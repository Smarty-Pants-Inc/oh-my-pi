import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type ExecutionEnvironmentLease,
	type ExecutionEnvironmentProvider,
	ExecutionEnvironmentReleaseIndeterminateErrorV1,
	type ExecutionEnvironmentReleaseProviderV1,
	freezeExecutionEnvironmentRuntimeReleaseAuthorityV1,
	reconcileExecutionEnvironmentRuntimeReleaseV1,
} from "@oh-my-pi/pi-coding-agent/session/execution-environment";
import type {
	ConfidentialTransientTaskEnsureIsolationRequestV1,
	ConfidentialTransientTaskIsolationCleanupDescriptorV1,
	ConfidentialTransientTaskIsolationCreatorDescriptorV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1,
	ConfidentialTransientTaskIsolationOwnershipClaimV1,
	ConfidentialTransientTaskIsolationPreparingAuthorityV1,
	ConfidentialTransientTaskIsolationReadyToBindReceiptV1,
	OrdinaryTransientTaskBoundIsolationContinuationV1,
	OrdinaryTransientTaskExecutionEnvironmentReleaseBarrierV1,
	OrdinaryTransientTaskLifecycleFailureInputV1,
	OrdinaryTransientTaskPendingOutcomeContinuationV1,
	RuntimeLeaseReleaseResult,
	RuntimeReplicaDeleteResult,
	RuntimeReplicaDeletionAuthorizationV1,
	TransientTaskCanonicalDiscardReceiptV1,
	TransientTaskCanonicalProviderTerminalEvidenceV1,
	TransientTaskCaptureReceiptV1,
	TransientTaskControllerAuthorityProofV1,
	TransientTaskEffectIdentityManifestV1,
	TransientTaskIsolationCleanupReceiptV1,
	TransientTaskIsolationCleanupTerminalEvidenceV1,
	TransientTaskNoAcknowledgedEffectsProofV1,
	TransientTaskPendingOutcomeReceiptV1,
	TransientTaskPendingOutcomeV1,
	TransientTaskPostTerminalCleanupEvidenceV1,
	TransientTaskPreparedReplicaDeleteV1,
	TransientTaskPublicationTargetBindingEvidenceV1,
	TransientTaskPublicationTargetBindReceiptV1,
	TransientTaskPublicationTargetCleanupClaimV1,
	TransientTaskPublicationTargetPublicationClaimV1,
	TransientTaskPublicationTargetReleaseReceiptV1,
	TransientTaskResultlessRepresentabilityPreflightV1,
	TransientTaskWorkspaceTombstoneV1,
	TransientTaskWorktreePublicationReceiptV1,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import { canonicalRuntimeProviderInspectionSha256V1 } from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	type IsolatedRunOptions,
	runIsolatedSubprocess,
	type TransientTaskIsolationLifecycleAdapterV1,
	type TransientTaskIsolationSettlementV1,
} from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import { createTransientTaskOutcomePayloadByteBudgetV1 } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { deriveTransientTaskIsolationPhysicalIdentityV1 } from "@oh-my-pi/pi-coding-agent/task/worktree";

const NOW = "2026-01-01T00:00:00.000Z";
const RENEW_BY = "2026-01-01T00:05:00.000Z";
const EXPIRES_AT = "2026-01-01T00:10:00.000Z";

function hex(digit: string): string {
	return digit.repeat(64);
}

function shaRef(digit: string): `sha256:${string}` {
	return `sha256:${hex(digit)}`;
}

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "EnvironmentTask",
		agent: "task",
		agentSource: "bundled",
		task: "Do environment work",
		assignment: "Do environment work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

function resultlessPreflight(): TransientTaskResultlessRepresentabilityPreflightV1 {
	const preflight = executorModule.preflightTransientTaskResultlessRepresentabilityV1(
		0,
		"EnvironmentTask",
		"task",
		1_048_576,
	);
	if (preflight.status !== "accepted") throw new Error(`Unexpected preflight rejection: ${preflight.code}`);
	return preflight.preflight;
}

async function isolationAuthority(events: string[]) {
	const taskId = "task-1";
	const runId = "run-1";
	const createId = "create-1";
	const identity = await deriveTransientTaskIsolationPhysicalIdentityV1({ taskId, runId, createId });
	const descriptor = {
		schemaVersion: 1,
		taskId,
		runId,
		createId,
		publicationTargetId: "publication-target-1",
		worktreePublicationId: "worktree-publication-1",
		isolationCleanupId: "isolation-cleanup-1",
		bindingOperationId: "binding-operation-1",
		ownershipClaimCreateOperationId: "ownership-claim-create-1",
		effectIdentityManifestSha256: shaRef("1"),
		...identity,
		ownerManifestSha256: shaRef("2"),
		creatorDescriptorSha256: shaRef("3"),
	} satisfies ConfidentialTransientTaskIsolationCreatorDescriptorV1;
	const controller = {
		schemaVersion: 1,
		taskId,
		runId,
		createId,
		controllerId: "controller-1",
		workspaceId: "workspace-1",
		controlHostId: "host-1",
		controllerEpoch: 0,
		fencingGeneration: 0,
	} satisfies TransientTaskControllerAuthorityProofV1;
	const ownershipClaim = {
		schemaVersion: 1,
		ownerManifestSha256: descriptor.ownerManifestSha256,
		claimOperationId: descriptor.ownershipClaimCreateOperationId,
		claimantInstanceId: "claimant-1",
		controlHostId: controller.controlHostId,
		pid: 123,
		processStartToken: "process-start-1",
		claimedAt: NOW,
		claimSha256: shaRef("4"),
	} satisfies ConfidentialTransientTaskIsolationOwnershipClaimV1;
	const claimRequest = {
		schemaVersion: 1,
		taskId,
		runId,
		createId,
		operation: "exclusive_create",
		effectOperationId: descriptor.ownershipClaimCreateOperationId,
		creatorDescriptor: descriptor,
		controller,
		authoritySha256: shaRef("5"),
		requestedAt: NOW,
		requestSha256: shaRef("6"),
		expectedClaim: null,
		nextClaim: ownershipClaim,
		exclusive: true,
		noFollow: true,
		createParentDirectories: false,
	} satisfies ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1;
	const claimAttempt = {
		state: "claim_outcome_unknown",
		request: claimRequest,
		openedAt: NOW,
		attemptSha256: shaRef("7"),
	} satisfies ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1;
	const claimReceipt = {
		schemaVersion: 1,
		taskId,
		runId,
		createId,
		effectOperationId: claimRequest.effectOperationId,
		requestSha256: claimRequest.requestSha256,
		attemptSha256: claimAttempt.attemptSha256,
		authoritySha256: claimRequest.authoritySha256,
		completedAt: NOW,
		receiptSha256: shaRef("8"),
		operation: "exclusive_create",
		outcome: "created",
		previousClaimSha256: null,
		claim: ownershipClaim,
		currentClaimSha256: ownershipClaim.claimSha256,
	} satisfies ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1;
	const preparation = {
		state: "claim_current",
		creatorDescriptor: descriptor,
		orderedClaimAttempts: [claimAttempt],
		orderedClaimReceipts: [claimReceipt],
		ownershipClaim,
		ownershipClaimReceipt: claimReceipt,
		updatedAt: NOW,
	} satisfies Extract<ConfidentialTransientTaskIsolationPreparingAuthorityV1, { state: "claim_current" }>;
	const cleanupDescriptor = {
		schemaVersion: 1,
		creatorDescriptor: descriptor,
		mergedDir: descriptor.mergedDir,
		backend: 0,
		fellBack: false,
		fallbackReason: null,
		cleanupDescriptorSha256: shaRef("9"),
	} satisfies ConfidentialTransientTaskIsolationCleanupDescriptorV1;
	const ensureRequest = {
		preparation,
		controller,
		authoritySha256: shaRef("a"),
		requestSha256: shaRef("b"),
		requestedAt: NOW,
	} satisfies ConfidentialTransientTaskEnsureIsolationRequestV1;
	const materialize = vi.fn<TransientTaskIsolationLifecycleAdapterV1["materializer"]["ensureIsolation"]>(
		async request => {
			events.push("materialize");
			expect(request).toBe(ensureRequest);
			return { status: "created", cleanupDescriptor };
		},
	);
	const ready = {
		schemaVersion: 1,
		taskId,
		runId,
		createId,
		creatorDescriptor: descriptor,
		ownershipClaim,
		ownershipClaimReceipt: claimReceipt,
		cleanupDescriptor,
		orderedClaimAttemptSha256s: [claimAttempt.attemptSha256],
		orderedClaimReceiptSha256s: [claimReceipt.receiptSha256],
		authoritySha256: shaRef("c"),
		preparedAt: NOW,
		receiptSha256: shaRef("d"),
	} satisfies ConfidentialTransientTaskIsolationReadyToBindReceiptV1;
	const bindReceipt = {
		schemaVersion: 1,
		key: { schemaVersion: 1, taskId, runId, createId, publicationTargetId: descriptor.publicationTargetId },
		isolationCleanupId: descriptor.isolationCleanupId,
		bindingOperationId: descriptor.bindingOperationId,
		state: "bound",
		bindingRevision: 1,
		renewalSequence: 0,
		cleanupDescriptorSha256: cleanupDescriptor.cleanupDescriptorSha256,
		isolationCreatorPreparationReceiptSha256: ready.receiptSha256,
		isolationOwnershipClaimReceiptSha256: claimReceipt.receiptSha256,
		isolationCreatorDescriptorSha256: descriptor.creatorDescriptorSha256,
		isolationNamespaceSha256: descriptor.namespaceSha256,
		isolationOwnerManifestSha256: descriptor.ownerManifestSha256,
		bindRequestSha256: hex("c"),
		authoritySha256: shaRef("e"),
		boundAt: NOW,
		renewBy: RENEW_BY,
		expiresAt: EXPIRES_AT,
		receiptSha256: shaRef("f"),
	} satisfies TransientTaskPublicationTargetBindReceiptV1;
	const bound = {
		preparation: { state: "bound", ready, bindReceipt, updatedAt: NOW },
		cleanupDescriptor,
		releaseBarrier: { status: "not_applicable" },
	} satisfies OrdinaryTransientTaskBoundIsolationContinuationV1;

	return {
		taskId,
		runId,
		materializer: { ensureIsolation: materialize },
		materialize,
		ensureRequest,
		cleanupDescriptor,
		bound,
	};
}

interface IsolationAuthorityFixture {
	readonly taskId: string;
	readonly runId: string;
	readonly ensureRequest: ConfidentialTransientTaskEnsureIsolationRequestV1;
	readonly cleanupDescriptor: ConfidentialTransientTaskIsolationCleanupDescriptorV1;
	readonly bound: OrdinaryTransientTaskBoundIsolationContinuationV1;
}

function pendingOutcomeFixture(
	authority: IsolationAuthorityFixture,
	outcome: "succeeded" | "failed",
): OrdinaryTransientTaskPendingOutcomeContinuationV1 {
	const base = {
		schemaVersion: 1 as const,
		taskId: authority.taskId,
		runId: authority.runId,
		createId: authority.ensureRequest.controller.createId,
		resultPublicationId: "result-publication-1",
		resultPublicationTargetId: "result-target-1",
		resultPublicationTargetCleanupId: "result-target-cleanup-1",
		pendingPayloadId: "pending-payload-1",
		pendingPayloadDeleteId: "pending-payload-delete-1",
		capturedAt: NOW,
		outcomeSha256: shaRef("1"),
		cancellationAcknowledgementReceiptSha256: null,
		payload: {
			storage: "inline_base64" as const,
			payloadRole: "pending" as const,
			mediaType: "application/vnd.omp.task-outcome.v1+json" as const,
			bytesBase64: "e30=",
			byteLength: 2,
			payloadSha256: shaRef("2"),
		},
		payloadPutReceipt: null,
	};
	const pending =
		outcome === "succeeded"
			? ({ ...base, outcome, classification: "child_completion" } satisfies TransientTaskPendingOutcomeV1)
			: ({ ...base, outcome, classification: "child_failure" } satisfies TransientTaskPendingOutcomeV1);
	const receipt = {
		schemaVersion: 1,
		state: "pending",
		taskId: pending.taskId,
		runId: pending.runId,
		createId: pending.createId,
		resultPublicationId: pending.resultPublicationId,
		resultPublicationTargetId: pending.resultPublicationTargetId,
		resultPublicationTargetCleanupId: pending.resultPublicationTargetCleanupId,
		pendingPayloadId: pending.pendingPayloadId,
		pendingPayloadDeleteId: pending.pendingPayloadDeleteId,
		outcome,
		outcomeSha256: pending.outcomeSha256,
		initializationReceiptSha256: shaRef("3"),
		predecessorReceiptSha256: shaRef("4"),
		cancellationAcknowledgementReceiptSha256: null,
		payloadSha256: pending.payload.payloadSha256,
		payloadPutReceiptSha256: null,
		requestSha256: hex("5"),
		recordedAt: NOW,
		receiptSha256: shaRef("6"),
	} satisfies TransientTaskPendingOutcomeReceiptV1;
	return { pending, receipt };
}

function terminalEvidenceFixture(
	authority: IsolationAuthorityFixture,
	outcome: "succeeded" | "failed",
): TransientTaskPostTerminalCleanupEvidenceV1 {
	const taskId = authority.taskId;
	const runId = authority.runId;
	const descriptor = authority.cleanupDescriptor.creatorDescriptor;
	const bindReceipt = authority.bound.preparation.bindReceipt;
	const publicationTargetKey = bindReceipt.key;
	const checkpoint = {
		workspaceId: authority.ensureRequest.controller.workspaceId,
		generation: 1,
		rootSha256: hex("1"),
		fileCount: 0,
		byteCount: 0,
		committedAt: NOW,
	};
	const replica = {
		providerId: "provider-terminal-1",
		profileId: "profile-terminal-1",
		replicaId: "replica-terminal-1",
		workspaceId: checkpoint.workspaceId,
	};
	const runtimeRelease = {
		status: "released",
		request: { requestId: "terminal-release-request-1", requestSha256: hex("2"), parentOperationId: "cleanup-1" },
		replica,
		leaseId: "terminal-lease-1",
		compute: "stopped",
	} satisfies RuntimeLeaseReleaseResult;
	const effectIdentityManifest = {
		schemaVersion: 1,
		taskId,
		runId,
		worktreePublicationId: descriptor.worktreePublicationId,
		captureMemberNamespaceId: "capture-member-namespace-1",
		captureMaterializationNamespaceId: "capture-materialization-namespace-1",
		messageGenerationNamespaceId: "message-generation-namespace-1",
		captureSubeffectNamespaceId: "capture-subeffect-namespace-1",
		semanticMergeStepNamespaceId: "semantic-merge-step-namespace-1",
		semanticMergeSubeffectNamespaceId: "semantic-merge-subeffect-namespace-1",
		bindingOperationNamespaceId: "binding-operation-namespace-1",
		payloadRetentionNamespaceId: "payload-retention-namespace-1",
		parentDeliveryNamespaceId: "parent-delivery-namespace-1",
		manifestSha256: descriptor.effectIdentityManifestSha256,
	} satisfies TransientTaskEffectIdentityManifestV1;
	const noEffectsProof = {
		schemaVersion: 1,
		taskId,
		runId,
		assessmentId: "assessment-1",
		providerWorkspace: {
			taskId,
			runId,
			workspaceId: checkpoint.workspaceId,
			acquisitionTransitionId: "acquisition-transition-1",
			lease: {
				replica,
				leaseId: runtimeRelease.leaseId,
				fenceId: "terminal-fence-1",
				initialRenewalSequence: 0,
				baseCheckpoint: checkpoint,
				deletionAuthorityDomain: "transient_task",
				leaseTtlMs: 60_000,
			},
			recovery: {
				locator: {
					recoveryFreezeId: "recovery-freeze-1",
					replica,
					leaseId: runtimeRelease.leaseId,
					fenceId: "terminal-fence-1",
					baseGeneration: 0,
					checkpointId: "frozen-checkpoint-1",
				},
				canonicalCommitId: "canonical-commit-1",
				requests: {
					freeze: { requestId: "freeze-request-1", requestSha256: hex("3") },
					checkpointAcknowledgement: {
						requestId: "checkpoint-ack-request-1",
						parentOperationId: "recovery-freeze-1",
					},
					release: {
						requestId: runtimeRelease.request.requestId,
						requestSha256: runtimeRelease.request.requestSha256,
						parentOperationId: runtimeRelease.request.parentOperationId,
					},
				},
			},
		},
		baseCheckpoint: checkpoint,
		observedImage: { rootSha256: checkpoint.rootSha256, fileCount: 0, byteCount: 0 },
		acknowledgedMutationCount: 0,
		acknowledgedCommandCount: 0,
		unknownMutationCount: 0,
		unknownCommandCount: 0,
		activeCommands: 0,
		pendingSyncs: 0,
		observedAt: NOW,
		proofSha256: shaRef("7"),
	} satisfies TransientTaskNoAcknowledgedEffectsProofV1;
	const branch =
		outcome === "succeeded"
			? ({ kind: "preserve", reason: "task_succeeded", assessment: null } as const)
			: ({
					kind: "fast_discard",
					reason: "no_acknowledged_effects",
					assessment: { status: "none_acknowledged", proof: noEffectsProof },
				} as const);
	const cleanupClaim = {
		schemaVersion: 1,
		key: publicationTargetKey,
		isolationCleanupId: descriptor.isolationCleanupId,
		openOperationId: "cleanup-open-1",
		cleanupClaimOperationId: "cleanup-claim-1",
		access: "live",
		bindingRevision: bindReceipt.bindingRevision,
		renewalSequence: bindReceipt.renewalSequence,
		bindingReceiptSha256: bindReceipt.receiptSha256,
		bindingAuthoritySha256: bindReceipt.authoritySha256,
		bindingOpenRequestSha256: hex("8"),
		cleanupDescriptorSha256: authority.cleanupDescriptor.cleanupDescriptorSha256,
		isolationNamespaceSha256: descriptor.namespaceSha256,
		isolationOwnerManifestSha256: descriptor.ownerManifestSha256,
		isolationCreatorDescriptorSha256: descriptor.creatorDescriptorSha256,
		claimedAt: NOW,
		claimSha256: shaRef("9"),
	} satisfies TransientTaskPublicationTargetCleanupClaimV1;
	const publicationClaim = {
		schemaVersion: 1,
		key: publicationTargetKey,
		isolationCleanupId: descriptor.isolationCleanupId,
		worktreePublicationId: descriptor.worktreePublicationId,
		openOperationId: "publication-open-1",
		access: "live",
		bindingRevision: bindReceipt.bindingRevision,
		renewalSequence: bindReceipt.renewalSequence,
		bindingReceiptSha256: bindReceipt.receiptSha256,
		bindingAuthoritySha256: bindReceipt.authoritySha256,
		bindingOpenRequestSha256: hex("a"),
		isolationNamespaceSha256: descriptor.namespaceSha256,
		isolationOwnerManifestSha256: descriptor.ownerManifestSha256,
		isolationCreatorDescriptorSha256: descriptor.creatorDescriptorSha256,
		claimedAt: NOW,
		claimSha256: shaRef("b"),
	} satisfies TransientTaskPublicationTargetPublicationClaimV1;
	const worktreePublication =
		outcome === "succeeded"
			? ({
					schemaVersion: 1,
					taskId,
					runId,
					worktreePublicationId: descriptor.worktreePublicationId,
					effectIdentityManifestSha256: descriptor.effectIdentityManifestSha256,
					workspaceId: checkpoint.workspaceId,
					createId: descriptor.createId,
					cleanupId: "cleanup-1",
					cleanupAuthorityId: "cleanup-authority-1",
					publicationTargetKey,
					publicationClaim,
					bindingRevision: bindReceipt.bindingRevision,
					bindingRenewalSequence: bindReceipt.renewalSequence,
					bindingReceiptSha256: bindReceipt.receiptSha256,
					bindingAuthoritySha256: bindReceipt.authoritySha256,
					bindingOpenRequestSha256: publicationClaim.bindingOpenRequestSha256,
					checkpoint,
					requestSha256: hex("b"),
					attemptSha256: shaRef("c"),
					publishedAt: NOW,
					receiptSha256: shaRef("d"),
				} satisfies TransientTaskWorktreePublicationReceiptV1)
			: null;
	const captureReceipt =
		outcome === "succeeded"
			? ({
					schemaVersion: 1,
					taskId,
					runId,
					capturePreparationId: "capture-preparation-1",
					captureId: "capture-1",
					preparationReceiptSha256: shaRef("e"),
					preparedContentSha256: shaRef("f"),
					effectIdentityManifest,
					planSha256: shaRef("1"),
					captureRequestSha256: hex("2"),
					captureRefState: {
						schemaVersion: 1,
						captureBranchRef: descriptor.captureBranchRef,
						expectedOldCaptureRefSha: "0".repeat(40),
						sourceKind: "isolation_creation",
						sourceReceiptSha256: authority.ensureRequest.preparation.ownershipClaimReceipt.receiptSha256,
						stateSha256: shaRef("3"),
					},
					captureRefStateSha256: shaRef("3"),
					captureMaterializationReceiptSha256: null,
					orderedSubeffectReceiptSha256s: [],
					fieldsSha256: shaRef("4"),
					resultErrorSha256: null,
					capturedAt: NOW,
					receiptSha256: shaRef("5"),
					outcome: "no_changes",
					fields: { kind: "none", patchPath: null, branchName: null, branchBaseSha: null, nestedPatches: null },
					resultError: null,
				} satisfies TransientTaskCaptureReceiptV1)
			: null;
	const isolationCleanupTerminalEvidence = {
		schemaVersion: 1,
		taskId,
		runId,
		isolationCleanupId: descriptor.isolationCleanupId,
		planSha256: shaRef("6"),
		cleanupRequestSha256: hex("7"),
		componentOrder: ["backend_stop", "directory_delete", "capture_ref_cas_delete", "ownership_claim_release"],
		componentOperationIds: ["cleanup-backend-1", "cleanup-directory-1", "cleanup-ref-1", "cleanup-claim-1"],
		orderedComponentReceiptSha256s: [shaRef("7"), shaRef("8"), shaRef("9"), shaRef("a")],
		backendStoppedOrNotApplicable: true,
		directoryAbsent: true,
		captureRefAbsentAfterExpectedOldCas: true,
		ownershipClaimReleasedLast: true,
		evidenceSha256: shaRef("b"),
	} satisfies TransientTaskIsolationCleanupTerminalEvidenceV1;
	if (outcome === "succeeded" && captureReceipt === null) {
		throw new Error("succeeded terminal evidence requires a capture receipt");
	}
	const isolationCleanupReceipt = {
		schemaVersion: 1,
		taskId,
		runId,
		isolationCleanupId: descriptor.isolationCleanupId,
		publicationTargetId: descriptor.publicationTargetId,
		publicationTargetKey,
		bindingAccess: "live",
		bindingRevision: bindReceipt.bindingRevision,
		bindingRenewalSequence: bindReceipt.renewalSequence,
		bindingReceiptSha256: bindReceipt.receiptSha256,
		bindingAuthoritySha256: bindReceipt.authoritySha256,
		bindingOpenRequestSha256: cleanupClaim.bindingOpenRequestSha256,
		cleanupDescriptorSha256: authority.cleanupDescriptor.cleanupDescriptorSha256,
		isolationNamespaceSha256: descriptor.namespaceSha256,
		isolationOwnerManifestSha256: descriptor.ownerManifestSha256,
		isolationCreatorDescriptorSha256: descriptor.creatorDescriptorSha256,
		cleanupClaim,
		planSha256: isolationCleanupTerminalEvidence.planSha256,
		cleanupRequestSha256: isolationCleanupTerminalEvidence.cleanupRequestSha256,
		cleanupAttemptSha256: shaRef("c"),
		terminalEvidence: isolationCleanupTerminalEvidence,
		terminalEvidenceSha256: isolationCleanupTerminalEvidence.evidenceSha256,
		cleanedAt: NOW,
		receiptSha256: shaRef("d"),
		...(outcome === "succeeded"
			? {
					cleanupKind: "after_capture" as const,
					captureId: captureReceipt!.captureId,
					captureReceiptSha256: captureReceipt!.receiptSha256,
				}
			: {
					cleanupKind: "non_success" as const,
					outcome: "failed" as const,
					pendingOutcomeSha256: shaRef("e"),
					canonicalProviderTerminalEvidenceSha256: shaRef("f"),
				}),
	} satisfies TransientTaskIsolationCleanupReceiptV1;
	const publicationTargetReleaseReceipt = {
		schemaVersion: 1,
		key: publicationTargetKey,
		isolationCleanupId: descriptor.isolationCleanupId,
		bindingOperationId: descriptor.bindingOperationId,
		state: "released",
		bindingAccess: "live",
		bindingRevision: bindReceipt.bindingRevision,
		renewalSequence: bindReceipt.renewalSequence,
		reason: "ordinary_isolation_cleanup",
		previousReceiptSha256: bindReceipt.receiptSha256,
		bindingAuthoritySha256: bindReceipt.authoritySha256,
		bindingOpenRequestSha256: cleanupClaim.bindingOpenRequestSha256,
		cleanupDescriptorSha256: authority.cleanupDescriptor.cleanupDescriptorSha256,
		cleanupClaimSha256: cleanupClaim.claimSha256,
		isolationCleanupReceiptSha256: isolationCleanupReceipt.receiptSha256,
		releaseRequestSha256: hex("1"),
		releasePlanSha256: shaRef("2"),
		authoritySha256: shaRef("3"),
		terminalAt: NOW,
		receiptSha256: shaRef("4"),
	} satisfies TransientTaskPublicationTargetReleaseReceiptV1;
	const publicationTargetBindingEvidence = {
		schemaVersion: 1,
		key: publicationTargetKey,
		isolationCleanupId: descriptor.isolationCleanupId,
		bindReceipt,
		renewalReceipts: [],
		effectAccess: "live",
		effectBindingRevision: bindReceipt.bindingRevision,
		effectBindingRenewalSequence: bindReceipt.renewalSequence,
		effectBindingReceiptSha256: bindReceipt.receiptSha256,
		effectBindingAuthoritySha256: bindReceipt.authoritySha256,
		effectBindingOpenRequestSha256: cleanupClaim.bindingOpenRequestSha256,
		cleanupDescriptorSha256: authority.cleanupDescriptor.cleanupDescriptorSha256,
		cleanupClaim,
		worktreePublicationReceiptSha256: worktreePublication?.receiptSha256 ?? null,
		cleanupDueReceipt: null,
		isolationCleanupReceipt,
		isolationCleanupReceiptSha256: isolationCleanupReceipt.receiptSha256,
		releasePlanSha256: publicationTargetReleaseReceipt.releasePlanSha256,
		terminalReceipt: publicationTargetReleaseReceipt,
		bindInspectStatuses: ["matching"],
		renewalInspectStatuses: [],
		releaseInspectStatuses: ["matching"],
		expiryInspectStatuses: [],
		bindAttemptSha256: shaRef("5"),
		renewalAttemptSha256s: [],
		releaseAttemptSha256: shaRef("6"),
		expiryAttemptSha256: null,
		adoptedAttemptSha256s: [],
		cleanupClaimSurvivedWallClockExpiry: true,
		publicPhysicalPathFieldCount: 0,
		publicBackendFieldCount: 0,
		publicPrivateRequestDigestFieldCount: 0,
		evidenceSha256: shaRef("7"),
	} satisfies TransientTaskPublicationTargetBindingEvidenceV1;
	const deletionAuthorization = {
		domain: "transient_task",
		taskId,
		runId,
		workspaceId: checkpoint.workspaceId,
		cleanupId: "cleanup-1",
		cleanupAuthorityId: "cleanup-authority-1",
		cleanupPlanSha256: shaRef("8"),
		finalCheckpoint: checkpoint,
		replicaDeleteRequestId: "replica-delete-request-1",
		replicaDeletionQuarantineId: "replica-quarantine-1",
		replicaDeletionPlannedAt: NOW,
		replicaDeletionPurgeAfter: NOW,
	} satisfies Extract<RuntimeReplicaDeletionAuthorizationV1, { domain: "transient_task" }>;
	const preparedReplicaDelete = {
		requestId: deletionAuthorization.replicaDeleteRequestId,
		requestSha256: hex("9"),
		replica,
		authorization: deletionAuthorization,
		preparedAt: NOW,
	} satisfies TransientTaskPreparedReplicaDeleteV1;
	const replicaDelete = {
		status: "absent",
		request: { requestId: preparedReplicaDelete.requestId, requestSha256: preparedReplicaDelete.requestSha256 },
		replica,
		authorization: deletionAuthorization,
		observedAt: NOW,
		retryAfter: null,
		receiptSha256: shaRef("a"),
	} satisfies RuntimeReplicaDeleteResult;
	const canonicalDiscard = {
		schemaVersion: 1,
		taskId,
		runId,
		workspaceId: checkpoint.workspaceId,
		cleanupId: deletionAuthorization.cleanupId,
		cleanupAuthorityId: deletionAuthorization.cleanupAuthorityId,
		canonicalDiscardId: "canonical-discard-1",
		finalCheckpoint: checkpoint,
		cleanupPlanSha256: deletionAuthorization.cleanupPlanSha256,
		discardedAt: NOW,
		receiptSha256: shaRef("b"),
	} satisfies TransientTaskCanonicalDiscardReceiptV1;
	const tombstone = {
		schemaVersion: 1,
		taskId,
		runId,
		workspaceId: checkpoint.workspaceId,
		cleanupId: deletionAuthorization.cleanupId,
		cleanupAuthorityId: deletionAuthorization.cleanupAuthorityId,
		terminalState: "discarded",
		finalCheckpoint: checkpoint,
		providerDeletionAuthorization: deletionAuthorization,
		planSha256: deletionAuthorization.cleanupPlanSha256,
		deletedAt: NOW,
	} satisfies TransientTaskWorkspaceTombstoneV1;
	const canonicalProviderTerminalEvidence = {
		schemaVersion: 1,
		taskId,
		runId,
		postTerminalCleanupEvidenceId: "terminal-evidence-1",
		cleanupId: deletionAuthorization.cleanupId,
		cleanupAuthorityId: deletionAuthorization.cleanupAuthorityId,
		workspaceId: checkpoint.workspaceId,
		resultPublicationId: "result-publication-1",
		publicationTargetId: descriptor.publicationTargetId,
		publicationTargetKey,
		isolationCleanupId: descriptor.isolationCleanupId,
		worktreePublicationId: descriptor.worktreePublicationId,
		effectIdentityManifestSha256: descriptor.effectIdentityManifestSha256,
		isolationNamespaceSha256: descriptor.namespaceSha256,
		isolationOwnerManifestSha256: descriptor.ownerManifestSha256,
		isolationCreatorDescriptorSha256: descriptor.creatorDescriptorSha256,
		worktreePublicationUse: outcome === "succeeded" ? "published" : "unused_non_success",
		worktreePublicationAttemptSha256: worktreePublication?.attemptSha256 ?? null,
		worktreePublication,
		resultPublicationTargetId: "result-target-1",
		pendingPayloadId: "pending-payload-1",
		pendingPayloadDeleteId: "pending-payload-delete-1",
		composedPayloadId: "composed-payload-1",
		composedPayloadDeleteId: "composed-payload-delete-1",
		pendingOutcomeSha256: shaRef("c"),
		outcome,
		branch,
		planSha256: deletionAuthorization.cleanupPlanSha256,
		canonicalCommit: null,
		checkpointAcknowledgement: null,
		release: runtimeRelease,
		preparedReplicaDelete,
		replicaDelete,
		canonicalDiscard,
		tombstone,
		terminalAt: NOW,
		evidenceSha256: shaRef("d"),
	} satisfies TransientTaskCanonicalProviderTerminalEvidenceV1;
	const base = {
		schemaVersion: 1 as const,
		taskId,
		runId,
		evidenceId: canonicalProviderTerminalEvidence.postTerminalCleanupEvidenceId,
		cleanupId: deletionAuthorization.cleanupId,
		cleanupAuthorityId: deletionAuthorization.cleanupAuthorityId,
		workspaceId: checkpoint.workspaceId,
		resultPublicationId: canonicalProviderTerminalEvidence.resultPublicationId,
		publicationTargetId: descriptor.publicationTargetId,
		publicationTargetKey,
		isolationCleanupId: descriptor.isolationCleanupId,
		worktreePublicationId: descriptor.worktreePublicationId,
		effectIdentityManifestSha256: descriptor.effectIdentityManifestSha256,
		isolationNamespaceSha256: descriptor.namespaceSha256,
		isolationOwnerManifestSha256: descriptor.ownerManifestSha256,
		isolationCreatorDescriptorSha256: descriptor.creatorDescriptorSha256,
		worktreePublicationUse: canonicalProviderTerminalEvidence.worktreePublicationUse,
		worktreePublicationAttemptSha256: canonicalProviderTerminalEvidence.worktreePublicationAttemptSha256,
		worktreePublication,
		canonicalProviderTerminalEvidence,
		canonicalProviderTerminalEvidenceSha256: canonicalProviderTerminalEvidence.evidenceSha256,
		physicalCleanupBindingAccess: "live" as const,
		physicalCleanupBindingRevision: bindReceipt.bindingRevision,
		physicalCleanupBindingRenewalSequence: bindReceipt.renewalSequence,
		physicalCleanupBindingReceiptSha256: bindReceipt.receiptSha256,
		physicalCleanupBindingAuthoritySha256: bindReceipt.authoritySha256,
		physicalCleanupBindingOpenRequestSha256: cleanupClaim.bindingOpenRequestSha256,
		cleanupDescriptorSha256: authority.cleanupDescriptor.cleanupDescriptorSha256,
		cleanupClaim,
		isolationCleanupReceipt,
		isolationCleanupTerminalEvidence,
		isolationCleanupTerminalEvidenceSha256: isolationCleanupTerminalEvidence.evidenceSha256,
		publicationTargetReleaseReceipt,
		publicationTargetBindingEvidence,
		publicationTargetBindingEvidenceSha256: publicationTargetBindingEvidence.evidenceSha256,
		resultPublicationTargetId: canonicalProviderTerminalEvidence.resultPublicationTargetId,
		pendingPayloadId: canonicalProviderTerminalEvidence.pendingPayloadId,
		pendingPayloadDeleteId: canonicalProviderTerminalEvidence.pendingPayloadDeleteId,
		composedPayloadId: canonicalProviderTerminalEvidence.composedPayloadId,
		composedPayloadDeleteId: canonicalProviderTerminalEvidence.composedPayloadDeleteId,
		pendingOutcomeSha256: canonicalProviderTerminalEvidence.pendingOutcomeSha256,
		branch,
		planSha256: deletionAuthorization.cleanupPlanSha256,
		canonicalCommit: null,
		checkpointAcknowledgement: null,
		release: runtimeRelease,
		preparedReplicaDelete,
		replicaDelete,
		canonicalDiscard,
		tombstone,
		completedAt: NOW,
		evidenceSha256: shaRef("e"),
	};
	if (outcome === "succeeded") {
		return {
			...base,
			outcome,
			captureReceipt: captureReceipt!,
			captureReceiptSha256: captureReceipt!.receiptSha256,
		} satisfies TransientTaskPostTerminalCleanupEvidenceV1;
	}
	return {
		...base,
		outcome,
		captureReceipt: null,
		captureReceiptSha256: null,
	} satisfies TransientTaskPostTerminalCleanupEvidenceV1;
}

type LifecycleOptions = {
	readonly outcome?: "succeeded" | "failed";
	readonly mergeSummary?: string;
	readonly changesApplied?: boolean | null;
	readonly capture?: boolean;
	readonly finalizeError?: unknown;
	readonly releaseError?: unknown;
};

async function lifecycleHarness(
	events: string[],
	preflight: TransientTaskResultlessRepresentabilityPreflightV1,
	options: LifecycleOptions = {},
) {
	const authority = await isolationAuthority(events);
	const outcome = options.outcome ?? "succeeded";
	const terminalEvidence = terminalEvidenceFixture(authority, outcome);
	const failureEvidence = terminalEvidenceFixture(authority, "failed");
	const pending = pendingOutcomeFixture(authority, outcome);
	const fail = vi.fn<TransientTaskIsolationLifecycleAdapterV1["fail"]>(
		async (input: OrdinaryTransientTaskLifecycleFailureInputV1) => {
			events.push("cleanup");
			const terminalSource =
				input.phase === "bound"
					? input.projection
					: executorModule.projectTransientTaskResultlessSourceV1(preflight, "failed", input.source);
			return {
				terminalSource,
				mergeSummary: "Lifecycle failure cleaned task isolation",
				changesApplied: false,
				terminalEvidence: failureEvidence,
			};
		},
	);
	const finalized = vi.fn<TransientTaskIsolationLifecycleAdapterV1["finalized"]>(async input => {
		events.push("finalized");
		expect(input.classification.outcome).toBe(outcome);
		return pending;
	});
	const isolationReady = vi.fn<TransientTaskIsolationLifecycleAdapterV1["isolationReady"]>(async cleanupDescriptor => {
		events.push("bind");
		expect(cleanupDescriptor).toBe(authority.cleanupDescriptor);
		return authority.bound;
	});
	const releaseExecutionEnvironment = vi.fn<TransientTaskIsolationLifecycleAdapterV1["releaseExecutionEnvironment"]>(
		async releaseAuthority => {
			events.push("release");
			if (options.releaseError !== undefined) throw options.releaseError;
			try {
				const receipt = await reconcileExecutionEnvironmentRuntimeReleaseV1(releaseAuthority);
				return { status: "released", receipt };
			} catch (error) {
				if (error instanceof ExecutionEnvironmentReleaseIndeterminateErrorV1)
					return { status: "release_outcome_unknown", request: releaseAuthority.request };
				throw error;
			}
		},
	);
	const finalizeAfterPending = vi.fn<TransientTaskIsolationLifecycleAdapterV1["finalizeAfterPending"]>(
		async input => {
			expect(input.cleanupDescriptor).toBe(authority.cleanupDescriptor);
			expect(input.pending).toBe(pending);
			let releaseBarrier: OrdinaryTransientTaskExecutionEnvironmentReleaseBarrierV1 = {
				status: "not_applicable",
			};
			if (input.executionEnvironment.kind === "sync_then_release") {
				try {
					await input.executionEnvironment.syncBack();
				} catch (error) {
					await releaseExecutionEnvironment(input.executionEnvironment.releaseAuthority);
					throw error;
				}
			}
			if (input.executionEnvironment.kind !== "not_applicable") {
				releaseBarrier = await releaseExecutionEnvironment(input.executionEnvironment.releaseAuthority);
			}
			if (options.capture !== false) events.push("capture");
			if (options.finalizeError !== undefined) throw options.finalizeError;
			events.push("cleanup", "merge");
			return {
				releaseBarrier,
				mergeSummary: options.mergeSummary ?? "Captured and applied task changes",
				changesApplied: options.changesApplied === undefined ? true : options.changesApplied,
				terminalEvidence,
			};
		},
	);
	const lifecycle = {
		taskId: authority.taskId,
		runId: authority.runId,
		materializer: authority.materializer,
		ensureRequest: authority.ensureRequest,
		fail,
		finalized,
		isolationReady,
		releaseExecutionEnvironment,
		finalizeAfterPending,
	} satisfies TransientTaskIsolationLifecycleAdapterV1;

	return {
		...authority,
		lifecycle,
		fail,
		finalized,
		isolationReady,
		releaseExecutionEnvironment,
		finalizeAfterPending,
		terminalEvidence,
		failureEvidence,
	};
}

type EnvironmentBehavior = {
	readonly acquireError?: unknown;
	readonly syncError?: unknown;
	readonly leaseId?: string;
};

async function fakeEnvironment(events: string[], isolationDir: string, behavior: EnvironmentBehavior = {}) {
	const replica = {
		providerId: "provider-1",
		profileId: "profile-1",
		replicaId: "replica-1",
		workspaceId: "workspace-1",
	};
	const leaseRef = {
		leaseId: behavior.leaseId ?? "lease-1",
		replica,
		fenceId: "fence-1",
		baseGeneration: 0,
		renewalSequence: 0,
		acquiredAt: NOW,
		renewBy: RENEW_BY,
		expiresAt: EXPIRES_AT,
	};
	const releaseRequestTemplate = {
		requestId: hex("0"),
		requestSha256: hex("0"),
		parentOperationId: "release-parent-1",
		replica,
		leaseId: leaseRef.leaseId,
	};
	const releaseRequest = {
		...releaseRequestTemplate,
		requestSha256: await canonicalRuntimeProviderInspectionSha256V1({
			operation: "release",
			request: releaseRequestTemplate,
		}),
	};
	const releaseReceipt = {
		status: "released",
		request: {
			requestId: releaseRequest.requestId,
			requestSha256: releaseRequest.requestSha256,
			parentOperationId: releaseRequest.parentOperationId,
		},
		replica,
		leaseId: leaseRef.leaseId,
		compute: "stopped",
	} satisfies RuntimeLeaseReleaseResult;
	const providerRelease = vi.fn<ExecutionEnvironmentReleaseProviderV1["release"]>(async request => {
		events.push("provider-release");
		expect(request).toEqual(releaseRequest);
		return releaseReceipt;
	});
	const inspectRelease = vi.fn<ExecutionEnvironmentReleaseProviderV1["inspectRelease"]>(async _request => ({
		status: "complete",
		result: releaseReceipt,
	}));
	const releaseAuthority = await freezeExecutionEnvironmentRuntimeReleaseAuthorityV1({
		provider: { id: replica.providerId, release: providerRelease, inspectRelease },
		lease: leaseRef,
		fence: { fenceId: leaseRef.fenceId, token: "fence-token-1" },
		request: releaseRequest,
	});
	const syncBack = vi.fn<ExecutionEnvironmentLease["syncBack"]>(async () => {
		events.push("sync");
		if (behavior.syncError !== undefined) throw behavior.syncError;
	});
	const release = vi.fn<ExecutionEnvironmentLease["release"]>(() =>
		reconcileExecutionEnvironmentRuntimeReleaseV1(releaseAuthority),
	);
	const lease: ExecutionEnvironmentLease = {
		id: leaseRef.leaseId,
		sourceRoot: isolationDir,
		remoteRoot: "/workspace",
		bridge: {
			readTextFile: async () => "",
			writeTextFile: async () => {},
			createTerminal: async () => {
				throw new Error("Unused fake terminal");
			},
		},
		releaseAuthority,
		syncBack,
		release,
	};
	const acquire = vi.fn<ExecutionEnvironmentProvider["acquire"]>(async () => {
		events.push("acquire");
		if (behavior.acquireError !== undefined) throw behavior.acquireError;
		return lease;
	});

	return {
		provider: { acquire },
		lease,
		acquire,
		syncBack,
		release,
		releaseAuthority,
		releaseReceipt,
		providerRelease,
		inspectRelease,
	};
}

function runOptions(
	lifecycle: TransientTaskIsolationLifecycleAdapterV1,
	preflight: TransientTaskResultlessRepresentabilityPreflightV1,
	executionEnvironmentProvider?: ExecutionEnvironmentProvider,
	overrides: Partial<IsolatedRunOptions["baseOptions"]> = {},
): IsolatedRunOptions {
	return {
		baseOptions: {
			cwd: "/repo",
			agent: {
				name: "task",
				description: "Task agent",
				systemPrompt: "test",
				source: "bundled",
			},
			task: "Do environment work",
			index: 0,
			id: "EnvironmentTask",
			parentAgentId: "OwnerAgent",
			...overrides,
		},
		lifecycle,
		resultlessRepresentabilityPreflight: preflight,
		outcomePayloadBudget: createTransientTaskOutcomePayloadByteBudgetV1({
			preflight,
			agentSource: "bundled",
			task: "Do environment work",
			assignment: "Do environment work",
		}),
		...(executionEnvironmentProvider ? { executionEnvironmentProvider } : {}),
	};
}

type ResultSettlement = Extract<TransientTaskIsolationSettlementV1, { readonly result: SingleResult }>;
type ResultlessSettlement = Extract<TransientTaskIsolationSettlementV1, { readonly result: null }>;

function expectResultSettlement(
	settlement: TransientTaskIsolationSettlementV1,
): asserts settlement is ResultSettlement {
	expect(settlement.result).not.toBeNull();
	if (settlement.result === null) throw new Error("Expected a SingleResult settlement");
}

function expectResultlessSettlement(
	settlement: TransientTaskIsolationSettlementV1,
): asserts settlement is ResultlessSettlement {
	expect(settlement.result).toBeNull();
	if (settlement.result !== null) throw new Error("Expected a resultless settlement");
}

describe("runIsolatedSubprocess", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("orders materialization, binding, child quiescence, runtime release, capture, cleanup, and merge", async () => {
		const events: string[] = [];
		const preflight = resultlessPreflight();
		const lifecycle = await lifecycleHarness(events, preflight);
		const environment = await fakeEnvironment(events, lifecycle.cleanupDescriptor.mergedDir);
		const signal = new AbortController().signal;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			events.push("child");
			expect(options.worktree).toBe(lifecycle.cleanupDescriptor.mergedDir);
			expect(options.preloadedExtensionPaths).toBeUndefined();
			expect(options.preloadedCustomToolPaths).toBeUndefined();
			expect(options.executionEnvironment).toEqual({
				id: environment.lease.id,
				sourceRoot: environment.lease.sourceRoot,
				remoteRoot: environment.lease.remoteRoot,
				bridge: environment.lease.bridge,
			});
			expect(options.executionEnvironment).not.toBe(environment.lease);
			expect(options.executionEnvironment).not.toHaveProperty("syncBack");
			expect(options.executionEnvironment).not.toHaveProperty("releaseAuthority");
			events.push("quiescence");
			return result();
		});

		const settlement = await runIsolatedSubprocess(
			runOptions(lifecycle.lifecycle, preflight, environment.provider, { signal }),
		);

		expect(events).toEqual([
			"materialize",
			"bind",
			"acquire",
			"child",
			"quiescence",
			"sync",
			"release",
			"provider-release",
			"finalized",
			"capture",
			"cleanup",
			"merge",
		]);
		expect(environment.acquire).toHaveBeenCalledWith({
			taskId: lifecycle.taskId,
			runId: lifecycle.runId,
			sourceRoot: lifecycle.cleanupDescriptor.mergedDir,
			signal,
		});
		expect(environment.syncBack).toHaveBeenCalledWith(signal);
		expect(lifecycle.releaseExecutionEnvironment).toHaveBeenCalledWith(environment.releaseAuthority);
		expect(environment.providerRelease).toHaveBeenCalledWith(environment.releaseAuthority.request);
		expect(environment.release).not.toHaveBeenCalled();
		expect(lifecycle.finalizeAfterPending).toHaveBeenCalledWith({
			cleanupDescriptor: lifecycle.cleanupDescriptor,
			pending: expect.anything(),
			executionEnvironment: expect.objectContaining({ kind: "sync_then_release" }),
		});
		expectResultSettlement(settlement);
		expect(settlement.result.exitCode).toBe(0);
		expect(settlement).not.toHaveProperty("terminalProjection");
		expect(settlement.terminalEvidence).toBe(lifecycle.terminalEvidence);
		expect(settlement.terminalEvidence.outcome).toBe("succeeded");
		expect(settlement.mergeSummary).toBe("Captured and applied task changes");
		expect(settlement.changesApplied).toBe(true);
	});

	it("settles a materialization rejection before binding without starting the child", async () => {
		const events: string[] = [];
		const preflight = resultlessPreflight();
		const lifecycle = await lifecycleHarness(events, preflight);
		lifecycle.materialize.mockImplementation(async request => {
			events.push("materialize");
			expect(request).toBe(lifecycle.ensureRequest);
			return { status: "blocked", code: "directory_unowned" };
		});
		const child = vi.spyOn(executorModule, "runSubprocess");

		const settlement = await runIsolatedSubprocess(runOptions(lifecycle.lifecycle, preflight));

		expect(events).toEqual(["materialize", "cleanup"]);
		expect(child).not.toHaveBeenCalled();
		expect(lifecycle.materialize).toHaveBeenCalledWith(lifecycle.ensureRequest);
		expect(lifecycle.isolationReady).not.toHaveBeenCalled();
		expect(lifecycle.fail).toHaveBeenCalledWith({
			phase: "before_bind",
			source: { kind: "caught_value", caughtAt: "runtime", value: expect.any(Error) },
		});
		expectResultlessSettlement(settlement);
		expect(settlement.terminalProjection.status).toBe("projected");
		expect(settlement.error).toBeInstanceOf(Error);
		expect(String(settlement.error)).toContain("blocked/directory_unowned");
		expect(settlement.terminalEvidence).toBe(lifecycle.failureEvidence);
		expect(settlement.terminalEvidence.outcome).toBe("failed");
		expect(settlement.mergeSummary).toBe("Lifecycle failure cleaned task isolation");
		expect(settlement.changesApplied).toBe(false);
	});

	it("does not start the child or release when acquisition fails before returning a lease", async () => {
		const events: string[] = [];
		const preflight = resultlessPreflight();
		const lifecycle = await lifecycleHarness(events, preflight);
		const acquireError = new Error("acquire failed");
		const environment = await fakeEnvironment(events, lifecycle.cleanupDescriptor.mergedDir, { acquireError });
		const child = vi.spyOn(executorModule, "runSubprocess");

		const settlement = await runIsolatedSubprocess(runOptions(lifecycle.lifecycle, preflight, environment.provider));

		expect(events).toEqual(["materialize", "bind", "acquire", "cleanup"]);
		expect(child).not.toHaveBeenCalled();
		expect(environment.syncBack).not.toHaveBeenCalled();
		expect(lifecycle.releaseExecutionEnvironment).not.toHaveBeenCalled();
		expect(environment.providerRelease).not.toHaveBeenCalled();
		expect(lifecycle.finalized).not.toHaveBeenCalled();
		expectResultlessSettlement(settlement);
		expect(settlement.error).toBe(acquireError);
		expect(settlement.terminalProjection.document.terminalOutcome).toBe("failed");
		expect(settlement.terminalEvidence).toBe(lifecycle.failureEvidence);
		expect(settlement.changesApplied).toBe(false);
	});

	it("releases through lifecycle authority once when child startup throws", async () => {
		const events: string[] = [];
		const preflight = resultlessPreflight();
		const lifecycle = await lifecycleHarness(events, preflight);
		const environment = await fakeEnvironment(events, lifecycle.cleanupDescriptor.mergedDir);
		const startupError = new Error("session start failed");
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			events.push("child");
			throw startupError;
		});

		const settlement = await runIsolatedSubprocess(runOptions(lifecycle.lifecycle, preflight, environment.provider));

		expect(events).toEqual(["materialize", "bind", "acquire", "child", "release", "provider-release", "cleanup"]);
		expect(environment.syncBack).not.toHaveBeenCalled();
		expect(lifecycle.releaseExecutionEnvironment).toHaveBeenCalledTimes(1);
		expect(environment.providerRelease).toHaveBeenCalledTimes(1);
		expect(environment.release).not.toHaveBeenCalled();
		expect(lifecycle.finalized).not.toHaveBeenCalled();
		expectResultlessSettlement(settlement);
		expect(settlement.error).toBe(startupError);
		expect(settlement.terminalProjection.document.terminalOutcome).toBe("failed");
	});

	it("skips sync, releases, and finalizes a child failure without capture", async () => {
		const events: string[] = [];
		const preflight = resultlessPreflight();
		const lifecycle = await lifecycleHarness(events, preflight, {
			outcome: "failed",
			capture: false,
			mergeSummary: "Child failed; no changes captured",
			changesApplied: false,
		});
		const environment = await fakeEnvironment(events, lifecycle.cleanupDescriptor.mergedDir);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			events.push("child", "quiescence");
			return result({ error: "child failed" });
		});

		const settlement = await runIsolatedSubprocess(runOptions(lifecycle.lifecycle, preflight, environment.provider));

		expect(events).toEqual([
			"materialize",
			"bind",
			"acquire",
			"child",
			"quiescence",
			"release",
			"provider-release",
			"finalized",
			"cleanup",
			"merge",
		]);
		expect(environment.syncBack).not.toHaveBeenCalled();
		expect(lifecycle.releaseExecutionEnvironment).toHaveBeenCalledTimes(1);
		expectResultSettlement(settlement);
		expect(settlement.result.error).toBe("child failed");
		expect(settlement).not.toHaveProperty("terminalProjection");
		expect(settlement.terminalEvidence).toBe(lifecycle.terminalEvidence);
		expect(settlement.terminalEvidence.outcome).toBe("failed");
		expect(settlement.mergeSummary).toBe("Child failed; no changes captured");
		expect(settlement.changesApplied).toBe(false);
	});

	it("skips sync and marks a successful child result failed when aborted before capture", async () => {
		const events: string[] = [];
		const preflight = resultlessPreflight();
		const lifecycle = await lifecycleHarness(events, preflight, {
			outcome: "failed",
			capture: false,
			mergeSummary: "Cancelled before capture",
			changesApplied: false,
		});
		const environment = await fakeEnvironment(events, lifecycle.cleanupDescriptor.mergedDir);
		const controller = new AbortController();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			events.push("child");
			controller.abort();
			events.push("quiescence");
			return result();
		});

		const settlement = await runIsolatedSubprocess(
			runOptions(lifecycle.lifecycle, preflight, environment.provider, { signal: controller.signal }),
		);

		expect(events).toEqual([
			"materialize",
			"bind",
			"acquire",
			"child",
			"quiescence",
			"release",
			"provider-release",
			"finalized",
			"cleanup",
			"merge",
		]);
		expect(environment.syncBack).not.toHaveBeenCalled();
		expectResultSettlement(settlement);
		expect(settlement.result.aborted).toBe(true);
		expect(settlement.result.exitCode).toBe(1);
		expect(settlement.result.error).toContain("cancelled before capture");
		expect(settlement.terminalEvidence.outcome).toBe("failed");
		expect(settlement.changesApplied).toBe(false);
	});

	it("releases and blocks capture when sync-back fails", async () => {
		const events: string[] = [];
		const preflight = resultlessPreflight();
		const lifecycle = await lifecycleHarness(events, preflight, {
			outcome: "failed",
			capture: false,
			mergeSummary: "Sync failed; no changes captured",
			changesApplied: false,
		});
		const environment = await fakeEnvironment(events, lifecycle.cleanupDescriptor.mergedDir, {
			syncError: new Error("manifest rejected"),
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			events.push("child", "quiescence");
			return result();
		});

		const settlement = await runIsolatedSubprocess(runOptions(lifecycle.lifecycle, preflight, environment.provider));

		expect(events).toEqual([
			"materialize",
			"bind",
			"acquire",
			"child",
			"quiescence",
			"sync",
			"release",
			"provider-release",
			"finalized",
			"cleanup",
			"merge",
		]);
		expect(lifecycle.releaseExecutionEnvironment).toHaveBeenCalledTimes(1);
		expectResultSettlement(settlement);
		expect(settlement.result.exitCode).toBe(1);
		expect(settlement.result.error).toContain("sync-back failed");
		expect(settlement.result.error).toContain("manifest rejected");
		expect(settlement.result.patchPath).toBeUndefined();
		expect(settlement.result.branchName).toBeUndefined();
		expect(settlement.result.nestedPatches).toBeUndefined();
		expect(settlement.terminalEvidence.outcome).toBe("failed");
		expect(settlement.mergeSummary).toBe("Sync failed; no changes captured");
		expect(settlement.changesApplied).toBe(false);
	});

	it("settles through failure without leaking the lease ID when lifecycle release throws", async () => {
		const events: string[] = [];
		const preflight = resultlessPreflight();
		const releaseError = new Error("release row write failed");
		const lifecycle = await lifecycleHarness(events, preflight, { releaseError });
		const leaseId = "lease-unsafe\nvalue";
		const environment = await fakeEnvironment(events, lifecycle.cleanupDescriptor.mergedDir, { leaseId });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			events.push("child", "quiescence");
			return result();
		});

		const settlement = await runIsolatedSubprocess(runOptions(lifecycle.lifecycle, preflight, environment.provider));

		expect(events).toEqual(["materialize", "bind", "acquire", "child", "quiescence", "sync", "release", "cleanup"]);
		expect(lifecycle.releaseExecutionEnvironment).toHaveBeenCalledTimes(1);
		expect(environment.providerRelease).not.toHaveBeenCalled();
		expect(lifecycle.finalized).not.toHaveBeenCalled();
		expectResultlessSettlement(settlement);
		expect(settlement.error).toBe(releaseError);
		expect(String(settlement.error)).not.toContain(leaseId);
		expect(settlement.terminalProjection.document.terminalOutcome).toBe("failed");
		expect(settlement.terminalEvidence).toBe(lifecycle.failureEvidence);
		expect(settlement.changesApplied).toBe(false);
	});

	it("projects nested changes to lifecycle capture and exposes the canonical settlement summary", async () => {
		const events: string[] = [];
		const preflight = resultlessPreflight();
		const lifecycle = await lifecycleHarness(events, preflight, {
			mergeSummary: "Root capture empty; nested repository patches captured and applied",
			changesApplied: true,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(
			result({ nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }] }),
		);

		const settlement = await runIsolatedSubprocess(runOptions(lifecycle.lifecycle, preflight));

		const finalizedInput = lifecycle.finalized.mock.calls[0]?.[0];
		expect(finalizedInput?.projection.status).toBe("projected");
		if (finalizedInput?.projection.status !== "projected") throw new Error("Expected projected SingleResult");
		expect(finalizedInput.projection.document.singleResult.nestedPatches).toEqual([
			{ relativePath: "nested", patch: "diff --git a/file b/file\n" },
		]);
		expect(finalizedInput.classification).toEqual({ outcome: "succeeded", classification: "child_completion" });
		expectResultSettlement(settlement);
		expect(settlement.result.nestedPatches).toEqual([
			{ relativePath: "nested", patch: "diff --git a/file b/file\n" },
		]);
		expect(settlement.terminalEvidence.outcome).toBe("succeeded");
		expect(settlement.mergeSummary).toContain("nested repository patches captured and applied");
		expect(settlement.changesApplied).toBe(true);
	});

	it("routes capture finalization failure through the bound lifecycle without releasing twice", async () => {
		const events: string[] = [];
		const preflight = resultlessPreflight();
		const captureError = new Error("capture object import failed");
		const lifecycle = await lifecycleHarness(events, preflight, { finalizeError: captureError });
		const environment = await fakeEnvironment(events, lifecycle.cleanupDescriptor.mergedDir);
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result());

		const settlement = await runIsolatedSubprocess(runOptions(lifecycle.lifecycle, preflight, environment.provider));

		expect(events).toEqual([
			"materialize",
			"bind",
			"acquire",
			"sync",
			"release",
			"provider-release",
			"finalized",
			"capture",
			"cleanup",
		]);
		expect(lifecycle.releaseExecutionEnvironment).toHaveBeenCalledTimes(1);
		expect(environment.providerRelease).toHaveBeenCalledTimes(1);
		expect(lifecycle.fail).toHaveBeenCalledWith({
			phase: "bound",
			projection: expect.objectContaining({ status: "projected" }),
			cleanupDescriptor: lifecycle.cleanupDescriptor,
			releaseBarrier: { status: "released", receipt: environment.releaseReceipt },
		});
		expectResultlessSettlement(settlement);
		expect(settlement.error).toBe(captureError);
		expect(settlement.terminalProjection.document.terminalOutcome).toBe("failed");
		expect(settlement.terminalEvidence).toBe(lifecycle.failureEvidence);
		expect(settlement.mergeSummary).toBe("Lifecycle failure cleaned task isolation");
		expect(settlement.changesApplied).toBe(false);
	});
});
