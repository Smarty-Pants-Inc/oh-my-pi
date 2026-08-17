import { describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig } from "@oh-my-pi/pi-agent-core/types";
import { mapContextInstructions } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	defaultConvertToLlm,
} from "../src/compaction/messages";

describe("compaction semantic context", () => {
	it("sends persisted summaries as internal_context and never as user text", async () => {
		const now = new Date().toISOString();
		const context: AgentContext = {
			systemPrompt: ["base"],
			messages: [
				createBranchSummaryMessage("branch facts", "old", now),
				createCompactionSummaryMessage("compacted facts", 10_000, now),
			],
			tools: [],
		};
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const config: AgentLoopConfig = {
			model: mock.model,
			contextTarget: "subagent",
			convertToLlm: defaultConvertToLlm,
		};
		const directUser = { role: "user" as const, content: "direct request", timestamp: Date.now() };
		const stream = agentLoop([directUser], context, config, undefined, mock.stream);
		for await (const _event of stream) {
			// Drain the run.
		}
		await stream.result();

		const call = mock.calls[0]?.context;
		expect(call?.messages).toHaveLength(1);
		expect(call?.messages[0]).toMatchObject(directUser);
		expect(call?.messages.some(message => JSON.stringify(message).includes("compacted facts"))).toBe(false);
		expect(call?.instructions?.map(instruction => instruction.role)).toEqual([
			"internal_context",
			"internal_context",
		]);
		expect(call?.instructions?.map(instruction => instruction.target)).toEqual(["subagent", "subagent"]);
		expect(call?.instructions?.map(instruction => instruction.renderedText).join("\n")).toContain("branch facts");
		expect(call?.instructions?.map(instruction => instruction.renderedText).join("\n")).toContain("compacted facts");

		const instructions = call?.instructions ?? [];
		expect(
			mapContextInstructions(instructions, true).every(instruction => instruction.actualRole === "developer"),
		).toBe(true);
		expect(
			mapContextInstructions(instructions, false).every(instruction => instruction.actualRole === "system"),
		).toBe(true);
	});
});
