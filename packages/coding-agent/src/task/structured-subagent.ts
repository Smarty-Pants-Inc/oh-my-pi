/**
 * Shared policy resolution and execution for task and eval subagents.
 *
 * The two public frontends deliberately retain their presentation concerns, but
 * every decision that affects what a child may run lives here.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { $env, Snowflake } from "@oh-my-pi/pi-utils";
import {
	type AgentModelSelectionSource,
	getModelMatchPreferences,
	normalizeModelPatternList,
	resolveAgentModelSelectionWithSource,
	resolveAllowedModels,
	resolveConfiguredModelPatterns,
	resolveModelOverride,
	resolveModelPolicyModels,
} from "../config/model-resolver";
import type { LocalProtocolOptions } from "../internal-urls";
import { registerArtifactsDir } from "../internal-urls/registry-helpers";
import { MCPManager } from "../mcp/manager";
import { loadOverallPlanReference } from "../plan-mode/plan-handoff";
import planModeSubagentPrompt from "../prompts/system/plan-mode-subagent.md" with { type: "text" };
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { ExecutionEnvironmentProvider } from "../session/execution-environment";
import type { TaskEffort } from "../thinking";
import type { ToolSession } from "../tools";
import { isIrcEnabled } from "../tools/hub";
import { buildOutputValidator } from "../tools/output-schema-validator";
import { trackLateCleanup } from "../utils/late-cleanup";
import { type DiscoveryResult, discoverAgents, getAgent } from "./discovery";
import { type ExecutorOptions, runSubprocess } from "./executor";
import {
	applyEligibleNestedPatches,
	type IsolationContext,
	makeIsolationCommitMessage,
	mergeIsolatedChanges,
	prepareIsolationContext,
	runIsolatedSubprocess,
} from "./isolation-runner";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager } from "./output-manager";
import {
	createLocalSubagentRuntimeProfile,
	ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE,
	resolveSubagentRuntimeToolNames,
	type SubagentRuntimeProfile,
	subagentRuntimeAllows,
} from "./runtime-profile";
import { resolveSpawnPolicy } from "./spawn-policy";
import {
	type AgentDefinition,
	type AgentProgress,
	canSpawnAtDepth,
	type SingleResult,
	type StructuredSubagentOutput,
} from "./types";
import { type NestedRepoPatch, parseIsolationMode } from "./worktree";

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
}

/** A normalized preflight result, reusable by tests and adapters. */
export interface EffectiveSubagentPolicy {
	discovery: DiscoveryResult;
	agentName: string;
	agent: AgentDefinition;
	effectiveAgent: AgentDefinition;
	execution: "local" | "environment";
	executionEnvironmentProvider?: ExecutionEnvironmentProvider;
	modelOverride?: string | string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	/** Precedence source for the effective model patterns. */
	modelSelectionSource: AgentModelSelectionSource;
	/** True when a caller, settings override, or agent definition selected the patterns. */
	modelSelectionExplicit: boolean;
	/** Models allowed by the active path-scoped policy, when a registry is available. */
	allowedModels?: Model<Api>[];
	/** Policy-visible models used to validate explicit selectors, including providers without credentials. */
	modelCandidates?: Model<Api>[];
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
	artifactsDir: string;
	temporaryArtifacts: boolean;
}

/** Machine-readable failure category so adapters can retain their native errors. */
export class StructuredSubagentError extends Error {
	readonly kind: "preflight" | "isolation" | "execution";

	constructor(kind: "preflight" | "isolation" | "execution", message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "StructuredSubagentError";
		this.kind = kind;
	}
}

const PLAN_MODE_TOOLS = ["read", "grep", "glob", "web_search"] as const;

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
	await request.session.settings.reloadFromDisk();
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
	let executionEnvironmentProvider: ExecutionEnvironmentProvider | undefined;
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
		executionEnvironmentProvider = request.session.getExecutionEnvironmentProvider?.();
		if (!executionEnvironmentProvider) {
			throw new StructuredSubagentError(
				"preflight",
				"Environment execution requires a registered execution environment provider.",
			);
		}
	}
	assertPlanControlsAllowed(request, planMode);
	assertDepthAndSpawnAllowed(request, agentName);

	const discovery = await discoverAgents(request.session.cwd, undefined, request.session.effectiveExtensionRoots?.());
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
	const hasRequestModel = request.model !== undefined;
	const requestSelectors = normalizeModelPatternList(request.model);
	if (hasRequestModel && requestSelectors.length === 0) {
		throw new StructuredSubagentError(
			"preflight",
			"The requested subagent `model` selector is empty. Use a model string or ordered list of model strings.",
		);
	}
	const configuredRequestPatterns = resolveConfiguredModelPatterns(request.model, request.session.settings);
	if (hasRequestModel && configuredRequestPatterns.length === 0) {
		throw new StructuredSubagentError(
			"preflight",
			`The requested subagent model ${JSON.stringify(request.model)} does not resolve to a configured model selector.`,
		);
	}
	const parentActiveModelPattern = request.session.getActiveModelString?.();
	const modelResolution = {
		requestModel: request.model,
		settingsOverride: agentModelOverrides[agentName],
		agentModel: effectiveAgent.model,
		settings: request.session.settings,
		activeModelPattern: parentActiveModelPattern,
		fallbackModelPattern: request.session.getModelString?.(),
	};
	// Role identity and patterns come from one call so they cannot be derived
	// from different sources: the expansion below discards the alias, and the
	// child's inherited retry-fallback chain is keyed off the role.
	const {
		patterns: modelOverride,
		role: modelRole,
		source: modelSelectionSource,
	} = resolveAgentModelSelectionWithSource(modelResolution);
	const modelSelectionExplicit = modelSelectionSource !== "session";
	const modelRegistry = request.session.modelRegistry;
	let allowedModels: Model<Api>[] | undefined;
	let modelCandidates: Model<Api>[] | undefined;
	if (modelRegistry) {
		await modelRegistry.awaitBackgroundRefresh?.();
		allowedModels = await resolveAllowedModels(
			modelRegistry,
			request.session.settings,
			getModelMatchPreferences(request.session.settings),
		);
		modelCandidates = resolveModelPolicyModels(modelRegistry, request.session.settings);
		if (modelOverride.length > 0) {
			const resolved = resolveModelOverride(modelOverride, modelRegistry, request.session.settings, modelCandidates);
			if (!resolved.model) {
				const scope =
					request.session.settings.get("enabledModels").length > 0 ? " within the active enabledModels scope" : "";
				throw new StructuredSubagentError(
					"preflight",
					`Subagent model selector${scope} did not resolve to an available model: ${modelOverride.join(", ")}`,
				);
			}
		} else if (allowedModels.length === 0) {
			throw new StructuredSubagentError(
				"preflight",
				"No available subagent model satisfies the active model policy.",
			);
		}
	}
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
		modelRole,
		modelSelectionSource,
		modelSelectionExplicit,
		...(allowedModels ? { allowedModels } : {}),
		...(modelCandidates ? { modelCandidates } : {}),
		parentActiveModelPattern,
		schema,
		execution,
		...(executionEnvironmentProvider ? { executionEnvironmentProvider } : {}),
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
		task: request.assignment.trim(),
		assignment: request.assignment.trim(),
		context: request.context?.trim() || undefined,
		planReference: undefined,
		// Task `name` is the spawn handle (id allocation). Eval `label` is a
		// real UI description. Copy it only for eval so generateTaskLabel can run.
		description: request.invocationKind === "eval" ? trimToUndefined(request.identity?.label) : undefined,
		index: request.index ?? 0,
		parentToolCallId: request.parentToolCallId,
		detached: request.detached,
		id,
		taskDepth: session.taskDepth ?? 0,
		invokedAt: request.invokedAt,
		acquiredAt: request.acquiredAt,
		modelOverride: policy.modelOverride,
		modelRole: policy.modelRole,
		modelSelectionExplicit: policy.modelSelectionExplicit,
		allowedModels: policy.allowedModels,
		modelCandidates: policy.modelCandidates,
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
		maxRuntimeMs: request.maxRuntimeMs,
		signal: request.signal,
		eventBus: session.eventBus,
		subagentEventBus: session.subagentEventBus,
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
		// Root policy and module paths have separate jobs: the live policy drives
		// recursive sub-discovery; preloaded paths only avoid re-scanning/reusing
		// parent-bound extension instances while constructing the child.
		extensionRoots: session.effectiveExtensionRoots?.bind(session),
		preloadedExtensionPaths: subagentRuntimeAllows(runtimeProfile, "extensions") ? session.extensionPaths : [],
		preloadedPreparedExtensions: subagentRuntimeAllows(runtimeProfile, "extensions")
			? session.preparedExtensions
			: [],
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

function buildFailureResult(
	request: StructuredSubagentRequest,
	policy: EffectiveSubagentPolicy,
	id: string,
	startedAt: number,
) {
	return (error: unknown): SingleResult => {
		const message = error instanceof Error ? error.message : String(error);
		return {
			index: request.index ?? 0,
			id,
			agent: policy.agent.name,
			agentSource: policy.agent.source,
			task: request.assignment.trim(),
			assignment: request.assignment.trim(),
			description: request.invocationKind === "eval" ? trimToUndefined(request.identity?.label) : undefined,
			exitCode: 1,
			output: "",
			stderr: message,
			truncated: false,
			durationMs: Date.now() - startedAt,
			tokens: 0,
			requests: 0,
			modelOverride: policy.modelOverride,
			modelRole: policy.modelRole,
			error: message,
		};
	};
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

/**
 * Execute a validated subagent. Preflight errors occur before any artifact
 * lease or child dispatch; callers keep responsibility for their result text.
 */
export async function runStructuredSubagent(request: StructuredSubagentRequest): Promise<StructuredSubagentResult> {
	const policy = await resolveEffectiveSubagentPolicy(request);
	const lease = await leaseArtifacts(request.session, request.invocationKind);
	let changesApplied: boolean | null = null;
	let mergeSummary = "";
	let requiresRecoveryArtifacts = false;
	let completedSuccessfully = false;
	let deferredCleanup: Promise<void> | undefined;
	const onSubprocessResult =
		request.invocationKind === "eval"
			? (result: SingleResult) => request.session.recordEvalSubagentUsage?.(result.usage?.output ?? 0)
			: undefined;
	try {
		const id = await reserveStructuredSubagentId(request.session, {
			...request.identity,
			label: request.identity?.label ?? (request.invocationKind === "eval" ? "EvalAgent" : undefined),
		});
		const baseOptions = buildExecutorOptions(request, policy, lease, id);
		baseOptions.onCleanupDeferred = completion => {
			deferredCleanup = completion;
		};
		baseOptions.planReference = await loadPlanReference(request, policy);
		let isolationContext: IsolationContext | null = null;
		if (policy.isIsolated) {
			try {
				isolationContext = await prepareIsolationContext(request.session.cwd);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new StructuredSubagentError(
					"isolation",
					`Isolated subagent execution could not be prepared: ${message}`,
					{ cause: error },
				);
			}
		}
		let result: SingleResult;
		if (!isolationContext) {
			result = await runSubprocess(baseOptions);
			onSubprocessResult?.(result);
		} else {
			result = await runIsolatedSubprocess({
				baseOptions,
				context: isolationContext,
				preferredBackend: parseIsolationMode(request.session.settings.get("task.isolation.mode")),
				agentId: id,
				mergeMode: policy.mergeMode,
				...(policy.executionEnvironmentProvider
					? { executionEnvironmentProvider: policy.executionEnvironmentProvider }
					: {}),
				artifactsDir: lease.artifactsDir,
				description: trimToUndefined(request.identity?.label),
				buildCommitMessage: makeIsolationCommitMessage(request.session),
				buildFailureResult: buildFailureResult(request, policy, id, Date.now()),
				onSubprocessResult,
			});
		}
		attachStructuredOutputMetadata(result, policy.schema);
		requiresRecoveryArtifacts =
			policy.isIsolated &&
			(result.exitCode !== 0 || result.error !== undefined || result.aborted === true) &&
			(result.patchPath !== undefined || result.branchName !== undefined || (result.nestedPatches?.length ?? 0) > 0);

		if (
			policy.isIsolated &&
			isolationContext &&
			policy.applyChanges &&
			result.exitCode === 0 &&
			!result.error &&
			!result.aborted
		) {
			const outcome = await mergeIsolatedChanges({
				result,
				repoRoot: isolationContext.repoRoot,
				mergeMode: policy.mergeMode,
			});
			mergeSummary = outcome.summary;
			changesApplied = outcome.changesApplied;
			if (outcome.changesApplied !== false) {
				const nestedPatchSummary = await applyEligibleNestedPatches({
					result,
					repoRoot: isolationContext.repoRoot,
					mergeMode: policy.mergeMode,
					changesApplied: outcome.changesApplied,
					mergedBranchForNestedPatches: outcome.mergedBranchForNestedPatches,
					commitMessage: makeIsolationCommitMessage(request.session)(),
				});
				mergeSummary += nestedPatchSummary;
				requiresRecoveryArtifacts ||=
					nestedPatchSummary.includes("<system-notification>") && (result.nestedPatches?.length ?? 0) > 0;
			}
		} else if (policy.isIsolated && isolationContext && !policy.applyChanges) {
			if (result.branchName)
				mergeSummary = `\n\nIsolation: changes captured on branch \`${result.branchName}\` (apply=false). Not merged.`;
			else if (result.patchPath)
				mergeSummary = `\n\nIsolation: changes captured at \`${result.patchPath}\` (apply=false). Not applied.`;
			else if ((result.nestedPatches?.length ?? 0) > 0)
				mergeSummary = `\n\nIsolation: changes captured for ${result.nestedPatches?.length} nested ${(result.nestedPatches?.length ?? 0) === 1 ? "repository" : "repositories"} (apply=false). Not applied.`;
			else mergeSummary = "\n\nIsolation: no changes captured.";
		}

		completedSuccessfully = result.exitCode === 0 && !result.error && !result.aborted;
		return {
			result,
			policy,
			mergeSummary,
			changesApplied,
			artifactsDir: lease.artifactsDir,
			temporaryArtifacts: lease.temporary,
		};
	} catch (error) {
		if (error instanceof StructuredSubagentError) throw error;
		throw new StructuredSubagentError(
			"execution",
			`Subagent execution failed: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	} finally {
		const shouldRetainArtifacts =
			(request.retainArtifacts && completedSuccessfully) ||
			(policy.isIsolated && (!policy.applyChanges || changesApplied === false || requiresRecoveryArtifacts));
		const shouldCleanup = lease.temporary && !shouldRetainArtifacts;
		if (shouldCleanup) {
			const cleanupArtifacts = async (): Promise<void> => {
				await fs.rm(lease.artifactsDir, { recursive: true, force: true });
				lease.unregister?.();
			};
			if (deferredCleanup) {
				trackLateCleanup(deferredCleanup.then(cleanupArtifacts), {
					resource: "artifacts",
					artifactsDir: lease.artifactsDir,
				});
			} else {
				await cleanupArtifacts();
			}
		}
	}
}

/** Build the recovery suffix used by adapters after an isolated failure. */
export async function buildStructuredSubagentRecoveryHint(result: SingleResult, artifactsDir: string): Promise<string> {
	return isolationRecoveryHint(result, artifactsDir);
}
