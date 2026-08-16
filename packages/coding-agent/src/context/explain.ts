import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mapContextRole } from "@oh-my-pi/pi-ai/context-instructions";
import { YAML } from "bun";
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
	approvalStatus: "approved" | "unapproved" | "mismatch" | "not_applicable";
	sha256: string;
	provider: string;
	model: string;
	renderedWrapper: string;
	precedence: number;
	providerOrder: number;
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
}

function counts(content: string): Pick<ExplainedComponent, "bytes" | "words" | "estimatedTokens"> {
	const words = content.trim().length === 0 ? 0 : content.trim().split(/\s+/).length;
	return { bytes: Buffer.byteLength(content), words, estimatedTokens: Math.ceil(content.length / 4) };
}

function supportsDeveloperRole(provider: string): boolean {
	return /(?:openai|azure|responses)/i.test(provider);
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
	while (true) {
		if (current !== home && !path.basename(current).startsWith(".")) {
			const contextFile = await readContextFile(path.join(current, "AGENTS.md"), depth);
			if (contextFile) projectFiles.push(contextFile);
		}
		if (current === boundary) break;
		const parent = path.dirname(current);
		if (parent === current || !isWithin(boundary, parent)) break;
		current = parent;
		depth++;
	}
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

async function loadOfflineDynamicSources(
	cwd: string,
): Promise<
	Array<{ id: string; source: string; trigger: string; content: string; kind: "skill" | "extension" | "mcp" }>
> {
	const configPath = path.join(os.homedir(), ".omp/agent/config.yml");
	const config = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
	const sources: Array<{
		id: string;
		source: string;
		trigger: string;
		content: string;
		kind: "skill" | "extension" | "mcp";
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
			});
		}
	}
	for (const filePath of [path.join(cwd, ".mcp.json"), path.join(os.homedir(), ".omp/agent/mcp.json")]) {
		const file = Bun.file(filePath);
		if (!(await file.exists())) continue;
		const content = await file.text();
		JSON.parse(content);
		sources.push({
			id: `external.mcp.${sha256(filePath).slice(0, 12)}`,
			source: filePath,
			trigger: "startup",
			content,
			kind: "mcp",
		});
	}
	return sources.sort((left, right) => left.source.localeCompare(right.source));
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
}): Promise<ContextExplanation> {
	const cwd = options.cwd ?? process.cwd();
	const provider = options.provider ?? "provider-unspecified";
	const model = options.model ?? "model-unspecified";
	const developerRole = supportsDeveloperRole(provider);
	const release = await buildContextReleaseManifest(cwd);
	const approval = await approvalStatus(release);
	const registry = promptRegistry();
	const components: ExplainedComponent[] = [];
	for (const entry of registry.prompts
		.filter(prompt => prompt.target.includes(options.target))
		.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))) {
		const content = registeredPromptSource(entry.id);
		const enabled = entry.defaultEnabled;
		components.push({
			id: entry.id,
			source: registeredPromptRepositoryPath(entry.path),
			kind: "instruction",
			semanticRole: entry.role,
			actualRole: mapContextRole(entry.role, developerRole),
			target: options.target,
			trigger: entry.trigger,
			visibility: entry.visibility,
			enabled,
			enabledReason: enabled ? "agent-behavior default" : "registered optional component; runtime trigger required",
			approvalStatus: approval.status,
			sha256: sha256(content),
			provider,
			model,
			renderedWrapper: "registered Markdown template; dynamic values are resolved at provider dispatch",
			precedence: entry.order,
			providerOrder: components.length,
			...counts(content),
			...(options.includeContent ? { content } : {}),
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
				approvalStatus: await externalApproval(file.path, contentSha256, release, approval),
				sha256: contentSha256,
				provider,
				model,
				renderedWrapper: "external_instruction",
				precedence: 10_000 + (file.depth ?? 0),
				providerOrder: components.length,
				...counts(file.content),
				...(options.includeContent ? { content: file.content } : {}),
			});
		}
	}

	if (options.target === "main" || options.target === "subagent") {
		for (const source of await loadOfflineDynamicSources(cwd)) {
			const contentSha256 = sha256(source.content);
			const isSkill = source.kind === "skill";
			const hasSmartyWrapper =
				isSkill && SMARTY_MERGIFY_SKILLS.includes(source.id.slice("external.skill.".length) as never);
			components.push({
				id: source.id,
				source: source.source,
				kind: "instruction",
				semanticRole: "external_instruction",
				actualRole: "system",
				target: options.target,
				trigger: source.trigger,
				visibility: "external",
				enabled: false,
				enabledReason: `available ${source.kind} source; dynamic session trigger is unavailable offline`,
				approvalStatus: await externalApproval(source.source, contentSha256, release, approval),
				sha256: contentSha256,
				provider,
				model,
				renderedWrapper: hasSmartyWrapper
					? "external skill body followed by skill.smarty_mergify_policy"
					: `external ${source.kind} provenance; not triggered offline`,
				precedence: 10_000,
				providerOrder: components.length,
				...counts(source.content),
				...(options.includeContent ? { content: source.content } : {}),
			});
		}
	}

	for (const implementation of release.contentManifest.implementationSources) {
		if (!implementation.path.startsWith("packages/agent/src/compaction/")) continue;
		components.push({
			id: `implementation.${implementation.path}`,
			source: implementation.path,
			kind: "data",
			semanticRole: "data",
			actualRole: "data",
			target: options.target,
			trigger: "compaction",
			visibility: "offline_only",
			enabled: false,
			enabledReason: "protected compaction transform or dispatch implementation",
			approvalStatus: approval.status,
			sha256: implementation.sha256,
			provider,
			model,
			renderedWrapper: "implementation provenance; no direct model content",
			precedence: 50_000,
			providerOrder: components.length,
			...counts(""),
		});
	}

	components.sort((left, right) => left.precedence - right.precedence || left.id.localeCompare(right.id));
	components.forEach((component, index) => {
		component.providerOrder = index;
	});

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
			`[${component.providerOrder}] ${component.id}`,
			`  source: ${component.source}`,
			`  kind: ${component.kind}; role: ${component.semanticRole} -> ${component.actualRole}`,
			`  target/trigger: ${component.target} / ${component.trigger}`,
			`  enabled: ${component.enabled} (${component.enabledReason}); approval: ${component.approvalStatus}`,
			`  sha256: ${component.sha256}`,
			`  wrapper/precedence/order: ${component.renderedWrapper} / ${component.precedence} / ${component.providerOrder}`,
			`  size: ${component.bytes} bytes; ${component.words} words; ~${component.estimatedTokens} tokens`,
		);
		if (component.content !== undefined) lines.push("  ---", component.content, "  ---");
	}
	lines.push("", "Effective behavior:", canonicalJson(explanation.behavior as JsonValue));
	lines.push(`Automatic turn sources: ${explanation.automaticTurnSources.join(", ") || "none"}`);
	return `${lines.join("\n")}\n`;
}
