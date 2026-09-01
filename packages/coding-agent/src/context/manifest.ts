import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import trackedManifestSource from "../../generated/prompt-manifest.json" with { type: "text" };
import type { ApprovedLegacyPiModule, LegacyPiModuleSnapshot } from "../extensibility/plugins/legacy-pi-compat";
import { config, diff, fetch as gitFetch, ls, ref, remote, repo, show, status } from "../utils/git";
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
const MATERIALIZED_STACK_PACKAGE_METADATA_PATHS: Record<string, true> = {
	"PROVENANCE.json": true,
	"MANIFEST.json": true,
	"SHA256SUMS.txt": true,
	"extensions/smarty-prompt-guard/package.json": true,
};

/** Hash the immutable Stack content shared by source candidates and materialized runtimes. */
export function stackPackageContentSha256(entries: readonly { path: string; sha256: string }[]): string {
	let previousPath: string | undefined;
	const retained: Array<{ path: string; sha256: string }> = [];
	for (const entry of entries) {
		if (previousPath !== undefined && compareUnicodeCodePoints(previousPath, entry.path) >= 0) {
			throw new Error("Stack package entries must be sorted and unique by path");
		}
		previousPath = entry.path;
		if (!Object.hasOwn(MATERIALIZED_STACK_PACKAGE_METADATA_PATHS, entry.path)) {
			retained.push({ path: entry.path, sha256: entry.sha256 });
		}
	}
	if (retained.length === 0) throw new Error("Stack package has no static content entries");
	return sha256(canonicalJson(retained));
}

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
	stackPackageContentSha256: string;
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
			"stackPackageContentSha256",
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
		"stackPackageContentSha256",
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

async function loadActivationState(): Promise<ContextReleaseManifest | undefined> {
	const statePath = activationStatePath();
	if (!(await Bun.file(statePath).exists())) return undefined;
	return parseContextReleaseManifest(await Bun.file(statePath).text());
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

type WorkingTreeEntry =
	| { readonly kind: "file"; readonly mode: "100644" | "100755" | "120000"; readonly objectId: string }
	| { readonly kind: "tree"; readonly entries: Map<string, WorkingTreeEntry> };

const UTF8_ENCODER = new TextEncoder();

function gitObjectId(type: "blob" | "tree", bytes: Uint8Array, expectedLength: number): string | undefined {
	const hasher =
		expectedLength === 40
			? new Bun.CryptoHasher("sha1")
			: expectedLength === 64
				? new Bun.CryptoHasher("sha256")
				: undefined;
	if (!hasher) return undefined;
	hasher.update(`${type} ${bytes.byteLength}\0`);
	hasher.update(bytes);
	return hasher.digest("hex");
}

function objectIdBytes(objectId: string): Uint8Array | undefined {
	if (objectId.length % 2 !== 0 || !/^[a-f0-9]+$/.test(objectId)) return undefined;
	const bytes = new Uint8Array(objectId.length / 2);
	for (let index = 0; index < bytes.length; index++) {
		bytes[index] = Number.parseInt(objectId.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function concatenateBytes(chunks: readonly Uint8Array[]): Uint8Array {
	const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function compareGitTreeEntries(
	[leftName, left]: readonly [string, WorkingTreeEntry],
	[rightName, right]: readonly [string, WorkingTreeEntry],
): number {
	const leftBytes = UTF8_ENCODER.encode(leftName);
	const rightBytes = UTF8_ENCODER.encode(rightName);
	const commonLength = Math.min(leftBytes.length, rightBytes.length);
	for (let index = 0; index < commonLength; index++) {
		const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
		if (difference !== 0) return difference;
	}
	const leftTerminator =
		leftBytes.length === commonLength ? (left.kind === "tree" ? 0x2f : 0) : leftBytes[commonLength];
	const rightTerminator =
		rightBytes.length === commonLength ? (right.kind === "tree" ? 0x2f : 0) : rightBytes[commonLength];
	return (leftTerminator ?? 0) - (rightTerminator ?? 0);
}

function workingTreeObjectId(
	tree: Extract<WorkingTreeEntry, { kind: "tree" }>,
	expectedLength: number,
): string | undefined {
	const chunks: Uint8Array[] = [];
	for (const [name, entry] of [...tree.entries].sort(compareGitTreeEntries)) {
		const objectId = entry.kind === "tree" ? workingTreeObjectId(entry, expectedLength) : entry.objectId;
		if (!objectId) return undefined;
		const idBytes = objectIdBytes(objectId);
		if (!idBytes) return undefined;
		const mode = entry.kind === "tree" ? "40000" : entry.mode;
		chunks.push(UTF8_ENCODER.encode(`${mode} ${name}\0`), idBytes);
	}
	return gitObjectId("tree", concatenateBytes(chunks), expectedLength);
}

async function workingPackageTreeObjectId(
	repositoryRoot: string,
	relativeSourceRoot: string,
	expectedLength: number,
): Promise<string | undefined> {
	const [trackedEntries, fileModeConfig, symlinksConfig] = await Promise.all([
		ls.treeEntries(repositoryRoot, "HEAD", [`:(literal)${relativeSourceRoot || "."}`]),
		config.get(repositoryRoot, "core.fileMode"),
		config.get(repositoryRoot, "core.symlinks"),
	]);
	const normalizedFileMode = fileModeConfig?.toLowerCase();
	const useFilesystemMode =
		normalizedFileMode !== "false" &&
		normalizedFileMode !== "no" &&
		normalizedFileMode !== "off" &&
		normalizedFileMode !== "0";
	const normalizedSymlinks = symlinksConfig?.toLowerCase();
	const useFilesystemSymlinks =
		normalizedSymlinks !== "false" &&
		normalizedSymlinks !== "no" &&
		normalizedSymlinks !== "off" &&
		normalizedSymlinks !== "0";
	const root: Extract<WorkingTreeEntry, { kind: "tree" }> = { kind: "tree", entries: new Map() };
	const verifiedDirectories = new Set<string>();
	for (const { path: trackedPath, mode: trackedMode } of trackedEntries) {
		const relative = relativeSourceRoot ? path.posix.relative(relativeSourceRoot, trackedPath) : trackedPath;
		if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative))
			return undefined;
		const parts = relative.split("/");
		let tree = root;
		for (let index = 0; index < parts.length - 1; index++) {
			const directoryPath = path.resolve(repositoryRoot, relativeSourceRoot, ...parts.slice(0, index + 1));
			if (!verifiedDirectories.has(directoryPath)) {
				try {
					if (!(await fs.lstat(directoryPath)).isDirectory()) return undefined;
				} catch {
					return undefined;
				}
				verifiedDirectories.add(directoryPath);
			}
			const name = parts[index];
			if (!name) return undefined;
			const existing = tree.entries.get(name);
			if (existing?.kind === "file") return undefined;
			if (existing) {
				tree = existing;
			} else {
				const child: Extract<WorkingTreeEntry, { kind: "tree" }> = { kind: "tree", entries: new Map() };
				tree.entries.set(name, child);
				tree = child;
			}
		}

		const name = parts.at(-1);
		if (!name || tree.entries.has(name)) return undefined;
		const absolutePath = path.resolve(repositoryRoot, trackedPath);
		const repositoryRelative = path.relative(repositoryRoot, absolutePath);
		if (
			repositoryRelative === ".." ||
			repositoryRelative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(repositoryRelative)
		) {
			return undefined;
		}
		let bytes: Uint8Array;
		let mode: "100644" | "100755" | "120000";
		try {
			const stats = await fs.lstat(absolutePath);
			if (stats.isSymbolicLink()) {
				if (trackedMode !== "120000") return undefined;
				mode = trackedMode;
				bytes = UTF8_ENCODER.encode(await fs.readlink(absolutePath));
			} else if (stats.isFile()) {
				if (trackedMode === "120000") {
					if (useFilesystemSymlinks) return undefined;
					mode = trackedMode;
				} else {
					if (trackedMode !== "100644" && trackedMode !== "100755") return undefined;
					const filesystemMode = (stats.mode & 0o100) === 0 ? "100644" : "100755";
					if (useFilesystemMode && filesystemMode !== trackedMode) return undefined;
					mode = trackedMode;
				}
				bytes = await Bun.file(absolutePath).bytes();
			} else {
				return undefined;
			}
		} catch {
			return undefined;
		}
		const objectId = gitObjectId("blob", bytes, expectedLength);
		if (!objectId) return undefined;
		tree.entries.set(name, { kind: "file", mode, objectId });
	}
	return trackedEntries.length > 0 ? workingTreeObjectId(root, expectedLength) : undefined;
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

async function materializedPackageRoot(resolvedSource: string): Promise<string | undefined> {
	let current = path.dirname(resolvedSource);
	while (true) {
		const markers = ["MANIFEST.json", "PROVENANCE.json", "SHA256SUMS.txt"].map(name => path.join(current, name));
		const present = await Promise.all(markers.map(async marker => await Bun.file(marker).exists()));
		if (present.some(Boolean)) return present.every(Boolean) ? current : undefined;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function materializedPackageFiles(directory: string, owner: number, prefix = ""): Promise<string[] | undefined> {
	const directoryStats = await fs.lstat(directory);
	if (
		!directoryStats.isDirectory() ||
		directoryStats.isSymbolicLink() ||
		directoryStats.uid !== owner ||
		(directoryStats.mode & 0o222) !== 0
	) {
		return undefined;
	}
	const files: string[] = [];
	const entries = await fs.readdir(directory, { withFileTypes: true });
	entries.sort((left, right) => compareUnicodeCodePoints(left.name, right.name));
	for (const entry of entries) {
		const absolute = path.join(directory, entry.name);
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		const stats = await fs.lstat(absolute);
		if (stats.isSymbolicLink() || stats.uid !== owner || (stats.mode & 0o222) !== 0) return undefined;
		if (stats.isDirectory()) {
			const nested = await materializedPackageFiles(absolute, owner, relative);
			if (!nested) return undefined;
			files.push(...nested);
		} else if (stats.isFile()) {
			files.push(relative);
		} else {
			return undefined;
		}
	}
	return files;
}

interface ApprovedMaterializedCandidateSource {
	readonly root: string;
	readonly sourceEntries: ReadonlyMap<string, { readonly bytes: number; readonly sha256: string }>;
}

async function isApprovedMaterializedCandidateSource(
	absoluteSource: string,
	resolvedSource: string,
	release: ContextReleaseManifest,
): Promise<ApprovedMaterializedCandidateSource | false> {
	const root = await materializedPackageRoot(resolvedSource);
	if (!root) return false;
	const [manifestSource, provenanceSource, sumsSource] = await Promise.all([
		Bun.file(path.join(root, "MANIFEST.json")).text(),
		Bun.file(path.join(root, "PROVENANCE.json")).text(),
		Bun.file(path.join(root, "SHA256SUMS.txt")).text(),
	]);
	const manifest: unknown = JSON.parse(manifestSource);
	const provenance: unknown = JSON.parse(provenanceSource);
	if (!isRecord(manifest) || !isRecord(provenance)) return false;
	assertExactKeys(manifest, ["schema", "version", "createdAt", "status", "files"], "materialized package manifest");
	assertExactKeys(
		provenance,
		[
			"schema",
			"version",
			"repository",
			"commit",
			"tree",
			"createdAt",
			"purpose",
			"sources",
			"authority",
			"recovery",
			"nonclaims",
		],
		"materialized package provenance",
	);
	assertString(manifest.version, "materialized package manifest version");
	assertString(manifest.createdAt, "materialized package manifest creation date");
	assertString(provenance.version, "materialized package provenance version");
	assertString(provenance.repository, "materialized package provenance repository");
	assertString(provenance.createdAt, "materialized package provenance creation date");
	if (provenance.commit === null && provenance.tree === null) return false;
	assertGitObject(provenance.commit, "materialized package provenance commit");
	assertGitObject(provenance.tree, "materialized package provenance tree");
	if (
		manifest.schema !== "smarty.stack.release_manifest.v1" ||
		manifest.status !== "protected_candidate_requires_external_approval" ||
		provenance.schema !== "smarty.stack.provenance.v1" ||
		provenance.version !== manifest.version ||
		provenance.createdAt !== manifest.createdAt ||
		!/^\d{4}-\d{2}-\d{2}$/.test(manifest.createdAt) ||
		!Array.isArray(manifest.files) ||
		manifest.files.length === 0
	) {
		return false;
	}
	const candidate = release.candidates.find(item => item.repository === provenance.repository);
	const owner = process.getuid?.();
	if (owner === undefined) return false;
	const versions = path.dirname(root);
	const stackRoot = path.dirname(versions);
	if (path.basename(versions) !== "versions" || path.basename(root) !== manifest.version) return false;
	let current = path.dirname(absoluteSource);
	while (path.basename(current) !== "current" || path.basename(path.dirname(current)) !== ".smarty-stack") {
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
	const currentStats = await fs.lstat(current);
	if (
		!currentStats.isSymbolicLink() ||
		currentStats.uid !== owner ||
		(await fs.realpath(path.dirname(current))) !== stackRoot ||
		(await fs.realpath(current)) !== root
	) {
		return false;
	}
	const currentRelative = path.relative(current, absoluteSource);
	if (!currentRelative || currentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(currentRelative))
		return false;
	if (path.resolve(root, currentRelative) !== resolvedSource) return false;
	if (!candidate || candidate.commit !== provenance.commit || candidate.tree !== provenance.tree) return false;

	const expectedChecksums = new Map<string, string>();
	const sourceEntries = new Map<string, { bytes: number; sha256: string }>();
	const contentEntries: Array<{ path: string; sha256: string }> = [];
	let previousPath: string | undefined;
	for (const [index, rawEntry] of manifest.files.entries()) {
		if (!isRecord(rawEntry)) return false;
		assertExactKeys(rawEntry, ["path", "bytes", "sha256"], `materialized package file ${index}`);
		assertRepositoryPath(rawEntry.path, `materialized package file ${index} path`);
		assertSha256(rawEntry.sha256, `materialized package file ${index} sha256`);
		if (typeof rawEntry.bytes !== "number" || !Number.isSafeInteger(rawEntry.bytes) || rawEntry.bytes < 0)
			return false;
		if (previousPath !== undefined && compareUnicodeCodePoints(previousPath, rawEntry.path) >= 0) return false;
		if (rawEntry.path === "MANIFEST.json" || rawEntry.path === "SHA256SUMS.txt") return false;
		const absolute = path.join(root, rawEntry.path);
		const relative = path.relative(root, absolute);
		if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
		const stats = await fs.lstat(absolute);
		if (!stats.isFile() || stats.isSymbolicLink()) return false;
		const bytes = await fs.readFile(absolute);
		if (bytes.byteLength !== rawEntry.bytes || sha256(bytes) !== rawEntry.sha256) return false;
		expectedChecksums.set(rawEntry.path, rawEntry.sha256);
		sourceEntries.set(rawEntry.path, { bytes: rawEntry.bytes, sha256: rawEntry.sha256 });
		contentEntries.push({ path: rawEntry.path, sha256: rawEntry.sha256 });
		previousPath = rawEntry.path;
	}
	if (release.stackPackageContentSha256 !== stackPackageContentSha256(contentEntries)) return false;
	const sourceRelative = path.relative(root, resolvedSource).replaceAll(path.sep, "/");
	if (!expectedChecksums.has(sourceRelative)) return false;
	expectedChecksums.set("MANIFEST.json", sha256(manifestSource));

	if (!sumsSource.endsWith("\n")) return false;
	const actualChecksums = new Map<string, string>();
	for (const line of sumsSource.slice(0, -1).split("\n")) {
		const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
		if (!match) return false;
		const digest = match[1];
		const name = match[2];
		if (!digest || !name) return false;
		assertRepositoryPath(name, "materialized package checksum path");
		if (actualChecksums.has(name)) return false;
		actualChecksums.set(name, digest);
	}
	const actualChecksumNames = [...actualChecksums.keys()];
	if (
		actualChecksumNames.some(
			(name, index) => index > 0 && compareUnicodeCodePoints(actualChecksumNames[index - 1]!, name) >= 0,
		)
	) {
		return false;
	}
	if (
		actualChecksums.size !== expectedChecksums.size ||
		[...expectedChecksums].some(([name, digest]) => actualChecksums.get(name) !== digest)
	) {
		return false;
	}
	const actualFiles = await materializedPackageFiles(root, owner);
	const expectedFiles = [...expectedChecksums.keys(), "SHA256SUMS.txt"].sort(compareUnicodeCodePoints);
	if (
		!actualFiles ||
		actualFiles.length !== expectedFiles.length ||
		actualFiles.some((name, index) => name !== expectedFiles[index])
	) {
		return false;
	}
	return { root, sourceEntries };
}

function snapshotSourceRelativePath(root: string, sourcePath: string): string | undefined {
	const relative = path.relative(root, sourcePath).replaceAll(path.sep, "/");
	return !relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)
		? undefined
		: relative;
}

async function snapshotMatchesMaterializedCandidateSource(
	snapshot: LegacyPiModuleSnapshot,
	materialized: ApprovedMaterializedCandidateSource,
	isSnapshotContained: (snapshot: LegacyPiModuleSnapshot, packageRoot: string) => Promise<boolean>,
): Promise<boolean> {
	if (!(await isSnapshotContained(snapshot, materialized.root))) return false;
	for (const [modulePath, source] of snapshot.sourceModules) {
		const relative = snapshotSourceRelativePath(materialized.root, modulePath);
		const expected = relative ? materialized.sourceEntries.get(relative) : undefined;
		const sourceBytes = UTF8_ENCODER.encode(source);
		if (!expected || sourceBytes.byteLength !== expected.bytes || sha256(sourceBytes) !== expected.sha256)
			return false;
	}
	return true;
}

async function snapshotMatchesCandidateSource(
	snapshot: LegacyPiModuleSnapshot,
	repositoryRoot: string,
	sourceRoot: string,
	candidateCommit: string,
	isSnapshotContained: (snapshot: LegacyPiModuleSnapshot, packageRoot: string) => Promise<boolean>,
): Promise<boolean> {
	if (!(await isSnapshotContained(snapshot, sourceRoot))) return false;
	for (const [modulePath, source] of snapshot.sourceModules) {
		const relative = snapshotSourceRelativePath(repositoryRoot, modulePath);
		if (!relative) return false;
		const approvedSource = await show(repositoryRoot, `${candidateCommit}:${relative}`);
		if (approvedSource !== source) return false;
	}
	return true;
}

/** Capture and attest an external runtime source graph before it can be evaluated. */
export async function approvedCandidateSourceModule(
	filePath: string,
	release: ContextReleaseManifest,
): Promise<ApprovedLegacyPiModule | undefined> {
	try {
		const absolute = path.resolve(filePath);
		const resolved = await fs.realpath(absolute);
		// Keep runtime plugin graph loading outside native-free offline context commands.
		const legacyPi = await import("../extensibility/plugins/legacy-pi-compat");
		const snapshot = await legacyPi.captureLegacyPiModuleSnapshot(resolved);
		if (!snapshot) return undefined;
		const materialized = await isApprovedMaterializedCandidateSource(absolute, resolved, release);
		if (
			materialized &&
			(await snapshotMatchesMaterializedCandidateSource(
				snapshot,
				materialized,
				legacyPi.isLegacyPiModuleSnapshotContained,
			))
		) {
			return legacyPi.createApprovedLegacyPiModule(snapshot);
		}
		const repositoryRoot = await repo.root(path.dirname(resolved));
		if (!repositoryRoot) return undefined;
		const relative = snapshotSourceRelativePath(repositoryRoot, resolved);
		if (!relative) return undefined;
		const remoteNames = await remote.list(repositoryRoot);
		let repository: string | undefined;
		for (const name of ["origin", ...remoteNames.filter(name => name !== "origin")]) {
			repository = canonicalGithubRepository(await remote.url(repositoryRoot, name));
			if (repository) break;
		}
		const candidate = release.candidates.find(item => item.repository === repository);
		if (!candidate) return undefined;
		const approvedIdentity = await ref.commitIdentity(repositoryRoot, candidate.commit);
		const sourceRoot = await approvedCandidateSourceRoot(repositoryRoot, resolved, candidate.commit);
		if (!sourceRoot) return undefined;
		const relativeSourceRoot = path.relative(repositoryRoot, sourceRoot).replaceAll(path.sep, "/");
		const packagePathspec = `:(literal)${relativeSourceRoot || "."}`;
		const [approvedPackageTree, headPackageTree, workingSourceStatus, workingPackageTree, snapshotMatches] =
			await Promise.all([
				ref.resolve(repositoryRoot, `${candidate.commit}:${relativeSourceRoot}`),
				ref.resolve(repositoryRoot, `HEAD:${relativeSourceRoot}`),
				status(repositoryRoot, {
					porcelainV1: true,
					untrackedFiles: "all",
					includeIgnored: true,
					z: true,
					pathspecs: [packagePathspec],
				}),
				workingPackageTreeObjectId(repositoryRoot, relativeSourceRoot, candidate.tree.length),
				snapshotMatchesCandidateSource(
					snapshot,
					repositoryRoot,
					sourceRoot,
					candidate.commit,
					legacyPi.isLegacyPiModuleSnapshotContained,
				),
			]);
		if (!headPackageTree || workingPackageTree !== headPackageTree || !snapshotMatches) return undefined;
		return approvedCandidateSourceMatches(
			repository,
			approvedIdentity ?? undefined,
			approvedPackageTree ?? undefined,
			headPackageTree ?? undefined,
			workingSourceStatus,
			release,
		)
			? legacyPi.createApprovedLegacyPiModule(snapshot)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Resolve an external runtime source to its approved snapshot entry path. */
export async function approvedCandidateSourcePath(
	filePath: string,
	release: ContextReleaseManifest,
): Promise<string | undefined> {
	return (await approvedCandidateSourceModule(filePath, release))?.entryPath;
}

/** Bind an external runtime source to an unchanged, clean package in one approved candidate. */
export async function isApprovedCandidateSource(filePath: string, release: ContextReleaseManifest): Promise<boolean> {
	return (await approvedCandidateSourceModule(filePath, release)) !== undefined;
}

export async function buildContextReleaseManifest(
	_projectCwd: string = process.cwd(),
	candidateOverride?: readonly CandidateIdentity[],
	options?: { requireCleanCanonicalCheckout?: boolean; scopeCoverage?: unknown; stackPackageContentSha256?: string },
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
	const activation = candidateOverride ? undefined : await loadActivationState();
	const candidateInput = candidateOverride ?? activation?.candidates;
	const suppliedOmp = candidateInput?.find(candidate => candidate.repository === OMP_REPOSITORY);
	const stackPackageContentSha256 = options?.stackPackageContentSha256 ?? activation?.stackPackageContentSha256;
	if (!stackPackageContentSha256) {
		throw new Error("PROMPT_POLICY_REVIEW_REQUIRED: missing approved Stack package content hash");
	}
	assertSha256(stackPackageContentSha256, "approved Stack package content hash");
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
		stackPackageContentSha256,
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
