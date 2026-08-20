import { describe, expect, test } from "bun:test";
import { generateSummary, type SummaryOptions } from "@oh-my-pi/pi-agent-core/compaction";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Context, Model, Usage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const MODEL: Model = buildModel({
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 20_000,
	maxTokens: 4_000,
});

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function internalContextPrompt(ctx: Context): string {
	expect(ctx.messages).toEqual([]);
	const instruction = ctx.instructions?.[0];
	if (instruction?.role !== "internal_context") throw new Error("summary request lacked internal context");
	return instruction.renderedText;
}

function assistantResponse(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: MODEL.id,
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function oversizedResponse(): AssistantMessage {
	return {
		...assistantResponse(""),
		stopReason: "error",
		errorStatus: 400,
		errorMessage: "prompt is too long",
	};
}

function conversationChunk(prompt: string): string {
	const prefix = "<conversation>\n";
	const suffix = "\n</conversation>\n\n";
	const end = prompt.indexOf(suffix, prefix.length);
	if (!prompt.startsWith(prefix) || end < 0) throw new Error("summary prompt did not contain conversation tags");
	return prompt.slice(prefix.length, end);
}

describe("compaction summary input budgeting", () => {
	test("summarizes oversized history in bounded ordered chunks", async () => {
		const payload = `HISTORY_SENTINEL_4076=${"x".repeat(80_000)}`;
		const messages: AgentMessage[] = [{ role: "user", content: payload, timestamp: Date.now() }];
		const attempts: string[] = [];
		const prompts: string[] = [];
		const completeImpl: NonNullable<SummaryOptions["completeImpl"]> = async (_model, ctx) => {
			const prompt = internalContextPrompt(ctx);
			attempts.push(prompt);
			if (Buffer.byteLength(prompt, "utf8") >= MODEL.contextWindow!) return oversizedResponse();
			prompts.push(prompt);
			return assistantResponse(`summary-${prompts.length}`);
		};

		const summary = await generateSummary(messages, MODEL, 1_000, "test-api-key", undefined, undefined, undefined, {
			completeImpl,
		});

		expect(attempts).toEqual(prompts);
		expect(attempts.every(prompt => Buffer.byteLength(prompt, "utf8") < MODEL.contextWindow!)).toBe(true);
		expect(prompts.length).toBeGreaterThan(1);
		expect(summary).toBe(`summary-${prompts.length}`);
		expect(prompts.every(prompt => Buffer.byteLength(prompt, "utf8") < MODEL.contextWindow!)).toBe(true);
		expect(prompts.map(conversationChunk).join("")).toContain(payload);
		for (let i = 1; i < prompts.length; i++) {
			expect(prompts[i]).toContain(`<previous-summary>\nsummary-${i}\n</previous-summary>`);
		}
	});
});
