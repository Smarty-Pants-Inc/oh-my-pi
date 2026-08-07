import type { ISO8601, Sha256Ref } from "../registry/persistent-agent-contracts.js";
import type { PackageInternalNativeTransientTaskIsolationOwnershipClaimRuntimeV1 } from "../task/worktree.js";
import {
	controllerProofMatches,
	exactJson,
	invalidIsolationClaimInspection,
	lifecycleIso8601,
	lifecycleIsolationClaimAttemptTuple,
	lifecycleIsolationEnsureTuple,
	lifecycleIsolationReadyTuple,
	lifecycleSafeInteger,
	lifecycleSha256Ref,
	lifecycleTupleRef,
	proxyFreeData,
	publicIsolationClaimInspection,
	strictRecord,
	validIsolationClaimInspectRequest,
	validLifecycleControllerProof,
	validLifecycleIsolationClaimRequest,
	validLifecycleIsolationCleanupDescriptor,
} from "./workspace-controller-codecs.js";
import type {
	ConfidentialTransientTaskIsolationCreatorStoreV1 as ConfidentialTransientTaskIsolationCreatorStoreContractV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectAdoptRequestV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1,
	ConfidentialTransientTaskIsolationPreparingAuthorityV1,
	ConfidentialTransientTaskIsolationReadyToBindReceiptV1,
	TransientTaskControllerAuthorityProofV1,
	TransientTaskIsolationOwnershipClaimEffectInspectRequestV1,
	TransientTaskWorkspaceAuthorityStoreV1,
	TransientTaskWorkspaceAuthorityV1,
	TransientTaskWorkspaceKeyV1,
} from "./workspace-runtime-contracts.js";
import { validateTransientTaskPublicationTargetBindReceiptV1 } from "./workspace-runtime-contracts.js";

export class DurableConfidentialTransientTaskIsolationCreatorStoreV1
	implements ConfidentialTransientTaskIsolationCreatorStoreContractV1
{
	readonly controlHostId: string;
	readonly processIdentityProbe: ConfidentialTransientTaskIsolationCreatorStoreContractV1["processIdentityProbe"];
	readonly #authorityStore: TransientTaskWorkspaceAuthorityStoreV1;
	readonly #claimRuntime: PackageInternalNativeTransientTaskIsolationOwnershipClaimRuntimeV1;

	constructor(options: {
		readonly controlHostId: string;
		readonly processIdentityProbe: ConfidentialTransientTaskIsolationCreatorStoreContractV1["processIdentityProbe"];
		readonly authorityStore: TransientTaskWorkspaceAuthorityStoreV1;
		readonly claimRuntime: PackageInternalNativeTransientTaskIsolationOwnershipClaimRuntimeV1;
	}) {
		this.controlHostId = options.controlHostId;
		this.processIdentityProbe = options.processIdentityProbe;
		this.#authorityStore = options.authorityStore;
		this.#claimRuntime = options.claimRuntime;
	}

	async #preparing(key: TransientTaskWorkspaceKeyV1) {
		const inspected = await this.#authorityStore.inspect(key);
		return inspected.status === "present" && inspected.authority.state === "preparing" ? inspected.authority : null;
	}

	async #replacePreparation(
		current: Extract<TransientTaskWorkspaceAuthorityV1, { readonly state: "preparing" }>,
		preparation: ConfidentialTransientTaskIsolationPreparingAuthorityV1,
		controller: TransientTaskControllerAuthorityProofV1,
		updatedAt: ISO8601,
	) {
		return this.#authorityStore.replaceControlled({
			expectedRevision: current.revision,
			next: {
				...current,
				revision: current.revision + 1,
				isolationPreparation: preparation,
				updatedAt,
			},
			controller,
		});
	}

	async prepareEffect(
		request: Parameters<ConfidentialTransientTaskIsolationCreatorStoreContractV1["prepareEffect"]>[0],
	) {
		const effect = request.effectRequest;
		if (
			!proxyFreeData(request) ||
			!strictRecord(request, ["expectedWorkspaceRevision", "effectRequest", "controller"]) ||
			!lifecycleSafeInteger(request.expectedWorkspaceRevision) ||
			!validLifecycleIsolationClaimRequest(effect) ||
			!validLifecycleControllerProof(request.controller) ||
			!controllerProofMatches(effect.controller, request.controller)
		)
			return { status: "invalid" } as const;
		const current = await this.#preparing(effect);
		if (!current) return { status: "conflict" } as const;
		if (!controllerProofMatches(current.controller.proof, request.controller))
			return { status: "controller_lost" } as const;
		if (current.revision !== request.expectedWorkspaceRevision) return { status: "revision_conflict" } as const;
		const preparation = current.isolationPreparation;
		if (
			(preparation.state === "claim_effect_not_applied" || preparation.state === "claim_effect_outcome_unknown") &&
			exactJson(preparation.activeAttempt.request, effect)
		) {
			return preparation.state === "claim_effect_not_applied"
				? ({ status: "already_prepared", preparation } as const)
				: ({ status: "conflict" } as const);
		}
		let orderedPriorAttempts: readonly ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1[];
		let orderedPriorReceipts: readonly ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1[];
		if (effect.operation === "pre_bind_cas_release") {
			if (preparation.state !== "claim_current" || !exactJson(effect.expectedClaim, preparation.ownershipClaim))
				return { status: "conflict" } as const;
			orderedPriorAttempts = preparation.orderedClaimAttempts;
			orderedPriorReceipts = preparation.orderedClaimReceipts;
		} else {
			if (
				preparation.state !== "claim_effect_outcome_unknown" ||
				effect.staleOwnerEvidence.attemptSha256 !== preparation.activeAttempt.attemptSha256 ||
				!exactJson(effect.expectedClaim, effect.staleOwnerEvidence.observedClaim)
			)
				return { status: "conflict" } as const;
			orderedPriorAttempts = preparation.orderedPriorAttempts;
			orderedPriorReceipts = preparation.orderedPriorReceipts;
		}
		const attemptCore = { state: "claim_not_applied" as const, request: effect, openedAt: effect.requestedAt };
		const activeAttempt: ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1 & {
			readonly state: "claim_not_applied";
		} = {
			...attemptCore,
			attemptSha256: lifecycleTupleRef(lifecycleIsolationClaimAttemptTuple(attemptCore)),
		};
		const nextPreparation: ConfidentialTransientTaskIsolationPreparingAuthorityV1 = {
			state: "claim_effect_not_applied",
			creatorDescriptor: effect.creatorDescriptor,
			orderedPriorAttempts,
			orderedPriorReceipts,
			activeAttempt,
			updatedAt: effect.requestedAt,
		};
		const replaced = await this.#replacePreparation(current, nextPreparation, request.controller, effect.requestedAt);
		return replaced.status === "replaced"
			? ({ status: "prepared", preparation: nextPreparation } as const)
			: ({ status: replaced.status === "cleanup_latched" ? "conflict" : replaced.status } as const);
	}

	async transitionEffectToOutcomeUnknown(
		request: Parameters<
			ConfidentialTransientTaskIsolationCreatorStoreContractV1["transitionEffectToOutcomeUnknown"]
		>[0],
	) {
		if (
			!proxyFreeData(request) ||
			!strictRecord(request, ["expectedWorkspaceRevision", "expectedAttemptSha256", "controller"]) ||
			!lifecycleSafeInteger(request.expectedWorkspaceRevision) ||
			!lifecycleSha256Ref(request.expectedAttemptSha256) ||
			!validLifecycleControllerProof(request.controller)
		)
			return { status: "invalid" } as const;
		const current = await this.#preparing(request.controller);
		if (!current) return { status: "conflict" } as const;
		if (!controllerProofMatches(current.controller.proof, request.controller))
			return { status: "controller_lost" } as const;
		if (current.revision !== request.expectedWorkspaceRevision) return { status: "revision_conflict" } as const;
		const preparation = current.isolationPreparation;
		if (preparation.state === "claim_effect_outcome_unknown") {
			const prior = { ...preparation.activeAttempt, state: "claim_not_applied" as const };
			if (lifecycleTupleRef(lifecycleIsolationClaimAttemptTuple(prior)) !== request.expectedAttemptSha256)
				return { status: "conflict" } as const;
			return { status: "already_outcome_unknown", attempt: preparation.activeAttempt } as const;
		}
		if (
			preparation.state !== "claim_effect_not_applied" ||
			preparation.activeAttempt.attemptSha256 !== request.expectedAttemptSha256
		)
			return { status: "conflict" } as const;
		const attemptCore = { ...preparation.activeAttempt, state: "claim_outcome_unknown" as const };
		const activeAttempt = {
			...attemptCore,
			attemptSha256: lifecycleTupleRef(lifecycleIsolationClaimAttemptTuple(attemptCore)),
		};
		const nextPreparation: ConfidentialTransientTaskIsolationPreparingAuthorityV1 = {
			...preparation,
			state: "claim_effect_outcome_unknown",
			activeAttempt,
		};
		const replaced = await this.#replacePreparation(
			current,
			nextPreparation,
			request.controller,
			preparation.updatedAt,
		);
		return replaced.status === "replaced"
			? ({ status: "transitioned", attempt: activeAttempt } as const)
			: ({ status: replaced.status === "cleanup_latched" ? "conflict" : replaced.status } as const);
	}

	async #nativeInspection(request: TransientTaskIsolationOwnershipClaimEffectInspectRequestV1) {
		const current = await this.#preparing(request);
		if (!current) return null;
		const preparation = current.isolationPreparation;
		if (
			(preparation.state !== "claim_effect_not_applied" && preparation.state !== "claim_effect_outcome_unknown") ||
			preparation.activeAttempt.attemptSha256 !== request.attemptSha256 ||
			preparation.activeAttempt.request.requestSha256 !== request.requestSha256 ||
			preparation.activeAttempt.request.effectOperationId !== request.effectOperationId
		)
			return { current, preparation: null, inspection: { status: "conflict" } as const };
		return {
			current,
			preparation,
			inspection: await this.#claimRuntime.inspect({ attempt: preparation.activeAttempt, request }),
		};
	}

	async inspectEffect(request: TransientTaskIsolationOwnershipClaimEffectInspectRequestV1) {
		if (!validIsolationClaimInspectRequest(request)) return invalidIsolationClaimInspection();
		try {
			const resolved = await this.#nativeInspection(request);
			return publicIsolationClaimInspection(request, resolved?.inspection ?? { status: "conflict" });
		} catch {
			return publicIsolationClaimInspection(request, { status: "outcome_unknown" });
		}
	}

	async adoptEffect(request: ConfidentialTransientTaskIsolationOwnershipClaimEffectAdoptRequestV1) {
		if (
			!proxyFreeData(request) ||
			!strictRecord(request, [
				"inspectRequest",
				"inspection",
				"expectedInspectionSha256",
				"controller",
				"authoritySha256",
				"adoptedAt",
				"adoptRequestSha256",
			]) ||
			!validLifecycleControllerProof(request.controller) ||
			!lifecycleSha256Ref(request.expectedInspectionSha256) ||
			!lifecycleSha256Ref(request.authoritySha256) ||
			!lifecycleIso8601(request.adoptedAt) ||
			!validIsolationClaimInspectRequest(request.inspectRequest) ||
			!proxyFreeData(request.inspection) ||
			request.inspection === null ||
			typeof request.inspection !== "object" ||
			!lifecycleSha256Ref(Object.getOwnPropertyDescriptor(request.inspection, "inspectionSha256")?.value) ||
			!lifecycleSha256Ref(request.adoptRequestSha256) ||
			request.expectedInspectionSha256 !== request.inspection.inspectionSha256
		)
			return { status: "invalid" } as const;
		const resolved = await this.#nativeInspection(request.inspectRequest).catch(() => undefined);
		if (resolved === undefined) return { status: "outcome_unknown" } as const;
		if (!resolved?.preparation) return { status: "preparation_missing" } as const;
		if (!controllerProofMatches(resolved.current.controller.proof, request.controller))
			return { status: "controller_lost" } as const;
		if (request.authoritySha256 !== resolved.preparation.activeAttempt.request.authoritySha256)
			return { status: "conflict" } as const;
		if (!exactJson(publicIsolationClaimInspection(request.inspectRequest, resolved.inspection), request.inspection))
			return { status: "conflict" } as const;
		if (resolved.inspection.status === "not_applied")
			return {
				status: "not_applied",
				attempt: resolved.preparation.activeAttempt,
				proof: resolved.inspection.proof,
				preparation: resolved.preparation,
			} as const;
		if (resolved.inspection.status === "stale_same_owner")
			return {
				status: "stale_same_owner",
				observedClaim: resolved.inspection.observedClaim,
				ownerLivenessEvidence: resolved.inspection.ownerLivenessEvidence,
				preparation: resolved.preparation,
			} as const;
		if (resolved.inspection.status !== "matching") return { status: resolved.inspection.status } as const;
		const receipt = resolved.inspection.receipt;
		const preparation = resolved.preparation;
		let nextPreparation: ConfidentialTransientTaskIsolationPreparingAuthorityV1;
		if (receipt.operation === "pre_bind_cas_release") {
			nextPreparation = {
				state: "released_before_bind",
				creatorDescriptorSha256: preparation.creatorDescriptor.creatorDescriptorSha256,
				lastClaimReceiptSha256: receipt.receiptSha256,
				releaseReceipt: receipt,
				updatedAt: request.adoptedAt,
			};
		} else {
			const orderedClaimAttempts: readonly [
				ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1,
				...ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1[],
			] =
				preparation.orderedPriorAttempts.length === 0
					? [preparation.activeAttempt]
					: [
							preparation.orderedPriorAttempts[0]!,
							...preparation.orderedPriorAttempts.slice(1),
							preparation.activeAttempt,
						];
			const orderedClaimReceipts: readonly [
				ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1,
				...ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1[],
			] =
				preparation.orderedPriorReceipts.length === 0
					? [receipt]
					: [preparation.orderedPriorReceipts[0]!, ...preparation.orderedPriorReceipts.slice(1), receipt];
			nextPreparation = {
				state: "claim_current",
				creatorDescriptor: preparation.creatorDescriptor,
				orderedClaimAttempts,
				orderedClaimReceipts,
				ownershipClaim: receipt.claim,
				ownershipClaimReceipt: receipt,
				updatedAt: request.adoptedAt,
			};
		}
		const replaced = await this.#replacePreparation(
			resolved.current,
			nextPreparation,
			request.controller,
			request.adoptedAt,
		);
		return replaced.status === "replaced"
			? ({ status: "adopted", receipt, preparation: nextPreparation } as const)
			: ({
					status:
						replaced.status === "revision_conflict" || replaced.status === "cleanup_latched"
							? "conflict"
							: replaced.status,
				} as const);
	}

	async recordReadyToBind(
		request: Parameters<ConfidentialTransientTaskIsolationCreatorStoreContractV1["recordReadyToBind"]>[0],
	) {
		if (
			!proxyFreeData(request) ||
			!strictRecord(request, [
				"expectedWorkspaceRevision",
				"ensureRequestSha256",
				"cleanupDescriptor",
				"controller",
				"preparedAt",
			]) ||
			!lifecycleSafeInteger(request.expectedWorkspaceRevision) ||
			!lifecycleSha256Ref(request.ensureRequestSha256) ||
			!validLifecycleIsolationCleanupDescriptor(request.cleanupDescriptor) ||
			!validLifecycleControllerProof(request.controller) ||
			!lifecycleIso8601(request.preparedAt)
		)
			return { status: "invalid" } as const;
		const current = await this.#preparing(request.controller);
		if (!current) return { status: "conflict" } as const;
		if (!controllerProofMatches(current.controller.proof, request.controller))
			return { status: "controller_lost" } as const;
		if (current.revision !== request.expectedWorkspaceRevision) return { status: "revision_conflict" } as const;
		const preparation = current.isolationPreparation;
		if (preparation.state === "ready_to_bind")
			return preparation.ready.cleanupDescriptor.cleanupDescriptorSha256 ===
				request.cleanupDescriptor.cleanupDescriptorSha256
				? ({ status: "already_recorded", receipt: preparation.ready } as const)
				: ({ status: "conflict" } as const);
		if (preparation.state !== "claim_current") return { status: "claim_not_current" } as const;
		const authoritySha256 = preparation.ownershipClaimReceipt.authoritySha256;
		const ensureCore = {
			preparation,
			controller: request.controller,
			authoritySha256,
			requestedAt: preparation.updatedAt,
		};
		if (
			lifecycleTupleRef(lifecycleIsolationEnsureTuple(ensureCore)) !== request.ensureRequestSha256 ||
			request.cleanupDescriptor.creatorDescriptor.creatorDescriptorSha256 !==
				preparation.creatorDescriptor.creatorDescriptorSha256
		)
			return { status: "conflict" } as const;
		const readyCore: Omit<ConfidentialTransientTaskIsolationReadyToBindReceiptV1, "receiptSha256"> = {
			schemaVersion: 1 as const,
			taskId: current.taskId,
			runId: current.runId,
			createId: current.createId,
			creatorDescriptor: preparation.creatorDescriptor,
			ownershipClaim: preparation.ownershipClaim,
			ownershipClaimReceipt: preparation.ownershipClaimReceipt,
			cleanupDescriptor: request.cleanupDescriptor,
			orderedClaimAttemptSha256s: preparation.orderedClaimAttempts.map(attempt => attempt.attemptSha256) as [
				Sha256Ref,
				...Sha256Ref[],
			],
			orderedClaimReceiptSha256s: preparation.orderedClaimReceipts.map(receipt => receipt.receiptSha256) as [
				Sha256Ref,
				...Sha256Ref[],
			],
			authoritySha256,
			preparedAt: request.preparedAt,
		};
		const ready: ConfidentialTransientTaskIsolationReadyToBindReceiptV1 = {
			...readyCore,
			receiptSha256: lifecycleTupleRef(lifecycleIsolationReadyTuple(readyCore)),
		};
		const nextPreparation: ConfidentialTransientTaskIsolationPreparingAuthorityV1 = {
			state: "ready_to_bind",
			ready,
			updatedAt: request.preparedAt,
		};
		const replaced = await this.#replacePreparation(current, nextPreparation, request.controller, request.preparedAt);
		return replaced.status === "replaced"
			? ({ status: "recorded", receipt: ready } as const)
			: ({ status: replaced.status === "cleanup_latched" ? "conflict" : replaced.status } as const);
	}

	async recordBound(request: Parameters<ConfidentialTransientTaskIsolationCreatorStoreContractV1["recordBound"]>[0]) {
		if (
			!proxyFreeData(request) ||
			!strictRecord(request, ["expectedWorkspaceRevision", "readyReceiptSha256", "bindReceipt", "controller"]) ||
			!lifecycleSafeInteger(request.expectedWorkspaceRevision) ||
			!lifecycleSha256Ref(request.readyReceiptSha256) ||
			!validateTransientTaskPublicationTargetBindReceiptV1(request.bindReceipt) ||
			!validLifecycleControllerProof(request.controller)
		)
			return { status: "invalid" } as const;
		const current = await this.#preparing(request.controller);
		if (!current) return { status: "conflict" } as const;
		if (!controllerProofMatches(current.controller.proof, request.controller))
			return { status: "controller_lost" } as const;
		if (current.revision !== request.expectedWorkspaceRevision) return { status: "revision_conflict" } as const;
		const preparation = current.isolationPreparation;
		if (preparation.state === "bound")
			return preparation.ready.receiptSha256 === request.readyReceiptSha256 &&
				exactJson(preparation.bindReceipt, request.bindReceipt)
				? ({ status: "already_recorded", preparation } as const)
				: ({ status: "conflict" } as const);
		if (preparation.state !== "ready_to_bind" || preparation.ready.receiptSha256 !== request.readyReceiptSha256)
			return { status: "conflict" } as const;
		const ready = preparation.ready;
		const bind = request.bindReceipt;
		if (
			bind.key.taskId !== current.taskId ||
			bind.key.runId !== current.runId ||
			bind.key.createId !== current.createId ||
			bind.key.publicationTargetId !== ready.creatorDescriptor.publicationTargetId ||
			bind.isolationCleanupId !== ready.creatorDescriptor.isolationCleanupId ||
			bind.bindingOperationId !== ready.creatorDescriptor.bindingOperationId ||
			bind.cleanupDescriptorSha256 !== ready.cleanupDescriptor.cleanupDescriptorSha256 ||
			bind.isolationCreatorPreparationReceiptSha256 !== ready.receiptSha256 ||
			bind.isolationOwnershipClaimReceiptSha256 !== ready.ownershipClaimReceipt.receiptSha256 ||
			bind.isolationCreatorDescriptorSha256 !== ready.creatorDescriptor.creatorDescriptorSha256 ||
			bind.isolationNamespaceSha256 !== ready.creatorDescriptor.namespaceSha256 ||
			bind.isolationOwnerManifestSha256 !== ready.creatorDescriptor.ownerManifestSha256 ||
			bind.authoritySha256 !== ready.authoritySha256
		)
			return { status: "conflict" } as const;
		const nextPreparation = {
			state: "bound" as const,
			ready,
			bindReceipt: bind,
			updatedAt: bind.boundAt,
		};
		const replaced = await this.#replacePreparation(current, nextPreparation, request.controller, bind.boundAt);
		return replaced.status === "replaced"
			? ({ status: "recorded", preparation: nextPreparation } as const)
			: ({ status: replaced.status === "cleanup_latched" ? "conflict" : replaced.status } as const);
	}
}
