import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ImageContent,
	Message,
	MessageAttribution,
	ServiceTierByFamily,
	TextContent,
	Usage,
} from "@oh-my-pi/pi-ai";
import {
	directoryExists,
	getBlobsDir,
	getProjectDir,
	getSessionsDir,
	isEnoent,
	logger,
	stringifyJson,
	toError,
} from "@oh-my-pi/pi-utils";
import type { StructuredSubagentSchemaMode } from "../task/types";
import {
	ArtifactManager,
	type ArtifactManagerTransaction,
	type ArtifactTransaction,
	type ArtifactWriterLease,
} from "./artifacts";
import { type BlobPutOptions, type BlobPutResult, BlobStore } from "./blob-store";
import type { CompactionMethod } from "./compaction-methods";
import {
	type BashExecutionMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	normalizeCustomMessagePayload,
	type PythonExecutionMessage,
	sanitizeRehydratedOpenAIResponsesAssistantMessage,
	stripInternalDetailsFields,
} from "./messages";
import { type BuildSessionContextOptions, buildSessionContext, type SessionContext } from "./session-context";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type CredentialPinEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	type LabelEntry,
	type ModeChangeEntry,
	type ModelChangeEntry,
	type NewSessionOptions,
	type ResetBoundaryEntry,
	SESSION_LEAF_ENTRY_TYPE,
	type ServiceTierChangeEntry,
	type SessionEntry,
	type SessionHeader,
	type SessionInitEntry,
	type SessionLeafEntry,
	type SessionMessageEntry,
	type SessionTitleSource,
	type SessionTreeNode,
	type ThinkingLevelChangeEntry,
	TITLE_CHANGE_ENTRY_TYPE,
	type TitleChangeEntry,
	type TtsrInjectionEntry,
	type UsageStatistics,
} from "./session-entries";
import { findMostRecentSession, listAllSessions, listSessions, type SessionInfo } from "./session-listing";
import {
	loadEntriesFromFile,
	loadSessionFile,
	readTitleSlotFromFile,
	resolveBlobRefsInEntries,
	restoreSessionJournal,
	type SessionLoadResult,
	visitEntriesFromFile,
} from "./session-loader";
import { generateId, migrateToCurrentVersion } from "./session-migrations";
import {
	computeDefaultSessionDir,
	readTerminalBreadcrumbEntry,
	resolveManagedSessionRoot,
	writeTerminalBreadcrumb,
} from "./session-paths";
import { prepareEntryForPersistence } from "./session-persistence";
import { loadPinnedSessionIds, sortPinnedFirst } from "./session-pins";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
	type SessionStorageWriter,
} from "./session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "./session-title-slot";
import {
	additionalWorkspaceDirectories,
	normalizeSessionWorkspace,
	normalizeWorkspaceDirectory,
} from "./session-workspace";
import { recordSessionTitle } from "./title-index";

const JSONL_SUFFIX_LENGTH = ".jsonl".length;
const DRAFT_ONLY_SESSION_MARKER = ".draft-only-session";
const DISCARDED_ENTRY_BRANCH_MARKER = "discarded-entry-branch";
const reconciledArtifactRoots = new Set<string>();

/** Deep-copy session state through the same JSON value boundary used by the durable journal. */
function cloneDurableSessionJson<T>(value: T): T {
	const serialized = stringifyJson(value);
	if (serialized === undefined) throw new TypeError("Session state is not JSON-serializable");
	return JSON.parse(serialized) as T;
}

function mintSessionId(): string {
	return Bun.randomUUIDv7();
}

function nowIso(): string {
	return new Date().toISOString();
}

function fileSafeTimestamp(iso: string): string {
	return iso.replace(/[:.]/g, "-");
}

function artifactsDirectoryFor(sessionFile: string | undefined): string | null {
	if (!sessionFile?.endsWith(".jsonl")) return null;
	return sessionFile.slice(0, -JSONL_SUFFIX_LENGTH);
}

/** Copy a session's artifact directory to another session, matching interactive `/fork`. */
export async function copySessionArtifacts(sourceSessionFile: string, destinationSessionFile: string): Promise<void> {
	const sourceArtifactsDir = artifactsDirectoryFor(sourceSessionFile);
	const destinationArtifactsDir = artifactsDirectoryFor(destinationSessionFile);
	if (!sourceArtifactsDir || !destinationArtifactsDir) return;
	if (path.resolve(sourceArtifactsDir) === path.resolve(destinationArtifactsDir)) return;

	try {
		const sourceStat = await fs.promises.stat(sourceArtifactsDir);
		if (sourceStat.isDirectory()) {
			await fs.promises.cp(sourceArtifactsDir, destinationArtifactsDir, { recursive: true });
		}
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to copy artifacts during fork", {
				sourceArtifactsDir,
				destinationArtifactsDir,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/**
 * Resolve a breadcrumb's recorded session file to its interactive root. Subagent
 * (and other artifact) sessions live inside a parent session's artifacts dir —
 * `<parent>.jsonl` strips its suffix to `<parent>/`, and a child writes
 * `<parent>/<agentId>.jsonl`. A breadcrumb that points at such a child — a
 * pre-fix poisoned crumb left by a subagent that opened in the parent's TTY, or
 * any nested artifact — must resolve back up to the top-level session so
 * `--continue` resumes the real conversation instead of a subagent transcript.
 */
function resolveBreadcrumbToInteractiveRoot(sessionFile: string): string {
	let current = path.resolve(sessionFile);
	// Walk up while the containing dir is itself a session's artifacts dir
	// (`<dir>.jsonl` exists). Capped to defend against pathological layouts.
	for (let depth = 0; depth < 8; depth++) {
		const parentSessionFile = `${path.dirname(current)}.jsonl`;
		if (!fs.existsSync(parentSessionFile)) return current;
		current = parentSessionFile;
	}
	return current;
}

function emptyUsageStatistics(): UsageStatistics {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 0,
		cost: 0,
	};
}

function taskUsageFrom(details: unknown): Usage | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const maybeUsage = (details as Record<string, unknown>).usage;
	return maybeUsage !== null && typeof maybeUsage === "object" ? (maybeUsage as Usage) : undefined;
}

function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "assistant") return message.usage;
	if (message.role === "toolResult" && message.toolName === "task") return taskUsageFrom(message.details);
	return undefined;
}

function addUsage(target: UsageStatistics, usage: Usage | undefined): void {
	if (!usage) return;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.orchestrationInput += usage.orchestration?.input ?? 0;
	target.orchestrationOutput += usage.orchestration?.output ?? 0;
	target.orchestrationCacheRead += usage.orchestration?.cacheRead ?? 0;
	target.premiumRequests += usage.premiumRequests ?? 0;
	target.cost += usage.cost.total;
}

function isAssistantEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "assistant";
}

function isDraftOnlyMetadataEntry(entry: SessionEntry): boolean {
	// Startup-recorded selector state that does not survive as user intent
	// once the draft is cleared. `mode_change` covers the `plan.defaultOnStartup`
	// path (interactive-mode.ts enters plan mode before draft restoration) and
	// `/plan` toggles that leave the session otherwise empty; entries carrying
	// real conversation state — messages, compactions, branch summaries,
	// custom/custom_message, session_init, labels, title/tool selection — never
	// reach this branch and always keep the file resumable.
	switch (entry.type) {
		case "model_change":
		case "thinking_level_change":
		case "service_tier_change":
		case "mode_change":
		case "credential_pin":
			return true;
		default:
			return false;
	}
}

function orderedByTimestamp(a: SessionTreeNode, b: SessionTreeNode): number {
	return new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime();
}

/**
 * Maintains the derived views over a session's entry list: id lookup, the
 * parent→children adjacency, the resolved label map, the active leaf, and the
 * running usage totals. Kept in lockstep with the manager's `#entries` so reads
 * stay O(1)/O(children) instead of rescanning the whole journal.
 */
class SessionEntryIndex {
	#entriesById = new Map<string, SessionEntry>();
	#children = new Map<string | null, SessionEntry[]>();
	#labels = new Map<string, string>();
	#leaf: string | null = null;
	#usage = emptyUsageStatistics();

	clear(): void {
		this.#entriesById.clear();
		this.#children.clear();
		this.#labels.clear();
		this.#leaf = null;
		this.#usage = emptyUsageStatistics();
	}

	rebuild(entries: readonly SessionEntry[], leafId?: string | null): void {
		this.clear();
		for (const entry of entries) this.insert(entry);
		if (leafId === null || (leafId !== undefined && this.#entriesById.has(leafId))) this.#leaf = leafId;
	}

	insert(entry: SessionEntry): void {
		this.#entriesById.set(entry.id, entry);
		this.#leaf = entry.id;

		const bucket = this.#children.get(entry.parentId);
		if (bucket) bucket.push(entry);
		else this.#children.set(entry.parentId, [entry]);

		if (entry.type === "label") {
			if (entry.label) this.#labels.set(entry.targetId, entry.label);
			else this.#labels.delete(entry.targetId);
		}

		addUsage(this.#usage, entryUsage(entry));
	}

	has(id: string): boolean {
		return this.#entriesById.has(id);
	}

	get(id: string): SessionEntry | undefined {
		return this.#entriesById.get(id);
	}

	/**
	 * The live id→entry map. Read-only for callers (lookups + `generateId`
	 * collision checks); never mutate it directly — go through `insert`/`rebuild`.
	 */
	entriesById(): Map<string, SessionEntry> {
		return this.#entriesById;
	}

	leafId(): string | null {
		return this.#leaf;
	}

	leafEntry(): SessionEntry | undefined {
		return this.#leaf ? this.#entriesById.get(this.#leaf) : undefined;
	}

	setLeaf(id: string | null): void {
		this.#leaf = id;
	}

	childrenOf(parentId: string): SessionEntry[] {
		return [...(this.#children.get(parentId) ?? [])];
	}

	labelFor(id: string): string | undefined {
		return this.#labels.get(id);
	}

	labelsInEffect(): IterableIterator<[string, string]> {
		return this.#labels.entries();
	}

	usageSnapshot(): UsageStatistics {
		return { ...this.#usage };
	}

	pathTo(id: string | null | undefined = this.#leaf): SessionEntry[] {
		const branch: SessionEntry[] = [];
		const seen = new Set<string>();
		let cursor = id ? this.#entriesById.get(id) : undefined;

		while (cursor && !seen.has(cursor.id)) {
			seen.add(cursor.id);
			branch.push(cursor);
			cursor = cursor.parentId ? this.#entriesById.get(cursor.parentId) : undefined;
		}
		branch.reverse();
		return branch;
	}

	tree(entries: readonly SessionEntry[]): SessionTreeNode[] {
		const nodes = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const entry of entries) {
			nodes.set(entry.id, { entry, children: [], label: this.#labels.get(entry.id) });
		}

		for (const entry of entries) {
			const node = nodes.get(entry.id)!;
			const parentId = entry.parentId;
			if (parentId === null || parentId === entry.id) {
				roots.push(node);
				continue;
			}

			const parent = nodes.get(parentId);
			if (parent) parent.children.push(node);
			else roots.push(node);
		}

		const stack = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort(orderedByTimestamp);
			stack.push(...node.children);
		}

		return roots;
	}
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getSessionName"
	| "onSessionNameChanged"
	| "getArtifactsDir"
	| "getArtifactManager"
	| "allocateArtifactPath"
	| "saveArtifact"
	| "getArtifactPath"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getUsageStatistics"
	| "putBlob"
	| "putBlobSync"
	| "ensureOnDisk"
>;

export interface SessionManagerStateSnapshot {
	cwd: string;
	sessionDir: string;
	sessionId: string;
	sessionName: string | undefined;
	titleSource: SessionTitleSource | undefined;
	sessionFile: string | undefined;
	/** Monotonic generation of accepted journal appends for this session file. */
	journalMutationGeneration: number;
	/** False when durable preimage bytes own rollback and header/entries are borrowed without copying. */
	journalCopied: boolean;
	titleUpdatedAt: string;
	hasTitleSlot: boolean;
	onDisk: boolean;
	needsRewrite: boolean;
	draftOnlySessionCleanupArmed: boolean;
	header: SessionHeader;
	entries: SessionEntry[];
	leafId: string | null;
	forceFileCreation: boolean;
	turnBudgetTotal: number | null;
	turnBudgetHard: boolean;
	turnOutputBaseline: number;
	turnEvalOutput: number;
	artifactManager: ArtifactManager | null;
	artifactManagerSessionFile: string | null;
	adoptedArtifactManager: ArtifactManager | null;
	inMemoryArtifacts: Map<string, string> | null;
	inMemoryArtifactCounter: number;
	breadcrumbFresh: boolean;
}

/** Exact durable bytes captured for a fallible in-place session mutation. */
export interface PersistedSessionFileSnapshot {
	sessionFile: string;
	/** Undefined records a path which did not exist at snapshot time. */
	content: string | undefined;
	/** Monotonic generation paired with {@link content}. */
	mutationGeneration: number;
}

/** A source-session artifact snapshot published before its replacement journal becomes visible. */
export interface SessionArtifactCloneTransaction {
	publish(destinationSessionFile: string): Promise<void>;
	commit(): Promise<void>;
	rollback(): Promise<void>;
}

interface DiskQueueOptions {
	ignorePriorError?: boolean;
	ignoreEpoch?: boolean;
	epoch?: number;
}

interface AtomicEntryBatch {
	collecting: boolean;
	entryIds: Set<string>;
	deferredNotifications: SessionEntry[];
	preBatchLeafId: string | null;
	externalLeafChanged: boolean;
	externalLeafId: string | null;
}

/**
 * The storage may have published a write that rejected, and an authoritative
 * repair could not be proven durable. Callers must fail closed until recovery.
 */
export class SessionPersistenceIndeterminateError extends AggregateError {
	readonly operationError: Error;
	readonly recoveryErrors: readonly Error[];

	constructor(operationError: Error, recoveryErrors: readonly Error[]) {
		super(
			[operationError, ...recoveryErrors],
			`Session persistence is indeterminate after "${operationError.message}" and authoritative repair failed.`,
		);
		this.name = "SessionPersistenceIndeterminateError";
		this.operationError = operationError;
		this.recoveryErrors = [...recoveryErrors];
	}
}

/**
 * Stores and navigates an append-only conversation journal.
 *
 * A session is a JSONL file: one header line followed by entries. Entries form a
 * tree by `(id, parentId)`, and the mutable leaf pointer selects which path is
 * active for future appends and for LLM context construction.
 *
 * Durability is software-crash safe but not power-loss safe: completed entries
 * (user/assistant/toolResult messages, tool_execution_start markers, custom
 * entries) are handed to the OS synchronously in-body on append and never
 * `fsync`'d. In-flight streaming text is intentionally not durable until
 * `message_end` persists the finished message.
 *
 * While an in-place atomic rewrite is publishing, a concurrent completed append
 * supersedes that publish with a synchronous full-body rewrite so the entry is
 * software-crash durable before the append returns; the abandoned atomic's
 * `commitGuard` then refuses to clobber the fresher body.
 *
 * During {@link moveTo}, appends write a full body to the live relocation path
 * (source until rename, destination once the rename has landed) so a crash mid-
 * move still preserves completed entries without recreating a vacated source.
 * A trailing atomic rewrite still rewrites the header cwd after the path is
 * repointed.
 */
export class SessionManager {
	#cwd: string;
	/** Additional workspace directories beyond cwd (multi-root). Normalized absolute, deduped, excludes cwd. */
	#additionalDirectories: string[] = [];
	#sessionDir: string;
	readonly #persist: boolean;
	readonly #storage: SessionStorage;
	readonly #blobs: BlobStore;

	#sessionId = "";
	#sessionName: string | undefined;
	#titleSource: SessionTitleSource | undefined;
	#sessionFile: string | undefined;
	#header!: SessionHeader;
	#titleUpdatedAt = "";
	#hasTitleSlot = true;
	#entries: SessionEntry[] = [];
	#index = new SessionEntryIndex();

	/** File reflects all current entries; appends can go incrementally. */
	#fileIsCurrent = false;
	/** In-memory entries diverged from disk (load-migration/sanitize) → next persist must full-rewrite. */
	#rewriteRequired = false;
	/** Lazy gate crossed (ensureOnDisk / loaded file): every entry must persist from now on. */
	#forceFileCreation = false;
	/**
	 * Armed only when this manager observed a draft sidecar lifecycle that
	 * materialized an otherwise metadata-only session file. Explicit
	 * ensureOnDisk() callers (ACP session/new, handoff) must survive close().
	 */
	#draftOnlySessionCleanupArmed = false;

	/**
	 * Collab replication tap: invoked for every appended entry with the
	 * in-memory (pre-blob-externalization) entry, so inline images survive.
	 */
	onEntryAppended?: (entry: SessionEntry) => void;
	readonly #entryAppendedSubscribers = new Set<(entry: SessionEntry) => void>();

	/** Subscribe without replacing another collaboration host's replication tap. */
	subscribeEntryAppended(callback: (entry: SessionEntry) => void): () => void {
		this.#entryAppendedSubscribers.add(callback);
		return () => this.#entryAppendedSubscribers.delete(callback);
	}

	#turnBudgetTotal: number | null = null;
	#turnBudgetHard = false;
	#turnOutputBaseline = 0;
	#turnEvalOutput = 0;

	/** The single open append writer; the manager only ever writes one file at a time. */
	#writer: SessionStorageWriter | undefined;
	/** Sealed by {@link releaseRetainedEntries}: every later append/title/rewrite is a dropped no-op. */
	#released = false;
	/** Serializes async disk work (flush/close/atomic rewrite). Appends are synchronous and bypass it. */
	#diskTail: Promise<void> = Promise.resolve();
	#diskFailure: Error | undefined;
	#diskFailureLogged = false;
	/** FIFO reservation for atomic batches and authoritative recovery. */
	#atomicPersistenceTail: Promise<void> = Promise.resolve();
	/** Observer notifications withheld until their entries are proven durable. */
	#pendingDurabilityNotifications: SessionEntry[] = [];
	/** Bumped on every sync rewrite / chain reset so stale queued tasks become no-ops. */
	#diskEpoch = 0;
	/** Per-file generation advanced by every accepted journal append. */
	#journalMutationGenerationByFile = new Map<string, number>();
	/** Latest durable snapshot generation; later appends must materialize even a lazy journal. */
	#persistedSnapshotGenerationByFile = new Map<string, number>();
	/**
	 * Epoch of the in-flight atomic rewrite, or `null` when no rewrite is running.
	 * The fence in {@link #appendToSessionFile} only applies while this matches
	 * `#diskEpoch`: once a synchronous rewrite (`flushSync` → `#rewriteSynchronously`)
	 * bumps the epoch, the pending atomic publish is guaranteed to abandon via
	 * its `commitGuard`, and appends can safely take the hot path against the
	 * freshly-published file.
	 */
	#atomicRewriteFenceEpoch: number | null = null;
	/** Set by synchronous appends that land while an atomic replacement is active. */
	#atomicRewriteDirty = false;
	/**
	 * Active {@link moveTo} relocation. Concurrent completed appends write a
	 * full body to the live path: source while a filesystem rename is pending,
	 * or destination immediately for queued external-store transactions. Never
	 * recreates a vacated source. `null` outside an active relocation.
	 */
	#sessionFileRelocating: { source: string; dest: string; preferDestination: boolean } | null = null;
	/** Atomic entry batch currently staged for a full-file commit. */
	#atomicEntryBatch: AtomicEntryBatch | undefined;

	#artifactManager: ArtifactManager | null = null;
	#artifactManagerSessionFile: string | null = null;
	#adoptedArtifactManager: ArtifactManager | null = null;
	#activeArtifactTransaction: ArtifactManagerTransaction | null = null;
	#inMemoryArtifacts: Map<string, string> | null = null;
	#inMemoryArtifactCounter = 0;

	#suppressBreadcrumb = false;
	/**
	 * The last breadcrumb this manager wrote marked a lazy `/new` boundary whose
	 * JSONL is not yet on disk. Cleared (and the crumb re-stamped non-fresh) once
	 * the session materializes, so a materialized-then-deleted session still falls
	 * back to the most-recent session instead of being treated as a fresh crumb.
	 */
	#breadcrumbFresh = false;
	#sessionNameChangedCallbacks = new Set<() => void>();
	#persistenceErrorCallbacks = new Set<(error: Error) => void>();

	private constructor(cwd: string, sessionDir: string, persist: boolean, storage: SessionStorage) {
		this.#cwd = cwd;
		this.#sessionDir = sessionDir;
		this.#persist = persist;
		this.#storage = storage;
		this.#blobs = new BlobStore(getBlobsDir());

		if (persist && sessionDir) {
			this.#storage.ensureDirSync(sessionDir);
			if (storage instanceof FileSessionStorage) {
				const managedRoot = resolveManagedSessionRoot(sessionDir, cwd);
				const reconciliationRoot = path.resolve(managedRoot ?? sessionDir);
				if (!reconciledArtifactRoots.has(reconciliationRoot)) {
					if (managedRoot) storage.reconcileArtifactOperationsUnderRootSync(reconciliationRoot);
					else storage.reconcileArtifactOperationsSync(reconciliationRoot);
					reconciledArtifactRoots.add(reconciliationRoot);
				}
			}
		}
	}

	#rememberBreadcrumb(cwd: string, sessionFile: string, fresh = false): void {
		this.#breadcrumbFresh = fresh;
		if (!this.#suppressBreadcrumb) writeTerminalBreadcrumb(cwd, sessionFile, fresh);
	}

	/**
	 * Re-stamp a fresh `/new` breadcrumb as non-fresh once the session has
	 * materialized on disk. A no-op unless the current breadcrumb is still fresh.
	 */
	#materializeBreadcrumb(): void {
		if (!this.#breadcrumbFresh || !this.#sessionFile) return;
		this.#rememberBreadcrumb(this.#cwd, this.#sessionFile, false);
	}

	#clearDiskError(): void {
		this.#diskFailure = undefined;
		this.#diskFailureLogged = false;
	}

	#noteDiskFailure(errorLike: unknown): Error {
		const error = toError(errorLike);
		if (!this.#diskFailure) this.#diskFailure = error;

		if (!this.#diskFailureLogged) {
			this.#diskFailureLogged = true;
			logger.error("Session persistence error.", {
				sessionFile: this.#sessionFile,
				error: error.message,
				stack: error.stack,
			});
			for (const callback of this.#persistenceErrorCallbacks) {
				try {
					callback(error);
				} catch (callbackError) {
					logger.warn("Session persistence error observer failed", {
						error: toError(callbackError).message,
					});
				}
			}
		}

		return this.#diskFailure;
	}

	#scheduleDiskWork(work: () => Promise<void>, options: DiskQueueOptions = {}): Promise<void> {
		const epoch = options.epoch ?? this.#diskEpoch;
		const scheduled = this.#diskTail
			.catch(() => undefined)
			.then(async () => {
				if (!options.ignoreEpoch && epoch !== this.#diskEpoch) return;
				if (this.#diskFailure && !options.ignorePriorError) throw this.#diskFailure;
				await work();
			});

		const reported = scheduled.catch(err => {
			throw this.#noteDiskFailure(err);
		});
		this.#diskTail = reported.catch(() => undefined);
		return reported;
	}

	async #withAtomicPersistenceLock<T>(operation: () => Promise<T>): Promise<T> {
		const predecessor = this.#atomicPersistenceTail;
		const turn = Promise.withResolvers<void>();
		this.#atomicPersistenceTail = predecessor.catch(() => undefined).then(() => turn.promise);
		await predecessor.catch(() => undefined);
		try {
			return await operation();
		} finally {
			turn.resolve();
		}
	}

	async #drainAndCloseWriter(): Promise<void> {
		try {
			await this.#scheduleDiskWork(
				async () => {
					await this.#closeWriterHandle();
				},
				{ ignorePriorError: true, ignoreEpoch: true },
			);
		} finally {
			this.#writer = undefined;
			this.#diskTail = Promise.resolve();
		}
	}

	#closeWriterEventually(): void {
		const writer = this.#writer;
		this.#writer = undefined;
		if (writer) void writer.close().catch(() => undefined);
	}

	async #closeWriterHandle(): Promise<void> {
		const writer = this.#writer;
		if (!writer) return;
		this.#writer = undefined;
		await writer.close();
	}

	#latchIndeterminate(operationError: Error, recoveryErrors: readonly Error[]): SessionPersistenceIndeterminateError {
		const error = new SessionPersistenceIndeterminateError(operationError, recoveryErrors);
		this.#diskFailure = error;
		if (!this.#diskFailureLogged) {
			this.#diskFailureLogged = true;
			logger.error("Session persistence became indeterminate.", {
				sessionFile: this.#sessionFile,
				error: error.message,
			});
		}
		return error;
	}

	#notifyDurableEntries(entries: readonly SessionEntry[] = []): void {
		const notifications = [...this.#pendingDurabilityNotifications, ...entries];
		this.#pendingDurabilityNotifications = [];
		const seen = new Set<string>();
		for (const entry of notifications) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			this.#notifyEntryAppended(entry);
		}
	}

	async #authoritativelyRewriteCurrentStateLocked(operationError: Error): Promise<void> {
		if (this.#released) {
			// Terminal seal: repair would reset the disk tail (escaping the
			// close() serialization) and atomically publish #fileBody() — after
			// release that truncates, and a revival may already own the file.
			// The original operation error still propagates to the caller.
			logger.warn("Skipped authoritative session repair after terminal release", {
				error: String(operationError),
			});
			return;
		}
		if (!this.#persist || !this.#sessionFile) return;
		const previousDiskTail = this.#diskTail;
		const writer = this.#writer;
		this.#diskEpoch++;
		const epoch = this.#diskEpoch;
		this.#writer = undefined;
		this.#diskTail = Promise.resolve();
		this.#forceFileCreation = true;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		this.#atomicRewriteFenceEpoch = epoch;
		if (!this.#diskFailure) this.#diskFailure = operationError;
		try {
			await previousDiskTail.catch(() => undefined);
			let closeError: Error | undefined;
			if (writer) {
				try {
					await writer.close();
				} catch (error) {
					closeError = toError(error);
				}
			}
			let drainError: Error | undefined;
			try {
				await this.#storage.drain();
			} catch (error) {
				drainError = toError(error);
			}
			if (writer?.isOpen()) {
				throw this.#latchIndeterminate(operationError, [
					closeError ?? new Error("Failed to close session writer before authoritative repair."),
					...(drainError ? [drainError] : []),
				]);
			}

			do {
				this.#atomicRewriteDirty = false;
				const sessionFile = this.#sessionFile;
				if (!sessionFile) {
					throw this.#latchIndeterminate(operationError, [
						new Error("Session file disappeared during authoritative repair."),
					]);
				}
				const body = this.#fileBody();
				try {
					await this.#storage.writeTextAtomic(sessionFile, body, {
						commitGuard: () => !this.#released && this.#diskEpoch === epoch,
					});
				} catch (error) {
					const recoveryErrors = [toError(error)];
					try {
						await this.#storage.drain();
					} catch (drainFailure) {
						recoveryErrors.push(toError(drainFailure));
					}
					let actual: string;
					try {
						actual = await this.#storage.readText(sessionFile);
					} catch (readFailure) {
						recoveryErrors.push(toError(readFailure));
						throw this.#latchIndeterminate(operationError, recoveryErrors);
					}
					if (actual !== body) {
						recoveryErrors.push(new Error("Authoritative session repair did not match durable storage."));
						throw this.#latchIndeterminate(operationError, recoveryErrors);
					}
				}
				if (this.#diskEpoch !== epoch) {
					throw this.#latchIndeterminate(operationError, [
						new Error("Authoritative session repair was superseded before verification."),
					]);
				}
			} while (this.#atomicRewriteDirty);

			this.#fileIsCurrent = true;
			this.#rewriteRequired = false;
			this.#hasTitleSlot = true;
			this.#clearDiskError();
		} catch (error) {
			if (error instanceof SessionPersistenceIndeterminateError) throw error;
			throw this.#latchIndeterminate(operationError, [toError(error)]);
		} finally {
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
		}
	}

	#appendWriter(): SessionStorageWriter {
		if (!this.#sessionFile) throw new Error("Cannot open a session writer before a session file exists");

		if (this.#writer?.isOpen()) return this.#writer;

		this.#writer = this.#storage.openWriter(this.#sessionFile, {
			flags: "a",
			onError: err => this.#noteDiskFailure(err),
		});
		return this.#writer;
	}

	#lineFor(entry: FileEntry): string {
		return `${stringifyJson(prepareEntryForPersistence(entry, this.#blobs)) ?? "null"}\n`;
	}

	#titleSlotLine(): string {
		return serializeTitleSlot({
			title: this.#sessionName,
			source: this.#titleSource,
			updatedAt: this.#titleUpdatedAt || this.#header.timestamp,
		});
	}

	#leafRecord(): SessionLeafEntry | undefined {
		const fallbackLeafId = this.#entries.at(-1)?.id ?? null;
		const leafId = this.#index.leafId();
		return leafId === fallbackLeafId ? undefined : { type: SESSION_LEAF_ENTRY_TYPE, leafId };
	}

	#fileBody(): string {
		let body = this.#titleSlotLine();
		body += this.#lineFor(this.#header);
		for (const entry of this.#entries) body += this.#lineFor(entry);
		const leafRecord = this.#leafRecord();
		if (leafRecord) body += this.#lineFor(leafRecord);
		return body;
	}

	#historyContainsAssistantMessage(): boolean {
		return this.#entries.some(isAssistantEntry);
	}

	#shouldHaveSessionFile(): boolean {
		return this.#forceFileCreation || this.#fileIsCurrent || this.#historyContainsAssistantMessage();
	}

	/** Live path for concurrent completed appends during {@link moveTo}. */
	#liveRelocationWritePath(): string | null {
		const relocating = this.#sessionFileRelocating;
		if (!relocating) return null;
		if (relocating.preferDestination) return relocating.dest;
		if (this.#storage.existsSync(relocating.dest)) return relocating.dest;
		if (this.#storage.existsSync(relocating.source)) return relocating.source;
		// Rename in flight with neither path visible (rare cross-device edge):
		// fall back to destination so we do not recreate a vacated source.
		return relocating.dest;
	}

	/**
	 * Synchronously rewrite the whole file (header + entries) and keep no open
	 * writer; the next append re-opens one. `writeTextSync` returns with the
	 * bytes in the kernel page cache, so the file is software-crash durable.
	 *
	 * During {@link moveTo}, writes to the live relocation path (source pre-
	 * rename, destination post-rename) rather than always `#sessionFile`, so
	 * concurrent completed entries are durable without recreating a vacated source.
	 */
	#rewriteSynchronously(): void {
		if (this.#released) return;
		if (!this.#persist || !this.#shouldHaveSessionFile()) return;
		const targetPath = this.#liveRelocationWritePath() ?? this.#sessionFile;
		if (!targetPath) return;

		try {
			const body = this.#fileBody();
			this.#diskEpoch++;
			this.#diskTail = Promise.resolve();
			this.#closeWriterEventually();
			this.#storage.writeTextSync(targetPath, body);
			this.#clearDiskError();
			// Only mark the manager current when writing the active session path.
			// Mid-move writes update the live relocation path; `#sessionFile` is
			// still the pre-repoint source until moveTo repoints it.
			if (!this.#sessionFileRelocating || targetPath === this.#sessionFile) {
				this.#fileIsCurrent = true;
				this.#materializeBreadcrumb();
				this.#rewriteRequired = false;
				this.#hasTitleSlot = true;
			} else {
				// Destination body is current on disk; in-memory still needs a
				// header-cwd rewrite after repoint, but entries are durable.
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				this.#hasTitleSlot = true;
			}
		} catch (err) {
			this.#noteDiskFailure(err);
		}
	}

	/**
	 * Rewrite the whole file atomically (temp-write + rename, EPERM-safe) on the
	 * disk chain. The body is serialized after the writer is closed. The fence
	 * is enabled BEFORE `#closeWriterHandle()` and stays active until the last
	 * atomic publish returns, so a sync append landing in the close-yield window
	 * cannot open a fresh writer that the pending replacement would then detach
	 * from the current JSONL path. A `commitGuard` also prevents a superseding
	 * synchronous rewrite from being overwritten by the stale body serialized
	 * before it ran.
	 */
	async #rewriteAtomically(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#released) return;

		const startEpoch = this.#diskEpoch;
		await this.#scheduleDiskWork(
			async () => {
				if (await this.#runFencedAtomicRewrite(startEpoch)) {
					this.#fileIsCurrent = true;
					this.#materializeBreadcrumb();
					this.#rewriteRequired = false;
					this.#hasTitleSlot = true;
				}
			},
			{ epoch: startEpoch },
		);
	}

	/**
	 * Shared fenced atomic-rewrite loop used by `#rewriteAtomically` and the
	 * `#persistTitleChangeEntry` fallback. Holds `#atomicRewriteActive` across
	 * the writer close and the full-file replace, and loops on
	 * `#atomicRewriteDirty` so any fenced append that lands during the rewrite
	 * is captured before the task resolves. Returns `false` when the disk epoch
	 * moved (a superseding synchronous rewrite has taken over) so callers skip
	 * their post-publish state updates.
	 */
	async #runFencedAtomicRewrite(epoch: number): Promise<boolean> {
		if (this.#released) return false;
		this.#atomicRewriteFenceEpoch = epoch;
		try {
			do {
				this.#atomicRewriteDirty = false;
				await this.#closeWriterHandle();
				const sessionFile = this.#sessionFile;
				if (!sessionFile) return false;
				if (this.#diskEpoch !== epoch) return false;
				await this.#storage.writeTextAtomic(sessionFile, this.#fileBody(), {
					commitGuard: () => !this.#released && this.#diskEpoch === epoch && !this.#atomicRewriteDirty,
				});
				if (this.#diskEpoch !== epoch) return false;
			} while (this.#atomicRewriteDirty);
			return true;
		} finally {
			// Only relinquish the fence if we still own it. A superseding
			// synchronous rewrite (`flushSync` → `#rewriteSynchronously`) may
			// have reset `#diskTail`, scheduled a fresh atomic task at the new
			// epoch, and that task may have taken ownership of the fence while
			// this stale rewrite was still awaiting storage. Clearing it here
			// unconditionally would strand appends during the newer publish.
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
		}
	}

	#appendToSessionFile(entry: FileEntry): void {
		if (this.#released) return;
		this.#advanceJournalMutation();
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#atomicEntryBatch) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#atomicRewriteDirty = true;
			return;
		}
		if (this.#diskFailure) {
			// The failed entry and any later entries remain in memory. A full
			// replacement is the writability probe and restores all of them once
			// transient storage pressure clears.
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
		}

		// Lazy gate: a brand-new session is not written until it has an assistant
		// message (or someone forced creation), so sessions that never produce
		// output never create a file.
		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}

		// Atomic replacement / move window: do not open a fresh append writer that
		// a Windows EPERM replace could detach from the current JSONL path.
		// - moveTo: write a full body to the live relocation path (source pre-
		//   rename, destination post-rename) so completed entries are durable
		//   without recreating a vacated source.
		// - in-place atomic fence: supersede the pending publish with a
		//   synchronous full-body rewrite; bumping `#diskEpoch` abandons the
		//   in-flight atomic via its `commitGuard`.
		if (this.#sessionFileRelocating) {
			this.#rewriteSynchronously();
			return;
		}
		if (this.#atomicRewriteFenceEpoch !== null && this.#atomicRewriteFenceEpoch === this.#diskEpoch) {
			this.#atomicRewriteDirty = true;
			this.#rewriteSynchronously();
			return;
		}
		// Cold/divergent: not on disk yet, or in-memory entries diverged from the
		// file → rewrite the whole file synchronously and keep going.
		if (!this.#fileIsCurrent || this.#rewriteRequired) {
			this.#rewriteSynchronously();
			return;
		}

		// Hot path: write the entry directly on the writer, outside the async disk
		// chain. Prefer appendSync so write failures latch `#diskFailure` before
		// this call returns (not via a discarded rejected Promise after a later
		// microtask). Callers stay non-throwing here — the core turn loop invokes
		// appendMessage/appendCustomEntry without try/catch. A later entry retries
		// all in-memory state through a full rewrite. File writers apply each line
		// to the OS page cache before return.
		// A mid-close writer leaves `#writer` undefined, so `#appendWriter` simply
		// opens a fresh append handle and the entry still lands.
		try {
			const writer = this.#appendWriter();
			const line = this.#lineFor(entry);
			if (writer.appendSync) {
				writer.appendSync(line);
			} else {
				void writer.append(line).catch(err => {
					this.#fileIsCurrent = false;
					this.#rewriteRequired = true;
					this.#noteDiskFailure(err);
				});
			}
		} catch (err) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#noteDiskFailure(err);
		}
	}

	async #persistTitleChangeEntry(entry: TitleChangeEntry, update: SessionTitleUpdate): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#diskFailure) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#rewriteSynchronously();
			if (this.#diskFailure) throw this.#diskFailure;
			return;
		}

		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}

		// Title changes use their own asynchronous append path rather than
		// #appendToSessionFile. During move, write the full body (including the
		// title entry) to the live relocation path so a crash mid-move still
		// keeps the title change; the trailing rewrite still updates header cwd.
		if (this.#sessionFileRelocating) {
			this.#rewriteSynchronously();
			return;
		}

		if (
			!this.#fileIsCurrent ||
			this.#rewriteRequired ||
			!this.#hasTitleSlot ||
			!this.#storage.existsSync(this.#sessionFile)
		) {
			await this.#rewriteAtomically();
			return;
		}

		const epoch = this.#diskEpoch;
		const line = this.#lineFor(entry);
		await this.#scheduleDiskWork(
			async () => {
				if (this.#released) return;
				const sessionFile = this.#sessionFile;
				if (!sessionFile) return;
				try {
					await this.#appendWriter().append(line);
					await this.#storage.updateSessionTitle(sessionFile, update);
					if (this.#diskEpoch === epoch) this.#fileIsCurrent = true;
				} catch {
					if (!(await this.#runFencedAtomicRewrite(epoch))) return;
					this.#clearDiskError();
					this.#fileIsCurrent = true;
					this.#rewriteRequired = false;
					this.#hasTitleSlot = true;
				}
			},
			{ epoch },
		);
	}

	#notifyEntryAppended(entry: SessionEntry): void {
		const notify = (callback: ((entry: SessionEntry) => void) | undefined): void => {
			if (!callback) return;
			try {
				callback(entry);
			} catch (err) {
				logger.warn("session entry hook failed", { error: String(err) });
			}
		};
		notify(this.onEntryAppended);
		for (const callback of this.#entryAppendedSubscribers) notify(callback);
	}

	#resetToNewSession(options?: NewSessionOptions, forcedSessionFile?: string): string | undefined {
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();
		this.#sessionId = mintSessionId();
		this.#sessionName = undefined;
		this.#titleSource = undefined;
		this.#titleUpdatedAt = "";
		this.#hasTitleSlot = true;

		const timestamp = nowIso();
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			timestamp,
			cwd: this.#cwd,
			parentSession: options?.parentSession,
			providerPromptCacheKey: options?.providerPromptCacheKey,
		};
		const workspace = normalizeSessionWorkspace({
			cwd: this.#cwd,
			directories: options?.additionalDirectories ?? [],
		});
		this.#additionalDirectories = additionalWorkspaceDirectories(workspace);
		if (this.#additionalDirectories.length > 0) {
			this.#header.additionalDirectories = [...this.#additionalDirectories];
		}
		this.#titleUpdatedAt = timestamp;

		this.#entries = [];
		this.#index.clear();
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#forceFileCreation = false;
		this.#draftOnlySessionCleanupArmed = false;
		this.#turnBudgetTotal = null;
		this.#turnBudgetHard = false;
		this.#turnOutputBaseline = 0;
		this.#turnEvalOutput = 0;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;
		this.#inMemoryArtifacts = null;
		this.#inMemoryArtifactCounter = 0;

		if (this.#persist) {
			this.#sessionFile =
				forcedSessionFile ??
				path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`);
			this.#rememberBreadcrumb(this.#cwd, this.#sessionFile, true);
		} else {
			this.#sessionFile = undefined;
		}

		return this.#sessionFile;
	}

	#applyEntries(header: SessionHeader, entries: SessionEntry[], leafId?: string | null): void {
		this.#header = header;
		this.#entries = entries;
		this.#sessionId = header.id;
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#titleUpdatedAt = header.timestamp;
		this.#index.rebuild(entries, leafId);
	}

	#journalMutationGeneration(sessionFile: string | undefined = this.#sessionFile): number {
		return sessionFile ? (this.#journalMutationGenerationByFile.get(path.resolve(sessionFile)) ?? 0) : 0;
	}

	#advanceJournalMutation(): void {
		if (!this.#persist || !this.#sessionFile) return;
		const sessionFile = path.resolve(this.#sessionFile);
		const nextGeneration = (this.#journalMutationGenerationByFile.get(sessionFile) ?? 0) + 1;
		this.#journalMutationGenerationByFile.set(sessionFile, nextGeneration);
		const snapshotGeneration = this.#persistedSnapshotGenerationByFile.get(sessionFile);
		if (snapshotGeneration !== undefined && nextGeneration > snapshotGeneration) this.#forceFileCreation = true;
	}

	async #reloadCurrentPersistedJournal(): Promise<boolean> {
		const sessionFile = this.#sessionFile;
		if (!sessionFile || !this.#storage.existsSync(sessionFile)) return false;
		const titleSlot = await readTitleSlotFromFile(sessionFile, this.#storage);
		const fileEntries = await loadEntriesFromFile(sessionFile, this.#storage);
		if (fileEntries.length === 0) return false;
		const migrated = migrateToCurrentVersion(fileEntries);
		await resolveBlobRefsInEntries(fileEntries, this.#blobs);
		const header = fileEntries[0] as SessionHeader;
		const journal = restoreSessionJournal(fileEntries);
		this.#applyEntries(header, journal.entries, journal.leafId);
		this.#additionalDirectories = header.additionalDirectories ?? [];
		this.#titleUpdatedAt = titleSlot?.updatedAt ?? header.timestamp;
		this.#hasTitleSlot = titleSlot !== undefined;
		this.#fileIsCurrent = true;
		this.#rewriteRequired = migrated;
		this.#forceFileCreation = true;
		this.sanitizeLoadedOpenAIResponsesReplayMetadata();
		return true;
	}

	#freshEntryFields(): { id: string; parentId: string | null; timestamp: string } {
		return {
			id: generateId(this.#index),
			parentId: this.#index.leafId(),
			timestamp: nowIso(),
		};
	}

	#setLeaf(id: string | null): void {
		this.#index.setLeaf(id);
		const batch = this.#atomicEntryBatch;
		if (batch && !batch.collecting) {
			batch.externalLeafChanged = true;
			batch.externalLeafId = id;
		}
	}

	#recordEntry(entry: SessionEntry): void {
		if (this.#released) {
			logger.warn("Dropped session entry appended after terminal release", { type: entry.type });
			return;
		}
		this.#entries.push(entry);
		this.#index.insert(entry);
		const batch = this.#atomicEntryBatch;
		if (batch?.collecting) batch.entryIds.add(entry.id);
		if (batch && !batch.collecting) {
			batch.externalLeafChanged = true;
			batch.externalLeafId = entry.id;
		}
		this.#appendToSessionFile(entry);
		if (batch) batch.deferredNotifications.push(entry);
		else this.#notifyEntryAppended(entry);
	}

	#rollbackAtomicEntryBatch(batch: AtomicEntryBatch): void {
		const retainedAncestor = (id: string | null): string | null => {
			const seen = new Set<string>();
			while (id && batch.entryIds.has(id) && !seen.has(id)) {
				seen.add(id);
				id = this.#index.get(id)?.parentId ?? null;
			}
			return id;
		};
		const retained = this.#entries.filter(entry => !batch.entryIds.has(entry.id));
		for (const entry of retained) entry.parentId = retainedAncestor(entry.parentId);
		const restoredLeaf = retainedAncestor(batch.externalLeafChanged ? batch.externalLeafId : batch.preBatchLeafId);
		this.#entries = retained;
		this.#index.rebuild(retained);
		this.#index.setLeaf(restoredLeaf && this.#index.has(restoredLeaf) ? restoredLeaf : null);
	}

	#draftPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, "draft.txt") : null;
	}

	#draftOnlySessionMarkerPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, DRAFT_ONLY_SESSION_MARKER) : null;
	}

	#hasDraftOnlySessionMarker(): boolean {
		const markerPath = this.#draftOnlySessionMarkerPath();
		return markerPath !== null && this.#storage.existsSync(markerPath);
	}

	async #writeDraftOnlySessionMarker(): Promise<void> {
		const markerPath = this.#draftOnlySessionMarkerPath();
		if (!markerPath) return;
		await this.#storage.writeText(markerPath, "");
	}

	async #clearDraftOnlySessionMarker(): Promise<void> {
		const markerPath = this.#draftOnlySessionMarkerPath();
		if (!markerPath) return;
		try {
			await this.#storage.unlink(markerPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	#artifactManagerForSession(): ArtifactManager | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager;

		const sessionFile = this.#sessionFile;
		if (!sessionFile) {
			this.#artifactManager = null;
			this.#artifactManagerSessionFile = null;
			return null;
		}

		if (this.#artifactManager && this.#artifactManagerSessionFile === sessionFile) return this.#artifactManager;

		this.#artifactManager = new ArtifactManager(sessionFile.slice(0, -JSONL_SUFFIX_LENGTH));
		this.#artifactManagerSessionFile = sessionFile;
		return this.#artifactManager;
	}

	#notifySessionNameListeners(): void {
		for (const callback of [...this.#sessionNameChangedCallbacks]) {
			try {
				callback();
			} catch (err) {
				logger.warn("SessionManager: session name change hook failed", { error: String(err) });
			}
		}
	}

	static #cleanTitle(raw: string): string {
		return raw
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/ +/g, " ")
			.trim();
	}

	/** Puts a binary blob into the blob store and returns the blob reference. */
	async putBlob(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		return this.#blobs.put(data, options);
	}

	/** Synchronous variant of {@link putBlob} for rebuild-only render paths. */
	putBlobSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		return this.#blobs.putSync(data, options);
	}

	captureState(options: { copyJournal?: boolean } = {}): SessionManagerStateSnapshot {
		return {
			cwd: this.#cwd,
			sessionDir: this.#sessionDir,
			sessionId: this.#sessionId,
			sessionName: this.#sessionName,
			titleSource: this.#titleSource,
			titleUpdatedAt: this.#titleUpdatedAt,
			hasTitleSlot: this.#hasTitleSlot,
			sessionFile: this.#sessionFile,
			journalMutationGeneration: this.#journalMutationGeneration(),
			journalCopied: options.copyJournal !== false,
			onDisk: this.#fileIsCurrent,
			needsRewrite: this.#rewriteRequired,
			draftOnlySessionCleanupArmed: this.#draftOnlySessionCleanupArmed,
			// Durable lifecycle checkpoints already own exact JSONL bytes. They may
			// borrow the live journal to avoid a second transcript-sized success-path copy;
			// rollback reloads the durable preimage before publishing retained state.
			header: options.copyJournal === false ? this.#header : cloneDurableSessionJson(this.#header),
			entries: options.copyJournal === false ? this.#entries : cloneDurableSessionJson(this.#entries),
			leafId: this.#index.leafId(),
			forceFileCreation: this.#forceFileCreation,
			turnBudgetTotal: this.#turnBudgetTotal,
			turnBudgetHard: this.#turnBudgetHard,
			turnOutputBaseline: this.#turnOutputBaseline,
			turnEvalOutput: this.#turnEvalOutput,
			// Manager identity is intentionally retained for adopted/shared managers;
			// beginArtifactTransaction() snapshots and restores their mutable state in place.
			artifactManager: this.#artifactManager,
			artifactManagerSessionFile: this.#artifactManagerSessionFile,
			adoptedArtifactManager: this.#adoptedArtifactManager,
			inMemoryArtifacts: this.#inMemoryArtifacts ? new Map(this.#inMemoryArtifacts) : null,
			inMemoryArtifactCounter: this.#inMemoryArtifactCounter,
			breadcrumbFresh: this.#breadcrumbFresh,
		};
	}

	/** Capture exact JSONL state, including a configured path that has not yet been materialized. */
	async capturePersistedSessionFile(): Promise<PersistedSessionFileSnapshot | undefined> {
		const sessionFile = this.#sessionFile;
		if (!this.#persist || !sessionFile) return undefined;
		await this.flush();
		for (;;) {
			const mutationGeneration = this.#journalMutationGeneration(sessionFile);
			const content = this.#storage.existsSync(sessionFile) ? await this.#storage.readText(sessionFile) : undefined;
			if (this.#journalMutationGeneration(sessionFile) === mutationGeneration) {
				this.#persistedSnapshotGenerationByFile.set(path.resolve(sessionFile), mutationGeneration);
				return { sessionFile, content, mutationGeneration };
			}
			await this.flush();
		}
	}

	/**
	 * Capture a target transcript before a fallible switch adopts it. This must not
	 * flush or otherwise touch the currently active session.
	 */
	async capturePersistedSessionFileAt(sessionFile: string): Promise<PersistedSessionFileSnapshot | undefined> {
		if (!this.#persist) return undefined;
		const resolvedSessionFile = path.resolve(sessionFile);
		for (;;) {
			const mutationGeneration = this.#journalMutationGeneration(resolvedSessionFile);
			const content = this.#storage.existsSync(resolvedSessionFile)
				? await this.#storage.readText(resolvedSessionFile)
				: undefined;
			if (this.#journalMutationGeneration(resolvedSessionFile) === mutationGeneration) {
				this.#persistedSnapshotGenerationByFile.set(resolvedSessionFile, mutationGeneration);
				return { sessionFile: resolvedSessionFile, content, mutationGeneration };
			}
		}
	}

	/** Restore a durable JSONL preimage, optionally retaining newer accepted appends. */
	async restorePersistedSessionFile(
		snapshot: PersistedSessionFileSnapshot | undefined,
		options: { preserveNewerMutations?: boolean; reloadJournal?: boolean } = {},
	): Promise<boolean> {
		if (!this.#persist || !snapshot || this.#sessionFile !== snapshot.sessionFile) return false;
		if (
			options.preserveNewerMutations === true &&
			this.#journalMutationGeneration(snapshot.sessionFile) > snapshot.mutationGeneration
		) {
			if (!(await this.#reloadCurrentPersistedJournal())) {
				throw new Error("Newer session journal mutations could not be reloaded from durable storage");
			}
			return true;
		}
		const epoch = this.#diskEpoch;
		let restored = false;
		this.#atomicRewriteFenceEpoch = epoch;
		try {
			await this.#scheduleDiskWork(
				async () => {
					await this.#closeWriterHandle();
					if (this.#sessionFile !== snapshot.sessionFile) return;
					if (this.#diskEpoch !== epoch) {
						if (this.#diskFailure) throw this.#diskFailure;
						restored = true;
						return;
					}

					if (snapshot.content === undefined) {
						try {
							await this.#storage.unlink(snapshot.sessionFile);
						} catch (error) {
							if (!isEnoent(error)) throw error;
						}
						if (this.#diskEpoch !== epoch) {
							this.#rewriteSynchronously();
							if (this.#diskFailure) throw this.#diskFailure;
							restored = true;
							return;
						}
					} else {
						await this.#storage.writeTextAtomic(snapshot.sessionFile, snapshot.content, {
							commitGuard: () => this.#diskEpoch === epoch,
						});
						if (this.#diskEpoch !== epoch) {
							if (this.#diskFailure) throw this.#diskFailure;
							restored = true;
							return;
						}
					}

					this.#fileIsCurrent = snapshot.content !== undefined;
					this.#rewriteRequired = false;
					this.#hasTitleSlot = snapshot.content !== undefined;
					restored = true;
				},
				{ ignoreEpoch: true },
			);
		} finally {
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
		}
		if (restored && options.reloadJournal && !(await this.#reloadCurrentPersistedJournal())) {
			throw new Error("Restored session journal preimage could not be reloaded");
		}
		return restored;
	}

	/**
	 * Create an independent manager for the current logical session and branch.
	 * The clone shares the storage backend but owns its entry index and writer, so
	 * callers can finish session-owned work after this manager switches elsewhere.
	 * Set `persist` false when the original session is intentionally being dropped.
	 */
	cloneCurrentSession(options?: { persist?: boolean }): SessionManager {
		const persist = options?.persist ?? this.#persist;
		const clone = new SessionManager(this.#cwd, this.#sessionDir, persist, this.#storage);
		clone.#suppressBreadcrumb = true;
		const snapshot = this.captureState();
		clone.#journalMutationGenerationByFile = new Map(this.#journalMutationGenerationByFile);
		clone.restoreState(snapshot);
		clone.#persistedSnapshotGenerationByFile = new Map(this.#persistedSnapshotGenerationByFile);
		// A clone owns fresh transient budget/artifact bookkeeping just as it did
		// before rollback snapshots covered those fields.
		clone.#forceFileCreation = snapshot.onDisk;
		clone.#turnBudgetTotal = null;
		clone.#turnBudgetHard = false;
		clone.#turnOutputBaseline = 0;
		clone.#turnEvalOutput = 0;
		clone.#artifactManager = null;
		clone.#artifactManagerSessionFile = null;
		clone.#adoptedArtifactManager = null;
		clone.#inMemoryArtifacts = null;
		clone.#inMemoryArtifactCounter = 0;
		clone.#breadcrumbFresh = false;
		if (!persist) {
			clone.#sessionFile = undefined;
			clone.#fileIsCurrent = false;
			clone.#rewriteRequired = false;
			clone.#forceFileCreation = false;
		}
		return clone;
	}

	restoreState(snapshot: SessionManagerStateSnapshot, options: { preserveCurrentJournal?: boolean } = {}): void {
		this.#closeWriterEventually();
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();
		// A snapshot may be restored more than once during rollback. Every restore
		// must own fresh objects so reconciler/title mutations cannot alias the
		// checkpoint and poison the authoritative second restore.
		const preserveCurrentJournal = options.preserveCurrentJournal === true;
		const header = cloneDurableSessionJson(preserveCurrentJournal ? this.#header : snapshot.header);
		const entries = cloneDurableSessionJson(preserveCurrentJournal ? this.#entries : snapshot.entries);
		const leafId = preserveCurrentJournal ? this.#index.leafId() : snapshot.leafId;
		const sessionName = preserveCurrentJournal ? this.#sessionName : snapshot.sessionName;
		const titleSource = preserveCurrentJournal ? this.#titleSource : snapshot.titleSource;
		const titleUpdatedAt = preserveCurrentJournal ? this.#titleUpdatedAt : snapshot.titleUpdatedAt;
		const hasTitleSlot = preserveCurrentJournal ? this.#hasTitleSlot : snapshot.hasTitleSlot;
		this.#cwd = snapshot.cwd;
		this.#sessionDir = snapshot.sessionDir;
		this.#sessionFile = snapshot.sessionFile;
		this.#fileIsCurrent = snapshot.onDisk;
		this.#rewriteRequired = snapshot.needsRewrite;
		this.#draftOnlySessionCleanupArmed = snapshot.draftOnlySessionCleanupArmed;
		this.#applyEntries(header, entries, leafId);
		this.#additionalDirectories = [...(header.additionalDirectories ?? [])];
		this.#sessionName = sessionName;
		this.#titleSource = titleSource;
		this.#titleUpdatedAt = titleUpdatedAt;
		this.#hasTitleSlot = hasTitleSlot;
		this.#forceFileCreation = snapshot.forceFileCreation;
		this.#turnBudgetTotal = snapshot.turnBudgetTotal;
		this.#turnBudgetHard = snapshot.turnBudgetHard;
		this.#turnOutputBaseline = snapshot.turnOutputBaseline;
		this.#turnEvalOutput = snapshot.turnEvalOutput;
		this.#artifactManager = snapshot.artifactManager;
		this.#artifactManagerSessionFile = snapshot.artifactManagerSessionFile;
		this.#adoptedArtifactManager = snapshot.adoptedArtifactManager;
		this.#inMemoryArtifacts = snapshot.inMemoryArtifacts ? new Map(snapshot.inMemoryArtifacts) : null;
		this.#inMemoryArtifactCounter = snapshot.inMemoryArtifactCounter;
		this.#breadcrumbFresh = snapshot.breadcrumbFresh;

		if (this.#sessionFile) this.#rememberBreadcrumb(this.#cwd, this.#sessionFile, snapshot.breadcrumbFresh);
		if (this.#sessionFile) {
			const sessionFile = path.resolve(this.#sessionFile);
			this.#journalMutationGenerationByFile.set(
				sessionFile,
				Math.max(this.#journalMutationGeneration(sessionFile), snapshot.journalMutationGeneration),
			);
		}
	}

	/** Switch to a different session file (resume / branch). */
	async setSessionFile(sessionFile: string): Promise<void> {
		await this.#setSessionFile(sessionFile);
	}

	async #setSessionFile(sessionFile: string, loadedSession?: SessionLoadResult): Promise<void> {
		await this.#drainAndCloseWriter();
		this.#clearDiskError();
		this.#draftOnlySessionCleanupArmed = false;

		const resolvedSessionFile = path.resolve(sessionFile);
		this.#sessionFile = resolvedSessionFile;
		this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);

		const loaded = loadedSession ?? (await loadSessionFile(resolvedSessionFile, this.#storage));
		const { entries: fileEntries, titleSlot } = loaded;
		if (fileEntries.length === 0) {
			// Explicit but empty/missing path (e.g. --session flag): start fresh but
			// keep the requested path and materialize the header immediately.
			this.#resetToNewSession(undefined, resolvedSessionFile);
			this.#forceFileCreation = true;
			await this.#rewriteAtomically();
			this.#fileIsCurrent = true;
			return;
		}

		const migrated = migrateToCurrentVersion(fileEntries);
		await resolveBlobRefsInEntries(fileEntries, this.#blobs);
		// loadEntriesFromFile guarantees entries[0] is a valid session header.
		const header = fileEntries[0] as SessionHeader;

		// Adopt the loaded session's working directory. Sessions live in a dir
		// keyed by their cwd, so resuming a session from another project must
		// re-point cwd/sessionDir at that project — unless that project directory
		// no longer exists on disk, in which case adopting it (and the process
		// chdir interactive mode then performs) would fail with ENOENT. Keep the
		// current cwd so the resumed session stays where the user already is.
		const headerCwd = header.cwd ? path.resolve(header.cwd) : undefined;
		if (headerCwd && headerCwd !== path.resolve(this.#cwd) && (await directoryExists(headerCwd))) {
			this.#cwd = headerCwd;
			this.#sessionDir = path.dirname(resolvedSessionFile);
			this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);
		}

		const journal = restoreSessionJournal(fileEntries);
		this.#applyEntries(header, journal.entries, journal.leafId);
		this.#additionalDirectories = header.additionalDirectories ?? [];
		this.#titleUpdatedAt = titleSlot?.updatedAt ?? header.timestamp;
		this.#hasTitleSlot = titleSlot !== undefined;
		this.#fileIsCurrent = true;
		this.#rewriteRequired = migrated || loaded.malformedRecords > 0;
		this.#forceFileCreation = true;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;

		this.sanitizeLoadedOpenAIResponsesReplayMetadata();
	}

	/** Start a new session. Drains and closes any existing writer first. */
	async newSession(options?: NewSessionOptions): Promise<string | undefined> {
		await this.#drainAndCloseWriter();
		return this.#resetToNewSession(options);
	}

	/** Delete a session file and its artifact directory after draining artifact writers. */
	async dropSession(sessionPath: string): Promise<void> {
		await this.#drainAndCloseWriter();
		const resolvedSessionPath = path.resolve(sessionPath);
		const artifactManager =
			!this.#adoptedArtifactManager && this.#sessionFile && path.resolve(this.#sessionFile) === resolvedSessionPath
				? this.#artifactManagerForSession()
				: new ArtifactManager(resolvedSessionPath.slice(0, -JSONL_SUFFIX_LENGTH));
		const artifactFence = await artifactManager?.beginTransaction();
		try {
			await this.#storage.deleteSessionWithArtifacts(resolvedSessionPath);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		} finally {
			await artifactFence?.commit();
		}
	}

	/**
	 * Fork the current session into a new file with the same entries.
	 * `beforeJournalPublish` lets lifecycle callers atomically publish referenced artifacts first.
	 * @returns the old and new session file paths, or undefined when not persisting.
	 */
	async fork(
		beforeJournalPublish?: (newSessionFile: string) => void | Promise<void>,
	): Promise<{ oldSessionFile: string; newSessionFile: string } | undefined> {
		if (!this.#persist || !this.#sessionFile) return undefined;

		const oldSessionFile = this.#sessionFile;
		const parentSessionId = this.#sessionId;
		const retainedState = beforeJournalPublish ? undefined : this.captureState();
		await this.#drainAndCloseWriter();
		this.#clearDiskError();
		const ownedArtifactClone = beforeJournalPublish ? undefined : await this.beginArtifactCloneTransaction();

		const timestamp = nowIso();
		const newSessionId = mintSessionId();
		const newSessionFile = path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${newSessionId}.jsonl`);
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			title: this.#header.title ?? this.#sessionName,
			titleSource: this.#header.titleSource ?? this.#titleSource,
			timestamp,
			cwd: this.#cwd,
			additionalDirectories: this.#additionalDirectories.length > 0 ? [...this.#additionalDirectories] : undefined,
			parentSession: parentSessionId,
			providerPromptCacheKey: this.#header.providerPromptCacheKey ?? parentSessionId,
		};

		try {
			if (ownedArtifactClone) await ownedArtifactClone.publish(newSessionFile);
			else await beforeJournalPublish?.(newSessionFile);
			this.#sessionId = newSessionId;
			this.#sessionFile = newSessionFile;
			this.#header = header;
			this.#sessionName = header.title;
			this.#titleSource = header.titleSource;
			this.#titleUpdatedAt = timestamp;
			this.#hasTitleSlot = true;
			this.#fileIsCurrent = false;
			this.#rewriteRequired = false;
			this.#forceFileCreation = true;
			this.#draftOnlySessionCleanupArmed = false;
			this.#artifactManager = null;
			this.#artifactManagerSessionFile = null;

			await this.#rewriteAtomically();
			await ownedArtifactClone?.commit();
			this.#rememberBreadcrumb(this.#cwd, newSessionFile);
			return { oldSessionFile, newSessionFile };
		} catch (operationError) {
			if (!ownedArtifactClone || !retainedState) throw operationError;
			this.restoreState(retainedState);
			const failures: unknown[] = [operationError];
			try {
				await this.#storage.deleteSessionWithArtifacts(newSessionFile);
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			try {
				await ownedArtifactClone.rollback();
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			if (failures.length === 1) throw operationError;
			throw new AggregateError(failures, "Fork failed and target cleanup was incomplete");
		}
	}

	/**
	 * Move the session to a new working directory: relocate the session file and
	 * artifacts on disk, update internal references, and rewrite the header cwd.
	 */
	async moveTo(newCwd: string, targetSessionDir?: string): Promise<void> {
		const resolvedCwd = path.resolve(newCwd);
		const resolvedTargetDir = targetSessionDir ? path.resolve(targetSessionDir) : undefined;
		if (
			resolvedCwd === path.resolve(this.#cwd) &&
			(!resolvedTargetDir || resolvedTargetDir === path.resolve(this.#sessionDir))
		) {
			return;
		}

		const managedRoot = resolveManagedSessionRoot(this.#sessionDir, this.#cwd);
		const nextSessionDir =
			resolvedTargetDir ??
			(managedRoot
				? computeDefaultSessionDir(resolvedCwd, this.#storage, managedRoot)
				: computeDefaultSessionDir(resolvedCwd, this.#storage));
		let sessionFileExisted = false;

		try {
			if (this.#persist && this.#sessionFile) {
				this.#storage.ensureDirSync(nextSessionDir);
				const oldSessionFile = this.#sessionFile;
				const newSessionFile = path.join(nextSessionDir, path.basename(oldSessionFile));
				const oldArtifactsDir = artifactsDirectoryFor(oldSessionFile)!;
				const newArtifactsDir = artifactsDirectoryFor(newSessionFile)!;
				const sessionPathChanged = path.resolve(oldSessionFile) !== path.resolve(newSessionFile);
				const artifactPathChanged = path.resolve(oldArtifactsDir) !== path.resolve(newArtifactsDir);
				sessionFileExisted = this.#storage.existsSync(oldSessionFile);
				let artifactsExisted = false;
				try {
					artifactsExisted = (await fs.promises.stat(oldArtifactsDir)).isDirectory();
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
				if (artifactsExisted && !sessionFileExisted) {
					// Artifact references must never move without a journal commit point.
					// Materialize the lazy source first so recovery can select one side.
					this.#forceFileCreation = true;
					await this.#rewriteAtomically();
					sessionFileExisted = this.#storage.existsSync(oldSessionFile);
				}

				const moveStoredSession = this.#storage.moveSessionWithArtifacts;
				const relocation = { source: oldSessionFile, dest: newSessionFile, preferDestination: false };
				this.#sessionFileRelocating = relocation;
				await this.#drainAndCloseWriter();
				sessionFileExisted ||= this.#storage.existsSync(oldSessionFile);
				this.#clearDiskError();

				const relocationManager = artifactPathChanged
					? this.#artifactManager && this.#artifactManagerSessionFile === oldSessionFile
						? this.#artifactManager
						: new ArtifactManager(oldArtifactsDir)
					: undefined;
				const artifactRelocation = relocationManager
					? await relocationManager.beginRelocation(newArtifactsDir)
					: undefined;
				try {
					// Filesystem artifacts are staged before the journal/storage
					// relocation becomes the commit point observed by recovery.
					if (sessionFileExisted && sessionPathChanged) {
						if (moveStoredSession) {
							// The indexed implementation installs its source/destination
							// queue synchronously, so later fenced writes can target dest.
							relocation.preferDestination = true;
							await moveStoredSession.call(this.#storage, oldSessionFile, newSessionFile);
						} else {
							await this.#storage.rename(oldSessionFile, newSessionFile);
						}
					}
				} catch (operationError) {
					try {
						await artifactRelocation?.rollback();
					} catch (rollbackError) {
						throw new AggregateError(
							[operationError, rollbackError],
							"Failed to relocate the session journal and roll back its artifacts",
						);
					}
					throw operationError;
				}
				await artifactRelocation?.commit();

				if (sessionFileExisted && sessionPathChanged) {
					this.#header.previousSessionFiles = [
						...new Set([...(this.#header.previousSessionFiles ?? []), path.resolve(oldSessionFile)]),
					];
				}

				this.#sessionFile = newSessionFile;
				if (relocationManager) {
					this.#artifactManager = relocationManager;
					this.#artifactManagerSessionFile = newSessionFile;
				}
				this.#sessionFileRelocating = null;
			}

			this.#cwd = resolvedCwd;
			this.#sessionDir = nextSessionDir;
			this.#header.cwd = resolvedCwd;
			if (this.#additionalDirectories.length > 0) {
				this.#additionalDirectories = this.#additionalDirectories.filter(directory => directory !== resolvedCwd);
				this.#header.additionalDirectories =
					this.#additionalDirectories.length > 0 ? this.#additionalDirectories : undefined;
			}

			const hasAssistant = this.#historyContainsAssistantMessage();
			if (this.#persist && this.#sessionFile && (sessionFileExisted || hasAssistant)) {
				this.#forceFileCreation = true;
				await this.#rewriteAtomically();
			}

			if (this.#sessionFile) this.#rememberBreadcrumb(resolvedCwd, this.#sessionFile);
		} finally {
			this.#sessionFileRelocating = null;
		}
	}

	/**
	 * Force the session onto disk even with no assistant message yet. Callers
	 * that expose a resumable session ID must await this first.
	 */
	async ensureOnDisk(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		this.#forceFileCreation = true;
		if (this.#fileIsCurrent && !this.#rewriteRequired) return;
		await this.#rewriteAtomically();
	}

	/** Persist this session's transcript as a newly identified OMP session. */
	async persistCopy(
		options?: { sessionDir?: string; suppressBreadcrumb?: boolean },
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionManager> {
		const sessionDir = options?.sessionDir ?? SessionManager.getDefaultSessionDir(this.#cwd, undefined, storage);
		const manager = new SessionManager(this.#cwd, sessionDir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		manager.#resetToNewSession();
		manager.#sessionName = this.#sessionName;
		manager.#titleSource = this.#titleSource;
		manager.#titleUpdatedAt = this.#titleUpdatedAt;
		manager.#header.title = this.#sessionName;
		manager.#header.titleSource = this.#titleSource;
		manager.#additionalDirectories = [...this.#additionalDirectories];
		manager.#header.additionalDirectories =
			manager.#additionalDirectories.length > 0 ? [...manager.#additionalDirectories] : undefined;
		manager.#entries = cloneDurableSessionJson(this.#entries);
		manager.#index.rebuild(manager.#entries, this.#index.leafId());
		manager.#forceFileCreation = true;
		const targetSessionFile = manager.#sessionFile;
		const artifactClone = await this.#artifactManagerForSession()?.beginCloneTransaction();
		try {
			if (artifactClone && targetSessionFile) {
				await artifactClone.publish(targetSessionFile.slice(0, -JSONL_SUFFIX_LENGTH));
			}
			await manager.#rewriteAtomically();
			await artifactClone?.commit();
			return manager;
		} catch (operationError) {
			const failures: unknown[] = [operationError];
			if (targetSessionFile) {
				try {
					await storage.deleteSessionWithArtifacts(targetSessionFile);
				} catch (cleanupError) {
					failures.push(cleanupError);
				}
			}
			try {
				await artifactClone?.rollback();
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			if (failures.length === 1) throw operationError;
			throw new AggregateError(failures, "Persisted session copy failed and target cleanup was incomplete");
		}
	}

	/**
	 * Stage a synchronous group of entry appends and publish the resulting full
	 * journal with one atomic replace. A failed publish removes only the staged
	 * entries, preserves/reparents entries appended concurrently, restores the
	 * prior durable file view, and clears the failed writer latch for retry.
	 *
	 * The callback MUST be synchronous.
	 */
	appendEntriesAtomically<T>(append: () => T): Promise<T> {
		return this.#withAtomicPersistenceLock(() => this.#appendEntriesAtomicallyLocked(append));
	}

	async #appendEntriesAtomicallyLocked<T>(append: () => T): Promise<T> {
		if (!this.#persist || !this.#sessionFile) return append();
		if (this.#atomicEntryBatch) throw new Error("Atomic persistence lock ownership was violated.");
		try {
			await this.ensureOnDisk();
			await this.flush();
		} catch (error) {
			const operationError = toError(error);
			await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			this.#notifyDurableEntries();
			throw error;
		}

		const batch: AtomicEntryBatch = {
			collecting: true,
			entryIds: new Set(),
			deferredNotifications: [],
			preBatchLeafId: this.#index.leafId(),
			externalLeafChanged: false,
			externalLeafId: null,
		};
		this.#atomicEntryBatch = batch;
		let result!: T;
		try {
			try {
				result = append();
			} finally {
				batch.collecting = false;
			}
			await this.#rewriteAtomically();
			if (!this.#fileIsCurrent || this.#rewriteRequired) {
				throw new Error("Atomic session batch was superseded before commit.");
			}
			this.#atomicEntryBatch = undefined;
			this.#notifyDurableEntries(batch.deferredNotifications);
			return result;
		} catch (error) {
			batch.collecting = false;
			const operationError = toError(error);
			this.#rollbackAtomicEntryBatch(batch);
			try {
				await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			} catch (repairError) {
				const retainedNotifications = batch.deferredNotifications.filter(entry => !batch.entryIds.has(entry.id));
				this.#pendingDurabilityNotifications.push(...retainedNotifications);
				this.#atomicEntryBatch = undefined;
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				if (repairError instanceof SessionPersistenceIndeterminateError) throw repairError;
				throw this.#latchIndeterminate(operationError, [toError(repairError)]);
			}
			const retainedNotifications = batch.deferredNotifications.filter(entry => !batch.entryIds.has(entry.id));
			this.#atomicEntryBatch = undefined;
			this.#notifyDurableEntries(retainedNotifications);
			throw error;
		}
	}

	/**
	 * Replace an uncertain append tail with the authoritative in-memory journal.
	 * Callers must only use this for monotonic recovery where every retained
	 * entry remains intended (for example, an explicit terminal tombstone).
	 */
	recoverPersistenceFromCurrentState(): Promise<void> {
		return this.#withAtomicPersistenceLock(async () => {
			if (!this.#persist || !this.#sessionFile) return;
			if (this.#atomicEntryBatch) throw new Error("Atomic persistence lock ownership was violated.");
			const operationError =
				this.#diskFailure ?? new Error("Authoritative session persistence recovery was requested.");
			await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			this.#notifyDurableEntries();
		});
	}

	/** Flush pending writes. Call before switching sessions or on shutdown. */
	async flush(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		await this.#scheduleDiskWork(async () => {
			if (this.#writer?.isOpen()) await this.#writer.flush();
		});
		// Drain any fire-and-forget backing writes (e.g. `writeTextSync` queued
		// on IndexedSessionStorage during `flushSync`) so callers relying on
		// flush() see the write durably visible to readers.
		await this.#storage.drain();
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * Synchronously makes the current append-only session durable. Avoid rewriting
	 * an already-current file: large restored sessions can contain GiB of compacted
	 * history, and Ctrl+C must not rebuild the whole JSONL string just to flush.
	 */
	flushSync(): void {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#atomicEntryBatch) throw new Error("Cannot synchronously flush during an atomic session batch.");
		if (this.#diskFailure) throw this.#diskFailure;
		if (this.#fileIsCurrent && !this.#rewriteRequired) {
			this.#writer?.flushSync?.();
			const writerError = this.#writer?.getError();
			if (writerError) throw writerError;
			return;
		}
		this.#rewriteSynchronously();
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * Drop only session files that this manager saw materialized for a draft and
	 * that still contain no durable conversation or extension state. Explicit
	 * ensureOnDisk() records (ACP session/new, handoff) stay resumable.
	 */
	async #dropIfEmptyAndNoDraft(): Promise<void> {
		if (!this.#draftOnlySessionCleanupArmed) return;
		const sessionFile = this.#sessionFile;
		if (!sessionFile || !this.#storage.existsSync(sessionFile)) {
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		const draftPath = this.#draftPath();
		if (draftPath && this.#storage.existsSync(draftPath)) return;
		if (!this.#entries.every(isDraftOnlyMetadataEntry)) {
			await this.#clearDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		try {
			await this.#storage.deleteSessionWithArtifacts(sessionFile);
			this.#fileIsCurrent = false;
			this.#forceFileCreation = false;
			this.#hasTitleSlot = false;
			this.#draftOnlySessionCleanupArmed = false;
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to drop empty session on close", { sessionFile, error: String(err) });
			}
		}
	}

	/** Flush, then close the append writer. */
	async close(): Promise<void> {
		if (!this.#persist) return;
		await this.#scheduleDiskWork(async () => {
			const hadWriter = this.#writer !== undefined;
			await this.#closeWriterHandle();
			if (hadWriter || (this.#sessionFile && this.#storage.existsSync(this.#sessionFile)))
				this.#fileIsCurrent = true;
		});
		await this.#dropIfEmptyAndNoDraft();
		// Wait for any queued backing writes (IndexedSessionStorage per-path
		// tail) to become durable so a graceful shutdown does not exit while
		// a fire-and-forget publish is still on the wire.
		await this.#storage.drain();
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * Raise the terminal write barrier ahead of the final {@link close}. Once
	 * sealed:
	 * - every later append, title change, and rewrite is a dropped no-op —
	 *   including work an event handler tries to enqueue while dispose is
	 *   awaiting `close()` on the disk tail;
	 * - the disk epoch is bumped, so queued-but-unexecuted tail work is
	 *   superseded and an ALREADY-RUNNING fenced/repair rewrite (awaiting the
	 *   tail, drain, writer close, or the atomic stage) fails its commit guard
	 *   at the rename fence instead of publishing over a revived file.
	 * The final `close()` itself is scheduled after the bump and still runs;
	 * pre-seal hot-path appends are already in the page cache. Idempotent;
	 * terminal.
	 */
	seal(): void {
		if (this.#released) return;
		this.#released = true;
		this.#diskEpoch++;
	}

	/**
	 * Terminal release: drop the in-memory transcript and complete the
	 * {@link seal}. The entry journal and its index mirror the agent's message
	 * array (tool results, file contents, base64 frame images); on a disposed
	 * session — e.g. a parked subagent still referenced by the lifecycle
	 * adoption record — they would otherwise stay pinned for the process
	 * lifetime.
	 *
	 * Closes the append writer; with the seal up, nothing can reopen it. A
	 * revival may reopen the same JSONL through a NEW manager the moment
	 * dispose returns; a late event handler resuming on THIS manager must
	 * never race that writer — and a post-release rewrite would persist the
	 * now-empty entry list, truncating the transcript. Reads after this point
	 * reopen from disk (revival, `history://`). Only call from session
	 * dispose, after the final `close()`; idempotent.
	 */
	releaseRetainedEntries(): void {
		this.seal();
		this.#entries = [];
		this.#index.clear();
		this.#closeWriterEventually();
	}

	getCwd(): string {
		return this.#cwd;
	}

	/** Additional workspace directories beyond cwd (multi-root), absolute and normalized. */
	getAdditionalDirectories(): string[] {
		return [...this.#additionalDirectories];
	}

	/**
	 * Persist a workspace-directory change to the session header. Respects the
	 * lazy-persistence gate: a session with no durable output yet keeps the
	 * change in memory (the header lands with the first real write), so seeding
	 * roots at launch never materializes an empty resumable session file.
	 */
	async #persistWorkspaceDirectoriesChange(): Promise<void> {
		if (!this.#persist || !this.#sessionFile || !this.#shouldHaveSessionFile()) return;
		this.#rewriteRequired = true;
		await this.#rewriteAtomically();
	}

	/**
	 * Add a workspace directory. Normalizes (relative to cwd), dedupes, rejects
	 * the cwd itself, persists to the session header, and triggers an atomic
	 * rewrite so the change survives a crash. Returns the resolved absolute
	 * path or `null` when the directory was already present (no-op).
	 */
	async addWorkspaceDirectory(directory: string): Promise<string | null> {
		const resolved = normalizeWorkspaceDirectory(directory, this.#cwd);
		if (resolved === path.resolve(this.#cwd)) {
			throw new Error("The current working directory is already the primary workspace root.");
		}
		if (this.#additionalDirectories.includes(resolved)) return null;
		this.#additionalDirectories = [...this.#additionalDirectories, resolved];
		this.#header.additionalDirectories = this.#additionalDirectories;
		await this.#persistWorkspaceDirectoriesChange();
		return resolved;
	}

	/**
	 * Remove a workspace directory by absolute or cwd-relative path. Persists
	 * the trimmed header. Returns the resolved path that was removed, or
	 * `null` when the directory was not an additional root (no-op).
	 */
	async removeWorkspaceDirectory(directory: string): Promise<string | null> {
		const resolved = normalizeWorkspaceDirectory(directory, this.#cwd);
		const idx = this.#additionalDirectories.findIndex(p => path.resolve(p) === resolved);
		if (idx === -1) return null;
		this.#additionalDirectories = this.#additionalDirectories.filter((_, i) => i !== idx);
		if (this.#additionalDirectories.length === 0) {
			this.#header.additionalDirectories = undefined;
		} else {
			this.#header.additionalDirectories = this.#additionalDirectories;
		}
		await this.#persistWorkspaceDirectoriesChange();
		return resolved;
	}

	/** Seed additional directories from settings or a passed list. Also called on resumed sessions with --add-dir; persists the updated header when the session file is already durable. No-op when the normalized list is unchanged (avoids rewriting large session files on every startup). */
	async setAdditionalDirectories(directories: string[]): Promise<void> {
		const workspace = normalizeSessionWorkspace({ cwd: this.#cwd, directories });
		const next = additionalWorkspaceDirectories(workspace);
		if (
			next.length === this.#additionalDirectories.length &&
			next.every((d, i) => d === this.#additionalDirectories[i])
		) {
			return;
		}
		this.#additionalDirectories = next;
		if (this.#additionalDirectories.length > 0) {
			this.#header.additionalDirectories = this.#additionalDirectories;
		} else {
			this.#header.additionalDirectories = undefined;
		}
		await this.#persistWorkspaceDirectoriesChange();
	}

	getUsageStatistics(): UsageStatistics {
		return this.#index.usageSnapshot();
	}

	/**
	 * Open a new per-turn budget window: snapshot the cumulative output baseline,
	 * reset the eval-subagent counter, and set the (optional) ceiling.
	 */
	beginTurnBudget(total: number | null, hard: boolean): void {
		this.#turnBudgetTotal = total;
		this.#turnBudgetHard = hard;
		this.#turnOutputBaseline = this.#index.usageSnapshot().output;
		this.#turnEvalOutput = 0;
	}

	recordEvalSubagentOutput(output: number): void {
		if (Number.isFinite(output) && output > 0) this.#turnEvalOutput += output;
	}

	getTurnBudget(): { total: number | null; spent: number; hard: boolean } {
		const mainOutput = Math.max(0, this.#index.usageSnapshot().output - this.#turnOutputBaseline);
		return { total: this.#turnBudgetTotal, spent: mainOutput + this.#turnEvalOutput, hard: this.#turnBudgetHard };
	}

	getSessionDir(): string {
		return this.#sessionDir;
	}

	getSessionId(): string {
		return this.#sessionId;
	}

	getSessionFile(): string | undefined {
		return this.#sessionFile;
	}

	/**
	 * Whether the current session has actually been materialized to durable
	 * storage (the JSONL exists on disk / in the active storage backend).
	 *
	 * Session persistence is lazy: the file is only written once the history
	 * contains an assistant message (or an explicit {@link ensureOnDisk}
	 * caller forces it). Until then {@link getSessionFile} returns an allocated
	 * path that leads nowhere, so a `--resume <id>` hint built from it would
	 * always fail. Consumers that advertise a resume command must gate on this
	 * (issue #8860).
	 */
	isSessionOnDisk(): boolean {
		return !!this.#sessionFile && this.#storage.existsSync(this.#sessionFile);
	}

	getArtifactsDir(): string | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager.dir;
		return artifactsDirectoryFor(this.#sessionFile);
	}

	adoptArtifactManager(manager: ArtifactManager): void {
		this.#adoptedArtifactManager = manager;
	}

	getArtifactManager(): ArtifactManager | null {
		return this.#artifactManagerForSession();
	}

	/**
	 * Fence the active session's artifact manager for inheritance by a future
	 * replacement session. Publication accepts either the still-active source
	 * (while fork/branch artifacts are published before their journal) or the
	 * already-active replacement, maps the JSONL path to its sibling artifact
	 * directory, and rejects unrelated destinations. Callers may include exact
	 * top-level companion files whose lifecycle semantics require continuity.
	 */
	async beginArtifactCloneTransaction(
		additionalFileNames: readonly string[] = [],
	): Promise<SessionArtifactCloneTransaction | undefined> {
		const sourceSessionFile = this.#sessionFile;
		if (!this.#persist || !sourceSessionFile) return undefined;
		const sourceManager = this.#artifactManagerForSession();
		if (!sourceManager) return undefined;
		const transaction = await sourceManager.beginCloneTransaction(additionalFileNames);

		return {
			publish: async destinationSessionFile => {
				const resolvedDestinationSessionFile = path.resolve(destinationSessionFile);
				const resolvedSourceSessionFile = path.resolve(sourceSessionFile);
				const resolvedActiveSessionFile = this.#sessionFile ? path.resolve(this.#sessionFile) : undefined;
				const publishingBeforeJournal = resolvedActiveSessionFile === resolvedSourceSessionFile;
				if (
					resolvedActiveSessionFile !== resolvedDestinationSessionFile &&
					(!publishingBeforeJournal ||
						path.dirname(resolvedDestinationSessionFile) !== path.resolve(this.#sessionDir) ||
						!resolvedDestinationSessionFile.endsWith(".jsonl") ||
						this.#storage.existsSync(resolvedDestinationSessionFile))
				) {
					throw new Error("Artifact clone destination is not the active or pending replacement session");
				}
				if (resolvedDestinationSessionFile === path.resolve(sourceSessionFile)) {
					throw new Error("Artifact clone destination must differ from its source session");
				}
				const destinationDir = artifactsDirectoryFor(resolvedDestinationSessionFile);
				if (!destinationDir) throw new Error("Artifact clone destination session is not persisted");
				await transaction.publish(destinationDir);
			},
			commit: () => transaction.commit(),
			rollback: () => transaction.rollback(),
		};
	}

	/**
	 * Snapshot artifact state for a fallible in-place session mutation. Persistent
	 * managers are restored in place so adopted owners keep one shared allocator.
	 */
	async beginArtifactTransaction(): Promise<ArtifactTransaction> {
		if (this.#activeArtifactTransaction) throw new Error("Artifact transaction already active");
		const managerTransaction = await this.#artifactManagerForSession()?.beginTransaction();
		this.#activeArtifactTransaction = managerTransaction ?? null;
		const inMemoryArtifacts = this.#inMemoryArtifacts ? new Map(this.#inMemoryArtifacts) : null;
		const inMemoryArtifactCounter = this.#inMemoryArtifactCounter;
		let closed = false;
		let rollbackPromise: Promise<void> | undefined;

		return {
			commit: async () => {
				if (closed) return;
				if (rollbackPromise) await rollbackPromise;
				if (closed) return;
				closed = true;
				if (this.#activeArtifactTransaction === managerTransaction) {
					this.#activeArtifactTransaction = null;
				}
				await managerTransaction?.commit();
			},
			rollback: () => {
				if (rollbackPromise) return rollbackPromise;
				if (closed) return Promise.resolve();
				rollbackPromise = (async () => {
					let failure: unknown;
					try {
						await managerTransaction?.rollback();
					} catch (error) {
						failure = error;
					}
					this.#inMemoryArtifacts = inMemoryArtifacts ? new Map(inMemoryArtifacts) : null;
					this.#inMemoryArtifactCounter = inMemoryArtifactCounter;
					if (failure) {
						closed = true;
						await managerTransaction?.commit();
						if (this.#activeArtifactTransaction === managerTransaction) {
							this.#activeArtifactTransaction = null;
						}
						throw failure;
					}
				})();
				return rollbackPromise;
			},
		};
	}

	async allocateArtifactPath(toolType: string): Promise<Partial<ArtifactWriterLease>> {
		const manager = this.#activeArtifactTransaction ?? this.#artifactManagerForSession();
		return (await manager?.allocatePath(toolType)) ?? {};
	}

	async saveArtifact(content: string, toolType: string): Promise<string | undefined> {
		const manager = this.#activeArtifactTransaction ?? this.#artifactManagerForSession();
		if (manager) return manager.save(content, toolType);

		// Non-persistent session: keep an in-memory copy so spill truncation works.
		this.#inMemoryArtifacts ??= new Map();
		const id = String(this.#inMemoryArtifactCounter++);
		this.#inMemoryArtifacts.set(id, content);
		return id;
	}

	async getArtifactPath(id: string): Promise<string | null> {
		return (await this.#artifactManagerForSession()?.getPath(id)) ?? null;
	}

	async saveDraft(text: string): Promise<void> {
		const draftPath = this.#draftPath();
		if (!draftPath || !this.#persist) return;

		if (text.length === 0) {
			try {
				await this.#storage.unlink(draftPath);
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			return;
		}

		const sessionFile = this.#sessionFile;
		const draftWillMaterializeMetadataOnlyFile =
			sessionFile !== undefined &&
			!this.#storage.existsSync(sessionFile) &&
			this.#entries.every(isDraftOnlyMetadataEntry);
		// Force the header onto disk so resume can find the file this draft attaches to.
		await this.ensureOnDisk();
		if (draftWillMaterializeMetadataOnlyFile) {
			await this.#writeDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = true;
		}
		await this.#storage.writeText(draftPath, text);
	}

	async consumeDraft(): Promise<string | null> {
		const draftPath = this.#draftPath();
		if (!draftPath) return null;

		let draft: string;
		try {
			draft = await this.#storage.readText(draftPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}

		try {
			await this.#storage.unlink(draftPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		if (this.#entries.every(isDraftOnlyMetadataEntry) && this.#hasDraftOnlySessionMarker())
			this.#draftOnlySessionCleanupArmed = true;

		return draft;
	}

	/** The source that set the session name: "user" (manual/RPC) or "auto" (generated title). */
	get titleSource(): SessionTitleSource | undefined {
		return this.#titleSource;
	}

	getSessionName(): string | undefined {
		return this.#sessionName;
	}

	onSessionNameChanged(cb: () => void): () => void {
		this.#sessionNameChangedCallbacks.add(cb);
		return () => {
			this.#sessionNameChangedCallbacks.delete(cb);
		};
	}

	/** Subscribe to persistence failures so hosts can surface lost-durability state. */
	onPersistenceError(cb: (error: Error) => void): () => void {
		this.#persistenceErrorCallbacks.add(cb);
		return () => {
			this.#persistenceErrorCallbacks.delete(cb);
		};
	}

	/**
	 * Set the session display name.
	 * @param source "user" for explicit renames; "auto" for generated titles.
	 *   Auto titles are ignored once the user has set a name.
	 */
	async setSessionName(name: string, source: SessionTitleSource = "auto", trigger?: string): Promise<boolean> {
		if (this.#released) return false;
		if (this.#titleSource === "user" && source === "auto") return false;

		const title = SessionManager.#cleanTitle(name);
		if (!title) return false;

		const previousTitle = this.#sessionName;
		const timestamp = nowIso();
		this.#sessionName = title;
		this.#titleSource = source;
		this.#titleUpdatedAt = timestamp;
		this.#header.title = title;
		this.#header.titleSource = source;

		const entry: TitleChangeEntry = {
			type: TITLE_CHANGE_ENTRY_TYPE,
			...this.#freshEntryFields(),
			timestamp,
			title,
			source,
		};
		if (previousTitle) entry.previousTitle = previousTitle;
		if (trigger) entry.trigger = trigger;
		this.#entries.push(entry);
		this.#index.insert(entry);
		this.#notifyEntryAppended(entry);
		this.#advanceJournalMutation();
		await this.#persistTitleChangeEntry(entry, { title, source, updatedAt: timestamp });
		// Keep the recent-sessions title index current so welcome-screen lookups
		// never have to content-scan this session's file.
		if (this.#persist && this.#storage instanceof FileSessionStorage) {
			recordSessionTitle(this.#sessionId, title);
		}

		this.#notifySessionNameListeners();
		return true;
	}

	/**
	 * Append a foreign (host-authored) entry verbatim, preserving its
	 * `id`/`parentId`. Used by collab guests to mirror the host session.
	 */
	ingestReplicatedEntry(entry: SessionEntry): void {
		this.#recordEntry(entry);
	}

	/**
	 * Snapshot the session for collab replication: the live header plus a deep
	 * copy of every entry (the host mutates entries in place on rewrite paths, so
	 * guests must not share references).
	 */
	snapshotForReplication(): { header: SessionHeader; entries: SessionEntry[] } {
		return { header: cloneDurableSessionJson(this.#header), entries: cloneDurableSessionJson(this.#entries) };
	}

	/**
	 * Append a message as a child of the current leaf, then advance the leaf.
	 * CompactionSummaryMessage / BranchSummaryMessage are rejected here — they are
	 * top-level entries via appendCompaction()/branchWithSummary().
	 */
	appendMessage(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
	): string {
		const entry: SessionMessageEntry = { type: "message", ...this.#freshEntryFields(), message };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append to a non-active branch without changing the current leaf.
	 * Used by work that retains ownership of a branch across tree navigation.
	 */
	appendMessageToBranch(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
		parentId: string | null,
	): string {
		if (parentId !== null && !this.#index.has(parentId)) throw new Error(`Entry ${parentId} not found`);
		const activeLeafId = this.#index.leafId();
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.#index),
			parentId,
			timestamp: nowIso(),
			message,
		};
		this.#recordEntry(entry);
		this.#index.setLeaf(activeLeafId);
		const leafRecord = this.#leafRecord();
		if (leafRecord) this.#appendToSessionFile(leafRecord);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel?: string, configured?: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			...this.#freshEntryFields(),
			thinkingLevel: thinkingLevel ?? null,
			configured: configured ?? null,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendServiceTierChange(serviceTier: ServiceTierByFamily | null): string {
		const entry: ServiceTierChangeEntry = { type: "service_tier_change", ...this.#freshEntryFields(), serviceTier };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendModeChange(mode: string, data?: Record<string, unknown>): string {
		const entry: ModeChangeEntry = { type: "mode_change", ...this.#freshEntryFields(), mode, data };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append a model change as a child of the current leaf, then advance the leaf.
	 * @param model Model in "provider/modelId" format
	 * @param role Optional role (default: "default")
	 * @param resolvedModelIsFallback Whether this transition selected a retry-fallback model
	 */
	appendModelChange(model: string, role?: string, resolvedModelIsFallback = false): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			...this.#freshEntryFields(),
			model,
			role,
			resolvedModelIsFallback,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendSessionInit(init: {
		systemPrompt: string;
		task: string;
		tools: string[];
		agent?: string;
		modelRole?: string;
		resolvedModel?: string;
		readOnly?: boolean;
		outputSchema?: unknown;
		outputSchemaMode?: StructuredSubagentSchemaMode;
		restrictToolNames?: boolean;
		spawns?: string;
		readSummarize?: boolean;
		advisor?: string;
	}): string {
		const entry: SessionInitEntry = { type: "session_init", ...this.#freshEntryFields(), ...init };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCompaction<T = unknown>(
		summary: string,
		shortSummary: string | undefined,
		firstKeptEntryId: string,
		tokensBefore: number,
		options: {
			details?: T;
			fromExtension?: boolean;
			preserveData?: Record<string, unknown>;
			method?: CompactionMethod;
			providerReplayThroughEntryId?: string;
			tokensAfter?: number;
		} = {},
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			...this.#freshEntryFields(),
			summary,
			shortSummary,
			firstKeptEntryId,
			tokensBefore,
			tokensAfter: options.tokensAfter,
			method: options.method,
			providerReplayThroughEntryId: options.providerReplayThroughEntryId,
			details: options.details,
			fromExtension: options.fromExtension,
			preserveData: options.preserveData,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append the durable conversation boundary recorded by `/clear`. The
	 * collapsed live transcript and the model-context rebuild start after the
	 * latest one, while the full history stays on disk (the plain
	 * `transcript:true` export walks it unchanged).
	 */
	appendResetBoundary(): string {
		const entry: ResetBoundaryEntry = { type: "reset_boundary", ...this.#freshEntryFields() };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = { type: "custom", customType, data, ...this.#freshEntryFields() };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Rewrite the session file after in-place entry updates (e.g. pruning old tool
	 * outputs). Use sparingly.
	 */
	async rewriteEntries(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		await this.#rewriteAtomically();
	}

	/** Materialize the current tree leaf before publishing an in-file navigation. */
	async persistActiveLeaf(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		this.#forceFileCreation = true;
		// Always canonicalize the file. If a previous navigation appended a leaf
		// record and this navigation returns to the physical last entry, the
		// canonical body must remove that stale trailing record before resume.
		await this.#rewriteAtomically();
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Hook identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @param attribution Who initiated this message for billing/attribution semantics
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string | undefined,
		content: string | (TextContent | ImageContent)[] | undefined,
		display: boolean | undefined,
		details?: T,
		attribution: MessageAttribution | undefined = "agent",
	): string {
		const normalized = normalizeCustomMessagePayload<T>({ customType, content, display, details, attribution });
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType: normalized.customType,
			content: normalized.content,
			display: normalized.display,
			// Drop AgentSession-internal transient fields before disk persistence.
			details: stripInternalDetailsFields(normalized.details),
			attribution: normalized.attribution,
			...this.#freshEntryFields(),
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/** Append a TTSR injection entry recording which rules were injected. */
	appendTtsrInjection(ruleNames: string[]): string {
		const entry: TtsrInjectionEntry = {
			type: "ttsr_injection",
			...this.#freshEntryFields(),
			injectedRules: [...ruleNames],
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/** All unique TTSR rule names injected on the current branch (root → leaf). */
	getInjectedTtsrRules(): string[] {
		const names = new Set<string>();
		for (const entry of this.getBranch()) {
			if (entry.type !== "ttsr_injection") continue;
			for (const name of entry.injectedRules) names.add(name);
		}
		return [...names];
	}

	/** Append a credential pin recording which OAuth account served `provider`. */
	appendCredentialPin(provider: string, hash: string): string {
		const entry: CredentialPinEntry = {
			type: "credential_pin",
			...this.#freshEntryFields(),
			provider,
			hash,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Latest credential pin per provider on the current branch (root → leaf),
	 * with the effective last-use time of the pinned account.
	 *
	 * Pins are appended only when the serving account *changes*, so a long
	 * session on one account carries a single old pin entry. Any assistant turn
	 * for the same provider after that pin was necessarily served by the pinned
	 * account, so its timestamp advances `lastUsedAt` — a resume seconds after
	 * the last turn seeds a warm sticky instead of a stale one.
	 */
	getCredentialPins(): Map<string, { hash: string; lastUsedAt: number }> {
		const pins = new Map<string, { hash: string; lastUsedAt: number }>();
		for (const entry of this.getBranch()) {
			if (entry.type === "credential_pin") {
				pins.set(entry.provider, { hash: entry.hash, lastUsedAt: new Date(entry.timestamp).getTime() });
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				const pin = pins.get(entry.message.provider);
				if (pin) pin.lastUsedAt = Math.max(pin.lastUsedAt, entry.message.timestamp);
			}
		}
		return pins;
	}

	getLeafId(): string | null {
		return this.#index.leafId();
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.#index.leafEntry();
	}

	/**
	 * The most recent model role on the current branch, or undefined when no
	 * model change has been recorded.
	 */
	getLastModelChangeRole(): string | undefined {
		const branch = this.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type === "model_change") return entry.role ?? "default";
		}
		return undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.#index.get(id);
	}

	/** All direct children of an entry. */
	getChildren(parentId: string): SessionEntry[] {
		return this.#index.childrenOf(parentId);
	}

	getLabel(id: string): string | undefined {
		return this.#index.labelFor(id);
	}

	/**
	 * Set or clear a label on an entry. Pass undefined/empty to clear.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.#index.has(targetId)) throw new Error(`Entry ${targetId} not found`);

		const entry: LabelEntry = { type: "label", ...this.#freshEntryFields(), targetId, label };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Walk from an entry to root, returning entries in path order. Includes all
	 * entry types; use buildSessionContext() for the resolved LLM messages.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		return this.#index.pathTo(fromId ?? this.#index.leafId());
	}

	/**
	 * Build the session context (LLM messages), or — with `{ transcript: true }` —
	 * the full-history display transcript, from the current leaf path.
	 */
	buildSessionContext(options?: BuildSessionContextOptions): SessionContext {
		return buildSessionContext(this.#entries, this.#index.leafId(), this.#index.entriesById(), options);
	}

	/** Strip stale OpenAI Responses replay metadata from the runtime projection without forcing a durable rewrite. */
	sanitizeLoadedOpenAIResponsesReplayMetadata(): boolean {
		let changed = false;
		for (const entry of this.#entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;

			const sanitized = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
			if (sanitized === entry.message) continue;

			entry.message = sanitized;
			changed = true;
		}

		return changed;
	}

	getHeader(): SessionHeader | null {
		return this.#header;
	}

	/** All session entries (excludes header). Returns a shallow copy. */
	getEntries(): SessionEntry[] {
		return [...this.#entries];
	}

	/**
	 * The session as a tree. A well-formed session has exactly one root; orphaned
	 * entries (broken parent chain) are returned as roots too.
	 */
	getTree(): SessionTreeNode[] {
		return this.#index.tree(this.#entries);
	}

	/**
	 * Move the leaf to an earlier entry so the next append forms a new branch.
	 * Existing entries are never modified or deleted.
	 */
	branch(branchFromId: string): void {
		if (!this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		this.#setLeaf(branchFromId);
	}

	/** Reset the leaf to null so the next append creates a new root entry. */
	resetLeaf(): void {
		this.#setLeaf(null);
	}

	/**
	 * Durably move the active branch past a discarded entry.
	 *
	 * The loader reconstructs the active branch from the last physical journal
	 * entry, so changing the in-memory leaf alone is lost on reload. Known
	 * metadata children are chained onto the discarded entry's parent before the
	 * entry is removed. If any child may carry content, the subtree is preserved
	 * off-branch instead. Both paths append a metadata-only branch marker and
	 * rewrite the journal, making the selected path durable.
	 */
	async discardEntryDurably(entryId: string): Promise<void> {
		const entry = this.#index.get(entryId);
		if (!entry) return;
		const children = this.#index.childrenOf(entryId);
		const canReparentChildren = children.every(child => child.type === "service_tier_change");
		let leafId = entry.parentId;
		if (canReparentChildren) {
			for (const child of children) {
				child.parentId = leafId;
				leafId = child.id;
			}
			this.#entries = this.#entries.filter(candidate => candidate.id !== entryId);
			this.#index.rebuild(this.#entries);
		}
		this.branchWithSummary(leafId, "", {
			kind: DISCARDED_ENTRY_BRANCH_MARKER,
			discardedEntryId: entryId,
		});
		await this.rewriteEntries();
	}

	/** Like branch(), but also records a branch_summary of the abandoned path. */
	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromExtension?: boolean): string {
		if (branchFromId !== null && !this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);

		this.#setLeaf(branchFromId);
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.#index),
			parentId: branchFromId,
			timestamp: nowIso(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromExtension,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Create a new session file containing only the path from root to `leafId`.
	 * A supplied `beforeJournalPublish` barrier publishes referenced artifacts before the journal.
	 * Returns the new file path, or undefined when not persisting.
	 */
	createBranchedSession(leafId: string): string | undefined;
	createBranchedSession(
		leafId: string,
		beforeJournalPublish: (newSessionFile: string) => void | Promise<void>,
	): Promise<string | undefined>;
	createBranchedSession(
		leafId: string,
		beforeJournalPublish?: (newSessionFile: string) => void | Promise<void>,
	): string | undefined | Promise<string | undefined> {
		const sourceSessionFile = this.#sessionFile;
		const branchPath = this.getBranch(leafId);
		if (branchPath.length === 0) throw new Error(`Entry ${leafId} not found`);

		// Drop label entries from the path; recreate them fresh from the resolved map.
		const entriesToKeep = branchPath.filter(entry => entry.type !== "label");
		const keptIds = new Set(entriesToKeep.map(entry => entry.id));
		const labelsToCarry: Array<{ targetId: string; label: string }> = [];
		for (const [targetId, label] of this.#index.labelsInEffect()) {
			if (keptIds.has(targetId)) labelsToCarry.push({ targetId, label });
		}

		const timestamp = nowIso();
		const newSessionId = mintSessionId();
		const newSessionFile = path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${newSessionId}.jsonl`);
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.#cwd,
			title: this.#sessionName,
			titleSource: this.#titleSource,
			parentSession: this.#persist ? sourceSessionFile : undefined,
			additionalDirectories: this.#additionalDirectories.length > 0 ? [...this.#additionalDirectories] : undefined,
		};

		const labels: LabelEntry[] = [];
		let parentId = entriesToKeep[entriesToKeep.length - 1]?.id ?? null;
		for (const carried of labelsToCarry) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...keptIds, ...labels.map(entry => entry.id)])),
				parentId,
				timestamp: nowIso(),
				targetId: carried.targetId,
				label: carried.label,
			};
			labels.push(labelEntry);
			parentId = labelEntry.id;
		}

		const activateTarget = (): string | undefined => {
			this.#header = header;
			this.#entries = [...entriesToKeep, ...labels];
			this.#sessionId = newSessionId;
			this.#sessionName = header.title;
			this.#titleSource = header.titleSource;
			this.#titleUpdatedAt = timestamp;
			this.#hasTitleSlot = true;
			this.#index.rebuild(this.#entries);
			this.#artifactManager = null;
			this.#artifactManagerSessionFile = null;
			this.#forceFileCreation = this.#persist;

			if (!this.#persist) {
				this.#sessionFile = undefined;
				this.#fileIsCurrent = false;
				this.#rewriteRequired = false;
				return undefined;
			}

			this.#sessionFile = newSessionFile;
			this.#rewriteSynchronously();
			this.#rememberBreadcrumb(this.#cwd, newSessionFile);
			return newSessionFile;
		};
		if (!this.#persist || !beforeJournalPublish) return activateTarget();
		return Promise.resolve(beforeJournalPublish(newSessionFile)).then(activateTarget);
	}

	/** Resolve the canonical default session directory for a cwd. */
	static getDefaultSessionDir(
		cwd: string,
		agentDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): string {
		return computeDefaultSessionDir(cwd, storage, getSessionsDir(agentDir));
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in the session header)
	 * @param sessionDir Optional session directory; defaults to the cwd-derived dir.
	 */
	static create(cwd: string, sessionDir?: string, storage: SessionStorage = new FileSessionStorage()): SessionManager {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#resetToNewSession();
		return manager;
	}

	/**
	 * Create a fresh empty session file in the default session directory for
	 * `cwd`, writing only the session header. The returned path can be passed to
	 * `setSessionFile` / `AgentSession.switchSession` when a caller explicitly
	 * needs a brand-new persisted session at a cwd-derived path.
	 */
	static createEmptySessionFile(cwd: string, storage: SessionStorage = new FileSessionStorage()): string {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const id = mintSessionId();
		const timestamp = nowIso();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id,
			timestamp,
			cwd: path.resolve(cwd),
		};
		const file = path.join(sessionDir, `${fileSafeTimestamp(timestamp)}_${id}.jsonl`);
		storage.writeTextSync(file, `${serializeTitleSlot({ updatedAt: timestamp })}${JSON.stringify(header)}\n`);
		return file;
	}

	/**
	 * Fork a session into the current project directory: copy history from another
	 * session file while creating a fresh session file in this sessionDir.
	 *
	 * `options.sessionFile` pins the new session's file path (default: an
	 * auto-named `<timestamp>_<id>.jsonl` in `sessionDir`). Artifacts are copied
	 * recursively by default; nested agents that deliberately share their parent's
	 * artifact root may disable this with `copyArtifacts: false`.
	 */
	static async forkFrom(
		sourcePath: string,
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: { copyArtifacts?: boolean; suppressBreadcrumb?: boolean; sessionFile?: string },
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;

		const resolvedSourcePath = path.resolve(sourcePath);
		const sourceEntries = await loadEntriesFromFile(resolvedSourcePath, storage);
		migrateToCurrentVersion(sourceEntries);
		await resolveBlobRefsInEntries(sourceEntries, manager.#blobs);

		const sourceHeader = sourceEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
		const journal = restoreSessionJournal(sourceEntries);
		manager.#resetToNewSession(
			{
				parentSession: sourceHeader?.id,
				providerPromptCacheKey: sourceHeader?.providerPromptCacheKey ?? sourceHeader?.id,
			},
			options?.sessionFile,
		);
		manager.#header.title = sourceHeader?.title;
		manager.#header.titleSource = sourceHeader?.titleSource;
		manager.#additionalDirectories = (sourceHeader?.additionalDirectories ?? []).filter(
			directory => directory !== path.resolve(cwd),
		);
		manager.#header.additionalDirectories =
			manager.#additionalDirectories.length > 0 ? manager.#additionalDirectories : undefined;
		manager.#sessionName = manager.#header.title;
		manager.#titleSource = manager.#header.titleSource;
		manager.#titleUpdatedAt = nowIso();
		manager.#hasTitleSlot = true;
		manager.#entries = journal.entries;
		manager.#index.rebuild(journal.entries, journal.leafId);
		manager.sanitizeLoadedOpenAIResponsesReplayMetadata();
		manager.#forceFileCreation = true;
		const targetSessionFile = manager.#sessionFile;
		if (!targetSessionFile) throw new Error("Persisted fork did not allocate a target session file");
		if (path.resolve(targetSessionFile) === resolvedSourcePath) {
			throw new Error("Fork target session file must differ from its source");
		}
		const sourceArtifactsDir = artifactsDirectoryFor(resolvedSourcePath);
		const targetArtifactsDir = artifactsDirectoryFor(targetSessionFile);
		const artifactClone =
			options?.copyArtifacts === false || !sourceArtifactsDir
				? undefined
				: await new ArtifactManager(sourceArtifactsDir).beginCloneTransaction();
		try {
			if (artifactClone && !targetArtifactsDir) throw new Error("Fork target has no artifact directory");
			await artifactClone?.publish(targetArtifactsDir!);
			await manager.#rewriteAtomically();
			await artifactClone?.commit();
			return manager;
		} catch (operationError) {
			const failures: unknown[] = [operationError];
			try {
				await storage.deleteSessionWithArtifacts(targetSessionFile);
			} catch (cleanupError) {
				failures.push(cleanupError);
			}
			if (artifactClone) {
				try {
					await artifactClone.rollback();
				} catch (cleanupError) {
					failures.push(cleanupError);
				}
			}
			if (failures.length === 1) throw operationError;
			throw new AggregateError(failures, "Fork failed and target cleanup was incomplete");
		}
	}

	/**
	 * Open a specific session file.
	 * @param sessionDir Optional dir for /new or /branch; defaults to the file's parent.
	 * @param options.initialCwd Cwd to use when the file is empty or missing.
	 */
	static async open(
		filePath: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: { initialCwd?: string; suppressBreadcrumb?: boolean },
	): Promise<SessionManager> {
		const loaded = await loadSessionFile(filePath, storage);
		const header = loaded.entries.find(entry => entry.type === "session") as SessionHeader | undefined;
		// Resume into the session's recorded cwd only when that directory still
		// exists. A deleted project dir would make the constructor's #cwd — and the
		// `setProjectDir` chdir interactive mode runs next — point at (and fail on)
		// a missing path, so fall back to the launch cwd and anchor /new and /branch
		// there too, keeping the resumed session where the user already is.
		const recordedCwd = header?.cwd;
		const recordedCwdUsable = !!recordedCwd && (await directoryExists(recordedCwd));
		const cwd = recordedCwdUsable ? recordedCwd : (options?.initialCwd ?? getProjectDir());
		const dir =
			sessionDir ??
			(recordedCwd && !recordedCwdUsable
				? SessionManager.getDefaultSessionDir(cwd, undefined, storage)
				: path.dirname(path.resolve(filePath)));
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		await manager.#setSessionFile(filePath, loaded);
		return manager;
	}

	/**
	 * Lock-free peek for cold subagent revival: returns the recorded working
	 * directory (session header) and the latest `session_init` contract (system
	 * prompt / tools / output schema) WITHOUT taking the single-writer lock that
	 * {@link open} acquires — the caller re-opens for the actual revive. Returns
	 * null when the file can't be read; `init` is null for files written before
	 * `session_init` was recorded (no faithful contract to rebuild from).
	 */
	static async peekSessionInit(
		filePath: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<{
		cwd: string;
		init: {
			systemPrompt: string;
			task: string;
			tools: string[];
			agent?: string;
			modelRole?: string;
			resolvedModel?: string;
			outputSchema?: unknown;
			outputSchemaMode?: StructuredSubagentSchemaMode;
			restrictToolNames?: boolean;
			spawns?: string;
			readSummarize?: boolean;
			advisor?: string;
		} | null;
	} | null> {
		let header: SessionHeader | undefined;
		let init: {
			systemPrompt: string;
			task: string;
			tools: string[];
			agent?: string;
			modelRole?: string;
			resolvedModel?: string;
			outputSchema?: unknown;
			outputSchemaMode?: StructuredSubagentSchemaMode;
			restrictToolNames?: boolean;
			spawns?: string;
			readSummarize?: boolean;
			advisor?: string;
		} | null = null;
		const visit = (entry: FileEntry): void => {
			if (entry.type === "session") {
				header ??= entry;
				return;
			}
			if (entry.type === "session_init") {
				init = {
					systemPrompt: entry.systemPrompt,
					task: entry.task,
					tools: entry.tools,
					agent: entry.agent,
					modelRole: entry.modelRole,
					resolvedModel: entry.resolvedModel,
					outputSchema: entry.outputSchema,
					outputSchemaMode: entry.outputSchemaMode,
					restrictToolNames: entry.restrictToolNames,
					readSummarize: entry.readSummarize,
					spawns: entry.spawns,
					advisor: entry.advisor,
				};
			}
		};

		try {
			await visitEntriesFromFile(filePath, visit, storage);
		} catch {
			return null;
		}
		// A missing, empty, or invalid file has no usable session.
		if (!header) return null;
		return { cwd: header.cwd ?? getProjectDir(), init };
	}

	/** Continue the most recent session, or create a new one if none exists. */
	static async continueRecent(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const resolvedCwd = path.resolve(cwd);
		const breadcrumb = await readTerminalBreadcrumbEntry();
		let chosenSession: string | null | undefined;

		if (breadcrumb) {
			// A fresh `/new` boundary whose JSONL was never materialized (lazy
			// new-session persistence, then a process exit before any assistant
			// output). Honor the boundary: start fresh rather than falling back to
			// findMostRecentSession(), which would resurrect the pre-`/new`
			// transcript. A materialized (or genuinely stale/deleted) crumb reports
			// exists=false only when fresh, so this never masks a real stale crumb.
			if (breadcrumb.fresh && !breadcrumb.exists) {
				const manager = new SessionManager(cwd, dir, true, storage);
				manager.#resetToNewSession();
				return manager;
			}

			// Recover stale crumbs: a subagent open (pre-fix) may have pointed this
			// terminal's breadcrumb at an artifact child; resume the parent instead.
			breadcrumb.sessionFile = resolveBreadcrumbToInteractiveRoot(breadcrumb.sessionFile);
			const breadcrumbCwd = path.resolve(breadcrumb.cwd);
			if (breadcrumbCwd === resolvedCwd) {
				chosenSession = breadcrumb.sessionFile;
			} else {
				// The terminal's last session started in a different cwd. If that cwd is
				// gone (worktree move/rename) and this location has no sessions of its
				// own, re-root the moved session here instead of starting fresh. When an
				// explicit sessionDir is reused across the move, the stale breadcrumb file
				// may be the newest entry there; prefer a genuine current-cwd session.
				let newestInTargetDir = await findMostRecentSession(dir, storage);
				const breadcrumbFile = path.resolve(breadcrumb.sessionFile);
				const breadcrumbCwdMissing = !fs.existsSync(breadcrumbCwd);
				const newestIsBreadcrumb = newestInTargetDir ? path.resolve(newestInTargetDir) === breadcrumbFile : false;
				let currentProjectAlreadyHasSession = false;

				if (breadcrumbCwdMissing && newestIsBreadcrumb) {
					const localSession = (await SessionManager.list(cwd, dir, storage)).find(
						session =>
							path.resolve(session.path) !== breadcrumbFile &&
							session.cwd &&
							path.resolve(session.cwd) === resolvedCwd,
					);
					if (localSession) {
						newestInTargetDir = localSession.path;
						currentProjectAlreadyHasSession = true;
					}
				}

				const looksLikeMovedProject =
					breadcrumbCwdMissing &&
					(newestInTargetDir === null || (newestIsBreadcrumb && !currentProjectAlreadyHasSession));
				if (looksLikeMovedProject) {
					logger.info("Re-rooting moved session", { from: breadcrumbCwd, to: resolvedCwd });
					// Anchor at the gone breadcrumb cwd so the moveTo below relocates the
					// session: open() now falls back to the launch cwd for a missing
					// recorded cwd, which would no-op moveTo when it equals `cwd`.
					const manager = await SessionManager.open(breadcrumb.sessionFile, undefined, storage, {
						initialCwd: breadcrumbCwd,
					});
					await manager.moveTo(cwd, sessionDir);
					return manager;
				}

				chosenSession = newestInTargetDir;
			}
		}

		if (chosenSession === undefined) chosenSession = await findMostRecentSession(dir, storage);

		const manager = new SessionManager(cwd, dir, true, storage);
		if (chosenSession) await manager.setSessionFile(chosenSession);
		else manager.#resetToNewSession();
		return manager;
	}

	/** Create an in-memory session (no file persistence). */
	static inMemory(
		cwd: string = getProjectDir(),
		storage: SessionStorage = new MemorySessionStorage(),
	): SessionManager {
		const manager = new SessionManager(cwd, "", false, storage);
		manager.#resetToNewSession();
		return manager;
	}

	/**
	 * List sessions for a project directory.
	 * @param sessionDir Optional dir; defaults to the cwd-derived dir.
	 */
	static async list(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionInfo[]> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const sessions = await listSessions(dir, storage);
		return sortPinnedFirst(sessions, await loadPinnedSessionIds());
	}

	/** List all sessions across all project directories, pinned sessions first. */
	static async listAll(storage: SessionStorage = new FileSessionStorage()): Promise<SessionInfo[]> {
		const sessions = await listAllSessions(storage);
		return sortPinnedFirst(sessions, await loadPinnedSessionIds());
	}
}

/**
 * If the current session was created by `/move` and contains no real
 * user/assistant messages, delete it so empty move sessions don't accumulate.
 */
export async function cleanupEmptyMoveSession(
	sessionManager: SessionManager,
	movedFromEmptySessionFile: string | undefined,
): Promise<void> {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !movedFromEmptySessionFile) return;
	if (path.resolve(sessionFile) !== path.resolve(movedFromEmptySessionFile)) return;
	const entries = sessionManager.getEntries();
	const hasRealMessages = entries.some(
		e => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
	);
	if (hasRealMessages) return;
	try {
		await sessionManager.dropSession(sessionFile);
	} catch (err) {
		logger.warn("Failed to clean up empty move session", { sessionFile, error: String(err) });
	}
}
