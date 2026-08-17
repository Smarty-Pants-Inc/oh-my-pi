import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** Async ownership gates session_stop, while todo state remains passive and never emits reminders. */
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

describe("AgentSession todo reminder async-job deferral", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let manager: AsyncJobManager;
	let extensionRunner: ExtensionRunner;
	let gates: Array<PromiseWithResolvers<string>>;
	let reminderAttempts: number[];
	let agentEndTerminalStates: Array<boolean | undefined>;

	function textOnlyAssistantMessage(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "paused at your instruction" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function emitTextOnlyStop(): void {
		const msg = textOnlyAssistantMessage();
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	/** Register a job that stays running until the returned resolver fires. */
	function registerGatedJob(ownerId: string): { resolve: () => void } {
		const gate = Promise.withResolvers<string>();
		gates.push(gate);
		manager.register("bash", `gated job owned by ${ownerId}`, async () => await gate.promise, { ownerId });
		return { resolve: () => gate.resolve("done") };
	}

	/** Give the session incomplete todos so the stop-time reminder is armed. */
	function setIncompleteTodos(): void {
		session.setTodoPhases([
			{
				name: "Pending review",
				tasks: [
					{ content: "Slice 81", status: "pending" },
					{ content: "Slice 82", status: "pending" },
				],
			},
		]);
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-todo-reminder-async-jobs-");
		sessionManager = SessionManager.inMemory(tempDir.path());
		manager = new AsyncJobManager({});
		gates = [];
		extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": true,
			"todo.reminders": true,
			"todo.remindersMax": 3,
		});
		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
			getTodoPhases: () => session?.getTodoPhases() ?? [],
			setTodoPhases: phases => session?.setTodoPhases(phases),
		};

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [new TodoTool(toolSession)],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: sharedModelRegistry,
			agentId: "Main",
			asyncJobManager: manager,
			extensionRunner,
		});
		// Override the session's self-registered sink with a no-op: these tests
		// exercise the async-wake deferral gates, not result injection.
		manager.registerDeliverySink("Main", () => {});

		reminderAttempts = [];
		agentEndTerminalStates = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "todo_reminder") reminderAttempts.push(event.attempt);
			if (event.type === "agent_end") {
				agentEndTerminalStates.push(
					(event as Extract<AgentSessionEvent, { type: "agent_end" }> & { isTerminal?: boolean }).isTerminal,
				);
			}
		});
	});

	afterEach(async () => {
		// Unblock any still-gated job body so the manager can settle promptly.
		for (const gate of gates) gate.resolve("done");
		await session.dispose();
		manager.cancelAll();
		await manager.dispose();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("does not defer a terminal stop for an owned job without an open origin turn", async () => {
		setIncompleteTodos();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		registerGatedJob("Main");

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([]);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(agentEndTerminalStates).toEqual([true]);
	});

	it("never creates a todo reminder for a job owned by a different agent", async () => {
		setIncompleteTodos();
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		registerGatedJob("OtherAgent");

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([]);
	});

	it("does not create a todo reminder after an owned job drains", async () => {
		setIncompleteTodos();
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const job = registerGatedJob("Main");

		// While the job runs, the stop stays silent.
		emitTextOnlyStop();
		await session.waitForIdle();
		expect(reminderAttempts).toEqual([]);

		// Complete the job and drain its result delivery — nothing is left to
		// re-wake the loop, so the deferral must lift.
		job.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries();

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([]);
	});

	it("runs the session_stop hook for an owned job without an open origin turn", async () => {
		// No todo phases: the stop reaches the session_stop pass directly. An
		// unscoped job cannot defer or re-wake the model loop.
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		registerGatedJob("Main");

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});

	it("invokes session_stop on each stop around an unscoped owned job", async () => {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		const job = registerGatedJob("Main");

		// The unscoped job does not defer the first stop.
		emitTextOnlyStop();
		await session.waitForIdle();
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);

		job.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries();

		emitTextOnlyStop();
		await session.waitForIdle();

		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(2);
	});
});
