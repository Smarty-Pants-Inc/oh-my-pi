import type { Api, ContextInstruction, ContextRole, Model } from "./types";

export type ContextWireRole = "system" | "developer";

/** An instruction plus its selected provider role and exact emission order. */
export interface MappedContextInstruction extends ContextInstruction {
	actualRole: ContextWireRole;
	providerOrder: number;
}

/** Exact provider compatibility used when selecting an instruction wire role. */
export function supportsDeveloperRoleForContext<TApi extends Api>(
	model: Pick<Model<TApi>, "api" | "compat">,
	resolvedSupportsDeveloperRole?: boolean,
): boolean {
	if (model.api === "openai-codex-responses") return true;
	if (
		model.api !== "openai-completions" &&
		model.api !== "openai-responses" &&
		model.api !== "azure-openai-responses" &&
		model.api !== "openrouter"
	) {
		return false;
	}
	if (resolvedSupportsDeveloperRole !== undefined) return resolvedSupportsDeveloperRole;
	const compat: unknown = model.compat;
	return (
		typeof compat === "object" &&
		compat !== null &&
		"supportsDeveloperRole" in compat &&
		compat.supportsDeveloperRole === true
	);
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

/** Map typed instructions with the same resolved policy used by the live provider. */
export function mapContextInstructionsForModel<TApi extends Api>(
	instructions: readonly ContextInstruction[] | undefined,
	model: Pick<Model<TApi>, "api" | "compat">,
): MappedContextInstruction[] {
	return mapContextInstructions(instructions, supportsDeveloperRoleForContext(model));
}
