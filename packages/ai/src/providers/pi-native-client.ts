/**
 * Client half of the pi-native auth-gateway protocol.
 *
 * Dispatches a {@link streamSimple}-shaped request to an `omp auth-gateway`
 * via the auth-gateway's pi-native endpoint, reads the SSE event stream back, and pushes the
 * parsed events into a local {@link AssistantMessageEventStream} — the same
 * stream type every other provider client produces. Callers downstream of
 * `streamSimple` cannot tell whether the events came from a real provider
 * SDK or from a gateway hop; they consume `AssistantMessageEvent`s either
 * way.
 *
 * Activated when a {@link Model} has `transport: "pi-native"` set; the
 * dispatch hook lives in `streamSimple()` (see `../stream.ts`). Used by
 * containerized omp deployments (such as robomp slots) that
 * route every LLM call through a credential-holding sidecar so the slot
 * itself stays credential-free.
 */

import { createHash } from "node:crypto";
import * as os from "node:os";
import { getAppName, getInstallId, readSseJson } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream as AssistantMessageEventStreamType,
	Context,
	Model,
	SimpleStreamOptions,
} from "../types";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs, iterateWithIdleTimeout } from "../utils/idle-iterator";
import { notifyProviderResponse } from "../utils/provider-response";
import type {
	PiNativeBoundaryApprovalDecision,
	PiNativeBoundaryPreparation,
	PiNativeBoundaryPreparationEvent,
} from "./pi-native-server";

/**
 * Fields that must not cross the wire — either non-serializable (functions,
 * `AbortSignal`, the provider-session `Map`) or server-controlled
 * (`apiKey`, which the gateway injects from its own credential store; the
 * client's `apiKey` is the gateway *bearer*, sent in the `Authorization`
 * header rather than the request body). Payload/tool callbacks run locally
 * against the final canonical gateway envelope before their closures are
 * removed from its options bag.
 */
const NON_WIRE_KEYS = new Set<keyof SimpleStreamOptions>([
	"signal",
	"apiKey",
	"fetch",
	"providerDispatchGuard",
	"onPayload",
	"onToolContracts",
	"onResponse",
	"onSseEvent",
	"execHandlers",
	"cursorExecHandlers",
	"cursorOnToolResult",
	"providerSessionState",
]);
const PI_NATIVE_STREAM_IDLE_TIMEOUT_ERROR = "pi-native stream stalled while waiting for the next event";
const PI_NATIVE_STREAM_FIRST_EVENT_TIMEOUT_ERROR = "pi-native stream timed out while waiting for the first event";

interface PiNativeStreamRequest {
	modelId: string;
	context: Context;
	options: Record<string, unknown>;
	stream: true;
	boundaryApproval?: { version: 1; payload: boolean; toolContracts: boolean };
}

type PiNativeWireEvent = AssistantMessageEvent | PiNativeBoundaryPreparationEvent;

function isPiNativeProgressEvent(event: unknown): boolean {
	if (typeof event !== "object" || event === null || !("type" in event)) return true;
	return event.type !== "start";
}

function sha256Utf8(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundaryDecision(
	preparation: PiNativeBoundaryPreparation,
	decision: PiNativeBoundaryApprovalDecision["decision"],
	extra: Pick<PiNativeBoundaryApprovalDecision, "replacementJson" | "replacementSha256" | "error"> = {},
): PiNativeBoundaryApprovalDecision {
	return {
		version: 1,
		requestId: preparation.requestId,
		streamId: preparation.streamId,
		sessionId: preparation.sessionId,
		sequence: preparation.sequence,
		preparationId: preparation.preparationId,
		kind: preparation.kind,
		modelSha256: preparation.modelSha256,
		payloadSha256: preparation.payloadSha256,
		expiresAt: preparation.expiresAt,
		decision,
		...extra,
	};
}

function buildWireOptions(options: SimpleStreamOptions | undefined): Record<string, unknown> {
	if (!options) return {};
	const wire: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(options)) {
		if (v === undefined) continue;
		if (NON_WIRE_KEYS.has(k as keyof SimpleStreamOptions)) continue;
		wire[k] = v;
	}
	return wire;
}

async function decodeGatewayError(response: Response): Promise<AIError.AuthGatewayError> {
	const status = response.status;
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = await response.text().catch(() => "");
	}
	if (typeof body === "object" && body !== null && "error" in body) {
		const err = (body as { error: unknown }).error;
		if (typeof err === "object" && err !== null) {
			const message = (err as { message?: unknown }).message;
			const type = (err as { type?: unknown }).type;
			return new AIError.AuthGatewayError(
				typeof message === "string" ? message : `auth-gateway ${status}`,
				status,
				response.headers,
				typeof type === "string" ? type : undefined,
			);
		}
	}
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return new AIError.AuthGatewayError(
		`auth-gateway ${status}: ${text || response.statusText}`,
		status,
		response.headers,
	);
}

/**
 * Resolve the gateway base URL from the model's `baseUrl`.
 * Trims a trailing slash so concatenation can't double-slash; throws when
 * the baseUrl is missing (transport=pi-native without a gateway target is
 * a configuration error, not a runtime recoverable one).
 */
function resolveGatewayBaseUrl(model: Model<Api>): string {
	if (!model.baseUrl) {
		throw new AIError.ConfigurationError(
			`pi-native transport requires \`baseUrl\` on model ${model.id} (set it on the provider config in models.yml)`,
		);
	}
	return model.baseUrl.replace(/\/+$/, "");
}

function buildHeaders(model: Model<Api>, apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		// Usage-attribution identity: the gateway reports this request's token
		// burn to the broker under the ORIGINATING client, not the gateway host.
		// Attribution-only — the gateway never forwards x-omp-* upstream. Header
		// values must stay ISO-8859-1-safe, hence the hostname scrub.
		"x-omp-install-id": getInstallId(),
		"x-omp-hostname": os.hostname().replace(/[^\x20-\x7e]/g, "?"),
		"x-omp-app": getAppName(),
		...model.headers,
	};
	if (apiKey && !headers.Authorization) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

function serializeBoundaryReplacement(value: unknown): string {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value, (_key, entry: unknown) => {
			if (typeof entry === "function" || typeof entry === "symbol") {
				throw new TypeError("replacement contains a non-JSON value");
			}
			if (typeof entry === "number" && !Number.isFinite(entry)) {
				throw new TypeError("replacement contains a non-finite number");
			}
			if (ArrayBuffer.isView(entry)) throw new TypeError("replacement contains binary data");
			return entry;
		});
	} catch (error) {
		throw new AIError.ValidationError(
			`pi-native boundary replacement is not JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (serialized === undefined) throw new AIError.ValidationError("pi-native boundary replacement is not JSON");
	return serialized;
}

async function postBoundaryDecision(
	url: string,
	headers: Record<string, string>,
	decision: PiNativeBoundaryApprovalDecision,
	fetchImpl: NonNullable<SimpleStreamOptions["fetch"]>,
	signal: AbortSignal,
): Promise<void> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { ...headers, Accept: "application/json" },
		body: JSON.stringify(decision),
		signal,
	});
	if (!response.ok) throw await decodeGatewayError(response);
	await response.arrayBuffer();
}

async function handleBoundaryPreparation(
	preparation: PiNativeBoundaryPreparation,
	options: SimpleStreamOptions | undefined,
	approvalUrl: string,
	headers: Record<string, string>,
	fetchImpl: NonNullable<SimpleStreamOptions["fetch"]>,
	signal: AbortSignal,
): Promise<void> {
	const modelJson = JSON.stringify(preparation.model);
	if (
		preparation.expiresAt <= Date.now() ||
		sha256Utf8(modelJson) !== preparation.modelSha256 ||
		sha256Utf8(preparation.payloadJson) !== preparation.payloadSha256
	) {
		throw new AIError.ValidationError("pi-native boundary preparation custody check failed");
	}

	let payload: unknown;
	try {
		payload = JSON.parse(preparation.payloadJson);
	} catch {
		throw new AIError.ValidationError("pi-native boundary preparation payload is not JSON");
	}
	try {
		if (preparation.kind === "payload") {
			if (!options?.onPayload)
				throw new AIError.ConfigurationError("pi-native payload approval callback is missing");
			const replacement = await options.onPayload(payload, preparation.model);
			if (replacement === undefined) {
				await postBoundaryDecision(approvalUrl, headers, boundaryDecision(preparation, "keep"), fetchImpl, signal);
				return;
			}
			const replacementJson = serializeBoundaryReplacement(replacement);
			await postBoundaryDecision(
				approvalUrl,
				headers,
				boundaryDecision(preparation, "replace", {
					replacementJson,
					replacementSha256: sha256Utf8(replacementJson),
				}),
				fetchImpl,
				signal,
			);
			return;
		}
		if (!options?.onToolContracts) {
			throw new AIError.ConfigurationError("pi-native tool-contract approval callback is missing");
		}
		await options.onToolContracts(payload, preparation.model);
		await postBoundaryDecision(approvalUrl, headers, boundaryDecision(preparation, "keep"), fetchImpl, signal);
	} catch (error) {
		try {
			await postBoundaryDecision(
				approvalUrl,
				headers,
				boundaryDecision(preparation, "reject", {
					error: error instanceof Error ? error.message : String(error),
				}),
				fetchImpl,
				signal,
			);
		} catch {
			// The original callback/custody failure remains authoritative.
		}
		throw error;
	}
}

/**
 * Stream a turn through an `omp auth-gateway` over the pi-native protocol.
 *
 * The returned {@link AssistantMessageEventStream} receives each parsed
 * `AssistantMessageEvent` verbatim from the gateway; the terminal `done` /
 * `error` event resolves `.result()` automatically via the base class's
 * completion check. Non-streaming consumers just call `.result()` and pay
 * for SSE framing they don't use — that overhead is dominated by provider
 * latency, so we always stream rather than maintaining a parallel
 * non-streaming path.
 */
export function streamPiNative<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStreamType {
	const stream = new AssistantMessageEventStream();

	void (async () => {
		const callerSignal = options?.signal;
		const abortTracker = createAbortSourceTracker(callerSignal);
		// Abort propagation: cancel the response body when the caller's signal
		// fires. Mirror `streamProxy`'s shape — explicit listener + finally
		// cleanup — so we don't leak listeners on the long-running case.
		let response: Response | null = null;
		const onAbort = (): void => {
			const body = response?.body;
			if (body) body.cancel("Request aborted by caller").catch(() => {});
		};
		if (callerSignal) {
			if (callerSignal.aborted) {
				stream.fail(
					callerSignal.reason instanceof Error
						? callerSignal.reason
						: new Error(String(callerSignal.reason ?? "aborted")),
				);
				return;
			}
			callerSignal.addEventListener("abort", onAbort, { once: true });
		}

		try {
			const gatewayBaseUrl = resolveGatewayBaseUrl(model as Model<Api>);
			const fetchImpl = options?.fetch ?? globalThis.fetch;
			const headers = buildHeaders(
				model as Model<Api>,
				typeof options?.apiKey === "string" ? options.apiKey : undefined,
			);
			const boundaryApproval =
				options?.onPayload || options?.onToolContracts
					? {
							version: 1 as const,
							payload: options.onPayload !== undefined,
							toolContracts: options.onToolContracts !== undefined,
						}
					: undefined;
			// A separate versioned route makes an old gateway fail with 404 before
			// dispatch. An unknown body field on the legacy route is not a capability check.
			const url = boundaryApproval ? `${gatewayBaseUrl}/v1/pi/boundary-stream/v1` : `${gatewayBaseUrl}/v1/pi/stream`;
			const approvalUrl = `${gatewayBaseUrl}/v1/pi/boundary-approval`;
			const request: PiNativeStreamRequest = {
				modelId: `${model.provider}/${model.id}`,
				context,
				options: buildWireOptions(options),
				stream: true,
				...(boundaryApproval ? { boundaryApproval } : undefined),
			};
			const body = JSON.stringify(request);

			response = await fetchImpl(url, {
				method: "POST",
				headers,
				body,
				signal: abortTracker.requestSignal,
			});
			if (!response.ok) {
				stream.fail(await decodeGatewayError(response));
				return;
			}
			// Callers can truthfully inspect the gateway HTTP response, but its
			// request body is opaque here; callbacks themselves never cross the wire.
			await notifyProviderResponse(
				options,
				response,
				model,
				response.headers.get("x-request-id") ?? response.headers.get("request-id"),
			);
			if (!response.body) {
				stream.fail(
					new AIError.AuthGatewayError("auth-gateway returned empty body", response.status, response.headers),
				);
				return;
			}

			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs();
			const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs);
			const source = readSseJson<PiNativeWireEvent>(
				response.body as ReadableStream<Uint8Array>,
				abortTracker.requestSignal,
			);
			const watchedSource = iterateWithIdleTimeout(source, {
				idleTimeoutMs,
				firstItemTimeoutMs: firstEventTimeoutMs,
				errorMessage: PI_NATIVE_STREAM_IDLE_TIMEOUT_ERROR,
				firstItemErrorMessage: PI_NATIVE_STREAM_FIRST_EVENT_TIMEOUT_ERROR,
				onIdle: () =>
					abortTracker.abortLocally(new AIError.StreamTimeoutError(PI_NATIVE_STREAM_IDLE_TIMEOUT_ERROR)),
				onFirstItemTimeout: () =>
					abortTracker.abortLocally(new AIError.StreamTimeoutError(PI_NATIVE_STREAM_FIRST_EVENT_TIMEOUT_ERROR)),
				isProgressItem: isPiNativeProgressEvent,
			});
			let boundaryCustody:
				| {
						requestId: string;
						streamId: string;
						sessionId: string;
						sequence: number;
						preparationIds: Set<string>;
				  }
				| undefined;
			let payloadApprovals = 0;
			let sawTerminal = false;
			for await (const event of watchedSource) {
				if (event.type === "pi_boundary_approval") {
					const preparation = event.boundaryApproval;
					if (!boundaryApproval) {
						throw new AIError.ValidationError("auth-gateway sent an unrequested pi-native boundary approval");
					}
					if (
						(preparation.kind === "payload" && !boundaryApproval.payload) ||
						(preparation.kind === "toolContracts" && !boundaryApproval.toolContracts)
					) {
						throw new AIError.ValidationError("auth-gateway sent an unrequested pi-native boundary kind");
					}
					if (!boundaryCustody) {
						const responseRequestId =
							response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
						if (responseRequestId && preparation.requestId !== responseRequestId) {
							throw new AIError.ValidationError("pi-native boundary preparation request binding mismatch");
						}
						boundaryCustody = {
							requestId: preparation.requestId,
							streamId: preparation.streamId,
							sessionId: preparation.sessionId,
							sequence: 0,
							preparationIds: new Set<string>(),
						};
					}
					if (
						preparation.requestId !== boundaryCustody.requestId ||
						preparation.streamId !== boundaryCustody.streamId ||
						preparation.sessionId !== boundaryCustody.sessionId ||
						preparation.sequence !== boundaryCustody.sequence + 1 ||
						boundaryCustody.preparationIds.has(preparation.preparationId)
					) {
						throw new AIError.ValidationError("pi-native boundary preparation sequence binding mismatch");
					}
					boundaryCustody.sequence = preparation.sequence;
					boundaryCustody.preparationIds.add(preparation.preparationId);
					if (preparation.kind === "payload") payloadApprovals++;
					await handleBoundaryPreparation(
						preparation,
						options,
						approvalUrl,
						headers,
						fetchImpl,
						abortTracker.requestSignal,
					);
					continue;
				}
				if (event.type === "done" && boundaryApproval?.payload && payloadApprovals === 0) {
					throw new AIError.ValidationError("auth-gateway completed without pi-native payload approval");
				}
				if (event.type === "done" || event.type === "error") sawTerminal = true;
				stream.push(event);
				// `stream.push` resolves `.result()` on `done`/`error`; subsequent
				// pushes are silently dropped by the base class. We still iterate
				// to drain any trailing bytes from the wire so the underlying TCP
				// stream closes cleanly.
			}

			if (!sawTerminal && boundaryApproval) {
				throw new AIError.ValidationError("auth-gateway closed protected pi-native stream without terminal event");
			}
			if (!sawTerminal) {
				// SSE closed before a terminal event reached us — synthesize one
				// so awaiters of `.result()` resolve instead of hanging forever.
				// Matches the gateway's own defensive fallback in
				// `pi-native-server.encodeStream`.
				const aborted = abortTracker.wasCallerAbort();
				const partial = makeSyntheticAssistant(model as Model<Api>);
				if (aborted) {
					partial.stopReason = "aborted";
					partial.errorMessage = "stream closed without terminal event";
					stream.push({ type: "error", reason: "aborted", error: partial });
				} else {
					partial.stopReason = "stop";
					stream.push({ type: "done", reason: "stop", message: partial });
				}
			}
			stream.end();
		} catch (err) {
			abortTracker.abortLocally(err instanceof Error ? err : new Error(String(err)));
			stream.fail(err);
		} finally {
			if (callerSignal) callerSignal.removeEventListener("abort", onAbort);
		}
	})();

	return stream;
}

function makeSyntheticAssistant(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
