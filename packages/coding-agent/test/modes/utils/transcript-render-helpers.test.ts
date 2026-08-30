import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import {
	assistantUsageIsBilled,
	splitAssistantMessageToolTimeline,
} from "../../../src/modes/utils/transcript-render-helpers";

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
	};
}

function cursorResolvedToolCall(id: string, name: string): ToolCall {
	const toolCall: ToolCall = { type: "toolCall", id, name, arguments: {}, cursorExecResolved: true };
	(toolCall as CursorExecResolvedCarrier)[kCursorExecResolved] = true;
	return toolCall;
}

describe("assistantUsageIsBilled", () => {
	it("suppresses the token badge only for turns that consumed nothing", () => {
		expect(assistantUsageIsBilled(usage())).toBe(false);
	});

	it("preserves cost transparency for empty replies whose prompt still cost input tokens", () => {
		expect(assistantUsageIsBilled(usage({ input: 321 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ output: 0, cacheRead: 512 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ cacheWrite: 128 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ premiumRequests: 1 }))).toBe(true);
	});

	// Documents the live/resume parity contract for #4532: both paths ask
	// `assistantUsageIsBilled` about `message.usage`, so an empty automated
	// reply that still cost input tokens renders identically on both surfaces.
	it("matches whether the assistant carrier renders visible content", () => {
		const emptyBilledMessage: Pick<AssistantMessage, "usage"> = { usage: usage({ input: 321 }) };
		const emptyFreeMessage: Pick<AssistantMessage, "usage"> = { usage: usage() };
		expect(assistantUsageIsBilled(emptyBilledMessage.usage)).toBe(true);
		expect(assistantUsageIsBilled(emptyFreeMessage.usage)).toBe(false);
	});
});

describe("splitAssistantMessageToolTimeline response navigation", () => {
	it("selects only text after the final Cursor-resolved tool call as the reply stop", () => {
		const timeline = splitAssistantMessageToolTimeline(
			assistant([
				{ type: "thinking", thinking: "reasoning before the reply" },
				{ type: "text", text: "intro" },
				cursorResolvedToolCall("a", "read"),
				{ type: "thinking", thinking: "more reasoning" },
				{ type: "text", text: "middle" },
				cursorResolvedToolCall("b", "bash"),
				{ type: "text", text: "final reply" },
			]),
		);

		expect(timeline.replySegment?.content).toEqual([{ type: "text", text: "final reply" }]);
		expect(
			splitAssistantMessageToolTimeline(
				assistant([
					{ type: "text", text: "intro" },
					cursorResolvedToolCall("a", "read"),
					{ type: "text", text: "middle after the first tool" },
					cursorResolvedToolCall("b", "bash"),
				]),
			).replySegment,
		).toBeUndefined();
	});

	it("requires explicit terminality for a replay response anchor", () => {
		const terminal = assistant([{ type: "text", text: "final reply" }]);
		terminal.responseAnchorTerminal = true;
		const nonterminal = assistant([{ type: "text", text: "scheduled continuation" }]);
		nonterminal.responseAnchorTerminal = false;

		expect(splitAssistantMessageToolTimeline(terminal).terminalReplySegment?.content).toEqual([
			{ type: "text", text: "final reply" },
		]);
		expect(splitAssistantMessageToolTimeline(nonterminal).terminalReplySegment).toBeUndefined();
		expect(
			splitAssistantMessageToolTimeline(assistant([{ type: "text", text: "legacy unknown" }])).terminalReplySegment,
		).toBeUndefined();
	});

	it("keeps a terminal Cursor reply eligible after JSON replay drops its live marker", () => {
		const replayed = JSON.parse(
			JSON.stringify(
				assistant([cursorResolvedToolCall("cursor", "bash"), { type: "text", text: "replayed reply" }]),
			),
		) as AssistantMessage;
		const replayedToolCall = replayed.content.find((content): content is ToolCall => content.type === "toolCall");
		if (!replayedToolCall) throw new Error("Expected replayed Cursor tool call");

		expect((replayedToolCall as CursorExecResolvedCarrier)[kCursorExecResolved]).toBeUndefined();
		expect(replayedToolCall.cursorExecResolved).toBe(true);
		expect(splitAssistantMessageToolTimeline(replayed).replySegment?.content).toEqual([
			{ type: "text", text: "replayed reply" },
		]);
	});

	it("does not turn stripped local-tool progress into a terminal reply", () => {
		const rebuilt = {
			...assistant([{ type: "text", text: "local progress after stripped call" }]),
			strippedToolCalls: 1,
		};

		expect(splitAssistantMessageToolTimeline(rebuilt).replySegment).toBeUndefined();
	});

	it("keeps a hidden final post-tool segment instead of falling back to pre-tool text", () => {
		const timeline = splitAssistantMessageToolTimeline(
			assistant([
				{ type: "text", text: "visible text before the tool" },
				cursorResolvedToolCall("a", "read"),
				{ type: "text", text: "[hidden-reference]: https://example.test/reference" },
			]),
		);

		expect(timeline.replySegment).toBe(timeline.afterToolCalls.get("a"));
		expect(timeline.replySegment).not.toBe(timeline.beforeTools);
	});

	it("does not select interrupted, failed, truncated, or paused progress as a reply stop", () => {
		const aborted = assistant([{ type: "text", text: "partial before interrupt" }]);
		aborted.stopReason = "aborted";
		const failed = assistant([{ type: "text", text: "partial before provider error" }]);
		failed.stopReason = "error";
		const truncated = assistant([{ type: "text", text: "partial at token limit" }]);
		truncated.stopReason = "length";
		const paused = assistant([{ type: "text", text: "progress before pause" }]);
		paused.stopDetails = { type: "pause_turn" };

		expect(splitAssistantMessageToolTimeline(aborted).replySegment).toBeUndefined();
		expect(splitAssistantMessageToolTimeline(failed).replySegment).toBeUndefined();
		expect(splitAssistantMessageToolTimeline(truncated).replySegment).toBeUndefined();
		expect(splitAssistantMessageToolTimeline(paused).replySegment).toBeUndefined();
	});

	it("rejects a local tool continuation but preserves a terminal Cursor-resolved tool reply", () => {
		const local = assistant([
			{ type: "toolCall", id: "local", name: "read", arguments: {} },
			{ type: "text", text: "local progress" },
		]);
		const cursorResolved = assistant([
			cursorResolvedToolCall("cursor", "read"),
			{ type: "text", text: "terminal Cursor reply" },
		]);

		expect(splitAssistantMessageToolTimeline(local).replySegment).toBeUndefined();
		expect(splitAssistantMessageToolTimeline(cursorResolved).replySegment?.content).toEqual([
			{ type: "text", text: "terminal Cursor reply" },
		]);
	});
});
