import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression for issue #3656 — running `/shake` (or any mid-stream rebuild)
 * while the LLM is still streaming used to wipe the in-flight assistant turn
 * from the chat. `rebuildChatFromMessages` clears `chatContainer` and replays
 * only committed `state.messages`; the agent's in-flight `streamMessage` and
 * its still-pending tool calls live OUTSIDE `state.messages` until
 * `message_end`, so the live `streamingComponent` and `pendingTools` entries
 * were detached and every subsequent `message_update`/`message_end` event
 * routed deltas into orphaned components that never re-rendered.
 *
 * The fix snapshots the live components before clear, re-appends them after
 * the historical replay, and restores the `pendingTools` map so streaming
 * continues into the same on-screen components.
 */
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantWithBash(command: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage,
		timestamp: Date.now(),
	};
}

function assistantWithResolvedBashReply(command: string, reply: string): AssistantMessage {
	const message = assistantWithBash(command);
	const toolCall = message.content[0];
	if (toolCall?.type !== "toolCall") throw new Error("Expected bash tool call");
	toolCall.cursorExecResolved = true;
	(toolCall as CursorExecResolvedCarrier)[kCursorExecResolved] = true;
	message.api = "cursor-agent";
	message.provider = "cursor";
	message.model = "cursor-model";
	message.content.push({ type: "text", text: reply });
	message.stopReason = "stop";
	return message;
}

function assistantWithReply(reply: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: reply }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage,
		timestamp: Date.now(),
	};
}
function assistantWithTwoResolvedBashReplies(): AssistantMessage {
	const message = assistantWithResolvedBashReply("echo TOOL_A", "MIDDLE BETWEEN TOOLS");
	message.content.unshift({ type: "text", text: "INTRO BEFORE TOOL_A" });
	const firstTool = message.content.find(content => content.type === "toolCall");
	if (!firstTool) throw new Error("Expected first bash tool call");
	firstTool.id = "call-a";
	const secondTool = {
		type: "toolCall" as const,
		id: "call-b",
		name: "bash",
		arguments: { command: "echo TOOL_B" },
		cursorExecResolved: true as const,
	};
	(secondTool as CursorExecResolvedCarrier)[kCursorExecResolved] = true;
	message.content.push(secondTool, { type: "text", text: "FINAL AFTER TOOL_B" });
	return message;
}

describe("issue #3656 /shake mid-stream preserves the in-flight assistant turn", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-3656-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		HistoryStorage.resetInstance();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function makeStreamingFixture(streaming = true): {
		streamingComponent: AssistantMessageComponent;
		pendingTool: ToolExecutionComponent;
	} {
		const streamingComponent = new AssistantMessageComponent();
		const pendingTool = new ToolExecutionComponent(
			"bash",
			{ command: "echo hi" },
			{},
			undefined,
			mode.ui,
			tempDir.path(),
			"call-1",
		);
		mode.chatContainer.addChild(streamingComponent);
		mode.chatContainer.addChild(pendingTool);
		mode.streamingComponent = streamingComponent;
		mode.streamingMessage = assistantWithBash("echo hi");
		mode.pendingTools.set("call-1", pendingTool);
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		return { streamingComponent, pendingTool };
	}

	it("keeps the streaming assistant component attached after a mid-stream rebuild", () => {
		const { streamingComponent } = makeStreamingFixture();

		mode.rebuildChatFromMessages();

		expect(mode.chatContainer.children).toContain(streamingComponent);
		expect(mode.streamingComponent).toBe(streamingComponent);
	});

	it("keeps in-flight tool components attached and tracked in pendingTools", () => {
		const { pendingTool } = makeStreamingFixture();

		mode.rebuildChatFromMessages();

		expect(mode.chatContainer.children).toContain(pendingTool);
		expect(mode.pendingTools.get("call-1")).toBe(pendingTool);
	});

	it("routes later streamed tool-call deltas into the preserved on-screen component", async () => {
		const { pendingTool } = makeStreamingFixture();
		const updateArgs = vi.spyOn(pendingTool, "updateArgs");

		mode.rebuildChatFromMessages();
		await mode.eventController.handleEvent({
			type: "message_update",
			message: assistantWithBash("echo after"),
		} as AgentSessionEvent);

		expect(mode.pendingTools.get("call-1")).toBe(pendingTool);
		expect(updateArgs).toHaveBeenCalledWith({ command: "echo after" }, "call-1");
	});

	it("re-appends in-flight components after the historical replay (live tail order)", () => {
		const { streamingComponent, pendingTool } = makeStreamingFixture();

		mode.rebuildChatFromMessages();

		const children = mode.chatContainer.children;
		const streamingIdx = children.indexOf(streamingComponent);
		const pendingIdx = children.indexOf(pendingTool);
		expect(streamingIdx).toBeGreaterThanOrEqual(0);
		expect(pendingIdx).toBeGreaterThan(streamingIdx);
	});

	it("uses the rendered view session when preserving a focused subagent stream", () => {
		const { streamingComponent, pendingTool } = makeStreamingFixture(false);
		Object.defineProperty(mode, "viewSession", {
			configurable: true,
			get: () => ({
				isStreaming: true,
				buildTranscriptSessionContext: () => ({ messages: [] }),
				getToolByName: () => undefined,
				sessionManager: { getCwd: () => tempDir.path() },
				retryAttempt: undefined,
			}),
		});

		mode.rebuildChatFromMessages();

		expect(mode.chatContainer.children).toContain(streamingComponent);
		expect(mode.chatContainer.children).toContain(pendingTool);
		expect(mode.pendingTools.get("call-1")).toBe(pendingTool);
	});

	it("reattaches post-tool reply text so message_end can finalize the same visible block", async () => {
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		const completed = assistantWithResolvedBashReply("echo hi", "FINAL AFTER TOOL");
		await mode.eventController.handleEvent({
			type: "message_start",
			message: { ...completed, content: [] },
		} as AgentSessionEvent);
		await mode.eventController.handleEvent({ type: "message_update", message: completed } as AgentSessionEvent);

		const postToolComponent = mode.chatContainer.children.find(
			child =>
				child instanceof AssistantMessageComponent &&
				child !== mode.streamingComponent &&
				Bun.stripANSI(child.render(120).join("\n")).includes("FINAL AFTER TOOL"),
		);
		if (!(postToolComponent instanceof AssistantMessageComponent)) {
			throw new Error("Expected visible post-tool assistant component");
		}

		mode.rebuildChatFromMessages();
		expect(mode.chatContainer.children).toContain(postToolComponent);

		await mode.eventController.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "hi" }] },
			isError: false,
		} as AgentSessionEvent);
		await mode.eventController.handleEvent({ type: "message_end", message: completed } as AgentSessionEvent);
		await mode.eventController.handleEvent({
			type: "turn_end",
			message: completed,
			toolResults: [],
			willContinue: false,
		} as AgentSessionEvent);
		expect(postToolComponent.render(120).join("\n")).not.toContain("\x1b]133;");

		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		await mode.eventController.handleEvent({
			type: "agent_end",
			messages: [completed],
			isTerminal: true,
			responseAnchorTerminal: true,
		} as AgentSessionEvent);

		expect(mode.chatContainer.children).toContain(postToolComponent);
		expect(String(postToolComponent.render(120).join("\n"))).toContain("\x1b]133;A;aid=omp-response-");
	});
	it("anchors a persisted JSON-replayed terminal Cursor reply", () => {
		const reply = "PERSISTED CURSOR REPLY";
		const replayed = JSON.parse(JSON.stringify(assistantWithResolvedBashReply("echo hi", reply))) as AssistantMessage;
		replayed.responseAnchorTerminal = true;
		const replayedToolCall = replayed.content.find(content => content.type === "toolCall");
		if (!replayedToolCall) throw new Error("Expected replayed Cursor tool call");
		expect((replayedToolCall as CursorExecResolvedCarrier)[kCursorExecResolved]).toBeUndefined();
		expect(replayedToolCall.cursorExecResolved).toBe(true);
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: replayedToolCall.id,
			toolName: replayedToolCall.name,
			content: [{ type: "text", text: "hi" }],
			isError: false,
			timestamp: Date.now(),
		};
		session.sessionManager.appendMessage(replayed);
		session.sessionManager.appendMessage(JSON.parse(JSON.stringify(result)) as ToolResultMessage);

		mode.rebuildChatFromMessages();

		const raw = mode.chatContainer.render(120).join("\n");
		expect(Bun.stripANSI(raw)).toContain(reply);
		expect(raw.split("\x1b]133;A;aid=omp-response-")).toHaveLength(2);
	});

	it("does not anchor unresolved local-tool progress when a rebuild strips its dangling call", () => {
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		const progress = assistantWithBash("sleep 60");
		progress.content.push({ type: "text", text: "LOCAL TOOL PROGRESS AFTER REBUILD" });
		session.sessionManager.appendMessage(progress);

		const rebuilt = session
			.buildTranscriptSessionContext()
			.messages.find((message): message is AssistantMessage => message.role === "assistant");
		if (!rebuilt) throw new Error("Expected rebuilt local-tool message");
		expect(rebuilt.content.some(block => block.type === "toolCall")).toBe(false);
		expect((rebuilt as AssistantMessage & { strippedToolCalls?: number }).strippedToolCalls).toBe(1);

		mode.rebuildChatFromMessages();

		expect(mode.chatContainer.render(120).join("\n")).not.toContain("\x1b]133;A;aid=omp-response-");
	});

	it("renders a post-tool reply once across an active rebuild and retains its terminal anchor candidate", async () => {
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		const reply = "POST TOOL REPLY REBUILT ONCE";
		const completed = assistantWithResolvedBashReply("echo hi", reply);
		await mode.eventController.handleEvent({
			type: "message_start",
			message: { ...completed, content: [] },
		} as AgentSessionEvent);
		await mode.eventController.handleEvent({ type: "message_update", message: completed } as AgentSessionEvent);
		await mode.eventController.handleEvent({ type: "message_end", message: completed } as AgentSessionEvent);

		const postToolComponent = mode.chatContainer.children.find(
			child =>
				child instanceof AssistantMessageComponent && Bun.stripANSI(child.render(120).join("\n")).includes(reply),
		);
		if (!(postToolComponent instanceof AssistantMessageComponent)) {
			throw new Error("Expected visible post-tool assistant component");
		}
		const replayed = JSON.parse(JSON.stringify(completed)) as AssistantMessage;
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "hi" }],
			isError: false,
			timestamp: Date.now(),
		};
		session.sessionManager.appendMessage(replayed);
		session.sessionManager.appendMessage(JSON.parse(JSON.stringify(result)) as ToolResultMessage);

		mode.rebuildChatFromMessages();

		let raw = mode.chatContainer.render(120).join("\n");
		expect(Bun.stripANSI(raw).split(reply)).toHaveLength(2);
		expect(mode.chatContainer.children).toContain(postToolComponent);
		await mode.eventController.handleEvent({
			type: "turn_end",
			message: completed,
			toolResults: [],
			willContinue: false,
		} as AgentSessionEvent);
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		await mode.eventController.handleEvent({
			type: "agent_end",
			messages: [completed],
			isTerminal: true,
			responseAnchorTerminal: true,
		} as AgentSessionEvent);

		raw = mode.chatContainer.render(120).join("\n");
		expect(Bun.stripANSI(raw).split(reply)).toHaveLength(2);
		expect(String(postToolComponent.render(120).join("\n"))).toContain("\x1b]133;A;aid=omp-response-");
	});
	it("keeps each post-tool segment at its matching replay position and anchors only the final response", async () => {
		let streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		const completed = assistantWithTwoResolvedBashReplies();
		await mode.eventController.handleEvent({
			type: "message_start",
			message: { ...completed, content: [] },
		} as AgentSessionEvent);
		await mode.eventController.handleEvent({ type: "message_update", message: completed } as AgentSessionEvent);

		const middleComponent = mode.chatContainer.children.find(
			child =>
				child instanceof AssistantMessageComponent &&
				Bun.stripANSI(child.render(120).join("\n")).includes("MIDDLE BETWEEN TOOLS"),
		);
		const finalComponent = mode.chatContainer.children.find(
			child =>
				child instanceof AssistantMessageComponent &&
				Bun.stripANSI(child.render(120).join("\n")).includes("FINAL AFTER TOOL_B"),
		);
		if (
			!(middleComponent instanceof AssistantMessageComponent) ||
			!(finalComponent instanceof AssistantMessageComponent)
		) {
			throw new Error("Expected visible post-tool assistant components");
		}

		session.sessionManager.appendMessage(JSON.parse(JSON.stringify(completed)) as AssistantMessage);
		for (const toolCallId of ["call-a", "call-b"]) {
			session.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			});
		}

		mode.rebuildChatFromMessages();

		let raw = mode.chatContainer.render(120).join("\n");
		const visible = Bun.stripANSI(raw);
		const positions = ["INTRO", "TOOL_A", "MIDDLE BETWEEN TOOLS", "TOOL_B", "FINAL AFTER TOOL_B"].map(marker =>
			visible.indexOf(marker),
		);
		expect(positions.every(position => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((left, right) => left - right));
		expect(mode.chatContainer.children).toContain(middleComponent);
		expect(mode.chatContainer.children).toContain(finalComponent);

		await mode.eventController.handleEvent({ type: "message_end", message: completed } as AgentSessionEvent);
		streaming = false;
		await mode.eventController.handleEvent({
			type: "agent_end",
			messages: [completed],
			isTerminal: true,
			responseAnchorTerminal: true,
		} as AgentSessionEvent);

		raw = mode.chatContainer.render(120).join("\n");
		expect(raw.split("\x1b]133;A;aid=omp-response-")).toHaveLength(2);
		expect(finalComponent.render(120).join("\n")).toContain("\x1b]133;A;aid=omp-response-");
		expect(middleComponent.render(120).join("\n")).not.toContain("\x1b]133;A;aid=omp-response-");
	});

	it("keeps a no-tool reply candidate singular until terminal agent_end resolves its zone", async () => {
		let streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		const reply = "NO TOOL TERMINAL REPLY REBUILT ONCE";
		const completed = assistantWithReply(reply);
		await mode.eventController.handleEvent({
			type: "message_start",
			message: { ...completed, content: [] },
		} as AgentSessionEvent);
		await mode.eventController.handleEvent({ type: "message_end", message: completed } as AgentSessionEvent);
		const candidate = mode.chatContainer.children.find(
			child =>
				child instanceof AssistantMessageComponent && Bun.stripANSI(child.render(120).join("\n")).includes(reply),
		);
		if (!(candidate instanceof AssistantMessageComponent)) {
			throw new Error("Expected visible no-tool response candidate");
		}
		const persisted = JSON.parse(JSON.stringify(completed)) as AssistantMessage;
		persisted.responseAnchorTerminal = true;
		session.sessionManager.appendMessage(persisted);
		mode.rebuildChatFromMessages();

		let raw = mode.chatContainer.render(120).join("\n");
		expect(Bun.stripANSI(raw).split(reply)).toHaveLength(2);
		expect(raw).not.toContain("\x1b]133;A;aid=omp-response-");
		expect(mode.chatContainer.children).toContain(candidate);

		streaming = false;
		await mode.eventController.handleEvent({
			type: "agent_end",
			messages: [completed],
			isTerminal: true,
			responseAnchorTerminal: true,
		} as AgentSessionEvent);

		raw = mode.chatContainer.render(120).join("\n");
		expect(Bun.stripANSI(raw).split(reply)).toHaveLength(2);
		expect(raw.split("\x1b]133;A;aid=omp-response-")).toHaveLength(2);

		mode.rebuildChatFromMessages();
		raw = mode.chatContainer.render(120).join("\n");
		expect(raw.split("\x1b]133;A;aid=omp-response-")).toHaveLength(2);
	});

	it.each([
		["explicitly false", false],
		["absent", undefined],
	] as const)(
		"fails closed on reply anchoring when durable anchor eligibility is %s",
		async (_case, responseAnchorTerminal) => {
			let streaming = true;
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
			const reply = "NO TOOL ANCHOR-INELIGIBLE REPLY REBUILT ONCE";
			const completed = assistantWithReply(reply);
			await mode.eventController.handleEvent({
				type: "message_start",
				message: { ...completed, content: [] },
			} as AgentSessionEvent);
			await mode.eventController.handleEvent({ type: "message_end", message: completed } as AgentSessionEvent);
			const persisted = JSON.parse(JSON.stringify(completed)) as AssistantMessage;
			persisted.responseAnchorTerminal = false;
			session.sessionManager.appendMessage(persisted);

			mode.rebuildChatFromMessages();

			let raw = mode.chatContainer.render(120).join("\n");
			expect(Bun.stripANSI(raw).split(reply)).toHaveLength(2);
			expect(raw).not.toContain("\x1b]133;A;aid=omp-response-");

			streaming = false;
			await mode.eventController.handleEvent({
				type: "agent_end",
				messages: [completed],
				isTerminal: true,
				responseAnchorTerminal,
			} as AgentSessionEvent);

			raw = mode.chatContainer.render(120).join("\n");
			expect(Bun.stripANSI(raw).split(reply)).toHaveLength(2);
			expect(raw).not.toContain("\x1b]133;A;aid=omp-response-");

			mode.rebuildChatFromMessages();
			raw = mode.chatContainer.render(120).join("\n");
			expect(raw).not.toContain("\x1b]133;A;aid=omp-response-");
		},
	);
	it("does not preserve in-flight tracking when the session is idle (post-stream rebuilds reset cleanly)", () => {
		const streamingComponent = new AssistantMessageComponent();
		mode.chatContainer.addChild(streamingComponent);
		mode.streamingComponent = streamingComponent;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		mode.rebuildChatFromMessages();

		// Idle rebuilds (resume, /compact post-flush, theme overlay close) treat
		// `streamingComponent` as stale UI to discard — the chat must be redrawn
		// purely from committed messages.
		expect(mode.chatContainer.children).not.toContain(streamingComponent);
	});
});
