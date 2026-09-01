/*
 * Session-scoped artifact storage for truncated tool outputs.
 *
 * Artifacts are stored in a directory alongside the session file,
 * accessible via artifact:// URLs.
 */

import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { replaceFileAtomically } from "../utils/atomic-file";
import {
	type ArtifactPublication,
	commitClonePublication,
	commitRelocationPublication,
	publishArtifactGraph,
	rollbackArtifactPublication,
} from "./artifact-durability";

export {
	reconcileArtifactOperationsSync,
	reconcileArtifactOperationsUnderRootSync,
	removeArtifactOperationIntent,
	writeArtifactDeletionIntent,
} from "./artifact-durability";

/**
 * Sanitize a tool name for safe use as the middle segment of the artifact
 * filename (`${id}.${toolType}.log`). Built-in tool names are fixed, but MCP,
 * extension, and RPC-host tool names are arbitrary and may contain path
 * separators (`/`, `\\`) or traversal sequences (`..`) that would otherwise let
 * a spilled artifact escape the artifacts directory. Collapse everything
 * outside `[A-Za-z0-9_-]` to `_`, and cap the length so an arbitrarily long
 * name cannot overflow the filesystem's filename limit (ENAMETOOLONG). Fall
 * back to `tool` when nothing survives.
 */
function sanitizeToolType(toolType: string): string {
	const sanitized = toolType
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 64);
	return sanitized || "tool";
}

const ARTIFACT_FILE_PATTERN = /^\d+\..*\.log$/;
const ARTIFACT_ID_RESERVATION_PATTERN = /^\.omp-artifact-id-(\d+)$/;
const TRANSACTION_BLOCKED = Symbol("artifactTransactionBlocked");

interface ArtifactTransactionSnapshot {
	dirExisted: boolean;
	nextId: number;
}

interface OwnedArtifactPath {
	filename: string;
	dev: number;
	ino: number;
}

interface ArtifactReservation extends OwnedArtifactPath {
	idReservation: OwnedArtifactPath;
}

interface ReservedArtifactWriterLease extends ArtifactWriterLease {
	reservation: ArtifactReservation;
	settled: Promise<void>;
	write(content: string): Promise<void>;
}

/** A transaction fence whose rollback removes only paths allocated by that transaction. */
export interface ArtifactTransaction {
	/** Release the mutation fence after success or after rollback publication. */
	commit(): Promise<void>;
	/** Remove transaction-created paths while retaining the fence until commit(). */
	rollback(): Promise<void>;
}

/** A read-only source fence that can atomically publish a copy into a new session directory. */
export interface ArtifactCloneTransaction {
	/** Publish the fenced source snapshot at an absent destination directory. */
	publish(destinationDir: string): Promise<void>;
	/** Keep the published destination and release the source fence. */
	commit(): Promise<void>;
	/** Remove clone output and release the source fence. */
	rollback(): Promise<void>;
}

/** A fenced relocation whose destination artifacts are published before its journal moves. */
export interface ArtifactRelocationTransaction {
	/** Rebind the shared manager state to the destination and retire the source artifacts. */
	commit(): Promise<void>;
	/** Remove the unpublished destination and retain the source binding. */
	rollback(): Promise<void>;
}

/** An allocated artifact path whose writer must release ownership after its final byte is durable. */
export interface ArtifactWriterLease {
	id: string;
	path: string;
	release(): void;
}

export interface ArtifactManagerTransaction extends ArtifactTransaction {
	allocatePath(toolType: string): Promise<ArtifactWriterLease>;
	save(content: string, toolType: string): Promise<string>;
}

interface ActiveArtifactTransaction {
	token: symbol;
	settled: Promise<void>;
}

interface ArtifactTransactionFence {
	token: symbol;
	release(): void;
}

interface ArtifactDirectoryState {
	dir: string;
	nextId: number;
	dirCreated: boolean;
	initPromise: Promise<void> | null;
	operationTail: Promise<void>;
	transactionTail: Promise<void>;
	activeTransaction: ActiveArtifactTransaction | null;
	writerLeases: Set<Promise<void>>;
}

interface ArtifactDirectoryBinding {
	state: ArtifactDirectoryState;
}

const artifactBindings = new Map<string, ArtifactDirectoryBinding>();

function hasCode(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function createArtifactState(dir: string): ArtifactDirectoryState {
	return {
		dir,
		nextId: 0,
		dirCreated: false,
		initPromise: null,
		operationTail: Promise.resolve(),
		transactionTail: Promise.resolve(),
		activeTransaction: null,
		writerLeases: new Set(),
	};
}

function artifactBindingFor(dir: string): ArtifactDirectoryBinding {
	const key = path.resolve(dir);
	const existing = artifactBindings.get(key);
	if (existing) return existing;
	const created = { state: createArtifactState(key) };
	artifactBindings.set(key, created);
	return created;
}

function reserveRelocationDestination(state: ArtifactDirectoryState, destinationDir: string): () => void {
	const sourceDir = state.dir;
	const destinationKey = path.resolve(destinationDir);
	const existing = artifactBindings.get(destinationKey);
	if (existing && existing.state !== state) {
		throw new Error(`Artifact relocation destination already has a live manager: ${destinationKey}`);
	}
	const destinationBinding = existing ?? { state };
	destinationBinding.state = state;
	artifactBindings.set(destinationKey, destinationBinding);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		if (destinationBinding.state === state && state.dir !== destinationKey) {
			destinationBinding.state = createArtifactState(destinationKey);
		}
		if (!artifactBindings.has(sourceDir)) artifactBindings.set(sourceDir, { state });
	};
}

function commitRelocationBinding(
	state: ArtifactDirectoryState,
	sourceDir: string,
	destinationDir: string,
	destinationExists: boolean,
): void {
	const sourceKey = path.resolve(sourceDir);
	const destinationKey = path.resolve(destinationDir);
	if (artifactBindings.get(sourceKey)?.state === state) artifactBindings.delete(sourceKey);
	const destinationBinding = artifactBindings.get(destinationKey) ?? { state };
	destinationBinding.state = state;
	artifactBindings.set(destinationKey, destinationBinding);
	state.dir = destinationKey;
	state.dirCreated = destinationExists;
}

/**
 * Persist an artifact only when the filesystem confirms the complete payload is
 * readable, then swap it into place atomically.
 *
 * Content is staged to a temporary sibling and verified (byte count, on-disk
 * size, readability) before an atomic `rename` publishes it. `agent://<id>`
 * discovers `${id}.md` by scanning the artifacts directory rather than reading
 * `result.outputPath`, so a direct in-place write that fell short would leave a
 * truncated file resolvable as incomplete output and a failed follow-up write
 * would destroy the prior valid artifact. Staging keeps both hazards out: on
 * any failure the temp file is removed and the existing artifact at `path` is
 * untouched.
 *
 * Returns the verified UTF-8 byte count.
 */
export async function writeArtifact(path: string, content: string): Promise<number> {
	const expectedBytes = Buffer.byteLength(content);
	const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
	try {
		const writtenBytes = await Bun.write(tempPath, content);
		if (writtenBytes !== expectedBytes) {
			throw new Error(`Artifact write incomplete: wrote ${writtenBytes} of ${expectedBytes} bytes`);
		}
		const file = Bun.file(tempPath);
		if (file.size !== expectedBytes) {
			throw new Error(`Artifact size mismatch: found ${file.size} of ${expectedBytes} bytes`);
		}
		await file.slice(0, Math.min(expectedBytes, 1)).arrayBuffer();
		await replaceFileAtomically(tempPath, path);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		throw error;
	}
	return expectedBytes;
}

/**
 * Manages artifact storage for a session.
 *
 * Artifacts are stored with sequential IDs in the session's artifact directory.
 * The directory is created lazily on first write.
 *
 * Subagents do not own their own `ArtifactManager`. The parent's instance is
 * adopted via `SessionManager.adoptArtifactManager`, so the whole parent +
 * subagent tree shares one ID space and one directory.
 */
export class ArtifactManager {
	readonly #binding: ArtifactDirectoryBinding;

	get #state(): ArtifactDirectoryState {
		return this.#binding.state;
	}

	/** @param dir Directory that will hold artifact files. Created lazily on first save. */
	constructor(dir: string) {
		this.#binding = artifactBindingFor(dir);
	}

	/** Artifact directory path. Directory may not exist until first artifact use. */
	get dir(): string {
		return this.#state.dir;
	}

	async #withOperation<T>(operation: () => Promise<T>): Promise<T> {
		const state = this.#state;
		const predecessor = state.operationTail;
		const turn = Promise.withResolvers<void>();
		state.operationTail = predecessor.catch(() => undefined).then(() => turn.promise);
		await predecessor.catch(() => undefined);
		try {
			return await operation();
		} finally {
			turn.resolve();
		}
	}

	#createWriterLease(
		id: string,
		artifactPath: string,
		handle: FileHandle,
		reservation: ArtifactReservation,
	): ReservedArtifactWriterLease {
		const state = this.#state;
		const settled = Promise.withResolvers<void>();
		state.writerLeases.add(settled.promise);
		let released = false;
		return {
			id,
			path: artifactPath,
			reservation,
			settled: settled.promise,
			write: async content => {
				const expectedBytes = Buffer.byteLength(content);
				await handle.writeFile(content);
				const { size } = await handle.stat();
				if (size !== expectedBytes) {
					throw new Error(`Artifact size mismatch: found ${size} of ${expectedBytes} bytes`);
				}
				await Bun.file(artifactPath).slice(0, Math.min(expectedBytes, 1)).arrayBuffer();
			},
			release: () => {
				if (released) return;
				released = true;
				void handle
					.close()
					.catch(() => undefined)
					.finally(() => {
						state.writerLeases.delete(settled.promise);
						settled.resolve();
					});
			},
		};
	}

	async #waitForWriters(): Promise<void> {
		while (this.#state.writerLeases.size > 0) {
			await Promise.all(this.#state.writerLeases);
		}
	}

	async #outsideTransactionOperation<T>(operation: () => Promise<T>): Promise<T> {
		while (true) {
			const active = this.#state.activeTransaction;
			if (active) {
				await active.settled;
				continue;
			}
			const result = await this.#withOperation<T | typeof TRANSACTION_BLOCKED>(async () => {
				if (this.#state.activeTransaction) return TRANSACTION_BLOCKED;
				return operation();
			});
			if (result !== TRANSACTION_BLOCKED) return result as T;
		}
	}

	async #transactionOperation<T>(token: symbol, operation: () => Promise<T>): Promise<T> {
		return this.#withOperation(async () => {
			if (this.#state.activeTransaction?.token !== token) {
				throw new Error("Artifact transaction is no longer active");
			}
			return operation();
		});
	}

	async #ensureDir(): Promise<void> {
		const state = this.#state;
		if (!state.dirCreated) {
			await fs.mkdir(state.dir, { recursive: true });
			state.dirCreated = true;
		}
		state.initPromise ??= this.#scanExistingIds();
		await state.initPromise;
	}

	async #listArtifactFiles(): Promise<string[]> {
		try {
			const entries = await fs.readdir(this.#state.dir, { withFileTypes: true });
			return entries
				.filter(entry => entry.isFile() && ARTIFACT_FILE_PATTERN.test(entry.name))
				.map(entry => entry.name);
		} catch (error) {
			if (hasCode(error, "ENOENT")) return [];
			throw error;
		}
	}

	async #scanExistingIds(): Promise<void> {
		const entries = await fs.readdir(this.#state.dir);
		let maxId = -1;
		for (const entry of entries) {
			const matchedId = entry.match(/^(\d+)\..*\.log$/)?.[1] ?? entry.match(ARTIFACT_ID_RESERVATION_PATTERN)?.[1];
			if (matchedId !== undefined) maxId = Math.max(maxId, Number.parseInt(matchedId, 10));
		}
		this.#state.nextId = Math.max(this.#state.nextId, maxId + 1);
	}

	async #directoryExists(): Promise<boolean> {
		try {
			return (await fs.stat(this.#state.dir)).isDirectory();
		} catch (error) {
			if (hasCode(error, "ENOENT")) return false;
			throw error;
		}
	}

	async #captureTransactionSnapshot(): Promise<ArtifactTransactionSnapshot> {
		const dirExisted = await this.#directoryExists();
		if (dirExisted) await this.#ensureDir();
		return { dirExisted, nextId: this.#state.nextId };
	}

	async #removeOwnedPath(ownedPath: OwnedArtifactPath): Promise<boolean> {
		const targetPath = path.join(this.#state.dir, ownedPath.filename);
		let stat: Stats;
		try {
			stat = await fs.lstat(targetPath);
		} catch (error) {
			if (hasCode(error, "ENOENT")) return false;
			throw error;
		}
		if (stat.dev !== ownedPath.dev || stat.ino !== ownedPath.ino) return false;
		await fs.unlink(targetPath);
		return true;
	}

	async #removeOwnedReservation(reservation: ArtifactReservation): Promise<void> {
		if (await this.#removeOwnedPath(reservation)) {
			await this.#removeOwnedPath(reservation.idReservation);
		}
	}

	async #restoreTransactionSnapshot(
		snapshot: ArtifactTransactionSnapshot,
		createdFiles: ReadonlyMap<string, ArtifactReservation>,
	): Promise<void> {
		await this.#waitForWriters();
		for (const reservation of createdFiles.values()) await this.#removeOwnedReservation(reservation);

		const state = this.#state;
		if (!snapshot.dirExisted) {
			try {
				await fs.rmdir(state.dir);
				state.dirCreated = false;
				state.initPromise = null;
				state.nextId = snapshot.nextId;
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					state.dirCreated = false;
					state.initPromise = null;
					state.nextId = snapshot.nextId;
					return;
				}
				if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
			}
		}

		state.nextId = snapshot.nextId;
		state.dirCreated = true;
		state.initPromise = this.#scanExistingIds();
		await state.initPromise;
	}

	/** Serialize transaction acquisition, drain writers, and fence new source mutations. */
	async #acquireTransactionFence(): Promise<ArtifactTransactionFence> {
		const state = this.#state;
		const predecessor = state.transactionTail;
		const turn = Promise.withResolvers<void>();
		state.transactionTail = predecessor.catch(() => undefined).then(() => turn.promise);
		await predecessor.catch(() => undefined);

		const token = Symbol("artifactTransaction");
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			if (state.activeTransaction?.token === token) state.activeTransaction = null;
			turn.resolve();
		};
		try {
			while (true) {
				await this.#waitForWriters();
				const acquired = await this.#withOperation(async () => {
					if (state.writerLeases.size > 0) return false;
					state.activeTransaction = { token, settled: turn.promise };
					return true;
				});
				if (acquired) return { token, release };
			}
		} catch (error) {
			release();
			throw error;
		}
	}

	/** Fence an in-place session mutation and remove only transaction-owned reservations on rollback. */
	async beginTransaction(): Promise<ArtifactManagerTransaction> {
		const fence = await this.#acquireTransactionFence();
		let snapshot: ArtifactTransactionSnapshot;
		try {
			snapshot = await this.#captureTransactionSnapshot();
		} catch (error) {
			fence.release();
			throw error;
		}

		let closed = false;
		let rollingBack = false;
		let rollbackPromise: Promise<void> | undefined;
		const createdFiles = new Map<string, ArtifactReservation>();
		return {
			allocatePath: toolType => {
				if (closed || rollingBack) throw new Error("Artifact transaction is no longer writable");
				return this.#transactionOperation(fence.token, async () => {
					const allocation = await this.#allocatePath(toolType);
					createdFiles.set(allocation.reservation.filename, allocation.reservation);
					return allocation;
				});
			},
			save: (content, toolType) => {
				if (closed || rollingBack) throw new Error("Artifact transaction is no longer writable");
				return this.#transactionOperation(fence.token, async () => {
					const allocation = await this.#allocatePath(toolType);
					createdFiles.set(allocation.reservation.filename, allocation.reservation);
					try {
						await allocation.write(content);
						return allocation.id;
					} catch (error) {
						allocation.release();
						await allocation.settled;
						await this.#removeOwnedReservation(allocation.reservation).catch(() => undefined);
						throw error;
					} finally {
						allocation.release();
						await allocation.settled;
					}
				});
			},
			commit: async () => {
				if (closed) return;
				if (rollbackPromise) await rollbackPromise;
				if (closed) return;
				closed = true;
				fence.release();
			},
			rollback: () => {
				if (rollbackPromise) return rollbackPromise;
				if (closed) return Promise.resolve();
				rollingBack = true;
				rollbackPromise = this.#withOperation(() => this.#restoreTransactionSnapshot(snapshot, createdFiles)).catch(
					error => {
						closed = true;
						fence.release();
						throw error;
					},
				);
				return rollbackPromise;
			},
		};
	}

	/** Fence and clone the complete durable artifact graph into a future session directory. */
	async beginCloneTransaction(additionalFileNames: readonly string[] = []): Promise<ArtifactCloneTransaction> {
		const additionalFiles = new Set(additionalFileNames);
		for (const filename of additionalFiles) {
			if (filename === "." || filename === ".." || path.basename(filename) !== filename) {
				throw new Error(`Artifact clone companion file must be a basename: ${filename}`);
			}
		}
		const sourceFence = await this.#acquireTransactionFence();
		let destinationDir: string | undefined;
		let publication: ArtifactPublication | undefined;
		let publishAttempted = false;
		let publishPromise: Promise<void> | undefined;
		let commitPromise: Promise<void> | undefined;
		let rollbackPromise: Promise<void> | undefined;
		let closed = false;

		return {
			publish: requestedDestinationDir => {
				const nextDestinationDir = path.resolve(requestedDestinationDir);
				if (destinationDir && destinationDir !== nextDestinationDir) {
					throw new Error("Artifact clone transaction already targets a different directory");
				}
				if (publishPromise) return publishPromise;
				if (closed || rollbackPromise) throw new Error("Artifact clone transaction is no longer active");
				destinationDir = nextDestinationDir;
				publishAttempted = true;
				publishPromise = publishArtifactGraph("clone", this.#state.dir, nextDestinationDir, additionalFiles).then(
					result => {
						publication = result;
					},
				);
				return publishPromise;
			},
			commit: () => {
				if (closed) return Promise.resolve();
				if (commitPromise) return commitPromise;
				if (rollbackPromise) return rollbackPromise;
				if (!publishAttempted) return Promise.reject(new Error("Artifact clone transaction was not published"));
				commitPromise = (async () => {
					await publishPromise;
					if (rollbackPromise) return rollbackPromise;
					await commitClonePublication(publication);
					closed = true;
					sourceFence.release();
				})();
				return commitPromise;
			},
			rollback: () => {
				if (rollbackPromise) return rollbackPromise;
				if (closed) return Promise.resolve();
				rollbackPromise = (async () => {
					await publishPromise?.catch(() => undefined);
					try {
						if (publication) await rollbackArtifactPublication(publication);
					} finally {
						closed = true;
						sourceFence.release();
					}
				})();
				return rollbackPromise;
			},
		};
	}

	/**
	 * Fence all managers bound to this directory, drain their writer leases, and
	 * publish a destination snapshot before the caller moves the journal.
	 */
	async beginRelocation(destinationDir: string): Promise<ArtifactRelocationTransaction> {
		const sourceDir = path.resolve(this.#state.dir);
		const destinationKey = path.resolve(destinationDir);
		if (sourceDir === destinationKey) {
			return { commit: () => Promise.resolve(), rollback: () => Promise.resolve() };
		}
		const fence = await this.#acquireTransactionFence();
		let releaseDestinationReservation: (() => void) | undefined;
		let publication: ArtifactPublication | undefined;
		try {
			releaseDestinationReservation = reserveRelocationDestination(this.#state, destinationKey);
			publication = await publishArtifactGraph("relocate", sourceDir, destinationKey, new Set());
		} catch (error) {
			releaseDestinationReservation?.();
			fence.release();
			throw error;
		}

		let closed = false;
		let commitPromise: Promise<void> | undefined;
		let rollbackPromise: Promise<void> | undefined;
		return {
			commit: () => {
				if (closed) return Promise.resolve();
				if (commitPromise) return commitPromise;
				if (rollbackPromise) return rollbackPromise;
				commitPromise = (async () => {
					commitRelocationBinding(this.#state, sourceDir, destinationKey, publication !== undefined);
					closed = true;
					fence.release();
					await commitRelocationPublication(publication, sourceDir);
				})();
				return commitPromise;
			},
			rollback: () => {
				if (rollbackPromise) return rollbackPromise;
				if (closed) return Promise.resolve();
				rollbackPromise = (async () => {
					try {
						if (publication) await rollbackArtifactPublication(publication);
					} finally {
						releaseDestinationReservation?.();
						closed = true;
						fence.release();
					}
				})();
				return rollbackPromise;
			},
		};
	}

	async #allocatePath(toolType: string): Promise<ReservedArtifactWriterLease> {
		await this.#ensureDir();
		const state = this.#state;
		while (true) {
			const id = String(state.nextId++);
			const idFilename = `.omp-artifact-id-${id}`;
			const idPath = path.join(state.dir, idFilename);
			let idHandle: FileHandle;
			try {
				idHandle = await fs.open(idPath, "wx", 0o600);
			} catch (error) {
				if (hasCode(error, "EEXIST")) continue;
				if (hasCode(error, "ENOENT")) {
					state.dirCreated = false;
					state.initPromise = null;
					await this.#ensureDir();
					continue;
				}
				throw error;
			}

			let idStat: Stats;
			try {
				idStat = await idHandle.stat();
			} catch (error) {
				await idHandle.close().catch(() => undefined);
				throw error;
			}
			const idReservation = { filename: idFilename, dev: idStat.dev, ino: idStat.ino };
			try {
				await idHandle.close();
			} catch (error) {
				await this.#removeOwnedPath(idReservation).catch(() => undefined);
				throw error;
			}

			const filename = `${id}.${sanitizeToolType(toolType)}.log`;
			const artifactPath = path.join(state.dir, filename);
			let handle: FileHandle;
			try {
				handle = await fs.open(artifactPath, "wx", 0o600);
			} catch (error) {
				if (hasCode(error, "EEXIST")) continue;
				await this.#removeOwnedPath(idReservation).catch(() => undefined);
				if (hasCode(error, "ENOENT")) {
					state.dirCreated = false;
					state.initPromise = null;
					await this.#ensureDir();
					continue;
				}
				throw error;
			}
			try {
				const stat = await handle.stat();
				const reservation = { filename, dev: stat.dev, ino: stat.ino, idReservation };
				return this.#createWriterLease(id, artifactPath, handle, reservation);
			} catch (error) {
				await handle.close().catch(() => undefined);
				throw error;
			}
		}
	}

	/** Allocate and atomically reserve a new artifact path and ID without writing content. */
	async allocatePath(toolType: string): Promise<ArtifactWriterLease> {
		return this.#outsideTransactionOperation(() => this.#allocatePath(toolType));
	}

	/** Save content as an artifact and return its numeric ID. */
	async save(content: string, toolType: string): Promise<string> {
		return this.#outsideTransactionOperation(async () => {
			const allocation = await this.#allocatePath(toolType);
			try {
				await allocation.write(content);
				return allocation.id;
			} catch (error) {
				allocation.release();
				await allocation.settled;
				await this.#removeOwnedReservation(allocation.reservation).catch(() => undefined);
				throw error;
			} finally {
				allocation.release();
				await allocation.settled;
			}
		});
	}

	/** Check if an artifact exists. */
	async exists(id: string): Promise<boolean> {
		const files = await this.listFiles();
		return files.some(file => file.startsWith(`${id}.`));
	}

	/** List numeric artifact files, or an empty list when the directory is absent. */
	async listFiles(): Promise<string[]> {
		return this.#listArtifactFiles();
	}

	/** Resolve an artifact ID to its full path. */
	async getPath(id: string): Promise<string | null> {
		const files = await this.listFiles();
		const match = files.find(file => file.startsWith(`${id}.`));
		return match ? path.join(this.#state.dir, match) : null;
	}
}
