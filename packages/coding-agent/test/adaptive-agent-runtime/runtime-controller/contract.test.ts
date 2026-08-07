import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type {
	OperationId,
	Sha256Hex,
	Sha256Ref,
	TransientTaskOutcomePayloadId,
	TransientTaskResultPublicationTargetId,
	WorkspaceId,
} from "../../../src/registry/persistent-agent-contracts.js";
import { FileRuntimeDurableStateStoreV1 } from "../../../src/session/managed-workspace.js";
import {
	DurableTransientTaskResultPublicationStoreV1,
	RuntimeAttachmentFileStoreV1,
	TransientTaskWorkspaceAuthorityStore,
	WorkspaceRuntimeControllerV1,
} from "../../../src/session/workspace-controller.js";
import {
	type CanonicalRuntimeValue,
	type ConfidentialTransientTaskIsolationCreatorDescriptorV1,
	type ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1,
	type ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1,
	type ConfidentialTransientTaskIsolationOwnershipClaimV1,
	canonicalRuntimeSha256,
	type TransientTaskCancellationAcknowledgementReceiptV1,
	type TransientTaskControllerAuthorityProofV1,
	type TransientTaskEffectIdentityManifestV1,
	type TransientTaskPendingOutcomeV1,
	type TransientTaskResultPublicationPrePendingInitializationReceiptV1,
	type TransientTaskResultPublicationPrePendingPlanV1,
	type TransientTaskResultPublicationTargetKeyV1,
	type TransientTaskWorkspaceCreatePlanV1,
} from "../../../src/session/workspace-runtime-contracts.js";
import { preflightTransientTaskResultlessRepresentabilityV1 } from "../../../src/task/executor.js";

const fixedAt = "2026-08-06T00:00:00.000Z";
const mediaType = "application/vnd.omp.task-outcome.v1+json" as const;

function shaRef(bytes: string): Sha256Ref {
	return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}` as Sha256Ref;
}

async function tupleRef(tuple: readonly CanonicalRuntimeValue[]): Promise<Sha256Ref> {
	return `sha256:${await canonicalRuntimeSha256(tuple)}` as Sha256Ref;
}
function targetKeyTuple(key: TransientTaskResultPublicationTargetKeyV1): readonly CanonicalRuntimeValue[] {
	return [
		key.taskId,
		key.runId,
		key.createId,
		key.resultPublicationId,
		key.resultPublicationTargetId,
		key.resultPublicationTargetCleanupId,
	];
}

function targetKey(suffix: string): TransientTaskResultPublicationTargetKeyV1 {
	return {
		schemaVersion: 1,
		taskId: `task-${suffix}`,
		runId: `run-${suffix}`,
		createId: `create-${suffix}` as OperationId,
		resultPublicationId: `publication-${suffix}` as OperationId,
		resultPublicationTargetId: `target-${suffix}` as TransientTaskResultPublicationTargetId,
		resultPublicationTargetCleanupId: `target-cleanup-${suffix}` as OperationId,
	};
}

function controller(key: TransientTaskResultPublicationTargetKeyV1): TransientTaskControllerAuthorityProofV1 {
	return {
		schemaVersion: 1,
		taskId: key.taskId,
		runId: key.runId,
		createId: key.createId,
		controllerId: "controller-1" as OperationId,
		workspaceId: "workspace-1" as WorkspaceId,
		controlHostId: "host-1",
		controllerEpoch: 1,
		fencingGeneration: 1,
	};
}

function controllerTuple(proof: TransientTaskControllerAuthorityProofV1): readonly CanonicalRuntimeValue[] {
	return [
		1,
		proof.taskId,
		proof.runId,
		proof.createId,
		proof.controllerId,
		proof.workspaceId,
		proof.controlHostId,
		proof.controllerEpoch,
		proof.fencingGeneration,
	];
}

function manifestTuple(
	manifest: Omit<TransientTaskEffectIdentityManifestV1, "manifestSha256">,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-effect-identity-manifest-v1",
		1,
		manifest.taskId,
		manifest.runId,
		manifest.worktreePublicationId,
		manifest.captureMemberNamespaceId,
		manifest.captureMaterializationNamespaceId,
		manifest.messageGenerationNamespaceId,
		manifest.captureSubeffectNamespaceId,
		manifest.semanticMergeStepNamespaceId,
		manifest.semanticMergeSubeffectNamespaceId,
		manifest.bindingOperationNamespaceId,
		manifest.payloadRetentionNamespaceId,
		manifest.parentDeliveryNamespaceId,
	];
}

function isolationNamespaceTuple(
	key: Pick<TransientTaskResultPublicationTargetKeyV1, "taskId" | "runId" | "createId">,
): readonly CanonicalRuntimeValue[] {
	return ["omp-transient-task-isolation-namespace-v1", 1, key.taskId, key.runId, key.createId];
}

function isolationOwnerTuple(
	descriptor: Omit<
		ConfidentialTransientTaskIsolationCreatorDescriptorV1,
		"ownerManifestSha256" | "creatorDescriptorSha256"
	>,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-isolation-owner-v1",
		1,
		isolationNamespaceTuple(descriptor),
		descriptor.namespaceSha256,
		descriptor.effectIdentityManifestSha256,
		[
			"omp-transient-task-publication-target-v1",
			"key",
			1,
			descriptor.taskId,
			descriptor.runId,
			descriptor.createId,
			descriptor.publicationTargetId,
		],
		descriptor.worktreePublicationId,
		descriptor.isolationCleanupId,
		descriptor.bindingOperationId,
		descriptor.ownershipClaimCreateOperationId,
		descriptor.directorySegment,
		descriptor.captureBranchRef,
	];
}

function isolationDescriptorTuple(
	descriptor: Omit<ConfidentialTransientTaskIsolationCreatorDescriptorV1, "creatorDescriptorSha256">,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-isolation-creator-v1",
		1,
		isolationOwnerTuple(descriptor),
		descriptor.baseDir,
		descriptor.mergedDir,
		descriptor.ownershipClaimPath,
	];
}

function isolationClaimTuple(
	claim: Omit<ConfidentialTransientTaskIsolationOwnershipClaimV1, "claimSha256">,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-isolation-claim-v1",
		1,
		claim.ownerManifestSha256,
		claim.claimOperationId,
		claim.claimantInstanceId,
		claim.controlHostId,
		claim.pid,
		claim.processStartToken,
		claim.claimedAt,
	];
}

type ExclusiveIsolationClaimRequestV1 = Extract<
	ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1,
	{ readonly operation: "exclusive_create" }
>;

function isolationClaimRequestTuple(
	request: Omit<ExclusiveIsolationClaimRequestV1, "requestSha256">,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-isolation-claim-effect-v1",
		"request",
		1,
		request.taskId,
		request.runId,
		request.createId,
		request.operation,
		request.effectOperationId,
		isolationDescriptorTuple(request.creatorDescriptor),
		controllerTuple(request.controller),
		request.authoritySha256,
		request.requestedAt,
		null,
		isolationClaimTuple(request.nextClaim),
		true,
		true,
		false,
	];
}

function isolationClaimAttemptTuple(
	attempt: Omit<ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1, "attemptSha256">,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-isolation-claim-effect-v1",
		"attempt",
		1,
		attempt.state,
		isolationClaimRequestTuple(attempt.request as ExclusiveIsolationClaimRequestV1),
		attempt.openedAt,
	];
}

async function seedWorkspaceAuthority(options: {
	readonly durable: FileRuntimeDurableStateStoreV1;
	readonly key: TransientTaskResultPublicationTargetKeyV1;
	readonly publicationPlan: TransientTaskResultPublicationPrePendingPlanV1;
	readonly suffix: string;
}) {
	const proof = controller(options.key);
	const manifestCore = {
		schemaVersion: 1 as const,
		taskId: options.key.taskId,
		runId: options.key.runId,
		worktreePublicationId: `worktree-publication-${options.suffix}` as OperationId,
		captureMemberNamespaceId: `capture-member-${options.suffix}` as OperationId,
		captureMaterializationNamespaceId: `capture-materialization-${options.suffix}` as OperationId,
		messageGenerationNamespaceId: `message-generation-${options.suffix}` as OperationId,
		captureSubeffectNamespaceId: `capture-subeffect-${options.suffix}` as OperationId,
		semanticMergeStepNamespaceId: `semantic-merge-step-${options.suffix}` as OperationId,
		semanticMergeSubeffectNamespaceId: `semantic-merge-subeffect-${options.suffix}` as OperationId,
		bindingOperationNamespaceId: `binding-operation-${options.suffix}` as OperationId,
		payloadRetentionNamespaceId: `payload-retention-${options.suffix}` as OperationId,
		parentDeliveryNamespaceId: `parent-delivery-${options.suffix}` as OperationId,
	};
	const effectIdentityManifest: TransientTaskEffectIdentityManifestV1 = {
		...manifestCore,
		manifestSha256: await tupleRef(manifestTuple(manifestCore)),
	};
	const namespaceSha256 = await canonicalRuntimeSha256(isolationNamespaceTuple(options.key));
	const descriptorCore = {
		schemaVersion: 1 as const,
		taskId: options.key.taskId,
		runId: options.key.runId,
		createId: options.key.createId,
		publicationTargetId: `publication-target-${options.suffix}` as OperationId,
		worktreePublicationId: effectIdentityManifest.worktreePublicationId,
		isolationCleanupId: `isolation-cleanup-${options.suffix}` as OperationId,
		bindingOperationId: `binding-${options.suffix}` as OperationId,
		ownershipClaimCreateOperationId: `ownership-claim-${options.suffix}` as OperationId,
		effectIdentityManifestSha256: effectIdentityManifest.manifestSha256,
		namespaceSha256,
		directorySegment: `t1-${namespaceSha256}`,
		baseDir: `/fixture/${options.suffix}`,
		mergedDir: `/fixture/${options.suffix}/merged`,
		ownershipClaimPath: `/fixture/${options.suffix}/ownership-claim.json`,
		captureBranchRef: `refs/heads/runtime-controller-${options.suffix}`,
	};
	const descriptorWithOwner = {
		...descriptorCore,
		ownerManifestSha256: await tupleRef(isolationOwnerTuple(descriptorCore)),
	};
	const creatorDescriptor: ConfidentialTransientTaskIsolationCreatorDescriptorV1 = {
		...descriptorWithOwner,
		creatorDescriptorSha256: await tupleRef(isolationDescriptorTuple(descriptorWithOwner)),
	};
	const claimCore = {
		schemaVersion: 1 as const,
		ownerManifestSha256: creatorDescriptor.ownerManifestSha256,
		claimOperationId: creatorDescriptor.ownershipClaimCreateOperationId,
		claimantInstanceId: `claimant-${options.suffix}` as OperationId,
		controlHostId: proof.controlHostId,
		pid: 1,
		processStartToken: `process-${options.suffix}`,
		claimedAt: fixedAt,
	};
	const nextClaim: ConfidentialTransientTaskIsolationOwnershipClaimV1 = {
		...claimCore,
		claimSha256: await tupleRef(isolationClaimTuple(claimCore)),
	};
	const claimRequestCore = {
		schemaVersion: 1 as const,
		taskId: options.key.taskId,
		runId: options.key.runId,
		createId: options.key.createId,
		operation: "exclusive_create" as const,
		effectOperationId: creatorDescriptor.ownershipClaimCreateOperationId,
		creatorDescriptor,
		controller: proof,
		authoritySha256: await tupleRef([
			"omp-transient-task-workspace-authority-v1",
			"fixture",
			options.key.taskId,
			options.key.runId,
			options.key.createId,
		]),
		requestedAt: fixedAt,
		expectedClaim: null,
		nextClaim,
		exclusive: true as const,
		noFollow: true as const,
		createParentDirectories: false as const,
	};
	const claimRequest: ExclusiveIsolationClaimRequestV1 = {
		...claimRequestCore,
		requestSha256: await tupleRef(isolationClaimRequestTuple(claimRequestCore)),
	};
	const attemptCore = {
		state: "claim_not_applied" as const,
		request: claimRequest,
		openedAt: fixedAt,
	};
	const activeAttempt: ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1 & {
		readonly state: "claim_not_applied";
		readonly request: ExclusiveIsolationClaimRequestV1;
	} = {
		...attemptCore,
		attemptSha256: await tupleRef(isolationClaimAttemptTuple(attemptCore)),
	};
	const createPlan: TransientTaskWorkspaceCreatePlanV1 = {
		schemaVersion: 1,
		taskId: options.key.taskId,
		runId: options.key.runId,
		createId: options.key.createId,
		controllerId: proof.controllerId,
		cleanupAuthorityId: `cleanup-authority-${options.suffix}` as OperationId,
		resultPublicationId: options.key.resultPublicationId,
		capturePreparationId: `capture-preparation-${options.suffix}` as OperationId,
		captureId: `capture-${options.suffix}` as OperationId,
		semanticMergeId: `semantic-merge-${options.suffix}` as OperationId,
		semanticMergeFinishId: `semantic-merge-finish-${options.suffix}` as OperationId,
		isolationCleanupId: creatorDescriptor.isolationCleanupId,
		resultCompositionId: `result-composition-${options.suffix}` as OperationId,
		effectIdentityManifest,
		isolationNamespaceSha256: creatorDescriptor.namespaceSha256,
		isolationOwnerManifestSha256: creatorDescriptor.ownerManifestSha256,
		isolationCreatorDescriptorSha256: creatorDescriptor.creatorDescriptorSha256,
		postTerminalIntentSha256: await tupleRef([
			"omp-transient-task-post-terminal-intent-v1",
			"fixture",
			options.key.taskId,
			options.key.runId,
			options.key.createId,
		]),
		publicationTargetId: creatorDescriptor.publicationTargetId,
		resultPublicationTargetId: options.key.resultPublicationTargetId,
		resultPublicationTargetCleanupId: options.key.resultPublicationTargetCleanupId,
		pendingPayloadId: `pending-payload-${options.suffix}` as TransientTaskOutcomePayloadId,
		pendingPayloadDeleteId: `pending-delete-${options.suffix}` as OperationId,
		composedPayloadId: `composed-payload-${options.suffix}` as TransientTaskOutcomePayloadId,
		composedPayloadDeleteId: `composed-delete-${options.suffix}` as OperationId,
		resultlessIdentity: options.publicationPlan.resultlessIdentity,
		resultlessMaximumUtf8ByteLength: options.publicationPlan.maximumUtf8ByteLength,
		resultlessRepresentabilityPreflightSha256: options.publicationPlan.preflightSha256,
		resultPublicationPrePendingPlanSha256: options.publicationPlan.planSha256,
		workspaceId: proof.workspaceId,
		expectedInitialImage: { rootSha256: "0".repeat(64) as Sha256Hex, fileCount: 0, byteCount: 0 },
		plannedAt: fixedAt,
	};
	const authorityStore = new TransientTaskWorkspaceAuthorityStore({
		durable: options.durable,
		now: () => fixedAt,
	});
	const created = await authorityStore.create({
		plan: createPlan,
		isolationPreparation: {
			creatorDescriptor,
			orderedPriorAttempts: [],
			orderedPriorReceipts: [],
			updatedAt: fixedAt,
			state: "claim_effect_not_applied",
			activeAttempt,
		},
		controlHostId: proof.controlHostId,
		ttlMs: 60_000,
	});
	if (created.status === "conflict") throw new Error(`authority creation failed: ${created.code}`);
	if (created.authority.state !== "preparing") throw new Error("authority fixture is not preparing");
	return {
		authorityStore,
		revision: created.authority.revision,
		proof: created.authority.controller.proof,
	};
}

function initializationTuple(
	receipt: TransientTaskResultPublicationPrePendingInitializationReceiptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-result-publication-v1",
		"pre-pending-initialization-receipt",
		1,
		[
			receipt.resultTargetKey.taskId,
			receipt.resultTargetKey.runId,
			receipt.resultTargetKey.createId,
			receipt.resultTargetKey.resultPublicationId,
			receipt.resultTargetKey.resultPublicationTargetId,
			receipt.resultTargetKey.resultPublicationTargetCleanupId,
		],
		receipt.planSha256,
		receipt.requestSha256,
		receipt.initializedAt,
	];
}

function cancellationTuple(
	receipt: TransientTaskCancellationAcknowledgementReceiptV1,
): readonly CanonicalRuntimeValue[] {
	const key = receipt.core.resultTargetKey;
	return [
		"omp-transient-task-result-publication-v1",
		"cancellation-acknowledgement-receipt",
		1,
		[
			"omp-transient-task-result-publication-v1",
			"cancellation-acknowledgement-core",
			1,
			[
				key.taskId,
				key.runId,
				key.createId,
				key.resultPublicationId,
				key.resultPublicationTargetId,
				key.resultPublicationTargetCleanupId,
			],
			receipt.core.planSha256,
			receipt.core.kind,
			receipt.core.message,
		],
		receipt.initializationReceiptSha256,
		receipt.requestSha256,
		receipt.acknowledgedAt,
	];
}

function pendingTuple(pending: TransientTaskPendingOutcomeV1): readonly CanonicalRuntimeValue[] {
	const payload = pending.payload;
	if (payload.storage !== "inline_base64") throw new Error("fixture payload must be inline");
	return [
		"omp-transient-task-pending-outcome-v1",
		1,
		pending.taskId,
		pending.runId,
		pending.createId,
		pending.resultPublicationId,
		pending.resultPublicationTargetId,
		pending.resultPublicationTargetCleanupId,
		pending.pendingPayloadId,
		pending.pendingPayloadDeleteId,
		"pending",
		pending.outcome,
		pending.classification,
		pending.cancellationAcknowledgementReceiptSha256,
		[
			"inline_base64",
			payload.payloadRole,
			payload.mediaType,
			payload.bytesBase64,
			payload.byteLength,
			payload.payloadSha256,
		],
		null,
		pending.capturedAt,
	];
}
function resultlessEncodingTuple(
	encoding:
		| TransientTaskResultPublicationPrePendingPlanV1["representabilityPreflight"]["fallbackEncodings"]["failed"]
		| TransientTaskResultPublicationPrePendingPlanV1["representabilityPreflight"]["fallbackEncodings"]["cancelled"],
): readonly CanonicalRuntimeValue[] {
	const document = encoding.outcomeDocument;
	if (document.documentKind !== "resultless_terminal") throw new Error("fixture encoding must be resultless");
	const error = document.error;
	const errorTuple: readonly CanonicalRuntimeValue[] = [
		error.code,
		error.source,
		error.structuredSubagentKind,
		error.sourceMessage,
	];
	return [
		1,
		[1, "resultless_terminal", document.index, document.id, document.agent, document.terminalOutcome, errorTuple],
		encoding.outcomeDocumentUtf8,
		encoding.outcomeDocumentUtf8ByteLength,
		encoding.outcomeDocumentUtf8Sha256,
	];
}

function preflightTuple(
	preflight: TransientTaskResultPublicationPrePendingPlanV1["representabilityPreflight"],
): readonly CanonicalRuntimeValue[] {
	return [
		1,
		[preflight.identity.index, preflight.identity.id, preflight.identity.agent],
		preflight.maximumUtf8ByteLength,
		preflight.requiredResultlessFallbackUtf8ByteLength,
		resultlessEncodingTuple(preflight.fallbackEncodings.failed),
		resultlessEncodingTuple(preflight.fallbackEncodings.cancelled),
	];
}

function planTuple(plan: TransientTaskResultPublicationPrePendingPlanV1): readonly CanonicalRuntimeValue[] {
	const key = plan.resultTargetKey;
	return [
		"omp-transient-task-result-publication-v1",
		"pre-pending-plan",
		1,
		[
			key.taskId,
			key.runId,
			key.createId,
			key.resultPublicationId,
			key.resultPublicationTargetId,
			key.resultPublicationTargetCleanupId,
		],
		[plan.resultlessIdentity.index, plan.resultlessIdentity.id, plan.resultlessIdentity.agent],
		plan.maximumUtf8ByteLength,
		preflightTuple(plan.representabilityPreflight),
		plan.preflightSha256,
	];
}

function reopenedAuthority(durable: FileRuntimeDurableStateStoreV1) {
	return new TransientTaskWorkspaceAuthorityStore({ durable, now: () => fixedAt });
}

interface PendingFixtureV1 {
	readonly store: DurableTransientTaskResultPublicationStoreV1;
	readonly key: TransientTaskResultPublicationTargetKeyV1;
	readonly proof: TransientTaskControllerAuthorityProofV1;
	readonly plan: TransientTaskResultPublicationPrePendingPlanV1;
	readonly predecessor:
		| TransientTaskResultPublicationPrePendingInitializationReceiptV1
		| TransientTaskCancellationAcknowledgementReceiptV1;
	readonly pending: TransientTaskPendingOutcomeV1;
	readonly revision: number;
	readonly requestSha256: Sha256Hex;
}

async function preparePending(options: {
	root: string;
	suffix: string;
	outcome: "succeeded" | "failed" | "cancelled";
}) {
	const durable = new FileRuntimeDurableStateStoreV1(options.root);
	const key = targetKey(options.suffix);
	const preflightResult = preflightTransientTaskResultlessRepresentabilityV1(0, "resultless", "test", 4096);
	if (preflightResult.status !== "accepted") throw new Error(`preflight failed: ${preflightResult.code}`);
	const preflightSha256 = await tupleRef(preflightTuple(preflightResult.preflight));
	const provisionalPlan: TransientTaskResultPublicationPrePendingPlanV1 = {
		schemaVersion: 1,
		resultTargetKey: key,
		resultlessIdentity: preflightResult.preflight.identity,
		maximumUtf8ByteLength: preflightResult.preflight.maximumUtf8ByteLength,
		representabilityPreflight: preflightResult.preflight,
		preflightSha256,
		planSha256: preflightSha256,
	};
	const plan: TransientTaskResultPublicationPrePendingPlanV1 = {
		...provisionalPlan,
		planSha256: await tupleRef(planTuple(provisionalPlan)),
	};
	const seeded = await seedWorkspaceAuthority({
		durable,
		key,
		publicationPlan: plan,
		suffix: options.suffix,
	});
	const { authorityStore, revision, proof } = seeded;
	const store = new DurableTransientTaskResultPublicationStoreV1({
		durable,
		authority: authorityStore,
		delivery: { deliver: async () => ({ status: "invalid" }) },
		now: () => fixedAt,
	});
	const initializationRequestSha256 = await canonicalRuntimeSha256([
		"omp-transient-task-result-publication-v1",
		"pre-pending-initialize",
		1,
		planTuple(plan),
		revision,
		proof.fencingGeneration,
		controllerTuple(proof),
		fixedAt,
	]);
	const initialized = await store.initializePrePending({
		plan,
		expectedAuthorityRevision: revision,
		fencingGeneration: proof.fencingGeneration,
		controller: proof,
		initializedAt: fixedAt,
		requestSha256: initializationRequestSha256,
	});
	if (initialized.status !== "initialized") throw new Error(`initialization failed: ${initialized.status}`);
	let predecessor:
		| TransientTaskResultPublicationPrePendingInitializationReceiptV1
		| TransientTaskCancellationAcknowledgementReceiptV1 = initialized.state.initializationReceipt;
	let cancellationReceiptSha256: Sha256Ref | null = null;
	if (options.outcome === "cancelled") {
		const core = {
			schemaVersion: 1 as const,
			resultTargetKey: key,
			planSha256: plan.planSha256,
			kind: "detached_pre_execution_abort" as const,
			message: "Aborted before execution" as const,
			coreSha256: await tupleRef([
				"omp-transient-task-result-publication-v1",
				"cancellation-acknowledgement-core",
				1,
				[
					key.taskId,
					key.runId,
					key.createId,
					key.resultPublicationId,
					key.resultPublicationTargetId,
					key.resultPublicationTargetCleanupId,
				],
				plan.planSha256,
				"detached_pre_execution_abort",
				"Aborted before execution",
			]),
		};
		const cancellationRequestSha256 = await canonicalRuntimeSha256([
			"omp-transient-task-result-publication-v1",
			"cancellation-acknowledgement-request",
			1,
			[
				"omp-transient-task-result-publication-v1",
				"cancellation-acknowledgement-core",
				1,
				[
					key.taskId,
					key.runId,
					key.createId,
					key.resultPublicationId,
					key.resultPublicationTargetId,
					key.resultPublicationTargetCleanupId,
				],
				core.planSha256,
				core.kind,
				core.message,
			],
			initialized.state.initializationReceipt.receiptSha256,
			revision,
			proof.fencingGeneration,
			controllerTuple(proof),
			fixedAt,
		]);
		const acknowledged = await store.acknowledgeCancellation({
			core,
			expectedInitializationReceiptSha256: initialized.state.initializationReceipt.receiptSha256,
			expectedAuthorityRevision: revision,
			fencingGeneration: proof.fencingGeneration,
			controller: proof,
			requestedAt: fixedAt,
			requestSha256: cancellationRequestSha256,
		});
		if (acknowledged.status !== "acknowledged") throw new Error(`cancellation failed: ${acknowledged.status}`);
		predecessor = acknowledged.state.cancellationAcknowledgementReceipt;
		cancellationReceiptSha256 = predecessor.receiptSha256;
	}
	const bytes = JSON.stringify({ outcome: options.outcome });
	const payloadSha256 = shaRef(bytes);
	const pendingBase = {
		...key,
		pendingPayloadId: `pending-payload-${options.suffix}` as TransientTaskOutcomePayloadId,
		pendingPayloadDeleteId: `pending-delete-${options.suffix}` as OperationId,
		payload: {
			storage: "inline_base64" as const,
			payloadRole: "pending" as const,
			mediaType,
			bytesBase64: Buffer.from(bytes, "utf8").toString("base64"),
			byteLength: Buffer.byteLength(bytes, "utf8"),
			payloadSha256,
		},
		payloadPutReceipt: null,
		capturedAt: fixedAt,
	};
	let provisionalPending: TransientTaskPendingOutcomeV1;
	if (options.outcome === "succeeded") {
		provisionalPending = {
			...pendingBase,
			outcome: "succeeded",
			classification: "child_completion",
			cancellationAcknowledgementReceiptSha256: null,
			outcomeSha256: payloadSha256,
		};
	} else if (options.outcome === "failed") {
		provisionalPending = {
			...pendingBase,
			outcome: "failed",
			classification: "child_failure",
			cancellationAcknowledgementReceiptSha256: null,
			outcomeSha256: payloadSha256,
		};
	} else {
		if (cancellationReceiptSha256 === null) throw new Error("cancelled fixture lacks acknowledgement");
		provisionalPending = {
			...pendingBase,
			outcome: "cancelled",
			classification: "durable_cancellation_acknowledgement",
			cancellationAcknowledgementReceiptSha256: cancellationReceiptSha256,
			outcomeSha256: payloadSha256,
		};
	}
	const pending: TransientTaskPendingOutcomeV1 = {
		...provisionalPending,
		outcomeSha256: await tupleRef(pendingTuple(provisionalPending)),
	};
	const predecessorTuple =
		pending.outcome === "cancelled"
			? "core" in predecessor
				? cancellationTuple(predecessor)
				: null
			: "core" in predecessor
				? null
				: initializationTuple(predecessor);
	if (predecessorTuple === null) throw new Error("fixture predecessor arm mismatch");
	const requestSha256 = await canonicalRuntimeSha256([
		"omp-transient-task-pending-outcome-v1",
		"put-request",
		1,
		pendingTuple(pending),
		predecessorTuple,
		revision,
		proof.fencingGeneration,
		controllerTuple(proof),
	]);
	return { store, key, proof, plan, predecessor, pending, revision, requestSha256 } satisfies PendingFixtureV1;
}
async function putFixturePending(fixture: PendingFixtureV1, requestSha256: Sha256Hex) {
	const common = {
		expectedAuthorityRevision: fixture.revision,
		fencingGeneration: fixture.proof.fencingGeneration,
		controller: fixture.proof,
		requestSha256,
	};
	if (fixture.pending.outcome === "cancelled") {
		if (!("core" in fixture.predecessor)) throw new Error("cancelled fixture predecessor mismatch");
		return fixture.store.putPending({
			...common,
			pending: fixture.pending,
			predecessorReceipt: fixture.predecessor,
		});
	}
	if ("core" in fixture.predecessor) throw new Error("non-cancelled fixture predecessor mismatch");
	return fixture.store.putPending({
		...common,
		pending: fixture.pending,
		predecessorReceipt: fixture.predecessor,
	});
}

describe("RuntimeController transient result publication", () => {
	it("records every pending outcome arm, recomputes exact receipt tuples, and adopts byte-identically after restart", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "omp-runtime-controller-contract-"));
		try {
			for (const outcome of ["succeeded", "failed", "cancelled"] as const) {
				const fixture = await preparePending({ root, suffix: outcome, outcome });
				expect(await putFixturePending(fixture, "f".repeat(64) as Sha256Hex)).toEqual({ status: "invalid" });
				const recorded = await putFixturePending(fixture, fixture.requestSha256);
				expect(recorded.status).toBe("recorded");
				if (recorded.status !== "recorded") throw new Error("expected recorded pending state");
				const receipt = recorded.state.receipt;
				expect(receipt.receiptSha256).toBe(
					await tupleRef([
						"omp-transient-task-pending-outcome-v1",
						"receipt",
						1,
						fixture.key.taskId,
						fixture.key.runId,
						"pending",
						fixture.key.createId,
						fixture.key.resultPublicationId,
						fixture.key.resultPublicationTargetId,
						fixture.key.resultPublicationTargetCleanupId,
						fixture.pending.pendingPayloadId,
						fixture.pending.pendingPayloadDeleteId,
						fixture.pending.outcome,
						fixture.pending.outcomeSha256,
						recorded.state.initializationReceipt.receiptSha256,
						fixture.predecessor.receiptSha256,
						fixture.pending.cancellationAcknowledgementReceiptSha256,
						fixture.pending.payload.payloadSha256,
						null,
						fixture.requestSha256,
						receipt.recordedAt,
					]),
				);
				const reopenedDurable = new FileRuntimeDurableStateStoreV1(root);
				const reopened = new DurableTransientTaskResultPublicationStoreV1({
					durable: reopenedDurable,
					authority: reopenedAuthority(reopenedDurable),
					delivery: { deliver: async () => ({ status: "invalid" }) },
					now: () => fixedAt,
				});
				const inspectRequestSha256 = await canonicalRuntimeSha256([
					"omp-transient-task-result-publication-v1",
					"pre-pending-inspect",
					1,
					targetKeyTuple(fixture.key),
					fixture.plan.planSha256,
					fixedAt,
				]);
				const inspectRequest = {
					resultTargetKey: fixture.key,
					expectedPlanSha256: fixture.plan.planSha256,
					inspectedAt: fixedAt,
					requestSha256: inspectRequestSha256,
				};
				const inspection = await reopened.inspectPrePending(inspectRequest);
				expect(inspection.state).toBe("pending");
				if (inspection.state !== "pending") throw new Error("expected pending inspection");
				const inspectionTuple = [
					"omp-transient-task-result-publication-v1",
					"pre-pending-inspection",
					1,
					inspection.state,
					inspection.initializationReceiptSha256,
					inspection.cancellationAcknowledgementReceiptSha256,
					inspection.pendingReceiptSha256,
				] as const;
				const adoptRequestSha256 = await canonicalRuntimeSha256([
					"omp-transient-task-result-publication-v1",
					"pre-pending-adopt",
					1,
					[
						"omp-transient-task-result-publication-v1",
						"pre-pending-inspect",
						1,
						targetKeyTuple(fixture.key),
						fixture.plan.planSha256,
						fixedAt,
					],
					inspectionTuple,
					inspection.inspectionSha256,
					controllerTuple(fixture.proof),
					fixedAt,
				]);
				const adopted = await reopened.adoptPrePending({
					inspectRequest,
					inspection,
					expectedInspectionSha256: inspection.inspectionSha256,
					controller: fixture.proof,
					adoptedAt: fixedAt,
					requestSha256: adoptRequestSha256,
				});
				expect(adopted).toEqual({ status: "adopted", state: recorded.state });
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("WorkspaceRuntimeControllerV1 persistent status", () => {
	it("constructs without transient Task or Hub stores", () => {
		const workspaceId = "workspace-controller-construction" as WorkspaceId;
		const lease = {
			proof: {
				workspaceId,
				agentId: "agent",
				controlHostId: "host",
				ownerEpoch: 1,
				leaseId: "lease",
				epoch: 1,
			},
			acquiredAt: fixedAt,
			renewBy: "2026-08-06T00:01:00.000Z",
			expiresAt: "2026-08-06T00:02:00.000Z",
		};
		const runtime = new WorkspaceRuntimeControllerV1({
			workspaceId,
			ownership: {} as never,
			controllerLeaseStore: {} as never,
			controllerLease: lease as never,
			controllerLeaseTtlMs: 60_000,
			runtimeLeaseTtlMs: 60_000,
			commitGuard: {} as never,
			attachmentStore: {} as never,
			canonicalStore: {} as never,
			registry: {} as never,
			scheduler: {} as never,
			providerConfigurations: [],
			now: () => fixedAt,
		});

		expect(runtime).toBeInstanceOf(WorkspaceRuntimeControllerV1);
		expect("transientTaskWorkspaceAuthorityStore" in runtime).toBe(false);
	});

	it("projects durable cleanup schedules, timing, completed transition latency, and selected-provider cost", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "omp-runtime-status-contract-"));
		try {
			const workspaceId = "workspace-controller-status" as WorkspaceId;
			const lease = {
				proof: {
					workspaceId,
					agentId: "agent",
					controlHostId: "host",
					ownerEpoch: 1,
					leaseId: "lease",
					epoch: 1,
				},
				acquiredAt: fixedAt,
				renewBy: "2026-08-06T00:01:00.000Z",
				expiresAt: "2026-08-06T00:02:00.000Z",
			};
			const durable = new FileRuntimeDurableStateStoreV1(root);
			const attachmentStore = new RuntimeAttachmentFileStoreV1({
				durable,
				authority: {
					authorizePersistentController: async () => ({ status: "current" }),
				} as never,
			});
			const initial = {
				schemaVersion: 1,
				createId: "attachment-create",
				revision: 1,
				workspaceId,
				attachment: {
					state: "none",
					transitionId: null,
					active: null,
					lastDiscardedRuntimeChanges: null,
					block: null,
				},
				scheduler: {
					input: null,
					providers: [],
					candidates: [],
					decision: { status: "not_evaluated" },
					evaluatedAt: null,
					durationMs: null,
				},
				lastCompletedTransition: null,
				updatedAt: fixedAt,
			};
			expect(
				await attachmentStore.create({
					createId: initial.createId as never,
					initial: initial as never,
					controllerLease: lease.proof as never,
				}),
			).toMatchObject({ status: "complete" });
			const now = "2026-08-06T00:00:20.000Z";
			const selectedScheduler = {
				input: {
					placement: "auto",
					configuredProviderId: "provider",
					workspaceFormat: "omp-text-v1",
					capabilities: [],
					os: null,
					arch: null,
					minCpu: 0,
					minMemoryMiB: 0,
					network: "none",
					maxReadyLatencyMs: null,
				},
				providers: [],
				candidates: [
					{
						providerId: "provider",
						profileId: "profile",
						location: "local",
						hardFilterFailures: [],
						retainedCurrent: false,
						estimatedIncrementalCostMicrosPerHour: 3_600_000,
						estimatedReadyLatencyMs: 5,
					},
				],
				decision: { status: "selected", providerId: "provider", profileId: "profile", retainedCurrent: false },
				evaluatedAt: "2026-08-06T00:00:05.000Z",
				durationMs: 3,
			};
			expect(
				await attachmentStore.replace({
					expectedRevision: 1,
					next: {
						...initial,
						revision: 2,
						scheduler: selectedScheduler,
						lastCompletedTransition: {
							transitionId: "ready-transition",
							reason: "first_tool",
							from: "none",
							to: "active",
							startedAt: fixedAt,
							completedAt: "2026-08-06T00:00:10.000Z",
						},
						updatedAt: "2026-08-06T00:00:10.000Z",
					} as never,
					controllerLease: lease.proof as never,
				}),
			).toMatchObject({ status: "replaced" });
			const entries = [
				{
					cacheEviction: {
						state: "pending",
						plan: { retentionDeadline: "2026-08-06T00:00:09.000Z" },
						progress: { state: "deferred", nextAttemptAt: "2026-08-06T00:00:04.000Z" },
					},
					cleanup: { state: "pending", nextAttemptAt: "2026-08-06T00:00:03.000Z" },
					observation: { state: "retained" },
				},
				{
					cacheEviction: { state: "not_requested" },
					cleanup: {
						state: "failed",
						retryable: true,
						nextRetryAt: "2026-08-06T00:00:02.000Z",
					},
					observation: { state: "absent" },
				},
				{
					cacheEviction: { state: "not_requested" },
					cleanup: {
						state: "failed",
						retryable: false,
						nextRetryAt: "2026-08-06T00:00:01.000Z",
					},
					observation: { state: "absent" },
				},
			];
			const runtime = new WorkspaceRuntimeControllerV1({
				workspaceId,
				ownership: {
					isHeld: () => true,
					read: async () => ({
						kind: "record",
						record: {
							phase: "open",
							workspace: {
								workspaceId,
								canonical: { state: "present" },
								knownReplicas: { entries },
							},
						},
					}),
				} as never,
				controllerLeaseStore: {} as never,
				controllerLease: lease as never,
				controllerLeaseTtlMs: 60_000,
				runtimeLeaseTtlMs: 60_000,
				commitGuard: {} as never,
				attachmentStore,
				canonicalStore: {
					inspect: async () => ({ status: "present", workspace: { checkpoint: { generation: 7 } } }),
				} as never,
				registry: {} as never,
				scheduler: {} as never,
				providerConfigurations: [],
				now: () => now,
			});

			const status = await runtime.status();
			expect(status.replicaCleanup).toMatchObject({ nextCleanupAt: "2026-08-06T00:00:02.000Z" });
			expect(status.latency).toMatchObject({
				lastReadyLatencyMs: 10_000,
				lastDrainMs: null,
				accumulatedActiveRuntimeMs: 0,
				accumulatedZeroRuntimeIdleMs: 20_000,
				observedThrough: now,
			});
			expect(status.cost).toEqual({
				availability: "available",
				estimateSource: "configured",
				currency: "USD",
				unitRateMicrosPerHour: 3_600_000,
				estimatedIncrementalCostMicrosPerHour: 3_600_000,
				measuredActiveIntervalMs: 0,
				conservativeUpperBoundMicros: 0,
				observedAt: now,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
