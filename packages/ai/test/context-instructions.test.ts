import { describe, expect, it } from "bun:test";
import { mapContextInstructions } from "@oh-my-pi/pi-ai/context-instructions";
import type { ContextInstruction, ContextRole } from "@oh-my-pi/pi-ai/types";

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
});
