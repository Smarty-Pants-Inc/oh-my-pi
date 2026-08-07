import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
	ConfidentialTransientTaskCaptureRefCompareAndSwapRequestV1,
	ConfidentialTransientTaskCaptureRepositoryHandleV1,
	ConfidentialTransientTaskIsolationCleanupComponentRequestV1,
	TransientTaskIsolationCleanupHandleV1,
} from "../../../src/session/workspace-runtime-contracts";
import {
	encodeTransientTaskOutcomeDocumentV1,
	preflightTransientTaskResultlessRepresentabilityV1,
} from "../../../src/task/executor";
import {
	createTransientTaskCaptureRefCompareAndSwapInvocationV1,
	createTransientTaskCaptureRefDeleteInvocationV1,
	deriveTransientTaskIsolationPhysicalIdentityV1,
} from "../../../src/task/worktree";

const captureRepository = Object.freeze({}) as ConfidentialTransientTaskCaptureRepositoryHandleV1;
const cleanupRepository = Object.freeze({}) as TransientTaskIsolationCleanupHandleV1;
const sha1Absent = "0".repeat(40);
const sha1Tip = "1".repeat(40);

describe("adaptive transient TaskAdapter contract", () => {
	test("derives the full physical namespace only from task/run/create identity", async () => {
		const identity = await deriveTransientTaskIsolationPhysicalIdentityV1({
			taskId: "task-1",
			runId: "run-1",
			createId: "create-1",
		});
		expect(identity.namespaceSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(identity.directorySegment).toBe(`t1-${identity.namespaceSha256}`);
		expect(identity.captureBranchRef).toBe(`refs/heads/omp/task/v1/${identity.namespaceSha256}`);
		expect(identity.ownershipClaimPath).toBe(`${identity.baseDir}.owner-v1`);
	});

	test("preserves the frozen canonical baseline vector and representability boundary", () => {
		const document = {
			schemaVersion: 1 as const,
			documentKind: "single_result" as const,
			singleResult: {
				index: 0,
				id: "r1",
				agent: "agent",
				agentSource: "bundled" as const,
				task: "task",
				exitCode: 0,
				output: "",
				stderr: "",
				truncated: false,
				durationMs: 0,
				tokens: 0,
				requests: 0,
				aborted: false,
			},
			mergeSummary: "",
			changesApplied: null,
		};
		const bytes = encodeTransientTaskOutcomeDocumentV1(document);
		expect(new TextDecoder().decode(bytes)).toBe(
			'{"schemaVersion":1,"documentKind":"single_result","singleResult":{"index":0,"id":"r1","agent":"agent","agentSource":"bundled","task":"task","exitCode":0,"output":"","stderr":"","truncated":false,"durationMs":0,"tokens":0,"requests":0,"aborted":false},"mergeSummary":"","changesApplied":null}',
		);
		expect(bytes.byteLength).toBe(291);
		expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(
			"sha256:6fb9db9f2b0ef9360f8217a0c3e4f775ca3feb105f2f1aca50932b83788d7749",
		);
		expect(preflightTransientTaskResultlessRepresentabilityV1(0, "x", "x", 253)).toMatchObject({
			status: "rejected",
			code: "resultless_fallback_exceeds_maximum",
		});
		expect(preflightTransientTaskResultlessRepresentabilityV1(0, "x", "x", 254)).toMatchObject({
			status: "accepted",
		});
	});

	test("uses absence states for canonical ref create and cleanup delete", () => {
		const captureRequest = {
			objectFormat: "sha1",
			command: ["git", "update-ref", "refs/heads/omp/task/v1/test", sha1Tip, sha1Absent],
			captureBranchRef: "refs/heads/omp/task/v1/test",
			expectedOldCaptureRefSha: sha1Absent,
			expectedNewCaptureRefSha: sha1Tip,
		} as unknown as ConfidentialTransientTaskCaptureRefCompareAndSwapRequestV1;
		const cleanupRequest = {
			component: "capture_ref_cas_delete",
			captureBranchRef: "refs/heads/omp/task/v1/test",
			expectedOldCaptureRefSha: sha1Tip,
		} as unknown as Extract<
			ConfidentialTransientTaskIsolationCleanupComponentRequestV1,
			{ component: "capture_ref_cas_delete" }
		>;

		const captureInvocation = createTransientTaskCaptureRefCompareAndSwapInvocationV1(
			captureRepository,
			captureRequest,
		);
		const cleanupInvocation = createTransientTaskCaptureRefDeleteInvocationV1(
			cleanupRepository,
			"sha1",
			cleanupRequest,
		);
		expect(captureInvocation.expected.expectedOld).toEqual({ state: "absent" });
		expect(cleanupInvocation.expected.expectedNew).toEqual({ state: "absent" });
		expect(captureInvocation).not.toHaveProperty("reason", "invalid_object_id");
		expect(cleanupInvocation).not.toHaveProperty("reason", "invalid_object_id");
	});
});
