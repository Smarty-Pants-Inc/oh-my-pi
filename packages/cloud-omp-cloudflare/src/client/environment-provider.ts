import { randomBytes } from "node:crypto";
import {
	type ExecutionEnvironmentProvider,
	type ExecutionEnvironmentReleaseProviderV1,
	type ExecutionEnvironmentRequest,
	type ExecutionEnvironmentRuntimeReleaseAuthorityV1,
	freezeExecutionEnvironmentRuntimeReleaseAuthorityV1,
} from "@oh-my-pi/pi-coding-agent/session/execution-environment";
import {
	canonicalRuntimeProviderInspectionSha256V1,
	canonicalRuntimeSha256,
	deriveProviderSubrequestId,
	type FrozenReplicaCheckpointRef,
	type RuntimeAcquireInspectRequest,
	type RuntimeAcquireInspectResult,
	type RuntimeAcquireRequest,
	type RuntimeAcquireResult,
	type RuntimeCandidate,
	type RuntimeCheckpointAcknowledgeInspectRequest,
	type RuntimeCheckpointAcknowledgeInspectResult,
	type RuntimeCheckpointAcknowledgeRequest,
	type RuntimeCheckpointAcknowledgeResult,
	type RuntimeCheckpointFetchResult,
	type RuntimeCheckpointInspectRequest,
	type RuntimeCheckpointRequest,
	type RuntimeCheckpointResult,
	type RuntimeCommandInspectResult,
	type RuntimeCommandLocator,
	type RuntimeCommandStartReconcileResult,
	type RuntimeFence,
	type RuntimeFrozenCheckpointInspectResult,
	type RuntimeInspectResult,
	type RuntimeLeaseRef,
	type RuntimeLeaseReleaseInspectRequest,
	type RuntimeLeaseReleaseInspectResult,
	type RuntimeLeaseReleaseRequest,
	type RuntimeLeaseReleaseResult,
	type RuntimeLeaseRenewalPlan,
	type RuntimeLeaseRenewalReceipt,
	type RuntimeLeaseRenewInspectResult,
	type RuntimeLeaseRenewRequest,
	type RuntimeProvider,
	type RuntimeProviderDiscoveryProbeResult,
	type RuntimePushInspectRequest,
	type RuntimePushInspectResult,
	type RuntimePushRequest,
	type RuntimePushResult,
	type RuntimeQuiesceInspectRequest,
	type RuntimeQuiesceInspectResult,
	type RuntimeQuiesceRequest,
	type RuntimeQuiesceResult,
	type RuntimeRecoveryFreezeInspectResult,
	type RuntimeRecoveryFreezeRequest,
	type RuntimeRecoveryFreezeResult,
	type RuntimeReplicaCacheEvictionInspectResult,
	type RuntimeReplicaCacheEvictionPlan,
	type RuntimeReplicaCacheEvictionRequest,
	type RuntimeReplicaCacheEvictionRequestResult,
	type RuntimeReplicaDeleteInspectResult,
	type RuntimeReplicaDeleteRequest,
	type RuntimeReplicaDeleteResult,
	type RuntimeReplicaRef,
	type RuntimeRequirements,
	type RuntimeRevokeInspectRequest,
	type RuntimeRevokeInspectResult,
	type RuntimeRevokeRequest,
	type RuntimeRevokeResult,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import {
	CLOUD_OMP_REMOTE_ROOT,
	CLOUD_OMP_WORKSPACE_TTL_MS,
	CLOUDFLARE_WORKSPACE_RETENTION_MS_DEFAULT_V1,
	type CloudflareCheckpointFetchRequestV1,
	type CloudflareRuntimeEffectTransportEnvelopeV1,
	type CloudflareRuntimeEffectTransportResultEnvelopeV1,
	type CloudflareRuntimeInspectionTransportEnvelopeV1,
	type CloudflareRuntimeInspectionTransportResultEnvelopeV1,
	CloudflareRuntimeProtocolErrorV1,
	type CloudflareRuntimeStatusRequestV1,
	cloudflareRuntimeRoutesV1,
	cloudOmpRoutes,
	isWireId,
} from "../protocol";
import { auditErrorCode, CloudOmpAuditWriter, createAuditCorrelationId, hashWorkspaceId } from "./audit";
import { CloudflareEnvironmentBridge, CloudflareRuntimeBridge } from "./environment-bridge";
import { CloudflareEnvironmentLease } from "./environment-lease";
import {
	assertNotAborted,
	bestEffortDelete,
	CloudOmpEnvironmentError,
	decodeCloudflareCheckpointFetchWireV1,
	decodeCloudflareReplicaCacheEvictionResultWireV1,
	decodeCloudflareReplicaDeleteResultWireV1,
	decodeCloudflareRuntimeEffectTransportResultWireV1,
	decodeCloudflareRuntimeInspectionTransportResultWireV1,
	decodeCloudflareRuntimeStatusWireV1,
	elapsedMs,
	encodeCloudflareCheckpointFetchWireV1,
	encodeCloudflareReplicaCacheEvictionWireV1,
	encodeCloudflareReplicaDeleteWireV1,
	encodeCloudflareRuntimeEffectTransportWireV1,
	encodeCloudflareRuntimeInspectionTransportWireV1,
	encodeCloudflareRuntimeStatusWireV1,
	once,
	retryTransportOnce,
	retryWorkspacePutOnce,
	sanitizeEnvironmentError,
	scheduleReleaseAtExpiry,
	validateCreateWorkspaceResponse,
} from "./environment-wire";
import { type CloudOmpHttpClientOptions, type CloudOmpJsonClient, createOrdinaryJsonClient } from "./http";
import { buildCreateWorkspaceRequest, createSeedBundle, type SeedBundle } from "./manifest";

type ProviderId = RuntimeReplicaRef["providerId"];
type ProfileId = RuntimeReplicaRef["profileId"];
type RuntimeLeaseId = RuntimeLeaseRef["leaseId"];

const REMOTE_SENTINEL_PATH = "remote-only.txt";
const REMOTE_SENTINEL_CONTENT = "remote sentinel from cloud-omp fixture\n";
const CONTAINER_INTERNET_ENABLED = true;

const RUNTIME_PROVIDER_ID = "cloudflare" as ProviderId;
const DEFAULT_RUNTIME_PROFILE = "default" as ProfileId;
const COMPATIBILITY_RUNTIME_PROFILE: ProfileId = "execution-environment-v1";

const RUNTIME_CAPABILITIES = Object.freeze([
	"process.exec",
	"workspace.list",
	"workspace.read",
	"workspace.search",
	"workspace.write",
] as const);
const RUNTIME_WORKSPACE_FORMATS = Object.freeze(["omp-text-v1"] as const);

interface CompatibilityLeaseReservation {
	readonly promise: Promise<void>;
	resolve(): void;
}

class CompatibilityLeaseSlot {
	#reservation?: CompatibilityLeaseReservation;

	async acquire(signal?: AbortSignal): Promise<() => void> {
		for (;;) {
			assertNotAborted(signal, "acquire");
			const occupied = this.#reservation;
			if (!occupied) {
				const pending = Promise.withResolvers<void>();
				const reservation: CompatibilityLeaseReservation = {
					promise: pending.promise,
					resolve: () => pending.resolve(),
				};
				this.#reservation = reservation;
				return once(() => {
					if (this.#reservation !== reservation) return;
					this.#reservation = undefined;
					reservation.resolve();
				});
			}
			if (!signal) {
				await occupied.promise;
				continue;
			}
			const aborted = Promise.withResolvers<never>();
			const onAbort = (): void => aborted.reject(new CloudOmpEnvironmentError("abort", "acquire", "ABORTED"));
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			try {
				await Promise.race([occupied.promise, aborted.promise]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		}
	}
}

function sameRuntimeReplica(left: RuntimeReplicaRef, right: RuntimeReplicaRef): boolean {
	return (
		left.providerId === right.providerId &&
		left.profileId === right.profileId &&
		left.replicaId === right.replicaId &&
		left.workspaceId === right.workspaceId
	);
}

function sameReleaseRequest(
	left: RuntimeLeaseReleaseInspectRequest | RuntimeLeaseReleaseRequest,
	right: RuntimeLeaseReleaseInspectRequest,
): boolean {
	return (
		left.requestId === right.requestId &&
		left.requestSha256 === right.requestSha256 &&
		left.parentOperationId === right.parentOperationId &&
		left.leaseId === right.leaseId &&
		sameRuntimeReplica(left.replica, right.replica)
	);
}

async function createCompatibilityReleaseAuthority(input: {
	readonly http: CloudOmpJsonClient;
	readonly workspaceId: string;
	readonly seedRootSha256: string;
	readonly expiresAt: number;
	readonly releaseSlot: () => void;
}): Promise<ExecutionEnvironmentRuntimeReleaseAuthorityV1> {
	const acquiredAtEpochMs = Math.min(Date.now(), input.expiresAt);
	const renewByEpochMs = acquiredAtEpochMs + Math.floor((input.expiresAt - acquiredAtEpochMs) / 2);
	const operationId = await canonicalRuntimeSha256([
		"omp-execution-environment-runtime-v1",
		"legacy-release",
		input.workspaceId,
		input.seedRootSha256,
	]);
	const leaseId = await canonicalRuntimeSha256(["omp-execution-environment-runtime-v1", "lease", operationId]);
	const fenceId = await canonicalRuntimeSha256(["omp-execution-environment-runtime-v1", "fence", operationId]);
	const replica: RuntimeReplicaRef = Object.freeze({
		providerId: RUNTIME_PROVIDER_ID,
		profileId: COMPATIBILITY_RUNTIME_PROFILE,
		replicaId: input.workspaceId,
		workspaceId: input.workspaceId,
	});
	const lease: RuntimeLeaseRef = Object.freeze({
		leaseId,
		replica,
		fenceId,
		baseGeneration: 0,
		renewalSequence: 0,
		acquiredAt: new Date(acquiredAtEpochMs).toISOString(),
		renewBy: new Date(renewByEpochMs).toISOString(),
		expiresAt: new Date(input.expiresAt).toISOString(),
	});
	const fence: RuntimeFence = Object.freeze({ fenceId, token: randomBytes(32).toString("hex") });
	const requestId = await deriveProviderSubrequestId({
		workspaceId: input.workspaceId,
		parentKind: "runtime_transition",
		parentId: operationId,
		ordinal: 0,
		operation: "release",
	});
	const draft = {
		requestId,
		requestSha256: "",
		parentOperationId: operationId,
		replica,
		leaseId,
	};
	const request: RuntimeLeaseReleaseInspectRequest = Object.freeze({
		...draft,
		requestSha256: await canonicalRuntimeProviderInspectionSha256V1({ operation: "release", request: draft }),
	});
	const requestIdentity = Object.freeze({
		requestId: request.requestId,
		requestSha256: request.requestSha256,
		parentOperationId: request.parentOperationId,
	});
	let result: RuntimeLeaseReleaseResult | undefined;
	let releasePromise: Promise<RuntimeLeaseReleaseResult> | undefined;
	let ambiguous = false;
	let releaseStarted = false;
	const complete = (status: RuntimeLeaseReleaseResult["status"]): RuntimeLeaseReleaseResult => {
		result ??= Object.freeze({
			status,
			request: requestIdentity,
			replica,
			leaseId,
			compute: "stopped",
		});
		input.releaseSlot();
		return result;
	};
	const expireAmbiguousRelease = (): void => {
		if (ambiguous && !result) complete("expired");
	};
	const requireRequest = (value: RuntimeLeaseReleaseInspectRequest | RuntimeLeaseReleaseRequest): void => {
		if (!sameReleaseRequest(value, request)) {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
	};
	const provider: ExecutionEnvironmentReleaseProviderV1 = {
		id: RUNTIME_PROVIDER_ID,
		release(value) {
			requireRequest(value);
			if (result) return Promise.resolve(result);
			releaseStarted = true;
			releasePromise ??= (async () => {
				try {
					await retryTransportOnce(() =>
						input.http.requestEmpty({ method: "DELETE", path: cloudOmpRoutes.workspace(input.workspaceId) }),
					);
					return complete("released");
				} catch (error) {
					const failure = sanitizeEnvironmentError(error, value.signal, "release");
					ambiguous = failure.code === "TRANSPORT_FAILURE";
					if (ambiguous) scheduleReleaseAtExpiry(expireAmbiguousRelease, input.expiresAt);
					throw failure;
				}
			})();
			return releasePromise;
		},
		async inspectRelease(value) {
			requireRequest(value);
			if (ambiguous && Date.now() >= input.expiresAt) expireAmbiguousRelease();
			if (result) return { status: "complete", result };
			if (!releaseStarted) {
				return { status: "not_requested", request: requestIdentity, replica, leaseId };
			}
			return {
				status: "in_progress",
				request: requestIdentity,
				replica,
				leaseId,
				compute: "unknown",
				observedAt: new Date().toISOString(),
			};
		},
	};
	return freezeExecutionEnvironmentRuntimeReleaseAuthorityV1({ provider, lease, fence, request });
}

export interface CloudflareRuntimeProviderConfig {
	endpoint: string | URL;
	bearer: string;
	profile?: string;
	workspaceRetentionMs?: number;
}

export interface CloudflareEnvironmentConfig extends CloudflareRuntimeProviderConfig {
	auditPath?: string;
	testRemoteSentinel?: boolean;
}

export interface CloudflareRuntimeProviderDependencies {
	fetch?: typeof globalThis.fetch;
}

/** The only legacy environment test seams: transport injection and deterministic workspace IDs. */
export interface CloudflareEnvironmentDependencies extends CloudflareRuntimeProviderDependencies {
	randomId?: () => string;
}

export function createCloudflareEnvironmentProvider(
	config: CloudflareEnvironmentConfig,
	dependencies: CloudflareEnvironmentDependencies = {},
): ExecutionEnvironmentProvider {
	return new CloudflareEnvironmentProvider(config, dependencies);
}

export function createCloudflareRuntimeProvider(
	config: CloudflareRuntimeProviderConfig,
	dependencies: CloudflareRuntimeProviderDependencies = {},
): RuntimeProvider {
	return new CloudflareRuntimeProvider(config, dependencies);
}

export class CloudflareEnvironmentProvider implements ExecutionEnvironmentProvider {
	readonly #config: Readonly<CloudflareEnvironmentConfig>;
	readonly #http: CloudOmpJsonClient;
	readonly #randomId: () => string;
	readonly #slot = new CompatibilityLeaseSlot();

	constructor(config: CloudflareEnvironmentConfig, dependencies: CloudflareEnvironmentDependencies = {}) {
		this.#config = Object.freeze({
			endpoint: config.endpoint instanceof URL ? config.endpoint.href : config.endpoint,
			bearer: config.bearer,
			...(config.auditPath === undefined ? {} : { auditPath: config.auditPath }),
			testRemoteSentinel: config.testRemoteSentinel === true,
		});
		const httpOptions: CloudOmpHttpClientOptions = {
			endpoint: this.#config.endpoint,
			bearer: this.#config.bearer,
			...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
		};
		this.#http = createOrdinaryJsonClient(httpOptions);
		this.#randomId = dependencies.randomId ?? (() => randomBytes(16).toString("hex"));
		Object.freeze(this);
	}

	async acquire(request: ExecutionEnvironmentRequest) {
		const startedAt = performance.now();
		assertNotAborted(request.signal, "acquire");
		const releaseSlot = await this.#slot.acquire(request.signal);
		let workspaceId = "";
		let workspaceExpiresAt = Date.now() + CLOUD_OMP_WORKSPACE_TTL_MS;
		let audit: CloudOmpAuditWriter | undefined;
		let seed: SeedBundle | undefined;

		try {
			workspaceId = this.#randomId();
			if (!isWireId(workspaceId))
				throw new CloudOmpEnvironmentError("environment", "acquire", "INVALID_GENERATED_ID");
			const correlationId = createAuditCorrelationId();
			audit = new CloudOmpAuditWriter(
				{
					correlationId,
					workspaceIdSha256: hashWorkspaceId(workspaceId),
					taskId: request.taskId,
					runId: request.runId,
					containerInternetEnabled: CONTAINER_INTERNET_ENABLED,
				},
				{ path: this.#config.auditPath },
			);
			seed = await createSeedBundle(request.sourceRoot, request.signal);
			const createRequest = buildCreateWorkspaceRequest(correlationId, seed);
			const response = await retryWorkspacePutOnce(this.#http, workspaceId, createRequest, request.signal);
			workspaceExpiresAt = validateCreateWorkspaceResponse(response, workspaceId);
			const releaseAuthority = await createCompatibilityReleaseAuthority({
				http: this.#http,
				workspaceId,
				seedRootSha256: seed.seedRootSha256,
				expiresAt: workspaceExpiresAt,
				releaseSlot,
			});

			const bridge = new CloudflareEnvironmentBridge(this.#http, workspaceId, audit);
			if (this.#config.testRemoteSentinel) {
				await bridge.writeInternal(REMOTE_SENTINEL_PATH, REMOTE_SENTINEL_CONTENT, request.signal);
			}
			assertNotAborted(request.signal, "acquire");
			await audit.record({
				operation: "acquire",
				durationMs: elapsedMs(startedAt),
				outcome: "success",
				byteCount: seed.totalBytes,
				fileCount: seed.files.length,
				seedRootSha256: seed.seedRootSha256,
				cleanupState: "not_started",
			});

			return new CloudflareEnvironmentLease({
				id: workspaceId,
				sourceRoot: request.sourceRoot,
				bridge,
				http: this.#http,
				audit,
				seedManifest: seed.seedManifest,
				seedRootSha256: seed.seedRootSha256,
				releaseAuthority,
			});
		} catch (error) {
			const cleanupResult = workspaceId ? await bestEffortDelete(this.#http, workspaceId) : "released";
			if (cleanupResult === "released") releaseSlot();
			else if (cleanupResult === "ambiguous") scheduleReleaseAtExpiry(releaseSlot, workspaceExpiresAt);
			if (audit) {
				await audit
					.record({
						operation: "acquire",
						durationMs: elapsedMs(startedAt),
						outcome: request.signal?.aborted ? "cancelled" : "failed",
						...(seed
							? { byteCount: seed.totalBytes, fileCount: seed.files.length, seedRootSha256: seed.seedRootSha256 }
							: {}),
						cleanupState: cleanupResult === "released" ? "completed" : "failed",
						errorCode: auditErrorCode(error),
					})
					.catch(() => {});
			}
			throw sanitizeEnvironmentError(error, request.signal, "acquire");
		}
	}
}

export class CloudflareRuntimeProvider implements RuntimeProvider {
	readonly id = RUNTIME_PROVIDER_ID;
	readonly supportedLocations = Object.freeze(["cloud"] as const);

	readonly #http: CloudOmpJsonClient;
	readonly #candidate: RuntimeCandidate;
	readonly #workspaceRetentionMs: number;

	constructor(config: CloudflareRuntimeProviderConfig, dependencies: CloudflareRuntimeProviderDependencies = {}) {
		const profile = config.profile ?? DEFAULT_RUNTIME_PROFILE;
		if (typeof profile !== "string" || profile.length === 0 || profile.trim() !== profile) {
			throw new TypeError("Cloudflare runtime profile must be a non-empty canonical profile id");
		}
		const workspaceRetentionMs = config.workspaceRetentionMs ?? CLOUDFLARE_WORKSPACE_RETENTION_MS_DEFAULT_V1;
		if (
			!Number.isSafeInteger(workspaceRetentionMs) ||
			Object.is(workspaceRetentionMs, -0) ||
			workspaceRetentionMs <= 0
		) {
			throw new TypeError("Cloudflare workspace retention must be a positive safe integer");
		}
		this.#http = createOrdinaryJsonClient({
			endpoint: config.endpoint,
			bearer: config.bearer,
			...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
		});
		this.#workspaceRetentionMs = workspaceRetentionMs;
		this.#candidate = Object.freeze({
			providerId: this.id,
			profileId: profile as ProfileId,
			location: "cloud",
			capabilities: RUNTIME_CAPABILITIES,
			workspaceFormats: RUNTIME_WORKSPACE_FORMATS,
			os: "linux",
			arch: "x64",
			cpu: 2,
			memoryMiB: 4096,
			network: "egress",
			available: true,
			estimatedIncrementalCostMicrosPerHour: 100,
			estimatedReadyLatencyMs: 1_000,
		});
		Object.freeze(this);
	}

	discoverCandidates(_requirements: RuntimeRequirements): Promise<RuntimeProviderDiscoveryProbeResult> {
		return Promise.resolve({ status: "available", candidates: [this.#candidate] });
	}

	async acquire(request: RuntimeAcquireRequest): Promise<RuntimeAcquireResult> {
		const { signal, ...wireRequest } = request;
		const envelope = { schemaVersion: 1, operation: "acquire", request: wireRequest } as const;
		const response = await this.#effect(envelope, signal);
		if (response.operation !== "acquire") throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		return {
			...response.result,
			binding: Object.freeze({
				lease: response.result.lease,
				fence: request.fence,
				modelRoot: CLOUD_OMP_REMOTE_ROOT,
				bridge: new CloudflareRuntimeBridge(this.#http, response.result.lease),
			}),
		};
	}

	async inspectAcquire(request: RuntimeAcquireInspectRequest): Promise<RuntimeAcquireInspectResult> {
		const envelope = { schemaVersion: 1, operation: "acquire", request } as const;
		const response = await this.#inspection(envelope);
		if (response.operation !== "acquire") throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		return response.result;
	}

	async renew(request: RuntimeLeaseRenewRequest): Promise<RuntimeLeaseRenewalReceipt> {
		const { signal, ...wireRequest } = request;
		const envelope = {
			schemaVersion: 1,
			family: "control",
			operation: "renew",
			replica: wireRequest.plan.expectedLease.replica,
			request: wireRequest,
		} as const;
		const response = await this.#effect(envelope, signal);
		if (!("family" in response) || response.family !== "control" || response.operation !== "renew") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async inspectRenewal(plan: RuntimeLeaseRenewalPlan): Promise<RuntimeLeaseRenewInspectResult> {
		const envelope = {
			schemaVersion: 1,
			family: "control",
			operation: "renew",
			replica: plan.expectedLease.replica,
			request: plan,
		} as const;
		const response = await this.#inspection(envelope);
		if (!("family" in response) || response.family !== "control" || response.operation !== "renew") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async push(request: RuntimePushRequest): Promise<RuntimePushResult> {
		const { signal, ...wireRequest } = request;
		const envelope = { schemaVersion: 1, operation: "push", request: wireRequest } as const;
		const response = await this.#effect(envelope, signal);
		if (response.operation !== "push") throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		return response.result;
	}

	async inspectPush(request: RuntimePushInspectRequest): Promise<RuntimePushInspectResult> {
		const envelope = { schemaVersion: 1, operation: "push", request } as const;
		const response = await this.#inspection(envelope);
		if (response.operation !== "push") throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		return response.result;
	}

	async inspect(request: {
		readonly replica: RuntimeReplicaRef;
		readonly leaseId: RuntimeLeaseId;
		readonly fence: RuntimeFence | null;
	}): Promise<RuntimeInspectResult> {
		const wireRequest: CloudflareRuntimeStatusRequestV1 = {
			schemaVersion: 1,
			replica: request.replica,
			leaseId: request.leaseId,
		};
		const bodyJson = encodeCloudflareRuntimeStatusWireV1(wireRequest);
		const value = await this.#http.requestJson<unknown>({
			method: "POST",
			path: cloudflareRuntimeRoutesV1.status,
			bodyJson,
		});
		return decodeCloudflareRuntimeStatusWireV1(value, wireRequest).result;
	}

	async inspectCommand(request: RuntimeCommandLocator): Promise<RuntimeCommandInspectResult> {
		const envelope = {
			schemaVersion: 1,
			family: "control",
			operation: "command",
			replica: request.replica,
			request,
		} as const;
		const response = await this.#inspection(envelope);
		if (!("family" in response) || response.family !== "control" || response.operation !== "command") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async reconcileCommandStart(request: RuntimeCommandLocator): Promise<RuntimeCommandStartReconcileResult> {
		const envelope = {
			schemaVersion: 1,
			family: "control",
			operation: "command_start_reconcile",
			replica: request.replica,
			request,
		} as const;
		const response = await this.#effect(envelope);
		if (
			!("family" in response) ||
			response.family !== "control" ||
			response.operation !== "command_start_reconcile"
		) {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async quiesce(request: RuntimeQuiesceRequest): Promise<RuntimeQuiesceResult> {
		const { signal, ...wireRequest } = request;
		const envelope = { schemaVersion: 1, operation: "quiesce", request: wireRequest } as const;
		const response = await this.#effect(envelope, signal);
		if (response.operation !== "quiesce") throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		return response.result;
	}

	async inspectQuiesce(request: RuntimeQuiesceInspectRequest): Promise<RuntimeQuiesceInspectResult> {
		const envelope = { schemaVersion: 1, operation: "quiesce", request } as const;
		const response = await this.#inspection(envelope);
		if (response.operation !== "quiesce") throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		return response.result;
	}

	async checkpoint(request: RuntimeCheckpointRequest): Promise<RuntimeCheckpointResult> {
		const { signal, ...wireRequest } = request;
		const envelope = { schemaVersion: 1, operation: "checkpoint", request: wireRequest } as const;
		const response = await this.#effect(envelope, signal);
		if (response.operation !== "checkpoint") throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		return response.result;
	}

	async recoveryFreeze(request: RuntimeRecoveryFreezeRequest): Promise<RuntimeRecoveryFreezeResult> {
		const { signal, ...wireRequest } = request;
		const envelope = {
			schemaVersion: 1,
			family: "control",
			operation: "recovery_freeze",
			replica: wireRequest.locator.replica,
			request: wireRequest,
		} as const;
		const response = await this.#effect(envelope, signal);
		if (!("family" in response) || response.family !== "control" || response.operation !== "recovery_freeze") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async inspectRecoveryFreeze(request: RuntimeRecoveryFreezeRequest): Promise<RuntimeRecoveryFreezeInspectResult> {
		const { signal, ...wireRequest } = request;
		const envelope = {
			schemaVersion: 1,
			family: "control",
			operation: "recovery_freeze",
			replica: wireRequest.locator.replica,
			request: wireRequest,
		} as const;
		const response = await this.#inspection(envelope, signal);
		if (!("family" in response) || response.family !== "control" || response.operation !== "recovery_freeze") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async inspectCheckpoint(request: RuntimeCheckpointInspectRequest): Promise<RuntimeFrozenCheckpointInspectResult> {
		const envelope = { schemaVersion: 1, operation: "checkpoint", request } as const;
		const response = await this.#inspection(envelope);
		if (response.operation !== "checkpoint") throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		return response.result;
	}

	async fetchCheckpoint(request: {
		readonly reference: FrozenReplicaCheckpointRef;
		readonly signal?: AbortSignal;
	}): Promise<RuntimeCheckpointFetchResult> {
		const { reference } = request;
		const wireRequest: CloudflareCheckpointFetchRequestV1 = {
			schemaVersion: 1,
			locator: {
				providerId: reference.providerId,
				profileId: reference.profileId,
				workspaceId: reference.workspaceId,
				replicaId: reference.replicaId,
				leaseId: reference.leaseId,
				checkpointId: reference.checkpointId,
			},
		};
		const bodyJson = encodeCloudflareCheckpointFetchWireV1(wireRequest);
		const value = await this.#http.requestJson<unknown>({
			method: "POST",
			path: cloudflareRuntimeRoutesV1.checkpointFetch,
			bodyJson,
			signal: request.signal,
		});
		return (await decodeCloudflareCheckpointFetchWireV1(value, wireRequest)).result;
	}

	async acknowledgeCheckpoint(
		request: RuntimeCheckpointAcknowledgeRequest,
	): Promise<RuntimeCheckpointAcknowledgeResult> {
		const { signal, ...wireRequest } = request;
		const envelope = { schemaVersion: 1, operation: "checkpoint_acknowledgement", request: wireRequest } as const;
		const response = await this.#effect(envelope, signal);
		if (response.operation !== "checkpoint_acknowledgement") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async inspectCheckpointAcknowledgement(
		request: RuntimeCheckpointAcknowledgeInspectRequest,
	): Promise<RuntimeCheckpointAcknowledgeInspectResult> {
		const envelope = { schemaVersion: 1, operation: "checkpoint_acknowledgement", request } as const;
		const response = await this.#inspection(envelope);
		if (response.operation !== "checkpoint_acknowledgement") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async revoke(request: RuntimeRevokeRequest): Promise<RuntimeRevokeResult> {
		const { signal, ...wireRequest } = request;
		const envelope = { schemaVersion: 1, operation: "revoke", request: wireRequest } as const;
		const response = await this.#effect(envelope, signal);
		if (response.operation !== "revoke") throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		return response.result;
	}

	async inspectRevoke(request: RuntimeRevokeInspectRequest): Promise<RuntimeRevokeInspectResult> {
		const envelope = { schemaVersion: 1, operation: "revoke", request } as const;
		const response = await this.#inspection(envelope);
		if (response.operation !== "revoke") throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		return response.result;
	}

	async release(request: RuntimeLeaseReleaseRequest): Promise<RuntimeLeaseReleaseResult> {
		const { signal, ...wireRequest } = request;
		const envelope = { schemaVersion: 1, operation: "release", request: wireRequest } as const;
		const response = await this.#effect(envelope, signal);
		if (response.operation !== "release") throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		return response.result;
	}

	async inspectRelease(request: RuntimeLeaseReleaseInspectRequest): Promise<RuntimeLeaseReleaseInspectResult> {
		const envelope = { schemaVersion: 1, operation: "release", request } as const;
		const response = await this.#inspection(envelope);
		if (response.operation !== "release") throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		return response.result;
	}

	async requestReplicaCacheEviction(
		request: RuntimeReplicaCacheEvictionRequest,
	): Promise<RuntimeReplicaCacheEvictionRequestResult> {
		const { signal, ...plan } = request;
		const bodyJson = await encodeCloudflareReplicaCacheEvictionWireV1(plan, {
			workspaceRetentionMs: this.#workspaceRetentionMs,
		});
		const value = await this.#http.requestJson<unknown>({
			method: "POST",
			path: cloudflareRuntimeRoutesV1.cacheEviction,
			bodyJson,
			signal,
		});
		return (await decodeCloudflareReplicaCacheEvictionResultWireV1(value, plan, false, {
			workspaceRetentionMs: this.#workspaceRetentionMs,
		})) as RuntimeReplicaCacheEvictionRequestResult;
	}

	async inspectReplicaCacheEviction(
		plan: RuntimeReplicaCacheEvictionPlan,
	): Promise<RuntimeReplicaCacheEvictionInspectResult> {
		const bodyJson = await encodeCloudflareReplicaCacheEvictionWireV1(plan, {
			workspaceRetentionMs: this.#workspaceRetentionMs,
		});
		const value = await this.#http.requestJson<unknown>({
			method: "POST",
			path: cloudflareRuntimeRoutesV1.cacheEvictionInspect,
			bodyJson,
		});
		return (await decodeCloudflareReplicaCacheEvictionResultWireV1(value, plan, true, {
			workspaceRetentionMs: this.#workspaceRetentionMs,
		})) as RuntimeReplicaCacheEvictionInspectResult;
	}

	async deleteReplica(request: RuntimeReplicaDeleteRequest): Promise<RuntimeReplicaDeleteResult> {
		const { signal, ...wireRequest } = request;
		const domain = wireRequest.authorization.domain;
		const bodyJson = await encodeCloudflareReplicaDeleteWireV1(wireRequest, domain);
		const value = await this.#http.requestJson<unknown>({
			method: "POST",
			path: cloudflareRuntimeRoutesV1.replicaDelete,
			bodyJson,
			signal,
		});
		return (await decodeCloudflareReplicaDeleteResultWireV1(
			value,
			wireRequest,
			false,
			domain,
		)) as RuntimeReplicaDeleteResult;
	}

	async inspectReplicaDeletion(request: RuntimeReplicaDeleteRequest): Promise<RuntimeReplicaDeleteInspectResult> {
		const { signal, ...wireRequest } = request;
		const domain = wireRequest.authorization.domain;
		const bodyJson = await encodeCloudflareReplicaDeleteWireV1(wireRequest, domain);
		const value = await this.#http.requestJson<unknown>({
			method: "POST",
			path: cloudflareRuntimeRoutesV1.replicaDeleteInspect,
			bodyJson,
			signal,
		});
		return (await decodeCloudflareReplicaDeleteResultWireV1(
			value,
			wireRequest,
			true,
			domain,
		)) as RuntimeReplicaDeleteInspectResult;
	}

	async #effect(
		envelope: CloudflareRuntimeEffectTransportEnvelopeV1,
		signal?: AbortSignal,
	): Promise<CloudflareRuntimeEffectTransportResultEnvelopeV1> {
		const bodyJson = await encodeCloudflareRuntimeEffectTransportWireV1(envelope);
		const value = await this.#http.requestJson<unknown>({
			method: "POST",
			path: cloudflareRuntimeRoutesV1.effect,
			bodyJson,
			signal,
		});
		return decodeCloudflareRuntimeEffectTransportResultWireV1(value, envelope);
	}

	async #inspection(
		envelope: CloudflareRuntimeInspectionTransportEnvelopeV1,
		signal?: AbortSignal,
	): Promise<CloudflareRuntimeInspectionTransportResultEnvelopeV1> {
		const bodyJson = await encodeCloudflareRuntimeInspectionTransportWireV1(envelope);
		const value = await this.#http.requestJson<unknown>({
			method: "POST",
			path: cloudflareRuntimeRoutesV1.inspect,
			bodyJson,
			signal,
		});
		return decodeCloudflareRuntimeInspectionTransportResultWireV1(value, envelope);
	}
}
