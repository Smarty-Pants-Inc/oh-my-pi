/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with omp-coding-agent)
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent spawn per call (parallelism = parallel task calls)
 *   - Batch spawning + shared context per call when `task.batch` is enabled
 *   - Background execution through AsyncJobManager when `async.enabled` is enabled
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { $env, logger, prompt } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "..";
import type { Theme } from "../modes/theme/theme";
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskAsyncContractTemplate from "../prompts/tools/task-async-contract.md" with { type: "text" };
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import type { AgentSessionTransientTaskRuntimeAuthorityV1 } from "../session/agent-session-types";
import {
	type AgentSessionTransientTaskSourceObservationProducerV1,
	type ConfidentialAgentSessionToolResultSerializerKeyV1,
	type ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1,
	type ConfidentialTransientTaskExecuteEntryObservationReceiptV1,
	type ConfidentialTransientTaskForegroundBeforeReturnRecordV1,
	type ConfidentialTransientTaskForegroundBeforeReturnSuspensionV1,
	type ConfidentialTransientTaskForegroundPendingTtsrOverlayBindingV1,
	type ConfidentialTransientTaskForegroundPendingTtsrOverlayPreDispatchBindingV1,
	type ConfidentialTransientTaskForegroundPendingTtsrOverlaySnapshotV1,
	type ConfidentialTransientTaskForegroundResultHandoffBatchV1,
	type ConfidentialTransientTaskForegroundResultHandoffV1,
	type ConfidentialTransientTaskPendingCaptureIndexKeyV1,
	type ConfidentialTransientTaskSourceObservationReceiptV1,
	type ConfidentialTransientTaskSourceObservationResultV1,
	type ConfidentialTransientTaskTaskToolSourceObservationInputV1,
	deriveTransientTaskEffectOperationIdV1,
	deriveTransientTaskForegroundAppendBatchKeyV1,
	type SessionManagerJournalGenerationAuthorityResolverV1,
	TRANSIENT_TASK_DETACHED_PRE_EXECUTION_ABORT_JOB_ERROR_TEXT_V1,
	type TransientTaskForegroundBeforeReturnRecoveryBridgeV1,
	type TransientTaskForegroundDispatchClassificationV1,
	type TransientTaskForegroundPendingTtsrOverlayBindingResolverV1,
	type TransientTaskForegroundPreReturnIdentityEnvelopeListV1,
	type TransientTaskForegroundPreReturnIdentityV1,
	type TransientTaskForegroundResultSettlementStoreV1,
	type TransientTaskForegroundSessionAppendBridgeV1,
	type TransientTaskPostTerminalCleanupEvidenceV1,
	type TransientTaskResultlessTerminalProjectionV1,
} from "../session/workspace-runtime-contracts";
import { TASK_EFFORTS, type TaskEffort } from "../thinking";
import { truncateForPrompt } from "../tools/approval";
import { isIrcEnabled } from "../tools/hub";
import { formatBytes, formatDuration } from "../tools/render-utils";
import { isScoutSpawnable, resolveSpawnPolicy } from "./spawn-policy";
import {
	type AgentDefinition,
	type AgentProgress,
	canSpawnAtDepth,
	getTaskSchema,
	type SingleResult,
	StructuredSubagentError,
	type TaskItem,
	type TaskParams,
	type TaskToolDetails,
	type TaskToolSchemaInstance,
	validateAndProjectTransientTaskForegroundSourceAgentToolResultV1,
} from "./types";
// Import review tools for side effects (registers subagent tool handlers)
import "../tools/review";
import type { AsyncJobManager, AsyncJobTransientTaskRunContextV1 } from "../async";
import { hasResolvableTranscript } from "../internal-urls/registry-helpers";
import { AgentRegistry } from "../registry/agent-registry";
import type { OperationId, Sha256Ref } from "../registry/persistent-agent-contracts";
import { type DiscoveryResult, discoverAgents } from "./discovery";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimitAllSettled, Semaphore } from "./parallel";
import { renderResult, renderCall as renderTaskCall } from "./render";
import { repairTaskParams } from "./repair-args";
import {
	createStructuredSubagentTransientTaskRuntimeV1,
	type EffectiveSubagentPolicy,
	reserveStructuredSubagentId,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	type StructuredSubagentForegroundHandoffIdentityV1,
	StructuredSubagentLifecycleFailure,
	type StructuredSubagentRequest,
	type StructuredSubagentTransientTaskRuntimeAssemblyV1,
} from "./structured-subagent";

type TaskForegroundRuntimeAuthorityV1 = {
	readonly sourceObservationProducer: AgentSessionTransientTaskSourceObservationProducerV1;
	readonly pendingOverlayBindingResolver: TransientTaskForegroundPendingTtsrOverlayBindingResolverV1;
	readonly takePreDispatchBinding: (toolCallId: string) => {
		readonly indexKey: ConfidentialTransientTaskPendingCaptureIndexKeyV1;
		readonly snapshot: ConfidentialTransientTaskForegroundPendingTtsrOverlaySnapshotV1;
		readonly binding: ConfidentialTransientTaskForegroundPendingTtsrOverlayPreDispatchBindingV1;
		readonly sourceToolCallOrdinal: number;
		readonly assistantAnchorEntryId: string;
		readonly serializerKey: ConfidentialAgentSessionToolResultSerializerKeyV1;
	} | null;
	readonly beforeReturnRecovery: TransientTaskForegroundBeforeReturnRecoveryBridgeV1;
	readonly sessionAppend: TransientTaskForegroundSessionAppendBridgeV1;
	readonly settlement: TransientTaskForegroundResultSettlementStoreV1;
	readonly resolveJournalGenerationAuthority: SessionManagerJournalGenerationAuthorityResolverV1["resolveTransientTaskJournalGenerationAuthority"];
};

type TaskRuntimeAuthorityWithForegroundV1 = AgentSessionTransientTaskRuntimeAuthorityV1 & {
	readonly foregroundTask?: TaskForegroundRuntimeAuthorityV1;
};

interface TaskForegroundInvocationV1 {
	readonly authority: TaskForegroundRuntimeAuthorityV1;
	readonly runtimeAuthority: AgentSessionTransientTaskRuntimeAuthorityV1;
	readonly indexKey: ConfidentialTransientTaskPendingCaptureIndexKeyV1;
	readonly snapshot: ConfidentialTransientTaskForegroundPendingTtsrOverlaySnapshotV1;
	readonly preDispatchBinding: ConfidentialTransientTaskForegroundPendingTtsrOverlayPreDispatchBindingV1;
	readonly sourceToolCallOrdinal: number;
	readonly assistantAnchorEntryId: string;
	readonly serializerKey: ConfidentialAgentSessionToolResultSerializerKeyV1;
	readonly effectiveTaskArgumentsSha256: Sha256Ref;
	readonly effectiveArgumentRevisionChainSha256: Sha256Ref;
	readonly executeEntryObservationReceipt: ConfidentialTransientTaskExecuteEntryObservationReceiptV1;
}

interface TaskForegroundCompletedChildV1 {
	readonly spawnIndex: number;
	readonly handoffIdentity: StructuredSubagentForegroundHandoffIdentityV1;
}
type TaskForegroundPresentDispatchClassificationV1 = Extract<
	TransientTaskForegroundDispatchClassificationV1,
	{ core: { classification: "foreground_present" } }
>;

function isTaskExecuteEntryObservationReceipt(
	receipt: ConfidentialTransientTaskSourceObservationReceiptV1,
): receipt is ConfidentialTransientTaskExecuteEntryObservationReceiptV1 {
	return receipt.core.eventKind === "task_execute_entry";
}

function isTaskForegroundPresentDispatchClassification(
	classification: TransientTaskForegroundDispatchClassificationV1,
): classification is TaskForegroundPresentDispatchClassificationV1 {
	return classification.core.classification === "foreground_present";
}

const transientTaskForegroundStringify = JSON.stringify.bind(JSON);

function transientTaskForegroundTupleSha256(tuple: readonly unknown[]): Sha256Ref {
	const utf8 = transientTaskForegroundStringify(tuple);
	if (utf8 === undefined) throw new TypeError("Foreground canonical tuple is not JSON-representable");
	return `sha256:${createHash("sha256").update(utf8, "utf8").digest("hex")}` as Sha256Ref;
}

function transientTaskForegroundOperationId(): OperationId {
	return randomUUID() as OperationId;
}

function transientTaskForegroundResultTargetTuple(
	key: StructuredSubagentForegroundHandoffIdentityV1["resultTargetKey"],
): readonly unknown[] {
	return [
		key.taskId,
		key.runId,
		key.createId,
		key.resultPublicationId,
		key.resultPublicationTargetId,
		key.resultPublicationTargetCleanupId,
	];
}

function transientTaskForegroundPendingForever(): Promise<never> {
	return new Promise<never>(() => {});
}

function renderSubagentUserPrompt(assignment: string): string {
	return prompt.render(subagentUserPromptTemplate, {
		assignment: assignment.trim(),
	});
}

function resolveTransientTaskRuntimeAuthorityAcquirer(
	session: ToolSession,
): (() => Promise<AgentSessionTransientTaskRuntimeAuthorityV1>) | null {
	if (!("acquireTransientTaskRuntimeAuthority" in session)) return null;
	const acquire = session.acquireTransientTaskRuntimeAuthority;
	if (typeof acquire !== "function") return null;
	return () => (acquire as (this: ToolSession) => Promise<AgentSessionTransientTaskRuntimeAuthorityV1>).call(session);
}

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export type {
	AgentDefinition,
	AgentProgress,
	SingleResult,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	TaskParams,
	TaskToolDetails,
} from "./types";
export {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	taskSchema,
} from "./types";

// Built-in tools whose approval tier is "read" (see tool classes' `approval`).
// An agent is read-only iff its declared tools are a non-empty subset of this set.
// Fail-safe: any unknown tool makes the agent not read-only.
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"glob",
	"web_search",
	"ast_grep",
	"yield",
	"hub",
	"ask",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"inspect_image",
	"checkpoint",
	"rewind",
]);

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return !!agent.tools?.length && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}

/**
 * Preview text for a child result. Falls back to "(no output)" — annotated
 * with the request count when the child actually did work, so the parent can
 * tell a no-op child from one that burned requests before being cancelled.
 */
export function formatResultOutputFallback(result: Pick<SingleResult, "output" | "stderr" | "requests">): string {
	const base = result.output.trim() || result.stderr.trim();
	if (base) return base;
	return result.requests > 0 ? `(no output) after ${result.requests} req` : "(no output)";
}

interface TaskDescriptionOptions {
	agents: AgentDefinition[];
	isolationEnabled: boolean;
	applyIsolatedChanges: boolean;
	disabledAgents: string[];
	batchEnabled: boolean;
	effortEnabled: boolean;
	asyncEnabled: boolean;
	ircEnabled: boolean;
	parentSpawns: string;
}

/** Render the tool description from a cached agent list and current settings. */
function renderDescription(options: TaskDescriptionOptions): string {
	const spawnPolicy = resolveSpawnPolicy(options.parentSpawns);
	const spawningDisabled = !spawnPolicy.enabled;
	let filteredAgents =
		options.disabledAgents.length > 0
			? options.agents.filter(agent => !options.disabledAgents.includes(agent.name))
			: options.agents;
	if (spawningDisabled) {
		filteredAgents = [];
	} else if (spawnPolicy.allowedAgents !== null) {
		const allowed = new Set(spawnPolicy.allowedAgents);
		filteredAgents = filteredAgents.filter(agent => allowed.has(agent.name));
	}
	const renderedAgents = filteredAgents.map(agent => ({
		name: agent.name,
		description: agent.description,
		readOnly: isReadOnlyAgent(agent),
		blocking: agent.blocking === true,
	}));
	const scoutAvailable = isScoutSpawnable(options.disabledAgents, options.parentSpawns);
	return prompt.render(taskDescriptionTemplate, {
		agents: renderedAgents,
		scoutAvailable,
		spawningDisabled,
		defaultAgent: spawnPolicy.defaultAgent,
		isolationEnabled: options.isolationEnabled,
		applyIsolatedChanges: options.applyIsolatedChanges,
		batchEnabled: options.batchEnabled,
		effortEnabled: options.effortEnabled,
		asyncEnabled: options.asyncEnabled,
		hasBlockingAgents: renderedAgents.some(agent => agent.blocking),
		ircEnabled: options.ircEnabled,
	});
}

function createTaskModeError(text: string): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

/**
 * Reject legacy fields and shape/configuration combinations the current tool
 * cannot accept. `outputSchema` is a first-class per-spawn field; stale
 * `schema` remains an eval-only alias and is rejected.
 */
function validateShapeParams(batchEnabled: boolean, params: TaskParams): string | undefined {
	if (params.tasks !== undefined) {
		if (Object.hasOwn(params, "execution")) {
			return "`execution` is only available on the flat single-task input, not a batch call.";
		}
		for (let index = 0; index < (Array.isArray(params.tasks) ? params.tasks.length : 0); index++) {
			const item = params.tasks[index];
			if (item && Object.hasOwn(item, "execution")) {
				return `Task ${index + 1} cannot set \`execution\`; environment selection is only available on a flat single-task input.`;
			}
		}
	}
	if (Object.hasOwn(params, "schema")) {
		return "The task tool uses `outputSchema`; rename the stale `schema` field.";
	}
	if (!batchEnabled) {
		const disallowed = (["tasks", "context"] as const).filter(field => params[field] !== undefined);
		if (disallowed.length > 0) {
			return `task.batch is disabled, so the task tool does not accept ${disallowed.map(f => `\`${f}\``).join(" or ")}. Spawn one agent per call with \`task\`, or enable the task.batch setting.`;
		}
	}
	return undefined;
}

/**
 * Validate the spawn parameter contract against the wire shapes. With
 * `task.batch` the model-facing shape is `{ context, tasks[] }` — `tasks`
 * non-empty with per-item `task` instructions and unique names, `context`
 * non-empty, no top-level `task` alongside. The flat `{ agent?, ...item }`
 * form stays accepted at runtime under either setting (internal callers, stale
 * transcripts). Missing `agent` values resolve against the session spawn
 * policy later, in `spawnParamsFor`. Returns a problem description, or
 * undefined when valid.
 */

/** Reject an out-of-range `effort` selector on internal/stale-transcript calls that bypass the wire schema. */
function validateEffort(effort: TaskEffort | undefined, label: string): string | undefined {
	if (effort === undefined || TASK_EFFORTS.includes(effort)) return undefined;
	return `${label} has an invalid \`effort\` value ${JSON.stringify(effort)}. Use "lo", "med", or "hi".`;
}

function validateSpawnParams(params: TaskParams, batchEnabled: boolean): string | undefined {
	const hasTask = typeof params.task === "string" && params.task.trim() !== "";
	const tasks = params.tasks;
	if (batchEnabled && tasks !== undefined) {
		if (!Array.isArray(tasks) || tasks.length === 0) {
			return "Missing `tasks`. Provide at least one task item ({ name?, agent?, task }).";
		}
		if (hasTask) {
			return "Top-level `task` is not part of the batch shape. Put the work in `tasks[]` items.";
		}
		for (let i = 0; i < tasks.length; i++) {
			const item = tasks[i];
			if (!item || typeof item.task !== "string" || item.task.trim() === "") {
				return `Task ${i + 1}${item?.name ? ` (\`${item.name}\`)` : ""} is missing \`task\`. Every task needs complete, self-contained instructions.`;
			}
			const effortError = validateEffort(item.effort, `Task ${i + 1}${item.name ? ` (\`${item.name}\`)` : ""}`);
			if (effortError) return effortError;
		}
		const seen = new Map<string, string>();
		for (const item of tasks) {
			const name = item.name?.trim();
			if (!name) continue;
			const key = name.toLowerCase();
			const existing = seen.get(key);
			if (existing !== undefined) {
				return `Duplicate task name ${existing === name ? `\`${name}\`` : `\`${existing}\` / \`${name}\``}. Provided names must be unique within a call (case-insensitive).`;
			}
			seen.set(key, name);
		}
		if (typeof params.context !== "string" || params.context.trim() === "") {
			return "Missing `context`. Provide the shared background for this batch — goal, constraints, and any contract the tasks share.";
		}
		return undefined;
	}
	if (!hasTask) {
		return batchEnabled
			? "Missing `tasks`. Provide a `tasks` array (one subagent per item) with a shared `context`."
			: "Missing `task`. Provide complete, self-contained instructions for the agent.";
	}
	const effortError = validateEffort(params.effort, "The call");
	if (effortError) return effortError;
	if (params.execution === undefined || params.execution === "local" || params.execution === "environment") {
		return undefined;
	}
	return `The call has an invalid \`execution\` value ${JSON.stringify(params.execution)}. Use "local" or "environment".`;
}

/**
 * Normalize a validated call into its spawn list: the `tasks[]` batch when
 * provided, otherwise the single top-level spawn. The flat form's `isolated`
 * flag is only materialized when the caller sent one — `#runSpawn`
 * distinguishes an absent key from an explicit value.
 */
function resolveSpawnItems(params: TaskParams): TaskItem[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks;
	}
	const item: TaskItem = { name: params.name, agent: params.agent, task: params.task };
	if ("outputSchema" in params) item.outputSchema = params.outputSchema;
	if ("schemaMode" in params) item.schemaMode = params.schemaMode;
	if ("effort" in params) item.effort = params.effort;
	if ("isolated" in params) item.isolated = params.isolated;
	return [item];
}

/**
 * Per-spawn params handed to the executor path: top-level call fields with the
 * item's identity substituted in. Each spawn's `agent` resolves here —
 * the item's own value, else `defaultAgent` from the session spawn policy.
 * `tasks` never leaks into a spawn; the shared `context` rides along
 * unchanged. Keys are only materialized when present — `#runSpawn`
 * distinguishes an absent `isolated` from an explicit one. The item's
 * `isolated` (batch form) wins over the top-level flag (flat form).
 */
function spawnParamsFor(params: TaskParams, item: TaskItem, defaultAgent: string): TaskParams {
	const spawn: TaskParams = { agent: item.agent?.trim() || defaultAgent };
	if (item.name !== undefined) spawn.name = item.name;
	if (item.task !== undefined) spawn.task = item.task;
	if (params.context !== undefined) spawn.context = params.context;
	if ("outputSchema" in item) spawn.outputSchema = item.outputSchema;
	if ("schemaMode" in item) spawn.schemaMode = item.schemaMode;
	if ("effort" in item) spawn.effort = item.effort;
	if (item.isolated !== undefined) {
		spawn.isolated = item.isolated;
	} else if ("isolated" in params) {
		spawn.isolated = params.isolated;
	}
	if (params.tasks === undefined && Object.hasOwn(params, "execution")) spawn.execution = params.execution;
	return spawn;
}

/** One sync-executed spawn: its item, position in the original call, and (for mixed calls) a pre-claimed agent id. */
interface SyncSpawnRef {
	item: TaskItem;
	index: number;
	preAllocatedId?: string;
}

/** Merged view of a sync spawn set's payloads: joined text plus flattened results/usage/paths. */
interface MergedSyncPayloads {
	contentParts: string[];
	results: SingleResult[];
	usage?: Usage;
	outputPaths?: string[];
	projectAgentsDir: string | null;
}

/**
 * Merge per-spawn sync payloads into one result view. `index` is each spawn's
 * position in the original call so batch rows keep stable ordering; a missing
 * payload (cancelled before start) becomes an explanatory content line.
 */
function mergeSyncPayloads(
	spawns: SyncSpawnRef[],
	payloads: (AgentToolResult<TaskToolDetails> | undefined)[],
): MergedSyncPayloads {
	const results: SingleResult[] = [];
	const contentParts: string[] = [];
	const outputPaths: string[] = [];
	const usageTotals = createUsageTotals();
	let hasUsage = false;
	let projectAgentsDir: string | null = null;
	for (let position = 0; position < spawns.length; position++) {
		const payload = payloads[position];
		const { item, index } = spawns[position];
		if (!payload) {
			contentParts.push(`Task ${item.name?.trim() || `#${index + 1}`}: cancelled before start.`);
			continue;
		}
		projectAgentsDir ??= payload.details?.projectAgentsDir ?? null;
		const text = payload.content.find(part => part.type === "text")?.text;
		if (text) contentParts.push(text);
		for (const result of payload.details?.results ?? []) {
			results.push({ ...result, index });
			if (result.usage) {
				addUsageTotals(usageTotals, result.usage);
				hasUsage = true;
			}
			if (result.outputPath) outputPaths.push(result.outputPath);
		}
	}
	return {
		contentParts,
		results,
		usage: hasUsage ? usageTotals : undefined,
		outputPaths: outputPaths.length > 0 ? outputPaths : undefined,
		projectAgentsDir,
	};
}

/** Generic worker agent types; several in one call usually means a more specific type exists. */
const GENERIC_SPAWN_AGENTS: ReadonlySet<string> = new Set(["task", "sonic"]);

/**
 * Advisory — never a rejection — nudging the spawner toward tailored
 * specific agent types when one call resolves ≥2 items to a generic
 * `task`/`sonic` worker and the spawner still holds spawn capacity
 * (DepthCapacity: it currently has the `task` tool). `agentNames` are the
 * per-item resolved agent types. Returns undefined when no nudge applies.
 */
export function buildSpecializationAdvisory(
	agentNames: string[],
	depthCapacity: boolean,
	scoutAvailable = true,
): string | undefined {
	if (!depthCapacity) return undefined;
	const generics = agentNames.filter(name => GENERIC_SPAWN_AGENTS.has(name));
	if (generics.length < 2) return undefined;
	const specialist = scoutAvailable
		? `Check the agent list for a closer specialist type — e.g. read-only research belongs on ` +
			`\`agent: "scout"\`, which runs on a faster model.`
		: `Check the agent list for a closer specialist type.`;
	return `Tip: this call spawned ${generics.length} generic \`${generics[0]}\` workers. ${specialist}`;
}

/**
 * Suggestion — never a rejection — nudging the spawner to coordinate via the
 * hub when one call creates ≥2 live siblings and it still holds spawn
 * capacity. Returns undefined when there is nothing to coordinate or peer
 * messaging is unavailable.
 */
export function buildCoordinationAdvisory(
	items: TaskItem[],
	depthCapacity: boolean,
	ircEnabled: boolean,
): string | undefined {
	if (!depthCapacity || !ircEnabled || items.length < 2) return undefined;
	return (
		`Coordinate: ${items.length} siblings are running together. If their work overlaps, have them ` +
		`message each other via \`hub\` (by id, or "all" to broadcast) before editing shared files — ` +
		`live coordination beats a serial handoff. Check \`hub\` op:"list" to see who is doing what.`
	);
}

/**
 * Compose the non-blocking advisory appended to a `task` result: the
 * specialization nudge (from the per-item resolved agent types), plus — only
 * when some spawns keep running after this call (`willRunAsync`) — the
 * coordination suggestion over those still-live spawns (`items`). Coordination
 * is gated on async because a sync spawn has already finished by the time the
 * call returns, so a "coordinate while they run" hint would misfire. Returns
 * undefined when neither applies.
 */
export function composeSpawnAdvisory(args: {
	agents: string[];
	items: TaskItem[];
	depthCapacity: boolean;
	ircEnabled: boolean;
	willRunAsync: boolean;
	scoutAvailable?: boolean;
}): string | undefined {
	return (
		[
			buildSpecializationAdvisory(args.agents, args.depthCapacity, args.scoutAvailable),
			args.willRunAsync ? buildCoordinationAdvisory(args.items, args.depthCapacity, args.ircEnabled) : undefined,
		]
			.filter(Boolean)
			.join("\n\n") || undefined
	);
}

/** Sentinel for async jobs whose subagent finished with a failing result; progress is already updated. */
class TaskJobError extends Error {}

/**
 * Process-level memo for create-time agent discovery, keyed by resolved cwd.
 *
 * `TaskTool.create` runs for every (sub)agent session in this process and the
 * walk-up + plugin-registry scan in `discoverAgents` is identical for a given
 * cwd, so repeat creations reuse the first scan. Execution-time discovery
 * (`#runSpawn`) intentionally stays fresh. The memo also tracks the live
 * `discoverAgents` binding: test spies swap that binding, which invalidates
 * the memo automatically.
 */
const discoveryMemo = new Map<string, Promise<DiscoveryResult>>();
let discoveryMemoFn: typeof discoverAgents | undefined;

function discoverAgentsForCreate(cwd: string): Promise<DiscoveryResult> {
	const fn = discoverAgents;
	if (discoveryMemoFn !== fn) {
		discoveryMemoFn = fn;
		discoveryMemo.clear();
	}
	const key = path.resolve(cwd);
	let pending = discoveryMemo.get(key);
	if (!pending) {
		pending = fn(cwd);
		discoveryMemo.set(key, pending);
		pending.catch(() => {
			if (discoveryMemo.get(key) === pending) discoveryMemo.delete(key);
		});
	}
	return pending;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Each call spawns one subagent — or, with `task.batch`, one per `tasks[]`
 * item. When `async.enabled` is on, spawns run as AsyncJobManager jobs; when
 * disabled, the tool blocks until every spawn finishes.
 */
export class TaskTool implements AgentTool<TaskToolSchemaInstance, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<TaskParams>;
		const lines: string[] = [];
		if (typeof params.agent === "string") {
			lines.push(`Agent: ${truncateForPrompt(params.agent)}`);
		}
		if (typeof params.name === "string" && params.name.trim()) {
			lines.push(`Name: ${truncateForPrompt(params.name)}`);
		}
		if (typeof params.task === "string") {
			lines.push(`Task:\n${truncateForPrompt(params.task)}`);
		}
		if (typeof params.context === "string" && params.context.trim()) {
			lines.push(`Context:\n${truncateForPrompt(params.context)}`);
		}
		const tasks: unknown[] = Array.isArray(params.tasks) ? params.tasks : [];
		if (tasks.length > 0) {
			const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
			const effectiveAgent = (item: unknown): string => {
				if (item && typeof item === "object" && "agent" in item) {
					const agent = item.agent;
					if (typeof agent === "string" && agent.trim()) return agent.trim();
				}
				return defaultAgent;
			};
			const agentCounts = new Map<string, number>();
			for (const item of tasks) {
				const agent = effectiveAgent(item);
				agentCounts.set(agent, (agentCounts.get(agent) ?? 0) + 1);
			}
			const agentSummary = [...agentCounts].map(([agent, count]) => `${agent} ×${count}`).join(", ");
			lines.push(`Batch agents: ${truncateForPrompt(agentSummary)}`);

			const firstTask = tasks[0];
			if (firstTask && typeof firstTask === "object") {
				if ("name" in firstTask && typeof firstTask.name === "string" && firstTask.name.trim()) {
					lines.push(`Name: ${truncateForPrompt(firstTask.name)}`);
				}
				lines.push(`Agent: ${truncateForPrompt(effectiveAgent(firstTask))}`);
				if ("task" in firstTask && typeof firstTask.task === "string") {
					lines.push(`Task:\n${truncateForPrompt(firstTask.task)}`);
				}
			}
			if (tasks.length > 1) {
				lines.push(`+${tasks.length - 1} more task${tasks.length === 2 ? "" : "s"}`);
			}
		}
		return lines;
	};
	readonly label = "Task";
	readonly summary = "Spawn subagents to complete delegated tasks";
	readonly strict = false;
	readonly loadMode = "essential";
	// Arktype validates model calls against the active wire schema, but the flat
	// single-spawn schema carries `"+": "delete"`: a batch `{ context, tasks[] }`
	// payload has those keys stripped, then fails on the now-missing `task` with
	// the misleading `task must be a string (was missing)`. That preempts the
	// tool's own actionable shape checks (`validateShapeParams` /
	// `validateSpawnParams`), which never run. Lenient validation forwards the
	// raw args to `execute()` on any arktype failure so those checks surface the
	// real reason ("enable task.batch, or use the flat `task` shape"). Valid
	// calls still normalize through arktype; `execute()` resolves `agent`
	// defaults independently, so the success path is unchanged.
	readonly lenientArgValidation = true;
	readonly renderResult = renderResult;
	// Suppress the streaming call preview once a (partial or final) result exists
	// so the task renders as ONE block that transitions in place — not a pending
	// call frame stacked above the result frame. Mirrors `taskToolRenderer`.
	readonly mergeCallAndResult = true;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;
	/**
	 * One semaphore per TaskTool instance (i.e. per session): bounds concurrent
	 * subagents across parallel `task` calls within the session. Resized in
	 * place from `task.maxConcurrency` before every acquire/release so a
	 * mid-session settings change (UI toggle, `/settings`) applies to both new
	 * spawns and work already parked in the semaphore queue.
	 */
	#spawnSemaphore: Semaphore | undefined;

	get parameters(): TaskToolSchemaInstance {
		const planMode = this.session.getPlanModeState?.()?.enabled === true;
		const isolationEnabled = !planMode && this.session.settings.get("task.isolation.mode") !== "none";
		const environmentEnabled =
			isolationEnabled &&
			(this.session.taskDepth ?? 0) === 0 &&
			"supportsTransientTaskEnvironmentExecution" in this.session &&
			typeof this.session.supportsTransientTaskEnvironmentExecution === "function" &&
			this.session.supportsTransientTaskEnvironmentExecution();
		const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
		return getTaskSchema({
			isolationEnabled,
			batchEnabled: this.#isBatchEnabled(),
			effortEnabled: this.session.settings.get("task.enableEffort"),
			defaultAgent,
			environmentEnabled,
		});
	}

	renderCall(args: unknown, options: Parameters<typeof renderTaskCall>[1], theme: Theme) {
		return renderTaskCall(repairTaskParams(args as TaskParams), options, theme);
	}

	/** Dynamic description that reflects current task settings. */
	get description(): string {
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		const planMode = this.session.getPlanModeState?.()?.enabled === true;
		const isolationMode = this.session.settings.get("task.isolation.mode");
		return renderDescription({
			agents: this.#discoveredAgents,
			isolationEnabled: !planMode && isolationMode !== "none",
			applyIsolatedChanges: this.session.settings.get("task.isolation.apply"),
			disabledAgents,
			batchEnabled: this.#isBatchEnabled(),
			effortEnabled: this.session.settings.get("task.enableEffort"),
			asyncEnabled: this.session.settings.get("async.enabled"),
			ircEnabled: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			parentSpawns: this.session.getSessionSpawns() ?? "*",
		});
	}
	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
	) {
		this.#blockedAgent = $env.PI_BLOCKED_AGENT;
		this.#discoveredAgents = discoveredAgents;
	}

	#isBatchEnabled(): boolean {
		return this.session.settings.get("task.batch");
	}

	#getSpawnSemaphore(): Semaphore {
		const max = this.session.settings.get("task.maxConcurrency");
		if (this.#spawnSemaphore) {
			this.#spawnSemaphore.resize(max);
		} else {
			this.#spawnSemaphore = new Semaphore(max);
		}
		return this.#spawnSemaphore;
	}

	#releaseSpawnSemaphore(): void {
		this.#getSpawnSemaphore().release();
	}

	/**
	 * Resolve the shared policy before detached work exists. The resulting
	 * policy intentionally stays local: executor dispatch resolves again from
	 * normalized task params rather than smuggling internal policy over the
	 * task wire contract.
	 */
	#resolveSpawnPreflight(params: TaskParams) {
		return resolveEffectiveSubagentPolicy({
			session: this.session,
			invocationKind: "task",
			assignment: (params.task ?? "").trim(),
			context: this.#isBatchEnabled() ? params.context?.trim() || undefined : undefined,
			agent: params.agent,
			...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
			...(Object.hasOwn(params, "schemaMode") ? { schemaMode: params.schemaMode } : {}),
			...(params.effort !== undefined ? { effort: params.effort } : {}),
			...("isolated" in params ? { isolation: { requested: params.isolated } } : {}),
			...(Object.hasOwn(params, "execution") ? { execution: params.execution } : {}),
			blockedAgent: this.#blockedAgent,
			enableLsp: (this.session.enableLsp ?? true) && this.session.settings.get("task.enableLsp"),
			enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			maxRuntimeMs: this.session.settings.get("task.maxRuntimeMs"),
		});
	}

	async #recordTaskForegroundObservation(
		invocation: Pick<TaskForegroundInvocationV1, "authority" | "indexKey">,
		observationInput: ConfidentialTransientTaskTaskToolSourceObservationInputV1,
	): Promise<ConfidentialTransientTaskSourceObservationReceiptV1> {
		const observedAt = new Date().toISOString();
		const requestedAt = observedAt;
		const reservationId = transientTaskForegroundOperationId();
		const core = {
			indexKey: invocation.indexKey,
			producer: "task_tool" as const,
			observationInput,
			reservationId,
			observedAt,
			requestedAt,
		};
		const result =
			await invocation.authority.sourceObservationProducer.reserveAndFreezeTransientTaskSourceObservationDraft({
				core,
				requestSha256: transientTaskForegroundTupleSha256([
					"omp-agent-session-transient-task-lifecycle-v1",
					"producer-draft-request-core",
					1,
					core.indexKey,
					core.producer,
					core.observationInput,
					core.reservationId,
					core.observedAt,
					core.requestedAt,
				]),
			});
		if (result.status !== "committed" && result.status !== "already_committed") {
			throw new StructuredSubagentError(
				"execution",
				`Task foreground source observation was rejected: ${result.status}`,
			);
		}
		return result.observationReceipt;
	}

	async #beginTaskForegroundInvocation(
		toolCallId: string,
		params: TaskParams,
	): Promise<TaskForegroundInvocationV1 | null> {
		const acquireAuthority = resolveTransientTaskRuntimeAuthorityAcquirer(this.session);
		if (!acquireAuthority) return null;
		const runtimeAuthority = (await acquireAuthority()) as TaskRuntimeAuthorityWithForegroundV1;
		const authority = runtimeAuthority.foregroundTask;
		if (!authority) return null;
		const preDispatch = authority.takePreDispatchBinding(toolCallId);
		if (!preDispatch) return null;
		const generation = authority.resolveJournalGenerationAuthority(preDispatch.assistantAnchorEntryId);
		if (
			generation.status !== "matching" ||
			generation.authority.sessionGeneration.core.sessionId !== preDispatch.indexKey.core.parentSessionId ||
			generation.authority.sessionGeneration.sessionGenerationSha256 !==
				preDispatch.indexKey.core.parentSessionGenerationSha256 ||
			generation.authority.branchGeneration.branchGenerationSha256 !==
				preDispatch.serializerKey.parentBranchGenerationSha256 ||
			preDispatch.serializerKey.parentSessionId !== preDispatch.indexKey.core.parentSessionId ||
			preDispatch.serializerKey.parentSessionGenerationSha256 !==
				preDispatch.indexKey.core.parentSessionGenerationSha256 ||
			preDispatch.serializerKey.assistantAnchorEntryId !== preDispatch.assistantAnchorEntryId ||
			preDispatch.sourceToolCallOrdinal !== preDispatch.indexKey.core.sourceToolCallOrdinal ||
			preDispatch.binding.pendingOverlaySnapshotSha256 !== preDispatch.snapshot.pendingOverlaySnapshotSha256
		) {
			throw new StructuredSubagentError(
				"execution",
				"Task foreground journal authority changed before execute entry.",
			);
		}
		const effectiveTaskArgumentsSha256 = transientTaskForegroundTupleSha256([
			"omp-transient-task-foreground-route-v1",
			"effective-task-arguments",
			1,
			params,
		]);
		const effectiveArgumentRevisionChainSha256 = transientTaskForegroundTupleSha256([
			"omp-transient-task-foreground-route-v1",
			"effective-argument-revision-chain",
			1,
			params,
		]);
		const partial = {
			authority,
			indexKey: preDispatch.indexKey,
		};
		const executeEntryObservationReceipt = await this.#recordTaskForegroundObservation(partial, {
			schemaVersion: 1,
			eventKind: "task_execute_entry",
			effectiveTaskArgumentsSha256,
			effectiveArgumentRevisionChainSha256,
		});
		if (!isTaskExecuteEntryObservationReceipt(executeEntryObservationReceipt)) {
			throw new StructuredSubagentError("execution", "Task execute-entry observation receipt changed event kind.");
		}
		return {
			...partial,
			runtimeAuthority,
			snapshot: preDispatch.snapshot,
			preDispatchBinding: preDispatch.binding,
			sourceToolCallOrdinal: preDispatch.sourceToolCallOrdinal,
			assistantAnchorEntryId: preDispatch.assistantAnchorEntryId,
			serializerKey: preDispatch.serializerKey,
			effectiveTaskArgumentsSha256,
			effectiveArgumentRevisionChainSha256,
			executeEntryObservationReceipt,
		};
	}

	#createTaskForegroundDispatchClassification(
		invocation: TaskForegroundInvocationV1,
		blockingChildCount: number,
		asyncChildCount: number,
	): TransientTaskForegroundDispatchClassificationV1 {
		const classifiedAt = new Date().toISOString();
		const core =
			blockingChildCount > 0
				? {
						schemaVersion: 1 as const,
						classification: "foreground_present" as const,
						blockingChildCount,
						asyncChildCount,
						effectiveTaskArgumentsSha256: invocation.effectiveTaskArgumentsSha256,
						effectiveArgumentRevisionChainSha256: invocation.effectiveArgumentRevisionChainSha256,
						classifiedAt,
					}
				: {
						schemaVersion: 1 as const,
						classification: "async_only" as const,
						blockingChildCount: 0 as const,
						asyncChildCount,
						effectiveTaskArgumentsSha256: invocation.effectiveTaskArgumentsSha256,
						effectiveArgumentRevisionChainSha256: invocation.effectiveArgumentRevisionChainSha256,
						classifiedAt,
					};
		return {
			core,
			classificationSha256: transientTaskForegroundTupleSha256([
				"omp-transient-task-foreground-route-v1",
				"classification-core",
				1,
				core.classification,
				core.blockingChildCount,
				core.asyncChildCount,
				core.effectiveTaskArgumentsSha256,
				core.effectiveArgumentRevisionChainSha256,
				core.classifiedAt,
			]),
		} as TransientTaskForegroundDispatchClassificationV1;
	}

	async #suspendTaskForegroundBeforeReturn(
		invocation: TaskForegroundInvocationV1,
		record: ConfidentialTransientTaskForegroundBeforeReturnRecordV1,
		reason: ConfidentialTransientTaskForegroundBeforeReturnSuspensionV1["reason"],
	): Promise<never> {
		const suspendedAt = new Date().toISOString();
		const projection = {
			schemaVersion: 1 as const,
			state: "before_return_suspended" as const,
			foregroundAppendBatchKeySha256: record.preallocationRequest.foregroundAppendBatchKeySha256,
			beforeReturnRecordSha256: record.recordSha256,
			returnedSourceResultSnapshotSha256: record.returnedSourceResultSnapshot.sourceSnapshotUtf8Sha256,
			reason,
		};
		const suspension: ConfidentialTransientTaskForegroundBeforeReturnSuspensionV1 = {
			schemaVersion: 1,
			record,
			projection,
			reason,
			suspendedAt,
			suspensionSha256: transientTaskForegroundTupleSha256([
				"omp-transient-task-foreground-settlement-v1",
				"before-return-suspension-core",
				1,
				record,
				projection.foregroundAppendBatchKeySha256,
				projection.returnedSourceResultSnapshotSha256,
				reason,
				suspendedAt,
			]),
		};
		await invocation.authority.beforeReturnRecovery.persistBeforeReturnSuspension(suspension).catch(() => undefined);
		return transientTaskForegroundPendingForever();
	}

	async #prepareTaskForegroundHandoff(
		toolCallId: string,
		invocation: TaskForegroundInvocationV1,
		classification: Extract<
			TransientTaskForegroundDispatchClassificationV1,
			{ core: { classification: "foreground_present" } }
		>,
		children: readonly TaskForegroundCompletedChildV1[],
		result: ConfidentialTransientTaskSourceObservationResultV1,
	): Promise<ConfidentialTransientTaskForegroundResultHandoffBatchV1> {
		const parentSessionId = invocation.serializerKey.parentSessionId;
		const parentSessionGenerationSha256 = invocation.serializerKey.parentSessionGenerationSha256;
		const parentBranchGenerationSha256 = invocation.serializerKey.parentBranchGenerationSha256;
		const parentBranchAnchorEntryId = invocation.assistantAnchorEntryId;
		const bindingRequestedAt = new Date().toISOString();
		const bindingRequest = {
			schemaVersion: 1 as const,
			preDispatchBinding: invocation.preDispatchBinding,
			parentSessionId,
			parentSessionGenerationSha256,
			parentBranchGenerationSha256,
			parentBranchAnchorEntryId,
			toolCallId,
			requestedAt: bindingRequestedAt,
			requestSha256: transientTaskForegroundTupleSha256([
				"omp-transient-task-foreground-settlement-v1",
				"pending-ttsr-anchor-resolve-core",
				1,
				invocation.preDispatchBinding,
				parentSessionId,
				parentSessionGenerationSha256,
				parentBranchGenerationSha256,
				parentBranchAnchorEntryId,
				toolCallId,
				bindingRequestedAt,
			]),
		};
		const bindingResult = await invocation.authority.pendingOverlayBindingResolver
			.resolveFinalizedPendingOverlayForBeforeReturn(bindingRequest)
			.catch(() => null);
		if (bindingResult === null) return transientTaskForegroundPendingForever();
		if (bindingResult.status !== "resolved" && bindingResult.status !== "already_resolved") {
			return transientTaskForegroundPendingForever();
		}
		const pendingOverlayBinding: ConfidentialTransientTaskForegroundPendingTtsrOverlayBindingV1 =
			bindingResult.binding;
		if (
			pendingOverlayBinding.parentBranchGenerationSha256 !== parentBranchGenerationSha256 ||
			pendingOverlayBinding.parentBranchAnchorEntryId !== parentBranchAnchorEntryId ||
			pendingOverlayBinding.preDispatchBinding.bindingSha256 !== invocation.preDispatchBinding.bindingSha256
		) {
			return transientTaskForegroundPendingForever();
		}

		const orderedChildren = [...children].sort((left, right) => left.spawnIndex - right.spawnIndex);
		if (orderedChildren.length === 0) return transientTaskForegroundPendingForever();
		for (let index = 1; index < orderedChildren.length; index++) {
			if (orderedChildren[index - 1]!.spawnIndex === orderedChildren[index]!.spawnIndex) {
				return transientTaskForegroundPendingForever();
			}
		}

		const entryPreallocationOperationId = transientTaskForegroundOperationId();
		const entryIdUtf8 = transientTaskForegroundStringify([
			"omp-transient-task-foreground-session-entry-id-v1",
			1,
			entryPreallocationOperationId,
		]);
		if (entryIdUtf8 === undefined) return transientTaskForegroundPendingForever();
		const toolResultEntryId = createHash("sha256").update(entryIdUtf8, "utf8").digest("hex").slice(0, 8);
		const memberCount = orderedChildren.length;
		const orderedPreReturnIdentities = orderedChildren.map((child, foregroundMemberIndex) => {
			const target = child.handoffIdentity.resultTargetKey;
			const manifest = child.handoffIdentity.effectIdentityManifest;
			const deliverySelectorBinding = {
				resultPublicationTargetId: target.resultPublicationTargetId,
				parentSessionId,
				toolCallId,
				foregroundMemberIndex,
			};
			const appendSelectorBinding = { parentSessionId, toolCallId, foregroundMemberIndex };
			const deliverySelectorUtf8 = transientTaskForegroundStringify([
				"omp-transient-task-parent-delivery-selector-v1",
				"foreground-settlement",
				1,
				target.resultPublicationTargetId,
				parentSessionId,
				toolCallId,
				foregroundMemberIndex,
			]);
			const appendSelectorUtf8 = transientTaskForegroundStringify([
				"omp-transient-task-parent-delivery-selector-v1",
				"foreground-session-append",
				1,
				parentSessionId,
				toolCallId,
				foregroundMemberIndex,
			]);
			if (deliverySelectorUtf8 === undefined || appendSelectorUtf8 === undefined) {
				throw new TypeError("Foreground effect selector is not JSON-representable");
			}
			const deliveryOperationId = deriveTransientTaskEffectOperationIdV1({
				namespace: "parent_delivery",
				namespaceId: manifest.parentDeliveryNamespaceId,
				domain: "foreground_settlement",
				selector: { kind: "key", keyUtf8: deliverySelectorUtf8 },
				selectorBinding: deliverySelectorBinding,
			});
			const appendOperationId = deriveTransientTaskEffectOperationIdV1({
				namespace: "parent_delivery",
				namespaceId: manifest.parentDeliveryNamespaceId,
				domain: "foreground_session_append",
				selector: { kind: "key", keyUtf8: appendSelectorUtf8 },
				selectorBinding: appendSelectorBinding,
			});
			const core = {
				...target,
				schemaVersion: 1 as const,
				effectIdentityManifestSha256: manifest.manifestSha256,
				deliveryOperationId,
				appendOperationId,
				foregroundMemberIndex,
				foregroundMemberCount: memberCount,
				parentSessionId,
				parentSessionGenerationSha256,
				parentBranchGenerationSha256,
				parentBranchAnchorEntryId,
				toolCallId,
				toolResultSerializerKeySha256: invocation.serializerKey.serializerKeySha256,
				sourceToolCallOrdinal: invocation.sourceToolCallOrdinal,
				entryPreallocationOperationId,
				toolResultEntryId,
				returnedAgentToolResultUtf8Sha256: result.core.resultUtf8Sha256,
				returnedAgentToolResultUtf8ByteLength: result.core.resultUtf8ByteLength,
				returnedSourceResultSnapshotSha256: result.core.sourceResultSnapshot.sourceSnapshotUtf8Sha256,
				returnedSourceResultSnapshotByteLength: result.core.sourceResultSnapshot.sourceSnapshotUtf8ByteLength,
			};
			return {
				core,
				preReturnIdentitySha256: transientTaskForegroundTupleSha256([
					"omp-transient-task-foreground-settlement-v1",
					"pre-return-identity-core",
					1,
					transientTaskForegroundResultTargetTuple(target),
					core.effectIdentityManifestSha256,
					core.deliveryOperationId,
					core.appendOperationId,
					core.foregroundMemberIndex,
					core.foregroundMemberCount,
					core.parentSessionId,
					core.parentSessionGenerationSha256,
					core.parentBranchGenerationSha256,
					core.parentBranchAnchorEntryId,
					core.toolCallId,
					core.toolResultSerializerKeySha256,
					core.sourceToolCallOrdinal,
					core.entryPreallocationOperationId,
					core.toolResultEntryId,
					core.returnedAgentToolResultUtf8Sha256,
					core.returnedAgentToolResultUtf8ByteLength,
					core.returnedSourceResultSnapshotSha256,
					core.returnedSourceResultSnapshotByteLength,
				]),
			} satisfies TransientTaskForegroundPreReturnIdentityV1;
		}) as unknown as TransientTaskForegroundPreReturnIdentityEnvelopeListV1;
		const orderedPreReturnIdentitySha256s = orderedPreReturnIdentities.map(
			identity => identity.preReturnIdentitySha256,
		) as [Sha256Ref, ...Sha256Ref[]];
		const orderedAppendOperationIds = orderedPreReturnIdentities.map(identity => identity.core.appendOperationId) as [
			OperationId,
			...OperationId[],
		];
		const batchKeyInput = {
			parentSessionId,
			parentSessionGenerationSha256,
			parentBranchGenerationSha256,
			parentBranchAnchorEntryId,
			toolCallId,
			orderedPreReturnIdentitySha256s,
		};
		const foregroundAppendBatchKeySha256 = deriveTransientTaskForegroundAppendBatchKeyV1(batchKeyInput);
		const preallocationRequest = {
			schemaVersion: 1 as const,
			entryPreallocationOperationId,
			expectedToolResultEntryId: toolResultEntryId,
			foregroundAppendBatchKeySha256,
			parentSessionId,
			parentSessionGenerationSha256,
			parentBranchGenerationSha256,
			parentBranchAnchorEntryId,
			toolCallId,
			orderedPreReturnIdentitySha256s,
		};
		const frozenBeforeReturnAt = new Date().toISOString();
		const recordCoreTuple = [
			"omp-transient-task-foreground-settlement-v1",
			"before-return-core",
			1,
			classification,
			invocation.serializerKey.serializerKeySha256,
			invocation.sourceToolCallOrdinal,
			[
				"omp-transient-task-foreground-settlement-v1",
				"batch-key-core",
				1,
				parentSessionId,
				parentSessionGenerationSha256,
				parentBranchGenerationSha256,
				parentBranchAnchorEntryId,
				toolCallId,
				orderedPreReturnIdentitySha256s,
			],
			[
				"omp-transient-task-foreground-settlement-v1",
				"entry-preallocation-core",
				1,
				entryPreallocationOperationId,
				toolResultEntryId,
				foregroundAppendBatchKeySha256,
				parentSessionId,
				parentSessionGenerationSha256,
				parentBranchGenerationSha256,
				parentBranchAnchorEntryId,
				toolCallId,
				orderedPreReturnIdentitySha256s,
			],
			pendingOverlayBinding,
			result.core.sourceResult,
			result.core.sourceResultSnapshot,
			result.core.wireResult,
			result.core.resultUtf8,
			orderedPreReturnIdentities,
			orderedPreReturnIdentitySha256s,
			frozenBeforeReturnAt,
		] as const;
		const record: ConfidentialTransientTaskForegroundBeforeReturnRecordV1 = {
			schemaVersion: 1,
			dispatchClassification: classification,
			toolResultSerializerKeySha256: invocation.serializerKey.serializerKeySha256,
			sourceToolCallOrdinal: invocation.sourceToolCallOrdinal,
			batchKeyInput,
			preallocationRequest,
			pendingOverlayBinding,
			returnedAgentToolResult: result.core.sourceResult,
			returnedSourceResultSnapshot: result.core.sourceResultSnapshot,
			returnedAgentToolResultWire: result.core.wireResult,
			returnedAgentToolResultUtf8: result.core.resultUtf8,
			orderedPreReturnIdentities,
			orderedPreReturnIdentitySha256s,
			frozenBeforeReturnAt,
			recordSha256: transientTaskForegroundTupleSha256(recordCoreTuple),
		};
		const recordPrepare = await invocation.authority.beforeReturnRecovery
			.prepareBeforeReturnRecord(record)
			.catch(() => null);
		if (recordPrepare === null) {
			return this.#suspendTaskForegroundBeforeReturn(invocation, record, "record_prepare_response_lost");
		}
		if (recordPrepare.status !== "prepared" && recordPrepare.status !== "already_prepared") {
			const reason =
				recordPrepare.status === "pending_overlay_missing"
					? "pending_overlay_missing"
					: recordPrepare.status === "pending_overlay_conflict"
						? "pending_overlay_conflict"
						: recordPrepare.status === "session_generation_replaced"
							? "session_generation_replaced"
							: recordPrepare.status === "branch_generation_replaced"
								? "branch_generation_replaced"
								: recordPrepare.status === "branch_anchor_missing"
									? "branch_anchor_missing"
									: recordPrepare.status === "invalid"
										? "invalid"
										: "conflict";
			return this.#suspendTaskForegroundBeforeReturn(invocation, record, reason);
		}
		const preallocation = await invocation.authority.sessionAppend
			.preallocateExactToolResultEntry(preallocationRequest)
			.catch(() => null);
		if (preallocation === null) {
			return this.#suspendTaskForegroundBeforeReturn(invocation, record, "preallocation_response_lost");
		}
		if (preallocation.status !== "preallocated" && preallocation.status !== "already_preallocated") {
			const reason =
				preallocation.status === "session_generation_replaced"
					? "session_generation_replaced"
					: preallocation.status === "branch_generation_replaced"
						? "branch_generation_replaced"
						: preallocation.status === "branch_anchor_missing"
							? "branch_anchor_missing"
							: preallocation.status === "invalid"
								? "invalid"
								: "conflict";
			return this.#suspendTaskForegroundBeforeReturn(invocation, record, reason);
		}
		if (
			preallocation.foregroundAppendBatchKeySha256 !== foregroundAppendBatchKeySha256 ||
			preallocation.toolResultEntryId !== toolResultEntryId
		) {
			return this.#suspendTaskForegroundBeforeReturn(invocation, record, "conflict");
		}
		const preparedBeforeReturnAt = new Date().toISOString();
		const handoffs = orderedPreReturnIdentities.map(preReturnIdentity => {
			const handoff: ConfidentialTransientTaskForegroundResultHandoffV1 = {
				schemaVersion: 1,
				preReturnIdentity,
				pendingOverlayBinding,
				returnedAgentToolResult: result.core.sourceResult,
				returnedSourceResultSnapshot: result.core.sourceResultSnapshot,
				returnedAgentToolResultWire: result.core.wireResult,
				returnedAgentToolResultUtf8: result.core.resultUtf8,
				preparedBeforeReturnAt,
				handoffSha256: transientTaskForegroundTupleSha256([
					"omp-transient-task-foreground-settlement-v1",
					"handoff-core",
					1,
					preReturnIdentity,
					pendingOverlayBinding,
					result.core.sourceResult,
					result.core.sourceResultSnapshot,
					result.core.wireResult,
					result.core.resultUtf8,
					preparedBeforeReturnAt,
				]),
			};
			return handoff;
		}) as [
			ConfidentialTransientTaskForegroundResultHandoffV1,
			...ConfidentialTransientTaskForegroundResultHandoffV1[],
		];
		const batchCore = [
			"omp-transient-task-foreground-settlement-v1",
			"handoff-batch-core",
			1,
			parentSessionId,
			toolCallId,
			invocation.serializerKey.serializerKeySha256,
			invocation.sourceToolCallOrdinal,
			foregroundAppendBatchKeySha256,
			toolResultEntryId,
			pendingOverlayBinding,
			orderedAppendOperationIds,
			orderedPreReturnIdentities,
			orderedPreReturnIdentitySha256s,
			result.core.resultUtf8Sha256,
			result.core.resultUtf8ByteLength,
			result.core.sourceResultSnapshot.sourceSnapshotUtf8Sha256,
			result.core.sourceResultSnapshot.sourceSnapshotUtf8ByteLength,
			handoffs,
		] as const;
		const batch: ConfidentialTransientTaskForegroundResultHandoffBatchV1 = {
			schemaVersion: 1,
			parentSessionId,
			toolCallId,
			toolResultSerializerKeySha256: invocation.serializerKey.serializerKeySha256,
			sourceToolCallOrdinal: invocation.sourceToolCallOrdinal,
			foregroundAppendBatchKeySha256,
			toolResultEntryId,
			pendingOverlayBinding,
			orderedAppendOperationIds,
			orderedPreReturnIdentities,
			orderedPreReturnIdentitySha256s,
			returnedAgentToolResultUtf8Sha256: result.core.resultUtf8Sha256,
			returnedAgentToolResultUtf8ByteLength: result.core.resultUtf8ByteLength,
			returnedSourceResultSnapshotSha256: result.core.sourceResultSnapshot.sourceSnapshotUtf8Sha256,
			returnedSourceResultSnapshotByteLength: result.core.sourceResultSnapshot.sourceSnapshotUtf8ByteLength,
			handoffs,
			handoffBatchSha256: transientTaskForegroundTupleSha256(batchCore),
		};
		const prepared = await invocation.authority.settlement.prepareHandoff(batch).catch(() => null);
		if (prepared === null) {
			return this.#suspendTaskForegroundBeforeReturn(invocation, record, "handoff_prepare_response_lost");
		}
		if (prepared.status !== "prepared" && prepared.status !== "already_prepared") {
			const reason =
				prepared.status === "session_generation_replaced"
					? "session_generation_replaced"
					: prepared.status === "branch_generation_replaced"
						? "branch_generation_replaced"
						: prepared.status === "invalid"
							? "invalid"
							: "conflict";
			return this.#suspendTaskForegroundBeforeReturn(invocation, record, reason);
		}
		if (
			prepared.handoffBatchSha256 !== batch.handoffBatchSha256 ||
			transientTaskForegroundStringify(prepared.orderedPreReturnIdentitySha256s) !==
				transientTaskForegroundStringify(orderedPreReturnIdentitySha256s)
		) {
			return this.#suspendTaskForegroundBeforeReturn(invocation, record, "conflict");
		}
		return batch;
	}

	async #completeTaskForegroundInvocation(
		toolCallId: string,
		invocation: TaskForegroundInvocationV1 | null,
		classification: TransientTaskForegroundDispatchClassificationV1 | null,
		preclassificationReason: "preflight_error" | "mode_error",
		children: readonly TaskForegroundCompletedChildV1[],
		sourceResult: AgentToolResult<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		if (!invocation) return sourceResult;
		const projectionResult = validateAndProjectTransientTaskForegroundSourceAgentToolResultV1(sourceResult);
		const returnedResult = (
			projectionResult.status === "projected"
				? projectionResult.sourceResult
				: projectionResult.rejection.core.toolResult
		) as AgentToolResult<TaskToolDetails>;
		const resultProjection =
			projectionResult.status === "projected"
				? projectionResult.projection
				: projectionResult.rejection.core.toolResultProjection;
		const completedBlockingChildCount = children.length;
		const resultLooksLikeToolError =
			projectionResult.status === "rejected" ||
			returnedResult.isError === true ||
			(Array.isArray(returnedResult.details?.results) && returnedResult.details.results.length === 0);
		let observationInput: Parameters<
			AgentSessionTransientTaskSourceObservationProducerV1["reserveAndFreezeTransientTaskSourceObservationDraft"]
		>[0]["core"]["observationInput"];
		let executedWithoutHandoff = false;

		if (classification === null) {
			observationInput = {
				schemaVersion: 1,
				eventKind: "task_execute_result_classification",
				executeEntryObservationReceipt: invocation.executeEntryObservationReceipt,
				result: resultProjection,
				dispatchClassification: null,
				resultDisposition: "executed_without_handoff",
				noHandoffReason: preclassificationReason,
				completedBlockingChildCount: 0,
			};
			executedWithoutHandoff = true;
		} else if (!isTaskForegroundPresentDispatchClassification(classification)) {
			const reason = resultLooksLikeToolError ? "tool_error" : "async_only";
			observationInput = {
				schemaVersion: 1,
				eventKind: "task_execute_result_classification",
				executeEntryObservationReceipt: invocation.executeEntryObservationReceipt,
				result: resultProjection,
				dispatchClassification: classification,
				resultDisposition: "executed_without_handoff",
				noHandoffReason: reason,
				completedBlockingChildCount: 0,
			};
			executedWithoutHandoff = true;
		} else if (completedBlockingChildCount === 0) {
			const reason = resultLooksLikeToolError ? "tool_error" : "zero_completed_blocking_children";
			observationInput = {
				schemaVersion: 1,
				eventKind: "task_execute_result_classification",
				executeEntryObservationReceipt: invocation.executeEntryObservationReceipt,
				result: resultProjection,
				dispatchClassification: classification,
				resultDisposition: "executed_without_handoff",
				noHandoffReason: reason,
				completedBlockingChildCount: 0,
			};
			executedWithoutHandoff = true;
		} else if (projectionResult.status === "rejected") {
			observationInput = {
				schemaVersion: 1,
				eventKind: "task_execute_result_classification",
				executeEntryObservationReceipt: invocation.executeEntryObservationReceipt,
				result: resultProjection,
				dispatchClassification: classification,
				resultDisposition: "executed_without_handoff",
				noHandoffReason: "source_value_unrepresentable",
				sourceProjectionRejection: projectionResult.rejection,
				completedBlockingChildCount,
			};
			executedWithoutHandoff = true;
		} else {
			observationInput = {
				schemaVersion: 1,
				eventKind: "task_execute_result_classification",
				executeEntryObservationReceipt: invocation.executeEntryObservationReceipt,
				result: resultProjection,
				dispatchClassification: classification,
				resultDisposition: "foreground_handoff_present",
				noHandoffReason: null,
				completedBlockingChildCount,
			};
		}
		const executeResultObservationReceipt = await this.#recordTaskForegroundObservation(invocation, observationInput);
		if (executeResultObservationReceipt.core.eventKind !== "task_execute_result_classification") {
			throw new StructuredSubagentError("execution", "Task execute-result observation receipt changed event kind.");
		}

		if (executedWithoutHandoff) return returnedResult;
		if (classification === null || !isTaskForegroundPresentDispatchClassification(classification)) {
			throw new StructuredSubagentError("execution", "Task foreground handoff classification is unavailable.");
		}

		await this.#prepareTaskForegroundHandoff(toolCallId, invocation, classification, children, resultProjection);
		return returnedResult;
	}

	/**
	 * Create a TaskTool instance with async agent discovery.
	 */
	static async create(session: ToolSession): Promise<TaskTool> {
		const { agents } = await discoverAgentsForCreate(session.cwd);
		return new TaskTool(session, agents);
	}

	async execute(
		toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const params = repairTaskParams(rawParams as TaskParams);
		// Schema defaults fill `agent` for model calls, but internal callers
		// and stale transcripts can bypass arktype. `spawnParamsFor` resolves each
		// item's agent type against the session's actual default agent.
		const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
		const batchEnabled = this.#isBatchEnabled();
		const validationError = validateShapeParams(batchEnabled, params) ?? validateSpawnParams(params, batchEnabled);
		if (validationError) {
			return createTaskModeError(validationError);
		}

		const spawnItems = resolveSpawnItems(params);
		const normalizedSpawnParams = spawnItems.map(item => spawnParamsFor(params, item, defaultAgent));
		const resolvedAgents = normalizedSpawnParams.map(spawn => spawn.agent ?? defaultAgent);
		// Resolve every item before choosing an execution path. No executor or
		// job manager may observe a batch unless every effective policy is valid.
		const preflights = await Promise.all(
			normalizedSpawnParams.map(async spawn => {
				try {
					return { policy: await this.#resolveSpawnPreflight(spawn) };
				} catch (error) {
					return { error: error instanceof StructuredSubagentError ? error.message : String(error) };
				}
			}),
		);
		const preflightFailures = preflights
			.map((preflight, index) => ("error" in preflight ? { index, error: preflight.error } : undefined))
			.filter((failure): failure is { index: number; error: string } => failure !== undefined);
		if (preflightFailures.length > 0) {
			if (!batchEnabled) {
				return createTaskModeError(`Task execution failed: ${preflightFailures[0]!.error}`);
			}
			return createTaskModeError(
				preflightFailures
					.map(({ index, error }) => {
						const item = spawnItems[index]!;
						return `Task ${item.name?.trim() || `#${index + 1}`} failed preflight: ${error}`;
					})
					.join("\n"),
			);
		}
		const policies = preflights.map(preflight => preflight.policy!);
		const foregroundInvocation = await this.#beginTaskForegroundInvocation(toolCallId, params);
		const foregroundChildren: TaskForegroundCompletedChildV1[] = [];
		let foregroundClassification: TransientTaskForegroundDispatchClassificationV1 | null = null;
		const completeForeground = (
			result: AgentToolResult<TaskToolDetails>,
			preclassificationReason: "preflight_error" | "mode_error" = "mode_error",
		) =>
			this.#completeTaskForegroundInvocation(
				toolCallId,
				foregroundInvocation,
				foregroundClassification,
				preclassificationReason,
				foregroundChildren,
				result,
			);
		const onForegroundCompletedChild = (child: TaskForegroundCompletedChildV1) => {
			foregroundChildren.push(child);
		};
		const itemBlocking = policies.map(policy => policy.effectiveAgent.blocking === true);

		// Execution mode is per item: an item whose agent type declares
		// `blocking: true` runs inline on this turn (the parent waits on its
		// result); every other item becomes a background job when async
		// execution is available.
		const asyncEnabled = this.session.settings.get("async.enabled");
		const manager = asyncEnabled ? this.session.asyncJobManager : undefined;
		const asyncItems = manager ? spawnItems.filter((_, index) => !itemBlocking[index]) : [];
		if (foregroundInvocation) {
			const blockingChildCount = manager
				? itemBlocking.reduce((count, blocking) => count + (blocking ? 1 : 0), 0)
				: spawnItems.length;
			const asyncChildCount = manager ? spawnItems.length - blockingChildCount : 0;
			foregroundClassification = this.#createTaskForegroundDispatchClassification(
				foregroundInvocation,
				blockingChildCount,
				asyncChildCount,
			);
		}
		const depthCapacity = canSpawnAtDepth(
			this.session.settings.get("task.maxRecursionDepth") ?? 2,
			this.session.taskDepth ?? 0,
		);
		const ircEnabled = isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0);

		if (!manager || asyncItems.length === 0) {
			// Sync fallback: async execution disabled, orphaned host that never
			// wired a job manager, or every item's agent type declares
			// `blocking: true`.
			if (asyncEnabled && !this.session.asyncJobManager) {
				logger.warn("task: no AsyncJobManager registered; falling back to sync execution");
			}
			const advisory = this.session.suppressSpawnAdvisory
				? undefined
				: composeSpawnAdvisory({
						agents: resolvedAgents,
						items: asyncItems,
						depthCapacity,
						ircEnabled,
						willRunAsync: false,
						scoutAvailable: isScoutSpawnable(
							this.session.settings.get("task.disabledAgents") as string[] | undefined,
							this.session.getSessionSpawns?.() ?? "*",
						),
					});
			const result = await this.#executeSyncFanout(
				toolCallId,
				params,
				spawnItems.map((item, index) => ({ item, index })),
				defaultAgent,
				signal,
				onUpdate,
				onForegroundCompletedChild,
			);
			if (!advisory) return completeForeground(result);
			let appended = false;
			const content = result.content.map(part => {
				if (!appended && part.type === "text" && typeof part.text === "string") {
					appended = true;
					return { ...part, text: `${part.text}\n\n${advisory}` };
				}
				return part;
			});
			if (!appended) content.push({ type: "text", text: advisory });
			return completeForeground({ ...result, content });
		}

		// Coordination only makes sense for spawns that keep running after this
		// call returns (the async subset). Blocking items have already completed
		// by then, so a "coordinate while they run" hint would misfire.
		const advisory = this.session.suppressSpawnAdvisory
			? undefined
			: composeSpawnAdvisory({
					agents: resolvedAgents,
					items: asyncItems,
					depthCapacity,
					ircEnabled,
					willRunAsync: asyncItems.length > 0,
					scoutAvailable: isScoutSpawnable(
						this.session.settings.get("task.disabledAgents") as string[] | undefined,
						this.session.getSessionSpawns?.() ?? "*",
					),
				});
		// Returns a fresh result (copied content array, copied text part) rather
		// than mutating the caller's — task results are short-lived here, but an
		// in-place edit on a shared/cached AgentToolResult would be a hidden trap.
		const withAdvisory = (result: AgentToolResult<TaskToolDetails>): AgentToolResult<TaskToolDetails> => {
			if (!advisory) return result;
			let appended = false;
			const content = result.content.map(part => {
				if (!appended && part.type === "text" && typeof part.text === "string") {
					appended = true;
					return { ...part, text: `${part.text}\n\n${advisory}` };
				}
				return part;
			});
			if (!appended) content.push({ type: "text", text: advisory });
			return { ...result, content };
		};
		if (asyncItems.length === 0) {
			return completeForeground(
				withAdvisory(
					await this.#executeSyncFanout(
						toolCallId,
						params,
						spawnItems.map((item, index) => ({ item, index })),
						defaultAgent,
						signal,
						onUpdate,
						onForegroundCompletedChild,
					),
				),
			);
		}

		// Async IDs are claimed before job registration, so retain the fallback
		// manager on the session rather than recreating it for every call.
		let outputManager = this.session.agentOutputManager;
		if (!outputManager) {
			outputManager = new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
			this.session.agentOutputManager = outputManager;
		}
		const callStartedAt = Date.now();
		const spawns: Array<{
			agentId: string;
			item: TaskItem;
			index: number;
			blocking: boolean;
			progress: AgentProgress;
		}> = [];
		for (const [index, item] of spawnItems.entries()) {
			const agentType = resolvedAgents[index]!;
			const policy = policies[index]!;
			const agentSource = policy.agent.source;
			const agentId = await outputManager.allocate(item.name?.trim() || generateTaskName());
			const assignment = (item.task ?? "").trim();
			spawns.push({
				agentId,
				item,
				index,
				blocking: itemBlocking[index],
				progress: {
					index,
					id: agentId,
					agent: agentType,
					agentSource,
					status: "pending",
					task: renderSubagentUserPrompt(assignment),
					assignment,
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 0,
				},
			});
		}
		const asyncSpawns = spawns.filter(spawn => !spawn.blocking);
		const syncSpawns = spawns.filter(spawn => spawn.blocking);
		const agentLabel = [...new Set(asyncSpawns.map(spawn => spawn.progress.agent))].join(", ");

		// Aggregate state for the one tool call. Async spawns report into the
		// shared progress snapshot through their jobs: the async half stays
		// "running" until every job settles, then turns "failed" if any spawn
		// failed. Blocking spawns run inline below and land in `results` before
		// the call returns, so post-return job updates never drop them.
		let settledCount = 0;
		let failedCount = 0;
		let primaryJobId = asyncSpawns[0].agentId;
		const syncResults: SingleResult[] = [];
		let syncUsage: Usage | undefined;
		let syncOutputPaths: string[] | undefined;
		let syncProjectAgentsDir: string | null = null;
		const buildAsyncDetails = (): TaskToolDetails => ({
			projectAgentsDir: syncProjectAgentsDir,
			results: [...syncResults],
			totalDurationMs: Date.now() - callStartedAt,
			usage: syncUsage,
			outputPaths: syncOutputPaths,
			progress: spawns.map(spawn => ({ ...spawn.progress })),
			async: {
				state: settledCount < asyncSpawns.length ? "running" : failedCount > 0 ? "failed" : "completed",
				jobId: primaryJobId,
				type: "task",
			},
		});

		const started: Array<{ agentId: string; jobId: string }> = [];
		const failedSchedules: string[] = [];
		let reusableTransientTaskRuntimeAuthority = foregroundInvocation?.runtimeAuthority;
		for (const spawn of asyncSpawns) {
			const transientTaskRuntimeAuthority = policies[spawn.progress.index]!.isIsolated
				? reusableTransientTaskRuntimeAuthority
				: undefined;
			if (transientTaskRuntimeAuthority) reusableTransientTaskRuntimeAuthority = undefined;
			try {
				const jobId = await this.#registerSpawnJob({
					manager,
					toolCallId,
					spawnParams: spawnParamsFor(params, spawn.item, defaultAgent),
					agentId: spawn.agentId,
					progress: spawn.progress,
					policy: policies[spawn.progress.index]!,
					transientTaskRuntimeAuthority,
					ircEnabled,
					buildDetails: buildAsyncDetails,
					onUpdate,
					onSettled: failed => {
						settledCount += 1;
						if (failed) failedCount += 1;
					},
				});
				if (started.length === 0) primaryJobId = jobId;
				started.push({ agentId: spawn.agentId, jobId });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failedSchedules.push(`${spawn.agentId}: ${message}`);
				spawn.progress.status = "failed";
				settledCount += 1;
				failedCount += 1;
			}
		}

		if (started.length === 0 && syncSpawns.length === 0) {
			return completeForeground({
				content: [
					{
						type: "text",
						text: `Failed to start background task job${failedSchedules.length === 1 ? "" : "s"}: ${failedSchedules.join("; ")}`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			});
		}

		const scheduleFailureSummary =
			failedSchedules.length > 0
				? ` Failed to schedule ${failedSchedules.length} spawn${failedSchedules.length === 1 ? "" : "s"}: ${failedSchedules.join("; ")}.`
				: "";
		const coordinationHint = [
			started.length === 1
				? ircEnabled
					? `DM \`${started[0].agentId}\` via \`hub\` send to coordinate while it runs; use \`hub\` only to inspect (\`jobs\`), wait, or cancel a stuck task.`
					: `Use \`hub\` to inspect (\`jobs\`), wait, or cancel a stuck task.`
				: ircEnabled
					? `DM these ids via \`hub\` send to coordinate while they run; use \`hub\` only to inspect (\`jobs\`), wait, or cancel a stuck task.`
					: `Use \`hub\` to inspect (\`jobs\`), wait, or cancel a stuck task by id.`,
			taskAsyncContractTemplate.trim(),
		].join("\n");

		if (syncSpawns.length === 0) {
			if (spawns.length === 1) {
				const { agentId, jobId } = started[0];
				onUpdate?.({
					content: [{ type: "text", text: `Spawned agent \`${agentId}\`...` }],
					details: buildAsyncDetails(),
				});
				return completeForeground(
					withAdvisory({
						content: [
							{
								type: "text",
								text: `Spawned agent \`${agentId}\` (job \`${jobId}\`). Its result auto-delivers on yield unless a settled \`hub jobs\`/\`wait\` snapshot consumes it first. ${coordinationHint}`,
							},
						],
						details: buildAsyncDetails(),
					}),
				);
			}
			const startedListing = started.map(({ agentId, jobId }) => `- \`${agentId}\` (job \`${jobId}\`)`).join("\n");
			onUpdate?.({
				content: [{ type: "text", text: `Spawned ${started.length} agents...` }],
				details: buildAsyncDetails(),
			});
			return completeForeground(
				withAdvisory({
					content: [
						{
							type: "text",
							text: `Spawned ${started.length} background agents using ${agentLabel}.${scheduleFailureSummary} Each result auto-delivers on yield unless a settled \`hub jobs\`/\`wait\` snapshot consumes it first.\n${startedListing}\n${coordinationHint}`,
						},
					],
					details: buildAsyncDetails(),
				}),
			);
		}

		// Mixed call: the async jobs above already run detached; the blocking
		// subset runs inline and gates the call's return — exactly what each
		// agent type declares (`blocking: true` = the parent waits on it).
		const syncLabel = syncSpawns.map(spawn => `\`${spawn.agentId}\``).join(", ");
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `Running ${syncLabel} inline; ${started.length} background agent${started.length === 1 ? "" : "s"} spawned...`,
				},
			],
			details: buildAsyncDetails(),
		});
		const payloads = await this.#runSyncSpawns({
			toolCallId,
			params,
			defaultAgent,
			signal,
			spawns: syncSpawns.map(spawn => ({ item: spawn.item, index: spawn.index, preAllocatedId: spawn.agentId })),
			onItemProgress: onUpdate
				? (index, progress) => {
						const spawn = spawns.find(candidate => candidate.index === index);
						if (spawn) spawn.progress = { ...progress, index };
						onUpdate({
							content: [{ type: "text", text: `Running ${syncLabel} inline...` }],
							details: buildAsyncDetails(),
						});
					}
				: undefined,
			onTransientForegroundCompletedChild: onForegroundCompletedChild,
		});
		const merged = mergeSyncPayloads(
			syncSpawns.map(spawn => ({ item: spawn.item, index: spawn.index })),
			payloads,
		);
		syncResults.push(...merged.results);
		syncUsage = merged.usage;
		syncOutputPaths = merged.outputPaths;
		syncProjectAgentsDir = merged.projectAgentsDir;
		// Settle the inline spawns' progress rows from their merged results so
		// post-return job updates carry final statuses, not the last snapshot.
		for (let position = 0; position < syncSpawns.length; position++) {
			const spawn = syncSpawns[position];
			const result = merged.results.find(r => r.id === spawn.agentId);
			if (result) {
				spawn.progress.status = result.aborted
					? "aborted"
					: result.exitCode === 0 && !result.error
						? "completed"
						: "failed";
				spawn.progress.durationMs = result.durationMs;
			} else {
				spawn.progress.status = payloads[position] ? "failed" : "aborted";
			}
		}

		const spawnedSummary =
			started.length > 0
				? `Spawned ${started.length} background agent${started.length === 1 ? "" : "s"}.${scheduleFailureSummary} Each result auto-delivers on yield unless a settled \`hub jobs\`/\`wait\` snapshot consumes it first.\n${started.map(({ agentId, jobId }) => `- \`${agentId}\` (job \`${jobId}\`)`).join("\n")}\n${coordinationHint}`
				: scheduleFailureSummary.trim();
		const text = [merged.contentParts.join("\n\n"), spawnedSummary]
			.filter(section => section.trim().length > 0)
			.join("\n\n");
		return completeForeground(
			withAdvisory({
				content: [{ type: "text", text: text.length > 0 ? text : "No results." }],
				details: buildAsyncDetails(),
			}),
		);
	}

	/**
	 * Register one background job that runs a single spawn to completion and
	 * delivers its yield text. The job body mirrors the sync path; `buildDetails`
	 * supplies the (possibly batch-shared) progress snapshot and `onSettled`
	 * feeds the caller's aggregate counters.
	 */
	async #registerSpawnJob(options: {
		manager: AsyncJobManager;
		toolCallId: string;
		spawnParams: TaskParams;
		agentId: string;
		policy: EffectiveSubagentPolicy;
		transientTaskRuntimeAuthority?: AgentSessionTransientTaskRuntimeAuthorityV1;
		progress: AgentProgress;
		ircEnabled: boolean;
		buildDetails: () => TaskToolDetails;
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
		onSettled?: (failed: boolean) => void;
	}): Promise<string> {
		const {
			manager,
			toolCallId,
			spawnParams,
			agentId,
			progress,
			policy,
			transientTaskRuntimeAuthority,
			ircEnabled,
			buildDetails,
			onUpdate,
			onSettled,
		} = options;
		let transientTaskRuntimeAssembly: StructuredSubagentTransientTaskRuntimeAssemblyV1 | undefined;
		let transientTaskOwnerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1 | undefined;
		if (policy.isIsolated) {
			const authority =
				transientTaskRuntimeAuthority ??
				(await (() => {
					const acquireAuthority = resolveTransientTaskRuntimeAuthorityAcquirer(this.session);
					if (!acquireAuthority) {
						throw new StructuredSubagentError(
							"preflight",
							"Isolated task execution requires the session-owned transient-task runtime authority.",
						);
					}
					return acquireAuthority();
				})());
			transientTaskOwnerSessionIndex = authority.ownerSessionIndex;
			transientTaskRuntimeAssembly = await createStructuredSubagentTransientTaskRuntimeV1({
				authority,
				parentToolCallId: toolCallId,
				spawnIndex: progress.index,
				detachedJobId: agentId,
				childId: agentId,
				agentName: policy.agent.name,
				captureMode: policy.mergeMode,
				applyChanges: policy.applyChanges,
			});
		}
		const buildFollowUpHint = async (aborted: boolean): Promise<string> => {
			if (aborted) {
				const ref = AgentRegistry.global().get(agentId);
				const transcript = (await hasResolvableTranscript(agentId))
					? `transcript at history://${agentId}`
					: "transcript unavailable";
				if (ref?.status === "idle" || ref?.status === "parked") {
					const followUp = ircEnabled ? "message it via `hub` to resume; " : "";
					return `\n\n${agentId} was stopped but is still resumable — ${followUp}${transcript}`;
				}
				return `\n\n${agentId} was aborted — ${transcript}`;
			}
			const followUp = ircEnabled ? "message it via `hub` to follow up; " : "";
			return `\n\n${agentId} is now idle — ${followUp}transcript at history://${agentId}`;
		};

		const runSpawnJob = async (
			runSignal: AbortSignal,
			reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>,
			markRunning: () => void,
		): Promise<{
			readonly deliveryText: string;
			readonly resultFailed: boolean;
			readonly terminalEvidence: TransientTaskPostTerminalCleanupEvidenceV1 | undefined;
			readonly preExecutionCancelled: boolean;
		}> => {
			const startedAt = Date.now();
			const semaphore = this.#getSpawnSemaphore();
			let semaphoreHeld = false;
			let settledReported = false;
			const reportSettled = (failed: boolean) => {
				if (settledReported) return;
				settledReported = true;
				onSettled?.(failed);
			};
			const releasePermit = () => {
				if (!semaphoreHeld) return;
				semaphoreHeld = false;
				this.#releaseSpawnSemaphore();
			};
			try {
				await semaphore.acquire(runSignal);
				semaphoreHeld = true;
			} catch {
				// Pass an acquire-time abort through the sealed transient runtime so
				// it can acknowledge pre-pending state and release the pre-bind claim.
			}
			const acquiredAt = Date.now();
			if (!semaphoreHeld || runSignal.aborted) {
				releasePermit();
				progress.status = "aborted";
				if (!transientTaskRuntimeAssembly) {
					reportSettled(true);
					throw new Error(TRANSIENT_TASK_DETACHED_PRE_EXECUTION_ABORT_JOB_ERROR_TEXT_V1);
				}
				let preExecutionCancelled = false;
				await this.#executeSync(
					toolCallId,
					spawnParams,
					runSignal,
					undefined,
					agentId,
					progress.index,
					true,
					{ invokedAt: startedAt, acquiredAt },
					transientTaskRuntimeAssembly,
					undefined,
					() => {
						preExecutionCancelled = true;
					},
				);
				reportSettled(true);
				if (!preExecutionCancelled) {
					throw new Error("Transient task aborted before execution without sealed cancellation settlement");
				}
				return {
					deliveryText: TRANSIENT_TASK_DETACHED_PRE_EXECUTION_ABORT_JOB_ERROR_TEXT_V1,
					resultFailed: true,
					terminalEvidence: undefined,
					preExecutionCancelled: true,
				};
			}
			let terminalEvidence: TransientTaskPostTerminalCleanupEvidenceV1 | undefined;
			let preExecutionCancelled = false;
			try {
				markRunning();
				progress.status = "running";
				await reportProgress(
					`Running background task ${agentId}...`,
					buildDetails() as unknown as Record<string, unknown>,
				);
				const forwardSyncProgress: AgentToolUpdateCallback<TaskToolDetails> = async update => {
					const nextProgress = update.details?.progress?.[0];
					if (nextProgress) {
						progress.resolvedModel = nextProgress.resolvedModel;
						progress.resolvedModelIsFallback = nextProgress.resolvedModelIsFallback;
						progress.tokens = nextProgress.tokens;
						progress.requests = nextProgress.requests;
						progress.contextTokens = nextProgress.contextTokens;
						progress.contextWindow = nextProgress.contextWindow;
						progress.cost = nextProgress.cost;
						progress.toolCount = nextProgress.toolCount;
						progress.currentTool = nextProgress.currentTool;
						progress.lastIntent = nextProgress.lastIntent;
						progress.recentTools = nextProgress.recentTools.slice();
						progress.recentOutput = nextProgress.recentOutput.slice();
						progress.retryState = nextProgress.retryState;
						progress.retryFailure = nextProgress.retryFailure;
					}
					const updateText =
						update.content.find(part => part.type === "text")?.text ?? `Running background task ${agentId}...`;
					await reportProgress(updateText, buildDetails() as unknown as Record<string, unknown>);
				};
				const result = await this.#executeSync(
					toolCallId,
					spawnParams,
					runSignal,
					forwardSyncProgress,
					agentId,
					progress.index,
					true,
					{ invokedAt: startedAt, acquiredAt },
					transientTaskRuntimeAssembly,
					evidence => {
						terminalEvidence = evidence;
					},
					() => {
						preExecutionCancelled = true;
					},
				);
				if (preExecutionCancelled) {
					progress.status = "aborted";
					progress.durationMs = Math.max(0, Date.now() - startedAt);
					reportSettled(true);
					return {
						deliveryText: TRANSIENT_TASK_DETACHED_PRE_EXECUTION_ABORT_JOB_ERROR_TEXT_V1,
						resultFailed: true,
						terminalEvidence: undefined,
						preExecutionCancelled: true,
					};
				}
				const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
				const singleResult = result.details?.results[0];
				const resultFailed = !singleResult || (singleResult.aborted ?? false) || singleResult.exitCode !== 0;
				if (transientTaskRuntimeAssembly && !terminalEvidence) {
					throw new Error("Isolated background task completed without exact terminal evidence");
				}
				progress.status = singleResult?.aborted ? "aborted" : resultFailed ? "failed" : "completed";
				progress.durationMs = singleResult?.durationMs ?? Math.max(0, Date.now() - startedAt);
				progress.tokens = singleResult?.tokens ?? 0;
				progress.requests = singleResult?.requests ?? 0;
				progress.contextTokens = singleResult?.contextTokens;
				progress.contextWindow = singleResult?.contextWindow;
				progress.cost = singleResult?.usage?.cost.total ?? 0;
				progress.extractedToolData = singleResult?.extractedToolData;
				progress.retryFailure = singleResult?.retryFailure;
				progress.retryState = undefined;
				if (singleResult?.resolvedModel) {
					progress.resolvedModel = singleResult.resolvedModel;
					progress.resolvedModelIsFallback = singleResult.resolvedModelIsFallback;
				} else {
					delete progress.resolvedModel;
					delete progress.resolvedModelIsFallback;
				}
				reportSettled(resultFailed);
				const statusText = resultFailed
					? `Background task ${agentId} failed.`
					: `Background task ${agentId} complete.`;
				try {
					await reportProgress(statusText, buildDetails() as unknown as Record<string, unknown>);
				} catch (error) {
					if (!terminalEvidence) throw error;
					logger.warn("Terminal task progress observation failed", {
						agentId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				let deliveryText = finalText;
				try {
					deliveryText += await buildFollowUpHint(singleResult?.aborted === true);
				} catch (error) {
					if (!terminalEvidence) throw error;
					logger.warn("Terminal task follow-up hint failed", {
						agentId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return {
					deliveryText,
					resultFailed,
					terminalEvidence,
					preExecutionCancelled: false,
				};
			} catch (error) {
				progress.status = "failed";
				progress.durationMs = Math.max(0, Date.now() - startedAt);
				reportSettled(true);
				const message = error instanceof Error ? error.message : String(error);
				if (transientTaskRuntimeAssembly && terminalEvidence) {
					return {
						deliveryText: message,
						resultFailed: true,
						terminalEvidence,
						preExecutionCancelled: false,
					};
				}
				await reportProgress(
					`Background task ${agentId} failed.`,
					buildDetails() as unknown as Record<string, unknown>,
				);
				if (error instanceof TaskJobError) throw error;
				const hint = AgentRegistry.global().get(agentId) ? await buildFollowUpHint(false) : "";
				throw new TaskJobError(`${message}${hint}`);
			} finally {
				releasePermit();
			}
		};
		const jobProgress = {
			id: agentId,
			agentId,
			queued: true,
			onProgress: async (text: string) => {
				try {
					await onUpdate?.({ content: [{ type: "text", text }], details: buildDetails() });
				} catch (error) {
					logger.warn("Task progress observer failed", {
						agentId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			},
		};
		if (!transientTaskRuntimeAssembly || !transientTaskOwnerSessionIndex) {
			return manager.register(
				"task",
				agentId,
				async context => {
					const outcome = await runSpawnJob(context.signal, context.reportProgress, context.markRunning);
					if (outcome.resultFailed) throw new TaskJobError(outcome.deliveryText);
					return outcome.deliveryText;
				},
				{
					...jobProgress,
					ownerId: this.session.getAgentId?.() ?? undefined,
				},
			);
		}

		const assembly = transientTaskRuntimeAssembly;
		const ownerSessionIndex = transientTaskOwnerSessionIndex;
		try {
			return manager.registerTransientTask(
				agentId,
				async (context: AsyncJobTransientTaskRunContextV1) => {
					const outcome = await runSpawnJob(
						context.signal,
						(text, details) => context.reportProgress(text, details),
						context.markRunning,
					);
					if (outcome.preExecutionCancelled) {
						return assembly.settleDetached({
							context,
							terminalStatus: "cancelled",
							terminalEvidence: null,
							deliveryText: TRANSIENT_TASK_DETACHED_PRE_EXECUTION_ABORT_JOB_ERROR_TEXT_V1,
						});
					}
					if (!outcome.terminalEvidence) {
						throw new Error("Isolated background task completed without exact terminal evidence");
					}
					return assembly.settleDetached({
						context,
						terminalStatus: outcome.resultFailed ? "failed" : "completed",
						terminalEvidence: outcome.terminalEvidence,
						deliveryText: outcome.deliveryText,
					});
				},
				{
					...jobProgress,
					ownerId: ownerSessionIndex.ownerId,
					ownerSessionId: ownerSessionIndex.ownerSessionId,
					ownerSessionGenerationSha256: ownerSessionIndex.ownerSessionGenerationSha256,
					deliveryEpoch: ownerSessionIndex.deliveryEpoch,
				},
			);
		} catch (registrationError) {
			const message = registrationError instanceof Error ? registrationError.message : String(registrationError);
			const reason =
				message === "Async job manager is disposed"
					? "async_job_manager_disposed"
					: message.startsWith("Background job limit reached (")
						? "async_job_capacity_rejected"
						: "async_job_registration_failed";
			await assembly.abortBeforeRegistration(reason);
			throw registrationError;
		}
	}

	/**
	 * Sync fan-out (async unavailable, or every item's agent type is
	 * `blocking: true`): run every spawn to completion inline and merge the
	 * per-spawn payloads into a single tool result. The session-scoped
	 * semaphore still bounds concurrency across parallel task calls.
	 */
	async #executeSyncFanout(
		toolCallId: string,
		params: TaskParams,
		spawns: SyncSpawnRef[],
		defaultAgent: string,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		onTransientForegroundCompletedChild?: (child: TaskForegroundCompletedChildV1) => void,
	): Promise<AgentToolResult<TaskToolDetails>> {
		if (spawns.length === 1) {
			const spawn = spawns[0]!;
			const semaphore = this.#getSpawnSemaphore();
			const invokedAt = Date.now();
			await semaphore.acquire(signal);
			const acquiredAt = Date.now();
			try {
				return await this.#executeSync(
					toolCallId,
					spawnParamsFor(params, spawn.item, defaultAgent),
					signal,
					onUpdate,
					spawn.preAllocatedId,
					spawn.index,
					false,
					{ invokedAt, acquiredAt },
					undefined,
					undefined,
					undefined,
					onTransientForegroundCompletedChild,
				);
			} finally {
				this.#releaseSpawnSemaphore();
			}
		}

		const startTime = Date.now();
		const latestProgress = new Map<number, AgentProgress>();
		const emitCombined = () => {
			onUpdate?.({
				content: [{ type: "text", text: `Running ${spawns.length} agents...` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress: Array.from(latestProgress.entries())
						.sort((a, b) => a[0] - b[0])
						.map(([, progress]) => progress),
				},
			});
		};

		const payloads = await this.#runSyncSpawns({
			toolCallId,
			params,
			defaultAgent,
			signal,
			spawns,
			onItemProgress: onUpdate
				? (index, progress) => {
						latestProgress.set(index, { ...progress, index });
						emitCombined();
					}
				: undefined,
			onTransientForegroundCompletedChild,
		});

		const merged = mergeSyncPayloads(spawns, payloads);
		return {
			content: [{ type: "text", text: merged.contentParts.join("\n\n") }],
			details: {
				projectAgentsDir: merged.projectAgentsDir,
				results: merged.results,
				totalDurationMs: Date.now() - startTime,
				usage: merged.usage,
				outputPaths: merged.outputPaths,
			},
		};
	}

	/**
	 * Run a set of spawns to completion inline, bounded by the session spawn
	 * semaphore. `preAllocatedId` reuses an id claimed up front (mixed calls);
	 * `index` is each item's position in the original call so progress rows and
	 * merged results keep stable ordering. Per-item progress snapshots flow
	 * through `onItemProgress`. Returns per-spawn payloads in input order;
	 * `undefined` marks a spawn cancelled before it started.
	 */
	async #runSyncSpawns(args: {
		toolCallId: string;
		params: TaskParams;
		defaultAgent: string;
		spawns: SyncSpawnRef[];
		signal?: AbortSignal;
		onItemProgress?: (index: number, progress: AgentProgress) => void;
		onTransientForegroundCompletedChild?: (child: TaskForegroundCompletedChildV1) => void;
	}): Promise<(AgentToolResult<TaskToolDetails> | undefined)[]> {
		const { toolCallId, params, defaultAgent, spawns, signal, onItemProgress, onTransientForegroundCompletedChild } =
			args;
		const semaphore = this.#getSpawnSemaphore();
		const { results } = await mapWithConcurrencyLimitAllSettled(
			spawns,
			spawns.length,
			async (spawn, _position, workerSignal) => {
				const invokedAt = Date.now();
				let semaphoreHeld = false;
				try {
					await semaphore.acquire(workerSignal);
					semaphoreHeld = true;
				} catch (error) {
					if (workerSignal.aborted) return undefined;
					throw error;
				}
				const acquiredAt = Date.now();
				try {
					const itemOnUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined = onItemProgress
						? update => {
								const progress = update.details?.progress?.[0];
								if (progress) onItemProgress(spawn.index, progress);
							}
						: undefined;
					return await this.#executeSync(
						toolCallId,
						spawnParamsFor(params, spawn.item, defaultAgent),
						workerSignal,
						itemOnUpdate,
						spawn.preAllocatedId,
						spawn.index,
						false,
						{ invokedAt, acquiredAt },
						undefined,
						undefined,
						undefined,
						onTransientForegroundCompletedChild,
					);
				} finally {
					if (semaphoreHeld) this.#releaseSpawnSemaphore();
				}
			},
			signal,
		);
		return results.map((settled, position) => {
			if (!settled) return undefined;
			if (settled.status === "fulfilled") return settled.value;
			const message = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
			const item = spawns[position].item;
			return {
				content: [
					{
						type: "text",
						text: `Task ${item.name?.trim() || `#${spawns[position].index + 1}`} failed: ${message}`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		});
	}

	/**
	 * Synchronous execution of one spawn. Used as the body of every
	 * async job and directly by the sync fallback (no job manager / blocking
	 * agent) and by in-process callers that need the result inline (e.g. the
	 * commit flow's analyze_files tool).
	 */
	async #executeSync(
		toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
		transientTaskRuntimeAssembly?: StructuredSubagentTransientTaskRuntimeAssemblyV1,
		onTransientTerminalEvidence?: (evidence: TransientTaskPostTerminalCleanupEvidenceV1) => void,
		onTransientPreExecutionCancelled?: (projection: TransientTaskResultlessTerminalProjectionV1) => void,
		onTransientForegroundCompletedChild?: (child: TaskForegroundCompletedChildV1) => void,
	): Promise<AgentToolResult<TaskToolDetails>> {
		return this.#runSpawn(
			toolCallId,
			params,
			signal,
			onUpdate,
			preAllocatedId,
			spawnIndex,
			detached,
			launchTiming,
			transientTaskRuntimeAssembly,
			onTransientTerminalEvidence,
			onTransientPreExecutionCancelled,
			onTransientForegroundCompletedChild,
		);
	}

	/** Spawn a fresh subagent and run it to completion. */
	async #runSpawn(
		toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
		transientTaskRuntimeAssembly?: StructuredSubagentTransientTaskRuntimeAssemblyV1,
		onTransientTerminalEvidence?: (evidence: TransientTaskPostTerminalCleanupEvidenceV1) => void,
		onTransientPreExecutionCancelled?: (projection: TransientTaskResultlessTerminalProjectionV1) => void,
		onTransientForegroundCompletedChild?: (child: TaskForegroundCompletedChildV1) => void,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const assignment = (params.task ?? "").trim();
		const context = this.#isBatchEnabled() ? params.context?.trim() || undefined : undefined;
		let latestProgress: AgentProgress | undefined;
		let runtimeAssembly = transientTaskRuntimeAssembly;
		try {
			const structuredRequest: StructuredSubagentRequest = {
				session: this.session,
				invocationKind: "task",
				assignment,
				context,
				agent: params.agent,
				...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
				...(Object.hasOwn(params, "schemaMode") ? { schemaMode: params.schemaMode } : {}),
				...(params.effort !== undefined ? { effort: params.effort } : {}),
				identity: { id: preAllocatedId, label: params.name },
				index: spawnIndex,
				parentToolCallId: toolCallId,
				detached,
				invokedAt: launchTiming?.invokedAt,
				acquiredAt: launchTiming?.acquiredAt,
				...("isolated" in params ? { isolation: { requested: params.isolated } } : {}),
				...(Object.hasOwn(params, "execution") ? { execution: params.execution } : {}),
				blockedAgent: this.#blockedAgent,
				enableLsp: (this.session.enableLsp ?? true) && this.session.settings.get("task.enableLsp"),
				enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
				maxRuntimeMs: this.session.settings.get("task.maxRuntimeMs"),
				signal,
				onProgress: progress => {
					latestProgress = { ...progress, recentTools: progress.recentTools.slice() };
					onUpdate?.({
						content: [{ type: "text", text: `Running agent ${progress.id}...` }],
						details: {
							projectAgentsDir: null,
							results: [],
							totalDurationMs: Date.now() - startTime,
							progress: [latestProgress],
						},
					});
				},
			};
			if (!runtimeAssembly) {
				const policy = await resolveEffectiveSubagentPolicy(structuredRequest);
				if (policy.isIsolated) {
					const childId = await reserveStructuredSubagentId(this.session, structuredRequest.identity);
					const acquireAuthority = resolveTransientTaskRuntimeAuthorityAcquirer(this.session);
					if (!acquireAuthority) {
						throw new StructuredSubagentError(
							"preflight",
							"Isolated task execution requires the session-owned transient-task runtime authority.",
						);
					}
					runtimeAssembly = await createStructuredSubagentTransientTaskRuntimeV1({
						authority: await acquireAuthority(),
						parentToolCallId: toolCallId,
						spawnIndex,
						detachedJobId: detached ? childId : null,
						childId,
						agentName: policy.agent.name,
						captureMode: policy.mergeMode,
						applyChanges: policy.applyChanges,
					});
					structuredRequest.identity = { id: childId, label: params.name };
				}
			}
			if (runtimeAssembly) structuredRequest.transientTaskRuntime = runtimeAssembly.runtime;
			const execution = await runStructuredSubagent(structuredRequest);
			if (runtimeAssembly) {
				if (!execution.terminalEvidence) {
					throw new StructuredSubagentError(
						"execution",
						"Isolated task execution completed without exact terminal evidence.",
					);
				}
				onTransientTerminalEvidence?.(execution.terminalEvidence);
				onTransientForegroundCompletedChild?.({
					spawnIndex,
					handoffIdentity: runtimeAssembly.foregroundHandoffIdentity,
				});
			}
			return this.#buildResultPayload(
				execution.result,
				execution.policy.discovery.projectAgentsDir,
				Date.now() - startTime,
				execution.mergeSummary,
			);
		} catch (error) {
			if (error instanceof StructuredSubagentLifecycleFailure) {
				onTransientTerminalEvidence?.(error.terminalEvidence);
				if (error.terminalProjection?.document.terminalOutcome === "cancelled") {
					onTransientPreExecutionCancelled?.(error.terminalProjection);
				}
				if (runtimeAssembly && error.result !== null) {
					onTransientForegroundCompletedChild?.({
						spawnIndex,
						handoffIdentity: runtimeAssembly.foregroundHandoffIdentity,
					});
				}
				if (error.result !== null) {
					return this.#buildResultPayload(error.result, null, Date.now() - startTime, error.mergeSummary);
				}
			}
			const message = error instanceof StructuredSubagentError ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Task execution failed: ${message}` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - startTime,
					...(latestProgress ? { progress: [latestProgress] } : {}),
				},
			};
		}
	}

	/** Build the tool result (summary text + details) for a settled run. */
	#buildResultPayload(
		result: SingleResult,
		projectAgentsDir: string | null,
		totalDurationMs: number,
		mergeSummary: string,
	): AgentToolResult<TaskToolDetails> {
		const status = result.aborted
			? "cancelled"
			: result.exitCode === 0 && result.error
				? "merge failed"
				: result.exitCode === 0
					? "completed"
					: `failed (exit ${result.exitCode})`;
		const output = formatResultOutputFallback(result);
		const outputCharCount = result.outputMeta?.charCount ?? output.length;
		const fullOutputThreshold = 5000;
		let preview = output;
		let truncated = false;
		if (outputCharCount > fullOutputThreshold) {
			const slice = output.slice(0, fullOutputThreshold);
			const lastNewline = slice.lastIndexOf("\n");
			preview = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
			truncated = true;
		}
		// A stopped-but-adopted agent (soft-budget stop) stays messageable; tell
		// the parent so it can resume via irc instead of redoing the work.
		const refStatus = AgentRegistry.global().get(result.id)?.status;
		const resumable = result.aborted && (refStatus === "idle" || refStatus === "parked");
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: result.agent,
			id: result.id,
			status,
			duration: formatDuration(totalDurationMs),
			abortReason: result.aborted ? result.abortReason : undefined,
			resumable,
			preview,
			truncated,
			meta: result.outputMeta
				? {
						lineCount: result.outputMeta.lineCount,
						charSize: formatBytes(result.outputMeta.charCount),
					}
				: undefined,
			mergeSummary,
		});

		return {
			content: [{ type: "text", text: summary }],
			details: {
				projectAgentsDir,
				results: [result],
				totalDurationMs,
				usage: result.usage,
				outputPaths: result.outputPath ? [result.outputPath] : undefined,
			},
		};
	}
}
