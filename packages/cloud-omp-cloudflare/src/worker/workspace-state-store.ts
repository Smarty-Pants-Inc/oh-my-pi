import type { SyncRetryIntent } from "@cloudflare/computer";
import type {
	ReplicaCheckpoint,
	RuntimeCommandSnapshot,
	RuntimeLeaseRef,
	RuntimeProviderPhase,
	RuntimeProviderRequestIdentity,
	RuntimeReplicaDeleteResult,
	RuntimeReplicaDeletionAuthorizationV1,
	RuntimeReplicaRef,
	WorkspaceImage,
	WorkspaceTombstone,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import {
	type CloudflareDeadlineSummaryV1,
	type CloudflareDurableDeadlineV1,
	type ExecSnapshot,
	MAX_EXEC_OUTPUT_BYTES,
	summarizeCloudflareDurableDeadlinesV1,
	type WorkspacePhase,
	type WorkspaceState,
} from "../protocol";
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
export const RUNTIME_REPLICA_TABLE = "cloud_omp_runtime_replica";
export const RUNTIME_REQUESTS_TABLE = "cloud_omp_runtime_requests";
export const RUNTIME_CHECKPOINTS_TABLE = "cloud_omp_runtime_checkpoints";
export const RUNTIME_DEADLINES_TABLE = "cloud_omp_runtime_deadlines";
export const RUNTIME_COMMANDS_TABLE = "cloud_omp_runtime_commands";

export interface RuntimeReplicaTombstone {
	request: RuntimeProviderRequestIdentity;
	authorization: RuntimeReplicaDeletionAuthorizationV1;
	tombstone: WorkspaceTombstone | null;
	result: RuntimeReplicaDeleteResult;
}

export interface RuntimeReplicaState {
	replica: RuntimeReplicaRef;
	lease: RuntimeLeaseRef;
	fenceVerifierSha256: string;
	deletionAuthorityDomain: RuntimeReplicaDeletionAuthorizationV1["domain"];
	providerPhase: RuntimeProviderPhase;
	replicaImage: WorkspaceImage | null;
	admissionClosed: boolean;
	tombstone: RuntimeReplicaTombstone | null;
	updatedAtEpochMs: number;
}

export interface RuntimeRequestState {
	requestId: string;
	requestSha256: string;
	operation: string;
	canonicalTupleUtf8: string;
	request: unknown;
	state: "reserved" | "outcome_unknown" | "complete";
	result: unknown | null;
	updatedAtEpochMs: number;
}

export interface RuntimeCheckpointState {
	checkpointId: string;
	locator: unknown;
	reference: unknown;
	checkpoint: ReplicaCheckpoint | null;
	canonicalCommit: unknown | null;
	acknowledgedAt: string | null;
}

export interface RuntimeCommandState {
	commandId: string;
	requestSha256: string;
	context: unknown;
	status: RuntimeCommandSnapshot["status"];
	certainty: "not_started" | "unknown" | "started" | "completed";
	proof: "reservation_without_attempt" | "backend_absent" | null;
	backend: string;
	output: string;
	outputBytes: number;
	outputStoredBytes: number;
	outputByteLimit: number;
	truncated: boolean;
	lastSeq: number;
	sync: RuntimeCommandSnapshot["sync"];
	exitCode: number | null;
	signal: RuntimeCommandSnapshot["signal"];
	updatedAt: string;
	disposed: boolean;
}

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
			this.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS ${RUNTIME_REPLICA_TABLE} (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					replicaJson TEXT NOT NULL,
					leaseJson TEXT NOT NULL,
					fenceVerifierSha256 TEXT NOT NULL,
					deletionAuthorityDomain TEXT NOT NULL,
					providerPhase TEXT NOT NULL,
					replicaImageJson TEXT,
					admissionClosed INTEGER NOT NULL,
					tombstoneJson TEXT,
					updatedAtEpochMs INTEGER NOT NULL
				)
			`);
			this.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS ${RUNTIME_REQUESTS_TABLE} (
					requestId TEXT PRIMARY KEY,
					requestSha256 TEXT NOT NULL,
					operation TEXT NOT NULL,
					canonicalTupleUtf8 TEXT NOT NULL,
					requestJson TEXT NOT NULL,
					state TEXT NOT NULL,
					resultJson TEXT,
					updatedAtEpochMs INTEGER NOT NULL
				)
			`);
			this.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS ${RUNTIME_CHECKPOINTS_TABLE} (
					checkpointId TEXT PRIMARY KEY,
					locatorJson TEXT NOT NULL,
					referenceJson TEXT NOT NULL,
					checkpointJson TEXT,
					canonicalCommitJson TEXT,
					acknowledgedAt TEXT
				)
			`);
			this.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS ${RUNTIME_DEADLINES_TABLE} (
					kind TEXT NOT NULL,
					deadlineKey TEXT NOT NULL,
					dueAtEpochMs INTEGER NOT NULL,
					deadlineJson TEXT NOT NULL,
					PRIMARY KEY (kind, deadlineKey)
				)
			`);
			this.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS ${RUNTIME_COMMANDS_TABLE} (
					commandId TEXT PRIMARY KEY,
					requestSha256 TEXT NOT NULL,
					contextJson TEXT NOT NULL,
					status TEXT NOT NULL,
					certainty TEXT NOT NULL,
					proof TEXT,
					backend TEXT NOT NULL,
					output TEXT NOT NULL,
					outputBytes INTEGER NOT NULL,
					outputStoredBytes INTEGER NOT NULL,
					outputByteLimit INTEGER NOT NULL,
					truncated INTEGER NOT NULL,
					lastSeq INTEGER NOT NULL,
					sync TEXT NOT NULL,
					exitCode INTEGER,
					signal TEXT,
					updatedAt TEXT NOT NULL,
					disposed INTEGER NOT NULL
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

	runtimeReplica(): RuntimeReplicaState | undefined {
		const row = this.storage.sql
			.exec<{
				replicaJson: string;
				leaseJson: string;
				fenceVerifierSha256: string;
				deletionAuthorityDomain: RuntimeReplicaDeletionAuthorizationV1["domain"];
				providerPhase: RuntimeProviderPhase;
				replicaImageJson: string | null;
				admissionClosed: number;
				tombstoneJson: string | null;
				updatedAtEpochMs: number;
			}>(
				`SELECT replicaJson, leaseJson, fenceVerifierSha256, deletionAuthorityDomain, providerPhase,
				        replicaImageJson, admissionClosed, tombstoneJson, updatedAtEpochMs
				 FROM ${RUNTIME_REPLICA_TABLE} WHERE singleton = 1`,
			)
			.toArray()[0];
		if (!row) return undefined;
		return {
			replica: parseJson(row.replicaJson),
			lease: parseJson(row.leaseJson),
			fenceVerifierSha256: row.fenceVerifierSha256,
			deletionAuthorityDomain: row.deletionAuthorityDomain,
			providerPhase: row.providerPhase,
			replicaImage: row.replicaImageJson === null ? null : parseJson(row.replicaImageJson),
			admissionClosed: Boolean(row.admissionClosed),
			tombstone: row.tombstoneJson === null ? null : parseJson(row.tombstoneJson),
			updatedAtEpochMs: Number(row.updatedAtEpochMs),
		};
	}

	saveRuntimeReplica(state: RuntimeReplicaState): RuntimeReplicaState {
		return this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`INSERT INTO ${RUNTIME_REPLICA_TABLE}
				 (singleton, replicaJson, leaseJson, fenceVerifierSha256, deletionAuthorityDomain, providerPhase,
				  replicaImageJson, admissionClosed, tombstoneJson, updatedAtEpochMs)
				 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(singleton) DO UPDATE SET
				  replicaJson = excluded.replicaJson,
				  leaseJson = excluded.leaseJson,
				  fenceVerifierSha256 = excluded.fenceVerifierSha256,
				  deletionAuthorityDomain = excluded.deletionAuthorityDomain,
				  providerPhase = excluded.providerPhase,
				  replicaImageJson = excluded.replicaImageJson,
				  admissionClosed = excluded.admissionClosed,
				  tombstoneJson = excluded.tombstoneJson,
				  updatedAtEpochMs = excluded.updatedAtEpochMs`,
				canonicalJson(state.replica),
				canonicalJson(state.lease),
				state.fenceVerifierSha256,
				state.deletionAuthorityDomain,
				state.providerPhase,
				state.replicaImage === null ? null : canonicalJson(state.replicaImage),
				state.admissionClosed ? 1 : 0,
				state.tombstone === null ? null : canonicalJson(state.tombstone),
				state.updatedAtEpochMs,
			);
			const persisted = this.runtimeReplica();
			if (!persisted) throw new WorkspaceObjectError(500, "workspace_state_lost", "Runtime replica state was lost");
			return persisted;
		});
	}

	runtimeRequest(requestId: string): RuntimeRequestState | undefined {
		const row = this.storage.sql
			.exec<{
				requestId: string;
				requestSha256: string;
				operation: string;
				canonicalTupleUtf8: string;
				requestJson: string;
				state: RuntimeRequestState["state"];
				resultJson: string | null;
				updatedAtEpochMs: number;
			}>(
				`SELECT requestId, requestSha256, operation, canonicalTupleUtf8, requestJson, state, resultJson,
				        updatedAtEpochMs FROM ${RUNTIME_REQUESTS_TABLE} WHERE requestId = ?`,
				requestId,
			)
			.toArray()[0];
		if (!row) return undefined;
		return {
			requestId: row.requestId,
			requestSha256: row.requestSha256,
			operation: row.operation,
			canonicalTupleUtf8: row.canonicalTupleUtf8,
			request: parseJson(row.requestJson),
			state: row.state,
			result: row.resultJson === null ? null : parseJson(row.resultJson),
			updatedAtEpochMs: Number(row.updatedAtEpochMs),
		};
	}

	reserveRuntimeRequest(input: Omit<RuntimeRequestState, "state" | "result">): RuntimeRequestState {
		return this.storage.transactionSync(() => {
			const existing = this.runtimeRequest(input.requestId);
			if (existing) {
				if (
					existing.requestSha256 !== input.requestSha256 ||
					existing.operation !== input.operation ||
					existing.canonicalTupleUtf8 !== input.canonicalTupleUtf8 ||
					canonicalJson(existing.request) !== canonicalJson(input.request)
				) {
					throw new WorkspaceObjectError(
						409,
						"request_conflict",
						"Runtime request identity conflicts with its reservation",
					);
				}
				return existing;
			}
			this.storage.sql.exec(
				`INSERT INTO ${RUNTIME_REQUESTS_TABLE}
				 (requestId, requestSha256, operation, canonicalTupleUtf8, requestJson, state, resultJson, updatedAtEpochMs)
				 VALUES (?, ?, ?, ?, ?, 'reserved', NULL, ?)`,
				input.requestId,
				input.requestSha256,
				input.operation,
				input.canonicalTupleUtf8,
				canonicalJson(input.request),
				input.updatedAtEpochMs,
			);
			return this.runtimeRequest(input.requestId)!;
		});
	}

	markRuntimeRequestOutcomeUnknown(
		requestId: string,
		updatedAtEpochMs: number,
		reconciliationEvidence: unknown = null,
	): RuntimeRequestState {
		return this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`UPDATE ${RUNTIME_REQUESTS_TABLE}
				 SET state = 'outcome_unknown', resultJson = ?, updatedAtEpochMs = ?
				 WHERE requestId = ? AND state = 'reserved'`,
				canonicalJson(reconciliationEvidence),
				updatedAtEpochMs,
				requestId,
			);
			const row = this.runtimeRequest(requestId);
			if (!row) throw new WorkspaceObjectError(500, "workspace_state_lost", "Runtime request reservation was lost");
			return row;
		});
	}

	completeRuntimeRequest(requestId: string, result: unknown, updatedAtEpochMs: number): RuntimeRequestState {
		return this.storage.transactionSync(() => {
			const existing = this.runtimeRequest(requestId);
			if (!existing)
				throw new WorkspaceObjectError(500, "workspace_state_lost", "Runtime request reservation was lost");
			if (existing.state === "complete") {
				if (canonicalJson(existing.result) !== canonicalJson(result)) {
					throw new WorkspaceObjectError(
						409,
						"request_conflict",
						"Runtime request result conflicts with its durable outcome",
					);
				}
				return existing;
			}
			this.storage.sql.exec(
				`UPDATE ${RUNTIME_REQUESTS_TABLE} SET state = 'complete', resultJson = ?, updatedAtEpochMs = ?
				 WHERE requestId = ?`,
				canonicalJson(result),
				updatedAtEpochMs,
				requestId,
			);
			return this.runtimeRequest(requestId)!;
		});
	}

	replaceRuntimeRequestResult(requestId: string, result: unknown, updatedAtEpochMs: number): RuntimeRequestState {
		return this.storage.transactionSync(() => {
			if (!this.runtimeRequest(requestId)) {
				throw new WorkspaceObjectError(500, "workspace_state_lost", "Runtime request reservation was lost");
			}
			this.storage.sql.exec(
				`UPDATE ${RUNTIME_REQUESTS_TABLE} SET state = 'complete', resultJson = ?, updatedAtEpochMs = ? WHERE requestId = ?`,
				canonicalJson(result),
				updatedAtEpochMs,
				requestId,
			);
			return this.runtimeRequest(requestId)!;
		});
	}

	runtimeCheckpoint(checkpointId: string): RuntimeCheckpointState | undefined {
		const row = this.storage.sql
			.exec<{
				checkpointId: string;
				locatorJson: string;
				referenceJson: string;
				checkpointJson: string | null;
				canonicalCommitJson: string | null;
				acknowledgedAt: string | null;
			}>(
				`SELECT checkpointId, locatorJson, referenceJson, checkpointJson, canonicalCommitJson, acknowledgedAt
				 FROM ${RUNTIME_CHECKPOINTS_TABLE} WHERE checkpointId = ?`,
				checkpointId,
			)
			.toArray()[0];
		if (!row) return undefined;
		return {
			checkpointId: row.checkpointId,
			locator: parseJson(row.locatorJson),
			reference: parseJson(row.referenceJson),
			checkpoint: row.checkpointJson === null ? null : parseJson(row.checkpointJson),
			canonicalCommit: row.canonicalCommitJson === null ? null : parseJson(row.canonicalCommitJson),
			acknowledgedAt: row.acknowledgedAt,
		};
	}

	saveRuntimeCheckpoint(state: RuntimeCheckpointState): RuntimeCheckpointState {
		return this.storage.transactionSync(() => {
			const existing = this.runtimeCheckpoint(state.checkpointId);
			if (existing && canonicalJson(existing.reference) !== canonicalJson(state.reference)) {
				throw new WorkspaceObjectError(
					409,
					"request_conflict",
					"Checkpoint identity conflicts with its frozen reference",
				);
			}
			this.storage.sql.exec(
				`INSERT INTO ${RUNTIME_CHECKPOINTS_TABLE}
				 (checkpointId, locatorJson, referenceJson, checkpointJson, canonicalCommitJson, acknowledgedAt)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(checkpointId) DO UPDATE SET
				  checkpointJson = COALESCE(${RUNTIME_CHECKPOINTS_TABLE}.checkpointJson, excluded.checkpointJson),
				  canonicalCommitJson = COALESCE(${RUNTIME_CHECKPOINTS_TABLE}.canonicalCommitJson, excluded.canonicalCommitJson),
				  acknowledgedAt = COALESCE(${RUNTIME_CHECKPOINTS_TABLE}.acknowledgedAt, excluded.acknowledgedAt)`,
				state.checkpointId,
				canonicalJson(state.locator),
				canonicalJson(state.reference),
				state.checkpoint === null ? null : canonicalJson(state.checkpoint),
				state.canonicalCommit === null ? null : canonicalJson(state.canonicalCommit),
				state.acknowledgedAt,
			);
			return this.runtimeCheckpoint(state.checkpointId)!;
		});
	}

	acknowledgeRuntimeCheckpoint(
		checkpointId: string,
		canonicalCommit: unknown,
		acknowledgedAt: string,
	): RuntimeCheckpointState {
		return this.storage.transactionSync(() => {
			const checkpoint = this.runtimeCheckpoint(checkpointId);
			if (!checkpoint) throw new WorkspaceObjectError(404, "protocol_invalid", "Frozen checkpoint does not exist");
			if (
				checkpoint.canonicalCommit !== null &&
				canonicalJson(checkpoint.canonicalCommit) !== canonicalJson(canonicalCommit)
			) {
				throw new WorkspaceObjectError(
					409,
					"request_conflict",
					"Checkpoint acknowledgement conflicts with durable state",
				);
			}
			this.storage.sql.exec(
				`UPDATE ${RUNTIME_CHECKPOINTS_TABLE}
				 SET canonicalCommitJson = ?, acknowledgedAt = ?, checkpointJson = NULL WHERE checkpointId = ?`,
				canonicalJson(canonicalCommit),
				acknowledgedAt,
				checkpointId,
			);
			return this.runtimeCheckpoint(checkpointId)!;
		});
	}

	runtimeCheckpointRows(): RuntimeCheckpointState[] {
		return this.storage.sql
			.exec<{ checkpointId: string }>(`SELECT checkpointId FROM ${RUNTIME_CHECKPOINTS_TABLE} ORDER BY checkpointId`)
			.toArray()
			.map(row => this.runtimeCheckpoint(row.checkpointId)!)
			.filter(Boolean);
	}

	unacknowledgedRuntimeCheckpointCount(): number {
		return Number(
			this.storage.sql
				.exec<{ count: number }>(
					`SELECT COUNT(*) AS count FROM ${RUNTIME_CHECKPOINTS_TABLE} WHERE acknowledgedAt IS NULL`,
				)
				.toArray()[0]?.count ?? 0,
		);
	}

	purgeRuntimeReplicaPayloadState(): void {
		this.storage.transactionSync(() => {
			this.storage.sql.exec(`UPDATE ${RUNTIME_CHECKPOINTS_TABLE} SET checkpointJson = NULL`);
			this.storage.sql.exec(`DELETE FROM ${RUNTIME_COMMANDS_TABLE}`);
			this.storage.sql.exec(`DELETE FROM ${RUNTIME_DEADLINES_TABLE}`);
		});
	}

	putRuntimeDeadline(deadline: CloudflareDurableDeadlineV1): void {
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				`INSERT INTO ${RUNTIME_DEADLINES_TABLE} (kind, deadlineKey, dueAtEpochMs, deadlineJson)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(kind, deadlineKey) DO UPDATE SET dueAtEpochMs = excluded.dueAtEpochMs, deadlineJson = excluded.deadlineJson`,
				deadline.kind,
				deadline.key,
				deadline.dueAtEpochMs,
				canonicalJson(deadline),
			);
		});
	}

	deleteRuntimeDeadline(kind: CloudflareDurableDeadlineV1["kind"], key: string): void {
		this.storage.transactionSync(() => {
			this.storage.sql.exec(`DELETE FROM ${RUNTIME_DEADLINES_TABLE} WHERE kind = ? AND deadlineKey = ?`, kind, key);
		});
	}

	runtimeDeadlines(): CloudflareDurableDeadlineV1[] {
		return this.storage.sql
			.exec<{ deadlineJson: string }>(
				`SELECT deadlineJson FROM ${RUNTIME_DEADLINES_TABLE}
				 ORDER BY CASE kind WHEN 'runtime_expiry' THEN 0 WHEN 'sync_retry' THEN 1 ELSE 2 END, dueAtEpochMs, deadlineKey`,
			)
			.toArray()
			.map(row => parseJson<CloudflareDurableDeadlineV1>(row.deadlineJson));
	}

	dueRuntimeDeadlines(nowEpochMs: number, limit = 100): CloudflareDurableDeadlineV1[] {
		return this.storage.sql
			.exec<{ deadlineJson: string }>(
				`SELECT deadlineJson FROM ${RUNTIME_DEADLINES_TABLE} WHERE dueAtEpochMs <= ?
				 ORDER BY CASE kind WHEN 'runtime_expiry' THEN 0 WHEN 'sync_retry' THEN 1 ELSE 2 END, dueAtEpochMs, deadlineKey LIMIT ?`,
				nowEpochMs,
				limit,
			)
			.toArray()
			.map(row => parseJson<CloudflareDurableDeadlineV1>(row.deadlineJson));
	}

	runtimeDeadlineSummary(): CloudflareDeadlineSummaryV1 {
		return summarizeCloudflareDurableDeadlinesV1(this.runtimeDeadlines());
	}

	runtimeCommand(commandId: string): RuntimeCommandState | undefined {
		const row = this.storage.sql
			.exec<Record<string, unknown>>(
				`SELECT commandId, requestSha256, contextJson, status, certainty, proof, backend, output,
				        outputBytes, outputStoredBytes, outputByteLimit, truncated, lastSeq, sync, exitCode,
				        signal, updatedAt, disposed FROM ${RUNTIME_COMMANDS_TABLE} WHERE commandId = ?`,
				commandId,
			)
			.toArray()[0];
		return row ? runtimeCommandFromRow(row) : undefined;
	}

	runtimeCommandRows(): RuntimeCommandState[] {
		return this.storage.sql
			.exec<Record<string, unknown>>(
				`SELECT commandId, requestSha256, contextJson, status, certainty, proof, backend, output,
				        outputBytes, outputStoredBytes, outputByteLimit, truncated, lastSeq, sync, exitCode,
				        signal, updatedAt, disposed FROM ${RUNTIME_COMMANDS_TABLE} ORDER BY commandId`,
			)
			.toArray()
			.map(runtimeCommandFromRow);
	}

	reserveRuntimeCommand(state: RuntimeCommandState): RuntimeCommandState {
		return this.storage.transactionSync(() => {
			const existing = this.runtimeCommand(state.commandId);
			if (existing) {
				if (
					existing.requestSha256 !== state.requestSha256 ||
					canonicalJson(existing.context) !== canonicalJson(state.context)
				) {
					throw new WorkspaceObjectError(
						409,
						"request_conflict",
						"Command identity conflicts with its reservation",
					);
				}
				return existing;
			}
			this.writeRuntimeCommand(state, false);
			return this.runtimeCommand(state.commandId)!;
		});
	}

	saveRuntimeCommand(state: RuntimeCommandState): RuntimeCommandState {
		return this.storage.transactionSync(() => {
			const existing = this.runtimeCommand(state.commandId);
			if (!existing) throw new WorkspaceObjectError(500, "workspace_state_lost", "Command reservation was lost");
			if (
				existing.requestSha256 !== state.requestSha256 ||
				canonicalJson(existing.context) !== canonicalJson(state.context)
			) {
				throw new WorkspaceObjectError(409, "request_conflict", "Command identity conflicts with its reservation");
			}
			this.writeRuntimeCommand(state, true);
			return this.runtimeCommand(state.commandId)!;
		});
	}

	deleteRuntimeCommand(commandId: string): boolean {
		return this.storage.transactionSync(() => {
			const present = this.runtimeCommand(commandId) !== undefined;
			this.storage.sql.exec(`DELETE FROM ${RUNTIME_COMMANDS_TABLE} WHERE commandId = ?`, commandId);
			return present;
		});
	}

	runtimeActiveCommandCount(): number {
		return Number(
			this.storage.sql
				.exec<{ count: number }>(
					`SELECT COUNT(*) AS count FROM ${RUNTIME_COMMANDS_TABLE} WHERE disposed = 0 AND status IN ('start_unknown', 'running')`,
				)
				.toArray()[0]?.count ?? 0,
		);
	}

	runtimePendingSyncCount(): number {
		return Number(
			this.storage.sql
				.exec<{ count: number }>(
					`SELECT COUNT(*) AS count FROM ${RUNTIME_COMMANDS_TABLE} WHERE disposed = 0 AND sync = 'pending'`,
				)
				.toArray()[0]?.count ?? 0,
		);
	}

	runtimePendingCommands(backend?: string): RuntimeCommandState[] {
		return this.runtimeCommandRows().filter(
			row => !row.disposed && row.sync === "pending" && (backend === undefined || row.backend === backend),
		);
	}

	runtimeAmbiguousCommandCount(): number {
		return Number(
			this.storage.sql
				.exec<{ count: number }>(
					`SELECT COUNT(*) AS count FROM ${RUNTIME_COMMANDS_TABLE} WHERE disposed = 0 AND (status = 'start_unknown' OR sync != 'complete')`,
				)
				.toArray()[0]?.count ?? 0,
		);
	}

	runtimeMutationReceiptIdentities(): string[] {
		const identities = this.storage.sql
			.exec<{ requestId: string; requestSha256: string }>(
				`SELECT requestId, requestSha256 FROM ${RUNTIME_REQUESTS_TABLE}
				 WHERE state = 'complete' AND operation IN ('write_text_file', 'mkdir', 'remove', 'rename')`,
			)
			.toArray()
			.map(row => ({ id: row.requestId, digest: row.requestSha256 }));
		for (const command of this.runtimeCommandRows()) {
			if (
				(command.status === "succeeded" || command.status === "failed" || command.status === "cancelled") &&
				command.sync === "complete"
			) {
				identities.push({ id: command.commandId, digest: command.requestSha256 });
			}
		}
		identities.sort((left, right) =>
			left.id < right.id
				? -1
				: left.id > right.id
					? 1
					: left.digest < right.digest
						? -1
						: left.digest > right.digest
							? 1
							: 0,
		);
		return identities.flatMap(identity => [identity.id, identity.digest]);
	}

	private writeRuntimeCommand(state: RuntimeCommandState, update: boolean): void {
		const bindings = [
			state.commandId,
			state.requestSha256,
			canonicalJson(state.context),
			state.status,
			state.certainty,
			state.proof,
			state.backend,
			state.output,
			state.outputBytes,
			state.outputStoredBytes,
			state.outputByteLimit,
			state.truncated ? 1 : 0,
			state.lastSeq,
			state.sync,
			state.exitCode,
			state.signal,
			state.updatedAt,
			state.disposed ? 1 : 0,
		];
		if (!update) {
			this.storage.sql.exec(
				`INSERT INTO ${RUNTIME_COMMANDS_TABLE}
				 (commandId, requestSha256, contextJson, status, certainty, proof, backend, output, outputBytes,
				  outputStoredBytes, outputByteLimit, truncated, lastSeq, sync, exitCode, signal, updatedAt, disposed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				...bindings,
			);
			return;
		}
		this.storage.sql.exec(
			`UPDATE ${RUNTIME_COMMANDS_TABLE}
			 SET requestSha256 = ?, contextJson = ?, status = ?, certainty = ?, proof = ?, backend = ?, output = ?,
			     outputBytes = ?, outputStoredBytes = ?, outputByteLimit = ?, truncated = ?, lastSeq = ?, sync = ?,
			     exitCode = ?, signal = ?, updatedAt = ?, disposed = ? WHERE commandId = ?`,
			...bindings.slice(1),
			bindings[0],
		);
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
		const pending = this.storage.sql
			.exec<{ notBefore: number | null }>(
				`SELECT MIN(r.notBefore) AS notBefore
				 FROM ${RETRY_INTENTS_TABLE} r
				 WHERE EXISTS (
				  SELECT 1 FROM ${EXECUTIONS_TABLE} e
				  WHERE e.backend = r.backend AND e.sync = 'pending'
				 ) OR EXISTS (
				  SELECT 1 FROM ${RUNTIME_COMMANDS_TABLE} c
				  WHERE c.backend = r.backend AND c.disposed = 0 AND c.sync = 'pending'
				 )`,
			)
			.toArray()[0]?.notBefore;
		const legacyExpiry = state && state.phase !== "released" ? state.expiresAt : Number.POSITIVE_INFINITY;
		const syncTarget = pending ?? Number.POSITIVE_INFINITY;
		const runtimeTarget = this.runtimeDeadlineSummary().earliestDueAtEpochMs ?? Number.POSITIVE_INFINITY;
		const target = Math.min(legacyExpiry, syncTarget, runtimeTarget);
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

function parseJson<T>(value: string): T {
	return JSON.parse(value) as T;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value === null || typeof value !== "object") return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		sorted[key] = sortJson((value as Record<string, unknown>)[key]);
	}
	return sorted;
}

function runtimeCommandFromRow(row: Record<string, unknown>): RuntimeCommandState {
	return {
		commandId: String(row.commandId),
		requestSha256: String(row.requestSha256),
		context: parseJson(String(row.contextJson)),
		status: row.status as RuntimeCommandState["status"],
		certainty: row.certainty as RuntimeCommandState["certainty"],
		proof: (row.proof ?? null) as RuntimeCommandState["proof"],
		backend: String(row.backend),
		output: String(row.output),
		outputBytes: Number(row.outputBytes),
		outputStoredBytes: Number(row.outputStoredBytes),
		outputByteLimit: Number(row.outputByteLimit),
		truncated: Boolean(row.truncated),
		lastSeq: Number(row.lastSeq),
		sync: row.sync as RuntimeCommandState["sync"],
		exitCode: row.exitCode === null || row.exitCode === undefined ? null : Number(row.exitCode),
		signal: (row.signal ?? null) as RuntimeCommandState["signal"],
		updatedAt: String(row.updatedAt),
		disposed: Boolean(row.disposed),
	};
}
