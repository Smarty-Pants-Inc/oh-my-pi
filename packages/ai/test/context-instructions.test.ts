import { describe, expect, it } from "bun:test";
import {
	mapContextInstructions,
	mapContextInstructionsForModel,
	supportsDeveloperRoleForContext,
} from "@oh-my-pi/pi-ai/context-instructions";
import type { ContextInstruction, ContextRole, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function instruction(role: ContextRole, renderedText: string): ContextInstruction {
	return {
		id: `test.${role}`,
		sourcePath: `prompts/${role}.md`,
		role,
		target: "main",
		trigger: "test",
		sha256: `sha-${role}`,
		renderedText,
	};
}

describe("context instruction mapping", () => {
	it("preserves provenance and order while selecting only provider instruction roles", () => {
		const instructions = [
			instruction("system", "system text"),
			instruction("developer", "developer text"),
			instruction("internal_context", "internal text"),
		];

		expect(mapContextInstructions(instructions, true)).toEqual([
			{ ...instructions[0], actualRole: "system", providerOrder: 0 },
			{ ...instructions[1], actualRole: "developer", providerOrder: 1 },
			{ ...instructions[2], actualRole: "developer", providerOrder: 2 },
		]);
		expect(mapContextInstructions(instructions, false).map(item => item.actualRole)).toEqual([
			"system",
			"system",
			"system",
		]);
	});

	it("uses resolved model compatibility instead of provider-name inference", () => {
		const model = buildModel({
			id: "custom-openai-model",
			name: "Custom OpenAI Model",
			api: "openai-completions",
			provider: "openai-compatible-without-developer-role",
			baseUrl: "https://example.test/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
			compat: { supportsDeveloperRole: false },
		} satisfies ModelSpec<"openai-completions">);

		expect(supportsDeveloperRoleForContext(model)).toBe(false);
		expect(
			mapContextInstructionsForModel([instruction("internal_context", "internal text")], model)[0]?.actualRole,
		).toBe("system");
	});
});
