import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentClosureRejection } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** Stale todo closure is rejected once per prompt without a hidden continuation loop. */
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

describe("AgentSession stop-time todo notifications", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let reminderAttempts: number[];
	let agentEndTerminalStates: Array<boolean | undefined>;
	let closureRejections: AgentClosureRejection[];

	function textOnlyAssistantMessage(text = "paused at your instruction"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
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

	function emitTextOnlyStop(text?: string): void {
		const msg = textOnlyAssistantMessage(text);
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	function emitSuccessfulYieldStop(): void {
		const now = Date.now();
		const yieldCall = {
			type: "toolCall" as const,
			id: "call-stale-todo-yield",
			name: "yield",
			arguments: { data: { ok: true } },
		};
		const msg: AssistantMessage = {
			role: "assistant",
			content: [yieldCall],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			isError: false,
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { ok: true } },
			},
		});
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	function todoReminderTranscriptEntry() {
		return sessionManager.getBranch().find(entry => {
			if (entry.type !== "message" || entry.message.role !== "developer") return false;
			const { content } = entry.message;
			if (!Array.isArray(content)) return false;
			return content.some(
				(item): item is TextContent =>
					item.type === "text" && item.text.includes("You stopped with 2 incomplete todo item(s):"),
			);
		});
	}

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-todo-reminder-loop-");
		sessionManager = SessionManager.inMemory(tempDir.path());

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
		const todoTool = new TodoTool(toolSession);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [todoTool],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: sharedModelRegistry,
		});

		agentEndTerminalStates = [];
		closureRejections = [];
		reminderAttempts = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "todo_reminder") reminderAttempts.push(event.attempt);
			if (event.type === "agent_end") {
				agentEndTerminalStates.push(event.isTerminal);
				if (event.closureRejected) closureRejections.push(event.closureRejected);
			}
		});

		session.setTodoPhases([
			{
				name: "Pending review",
				tasks: [
					{ content: "Slice 81", status: "pending" },
					{ content: "Slice 82", status: "pending" },
				],
			},
		]);
	});

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("rejects stale todo closure without continuing or forcing a tool", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		expect(agentEndTerminalStates).toEqual([true]);
		expect(closureRejections).toEqual([
			{
				reason: "stale_todos",
				todos: [
					{ content: "Slice 81", status: "pending" },
					{ content: "Slice 82", status: "pending" },
				],
			},
		]);
		expect(session.toolChoiceQueue.nextToolChoice()).toBeUndefined();
		expect(todoReminderTranscriptEntry()).toBeUndefined();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("rejects a successful terminal yield while actionable todos remain", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitSuccessfulYieldStop();
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		expect(agentEndTerminalStates).toEqual([true]);
		expect(closureRejections).toEqual([
			{
				reason: "stale_todos",
				todos: [
					{ content: "Slice 81", status: "pending" },
					{ content: "Slice 82", status: "pending" },
				],
			},
		]);
		expect(session.toolChoiceQueue.nextToolChoice()).toBeUndefined();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("rejects a later user turn while actionable todos remain", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		emitTextOnlyStop();
		await session.waitForIdle();
		vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			emitTextOnlyStop("The tracked work is still incomplete.");
		});

		await session.prompt("Continue the tracked work.");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1, 1]);
		expect(agentEndTerminalStates).toEqual([true, true]);
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("rejects stale closure when the assistant asks for user input", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop("I need your feedback before continuing. Which trade-off should I optimize for?");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		expect(agentEndTerminalStates).toEqual([true]);
		expect(todoReminderTranscriptEntry()).toBeUndefined();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("does not notify when todo reminders are disabled", async () => {
		session.settings.override("todo.reminders", false);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop("The requested work is complete.");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([]);
		expect(todoReminderTranscriptEntry()).toBeUndefined();
		expect(agentEndTerminalStates).toEqual([true]);
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("does not notify for completed or blocked todos", async () => {
		session.setTodoPhases([
			{
				name: "Completed",
				tasks: [{ content: "Review lifecycle patch", status: "completed" }],
			},
		]);
		emitTextOnlyStop("The requested work is complete.");
		await session.waitForIdle();

		session.setTodoPhases([
			{
				name: "Delegation",
				tasks: [{ content: "Review lifecycle patch", status: "blocked", blocker: "waiting on ReviewFixer" }],
			},
		]);
		emitTextOnlyStop("Waiting for the review.");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([]);
		expect(session.toolChoiceQueue.nextToolChoice()).toBeUndefined();
		expect(agentEndTerminalStates).toEqual([true, true]);
	});

	it("rejects stale closure for a non-English user-facing question", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop("我遇到一个需要你决定的问题：是否应该继续删除旧的配置文件？");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		expect(agentEndTerminalStates).toEqual([true]);
		expect(todoReminderTranscriptEntry()).toBeUndefined();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("notifies when the assistant answers its own prompt-shaped question", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop(
			"Which configuration should this use?\nUse the existing default; the remaining todo items still need work.",
		);
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		expect(todoReminderTranscriptEntry()).toBeUndefined();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("notifies when ordinary prose contains answer", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop("Final answer: I summarized the work completed so far, but the todo items remain open.");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		expect(todoReminderTranscriptEntry()).toBeUndefined();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("notifies when TypeScript optional syntax appears in the assistant tail", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop("Tail note: the interface includes foo?: string, but the todo items remain open.");
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		expect(todoReminderTranscriptEntry()).toBeUndefined();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("emits only one notification for repeated terminal events in one prompt", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		emitTextOnlyStop();
		await session.waitForIdle();
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(reminderAttempts).toEqual([1]);
		expect(agentEndTerminalStates).toEqual([true, true]);
		expect(continueSpy).not.toHaveBeenCalled();
	});
});
