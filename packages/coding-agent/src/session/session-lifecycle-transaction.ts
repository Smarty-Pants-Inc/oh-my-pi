import { logger } from "@oh-my-pi/pi-utils";
import type {
	RetainedSessionTransitionCheckpoint,
	SessionLifecycleCommitOptions,
	SessionLifecycleOwnership,
} from "./session-lifecycle-owner";

export type SessionLifecyclePhase =
	| "fenced"
	| "checkpointed"
	| "ownership-acquired"
	| "target-marked"
	| "commit-preparing"
	| "commit-selecting"
	| "commit-sealing"
	| "commit-selected"
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
	includeCauseInAggregate?: boolean;
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
	#ownershipAcquired = false;
	#publicationStarted = false;
	#released = false;
	#commitSeals: LifecycleOperation[] = [];
	#targetCleanups: LifecycleOperation[] = [];
	#rollbackReleases: LifecycleOperation[] = [];
	readonly #host: SessionLifecycleTransactionHost;

	constructor(host: SessionLifecycleTransactionHost) {
		this.#host = host;
		this.#ownership = host.beginOwnership();
	}

	get phase(): SessionLifecyclePhase {
		return this.#phase;
	}

	async captureRetained(options: { capturePersistedSessionFile?: boolean } = {}): Promise<void> {
		await this.#ownership.ready();
		if (options.capturePersistedSessionFile) await this.#ownership.quarantineBash();
		const checkpoint = await this.#host.captureRetainedCheckpoint(options);
		// Publish a capture only after it completes. If a later post-quiescence
		// capture fails, rollback must retain the earlier durable preimage.
		this.#checkpoint = checkpoint;
		this.#checkpointIncludesPersistedFile = options.capturePersistedSessionFile === true;
		this.#phase = "checkpointed";
	}

	async acquireOwnership(): Promise<void> {
		if (this.#ownershipAcquired) throw new Error("Lifecycle ownership already acquired");
		await this.#ownership.acquire();
		this.#ownershipAcquired = true;
		this.#phase = "ownership-acquired";
	}

	markTarget(): void {
		if (!this.#ownershipAcquired) throw new Error("Lifecycle target cannot be marked before ownership is acquired");
		this.#ownership.markTarget();
		this.#phase = "target-marked";
	}

	/** Host quiescence has begun; every later failure owns authoritative rollback publication. */
	markPublicationStarted(): void {
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

	/**
	 * Runs after ordinary extension handlers but before host afterDispatch. The
	 * returned continuation activates delivery and releases the lifecycle fence
	 * after publication; callers also confirm activation once the host barrier returns.
	 */
	async prepareCommit(options?: SessionLifecycleCommitOptions): Promise<SessionLifecyclePostHostContinuation> {
		if (!this.#ownershipAcquired) throw new Error("Lifecycle commit requires acquired ownership");
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
		if (this.#phase !== "commit-selected" && this.#phase !== "commit-activating") {
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
		if (this.#released) return;
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
		}
	}
}
