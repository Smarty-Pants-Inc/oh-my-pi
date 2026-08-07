import type { ISO8601, OperationId, Sha256Ref } from "../registry/persistent-agent-contracts.js";
import type { RuntimeDurableStateStoreV1 } from "./managed-workspace.js";
import type { RuntimeTransientAuthorityV1 } from "./workspace-controller-codecs.js";
import {
	addMilliseconds,
	cleanupProofMatches,
	controllerProofMatches,
	exactJson,
	lifecycleCleanupPlanTuple,
	lifecycleCleanupTransitionAllowed,
	lifecycleControlledTransitionAllowed,
	lifecyclePendingJoinsAuthority,
	lifecyclePlanJoinsAuthority,
	lifecycleTupleRef,
	nowIso,
	publicationMapKey,
	publicationState,
	renewalDeadline,
	sameLifecycleImmutableAuthority,
	TRANSIENT_NAMESPACE,
	transientKey,
	transientRuntimeState,
	validLifecycleAuthority,
	validLifecycleCleanupPlan,
	validLifecycleDiscardReceipt,
	validLifecyclePendingReceipt,
	validLifecycleTerminalEvidence,
} from "./workspace-controller-codecs.js";
import type {
	TransientTaskCanonicalWorktreePublicationAttemptV1,
	TransientTaskCanonicalWorktreePublicationNotAppliedReceiptV1,
	TransientTaskCleanupAuthorityProofV1,
	TransientTaskCleanupAuthorityV1,
	TransientTaskControllerAuthorityProofV1,
	TransientTaskControllerAuthorityV1,
	TransientTaskWorktreePublicationReceiptV1,
	TransientTaskWorkspaceAuthorityStoreV1,
	TransientTaskWorkspaceAuthorityV1,
	TransientTaskWorkspaceCreatePlanV1,
	TransientTaskWorkspaceKeyV1,
} from "./workspace-runtime-contracts.js";

type CleanupAuthorityV1 = Extract<TransientTaskWorkspaceAuthorityV1, { readonly state: "cleanup" }>;

function publicationReceiptMatchesAttempt(
	receipt: TransientTaskWorktreePublicationReceiptV1,
	attempt: TransientTaskCanonicalWorktreePublicationAttemptV1,
): boolean {
	const request = attempt.request;
	return (
		receipt.taskId === request.taskId &&
		receipt.runId === request.runId &&
		receipt.workspaceId === request.workspaceId &&
		receipt.createId === request.createId &&
		receipt.cleanupId === request.cleanupId &&
		receipt.cleanupAuthorityId === request.cleanupAuthorityId &&
		receipt.worktreePublicationId === request.worktreePublicationId &&
		receipt.effectIdentityManifestSha256 === request.effectIdentityManifestSha256 &&
		exactJson(receipt.publicationTargetKey, request.publicationTargetKey) &&
		exactJson(receipt.publicationClaim, request.publicationClaim) &&
		receipt.bindingRevision === request.bindingRevision &&
		receipt.bindingRenewalSequence === request.bindingRenewalSequence &&
		receipt.bindingReceiptSha256 === request.bindingReceiptSha256 &&
		receipt.bindingAuthoritySha256 === request.bindingAuthoritySha256 &&
		receipt.bindingOpenRequestSha256 === request.bindingOpenRequestSha256 &&
		exactJson(receipt.checkpoint, request.checkpoint) &&
		receipt.requestSha256 === request.requestSha256 &&
		receipt.attemptSha256 === attempt.attemptSha256
	);
}

function publicationNotAppliedMatchesAttempt(
	proof: TransientTaskCanonicalWorktreePublicationNotAppliedReceiptV1,
	attempt: TransientTaskCanonicalWorktreePublicationAttemptV1,
): boolean {
	const request = attempt.request;
	return (
		proof.taskId === request.taskId &&
		proof.runId === request.runId &&
		proof.cleanupId === request.cleanupId &&
		proof.cleanupAuthorityId === request.cleanupAuthorityId &&
		proof.worktreePublicationId === request.worktreePublicationId &&
		exactJson(proof.publicationTargetKey, request.publicationTargetKey) &&
		proof.publicationClaimSha256 === request.publicationClaim.claimSha256 &&
		proof.publicationRequestSha256 === request.requestSha256 &&
		proof.publicationAttemptSha256 === attempt.attemptSha256
	);
}

function noEffectsBranchMatchesCurrent(current: CleanupAuthorityV1, next: CleanupAuthorityV1): boolean {
	const progress = next.cleanup.progress;
	if (progress.state !== "branch_selected" || progress.branch.kind !== "fast_discard") return true;
	const proof = progress.branch.assessment.proof;
	const checkpoint = current.canonical.checkpoint;
	return (
		exactJson(next.canonical, current.canonical) &&
		exactJson(next.runtime, current.runtime) &&
		exactJson(proof.baseCheckpoint, checkpoint) &&
		proof.observedImage.rootSha256 === checkpoint.rootSha256 &&
		proof.observedImage.fileCount === checkpoint.fileCount &&
		proof.observedImage.byteCount === checkpoint.byteCount &&
		Date.parse(proof.observedAt) >= Date.parse(current.updatedAt)
	);
}

function canonicalTransitionMatchesFrozenCommit(current: CleanupAuthorityV1, next: CleanupAuthorityV1): boolean {
	if (exactJson(next.canonical, current.canonical)) return true;
	const runtime = next.runtime.attachment;
	if (runtime.state !== "draining") return false;
	const publication = runtime.publication;
	if (publication.state !== "committed" && publication.state !== "acknowledged") return false;
	const branch = "branch" in next.cleanup.progress ? next.cleanup.progress.branch : null;
	if (branch?.kind !== "preserve") return false;
	const plan = current.cleanup.plan.preservingDrain;
	const provider = current.providerWorkspace;
	const commit = publication.canonicalCommit;
	const reference = publication.reference;
	if (
		!exactJson(runtime.plan, plan) ||
		commit.workspaceId !== current.workspaceId ||
		commit.commitId !== plan.canonicalCommitId ||
		commit.expectedGeneration !== current.cleanup.plan.expectedCanonical.checkpoint.generation ||
		!exactJson(next.canonical, { ...current.canonical, checkpoint: commit.checkpoint }) ||
		reference.workspaceId !== current.workspaceId ||
		reference.providerId !== provider.lease.replica.providerId ||
		reference.profileId !== provider.lease.replica.profileId ||
		reference.replicaId !== provider.lease.replica.replicaId ||
		reference.leaseId !== provider.lease.leaseId ||
		reference.checkpointId !== plan.checkpointId ||
		reference.baseGeneration !== commit.expectedGeneration ||
		reference.rootSha256 !== commit.checkpoint.rootSha256 ||
		reference.fileCount !== commit.checkpoint.fileCount ||
		reference.byteCount !== commit.checkpoint.byteCount
	)
		return false;
	return (
		publication.state !== "acknowledged" ||
		(exactJson(publication.acknowledgement.reference, reference) &&
			exactJson(publication.acknowledgement.canonicalCommit, commit))
	);
}

function publicationProgressPreservesRuntime(current: CleanupAuthorityV1, next: CleanupAuthorityV1): boolean {
	const currentState = current.cleanup.progress.state;
	const nextState = next.cleanup.progress.state;
	if (
		(currentState === "runtime_draining" && nextState === "worktree_publication_outcome_unknown") ||
		((currentState === "worktree_publication_outcome_unknown" ||
			currentState === "worktree_publication_not_applied") &&
			(nextState === "worktree_publication_outcome_unknown" ||
				nextState === "worktree_publication_not_applied" ||
				nextState === "worktree_published"))
	)
		return exactJson(next.runtime, current.runtime) && exactJson(next.canonical, current.canonical);
	return true;
}

export class TransientTaskWorkspaceAuthorityStore
	implements TransientTaskWorkspaceAuthorityStoreV1, RuntimeTransientAuthorityV1
{
	readonly #durable: RuntimeDurableStateStoreV1;
	readonly #now: () => ISO8601;

	constructor(options: { readonly durable: RuntimeDurableStateStoreV1; readonly now?: () => ISO8601 }) {
		this.#durable = options.durable;
		this.#now = options.now ?? nowIso;
	}

	#base(plan: TransientTaskWorkspaceCreatePlanV1, controlHostId: string, now: ISO8601) {
		return {
			schemaVersion: 1 as const,
			taskId: plan.taskId,
			runId: plan.runId,
			revision: 0,
			createId: plan.createId,
			controlHostId,
			cleanupAuthorityId: plan.cleanupAuthorityId,
			resultPublicationId: plan.resultPublicationId,
			capturePreparationId: plan.capturePreparationId,
			captureId: plan.captureId,
			semanticMergeId: plan.semanticMergeId,
			semanticMergeFinishId: plan.semanticMergeFinishId,
			isolationCleanupId: plan.isolationCleanupId,
			resultCompositionId: plan.resultCompositionId,
			effectIdentityManifest: plan.effectIdentityManifest,
			postTerminalIntentSha256: plan.postTerminalIntentSha256,
			isolationNamespaceSha256: plan.isolationNamespaceSha256,
			isolationOwnerManifestSha256: plan.isolationOwnerManifestSha256,
			isolationCreatorDescriptorSha256: plan.isolationCreatorDescriptorSha256,
			publicationTargetId: plan.publicationTargetId,
			resultPublicationTargetId: plan.resultPublicationTargetId,
			resultPublicationTargetCleanupId: plan.resultPublicationTargetCleanupId,
			pendingPayloadId: plan.pendingPayloadId,
			pendingPayloadDeleteId: plan.pendingPayloadDeleteId,
			composedPayloadId: plan.composedPayloadId,
			composedPayloadDeleteId: plan.composedPayloadDeleteId,
			resultlessIdentity: plan.resultlessIdentity,
			resultlessMaximumUtf8ByteLength: plan.resultlessMaximumUtf8ByteLength,
			resultlessRepresentabilityPreflightSha256: plan.resultlessRepresentabilityPreflightSha256,
			resultPublicationPrePendingPlanSha256: plan.resultPublicationPrePendingPlanSha256,
			workspaceId: plan.workspaceId,
			createdAt: now,
			updatedAt: now,
		};
	}

	async create(request: Parameters<TransientTaskWorkspaceAuthorityStoreV1["create"]>[0]) {
		const key = { taskId: request.plan.taskId, runId: request.plan.runId };
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(key), currentInput => {
			const state = transientRuntimeState(key, currentInput);
			if (state.authority) {
				if (state.authority.state === "deleted" || state.authority.state === "discarded") {
					return { state, result: { status: "conflict", code: "terminal_key_reuse" } as const };
				}
				const same =
					state.authority.createId === request.plan.createId &&
					state.authority.effectIdentityManifest.manifestSha256 ===
						request.plan.effectIdentityManifest.manifestSha256;
				return same
					? { state, result: { status: "already_created", authority: state.authority } as const }
					: { state, result: { status: "conflict", code: "same_key_different_plan" } as const };
			}
			const observedAt = this.#now();
			const controller: TransientTaskControllerAuthorityV1 = {
				proof: {
					schemaVersion: 1,
					taskId: request.plan.taskId,
					runId: request.plan.runId,
					createId: request.plan.createId,
					controllerId: request.plan.controllerId,
					workspaceId: request.plan.workspaceId,
					controlHostId: request.controlHostId,
					controllerEpoch: 1,
					fencingGeneration: 1,
				},
				acquiredAt: observedAt,
				renewBy: renewalDeadline(observedAt, request.ttlMs),
				expiresAt: addMilliseconds(observedAt, request.ttlMs),
			};
			const authority: TransientTaskWorkspaceAuthorityV1 = {
				...this.#base(request.plan, request.controlHostId, observedAt),
				state: "preparing",
				controller,
				isolationPreparation: request.isolationPreparation,
				canonical: null,
				providerWorkspace: null,
				runtime: null,
				cleanup: null,
			};
			if (
				!validLifecycleAuthority(authority) ||
				!exactJson(request.isolationPreparation.activeAttempt.request.controller, controller.proof)
			)
				throw new Error("Transient task create authority is invalid");
			return { state: { ...state, authority }, result: { status: "created", authority } as const };
		});
	}

	async inspect(key: TransientTaskWorkspaceKeyV1) {
		try {
			const state = transientRuntimeState(key, await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(key)));
			return state.authority
				? ({ status: "present", authority: state.authority } as const)
				: ({ status: "absent", key } as const);
		} catch {
			return { status: "invalid", key, code: "record_invariant_violation" } as const;
		}
	}

	async acquireController(request: Parameters<TransientTaskWorkspaceAuthorityStoreV1["acquireController"]>[0]) {
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(request.key), currentInput => {
			const state = transientRuntimeState(request.key, currentInput);
			const current = state.authority;
			if (!current || current.createId !== request.createId) {
				return { state, result: { status: "conflict" } as const };
			}
			if (current.state === "deleted" || current.state === "discarded") {
				return { state, result: { status: "terminal", terminalState: current.state } as const };
			}
			if (current.state === "cleanup") {
				return { state, result: { status: "cleanup_latched", cleanupId: current.cleanup.plan.cleanupId } as const };
			}
			const controller = current.controller;
			if (!controller) return { state, result: { status: "conflict" } as const };
			const observedAt = this.#now();
			if (
				Date.parse(controller.expiresAt) > Date.parse(observedAt) &&
				(controller.proof.controllerId !== request.controllerId ||
					controller.proof.controlHostId !== request.controlHostId)
			) {
				return {
					state,
					result: { status: "busy", renewBy: controller.renewBy, expiresAt: controller.expiresAt } as const,
				};
			}
			const authority: TransientTaskControllerAuthorityV1 = {
				proof: {
					...controller.proof,
					controllerId: request.controllerId,
					controlHostId: request.controlHostId,
					controllerEpoch: controller.proof.controllerEpoch + 1,
					fencingGeneration: controller.proof.fencingGeneration + 1,
				},
				acquiredAt: observedAt,
				renewBy: renewalDeadline(observedAt, request.ttlMs),
				expiresAt: addMilliseconds(observedAt, request.ttlMs),
			};
			const next = {
				...current,
				revision: current.revision + 1,
				controller: authority,
				updatedAt: observedAt,
			} as TransientTaskWorkspaceAuthorityV1;
			return { state: { ...state, authority: next }, result: { status: "acquired", authority } as const };
		});
	}

	async renewController(request: Parameters<TransientTaskWorkspaceAuthorityStoreV1["renewController"]>[0]) {
		const key = { taskId: request.proof.taskId, runId: request.proof.runId };
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(key), currentInput => {
			const state = transientRuntimeState(key, currentInput);
			const current = state.authority;
			if (!current || current.state === "cleanup" || current.state === "deleted" || current.state === "discarded") {
				return { state, result: { status: "lost" } as const };
			}
			const controller = current.controller;
			if (
				!controller ||
				!controllerProofMatches(controller.proof, request.proof) ||
				Date.parse(controller.expiresAt) <= Date.parse(this.#now())
			)
				return { state, result: { status: "lost" } as const };
			const observedAt = this.#now();
			const authority = {
				...controller,
				renewBy: renewalDeadline(observedAt, request.ttlMs),
				expiresAt: addMilliseconds(observedAt, request.ttlMs),
			};
			const next = { ...current, controller: authority, updatedAt: observedAt } as TransientTaskWorkspaceAuthorityV1;
			return { state: { ...state, authority: next }, result: { status: "renewed", authority } as const };
		});
	}

	async replaceControlled(request: Parameters<TransientTaskWorkspaceAuthorityStoreV1["replaceControlled"]>[0]) {
		const key = { taskId: request.controller.taskId, runId: request.controller.runId };
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(key), currentInput => {
			const state = transientRuntimeState(key, currentInput);
			const current = state.authority;
			if (!current) return { state, result: { status: "invalid" } as const };
			if (current.state === "cleanup" || current.state === "deleted" || current.state === "discarded")
				return { state, result: { status: "cleanup_latched" } as const };
			if (!current.controller || !controllerProofMatches(current.controller.proof, request.controller))
				return { state, result: { status: "controller_lost" } as const };
			if (current.revision !== request.expectedRevision)
				return { state, result: { status: "revision_conflict" } as const };
			const next = request.next;
			if (!validLifecycleAuthority(next)) return { state, result: { status: "invalid" } as const };
			if (next.state === "cleanup" || next.state === "deleted" || next.state === "discarded")
				return { state, result: { status: "invalid" } as const };
			if (
				next.revision !== request.expectedRevision + 1 ||
				!lifecycleControlledTransitionAllowed(current, next) ||
				!sameLifecycleImmutableAuthority(current, next) ||
				!exactJson(next.controller, current.controller) ||
				Date.parse(next.updatedAt) < Date.parse(current.updatedAt)
			)
				return { state, result: { status: "invalid" } as const };
			return {
				state: { ...state, authority: next },
				result: { status: "replaced", authority: next } as const,
			};
		});
	}

	async beginCleanup(request: Parameters<TransientTaskWorkspaceAuthorityStoreV1["beginCleanup"]>[0]) {
		const key = { taskId: request.controller.taskId, runId: request.controller.runId };
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(key), async currentInput => {
			const state = transientRuntimeState(key, currentInput);
			const current = state.authority;
			if (!current) return { state, result: { status: "pending_outcome_missing" } as const };
			if (current.state === "deleted" || current.state === "discarded")
				return { state, result: { status: "terminal" } as const };
			if (current.state === "cleanup") {
				const same =
					validLifecycleCleanupPlan(request.plan) &&
					validLifecyclePendingReceipt(request.pendingOutcomeReceipt) &&
					request.planSha256 === lifecycleTupleRef(lifecycleCleanupPlanTuple(request.plan)) &&
					exactJson(current.cleanup.plan, request.plan) &&
					current.cleanup.planSha256 === request.planSha256 &&
					exactJson(current.cleanup.pendingOutcomeReceipt, request.pendingOutcomeReceipt);
				return same
					? { state, result: { status: "already_started", authority: current } as const }
					: { state, result: { status: "plan_conflict" } as const };
			}
			if (!current.controller || !controllerProofMatches(current.controller.proof, request.controller))
				return { state, result: { status: "controller_lost" } as const };
			if (current.revision !== request.expectedRevision)
				return { state, result: { status: "revision_conflict" } as const };
			if (current.state !== "active") return { state, result: { status: "pending_outcome_missing" } as const };
			if (
				!validLifecycleCleanupPlan(request.plan) ||
				!validLifecyclePendingReceipt(request.pendingOutcomeReceipt) ||
				request.planSha256 !== lifecycleTupleRef(lifecycleCleanupPlanTuple(request.plan)) ||
				request.plan.expectedAuthorityRevision !== current.revision ||
				!lifecyclePlanJoinsAuthority(request.plan, current as unknown as Record<string, unknown>) ||
				!lifecyclePendingJoinsAuthority(
					request.pendingOutcomeReceipt,
					current as unknown as Record<string, unknown>,
				) ||
				request.plan.pendingOutcomeSha256 !== request.pendingOutcomeReceipt.outcomeSha256 ||
				request.plan.pendingOutcomeReceiptSha256 !== request.pendingOutcomeReceipt.receiptSha256 ||
				request.plan.outcome !== request.pendingOutcomeReceipt.outcome ||
				!exactJson(request.plan.expectedCanonical, current.canonical) ||
				!exactJson(request.plan.expectedProvider, current.providerWorkspace)
			)
				return { state, result: { status: "plan_conflict" } as const };
			const pendingMapKey = publicationMapKey({
				schemaVersion: 1,
				taskId: current.taskId,
				runId: current.runId,
				createId: current.createId,
				resultPublicationId: current.resultPublicationId,
				resultPublicationTargetId: current.resultPublicationTargetId,
				resultPublicationTargetCleanupId: current.resultPublicationTargetCleanupId,
			});
			const durablePending = await publicationState(state.publications[pendingMapKey]);
			if (
				durablePending?.state !== "pending" ||
				!validLifecyclePendingReceipt(durablePending.receipt) ||
				!exactJson(durablePending.receipt, request.pendingOutcomeReceipt)
			)
				return { state, result: { status: "pending_outcome_missing" } as const };
			const observedAt = this.#now();
			const authority: TransientTaskCleanupAuthorityV1 = {
				proof: {
					schemaVersion: 1,
					taskId: key.taskId,
					runId: key.runId,
					cleanupId: request.plan.cleanupId,
					cleanupAuthorityId: request.plan.cleanupAuthorityId,
					workspaceId: current.workspaceId,
					controlHostId: request.controller.controlHostId,
					cleanupEpoch: 1,
					fencingGeneration: request.controller.fencingGeneration + 1,
				},
				acquiredAt: observedAt,
				renewBy: renewalDeadline(observedAt, request.ttlMs),
				expiresAt: addMilliseconds(observedAt, request.ttlMs),
			};
			const next: TransientTaskWorkspaceAuthorityV1 = {
				...current,
				state: "cleanup",
				revision: current.revision + 1,
				controller: null,
				canonical: current.canonical,
				providerWorkspace: current.providerWorkspace,
				runtime: current.runtime,
				cleanup: {
					plan: request.plan,
					planSha256: request.planSha256,
					pendingOutcomeReceipt: request.pendingOutcomeReceipt,
					authority,
					progress: { state: "planned" },
				},
				updatedAt: observedAt,
			};
			if (!validLifecycleAuthority(next)) return { state, result: { status: "plan_conflict" } as const };
			return { state: { ...state, authority: next }, result: { status: "started", authority: next } as const };
		});
	}

	async acquireCleanup(request: Parameters<TransientTaskWorkspaceAuthorityStoreV1["acquireCleanup"]>[0]) {
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(request.key), currentInput => {
			const state = transientRuntimeState(request.key, currentInput);
			const current = state.authority;
			if (!current) return { state, result: { status: "missing" } as const };
			if (current.state === "deleted" || current.state === "discarded")
				return { state, result: { status: "terminal", terminalState: current.state } as const };
			if (
				current.state !== "cleanup" ||
				current.cleanup.plan.cleanupId !== request.cleanupId ||
				current.cleanup.plan.cleanupAuthorityId !== request.cleanupAuthorityId ||
				current.cleanup.planSha256 !== request.planSha256
			) {
				return { state, result: { status: "conflict" } as const };
			}
			const observedAt = this.#now();
			if (
				Date.parse(current.cleanup.authority.expiresAt) > Date.parse(observedAt) &&
				current.cleanup.authority.proof.controlHostId !== request.controlHostId
			) {
				return {
					state,
					result: {
						status: "busy",
						renewBy: current.cleanup.authority.renewBy,
						expiresAt: current.cleanup.authority.expiresAt,
					} as const,
				};
			}
			const authority: TransientTaskCleanupAuthorityV1 = {
				proof: {
					...current.cleanup.authority.proof,
					controlHostId: request.controlHostId,
					cleanupEpoch: current.cleanup.authority.proof.cleanupEpoch + 1,
					fencingGeneration: current.cleanup.authority.proof.fencingGeneration + 1,
				},
				acquiredAt: observedAt,
				renewBy: renewalDeadline(observedAt, request.ttlMs),
				expiresAt: addMilliseconds(observedAt, request.ttlMs),
			};
			const next: TransientTaskWorkspaceAuthorityV1 = {
				...current,
				revision: current.revision + 1,
				cleanup: { ...current.cleanup, authority },
				updatedAt: observedAt,
			};
			return { state: { ...state, authority: next }, result: { status: "acquired", authority } as const };
		});
	}

	async renewCleanup(request: Parameters<TransientTaskWorkspaceAuthorityStoreV1["renewCleanup"]>[0]) {
		const key = { taskId: request.proof.taskId, runId: request.proof.runId };
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(key), currentInput => {
			const state = transientRuntimeState(key, currentInput);
			const current = state.authority;
			if (
				current?.state !== "cleanup" ||
				!cleanupProofMatches(current.cleanup.authority.proof, request.proof) ||
				Date.parse(current.cleanup.authority.expiresAt) <= Date.parse(this.#now())
			)
				return { state, result: { status: "lost" } as const };
			const observedAt = this.#now();
			const authority = {
				...current.cleanup.authority,
				renewBy: renewalDeadline(observedAt, request.ttlMs),
				expiresAt: addMilliseconds(observedAt, request.ttlMs),
			};
			const next: TransientTaskWorkspaceAuthorityV1 = {
				...current,
				cleanup: { ...current.cleanup, authority },
				updatedAt: observedAt,
			};
			return { state: { ...state, authority: next }, result: { status: "renewed", authority } as const };
		});
	}

	async replaceCleanup(request: Parameters<TransientTaskWorkspaceAuthorityStoreV1["replaceCleanup"]>[0]) {
		const key = { taskId: request.cleanup.taskId, runId: request.cleanup.runId };
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(key), currentInput => {
			const state = transientRuntimeState(key, currentInput);
			const current = state.authority;
			if (current?.state !== "cleanup" || !cleanupProofMatches(current.cleanup.authority.proof, request.cleanup)) {
				return { state, result: { status: "cleanup_lost" } as const };
			}
			if (current.revision !== request.expectedRevision)
				return { state, result: { status: "revision_conflict" } as const };
			if (
				!validLifecycleAuthority(request.next) ||
				request.next.state !== "cleanup" ||
				request.next.revision !== request.expectedRevision + 1 ||
				!sameLifecycleImmutableAuthority(current, request.next) ||
				!exactJson(request.next.providerWorkspace, current.providerWorkspace) ||
				!exactJson(request.next.cleanup.plan, current.cleanup.plan) ||
				request.next.cleanup.planSha256 !== current.cleanup.planSha256 ||
				!exactJson(request.next.cleanup.pendingOutcomeReceipt, current.cleanup.pendingOutcomeReceipt) ||
				!exactJson(request.next.cleanup.authority, current.cleanup.authority) ||
				Date.parse(request.next.updatedAt) < Date.parse(current.updatedAt)
			) {
				return { state, result: { status: "invalid" } as const };
			}
			const currentProgress = current.cleanup.progress;
			const nextProgress = request.next.cleanup.progress;
			if (!lifecycleCleanupTransitionAllowed(currentProgress, nextProgress))
				return { state, result: { status: "invalid" } as const };
			if (
				(currentProgress.state === "worktree_publication_outcome_unknown" ||
					currentProgress.state === "worktree_publication_not_applied") &&
				nextProgress.state === "worktree_published" &&
				!publicationReceiptMatchesAttempt(nextProgress.receipt, currentProgress.attempt)
			)
				return { state, result: { status: "invalid" } as const };
			if (
				currentProgress.state === "worktree_publication_outcome_unknown" &&
				nextProgress.state === "worktree_publication_not_applied" &&
				!publicationNotAppliedMatchesAttempt(nextProgress.proof, currentProgress.attempt)
			)
				return { state, result: { status: "invalid" } as const };
			if (
				currentProgress.state === "worktree_publication_not_applied" &&
				nextProgress.state === "worktree_publication_not_applied" &&
				!exactJson(nextProgress.proof, currentProgress.proof)
			)
				return { state, result: { status: "invalid" } as const };
			if (
				currentProgress.state === "worktree_published" &&
				nextProgress.state === "worktree_published" &&
				!exactJson(nextProgress.receipt, currentProgress.receipt)
			)
				return { state, result: { status: "invalid" } as const };
			if (
				currentProgress.state === "worktree_published" &&
				nextProgress.state === "runtime_released" &&
				!exactJson(nextProgress.worktreePublication, currentProgress.receipt)
			)
				return { state, result: { status: "invalid" } as const };
			if (
				"attempt" in currentProgress &&
				"attempt" in nextProgress &&
				!(
					currentProgress.state === "worktree_publication_not_applied" &&
					nextProgress.state === "worktree_publication_outcome_unknown"
				) &&
				!exactJson(currentProgress.attempt, nextProgress.attempt)
			)
				return { state, result: { status: "invalid" } as const };
			if (
				"branch" in currentProgress &&
				currentProgress.branch !== null &&
				"branch" in nextProgress &&
				nextProgress.branch !== null &&
				!exactJson(currentProgress.branch, nextProgress.branch)
			)
				return { state, result: { status: "invalid" } as const };
			if (
				"prepared" in currentProgress &&
				"prepared" in nextProgress &&
				!exactJson(currentProgress.prepared, nextProgress.prepared)
			)
				return { state, result: { status: "invalid" } as const };
			if (
				"result" in currentProgress &&
				"result" in nextProgress &&
				!exactJson(currentProgress.result, nextProgress.result)
			)
				return { state, result: { status: "invalid" } as const };
			if (
				currentProgress.state === "runtime_draining" &&
				nextProgress.state === "worktree_publication_outcome_unknown" &&
				nextProgress.attempt.request.expectedAuthorityRevision !== current.revision
			)
				return { state, result: { status: "invalid" } as const };
			if (
				!noEffectsBranchMatchesCurrent(current, request.next) ||
				!canonicalTransitionMatchesFrozenCommit(current, request.next) ||
				!publicationProgressPreservesRuntime(current, request.next)
			)
				return { state, result: { status: "invalid" } as const };
			return {
				state: { ...state, authority: request.next },
				result: { status: "replaced", authority: request.next } as const,
			};
		});
	}

	async finishCleanup(request: Parameters<TransientTaskWorkspaceAuthorityStoreV1["finishCleanup"]>[0]) {
		const key = { taskId: request.cleanup.taskId, runId: request.cleanup.runId };
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(key), currentInput => {
			const state = transientRuntimeState(key, currentInput);
			const current = state.authority;
			if (!validLifecycleDiscardReceipt(request.canonicalDiscard))
				return { state, result: { status: "discard_receipt_invalid" } as const };
			if (!validLifecycleTerminalEvidence(request.evidence))
				return { state, result: { status: "evidence_invalid" } as const };
			if (!current) return { state, result: { status: "conflict" } as const };
			if (current.state === "deleted" || current.state === "discarded") {
				return exactJson(current.cleanup.progress.evidence, request.evidence) &&
					exactJson(current.cleanup.progress.evidence.canonicalDiscard, request.canonicalDiscard)
					? { state, result: { status: "already_terminal", authority: current } as const }
					: { state, result: { status: "conflict" } as const };
			}
			if (current.state !== "cleanup" || !cleanupProofMatches(current.cleanup.authority.proof, request.cleanup)) {
				return { state, result: { status: "cleanup_lost" } as const };
			}
			if (current.revision !== request.expectedRevision)
				return { state, result: { status: "revision_conflict" } as const };
			if (current.cleanup.progress.state !== "canonical_discard_outcome_unknown")
				return { state, result: { status: "evidence_invalid" } as const };
			const plan = current.cleanup.plan;
			const progress = current.cleanup.progress;
			const discard = request.canonicalDiscard;
			if (
				discard.taskId !== current.taskId ||
				discard.runId !== current.runId ||
				discard.workspaceId !== current.workspaceId ||
				discard.cleanupId !== plan.cleanupId ||
				discard.cleanupAuthorityId !== current.cleanupAuthorityId ||
				discard.canonicalDiscardId !== plan.canonicalDiscardId ||
				discard.cleanupPlanSha256 !== current.cleanup.planSha256 ||
				!exactJson(discard.finalCheckpoint, current.canonical.checkpoint) ||
				!exactJson(discard, request.evidence.canonicalDiscard)
			)
				return { state, result: { status: "discard_receipt_invalid" } as const };
			const evidence = request.evidence;
			const authorization = evidence.preparedReplicaDelete.authorization;
			const provider = current.providerWorkspace;
			if (
				evidence.taskId !== current.taskId ||
				evidence.runId !== current.runId ||
				evidence.postTerminalCleanupEvidenceId !== plan.terminalEvidenceId ||
				evidence.cleanupId !== plan.cleanupId ||
				evidence.cleanupAuthorityId !== current.cleanupAuthorityId ||
				evidence.workspaceId !== current.workspaceId ||
				evidence.resultPublicationId !== current.resultPublicationId ||
				evidence.publicationTargetId !== current.publicationTargetId ||
				!exactJson(evidence.publicationTargetKey, plan.publicationTargetKey) ||
				evidence.isolationCleanupId !== current.isolationCleanupId ||
				evidence.worktreePublicationId !== current.effectIdentityManifest.worktreePublicationId ||
				evidence.effectIdentityManifestSha256 !== current.effectIdentityManifest.manifestSha256 ||
				evidence.isolationNamespaceSha256 !== current.isolationNamespaceSha256 ||
				evidence.isolationOwnerManifestSha256 !== current.isolationOwnerManifestSha256 ||
				evidence.isolationCreatorDescriptorSha256 !== current.isolationCreatorDescriptorSha256 ||
				evidence.resultPublicationTargetId !== current.resultPublicationTargetId ||
				evidence.pendingPayloadId !== current.pendingPayloadId ||
				evidence.pendingPayloadDeleteId !== current.pendingPayloadDeleteId ||
				evidence.composedPayloadId !== current.composedPayloadId ||
				evidence.composedPayloadDeleteId !== current.composedPayloadDeleteId ||
				evidence.pendingOutcomeSha256 !== current.cleanup.pendingOutcomeReceipt.outcomeSha256 ||
				evidence.outcome !== current.cleanup.pendingOutcomeReceipt.outcome ||
				!exactJson(evidence.branch, progress.branch) ||
				evidence.planSha256 !== current.cleanup.planSha256 ||
				!exactJson(evidence.preparedReplicaDelete, progress.prepared) ||
				!exactJson(evidence.replicaDelete, progress.result) ||
				!exactJson(evidence.replicaDelete.replica, evidence.preparedReplicaDelete.replica) ||
				!exactJson(evidence.replicaDelete.authorization, authorization) ||
				evidence.replicaDelete.request.requestId !== evidence.preparedReplicaDelete.requestId ||
				evidence.replicaDelete.request.requestSha256 !== evidence.preparedReplicaDelete.requestSha256 ||
				!exactJson(evidence.release.replica, provider.lease.replica) ||
				evidence.release.leaseId !== provider.lease.leaseId ||
				!exactJson(evidence.preparedReplicaDelete.replica, provider.lease.replica) ||
				authorization.taskId !== current.taskId ||
				authorization.runId !== current.runId ||
				authorization.workspaceId !== current.workspaceId ||
				authorization.cleanupId !== plan.cleanupId ||
				authorization.cleanupAuthorityId !== current.cleanupAuthorityId ||
				authorization.cleanupPlanSha256 !== current.cleanup.planSha256 ||
				!exactJson(authorization.finalCheckpoint, discard.finalCheckpoint) ||
				authorization.replicaDeleteRequestId !== plan.replicaDeleteRequestId ||
				authorization.replicaDeletionQuarantineId !== plan.replicaDeletionQuarantineId ||
				authorization.replicaDeletionPlannedAt !== plan.replicaDeletionPlannedAt ||
				authorization.replicaDeletionPurgeAfter !== plan.replicaDeletionPurgeAfter ||
				evidence.preparedReplicaDelete.requestId !== plan.replicaDeleteRequestId ||
				!exactJson(evidence.tombstone.providerDeletionAuthorization, authorization) ||
				evidence.tombstone.taskId !== current.taskId ||
				evidence.tombstone.runId !== current.runId ||
				evidence.tombstone.workspaceId !== current.workspaceId ||
				evidence.tombstone.cleanupId !== plan.cleanupId ||
				evidence.tombstone.cleanupAuthorityId !== current.cleanupAuthorityId ||
				!exactJson(evidence.tombstone.finalCheckpoint, discard.finalCheckpoint) ||
				evidence.tombstone.planSha256 !== current.cleanup.planSha256 ||
				evidence.tombstone.deletedAt !== evidence.terminalAt ||
				Date.parse(discard.discardedAt) > Date.parse(evidence.terminalAt) ||
				Date.parse(evidence.terminalAt) < Date.parse(current.updatedAt)
			)
				return { state, result: { status: "evidence_invalid" } as const };
			if (plan.outcome === "succeeded") {
				if (
					evidence.branch.reason !== "task_succeeded" ||
					evidence.worktreePublicationUse !== "published" ||
					evidence.worktreePublication === null ||
					evidence.worktreePublicationAttemptSha256 !== evidence.worktreePublication.attemptSha256 ||
					evidence.worktreePublication.taskId !== current.taskId ||
					evidence.worktreePublication.runId !== current.runId ||
					evidence.worktreePublication.workspaceId !== current.workspaceId ||
					evidence.worktreePublication.createId !== current.createId ||
					evidence.worktreePublication.cleanupId !== plan.cleanupId ||
					evidence.worktreePublication.cleanupAuthorityId !== current.cleanupAuthorityId ||
					evidence.worktreePublication.worktreePublicationId !== plan.worktreePublicationId ||
					evidence.worktreePublication.effectIdentityManifestSha256 !== plan.effectIdentityManifestSha256 ||
					!exactJson(evidence.worktreePublication.publicationTargetKey, plan.publicationTargetKey) ||
					evidence.worktreePublication.publicationClaim.isolationCleanupId !== current.isolationCleanupId ||
					evidence.worktreePublication.publicationClaim.isolationNamespaceSha256 !==
						current.isolationNamespaceSha256 ||
					evidence.worktreePublication.publicationClaim.isolationOwnerManifestSha256 !==
						current.isolationOwnerManifestSha256 ||
					evidence.worktreePublication.publicationClaim.isolationCreatorDescriptorSha256 !==
						current.isolationCreatorDescriptorSha256 ||
					!exactJson(evidence.worktreePublication.checkpoint, discard.finalCheckpoint) ||
					Date.parse(evidence.worktreePublication.publishedAt) > Date.parse(discard.discardedAt)
				)
					return { state, result: { status: "evidence_invalid" } as const };
			} else if (
				evidence.worktreePublicationUse !== "unused_non_success" ||
				evidence.worktreePublicationAttemptSha256 !== null ||
				evidence.worktreePublication !== null ||
				evidence.branch.reason === "task_succeeded"
			)
				return { state, result: { status: "evidence_invalid" } as const };
			if (evidence.branch.kind === "preserve") {
				if (
					evidence.canonicalCommit === null ||
					evidence.checkpointAcknowledgement === null ||
					evidence.canonicalCommit.workspaceId !== current.workspaceId ||
					evidence.canonicalCommit.commitId !== plan.preservingDrain.canonicalCommitId ||
					evidence.canonicalCommit.expectedGeneration !== plan.expectedCanonical.checkpoint.generation ||
					!exactJson(evidence.canonicalCommit.checkpoint, discard.finalCheckpoint) ||
					!exactJson(evidence.checkpointAcknowledgement.canonicalCommit, evidence.canonicalCommit) ||
					evidence.checkpointAcknowledgement.reference.workspaceId !== discard.finalCheckpoint.workspaceId ||
					evidence.checkpointAcknowledgement.reference.baseGeneration !==
						plan.expectedCanonical.checkpoint.generation ||
					evidence.checkpointAcknowledgement.reference.rootSha256 !== discard.finalCheckpoint.rootSha256 ||
					evidence.checkpointAcknowledgement.reference.fileCount !== discard.finalCheckpoint.fileCount ||
					evidence.checkpointAcknowledgement.reference.byteCount !== discard.finalCheckpoint.byteCount ||
					evidence.checkpointAcknowledgement.reference.providerId !== provider.lease.replica.providerId ||
					evidence.checkpointAcknowledgement.reference.profileId !== provider.lease.replica.profileId ||
					evidence.checkpointAcknowledgement.reference.replicaId !== provider.lease.replica.replicaId ||
					evidence.checkpointAcknowledgement.reference.leaseId !== provider.lease.leaseId ||
					evidence.checkpointAcknowledgement.reference.checkpointId !== plan.preservingDrain.checkpointId ||
					evidence.checkpointAcknowledgement.request.requestId !==
						plan.preservingDrain.requests.checkpointAcknowledgement.requestId ||
					evidence.checkpointAcknowledgement.request.parentOperationId !==
						plan.preservingDrain.requests.checkpointAcknowledgement.parentOperationId ||
					evidence.release.request.requestId !== plan.preservingDrain.requests.release.requestId ||
					evidence.release.request.requestSha256 !== plan.preservingDrain.requests.release.requestSha256 ||
					evidence.release.request.parentOperationId !== plan.preservingDrain.requests.release.parentOperationId ||
					Date.parse(evidence.canonicalCommit.durableAt) >
						Date.parse(evidence.checkpointAcknowledgement.acknowledgedAt) ||
					Date.parse(evidence.checkpointAcknowledgement.acknowledgedAt) > Date.parse(discard.discardedAt)
				)
					return { state, result: { status: "evidence_invalid" } as const };
			} else if (
				evidence.canonicalCommit !== null ||
				evidence.checkpointAcknowledgement !== null ||
				evidence.release.request.requestId !== plan.fastDiscardDrain.requests.release.requestId ||
				evidence.release.request.requestSha256 !== plan.fastDiscardDrain.requests.release.requestSha256 ||
				evidence.release.request.parentOperationId !== plan.fastDiscardDrain.requests.release.parentOperationId ||
				!exactJson(discard.finalCheckpoint, plan.expectedCanonical.checkpoint) ||
				!exactJson(evidence.branch.assessment.proof.baseCheckpoint, plan.expectedCanonical.checkpoint) ||
				evidence.branch.assessment.proof.observedImage.rootSha256 !== discard.finalCheckpoint.rootSha256 ||
				evidence.branch.assessment.proof.observedImage.fileCount !== discard.finalCheckpoint.fileCount ||
				evidence.branch.assessment.proof.observedImage.byteCount !== discard.finalCheckpoint.byteCount
			)
				return { state, result: { status: "evidence_invalid" } as const };
			const terminalState = evidence.branch.kind === "fast_discard" ? "discarded" : "deleted";
			if (evidence.tombstone.terminalState !== terminalState)
				return { state, result: { status: "evidence_invalid" } as const };
			const next: TransientTaskWorkspaceAuthorityV1 = {
				...current,
				state: terminalState,
				revision: current.revision + 1,
				controller: null,
				canonical: null,
				runtime: null,
				cleanup: {
					plan,
					planSha256: current.cleanup.planSha256,
					pendingOutcomeReceipt: current.cleanup.pendingOutcomeReceipt,
					authority: null,
					progress: { state: "canonical_provider_terminal", evidence },
				},
				updatedAt: this.#now(),
			};
			if (!validLifecycleAuthority(next)) return { state, result: { status: "evidence_invalid" } as const };
			return { state: { ...state, authority: next }, result: { status: "terminal", authority: next } as const };
		});
	}

	async authorizeController(proof: TransientTaskControllerAuthorityProofV1) {
		const key = { taskId: proof.taskId, runId: proof.runId };
		const state = transientRuntimeState(key, await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(key)));
		const current = state.authority;
		if (!current) return "controller_lost" as const;
		if (current.state === "cleanup" || current.state === "deleted" || current.state === "discarded")
			return "cleanup_latched" as const;
		if (current.controller === null) return "controller_lost" as const;
		return controllerProofMatches(current.controller.proof, proof) &&
			Date.parse(current.controller.expiresAt) > Date.parse(this.#now())
			? ("current" as const)
			: ("controller_lost" as const);
	}

	async authorizeCleanup(proof: TransientTaskCleanupAuthorityProofV1): Promise<boolean> {
		const key = { taskId: proof.taskId, runId: proof.runId };
		const state = transientRuntimeState(key, await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(key)));
		return (
			state.authority?.state === "cleanup" &&
			cleanupProofMatches(state.authority.cleanup.authority.proof, proof) &&
			Date.parse(state.authority.cleanup.authority.expiresAt) > Date.parse(this.#now())
		);
	}

	async authorizeTerminal(request: {
		readonly key: TransientTaskWorkspaceKeyV1;
		readonly terminalEvidenceId: OperationId;
		readonly terminalEvidenceSha256: Sha256Ref;
	}): Promise<boolean> {
		const state = transientRuntimeState(
			request.key,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(request.key)),
		);
		const authority = state.authority;
		if (!authority || (authority.state !== "deleted" && authority.state !== "discarded")) return false;
		const evidence = authority.cleanup.progress.evidence;
		return (
			evidence.postTerminalCleanupEvidenceId === request.terminalEvidenceId &&
			evidence.evidenceSha256 === request.terminalEvidenceSha256
		);
	}

	async inspectRevision(key: TransientTaskWorkspaceKeyV1): Promise<number | null> {
		const state = transientRuntimeState(key, await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(key)));
		return state.authority?.revision ?? null;
	}
}
