import { describe, expect, it } from "bun:test";
import { mapContextInstructions } from "@oh-my-pi/pi-ai";
import { smartyMergifySkillInstruction } from "../../src/context/smarty-skills";

describe("Smarty Mergify selected-skill policy", () => {
	it("adds a later registered internal-context wrapper without changing the external body", () => {
		const externalBody = "official exact bytes";
		const instruction = smartyMergifySkillInstruction(
			[
				{
					role: "custom",
					customType: "skill-prompt",
					details: { name: "mergify-merge-queue" },
					content: externalBody,
				},
			],
			"main",
		);

		expect(instruction?.id).toBe("skill.smarty_mergify_policy");
		expect(instruction?.role).toBe("internal_context");
		expect(instruction?.order).toBe(520);
		expect(instruction?.renderedText).toContain("mutation through `/smarty-land`");
		expect(mapContextInstructions([instruction!], true)[0]?.actualRole).toBe("developer");
		expect(externalBody).toBe("official exact bytes");
	});

	it("does not wrap unrelated skills", () => {
		expect(
			smartyMergifySkillInstruction(
				[{ role: "custom", customType: "skill-prompt", details: { name: "typescript" } }],
				"main",
			),
		).toBeUndefined();
	});
});
