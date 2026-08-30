import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { Component, TUI } from "@oh-my-pi/pi-tui";

const TOOL_CALL_A_ID = "toolu_mixed_text_order_a";
const TOOL_CALL_B_ID = "toolu_mixed_text_order_b";
const INTRO_MARKER = "INTRO TEXT BEFORE FIRST TOOL";
const TOOL_RESULT_A_MARKER = "TOOL RESULT FROM FIRST TOOL";
const MIDDLE_MARKER = "MIDDLE TEXT BETWEEN TOOL CALLS";
const TOOL_RESULT_B_MARKER = "TOOL RESULT FROM SECOND TOOL";
const FINAL_MARKER = "FINAL ANSWER AFTER SECOND TOOL";
const HIDDEN_BASH_COMMAND_MARKER = "HIDDEN BASH COMMAND MARKER";
const HIDDEN_BASH_FAILURE_MARKER = "HIDDEN BASH FAILURE MARKER";
const HIDDEN_READ_PATH_MARKER = "hidden-tool-activity.ts";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor",
		provider: "cursor",
		model: "cursor-model",
		stopReason: "stop",
		usage: zeroUsage(),
		timestamp: 1,
		...overrides,
	};
}

function lineContaining(lines: string[], marker: string): number {
	const index = lines.findIndex(line => line.includes(marker));
	if (index === -1) {
		throw new Error(`Rendered transcript did not contain ${marker}:\n${lines.join("\n")}`);
	}
	return index;
}

function createFixture(hideToolActivity = false, hasTransformAssistantMessage = false) {
	const chatContainer = new TranscriptContainer();
	chatContainer.setToolActivityVisible(!hideToolActivity);
	const pendingTools = new Map();
	const ui = {
		requestRender: vi.fn(),
		requestComponentRender: vi.fn(),
		imageBudget: undefined,
	} as unknown as TUI;
	const viewSession = {
		getToolByName: () => undefined,
		hasBuiltInTool: () => true,
		extensionRunner: undefined,
		isTtsrAbortPending: false,
		retryAttempt: 0,
		isStreaming: false,
		isCompacting: false,
		messages: [],
		getContextUsage: () => undefined,
		agent: { transformAssistantMessage: hasTransformAssistantMessage ? vi.fn() : undefined },
	};
	let hasDisplayableThinkingContent = false;
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui,
		settings,
		chatContainer,
		transcriptMessageComponents: new WeakMap(),
		pendingTools,
		toolOutputExpanded: false,
		hideToolActivity,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		statusLine: { invalidate: vi.fn(), markActivityEnd: vi.fn(), markActivityStart: vi.fn() },
		statusContainer: { disposeChildren: vi.fn() },
		noteDisplayableThinkingContent: vi.fn((message: AssistantMessage) => {
			const hasThinking = message.content.some(
				content => content.type === "thinking" && content.thinking.trim() !== "",
			);
			if (!hasThinking || hasDisplayableThinkingContent) return false;
			hasDisplayableThinkingContent = true;
			return true;
		}),
		session: viewSession,
		viewSession,
		sessionManager: { getCwd: () => process.cwd(), getSessionName: () => "test" },
		flushPendingModelSwitch: vi.fn(async () => {}),
		flushPendingCommandOutput: vi.fn(),
		editor: { getText: () => "" },
		showWarning: vi.fn(),
		showPinnedError: vi.fn(),
		clearTransientSessionUi: vi.fn(),
		lastAssistantUsage: zeroUsage(),
	} as unknown as InteractiveModeContext;

	return { controller: new EventController(ctx), chatContainer };
}

describe("EventController mixed assistant text/tool rendering", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	async function settleTurn(
		controller: EventController,
		message: AssistantMessage,
		willContinue: boolean,
	): Promise<void> {
		await controller.handleEvent({ type: "turn_end", message, toolResults: [], willContinue });
	}

	async function settleAgent(
		controller: EventController,
		messages: AssistantMessage[],
		{
			isTerminal = true,
			responseAnchorId,
			responseAnchorTerminal,
		}: { isTerminal?: boolean; responseAnchorId?: string; responseAnchorTerminal?: boolean } = {},
	): Promise<void> {
		await controller.handleEvent({
			type: "agent_end",
			messages,
			isTerminal,
			responseAnchorId,
			responseAnchorTerminal,
		});
	}

	it("finalizes and removes an orphaned streaming component on the next message_start", async () => {
		// Regression: a stream that died between message_start and message_end
		// (transport drop, hook throw) left its component live in the transcript.
		// One unfinalized block at the retirement frontier blocks history commits
		// for everything after it, so the whole transcript tail stayed in the
		// mutable viewport in pressure mode (no separators, compacted blocks).
		const { controller, chatContainer } = createFixture();

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: assistantMessage([{ type: "thinking", thinking: "**dead attempt**" }]),
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		const orphan = chatContainer.children.at(-1) as Component & {
			isTranscriptBlockFinalized(): boolean;
		};
		expect(orphan.isTranscriptBlockFinalized()).toBe(false);

		// Retry attempt streams a fresh message without the dead one ever ending.
		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);

		expect(chatContainer.children).not.toContain(orphan);
		expect(orphan.isTranscriptBlockFinalized()).toBe(true);
	});

	it("retires pre-tool text before a live tool preview for an ordinary session", async () => {
		// A finalized leading block can be offered to native scrollback while the
		// following tool card stays live and grows with its streaming preview.
		const { controller, chatContainer } = createFixture();
		const toolCall: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_A_ID,
			name: "contract_probe_a",
			arguments: { value: "a" },
		};
		const message = assistantMessage([{ type: "text", text: INTRO_MARKER }, toolCall]);

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({ type: "message_update", message } as Extract<
			AgentSessionEvent,
			{ type: "message_update" }
		>);

		const leading = chatContainer.children[0] as Component & {
			isTranscriptBlockFinalized(): boolean;
		};
		expect(leading.isTranscriptBlockFinalized()).toBe(true);
		const retired = chatContainer.peekFinalizedBatch(120, 0);
		expect(retired?.rows.join("\n")).toContain(INTRO_MARKER);
		expect(retired?.rows.join("\n")).not.toContain("\x1b]133;A;aid=omp-response-");

		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect(leading.isTranscriptBlockFinalized()).toBe(true);
		expect(chatContainer.render(120).join("\n")).not.toContain("\x1b]133;A;aid=omp-response-");
	});

	it("keeps pre-tool text mutable until message_end when a transform hook exists", async () => {
		const { controller, chatContainer } = createFixture(false, true);
		const toolCall: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_A_ID,
			name: "contract_probe_a",
			arguments: { value: "preview" },
		};
		const preview = assistantMessage([{ type: "text", text: INTRO_MARKER }, toolCall]);
		const finalText = "FINAL TEXT AFTER TRANSFORM";
		const final = assistantMessage([{ type: "text", text: finalText }, toolCall]);

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({ type: "message_update", message: preview } as Extract<
			AgentSessionEvent,
			{ type: "message_update" }
		>);

		const leading = chatContainer.children[0] as Component & {
			isTranscriptBlockFinalized(): boolean;
		};
		expect(leading.isTranscriptBlockFinalized()).toBe(false);
		expect(chatContainer.peekFinalizedBatch(120, 0)).toBeUndefined();

		await controller.handleEvent({ type: "message_end", message: final } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect(leading.isTranscriptBlockFinalized()).toBe(true);
		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain(finalText);
		expect(rendered).not.toContain(INTRO_MARKER);
	});

	it("does not use pre-tool text when the final post-tool Markdown has no glyphs", async () => {
		const { controller, chatContainer } = createFixture();
		const toolCall: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_A_ID,
			name: "contract_probe_a",
			arguments: { value: "a" },
		};
		const message = assistantMessage([
			{ type: "text", text: INTRO_MARKER },
			toolCall,
			{ type: "text", text: "[hidden-reference]: https://example.test/reference" },
		]);

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({ type: "message_update", message } as Extract<
			AgentSessionEvent,
			{ type: "message_update" }
		>);
		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		const raw = chatContainer.render(120).join("\n");
		expect(Bun.stripANSI(raw)).toContain(INTRO_MARKER);
		expect(raw).not.toContain("\x1b]133;A;aid=omp-response-");
	});

	it("renders assistant text segments in order around two tool results from one mixed message", async () => {
		const { controller, chatContainer } = createFixture();
		const toolCallA: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_A_ID,
			name: "contract_probe_a",
			arguments: { value: "a" },
		};
		const toolCallB: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_B_ID,
			name: "contract_probe_b",
			arguments: { value: "b" },
		};
		(toolCallA as CursorExecResolvedCarrier)[kCursorExecResolved] = true;
		(toolCallB as CursorExecResolvedCarrier)[kCursorExecResolved] = true;
		const started = assistantMessage([]);
		const withFirstToolCall = assistantMessage([{ type: "text", text: INTRO_MARKER }, toolCallA]);
		const withSecondToolCall = assistantMessage([
			{ type: "text", text: INTRO_MARKER },
			toolCallA,
			{ type: "text", text: MIDDLE_MARKER },
			toolCallB,
		]);
		const completed = assistantMessage([
			{ type: "text", text: INTRO_MARKER },
			toolCallA,
			{ type: "text", text: MIDDLE_MARKER },
			toolCallB,
			{ type: "text", text: FINAL_MARKER },
		]);

		await controller.handleEvent({ type: "message_start", message: started } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: withFirstToolCall,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: toolCallA,
				partial: withFirstToolCall,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await controller.handleEvent({
			type: "message_update",
			message: withSecondToolCall,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 3,
				toolCall: toolCallB,
				partial: withSecondToolCall,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		const liveLines = chatContainer.render(120).map(line => Bun.stripANSI(line));
		expect(lineContaining(liveLines, INTRO_MARKER)).toBeLessThan(lineContaining(liveLines, MIDDLE_MARKER));
		expect(chatContainer.render(120).join("\n")).not.toContain("\x1b]133;A;aid=omp-response-");
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "contract_probe_a",
			args: { value: "a" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "contract_probe_a",
			result: { content: [{ type: "text", text: TOOL_RESULT_A_MARKER }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "contract_probe_b",
			args: { value: "b" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "contract_probe_b",
			result: { content: [{ type: "text", text: TOOL_RESULT_B_MARKER }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({ type: "message_end", message: completed } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
		const beforeTerminalSettle = chatContainer.render(120).join("\n");
		expect(beforeTerminalSettle).not.toContain("\x1b]133;A;aid=omp-response-");
		await settleTurn(controller, completed, false);
		expect(chatContainer.render(120).join("\n")).not.toContain("\x1b]133;A;aid=omp-response-");
		await settleAgent(controller, [completed], { responseAnchorTerminal: true });

		const rawLines = chatContainer.render(120);
		const lines = rawLines.map(line => Bun.stripANSI(line));
		const introLine = lineContaining(lines, INTRO_MARKER);
		const toolResultALine = lineContaining(lines, TOOL_RESULT_A_MARKER);
		const middleLine = lineContaining(lines, MIDDLE_MARKER);
		const toolResultBLine = lineContaining(lines, TOOL_RESULT_B_MARKER);
		const finalLine = lineContaining(lines, FINAL_MARKER);

		expect(introLine).toBeLessThan(toolResultALine);
		expect(toolResultALine).toBeLessThan(middleLine);
		expect(lines.filter(line => line.includes(MIDDLE_MARKER))).toHaveLength(1);
		expect(middleLine).toBeLessThan(toolResultBLine);
		expect(toolResultBLine).toBeLessThan(finalLine);
		const raw = rawLines.join("\n");
		expect(raw.split("\x1b]133;A;aid=omp-response-")).toHaveLength(2);
		expect(rawLines[introLine]).not.toContain("\x1b]133;");
		expect(rawLines[middleLine]).not.toContain("\x1b]133;");
		expect(String(rawLines[finalLine])).toContain("\x1b]133;A;aid=omp-response-");
	});

	it("waits for its own agent_end before terminalizing a resumed response", async () => {
		const { controller, chatContainer } = createFixture();
		const first = assistantMessage([{ type: "text", text: "DELAYED RESPONSE ONE" }], {
			responseAnchorId: "response-one",
		});
		const second = assistantMessage([{ type: "text", text: "RESUMED RESPONSE TWO" }], {
			responseAnchorId: "response-two",
		});
		const firstAnchor = ":response-one\x07";
		const secondAnchor = ":response-two\x07";

		await controller.handleEvent({ type: "message_start", message: { ...first, content: [] } });
		await controller.handleEvent({ type: "message_end", message: first });
		await controller.handleEvent({ type: "message_start", message: { ...second, content: [] } });
		await controller.handleEvent({ type: "message_end", message: second });

		// A nonterminal old settle cannot consume the newer response candidate.
		await settleAgent(controller, [first], {
			isTerminal: false,
			responseAnchorId: "response-one",
			responseAnchorTerminal: false,
		});
		expect(chatContainer.render(120).join("\n")).not.toContain(secondAnchor);

		// Its delayed terminal event must not terminalize the newer response either.
		await settleAgent(controller, [first], {
			responseAnchorId: "response-one",
			responseAnchorTerminal: true,
		});
		expect(chatContainer.render(120).join("\n")).not.toContain(secondAnchor);

		// Without a durable id, legacy delivery may settle only its exact response.
		await settleAgent(controller, [first], { responseAnchorTerminal: true });
		expect(chatContainer.render(120).join("\n")).not.toContain(secondAnchor);

		await settleAgent(controller, [second], {
			responseAnchorId: "response-two",
			responseAnchorTerminal: true,
		});

		const raw = chatContainer.render(120).join("\n");
		expect(raw).not.toContain(firstAnchor);
		expect(raw).toContain(secondAnchor);
		expect(raw.split("\x1b]133;A;aid=omp-response-")).toHaveLength(2);
	});

	it("keeps post-tool components distinct for consecutive responses that reuse a call index", async () => {
		const { controller, chatContainer } = createFixture();
		const firstReply = "FIRST POST-TOOL RESPONSE";
		const secondReply = "SECOND POST-TOOL RESPONSE";
		const firstToolCall: ToolCall = {
			type: "toolCall",
			id: "toolu_first_response_call",
			name: "contract_probe_a",
			arguments: { value: "first" },
		};
		const secondToolCall: ToolCall = {
			type: "toolCall",
			id: "toolu_second_response_call",
			name: "contract_probe_a",
			arguments: { value: "second" },
		};
		(firstToolCall as CursorExecResolvedCarrier)[kCursorExecResolved] = true;
		(secondToolCall as CursorExecResolvedCarrier)[kCursorExecResolved] = true;
		const first = assistantMessage([firstToolCall, { type: "text", text: firstReply }]);
		const second = assistantMessage([secondToolCall, { type: "text", text: secondReply }]);

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
		await controller.handleEvent({
			type: "message_update",
			message: first,
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await controller.handleEvent({ type: "message_end", message: first });
		const firstComponent = chatContainer.children.find(child =>
			Bun.stripANSI(child.render(120).join("\n")).includes(firstReply),
		);
		if (!firstComponent) throw new Error("Expected first post-tool assistant component");
		await settleTurn(controller, first, true);

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
		await controller.handleEvent({
			type: "message_update",
			message: second,
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await controller.handleEvent({ type: "message_end", message: second });
		const secondComponent = chatContainer.children.find(child =>
			Bun.stripANSI(child.render(120).join("\n")).includes(secondReply),
		);
		if (!secondComponent) throw new Error("Expected second post-tool assistant component");
		expect(secondComponent).not.toBe(firstComponent);
		await settleTurn(controller, second, false);
		await settleAgent(controller, [first, second], { responseAnchorTerminal: true });

		const firstRaw = firstComponent.render(120).join("\n");
		const secondRaw = secondComponent.render(120).join("\n");
		const raw = chatContainer.render(120).join("\n");
		expect(Bun.stripANSI(firstRaw)).toContain(firstReply);
		expect(Bun.stripANSI(secondRaw)).toContain(secondReply);
		expect(Bun.stripANSI(raw).indexOf(firstReply)).toBeLessThan(Bun.stripANSI(raw).indexOf(secondReply));
		expect(firstRaw).not.toContain("\x1b]133;A;aid=omp-response-");
		expect(secondRaw).toContain("\x1b]133;A;aid=omp-response-");
		expect(raw.split("\x1b]133;A;aid=omp-response-")).toHaveLength(2);
	});

	it("anchors only the final reply after a local-tool continuation", async () => {
		const { controller, chatContainer } = createFixture();
		const toolCall: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_A_ID,
			name: "contract_probe_a",
			arguments: { value: "a" },
		};
		const progress = assistantMessage([toolCall, { type: "text", text: "LOCAL TOOL PROGRESS" }], {
			stopReason: "toolUse",
		});
		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
		await controller.handleEvent({ type: "message_end", message: progress });
		expect(chatContainer.render(120).join("\n")).not.toContain("\x1b]133;");
		await settleTurn(controller, progress, true);
		expect(chatContainer.render(120).join("\n")).not.toContain("\x1b]133;");

		const final = assistantMessage([{ type: "text", text: "LOCAL TOOL FINAL" }]);
		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
		await controller.handleEvent({ type: "message_end", message: final });
		await settleTurn(controller, final, false);
		expect(chatContainer.render(120).join("\n")).not.toContain("\x1b]133;");
		await settleAgent(controller, [progress, final], { responseAnchorTerminal: true });

		const raw = chatContainer.render(120).join("\n");
		expect(raw.split("\x1b]133;A;aid=omp-response-")).toHaveLength(2);
		expect(raw).toContain("LOCAL TOOL FINAL");
	});

	it("does not anchor a pause_turn progress reply before the resumed final reply", async () => {
		const { controller, chatContainer } = createFixture();
		const paused = assistantMessage([{ type: "text", text: "PAUSED PROGRESS" }], {
			stopDetails: { type: "pause_turn" },
		});
		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
		await controller.handleEvent({ type: "message_end", message: paused });
		await settleTurn(controller, paused, true);
		expect(chatContainer.render(120).join("\n")).not.toContain("\x1b]133;");

		const final = assistantMessage([{ type: "text", text: "PAUSE FINAL" }]);
		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
		await controller.handleEvent({ type: "message_end", message: final });
		await settleTurn(controller, final, false);
		await settleAgent(controller, [paused, final], { responseAnchorTerminal: true });

		const raw = chatContainer.render(120).join("\n");
		expect(raw.split("\x1b]133;A;aid=omp-response-")).toHaveLength(2);
		expect(raw).toContain("PAUSE FINAL");
	});

	it("does not anchor a length-truncated reply during incomplete recovery", async () => {
		const { controller, chatContainer } = createFixture();
		const truncated = assistantMessage([{ type: "text", text: "TRUNCATED REPLY" }], {
			stopReason: "length",
		});
		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
		await controller.handleEvent({ type: "message_end", message: truncated });
		await settleTurn(controller, truncated, false);
		await settleAgent(controller, [truncated], { isTerminal: false, responseAnchorTerminal: false });

		expect(chatContainer.render(120).join("\n")).not.toContain("\x1b]133;");
	});

	it("keeps assistant text streaming while hiding bash failures and grouped read activity", async () => {
		const { controller, chatContainer } = createFixture(true);
		const bashCall: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_A_ID,
			name: "bash",
			arguments: { command: `printf '${HIDDEN_BASH_COMMAND_MARKER}'` },
		};
		const readCall: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_B_ID,
			name: "read",
			arguments: { path: HIDDEN_READ_PATH_MARKER },
		};
		const started = assistantMessage([]);
		const streaming = assistantMessage([
			{ type: "text", text: INTRO_MARKER },
			bashCall,
			{ type: "text", text: MIDDLE_MARKER },
			readCall,
			{ type: "text", text: FINAL_MARKER },
		]);

		await controller.handleEvent({ type: "message_start", message: started } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 3,
				toolCall: readCall,
				partial: streaming,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "bash",
			args: bashCall.arguments,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "bash",
			result: { content: [{ type: "text", text: HIDDEN_BASH_FAILURE_MARKER }] },
			isError: true,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "read",
			args: readCall.arguments,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "read",
			result: { content: [{ type: "text", text: "read result must stay hidden" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({ type: "message_end", message: streaming } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain(INTRO_MARKER);
		expect(rendered).toContain(MIDDLE_MARKER);
		expect(rendered).toContain(FINAL_MARKER);
		expect(rendered).not.toContain(HIDDEN_BASH_COMMAND_MARKER);
		expect(rendered).not.toContain(HIDDEN_BASH_FAILURE_MARKER);
		expect(rendered).not.toContain(HIDDEN_READ_PATH_MARKER);
	});
});
