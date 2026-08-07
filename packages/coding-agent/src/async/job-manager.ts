import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { logger } from "@oh-my-pi/pi-utils";
import type { ISO8601, Sha256Hex, Sha256Ref } from "../registry/persistent-agent-contracts.js";
import type {
	AsyncJobManagerSettlementBridgeV1,
	AsyncJobManagerTransientTaskSettlementStoreBindResultV1,
	AsyncJobManagerTransientTaskSettlementStoreResolveResultV1,
	ConfidentialAsyncJobSettledRowInspectRequestV1,
	ConfidentialAsyncJobSettledRowInspectResultV1,
	ConfidentialAsyncJobSettledRowV1,
	ConfidentialAsyncJobTransientTaskFreezeSettlementRecoveryInputV1,
	ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1,
	ConfidentialAsyncJobTransientTaskRecoveryPrepareResultV1,
	ConfidentialAsyncJobTransientTaskRecoveryRecordV1,
	ConfidentialAsyncJobTransientTaskSettlementResumeResultV1,
	ConfidentialTransientTaskAsyncJobRunResultV1,
	ConfidentialTransientTaskDetachedCancellationSettlementAdoptRequestV1,
	ConfidentialTransientTaskDetachedSettlementAdoptRequestV1,
	TransientTaskAsyncJobCompletionHandoffV1,
	TransientTaskDetachedSettledResultPublicationReceiptV1,
	TransientTaskParentResultDeliveryStoreCapabilityV1,
	TransientTaskParentResultDeliveryStoreV1,
} from "../session/workspace-runtime-contracts.js";

const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;
const DELIVERY_RETRY_JITTER_MS = 200;
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RUNNING_JOBS = 15;

function transientTaskDigest(domain: string, value: unknown): Sha256Hex {
	return createHash("sha256")
		.update(JSON.stringify([domain, value]), "utf8")
		.digest("hex") as Sha256Hex;
}

function transientTaskDigestRef(domain: string, value: unknown): Sha256Ref {
	return `sha256:${transientTaskDigest(domain, value)}` as Sha256Ref;
}

const SHA256_REF = /^sha256:[0-9a-f]{64}$/;
const TRANSIENT_TASK_OWNER_SESSION_INDEX_KEYS = [
	"schemaVersion",
	"ownerId",
	"ownerSessionId",
	"ownerSessionGenerationSha256",
	"deliveryEpoch",
	"indexSha256",
] as const;

interface TransientTaskParentResultDeliveryStoreBinding {
	readonly ownerSessionKey: string;
	readonly tupleKey: string;
	readonly store: TransientTaskParentResultDeliveryStoreV1;
}

interface ManagedCompletionSinkBinding {
	readonly ownerId: string;
	readonly sink: ManagedAsyncJobCompletionSink;
	readonly inFlight: Set<Promise<void>>;
	readonly retired: PromiseWithResolvers<void>;
	active: boolean;
	releasePromise?: Promise<void>;
}

function transientTaskOwnerSessionKeys(input: unknown): { ownerSessionKey: string; tupleKey: string } | null {
	if (isProxy(input) || input === null || typeof input !== "object" || Array.isArray(input)) return null;
	try {
		const prototype = Object.getPrototypeOf(input);
		if (prototype !== Object.prototype && prototype !== null) return null;
		const ownKeys = Reflect.ownKeys(input);
		if (ownKeys.length !== TRANSIENT_TASK_OWNER_SESSION_INDEX_KEYS.length) return null;
		const descriptors = Object.getOwnPropertyDescriptors(input);
		if (
			!ownKeys.every(key => {
				if (
					typeof key !== "string" ||
					!TRANSIENT_TASK_OWNER_SESSION_INDEX_KEYS.includes(
						key as (typeof TRANSIENT_TASK_OWNER_SESSION_INDEX_KEYS)[number],
					)
				)
					return false;
				const descriptor = descriptors[key];
				return descriptor?.enumerable === true && "value" in descriptor;
			})
		)
			return null;

		const schemaVersion = descriptors.schemaVersion?.value;
		const ownerId = descriptors.ownerId?.value;
		const ownerSessionId = descriptors.ownerSessionId?.value;
		const ownerSessionGenerationSha256 = descriptors.ownerSessionGenerationSha256?.value;
		const deliveryEpoch = descriptors.deliveryEpoch?.value;
		const indexSha256 = descriptors.indexSha256?.value;
		if (
			schemaVersion !== 1 ||
			typeof ownerId !== "string" ||
			ownerId.length === 0 ||
			typeof ownerSessionId !== "string" ||
			ownerSessionId.length === 0 ||
			typeof ownerSessionGenerationSha256 !== "string" ||
			!SHA256_REF.test(ownerSessionGenerationSha256) ||
			typeof deliveryEpoch !== "number" ||
			!Number.isSafeInteger(deliveryEpoch) ||
			Object.is(deliveryEpoch, -0) ||
			deliveryEpoch < 0 ||
			typeof indexSha256 !== "string" ||
			!SHA256_REF.test(indexSha256)
		)
			return null;

		const core = { schemaVersion, ownerId, ownerSessionId, ownerSessionGenerationSha256, deliveryEpoch };
		if (indexSha256 !== transientTaskDigestRef("async-job-owner-session-index", core)) return null;

		return {
			ownerSessionKey: JSON.stringify([ownerId, ownerSessionId]),
			tupleKey: JSON.stringify([
				schemaVersion,
				ownerId,
				ownerSessionId,
				ownerSessionGenerationSha256,
				deliveryEpoch,
				indexSha256,
			]),
		};
	} catch {
		return null;
	}
}

/**
 * Adaptive ("smart") `hub` poll-wait ladder (ms). A tight poll loop climbs
 * these rungs so each immediate re-poll backs off and stops spending turns on
 * "still running" frames; the floor (first rung) is the shortest wait and the
 * top rung is the longest a smart poll will ever block. Only used when
 * `async.pollWaitDuration` is set to `smart`; fixed durations wait verbatim.
 */
const POLL_WAIT_LADDER_MS = [5_000, 10_000, 30_000, 60_000, 300_000] as const;
/**
 * Going at least this long between poll calls means the agent stepped out of
 * the poll loop to do real work — the next poll drops back to the ladder floor.
 */
const POLL_ESCALATION_RESET_MS = 60_000;

interface PollEscalationState {
	/** Index into POLL_WAIT_LADDER_MS used for the most recent poll wait. */
	level: number;
	/** Timestamp (ms) when the most recent poll wait returned. */
	lastPollEndAt: number;
}

export interface AsyncJob {
	id: string;
	type: "bash" | "task";
	status: "running" | "completed" | "failed" | "cancelled";
	startTime: number;
	label: string;
	abortController: AbortController;
	promise: Promise<void>;
	resultText?: string;
	errorText?: string;
	/** Latest tool-render details reported by the running job. */
	latestDetails?: Record<string, unknown>;
	/**
	 * Registry id of the agent that registered the job (e.g. "Main",
	 * "AuthLoader"). Used by scoped cancel/list APIs so a subagent's teardown
	 * does not cancel its parent's jobs. Undefined for callers that don't
	 * supply an id (e.g. legacy tests, SDK consumers without an agent context).
	 */
	ownerId?: string;
	/**
	 * Registry id of the subagent this job runs (task/tan/vibe jobs). Lets
	 * job-view code link a job row to its AgentRegistry ref even when the job
	 * id differs from the agent id (vibe turn jobs, tan clones).
	 */
	agentId?: string;
	/**
	 * Job is registered but parked behind a caller-managed gate (e.g. a task
	 * batch semaphore). Queued jobs do not count toward the running-job limit
	 * until the caller invokes `markRunning()` from the run context.
	 */
	queued?: boolean;
	/** Durable settlement state exists only for registerTransientTask jobs. */
	transientTaskSettlementManaged?: boolean;
	transientTaskCompletion?: TransientTaskAsyncJobCompletionHandoffV1;
	transientTaskSettlementBlock?: Extract<
		ConfidentialTransientTaskAsyncJobRunResultV1,
		{ state: "blocked_indeterminate" }
	>;
	transientTaskRecoveryRecord?: ConfidentialAsyncJobTransientTaskRecoveryRecordV1;
}

/** Delivery callback for a settled job's result text. */
export type AsyncJobDeliverySink = (jobId: string, text: string, job?: AsyncJob) => void | Promise<void>;

/** Durable settled row eligible for managed completion routing. */
export type ManagedAsyncJobCompletionRow = Extract<
	ConfidentialAsyncJobSettledRowV1,
	{ readonly transientTaskCompletion: TransientTaskAsyncJobCompletionHandoffV1 }
>;

/** Exact, idempotent result of applying one managed handoff to its owner sink. */
export type ManagedAsyncJobCompletionAcknowledgement =
	| { readonly status: "committed"; readonly handoffSha256: Sha256Ref }
	| { readonly status: "not_applied"; readonly handoffSha256: Sha256Ref };

/** Owner-local callback for a durably settled transient-task handoff. */
export type ManagedAsyncJobCompletionSink = (
	row: ManagedAsyncJobCompletionRow,
	job: AsyncJob,
) => ManagedAsyncJobCompletionAcknowledgement | Promise<ManagedAsyncJobCompletionAcknowledgement>;

export interface AsyncJobManagerOptions {
	/**
	 * Delivery sink for UNOWNED completions (jobs registered without an
	 * `ownerId`). Owned deliveries route exclusively through
	 * {@link AsyncJobManager.registerDeliverySink}; when the owner has no live
	 * sink they are dead-lettered (dropped with a warning; the job row keeps
	 * the result text until retention eviction) — never routed here, which
	 * would leak one agent's result into another session.
	 */
	onJobComplete?: AsyncJobDeliverySink;
	maxRunningJobs?: number;
	retentionMs?: number;
}

interface AsyncJobDelivery {
	jobId: string;
	text: string;
	attempt: number;
	nextAttemptAt: number;
	lastError?: string;
	ownerId?: string;
	promise?: Promise<void>;
}

export interface AsyncJobDeliveryState {
	queued: number;
	delivering: boolean;
	nextRetryAt?: number;
	pendingJobIds: string[];
}

export interface AsyncJobRegisterOptions {
	id?: string;
	/** Registry id of the agent that owns this job; used to scope cancelAll. */
	ownerId?: string;
	/** Registry id of the subagent this job runs; see {@link AsyncJob.agentId}. */
	agentId?: string;
	onProgress?: (text: string, details?: Record<string, unknown>) => void | Promise<void>;
	/** Register the job in queued state; see {@link AsyncJob.queued}. */
	queued?: boolean;
}

/** Exact detached Task callback authority available only after durable pre-registration preparation. */
export interface AsyncJobTransientTaskRunContextV1 {
	readonly jobId: string;
	readonly signal: AbortSignal;
	readonly reportProgress: (text: string, details?: Readonly<Record<string, unknown>>) => Promise<void>;
	readonly markRunning: () => void;
	readonly freezeSettlementRecovery: (
		input: ConfidentialAsyncJobTransientTaskFreezeSettlementRecoveryInputV1,
	) => Promise<
		Extract<
			ConfidentialAsyncJobTransientTaskRecoveryPrepareResultV1,
			{ readonly status: "prepared" | "already_prepared" }
		>
	>;
}

/**
 * Filter applied to job query/cancel APIs. With `ownerId`, results are
 * restricted to jobs registered by that agent (registry id from
 * `AgentRegistry`, e.g. "Main", "AuthLoader").
 */
export interface AsyncJobFilter {
	ownerId?: string;
}

export type AsyncJobManagerTransientTaskCutoverResultV1 =
	| { readonly status: "ready"; readonly evictedTerminalJobIds: readonly string[] }
	| {
			readonly status: "blocked";
			readonly unresolvedJobIds: readonly string[];
			readonly recoveryStatuses: readonly string[];
	  };

export class AsyncJobManager implements AsyncJobManagerSettlementBridgeV1 {
	static #instance: AsyncJobManager | undefined;

	/** Process-global instance shared by internal URL protocol handlers and tools. */
	static instance(): AsyncJobManager | undefined {
		return AsyncJobManager.#instance;
	}

	/** Install or clear the process-global instance. */
	static setInstance(value: AsyncJobManager | undefined): void {
		AsyncJobManager.#instance = value;
	}

	/** Reset the process-global instance. Test-only. */
	static resetForTests(): void {
		AsyncJobManager.#instance = undefined;
	}

	readonly #jobs = new Map<string, AsyncJob>();
	readonly #deliveries: AsyncJobDelivery[] = [];
	readonly #inFlightDeliveries: AsyncJobDelivery[] = [];
	readonly #suppressedDeliveries = new Set<string>();
	readonly #watchedJobs = new Set<string>();
	readonly #evictionTimers = new Map<string, NodeJS.Timeout>();
	readonly #pollEscalation = new Map<string | undefined, PollEscalationState>();
	readonly #deliverySinks = new Map<string, AsyncJobDeliverySink>();
	readonly #managedCompletionSinks = new Map<string, ManagedCompletionSinkBinding>();
	readonly #managedCompletionDelivered = new Set<Sha256Ref>();
	readonly #managedCompletionInFlight = new Map<Sha256Ref, Promise<void>>();
	readonly #managedCompletionTails = new Map<string, Promise<void>>();
	readonly #transientTaskParentResultDeliveryStores = new Map<string, TransientTaskParentResultDeliveryStoreBinding>();
	readonly #transientTaskOwnerSessions = new Map<string, string>();
	readonly #onJobComplete: AsyncJobManagerOptions["onJobComplete"];
	readonly #maxRunningJobs: number;
	readonly #retentionMs: number;
	#deliveryLoop: Promise<void> | undefined;
	#disposed = false;

	#filterJobs(jobs: Iterable<AsyncJob>, filter?: AsyncJobFilter): AsyncJob[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return Array.from(jobs);
		const out: AsyncJob[] = [];
		for (const job of jobs) {
			if (job.ownerId === ownerId) out.push(job);
		}
		return out;
	}

	constructor(options: AsyncJobManagerOptions) {
		this.#onJobComplete = options.onJobComplete;
		this.#maxRunningJobs = Math.max(1, Math.floor(options.maxRunningJobs ?? DEFAULT_MAX_RUNNING_JOBS));
		this.#retentionMs = Math.max(0, Math.floor(options.retentionMs ?? DEFAULT_RETENTION_MS));
	}

	/** True when the running-job count has reached the configured cap. */
	get atCapacity(): boolean {
		if (this.#disposed) return true;
		// Mirror register(): queued jobs hold no execution slot.
		let activeCount = 0;
		for (const job of this.#jobs.values()) {
			if (job.status === "running" && !job.queued) activeCount++;
		}
		return activeCount >= this.#maxRunningJobs;
	}

	register(
		type: "bash" | "task",
		label: string,
		run: (ctx: {
			jobId: string;
			signal: AbortSignal;
			reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
			/** Clear the queued flag once the job actually starts executing. */
			markRunning: () => void;
		}) => Promise<string>,
		options?: AsyncJobRegisterOptions,
	): string {
		if (this.#disposed) {
			throw new Error("Async job manager is disposed");
		}
		// Queued jobs hold no execution slot yet — only count jobs that are
		// actually running so a large parked batch cannot starve registration.
		let activeCount = 0;
		for (const existing of this.#jobs.values()) {
			if (existing.status === "running" && !existing.queued) activeCount++;
		}
		if (activeCount >= this.#maxRunningJobs) {
			throw new Error(
				`Background job limit reached (${this.#maxRunningJobs}). Wait for running jobs to finish or cancel one.`,
			);
		}

		const id = this.#resolveJobId(options?.id);
		this.#suppressedDeliveries.delete(id);
		const abortController = new AbortController();
		const startTime = Date.now();

		const job: AsyncJob = {
			id,
			type,
			status: "running",
			startTime,
			label,
			abortController,
			promise: Promise.resolve(),
			ownerId: options?.ownerId,
			agentId: options?.agentId,
			queued: options?.queued === true,
		};

		const reportProgress = async (text: string, details?: Record<string, unknown>): Promise<void> => {
			if (details) job.latestDetails = details;
			if (!options?.onProgress) return;
			try {
				await options.onProgress(text, details);
			} catch (error) {
				logger.warn("Async job progress callback failed", {
					jobId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		job.promise = (async () => {
			try {
				const text = await run({
					jobId: id,
					signal: abortController.signal,
					reportProgress,
					markRunning: () => {
						job.queued = false;
					},
				});
				if (job.status === "cancelled") {
					job.resultText = text;
					this.#scheduleEviction(id);
					return;
				}
				job.status = "completed";
				job.resultText = text;
				this.#enqueueDelivery(id, text);
				this.#scheduleEviction(id);
			} catch (error) {
				if (job.status === "cancelled") {
					job.errorText = error instanceof Error ? error.message : String(error);
					this.#scheduleEviction(id);
					return;
				}
				const errorText = error instanceof Error ? error.message : String(error);
				job.status = "failed";
				job.errorText = errorText;
				this.#enqueueDelivery(id, errorText);
				this.#scheduleEviction(id);
			}
		})();

		this.#jobs.set(id, job);
		return id;
	}

	registerTransientTask(
		label: string,
		run: (context: AsyncJobTransientTaskRunContextV1) => Promise<ConfidentialTransientTaskAsyncJobRunResultV1>,
		options: {
			readonly id?: string;
			readonly agentId: string;
			readonly queued?: boolean;
			readonly ownerId: string;
			readonly ownerSessionId: string;
			readonly ownerSessionGenerationSha256: Sha256Ref;
			readonly deliveryEpoch: number;
			readonly onProgress?: (text: string) => void | Promise<void>;
		},
	): string {
		if (this.#disposed) throw new Error("Async job manager is disposed");
		const id = options.id;
		if (!id?.trim()) throw new Error("Transient task registration requires an exact preferred job ID");
		if (this.#jobs.has(id)) throw new Error(`Transient task job ID is already registered: ${id}`);
		let activeCount = 0;
		for (const existing of this.#jobs.values()) {
			if (existing.status === "running" && !existing.queued) activeCount++;
		}
		if (activeCount >= this.#maxRunningJobs) {
			throw new Error(
				`Background job limit reached (${this.#maxRunningJobs}). Wait for running jobs to finish or cancel one.`,
			);
		}
		this.#suppressedDeliveries.delete(id);
		const abortController = new AbortController();
		const startTime = Date.now();
		const ownerSessionIndex = this.#transientTaskOwnerSessionIndex(options);
		const job: AsyncJob = {
			id,
			type: "task",
			status: "running",
			startTime,
			label,
			abortController,
			promise: Promise.resolve(),
			ownerId: options.ownerId,
			agentId: options.agentId,
			queued: options.queued === true,
			transientTaskSettlementManaged: true,
		};
		let frozenRecord:
			| Extract<ConfidentialAsyncJobTransientTaskRecoveryRecordV1, { readonly recoveryState: "attempt_frozen" }>
			| undefined;
		const reportProgress = async (text: string, details?: Readonly<Record<string, unknown>>): Promise<void> => {
			if (details) job.latestDetails = { ...details };
			if (!options.onProgress) return;
			try {
				await options.onProgress(text);
			} catch (error) {
				logger.warn("Async job progress callback failed", {
					jobId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		job.promise = (async () => {
			try {
				const outcome = await run({
					jobId: id,
					signal: abortController.signal,
					reportProgress,
					markRunning: () => {
						job.queued = false;
					},
					freezeSettlementRecovery: async input => {
						const ownerKeys = transientTaskOwnerSessionKeys(ownerSessionIndex);
						if (!ownerKeys) throw new Error("Transient task recovery owner session is invalid");
						const candidate = this.#transientTaskAttemptFrozenRecord({
							job,
							ownerSessionIndex,
							input,
						});
						if (frozenRecord && frozenRecord.recoveryRecordSha256 !== candidate.recoveryRecordSha256) {
							throw new Error("Transient task settlement recovery was already frozen for a different attempt");
						}
						frozenRecord ??= candidate;
						const store = this.#requireTransientTaskSettlementStore(ownerSessionIndex);
						const request = {
							record: frozenRecord,
							requestSha256: transientTaskDigestRef("async-job-recovery-prepare-request", frozenRecord),
						};
						const prepared = await store.prepareAsyncJobRecovery(request);
						if (prepared.status !== "prepared" && prepared.status !== "already_prepared") {
							throw new Error(`Transient task recovery freeze failed: ${prepared.status}`);
						}
						if (prepared.record.recoveryRecordSha256 !== frozenRecord.recoveryRecordSha256)
							throw new Error("Transient task recovery preparation replaced the frozen record");
						job.transientTaskRecoveryRecord = prepared.record;
						return prepared;
					},
				});
				if (!frozenRecord) throw new Error("Transient task run returned without freezing settlement recovery");
				if (outcome.ownerId !== options.ownerId || outcome.jobId !== id || outcome.jobType !== "task") {
					throw new Error("Transient task completion handoff identity does not match the registered job");
				}
				const transitioned = await this.#transitionTransientTaskRecovery(
					job,
					ownerSessionIndex,
					frozenRecord,
					outcome,
				);
				if (transitioned.recoveryState === "handoff_ready") {
					await this.#notifyManagedCompletion(this.#transientTaskSettledRow(job, transitioned), job);
				}
			} catch (error) {
				await this.#recordTransientTaskRunFailure(job, ownerSessionIndex, frozenRecord, error);
			}
		})();
		this.#jobs.set(id, job);
		return id;
	}

	async #recordTransientTaskRunFailure(
		job: AsyncJob,
		ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1,
		frozenRecord:
			| Extract<ConfidentialAsyncJobTransientTaskRecoveryRecordV1, { readonly recoveryState: "attempt_frozen" }>
			| undefined,
		error: unknown,
	): Promise<void> {
		const runErrorText = error instanceof Error ? error.message : String(error);
		let recoveryErrorText: string | undefined;
		if (frozenRecord) {
			try {
				const store = this.#requireTransientTaskSettlementStore(ownerSessionIndex);
				const prepareRequest = {
					record: frozenRecord,
					requestSha256: transientTaskDigestRef("async-job-recovery-prepare-request", frozenRecord),
				};
				const prepared = await store.prepareAsyncJobRecovery(prepareRequest);
				if (prepared.status === "prepared" || prepared.status === "already_prepared") {
					if (prepared.record.recoveryRecordSha256 !== frozenRecord.recoveryRecordSha256)
						throw new Error("Transient task recovery preparation replaced the frozen record");
					job.transientTaskRecoveryRecord = prepared.record;
					const resumed = await this.resumeTransientTaskSettlement({
						ownerSessionIndex,
						jobId: job.id,
						expectedRecoveryRecordSha256: prepared.record.recoveryRecordSha256,
						requestedAt: new Date().toISOString() as ISO8601,
					});
					if (resumed.status === "settled" || resumed.status === "blocked_indeterminate") return;
					recoveryErrorText = `recovery ${resumed.status}`;
				} else {
					recoveryErrorText = `recovery freeze ${prepared.status}`;
				}
			} catch (recoveryError) {
				recoveryErrorText = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
			}
		}
		// A managed task with an unhanded-off outcome remains nonterminal: only its
		// frozen durable record may later establish a terminal result.
		job.status = job.status === "cancelled" ? "cancelled" : "running";
		job.errorText = recoveryErrorText
			? `${runErrorText}; settlement recovery failed: ${recoveryErrorText}`
			: runErrorText;
		logger.error("Transient task settlement did not reach a durable handoff", {
			jobId: job.id,
			error: job.errorText,
		});
	}

	#transientTaskOwnerSessionIndex(options: {
		readonly ownerId: string;
		readonly ownerSessionId: string;
		readonly ownerSessionGenerationSha256: Sha256Ref;
		readonly deliveryEpoch: number;
	}): ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1 {
		const core = {
			schemaVersion: 1 as const,
			ownerId: options.ownerId,
			ownerSessionId: options.ownerSessionId,
			ownerSessionGenerationSha256: options.ownerSessionGenerationSha256,
			deliveryEpoch: options.deliveryEpoch,
		};
		return { ...core, indexSha256: transientTaskDigestRef("async-job-owner-session-index", core) };
	}

	#requireTransientTaskSettlementStore(
		ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1,
	): TransientTaskParentResultDeliveryStoreV1["detachedSettlement"] {
		const resolved = this.resolveTransientTaskParentResultDeliveryStore(ownerSessionIndex);
		if (resolved.status !== "resolved") {
			throw new Error(`Transient task settlement store is unavailable: ${resolved.status}`);
		}
		return resolved.store.detachedSettlement;
	}

	#transientTaskAttemptFrozenRecord(input: {
		readonly job: AsyncJob;
		readonly ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1;
		readonly input: ConfidentialAsyncJobTransientTaskFreezeSettlementRecoveryInputV1;
	}): Extract<ConfidentialAsyncJobTransientTaskRecoveryRecordV1, { readonly recoveryState: "attempt_frozen" }> {
		const coordinatesCore = {
			schemaVersion: 1 as const,
			ownerSessionIndex: input.ownerSessionIndex,
			jobId: input.job.id,
			agentId: input.job.agentId ?? input.job.id,
			label: input.job.label,
			startedAtEpochMs: input.job.startTime,
		};
		const coordinates = {
			...coordinatesCore,
			coordinatesSha256: transientTaskDigestRef("async-job-recovery-coordinates", coordinatesCore),
		};
		const common = {
			schemaVersion: 1 as const,
			jobType: "task" as const,
			coordinates,
			settlementIdentitySha256: input.input.attempt.operation.request.identity.identitySha256,
			settlementRequestSha256: input.input.attempt.operation.request.settlementRequestSha256,
			attemptSha256: input.input.attempt.attemptSha256,
			terminalStatus: input.input.terminalStatus,
			text: input.input.text,
			jobErrorTextUtf8: input.input.jobErrorTextUtf8,
			parentDeliveryRequest: input.input.parentDeliveryRequest,
			attempt: input.input.attempt,
			inspectRequest: input.input.inspectRequest,
			recoveryState: "attempt_frozen" as const,
			status: input.input.terminalStatus === "cancelled" ? ("cancelled" as const) : ("running" as const),
			resultText: null,
			errorText: input.input.terminalStatus === "cancelled" ? input.input.jobErrorTextUtf8 : null,
			transientTaskCompletion: null,
			transientTaskSettlementBlock: null,
			notAppliedReceiptSha256: null,
			blockSha256: null,
			handoffSha256: null,
		};
		return {
			...common,
			recoveryRecordSha256: transientTaskDigestRef("async-job-recovery-record", common),
		} as Extract<ConfidentialAsyncJobTransientTaskRecoveryRecordV1, { readonly recoveryState: "attempt_frozen" }>;
	}

	async #transitionTransientTaskRecovery(
		job: AsyncJob,
		ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1,
		sourceRecord: Extract<
			ConfidentialAsyncJobTransientTaskRecoveryRecordV1,
			{ readonly recoveryState: "attempt_frozen" | "blocked_indeterminate" }
		>,
		outcome: ConfidentialTransientTaskAsyncJobRunResultV1,
	): Promise<ConfidentialAsyncJobTransientTaskRecoveryRecordV1> {
		if (
			"state" in outcome &&
			sourceRecord.recoveryState === "blocked_indeterminate" &&
			outcome.state === "blocked_indeterminate"
		) {
			this.#applyTransientTaskRecoveryRecord(job, sourceRecord);
			return sourceRecord;
		}
		const state =
			"state" in outcome
				? {
						...sourceRecord,
						recoveryState: "blocked_indeterminate" as const,
						status: outcome.terminalStatus === "cancelled" ? ("cancelled" as const) : ("running" as const),
						resultText: null,
						errorText: outcome.terminalStatus === "cancelled" ? outcome.jobErrorTextUtf8 : null,
						transientTaskCompletion: null,
						transientTaskSettlementBlock: outcome,
						notAppliedReceiptSha256: outcome.notAppliedReceipt?.receiptSha256 ?? null,
						blockSha256: outcome.blockSha256,
						handoffSha256: null,
					}
				: {
						...sourceRecord,
						recoveryState: "handoff_ready" as const,
						status: outcome.terminalStatus,
						resultText: outcome.terminalStatus === "completed" ? outcome.text : null,
						errorText: outcome.terminalStatus === "completed" ? null : outcome.text,
						transientTaskCompletion: outcome,
						transientTaskSettlementBlock: null,
						notAppliedReceiptSha256: outcome.notAppliedReceiptSha256,
						blockSha256: null,
						handoffSha256: outcome.handoffSha256,
					};
		const record = {
			...state,
			recoveryRecordSha256: transientTaskDigestRef("async-job-recovery-record", state),
		} as ConfidentialAsyncJobTransientTaskRecoveryRecordV1;
		const store = this.#requireTransientTaskSettlementStore(ownerSessionIndex);
		const transitioned = await store.transitionAsyncJobRecovery({
			expectedRecoveryRecordSha256: sourceRecord.recoveryRecordSha256,
			record: record as Extract<
				ConfidentialAsyncJobTransientTaskRecoveryRecordV1,
				{ readonly recoveryState: "blocked_indeterminate" | "handoff_ready" }
			>,
			requestSha256: transientTaskDigestRef("async-job-recovery-transition-request", {
				from: sourceRecord.recoveryRecordSha256,
				to: record.recoveryRecordSha256,
			}),
		});
		if (transitioned.status !== "transitioned" && transitioned.status !== "already_transitioned") {
			throw new Error(`Transient task recovery transition failed: ${transitioned.status}`);
		}
		if (transitioned.record.recoveryRecordSha256 !== record.recoveryRecordSha256)
			throw new Error("Transient task recovery transition replaced the exact record");
		this.#applyTransientTaskRecoveryRecord(job, transitioned.record);
		return transitioned.record;
	}

	#applyTransientTaskRecoveryRecord(job: AsyncJob, record: ConfidentialAsyncJobTransientTaskRecoveryRecordV1): void {
		job.transientTaskRecoveryRecord = record;
		job.transientTaskCompletion = record.transientTaskCompletion ?? undefined;
		job.transientTaskSettlementBlock = record.transientTaskSettlementBlock ?? undefined;
		job.status = record.status;
		job.resultText = record.resultText ?? undefined;
		job.errorText = record.errorText ?? undefined;
	}

	#rehydrateTransientTaskJob(record: ConfidentialAsyncJobTransientTaskRecoveryRecordV1): AsyncJob | null {
		let job = this.#jobs.get(record.coordinates.jobId);
		if (!job) {
			job = {
				id: record.coordinates.jobId,
				type: "task",
				status: record.status,
				startTime: record.coordinates.startedAtEpochMs,
				label: record.coordinates.label,
				abortController: new AbortController(),
				promise: Promise.resolve(),
				ownerId: record.coordinates.ownerSessionIndex.ownerId,
				agentId: record.coordinates.agentId,
				transientTaskSettlementManaged: true,
			};
			this.#jobs.set(job.id, job);
		} else {
			const current = job.transientTaskRecoveryRecord;
			const currentOwnerSession = current?.coordinates.ownerSessionIndex;
			const ownerSession = record.coordinates.ownerSessionIndex;
			if (
				job.type !== "task" ||
				job.transientTaskSettlementManaged !== true ||
				job.ownerId !== ownerSession.ownerId ||
				job.agentId !== record.coordinates.agentId ||
				job.label !== record.coordinates.label ||
				job.startTime !== record.coordinates.startedAtEpochMs ||
				!current ||
				current.coordinates.jobId !== record.coordinates.jobId ||
				current.coordinates.agentId !== record.coordinates.agentId ||
				current.coordinates.label !== record.coordinates.label ||
				current.coordinates.startedAtEpochMs !== record.coordinates.startedAtEpochMs ||
				!currentOwnerSession ||
				currentOwnerSession.ownerId !== ownerSession.ownerId ||
				currentOwnerSession.ownerSessionId !== ownerSession.ownerSessionId ||
				currentOwnerSession.ownerSessionGenerationSha256 !== ownerSession.ownerSessionGenerationSha256 ||
				currentOwnerSession.deliveryEpoch !== ownerSession.deliveryEpoch ||
				currentOwnerSession.indexSha256 !== ownerSession.indexSha256 ||
				current.recoveryRecordSha256 !== record.recoveryRecordSha256
			) {
				return null;
			}
		}
		this.#applyTransientTaskRecoveryRecord(job, record);
		return job;
	}

	async #resumeAdoptedTransientTaskRecovery(
		store: TransientTaskParentResultDeliveryStoreV1["detachedSettlement"],
		record: ConfidentialAsyncJobTransientTaskRecoveryRecordV1,
		requestedAt: ISO8601,
	): Promise<ConfidentialAsyncJobTransientTaskSettlementResumeResultV1> {
		if (record.recoveryState === "handoff_ready") {
			const job = this.#rehydrateTransientTaskJob(record);
			if (!job) return { status: "conflict" };
			const row = this.#transientTaskSettledRow(job, record);
			await this.#notifyManagedCompletion(row, job);
			return { status: "settled", row };
		}
		const inspection = await store.inspect(record.inspectRequest);
		let receipt: TransientTaskDetachedSettledResultPublicationReceiptV1 | undefined;
		let notAppliedReceiptSha256: Sha256Ref | null =
			inspection.status === "not_applied" ||
			inspection.status === "outcome_unknown" ||
			inspection.status === "matching"
				? inspection.notAppliedReceiptSha256
				: null;
		let publicationMayProceed = inspection.status === "not_applied";
		let notAppliedReceipt:
			| Extract<
					ConfidentialTransientTaskAsyncJobRunResultV1,
					{ state: "blocked_indeterminate" }
			  >["notAppliedReceipt"]
			| null = null;
		if (inspection.status === "matching" || inspection.status === "outcome_unknown") {
			const common = {
				...record.inspectRequest,
				expectedIdentity: record.attempt.operation.request.identity,
				expectedOperation: record.attempt.operation,
				expectedAttempt: record.attempt,
				expectedNotAppliedReceiptSha256: inspection.notAppliedReceiptSha256,
				expectedReceiptSha256: inspection.status === "matching" ? inspection.receiptSha256 : null,
				expectedCurrentAuthority: null,
			};
			const adopted =
				record.terminalStatus === "cancelled"
					? await store.adopt(common as ConfidentialTransientTaskDetachedCancellationSettlementAdoptRequestV1)
					: await store.adopt(common as ConfidentialTransientTaskDetachedSettlementAdoptRequestV1);
			if (adopted.status === "adopted" && "settledResultOperationId" in adopted.receipt) {
				receipt = adopted.receipt;
			} else if (adopted.status === "not_applied" || adopted.status === "outcome_unknown") {
				notAppliedReceipt = adopted.notAppliedReceipt;
				notAppliedReceiptSha256 = adopted.notAppliedReceipt.receiptSha256;
				publicationMayProceed = adopted.status === "not_applied";
			}
		} else if (inspection.status === "absent") {
			const prepared = await store.prepare({ attempt: record.attempt });
			if (prepared.status === "prepared" || prepared.status === "already_prepared") {
				notAppliedReceipt = prepared.notAppliedReceipt;
				notAppliedReceiptSha256 = prepared.notAppliedReceipt.receiptSha256;
				publicationMayProceed = true;
			}
		}
		if (!receipt && publicationMayProceed && notAppliedReceiptSha256) {
			const published = await store.publishSettledResult({
				operation: record.attempt.operation,
				expectedAttemptSha256: record.attempt.attemptSha256,
				expectedNotAppliedReceiptSha256: notAppliedReceiptSha256,
			});
			if (published.status === "published" || published.status === "already_published") receipt = published.receipt;
		}
		let outcome: ConfidentialTransientTaskAsyncJobRunResultV1;
		if (receipt) {
			const authority = await store.resolveAsyncJobRecoveryCurrentAuthority({
				ownerSessionIndex: record.coordinates.ownerSessionIndex,
				jobId: record.coordinates.jobId,
				expectedRecoveryRecordSha256: record.recoveryRecordSha256,
				settlementRequest: record.attempt.operation.request,
				settledResultReceipt: receipt,
				requestedAt,
				requestSha256: transientTaskDigestRef("async-job-recovery-current-authority", {
					recoveryRecordSha256: record.recoveryRecordSha256,
					receiptSha256: receipt.receiptSha256,
				}),
			});
			if (authority.status === "resolved" && notAppliedReceiptSha256) {
				const handoffCore = {
					schemaVersion: 1 as const,
					jobType: "task" as const,
					ownerId: record.coordinates.ownerSessionIndex.ownerId,
					jobId: record.coordinates.jobId,
					notAppliedReceiptSha256,
					terminalStatus: record.terminalStatus,
					text: record.text,
					jobErrorTextUtf8: record.jobErrorTextUtf8,
					attempt: record.attempt,
					settlementRequest: record.attempt.operation.request,
					settledResultReceipt: receipt,
					currentAuthority: authority.currentAuthority,
				};
				outcome = {
					...handoffCore,
					handoffSha256: transientTaskDigestRef("async-job-completion-handoff", handoffCore),
				} as TransientTaskAsyncJobCompletionHandoffV1;
			} else {
				outcome = this.#transientTaskSettlementBlock(record, notAppliedReceipt, requestedAt);
			}
		} else {
			outcome = this.#transientTaskSettlementBlock(record, notAppliedReceipt, requestedAt);
		}
		const job = this.#rehydrateTransientTaskJob(record);
		if (!job) return { status: "conflict" };
		const transitioned = await this.#transitionTransientTaskRecovery(
			job,
			record.coordinates.ownerSessionIndex,
			record as Extract<
				ConfidentialAsyncJobTransientTaskRecoveryRecordV1,
				{ readonly recoveryState: "attempt_frozen" | "blocked_indeterminate" }
			>,
			outcome,
		);
		if (transitioned.recoveryState === "blocked_indeterminate") {
			return {
				status: "blocked_indeterminate",
				row: {
					schemaVersion: 1,
					jobId: job.id,
					jobType: "task",
					ownerId: job.ownerId!,
					status: transitioned.status,
					resultText: null,
					errorText: null,
					jobErrorTextUtf8: transitioned.jobErrorTextUtf8,
					transientTaskCompletion: null,
					transientTaskSettlementBlock: transitioned.transientTaskSettlementBlock,
					recoveryRecord: transitioned,
				} as Extract<
					ConfidentialAsyncJobTransientTaskSettlementResumeResultV1,
					{ readonly status: "blocked_indeterminate" }
				>["row"],
			};
		}
		const row = this.#transientTaskSettledRow(job, transitioned);
		await this.#notifyManagedCompletion(row, job);
		return { status: "settled", row };
	}

	#transientTaskSettlementBlock(
		record: ConfidentialAsyncJobTransientTaskRecoveryRecordV1,
		notAppliedReceipt: Extract<
			ConfidentialTransientTaskAsyncJobRunResultV1,
			{ state: "blocked_indeterminate" }
		>["notAppliedReceipt"],
		blockedAt: ISO8601,
	): Extract<ConfidentialTransientTaskAsyncJobRunResultV1, { state: "blocked_indeterminate" }> {
		const core = {
			schemaVersion: 1 as const,
			state: "blocked_indeterminate" as const,
			cancellationPolicy: "reject_preserve_block" as const,
			jobType: "task" as const,
			ownerId: record.coordinates.ownerSessionIndex.ownerId,
			jobId: record.coordinates.jobId,
			blockedAt,
			terminalStatus: record.terminalStatus,
			text: record.text,
			jobErrorTextUtf8: record.jobErrorTextUtf8,
			attempt: record.attempt,
			notAppliedReceipt,
			inspectRequest: record.inspectRequest,
		};
		return { ...core, blockSha256: transientTaskDigestRef("async-job-settlement-block", core) } as Extract<
			ConfidentialTransientTaskAsyncJobRunResultV1,
			{ state: "blocked_indeterminate" }
		>;
	}

	#transientTaskSettledRow(
		job: AsyncJob,
		record: ConfidentialAsyncJobTransientTaskRecoveryRecordV1,
	): ManagedAsyncJobCompletionRow {
		if (record.recoveryState !== "handoff_ready" || !record.transientTaskCompletion) {
			throw new Error("Transient task recovery is not settled");
		}
		return {
			schemaVersion: 1,
			jobId: job.id,
			settledAt: record.transientTaskCompletion.settledResultReceipt.publishedAt,
			jobType: "task",
			ownerId: record.coordinates.ownerSessionIndex.ownerId,
			status: record.status,
			resultText: record.resultText,
			errorText: record.errorText,
			transientTaskCompletion: record.transientTaskCompletion,
			transientTaskRecoveryRecordSha256: record.recoveryRecordSha256,
		} as ManagedAsyncJobCompletionRow;
	}

	async resumeTransientTaskSettlement(request: {
		readonly ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1;
		readonly jobId: string;
		readonly expectedRecoveryRecordSha256: Sha256Ref;
		readonly requestedAt: ISO8601;
	}): Promise<ConfidentialAsyncJobTransientTaskSettlementResumeResultV1> {
		if (!transientTaskOwnerSessionKeys(request.ownerSessionIndex)) return { status: "session_mismatch" };
		let store: TransientTaskParentResultDeliveryStoreV1["detachedSettlement"];
		try {
			store = this.#requireTransientTaskSettlementStore(request.ownerSessionIndex);
		} catch {
			return { status: "session_mismatch" };
		}
		try {
			const inspected = await store.inspectAsyncJobRecovery({
				...request,
				requestSha256: transientTaskDigestRef("async-job-recovery-inspect-request", request),
			});
			if (inspected.status === "terminal")
				return { status: "terminal", terminalReceiptSha256: inspected.terminalReceiptSha256 };
			if (inspected.status !== "matching") {
				return {
					status:
						inspected.status === "owner_session_conflict"
							? "session_mismatch"
							: inspected.status === "record_conflict" || inspected.status === "invalid"
								? "conflict"
								: "absent",
				};
			}
			const adopted = await store.adoptAsyncJobRecovery({
				ownerSessionIndex: request.ownerSessionIndex,
				inspection: inspected,
				expectedRecoveryRecordSha256: request.expectedRecoveryRecordSha256,
				requestedAt: request.requestedAt,
				requestSha256: transientTaskDigestRef("async-job-recovery-adopt-request", {
					inspectionSha256: inspected.inspectionSha256,
					expectedRecoveryRecordSha256: request.expectedRecoveryRecordSha256,
				}),
			});
			if (adopted.status === "terminal")
				return { status: "terminal", terminalReceiptSha256: adopted.terminalReceiptSha256 };
			if (adopted.status !== "adopted") {
				return {
					status:
						adopted.status === "owner_session_conflict"
							? "session_mismatch"
							: adopted.status === "absent"
								? "absent"
								: "conflict",
				};
			}
			if (
				adopted.record.recoveryRecordSha256 !== request.expectedRecoveryRecordSha256 ||
				adopted.record.coordinates.jobId !== request.jobId ||
				transientTaskOwnerSessionKeys(adopted.record.coordinates.ownerSessionIndex)?.tupleKey !==
					transientTaskOwnerSessionKeys(request.ownerSessionIndex)?.tupleKey
			)
				return { status: "conflict" };
			return await this.#resumeAdoptedTransientTaskRecovery(store, adopted.record, request.requestedAt);
		} catch {
			return { status: "conflict" };
		}
	}
	async rehydrateTransientTaskSettlements(request: {
		readonly ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1;
		readonly requestedAt: ISO8601;
	}): Promise<readonly ConfidentialAsyncJobTransientTaskSettlementResumeResultV1[]> {
		let store: TransientTaskParentResultDeliveryStoreV1["detachedSettlement"];
		try {
			store = this.#requireTransientTaskSettlementStore(request.ownerSessionIndex);
		} catch {
			return [{ status: "session_mismatch" }];
		}
		try {
			const enumerated = await store.enumerateAsyncJobRecovery({
				...request,
				requestSha256: transientTaskDigestRef("async-job-recovery-enumerate-request", request),
			});
			if (enumerated.status !== "matching") {
				return [{ status: enumerated.status === "owner_session_conflict" ? "session_mismatch" : "conflict" }];
			}
			const results: ConfidentialAsyncJobTransientTaskSettlementResumeResultV1[] = [];
			for (const entry of enumerated.entries) {
				results.push(
					await this.resumeTransientTaskSettlement({
						ownerSessionIndex: request.ownerSessionIndex,
						jobId: entry.jobId,
						expectedRecoveryRecordSha256: entry.recoveryRecordSha256,
						requestedAt: request.requestedAt,
					}),
				);
			}
			return results;
		} catch {
			return [{ status: "conflict" }];
		}
	}

	/**
	 * Reconcile every durable row for one exact owner-session generation before
	 * its store binding can be released. Only rows proven terminal are evicted;
	 * blocked, handoff-ready, missing-freeze, and index-conflict states fail closed.
	 */
	async reconcileTransientTaskSessionCutover(request: {
		readonly ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1;
		readonly requestedAt: ISO8601;
	}): Promise<AsyncJobManagerTransientTaskCutoverResultV1> {
		const recovery = await this.rehydrateTransientTaskSettlements(request);
		const recoveryStatuses = recovery.filter(result => result.status !== "terminal").map(result => result.status);
		const unresolvedJobIds: string[] = [];
		const evictedTerminalJobIds: string[] = [];
		for (const job of this.getAllJobs({ ownerId: request.ownerSessionIndex.ownerId })) {
			if (!job.transientTaskSettlementManaged) continue;
			const record = job.transientTaskRecoveryRecord;
			if (!record || record.coordinates.ownerSessionIndex.indexSha256 !== request.ownerSessionIndex.indexSha256) {
				unresolvedJobIds.push(job.id);
				continue;
			}
			const resumed = await this.resumeTransientTaskSettlement({
				ownerSessionIndex: request.ownerSessionIndex,
				jobId: job.id,
				expectedRecoveryRecordSha256: record.recoveryRecordSha256,
				requestedAt: request.requestedAt,
			});
			if (resumed.status === "terminal") {
				evictedTerminalJobIds.push(job.id);
			} else {
				unresolvedJobIds.push(job.id);
				recoveryStatuses.push(resumed.status);
			}
		}
		if (recoveryStatuses.length > 0 || unresolvedJobIds.length > 0) {
			return {
				status: "blocked",
				unresolvedJobIds: Object.freeze([...new Set(unresolvedJobIds)]),
				recoveryStatuses: Object.freeze([...recoveryStatuses]),
			};
		}
		for (const jobId of evictedTerminalJobIds) this.#evictJob(jobId);
		return { status: "ready", evictedTerminalJobIds: Object.freeze(evictedTerminalJobIds) };
	}

	async inspectSettledRow(
		request: ConfidentialAsyncJobSettledRowInspectRequestV1,
	): Promise<ConfidentialAsyncJobSettledRowInspectResultV1> {
		const job = this.#jobs.get(request.jobId);
		if (!job) return { status: "absent" };
		if ((job.ownerId ?? null) !== request.ownerId) return { status: "owner_mismatch" };
		const recovery = job.transientTaskRecoveryRecord;
		if (recovery?.recoveryState === "blocked_indeterminate") {
			return {
				status: "blocked_indeterminate",
				recoveryRecordSha256: recovery.recoveryRecordSha256,
				blockSha256: recovery.blockSha256,
				attemptSha256: recovery.attemptSha256,
			};
		}
		if (recovery?.recoveryState === "handoff_ready") {
			return { status: "settled", row: this.#transientTaskSettledRow(job, recovery) };
		}
		if (job.status === "running") return { status: "running" };
		if (job.status === "cancelled") return { status: "cancelled" };
		const settledAt = new Date(job.startTime).toISOString() as ISO8601;
		return job.status === "completed"
			? {
					status: "settled",
					row: {
						schemaVersion: 1,
						jobId: job.id,
						settledAt,
						jobType: job.type,
						ownerId: job.ownerId ?? null,
						transientTaskCompletion: null,
						transientTaskRecoveryRecordSha256: null,
						status: "completed",
						resultText: job.resultText ?? "",
						errorText: null,
					},
				}
			: {
					status: "settled",
					row: {
						schemaVersion: 1,
						jobId: job.id,
						settledAt,
						jobType: job.type,
						ownerId: job.ownerId ?? null,
						transientTaskCompletion: null,
						transientTaskRecoveryRecordSha256: null,
						status: "failed",
						resultText: null,
						errorText: job.errorText ?? "",
					},
				};
	}

	/**
	 * Cancel a single job by id. When `filter.ownerId` is set and does not
	 * match the job's owner, the call is treated as not-found (returns false)
	 * so cross-agent cancellation is rejected at the manager level.
	 */
	cancel(id: string, filter?: AsyncJobFilter): boolean {
		const job = this.#jobs.get(id);
		if (!job) return false;
		if (filter?.ownerId && job.ownerId !== filter.ownerId) return false;
		if (job.status !== "running") return false;
		if (job.transientTaskSettlementBlock) return false;
		job.status = "cancelled";
		job.abortController.abort();
		if (!job.transientTaskSettlementManaged) this.#scheduleEviction(id);
		return true;
	}

	getJob(id: string): AsyncJob | undefined {
		return this.#jobs.get(id);
	}

	getRunningJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter).filter(job => job.status === "running");
	}

	getRecentJobs(limit = 10, filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter)
			.filter(job => job.status !== "running")
			.sort((a, b) => b.startTime - a.startTime)
			.slice(0, limit);
	}

	getAllJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter);
	}

	getDeliveryState(filter?: AsyncJobFilter): AsyncJobDeliveryState {
		const deliveries = this.#filterDeliveries(filter);
		const inFlightDeliveries = this.#filterInFlightDeliveries(filter);
		const nextRetryAt = deliveries.reduce<number | undefined>((next, delivery) => {
			if (next === undefined) return delivery.nextAttemptAt;
			return Math.min(next, delivery.nextAttemptAt);
		}, undefined);

		return {
			queued: deliveries.length + inFlightDeliveries.length,
			delivering: inFlightDeliveries.length > 0 || (this.#deliveryLoop !== undefined && deliveries.length > 0),
			nextRetryAt,
			pendingJobIds: deliveries.concat(inFlightDeliveries).map(delivery => delivery.jobId),
		};
	}

	hasPendingDeliveries(filter?: AsyncJobFilter): boolean {
		return this.getDeliveryState(filter).queued > 0;
	}

	watchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		for (const jobId of uniqueJobIds) {
			this.#watchedJobs.add(jobId);
		}
		return uniqueJobIds.length;
	}

	unwatchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		let removed = 0;
		for (const jobId of uniqueJobIds) {
			if (this.#watchedJobs.delete(jobId)) {
				removed += 1;
			}
		}
		return removed;
	}

	/**
	 * Compute the next adaptive ("smart") wait (ms) for a blocking `hub` wait by
	 * the given owner. Consecutive polls — those starting within
	 * POLL_ESCALATION_RESET_MS of the previous poll returning — climb
	 * POLL_WAIT_LADDER_MS so a tight wait loop backs off; a longer gap means the
	 * agent left to do real work, so the wait resets to the floor. Pair each call
	 * with `recordPollWaitEnd()` once the wait returns.
	 */
	nextPollWaitMs(ownerId: string | undefined, now: number = Date.now()): number {
		const prev = this.#pollEscalation.get(ownerId);
		const reset = !prev || now - prev.lastPollEndAt >= POLL_ESCALATION_RESET_MS;
		const level = reset ? 0 : Math.min(prev.level + 1, POLL_WAIT_LADDER_MS.length - 1);
		this.#pollEscalation.set(ownerId, { level, lastPollEndAt: prev?.lastPollEndAt ?? now });
		return POLL_WAIT_LADDER_MS[level];
	}

	/**
	 * Mark a blocking poll wait as finished so the idle-reset window is measured
	 * from now. Polling again before POLL_ESCALATION_RESET_MS elapses keeps
	 * climbing the ladder; waiting longer resets it to the floor.
	 */
	recordPollWaitEnd(ownerId: string | undefined, now: number = Date.now()): void {
		const prev = this.#pollEscalation.get(ownerId);
		this.#pollEscalation.set(ownerId, { level: prev?.level ?? 0, lastPollEndAt: now });
	}

	acknowledgeDeliveries(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		if (uniqueJobIds.length === 0) return 0;

		for (const jobId of uniqueJobIds) {
			this.#suppressedDeliveries.add(jobId);
		}

		const before = this.#deliveries.length;
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId)),
		);
		return before - this.#deliveries.length;
	}

	/**
	 * Lift a foreground-wait suppression set via `acknowledgeDeliveries`. If the
	 * job already finished while suppressed (its delivery enqueue was skipped),
	 * re-enqueue the completion so the result is still delivered exactly once.
	 */
	resumeDeliveries(jobIds: string[]): void {
		for (const rawId of jobIds) {
			const jobId = rawId.trim();
			if (!jobId) continue;
			if (!this.#suppressedDeliveries.delete(jobId)) continue;
			const job = this.#jobs.get(jobId);
			if (!job || (job.status !== "completed" && job.status !== "failed")) continue;
			const queued =
				this.#deliveries.some(delivery => delivery.jobId === jobId) ||
				this.#inFlightDeliveries.some(delivery => delivery.jobId === jobId);
			if (queued) continue;
			this.#enqueueDelivery(jobId, job.status === "completed" ? (job.resultText ?? "") : (job.errorText ?? ""));
		}
	}

	/**
	 * Cancel running jobs. With `filter.ownerId` set, cancels only jobs the
	 * matching agent registered; with no filter, cancels every running job
	 * (used by `dispose()` to nuke the manager's state).
	 */
	cancelAll(filter?: AsyncJobFilter): void {
		for (const job of this.getRunningJobs(filter)) {
			if (job.transientTaskSettlementBlock) continue;
			job.status = "cancelled";
			job.abortController.abort();
			if (!job.transientTaskSettlementManaged) this.#scheduleEviction(job.id);
		}
	}

	/**
	 * Immediately evict completed and failed jobs matching the filter instead of
	 * waiting for retention expiry, dropping every queued delivery so a prior
	 * session's result can never be injected into a later transcript. Returns the
	 * number of jobs evicted.
	 *
	 * A delivery whose sink call is already in flight (or drained onto a caller's
	 * yield queue) is guarded by the owner's delivery generation, not the per-id
	 * suppression marker — that marker is cleared when the id is reused.
	 */
	evictCompletedJobs(filter?: AsyncJobFilter): number {
		let evicted = 0;
		for (const job of this.#filterJobs(this.#jobs.values(), filter)) {
			if (job.status !== "completed" && job.status !== "failed") continue;
			if (job.transientTaskSettlementManaged) continue;
			this.acknowledgeDeliveries([job.id]);
			if (this.#evictJob(job.id)) evicted += 1;
		}
		return evicted;
	}

	async waitForAll(): Promise<void> {
		await Promise.all(Array.from(this.#jobs.values()).map(job => job.promise));
	}

	/**
	 * Route completions for jobs owned by `ownerId` to `sink`. Sessions register
	 * their own sink at construction and unregister on dispose. Owned deliveries
	 * with no live sink are dead-lettered — `onJobComplete` serves only unowned
	 * deliveries.
	 *
	 * Last registration wins for an owner id; the returned unregister clears the
	 * mapping only while it still points at `sink`, so a revived session's fresh
	 * registration survives its parked predecessor's late cleanup.
	 */
	registerDeliverySink(ownerId: string, sink: AsyncJobDeliverySink): () => void {
		this.#deliverySinks.set(ownerId, sink);
		return () => {
			if (this.#deliverySinks.get(ownerId) === sink) this.#deliverySinks.delete(ownerId);
		};
	}

	/**
	 * Bind the one managed settlement sink for an owner. Unlike ordinary result
	 * delivery, a second live binding is rejected. The returned async release
	 * retires only this exact binding and resolves after its callbacks and owner
	 * queue are fenced. Retained durable handoffs replay in recovery source order.
	 */
	registerManagedCompletionSink(ownerId: string, sink: ManagedAsyncJobCompletionSink): () => Promise<void> {
		if (this.#disposed) throw new Error("Async job manager is disposed");
		if (this.#managedCompletionSinks.has(ownerId)) {
			throw new Error(`Managed completion sink is already registered for owner: ${ownerId}`);
		}
		const binding: ManagedCompletionSinkBinding = {
			ownerId,
			sink,
			inFlight: new Set(),
			retired: Promise.withResolvers<void>(),
			active: true,
		};
		this.#managedCompletionSinks.set(ownerId, binding);
		void this.#notifyRetainedManagedCompletions(ownerId);
		return () => this.#releaseManagedCompletionSink(binding);
	}

	#releaseManagedCompletionSink(binding: ManagedCompletionSinkBinding): Promise<void> {
		if (binding.releasePromise) return binding.releasePromise;
		binding.active = false;
		binding.retired.resolve();
		binding.releasePromise = (async () => {
			for (;;) {
				const callbacks = Array.from(binding.inFlight);
				if (callbacks.length > 0) await Promise.all(callbacks);
				const tail = this.#managedCompletionTails.get(binding.ownerId);
				if (tail) await tail;
				if (binding.inFlight.size === 0 && this.#managedCompletionTails.get(binding.ownerId) === undefined) break;
			}
			if (this.#managedCompletionSinks.get(binding.ownerId) === binding) {
				this.#managedCompletionSinks.delete(binding.ownerId);
			}
		})();
		return binding.releasePromise;
	}

	async #drainManagedCompletions(): Promise<void> {
		await Promise.all(
			Array.from(this.#managedCompletionSinks.values(), binding => this.#releaseManagedCompletionSink(binding)),
		);
		for (;;) {
			const work = new Set<Promise<void>>([
				...this.#managedCompletionInFlight.values(),
				...this.#managedCompletionTails.values(),
			]);
			if (work.size === 0) return;
			await Promise.all(work);
		}
	}

	bindTransientTaskParentResultDeliveryStore(
		capability: TransientTaskParentResultDeliveryStoreCapabilityV1,
	): AsyncJobManagerTransientTaskSettlementStoreBindResultV1 {
		if (this.#disposed) return { status: "owner_session_conflict", release: null };
		const keys = transientTaskOwnerSessionKeys(capability.ownerSessionIndex);
		if (!keys) return { status: "owner_session_conflict", release: null };

		const currentTupleKey = this.#transientTaskOwnerSessions.get(keys.ownerSessionKey);
		if (currentTupleKey !== undefined) {
			const current = this.#transientTaskParentResultDeliveryStores.get(currentTupleKey);
			if (currentTupleKey !== keys.tupleKey || current?.store !== capability.store)
				return { status: "owner_session_conflict", release: null };
			return { status: "bound", release: this.#transientTaskParentResultDeliveryStoreRelease(current) };
		}

		const binding: TransientTaskParentResultDeliveryStoreBinding = {
			ownerSessionKey: keys.ownerSessionKey,
			tupleKey: keys.tupleKey,
			store: capability.store,
		};
		this.#transientTaskParentResultDeliveryStores.set(keys.tupleKey, binding);
		this.#transientTaskOwnerSessions.set(keys.ownerSessionKey, keys.tupleKey);
		return { status: "bound", release: this.#transientTaskParentResultDeliveryStoreRelease(binding) };
	}

	resolveTransientTaskParentResultDeliveryStore(
		ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1,
	): AsyncJobManagerTransientTaskSettlementStoreResolveResultV1 {
		if (this.#disposed) return { status: "absent", store: null };
		const keys = transientTaskOwnerSessionKeys(ownerSessionIndex);
		if (!keys) return { status: "owner_session_conflict", store: null };
		const currentTupleKey = this.#transientTaskOwnerSessions.get(keys.ownerSessionKey);
		if (currentTupleKey === undefined) return { status: "absent", store: null };
		if (currentTupleKey !== keys.tupleKey) return { status: "owner_session_conflict", store: null };
		const binding = this.#transientTaskParentResultDeliveryStores.get(keys.tupleKey);
		return binding ? { status: "resolved", store: binding.store } : { status: "absent", store: null };
	}

	#transientTaskParentResultDeliveryStoreRelease(binding: TransientTaskParentResultDeliveryStoreBinding): () => void {
		return () => {
			if (this.#transientTaskParentResultDeliveryStores.get(binding.tupleKey) !== binding) return;
			this.#transientTaskParentResultDeliveryStores.delete(binding.tupleKey);
			if (this.#transientTaskOwnerSessions.get(binding.ownerSessionKey) === binding.tupleKey)
				this.#transientTaskOwnerSessions.delete(binding.ownerSessionKey);
		};
	}

	/**
	 * Wait until every job owned by `ownerId` has settled — its run promise
	 * resolved, which for cancelled jobs means the underlying process actually
	 * exited. Jobs registered while waiting (e.g. by a follow-up turn) are
	 * awaited too. Returns false when `timeoutMs` elapses first.
	 *
	 * `excludeSuppressed` skips jobs whose delivery is suppressed (acknowledged
	 * or `hub`-watched): those can never re-wake a run, so quiescence barriers
	 * pass it to share one contract with the pending-async-wake predicate.
	 * Teardown reaps omit it — worktree safety concerns every owner process.
	 */
	async waitForOwnerJobs(
		ownerId: string,
		options?: { timeoutMs?: number; excludeSuppressed?: boolean },
	): Promise<boolean> {
		const deadline =
			options?.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + Math.max(0, options.timeoutMs);
		const awaited = new Set<string>();
		for (;;) {
			const pending = this.#filterJobs(this.#jobs.values(), { ownerId }).filter(
				job => !awaited.has(job.id) && (options?.excludeSuppressed !== true || !this.isDeliverySuppressed(job.id)),
			);
			if (pending.length === 0) return true;
			for (const job of pending) awaited.add(job.id);
			const settled = await this.#waitForDeliveryPromise(
				Promise.all(pending.map(job => job.promise)).then(() => {}),
				deadline,
			);
			if (!settled) return false;
		}
	}

	async #waitForAllUntil(deadline: number): Promise<boolean> {
		const promises = Array.from(this.#jobs.values()).map(job => job.promise);
		if (promises.length === 0) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await Promise.all(promises);
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;

		const timeout = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => timeout.resolve("timeout"), remainingMs);
		timer.unref();
		try {
			const result = await Promise.race([Promise.all(promises).then(() => "settled" as const), timeout.promise]);
			return result === "settled";
		} finally {
			clearTimeout(timer);
		}
	}

	async drainDeliveries(options?: { timeoutMs?: number; filter?: AsyncJobFilter }): Promise<boolean> {
		const timeoutMs = options?.timeoutMs;
		const filter = options?.filter;
		const hasDeadline = timeoutMs !== undefined;
		const deadline = hasDeadline ? Date.now() + Math.max(timeoutMs, 0) : Number.POSITIVE_INFINITY;

		while (this.hasPendingDeliveries(filter)) {
			if (filter?.ownerId) {
				const delivered = await this.#deliverNextFiltered(filter, deadline);
				if (delivered) continue;
				return false;
			}
			const inFlightDeliveries = this.#filterInFlightDeliveries();
			if (inFlightDeliveries.length > 0 && this.#filterDeliveries().length === 0) {
				const delivered = await this.#waitForDeliveryPromise(inFlightDeliveries[0]?.promise, deadline);
				if (delivered) continue;
				return false;
			}

			this.#ensureDeliveryLoop();
			const loop = this.#deliveryLoop;
			if (!loop) {
				continue;
			}

			if (!hasDeadline) {
				await loop;
				continue;
			}

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}

			await Promise.race([loop, Bun.sleep(remainingMs)]);
			if (Date.now() >= deadline && this.hasPendingDeliveries(filter)) {
				return false;
			}
		}

		return true;
	}

	async dispose(options?: { timeoutMs?: number }): Promise<boolean> {
		this.#disposed = true;
		const managedDrain = this.#drainManagedCompletions();
		this.#clearEvictionTimers();
		this.cancelAll();
		const timeoutMs = Math.max(options?.timeoutMs ?? 3_000, 0);
		const deadline = Date.now() + timeoutMs;
		const jobsSettled = await this.#waitForAllUntil(deadline);
		const drained = await this.drainDeliveries({ timeoutMs: Math.max(deadline - Date.now(), 0) });
		const managedDrained = await this.#waitForDeliveryPromise(managedDrain, deadline);
		this.#clearEvictionTimers();
		this.#jobs.clear();
		this.#deliveries.length = 0;
		this.#inFlightDeliveries.length = 0;
		this.#suppressedDeliveries.clear();
		this.#watchedJobs.clear();
		this.#pollEscalation.clear();
		this.#deliverySinks.clear();
		this.#transientTaskParentResultDeliveryStores.clear();
		this.#transientTaskOwnerSessions.clear();
		this.#managedCompletionSinks.clear();
		this.#managedCompletionDelivered.clear();
		this.#managedCompletionInFlight.clear();
		this.#managedCompletionTails.clear();
		return jobsSettled && drained && managedDrained;
	}

	#resolveJobId(preferredId?: string): string {
		preferredId = preferredId?.trim();
		if (!preferredId) {
			let candidate = 1;
			while (true) {
				const id = `bg_${candidate}`;
				if (!this.#jobs.has(id)) {
					return id;
				}
				candidate += 1;
			}
		}

		const base = preferredId.trim();
		if (!this.#jobs.has(base)) return base;

		let suffix = 2;
		let candidate = `${base}-${suffix}`;
		while (this.#jobs.has(candidate)) {
			suffix += 1;
			candidate = `${base}-${suffix}`;
		}
		return candidate;
	}

	#evictJob(jobId: string): boolean {
		clearTimeout(this.#evictionTimers.get(jobId));
		this.#evictionTimers.delete(jobId);
		this.#suppressedDeliveries.delete(jobId);
		this.#watchedJobs.delete(jobId);
		const job = this.#jobs.get(jobId);
		const evicted = this.#jobs.delete(jobId);
		const handoffSha256 = job?.transientTaskCompletion?.handoffSha256;
		if (evicted && handoffSha256) {
			const inFlight = this.#managedCompletionInFlight.get(handoffSha256);
			if (inFlight) {
				void inFlight.finally(() => {
					for (const candidate of this.#jobs.values()) {
						if (candidate.transientTaskCompletion?.handoffSha256 === handoffSha256) return;
					}
					this.#managedCompletionDelivered.delete(handoffSha256);
				});
			} else {
				this.#managedCompletionDelivered.delete(handoffSha256);
			}
		}
		return evicted;
	}

	#scheduleEviction(jobId: string): void {
		if (this.#disposed) return;
		if (this.#retentionMs <= 0) {
			this.#evictJob(jobId);
			return;
		}
		const existing = this.#evictionTimers.get(jobId);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.#evictJob(jobId);
		}, this.#retentionMs);
		timer.unref();
		this.#evictionTimers.set(jobId, timer);
	}

	#clearEvictionTimers(): void {
		for (const timer of this.#evictionTimers.values()) {
			clearTimeout(timer);
		}
		this.#evictionTimers.clear();
	}

	#filterDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId));
		return this.#deliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.isDeliverySuppressed(delivery.jobId),
		);
	}

	#filterInFlightDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return this.#inFlightDeliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId));
		return this.#inFlightDeliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.isDeliverySuppressed(delivery.jobId),
		);
	}

	async #deliverNextFiltered(filter: AsyncJobFilter, deadline: number): Promise<boolean> {
		while (true) {
			let selected: AsyncJobDelivery | undefined;
			for (const delivery of this.#deliveries) {
				if (delivery.ownerId !== filter.ownerId) continue;
				if (this.isDeliverySuppressed(delivery.jobId)) continue;
				if (!selected || delivery.nextAttemptAt < selected.nextAttemptAt) {
					selected = delivery;
				}
			}

			if (!selected) {
				const inFlight = this.#filterInFlightDeliveries(filter);
				if (inFlight.length === 0) return true;
				return this.#waitForDeliveryPromise(inFlight[0]?.promise, deadline);
			}

			const now = Date.now();
			if (selected.nextAttemptAt > now) {
				if (selected.nextAttemptAt > deadline) return false;
				await Bun.sleep(selected.nextAttemptAt - now);
				continue;
			}

			const index = this.#deliveries.indexOf(selected);
			if (index === -1) continue;
			this.#deliveries.splice(index, 1);
			if (this.isDeliverySuppressed(selected.jobId)) continue;

			return this.#waitForDeliveryPromise(this.#deliverDelivery(selected), deadline);
		}
	}

	isDeliverySuppressed(jobId: string): boolean {
		return this.#suppressedDeliveries.has(jobId) || this.#watchedJobs.has(jobId);
	}

	#enqueueDelivery(jobId: string, text: string): void {
		// Skip delivery if already acknowledged
		if (this.isDeliverySuppressed(jobId)) {
			return;
		}
		this.#deliveries.push({
			jobId,
			text,
			attempt: 0,
			nextAttemptAt: Date.now(),
			ownerId: this.#jobs.get(jobId)?.ownerId,
		});
		this.#ensureDeliveryLoop();
	}

	#ensureDeliveryLoop(): void {
		if (this.#deliveryLoop) {
			return;
		}

		this.#deliveryLoop = this.#runDeliveryLoop()
			.catch(error => {
				logger.error("Async job delivery loop crashed", { error: String(error) });
			})
			.finally(() => {
				this.#deliveryLoop = undefined;
				if (this.#deliveries.length > 0) {
					this.#ensureDeliveryLoop();
				}
			});
	}

	async #runDeliveryLoop(): Promise<void> {
		while (this.#deliveries.length > 0) {
			const delivery = this.#deliveries[0];
			if (this.isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				continue;
			}
			const waitMs = delivery.nextAttemptAt - Date.now();
			if (waitMs > 0) {
				await Bun.sleep(waitMs);
			}
			if (this.#deliveries[0] !== delivery) {
				continue;
			}
			if (this.isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				continue;
			}

			this.#deliveries.shift();
			await this.#deliverDelivery(delivery);
		}
	}

	async #notifyRetainedManagedCompletions(ownerId: string): Promise<void> {
		const retained = Array.from(this.#jobs.values())
			.filter(
				(
					job,
				): job is AsyncJob & { transientTaskRecoveryRecord: ConfidentialAsyncJobTransientTaskRecoveryRecordV1 } =>
					job.ownerId === ownerId && job.transientTaskRecoveryRecord?.recoveryState === "handoff_ready",
			)
			.sort((left, right) => left.startTime - right.startTime || left.id.localeCompare(right.id));
		const notifications = retained.map(job =>
			this.#notifyManagedCompletion(this.#transientTaskSettledRow(job, job.transientTaskRecoveryRecord), job),
		);
		await Promise.all(notifications);
	}

	#notifyManagedCompletion(row: ManagedAsyncJobCompletionRow, job: AsyncJob): Promise<void> {
		const handoff = row.transientTaskCompletion;
		if (this.#disposed || handoff.terminalStatus === "cancelled") return Promise.resolve();
		if (this.#managedCompletionDelivered.has(handoff.handoffSha256)) return Promise.resolve();
		const existing = this.#managedCompletionInFlight.get(handoff.handoffSha256);
		if (existing) return existing;

		const previous = this.#managedCompletionTails.get(row.ownerId) ?? Promise.resolve();
		let notification: Promise<void>;
		notification = previous
			.then(() => this.#deliverManagedCompletion(row, job))
			.finally(() => {
				if (this.#managedCompletionInFlight.get(handoff.handoffSha256) === notification) {
					this.#managedCompletionInFlight.delete(handoff.handoffSha256);
				}
				if (this.#managedCompletionTails.get(row.ownerId) === notification) {
					this.#managedCompletionTails.delete(row.ownerId);
				}
			});
		this.#managedCompletionInFlight.set(handoff.handoffSha256, notification);
		this.#managedCompletionTails.set(row.ownerId, notification);
		return notification;
	}

	async #deliverManagedCompletion(row: ManagedAsyncJobCompletionRow, job: AsyncJob): Promise<void> {
		const handoffSha256 = row.transientTaskCompletion.handoffSha256;
		let attempt = 0;
		for (;;) {
			if (this.#disposed || this.#managedCompletionDelivered.has(handoffSha256)) return;
			const binding = this.#managedCompletionSinks.get(row.ownerId);
			if (!binding?.active) return;

			const callback = (async (): Promise<ManagedAsyncJobCompletionAcknowledgement | null> => {
				try {
					return await binding.sink(row, job);
				} catch (error) {
					logger.warn("Managed async job completion notification failed", {
						jobId: row.jobId,
						ownerId: row.ownerId,
						error: error instanceof Error ? error.message : String(error),
					});
					return null;
				}
			})();
			const callbackFence = callback.then(() => {});
			binding.inFlight.add(callbackFence);
			let acknowledgement: ManagedAsyncJobCompletionAcknowledgement | null;
			try {
				acknowledgement = await callback;
			} finally {
				binding.inFlight.delete(callbackFence);
			}
			if (this.#disposed || !binding.active || this.#managedCompletionSinks.get(row.ownerId) !== binding) return;
			if (acknowledgement?.handoffSha256 === handoffSha256 && acknowledgement.status === "committed") {
				this.#managedCompletionDelivered.add(handoffSha256);
				return;
			}
			if (acknowledgement && acknowledgement.handoffSha256 !== handoffSha256) {
				logger.warn("Managed async job completion acknowledgement did not match handoff", {
					jobId: row.jobId,
					ownerId: row.ownerId,
					expectedHandoffSha256: handoffSha256,
					acknowledgedHandoffSha256: acknowledgement.handoffSha256,
				});
			}
			attempt += 1;
			const retryMs = Math.min(DELIVERY_RETRY_MAX_MS, DELIVERY_RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 8));
			await Promise.race([Bun.sleep(retryMs), binding.retired.promise]);
		}
	}

	/**
	 * Resolve the sink for one delivery attempt: owned deliveries route ONLY to
	 * their owner's registered sink (a missing sink dead-letters — never the
	 * default, which would misroute a dead owner's result into another
	 * session); unowned deliveries use the constructor default. Resolved per
	 * attempt so a sink registered between retries (e.g. a revived session)
	 * picks up the retry.
	 */
	#resolveDeliverySink(ownerId: string | undefined): AsyncJobDeliverySink | undefined {
		if (ownerId !== undefined) return this.#deliverySinks.get(ownerId);
		return this.#onJobComplete;
	}

	#deliverDelivery(delivery: AsyncJobDelivery): Promise<void> {
		const sink = this.#resolveDeliverySink(delivery.ownerId);
		if (!sink) {
			// Dead-letter: owned delivery with no live sink (session disposed or
			// parked), or unowned delivery with no default sink. Drop it — the
			// job row keeps its result/error text until retention eviction, so
			// the outcome stays inspectable via job queries and agent:// reads.
			logger.warn("Async job delivery dead-lettered: no delivery sink", {
				jobId: delivery.jobId,
				ownerId: delivery.ownerId,
			});
			delivery.promise = Promise.resolve();
			return delivery.promise;
		}
		const promise = (async () => {
			this.#inFlightDeliveries.push(delivery);
			try {
				await sink(delivery.jobId, delivery.text, this.#jobs.get(delivery.jobId));
			} catch (error) {
				delivery.attempt += 1;
				delivery.lastError = error instanceof Error ? error.message : String(error);
				delivery.nextAttemptAt = Date.now() + this.#getRetryDelay(delivery.attempt);
				if (!this.isDeliverySuppressed(delivery.jobId)) {
					this.#deliveries.push(delivery);
				}
				logger.warn("Async job completion delivery failed", {
					jobId: delivery.jobId,
					attempt: delivery.attempt,
					nextRetryAt: delivery.nextAttemptAt,
					error: delivery.lastError,
				});
			} finally {
				const index = this.#inFlightDeliveries.indexOf(delivery);
				if (index !== -1) this.#inFlightDeliveries.splice(index, 1);
				if (this.#deliveries.length > 0) this.#ensureDeliveryLoop();
			}
		})();
		delivery.promise = promise;
		return promise;
	}

	async #waitForDeliveryPromise(promise: Promise<void> | undefined, deadline: number): Promise<boolean> {
		if (!promise) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await promise;
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;
		let timedOut = false;
		await Promise.race([
			promise,
			Bun.sleep(remainingMs).then(() => {
				timedOut = true;
			}),
		]);
		return !timedOut;
	}

	#getRetryDelay(attempt: number): number {
		const exp = Math.min(Math.max(attempt - 1, 0), 8);
		const backoffMs = DELIVERY_RETRY_BASE_MS * 2 ** exp;
		const jitterMs = Math.floor(Math.random() * DELIVERY_RETRY_JITTER_MS);
		return Math.min(DELIVERY_RETRY_MAX_MS, backoffMs + jitterMs);
	}
}
