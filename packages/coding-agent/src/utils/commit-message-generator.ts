/**
 * Generate commit messages from diffs using a smol, fast model.
 * Follows the same pattern as title-generator.ts.
 */
import { createHash } from "node:crypto";

import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type Api, type ApiKeyResolver, completeSimple, type Effort, type Model } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import MODEL_PRIO from "../priority.json" with { type: "json" };
import commitSystemPrompt from "../prompts/system/commit-message-system.md" with { type: "text" };
import { concreteThinkingLevel, toReasoningEffort } from "../thinking";

const COMMIT_SYSTEM_PROMPT = prompt.render(commitSystemPrompt);
const MAX_DIFF_CHARS = 4000;
// Cover the "backend ignores `disableReasoning`" case unconditionally: the
// static `model.reasoning` catalog flag can't distinguish a thinking model
// declared `reasoning: false` (e.g. Qwen3 served locally via llama.cpp) from
// one that never emits thinking. `maxTokens` is a hard cap — non-thinking
// completions still return in a handful of tokens (issue #4355).
const COMMIT_MAX_TOKENS = 1024;
const FROZEN_RESOLVER_KIND = "model_registry" as const;
const FROZEN_REASONING_VALUES: Record<string, true> = {
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

/** File patterns that should be excluded from commit message generation diffs. */
const NOISE_SUFFIXES = [".lock", ".lockb", "-lock.json", "-lock.yaml"];

type FrozenJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly FrozenJsonValue[]
	| { readonly [key: string]: FrozenJsonValue };

export interface FrozenCommitMessageUtf8V1 {
	readonly utf8: string;
	readonly byteLength: number;
	readonly sha256: string;
}

/** JSON-only model metadata used as the exact `completeSimple` descriptor. */
export type FrozenCommitMessageModelDescriptorV1 = Readonly<Model<Api>>;

export interface FrozenCommitMessageCandidateV1 {
	readonly model: FrozenCommitMessageModelDescriptorV1;
	readonly resolverKind: typeof FROZEN_RESOLVER_KIND;
	readonly sessionId: string | null;
}

/** A self-verifying, serializable commit-message request with no credential material. */
export interface FrozenCommitMessageInvocationV1 {
	readonly schemaVersion: 1;
	readonly candidate: FrozenCommitMessageCandidateV1;
	readonly systemPromptUtf8: string;
	readonly userPromptUtf8: string;
	readonly frozenAt: number;
	readonly maxTokens: number;
	readonly reasoning: Effort | null;
	readonly canonicalJsonUtf8: string;
	readonly canonicalJsonUtf8ByteLength: number;
	readonly canonicalJsonUtf8Sha256: string;
}

export interface FrozenCommitMessageRegistryV1 {
	getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined>;
	resolver(model: Model<Api>, sessionId?: string): ApiKeyResolver;
}

type FrozenCommitMessageTextResultV1 = {
	readonly responseText: FrozenCommitMessageUtf8V1 | null;
	readonly selectedText: FrozenCommitMessageUtf8V1 | null;
};

export type FrozenCommitMessageExecutionResultV1 =
	| ({ readonly status: "no_credentials" } & FrozenCommitMessageTextResultV1)
	| ({ readonly status: "provider_rejected" } & FrozenCommitMessageTextResultV1)
	| ({ readonly status: "empty_text" } & FrozenCommitMessageTextResultV1)
	| ({ readonly status: "invalid_text" } & FrozenCommitMessageTextResultV1)
	| ({ readonly status: "generated" } & FrozenCommitMessageTextResultV1)
	| ({ readonly status: "transport_outcome_unknown" } & FrozenCommitMessageTextResultV1);

export type FrozenCommitMessageInvocationBuilderV1 = (
	diff: string,
	frozenAt?: number,
) => readonly FrozenCommitMessageInvocationV1[];

/** Strip diff hunks for noisy files that drown out real changes. */
function filterDiffNoise(diff: string): string {
	const lines = diff.split("\n");
	const filtered: string[] = [];
	let skip = false;
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			const bPath = line.split(" b/")[1];
			skip = bPath != null && NOISE_SUFFIXES.some(s => bPath.endsWith(s));
		}
		if (!skip) filtered.push(line);
	}
	return filtered.join("\n");
}

function getSmolModelCandidates(
	registry: ModelRegistry,
	settings: Settings,
): Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return [];

	const candidates: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> = [];
	const addCandidate = (model?: Model<Api>, thinkingLevel?: ThinkingLevel): void => {
		if (!model) return;
		if (candidates.some(c => c.model.provider === model.provider && c.model.id === model.id)) return;
		candidates.push({ model, thinkingLevel });
	};

	const matchPreferences = getModelMatchPreferences(settings);
	const configuredSmol = resolveModelRoleValue(settings.getModelRole("smol"), availableModels, {
		settings,
		matchPreferences,
	});
	addCandidate(configuredSmol.model, concreteThinkingLevel(configuredSmol.thinkingLevel));

	for (const pattern of MODEL_PRIO.smol) {
		const needle = pattern.toLowerCase();
		addCandidate(availableModels.find(m => m.id.toLowerCase() === needle));
		addCandidate(availableModels.find(m => m.id.toLowerCase().includes(needle)));
	}

	for (const model of availableModels) {
		addCandidate(model);
	}

	return candidates;
}

function freezeJson(value: FrozenJsonValue): FrozenJsonValue {
	if (Array.isArray(value)) {
		for (const item of value) freezeJson(item);
		return Object.freeze(value);
	}
	if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) freezeJson(item);
		return Object.freeze(value);
	}
	return value;
}

function isCredentialFieldName(name: string): boolean {
	return /authorization|cookie|(?:api|access)[-_]?(?:key|token)|(?:^|[-_])(?:token|secret)(?:$|[-_])|(?:token|secret)$/i.test(
		name,
	);
}

function canonicalJsonValue(value: unknown): FrozenJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (Array.isArray(value)) return value.map(canonicalJsonValue);
	if (typeof value !== "object") {
		if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return null;
		throw new TypeError("Frozen commit-message model is not JSON-serializable");
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("Frozen commit-message model must be a plain JSON object");
	}
	const result: Record<string, FrozenJsonValue> = {};
	for (const key of Object.keys(value).sort()) {
		if (isCredentialFieldName(key)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor))
			throw new TypeError("Frozen commit-message model cannot contain accessors");
		if (
			typeof descriptor.value === "undefined" ||
			typeof descriptor.value === "function" ||
			typeof descriptor.value === "symbol"
		) {
			continue;
		}
		result[key] = canonicalJsonValue(descriptor.value);
	}
	return result;
}

function utf8Fact(utf8: string): FrozenCommitMessageUtf8V1 {
	const bytes = Buffer.from(utf8, "utf8");
	return Object.freeze({
		utf8,
		byteLength: bytes.byteLength,
		sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
	});
}

function invocationCore(
	invocation: Omit<
		FrozenCommitMessageInvocationV1,
		"canonicalJsonUtf8" | "canonicalJsonUtf8ByteLength" | "canonicalJsonUtf8Sha256"
	>,
): Record<string, unknown> {
	return {
		schemaVersion: invocation.schemaVersion,
		candidate: invocation.candidate,
		systemPromptUtf8: invocation.systemPromptUtf8,
		userPromptUtf8: invocation.userPromptUtf8,
		frozenAt: invocation.frozenAt,
		maxTokens: invocation.maxTokens,
		reasoning: invocation.reasoning,
	};
}

type FrozenCommitMessageBuilderCandidateV1 = {
	readonly candidate: FrozenCommitMessageCandidateV1;
	readonly reasoning: Effort | null;
};

function buildFrozenInvocation(
	candidate: FrozenCommitMessageBuilderCandidateV1,
	userPromptUtf8: string,
	frozenAt: number,
): FrozenCommitMessageInvocationV1 {
	const core = {
		schemaVersion: 1 as const,
		candidate: candidate.candidate,
		systemPromptUtf8: COMMIT_SYSTEM_PROMPT,
		userPromptUtf8,
		frozenAt,
		maxTokens: COMMIT_MAX_TOKENS,
		reasoning: candidate.reasoning,
	};
	const canonicalJsonUtf8 = JSON.stringify(invocationCore(core));
	if (canonicalJsonUtf8 === undefined)
		throw new TypeError("Frozen commit-message invocation is not JSON-serializable");
	const canonicalFact = utf8Fact(canonicalJsonUtf8);
	return Object.freeze({
		...core,
		canonicalJsonUtf8,
		canonicalJsonUtf8ByteLength: canonicalFact.byteLength,
		canonicalJsonUtf8Sha256: canonicalFact.sha256,
	});
}

/** Snapshot candidate order, model metadata, and reasoning before a future diff is available. */
export function createFrozenCommitMessageInvocationBuilderV1(
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
): FrozenCommitMessageInvocationBuilderV1 {
	const candidates = Object.freeze(
		getSmolModelCandidates(registry, settings).map(candidate =>
			Object.freeze({
				candidate: Object.freeze({
					model: freezeJson(
						canonicalJsonValue(candidate.model),
					) as unknown as FrozenCommitMessageModelDescriptorV1,
					resolverKind: FROZEN_RESOLVER_KIND,
					sessionId: sessionId ?? null,
				}),
				reasoning: toReasoningEffort(candidate.thinkingLevel) ?? null,
			}),
		),
	);
	return (diff, frozenAt = Date.now()) => {
		if (candidates.length === 0) return Object.freeze([]);
		const cleanDiff = filterDiffNoise(diff);
		const truncatedDiff =
			cleanDiff.length > MAX_DIFF_CHARS ? `${cleanDiff.slice(0, MAX_DIFF_CHARS)}\n… (truncated)` : cleanDiff;
		if (!truncatedDiff.trim()) return Object.freeze([]);
		const userPromptUtf8 = `<diff>\n${truncatedDiff}\n</diff>`;
		return Object.freeze(candidates.map(candidate => buildFrozenInvocation(candidate, userPromptUtf8, frozenAt)));
	};
}

/** Compatibility helper for callers that construct and consume one snapshot immediately. */
export function buildFrozenCommitMessageInvocationsV1(
	diff: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	frozenAt = Date.now(),
): readonly FrozenCommitMessageInvocationV1[] {
	return createFrozenCommitMessageInvocationBuilderV1(registry, settings, sessionId)(diff, frozenAt);
}

function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	try {
		const prototype = Object.getPrototypeOf(value);
		const ownKeys = Reflect.ownKeys(value);
		if (
			(prototype !== Object.prototype && prototype !== null) ||
			ownKeys.length !== keys.length ||
			!keys.every(key => ownKeys.includes(key))
		)
			return null;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (!descriptor?.enumerable || !("value" in descriptor)) return null;
		}
		return value as Record<string, unknown>;
	} catch {
		return null;
	}
}

function validJsonValue(value: unknown): value is FrozenJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(validJsonValue);
	if (value === null || typeof value !== "object") return false;
	const record = strictRecord(value, Object.keys(value));
	return (
		record !== null &&
		Object.entries(record).every(([key, entry]) => !isCredentialFieldName(key) && validJsonValue(entry))
	);
}

function decodeFrozenInvocation(input: unknown): FrozenCommitMessageInvocationV1 | null {
	const record = strictRecord(input, [
		"schemaVersion",
		"candidate",
		"systemPromptUtf8",
		"userPromptUtf8",
		"frozenAt",
		"maxTokens",
		"reasoning",
		"canonicalJsonUtf8",
		"canonicalJsonUtf8ByteLength",
		"canonicalJsonUtf8Sha256",
	]);
	if (
		record?.schemaVersion !== 1 ||
		typeof record.systemPromptUtf8 !== "string" ||
		typeof record.userPromptUtf8 !== "string"
	) {
		return null;
	}
	if (
		!Number.isSafeInteger(record.frozenAt) ||
		(record.frozenAt as number) < 0 ||
		!Number.isSafeInteger(record.maxTokens)
	)
		return null;
	if (
		record.reasoning !== null &&
		(typeof record.reasoning !== "string" || !Object.hasOwn(FROZEN_REASONING_VALUES, record.reasoning))
	)
		return null;
	if (
		typeof record.canonicalJsonUtf8 !== "string" ||
		!Number.isSafeInteger(record.canonicalJsonUtf8ByteLength) ||
		typeof record.canonicalJsonUtf8Sha256 !== "string"
	) {
		return null;
	}
	const candidate = strictRecord(record.candidate, ["model", "resolverKind", "sessionId"]);
	if (
		!candidate ||
		candidate.resolverKind !== FROZEN_RESOLVER_KIND ||
		(candidate.sessionId !== null && typeof candidate.sessionId !== "string") ||
		!validJsonValue(candidate.model) ||
		candidate.model === null ||
		typeof candidate.model !== "object" ||
		Array.isArray(candidate.model)
	)
		return null;
	const model = candidate.model as Record<string, unknown>;
	if (
		typeof model.provider !== "string" ||
		typeof model.id !== "string" ||
		typeof model.name !== "string" ||
		typeof model.api !== "string" ||
		typeof model.baseUrl !== "string" ||
		typeof model.reasoning !== "boolean" ||
		!Array.isArray(model.input) ||
		!validJsonValue(model.cost) ||
		(model.contextWindow !== null && typeof model.contextWindow !== "number") ||
		(model.maxTokens !== null && typeof model.maxTokens !== "number") ||
		!validJsonValue(model.compat)
	)
		return null;
	const frozen = Object.freeze({
		schemaVersion: 1 as const,
		candidate: Object.freeze({
			model: freezeJson(canonicalJsonValue(model)) as unknown as FrozenCommitMessageModelDescriptorV1,
			resolverKind: FROZEN_RESOLVER_KIND,
			sessionId: candidate.sessionId as string | null,
		}),
		systemPromptUtf8: record.systemPromptUtf8,
		userPromptUtf8: record.userPromptUtf8,
		frozenAt: record.frozenAt as number,
		maxTokens: record.maxTokens as number,
		reasoning: record.reasoning as Effort | null,
		canonicalJsonUtf8: record.canonicalJsonUtf8,
		canonicalJsonUtf8ByteLength: record.canonicalJsonUtf8ByteLength as number,
		canonicalJsonUtf8Sha256: record.canonicalJsonUtf8Sha256,
	});
	const fact = utf8Fact(frozen.canonicalJsonUtf8);
	if (
		fact.byteLength !== frozen.canonicalJsonUtf8ByteLength ||
		fact.sha256 !== frozen.canonicalJsonUtf8Sha256 ||
		frozen.canonicalJsonUtf8 !== JSON.stringify(invocationCore(frozen))
	)
		return null;
	return frozen;
}

/** Strict decoder used by the executor before it resolves any credential. */
export function decodeFrozenCommitMessageInvocationV1(input: unknown): FrozenCommitMessageInvocationV1 {
	const invocation = decodeFrozenInvocation(input);
	if (invocation === null) throw new TypeError("Invalid frozen commit-message invocation");
	return invocation;
}

/** Execute exactly one frozen request; model selection and prompt rendering are intentionally unavailable here. */
export async function executeFrozenCommitMessageInvocationV1(
	input: unknown,
	registry: FrozenCommitMessageRegistryV1,
): Promise<FrozenCommitMessageExecutionResultV1> {
	const invocation = decodeFrozenCommitMessageInvocationV1(input);
	const { model, sessionId } = invocation.candidate;
	let apiKey: string | undefined;
	try {
		apiKey = await registry.getApiKey(model, sessionId ?? undefined);
	} catch {
		return Object.freeze({ status: "transport_outcome_unknown", responseText: null, selectedText: null });
	}
	if (!apiKey) return Object.freeze({ status: "no_credentials", responseText: null, selectedText: null });
	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: [invocation.systemPromptUtf8],
				messages: [{ role: "user", content: invocation.userPromptUtf8, timestamp: invocation.frozenAt }],
			},
			{
				apiKey: registry.resolver(model, sessionId ?? undefined),
				maxTokens: invocation.maxTokens,
				reasoning: invocation.reasoning ?? undefined,
			},
		);
		const responseText = utf8Fact(
			response.content.reduce((text, content) => (content.type === "text" ? text + content.text : text), ""),
		);
		if (response.stopReason === "error") {
			return Object.freeze({ status: "provider_rejected", responseText, selectedText: null });
		}
		const trimmed = responseText.utf8.trim();
		if (!trimmed) return Object.freeze({ status: "empty_text", responseText, selectedText: null });
		const selectedText = utf8Fact(trimmed.replace(/^[`"']|[`"']$/g, "").replace(/\.$/, ""));
		return Object.freeze({
			status: selectedText.utf8 ? "generated" : "invalid_text",
			responseText,
			selectedText,
		});
	} catch {
		return Object.freeze({ status: "transport_outcome_unknown", responseText: null, selectedText: null });
	}
}

/**
 * Generate a commit message from a unified diff.
 * Returns null if generation fails (caller should fall back to generic message).
 */
export async function generateCommitMessage(
	diff: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
): Promise<string | null> {
	const invocations = buildFrozenCommitMessageInvocationsV1(diff, registry, settings, sessionId);
	if (invocations.length === 0) {
		logger.debug("commit-msg-generator: no smol model found");
		return null;
	}
	for (const invocation of invocations) {
		const result = await executeFrozenCommitMessageInvocationV1(invocation, registry);
		const model = invocation.candidate.model;
		if (result.status === "generated" || result.status === "invalid_text") {
			const msg = result.selectedText?.utf8 ?? "";
			logger.debug("commit-msg-generator: generated", { model: model.id, msg });
			return msg;
		}
		if (result.status === "provider_rejected") {
			logger.debug("commit-msg-generator: error", { model: model.id });
		} else if (result.status === "transport_outcome_unknown") {
			logger.debug("commit-msg-generator: error", { model: model.id });
		}
	}
	return null;
}
