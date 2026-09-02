/**
 * omp auth-gateway HTTP server.
 *
 * Accepts any provider-format request (OpenAI chat-completions, Anthropic
 * messages, OpenAI Responses) and dispatches through pi-ai's `streamSimple()`
 * — which handles credential injection, anthropic-beta headers, codex
 * websocket transport, and all the per-provider intricacies. The gateway is
 * pure protocol translation: foreign wire → omp Context → pi-ai stream() →
 * omp events → foreign wire.
 *
 * Endpoints:
 *   GET  /healthz                          → unauth; ok + version
 *   GET  /v1/usage                         → aggregated provider usage (5-min per-credential cache via AuthStorage)
 *   GET  /v1/credentials/check             → per-credential auth probe (diagnose 401s in a multi-account pool)
 *   GET  /v1/models                        → list known models from the registry
 *   POST /v1/chat/completions              → OpenAI chat-completions in/out
 *   POST /v1/messages                      → Anthropic messages in/out
 *   POST /v1/responses                     → OpenAI Responses in/out
 */

import { createHash } from "node:crypto";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { extractHttpStatusFromError, extractRetryHint, logger } from "@oh-my-pi/pi-utils";
import type { ApiKeyResolver } from "../auth-retry";
import type { AuthStorage } from "../auth-storage";
import * as AIError from "../error";
import { classifyGatewayError } from "../error/gateway";
import { isUsageLimitOutcome } from "../error/rate-limit";
import * as anthropicMessages from "../providers/anthropic-messages-server";
import * as openaiChat from "../providers/openai-chat-server";
import * as openaiResponses from "../providers/openai-responses-server";
import * as piNative from "../providers/pi-native-server";
import { completeSimple, streamSimple } from "../stream";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "../types";
import type { ClientUsageIdentity } from "../usage";
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream as AssistantMessageEventStreamImpl } from "../utils/event-stream";
import { parseBind } from "../utils/parse-bind";
import {
	captureRequestHeaders,
	corsHeaders,
	gatewayResponseHeaders,
	isAuthorized,
	json,
	resolveClientIdentity,
	resolvePeer,
	withCors,
} from "./http";
import type {
	AuthGatewayServerHandle,
	AuthGatewayServerOptions,
	AuthGatewayFormatModule as FormatModule,
	AuthGatewayParsedRequest as ParsedFormatRequest,
} from "./types";
import { DEFAULT_AUTH_GATEWAY_BIND } from "./types";

// ParsedFormatRequest / ParsedFormatOptions / FormatModule come from ./types.

export type ModelResolver = (modelId: string) => Model<Api> | undefined;

export interface AuthGatewayBootOptions extends AuthGatewayServerOptions {
	/** Source of credentials. Caller wires this to a broker-backed AuthStorage. */
	storage: AuthStorage;
	/**
	 * Resolve a client-requested model id to a pi-ai Model. Caller supplies
	 * this from a ModelRegistry (lives in `coding-agent` to avoid an inverse
	 * dependency in `pi-ai`).
	 */
	resolveModel: ModelResolver;
	/** Optional supplier for `/v1/models` listing. Returns the full model array. */
	listModels?: () => Iterable<Model<Api>>;
	/** Test/embedding override for the bounded pi-native boundary waiter. */
	boundaryApprovalTtlMs?: number;
}

const PI_NATIVE_BOUNDARY_APPROVAL_TTL_MS = 30_000;
const PI_NATIVE_PAYLOAD_BOUNDARY_APIS = new Set<Api>([
	"anthropic-messages",
	"bedrock-converse-stream",
	"openai-completions",
	"openai-responses",
	"openrouter",
	"openai-codex-responses",
	"azure-openai-responses",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"ollama-chat",
	"cursor-agent",
	"gitlab-duo-agent",
	"devin-agent",
]);
const PI_NATIVE_TOOL_CONTRACT_BOUNDARY_APIS = new Set<Api>(["cursor-agent", "gitlab-duo-agent", "devin-agent"]);

type PiNativeBoundaryResolution = { decision: "keep" } | { decision: "replace"; replacement: unknown };

interface PiNativeBoundarySession {
	requestId: string;
	streamId: string;
	sessionId: string;
	bearerFingerprint: string;
	forbiddenSecrets: string[];
	signal: AbortSignal;
	sequence: number;
	emit: (event: piNative.PiNativeBoundaryPreparationEvent) => void;
}

interface PendingPiNativeBoundaryApproval {
	preparation: piNative.PiNativeBoundaryPreparation;
	payload: unknown;
	bearerFingerprint: string;
	signal: AbortSignal;
	timer: NodeJS.Timeout;
	abort: () => void;
	resolve: (resolution: PiNativeBoundaryResolution) => void;
	reject: (error: unknown) => void;
}

function sha256Utf8(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestBearerFingerprint(req: Request): string {
	const authorization = req.headers.get("authorization")?.trim() ?? "";
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	return sha256Utf8(match?.[1]?.trim() ?? "");
}

function serializePiNativeBoundaryJson(value: unknown, label: string): string {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value, (_key, entry: unknown) => {
			if (typeof entry === "function" || typeof entry === "symbol") {
				throw new TypeError(`${label} contains a non-JSON value`);
			}
			if (typeof entry === "number" && !Number.isFinite(entry)) {
				throw new TypeError(`${label} contains a non-finite number`);
			}
			if (ArrayBuffer.isView(entry)) throw new TypeError(`${label} contains binary data`);
			return entry;
		});
	} catch (error) {
		throw new AIError.ValidationError(
			`pi-native boundary approval cannot serialize ${label}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (serialized === undefined) {
		throw new AIError.ValidationError(`pi-native boundary approval cannot serialize ${label}`);
	}
	return serialized;
}

function piNativeBoundaryModel(model: Model<Api>): piNative.PiNativeBoundaryModel {
	const { baseUrl: _baseUrl, headers: _headers, transport: _transport, ...credentialFree } = model;
	return { ...credentialFree, baseUrl: "" };
}

class PiNativeBoundaryApprovalStore {
	readonly #pending = new Map<string, PendingPiNativeBoundaryApproval>();
	readonly #pendingByStream = new Map<string, string>();
	readonly #ttlMs: number;

	constructor(ttlMs: number | undefined) {
		this.#ttlMs = Math.max(1, Math.floor(ttlMs ?? PI_NATIVE_BOUNDARY_APPROVAL_TTL_MS));
	}

	async prepare(
		session: PiNativeBoundarySession,
		kind: piNative.PiNativeBoundaryApprovalKind,
		payload: unknown,
		model: Model<Api>,
	): Promise<PiNativeBoundaryResolution> {
		if (session.signal.aborted) throw session.signal.reason ?? new AIError.AbortError("request aborted");
		if (this.#pendingByStream.has(session.streamId)) {
			throw new AIError.ValidationError("pi-native boundary approval already has a pending waiter for this stream");
		}
		const payloadJson = serializePiNativeBoundaryJson(payload, `${kind} payload`);
		if (session.forbiddenSecrets.some(secret => secret.length >= 8 && payloadJson.includes(secret))) {
			throw new AIError.ValidationError("pi-native boundary approval payload contains provider credentials");
		}
		const boundaryModel = piNativeBoundaryModel(model);
		const modelJson = serializePiNativeBoundaryJson(boundaryModel, "model projection");
		const preparation: piNative.PiNativeBoundaryPreparation = {
			version: 1,
			requestId: session.requestId,
			streamId: session.streamId,
			sessionId: session.sessionId,
			sequence: ++session.sequence,
			preparationId: crypto.randomUUID(),
			kind,
			model: boundaryModel,
			modelSha256: sha256Utf8(modelJson),
			payloadJson,
			payloadSha256: sha256Utf8(payloadJson),
			expiresAt: Date.now() + this.#ttlMs,
		};
		const { promise, resolve, reject } = Promise.withResolvers<PiNativeBoundaryResolution>();
		const abort = (): void => {
			const pending = this.#take(preparation.preparationId);
			if (pending) pending.reject(session.signal.reason ?? new AIError.AbortError("request aborted"));
		};
		const timer = setTimeout(() => {
			const pending = this.#take(preparation.preparationId);
			if (pending) pending.reject(new AIError.ValidationError("pi-native boundary approval expired"));
		}, this.#ttlMs);
		this.#pending.set(preparation.preparationId, {
			preparation,
			payload,
			bearerFingerprint: session.bearerFingerprint,
			signal: session.signal,
			timer,
			abort,
			resolve,
			reject,
		});
		this.#pendingByStream.set(session.streamId, preparation.preparationId);
		session.signal.addEventListener("abort", abort, { once: true });
		try {
			session.emit({
				type: "pi_boundary_approval",
				boundaryApproval: preparation,
			});
		} catch (error) {
			this.#take(preparation.preparationId)?.reject(error);
		}
		return promise;
	}

	consume(
		decision: piNative.PiNativeBoundaryApprovalDecision,
		bearerFingerprint: string,
	): { status: number; message: string } {
		const pending = this.#pending.get(decision.preparationId);
		if (!pending) {
			return decision.expiresAt <= Date.now()
				? { status: 410, message: "boundary approval expired" }
				: { status: 409, message: "boundary approval is not pending" };
		}
		if (pending.bearerFingerprint !== bearerFingerprint) {
			return { status: 403, message: "boundary approval bearer mismatch" };
		}
		const expected = pending.preparation;
		if (expected.expiresAt <= Date.now()) {
			return this.#rejectProtocol(decision.preparationId, 410, "boundary approval expired");
		}
		if (
			decision.requestId !== expected.requestId ||
			decision.streamId !== expected.streamId ||
			decision.sessionId !== expected.sessionId ||
			decision.sequence !== expected.sequence ||
			decision.kind !== expected.kind ||
			decision.modelSha256 !== expected.modelSha256 ||
			decision.payloadSha256 !== expected.payloadSha256 ||
			decision.expiresAt !== expected.expiresAt
		) {
			return this.#rejectProtocol(decision.preparationId, 409, "boundary approval custody mismatch");
		}

		let resolution: PiNativeBoundaryResolution = { decision: "keep" };
		if (decision.decision === "replace") {
			const replacementJson = decision.replacementJson;
			if (!replacementJson || sha256Utf8(replacementJson) !== decision.replacementSha256) {
				return this.#rejectProtocol(decision.preparationId, 400, "boundary approval replacement hash mismatch");
			}
			try {
				const replacement: unknown = JSON.parse(replacementJson);
				if (JSON.stringify(replacement) !== replacementJson) {
					return this.#rejectProtocol(
						decision.preparationId,
						400,
						"boundary approval replacement bytes are not stable JSON",
					);
				}
				resolution = { decision: "replace", replacement };
			} catch {
				return this.#rejectProtocol(decision.preparationId, 400, "boundary approval replacement is not JSON");
			}
		} else {
			let currentPayloadJson: string;
			try {
				currentPayloadJson = serializePiNativeBoundaryJson(pending.payload, `${expected.kind} payload`);
			} catch {
				return this.#rejectProtocol(decision.preparationId, 409, "boundary payload changed after preparation");
			}
			if (currentPayloadJson !== expected.payloadJson || sha256Utf8(currentPayloadJson) !== expected.payloadSha256) {
				return this.#rejectProtocol(decision.preparationId, 409, "boundary payload changed after preparation");
			}
		}

		const consumed = this.#take(decision.preparationId);
		if (!consumed) return { status: 409, message: "boundary approval is not pending" };
		if (decision.decision === "reject") {
			consumed.reject(new AIError.ValidationError(decision.error ?? "pi-native boundary approval rejected"));
		} else {
			consumed.resolve(resolution);
		}
		return { status: 200, message: "approved" };
	}

	cancelStream(streamId: string, reason: unknown): void {
		const preparationId = this.#pendingByStream.get(streamId);
		if (!preparationId) return;
		this.#take(preparationId)?.reject(reason);
	}

	close(): void {
		for (const preparationId of [...this.#pending.keys()]) {
			this.#take(preparationId)?.reject(new AIError.AbortError("auth-gateway stopped"));
		}
	}

	#take(preparationId: string): PendingPiNativeBoundaryApproval | undefined {
		const pending = this.#pending.get(preparationId);
		if (!pending) return undefined;
		this.#pending.delete(preparationId);
		this.#pendingByStream.delete(pending.preparation.streamId);
		clearTimeout(pending.timer);
		pending.signal.removeEventListener("abort", pending.abort);
		return pending;
	}

	#rejectProtocol(preparationId: string, status: number, message: string): { status: number; message: string } {
		this.#take(preparationId)?.reject(new AIError.ValidationError(`pi-native ${message}`));
		return { status, message };
	}
}

// `parseBind` lives in ../utils/parse-bind so the gateway and broker can't
// drift on accepted inputs (e.g. empty hostname, IPv6 brackets).

const FORMAT_ROUTES: Record<string, { module: FormatModule; label: string }> = {
	"/v1/chat/completions": { module: openaiChat, label: "openai-chat" },
	"/v1/messages": { module: anthropicMessages, label: "anthropic-messages" },
	"/v1/responses": { module: openaiResponses, label: "openai-responses" },
};

// (passthrough fast-path removed — it bypassed pi-ai provider logic, in
// particular the Anthropic Claude-Code OAuth system-prompt prefix injection.
// Every request now takes the translate path so credential-specific request
// shaping always applies.)

// Options the caller's wire format may carry but the resolved provider can't
// honour are dropped silently in `buildStreamOptions`. We used to 400 here
// (`Unsupported option: temperature for openai-codex-responses`), but every
// realistic client (llm-git, openai SDK, anthropic SDK) bakes some of these
// defaults in without knowing which model they'll resolve to. Failing loudly
// just turned that into per-call config hell. Silent strip is what the
// upstream provider would do anyway when it ignores extra fields.

/**
 * Derive a stable cache identity from the parts of the request that don't
 * change turn-to-turn within a logical conversation: model id, system prompt,
 * tool definitions, and the first message (the conversation seed). Codex-class
 * backends only cache prefixes when an explicit `prompt_cache_key` is set;
 * without one, two requests with the same prefix but different trailing
 * messages don't coalesce. This bridges Anthropic-style clients (which signal
 * caching via `cache_control` markers rather than an opaque key) to Codex's
 * keyed model so cross-protocol caching "just works".
 *
 * Including the first message scopes the key to one logical conversation:
 * two different chats with the same system prompt no longer share a cache
 * bucket and can't trample each other's prefix-tree entries.
 *
 * Anthropic-backed requests ignore `sessionId`; the key is harmless there.
 */
function deriveSessionId(modelId: string, context: Context): string {
	const parts: string[] = [modelId];
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		parts.push(context.systemPrompt.join("\n\n"));
	}
	if (context.tools && context.tools.length > 0) {
		parts.push(JSON.stringify(context.tools));
	}
	const first = context.messages?.[0];
	if (first) {
		// Strip timestamp / provider metadata so the hash is stable across turns
		// of the same conversation (omp re-stamps every parsed Message). role +
		// content is what's actually on the wire.
		parts.push(JSON.stringify({ role: first.role, content: first.content }));
	}
	const seed = parts.join("\u0000");
	// The 36-char UUID flows through unchanged:
	// `normalizeOpenAIPromptCacheKey` accepts ≤64 chars verbatim.
	return deterministicUuid(seed);
}

function buildStreamOptions(parsed: ParsedFormatRequest, api: Api, signal: AbortSignal): SimpleStreamOptions {
	const opts: SimpleStreamOptions = { signal };
	const { options } = parsed;
	// Codex backend rejects every sampling control with
	// `Unsupported parameter: …` (#3117). Strip the full set for that one
	// provider; everything else is harmless to forward — `streamSimple` ignores
	// what the underlying provider doesn't honour.
	const isCodex = api === "openai-codex-responses";
	if (options.maxOutputTokens !== undefined) opts.maxTokens = options.maxOutputTokens;
	if (options.temperature !== undefined && !isCodex) opts.temperature = options.temperature;
	if (options.topP !== undefined && !isCodex) opts.topP = options.topP;
	if (options.topK !== undefined && !isCodex) opts.topK = options.topK;
	if (options.minP !== undefined && !isCodex) opts.minP = options.minP;
	if (options.stopSequences !== undefined && !isCodex) opts.stopSequences = options.stopSequences;
	if (options.presencePenalty !== undefined && !isCodex) opts.presencePenalty = options.presencePenalty;
	if (options.frequencyPenalty !== undefined && !isCodex) opts.frequencyPenalty = options.frequencyPenalty;
	if (options.repetitionPenalty !== undefined && !isCodex) opts.repetitionPenalty = options.repetitionPenalty;
	if (options.metadata !== undefined) opts.metadata = options.metadata;
	if (options.headers !== undefined) opts.headers = { ...opts.headers, ...options.headers };
	if (options.toolChoice !== undefined) {
		opts.toolChoice =
			typeof options.toolChoice !== "object"
				? options.toolChoice
				: "type" in options.toolChoice
					? options.toolChoice
					: { type: "tool", name: options.toolChoice.name };
	}
	if (options.reasoning !== undefined) opts.reasoning = options.reasoning;
	if (options.disableReasoning !== undefined) opts.disableReasoning = options.disableReasoning;
	if (options.hideThinkingSummary !== undefined) opts.hideThinkingSummary = options.hideThinkingSummary;
	if (options.taskBudget !== undefined) opts.taskBudget = options.taskBudget;
	if (options.anthropicPrefixMismatchBehavior !== undefined) {
		opts.anthropicPrefixMismatchBehavior = options.anthropicPrefixMismatchBehavior;
	}
	if (options.serviceTier !== undefined) opts.serviceTier = options.serviceTier;
	if (options.cacheRetention !== undefined) opts.cacheRetention = options.cacheRetention;
	if (options.include !== undefined) opts.include = options.include;
	// Client-supplied `prompt_cache_key` wins; otherwise derive a stable
	// key from the model + system + tools so prefix caching engages on
	// Codex-class backends across turns of the same logical conversation.
	const promptCacheKey = options.promptCacheKey ?? deriveSessionId(parsed.modelId, parsed.context);
	opts.promptCacheKey = promptCacheKey;
	opts.sessionId = promptCacheKey;
	if (options.thinkingBudgets) {
		opts.thinkingBudgets = {
			...(opts.thinkingBudgets ?? {}),
			...options.thinkingBudgets,
		};
	}
	if (options.explicitThinkingBudgetTokens !== undefined) {
		// Mirror Rust's `resolve_thinking_budget`: explicit budget pins onto
		// whichever effort the client requested (or High when unspecified) and
		// ALSO sets the effort so providers that gate on `reasoning` actually
		// surface the budget.
		const effort = options.reasoning ?? Effort.High;
		opts.thinkingBudgets = {
			...opts.thinkingBudgets,
			[effort]: options.explicitThinkingBudgetTokens,
		};
		opts.reasoning ??= effort;
	}
	// Fields that don't yet have a matching pi-ai `SimpleStreamOptions` slot.
	// Surfaced once in debug logs so they show up when wiring a new provider,
	// but NEVER widened into `options.extra` — every consumer would have to
	// re-implement the typed parse to read them back out.
	// TODO(pi-ai): land first-class fields and replace these blocks.
	if (
		options.parallelToolCalls !== undefined ||
		options.previousResponseId !== undefined ||
		options.seed !== undefined ||
		options.logitBias !== undefined ||
		options.user !== undefined ||
		options.responseFormat !== undefined
	) {
		logger.debug("auth-gateway dropped unsupported typed options", {
			api,
			parallelToolCalls: options.parallelToolCalls,
			previousResponseId: options.previousResponseId,
			seed: options.seed,
			hasLogitBias: options.logitBias !== undefined,
			user: options.user,
			hasResponseFormat: options.responseFormat !== undefined,
		});
	}
	return opts;
}

/**
 * Hook fired by {@link streamSimple} when the upstream request fails in a
 * way that's rotatable — today that's HTTP 401 (credential is bad) and
 * usage-limit phrasing matched by {@link isUsageLimitError} (Codex's
 * `usage_limit_reached`, Anthropic's `usage_limit_reached`, Google's
 * `resource_exhausted`, …). The two cases need different storage actions:
 *
 * - **usage-limit** → {@link AuthStorage.markUsageLimitReached}. Marks just
 *   the current session's credential as temporarily blocked (honouring
 *   `retry-after` / `resets_at` hints when present) and returns `true` only
 *   when a sibling credential is still available. Burning the credential
 *   with `invalidateCredentialMatching` here would orphan accounts whose
 *   reset window is several hours away — exactly the bug this helper exists
 *   to avoid.
 * - **auth-failure** → {@link AuthStorage.invalidateCredentialMatching}.
 *   Suspect/delete the row so it doesn't get re-picked next request.
 *
 * In both branches we return the next `getApiKey` result (sticky on the
 * same `sessionId`) so streamSimple can transparently retry the pre-emit
 * failure with a fresh credential. Returning `undefined` aborts the retry
 * and surfaces the original error to the caller.
 */
async function refreshGatewayApiKeyAfterAuthError(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	provider: string,
	oldKey: string,
	error: unknown,
	signal: AbortSignal,
	format: string,
	peer: string,
): Promise<string | undefined> {
	const message = error instanceof Error ? error.message : String(error);
	const status = extractHttpStatusFromError(error);
	if (AIError.isUsageLimit(error) || isUsageLimitOutcome(status, message)) {
		const retryAfterMs = extractRetryHint(undefined, message);
		const { switched, retryAtMs } = await storage.markUsageLimitReached(provider, sessionId, {
			retryAfterMs,
			baseUrl: model.baseUrl,
			modelId: model.id,
			apiKey: oldKey,
			signal,
		});
		logger.debug("auth-gateway retrying provider request after usage-limit block", {
			format,
			provider,
			peer,
			switched,
			retryAfterMs,
			retryAtMs,
			error: message,
		});
		if (!switched) return undefined;
		return storage.getApiKey(provider, sessionId, {
			modelId: model.id,
			signal,
		});
	}
	await storage.invalidateCredentialMatching(provider, oldKey, {
		sessionId,
		signal,
	});
	logger.debug("auth-gateway retrying provider request after credential invalidation", {
		format,
		provider,
		peer,
		error: message,
	});
	return storage.getApiKey(provider, sessionId, { modelId: model.id, signal });
}

/**
 * Build the {@link ApiKeyResolver} handed to `streamSimple` for a gateway
 * request. Drives the central a/b/c auth-retry policy server-side:
 *
 * - initial resolve → the credential already resolved for this request.
 * - step (b) `!lastChance` → force-refresh the SAME session-sticky credential
 *   (a peer/broker may have rotated its token out from under our cached copy).
 * - step (c) `lastChance` → {@link refreshGatewayApiKeyAfterAuthError} switches
 *   to a sibling (usage-limit block vs credential invalidation by error class).
 *
 * `lastKey` tracks the most recent bearer so the switch step invalidates the
 * credential that actually failed.
 */
function buildGatewayApiKeyResolver(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	initialKey: string,
	requestSignal: AbortSignal,
	format: string,
	peer: string,
): ApiKeyResolver {
	let lastKey = initialKey;
	return async ({ lastChance, error, signal }) => {
		const sig = signal ?? requestSignal;
		if (error === undefined) {
			lastKey = initialKey;
			return initialKey;
		}
		if (!lastChance) {
			const refreshed = await storage.getApiKey(model.provider, sessionId, {
				modelId: model.id,
				signal: sig,
				forceRefresh: true,
			});
			lastKey = refreshed ?? lastKey;
			return refreshed;
		}
		const next = await refreshGatewayApiKeyAfterAuthError(
			storage,
			model,
			sessionId,
			model.provider,
			lastKey,
			error,
			sig,
			format,
			peer,
		);
		lastKey = next ?? lastKey;
		return next;
	};
}

function clientClosedResponse(route: { module: FormatModule }): Response {
	return route.module.formatError(499, "request_aborted", "client closed request");
}

/**
 * Attribute one settled upstream request to the originating client via the
 * broker's observed-usage channel (`AuthStorage.recordObservedUsage`, batched
 * by the remote store). Error/aborted turns still record — the provider
 * billed whatever tokens the partial turn consumed; zero-usage messages
 * (pre-flight failures) are skipped.
 */
function recordGatewayUsage(
	storage: AuthStorage,
	model: Model<Api>,
	client: ClientUsageIdentity,
	message: AssistantMessage,
): void {
	const usage = message.usage;
	if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return;
	storage.recordObservedUsage({
		provider: model.provider,
		model: model.id,
		at: message.timestamp || Date.now(),
		usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
		costUsd: usage.cost.total,
		client,
	});
}

function mirrorRequestAbort(req: Request): AbortController {
	const controller = new AbortController();
	if (req.signal.aborted) {
		controller.abort(req.signal.reason);
	} else {
		req.signal.addEventListener("abort", () => controller.abort(req.signal.reason), { once: true });
	}
	return controller;
}

// (handlePassthrough removed — see note above.)

async function handleFormatEndpoint(
	route: { module: FormatModule; label: string },
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return clientClosedResponse(route);

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		return route.module.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	// All three supported wire formats put the model id on a top-level `model`
	// field. Read it without running the full strict schema so the route can
	// produce a coherent error envelope when the model id is missing.
	const modelId =
		typeof body === "object" && body !== null && typeof (body as { model?: unknown }).model === "string"
			? (body as { model: string }).model
			: undefined;
	if (!modelId) {
		return route.module.formatError(400, "invalid_request_error", "Missing top-level `model` field");
	}

	const model = bootOpts.resolveModel(modelId);
	if (!model) {
		return route.module.formatError(404, "invalid_request_error", `Unknown model: ${modelId}`);
	}
	const client = resolveClientIdentity(req.headers);

	// Parse the wire-format request BEFORE resolving the credential so we
	// have a stable per-conversation `sessionId` to thread into AuthStorage.
	// Sticky-credential tracking and `markUsageLimitReached` both key off
	// this id; without it `getApiKey` would re-roundrobin every request
	// and `markUsageLimitReached` would no-op (it can only mark the
	// credential it last handed out to that session).
	let parsed: ParsedFormatRequest;
	try {
		parsed = route.module.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		const message = error instanceof Error ? error.message : String(error);
		return route.module.formatError(400, "invalid_request_error", message);
	}
	// Merge gateway-captured passthrough headers under the parser's own
	// captures. Parsers that set `options.headers` themselves win (they may
	// have stripped or normalized values); the gateway's allow-list fills in
	// anything they didn't touch.
	{
		const captured = captureRequestHeaders(req.headers);
		parsed.options.headers = { ...captured, ...parsed.options.headers };
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	const supportsOpenAIImageFileReferences =
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses";
	if (
		route.label === "openai-responses" &&
		!supportsOpenAIImageFileReferences &&
		parsed.context.messages.some(
			message =>
				message.role === "toolResult" &&
				message.content.some(
					block => block.type === "image" && block.providerFile?.provider === "openai" && block.providerFile.id,
				),
		)
	) {
		return route.module.formatError(
			400,
			"invalid_request_error",
			"OpenAI image file IDs in tool outputs require a Responses-compatible upstream model",
		);
	}

	// Sticky credential id: honour the client's `prompt_cache_key` when
	// supplied (so external session ids align), otherwise derive from
	// modelId + system + tools + first message. Mirrored into
	// streamOpts.sessionId / promptCacheKey by `buildStreamOptions`.
	const sessionId = parsed.options.promptCacheKey ?? deriveSessionId(parsed.modelId, parsed.context);
	parsed.options.promptCacheKey ??= sessionId;

	// pi-ai's stream() does NOT consult AuthStorage — the caller (us) is
	// expected to resolve the credential and pass it as `options.apiKey`.
	// For OAuth providers this returns the access token (refreshed via the
	// broker override on AuthStorage when needed).
	let apiKey: string | undefined;
	try {
		apiKey = await bootOpts.storage.getApiKey(model.provider, sessionId, {
			modelId: model.id,
			signal: controller.signal,
		});
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway getApiKey threw", {
			provider: model.provider,
			peer,
			error: classified.message,
		});
		return route.module.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);
	if (!apiKey) {
		return route.module.formatError(
			401,
			"authentication_error",
			`No credential available for provider ${model.provider}`,
		);
	}

	const streamOpts = buildStreamOptions(parsed, model.api, controller.signal);
	streamOpts.apiKey = buildGatewayApiKeyResolver(
		bootOpts.storage,
		model,
		sessionId,
		apiKey,
		controller.signal,
		route.label,
		peer,
	);

	logger.info("auth-gateway request", {
		requestId,
		format: route.label,
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: parsed.stream,
		peer,
	});

	if (!parsed.stream) {
		try {
			if (controller.signal.aborted) return clientClosedResponse(route);
			const message = await completeSimple(model, parsed.context, streamOpts);
			recordGatewayUsage(bootOpts.storage, model, client, message);
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				const errorMessage =
					message.errorMessage ??
					(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				logger.warn("auth-gateway non-streaming failed", {
					format: route.label,
					reason: message.stopReason,
					error: errorMessage,
					peer,
				});
				if (message.stopReason === "aborted") {
					return route.module.formatError(499, "request_aborted", errorMessage);
				}
				const classified = classifyGatewayError(message.errorClassificationMessage ?? errorMessage);
				return route.module.formatError(classified.status, classified.type, errorMessage);
			}
			return json(
				200,
				route.module.encodeResponse(message, parsed.modelId),
				gatewayResponseHeaders(model, { requestId, message, startedAt }),
			);
		} catch (error) {
			if (controller.signal.aborted) return clientClosedResponse(route);
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway non-streaming aborted", {
				format: route.label,
				error: classified.message,
				peer,
			});
			return route.module.formatError(classified.status, classified.type, classified.message);
		}
	}

	let events: AssistantMessageEventStream;
	try {
		if (controller.signal.aborted) return clientClosedResponse(route);
		events = streamSimple(model, parsed.context, streamOpts);
	} catch (error) {
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway streamSimple threw", {
			format: route.label,
			error: classified.message,
			peer,
		});
		return route.module.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);
	void events
		.result()
		.then(message => recordGatewayUsage(bootOpts.storage, model, client, message))
		.catch(() => {});

	const sseStream = route.module.encodeStream(events, parsed.modelId, parsed.options, {
		signal: controller.signal,
		onCancel: reason => {
			if (!controller.signal.aborted) {
				controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
			}
		},
	});
	return new Response(sseStream, {
		status: 200,
		headers: {
			...gatewayResponseHeaders(model, { requestId }),
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			// Disable proxy buffering (nginx and ingress controllers honor this).
			// Without it the SSE stream gets held until the buffer flushes, which
			// stalls the long-thinking-budget calls we exist to support.
			"X-Accel-Buffering": "no",
		},
	});
}

/**
 * Pi-native fast path: `POST /v1/pi/stream`. Accepts the canonical pi-ai
 * `Context` directly (no wire-format round-trip) and emits a bandwidth-shrunk
 * event stream matching `pi-agent`'s `streamProxy`. Skips the OpenAI /
 * Anthropic / Responses translation layers — those exist to bridge foreign
 * SDKs (llm-git, anthropic-sdk, openai-sdk), and bridging back to pi-native
 * just to bridge forward again is wasted work.
 *
 * Every other gateway concern (bearer auth, model resolve, credential fetch,
 * abort mirroring, codex temperature/topP strip, prefix-cache key derivation,
 * Claude-Code OAuth shaping inside `streamSimple`) still applies — only
 * `parseRequest`/`encodeResponse`/`encodeStream` differ from the format-endpoint
 * path.
 */
async function handlePiNativeBoundaryApproval(
	approvals: PiNativeBoundaryApprovalStore,
	req: Request,
): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		return piNative.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	let decision: piNative.PiNativeBoundaryApprovalDecision;
	try {
		decision = piNative.parseBoundaryApprovalDecision(body);
	} catch (error) {
		return piNative.formatError(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
	}
	const result = approvals.consume(decision, requestBearerFingerprint(req));
	return result.status === 200
		? json(200, { ok: true })
		: piNative.formatError(result.status, "boundary_approval_error", result.message);
}

async function handlePiNative(
	bootOpts: AuthGatewayBootOptions,
	approvals: PiNativeBoundaryApprovalStore,
	req: Request,
	peer: string,
	protectedRoute: boolean,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => piNative.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		return piNative.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return aborted();

	let parsed: piNative.PiNativeParsedRequest;
	try {
		parsed = piNative.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = error instanceof Error ? error.message : String(error);
		return piNative.formatError(400, "invalid_request_error", message);
	}

	const model = bootOpts.resolveModel(parsed.modelId);
	if (!model) {
		return piNative.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}
	const boundaryApproval =
		parsed.boundaryApproval && (parsed.boundaryApproval.payload || parsed.boundaryApproval.toolContracts)
			? parsed.boundaryApproval
			: undefined;
	if (protectedRoute !== (boundaryApproval !== undefined)) {
		return piNative.formatError(
			400,
			"boundary_approval_route_mismatch",
			protectedRoute
				? "pi-native boundary stream requires at least one approval callback"
				: "pi-native boundary approval requires /v1/pi/boundary-stream/v1",
		);
	}
	if (boundaryApproval?.payload && !PI_NATIVE_PAYLOAD_BOUNDARY_APIS.has(model.api)) {
		return piNative.formatError(
			400,
			"boundary_approval_unsupported",
			`pi-native payload boundary approval is unsupported for API ${model.api}`,
		);
	}
	if (boundaryApproval?.toolContracts && !PI_NATIVE_TOOL_CONTRACT_BOUNDARY_APIS.has(model.api)) {
		return piNative.formatError(
			400,
			"boundary_approval_unsupported",
			`pi-native tool-contract boundary approval is unsupported for API ${model.api}`,
		);
	}
	const client = resolveClientIdentity(req.headers);
	// Pi-native already parsed `streamOpts.sessionId` (when set by the
	// client); fall back to the derived key so credential-stickiness lines
	// up with cache-prefix stickiness — same identity used for both means
	// the next turn of this conversation reuses the same credential until
	// it hits a usage cap, then markUsageLimitReached can hand off.
	const sessionId = parsed.options.sessionId ?? deriveSessionId(parsed.modelId, parsed.context);
	parsed.options.sessionId ??= sessionId;

	let apiKey: string | undefined;
	try {
		apiKey = await bootOpts.storage.getApiKey(model.provider, sessionId, {
			modelId: model.id,
			signal: controller.signal,
		});
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway getApiKey threw", {
			provider: model.provider,
			peer,
			error: classified.message,
		});
		return piNative.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return aborted();
	if (!apiKey) {
		return piNative.formatError(
			401,
			"authentication_error",
			`No credential available for provider ${model.provider}`,
		);
	}

	// Build the SimpleStreamOptions actually handed to `streamSimple`. We
	// trust the client's options (already allow-listed by `parseRequest`) and
	// only inject server-controlled fields. The codex sampling strip mirrors
	// `buildStreamOptions` — Codex rejects every one with a 400 (#3117).
	const streamOpts: SimpleStreamOptions = {
		...parsed.options,
		apiKey,
		signal: controller.signal,
	};
	streamOpts.apiKey = buildGatewayApiKeyResolver(
		bootOpts.storage,
		model,
		sessionId,
		apiKey,
		controller.signal,
		"pi-native",
		peer,
	);
	if (model.api === "openai-codex-responses") {
		delete streamOpts.temperature;
		delete streamOpts.topP;
		delete streamOpts.topK;
		delete streamOpts.minP;
		delete streamOpts.stopSequences;
		delete streamOpts.presencePenalty;
		delete streamOpts.frequencyPenalty;
		delete streamOpts.repetitionPenalty;
	}
	// Merge gateway-captured passthrough headers under the client's own
	// headers — the client's values win when they collide.
	const captured = captureRequestHeaders(req.headers);
	streamOpts.headers = { ...captured, ...streamOpts.headers };
	streamOpts.sessionId ??= sessionId;
	const streamId = crypto.randomUUID();
	const boundaryEvents = boundaryApproval ? new AssistantMessageEventStreamImpl() : undefined;
	const boundarySession: PiNativeBoundarySession | undefined = boundaryEvents
		? {
				requestId,
				streamId,
				sessionId,
				bearerFingerprint: requestBearerFingerprint(req),
				forbiddenSecrets: [apiKey, ...Object.values(streamOpts.headers ?? {})],
				signal: controller.signal,
				sequence: 0,
				emit: event => boundaryEvents.deliver(event as unknown as AssistantMessageEvent),
			}
		: undefined;
	if (boundaryApproval?.payload && boundarySession) {
		streamOpts.onPayload = async (payload, payloadModel) => {
			const resolution = await approvals.prepare(boundarySession, "payload", payload, payloadModel ?? model);
			return resolution.decision === "replace" ? resolution.replacement : undefined;
		};
	}
	if (boundaryApproval?.toolContracts && boundarySession) {
		streamOpts.onToolContracts = async (payload, payloadModel) => {
			await approvals.prepare(boundarySession, "toolContracts", payload, payloadModel ?? model);
		};
	}

	logger.info("auth-gateway request", {
		requestId,
		format: "pi-native",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: parsed.stream,
		peer,
	});

	if (!parsed.stream) {
		try {
			if (controller.signal.aborted) return aborted();
			const message = await completeSimple(model, parsed.context, streamOpts);
			recordGatewayUsage(bootOpts.storage, model, client, message);
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				const errorMessage =
					message.errorMessage ??
					(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				logger.warn("auth-gateway non-streaming failed", {
					format: "pi-native",
					reason: message.stopReason,
					error: errorMessage,
					peer,
				});
				if (message.stopReason === "aborted") {
					return piNative.formatError(499, "request_aborted", errorMessage);
				}
				const classified = classifyGatewayError(message.errorClassificationMessage ?? errorMessage);
				return piNative.formatError(classified.status, classified.type, errorMessage);
			}
			return json(200, { message }, gatewayResponseHeaders(model, { requestId, message, startedAt }));
		} catch (error) {
			if (controller.signal.aborted) return aborted();
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway non-streaming aborted", {
				format: "pi-native",
				error: classified.message,
				peer,
			});
			return piNative.formatError(classified.status, classified.type, classified.message);
		}
	}

	let events: AssistantMessageEventStream;
	try {
		if (controller.signal.aborted) return aborted();
		events = streamSimple(model, parsed.context, streamOpts);
	} catch (error) {
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway streamSimple threw", {
			format: "pi-native",
			error: classified.message,
			peer,
		});
		return piNative.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return aborted();
	void events
		.result()
		.then(message => recordGatewayUsage(bootOpts.storage, model, client, message))
		.catch(() => {});
	if (boundaryEvents && boundarySession) {
		const providerEvents = events;
		void (async () => {
			try {
				for await (const event of providerEvents) boundaryEvents.push(event);
				if (!boundaryEvents.done) boundaryEvents.end();
			} catch (error) {
				boundaryEvents.fail(error);
			} finally {
				approvals.cancelStream(boundarySession.streamId, new AIError.AbortError("pi-native stream ended"));
			}
		})();
		events = boundaryEvents;
	}

	const sseStream = piNative.encodeStream(events, parsed.modelId, parsed.options, {
		signal: controller.signal,
		onCancel: reason => {
			if (!controller.signal.aborted) {
				controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
			}
		},
	});
	return new Response(sseStream, {
		status: 200,
		headers: {
			...gatewayResponseHeaders(model, { requestId }),
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

/**
 * Snapshot of `GET /v1/usage` — `fetchUsageReports` already caches reports at
 * a 5-minute per-credential TTL (with jitter, plus last-good fallback on
 * failure) inside `AuthStorage`, so this handler is a thin wrapper that
 * surfaces the same data to HTTP callers (notably the macOS usage widget).
 */
async function handleUsage(storage: AuthStorage, signal: AbortSignal): Promise<Response> {
	const reports = (await storage.fetchUsageReports?.({ signal })) ?? [];
	// Drop the heavy provider-specific `raw` payload — UI consumers only need
	// `limits` + `metadata`. Match the broker's `/v1/usage` shape so a single
	// client struct (Swift widget, llm-git, ...) works against either endpoint.
	const trimmed = reports.map(({ raw: _raw, ...rest }) => rest);
	return json(200, { generatedAt: Date.now(), reports: trimmed });
}

/**
 * Per-credential health probe surfaced on `GET /v1/credentials/check`. Tells
 * the caller exactly which row in their broker is producing 401s — the
 * aggregate `/v1/usage` endpoint silently drops failed credentials, which is
 * the wrong shape when you're diagnosing auth.
 *
 * The probe is sequential (one credential at a time) to avoid synchronized
 * N-account fan-out tripping per-IP rate limits on provider `/usage`
 * endpoints. For multi-account pools that's the difference between getting
 * a clean diagnosis and getting a 429 storm.
 */
async function handleCredentialsCheck(storage: AuthStorage, signal: AbortSignal): Promise<Response> {
	const credentials = await storage.checkCredentials({ signal });
	return json(200, { generatedAt: Date.now(), credentials });
}

/**
 * Row shape for `GET /v1/models`. Beyond the OpenAI-standard `id`/`object`/
 * `owned_by`, rows advertise the catalog metadata OpenAI-compatible clients
 * (omp's own proxy discovery, Zed's openai_compatible provider, ...) read to
 * size and capability-gate discovered models: `context_length`,
 * `max_output_tokens`, `input_modalities`, and `supports_tools` (only emitted
 * when the catalog explicitly reports `false`; absent means usable).
 */
interface ModelListRow {
	id: string;
	object: "model";
	owned_by: string;
	api: Api;
	display_name: string;
	context_length?: number;
	max_output_tokens?: number;
	input_modalities: ("text" | "image")[];
	supports_tools?: boolean;
}

function handleModelsList(opts: AuthGatewayBootOptions): Response {
	const seen = new Set<string>();
	const data: ModelListRow[] = [];
	for (const model of opts.listModels?.() ?? []) {
		const id = `${model.provider}/${model.id}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const row: ModelListRow = {
			id,
			object: "model",
			owned_by: model.provider,
			api: model.api,
			display_name: model.name,
			input_modalities: model.input,
		};
		if (model.contextWindow != null) row.context_length = model.contextWindow;
		if (model.maxTokens != null) row.max_output_tokens = model.maxTokens;
		if (model.supportsTools === false) row.supports_tools = false;
		data.push(row);
	}
	return json(200, { object: "list", data });
}

export function startAuthGateway(opts: AuthGatewayBootOptions): AuthGatewayServerHandle {
	const bind = parseBind(opts.bind ?? DEFAULT_AUTH_GATEWAY_BIND);
	const tokens = new Set<string>(opts.bearerTokens);
	const version = opts.version;
	const boundaryApprovals = new PiNativeBoundaryApprovalStore(opts.boundaryApprovalTtlMs);

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		fetch: async (req): Promise<Response> => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const peer = resolvePeer(req);
			// CORS preflight is always answered without auth — browsers send
			// preflights pre-authentication and a 401 here breaks the actual
			// request before the bearer is ever attached.
			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders(req) });
			}
			try {
				if (req.method === "GET" && pathname === "/healthz") {
					return withCors(json(200, { ok: true, version }), req);
				}
				if (!isAuthorized(req, tokens)) {
					logger.info("auth-gateway request unauthorized", {
						method: req.method,
						path: pathname,
						peer,
					});
					return withCors(json(401, { error: "unauthorized" }), req);
				}

				// Aggregated usage — backed by AuthStorage's 5-min per-credential cache.
				// Same shape as the broker's `/v1/usage`, so widget/llm-git speak to either with the
				// same client struct.
				if (req.method === "GET" && pathname === "/v1/usage") {
					return withCors(await handleUsage(opts.storage, req.signal), req);
				}

				// Per-credential auth probe — diagnoses which row in a multi-account
				// pool is producing 401s. Aggregated `/v1/usage` silently drops failed
				// credentials, so we need a separate endpoint that captures errors.
				if (req.method === "GET" && pathname === "/v1/credentials/check") {
					return withCors(await handleCredentialsCheck(opts.storage, req.signal), req);
				}

				// Provider-format dispatch.
				const formatRoute = FORMAT_ROUTES[pathname];
				if (formatRoute && req.method === "POST") {
					return withCors(await handleFormatEndpoint(formatRoute, opts, req, peer), req);
				}

				// Pi-native fast path. Same auth + provider plumbing as the
				// foreign-wire routes, just without the wire-format translation.
				if (req.method === "POST" && pathname === "/v1/pi/stream") {
					return withCors(await handlePiNative(opts, boundaryApprovals, req, peer, false), req);
				}
				if (req.method === "POST" && pathname === "/v1/pi/boundary-stream/v1") {
					return withCors(await handlePiNative(opts, boundaryApprovals, req, peer, true), req);
				}
				if (req.method === "POST" && pathname === "/v1/pi/boundary-approval") {
					return withCors(await handlePiNativeBoundaryApproval(boundaryApprovals, req), req);
				}

				// Model catalog.
				if (req.method === "GET" && pathname === "/v1/models") {
					return withCors(handleModelsList(opts), req);
				}

				// Route-table miss: no format module to defer to, so we emit a
				// plain JSON 404 rather than guessing at a protocol-specific envelope.
				return withCors(json(404, { error: `No route: ${req.method} ${pathname}` }), req);
			} catch (error) {
				logger.error("auth-gateway handler crashed", {
					method: req.method,
					path: pathname,
					peer,
					error: String(error),
				});
				return withCors(json(500, { error: "internal error" }), req);
			}
		},
		// Max-out Bun's idle timeout. Long thinking-budget calls can sit idle
		// for minutes before the first token arrives; the default kills them.
		idleTimeout: 255,
	});

	const boundHost = server.hostname ?? bind.hostname;
	const boundPort = server.port ?? bind.port;
	return {
		url: `http://${boundHost}:${boundPort}`,
		port: boundPort,
		hostname: boundHost,
		close: async () => {
			boundaryApprovals.close();
			server.stop(true);
		},
	};
}
