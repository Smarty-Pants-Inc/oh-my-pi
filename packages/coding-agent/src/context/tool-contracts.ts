import type { Tool } from "@oh-my-pi/pi-ai";
import generatedContractsSource from "../../generated/tool-contracts.json" with { type: "text" };
import { canonicalJson, sha256 } from "./canonical";

export interface ToolContractManifestEntry {
	id: string;
	descriptionSha256: string;
	schemaSha256: string;
}

interface GeneratedToolContract {
	id: string;
	description: string;
	schema: unknown;
}

interface GeneratedToolContracts {
	schema: "omp.tool_contracts.v1";
	tools: GeneratedToolContract[];
	rootSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
	const expected = [...keys].sort((left, right) => left.localeCompare(right));
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const trackedContractsSource =
	typeof generatedContractsSource === "string" ? generatedContractsSource : JSON.stringify(generatedContractsSource);

export function parseGeneratedToolContracts(source = trackedContractsSource): GeneratedToolContracts {
	const value: unknown = JSON.parse(source);
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["schema", "tools", "rootSha256"]) ||
		value.schema !== "omp.tool_contracts.v1" ||
		!Array.isArray(value.tools) ||
		typeof value.rootSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.rootSha256)
	) {
		throw new Error("generated tool contracts have an invalid schema");
	}
	const payload = { schema: value.schema, tools: value.tools };
	if (sha256(canonicalJson(payload as never)) !== value.rootSha256) {
		throw new Error("generated tool contracts root does not match its payload");
	}
	for (const [index, tool] of value.tools.entries()) {
		if (
			!isRecord(tool) ||
			!hasExactKeys(tool, ["id", "description", "schema"]) ||
			typeof tool.id !== "string" ||
			!/^tool\.[a-z0-9_]+$/.test(tool.id) ||
			typeof tool.description !== "string"
		) {
			throw new Error(`generated tool contract ${index} is invalid`);
		}
	}
	const contracts = value.tools as GeneratedToolContract[];
	const ids = contracts.map(tool => tool.id);
	if (
		new Set(ids).size !== ids.length ||
		ids.some((id, index) => index > 0 && ids[index - 1]!.localeCompare(id) > 0)
	) {
		throw new Error("generated tool contracts must have sorted unique ids");
	}
	return value as unknown as GeneratedToolContracts;
}

/** Native-free verification of the exact generated descriptions and wire schemas. */
export function buildGeneratedToolContractManifest(): ToolContractManifestEntry[] {
	return parseGeneratedToolContracts().tools.map(tool => ({
		id: tool.id,
		descriptionSha256: sha256(tool.description),
		schemaSha256: sha256(canonicalJson(tool.schema as never)),
	}));
}

async function manifestSession() {
	const [{ Settings }, { SessionCapabilities }] = await Promise.all([
		import("../config/settings"),
		import("../capability/session-capabilities"),
	]);
	return {
		cwd: "/workspace",
		hasUI: true,
		capabilities: new SessionCapabilities({ workspace: "/workspace" }),
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
export async function buildToolContractManifest(): Promise<ToolContractManifestEntry[]> {
	const [{ toolWireSchema }, { BUILTIN_TOOLS, HIDDEN_TOOLS }] = await Promise.all([
		import("@oh-my-pi/pi-ai"),
		import("../tools"),
	]);
	const session = await manifestSession();
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

/** Full canonical values used only by the generator to produce the native-free sidecar. */
export async function buildToolContractSnapshot(): Promise<GeneratedToolContracts> {
	const [{ toolWireSchema }, { BUILTIN_TOOLS, HIDDEN_TOOLS }] = await Promise.all([
		import("@oh-my-pi/pi-ai"),
		import("../tools"),
	]);
	const session = await manifestSession();
	const tools: Tool[] = [];
	for (const [name, factory] of Object.entries({ ...BUILTIN_TOOLS, ...HIDDEN_TOOLS }).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const tool = await factory(session);
		if (!tool) continue;
		if (tool.name !== name) throw new Error(`tool factory ${name} produced ${tool.name}`);
		tools.push(tool as Tool);
	}
	const contracts = tools
		.map(tool => ({ id: `tool.${tool.name}`, description: tool.description, schema: toolWireSchema(tool) }))
		.sort((left, right) => left.id.localeCompare(right.id));
	const payload = { schema: "omp.tool_contracts.v1" as const, tools: contracts };
	return { ...payload, rootSha256: sha256(canonicalJson(payload as never)) };
}
