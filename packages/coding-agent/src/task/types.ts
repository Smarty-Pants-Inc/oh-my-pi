import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { type BaseType, type } from "@oh-my-pi/omptype";
import type { Usage } from "@oh-my-pi/pi-ai";
import { $env, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../session/agent-session";
import {
	type ConfidentialTransientTaskForegroundSourceResultSnapshotV1,
	type ConfidentialTransientTaskSourceObservationResultV1,
	TRANSIENT_EVAL_FOREGROUND_SOURCE_VALUE_TOOL_ERROR_TEXT_V1,
	TRANSIENT_TASK_FOREGROUND_SOURCE_VALUE_TOOL_ERROR_TEXT_V1,
	type TransientEvalForegroundSourceAgentToolResultV1,
	type TransientEvalForegroundSourceProjectionResultV1,
	type TransientEvalForegroundSourceValueToolErrorResultV1,
	type TransientForegroundAgentToolResultV1,
	type TransientForegroundSourceAgentToolResultV1,
	type TransientTaskForegroundSourceAgentToolResultV1,
	type TransientTaskForegroundSourceProjectionResultV1,
	type TransientTaskForegroundSourceValueToolErrorResultV1,
	type TransientTaskForegroundTaggedSourceValueV1,
} from "../session/workspace-runtime-contracts";
import type { ConfiguredThinkingLevel, TaskEffort } from "../thinking";
import type { NestedRepoPatch } from "./worktree";

const stringifyTransientTaskForegroundValue = JSON.stringify.bind(JSON);

function transientTaskForegroundUtf8Sha256(value: string): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function transientTaskForegroundTupleSha256(tuple: readonly unknown[]): `sha256:${string}` {
	const utf8 = stringifyTransientTaskForegroundValue(tuple);
	if (utf8 === undefined) throw new TypeError("Foreground tuple is not JSON-representable");
	return transientTaskForegroundUtf8Sha256(utf8);
}

function transientTaskForegroundPointer(parent: string, key: string): string {
	return `${parent}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function tagTransientTaskForegroundSourceValue(
	input: unknown,
	pointer: string,
	active: Set<object>,
	ownUndefinedJsonPointers: string[],
): TransientTaskForegroundTaggedSourceValueV1 {
	if (input === undefined) {
		ownUndefinedJsonPointers.push(pointer);
		return { kind: "undefined" };
	}
	if (input === null) return { kind: "null" };
	if (typeof input === "boolean") return { kind: "boolean", value: input };
	if (typeof input === "number") {
		if (!Number.isFinite(input) || Object.is(input, -0)) throw new TypeError("Invalid foreground source number");
		return { kind: "number", value: input };
	}
	if (typeof input === "string") {
		if (!input.isWellFormed()) throw new TypeError("Invalid foreground source string");
		return { kind: "string", value: input };
	}
	if (typeof input !== "object" || isProxy(input) || active.has(input)) {
		throw new TypeError("Invalid foreground source value");
	}

	active.add(input);
	try {
		if (Array.isArray(input)) {
			if (Object.getPrototypeOf(input) !== Array.prototype) throw new TypeError("Invalid foreground source array");
			const descriptors = Object.getOwnPropertyDescriptors(input);
			const keys = Reflect.ownKeys(input);
			if (keys.length !== input.length + 1 || keys.some(key => typeof key !== "string")) {
				throw new TypeError("Invalid foreground source array shape");
			}
			const items: TransientTaskForegroundTaggedSourceValueV1[] = [];
			for (let index = 0; index < input.length; index++) {
				const descriptor = descriptors[String(index)];
				if (descriptor?.enumerable !== true || !("value" in descriptor) || descriptor.value === undefined) {
					throw new TypeError("Invalid foreground source array entry");
				}
				items.push(
					tagTransientTaskForegroundSourceValue(
						descriptor.value,
						transientTaskForegroundPointer(pointer, String(index)),
						active,
						ownUndefinedJsonPointers,
					),
				);
			}
			return { kind: "array", items };
		}

		const prototype = Object.getPrototypeOf(input);
		if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Invalid foreground source object");
		const descriptors = Object.getOwnPropertyDescriptors(input);
		const keys = Reflect.ownKeys(input);
		if (keys.some(key => typeof key !== "string")) throw new TypeError("Invalid foreground source object key");
		const entries: Array<{ key: string; value: TransientTaskForegroundTaggedSourceValueV1 }> = [];
		for (const key of keys as string[]) {
			if (!key.isWellFormed()) throw new TypeError("Invalid foreground source object key");
			const descriptor = descriptors[key];
			if (descriptor?.enumerable !== true || !("value" in descriptor)) {
				throw new TypeError("Invalid foreground source object entry");
			}
			entries.push({
				key,
				value: tagTransientTaskForegroundSourceValue(
					descriptor.value,
					transientTaskForegroundPointer(pointer, key),
					active,
					ownUndefinedJsonPointers,
				),
			});
		}
		return { kind: "object", entries };
	} finally {
		active.delete(input);
	}
}

function transientTaskForegroundDataRecord(input: unknown): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input) || isProxy(input)) {
		throw new TypeError("Invalid foreground source record");
	}
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Invalid foreground source record");
	return input as Record<string, unknown>;
}

function transientTaskForegroundExactKeys(
	record: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const allowed = new Set([...required, ...optional]);
	const keys = Object.keys(record);
	if (required.some(key => !Object.hasOwn(record, key)) || keys.some(key => !allowed.has(key))) {
		throw new TypeError("Invalid foreground source DTO shape");
	}
}

function validateTransientTaskForegroundSourceShape(input: unknown): TransientTaskForegroundSourceAgentToolResultV1 {
	const result = transientTaskForegroundDataRecord(input);
	transientTaskForegroundExactKeys(result, ["content"], ["details", "isError", "providerMetadata", "useless"]);
	if (!Array.isArray(result.content)) throw new TypeError("Invalid foreground source content");
	for (const member of result.content) {
		const content = transientTaskForegroundDataRecord(member);
		if (content.type === "text") {
			transientTaskForegroundExactKeys(content, ["type", "text"], ["textSignature"]);
			if (
				typeof content.text !== "string" ||
				(content.textSignature !== undefined && typeof content.textSignature !== "string")
			) {
				throw new TypeError("Invalid foreground source text content");
			}
		} else if (content.type === "image") {
			transientTaskForegroundExactKeys(content, ["type", "data", "mimeType"], ["detail"]);
			if (
				typeof content.data !== "string" ||
				typeof content.mimeType !== "string" ||
				(content.detail !== undefined && !["auto", "low", "high", "original"].includes(content.detail as string))
			) {
				throw new TypeError("Invalid foreground source image content");
			}
		} else {
			throw new TypeError("Invalid foreground source content type");
		}
	}
	if (result.isError !== undefined && typeof result.isError !== "boolean") {
		throw new TypeError("Invalid foreground source error flag");
	}
	if (result.useless !== undefined && typeof result.useless !== "boolean") {
		throw new TypeError("Invalid foreground source useless flag");
	}
	if (result.details !== undefined) {
		const details = transientTaskForegroundDataRecord(result.details);
		transientTaskForegroundExactKeys(
			details,
			["projectAgentsDir", "results", "totalDurationMs"],
			["usage", "outputPaths", "progress", "async"],
		);
		if (
			(details.projectAgentsDir !== null && typeof details.projectAgentsDir !== "string") ||
			!Array.isArray(details.results) ||
			typeof details.totalDurationMs !== "number" ||
			(details.outputPaths !== undefined &&
				(!Array.isArray(details.outputPaths) || details.outputPaths.some(value => typeof value !== "string"))) ||
			(details.progress !== undefined && !Array.isArray(details.progress))
		) {
			throw new TypeError("Invalid foreground source task details");
		}
		if (details.async !== undefined) {
			const asynchronous = transientTaskForegroundDataRecord(details.async);
			transientTaskForegroundExactKeys(asynchronous, ["state", "jobId", "type"]);
			if (
				!["running", "completed", "failed"].includes(asynchronous.state as string) ||
				typeof asynchronous.jobId !== "string" ||
				asynchronous.type !== "task"
			) {
				throw new TypeError("Invalid foreground source async details");
			}
		}
	}
	if (result.providerMetadata !== undefined) {
		const metadata = transientTaskForegroundDataRecord(result.providerMetadata);
		transientTaskForegroundExactKeys(metadata, ["type", "screenshot", "acknowledgedSafetyChecks"]);
		if (metadata.type !== "computer" || !Array.isArray(metadata.acknowledgedSafetyChecks)) {
			throw new TypeError("Invalid foreground source provider metadata");
		}
		const screenshot = transientTaskForegroundDataRecord(metadata.screenshot);
		if (screenshot.type !== "computer_screenshot") throw new TypeError("Invalid foreground source screenshot");
		if (Object.hasOwn(screenshot, "image_url")) {
			transientTaskForegroundExactKeys(screenshot, ["type", "image_url"]);
			if (typeof screenshot.image_url !== "string") throw new TypeError("Invalid foreground source screenshot URL");
		} else {
			transientTaskForegroundExactKeys(screenshot, ["type", "file_id"]);
			if (typeof screenshot.file_id !== "string") throw new TypeError("Invalid foreground source screenshot id");
		}
	}
	return result as unknown as TransientTaskForegroundSourceAgentToolResultV1;
}

function validateTransientEvalForegroundSourceShape(input: unknown): TransientEvalForegroundSourceAgentToolResultV1 {
	const result = transientTaskForegroundDataRecord(input);
	transientTaskForegroundExactKeys(result, ["content"], ["details", "isError", "providerMetadata", "useless"]);
	if (!Array.isArray(result.content)) throw new TypeError("Invalid eval foreground source content");
	for (const member of result.content) {
		const content = transientTaskForegroundDataRecord(member);
		if (content.type === "text") {
			transientTaskForegroundExactKeys(content, ["type", "text"], ["textSignature"]);
			if (
				typeof content.text !== "string" ||
				(content.textSignature !== undefined && typeof content.textSignature !== "string")
			) {
				throw new TypeError("Invalid eval foreground source text content");
			}
		} else if (content.type === "image") {
			transientTaskForegroundExactKeys(content, ["type", "data", "mimeType"], ["detail"]);
			if (
				typeof content.data !== "string" ||
				typeof content.mimeType !== "string" ||
				(content.detail !== undefined && !["auto", "low", "high", "original"].includes(content.detail as string))
			) {
				throw new TypeError("Invalid eval foreground source image content");
			}
		} else {
			throw new TypeError("Invalid eval foreground source content type");
		}
	}
	if (result.isError !== undefined && typeof result.isError !== "boolean") {
		throw new TypeError("Invalid eval foreground source error flag");
	}
	if (result.useless !== undefined && typeof result.useless !== "boolean") {
		throw new TypeError("Invalid eval foreground source useless flag");
	}
	if (result.details !== undefined) transientTaskForegroundDataRecord(result.details);
	if (result.providerMetadata !== undefined) {
		const metadata = transientTaskForegroundDataRecord(result.providerMetadata);
		transientTaskForegroundExactKeys(metadata, ["type", "screenshot", "acknowledgedSafetyChecks"]);
		if (metadata.type !== "computer" || !Array.isArray(metadata.acknowledgedSafetyChecks)) {
			throw new TypeError("Invalid eval foreground source provider metadata");
		}
		const screenshot = transientTaskForegroundDataRecord(metadata.screenshot);
		if (screenshot.type !== "computer_screenshot") throw new TypeError("Invalid eval foreground source screenshot");
		if (Object.hasOwn(screenshot, "image_url")) {
			transientTaskForegroundExactKeys(screenshot, ["type", "image_url"]);
			if (typeof screenshot.image_url !== "string")
				throw new TypeError("Invalid eval foreground source screenshot URL");
		} else {
			transientTaskForegroundExactKeys(screenshot, ["type", "file_id"]);
			if (typeof screenshot.file_id !== "string")
				throw new TypeError("Invalid eval foreground source screenshot id");
		}
	}
	return result as unknown as TransientEvalForegroundSourceAgentToolResultV1;
}

function projectTransientTaskForegroundWireValue(input: unknown): unknown {
	if (input === undefined) return undefined;
	if (input === null || typeof input === "boolean" || typeof input === "number" || typeof input === "string")
		return input;
	if (Array.isArray(input)) return input.map(projectTransientTaskForegroundWireValue);
	const source = input as Record<string, unknown>;
	const projected: Record<string, unknown> = {};
	for (const key of Object.keys(source)) {
		const value = projectTransientTaskForegroundWireValue(source[key]);
		if (value !== undefined) projected[key] = value;
	}
	return projected;
}

function projectTransientTaskForegroundWireResult(
	source: TransientForegroundSourceAgentToolResultV1,
): TransientForegroundAgentToolResultV1 {
	const content = source.content.map(member => {
		if (member.type === "text") return { type: "text" as const, text: sanitizeText(member.text) };
		return {
			type: "image" as const,
			data: member.data,
			mimeType: member.mimeType,
			...(member.detail !== undefined ? { detail: member.detail } : {}),
		};
	});
	const projected = {
		content,
		...(source.details !== undefined ? { details: projectTransientTaskForegroundWireValue(source.details) } : {}),
		...(source.providerMetadata !== undefined
			? { providerMetadata: projectTransientTaskForegroundWireValue(source.providerMetadata) }
			: {}),
		...(source.isError === true
			? { isError: true as const }
			: source.useless === true
				? { useless: true as const }
				: {}),
	};
	return projected as TransientForegroundAgentToolResultV1;
}

function projectValidTransientTaskForegroundSourceResult(
	source: TransientForegroundSourceAgentToolResultV1,
	taggedSourceResult: TransientTaskForegroundTaggedSourceValueV1,
	ownUndefinedJsonPointers: string[],
): ConfidentialTransientTaskSourceObservationResultV1 {
	const sourceSnapshotUtf8 = stringifyTransientTaskForegroundValue(taggedSourceResult);
	if (sourceSnapshotUtf8 === undefined) throw new TypeError("Foreground source snapshot encoding failed");
	const sourceResultSnapshot: ConfidentialTransientTaskForegroundSourceResultSnapshotV1 = {
		schemaVersion: 1,
		taggedSourceResult,
		ownUndefinedJsonPointers,
		sourceSnapshotUtf8,
		sourceSnapshotUtf8Sha256: transientTaskForegroundUtf8Sha256(sourceSnapshotUtf8),
		sourceSnapshotUtf8ByteLength: Buffer.byteLength(sourceSnapshotUtf8, "utf8"),
	};
	const wireResult = projectTransientTaskForegroundWireResult(source);
	const resultUtf8 = stringifyTransientTaskForegroundValue(wireResult);
	if (resultUtf8 === undefined) throw new TypeError("Foreground wire result encoding failed");
	const core = {
		sourceResult: source,
		sourceResultSnapshot,
		wireResult,
		resultUtf8,
		resultUtf8Sha256: transientTaskForegroundUtf8Sha256(resultUtf8),
		resultUtf8ByteLength: Buffer.byteLength(resultUtf8, "utf8"),
	};
	return {
		core,
		resultProjectionSha256: transientTaskForegroundTupleSha256([
			"omp-transient-task-source-observation-v1",
			"result-projection-core",
			1,
			core.sourceResult,
			core.sourceResultSnapshot,
			core.wireResult,
			core.resultUtf8,
			core.resultUtf8Sha256,
			core.resultUtf8ByteLength,
		]),
	};
}

/** Total TaskTool producer boundary. Valid results retain their exact original reference. */
export function validateAndProjectTransientTaskForegroundSourceAgentToolResultV1(
	source: unknown,
): TransientTaskForegroundSourceProjectionResultV1 {
	try {
		const ownUndefinedJsonPointers: string[] = [];
		const taggedSourceResult = tagTransientTaskForegroundSourceValue(source, "", new Set(), ownUndefinedJsonPointers);
		const sourceResult = validateTransientTaskForegroundSourceShape(source);
		const projection = projectValidTransientTaskForegroundSourceResult(
			sourceResult,
			taggedSourceResult,
			ownUndefinedJsonPointers,
		);
		return { status: "projected", sourceDisposition: "unchanged_valid", sourceResult, projection };
	} catch {
		const toolResult = Object.freeze({
			content: Object.freeze([
				Object.freeze({
					type: "text" as const,
					text: TRANSIENT_TASK_FOREGROUND_SOURCE_VALUE_TOOL_ERROR_TEXT_V1,
				}),
			]),
			isError: true as const,
		}) as TransientTaskForegroundSourceValueToolErrorResultV1;
		const toolResultOwnUndefinedJsonPointers: string[] = [];
		const toolResultTaggedSourceResult = tagTransientTaskForegroundSourceValue(
			toolResult,
			"",
			new Set(),
			toolResultOwnUndefinedJsonPointers,
		);
		const toolResultProjection = projectValidTransientTaskForegroundSourceResult(
			toolResult,
			toolResultTaggedSourceResult,
			toolResultOwnUndefinedJsonPointers,
		);
		const core = {
			schemaVersion: 1 as const,
			code: "foreground_source_value_unrepresentable" as const,
			noHandoffReason: "source_value_unrepresentable" as const,
			toolResult,
			toolResultProjection,
		};
		return {
			status: "rejected",
			sourceDisposition: "fixed_tool_error",
			rejection: {
				core,
				rejectionSha256: transientTaskForegroundTupleSha256([
					"omp-transient-task-foreground-source-result-v1",
					"rejection-core",
					1,
					core.code,
					core.noHandoffReason,
					core.toolResult,
					core.toolResultProjection,
				]),
			},
		};
	}
}

/** Total EvalTool producer boundary. Valid results retain their exact original reference. */
export function validateAndProjectTransientEvalForegroundSourceAgentToolResultV1(
	source: unknown,
): TransientEvalForegroundSourceProjectionResultV1 {
	try {
		const ownUndefinedJsonPointers: string[] = [];
		const taggedSourceResult = tagTransientTaskForegroundSourceValue(source, "", new Set(), ownUndefinedJsonPointers);
		const sourceResult = validateTransientEvalForegroundSourceShape(source);
		const projection = projectValidTransientTaskForegroundSourceResult(
			sourceResult,
			taggedSourceResult,
			ownUndefinedJsonPointers,
		);
		return { status: "projected", sourceDisposition: "unchanged_valid", sourceResult, projection };
	} catch {
		const toolResult = Object.freeze({
			content: Object.freeze([
				Object.freeze({
					type: "text" as const,
					text: TRANSIENT_EVAL_FOREGROUND_SOURCE_VALUE_TOOL_ERROR_TEXT_V1,
				}),
			]),
			isError: true as const,
		}) as TransientEvalForegroundSourceValueToolErrorResultV1;
		const ownUndefinedJsonPointers: string[] = [];
		const taggedSourceResult = tagTransientTaskForegroundSourceValue(
			toolResult,
			"",
			new Set(),
			ownUndefinedJsonPointers,
		);
		const toolResultProjection = projectValidTransientTaskForegroundSourceResult(
			toolResult,
			taggedSourceResult,
			ownUndefinedJsonPointers,
		);
		const core = {
			schemaVersion: 1 as const,
			code: "eval_foreground_source_value_unrepresentable" as const,
			noHandoffReason: "source_value_unrepresentable" as const,
			toolResult,
			toolResultProjection,
		};
		return {
			status: "rejected",
			sourceDisposition: "fixed_tool_error",
			rejection: {
				core,
				rejectionSha256: transientTaskForegroundTupleSha256([
					"omp-transient-eval-foreground-source-result-v1",
					"rejection-core",
					1,
					core.code,
					core.noHandoffReason,
					core.toolResult,
					core.toolResultProjection,
				]),
			},
		};
	}
}

/** Source of an agent definition */
export type AgentSource = "bundled" | "user" | "project";
/**
 * Enforcement policy for a structured subagent output schema.
 *
 * `permissive` preserves legacy retry-budget overrides; `strict` turns every
 * invalid final payload, including an exhausted retry override, into a failed
 * `schema_violation` result.
 */
export type StructuredSubagentSchemaMode = "permissive" | "strict";

/** Origin of the schema selected for a structured subagent invocation. */
export type StructuredSubagentSchemaSource = "caller" | "agent" | "session" | "none";

/** Final validation state of a structured subagent invocation. */
export type StructuredSubagentValidationStatus = "valid" | "invalid" | "unavailable";

/**
 * Parsed structured completion and its schema-validation metadata.
 *
 * `data` is present whenever a payload could be assembled or parsed, even when
 * strict validation rejects it. `error` explains unavailable or invalid
 * validation without requiring consumers to parse presentation text.
 */
export interface StructuredSubagentOutput {
	source: StructuredSubagentSchemaSource;
	mode: StructuredSubagentSchemaMode;
	status: StructuredSubagentValidationStatus;
	data?: unknown;
	error?: string;
}

/** Machine-readable structured-subagent failure retained by resultless projection. */
export class StructuredSubagentError extends Error {
	readonly kind: "preflight" | "isolation" | "execution";

	constructor(kind: "preflight" | "isolation" | "execution", message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "StructuredSubagentError";
		this.kind = kind;
	}
}

const parseNumber = (value: string | undefined, defaultValue: number): number => {
	if (value) {
		try {
			const number = Number.parseInt(value, 10);
			if (!Number.isNaN(number) && number > 0) {
				return number;
			}
		} catch {}
	}
	return defaultValue;
};

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = parseNumber($env.PI_TASK_MAX_OUTPUT_BYTES, 500_000);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = parseNumber($env.PI_TASK_MAX_OUTPUT_LINES, 5000);

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** EventBus channel for aggregated subagent progress */
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

/** EventBus channel for subagent lifecycle (start/end) */
export const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

/** Payload emitted on TASK_SUBAGENT_PROGRESS_CHANNEL */
export interface SubagentProgressPayload {
	index: number;
	agent: string;
	agentSource: AgentSource;
	task: string;
	parentToolCallId?: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;
	/** See {@link SubagentLifecyclePayload.detached}. */
	detached?: boolean;
}

/** Payload emitted on TASK_SUBAGENT_EVENT_CHANNEL */
export interface SubagentEventPayload {
	id: string;
	event: AgentSessionEvent;
}

/** Payload emitted on TASK_SUBAGENT_LIFECYCLE_CHANNEL */
export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	agentSource: AgentSource;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;
	/**
	 * Spawn runs as a detached background job: the parent turn keeps working
	 * while this agent runs. Sync task spawns (parent blocked on the call) and
	 * eval `agent()` bridge spawns (rendered inside their eval cell) leave this
	 * unset — surfaces like the subagent HUD only list detached spawns.
	 */
	detached?: boolean;
}

/** Display cap for a normalized one-line label (roster line, registry `displayName`, prompt field). */
export const LABEL_MAX = 80;

// Keep this explicit: ArkType serializes `unknown` as a boolean subschema, which llama.cpp grammars reject.
const outputSchemaInputSchema = type("object | boolean | string | null");
// Coarse per-spawn thinking effort; must stay in sync with TASK_EFFORTS in ../thinking.
const effortRule = '"lo" | "med" | "hi"' as const;
const selectableExecutionField = { "execution?": '"local" | "environment"' } as const;

function rejectExecutionField<T>(schema: T): T {
	return (schema as unknown as BaseType).filter((value, ctx) => {
		if (value !== null && typeof value === "object" && Object.hasOwn(value, "execution")) {
			return ctx.mustBe("provided without `execution`; that field is unavailable for this task shape");
		}
		return true;
	}) as unknown as T;
}

export const taskItemSchema = rejectExecutionField(
	type({
		"name?": "string",
		agent: "string = 'task'",
		task: "string",
		"outputSchema?": outputSchemaInputSchema,
		"schemaMode?": '"permissive" | "strict"',
		"+": "delete",
	}),
);
const taskItemSchemaIsolated = rejectExecutionField(
	type({
		"name?": "string",
		agent: "string = 'task'",
		task: "string",
		"outputSchema?": outputSchemaInputSchema,
		"schemaMode?": '"permissive" | "strict"',
		"isolated?": "boolean",
		"+": "delete",
	}),
);

/** Single task item. Fields are optional defensively: args stream in token by token. */
export interface TaskItem {
	/** Stable agent name; becomes the registry/IRC id. Default = generated AdjectiveNoun. */
	name?: string;
	/** Agent type to run this item (e.g. "scout"). Defaults to the spawn policy's default agent. */
	agent?: string;
	/** The work; required by the schema. */
	task?: string;
	/** Per-spawn thinking effort: lowest/middle/highest level the resolved model supports. Overrides the agent's default selector (e.g. `auto`). */
	effort?: TaskEffort;
	/** Caller-provided output schema; its presence overrides the selected agent's schema. */
	outputSchema?: unknown;
	/** Validation behavior for a caller-provided or inherited output schema. */
	schemaMode?: "permissive" | "strict";
	/** Run this spawn in an isolated worktree (batch form; flat form carries it top-level). */
	isolated?: boolean;
}

export const taskSchema = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	...selectableExecutionField,
	"isolated?": "boolean",
	"+": "delete",
});
const taskSchemaIsolated = rejectExecutionField(
	type({
		"name?": "string",
		agent: "string = 'task'",
		task: "string",
		"outputSchema?": outputSchemaInputSchema,
		"schemaMode?": '"permissive" | "strict"',
		"isolated?": "boolean",
		"+": "delete",
	}),
);
const taskSchemaNoIsolation = rejectExecutionField(
	type({
		"name?": "string",
		agent: "string = 'task'",
		task: "string",
		"outputSchema?": outputSchemaInputSchema,
		"schemaMode?": '"permissive" | "strict"',
		"+": "delete",
	}),
);
const taskSchemaBatch = rejectExecutionField(
	type({
		context: "string",
		tasks: taskItemSchemaIsolated.array(),
		"+": "delete",
	}),
);
const taskSchemaBatchNoIsolation = rejectExecutionField(
	type({
		context: "string",
		tasks: taskItemSchema.array(),
		"+": "delete",
	}),
);
const ALL_TASK_SCHEMAS = [
	taskSchema,
	taskSchemaIsolated,
	taskSchemaNoIsolation,
	taskSchemaBatch,
	taskSchemaBatchNoIsolation,
] as const;

type DynamicTaskSchema = (typeof ALL_TASK_SCHEMAS)[number];
export type TaskSchema = typeof taskSchema;
/** Active task tool parameter schema for the current isolation / batch flags */
export type TaskToolSchemaInstance = DynamicTaskSchema | BaseType;

const TASK_AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const taskSchemaCache = new Map<string, BaseType>();

function taskAgentSchemaRule(defaultAgent: string): string {
	const trimmed = defaultAgent.trim();
	if (TASK_AGENT_NAME_PATTERN.test(trimmed)) {
		return `string = '${trimmed}'`;
	}
	return "string";
}

function createTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	defaultAgent: string;
	effortEnabled: boolean;
	environmentEnabled: boolean;
}): BaseType {
	const agent = taskAgentSchemaRule(options.defaultAgent);
	const effortField = options.effortEnabled ? { "effort?": effortRule } : {};
	if (options.batchEnabled) {
		const item = rejectExecutionField(
			type.raw({
				"name?": "string",
				agent,
				task: "string",
				...effortField,
				"outputSchema?": outputSchemaInputSchema,
				"schemaMode?": '"permissive" | "strict"',
				...(options.isolationEnabled ? { "isolated?": "boolean" as const } : {}),
				"+": "delete",
			}),
		);
		return rejectExecutionField(
			type.raw({
				context: "string",
				tasks: item.array(),
				"+": "delete",
			}),
		);
	}
	const schema = type.raw({
		"name?": "string",
		agent,
		task: "string",
		...effortField,
		"outputSchema?": outputSchemaInputSchema,
		"schemaMode?": '"permissive" | "strict"',
		...(options.isolationEnabled ? { "isolated?": "boolean" as const } : {}),
		...(options.environmentEnabled ? selectableExecutionField : {}),
		"+": "delete",
	});
	return options.environmentEnabled ? schema : rejectExecutionField(schema);
}

/** Build the task wire schema for the current settings and spawn policy. */
export function getTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	effortEnabled?: boolean;
	defaultAgent?: string;
	environmentEnabled?: boolean;
}): TaskToolSchemaInstance {
	const defaultAgent = options.defaultAgent ?? "task";
	const effortEnabled = options.effortEnabled ?? false;
	const environmentEnabled = options.isolationEnabled && (options.environmentEnabled ?? false);
	if (defaultAgent === "task" && !effortEnabled) {
		if (options.batchEnabled) return options.isolationEnabled ? taskSchemaBatch : taskSchemaBatchNoIsolation;
		if (!options.isolationEnabled) return taskSchemaNoIsolation;
		return environmentEnabled ? taskSchema : taskSchemaIsolated;
	}
	const key = `${options.isolationEnabled ? "iso" : "flat"}:${options.batchEnabled ? "batch" : "single"}:${environmentEnabled ? "environment" : "local"}:${effortEnabled ? "effort" : "default"}:${defaultAgent}`;
	const cached = taskSchemaCache.get(key);
	if (cached) return cached;
	const schema = createTaskSchema({ ...options, environmentEnabled, effortEnabled, defaultAgent });
	taskSchemaCache.set(key, schema);
	return schema;
}

/**
 * Runtime params union over both wire shapes. The model sees exactly one shape
 * (`{ context, tasks[] }` when `task.batch` is on, `{ name?, agent?, task }`
 * otherwise); runtime stays permissive so internal callers and stale
 * transcripts using the flat form keep working under either setting.
 */
export interface TaskParams {
	/** Stable agent name (flat form). */
	name?: string;
	/** Agent type to spawn (flat form); omitted values resolve from the session spawn policy. */
	agent?: string;
	/** The work (flat form). */
	task?: string;
	/** Per-spawn thinking effort (flat form): lowest/middle/highest level the resolved model supports. */
	effort?: TaskEffort;
	/** Caller-provided output schema; its presence overrides the selected agent's schema. */
	outputSchema?: unknown;
	/** Validation behavior for a caller-provided or inherited output schema. */
	schemaMode?: "permissive" | "strict";
	/** Batch form (`task.batch`): one subagent per item. */
	tasks?: TaskItem[];
	/** Batch form: shared background prepended to every assignment; required by the batch schema. */
	context?: string;
	/** Run in an isolated worktree (flat form; per-item in batch form). */
	isolated?: boolean;
	/** Select the execution substrate (flat form only). Defaults to local. */
	execution?: "local" | "environment";
}

/**
 * One-line, length-capped label safe for a single roster line, a registry
 * `displayName`, or a system-prompt field. Collapses every run of whitespace
 * AND control/format characters — including U+0085 NEL, ESC/ANSI, and the
 * zero-width separators that `\s` misses — to a single space, then caps length.
 * So untrusted text (a generated task label, a peer activity gist) can neither
 * break the line, inject prompt structure, nor smuggle terminal escapes. Caps at
 * `max` characters (clamped to >= 1; default `LABEL_MAX`), appending an ellipsis when truncated.
 */
export function oneLineLabel(text: string, max = LABEL_MAX): string {
	const oneLine = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
	const cap = Math.max(1, max);
	// Count/cut by code point, not UTF-16 code unit, so truncation can never
	// split an astral character into a lone surrogate.
	const chars = [...oneLine];
	return chars.length > cap ? `${chars.slice(0, cap - 1).join("")}…` : oneLine;
}

/**
 * Whether an agent at `taskDepth` may still spawn children — i.e. it currently
 * holds the `task` tool. Mirrors the task-tool availability gate;
 * `maxRecursionDepth < 0` disables the cap entirely.
 */
export function canSpawnAtDepth(maxRecursionDepth: number, taskDepth: number): boolean {
	return maxRecursionDepth < 0 || taskDepth < maxRecursionDepth;
}

/** A code review finding reported by the reviewer agent */
export interface ReviewFinding {
	title: string;
	body: string;
	priority: number;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

/** Review summary submitted by the reviewer agent */
export interface ReviewSummary {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}

/** Structured review data extracted from reviewer agent */
export interface ReviewData {
	findings: ReviewFinding[];
	summary?: ReviewSummary;
}

/** Agent definition (bundled or discovered) */
export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: ConfiguredThinkingLevel;
	output?: unknown;
	blocking?: boolean;
	autoloadSkills?: string[];
	/** When `false`, the agent's `read` tool returns verbatim file content instead of structural summaries. */
	readSummarize?: boolean;
	/** Prewalk hand-off for the spawned session: `true` = switch to the default prewalk target at the first edit/write, string = custom target model pattern. */
	prewalk?: boolean | string;
	source: AgentSource;
	filePath?: string;
}

/** Details extracted from a subagent `yield` tool call for final-result assembly and task rendering. */
export interface YieldItem {
	data?: unknown;
	status?: "success" | "aborted";
	error?: string;
	/** A string label is terminal; a non-empty array of labels is incremental. */
	type?: string | string[];
	/** Resolve this yield's payload from the latest durable assistant text instead of `data`. */
	useLastTurn?: boolean;
	/**
	 * Set by the in-tool yield validator when it exhausted its retry budget and
	 * accepted schema-invalid data anyway. The executor preserves that override
	 * during post-mortem validation.
	 */
	schemaOverridden?: boolean;
}

/** Progress tracking for a single agent */
export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	/** Count of assistant requests (assistant message_end events) across the run. Drives the soft request budget guard. */
	requests: number;
	/** Cumulative input + output + cacheWrite tokens across all turns. Excludes cacheRead (re-reads cached context every turn, making cumulative sum misleading). */
	tokens: number;
	/**
	 * Current per-turn context size: latest assistant message's `usage.totalTokens`.
	 * This is the number to compare against `contextWindow` — what compaction
	 * decides on, what the user typically reads as "how full is the context".
	 * Distinct from `tokens`, which is a lifetime billing-volume counter.
	 */
	contextTokens?: number;
	/** Model's context window in tokens, when known. Lets the UI render `<curr>/<window>` gauges. */
	contextWindow?: number;
	/** Cumulative billing cost in USD, accumulated incrementally from message_end events. */
	cost: number;
	durationMs: number;
	modelOverride?: string | string[];
	/** Resolved model display string in the form `<provider>/<id>`, optionally suffixed with `:<thinkingLevel>` when the level was set explicitly. Undefined when the model could not be resolved. */
	resolvedModel?: string;
	/** True when {@link resolvedModel} is the target of an active retry fallback (not the originally configured model). Lets observer-only UIs (collab guests, Agent Hub rows with no live session) flag the fallback and keep the provider. */
	resolvedModelIsFallback?: boolean;
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
	/**
	 * Auto-retry state when the subagent is sleeping between provider retries
	 * (e.g. 429 rate-limit with retry-after). Cleared when the retry resolves
	 * or fails. Surfacing this to the parent prevents the task tool from
	 * looking indefinitely "in progress" when a child is actually blocked on
	 * provider quota.
	 */
	retryState?: {
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		errorMessage: string;
		startedAtMs: number;
	};
	/**
	 * Terminal retry failure surfaced once the subagent gave up retrying
	 * (e.g. retry-after exceeded the cap, or all attempts exhausted). Carries
	 * the final error so the parent UI can render "blocked: rate-limited"
	 * instead of waiting for a status that never arrives.
	 */
	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};
	/**
	 * Snapshot of the most recent `task` tool call's in-flight `TaskToolDetails`,
	 * captured from `tool_execution_update`. Lets the parent UI surface live
	 * nested-subagent progress while this agent is still inside its own `task`
	 * call. Cleared when the call ends — finalized data lives in
	 * `extractedToolData.task` after that.
	 */
	inflightTaskDetails?: TaskToolDetails;
}

/** Result from a single agent execution */
export interface SingleResult {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	exitCode: number;
	output: string;
	stderr: string;
	truncated: boolean;
	/**
	 * Parsed structured completion and validation metadata, when this invocation
	 * selected an output schema or strict schema mode.
	 */
	structuredOutput?: StructuredSubagentOutput;
	durationMs: number;
	/** Cumulative input + output + cacheWrite tokens across all turns. Excludes cacheRead (re-reads cached context every turn, making cumulative sum misleading). */
	tokens: number;
	/** Count of assistant requests (assistant message_end events) across the run. */
	requests: number;
	/** Latest per-turn context size at task completion. See `AgentProgress.contextTokens`. */
	contextTokens?: number;
	/** Model's context window in tokens, when known. */
	contextWindow?: number;
	modelOverride?: string | string[];
	/** Resolved model display string in the form `<provider>/<id>`, optionally suffixed with `:<thinkingLevel>` when the level was set explicitly. Omitted from tool-result JSON when undefined to keep wire payloads small. */
	resolvedModel?: string;
	/** True when {@link resolvedModel} is the target of an active retry fallback. Mirrors {@link AgentProgress.resolvedModelIsFallback} onto the settled result. */
	resolvedModelIsFallback?: boolean;
	error?: string;
	aborted?: boolean;
	abortReason?: string;
	/** Aggregated usage from the subprocess, accumulated incrementally from message_end events. */
	usage?: Usage;
	/** Output path for the task result */
	outputPath?: string;
	/** Patch path for isolated worktree output */
	patchPath?: string;
	/** Branch name for isolated branch-mode output */
	branchName?: string;
	/**
	 * Baseline commit SHA the task branch was created from. Passed to
	 * `mergeTaskBranches` so cherry-pick uses the inclusive range
	 * `branchBaseSha..branchName` and preserves every agent commit's message.
	 */
	branchBaseSha?: string;
	/** Nested repo patches to apply after parent merge */
	nestedPatches?: NestedRepoPatch[];
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
	/**
	 * Terminal retry failure, when the subagent exited because the auto-retry
	 * loop gave up (retry-after exceeded the cap, or all attempts exhausted).
	 * Lets the parent task tool surface a "blocked: rate-limited" outcome
	 * instead of a generic failure.
	 */
	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};
	/** Output metadata for agent:// URL integration */
	outputMeta?: { lineCount: number; charCount: number };
}

/** Tool details for TUI rendering */
export interface TaskToolDetails {
	projectAgentsDir: string | null;
	results: SingleResult[];
	totalDurationMs: number;
	/** Aggregated usage across all subagents. */
	usage?: Usage;
	outputPaths?: string[];
	progress?: AgentProgress[];
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "task";
	};
}
