import * as os from "node:os";
import * as path from "node:path";
import type { JsonValue } from "./canonical";
import { canonicalJson, sha256 } from "./canonical";
import {
	activationStatePath,
	buildContextReleaseManifest,
	type CandidateIdentity,
	type ContextReleaseManifest,
	parseContextReleaseManifest,
} from "./manifest";

export const APPROVED_POLICY_SCHEMA = "smarty.approved_policy.v1" as const;

export interface ApprovedPolicy {
	schema: typeof APPROVED_POLICY_SCHEMA;
	approval: {
		reference: string;
		approvedBy: "paulbettner";
		approvedAt: string;
	};
	candidates: CandidateIdentity[];
	contentManifestRootSha256: string;
	behaviorSha256: string;
	globalAgentsSha256: string;
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
		throw new Error(`approved policy ${label} has unknown or missing fields`);
	}
}

function policyPayload(policy: ApprovedPolicy): Omit<ApprovedPolicy, "rootSha256"> {
	const { rootSha256: _rootSha256, ...payload } = policy;
	return payload;
}

function sortedCandidates(candidates: readonly CandidateIdentity[]): CandidateIdentity[] {
	return [...candidates].sort(
		(left, right) =>
			left.repository.localeCompare(right.repository) ||
			left.commit.localeCompare(right.commit) ||
			left.tree.localeCompare(right.tree),
	);
}

function assertSha256(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new Error(`approved policy ${field} must be a lowercase SHA-256`);
	}
}

function assertGitObject(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
		throw new Error(`approved policy ${field} must be a Git SHA-1 object id`);
	}
}

export function parseApprovedPolicy(source: string): ApprovedPolicy {
	const value: unknown = JSON.parse(source);
	if (!isRecord(value) || value.schema !== APPROVED_POLICY_SCHEMA) {
		throw new Error(`approved policy schema must be ${APPROVED_POLICY_SCHEMA}`);
	}
	assertExactKeys(
		value,
		[
			"schema",
			"approval",
			"candidates",
			"contentManifestRootSha256",
			"behaviorSha256",
			"globalAgentsSha256",
			"configurationSemanticSha256",
			"combinedPromptBehaviorSha256",
			"rootSha256",
		],
		"record",
	);
	const policy = value as unknown as ApprovedPolicy;
	if (
		!isRecord(policy.approval) ||
		policy.approval.approvedBy !== "paulbettner" ||
		typeof policy.approval.reference !== "string" ||
		policy.approval.reference.trim().length === 0 ||
		typeof policy.approval.approvedAt !== "string" ||
		!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(
			policy.approval.approvedAt,
		) ||
		Number.isNaN(Date.parse(policy.approval.approvedAt)) ||
		!Array.isArray(policy.candidates) ||
		policy.candidates.length === 0
	) {
		throw new Error("approved policy has invalid approval or candidates");
	}
	assertExactKeys(policy.approval, ["reference", "approvedBy", "approvedAt"], "approval");
	const repositories = new Set<string>();
	for (const [index, candidate] of policy.candidates.entries()) {
		if (
			!isRecord(candidate) ||
			typeof candidate.repository !== "string" ||
			!/^[^/\s]+\/[^/\s]+$/.test(candidate.repository) ||
			repositories.has(candidate.repository)
		) {
			throw new Error(`approved policy candidate ${index} is invalid or duplicated`);
		}
		assertExactKeys(candidate, ["repository", "commit", "tree"], `candidate ${index}`);
		assertGitObject(candidate.commit, `candidates[${index}].commit`);
		assertGitObject(candidate.tree, `candidates[${index}].tree`);
		repositories.add(candidate.repository);
	}
	assertSha256(policy.contentManifestRootSha256, "contentManifestRootSha256");
	assertSha256(policy.behaviorSha256, "behaviorSha256");
	assertSha256(policy.globalAgentsSha256, "globalAgentsSha256");
	assertSha256(policy.configurationSemanticSha256, "configurationSemanticSha256");
	assertSha256(policy.combinedPromptBehaviorSha256, "combinedPromptBehaviorSha256");
	assertSha256(policy.rootSha256, "rootSha256");
	const canonicalCandidates = sortedCandidates(policy.candidates);
	if (
		canonicalJson(policy.candidates as unknown as JsonValue) !==
		canonicalJson(canonicalCandidates as unknown as JsonValue)
	) {
		throw new Error("approved policy candidates must be sorted by repository, commit, and tree");
	}
	const expectedRoot = sha256(canonicalJson(policyPayload(policy) as unknown as JsonValue));
	if (policy.rootSha256 !== expectedRoot) throw new Error("approved policy rootSha256 does not match its payload");
	return policy;
}

export function approvedPolicyPath(explicitPath?: string): string {
	return explicitPath ?? path.join(os.homedir(), ".smarty-stack/policy/approved-policy.json");
}

export async function loadApprovedPolicy(explicitPath?: string): Promise<ApprovedPolicy | undefined> {
	const file = Bun.file(approvedPolicyPath(explicitPath));
	return (await file.exists()) ? parseApprovedPolicy(await file.text()) : undefined;
}

function policyMismatches(policy: ApprovedPolicy, release: ContextReleaseManifest): string[] {
	const mismatches: string[] = [];
	const compare = (field: string, expected: string, actual: string): void => {
		if (expected !== actual) mismatches.push(`${field}: approved=${expected} current=${actual}`);
	};
	compare("contentManifestRootSha256", policy.contentManifestRootSha256, release.contentManifestRootSha256);
	compare("behaviorSha256", policy.behaviorSha256, release.behaviorSha256);
	compare("globalAgentsSha256", policy.globalAgentsSha256, release.globalAgentsSourceSha256);
	compare("configurationSemanticSha256", policy.configurationSemanticSha256, release.configurationSemanticSha256);
	compare("combinedPromptBehaviorSha256", policy.combinedPromptBehaviorSha256, release.combinedPromptBehaviorSha256);
	if (
		canonicalJson(policy.candidates as unknown as JsonValue) !==
		canonicalJson(release.candidates as unknown as JsonValue)
	) {
		mismatches.push("candidates: approved candidate set differs from current activation set");
	}
	return mismatches;
}

export function releaseProjectionMismatches(
	activated: ContextReleaseManifest,
	current: ContextReleaseManifest,
): string[] {
	const mismatches: string[] = [];
	const compare = (field: string, expected: string, actual: string): void => {
		if (expected !== actual) mismatches.push(`${field}: activated=${expected} current=${actual}`);
	};
	compare("repository", activated.repository, current.repository);
	compare("commit", activated.commit, current.commit);
	compare("tree", activated.tree, current.tree);
	compare("contentManifestRootSha256", activated.contentManifestRootSha256, current.contentManifestRootSha256);
	compare("behaviorSha256", activated.behaviorSha256, current.behaviorSha256);
	compare("globalAgentsSha256", activated.globalAgentsSha256, current.globalAgentsSha256);
	compare("configurationSemanticSha256", activated.configurationSemanticSha256, current.configurationSemanticSha256);
	compare(
		"combinedPromptBehaviorSha256",
		activated.combinedPromptBehaviorSha256,
		current.combinedPromptBehaviorSha256,
	);
	if (
		canonicalJson(activated.candidates as unknown as JsonValue) !==
		canonicalJson(current.candidates as unknown as JsonValue)
	) {
		mismatches.push("candidates: activated candidate set differs from current release");
	}
	return mismatches;
}

export async function approvalStatus(
	release: ContextReleaseManifest,
	explicitPolicyPath?: string,
): Promise<{ status: "approved" | "unapproved" | "mismatch"; reference?: string; reasons: string[] }> {
	const policy = await loadApprovedPolicy(explicitPolicyPath);
	if (!policy) return { status: "unapproved", reasons: [`missing ${approvedPolicyPath(explicitPolicyPath)}`] };
	const reasons = policyMismatches(policy, release);
	return reasons.length === 0
		? { status: "approved", reference: policy.approval.reference, reasons: [] }
		: { status: "mismatch", reference: policy.approval.reference, reasons };
}

export async function assertApprovedStartup(cwd: string = process.cwd()): Promise<ContextReleaseManifest> {
	const statePath = activationStatePath();
	if (!(await Bun.file(statePath).exists())) {
		throw new Error(`PROMPT_POLICY_REVIEW_REQUIRED: missing ${statePath}`);
	}
	const activated = parseContextReleaseManifest(await Bun.file(statePath).text());
	const release = await buildContextReleaseManifest(cwd, undefined, { requireCleanCanonicalCheckout: true });
	const activationMismatches = releaseProjectionMismatches(activated, release);
	if (activationMismatches.length > 0) {
		throw new Error(`PROMPT_POLICY_REVIEW_REQUIRED: ${activationMismatches.join("; ")}`);
	}
	const status = await approvalStatus(release);
	if (status.status !== "approved") {
		throw new Error(`PROMPT_POLICY_REVIEW_REQUIRED: ${status.reasons.join("; ")}`);
	}
	return release;
}

/** Fresh runtime gate for every new session. Offline context commands deliberately do not call it. */
export function ensureApprovedStartup(): Promise<ContextReleaseManifest> {
	return assertApprovedStartup();
}
