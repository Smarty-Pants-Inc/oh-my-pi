import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { CapabilityGrantProvenance } from "../capability/session-capabilities";
import capabilityGrantDescription from "../prompts/tools/capability-grant.md" with { type: "text" };
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const capabilityGrantSchema = type({
	kind: "'writePath' | 'externalCapability'",
	value: type("string > 0").describe("exact path or exact named external capability"),
	"+": "reject",
});

type CapabilityGrantInput = typeof capabilityGrantSchema.infer;

export class CapabilityGrantTool implements AgentTool<typeof capabilityGrantSchema, CapabilityGrantProvenance> {
	readonly name = "capability_grant";
	readonly label = "Capability Grant";
	readonly loadMode = "essential" as const;
	readonly approval = "read" as const;
	readonly description = capabilityGrantDescription.trim();
	readonly parameters = capabilityGrantSchema;
	readonly strict = true;

	constructor(readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: CapabilityGrantInput,
	): Promise<AgentToolResult<CapabilityGrantProvenance>> {
		try {
			const details = this.session.capabilities?.grantFromCurrentDirectUserTurn(params, this.session.cwd);
			if (!details) throw new Error("session capability boundary is unavailable");
			return { content: [{ type: "text", text: `Granted ${details.kind}: ${details.value}` }], details };
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
	}
}
