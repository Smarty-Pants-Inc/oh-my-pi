import * as os from "node:os";
import * as path from "node:path";
import type { JsonValue } from "./canonical";
import { canonicalJson, sha256 } from "./canonical";
import {
	activationStatePath,
	buildContextReleaseManifest,
	type CandidateIdentity,
	type ContextReleaseManifest,
	parseCandidateIdentities,
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
	stackPackageContentSha256: string;
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

function assertSha256(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new Error(`approved policy ${field} must be a lowercase SHA-256`);
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
			"stackPackageContentSha256",
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
	policy.candidates = parseCandidateIdentities(policy.candidates, "approved policy candidates");
	assertSha256(policy.contentManifestRootSha256, "contentManifestRootSha256");
	assertSha256(policy.behaviorSha256, "behaviorSha256");
	assertSha256(policy.globalAgentsSha256, "globalAgentsSha256");
	assertSha256(policy.configurationSemanticSha256, "configurationSemanticSha256");
	assertSha256(policy.combinedPromptBehaviorSha256, "combinedPromptBehaviorSha256");
	assertSha256(policy.stackPackageContentSha256, "stackPackageContentSha256");
	assertSha256(policy.rootSha256, "rootSha256");
	const expectedRoot = sha256(canonicalJson(policyPayload(policy) as unknown as JsonValue));
	if (policy.rootSha256 !== expectedRoot) throw new Error("approved policy rootSha256 does not match its payload");
	return policy;
}

export function approvedPolicyPath(explicitPath?: string): string {
	return explicitPath ?? path.join(os.homedir(), ".smarty/stack/policy/approved-policy.json");
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
	compare("stackPackageContentSha256", policy.stackPackageContentSha256, release.stackPackageContentSha256);
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
	compare("stackPackageContentSha256", activated.stackPackageContentSha256, current.stackPackageContentSha256);
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
	const activatedSource = await Bun.file(statePath).text();
	let activated: ContextReleaseManifest;
	try {
		activated = parseContextReleaseManifest(activatedSource);
	} catch (error) {
		throw new Error(`PROMPT_POLICY_REVIEW_REQUIRED: invalid ${statePath}`, { cause: error });
	}
	const policyPath = approvedPolicyPath();
	const policyFile = Bun.file(policyPath);
	if (!(await policyFile.exists())) throw new Error(`PROMPT_POLICY_REVIEW_REQUIRED: missing ${policyPath}`);
	const policySource = await policyFile.text();
	let policy: ApprovedPolicy;
	try {
		policy = parseApprovedPolicy(policySource);
	} catch (error) {
		throw new Error(`PROMPT_POLICY_REVIEW_REQUIRED: invalid ${policyPath}`, { cause: error });
	}
	const release = await buildContextReleaseManifest(cwd, policy.candidates, {
		requireCleanCanonicalCheckout: true,
		stackPackageContentSha256: policy.stackPackageContentSha256,
	});
	const activationMismatches = releaseProjectionMismatches(activated, release);
	if (activationMismatches.length > 0) {
		throw new Error(`PROMPT_POLICY_REVIEW_REQUIRED: ${activationMismatches.join("; ")}`);
	}
	const approvalMismatches = policyMismatches(policy, release);
	if (approvalMismatches.length > 0) {
		throw new Error(`PROMPT_POLICY_REVIEW_REQUIRED: ${approvalMismatches.join("; ")}`);
	}
	return release;
}

export function promptPolicyReviewWarning(error: unknown): string | undefined {
	if (!(error instanceof Error) || !error.message.startsWith("PROMPT_POLICY_REVIEW_REQUIRED:")) return undefined;
	return error.message;
}

export async function verifyApprovedStartup(
	isInteractive: boolean,
	verify: () => Promise<unknown> = assertApprovedStartup,
): Promise<string | undefined> {
	try {
		await verify();
		return undefined;
	} catch (error) {
		const warning = isInteractive ? promptPolicyReviewWarning(error) : undefined;
		if (!warning) throw error;
		return warning;
	}
}
/** Startup policy drift is advisory; unrelated verification failures remain strict. */
export async function ensureApprovedStartup(
	verify: () => Promise<ContextReleaseManifest> = assertApprovedStartup,
): Promise<ContextReleaseManifest | undefined> {
	try {
		return await verify();
	} catch (error) {
		if (promptPolicyReviewWarning(error)) return undefined;
		throw error;
	}
}
