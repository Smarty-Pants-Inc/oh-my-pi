import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { Sha256Hex } from "../../../src/registry/persistent-agent-contracts.js";
import { ProcessSessionJournalService } from "../../../src/session/session-journal.js";
import type {
	CanonicalSessionEntryProjectionV1,
	CanonicalSessionProjectionV1,
	SessionJournalCommitV1,
	SessionJournalSink,
	SessionJournalStreamDescriptorV1,
} from "../../../src/session/session-journal-contracts.js";
import { SessionManager } from "../../../src/session/session-manager.js";
import { createPrimarySessionDurabilityReceipt, MemorySessionStorage } from "../../../src/session/session-storage.js";

const COMMITTED_AT = "2026-08-06T12:00:00.000Z";

function sha256(value: string): Sha256Hex {
	return createHash("sha256").update(value, "utf8").digest("hex") as Sha256Hex;
}

function descriptor(sessionId: string, ownerAgentId = "Main"): SessionJournalStreamDescriptorV1 {
	return {
		schemaVersion: 1,
		streamId: `session:${sessionId}`,
		sessionId,
		kind: "main",
		ownerAgentId,
	};
}

function entry(
	ordinal: number,
	entryId: string,
	privacyClass: CanonicalSessionEntryProjectionV1["privacyClass"] = "transcript",
): CanonicalSessionEntryProjectionV1 {
	return Object.freeze({
		ordinal,
		entryId,
		entryType: privacyClass === "credential-pseudonym" ? "credential_pin" : "custom",
		timestamp: COMMITTED_AT,
		canonicalLine: `${JSON.stringify({ type: "custom", id: entryId, ordinal })}\n`,
		privacyClass,
	});
}

function projection(
	sessionId: string,
	entries: readonly CanonicalSessionEntryProjectionV1[] = [],
	title = "Session",
): CanonicalSessionProjectionV1 {
	return Object.freeze({
		schemaVersion: 1,
		sessionId,
		titleSlotLine: `${JSON.stringify({ type: "session_title", title })}\n`,
		header: Object.freeze({ canonicalLine: `${JSON.stringify({ type: "session", id: sessionId })}\n` }),
		entries: Object.freeze([...entries]),
	});
}

function projectionBody(value: CanonicalSessionProjectionV1): string {
	return value.titleSlotLine + value.header.canonicalLine + value.entries.map(item => item.canonicalLine).join("");
}

class RecordingSink implements SessionJournalSink {
	readonly id: string;
	readonly commits: SessionJournalCommitV1[] = [];
	readonly attempts: SessionJournalCommitV1[] = [];
	readonly #seen = new Map<string, string>();
	failApplyCount = 0;
	flushCount = 0;
	closeCount = 0;

	constructor(id = "recording") {
		this.id = id;
	}

	async apply(commit: SessionJournalCommitV1): Promise<"applied" | "duplicate"> {
		this.attempts.push(commit);
		if (this.failApplyCount > 0) {
			this.failApplyCount--;
			throw new Error("injected journal sink failure");
		}
		const encoded = JSON.stringify(commit, (key, value) =>
			key === "primaryCommittedAt" || key === "reason" || key === "deletedAt" ? undefined : value,
		);
		const prior = this.#seen.get(commit.commitId);
		if (prior !== undefined) {
			if (prior !== encoded) throw new Error("commit id payload conflict");
			return "duplicate";
		}
		this.#seen.set(commit.commitId, encoded);
		this.commits.push(commit);
		return "applied";
	}

	async flush(): Promise<void> {
		this.flushCount++;
	}

	async close(): Promise<void> {
		this.closeCount++;
	}
}

describe("JournalStorageCore", () => {
	it("uses one canonical projection for primary storage and Append/Replace/Delete journal effects", async () => {
		const storage = new MemorySessionStorage();
		const sink = new RecordingSink();
		const service = new ProcessSessionJournalService([sink], { now: () => new Date(COMMITTED_AT) });
		const manager = SessionManager.create("/workspace", "/sessions", storage);
		const sessionId = manager.getSessionId();
		await manager.attachSessionJournal(service, descriptor(sessionId));

		manager.appendCredentialPin("anthropic", "opaque-account-pseudonym");
		await manager.ensureOnDisk();
		await manager.flush();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persistent session file");
		const create = sink.commits.at(-1);
		if (create?.kind !== "replace") throw new Error("expected create Replace");
		expect(create.reason).toBe("create");
		expect(await storage.readText(sessionFile)).toBe(projectionBody(create.projection));
		expect(create.projection.entries).toHaveLength(1);
		expect(create.projection.entries[0]?.privacyClass).toBe("credential-pseudonym");
		expect(create.projection.entries[0]?.canonicalLine).toContain("opaque-account-pseudonym");
		expect(create.commitId).toBe(
			sha256(`journal/v1\0session:${sessionId}\0replace\0${projectionBody(create.projection)}`),
		);

		const customId = manager.appendCustomEntry("note", { text: "visible" });
		await manager.flush();
		const append = sink.commits.at(-1);
		if (append?.kind !== "append") throw new Error("expected hot-path Append");
		expect(append.entry.entryId).toBe(customId);
		expect(append.entry.privacyClass).toBe("transcript");
		expect(await storage.readText(sessionFile)).toEndWith(append.entry.canonicalLine);
		expect(append.commitId).toBe(
			sha256(`journal/v1\0session:${sessionId}\0append\0${customId}\0${append.entry.canonicalLine}`),
		);

		await manager.setSessionName("Renamed", "user");
		await manager.flush();
		const titleChange = sink.commits.at(-1);
		if (titleChange?.kind !== "replace") throw new Error("expected title Replace");
		expect(titleChange.reason).toBe("title-change");
		expect(await storage.readText(sessionFile)).toBe(projectionBody(titleChange.projection));

		await manager.dropSession(sessionFile);
		expect(storage.existsSync(sessionFile)).toBe(false);
		const deletion = sink.commits.at(-1);
		if (deletion?.kind !== "delete") throw new Error("expected Delete");
		expect(deletion.commitId).toBe(sha256(`journal/v1\0session:${sessionId}\0delete`));
		expect(deletion.deletedAt).toBe(deletion.primaryCommittedAt);
		await service.close();
		expect(sink.closeCount).toBe(1);
	});

	it("waits for matching primary receipts, preserves per-stream FIFO, and lets other streams progress", async () => {
		const sink = new RecordingSink();
		const service = new ProcessSessionJournalService([sink], { now: () => new Date(COMMITTED_AT) });
		const a = service.openStream(descriptor("a", "A"));
		const b = service.openStream(descriptor("b", "B"));
		const primaryA = Promise.withResolvers<void>();
		const aFirstProjection = projection("a");
		const aSecondProjection = projection("a", [entry(0, "a-entry")]);
		const firstA = a.replace("create", aFirstProjection, createPrimarySessionDurabilityReceipt(primaryA.promise));
		const secondA = a.replace("rewrite", aSecondProjection, createPrimarySessionDurabilityReceipt(Promise.resolve()));
		const firstB = b.replace("create", projection("b"), createPrimarySessionDurabilityReceipt(Promise.resolve()));

		expect((await firstB.settled).status).toBe("mirrored");
		expect(sink.commits.map(commit => commit.streamId)).toEqual(["session:b"]);
		primaryA.resolve();
		expect((await firstA.settled).status).toBe("mirrored");
		expect((await secondA.settled).status).toBe("mirrored");
		expect(sink.commits.map(commit => commit.streamId)).toEqual(["session:b", "session:a", "session:a"]);
		expect(firstA.commitId).toBe(sha256(`journal/v1\0session:a\0replace\0${projectionBody(aFirstProjection)}`));

		await a.close();
		await b.close();
		await service.close();
	});

	it("marks primary failures out of sync, skips appends, and reconciles with the next full projection", async () => {
		const sink = new RecordingSink();
		const service = new ProcessSessionJournalService([sink], { now: () => new Date(COMMITTED_AT) });
		const handle = service.openStream(descriptor("recover"));
		const primaryFailure = Promise.withResolvers<void>();
		const failed = handle.replace(
			"create",
			projection("recover"),
			createPrimarySessionDurabilityReceipt(primaryFailure.promise),
		);
		primaryFailure.reject(new Error("primary failed"));
		expect((await failed.settled).status).toBe("primary-failed");
		expect(sink.attempts).toHaveLength(0);
		expect(handle.needsReconcile).toBe(true);

		const tail = entry(0, "tail");
		const skipped = handle.append(tail, createPrimarySessionDurabilityReceipt(Promise.resolve()));
		expect((await skipped.settled).status).toBe("degraded");
		expect(sink.attempts).toHaveLength(0);

		const reconciled = handle.replace(
			"rewrite",
			projection("recover", [tail]),
			createPrimarySessionDurabilityReceipt(Promise.resolve()),
		);
		expect((await reconciled.settled).status).toBe("mirrored");
		expect(sink.commits).toHaveLength(1);
		expect(sink.commits[0]).toMatchObject({ kind: "replace", reason: "queue-reconcile" });
		expect(handle.needsReconcile).toBe(false);

		await handle.close();
		await service.close();
	});

	it("bounds retries, coalesces out-of-sync appends, and closes sinks only after shared handles release", async () => {
		const sink = new RecordingSink();
		sink.failApplyCount = 2;
		const service = new ProcessSessionJournalService([sink], {
			maximumAttempts: 2,
			baseRetryDelayMs: 0,
			maximumRetryDelayMs: 0,
			now: () => new Date(COMMITTED_AT),
			sleep: async () => {},
		});
		const primary = service.openStream(descriptor("shared"));
		const clone = service.openStream(descriptor("shared"));
		const initial = primary.replace(
			"create",
			projection("shared"),
			createPrimarySessionDurabilityReceipt(Promise.resolve()),
		);
		expect((await initial.settled).status).toBe("degraded");
		expect(sink.attempts).toHaveLength(2);
		expect(new Set(sink.attempts.map(commit => commit.commitId)).size).toBe(1);

		const tail = entry(0, "shared-tail");
		const skipped = clone.append(tail, createPrimarySessionDurabilityReceipt(Promise.resolve()));
		expect((await skipped.settled).status).toBe("degraded");
		expect(sink.attempts).toHaveLength(2);
		const repair = primary.replace(
			"rewrite",
			projection("shared", [tail]),
			createPrimarySessionDurabilityReceipt(Promise.resolve()),
		);
		expect((await repair.settled).status).toBe("mirrored");
		expect(sink.commits[0]).toMatchObject({ kind: "replace", reason: "queue-reconcile" });

		const repeatedTail = entry(1, "shared-repeat");
		const firstDelivery = primary.append(repeatedTail, createPrimarySessionDurabilityReceipt(Promise.resolve()));
		const duplicateDelivery = clone.append(repeatedTail, createPrimarySessionDurabilityReceipt(Promise.resolve()));
		expect(firstDelivery.commitId).toBe(duplicateDelivery.commitId);
		expect((await firstDelivery.settled).status).toBe("mirrored");
		expect((await duplicateDelivery.settled).status).toBe("mirrored");
		expect(sink.commits.filter(commit => commit.commitId === firstDelivery.commitId)).toHaveLength(1);

		let serviceClosed = false;
		const closing = service.close().then(() => {
			serviceClosed = true;
		});
		await Promise.resolve();
		expect(serviceClosed).toBe(false);
		await primary.close();
		expect(serviceClosed).toBe(false);
		await clone.close();
		await closing;
		expect(serviceClosed).toBe(true);
		expect(sink.closeCount).toBe(1);
	});

	it("releases a degraded manager handle after service close is requested", async () => {
		const storage = new MemorySessionStorage();
		const sink = new RecordingSink();
		const service = new ProcessSessionJournalService([sink], {
			maximumAttempts: 1,
			now: () => new Date(COMMITTED_AT),
		});
		const manager = SessionManager.create("/workspace", "/sessions", storage);
		const sessionId = manager.getSessionId();
		await manager.attachSessionJournal(service, descriptor(sessionId));
		await manager.ensureOnDisk();
		await manager.flush();

		sink.failApplyCount = 1;
		manager.appendCustomEntry("degraded", { close: true });
		const degraded = await service.flush();
		expect(degraded.health.state).toBe("out-of-sync");

		const closing = service.close();
		await manager.close();
		await closing;
		expect(sink.commits.at(-1)).toMatchObject({ kind: "replace", reason: "queue-reconcile" });
		expect(sink.closeCount).toBe(1);
	});

	it("rebinds a restored manager to its original shared stream", async () => {
		const storage = new MemorySessionStorage();
		const sink = new RecordingSink();
		const service = new ProcessSessionJournalService([sink], { now: () => new Date(COMMITTED_AT) });
		const manager = SessionManager.create("/workspace", "/sessions", storage);
		const originalSessionId = manager.getSessionId();
		await manager.attachSessionJournal(service, descriptor(originalSessionId));
		manager.appendCredentialPin("anthropic", "opaque-account-pseudonym");
		await manager.ensureOnDisk();
		await manager.flush();
		const originalState = manager.captureState();

		const target = SessionManager.create("/workspace", "/sessions", storage);
		await target.ensureOnDisk();
		const targetSessionId = target.getSessionId();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("expected a target session file");
		await target.close();

		await manager.setSessionFile(targetFile);
		manager.restoreState(originalState);
		const appendedId = manager.appendCustomEntry("after-restore", { restored: true });
		await manager.flush();

		const restoredAppend = sink.commits.findLast(
			commit => commit.kind === "append" && commit.streamId === `session:${originalSessionId}`,
		);
		if (restoredAppend?.kind !== "append") throw new Error("expected append on the restored stream");
		expect(restoredAppend.entry.entryId).toBe(appendedId);
		expect(
			sink.commits.some(commit => commit.kind === "append" && commit.streamId === `session:${targetSessionId}`),
		).toBe(false);

		await manager.close();
		await service.close();
	});

	it("canonicalizes a legacy primary body before open reconciliation", async () => {
		const storage = new MemorySessionStorage();
		const sink = new RecordingSink();
		const service = new ProcessSessionJournalService([sink], { now: () => new Date(COMMITTED_AT) });
		const manager = SessionManager.create("/workspace", "/sessions", storage);
		const sessionId = Bun.randomUUIDv7();
		const sessionFile = "/sessions/legacy.jsonl";
		storage.writeTextSync(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: COMMITTED_AT,
				cwd: "/workspace",
			})}\n`,
		);
		await manager.setSessionFile(sessionFile);
		await manager.attachSessionJournal(service, descriptor(sessionId));
		await manager.flush();

		const opened = sink.commits.at(-1);
		if (opened?.kind !== "replace") throw new Error("expected open reconciliation Replace");
		expect(opened.reason).toBe("open-reconcile");
		expect(await storage.readText(sessionFile)).toBe(projectionBody(opened.projection));

		await manager.close();
		await service.close();
	});

	it("uses advisor-open for an explicitly attached advisor stream", async () => {
		const storage = new MemorySessionStorage();
		const sink = new RecordingSink();
		const service = new ProcessSessionJournalService([sink], { now: () => new Date(COMMITTED_AT) });
		const manager = SessionManager.create("/workspace", "/sessions", storage);
		const sessionId = manager.getSessionId();
		await manager.attachSessionJournal(service, {
			schemaVersion: 1,
			streamId: `session:${sessionId}`,
			sessionId,
			kind: "advisor",
			parentStreamId: "session:parent",
			advisorId: "reviewer",
		});
		await manager.flush();
		const opened = sink.commits.at(-1);
		if (opened?.kind !== "replace") throw new Error("expected advisor Replace");
		expect(opened.reason).toBe("advisor-open");
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected advisor session file");
		expect(await storage.readText(sessionFile)).toBe(projectionBody(opened.projection));

		await manager.close();
		await service.close();
	});
});
