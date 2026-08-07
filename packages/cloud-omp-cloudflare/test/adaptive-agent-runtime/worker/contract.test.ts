import { describe, expect, test } from "bun:test";
import type {
	RuntimeCanonicalProviderInspectionV1,
	RuntimeSearchRequest,
	WorkspaceDeletionPlanCoreV1,
	WorkspaceDeletionPlanV1,
} from "@oh-my-pi/pi-coding-agent";
import {
	CLOUDFLARE_RUNTIME_SEARCH_CURSOR_MAX_CHARS_V1,
	CLOUDFLARE_RUNTIME_SEARCH_RESULT_BYTE_BUDGET_V1,
	type CloudflareDurableDeadlineV1,
	canonicalRuntimeSha256V1,
	cloudflareRuntimeRoutesV1,
	decodeCloudflareReplicaDeleteResultV1,
	decodeCloudflareRuntimeInspectionTransportResultEnvelopeV1,
	deferCloudflareWorkspaceRetentionDeadlineV1,
	deriveCloudflareRuntimeDurableObjectNameV1,
	deriveCloudflareWorkspaceTombstoneV1,
	encodeCloudflareRuntimeSearchCursorV1,
	projectCloudflareDeletionPlanCoreTupleV1,
	projectCloudflareDeletionPlanTupleV1,
	projectCloudflarePersistentReplicaDeleteTupleV1,
	projectCloudflareReplicaCacheEvictionTupleV1,
	projectCloudflareReplicaDeleteReceiptTupleV1,
	projectCloudflareRuntimeInspectionTupleV1,
	rearmCloudflarePhysicalAlarmV1,
	selectDueCloudflareDurableDeadlinesV1,
} from "../../../src/protocol";
import type { WorkerEnv, WorkspaceNamespace, WorkspaceRpc } from "../../../src/worker/router";
import worker from "../../../src/worker/router";
import {
	RequestValidationError,
	validateCloudflareCheckpointFetchRequestV1,
	validateCloudflareDurableDeadlineV1,
	validateCloudflareReplicaCacheEvictionPlanV1,
	validateCloudflareReplicaDeleteRequestV1,
	validateCloudflareRuntimeEffectEnvelopeV1,
	validateCloudflareRuntimeEffectTransportEnvelopeV1,
	validateCloudflareRuntimeInspectionEnvelopeV1,
	validateCloudflareRuntimeInspectionTransportEnvelopeV1,
	validateCloudflareRuntimeStatusRequestV1,
} from "../../../src/worker/validation";

const digest = (character: string): string => character.repeat(64);
const acquiredAt = "2030-01-01T00:00:00.000Z";
const renewBy = "2030-01-01T00:05:00.000Z";
const expiresAt = "2030-01-01T00:10:00.000Z";
const committedAt = "2029-12-31T23:59:00.000Z";

const replica = {
	providerId: "cloudflare",
	profileId: "standard-2",
	replicaId: "replica-1",
	workspaceId: "workspace-1",
} as const;

const checkpoint = {
	workspaceId: replica.workspaceId,
	generation: 3,
	rootSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	fileCount: 0,
	byteCount: 0,
	committedAt,
} as const;

const lease = {
	leaseId: "lease-1",
	replica,
	fenceId: "fence-1",
	baseGeneration: checkpoint.generation,
	renewalSequence: 0,
	acquiredAt,
	renewBy,
	expiresAt,
} as const;

const candidate = {
	providerId: replica.providerId,
	profileId: replica.profileId,
	location: "cloud",
	capabilities: ["workspace.read", "workspace.write", "process.exec"],
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

const leasePlan = {
	replica,
	leaseId: lease.leaseId,
	fenceId: lease.fenceId,
	initialRenewalSequence: 0,
	baseCheckpoint: checkpoint,
	deletionAuthorityDomain: "persistent",
	leaseTtlMs: 600_000,
} as const;

interface FrozenVector {
	readonly operation:
		| "acquire"
		| "push"
		| "quiesce"
		| "checkpoint"
		| "revoke"
		| "checkpoint_acknowledgement"
		| "release";
	readonly inspection: {
		readonly schemaVersion: 1;
		readonly operation: string;
		readonly request: Record<string, unknown>;
	};
	readonly effect: {
		readonly schemaVersion: 1;
		readonly operation: string;
		readonly request: Record<string, unknown>;
	};
	readonly identityKey: "transitionId" | "parentOperationId";
}

async function sealInspection(
	operation: FrozenVector["operation"],
	request: Record<string, unknown>,
): Promise<{ readonly request: Record<string, unknown>; readonly digest: string }> {
	const provisional = {
		operation,
		request: { ...request, requestSha256: digest("0") },
	} as unknown as RuntimeCanonicalProviderInspectionV1;
	const requestSha256 = await canonicalRuntimeSha256V1(projectCloudflareRuntimeInspectionTupleV1(provisional));
	return { request: { ...request, requestSha256 }, digest: requestSha256 };
}

async function frozenVectors(): Promise<readonly FrozenVector[]> {
	const acquire = await sealInspection("acquire", {
		requestId: digest("a"),
		transitionId: "transition-acquire",
		candidate,
		plan: leasePlan,
	});
	const push = await sealInspection("push", {
		requestId: digest("b"),
		transitionId: "transition-acquire",
		lease,
		snapshot: { rootSha256: checkpoint.rootSha256, fileCount: 0, byteCount: 0 },
	});
	const quiesce = await sealInspection("quiesce", {
		requestId: digest("c"),
		transitionId: "transition-drain",
		lease,
	});
	const frozenCheckpoint = await sealInspection("checkpoint", {
		requestId: digest("d"),
		transitionId: "transition-drain",
		checkpointId: "checkpoint-1",
		lease,
	});
	const revoke = await sealInspection("revoke", {
		requestId: digest("e"),
		transitionId: "transition-drain",
		replica,
		leaseId: lease.leaseId,
		fenceId: lease.fenceId,
		reasonCode: "runtime_revoked",
	});
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
		frozenAt: "2030-01-01T00:11:00.000Z",
	} as const;
	const canonicalCommit = {
		workspaceId: replica.workspaceId,
		commitId: "commit-1",
		expectedGeneration: checkpoint.generation,
		checkpoint: { ...checkpoint, generation: checkpoint.generation + 1, committedAt: "2030-01-01T00:12:00.000Z" },
		durableAt: "2030-01-01T00:12:01.000Z",
	} as const;
	const acknowledgement = await sealInspection("checkpoint_acknowledgement", {
		requestId: digest("f"),
		parentOperationId: "transition-drain",
		reference,
		canonicalCommit,
	});
	const release = await sealInspection("release", {
		requestId: digest("7"),
		parentOperationId: "transition-drain",
		replica,
		leaseId: lease.leaseId,
	});
	const fence = { fenceId: lease.fenceId, token: "volatile-fence-token" };
	return [
		{
			operation: "acquire",
			inspection: { schemaVersion: 1, operation: "acquire", request: acquire.request },
			effect: { schemaVersion: 1, operation: "acquire", request: { ...acquire.request, fence } },
			identityKey: "transitionId",
		},
		{
			operation: "push",
			inspection: { schemaVersion: 1, operation: "push", request: push.request },
			effect: {
				schemaVersion: 1,
				operation: "push",
				request: { ...push.request, fence, snapshot: { checkpoint, files: [] } },
			},
			identityKey: "transitionId",
		},
		{
			operation: "quiesce",
			inspection: { schemaVersion: 1, operation: "quiesce", request: quiesce.request },
			effect: { schemaVersion: 1, operation: "quiesce", request: { ...quiesce.request, fence } },
			identityKey: "transitionId",
		},
		{
			operation: "checkpoint",
			inspection: { schemaVersion: 1, operation: "checkpoint", request: frozenCheckpoint.request },
			effect: { schemaVersion: 1, operation: "checkpoint", request: { ...frozenCheckpoint.request, fence } },
			identityKey: "transitionId",
		},
		{
			operation: "revoke",
			inspection: { schemaVersion: 1, operation: "revoke", request: revoke.request },
			effect: { schemaVersion: 1, operation: "revoke", request: revoke.request },
			identityKey: "transitionId",
		},
		{
			operation: "checkpoint_acknowledgement",
			inspection: { schemaVersion: 1, operation: "checkpoint_acknowledgement", request: acknowledgement.request },
			effect: { schemaVersion: 1, operation: "checkpoint_acknowledgement", request: acknowledgement.request },
			identityKey: "parentOperationId",
		},
		{
			operation: "release",
			inspection: { schemaVersion: 1, operation: "release", request: release.request },
			effect: { schemaVersion: 1, operation: "release", request: release.request },
			identityKey: "parentOperationId",
		},
	];
}

function cloneRecord<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

describe("Cloudflare Worker adaptive runtime protocol", () => {
	test("strict-decodes the exact seven effect/inspection pairs and recomputes identical tuples", async () => {
		for (const vector of await frozenVectors()) {
			const inspection = await validateCloudflareRuntimeInspectionEnvelopeV1(vector.inspection);
			const effect = await validateCloudflareRuntimeEffectEnvelopeV1(vector.effect);
			expect(effect.operation).toBe(vector.operation);
			expect(effect.canonicalTupleUtf8).toBe(inspection.canonicalTupleUtf8);
			expect(effect.requestSha256).toBe(inspection.requestSha256);

			const mutated = cloneRecord(vector.inspection);
			mutated.request[vector.identityKey] = "mutated-parent";
			await expect(validateCloudflareRuntimeInspectionEnvelopeV1(mutated)).rejects.toMatchObject({
				code: "request_digest_mismatch",
			});
		}
	});

	test("strict-decodes the exact bridge effect and inspection families", async () => {
		const content = "hello";
		const contentSha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
		const tuple = [
			"omp-runtime-request-v1",
			"write_text",
			"operation-lease-1",
			replica.workspaceId,
			checkpoint.generation,
			replica.replicaId,
			lease.leaseId,
			lease.fenceId,
			"/workspace/blob.txt",
			contentSha256,
			5,
		] as const;
		const effect = {
			schemaVersion: 1,
			family: "bridge",
			operation: "write_text_file",
			replica,
			request: {
				operationLeaseId: "operation-lease-1",
				workspaceId: replica.workspaceId,
				expectedGeneration: checkpoint.generation,
				replicaId: replica.replicaId,
				leaseId: lease.leaseId,
				fence: { fenceId: lease.fenceId, token: "fence-token-1" },
				requestId: digest("b"),
				requestSha256: await canonicalRuntimeSha256V1(tuple),
				path: "/workspace/blob.txt",
				content,
				contentSha256,
			},
		} as const;
		await expect(validateCloudflareRuntimeEffectTransportEnvelopeV1(effect)).resolves.toMatchObject({
			transportFamily: "bridge",
			family: "bridge",
			operation: "write_text_file",
			replica,
			request: effect.request,
		});

		const inspection = {
			schemaVersion: 1,
			family: "bridge",
			operation: "read_binary_file",
			replica,
			request: {
				operationLeaseId: "operation-lease-1",
				workspaceId: replica.workspaceId,
				expectedGeneration: checkpoint.generation,
				replicaId: replica.replicaId,
				leaseId: lease.leaseId,
				fence: { fenceId: lease.fenceId, token: "fence-token-1" },
				path: "/workspace/blob.txt",
				offset: 0,
				byteLimit: 1024,
			},
		} as const;
		await expect(validateCloudflareRuntimeInspectionTransportEnvelopeV1(inspection)).resolves.toMatchObject({
			transportFamily: "bridge",
			family: "bridge",
			operation: "read_binary_file",
			replica,
			request: inspection.request,
		});

		const missingProfile = cloneRecord(effect) as Record<string, unknown> & { replica: Record<string, unknown> };
		delete missingProfile.replica.profileId;
		await expect(validateCloudflareRuntimeEffectTransportEnvelopeV1(missingProfile)).rejects.toBeInstanceOf(
			RequestValidationError,
		);
		const mismatchedRequestReplica = cloneRecord(effect) as unknown as { request: { replicaId: string } };
		mismatchedRequestReplica.request.replicaId = "other-replica";
		await expect(validateCloudflareRuntimeEffectTransportEnvelopeV1(mismatchedRequestReplica)).rejects.toBeInstanceOf(
			RequestValidationError,
		);
		const forgedContent = cloneRecord(effect) as unknown as { request: { content: string } };
		forgedContent.request.content = "hello!";
		await expect(validateCloudflareRuntimeEffectTransportEnvelopeV1(forgedContent)).rejects.toBeInstanceOf(
			RequestValidationError,
		);
	});

	test("bounds bridge search regexes at strict decode", async () => {
		const request = {
			operationLeaseId: "operation-lease-1",
			workspaceId: replica.workspaceId,
			expectedGeneration: checkpoint.generation,
			replicaId: replica.replicaId,
			leaseId: lease.leaseId,
			fence: { fenceId: lease.fenceId, token: "fence-token-1" },
			path: "/workspace/source",
			pattern: "first\\nsecond|third[0-9]",
			flags: "gims",
			limit: 100,
			cursor: null,
		};
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "search_text",
			replica,
			request,
		} as const;
		const validatedEnvelope = await validateCloudflareRuntimeInspectionTransportEnvelopeV1(envelope);
		expect(validatedEnvelope).toMatchObject({
			transportFamily: "bridge",
			operation: "search_text",
			request,
		});
		const typedRequest = request as unknown as RuntimeSearchRequest;
		const validCursor = await encodeCloudflareRuntimeSearchCursorV1(typedRequest, {
			path: "/workspace/source/file.txt" as RuntimeSearchRequest["path"],
			codeUnitOffset: 0,
		});
		await expect(
			validateCloudflareRuntimeInspectionTransportEnvelopeV1({
				...envelope,
				request: { ...request, limit: 1, cursor: validCursor },
			}),
		).resolves.toMatchObject({ operation: "search_text" });
		const otherRequest = { ...typedRequest, path: "/workspace/other" as RuntimeSearchRequest["path"] };
		const otherCursor = await encodeCloudflareRuntimeSearchCursorV1(otherRequest, {
			path: "/workspace/other/file.txt" as RuntimeSearchRequest["path"],
			codeUnitOffset: 0,
		});
		const unsafePositionTuple = JSON.parse(atob(validCursor)) as unknown[];
		unsafePositionTuple[3] = 1.5;
		for (const cursor of [
			0,
			1,
			Number.MAX_SAFE_INTEGER,
			"x".repeat(CLOUDFLARE_RUNTIME_SEARCH_CURSOR_MAX_CHARS_V1 + 1),
			"not-canonical-base64",
			otherCursor,
			btoa(JSON.stringify(unsafePositionTuple)),
		]) {
			await expect(
				validateCloudflareRuntimeInspectionTransportEnvelopeV1({
					...envelope,
					request: { ...request, cursor },
				}),
			).rejects.toBeInstanceOf(RequestValidationError);
		}
		await expect(
			decodeCloudflareRuntimeInspectionTransportResultEnvelopeV1(
				{
					schemaVersion: 1,
					family: "bridge",
					operation: "search_text",
					replica,
					result: {
						matches: [
							{
								path: "/workspace/source/file.txt",
								line: 1,
								column: 1,
								text: "x".repeat(CLOUDFLARE_RUNTIME_SEARCH_RESULT_BYTE_BUDGET_V1),
							},
						],
						nextCursor: null,
					},
				},
				validatedEnvelope,
			),
		).rejects.toThrow();

		for (const mutation of [
			{ pattern: "é".repeat(2_049) },
			{ flags: "u" },
			{ flags: "y" },
			{ pattern: "(a+)+$" },
			{ pattern: "a.*b" },
			{ pattern: "(?=a)" },
			{ pattern: "\\1" },
		]) {
			await expect(
				validateCloudflareRuntimeInspectionTransportEnvelopeV1({
					...envelope,
					request: { ...request, ...mutation },
				}),
			).rejects.toBeInstanceOf(RequestValidationError);
		}
	});

	test("freezes eight runtime paths and collision-resistant full-replica Durable Object names", async () => {
		expect(Object.values(cloudflareRuntimeRoutesV1)).toEqual([
			"/v1/runtime/effect",
			"/v1/runtime/inspect",
			"/v1/runtime/status",
			"/v1/runtime/checkpoint/fetch",
			"/v1/runtime/cache-eviction",
			"/v1/runtime/cache-eviction/inspect",
			"/v1/runtime/replica-delete",
			"/v1/runtime/replica-delete/inspect",
		]);
		const collisionA = { providerId: "a:b", profileId: "c", replicaId: "d", workspaceId: "e" } as const;
		const collisionB = { providerId: "a", profileId: "b:c", replicaId: "d", workspaceId: "e" } as const;
		const nameA = await deriveCloudflareRuntimeDurableObjectNameV1(collisionA);
		const nameB = await deriveCloudflareRuntimeDurableObjectNameV1(collisionB);
		expect(nameA).toMatch(/^runtime:v1:[0-9a-f]{64}$/);
		expect(nameB).not.toBe(nameA);
	});

	test("authenticates and strict-decodes before lookup, rejects old routes, and validates DO results", async () => {
		const token = "worker-transport-token";
		const tokenBytes = new TextEncoder().encode(token);
		const bearerDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", tokenBytes)), byte =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const names: string[] = [];
		const effect = (await frozenVectors())[0]!.effect;
		const rpc = {
			applyRuntimeEffect: async () => ({
				schemaVersion: 1,
				operation: "acquire",
				result: {
					status: "acquired",
					request: {
						requestId: effect.request.requestId,
						requestSha256: effect.request.requestSha256,
						transitionId: effect.request.transitionId,
					},
					lease,
					providerPhase: "reserved",
					deletionAuthorityDomain: "persistent",
				},
				unexpected: true,
			}),
		} as unknown as WorkspaceRpc;
		const namespace: WorkspaceNamespace = {
			idFromName(name) {
				names.push(name);
				return { name } as DurableObjectId;
			},
			get() {
				return rpc;
			},
		};
		const env: WorkerEnv = { WORKSPACE: namespace, CLOUD_OMP_BEARER_SHA256: bearerDigest };
		const fetchRuntime = (path: string, body: unknown, bearer = token) =>
			worker.fetch(
				new Request(`https://worker.example${path}`, {
					method: "POST",
					headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
				env,
			);

		expect((await fetchRuntime(cloudflareRuntimeRoutesV1.effect, effect, "wrong-token")).status).toBe(401);
		expect(names).toEqual([]);
		expect((await fetchRuntime(cloudflareRuntimeRoutesV1.effect, { unexpected: true })).status).toBe(400);
		expect(names).toEqual([]);
		for (const oldPath of ["/v1/runtime/effects", "/v1/runtime/renewals", "/v1/runtime/bridge"]) {
			expect((await fetchRuntime(oldPath, effect)).status).toBe(404);
			expect(names).toEqual([]);
		}

		const response = await fetchRuntime(cloudflareRuntimeRoutesV1.effect, effect);
		expect(response.status).toBe(500);
		expect(names).toEqual([await deriveCloudflareRuntimeDurableObjectNameV1(replica)]);
		expect(await response.json()).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
	});

	test("projects checkpoint fetch locators for Durable Object lookup while forwarding the full locator", async () => {
		const token = "worker-transport-token";
		const tokenBytes = new TextEncoder().encode(token);
		const bearerDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", tokenBytes)), byte =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const names: string[] = [];
		const locator = {
			providerId: replica.providerId,
			profileId: replica.profileId,
			workspaceId: replica.workspaceId,
			replicaId: replica.replicaId,
			leaseId: lease.leaseId,
			checkpointId: "checkpoint-1",
		} as const;
		const calls: unknown[] = [];
		const rpc = {
			fetchRuntimeCheckpoint(input: unknown) {
				calls.push(input);
				throw Object.assign(new Error("Frozen runtime checkpoint is unavailable"), {
					name: "WorkspaceObjectError",
					status: 404,
					code: "protocol_invalid",
				});
			},
		} as unknown as WorkspaceRpc;
		const env: WorkerEnv = {
			WORKSPACE: {
				idFromName(name) {
					names.push(name);
					return { name } as DurableObjectId;
				},
				get() {
					return rpc;
				},
			},
			CLOUD_OMP_BEARER_SHA256: bearerDigest,
		};
		const malformed = await worker.fetch(
			new Request(`https://worker.example${cloudflareRuntimeRoutesV1.checkpointFetch}`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ schemaVersion: 1, locator: { ...locator, unexpected: true } }),
			}),
			env,
		);
		expect(malformed.status).toBe(400);
		expect(names).toEqual([]);
		expect(calls).toEqual([]);

		const response = await worker.fetch(
			new Request(`https://worker.example${cloudflareRuntimeRoutesV1.checkpointFetch}`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ schemaVersion: 1, locator }),
			}),
			env,
		);
		expect(response.status).toBe(404);
		expect(names).toEqual([await deriveCloudflareRuntimeDurableObjectNameV1(replica)]);
		expect(calls).toEqual([{ schemaVersion: 1, locator }]);
		expect(await response.json()).toEqual({
			error: { code: "protocol_invalid", message: "Frozen runtime checkpoint is unavailable" },
		});
	});

	test("rejects push inspection generation and effect checkpoint-generation mismatch before effects", async () => {
		const push = (await frozenVectors()).find(vector => vector.operation === "push")!;
		const forbiddenInspection = cloneRecord(push.inspection);
		(forbiddenInspection.request.snapshot as Record<string, unknown>).generation = checkpoint.generation;
		await expect(validateCloudflareRuntimeInspectionEnvelopeV1(forbiddenInspection)).rejects.toMatchObject({
			code: "unknown_fields",
		});

		const mismatchedEffect = cloneRecord(push.effect);
		const snapshot = mismatchedEffect.request.snapshot as { checkpoint: Record<string, unknown> };
		snapshot.checkpoint.generation = checkpoint.generation + 1;
		await expect(validateCloudflareRuntimeEffectEnvelopeV1(mismatchedEffect)).rejects.toMatchObject({
			code: "checkpoint_generation_mismatch",
		});
	});

	test("validates one-alarm retention rows, expiry-first ties, and bounded deferral updates", async () => {
		const plannedAt = "2030-01-02T00:00:00.000Z";
		const retentionDeadline = "2030-01-02T01:00:00.000Z";
		const planWithoutDigest = {
			requestId: digest("8"),
			requestSha256: digest("0"),
			requestedByOperationId: "transition-retention",
			replica,
			mode: "workspace_retention",
			delayMs: 3_600_000,
			plannedAt,
			retentionDeadline,
		} as const;
		const plan = {
			...planWithoutDigest,
			requestSha256: await canonicalRuntimeSha256V1(projectCloudflareReplicaCacheEvictionTupleV1(planWithoutDigest)),
		};
		await expect(
			validateCloudflareReplicaCacheEvictionPlanV1(plan, { workspaceRetentionMs: 3_600_000 }),
		).resolves.toEqual(plan);
		const dueAtEpochMs = Date.parse(retentionDeadline);
		const retention = await validateCloudflareDurableDeadlineV1(
			{
				schemaVersion: 1,
				dueAtEpochMs,
				attempt: 0,
				updatedAtEpochMs: Date.parse(plannedAt),
				kind: "workspace_retention",
				key: plan.requestId,
				eviction: plan,
				acceptedAtEpochMs: Date.parse(plannedAt),
				lastDeferral: null,
			},
			{ workspaceRetentionMs: 3_600_000 },
		);
		const tied: readonly CloudflareDurableDeadlineV1[] = [
			retention,
			{
				schemaVersion: 1,
				dueAtEpochMs,
				attempt: 0,
				updatedAtEpochMs: dueAtEpochMs,
				kind: "sync_retry",
				key: "command-1",
			},
			{
				schemaVersion: 1,
				dueAtEpochMs,
				attempt: 0,
				updatedAtEpochMs: dueAtEpochMs,
				kind: "runtime_expiry",
				key: lease.leaseId,
			},
		];
		expect(selectDueCloudflareDurableDeadlinesV1(tied, dueAtEpochMs).map(row => row.kind)).toEqual([
			"runtime_expiry",
			"sync_retry",
			"workspace_retention",
		]);
		expect(rearmCloudflarePhysicalAlarmV1(tied, dueAtEpochMs - 1)).toEqual({
			action: "set",
			atEpochMs: dueAtEpochMs,
		});
		const deferred = deferCloudflareWorkspaceRetentionDeadlineV1(
			retention,
			"checkpoint_unacknowledged",
			dueAtEpochMs,
		);
		expect(deferred).toMatchObject({
			attempt: 1,
			dueAtEpochMs: dueAtEpochMs + 60_000,
			updatedAtEpochMs: dueAtEpochMs,
			lastDeferral: {
				reason: "checkpoint_unacknowledged",
				observedAtEpochMs: dueAtEpochMs,
				nextAttemptAtEpochMs: dueAtEpochMs + 60_000,
			},
		});
		await expect(validateCloudflareDurableDeadlineV1(deferred, { workspaceRetentionMs: 3_600_000 })).resolves.toEqual(
			deferred,
		);
	});

	test("recomputes persistent deletion core, request, final-plan, tombstone, and outer authorization", async () => {
		const requestId = digest("9");
		const core = {
			deleteId: "delete-1",
			deletionAuthorityId: "delete-authority-1",
			quarantineId: "quarantine-1",
			workspaceId: replica.workspaceId,
			expectedCheckpoint: checkpoint,
			expectedRuntimeAttachmentCreateId: "attachment-create-1",
			expectedRuntimeAttachmentRevision: 4,
			expectedKnownReplicaCatalogRevision: 2,
			plannedDeletionAt: "2030-01-03T00:00:00.000Z",
			deletedBytesGraceMs: 60_000,
			purgeAfter: "2030-01-03T00:01:00.000Z",
			replicaRequests: [{ replica, deletionAuthorityDomain: "persistent", requestId }],
		} as const;
		const deletionPlanCoreSha256 = `sha256:${await canonicalRuntimeSha256V1(
			projectCloudflareDeletionPlanCoreTupleV1(core as WorkspaceDeletionPlanCoreV1),
		)}`;
		const tombstone = deriveCloudflareWorkspaceTombstoneV1(core as WorkspaceDeletionPlanCoreV1);
		const requestSha256 = await canonicalRuntimeSha256V1(
			projectCloudflarePersistentReplicaDeleteTupleV1({ requestId, replica, deletionPlanCoreSha256, tombstone }),
		);
		const deletion = {
			core,
			replicaRequests: [
				{
					replica,
					deletionAuthorityDomain: "persistent",
					request: { requestId, requestSha256 },
				},
			],
		} as const;
		const deletionPlanSha256 = `sha256:${await canonicalRuntimeSha256V1(
			projectCloudflareDeletionPlanTupleV1(deletion as WorkspaceDeletionPlanV1),
		)}`;
		const request = {
			requestId,
			requestSha256,
			replica,
			authorization: {
				domain: "persistent",
				deletion,
				deletionPlanCoreSha256,
				deletionPlanSha256,
				tombstone,
			},
		};
		await expect(validateCloudflareReplicaDeleteRequestV1(request, "persistent")).resolves.toMatchObject({
			authorizationDomain: "persistent",
			requestSha256,
		});
		const result = {
			status: "deleted",
			request: { requestId, requestSha256 },
			replica,
			authorization: request.authorization,
			observedAt: "2030-01-03T00:01:01.000Z",
			retryAfter: null,
			receiptSha256: `sha256:${await canonicalRuntimeSha256V1(projectCloudflareReplicaDeleteReceiptTupleV1(request))}`,
		} as const;
		await expect(decodeCloudflareReplicaDeleteResultV1(result, request, "persistent")).resolves.toEqual(result);
		await expect(decodeCloudflareReplicaDeleteResultV1(result, request, "persistent")).resolves.toEqual(result);
		await expect(
			decodeCloudflareReplicaDeleteResultV1({ ...result, receiptSha256: `sha256:${digest("e")}` }, request),
		).rejects.toMatchObject({ code: "provider_response_invalid" });
		await expect(
			decodeCloudflareReplicaDeleteResultV1(result, { ...request, requestId: digest("8") }, "persistent"),
		).rejects.toMatchObject({ code: "request_identity_mismatch" });
		const differentAuthority = cloneRecord(result);
		differentAuthority.authorization.deletionPlanSha256 = `sha256:${digest("e")}`;
		await expect(
			decodeCloudflareReplicaDeleteResultV1(differentAuthority, request, "persistent"),
		).rejects.toMatchObject({
			code: "request_identity_mismatch",
		});
		const mutated = cloneRecord(request);
		mutated.authorization.deletionPlanSha256 = `sha256:${digest("f")}`;
		await expect(validateCloudflareReplicaDeleteRequestV1(mutated, "persistent")).rejects.toBeInstanceOf(
			RequestValidationError,
		);
	});

	test("keeps status and checkpoint fetch request DTOs closed and effect-free", () => {
		expect(validateCloudflareRuntimeStatusRequestV1({ schemaVersion: 1, replica, leaseId: lease.leaseId })).toEqual({
			schemaVersion: 1,
			replica,
			leaseId: lease.leaseId,
		});
		expect(() =>
			validateCloudflareRuntimeStatusRequestV1({ schemaVersion: 1, replica, leaseId: lease.leaseId, start: true }),
		).toThrow(RequestValidationError);
		expect(
			validateCloudflareCheckpointFetchRequestV1({
				schemaVersion: 1,
				locator: {
					providerId: replica.providerId,
					profileId: replica.profileId,
					workspaceId: replica.workspaceId,
					replicaId: replica.replicaId,
					leaseId: lease.leaseId,
					checkpointId: "checkpoint-1",
				},
			}),
		).toMatchObject({ schemaVersion: 1 });
	});
});
