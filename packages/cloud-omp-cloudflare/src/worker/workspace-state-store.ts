import type { SyncRetryIntent } from "@cloudflare/computer";
import { type ExecSnapshot, MAX_EXEC_OUTPUT_BYTES, type WorkspacePhase, type WorkspaceState } from "../protocol";
import { WorkspaceObjectError } from "./errors";

export interface SqlCursorLike<Row extends object = Record<string, unknown>> {
	toArray(): Row[];
}

export interface SqlStorageLike {
	sql: {
		exec<Row extends object = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursorLike<Row>;
	};
	transactionSync<T>(callback: () => T): T;
	getAlarm?(): Promise<number | null>;
	setAlarm(scheduledTime: number | Date): Promise<void>;
	deleteAlarm(): Promise<void>;
}

export const WORKSPACE_STATE_TABLE = "cloud_omp_workspace_state";
export const EXECUTIONS_TABLE = "cloud_omp_executions";
export const RETRY_INTENTS_TABLE = "cloud_omp_retry_intents";

export interface WorkspaceRow {
	workspaceIdSha256: string;
	auditCorrelationId: string;
	phase: WorkspacePhase;
	expiresAt: number;
	seedDigest: string;
	seedComplete: number;
	cleanupReason: "release" | "expiry" | null;
	workspaceClosed: number;
	mutationGeneration: number;
}

export interface ExecutionRow {
	id: string;
	backend: string;
	status: ExecSnapshot["status"];
	output: string;
	outputBytes: number;
	outputStoredBytes: number;
	outputByteLimit: number;
	truncated: number;
	lastSeq: number;
	sync: ExecSnapshot["sync"];
	resultStatus: "completed" | "failed" | "cancelled" | null;
	startedAt: number;
	exitCode: number | null;
	signal: string | null;
	error: string | null;
}

export interface ExecutionOutputEvent {
	seq: number;
	name: "stdout" | "stderr" | "result" | "exit";
	value: unknown;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class WorkspaceStateStore {
	constructor(readonly storage: SqlStorageLike) {
		if (typeof storage.transactionSync !== "function") {
			throw new TypeError("WorkspaceStateStore requires transactionSync storage");
		}
	}

	initialize(): void {
		this.storage.transactionSync(() => {
			this.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS ${WORKSPACE_STATE_TABLE} (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					workspaceIdSha256 TEXT NOT NULL,
					auditCorrelationId TEXT NOT NULL,
					phase TEXT NOT NULL CHECK (phase IN ('active', 'quiescing', 'quiesced', 'released')),
					expiresAt REAL NOT NULL,
					seedDigest TEXT NOT NULL,
					seedComplete INTEGER NOT NULL DEFAULT 0,
					cleanupReason TEXT CHECK (cleanupReason IS NULL OR cleanupReason IN ('release', 'expiry')),
					workspaceClosed INTEGER NOT NULL DEFAULT 0,
					mutationGeneration INTEGER NOT NULL DEFAULT 0
				)
			`);
			this.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS ${EXECUTIONS_TABLE} (
					id TEXT PRIMARY KEY,
					backend TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'completed', 'failed', 'cancelled')),
					output TEXT NOT NULL DEFAULT '',
					outputBytes INTEGER NOT NULL DEFAULT 0,
					outputStoredBytes INTEGER NOT NULL DEFAULT 0,
					outputByteLimit INTEGER NOT NULL,
					truncated INTEGER NOT NULL DEFAULT 0,
					lastSeq REAL NOT NULL DEFAULT -1,
					sync TEXT NOT NULL DEFAULT 'pending' CHECK (sync IN ('pending', 'complete', 'exhausted')),
					resultStatus TEXT CHECK (resultStatus IS NULL OR resultStatus IN ('completed', 'failed', 'cancelled')),
					startedAt REAL NOT NULL,
					exitCode REAL,
					signal TEXT,
					error TEXT
				)
			`);
			this.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS ${RETRY_INTENTS_TABLE} (
					backend TEXT PRIMARY KEY,
					attempt INTEGER NOT NULL,
					notBefore REAL NOT NULL
				)
			`);
		});
	}

	workspace(): WorkspaceRow | undefined {
		return this.storage.sql
			.exec<WorkspaceRow>(
				`SELECT workspaceIdSha256, auditCorrelationId, phase, expiresAt, seedDigest, seedComplete,
				        cleanupReason, workspaceClosed, mutationGeneration
				 FROM ${WORKSPACE_STATE_TABLE} WHERE singleton = 1`,
			)
			.toArray()[0];
	}

	executionRows(): ExecutionRow[] {
		return this.storage.sql
			.exec<ExecutionRow>(
				`SELECT id, backend, status, output, outputBytes, outputStoredBytes, outputByteLimit, truncated,
				        lastSeq, sync, resultStatus, startedAt, exitCode, signal, error
				 FROM ${EXECUTIONS_TABLE} ORDER BY id`,
			)
			.toArray();
	}

	execution(execId: string): ExecutionRow | undefined {
		return this.storage.sql
			.exec<ExecutionRow>(
				`SELECT id, backend, status, output, outputBytes, outputStoredBytes, outputByteLimit, truncated,
				        lastSeq, sync, resultStatus, startedAt, exitCode, signal, error
				 FROM ${EXECUTIONS_TABLE} WHERE id = ?`,
				execId,
			)
			.toArray()[0];
	}

	requireExecution(execId: string): ExecutionRow {
		const row = this.execution(execId);
		if (!row) throw new WorkspaceObjectError(404, "execution_not_found", "Execution does not exist");
		return row;
	}

	insertWorkspace(input: {
		workspaceIdSha256: string;
		auditCorrelationId: string;
		expiresAt: number;
		seedDigest: string;
	}): WorkspaceRow {
		return this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`INSERT OR IGNORE INTO ${WORKSPACE_STATE_TABLE}
				 (singleton, workspaceIdSha256, auditCorrelationId, phase, expiresAt, seedDigest, seedComplete,
				  cleanupReason, workspaceClosed, mutationGeneration)
				 VALUES (1, ?, ?, 'active', ?, ?, 0, NULL, 0, 0)`,
				input.workspaceIdSha256,
				input.auditCorrelationId,
				input.expiresAt,
				input.seedDigest,
			);
			const row = this.workspace();
			if (!row)
				throw new WorkspaceObjectError(500, "workspace_state_lost", "Workspace state could not be persisted");
			return row;
		});
	}

	markSeedComplete(): WorkspaceRow | undefined {
		return this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`UPDATE ${WORKSPACE_STATE_TABLE}
				 SET seedComplete = 1
				 WHERE singleton = 1 AND phase = 'active' AND cleanupReason IS NULL`,
			);
			return this.workspace();
		});
	}

	reserveExecution(input: {
		id: string;
		backend: string;
		outputByteLimit: number;
		startedAt: number;
		now: number;
		mutationGeneration: number;
	}): void {
		this.storage.transactionSync(() => {
			const state = this.workspace();
			if (
				state?.phase !== "active" ||
				!state.seedComplete ||
				input.now >= state.expiresAt ||
				state.mutationGeneration !== input.mutationGeneration
			) {
				throw new WorkspaceObjectError(409, "invalid_workspace_phase", "Workspace is not available for execution");
			}
			if (this.activeExecutionCount() !== 0) {
				throw new WorkspaceObjectError(409, "execution_active", "Workspace already has an active execution");
			}
			this.storage.sql.exec(
				`INSERT INTO ${EXECUTIONS_TABLE}
				 (id, backend, status, output, outputBytes, outputStoredBytes, outputByteLimit, truncated, lastSeq, sync, startedAt)
				 VALUES (?, ?, 'starting', '', 0, 0, ?, 0, -1, 'pending', ?)`,
				input.id,
				input.backend,
				input.outputByteLimit,
				input.startedAt,
			);
		});
	}

	markExecutionRunning(execId: string, backend: string, mutationGeneration: number): boolean {
		return this.storage.transactionSync(() => {
			const state = this.workspace();
			if (state?.phase !== "active" || state.mutationGeneration !== mutationGeneration) return false;
			this.storage.sql.exec(
				`UPDATE ${EXECUTIONS_TABLE} SET status = 'running', backend = ? WHERE id = ? AND status = 'starting'`,
				backend,
				execId,
			);
			return this.execution(execId)?.status === "running";
		});
	}

	applyExecutionEvent(execId: string, event: ExecutionOutputEvent): boolean {
		return this.storage.transactionSync(() => {
			const row = this.requireExecution(execId);
			if (isTerminal(row.status) || event.seq <= row.lastSeq) return row.outputBytes > MAX_EXEC_OUTPUT_BYTES;
			let output = row.output;
			let outputBytes = row.outputBytes;
			let outputStoredBytes = row.outputStoredBytes;
			let truncated = Boolean(row.truncated);
			let exitCode = row.exitCode;
			if (event.name === "stdout" || event.name === "stderr") {
				if (typeof event.value !== "string") throw new Error("Remote execution emitted malformed UTF-8 output");
				const chunkBytes = encoder.encode(event.value).byteLength;
				outputBytes += chunkBytes;
				const remaining = Math.max(0, row.outputByteLimit - outputStoredBytes);
				const appended = remaining > 0 ? truncateUtf8(event.value, remaining) : "";
				const appendedBytes = encoder.encode(appended).byteLength;
				output += appended;
				outputStoredBytes += appendedBytes;
				if (chunkBytes > appendedBytes) truncated = true;
			} else if (event.name === "exit" && typeof event.value === "number") {
				exitCode = event.value;
			}
			this.storage.sql.exec(
				`UPDATE ${EXECUTIONS_TABLE}
				 SET output = ?, outputBytes = ?, outputStoredBytes = ?, truncated = ?, lastSeq = ?, exitCode = ?
				 WHERE id = ? AND lastSeq < ?`,
				output,
				outputBytes,
				outputStoredBytes,
				truncated ? 1 : 0,
				event.seq,
				exitCode,
				execId,
				event.seq,
			);
			if (outputBytes > MAX_EXEC_OUTPUT_BYTES) {
				this.storage.sql.exec(
					`UPDATE ${EXECUTIONS_TABLE} SET truncated = 1, error = 'Execution output exceeded the hard cap' WHERE id = ?`,
					execId,
				);
			}
			return outputBytes > MAX_EXEC_OUTPUT_BYTES;
		});
	}

	markExecutionPending(
		execId: string,
		backend: string,
		resultStatus: ExecutionRow["resultStatus"],
		exitCode: number,
	): ExecutionRow {
		return this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`UPDATE ${EXECUTIONS_TABLE}
				 SET status = 'running', sync = 'pending', resultStatus = ?, exitCode = ?, backend = ?
				 WHERE id = ? AND status IN ('starting', 'running')`,
				resultStatus,
				exitCode,
				backend,
				execId,
			);
			return this.requireExecution(execId);
		});
	}

	completeExecution(
		execId: string,
		status: ExecSnapshot["status"],
		resultStatus: ExecutionRow["resultStatus"],
		exitCode: number,
	): ExecutionRow {
		return this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`UPDATE ${EXECUTIONS_TABLE}
				 SET status = ?, sync = 'complete', resultStatus = ?, exitCode = ?
				 WHERE id = ? AND status IN ('starting', 'running')`,
				status,
				resultStatus,
				exitCode,
				execId,
			);
			return this.requireExecution(execId);
		});
	}

	markExecutionFailed(
		execId: string,
		message: string,
		sync: ExecSnapshot["sync"],
		exitCode: number | null = null,
	): ExecutionRow {
		return this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`UPDATE ${EXECUTIONS_TABLE}
				 SET status = 'failed', sync = ?, error = ?, exitCode = COALESCE(?, exitCode)
				 WHERE id = ? AND status IN ('starting', 'running')`,
				sync,
				message,
				exitCode,
				execId,
			);
			return this.requireExecution(execId);
		});
	}

	deleteExecution(execId: string): { backend: string; backendUnused: boolean } | undefined {
		return this.storage.transactionSync(() => {
			const row = this.execution(execId);
			if (!row) return undefined;
			this.storage.sql.exec(`DELETE FROM ${EXECUTIONS_TABLE} WHERE id = ?`, execId);
			const backendUnused = !this.storage.sql
				.exec<{ present: number }>(
					`SELECT 1 AS present FROM ${EXECUTIONS_TABLE} WHERE backend = ? LIMIT 1`,
					row.backend,
				)
				.toArray()[0];
			if (backendUnused) this.storage.sql.exec(`DELETE FROM ${RETRY_INTENTS_TABLE} WHERE backend = ?`, row.backend);
			return { backend: row.backend, backendUnused };
		});
	}

	beginQuiesce(): WorkspaceRow | undefined {
		return this.transitionWorkspace("active", "quiescing", true);
	}

	finishQuiesce(): WorkspaceRow | undefined {
		return this.transitionWorkspace("quiescing", "quiesced", true);
	}

	beginRestart(): WorkspaceRow | undefined {
		return this.transitionWorkspace("active", "quiescing", true);
	}

	finishRestart(): WorkspaceRow | undefined {
		return this.transitionWorkspace("quiescing", "active", true);
	}

	beginCleanup(reason: "release" | "expiry"): WorkspaceRow | undefined {
		return this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`UPDATE ${WORKSPACE_STATE_TABLE}
				 SET phase = 'quiescing', mutationGeneration = mutationGeneration + 1,
				     cleanupReason = CASE WHEN cleanupReason = 'expiry' THEN 'expiry' ELSE ? END
				 WHERE singleton = 1 AND phase != 'released'`,
				reason,
			);
			return this.workspace();
		});
	}

	beginExpiryCleanup(): WorkspaceRow | undefined {
		return this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`UPDATE ${WORKSPACE_STATE_TABLE}
				 SET phase = 'quiescing', cleanupReason = 'expiry', mutationGeneration = mutationGeneration + 1
				 WHERE singleton = 1 AND phase != 'released'`,
			);
			this.storage.sql.exec(
				`UPDATE ${EXECUTIONS_TABLE}
				 SET status = CASE WHEN status = 'starting' THEN 'failed' ELSE 'cancelled' END,
				     sync = CASE WHEN sync = 'complete' THEN 'complete' ELSE 'exhausted' END,
				     error = 'Workspace expiry cleanup took precedence'
				 WHERE status IN ('starting', 'running')`,
			);
			return this.workspace();
		});
	}

	completeRelease(reason: "release" | "expiry"): WorkspaceRow | undefined {
		return this.storage.transactionSync(() => {
			this.storage.sql.exec(`DELETE FROM ${EXECUTIONS_TABLE}`);
			this.storage.sql.exec(`DELETE FROM ${RETRY_INTENTS_TABLE}`);
			this.storage.sql.exec(
				`UPDATE ${WORKSPACE_STATE_TABLE}
				 SET phase = 'released', workspaceClosed = 1, cleanupReason = ?
				 WHERE singleton = 1 AND phase = 'quiescing'`,
				reason,
			);
			return this.workspace();
		});
	}

	markAllUnsettledSyncExhausted(): void {
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`UPDATE ${EXECUTIONS_TABLE} SET sync = CASE WHEN sync = 'complete' THEN 'complete' ELSE 'exhausted' END`,
			);
		});
	}

	activeExecutionCount(): number {
		return Number(
			this.storage.sql
				.exec<{ count: number }>(
					`SELECT COUNT(*) AS count FROM ${EXECUTIONS_TABLE} WHERE status IN ('starting', 'running')`,
				)
				.toArray()[0]?.count ?? 0,
		);
	}

	hasUnsettledSync(): boolean {
		const row = this.storage.sql
			.exec<{ pending: number; exhausted: number }>(
				`SELECT
				 SUM(CASE WHEN sync = 'pending' THEN 1 ELSE 0 END) AS pending,
				 SUM(CASE WHEN sync = 'exhausted' THEN 1 ELSE 0 END) AS exhausted
				 FROM ${EXECUTIONS_TABLE}`,
			)
			.toArray()[0];
		return Number(row?.pending ?? 0) !== 0 || Number(row?.exhausted ?? 0) !== 0;
	}

	stateSnapshot(phase: WorkspacePhase): WorkspaceState {
		const rows = this.executionRows();
		return {
			phase,
			activeExecutions: rows.filter(row => !isTerminal(row.status)).length,
			pendingSyncs: rows.filter(row => row.sync === "pending").length,
			exhaustedSyncs: rows.filter(row => row.sync === "exhausted").length,
		};
	}

	pendingExecution(backend: string): ExecutionRow | undefined {
		return this.storage.sql
			.exec<ExecutionRow>(
				`SELECT id, backend, status, output, outputBytes, outputStoredBytes, outputByteLimit, truncated,
				        lastSeq, sync, resultStatus, startedAt, exitCode, signal, error
				 FROM ${EXECUTIONS_TABLE} WHERE backend = ? AND sync = 'pending' ORDER BY id LIMIT 1`,
				backend,
			)
			.toArray()[0];
	}

	completePendingSync(backend: string): ExecutionRow | undefined {
		return this.storage.transactionSync(() => {
			const pending = this.pendingExecution(backend);
			if (!pending) return undefined;
			this.storage.sql.exec(
				`UPDATE ${EXECUTIONS_TABLE} SET status = ?, sync = 'complete' WHERE id = ? AND sync = 'pending'`,
				pending.resultStatus ?? "failed",
				pending.id,
			);
			this.storage.sql.exec(`DELETE FROM ${RETRY_INTENTS_TABLE} WHERE backend = ?`, backend);
			return this.execution(pending.id);
		});
	}

	getRetry(backend: string): SyncRetryIntent | undefined {
		const row = this.storage.sql
			.exec<{ backend: string; attempt: number; notBefore: number }>(
				`SELECT backend, attempt, notBefore FROM ${RETRY_INTENTS_TABLE} WHERE backend = ?`,
				backend,
			)
			.toArray()[0];
		return row ? { backend: row.backend, attempt: row.attempt, notBefore: row.notBefore } : undefined;
	}

	listRetries(): SyncRetryIntent[] {
		return this.storage.sql
			.exec<{ backend: string; attempt: number; notBefore: number }>(
				`SELECT backend, attempt, notBefore FROM ${RETRY_INTENTS_TABLE} ORDER BY notBefore, backend`,
			)
			.toArray()
			.map(row => ({ backend: row.backend, attempt: row.attempt, notBefore: row.notBefore }));
	}

	scheduleRetry(intent: SyncRetryIntent): void {
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`INSERT INTO ${RETRY_INTENTS_TABLE} (backend, attempt, notBefore)
				 VALUES (?, ?, ?)
				 ON CONFLICT(backend) DO UPDATE SET attempt = excluded.attempt, notBefore = excluded.notBefore`,
				intent.backend,
				intent.attempt,
				intent.notBefore,
			);
		});
	}

	clearRetry(backend: string): void {
		this.storage.transactionSync(() => {
			this.storage.sql.exec(`DELETE FROM ${RETRY_INTENTS_TABLE} WHERE backend = ?`, backend);
		});
	}

	clearRetries(): void {
		this.storage.transactionSync(() => {
			this.storage.sql.exec(`DELETE FROM ${RETRY_INTENTS_TABLE}`);
		});
	}

	alarmTarget(): number | undefined {
		const state = this.workspace();
		if (!state || state.phase === "released") return undefined;
		const pending = this.storage.sql
			.exec<{ notBefore: number | null }>(
				`SELECT MIN(r.notBefore) AS notBefore
				 FROM ${RETRY_INTENTS_TABLE} r
				 WHERE EXISTS (
					 SELECT 1 FROM ${EXECUTIONS_TABLE} e
					 WHERE e.backend = r.backend AND e.sync = 'pending'
				 )`,
			)
			.toArray()[0]?.notBefore;
		const target = Math.min(state.expiresAt, pending ?? Number.POSITIVE_INFINITY);
		return Number.isFinite(target) ? target : undefined;
	}

	private transitionWorkspace(
		from: WorkspacePhase,
		to: WorkspacePhase,
		requireNoCleanup: boolean,
	): WorkspaceRow | undefined {
		return this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`UPDATE ${WORKSPACE_STATE_TABLE} SET phase = ?
				 WHERE singleton = 1 AND phase = ?${requireNoCleanup ? " AND cleanupReason IS NULL" : ""}`,
				to,
				from,
			);
			return this.workspace();
		});
	}
}

export function isTerminalExecution(status: ExecSnapshot["status"]): boolean {
	return isTerminal(status);
}

function isTerminal(status: ExecSnapshot["status"]): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function truncateUtf8(value: string, byteLimit: number): string {
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= byteLimit) return value;
	let end = byteLimit;
	while (end > 0) {
		try {
			return decoder.decode(bytes.subarray(0, end));
		} catch {
			end--;
		}
	}
	return "";
}
