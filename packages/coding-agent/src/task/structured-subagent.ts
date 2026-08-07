/**
 * Shared policy resolution and execution for task and eval subagents.
 *
 * The two public frontends deliberately retain their presentation concerns, but
 * every decision that affects what a child may run lives here.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { $env, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import { resolveAgentModelPatterns } from "../config/model-resolver";
import type { LocalProtocolOptions } from "../internal-urls";
import { registerArtifactsDir } from "../internal-urls/registry-helpers";
import { MCPManager } from "../mcp/manager";
import { loadOverallPlanReference } from "../plan-mode/plan-handoff";
import planModeSubagentPrompt from "../prompts/system/plan-mode-subagent.md" with { type: "text" };
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type {
	AgentSessionTransientTaskCurrentParentLocatorV1,
	AgentSessionTransientTaskRuntimeAuthorityV1,
} from "../session/agent-session-types";
import type {
	ConfidentialTransientTaskEnsureIsolationRequestV1,
	OrdinaryTransientTaskLifecycleRunV1,
	TransientTaskCaptureModeV1,
	TransientTaskEffectIdentityManifestV1,
	TransientTaskOutcomePayloadByteBudgetV1,
	TransientTaskPostTerminalCleanupEvidenceV1,
	TransientTaskResultlessRepresentabilityPreflightV1,
	TransientTaskResultlessTerminalProjectionV1,
	TransientTaskResultPublicationPrePendingInitializeRequestV1,
} from "../session/workspace-runtime-contracts";
import type { TaskEffort } from "../thinking";
import type { ToolSession } from "../tools";
import { isIrcEnabled } from "../tools/hub";
import { buildOutputValidator } from "../tools/output-schema-validator";
import { type DiscoveryResult, discoverAgents, getAgent } from "./discovery";
import { type ExecutorOptions, preflightTransientTaskResultlessRepresentabilityV1, runSubprocess } from "./executor";
import { runIsolatedSubprocess } from "./isolation-runner";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager, createTransientTaskOutcomePayloadByteBudgetV1 } from "./output-manager";
import {
	createLocalSubagentRuntimeProfile,
	ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE,
	resolveSubagentRuntimeToolNames,
	type SubagentRuntimeProfile,
	subagentRuntimeAllows,
	type TransientTaskRuntimeInjectionV1,
	validateTransientTaskRuntimeInjectionV1,
} from "./runtime-profile";
import { resolveSpawnPolicy } from "./spawn-policy";
import {
	type AgentDefinition,
	type AgentProgress,
	canSpawnAtDepth,
	MAX_OUTPUT_BYTES,
	type SingleResult,
	StructuredSubagentError,
	type StructuredSubagentOutput,
} from "./types";
import type { ConfidentialTransientTaskIsolationMaterializerV1, NestedRepoPatch } from "./worktree";

/** Validation behavior requested for an effective output schema. */
export type StructuredSubagentSchemaMode = "permissive" | "strict";

/** Where an effective output schema came from. */
export type StructuredSubagentSchemaSource = "caller" | "agent" | "session" | "none";

/** Final structured completion metadata returned for a schema-bearing run. */
export type StructuredSubagentSchemaResult = StructuredSubagentOutput;

/** A schema validation or extraction error attached to structured completion metadata. */
export type StructuredSubagentSchemaError = NonNullable<StructuredSubagentOutput["error"]>;

/** A selected schema paired with its source and enforcement mode. */
export interface StructuredSubagentSchemaResolution {
	schema: unknown;
	source: StructuredSubagentSchemaSource;
	mode: StructuredSubagentSchemaMode;
	outputSchemaOverridesAgent: boolean;
}

/** Isolation controls shared by the task and eval surfaces. */
export interface StructuredSubagentIsolationControls {
	requested?: boolean;
	merge?: "patch" | "branch";
	apply?: boolean;
}

/** Exact ordinary-lifecycle authority consumed by one structured task execution. */
export interface StructuredSubagentTransientTaskRuntimeV1 extends TransientTaskRuntimeInjectionV1 {
	readonly materializer: ConfidentialTransientTaskIsolationMaterializerV1;
	readonly ensureRequest: ConfidentialTransientTaskEnsureIsolationRequestV1;
	readonly initializePrePendingRequest: TransientTaskResultPublicationPrePendingInitializeRequestV1;
	readonly fail: OrdinaryTransientTaskLifecycleRunV1["fail"];
	readonly finalized: OrdinaryTransientTaskLifecycleRunV1["finalized"];
	readonly isolationReady: OrdinaryTransientTaskLifecycleRunV1["isolationReady"];
	readonly releaseExecutionEnvironment: OrdinaryTransientTaskLifecycleRunV1["releaseExecutionEnvironment"];
	readonly finalizeAfterPending: OrdinaryTransientTaskLifecycleRunV1["finalizeAfterPending"];
}

export interface StructuredSubagentTransientTaskRuntimeCreateOptionsV1 {
	readonly authority: AgentSessionTransientTaskRuntimeAuthorityV1;
	readonly parentToolCallId: string;
	readonly spawnIndex: number;
	readonly detachedJobId: string | null;
	readonly childId: string;
	readonly agentName: string;
	readonly captureMode: TransientTaskCaptureModeV1;
	readonly applyChanges: boolean;
}

/** Immutable per-child identity allocated by the sole ordinary lifecycle producer. */
export interface StructuredSubagentForegroundHandoffIdentityV1 {
	readonly resultTargetKey: TransientTaskResultPublicationPrePendingInitializeRequestV1["plan"]["resultTargetKey"];
	readonly effectIdentityManifest: TransientTaskEffectIdentityManifestV1;
}

/** @internal Per-spawn runtime plus the only detached settlement authority TaskTool may retain. */
export interface StructuredSubagentTransientTaskRuntimeAssemblyV1 {
	readonly runtime: StructuredSubagentTransientTaskRuntimeV1;
	readonly foregroundHandoffIdentity: StructuredSubagentForegroundHandoffIdentityV1;
	readonly settleDetached: OrdinaryTransientTaskLifecycleRunV1["settleDetached"];
	readonly abortBeforeRegistration: OrdinaryTransientTaskLifecycleRunV1["abortBeforeRegistration"];
}

/** Assemble one frozen runtime exclusively through the session-owned ordinary lifecycle. */
export async function createStructuredSubagentTransientTaskRuntimeV1(
	options: StructuredSubagentTransientTaskRuntimeCreateOptionsV1,
): Promise<StructuredSubagentTransientTaskRuntimeAssemblyV1> {
	const preflight = preflightTransientTaskResultlessRepresentabilityV1(
		options.spawnIndex,
		options.childId,
		options.agentName,
		MAX_OUTPUT_BYTES,
	);
	if (preflight.status !== "accepted") throw new StructuredSubagentError("preflight", preflight.toolResultText);

	const executionEnvironmentProvider = options.authority.executionEnvironmentProvider;
	if (
		executionEnvironmentProvider === null ||
		typeof executionEnvironmentProvider !== "object" ||
		typeof executionEnvironmentProvider.acquire !== "function"
	) {
		throw new StructuredSubagentError(
			"preflight",
			"Transient task execution requires the exact caller-acquired execution environment provider.",
		);
	}

	const lifecycle = await options.authority.stores.ordinaryTransientTaskLifecycle.create({
		parentToolCallId: options.parentToolCallId,
		spawnIndex: options.spawnIndex,
		detachedJobId: options.detachedJobId,
		resultlessPreflight: preflight.preflight,
		captureMode: options.captureMode,
		applyChanges: options.applyChanges,
	});
	const runtime: StructuredSubagentTransientTaskRuntimeV1 = validateTransientTaskRuntimeInjectionV1(
		Object.freeze({
			taskId: lifecycle.taskId,
			runId: lifecycle.runId,
			createId: lifecycle.createId,
			executionEnvironmentProvider,
			materializer: lifecycle.materializer,
			ensureRequest: lifecycle.ensureRequest,
			initializePrePendingRequest: lifecycle.initializePrePendingRequest,
			fail: (input: Parameters<OrdinaryTransientTaskLifecycleRunV1["fail"]>[0]) => lifecycle.fail(input),
			finalized: (input: Parameters<OrdinaryTransientTaskLifecycleRunV1["finalized"]>[0]) =>
				lifecycle.finalized(input),
			isolationReady: (cleanupDescriptor: Parameters<OrdinaryTransientTaskLifecycleRunV1["isolationReady"]>[0]) =>
				lifecycle.isolationReady(cleanupDescriptor),
			releaseExecutionEnvironment: (
				authority: Parameters<OrdinaryTransientTaskLifecycleRunV1["releaseExecutionEnvironment"]>[0],
			) => lifecycle.releaseExecutionEnvironment(authority),
			finalizeAfterPending: (input: Parameters<OrdinaryTransientTaskLifecycleRunV1["finalizeAfterPending"]>[0]) =>
				lifecycle.finalizeAfterPending(input),
		}),
	);
	const abortBeforeRegistration: OrdinaryTransientTaskLifecycleRunV1["abortBeforeRegistration"] = reason =>
		lifecycle.abortBeforeRegistration(reason);
	const settleDetached: OrdinaryTransientTaskLifecycleRunV1["settleDetached"] = input =>
		lifecycle.settleDetached(input);
	const foregroundHandoffIdentity: StructuredSubagentForegroundHandoffIdentityV1 = Object.freeze({
		resultTargetKey: lifecycle.initializePrePendingRequest.plan.resultTargetKey,
		effectIdentityManifest: lifecycle.effectIdentityManifest,
	});
	return Object.freeze({ runtime, foregroundHandoffIdentity, abortBeforeRegistration, settleDetached });
}

/** Identity and presentation metadata supplied by the calling surface. */
export interface StructuredSubagentIdentity {
	/** A previously reserved output/registry id. */
	id?: string;
	/** Stable user-facing label used when allocating a new id. */
	label?: string;
}

/** One normalized child invocation. */
export interface StructuredSubagentRequest {
	session: ToolSession;
	invocationKind: "task" | "eval";
	assignment: string;
	context?: string;
	agent?: string;
	/** Select the execution substrate. Only explicit environment-backed task requests are restricted below. */
	execution?: "local" | "environment";
	model?: string | string[];
	/** Presence, rather than truthiness, makes this the highest-priority schema. */
	outputSchema?: unknown;
	schemaMode?: StructuredSubagentSchemaMode;
	/** Per-spawn thinking effort mapped onto the resolved model's supported range; overrides the agent's default selector. */
	effort?: TaskEffort;
	identity?: StructuredSubagentIdentity;
	index?: number;
	parentToolCallId?: string;
	detached?: boolean;
	invokedAt?: number;
	acquiredAt?: number;
	isolation?: StructuredSubagentIsolationControls;
	/** The parent agent name forbidden from recursively spawning itself. */
	blockedAgent?: string;
	/** Preserve a completed temporary artifacts directory for an agent:// handle. */
	retainArtifacts?: boolean;
	/** Task UI agents keep live registry references; eval one-shots normally do not. */
	keepAlive?: boolean;
	/** Task subagents share their parent's eval kernel; eval bridge children must not. */
	shareEvalSession?: boolean;
	/** Task frontends may inherit LSP; eval frontends normally set this false. */
	enableLsp?: boolean;
	/** Explicitly pass false for plan mode or invocation kinds that must not use IRC. */
	enableIrc?: boolean;
	/** `0` disables executor wall-clock timeout. Undefined inherits settings. */
	maxRuntimeMs?: number;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	/** Exact durable task/run/store authority; never derived from ToolSession or agent id. */
	transientTaskRuntime?: StructuredSubagentTransientTaskRuntimeV1;
}

/** A normalized preflight result, reusable by tests and adapters. */
export interface EffectiveSubagentPolicy {
	discovery: DiscoveryResult;
	agentName: string;
	agent: AgentDefinition;
	effectiveAgent: AgentDefinition;
	execution: "local" | "environment";
	modelOverride?: string | string[];
	parentActiveModelPattern?: string;
	schema: StructuredSubagentSchemaResolution;
	planMode: boolean;
	isIsolated: boolean;
	mergeMode: "patch" | "branch";
	applyChanges: boolean;
	runtimeProfile: SubagentRuntimeProfile;
}

/** Settled child execution plus data needed by the frontends' own rendering. */
export interface StructuredSubagentResult {
	result: SingleResult;
	policy: EffectiveSubagentPolicy;
	mergeSummary: string;
	changesApplied: boolean | null;
	/** @internal Exact validated evidence retained only for sealed parent settlement. */
	terminalEvidence?: TransientTaskPostTerminalCleanupEvidenceV1;
	artifactsDir: string;
	temporaryArtifacts: boolean;
}

const PLAN_MODE_TOOLS = ["read", "grep", "glob", "web_search"] as const;

function renderSubagentPrompt(assignment: string): string {
	return prompt.render(subagentUserPromptTemplate, { assignment: assignment.trim() });
}

function trimToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

function sanitizeAgentId(value: string | undefined): string | undefined {
	const trimmed = trimToUndefined(value);
	const sanitized = trimmed?.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
	return sanitized || undefined;
}

function resolveSchema(request: StructuredSubagentRequest, agent: AgentDefinition): StructuredSubagentSchemaResolution {
	const mode = request.schemaMode ?? request.session.outputSchemaMode ?? "permissive";
	if (Object.hasOwn(request, "outputSchema")) {
		return { schema: request.outputSchema, source: "caller", mode, outputSchemaOverridesAgent: true };
	}
	if (agent.output !== undefined) {
		return { schema: agent.output, source: "agent", mode, outputSchemaOverridesAgent: false };
	}
	if (request.session.outputSchema !== undefined) {
		return { schema: request.session.outputSchema, source: "session", mode, outputSchemaOverridesAgent: false };
	}
	return { schema: undefined, source: "none", mode, outputSchemaOverridesAgent: false };
}

function createPlanModeAgent(agent: AgentDefinition): AgentDefinition {
	const tools = [...PLAN_MODE_TOOLS, ...(agent.tools ?? []).filter(tool => tool === "ast_grep")];
	return {
		...agent,
		systemPrompt: `${planModeSubagentPrompt}\n\n${agent.systemPrompt}`,
		tools,
		spawns: undefined,
		prewalk: undefined,
	};
}

function createEnvironmentAgent(agent: AgentDefinition): AgentDefinition {
	const profile = ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE;
	return {
		...agent,
		tools: resolveSubagentRuntimeToolNames(profile, agent.tools) ?? [],
		spawns: subagentRuntimeAllows(profile, "spawns") ? agent.spawns : undefined,
		prewalk: subagentRuntimeAllows(profile, "prewalk") ? agent.prewalk : undefined,
	};
}

function assertPlanControlsAllowed(request: StructuredSubagentRequest, planMode: boolean): void {
	if (!planMode) return;
	const isolation = request.isolation;
	if (
		isolation &&
		(Object.hasOwn(isolation, "requested") || Object.hasOwn(isolation, "apply") || Object.hasOwn(isolation, "merge"))
	) {
		throw new StructuredSubagentError(
			"preflight",
			"Subagent isolation, apply, and merge controls are unavailable in plan mode.",
		);
	}
}

function assertDepthAndSpawnAllowed(request: StructuredSubagentRequest, agentName: string): void {
	const taskDepth = request.session.taskDepth ?? 0;
	const maxDepth = request.session.settings.get("task.maxRecursionDepth") ?? 2;
	if (!canSpawnAtDepth(maxDepth, taskDepth)) {
		throw new StructuredSubagentError(
			"preflight",
			`Cannot spawn another agent at task depth ${taskDepth}; maximum depth is ${maxDepth}.`,
		);
	}
	const blockedAgent = request.blockedAgent ?? $env.PI_BLOCKED_AGENT;
	if (blockedAgent && blockedAgent === agentName) {
		throw new StructuredSubagentError(
			"preflight",
			`Cannot spawn ${blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`,
		);
	}
	const spawnPolicy = resolveSpawnPolicy(request.session.getSessionSpawns());
	if (!spawnPolicy.enabled || (spawnPolicy.allowedAgents !== null && !spawnPolicy.allowedAgents.includes(agentName))) {
		throw new StructuredSubagentError(
			"preflight",
			`Cannot spawn '${agentName}'. Allowed: ${spawnPolicy.allowedErrorText}`,
		);
	}
}

/**
 * Resolve every policy shared by task and eval before allocating artifacts or
 * dispatching work. Callers translate {@link StructuredSubagentError} into
 * their own wire-level error surface.
 */
export async function resolveEffectiveSubagentPolicy(
	request: StructuredSubagentRequest,
): Promise<EffectiveSubagentPolicy> {
	const spawnPolicy = resolveSpawnPolicy(request.session.getSessionSpawns());
	const agentName = request.agent?.trim() || spawnPolicy.defaultAgent;
	const planMode = request.session.getPlanModeState?.()?.enabled === true;
	const execution = request.execution ?? "local";
	if (execution !== "local" && execution !== "environment") {
		throw new StructuredSubagentError(
			"preflight",
			`Unsupported subagent execution selection ${JSON.stringify(execution)}. Use "local" or "environment".`,
		);
	}
	if (execution === "environment") {
		if (request.invocationKind !== "task") {
			throw new StructuredSubagentError("preflight", "Environment execution is only available to task invocations.");
		}
		if (planMode) {
			throw new StructuredSubagentError("preflight", "Environment execution is unavailable in plan mode.");
		}
		if (request.isolation?.requested !== true) {
			throw new StructuredSubagentError(
				"preflight",
				"Environment execution requires explicit `isolated: true` on the task request.",
			);
		}
		const taskDepth = request.session.taskDepth ?? 0;
		if (taskDepth !== 0) {
			throw new StructuredSubagentError(
				"preflight",
				`Environment execution is only available at task depth 0; current depth is ${taskDepth}.`,
			);
		}
		if (request.detached === true) {
			throw new StructuredSubagentError("preflight", "Environment execution must be blocking, not detached.");
		}
	}
	assertPlanControlsAllowed(request, planMode);
	assertDepthAndSpawnAllowed(request, agentName);

	const discovery = await discoverAgents(request.session.cwd);
	const agent = getAgent(discovery.agents, agentName);
	if (!agent) {
		const available = discovery.agents.map(candidate => candidate.name).join(", ") || "none";
		throw new StructuredSubagentError("preflight", `Unknown agent "${agentName}". Available: ${available}`);
	}
	const disabledAgents = request.session.settings.get("task.disabledAgents") as string[];
	if (disabledAgents.includes(agentName)) {
		const enabled = discovery.agents
			.filter(candidate => !disabledAgents.includes(candidate.name))
			.map(candidate => candidate.name);
		throw new StructuredSubagentError(
			"preflight",
			`Agent "${agentName}" is disabled in settings. Enable it via /agents, or use a different agent type.${enabled.length > 0 ? ` Available: ${enabled.join(", ")}` : ""}`,
		);
	}

	let effectiveAgent = planMode ? createPlanModeAgent(agent) : agent;
	if (execution === "environment") {
		if (effectiveAgent.blocking !== true) {
			throw new StructuredSubagentError(
				"preflight",
				`Environment execution requires a blocking agent; "${agentName}" is nonblocking.`,
			);
		}
		effectiveAgent = createEnvironmentAgent(effectiveAgent);
	}
	const schema = resolveSchema(request, effectiveAgent);
	if (schema.source === "caller" || (schema.source !== "none" && schema.mode === "strict")) {
		const { error } = buildOutputValidator(schema.schema);
		if (error) {
			const scope =
				schema.source === "caller" ? (schema.mode === "strict" ? "strict caller" : "caller") : "strict effective";
			throw new StructuredSubagentError("preflight", `Invalid ${scope} output schema: ${error}`);
		}
	}
	const agentModelOverrides = request.session.settings.get("task.agentModelOverrides");
	const parentActiveModelPattern = request.session.getActiveModelString?.();
	const modelOverride = resolveAgentModelPatterns({
		settingsOverride: request.model ?? agentModelOverrides[agentName],
		agentModel: effectiveAgent.model,
		settings: request.session.settings,
		activeModelPattern: parentActiveModelPattern,
		fallbackModelPattern: request.session.getModelString?.(),
	});
	const isolationMode = request.session.settings.get("task.isolation.mode");
	const isIsolated = request.isolation?.requested === true;
	if (isIsolated && isolationMode === "none") {
		throw new StructuredSubagentError(
			"preflight",
			`Subagent isolated execution requires task.isolation.mode to be set; current mode is "none".`,
		);
	}
	const enableLsp =
		!planMode &&
		(request.enableLsp ?? ((request.session.enableLsp ?? true) && request.session.settings.get("task.enableLsp")));
	const enableIrc =
		!planMode &&
		(request.enableIrc ??
			(request.session.enableIrc !== false &&
				isIrcEnabled(request.session.settings, request.session.taskDepth ?? 0)));
	const runtimeProfile =
		execution === "environment"
			? ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE
			: createLocalSubagentRuntimeProfile({
					restrictToolNames: planMode || request.session.restrictToolNames === true,
					enableSpawns: !planMode,
					enableLsp,
					enableIrc,
					enableMCP: request.session.enableMCP ?? true,
					shareEvalState: request.shareEvalSession !== false,
					keepAlive: request.keepAlive !== false,
					enableRevival: !isIsolated,
				});
	return {
		discovery,
		agentName,
		agent,
		effectiveAgent,
		modelOverride,
		parentActiveModelPattern,
		schema,
		execution,
		planMode,
		isIsolated,
		mergeMode: request.isolation?.merge ?? request.session.settings.get("task.isolation.merge"),
		applyChanges:
			request.isolation?.apply ??
			(request.invocationKind === "task" ? request.session.settings.get("task.isolation.apply") : true),
		runtimeProfile,
	};
}

/** Reserve a session-global agent id only after preflight has succeeded. */
export async function reserveStructuredSubagentId(
	session: ToolSession,
	identity: StructuredSubagentIdentity | undefined,
): Promise<string> {
	if (identity?.id) return identity.id;
	const manager = session.agentOutputManager ?? new AgentOutputManager(session.getArtifactsDir ?? (() => null));
	session.agentOutputManager ??= manager;
	return manager.allocate(sanitizeAgentId(identity?.label) ?? generateTaskName());
}

interface ArtifactLease {
	sessionFile: string | null;
	artifactsDir: string;
	temporary: boolean;
	unregister: (() => void) | undefined;
}

async function leaseArtifacts(
	session: ToolSession,
	invocationKind: StructuredSubagentRequest["invocationKind"],
): Promise<ArtifactLease> {
	const sessionFile = session.getSessionFile();
	if (sessionFile) {
		const artifactsDir = sessionFile.slice(0, -6);
		await fs.mkdir(artifactsDir, { recursive: true });
		return { sessionFile, artifactsDir, temporary: false, unregister: undefined };
	}
	const artifactsDir = path.join(
		os.tmpdir(),
		`${invocationKind === "eval" ? "omp-eval-agent" : "omp-task"}-${Snowflake.next()}`,
	);
	await fs.mkdir(artifactsDir, { recursive: true });
	return { sessionFile: null, artifactsDir, temporary: true, unregister: registerArtifactsDir(artifactsDir) };
}

function resolveAutoloadSkills(session: ToolSession, agent: AgentDefinition) {
	const skills = [...(session.skills ?? [])];
	const autoloadSkills = agent.autoloadSkills?.length
		? agent.autoloadSkills.map(name => skills.find(skill => skill.name === name)).filter(skill => skill !== undefined)
		: [];
	return { skills, autoloadSkills };
}

function buildExecutorOptions(
	request: StructuredSubagentRequest,
	policy: EffectiveSubagentPolicy,
	lease: ArtifactLease,
	id: string,
	transientRuntime: StructuredSubagentTransientTaskRuntimeV1 | undefined,
): ExecutorOptions {
	const { session } = request;
	const { skills, autoloadSkills } = resolveAutoloadSkills(session, policy.effectiveAgent);
	const localProtocolOptions: LocalProtocolOptions = session.localProtocolOptions ?? {
		getArtifactsDir: session.getArtifactsDir ?? (() => null),
		getSessionId: session.getSessionId ?? (() => null),
	};
	const runtimeProfile = policy.runtimeProfile;
	const enableMCP = subagentRuntimeAllows(runtimeProfile, "mcp");
	return {
		cwd: session.cwd,
		additionalDirectories: session.additionalDirectories,
		getApiKey: session.getApiKey,
		agent: policy.effectiveAgent,
		task: renderSubagentPrompt(request.assignment),
		assignment: request.assignment.trim(),
		context: request.context?.trim() || undefined,
		planReference: undefined,
		description: trimToUndefined(request.identity?.label),
		index: request.index ?? 0,
		parentToolCallId: request.parentToolCallId,
		detached: request.detached,
		id,
		taskDepth: session.taskDepth ?? 0,
		invokedAt: request.invokedAt,
		acquiredAt: request.acquiredAt,
		modelOverride: policy.modelOverride,
		parentActiveModelPattern: policy.parentActiveModelPattern,
		thinkingLevel: policy.effectiveAgent.thinkingLevel,
		effort: request.effort,
		...(policy.schema.source === "none"
			? {}
			: {
					outputSchemaSource: policy.schema.source,
					outputSchema: policy.schema.schema,
					outputSchemaOverridesAgent: policy.schema.outputSchemaOverridesAgent,
					outputSchemaMode: policy.schema.mode,
				}),
		sessionFile: lease.sessionFile,
		persistArtifacts: !lease.temporary,
		artifactsDir: lease.artifactsDir,
		runtimeProfile,
		transientTaskCurrentParentTaskLocator: transientRuntime
			? (Object.freeze({
					taskId: transientRuntime.taskId,
					runId: transientRuntime.runId,
					createId: transientRuntime.createId,
				}) satisfies AgentSessionTransientTaskCurrentParentLocatorV1)
			: undefined,
		maxRuntimeMs: request.maxRuntimeMs,
		signal: request.signal,
		eventBus: session.eventBus,
		onProgress: request.onProgress,
		authStorage: session.authStorage,
		modelRegistry: session.modelRegistry,
		settings: session.settings,
		mcpManager: enableMCP ? (session.mcpManager ?? MCPManager.instance()) : undefined,
		contextFiles: session.contextFiles?.filter(file => path.basename(file.path).toLowerCase() !== "agents.md"),
		skills,
		autoloadSkills,
		workspaceTree: session.workspaceTree,
		promptTemplates: session.promptTemplates,
		rules: session.rules,
		preloadedExtensionPaths: subagentRuntimeAllows(runtimeProfile, "extensions") ? session.extensionPaths : [],
		preloadedCustomToolPaths: subagentRuntimeAllows(runtimeProfile, "customTools") ? session.customToolPaths : [],
		localProtocolOptions,
		parentArtifactManager: session.getArtifactManager?.() ?? undefined,
		parentHindsightSessionState: session.getHindsightSessionState?.(),
		parentMnemopiSessionState: session.getMnemopiSessionState?.(),
		parentTelemetry: session.getTelemetry?.(),
		parentEvalSessionId: subagentRuntimeAllows(runtimeProfile, "sharedEvalState")
			? (session.getEvalSessionId?.() ?? undefined)
			: undefined,
		parentAgentId: session.getAgentId?.() ?? MAIN_AGENT_ID,
		parentServiceTier: session.getServiceTierByFamily ? (session.getServiceTierByFamily() ?? null) : undefined,
	};
}

async function loadPlanReference(
	request: StructuredSubagentRequest,
	policy: EffectiveSubagentPolicy,
): Promise<{ path: string; content: string } | undefined> {
	if (policy.planMode) return undefined;
	const localProtocolOptions: LocalProtocolOptions = request.session.localProtocolOptions ?? {
		getArtifactsDir: request.session.getArtifactsDir ?? (() => null),
		getSessionId: request.session.getSessionId ?? (() => null),
	};
	return loadOverallPlanReference(request.session.getPlanReferencePath?.() ?? "local://PLAN.md", localProtocolOptions);
}

async function persistNestedPatches(
	artifactsDir: string,
	agentId: string,
	nestedPatches: NestedRepoPatch[],
): Promise<string[]> {
	const saved: string[] = [];
	for (const [index, nestedPatch] of nestedPatches.entries()) {
		const destination = path.join(
			artifactsDir,
			`${agentId}.nested-${index}-${nestedPatch.relativePath.replace(/[^a-zA-Z0-9._-]/g, "_") || "root"}.patch`,
		);
		try {
			await fs.writeFile(destination, nestedPatch.patch);
			saved.push(destination);
		} catch {}
	}
	return saved;
}

async function isolationRecoveryHint(result: SingleResult, artifactsDir: string): Promise<string> {
	const hints: string[] = [];
	if (result.patchPath) hints.push(`Captured patch preserved at ${result.patchPath}.`);
	for (const nestedPath of await persistNestedPatches(artifactsDir, result.id, result.nestedPatches ?? [])) {
		hints.push(`Captured nested patch preserved at ${nestedPath}.`);
	}
	if (result.branchName) hints.push(`Captured branch preserved as ${result.branchName}.`);
	return hints.length > 0 ? ` ${hints.join(" ")}` : "";
}

function attachStructuredOutputMetadata(result: SingleResult, schema: StructuredSubagentSchemaResolution): void {
	if (Object.isFrozen(result)) return;
	if (schema.source === "none") {
		delete result.structuredOutput;
		return;
	}
	if (result.structuredOutput) return;
	let fallbackData: unknown = result.output;
	try {
		fallbackData = JSON.parse(result.output);
	} catch {}
	const output: StructuredSubagentOutput = {
		source: schema.source,
		mode: schema.mode,
		status: result.exitCode === 0 ? "valid" : "invalid",
		data: fallbackData,
		...(result.error ? { error: result.error } : {}),
	};
	result.structuredOutput = output;
}

function exactJson(left: unknown, right: unknown): boolean {
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

async function settlePreExecutionCancellationV1(
	request: StructuredSubagentRequest,
	runtime: StructuredSubagentTransientTaskRuntimeV1,
): Promise<never> {
	const error = new StructuredSubagentError("execution", "Transient task was interrupted before child execution.");
	const terminal = await runtime.fail({
		phase: "before_bind",
		source: request.detached
			? { kind: "detached_pre_execution_abort" }
			: { kind: "controller_interrupted_before_cleanup" },
	});
	throw new StructuredSubagentLifecycleFailure(error, {
		result: null,
		terminalProjection: terminal.terminalSource,
		mergeSummary: terminal.mergeSummary,
		changesApplied: terminal.changesApplied,
		terminalEvidence: terminal.terminalEvidence,
	});
}

/** Internal terminalized failure carrying exact evidence to the detached settlement adapter. */
export class StructuredSubagentLifecycleFailure extends StructuredSubagentError {
	readonly result: SingleResult | null;
	readonly terminalProjection: TransientTaskResultlessTerminalProjectionV1 | null;
	readonly mergeSummary: string;
	readonly changesApplied: boolean | null;
	readonly terminalEvidence: TransientTaskPostTerminalCleanupEvidenceV1;

	constructor(
		error: unknown,
		terminal: {
			readonly result: SingleResult | null;
			readonly terminalProjection: TransientTaskResultlessTerminalProjectionV1 | null;
			readonly mergeSummary: string;
			readonly changesApplied: boolean | null;
			readonly terminalEvidence: TransientTaskPostTerminalCleanupEvidenceV1;
		},
	) {
		super(
			error instanceof StructuredSubagentError ? error.kind : "execution",
			error instanceof Error ? error.message : "Subagent execution failed before child dispatch.",
			{ cause: error },
		);
		this.name = "StructuredSubagentLifecycleFailure";
		this.result = terminal.result;
		this.terminalProjection = terminal.terminalProjection;
		this.mergeSummary = terminal.mergeSummary;
		this.changesApplied = terminal.changesApplied;
		this.terminalEvidence = terminal.terminalEvidence;
	}
}

/**
 * Execute a validated subagent. Preflight errors occur before any artifact
 * lease or child dispatch; callers keep responsibility for their result text.
 */
export async function runStructuredSubagent(request: StructuredSubagentRequest): Promise<StructuredSubagentResult> {
	const injectedRuntime = request.transientTaskRuntime;
	let transientRuntime: StructuredSubagentTransientTaskRuntimeV1 | undefined;
	if (injectedRuntime) {
		try {
			transientRuntime = validateTransientTaskRuntimeInjectionV1(injectedRuntime);
		} catch (error) {
			throw new StructuredSubagentError(
				"preflight",
				`Invalid transient task runtime: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}
	const failBeforeBind = async (error: unknown): Promise<never> => {
		if (!transientRuntime) throw error;
		const terminal = await transientRuntime.fail({
			phase: "before_bind",
			source: { kind: "caught_value", caughtAt: "runtime", value: error },
		});
		throw new StructuredSubagentLifecycleFailure(error, {
			result: null,
			terminalProjection: terminal.terminalSource,
			mergeSummary: terminal.mergeSummary,
			changesApplied: terminal.changesApplied,
			terminalEvidence: terminal.terminalEvidence,
		});
	};
	const policy = await resolveEffectiveSubagentPolicy(request).catch(error => failBeforeBind(error));
	if (transientRuntime && !policy.isIsolated) {
		await failBeforeBind(
			new StructuredSubagentError(
				"preflight",
				"Durable transient-task execution requires isolated workspace authority.",
			),
		);
	}
	if (policy.isIsolated && !transientRuntime) {
		throw new StructuredSubagentError(
			"preflight",
			"Isolated subagent execution requires exact taskId/runId/createId authority and the claimed transient-task runtime contract.",
		);
	}
	const executionEnvironmentProvider =
		policy.execution === "environment" ? transientRuntime?.executionEnvironmentProvider : undefined;
	if (policy.execution === "environment" && !executionEnvironmentProvider) {
		await failBeforeBind(
			new StructuredSubagentError(
				"preflight",
				"Environment execution requires the exact caller-acquired transient runtime authority.",
			),
		);
	}

	const id = await reserveStructuredSubagentId(request.session, {
		...request.identity,
		label: request.identity?.label ?? (request.invocationKind === "eval" ? "EvalAgent" : undefined),
	}).catch(error =>
		failBeforeBind(
			error instanceof StructuredSubagentError
				? error
				: new StructuredSubagentError(
						"execution",
						`Subagent execution failed: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					),
		),
	);

	let resultlessRepresentabilityPreflight: TransientTaskResultlessRepresentabilityPreflightV1 | undefined;
	let outcomePayloadBudget: TransientTaskOutcomePayloadByteBudgetV1 | undefined;
	if (transientRuntime) {
		const descriptor = transientRuntime.ensureRequest.preparation.creatorDescriptor;
		const plan = transientRuntime.initializePrePendingRequest.plan;
		const preflightResult = preflightTransientTaskResultlessRepresentabilityV1(
			request.index ?? 0,
			id,
			policy.agent.name,
			plan.maximumUtf8ByteLength,
		);
		const preflight =
			preflightResult.status === "accepted"
				? preflightResult.preflight
				: await failBeforeBind(new StructuredSubagentError("preflight", preflightResult.toolResultText));
		if (
			transientRuntime.taskId !== descriptor.taskId ||
			transientRuntime.runId !== descriptor.runId ||
			transientRuntime.createId !== descriptor.createId ||
			plan.resultTargetKey.taskId !== transientRuntime.taskId ||
			plan.resultTargetKey.runId !== transientRuntime.runId ||
			plan.resultTargetKey.createId !== transientRuntime.createId ||
			plan.resultlessIdentity.index !== (request.index ?? 0) ||
			plan.resultlessIdentity.id !== id ||
			plan.resultlessIdentity.agent !== policy.agent.name ||
			!exactJson(plan.representabilityPreflight, preflight)
		) {
			await failBeforeBind(
				new StructuredSubagentError(
					"preflight",
					"Transient task identity does not match the prepared runtime authority.",
				),
			);
		}
		try {
			outcomePayloadBudget = createTransientTaskOutcomePayloadByteBudgetV1({
				preflight,
				agentSource: policy.agent.source,
				task: renderSubagentPrompt(request.assignment),
				assignment: request.assignment.trim(),
				...(policy.modelOverride !== undefined ? { modelOverride: policy.modelOverride } : {}),
			});
		} catch (error) {
			await failBeforeBind(error);
		}
		resultlessRepresentabilityPreflight = preflight;
		if (request.signal?.aborted) await settlePreExecutionCancellationV1(request, transientRuntime);
	}

	const lease = await leaseArtifacts(request.session, request.invocationKind).catch(async error => {
		if (transientRuntime && request.signal?.aborted) {
			await settlePreExecutionCancellationV1(request, transientRuntime);
		}
		return failBeforeBind(
			new StructuredSubagentError(
				"execution",
				`Subagent artifact allocation failed: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			),
		);
	});
	let changesApplied: boolean | null = null;
	let mergeSummary = "";
	let terminalEvidence: TransientTaskPostTerminalCleanupEvidenceV1 | undefined;
	let requiresRecoveryArtifacts = false;
	let completedSuccessfully = false;
	let transientLifecycleDispatchStarted = false;
	try {
		if (transientRuntime && request.signal?.aborted) {
			await settlePreExecutionCancellationV1(request, transientRuntime);
		}
		const baseOptions = buildExecutorOptions(request, policy, lease, id, transientRuntime);
		try {
			baseOptions.planReference = await loadPlanReference(request, policy);
		} catch (error) {
			if (transientRuntime && request.signal?.aborted) {
				await settlePreExecutionCancellationV1(request, transientRuntime);
			}
			throw error;
		}
		if (transientRuntime && request.signal?.aborted) {
			await settlePreExecutionCancellationV1(request, transientRuntime);
		}
		let result: SingleResult;
		if (!policy.isIsolated) {
			result = await runSubprocess(baseOptions);
		} else if (transientRuntime && resultlessRepresentabilityPreflight && outcomePayloadBudget) {
			transientLifecycleDispatchStarted = true;
			const settlement = await runIsolatedSubprocess({
				baseOptions,
				lifecycle: transientRuntime,
				resultlessRepresentabilityPreflight,
				outcomePayloadBudget,
				...(executionEnvironmentProvider ? { executionEnvironmentProvider } : {}),
			});
			mergeSummary = settlement.mergeSummary;
			changesApplied = settlement.changesApplied;
			terminalEvidence = settlement.terminalEvidence;
			if (settlement.result === null) {
				throw new StructuredSubagentLifecycleFailure(settlement.error, {
					result: null,
					terminalProjection: settlement.terminalProjection,
					mergeSummary,
					changesApplied,
					terminalEvidence,
				});
			}
			result = settlement.result;
		} else {
			throw new StructuredSubagentError(
				"preflight",
				"Isolated subagent execution requires exact taskId/runId/createId authority and the claimed transient-task runtime contract.",
			);
		}
		attachStructuredOutputMetadata(result, policy.schema);
		requiresRecoveryArtifacts =
			policy.isIsolated &&
			(result.exitCode !== 0 || result.error !== undefined || result.aborted === true) &&
			(result.patchPath !== undefined || result.branchName !== undefined || (result.nestedPatches?.length ?? 0) > 0);
		completedSuccessfully = result.exitCode === 0 && !result.error && !result.aborted;
		return {
			result,
			policy,
			mergeSummary,
			terminalEvidence,
			changesApplied,
			artifactsDir: lease.artifactsDir,
			temporaryArtifacts: lease.temporary,
		};
	} catch (error) {
		if (error instanceof StructuredSubagentLifecycleFailure) throw error;
		const structuredError =
			error instanceof StructuredSubagentError
				? error
				: new StructuredSubagentError(
						"execution",
						`Subagent execution failed: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					);
		if (transientRuntime && !transientLifecycleDispatchStarted) await failBeforeBind(structuredError);
		throw structuredError;
	} finally {
		const shouldRetainArtifacts =
			(request.retainArtifacts && completedSuccessfully) ||
			(policy.isIsolated && (!policy.applyChanges || changesApplied === false || requiresRecoveryArtifacts));
		const shouldCleanup = lease.temporary && !shouldRetainArtifacts;
		if (shouldCleanup) {
			try {
				await fs.rm(lease.artifactsDir, { recursive: true, force: true });
			} catch {
				// Durable terminal recovery owns cleanup truth; incidental artifact removal cannot replace it.
			} finally {
				lease.unregister?.();
			}
		}
	}
}

/** Build the recovery suffix used by adapters after an isolated failure. */
export async function buildStructuredSubagentRecoveryHint(result: SingleResult, artifactsDir: string): Promise<string> {
	return isolationRecoveryHint(result, artifactsDir);
}
