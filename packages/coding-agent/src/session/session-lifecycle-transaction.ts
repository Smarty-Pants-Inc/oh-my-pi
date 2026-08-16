import { logger } from "@oh-my-pi/pi-utils";
import type {
	RetainedSessionTransitionCheckpoint,
	SessionLifecycleCommitOptions,
	SessionLifecycleOwnership,
} from "./session-lifecycle-owner";

export type SessionLifecyclePhase =
	| "fenced"
	| "checkpointing"
	| "checkpointed"
	| "recapturing"
	| "ownership-acquiring"
	| "ownership-acquired"
	| "target-marked"
	| "commit-preparing"
	| "commit-selecting"
	| "commit-sealing"
	| "commit-selected"
	| "commit-finalizing"
	| "commit-activating"
	| "committed"
	| "rollback-preparing"
	| "rollback-cleaning-target"
	| "rollback-restoring-retained"
	| "rollback-releasing-cleanup"
	| "rollback-selecting"
	| "rollback-selected"
	| "rollback-publishing"
	| "rollback-activating"
	| "rolled-back";

export type SessionLifecyclePostHostContinuation = () => void | Promise<void>;

type LifecycleOperation = {
	name: string;
	run: () => void | Promise<void>;
};

export interface SessionLifecycleTransactionHost {
	captureRetainedCheckpoint(options?: {
		capturePersistedSessionFile?: boolean;
	}): Promise<RetainedSessionTransitionCheckpoint>;
	beginOwnership(): SessionLifecycleOwnership;
	activateFence(): void | Promise<void>;
	publishRollback?(postHostContinuation: SessionLifecyclePostHostContinuation): Promise<void>;
}

export interface SessionLifecycleRollbackOptions {
	cause: unknown;
	message: string;
	cleanupReplacement?: boolean;
	reconcileMode?: boolean;
	preserveNewerRetainedMutations?: boolean;
	includeCauseInAggregate?: boolean;
}

export interface SessionLifecycleResource {
	/** Reversible preparation completed before host publication. */
	seal?: () => void | Promise<void>;
	/** Irreversible completion attempted once after host acknowledgement. */
	finalize?: () => void | Promise<void>;
	/** Remove provisional mutations after rejection. */
	rollback?: () => void | Promise<void>;
	/** Release the resource fence after rollback cleanup. */
	release?: () => void | Promise<void>;
}

/**
 * Owns one destructive session transition from the first retained snapshot
 * through exactly one post-publication activation and fence release.
 */
export class SessionLifecycleTransaction {
	#phase: SessionLifecyclePhase = "fenced";
	#checkpoint: RetainedSessionTransitionCheckpoint | undefined;
	#checkpointIncludesPersistedFile = false;
	readonly #ownership: SessionLifecycleOwnership;
	#publicationStarted = false;
	#released = false;
	#commitSeals: LifecycleOperation[] = [];
	#targetCleanups: LifecycleOperation[] = [];
	#commitFinalizers: LifecycleOperation[] = [];
	#rollbackReleases: LifecycleOperation[] = [];
	readonly #host: SessionLifecycleTransactionHost;
	readonly #settlement = Promise.withResolvers<void>();
	#commitActivation: Promise<void> | undefined;

	constructor(host: SessionLifecycleTransactionHost) {
		this.#host = host;
		this.#ownership = host.beginOwnership();
	}

	get phase(): SessionLifecyclePhase {
		return this.#phase;
	}

	get settled(): Promise<void> {
		return this.#settlement.promise;
	}

	async captureRetained(options: { capturePersistedSessionFile?: boolean } = {}): Promise<void> {
		if (this.#phase !== "fenced")
			throw new Error(`Lifecycle retained capture cannot start from phase ${this.#phase}`);
		this.#phase = "checkpointing";
		try {
			await this.#ownership.ready();
			if (options.capturePersistedSessionFile) await this.#ownership.quarantineBash();
			const checkpoint = await this.#host.captureRetainedCheckpoint(options);
			this.#checkpoint = checkpoint;
			this.#checkpointIncludesPersistedFile = options.capturePersistedSessionFile === true;
			this.#phase = "checkpointed";
		} catch (error) {
			this.#phase = "fenced";
			throw error;
		}
	}

	/** Refresh the retained checkpoint after quiescence without permitting an accidental duplicate first capture. */
	async recaptureRetained(options: { capturePersistedSessionFile?: boolean } = {}): Promise<void> {
		if (this.#phase !== "checkpointed") {
			throw new Error(`Lifecycle retained recapture cannot start from phase ${this.#phase}`);
		}
		this.#phase = "recapturing";
		try {
			if (this.#checkpoint?.recapture) await this.#checkpoint.recapture(options);
			else this.#checkpoint = await this.#host.captureRetainedCheckpoint(options);
			this.#checkpointIncludesPersistedFile = options.capturePersistedSessionFile === true;
		} catch (error) {
			this.#phase = "checkpointed";
			throw error;
		}
		this.#phase = "checkpointed";
	}

	async acquireOwnership(): Promise<void> {
		if (this.#phase !== "checkpointed")
			throw new Error(`Lifecycle ownership cannot be acquired from phase ${this.#phase}`);
		this.#phase = "ownership-acquiring";
		try {
			await this.#ownership.acquire();
		} catch (error) {
			this.#phase = "checkpointed";
			throw error;
		}
		this.#phase = "ownership-acquired";
	}

	markTarget(): void {
		if (this.#phase !== "ownership-acquired")
			throw new Error(`Lifecycle target cannot be marked from phase ${this.#phase}`);
		this.#ownership.markTarget();
		this.#phase = "target-marked";
	}

	/** Host quiescence has begun; every later failure owns authoritative rollback publication. */
	markPublicationStarted(): void {
		if (this.#publicationStarted) throw new Error("Lifecycle publication already started");
		if (
			this.#phase !== "fenced" &&
			this.#phase !== "checkpointed" &&
			this.#phase !== "ownership-acquired" &&
			this.#phase !== "target-marked"
		) {
			throw new Error(`Lifecycle publication cannot start from phase ${this.#phase}`);
		}
		this.#publicationStarted = true;
	}

	addCommitSeal(name: string, run: () => void | Promise<void>): void {
		this.#commitSeals.push({ name, run });
	}

	addTargetCleanup(name: string, run: () => void | Promise<void>): void {
		this.#targetCleanups.push({ name, run });
	}

	addRollbackRelease(name: string, run: () => void | Promise<void>): void {
		this.#rollbackReleases.push({ name, run });
	}

	/** Register every phase of one resource in a single synchronous operation. */
	bindResource(name: string, resource: SessionLifecycleResource): void {
		if (resource.seal) this.#commitSeals.push({ name, run: resource.seal });
		if (resource.finalize) this.#commitFinalizers.push({ name, run: resource.finalize });
		if (resource.rollback) this.#targetCleanups.push({ name, run: resource.rollback });
		if (resource.release) this.#rollbackReleases.push({ name, run: resource.release });
	}

	/**
	 * Runs after ordinary extension handlers but before host afterDispatch. The
	 * returned continuation irreversibly finalizes resources, activates delivery,
	 * and releases the lifecycle fence only after publication is acknowledged.
	 */
	async prepareCommit(options?: SessionLifecycleCommitOptions): Promise<SessionLifecyclePostHostContinuation> {
		if (this.#phase !== "target-marked") throw new Error(`Lifecycle commit cannot prepare from phase ${this.#phase}`);
		const ownership = this.#ownership;
		this.#phase = "commit-preparing";
		await ownership.prepareCommit();
		this.#phase = "commit-selecting";
		// Every required owner selection is attempted while artifact preimages and
		// retained runtime state are still rollback-capable. Only a complete
		// selection may seal the durable target before host publication.
		await ownership.selectCommit(options);
		this.#phase = "commit-sealing";
		for (const operation of this.#commitSeals) await operation.run();
		this.#phase = "commit-selected";
		return () => this.#activateCommit();
	}

	async commit(options?: SessionLifecycleCommitOptions): Promise<void> {
		const activate = await this.prepareCommit(options);
		await activate();
	}

	/** Confirm commit activation after the host publication barrier has returned. */
	async activateCommitAfterHostPublication(): Promise<void> {
		if (this.#phase === "committed") return;
		if (
			this.#phase !== "commit-selected" &&
			this.#phase !== "commit-finalizing" &&
			this.#phase !== "commit-activating"
		) {
			throw new Error(`Lifecycle commit cannot activate from phase ${this.#phase}`);
		}
		await this.#activateCommit();
	}

	async rollback(options: SessionLifecycleRollbackOptions): Promise<void> {
		const failures: unknown[] = [];
		const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
			try {
				await operation();
			} catch (error) {
				failures.push(error);
			}
		};

		this.#phase = "rollback-preparing";
		await attempt(() => this.#ownership.prepareRollback());

		this.#phase = "rollback-cleaning-target";
		for (const operation of this.#targetCleanups) await attempt(operation.run);

		this.#phase = "rollback-restoring-retained";
		if (this.#checkpoint) {
			await attempt(() =>
				this.#checkpoint!.restore({
					cleanupReplacement: options.cleanupReplacement,
					reconcileMode: options.reconcileMode,
					preserveNewerRetainedMutations: options.preserveNewerRetainedMutations,
					rewriteRetainedEntries: this.#checkpointIncludesPersistedFile,
				}),
			);
		}

		this.#phase = "rollback-releasing-cleanup";
		for (const operation of this.#rollbackReleases) await attempt(operation.run);

		this.#phase = "rollback-selecting";
		await attempt(() => this.#ownership.selectRollback());
		this.#phase = "rollback-selected";

		const activate = () => this.#activateRollback();
		if (this.#publicationStarted && failures.length === 0 && this.#host.publishRollback) {
			this.#phase = "rollback-publishing";
			try {
				await this.#host.publishRollback(activate);
				await activate();
			} catch (error) {
				failures.push(error);
				await activate();
			}
		} else {
			await activate();
		}

		if (failures.length > 0) {
			throw new AggregateError(
				options.includeCauseInAggregate === false ? failures : [options.cause, ...failures],
				options.message,
			);
		}
	}

	async #activateCommit(): Promise<void> {
		this.#commitActivation ??= this.#activateCommitOnce();
		await this.#commitActivation;
	}

	async #activateCommitOnce(): Promise<void> {
		if (this.#released) return;
		this.#phase = "commit-finalizing";
		for (const operation of this.#commitFinalizers) {
			try {
				await operation.run();
			} catch (error) {
				logger.error("Lifecycle resource finalization failed after host publication", {
					resource: operation.name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		this.#phase = "commit-activating";
		try {
			await this.#ownership.activateCommit();
		} catch (error) {
			logger.error("Lifecycle commit activation failed after host publication", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		await this.#releaseFence();
		this.#phase = "committed";
	}

	async #activateRollback(): Promise<void> {
		if (this.#released) return;
		this.#phase = "rollback-activating";
		try {
			await this.#ownership.activateRollback();
		} catch (error) {
			logger.error("Lifecycle rollback activation failed after host publication", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		await this.#releaseFence();
		this.#phase = "rolled-back";
	}

	async #releaseFence(): Promise<void> {
		if (this.#released) return;
		this.#released = true;
		try {
			await this.#host.activateFence();
		} catch (error) {
			logger.error("Lifecycle fence release failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.#settlement.resolve();
		}
	}
}
