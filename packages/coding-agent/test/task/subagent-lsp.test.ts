import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import {
	AgentSession,
	type AgentSessionEvent,
	type PromptOptions,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { WorkspaceRuntimeProviderRegistry } from "@oh-my-pi/pi-coding-agent/session/workspace-provider-registry";
import type { OrdinaryTransientTaskLifecycleCreateInputV1 } from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/tools/yield";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const TEST_TASK: TaskParams = { agent: "task", name: "CheckLsp", task: "Inspect LSP tools." };
interface IsolationRuntimeAuthorityFixture {
	readonly executionEnvironmentProvider: { acquire(): Promise<never> };
	readonly ownerSessionIndex: Readonly<Record<string, never>>;
	readonly stores: {
		readonly ordinaryTransientTaskLifecycle: {
			create(input: OrdinaryTransientTaskLifecycleCreateInputV1): Promise<object>;
		};
	};
}

function createAssistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
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

function createYieldingSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[], model: undefined, systemPrompt: ["test"] };

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = Object.create(AgentSession.prototype);
	Object.defineProperty(session, "extensionRunner", { value: undefined });

	return Object.assign(session, {
		agent: { state },
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			state.messages.push(createAssistantStopMessage("done"));
			emit({
				type: "tool_execution_end",
				toolCallId: "yield-call",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
	});
}

function createSession(
	options: {
		isolationMode?: "none" | "auto";
		parentEnableLsp?: boolean;
		planMode?: PlanModeState;
		runtimeAuthority?: IsolationRuntimeAuthorityFixture;
		sessionFile?: string | null;
		taskEnableLsp?: boolean;
	} = {},
): ToolSession {
	const runtimeAuthority = options.runtimeAuthority;

	const session: ToolSession = {
		cwd: "/tmp",
		hasUI: false,
		enableLsp: options.parentEnableLsp,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": options.isolationMode ?? "none",
			...(options.taskEnableLsp !== undefined ? { "task.enableLsp": options.taskEnableLsp } : {}),
		}),
		getSessionFile: () => options.sessionFile ?? null,
		getSessionSpawns: () => "*",
		getPlanModeState: () => options.planMode,
	};
	if (runtimeAuthority) {
		Object.assign(session, { acquireTransientTaskRuntimeAuthority: async () => runtimeAuthority });
	}
	return session;
}

function mockAgents(agent: AgentDefinition): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [agent],
		projectAgentsDir: null,
	});
}

function mockCreateAgentSession(): { getOptions: () => CreateAgentSessionOptions | undefined } {
	let capturedOptions: CreateAgentSessionOptions | undefined;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
		capturedOptions = options;
		return {
			session: createYieldingSession(),
			runtimeProviderRegistry: new WorkspaceRuntimeProviderRegistry(),
			extensionsResult: { extensions: [], errors: [], runtime: new ExtensionRuntime() },
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult;
	});
	return { getOptions: () => capturedOptions };
}

function mockIsolation() {
	const taskId = "task-id";
	const runId = "run-id";
	const createId = "create-id";
	const creatorDescriptor = {
		taskId,
		runId,
		createId,
		mergedDir: "/tmp/isolated-subagent",
	};
	const cleanupDescriptor = {
		schemaVersion: 1,
		creatorDescriptor,
		mergedDir: creatorDescriptor.mergedDir,
		backend: "rcopy",
		fellBack: false,
		fallbackReason: null,
		cleanupDescriptorSha256: `sha256:${"a".repeat(64)}`,
	};
	const terminalEvidence = { outcome: "succeeded" };
	const materialize = vi.fn(async () => ({ status: "created" as const, cleanupDescriptor }));
	const isolationReady = vi.fn(async () => ({
		preparation: { state: "bound" as const },
		cleanupDescriptor,
		releaseBarrier: { status: "not_applicable" as const },
	}));
	const finalized = vi.fn(async () => ({ pending: {}, receipt: {} }));
	const finalize = vi.fn(async () => ({
		mergeSummary: "Captured isolated changes and cleaned up the execution environment.",
		changesApplied: true,
		terminalEvidence,
	}));
	const unused = async (): Promise<never> => {
		throw new Error("Unexpected transient-task lifecycle call");
	};
	const create = vi.fn(async (input: OrdinaryTransientTaskLifecycleCreateInputV1) => ({
		taskId,
		runId,
		createId,
		effectIdentityManifest: {},
		materializer: { ensureIsolation: materialize },
		ensureRequest: {
			preparation: { state: "claim_current" as const, creatorDescriptor },
			controller: { taskId, runId, createId },
			authoritySha256: `sha256:${"b".repeat(64)}`,
			requestSha256: `sha256:${"c".repeat(64)}`,
			requestedAt: "2026-01-01T00:00:00.000Z",
		},
		initializePrePendingRequest: {
			plan: {
				schemaVersion: 1,
				resultTargetKey: { schemaVersion: 1, taskId, runId, createId, publicationTargetId: "target-id" },
				resultlessIdentity: input.resultlessPreflight.identity,
				maximumUtf8ByteLength: input.resultlessPreflight.maximumUtf8ByteLength,
				representabilityPreflight: input.resultlessPreflight,
				preflightSha256: `sha256:${"d".repeat(64)}`,
				planSha256: `sha256:${"e".repeat(64)}`,
			},
			expectedAuthorityRevision: 1,
			fencingGeneration: 1,
			controller: { taskId, runId, createId },
			initializedAt: "2026-01-01T00:00:00.000Z",
			requestSha256: "f".repeat(64),
		},
		abortBeforeRegistration: unused,
		fail: unused,
		finalized,
		cancelled: unused,
		releaseBeforeBind: unused,
		isolationReady,
		releaseExecutionEnvironment: unused,
		finalize,
		settleDetached: unused,
	}));
	const authority: IsolationRuntimeAuthorityFixture = {
		executionEnvironmentProvider: { acquire: unused },
		ownerSessionIndex: {},
		stores: { ordinaryTransientTaskLifecycle: { create } },
	};

	vi.spyOn(worktreeModule, "ensureIsolation").mockImplementation((request, materializer) =>
		materializer.ensureIsolation(request),
	);
	return { authority, create, materialize, isolationReady, finalized, finalize, cleanupDescriptor };
}

describe("subagent LSP availability", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("disables LSP for subagents by default", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use LSP when useful.",
			source: "bundled",
			tools: ["lsp"],
		});
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession());
		await tool.execute("tool-call", TEST_TASK);

		expect(getOptions()?.enableLsp).toBe(false);
	});

	it("enables subagent LSP when task.enableLsp is set", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["lsp"],
		});
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession({ taskEnableLsp: true }));
		await tool.execute("tool-call", TEST_TASK);

		expect(getOptions()?.enableLsp).toBe(true);
		expect(getOptions()?.toolNames).toContain("lsp");
	});

	it("keeps subagent LSP disabled when the parent session disables LSP", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["lsp"],
		});
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession({ parentEnableLsp: false, taskEnableLsp: true }));
		await tool.execute("tool-call", TEST_TASK);

		expect(getOptions()?.enableLsp).toBe(false);
	});

	it("disables LSP for isolated subagents by default", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use LSP when useful.",
			source: "bundled",
			tools: ["lsp"],
		});
		const isolation = mockIsolation();
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(
			createSession({ isolationMode: "auto", runtimeAuthority: isolation.authority }),
		);
		const result = await tool.execute("tool-call", { ...TEST_TASK, isolated: true });

		expect(getOptions()?.cwd).toBe("/tmp/isolated-subagent");
		expect(getOptions()?.enableLsp).toBe(false);
		expect(result.details?.results).toEqual([
			expect.objectContaining({ exitCode: 0, output: JSON.stringify({ ok: true }, null, 2) }),
		]);
		const summaryContent = result.content[0];
		if (summaryContent?.type !== "text") throw new TypeError("Expected a text task summary");
		expect(summaryContent.text).toContain("Captured isolated changes and cleaned up the execution environment.");
		expect(isolation.materialize).toHaveBeenCalledTimes(1);
		expect(isolation.isolationReady).toHaveBeenCalledWith(isolation.cleanupDescriptor);
		expect(isolation.finalized).toHaveBeenCalledTimes(1);
		expect(isolation.finalize).toHaveBeenCalledWith(
			expect.objectContaining({ cleanupDescriptor: isolation.cleanupDescriptor }),
		);
	});

	it("opens isolated persisted subagent sessions with the worktree cwd", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["write"],
		});
		const isolation = mockIsolation();
		const { getOptions } = mockCreateAgentSession();
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolated-session-cwd-"));
		try {
			const parentSessionFile = path.join(tempDir, "parent.jsonl");
			const tool = await TaskTool.create(
				createSession({
					isolationMode: "auto",
					runtimeAuthority: isolation.authority,
					sessionFile: parentSessionFile,
				}),
			);
			await tool.execute("tool-call", { ...TEST_TASK, isolated: true });

			expect(getOptions()?.cwd).toBe("/tmp/isolated-subagent");
			expect(getOptions()?.sessionManager?.getCwd()).toBe("/tmp/isolated-subagent");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("clamps plan-mode mixed-capability tools despite ordinary settings", async () => {
		mockAgents({
			name: "task",
			description: "Reviewer-like task agent",
			systemPrompt: "Review with read-only specialty tools.",
			source: "bundled",
			tools: ["bash", "ast_grep", "memory_edit", "retain", "todo"],
		});
		const { getOptions } = mockCreateAgentSession();
		const planMode = { enabled: true, planFilePath: "local://PLAN.md" };

		const tool = await TaskTool.create(createSession({ planMode, taskEnableLsp: true }));
		await tool.execute("tool-call", TEST_TASK);

		const options = getOptions();
		expect(options?.enableLsp).toBe(false);
		expect(options?.enableIrc).toBe(false);
		expect(options?.restrictToolNames).toBe(true);
		expect(options?.toolNames).toEqual(["read", "grep", "glob", "web_search", "ast_grep"]);
		expect(options?.toolNames).not.toContain("lsp");
		expect(options?.toolNames).not.toContain("hub");
		expect(options?.toolNames).not.toContain("bash");
		expect(options?.toolNames).not.toContain("memory_edit");
		expect(options?.toolNames).not.toContain("retain");
		expect(options?.toolNames).not.toContain("todo");
	});
});
