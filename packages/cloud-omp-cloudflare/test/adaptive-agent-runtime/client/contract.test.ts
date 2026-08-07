import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
	CommandId,
	PersistentModelWorkspacePath,
	RuntimeAccessContext,
	RuntimeCanonicalProviderInspectionV1,
	RuntimeCommandLocator,
	RuntimeCommandRequest,
	RuntimeLeaseRef,
	RuntimeLeaseRenewalPlan,
	RuntimeLeaseRenewRequest,
	RuntimeListRequest,
	RuntimeMutationContext,
	RuntimeReadBinaryRequest,
	RuntimeReadTextRequest,
	RuntimeRecoveryFreezeRequest,
	RuntimeSearchRequest,
	RuntimeWriteTextRequest,
} from "@oh-my-pi/pi-coding-agent";
import { CloudflareRuntimeBridge } from "../../../src/client/environment-bridge";
import { createCloudflareRuntimeProvider } from "../../../src/client/environment-provider";
import {
	decodeCloudflareCheckpointFetchWireV1,
	decodeCloudflareReplicaCacheEvictionResultWireV1,
	decodeCloudflareReplicaDeleteResultWireV1,
	decodeCloudflareRuntimeEffectResultWireV1,
	decodeCloudflareRuntimeEffectTransportResultWireV1,
	decodeCloudflareRuntimeInspectionTransportResultWireV1,
	decodeCloudflareRuntimeStatusWireV1,
	encodeCloudflareCheckpointFetchWireV1,
	encodeCloudflareReplicaCacheEvictionWireV1,
	encodeCloudflareReplicaDeleteWireV1,
	encodeCloudflareRuntimeEffectTransportWireV1,
	encodeCloudflareRuntimeEffectWireV1,
	encodeCloudflareRuntimeInspectionTransportWireV1,
	encodeCloudflareRuntimeInspectionWireV1,
	encodeCloudflareRuntimeStatusWireV1,
	sanitizeEnvironmentError,
} from "../../../src/client/environment-wire";
import { createOrdinaryJsonClient } from "../../../src/client/http";
import {
	CLOUD_OMP_REMOTE_ROOT,
	type CloudflareRuntimeEffectEnvelopeV1,
	type CloudflareRuntimeEffectTransportEnvelopeV1,
	type CloudflareRuntimeInspectionEnvelopeV1,
	type CloudflareRuntimeInspectionTransportEnvelopeV1,
	CloudflareRuntimeProtocolErrorV1,
	canonicalRuntimeSha256V1,
	cloudflareRuntimeRoutesV1,
	projectCloudflareReplicaCacheEvictionTupleV1,
	projectCloudflareReplicaDeleteReceiptTupleV1,
	projectCloudflareRuntimeInspectionTupleV1,
	projectCloudflareTransientReplicaDeleteTupleV1,
} from "../../../src/protocol";

const digest = (character: string): string => character.repeat(64);
const replica = {
	providerId: "cloudflare",
	profileId: "standard-2",
	replicaId: "replica-client-1",
	workspaceId: "workspace-client-1",
} as const;
const checkpoint = {
	workspaceId: replica.workspaceId,
	generation: 7,
	rootSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	fileCount: 0,
	byteCount: 0,
	committedAt: "2030-02-01T00:00:00.000Z",
} as const;
const lease = {
	leaseId: "lease-client-1",
	replica,
	fenceId: "fence-client-1",
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

interface ClientVector {
	readonly operation:
		| "acquire"
		| "push"
		| "quiesce"
		| "checkpoint"
		| "revoke"
		| "checkpoint_acknowledgement"
		| "release";
	readonly inspection: CloudflareRuntimeInspectionEnvelopeV1;
	readonly effect: CloudflareRuntimeEffectEnvelopeV1;
}

async function sealRequest(
	operation: ClientVector["operation"],
	request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const provisional = {
		operation,
		request: { ...request, requestSha256: digest("0") },
	} as unknown as RuntimeCanonicalProviderInspectionV1;
	return {
		...request,
		requestSha256: await canonicalRuntimeSha256V1(projectCloudflareRuntimeInspectionTupleV1(provisional)),
	};
}

async function clientVectors(): Promise<readonly ClientVector[]> {
	const acquire = await sealRequest("acquire", {
		requestId: digest("a"),
		transitionId: "transition-client-acquire",
		candidate,
		plan: leasePlan,
	});
	const push = await sealRequest("push", {
		requestId: digest("b"),
		transitionId: "transition-client-acquire",
		lease,
		snapshot: { rootSha256: checkpoint.rootSha256, fileCount: 0, byteCount: 0 },
	});
	const quiesce = await sealRequest("quiesce", {
		requestId: digest("c"),
		transitionId: "transition-client-drain",
		lease,
	});
	const frozenCheckpoint = await sealRequest("checkpoint", {
		requestId: digest("d"),
		transitionId: "transition-client-drain",
		checkpointId: "checkpoint-client-1",
		lease,
	});
	const revoke = await sealRequest("revoke", {
		requestId: digest("e"),
		transitionId: "transition-client-drain",
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
		checkpointId: "checkpoint-client-1",
		rootSha256: checkpoint.rootSha256,
		fileCount: 0,
		byteCount: 0,
		format: "omp-text-v1",
		baseGeneration: checkpoint.generation,
		frozenAt: "2030-02-01T00:12:00.000Z",
	} as const;
	const canonicalCommit = {
		workspaceId: replica.workspaceId,
		commitId: "commit-client-1",
		expectedGeneration: checkpoint.generation,
		checkpoint: { ...checkpoint, generation: checkpoint.generation + 1, committedAt: "2030-02-01T00:13:00.000Z" },
		durableAt: "2030-02-01T00:13:01.000Z",
	} as const;
	const acknowledgement = await sealRequest("checkpoint_acknowledgement", {
		requestId: digest("f"),
		parentOperationId: "transition-client-drain",
		reference,
		canonicalCommit,
	});
	const release = await sealRequest("release", {
		requestId: digest("7"),
		parentOperationId: "transition-client-drain",
		replica,
		leaseId: lease.leaseId,
	});
	const fence = { fenceId: lease.fenceId, token: "client-volatile-token" };
	return [
		{
			operation: "acquire",
			inspection: {
				schemaVersion: 1,
				operation: "acquire",
				request: acquire,
			} as CloudflareRuntimeInspectionEnvelopeV1,
			effect: {
				schemaVersion: 1,
				operation: "acquire",
				request: { ...acquire, fence },
			} as CloudflareRuntimeEffectEnvelopeV1,
		},
		{
			operation: "push",
			inspection: { schemaVersion: 1, operation: "push", request: push } as CloudflareRuntimeInspectionEnvelopeV1,
			effect: {
				schemaVersion: 1,
				operation: "push",
				request: { ...push, fence, snapshot: { checkpoint, files: [] } },
			} as CloudflareRuntimeEffectEnvelopeV1,
		},
		{
			operation: "quiesce",
			inspection: {
				schemaVersion: 1,
				operation: "quiesce",
				request: quiesce,
			} as CloudflareRuntimeInspectionEnvelopeV1,
			effect: {
				schemaVersion: 1,
				operation: "quiesce",
				request: { ...quiesce, fence },
			} as CloudflareRuntimeEffectEnvelopeV1,
		},
		{
			operation: "checkpoint",
			inspection: {
				schemaVersion: 1,
				operation: "checkpoint",
				request: frozenCheckpoint,
			} as CloudflareRuntimeInspectionEnvelopeV1,
			effect: {
				schemaVersion: 1,
				operation: "checkpoint",
				request: { ...frozenCheckpoint, fence },
			} as CloudflareRuntimeEffectEnvelopeV1,
		},
		{
			operation: "revoke",
			inspection: {
				schemaVersion: 1,
				operation: "revoke",
				request: revoke,
			} as CloudflareRuntimeInspectionEnvelopeV1,
			effect: { schemaVersion: 1, operation: "revoke", request: revoke } as CloudflareRuntimeEffectEnvelopeV1,
		},
		{
			operation: "checkpoint_acknowledgement",
			inspection: {
				schemaVersion: 1,
				operation: "checkpoint_acknowledgement",
				request: acknowledgement,
			} as CloudflareRuntimeInspectionEnvelopeV1,
			effect: {
				schemaVersion: 1,
				operation: "checkpoint_acknowledgement",
				request: acknowledgement,
			} as CloudflareRuntimeEffectEnvelopeV1,
		},
		{
			operation: "release",
			inspection: {
				schemaVersion: 1,
				operation: "release",
				request: release,
			} as CloudflareRuntimeInspectionEnvelopeV1,
			effect: { schemaVersion: 1, operation: "release", request: release } as CloudflareRuntimeEffectEnvelopeV1,
		},
	];
}

function cloneRecord<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

describe("Cloudflare adaptive runtime client codec", () => {
	test("encodes the same closed seven request/inspection DTO pairs without fallback", async () => {
		for (const vector of await clientVectors()) {
			const effect = JSON.parse(await encodeCloudflareRuntimeEffectWireV1(vector.effect)) as {
				operation: string;
				request: { requestSha256: string };
			};
			const inspection = JSON.parse(await encodeCloudflareRuntimeInspectionWireV1(vector.inspection)) as {
				operation: string;
				request: { requestSha256: string };
			};
			expect(effect.operation).toBe(vector.operation);
			expect(effect.request.requestSha256).toBe(inspection.request.requestSha256);
		}

		const malformed = cloneRecord((await clientVectors())[0]!.effect);
		(malformed.request as Record<string, unknown>).transitionId = "mutated-transition";
		await expect(encodeCloudflareRuntimeEffectWireV1(malformed)).rejects.toBeInstanceOf(
			CloudflareRuntimeProtocolErrorV1,
		);
	});

	test("validates release response identity and stopped/no-compute proof", async () => {
		const release = (await clientVectors()).find(vector => vector.operation === "release")!;
		const request = release.effect.request as {
			readonly requestId: string;
			readonly requestSha256: string;
			readonly parentOperationId: string;
		};
		const response = {
			schemaVersion: 1,
			operation: "release",
			result: {
				status: "released",
				request: {
					requestId: request.requestId,
					requestSha256: request.requestSha256,
					parentOperationId: request.parentOperationId,
				},
				replica,
				leaseId: lease.leaseId,
				compute: "stopped",
			},
		};
		await expect(decodeCloudflareRuntimeEffectResultWireV1(response, release.effect)).resolves.toEqual(response);
		await expect(
			decodeCloudflareRuntimeEffectResultWireV1(
				{ ...response, result: { ...response.result, compute: "running" } },
				release.effect,
			),
		).rejects.toMatchObject({ code: "provider_response_invalid" });
	});

	test("keeps cache eviction digest unprefixed and deadline-bound", async () => {
		const planWithoutDigest = {
			requestId: digest("8"),
			requestSha256: digest("0"),
			requestedByOperationId: "transition-retention-client",
			replica,
			mode: "workspace_retention",
			delayMs: 7_200_000,
			plannedAt: "2030-02-02T00:00:00.000Z",
			retentionDeadline: "2030-02-02T02:00:00.000Z",
		} as const;
		const plan = {
			...planWithoutDigest,
			requestSha256: await canonicalRuntimeSha256V1(projectCloudflareReplicaCacheEvictionTupleV1(planWithoutDigest)),
		};
		expect(
			JSON.parse(await encodeCloudflareReplicaCacheEvictionWireV1(plan, { workspaceRetentionMs: 7_200_000 })),
		).toEqual(plan);
		await expect(
			encodeCloudflareReplicaCacheEvictionWireV1(
				{ ...plan, requestSha256: `sha256:${plan.requestSha256}` },
				{ workspaceRetentionMs: 7_200_000 },
			),
		).rejects.toMatchObject({ code: "invalid_digest" });
		const accepted = {
			status: "accepted",
			acceptance: {
				requestId: plan.requestId,
				requestSha256: plan.requestSha256,
				replica,
				retentionDeadline: plan.retentionDeadline,
				acceptedAt: plan.plannedAt,
			},
		} as const;
		await expect(
			decodeCloudflareReplicaCacheEvictionResultWireV1(accepted, plan, false, {
				workspaceRetentionMs: 7_200_000,
			}),
		).resolves.toMatchObject({ status: "accepted" });
		await expect(
			decodeCloudflareReplicaCacheEvictionResultWireV1(accepted, plan, true, {
				workspaceRetentionMs: 7_200_000,
			}),
		).resolves.toMatchObject({ status: "accepted" });
	});

	test("binds terminal deletion receipts to the exact request and authorization", async () => {
		const authorization = {
			domain: "transient_task",
			taskId: "task-client-1",
			runId: "run-client-1",
			workspaceId: replica.workspaceId,
			cleanupId: "cleanup-client-1",
			cleanupAuthorityId: "cleanup-authority-client-1",
			cleanupPlanSha256: `sha256:${digest("2")}`,
			finalCheckpoint: checkpoint,
			replicaDeleteRequestId: digest("9"),
			replicaDeletionQuarantineId: "quarantine-client-1",
			replicaDeletionPlannedAt: "2030-02-03T00:00:00.000Z",
			replicaDeletionPurgeAfter: "2030-02-03T00:01:00.000Z",
		} as const;
		const request = {
			requestId: authorization.replicaDeleteRequestId,
			requestSha256: await canonicalRuntimeSha256V1(
				projectCloudflareTransientReplicaDeleteTupleV1({ replica, authorization }),
			),
			replica,
			authorization,
		};
		expect(JSON.parse(await encodeCloudflareReplicaDeleteWireV1(request, "transient_task"))).toEqual(request);
		await expect(encodeCloudflareReplicaDeleteWireV1(request, "persistent")).rejects.toMatchObject({
			code: "deletion_authority_domain_mismatch",
		});

		const result = {
			status: "deleted",
			request: { requestId: request.requestId, requestSha256: request.requestSha256 },
			replica,
			authorization,
			observedAt: "2030-02-03T00:01:01.000Z",
			retryAfter: null,
			receiptSha256: `sha256:${await canonicalRuntimeSha256V1(projectCloudflareReplicaDeleteReceiptTupleV1(request))}`,
		} as const;
		await expect(
			decodeCloudflareReplicaDeleteResultWireV1(result, request, false, "transient_task"),
		).resolves.toEqual(result);
		await expect(decodeCloudflareReplicaDeleteResultWireV1(result, request, true, "transient_task")).resolves.toEqual(
			result,
		);
		await expect(
			decodeCloudflareReplicaDeleteResultWireV1(result, request, false, "transient_task"),
		).resolves.toEqual(result);

		const differentAuthorization = {
			...authorization,
			cleanupId: "cleanup-client-2",
			cleanupAuthorityId: "cleanup-authority-client-2",
			replicaDeleteRequestId: digest("8"),
			replicaDeletionQuarantineId: "quarantine-client-2",
		} as const;
		const differentRequest = {
			requestId: differentAuthorization.replicaDeleteRequestId,
			requestSha256: await canonicalRuntimeSha256V1(
				projectCloudflareTransientReplicaDeleteTupleV1({ replica, authorization: differentAuthorization }),
			),
			replica,
			authorization: differentAuthorization,
		};
		await expect(
			decodeCloudflareReplicaDeleteResultWireV1(result, differentRequest, false, "transient_task"),
		).rejects.toMatchObject({ code: "request_identity_mismatch" });
		await expect(
			decodeCloudflareReplicaDeleteResultWireV1(
				{ ...result, authorization: differentAuthorization },
				request,
				false,
				"transient_task",
			),
		).rejects.toMatchObject({ code: "request_identity_mismatch" });
		const reusedReceiptSha256 = `sha256:${await canonicalRuntimeSha256V1(projectCloudflareReplicaDeleteReceiptTupleV1(differentRequest))}`;
		await expect(
			decodeCloudflareReplicaDeleteResultWireV1(
				{ ...result, receiptSha256: reusedReceiptSha256 },
				request,
				false,
				"transient_task",
			),
		).rejects.toMatchObject({ code: "provider_response_invalid" });
	});

	test("round-trips status and authenticated frozen-checkpoint retrieval without compute controls", async () => {
		const statusRequest = { schemaVersion: 1, replica, leaseId: lease.leaseId } as const;
		expect(JSON.parse(encodeCloudflareRuntimeStatusWireV1(statusRequest))).toEqual(statusRequest);
		const statusResponse = {
			schemaVersion: 1,
			observationSource: "durable_state_and_container_running_only",
			containerRunning: false,
			result: {
				status: "present",
				lease,
				providerPhase: "ready",
				compute: "stopped",
				activeCommands: 0,
				pendingSyncs: 0,
				replicaImage: { rootSha256: checkpoint.rootSha256, fileCount: 0, byteCount: 0 },
			},
			deadlines: {
				earliestDueAtEpochMs: null,
				counts: { sync_retry: 0, runtime_expiry: 0, workspace_retention: 0 },
			},
		} as const;
		expect(decodeCloudflareRuntimeStatusWireV1(statusResponse, statusRequest)).toEqual(statusResponse);

		const locator = {
			providerId: replica.providerId,
			profileId: replica.profileId,
			workspaceId: replica.workspaceId,
			replicaId: replica.replicaId,
			leaseId: lease.leaseId,
			checkpointId: "checkpoint-client-1",
		} as const;
		const fetchRequest = { schemaVersion: 1, locator } as const;
		expect(JSON.parse(encodeCloudflareCheckpointFetchWireV1(fetchRequest))).toEqual(fetchRequest);
		const reference = {
			...locator,
			rootSha256: checkpoint.rootSha256,
			fileCount: 0,
			byteCount: 0,
			format: "omp-text-v1",
			baseGeneration: checkpoint.generation,
			frozenAt: "2030-02-01T00:12:00.000Z",
		} as const;
		const fetchResponse = {
			schemaVersion: 1,
			result: {
				status: "fetched",
				checkpoint: {
					rootSha256: checkpoint.rootSha256,
					fileCount: 0,
					byteCount: 0,
					reference,
					files: [],
				},
			},
		} as const;
		await expect(decodeCloudflareCheckpointFetchWireV1(fetchResponse, fetchRequest)).resolves.toEqual(fetchResponse);
	});

	test("maps frozen protocol failures as protocol errors rather than local fallback", () => {
		for (const code of ["request_digest_mismatch", "request_conflict"] as const) {
			const error = new CloudflareRuntimeProtocolErrorV1(code);
			expect(sanitizeEnvironmentError(error, undefined, "acquire")).toMatchObject({
				kind: "protocol",
				stage: "acquire",
				code,
			});
		}
	});

	test("routes every supplemental operation through the exact singular effect and inspect endpoints", async () => {
		const observed: Array<{ readonly path: string; readonly body: unknown }> = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			observed.push({ path: new URL(request.url).pathname, body: await request.json() });
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		};
		const http = createOrdinaryJsonClient({ endpoint: "https://runtime.example.test", bearer: "test", fetch });
		const runtimeLease = lease as unknown as RuntimeLeaseRef;
		const bridge = new CloudflareRuntimeBridge(http, runtimeLease);
		const provider = createCloudflareRuntimeProvider(
			{ endpoint: "https://runtime.example.test", bearer: "test", profile: replica.profileId },
			{ fetch },
		);

		const renewalRequestId = digest("1");
		const renewalRequestSha256 = await canonicalRuntimeSha256V1([
			"omp-runtime-provider-v1",
			"renew",
			"renewal-client-1",
			1,
			replica.providerId,
			replica.profileId,
			replica.workspaceId,
			replica.replicaId,
			lease.leaseId,
			lease.fenceId,
			lease.baseGeneration,
			lease.renewalSequence,
			lease.acquiredAt,
			lease.renewBy,
			lease.expiresAt,
			600_000,
		]);
		const renewalPlan = {
			renewalId: "renewal-client-1",
			sequence: 1,
			expectedLease: runtimeLease,
			leaseTtlMs: 600_000,
			request: { requestId: renewalRequestId, requestSha256: renewalRequestSha256 },
		} as unknown as RuntimeLeaseRenewalPlan;
		const renewalRequest = {
			plan: renewalPlan,
			fence: { fenceId: lease.fenceId, token: "client-volatile-token" },
		} as unknown as RuntimeLeaseRenewRequest;

		const recoveryLocator = {
			recoveryFreezeId: "recovery-freeze-client-1",
			replica,
			leaseId: lease.leaseId,
			fenceId: lease.fenceId,
			baseGeneration: lease.baseGeneration,
			checkpointId: "checkpoint-client-1",
		} as const;
		const recoveryRequest = {
			requestId: digest("2"),
			requestSha256: await canonicalRuntimeSha256V1([
				"omp-runtime-provider-v1",
				"recovery_freeze",
				recoveryLocator.recoveryFreezeId,
				replica.providerId,
				replica.profileId,
				replica.workspaceId,
				replica.replicaId,
				lease.leaseId,
				lease.fenceId,
				lease.baseGeneration,
				recoveryLocator.checkpointId,
			]),
			locator: recoveryLocator,
		} as unknown as RuntimeRecoveryFreezeRequest;
		const commandLocator = {
			replica,
			leaseId: lease.leaseId,
			commandId: "command-client-1",
			requestSha256: digest("3"),
		} as unknown as RuntimeCommandLocator;

		const access = {
			operationLeaseId: "operation-lease-client-1",
			workspaceId: replica.workspaceId,
			expectedGeneration: lease.baseGeneration,
			replicaId: replica.replicaId,
			leaseId: lease.leaseId,
			fence: { fenceId: lease.fenceId, token: "client-volatile-token" },
		} as unknown as RuntimeAccessContext;
		const accessTuple = [
			access.operationLeaseId,
			access.workspaceId,
			access.expectedGeneration,
			access.replicaId,
			access.leaseId,
			access.fence.fenceId,
		] as const;
		const notesPath = `${CLOUD_OMP_REMOTE_ROOT}/notes.txt` as PersistentModelWorkspacePath;
		const tmpPath = `${CLOUD_OMP_REMOTE_ROOT}/tmp` as PersistentModelWorkspacePath;
		const fromPath = `${CLOUD_OMP_REMOTE_ROOT}/from.txt` as PersistentModelWorkspacePath;
		const toPath = `${CLOUD_OMP_REMOTE_ROOT}/to.txt` as PersistentModelWorkspacePath;
		const sourcePath = `${CLOUD_OMP_REMOTE_ROOT}/src` as PersistentModelWorkspacePath;
		const content = "cloud transport\n";
		const contentSha256 = createHash("sha256").update(content).digest("hex");
		const writeRequest = {
			...access,
			requestId: digest("4"),
			requestSha256: await canonicalRuntimeSha256V1([
				"omp-runtime-request-v1",
				"write_text",
				...accessTuple,
				notesPath,
				contentSha256,
				new TextEncoder().encode(content).byteLength,
			]),
			path: notesPath,
			content,
			contentSha256,
		} as unknown as RuntimeWriteTextRequest;
		const mkdirRequest = {
			...access,
			requestId: digest("5"),
			requestSha256: await canonicalRuntimeSha256V1([
				"omp-runtime-request-v1",
				"mkdir",
				...accessTuple,
				tmpPath,
				true,
			]),
			path: tmpPath,
			recursive: true,
		} as unknown as RuntimeMutationContext & {
			readonly path: PersistentModelWorkspacePath;
			readonly recursive: boolean;
		};
		const removeRequest = {
			...access,
			requestId: digest("6"),
			requestSha256: await canonicalRuntimeSha256V1([
				"omp-runtime-request-v1",
				"remove",
				...accessTuple,
				tmpPath,
				true,
			]),
			path: tmpPath,
			recursive: true,
		} as unknown as RuntimeMutationContext & {
			readonly path: PersistentModelWorkspacePath;
			readonly recursive: boolean;
		};
		const renameRequest = {
			...access,
			requestId: digest("7"),
			requestSha256: await canonicalRuntimeSha256V1([
				"omp-runtime-request-v1",
				"rename",
				...accessTuple,
				fromPath,
				toPath,
			]),
			from: fromPath,
			to: toPath,
		} as unknown as RuntimeMutationContext & {
			readonly from: PersistentModelWorkspacePath;
			readonly to: PersistentModelWorkspacePath;
		};
		const command = {
			shell: "/bin/bash",
			source: "printf ok",
			cwd: sourcePath,
			environment: "omp-runtime-scrubbed-v1",
			timeoutMs: 1_000,
			outputByteLimit: 1_024,
			pty: false,
		} as const;
		const commandRequest = {
			...access,
			commandId: commandLocator.commandId,
			requestSha256: await canonicalRuntimeSha256V1([
				"omp-runtime-request-v1",
				"command_submit",
				...accessTuple,
				command.shell,
				command.source,
				command.cwd,
				command.environment,
				command.timeoutMs,
				command.outputByteLimit,
				command.pty,
			]),
			command,
		} as unknown as RuntimeCommandRequest;
		const cancelRequest = {
			...access,
			requestId: digest("8"),
			requestSha256: await canonicalRuntimeSha256V1([
				"omp-runtime-request-v1",
				"command_cancel",
				...accessTuple,
				commandLocator.commandId,
				"SIGTERM",
			]),
			commandId: commandLocator.commandId,
			signal: "SIGTERM",
		} as unknown as RuntimeMutationContext & { readonly commandId: CommandId; readonly signal: "SIGTERM" };
		const disposeRequest = {
			...access,
			requestId: digest("9"),
			requestSha256: await canonicalRuntimeSha256V1([
				"omp-runtime-request-v1",
				"command_dispose",
				...accessTuple,
				commandLocator.commandId,
			]),
			commandId: commandLocator.commandId,
		} as unknown as RuntimeMutationContext & { readonly commandId: CommandId };

		const vectors: readonly {
			readonly family: "control" | "bridge";
			readonly operation: string;
			readonly route: string;
			readonly invoke: () => Promise<unknown>;
		}[] = [
			{
				family: "control",
				operation: "renew",
				route: cloudflareRuntimeRoutesV1.effect,
				invoke: () => provider.renew(renewalRequest),
			},
			{
				family: "control",
				operation: "renew",
				route: cloudflareRuntimeRoutesV1.inspect,
				invoke: () => provider.inspectRenewal(renewalPlan),
			},
			{
				family: "control",
				operation: "recovery_freeze",
				route: cloudflareRuntimeRoutesV1.effect,
				invoke: () => provider.recoveryFreeze(recoveryRequest),
			},
			{
				family: "control",
				operation: "recovery_freeze",
				route: cloudflareRuntimeRoutesV1.inspect,
				invoke: () => provider.inspectRecoveryFreeze(recoveryRequest),
			},
			{
				family: "control",
				operation: "command_start_reconcile",
				route: cloudflareRuntimeRoutesV1.effect,
				invoke: () => provider.reconcileCommandStart(commandLocator),
			},
			{
				family: "control",
				operation: "command",
				route: cloudflareRuntimeRoutesV1.inspect,
				invoke: () => provider.inspectCommand(commandLocator),
			},
			{
				family: "bridge",
				operation: "write_text_file",
				route: cloudflareRuntimeRoutesV1.effect,
				invoke: () => bridge.writeTextFile(writeRequest),
			},
			{
				family: "bridge",
				operation: "mkdir",
				route: cloudflareRuntimeRoutesV1.effect,
				invoke: () => bridge.mkdir(mkdirRequest),
			},
			{
				family: "bridge",
				operation: "remove",
				route: cloudflareRuntimeRoutesV1.effect,
				invoke: () => bridge.remove(removeRequest),
			},
			{
				family: "bridge",
				operation: "rename",
				route: cloudflareRuntimeRoutesV1.effect,
				invoke: () => bridge.rename(renameRequest),
			},
			{
				family: "bridge",
				operation: "submit_command",
				route: cloudflareRuntimeRoutesV1.effect,
				invoke: () => bridge.submitCommand(commandRequest),
			},
			{
				family: "bridge",
				operation: "cancel_command",
				route: cloudflareRuntimeRoutesV1.effect,
				invoke: () => bridge.cancelCommand(cancelRequest),
			},
			{
				family: "bridge",
				operation: "dispose_command",
				route: cloudflareRuntimeRoutesV1.effect,
				invoke: () => bridge.disposeCommand(disposeRequest),
			},
			{
				family: "bridge",
				operation: "read_text_file",
				route: cloudflareRuntimeRoutesV1.inspect,
				invoke: () =>
					bridge.readTextFile({
						...access,
						path: notesPath,
						line: null,
						limit: null,
						byteLimit: 1_024,
					} as unknown as RuntimeReadTextRequest),
			},
			{
				family: "bridge",
				operation: "read_binary_file",
				route: cloudflareRuntimeRoutesV1.inspect,
				invoke: () =>
					bridge.readBinaryFile({
						...access,
						path: notesPath,
						offset: 0,
						byteLimit: 1_024,
					} as unknown as RuntimeReadBinaryRequest),
			},
			{
				family: "bridge",
				operation: "exists",
				route: cloudflareRuntimeRoutesV1.inspect,
				invoke: () => bridge.exists({ ...access, path: notesPath }),
			},
			{
				family: "bridge",
				operation: "stat",
				route: cloudflareRuntimeRoutesV1.inspect,
				invoke: () => bridge.stat({ ...access, path: notesPath }),
			},
			{
				family: "bridge",
				operation: "list_files",
				route: cloudflareRuntimeRoutesV1.inspect,
				invoke: () =>
					bridge.listFiles({
						...access,
						directory: sourcePath,
						pattern: "**/*",
						limit: 100,
						cursor: null,
					} as unknown as RuntimeListRequest),
			},
			{
				family: "bridge",
				operation: "search_text",
				route: cloudflareRuntimeRoutesV1.inspect,
				invoke: () =>
					bridge.searchText({
						...access,
						path: sourcePath,
						pattern: "needle",
						flags: "",
						limit: 100,
						cursor: null,
					} as unknown as RuntimeSearchRequest),
			},
			{
				family: "bridge",
				operation: "inspect_command",
				route: cloudflareRuntimeRoutesV1.inspect,
				invoke: () => bridge.inspectCommand({ ...access, commandId: commandLocator.commandId }),
			},
		];

		expect(vectors.map(({ family, operation, route }) => ({ family, operation, route }))).toEqual([
			{ family: "control", operation: "renew", route: "/v1/runtime/effect" },
			{ family: "control", operation: "renew", route: "/v1/runtime/inspect" },
			{ family: "control", operation: "recovery_freeze", route: "/v1/runtime/effect" },
			{ family: "control", operation: "recovery_freeze", route: "/v1/runtime/inspect" },
			{ family: "control", operation: "command_start_reconcile", route: "/v1/runtime/effect" },
			{ family: "control", operation: "command", route: "/v1/runtime/inspect" },
			{ family: "bridge", operation: "write_text_file", route: "/v1/runtime/effect" },
			{ family: "bridge", operation: "mkdir", route: "/v1/runtime/effect" },
			{ family: "bridge", operation: "remove", route: "/v1/runtime/effect" },
			{ family: "bridge", operation: "rename", route: "/v1/runtime/effect" },
			{ family: "bridge", operation: "submit_command", route: "/v1/runtime/effect" },
			{ family: "bridge", operation: "cancel_command", route: "/v1/runtime/effect" },
			{ family: "bridge", operation: "dispose_command", route: "/v1/runtime/effect" },
			{ family: "bridge", operation: "read_text_file", route: "/v1/runtime/inspect" },
			{ family: "bridge", operation: "read_binary_file", route: "/v1/runtime/inspect" },
			{ family: "bridge", operation: "exists", route: "/v1/runtime/inspect" },
			{ family: "bridge", operation: "stat", route: "/v1/runtime/inspect" },
			{ family: "bridge", operation: "list_files", route: "/v1/runtime/inspect" },
			{ family: "bridge", operation: "search_text", route: "/v1/runtime/inspect" },
			{ family: "bridge", operation: "inspect_command", route: "/v1/runtime/inspect" },
		]);
		for (const vector of vectors) {
			observed.length = 0;
			await expect(vector.invoke()).rejects.toBeInstanceOf(CloudflareRuntimeProtocolErrorV1);
			expect(observed).toHaveLength(1);
			expect(observed[0]!.path).toBe(vector.route);
			expect(observed[0]!.body).toMatchObject({
				schemaVersion: 1,
				family: vector.family,
				operation: vector.operation,
				replica,
			});
		}
	});

	test("strictly validates the complete supplemental response envelope", async () => {
		const access = {
			operationLeaseId: "operation-lease-client-2",
			workspaceId: replica.workspaceId,
			expectedGeneration: lease.baseGeneration,
			replicaId: replica.replicaId,
			leaseId: lease.leaseId,
			fence: { fenceId: lease.fenceId, token: "client-volatile-token" },
		} as unknown as RuntimeAccessContext;
		const accessTuple = [
			access.operationLeaseId,
			access.workspaceId,
			access.expectedGeneration,
			access.replicaId,
			access.leaseId,
			access.fence.fenceId,
		] as const;
		const strictPath = `${CLOUD_OMP_REMOTE_ROOT}/strict` as PersistentModelWorkspacePath;
		const request = {
			...access,
			requestId: digest("a"),
			requestSha256: await canonicalRuntimeSha256V1([
				"omp-runtime-request-v1",
				"mkdir",
				...accessTuple,
				strictPath,
				true,
			]),
			path: strictPath,
			recursive: true,
		};
		const effectEnvelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "mkdir",
			replica,
			request,
		} as CloudflareRuntimeEffectTransportEnvelopeV1;
		const inspectionEnvelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "exists",
			replica,
			request: { ...access, path: strictPath },
		} as CloudflareRuntimeInspectionTransportEnvelopeV1;
		expect(JSON.parse(await encodeCloudflareRuntimeEffectTransportWireV1(effectEnvelope))).toEqual(effectEnvelope);
		expect(JSON.parse(await encodeCloudflareRuntimeInspectionTransportWireV1(inspectionEnvelope))).toEqual(
			inspectionEnvelope,
		);

		const effectResponse = {
			schemaVersion: 1,
			family: "bridge",
			operation: "mkdir",
			replica,
			result: { status: "created" },
		} as const;
		const inspectionResponse = {
			schemaVersion: 1,
			family: "bridge",
			operation: "exists",
			replica,
			result: false,
		} as const;
		await expect(decodeCloudflareRuntimeEffectTransportResultWireV1(effectResponse, effectEnvelope)).resolves.toEqual(
			effectResponse,
		);
		await expect(
			decodeCloudflareRuntimeInspectionTransportResultWireV1(inspectionResponse, inspectionEnvelope),
		).resolves.toEqual(inspectionResponse);
		await expect(
			decodeCloudflareRuntimeEffectTransportResultWireV1(
				{ ...effectResponse, result: { status: "already_absent" } },
				effectEnvelope,
			),
		).rejects.toMatchObject({ code: "provider_response_invalid" });
		await expect(
			decodeCloudflareRuntimeEffectTransportResultWireV1({ ...effectResponse, extra: true }, effectEnvelope),
		).rejects.toMatchObject({ code: "unknown_fields" });
		await expect(
			decodeCloudflareRuntimeEffectTransportResultWireV1(
				{
					schemaVersion: effectResponse.schemaVersion,
					family: effectResponse.family,
					operation: effectResponse.operation,
					replica: effectResponse.replica,
				},
				effectEnvelope,
			),
		).rejects.toMatchObject({ code: "unknown_fields" });
	});
});
