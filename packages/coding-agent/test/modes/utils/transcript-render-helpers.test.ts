import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
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
	it("selects only the final non-empty text segment as the reply stop", () => {
		const timeline = splitAssistantMessageToolTimeline(
			assistant([
				{ type: "thinking", thinking: "reasoning before the reply" },
				{ type: "text", text: "intro" },
				{ type: "toolCall", id: "a", name: "read", arguments: {} },
				{ type: "thinking", thinking: "more reasoning" },
				{ type: "text", text: "middle" },
				{ type: "toolCall", id: "b", name: "bash", arguments: {} },
				{ type: "text", text: "final reply" },
			]),
		);

		expect(timeline.replySegment?.content).toEqual([{ type: "text", text: "final reply" }]);
		expect(
			splitAssistantMessageToolTimeline(
				assistant([
					{ type: "thinking", thinking: "reasoning only" },
					{ type: "toolCall", id: "only-tool", name: "read", arguments: {} },
				]),
			).replySegment,
		).toBeUndefined();
	});

	it("does not select aborted or failed partial text as a finalized reply stop", () => {
		const aborted = assistant([{ type: "text", text: "partial before interrupt" }]);
		aborted.stopReason = "aborted";
		const failed = assistant([{ type: "text", text: "partial before provider error" }]);
		failed.stopReason = "error";

		expect(splitAssistantMessageToolTimeline(aborted).replySegment).toBeUndefined();
		expect(splitAssistantMessageToolTimeline(failed).replySegment).toBeUndefined();
	});
});
