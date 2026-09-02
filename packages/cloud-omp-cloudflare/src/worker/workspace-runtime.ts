import {
	CLOUD_OMP_REMOTE_ROOT,
	CLOUD_OMP_WORKSPACE_TTL_MS,
	type CreateWorkspaceRequest,
	type CreateWorkspaceResponse,
	type ExecCreateResponse,
	type ExecRequest,
	type ExecSnapshot,
	type FilePayload,
	type FileReadRequest,
	MAX_COMMAND_BYTES,
	MAX_COMMAND_TIMEOUT_MS,
	MAX_EXEC_OUTPUT_BYTES,
	MAX_SYNC_FILE_COUNT,
	MAX_SYNC_TOTAL_BYTES,
	type ManifestResponse,
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
	enumerateManifest,
	manifestRootSha256,
	readFilePayload,
	requireSafeDirectory,
	requireSafeFilePath,
	validateManifestEntries,
	validatePayload,
} from "./workspace-files";
import { WorkspaceMutationFence } from "./workspace-mutation-fence";
import type { WorkspaceRow, WorkspaceStateStore } from "./workspace-state-store";

export type { RuntimeEvent, RuntimeHandle, RuntimeLike, RuntimeResult, WorkspaceLike } from "./execution-supervisor";

const DEFAULT_CLEANUP_TIMEOUT_MS = MAX_COMMAND_TIMEOUT_MS;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ContainerLike {
	restart(env: Record<string, string>): Promise<void>;
	status(): Promise<{ running: boolean; exit: { reason: string } | null }>;
	destroy(): Promise<void>;
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
		this.#cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
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

	async alarm(): Promise<void> {
		const state = this.#store.workspace();
		if (!state || state.phase === "released") {
			await this.#alarms.rearm();
			return;
		}
		if (this.#now() >= state.expiresAt) {
			await this.#expireIfDue(state);
			return;
		}
		await this.#supervisor.recoverActiveExecutions();
		await this.#supervisor.retryDueSync();
		const afterRetry = this.#store.workspace();
		if (afterRetry && this.#now() >= afterRetry.expiresAt) await this.#expireIfDue(afterRetry);
		else await this.#alarms.rearm();
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
