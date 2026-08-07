import type {
	CanonicalWorkspaceCommitReceipt,
	FrozenReplicaCheckpointLocator,
	FrozenReplicaCheckpointRef,
	PersistentModelWorkspacePath,
	RuntimeAccessContext,
	RuntimeAcquireInspectResult,
	RuntimeAcquireRequest,
	RuntimeAcquireResult,
	RuntimeCheckpointAcknowledgeInspectResult,
	RuntimeCheckpointAcknowledgeRequest,
	RuntimeCheckpointAcknowledgeResult,
	RuntimeCheckpointRequest,
	RuntimeCheckpointResult,
	RuntimeCommandInspectResult,
	RuntimeCommandLocator,
	RuntimeCommandRequest,
	RuntimeCommandSnapshot,
	RuntimeCommandStartReconcileResult,
	RuntimeFence,
	RuntimeFileStat,
	RuntimeFrozenCheckpointInspectResult,
	RuntimeInspectResult,
	RuntimeLeaseRef,
	RuntimeLeaseReleaseInspectResult,
	RuntimeLeaseReleaseRequest,
	RuntimeLeaseReleaseResult,
	RuntimeLeaseRenewalPlan,
	RuntimeLeaseRenewalReceipt,
	RuntimeLeaseRenewInspectResult,
	RuntimeListRequest,
	RuntimeListResult,
	RuntimeMutationContext,
	RuntimePushInspectResult,
	RuntimePushRequest,
	RuntimePushResult,
	RuntimeQuiesceInspectResult,
	RuntimeQuiesceRequest,
	RuntimeQuiesceResult,
	RuntimeReadBinaryRequest,
	RuntimeReadBinaryResult,
	RuntimeReadTextRequest,
	RuntimeReadTextResult,
	RuntimeRecoveryFreezeInspectResult,
	RuntimeRecoveryFreezeRequest,
	RuntimeRecoveryFreezeResult,
	RuntimeReplicaCacheEvictionDeferredReason,
	RuntimeReplicaCacheEvictionInspectResult,
	RuntimeReplicaCacheEvictionPlan,
	RuntimeReplicaCacheEvictionRequestResult,
	RuntimeReplicaDeleteInspectResult,
	RuntimeReplicaDeleteResult,
	RuntimeReplicaDeletionAuthorizationV1,
	RuntimeReplicaRef,
	RuntimeRevokeInspectResult,
	RuntimeRevokeRequest,
	RuntimeRevokeResult,
	RuntimeSearchRequest,
	RuntimeSearchResult,
	RuntimeWriteResult,
	RuntimeWriteTextRequest,
	WorkspaceImage,
	WorkspaceSnapshot,
	WorkspaceTombstone,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import {
	CLOUD_OMP_REMOTE_ROOT,
	CLOUD_OMP_WORKSPACE_TTL_MS,
	CLOUDFLARE_ALARM_BATCH_LIMIT_V1,
	CLOUDFLARE_WORKSPACE_RETENTION_MS_DEFAULT_V1,
	type CloudflareCheckpointFetchResponseV1,
	type CloudflareDurableDeadlineV1,
	type CloudflareReplicaDeletionValidationV1,
	type CloudflareRuntimeEffectResultEnvelopeV1,
	type CloudflareRuntimeEffectTransportEnvelopeV1,
	type CloudflareRuntimeEffectTransportResultEnvelopeV1,
	type CloudflareRuntimeInspectionResultEnvelopeV1,
	type CloudflareRuntimeInspectionTransportEnvelopeV1,
	type CloudflareRuntimeInspectionTransportResultEnvelopeV1,
	type CloudflareRuntimeStatusResponseV1,
	type CloudflareValidatedRuntimeEffectTransportV1,
	type CloudflareValidatedRuntimeInspectionTransportV1,
	type CloudflareValidatedRuntimeOperationV1,
	type CreateWorkspaceRequest,
	type CreateWorkspaceResponse,
	canonicalRuntimeSha256V1,
	decodeCloudflareCheckpointFetchRequestV1,
	decodeCloudflareDurableDeadlineV1,
	decodeCloudflareReplicaCacheEvictionPlanV1,
	decodeCloudflareReplicaDeleteRequestV1,
	decodeCloudflareRuntimeEffectEnvelopeV1,
	decodeCloudflareRuntimeEffectTransportEnvelopeV1,
	decodeCloudflareRuntimeInspectionEnvelopeV1,
	decodeCloudflareRuntimeInspectionTransportEnvelopeV1,
	decodeCloudflareRuntimeSearchCursorV1,
	decodeCloudflareRuntimeStatusRequestV1,
	deferCloudflareWorkspaceRetentionDeadlineV1,
	type ExecCreateResponse,
	type ExecRequest,
	type ExecSnapshot,
	encodeCloudflareRuntimeSearchCursorV1,
	type FilePayload,
	type FileReadRequest,
	MAX_COMMAND_BYTES,
	MAX_COMMAND_TIMEOUT_MS,
	MAX_EXEC_OUTPUT_BYTES,
	MAX_SYNC_FILE_BYTES,
	MAX_SYNC_FILE_COUNT,
	MAX_SYNC_TOTAL_BYTES,
	type ManifestResponse,
	projectCloudflareReplicaCacheEvictionTupleV1,
	projectCloudflareReplicaDeleteReceiptTupleV1,
	type WorkspacePhase,
	type WorkspaceState,
} from "../protocol";
import { WorkspaceObjectError } from "./errors";
import { ExecutionSupervisor, type WorkspaceLike } from "./execution-supervisor";
import type { SQLiteRetryScheduler, WorkspaceAlarmCoordinator } from "./retry-scheduler";
import {
	hashWorkspaceId,
	type WorkspaceAuditContext,
	type WorkspaceAuditEvent,
	type WorkspaceAuditSink,
	workspaceAuditErrorCode,
	workspaceAuditOutcomeForError,
} from "./workspace-audit";
import {
	canonicalWorkspaceDirectory,
	compareUtf8,
	enumerateManifest,
	enumerateWorkspaceSnapshotFiles,
	freezeReplicaCheckpoint,
	manifestRootSha256,
	materializeWorkspaceSnapshot,
	purgeRuntimeWorkspaceBytes,
	readFilePayload,
	readRuntimeFileBytes,
	requireSafeDirectory,
	requireSafeFilePath,
	resolveWorkspacePathNoSymlinkAncestors,
	runtimeRelativePath,
	searchWorkspaceText,
	sha256Hex,
	validateManifestEntries,
	validatePayload,
	type WorkspaceFilesystemLike,
	type WorkspaceStatLike,
} from "./workspace-files";
import { WorkspaceMutationFence } from "./workspace-mutation-fence";
import type {
	RuntimeReplicaState,
	RuntimeRequestState,
	WorkspaceRow,
	WorkspaceStateStore,
} from "./workspace-state-store";

export type {
	RuntimeEvent,
	RuntimeHandle,
	RuntimeLike,
	RuntimeResult,
	WorkspaceLike,
} from "./execution-supervisor";

const DEFAULT_CLEANUP_TIMEOUT_MS = MAX_COMMAND_TIMEOUT_MS;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ContainerLike {
	restart(env: Record<string, string>): Promise<void>;
	status(): Promise<{ running: boolean; exit: { reason: string } | null }>;
	destroy(): Promise<void>;
	readonly running?: boolean;
}

export interface WorkspaceRuntimeOptions {
	store: WorkspaceStateStore;
	workspace: WorkspaceLike;
	container: ContainerLike;
	retryScheduler: SQLiteRetryScheduler;
	alarms: WorkspaceAlarmCoordinator;
	audit: WorkspaceAuditSink;
	now?: () => number;
	randomId?: () => string;
	waitUntil?: (promise: Promise<unknown>) => void;
	sleep?: (milliseconds: number) => Promise<void>;
	cleanupTimeoutMs?: number;
	containerRunning?: () => boolean;
	workspaceRetentionMs?: number;
}

export class WorkspaceObjectRuntime {
	readonly #store: WorkspaceStateStore;
	readonly #workspace: WorkspaceLike;
	readonly #container: ContainerLike;
	readonly #alarms: WorkspaceAlarmCoordinator;
	readonly #audit: WorkspaceAuditSink;
	readonly #supervisor: ExecutionSupervisor;
	readonly #mutations = new WorkspaceMutationFence();
	readonly #now: () => number;
	readonly #cleanupTimeoutMs: number;
	readonly #sleep: (milliseconds: number) => Promise<void>;
	readonly #containerRunning: () => boolean;
	readonly #workspaceRetentionMs: number;
	#restartPromise: Promise<void> | undefined;
	#releasePromise: Promise<void> | undefined;
	#closePromise: Promise<void> | undefined;
	#createPromise: Promise<CreateWorkspaceResponse> | undefined;

	constructor(options: WorkspaceRuntimeOptions) {
		this.#store = options.store;
		this.#workspace = options.workspace;
		this.#container = options.container;
		this.#alarms = options.alarms;
		this.#audit = options.audit;
		this.#now = options.now ?? Date.now;
		this.#alarms.setClock(this.#now);
		this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
		this.#containerRunning = options.containerRunning ?? (() => options.container.running === true);
		this.#workspaceRetentionMs = requiredInteger(
			options.workspaceRetentionMs ?? CLOUDFLARE_WORKSPACE_RETENTION_MS_DEFAULT_V1,
			1,
		);
		this.#sleep =
			options.sleep ??
			(milliseconds => {
				const delay = Promise.withResolvers<void>();
				setTimeout(delay.resolve, milliseconds);
				return delay.promise;
			});
		this.#supervisor = new ExecutionSupervisor({
			store: options.store,
			workspace: options.workspace,
			retryScheduler: options.retryScheduler,
			alarms: options.alarms,
			audit: options.audit,
			now: this.#now,
			randomId: options.randomId ?? randomHex128,
			waitUntil: options.waitUntil ?? (() => undefined),
		});
	}

	async initialize(): Promise<void> {
		this.#store.initialize();
		await this.#alarms.rearm();
	}

	async createWorkspace(clientWorkspaceId: string, request: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse> {
		if (!/^[0-9a-f]{32}$/.test(clientWorkspaceId)) {
			throw new WorkspaceObjectError(
				400,
				"invalid_workspace_id",
				"Workspace ID must be 128-bit lowercase hexadecimal",
			);
		}
		if (!/^[0-9a-f]{32}$/.test(request.auditCorrelationId)) {
			throw new WorkspaceObjectError(400, "audit_correlation_id_invalid", "Audit correlation ID is malformed");
		}
		if (!/^[0-9a-f]{64}$/.test(request.seedRootSha256) || request.files.length > MAX_SYNC_FILE_COUNT) {
			throw new WorkspaceObjectError(400, "invalid_seed", "Workspace seed metadata is invalid");
		}

		const validated: Array<{ entry: FilePayload; bytes: Uint8Array }> = [];
		let totalBytes = 0;
		for (const payload of request.files) {
			const file = await validatePayload(payload);
			totalBytes += file.bytes.byteLength;
			if (totalBytes > MAX_SYNC_TOTAL_BYTES) {
				throw new WorkspaceObjectError(400, "seed_too_large", "Workspace seed exceeds the total-byte cap");
			}
			validated.push({ entry: { ...file.entry, contentBase64: payload.contentBase64 }, bytes: file.bytes });
		}
		validateManifestEntries(validated.map(file => file.entry));
		if ((await manifestRootSha256(validated.map(file => file.entry))) !== request.seedRootSha256) {
			throw new WorkspaceObjectError(
				422,
				"seed_digest_mismatch",
				"Workspace seed root digest does not match the manifest",
			);
		}

		const workspaceIdSha256 = await hashWorkspaceId(clientWorkspaceId);
		const auditContext = { auditCorrelationId: request.auditCorrelationId, workspaceIdSha256 };
		const startedAt = this.#now();
		const existing = this.#store.workspace();
		if (existing) {
			if (existing.phase === "released" || this.#now() >= existing.expiresAt) {
				await this.#expireIfDue(existing);
				throw new WorkspaceObjectError(410, "workspace_gone", "Workspace has expired or been released");
			}
			if (
				existing.workspaceIdSha256 !== workspaceIdSha256 ||
				existing.seedDigest !== request.seedRootSha256 ||
				existing.auditCorrelationId !== request.auditCorrelationId
			) {
				throw new WorkspaceObjectError(
					409,
					"workspace_seed_conflict",
					"Workspace ID is already bound to different creation metadata",
				);
			}
			if (existing.seedComplete) {
				this.#audit.record(auditContext, {
					operation: "acquire",
					durationMs: Math.max(0, this.#now() - startedAt),
					outcome: "success",
					byteCount: totalBytes,
					fileCount: validated.length,
					cleanupState: "not_started",
				});
				return this.#createResponse(clientWorkspaceId, existing);
			}
		}
		if (this.#createPromise) return this.#createPromise;
		const creation = this.#seedWorkspace(
			clientWorkspaceId,
			workspaceIdSha256,
			request.auditCorrelationId,
			request.seedRootSha256,
			validated,
			totalBytes,
			existing,
		).finally(() => {
			if (this.#createPromise === creation) this.#createPromise = undefined;
		});
		this.#createPromise = creation;
		return creation;
	}

	async readFile(request: FileReadRequest): Promise<FilePayload> {
		const startedAt = this.#now();
		const context = this.#auditContext(await this.#requireOperational(["active", "quiesced"]));
		try {
			this.#supervisor.assertNoActive();
			const payload = await readFilePayload(this.#workspace.fs, request.path);
			await this.#requireOperational(["active", "quiesced"]);
			this.#supervisor.assertNoActive();
			this.#audit.record(context, {
				operation: "read",
				durationMs: Math.max(0, this.#now() - startedAt),
				outcome: "success",
				byteCount: payload.byteLength,
				fileCount: 1,
			});
			return payload;
		} catch (error) {
			this.#auditFailure(context, "read", startedAt, error);
			throw error;
		}
	}

	async writeFile(request: FilePayload): Promise<FilePayload> {
		const startedAt = this.#now();
		const state = await this.#requireOperational(["active"]);
		const context = this.#auditContext(state);
		const mutation = this.#mutations.enter(state.mutationGeneration);
		try {
			this.#supervisor.assertNoActive();
			const validated = await validatePayload(request);
			this.#requireMutationCurrent(mutation.generation);
			this.#supervisor.assertNoActive();
			const absolute = await requireSafeFilePath(this.#workspace.fs, validated.entry.path, true);
			this.#requireMutationCurrent(mutation.generation);
			this.#supervisor.assertNoActive();
			await this.#workspace.fs.writeFile(absolute, validated.bytes);
			this.#requireMutationCurrent(mutation.generation);
			this.#supervisor.assertNoActive();
			const written = await readFilePayload(this.#workspace.fs, validated.entry.path);
			this.#requireMutationCurrent(mutation.generation);
			this.#supervisor.assertNoActive();
			this.#audit.record(context, {
				operation: "write",
				durationMs: Math.max(0, this.#now() - startedAt),
				outcome: "success",
				byteCount: written.byteLength,
				fileCount: 1,
			});
			return written;
		} catch (error) {
			this.#auditFailure(context, "write", startedAt, error);
			throw error;
		} finally {
			mutation.release();
		}
	}

	async getManifest(): Promise<ManifestResponse> {
		await this.#requireOperational(["active", "quiesced"]);
		this.#supervisor.assertNoActive();
		this.#supervisor.assertSyncSettled();
		const manifest = await enumerateManifest(this.#workspace.fs);
		const after = await this.#requireOperational(["active", "quiesced"]);
		this.#supervisor.assertNoActive();
		this.#supervisor.assertSyncSettled();
		return { phase: after.phase, rootSha256: manifest.rootSha256, files: manifest.entries };
	}

	async createExec(request: ExecRequest): Promise<ExecCreateResponse> {
		const state = await this.#requireOperational(["active"]);
		const mutation = this.#mutations.enter(state.mutationGeneration);
		try {
			if (typeof request.source !== "string") {
				throw new WorkspaceObjectError(
					400,
					"invalid_command",
					"Command must be non-empty strict UTF-8 within the command cap",
				);
			}
			const sourceBytes = encoder.encode(request.source);
			if (
				request.source.length === 0 ||
				request.source.includes("\0") ||
				sourceBytes.byteLength > MAX_COMMAND_BYTES ||
				decoder.decode(sourceBytes) !== request.source
			) {
				throw new WorkspaceObjectError(
					400,
					"invalid_command",
					"Command must be non-empty strict UTF-8 within the command cap",
				);
			}
			if (
				!Number.isInteger(request.timeoutMs) ||
				request.timeoutMs < 1 ||
				request.timeoutMs > MAX_COMMAND_TIMEOUT_MS
			) {
				throw new WorkspaceObjectError(400, "invalid_timeout", "Command timeout is outside the supported range");
			}
			if (
				!Number.isInteger(request.outputByteLimit) ||
				request.outputByteLimit < 1 ||
				request.outputByteLimit > MAX_EXEC_OUTPUT_BYTES
			) {
				throw new WorkspaceObjectError(
					400,
					"invalid_output_limit",
					"Output byte limit is outside the supported range",
				);
			}
			const cwd = canonicalWorkspaceDirectory(request.cwd);
			await requireSafeDirectory(this.#workspace.fs, cwd);
			this.#requireMutationCurrent(mutation.generation);
			return await this.#supervisor.createExec(request, cwd, mutation.generation);
		} finally {
			mutation.release();
		}
	}

	async getExec(execId: string): Promise<ExecSnapshot> {
		await this.#requireOperational(["active"]);
		return this.#supervisor.getExec(execId);
	}

	async killExec(execId: string): Promise<ExecSnapshot> {
		await this.#requireOperational(["active"]);
		return this.#supervisor.killExec(execId);
	}

	async deleteExec(execId: string): Promise<void> {
		await this.#requireOperational(["active"]);
		await this.#supervisor.deleteExec(execId);
	}

	async quiesce(): Promise<WorkspaceState> {
		const startedAt = this.#now();
		const state = await this.#requireOperational(["active", "quiescing", "quiesced"]);
		const context = this.#auditContext(state);
		try {
			if (state.phase === "quiesced") return this.#supervisor.stateSnapshot(state.phase);
			if (state.phase === "active") {
				this.#supervisor.assertNoActive();
				this.#supervisor.assertSyncSettled();
				this.#store.beginQuiesce();
			}
			await this.#restartAndWait();
			this.#supervisor.assertNoActive();
			this.#supervisor.assertSyncSettled();
			const quiesced = this.#store.finishQuiesce();
			if (quiesced?.phase === "released" || quiesced?.cleanupReason) {
				throw new WorkspaceObjectError(410, "workspace_gone", "Workspace cleanup took precedence over quiesce");
			}
			if (quiesced?.phase !== "quiesced") {
				throw new WorkspaceObjectError(409, "quiesce_incomplete", "Workspace did not reach the quiesced phase");
			}
			const snapshot = this.#supervisor.stateSnapshot(quiesced.phase);
			this.#audit.record(context, {
				operation: "quiesce",
				durationMs: Math.max(0, this.#now() - startedAt),
				outcome: "success",
				...stateCounts(snapshot),
			});
			return snapshot;
		} catch (error) {
			this.#auditFailure(context, "quiesce", startedAt, error);
			throw error;
		}
	}

	async restartForTest(): Promise<WorkspaceState> {
		const startedAt = this.#now();
		const state = await this.#requireOperational(["active"]);
		const context = this.#auditContext(state);
		try {
			this.#supervisor.assertNoActive();
			this.#store.beginRestart();
			try {
				await this.#restartAndWait();
			} finally {
				this.#store.finishRestart();
			}
			const restarted = this.#store.workspace();
			if (restarted?.phase !== "active") {
				throw new WorkspaceObjectError(409, "restart_superseded", "Workspace restart was superseded by cleanup");
			}
			const snapshot = this.#supervisor.stateSnapshot(restarted.phase);
			this.#audit.record(context, {
				operation: "restart",
				durationMs: Math.max(0, this.#now() - startedAt),
				outcome: "success",
				...stateCounts(snapshot),
			});
			return snapshot;
		} catch (error) {
			this.#auditFailure(context, "restart", startedAt, error);
			throw error;
		}
	}

	async release(): Promise<void> {
		const state = this.#store.workspace();
		if (!state || state.phase === "released") return;
		if (this.#now() >= state.expiresAt) await this.#expireIfDue(state);
		else await this.#releaseInternal("release");
	}

	async applyRuntimeEffect(input: unknown): Promise<CloudflareRuntimeEffectResultEnvelopeV1> {
		const validated = await this.#decodeRuntimeEffect(input);
		const reservation = this.#reserveValidatedRuntimeRequest(validated);
		if (reservation.state === "complete") {
			return {
				schemaVersion: 1,
				operation: validated.operation,
				result: reservation.result,
			} as CloudflareRuntimeEffectResultEnvelopeV1;
		}
		const result = await this.#applyValidatedRuntimeEffect(validated);
		this.#store.completeRuntimeRequest(validated.requestId, result, this.#now());
		return { schemaVersion: 1, operation: validated.operation, result } as CloudflareRuntimeEffectResultEnvelopeV1;
	}

	async inspectRuntimeOperation(input: unknown): Promise<CloudflareRuntimeInspectionResultEnvelopeV1> {
		const validated = await this.#decodeRuntimeInspection(input);
		const result = this.#inspectValidatedRuntimeOperation(validated);
		return {
			schemaVersion: 1,
			operation: validated.operation,
			result,
		} as CloudflareRuntimeInspectionResultEnvelopeV1;
	}

	async applyRuntimeControlEffect(
		input: CloudflareRuntimeEffectTransportEnvelopeV1,
	): Promise<CloudflareRuntimeEffectTransportResultEnvelopeV1> {
		let validated: CloudflareValidatedRuntimeEffectTransportV1;
		try {
			validated = await decodeCloudflareRuntimeEffectTransportEnvelopeV1(input);
		} catch (error) {
			throw protocolObjectError(error);
		}
		if (validated.transportFamily !== "control") {
			throw new WorkspaceObjectError(400, "protocol_invalid", "Runtime control effect envelope is invalid");
		}
		let result: unknown;
		switch (validated.operation) {
			case "renew":
				result = await this.renewRuntimeLease({
					plan: validated.request.plan,
					fence: validated.request.fence,
					canonicalTupleUtf8: validated.canonicalTupleUtf8,
				});
				break;
			case "recovery_freeze":
				result = await this.recoveryFreezeRuntime({
					request: validated.request,
					canonicalTupleUtf8: validated.canonicalTupleUtf8,
				});
				break;
			case "command_start_reconcile":
				result = await this.reconcileRuntimeCommandStart(validated.request);
				break;
		}
		return {
			schemaVersion: 1,
			family: "control",
			operation: validated.operation,
			replica: validated.replica,
			result,
		} as CloudflareRuntimeEffectTransportResultEnvelopeV1;
	}

	async inspectRuntimeControl(
		input: CloudflareRuntimeInspectionTransportEnvelopeV1,
	): Promise<CloudflareRuntimeInspectionTransportResultEnvelopeV1> {
		let validated: CloudflareValidatedRuntimeInspectionTransportV1;
		try {
			validated = await decodeCloudflareRuntimeInspectionTransportEnvelopeV1(input);
		} catch (error) {
			throw protocolObjectError(error);
		}
		if (validated.transportFamily !== "control") {
			throw new WorkspaceObjectError(400, "protocol_invalid", "Runtime control inspection envelope is invalid");
		}
		let result: unknown;
		switch (validated.operation) {
			case "renew":
				result = await this.inspectRuntimeRenewal({
					plan: validated.request,
					canonicalTupleUtf8: validated.canonicalTupleUtf8,
				});
				break;
			case "recovery_freeze":
				result = await this.inspectRuntimeRecoveryFreeze({
					request: validated.request,
					canonicalTupleUtf8: validated.canonicalTupleUtf8,
				});
				break;
			case "command":
				result = await this.inspectRuntimeCommand(validated.request);
				break;
		}
		return {
			schemaVersion: 1,
			family: "control",
			operation: validated.operation,
			replica: validated.replica,
			result,
		} as CloudflareRuntimeInspectionTransportResultEnvelopeV1;
	}

	inspectRuntimeStatus(input: unknown): CloudflareRuntimeStatusResponseV1 {
		const request = decodeCloudflareRuntimeStatusRequestV1(input);
		const state = this.#store.runtimeReplica();
		const containerRunning = this.#containerRunning();
		let result: RuntimeInspectResult;
		if (!state || !sameJson(state.replica, request.replica) || state.lease.leaseId !== request.leaseId) {
			result = { status: "absent", replica: request.replica, leaseId: request.leaseId };
		} else if (state.tombstone) {
			result = {
				status: "tombstoned",
				tombstone: state.tombstone.tombstone ?? deletionTombstone(state.tombstone.authorization),
			};
		} else {
			result = {
				status: "present",
				lease: state.lease,
				providerPhase: state.providerPhase,
				compute: containerRunning ? "running" : "stopped",
				activeCommands: this.#store.runtimeActiveCommandCount(),
				pendingSyncs: this.#store.runtimePendingSyncCount(),
				replicaImage: state.replicaImage,
			};
		}
		return {
			schemaVersion: 1,
			observationSource: "durable_state_and_container_running_only",
			containerRunning,
			result,
			deadlines: this.#store.runtimeDeadlineSummary(),
		};
	}

	fetchRuntimeCheckpoint(input: unknown): CloudflareCheckpointFetchResponseV1 {
		const request = decodeCloudflareCheckpointFetchRequestV1(input);
		const stored = this.#store.runtimeCheckpoint(request.locator.checkpointId);
		if (!stored || !sameJson(stored.locator, request.locator) || stored.checkpoint === null) {
			throw new WorkspaceObjectError(404, "protocol_invalid", "Frozen runtime checkpoint is unavailable");
		}
		return { schemaVersion: 1, result: { status: "fetched", checkpoint: stored.checkpoint } };
	}

	async #applyValidatedRuntimeEffect(validated: CloudflareValidatedRuntimeOperationV1): Promise<unknown> {
		switch (validated.operation) {
			case "acquire":
				return this.#runtimeAcquire(validated, validated.envelope.request as RuntimeAcquireRequest);
			case "push":
				return this.#runtimePush(validated, validated.envelope.request as RuntimePushRequest);
			case "quiesce":
				return this.#runtimeQuiesce(validated, validated.envelope.request as RuntimeQuiesceRequest);
			case "checkpoint":
				return this.#runtimeCheckpoint(validated, validated.envelope.request as RuntimeCheckpointRequest);
			case "revoke":
				return this.#runtimeRevoke(validated, validated.envelope.request as RuntimeRevokeRequest);
			case "checkpoint_acknowledgement":
				return this.#runtimeCheckpointAcknowledgement(
					validated,
					validated.envelope.request as RuntimeCheckpointAcknowledgeRequest,
				);
			case "release":
				return this.#runtimeLeaseRelease(validated, validated.envelope.request as RuntimeLeaseReleaseRequest);
		}
	}

	async #runtimeAcquire(
		validated: CloudflareValidatedRuntimeOperationV1,
		request: RuntimeAcquireRequest,
	): Promise<Omit<RuntimeAcquireResult, "binding">> {
		const now = this.#now();
		const existing = this.#store.runtimeReplica();
		if (existing?.tombstone) throw new WorkspaceObjectError(410, "workspace_gone", "Runtime replica is tombstoned");
		if (existing) {
			if (
				!sameJson(existing.replica, request.plan.replica) ||
				existing.lease.leaseId !== request.plan.leaseId ||
				existing.deletionAuthorityDomain !== request.plan.deletionAuthorityDomain
			) {
				throw new WorkspaceObjectError(
					409,
					"request_conflict",
					"Runtime replica reservation conflicts with existing state",
				);
			}
			if (existing.providerPhase !== "reserved" || now >= Date.parse(existing.lease.expiresAt)) {
				throw new WorkspaceObjectError(
					409,
					"invalid_workspace_phase",
					"Runtime replica reservation is no longer acquirable",
				);
			}
			await this.#requireRuntimeFence(existing, request.fence);
			return {
				status: "already_acquired",
				request: transitionRequestEcho(validated),
				lease: existing.lease,
				providerPhase: "reserved",
				deletionAuthorityDomain: existing.deletionAuthorityDomain,
			};
		}
		const expiresAtEpochMs = checkedEpochAdd(now, request.plan.leaseTtlMs);
		const lease = {
			leaseId: request.plan.leaseId,
			replica: request.plan.replica,
			fenceId: request.plan.fenceId,
			baseGeneration: request.plan.baseCheckpoint.generation,
			renewalSequence: 0,
			acquiredAt: iso(now),
			renewBy: iso(checkedEpochAdd(now, Math.max(1, Math.floor(request.plan.leaseTtlMs / 2)))),
			expiresAt: iso(expiresAtEpochMs),
		} as const;
		const fenceVerifierSha256 = await fenceVerifier(request.fence.fenceId, request.fence.token);
		this.#store.saveRuntimeReplica({
			replica: request.plan.replica,
			lease,
			fenceVerifierSha256,
			deletionAuthorityDomain: request.plan.deletionAuthorityDomain,
			providerPhase: "reserved",
			replicaImage: null,
			admissionClosed: false,
			tombstone: null,
			updatedAtEpochMs: now,
		});
		this.#store.putRuntimeDeadline({
			schemaVersion: 1,
			kind: "runtime_expiry",
			key: request.plan.leaseId,
			dueAtEpochMs: expiresAtEpochMs,
			attempt: 0,
			updatedAtEpochMs: now,
		});
		await this.#alarms.rearm(now);
		return {
			status: "acquired",
			request: transitionRequestEcho(validated),
			lease,
			providerPhase: "reserved",
			deletionAuthorityDomain: request.plan.deletionAuthorityDomain,
		};
	}

	async #runtimePush(
		validated: CloudflareValidatedRuntimeOperationV1,
		request: RuntimePushRequest,
	): Promise<RuntimePushResult> {
		let state = await this.#requireRuntimeLeaseAndFence(request.lease, request.fence);
		if (state.replicaImage) {
			const image = imageFromSnapshot(request.snapshot);
			if (!sameJson(state.replicaImage, image)) {
				throw new WorkspaceObjectError(
					409,
					"request_conflict",
					"Runtime replica is materialized with different bytes",
				);
			}
			return {
				status: "already_materialized",
				request: transitionRequestEcho(validated),
				replica: state.replica,
				canonicalGeneration: request.lease.baseGeneration,
				...image,
			};
		}
		if (state.providerPhase !== "reserved" && state.providerPhase !== "materializing") {
			throw new WorkspaceObjectError(
				409,
				"invalid_workspace_phase",
				"Runtime replica cannot be materialized in its current phase",
			);
		}
		this.#store.markRuntimeRequestOutcomeUnknown(validated.requestId, this.#now());
		state = this.#store.saveRuntimeReplica({
			...state,
			providerPhase: "materializing",
			updatedAtEpochMs: this.#now(),
		});
		const image = await materializeWorkspaceSnapshot(this.#workspace.fs, request.snapshot);
		state = this.#store.saveRuntimeReplica({
			...state,
			providerPhase: "ready",
			replicaImage: image,
			updatedAtEpochMs: this.#now(),
		});
		return {
			status: "materialized",
			request: transitionRequestEcho(validated),
			replica: state.replica,
			canonicalGeneration: request.lease.baseGeneration,
			...image,
		};
	}

	async #runtimeQuiesce(
		validated: CloudflareValidatedRuntimeOperationV1,
		request: RuntimeQuiesceRequest,
	): Promise<RuntimeQuiesceResult> {
		let state = await this.#requireRuntimeLeaseAndFence(request.lease, request.fence);
		if (state.providerPhase === "quiesced") {
			return {
				status: "already_quiesced",
				request: transitionRequestEcho(validated),
				lease: state.lease,
				activeCommands: 0,
				pendingSyncs: 0,
			};
		}
		if (state.providerPhase !== "ready" && state.providerPhase !== "quiescing") {
			throw new WorkspaceObjectError(409, "invalid_workspace_phase", "Runtime replica is not ready to quiesce");
		}
		this.#store.markRuntimeRequestOutcomeUnknown(validated.requestId, this.#now());
		state = this.#store.saveRuntimeReplica({
			...state,
			providerPhase: "quiescing",
			admissionClosed: true,
			updatedAtEpochMs: this.#now(),
		});
		await this.#supervisor.stopRuntimeCommands();
		if (this.#store.runtimeActiveCommandCount() !== 0 || this.#store.runtimePendingSyncCount() !== 0) {
			throw new WorkspaceObjectError(409, "sync_unsettled", "Runtime commands are not durably settled");
		}
		state = this.#store.saveRuntimeReplica({ ...state, providerPhase: "quiesced", updatedAtEpochMs: this.#now() });
		return {
			status: "quiesced",
			request: transitionRequestEcho(validated),
			lease: state.lease,
			activeCommands: 0,
			pendingSyncs: 0,
		};
	}

	async #runtimeCheckpoint(
		validated: CloudflareValidatedRuntimeOperationV1,
		request: RuntimeCheckpointRequest,
	): Promise<RuntimeCheckpointResult> {
		const state = await this.#requireRuntimeLeaseAndFence(request.lease, request.fence);
		const existing = this.#store.runtimeCheckpoint(request.checkpointId);
		if (existing) {
			return {
				status: "already_checkpointed",
				request: transitionRequestEcho(validated),
				reference: existing.reference as FrozenReplicaCheckpointRef,
			};
		}
		if (state.providerPhase !== "quiesced") {
			throw new WorkspaceObjectError(
				409,
				"invalid_workspace_phase",
				"Runtime replica must be quiesced before checkpointing",
			);
		}
		this.#store.markRuntimeRequestOutcomeUnknown(validated.requestId, this.#now());
		const snapshot = await enumerateWorkspaceSnapshotFiles(this.#workspace.fs);
		const reference: FrozenReplicaCheckpointRef = {
			providerId: state.replica.providerId,
			profileId: state.replica.profileId,
			workspaceId: state.replica.workspaceId,
			replicaId: state.replica.replicaId,
			leaseId: state.lease.leaseId,
			checkpointId: request.checkpointId,
			rootSha256: snapshot.rootSha256,
			fileCount: snapshot.files.length,
			byteCount: snapshot.byteCount,
			format: "omp-text-v1",
			baseGeneration: state.lease.baseGeneration,
			frozenAt: iso(this.#now()),
		};
		const checkpoint = await freezeReplicaCheckpoint(this.#workspace.fs, reference);
		this.#store.saveRuntimeCheckpoint({
			checkpointId: request.checkpointId,
			locator: checkpointLocator(reference),
			reference,
			checkpoint,
			canonicalCommit: null,
			acknowledgedAt: null,
		});
		return { status: "checkpointed", request: transitionRequestEcho(validated), reference };
	}

	async #runtimeRevoke(
		validated: CloudflareValidatedRuntimeOperationV1,
		request: RuntimeRevokeRequest,
	): Promise<RuntimeRevokeResult> {
		let state = this.#store.runtimeReplica();
		if (!state || !sameJson(state.replica, request.replica) || state.lease.leaseId !== request.leaseId) {
			return {
				status: "absent",
				request: transitionRequestEcho(validated),
				replica: request.replica,
				leaseId: request.leaseId,
				fenceId: request.fenceId,
			};
		}
		if (state.lease.fenceId !== request.fenceId)
			throw new WorkspaceObjectError(409, "request_conflict", "Runtime fence identity does not match");
		if (state.providerPhase === "revoked" || state.providerPhase === "expired") {
			return {
				status: state.providerPhase === "expired" ? "expired" : "already_revoked",
				request: transitionRequestEcho(validated),
				replica: state.replica,
				leaseId: state.lease.leaseId,
				fenceId: state.lease.fenceId,
			};
		}
		this.#store.markRuntimeRequestOutcomeUnknown(validated.requestId, this.#now());
		await this.#supervisor.stopRuntimeCommands();
		const expired = this.#now() >= Date.parse(state.lease.expiresAt);
		state = this.#store.saveRuntimeReplica({
			...state,
			providerPhase: expired ? "expired" : "revoked",
			admissionClosed: true,
			updatedAtEpochMs: this.#now(),
		});
		this.#store.deleteRuntimeDeadline("runtime_expiry", state.lease.leaseId);
		await this.#alarms.rearm(this.#now());
		return {
			status: expired ? "expired" : "revoked",
			request: transitionRequestEcho(validated),
			replica: state.replica,
			leaseId: state.lease.leaseId,
			fenceId: state.lease.fenceId,
		};
	}

	async #runtimeCheckpointAcknowledgement(
		validated: CloudflareValidatedRuntimeOperationV1,
		request: RuntimeCheckpointAcknowledgeRequest,
	): Promise<RuntimeCheckpointAcknowledgeResult> {
		const stored = this.#store.runtimeCheckpoint(request.reference.checkpointId);
		if (!stored || !sameJson(stored.reference, request.reference)) {
			throw new WorkspaceObjectError(404, "protocol_invalid", "Frozen checkpoint does not exist");
		}
		const already = stored.acknowledgedAt !== null;
		const acknowledged = this.#store.acknowledgeRuntimeCheckpoint(
			request.reference.checkpointId,
			request.canonicalCommit,
			stored.acknowledgedAt ?? iso(this.#now()),
		);
		return {
			status: already ? "already_acknowledged" : "acknowledged",
			request: parentRequestEcho(validated),
			reference: request.reference,
			canonicalCommit: request.canonicalCommit,
			acknowledgedAt: acknowledged.acknowledgedAt!,
		};
	}

	async #runtimeLeaseRelease(
		validated: CloudflareValidatedRuntimeOperationV1,
		request: RuntimeLeaseReleaseRequest,
	): Promise<RuntimeLeaseReleaseResult> {
		let state = this.#store.runtimeReplica();
		if (!state || !sameJson(state.replica, request.replica) || state.lease.leaseId !== request.leaseId) {
			return {
				status: "absent",
				request: parentRequestEcho(validated),
				replica: request.replica,
				leaseId: request.leaseId,
				compute: "not_applicable",
			};
		}
		if (state.providerPhase === "released" || state.providerPhase === "expired") {
			return {
				status: state.providerPhase === "expired" ? "expired" : "already_released",
				request: parentRequestEcho(validated),
				replica: state.replica,
				leaseId: state.lease.leaseId,
				compute: "stopped",
			};
		}
		this.#store.markRuntimeRequestOutcomeUnknown(validated.requestId, this.#now());
		await this.#supervisor.stopRuntimeCommands();
		if (this.#containerRunning()) await this.#container.destroy();
		const expired = this.#now() >= Date.parse(state.lease.expiresAt);
		state = this.#store.saveRuntimeReplica({
			...state,
			providerPhase: expired ? "expired" : "released",
			admissionClosed: true,
			updatedAtEpochMs: this.#now(),
		});
		this.#store.deleteRuntimeDeadline("runtime_expiry", state.lease.leaseId);
		await this.#alarms.rearm(this.#now());
		return {
			status: expired ? "expired" : "released",
			request: parentRequestEcho(validated),
			replica: state.replica,
			leaseId: state.lease.leaseId,
			compute: "stopped",
		};
	}

	async #decodeRuntimeEffect(input: unknown): Promise<CloudflareValidatedRuntimeOperationV1> {
		try {
			return await decodeCloudflareRuntimeEffectEnvelopeV1(input);
		} catch (error) {
			throw protocolObjectError(error);
		}
	}

	async #decodeRuntimeInspection(input: unknown): Promise<CloudflareValidatedRuntimeOperationV1> {
		try {
			return await decodeCloudflareRuntimeInspectionEnvelopeV1(input);
		} catch (error) {
			throw protocolObjectError(error);
		}
	}
	#reserveValidatedRuntimeRequest(validated: CloudflareValidatedRuntimeOperationV1) {
		return this.#store.reserveRuntimeRequest({
			requestId: validated.requestId,
			requestSha256: validated.requestSha256,
			operation: validated.operation,
			canonicalTupleUtf8: validated.canonicalTupleUtf8,
			request: sanitizeRuntimeLedgerValue(validated.inspection),
			updatedAtEpochMs: this.#now(),
		});
	}

	#inspectValidatedRuntimeOperation(validated: CloudflareValidatedRuntimeOperationV1): unknown {
		const requestState = this.#runtimeRequestForInspection(
			validated.requestId,
			validated.requestSha256,
			validated.operation,
			validated.canonicalTupleUtf8,
		);
		if (requestState?.state === "complete") {
			if (validated.operation === "checkpoint_acknowledgement") {
				return { status: "complete", result: requestState.result } as RuntimeCheckpointAcknowledgeInspectResult;
			}
			if (validated.operation === "release") {
				return { status: "complete", result: requestState.result } as RuntimeLeaseReleaseInspectResult;
			}
			if (validated.operation === "revoke") {
				return { status: "complete", result: requestState.result } as RuntimeRevokeInspectResult;
			}
			if (validated.operation === "checkpoint") {
				const result = requestState.result as RuntimeCheckpointResult;
				const stored = this.#store.runtimeCheckpoint(result.reference.checkpointId);
				if (stored?.acknowledgedAt) {
					return {
						status: "acknowledged",
						request: result.request,
						reference: result.reference,
						canonicalCommit: stored.canonicalCommit as CanonicalWorkspaceCommitReceipt,
						acknowledgedAt: stored.acknowledgedAt,
					} as RuntimeFrozenCheckpointInspectResult;
				}
				return {
					status: "frozen",
					request: result.request,
					reference: result.reference,
				} as RuntimeFrozenCheckpointInspectResult;
			}
			return { status: "complete", result: requestState.result };
		}
		const observedAt = iso(this.#now());
		const inspection = validated.inspection;
		switch (inspection.operation) {
			case "acquire": {
				const request = inspection.request;
				if (!requestState) {
					return {
						status: "not_started",
						request: transitionRequestEcho(validated),
						replica: request.plan.replica,
						leaseId: request.plan.leaseId,
						deletionAuthorityDomain: request.plan.deletionAuthorityDomain,
					} as RuntimeAcquireInspectResult;
				}
				return {
					status: "in_progress",
					request: transitionRequestEcho(validated),
					replica: request.plan.replica,
					leaseId: request.plan.leaseId,
					deletionAuthorityDomain: request.plan.deletionAuthorityDomain,
					providerPhase: "reserved",
					observedAt,
				} as RuntimeAcquireInspectResult;
			}
			case "push": {
				const request = inspection.request;
				if (!requestState) {
					return {
						status: "not_started",
						request: transitionRequestEcho(validated),
						replica: request.lease.replica,
						leaseId: request.lease.leaseId,
					} as RuntimePushInspectResult;
				}
				return {
					status: "in_progress",
					request: transitionRequestEcho(validated),
					replica: request.lease.replica,
					leaseId: request.lease.leaseId,
					providerPhase: "materializing",
					observedAt,
				} as RuntimePushInspectResult;
			}
			case "quiesce": {
				const request = inspection.request;
				if (!requestState)
					return {
						status: "not_started",
						request: transitionRequestEcho(validated),
						lease: request.lease,
					} as RuntimeQuiesceInspectResult;
				return {
					status: "in_progress",
					request: transitionRequestEcho(validated),
					lease: request.lease,
					activeCommands: this.#store.runtimeActiveCommandCount(),
					pendingSyncs: this.#store.runtimePendingSyncCount(),
					observedAt,
				} as RuntimeQuiesceInspectResult;
			}
			case "checkpoint": {
				const request = inspection.request;
				const locator: FrozenReplicaCheckpointLocator = {
					...request.lease.replica,
					leaseId: request.lease.leaseId,
					checkpointId: request.checkpointId,
				};
				return {
					status: "absent",
					request: transitionRequestEcho(validated),
					locator,
				} as RuntimeFrozenCheckpointInspectResult;
			}
			case "revoke": {
				const request = inspection.request;
				return {
					status: "not_started",
					request: transitionRequestEcho(validated),
					replica: request.replica,
					leaseId: request.leaseId,
					fenceId: request.fenceId,
				} as RuntimeRevokeInspectResult;
			}
			case "checkpoint_acknowledgement": {
				const request = inspection.request;
				return {
					status: "not_requested",
					request: parentRequestEcho(validated),
					reference: request.reference,
				} as RuntimeCheckpointAcknowledgeInspectResult;
			}
			case "release": {
				const request = inspection.request;
				if (!requestState)
					return {
						status: "not_requested",
						request: parentRequestEcho(validated),
						replica: request.replica,
						leaseId: request.leaseId,
					} as RuntimeLeaseReleaseInspectResult;
				return {
					status: "in_progress",
					request: parentRequestEcho(validated),
					replica: request.replica,
					leaseId: request.leaseId,
					compute: this.#containerRunning() ? "running" : "stopped",
					observedAt,
				} as RuntimeLeaseReleaseInspectResult;
			}
		}
	}

	async #requireRuntimeLeaseAndFence(lease: RuntimePushRequest["lease"], fence: RuntimePushRequest["fence"]) {
		const state = this.#store.runtimeReplica();
		if (!state || state.tombstone || !sameJson(state.lease, lease)) {
			throw new WorkspaceObjectError(409, "request_conflict", "Runtime lease does not match durable replica state");
		}
		await this.#requireRuntimeFence(state, fence);
		if (this.#now() >= Date.parse(state.lease.expiresAt)) {
			throw new WorkspaceObjectError(410, "workspace_gone", "Runtime lease has expired");
		}
		if (state.admissionClosed && state.providerPhase !== "quiescing" && state.providerPhase !== "quiesced") {
			throw new WorkspaceObjectError(409, "invalid_workspace_phase", "Runtime command admission is closed");
		}
		return state;
	}

	#runtimeRequestForInspection(
		requestId: string,
		requestSha256: string,
		operation: string,
		canonicalTupleUtf8: string,
	) {
		const state = this.#store.runtimeRequest(requestId);
		if (
			state &&
			(state.requestSha256 !== requestSha256 ||
				state.operation !== operation ||
				state.canonicalTupleUtf8 !== canonicalTupleUtf8)
		) {
			throw new WorkspaceObjectError(
				409,
				"request_conflict",
				"Runtime inspection identity conflicts with durable state",
			);
		}
		return state;
	}

	async #requireRuntimeFence(state: RuntimeReplicaState, fence: RuntimePushRequest["fence"]): Promise<void> {
		if (
			fence.fenceId !== state.lease.fenceId ||
			(await fenceVerifier(fence.fenceId, fence.token)) !== state.fenceVerifierSha256
		) {
			throw new WorkspaceObjectError(409, "request_conflict", "Runtime fence authority does not match");
		}
	}

	async renewRuntimeLease(decoded: {
		readonly plan: RuntimeLeaseRenewalPlan;
		readonly fence: RuntimeFence;
		readonly canonicalTupleUtf8: string;
	}): Promise<RuntimeLeaseRenewalReceipt> {
		const reservation = this.#store.reserveRuntimeRequest({
			requestId: decoded.plan.request.requestId,
			requestSha256: decoded.plan.request.requestSha256,
			operation: "renew",
			canonicalTupleUtf8: decoded.canonicalTupleUtf8,
			request: decoded.plan,
			updatedAtEpochMs: this.#now(),
		});
		if (reservation.state === "complete") return reservation.result as RuntimeLeaseRenewalReceipt;
		const state = this.#store.runtimeReplica();
		if (!state || state.tombstone || !sameJson(state.lease, decoded.plan.expectedLease)) {
			throw new WorkspaceObjectError(409, "request_conflict", "Runtime renewal expected lease does not match");
		}
		await this.#requireRuntimeFence(state, decoded.fence);
		if (decoded.plan.sequence !== state.lease.renewalSequence + 1) {
			throw new WorkspaceObjectError(409, "request_conflict", "Runtime renewal sequence is stale");
		}
		const now = this.#now();
		if (
			now >= Date.parse(state.lease.expiresAt) ||
			state.providerPhase === "revoked" ||
			state.providerPhase === "released" ||
			state.providerPhase === "expired" ||
			state.providerPhase === "recovery_freezing"
		) {
			throw new WorkspaceObjectError(410, "workspace_gone", "Runtime lease cannot be renewed");
		}
		const lease = {
			...state.lease,
			renewalSequence: decoded.plan.sequence,
			renewBy: iso(checkedEpochAdd(now, Math.max(1, Math.floor(decoded.plan.leaseTtlMs / 2)))),
			expiresAt: iso(checkedEpochAdd(now, decoded.plan.leaseTtlMs)),
		};
		const receipt: RuntimeLeaseRenewalReceipt = {
			renewalId: decoded.plan.renewalId,
			sequence: decoded.plan.sequence,
			request: decoded.plan.request,
			priorLease: state.lease,
			lease,
			providerOutcome: "renewed",
			completedAt: iso(now),
		};
		this.#store.saveRuntimeReplica({ ...state, lease, updatedAtEpochMs: now });
		this.#store.putRuntimeDeadline({
			schemaVersion: 1,
			kind: "runtime_expiry",
			key: lease.leaseId,
			dueAtEpochMs: Date.parse(lease.expiresAt),
			attempt: 0,
			updatedAtEpochMs: now,
		});
		this.#store.completeRuntimeRequest(decoded.plan.request.requestId, receipt, now);
		await this.#alarms.rearm(now);
		return receipt;
	}

	async inspectRuntimeRenewal(decoded: {
		readonly plan: RuntimeLeaseRenewalPlan;
		readonly canonicalTupleUtf8: string;
	}): Promise<RuntimeLeaseRenewInspectResult> {
		const { plan } = decoded;
		const requestState = this.#runtimeRequestForInspection(
			plan.request.requestId,
			plan.request.requestSha256,
			"renew",
			decoded.canonicalTupleUtf8,
		);
		if (requestState?.state === "complete")
			return { status: "complete", receipt: requestState.result as RuntimeLeaseRenewalReceipt };
		const state = this.#store.runtimeReplica();
		if (!requestState)
			return {
				status: "absent",
				renewalId: plan.renewalId,
				sequence: plan.sequence,
				requestId: plan.request.requestId,
			};
		const observedAt = iso(this.#now());
		if (!state || state.providerPhase === "revoked" || state.providerPhase === "released") {
			return {
				status: "rejected",
				renewalId: plan.renewalId,
				sequence: plan.sequence,
				reason: "lease_revoked",
				observedRenewalSequence: state?.lease.renewalSequence ?? null,
				observedAt,
			};
		}
		if (this.#now() >= Date.parse(state.lease.expiresAt) || state.providerPhase === "expired") {
			return {
				status: "rejected",
				renewalId: plan.renewalId,
				sequence: plan.sequence,
				reason: "lease_expired",
				observedRenewalSequence: state.lease.renewalSequence,
				observedAt,
			};
		}
		return {
			status: "rejected",
			renewalId: plan.renewalId,
			sequence: plan.sequence,
			reason: "expected_lease_mismatch",
			observedRenewalSequence: state.lease.renewalSequence,
			observedAt,
		};
	}

	async recoveryFreezeRuntime(decoded: {
		readonly request: Omit<RuntimeRecoveryFreezeRequest, "signal">;
		readonly canonicalTupleUtf8: string;
	}): Promise<RuntimeRecoveryFreezeResult> {
		const reservation = this.#store.reserveRuntimeRequest({
			requestId: decoded.request.requestId,
			requestSha256: decoded.request.requestSha256,
			operation: "recovery_freeze",
			canonicalTupleUtf8: decoded.canonicalTupleUtf8,
			request: decoded.request,
			updatedAtEpochMs: this.#now(),
		});
		if (reservation.state === "complete") return reservation.result as RuntimeRecoveryFreezeResult;
		let state = this.#store.runtimeReplica();
		if (
			!state ||
			!sameJson(state.replica, decoded.request.locator.replica) ||
			state.lease.leaseId !== decoded.request.locator.leaseId ||
			state.lease.fenceId !== decoded.request.locator.fenceId ||
			state.lease.baseGeneration !== decoded.request.locator.baseGeneration
		) {
			const result = await recoveryImpossible(decoded.request.locator, "replica_absent", this.#now());
			this.#store.completeRuntimeRequest(decoded.request.requestId, result, this.#now());
			return result;
		}
		const priorPhase = state.providerPhase;
		this.#store.markRuntimeRequestOutcomeUnknown(decoded.request.requestId, this.#now());
		state = this.#store.saveRuntimeReplica({
			...state,
			providerPhase: "recovery_freezing",
			admissionClosed: true,
			updatedAtEpochMs: this.#now(),
		});
		await this.#supervisor.stopRuntimeCommands();
		if (!state.replicaImage) {
			const result = await recoveryImpossible(decoded.request.locator, "replica_image_missing", this.#now());
			this.#store.completeRuntimeRequest(decoded.request.requestId, result, this.#now());
			return result;
		}
		if (this.#store.runtimeAmbiguousCommandCount() !== 0 || this.#store.runtimePendingSyncCount() !== 0) {
			throw new WorkspaceObjectError(409, "sync_unsettled", "Runtime command reconciliation is not durably settled");
		}
		const existingCheckpoint = this.#store.runtimeCheckpoint(decoded.request.locator.checkpointId);
		if (existingCheckpoint) {
			if (!sameJson(existingCheckpoint.locator, checkpointLocatorFromRecovery(decoded.request.locator))) {
				throw new WorkspaceObjectError(
					409,
					"request_conflict",
					"Recovery checkpoint identity conflicts with durable state",
				);
			}
			const acknowledgedMutationsSha256 = await canonicalRuntimeSha256V1([
				"omp-cloudflare-acknowledged-mutations-v1",
				...this.#store.runtimeMutationReceiptIdentities(),
			]);
			const priorFence =
				this.#now() >= Date.parse(state.lease.expiresAt)
					? "expired"
					: priorPhase === "revoked" || priorPhase === "released"
						? "already_revoked"
						: "recovery_revoked";
			const result: RuntimeRecoveryFreezeResult = {
				status: "already_frozen",
				reference: existingCheckpoint.reference as FrozenReplicaCheckpointRef,
				acknowledgedMutationsSha256,
				observedRenewalSequence: state.lease.renewalSequence,
				commandAdmission: "closed",
				activeCommands: 0,
				pendingSyncs: 0,
				priorFence,
			};
			this.#store.saveRuntimeReplica({
				...state,
				providerPhase: "quiesced",
				admissionClosed: true,
				updatedAtEpochMs: this.#now(),
			});
			this.#store.completeRuntimeRequest(decoded.request.requestId, result, this.#now());
			return result;
		}
		const snapshot = await enumerateWorkspaceSnapshotFiles(this.#workspace.fs).catch(async error => {
			if (!(error instanceof WorkspaceObjectError) || error.status !== 422) throw error;
			const result = await recoveryImpossible(decoded.request.locator, "replica_image_invalid", this.#now());
			this.#store.completeRuntimeRequest(decoded.request.requestId, result, this.#now());
			return result;
		});
		if ("status" in snapshot) return snapshot;
		const reference: FrozenReplicaCheckpointRef = {
			...checkpointLocatorFromRecovery(decoded.request.locator),
			rootSha256: snapshot.rootSha256,
			fileCount: snapshot.files.length,
			byteCount: snapshot.byteCount,
			format: "omp-text-v1",
			baseGeneration: decoded.request.locator.baseGeneration,
			frozenAt: iso(this.#now()),
		};
		const checkpoint = await freezeReplicaCheckpoint(this.#workspace.fs, reference);
		this.#store.saveRuntimeCheckpoint({
			checkpointId: reference.checkpointId,
			locator: checkpointLocator(reference),
			reference,
			checkpoint,
			canonicalCommit: null,
			acknowledgedAt: null,
		});
		const acknowledgedMutationsSha256 = await canonicalRuntimeSha256V1([
			"omp-cloudflare-acknowledged-mutations-v1",
			...this.#store.runtimeMutationReceiptIdentities(),
		]);
		const priorFence =
			this.#now() >= Date.parse(state.lease.expiresAt)
				? "expired"
				: priorPhase === "revoked" || priorPhase === "released"
					? "already_revoked"
					: "recovery_revoked";
		const result: RuntimeRecoveryFreezeResult = {
			status: "frozen",
			reference,
			acknowledgedMutationsSha256,
			observedRenewalSequence: state.lease.renewalSequence,
			commandAdmission: "closed",
			activeCommands: 0,
			pendingSyncs: 0,
			priorFence,
		};
		this.#store.saveRuntimeReplica({
			...state,
			providerPhase: "quiesced",
			admissionClosed: true,
			updatedAtEpochMs: this.#now(),
		});
		this.#store.completeRuntimeRequest(decoded.request.requestId, result, this.#now());
		return result;
	}

	async inspectRuntimeRecoveryFreeze(decoded: {
		readonly request: Omit<RuntimeRecoveryFreezeRequest, "signal">;
		readonly canonicalTupleUtf8: string;
	}): Promise<RuntimeRecoveryFreezeInspectResult> {
		const requestState = this.#runtimeRequestForInspection(
			decoded.request.requestId,
			decoded.request.requestSha256,
			"recovery_freeze",
			decoded.canonicalTupleUtf8,
		);
		if (!requestState) return { status: "absent", locator: decoded.request.locator };
		if (requestState.state !== "complete") {
			return {
				status: "in_progress",
				locator: decoded.request.locator,
				phase: "reconciling_commands",
				activeCommands: this.#store.runtimeActiveCommandCount(),
				pendingSyncs: this.#store.runtimePendingSyncCount(),
				observedAt: iso(this.#now()),
			};
		}
		const result = requestState.result as RuntimeRecoveryFreezeResult;
		switch (result.status) {
			case "frozen":
			case "already_frozen":
				return { ...result, status: "frozen" };
			case "preservation_impossible":
			case "already_proved_impossible":
				return { status: "preservation_impossible", proof: result.proof };
			default:
				throw new WorkspaceObjectError(500, "protocol_invalid", "Stored recovery-freeze result is invalid");
		}
	}

	async inspectRuntimeCommand(input: unknown): Promise<RuntimeCommandInspectResult> {
		const locator = decodeRuntimeCommandLocatorV1(input);
		this.#requireRuntimeCommandLocator(locator);
		const state = this.#store.runtimeCommand(locator.commandId);
		if (state && state.requestSha256 !== locator.requestSha256)
			throw new WorkspaceObjectError(409, "request_conflict", "Runtime command digest does not match reservation");
		return this.#supervisor.inspectRuntimeCommand(locator.commandId);
	}

	async reconcileRuntimeCommandStart(input: unknown): Promise<RuntimeCommandStartReconcileResult> {
		const locator = decodeRuntimeCommandLocatorV1(input);
		this.#requireRuntimeCommandLocator(locator);
		const state = this.#store.runtimeCommand(locator.commandId);
		if (!state || state.requestSha256 !== locator.requestSha256)
			throw new WorkspaceObjectError(409, "request_conflict", "Runtime command digest does not match reservation");
		return this.#supervisor.reconcileRuntimeCommandStart(locator.commandId);
	}

	async requestReplicaCacheEviction(input: unknown): Promise<RuntimeReplicaCacheEvictionRequestResult> {
		const plan = await this.#decodeCacheEvictionPlan(input);
		const tuple = projectCloudflareReplicaCacheEvictionTupleV1(plan);
		const reservation = this.#store.reserveRuntimeRequest({
			requestId: plan.requestId,
			requestSha256: plan.requestSha256,
			operation: "replica_cache_evict",
			canonicalTupleUtf8: JSON.stringify(tuple),
			request: plan,
			updatedAtEpochMs: this.#now(),
		});
		if (reservation.state === "complete") return reservation.result as RuntimeReplicaCacheEvictionRequestResult;
		const acceptedAtEpochMs = this.#now();
		const acceptance = {
			requestId: plan.requestId,
			requestSha256: plan.requestSha256,
			replica: plan.replica,
			retentionDeadline: plan.retentionDeadline,
			acceptedAt: iso(acceptedAtEpochMs),
		} as const;
		const deadline = await decodeCloudflareDurableDeadlineV1(
			{
				schemaVersion: 1,
				kind: "workspace_retention",
				key: plan.requestId,
				dueAtEpochMs: Date.parse(plan.retentionDeadline),
				attempt: 0,
				updatedAtEpochMs: acceptedAtEpochMs,
				eviction: plan,
				acceptedAtEpochMs,
				lastDeferral: null,
			},
			{ workspaceRetentionMs: this.#workspaceRetentionMs },
		);
		this.#store.putRuntimeDeadline(deadline);
		const result: RuntimeReplicaCacheEvictionRequestResult = { status: "accepted", acceptance };
		this.#store.completeRuntimeRequest(plan.requestId, result, acceptedAtEpochMs);
		await this.#alarms.rearm(acceptedAtEpochMs);
		return result;
	}

	async inspectReplicaCacheEviction(input: unknown): Promise<RuntimeReplicaCacheEvictionInspectResult> {
		const plan = await this.#decodeCacheEvictionPlan(input);
		const tuple = projectCloudflareReplicaCacheEvictionTupleV1(plan);
		const requestState = this.#runtimeRequestForInspection(
			plan.requestId,
			plan.requestSha256,
			"replica_cache_evict",
			JSON.stringify(tuple),
		);
		const deadline = this.#store
			.runtimeDeadlines()
			.find(item => item.kind === "workspace_retention" && item.key === plan.requestId);
		if (deadline?.kind === "workspace_retention" && !sameJson(deadline.eviction, plan)) {
			throw new WorkspaceObjectError(
				409,
				"request_conflict",
				"Replica eviction deadline conflicts with the inspected plan",
			);
		}
		if (requestState?.state !== "complete" || requestState.result === null) {
			if (deadline?.kind === "workspace_retention") {
				return {
					status: "accepted",
					acceptance: {
						requestId: plan.requestId,
						requestSha256: plan.requestSha256,
						replica: plan.replica,
						retentionDeadline: plan.retentionDeadline,
						acceptedAt: iso(deadline.acceptedAtEpochMs),
					},
				};
			}
			return {
				status: "not_started",
				requestId: plan.requestId,
				requestSha256: plan.requestSha256,
				replica: plan.replica,
				retentionDeadline: plan.retentionDeadline,
				observedAt: iso(this.#now()),
			};
		}
		const result = requestState.result as RuntimeReplicaCacheEvictionRequestResult;
		if (result.status === "complete") return result;
		if (result.status === "accepted" || result.status === "already_accepted") {
			if (deadline?.kind === "workspace_retention" && deadline.lastDeferral) {
				return {
					status: "deferred",
					acceptance: result.acceptance,
					reason: deadline.lastDeferral.reason,
					nextAttemptAt: iso(deadline.lastDeferral.nextAttemptAtEpochMs),
					observedAt: iso(deadline.lastDeferral.observedAtEpochMs),
				};
			}
			return { status: "accepted", acceptance: result.acceptance };
		}
		return result as RuntimeReplicaCacheEvictionInspectResult;
	}

	async deleteRuntimeReplica(input: unknown): Promise<RuntimeReplicaDeleteResult> {
		const validated = await this.#decodeReplicaDelete(input);
		const { request } = validated;
		const reservation = this.#store.reserveRuntimeRequest({
			requestId: request.requestId,
			requestSha256: request.requestSha256,
			operation: "replica_delete",
			canonicalTupleUtf8: validated.canonicalTupleUtf8,
			request,
			updatedAtEpochMs: this.#now(),
		});
		const existingResult = reservation.result as RuntimeReplicaDeleteResult | null;
		const state = this.#store.runtimeReplica();
		if (state && !sameJson(state.replica, request.replica)) {
			throw new WorkspaceObjectError(
				409,
				"request_conflict",
				"Replica deletion target does not match durable state",
			);
		}
		if (state?.tombstone) {
			if (
				!sameJson(state.tombstone.request, requestIdentity(request)) ||
				!sameJson(state.tombstone.authorization, request.authorization)
			) {
				throw new WorkspaceObjectError(
					409,
					"request_conflict",
					"Replica tombstone is bound to a different deletion request",
				);
			}
			this.#store.replaceRuntimeRequestResult(request.requestId, state.tombstone.result, this.#now());
			return state.tombstone.result;
		}
		if (reservation.state === "complete" && existingResult?.status !== "cleanup_pending") return existingResult!;
		if (state && state.deletionAuthorityDomain !== validated.authorizationDomain) {
			throw new WorkspaceObjectError(
				409,
				"deletion_authority_domain_mismatch",
				"Replica deletion authority domain does not match reservation",
			);
		}
		const purgeAfter = deletionPurgeAfter(request.authorization);
		if (this.#now() < Date.parse(purgeAfter)) {
			const result: RuntimeReplicaDeleteResult = {
				status: "cleanup_pending",
				request: requestIdentity(request),
				replica: request.replica,
				authorization: request.authorization,
				observedAt: iso(this.#now()),
				retryAfter: purgeAfter,
				receiptSha256: null,
			};
			if (reservation.state === "complete")
				this.#store.replaceRuntimeRequestResult(request.requestId, result, this.#now());
			else this.#store.completeRuntimeRequest(request.requestId, result, this.#now());
			return result;
		}
		const receiptSha256 =
			`sha256:${await canonicalRuntimeSha256V1(projectCloudflareReplicaDeleteReceiptTupleV1(request))}` as const;
		if (!state) {
			const result: RuntimeReplicaDeleteResult = {
				status: "absent",
				request: requestIdentity(request),
				replica: request.replica,
				authorization: request.authorization,
				observedAt: iso(this.#now()),
				retryAfter: null,
				receiptSha256,
			};
			this.#store.replaceRuntimeRequestResult(request.requestId, result, this.#now());
			return result;
		}
		this.#store.markRuntimeRequestOutcomeUnknown(request.requestId, this.#now());
		await this.#supervisor.stopRuntimeCommands();
		if (this.#containerRunning()) await this.#container.destroy();
		await purgeRuntimeWorkspaceBytes(this.#workspace.fs);
		this.#store.purgeRuntimeReplicaPayloadState();
		const result: RuntimeReplicaDeleteResult = {
			status: "deleted",
			request: requestIdentity(request),
			replica: request.replica,
			authorization: request.authorization,
			observedAt: iso(this.#now()),
			retryAfter: null,
			receiptSha256,
		};
		this.#store.saveRuntimeReplica({
			...state,
			providerPhase: "released",
			admissionClosed: true,
			tombstone: {
				request: result.request,
				authorization: request.authorization,
				tombstone: request.authorization.domain === "persistent" ? request.authorization.tombstone : null,
				result,
			},
			updatedAtEpochMs: this.#now(),
		});
		this.#store.replaceRuntimeRequestResult(request.requestId, result, this.#now());
		await this.#alarms.rearm(this.#now());
		return result;
	}

	async inspectRuntimeReplicaDeletion(input: unknown): Promise<RuntimeReplicaDeleteInspectResult> {
		const validated = await this.#decodeReplicaDelete(input);
		const row = this.#runtimeRequestForInspection(
			validated.request.requestId,
			validated.request.requestSha256,
			"replica_delete",
			validated.canonicalTupleUtf8,
		);
		const state = this.#store.runtimeReplica();
		if (state?.tombstone) {
			if (
				!sameJson(state.replica, validated.request.replica) ||
				!sameJson(state.tombstone.request, requestIdentity(validated.request)) ||
				!sameJson(state.tombstone.authorization, validated.request.authorization)
			) {
				throw new WorkspaceObjectError(
					409,
					"request_conflict",
					"Replica tombstone is bound to a different deletion request",
				);
			}
			return state.tombstone.result;
		}
		if (row?.state === "complete") return row.result as RuntimeReplicaDeleteResult;
		return {
			status: "not_started",
			request: requestIdentity(validated.request),
			replica: validated.request.replica,
			authorization: validated.request.authorization,
			observedAt: iso(this.#now()),
			retryAfter: null,
			receiptSha256: null,
		};
	}

	#requireRuntimeCommandLocator(locator: RuntimeCommandLocator): RuntimeReplicaState {
		const state = this.#store.runtimeReplica();
		if (!state || !sameJson(state.replica, locator.replica) || state.lease.leaseId !== locator.leaseId) {
			throw new WorkspaceObjectError(
				409,
				"request_conflict",
				"Runtime command locator does not match durable replica state",
			);
		}
		return state;
	}

	async #decodeCacheEvictionPlan(input: unknown): Promise<RuntimeReplicaCacheEvictionPlan> {
		try {
			return await decodeCloudflareReplicaCacheEvictionPlanV1(input, {
				workspaceRetentionMs: this.#workspaceRetentionMs,
			});
		} catch (error) {
			throw protocolObjectError(error);
		}
	}

	async #decodeReplicaDelete(input: unknown): Promise<CloudflareReplicaDeletionValidationV1> {
		try {
			return await decodeCloudflareReplicaDeleteRequestV1(input);
		} catch (error) {
			throw protocolObjectError(error);
		}
	}

	async applyRuntimeBridgeOperation(
		input: CloudflareRuntimeEffectTransportEnvelopeV1 | CloudflareRuntimeInspectionTransportEnvelopeV1,
	): Promise<CloudflareRuntimeEffectTransportResultEnvelopeV1 | CloudflareRuntimeInspectionTransportResultEnvelopeV1> {
		if (!("family" in input) || input.family !== "bridge") {
			throw new WorkspaceObjectError(400, "protocol_invalid", "Runtime bridge transport envelope is invalid");
		}
		const decoded = await decodeRuntimeBridgeEnvelopeV1(input, isBridgeEffectOperation(input.operation));
		const state = await this.#assertRuntimeAccess(decoded.request, isBridgeMutation(decoded.operation));
		if (!sameJson(state.replica, decoded.replica)) {
			throw new WorkspaceObjectError(409, "request_conflict", "Runtime bridge replica does not match durable state");
		}
		let result: unknown;
		switch (decoded.operation) {
			case "read_text_file":
				result = await this.#runtimeReadText(decoded.request as RuntimeReadTextRequest);
				break;
			case "read_binary_file":
				result = await this.#runtimeReadBinary(decoded.request as RuntimeReadBinaryRequest);
				break;
			case "write_text_file":
				result = await this.#runtimeWriteText(decoded);
				break;
			case "exists":
				result = await this.#runtimeExists((decoded.request as RuntimeAccessContext & { path: string }).path);
				break;
			case "stat":
				result = await this.#runtimeStat((decoded.request as RuntimeAccessContext & { path: string }).path);
				break;
			case "mkdir":
				result = await this.#runtimeMkdir(decoded);
				break;
			case "remove":
				result = await this.#runtimeRemove(decoded);
				break;
			case "rename":
				result = await this.#runtimeRename(decoded);
				break;
			case "list_files":
				result = await this.#runtimeList(decoded.request as RuntimeListRequest);
				break;
			case "search_text":
				result = await this.#runtimeSearch(decoded.request as RuntimeSearchRequest);
				break;
			case "submit_command":
				result = await this.#runtimeSubmitCommand(decoded.request as RuntimeCommandRequest);
				break;
			case "inspect_command":
				result = this.#supervisor.inspectRuntimeCommand(
					(decoded.request as RuntimeAccessContext & { commandId: string }).commandId,
				);
				break;
			case "cancel_command":
				result = await this.#runtimeCancelCommand(decoded);
				break;
			case "dispose_command":
				result = await this.#runtimeDisposeCommand(decoded);
				break;
		}
		await this.#assertRuntimeAccess(decoded.request, isBridgeMutation(decoded.operation));
		return {
			schemaVersion: 1,
			family: "bridge",
			operation: decoded.operation,
			replica: decoded.replica,
			result,
		} as CloudflareRuntimeEffectTransportResultEnvelopeV1 | CloudflareRuntimeInspectionTransportResultEnvelopeV1;
	}

	async #assertRuntimeAccess(request: RuntimeAccessContext, mutation: boolean): Promise<RuntimeReplicaState> {
		const state = this.#store.runtimeReplica();
		if (
			!state ||
			state.tombstone ||
			request.workspaceId !== state.replica.workspaceId ||
			request.replicaId !== state.replica.replicaId ||
			request.leaseId !== state.lease.leaseId ||
			request.expectedGeneration !== state.lease.baseGeneration
		) {
			throw new WorkspaceObjectError(
				409,
				"request_conflict",
				"Runtime access context does not match durable lease state",
			);
		}
		await this.#requireRuntimeFence(state, request.fence);
		if (
			this.#now() >= Date.parse(state.lease.expiresAt) ||
			state.providerPhase === "revoked" ||
			state.providerPhase === "released" ||
			state.providerPhase === "expired"
		) {
			throw new WorkspaceObjectError(410, "workspace_gone", "Runtime lease is no longer operational");
		}
		if (mutation && state.admissionClosed) {
			throw new WorkspaceObjectError(409, "invalid_workspace_phase", "Runtime mutation admission is closed");
		}
		return state;
	}

	async #runtimeReadText(request: RuntimeReadTextRequest): Promise<RuntimeReadTextResult> {
		const bytes = await readRuntimeFileBytes(this.#workspace.fs, request.path, MAX_SYNC_FILE_BYTES);
		let content: string;
		try {
			content = decoder.decode(bytes);
		} catch {
			throw new WorkspaceObjectError(422, "invalid_utf8", "Runtime text file is not strict UTF-8");
		}
		if (request.line !== null || request.limit !== null) {
			const lines = content.split("\n");
			const start = request.line === null ? 0 : Math.max(0, request.line - 1);
			content = lines.slice(start, request.limit === null ? undefined : start + request.limit).join("\n");
		}
		content = truncateStrictUtf8(content, request.byteLimit);
		const projected = encoder.encode(content);
		return { path: request.path, content, sha256: await sha256Hex(projected), byteLength: projected.byteLength };
	}

	async #runtimeReadBinary(request: RuntimeReadBinaryRequest): Promise<RuntimeReadBinaryResult> {
		const bytes = await readRuntimeFileBytes(this.#workspace.fs, request.path, MAX_SYNC_FILE_BYTES);
		const end = Math.min(bytes.byteLength, checkedEpochAdd(request.offset, request.byteLimit));
		const projected = bytes.slice(request.offset, end);
		return {
			path: request.path,
			contentBase64: encodeRuntimeBase64(projected),
			sha256: await sha256Hex(projected),
			byteLength: projected.byteLength,
			truncated: end < bytes.byteLength,
		};
	}

	async #runtimeWriteText(decoded: DecodedRuntimeBridgeOperation): Promise<RuntimeWriteResult> {
		const request = decoded.request as RuntimeWriteTextRequest;
		const existing = this.#reserveRuntimeMutation(decoded);
		if (existing?.state === "complete") return existing.result as RuntimeWriteResult;
		const bytes = encoder.encode(request.content);
		const relative = runtimeRelativePath(request.path);
		let prior: Uint8Array | null = null;
		try {
			prior = await readRuntimeFileBytes(this.#workspace.fs, request.path);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}
		if (prior && (await sha256Hex(prior)) === request.contentSha256) {
			const result: RuntimeWriteResult = {
				status: "already_written",
				path: request.path,
				sha256: request.contentSha256,
				byteLength: bytes.byteLength,
			};
			this.#store.completeRuntimeRequest(request.requestId, result, this.#now());
			return result;
		}
		this.#store.markRuntimeRequestOutcomeUnknown(request.requestId, this.#now());
		const absolute = await requireSafeFilePath(this.#workspace.fs, relative, true);
		await this.#workspace.fs.writeFile(absolute, bytes);
		const result: RuntimeWriteResult = {
			status: "written",
			path: request.path,
			sha256: request.contentSha256,
			byteLength: bytes.byteLength,
		};
		this.#store.completeRuntimeRequest(request.requestId, result, this.#now());
		return result;
	}

	async #runtimeExists(path: string): Promise<boolean> {
		const absolute = await resolveWorkspacePathNoSymlinkAncestors(this.#workspace.fs, path);
		return (await runtimeLstatOrNull(this.#workspace.fs, absolute)) !== null;
	}

	async #runtimeStat(path: string): Promise<RuntimeFileStat> {
		const absolute = await resolveWorkspacePathNoSymlinkAncestors(this.#workspace.fs, path);
		const stat = await runtimeLstatOrNull(this.#workspace.fs, absolute);
		if (!stat) throw new WorkspaceObjectError(404, "file_not_found", "Runtime path does not exist");
		if (stat.isSymbolicLink)
			return { path: path as RuntimeFileStat["path"], kind: "symlink", byteLength: null, sha256: null };
		if (stat.isDirectory)
			return { path: path as RuntimeFileStat["path"], kind: "directory", byteLength: null, sha256: null };
		if (!stat.isFile) return { path: path as RuntimeFileStat["path"], kind: "other", byteLength: null, sha256: null };
		const bytes = await readRuntimeFileBytes(this.#workspace.fs, path);
		return {
			path: path as RuntimeFileStat["path"],
			kind: "file",
			byteLength: bytes.byteLength,
			sha256: await sha256Hex(bytes),
		};
	}

	async #runtimeMkdir(decoded: DecodedRuntimeBridgeOperation): Promise<{ status: "created" | "already_exists" }> {
		const request = decoded.request as RuntimeMutationContext & { path: string; recursive: boolean };
		const existing = this.#reserveRuntimeMutation(decoded);
		if (existing?.state === "complete") return existing.result as { status: "created" | "already_exists" };
		const absolute = `${CLOUD_OMP_REMOTE_ROOT}/${runtimeRelativePath(request.path)}`;
		if (await this.#runtimeExists(request.path)) {
			const stat = await this.#workspace.fs.lstat(absolute);
			if (!stat.isDirectory || stat.isSymbolicLink)
				throw new WorkspaceObjectError(409, "request_conflict", "Runtime mkdir destination is not a directory");
			const result = { status: "already_exists" as const };
			this.#store.completeRuntimeRequest(request.requestId, result, this.#now());
			return result;
		}
		this.#store.markRuntimeRequestOutcomeUnknown(request.requestId, this.#now());
		await this.#workspace.fs.mkdir(absolute, { recursive: request.recursive });
		const result = { status: "created" as const };
		this.#store.completeRuntimeRequest(request.requestId, result, this.#now());
		return result;
	}

	async #runtimeRemove(decoded: DecodedRuntimeBridgeOperation): Promise<{ status: "removed" | "already_absent" }> {
		const request = decoded.request as RuntimeMutationContext & { path: string; recursive: boolean };
		const existing = this.#reserveRuntimeMutation(decoded);
		if (existing?.state === "complete") return existing.result as { status: "removed" | "already_absent" };
		const absolute = await resolveWorkspacePathNoSymlinkAncestors(this.#workspace.fs, request.path);
		if ((await runtimeLstatOrNull(this.#workspace.fs, absolute)) === null) {
			const result = { status: "already_absent" as const };
			this.#store.completeRuntimeRequest(request.requestId, result, this.#now());
			return result;
		}
		this.#store.markRuntimeRequestOutcomeUnknown(request.requestId, this.#now());
		await this.#workspace.fs.rm(absolute, { recursive: request.recursive, force: true });
		const result = { status: "removed" as const };
		this.#store.completeRuntimeRequest(request.requestId, result, this.#now());
		return result;
	}

	async #runtimeRename(decoded: DecodedRuntimeBridgeOperation): Promise<{ status: "renamed" | "already_renamed" }> {
		const request = decoded.request as RuntimeMutationContext & { from: string; to: string };
		const existing = this.#reserveRuntimeMutation(decoded);
		if (existing?.state === "complete") return existing.result as { status: "renamed" | "already_renamed" };
		const from = await resolveWorkspacePathNoSymlinkAncestors(this.#workspace.fs, request.from);
		const source = await runtimeLstatOrNull(this.#workspace.fs, from);
		if (existing.state === "reserved" && !source) {
			throw new WorkspaceObjectError(404, "file_not_found", "Runtime rename source does not exist");
		}
		const to = await resolveWorkspacePathNoSymlinkAncestors(
			this.#workspace.fs,
			request.to,
			existing.state === "reserved",
		);
		const destination = await runtimeLstatOrNull(this.#workspace.fs, to);
		if (existing.state === "outcome_unknown") {
			const evidence = decodeRuntimeRenameEvidence(existing, request.from, request.to);
			if (!source) {
				if (destination && sameRuntimeRenameEntry(destination, evidence.source)) {
					const result = { status: "already_renamed" as const };
					this.#store.completeRuntimeRequest(request.requestId, result, this.#now());
					return result;
				}
				if (destination) {
					throw new WorkspaceObjectError(
						409,
						"request_conflict",
						"Runtime rename replay destination identity changed",
					);
				}
				throw new WorkspaceObjectError(404, "file_not_found", "Runtime rename source does not exist");
			}
			const destinationMatches =
				destination === null || evidence.destination.entry === null
					? destination === null && evidence.destination.entry === null
					: sameRuntimeRenameEntry(destination, evidence.destination.entry);
			if (!sameRuntimeRenameEntry(source, evidence.source) || !destinationMatches) {
				throw new WorkspaceObjectError(409, "request_conflict", "Runtime rename replay identity changed");
			}
		} else {
			this.#store.markRuntimeRequestOutcomeUnknown(request.requestId, this.#now(), {
				schemaVersion: 1,
				operation: "rename",
				source: { path: request.from, ...runtimeRenameEntry(source!) },
				destination: {
					path: request.to,
					entry: destination ? runtimeRenameEntry(destination) : null,
				},
			} satisfies RuntimeRenameEvidence);
		}
		await this.#workspace.fs.rename(from, to);
		const result = { status: "renamed" as const };
		this.#store.completeRuntimeRequest(request.requestId, result, this.#now());
		return result;
	}

	async #runtimeList(request: RuntimeListRequest): Promise<RuntimeListResult> {
		const absolute = await resolveWorkspacePathNoSymlinkAncestors(this.#workspace.fs, request.directory);
		const stat = await runtimeLstatOrNull(this.#workspace.fs, absolute);
		if (!stat) throw new WorkspaceObjectError(404, "file_not_found", "Runtime directory does not exist");
		if (!stat.isDirectory || stat.isSymbolicLink) {
			throw new WorkspaceObjectError(400, "unsafe_path", "Runtime list path is not a regular directory");
		}
		const children = await this.#workspace.fs.readdir(absolute);
		const matcher = wildcardMatcher(request.pattern);
		const entries = children
			.map(child => ({
				path: canonicalRuntimePath(
					`${request.directory === CLOUD_OMP_REMOTE_ROOT ? CLOUD_OMP_REMOTE_ROOT : request.directory}/${child.name}`,
				),
				kind: child.isSymbolicLink
					? ("symlink" as const)
					: child.isDirectory
						? ("directory" as const)
						: ("file" as const),
				byteLength: null,
			}))
			.filter(entry => matcher(entry.path))
			.sort((left, right) => compareRuntimePaths(left.path, right.path));
		const start = request.cursor === null ? 0 : Math.max(0, Number.parseInt(request.cursor, 10));
		const selected = entries.slice(start, start + request.limit);
		return {
			entries: selected,
			nextCursor: start + selected.length < entries.length ? String(start + selected.length) : null,
		};
	}

	async #runtimeSearch(request: RuntimeSearchRequest): Promise<RuntimeSearchResult> {
		const expression = new RegExp(request.pattern, request.flags.includes("g") ? request.flags : `${request.flags}g`);
		const cursor = await decodeCloudflareRuntimeSearchCursorV1(request.cursor, request);
		const result = await searchWorkspaceText(this.#workspace.fs, request.path, expression, cursor, request.limit);
		return {
			matches: result.matches,
			nextCursor:
				result.nextPosition === null
					? null
					: await encodeCloudflareRuntimeSearchCursorV1(request, result.nextPosition),
		};
	}

	async #runtimeSubmitCommand(request: RuntimeCommandRequest): Promise<RuntimeCommandSnapshot> {
		const state = this.#store.runtimeReplica()!;
		if (state.admissionClosed)
			throw new WorkspaceObjectError(409, "invalid_workspace_phase", "Runtime command admission is closed");
		return this.#supervisor.submitRuntimeCommand(request, {
			operationLeaseId: request.operationLeaseId,
			workspaceId: request.workspaceId,
			expectedGeneration: request.expectedGeneration,
			replicaId: request.replicaId,
			leaseId: request.leaseId,
			fenceId: request.fence.fenceId,
			commandId: request.commandId,
			command: {
				shell: request.command.shell,
				cwd: request.command.cwd,
				environment: request.command.environment,
				timeoutMs: request.command.timeoutMs,
				outputByteLimit: request.command.outputByteLimit,
				pty: request.command.pty,
			},
		});
	}

	async #runtimeCancelCommand(decoded: DecodedRuntimeBridgeOperation): Promise<RuntimeCommandSnapshot> {
		const request = decoded.request as RuntimeMutationContext & {
			commandId: string;
			signal: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
		};
		const existing = this.#reserveRuntimeMutation(decoded);
		if (existing?.state === "complete") return existing.result as RuntimeCommandSnapshot;
		this.#store.markRuntimeRequestOutcomeUnknown(request.requestId, this.#now());
		const result = await this.#supervisor.cancelRuntimeCommand(request.commandId, request.signal);
		this.#store.completeRuntimeRequest(request.requestId, result, this.#now());
		return result;
	}

	async #runtimeDisposeCommand(decoded: DecodedRuntimeBridgeOperation) {
		const request = decoded.request as RuntimeMutationContext & { commandId: string };
		const existing = this.#reserveRuntimeMutation(decoded);
		if (existing?.state === "complete")
			return existing.result as { status: "disposed" | "already_disposed"; commandId: string };
		this.#store.markRuntimeRequestOutcomeUnknown(request.requestId, this.#now());
		const result = await this.#supervisor.disposeRuntimeCommand(request.commandId);
		this.#store.completeRuntimeRequest(request.requestId, result, this.#now());
		return result;
	}

	#reserveRuntimeMutation(decoded: DecodedRuntimeBridgeOperation) {
		if (!decoded.canonicalTupleUtf8)
			throw new WorkspaceObjectError(
				400,
				"protocol_invalid",
				"Runtime mutation request is missing a canonical tuple",
			);
		const request = decoded.request as RuntimeMutationContext;
		return this.#store.reserveRuntimeRequest({
			requestId: request.requestId,
			requestSha256: request.requestSha256,
			operation: decoded.operation,
			canonicalTupleUtf8: decoded.canonicalTupleUtf8,
			request: sanitizeRuntimeMutationRequest(request),
			updatedAtEpochMs: this.#now(),
		});
	}

	async alarm(): Promise<void> {
		const now = this.#now();
		try {
			const due = this.#store.dueRuntimeDeadlines(now, CLOUDFLARE_ALARM_BATCH_LIMIT_V1);
			for (const persisted of due) {
				if (persisted.kind !== "runtime_expiry") continue;
				let deadline: CloudflareDurableDeadlineV1;
				try {
					deadline = await decodeCloudflareDurableDeadlineV1(persisted, {
						workspaceRetentionMs: this.#workspaceRetentionMs,
					});
				} catch (error) {
					throw protocolObjectError(error);
				}
				if (deadline.kind === "runtime_expiry") await this.#processRuntimeExpiry(deadline, now);
			}
			await this.#supervisor.retryDueSync(now);
			for (const persisted of due) {
				if (persisted.kind === "runtime_expiry") continue;
				let deadline: CloudflareDurableDeadlineV1;
				try {
					deadline = await decodeCloudflareDurableDeadlineV1(persisted, {
						workspaceRetentionMs: this.#workspaceRetentionMs,
					});
				} catch (error) {
					throw protocolObjectError(error);
				}
				if (deadline.kind === "sync_retry") await this.#processRuntimeSyncRetry(deadline);
				else if (deadline.kind === "workspace_retention") await this.#processRuntimeRetention(deadline, now);
			}

			const state = this.#store.workspace();
			if (state && state.phase !== "released") {
				if (now >= state.expiresAt) await this.#expireIfDue(state);
				else await this.#supervisor.recoverActiveExecutions();
			}
		} finally {
			await this.#alarms.rearm(now);
		}
	}

	async #processRuntimeExpiry(
		deadline: Extract<CloudflareDurableDeadlineV1, { kind: "runtime_expiry" }>,
		now: number,
	): Promise<void> {
		let state = this.#store.runtimeReplica();
		if (!state || state.lease.leaseId !== deadline.key || Date.parse(state.lease.expiresAt) > now) {
			this.#store.deleteRuntimeDeadline(deadline.kind, deadline.key);
			return;
		}
		if (state.providerPhase !== "expired" && state.providerPhase !== "released") {
			state = this.#store.saveRuntimeReplica({
				...state,
				providerPhase: "expired",
				admissionClosed: true,
				updatedAtEpochMs: now,
			});
			await this.#supervisor.stopRuntimeCommands();
			if (this.#containerRunning()) await this.#container.destroy();
		}
		this.#store.deleteRuntimeDeadline(deadline.kind, deadline.key);
	}

	async #processRuntimeSyncRetry(
		deadline: Extract<CloudflareDurableDeadlineV1, { kind: "sync_retry" }>,
	): Promise<void> {
		if (this.#store.runtimePendingSyncCount() === 0) this.#store.deleteRuntimeDeadline(deadline.kind, deadline.key);
	}

	async #processRuntimeRetention(
		deadline: Extract<CloudflareDurableDeadlineV1, { kind: "workspace_retention" }>,
		now: number,
	): Promise<void> {
		const state = this.#store.runtimeReplica();
		let reason: RuntimeReplicaCacheEvictionDeferredReason;
		if (!state || !sameJson(state.replica, deadline.eviction.replica)) {
			const completion = await cacheEvictionCompletion(deadline, "absent", now);
			this.#store.replaceRuntimeRequestResult(
				deadline.eviction.requestId,
				{ status: "complete", result: completion },
				now,
			);
			this.#store.deleteRuntimeDeadline(deadline.kind, deadline.key);
			return;
		}
		if (state.providerPhase !== "released" && state.providerPhase !== "expired") reason = "not_released";
		else if (this.#containerRunning()) reason = "active_compute";
		else if (this.#store.runtimeActiveCommandCount() !== 0) reason = "compute_ambiguous";
		else if (this.#store.unacknowledgedRuntimeCheckpointCount() !== 0) reason = "checkpoint_unacknowledged";
		else if (this.#store.runtimeAmbiguousCommandCount() !== 0 || this.#store.runtimePendingSyncCount() !== 0) {
			reason = "command_or_sync_ambiguous";
		} else {
			await purgeRuntimeWorkspaceBytes(this.#workspace.fs);
			this.#store.saveRuntimeReplica({ ...state, replicaImage: null, updatedAtEpochMs: now });
			const completion = await cacheEvictionCompletion(deadline, "evicted", now);
			this.#store.replaceRuntimeRequestResult(
				deadline.eviction.requestId,
				{ status: "complete", result: completion },
				now,
			);
			this.#store.deleteRuntimeDeadline(deadline.kind, deadline.key);
			return;
		}
		this.#store.putRuntimeDeadline(deferCloudflareWorkspaceRetentionDeadlineV1(deadline, reason, now));
	}

	async #seedWorkspace(
		clientWorkspaceId: string,
		workspaceIdSha256: string,
		auditCorrelationId: string,
		seedRootSha256: string,
		validated: Array<{ entry: FilePayload; bytes: Uint8Array }>,
		totalBytes: number,
		existing: WorkspaceRow | undefined,
	): Promise<CreateWorkspaceResponse> {
		const startedAt = this.#now();
		const context = { auditCorrelationId, workspaceIdSha256 };
		try {
			if (!existing) {
				const inserted = this.#store.insertWorkspace({
					workspaceIdSha256,
					auditCorrelationId,
					expiresAt: this.#now() + CLOUD_OMP_WORKSPACE_TTL_MS,
					seedDigest: seedRootSha256,
				});
				if (
					inserted.workspaceIdSha256 !== workspaceIdSha256 ||
					inserted.auditCorrelationId !== auditCorrelationId ||
					inserted.seedDigest !== seedRootSha256
				) {
					throw new WorkspaceObjectError(
						409,
						"workspace_seed_conflict",
						"Workspace ID is already bound to different creation metadata",
					);
				}
				await this.#alarms.rearm();
			}
			this.#audit.record(context, {
				operation: "acquire",
				durationMs: Math.max(0, this.#now() - startedAt),
				outcome: "success",
				byteCount: totalBytes,
				fileCount: validated.length,
				cleanupState: "not_started",
			});

			await this.#workspace.fs.rm(CLOUD_OMP_REMOTE_ROOT, { recursive: true, force: true });
			await this.#workspace.fs.mkdir(CLOUD_OMP_REMOTE_ROOT, { recursive: true });
			for (const file of validated) {
				const absolute = await requireSafeFilePath(this.#workspace.fs, file.entry.path, true);
				await this.#workspace.fs.writeFile(absolute, file.bytes);
			}
			const actual = await enumerateManifest(this.#workspace.fs);
			if (actual.rootSha256 !== seedRootSha256) {
				throw new WorkspaceObjectError(500, "seed_verify_failed", "Workspace seed did not verify after upload");
			}
			const created = this.#store.markSeedComplete();
			if (!created)
				throw new WorkspaceObjectError(500, "workspace_state_lost", "Workspace state disappeared during creation");
			if (!created.seedComplete || created.phase !== "active" || created.cleanupReason) {
				throw new WorkspaceObjectError(410, "workspace_gone", "Workspace cleanup took precedence over creation");
			}
			this.#audit.record(context, {
				operation: "create",
				durationMs: Math.max(0, this.#now() - startedAt),
				outcome: "success",
				byteCount: totalBytes,
				fileCount: validated.length,
				cleanupState: "not_started",
			});
			return this.#createResponse(clientWorkspaceId, created);
		} catch (error) {
			this.#auditFailure(context, "create", startedAt, error, {
				byteCount: totalBytes,
				fileCount: validated.length,
				cleanupState: "failed",
			});
			throw error;
		}
	}

	#createResponse(clientWorkspaceId: string, row: WorkspaceRow): CreateWorkspaceResponse {
		return {
			workspaceId: clientWorkspaceId,
			remoteRoot: CLOUD_OMP_REMOTE_ROOT,
			expiresAt: new Date(row.expiresAt).toISOString(),
		};
	}

	async #requireOperational(phases: WorkspacePhase[]): Promise<WorkspaceRow> {
		const state = this.#store.workspace();
		if (!state) throw new WorkspaceObjectError(404, "workspace_not_found", "Workspace does not exist");
		if (state.phase === "released" || this.#now() >= state.expiresAt) {
			await this.#expireIfDue(state);
			throw new WorkspaceObjectError(410, "workspace_gone", "Workspace has expired or been released");
		}
		if (!state.seedComplete)
			throw new WorkspaceObjectError(409, "workspace_initializing", "Workspace seed is incomplete");
		if (!phases.includes(state.phase))
			throw new WorkspaceObjectError(409, "invalid_workspace_phase", `Workspace is ${state.phase}`);
		return state;
	}

	#requireMutationCurrent(generation: number): void {
		const state = this.#store.workspace();
		if (state?.phase !== "active" || state.cleanupReason || state.mutationGeneration !== generation) {
			throw new WorkspaceObjectError(410, "workspace_gone", "Workspace cleanup took precedence over mutation");
		}
	}

	async #restartAndWait(): Promise<void> {
		if (!this.#restartPromise) {
			this.#restartPromise = this.#performRestartAndWait().finally(() => {
				this.#restartPromise = undefined;
			});
		}
		await this.#restartPromise;
	}

	async #performRestartAndWait(): Promise<void> {
		await this.#workspace.close();
		await this.#container.restart({ PORT: "8080", MOUNT_POINT: CLOUD_OMP_REMOTE_ROOT });
		const deadline = Date.now() + 60_000;
		for (;;) {
			const status = await this.#container.status();
			if (status.running) {
				await this.#workspace.ready("container-shell");
				return;
			}
			if (Date.now() >= deadline) {
				throw new WorkspaceObjectError(
					500,
					"container_restart_failed",
					"Container did not become healthy after restart",
				);
			}
			await this.#sleep(250);
		}
	}

	async #expireIfDue(state: WorkspaceRow): Promise<void> {
		if (state.phase === "released" || this.#now() < state.expiresAt) return;
		this.#mutations.seal();
		this.#store.beginExpiryCleanup();
		await this.#releaseInternal("expiry");
	}

	async #releaseInternal(reason: "release" | "expiry"): Promise<void> {
		if (!this.#releasePromise) {
			this.#releasePromise = this.#performRelease(reason).finally(() => {
				this.#releasePromise = undefined;
			});
		}
		await this.#releasePromise;
	}

	async #performRelease(reason: "release" | "expiry"): Promise<void> {
		this.#mutations.seal();
		const creation = this.#createPromise;
		if (creation) {
			try {
				await withTimeout(creation, this.#cleanupTimeoutMs, "Workspace creation did not settle before cleanup");
			} catch (error) {
				if (this.#createPromise === creation) throw error;
			}
		}
		const initial = this.#store.workspace();
		if (!initial || initial.phase === "released") return;
		const context = this.#auditContext(initial);
		const startedAt = this.#now();
		const counts = stateCounts(this.#supervisor.stateSnapshot(initial.phase));
		const needsRestart = initial.phase !== "quiesced";
		if (initial.cleanupReason !== "expiry") this.#store.beginCleanup(reason);
		const cleanupReason = this.#store.workspace()?.cleanupReason === "expiry" ? "expiry" : reason;
		try {
			await withTimeout(
				this.#mutations.waitForDrain(),
				this.#cleanupTimeoutMs,
				"Workspace mutations did not settle before cleanup",
			);
			if (needsRestart) {
				await withTimeout(
					this.#supervisor.stopAndDisposeExecutions(cleanupReason),
					this.#cleanupTimeoutMs,
					"Workspace executions did not clean up",
				);
				await this.#restartAndWait();
			}
			await this.#workspace.fs.rm(CLOUD_OMP_REMOTE_ROOT, { recursive: true, force: true });
			await this.#closeWorkspaceOnce();
			await withTimeout(this.#container.destroy(), this.#cleanupTimeoutMs, "Workspace container did not stop");
			const finalReason = this.#store.workspace()?.cleanupReason === "expiry" ? "expiry" : cleanupReason;
			this.#store.completeRelease(finalReason);
			await this.#alarms.rearm();
			this.#audit.record(context, {
				operation: finalReason === "expiry" ? "expiry" : "release",
				durationMs: Math.max(0, this.#now() - startedAt),
				outcome: "success",
				...counts,
				cleanupState: finalReason === "expiry" ? "expired" : "completed",
			});
		} catch (error) {
			this.#auditFailure(context, cleanupReason === "expiry" ? "expiry" : "release", startedAt, error, {
				...counts,
				cleanupState: "failed",
			});
			throw error;
		}
	}

	async #closeWorkspaceOnce(): Promise<void> {
		const state = this.#store.workspace();
		if (state?.workspaceClosed) return;
		if (!this.#closePromise) {
			this.#closePromise = this.#workspace.close().catch(error => {
				this.#closePromise = undefined;
				throw error;
			});
		}
		await this.#closePromise;
	}

	#auditContext(row: WorkspaceRow): WorkspaceAuditContext {
		return { auditCorrelationId: row.auditCorrelationId, workspaceIdSha256: row.workspaceIdSha256 };
	}

	#auditFailure(
		context: WorkspaceAuditContext,
		operation: WorkspaceAuditEvent["operation"],
		startedAt: number,
		error: unknown,
		extra: Omit<WorkspaceAuditEvent, "operation" | "durationMs" | "outcome" | "errorCode"> = {},
	): void {
		this.#audit.record(context, {
			operation,
			durationMs: Math.max(0, this.#now() - startedAt),
			outcome: workspaceAuditOutcomeForError(error),
			errorCode: workspaceAuditErrorCode(error),
			...extra,
		});
	}
}

function randomHex128(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function stateCounts(
	state: WorkspaceState,
): Pick<WorkspaceAuditEvent, "activeExecutions" | "pendingSyncs" | "exhaustedSyncs"> {
	return {
		activeExecutions: state.activeExecutions,
		pendingSyncs: state.pendingSyncs,
		exhaustedSyncs: state.exhaustedSyncs,
	};
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => timeout.reject(new WorkspaceObjectError(500, "cleanup_timeout", message)),
		milliseconds,
	);
	return Promise.race([promise, timeout.promise]).finally(() => clearTimeout(timer));
}

type RuntimeBridgeOperation = Extract<
	CloudflareRuntimeEffectTransportEnvelopeV1 | CloudflareRuntimeInspectionTransportEnvelopeV1,
	{ readonly family: "bridge" }
>["operation"];

interface DecodedRuntimeBridgeOperation {
	readonly replica: RuntimeReplicaRef;
	readonly operation: RuntimeBridgeOperation;
	readonly request: RuntimeAccessContext;
	readonly canonicalTupleUtf8?: string;
}

type RuntimeRenameEntryKind = "file" | "directory" | "symlink" | "other";

interface RuntimeRenameEntryEvidence {
	readonly inode: number;
	readonly kind: RuntimeRenameEntryKind;
}

interface RuntimeRenameEvidence {
	readonly schemaVersion: 1;
	readonly operation: "rename";
	readonly source: RuntimeRenameEntryEvidence & { readonly path: string };
	readonly destination: {
		readonly path: string;
		readonly entry: RuntimeRenameEntryEvidence | null;
	};
}

function decodeRuntimeCommandLocatorV1(input: unknown): RuntimeCommandLocator {
	const locator = strictRecord(input, ["replica", "leaseId", "commandId", "requestSha256"]);
	return {
		replica: decodeRuntimeReplica(locator.replica),
		leaseId: requiredIdentity(locator.leaseId),
		commandId: requiredIdentity(locator.commandId),
		requestSha256: requiredSha256(locator.requestSha256),
	};
}

async function decodeRuntimeBridgeEnvelopeV1(input: unknown, effect: boolean): Promise<DecodedRuntimeBridgeOperation> {
	try {
		const decoded = effect
			? await decodeCloudflareRuntimeEffectTransportEnvelopeV1(input)
			: await decodeCloudflareRuntimeInspectionTransportEnvelopeV1(input);
		if (decoded.transportFamily !== "bridge") {
			throw new WorkspaceObjectError(400, "protocol_invalid", "Runtime bridge transport family is invalid");
		}
		const operation = decoded.operation;
		return {
			replica: decoded.replica,
			operation,
			request: decoded.request,
			...(isBridgeMutation(operation)
				? { canonicalTupleUtf8: JSON.stringify(runtimeBridgeMutationTupleV1(operation, decoded.request)) }
				: {}),
		};
	} catch (error) {
		throw protocolObjectError(error);
	}
}

function runtimeBridgeMutationTupleV1(
	operation: RuntimeBridgeOperation,
	input: RuntimeAccessContext,
): readonly (string | number | boolean)[] {
	const access = [
		input.operationLeaseId,
		input.workspaceId,
		input.expectedGeneration,
		input.replicaId,
		input.leaseId,
		input.fence.fenceId,
	] as const;
	switch (operation) {
		case "write_text_file": {
			const request = input as RuntimeWriteTextRequest;
			return [
				"omp-runtime-request-v1",
				"write_text",
				...access,
				request.path,
				request.contentSha256,
				encoder.encode(request.content).byteLength,
			];
		}
		case "mkdir":
		case "remove": {
			const request = input as RuntimeMutationContext & { path: string; recursive: boolean };
			return ["omp-runtime-request-v1", operation, ...access, request.path, request.recursive];
		}
		case "rename": {
			const request = input as RuntimeMutationContext & { from: string; to: string };
			return ["omp-runtime-request-v1", "rename", ...access, request.from, request.to];
		}
		case "cancel_command": {
			const request = input as RuntimeMutationContext & { commandId: string; signal: string };
			return ["omp-runtime-request-v1", "command_cancel", ...access, request.commandId, request.signal];
		}
		case "dispose_command": {
			const request = input as RuntimeMutationContext & { commandId: string };
			return ["omp-runtime-request-v1", "command_dispose", ...access, request.commandId];
		}
		default:
			throw new WorkspaceObjectError(400, "protocol_invalid", "Runtime bridge operation is not a mutation");
	}
}

function decodeRuntimeReplica(input: unknown) {
	const replica = strictRecord(input, ["providerId", "profileId", "replicaId", "workspaceId"]);
	return {
		providerId: requiredIdentity(replica.providerId),
		profileId: requiredIdentity(replica.profileId),
		replicaId: requiredIdentity(replica.replicaId),
		workspaceId: requiredIdentity(replica.workspaceId),
	} as RuntimeLeaseRef["replica"];
}

function strictRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input))
		throw protocolObjectError("Runtime request shape is invalid");
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null)
		throw protocolObjectError("Runtime request prototype is invalid");
	const actual = Object.keys(input);
	if (actual.length !== keys.length || actual.some(key => !keys.includes(key)))
		throw protocolObjectError("Runtime request has missing or unknown fields");
	return input as Record<string, unknown>;
}

function requiredString(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || !isWellFormedUnicode(value))
		throw protocolObjectError("Runtime string is invalid");
	return value;
}

function requiredIdentity(value: unknown): string {
	return requiredString(value);
}

function requiredSha256(value: unknown): string {
	const digest = requiredString(value);
	if (!/^[0-9a-f]{64}$/.test(digest)) throw protocolObjectError("Runtime digest is invalid");
	return digest;
}

function requiredInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
	if (
		!Number.isSafeInteger(value) ||
		Object.is(value, -0) ||
		(value as number) < minimum ||
		(value as number) > maximum
	)
		throw protocolObjectError("Runtime integer is invalid");
	return value as number;
}

function isWellFormedUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(++index);
			if (next < 0xdc00 || next > 0xdfff) return false;
		} else if (code >= 0xdc00 && code <= 0xdfff) return false;
	}
	return true;
}

function isBridgeEffectOperation(operation: RuntimeBridgeOperation): boolean {
	return operation === "submit_command" || isBridgeMutation(operation);
}

function isBridgeMutation(operation: RuntimeBridgeOperation): boolean {
	return (
		operation === "write_text_file" ||
		operation === "mkdir" ||
		operation === "remove" ||
		operation === "rename" ||
		operation === "cancel_command" ||
		operation === "dispose_command"
	);
}
function canonicalRuntimePath(value: string): PersistentModelWorkspacePath {
	runtimeRelativePath(value);
	return value as PersistentModelWorkspacePath;
}

function sanitizeRuntimeMutationRequest(request: RuntimeMutationContext): unknown {
	const source = request as unknown as Record<string, unknown>;
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(source)) {
		if (key === "fence") {
			sanitized.fenceId = request.fence.fenceId;
		} else if (key !== "content" && key !== "source") {
			sanitized[key] = value;
		}
	}
	return sanitized;
}

function protocolObjectError(error: unknown): WorkspaceObjectError {
	if (error instanceof WorkspaceObjectError) return error;
	return new WorkspaceObjectError(400, "protocol_invalid", error instanceof Error ? error.message : String(error));
}

function transitionRequestEcho(validated: CloudflareValidatedRuntimeOperationV1) {
	const request = validated.inspection.request as { transitionId: string };
	return {
		requestId: validated.requestId,
		requestSha256: validated.requestSha256,
		transitionId: request.transitionId,
	};
}

function parentRequestEcho(validated: CloudflareValidatedRuntimeOperationV1) {
	const request = validated.inspection.request as { parentOperationId: string };
	return {
		requestId: validated.requestId,
		requestSha256: validated.requestSha256,
		parentOperationId: request.parentOperationId,
	};
}

function requestIdentity(request: { requestId: string; requestSha256: string }) {
	return { requestId: request.requestId, requestSha256: request.requestSha256 };
}

function imageFromSnapshot(snapshot: WorkspaceSnapshot): WorkspaceImage {
	return {
		rootSha256: snapshot.checkpoint.rootSha256,
		fileCount: snapshot.checkpoint.fileCount,
		byteCount: snapshot.checkpoint.byteCount,
	};
}

function checkpointLocator(reference: FrozenReplicaCheckpointRef): FrozenReplicaCheckpointLocator {
	return {
		providerId: reference.providerId,
		profileId: reference.profileId,
		workspaceId: reference.workspaceId,
		replicaId: reference.replicaId,
		leaseId: reference.leaseId,
		checkpointId: reference.checkpointId,
	};
}

function checkpointLocatorFromRecovery(
	locator: RuntimeRecoveryFreezeRequest["locator"],
): FrozenReplicaCheckpointLocator {
	return {
		providerId: locator.replica.providerId,
		profileId: locator.replica.profileId,
		workspaceId: locator.replica.workspaceId,
		replicaId: locator.replica.replicaId,
		leaseId: locator.leaseId,
		checkpointId: locator.checkpointId,
	};
}

function sanitizeRuntimeLedgerValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeRuntimeLedgerValue);
	if (value === null || typeof value !== "object") return value;
	const sanitized: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === "fence" || key === "token") continue;
		sanitized[key] = sanitizeRuntimeLedgerValue(child);
	}
	return sanitized;
}

function deletionTombstone(authorization: RuntimeReplicaDeletionAuthorizationV1): WorkspaceTombstone {
	if (authorization.domain === "persistent") return authorization.tombstone;
	return {
		workspaceId: authorization.workspaceId,
		deleteId: authorization.cleanupId,
		deletionAuthorityId: authorization.cleanupAuthorityId,
		quarantineId: authorization.replicaDeletionQuarantineId,
		deletedAt: authorization.replicaDeletionPlannedAt,
		lastCheckpoint: authorization.finalCheckpoint,
		purgeAfter: authorization.replicaDeletionPurgeAfter,
	};
}

function deletionPurgeAfter(authorization: RuntimeReplicaDeletionAuthorizationV1): string {
	return authorization.domain === "persistent"
		? authorization.tombstone.purgeAfter
		: authorization.replicaDeletionPurgeAfter;
}

async function fenceVerifier(fenceId: string, token: string): Promise<string> {
	return canonicalRuntimeSha256V1(["omp-cloudflare-fence-verifier-v1", fenceId, token]);
}

async function recoveryImpossible(
	locator: RuntimeRecoveryFreezeRequest["locator"],
	code:
		| "replica_absent"
		| "replica_image_missing"
		| "replica_image_invalid"
		| "acknowledged_mutation_ledger_incomplete",
	now: number,
): Promise<RuntimeRecoveryFreezeResult> {
	const observedAt = iso(now);
	const proofSha256 = await canonicalRuntimeSha256V1([
		"omp-cloudflare-recovery-impossible-v1",
		locator.recoveryFreezeId,
		locator.replica.workspaceId,
		locator.replica.replicaId,
		locator.leaseId,
		locator.fenceId,
		locator.baseGeneration,
		locator.checkpointId,
		code,
		observedAt,
	]);
	return { status: "preservation_impossible", proof: { locator, code, proofSha256, observedAt } };
}

async function cacheEvictionCompletion(
	deadline: Extract<CloudflareDurableDeadlineV1, { kind: "workspace_retention" }>,
	outcome: "evicted" | "already_evicted" | "absent",
	now: number,
) {
	const acceptedAt = iso(deadline.acceptedAtEpochMs);
	const acceptance = {
		requestId: deadline.eviction.requestId,
		requestSha256: deadline.eviction.requestSha256,
		replica: deadline.eviction.replica,
		retentionDeadline: deadline.eviction.retentionDeadline,
		acceptedAt,
	};
	const completedAt = iso(now);
	const receiptSha256 =
		`sha256:${await canonicalRuntimeSha256V1(["omp-cloudflare-cache-eviction-receipt-v1", acceptance.requestId, acceptance.requestSha256, acceptance.replica.workspaceId, acceptance.replica.replicaId, acceptance.retentionDeadline, acceptedAt, outcome, completedAt])}` as const;
	return { acceptance, outcome, completedAt, receiptSha256 } as const;
}

function truncateStrictUtf8(value: string, byteLimit: number): string {
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= byteLimit) return value;
	let end = byteLimit;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return decoder.decode(bytes.subarray(0, end));
}

function compareRuntimePaths(left: string, right: string): number {
	return compareUtf8(left, right);
}

function wildcardMatcher(pattern: string): (value: string) => boolean {
	if (pattern === "" || pattern === "*") return () => true;
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	const expression = new RegExp(`^${escaped}$`, "u");
	return value => expression.test(value);
}

function encodeRuntimeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + 0x8000)));
	}
	return btoa(binary);
}

async function runtimeLstatOrNull(fs: WorkspaceFilesystemLike, path: string): Promise<WorkspaceStatLike | null> {
	try {
		return await fs.lstat(path);
	} catch (error) {
		if (isMissingPathError(error)) return null;
		throw error;
	}
}

function runtimeRenameEntry(stat: WorkspaceStatLike): RuntimeRenameEntryEvidence {
	if (!Number.isSafeInteger(stat.inode) || stat.inode < 1) {
		throw new WorkspaceObjectError(500, "protocol_invalid", "Runtime filesystem stat lacks stable inode identity");
	}
	return {
		inode: stat.inode,
		kind: stat.isSymbolicLink ? "symlink" : stat.isDirectory ? "directory" : stat.isFile ? "file" : "other",
	};
}

function sameRuntimeRenameEntry(stat: WorkspaceStatLike, evidence: RuntimeRenameEntryEvidence): boolean {
	const actual = runtimeRenameEntry(stat);
	return actual.inode === evidence.inode && actual.kind === evidence.kind;
}

function decodeRuntimeRenameEvidence(request: RuntimeRequestState, from: string, to: string): RuntimeRenameEvidence {
	try {
		if (request.state !== "outcome_unknown" || request.operation !== "rename") throw new Error("wrong state");
		const evidence = strictEvidenceRecord(request.result, ["schemaVersion", "operation", "source", "destination"]);
		if (evidence.schemaVersion !== 1 || evidence.operation !== "rename") throw new Error("wrong schema");
		const source = strictEvidenceRecord(evidence.source, ["path", "inode", "kind"]);
		const destination = strictEvidenceRecord(evidence.destination, ["path", "entry"]);
		if (source.path !== from || destination.path !== to) throw new Error("wrong paths");
		return {
			schemaVersion: 1,
			operation: "rename",
			source: { path: from, ...decodeRuntimeRenameEntryEvidence(source) },
			destination: {
				path: to,
				entry:
					destination.entry === null
						? null
						: decodeRuntimeRenameEntryEvidence(strictEvidenceRecord(destination.entry, ["inode", "kind"])),
			},
		};
	} catch {
		throw new WorkspaceObjectError(500, "workspace_state_lost", "Runtime rename reconciliation evidence is invalid");
	}
}

function decodeRuntimeRenameEntryEvidence(value: Record<string, unknown>): RuntimeRenameEntryEvidence {
	if (!Number.isSafeInteger(value.inode) || (value.inode as number) < 1) throw new Error("invalid inode");
	if (value.kind !== "file" && value.kind !== "directory" && value.kind !== "symlink" && value.kind !== "other") {
		throw new Error("invalid kind");
	}
	return { inode: value.inode as number, kind: value.kind };
}

function strictEvidenceRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid record");
	const actual = Object.keys(input);
	if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new Error("invalid keys");
	return input as Record<string, unknown>;
}

function sameJson(left: unknown, right: unknown): boolean {
	return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value === null || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) result[key] = stableValue((value as Record<string, unknown>)[key]);
	return result;
}

function checkedEpochAdd(epoch: number, duration: number): number {
	const result = epoch + duration;
	if (
		!Number.isSafeInteger(epoch) ||
		!Number.isSafeInteger(duration) ||
		!Number.isSafeInteger(result) ||
		epoch < 0 ||
		duration < 0
	)
		throw protocolObjectError("Runtime timestamp arithmetic overflowed");
	return result;
}

function iso(epoch: number): string {
	return new Date(epoch).toISOString();
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof WorkspaceObjectError
		? error.status === 404
		: typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
