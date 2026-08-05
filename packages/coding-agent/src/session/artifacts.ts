/**
 * Session-scoped artifact storage for truncated tool outputs.
 *
 * Artifacts are stored in a directory alongside the session file,
 * accessible via artifact:// URLs.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Sanitize a tool name for safe use as the middle segment of the artifact
 * filename (`${id}.${toolType}.log`). Built-in tool names are fixed, but MCP,
 * extension, and RPC-host tool names are arbitrary and may contain path
 * separators (`/`, `\`) or traversal sequences (`..`) that would otherwise let
 * a spilled artifact escape the artifacts directory. Collapse everything
 * outside `[A-Za-z0-9_-]` to `_`, and cap the length so an arbitrarily long
 * name cannot overflow the filesystem's filename limit (ENAMETOOLONG). Fall
 * back to `tool` when nothing survives.
 */
function sanitizeToolType(toolType: string): string {
	const sanitized = toolType
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.slice(0, 64)
		.replace(/^_+|_+$/g, "");
	return sanitized.length > 0 ? sanitized : "tool";
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
const ARTIFACT_FILE_PATTERN = /^\d+\..*\.log$/;
const TRANSACTION_BLOCKED = Symbol("artifactTransactionBlocked");

function logSealedPreimageCleanupFailure(error: unknown): void {
	const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
	try {
		logger.warn("Failed to remove sealed artifact transaction preimage", {
			errorName: error instanceof Error ? error.name : typeof error,
			errorCode: typeof errorCode === "string" ? errorCode : undefined,
		});
	} catch {}
}

interface ArtifactTransactionSnapshot {
	dirExisted: boolean;
	nextId: number;
	files: Set<string>;
	preimageDir: string;
}

/** A bounded snapshot of one manager's allocator and durable artifact files. */
export interface ArtifactTransaction {
	/** Release the mutation fence after success or after rollback publication. */
	commit(): Promise<void>;
	/** Restore the snapshot while retaining the fence until commit(). */
	rollback(): Promise<void>;
}

/** A read-only source fence that can atomically publish a copy into a new session directory. */
export interface ArtifactCloneTransaction {
	/** Stage the numeric artifact store beside and atomically rename it to destinationDir. */
	publish(destinationDir: string): Promise<void>;
	/** Keep the published destination and release the source fence. */
	commit(): Promise<void>;
	/** Remove clone output and release the source fence. */
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

export class ArtifactManager {
	#nextId = 0;
	readonly #dir: string;
	#dirCreated = false;
	#initPromise: Promise<void> | null = null;
	#operationTail: Promise<void> = Promise.resolve();
	#transactionTail: Promise<void> = Promise.resolve();
	#activeTransaction: ActiveArtifactTransaction | null = null;
	#writerLeases = new Set<Promise<void>>();

	/**
	 * @param dir Directory that will hold artifact files. Created lazily on first save.
	 */
	constructor(dir: string) {
		this.#dir = dir;
	}

	/**
	 * Artifact directory path.
	 * Directory may not exist until first artifact is saved.
	 */
	get dir(): string {
		return this.#dir;
	}

	async #withOperation<T>(operation: () => Promise<T>): Promise<T> {
		const predecessor = this.#operationTail;
		const turn = Promise.withResolvers<void>();
		this.#operationTail = predecessor.catch(() => undefined).then(() => turn.promise);
		await predecessor.catch(() => undefined);
		try {
			return await operation();
		} finally {
			turn.resolve();
		}
	}

	#createWriterLease(id: string, artifactPath: string): ArtifactWriterLease {
		const settled = Promise.withResolvers<void>();
		this.#writerLeases.add(settled.promise);
		let released = false;
		return {
			id,
			path: artifactPath,
			release: () => {
				if (released) return;
				released = true;
				this.#writerLeases.delete(settled.promise);
				settled.resolve();
			},
		};
	}

	async #waitForWriters(): Promise<void> {
		while (this.#writerLeases.size > 0) {
			await Promise.all(this.#writerLeases);
		}
	}

	async #outsideTransactionOperation<T>(operation: () => Promise<T>): Promise<T> {
		while (true) {
			const active = this.#activeTransaction;
			if (active) {
				await active.settled;
				continue;
			}
			const result = await this.#withOperation<T | typeof TRANSACTION_BLOCKED>(async () => {
				if (this.#activeTransaction) return TRANSACTION_BLOCKED;
				return operation();
			});
			if (result !== TRANSACTION_BLOCKED) return result as T;
		}
	}

	async #transactionOperation<T>(token: symbol, operation: () => Promise<T>): Promise<T> {
		return this.#withOperation(async () => {
			if (this.#activeTransaction?.token !== token) {
				throw new Error("Artifact transaction is no longer active");
			}
			return operation();
		});
	}

	async #ensureDir(): Promise<void> {
		if (!this.#dirCreated) {
			await fs.mkdir(this.#dir, { recursive: true });
			this.#dirCreated = true;
		}
		// Memoize the first-use scan so it runs exactly once. Concurrent callers
		// share the in-flight promise instead of each re-seeding #nextId across
		// the readdir yield in #scanExistingIds (which would hand duplicate ids).
		this.#initPromise ??= this.#scanExistingIds();
		await this.#initPromise;
	}

	async #listArtifactFiles(): Promise<string[]> {
		try {
			const entries = await fs.readdir(this.#dir, { withFileTypes: true });
			return entries
				.filter(entry => entry.isFile() && ARTIFACT_FILE_PATTERN.test(entry.name))
				.map(entry => entry.name);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	/**
	 * Scan existing artifact files to find the next available ID.
	 * This ensures we don't overwrite artifacts when resuming a session.
	 */
	async #scanExistingIds(): Promise<void> {
		const files = await this.#listArtifactFiles();
		let maxId = -1;
		for (const file of files) {
			// Files are named: {id}.{toolType}.log
			const match = file.match(/^(\d+)\..*\.log$/);
			if (match) {
				const id = parseInt(match[1], 10);
				if (id > maxId) maxId = id;
			}
		}
		this.#nextId = maxId + 1;
	}

	async #directoryExists(): Promise<boolean> {
		try {
			return (await fs.stat(this.#dir)).isDirectory();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	async #captureTransactionSnapshot(): Promise<ArtifactTransactionSnapshot> {
		const dirExisted = await this.#directoryExists();
		if (dirExisted) await this.#ensureDir();
		const preimageDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-artifact-transaction-"));
		try {
			const files = new Set(await this.#listArtifactFiles());
			for (const filename of files) {
				await fs.copyFile(path.join(this.#dir, filename), path.join(preimageDir, filename));
			}
			return { dirExisted, nextId: this.#nextId, files, preimageDir };
		} catch (error) {
			await fs.rm(preimageDir, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
	}

	async #discardTransactionSnapshot(snapshot: ArtifactTransactionSnapshot): Promise<void> {
		await fs.rm(snapshot.preimageDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
	}

	async #restoreTransactionSnapshot(snapshot: ArtifactTransactionSnapshot): Promise<void> {
		await this.#waitForWriters();
		await fs.mkdir(this.#dir, { recursive: true });
		const currentEntries = await fs.readdir(this.#dir, { withFileTypes: true });
		for (const entry of currentEntries) {
			if (ARTIFACT_FILE_PATTERN.test(entry.name)) {
				await fs.rm(path.join(this.#dir, entry.name), { recursive: true, force: true });
			}
		}
		for (const filename of snapshot.files) {
			await fs.copyFile(path.join(snapshot.preimageDir, filename), path.join(this.#dir, filename));
		}

		this.#nextId = snapshot.nextId;
		this.#dirCreated = true;
		this.#initPromise = Promise.resolve();
		if (!snapshot.dirExisted) {
			try {
				await fs.rmdir(this.#dir);
				this.#dirCreated = false;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
				this.#dirCreated = code !== "ENOENT";
			}
		}
	}

	/** Serialize transaction acquisition, drain writers, and fence new source mutations. */
	async #acquireTransactionFence(): Promise<ArtifactTransactionFence> {
		const predecessor = this.#transactionTail;
		const turn = Promise.withResolvers<void>();
		this.#transactionTail = predecessor.catch(() => undefined).then(() => turn.promise);
		await predecessor.catch(() => undefined);

		const token = Symbol("artifactTransaction");
		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			if (this.#activeTransaction?.token === token) this.#activeTransaction = null;
			turn.resolve();
		};
		try {
			// Drain before fencing so a live writer can finish nested artifact work.
			// The operation lock then closes the zero-writers → fenced race against
			// allocations from every SessionManager sharing this manager.
			while (true) {
				await this.#waitForWriters();
				const acquired = await this.#withOperation(async () => {
					if (this.#writerLeases.size > 0) return false;
					this.#activeTransaction = { token, settled: turn.promise };
					return true;
				});
				if (acquired) return { token, release };
			}
		} catch (error) {
			release();
			throw error;
		}
	}

	/**
	 * Fence an in-place session mutation. Transactions on an adopted/shared
	 * manager serialize with each other and restore the same manager object, so
	 * every owner observes one coherent allocator after rollback.
	 */
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
		let snapshotDiscarded = false;
		let rollbackPromise: Promise<void> | undefined;
		const discardSnapshot = async (): Promise<void> => {
			if (snapshotDiscarded) return;
			await this.#discardTransactionSnapshot(snapshot);
			snapshotDiscarded = true;
		};
		return {
			allocatePath: toolType => {
				if (closed || rollingBack) throw new Error("Artifact transaction is no longer writable");
				return this.#transactionOperation(fence.token, () => this.#allocatePath(toolType));
			},
			save: (content, toolType) => {
				if (closed || rollingBack) throw new Error("Artifact transaction is no longer writable");
				return this.#transactionOperation(fence.token, async () => {
					const allocation = await this.#allocatePath(toolType);
					try {
						await Bun.write(allocation.path, content);
						return allocation.id;
					} finally {
						allocation.release();
					}
				});
			},
			commit: async () => {
				if (closed) return;
				if (rollbackPromise) await rollbackPromise;
				if (closed) return;
				closed = true;
				fence.release();
				try {
					await discardSnapshot();
				} catch (error) {
					logSealedPreimageCleanupFailure(error);
				}
			},
			rollback: () => {
				if (rollbackPromise) return rollbackPromise;
				if (closed) return Promise.resolve();
				rollingBack = true;
				rollbackPromise = this.#withOperation(async () => {
					await this.#restoreTransactionSnapshot(snapshot);
					await discardSnapshot();
				}).catch(error => {
					closed = true;
					fence.release();
					throw error;
				});
				return rollbackPromise;
			},
		};
	}

	/**
	 * Fence this manager and clone its numeric artifact store plus any explicitly
	 * requested top-level companion files into a future session directory. The
	 * source transaction remains rollback-capable until commit, while publication
	 * uses a sibling staging directory so the target becomes visible in one rename.
	 */
	async beginCloneTransaction(additionalFileNames: readonly string[] = []): Promise<ArtifactCloneTransaction> {
		const additionalFiles = new Set(additionalFileNames);
		for (const filename of additionalFiles) {
			if (filename === "." || filename === ".." || path.basename(filename) !== filename) {
				throw new Error(`Artifact clone companion file must be a basename: ${filename}`);
			}
		}
		const sourceFence = await this.#acquireTransactionFence();
		let destinationDir: string | undefined;
		let stagingDir: string | undefined;
		let publishedDir: string | undefined;
		let publishAttempted = false;
		let publishPromise: Promise<void> | undefined;
		let publishSucceeded = false;
		let commitPromise: Promise<void> | undefined;
		let rollbackPromise: Promise<void> | undefined;
		let closed = false;

		return {
			publish: requestedDestinationDir => {
				const resolvedDestinationDir = path.resolve(requestedDestinationDir);
				if (destinationDir && destinationDir !== resolvedDestinationDir) {
					throw new Error("Artifact clone transaction already targets a different directory");
				}
				if (publishPromise) return publishPromise;
				if (closed || rollbackPromise) throw new Error("Artifact clone transaction is no longer active");
				if (resolvedDestinationDir === path.resolve(this.#dir)) {
					throw new Error("Artifact clone destination must differ from its source");
				}

				destinationDir = resolvedDestinationDir;
				publishAttempted = true;
				publishPromise = (async () => {
					try {
						await fs.lstat(resolvedDestinationDir);
						throw Object.assign(
							new Error(`Artifact clone destination already exists: ${resolvedDestinationDir}`),
							{
								code: "EEXIST",
							},
						);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}

					let sourceStat: Awaited<ReturnType<typeof fs.stat>>;
					try {
						sourceStat = await fs.stat(this.#dir);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") {
							if (additionalFiles.size > 0) {
								throw new Error(
									`Artifact clone source is missing requested companion files: ${[...additionalFiles].join(", ")}`,
								);
							}
							publishSucceeded = true;
							return;
						}
						throw error;
					}
					if (!sourceStat.isDirectory()) {
						throw Object.assign(new Error(`Artifact source is not a directory: ${this.#dir}`), {
							code: "ENOTDIR",
						});
					}

					const cloneStagingDir = await fs.mkdtemp(
						path.join(
							path.dirname(resolvedDestinationDir),
							`.${path.basename(resolvedDestinationDir)}.artifact-clone-`,
						),
					);
					stagingDir = cloneStagingDir;
					const entries = await fs.readdir(this.#dir, { withFileTypes: true });
					const files = entries
						.filter(
							entry =>
								entry.isFile() && (ARTIFACT_FILE_PATTERN.test(entry.name) || additionalFiles.has(entry.name)),
						)
						.map(entry => entry.name)
						.sort();
					const missingAdditionalFiles = [...additionalFiles].filter(filename => !files.includes(filename));
					if (missingAdditionalFiles.length > 0) {
						throw new Error(`Artifact clone companion file is missing: ${missingAdditionalFiles.join(", ")}`);
					}
					for (const filename of files) {
						await fs.copyFile(path.join(this.#dir, filename), path.join(cloneStagingDir, filename));
					}
					await fs.rename(cloneStagingDir, resolvedDestinationDir);
					stagingDir = undefined;
					publishedDir = resolvedDestinationDir;
					publishSucceeded = true;
				})();
				return publishPromise;
			},
			commit: () => {
				if (closed) return Promise.resolve();
				if (commitPromise) return commitPromise;
				if (rollbackPromise) return rollbackPromise;
				if (!publishAttempted) return Promise.reject(new Error("Artifact clone transaction was not published"));

				if (publishSucceeded) {
					closed = true;
					sourceFence.release();
					return Promise.resolve();
				}

				commitPromise = (async () => {
					await publishPromise;
					if (rollbackPromise) {
						await rollbackPromise;
						return;
					}
					if (closed) return;
					closed = true;
					sourceFence.release();
				})();
				return commitPromise;
			},
			rollback: () => {
				if (rollbackPromise) return rollbackPromise;
				if (closed) return Promise.resolve();
				rollbackPromise = (async () => {
					const failures: unknown[] = [];
					await publishPromise?.catch(() => undefined);

					for (const cloneDir of [stagingDir, publishedDir]) {
						if (!cloneDir) continue;
						try {
							await fs.rm(cloneDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
						} catch (error) {
							failures.push(error);
						}
					}
					closed = true;
					sourceFence.release();
					if (failures.length > 0) {
						throw new AggregateError(failures, "Artifact clone rollback failed");
					}
				})();
				return rollbackPromise;
			},
		};
	}

	async #allocatePath(toolType: string): Promise<ArtifactWriterLease> {
		await this.#ensureDir();
		const id = String(this.#nextId++);
		const filename = `${id}.${sanitizeToolType(toolType)}.log`;
		return this.#createWriterLease(id, path.join(this.#dir, filename));
	}

	/**
	 * Allocate a new artifact path and ID without writing content.
	 *
	 * @param toolType Tool name for file extension (e.g., "bash", "read")
	 */
	async allocatePath(toolType: string): Promise<ArtifactWriterLease> {
		return this.#outsideTransactionOperation(() => this.#allocatePath(toolType));
	}

	/**
	 * Save content as an artifact and return the artifact ID.
	 *
	 * @param content Full content to save
	 * @param toolType Tool name for file extension (e.g., "bash", "read")
	 * @returns Artifact ID (numeric string)
	 */
	async save(content: string, toolType: string): Promise<string> {
		return this.#outsideTransactionOperation(async () => {
			const allocation = await this.#allocatePath(toolType);
			try {
				await Bun.write(allocation.path, content);
				return allocation.id;
			} finally {
				allocation.release();
			}
		});
	}

	/**
	 * Check if an artifact exists.
	 * @param id Artifact ID (numeric string)
	 */
	async exists(id: string): Promise<boolean> {
		const files = await this.listFiles();
		return files.some(f => f.startsWith(`${id}.`));
	}

	/**
	 * List all artifact files in the directory.
	 * Returns empty array if directory doesn't exist.
	 */
	async listFiles(): Promise<string[]> {
		try {
			return await fs.readdir(this.#dir);
		} catch {
			return [];
		}
	}

	/**
	 * Get the full path to an artifact file.
	 * Returns null if artifact doesn't exist.
	 *
	 * @param id Artifact ID (numeric string)
	 */
	async getPath(id: string): Promise<string | null> {
		const files = await this.listFiles();
		const match = files.find(f => f.startsWith(`${id}.`));
		return match ? path.join(this.#dir, match) : null;
	}
}
