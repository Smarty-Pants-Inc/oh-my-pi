import { createHash, randomUUID } from "node:crypto";
import type {
	FrozenCheckpointId,
	ISO8601,
	KnownReplicaCacheEvictionProgressV1,
	KnownReplicaRecordV1,
	ManagedWorkspaceRef,
	OperationId,
	PersistentAgentOwnership,
	PersistentAgentRecordCommitGuardV1,
	PersistentAgentRecordV1,
	PersistentWorkspaceAuthorityV1,
	ReplicaId,
	RuntimeFenceId,
	RuntimeLeaseId,
	WorkspaceCheckpoint,
	Sha256Ref,
	WorkspaceId,
	WorkspaceOperationLeaseId,
} from "../registry/persistent-agent-contracts.js";
import { appendKnownReplicaV1, replaceKnownReplicaV1 } from "../registry/persistent-agent-store.js";
import {
	addMilliseconds,
	exactJson,
	nowIso,
	runtimeLeaseMatches,
	runtimeTimingReadersV1,
	workspaceImagesMatch,
} from "./workspace-controller-codecs.js";
import type { RuntimeProviderConfigurationV1 } from "./workspace-provider-registry.js";
import { discoverRuntimeProviders } from "./workspace-provider-registry.js";
import type {
	AdaptiveRuntimeEventV1,
	CanonicalWorkspaceStore,
	RuntimeAcquisitionPlan,
	RuntimeAttachment,
	RuntimeAttachmentRecordV1,
	RuntimeAttachmentStore,
	RuntimeBinding,
	RuntimeCheckpointPublicationProjection,
	RuntimeController,
	RuntimeDiscardRuntimeChangesAuthorization,
	RuntimeDiscardRuntimeChangesResult,
	RuntimeDrainCacheEvictionProgress,
	RuntimeDrainPlan,
	RuntimeFence,
	RuntimeLeasePlan,
	RuntimeLeaseRef,
	RuntimeLeaseReleaseInspectRequest,
	RuntimeLeaseReleaseResult,
	RuntimeLeaseRenewalPlan,
	RuntimeLeaseRenewalReceipt,
	RuntimeProvider,
	RuntimeProviderRegistry,
	RuntimeRecoveryFreezeResult,
	RuntimeReplicaCacheEvictionAcceptance,
	RuntimeReplicaCacheEvictionCompletion,
	RuntimeReplicaCacheEvictionInspectResult,
	RuntimeReplicaCacheEvictionPlan,
	RuntimeReplicaCacheEvictionRequestResult,
	RuntimeRequirements,
	RuntimeScheduler,
	RuntimeSchedulerStatusSnapshot,
	RuntimeStatusSnapshot,
	RuntimeTransitionReason,
	RuntimeTransitionStatusSnapshot,
	WorkspaceControllerLease,
	WorkspaceControllerLeaseStore,
	WorkspaceOperationLease,
} from "./workspace-runtime-contracts.js";
import {
	canonicalRuntimeProviderInspectionSha256V1,
	canonicalRuntimeSha256,
	deriveProviderSubrequestId,
} from "./workspace-runtime-contracts.js";

export * from "./ordinary-transient-task-environment-release-store.js";
export * from "./persistent-workspace-authority-store.js";
export * from "./runtime-attachment-file-store.js";
export * from "./transient-task-isolation-creator-store.js";
export * from "./transient-task-outcome-payload-store.js";
export * from "./transient-task-parent-result-delivery-store.js";
export * from "./transient-task-pending-capture-index-store.js";
export * from "./transient-task-publication-target-binding-store.js";
export * from "./transient-task-result-publication-store.js";
export * from "./transient-task-result-publication-target-store.js";
export * from "./transient-task-source-observation-store.js";
export * from "./transient-task-workspace-authority-store.js";
export type {
	DurableTransientTaskForegroundAppendDeliveryBatchInspectResultV1,
	DurableTransientTaskForegroundAppendDeliveryBatchStateAuthorityV1,
	OrdinaryTransientTaskExecutionEnvironmentReleaseStartupResultV1,
	RuntimeControllerDependenciesV1,
	RuntimeTransientAuthorityV1,
	TransientTaskResultPublicationDeliveryResultV1,
	TransientTaskResultPublicationDeliveryV1,
	TransientTaskRuntimeStoreFacadeV1,
} from "./workspace-controller-codecs.js";
export {
	canonicalTransientTaskForegroundAppendDeliveryBatchCoordinatorRequestSha256V1,
	canonicalTransientTaskForegroundAppendDeliveryBatchInspectRequestSha256V1,
	canonicalTransientTaskForegroundAppendDeliveryBatchReplayAdoptRequestSha256V1,
	isDurableTransientTaskWorktreePublicationTargetHandleV1,
	resolveDurableTransientTaskIsolationCleanupHandleV1,
	resolveDurableTransientTaskWorktreePublicationTargetHandleV1,
} from "./workspace-controller-codecs.js";

export abstract class WorkspaceRuntimeControllerBaseV1 implements RuntimeController {
	abstract beginWorkspaceOperation(
		requirements: RuntimeRequirements,
		operationLeaseId: WorkspaceOperationLeaseId,
		signal?: AbortSignal,
	): Promise<WorkspaceOperationLease>;
	abstract drainToNone(
		reason: RuntimeTransitionReason,
		commitReplica: boolean,
		signal?: AbortSignal,
	): Promise<WorkspaceCheckpoint>;
	abstract status(signal?: AbortSignal): Promise<RuntimeStatusSnapshot>;
}

export interface WorkspaceRuntimeControllerOptionsV1 {
	readonly workspaceId: WorkspaceId;
	readonly ownership: PersistentAgentOwnership;
	readonly controllerLeaseStore: WorkspaceControllerLeaseStore;
	readonly controllerLease: WorkspaceControllerLease;
	readonly controllerLeaseTtlMs: number;
	readonly runtimeLeaseTtlMs: number;
	readonly commitGuard: PersistentAgentRecordCommitGuardV1;
	readonly attachmentStore: RuntimeAttachmentStore;
	readonly canonicalStore: CanonicalWorkspaceStore;
	readonly registry: RuntimeProviderRegistry;
	readonly cacheEvictionDelayMsByProvider?: Readonly<Record<string, number>>;
	readonly scheduler: RuntimeScheduler;
	readonly providerConfigurations: readonly RuntimeProviderConfigurationV1[];
	readonly now?: () => ISO8601;
	readonly identity?: () => string;
	readonly fenceToken?: () => string;
	readonly emitAdaptiveRuntimeEvent?: (event: AdaptiveRuntimeEventV1) => void;
}

function recordWorkspaceAuthority(record: PersistentAgentRecordV1): PersistentWorkspaceAuthorityV1 {
	if (record.phase === "creating") throw new Error("Persistent workspace authority is not yet available");
	if (record.phase !== "recovery_required") return record.workspace;
	if (record.recovery.failedPhase === "creating")
		throw new Error("Persistent workspace authority is not yet available");
	return record.recovery.workspace;
}

function replaceRecordWorkspaceAuthority(
	record: PersistentAgentRecordV1,
	workspace: PersistentWorkspaceAuthorityV1,
	updatedAt: ISO8601,
): PersistentAgentRecordV1 {
	const revision = record.revision + 1;
	if (!Number.isSafeInteger(revision)) throw new RangeError("Persistent agent revision overflow");
	switch (record.phase) {
		case "creating":
			throw new Error("Cannot publish runtime state before persistent workspace creation");
		case "open":
		case "parked":
		case "reviving":
		case "forking":
		case "parking":
		case "released":
			return { ...record, revision, updatedAt, workspace };
		case "releasing": {
			const progress = record.operation.progress;
			const operation =
				progress.step === "planned"
					? record.operation
					: { ...record.operation, progress: { ...progress, workspace } };
			return { ...record, revision, updatedAt, workspace, operation };
		}
		case "recovery_required": {
			if (record.recovery.failedPhase === "creating") {
				throw new Error("Cannot publish runtime state without persistent workspace authority");
			}
			return { ...record, revision, updatedAt, recovery: { ...record.recovery, workspace } };
		}
	}
}

function emptySchedulerStatus(): RuntimeSchedulerStatusSnapshot {
	return {
		input: null,
		providers: [],
		candidates: [],
		decision: { status: "not_evaluated" },
		evaluatedAt: null,
		durationMs: null,
	};
}

function adaptiveRuntimeIdentityHash(value: string): Sha256Ref {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}` as Sha256Ref;
}

export class WorkspaceRuntimeControllerV1 extends WorkspaceRuntimeControllerBaseV1 {
	readonly #workspaceId: WorkspaceId;
	readonly #ownership: PersistentAgentOwnership;
	readonly #controllerLeaseStore: WorkspaceControllerLeaseStore;
	readonly #controllerLeaseTtlMs: number;
	readonly #runtimeLeaseTtlMs: number;
	readonly #commitGuard: PersistentAgentRecordCommitGuardV1;
	readonly #attachmentStore: RuntimeAttachmentStore;
	readonly #canonicalStore: CanonicalWorkspaceStore;
	readonly #registry: RuntimeProviderRegistry;
	readonly #scheduler: RuntimeScheduler;
	readonly #providerConfigurations: readonly RuntimeProviderConfigurationV1[];
	readonly #cacheEvictionDelayMsByProvider: Readonly<Record<string, number>>;
	readonly #now: () => ISO8601;
	readonly #identity: () => string;
	readonly #fenceToken: () => string;
	readonly #emitAdaptiveRuntimeEvent: ((event: AdaptiveRuntimeEventV1) => void) | undefined;
	readonly #agentIdHash: Sha256Ref;
	readonly #workspaceIdHash: Sha256Ref;
	readonly #activeOperations = new Set<WorkspaceOperationLeaseId>();
	readonly #zeroOperationWaiters = new Set<() => void>();
	#controllerLease: WorkspaceControllerLease;
	#binding: RuntimeBinding | null = null;
	#admissionClosed = false;
	#serialTail: Promise<void> = Promise.resolve();

	constructor(options: WorkspaceRuntimeControllerOptionsV1) {
		super();
		if (
			options.controllerLease.proof.workspaceId !== options.workspaceId ||
			options.controllerLeaseTtlMs <= 0 ||
			!Number.isSafeInteger(options.controllerLeaseTtlMs) ||
			options.runtimeLeaseTtlMs <= 0 ||
			!Number.isSafeInteger(options.runtimeLeaseTtlMs) ||
			(options.emitAdaptiveRuntimeEvent !== undefined && typeof options.emitAdaptiveRuntimeEvent !== "function")
		)
			throw new TypeError("Invalid runtime controller configuration");
		this.#workspaceId = options.workspaceId;
		this.#ownership = options.ownership;
		this.#controllerLeaseStore = options.controllerLeaseStore;
		this.#controllerLease = options.controllerLease;
		this.#controllerLeaseTtlMs = options.controllerLeaseTtlMs;
		this.#runtimeLeaseTtlMs = options.runtimeLeaseTtlMs;
		this.#commitGuard = options.commitGuard;
		this.#attachmentStore = options.attachmentStore;
		this.#canonicalStore = options.canonicalStore;
		this.#registry = options.registry;
		this.#scheduler = options.scheduler;
		this.#providerConfigurations = options.providerConfigurations;
		this.#now = options.now ?? nowIso;
		this.#identity = options.identity ?? randomUUID;
		this.#fenceToken = options.fenceToken ?? randomUUID;
		this.#emitAdaptiveRuntimeEvent = options.emitAdaptiveRuntimeEvent;
		this.#agentIdHash = adaptiveRuntimeIdentityHash(options.controllerLease.proof.agentId);
		this.#workspaceIdHash = adaptiveRuntimeIdentityHash(options.workspaceId);
		this.#cacheEvictionDelayMsByProvider = options.cacheEvictionDelayMsByProvider ?? {};
	}

	async #serialized<Result>(signal: AbortSignal | undefined, action: () => Promise<Result>): Promise<Result> {
		const predecessor = this.#serialTail;
		let release = (): void => undefined;
		this.#serialTail = new Promise<void>(resolve => {
			release = resolve;
		});
		await predecessor;
		try {
			if (signal?.aborted)
				throw signal.reason instanceof Error ? signal.reason : new Error("Runtime operation aborted");
			return await action();
		} finally {
			release();
		}
	}

	#validateControllerLease(lease: WorkspaceControllerLease): void {
		const acquiredAt = Date.parse(lease.acquiredAt);
		const renewBy = Date.parse(lease.renewBy);
		const expiresAt = Date.parse(lease.expiresAt);
		if (
			lease.proof.workspaceId !== this.#workspaceId ||
			lease.proof.agentId !== this.#ownership.agentId ||
			lease.proof.controlHostId !== this.#ownership.controlHostId ||
			lease.proof.ownerEpoch !== this.#ownership.ownerEpoch ||
			!Number.isSafeInteger(lease.proof.epoch) ||
			lease.proof.epoch < 1 ||
			!Number.isFinite(acquiredAt) ||
			!Number.isFinite(renewBy) ||
			!Number.isFinite(expiresAt) ||
			acquiredAt > renewBy ||
			renewBy >= expiresAt ||
			expiresAt <= Date.parse(this.#now())
		) {
			throw new Error("Workspace controller lease is invalid or expired");
		}
	}

	#emit(event: AdaptiveRuntimeEventV1): void {
		try {
			this.#emitAdaptiveRuntimeEvent?.(event);
		} catch {
			// Observability is non-authoritative and must not change runtime outcomes.
		}
	}

	#observeRuntimeStatus<Result extends RuntimeStatusSnapshot>(runtime: Result): Result {
		this.#emit({
			schemaVersion: 1,
			timestamp: runtime.observedAt,
			kind: "runtime.status.observed",
			outcome: "succeeded",
			correlationId: this.#identity(),
			agentIdHash: this.#agentIdHash,
			workspaceIdHash: this.#workspaceIdHash,
			details: { runtime },
		});
		return runtime;
	}

	#emitAttachmentEvents(current: RuntimeAttachmentRecordV1, next: RuntimeAttachmentRecordV1): void {
		const attachment = next.attachment;
		if (
			attachment.transitionId !== null &&
			attachment.transitionId !== current.attachment.transitionId &&
			(attachment.state === "acquiring" || attachment.state === "draining")
		) {
			const acquiring = attachment.state === "acquiring";
			const transition: Extract<RuntimeTransitionStatusSnapshot, { status: "in_progress" }> = {
				status: "in_progress",
				currentTransitionId: attachment.transitionId,
				currentReason: acquiring ? "first_tool" : attachment.reason,
				currentFrom: acquiring ? "none" : "active",
				currentTo: acquiring ? "active" : "none",
				currentStartedAt: acquiring && next.scheduler.evaluatedAt !== null ? next.scheduler.evaluatedAt : next.updatedAt,
				currentErrorCode: null,
				lastCompleted: next.lastCompletedTransition,
			};
			this.#emit({
				schemaVersion: 1,
				timestamp: next.updatedAt,
				kind: "runtime.transition.started",
				outcome: "succeeded",
				correlationId: attachment.transitionId,
				agentIdHash: this.#agentIdHash,
				workspaceIdHash: this.#workspaceIdHash,
				details: {
					transition,
					oldProviderId: acquiring ? null : attachment.active.target.candidate.providerId,
					oldProfileId: acquiring ? null : attachment.active.target.candidate.profileId,
					newProviderId: acquiring ? attachment.plan.target.candidate.providerId : null,
					newProfileId: acquiring ? attachment.plan.target.candidate.profileId : null,
					durationMs: null,
				},
			});
		}
		const completed = next.lastCompletedTransition;
		if (completed === null || exactJson(completed, current.lastCompletedTransition)) return;
		const elapsed = Date.parse(completed.completedAt) - Date.parse(completed.startedAt);
		const oldActive =
			current.attachment.state === "active" || current.attachment.state === "draining"
				? current.attachment.active
				: null;
		const newActive = next.attachment.state === "active" ? next.attachment.active : null;
		this.#emit({
			schemaVersion: 1,
			timestamp: completed.completedAt,
			kind: "runtime.transition.completed",
			outcome: "succeeded",
			correlationId: completed.transitionId,
			agentIdHash: this.#agentIdHash,
			workspaceIdHash: this.#workspaceIdHash,
			details: {
				transition: {
					status: "none",
					currentTransitionId: null,
					currentReason: null,
					currentFrom: null,
					currentTo: null,
					currentStartedAt: null,
					currentErrorCode: null,
					lastCompleted: completed,
				},
				oldProviderId: oldActive?.target.candidate.providerId ?? null,
				oldProfileId: oldActive?.target.candidate.profileId ?? null,
				newProviderId: newActive?.target.candidate.providerId ?? null,
				newProfileId: newActive?.target.candidate.profileId ?? null,
				durationMs: Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null,
			},
		});
	}

	async #currentControllerLease(): Promise<WorkspaceControllerLease> {
		if (!this.#ownership.isHeld()) throw new Error("Persistent agent ownership was lost");
		const renewed = await this.#controllerLeaseStore.renew({
			proof: this.#controllerLease.proof,
			ownership: this.#ownership,
			ttlMs: this.#controllerLeaseTtlMs,
		});
		if (renewed.status === "renewed") {
			this.#validateControllerLease(renewed.lease);
			if (!exactJson(renewed.lease.proof, this.#controllerLease.proof)) {
				throw new Error("Workspace controller renewal changed authority identity");
			}
			this.#controllerLease = renewed.lease;
			return renewed.lease;
		}
		const acquired = await this.#controllerLeaseStore.acquire({
			workspaceId: this.#workspaceId,
			ownership: this.#ownership,
			ttlMs: this.#controllerLeaseTtlMs,
		});
		if (acquired.status !== "acquired")
			throw new Error(`Workspace controller authority unavailable: ${acquired.status}`);
		this.#validateControllerLease(acquired.lease);
		this.#controllerLease = acquired.lease;
		return acquired.lease;
	}

	async #persistentRecord(): Promise<{
		readonly record: PersistentAgentRecordV1;
		readonly workspace: PersistentWorkspaceAuthorityV1;
	}> {
		if (!this.#ownership.isHeld()) throw new Error("Persistent agent ownership was lost");
		const lookup = await this.#ownership.read();
		if (lookup.kind !== "record") throw new Error(`Persistent agent record unavailable: ${lookup.kind}`);
		const workspace = recordWorkspaceAuthority(lookup.record);
		if (workspace.workspaceId !== this.#workspaceId) throw new Error("Persistent workspace identity mismatch");
		return { record: lookup.record, workspace };
	}

	async #publishWorkspaceAuthority(
		record: PersistentAgentRecordV1,
		workspace: PersistentWorkspaceAuthorityV1,
	): Promise<void> {
		await this.#currentControllerLease();
		const next = replaceRecordWorkspaceAuthority(record, workspace, this.#now());
		await this.#ownership.replace(record.revision, next, this.#commitGuard);
	}

	async #appendPlannedReplica(replica: KnownReplicaRecordV1): Promise<void> {
		const { record, workspace } = await this.#persistentRecord();
		const existing = workspace.knownReplicas.entries.find(entry => exactJson(entry.replica, replica.replica));
		if (existing) {
			if (!exactJson(existing, replica)) throw new Error("Runtime replica catalog planning conflict");
			return;
		}
		const knownReplicas = appendKnownReplicaV1(workspace.knownReplicas, replica);
		await this.#publishWorkspaceAuthority(record, { ...workspace, knownReplicas });
	}

	async #replaceReplica(
		replica: KnownReplicaRecordV1["replica"],
		replace: (current: KnownReplicaRecordV1) => KnownReplicaRecordV1,
	): Promise<KnownReplicaRecordV1> {
		const { record, workspace } = await this.#persistentRecord();
		const current = workspace.knownReplicas.entries.find(entry => exactJson(entry.replica, replica));
		if (!current) throw new Error("Planned runtime replica is missing from the durable catalog");
		const next = replace(current);
		if (!exactJson(next.replica, current.replica)) throw new Error("Runtime replica catalog identity cannot change");
		if (exactJson(current, next)) return current;
		const knownReplicas = replaceKnownReplicaV1(workspace.knownReplicas, workspace.knownReplicas.revision, next);
		await this.#publishWorkspaceAuthority(record, { ...workspace, knownReplicas });
		return next;
	}

	async #recordReplicaLease(replica: KnownReplicaRecordV1["replica"], lease: RuntimeLeaseRef): Promise<void> {
		await this.#replaceReplica(replica, current => ({
			...current,
			lastLeaseId: lease.leaseId,
			observation: { state: "present", observedAt: this.#now(), image: null },
		}));
	}

	async #publishCanonicalWorkspace(workspaceRef: ManagedWorkspaceRef): Promise<void> {
		const { record, workspace } = await this.#persistentRecord();
		if (workspace.canonical.state !== "present") throw new Error("Canonical workspace is not publishable");
		if (
			workspaceImagesMatch(workspace.canonical.workspace.checkpoint, workspaceRef.checkpoint) &&
			workspace.canonical.workspace.checkpoint.generation === workspaceRef.checkpoint.generation
		)
			return;
		await this.#publishWorkspaceAuthority(record, {
			...workspace,
			canonical: { state: "present", workspace: workspaceRef },
		});
	}

	async #replaceAttachment(
		current: RuntimeAttachmentRecordV1,
		attachment: RuntimeAttachment,
		scheduler: RuntimeSchedulerStatusSnapshot = current.scheduler,
		lastCompletedTransition = current.lastCompletedTransition,
	): Promise<RuntimeAttachmentRecordV1> {
		const controllerLease = await this.#currentControllerLease();
		const next: RuntimeAttachmentRecordV1 = {
			...current,
			revision: current.revision + 1,
			attachment,
			scheduler,
			lastCompletedTransition,
			updatedAt: this.#now(),
		};
		const result = await this.#attachmentStore.replace({
			expectedRevision: current.revision,
			next,
			controllerLease: controllerLease.proof,
		});
		if (result.status !== "replaced") throw new Error(`Runtime attachment publication failed: ${result.status}`);
		this.#emitAttachmentEvents(current, result.record);
		return result.record;
	}

	#bindingMatches(active: RuntimeLeaseRef): boolean {
		return (
			this.#binding !== null &&
			runtimeLeaseMatches(this.#binding.lease, active) &&
			this.#binding.fence.fenceId === active.fenceId
		);
	}

	#operationLease(operationLeaseId: WorkspaceOperationLeaseId): WorkspaceOperationLease {
		if (!this.#binding) throw new Error("Runtime binding is unavailable");
		if (this.#activeOperations.has(operationLeaseId))
			throw new Error("Workspace operation lease identity was reused");
		this.#activeOperations.add(operationLeaseId);
		const binding = this.#binding;
		let ended = false;
		return Object.freeze({
			operationLeaseId,
			binding,
			end: () => {
				if (ended) return;
				ended = true;
				this.#activeOperations.delete(operationLeaseId);
				if (this.#activeOperations.size === 0) {
					for (const waiter of this.#zeroOperationWaiters) waiter();
					this.#zeroOperationWaiters.clear();
				}
			},
		});
	}

	async #waitForZeroOperations(signal?: AbortSignal): Promise<void> {
		if (this.#activeOperations.size === 0) return;
		await new Promise<void>((resolve, reject) => {
			const complete = () => {
				signal?.removeEventListener("abort", abort);
				this.#zeroOperationWaiters.delete(complete);
				resolve();
			};
			const abort = () => {
				this.#zeroOperationWaiters.delete(complete);
				reject(signal?.reason instanceof Error ? signal.reason : new Error("Runtime drain aborted"));
			};
			this.#zeroOperationWaiters.add(complete);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}

	async #schedule(requirements: RuntimeRequirements, current: RuntimeAcquisitionPlan["target"]["candidate"] | null) {
		const started = Date.now();
		const evaluatedAt = this.#now();
		const observations = await discoverRuntimeProviders({
			registry: this.#registry,
			configurations: this.#providerConfigurations,
			requirements,
		});
		const selected = this.#scheduler.select({ requirements, current, providers: observations });
		const input = {
			placement: requirements.placement,
			configuredProviderId: requirements.configuredProviderId,
			workspaceFormat: requirements.workspaceFormat,
			capabilities: requirements.capabilities,
			os: requirements.os,
			arch: requirements.arch,
			minCpu: requirements.minCpu,
			minMemoryMiB: requirements.minMemoryMiB,
			network: requirements.network,
			maxReadyLatencyMs: requirements.maxReadyLatencyMs,
		};
		const scheduler: Exclude<RuntimeSchedulerStatusSnapshot, { decision: { status: "not_evaluated" } }> =
			selected.status === "selected"
				? {
						input,
						providers: selected.providers,
						candidates: selected.candidates,
						decision: {
							status: "selected",
							providerId: selected.candidate.providerId,
							profileId: selected.candidate.profileId,
							retainedCurrent: selected.retainedCurrent,
						},
						evaluatedAt,
						durationMs: Math.max(0, Date.now() - started),
					}
				: {
						input,
						providers: selected.providers,
						candidates: selected.candidates,
						decision: { status: "unsatisfied", unmet: selected.unmet },
						evaluatedAt,
						durationMs: Math.max(0, Date.now() - started),
					};
		const correlationId = this.#identity();
		this.#emit({
			schemaVersion: 1,
			timestamp: evaluatedAt,
			kind: "scheduler.evaluated",
			outcome: "succeeded",
			correlationId,
			agentIdHash: this.#agentIdHash,
			workspaceIdHash: this.#workspaceIdHash,
			details: scheduler,
		});
		if (scheduler.decision.status === "selected") {
			this.#emit({
				schemaVersion: 1,
				timestamp: evaluatedAt,
				kind: "scheduler.selected",
				outcome: "succeeded",
				correlationId,
				agentIdHash: this.#agentIdHash,
				workspaceIdHash: this.#workspaceIdHash,
				details: scheduler as Extract<RuntimeSchedulerStatusSnapshot, { decision: { status: "selected" } }>,
			});
		}
		return { selected, scheduler };
	}

	#validateRenewalReceipt(plan: RuntimeLeaseRenewalPlan, receipt: RuntimeLeaseRenewalReceipt): void {
		const prior = plan.expectedLease;
		const lease = receipt.lease;
		if (
			receipt.renewalId !== plan.renewalId ||
			receipt.sequence !== plan.sequence ||
			!exactJson(receipt.request, plan.request) ||
			!runtimeLeaseMatches(receipt.priorLease, prior) ||
			lease.leaseId !== prior.leaseId ||
			!exactJson(lease.replica, prior.replica) ||
			lease.fenceId !== prior.fenceId ||
			lease.baseGeneration !== prior.baseGeneration ||
			lease.renewalSequence !== plan.sequence ||
			lease.acquiredAt !== prior.acquiredAt ||
			Date.parse(lease.renewBy) <= Date.parse(prior.renewBy) ||
			Date.parse(lease.expiresAt) <= Date.parse(prior.expiresAt) ||
			Date.parse(lease.expiresAt) <= Date.parse(lease.renewBy) ||
			(receipt.providerOutcome !== "renewed" && receipt.providerOutcome !== "already_renewed") ||
			!Number.isFinite(Date.parse(receipt.completedAt))
		) {
			throw new Error("Runtime provider returned an invalid renewal receipt");
		}
	}

	async #completeRenewal(
		record: RuntimeAttachmentRecordV1,
		receipt: RuntimeLeaseRenewalReceipt,
	): Promise<RuntimeAttachmentRecordV1> {
		if (record.attachment.state !== "active") {
			throw new Error("Runtime renewal completion has no durable plan");
		}
		const active = record.attachment.active;
		const plan = active.renewal.plan;
		if (plan === null) throw new Error("Runtime renewal completion has no durable plan");
		this.#validateRenewalReceipt(plan, receipt);
		const next = await this.#replaceAttachment(record, {
			state: "active",
			transitionId: null,
			active: {
				...active,
				lease: receipt.lease,
				renewal: {
					state: "complete",
					currentLease: receipt.lease,
					plan: null,
					lastOutcome: { kind: "renewed", receipt },
				},
			},
			lastDiscardedRuntimeChanges: record.attachment.lastDiscardedRuntimeChanges,
			block: null,
		});
		if (this.#bindingMatches(receipt.priorLease) && this.#binding) {
			this.#binding = Object.freeze({ ...this.#binding, lease: receipt.lease });
		}
		return next;
	}

	async #finishRenewalWithoutTransport(
		record: RuntimeAttachmentRecordV1,
		reason:
			| "cancelled_before_transport"
			| "inspected_absent_before_drain"
			| "inspected_absent_after_owner_loss"
			| "lease_expired"
			| "lease_revoked",
		observedAt: ISO8601,
	): Promise<RuntimeAttachmentRecordV1> {
		if (record.attachment.state !== "active") {
			throw new Error("Runtime renewal terminalization requires an active attachment");
		}
		const active = record.attachment.active;
		const plan = active.renewal.plan;
		if (plan === null) throw new Error("Runtime renewal terminalization has no durable plan");
		return this.#replaceAttachment(record, {
			state: "active",
			transitionId: null,
			active: {
				...active,
				renewal: {
					state: "complete",
					currentLease: active.renewal.currentLease,
					plan: null,
					lastOutcome: { kind: "not_renewed", plan, reason, observedAt },
				},
			},
			lastDiscardedRuntimeChanges: record.attachment.lastDiscardedRuntimeChanges,
			block: null,
		});
	}

	async #planRenewal(record: RuntimeAttachmentRecordV1): Promise<RuntimeAttachmentRecordV1> {
		if (record.attachment.state !== "active" || record.attachment.active.renewal.state !== "complete") {
			throw new Error("Runtime renewal can only be planned from terminal active state");
		}
		const active = record.attachment.active;
		if (!this.#bindingMatches(active.lease)) throw new Error("Runtime renewal requires the live fence owner");
		const renewalId: OperationId = this.#identity();
		const sequence = active.lease.renewalSequence + 1;
		if (!Number.isSafeInteger(sequence)) throw new RangeError("Runtime renewal sequence overflow");
		const requestId = await deriveProviderSubrequestId({
			workspaceId: this.#workspaceId,
			parentKind: "runtime_renewal",
			parentId: renewalId,
			ordinal: 0,
			operation: "renew",
		});
		const requestSha256 = await canonicalRuntimeSha256([
			"omp-runtime-provider-v1",
			"renew",
			renewalId,
			sequence,
			active.lease.replica.providerId,
			active.lease.replica.profileId,
			active.lease.replica.workspaceId,
			active.lease.replica.replicaId,
			active.lease.leaseId,
			active.lease.fenceId,
			active.lease.baseGeneration,
			active.lease.renewalSequence,
			active.lease.acquiredAt,
			active.lease.renewBy,
			active.lease.expiresAt,
			this.#runtimeLeaseTtlMs,
		]);
		const plan: RuntimeLeaseRenewalPlan = {
			renewalId,
			sequence,
			expectedLease: active.lease,
			leaseTtlMs: this.#runtimeLeaseTtlMs,
			request: { requestId, requestSha256 },
		};
		return this.#replaceAttachment(record, {
			state: "active",
			transitionId: null,
			active: {
				...active,
				renewal: { state: "planned", currentLease: active.lease, plan, lastOutcome: active.renewal.lastOutcome },
			},
			lastDiscardedRuntimeChanges: record.attachment.lastDiscardedRuntimeChanges,
			block: null,
		});
	}

	async #resolveRenewal(
		record: RuntimeAttachmentRecordV1,
		purpose: "admit" | "drain",
		signal?: AbortSignal,
	): Promise<RuntimeAttachmentRecordV1> {
		if (record.attachment.state !== "active") return record;
		let current = record;
		let active = record.attachment.active;
		if (active.renewal.state === "complete") {
			if (purpose === "drain" || Date.parse(this.#now()) < Date.parse(active.lease.renewBy)) return current;
			if (!this.#bindingMatches(active.lease)) return current;
			current = await this.#planRenewal(current);
			if (current.attachment.state !== "active")
				throw new Error("Runtime attachment changed during renewal planning");
			active = current.attachment.active;
		}
		if (active.renewal.state === "planned") {
			if (purpose === "drain")
				return this.#finishRenewalWithoutTransport(current, "cancelled_before_transport", this.#now());
			if (!this.#bindingMatches(active.renewal.currentLease)) {
				return this.#finishRenewalWithoutTransport(current, "inspected_absent_after_owner_loss", this.#now());
			}
			current = await this.#replaceAttachment(current, {
				state: "active",
				transitionId: null,
				active: { ...active, renewal: { ...active.renewal, state: "outcome_unknown" } },
				lastDiscardedRuntimeChanges: current.attachment.lastDiscardedRuntimeChanges,
				block: null,
			});
			if (current.attachment.state !== "active")
				throw new Error("Runtime attachment changed before renewal transport");
			active = current.attachment.active;
		}
		if (active.renewal.state !== "outcome_unknown") return current;
		const plan = active.renewal.plan;
		const provider = this.#registry.get(plan.expectedLease.replica.providerId);
		let inspection;
		try {
			inspection = await provider.inspectRenewal(plan);
		} catch {
			throw new Error("Runtime renewal inspection failed");
		}
		if (inspection.status === "complete") return this.#completeRenewal(current, inspection.receipt);
		if (inspection.status === "rejected") {
			if (inspection.reason === "expected_lease_mismatch")
				throw new Error("Runtime renewal sequence conflicts with provider state");
			this.#binding = null;
			return this.#finishRenewalWithoutTransport(current, inspection.reason, inspection.observedAt);
		}
		if (
			purpose === "drain" ||
			!this.#bindingMatches(plan.expectedLease) ||
			Date.parse(this.#now()) >= Date.parse(plan.expectedLease.expiresAt)
		) {
			const reason =
				purpose === "drain" && this.#bindingMatches(plan.expectedLease)
					? ("inspected_absent_before_drain" as const)
					: ("inspected_absent_after_owner_loss" as const);
			return this.#finishRenewalWithoutTransport(current, reason, this.#now());
		}
		const fence = this.#binding?.fence;
		if (!fence) return this.#finishRenewalWithoutTransport(current, "inspected_absent_after_owner_loss", this.#now());
		let receipt: RuntimeLeaseRenewalReceipt;
		try {
			receipt = await provider.renew({ plan, fence, signal });
		} catch {
			const reconciled = await provider.inspectRenewal(plan);
			if (reconciled.status === "complete") return this.#completeRenewal(current, reconciled.receipt);
			if (reconciled.status === "rejected" && reconciled.reason !== "expected_lease_mismatch") {
				this.#binding = null;
				return this.#finishRenewalWithoutTransport(current, reconciled.reason, reconciled.observedAt);
			}
			throw new Error("Runtime renewal outcome remains indeterminate");
		}
		return this.#completeRenewal(current, receipt);
	}

	async beginWorkspaceOperation(
		requirements: RuntimeRequirements,
		operationLeaseId: WorkspaceOperationLeaseId,
		signal?: AbortSignal,
	): Promise<WorkspaceOperationLease> {
		return this.#serialized(signal, async () => {
			if (this.#admissionClosed) throw new Error("Workspace operation admission is closed");
			if (this.#activeOperations.has(operationLeaseId))
				throw new Error("Workspace operation lease identity was reused");
			await this.#currentControllerLease();
			let readResult = await this.#attachmentStore.read(this.#workspaceId);
			if (readResult.status !== "present") throw new Error(`Runtime attachment unavailable: ${readResult.status}`);
			let record = readResult.record;
			if (record.attachment.state === "active") {
				record = await this.#resolveRenewal(record, "admit", signal);
				if (record.attachment.state !== "active") throw new Error("Runtime attachment changed during renewal");
				const scheduled = await this.#schedule(requirements, record.attachment.active.target.candidate);
				if (
					scheduled.selected.status === "selected" &&
					scheduled.selected.retainedCurrent &&
					this.#bindingMatches(record.attachment.active.lease)
				) {
					if (!exactJson(record.scheduler, scheduled.scheduler)) {
						record = await this.#replaceAttachment(record, record.attachment, scheduled.scheduler);
					}
					return this.#operationLease(operationLeaseId);
				}
				this.#admissionClosed = true;
				try {
					await this.#drainActive(record, "policy_change", true, signal);
				} finally {
					this.#admissionClosed = false;
				}
				readResult = await this.#attachmentStore.read(this.#workspaceId);
				if (readResult.status !== "present")
					throw new Error(`Runtime attachment unavailable: ${readResult.status}`);
				record = readResult.record;
			}
			if (record.attachment.state === "draining") {
				this.#admissionClosed = true;
				try {
					await this.#continueDrain(record, signal);
				} finally {
					this.#admissionClosed = false;
				}
				readResult = await this.#attachmentStore.read(this.#workspaceId);
				if (readResult.status !== "present")
					throw new Error(`Runtime attachment unavailable: ${readResult.status}`);
				record = readResult.record;
			}
			if (record.attachment.state === "acquiring") {
				this.#admissionClosed = true;
				try {
					await this.#rollbackAcquisition(record, signal);
				} finally {
					this.#admissionClosed = false;
				}
				readResult = await this.#attachmentStore.read(this.#workspaceId);
				if (readResult.status !== "present")
					throw new Error(`Runtime attachment unavailable: ${readResult.status}`);
				record = readResult.record;
			}
			if (record.attachment.state !== "none") {
				throw new Error(`Runtime transition requires reconciliation: ${record.attachment.state}`);
			}
			await this.#acquireFromNone(record, requirements, signal);
			return this.#operationLease(operationLeaseId);
		});
	}

	async #acquireFromNone(
		attachment: RuntimeAttachmentRecordV1,
		requirements: RuntimeRequirements,
		signal?: AbortSignal,
	): Promise<void> {
		await this.#currentControllerLease();
		const persistent = await this.#persistentRecord();
		if (persistent.workspace.canonical.state !== "present") throw new Error("Canonical workspace is unavailable");
		const canonical = await this.#canonicalStore.inspect(this.#workspaceId);
		if (
			canonical.status !== "present" ||
			!workspaceImagesMatch(canonical.workspace.checkpoint, persistent.workspace.canonical.workspace.checkpoint) ||
			canonical.workspace.checkpoint.generation !== persistent.workspace.canonical.workspace.checkpoint.generation
		) {
			throw new Error("Canonical workspace authority changed during runtime acquisition");
		}
		const scheduled = await this.#schedule(requirements, null);
		if (scheduled.selected.status !== "selected") {
			await this.#replaceAttachment(
				attachment,
				{
					state: "none",
					transitionId: null,
					active: null,
					lastDiscardedRuntimeChanges: attachment.attachment.lastDiscardedRuntimeChanges,
					block: {
						state: "operator_required",
						certainty: "unknown",
						stage: "inspect",
						code: "provider_unavailable",
						observedAt: this.#now(),
						next: { kind: "operator" },
					},
				},
				scheduled.scheduler,
			);
			throw new Error(`Runtime requirements are unsatisfied: ${scheduled.selected.unmet.join(",")}`);
		}
		const candidate = scheduled.selected.candidate;
		const transitionId: OperationId = this.#identity();
		const replicaId: ReplicaId = this.#identity();
		const leaseId: RuntimeLeaseId = this.#identity();
		const fenceId: RuntimeFenceId = this.#identity();
		const fence: RuntimeFence = { fenceId, token: this.#fenceToken() };
		const plannedAt = this.#now();
		const replica = {
			providerId: candidate.providerId,
			profileId: candidate.profileId,
			replicaId,
			workspaceId: this.#workspaceId,
		};
		const leasePlan: RuntimeLeasePlan = {
			replica,
			leaseId,
			fenceId,
			initialRenewalSequence: 0,
			baseCheckpoint: canonical.workspace.checkpoint,
			deletionAuthorityDomain: "persistent",
			leaseTtlMs: this.#runtimeLeaseTtlMs,
		};
		const acquireRequestId = await deriveProviderSubrequestId({
			workspaceId: this.#workspaceId,
			parentKind: "runtime_transition",
			parentId: transitionId,
			ordinal: 0,
			operation: "acquire",
		});
		const acquireDraft = { transitionId, requestId: acquireRequestId, requestSha256: "", candidate, plan: leasePlan };
		const acquireRequestSha256 = await canonicalRuntimeProviderInspectionSha256V1({
			operation: "acquire",
			request: acquireDraft,
		});
		const pushRequestId = await deriveProviderSubrequestId({
			workspaceId: this.#workspaceId,
			parentKind: "runtime_transition",
			parentId: transitionId,
			ordinal: 1,
			operation: "push",
		});
		const digestLease: RuntimeLeaseRef = {
			leaseId,
			replica,
			fenceId,
			baseGeneration: canonical.workspace.checkpoint.generation,
			renewalSequence: 0,
			acquiredAt: plannedAt,
			renewBy: plannedAt,
			expiresAt: plannedAt,
		};
		const pushDraft = {
			transitionId,
			requestId: pushRequestId,
			requestSha256: "",
			lease: digestLease,
			snapshot: {
				rootSha256: canonical.workspace.checkpoint.rootSha256,
				fileCount: canonical.workspace.checkpoint.fileCount,
				byteCount: canonical.workspace.checkpoint.byteCount,
			},
		};
		const pushRequestSha256 = await canonicalRuntimeProviderInspectionSha256V1({
			operation: "push",
			request: pushDraft,
		});
		const rollbackRevokeRequestId = await deriveProviderSubrequestId({
			workspaceId: this.#workspaceId,
			parentKind: "runtime_transition",
			parentId: transitionId,
			ordinal: 2,
			operation: "revoke",
		});
		const rollbackRevokeDraft = {
			transitionId,
			requestId: rollbackRevokeRequestId,
			requestSha256: "",
			replica,
			leaseId,
			fenceId,
			reasonCode: "runtime_reconciliation_blocked" as const,
		};
		const rollbackRevokeRequestSha256 = await canonicalRuntimeProviderInspectionSha256V1({
			operation: "revoke",
			request: rollbackRevokeDraft,
		});
		const rollbackReleaseRequestId = await deriveProviderSubrequestId({
			workspaceId: this.#workspaceId,
			parentKind: "runtime_transition",
			parentId: transitionId,
			ordinal: 3,
			operation: "release",
		});
		const rollbackReleaseDraft = {
			parentOperationId: transitionId,
			requestId: rollbackReleaseRequestId,
			requestSha256: "",
			replica,
			leaseId,
		};
		const rollbackReleaseRequestSha256 = await canonicalRuntimeProviderInspectionSha256V1({
			operation: "release",
			request: rollbackReleaseDraft,
		});
		const recoveryFreezeId: OperationId = this.#identity();
		const recoveryCheckpointId: FrozenCheckpointId = this.#identity();
		const recoveryCommitId: OperationId = this.#identity();
		const recoveryFreezeRequestId = await deriveProviderSubrequestId({
			workspaceId: this.#workspaceId,
			parentKind: "runtime_transition",
			parentId: recoveryFreezeId,
			ordinal: 4,
			operation: "recovery_freeze",
		});
		const recoveryFreezeRequestSha256 = await canonicalRuntimeSha256([
			"omp-runtime-provider-v1",
			"recovery_freeze",
			recoveryFreezeId,
			replica.providerId,
			replica.profileId,
			replica.workspaceId,
			replica.replicaId,
			leaseId,
			fenceId,
			canonical.workspace.checkpoint.generation,
			recoveryCheckpointId,
		]);
		const recoveryAcknowledgementRequestId = await deriveProviderSubrequestId({
			workspaceId: this.#workspaceId,
			parentKind: "runtime_transition",
			parentId: recoveryFreezeId,
			ordinal: 5,
			operation: "checkpoint_acknowledgement",
		});
		const recoveryReleaseRequestId = await deriveProviderSubrequestId({
			workspaceId: this.#workspaceId,
			parentKind: "runtime_transition",
			parentId: recoveryFreezeId,
			ordinal: 6,
			operation: "release",
		});
		const recoveryReleaseDraft = {
			parentOperationId: recoveryFreezeId,
			requestId: recoveryReleaseRequestId,
			requestSha256: "",
			replica,
			leaseId,
		};
		const recoveryReleaseRequestSha256 = await canonicalRuntimeProviderInspectionSha256V1({
			operation: "release",
			request: recoveryReleaseDraft,
		});
		const plan: RuntimeAcquisitionPlan = {
			transitionId,
			target: { candidate, requirements },
			lease: leasePlan,
			recovery: {
				locator: {
					recoveryFreezeId,
					replica,
					leaseId,
					fenceId,
					baseGeneration: canonical.workspace.checkpoint.generation,
					checkpointId: recoveryCheckpointId,
				},
				canonicalCommitId: recoveryCommitId,
				requests: {
					freeze: { requestId: recoveryFreezeRequestId, requestSha256: recoveryFreezeRequestSha256 },
					checkpointAcknowledgement: {
						requestId: recoveryAcknowledgementRequestId,
						parentOperationId: recoveryFreezeId,
					},
					release: {
						requestId: recoveryReleaseRequestId,
						requestSha256: recoveryReleaseRequestSha256,
						parentOperationId: recoveryFreezeId,
					},
				},
			},
			requests: {
				acquire: { transitionId, requestId: acquireRequestId, requestSha256: acquireRequestSha256 },
				push: { transitionId, requestId: pushRequestId, requestSha256: pushRequestSha256 },
				rollbackRevoke: {
					transitionId,
					requestId: rollbackRevokeRequestId,
					requestSha256: rollbackRevokeRequestSha256,
				},
				rollbackRelease: {
					parentOperationId: transitionId,
					requestId: rollbackReleaseRequestId,
					requestSha256: rollbackReleaseRequestSha256,
				},
			},
		};
		const plannedReplica: KnownReplicaRecordV1 = {
			replica,
			plannedByOperationId: transitionId,
			deletionAuthorityDomain: "persistent",
			firstPlannedAt: plannedAt,
			lastLeaseId: null,
			observation: { state: "never_observed" },
			cacheEviction: { state: "not_requested" },
			cleanup: { state: "not_requested" },
		};
		await this.#appendPlannedReplica(plannedReplica);
		let current = await this.#replaceAttachment(
			attachment,
			{
				state: "acquiring",
				transitionId,
				active: null,
				plan,
				progress: { phase: "pre_provider", lease: null, materialized: null },
				lastDiscardedRuntimeChanges: attachment.attachment.lastDiscardedRuntimeChanges,
				block: null,
			},
			scheduled.scheduler,
		);
		if (current.attachment.state !== "acquiring") throw new Error("Runtime acquisition state was not published");
		current = await this.#replaceAttachment(current, {
			...current.attachment,
			progress: { phase: "acquire_outcome_unknown", lease: null, materialized: null },
		});
		const provider = this.#registry.get(candidate.providerId);
		let acquired;
		try {
			acquired = await provider.acquire({
				transitionId,
				requestId: acquireRequestId,
				requestSha256: acquireRequestSha256,
				candidate,
				plan: leasePlan,
				fence,
				signal,
			});
		} catch {
			const inspection = await provider.inspectAcquire({
				transitionId,
				requestId: acquireRequestId,
				requestSha256: acquireRequestSha256,
				candidate,
				plan: leasePlan,
			});
			if (
				!exactJson(inspection.request, plan.requests.acquire) ||
				inspection.deletionAuthorityDomain !== "persistent"
			) {
				throw new Error("Runtime acquisition inspection conflicts with the durable plan");
			}
			if (inspection.status === "in_progress") {
				throw new Error("Runtime acquire remains in progress");
			}
			if (
				inspection.status === "not_started"
					? !exactJson(inspection.replica, replica) || inspection.leaseId !== leaseId
					: !exactJson(inspection.lease.replica, replica) ||
						inspection.lease.leaseId !== leaseId ||
						inspection.lease.fenceId !== fenceId ||
						inspection.lease.baseGeneration !== canonical.workspace.checkpoint.generation ||
						inspection.lease.renewalSequence !== 0
			) {
				throw new Error("Runtime acquisition inspection is invalid");
			}
			await this.#currentControllerLease();
			acquired = await provider.acquire({
				transitionId,
				requestId: acquireRequestId,
				requestSha256: acquireRequestSha256,
				candidate,
				plan: leasePlan,
				fence,
				signal,
			});
		}
		if (
			(acquired.status !== "acquired" && acquired.status !== "already_acquired") ||
			!exactJson(acquired.request, plan.requests.acquire) ||
			acquired.deletionAuthorityDomain !== "persistent" ||
			acquired.providerPhase !== "reserved" ||
			acquired.lease.leaseId !== leaseId ||
			acquired.lease.fenceId !== fenceId ||
			acquired.lease.baseGeneration !== canonical.workspace.checkpoint.generation ||
			acquired.lease.renewalSequence !== 0 ||
			!exactJson(acquired.lease.replica, replica) ||
			!runtimeLeaseMatches(acquired.binding.lease, acquired.lease) ||
			acquired.binding.fence.fenceId !== fenceId ||
			acquired.binding.fence.token !== fence.token ||
			acquired.binding.modelRoot !== "/workspace" ||
			Date.parse(acquired.lease.renewBy) <= Date.parse(acquired.lease.acquiredAt) ||
			Date.parse(acquired.lease.expiresAt) <= Date.parse(acquired.lease.renewBy)
		) {
			throw new Error("Runtime provider returned an invalid acquisition receipt");
		}
		if (current.attachment.state !== "acquiring") throw new Error("Runtime acquisition state changed unexpectedly");
		current = await this.#replaceAttachment(current, {
			...current.attachment,
			progress: { phase: "reserved", lease: acquired.lease, materialized: null },
		});
		await this.#recordReplicaLease(replica, acquired.lease);
		const controllerLease = await this.#currentControllerLease();
		const snapshotResult = await this.#canonicalStore.snapshot({
			workspaceId: this.#workspaceId,
			expectedGeneration: acquired.lease.baseGeneration,
			controllerLease: controllerLease.proof,
			signal,
		});
		if (
			snapshotResult.status !== "snapshot" ||
			snapshotResult.snapshot.checkpoint.generation !== acquired.lease.baseGeneration ||
			!workspaceImagesMatch(snapshotResult.snapshot.checkpoint, canonical.workspace.checkpoint)
		) {
			throw new Error(`Canonical workspace snapshot unavailable: ${snapshotResult.status}`);
		}
		if (current.attachment.state !== "acquiring") throw new Error("Runtime acquisition state changed unexpectedly");
		current = await this.#replaceAttachment(current, {
			...current.attachment,
			progress: { phase: "push_outcome_unknown", lease: acquired.lease, materialized: null },
		});
		let materialized;
		try {
			materialized = await provider.push({
				transitionId,
				requestId: pushRequestId,
				requestSha256: pushRequestSha256,
				lease: acquired.lease,
				fence,
				snapshot: snapshotResult.snapshot,
				signal,
			});
		} catch {
			const inspection = await provider.inspectPush({
				transitionId,
				requestId: pushRequestId,
				requestSha256: pushRequestSha256,
				lease: acquired.lease,
				snapshot: {
					rootSha256: snapshotResult.snapshot.checkpoint.rootSha256,
					fileCount: snapshotResult.snapshot.checkpoint.fileCount,
					byteCount: snapshotResult.snapshot.checkpoint.byteCount,
				},
			});
			if (inspection.status === "complete") materialized = inspection.result;
			else if (inspection.status === "not_started") {
				materialized = await provider.push({
					transitionId,
					requestId: pushRequestId,
					requestSha256: pushRequestSha256,
					lease: acquired.lease,
					fence,
					snapshot: snapshotResult.snapshot,
					signal,
				});
			} else throw new Error("Runtime push remains in progress");
		}
		if (
			!exactJson(materialized.request, plan.requests.push) ||
			!exactJson(materialized.replica, replica) ||
			materialized.canonicalGeneration !== acquired.lease.baseGeneration ||
			!workspaceImagesMatch(materialized, snapshotResult.snapshot.checkpoint)
		)
			throw new Error("Runtime push receipt is invalid");
		const inspection = await provider.inspect({ replica, leaseId, fence });
		if (
			inspection.status !== "present" ||
			inspection.providerPhase !== "ready" ||
			!runtimeLeaseMatches(inspection.lease, acquired.lease) ||
			inspection.activeCommands !== 0 ||
			inspection.pendingSyncs !== 0 ||
			inspection.replicaImage === null ||
			!workspaceImagesMatch(inspection.replicaImage, snapshotResult.snapshot.checkpoint)
		) {
			throw new Error("Runtime provider did not reach the exact ready state");
		}
		if (current.attachment.state !== "acquiring") throw new Error("Runtime acquisition state changed unexpectedly");
		current = await this.#replaceAttachment(current, {
			...current.attachment,
			progress: { phase: "ready", lease: acquired.lease, materialized },
		});
		if (current.attachment.state !== "acquiring") throw new Error("Runtime acquisition state changed unexpectedly");
		const active = {
			target: plan.target,
			lease: acquired.lease,
			recovery: plan.recovery,
			renewal: { state: "complete" as const, currentLease: acquired.lease, plan: null, lastOutcome: null },
		};
		const completedAt = this.#now();
		await this.#replaceAttachment(
			current,
			{
				state: "active",
				transitionId: null,
				active,
				lastDiscardedRuntimeChanges: current.attachment.lastDiscardedRuntimeChanges,
				block: null,
			},
			current.scheduler,
			{ transitionId, reason: "first_tool", from: "none", to: "active", startedAt: plannedAt, completedAt },
		);
		this.#binding = acquired.binding;
	}

	async #rollbackAcquisition(record: RuntimeAttachmentRecordV1, signal?: AbortSignal): Promise<void> {
		if (record.attachment.state !== "acquiring") throw new Error("Runtime attachment is not acquiring");
		const acquiring = record.attachment;
		const plan = acquiring.plan;
		const provider = this.#registry.get(plan.target.candidate.providerId);
		const completeNone = async (): Promise<void> => {
			const completedAt = this.#now();
			await this.#replaceAttachment(
				record,
				{
					state: "none",
					transitionId: null,
					active: null,
					lastDiscardedRuntimeChanges: acquiring.lastDiscardedRuntimeChanges,
					block: null,
				},
				record.scheduler,
				{
					transitionId: acquiring.transitionId,
					reason: "crash_recovery",
					from: "acquiring",
					to: "none",
					startedAt: record.updatedAt,
					completedAt,
				},
			);
		};
		if (acquiring.progress.phase === "pre_provider") {
			await completeNone();
			return;
		}
		if (acquiring.progress.phase === "acquire_outcome_unknown") {
			const inspected = await provider.inspectAcquire({
				...plan.requests.acquire,
				candidate: plan.target.candidate,
				plan: plan.lease,
			});
			if (inspected.status === "not_started") {
				if (
					!exactJson(inspected.request, plan.requests.acquire) ||
					!exactJson(inspected.replica, plan.lease.replica) ||
					inspected.leaseId !== plan.lease.leaseId ||
					inspected.deletionAuthorityDomain !== plan.lease.deletionAuthorityDomain
				) {
					throw new Error("Runtime acquisition absence inspection is invalid");
				}
				await completeNone();
				return;
			}
			if (
				!exactJson(inspected.request, plan.requests.acquire) ||
				inspected.deletionAuthorityDomain !== "persistent"
			) {
				throw new Error("Runtime acquisition inspection conflicts with the durable plan");
			}
			if (
				inspected.status === "complete" &&
				(!exactJson(inspected.lease.replica, plan.lease.replica) ||
					inspected.lease.leaseId !== plan.lease.leaseId ||
					inspected.lease.fenceId !== plan.lease.fenceId ||
					inspected.lease.baseGeneration !== plan.lease.baseCheckpoint.generation ||
					inspected.lease.renewalSequence !== 0)
			) {
				throw new Error("Runtime acquisition completion inspection is invalid");
			}
		}
		const revokeRequest = {
			...plan.requests.rollbackRevoke,
			replica: plan.lease.replica,
			leaseId: plan.lease.leaseId,
			fenceId: plan.lease.fenceId,
			reasonCode: "runtime_reconciliation_blocked" as const,
		};
		try {
			const revoked = await provider.revoke({ ...revokeRequest, signal });
			if (
				!exactJson(revoked.request, plan.requests.rollbackRevoke) ||
				!exactJson(revoked.replica, plan.lease.replica) ||
				revoked.leaseId !== plan.lease.leaseId ||
				revoked.fenceId !== plan.lease.fenceId
			) {
				throw new Error("Runtime acquisition rollback revoke receipt is invalid");
			}
		} catch {
			const inspected = await provider.inspectRevoke(revokeRequest);
			if (inspected.status === "not_started") {
				const revoked = await provider.revoke({ ...revokeRequest, signal });
				if (!exactJson(revoked.request, plan.requests.rollbackRevoke))
					throw new Error("Runtime rollback revoke retry conflicted");
			} else if (!exactJson(inspected.result.request, plan.requests.rollbackRevoke)) {
				throw new Error("Runtime rollback revoke inspection conflicted");
			}
		}
		const releaseRequest = {
			...plan.requests.rollbackRelease,
			replica: plan.lease.replica,
			leaseId: plan.lease.leaseId,
		};
		const released = await this.#releaseExact(provider, releaseRequest, signal);
		if (
			!exactJson(released.request, plan.requests.rollbackRelease) ||
			!exactJson(released.replica, plan.lease.replica) ||
			released.leaseId !== plan.lease.leaseId ||
			(released.compute !== "stopped" && released.compute !== "not_applicable")
		) {
			throw new Error("Runtime acquisition rollback release receipt is invalid");
		}
		await this.#replaceReplica(plan.lease.replica, current => ({
			...current,
			lastLeaseId: plan.lease.leaseId,
			observation: { state: "present", observedAt: this.#now(), image: null },
		}));
		await completeNone();
	}
	async #prepareCacheEvictionPlan(
		active: Extract<RuntimeAttachment, { state: "active" }>["active"],
		requestedByOperationId: OperationId,
	): Promise<RuntimeReplicaCacheEvictionPlan | null> {
		const providerId = active.lease.replica.providerId;
		if (!Object.hasOwn(this.#cacheEvictionDelayMsByProvider, providerId)) return null;
		const delayMs = this.#cacheEvictionDelayMsByProvider[providerId];
		if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new TypeError("Invalid provider cache-eviction delay");
		const persistent = await this.#persistentRecord();
		const row = persistent.workspace.knownReplicas.entries.find(entry =>
			exactJson(entry.replica, active.lease.replica),
		);
		if (!row) throw new Error("Active runtime replica is missing from the durable catalog");
		if (row.cacheEviction.state !== "not_requested") {
			if (
				!exactJson(row.cacheEviction.plan.replica, active.lease.replica) ||
				row.cacheEviction.plan.mode !== "workspace_retention" ||
				row.cacheEviction.plan.delayMs !== delayMs
			) {
				throw new Error("Runtime cache-eviction plan conflicts with the active replica");
			}
			return row.cacheEviction.plan;
		}
		const plannedAt = this.#now();
		const retentionDeadline = addMilliseconds(plannedAt, delayMs);
		const requestId = await deriveProviderSubrequestId({
			workspaceId: this.#workspaceId,
			parentKind: "runtime_transition",
			parentId: requestedByOperationId,
			ordinal: 7,
			operation: "replica_cache_evict",
		});
		const requestSha256 = await canonicalRuntimeSha256([
			"omp-runtime-provider-v1",
			"replica_cache_evict",
			requestedByOperationId,
			active.lease.replica.providerId,
			active.lease.replica.profileId,
			active.lease.replica.workspaceId,
			active.lease.replica.replicaId,
			"workspace_retention",
			delayMs,
			plannedAt,
			retentionDeadline,
		]);
		const plan: RuntimeReplicaCacheEvictionPlan = {
			requestId,
			requestSha256,
			requestedByOperationId,
			replica: active.lease.replica,
			mode: "workspace_retention",
			delayMs,
			plannedAt,
			retentionDeadline,
		};
		await this.#replaceReplica(active.lease.replica, current => {
			if (current.cacheEviction.state !== "not_requested") {
				if (!exactJson(current.cacheEviction.plan, plan))
					throw new Error("Runtime cache-eviction planning conflict");
				return current;
			}
			return {
				...current,
				cacheEviction: {
					state: "pending",
					plan,
					attempts: 1,
					lastAttemptAt: null,
					progress: { state: "not_started" },
				},
			};
		});
		return plan;
	}

	#validateEvictionAcceptance(
		plan: RuntimeReplicaCacheEvictionPlan,
		acceptance: RuntimeReplicaCacheEvictionAcceptance,
	): void {
		if (
			acceptance.requestId !== plan.requestId ||
			acceptance.requestSha256 !== plan.requestSha256 ||
			!exactJson(acceptance.replica, plan.replica) ||
			acceptance.retentionDeadline !== plan.retentionDeadline ||
			!Number.isFinite(Date.parse(acceptance.acceptedAt))
		) {
			throw new Error("Runtime cache-eviction acceptance is invalid");
		}
	}

	#validateEvictionCompletion(
		plan: RuntimeReplicaCacheEvictionPlan,
		completion: RuntimeReplicaCacheEvictionCompletion,
	): void {
		this.#validateEvictionAcceptance(plan, completion.acceptance);
		if (
			(completion.outcome !== "evicted" &&
				completion.outcome !== "already_evicted" &&
				completion.outcome !== "absent") ||
			!Number.isFinite(Date.parse(completion.completedAt)) ||
			!completion.receiptSha256.startsWith("sha256:")
		) {
			throw new Error("Runtime cache-eviction completion is invalid");
		}
	}

	async #publishEvictionProgress(
		record: RuntimeAttachmentRecordV1,
		drainProgress: RuntimeDrainCacheEvictionProgress,
		catalogProgress: KnownReplicaCacheEvictionProgressV1,
		attemptedAt: ISO8601 | null,
	): Promise<RuntimeAttachmentRecordV1> {
		if (record.attachment.state !== "draining") {
			throw new Error("Runtime cache-eviction progress requires a draining attachment");
		}
		const draining = record.attachment;
		const plan = draining.plan.cacheEvictionPlan;
		if (plan === null) throw new Error("Runtime cache-eviction progress has no durable drain plan");
		await this.#replaceReplica(plan.replica, current => {
			if (current.cacheEviction.state !== "pending" || !exactJson(current.cacheEviction.plan, plan)) {
				throw new Error("Runtime cache-eviction catalog plan conflict");
			}
			const attempted =
				attemptedAt !== null && current.cacheEviction.progress.state !== "submission_outcome_unknown";
			return {
				...current,
				cacheEviction: {
					...current.cacheEviction,
					attempts: current.cacheEviction.attempts,
					lastAttemptAt: attempted ? attemptedAt : current.cacheEviction.lastAttemptAt,
					progress: catalogProgress,
				},
			};
		});
		return this.#replaceAttachment(record, { ...draining, cacheEviction: drainProgress });
	}

	async #publishEvictionCompletion(
		record: RuntimeAttachmentRecordV1,
		completion: RuntimeReplicaCacheEvictionCompletion,
	): Promise<RuntimeAttachmentRecordV1> {
		if (record.attachment.state !== "draining") {
			throw new Error("Runtime cache-eviction completion requires a draining attachment");
		}
		const draining = record.attachment;
		const plan = draining.plan.cacheEvictionPlan;
		if (plan === null) throw new Error("Runtime cache-eviction completion has no durable drain plan");
		this.#validateEvictionCompletion(plan, completion);
		await this.#replaceReplica(plan.replica, current => {
			if (current.cacheEviction.state === "complete") {
				if (!exactJson(current.cacheEviction.plan, plan) || !exactJson(current.cacheEviction.result, completion)) {
					throw new Error("Runtime cache-eviction completion conflicts with the catalog");
				}
				return current;
			}
			if (current.cacheEviction.state !== "pending" || !exactJson(current.cacheEviction.plan, plan)) {
				throw new Error("Runtime cache-eviction completion has no matching catalog plan");
			}
			return {
				...current,
				observation: { state: "absent", observedAt: completion.completedAt },
				cacheEviction: { state: "complete", plan, result: completion },
			};
		});
		return this.#replaceAttachment(record, { ...draining, cacheEviction: { state: "complete", result: completion } });
	}

	async #blockEviction(
		record: RuntimeAttachmentRecordV1,
		progress: Extract<RuntimeDrainCacheEvictionProgress, { state: "rejected" | "deadline_mismatch" }>,
		catalogProgress: Extract<KnownReplicaCacheEvictionProgressV1, { state: "rejected" | "deadline_mismatch" }>,
	): Promise<never> {
		const current = await this.#publishEvictionProgress(record, progress, catalogProgress, null);
		if (current.attachment.state !== "draining") throw new Error("Runtime drain changed while blocking eviction");
		const code =
			progress.state === "rejected"
				? ("provider_request_rejected" as const)
				: ("provider_response_invalid" as const);
		await this.#replaceAttachment(current, {
			...current.attachment,
			block: {
				state: "operator_required",
				certainty: "completed",
				stage: "cache_eviction_acceptance",
				code,
				observedAt: this.#now(),
				next: { kind: "operator" },
			},
		});
		throw new Error("Runtime cache-eviction acceptance is durably blocked");
	}

	async #adoptEvictionObservation(
		record: RuntimeAttachmentRecordV1,
		observation: RuntimeReplicaCacheEvictionRequestResult | RuntimeReplicaCacheEvictionInspectResult,
	): Promise<{ readonly record: RuntimeAttachmentRecordV1; readonly releaseAuthorized: boolean }> {
		if (record.attachment.state !== "draining" || record.attachment.plan.cacheEvictionPlan === null) {
			throw new Error("Runtime cache-eviction observation has no durable plan");
		}
		const plan = record.attachment.plan.cacheEvictionPlan;
		if (observation.status === "not_started") {
			if (
				observation.requestId !== plan.requestId ||
				observation.requestSha256 !== plan.requestSha256 ||
				!exactJson(observation.replica, plan.replica) ||
				observation.retentionDeadline !== plan.retentionDeadline
			) {
				throw new Error("Runtime cache-eviction absence inspection is invalid");
			}
			return { record, releaseAuthorized: false };
		}
		if (observation.status === "acceptance_pending") {
			const pending = observation.pending;
			if (
				pending.requestId !== plan.requestId ||
				pending.requestSha256 !== plan.requestSha256 ||
				!exactJson(pending.replica, plan.replica) ||
				pending.retentionDeadline !== plan.retentionDeadline
			) {
				throw new Error("Runtime cache-eviction pending evidence is invalid");
			}
			const next = await this.#publishEvictionProgress(
				record,
				{ state: "inspection_pending", pending },
				{ state: "inspection_pending", pending },
				null,
			);
			return { record: next, releaseAuthorized: false };
		}
		if (observation.status === "accepted" || observation.status === "already_accepted") {
			this.#validateEvictionAcceptance(plan, observation.acceptance);
			const next = await this.#publishEvictionProgress(
				record,
				{ state: "accepted", acceptance: observation.acceptance },
				{ state: "accepted", acceptance: observation.acceptance },
				null,
			);
			return { record: next, releaseAuthorized: true };
		}
		if (observation.status === "deferred") {
			this.#validateEvictionAcceptance(plan, observation.acceptance);
			const next = await this.#publishEvictionProgress(
				record,
				{
					state: "deferred",
					acceptance: observation.acceptance,
					reason: observation.reason,
					nextAttemptAt: observation.nextAttemptAt,
				},
				{
					state: "deferred",
					acceptance: observation.acceptance,
					reason: observation.reason,
					nextAttemptAt: observation.nextAttemptAt,
				},
				null,
			);
			return { record: next, releaseAuthorized: true };
		}
		if (observation.status === "complete") {
			const next = await this.#publishEvictionCompletion(record, observation.result);
			return { record: next, releaseAuthorized: true };
		}
		if (observation.status === "rejected") {
			if (
				observation.rejection.requestId !== plan.requestId ||
				observation.rejection.requestSha256 !== plan.requestSha256 ||
				!exactJson(observation.rejection.replica, plan.replica) ||
				observation.rejection.retentionDeadline !== plan.retentionDeadline
			)
				throw new Error("Runtime eviction rejection is invalid");
			return this.#blockEviction(
				record,
				{ state: "rejected", rejection: observation.rejection },
				{ state: "rejected", rejection: observation.rejection },
			);
		}
		if (observation.status !== "deadline_mismatch") {
			throw new Error("Runtime cache-eviction observation has an unsupported status");
		}
		if (
			observation.mismatch.requestId !== plan.requestId ||
			observation.mismatch.requestSha256 !== plan.requestSha256 ||
			!exactJson(observation.mismatch.replica, plan.replica) ||
			observation.mismatch.plannedRetentionDeadline !== plan.retentionDeadline ||
			observation.mismatch.providerRetentionDeadline === plan.retentionDeadline
		) {
			throw new Error("Runtime eviction deadline-mismatch evidence is invalid");
		}
		return this.#blockEviction(
			record,
			{ state: "deadline_mismatch", mismatch: observation.mismatch },
			{ state: "deadline_mismatch", mismatch: observation.mismatch },
		);
	}

	async #advanceCacheEviction(
		record: RuntimeAttachmentRecordV1,
		signal?: AbortSignal,
	): Promise<RuntimeAttachmentRecordV1> {
		if (record.attachment.state !== "draining") throw new Error("Runtime attachment is not draining");
		const plan = record.attachment.plan.cacheEvictionPlan;
		if (plan === null) {
			if (record.attachment.cacheEviction.state !== "not_required")
				throw new Error("Unexpected cache-eviction progress");
			return record;
		}
		if (
			record.attachment.cacheEviction.state === "accepted" ||
			record.attachment.cacheEviction.state === "deferred" ||
			record.attachment.cacheEviction.state === "complete"
		)
			return record;
		if (
			record.attachment.cacheEviction.state === "rejected" ||
			record.attachment.cacheEviction.state === "deadline_mismatch"
		) {
			throw new Error("Runtime cache-eviction acceptance is blocked");
		}
		let current = record;
		let shouldSubmit = false;
		if (current.attachment.state !== "draining") throw new Error("Runtime drain changed unexpectedly");
		if (current.attachment.cacheEviction.state === "planned") {
			const attemptedAt = this.#now();
			current = await this.#publishEvictionProgress(
				current,
				{ state: "submission_outcome_unknown" },
				{ state: "submission_outcome_unknown" },
				attemptedAt,
			);
			shouldSubmit = true;
		}
		const provider = this.#registry.get(plan.replica.providerId);
		if (!shouldSubmit) {
			const inspected = await provider.inspectReplicaCacheEviction(plan);
			const adopted = await this.#adoptEvictionObservation(current, inspected);
			current = adopted.record;
			if (adopted.releaseAuthorized) return current;
			if (inspected.status !== "not_started") throw new Error("Runtime cache-eviction acceptance remains pending");
			shouldSubmit = true;
		}
		if (shouldSubmit) {
			try {
				const result = await provider.requestReplicaCacheEviction({ ...plan, signal });
				const adopted = await this.#adoptEvictionObservation(current, result);
				if (!adopted.releaseAuthorized) throw new Error("Runtime cache-eviction acceptance remains pending");
				return adopted.record;
			} catch (error) {
				const inspected = await provider.inspectReplicaCacheEviction(plan);
				const adopted = await this.#adoptEvictionObservation(current, inspected);
				if (adopted.releaseAuthorized) return adopted.record;
				if (inspected.status === "not_started") throw error;
				throw new Error("Runtime cache-eviction acceptance remains pending");
			}
		}
		return current;
	}

	async discardRuntimeChangesAfterPreservationImpossible(
		authorization: RuntimeDiscardRuntimeChangesAuthorization,
		signal?: AbortSignal,
	): Promise<RuntimeDiscardRuntimeChangesResult> {
		return this.#serialized(signal, async () => {
			this.#admissionClosed = true;
			try {
				const read = await this.#attachmentStore.read(this.#workspaceId);
				if (read.status !== "present") throw new Error(`Runtime attachment unavailable: ${read.status}`);
				let current = read.record;
				if (current.attachment.state === "none") {
					if (!exactJson(current.attachment.lastDiscardedRuntimeChanges, authorization)) {
						throw new Error("Runtime discard authorization does not match the durable completion");
					}
					const canonical = await this.#canonicalStore.inspect(this.#workspaceId);
					if (canonical.status !== "present")
						throw new Error(`Canonical workspace unavailable: ${canonical.status}`);
					return { status: "already_discarded", authorization, checkpoint: canonical.workspace.checkpoint };
				}
				if (current.attachment.state !== "draining") {
					throw new Error("Runtime discard requires a draining recovery attachment");
				}
				let draining = current.attachment;
				if (
					draining.plan.freezeAuthority !== "control_plane_recovery" ||
					draining.recoveryFreeze?.state !== "preservation_impossible" ||
					!exactJson(authorization.impossibility, draining.recoveryFreeze.proof)
				) {
					throw new Error("Runtime discard lacks the exact durable preservation-impossibility proof");
				}
				const timingReader = runtimeTimingReadersV1.get(this.#attachmentStore);
				if (!timingReader) throw new Error("Runtime timing reader is unavailable for attachment store");
				const timingTransition = (await timingReader(this.#workspaceId))?.transition;
				if (!timingTransition || timingTransition.transitionId !== draining.transitionId) {
					throw new Error("Runtime discard transition timing is missing or mismatched");
				}
				const canonical = await this.#canonicalStore.inspect(this.#workspaceId);
				if (canonical.status !== "present") throw new Error(`Canonical workspace unavailable: ${canonical.status}`);
				if (draining.discardAuthorization === null) {
					if (
						authorization.ownerEpoch !== this.#ownership.ownerEpoch ||
						authorization.expectedAttachmentRevision !== current.revision
					) {
						throw new Error(
							"Runtime discard authorization is not bound to the current owner and attachment revision",
						);
					}
					current = await this.#replaceAttachment(current, { ...draining, discardAuthorization: authorization });
					if (current.attachment.state !== "draining")
						throw new Error("Runtime discard state changed unexpectedly");
					draining = current.attachment;
				} else if (!exactJson(draining.discardAuthorization, authorization)) {
					throw new Error("Runtime discard authorization conflicts with the durable authorization");
				}
				const provider = this.#registry.get(draining.active.lease.replica.providerId);
				const releaseRequest = draining.active.recovery.requests.release;
				const release = await this.#releaseExact(
					provider,
					{ ...releaseRequest, replica: draining.active.lease.replica, leaseId: draining.active.lease.leaseId },
					signal,
				);
				if (
					!exactJson(release.request, releaseRequest) ||
					!exactJson(release.replica, draining.active.lease.replica) ||
					release.leaseId !== draining.active.lease.leaseId ||
					(release.compute !== "stopped" && release.compute !== "not_applicable")
				) {
					throw new Error("Runtime recovery release receipt is invalid");
				}
				await this.#replaceReplica(draining.active.lease.replica, replica => ({
					...replica,
					observation: { state: "unknown", observedAt: this.#now(), code: "runtime_preservation_impossible" },
				}));
				const completedAt = this.#now();
				await this.#replaceAttachment(
					current,
					{
						state: "none",
						transitionId: null,
						active: null,
						lastDiscardedRuntimeChanges: authorization,
						block: null,
					},
					current.scheduler,
					{
						transitionId: draining.transitionId,
						reason: draining.reason,
						from: "active",
						to: "none",
						startedAt: timingTransition.startedAt,
						completedAt,
					},
				);
				this.#binding = null;
				return { status: "discarded", authorization, checkpoint: canonical.workspace.checkpoint };
			} finally {
				this.#admissionClosed = false;
			}
		});
	}

	async drainToNone(
		reason: RuntimeTransitionReason,
		commitReplica: boolean,
		signal?: AbortSignal,
	): Promise<WorkspaceCheckpoint> {
		return this.#serialized(signal, async () => {
			this.#admissionClosed = true;
			try {
				let readResult = await this.#attachmentStore.read(this.#workspaceId);
				if (readResult.status !== "present")
					throw new Error(`Runtime attachment unavailable: ${readResult.status}`);
				const record = readResult.record;
				if (record.attachment.state === "none") {
					const canonical = await this.#canonicalStore.inspect(this.#workspaceId);
					if (canonical.status !== "present")
						throw new Error(`Canonical workspace unavailable: ${canonical.status}`);
					return canonical.workspace.checkpoint;
				}
				if (record.attachment.state === "acquiring") {
					await this.#rollbackAcquisition(record, signal);
					readResult = await this.#attachmentStore.read(this.#workspaceId);
					if (readResult.status !== "present" || readResult.record.attachment.state !== "none") {
						throw new Error("Runtime acquisition rollback did not reach none");
					}
					const canonical = await this.#canonicalStore.inspect(this.#workspaceId);
					if (canonical.status !== "present")
						throw new Error(`Canonical workspace unavailable: ${canonical.status}`);
					return canonical.workspace.checkpoint;
				}
				if (record.attachment.state === "draining") return this.#continueDrain(record, signal);
				if (record.attachment.state === "active") return this.#drainActive(record, reason, commitReplica, signal);
				throw new Error("Runtime transition requires reconciliation");
			} finally {
				this.#admissionClosed = false;
			}
		});
	}

	async #drainActive(
		record: RuntimeAttachmentRecordV1,
		reason: RuntimeTransitionReason,
		commitReplica: boolean,
		signal?: AbortSignal,
	): Promise<WorkspaceCheckpoint> {
		if (record.attachment.state !== "active") throw new Error("Runtime attachment is not active");
		if (!commitReplica)
			throw new Error("Persistent runtime discard requires durable preservation-impossibility authorization");
		let current = await this.#resolveRenewal(record, "drain", signal);
		if (current.attachment.state !== "active") throw new Error("Runtime attachment changed while resolving renewal");
		const active = current.attachment.active;
		const transitionId: OperationId = this.#identity();
		const cacheEvictionPlan = await this.#prepareCacheEvictionPlan(active, transitionId);
		if (this.#bindingMatches(active.lease)) await this.#waitForZeroOperations(signal);
		await this.#currentControllerLease();
		const live = this.#bindingMatches(active.lease) && this.#activeOperations.size === 0;
		const checkpointId: FrozenCheckpointId = this.#identity();
		const canonicalCommitId: OperationId = this.#identity();
		const quiesceRequestId = await deriveProviderSubrequestId({
			workspaceId: this.#workspaceId,
			parentKind: "runtime_transition",
			parentId: transitionId,
			ordinal: 0,
			operation: "quiesce",
		});
		const quiesceRequestSha256 = await canonicalRuntimeProviderInspectionSha256V1({
			operation: "quiesce",
			request: { transitionId, requestId: quiesceRequestId, requestSha256: "", lease: active.lease },
		});
		const checkpointRequestId = await deriveProviderSubrequestId({
			workspaceId: this.#workspaceId,
			parentKind: "runtime_transition",
			parentId: transitionId,
			ordinal: 1,
			operation: "checkpoint",
		});
		const checkpointRequestSha256 = await canonicalRuntimeProviderInspectionSha256V1({
			operation: "checkpoint",
			request: {
				transitionId,
				requestId: checkpointRequestId,
				requestSha256: "",
				checkpointId,
				lease: active.lease,
			},
		});
		const revokeRequestId = await deriveProviderSubrequestId({
			workspaceId: this.#workspaceId,
			parentKind: "runtime_transition",
			parentId: transitionId,
			ordinal: 2,
			operation: "revoke",
		});
		const revokeRequestSha256 = await canonicalRuntimeProviderInspectionSha256V1({
			operation: "revoke",
			request: {
				transitionId,
				requestId: revokeRequestId,
				requestSha256: "",
				replica: active.lease.replica,
				leaseId: active.lease.leaseId,
				fenceId: active.lease.fenceId,
				reasonCode: "operation_admission_closed",
			},
		});
		const acknowledgementRequestId = await deriveProviderSubrequestId({
			workspaceId: this.#workspaceId,
			parentKind: "runtime_transition",
			parentId: transitionId,
			ordinal: 3,
			operation: "checkpoint_acknowledgement",
		});
		const releaseRequestId = await deriveProviderSubrequestId({
			workspaceId: this.#workspaceId,
			parentKind: "runtime_transition",
			parentId: transitionId,
			ordinal: 4,
			operation: "release",
		});
		const releaseRequestSha256 = await canonicalRuntimeProviderInspectionSha256V1({
			operation: "release",
			request: {
				parentOperationId: transitionId,
				requestId: releaseRequestId,
				requestSha256: "",
				replica: active.lease.replica,
				leaseId: active.lease.leaseId,
			},
		});
		const plan: RuntimeDrainPlan = live
			? {
					transitionId,
					commitReplica: true,
					freezeAuthority: "live_fence",
					checkpointId,
					canonicalCommitId,
					recovery: null,
					cacheEvictionPlan,
					requests: {
						quiesce: { transitionId, requestId: quiesceRequestId, requestSha256: quiesceRequestSha256 },
						checkpoint: { transitionId, requestId: checkpointRequestId, requestSha256: checkpointRequestSha256 },
						revoke: { transitionId, requestId: revokeRequestId, requestSha256: revokeRequestSha256 },
						checkpointAcknowledgement: { parentOperationId: transitionId, requestId: acknowledgementRequestId },
						release: {
							parentOperationId: transitionId,
							requestId: releaseRequestId,
							requestSha256: releaseRequestSha256,
						},
					},
				}
			: {
					transitionId,
					commitReplica: true,
					freezeAuthority: "control_plane_recovery",
					checkpointId: active.recovery.locator.checkpointId,
					canonicalCommitId: active.recovery.canonicalCommitId,
					recovery: active.recovery,
					cacheEvictionPlan,
					requests: {
						quiesce: null,
						checkpoint: null,
						revoke: null,
						checkpointAcknowledgement: active.recovery.requests.checkpointAcknowledgement,
						release: active.recovery.requests.release,
					},
				};
		const draining: Extract<RuntimeAttachment, { state: "draining" }> = {
			state: "draining",
			transitionId,
			active,
			reason,
			plan,
			publication: { state: "not_requested" },
			recoveryFreeze: live ? null : { state: "not_started" },
			cacheEviction: cacheEvictionPlan === null ? { state: "not_required" } : { state: "planned" },
			discardAuthorization: null,
			lastDiscardedRuntimeChanges: current.attachment.lastDiscardedRuntimeChanges,
			block: null,
		};
		current = await this.#replaceAttachment(current, draining);
		return this.#continueDrain(current, signal);
	}

	async #continueDrain(record: RuntimeAttachmentRecordV1, signal?: AbortSignal): Promise<WorkspaceCheckpoint> {
		if (record.attachment.state !== "draining") throw new Error("Runtime attachment is not draining");
		const plan = record.attachment.plan;
		if (!plan.commitReplica) {
			if (record.attachment.discardAuthorization === null)
				throw new Error("Persistent runtime discard lacks durable authorization");
			throw new Error("Authorized discard requires its exact provider-proven branch");
		}
		let current = record;
		let draining: Extract<RuntimeAttachment, { state: "draining" }> = record.attachment;
		const provider = this.#registry.get(draining.active.lease.replica.providerId);
		if (draining.publication.state === "not_requested" || draining.publication.state === "freeze_outcome_unknown") {
			if (draining.plan.freezeAuthority === "live_fence" && this.#bindingMatches(draining.active.lease)) {
				const fence = this.#binding?.fence;
				const quiesceRequest = draining.plan.requests.quiesce;
				const checkpointRequest = draining.plan.requests.checkpoint;
				const checkpointId = draining.plan.checkpointId;
				if (!fence || !quiesceRequest || !checkpointRequest || checkpointId === null) {
					throw new Error("Live runtime drain authority is incomplete");
				}
				let quiesced;
				try {
					quiesced = await provider.quiesce({ ...quiesceRequest, lease: draining.active.lease, fence, signal });
				} catch {
					const inspected = await provider.inspectQuiesce({ ...quiesceRequest, lease: draining.active.lease });
					if (inspected.status === "not_started") {
						quiesced = await provider.quiesce({ ...quiesceRequest, lease: draining.active.lease, fence, signal });
					} else if (inspected.status === "complete") quiesced = inspected.result;
					else throw new Error("Runtime quiescence remains in progress");
				}
				if (
					!exactJson(quiesced.request, quiesceRequest) ||
					!runtimeLeaseMatches(quiesced.lease, draining.active.lease) ||
					quiesced.activeCommands !== 0 ||
					quiesced.pendingSyncs !== 0
				)
					throw new Error("Runtime quiesce receipt is invalid");
				if (draining.publication.state === "not_requested") {
					current = await this.#replaceAttachment(current, {
						...draining,
						publication: {
							state: "freeze_outcome_unknown",
							locator: {
								providerId: draining.active.lease.replica.providerId,
								profileId: draining.active.lease.replica.profileId,
								workspaceId: draining.active.lease.replica.workspaceId,
								replicaId: draining.active.lease.replica.replicaId,
								leaseId: draining.active.lease.leaseId,
								checkpointId,
							},
						},
					});
					if (current.attachment.state !== "draining") throw new Error("Runtime drain state changed unexpectedly");
					draining = current.attachment;
				}
				let frozen;
				try {
					frozen = await provider.checkpoint({
						...checkpointRequest,
						checkpointId,
						lease: draining.active.lease,
						fence,
						signal,
					});
				} catch {
					const inspected = await provider.inspectCheckpoint({
						...checkpointRequest,
						checkpointId,
						lease: draining.active.lease,
					});
					if (inspected.status === "frozen" || inspected.status === "acknowledged") {
						frozen = {
							status: "already_checkpointed" as const,
							request: checkpointRequest,
							reference: inspected.reference,
						};
					} else if (inspected.status === "absent") {
						frozen = await provider.checkpoint({
							...checkpointRequest,
							checkpointId,
							lease: draining.active.lease,
							fence,
							signal,
						});
					} else throw new Error("Runtime checkpoint remains indeterminate");
				}
				if (
					!exactJson(frozen.request, checkpointRequest) ||
					frozen.reference.checkpointId !== checkpointId ||
					frozen.reference.leaseId !== draining.active.lease.leaseId ||
					frozen.reference.baseGeneration !== draining.active.lease.baseGeneration ||
					!exactJson(
						{
							providerId: frozen.reference.providerId,
							profileId: frozen.reference.profileId,
							workspaceId: frozen.reference.workspaceId,
							replicaId: frozen.reference.replicaId,
						},
						draining.active.lease.replica,
					)
				) {
					throw new Error("Runtime checkpoint receipt is invalid");
				}
				current = await this.#replaceAttachment(current, {
					...draining,
					publication: { state: "frozen", reference: frozen.reference },
				});
				if (current.attachment.state !== "draining") throw new Error("Runtime drain state changed unexpectedly");
				draining = current.attachment;
			} else {
				const recovery = draining.active.recovery;
				if (draining.plan.freezeAuthority !== "control_plane_recovery") {
					const recoveryPlan: RuntimeDrainPlan = {
						transitionId: draining.transitionId,
						commitReplica: true,
						freezeAuthority: "control_plane_recovery",
						checkpointId: recovery.locator.checkpointId,
						canonicalCommitId: recovery.canonicalCommitId,
						recovery,
						cacheEvictionPlan: draining.plan.cacheEvictionPlan,
						requests: {
							quiesce: null,
							checkpoint: null,
							revoke: null,
							checkpointAcknowledgement: recovery.requests.checkpointAcknowledgement,
							release: recovery.requests.release,
						},
					};
					current = await this.#replaceAttachment(current, {
						...draining,
						plan: recoveryPlan,
						publication: { state: "not_requested" },
						recoveryFreeze: { state: "not_started" },
					});
					if (current.attachment.state !== "draining") throw new Error("Runtime drain state changed unexpectedly");
					draining = current.attachment;
				}
				if (draining.recoveryFreeze?.state === "preservation_impossible") {
					throw new Error("Runtime preservation is impossible without explicit discard authorization");
				}
				const recoveryPlan = draining.active.recovery;
				if (draining.recoveryFreeze?.state !== "frozen") {
					if (draining.recoveryFreeze?.state === "not_started") {
						current = await this.#replaceAttachment(current, {
							...draining,
							recoveryFreeze: { state: "outcome_unknown", locator: recoveryPlan.locator },
						});
						if (current.attachment.state !== "draining")
							throw new Error("Runtime drain state changed unexpectedly");
						draining = current.attachment;
					}
					let frozen: RuntimeRecoveryFreezeResult;
					const inspected = await provider.inspectRecoveryFreeze({
						...recoveryPlan.requests.freeze,
						locator: recoveryPlan.locator,
					});
					if (inspected.status === "absent") {
						frozen = await provider.recoveryFreeze({
							...recoveryPlan.requests.freeze,
							locator: recoveryPlan.locator,
							signal,
						});
					} else if (inspected.status === "frozen") frozen = { ...inspected, status: "already_frozen" as const };
					else if (inspected.status === "preservation_impossible") {
						await this.#replaceAttachment(current, {
							...draining,
							recoveryFreeze: { state: "preservation_impossible", proof: inspected.proof },
							block: {
								state: "operator_required",
								certainty: "completed",
								stage: "recovery_freeze",
								code: "runtime_preservation_impossible",
								observedAt: this.#now(),
								next: { kind: "operator" },
							},
						});
						throw new Error("Runtime preservation is impossible without explicit discard authorization");
					} else {
						await this.#replaceAttachment(current, {
							...draining,
							recoveryFreeze: {
								state: "in_progress",
								locator: inspected.locator,
								phase: inspected.phase,
								activeCommands: inspected.activeCommands,
								pendingSyncs: inspected.pendingSyncs,
								observedAt: inspected.observedAt,
							},
						});
						throw new Error("Runtime recovery freeze remains in progress");
					}
					if ("proof" in frozen) {
						await this.#replaceAttachment(current, {
							...draining,
							recoveryFreeze: { state: "preservation_impossible", proof: frozen.proof },
							block: {
								state: "operator_required",
								certainty: "completed",
								stage: "recovery_freeze",
								code: "runtime_preservation_impossible",
								observedAt: this.#now(),
								next: { kind: "operator" },
							},
						});
						throw new Error("Runtime preservation is impossible without explicit discard authorization");
					}
					current = await this.#replaceAttachment(current, {
						...draining,
						recoveryFreeze: { state: "frozen", result: frozen },
						publication: { state: "frozen", reference: frozen.reference },
					});
					if (current.attachment.state !== "draining") throw new Error("Runtime drain state changed unexpectedly");
					draining = current.attachment;
				}
			}
		}
		if (
			draining.plan.freezeAuthority === "live_fence" &&
			draining.publication.state !== "not_requested" &&
			draining.publication.state !== "freeze_outcome_unknown"
		) {
			const revokeRequest = draining.plan.requests.revoke;
			if (!revokeRequest) throw new Error("Runtime revoke identity is missing");
			const request = {
				...revokeRequest,
				replica: draining.active.lease.replica,
				leaseId: draining.active.lease.leaseId,
				fenceId: draining.active.lease.fenceId,
				reasonCode: "operation_admission_closed" as const,
			};
			try {
				const revoked = await provider.revoke({ ...request, signal });
				if (
					!exactJson(revoked.request, revokeRequest) ||
					!exactJson(revoked.replica, draining.active.lease.replica) ||
					revoked.leaseId !== draining.active.lease.leaseId ||
					revoked.fenceId !== draining.active.lease.fenceId
				) {
					throw new Error("Runtime revoke receipt is invalid");
				}
			} catch {
				const inspected = await provider.inspectRevoke(request);
				if (inspected.status === "not_started") await provider.revoke({ ...request, signal });
				else if (!exactJson(inspected.result.request, revokeRequest))
					throw new Error("Runtime revoke inspection is invalid");
			}
			this.#binding = null;
		}
		if (draining.publication.state === "frozen") {
			const fetched = await provider.fetchCheckpoint({ reference: draining.publication.reference, signal });
			if (
				fetched.status !== "fetched" ||
				!exactJson(fetched.checkpoint.reference, draining.publication.reference) ||
				!workspaceImagesMatch(fetched.checkpoint, draining.publication.reference)
			) {
				throw new Error("Fetched runtime checkpoint is invalid");
			}
			const controllerLease = await this.#currentControllerLease();
			const canonicalCommitId = draining.plan.canonicalCommitId;
			if (canonicalCommitId === null) throw new Error("Canonical runtime commit identity is missing");
			const committed = await this.#canonicalStore.commit({
				workspaceId: this.#workspaceId,
				expectedGeneration: draining.active.lease.baseGeneration,
				commitId: canonicalCommitId,
				controllerLease: controllerLease.proof,
				replicaCheckpoint: fetched.checkpoint,
				signal,
			});
			if (committed.status !== "committed" && committed.status !== "already_committed") {
				throw new Error(`Canonical runtime checkpoint commit failed: ${committed.status}`);
			}
			if (
				committed.receipt.workspaceId !== this.#workspaceId ||
				committed.receipt.commitId !== canonicalCommitId ||
				committed.receipt.expectedGeneration !== draining.active.lease.baseGeneration ||
				committed.workspace.workspaceId !== this.#workspaceId ||
				!workspaceImagesMatch(committed.receipt.checkpoint, fetched.checkpoint) ||
				!workspaceImagesMatch(committed.workspace.checkpoint, committed.receipt.checkpoint) ||
				committed.workspace.checkpoint.generation !== committed.receipt.checkpoint.generation
			) {
				throw new Error("Canonical runtime checkpoint commit receipt is invalid");
			}
			const preallocation = draining.plan.requests.checkpointAcknowledgement;
			if (!preallocation) throw new Error("Checkpoint acknowledgement identity is missing");
			const acknowledgementDraft = {
				parentOperationId: preallocation.parentOperationId,
				requestId: preallocation.requestId,
				requestSha256: "",
				reference: draining.publication.reference,
				canonicalCommit: committed.receipt,
			};
			const requestSha256 = await canonicalRuntimeProviderInspectionSha256V1({
				operation: "checkpoint_acknowledgement",
				request: acknowledgementDraft,
			});
			current = await this.#replaceAttachment(current, {
				...draining,
				publication: {
					state: "committed",
					reference: draining.publication.reference,
					canonicalCommit: committed.receipt,
					acknowledgementRequest: { ...acknowledgementDraft, requestSha256 },
				},
			});
			if (current.attachment.state !== "draining") throw new Error("Runtime drain state changed unexpectedly");
			draining = current.attachment;
			await this.#publishCanonicalWorkspace(committed.workspace);
		}
		if (draining.publication.state === "committed") {
			const canonical = await this.#canonicalStore.inspect(this.#workspaceId);
			if (
				canonical.status !== "present" ||
				!workspaceImagesMatch(canonical.workspace.checkpoint, draining.publication.canonicalCommit.checkpoint) ||
				canonical.workspace.checkpoint.generation !== draining.publication.canonicalCommit.checkpoint.generation
			) {
				throw new Error("Canonical checkpoint publication did not converge");
			}
			await this.#publishCanonicalWorkspace(canonical.workspace);
			let acknowledgement;
			try {
				acknowledgement = await provider.acknowledgeCheckpoint({
					...draining.publication.acknowledgementRequest,
					signal,
				});
			} catch {
				const inspected = await provider.inspectCheckpointAcknowledgement(
					draining.publication.acknowledgementRequest,
				);
				if (inspected.status === "complete") acknowledgement = inspected.result;
				else
					acknowledgement = await provider.acknowledgeCheckpoint({
						...draining.publication.acknowledgementRequest,
						signal,
					});
			}
			if (
				!exactJson(acknowledgement.request, {
					parentOperationId: draining.publication.acknowledgementRequest.parentOperationId,
					requestId: draining.publication.acknowledgementRequest.requestId,
					requestSha256: draining.publication.acknowledgementRequest.requestSha256,
				}) ||
				!exactJson(acknowledgement.reference, draining.publication.reference) ||
				!exactJson(acknowledgement.canonicalCommit, draining.publication.canonicalCommit)
			) {
				throw new Error("Runtime checkpoint acknowledgement receipt is invalid");
			}
			current = await this.#replaceAttachment(current, {
				...draining,
				publication: { ...draining.publication, state: "acknowledged", acknowledgement },
			});
			if (current.attachment.state !== "draining") throw new Error("Runtime drain state changed unexpectedly");
			draining = current.attachment;
		}
		if (draining.publication.state !== "acknowledged")
			throw new Error("Runtime checkpoint is not durably acknowledged");
		const canonicalCommit = draining.publication.canonicalCommit;
		current = await this.#advanceCacheEviction(current, signal);
		if (current.attachment.state !== "draining") throw new Error("Runtime drain state changed unexpectedly");
		draining = current.attachment;
		if (
			draining.cacheEviction.state !== "not_required" &&
			draining.cacheEviction.state !== "accepted" &&
			draining.cacheEviction.state !== "deferred" &&
			draining.cacheEviction.state !== "complete"
		) {
			throw new Error("Runtime release is blocked on cache-eviction acceptance");
		}
		const releaseRequest = draining.plan.requests.release;
		const release = await this.#releaseExact(
			provider,
			{ ...releaseRequest, replica: draining.active.lease.replica, leaseId: draining.active.lease.leaseId },
			signal,
		);
		if (
			!exactJson(release.request, releaseRequest) ||
			!exactJson(release.replica, draining.active.lease.replica) ||
			release.leaseId !== draining.active.lease.leaseId ||
			(release.compute !== "stopped" && release.compute !== "not_applicable")
		)
			throw new Error("Runtime release receipt is invalid");
		const checkpoint = canonicalCommit.checkpoint;
		await this.#replaceReplica(draining.active.lease.replica, replica =>
			replica.observation.state === "absent"
				? replica
				: {
						...replica,
						observation: {
							state: "retained",
							observedAt: this.#now(),
							image: {
								rootSha256: checkpoint.rootSha256,
								fileCount: checkpoint.fileCount,
								byteCount: checkpoint.byteCount,
							},
						},
					},
		);
		const completedAt = this.#now();
		await this.#replaceAttachment(
			current,
			{
				state: "none",
				transitionId: null,
				active: null,
				lastDiscardedRuntimeChanges: draining.lastDiscardedRuntimeChanges,
				block: null,
			},
			current.scheduler,
			{
				transitionId: draining.transitionId,
				reason: draining.reason,
				from: "active",
				to: "none",
				startedAt: record.updatedAt,
				completedAt,
			},
		);
		this.#binding = null;
		return checkpoint;
	}

	async #releaseExact(
		provider: RuntimeProvider,
		request: RuntimeLeaseReleaseInspectRequest,
		signal?: AbortSignal,
	): Promise<RuntimeLeaseReleaseResult> {
		try {
			return await provider.release({ ...request, signal });
		} catch {
			const inspected = await provider.inspectRelease(request);
			if (inspected.status === "complete") return inspected.result;
			if (inspected.status === "not_requested") return provider.release({ ...request, signal });
			throw new Error("Runtime release remains in progress");
		}
	}

	async status(signal?: AbortSignal): Promise<RuntimeStatusSnapshot> {
		return this.#serialized(signal, async () => {
			const observedAt = this.#now();
			const readResult = await this.#attachmentStore.read(this.#workspaceId);
			if (readResult.status !== "present") throw new Error(`Runtime attachment unavailable: ${readResult.status}`);
			const canonical = await this.#canonicalStore.inspect(this.#workspaceId);
			if (canonical.status !== "present") throw new Error(`Canonical workspace unavailable: ${canonical.status}`);
			const persistent = await this.#persistentRecord();
			const attachment = readResult.record.attachment;
			const timingReader = runtimeTimingReadersV1.get(this.#attachmentStore);
			if (!timingReader) throw new Error("Runtime timing reader is unavailable for attachment store");
			const timing = await timingReader(this.#workspaceId);
			if (timing === null) throw new Error("Runtime timing state is unavailable");
			let transition: RuntimeTransitionStatusSnapshot;
			if (attachment.state === "none" || attachment.state === "active") {
				transition = {
					status: "none",
					currentTransitionId: null,
					currentReason: null,
					currentFrom: null,
					currentTo: null,
					currentStartedAt: null,
					currentErrorCode: null,
					lastCompleted: readResult.record.lastCompletedTransition,
				};
			} else {
				const timingTransition = timing.transition;
				if (!timingTransition || timingTransition.transitionId !== attachment.transitionId) {
					throw new Error("Runtime transition timing is missing or mismatched");
				}
				const currentTransition = {
					currentTransitionId: attachment.transitionId,
					currentReason: attachment.state === "draining" ? attachment.reason : ("first_tool" as const),
					currentFrom: attachment.state === "draining" ? ("active" as const) : ("none" as const),
					currentTo: attachment.state === "draining" ? ("none" as const) : ("active" as const),
					currentStartedAt: timingTransition.startedAt,
					lastCompleted: readResult.record.lastCompletedTransition,
				};
				transition =
					attachment.block === null
						? { ...currentTransition, status: "in_progress", currentErrorCode: null }
						: { ...currentTransition, status: "blocked", currentErrorCode: attachment.block.code };
			}
			let publication: RuntimeCheckpointPublicationProjection = { state: "not_requested" };
			if (attachment.state === "draining") {
				const publicationState = attachment.publication;
				if (publicationState.state === "freeze_outcome_unknown") {
					publication = { state: "freeze_outcome_unknown", checkpointId: publicationState.locator.checkpointId };
				} else if (publicationState.state === "frozen") {
					publication = {
						state: "frozen",
						checkpointId: publicationState.reference.checkpointId,
						rootSha256: publicationState.reference.rootSha256,
						fileCount: publicationState.reference.fileCount,
						byteCount: publicationState.reference.byteCount,
						baseGeneration: publicationState.reference.baseGeneration,
					};
				} else if (publicationState.state === "committed" || publicationState.state === "acknowledged") {
					publication = {
						state: publicationState.state,
						checkpointId: publicationState.reference.checkpointId,
						rootSha256: publicationState.reference.rootSha256,
						fileCount: publicationState.reference.fileCount,
						byteCount: publicationState.reference.byteCount,
						baseGeneration: publicationState.reference.baseGeneration,
						canonicalGeneration: publicationState.canonicalCommit.checkpoint.generation,
						canonicalCommitId: publicationState.canonicalCommit.commitId,
					};
				}
			}
			const checkpoint = {
				availability: "available" as const,
				publication,
				blockCode: attachment.block?.code ?? null,
				observedAt,
			};
			const entries = persistent.workspace.knownReplicas.entries;
			let nextCleanupAt: ISO8601 | null = null;
			const scheduleCleanup = (dueAt: ISO8601 | null): void => {
				if (dueAt !== null && (nextCleanupAt === null || dueAt < nextCleanupAt)) nextCleanupAt = dueAt;
			};
			for (const entry of entries) {
				if (entry.cacheEviction.state === "pending") {
					scheduleCleanup(
						entry.cacheEviction.progress.state === "deferred"
							? entry.cacheEviction.progress.nextAttemptAt
							: entry.cacheEviction.plan.retentionDeadline,
					);
				}
				if (entry.cleanup.state === "pending") scheduleCleanup(entry.cleanup.nextAttemptAt);
				if (entry.cleanup.state === "failed" && entry.cleanup.retryable) {
					scheduleCleanup(entry.cleanup.nextRetryAt);
				}
			}
			const elapsedSinceTiming = Date.parse(observedAt) - Date.parse(timing.observedThrough);
			if (!Number.isSafeInteger(elapsedSinceTiming) || elapsedSinceTiming < 0) {
				throw new Error("Runtime timing state is ahead of status observation");
			}
			const accumulatedActiveRuntimeMs =
				timing.accumulatedActiveRuntimeMs + (timing.placement === "active" ? elapsedSinceTiming : 0);
			const accumulatedZeroRuntimeIdleMs =
				timing.accumulatedZeroRuntimeIdleMs + (timing.placement === "idle" ? elapsedSinceTiming : 0);
			if (!Number.isSafeInteger(accumulatedActiveRuntimeMs) || !Number.isSafeInteger(accumulatedZeroRuntimeIdleMs)) {
				throw new Error("Runtime timing accumulation overflow");
			}
			const lastCompleted = readResult.record.lastCompletedTransition;
			const lastCompletedDurationMs =
				lastCompleted === null ? null : Date.parse(lastCompleted.completedAt) - Date.parse(lastCompleted.startedAt);
			if (
				lastCompletedDurationMs !== null &&
				(!Number.isSafeInteger(lastCompletedDurationMs) || lastCompletedDurationMs < 0)
			) {
				throw new Error("Runtime completed transition duration is invalid");
			}
			const replicaCleanup = {
				availability: "available" as const,
				deletionState:
					persistent.workspace.canonical.state === "present"
						? ("retained" as const)
						: persistent.workspace.canonical.state,
				knownReplicaCount: entries.length,
				retainedReplicaCount: entries.filter(row => row.observation.state === "retained").length,
				cacheEvictionPendingCount: entries.filter(row => row.cacheEviction.state === "pending").length,
				cacheEvictionCompleteCount: entries.filter(row => row.cacheEviction.state === "complete").length,
				cleanupPendingCount: entries.filter(row => row.cleanup.state === "pending").length,
				cleanupCompleteCount: entries.filter(row => row.cleanup.state === "complete").length,
				cleanupFailedCount: entries.filter(row => row.cleanup.state === "failed").length,
				nextCleanupAt,
				observedAt,
			};
			const latency = {
				createToFirstModelTokenMs: null,
				createToFirstWorkspaceReadyMs: null,
				lastSchedulerMs: readResult.record.scheduler.durationMs,
				lastReadyLatencyMs: lastCompleted?.to === "active" ? lastCompletedDurationMs : null,
				lastDrainMs: lastCompleted?.to === "none" ? lastCompletedDurationMs : null,
				lastQuiesceMs: null,
				lastSyncMs: null,
				lastCanonicalPublishMs: null,
				lastReleaseMs: null,
				lastReplicaCleanupMs: null,
				accumulatedActiveRuntimeMs,
				accumulatedZeroRuntimeIdleMs,
				observedThrough: observedAt,
			};
			const schedulerDecision = readResult.record.scheduler.decision;
			const selectedCandidate =
				schedulerDecision.status === "selected"
					? readResult.record.scheduler.candidates.find(
							candidate =>
								candidate.providerId === schedulerDecision.providerId &&
								candidate.profileId === schedulerDecision.profileId,
						)
					: undefined;
			const activeCostRate = selectedCandidate?.estimatedIncrementalCostMicrosPerHour;
			const conservativeUpperBoundMicros =
				activeCostRate === undefined
					? null
					: (BigInt(activeCostRate) * BigInt(accumulatedActiveRuntimeMs) + 3_599_999n) / 3_600_000n;
			const cost =
				selectedCandidate === undefined ||
				activeCostRate === undefined ||
				conservativeUpperBoundMicros === null ||
				conservativeUpperBoundMicros > BigInt(Number.MAX_SAFE_INTEGER)
					? { availability: "unavailable" as const, reasonCode: "cost_status_unavailable" as const, observedAt }
					: {
							availability: "available" as const,
							estimateSource:
								readResult.record.scheduler.input?.configuredProviderId === selectedCandidate.providerId
									? ("configured" as const)
									: ("provider" as const),
							currency: "USD" as const,
							unitRateMicrosPerHour: activeCostRate,
							estimatedIncrementalCostMicrosPerHour: activeCostRate,
							measuredActiveIntervalMs: accumulatedActiveRuntimeMs,
							conservativeUpperBoundMicros: Number(conservativeUpperBoundMicros),
							observedAt,
						};
			const common = {
				workspaceGeneration: canonical.workspace.checkpoint.generation,
				scheduler: readResult.record.scheduler,
				transition,
				checkpoint,
				replicaCleanup,
				latency,
				cost,
				observedAt,
			};
			if (attachment.state === "none")
				return this.#observeRuntimeStatus({
					...common,
					state: "none",
					block: attachment.block,
					providerId: null,
					profileId: null,
					leaseId: null,
					compute: null,
					activeOperationCount: 0,
				});
			if (attachment.state === "acquiring")
				return this.#observeRuntimeStatus({
					...common,
					state: "acquiring",
					block: attachment.block,
					providerId: attachment.plan.target.candidate.providerId,
					profileId: attachment.plan.target.candidate.profileId,
					leaseId: attachment.progress.lease?.leaseId ?? null,
					compute: null,
					activeOperationCount: 0,
				});
			const active = attachment.active;
			let compute: "not_applicable" | "stopped" | "running" | "unknown" = "unknown";
			try {
				const inspected = await this.#registry.get(active.lease.replica.providerId).inspect({
					replica: active.lease.replica,
					leaseId: active.lease.leaseId,
					fence: this.#bindingMatches(active.lease) ? (this.#binding?.fence ?? null) : null,
				});
				compute = inspected.status === "present" ? inspected.compute : "unknown";
			} catch {
				compute = "unknown";
			}
			const activeOperationCount = this.#bindingMatches(active.lease)
				? this.#activeOperations.size
				: ("unknown" as const);
			return this.#observeRuntimeStatus(
				attachment.state === "active"
					? {
							...common,
							state: "active",
							block: null,
							providerId: active.target.candidate.providerId,
							profileId: active.target.candidate.profileId,
							leaseId: active.lease.leaseId,
							compute,
							activeOperationCount,
						}
					: {
							...common,
							state: "draining",
							block: attachment.block,
							providerId: active.target.candidate.providerId,
							profileId: active.target.candidate.profileId,
							leaseId: active.lease.leaseId,
							compute,
							activeOperationCount,
						},
			);
		});
	}
}
