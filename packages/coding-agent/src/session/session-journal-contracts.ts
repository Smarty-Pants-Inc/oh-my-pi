import { createHash } from "node:crypto";

import type { ISO8601, Sha256Hex } from "../registry/persistent-agent-contracts.js";

declare const primarySessionDurabilityReceiptBrand: unique symbol;

export type SessionJournalStreamId = `session:${string}`;

export type SessionJournalStreamDescriptorV1 =
	| {
			readonly schemaVersion: 1;
			readonly streamId: SessionJournalStreamId;
			readonly sessionId: string;
			readonly kind: "main" | "sub";
			readonly ownerAgentId: string;
			readonly parentStreamId?: SessionJournalStreamId;
	  }
	| {
			readonly schemaVersion: 1;
			readonly streamId: SessionJournalStreamId;
			readonly sessionId: string;
			readonly kind: "advisor";
			readonly parentStreamId: SessionJournalStreamId;
			readonly advisorId: string;
	  };

function isStrictJournalRecordV1(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		const actual = Reflect.ownKeys(value);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		return (
			(prototype === Object.prototype || prototype === null) &&
			actual.length === keys.length &&
			actual.every(key => {
				if (typeof key !== "string") return false;
				const descriptor = descriptors[key];
				return keys.includes(key) && descriptor?.enumerable && "value" in descriptor;
			})
		);
	} catch {
		return false;
	}
}

function isWellFormedJournalStringV1(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(++index);
			if (next < 0xdc00 || next > 0xdfff) return false;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function isSessionJournalStreamIdV1(value: unknown): value is SessionJournalStreamId {
	return isWellFormedJournalStringV1(value) && value.startsWith("session:") && value.length > "session:".length;
}

/** Strict closed validator for stream ownership and lineage. */
export function validateSessionJournalStreamDescriptorV1(input: unknown): input is SessionJournalStreamDescriptorV1 {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
	try {
		const kindDescriptor = Object.getOwnPropertyDescriptor(input, "kind");
		if (!kindDescriptor || !("value" in kindDescriptor)) return false;
		const kind = kindDescriptor.value;
		if (kind === "advisor") {
			if (
				!isStrictJournalRecordV1(input, [
					"schemaVersion",
					"streamId",
					"sessionId",
					"kind",
					"parentStreamId",
					"advisorId",
				])
			)
				return false;
			return (
				input.schemaVersion === 1 &&
				isSessionJournalStreamIdV1(input.streamId) &&
				isWellFormedJournalStringV1(input.sessionId) &&
				input.streamId === `session:${input.sessionId}` &&
				isSessionJournalStreamIdV1(input.parentStreamId) &&
				input.parentStreamId !== input.streamId &&
				isWellFormedJournalStringV1(input.advisorId) &&
				input.advisorId.trim() === input.advisorId
			);
		}
		const hasParent = Object.hasOwn(input, "parentStreamId");
		const keys = hasParent
			? ["schemaVersion", "streamId", "sessionId", "kind", "ownerAgentId", "parentStreamId"]
			: ["schemaVersion", "streamId", "sessionId", "kind", "ownerAgentId"];
		if (!isStrictJournalRecordV1(input, keys)) return false;
		return (
			input.schemaVersion === 1 &&
			(input.kind === "main" || input.kind === "sub") &&
			isSessionJournalStreamIdV1(input.streamId) &&
			isWellFormedJournalStringV1(input.sessionId) &&
			input.streamId === `session:${input.sessionId}` &&
			isWellFormedJournalStringV1(input.ownerAgentId) &&
			input.ownerAgentId.trim() === input.ownerAgentId &&
			(!hasParent || (isSessionJournalStreamIdV1(input.parentStreamId) && input.parentStreamId !== input.streamId))
		);
	} catch {
		return false;
	}
}

/** Strict decoder used before a stream handle is opened. */
export function decodeSessionJournalStreamDescriptorV1(input: unknown): SessionJournalStreamDescriptorV1 {
	if (!validateSessionJournalStreamDescriptorV1(input))
		throw new TypeError("session_journal_invalid_stream_descriptor");
	return input;
}

export type SessionJournalPrivacyClass = "transcript" | "credential-pseudonym";

export interface CanonicalSessionHeaderProjectionV1 {
	readonly canonicalLine: string;
}

export interface CanonicalSessionEntryProjectionV1 {
	readonly ordinal: number;
	readonly entryId: string;
	readonly entryType: string;
	readonly timestamp: string;
	readonly canonicalLine: string;
	readonly privacyClass: SessionJournalPrivacyClass;
}

export interface CanonicalSessionProjectionV1 {
	readonly schemaVersion: 1;
	readonly sessionId: string;
	readonly titleSlotLine: string;
	readonly header: CanonicalSessionHeaderProjectionV1;
	readonly entries: readonly CanonicalSessionEntryProjectionV1[];
}

export interface PrimarySessionDurabilityReceipt {
	readonly [primarySessionDurabilityReceiptBrand]: true;
	readonly committed: Promise<void>;
}

export type SessionJournalReplaceReason =
	| "create"
	| "open-reconcile"
	| "rewrite"
	| "title-change"
	| "header-change"
	| "move"
	| "fork"
	| "branch"
	| "copy"
	| "advisor-open"
	| "atomic-batch"
	| "persistence-recovery"
	| "queue-reconcile";

interface SessionJournalCommitBaseV1 {
	readonly schemaVersion: 1;
	readonly streamId: SessionJournalStreamId;
	readonly commitId: Sha256Hex;
	readonly primaryCommittedAt: ISO8601;
}

export interface SessionJournalAppendCommitV1 extends SessionJournalCommitBaseV1 {
	readonly kind: "append";
	readonly entry: CanonicalSessionEntryProjectionV1;
}

export interface SessionJournalReplaceCommitV1 extends SessionJournalCommitBaseV1 {
	readonly kind: "replace";
	readonly reason: SessionJournalReplaceReason;
	readonly projection: CanonicalSessionProjectionV1;
}

export interface SessionJournalDeleteCommitV1 extends SessionJournalCommitBaseV1 {
	readonly kind: "delete";
	readonly deletedAt: ISO8601;
}

export type SessionJournalCommitV1 =
	| SessionJournalAppendCommitV1
	| SessionJournalReplaceCommitV1
	| SessionJournalDeleteCommitV1;

const SESSION_JOURNAL_REPLACE_REASONS_V1: readonly SessionJournalReplaceReason[] = [
	"create",
	"open-reconcile",
	"rewrite",
	"title-change",
	"header-change",
	"move",
	"fork",
	"branch",
	"copy",
	"advisor-open",
	"atomic-batch",
	"persistence-recovery",
	"queue-reconcile",
];

function isCanonicalSessionJournalLineV1(value: unknown): value is string {
	return (
		isWellFormedJournalStringV1(value) &&
		value.length > 1 &&
		value.endsWith("\n") &&
		value.indexOf("\n") === value.length - 1 &&
		!value.includes("\r")
	);
}

function validateCanonicalSessionEntryProjectionV1(input: unknown): input is CanonicalSessionEntryProjectionV1 {
	return (
		isStrictJournalRecordV1(input, [
			"ordinal",
			"entryId",
			"entryType",
			"timestamp",
			"canonicalLine",
			"privacyClass",
		]) &&
		typeof input.ordinal === "number" &&
		Number.isSafeInteger(input.ordinal) &&
		input.ordinal >= 0 &&
		!Object.is(input.ordinal, -0) &&
		isWellFormedJournalStringV1(input.entryId) &&
		isWellFormedJournalStringV1(input.entryType) &&
		isWellFormedJournalStringV1(input.timestamp) &&
		isCanonicalSessionJournalLineV1(input.canonicalLine) &&
		(input.privacyClass === "transcript" || input.privacyClass === "credential-pseudonym")
	);
}

function validateCanonicalSessionProjectionV1(input: unknown): input is CanonicalSessionProjectionV1 {
	if (
		!isStrictJournalRecordV1(input, ["schemaVersion", "sessionId", "titleSlotLine", "header", "entries"]) ||
		input.schemaVersion !== 1 ||
		!isWellFormedJournalStringV1(input.sessionId) ||
		!isCanonicalSessionJournalLineV1(input.titleSlotLine) ||
		!isStrictJournalRecordV1(input.header, ["canonicalLine"]) ||
		!isCanonicalSessionJournalLineV1(input.header.canonicalLine) ||
		!Array.isArray(input.entries)
	)
		return false;
	let previousOrdinal = -1;
	const entryIds = new Set<string>();
	for (const entry of input.entries) {
		if (
			!validateCanonicalSessionEntryProjectionV1(entry) ||
			entry.ordinal <= previousOrdinal ||
			entryIds.has(entry.entryId)
		) {
			return false;
		}
		previousOrdinal = entry.ordinal;
		entryIds.add(entry.entryId);
	}
	return true;
}
function computeSessionJournalCommitIdV1(input: SessionJournalCommitV1): Sha256Hex {
	let identity: string;
	if (input.kind === "append") {
		identity = `journal/v1\0${input.streamId}\0append\0${input.entry.entryId}\0${input.entry.canonicalLine}`;
	} else if (input.kind === "replace") {
		const body =
			input.projection.titleSlotLine +
			input.projection.header.canonicalLine +
			input.projection.entries.map(entry => entry.canonicalLine).join("");
		identity = `journal/v1\0${input.streamId}\0replace\0${body}`;
	} else {
		identity = `journal/v1\0${input.streamId}\0delete`;
	}
	return createHash("sha256").update(identity, "utf8").digest("hex") as Sha256Hex;
}

/** Strict closed validator for append, replace, and delete journal commits. */
export function validateSessionJournalCommitV1(input: unknown): input is SessionJournalCommitV1 {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
	try {
		const kindDescriptor = Object.getOwnPropertyDescriptor(input, "kind");
		if (!kindDescriptor || !("value" in kindDescriptor)) return false;
		const kind = kindDescriptor.value;
		const keys =
			kind === "append"
				? ["schemaVersion", "streamId", "commitId", "primaryCommittedAt", "kind", "entry"]
				: kind === "replace"
					? ["schemaVersion", "streamId", "commitId", "primaryCommittedAt", "kind", "reason", "projection"]
					: kind === "delete"
						? ["schemaVersion", "streamId", "commitId", "primaryCommittedAt", "kind", "deletedAt"]
						: null;
		if (
			keys === null ||
			!isStrictJournalRecordV1(input, keys) ||
			input.schemaVersion !== 1 ||
			!isSessionJournalStreamIdV1(input.streamId) ||
			typeof input.commitId !== "string" ||
			!/^[0-9a-f]{64}$/.test(input.commitId) ||
			typeof input.primaryCommittedAt !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.primaryCommittedAt) ||
			new Date(input.primaryCommittedAt).toISOString() !== input.primaryCommittedAt
		)
			return false;
		if (kind === "append") {
			return (
				validateCanonicalSessionEntryProjectionV1(input.entry) &&
				input.commitId === computeSessionJournalCommitIdV1(input as unknown as SessionJournalCommitV1)
			);
		}
		if (kind === "replace") {
			return (
				typeof input.reason === "string" &&
				SESSION_JOURNAL_REPLACE_REASONS_V1.includes(input.reason as SessionJournalReplaceReason) &&
				validateCanonicalSessionProjectionV1(input.projection) &&
				input.streamId === `session:${input.projection.sessionId}` &&
				input.commitId === computeSessionJournalCommitIdV1(input as unknown as SessionJournalCommitV1)
			);
		}
		return (
			typeof input.deletedAt === "string" &&
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.deletedAt) &&
			new Date(input.deletedAt).toISOString() === input.deletedAt &&
			input.deletedAt >= input.primaryCommittedAt &&
			input.commitId === computeSessionJournalCommitIdV1(input as unknown as SessionJournalCommitV1)
		);
	} catch {
		return false;
	}
}

/** Strict decoder used before any journal sink effect. */
export function decodeSessionJournalCommitV1(input: unknown): SessionJournalCommitV1 {
	if (!validateSessionJournalCommitV1(input)) throw new TypeError("session_journal_invalid_commit");
	return input;
}

export type SessionJournalApplyResult = "applied" | "duplicate";

export interface SessionJournalSink {
	readonly id: string;
	apply(commit: SessionJournalCommitV1): Promise<SessionJournalApplyResult>;
	flush(): Promise<void>;
	close(): Promise<void>;
}

export type SessionJournalDeliveryStatus = "mirrored" | "disabled" | "primary-failed" | "degraded";

export interface SessionJournalDeliveryOutcome {
	readonly status: SessionJournalDeliveryStatus;
	readonly failedSinkIds: readonly string[];
}

export interface SessionJournalDeliveryReceipt {
	readonly streamId: SessionJournalStreamId;
	readonly commitId: Sha256Hex;
	readonly settled: Promise<SessionJournalDeliveryOutcome>;
}

export type SessionJournalSinkState = "healthy" | "degraded" | "out-of-sync" | "closed";

export interface SessionJournalHealthSnapshot {
	readonly state: SessionJournalSinkState;
	readonly pendingCommits: number;
	readonly failedSinkIds: readonly string[];
	readonly needsReconcileStreams: readonly SessionJournalStreamId[];
}

export interface SessionJournalFlushResult {
	readonly health: SessionJournalHealthSnapshot;
}

export interface SessionJournalStreamHandle {
	readonly descriptor: SessionJournalStreamDescriptorV1;
	readonly needsReconcile: boolean;
	append(
		entry: CanonicalSessionEntryProjectionV1,
		primary: PrimarySessionDurabilityReceipt,
	): SessionJournalDeliveryReceipt;
	replace(
		reason: SessionJournalReplaceReason,
		projection: CanonicalSessionProjectionV1,
		primary: PrimarySessionDurabilityReceipt,
	): SessionJournalDeliveryReceipt;
	delete(primary: PrimarySessionDurabilityReceipt): SessionJournalDeliveryReceipt;
	flush(): Promise<SessionJournalFlushResult>;
	close(): Promise<SessionJournalFlushResult>;
}

export interface SessionJournalService {
	openStream(descriptor: SessionJournalStreamDescriptorV1): SessionJournalStreamHandle;
	health(): SessionJournalHealthSnapshot;
	flush(): Promise<SessionJournalFlushResult>;
	close(): Promise<SessionJournalFlushResult>;
}
