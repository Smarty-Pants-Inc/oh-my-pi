import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, ContextInstruction, Model } from "@oh-my-pi/pi-ai";
import { mapContextRole, supportsDeveloperRoleForContext } from "@oh-my-pi/pi-ai/context-instructions";
import { resolveDeveloperRoleSupport } from "@oh-my-pi/pi-catalog/compat/developer-role";
import bundledModels from "@oh-my-pi/pi-catalog/models.json" with { type: "json" };
import { YAML } from "bun";
import type { MCPServer } from "../capability/mcp";
import { expandAtImports } from "../discovery/at-imports";
import { ref, remote, repo, show } from "../utils/git";
import { approvalStatus } from "./approved-policy";
import { canonicalJson, type JsonValue, sha256 } from "./canonical";
import { buildContextReleaseManifest, type ContextReleaseManifest, canonicalGithubRepository } from "./manifest";
import {
	agentBehavior,
	type ContextRole,
	type ContextTarget,
	promptRegistry,
	registeredPromptRepositoryPath,
	registeredPromptSource,
} from "./registry";
import { SMARTY_MERGIFY_SKILLS } from "./smarty-skills";
import type { RenderedToolContractExport } from "./tool-contracts";

export interface RuntimeMcpInstruction {
	name: string;
	source: string;
	content: string;
}

export interface RuntimeContextEvidence {
	/** Exact rendered blocks from standalone callers that do not have a final provider payload. */
	systemPromptBlocks?: readonly string[];
	instructions?: readonly ContextInstruction[];
	selectedSkills?: readonly { name: string; renderedText: string; order: number }[];
	mcpInstructions?: readonly RuntimeMcpInstruction[];
	renderedToolContracts?: RenderedToolContractExport;
}

type ProviderInstructionBlock = { actualRole: "system" | "developer"; renderedText: string };
const PROVIDER_PAYLOAD_EVIDENCE = Symbol.for("oh-my-pi.provider-payload-evidence");

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function textBlock(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	const item = record(value);
	return item && typeof item.text === "string" ? item.text : undefined;
}

function roleBlocks(value: unknown): ProviderInstructionBlock[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(item => {
		const message = record(item);
		if (!message || (message.role !== "system" && message.role !== "developer")) return [];
		if (typeof message.content === "string") {
			return [{ actualRole: message.role, renderedText: message.content }];
		}
		return [];
	});
}

function cursorInstructionBlocks(payload: Record<string, unknown>): ProviderInstructionBlock[] {
	const evidence = record((payload as Record<PropertyKey, unknown>)[PROVIDER_PAYLOAD_EVIDENCE]);
	if (evidence?.kind !== "cursor-root-prompt") {
		throw new Error("Cursor final provider payload is missing exact root-prompt evidence");
	}
	const ids = evidence.rootPromptMessageIds;
	const jsonBlocks = evidence.rootPromptMessagesJson;
	const state = record(payload.conversationState);
	const roots = state?.rootPromptMessagesJson;
	if (!Array.isArray(ids) || !Array.isArray(jsonBlocks) || !Array.isArray(roots) || ids.length !== jsonBlocks.length) {
		throw new Error("Cursor final provider payload has invalid root-prompt evidence");
	}
	for (let index = 0; index < ids.length; index++) {
		const root = roots[index];
		if (!(root instanceof Uint8Array) || typeof ids[index] !== "string") {
			throw new Error("Cursor final provider payload has invalid root-prompt ids");
		}
		if (Buffer.from(root).toString("base64") !== ids[index]) {
			throw new Error("Cursor payload guard changed the protected root-prompt topology");
		}
	}
	return jsonBlocks.map((value, index) => {
		if (typeof value !== "string") throw new Error(`Cursor root-prompt evidence ${index} is not JSON text`);
		const message = record(JSON.parse(value));
		if (message?.role !== "system" || typeof message.content !== "string") {
			throw new Error(`Cursor root-prompt evidence ${index} is not a system instruction`);
		}
		return { actualRole: "system" as const, renderedText: message.content };
	});
}

function devinInstructionBlocks(
	payload: Record<string, unknown>,
	candidates: readonly ContextInstruction[],
): ProviderInstructionBlock[] {
	if (typeof payload.prompt !== "string") throw new Error("Devin final provider payload is missing prompt text");
	let prefixEnd = payload.prompt.length;
	const instructions: ProviderInstructionBlock[] = [];
	for (let index = candidates.length - 1; index >= 0; index--) {
		const renderedText = candidates[index]!.renderedText.toWellFormed();
		const start = prefixEnd - renderedText.length;
		if (start < 0 || payload.prompt.slice(start, prefixEnd) !== renderedText) {
			throw new Error(`Devin final provider payload is missing instruction ${candidates[index]!.id}`);
		}
		instructions.unshift({ actualRole: "system", renderedText });
		prefixEnd = start;
		if (prefixEnd > 0) {
			if (payload.prompt.slice(prefixEnd - 2, prefixEnd) !== "\n\n") {
				throw new Error("Devin final provider payload has ambiguous instruction boundaries");
			}
			prefixEnd -= 2;
		}
	}
	const prefix = payload.prompt.slice(0, prefixEnd);
	return prefix.length > 0 ? [{ actualRole: "system", renderedText: prefix }, ...instructions] : instructions;
}

function finalProviderInstructionBlocks(
	payload: unknown,
	model: Pick<Model, "api">,
	candidates: readonly ContextInstruction[],
): ProviderInstructionBlock[] {
	const body = record(payload);
	if (!body) return [];
	if (model.api === "cursor-agent") return cursorInstructionBlocks(body);
	if (model.api === "devin-agent") return devinInstructionBlocks(body, candidates);
	if (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") {
		const system = Array.isArray(body.system) ? body.system : [];
		return system.flatMap(block => {
			const renderedText = textBlock(block);
			return renderedText === undefined ? [] : [{ actualRole: "system" as const, renderedText }];
		});
	}
	if (model.api === "google-generative-ai" || model.api === "google-vertex" || model.api === "google-gemini-cli") {
		const request = record(body.request) ?? body;
		const config = record(request.config) ?? request;
		const instruction = record(config.systemInstruction ?? config.system_instruction);
		const parts = instruction && Array.isArray(instruction.parts) ? instruction.parts : [];
		return parts.flatMap(part => {
			const renderedText = textBlock(part);
			return renderedText === undefined ? [] : [{ actualRole: "system" as const, renderedText }];
		});
	}
	if (model.api === "openai-completions" || model.api === "ollama-chat") {
		return roleBlocks(body.messages);
	}
	if (model.api === "gitlab-duo-agent") {
		const startRequest = record(body.startRequest);
		const flowConfig = record(startRequest?.flowConfig);
		const prompts = flowConfig && Array.isArray(flowConfig.prompts) ? flowConfig.prompts : [];
		return prompts.flatMap(prompt => {
			const template = record(record(prompt)?.prompt_template);
			return typeof template?.system === "string"
				? [{ actualRole: "system" as const, renderedText: template.system }]
				: [];
		});
	}
	if (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "openrouter"
	) {
		const request = record(body.response) ?? body;
		const blocks: ProviderInstructionBlock[] = [];
		if (typeof request.instructions === "string") {
			blocks.push({ actualRole: "system", renderedText: request.instructions });
		}
		blocks.push(...roleBlocks(request.input), ...roleBlocks(request.messages));
		return blocks;
	}
	return [];
}

/** Whether an onPayload callback is the provider request whose instruction evidence should be retained. */
export function isRuntimeContextEvidencePayload(payload: unknown, model: Pick<Model, "api">): boolean {
	if (model.api !== "gitlab-duo-agent") return true;
	return record(record(payload)?.startRequest) !== undefined;
}

/** Capture only exact instruction-channel strings from the final guarded provider payload. */
export function captureRuntimeContextEvidence(
	payload: unknown,
	model: Model,
	target: ContextTarget,
	candidates: readonly ContextInstruction[],
	renderedToolContracts?: RenderedToolContractExport,
): RuntimeContextEvidence {
	const candidateList = candidates.filter(candidate => candidate.renderedText.trim().length > 0);
	const blocks = finalProviderInstructionBlocks(payload, model, candidateList);
	const matched = new Map<number, ContextInstruction>();
	const matchedCandidates = new Set<ContextInstruction>();
	const supportsDeveloperRole = supportsDeveloperRoleForContext(model);
	let beforeBlock = blocks.length;
	for (let candidateIndex = candidateList.length - 1; candidateIndex >= 0; candidateIndex--) {
		const candidate = candidateList[candidateIndex]!;
		for (let blockIndex = beforeBlock - 1; blockIndex >= 0; blockIndex--) {
			const block = blocks[blockIndex]!;
			if (
				candidate.renderedText.toWellFormed() !== block.renderedText ||
				mapContextRole(candidate.role, supportsDeveloperRole) !== block.actualRole
			) {
				continue;
			}
			matched.set(blockIndex, candidate);
			matchedCandidates.add(candidate);
			beforeBlock = blockIndex;
			break;
		}
	}
	const instructions: ContextInstruction[] = blocks.map((block, providerOrder): ContextInstruction => {
		const candidate = matched.get(providerOrder);
		if (candidate) return { ...candidate, renderedText: block.renderedText, sha256: sha256(block.renderedText) };
		return {
			id: `runtime.system_prompt.${providerOrder}`,
			sourcePath: `provider://${model.provider}/${model.id}/request`,
			role: block.actualRole,
			target,
			trigger: "provider_request",
			sha256: sha256(block.renderedText),
			renderedText: block.renderedText,
			order: providerOrder,
		};
	});
	for (const candidate of candidateList) {
		if (matchedCandidates.has(candidate)) continue;
		instructions.push({ ...candidate, sha256: sha256(""), renderedText: "" });
	}
	return { instructions, renderedToolContracts };
}

export interface ExplainedComponent {
	id: string;
	source: string;
	kind: "instruction" | "data";
	semanticRole: ContextRole | "external_instruction" | "data";
	actualRole: "system" | "developer" | "user" | "data";
	target: ContextTarget;
	trigger: string;
	visibility: "model" | "conditional" | "offline_only" | "external";
	enabled: boolean;
	enabledReason: string;
	triggered: boolean;
	effective: boolean;
	availability: "effective" | "available" | "unavailable";
	approvalStatus: "approved" | "unapproved" | "mismatch" | "not_applicable";
	sha256: string;
	provider: string;
	model: string;
	renderedWrapper: string;
	precedence: number;
	/** Zero-based order for exact runtime system-prompt blocks and typed instructions; otherwise null. */
	providerOrder: number | null;
	bytes: number;
	words: number;
	estimatedTokens: number;
	content?: string;
}

export interface ContextExplanation {
	schema: "omp.context_explain.v1";
	target: ContextTarget;
	provider: string;
	model: string;
	approval: Awaited<ReturnType<typeof approvalStatus>>;
	release: ContextReleaseManifest;
	components: ExplainedComponent[];
	behavior: unknown;
	behaviorSource: "agent-behavior.yml";
	automaticTurnSources: string[];
	toolContracts:
		| { status: "effective"; export: RenderedToolContractExport }
		| { status: "unavailable"; provider: string; model: string; reason: string };
}

function counts(content: string): Pick<ExplainedComponent, "bytes" | "words" | "estimatedTokens"> {
	const words = content.trim().length === 0 ? 0 : content.trim().split(/\s+/).length;
	return { bytes: Buffer.byteLength(content), words, estimatedTokens: Math.ceil(content.length / 4) };
}

type ExplainWireModel = Pick<Model<Api>, "provider" | "id" | "api" | "compat" | "reasoning">;

function systemPromptRole(
	model: ExplainWireModel | undefined,
	blockIndex: number,
	supportsDeveloperRole: boolean,
): "system" | "developer" {
	if (model?.api === "openai-codex-responses") return blockIndex === 0 ? "system" : "developer";
	if (
		model?.reasoning &&
		supportsDeveloperRole &&
		["openai-completions", "openai-responses", "azure-openai-responses", "openrouter"].includes(model.api)
	) {
		return "developer";
	}
	return "system";
}

function resolveExplainWireModel(options: {
	provider?: string;
	model?: string;
	wireModel?: Model;
}): ExplainWireModel | undefined {
	if (options.wireModel) {
		if (options.provider !== undefined && options.provider !== options.wireModel.provider) {
			throw new Error("context explain provider does not match the live wire model");
		}
		if (options.model !== undefined && options.model !== options.wireModel.id) {
			throw new Error("context explain model does not match the live wire model");
		}
		return options.wireModel;
	}
	if (options.provider === undefined && options.model === undefined) return undefined;
	if (options.provider === undefined || options.model === undefined) {
		throw new Error("context explain requires --provider and --model together for exact wire-role mapping");
	}
	const providers = bundledModels as unknown as Record<string, Record<string, Record<string, unknown>>>;
	const providerModels = providers[options.provider];
	if (!providerModels) {
		throw new Error(`context explain cannot resolve provider ${options.provider} from the bundled catalog`);
	}
	const spec = providerModels[options.model];
	if (!spec || spec.provider !== options.provider || spec.id !== options.model || typeof spec.api !== "string") {
		throw new Error(
			`context explain cannot resolve model ${options.provider}/${options.model} from the bundled catalog`,
		);
	}
	const api = spec.api as Api;
	return {
		provider: options.provider,
		id: options.model,
		api,
		reasoning: spec.reasoning === true,
		compat: {
			supportsDeveloperRole: resolveDeveloperRoleSupport(api, {
				provider: options.provider,
				baseUrl: typeof spec.baseUrl === "string" ? spec.baseUrl : undefined,
				compat:
					typeof spec.compat === "object" && spec.compat !== null
						? (spec.compat as { supportsDeveloperRole?: boolean })
						: undefined,
			}),
		} as never,
	};
}

function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readContextFile(
	filePath: string,
	depth?: number,
): Promise<{ path: string; content: string; depth?: number } | undefined> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) return undefined;
	const content = await expandAtImports(await file.text(), filePath);
	return { path: filePath, content, ...(depth === undefined ? {} : { depth }) };
}

/** Native-free fallback for context-file discovery in source-only checkouts. */
async function loadOfflineContextFiles(cwd: string): Promise<Array<{ path: string; content: string; depth?: number }>> {
	const resolvedCwd = path.resolve(cwd);
	const home = path.resolve(os.homedir());
	const repositoryRoot = await repo.root(resolvedCwd);
	const boundary = repositoryRoot && !isWithin(home, repositoryRoot) ? repositoryRoot : home;
	const projectFiles: Array<{ path: string; content: string; depth?: number }> = [];
	let current = resolvedCwd;
	let depth = 0;
	let nearestOmpContext: { path: string; content: string; depth?: number } | undefined;
	while (true) {
		if (current !== home && !path.basename(current).startsWith(".")) {
			const contextFile = await readContextFile(path.join(current, "AGENTS.md"), depth);
			if (contextFile) projectFiles.push(contextFile);
		}
		if (!nearestOmpContext) {
			nearestOmpContext = await readContextFile(path.join(current, ".omp/AGENTS.md"), depth);
		}
		if (current === boundary) break;
		const parent = path.dirname(current);
		if (parent === current || !isWithin(boundary, parent)) break;
		current = parent;
		depth++;
	}
	if (nearestOmpContext) projectFiles.push(nearestOmpContext);
	projectFiles.sort((left, right) => (right.depth ?? -1) - (left.depth ?? -1));
	const global = await readContextFile(path.join(home, ".omp/agent/AGENTS.md"));
	const files = global ? [...projectFiles, global] : projectFiles;
	const lastByContent = new Map(files.map((file, index) => [file.content, index]));
	return files.filter((file, index) => lastByContent.get(file.content) === index);
}

async function loadExplainContextFiles(cwd: string): Promise<Array<{ path: string; content: string; depth?: number }>> {
	try {
		const { loadProjectContextFiles } = await import("../system-prompt");
		return await loadProjectContextFiles({ cwd });
	} catch (error) {
		if (!(error instanceof Error) || !/pi_natives|native addon/i.test(error.message)) throw error;
		return await loadOfflineContextFiles(cwd);
	}
}

interface OfflineDynamicSource {
	id: string;
	source: string;
	trigger: string;
	content: string;
	kind: "skill" | "extension" | "mcp";
	modelInstruction: boolean;
}

async function loadMcpPotentialSources(cwd: string): Promise<OfflineDynamicSource[] | undefined> {
	try {
		const [{ mcpCapability }, { loadCapability }] = await Promise.all([
			import("../capability/mcp"),
			import("../discovery"),
		]);
		const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd, includeDisabled: true });
		const warnings: string[] = [];
		for (const warning of result.warnings) {
			const optionalRead = /^\[[^\]]+\] Failed to read (.+)$/.exec(warning);
			if (optionalRead && !(await Bun.file(optionalRead[1]!).exists())) continue;
			warnings.push(warning);
		}
		if (warnings.length > 0) {
			throw new Error(`configured MCP discovery failed: ${warnings.sort().join("; ")}`);
		}
		return result.all
			.map(server => {
				const { _source, _shadowed: _ignored, ...config } = server;
				return {
					id: `external.mcp.config.${server.name}.${_source.provider}.${sha256(_source.path).slice(0, 12)}`,
					source: _source.path,
					trigger: "startup",
					content: canonicalJson(JSON.parse(JSON.stringify(config)) as JsonValue),
					kind: "mcp" as const,
					modelInstruction: false,
				};
			})
			.sort((left, right) => left.source.localeCompare(right.source) || left.id.localeCompare(right.id));
	} catch (error) {
		if (error instanceof Error && /pi_natives|native addon/i.test(error.message)) return undefined;
		throw error;
	}
}

async function loadOfflineDynamicSources(cwd: string): Promise<OfflineDynamicSource[]> {
	const configPath = path.join(os.homedir(), ".omp/agent/config.yml");
	const config = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
	const sources: Array<{
		id: string;
		source: string;
		trigger: string;
		content: string;
		kind: "skill" | "extension" | "mcp";
		modelInstruction: boolean;
	}> = [];
	const skillDirectories = new Map([[path.join(os.homedir(), ".agents/skills"), false]]);
	const skills = config.skills;
	if (skills && typeof skills === "object" && !Array.isArray(skills)) {
		const customDirectories = (skills as Record<string, unknown>).customDirectories;
		if (Array.isArray(customDirectories)) {
			for (const directory of customDirectories) {
				if (typeof directory === "string") skillDirectories.set(path.resolve(directory), true);
			}
		}
	}
	for (const [directory, required] of [...skillDirectories].sort(([left], [right]) => left.localeCompare(right))) {
		try {
			if (!(await fs.stat(directory)).isDirectory()) throw new Error(`skill path is not a directory: ${directory}`);
		} catch (error) {
			if (!required && error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw new Error(`configured skill directory is unavailable: ${directory}`, { cause: error });
		}
		for await (const filePath of new Bun.Glob("*/SKILL.md").scan({
			cwd: directory,
			absolute: true,
			onlyFiles: true,
		})) {
			const name = path.basename(path.dirname(filePath));
			sources.push({
				id: `external.skill.${name}`,
				source: filePath,
				trigger: "user_selected_skill",
				content: await Bun.file(filePath).text(),
				kind: "skill",
				modelInstruction: true,
			});
		}
	}
	const extensions = config.extensions;
	if (Array.isArray(extensions)) {
		for (const extension of extensions) {
			if (typeof extension !== "string") throw new Error("configured extension path must be a string");
			const filePath = path.resolve(extension);
			if (!(await Bun.file(filePath).exists())) throw new Error(`configured extension is missing: ${filePath}`);
			sources.push({
				id: `external.extension.${sha256(filePath).slice(0, 12)}`,
				source: filePath,
				trigger: "extension_event",
				content: await Bun.file(filePath).text(),
				kind: "extension",
				modelInstruction: false,
			});
		}
	}
	const discoveredMcp = await loadMcpPotentialSources(cwd);
	if (discoveredMcp) {
		sources.push(...discoveredMcp);
		return sources.sort((left, right) => left.source.localeCompare(right.source) || left.id.localeCompare(right.id));
	}
	for (const filePath of [
		path.join(cwd, ".mcp.json"),
		path.join(cwd, ".omp/mcp.json"),
		path.join(os.homedir(), ".omp/agent/mcp.json"),
	]) {
		const file = Bun.file(filePath);
		if (!(await file.exists())) continue;
		const content = await file.text();
		const parsed: unknown = JSON.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`MCP configuration must be an object: ${filePath}`);
		}
		const mcpServers = (parsed as Record<string, unknown>).mcpServers;
		if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) continue;
		for (const [name, config] of Object.entries(mcpServers).sort(([left], [right]) => left.localeCompare(right))) {
			if (!config || typeof config !== "object" || Array.isArray(config)) {
				throw new Error(`MCP server configuration must be an object: ${filePath}#${name}`);
			}
			const provider = filePath.includes(`${path.sep}.omp${path.sep}`) ? "native" : "mcp-json";
			sources.push({
				id: `external.mcp.config.${name}.${provider}.${sha256(filePath).slice(0, 12)}`,
				source: filePath,
				trigger: "startup",
				content: canonicalJson({ name, ...(config as Record<string, JsonValue>) }),
				kind: "mcp",
				modelInstruction: false,
			});
		}
	}
	return sources.sort((left, right) => left.source.localeCompare(right.source) || left.id.localeCompare(right.id));
}

async function externalApproval(
	filePath: string,
	contentSha256: string,
	release: ContextReleaseManifest,
	status: Awaited<ReturnType<typeof approvalStatus>>,
): Promise<ExplainedComponent["approvalStatus"]> {
	if (status.status !== "approved") return status.status;
	if (
		path.resolve(filePath) === path.resolve(release.globalAgentsPath) &&
		contentSha256 === release.globalAgentsSourceSha256
	) {
		return "approved";
	}
	try {
		const root = await repo.root(path.dirname(filePath));
		if (!root) return "unapproved";
		const relative = path.relative(root, filePath).replaceAll(path.sep, "/");
		if (relative.startsWith("../") || path.isAbsolute(relative)) return "unapproved";
		const identity = await ref.commitIdentity(root, "HEAD");
		if (!identity) return "unapproved";
		const remoteNames = await remote.list(root);
		let repository: string | undefined;
		for (const name of ["origin", ...remoteNames.filter(name => name !== "origin")]) {
			repository = canonicalGithubRepository(await remote.url(root, name));
			if (repository) break;
		}
		const candidate = release.candidates.find(item => item.repository === repository);
		if (!candidate || candidate.commit !== identity.commit || candidate.tree !== identity.tree) return "unapproved";
		return sha256(await show(root, `HEAD:${relative}`)) === contentSha256 ? "approved" : "unapproved";
	} catch {
		return "unapproved";
	}
}

export async function explainContext(options: {
	cwd?: string;
	target: ContextTarget;
	includeContent?: boolean;
	provider?: string;
	model?: string;
	wireModel?: Model;
	runtime?: RuntimeContextEvidence;
}): Promise<ContextExplanation> {
	const cwd = options.cwd ?? process.cwd();
	const wireModel = resolveExplainWireModel(options);
	const provider = wireModel?.provider ?? "provider-unspecified";
	const model = wireModel?.id ?? "model-unspecified";
	const developerRole = wireModel ? supportsDeveloperRoleForContext(wireModel) : false;
	const release = await buildContextReleaseManifest(cwd);
	const approval = await approvalStatus(release);
	const renderedToolContracts = options.runtime?.renderedToolContracts;
	if (renderedToolContracts) {
		const { rootSha256, ...payload } = renderedToolContracts;
		if (sha256(canonicalJson(payload as unknown as JsonValue)) !== rootSha256) {
			throw new Error("runtime rendered tool contract root does not match its payload");
		}
		if (
			renderedToolContracts.contentManifestRootSha256 !== release.contentManifestRootSha256 ||
			renderedToolContracts.configurationSemanticSha256 !== release.configurationSemanticSha256
		) {
			throw new Error("runtime rendered tool contracts are not bound to the current release projection");
		}
	}
	const selectedRenderedToolContracts =
		renderedToolContracts?.provider === provider && renderedToolContracts.model === model
			? renderedToolContracts
			: undefined;
	const registry = promptRegistry();
	const components: ExplainedComponent[] = [];
	const runtimeSystemPromptBlocks = (options.runtime?.systemPromptBlocks ?? [])
		.map((content, sourceIndex) => ({ content, sourceIndex }))
		.filter(block => block.content.trim().length > 0);
	for (const [providerOrder, block] of runtimeSystemPromptBlocks.entries()) {
		components.push({
			id: `runtime.system_prompt.${block.sourceIndex}`,
			source: `runtime.systemPrompt[${block.sourceIndex}]`,
			kind: "instruction",
			semanticRole: "system",
			actualRole: systemPromptRole(wireModel, providerOrder, developerRole),
			target: options.target,
			trigger: "startup",
			visibility: "model",
			enabled: true,
			enabledReason: "runtime supplied this exact rendered system-prompt block",
			triggered: true,
			effective: true,
			availability: "effective",
			approvalStatus: approval.status,
			sha256: sha256(block.content),
			provider,
			model,
			renderedWrapper: "exact runtime rendered system-prompt block",
			precedence: -10_000 + providerOrder,
			providerOrder,
			...counts(block.content),
			...(options.includeContent ? { content: block.content } : {}),
		});
	}
	const runtimeInstructionList = (options.runtime?.instructions ?? []).filter(
		instruction => instruction.target === options.target,
	);
	const runtimeInstructions = new Map(runtimeInstructionList.map(instruction => [instruction.id, instruction]));
	const runtimeInstructionProviderOrders = new Map<string, number>();
	let nextProviderOrder = runtimeSystemPromptBlocks.length;
	for (const instruction of runtimeInstructionList) {
		if (instruction.renderedText.trim().length === 0) continue;
		runtimeInstructionProviderOrders.set(instruction.id, nextProviderOrder++);
	}
	const registeredIds = new Set(registry.prompts.map(entry => entry.id));
	for (const entry of registry.prompts
		.filter(prompt => prompt.target.includes(options.target))
		.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))) {
		const sourceContent = registeredPromptSource(entry.id);
		const runtimeInstruction = runtimeInstructions.get(entry.id);
		const content = runtimeInstruction?.renderedText ?? sourceContent;
		const effective = runtimeInstruction !== undefined && runtimeInstruction.renderedText.trim().length > 0;
		components.push({
			id: entry.id,
			source: registeredPromptRepositoryPath(entry.path),
			kind: "instruction",
			semanticRole: entry.role,
			actualRole: mapContextRole(entry.role, developerRole),
			target: options.target,
			trigger: entry.trigger,
			visibility: entry.visibility,
			enabled: runtimeInstruction !== undefined || entry.defaultEnabled,
			enabledReason: runtimeInstruction
				? effective
					? "runtime trigger supplied an exact rendered instruction"
					: "runtime evidence did not contain an exact emitted instruction"
				: entry.defaultEnabled
					? "registered default template; exact runtime rendering was not supplied"
					: "registered potential component; runtime trigger was not observed",
			triggered: runtimeInstruction !== undefined,
			effective,
			availability: effective ? "effective" : entry.trigger === "tool_available" ? "unavailable" : "available",
			approvalStatus: approval.status,
			sha256: runtimeInstruction?.sha256 ?? sha256(content),
			provider,
			model,
			renderedWrapper: runtimeInstruction
				? effective
					? "exact runtime rendered instruction"
					: "runtime evidence contains no exact emitted instruction bytes"
				: "registered Markdown source template; not a rendered wire component",
			precedence: entry.order,
			providerOrder: effective ? (runtimeInstructionProviderOrders.get(entry.id) ?? null) : null,
			...counts(content),
			...(options.includeContent ? { content } : {}),
		});
	}
	for (const instruction of [...runtimeInstructions.values()].filter(item => !registeredIds.has(item.id))) {
		const effective = instruction.renderedText.trim().length > 0;
		const exactProviderBlock =
			instruction.id.startsWith("runtime.system_prompt.") && instruction.sourcePath.startsWith("provider://");
		components.push({
			id: instruction.id,
			source: instruction.sourcePath,
			kind: "instruction",
			semanticRole: instruction.role,
			actualRole: mapContextRole(instruction.role, developerRole),
			target: instruction.target,
			trigger: instruction.trigger,
			visibility: exactProviderBlock ? "model" : "external",
			enabled: effective,
			enabledReason: effective
				? "runtime supplied an exact provenance-bound instruction"
				: "runtime evidence did not contain an exact emitted instruction",
			triggered: true,
			effective,
			availability: effective ? "effective" : "available",
			approvalStatus: exactProviderBlock
				? approval.status
				: await externalApproval(instruction.sourcePath, instruction.sha256, release, approval),
			sha256: instruction.sha256,
			provider,
			model,
			renderedWrapper: effective
				? "exact runtime rendered instruction"
				: "runtime evidence contains no exact emitted instruction bytes",
			precedence: instruction.order ?? 10_000,
			providerOrder: effective ? (runtimeInstructionProviderOrders.get(instruction.id) ?? null) : null,
			...counts(instruction.renderedText),
			...(options.includeContent ? { content: instruction.renderedText } : {}),
		});
	}

	if (options.target === "main") {
		const contextFiles = await loadExplainContextFiles(cwd);
		for (const file of contextFiles) {
			const contentSha256 = sha256(file.content);
			const embeddedBlock =
				file.content.length > 0
					? runtimeSystemPromptBlocks.find(block => block.content.includes(file.content))
					: undefined;
			components.push({
				id: `external.agents.${contentSha256.slice(0, 12)}`,
				source: file.path,
				kind: "instruction",
				semanticRole: "system",
				actualRole: "system",
				target: "main",
				trigger: "startup",
				visibility: "external",
				enabled: true,
				enabledReason: embeddedBlock
					? `source text is embedded in runtime system-prompt block ${embeddedBlock.sourceIndex}`
					: "discovered external context source; exact runtime embedding was not observed",
				triggered: embeddedBlock !== undefined,
				effective: false,
				availability: "available",
				approvalStatus: await externalApproval(file.path, contentSha256, release, approval),
				sha256: contentSha256,
				provider,
				model,
				renderedWrapper: embeddedBlock
					? "external_instruction source embedded in a runtime system-prompt block"
					: "external_instruction source provenance; not a separate wire component",
				precedence: 10_000 + (file.depth ?? 0),
				providerOrder: null,
				...counts(file.content),
				...(options.includeContent ? { content: file.content } : {}),
			});
		}
	}

	if (options.target === "main" || options.target === "subagent") {
		const selectedSkills = new Map((options.runtime?.selectedSkills ?? []).map(skill => [skill.name, skill]));
		for (const source of await loadOfflineDynamicSources(cwd)) {
			const isSkill = source.kind === "skill";
			const selected = isSkill ? selectedSkills.get(source.id.slice("external.skill.".length)) : undefined;
			const renderedContent = selected?.renderedText ?? source.content;
			const contentSha256 = sha256(renderedContent);
			const hasSmartyWrapper =
				isSkill && SMARTY_MERGIFY_SKILLS.includes(source.id.slice("external.skill.".length) as never);
			components.push({
				id: source.id,
				source: source.source,
				kind: source.modelInstruction ? "instruction" : "data",
				semanticRole: source.modelInstruction ? "external_instruction" : "data",
				actualRole: source.modelInstruction ? "user" : "data",
				target: options.target,
				trigger: source.trigger,
				visibility: "external",
				enabled: selected !== undefined,
				enabledReason: selected
					? "runtime supplied this exact user-selected skill prompt"
					: source.kind === "mcp"
						? "configured MCP binding; returned server instructions are unavailable offline"
						: `available ${source.kind} source; runtime trigger was not observed`,
				triggered: selected !== undefined,
				effective: selected !== undefined,
				availability: selected ? "effective" : source.kind === "mcp" ? "unavailable" : "available",
				approvalStatus:
					source.kind === "mcp"
						? "unapproved"
						: await externalApproval(source.source, contentSha256, release, approval),
				sha256: contentSha256,
				provider,
				model,
				renderedWrapper: hasSmartyWrapper
					? "exact user-selected skill prompt followed by skill.smarty_mergify_policy"
					: source.kind === "mcp"
						? "configuration provenance only; never rendered as server instructions"
						: selected
							? "exact runtime user-selected skill prompt"
							: `external ${source.kind} provenance; not triggered offline`,
				precedence: selected ? 10_000 + selected.order : 10_000,
				providerOrder: null,
				...counts(renderedContent),
				...(options.includeContent && source.kind !== "mcp" ? { content: renderedContent } : {}),
			});
		}
		for (const [index, source] of (options.runtime?.mcpInstructions ?? []).entries()) {
			const contentSha256 = sha256(source.content);
			const embeddedBlock =
				source.content.length > 0
					? runtimeSystemPromptBlocks.find(block => block.content.includes(source.content))
					: undefined;
			components.push({
				id: `external.mcp.${source.name}`,
				source: source.source,
				kind: "instruction",
				semanticRole: "external_instruction",
				actualRole: "system",
				target: options.target,
				trigger: "startup",
				visibility: "external",
				enabled: true,
				enabledReason: embeddedBlock
					? `connected MCP text is embedded in runtime system-prompt block ${embeddedBlock.sourceIndex}`
					: "connected MCP server returned exact text; runtime system-prompt embedding was not observed",
				triggered: true,
				effective: false,
				availability: "available",
				approvalStatus: "unapproved",
				sha256: contentSha256,
				provider,
				model,
				renderedWrapper: embeddedBlock
					? "connected-server source embedded in a runtime system-prompt block"
					: "exact connected-server instruction provenance; not observed on the wire",
				precedence: 20_000 + index,
				providerOrder: null,
				...counts(source.content),
				...(options.includeContent ? { content: source.content } : {}),
			});
		}
	}

	for (const implementation of release.contentManifest.implementationSources) {
		const compaction = implementation.path.startsWith("packages/agent/src/compaction/");
		components.push({
			id: `implementation.${implementation.path}`,
			source: implementation.path,
			kind: "data",
			semanticRole: "data",
			actualRole: "data",
			target: options.target,
			trigger: compaction ? "compaction" : "tool_available",
			visibility: "offline_only",
			enabled: false,
			enabledReason: compaction
				? "protected compaction transform or dispatch implementation"
				: "protected tool selection or provider wire-transform implementation",
			triggered: false,
			effective: false,
			availability: "available",
			approvalStatus: approval.status,
			sha256: implementation.sha256,
			provider,
			model,
			renderedWrapper: "implementation provenance; no direct model content",
			precedence: 50_000,
			providerOrder: null,
			...counts(""),
		});
	}

	components.sort((left, right) => left.precedence - right.precedence || left.id.localeCompare(right.id));

	const behavior = agentBehavior;
	return {
		schema: "omp.context_explain.v1",
		target: options.target,
		provider,
		model,
		approval,
		release,
		components,
		behavior,
		behaviorSource: "agent-behavior.yml",
		automaticTurnSources: [...behavior.automaticTurns.allowed].sort(),
		toolContracts: selectedRenderedToolContracts
			? { status: "effective", export: selectedRenderedToolContracts }
			: {
					status: "unavailable",
					provider,
					model,
					reason: renderedToolContracts
						? "last rendered tool contracts belong to a different provider or model"
						: "exact final tool contracts are available only after provider payload rendering",
				},
	};
}

export function renderContextExplanation(explanation: ContextExplanation): string {
	const lines = [
		`Context target: ${explanation.target}`,
		`Provider/model: ${explanation.provider} / ${explanation.model}`,
		`Approval: ${explanation.approval.status}${explanation.approval.reference ? ` (${explanation.approval.reference})` : ""}`,
		`Manifest: ${explanation.release.contentManifestRootSha256}`,
		"",
	];
	for (const component of explanation.components) {
		lines.push(
			`[${component.providerOrder ?? "potential"}] ${component.id}`,
			`  source: ${component.source}`,
			`  kind: ${component.kind}; role: ${component.semanticRole} -> ${component.actualRole}`,
			`  target/trigger: ${component.target} / ${component.trigger}`,
			`  triggered/effective/availability: ${component.triggered}/${component.effective}/${component.availability}`,
			`  enabled: ${component.enabled} (${component.enabledReason}); approval: ${component.approvalStatus}`,
			`  sha256: ${component.sha256}`,
			`  wrapper/precedence/order: ${component.renderedWrapper} / ${component.precedence} / ${component.providerOrder}`,
			`  size: ${component.bytes} bytes; ${component.words} words; ~${component.estimatedTokens} tokens`,
		);
		if (component.content !== undefined) lines.push("  ---", component.content, "  ---");
	}
	lines.push("", "Effective behavior:", canonicalJson(explanation.behavior as JsonValue));
	lines.push(`Automatic turn sources: ${explanation.automaticTurnSources.join(", ") || "none"}`);
	lines.push(
		explanation.toolContracts.status === "effective"
			? `Rendered tool contracts: ${explanation.toolContracts.export.rootSha256}`
			: `Rendered tool contracts: unavailable (${explanation.toolContracts.reason})`,
	);
	return `${lines.join("\n")}\n`;
}
