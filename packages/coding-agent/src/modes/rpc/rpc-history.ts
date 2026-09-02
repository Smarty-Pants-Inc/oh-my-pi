import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { SessionEntry, SessionHeader } from "../../session/session-entries";

const MAX_HISTORY_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_PAGE_ENTRIES = 256;
const DEFAULT_HISTORY_PAGE_ENTRIES = 64;
const MAX_HISTORY_PAGE_BYTES = 768 * 1024;
const MAX_HISTORY_CHUNK_BYTES = 512 * 1024;
const DEFAULT_HISTORY_CHUNK_BYTES = 256 * 1024;
const MAX_HISTORY_CURSOR_BYTES = 2048;

export type RpcHistoryScope = "entries" | "branch";

export interface RpcHistorySnapshotData {
	header: SessionHeader;
	entries: SessionEntry[];
	branch: SessionEntry[];
	leafId: string | null;
}

export interface RpcHistoryDigest {
	algorithm: "sha256";
	value: string;
	byteLength: number;
	entryCount: number;
	branchEntryCount: number;
	leafId: string | null;
}

export interface RpcHistorySnapshot extends RpcHistorySnapshotData {
	digest: RpcHistoryDigest;
}

export interface RpcHistoryPageOptions {
	scope?: RpcHistoryScope;
	cursor?: string;
	limit?: number;
}

export interface RpcHistoryPage {
	header: SessionHeader;
	scope: RpcHistoryScope;
	entries: SessionEntry[];
	nextCursor?: string;
	totalEntries: number;
	leafId: string | null;
	digest: RpcHistoryDigest;
}

export interface RpcHistoryChunkOptions {
	cursor?: string;
	limit?: number;
}

export interface RpcHistoryChunk {
	encoding: "base64";
	data: string;
	offset: number;
	nextCursor?: string;
	totalBytes: number;
	digest: RpcHistoryDigest;
}

export class RpcHistoryError extends Error {
	constructor(
		message: string,
		readonly code: "protocol-error" | "session_busy" | "stale_cursor" | "history_too_large" | "entry_too_large",
	) {
		super(message);
		this.name = "RpcHistoryError";
	}
}

interface HistoryCapture {
	data: RpcHistorySnapshotData;
	bytes: Buffer;
	digest: RpcHistoryDigest;
	sessionId: string;
}

interface HistoryPageCursor {
	version: 1;
	sessionId: string;
	digest: string;
	scope: RpcHistoryScope;
	offset: number;
}

interface HistoryChunkCursor {
	version: 1;
	sessionId: string;
	digest: string;
	offset: number;
}

function encodeCursor(cursor: HistoryPageCursor | HistoryChunkCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): unknown {
	if (Buffer.byteLength(cursor, "utf8") > MAX_HISTORY_CURSOR_BYTES) {
		throw new RpcHistoryError("RPC history cursor is too large", "protocol-error");
	}
	try {
		return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw new RpcHistoryError("RPC history cursor is invalid", "protocol-error");
	}
}

function parsePageCursor(cursor: string): HistoryPageCursor {
	const value = decodeCursor(cursor);
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.sessionId !== "string" ||
		typeof value.digest !== "string" ||
		(value.scope !== "entries" && value.scope !== "branch") ||
		typeof value.offset !== "number" ||
		!Number.isSafeInteger(value.offset) ||
		value.offset < 0
	) {
		throw new RpcHistoryError("RPC history page cursor is invalid", "protocol-error");
	}
	return value as unknown as HistoryPageCursor;
}

function parseChunkCursor(cursor: string): HistoryChunkCursor {
	const value = decodeCursor(cursor);
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.sessionId !== "string" ||
		typeof value.digest !== "string" ||
		typeof value.offset !== "number" ||
		!Number.isSafeInteger(value.offset) ||
		value.offset < 0 ||
		"scope" in value
	) {
		throw new RpcHistoryError("RPC history chunk cursor is invalid", "protocol-error");
	}
	return value as unknown as HistoryChunkCursor;
}

function validateLimit(value: number | undefined, fallback: number, maximum: number, label: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new RpcHistoryError(`${label} must be an integer between 1 and ${maximum}`, "protocol-error");
	}
	return value;
}

function assertStableSession(session: AgentSession): void {
	if (session.isStreaming || session.isCompacting) {
		throw new RpcHistoryError("Cannot inspect exact history while the session is changing", "session_busy");
	}
}

function captureHistory(session: AgentSession): HistoryCapture {
	assertStableSession(session);
	const manager = session.sessionManager;
	const header = manager.getHeader();
	if (!header) throw new RpcHistoryError("Session header is unavailable", "session_busy");
	const data: RpcHistorySnapshotData = {
		header,
		entries: manager.getEntries(),
		branch: manager.getBranch(),
		leafId: manager.getLeafId(),
	};
	const bytes = Buffer.from(JSON.stringify(data), "utf8");
	const digest: RpcHistoryDigest = {
		algorithm: "sha256",
		value: new Bun.SHA256().update(bytes).digest("hex"),
		byteLength: bytes.byteLength,
		entryCount: data.entries.length,
		branchEntryCount: data.branch.length,
		leafId: data.leafId,
	};
	return { data, bytes, digest, sessionId: manager.getSessionId() };
}

function assertCurrentCursor(
	capture: HistoryCapture,
	cursor: { sessionId: string; digest: string; offset: number },
	maximumOffset: number,
): void {
	if (
		cursor.sessionId !== capture.sessionId ||
		cursor.digest !== capture.digest.value ||
		cursor.offset > maximumOffset
	) {
		throw new RpcHistoryError("RPC history cursor is stale", "stale_cursor");
	}
}

export function getRpcHistoryDigest(session: AgentSession): RpcHistoryDigest {
	return captureHistory(session).digest;
}

export function getRpcHistorySnapshot(session: AgentSession): RpcHistorySnapshot {
	const capture = captureHistory(session);
	if (capture.bytes.byteLength > MAX_HISTORY_SNAPSHOT_BYTES) {
		throw new RpcHistoryError(
			`Exact history snapshot exceeds ${MAX_HISTORY_SNAPSHOT_BYTES} bytes; use history_page or history_chunk`,
			"history_too_large",
		);
	}
	const data = JSON.parse(capture.bytes.toString("utf8")) as RpcHistorySnapshotData;
	return { ...data, digest: capture.digest };
}

export function getRpcHistoryPage(session: AgentSession, options: RpcHistoryPageOptions = {}): RpcHistoryPage {
	const capture = captureHistory(session);
	const limit = validateLimit(
		options.limit,
		DEFAULT_HISTORY_PAGE_ENTRIES,
		MAX_HISTORY_PAGE_ENTRIES,
		"History page limit",
	);
	let scope = options.scope ?? "entries";
	let offset = 0;
	if (options.cursor !== undefined) {
		const cursor = parsePageCursor(options.cursor);
		assertCurrentCursor(
			capture,
			cursor,
			cursor.scope === "entries" ? capture.data.entries.length : capture.data.branch.length,
		);
		if (options.scope !== undefined && options.scope !== cursor.scope) {
			throw new RpcHistoryError("History page scope does not match its cursor", "protocol-error");
		}
		scope = cursor.scope;
		offset = cursor.offset;
	}
	const source = scope === "entries" ? capture.data.entries : capture.data.branch;
	const entries: SessionEntry[] = [];
	let pageBytes = 2;
	for (let index = offset; index < source.length && entries.length < limit; index++) {
		const entry = source[index];
		if (!entry) break;
		const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + (entries.length > 0 ? 1 : 0);
		if (entries.length === 0 && entryBytes > MAX_HISTORY_PAGE_BYTES) {
			throw new RpcHistoryError(
				"A history entry is too large for a typed page; use history_chunk",
				"entry_too_large",
			);
		}
		if (pageBytes + entryBytes > MAX_HISTORY_PAGE_BYTES) break;
		entries.push(entry);
		pageBytes += entryBytes;
	}
	const nextOffset = offset + entries.length;
	return {
		header: capture.data.header,
		scope,
		entries,
		...(nextOffset < source.length
			? {
					nextCursor: encodeCursor({
						version: 1,
						sessionId: capture.sessionId,
						digest: capture.digest.value,
						scope,
						offset: nextOffset,
					}),
				}
			: {}),
		totalEntries: source.length,
		leafId: capture.data.leafId,
		digest: capture.digest,
	};
}

export function getRpcHistoryChunk(session: AgentSession, options: RpcHistoryChunkOptions = {}): RpcHistoryChunk {
	const capture = captureHistory(session);
	const limit = validateLimit(
		options.limit,
		DEFAULT_HISTORY_CHUNK_BYTES,
		MAX_HISTORY_CHUNK_BYTES,
		"History chunk limit",
	);
	let offset = 0;
	if (options.cursor !== undefined) {
		const cursor = parseChunkCursor(options.cursor);
		assertCurrentCursor(capture, cursor, capture.bytes.byteLength);
		offset = cursor.offset;
	}
	const end = Math.min(offset + limit, capture.bytes.byteLength);
	return {
		encoding: "base64",
		data: capture.bytes.subarray(offset, end).toString("base64"),
		offset,
		...(end < capture.bytes.byteLength
			? {
					nextCursor: encodeCursor({
						version: 1,
						sessionId: capture.sessionId,
						digest: capture.digest.value,
						offset: end,
					}),
				}
			: {}),
		totalBytes: capture.bytes.byteLength,
		digest: capture.digest,
	};
}
