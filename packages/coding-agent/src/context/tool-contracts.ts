import { type Tool, toolWireSchema } from "@oh-my-pi/pi-ai";
import { Settings } from "../config/settings";
import { BUILTIN_TOOLS, HIDDEN_TOOLS, type ToolSession } from "../tools";
import { canonicalJson, sha256 } from "./canonical";

function manifestSession(): ToolSession {
	return {
		cwd: "/workspace",
		hasUI: false,
		settings: Settings.isolated({
			"tools.xdev": false,
			"task.isolation.mode": "auto",
			"security.enabled": true,
			"autolearn.enabled": true,
			"memory.backend": "mnemopi",
			"inspect_image.enabled": true,
		}),
		skipPythonPreflight: true,
		enableIrc: true,
		enableMCP: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getGoalRuntime: () => ({}) as never,
	};
}

/** Builds the tool-description and input-schema portion of the protected content manifest. */
export async function buildToolContractManifest(): Promise<
	Array<{ id: string; descriptionSha256: string; schemaSha256: string }>
> {
	const session = manifestSession();
	const tools: Tool[] = [];
	for (const [name, factory] of Object.entries({ ...BUILTIN_TOOLS, ...HIDDEN_TOOLS }).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const tool = await factory(session);
		if (!tool) continue;
		if (tool.name !== name) throw new Error(`tool factory ${name} produced ${tool.name}`);
		tools.push(tool as Tool);
	}
	return tools
		.map(tool => ({
			id: `tool.${tool.name}`,
			descriptionSha256: sha256(tool.description),
			schemaSha256: sha256(canonicalJson(toolWireSchema(tool) as never)),
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
}
