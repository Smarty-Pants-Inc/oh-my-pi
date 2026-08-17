import { describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import type { ContextInstruction, Model } from "@oh-my-pi/pi-ai";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { GetUserJwtResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import { sha256 } from "../../src/context/canonical";
import { captureRuntimeContextEvidence } from "../../src/context/explain";

function instruction(renderedText: string): ContextInstruction {
	return {
		id: "system.date-cwd-reminder",
		sourcePath: "packages/coding-agent/src/prompts/system/date-cwd-reminder.md",
		role: "internal_context",
		target: "main",
		trigger: "provider_request",
		sha256: sha256(renderedText),
		renderedText,
		order: 10,
	};
}

describe("final provider payload context evidence", () => {
	it("decodes Cursor rootPromptMessagesJson and binds the exact typed instruction", async () => {
		const model: Model<"cursor-agent"> = buildModel({
			id: "cursor-evidence",
			name: "Cursor evidence",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8_192,
			maxTokens: 1_024,
		});
		const candidate = instruction("exact Cursor internal context");
		let evidence: ReturnType<typeof captureRuntimeContextEvidence> | undefined;
		const result = await streamCursor(
			model,
			{
				systemPrompt: ["exact Cursor system prompt"],
				instructions: [candidate],
				messages: [{ role: "user", content: "real direct user input", timestamp: 1 }],
			},
			{
				apiKey: "test-token",
				onPayload(payload, payloadModel) {
					evidence = captureRuntimeContextEvidence(payload, payloadModel ?? model, "main", [candidate]);
					throw new Error("stop after exact Cursor payload evidence");
				},
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(evidence?.instructions?.map(item => item.id)).toEqual([
			"runtime.system_prompt.0",
			"system.date-cwd-reminder",
		]);
		expect(evidence?.instructions?.[1]).toMatchObject({
			role: "internal_context",
			trigger: "provider_request",
			renderedText: candidate.renderedText,
		});
	});

	it("splits Devin's exact flattened prompt without inventing user authority", async () => {
		const model: Model<"devin-agent"> = buildModel({
			id: "devin-evidence",
			name: "Devin evidence",
			api: "devin-agent",
			provider: "devin",
			baseUrl: "https://server.codeium.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8_192,
			maxTokens: 1_024,
		});
		const candidate = instruction("exact Devin internal context");
		const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "test-jwt" }));
		let evidence: ReturnType<typeof captureRuntimeContextEvidence> | undefined;
		const result = await streamDevin(
			model,
			{
				systemPrompt: ["exact Devin system prompt"],
				instructions: [candidate],
				messages: [{ role: "user", content: "real direct user input", timestamp: 1 }],
			},
			{
				apiKey: "test-token",
				fetch: (async input => {
					if (String(input).includes("GetUserJwt")) return new Response(authPayload);
					throw new Error("chat request must not be sent after the evidence stop");
				}) as typeof fetch,
				onPayload(payload, payloadModel) {
					evidence = captureRuntimeContextEvidence(payload, payloadModel ?? model, "main", [candidate]);
					throw new Error("stop after exact Devin payload evidence");
				},
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(evidence?.instructions?.map(item => item.id)).toEqual([
			"runtime.system_prompt.0",
			"system.date-cwd-reminder",
		]);
		expect(evidence?.instructions?.[1]).toMatchObject({
			role: "internal_context",
			trigger: "provider_request",
			renderedText: candidate.renderedText,
		});
	});
});
