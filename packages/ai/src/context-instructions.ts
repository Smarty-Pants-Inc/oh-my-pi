import type { ContextInstruction, ContextRole } from "./types";

export type ContextWireRole = "system" | "developer";

/** An instruction plus its selected provider role and exact emission order. */
export interface MappedContextInstruction extends ContextInstruction {
	actualRole: ContextWireRole;
	providerOrder: number;
}

/** Map semantic authority to a provider instruction channel, never a user channel. */
export function mapContextRole(role: ContextRole, supportsDeveloperRole: boolean): ContextWireRole {
	if (role === "system") return "system";
	return supportsDeveloperRole ? "developer" : "system";
}

/**
 * Select wire roles without changing rendered bytes or provenance. Empty
 * rendered components are omitted because provider instruction fields reject
 * them; `providerOrder` identifies the resulting payload order.
 */
export function mapContextInstructions(
	instructions: readonly ContextInstruction[] | undefined,
	supportsDeveloperRole: boolean,
): MappedContextInstruction[] {
	if (!instructions?.length) return [];
	const mapped: MappedContextInstruction[] = [];
	for (const instruction of instructions) {
		if (instruction.renderedText.trim().length === 0) continue;
		mapped.push({
			...instruction,
			actualRole: mapContextRole(instruction.role, supportsDeveloperRole),
			providerOrder: mapped.length,
		});
	}
	return mapped;
}
