import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import trackedManifestSource from "../../generated/prompt-manifest.json" with { type: "text" };
import { ref, remote, repo, show, status } from "../utils/git";
import { canonicalJson, type JsonValue, sha256 } from "./canonical";
import {
	behaviorRegistrySource,
	promptRegistry,
	registeredPromptRepositoryPath,
	registeredPromptSource,
} from "./registry";

export const CONTENT_MANIFEST_SCHEMA = "omp.prompt_manifest.v1" as const;
export const RELEASE_MANIFEST_SCHEMA = "omp.context_release_manifest.v1" as const;
export const OMP_REPOSITORY = "Smarty-Pants-Inc/oh-my-pi";

export function canonicalGithubRepository(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const normalized = url
		.replace(/\\/g, "/")
		.replace(/\.git\/?$/, "")
		.replace(/\/$/, "");
	return normalized.match(/(?:github\.com[/:])([^/]+\/[^/]+)$/i)?.[1];
}

export interface CandidateIdentity {
	repository: string;
	commit: string;
	tree: string;
}

export interface PromptManifestEntry {
	id: string;
	path: string;
	role: "system" | "developer" | "internal_context";
	target: Array<"main" | "subagent" | "side_model">;
	trigger: string;
	visibility: "model" | "conditional" | "offline_only";
	defaultEnabled: boolean;
	order: number;
	sha256: string;
}

export interface ToolManifestEntry {
	id: string;
	descriptionSha256: string;
	schemaSha256: string;
}

export interface ProviderMappingEntry {
	id: string;
	semanticRole: "internal_context";
	actualRole: "developer" | "system";
	when: string;
	wrapperPromptId: string;
}

export interface ContentManifest {
	schema: typeof CONTENT_MANIFEST_SCHEMA;
	prompts: PromptManifestEntry[];
	toolSchemas: ToolManifestEntry[];
	providerMappings: ProviderMappingEntry[];
	implementationSources: Array<{ path: string; sha256: string }>;
	behaviorSha256: string;
	rootSha256: string;
}

export interface ContextReleaseManifest {
	schema: typeof RELEASE_MANIFEST_SCHEMA;
	repository: string;
	commit: string;
	tree: string;
	candidates: CandidateIdentity[];
	contentManifest: ContentManifest;
	contentManifestRootSha256: string;
	behaviorSha256: string;
	globalAgentsPath: string;
	globalAgentsSha256: string;
	globalAgentsSourceSha256: string;
	configurationPath: string;
	configurationSourceSha256: string;
	configurationSemanticSha256: string;
	combinedPromptBehaviorSha256: string;
	rootSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error(`${label} has unknown or missing fields`);
	}
}

function manifestPayload(manifest: ContentManifest): Omit<ContentManifest, "rootSha256"> {
	const { rootSha256: _rootSha256, ...payload } = manifest;
	return payload;
}

function assertString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function assertSha256(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new Error(`${label} must be a lowercase SHA-256`);
	}
}

function assertSortedUniqueIds(entries: readonly unknown[], label: string): void {
	const ids = entries.map((entry, index) => {
		if (!isRecord(entry) || typeof entry.id !== "string") throw new Error(`${label} ${index} must have an id`);
		return entry.id;
	});
	if (new Set(ids).size !== ids.length) throw new Error(`${label} ids must be unique`);
	if (ids.some((id, index) => index > 0 && ids[index - 1]!.localeCompare(id) > 0)) {
		throw new Error(`${label} entries must be sorted by id`);
	}
}

export function parseContentManifest(source: string): ContentManifest {
	const value: unknown = JSON.parse(source);
	if (!isRecord(value) || value.schema !== CONTENT_MANIFEST_SCHEMA) {
		throw new Error(`content manifest schema must be ${CONTENT_MANIFEST_SCHEMA}`);
	}
	assertExactKeys(
		value,
		["schema", "prompts", "toolSchemas", "providerMappings", "implementationSources", "behaviorSha256", "rootSha256"],
		"content manifest",
	);
	if (
		!Array.isArray(value.prompts) ||
		!Array.isArray(value.toolSchemas) ||
		!Array.isArray(value.providerMappings) ||
		!Array.isArray(value.implementationSources) ||
		value.implementationSources.length === 0
	) {
		throw new Error("content manifest entries must be arrays");
	}
	assertSortedUniqueIds(value.prompts, "content manifest prompts");
	assertSortedUniqueIds(value.toolSchemas, "content manifest tools");
	assertSortedUniqueIds(value.providerMappings, "content manifest provider mappings");
	for (const [index, entry] of value.prompts.entries()) {
		if (!isRecord(entry)) throw new Error(`content manifest prompt ${index} must be an object`);
		assertExactKeys(
			entry,
			["id", "path", "role", "target", "trigger", "visibility", "defaultEnabled", "order", "sha256"],
			`content manifest prompt ${index}`,
		);
		assertString(entry.id, `content manifest prompt ${index} id`);
		assertString(entry.path, `content manifest prompt ${index} path`);
		if (!["system", "developer", "internal_context"].includes(String(entry.role))) {
			throw new Error(`content manifest prompt ${index} has invalid role`);
		}
		if (
			!Array.isArray(entry.target) ||
			entry.target.length === 0 ||
			entry.target.some(target => !["main", "subagent", "side_model"].includes(String(target)))
		) {
			throw new Error(`content manifest prompt ${index} has invalid target`);
		}
		assertString(entry.trigger, `content manifest prompt ${index} trigger`);
		if (!["model", "conditional", "offline_only"].includes(String(entry.visibility))) {
			throw new Error(`content manifest prompt ${index} has invalid visibility`);
		}
		if (typeof entry.defaultEnabled !== "boolean" || !Number.isSafeInteger(entry.order)) {
			throw new Error(`content manifest prompt ${index} has invalid default/order`);
		}
		assertSha256(entry.sha256, `content manifest prompt ${index} sha256`);
	}
	for (const [index, entry] of value.toolSchemas.entries()) {
		if (!isRecord(entry)) throw new Error(`content manifest tool ${index} must be an object`);
		assertExactKeys(entry, ["id", "descriptionSha256", "schemaSha256"], `content manifest tool ${index}`);
		assertString(entry.id, `content manifest tool ${index} id`);
		assertSha256(entry.descriptionSha256, `content manifest tool ${index} descriptionSha256`);
		assertSha256(entry.schemaSha256, `content manifest tool ${index} schemaSha256`);
	}
	for (const [index, entry] of value.providerMappings.entries()) {
		if (!isRecord(entry)) throw new Error(`content manifest provider mapping ${index} must be an object`);
		assertExactKeys(
			entry,
			["id", "semanticRole", "actualRole", "when", "wrapperPromptId"],
			`content manifest provider mapping ${index}`,
		);
		assertString(entry.id, `content manifest provider mapping ${index} id`);
		if (entry.semanticRole !== "internal_context" || !["developer", "system"].includes(String(entry.actualRole))) {
			throw new Error(`content manifest provider mapping ${index} has invalid role`);
		}
		assertString(entry.when, `content manifest provider mapping ${index} when`);
		assertString(entry.wrapperPromptId, `content manifest provider mapping ${index} wrapperPromptId`);
	}
	let previousImplementationPath: string | undefined;
	for (const [index, entry] of value.implementationSources.entries()) {
		if (!isRecord(entry)) throw new Error(`content manifest implementation ${index} must be an object`);
		assertExactKeys(entry, ["path", "sha256"], `content manifest implementation ${index}`);
		assertString(entry.path, `content manifest implementation ${index} path`);
		if (
			entry.path.startsWith("/") ||
			entry.path.startsWith("./") ||
			entry.path.endsWith("/") ||
			entry.path.includes("\\") ||
			entry.path.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")
		) {
			throw new Error(`content manifest implementation ${index} has invalid path`);
		}
		if (previousImplementationPath !== undefined && previousImplementationPath.localeCompare(entry.path) >= 0) {
			throw new Error("content manifest implementations must be sorted and unique by path");
		}
		previousImplementationPath = entry.path;
		assertSha256(entry.sha256, `content manifest implementation ${index} sha256`);
	}
	assertSha256(value.behaviorSha256, "content manifest behaviorSha256");
	assertSha256(value.rootSha256, "content manifest rootSha256");
	const manifest = value as unknown as ContentManifest;
	const computed = sha256(canonicalJson(manifestPayload(manifest) as unknown as JsonValue));
	if (computed !== manifest.rootSha256) throw new Error("content manifest rootSha256 does not match its payload");
	return manifest;
}

export function parseContextReleaseManifest(source: string): ContextReleaseManifest {
	const value: unknown = JSON.parse(source);
	if (!isRecord(value) || value.schema !== RELEASE_MANIFEST_SCHEMA) {
		throw new Error(`release manifest schema must be ${RELEASE_MANIFEST_SCHEMA}`);
	}
	assertExactKeys(
		value,
		[
			"schema",
			"repository",
			"commit",
			"tree",
			"candidates",
			"contentManifest",
			"contentManifestRootSha256",
			"behaviorSha256",
			"globalAgentsPath",
			"globalAgentsSha256",
			"globalAgentsSourceSha256",
			"configurationPath",
			"configurationSourceSha256",
			"configurationSemanticSha256",
			"combinedPromptBehaviorSha256",
			"rootSha256",
		],
		"release manifest",
	);
	if (typeof value.repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(value.repository)) {
		throw new Error("release manifest repository must be owner/name");
	}
	if (!/^[a-f0-9]{40}$/.test(String(value.commit)) || !/^[a-f0-9]{40}$/.test(String(value.tree))) {
		throw new Error("release manifest commit/tree must be Git SHA-1 object ids");
	}
	if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
		throw new Error("release manifest candidates must be a non-empty array");
	}
	const candidates: CandidateIdentity[] = value.candidates.map((candidate, index) => {
		if (!isRecord(candidate)) throw new Error(`release manifest candidate ${index} must be an object`);
		assertExactKeys(candidate, ["repository", "commit", "tree"], `release manifest candidate ${index}`);
		if (
			typeof candidate.repository !== "string" ||
			!/^[^/\s]+\/[^/\s]+$/.test(candidate.repository) ||
			!(/^[a-f0-9]{40}$/.test(String(candidate.commit)) && /^[a-f0-9]{40}$/.test(String(candidate.tree)))
		) {
			throw new Error(`release manifest candidate ${index} is invalid`);
		}
		return {
			repository: candidate.repository,
			commit: String(candidate.commit),
			tree: String(candidate.tree),
		};
	});
	if (
		canonicalJson(candidates as unknown as JsonValue) !==
		canonicalJson(sortCandidates(candidates) as unknown as JsonValue)
	) {
		throw new Error("release manifest candidates must be sorted");
	}
	if (new Set(candidates.map(candidate => candidate.repository)).size !== candidates.length) {
		throw new Error("release manifest candidates must have unique repositories");
	}
	const ownCandidate = candidates.find(candidate => candidate.repository === value.repository);
	if (!ownCandidate || ownCandidate.commit !== value.commit || ownCandidate.tree !== value.tree) {
		throw new Error("release manifest repository identity must match its candidate");
	}
	if (!isRecord(value.contentManifest)) throw new Error("release manifest contentManifest must be an object");
	const contentManifest = parseContentManifest(JSON.stringify(value.contentManifest));
	for (const field of [
		"contentManifestRootSha256",
		"behaviorSha256",
		"globalAgentsSha256",
		"globalAgentsSourceSha256",
		"configurationSourceSha256",
		"configurationSemanticSha256",
		"combinedPromptBehaviorSha256",
		"rootSha256",
	] as const) {
		assertSha256(value[field], `release manifest ${field}`);
	}
	assertString(value.globalAgentsPath, "release manifest globalAgentsPath");
	assertString(value.configurationPath, "release manifest configurationPath");
	if (
		value.contentManifestRootSha256 !== contentManifest.rootSha256 ||
		value.behaviorSha256 !== contentManifest.behaviorSha256 ||
		value.globalAgentsSha256 !== value.globalAgentsSourceSha256
	) {
		throw new Error("release manifest aliases do not match their bound values");
	}
	const combined = sha256(
		canonicalJson({
			behaviorSha256: String(value.behaviorSha256),
			contentManifestRootSha256: String(value.contentManifestRootSha256),
		}),
	);
	if (value.combinedPromptBehaviorSha256 !== combined) {
		throw new Error("release manifest combinedPromptBehaviorSha256 does not match");
	}
	const { rootSha256, ...payload } = value;
	if (rootSha256 !== sha256(canonicalJson(payload as JsonValue))) {
		throw new Error("release manifest rootSha256 does not match its payload");
	}
	return value as unknown as ContextReleaseManifest;
}

export function trackedContentManifest(): ContentManifest {
	const source: unknown = trackedManifestSource;
	return parseContentManifest(typeof source === "string" ? source : JSON.stringify(source));
}

/** Recompute source-backed fields while retaining exact generated tool-schema entries. */
export async function currentContentManifest(): Promise<ContentManifest> {
	const tracked = trackedContentManifest();
	const registry = promptRegistry();
	const prompts = registry.prompts
		.map(entry => ({
			...entry,
			path: registeredPromptRepositoryPath(entry.path),
			sha256: sha256(registeredPromptSource(entry.id)),
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
	const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
	const implementationSources = await Promise.all(
		tracked.implementationSources.map(async entry => ({
			path: entry.path,
			sha256: sha256(
				await readRequiredSource(path.join(repositoryRoot, entry.path), `implementation ${entry.path}`),
			),
		})),
	);
	const { buildGeneratedToolContractManifest } = await import("./tool-contracts");
	const payload = {
		schema: CONTENT_MANIFEST_SCHEMA,
		prompts,
		toolSchemas: buildGeneratedToolContractManifest(),
		providerMappings: tracked.providerMappings,
		implementationSources,
		behaviorSha256: sha256(behaviorRegistrySource()),
	};
	return {
		...payload,
		rootSha256: sha256(canonicalJson(payload as unknown as JsonValue)),
	};
}

export async function assertTrackedManifestCurrent(): Promise<ContentManifest> {
	const tracked = trackedContentManifest();
	const current = await currentContentManifest();
	const { rootSha256: _rootSha256, ...payload } = current;
	current.rootSha256 = sha256(canonicalJson(payload as unknown as JsonValue));
	if (tracked.rootSha256 !== current.rootSha256) {
		throw new Error(
			`PROMPT_POLICY_REVIEW_REQUIRED: generated content manifest is stale (${tracked.rootSha256} != ${current.rootSha256})`,
		);
	}
	return current;
}

async function readRequiredSource(filePath: string, label: string): Promise<string> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) throw new Error(`PROMPT_POLICY_REVIEW_REQUIRED: missing ${label}: ${filePath}`);
	return await file.text();
}

function semanticConfigurationHash(source: string): string {
	const parsed = source.trim().length > 0 ? (YAML.parse(source) as unknown) : {};
	return sha256(canonicalJson((parsed ?? {}) as JsonValue));
}

function sortCandidates(candidates: readonly CandidateIdentity[]): CandidateIdentity[] {
	return [...candidates].sort(
		(left, right) =>
			left.repository.localeCompare(right.repository) ||
			left.commit.localeCompare(right.commit) ||
			left.tree.localeCompare(right.tree),
	);
}

function validateCandidateSet(
	current: CandidateIdentity,
	candidates: readonly CandidateIdentity[],
): CandidateIdentity[] {
	const sorted = sortCandidates(candidates);
	if (new Set(sorted.map(candidate => candidate.repository)).size !== sorted.length) {
		throw new Error("PROMPT_POLICY_REVIEW_REQUIRED: candidate repositories must be unique");
	}
	const omp = sorted.find(candidate => candidate.repository === OMP_REPOSITORY);
	if (!omp || omp.commit !== current.commit || omp.tree !== current.tree) {
		throw new Error("PROMPT_POLICY_REVIEW_REQUIRED: candidates do not match current OMP identity");
	}
	return sorted;
}

async function loadActivationCandidates(current: CandidateIdentity): Promise<CandidateIdentity[]> {
	const statePath = activationStatePath();
	if (!(await Bun.file(statePath).exists())) return [current];
	const state = parseContextReleaseManifest(await Bun.file(statePath).text());
	return validateCandidateSet(current, state.candidates);
}

export function activationStatePath(explicitPath?: string): string {
	return explicitPath ?? path.join(os.homedir(), ".omp/policy-state.json");
}

export function canonicalAgentDirPath(): string {
	return path.join(os.homedir(), ".omp/agent");
}

export function approvedCandidateSourceMatches(
	repository: string | undefined,
	identity: Pick<CandidateIdentity, "commit" | "tree"> | undefined,
	workingSha256: string,
	committedSha256: string,
	release: Pick<ContextReleaseManifest, "candidates">,
): boolean {
	if (!repository || !identity) return false;
	const candidate = release.candidates.find(item => item.repository === repository);
	return (
		candidate?.commit === identity.commit && candidate.tree === identity.tree && workingSha256 === committedSha256
	);
}

/** Bind an external runtime source to exact bytes in one approved candidate. */
export async function isApprovedCandidateSource(filePath: string, release: ContextReleaseManifest): Promise<boolean> {
	try {
		const resolved = path.resolve(filePath);
		const repositoryRoot = await repo.root(path.dirname(resolved));
		if (!repositoryRoot) return false;
		const relative = path.relative(repositoryRoot, resolved).replaceAll(path.sep, "/");
		if (relative.startsWith("../") || path.isAbsolute(relative)) return false;
		const identity = await ref.commitIdentity(repositoryRoot, "HEAD");
		if (!identity) return false;
		const remoteNames = await remote.list(repositoryRoot);
		let repository: string | undefined;
		for (const name of ["origin", ...remoteNames.filter(name => name !== "origin")]) {
			repository = canonicalGithubRepository(await remote.url(repositoryRoot, name));
			if (repository) break;
		}
		const [workingSource, committedSource] = await Promise.all([
			readRequiredSource(resolved, `candidate source ${resolved}`),
			show(repositoryRoot, `HEAD:${relative}`),
		]);
		return approvedCandidateSourceMatches(
			repository,
			identity,
			sha256(workingSource),
			sha256(committedSource),
			release,
		);
	} catch {
		return false;
	}
}

export async function buildContextReleaseManifest(
	_projectCwd: string = process.cwd(),
	candidateOverride?: readonly CandidateIdentity[],
	options?: { requireCleanCanonicalCheckout?: boolean },
): Promise<ContextReleaseManifest> {
	const packageRoot = path.resolve(import.meta.dir, "../..");
	const repositoryRoot = await repo.root(packageRoot);
	if (!repositoryRoot) throw new Error("omp context requires an OMP source or installed Git checkout");
	const identity = await ref.commitIdentity(repositoryRoot, "HEAD");
	if (!identity) throw new Error(`omp context requires a committed Git HEAD at ${repositoryRoot}`);
	const { commit, tree } = identity;
	if (candidateOverride || options?.requireCleanCanonicalCheckout) {
		const [origin, worktreeStatus] = await Promise.all([
			remote.url(repositoryRoot, "origin"),
			status(repositoryRoot, { porcelainV1: true, untrackedFiles: "all", z: true }),
		]);
		if (canonicalGithubRepository(origin) !== OMP_REPOSITORY) {
			throw new Error(`PROMPT_POLICY_REVIEW_REQUIRED: OMP checkout origin must be ${OMP_REPOSITORY}`);
		}
		if (worktreeStatus.length > 0) {
			throw new Error("PROMPT_POLICY_REVIEW_REQUIRED: OMP checkout must be clean");
		}
	}
	const content = await assertTrackedManifestCurrent();
	const currentCandidate = { repository: OMP_REPOSITORY, commit, tree };
	const candidates = candidateOverride
		? validateCandidateSet(currentCandidate, candidateOverride)
		: await loadActivationCandidates(currentCandidate);
	const agentDir = canonicalAgentDirPath();
	const globalAgentsPath = path.join(agentDir, "AGENTS.md");
	const configurationPath = path.join(agentDir, "config.yml");
	const [globalAgentsSource, configurationSource] = await Promise.all([
		readRequiredSource(globalAgentsPath, "global AGENTS.md"),
		readRequiredSource(configurationPath, "OMP configuration"),
	]);
	const combinedPromptBehaviorSha256 = sha256(
		canonicalJson({
			behaviorSha256: content.behaviorSha256,
			contentManifestRootSha256: content.rootSha256,
		}),
	);
	const payload = {
		schema: RELEASE_MANIFEST_SCHEMA,
		repository: OMP_REPOSITORY,
		commit,
		tree,
		candidates,
		contentManifest: content,
		contentManifestRootSha256: content.rootSha256,
		behaviorSha256: content.behaviorSha256,
		globalAgentsPath,
		globalAgentsSha256: sha256(globalAgentsSource),
		globalAgentsSourceSha256: sha256(globalAgentsSource),
		configurationPath,
		configurationSourceSha256: sha256(configurationSource),
		configurationSemanticSha256: semanticConfigurationHash(configurationSource),
		combinedPromptBehaviorSha256,
	};
	return { ...payload, rootSha256: sha256(canonicalJson(payload as unknown as JsonValue)) };
}
