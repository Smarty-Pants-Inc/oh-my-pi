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
	} catch {
		return await loadOfflineContextFiles(cwd);
	}
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
	const release = await buildContextReleaseManifest(cwd, undefined, { validateToolContracts: false });
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
			source: `packages/coding-agent/src/${entry.path}`,
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
		const contextFiles = await loadExplainContextFiles(cwd).catch(() => []);
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
		for (const skillName of SMARTY_MERGIFY_SKILLS) {
			const filePath = path.join(os.homedir(), ".agents/skills", skillName, "SKILL.md");
			const file = Bun.file(filePath);
			if (!(await file.exists())) continue;
			const content = await file.text();
			components.push({
				id: `external.skill.${skillName}`,
				source: filePath,
				kind: "instruction",
				semanticRole: "external_instruction",
				actualRole: "user",
				target: options.target,
				trigger: "user_selected_skill",
				visibility: "external",
				enabled: false,
				enabledReason: "available external source; injected only when selected",
				approvalStatus: "unapproved",
				sha256: sha256(content),
				provider,
				model,
				renderedWrapper: "external skill body followed by skill.smarty_mergify_policy",
				precedence: 10_000,
				providerOrder: components.length,
				...counts(content),
				...(options.includeContent ? { content } : {}),
			});
		}
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
