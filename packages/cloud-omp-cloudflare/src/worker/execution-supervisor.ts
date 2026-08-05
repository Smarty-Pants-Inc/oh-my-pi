import {
	type ExecCreateResponse,
	type ExecRequest,
	type ExecSnapshot,
	MAX_COMMAND_TIMEOUT_MS,
	type WorkspaceState,
} from "../protocol";
import { WorkspaceObjectError } from "./errors";
import type { SQLiteRetryScheduler, WorkspaceAlarmCoordinator } from "./retry-scheduler";
import {
	type WorkspaceAuditContext,
	type WorkspaceAuditEvent,
	type WorkspaceAuditSink,
	workspaceAuditErrorCode,
	workspaceAuditOutcomeForError,
} from "./workspace-audit";
import type { WorkspaceFilesystemLike } from "./workspace-files";
import { type ExecutionRow, isTerminalExecution, type WorkspaceStateStore } from "./workspace-state-store";

const BACKEND_ID = "container-shell";
const CLEANUP_TIMEOUT_MS = MAX_COMMAND_TIMEOUT_MS;

export interface RuntimeEvent {
	id: string;
	seq: number;
	name: "stdout" | "stderr" | "result" | "exit";
	value: unknown;
}

export interface RuntimeResult {
	status: "completed" | "failed" | "cancelled";
	exitCode: number;
	skipped: unknown[];
	sync: { status: "complete"; skipped: unknown[] } | { status: "pending"; skipped: unknown[]; error: string };
}

export interface RuntimeHandle extends ReadableStream<RuntimeEvent> {
	readonly id: string;
	readonly backend: string;
	result(): Promise<RuntimeResult>;
	kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): Promise<void>;
	[Symbol.dispose](): void;
}

export interface RuntimeLike {
	exec(
		source: string,
		options: { id: string; cwd: string; timeoutMs: number; encoding: "utf8" },
	): Promise<RuntimeHandle>;
	getExec(id: string, options: { resume: number | "full"; encoding: "utf8" }): Promise<RuntimeHandle>;
	killExec(id: string, options?: { signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP" }): Promise<void>;
	disposeExec(id: string): Promise<void>;
}

export interface WorkspaceLike {
	readonly fs: WorkspaceFilesystemLike;
	readonly runtime: RuntimeLike;
	retryPendingSync(
		backend?: string,
	): Promise<
		| { status: "idle"; backend: string }
		| { status: "complete"; backend: string; applied: number; skipped: unknown[] }
		| { status: "pending"; backend: string; attempt: number; notBefore: number; error: string }
		| { status: "exhausted"; backend: string; attempt: number; error: string }
	>;
	ready(options?: string | { all?: boolean }): Promise<void>;
	close(): Promise<void>;
}

export interface ExecutionSupervisorOptions {
	store: WorkspaceStateStore;
	workspace: WorkspaceLike;
	retryScheduler: SQLiteRetryScheduler;
	alarms: WorkspaceAlarmCoordinator;
	audit: WorkspaceAuditSink;
	now: () => number;
	randomId: () => string;
	waitUntil: (promise: Promise<unknown>) => void;
}

export class ExecutionSupervisor {
	readonly #store: WorkspaceStateStore;
	readonly #workspace: WorkspaceLike;
	readonly #retryScheduler: SQLiteRetryScheduler;
	readonly #alarms: WorkspaceAlarmCoordinator;
	readonly #audit: WorkspaceAuditSink;
	readonly #now: () => number;
	readonly #randomId: () => string;
	readonly #waitUntil: (promise: Promise<unknown>) => void;
	readonly #collectors = new Map<string, Promise<void>>();
	readonly #handles = new Map<string, RuntimeHandle>();

	constructor(options: ExecutionSupervisorOptions) {
		this.#store = options.store;
		this.#workspace = options.workspace;
		this.#retryScheduler = options.retryScheduler;
		this.#alarms = options.alarms;
		this.#audit = options.audit;
		this.#now = options.now;
		this.#randomId = options.randomId;
		this.#waitUntil = options.waitUntil;
	}

	async createExec(request: ExecRequest, cwd: string, mutationGeneration: number): Promise<ExecCreateResponse> {
		const startedAt = this.#now();
		const execId = this.#randomId();
		if (!/^[0-9a-f]{32}$/.test(execId)) {
			throw new WorkspaceObjectError(500, "invalid_generated_id", "Execution ID generator failed");
		}
		this.#store.reserveExecution({
			id: execId,
			backend: BACKEND_ID,
			outputByteLimit: request.outputByteLimit,
			startedAt,
			now: startedAt,
			mutationGeneration,
		});

		let handle: RuntimeHandle;
		try {
			handle = await this.#workspace.runtime.exec(request.source, {
				id: execId,
				cwd,
				timeoutMs: request.timeoutMs,
				encoding: "utf8",
			});
		} catch (error) {
			this.#auditEvent("exec_start", startedAt, "failed", { errorCode: workspaceAuditErrorCode(error) });
			throw new WorkspaceObjectError(
				500,
				"execution_start_failed",
				"Remote execution could not be started or recovered",
			);
		}
		if (handle.id !== execId) {
			handle[Symbol.dispose]();
			this.#store.markExecutionFailed(
				execId,
				"Remote execution identity did not match the reservation",
				"exhausted",
			);
			this.#auditEvent("exec_start", startedAt, "failed", { errorCode: "EXECUTION_IDENTITY_MISMATCH" });
			throw new WorkspaceObjectError(
				500,
				"execution_identity_mismatch",
				"Remote execution returned an unexpected identity",
			);
		}
		if (!this.#store.markExecutionRunning(execId, handle.backend, mutationGeneration)) {
			await this.#killHandle(handle, "SIGKILL");
			await this.#disposeRuntimeExecution(execId);
			handle[Symbol.dispose]();
			this.#store.markExecutionFailed(execId, "Workspace cleanup took precedence over execution start", "exhausted");
			this.#auditEvent("exec_start", startedAt, "cancelled", { cleanupState: "completed" });
			throw new WorkspaceObjectError(
				410,
				"workspace_gone",
				"Workspace cleanup took precedence over execution start",
			);
		}
		this.#startCollector(execId, handle);
		this.#auditEvent("exec_start", startedAt, "success", {});
		return { execId };
	}

	async getExec(execId: string): Promise<ExecSnapshot> {
		const row = this.requireExecution(execId);
		if (!isTerminalExecution(row.status)) await this.ensureCollector(execId);
		return this.snapshot(this.requireExecution(execId));
	}

	async killExec(execId: string): Promise<ExecSnapshot> {
		const startedAt = this.#now();
		const row = this.requireExecution(execId);
		try {
			if (!isTerminalExecution(row.status)) {
				await this.ensureCollector(execId);
				await this.#killExecution(execId, "SIGTERM");
				const collector = this.#collectors.get(execId);
				if (collector) await withTimeout(collector, CLEANUP_TIMEOUT_MS, "Execution did not stop after kill");
			}
			const snapshot = this.snapshot(this.requireExecution(execId));
			this.#auditEvent("exec_kill", startedAt, snapshot.status === "cancelled" ? "cancelled" : "success", {
				exitCode: snapshot.exitCode,
				signal: snapshot.signal,
			});
			return snapshot;
		} catch (error) {
			this.#auditEvent("exec_kill", startedAt, workspaceAuditOutcomeForError(error), {
				errorCode: workspaceAuditErrorCode(error),
			});
			throw error;
		}
	}

	async deleteExec(execId: string): Promise<void> {
		const startedAt = this.#now();
		const row = this.execution(execId);
		if (!row) return;
		try {
			if (!isTerminalExecution(row.status)) {
				await this.ensureCollector(execId);
				await this.#killExecution(execId, "SIGKILL");
				const collector = this.#collectors.get(execId);
				if (collector) await withTimeout(collector, CLEANUP_TIMEOUT_MS, "Execution did not stop before disposal");
			}
			await this.#disposeRuntimeExecution(execId);
			const deleted = this.#store.deleteExecution(execId);
			if (deleted?.backendUnused) await this.#alarms.rearm();
			this.#auditEvent("exec_dispose", startedAt, "success", { cleanupState: "completed" });
		} catch (error) {
			this.#auditEvent("exec_dispose", startedAt, workspaceAuditOutcomeForError(error), {
				cleanupState: "failed",
				errorCode: workspaceAuditErrorCode(error),
			});
			throw error;
		}
	}

	execution(execId: string): ExecutionRow | undefined {
		if (!/^[0-9a-f]{32}$/.test(execId)) {
			throw new WorkspaceObjectError(400, "invalid_execution_id", "Execution ID is malformed");
		}
		return this.#store.execution(execId);
	}

	requireExecution(execId: string): ExecutionRow {
		const row = this.execution(execId);
		if (!row) throw new WorkspaceObjectError(404, "execution_not_found", "Execution does not exist");
		return row;
	}

	assertNoActive(): void {
		if (this.#store.activeExecutionCount() !== 0) {
			throw new WorkspaceObjectError(409, "execution_active", "Workspace has an active execution");
		}
	}

	assertSyncSettled(): void {
		if (this.#store.hasUnsettledSync()) {
			throw new WorkspaceObjectError(409, "sync_unsettled", "Workspace execution synchronization is not complete");
		}
	}

	stateSnapshot(phase: WorkspaceState["phase"]): WorkspaceState {
		return this.#store.stateSnapshot(phase);
	}

	async recoverActiveExecutions(): Promise<void> {
		for (const execution of this.#store.executionRows().filter(row => !isTerminalExecution(row.status))) {
			await this.ensureCollector(execution.id);
		}
	}

	async ensureCollector(execId: string): Promise<void> {
		if (this.#collectors.has(execId)) return;
		const row = this.requireExecution(execId);
		if (isTerminalExecution(row.status)) return;
		let handle: RuntimeHandle;
		try {
			handle = await this.#workspace.runtime.getExec(execId, { resume: row.lastSeq, encoding: "utf8" });
		} catch {
			const failed = this.#store.markExecutionFailed(
				execId,
				"Remote execution could not be reconstructed",
				"exhausted",
			);
			this.#auditExecutionComplete(failed, "failed", "EXECUTION_RECONSTRUCTION_FAILED");
			return;
		}
		if (handle.id !== execId) {
			handle[Symbol.dispose]();
			const failed = this.#store.markExecutionFailed(
				execId,
				"Remote execution identity did not match the reservation",
				"exhausted",
			);
			this.#auditExecutionComplete(failed, "failed", "EXECUTION_IDENTITY_MISMATCH");
			return;
		}
		this.#startCollector(execId, handle);
	}

	async retryDueSync(): Promise<void> {
		const now = this.#now();
		for (const intent of this.#retryScheduler.list()) {
			if (intent.notBefore > now) continue;
			const pending = this.#store.pendingExecution(intent.backend);
			if (!pending) continue;
			const startedAt = this.#now();
			const result = await this.#workspace.retryPendingSync(intent.backend);
			if (result.status === "pending") {
				await this.#retryScheduler.schedule({
					backend: result.backend,
					attempt: result.attempt,
					notBefore: result.notBefore,
				});
				this.#auditEvent("sync_retry", startedAt, "success", { cleanupState: "not_started" });
				continue;
			}
			if (result.status === "complete" && result.skipped.length === 0) {
				const complete = this.#store.completePendingSync(result.backend);
				await this.#alarms.rearm();
				this.#auditEvent("sync_retry", startedAt, "success", { fileCount: result.applied });
				if (complete) this.#auditExecutionComplete(complete, executionOutcome(complete));
				continue;
			}
			const reason =
				result.status === "complete"
					? "Remote synchronization skipped workspace changes"
					: result.status === "idle"
						? "Pending synchronization unexpectedly became idle"
						: "Remote synchronization retries were exhausted";
			const failed = this.#store.markExecutionFailed(pending.id, reason, "exhausted");
			this.#auditEvent("sync_retry", startedAt, "failed", { errorCode: "SYNC_RETRY_EXHAUSTED" });
			this.#auditExecutionComplete(failed, "failed", "SYNC_RETRY_EXHAUSTED");
		}
	}

	async stopAndDisposeExecutions(reason: "release" | "expiry"): Promise<void> {
		for (const execution of this.#store.executionRows()) {
			if (!isTerminalExecution(execution.status)) await this.ensureCollector(execution.id);
			await this.#killExecution(execution.id, "SIGKILL");
			const collector = this.#collectors.get(execution.id);
			if (collector) await collector;
			await this.#disposeRuntimeExecution(execution.id);
		}
		if (reason === "expiry") this.#store.markAllUnsettledSyncExhausted();
	}

	snapshot(row: ExecutionRow): ExecSnapshot {
		return {
			execId: row.id,
			status: row.status,
			output: row.output,
			truncated: Boolean(row.truncated),
			sync: row.sync,
			...(row.exitCode === null ? {} : { exitCode: row.exitCode }),
			...(row.signal === null ? {} : { signal: row.signal }),
		};
	}

	#startCollector(execId: string, handle: RuntimeHandle): void {
		if (this.#collectors.has(execId)) {
			handle[Symbol.dispose]();
			return;
		}
		this.#handles.set(execId, handle);
		const collector = this.#collect(execId, handle).finally(() => {
			this.#handles.delete(execId);
			this.#collectors.delete(execId);
			handle[Symbol.dispose]();
		});
		this.#collectors.set(execId, collector);
		this.#waitUntil(collector);
	}

	async #collect(execId: string, handle: RuntimeHandle): Promise<void> {
		let resultHandle: RuntimeHandle | undefined;
		try {
			const reader = handle.getReader();
			let outputCapKillSent = false;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value.id !== execId) throw new Error("Remote execution event identity mismatch");
					if (!Number.isFinite(value.seq)) continue;
					const exceeded = this.#store.applyExecutionEvent(execId, value);
					if (exceeded && !outputCapKillSent) {
						outputCapKillSent = true;
						await this.#killHandle(handle, "SIGKILL");
					}
				}
			} finally {
				reader.releaseLock();
			}
			resultHandle = await this.#workspace.runtime.getExec(execId, { resume: "full", encoding: "utf8" });
			if (resultHandle.id !== execId) throw new Error("Remote execution replay identity mismatch");
			const result = await resultHandle.result();
			await this.#applyResult(execId, handle.backend, result);
		} catch (collectionError) {
			let cleanupError: unknown;
			try {
				await this.#killHandle(handle, "SIGKILL");
			} catch (error) {
				cleanupError = error;
			}
			const failed = this.#store.markExecutionFailed(execId, "Remote execution collection failed", "exhausted");
			this.#auditExecutionComplete(failed, "failed", workspaceAuditErrorCode(collectionError));
			if (cleanupError !== undefined) throw cleanupError;
		} finally {
			resultHandle?.[Symbol.dispose]();
		}
	}

	async #applyResult(execId: string, backend: string, result: RuntimeResult): Promise<void> {
		const skipped = [...result.skipped, ...result.sync.skipped];
		if (skipped.length !== 0) {
			const failed = this.#store.markExecutionFailed(
				execId,
				"Remote synchronization skipped workspace changes",
				"exhausted",
				result.exitCode,
			);
			this.#auditExecutionComplete(failed, "failed", "SYNC_SKIPPED_CHANGES");
			return;
		}
		if (result.sync.status === "pending") {
			const pending = this.#store.markExecutionPending(execId, backend, result.status, result.exitCode);
			if (isTerminalExecution(pending.status)) return;
			const intent = await this.#retryScheduler.get(backend);
			if (!intent) {
				const failed = this.#store.markExecutionFailed(
					execId,
					"Pending synchronization has no durable retry intent",
					"exhausted",
					result.exitCode,
				);
				this.#auditExecutionComplete(failed, "failed", "SYNC_RETRY_INTENT_MISSING");
				return;
			}
			await this.#alarms.rearm();
			return;
		}
		const row = this.#store.requireExecution(execId);
		const status = row.error === "Execution output exceeded the hard cap" ? "failed" : result.status;
		await this.#retryScheduler.clear(backend);
		const complete = this.#store.completeExecution(execId, status, result.status, result.exitCode);
		this.#auditExecutionComplete(complete, executionOutcome(complete));
	}

	async #killExecution(execId: string, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
		try {
			const handle = this.#handles.get(execId);
			if (handle) await handle.kill(signal);
			else await this.#workspace.runtime.killExec(execId, { signal });
		} catch (error) {
			if (!isComputerMissingRecordError(error)) throw error;
		}
	}

	async #killHandle(handle: RuntimeHandle, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
		try {
			await handle.kill(signal);
		} catch (error) {
			if (!isComputerMissingRecordError(error)) throw error;
		}
	}

	async #disposeRuntimeExecution(execId: string): Promise<void> {
		try {
			await this.#workspace.runtime.disposeExec(execId);
		} catch (error) {
			if (!isComputerMissingRecordError(error)) throw error;
		}
	}

	#auditExecutionComplete(row: ExecutionRow, outcome: WorkspaceAuditEvent["outcome"], errorCode?: string): void {
		this.#audit.record(this.#auditContext(), {
			operation: "exec_complete",
			durationMs: Math.max(0, this.#now() - row.startedAt),
			outcome,
			byteCount: row.outputBytes,
			exitCode: row.exitCode,
			signal: row.signal,
			truncated: Boolean(row.truncated),
			...(errorCode === undefined ? {} : { errorCode }),
		});
	}

	#auditEvent(
		operation: WorkspaceAuditEvent["operation"],
		startedAt: number,
		outcome: WorkspaceAuditEvent["outcome"],
		extra: Omit<WorkspaceAuditEvent, "operation" | "durationMs" | "outcome">,
	): void {
		this.#audit.record(this.#auditContext(), {
			operation,
			durationMs: Math.max(0, this.#now() - startedAt),
			outcome,
			...extra,
		});
	}

	#auditContext(): WorkspaceAuditContext {
		const row = this.#store.workspace();
		if (!row) throw new WorkspaceObjectError(500, "workspace_state_lost", "Workspace state disappeared during audit");
		return { auditCorrelationId: row.auditCorrelationId, workspaceIdSha256: row.workspaceIdSha256 };
	}
}

export function isComputerMissingRecordError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function executionOutcome(row: ExecutionRow): WorkspaceAuditEvent["outcome"] {
	if (row.status === "cancelled") return "cancelled";
	if (row.status === "failed" && row.exitCode === 124 && row.signal === null) return "timed_out";
	return row.status === "completed" ? "success" : "failed";
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => timeout.reject(new WorkspaceObjectError(500, "cleanup_timeout", message)),
		milliseconds,
	);
	return Promise.race([promise, timeout.promise]).finally(() => clearTimeout(timer));
}
