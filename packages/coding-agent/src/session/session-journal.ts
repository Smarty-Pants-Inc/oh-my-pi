import { createHash } from "node:crypto";

import type { Sha256Hex } from "../registry/persistent-agent-contracts.js";
import {
	type CanonicalSessionEntryProjectionV1,
	type CanonicalSessionProjectionV1,
	decodeSessionJournalCommitV1,
	decodeSessionJournalStreamDescriptorV1,
	type PrimarySessionDurabilityReceipt,
	type SessionJournalCommitV1,
	type SessionJournalDeliveryOutcome,
	type SessionJournalDeliveryReceipt,
	type SessionJournalFlushResult,
	type SessionJournalHealthSnapshot,
	type SessionJournalReplaceReason,
	type SessionJournalService,
	type SessionJournalSink,
	type SessionJournalStreamDescriptorV1,
	type SessionJournalStreamHandle,
	type SessionJournalStreamId,
} from "./session-journal-contracts.js";

export interface ProcessSessionJournalOptions {
	readonly maximumAttempts?: number;
	readonly baseRetryDelayMs?: number;
	readonly maximumRetryDelayMs?: number;
	readonly now?: () => Date;
	readonly random?: () => number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface SinkStreamState {
	outOfSync: boolean;
}

interface StreamState {
	readonly descriptor: SessionJournalStreamDescriptorV1;
	readonly sinks: Map<string, SinkStreamState>;
	readonly projectedEntryIds: Set<string>;
	readonly submittedAppends: Map<string, CanonicalSessionEntryProjectionV1>;
	tail: Promise<void>;
	pendingCommits: number;
	handleCount: number;
	needsReconcile: boolean;
	nextAppendOrdinal: number | undefined;
}

interface PreparedCommit {
	readonly commitId: Sha256Hex;
	create(primaryCommittedAt: string, forceReconcile: boolean): SessionJournalCommitV1;
}

const RESOLVED_VOID = Promise.resolve();
const VALIDATION_COMMITTED_AT = "1970-01-01T00:00:00.000Z";

function canonicalProjectionBody(projection: CanonicalSessionProjectionV1): string {
	return (
		projection.titleSlotLine + projection.header.canonicalLine + projection.entries.map(e => e.canonicalLine).join("")
	);
}

function commitId(identity: string): Sha256Hex {
	return createHash("sha256").update(identity, "utf8").digest("hex") as Sha256Hex;
}

function freezeEntry(entry: CanonicalSessionEntryProjectionV1): CanonicalSessionEntryProjectionV1 {
	return Object.freeze({ ...entry });
}

function freezeProjection(projection: CanonicalSessionProjectionV1): CanonicalSessionProjectionV1 {
	return Object.freeze({
		...projection,
		header: Object.freeze({ ...projection.header }),
		entries: Object.freeze(projection.entries.map(freezeEntry)),
	});
}

function sameEntryProjection(
	left: CanonicalSessionEntryProjectionV1,
	right: CanonicalSessionEntryProjectionV1,
): boolean {
	return (
		left.ordinal === right.ordinal &&
		left.entryId === right.entryId &&
		left.entryType === right.entryType &&
		left.timestamp === right.timestamp &&
		left.canonicalLine === right.canonicalLine &&
		left.privacyClass === right.privacyClass
	);
}

function preparedAppend(streamId: SessionJournalStreamId, input: CanonicalSessionEntryProjectionV1): PreparedCommit {
	const entry = freezeEntry(input);
	const id = commitId(`journal/v1\0${streamId}\0append\0${entry.entryId}\0${entry.canonicalLine}`);
	const create = (primaryCommittedAt: string): SessionJournalCommitV1 => ({
		schemaVersion: 1,
		streamId,
		commitId: id,
		primaryCommittedAt,
		kind: "append",
		entry,
	});
	decodeSessionJournalCommitV1(create(VALIDATION_COMMITTED_AT));
	return { commitId: id, create };
}

function preparedReplace(
	streamId: SessionJournalStreamId,
	reason: SessionJournalReplaceReason,
	input: CanonicalSessionProjectionV1,
): PreparedCommit {
	const projection = freezeProjection(input);
	const id = commitId(`journal/v1\0${streamId}\0replace\0${canonicalProjectionBody(projection)}`);
	const create = (primaryCommittedAt: string, forceReconcile: boolean): SessionJournalCommitV1 => ({
		schemaVersion: 1,
		streamId,
		commitId: id,
		primaryCommittedAt,
		kind: "replace",
		reason: forceReconcile ? "queue-reconcile" : reason,
		projection,
	});
	decodeSessionJournalCommitV1(create(VALIDATION_COMMITTED_AT, false));
	return { commitId: id, create };
}

function preparedDelete(streamId: SessionJournalStreamId): PreparedCommit {
	const id = commitId(`journal/v1\0${streamId}\0delete`);
	const create = (primaryCommittedAt: string): SessionJournalCommitV1 => ({
		schemaVersion: 1,
		streamId,
		commitId: id,
		primaryCommittedAt,
		kind: "delete",
		deletedAt: primaryCommittedAt,
	});
	decodeSessionJournalCommitV1(create(VALIDATION_COMMITTED_AT));
	return { commitId: id, create };
}

function sameDescriptor(left: SessionJournalStreamDescriptorV1, right: SessionJournalStreamDescriptorV1): boolean {
	if (
		left.schemaVersion !== right.schemaVersion ||
		left.streamId !== right.streamId ||
		left.sessionId !== right.sessionId ||
		left.kind !== right.kind
	)
		return false;
	if (left.kind === "advisor" || right.kind === "advisor") {
		return (
			left.kind === "advisor" &&
			right.kind === "advisor" &&
			left.parentStreamId === right.parentStreamId &&
			left.advisorId === right.advisorId
		);
	}
	return left.ownerAgentId === right.ownerAgentId && left.parentStreamId === right.parentStreamId;
}

function outcome(
	status: SessionJournalDeliveryOutcome["status"],
	failedSinkIds: readonly string[],
): SessionJournalDeliveryOutcome {
	return Object.freeze({ status, failedSinkIds: Object.freeze([...failedSinkIds]) });
}

class ProcessSessionJournalStreamHandle implements SessionJournalStreamHandle {
	readonly descriptor: SessionJournalStreamDescriptorV1;
	readonly #service: ProcessSessionJournalService;
	readonly #state: StreamState;
	#closed = false;

	constructor(service: ProcessSessionJournalService, state: StreamState) {
		this.#service = service;
		this.#state = state;
		this.descriptor = state.descriptor;
	}

	get needsReconcile(): boolean {
		return this.#state.needsReconcile;
	}

	append(entry: CanonicalSessionEntryProjectionV1, primary: PrimarySessionDurabilityReceipt) {
		this.#assertOpen();
		return this.#service.enqueueAppend(this.#state, entry, primary);
	}

	replace(
		reason: SessionJournalReplaceReason,
		projection: CanonicalSessionProjectionV1,
		primary: PrimarySessionDurabilityReceipt,
	) {
		this.#assertOpen();
		return this.#service.enqueueReplace(this.#state, reason, projection, primary);
	}

	delete(primary: PrimarySessionDurabilityReceipt) {
		this.#assertOpen();
		return this.#service.enqueueDelete(this.#state, primary);
	}

	flush(): Promise<SessionJournalFlushResult> {
		return this.#service.flushStream(this.#state);
	}

	async close(): Promise<SessionJournalFlushResult> {
		if (this.#closed) return { health: this.#service.health() };
		this.#closed = true;
		return this.#service.closeHandle(this.#state);
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("session_journal_stream_handle_closed");
	}
}

/** Process-owned post-primary mirror with one independent FIFO per stream. */
export class ProcessSessionJournalService implements SessionJournalService {
	readonly #sinks: readonly SessionJournalSink[];
	readonly #streams = new Map<SessionJournalStreamId, StreamState>();
	readonly #maximumAttempts: number;
	readonly #baseRetryDelayMs: number;
	readonly #maximumRetryDelayMs: number;
	readonly #now: () => Date;
	readonly #random: () => number;
	readonly #sleep: (milliseconds: number) => Promise<void>;
	readonly #globalFailedSinkIds = new Set<string>();
	#pendingCommits = 0;
	#handleCount = 0;
	#closeRequested = false;
	#closed = false;
	#closePromise: Promise<SessionJournalFlushResult> | undefined;
	#handlesReleased: PromiseWithResolvers<void> | undefined;

	constructor(sinks: readonly SessionJournalSink[], options: ProcessSessionJournalOptions = {}) {
		const sinkIds = new Set<string>();
		for (const sink of sinks) {
			if (typeof sink.id !== "string" || sink.id.length === 0 || sink.id.trim() !== sink.id)
				throw new TypeError("session_journal_invalid_sink_id");
			if (sinkIds.has(sink.id)) throw new TypeError("session_journal_duplicate_sink_id");
			sinkIds.add(sink.id);
		}
		const maximumAttempts = options.maximumAttempts ?? 3;
		const baseRetryDelayMs = options.baseRetryDelayMs ?? 25;
		const maximumRetryDelayMs = options.maximumRetryDelayMs ?? 1_000;
		if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1)
			throw new TypeError("session_journal_invalid_maximum_attempts");
		if (!Number.isFinite(baseRetryDelayMs) || baseRetryDelayMs < 0)
			throw new TypeError("session_journal_invalid_base_retry_delay");
		if (!Number.isFinite(maximumRetryDelayMs) || maximumRetryDelayMs < baseRetryDelayMs)
			throw new TypeError("session_journal_invalid_maximum_retry_delay");
		this.#sinks = Object.freeze([...sinks]);
		this.#maximumAttempts = maximumAttempts;
		this.#baseRetryDelayMs = baseRetryDelayMs;
		this.#maximumRetryDelayMs = maximumRetryDelayMs;
		this.#now = options.now ?? (() => new Date());
		this.#random = options.random ?? Math.random;
		this.#sleep =
			options.sleep ??
			(milliseconds => {
				const pending = Promise.withResolvers<void>();
				setTimeout(pending.resolve, milliseconds);
				return pending.promise;
			});
	}

	openStream(input: SessionJournalStreamDescriptorV1): SessionJournalStreamHandle {
		this.#assertAccepting();
		const descriptor = Object.freeze({ ...decodeSessionJournalStreamDescriptorV1(input) });
		let state = this.#streams.get(descriptor.streamId);
		if (state) {
			if (!sameDescriptor(state.descriptor, descriptor))
				throw new Error("session_journal_stream_descriptor_conflict");
		} else {
			state = {
				descriptor,
				sinks: new Map(this.#sinks.map(sink => [sink.id, { outOfSync: false }])),
				projectedEntryIds: new Set(),
				submittedAppends: new Map(),
				tail: RESOLVED_VOID,
				pendingCommits: 0,
				handleCount: 0,
				needsReconcile: false,
				nextAppendOrdinal: undefined,
			};
			this.#streams.set(descriptor.streamId, state);
		}
		state.handleCount++;
		this.#handleCount++;
		return new ProcessSessionJournalStreamHandle(this, state);
	}

	health(): SessionJournalHealthSnapshot {
		const failedSinkIds = new Set(this.#globalFailedSinkIds);
		const needsReconcileStreams: SessionJournalStreamId[] = [];
		for (const [streamId, state] of this.#streams) {
			if (state.needsReconcile) needsReconcileStreams.push(streamId);
			for (const [sinkId, sinkState] of state.sinks) if (sinkState.outOfSync) failedSinkIds.add(sinkId);
		}
		const orderedFailedSinkIds = this.#sinks.map(sink => sink.id).filter(id => failedSinkIds.has(id));
		needsReconcileStreams.sort();
		return Object.freeze({
			state: this.#closed
				? "closed"
				: needsReconcileStreams.length > 0
					? "out-of-sync"
					: orderedFailedSinkIds.length > 0
						? "degraded"
						: "healthy",
			pendingCommits: this.#pendingCommits,
			failedSinkIds: Object.freeze(orderedFailedSinkIds),
			needsReconcileStreams: Object.freeze(needsReconcileStreams),
		});
	}

	async flush(): Promise<SessionJournalFlushResult> {
		await this.#awaitAllStreams();
		for (const sink of this.#sinks) {
			try {
				await sink.flush();
				this.#globalFailedSinkIds.delete(sink.id);
			} catch {
				this.#globalFailedSinkIds.add(sink.id);
				for (const state of this.#streams.values()) {
					state.sinks.get(sink.id)!.outOfSync = true;
					state.needsReconcile = true;
				}
			}
		}
		return { health: this.health() };
	}

	close(): Promise<SessionJournalFlushResult> {
		if (this.#closePromise) return this.#closePromise;
		this.#closeRequested = true;
		this.#closePromise = this.#closeService();
		return this.#closePromise;
	}

	enqueueAppend(
		state: StreamState,
		entry: CanonicalSessionEntryProjectionV1,
		primary: PrimarySessionDurabilityReceipt,
	) {
		this.#assertHandleAccepting();
		const prepared = preparedAppend(state.descriptor.streamId, entry);
		const duplicate = state.submittedAppends.get(entry.entryId);
		if (duplicate) {
			if (!sameEntryProjection(duplicate, entry)) throw new Error("session_journal_append_entry_conflict");
			return this.#enqueue(state, prepared, primary);
		}
		if (state.nextAppendOrdinal === undefined) throw new Error("session_journal_append_requires_replace");
		if (entry.ordinal !== state.nextAppendOrdinal) throw new Error("session_journal_append_not_next_tail");
		if (state.projectedEntryIds.has(entry.entryId)) throw new Error("session_journal_append_entry_conflict");
		state.nextAppendOrdinal++;
		state.projectedEntryIds.add(entry.entryId);
		state.submittedAppends.set(entry.entryId, freezeEntry(entry));
		return this.#enqueue(state, prepared, primary);
	}

	enqueueReplace(
		state: StreamState,
		reason: SessionJournalReplaceReason,
		projection: CanonicalSessionProjectionV1,
		primary: PrimarySessionDurabilityReceipt,
	) {
		this.#assertHandleAccepting();
		const prepared = preparedReplace(state.descriptor.streamId, reason, projection);
		state.projectedEntryIds.clear();
		state.submittedAppends.clear();
		for (const entry of projection.entries) state.projectedEntryIds.add(entry.entryId);
		state.nextAppendOrdinal = (projection.entries.at(-1)?.ordinal ?? -1) + 1;
		return this.#enqueue(state, prepared, primary);
	}

	enqueueDelete(state: StreamState, primary: PrimarySessionDurabilityReceipt) {
		this.#assertHandleAccepting();
		state.projectedEntryIds.clear();
		state.submittedAppends.clear();
		state.nextAppendOrdinal = undefined;
		return this.#enqueue(state, preparedDelete(state.descriptor.streamId), primary);
	}

	async flushStream(state: StreamState): Promise<SessionJournalFlushResult> {
		await this.#awaitStream(state);
		for (const sink of this.#sinks) {
			try {
				await sink.flush();
				this.#globalFailedSinkIds.delete(sink.id);
			} catch {
				this.#globalFailedSinkIds.add(sink.id);
				state.sinks.get(sink.id)!.outOfSync = true;
				state.needsReconcile = true;
			}
		}
		return { health: this.health() };
	}

	async closeHandle(state: StreamState): Promise<SessionJournalFlushResult> {
		const result = await this.flushStream(state);
		state.handleCount--;
		this.#handleCount--;
		if (this.#handleCount === 0) this.#handlesReleased?.resolve();
		return result;
	}

	#enqueue(
		state: StreamState,
		prepared: PreparedCommit,
		primary: PrimarySessionDurabilityReceipt,
	): SessionJournalDeliveryReceipt {
		state.pendingCommits++;
		this.#pendingCommits++;
		const settled = state.tail
			.then(() => this.#deliver(state, prepared, primary))
			.finally(() => {
				state.pendingCommits--;
				this.#pendingCommits--;
			});
		state.tail = settled.then(
			() => undefined,
			() => undefined,
		);
		return Object.freeze({ streamId: state.descriptor.streamId, commitId: prepared.commitId, settled });
	}

	async #deliver(
		state: StreamState,
		prepared: PreparedCommit,
		primary: PrimarySessionDurabilityReceipt,
	): Promise<SessionJournalDeliveryOutcome> {
		try {
			await primary.committed;
		} catch {
			if (this.#sinks.length > 0) {
				state.needsReconcile = true;
				for (const sinkState of state.sinks.values()) sinkState.outOfSync = true;
			}
			return outcome("primary-failed", []);
		}
		const commit = Object.freeze(
			decodeSessionJournalCommitV1(prepared.create(this.#now().toISOString(), state.needsReconcile)),
		) as SessionJournalCommitV1;
		if (this.#sinks.length === 0) return outcome("disabled", []);
		const failedSinkIds: string[] = [];
		for (const sink of this.#sinks) {
			const sinkState = state.sinks.get(sink.id)!;
			if (commit.kind === "append" && sinkState.outOfSync) {
				failedSinkIds.push(sink.id);
				continue;
			}
			if (await this.#applyWithRetry(sink, commit)) {
				if (commit.kind !== "append") sinkState.outOfSync = false;
			} else {
				sinkState.outOfSync = true;
				failedSinkIds.push(sink.id);
			}
		}
		if (commit.kind !== "append") state.needsReconcile = [...state.sinks.values()].some(s => s.outOfSync);
		else if (failedSinkIds.length > 0) state.needsReconcile = true;
		return failedSinkIds.length === 0 ? outcome("mirrored", []) : outcome("degraded", failedSinkIds);
	}

	async #applyWithRetry(sink: SessionJournalSink, commit: SessionJournalCommitV1): Promise<boolean> {
		for (let attempt = 0; attempt < this.#maximumAttempts; attempt++) {
			try {
				const result = await sink.apply(commit);
				if (result !== "applied" && result !== "duplicate")
					throw new TypeError("session_journal_invalid_apply_result");
				return true;
			} catch {
				if (attempt + 1 >= this.#maximumAttempts) return false;
				const exponential = Math.min(this.#maximumRetryDelayMs, this.#baseRetryDelayMs * 2 ** attempt);
				const random = Math.min(1, Math.max(0, this.#random()));
				await this.#sleep(Math.floor(exponential * (0.5 + random * 0.5)));
			}
		}
		return false;
	}

	async #awaitStream(state: StreamState): Promise<void> {
		while (state.pendingCommits > 0) await state.tail;
	}

	async #awaitAllStreams(): Promise<void> {
		while (this.#pendingCommits > 0) await Promise.all([...this.#streams.values()].map(state => state.tail));
	}

	async #closeService(): Promise<SessionJournalFlushResult> {
		await this.flush();
		if (this.#handleCount > 0) {
			const released = Promise.withResolvers<void>();
			this.#handlesReleased = released;
			if (this.#handleCount === 0) released.resolve();
			await released.promise;
		}
		for (const sink of this.#sinks) {
			try {
				await sink.close();
			} catch {
				this.#globalFailedSinkIds.add(sink.id);
			}
		}
		this.#closed = true;
		return { health: this.health() };
	}

	#assertHandleAccepting(): void {
		if (this.#closed) throw new Error("session_journal_service_closed");
	}

	#assertAccepting(): void {
		if (this.#closeRequested || this.#closed) throw new Error("session_journal_service_closed");
	}
}
