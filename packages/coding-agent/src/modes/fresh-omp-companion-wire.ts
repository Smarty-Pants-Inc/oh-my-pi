import * as crypto from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getSegmenter } from "@oh-my-pi/pi-tui";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ExtensionAPI } from "../extensibility/extensions/types";
import type { Goal, GoalStatus } from "../goals/state";
import { isSilentAbort, isUserInterruptAbort } from "../session/messages";
import type { SessionEntry } from "../session/session-entries";
import { isTodoPhase, nextActionableTask, type TodoPhase } from "../tools/todo";

const OSC_PREFIX = "\x1b]777;notify;fresh://omp-companion;v1;";
const OSC_TERMINATOR = "\x1b\\";
export const SYNC_DOMAIN = "fresh-omp/sync/v1\0";
const OUT_DOMAIN = "fresh-omp/out/v1\0";
const IN_DOMAIN = "fresh-omp/in/v1\0";
export const COMMAND_PREFIX = "\u{10ffff}fresh-omp-command:v1:";
export const COMMAND_END = "\u{10fffe}";

export const SECRET_BYTES = 32;
export const SYNC_BYTES = 16;
export const SYNC_B64_LENGTH = 22;
const TAG_BYTES = 32;
const TAG_B64_LENGTH = 43;
const MAX_COMMAND_BODY_BYTES = 512;
const MAX_COMMAND_BODY_B64_CHARS = Math.ceil((MAX_COMMAND_BODY_BYTES * 4) / 3);
export const MAX_COMMAND_CAPTURE_CHARS = MAX_COMMAND_BODY_B64_CHARS + 1 + TAG_B64_LENGTH;
export const COMMAND_TIMEOUT_MS = 1_000;
export const MAX_FRAME_BYTES = 12 * 1024;
const MAX_BODY_BYTES = 8_192;
const MAX_ENCODED_BODY_CHARS = 10_923;
export const SAMPLE_INTERVAL_MS = 1_000;
export const EMIT_COALESCE_MS = 50;
export const HEARTBEAT_MS = 5_000;
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_COUNT = 2_147_483_647;
export const MAX_PROCESS_ID = 4_294_967_295;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
export const COMMAND_CAPTURE_CHARACTER_PATTERN = /^[A-Za-z0-9_.-]$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNICODE_WHITESPACE_PATTERN = /\p{White_Space}/u;
const THINKING_LEVELS: Record<ThinkingLevel, true> = {
	auto: true,
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};
const GOAL_STATUSES: Record<GoalStatus, true> = {
	active: true,
	paused: true,
	blocked: true,
	budget_limited: true,
	usage_limited: true,
	complete: true,
	dropped: true,
	superseded: true,
};

export type CompanionStateName =
	| "idle"
	| "working"
	| "awaiting_approval"
	| "retrying"
	| "compacting"
	| "stopped"
	| "error";

type ThinkingLevel = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type GoalSummary = Pick<Goal, "objective" | "status">;

export type TodoSummary = {
	pending: number;
	inProgress: number;
	blocked: number;
	completed: number;
	abandoned: number;
	current?: string;
};

export type ToolSummary = {
	name: string;
	intent?: string;
	order: number;
};

export interface SemanticSnapshot {
	version: 1;
	incarnation: string;
	sessionGeneration: number;
	workEpoch: number;
	ompVersion: string;
	processId: number;
	sessionId: string;
	sessionName?: string;
	cwd: string;
	state: CompanionStateName;
	statusText?: string;
	model?: {
		provider: string;
		id: string;
	};
	thinkingLevel?: ThinkingLevel;
	runningTools: number;
	currentTool?: {
		name: string;
		intent?: string;
	};
	goal?: {
		objective: string;
		status: GoalStatus;
	};
	todos?: TodoSummary;
	context?: {
		tokens: number;
		contextWindow: number;
		percentBps: number;
	};
	pendingApprovals: number;
	asyncJobs?: {
		running: number;
		recentFailures: number;
		pendingDelivery: number;
	};
}

export interface CompanionCommandTarget {
	incarnation: string;
	sessionGeneration: number;
	sessionId: string;
	workEpoch: number;
}

export type ParsedCompanionCommand =
	| {
			type: "cancel" | "request_snapshot";
			commandSequence: number;
	  }
	| {
			type: "snapshot_ack";
			incarnation: string;
			sequence: number;
			sessionGeneration: number;
			sessionId: string;
			workEpoch: number;
			accepted: boolean;
			commandSequence: number;
	  };

interface WireSnapshot extends SemanticSnapshot {
	sequence: number;
	timestampMs: number;
}

interface EncodedFrame {
	frame: string;
	semantic: string;
	sequence: number;
}

export function hmac(secret: Uint8Array, domain: string, ascii = ""): Buffer {
	return crypto.createHmac("sha256", secret).update(domain, "utf8").update(ascii, "ascii").digest();
}

function canonicalBase64Url(text: string, expectedBytes?: number): Buffer | undefined {
	if (!text || !BASE64URL_PATTERN.test(text)) return undefined;
	const decoded = Buffer.from(text, "base64url");
	if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) return undefined;
	return decoded.toString("base64url") === text ? decoded : undefined;
}

function isUnsafeScalar(codePoint: number, value: string): boolean {
	return (
		codePoint <= 0x1f ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		(codePoint >= 0xd800 && codePoint <= 0xdfff) ||
		codePoint === 0x061c ||
		codePoint === 0x200e ||
		codePoint === 0x200f ||
		(codePoint >= 0x202a && codePoint <= 0x202e) ||
		(codePoint >= 0x2066 && codePoint <= 0x2069) ||
		(codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
		(codePoint & 0xffff) === 0xfffe ||
		(codePoint & 0xffff) === 0xffff ||
		UNICODE_WHITESPACE_PATTERN.test(value)
	);
}

export function normalizeString(value: unknown, maxCodePoints: number, maxBytes: number): string | undefined {
	if (typeof value !== "string") return undefined;
	let normalized = "";
	let previousWasSpace = false;
	for (const scalar of value) {
		const codePoint = scalar.codePointAt(0);
		if (codePoint === undefined) continue;
		if (isUnsafeScalar(codePoint, scalar)) {
			if (!previousWasSpace) normalized += " ";
			previousWasSpace = true;
		} else {
			normalized += scalar;
			previousWasSpace = false;
		}
	}
	normalized = normalized.trim();
	if (!normalized) return undefined;
	return truncateString(normalized, maxCodePoints, maxBytes);
}

function truncateString(value: string, maxCodePoints: number, maxBytes: number): string {
	if (value.length <= maxCodePoints && Buffer.byteLength(value, "utf8") <= maxBytes) {
		let end = value.length;
		while (end > 0 && value.charCodeAt(end - 1) === 0x20) end--;
		return end === value.length ? value : value.slice(0, end);
	}
	let result = "";
	let lastNonSpaceEnd = 0;
	let codePoints = 0;
	let bytes = 0;
	for (const { segment } of getSegmenter().segment(value)) {
		let segmentCodePoints = 0;
		for (const _scalar of segment) segmentCodePoints++;
		if (codePoints + segmentCodePoints > maxCodePoints) break;
		const segmentBytes = Buffer.byteLength(segment, "utf8");
		if (bytes + segmentBytes > maxBytes) break;
		result += segment;
		if (segment !== " ") lastNonSpaceEnd = result.length;
		codePoints += segmentCodePoints;
		bytes += segmentBytes;
	}
	return lastNonSpaceEnd === result.length ? result : result.slice(0, lastNonSpaceEnd);
}

function truncateUtf8(value: string, maxBytes: number): string {
	return truncateString(value, Number.MAX_SAFE_INTEGER, maxBytes);
}

export function boundedInteger(value: unknown, max: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.min(max, Math.max(0, Math.trunc(value)));
}

export function boundedLength(length: number): number {
	return Math.min(MAX_COUNT, Math.max(0, Math.trunc(length)));
}

export function isCanonicalUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isCanonicalUuidV4(value: unknown): value is string {
	return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" && Object.hasOwn(THINKING_LEVELS, value) ? (value as ThinkingLevel) : undefined;
}

export function summarizeGoal(value: unknown): GoalSummary | undefined {
	if (
		!isRecord(value) ||
		typeof value.objective !== "string" ||
		typeof value.status !== "string" ||
		!Object.hasOwn(GOAL_STATUSES, value.status)
	) {
		return undefined;
	}
	return { objective: value.objective, status: value.status as GoalStatus };
}

export function goalFromBranch(entries: readonly SessionEntry[]): GoalSummary | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "mode_change") continue;
		if (entry.mode !== "goal" && entry.mode !== "goal_paused") return undefined;
		return summarizeGoal(entry.data?.goal);
	}
	return undefined;
}

export function summarizeTodos(phases: readonly TodoPhase[]): TodoSummary | undefined {
	if (phases.length === 0) return undefined;
	let pending = 0;
	let inProgress = 0;
	let blocked = 0;
	let completed = 0;
	let abandoned = 0;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			switch (task.status) {
				case "pending":
					pending++;
					break;
				case "in_progress":
					inProgress++;
					break;
				case "blocked":
					blocked++;
					break;
				case "completed":
					completed++;
					break;
				case "abandoned":
					abandoned++;
					break;
			}
		}
	}
	const current = nextActionableTask(phases)?.content;
	return {
		pending: Math.min(MAX_COUNT, pending),
		inProgress: Math.min(MAX_COUNT, inProgress),
		blocked: Math.min(MAX_COUNT, blocked),
		completed: Math.min(MAX_COUNT, completed),
		abandoned: Math.min(MAX_COUNT, abandoned),
		...(current === undefined ? {} : { current }),
	};
}

export function todosFromToolResult(result: unknown): TodoSummary | null | undefined {
	if (!isRecord(result) || !isRecord(result.details)) return undefined;
	const phases = result.details.phases;
	if (!Array.isArray(phases) || !phases.every(isTodoPhase)) return undefined;
	return summarizeTodos(phases) ?? null;
}

export function configuredThinkingLevel(pi: ExtensionAPI, entries: readonly SessionEntry[]): ThinkingLevel | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "thinking_level_change") continue;
		return normalizeThinkingLevel(entry.configured ?? entry.thinkingLevel);
	}
	return normalizeThinkingLevel(pi.getThinkingLevel());
}

export function hasSettledFailure(messages: readonly AgentMessage[]): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") return true;
		if (
			message.stopReason === "aborted" &&
			!isSilentAbort(message) &&
			!isUserInterruptAbort(message) &&
			typeof message.errorMessage === "string" &&
			message.errorMessage.length > 0
		) {
			return true;
		}
		return false;
	}
	return false;
}

export function parseCommand(
	secret: Uint8Array,
	capture: string,
	expected: CompanionCommandTarget,
	lastCommandSequence: number,
): ParsedCompanionCommand | undefined {
	if (capture.length > MAX_COMMAND_CAPTURE_CHARS) return undefined;
	const separator = capture.indexOf(".");
	if (separator <= 0 || separator !== capture.lastIndexOf(".")) return undefined;
	const bodyText = capture.slice(0, separator);
	const tagText = capture.slice(separator + 1);
	if (bodyText.length > MAX_COMMAND_BODY_B64_CHARS || tagText.length !== TAG_B64_LENGTH) return undefined;
	const body = canonicalBase64Url(bodyText);
	const tag = canonicalBase64Url(tagText, TAG_BYTES);
	if (!body || body.byteLength > MAX_COMMAND_BODY_BYTES || !tag) return undefined;
	const expectedTag = hmac(secret, IN_DOMAIN, bodyText);
	if (!crypto.timingSafeEqual(tag, expectedTag)) return undefined;

	let json: string;
	let value: unknown;
	try {
		json = UTF8_DECODER.decode(body);
		value = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const { version, type, incarnation, sequence, sessionGeneration, sessionId, workEpoch, accepted, commandSequence } =
		value;
	if (
		version !== 1 ||
		(type !== "cancel" && type !== "request_snapshot" && type !== "snapshot_ack") ||
		!isCanonicalUuidV4(incarnation) ||
		!isCanonicalUuid(sessionId) ||
		typeof sessionGeneration !== "number" ||
		!Number.isSafeInteger(sessionGeneration) ||
		sessionGeneration < 1 ||
		typeof workEpoch !== "number" ||
		!Number.isSafeInteger(workEpoch) ||
		workEpoch < 1 ||
		typeof commandSequence !== "number" ||
		!Number.isSafeInteger(commandSequence) ||
		commandSequence < 1 ||
		commandSequence <= lastCommandSequence ||
		incarnation !== expected.incarnation ||
		sessionGeneration !== expected.sessionGeneration ||
		sessionId !== expected.sessionId ||
		workEpoch !== expected.workEpoch
	)
		return undefined;
	if (type === "snapshot_ack") {
		if (
			typeof sequence !== "number" ||
			!Number.isSafeInteger(sequence) ||
			sequence < 1 ||
			typeof accepted !== "boolean"
		) {
			return undefined;
		}
		const canonical = JSON.stringify({
			version,
			type,
			incarnation,
			sequence,
			sessionGeneration,
			sessionId,
			workEpoch,
			accepted,
			commandSequence,
		});
		if (json !== canonical) return undefined;
		return {
			type,
			incarnation,
			sequence,
			sessionGeneration,
			sessionId,
			workEpoch,
			accepted,
			commandSequence,
		};
	}
	const canonical = JSON.stringify({
		version,
		type,
		incarnation,
		sessionGeneration,
		sessionId,
		workEpoch,
		commandSequence,
	});
	if (json !== canonical) return undefined;
	return { type, commandSequence };
}

function semanticFromWire(snapshot: WireSnapshot): SemanticSnapshot {
	const { sequence: _sequence, timestampMs: _timestampMs, ...semantic } = snapshot;
	return semantic;
}

function envelopeJson(snapshot: WireSnapshot): string {
	return JSON.stringify({ version: 1, type: "snapshot", snapshot });
}

function reduceSnapshotToBody(snapshot: WireSnapshot): { json: string; semantic: string } | undefined {
	let json = envelopeJson(snapshot);
	const measure = (): boolean => Buffer.byteLength(json, "utf8") <= MAX_BODY_BYTES;
	if (measure()) return { json, semantic: JSON.stringify(semanticFromWire(snapshot)) };

	if (snapshot.currentTool?.intent !== undefined) {
		snapshot.currentTool = { name: snapshot.currentTool.name };
	}
	json = envelopeJson(snapshot);
	if (measure()) return { json, semantic: JSON.stringify(semanticFromWire(snapshot)) };

	if (snapshot.todos?.current !== undefined) {
		snapshot.todos = {
			pending: snapshot.todos.pending,
			inProgress: snapshot.todos.inProgress,
			blocked: snapshot.todos.blocked,
			completed: snapshot.todos.completed,
			abandoned: snapshot.todos.abandoned,
		};
	}
	json = envelopeJson(snapshot);
	if (measure()) return { json, semantic: JSON.stringify(semanticFromWire(snapshot)) };

	delete snapshot.goal;
	json = envelopeJson(snapshot);
	if (measure()) return { json, semantic: JSON.stringify(semanticFromWire(snapshot)) };

	delete snapshot.currentTool;
	json = envelopeJson(snapshot);
	if (measure()) return { json, semantic: JSON.stringify(semanticFromWire(snapshot)) };

	delete snapshot.asyncJobs;
	json = envelopeJson(snapshot);
	if (measure()) return { json, semantic: JSON.stringify(semanticFromWire(snapshot)) };

	delete snapshot.sessionName;
	json = envelopeJson(snapshot);
	if (measure()) return { json, semantic: JSON.stringify(semanticFromWire(snapshot)) };

	delete snapshot.thinkingLevel;
	json = envelopeJson(snapshot);
	if (measure()) return { json, semantic: JSON.stringify(semanticFromWire(snapshot)) };

	delete snapshot.model;
	json = envelopeJson(snapshot);
	if (measure()) return { json, semantic: JSON.stringify(semanticFromWire(snapshot)) };

	delete snapshot.statusText;
	json = envelopeJson(snapshot);
	if (measure()) return { json, semantic: JSON.stringify(semanticFromWire(snapshot)) };

	snapshot.cwd = truncateUtf8(snapshot.cwd, 1_024);
	json = envelopeJson(snapshot);
	if (measure()) return { json, semantic: JSON.stringify(semanticFromWire(snapshot)) };

	snapshot.cwd = truncateUtf8(snapshot.cwd, 256);
	json = envelopeJson(snapshot);
	if (measure()) return { json, semantic: JSON.stringify(semanticFromWire(snapshot)) };
	return undefined;
}

function wireSnapshot(semantic: SemanticSnapshot, sequence: number, timestampMs: number): WireSnapshot {
	return { ...semantic, sequence, timestampMs };
}

export function encodeFrame(
	secret: Uint8Array,
	sync: string,
	semantic: SemanticSnapshot,
	sequence: number,
): EncodedFrame | undefined {
	if (sequence > MAX_SAFE_INTEGER) return undefined;
	const timestampMs = Math.min(MAX_SAFE_INTEGER, Math.max(0, Math.trunc(Date.now())));
	const reduced = reduceSnapshotToBody(wireSnapshot(semantic, sequence, timestampMs));
	if (!reduced) return undefined;
	const bodyText = Buffer.from(reduced.json, "utf8").toString("base64url");
	if (bodyText.length > MAX_ENCODED_BODY_CHARS) return undefined;
	const tagText = hmac(secret, OUT_DOMAIN, bodyText).toString("base64url");
	const frame = `${OSC_PREFIX}${sync};${bodyText}.${tagText}${OSC_TERMINATOR}`;
	if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) return undefined;
	return { frame, semantic: reduced.semantic, sequence };
}
