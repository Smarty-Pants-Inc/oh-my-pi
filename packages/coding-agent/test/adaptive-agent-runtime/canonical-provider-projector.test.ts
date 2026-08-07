import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	type CanonicalRuntimeValue,
	canonicalRuntimeProviderInspectionSha256V1,
	encodeCanonicalRuntimeTupleV1,
	projectRuntimeCanonicalProviderInspectionTupleV1,
	type RuntimeCanonicalProviderInspectionV1,
	type RuntimeCanonicalProviderOperationV1,
	type RuntimeProviderCanonicalGoldenVectorV1,
} from "../../src/session/workspace-runtime-contracts.js";

const digest = (character: string): string => character.repeat(64);
const checkpoint = {
	workspaceId: "workspace-1",
	generation: 7,
	rootSha256: digest("a"),
	fileCount: 3,
	byteCount: 42,
	committedAt: "2030-02-01T00:00:00.000Z",
} as const;
const replica = {
	providerId: "provider-1",
	profileId: "profile-1",
	replicaId: "replica-1",
	workspaceId: checkpoint.workspaceId,
} as const;
const lease = {
	leaseId: "lease-1",
	replica,
	fenceId: "fence-1",
	baseGeneration: checkpoint.generation,
	renewalSequence: 0,
	acquiredAt: "2030-02-01T00:01:00.000Z",
	renewBy: "2030-02-01T00:06:00.000Z",
	expiresAt: "2030-02-01T00:11:00.000Z",
} as const;
const candidate = {
	providerId: replica.providerId,
	profileId: replica.profileId,
	location: "cloud",
	capabilities: ["workspace.read", "workspace.write"],
	workspaceFormats: ["omp-text-v1"],
	os: "linux",
	arch: "x64",
	cpu: 2,
	memoryMiB: 4096,
	network: "none",
	available: true,
	estimatedIncrementalCostMicrosPerHour: 100,
	estimatedReadyLatencyMs: 1_000,
} as const;
const plan = {
	replica,
	leaseId: lease.leaseId,
	fenceId: lease.fenceId,
	initialRenewalSequence: 0,
	baseCheckpoint: checkpoint,
	deletionAuthorityDomain: "persistent",
	leaseTtlMs: 600_000,
} as const;
const reference = {
	providerId: replica.providerId,
	profileId: replica.profileId,
	workspaceId: replica.workspaceId,
	replicaId: replica.replicaId,
	leaseId: lease.leaseId,
	checkpointId: "checkpoint-1",
	rootSha256: checkpoint.rootSha256,
	fileCount: checkpoint.fileCount,
	byteCount: checkpoint.byteCount,
	format: "omp-text-v1",
	baseGeneration: checkpoint.generation,
	frozenAt: "2030-02-01T00:12:00.000Z",
} as const;
const committedCheckpoint = {
	...checkpoint,
	generation: checkpoint.generation + 1,
	committedAt: "2030-02-01T00:13:00.000Z",
} as const;
const canonicalCommit = {
	workspaceId: replica.workspaceId,
	commitId: "commit-1",
	expectedGeneration: committedCheckpoint.generation,
	checkpoint: committedCheckpoint,
	durableAt: "2030-02-01T00:13:01.000Z",
} as const;

function goldenVector(
	operation: RuntimeCanonicalProviderOperationV1,
	request: Record<string, unknown>,
	tuple: readonly CanonicalRuntimeValue[],
): RuntimeProviderCanonicalGoldenVectorV1 {
	const canonicalTupleUtf8 = JSON.stringify(tuple);
	const expectedRequestSha256 = createHash("sha256").update(canonicalTupleUtf8, "utf8").digest("hex");
	return {
		schemaVersion: 1,
		input: {
			operation,
			request: { ...request, requestSha256: expectedRequestSha256 },
		} as unknown as RuntimeCanonicalProviderInspectionV1,
		canonicalTupleUtf8,
		expectedRequestSha256,
	};
}

const vectors = [
	goldenVector("acquire", { requestId: "request-acquire", transitionId: "transition-acquire", candidate, plan }, [
		"omp-runtime-provider-v1",
		"acquire",
		"transition-acquire",
		replica.providerId,
		replica.profileId,
		replica.workspaceId,
		replica.replicaId,
		lease.leaseId,
		lease.fenceId,
		checkpoint.generation,
		checkpoint.rootSha256,
		checkpoint.fileCount,
		checkpoint.byteCount,
		"persistent",
		600_000,
		0,
	]),
	goldenVector(
		"push",
		{
			requestId: "request-push",
			transitionId: "transition-acquire",
			lease,
			snapshot: {
				rootSha256: checkpoint.rootSha256,
				fileCount: checkpoint.fileCount,
				byteCount: checkpoint.byteCount,
			},
		},
		[
			"omp-runtime-provider-v1",
			"push",
			"transition-acquire",
			replica.providerId,
			replica.profileId,
			replica.workspaceId,
			replica.replicaId,
			lease.leaseId,
			lease.fenceId,
			lease.baseGeneration,
			checkpoint.rootSha256,
			checkpoint.fileCount,
			checkpoint.byteCount,
		],
	),
	goldenVector("quiesce", { requestId: "request-quiesce", transitionId: "transition-drain", lease }, [
		"omp-runtime-provider-v1",
		"quiesce",
		"transition-drain",
		replica.providerId,
		replica.profileId,
		replica.workspaceId,
		replica.replicaId,
		lease.leaseId,
		lease.fenceId,
		lease.baseGeneration,
	]),
	goldenVector(
		"checkpoint",
		{
			requestId: "request-checkpoint",
			transitionId: "transition-drain",
			checkpointId: reference.checkpointId,
			lease,
		},
		[
			"omp-runtime-provider-v1",
			"checkpoint",
			"transition-drain",
			replica.providerId,
			replica.profileId,
			replica.workspaceId,
			replica.replicaId,
			lease.leaseId,
			lease.fenceId,
			reference.checkpointId,
			lease.baseGeneration,
		],
	),
	goldenVector(
		"revoke",
		{
			requestId: "request-revoke",
			transitionId: "transition-drain",
			replica,
			leaseId: lease.leaseId,
			fenceId: lease.fenceId,
			reasonCode: "runtime_revoked",
		},
		[
			"omp-runtime-provider-v1",
			"revoke",
			"transition-drain",
			replica.providerId,
			replica.profileId,
			replica.workspaceId,
			replica.replicaId,
			lease.leaseId,
			lease.fenceId,
			"runtime_revoked",
		],
	),
	goldenVector(
		"checkpoint_acknowledgement",
		{
			requestId: "request-acknowledgement",
			parentOperationId: "transition-drain",
			reference,
			canonicalCommit,
		},
		[
			"omp-runtime-provider-v1",
			"checkpoint_ack",
			"transition-drain",
			replica.providerId,
			replica.profileId,
			replica.workspaceId,
			replica.replicaId,
			lease.leaseId,
			reference.checkpointId,
			reference.baseGeneration,
			canonicalCommit.commitId,
			committedCheckpoint.generation,
			committedCheckpoint.rootSha256,
			committedCheckpoint.fileCount,
			committedCheckpoint.byteCount,
		],
	),
	goldenVector(
		"release",
		{ requestId: "request-release", parentOperationId: "transition-drain", replica, leaseId: lease.leaseId },
		[
			"omp-runtime-provider-v1",
			"release",
			"transition-drain",
			replica.providerId,
			replica.profileId,
			replica.workspaceId,
			replica.replicaId,
			lease.leaseId,
		],
	),
] as const satisfies readonly RuntimeProviderCanonicalGoldenVectorV1[];

describe("canonical provider inspection projector", () => {
	it("projects and hashes the exact closed seven-operation fixture set", async () => {
		expect(vectors.map(vector => vector.input.operation)).toEqual([
			"acquire",
			"push",
			"quiesce",
			"checkpoint",
			"revoke",
			"checkpoint_acknowledgement",
			"release",
		]);
		for (const vector of vectors) {
			const tuple = projectRuntimeCanonicalProviderInspectionTupleV1(vector.input);
			expect(new TextDecoder().decode(encodeCanonicalRuntimeTupleV1(tuple))).toBe(vector.canonicalTupleUtf8);
			expect(await canonicalRuntimeProviderInspectionSha256V1(vector.input)).toBe(vector.expectedRequestSha256);
			expect(vector.input.request.requestSha256).toBe(vector.expectedRequestSha256);
		}
	});
});
