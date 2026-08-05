import { CLOUD_OMP_VERSION_METADATA } from "../version-metadata";

export type WorkspaceAuditOperation =
	| "acquire"
	| "create"
	| "read"
	| "write"
	| "exec_start"
	| "exec_complete"
	| "exec_kill"
	| "exec_dispose"
	| "sync_retry"
	| "quiesce"
	| "restart"
	| "release"
	| "expiry";

export type WorkspaceAuditOutcome = "success" | "failed" | "cancelled" | "timed_out";
export type WorkspaceCleanupState = "not_started" | "completed" | "failed" | "expired";

export interface WorkspaceAuditContext {
	auditCorrelationId: string;
	workspaceIdSha256: string;
}

export interface WorkspaceAuditEvent {
	operation: WorkspaceAuditOperation;
	durationMs: number;
	outcome: WorkspaceAuditOutcome;
	byteCount?: number;
	fileCount?: number;
	activeExecutions?: number;
	pendingSyncs?: number;
	exhaustedSyncs?: number;
	exitCode?: number | null;
	signal?: string | null;
	truncated?: boolean;
	cleanupState?: WorkspaceCleanupState;
	errorCode?: string;
}

export interface WorkspaceAuditRecord extends WorkspaceAuditContext, WorkspaceAuditEvent {
	timestamp: string;
	workerVersionId: string;
	containerInternetEnabled: true;
	wireVersion: string;
	packageVersion: string;
	workerVersion: string;
	computerPackageVersion: string;
	computerGitHead: string;
	computerdImage: string;
	nodeBaseImage: string;
}

export interface WorkspaceAuditSinkOptions {
	workerVersionId: string;
	now?: () => Date;
	emit?: (record: WorkspaceAuditRecord) => void;
}

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const OPERATIONS = new Set<WorkspaceAuditOperation>([
	"acquire",
	"create",
	"read",
	"write",
	"exec_start",
	"exec_complete",
	"exec_kill",
	"exec_dispose",
	"sync_retry",
	"quiesce",
	"restart",
	"release",
	"expiry",
]);
const OUTCOMES = new Set<WorkspaceAuditOutcome>(["success", "failed", "cancelled", "timed_out"]);
const CLEANUP_STATES = new Set<WorkspaceCleanupState>(["not_started", "completed", "failed", "expired"]);
const OPTIONAL_KEYS = new Set([
	"byteCount",
	"fileCount",
	"activeExecutions",
	"pendingSyncs",
	"exhaustedSyncs",
	"exitCode",
	"signal",
	"truncated",
	"cleanupState",
	"errorCode",
]);

export class WorkspaceAuditSink {
	readonly #workerVersionId: string;
	readonly #now: () => Date;
	readonly #emit: (record: WorkspaceAuditRecord) => void;

	constructor(options: WorkspaceAuditSinkOptions) {
		if (typeof options.workerVersionId !== "string" || options.workerVersionId.length === 0) {
			throw new TypeError("Worker version metadata ID is required");
		}
		this.#workerVersionId = options.workerVersionId;
		this.#now = options.now ?? (() => new Date());
		this.#emit = options.emit ?? (record => console.info(record));
	}

	record(context: WorkspaceAuditContext, event: WorkspaceAuditEvent): void {
		const record: WorkspaceAuditRecord = {
			timestamp: this.#now().toISOString(),
			auditCorrelationId: context.auditCorrelationId,
			workspaceIdSha256: context.workspaceIdSha256,
			workerVersionId: this.#workerVersionId,
			containerInternetEnabled: true,
			...CLOUD_OMP_VERSION_METADATA,
			...copyEvent(event),
		};
		validateWorkspaceAuditRecord(record);
		this.#emit(Object.freeze(record));
	}
}

export async function hashWorkspaceId(workspaceId: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(workspaceId));
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function workspaceAuditErrorCode(error: unknown): string {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		const normalized = error.code.toUpperCase();
		if (SAFE_CODE.test(normalized)) return normalized;
	}
	return "UNEXPECTED_FAILURE";
}

export function workspaceAuditOutcomeForError(error: unknown): WorkspaceAuditOutcome {
	return typeof error === "object" && error !== null && "code" in error && error.code === "cleanup_timeout"
		? "timed_out"
		: "failed";
}

export function validateWorkspaceAuditRecord(value: unknown): asserts value is WorkspaceAuditRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError("Invalid Worker audit record");
	const record = value as Record<string, unknown>;
	const required = [
		"timestamp",
		"auditCorrelationId",
		"workspaceIdSha256",
		"workerVersionId",
		"containerInternetEnabled",
		...Object.keys(CLOUD_OMP_VERSION_METADATA),
		"operation",
		"durationMs",
		"outcome",
	];
	if (required.some(key => !Object.hasOwn(record, key))) throw new TypeError("Invalid Worker audit record");
	if (Object.keys(record).some(key => !required.includes(key) && !OPTIONAL_KEYS.has(key))) {
		throw new TypeError("Invalid Worker audit record");
	}
	if (typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp))) {
		throw new TypeError("Invalid Worker audit record");
	}
	if (!HEX_32.test(String(record.auditCorrelationId)) || !HEX_64.test(String(record.workspaceIdSha256))) {
		throw new TypeError("Invalid Worker audit record");
	}
	if (typeof record.workerVersionId !== "string" || record.workerVersionId.length === 0) {
		throw new TypeError("Invalid Worker audit record");
	}
	if (record.containerInternetEnabled !== true) throw new TypeError("Invalid Worker audit record");
	for (const [key, expected] of Object.entries(CLOUD_OMP_VERSION_METADATA)) {
		if (record[key] !== expected) throw new TypeError("Invalid Worker audit record");
	}
	validateEvent(copyEvent(record as unknown as WorkspaceAuditEvent));
}

function copyEvent(event: WorkspaceAuditEvent): WorkspaceAuditEvent {
	return {
		operation: event.operation,
		durationMs: event.durationMs,
		outcome: event.outcome,
		...(event.byteCount === undefined ? {} : { byteCount: event.byteCount }),
		...(event.fileCount === undefined ? {} : { fileCount: event.fileCount }),
		...(event.activeExecutions === undefined ? {} : { activeExecutions: event.activeExecutions }),
		...(event.pendingSyncs === undefined ? {} : { pendingSyncs: event.pendingSyncs }),
		...(event.exhaustedSyncs === undefined ? {} : { exhaustedSyncs: event.exhaustedSyncs }),
		...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
		...(event.signal === undefined ? {} : { signal: event.signal }),
		...(event.truncated === undefined ? {} : { truncated: event.truncated }),
		...(event.cleanupState === undefined ? {} : { cleanupState: event.cleanupState }),
		...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
	};
}

function validateEvent(event: WorkspaceAuditEvent): void {
	if (!OPERATIONS.has(event.operation) || !OUTCOMES.has(event.outcome))
		throw new TypeError("Invalid Worker audit record");
	if (!Number.isFinite(event.durationMs) || event.durationMs < 0) throw new TypeError("Invalid Worker audit record");
	for (const count of [
		event.byteCount,
		event.fileCount,
		event.activeExecutions,
		event.pendingSyncs,
		event.exhaustedSyncs,
	]) {
		if (count !== undefined && (!Number.isSafeInteger(count) || count < 0))
			throw new TypeError("Invalid Worker audit record");
	}
	if (event.exitCode !== undefined && event.exitCode !== null && !Number.isSafeInteger(event.exitCode)) {
		throw new TypeError("Invalid Worker audit record");
	}
	if (
		event.signal !== undefined &&
		event.signal !== null &&
		(typeof event.signal !== "string" || event.signal.length > 64)
	) {
		throw new TypeError("Invalid Worker audit record");
	}
	if (event.truncated !== undefined && typeof event.truncated !== "boolean")
		throw new TypeError("Invalid Worker audit record");
	if (event.cleanupState !== undefined && !CLEANUP_STATES.has(event.cleanupState)) {
		throw new TypeError("Invalid Worker audit record");
	}
	if (event.errorCode !== undefined && !SAFE_CODE.test(event.errorCode))
		throw new TypeError("Invalid Worker audit record");
}
