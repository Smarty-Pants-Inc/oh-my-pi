import type { Model, Tool } from "@oh-my-pi/pi-ai";
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

export interface RenderedToolContract {
	id: string;
	description: string;
	schema: unknown;
	descriptionSha256: string;
	schemaSha256: string;
}

export interface RenderedToolContractExport {
	schema: "omp.rendered_tool_contracts.v1";
	provider: string;
	model: string;
	contentManifestRootSha256: string;
	configurationSemanticSha256: string;
	tools: RenderedToolContract[];
	rootSha256: string;
}

export interface RenderedToolContractBinding {
	contentManifestRootSha256: string;
	configurationSemanticSha256: string;
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

function parseSchema(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function renderedContract(value: unknown): { name: string; description: string; schema: unknown } | undefined {
	if (!isRecord(value)) return undefined;
	if (isRecord(value.function)) return renderedContract(value.function);
	if (isRecord(value.toolSpec)) return renderedContract(value.toolSpec);
	const name = typeof value.name === "string" ? value.name : undefined;
	if (!name) return undefined;
	const inputSchema = isRecord(value.inputSchema) && "json" in value.inputSchema ? value.inputSchema.json : undefined;
	const schema =
		value.parameters ??
		value.parametersJsonSchema ??
		value.input_schema ??
		inputSchema ??
		value.schema ??
		value.jsonSchemaString;
	if (schema === undefined) return undefined;
	return {
		name,
		description: typeof value.description === "string" ? value.description : "",
		schema: parseSchema(schema),
	};
}

/** Extract the exact tool contracts from a provider-built payload after all wire transforms. */
export function exportRenderedToolContracts(
	payload: unknown,
	model: Pick<Model, "provider" | "id"> | undefined,
	binding: RenderedToolContractBinding,
): RenderedToolContractExport {
	if (
		!/^[a-f0-9]{64}$/.test(binding.contentManifestRootSha256) ||
		!/^[a-f0-9]{64}$/.test(binding.configurationSemanticSha256)
	) {
		throw new Error("rendered tool contract bindings must be lowercase SHA-256 values");
	}
	const found = new Map<string, { name: string; description: string; schema: unknown }>();
	const add = (candidate: unknown): void => {
		const contract = renderedContract(candidate);
		if (!contract) return;
		const prior = found.get(contract.name);
		if (prior && canonicalJson(prior as never) !== canonicalJson(contract as never)) {
			throw new Error(`provider payload contains conflicting contracts for tool ${contract.name}`);
		}
		found.set(contract.name, contract);
	};
	const visited = new Set<object>();
	const visit = (value: unknown): void => {
		if (!isRecord(value) || visited.has(value)) return;
		visited.add(value);
		if (Array.isArray(value.tools)) {
			for (const tool of value.tools) {
				if (isRecord(tool) && Array.isArray(tool.functionDeclarations)) {
					for (const declaration of tool.functionDeclarations) add(declaration);
				} else {
					add(tool);
				}
			}
		}
		if (Array.isArray(value.functionDeclarations)) {
			for (const declaration of value.functionDeclarations) add(declaration);
		}
		for (const nested of Object.values(value)) {
			if (Array.isArray(nested)) {
				for (const item of nested) visit(item);
			} else {
				visit(nested);
			}
		}
	};
	visit(payload);
	const tools = [...found.values()]
		.map(contract => ({
			id: `tool.${contract.name}`,
			description: contract.description,
			schema: contract.schema,
			descriptionSha256: sha256(contract.description),
			schemaSha256: sha256(canonicalJson(contract.schema as never)),
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
	const body = {
		schema: "omp.rendered_tool_contracts.v1" as const,
		provider: model?.provider ?? "provider-unspecified",
		model: model?.id ?? "model-unspecified",
		contentManifestRootSha256: binding.contentManifestRootSha256,
		configurationSemanticSha256: binding.configurationSemanticSha256,
		tools,
	};
	return { ...body, rootSha256: sha256(canonicalJson(body as never)) };
}

async function manifestSession() {
	const { Settings } = await import("../config/settings");
	return {
		cwd: "/workspace",
		hasUI: true,
		settings: Settings.isolated({
			"tools.xdev": false,
			"task.isolation.enabled": true,
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

async function buildFixedToolRegistry(): Promise<Tool[]> {
	const [{ BUILTIN_TOOLS, HIDDEN_TOOLS }, { imageGenTool }, { ttsTool }, { createVibeTools }] = await Promise.all([
		import("../tools"),
		import("../tools/image-gen"),
		import("../tools/tts"),
		import("../tools/vibe"),
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
	tools.push(imageGenTool as Tool, ttsTool as Tool, ...createVibeTools(session));
	const names = tools.map(tool => tool.name);
	if (new Set(names).size !== names.length) throw new Error("fixed tool registry contains duplicate names");
	return tools;
}

/** Builds the tool-description and input-schema portion of the protected content manifest. */
export async function buildToolContractManifest(): Promise<ToolContractManifestEntry[]> {
	const { toolWireSchema } = await import("@oh-my-pi/pi-ai");
	const tools = await buildFixedToolRegistry();
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
	const { toolWireSchema } = await import("@oh-my-pi/pi-ai");
	const tools = await buildFixedToolRegistry();
	const contracts = tools
		.map(tool => ({ id: `tool.${tool.name}`, description: tool.description, schema: toolWireSchema(tool) }))
		.sort((left, right) => left.id.localeCompare(right.id));
	const payload = { schema: "omp.tool_contracts.v1" as const, tools: contracts };
	return { ...payload, rootSha256: sha256(canonicalJson(payload as never)) };
}
