import type {
	RuntimeCommandInspectResult,
	RuntimeCommandRequest,
	RuntimeCommandSnapshot,
	RuntimeCommandStartReconcileResult,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
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
import {
	type ExecutionRow,
	isTerminalExecution,
	type RuntimeCommandState,
	type WorkspaceStateStore,
} from "./workspace-state-store";

const BACKEND_ID = "container-shell";
const CLEANUP_TIMEOUT_MS = MAX_COMMAND_TIMEOUT_MS;
const runtimeEncoder = new TextEncoder();
const runtimeDecoder = new TextDecoder("utf-8", { fatal: true });
const RUNTIME_COMMAND_PREFIX =
	"/usr/bin/env -i HOME=/workspace LANG=C LC_ALL=C PATH=/usr/bin:/bin TMPDIR=/workspace /bin/bash --noprofile --norc -c ";

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
	readonly #runtimeCollectors = new Map<string, Promise<void>>();
	readonly #runtimeHandles = new Map<string, RuntimeHandle>();

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

	async submitRuntimeCommand(request: RuntimeCommandRequest, context: unknown): Promise<RuntimeCommandSnapshot> {
		const now = iso8601(this.#now());
		let state = this.#store.reserveRuntimeCommand({
			commandId: request.commandId,
			requestSha256: request.requestSha256,
			context,
			status: "reserved",
			certainty: "not_started",
			proof: "reservation_without_attempt",
			backend: BACKEND_ID,
			output: "",
			outputBytes: 0,
			outputStoredBytes: 0,
			outputByteLimit: request.command.outputByteLimit,
			truncated: false,
			lastSeq: -1,
			sync: "complete",
			exitCode: null,
			signal: null,
			updatedAt: now,
			disposed: false,
		});
		if (state.status !== "reserved" || state.disposed) return this.runtimeCommandSnapshot(state);
		state = this.#store.saveRuntimeCommand({
			...state,
			status: "start_unknown",
			certainty: "unknown",
			proof: null,
			sync: "pending",
			updatedAt: iso8601(this.#now()),
		});

		let handle: RuntimeHandle;
		try {
			handle = await this.#workspace.runtime.exec(scrubbedRuntimeCommand(request.command.source), {
				id: request.commandId,
				cwd: request.command.cwd,
				timeoutMs: request.command.timeoutMs,
				encoding: "utf8",
			});
		} catch {
			return this.runtimeCommandSnapshot(state);
		}
		if (handle.id !== request.commandId) {
			await this.#killHandle(handle, "SIGKILL");
			handle[Symbol.dispose]();
			return this.runtimeCommandSnapshot(state);
		}
		state = this.#store.saveRuntimeCommand({
			...state,
			backend: handle.backend,
			status: "running",
			certainty: "started",
			updatedAt: iso8601(this.#now()),
		});
		this.#startRuntimeCollector(request.commandId, handle);
		return this.runtimeCommandSnapshot(state);
	}

	inspectRuntimeCommand(commandId: string): RuntimeCommandInspectResult {
		const state = this.#store.runtimeCommand(commandId);
		if (!state || state.disposed) {
			return {
				status: "absent",
				commandId,
				execution: { certainty: "not_started", proof: "provider_reservation_absent" },
			};
		}
		return { status: "present", snapshot: this.runtimeCommandSnapshot(state) };
	}

	async reconcileRuntimeCommandStart(commandId: string): Promise<RuntimeCommandStartReconcileResult> {
		let state = this.#store.runtimeCommand(commandId);
		if (!state || state.disposed) {
			throw new WorkspaceObjectError(404, "execution_not_found", "Runtime command reservation does not exist");
		}
		if (state.status === "reserved") {
			return {
				status: "not_started",
				snapshot: this.runtimeCommandSnapshot(state) as Extract<RuntimeCommandSnapshot, { status: "reserved" }>,
			};
		}
		if (state.status === "start_unknown") {
			let handle: RuntimeHandle;
			try {
				handle = await this.#workspace.runtime.getExec(commandId, { resume: state.lastSeq, encoding: "utf8" });
			} catch (error) {
				if (!isComputerMissingRecordError(error)) {
					return {
						status: "unknown",
						snapshot: this.runtimeCommandSnapshot(state) as Extract<
							RuntimeCommandSnapshot,
							{ status: "start_unknown" }
						>,
					};
				}
				state = this.#store.saveRuntimeCommand({
					...state,
					status: "reserved",
					certainty: "not_started",
					proof: "backend_absent",
					sync: "complete",
					updatedAt: iso8601(this.#now()),
				});
				return {
					status: "not_started",
					snapshot: this.runtimeCommandSnapshot(state) as Extract<RuntimeCommandSnapshot, { status: "reserved" }>,
				};
			}
			if (handle.id !== commandId) {
				handle[Symbol.dispose]();
				return {
					status: "unknown",
					snapshot: this.runtimeCommandSnapshot(state) as Extract<
						RuntimeCommandSnapshot,
						{ status: "start_unknown" }
					>,
				};
			}
			state = this.#store.saveRuntimeCommand({
				...state,
				backend: handle.backend,
				status: "running",
				certainty: "started",
				updatedAt: iso8601(this.#now()),
			});
			this.#startRuntimeCollector(commandId, handle);
		}
		return {
			status: "observed",
			snapshot: this.runtimeCommandSnapshot(state) as Exclude<
				RuntimeCommandSnapshot,
				{ status: "reserved" | "start_unknown" }
			>,
		};
	}

	async cancelRuntimeCommand(
		commandId: string,
		signal: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP",
	): Promise<RuntimeCommandSnapshot> {
		let state = this.#store.runtimeCommand(commandId);
		if (!state || state.disposed)
			throw new WorkspaceObjectError(404, "execution_not_found", "Runtime command does not exist");
		if (state.status === "reserved") {
			state = this.#store.saveRuntimeCommand({
				...state,
				status: "cancelled",
				certainty: "completed",
				proof: null,
				sync: "complete",
				signal,
				updatedAt: iso8601(this.#now()),
			});
			return this.runtimeCommandSnapshot(state);
		}
		if (state.status === "start_unknown") return this.runtimeCommandSnapshot(state);
		if (state.status === "running") {
			if (!this.#runtimeCollectors.has(commandId)) {
				try {
					const handle = await this.#workspace.runtime.getExec(commandId, {
						resume: state.lastSeq,
						encoding: "utf8",
					});
					if (handle.id === commandId) this.#startRuntimeCollector(commandId, handle);
					else handle[Symbol.dispose]();
				} catch (error) {
					if (!isComputerMissingRecordError(error)) throw error;
				}
			}
			state = this.#store.runtimeCommand(commandId) ?? state;
			if (state.status !== "running") return this.runtimeCommandSnapshot(state);
			state = this.#store.saveRuntimeCommand({ ...state, signal, updatedAt: iso8601(this.#now()) });
			try {
				const handle = this.#runtimeHandles.get(commandId);
				if (handle) await handle.kill(signal);
				else await this.#workspace.runtime.killExec(commandId, { signal });
			} catch (error) {
				if (!isComputerMissingRecordError(error)) throw error;
				return this.runtimeCommandSnapshot(state);
			}
			const collector = this.#runtimeCollectors.get(commandId);
			if (collector)
				await withTimeout(collector, CLEANUP_TIMEOUT_MS, "Runtime command did not stop after cancellation");
			state = this.#store.runtimeCommand(commandId) ?? state;
		}
		return this.runtimeCommandSnapshot(state);
	}

	async disposeRuntimeCommand(
		commandId: string,
	): Promise<{ status: "disposed" | "already_disposed"; commandId: string }> {
		let state = this.#store.runtimeCommand(commandId);
		if (!state || state.disposed) return { status: "already_disposed", commandId };
		if (state.status === "running") await this.cancelRuntimeCommand(commandId, "SIGKILL");
		state = this.#store.runtimeCommand(commandId) ?? state;
		if (state.status === "running" || state.status === "start_unknown") {
			throw new WorkspaceObjectError(409, "sync_unsettled", "Runtime command execution certainty is not settled");
		}
		if (state.status !== "reserved") await this.#disposeRuntimeExecution(commandId);
		this.#store.saveRuntimeCommand({ ...state, disposed: true, updatedAt: iso8601(this.#now()) });
		return { status: "disposed", commandId };
	}

	runtimeCommandSnapshot(state: RuntimeCommandState): RuntimeCommandSnapshot {
		const base = {
			commandId: state.commandId,
			requestSha256: state.requestSha256,
			sync: state.sync,
			output: state.output,
			truncated: state.truncated,
			exitCode: state.exitCode,
			signal: state.signal,
			updatedAt: state.updatedAt,
		};
		if (state.status === "reserved") {
			return {
				...base,
				status: "reserved",
				execution: { certainty: "not_started", proof: state.proof ?? "reservation_without_attempt" },
			};
		}
		if (state.status === "start_unknown")
			return { ...base, status: "start_unknown", execution: { certainty: "unknown" } };
		if (state.status === "running") return { ...base, status: "running", execution: { certainty: "started" } };
		return { ...base, status: state.status, execution: { certainty: "completed" } };
	}

	async stopRuntimeCommands(): Promise<void> {
		for (const command of this.#store.runtimeCommandRows()) {
			if (command.disposed) continue;
			let state = command;
			if (state.status === "start_unknown") {
				await this.reconcileRuntimeCommandStart(state.commandId);
				state = this.#store.runtimeCommand(state.commandId) ?? state;
			}
			if (state.status === "running") await this.cancelRuntimeCommand(state.commandId, "SIGKILL");
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

	async retryDueSync(now: number = this.#now()): Promise<void> {
		for (const intent of this.#retryScheduler.list()) {
			if (intent.notBefore > now) continue;
			const pending = this.#store.pendingExecution(intent.backend);
			const runtimePending = this.#store.runtimePendingCommands(intent.backend);
			if (!pending && runtimePending.length === 0) continue;
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
				for (const command of runtimePending) {
					this.#store.saveRuntimeCommand({ ...command, sync: "complete", updatedAt: iso8601(this.#now()) });
				}
				await this.#retryScheduler.clear(result.backend);
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
			if (pending) {
				const failed = this.#store.markExecutionFailed(pending.id, reason, "exhausted");
				this.#auditExecutionComplete(failed, "failed", "SYNC_RETRY_EXHAUSTED");
			}
			for (const command of runtimePending) {
				this.#store.saveRuntimeCommand({
					...command,
					status: command.status === "succeeded" ? "failed" : command.status,
					sync: "exhausted",
					updatedAt: iso8601(this.#now()),
				});
			}
			await this.#retryScheduler.clear(intent.backend);
			this.#auditEvent("sync_retry", startedAt, "failed", { errorCode: "SYNC_RETRY_EXHAUSTED" });
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

	#startRuntimeCollector(commandId: string, handle: RuntimeHandle): void {
		if (this.#runtimeCollectors.has(commandId)) {
			handle[Symbol.dispose]();
			return;
		}
		this.#runtimeHandles.set(commandId, handle);
		const collector = this.#collectRuntimeCommand(commandId, handle).finally(() => {
			this.#runtimeHandles.delete(commandId);
			this.#runtimeCollectors.delete(commandId);
			handle[Symbol.dispose]();
		});
		this.#runtimeCollectors.set(commandId, collector);
		this.#waitUntil(collector);
	}

	async #collectRuntimeCommand(commandId: string, handle: RuntimeHandle): Promise<void> {
		let resultHandle: RuntimeHandle | undefined;
		try {
			const reader = handle.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value.id !== commandId || !Number.isSafeInteger(value.seq)) continue;
					this.#applyRuntimeCommandEvent(commandId, value);
				}
			} finally {
				reader.releaseLock();
			}
			resultHandle = await this.#workspace.runtime.getExec(commandId, { resume: "full", encoding: "utf8" });
			if (resultHandle.id !== commandId) return;
			await this.#applyRuntimeCommandResult(commandId, handle.backend, await resultHandle.result());
		} catch {
			// Durable state remains running/start-known. Inspection or recovery reconciles the backend without replay.
		} finally {
			resultHandle?.[Symbol.dispose]();
		}
	}

	#applyRuntimeCommandEvent(commandId: string, event: RuntimeEvent): void {
		const state = this.#store.runtimeCommand(commandId);
		if (!state || state.disposed || state.certainty === "completed" || event.seq <= state.lastSeq) return;
		let output = state.output;
		let outputBytes = state.outputBytes;
		let outputStoredBytes = state.outputStoredBytes;
		let truncated = state.truncated;
		let exitCode = state.exitCode;
		if (event.name === "stdout" || event.name === "stderr") {
			if (typeof event.value !== "string") return;
			const chunkBytes = runtimeEncoder.encode(event.value).byteLength;
			outputBytes += chunkBytes;
			const remaining = Math.max(0, state.outputByteLimit - outputStoredBytes);
			const appended = remaining === 0 ? "" : truncateRuntimeUtf8(event.value, remaining);
			const appendedBytes = runtimeEncoder.encode(appended).byteLength;
			output += appended;
			outputStoredBytes += appendedBytes;
			truncated ||= appendedBytes !== chunkBytes;
		} else if (event.name === "exit" && typeof event.value === "number" && Number.isSafeInteger(event.value)) {
			exitCode = event.value;
		}
		this.#store.saveRuntimeCommand({
			...state,
			output,
			outputBytes,
			outputStoredBytes,
			truncated,
			lastSeq: event.seq,
			exitCode,
			updatedAt: iso8601(this.#now()),
		});
	}

	async #applyRuntimeCommandResult(commandId: string, backend: string, result: RuntimeResult): Promise<void> {
		let state = this.#store.runtimeCommand(commandId);
		if (!state || state.disposed || state.certainty === "completed") return;
		const skipped = [...result.skipped, ...result.sync.skipped];
		let status: RuntimeCommandState["status"] =
			result.status === "completed" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed";
		let sync: RuntimeCommandState["sync"] = result.sync.status === "complete" ? "complete" : "pending";
		if (skipped.length !== 0) {
			status = "failed";
			sync = "exhausted";
		}
		state = this.#store.saveRuntimeCommand({
			...state,
			backend,
			status,
			certainty: "completed",
			proof: null,
			sync,
			exitCode: result.exitCode,
			updatedAt: iso8601(this.#now()),
		});
		if (sync === "pending") {
			const intent = await this.#retryScheduler.get(backend);
			if (!intent) {
				this.#store.saveRuntimeCommand({
					...state,
					status: "failed",
					sync: "exhausted",
					updatedAt: iso8601(this.#now()),
				});
			} else {
				await this.#alarms.rearm();
			}
		} else if (!this.#store.pendingExecution(backend) && this.#store.runtimePendingCommands(backend).length === 0) {
			await this.#retryScheduler.clear(backend);
		}
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
		const complete = this.#store.completeExecution(execId, status, result.status, result.exitCode);
		if (!this.#store.pendingExecution(backend) && this.#store.runtimePendingCommands(backend).length === 0) {
			await this.#retryScheduler.clear(backend);
		}
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

function iso8601(epochMs: number): string {
	return new Date(epochMs).toISOString();
}

function scrubbedRuntimeCommand(source: string): string {
	return `${RUNTIME_COMMAND_PREFIX}'${source.replace(/'/g, `'"'"'`)}'`;
}

function truncateRuntimeUtf8(value: string, byteLimit: number): string {
	const bytes = runtimeEncoder.encode(value);
	if (bytes.byteLength <= byteLimit) return value;
	let end = byteLimit;
	while (end > 0) {
		try {
			return runtimeDecoder.decode(bytes.subarray(0, end));
		} catch {
			end--;
		}
	}
	return "";
}
