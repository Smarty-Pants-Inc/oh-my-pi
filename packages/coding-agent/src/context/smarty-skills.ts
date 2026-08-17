import type { ContextInstruction } from "@oh-my-pi/pi-ai";
import { renderInstruction } from "./registry";

export const SMARTY_MERGIFY_SKILLS = ["mergify-config", "mergify-merge-queue", "mergify-merge-protections"] as const;

const skillNames = new Set<string>(SMARTY_MERGIFY_SKILLS);

type SkillMessage = {
	role: string;
	customType?: string;
	details?: unknown;
	content?: unknown;
};

/** Returns the later OMP-owned policy wrapper while an official Mergify skill body is in context. */
export function smartyMergifySkillInstruction(
	messages: readonly SkillMessage[],
	target: "main" | "subagent",
): ContextInstruction | undefined {
	const selected = messages.some(message => {
		if (message.role !== "custom" || message.customType !== "skill-prompt") return false;
		const details = message.details;
		return (
			details !== null &&
			typeof details === "object" &&
			"name" in details &&
			typeof details.name === "string" &&
			skillNames.has(details.name)
		);
	});
	return selected ? renderInstruction("skill.smarty_mergify_policy", {}, target) : undefined;
}
