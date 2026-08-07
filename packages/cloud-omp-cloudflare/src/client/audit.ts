import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { isJsonObject } from "../protocol";

export const CLOUD_OMP_VERSION_METADATA = Object.freeze({
	wireVersion: "v1",
	packageVersion: "0.1.0",
	workerVersion: "0.1.0",
	computerPackageVersion: "0.1.1",
	computerGitHead: "63d363632e558f7e077794988d36ed75017c2a62",
	computerdImage:
		"ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.0-alpha.1@sha256:42ad8d95908fc62336bc74e1ab724df954af7357d1abb13c6a685af21b01b795",
	nodeBaseImage: "node:22-trixie-slim@sha256:c14465d88b83d14caaaa7e6e1f3efa49776a9868dc9713dddf7c79af3abb1d83",
});

export type CloudOmpAuditOperation =
	| "acquire"
	| "read"
	| "write"
	| "exec_start"
	| "exec_complete"
	| "exec_kill"
	| "exec_dispose"
	| "sync_back"
	| "release";

export type CloudOmpAuditOutcome = "success" | "failed" | "cancelled" | "timed_out";
export type CloudOmpCleanupState = "not_started" | "completed" | "failed" | "expired";

export interface CloudOmpAuditContext {
	correlationId: string;
	workspaceIdSha256: string;
	taskId: string;
	runId: string;
	containerInternetEnabled: boolean;
}

export interface CloudOmpAuditEvent {
	operation: CloudOmpAuditOperation;
	durationMs: number;
	outcome: CloudOmpAuditOutcome;
	byteCount?: number;
	fileCount?: number;
	exitCode?: number | null;
	signal?: string | null;
	truncated?: boolean;
	cleanupState?: CloudOmpCleanupState;
	seedRootSha256?: string;
	finalRootSha256?: string;
	errorCode?: string;
}

export interface CloudOmpAuditRecord extends CloudOmpAuditContext, CloudOmpAuditEvent {
	timestamp: string;
	wireVersion: string;
	packageVersion: string;
	workerVersion: string;
	computerPackageVersion: string;
	computerGitHead: string;
	computerdImage: string;
	nodeBaseImage: string;
}

export interface CloudOmpAuditWriterOptions {
	path?: string;
	now?: () => Date;
}

const EVENT_KEYS: Record<string, true> = {
	operation: true,
	durationMs: true,
	outcome: true,
	byteCount: true,
	fileCount: true,
	exitCode: true,
	signal: true,
	truncated: true,
	cleanupState: true,
	seedRootSha256: true,
	finalRootSha256: true,
	errorCode: true,
};
const AUDIT_OPERATIONS: Record<CloudOmpAuditOperation, true> = {
	acquire: true,
	read: true,
	write: true,
	exec_start: true,
	exec_complete: true,
	exec_kill: true,
	exec_dispose: true,
	sync_back: true,
	release: true,
};
const AUDIT_OUTCOMES: Record<CloudOmpAuditOutcome, true> = {
	success: true,
	failed: true,
	cancelled: true,
	timed_out: true,
};
const CLEANUP_STATES: Record<CloudOmpCleanupState, true> = {
	not_started: true,
	completed: true,
	failed: true,
	expired: true,
};
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export class CloudOmpAuditError extends Error {
	readonly code = "AUDIT_FAILURE";

	constructor() {
		super("Cloud OMP audit recording failed");
		this.name = "CloudOmpAuditError";
	}
}

export class CloudOmpAuditWriter {
	readonly path: string;
	readonly context: Readonly<CloudOmpAuditContext>;

	readonly #now: () => Date;
	#tail: Promise<void> = Promise.resolve();

	constructor(context: CloudOmpAuditContext, options: CloudOmpAuditWriterOptions = {}) {
		validateContext(context);
		this.path = resolve(options.path ?? `${tmpdir()}/cloud-omp/audit-${process.pid}.jsonl`);
		this.context = Object.freeze({ ...context });
		this.#now = options.now ?? (() => new Date());
	}

	record(event: CloudOmpAuditEvent): Promise<void> {
		validateEvent(event);
		const record: CloudOmpAuditRecord = {
			timestamp: this.#now().toISOString(),
			...this.context,
			...CLOUD_OMP_VERSION_METADATA,
			...copyEvent(event),
		};
		validateAuditRecord(record);
		const line = `${JSON.stringify(record)}\n`;
		const writePromise = this.#tail.then(() => appendSecureLine(this.path, line));
		this.#tail = writePromise.catch(() => {});
		return writePromise.catch(() => {
			throw new CloudOmpAuditError();
		});
	}
}

export function createAuditCorrelationId(): string {
	return randomBytes(16).toString("hex");
}

export function hashWorkspaceId(workspaceId: string): string {
	return createHash("sha256").update(workspaceId, "utf8").digest("hex");
}

export function auditErrorCode(error: unknown): string {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
		const normalized = error.code.toUpperCase();
		return SAFE_CODE.test(normalized) ? normalized : "UNEXPECTED_FAILURE";
	}
	return "UNEXPECTED_FAILURE";
}

export function validateAuditRecord(value: unknown): asserts value is CloudOmpAuditRecord {
	if (!isJsonObject(value)) throw new CloudOmpAuditError();
	const requiredKeys = [
		"timestamp",
		"correlationId",
		"workspaceIdSha256",
		"taskId",
		"runId",
		"containerInternetEnabled",
		"wireVersion",
		"packageVersion",
		"workerVersion",
		"computerPackageVersion",
		"computerGitHead",
		"computerdImage",
		"nodeBaseImage",
		"operation",
		"durationMs",
		"outcome",
	];
	for (const key of requiredKeys) {
		if (!Object.hasOwn(value, key)) throw new CloudOmpAuditError();
	}
	if (Object.keys(value).some(key => !requiredKeys.includes(key) && !Object.hasOwn(EVENT_KEYS, key))) {
		throw new CloudOmpAuditError();
	}
	validateContext(value as unknown as CloudOmpAuditContext);
	validateEvent(copyEvent(value as unknown as CloudOmpAuditEvent));
	if (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp)))
		throw new CloudOmpAuditError();
	for (const [key, expected] of Object.entries(CLOUD_OMP_VERSION_METADATA)) {
		if (value[key] !== expected) throw new CloudOmpAuditError();
	}
}

function copyEvent(event: CloudOmpAuditEvent): CloudOmpAuditEvent {
	return {
		operation: event.operation,
		durationMs: event.durationMs,
		outcome: event.outcome,
		...(event.byteCount === undefined ? {} : { byteCount: event.byteCount }),
		...(event.fileCount === undefined ? {} : { fileCount: event.fileCount }),
		...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
		...(event.signal === undefined ? {} : { signal: event.signal }),
		...(event.truncated === undefined ? {} : { truncated: event.truncated }),
		...(event.cleanupState === undefined ? {} : { cleanupState: event.cleanupState }),
		...(event.seedRootSha256 === undefined ? {} : { seedRootSha256: event.seedRootSha256 }),
		...(event.finalRootSha256 === undefined ? {} : { finalRootSha256: event.finalRootSha256 }),
		...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
	};
}

function validateContext(context: CloudOmpAuditContext): void {
	if (!HEX_32.test(context.correlationId) || !HEX_64.test(context.workspaceIdSha256)) throw new CloudOmpAuditError();
	if (!isBoundedId(context.taskId) || !isBoundedId(context.runId)) throw new CloudOmpAuditError();
	if (typeof context.containerInternetEnabled !== "boolean") throw new CloudOmpAuditError();
}

function validateEvent(event: CloudOmpAuditEvent): void {
	if (!isJsonObject(event) || Object.keys(event).some(key => !Object.hasOwn(EVENT_KEYS, key)))
		throw new CloudOmpAuditError();
	if (!isAuditOperation(event.operation) || !isAuditOutcome(event.outcome)) throw new CloudOmpAuditError();
	if (!Number.isFinite(event.durationMs) || event.durationMs < 0) throw new CloudOmpAuditError();
	for (const count of [event.byteCount, event.fileCount]) {
		if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw new CloudOmpAuditError();
	}
	if (event.exitCode !== undefined && event.exitCode !== null && !Number.isSafeInteger(event.exitCode)) {
		throw new CloudOmpAuditError();
	}
	if (event.signal !== undefined && event.signal !== null && !isBoundedId(event.signal, 64))
		throw new CloudOmpAuditError();
	if (event.truncated !== undefined && typeof event.truncated !== "boolean") throw new CloudOmpAuditError();
	if (event.cleanupState !== undefined && !Object.hasOwn(CLEANUP_STATES, event.cleanupState)) {
		throw new CloudOmpAuditError();
	}
	for (const digest of [event.seedRootSha256, event.finalRootSha256]) {
		if (digest !== undefined && !HEX_64.test(digest)) throw new CloudOmpAuditError();
	}
	if (event.errorCode !== undefined && !SAFE_CODE.test(event.errorCode)) throw new CloudOmpAuditError();
}

async function appendSecureLine(path: string, line: string): Promise<void> {
	const parent = dirname(path);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const parentStat = await lstat(parent);
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077) !== 0) {
		throw new CloudOmpAuditError();
	}
	const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
	const handle = await open(path, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | noFollow, 0o600);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new CloudOmpAuditError();
		await handle.chmod(0o600);
		await handle.writeFile(line, "utf8");
	} finally {
		await handle.close();
	}
}

function isAuditOperation(value: unknown): value is CloudOmpAuditOperation {
	return typeof value === "string" && Object.hasOwn(AUDIT_OPERATIONS, value);
}

function isAuditOutcome(value: unknown): value is CloudOmpAuditOutcome {
	return typeof value === "string" && Object.hasOwn(AUDIT_OUTCOMES, value);
}

function isBoundedId(value: unknown, maxLength = 256): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value)
	);
}
