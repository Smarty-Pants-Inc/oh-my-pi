import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import trackedManifestSource from "../../generated/prompt-manifest.json" with { type: "text" };
import { isExtensionSourceGraphContained } from "../extensibility/plugins/legacy-pi-compat";
import { diff, fetch as gitFetch, ref, remote, repo, show, status } from "../utils/git";
import { canonicalJson, compareUnicodeCodePoints, type JsonValue, sha256 } from "./canonical";
import { computeImplementationSources } from "./implementation-sources";
import {
	behaviorRegistrySource,
	promptRegistry,
	registeredPromptRepositoryPath,
	registeredPromptSource,
} from "./registry";

export const CONTENT_MANIFEST_SCHEMA = "omp.prompt_manifest.v1" as const;
export const RELEASE_MANIFEST_SCHEMA = "omp.context_release_manifest.v1" as const;
export const OMP_REPOSITORY = "Smarty-Pants-Inc/oh-my-pi";
const OMP_SCOPE_BASE = {
	commit: "37eee71978951fccf66b21f7e3e2b74596ac9d74",
	tree: "a20c0452f99155e7adeaecfad28e4afd0223c684",
} as const;
const OMP_SCOPE_BASE_URL = "https://github.com/can1357/oh-my-pi.git";

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
	baseCommit: string;
	baseTree: string;
	commit: string;
	tree: string;
	scopeCoverage: ScopeCoverageEntry[];
}

export type ScopeCoverageEntry =
	| { path: string; requirement: string }
	| { path: string; dependencyOf: string; necessity: string };

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

function assertRepositoryPath(value: unknown, label: string): asserts value is string {
	assertString(value, label);
	if (
		value.startsWith("/") ||
		value.startsWith("./") ||
		value.endsWith("/") ||
		value.includes("\\") ||
		value.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")
	) {
		throw new Error(`${label} must be a normalized repository-relative path`);
	}
}

function assertSha256(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new Error(`${label} must be a lowercase SHA-256`);
	}
}

function assertGitObject(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
		throw new Error(`${label} must be a Git SHA-1 object id`);
	}
}

export function parseScopeCoverage(value: unknown, label: string): ScopeCoverageEntry[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	let previousPath: string | undefined;
	const entries = value.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`${label} ${index} must be an object`);
		const entryLabel = `${label} ${index}`;
		if ("requirement" in entry) {
			assertExactKeys(entry, ["path", "requirement"], entryLabel);
			assertRepositoryPath(entry.path, `${entryLabel} path`);
			assertString(entry.requirement, `${entryLabel} requirement`);
			if (!/§\d+\.\d+(?:\.\d+)?(?:\b|\s)/u.test(entry.requirement)) {
				throw new Error(`${entryLabel} requirement must name an exact specification section or item`);
			}
		} else {
			assertExactKeys(entry, ["path", "dependencyOf", "necessity"], entryLabel);
			assertRepositoryPath(entry.path, `${entryLabel} path`);
			assertRepositoryPath(entry.dependencyOf, `${entryLabel} dependencyOf`);
			if (typeof entry.necessity !== "string" || entry.necessity.trim().length === 0) {
				throw new Error(`${entryLabel} necessity must be a non-empty reason`);
			}
		}
		if (previousPath !== undefined && compareUnicodeCodePoints(previousPath, entry.path) >= 0) {
			throw new Error(`${label} must be sorted and unique by path`);
		}
		previousPath = entry.path;
		return entry as ScopeCoverageEntry;
	});
	const directPaths = new Set(entries.filter(entry => "requirement" in entry).map(entry => entry.path));
	for (const [index, entry] of entries.entries()) {
		if (!("dependencyOf" in entry)) continue;
		if (entry.dependencyOf === entry.path) {
			throw new Error(`${label} ${index} dependencyOf must not reference itself`);
		}
		if (!directPaths.has(entry.dependencyOf)) {
			throw new Error(`${label} ${index} dependencyOf must reference a directly mapped path in the same set`);
		}
	}
	return entries;
}

export function parseCandidateIdentities(value: unknown, label: string): CandidateIdentity[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
	const candidates = value.map((candidate, index) => {
		if (!isRecord(candidate)) throw new Error(`${label} ${index} must be an object`);
		assertExactKeys(
			candidate,
			["repository", "baseCommit", "baseTree", "commit", "tree", "scopeCoverage"],
			`${label} ${index}`,
		);
		if (typeof candidate.repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(candidate.repository)) {
			throw new Error(`${label} ${index} repository must be owner/name`);
		}
		assertGitObject(candidate.baseCommit, `${label} ${index} baseCommit`);
		assertGitObject(candidate.baseTree, `${label} ${index} baseTree`);
		assertGitObject(candidate.commit, `${label} ${index} commit`);
		assertGitObject(candidate.tree, `${label} ${index} tree`);
		return {
			repository: candidate.repository,
			baseCommit: candidate.baseCommit,
			baseTree: candidate.baseTree,
			commit: candidate.commit,
			tree: candidate.tree,
			scopeCoverage: parseScopeCoverage(candidate.scopeCoverage, `${label} ${index} scopeCoverage`),
		};
	});
	if (new Set(candidates.map(candidate => candidate.repository)).size !== candidates.length) {
		throw new Error(`${label} repositories must be unique`);
	}
	if (
		canonicalJson(candidates as unknown as JsonValue) !==
		canonicalJson(sortCandidates(candidates) as unknown as JsonValue)
	) {
		throw new Error(`${label} must be sorted by repository and identity`);
	}
	return candidates;
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
		if (
			previousImplementationPath !== undefined &&
			compareUnicodeCodePoints(previousImplementationPath, entry.path) >= 0
		) {
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
	const candidates = parseCandidateIdentities(value.candidates, "release manifest candidates");
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
	const implementationSources = await computeImplementationSources(repositoryRoot);
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
			compareUnicodeCodePoints(left.repository, right.repository) ||
			compareUnicodeCodePoints(left.baseCommit, right.baseCommit) ||
			compareUnicodeCodePoints(left.baseTree, right.baseTree) ||
			compareUnicodeCodePoints(left.commit, right.commit) ||
			compareUnicodeCodePoints(left.tree, right.tree),
	);
}

export function validateScopeCoverage(changedPaths: readonly string[], coverage: unknown): ScopeCoverageEntry[] {
	const expectedPaths = [...changedPaths].sort(compareUnicodeCodePoints);
	for (const [index, changedPath] of expectedPaths.entries()) {
		assertRepositoryPath(changedPath, `changed path ${index}`);
		if (index > 0 && expectedPaths[index - 1] === changedPath) {
			throw new Error("PROMPT_POLICY_REVIEW_REQUIRED: actual diff contains a duplicate changed path");
		}
	}
	const parsed = parseScopeCoverage(coverage, "scopeCoverage");
	const coveredPaths = parsed.map(entry => entry.path);
	if (
		expectedPaths.length !== coveredPaths.length ||
		expectedPaths.some((changedPath, index) => changedPath !== coveredPaths[index])
	) {
		const expected = new Set(expectedPaths);
		const covered = new Set(coveredPaths);
		const missing = expectedPaths.filter(changedPath => !covered.has(changedPath));
		const extra = coveredPaths.filter(coveredPath => !expected.has(coveredPath));
		throw new Error(
			`PROMPT_POLICY_REVIEW_REQUIRED: scopeCoverage does not equal the actual diff` +
				` (missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"})`,
		);
	}
	return parsed;
}

async function ensureOmpScopeBase(repositoryRoot: string): Promise<void> {
	let identity = await ref.commitIdentity(repositoryRoot, OMP_SCOPE_BASE.commit);
	if (!identity) {
		try {
			await gitFetch(
				repositoryRoot,
				OMP_SCOPE_BASE_URL,
				OMP_SCOPE_BASE.commit,
				`refs/omp/scope-base/${OMP_SCOPE_BASE.commit}`,
			);
		} catch {
			throw new Error(`PROMPT_POLICY_REVIEW_REQUIRED: missing exact OMP scope base ${OMP_SCOPE_BASE.commit}`);
		}
		identity = await ref.commitIdentity(repositoryRoot, OMP_SCOPE_BASE.commit);
	}
	if (identity?.commit !== OMP_SCOPE_BASE.commit || identity.tree !== OMP_SCOPE_BASE.tree) {
		throw new Error(
			`PROMPT_POLICY_REVIEW_REQUIRED: OMP scope base identity does not match ${OMP_SCOPE_BASE.commit}/${OMP_SCOPE_BASE.tree}`,
		);
	}
}

async function buildCurrentCandidate(
	repositoryRoot: string,
	identity: Pick<CandidateIdentity, "commit" | "tree">,
	scopeCoverageInput: unknown,
): Promise<CandidateIdentity> {
	await ensureOmpScopeBase(repositoryRoot);
	const changedPaths = (
		await diff(repositoryRoot, {
			base: OMP_SCOPE_BASE.commit,
			head: identity.commit,
			nameOnly: true,
			z: true,
		})
	)
		.split("\0")
		.filter(Boolean)
		.sort(compareUnicodeCodePoints);
	const scopeCoverage = validateScopeCoverage(changedPaths, scopeCoverageInput);
	return {
		repository: OMP_REPOSITORY,
		baseCommit: OMP_SCOPE_BASE.commit,
		baseTree: OMP_SCOPE_BASE.tree,
		commit: identity.commit,
		tree: identity.tree,
		scopeCoverage,
	};
}

function validateCandidateSet(
	current: CandidateIdentity,
	candidates: readonly CandidateIdentity[],
): CandidateIdentity[] {
	const sorted = parseCandidateIdentities(sortCandidates(candidates), "candidate set");
	const omp = sorted.find(candidate => candidate.repository === OMP_REPOSITORY);
	if (!omp || canonicalJson(omp as unknown as JsonValue) !== canonicalJson(current as unknown as JsonValue)) {
		throw new Error("PROMPT_POLICY_REVIEW_REQUIRED: candidates do not match current OMP identity and scope");
	}
	return sorted;
}

async function loadActivationCandidates(): Promise<CandidateIdentity[] | undefined> {
	const statePath = activationStatePath();
	if (!(await Bun.file(statePath).exists())) return undefined;
	const state = parseContextReleaseManifest(await Bun.file(statePath).text());
	return state.candidates;
}

export function activationStatePath(explicitPath?: string): string {
	return explicitPath ?? path.join(os.homedir(), ".omp/policy-state.json");
}

export function canonicalAgentDirPath(): string {
	return path.join(os.homedir(), ".omp/agent");
}

export function approvedCandidateSourceMatches(
	repository: string | undefined,
	approvedIdentity: Pick<CandidateIdentity, "commit" | "tree"> | undefined,
	approvedPackageTree: string | undefined,
	headPackageTree: string | undefined,
	workingSourceStatus: string,
	release: Pick<ContextReleaseManifest, "candidates">,
): boolean {
	if (!repository || !approvedIdentity || !approvedPackageTree || !headPackageTree) return false;
	const candidate = release.candidates.find(item => item.repository === repository);
	return (
		candidate?.commit === approvedIdentity.commit &&
		candidate.tree === approvedIdentity.tree &&
		approvedPackageTree === headPackageTree &&
		workingSourceStatus === ""
	);
}

async function approvedCandidateSourceRoot(
	repositoryRoot: string,
	resolvedSource: string,
	candidateCommit: string,
): Promise<string | undefined> {
	let current = path.dirname(resolvedSource);
	while (true) {
		const relativeManifest = path
			.relative(repositoryRoot, path.join(current, "package.json"))
			.replaceAll(path.sep, "/");
		try {
			await show(repositoryRoot, `${candidateCommit}:${relativeManifest}`);
			return current;
		} catch {
			if (current === repositoryRoot) return undefined;
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}
}

/** Bind an external runtime source to an unchanged, clean package in one approved candidate. */
export async function isApprovedCandidateSource(filePath: string, release: ContextReleaseManifest): Promise<boolean> {
	try {
		const resolved = await fs.realpath(path.resolve(filePath));
		const repositoryRoot = await repo.root(path.dirname(resolved));
		if (!repositoryRoot) return false;
		const relative = path.relative(repositoryRoot, resolved).replaceAll(path.sep, "/");
		if (relative.startsWith("../") || path.isAbsolute(relative)) return false;
		const remoteNames = await remote.list(repositoryRoot);
		let repository: string | undefined;
		for (const name of ["origin", ...remoteNames.filter(name => name !== "origin")]) {
			repository = canonicalGithubRepository(await remote.url(repositoryRoot, name));
			if (repository) break;
		}
		const candidate = release.candidates.find(item => item.repository === repository);
		if (!candidate) return false;
		const approvedIdentity = await ref.commitIdentity(repositoryRoot, candidate.commit);
		const sourceRoot = await approvedCandidateSourceRoot(repositoryRoot, resolved, candidate.commit);
		if (!sourceRoot) return false;
		const relativeSourceRoot = path.relative(repositoryRoot, sourceRoot).replaceAll(path.sep, "/");
		const [approvedPackageTree, headPackageTree, workingSourceStatus, sourceGraphContained] = await Promise.all([
			ref.resolve(repositoryRoot, `${candidate.commit}:${relativeSourceRoot}`),
			ref.resolve(repositoryRoot, `HEAD:${relativeSourceRoot}`),
			status(repositoryRoot, {
				porcelainV1: true,
				untrackedFiles: "all",
				includeIgnored: true,
				z: true,
				pathspecs: [relativeSourceRoot],
			}),
			isExtensionSourceGraphContained(resolved, sourceRoot),
		]);
		if (!sourceGraphContained) return false;
		return approvedCandidateSourceMatches(
			repository,
			approvedIdentity ?? undefined,
			approvedPackageTree ?? undefined,
			headPackageTree ?? undefined,
			workingSourceStatus,
			release,
		);
	} catch {
		return false;
	}
}

export async function buildContextReleaseManifest(
	_projectCwd: string = process.cwd(),
	candidateOverride?: readonly CandidateIdentity[],
	options?: { requireCleanCanonicalCheckout?: boolean; scopeCoverage?: unknown },
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
	const candidateInput = candidateOverride ?? (await loadActivationCandidates());
	const suppliedOmp = candidateInput?.find(candidate => candidate.repository === OMP_REPOSITORY);
	const scopeCoverageInput = options?.scopeCoverage ?? suppliedOmp?.scopeCoverage;
	if (!scopeCoverageInput) {
		throw new Error("PROMPT_POLICY_REVIEW_REQUIRED: missing reviewed OMP scopeCoverage input");
	}
	const currentCandidate = await buildCurrentCandidate(repositoryRoot, { commit, tree }, scopeCoverageInput);
	const candidates = candidateInput ? validateCandidateSet(currentCandidate, candidateInput) : [currentCandidate];
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
