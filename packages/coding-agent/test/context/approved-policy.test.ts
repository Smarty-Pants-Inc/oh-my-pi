import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	approvedPolicyPath,
	parseApprovedPolicy,
	promptPolicyReviewWarning,
	releaseProjectionMismatches,
} from "../../src/context/approved-policy";
import { canonicalJson, type JsonValue, sha256 } from "../../src/context/canonical";
import type { CandidateIdentity, ContextReleaseManifest } from "../../src/context/manifest";

function candidateIdentity(): CandidateIdentity {
	return {
		repository: "Smarty-Pants-Inc/oh-my-pi",
		baseCommit: "9".repeat(40),
		baseTree: "8".repeat(40),
		commit: "a".repeat(40),
		tree: "b".repeat(40),
		scopeCoverage: [{ path: "packages/coding-agent/src/context/manifest.ts", requirement: "§8.6" }],
	};
}

function validPolicy(): Record<string, unknown> {
	const payload = {
		schema: "smarty.approved_policy.v1",
		approval: { reference: "owner-review-1", approvedBy: "paulbettner", approvedAt: "2026-08-15T12:00:00Z" },
		candidates: [candidateIdentity()],
		contentManifestRootSha256: "c".repeat(64),
		behaviorSha256: "d".repeat(64),
		globalAgentsSha256: "e".repeat(64),
		configurationSemanticSha256: "f".repeat(64),
		combinedPromptBehaviorSha256: "1".repeat(64),
	};
	return { ...payload, rootSha256: sha256(canonicalJson(payload as unknown as JsonValue)) };
}

describe("approved policy", () => {
	it("classifies only prompt-policy startup failures as nonfatal warnings", () => {
		expect(promptPolicyReviewWarning(new Error("PROMPT_POLICY_REVIEW_REQUIRED: drift"))).toBe(
			"PROMPT_POLICY_REVIEW_REQUIRED: drift",
		);
		expect(promptPolicyReviewWarning(new Error("unrelated startup failure"))).toBeUndefined();
		expect(promptPolicyReviewWarning("PROMPT_POLICY_REVIEW_REQUIRED: not an Error")).toBeUndefined();
	});

	it("uses the shared Smarty Stack policy path by default", () => {
		expect(approvedPolicyPath()).toEndWith(path.join(".smarty-stack", "policy", "approved-policy.json"));
		expect(approvedPolicyPath("/tmp/diagnostic-policy.json")).toBe("/tmp/diagnostic-policy.json");
		Bun.env.SMARTY_APPROVED_POLICY_PATH = "/tmp/decoy-policy.json";
		try {
			expect(approvedPolicyPath()).not.toBe(Bun.env.SMARTY_APPROVED_POLICY_PATH);
		} finally {
			delete Bun.env.SMARTY_APPROVED_POLICY_PATH;
		}
	});

	it("accepts only exact self-bound approval data", () => {
		const policy = validPolicy();
		const parsed = parseApprovedPolicy(JSON.stringify(policy));
		expect(parsed.rootSha256).toBe(String(policy.rootSha256));
		expect(parsed.candidates).toEqual(policy.candidates as CandidateIdentity[]);
		const offsetPolicy: Record<string, unknown> = {
			...policy,
			approval: { ...(policy.approval as Record<string, unknown>), approvedAt: "2026-08-15T08:00:00-04:00" },
		};
		offsetPolicy.rootSha256 = sha256(
			canonicalJson(
				Object.fromEntries(Object.entries(offsetPolicy).filter(([key]) => key !== "rootSha256")) as JsonValue,
			),
		);
		expect(parseApprovedPolicy(JSON.stringify(offsetPolicy)).approval.approvedAt).toEndWith("-04:00");
		expect(() => parseApprovedPolicy(JSON.stringify({ ...policy, behaviorSha256: "0".repeat(64) }))).toThrow(
			"rootSha256",
		);
		expect(() => parseApprovedPolicy(JSON.stringify({ ...policy, unknownProtectedField: true }))).toThrow(
			"unknown or missing fields",
		);
		expect(() => parseApprovedPolicy(JSON.stringify({ ...policy, approval: { approvedBy: "paulbettner" } }))).toThrow(
			"invalid approval",
		);
	});

	it("compares the protected activation projection but ignores diagnostic config bytes", () => {
		const current = {
			repository: "Smarty-Pants-Inc/oh-my-pi",
			commit: "a".repeat(40),
			tree: "b".repeat(40),
			candidates: [candidateIdentity()],
			contentManifestRootSha256: "c".repeat(64),
			behaviorSha256: "d".repeat(64),
			globalAgentsSha256: "e".repeat(64),
			configurationSemanticSha256: "f".repeat(64),
			combinedPromptBehaviorSha256: "1".repeat(64),
			configurationSourceSha256: "2".repeat(64),
		} as ContextReleaseManifest;
		expect(releaseProjectionMismatches({ ...current, configurationSourceSha256: "3".repeat(64) }, current)).toEqual(
			[],
		);
		expect(releaseProjectionMismatches({ ...current, behaviorSha256: "4".repeat(64) }, current)).toEqual([
			`behaviorSha256: activated=${"4".repeat(64)} current=${"d".repeat(64)}`,
		]);
		const changedCoverage = {
			...current,
			candidates: [
				{
					...current.candidates[0]!,
					scopeCoverage: [{ path: "packages/coding-agent/src/context/approved-policy.ts", requirement: "§17.1" }],
				},
			],
		};
		expect(releaseProjectionMismatches(changedCoverage, current)).toEqual([
			"candidates: activated candidate set differs from current release",
		]);
	});
});
