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
	behaviorRegistrySource,
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
	instructions?: readonly ContextInstruction[];
	selectedSkills?: readonly { name: string; renderedText: string; order: number }[];
	mcpInstructions?: readonly RuntimeMcpInstruction[];
	renderedToolContracts?: RenderedToolContractExport;
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

type ExplainWireModel = Pick<Model<Api>, "provider" | "id" | "api" | "compat">;

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
	const runtimeInstructions = new Map(
		(options.runtime?.instructions ?? [])
			.filter(instruction => instruction.target === options.target)
			.map(instruction => [instruction.id, instruction]),
	);
	const registeredIds = new Set(registry.prompts.map(entry => entry.id));
	for (const entry of registry.prompts
		.filter(prompt => prompt.target.includes(options.target))
		.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))) {
		const sourceContent = registeredPromptSource(entry.id);
		const runtimeInstruction = runtimeInstructions.get(entry.id);
		const content = runtimeInstruction?.renderedText ?? sourceContent;
		const effective =
			runtimeInstruction !== undefined ||
			(entry.defaultEnabled && entry.visibility === "model" && entry.trigger === "startup");
		components.push({
			id: entry.id,
			source: registeredPromptRepositoryPath(entry.path),
			kind: "instruction",
			semanticRole: entry.role,
			actualRole: mapContextRole(entry.role, developerRole),
			target: options.target,
			trigger: entry.trigger,
			visibility: entry.visibility,
			enabled: effective,
			enabledReason: runtimeInstruction
				? "runtime trigger supplied an exact rendered instruction"
				: effective
					? "agent-behavior default"
					: "registered potential component; runtime trigger was not observed",
			triggered: runtimeInstruction !== undefined || effective,
			effective,
			availability: effective ? "effective" : entry.trigger === "tool_available" ? "unavailable" : "available",
			approvalStatus: approval.status,
			sha256: runtimeInstruction?.sha256 ?? sha256(content),
			provider,
			model,
			renderedWrapper: runtimeInstruction
				? "exact runtime rendered instruction"
				: "registered Markdown template; dynamic values require a runtime trigger",
			precedence: entry.order,
			providerOrder: null,
			...counts(content),
			...(options.includeContent ? { content } : {}),
		});
	}
	for (const instruction of [...runtimeInstructions.values()].filter(item => !registeredIds.has(item.id))) {
		components.push({
			id: instruction.id,
			source: instruction.sourcePath,
			kind: "instruction",
			semanticRole: instruction.role,
			actualRole: mapContextRole(instruction.role, developerRole),
			target: instruction.target,
			trigger: instruction.trigger,
			visibility: "external",
			enabled: true,
			enabledReason: "runtime supplied an exact provenance-bound instruction",
			triggered: true,
			effective: true,
			availability: "effective",
			approvalStatus: await externalApproval(instruction.sourcePath, instruction.sha256, release, approval),
			sha256: instruction.sha256,
			provider,
			model,
			renderedWrapper: "exact runtime rendered instruction",
			precedence: instruction.order ?? 10_000,
			providerOrder: null,
			...counts(instruction.renderedText),
			...(options.includeContent ? { content: instruction.renderedText } : {}),
		});
	}

	if (options.target === "main") {
		const contextFiles = await loadExplainContextFiles(cwd);
		for (const file of contextFiles) {
			const contentSha256 = sha256(file.content);
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
				enabledReason: "discovered external context file",
				triggered: true,
				effective: true,
				availability: "effective",
				approvalStatus: await externalApproval(file.path, contentSha256, release, approval),
				sha256: contentSha256,
				provider,
				model,
				renderedWrapper: "external_instruction",
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
				enabledReason: "connected MCP server returned this exact instruction text",
				triggered: true,
				effective: true,
				availability: "effective",
				approvalStatus: "unapproved",
				sha256: contentSha256,
				provider,
				model,
				renderedWrapper: "exact connected-server instructions with MCP provenance",
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
	let providerOrder = 0;
	for (const component of components) {
		component.providerOrder = component.effective && component.kind === "instruction" ? providerOrder++ : null;
	}

	const behavior = YAML.parse(behaviorRegistrySource()) as Record<string, unknown>;
	const automaticTurns = behavior.automaticTurns as { allowed?: string[] } | undefined;
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
		automaticTurnSources: [...(automaticTurns?.allowed ?? [])].sort(),
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
