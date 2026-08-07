import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolPathWithSource } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import {
	artifactsDirsFromRegistry,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import * as planHandoff from "@oh-my-pi/pi-coding-agent/plan-mode/plan-handoff";
import type { ExecutionEnvironmentProvider } from "@oh-my-pi/pi-coding-agent/session/execution-environment";
import type {
	ConfidentialTransientTaskEnsureIsolationRequestV1,
	TransientTaskPostTerminalCleanupEvidenceV1,
	TransientTaskResultPublicationPrePendingInitializeRequestV1,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	preflightTransientTaskResultlessRepresentabilityV1,
	projectTransientTaskResultlessSourceV1,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type { TransientTaskIsolationSettlementV1 } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import {
	ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE,
	subagentRuntimeAllows,
} from "@oh-my-pi/pi-coding-agent/task/runtime-profile";
import {
	buildStructuredSubagentRecoveryHint,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	StructuredSubagentLifecycleFailure,
	type StructuredSubagentRequest,
	type StructuredSubagentTransientTaskRuntimeV1,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import {
	type AgentDefinition,
	MAX_OUTPUT_BYTES,
	type SingleResult,
	StructuredSubagentError,
} from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read", "write", "ast_grep"],
	output: { type: "object", properties: { agent: { type: "boolean" } } },
};

function session(
	options: {
		planMode?: boolean;
		outputSchema?: unknown;
		maxDepth?: number;
		isolationMode?: "none" | "worktree";
		isolationApply?: boolean;
		taskDepth?: number;
	} = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		outputSchema: options.outputSchema,
		settings: Settings.isolated({
			"task.maxRecursionDepth": options.maxDepth ?? 2,
			"task.isolation.mode": options.isolationMode ?? "none",
			"task.enableLsp": true,
			...(options.isolationApply !== undefined ? { "task.isolation.apply": options.isolationApply } : {}),
		}),
		taskDepth: options.taskDepth,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getPlanModeState: () => (options.planMode ? { enabled: true, planFilePath: "/tmp/plan.md" } : undefined),
	};
}

function request(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
	return {
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		...overrides,
	};
}

function result(): SingleResult {
	return {
		index: 0,
		id: "Worker",
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: '{"ok":true}',
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

const TASK_ID = "structured-subagent-task";
const RUN_ID = "structured-subagent-run";
const CREATE_ID = "structured-subagent-create";

type ResultlessIsolationSettlementV1 = Extract<TransientTaskIsolationSettlementV1, { readonly result: null }>;

function resultlessPreflight() {
	const preflight = preflightTransientTaskResultlessRepresentabilityV1(0, "Worker", "worker", MAX_OUTPUT_BYTES);
	if (preflight.status !== "accepted") throw new Error(preflight.toolResultText);
	return preflight.preflight;
}

function terminalEvidence(outcome: "succeeded" | "failed"): TransientTaskPostTerminalCleanupEvidenceV1 {
	return Object.freeze({
		schemaVersion: 1,
		taskId: TASK_ID,
		runId: RUN_ID,
		outcome,
		evidenceId: `terminal-evidence-${outcome}`,
	}) as TransientTaskPostTerminalCleanupEvidenceV1;
}

function transientTaskRuntime(
	executionEnvironmentProvider: ExecutionEnvironmentProvider = {
		acquire: async (): Promise<never> => {
			throw new Error("Unexpected execution environment acquisition");
		},
	},
): StructuredSubagentTransientTaskRuntimeV1 {
	const preflight = resultlessPreflight();
	const ensureRequest = {
		preparation: {
			creatorDescriptor: {
				taskId: TASK_ID,
				runId: RUN_ID,
				createId: CREATE_ID,
			},
		},
	} as ConfidentialTransientTaskEnsureIsolationRequestV1;
	const initializePrePendingRequest = {
		plan: {
			resultTargetKey: {
				schemaVersion: 1,
				taskId: TASK_ID,
				runId: RUN_ID,
				createId: CREATE_ID,
				resultPublicationId: "structured-subagent-publication",
				resultPublicationTargetId: "structured-subagent-target",
				resultPublicationTargetCleanupId: "structured-subagent-target-cleanup",
			},
			resultlessIdentity: preflight.identity,
			maximumUtf8ByteLength: preflight.maximumUtf8ByteLength,
			representabilityPreflight: preflight,
		},
	} as TransientTaskResultPublicationPrePendingInitializeRequestV1;
	const unexpectedLifecycleCall = async (): Promise<never> => {
		throw new Error("Unexpected lifecycle call from mocked isolation runner");
	};
	const fail: StructuredSubagentTransientTaskRuntimeV1["fail"] = async input => ({
		terminalSource:
			input.phase === "before_bind"
				? projectTransientTaskResultlessSourceV1(preflight, "failed", input.source)
				: input.projection,
		mergeSummary: "Isolation failed before binding.",
		changesApplied: null,
		terminalEvidence: terminalEvidence("failed"),
	});
	return Object.freeze({
		taskId: TASK_ID,
		runId: RUN_ID,
		createId: CREATE_ID,
		executionEnvironmentProvider,
		materializer: { ensureIsolation: unexpectedLifecycleCall },
		ensureRequest,
		initializePrePendingRequest,
		fail,
		finalized: unexpectedLifecycleCall,
		isolationReady: unexpectedLifecycleCall,
		releaseExecutionEnvironment: unexpectedLifecycleCall,
		finalizeAfterPending: unexpectedLifecycleCall,
	});
}

function isolatedSettlement(
	completed: SingleResult = result(),
	overrides: Partial<Pick<TransientTaskIsolationSettlementV1, "mergeSummary" | "changesApplied">> = {},
): TransientTaskIsolationSettlementV1 {
	return {
		result: completed,
		mergeSummary: overrides.mergeSummary ?? "",
		changesApplied: overrides.changesApplied === undefined ? true : overrides.changesApplied,
		terminalEvidence: terminalEvidence(
			completed.exitCode === 0 && completed.error === undefined && completed.aborted !== true
				? "succeeded"
				: "failed",
		),
	};
}

function resultlessIsolationSettlement(error: unknown): ResultlessIsolationSettlementV1 {
	return {
		result: null,
		terminalProjection: projectTransientTaskResultlessSourceV1(resultlessPreflight(), "failed", {
			kind: "caught_value",
			caughtAt: "runtime",
			value: error,
		}),
		error,
		mergeSummary: "Isolation failed before capture.",
		changesApplied: null,
		terminalEvidence: terminalEvidence("failed"),
	};
}

function mockDiscovery(agent: AgentDefinition = AGENT): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
}

afterEach(() => {
	vi.restoreAllMocks();
	resetRegisteredArtifactDirsForTests();
});

describe("structured subagent primitive", () => {
	it("uses caller, agent, then session schemas in precedence order", async () => {
		mockDiscovery();
		const callerSchema = { type: "object", properties: { caller: { type: "string" } } };
		const caller = await resolveEffectiveSubagentPolicy(
			request({ outputSchema: callerSchema, schemaMode: "strict" }),
		);
		expect(caller.schema).toEqual({
			schema: callerSchema,
			source: "caller",
			mode: "strict",
			outputSchemaOverridesAgent: true,
		});

		const agent = await resolveEffectiveSubagentPolicy(
			request({ session: session({ outputSchema: { session: true } }) }),
		);
		expect(agent.schema.source).toBe("agent");
		expect(agent.schema.schema).toBe(AGENT.output);

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const inheritedSession = session({ outputSchema: { session: true } });
		inheritedSession.outputSchemaMode = "strict";
		const inherited = await resolveEffectiveSubagentPolicy(request({ session: inheritedSession }));
		expect(inherited.schema).toMatchObject({ source: "session", mode: "strict", outputSchemaOverridesAgent: false });
	});

	it("gives task and eval invocations identical blocked-agent preflight errors", async () => {
		const previous = Bun.env.PI_BLOCKED_AGENT;
		Bun.env.PI_BLOCKED_AGENT = "worker";
		try {
			const discover = vi.spyOn(discoveryModule, "discoverAgents");
			const taskRequest = request();
			const evalRequest = request({ session: taskRequest.session, invocationKind: "eval" });
			const messages: string[] = [];
			for (const candidate of [taskRequest, evalRequest]) {
				try {
					await resolveEffectiveSubagentPolicy(candidate);
				} catch (error) {
					expect(error).toBeInstanceOf(StructuredSubagentError);
					messages.push((error as Error).message);
				}
			}
			expect(messages).toEqual([
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
			]);
			expect(discover).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete Bun.env.PI_BLOCKED_AGENT;
			else Bun.env.PI_BLOCKED_AGENT = previous;
		}
	});

	it("attenuates plan-mode agents and rejects mutable isolation controls before discovery", async () => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ planMode: true }), enableLsp: true, enableIrc: true }),
		);
		expect(policy.effectiveAgent.tools).toEqual(["read", "grep", "glob", "web_search", "ast_grep"]);
		expect(policy.effectiveAgent.spawns).toBeUndefined();
		expect(subagentRuntimeAllows(policy.runtimeProfile, "lsp")).toBe(false);
		expect(subagentRuntimeAllows(policy.runtimeProfile, "irc")).toBe(false);

		vi.restoreAllMocks();
		const discover = vi.spyOn(discoveryModule, "discoverAgents");
		await expect(
			resolveEffectiveSubagentPolicy(
				request({ session: session({ planMode: true }), isolation: { requested: false } }),
			),
		).rejects.toThrow("isolation, apply, and merge controls are unavailable in plan mode");
		expect(discover).not.toHaveBeenCalled();
	});

	it("rejects unsupported environment requests before isolation dispatch or lifecycle provider acquisition", async () => {
		const provider = {
			acquire: vi.fn(async () => {
				throw new Error("provider acquisition must not run during rejected preflight");
			}),
		} satisfies ExecutionEnvironmentProvider;
		const runtime = transientTaskRuntime(provider);
		const blockingAgent: AgentDefinition = { ...AGENT, blocking: true };
		const nonblockingAgent: AgentDefinition = { ...AGENT, name: "nonblocking" };
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [blockingAgent, nonblockingAgent],
			projectAgentsDir: null,
		});
		const isolatedRun = vi.spyOn(isolationRunner, "runIsolatedSubprocess");
		const candidates: Array<{ candidate: StructuredSubagentRequest; message: string }> = [
			{
				candidate: request({
					session: session({ isolationMode: "worktree" }),
					invocationKind: "eval",
					isolation: { requested: true },
					execution: "environment",
					transientTaskRuntime: runtime,
				}),
				message: "only available to task invocations",
			},
			{
				candidate: request({
					session: session({ isolationMode: "worktree" }),
					isolation: { requested: true },
					execution: "environment",
				}),
				message: "requires exact taskId/runId/createId authority",
			},
			{
				candidate: request({
					session: session({ isolationMode: "worktree" }),
					execution: "environment",
					transientTaskRuntime: runtime,
				}),
				message: "requires explicit `isolated: true`",
			},
			{
				candidate: request({
					session: session({ planMode: true, isolationMode: "worktree" }),
					isolation: { requested: true },
					execution: "environment",
					transientTaskRuntime: runtime,
				}),
				message: "unavailable in plan mode",
			},
			{
				candidate: request({
					session: session({ isolationMode: "worktree", taskDepth: 1 }),
					isolation: { requested: true },
					execution: "environment",
					transientTaskRuntime: runtime,
				}),
				message: "only available at task depth 0",
			},
			{
				candidate: request({
					session: session({ isolationMode: "worktree" }),
					isolation: { requested: true },
					execution: "environment",
					detached: true,
					transientTaskRuntime: runtime,
				}),
				message: "must be blocking, not detached",
			},
			{
				candidate: request({
					session: session({ isolationMode: "worktree" }),
					agent: "nonblocking",
					isolation: { requested: true },
					execution: "environment",
					transientTaskRuntime: runtime,
				}),
				message: "requires a blocking agent",
			},
		];

		for (const { candidate, message } of candidates) {
			await expect(runStructuredSubagent(candidate)).rejects.toThrow(message);
		}
		expect(isolatedRun).not.toHaveBeenCalled();
		expect(provider.acquire).not.toHaveBeenCalled();
	});

	it("attenuates a valid environment task to the exact child authority and passes only the provider to isolation", async () => {
		const provider = {
			acquire: vi.fn(async () => {
				throw new Error("mock isolation runner owns acquisition in this test");
			}),
		} satisfies ExecutionEnvironmentProvider;
		const blockingAgent: AgentDefinition = {
			...AGENT,
			blocking: true,
			tools: ["read", "write", "bash", "task", "hub", "eval"],
			spawns: "*",
			prewalk: true,
		};
		mockDiscovery(blockingAgent);
		const environmentSession = session({
			isolationMode: "worktree",
			isolationApply: false,
		});
		Object.assign(environmentSession, {
			enableMCP: true,
			mcpManager: { getTools: () => [{ name: "mcp__hostile" }] },
			extensionPaths: ["/hostile/extension.ts"],
			customToolPaths: [{ path: "/hostile/tool.ts", source: "project" }],
			getEvalSessionId: () => "parent-kernel",
		});
		const policy = await resolveEffectiveSubagentPolicy(
			request({
				session: environmentSession,
				isolation: { requested: true },
				execution: "environment",
			}),
		);
		expect(policy.effectiveAgent).not.toBe(blockingAgent);
		expect(policy.effectiveAgent.tools).toEqual(["read", "write", "bash"]);
		expect(policy.effectiveAgent.spawns).toBeUndefined();
		expect(policy.effectiveAgent.prewalk).toBeUndefined();
		expect(policy.runtimeProfile).toBe(ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE);

		let isolatedOptions: Parameters<typeof isolationRunner.runIsolatedSubprocess>[0] | undefined;
		const settlement = isolatedSettlement(result(), {
			mergeSummary: "Environment changes captured without applying.",
			changesApplied: false,
		});
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async options => {
			isolatedOptions = options;
			return settlement;
		});
		const settled = await runStructuredSubagent(
			request({
				session: environmentSession,
				isolation: { requested: true },
				execution: "environment",
				identity: { id: "Worker" },
				transientTaskRuntime: transientTaskRuntime(provider),
			}),
		);

		expect(isolatedOptions?.executionEnvironmentProvider).toBe(provider);
		expect(isolatedOptions?.baseOptions.runtimeProfile).toBe(ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE);
		expect(isolatedOptions?.baseOptions.agent.tools).toEqual(["read", "write", "bash"]);
		expect(isolatedOptions?.baseOptions.agent.spawns).toBeUndefined();
		expect(isolatedOptions?.baseOptions.agent.prewalk).toBeUndefined();
		expect(isolatedOptions?.baseOptions.mcpManager).toBeUndefined();
		expect(isolatedOptions?.baseOptions.parentEvalSessionId).toBeUndefined();
		expect(isolatedOptions?.baseOptions.executionEnvironment).toBeUndefined();
		expect(settled.mergeSummary).toBe("Environment changes captured without applying.");
		expect(settled.changesApplied).toBe(false);
		expect(settled.terminalEvidence).toBe(settlement.terminalEvidence);
		expect(provider.acquire).not.toHaveBeenCalled();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("leases temporary artifacts for a retained invocation and registers them for agent URLs", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			expect(await fs.stat(options.artifactsDir ?? "")).toBeDefined();
			return result();
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));
		expect(settled.temporaryArtifacts).toBe(true);
		expect(artifactsDir).toBe(settled.artifactsDir);
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(settled.result.structuredOutput).toMatchObject({
			source: "agent",
			mode: "permissive",
			data: { ok: true },
		});
		expect(path.basename(settled.artifactsDir)).toStartWith("omp-task-");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("uses identical non-plan LSP and IRC policy for task and eval invocations", async () => {
		mockDiscovery();
		const taskPolicy = await resolveEffectiveSubagentPolicy(request());
		const evalPolicy = await resolveEffectiveSubagentPolicy(request({ invocationKind: "eval" }));
		expect(Object.isFrozen(taskPolicy.runtimeProfile)).toBe(true);
		expect(Object.isFrozen(evalPolicy.runtimeProfile)).toBe(true);

		expect(subagentRuntimeAllows(evalPolicy.runtimeProfile, "lsp")).toBe(
			subagentRuntimeAllows(taskPolicy.runtimeProfile, "lsp"),
		);
		expect(subagentRuntimeAllows(evalPolicy.runtimeProfile, "irc")).toBe(
			subagentRuntimeAllows(taskPolicy.runtimeProfile, "irc"),
		);
	});

	it("rejects an invalid caller schema before executor dispatch in both modes", async () => {
		mockDiscovery();
		const dispatch = vi.spyOn(executorModule, "runSubprocess");

		for (const schemaMode of ["permissive", "strict"] as const) {
			await expect(runStructuredSubagent(request({ outputSchema: false, schemaMode }))).rejects.toThrow(
				schemaMode === "strict"
					? "Invalid strict caller output schema: boolean false schema rejects all outputs"
					: "Invalid caller output schema: boolean false schema rejects all outputs",
			);
		}
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("does not return unavailable structured metadata without an effective schema", async () => {
		const unstructuredAgent = { ...AGENT, output: undefined };
		mockDiscovery(unstructuredAgent);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			const completed = result();
			completed.structuredOutput = { source: "none", mode: "permissive", status: "unavailable" };
			return completed;
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));

		expect(settled.result).not.toHaveProperty("structuredOutput");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("keeps invalid inherited schemas permissive but rejects them when session strict mode is inherited", async () => {
		const invalidAgent = { ...AGENT, output: false };
		mockDiscovery(invalidAgent);
		expect((await resolveEffectiveSubagentPolicy(request())).schema).toMatchObject({
			source: "agent",
			mode: "permissive",
		});

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const strictSession = session({ outputSchema: false });
		strictSession.outputSchemaMode = "strict";
		await expect(resolveEffectiveSubagentPolicy(request({ session: strictSession }))).rejects.toThrow(
			"Invalid strict effective output schema: boolean false schema rejects all outputs",
		);
	});

	it("persists nested patch text with the compatible recovery path and wording", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-subagent-"));
		const completed = result();
		completed.patchPath = "/recovery/Worker.patch";
		completed.branchName = "omp/task/Worker";
		completed.nestedPatches = [{ relativePath: "sub/nested", patch: "diff --git a/file b/file\n" }];

		const hint = await buildStructuredSubagentRecoveryHint(completed, artifactsDir);
		const nestedPath = path.join(artifactsDir, "Worker.nested-0-sub_nested.patch");

		expect(hint).toContain("Captured patch preserved at /recovery/Worker.patch.");
		expect(hint).toContain(`Captured nested patch preserved at ${nestedPath}.`);
		expect(hint).toContain("Captured branch preserved as omp/task/Worker.");
		expect(await fs.readFile(nestedPath, "utf8")).toBe("diff --git a/file b/file\n");
		await fs.rm(artifactsDir, { recursive: true, force: true });
	});

	it("cleans ephemeral artifacts after a resultless isolation lifecycle failure", async () => {
		mockDiscovery();
		const isolationError = new Error("not a repository");
		const settlement = resultlessIsolationSettlement(isolationError);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockResolvedValue(settlement);

		let caught: unknown;
		try {
			await runStructuredSubagent(
				request({
					session: session({ isolationMode: "worktree" }),
					isolation: { requested: true },
					identity: { id: "Worker" },
					transientTaskRuntime: transientTaskRuntime(),
				}),
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(StructuredSubagentLifecycleFailure);
		if (!(caught instanceof StructuredSubagentLifecycleFailure)) throw caught;
		expect(caught.message).toBe("not a repository");
		expect(caught.result).toBeNull();
		expect(caught.terminalProjection).toBe(settlement.terminalProjection);
		expect(caught.terminalProjection?.document.error).toEqual({
			code: "runtime_interrupted_before_result",
			source: "runtime",
			structuredSubagentKind: null,
			sourceMessage: "not a repository",
		});
		expect(caught.mergeSummary).toBe("Isolation failed before capture.");
		expect(caught.changesApplied).toBeNull();
		expect(caught.terminalEvidence).toBe(settlement.terminalEvidence);
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("reuses a cached output manager across concurrent allocations and sanitizes artifact ids", async () => {
		mockDiscovery();
		const sharedSession = session();
		const ids: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			ids.push(options.id);
			return result();
		});

		const settled = await Promise.all([
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
		]);

		expect(ids.sort()).toEqual(["Worker", "Worker-2"]);
		expect(sharedSession.agentOutputManager).toBeDefined();
		for (const run of settled) await fs.rm(run.artifactsDir, { recursive: true, force: true });
	});

	it("suppresses plan capability sources while preserving non-plan propagation", async () => {
		mockDiscovery();
		const mcpManager = {} as NonNullable<ToolSession["mcpManager"]>;
		const extensionPaths = ["/plugins/example.ts"];
		const customToolPaths: ToolPathWithSource[] = [
			{ path: "/tools/example.ts", source: { provider: "test", providerName: "Test", level: "project" } },
		];
		const planSession = session({ planMode: true });
		Object.assign(planSession, { mcpManager, extensionPaths, customToolPaths });
		const nonPlanSession = session();
		Object.assign(nonPlanSession, { mcpManager, extensionPaths, customToolPaths });
		const mcpDisabledSession = session();
		mcpDisabledSession.enableMCP = false;
		const restrictedSession = session();
		const getApiKey = async () => "exact-account-key";
		Object.assign(restrictedSession, {
			restrictToolNames: true,
			getApiKey,
			mcpManager,
			extensionPaths,
			customToolPaths,
		});
		const options = [] as executorModule.ExecutorOptions[];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			options.push(executorOptions);
			return result();
		});

		const planRun = await runStructuredSubagent(request({ session: planSession, retainArtifacts: true }));
		const nonPlanRun = await runStructuredSubagent(request({ session: nonPlanSession, retainArtifacts: true }));
		const mcpDisabledRun = await runStructuredSubagent(
			request({ session: mcpDisabledSession, retainArtifacts: true }),
		);
		const restrictedRun = await runStructuredSubagent(request({ session: restrictedSession, retainArtifacts: true }));

		expect(options[0]?.runtimeProfile).toMatchObject({
			restrictToolNames: true,
			capabilities: { mcp: false, extensions: false, customTools: false },
		});
		expect(options[0]?.preloadedExtensionPaths).toEqual([]);
		expect(options[0]?.preloadedCustomToolPaths).toEqual([]);
		expect(options[0]?.mcpManager).toBeUndefined();
		expect(options[1]?.runtimeProfile).toMatchObject({
			restrictToolNames: false,
			capabilities: { mcp: true, extensions: true, customTools: true },
		});
		expect(options[1]).toMatchObject({
			mcpManager,
			preloadedExtensionPaths: extensionPaths,
			preloadedCustomToolPaths: customToolPaths,
		});
		expect(options[1]?.runtimeProfile?.restrictToolNames).toBe(false);
		expect(options[2]?.runtimeProfile).toMatchObject({ capabilities: { mcp: false } });
		expect(options[2]?.mcpManager).toBeUndefined();
		expect(options[3]?.runtimeProfile).toMatchObject({
			restrictToolNames: true,
			capabilities: { mcp: false, extensions: false, customTools: false },
		});
		expect(options[3]?.preloadedExtensionPaths).toEqual([]);
		expect(options[3]?.preloadedCustomToolPaths).toEqual([]);
		expect(options[3]?.mcpManager).toBeUndefined();
		expect(options[3]?.getApiKey).toBe(getApiKey);
		await fs.rm(planRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(nonPlanRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(mcpDisabledRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(restrictedRun.artifactsDir, { recursive: true, force: true });
	});

	it("does not allocate a temporary lease when output ID allocation fails", async () => {
		mockDiscovery();
		const failingSession = session();
		const outputManager = new AgentOutputManager(() => null);
		vi.spyOn(outputManager, "allocate").mockRejectedValue(new Error("allocate failed"));
		failingSession.agentOutputManager = outputManager;
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request({ session: failingSession }))).rejects.toThrow(
			"Subagent execution failed: allocate failed",
		);

		expect(remove).not.toHaveBeenCalled();
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("unregisters and removes a temporary lease when plan reference loading fails", async () => {
		mockDiscovery();
		vi.spyOn(planHandoff, "loadOverallPlanReference").mockRejectedValue(new Error("plan unavailable"));
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request())).rejects.toThrow("Subagent execution failed: plan unavailable");

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("cleans failed nonisolated handle artifacts", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed" };
		});

		await runStructuredSubagent(request({ invocationKind: "eval", retainArtifacts: true }));

		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir ?? "")).rejects.toThrow();
	});

	it("retains isolated failure artifacts needed for recovery", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		const completed = { ...result(), exitCode: 1, error: "agent failed", patchPath: "/recovery/Worker.patch" };
		const settlement = isolatedSettlement(completed, {
			mergeSummary: "Failed changes captured at /recovery/Worker.patch.",
			changesApplied: false,
		});
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return settlement;
		});

		const settled = await runStructuredSubagent(
			request({
				session: session({ isolationMode: "worktree" }),
				isolation: { requested: true },
				identity: { id: "Worker" },
				transientTaskRuntime: transientTaskRuntime(),
			}),
		);

		expect(settled.result).toBe(completed);
		expect(settled.mergeSummary).toContain("/recovery/Worker.patch");
		expect(settled.changesApplied).toBe(false);
		expect(settled.terminalEvidence).toBe(settlement.terminalEvidence);
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("defaults task isolation to auto-apply and lets config retain artifacts", async () => {
		mockDiscovery();
		const defaultPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ isolationMode: "worktree" }), isolation: { requested: true } }),
		);
		expect(defaultPolicy.applyChanges).toBe(true);

		const capturePolicy = await resolveEffectiveSubagentPolicy(
			request({
				session: session({ isolationMode: "worktree", isolationApply: false }),
				isolation: { requested: true },
			}),
		);
		expect(capturePolicy.applyChanges).toBe(false);

		const evalPolicy = await resolveEffectiveSubagentPolicy(
			request({
				invocationKind: "eval",
				session: session({ isolationMode: "worktree", isolationApply: false }),
				isolation: { requested: true },
			}),
		);
		expect(evalPolicy.applyChanges).toBe(true);
	});

	it("retains successful isolated task artifacts when auto-apply is disabled", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		const completed = { ...result(), patchPath: "/recovery/Worker.patch" };
		const settlement = isolatedSettlement(completed, {
			mergeSummary: "Changes captured at /recovery/Worker.patch without applying them.",
			changesApplied: false,
		});
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return settlement;
		});

		const settled = await runStructuredSubagent(
			request({
				session: session({ isolationMode: "worktree", isolationApply: false }),
				isolation: { requested: true },
				identity: { id: "Worker" },
				transientTaskRuntime: transientTaskRuntime(),
			}),
		);

		expect(settled.result).toBe(completed);
		expect(settled.changesApplied).toBe(false);
		expect(settled.mergeSummary).toBe("Changes captured at /recovery/Worker.patch without applying them.");
		expect(settled.terminalEvidence).toBe(settlement.terminalEvidence);
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
});
