import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isProxy } from "node:util/types";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type {
	ISO8601,
	OperationId,
	PersistentAgentOwnership,
	Sha256Hex,
	Sha256Ref,
	WorkspaceCheckpoint,
	WorkspaceId,
} from "../registry/persistent-agent-contracts.js";
import { validateAndProjectTransientTaskForegroundSourceAgentToolResultV1 } from "../task/types.js";
import type { PackageInternalNativeTransientTaskIsolationOwnershipClaimInspectionV1 } from "../task/worktree.js";
import type {
	CanonicalRuntimeValue,
	CanonicalWorkspaceCommitReceipt,
	CanonicalWorkspaceStore,
	ConfidentialAgentSessionToolResultPersistenceTicketInputV1,
	ConfidentialAgentSessionToolResultSerializerKeyV1,
	ConfidentialAgentSessionToolResultSerializerQueueStateV1,
	ConfidentialAgentSessionToolResultTicketAllocationReceiptV1,
	ConfidentialAgentSessionToolResultTicketAllocationRequestV1,
	ConfidentialAgentSessionToolResultTicketAllocationResultV1,
	ConfidentialAgentSessionTransientTaskLifecycleAuthorityV1,
	ConfidentialAsyncJobTransientTaskRecoveryIndexEntryV1,
	ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1,
	ConfidentialAsyncJobTransientTaskRecoveryRecordV1,
	ConfidentialAsyncJobTransientTaskRecoveryWriteReceiptV1,
	ConfidentialTransientTaskDetachedPrimarySessionAppendRequestV1,
	ConfidentialTransientTaskDetachedPrimarySessionPersistenceReceiptV1,
	ConfidentialTransientTaskDetachedSettlementAttemptV1,
	ConfidentialTransientTaskDetachedSettlementCurrentAuthorityV1,
	ConfidentialTransientTaskDetachedSettlementOperationReceiptV1,
	ConfidentialTransientTaskDetachedSettlementRequestV1,
	ConfidentialTransientTaskDetachedSettlementReservationReceiptV1,
	ConfidentialTransientTaskDetachedSettlementTerminalReceiptV1,
	ConfidentialTransientTaskEnsureIsolationRequestV1,
	ConfidentialTransientTaskForegroundAppendDeliveryBatchInspectRequestV1,
	ConfidentialTransientTaskForegroundAppendDeliveryBatchInspectResultV1,
	ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayAdoptRequestV1,
	ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayAdoptResultV1,
	ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayProofV1,
	ConfidentialTransientTaskForegroundAppendDeliveryBatchRequestV1,
	ConfidentialTransientTaskForegroundAppendDeliveryBatchTransitionReceiptV1,
	ConfidentialTransientTaskForegroundSessionAppendInspectRequestV1,
	ConfidentialTransientTaskForegroundSessionAppendReceiptV1,
	ConfidentialTransientTaskForegroundTtsrInjectionContentPlanV1,
	ConfidentialTransientTaskForegroundTtsrOverlayCommitReceiptV1,
	ConfidentialTransientTaskHubSendAwaitOutboundPlanV1,
	ConfidentialTransientTaskHubSendAwaitOutboundReceiptV1,
	ConfidentialTransientTaskHubSendAwaitOutboundStateV1,
	ConfidentialTransientTaskHubSendAwaitSelectedReplyAgentToolResultV1,
	ConfidentialTransientTaskHubWaitConsumedMessageV1,
	ConfidentialTransientTaskHubWaitMessageCurrentParentSessionAuthorityV1,
	ConfidentialTransientTaskHubWaitMessageOrdinaryPersistenceTicketV1,
	ConfidentialTransientTaskHubWaitMessagePostHookFinalizationV1,
	ConfidentialTransientTaskHubWaitMessagePreselectionAdoptionReceiptV1,
	ConfidentialTransientTaskHubWaitMessagePreselectionClaimV1,
	ConfidentialTransientTaskHubWaitMessagePrimaryCommitJoinV1,
	ConfidentialTransientTaskHubWaitMessageRetiredPlanAdoptionReceiptV1,
	ConfidentialTransientTaskHubWaitMessageReturnAcknowledgementReceiptV1,
	ConfidentialTransientTaskHubWaitMessageReturnAcknowledgementRequestV1,
	ConfidentialTransientTaskHubWaitMessageReturnDeliveryReceiptV1,
	ConfidentialTransientTaskHubWaitMessageReturnDeliveryRequestV1,
	ConfidentialTransientTaskHubWaitMessageReturnResultV1,
	ConfidentialTransientTaskHubWaitMessageReturnTargetRegistrationReceiptV1,
	ConfidentialTransientTaskHubWaitMessageReturnTargetRetirementReceiptV1,
	ConfidentialTransientTaskHubWaitMessageReturnTargetV1,
	ConfidentialTransientTaskHubWaitMessageSelectionResumePlanV1,
	ConfidentialTransientTaskHubWaitMessageSelectorInstallRequestV1,
	ConfidentialTransientTaskHubWaitMessageSerializerHeadCommitReceiptV1,
	ConfidentialTransientTaskHubWaitMessageWinnerAuthoritativeAbsenceReceiptV1,
	ConfidentialTransientTaskHubWaitMessageWinnerCompletionReceiptV1,
	ConfidentialTransientTaskHubWaitMessageWinnerContinuationV1,
	ConfidentialTransientTaskHubWaitSelectedMessageAgentToolResultV1,
	ConfidentialTransientTaskIsolationCleanupDescriptorV1,
	ConfidentialTransientTaskIsolationCreatorDescriptorV1,
	ConfidentialTransientTaskIsolationOwnerLivenessEvidenceV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1,
	ConfidentialTransientTaskIsolationOwnershipClaimV1,
	ConfidentialTransientTaskIsolationPreparingAuthorityV1,
	ConfidentialTransientTaskIsolationReadyToBindReceiptV1,
	ConfidentialTransientTaskOutcomePayloadAttemptV1,
	ConfidentialTransientTaskOutcomePayloadStoreStateV1,
	ConfidentialTransientTaskParentResultDeliveryAttemptV1,
	ConfidentialTransientTaskParentResultDeliveryRequestV1,
	ConfidentialTransientTaskParentResultNonDeliveryReceiptV1,
	ConfidentialTransientTaskPendingCaptureIndexKeyV1,
	ConfidentialTransientTaskPendingCaptureRecordV1,
	ConfidentialTransientTaskPendingCaptureStartedReceiptV1,
	ConfidentialTransientTaskPublicationTargetActiveAttemptV1,
	ConfidentialTransientTaskPublicationTargetBindAttemptV1,
	ConfidentialTransientTaskPublicationTargetExpiryAttemptV1,
	ConfidentialTransientTaskPublicationTargetReleaseAttemptV1,
	ConfidentialTransientTaskPublicationTargetRenewalAttemptV1,
	ConfidentialTransientTaskResultPublicationBindingV1,
	ConfidentialTransientTaskResultPublicationTargetAuthorityV1,
	ConfidentialTransientTaskResultPublicationTargetBindingAttemptV1,
	ConfidentialTransientTaskResultPublicationTargetCleanupAttemptV1,
	ConfidentialTransientTaskResultPublicationTargetRenewalAttemptV1,
	ConfidentialTransientTaskSourceObservationAcceptedRowV1,
	ConfidentialTransientTaskSourceObservationDraftReceiptV1,
	ConfidentialTransientTaskSourceObservationDraftRowV1,
	ConfidentialTransientTaskSourceObservationHeadV1,
	ConfidentialTransientTaskSourceObservationProducerV1,
	ConfidentialTransientTaskSourceObservationReceiptV1,
	ConfidentialTransientTaskSourceObservationRecordV1,
	ConfidentialTransientTaskSourceObservationReservationReceiptV1,
	ConfidentialTransientTaskSourceObservationReservationRequestV1,
	ConfidentialTransientTaskSourceObservationResultV1,
	FrozenReplicaCheckpointLocator,
	FrozenReplicaCheckpointRef,
	OrdinaryTransientTaskLifecycleV1,
	RuntimeAcquisitionPlan,
	RuntimeAttachment,
	RuntimeAttachmentRecordV1,
	RuntimeAttachmentStore,
	RuntimeCheckpointAcknowledgeResult,
	RuntimeDrainCacheEvictionProgress,
	RuntimeDrainPlan,
	RuntimeFence,
	RuntimeLeasePlan,
	RuntimeLeaseRef,
	RuntimeLeaseReleaseInspectRequest,
	RuntimeLeaseReleaseResult,
	RuntimeLeaseRenewalPlan,
	RuntimeProviderRegistry,
	RuntimePushResult,
	RuntimeRecoveryFreezeFrozenResult,
	RuntimeRecoveryFreezeImpossibilityProof,
	RuntimeReplicaCacheEvictionAcceptance,
	RuntimeReplicaCacheEvictionCompletion,
	RuntimeReplicaCacheEvictionPlan,
	RuntimeReplicaDeleteResult,
	RuntimeReplicaDeletionAuthorizationV1,
	RuntimeReplicaRef,
	RuntimeRequirements,
	RuntimeScheduler,
	RuntimeSchedulerStatusSnapshot,
	SafeDiagnosticCodeV1,
	TransientTaskCancellationAcknowledgementReceiptV1,
	TransientTaskCanonicalDiscardReceiptV1,
	TransientTaskCanonicalProviderTerminalEvidenceV1,
	TransientTaskCanonicalWorkspaceStoreV1,
	TransientTaskCanonicalWorktreePublicationAttemptV1,
	TransientTaskCanonicalWorktreePublicationNotAppliedReceiptV1,
	TransientTaskCleanupAuthorityProofV1,
	TransientTaskCleanupAuthorityV1,
	TransientTaskCleanupBranchV1,
	TransientTaskCleanupPlanV1,
	TransientTaskCleanupProgressV1,
	TransientTaskControllerAuthorityProofV1,
	TransientTaskControllerAuthorityV1,
	TransientTaskDetachedSettlementNotAppliedReceiptV1,
	TransientTaskDetachedSettlementStoreV1,
	TransientTaskEffectIdentityManifestV1,
	TransientTaskForegroundAfterToolCallGateBridgeV1,
	TransientTaskForegroundAppendDeliveryBatchResultV1,
	TransientTaskForegroundResultAppendNotAppliedProofV1,
	TransientTaskForegroundResultSettlementStoreV1,
	TransientTaskForegroundSessionAppendInspectResultV1,
	TransientTaskHubWaitMessagePreselectionRecoveryRefV1,
	TransientTaskIsolationCleanupHandleV1,
	TransientTaskIsolationCleanupReceiptV1,
	TransientTaskIsolationCleanupTerminalEvidenceV1,
	TransientTaskIsolationOwnershipClaimEffectInspectRequestV1,
	TransientTaskIsolationOwnershipClaimEffectInspectResultV1,
	TransientTaskManagedWorkspaceRefV1,
	TransientTaskOutcomeDocumentEncodingV1,
	TransientTaskOutcomePayloadActiveRetentionAuthorityV1,
	TransientTaskOutcomePayloadAvailableInspectionV1,
	TransientTaskOutcomePayloadAvailableStateV1,
	TransientTaskOutcomePayloadDeleteAuthorityV1,
	TransientTaskOutcomePayloadDeleteReceiptV1,
	TransientTaskOutcomePayloadDeleteRequestV1,
	TransientTaskOutcomePayloadLifetimeV1,
	TransientTaskOutcomePayloadPutReceiptV1,
	TransientTaskOutcomePayloadPutRequestV1,
	TransientTaskOutcomePayloadRecoveryAuthorityV1,
	TransientTaskOutcomePayloadRefV1,
	TransientTaskOutcomePayloadRetentionAuthorityV1,
	TransientTaskOutcomePayloadRetentionReceiptV1,
	TransientTaskOutcomePayloadRetentionRequestV1,
	TransientTaskOutcomePayloadStoreV1,
	TransientTaskOutcomePayloadV1,
	TransientTaskParentResultDeliveryInspectRequestV1,
	TransientTaskParentResultDeliveryInspectResultV1,
	TransientTaskParentResultDeliveryReceiptV1,
	TransientTaskParentResultDeliveryStoreV1,
	TransientTaskPendingCaptureRestartCoordinatorV1,
	TransientTaskPendingOutcomeReceiptV1,
	TransientTaskPendingOutcomeV1,
	TransientTaskPreparedReplicaDeleteV1,
	TransientTaskProviderWorkspaceIdentityV1,
	TransientTaskPublicationTargetAuthorityV1,
	TransientTaskPublicationTargetBindingEvidenceV1,
	TransientTaskPublicationTargetBindingStoreV1,
	TransientTaskPublicationTargetBindingV1,
	TransientTaskPublicationTargetBindReceiptV1,
	TransientTaskPublicationTargetCleanupClaimV1,
	TransientTaskPublicationTargetCleanupDueReceiptV1,
	TransientTaskPublicationTargetExpiryPlanV1,
	TransientTaskPublicationTargetKeyV1,
	TransientTaskPublicationTargetPublicationClaimV1,
	TransientTaskPublicationTargetReleasePlanV1,
	TransientTaskPublicationTargetReleaseReceiptV1,
	TransientTaskPublicationTargetRenewalReceiptV1,
	TransientTaskResultlessRepresentabilityPreflightV1,
	TransientTaskResultPublicationPrePendingInitializationReceiptV1,
	TransientTaskResultPublicationPrePendingStateV1,
	TransientTaskResultPublicationReceiptV1,
	TransientTaskResultPublicationStateV1,
	TransientTaskResultPublicationStoreV1,
	TransientTaskResultPublicationTargetBindingReceiptV1,
	TransientTaskResultPublicationTargetCleanupReceiptV1,
	TransientTaskResultPublicationTargetKeyV1,
	TransientTaskResultPublicationTargetLifetimeV1,
	TransientTaskResultPublicationTargetRecoveryAuthorityV1,
	TransientTaskResultPublicationTargetRenewalReceiptV1,
	TransientTaskResultPublicationTargetStateV1,
	TransientTaskResultPublicationTargetStoreV1,
	TransientTaskSingleResultCompositionDiagnosticV1,
	TransientTaskSourceObservationStoreV1,
	TransientTaskWorkspaceAuthorityStoreV1,
	TransientTaskWorkspaceAuthorityV1,
	TransientTaskWorkspaceKeyV1,
	TransientTaskWorkspaceTombstoneV1,
	TransientTaskWorktreePublicationReceiptV1,
	TransientTaskWorktreePublicationTargetHandleV1,
	WorkspaceControllerLease,
	WorkspaceControllerLeaseObservation,
	WorkspaceControllerLeaseProof,
	WorkspaceDeletionAuthority,
	WorkspaceDeletionAuthorityObservation,
	WorkspaceDeletionAuthorityProof,
	WorkspaceDeletionVerificationReceiptV1,
	WorkspaceTombstone,
} from "./workspace-runtime-contracts.js";
import {
	canonicalRuntimeSha256,
	encodeCanonicalRuntimeTupleV1,
	canonicalTransientTaskSourceObservationDigestV1,
	decodeTransientTaskPendingCaptureIndexKeyV1,
	decodeTransientTaskSourceObservationHeadV1,
	deriveTransientTaskHubDetachedCommitAttemptV1,
	deriveTransientTaskHubDetachedReleaseAttemptV1,
	deriveTransientTaskHubDetachedReservationAttemptV1,
	hashTransientTaskHubWaitMessageCanonicalRecordV1,
	SAFE_DIAGNOSTIC_MESSAGE_CATALOG_V1,
	TRANSIENT_TASK_OUTCOME_PAYLOAD_BYTES_MAX_V1,
	TRANSIENT_TASK_PUBLICATION_TARGET_TTL_MS_MAX_V1,
	TRANSIENT_TASK_PUBLICATION_TARGET_TTL_MS_MIN_V1,
	TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MAX_V1,
	TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MIN_V1,
	validateTransientTaskHubWaitMessageCanonicalRecordV1,
	validateTransientTaskPublicationTargetBindingV1,
	validateTransientTaskPublicationTargetBindReceiptV1,
	validateTransientTaskPublicationTargetCleanupDueReceiptV1,
	validateTransientTaskPublicationTargetKeyV1,
	validateTransientTaskPublicationTargetReleaseReceiptV1,
	validateTransientTaskPublicationTargetRenewalReceiptV1,
} from "./workspace-runtime-contracts.js";

const CONTROLLER_NAMESPACE = "workspace-controller";
const TRANSIENT_NAMESPACE = "transient-task-runtime";

export interface TransientTaskRuntimeStoreFacadeV1 {
	readonly transientTaskWorkspaceAuthorityStore: TransientTaskWorkspaceAuthorityStoreV1;
	readonly transientTaskCanonicalWorkspaceStore: TransientTaskCanonicalWorkspaceStoreV1;
	readonly transientTaskPublicationTargetBindingStore: TransientTaskPublicationTargetBindingStoreV1;
	readonly transientTaskOutcomePayloadStore: TransientTaskOutcomePayloadStoreV1;
	readonly transientTaskResultPublicationTargetStore: TransientTaskResultPublicationTargetStoreV1;
	readonly transientTaskResultPublicationStore: TransientTaskResultPublicationStoreV1;
	readonly transientTaskParentResultDeliveryStore: TransientTaskParentResultDeliveryStoreV1;
	readonly transientTaskSourceObservationStore: TransientTaskSourceObservationStoreV1;
	readonly transientTaskPendingCaptureRestartCoordinator: TransientTaskPendingCaptureRestartCoordinatorV1;
	readonly ordinaryTransientTaskLifecycle: OrdinaryTransientTaskLifecycleV1;
}

function nowIso(): ISO8601 {
	return new Date().toISOString();
}

function addMilliseconds(now: ISO8601, milliseconds: number): ISO8601 {
	if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0)
		throw new TypeError("TTL must be a positive safe integer");
	return new Date(Date.parse(now) + milliseconds).toISOString();
}

function renewalDeadline(now: ISO8601, ttlMs: number): ISO8601 {
	return addMilliseconds(now, Math.max(1, Math.floor(ttlMs / 2)));
}

function exactJson(left: unknown, right: unknown): boolean {
	return isDeepStrictEqual(left, right);
}
function workspaceImagesMatch(
	left: { readonly rootSha256: Sha256Hex; readonly fileCount: number; readonly byteCount: number },
	right: { readonly rootSha256: Sha256Hex; readonly fileCount: number; readonly byteCount: number },
): boolean {
	return (
		left.rootSha256 === right.rootSha256 && left.fileCount === right.fileCount && left.byteCount === right.byteCount
	);
}

function runtimeLeaseMatches(left: RuntimeLeaseRef, right: RuntimeLeaseRef): boolean {
	return (
		left.leaseId === right.leaseId &&
		left.fenceId === right.fenceId &&
		left.baseGeneration === right.baseGeneration &&
		left.renewalSequence === right.renewalSequence &&
		left.acquiredAt === right.acquiredAt &&
		left.renewBy === right.renewBy &&
		left.expiresAt === right.expiresAt &&
		exactJson(left.replica, right.replica)
	);
}

function proxyFreeData(input: unknown, active = new Set<object>()): boolean {
	if (isProxy(input)) return false;
	if (input === null || typeof input !== "object") return true;
	if (active.has(input)) return false;
	active.add(input);
	try {
		for (const key of Reflect.ownKeys(input)) {
			const descriptor = Object.getOwnPropertyDescriptor(input, key);
			if (!descriptor || !("value" in descriptor) || !proxyFreeData(descriptor.value, active)) return false;
		}
		return true;
	} catch {
		return false;
	} finally {
		active.delete(input);
	}
}

function strictRecord<Input>(input: Input, keys: readonly string[]): input is Input & Record<string, unknown> {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input)) return false;
	try {
		const prototype = Object.getPrototypeOf(input);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const ownKeys = Reflect.ownKeys(input);
		if (ownKeys.length !== keys.length) return false;
		const descriptors = Object.getOwnPropertyDescriptors(input);
		return ownKeys.every(key => {
			if (typeof key !== "string" || !keys.includes(key)) return false;
			const descriptor = descriptors[key];
			return descriptor?.enumerable === true && "value" in descriptor;
		});
	} catch {
		return false;
	}
}

function strictArray(input: unknown): input is readonly unknown[] {
	if (!proxyFreeData(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return false;
	const length = Object.getOwnPropertyDescriptor(input, "length");
	const ownKeys = Reflect.ownKeys(input);
	const descriptors = Object.getOwnPropertyDescriptors(input);
	if (
		!length ||
		length.enumerable ||
		!("value" in length) ||
		!Number.isSafeInteger(length.value) ||
		ownKeys.length !== length.value + 1
	)
		return false;
	for (let index = 0; index < length.value; index++) {
		const descriptor = descriptors[String(index)];
		if (descriptor?.enumerable !== true || !("value" in descriptor)) return false;
	}
	return true;
}

function strictMap(input: unknown): input is Readonly<Record<string, unknown>> {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input)) return false;
	try {
		const prototype = Object.getPrototypeOf(input);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const ownKeys = Reflect.ownKeys(input);
		const descriptors = Object.getOwnPropertyDescriptors(input);
		return ownKeys.every(key => {
			if (typeof key !== "string") return false;
			const descriptor = descriptors[key];
			return descriptor?.enumerable === true && "value" in descriptor;
		});
	} catch {
		return false;
	}
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA256_REF = /^sha256:[0-9a-f]{64}$/;
const ISO8601_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RUNTIME_CAPABILITIES = [
	"workspace.read",
	"workspace.write",
	"workspace.list",
	"workspace.search",
	"process.exec",
	"process.pty",
	"process.env",
] as const;
const RUNTIME_HARD_FILTER_CODES = [
	"configured_provider_missing",
	"configured_provider_disabled",
	"configured_provider_unavailable",
	"configured_provider_location_conflict",
	"provider_disabled",
	"provider_unavailable",
	"provider_no_candidates",
	"candidate_unavailable",
	"placement_mismatch",
	"provider_id_mismatch",
	"workspace_format_mismatch",
	"capability_missing",
	"os_mismatch",
	"arch_mismatch",
	"cpu_insufficient",
	"memory_insufficient",
	"network_mismatch",
	"ready_latency_exceeded",
] as const;
const RUNTIME_TRANSITION_REASONS = [
	"first_tool",
	"capability_change",
	"policy_change",
	"idle_timeout",
	"park",
	"agent_release",
	"workspace_delete",
	"task_complete",
	"task_failed",
	"task_cancelled",
	"crash_recovery",
	"lease_expired",
] as const;

function invalidPersistentRuntime(): never {
	throw new TypeError("Workspace controller state is invalid");
}

function isWellFormedString(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0xd800 || code > 0xdfff) continue;
		if (code >= 0xdc00 || index + 1 >= value.length) return false;
		const next = value.charCodeAt(++index);
		if (next < 0xdc00 || next > 0xdfff) return false;
	}
	return true;
}

function isSafeCount(value: unknown, minimum = 0): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum;
}

function isIso8601(value: unknown): value is ISO8601 {
	if (typeof value !== "string" || !ISO8601_MILLISECONDS.test(value)) return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function isSha256Hex(value: unknown): value is Sha256Hex {
	return typeof value === "string" && SHA256_HEX.test(value);
}

function isSha256Ref(value: unknown): value is Sha256Ref {
	return typeof value === "string" && SHA256_REF.test(value);
}

function isOneOf(value: unknown, allowed: readonly string[]): value is string {
	return typeof value === "string" && allowed.includes(value);
}

function isSafeDiagnosticCode(value: unknown): value is SafeDiagnosticCodeV1 {
	return typeof value === "string" && Object.hasOwn(SAFE_DIAGNOSTIC_MESSAGE_CATALOG_V1, value);
}

function tupleSha256(tuple: readonly unknown[]): Sha256Hex {
	return createHash("sha256")
		.update(encodeCanonicalRuntimeTupleV1(tuple as readonly CanonicalRuntimeValue[]), "utf8")
		.digest("hex") as Sha256Hex;
}

function derivedProviderRequestId(
	workspaceId: WorkspaceId,
	parentKind: "runtime_transition" | "runtime_renewal",
	parentId: OperationId,
	ordinal: number,
	operation: string,
): string {
	return tupleSha256(["omp-provider-subrequest-id-v1", workspaceId, parentKind, parentId, ordinal, operation]);
}

function decodeWorkspaceCheckpoint(input: unknown, workspaceId?: WorkspaceId): WorkspaceCheckpoint {
	if (
		!strictRecord(input, ["workspaceId", "generation", "rootSha256", "fileCount", "byteCount", "committedAt"]) ||
		!isWellFormedString(input.workspaceId) ||
		(workspaceId !== undefined && input.workspaceId !== workspaceId) ||
		!isSafeCount(input.generation) ||
		!isSha256Hex(input.rootSha256) ||
		!isSafeCount(input.fileCount) ||
		!isSafeCount(input.byteCount) ||
		!isIso8601(input.committedAt)
	) {
		invalidPersistentRuntime();
	}
	return input as unknown as WorkspaceCheckpoint;
}

function decodeRuntimeReplica(input: unknown, workspaceId?: WorkspaceId): RuntimeLeaseRef["replica"] {
	if (
		!strictRecord(input, ["providerId", "profileId", "replicaId", "workspaceId"]) ||
		!isWellFormedString(input.providerId) ||
		!isWellFormedString(input.profileId) ||
		!isWellFormedString(input.replicaId) ||
		!isWellFormedString(input.workspaceId) ||
		(workspaceId !== undefined && input.workspaceId !== workspaceId)
	) {
		invalidPersistentRuntime();
	}
	return input as unknown as RuntimeLeaseRef["replica"];
}

function decodeRuntimeLease(input: unknown, workspaceId?: WorkspaceId): RuntimeLeaseRef {
	if (
		!strictRecord(input, [
			"leaseId",
			"replica",
			"fenceId",
			"baseGeneration",
			"renewalSequence",
			"acquiredAt",
			"renewBy",
			"expiresAt",
		]) ||
		!isWellFormedString(input.leaseId) ||
		!isWellFormedString(input.fenceId) ||
		!isSafeCount(input.baseGeneration) ||
		!isSafeCount(input.renewalSequence) ||
		!isIso8601(input.acquiredAt) ||
		!isIso8601(input.renewBy) ||
		!isIso8601(input.expiresAt) ||
		Date.parse(input.renewBy) <= Date.parse(input.acquiredAt) ||
		Date.parse(input.expiresAt) <= Date.parse(input.renewBy)
	) {
		invalidPersistentRuntime();
	}
	decodeRuntimeReplica(input.replica, workspaceId);
	return input as unknown as RuntimeLeaseRef;
}

function decodeTransitionRequest(input: unknown, transitionId?: OperationId) {
	if (
		!strictRecord(input, ["transitionId", "requestId", "requestSha256"]) ||
		!isWellFormedString(input.transitionId) ||
		(transitionId !== undefined && input.transitionId !== transitionId) ||
		!isWellFormedString(input.requestId) ||
		!isSha256Hex(input.requestSha256)
	) {
		invalidPersistentRuntime();
	}
	return input;
}

function decodeParentRequest(input: unknown, parentOperationId?: OperationId) {
	if (
		!strictRecord(input, ["parentOperationId", "requestId", "requestSha256"]) ||
		!isWellFormedString(input.parentOperationId) ||
		(parentOperationId !== undefined && input.parentOperationId !== parentOperationId) ||
		!isWellFormedString(input.requestId) ||
		!isSha256Hex(input.requestSha256)
	) {
		invalidPersistentRuntime();
	}
	return input;
}

function decodeParentRequestPreallocation(input: unknown, parentOperationId?: OperationId) {
	if (
		!strictRecord(input, ["requestId", "parentOperationId"]) ||
		!isWellFormedString(input.requestId) ||
		!isWellFormedString(input.parentOperationId) ||
		(parentOperationId !== undefined && input.parentOperationId !== parentOperationId)
	) {
		invalidPersistentRuntime();
	}
	return input;
}

function decodeRuntimeRequirements(input: unknown): RuntimeRequirements {
	if (
		!strictRecord(input, [
			"capabilities",
			"placement",
			"configuredProviderId",
			"workspaceFormat",
			"os",
			"arch",
			"minCpu",
			"minMemoryMiB",
			"network",
			"maxReadyLatencyMs",
		]) ||
		!Array.isArray(input.capabilities) ||
		new Set(input.capabilities).size !== input.capabilities.length ||
		!input.capabilities.every(value => isOneOf(value, RUNTIME_CAPABILITIES)) ||
		!isOneOf(input.placement, ["local", "cloud", "auto"]) ||
		(input.configuredProviderId !== null && !isWellFormedString(input.configuredProviderId)) ||
		input.workspaceFormat !== "omp-text-v1" ||
		(input.os !== null && !isOneOf(input.os, ["darwin", "linux", "windows"])) ||
		(input.arch !== null && !isOneOf(input.arch, ["arm64", "x64"])) ||
		!isSafeCount(input.minCpu) ||
		!isSafeCount(input.minMemoryMiB) ||
		!isOneOf(input.network, ["none", "egress"]) ||
		(input.maxReadyLatencyMs !== null && !isSafeCount(input.maxReadyLatencyMs))
	) {
		invalidPersistentRuntime();
	}
	return input as unknown as RuntimeRequirements;
}

function decodeRuntimeCandidate(input: unknown): RuntimeAcquisitionPlan["target"]["candidate"] {
	if (
		!strictRecord(input, [
			"providerId",
			"profileId",
			"location",
			"capabilities",
			"workspaceFormats",
			"os",
			"arch",
			"cpu",
			"memoryMiB",
			"network",
			"available",
			"estimatedIncrementalCostMicrosPerHour",
			"estimatedReadyLatencyMs",
		]) ||
		!isWellFormedString(input.providerId) ||
		!isWellFormedString(input.profileId) ||
		!isOneOf(input.location, ["local", "cloud"]) ||
		!Array.isArray(input.capabilities) ||
		new Set(input.capabilities).size !== input.capabilities.length ||
		!input.capabilities.every(value => isOneOf(value, RUNTIME_CAPABILITIES)) ||
		!Array.isArray(input.workspaceFormats) ||
		input.workspaceFormats.length !== 1 ||
		input.workspaceFormats[0] !== "omp-text-v1" ||
		!isOneOf(input.os, ["darwin", "linux", "windows"]) ||
		!isOneOf(input.arch, ["arm64", "x64"]) ||
		!isSafeCount(input.cpu) ||
		!isSafeCount(input.memoryMiB) ||
		!isOneOf(input.network, ["none", "egress"]) ||
		typeof input.available !== "boolean" ||
		!isSafeCount(input.estimatedIncrementalCostMicrosPerHour) ||
		!isSafeCount(input.estimatedReadyLatencyMs)
	) {
		invalidPersistentRuntime();
	}
	return input as unknown as RuntimeAcquisitionPlan["target"]["candidate"];
}

function decodeRuntimeTarget(input: unknown): RuntimeAcquisitionPlan["target"] {
	if (!strictRecord(input, ["candidate", "requirements"])) invalidPersistentRuntime();
	decodeRuntimeCandidate(input.candidate);
	decodeRuntimeRequirements(input.requirements);
	return input as unknown as RuntimeAcquisitionPlan["target"];
}

function decodeRecoveryLocator(
	input: unknown,
	workspaceId?: WorkspaceId,
): RuntimeAcquisitionPlan["recovery"]["locator"] {
	if (
		!strictRecord(input, ["recoveryFreezeId", "replica", "leaseId", "fenceId", "baseGeneration", "checkpointId"]) ||
		!isWellFormedString(input.recoveryFreezeId) ||
		!isWellFormedString(input.leaseId) ||
		!isWellFormedString(input.fenceId) ||
		!isSafeCount(input.baseGeneration) ||
		!isWellFormedString(input.checkpointId)
	) {
		invalidPersistentRuntime();
	}
	decodeRuntimeReplica(input.replica, workspaceId);
	return input as unknown as RuntimeAcquisitionPlan["recovery"]["locator"];
}

function decodeRecoveryPlan(input: unknown, workspaceId?: WorkspaceId): RuntimeAcquisitionPlan["recovery"] {
	if (
		!strictRecord(input, ["locator", "canonicalCommitId", "requests"]) ||
		!isWellFormedString(input.canonicalCommitId)
	) {
		invalidPersistentRuntime();
	}
	const locator = decodeRecoveryLocator(input.locator, workspaceId);
	if (!strictRecord(input.requests, ["freeze", "checkpointAcknowledgement", "release"])) invalidPersistentRuntime();
	const freeze = (() => {
		if (
			!strictRecord(input.requests.freeze, ["requestId", "requestSha256"]) ||
			!isWellFormedString(input.requests.freeze.requestId) ||
			!isSha256Hex(input.requests.freeze.requestSha256)
		) {
			invalidPersistentRuntime();
		}
		return input.requests.freeze;
	})();
	const acknowledgement = decodeParentRequestPreallocation(
		input.requests.checkpointAcknowledgement,
		locator.recoveryFreezeId,
	);
	const release = decodeParentRequest(input.requests.release, locator.recoveryFreezeId);
	if (
		freeze.requestId !==
			derivedProviderRequestId(
				locator.replica.workspaceId,
				"runtime_transition",
				locator.recoveryFreezeId,
				4,
				"recovery_freeze",
			) ||
		freeze.requestSha256 !==
			tupleSha256([
				"omp-runtime-provider-v1",
				"recovery_freeze",
				locator.recoveryFreezeId,
				locator.replica.providerId,
				locator.replica.profileId,
				locator.replica.workspaceId,
				locator.replica.replicaId,
				locator.leaseId,
				locator.fenceId,
				locator.baseGeneration,
				locator.checkpointId,
			]) ||
		acknowledgement.requestId !==
			derivedProviderRequestId(
				locator.replica.workspaceId,
				"runtime_transition",
				locator.recoveryFreezeId,
				5,
				"checkpoint_acknowledgement",
			) ||
		release.requestId !==
			derivedProviderRequestId(
				locator.replica.workspaceId,
				"runtime_transition",
				locator.recoveryFreezeId,
				6,
				"release",
			) ||
		release.requestSha256 !==
			tupleSha256([
				"omp-runtime-provider-v1",
				"release",
				locator.recoveryFreezeId,
				locator.replica.providerId,
				locator.replica.profileId,
				locator.replica.workspaceId,
				locator.replica.replicaId,
				locator.leaseId,
			])
	) {
		invalidPersistentRuntime();
	}
	return input as unknown as RuntimeAcquisitionPlan["recovery"];
}

function decodeRuntimeAcquisitionPlan(input: unknown, workspaceId: WorkspaceId): RuntimeAcquisitionPlan {
	if (
		!strictRecord(input, ["transitionId", "target", "lease", "recovery", "requests"]) ||
		!isWellFormedString(input.transitionId)
	) {
		invalidPersistentRuntime();
	}
	const transitionId = input.transitionId as OperationId;
	const target = decodeRuntimeTarget(input.target);
	if (
		!strictRecord(input.lease, [
			"replica",
			"leaseId",
			"fenceId",
			"initialRenewalSequence",
			"baseCheckpoint",
			"deletionAuthorityDomain",
			"leaseTtlMs",
		]) ||
		!isWellFormedString(input.lease.leaseId) ||
		!isWellFormedString(input.lease.fenceId) ||
		input.lease.initialRenewalSequence !== 0 ||
		input.lease.deletionAuthorityDomain !== "persistent" ||
		!isSafeCount(input.lease.leaseTtlMs, 1)
	) {
		invalidPersistentRuntime();
	}
	const replica = decodeRuntimeReplica(input.lease.replica, workspaceId);
	const baseCheckpoint = decodeWorkspaceCheckpoint(input.lease.baseCheckpoint, workspaceId);
	if (replica.providerId !== target.candidate.providerId || replica.profileId !== target.candidate.profileId) {
		invalidPersistentRuntime();
	}
	const recovery = decodeRecoveryPlan(input.recovery, workspaceId);
	if (
		!exactJson(recovery.locator.replica, replica) ||
		recovery.locator.leaseId !== input.lease.leaseId ||
		recovery.locator.fenceId !== input.lease.fenceId ||
		recovery.locator.baseGeneration !== baseCheckpoint.generation
	) {
		invalidPersistentRuntime();
	}
	if (!strictRecord(input.requests, ["acquire", "push", "rollbackRevoke", "rollbackRelease"]))
		invalidPersistentRuntime();
	const acquire = decodeTransitionRequest(input.requests.acquire, transitionId);
	const push = decodeTransitionRequest(input.requests.push, transitionId);
	const rollbackRevoke = decodeTransitionRequest(input.requests.rollbackRevoke, transitionId);
	const rollbackRelease = decodeParentRequest(input.requests.rollbackRelease, transitionId);
	if (
		acquire.requestId !== derivedProviderRequestId(workspaceId, "runtime_transition", transitionId, 0, "acquire") ||
		acquire.requestSha256 !==
			tupleSha256([
				"omp-runtime-provider-v1",
				"acquire",
				transitionId,
				target.candidate.providerId,
				target.candidate.profileId,
				replica.workspaceId,
				replica.replicaId,
				input.lease.leaseId,
				input.lease.fenceId,
				baseCheckpoint.generation,
				baseCheckpoint.rootSha256,
				baseCheckpoint.fileCount,
				baseCheckpoint.byteCount,
				"persistent",
				input.lease.leaseTtlMs,
				0,
			]) ||
		push.requestId !== derivedProviderRequestId(workspaceId, "runtime_transition", transitionId, 1, "push") ||
		push.requestSha256 !==
			tupleSha256([
				"omp-runtime-provider-v1",
				"push",
				transitionId,
				replica.providerId,
				replica.profileId,
				replica.workspaceId,
				replica.replicaId,
				input.lease.leaseId,
				input.lease.fenceId,
				baseCheckpoint.generation,
				baseCheckpoint.rootSha256,
				baseCheckpoint.fileCount,
				baseCheckpoint.byteCount,
			]) ||
		rollbackRevoke.requestId !==
			derivedProviderRequestId(workspaceId, "runtime_transition", transitionId, 2, "revoke") ||
		rollbackRevoke.requestSha256 !==
			tupleSha256([
				"omp-runtime-provider-v1",
				"revoke",
				transitionId,
				replica.providerId,
				replica.profileId,
				replica.workspaceId,
				replica.replicaId,
				input.lease.leaseId,
				input.lease.fenceId,
				"runtime_reconciliation_blocked",
			]) ||
		rollbackRelease.requestId !==
			derivedProviderRequestId(workspaceId, "runtime_transition", transitionId, 3, "release") ||
		rollbackRelease.requestSha256 !==
			tupleSha256([
				"omp-runtime-provider-v1",
				"release",
				transitionId,
				replica.providerId,
				replica.profileId,
				replica.workspaceId,
				replica.replicaId,
				input.lease.leaseId,
			])
	) {
		invalidPersistentRuntime();
	}
	return input as unknown as RuntimeAcquisitionPlan;
}

function decodeRuntimePushResult(
	input: unknown,
	plan: RuntimeAcquisitionPlan,
	lease: RuntimeLeaseRef,
): RuntimePushResult {
	if (
		!strictRecord(input, [
			"status",
			"request",
			"replica",
			"canonicalGeneration",
			"rootSha256",
			"fileCount",
			"byteCount",
		]) ||
		!isOneOf(input.status, ["materialized", "already_materialized"]) ||
		!isSafeCount(input.canonicalGeneration) ||
		!isSha256Hex(input.rootSha256) ||
		!isSafeCount(input.fileCount) ||
		!isSafeCount(input.byteCount)
	) {
		invalidPersistentRuntime();
	}
	decodeTransitionRequest(input.request, plan.transitionId);
	decodeRuntimeReplica(input.replica, lease.replica.workspaceId);
	if (
		!exactJson(input.request, plan.requests.push) ||
		!exactJson(input.replica, lease.replica) ||
		input.canonicalGeneration !== lease.baseGeneration
	) {
		invalidPersistentRuntime();
	}
	return input as unknown as RuntimePushResult;
}

function decodeRuntimeAcquireProgress(
	input: unknown,
	plan: RuntimeAcquisitionPlan,
): Extract<RuntimeAttachment, { state: "acquiring" }>["progress"] {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input))
		invalidPersistentRuntime();
	const phase = Object.getOwnPropertyDescriptor(input, "phase")?.value;
	if (phase === "pre_provider" || phase === "acquire_outcome_unknown") {
		if (
			!strictRecord(input, ["phase", "lease", "materialized"]) ||
			input.lease !== null ||
			input.materialized !== null
		) {
			invalidPersistentRuntime();
		}
		return input as Extract<RuntimeAttachment, { state: "acquiring" }>["progress"];
	}
	if (phase !== "reserved" && phase !== "push_outcome_unknown" && phase !== "ready") invalidPersistentRuntime();
	if (!strictRecord(input, ["phase", "lease", "materialized"])) invalidPersistentRuntime();
	const lease = decodeRuntimeLease(input.lease, plan.lease.replica.workspaceId);
	if (
		lease.leaseId !== plan.lease.leaseId ||
		lease.fenceId !== plan.lease.fenceId ||
		lease.baseGeneration !== plan.lease.baseCheckpoint.generation ||
		lease.renewalSequence !== 0 ||
		!exactJson(lease.replica, plan.lease.replica)
	) {
		invalidPersistentRuntime();
	}
	if (phase === "ready") decodeRuntimePushResult(input.materialized, plan, lease);
	else if (input.materialized !== null) invalidPersistentRuntime();
	return input as unknown as Extract<RuntimeAttachment, { state: "acquiring" }>["progress"];
}

function decodeProviderAvailability(input: unknown): void {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input))
		invalidPersistentRuntime();
	const status = Object.getOwnPropertyDescriptor(input, "status")?.value;
	if (status === "available") {
		if (!strictRecord(input, ["status"])) invalidPersistentRuntime();
		return;
	}
	if (status === "not_queried") {
		if (!strictRecord(input, ["status", "reason"]) || !isOneOf(input.reason, ["not_registered", "disabled"])) {
			invalidPersistentRuntime();
		}
		return;
	}
	if (status !== "unavailable") invalidPersistentRuntime();
	if (!strictRecord(input, ["status", "code", "details"])) invalidPersistentRuntime();
	if (input.code === "provider_reported_unavailable") {
		if (
			!strictRecord(input.details, ["reportedCode"]) ||
			!isSafeDiagnosticCode(input.details.reportedCode) ||
			input.details.reportedCode === "provider_reported_unavailable" ||
			input.details.reportedCode === "discovery_failed"
		) {
			invalidPersistentRuntime();
		}
		return;
	}
	if (
		input.code !== "discovery_failed" ||
		!strictRecord(input.details, ["failureKind"]) ||
		!isOneOf(input.details.failureKind, ["provider_call_failed", "invalid_result"])
	) {
		invalidPersistentRuntime();
	}
}

function decodeSchedulerProviderObservation(input: unknown): void {
	if (
		!strictRecord(input, [
			"providerId",
			"registered",
			"enabled",
			"availability",
			"supportedLocations",
			"candidateCount",
			"hardFilterFailures",
		]) ||
		!isWellFormedString(input.providerId) ||
		typeof input.registered !== "boolean" ||
		typeof input.enabled !== "boolean" ||
		!Array.isArray(input.supportedLocations) ||
		new Set(input.supportedLocations).size !== input.supportedLocations.length ||
		!input.supportedLocations.every(value => isOneOf(value, ["local", "cloud"])) ||
		!isSafeCount(input.candidateCount) ||
		!Array.isArray(input.hardFilterFailures) ||
		new Set(input.hardFilterFailures).size !== input.hardFilterFailures.length ||
		!input.hardFilterFailures.every(value => isOneOf(value, RUNTIME_HARD_FILTER_CODES))
	) {
		invalidPersistentRuntime();
	}
	decodeProviderAvailability(input.availability);
}

function decodeSchedulerCandidateObservation(input: unknown): void {
	if (
		!strictRecord(input, [
			"providerId",
			"profileId",
			"location",
			"hardFilterFailures",
			"retainedCurrent",
			"estimatedIncrementalCostMicrosPerHour",
			"estimatedReadyLatencyMs",
		]) ||
		!isWellFormedString(input.providerId) ||
		!isWellFormedString(input.profileId) ||
		!isOneOf(input.location, ["local", "cloud"]) ||
		!Array.isArray(input.hardFilterFailures) ||
		new Set(input.hardFilterFailures).size !== input.hardFilterFailures.length ||
		!input.hardFilterFailures.every(value => isOneOf(value, RUNTIME_HARD_FILTER_CODES)) ||
		typeof input.retainedCurrent !== "boolean" ||
		!isSafeCount(input.estimatedIncrementalCostMicrosPerHour) ||
		!isSafeCount(input.estimatedReadyLatencyMs)
	) {
		invalidPersistentRuntime();
	}
}

function decodeRuntimeScheduler(input: unknown): RuntimeSchedulerStatusSnapshot {
	if (!strictRecord(input, ["input", "providers", "candidates", "decision", "evaluatedAt", "durationMs"])) {
		invalidPersistentRuntime();
	}
	if (input.input === null) {
		if (
			!Array.isArray(input.providers) ||
			input.providers.length !== 0 ||
			!Array.isArray(input.candidates) ||
			input.candidates.length !== 0 ||
			!strictRecord(input.decision, ["status"]) ||
			input.decision.status !== "not_evaluated" ||
			input.evaluatedAt !== null ||
			input.durationMs !== null
		) {
			invalidPersistentRuntime();
		}
		return input as unknown as RuntimeSchedulerStatusSnapshot;
	}
	decodeRuntimeRequirements(input.input);
	if (
		!Array.isArray(input.providers) ||
		!Array.isArray(input.candidates) ||
		!isIso8601(input.evaluatedAt) ||
		!isSafeCount(input.durationMs)
	) {
		invalidPersistentRuntime();
	}
	for (const provider of input.providers) decodeSchedulerProviderObservation(provider);
	for (const candidate of input.candidates) decodeSchedulerCandidateObservation(candidate);
	if (input.decision === null || typeof input.decision !== "object" || Array.isArray(input.decision))
		invalidPersistentRuntime();
	const status = Object.getOwnPropertyDescriptor(input.decision, "status")?.value;
	if (status === "selected") {
		if (
			!strictRecord(input.decision, ["status", "providerId", "profileId", "retainedCurrent"]) ||
			!isWellFormedString(input.decision.providerId) ||
			!isWellFormedString(input.decision.profileId) ||
			typeof input.decision.retainedCurrent !== "boolean"
		) {
			invalidPersistentRuntime();
		}
	} else if (status === "unsatisfied") {
		if (
			!strictRecord(input.decision, ["status", "unmet"]) ||
			!Array.isArray(input.decision.unmet) ||
			new Set(input.decision.unmet).size !== input.decision.unmet.length ||
			!input.decision.unmet.every(value => isOneOf(value, RUNTIME_HARD_FILTER_CODES))
		) {
			invalidPersistentRuntime();
		}
	} else {
		invalidPersistentRuntime();
	}
	return input as unknown as RuntimeSchedulerStatusSnapshot;
}

function decodeCompletedTransition(input: unknown): NonNullable<RuntimeAttachmentRecordV1["lastCompletedTransition"]> {
	if (
		!strictRecord(input, ["transitionId", "reason", "from", "to", "startedAt", "completedAt"]) ||
		!isWellFormedString(input.transitionId) ||
		!isOneOf(input.reason, RUNTIME_TRANSITION_REASONS) ||
		!isOneOf(input.from, ["none", "acquiring", "active", "draining"]) ||
		!isOneOf(input.to, ["none", "acquiring", "active", "draining"]) ||
		!isIso8601(input.startedAt) ||
		!isIso8601(input.completedAt) ||
		Date.parse(input.completedAt) < Date.parse(input.startedAt)
	)
		invalidPersistentRuntime();
	const validTransition =
		(input.from === "none" && input.to === "active" && input.reason === "first_tool") ||
		(input.from === "active" && input.to === "none") ||
		(input.from === "acquiring" && input.to === "none" && input.reason === "crash_recovery");
	if (!validTransition) invalidPersistentRuntime();
	return input as unknown as NonNullable<RuntimeAttachmentRecordV1["lastCompletedTransition"]>;
}

function decodeRuntimeBlock(input: unknown): Extract<RuntimeAttachment, { state: "none" }>["block"] {
	if (input === null) return null;
	if (!proxyFreeData(input) || typeof input !== "object" || Array.isArray(input)) invalidPersistentRuntime();
	const state = Object.getOwnPropertyDescriptor(input, "state")?.value;
	if (!isOneOf(state, ["retry_allowed", "reconcile_required", "finish_required", "operator_required"])) {
		invalidPersistentRuntime();
	}
	if (!strictRecord(input, ["state", "certainty", "stage", "code", "observedAt", "next"])) invalidPersistentRuntime();
	if (
		!isOneOf(input.stage, [
			"operation_lease",
			"provider_acquire",
			"push",
			"lease_renewal",
			"recovery_freeze",
			"quiesce",
			"command_ambiguity",
			"checkpoint",
			"canonical_commit",
			"checkpoint_acknowledgement",
			"cache_eviction_acceptance",
			"revoke",
			"release",
			"replica_delete",
			"inspect",
		]) ||
		!isSafeDiagnosticCode(input.code) ||
		!isIso8601(input.observedAt)
	) {
		invalidPersistentRuntime();
	}
	if (state === "retry_allowed") {
		if (
			input.certainty !== "not_started" ||
			!strictRecord(input.next, ["kind", "requestId"]) ||
			input.next.kind !== "retry_same_request" ||
			!isWellFormedString(input.next.requestId)
		) {
			invalidPersistentRuntime();
		}
	} else if (state === "reconcile_required") {
		if (
			input.certainty !== "unknown" ||
			input.next === null ||
			typeof input.next !== "object" ||
			Array.isArray(input.next)
		) {
			invalidPersistentRuntime();
		}
		const kind = Object.getOwnPropertyDescriptor(input.next, "kind")?.value;
		if (kind === "provider_request") {
			if (
				!strictRecord(input.next, ["kind", "providerId", "requestId"]) ||
				!isWellFormedString(input.next.providerId) ||
				!isWellFormedString(input.next.requestId)
			)
				invalidPersistentRuntime();
		} else if (kind === "lease") {
			if (!strictRecord(input.next, ["kind", "lease"])) invalidPersistentRuntime();
			decodeRuntimeLeasePlan(input.next.lease);
		} else if (kind === "lease_renewal") {
			if (!strictRecord(input.next, ["kind", "plan"])) invalidPersistentRuntime();
			decodeRenewalPlan(input.next.plan);
		} else if (kind === "recovery_freeze") {
			if (!strictRecord(input.next, ["kind", "plan"])) invalidPersistentRuntime();
			decodeRecoveryPlan(input.next.plan);
		} else if (kind === "command_start") {
			if (!strictRecord(input.next, ["kind", "command"])) invalidPersistentRuntime();
			if (
				!strictRecord(input.next.command, ["replica", "leaseId", "commandId", "requestSha256"]) ||
				!isWellFormedString(input.next.command.leaseId) ||
				!isWellFormedString(input.next.command.commandId) ||
				!isSha256Hex(input.next.command.requestSha256)
			)
				invalidPersistentRuntime();
			decodeRuntimeReplica(input.next.command.replica);
		} else if (kind === "frozen_checkpoint") {
			if (!strictRecord(input.next, ["kind", "checkpoint"])) invalidPersistentRuntime();
			decodeFrozenCheckpointLocator(input.next.checkpoint);
		} else if (kind === "replica_cache_eviction") {
			if (!strictRecord(input.next, ["kind", "plan"])) invalidPersistentRuntime();
			decodeCacheEvictionPlan(input.next.plan);
		} else if (kind === "canonical_commit") {
			if (
				!strictRecord(input.next, ["kind", "workspaceId", "commitId"]) ||
				!isWellFormedString(input.next.workspaceId) ||
				!isWellFormedString(input.next.commitId)
			)
				invalidPersistentRuntime();
		} else {
			invalidPersistentRuntime();
		}
	} else if (state === "finish_required") {
		if (
			!isOneOf(input.certainty, ["started", "completed"]) ||
			!strictRecord(input.next, ["kind", "transitionId"]) ||
			input.next.kind !== "finish_same_transition" ||
			!isWellFormedString(input.next.transitionId)
		)
			invalidPersistentRuntime();
	} else if (
		!isOneOf(input.certainty, ["unknown", "started", "completed"]) ||
		!strictRecord(input.next, ["kind"]) ||
		input.next.kind !== "operator"
	) {
		invalidPersistentRuntime();
	}
	return input as unknown as Extract<RuntimeAttachment, { state: "none" }>["block"];
}

function decodeRuntimeLeasePlan(input: unknown, workspaceId?: WorkspaceId): RuntimeLeasePlan {
	if (
		!strictRecord(input, [
			"replica",
			"leaseId",
			"fenceId",
			"initialRenewalSequence",
			"baseCheckpoint",
			"deletionAuthorityDomain",
			"leaseTtlMs",
		]) ||
		!isWellFormedString(input.leaseId) ||
		!isWellFormedString(input.fenceId) ||
		input.initialRenewalSequence !== 0 ||
		input.deletionAuthorityDomain !== "persistent" ||
		!isSafeCount(input.leaseTtlMs, 1)
	)
		invalidPersistentRuntime();
	decodeRuntimeReplica(input.replica, workspaceId);
	decodeWorkspaceCheckpoint(input.baseCheckpoint, workspaceId);
	return input as unknown as RuntimeLeasePlan;
}

function decodeRenewalPlan(input: unknown): RuntimeLeaseRenewalPlan {
	if (
		!strictRecord(input, ["renewalId", "sequence", "expectedLease", "leaseTtlMs", "request"]) ||
		!isWellFormedString(input.renewalId) ||
		!isSafeCount(input.sequence, 1) ||
		!isSafeCount(input.leaseTtlMs, 1) ||
		!strictRecord(input.request, ["requestId", "requestSha256"]) ||
		!isWellFormedString(input.request.requestId) ||
		!isSha256Hex(input.request.requestSha256)
	)
		invalidPersistentRuntime();
	const lease = decodeRuntimeLease(input.expectedLease);
	if (
		input.sequence !== lease.renewalSequence + 1 ||
		input.request.requestId !==
			derivedProviderRequestId(
				lease.replica.workspaceId,
				"runtime_renewal",
				input.renewalId as OperationId,
				0,
				"renew",
			) ||
		input.request.requestSha256 !==
			tupleSha256([
				"omp-runtime-provider-v1",
				"renew",
				input.renewalId,
				input.sequence,
				lease.replica.providerId,
				lease.replica.profileId,
				lease.replica.workspaceId,
				lease.replica.replicaId,
				lease.leaseId,
				lease.fenceId,
				lease.baseGeneration,
				lease.renewalSequence,
				lease.acquiredAt,
				lease.renewBy,
				lease.expiresAt,
				input.leaseTtlMs,
			])
	)
		invalidPersistentRuntime();
	return input as unknown as RuntimeLeaseRenewalPlan;
}

function decodeRenewalOutcome(input: unknown): void {
	if (input === null) return;
	if (!proxyFreeData(input) || typeof input !== "object" || Array.isArray(input)) invalidPersistentRuntime();
	const kind = Object.getOwnPropertyDescriptor(input, "kind")?.value;
	if (kind === "renewed") {
		if (
			!strictRecord(input, ["kind", "receipt"]) ||
			!strictRecord(input.receipt, [
				"renewalId",
				"sequence",
				"request",
				"priorLease",
				"lease",
				"providerOutcome",
				"completedAt",
			]) ||
			!isWellFormedString(input.receipt.renewalId) ||
			!isSafeCount(input.receipt.sequence, 1) ||
			!strictRecord(input.receipt.request, ["requestId", "requestSha256"]) ||
			!isWellFormedString(input.receipt.request.requestId) ||
			!isSha256Hex(input.receipt.request.requestSha256) ||
			!isOneOf(input.receipt.providerOutcome, ["renewed", "already_renewed"]) ||
			!isIso8601(input.receipt.completedAt)
		)
			invalidPersistentRuntime();
		const prior = decodeRuntimeLease(input.receipt.priorLease);
		const lease = decodeRuntimeLease(input.receipt.lease);
		if (
			input.receipt.sequence !== prior.renewalSequence + 1 ||
			lease.leaseId !== prior.leaseId ||
			lease.fenceId !== prior.fenceId ||
			lease.baseGeneration !== prior.baseGeneration ||
			lease.renewalSequence !== input.receipt.sequence ||
			lease.acquiredAt !== prior.acquiredAt ||
			!exactJson(lease.replica, prior.replica) ||
			Date.parse(lease.renewBy) <= Date.parse(prior.renewBy) ||
			Date.parse(lease.expiresAt) <= Date.parse(prior.expiresAt)
		)
			invalidPersistentRuntime();
		return;
	}
	if (kind !== "not_renewed" || !strictRecord(input, ["kind", "plan", "reason", "observedAt"]))
		invalidPersistentRuntime();
	decodeRenewalPlan(input.plan);
	if (
		!isOneOf(input.reason, [
			"cancelled_before_transport",
			"inspected_absent_before_drain",
			"inspected_absent_after_owner_loss",
			"lease_expired",
			"lease_revoked",
		]) ||
		!isIso8601(input.observedAt)
	)
		invalidPersistentRuntime();
}

function decodePersistedActive(
	input: unknown,
	workspaceId: WorkspaceId,
): Extract<RuntimeAttachment, { state: "active" }>["active"] {
	if (!strictRecord(input, ["target", "lease", "recovery", "renewal"])) invalidPersistentRuntime();
	const target = decodeRuntimeTarget(input.target);
	const lease = decodeRuntimeLease(input.lease, workspaceId);
	const recovery = decodeRecoveryPlan(input.recovery, workspaceId);
	if (
		target.candidate.providerId !== lease.replica.providerId ||
		target.candidate.profileId !== lease.replica.profileId ||
		!exactJson(recovery.locator.replica, lease.replica) ||
		recovery.locator.leaseId !== lease.leaseId ||
		recovery.locator.fenceId !== lease.fenceId ||
		recovery.locator.baseGeneration !== lease.baseGeneration
	)
		invalidPersistentRuntime();
	if (input.renewal === null || typeof input.renewal !== "object" || Array.isArray(input.renewal))
		invalidPersistentRuntime();
	const state = Object.getOwnPropertyDescriptor(input.renewal, "state")?.value;
	if (state === "complete") {
		if (
			!strictRecord(input.renewal, ["state", "currentLease", "plan", "lastOutcome"]) ||
			input.renewal.plan !== null
		) {
			invalidPersistentRuntime();
		}
	} else if (state === "planned" || state === "outcome_unknown") {
		if (!strictRecord(input.renewal, ["state", "currentLease", "plan", "lastOutcome"])) invalidPersistentRuntime();
		const plan = decodeRenewalPlan(input.renewal.plan);
		if (!runtimeLeaseMatches(plan.expectedLease, lease)) invalidPersistentRuntime();
	} else invalidPersistentRuntime();
	const currentLease = decodeRuntimeLease(input.renewal.currentLease, workspaceId);
	if (!runtimeLeaseMatches(currentLease, lease)) invalidPersistentRuntime();
	decodeRenewalOutcome(input.renewal.lastOutcome);
	return input as unknown as Extract<RuntimeAttachment, { state: "active" }>["active"];
}

function decodeFrozenCheckpointLocator(input: unknown): FrozenReplicaCheckpointLocator {
	if (
		!strictRecord(input, ["providerId", "profileId", "workspaceId", "replicaId", "leaseId", "checkpointId"]) ||
		!isWellFormedString(input.providerId) ||
		!isWellFormedString(input.profileId) ||
		!isWellFormedString(input.workspaceId) ||
		!isWellFormedString(input.replicaId) ||
		!isWellFormedString(input.leaseId) ||
		!isWellFormedString(input.checkpointId)
	)
		invalidPersistentRuntime();
	return {
		providerId: input.providerId,
		profileId: input.profileId,
		workspaceId: input.workspaceId,
		replicaId: input.replicaId,
		leaseId: input.leaseId,
		checkpointId: input.checkpointId,
	};
}

function decodeFrozenCheckpointReference(input: unknown): FrozenReplicaCheckpointRef {
	if (
		!strictRecord(input, [
			"providerId",
			"profileId",
			"workspaceId",
			"replicaId",
			"leaseId",
			"checkpointId",
			"format",
			"baseGeneration",
			"frozenAt",
			"rootSha256",
			"fileCount",
			"byteCount",
		]) ||
		input.format !== "omp-text-v1" ||
		!isSafeCount(input.baseGeneration) ||
		!isIso8601(input.frozenAt) ||
		!isSha256Hex(input.rootSha256) ||
		!isSafeCount(input.fileCount) ||
		!isSafeCount(input.byteCount)
	)
		invalidPersistentRuntime();
	decodeFrozenCheckpointLocator({
		providerId: input.providerId,
		profileId: input.profileId,
		workspaceId: input.workspaceId,
		replicaId: input.replicaId,
		leaseId: input.leaseId,
		checkpointId: input.checkpointId,
	});
	return input as unknown as FrozenReplicaCheckpointRef;
}

function decodeCanonicalCommit(input: unknown, workspaceId: WorkspaceId): CanonicalWorkspaceCommitReceipt {
	if (
		!strictRecord(input, ["workspaceId", "commitId", "expectedGeneration", "checkpoint", "durableAt"]) ||
		input.workspaceId !== workspaceId ||
		!isWellFormedString(input.commitId) ||
		!isSafeCount(input.expectedGeneration) ||
		!isIso8601(input.durableAt)
	)
		invalidPersistentRuntime();
	const checkpoint = decodeWorkspaceCheckpoint(input.checkpoint, workspaceId);
	if (checkpoint.generation !== input.expectedGeneration + 1) invalidPersistentRuntime();
	return input as unknown as CanonicalWorkspaceCommitReceipt;
}

function decodeCacheEvictionPlan(
	input: unknown,
	expectedReplica?: RuntimeLeaseRef["replica"],
): RuntimeReplicaCacheEvictionPlan {
	if (
		!strictRecord(input, [
			"requestId",
			"requestSha256",
			"requestedByOperationId",
			"replica",
			"mode",
			"delayMs",
			"plannedAt",
			"retentionDeadline",
		]) ||
		!isWellFormedString(input.requestId) ||
		!isSha256Hex(input.requestSha256) ||
		!isWellFormedString(input.requestedByOperationId) ||
		!isOneOf(input.mode, ["explicit", "workspace_retention"]) ||
		!isSafeCount(input.delayMs) ||
		!isIso8601(input.plannedAt) ||
		!isIso8601(input.retentionDeadline)
	)
		invalidPersistentRuntime();
	const replica = decodeRuntimeReplica(input.replica);
	if (
		(expectedReplica !== undefined && !exactJson(replica, expectedReplica)) ||
		Date.parse(input.plannedAt) + input.delayMs !== Date.parse(input.retentionDeadline) ||
		input.requestSha256 !==
			tupleSha256([
				"omp-runtime-provider-v1",
				"replica_cache_evict",
				input.requestedByOperationId,
				replica.providerId,
				replica.profileId,
				replica.workspaceId,
				replica.replicaId,
				input.mode,
				input.delayMs,
				input.plannedAt,
				input.retentionDeadline,
			])
	)
		invalidPersistentRuntime();
	return input as unknown as RuntimeReplicaCacheEvictionPlan;
}

function decodeEvictionAcceptance(
	input: unknown,
	plan: RuntimeReplicaCacheEvictionPlan,
): RuntimeReplicaCacheEvictionAcceptance {
	if (
		!strictRecord(input, ["requestId", "requestSha256", "replica", "retentionDeadline", "acceptedAt"]) ||
		input.requestId !== plan.requestId ||
		input.requestSha256 !== plan.requestSha256 ||
		input.retentionDeadline !== plan.retentionDeadline ||
		!isIso8601(input.acceptedAt)
	)
		invalidPersistentRuntime();
	decodeRuntimeReplica(input.replica, plan.replica.workspaceId);
	if (!exactJson(input.replica, plan.replica)) invalidPersistentRuntime();
	return input as unknown as RuntimeReplicaCacheEvictionAcceptance;
}

function decodeEvictionCompletion(
	input: unknown,
	plan: RuntimeReplicaCacheEvictionPlan,
): RuntimeReplicaCacheEvictionCompletion {
	if (
		!strictRecord(input, ["acceptance", "outcome", "completedAt", "receiptSha256"]) ||
		!isOneOf(input.outcome, ["evicted", "already_evicted", "absent"]) ||
		!isIso8601(input.completedAt) ||
		!isSha256Ref(input.receiptSha256)
	)
		invalidPersistentRuntime();
	decodeEvictionAcceptance(input.acceptance, plan);
	return input as unknown as RuntimeReplicaCacheEvictionCompletion;
}

function decodeRecoveryImpossibilityProof(
	input: unknown,
	expectedLocator?: RuntimeAcquisitionPlan["recovery"]["locator"],
): RuntimeRecoveryFreezeImpossibilityProof {
	if (
		!strictRecord(input, ["locator", "code", "proofSha256", "observedAt"]) ||
		!isOneOf(input.code, [
			"replica_absent",
			"replica_image_missing",
			"replica_image_invalid",
			"acknowledged_mutation_ledger_incomplete",
		]) ||
		!isSha256Hex(input.proofSha256) ||
		!isIso8601(input.observedAt)
	)
		invalidPersistentRuntime();
	const locator = decodeRecoveryLocator(input.locator);
	if (expectedLocator !== undefined && !exactJson(locator, expectedLocator)) invalidPersistentRuntime();
	const expectedDigest =
		locator.replica.providerId === "local"
			? tupleSha256([
					"local-recovery-impossibility-v1",
					locator.recoveryFreezeId,
					`${locator.replica.providerId}\u0000${locator.replica.profileId}\u0000${locator.replica.workspaceId}\u0000${locator.replica.replicaId}`,
					locator.leaseId,
					locator.fenceId,
					locator.baseGeneration,
					locator.checkpointId,
					input.code,
				])
			: locator.replica.providerId === "cloudflare"
				? tupleSha256([
						"omp-cloudflare-recovery-impossible-v1",
						locator.recoveryFreezeId,
						locator.replica.workspaceId,
						locator.replica.replicaId,
						locator.leaseId,
						locator.fenceId,
						locator.baseGeneration,
						locator.checkpointId,
						input.code,
						input.observedAt,
					])
				: null;
	if (expectedDigest === null || input.proofSha256 !== expectedDigest) invalidPersistentRuntime();
	return input as unknown as RuntimeRecoveryFreezeImpossibilityProof;
}

function decodeRecoveryFrozenFields(
	input: unknown,
	locator: RuntimeAcquisitionPlan["recovery"]["locator"],
	lease: RuntimeLeaseRef,
): RuntimeRecoveryFreezeFrozenResult {
	if (
		!strictRecord(input, [
			"reference",
			"acknowledgedMutationsSha256",
			"observedRenewalSequence",
			"commandAdmission",
			"activeCommands",
			"pendingSyncs",
			"priorFence",
		]) ||
		!isSha256Hex(input.acknowledgedMutationsSha256) ||
		input.observedRenewalSequence !== lease.renewalSequence ||
		input.commandAdmission !== "closed" ||
		input.activeCommands !== 0 ||
		input.pendingSyncs !== 0 ||
		!isOneOf(input.priorFence, ["recovery_revoked", "already_revoked", "expired"])
	)
		invalidPersistentRuntime();
	const reference = decodeFrozenCheckpointReference(input.reference);
	if (
		reference.providerId !== locator.replica.providerId ||
		reference.profileId !== locator.replica.profileId ||
		reference.workspaceId !== locator.replica.workspaceId ||
		reference.replicaId !== locator.replica.replicaId ||
		reference.leaseId !== locator.leaseId ||
		reference.checkpointId !== locator.checkpointId ||
		reference.baseGeneration !== locator.baseGeneration
	)
		invalidPersistentRuntime();
	return input as unknown as RuntimeRecoveryFreezeFrozenResult;
}

function decodeDiscardAuthorization(
	input: unknown,
	expectedLocator?: RuntimeAcquisitionPlan["recovery"]["locator"],
): Extract<RuntimeAttachment, { state: "none" }>["lastDiscardedRuntimeChanges"] {
	if (input === null) return null;
	if (
		!strictRecord(input, [
			"schemaVersion",
			"discardId",
			"expectedAttachmentRevision",
			"ownerEpoch",
			"impossibility",
			"authorizedAt",
		]) ||
		input.schemaVersion !== 1 ||
		!isWellFormedString(input.discardId) ||
		!isSafeCount(input.expectedAttachmentRevision, 1) ||
		!isSafeCount(input.ownerEpoch) ||
		!isIso8601(input.authorizedAt)
	)
		invalidPersistentRuntime();
	decodeRecoveryImpossibilityProof(input.impossibility, expectedLocator);
	return input as unknown as Extract<RuntimeAttachment, { state: "none" }>["lastDiscardedRuntimeChanges"];
}

function decodeRuntimeDrainPlan(
	input: unknown,
	transitionId: OperationId,
	active: Extract<RuntimeAttachment, { state: "active" }>["active"],
): RuntimeDrainPlan {
	if (
		!strictRecord(input, [
			"transitionId",
			"commitReplica",
			"freezeAuthority",
			"checkpointId",
			"canonicalCommitId",
			"recovery",
			"cacheEvictionPlan",
			"requests",
		]) ||
		input.transitionId !== transitionId ||
		typeof input.commitReplica !== "boolean"
	)
		invalidPersistentRuntime();
	if (input.cacheEvictionPlan !== null) {
		const plan = decodeCacheEvictionPlan(input.cacheEvictionPlan, active.lease.replica);
		if (plan.requestedByOperationId !== transitionId) invalidPersistentRuntime();
	}
	if (!strictRecord(input.requests, ["quiesce", "checkpoint", "revoke", "checkpointAcknowledgement", "release"])) {
		invalidPersistentRuntime();
	}
	if (input.freezeAuthority === "live_fence") {
		if (
			input.commitReplica !== true ||
			!isWellFormedString(input.checkpointId) ||
			!isWellFormedString(input.canonicalCommitId) ||
			input.recovery !== null ||
			input.requests.quiesce === null ||
			input.requests.checkpoint === null ||
			input.requests.revoke === null ||
			input.requests.checkpointAcknowledgement === null
		)
			invalidPersistentRuntime();
		const quiesce = decodeTransitionRequest(input.requests.quiesce, transitionId);
		const checkpoint = decodeTransitionRequest(input.requests.checkpoint, transitionId);
		const revoke = decodeTransitionRequest(input.requests.revoke, transitionId);
		const acknowledgement = decodeParentRequestPreallocation(input.requests.checkpointAcknowledgement, transitionId);
		const release = decodeParentRequest(input.requests.release, transitionId);
		const lease = active.lease;
		if (
			quiesce.requestId !==
				derivedProviderRequestId(lease.replica.workspaceId, "runtime_transition", transitionId, 0, "quiesce") ||
			quiesce.requestSha256 !==
				tupleSha256([
					"omp-runtime-provider-v1",
					"quiesce",
					transitionId,
					lease.replica.providerId,
					lease.replica.profileId,
					lease.replica.workspaceId,
					lease.replica.replicaId,
					lease.leaseId,
					lease.fenceId,
					lease.baseGeneration,
				]) ||
			checkpoint.requestId !==
				derivedProviderRequestId(lease.replica.workspaceId, "runtime_transition", transitionId, 1, "checkpoint") ||
			checkpoint.requestSha256 !==
				tupleSha256([
					"omp-runtime-provider-v1",
					"checkpoint",
					transitionId,
					lease.replica.providerId,
					lease.replica.profileId,
					lease.replica.workspaceId,
					lease.replica.replicaId,
					lease.leaseId,
					lease.fenceId,
					input.checkpointId,
					lease.baseGeneration,
				]) ||
			revoke.requestId !==
				derivedProviderRequestId(lease.replica.workspaceId, "runtime_transition", transitionId, 2, "revoke") ||
			revoke.requestSha256 !==
				tupleSha256([
					"omp-runtime-provider-v1",
					"revoke",
					transitionId,
					lease.replica.providerId,
					lease.replica.profileId,
					lease.replica.workspaceId,
					lease.replica.replicaId,
					lease.leaseId,
					lease.fenceId,
					"operation_admission_closed",
				]) ||
			acknowledgement.requestId !==
				derivedProviderRequestId(
					lease.replica.workspaceId,
					"runtime_transition",
					transitionId,
					3,
					"checkpoint_acknowledgement",
				) ||
			release.requestId !==
				derivedProviderRequestId(lease.replica.workspaceId, "runtime_transition", transitionId, 4, "release") ||
			release.requestSha256 !==
				tupleSha256([
					"omp-runtime-provider-v1",
					"release",
					transitionId,
					lease.replica.providerId,
					lease.replica.profileId,
					lease.replica.workspaceId,
					lease.replica.replicaId,
					lease.leaseId,
				])
		)
			invalidPersistentRuntime();
	} else if (input.freezeAuthority === "control_plane_recovery") {
		if (
			input.commitReplica !== true ||
			!isWellFormedString(input.checkpointId) ||
			!isWellFormedString(input.canonicalCommitId) ||
			input.requests.quiesce !== null ||
			input.requests.checkpoint !== null ||
			input.requests.revoke !== null ||
			input.recovery === null
		)
			invalidPersistentRuntime();
		const recovery = decodeRecoveryPlan(input.recovery, active.lease.replica.workspaceId);
		if (
			!exactJson(recovery, active.recovery) ||
			input.checkpointId !== recovery.locator.checkpointId ||
			input.canonicalCommitId !== recovery.canonicalCommitId ||
			!exactJson(input.requests.checkpointAcknowledgement, recovery.requests.checkpointAcknowledgement) ||
			!exactJson(input.requests.release, recovery.requests.release)
		)
			invalidPersistentRuntime();
	} else if (input.freezeAuthority === "none") {
		if (
			input.commitReplica !== false ||
			input.checkpointId !== null ||
			input.canonicalCommitId !== null ||
			input.recovery !== null ||
			input.cacheEvictionPlan !== null ||
			input.requests.quiesce === null ||
			input.requests.checkpoint !== null ||
			input.requests.revoke === null ||
			input.requests.checkpointAcknowledgement !== null
		)
			invalidPersistentRuntime();
		const quiesce = decodeTransitionRequest(input.requests.quiesce, transitionId);
		const revoke = decodeTransitionRequest(input.requests.revoke, transitionId);
		const release = decodeParentRequest(input.requests.release, transitionId);
		const lease = active.lease;
		if (
			quiesce.requestId !==
				derivedProviderRequestId(lease.replica.workspaceId, "runtime_transition", transitionId, 0, "quiesce") ||
			quiesce.requestSha256 !==
				tupleSha256([
					"omp-runtime-provider-v1",
					"quiesce",
					transitionId,
					lease.replica.providerId,
					lease.replica.profileId,
					lease.replica.workspaceId,
					lease.replica.replicaId,
					lease.leaseId,
					lease.fenceId,
					lease.baseGeneration,
				]) ||
			revoke.requestId !==
				derivedProviderRequestId(lease.replica.workspaceId, "runtime_transition", transitionId, 2, "revoke") ||
			revoke.requestSha256 !==
				tupleSha256([
					"omp-runtime-provider-v1",
					"revoke",
					transitionId,
					lease.replica.providerId,
					lease.replica.profileId,
					lease.replica.workspaceId,
					lease.replica.replicaId,
					lease.leaseId,
					lease.fenceId,
					"operation_admission_closed",
				]) ||
			release.requestId !==
				derivedProviderRequestId(lease.replica.workspaceId, "runtime_transition", transitionId, 4, "release") ||
			release.requestSha256 !==
				tupleSha256([
					"omp-runtime-provider-v1",
					"release",
					transitionId,
					lease.replica.providerId,
					lease.replica.profileId,
					lease.replica.workspaceId,
					lease.replica.replicaId,
					lease.leaseId,
				])
		)
			invalidPersistentRuntime();
	} else invalidPersistentRuntime();
	return input as unknown as RuntimeDrainPlan;
}

function decodeCheckpointPublication(
	input: unknown,
	plan: RuntimeDrainPlan,
	active: Extract<RuntimeAttachment, { state: "active" }>["active"],
): Extract<RuntimeAttachment, { state: "draining" }>["publication"] {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input))
		invalidPersistentRuntime();
	const state = Object.getOwnPropertyDescriptor(input, "state")?.value;
	if (state === "not_requested") {
		if (!strictRecord(input, ["state"])) invalidPersistentRuntime();
		return input as Extract<RuntimeAttachment, { state: "draining" }>["publication"];
	}
	if (state === "freeze_outcome_unknown") {
		if (!strictRecord(input, ["state", "locator"])) invalidPersistentRuntime();
		const locator = decodeFrozenCheckpointLocator(input.locator);
		if (
			locator.providerId !== active.lease.replica.providerId ||
			locator.profileId !== active.lease.replica.profileId ||
			locator.workspaceId !== active.lease.replica.workspaceId ||
			locator.replicaId !== active.lease.replica.replicaId ||
			locator.leaseId !== active.lease.leaseId ||
			locator.checkpointId !== plan.checkpointId
		)
			invalidPersistentRuntime();
		return input as unknown as Extract<RuntimeAttachment, { state: "draining" }>["publication"];
	}
	if (!isOneOf(state, ["frozen", "committed", "acknowledged"])) invalidPersistentRuntime();
	const keys =
		state === "frozen"
			? ["state", "reference"]
			: state === "committed"
				? ["state", "reference", "canonicalCommit", "acknowledgementRequest"]
				: ["state", "reference", "canonicalCommit", "acknowledgementRequest", "acknowledgement"];
	if (!strictRecord(input, keys)) invalidPersistentRuntime();
	const reference = decodeFrozenCheckpointReference(input.reference);
	if (
		reference.providerId !== active.lease.replica.providerId ||
		reference.profileId !== active.lease.replica.profileId ||
		reference.workspaceId !== active.lease.replica.workspaceId ||
		reference.replicaId !== active.lease.replica.replicaId ||
		reference.leaseId !== active.lease.leaseId ||
		reference.checkpointId !== plan.checkpointId ||
		reference.baseGeneration !== active.lease.baseGeneration
	)
		invalidPersistentRuntime();
	if (state === "frozen") return input as unknown as Extract<RuntimeAttachment, { state: "draining" }>["publication"];
	const commit = decodeCanonicalCommit(input.canonicalCommit, active.lease.replica.workspaceId);
	if (
		commit.commitId !== plan.canonicalCommitId ||
		commit.expectedGeneration !== active.lease.baseGeneration ||
		!workspaceImagesMatch(commit.checkpoint, reference)
	)
		invalidPersistentRuntime();
	if (
		!strictRecord(input.acknowledgementRequest, [
			"parentOperationId",
			"requestId",
			"requestSha256",
			"reference",
			"canonicalCommit",
		]) ||
		!exactJson(input.acknowledgementRequest.reference, reference) ||
		!exactJson(input.acknowledgementRequest.canonicalCommit, commit)
	)
		invalidPersistentRuntime();
	const request = input.acknowledgementRequest;
	const preallocation = plan.requests.checkpointAcknowledgement;
	if (
		preallocation === null ||
		request.parentOperationId !== preallocation.parentOperationId ||
		request.requestId !== preallocation.requestId ||
		!isSha256Hex(request.requestSha256) ||
		request.requestSha256 !==
			tupleSha256([
				"omp-runtime-provider-v1",
				"checkpoint_ack",
				request.parentOperationId,
				reference.providerId,
				reference.profileId,
				reference.workspaceId,
				reference.replicaId,
				reference.leaseId,
				reference.checkpointId,
				reference.baseGeneration,
				commit.commitId,
				commit.checkpoint.generation,
				commit.checkpoint.rootSha256,
				commit.checkpoint.fileCount,
				commit.checkpoint.byteCount,
			])
	)
		invalidPersistentRuntime();
	if (state === "acknowledged") {
		if (
			!strictRecord(input.acknowledgement, [
				"status",
				"request",
				"reference",
				"canonicalCommit",
				"acknowledgedAt",
			]) ||
			!isOneOf(input.acknowledgement.status, ["acknowledged", "already_acknowledged"]) ||
			!exactJson(input.acknowledgement.request, {
				parentOperationId: request.parentOperationId,
				requestId: request.requestId,
				requestSha256: request.requestSha256,
			}) ||
			!exactJson(input.acknowledgement.reference, reference) ||
			!exactJson(input.acknowledgement.canonicalCommit, commit) ||
			!isIso8601(input.acknowledgement.acknowledgedAt)
		)
			invalidPersistentRuntime();
	}
	return input as unknown as Extract<RuntimeAttachment, { state: "draining" }>["publication"];
}

function decodeRecoveryFreezeProgress(
	input: unknown,
	active: Extract<RuntimeAttachment, { state: "active" }>["active"],
): Extract<RuntimeAttachment, { state: "draining" }>["recoveryFreeze"] {
	if (input === null) return null;
	if (!proxyFreeData(input) || typeof input !== "object" || Array.isArray(input)) invalidPersistentRuntime();
	const state = Object.getOwnPropertyDescriptor(input, "state")?.value;
	if (state === "not_started") {
		if (!strictRecord(input, ["state"])) invalidPersistentRuntime();
	} else if (state === "outcome_unknown") {
		if (
			!strictRecord(input, ["state", "locator"]) ||
			!exactJson(decodeRecoveryLocator(input.locator), active.recovery.locator)
		) {
			invalidPersistentRuntime();
		}
	} else if (state === "in_progress") {
		if (
			!strictRecord(input, ["state", "locator", "phase", "activeCommands", "pendingSyncs", "observedAt"]) ||
			!exactJson(decodeRecoveryLocator(input.locator), active.recovery.locator) ||
			!isOneOf(input.phase, ["sealing_admission", "reconciling_commands", "freezing_checkpoint"]) ||
			!isSafeCount(input.activeCommands) ||
			!isSafeCount(input.pendingSyncs) ||
			!isIso8601(input.observedAt)
		)
			invalidPersistentRuntime();
	} else if (state === "frozen") {
		if (!strictRecord(input, ["state", "result"])) invalidPersistentRuntime();
		decodeRecoveryFrozenFields(input.result, active.recovery.locator, active.lease);
	} else if (state === "preservation_impossible") {
		if (!strictRecord(input, ["state", "proof"])) invalidPersistentRuntime();
		decodeRecoveryImpossibilityProof(input.proof, active.recovery.locator);
	} else invalidPersistentRuntime();
	return input as unknown as Extract<RuntimeAttachment, { state: "draining" }>["recoveryFreeze"];
}

function decodeDrainCacheEvictionProgress(
	input: unknown,
	plan: RuntimeReplicaCacheEvictionPlan | null,
): RuntimeDrainCacheEvictionProgress {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input))
		invalidPersistentRuntime();
	const state = Object.getOwnPropertyDescriptor(input, "state")?.value;
	if (state === "not_required") {
		if (!strictRecord(input, ["state"]) || plan !== null) invalidPersistentRuntime();
	} else if (state === "planned" || state === "submission_outcome_unknown") {
		if (!strictRecord(input, ["state"]) || plan === null) invalidPersistentRuntime();
	} else {
		if (plan === null) invalidPersistentRuntime();
		if (state === "inspection_pending") {
			if (
				!strictRecord(input, ["state", "pending"]) ||
				!strictRecord(input.pending, [
					"requestId",
					"requestSha256",
					"replica",
					"retentionDeadline",
					"observedAt",
				]) ||
				input.pending.requestId !== plan.requestId ||
				input.pending.requestSha256 !== plan.requestSha256 ||
				input.pending.retentionDeadline !== plan.retentionDeadline ||
				!isIso8601(input.pending.observedAt)
			)
				invalidPersistentRuntime();
			decodeRuntimeReplica(input.pending.replica, plan.replica.workspaceId);
			if (!exactJson(input.pending.replica, plan.replica)) invalidPersistentRuntime();
		} else if (state === "accepted") {
			if (!strictRecord(input, ["state", "acceptance"])) invalidPersistentRuntime();
			decodeEvictionAcceptance(input.acceptance, plan);
		} else if (state === "deferred") {
			if (
				!strictRecord(input, ["state", "acceptance", "reason", "nextAttemptAt"]) ||
				!isOneOf(input.reason, [
					"not_released",
					"active_compute",
					"compute_ambiguous",
					"checkpoint_unacknowledged",
					"command_or_sync_ambiguous",
				]) ||
				!isIso8601(input.nextAttemptAt)
			)
				invalidPersistentRuntime();
			decodeEvictionAcceptance(input.acceptance, plan);
		} else if (state === "rejected") {
			if (
				!strictRecord(input, ["state", "rejection"]) ||
				!strictRecord(input.rejection, [
					"requestId",
					"requestSha256",
					"replica",
					"retentionDeadline",
					"code",
					"observedAt",
				]) ||
				input.rejection.requestId !== plan.requestId ||
				input.rejection.requestSha256 !== plan.requestSha256 ||
				input.rejection.retentionDeadline !== plan.retentionDeadline ||
				input.rejection.code !== "provider_request_rejected" ||
				!isIso8601(input.rejection.observedAt)
			)
				invalidPersistentRuntime();
			decodeRuntimeReplica(input.rejection.replica, plan.replica.workspaceId);
			if (!exactJson(input.rejection.replica, plan.replica)) invalidPersistentRuntime();
		} else if (state === "deadline_mismatch") {
			if (
				!strictRecord(input, ["state", "mismatch"]) ||
				!strictRecord(input.mismatch, [
					"requestId",
					"requestSha256",
					"replica",
					"plannedRetentionDeadline",
					"providerRetentionDeadline",
					"observedAt",
				]) ||
				input.mismatch.requestId !== plan.requestId ||
				input.mismatch.requestSha256 !== plan.requestSha256 ||
				input.mismatch.plannedRetentionDeadline !== plan.retentionDeadline ||
				input.mismatch.providerRetentionDeadline === plan.retentionDeadline ||
				!isIso8601(input.mismatch.providerRetentionDeadline) ||
				!isIso8601(input.mismatch.observedAt)
			)
				invalidPersistentRuntime();
			decodeRuntimeReplica(input.mismatch.replica, plan.replica.workspaceId);
			if (!exactJson(input.mismatch.replica, plan.replica)) invalidPersistentRuntime();
		} else if (state === "complete") {
			if (!strictRecord(input, ["state", "result"])) invalidPersistentRuntime();
			decodeEvictionCompletion(input.result, plan);
		} else invalidPersistentRuntime();
	}
	return input as unknown as RuntimeDrainCacheEvictionProgress;
}

function decodeRuntimeAttachment(input: unknown, workspaceId: WorkspaceId): RuntimeAttachment {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input))
		invalidPersistentRuntime();
	const state = Object.getOwnPropertyDescriptor(input, "state")?.value;
	if (state === "none") {
		if (
			!strictRecord(input, ["state", "transitionId", "active", "lastDiscardedRuntimeChanges", "block"]) ||
			input.transitionId !== null ||
			input.active !== null
		) {
			invalidPersistentRuntime();
		}
		decodeDiscardAuthorization(input.lastDiscardedRuntimeChanges);
		decodeRuntimeBlock(input.block);
	} else if (state === "acquiring") {
		if (
			!strictRecord(input, [
				"state",
				"transitionId",
				"active",
				"plan",
				"progress",
				"lastDiscardedRuntimeChanges",
				"block",
			]) ||
			!isWellFormedString(input.transitionId) ||
			input.active !== null
		)
			invalidPersistentRuntime();
		const plan = decodeRuntimeAcquisitionPlan(input.plan, workspaceId);
		if (plan.transitionId !== input.transitionId) invalidPersistentRuntime();
		decodeRuntimeAcquireProgress(input.progress, plan);
		decodeDiscardAuthorization(input.lastDiscardedRuntimeChanges);
		decodeRuntimeBlock(input.block);
	} else if (state === "active") {
		if (
			!strictRecord(input, ["state", "transitionId", "active", "lastDiscardedRuntimeChanges", "block"]) ||
			input.transitionId !== null ||
			input.block !== null
		) {
			invalidPersistentRuntime();
		}
		decodePersistedActive(input.active, workspaceId);
		decodeDiscardAuthorization(input.lastDiscardedRuntimeChanges);
	} else if (state === "draining") {
		if (
			!strictRecord(input, [
				"state",
				"transitionId",
				"active",
				"reason",
				"plan",
				"publication",
				"recoveryFreeze",
				"cacheEviction",
				"discardAuthorization",
				"lastDiscardedRuntimeChanges",
				"block",
			]) ||
			!isWellFormedString(input.transitionId) ||
			!isOneOf(input.reason, RUNTIME_TRANSITION_REASONS)
		)
			invalidPersistentRuntime();
		const active = decodePersistedActive(input.active, workspaceId);
		const plan = decodeRuntimeDrainPlan(input.plan, input.transitionId as OperationId, active);
		decodeCheckpointPublication(input.publication, plan, active);
		const recoveryFreeze = decodeRecoveryFreezeProgress(input.recoveryFreeze, active);
		if ((plan.freezeAuthority === "control_plane_recovery") !== (recoveryFreeze !== null)) invalidPersistentRuntime();
		decodeDrainCacheEvictionProgress(input.cacheEviction, plan.cacheEvictionPlan);
		const discard = decodeDiscardAuthorization(input.discardAuthorization, active.recovery.locator);
		decodeDiscardAuthorization(input.lastDiscardedRuntimeChanges);
		if (
			discard !== null &&
			(plan.freezeAuthority !== "control_plane_recovery" ||
				recoveryFreeze?.state !== "preservation_impossible" ||
				!exactJson(discard.impossibility, recoveryFreeze.proof))
		)
			invalidPersistentRuntime();
		decodeRuntimeBlock(input.block);
	} else invalidPersistentRuntime();
	return input as unknown as RuntimeAttachment;
}

function decodeRuntimeAttachmentRecordV1(input: unknown, workspaceId?: WorkspaceId): RuntimeAttachmentRecordV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"createId",
			"revision",
			"workspaceId",
			"attachment",
			"scheduler",
			"lastCompletedTransition",
			"updatedAt",
		]) ||
		input.schemaVersion !== 1 ||
		!isWellFormedString(input.createId) ||
		!isSafeCount(input.revision, 1) ||
		!isWellFormedString(input.workspaceId) ||
		(workspaceId !== undefined && input.workspaceId !== workspaceId) ||
		!isIso8601(input.updatedAt)
	)
		invalidPersistentRuntime();
	const attachment = decodeRuntimeAttachment(input.attachment, input.workspaceId as WorkspaceId);
	if (
		attachment.state === "draining" &&
		attachment.discardAuthorization !== null &&
		attachment.discardAuthorization.expectedAttachmentRevision !== (input.revision as number) - 1
	)
		invalidPersistentRuntime();
	decodeRuntimeScheduler(input.scheduler);
	if (input.lastCompletedTransition !== null) {
		const completed = decodeCompletedTransition(input.lastCompletedTransition);
		if (Date.parse(completed.completedAt) > Date.parse(input.updatedAt)) invalidPersistentRuntime();
	}
	return input as unknown as RuntimeAttachmentRecordV1;
}

function controllerObservation(lease: WorkspaceControllerLease): WorkspaceControllerLeaseObservation {
	return {
		workspaceId: lease.proof.workspaceId,
		agentId: lease.proof.agentId,
		controlHostId: lease.proof.controlHostId,
		ownerEpoch: lease.proof.ownerEpoch,
		acquiredAt: lease.acquiredAt,
		renewBy: lease.renewBy,
		expiresAt: lease.expiresAt,
	};
}

function deletionObservation(authority: WorkspaceDeletionAuthority): WorkspaceDeletionAuthorityObservation {
	return {
		workspaceId: authority.proof.workspaceId,
		deleteId: authority.proof.deleteId,
		deletionAuthorityId: authority.proof.deletionAuthorityId,
		deletionPlanCoreSha256: authority.proof.deletionPlanCoreSha256,
		deletionPlanSha256: authority.proof.deletionPlanSha256,
		agentId: authority.proof.agentId,
		controlHostId: authority.proof.controlHostId,
		ownerEpoch: authority.proof.ownerEpoch,
		expectedGeneration: authority.expectedGeneration,
		expectedRuntimeAttachmentCreateId: authority.expectedRuntimeAttachmentCreateId,
		expectedRuntimeAttachmentRevision: authority.expectedRuntimeAttachmentRevision,
		verification: authority.verification === null ? "pending" : "verified",
		acquiredAt: authority.acquiredAt,
		renewBy: authority.renewBy,
		expiresAt: authority.expiresAt,
	};
}

function ownershipMatches(
	proof: {
		readonly agentId: string;
		readonly controlHostId: string;
		readonly ownerEpoch: number;
	},
	ownership: PersistentAgentOwnership,
): boolean {
	return (
		ownership.isHeld() &&
		ownership.agentId === proof.agentId &&
		ownership.controlHostId === proof.controlHostId &&
		ownership.ownerEpoch === proof.ownerEpoch
	);
}

function leaseProofMatches(left: WorkspaceControllerLeaseProof, right: WorkspaceControllerLeaseProof): boolean {
	return (
		left.workspaceId === right.workspaceId &&
		left.agentId === right.agentId &&
		left.controlHostId === right.controlHostId &&
		left.ownerEpoch === right.ownerEpoch &&
		left.leaseId === right.leaseId &&
		left.epoch === right.epoch
	);
}

function deletionProofMatches(left: WorkspaceDeletionAuthorityProof, right: WorkspaceDeletionAuthorityProof): boolean {
	return (
		left.workspaceId === right.workspaceId &&
		left.deleteId === right.deleteId &&
		left.deletionAuthorityId === right.deletionAuthorityId &&
		left.deletionPlanCoreSha256 === right.deletionPlanCoreSha256 &&
		left.deletionPlanSha256 === right.deletionPlanSha256 &&
		left.agentId === right.agentId &&
		left.controlHostId === right.controlHostId &&
		left.ownerEpoch === right.ownerEpoch &&
		left.epoch === right.epoch
	);
}

interface RuntimeTimingStateV1 {
	readonly schemaVersion: 1;
	readonly placement: "idle" | "active";
	readonly transition: {
		readonly transitionId: OperationId;
		readonly startedAt: ISO8601;
	} | null;
	readonly accumulatedActiveRuntimeMs: number;
	readonly accumulatedZeroRuntimeIdleMs: number;
	readonly observedThrough: ISO8601;
}

interface WorkspaceControllerStateV1 {
	readonly schemaVersion: 1;
	readonly workspaceId: WorkspaceId;
	readonly controllerEpoch: number;
	readonly controller: WorkspaceControllerLease | null;
	readonly deletionEpoch: number;
	readonly deletion: WorkspaceDeletionAuthority | null;
	readonly tombstone: WorkspaceTombstone | null;
	readonly attachment: RuntimeAttachmentRecordV1 | null;
	readonly timing: RuntimeTimingStateV1 | null;
}

function emptyControllerState(workspaceId: WorkspaceId): WorkspaceControllerStateV1 {
	return {
		schemaVersion: 1,
		workspaceId,
		controllerEpoch: 0,
		controller: null,
		deletionEpoch: 0,
		deletion: null,
		tombstone: null,
		attachment: null,
		timing: null,
	};
}

function decodeControllerLease(input: unknown, workspaceId: WorkspaceId, epoch: number): WorkspaceControllerLease {
	if (!strictRecord(input, ["proof", "acquiredAt", "renewBy", "expiresAt"])) invalidPersistentRuntime();
	if (
		!strictRecord(input.proof, ["workspaceId", "agentId", "controlHostId", "ownerEpoch", "leaseId", "epoch"]) ||
		input.proof.workspaceId !== workspaceId ||
		!isWellFormedString(input.proof.agentId) ||
		!isWellFormedString(input.proof.controlHostId) ||
		!isSafeCount(input.proof.ownerEpoch) ||
		!isWellFormedString(input.proof.leaseId) ||
		input.proof.epoch !== epoch ||
		epoch < 1 ||
		!isIso8601(input.acquiredAt) ||
		!isIso8601(input.renewBy) ||
		!isIso8601(input.expiresAt) ||
		Date.parse(input.renewBy) <= Date.parse(input.acquiredAt) ||
		Date.parse(input.expiresAt) <= Date.parse(input.renewBy)
	)
		invalidPersistentRuntime();
	return input as unknown as WorkspaceControllerLease;
}

function decodeDeletionVerification(
	input: unknown,
	proof: WorkspaceDeletionAuthorityProof,
	expectedGeneration: number,
	expectedCreateId: OperationId,
	expectedRevision: number,
): WorkspaceDeletionVerificationReceiptV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"workspaceId",
			"deleteId",
			"deletionAuthorityId",
			"deletionPlanCoreSha256",
			"deletionPlanSha256",
			"deletionEpoch",
			"canonicalGeneration",
			"runtimeAttachmentCreateId",
			"runtimeAttachmentRevision",
			"runtimeAttachmentState",
			"verifiedAt",
			"receiptSha256",
		]) ||
		input.schemaVersion !== 1 ||
		input.workspaceId !== proof.workspaceId ||
		input.deleteId !== proof.deleteId ||
		input.deletionAuthorityId !== proof.deletionAuthorityId ||
		input.deletionPlanCoreSha256 !== proof.deletionPlanCoreSha256 ||
		input.deletionPlanSha256 !== proof.deletionPlanSha256 ||
		input.deletionEpoch !== proof.epoch ||
		input.canonicalGeneration !== expectedGeneration ||
		input.runtimeAttachmentCreateId !== expectedCreateId ||
		input.runtimeAttachmentRevision !== expectedRevision ||
		input.runtimeAttachmentState !== "none" ||
		!isIso8601(input.verifiedAt) ||
		!isSha256Ref(input.receiptSha256)
	)
		invalidPersistentRuntime();
	const expectedReceiptSha256 = `sha256:${tupleSha256([
		"omp-workspace-deletion-verification-v1",
		proof.workspaceId,
		proof.deleteId,
		proof.deletionAuthorityId,
		proof.deletionPlanCoreSha256,
		proof.deletionPlanSha256,
		proof.epoch,
		expectedGeneration,
		expectedCreateId,
		expectedRevision,
		"none",
		input.verifiedAt,
	])}`;
	if (input.receiptSha256 !== expectedReceiptSha256) invalidPersistentRuntime();
	return input as unknown as WorkspaceDeletionVerificationReceiptV1;
}

function decodeDeletionAuthority(
	input: unknown,
	workspaceId: WorkspaceId,
	deletionEpoch: number,
	controllerEpoch: number,
): WorkspaceDeletionAuthority {
	if (
		!strictRecord(input, [
			"proof",
			"expectedGeneration",
			"expectedRuntimeAttachmentCreateId",
			"expectedRuntimeAttachmentRevision",
			"invalidatedControllerEpoch",
			"verification",
			"acquiredAt",
			"renewBy",
			"expiresAt",
		]) ||
		!strictRecord(input.proof, [
			"workspaceId",
			"deleteId",
			"deletionAuthorityId",
			"deletionPlanCoreSha256",
			"deletionPlanSha256",
			"agentId",
			"controlHostId",
			"ownerEpoch",
			"epoch",
		]) ||
		input.proof.workspaceId !== workspaceId ||
		!isWellFormedString(input.proof.deleteId) ||
		!isWellFormedString(input.proof.deletionAuthorityId) ||
		!isSha256Ref(input.proof.deletionPlanCoreSha256) ||
		!isSha256Ref(input.proof.deletionPlanSha256) ||
		!isWellFormedString(input.proof.agentId) ||
		!isWellFormedString(input.proof.controlHostId) ||
		!isSafeCount(input.proof.ownerEpoch) ||
		input.proof.epoch !== deletionEpoch ||
		deletionEpoch < 1 ||
		!isSafeCount(input.expectedGeneration) ||
		!isWellFormedString(input.expectedRuntimeAttachmentCreateId) ||
		!isSafeCount(input.expectedRuntimeAttachmentRevision, 1) ||
		input.invalidatedControllerEpoch !== controllerEpoch ||
		controllerEpoch < 1 ||
		!isIso8601(input.acquiredAt) ||
		!isIso8601(input.renewBy) ||
		!isIso8601(input.expiresAt) ||
		Date.parse(input.renewBy) <= Date.parse(input.acquiredAt) ||
		Date.parse(input.expiresAt) <= Date.parse(input.renewBy)
	)
		invalidPersistentRuntime();
	const proof = input.proof as unknown as WorkspaceDeletionAuthorityProof;
	if (input.verification !== null) {
		const verification = decodeDeletionVerification(
			input.verification,
			proof,
			input.expectedGeneration as number,
			input.expectedRuntimeAttachmentCreateId as OperationId,
			input.expectedRuntimeAttachmentRevision as number,
		);
		if (Date.parse(verification.verifiedAt) < Date.parse(input.acquiredAt as ISO8601)) invalidPersistentRuntime();
	}
	return input as unknown as WorkspaceDeletionAuthority;
}

function decodeWorkspaceTombstone(input: unknown, workspaceId: WorkspaceId): WorkspaceTombstone {
	if (
		!strictRecord(input, [
			"workspaceId",
			"deleteId",
			"deletionAuthorityId",
			"quarantineId",
			"deletedAt",
			"lastCheckpoint",
			"purgeAfter",
		]) ||
		input.workspaceId !== workspaceId ||
		!isWellFormedString(input.deleteId) ||
		!isWellFormedString(input.deletionAuthorityId) ||
		!isWellFormedString(input.quarantineId) ||
		!isIso8601(input.deletedAt) ||
		!isIso8601(input.purgeAfter) ||
		Date.parse(input.purgeAfter) < Date.parse(input.deletedAt)
	)
		invalidPersistentRuntime();
	decodeWorkspaceCheckpoint(input.lastCheckpoint, workspaceId);
	return input as unknown as WorkspaceTombstone;
}

function runtimeTimingPlacement(attachment: RuntimeAttachment): RuntimeTimingStateV1["placement"] {
	return attachment.state === "active" || attachment.state === "draining" ? "active" : "idle";
}

function decodeRuntimeTiming(input: unknown, attachment: RuntimeAttachmentRecordV1): RuntimeTimingStateV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"placement",
			"transition",
			"accumulatedActiveRuntimeMs",
			"accumulatedZeroRuntimeIdleMs",
			"observedThrough",
		]) ||
		input.schemaVersion !== 1 ||
		input.placement !== runtimeTimingPlacement(attachment.attachment) ||
		!isSafeCount(input.accumulatedActiveRuntimeMs) ||
		!isSafeCount(input.accumulatedZeroRuntimeIdleMs) ||
		!isIso8601(input.observedThrough) ||
		input.observedThrough !== attachment.updatedAt
	)
		invalidPersistentRuntime();
	const transitionId = attachment.attachment.transitionId;
	if (transitionId === null) {
		if (input.transition !== null) invalidPersistentRuntime();
	} else {
		if (
			!strictRecord(input.transition, ["transitionId", "startedAt"]) ||
			input.transition.transitionId !== transitionId ||
			!isIso8601(input.transition.startedAt) ||
			Date.parse(input.transition.startedAt) > Date.parse(input.observedThrough)
		)
			invalidPersistentRuntime();
	}
	return input as unknown as RuntimeTimingStateV1;
}

function controllerState(workspaceId: WorkspaceId, input: unknown | null): WorkspaceControllerStateV1 {
	if (input === null) return emptyControllerState(workspaceId);
	if (
		!strictRecord(input, [
			"schemaVersion",
			"workspaceId",
			"controllerEpoch",
			"controller",
			"deletionEpoch",
			"deletion",
			"tombstone",
			"attachment",
			"timing",
		]) ||
		input.schemaVersion !== 1 ||
		input.workspaceId !== workspaceId ||
		!isSafeCount(input.controllerEpoch) ||
		!isSafeCount(input.deletionEpoch) ||
		(input.controller !== null && input.deletion !== null) ||
		(input.tombstone !== null && (input.controller !== null || input.deletion !== null)) ||
		(input.attachment === null) !== (input.timing === null)
	)
		invalidPersistentRuntime();
	const controller =
		input.controller === null
			? null
			: decodeControllerLease(input.controller, workspaceId, input.controllerEpoch as number);
	const deletion =
		input.deletion === null
			? null
			: decodeDeletionAuthority(
					input.deletion,
					workspaceId,
					input.deletionEpoch as number,
					input.controllerEpoch as number,
				);
	const tombstone = input.tombstone === null ? null : decodeWorkspaceTombstone(input.tombstone, workspaceId);
	const attachment = input.attachment === null ? null : decodeRuntimeAttachmentRecordV1(input.attachment, workspaceId);
	if (attachment !== null && input.timing !== null) decodeRuntimeTiming(input.timing, attachment);
	if (deletion?.verification) {
		if (
			attachment === null ||
			attachment.createId !== deletion.expectedRuntimeAttachmentCreateId ||
			attachment.revision !== deletion.expectedRuntimeAttachmentRevision ||
			attachment.attachment.state !== "none"
		)
			invalidPersistentRuntime();
	}
	void controller;
	void tombstone;
	return input as unknown as WorkspaceControllerStateV1;
}

type RuntimeTimingReaderV1 = (workspaceId: WorkspaceId) => Promise<RuntimeTimingStateV1 | null>;

const runtimeTimingReadersV1 = new WeakMap<RuntimeAttachmentStore, RuntimeTimingReaderV1>();

function initialRuntimeTiming(record: RuntimeAttachmentRecordV1): RuntimeTimingStateV1 {
	return {
		schemaVersion: 1,
		placement: runtimeTimingPlacement(record.attachment),
		transition:
			record.attachment.transitionId === null
				? null
				: { transitionId: record.attachment.transitionId, startedAt: record.updatedAt },
		accumulatedActiveRuntimeMs: 0,
		accumulatedZeroRuntimeIdleMs: 0,
		observedThrough: record.updatedAt,
	};
}

function advanceRuntimeTiming(current: RuntimeTimingStateV1, next: RuntimeAttachmentRecordV1): RuntimeTimingStateV1 {
	const elapsed = Date.parse(next.updatedAt) - Date.parse(current.observedThrough);
	if (!Number.isSafeInteger(elapsed) || elapsed < 0) invalidPersistentRuntime();
	const accumulatedActiveRuntimeMs =
		current.accumulatedActiveRuntimeMs + (current.placement === "active" ? elapsed : 0);
	const accumulatedZeroRuntimeIdleMs =
		current.accumulatedZeroRuntimeIdleMs + (current.placement === "idle" ? elapsed : 0);
	if (!Number.isSafeInteger(accumulatedActiveRuntimeMs) || !Number.isSafeInteger(accumulatedZeroRuntimeIdleMs)) {
		invalidPersistentRuntime();
	}
	const transitionId = next.attachment.transitionId;
	const transitionStartedAt =
		next.attachment.state === "acquiring" && next.scheduler.evaluatedAt !== null
			? next.scheduler.evaluatedAt
			: next.updatedAt;
	return {
		schemaVersion: 1,
		placement: runtimeTimingPlacement(next.attachment),
		transition:
			transitionId === null
				? null
				: current.transition?.transitionId === transitionId
					? current.transition
					: { transitionId, startedAt: transitionStartedAt },
		accumulatedActiveRuntimeMs,
		accumulatedZeroRuntimeIdleMs,
		observedThrough: next.updatedAt,
	};
}

interface TransientTaskRuntimeStateV1 {
	readonly schemaVersion: 1;
	readonly key: TransientTaskWorkspaceKeyV1;
	readonly authority: TransientTaskWorkspaceAuthorityV1 | null;
	readonly bindings: Readonly<Record<string, unknown>>;
	readonly payloads: Readonly<Record<string, unknown>>;
	readonly resultTargets: Readonly<Record<string, unknown>>;
	readonly publications: Readonly<Record<string, unknown>>;
	readonly parentDeliveries: Readonly<Record<string, unknown>>;
}

function emptyTransientState(key: TransientTaskWorkspaceKeyV1): TransientTaskRuntimeStateV1 {
	return {
		schemaVersion: 1,
		key,
		authority: null,
		bindings: {},
		payloads: {},
		resultTargets: {},
		publications: {},
		parentDeliveries: {},
	};
}

const LIFECYCLE_SHA256_HEX = /^[0-9a-f]{64}$/;
const LIFECYCLE_SHA256_REF = /^sha256:[0-9a-f]{64}$/;

function lifecycleString(input: unknown, allowEmpty = false): input is string {
	if (typeof input !== "string" || (!allowEmpty && input.length === 0) || input.includes("\0")) return false;
	for (let index = 0; index < input.length; index++) {
		const code = input.charCodeAt(index);
		if (code < 0xd800 || code > 0xdfff) continue;
		if (code >= 0xdc00 || index + 1 >= input.length) return false;
		const next = input.charCodeAt(++index);
		if (next < 0xdc00 || next > 0xdfff) return false;
	}
	return true;
}

function lifecycleIdentity(input: unknown): input is string {
	return lifecycleString(input);
}

function lifecycleSha256Hex(input: unknown): input is Sha256Hex {
	return typeof input === "string" && LIFECYCLE_SHA256_HEX.test(input);
}

function lifecycleSha256Ref(input: unknown): input is Sha256Ref {
	return typeof input === "string" && LIFECYCLE_SHA256_REF.test(input);
}

function lifecycleSafeInteger(input: unknown, minimum = 0): input is number {
	return Number.isSafeInteger(input) && !Object.is(input, -0) && Number(input) >= minimum;
}

function lifecycleIso8601(input: unknown): input is ISO8601 {
	if (typeof input !== "string") return false;
	try {
		return new Date(input).toISOString() === input;
	} catch {
		return false;
	}
}

function lifecycleTupleRef(tuple: readonly CanonicalRuntimeValue[]): Sha256Ref {
	return `sha256:${createHash("sha256").update(encodeCanonicalRuntimeTupleV1(tuple), "utf8").digest("hex")}` as Sha256Ref;
}

function lifecycleCheckpointTuple(input: WorkspaceCheckpoint): readonly CanonicalRuntimeValue[] {
	return [input.workspaceId, input.generation, input.rootSha256, input.fileCount, input.byteCount, input.committedAt];
}

function validLifecycleCheckpoint(input: unknown): input is WorkspaceCheckpoint {
	return Boolean(
		strictRecord(input, ["workspaceId", "generation", "rootSha256", "fileCount", "byteCount", "committedAt"]) &&
			lifecycleIdentity(input.workspaceId) &&
			lifecycleSafeInteger(input.generation) &&
			lifecycleSha256Hex(input.rootSha256) &&
			lifecycleSafeInteger(input.fileCount) &&
			lifecycleSafeInteger(input.byteCount) &&
			lifecycleIso8601(input.committedAt),
	);
}

function validLifecycleImage(
	input: unknown,
): input is { readonly rootSha256: Sha256Hex; readonly fileCount: number; readonly byteCount: number } {
	return Boolean(
		strictRecord(input, ["rootSha256", "fileCount", "byteCount"]) &&
			lifecycleSha256Hex(input.rootSha256) &&
			lifecycleSafeInteger(input.fileCount) &&
			lifecycleSafeInteger(input.byteCount),
	);
}

function lifecycleManifestTuple(manifest: TransientTaskEffectIdentityManifestV1): readonly CanonicalRuntimeValue[] {
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

function validLifecycleManifest(input: unknown): input is TransientTaskEffectIdentityManifestV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"worktreePublicationId",
			"captureMemberNamespaceId",
			"captureMaterializationNamespaceId",
			"messageGenerationNamespaceId",
			"captureSubeffectNamespaceId",
			"semanticMergeStepNamespaceId",
			"semanticMergeSubeffectNamespaceId",
			"bindingOperationNamespaceId",
			"payloadRetentionNamespaceId",
			"parentDeliveryNamespaceId",
			"manifestSha256",
		]) ||
		input.schemaVersion !== 1 ||
		![
			input.taskId,
			input.runId,
			input.worktreePublicationId,
			input.captureMemberNamespaceId,
			input.captureMaterializationNamespaceId,
			input.messageGenerationNamespaceId,
			input.captureSubeffectNamespaceId,
			input.semanticMergeStepNamespaceId,
			input.semanticMergeSubeffectNamespaceId,
			input.bindingOperationNamespaceId,
			input.payloadRetentionNamespaceId,
			input.parentDeliveryNamespaceId,
		].every(lifecycleIdentity) ||
		!lifecycleSha256Ref(input.manifestSha256)
	)
		return false;
	return (
		input.manifestSha256 ===
		lifecycleTupleRef(lifecycleManifestTuple(input as unknown as TransientTaskEffectIdentityManifestV1))
	);
}

function validLifecycleResultlessIdentity(input: unknown): boolean {
	return Boolean(
		strictRecord(input, ["index", "id", "agent"]) &&
			lifecycleSafeInteger(input.index) &&
			lifecycleIdentity(input.id) &&
			lifecycleIdentity(input.agent),
	);
}

function validLifecycleControllerProof(input: unknown): input is TransientTaskControllerAuthorityProofV1 {
	return Boolean(
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"controllerId",
			"workspaceId",
			"controlHostId",
			"controllerEpoch",
			"fencingGeneration",
		]) &&
			input.schemaVersion === 1 &&
			[input.taskId, input.runId, input.createId, input.controllerId, input.workspaceId, input.controlHostId].every(
				lifecycleIdentity,
			) &&
			lifecycleSafeInteger(input.controllerEpoch, 1) &&
			lifecycleSafeInteger(input.fencingGeneration, 1),
	);
}

function validLifecycleCleanupProof(input: unknown): input is TransientTaskCleanupAuthorityProofV1 {
	return Boolean(
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"cleanupId",
			"cleanupAuthorityId",
			"workspaceId",
			"controlHostId",
			"cleanupEpoch",
			"fencingGeneration",
		]) &&
			input.schemaVersion === 1 &&
			[
				input.taskId,
				input.runId,
				input.cleanupId,
				input.cleanupAuthorityId,
				input.workspaceId,
				input.controlHostId,
			].every(lifecycleIdentity) &&
			lifecycleSafeInteger(input.cleanupEpoch, 1) &&
			lifecycleSafeInteger(input.fencingGeneration, 1),
	);
}

function validLifecycleLeaseAuthority(input: unknown, kind: "controller" | "cleanup"): boolean {
	if (!strictRecord(input, ["proof", "acquiredAt", "renewBy", "expiresAt"])) return false;
	const proofValid =
		kind === "controller" ? validLifecycleControllerProof(input.proof) : validLifecycleCleanupProof(input.proof);
	return Boolean(
		proofValid &&
			lifecycleIso8601(input.acquiredAt) &&
			lifecycleIso8601(input.renewBy) &&
			lifecycleIso8601(input.expiresAt) &&
			Date.parse(input.acquiredAt as string) <= Date.parse(input.renewBy as string) &&
			Date.parse(input.renewBy as string) <= Date.parse(input.expiresAt as string),
	);
}

function validLifecycleManagedWorkspace(input: unknown): input is TransientTaskManagedWorkspaceRefV1 {
	return Boolean(
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"workspaceId",
			"createId",
			"mode",
			"format",
			"checkpoint",
		]) &&
			input.schemaVersion === 1 &&
			[input.taskId, input.runId, input.workspaceId, input.createId].every(lifecycleIdentity) &&
			input.mode === "managed" &&
			input.format === "omp-text-v1" &&
			validLifecycleCheckpoint(input.checkpoint) &&
			(input.checkpoint as WorkspaceCheckpoint).workspaceId === input.workspaceId,
	);
}

function validLifecycleReplica(input: unknown): input is RuntimeReplicaRef {
	return Boolean(
		strictRecord(input, ["providerId", "profileId", "replicaId", "workspaceId"]) &&
			[input.providerId, input.profileId, input.replicaId, input.workspaceId].every(lifecycleIdentity),
	);
}

type LifecycleProviderRequestV1 = {
	readonly requestId: OperationId;
	readonly requestSha256: Sha256Hex;
};

type LifecycleParentProviderRequestV1 = LifecycleProviderRequestV1 & {
	readonly parentOperationId: OperationId;
};

type LifecycleTransitionProviderRequestV1 = LifecycleProviderRequestV1 & {
	readonly transitionId: OperationId;
};

function validLifecycleProviderRequest(input: unknown, kind: "parent"): input is LifecycleParentProviderRequestV1;
function validLifecycleProviderRequest(
	input: unknown,
	kind: "transition",
): input is LifecycleTransitionProviderRequestV1;
function validLifecycleProviderRequest(input: unknown, kind?: "plain"): input is LifecycleProviderRequestV1;
function validLifecycleProviderRequest(input: unknown, kind: "plain" | "parent" | "transition" = "plain"): boolean {
	const keys =
		kind === "parent"
			? ["requestId", "requestSha256", "parentOperationId"]
			: kind === "transition"
				? ["requestId", "requestSha256", "transitionId"]
				: ["requestId", "requestSha256"];
	return Boolean(
		strictRecord(input, keys) &&
			lifecycleIdentity(input.requestId) &&
			lifecycleSha256Hex(input.requestSha256) &&
			(kind !== "parent" || lifecycleIdentity(input.parentOperationId)) &&
			(kind !== "transition" || lifecycleIdentity(input.transitionId)),
	);
}

function validLifecycleProviderPreallocation(input: unknown): boolean {
	return Boolean(
		strictRecord(input, ["requestId", "parentOperationId"]) &&
			lifecycleIdentity(input.requestId) &&
			lifecycleIdentity(input.parentOperationId),
	);
}

function validLifecycleRecoveryPlan(input: unknown): boolean {
	try {
		decodeRecoveryPlan(input);
		return true;
	} catch {
		return false;
	}
}

function validLifecycleProviderWorkspace(input: unknown): input is TransientTaskProviderWorkspaceIdentityV1 {
	if (!strictRecord(input, ["taskId", "runId", "workspaceId", "acquisitionTransitionId", "lease", "recovery"]))
		return false;
	if (
		![input.taskId, input.runId, input.workspaceId, input.acquisitionTransitionId].every(lifecycleIdentity) ||
		!strictRecord(input.lease, [
			"replica",
			"leaseId",
			"fenceId",
			"initialRenewalSequence",
			"baseCheckpoint",
			"deletionAuthorityDomain",
			"leaseTtlMs",
		]) ||
		!validLifecycleReplica(input.lease.replica) ||
		!lifecycleIdentity(input.lease.leaseId) ||
		!lifecycleIdentity(input.lease.fenceId) ||
		input.lease.initialRenewalSequence !== 0 ||
		!validLifecycleCheckpoint(input.lease.baseCheckpoint) ||
		input.lease.deletionAuthorityDomain !== "transient_task" ||
		!lifecycleSafeInteger(input.lease.leaseTtlMs, 1) ||
		!validLifecycleRecoveryPlan(input.recovery)
	)
		return false;
	const recovery = input.recovery as Record<string, Record<string, unknown>>;
	const locator = recovery.locator;
	return (
		exactJson(input.lease.replica, locator.replica) &&
		input.workspaceId === input.lease.replica.workspaceId &&
		input.lease.leaseId === locator.leaseId &&
		input.lease.fenceId === locator.fenceId &&
		(input.lease.baseCheckpoint as WorkspaceCheckpoint).generation === locator.baseGeneration
	);
}

function validLifecycleCacheEvictionPlan(input: unknown): boolean {
	try {
		decodeCacheEvictionPlan(input);
		return true;
	} catch {
		return false;
	}
}

function validLifecycleDrainPlan(
	input: unknown,
	expected: "preserve" | "discard",
	provider: TransientTaskProviderWorkspaceIdentityV1,
): input is RuntimeDrainPlan {
	if (
		!strictRecord(input, [
			"transitionId",
			"commitReplica",
			"freezeAuthority",
			"checkpointId",
			"canonicalCommitId",
			"recovery",
			"cacheEvictionPlan",
			"requests",
		]) ||
		!lifecycleIdentity(input.transitionId) ||
		!strictRecord(input.requests, ["quiesce", "checkpoint", "revoke", "checkpointAcknowledgement", "release"])
	)
		return false;
	const plan = input as unknown as RuntimeDrainPlan;
	const lease = provider.lease;
	const replica = lease.replica;
	const baseGeneration = lease.baseCheckpoint.generation;
	if (expected === "discard")
		return Boolean(
			plan.commitReplica === false &&
				plan.freezeAuthority === "none" &&
				plan.checkpointId === null &&
				plan.canonicalCommitId === null &&
				plan.recovery === null &&
				plan.cacheEvictionPlan === null &&
				plan.requests.quiesce !== null &&
				validLifecycleProviderRequest(plan.requests.quiesce, "transition") &&
				plan.requests.quiesce.transitionId === plan.transitionId &&
				plan.requests.quiesce.requestId ===
					derivedProviderRequestId(replica.workspaceId, "runtime_transition", plan.transitionId, 0, "quiesce") &&
				plan.requests.quiesce.requestSha256 ===
					tupleSha256([
						"omp-runtime-provider-v1",
						"quiesce",
						plan.transitionId,
						replica.providerId,
						replica.profileId,
						replica.workspaceId,
						replica.replicaId,
						lease.leaseId,
						lease.fenceId,
						baseGeneration,
					]) &&
				plan.requests.checkpoint === null &&
				plan.requests.revoke !== null &&
				validLifecycleProviderRequest(plan.requests.revoke, "transition") &&
				plan.requests.revoke.transitionId === plan.transitionId &&
				plan.requests.revoke.requestId ===
					derivedProviderRequestId(replica.workspaceId, "runtime_transition", plan.transitionId, 2, "revoke") &&
				plan.requests.revoke.requestSha256 ===
					tupleSha256([
						"omp-runtime-provider-v1",
						"revoke",
						plan.transitionId,
						replica.providerId,
						replica.profileId,
						replica.workspaceId,
						replica.replicaId,
						lease.leaseId,
						lease.fenceId,
						"operation_admission_closed",
					]) &&
				plan.requests.checkpointAcknowledgement === null &&
				validLifecycleProviderRequest(plan.requests.release, "parent") &&
				plan.requests.release.parentOperationId === plan.transitionId &&
				plan.requests.release.requestId ===
					derivedProviderRequestId(replica.workspaceId, "runtime_transition", plan.transitionId, 4, "release") &&
				plan.requests.release.requestSha256 ===
					tupleSha256([
						"omp-runtime-provider-v1",
						"release",
						plan.transitionId,
						replica.providerId,
						replica.profileId,
						replica.workspaceId,
						replica.replicaId,
						lease.leaseId,
					]),
		);
	if (
		plan.commitReplica !== true ||
		plan.freezeAuthority !== "live_fence" ||
		!lifecycleIdentity(plan.checkpointId) ||
		!lifecycleIdentity(plan.canonicalCommitId) ||
		plan.recovery !== null ||
		(plan.cacheEvictionPlan !== null &&
			(!validLifecycleCacheEvictionPlan(plan.cacheEvictionPlan) ||
				plan.cacheEvictionPlan.requestedByOperationId !== plan.transitionId ||
				!exactJson(plan.cacheEvictionPlan.replica, replica))) ||
		plan.requests.quiesce === null ||
		plan.requests.checkpoint === null ||
		plan.requests.revoke === null ||
		plan.requests.checkpointAcknowledgement === null ||
		!validLifecycleProviderRequest(plan.requests.quiesce, "transition") ||
		!validLifecycleProviderRequest(plan.requests.checkpoint, "transition") ||
		!validLifecycleProviderRequest(plan.requests.revoke, "transition") ||
		!validLifecycleProviderPreallocation(plan.requests.checkpointAcknowledgement) ||
		!validLifecycleProviderRequest(plan.requests.release, "parent")
	)
		return false;
	return (
		plan.requests.quiesce.transitionId === plan.transitionId &&
		plan.requests.checkpoint.transitionId === plan.transitionId &&
		plan.requests.revoke.transitionId === plan.transitionId &&
		plan.requests.checkpointAcknowledgement.parentOperationId === plan.transitionId &&
		plan.requests.release.parentOperationId === plan.transitionId &&
		plan.requests.quiesce.requestId ===
			derivedProviderRequestId(replica.workspaceId, "runtime_transition", plan.transitionId, 0, "quiesce") &&
		plan.requests.quiesce.requestSha256 ===
			tupleSha256([
				"omp-runtime-provider-v1",
				"quiesce",
				plan.transitionId,
				replica.providerId,
				replica.profileId,
				replica.workspaceId,
				replica.replicaId,
				lease.leaseId,
				lease.fenceId,
				baseGeneration,
			]) &&
		plan.requests.checkpoint.requestId ===
			derivedProviderRequestId(replica.workspaceId, "runtime_transition", plan.transitionId, 1, "checkpoint") &&
		plan.requests.checkpoint.requestSha256 ===
			tupleSha256([
				"omp-runtime-provider-v1",
				"checkpoint",
				plan.transitionId,
				replica.providerId,
				replica.profileId,
				replica.workspaceId,
				replica.replicaId,
				lease.leaseId,
				lease.fenceId,
				plan.checkpointId,
				baseGeneration,
			]) &&
		plan.requests.revoke.requestId ===
			derivedProviderRequestId(replica.workspaceId, "runtime_transition", plan.transitionId, 2, "revoke") &&
		plan.requests.revoke.requestSha256 ===
			tupleSha256([
				"omp-runtime-provider-v1",
				"revoke",
				plan.transitionId,
				replica.providerId,
				replica.profileId,
				replica.workspaceId,
				replica.replicaId,
				lease.leaseId,
				lease.fenceId,
				"operation_admission_closed",
			]) &&
		plan.requests.checkpointAcknowledgement.requestId ===
			derivedProviderRequestId(
				replica.workspaceId,
				"runtime_transition",
				plan.transitionId,
				3,
				"checkpoint_acknowledgement",
			) &&
		plan.requests.release.requestId ===
			derivedProviderRequestId(replica.workspaceId, "runtime_transition", plan.transitionId, 4, "release") &&
		plan.requests.release.requestSha256 ===
			tupleSha256([
				"omp-runtime-provider-v1",
				"release",
				plan.transitionId,
				replica.providerId,
				replica.profileId,
				replica.workspaceId,
				replica.replicaId,
				lease.leaseId,
			])
	);
}

function lifecycleRecoveryPlanTuple(plan: RuntimeAcquisitionPlan["recovery"]): readonly CanonicalRuntimeValue[] {
	return [
		plan.locator.recoveryFreezeId,
		[
			plan.locator.replica.providerId,
			plan.locator.replica.profileId,
			plan.locator.replica.workspaceId,
			plan.locator.replica.replicaId,
		],
		plan.locator.leaseId,
		plan.locator.fenceId,
		plan.locator.baseGeneration,
		plan.locator.checkpointId,
		plan.canonicalCommitId,
		[plan.requests.freeze.requestId, plan.requests.freeze.requestSha256],
		[
			plan.requests.checkpointAcknowledgement.requestId,
			plan.requests.checkpointAcknowledgement.parentOperationId,
		],
		[plan.requests.release.requestId, plan.requests.release.requestSha256, plan.requests.release.parentOperationId],
	];
}

function lifecycleDrainPlanTuple(plan: RuntimeDrainPlan): readonly CanonicalRuntimeValue[] {
	const requests = plan.requests;
	return [
		plan.transitionId,
		plan.commitReplica,
		plan.freezeAuthority,
		plan.checkpointId,
		plan.canonicalCommitId,
		plan.recovery === null ? null : lifecycleRecoveryPlanTuple(plan.recovery),
		plan.cacheEvictionPlan === null
			? null
			: [
					plan.cacheEvictionPlan.requestId,
					plan.cacheEvictionPlan.requestSha256,
					plan.cacheEvictionPlan.requestedByOperationId,
					plan.cacheEvictionPlan.mode,
					plan.cacheEvictionPlan.delayMs,
					plan.cacheEvictionPlan.plannedAt,
					plan.cacheEvictionPlan.retentionDeadline,
				],
		requests.quiesce === null
			? null
			: [requests.quiesce.requestId, requests.quiesce.requestSha256, requests.quiesce.transitionId],
		requests.checkpoint === null
			? null
			: [requests.checkpoint.requestId, requests.checkpoint.requestSha256, requests.checkpoint.transitionId],
		requests.revoke === null
			? null
			: [requests.revoke.requestId, requests.revoke.requestSha256, requests.revoke.transitionId],
		requests.checkpointAcknowledgement === null
			? null
			: [requests.checkpointAcknowledgement.requestId, requests.checkpointAcknowledgement.parentOperationId],
		[requests.release.requestId, requests.release.requestSha256, requests.release.parentOperationId],
	];
}

function lifecycleManagedWorkspaceTuple(input: TransientTaskManagedWorkspaceRefV1): readonly CanonicalRuntimeValue[] {
	return [
		1,
		input.taskId,
		input.runId,
		input.workspaceId,
		input.createId,
		input.mode,
		input.format,
		lifecycleCheckpointTuple(input.checkpoint),
	];
}

function lifecycleProviderWorkspaceTuple(
	input: TransientTaskProviderWorkspaceIdentityV1,
): readonly CanonicalRuntimeValue[] {
	return [
		input.taskId,
		input.runId,
		input.workspaceId,
		input.acquisitionTransitionId,
		[
			input.lease.replica.providerId,
			input.lease.replica.profileId,
			input.lease.replica.replicaId,
			input.lease.replica.workspaceId,
			input.lease.leaseId,
			input.lease.fenceId,
			input.lease.initialRenewalSequence,
			lifecycleCheckpointTuple(input.lease.baseCheckpoint),
			input.lease.deletionAuthorityDomain,
			input.lease.leaseTtlMs,
		],
		lifecycleRecoveryPlanTuple(input.recovery),
	];
}

function lifecycleCleanupPlanTuple(plan: TransientTaskCleanupPlanV1): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-cleanup-plan-v1",
		1,
		plan.taskId,
		plan.runId,
		plan.cleanupId,
		plan.cleanupAuthorityId,
		plan.workspaceId,
		plan.expectedAuthorityRevision,
		lifecycleManagedWorkspaceTuple(plan.expectedCanonical),
		lifecycleProviderWorkspaceTuple(plan.expectedProvider),
		plan.pendingOutcomeSha256,
		plan.pendingOutcomeReceiptSha256,
		plan.acknowledgementAssessmentId,
		lifecycleDrainPlanTuple(plan.preservingDrain),
		lifecycleDrainPlanTuple(plan.fastDiscardDrain),
		plan.replicaDeleteRequestId,
		plan.replicaDeletionQuarantineId,
		plan.replicaDeletionPlannedAt,
		plan.replicaDeletionPurgeAfter,
		plan.canonicalDiscardId,
		plan.terminalEvidenceId,
		plan.publicationTargetId,
		[
			1,
			plan.publicationTargetKey.taskId,
			plan.publicationTargetKey.runId,
			plan.publicationTargetKey.createId,
			plan.publicationTargetKey.publicationTargetId,
		],
		plan.isolationCleanupId,
		plan.worktreePublicationId,
		plan.effectIdentityManifestSha256,
		plan.resultPublicationId,
		plan.resultPublicationTargetId,
		plan.resultPublicationTargetCleanupId,
		plan.pendingPayloadId,
		plan.pendingPayloadDeleteId,
		plan.composedPayloadId,
		plan.composedPayloadDeleteId,
		plan.outcome,
		plan.worktreePublicationUse,
		plan.plannedAt,
	];
}

function validLifecycleCleanupPlan(input: unknown): input is TransientTaskCleanupPlanV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"cleanupId",
			"cleanupAuthorityId",
			"workspaceId",
			"expectedAuthorityRevision",
			"expectedCanonical",
			"expectedProvider",
			"pendingOutcomeSha256",
			"pendingOutcomeReceiptSha256",
			"acknowledgementAssessmentId",
			"preservingDrain",
			"fastDiscardDrain",
			"replicaDeleteRequestId",
			"replicaDeletionQuarantineId",
			"replicaDeletionPlannedAt",
			"replicaDeletionPurgeAfter",
			"canonicalDiscardId",
			"terminalEvidenceId",
			"publicationTargetId",
			"publicationTargetKey",
			"isolationCleanupId",
			"worktreePublicationId",
			"effectIdentityManifestSha256",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"pendingPayloadId",
			"pendingPayloadDeleteId",
			"composedPayloadId",
			"composedPayloadDeleteId",
			"plannedAt",
			"outcome",
			"worktreePublicationUse",
		]) ||
		input.schemaVersion !== 1 ||
		![
			input.taskId,
			input.runId,
			input.cleanupId,
			input.cleanupAuthorityId,
			input.workspaceId,
			input.acknowledgementAssessmentId,
			input.replicaDeleteRequestId,
			input.replicaDeletionQuarantineId,
			input.canonicalDiscardId,
			input.terminalEvidenceId,
			input.publicationTargetId,
			input.isolationCleanupId,
			input.worktreePublicationId,
			input.resultPublicationId,
			input.resultPublicationTargetId,
			input.resultPublicationTargetCleanupId,
			input.pendingPayloadId,
			input.pendingPayloadDeleteId,
			input.composedPayloadId,
			input.composedPayloadDeleteId,
		].every(lifecycleIdentity) ||
		!lifecycleSafeInteger(input.expectedAuthorityRevision) ||
		!validLifecycleManagedWorkspace(input.expectedCanonical) ||
		!validLifecycleProviderWorkspace(input.expectedProvider) ||
		!lifecycleSha256Ref(input.pendingOutcomeSha256) ||
		!lifecycleSha256Ref(input.pendingOutcomeReceiptSha256) ||
		!validLifecycleDrainPlan(input.preservingDrain, "preserve", input.expectedProvider) ||
		!validLifecycleDrainPlan(input.fastDiscardDrain, "discard", input.expectedProvider) ||
		!lifecycleIso8601(input.replicaDeletionPlannedAt) ||
		!lifecycleIso8601(input.replicaDeletionPurgeAfter) ||
		Date.parse(input.replicaDeletionPlannedAt as string) > Date.parse(input.replicaDeletionPurgeAfter as string) ||
		!validateTransientTaskPublicationTargetKeyV1(input.publicationTargetKey) ||
		!lifecycleSha256Ref(input.effectIdentityManifestSha256) ||
		!lifecycleIso8601(input.plannedAt)
	)
		return false;
	const plan = input as unknown as TransientTaskCleanupPlanV1;
	return (
		((plan.outcome === "succeeded" && plan.worktreePublicationUse === "publish") ||
			((plan.outcome === "failed" || plan.outcome === "cancelled") &&
				plan.worktreePublicationUse === "unused_non_success")) &&
		plan.expectedCanonical.taskId === plan.taskId &&
		plan.expectedCanonical.runId === plan.runId &&
		plan.expectedCanonical.workspaceId === plan.workspaceId &&
		plan.expectedProvider.taskId === plan.taskId &&
		plan.expectedProvider.runId === plan.runId &&
		plan.expectedProvider.workspaceId === plan.workspaceId &&
		exactJson(plan.expectedCanonical.checkpoint, plan.expectedProvider.lease.baseCheckpoint) &&
		plan.publicationTargetKey.taskId === plan.taskId &&
		plan.publicationTargetKey.runId === plan.runId &&
		plan.publicationTargetKey.createId === plan.expectedCanonical.createId &&
		plan.publicationTargetKey.publicationTargetId === plan.publicationTargetId
	);
}

function lifecyclePendingReceiptTuple(receipt: TransientTaskPendingOutcomeReceiptV1): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-pending-outcome-v1",
		"receipt",
		1,
		receipt.taskId,
		receipt.runId,
		"pending",
		receipt.createId,
		receipt.resultPublicationId,
		receipt.resultPublicationTargetId,
		receipt.resultPublicationTargetCleanupId,
		receipt.pendingPayloadId,
		receipt.pendingPayloadDeleteId,
		receipt.outcome,
		receipt.outcomeSha256,
		receipt.initializationReceiptSha256,
		receipt.predecessorReceiptSha256,
		receipt.cancellationAcknowledgementReceiptSha256,
		receipt.payloadSha256,
		receipt.payloadPutReceiptSha256,
		receipt.requestSha256,
		receipt.recordedAt,
	];
}

function validLifecyclePendingReceipt(input: unknown): input is TransientTaskPendingOutcomeReceiptV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"state",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"pendingPayloadId",
			"pendingPayloadDeleteId",
			"outcome",
			"outcomeSha256",
			"initializationReceiptSha256",
			"predecessorReceiptSha256",
			"cancellationAcknowledgementReceiptSha256",
			"payloadSha256",
			"payloadPutReceiptSha256",
			"requestSha256",
			"recordedAt",
			"receiptSha256",
		]) ||
		input.schemaVersion !== 1 ||
		input.state !== "pending" ||
		![
			input.taskId,
			input.runId,
			input.createId,
			input.resultPublicationId,
			input.resultPublicationTargetId,
			input.resultPublicationTargetCleanupId,
			input.pendingPayloadId,
			input.pendingPayloadDeleteId,
		].every(lifecycleIdentity) ||
		(input.outcome !== "succeeded" && input.outcome !== "failed" && input.outcome !== "cancelled") ||
		![
			input.outcomeSha256,
			input.initializationReceiptSha256,
			input.predecessorReceiptSha256,
			input.payloadSha256,
			input.requestSha256,
			input.receiptSha256,
		].every(lifecycleSha256Ref) ||
		(input.cancellationAcknowledgementReceiptSha256 !== null &&
			!lifecycleSha256Ref(input.cancellationAcknowledgementReceiptSha256)) ||
		(input.payloadPutReceiptSha256 !== null && !lifecycleSha256Ref(input.payloadPutReceiptSha256)) ||
		!lifecycleIso8601(input.recordedAt)
	)
		return false;
	const receipt = input as unknown as TransientTaskPendingOutcomeReceiptV1;
	return (
		(receipt.outcome === "cancelled") === (receipt.cancellationAcknowledgementReceiptSha256 !== null) &&
		receipt.receiptSha256 === lifecycleTupleRef(lifecyclePendingReceiptTuple(receipt))
	);
}

function lifecycleDiscardTuple(receipt: TransientTaskCanonicalDiscardReceiptV1): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-canonical-discard-v1",
		receipt.taskId,
		receipt.runId,
		receipt.workspaceId,
		receipt.cleanupId,
		receipt.cleanupAuthorityId,
		receipt.canonicalDiscardId,
		...lifecycleCheckpointTuple(receipt.finalCheckpoint),
		receipt.cleanupPlanSha256,
		receipt.discardedAt,
	];
}

function validLifecycleDiscardReceipt(input: unknown): input is TransientTaskCanonicalDiscardReceiptV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"workspaceId",
			"cleanupId",
			"cleanupAuthorityId",
			"canonicalDiscardId",
			"finalCheckpoint",
			"cleanupPlanSha256",
			"discardedAt",
			"receiptSha256",
		]) ||
		input.schemaVersion !== 1 ||
		![
			input.taskId,
			input.runId,
			input.workspaceId,
			input.cleanupId,
			input.cleanupAuthorityId,
			input.canonicalDiscardId,
		].every(lifecycleIdentity) ||
		!validLifecycleCheckpoint(input.finalCheckpoint) ||
		(input.finalCheckpoint as WorkspaceCheckpoint).workspaceId !== input.workspaceId ||
		!lifecycleSha256Ref(input.cleanupPlanSha256) ||
		!lifecycleIso8601(input.discardedAt) ||
		!lifecycleSha256Ref(input.receiptSha256)
	)
		return false;
	const receipt = input as unknown as TransientTaskCanonicalDiscardReceiptV1;
	return receipt.receiptSha256 === lifecycleTupleRef(lifecycleDiscardTuple(receipt));
}

function lifecycleIsolationNamespaceTuple(
	descriptor: ConfidentialTransientTaskIsolationCreatorDescriptorV1,
): readonly CanonicalRuntimeValue[] {
	return ["omp-transient-task-isolation-namespace-v1", 1, descriptor.taskId, descriptor.runId, descriptor.createId];
}

function lifecycleIsolationOwnerTuple(
	descriptor: ConfidentialTransientTaskIsolationCreatorDescriptorV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-isolation-owner-v1",
		1,
		lifecycleIsolationNamespaceTuple(descriptor),
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

function lifecycleIsolationDescriptorTuple(
	descriptor: ConfidentialTransientTaskIsolationCreatorDescriptorV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-isolation-creator-v1",
		1,
		lifecycleIsolationOwnerTuple(descriptor),
		descriptor.baseDir,
		descriptor.mergedDir,
		descriptor.ownershipClaimPath,
	];
}

function validLifecycleIsolationDescriptor(
	input: unknown,
): input is ConfidentialTransientTaskIsolationCreatorDescriptorV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"publicationTargetId",
			"worktreePublicationId",
			"isolationCleanupId",
			"bindingOperationId",
			"ownershipClaimCreateOperationId",
			"effectIdentityManifestSha256",
			"namespaceSha256",
			"directorySegment",
			"baseDir",
			"mergedDir",
			"ownershipClaimPath",
			"captureBranchRef",
			"ownerManifestSha256",
			"creatorDescriptorSha256",
		]) ||
		input.schemaVersion !== 1 ||
		![
			input.taskId,
			input.runId,
			input.createId,
			input.publicationTargetId,
			input.worktreePublicationId,
			input.isolationCleanupId,
			input.bindingOperationId,
			input.ownershipClaimCreateOperationId,
			input.directorySegment,
			input.baseDir,
			input.mergedDir,
			input.ownershipClaimPath,
			input.captureBranchRef,
		].every(lifecycleIdentity) ||
		!lifecycleSha256Ref(input.effectIdentityManifestSha256) ||
		!lifecycleSha256Hex(input.namespaceSha256) ||
		!lifecycleSha256Ref(input.ownerManifestSha256) ||
		!lifecycleSha256Ref(input.creatorDescriptorSha256)
	)
		return false;
	const descriptor = input as unknown as ConfidentialTransientTaskIsolationCreatorDescriptorV1;
	const namespaceSha256 = createHash("sha256")
		.update(JSON.stringify(lifecycleIsolationNamespaceTuple(descriptor)), "utf8")
		.digest("hex");
	return (
		descriptor.namespaceSha256 === namespaceSha256 &&
		descriptor.directorySegment === `t1-${namespaceSha256}` &&
		descriptor.ownerManifestSha256 === lifecycleTupleRef(lifecycleIsolationOwnerTuple(descriptor)) &&
		descriptor.creatorDescriptorSha256 === lifecycleTupleRef(lifecycleIsolationDescriptorTuple(descriptor))
	);
}

function lifecycleIsolationClaimTuple(
	claim: ConfidentialTransientTaskIsolationOwnershipClaimV1,
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

function validLifecycleIsolationClaim(input: unknown): input is ConfidentialTransientTaskIsolationOwnershipClaimV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"ownerManifestSha256",
			"claimOperationId",
			"claimantInstanceId",
			"controlHostId",
			"pid",
			"processStartToken",
			"claimedAt",
			"claimSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!lifecycleSha256Ref(input.ownerManifestSha256) ||
		![input.claimOperationId, input.claimantInstanceId, input.controlHostId].every(lifecycleIdentity) ||
		!lifecycleSafeInteger(input.pid, 1) ||
		(input.processStartToken !== null && !lifecycleIdentity(input.processStartToken)) ||
		!lifecycleIso8601(input.claimedAt) ||
		!lifecycleSha256Ref(input.claimSha256)
	)
		return false;
	const claim = input as unknown as ConfidentialTransientTaskIsolationOwnershipClaimV1;
	return claim.claimSha256 === lifecycleTupleRef(lifecycleIsolationClaimTuple(claim));
}

function lifecycleOwnerLivenessCore(
	evidence: ConfidentialTransientTaskIsolationOwnerLivenessEvidenceV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-isolation-owner-liveness-v1",
		"evidence",
		1,
		evidence.taskId,
		evidence.runId,
		evidence.createId,
		evidence.effectOperationId,
		evidence.creatorDescriptorSha256,
		evidence.requestSha256,
		evidence.attemptSha256,
		lifecycleIsolationClaimTuple(evidence.observedClaim),
		evidence.probingControlHostId,
		evidence.verdict,
		evidence.basis,
	];
}

function validLifecycleOwnerLiveness(
	input: unknown,
): input is ConfidentialTransientTaskIsolationOwnerLivenessEvidenceV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"effectOperationId",
			"creatorDescriptorSha256",
			"requestSha256",
			"attemptSha256",
			"observedClaim",
			"probingControlHostId",
			"evidenceSha256",
			"verdict",
			"basis",
		]) ||
		input.schemaVersion !== 1 ||
		![input.taskId, input.runId, input.createId, input.effectOperationId, input.probingControlHostId].every(
			lifecycleIdentity,
		) ||
		![input.creatorDescriptorSha256, input.requestSha256, input.attemptSha256, input.evidenceSha256].every(
			lifecycleSha256Ref,
		) ||
		!validLifecycleIsolationClaim(input.observedClaim)
	)
		return false;
	const validArm =
		(input.verdict === "stale" &&
			(input.basis === "same_host_pid_absent" || input.basis === "same_host_process_start_token_mismatch")) ||
		(input.verdict === "live" && input.basis === "same_host_process_identity_live") ||
		(input.verdict === "indeterminate" &&
			[
				"different_control_host",
				"missing_process_start_token",
				"process_probe_unsupported",
				"process_probe_permission_denied",
				"process_probe_unavailable",
			].includes(input.basis as string));
	if (!validArm) return false;
	const evidence = input as unknown as ConfidentialTransientTaskIsolationOwnerLivenessEvidenceV1;
	return evidence.evidenceSha256 === lifecycleTupleRef(lifecycleOwnerLivenessCore(evidence));
}

function lifecycleIsolationClaimRequestTuple(
	request: ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1,
): readonly CanonicalRuntimeValue[] {
	const prefix: CanonicalRuntimeValue[] = [
		"omp-transient-task-isolation-claim-effect-v1",
		"request",
		1,
		request.taskId,
		request.runId,
		request.createId,
		request.operation,
		request.effectOperationId,
		lifecycleIsolationDescriptorTuple(request.creatorDescriptor),
		controllerProofTuple(request.controller),
		request.authoritySha256,
		request.requestedAt,
	];
	if (request.operation === "exclusive_create")
		return [...prefix, null, lifecycleIsolationClaimTuple(request.nextClaim), true, true, false];
	if (request.operation === "stale_same_owner_cas_adopt")
		return [
			...prefix,
			[lifecycleOwnerLivenessCore(request.staleOwnerEvidence), request.staleOwnerEvidence.evidenceSha256],
			lifecycleIsolationClaimTuple(request.expectedClaim),
			lifecycleIsolationClaimTuple(request.nextClaim),
			true,
			true,
		];
	return [...prefix, lifecycleIsolationClaimTuple(request.expectedClaim), null, true, true, request.reason];
}

function validLifecycleIsolationClaimRequest(
	input: unknown,
): input is ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1 {
	if (
		!proxyFreeData(input) ||
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		!("operation" in input)
	)
		return false;
	const operation = input.operation;
	const keys =
		operation === "exclusive_create"
			? [
					"schemaVersion",
					"taskId",
					"runId",
					"createId",
					"operation",
					"effectOperationId",
					"creatorDescriptor",
					"controller",
					"authoritySha256",
					"requestedAt",
					"requestSha256",
					"expectedClaim",
					"nextClaim",
					"exclusive",
					"noFollow",
					"createParentDirectories",
				]
			: operation === "stale_same_owner_cas_adopt"
				? [
						"schemaVersion",
						"taskId",
						"runId",
						"createId",
						"operation",
						"effectOperationId",
						"creatorDescriptor",
						"controller",
						"authoritySha256",
						"requestedAt",
						"requestSha256",
						"expectedClaim",
						"staleOwnerEvidence",
						"nextClaim",
						"compareAndSwap",
						"noFollow",
					]
				: operation === "pre_bind_cas_release"
					? [
							"schemaVersion",
							"taskId",
							"runId",
							"createId",
							"operation",
							"effectOperationId",
							"creatorDescriptor",
							"controller",
							"authoritySha256",
							"requestedAt",
							"requestSha256",
							"expectedClaim",
							"nextClaim",
							"compareAndSwap",
							"noFollow",
							"reason",
						]
					: null;
	if (
		keys === null ||
		!strictRecord(input, keys) ||
		input.schemaVersion !== 1 ||
		![input.taskId, input.runId, input.createId, input.effectOperationId].every(lifecycleIdentity) ||
		!validLifecycleIsolationDescriptor(input.creatorDescriptor) ||
		!validLifecycleControllerProof(input.controller) ||
		!lifecycleSha256Ref(input.authoritySha256) ||
		!lifecycleIso8601(input.requestedAt) ||
		!lifecycleSha256Ref(input.requestSha256) ||
		input.taskId !== input.creatorDescriptor.taskId ||
		input.runId !== input.creatorDescriptor.runId ||
		input.createId !== input.creatorDescriptor.createId ||
		input.controller.taskId !== input.taskId ||
		input.controller.runId !== input.runId ||
		input.controller.createId !== input.createId
	)
		return false;
	if (operation === "exclusive_create") {
		if (
			input.expectedClaim !== null ||
			input.exclusive !== true ||
			input.noFollow !== true ||
			input.createParentDirectories !== false ||
			!validLifecycleIsolationClaim(input.nextClaim)
		)
			return false;
	} else if (operation === "stale_same_owner_cas_adopt") {
		if (
			input.compareAndSwap !== true ||
			input.noFollow !== true ||
			!validLifecycleIsolationClaim(input.expectedClaim) ||
			!validLifecycleOwnerLiveness(input.staleOwnerEvidence) ||
			input.staleOwnerEvidence.verdict !== "stale" ||
			!validLifecycleIsolationClaim(input.nextClaim)
		)
			return false;
	} else if (
		input.compareAndSwap !== true ||
		input.noFollow !== true ||
		!validLifecycleIsolationClaim(input.expectedClaim) ||
		input.nextClaim !== null ||
		(input.reason !== "create_aborted" && input.reason !== "isolation_create_failed")
	)
		return false;
	const request = input as unknown as ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1;
	return request.requestSha256 === lifecycleTupleRef(lifecycleIsolationClaimRequestTuple(request));
}

function lifecycleIsolationClaimAttemptTuple(
	attempt: Omit<ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1, "attemptSha256">,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-isolation-claim-effect-v1",
		"attempt",
		1,
		attempt.state,
		lifecycleIsolationClaimRequestTuple(attempt.request),
		attempt.openedAt,
	];
}

function validLifecycleIsolationClaimAttempt(
	input: unknown,
): input is ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1 {
	if (
		!strictRecord(input, ["state", "request", "openedAt", "attemptSha256"]) ||
		(input.state !== "claim_not_applied" && input.state !== "claim_outcome_unknown") ||
		!validLifecycleIsolationClaimRequest(input.request) ||
		!lifecycleIso8601(input.openedAt) ||
		!lifecycleSha256Ref(input.attemptSha256)
	)
		return false;
	const attempt = input as unknown as ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1;
	return attempt.attemptSha256 === lifecycleTupleRef(lifecycleIsolationClaimAttemptTuple(attempt));
}

function lifecycleIsolationClaimReceiptTuple(
	receipt: ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1,
): readonly CanonicalRuntimeValue[] {
	const prefix: CanonicalRuntimeValue[] = [
		"omp-transient-task-isolation-claim-effect-v1",
		"receipt",
		1,
		receipt.taskId,
		receipt.runId,
		receipt.createId,
		receipt.effectOperationId,
		receipt.operation,
		receipt.outcome,
		receipt.requestSha256,
		receipt.attemptSha256,
		receipt.authoritySha256,
		receipt.previousClaimSha256,
	];
	if (receipt.operation === "pre_bind_cas_release")
		return [...prefix, null, null, receipt.completedAt, receipt.reason];
	return [...prefix, lifecycleIsolationClaimTuple(receipt.claim), receipt.currentClaimSha256, receipt.completedAt];
}

function validLifecycleIsolationClaimReceipt(
	input: unknown,
): input is ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1 {
	if (
		!proxyFreeData(input) ||
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		!("operation" in input)
	)
		return false;
	const release = input.operation === "pre_bind_cas_release";
	const keys = release
		? [
				"schemaVersion",
				"taskId",
				"runId",
				"createId",
				"effectOperationId",
				"requestSha256",
				"attemptSha256",
				"authoritySha256",
				"completedAt",
				"receiptSha256",
				"operation",
				"outcome",
				"previousClaimSha256",
				"currentClaimSha256",
				"reason",
			]
		: [
				"schemaVersion",
				"taskId",
				"runId",
				"createId",
				"effectOperationId",
				"requestSha256",
				"attemptSha256",
				"authoritySha256",
				"completedAt",
				"receiptSha256",
				"operation",
				"outcome",
				"previousClaimSha256",
				"claim",
				"currentClaimSha256",
			];
	if (
		!strictRecord(input, keys) ||
		input.schemaVersion !== 1 ||
		![input.taskId, input.runId, input.createId, input.effectOperationId].every(lifecycleIdentity) ||
		![input.requestSha256, input.attemptSha256, input.authoritySha256, input.receiptSha256].every(
			lifecycleSha256Ref,
		) ||
		!lifecycleIso8601(input.completedAt)
	)
		return false;
	if (release) {
		if (
			input.outcome !== "released_before_bind" ||
			!lifecycleSha256Ref(input.previousClaimSha256) ||
			input.currentClaimSha256 !== null ||
			(input.reason !== "create_aborted" && input.reason !== "isolation_create_failed")
		)
			return false;
	} else if (
		(input.operation !== "exclusive_create" && input.operation !== "stale_same_owner_cas_adopt") ||
		(input.operation === "exclusive_create"
			? input.outcome !== "created" && input.outcome !== "exact_claim_adopted"
			: input.outcome !== "stale_same_owner_adopted") ||
		(input.operation === "exclusive_create"
			? input.previousClaimSha256 !== null
			: !lifecycleSha256Ref(input.previousClaimSha256)) ||
		!validLifecycleIsolationClaim(input.claim) ||
		input.currentClaimSha256 !== input.claim.claimSha256
	)
		return false;
	const receipt = input as unknown as ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1;
	return receipt.receiptSha256 === lifecycleTupleRef(lifecycleIsolationClaimReceiptTuple(receipt));
}

function lifecycleIsolationCleanupDescriptorTuple(
	descriptor: ConfidentialTransientTaskIsolationCleanupDescriptorV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"cleanup_descriptor",
		1,
		lifecycleIsolationDescriptorTuple(descriptor.creatorDescriptor),
		descriptor.mergedDir,
		descriptor.backend,
		descriptor.fellBack,
		descriptor.fallbackReason,
	];
}

function validLifecycleIsolationCleanupDescriptor(
	input: unknown,
): input is ConfidentialTransientTaskIsolationCleanupDescriptorV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"creatorDescriptor",
			"mergedDir",
			"backend",
			"fellBack",
			"fallbackReason",
			"cleanupDescriptorSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validLifecycleIsolationDescriptor(input.creatorDescriptor) ||
		input.mergedDir !== input.creatorDescriptor.mergedDir ||
		!lifecycleSafeInteger(input.backend) ||
		Number(input.backend) > 7 ||
		typeof input.fellBack !== "boolean" ||
		(input.fallbackReason !== null && !lifecycleString(input.fallbackReason, true)) ||
		!lifecycleSha256Ref(input.cleanupDescriptorSha256)
	)
		return false;
	const descriptor = input as unknown as ConfidentialTransientTaskIsolationCleanupDescriptorV1;
	return (
		descriptor.cleanupDescriptorSha256 === lifecycleTupleRef(lifecycleIsolationCleanupDescriptorTuple(descriptor))
	);
}

function lifecycleIsolationReadyTuple(
	ready: Omit<ConfidentialTransientTaskIsolationReadyToBindReceiptV1, "receiptSha256">,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-isolation-creator-v1",
		"ready_to_bind",
		1,
		ready.taskId,
		ready.runId,
		ready.createId,
		lifecycleIsolationDescriptorTuple(ready.creatorDescriptor),
		lifecycleIsolationClaimTuple(ready.ownershipClaim),
		lifecycleIsolationClaimReceiptTuple(ready.ownershipClaimReceipt),
		lifecycleIsolationCleanupDescriptorTuple(ready.cleanupDescriptor),
		ready.orderedClaimAttemptSha256s,
		ready.orderedClaimReceiptSha256s,
		ready.authoritySha256,
		ready.preparedAt,
	];
}

function validLifecycleIsolationReady(input: unknown): input is ConfidentialTransientTaskIsolationReadyToBindReceiptV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"creatorDescriptor",
			"ownershipClaim",
			"ownershipClaimReceipt",
			"cleanupDescriptor",
			"orderedClaimAttemptSha256s",
			"orderedClaimReceiptSha256s",
			"authoritySha256",
			"preparedAt",
			"receiptSha256",
		]) ||
		input.schemaVersion !== 1 ||
		![input.taskId, input.runId, input.createId].every(lifecycleIdentity) ||
		!validLifecycleIsolationDescriptor(input.creatorDescriptor) ||
		!validLifecycleIsolationClaim(input.ownershipClaim) ||
		!validLifecycleIsolationClaimReceipt(input.ownershipClaimReceipt) ||
		input.ownershipClaimReceipt.operation === "pre_bind_cas_release" ||
		!validLifecycleIsolationCleanupDescriptor(input.cleanupDescriptor) ||
		!Array.isArray(input.orderedClaimAttemptSha256s) ||
		input.orderedClaimAttemptSha256s.length === 0 ||
		!input.orderedClaimAttemptSha256s.every(lifecycleSha256Ref) ||
		!Array.isArray(input.orderedClaimReceiptSha256s) ||
		input.orderedClaimReceiptSha256s.length !== input.orderedClaimAttemptSha256s.length ||
		!input.orderedClaimReceiptSha256s.every(lifecycleSha256Ref) ||
		!lifecycleSha256Ref(input.authoritySha256) ||
		!lifecycleIso8601(input.preparedAt) ||
		!lifecycleSha256Ref(input.receiptSha256)
	)
		return false;
	const ready = input as unknown as ConfidentialTransientTaskIsolationReadyToBindReceiptV1;
	return (
		ready.taskId === ready.creatorDescriptor.taskId &&
		ready.runId === ready.creatorDescriptor.runId &&
		ready.createId === ready.creatorDescriptor.createId &&
		ready.ownershipClaim.ownerManifestSha256 === ready.creatorDescriptor.ownerManifestSha256 &&
		ready.ownershipClaimReceipt.currentClaimSha256 === ready.ownershipClaim.claimSha256 &&
		ready.cleanupDescriptor.creatorDescriptor.creatorDescriptorSha256 ===
			ready.creatorDescriptor.creatorDescriptorSha256 &&
		ready.receiptSha256 === lifecycleTupleRef(lifecycleIsolationReadyTuple(ready))
	);
}

function validLifecycleIsolationPreparation(
	input: unknown,
): input is ConfidentialTransientTaskIsolationPreparingAuthorityV1 {
	if (
		!proxyFreeData(input) ||
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		!("state" in input)
	)
		return false;
	if (input.state === "claim_effect_not_applied" || input.state === "claim_effect_outcome_unknown") {
		if (
			!strictRecord(input, [
				"creatorDescriptor",
				"orderedPriorAttempts",
				"orderedPriorReceipts",
				"updatedAt",
				"state",
				"activeAttempt",
			]) ||
			!validLifecycleIsolationDescriptor(input.creatorDescriptor) ||
			!Array.isArray(input.orderedPriorAttempts) ||
			!input.orderedPriorAttempts.every(validLifecycleIsolationClaimAttempt) ||
			!Array.isArray(input.orderedPriorReceipts) ||
			input.orderedPriorReceipts.length !== input.orderedPriorAttempts.length ||
			!input.orderedPriorReceipts.every(validLifecycleIsolationClaimReceipt) ||
			!validLifecycleIsolationClaimAttempt(input.activeAttempt) ||
			!lifecycleIso8601(input.updatedAt) ||
			(input.state === "claim_effect_not_applied") !== (input.activeAttempt.state === "claim_not_applied")
		)
			return false;
		return (
			input.activeAttempt.request.creatorDescriptor.creatorDescriptorSha256 ===
			input.creatorDescriptor.creatorDescriptorSha256
		);
	}
	if (input.state === "claim_current") {
		if (
			!strictRecord(input, [
				"state",
				"creatorDescriptor",
				"orderedClaimAttempts",
				"orderedClaimReceipts",
				"ownershipClaim",
				"ownershipClaimReceipt",
				"updatedAt",
			]) ||
			!validLifecycleIsolationDescriptor(input.creatorDescriptor) ||
			!Array.isArray(input.orderedClaimAttempts) ||
			input.orderedClaimAttempts.length === 0 ||
			!input.orderedClaimAttempts.every(validLifecycleIsolationClaimAttempt) ||
			!Array.isArray(input.orderedClaimReceipts) ||
			input.orderedClaimReceipts.length !== input.orderedClaimAttempts.length ||
			!input.orderedClaimReceipts.every(validLifecycleIsolationClaimReceipt) ||
			!validLifecycleIsolationClaim(input.ownershipClaim) ||
			!validLifecycleIsolationClaimReceipt(input.ownershipClaimReceipt) ||
			input.ownershipClaimReceipt.operation === "pre_bind_cas_release" ||
			!lifecycleIso8601(input.updatedAt)
		)
			return false;
		for (let index = 0; index < input.orderedClaimAttempts.length; index++) {
			const attempt = input.orderedClaimAttempts[
				index
			] as ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1;
			const receipt = input.orderedClaimReceipts[
				index
			] as ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1;
			if (
				receipt.operation === "pre_bind_cas_release" ||
				receipt.attemptSha256 !== attempt.attemptSha256 ||
				receipt.requestSha256 !== attempt.request.requestSha256 ||
				receipt.effectOperationId !== attempt.request.effectOperationId
			)
				return false;
		}
		const finalReceipt = input.orderedClaimReceipts[input.orderedClaimReceipts.length - 1] as Exclude<
			ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1,
			{ operation: "pre_bind_cas_release" }
		>;
		return (
			input.ownershipClaim.ownerManifestSha256 === input.creatorDescriptor.ownerManifestSha256 &&
			input.ownershipClaimReceipt.receiptSha256 === finalReceipt.receiptSha256 &&
			input.ownershipClaimReceipt.currentClaimSha256 === input.ownershipClaim.claimSha256
		);
	}
	if (input.state === "ready_to_bind")
		return Boolean(
			strictRecord(input, ["state", "ready", "updatedAt"]) &&
				validLifecycleIsolationReady(input.ready) &&
				lifecycleIso8601(input.updatedAt),
		);
	if (input.state === "bound")
		return Boolean(
			strictRecord(input, ["state", "ready", "bindReceipt", "updatedAt"]) &&
				validLifecycleIsolationReady(input.ready) &&
				validateTransientTaskPublicationTargetBindReceiptV1(input.bindReceipt) &&
				lifecycleIso8601(input.updatedAt),
		);
	return Boolean(
		input.state === "released_before_bind" &&
			strictRecord(input, [
				"state",
				"creatorDescriptorSha256",
				"lastClaimReceiptSha256",
				"releaseReceipt",
				"updatedAt",
			]) &&
			lifecycleSha256Ref(input.creatorDescriptorSha256) &&
			lifecycleSha256Ref(input.lastClaimReceiptSha256) &&
			validLifecycleIsolationClaimReceipt(input.releaseReceipt) &&
			input.releaseReceipt.operation === "pre_bind_cas_release" &&
			input.releaseReceipt.receiptSha256 === input.lastClaimReceiptSha256 &&
			lifecycleIso8601(input.updatedAt),
	);
}

function validLifecycleRuntimeRecord(input: unknown, workspaceId: WorkspaceId): input is RuntimeAttachmentRecordV1 {
	try {
		decodeRuntimeAttachmentRecordV1(input, workspaceId);
		return true;
	} catch {
		return false;
	}
}

function validLifecycleRuntimeAttachment(input: unknown, workspaceId: WorkspaceId, expectedState?: string): boolean {
	try {
		const attachment = decodeRuntimeAttachment(input, workspaceId);
		return expectedState === undefined || attachment.state === expectedState;
	} catch {
		return false;
	}
}

function validLifecycleBlock(input: unknown): boolean {
	if (input === null) return false;
	try {
		decodeRuntimeBlock(input);
		return true;
	} catch {
		return false;
	}
}

function validLifecycleEffectsAssessment(input: unknown, expectedStatus: string): boolean {
	if (!strictRecord(input, ["status", "proof"]) || input.status !== expectedStatus) return false;
	const proof = input.proof;
	if (expectedStatus === "none_acknowledged")
		return Boolean(
			strictRecord(proof, [
				"schemaVersion",
				"taskId",
				"runId",
				"assessmentId",
				"providerWorkspace",
				"baseCheckpoint",
				"observedImage",
				"acknowledgedMutationCount",
				"acknowledgedCommandCount",
				"unknownMutationCount",
				"unknownCommandCount",
				"activeCommands",
				"pendingSyncs",
				"observedAt",
				"proofSha256",
			]) &&
				proof.schemaVersion === 1 &&
				[proof.taskId, proof.runId, proof.assessmentId].every(lifecycleIdentity) &&
				validLifecycleProviderWorkspace(proof.providerWorkspace) &&
				proof.providerWorkspace.taskId === proof.taskId &&
				proof.providerWorkspace.runId === proof.runId &&
				validLifecycleCheckpoint(proof.baseCheckpoint) &&
				exactJson(proof.baseCheckpoint, proof.providerWorkspace.lease.baseCheckpoint) &&
				validLifecycleImage(proof.observedImage) &&
				workspaceImagesMatch(proof.observedImage, proof.baseCheckpoint) &&
				proof.acknowledgedMutationCount === 0 &&
				proof.acknowledgedCommandCount === 0 &&
				proof.unknownMutationCount === 0 &&
				proof.unknownCommandCount === 0 &&
				proof.activeCommands === 0 &&
				proof.pendingSyncs === 0 &&
				lifecycleIso8601(proof.observedAt) &&
				lifecycleSha256Ref(proof.proofSha256),
		);
	if (expectedStatus === "acknowledged")
		return Boolean(
			strictRecord(proof, [
				"schemaVersion",
				"taskId",
				"runId",
				"assessmentId",
				"providerWorkspace",
				"acknowledgedMutationCount",
				"acknowledgedCommandCount",
				"acknowledgedMutationsSha256",
				"acknowledgedCommandsSha256",
				"unknownMutationCount",
				"unknownCommandCount",
				"observedAt",
				"proofSha256",
			]) &&
				proof.schemaVersion === 1 &&
				[proof.taskId, proof.runId, proof.assessmentId].every(lifecycleIdentity) &&
				validLifecycleProviderWorkspace(proof.providerWorkspace) &&
				proof.providerWorkspace.taskId === proof.taskId &&
				proof.providerWorkspace.runId === proof.runId &&
				lifecycleSafeInteger(proof.acknowledgedMutationCount) &&
				lifecycleSafeInteger(proof.acknowledgedCommandCount) &&
				Number(proof.acknowledgedMutationCount) + Number(proof.acknowledgedCommandCount) > 0 &&
				lifecycleSha256Ref(proof.acknowledgedMutationsSha256) &&
				lifecycleSha256Ref(proof.acknowledgedCommandsSha256) &&
				proof.unknownMutationCount === 0 &&
				proof.unknownCommandCount === 0 &&
				lifecycleIso8601(proof.observedAt) &&
				lifecycleSha256Ref(proof.proofSha256),
		);
	return Boolean(
		strictRecord(proof, [
			"schemaVersion",
			"taskId",
			"runId",
			"assessmentId",
			"providerWorkspace",
			"acknowledgedMutationCount",
			"acknowledgedCommandCount",
			"unknownMutationCount",
			"unknownCommandCount",
			"block",
			"observedAt",
			"proofSha256",
		]) &&
			proof.schemaVersion === 1 &&
			[proof.taskId, proof.runId, proof.assessmentId].every(lifecycleIdentity) &&
			validLifecycleProviderWorkspace(proof.providerWorkspace) &&
			proof.providerWorkspace.taskId === proof.taskId &&
			proof.providerWorkspace.runId === proof.runId &&
			lifecycleSafeInteger(proof.acknowledgedMutationCount) &&
			lifecycleSafeInteger(proof.acknowledgedCommandCount) &&
			lifecycleSafeInteger(proof.unknownMutationCount) &&
			lifecycleSafeInteger(proof.unknownCommandCount) &&
			Number(proof.unknownMutationCount) + Number(proof.unknownCommandCount) > 0 &&
			validLifecycleBlock(proof.block) &&
			lifecycleIso8601(proof.observedAt) &&
			lifecycleSha256Ref(proof.proofSha256),
	);
}

function validLifecycleCleanupBranch(input: unknown): input is TransientTaskCleanupBranchV1 {
	if (!strictRecord(input, ["kind", "reason", "assessment"])) return false;
	if (input.kind === "preserve" && input.reason === "task_succeeded") return input.assessment === null;
	if (input.kind === "preserve" && input.reason === "acknowledged_effects")
		return validLifecycleEffectsAssessment(input.assessment, "acknowledged");
	if (input.kind === "preserve" && input.reason === "uncertain_effects")
		return validLifecycleEffectsAssessment(input.assessment, "ambiguous");
	return Boolean(
		input.kind === "fast_discard" &&
			input.reason === "no_acknowledged_effects" &&
			validLifecycleEffectsAssessment(input.assessment, "none_acknowledged"),
	);
}

function lifecyclePublicationTargetKeyTuple(
	key: TransientTaskPublicationTargetKeyV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"key",
		1,
		key.taskId,
		key.runId,
		key.createId,
		key.publicationTargetId,
	];
}

const LIFECYCLE_WORKTREE_PUBLICATION_DOMAIN = "omp-transient-task-canonical-worktree-publication-v1" as const;

function lifecycleWorktreeTargetKeyTuple(key: TransientTaskPublicationTargetKeyV1): readonly CanonicalRuntimeValue[] {
	return [1, key.taskId, key.runId, key.createId, key.publicationTargetId];
}

function lifecycleWorktreeCleanupProofTuple(
	proof: TransientTaskCleanupAuthorityProofV1,
): readonly CanonicalRuntimeValue[] {
	return [
		1,
		proof.taskId,
		proof.runId,
		proof.cleanupId,
		proof.cleanupAuthorityId,
		proof.workspaceId,
		proof.controlHostId,
		proof.cleanupEpoch,
		proof.fencingGeneration,
	];
}

function lifecycleWorktreePublicationClaimTuple(
	claim: TransientTaskPublicationTargetPublicationClaimV1,
): readonly CanonicalRuntimeValue[] {
	return [
		1,
		lifecycleWorktreeTargetKeyTuple(claim.key),
		claim.isolationCleanupId,
		claim.worktreePublicationId,
		claim.openOperationId,
		claim.access,
		claim.bindingRevision,
		claim.renewalSequence,
		claim.bindingReceiptSha256,
		claim.bindingAuthoritySha256,
		claim.bindingOpenRequestSha256,
		claim.isolationNamespaceSha256,
		claim.isolationOwnerManifestSha256,
		claim.isolationCreatorDescriptorSha256,
		claim.claimedAt,
	];
}

function lifecycleWorktreeRequestTuple(
	request: TransientTaskCanonicalWorktreePublicationAttemptV1["request"],
): readonly CanonicalRuntimeValue[] {
	return [
		LIFECYCLE_WORKTREE_PUBLICATION_DOMAIN,
		"request",
		1,
		request.taskId,
		request.runId,
		request.workspaceId,
		request.createId,
		request.cleanupId,
		request.cleanupAuthorityId,
		request.expectedAuthorityRevision,
		request.expectedGeneration,
		request.expectedRootSha256,
		request.fencingGeneration,
		lifecycleWorktreeCleanupProofTuple(request.cleanup),
		request.worktreePublicationId,
		request.effectIdentityManifestSha256,
		lifecycleWorktreeTargetKeyTuple(request.publicationTargetKey),
		lifecycleWorktreePublicationClaimTuple(request.publicationClaim),
		request.bindingRevision,
		request.bindingRenewalSequence,
		request.bindingReceiptSha256,
		request.bindingAuthoritySha256,
		request.bindingOpenRequestSha256,
		lifecycleCheckpointTuple(request.checkpoint),
	];
}

function lifecycleWorktreeAttemptTuple(
	attempt: TransientTaskCanonicalWorktreePublicationAttemptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		LIFECYCLE_WORKTREE_PUBLICATION_DOMAIN,
		"attempt",
		1,
		lifecycleWorktreeRequestTuple(attempt.request),
		lifecycleWorktreePublicationClaimTuple(attempt.publicationClaim),
		attempt.openedAt,
	];
}

function lifecycleWorktreeReceiptTuple(
	receipt: TransientTaskWorktreePublicationReceiptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		LIFECYCLE_WORKTREE_PUBLICATION_DOMAIN,
		"receipt",
		1,
		receipt.taskId,
		receipt.runId,
		receipt.worktreePublicationId,
		receipt.effectIdentityManifestSha256,
		receipt.workspaceId,
		receipt.createId,
		receipt.cleanupId,
		receipt.cleanupAuthorityId,
		lifecycleWorktreeTargetKeyTuple(receipt.publicationTargetKey),
		lifecycleWorktreePublicationClaimTuple(receipt.publicationClaim),
		receipt.bindingRevision,
		receipt.bindingRenewalSequence,
		receipt.bindingReceiptSha256,
		receipt.bindingAuthoritySha256,
		receipt.bindingOpenRequestSha256,
		lifecycleCheckpointTuple(receipt.checkpoint),
		receipt.requestSha256,
		receipt.attemptSha256,
		receipt.publishedAt,
	];
}

function lifecycleWorktreeNotAppliedTuple(
	receipt: TransientTaskCanonicalWorktreePublicationNotAppliedReceiptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		LIFECYCLE_WORKTREE_PUBLICATION_DOMAIN,
		"not_applied",
		1,
		receipt.taskId,
		receipt.runId,
		receipt.cleanupId,
		receipt.cleanupAuthorityId,
		receipt.worktreePublicationId,
		lifecycleWorktreeTargetKeyTuple(receipt.publicationTargetKey),
		receipt.publicationClaimSha256,
		receipt.publicationRequestSha256,
		receipt.publicationAttemptSha256,
		receipt.inspectedAt,
	];
}

function validLifecyclePublicationClaim(input: unknown): input is TransientTaskPublicationTargetPublicationClaimV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"key",
			"isolationCleanupId",
			"worktreePublicationId",
			"openOperationId",
			"access",
			"bindingRevision",
			"renewalSequence",
			"bindingReceiptSha256",
			"bindingAuthoritySha256",
			"bindingOpenRequestSha256",
			"isolationNamespaceSha256",
			"isolationOwnerManifestSha256",
			"isolationCreatorDescriptorSha256",
			"claimedAt",
			"claimSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validateTransientTaskPublicationTargetKeyV1(input.key) ||
		!lifecycleIdentity(input.isolationCleanupId) ||
		!lifecycleIdentity(input.worktreePublicationId) ||
		!lifecycleIdentity(input.openOperationId) ||
		input.access !== "live" ||
		!lifecycleSafeInteger(input.bindingRevision, 1) ||
		!lifecycleSafeInteger(input.renewalSequence) ||
		input.bindingRevision !== input.renewalSequence + 1 ||
		!lifecycleSha256Ref(input.bindingReceiptSha256) ||
		!lifecycleSha256Ref(input.bindingAuthoritySha256) ||
		!lifecycleSha256Hex(input.bindingOpenRequestSha256) ||
		!lifecycleSha256Hex(input.isolationNamespaceSha256) ||
		!lifecycleSha256Ref(input.isolationOwnerManifestSha256) ||
		!lifecycleSha256Ref(input.isolationCreatorDescriptorSha256) ||
		!lifecycleIso8601(input.claimedAt) ||
		!lifecycleSha256Ref(input.claimSha256)
	)
		return false;
	const key = input.key as TransientTaskPublicationTargetKeyV1;
	return (
		input.claimSha256 ===
		lifecycleTupleRef([
			"omp-transient-task-publication-target-v1",
			"publication_claim",
			1,
			lifecyclePublicationTargetKeyTuple(key),
			input.isolationCleanupId,
			input.worktreePublicationId,
			input.openOperationId,
			"live",
			input.bindingRevision,
			input.renewalSequence,
			input.bindingReceiptSha256,
			input.bindingAuthoritySha256,
			input.bindingOpenRequestSha256,
			input.isolationNamespaceSha256,
			input.isolationOwnerManifestSha256,
			input.isolationCreatorDescriptorSha256,
			input.claimedAt,
		])
	);
}

function validLifecycleWorktreeRequest(
	input: unknown,
): input is TransientTaskCanonicalWorktreePublicationAttemptV1["request"] {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"workspaceId",
			"cleanupId",
			"cleanupAuthorityId",
			"expectedAuthorityRevision",
			"expectedGeneration",
			"expectedRootSha256",
			"fencingGeneration",
			"cleanup",
			"requestSha256",
			"createId",
			"worktreePublicationId",
			"effectIdentityManifestSha256",
			"publicationTargetKey",
			"publicationClaim",
			"bindingRevision",
			"bindingRenewalSequence",
			"bindingReceiptSha256",
			"bindingAuthoritySha256",
			"bindingOpenRequestSha256",
			"checkpoint",
		]) ||
		input.schemaVersion !== 1 ||
		![
			input.taskId,
			input.runId,
			input.workspaceId,
			input.cleanupId,
			input.cleanupAuthorityId,
			input.createId,
			input.worktreePublicationId,
		].every(lifecycleIdentity) ||
		!lifecycleSafeInteger(input.expectedAuthorityRevision) ||
		!lifecycleSafeInteger(input.expectedGeneration) ||
		!lifecycleSha256Hex(input.expectedRootSha256) ||
		!lifecycleSafeInteger(input.fencingGeneration, 1) ||
		!validLifecycleCleanupProof(input.cleanup) ||
		!lifecycleSha256Hex(input.requestSha256) ||
		!lifecycleSha256Ref(input.effectIdentityManifestSha256) ||
		!validateTransientTaskPublicationTargetKeyV1(input.publicationTargetKey) ||
		!validLifecyclePublicationClaim(input.publicationClaim) ||
		!lifecycleSafeInteger(input.bindingRevision, 1) ||
		!lifecycleSafeInteger(input.bindingRenewalSequence) ||
		!lifecycleSha256Ref(input.bindingReceiptSha256) ||
		!lifecycleSha256Ref(input.bindingAuthoritySha256) ||
		!lifecycleSha256Hex(input.bindingOpenRequestSha256) ||
		!validLifecycleCheckpoint(input.checkpoint)
	)
		return false;
	const request = input as unknown as TransientTaskCanonicalWorktreePublicationAttemptV1["request"];
	const cleanup = request.cleanup;
	const key = request.publicationTargetKey;
	const claim = request.publicationClaim;
	const checkpoint = request.checkpoint;
	return (
		cleanup.taskId === request.taskId &&
		cleanup.runId === request.runId &&
		cleanup.workspaceId === request.workspaceId &&
		cleanup.cleanupId === request.cleanupId &&
		cleanup.cleanupAuthorityId === request.cleanupAuthorityId &&
		cleanup.fencingGeneration === request.fencingGeneration &&
		key.taskId === request.taskId &&
		key.runId === request.runId &&
		key.createId === request.createId &&
		exactJson(claim.key, key) &&
		claim.worktreePublicationId === request.worktreePublicationId &&
		request.bindingRevision === claim.bindingRevision &&
		request.bindingRenewalSequence === claim.renewalSequence &&
		request.bindingReceiptSha256 === claim.bindingReceiptSha256 &&
		request.bindingAuthoritySha256 === claim.bindingAuthoritySha256 &&
		request.bindingOpenRequestSha256 === claim.bindingOpenRequestSha256 &&
		checkpoint.workspaceId === request.workspaceId &&
		checkpoint.generation === request.expectedGeneration &&
		checkpoint.rootSha256 === request.expectedRootSha256 &&
		request.requestSha256 === tupleSha256(lifecycleWorktreeRequestTuple(request))
	);
}

function validLifecycleWorktreeAttempt(input: unknown): input is TransientTaskCanonicalWorktreePublicationAttemptV1 {
	if (
		!strictRecord(input, ["request", "publicationClaim", "openedAt", "attemptSha256"]) ||
		!validLifecycleWorktreeRequest(input.request) ||
		!validLifecyclePublicationClaim(input.publicationClaim) ||
		!exactJson(input.publicationClaim, input.request.publicationClaim) ||
		!lifecycleIso8601(input.openedAt) ||
		!lifecycleSha256Ref(input.attemptSha256)
	)
		return false;
	const attempt = input as unknown as TransientTaskCanonicalWorktreePublicationAttemptV1;
	return attempt.attemptSha256 === lifecycleTupleRef(lifecycleWorktreeAttemptTuple(attempt));
}

function validLifecycleWorktreeReceipt(input: unknown): input is TransientTaskWorktreePublicationReceiptV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"worktreePublicationId",
			"effectIdentityManifestSha256",
			"workspaceId",
			"createId",
			"cleanupId",
			"cleanupAuthorityId",
			"publicationTargetKey",
			"publicationClaim",
			"bindingRevision",
			"bindingRenewalSequence",
			"bindingReceiptSha256",
			"bindingAuthoritySha256",
			"bindingOpenRequestSha256",
			"checkpoint",
			"requestSha256",
			"attemptSha256",
			"publishedAt",
			"receiptSha256",
		]) ||
		input.schemaVersion !== 1 ||
		![
			input.taskId,
			input.runId,
			input.worktreePublicationId,
			input.workspaceId,
			input.createId,
			input.cleanupId,
			input.cleanupAuthorityId,
		].every(lifecycleIdentity) ||
		!lifecycleSha256Ref(input.effectIdentityManifestSha256) ||
		!validateTransientTaskPublicationTargetKeyV1(input.publicationTargetKey) ||
		!validLifecyclePublicationClaim(input.publicationClaim) ||
		!lifecycleSafeInteger(input.bindingRevision, 1) ||
		!lifecycleSafeInteger(input.bindingRenewalSequence) ||
		!lifecycleSha256Ref(input.bindingReceiptSha256) ||
		!lifecycleSha256Ref(input.bindingAuthoritySha256) ||
		!lifecycleSha256Hex(input.bindingOpenRequestSha256) ||
		!validLifecycleCheckpoint(input.checkpoint) ||
		!lifecycleSha256Hex(input.requestSha256) ||
		!lifecycleSha256Ref(input.attemptSha256) ||
		!lifecycleIso8601(input.publishedAt) ||
		!lifecycleSha256Ref(input.receiptSha256)
	)
		return false;
	const receipt = input as unknown as TransientTaskWorktreePublicationReceiptV1;
	const key = receipt.publicationTargetKey;
	const claim = receipt.publicationClaim;
	const checkpoint = receipt.checkpoint;
	return (
		key.taskId === receipt.taskId &&
		key.runId === receipt.runId &&
		key.createId === receipt.createId &&
		exactJson(claim.key, key) &&
		claim.worktreePublicationId === receipt.worktreePublicationId &&
		receipt.bindingRevision === claim.bindingRevision &&
		receipt.bindingRenewalSequence === claim.renewalSequence &&
		receipt.bindingReceiptSha256 === claim.bindingReceiptSha256 &&
		receipt.bindingAuthoritySha256 === claim.bindingAuthoritySha256 &&
		receipt.bindingOpenRequestSha256 === claim.bindingOpenRequestSha256 &&
		checkpoint.workspaceId === receipt.workspaceId &&
		receipt.receiptSha256 === lifecycleTupleRef(lifecycleWorktreeReceiptTuple(receipt))
	);
}

function validLifecycleWorktreeNotApplied(
	input: unknown,
): input is TransientTaskCanonicalWorktreePublicationNotAppliedReceiptV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"cleanupId",
			"cleanupAuthorityId",
			"worktreePublicationId",
			"publicationTargetKey",
			"publicationClaimSha256",
			"publicationRequestSha256",
			"publicationAttemptSha256",
			"inspectedAt",
			"receiptSha256",
		]) ||
		input.schemaVersion !== 1 ||
		![input.taskId, input.runId, input.cleanupId, input.cleanupAuthorityId, input.worktreePublicationId].every(
			lifecycleIdentity,
		) ||
		!validateTransientTaskPublicationTargetKeyV1(input.publicationTargetKey) ||
		!lifecycleSha256Ref(input.publicationClaimSha256) ||
		!lifecycleSha256Hex(input.publicationRequestSha256) ||
		!lifecycleSha256Ref(input.publicationAttemptSha256) ||
		!lifecycleIso8601(input.inspectedAt) ||
		!lifecycleSha256Ref(input.receiptSha256)
	)
		return false;
	const receipt = input as unknown as TransientTaskCanonicalWorktreePublicationNotAppliedReceiptV1;
	return receipt.receiptSha256 === lifecycleTupleRef(lifecycleWorktreeNotAppliedTuple(receipt));
}

function validLifecycleCanonicalCommit(input: unknown): input is CanonicalWorkspaceCommitReceipt {
	return Boolean(
		strictRecord(input, ["workspaceId", "commitId", "expectedGeneration", "checkpoint", "durableAt"]) &&
			lifecycleIdentity(input.workspaceId) &&
			lifecycleIdentity(input.commitId) &&
			lifecycleSafeInteger(input.expectedGeneration) &&
			validLifecycleCheckpoint(input.checkpoint) &&
			(input.checkpoint as WorkspaceCheckpoint).workspaceId === input.workspaceId &&
			input.checkpoint.generation === input.expectedGeneration + 1 &&
			lifecycleIso8601(input.durableAt),
	);
}

function validLifecycleFrozenCheckpoint(input: unknown): input is FrozenReplicaCheckpointRef {
	try {
		decodeFrozenCheckpointReference(input);
		return true;
	} catch {
		return false;
	}
}

function validLifecycleCheckpointAcknowledgement(input: unknown): input is RuntimeCheckpointAcknowledgeResult {
	return Boolean(
		strictRecord(input, ["status", "request", "reference", "canonicalCommit", "acknowledgedAt"]) &&
			(input.status === "acknowledged" || input.status === "already_acknowledged") &&
			validLifecycleProviderRequest(input.request, "parent") &&
			validLifecycleFrozenCheckpoint(input.reference) &&
			validLifecycleCanonicalCommit(input.canonicalCommit) &&
			input.canonicalCommit.expectedGeneration === input.reference.baseGeneration &&
			input.canonicalCommit.checkpoint.workspaceId === input.reference.workspaceId &&
			input.canonicalCommit.checkpoint.generation === input.reference.baseGeneration + 1 &&
			input.canonicalCommit.checkpoint.rootSha256 === input.reference.rootSha256 &&
			input.canonicalCommit.checkpoint.fileCount === input.reference.fileCount &&
			input.canonicalCommit.checkpoint.byteCount === input.reference.byteCount &&
			input.request.requestSha256 ===
				tupleSha256([
					"omp-runtime-provider-v1",
					"checkpoint_ack",
					input.request.parentOperationId,
					input.reference.providerId,
					input.reference.profileId,
					input.reference.workspaceId,
					input.reference.replicaId,
					input.reference.leaseId,
					input.reference.checkpointId,
					input.reference.baseGeneration,
					input.canonicalCommit.commitId,
					input.canonicalCommit.checkpoint.generation,
					input.canonicalCommit.checkpoint.rootSha256,
					input.canonicalCommit.checkpoint.fileCount,
					input.canonicalCommit.checkpoint.byteCount,
				]) &&
			lifecycleIso8601(input.acknowledgedAt),
	);
}

function validLifecycleRelease(input: unknown): input is RuntimeLeaseReleaseResult {
	return Boolean(
		strictRecord(input, ["status", "request", "replica", "leaseId", "compute"]) &&
			["released", "already_released", "expired", "absent"].includes(input.status as string) &&
			validLifecycleProviderRequest(input.request, "parent") &&
			validLifecycleReplica(input.replica) &&
			lifecycleIdentity(input.leaseId) &&
			(input.compute === "stopped" || input.compute === "not_applicable"),
	);
}

function validLifecycleDeletionAuthorization(
	input: unknown,
): input is Extract<RuntimeReplicaDeletionAuthorizationV1, { domain: "transient_task" }> {
	return Boolean(
		strictRecord(input, [
			"domain",
			"taskId",
			"runId",
			"workspaceId",
			"cleanupId",
			"cleanupAuthorityId",
			"cleanupPlanSha256",
			"finalCheckpoint",
			"replicaDeleteRequestId",
			"replicaDeletionQuarantineId",
			"replicaDeletionPlannedAt",
			"replicaDeletionPurgeAfter",
		]) &&
			input.domain === "transient_task" &&
			[
				input.taskId,
				input.runId,
				input.workspaceId,
				input.cleanupId,
				input.cleanupAuthorityId,
				input.replicaDeleteRequestId,
				input.replicaDeletionQuarantineId,
			].every(lifecycleIdentity) &&
			lifecycleSha256Ref(input.cleanupPlanSha256) &&
			validLifecycleCheckpoint(input.finalCheckpoint) &&
			(input.finalCheckpoint as WorkspaceCheckpoint).workspaceId === input.workspaceId &&
			lifecycleIso8601(input.replicaDeletionPlannedAt) &&
			lifecycleIso8601(input.replicaDeletionPurgeAfter) &&
			Date.parse(input.replicaDeletionPlannedAt as string) <= Date.parse(input.replicaDeletionPurgeAfter as string),
	);
}

function validLifecyclePreparedDelete(input: unknown): input is TransientTaskPreparedReplicaDeleteV1 {
	if (
		!strictRecord(input, ["requestId", "requestSha256", "replica", "authorization", "preparedAt"]) ||
		!lifecycleIdentity(input.requestId) ||
		!lifecycleSha256Hex(input.requestSha256) ||
		!validLifecycleReplica(input.replica) ||
		!validLifecycleDeletionAuthorization(input.authorization) ||
		input.requestId !== input.authorization.replicaDeleteRequestId ||
		input.replica.workspaceId !== input.authorization.workspaceId ||
		!lifecycleIso8601(input.preparedAt)
	)
		return false;
	const replica = input.replica;
	const authorization = input.authorization;
	return (
		input.requestSha256 ===
		tupleSha256([
			"omp-runtime-provider-v1",
			"replica_delete",
			"transient_task",
			replica.providerId,
			replica.profileId,
			replica.workspaceId,
			replica.replicaId,
			authorization.taskId,
			authorization.runId,
			authorization.workspaceId,
			authorization.cleanupId,
			authorization.cleanupAuthorityId,
			authorization.cleanupPlanSha256,
			lifecycleCheckpointTuple(authorization.finalCheckpoint),
			authorization.replicaDeleteRequestId,
			authorization.replicaDeletionQuarantineId,
			authorization.replicaDeletionPlannedAt,
			authorization.replicaDeletionPurgeAfter,
		])
	);
}

function validLifecycleReplicaDelete(
	input: unknown,
): input is Extract<RuntimeReplicaDeleteResult, { status: "deleted" | "already_deleted" | "absent" }> {
	return Boolean(
		strictRecord(input, [
			"request",
			"replica",
			"authorization",
			"observedAt",
			"status",
			"retryAfter",
			"receiptSha256",
		]) &&
			validLifecycleProviderRequest(input.request) &&
			validLifecycleReplica(input.replica) &&
			validLifecycleDeletionAuthorization(input.authorization) &&
			(input.status === "deleted" || input.status === "already_deleted" || input.status === "absent") &&
			input.retryAfter === null &&
			lifecycleSha256Ref(input.receiptSha256) &&
			lifecycleIso8601(input.observedAt),
	);
}

function validLifecycleTombstone(input: unknown): input is TransientTaskWorkspaceTombstoneV1 {
	return Boolean(
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"workspaceId",
			"cleanupId",
			"cleanupAuthorityId",
			"terminalState",
			"finalCheckpoint",
			"providerDeletionAuthorization",
			"planSha256",
			"deletedAt",
		]) &&
			input.schemaVersion === 1 &&
			[input.taskId, input.runId, input.workspaceId, input.cleanupId, input.cleanupAuthorityId].every(
				lifecycleIdentity,
			) &&
			(input.terminalState === "deleted" || input.terminalState === "discarded") &&
			validLifecycleCheckpoint(input.finalCheckpoint) &&
			validLifecycleDeletionAuthorization(input.providerDeletionAuthorization) &&
			lifecycleSha256Ref(input.planSha256) &&
			lifecycleIso8601(input.deletedAt),
	);
}

function lifecycleCanonicalJson(input: unknown): string {
	if (input === null || typeof input === "boolean" || typeof input === "number" || typeof input === "string") {
		const encoded = JSON.stringify(input);
		if (encoded === undefined) throw new Error("Lifecycle evidence is not JSON serializable");
		return encoded;
	}
	if (Array.isArray(input)) return `[${input.map(lifecycleCanonicalJson).join(",")}]`;
	const record = input as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${lifecycleCanonicalJson(record[key])}`)
		.join(",")}}`;
}

function lifecycleTerminalEvidenceTuple(
	evidence: TransientTaskCanonicalProviderTerminalEvidenceV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-canonical-provider-terminal-evidence-v1",
		1,
		evidence.taskId,
		evidence.runId,
		evidence.postTerminalCleanupEvidenceId,
		evidence.cleanupId,
		evidence.cleanupAuthorityId,
		evidence.workspaceId,
		evidence.resultPublicationId,
		evidence.publicationTargetId,
		lifecycleCanonicalJson(evidence.publicationTargetKey),
		evidence.isolationCleanupId,
		evidence.worktreePublicationId,
		evidence.effectIdentityManifestSha256,
		evidence.isolationNamespaceSha256,
		evidence.isolationOwnerManifestSha256,
		evidence.isolationCreatorDescriptorSha256,
		evidence.worktreePublicationUse,
		evidence.worktreePublicationAttemptSha256,
		evidence.worktreePublication === null ? null : lifecycleCanonicalJson(evidence.worktreePublication),
		evidence.resultPublicationTargetId,
		evidence.pendingPayloadId,
		evidence.pendingPayloadDeleteId,
		evidence.composedPayloadId,
		evidence.composedPayloadDeleteId,
		evidence.pendingOutcomeSha256,
		evidence.outcome,
		lifecycleCanonicalJson(evidence.branch),
		evidence.planSha256,
		evidence.canonicalCommit === null ? null : lifecycleCanonicalJson(evidence.canonicalCommit),
		evidence.checkpointAcknowledgement === null ? null : lifecycleCanonicalJson(evidence.checkpointAcknowledgement),
		lifecycleCanonicalJson(evidence.release),
		lifecycleCanonicalJson(evidence.preparedReplicaDelete),
		lifecycleCanonicalJson(evidence.replicaDelete),
		lifecycleDiscardTuple(evidence.canonicalDiscard),
		lifecycleCanonicalJson(evidence.tombstone),
		evidence.terminalAt,
	];
}

function validLifecycleTerminalEvidence(input: unknown): input is TransientTaskCanonicalProviderTerminalEvidenceV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"postTerminalCleanupEvidenceId",
			"cleanupId",
			"cleanupAuthorityId",
			"workspaceId",
			"resultPublicationId",
			"publicationTargetId",
			"publicationTargetKey",
			"isolationCleanupId",
			"worktreePublicationId",
			"effectIdentityManifestSha256",
			"isolationNamespaceSha256",
			"isolationOwnerManifestSha256",
			"isolationCreatorDescriptorSha256",
			"worktreePublicationUse",
			"worktreePublicationAttemptSha256",
			"worktreePublication",
			"resultPublicationTargetId",
			"pendingPayloadId",
			"pendingPayloadDeleteId",
			"composedPayloadId",
			"composedPayloadDeleteId",
			"pendingOutcomeSha256",
			"outcome",
			"branch",
			"planSha256",
			"canonicalCommit",
			"checkpointAcknowledgement",
			"release",
			"preparedReplicaDelete",
			"replicaDelete",
			"canonicalDiscard",
			"tombstone",
			"terminalAt",
			"evidenceSha256",
		]) ||
		input.schemaVersion !== 1 ||
		![
			input.taskId,
			input.runId,
			input.postTerminalCleanupEvidenceId,
			input.cleanupId,
			input.cleanupAuthorityId,
			input.workspaceId,
			input.resultPublicationId,
			input.publicationTargetId,
			input.isolationCleanupId,
			input.worktreePublicationId,
			input.resultPublicationTargetId,
			input.pendingPayloadId,
			input.pendingPayloadDeleteId,
			input.composedPayloadId,
			input.composedPayloadDeleteId,
		].every(lifecycleIdentity) ||
		!validateTransientTaskPublicationTargetKeyV1(input.publicationTargetKey) ||
		!lifecycleSha256Ref(input.effectIdentityManifestSha256) ||
		!lifecycleSha256Hex(input.isolationNamespaceSha256) ||
		!lifecycleSha256Ref(input.isolationOwnerManifestSha256) ||
		!lifecycleSha256Ref(input.isolationCreatorDescriptorSha256) ||
		!lifecycleSha256Ref(input.pendingOutcomeSha256) ||
		(input.outcome !== "succeeded" && input.outcome !== "failed" && input.outcome !== "cancelled") ||
		!validLifecycleCleanupBranch(input.branch) ||
		!lifecycleSha256Ref(input.planSha256) ||
		(input.canonicalCommit !== null && !validLifecycleCanonicalCommit(input.canonicalCommit)) ||
		(input.checkpointAcknowledgement !== null &&
			!validLifecycleCheckpointAcknowledgement(input.checkpointAcknowledgement)) ||
		!validLifecycleRelease(input.release) ||
		!validLifecyclePreparedDelete(input.preparedReplicaDelete) ||
		!validLifecycleReplicaDelete(input.replicaDelete) ||
		!validLifecycleDiscardReceipt(input.canonicalDiscard) ||
		!validLifecycleTombstone(input.tombstone) ||
		!lifecycleIso8601(input.terminalAt) ||
		!lifecycleSha256Ref(input.evidenceSha256)
	)
		return false;
	if (input.worktreePublicationUse === "published") {
		if (
			!lifecycleSha256Ref(input.worktreePublicationAttemptSha256) ||
			!validLifecycleWorktreeReceipt(input.worktreePublication) ||
			input.worktreePublicationAttemptSha256 !== input.worktreePublication.attemptSha256
		)
			return false;
	} else if (
		input.worktreePublicationUse !== "unused_non_success" ||
		input.worktreePublicationAttemptSha256 !== null ||
		input.worktreePublication !== null
	)
		return false;
	if (
		(input.outcome === "succeeded") !== (input.branch.reason === "task_succeeded") ||
		(input.outcome === "succeeded") !== (input.worktreePublicationUse === "published") ||
		!exactJson(input.preparedReplicaDelete.replica, input.replicaDelete.replica) ||
		!exactJson(input.preparedReplicaDelete.authorization, input.replicaDelete.authorization) ||
		input.preparedReplicaDelete.requestId !== input.replicaDelete.request.requestId ||
		input.preparedReplicaDelete.requestSha256 !== input.replicaDelete.request.requestSha256 ||
		!exactJson(input.release.replica, input.preparedReplicaDelete.replica) ||
		input.canonicalDiscard.taskId !== input.taskId ||
		input.canonicalDiscard.runId !== input.runId ||
		input.canonicalDiscard.workspaceId !== input.workspaceId ||
		input.canonicalDiscard.cleanupId !== input.cleanupId ||
		input.canonicalDiscard.cleanupAuthorityId !== input.cleanupAuthorityId ||
		input.canonicalDiscard.cleanupPlanSha256 !== input.planSha256 ||
		input.tombstone.taskId !== input.taskId ||
		input.tombstone.runId !== input.runId ||
		input.tombstone.workspaceId !== input.workspaceId ||
		input.tombstone.cleanupId !== input.cleanupId ||
		input.tombstone.cleanupAuthorityId !== input.cleanupAuthorityId ||
		input.tombstone.planSha256 !== input.planSha256 ||
		!exactJson(input.tombstone.finalCheckpoint, input.canonicalDiscard.finalCheckpoint) ||
		!exactJson(input.tombstone.providerDeletionAuthorization, input.preparedReplicaDelete.authorization) ||
		input.tombstone.deletedAt !== input.terminalAt ||
		(input.branch.kind === "preserve") !==
			(input.canonicalCommit !== null && input.checkpointAcknowledgement !== null) ||
		(input.branch.kind === "fast_discard") !== (input.tombstone.terminalState === "discarded")
	)
		return false;
	const evidence = input as unknown as TransientTaskCanonicalProviderTerminalEvidenceV1;
	return evidence.evidenceSha256 === lifecycleTupleRef(lifecycleTerminalEvidenceTuple(evidence));
}

function validLifecycleCleanupProgress(
	input: unknown,
	workspaceId: WorkspaceId,
): input is TransientTaskCleanupProgressV1 {
	if (
		!proxyFreeData(input) ||
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		!("state" in input)
	)
		return false;
	if (input.state === "planned" || input.state === "admission_closed" || input.state === "assessment_outcome_unknown")
		return strictRecord(input, ["state"]);
	if (input.state === "branch_selected")
		return strictRecord(input, ["state", "branch"]) && validLifecycleCleanupBranch(input.branch);
	if (input.state === "runtime_draining")
		return Boolean(
			strictRecord(input, ["state", "branch", "runtime"]) &&
				validLifecycleCleanupBranch(input.branch) &&
				validLifecycleRuntimeAttachment(input.runtime, workspaceId, "draining"),
		);
	if (input.state === "worktree_publication_outcome_unknown")
		return Boolean(
			strictRecord(input, ["state", "branch", "attempt"]) &&
				validLifecycleCleanupBranch(input.branch) &&
				input.branch.reason === "task_succeeded" &&
				validLifecycleWorktreeAttempt(input.attempt),
		);
	if (input.state === "worktree_publication_not_applied")
		return Boolean(
			strictRecord(input, ["state", "branch", "attempt", "proof"]) &&
				validLifecycleCleanupBranch(input.branch) &&
				input.branch.reason === "task_succeeded" &&
				validLifecycleWorktreeAttempt(input.attempt) &&
				validLifecycleWorktreeNotApplied(input.proof) &&
				input.proof.taskId === input.attempt.request.taskId &&
				input.proof.runId === input.attempt.request.runId &&
				input.proof.cleanupId === input.attempt.request.cleanupId &&
				input.proof.cleanupAuthorityId === input.attempt.request.cleanupAuthorityId &&
				input.proof.worktreePublicationId === input.attempt.request.worktreePublicationId &&
				exactJson(input.proof.publicationTargetKey, input.attempt.request.publicationTargetKey) &&
				input.proof.publicationClaimSha256 === input.attempt.request.publicationClaim.claimSha256 &&
				input.proof.publicationRequestSha256 === input.attempt.request.requestSha256 &&
				input.proof.publicationAttemptSha256 === input.attempt.attemptSha256,
		);
	if (input.state === "worktree_published")
		return Boolean(
			strictRecord(input, ["state", "branch", "receipt"]) &&
				validLifecycleCleanupBranch(input.branch) &&
				input.branch.reason === "task_succeeded" &&
				validLifecycleWorktreeReceipt(input.receipt),
		);
	if (input.state === "runtime_released")
		return Boolean(
			strictRecord(input, [
				"state",
				"branch",
				"runtime",
				"release",
				"worktreePublicationId",
				"worktreePublicationUse",
				"worktreePublication",
			]) &&
				validLifecycleCleanupBranch(input.branch) &&
				validLifecycleRuntimeAttachment(input.runtime, workspaceId, "none") &&
				validLifecycleRelease(input.release) &&
				lifecycleIdentity(input.worktreePublicationId) &&
				((input.worktreePublicationUse === "published" &&
					validLifecycleWorktreeReceipt(input.worktreePublication) &&
					input.worktreePublication.worktreePublicationId === input.worktreePublicationId) ||
					(input.worktreePublicationUse === "unused_non_success" && input.worktreePublication === null)),
		);
	if (input.state === "replica_delete_prepared" || input.state === "replica_delete_outcome_unknown")
		return Boolean(
			strictRecord(input, ["state", "branch", "prepared"]) &&
				validLifecycleCleanupBranch(input.branch) &&
				validLifecyclePreparedDelete(input.prepared),
		);
	if (input.state === "replica_deleted" || input.state === "canonical_discard_outcome_unknown")
		return Boolean(
			strictRecord(input, ["state", "branch", "prepared", "result"]) &&
				validLifecycleCleanupBranch(input.branch) &&
				validLifecyclePreparedDelete(input.prepared) &&
				validLifecycleReplicaDelete(input.result) &&
				exactJson(input.prepared.replica, input.result.replica) &&
				exactJson(input.prepared.authorization, input.result.authorization) &&
				input.prepared.requestId === input.result.request.requestId &&
				input.prepared.requestSha256 === input.result.request.requestSha256,
		);
	if (input.state === "blocked")
		return Boolean(
			strictRecord(input, ["state", "branch", "block"]) &&
				(input.branch === null || validLifecycleCleanupBranch(input.branch)) &&
				validLifecycleBlock(input.block),
		);
	return Boolean(
		input.state === "canonical_provider_terminal" &&
			strictRecord(input, ["state", "evidence"]) &&
			validLifecycleTerminalEvidence(input.evidence),
	);
}

const TRANSIENT_AUTHORITY_BASE_KEYS = [
	"schemaVersion",
	"taskId",
	"runId",
	"revision",
	"createId",
	"cleanupAuthorityId",
	"resultPublicationId",
	"capturePreparationId",
	"captureId",
	"semanticMergeId",
	"semanticMergeFinishId",
	"isolationCleanupId",
	"resultCompositionId",
	"effectIdentityManifest",
	"postTerminalIntentSha256",
	"isolationNamespaceSha256",
	"isolationOwnerManifestSha256",
	"isolationCreatorDescriptorSha256",
	"publicationTargetId",
	"resultPublicationTargetId",
	"resultPublicationTargetCleanupId",
	"pendingPayloadId",
	"pendingPayloadDeleteId",
	"composedPayloadId",
	"composedPayloadDeleteId",
	"resultlessIdentity",
	"resultlessMaximumUtf8ByteLength",
	"resultlessRepresentabilityPreflightSha256",
	"resultPublicationPrePendingPlanSha256",
	"workspaceId",
	"controlHostId",
	"createdAt",
	"updatedAt",
] as const;

function validLifecycleAuthorityBase(input: Record<string, unknown>): boolean {
	return Boolean(
		input.schemaVersion === 1 &&
			[
				input.taskId,
				input.runId,
				input.createId,
				input.cleanupAuthorityId,
				input.resultPublicationId,
				input.capturePreparationId,
				input.captureId,
				input.semanticMergeId,
				input.semanticMergeFinishId,
				input.isolationCleanupId,
				input.resultCompositionId,
				input.publicationTargetId,
				input.resultPublicationTargetId,
				input.resultPublicationTargetCleanupId,
				input.pendingPayloadId,
				input.pendingPayloadDeleteId,
				input.composedPayloadId,
				input.composedPayloadDeleteId,
				input.workspaceId,
				input.controlHostId,
			].every(lifecycleIdentity) &&
			lifecycleSafeInteger(input.revision) &&
			validLifecycleManifest(input.effectIdentityManifest) &&
			input.effectIdentityManifest.taskId === input.taskId &&
			input.effectIdentityManifest.runId === input.runId &&
			lifecycleSha256Ref(input.postTerminalIntentSha256) &&
			lifecycleSha256Hex(input.isolationNamespaceSha256) &&
			lifecycleSha256Ref(input.isolationOwnerManifestSha256) &&
			lifecycleSha256Ref(input.isolationCreatorDescriptorSha256) &&
			validLifecycleResultlessIdentity(input.resultlessIdentity) &&
			lifecycleSafeInteger(input.resultlessMaximumUtf8ByteLength, 1) &&
			lifecycleSha256Ref(input.resultlessRepresentabilityPreflightSha256) &&
			lifecycleSha256Ref(input.resultPublicationPrePendingPlanSha256) &&
			lifecycleIso8601(input.createdAt) &&
			lifecycleIso8601(input.updatedAt) &&
			Date.parse(input.createdAt as string) <= Date.parse(input.updatedAt as string),
	);
}

function lifecycleControllerJoins(
	input: Record<string, unknown>,
	controller: TransientTaskControllerAuthorityV1,
): boolean {
	return (
		controller.proof.taskId === input.taskId &&
		controller.proof.runId === input.runId &&
		controller.proof.createId === input.createId &&
		controller.proof.workspaceId === input.workspaceId
	);
}

function lifecyclePlanJoinsAuthority(plan: TransientTaskCleanupPlanV1, input: Record<string, unknown>): boolean {
	const manifest = input.effectIdentityManifest as TransientTaskEffectIdentityManifestV1;
	return (
		plan.taskId === input.taskId &&
		plan.runId === input.runId &&
		plan.cleanupAuthorityId === input.cleanupAuthorityId &&
		plan.workspaceId === input.workspaceId &&
		plan.expectedCanonical.createId === input.createId &&
		plan.publicationTargetId === input.publicationTargetId &&
		plan.publicationTargetKey.createId === input.createId &&
		plan.isolationCleanupId === input.isolationCleanupId &&
		plan.worktreePublicationId === manifest.worktreePublicationId &&
		plan.effectIdentityManifestSha256 === manifest.manifestSha256 &&
		plan.resultPublicationId === input.resultPublicationId &&
		plan.resultPublicationTargetId === input.resultPublicationTargetId &&
		plan.resultPublicationTargetCleanupId === input.resultPublicationTargetCleanupId &&
		plan.pendingPayloadId === input.pendingPayloadId &&
		plan.pendingPayloadDeleteId === input.pendingPayloadDeleteId &&
		plan.composedPayloadId === input.composedPayloadId &&
		plan.composedPayloadDeleteId === input.composedPayloadDeleteId
	);
}

function lifecyclePendingJoinsAuthority(
	receipt: TransientTaskPendingOutcomeReceiptV1,
	input: Record<string, unknown>,
): boolean {
	return (
		receipt.taskId === input.taskId &&
		receipt.runId === input.runId &&
		receipt.createId === input.createId &&
		receipt.resultPublicationId === input.resultPublicationId &&
		receipt.resultPublicationTargetId === input.resultPublicationTargetId &&
		receipt.resultPublicationTargetCleanupId === input.resultPublicationTargetCleanupId &&
		receipt.pendingPayloadId === input.pendingPayloadId &&
		receipt.pendingPayloadDeleteId === input.pendingPayloadDeleteId
	);
}

function lifecyclePublicationClaimJoinsAuthority(
	claim: TransientTaskPublicationTargetPublicationClaimV1,
	input: Record<string, unknown>,
): boolean {
	return (
		claim.isolationCleanupId === input.isolationCleanupId &&
		claim.isolationNamespaceSha256 === input.isolationNamespaceSha256 &&
		claim.isolationOwnerManifestSha256 === input.isolationOwnerManifestSha256 &&
		claim.isolationCreatorDescriptorSha256 === input.isolationCreatorDescriptorSha256
	);
}

function lifecycleWorktreeAttemptJoinsAuthority(
	attempt: TransientTaskCanonicalWorktreePublicationAttemptV1,
	input: Record<string, unknown>,
): boolean {
	const cleanup = input.cleanup as Extract<TransientTaskWorkspaceAuthorityV1, { state: "cleanup" }>["cleanup"];
	const canonical = input.canonical as TransientTaskManagedWorkspaceRefV1;
	const request = attempt.request;
	return (
		request.taskId === input.taskId &&
		request.runId === input.runId &&
		request.workspaceId === input.workspaceId &&
		request.createId === input.createId &&
		request.cleanupId === cleanup.plan.cleanupId &&
		request.cleanupAuthorityId === input.cleanupAuthorityId &&
		request.expectedAuthorityRevision < Number(input.revision) &&
		request.fencingGeneration === cleanup.authority.proof.fencingGeneration &&
		exactJson(request.cleanup, cleanup.authority.proof) &&
		request.expectedGeneration === canonical.checkpoint.generation &&
		request.expectedRootSha256 === canonical.checkpoint.rootSha256 &&
		exactJson(request.checkpoint, canonical.checkpoint) &&
		request.worktreePublicationId === cleanup.plan.worktreePublicationId &&
		request.effectIdentityManifestSha256 === cleanup.plan.effectIdentityManifestSha256 &&
		exactJson(request.publicationTargetKey, cleanup.plan.publicationTargetKey) &&
		lifecyclePublicationClaimJoinsAuthority(request.publicationClaim, input)
	);
}

function lifecycleWorktreeReceiptJoinsAuthority(
	receipt: TransientTaskWorktreePublicationReceiptV1,
	input: Record<string, unknown>,
): boolean {
	const cleanup = input.cleanup as Extract<TransientTaskWorkspaceAuthorityV1, { state: "cleanup" }>["cleanup"];
	const canonical = input.canonical as TransientTaskManagedWorkspaceRefV1;
	return (
		receipt.taskId === input.taskId &&
		receipt.runId === input.runId &&
		receipt.workspaceId === input.workspaceId &&
		receipt.createId === input.createId &&
		receipt.cleanupId === cleanup.plan.cleanupId &&
		receipt.cleanupAuthorityId === input.cleanupAuthorityId &&
		receipt.worktreePublicationId === cleanup.plan.worktreePublicationId &&
		receipt.effectIdentityManifestSha256 === cleanup.plan.effectIdentityManifestSha256 &&
		exactJson(receipt.publicationTargetKey, cleanup.plan.publicationTargetKey) &&
		exactJson(receipt.checkpoint, canonical.checkpoint) &&
		lifecyclePublicationClaimJoinsAuthority(receipt.publicationClaim, input)
	);
}

function lifecycleCleanupBranchJoinsPlan(
	branch: TransientTaskCleanupBranchV1,
	plan: TransientTaskCleanupPlanV1,
): boolean {
	if ((plan.outcome === "succeeded") !== (branch.reason === "task_succeeded")) return false;
	if (branch.assessment === null) return true;
	return (
		branch.assessment.proof.taskId === plan.taskId &&
		branch.assessment.proof.runId === plan.runId &&
		branch.assessment.proof.assessmentId === plan.acknowledgementAssessmentId &&
		exactJson(branch.assessment.proof.providerWorkspace, plan.expectedProvider)
	);
}

function lifecycleCleanupProgressJoinsAuthority(
	progress: TransientTaskCleanupProgressV1,
	input: Record<string, unknown>,
): boolean {
	const cleanup = input.cleanup as Extract<TransientTaskWorkspaceAuthorityV1, { state: "cleanup" }>["cleanup"];
	const plan = cleanup.plan;
	const provider = input.providerWorkspace as TransientTaskProviderWorkspaceIdentityV1;
	const canonical = input.canonical as TransientTaskManagedWorkspaceRefV1;
	const runtime = input.runtime as RuntimeAttachmentRecordV1;
	const branch = "branch" in progress ? progress.branch : null;
	if (branch !== null && !lifecycleCleanupBranchJoinsPlan(branch, plan)) return false;
	if (
		progress.state === "planned" ||
		progress.state === "admission_closed" ||
		progress.state === "assessment_outcome_unknown" ||
		progress.state === "branch_selected" ||
		progress.state === "blocked"
	)
		return true;
	if (progress.state === "runtime_draining")
		return (
			exactJson(progress.runtime, runtime.attachment) &&
			exactJson(progress.runtime.plan, branch?.kind === "preserve" ? plan.preservingDrain : plan.fastDiscardDrain)
		);
	if (progress.state === "worktree_publication_outcome_unknown")
		return lifecycleWorktreeAttemptJoinsAuthority(progress.attempt, input);
	if (progress.state === "worktree_publication_not_applied")
		return lifecycleWorktreeAttemptJoinsAuthority(progress.attempt, input);
	if (progress.state === "worktree_published") return lifecycleWorktreeReceiptJoinsAuthority(progress.receipt, input);
	const selectedDrain = branch?.kind === "preserve" ? plan.preservingDrain : plan.fastDiscardDrain;
	if (progress.state === "runtime_released")
		return (
			exactJson(progress.runtime, runtime.attachment) &&
			exactJson(progress.release.replica, provider.lease.replica) &&
			progress.release.leaseId === provider.lease.leaseId &&
			exactJson(progress.release.request, selectedDrain.requests.release) &&
			progress.worktreePublicationId === plan.worktreePublicationId &&
			progress.worktreePublicationUse === (plan.outcome === "succeeded" ? "published" : "unused_non_success") &&
			(progress.worktreePublication === null ||
				lifecycleWorktreeReceiptJoinsAuthority(progress.worktreePublication, input))
		);
	if (progress.state === "canonical_provider_terminal") return false;
	const prepared = progress.prepared;
	if (
		!exactJson(prepared.replica, provider.lease.replica) ||
		prepared.requestId !== plan.replicaDeleteRequestId ||
		prepared.authorization.taskId !== input.taskId ||
		prepared.authorization.runId !== input.runId ||
		prepared.authorization.workspaceId !== input.workspaceId ||
		prepared.authorization.cleanupId !== plan.cleanupId ||
		prepared.authorization.cleanupAuthorityId !== input.cleanupAuthorityId ||
		prepared.authorization.cleanupPlanSha256 !== cleanup.planSha256 ||
		!exactJson(prepared.authorization.finalCheckpoint, canonical.checkpoint) ||
		prepared.authorization.replicaDeleteRequestId !== plan.replicaDeleteRequestId ||
		prepared.authorization.replicaDeletionQuarantineId !== plan.replicaDeletionQuarantineId ||
		prepared.authorization.replicaDeletionPlannedAt !== plan.replicaDeletionPlannedAt ||
		prepared.authorization.replicaDeletionPurgeAfter !== plan.replicaDeletionPurgeAfter
	)
		return false;
	return true;
}

function validLifecycleAuthority(input: unknown): input is TransientTaskWorkspaceAuthorityV1 {
	if (
		!proxyFreeData(input) ||
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		!("state" in input)
	)
		return false;
	const keys =
		input.state === "preparing"
			? [
					...TRANSIENT_AUTHORITY_BASE_KEYS,
					"state",
					"controller",
					"isolationPreparation",
					"canonical",
					"providerWorkspace",
					"runtime",
					"cleanup",
				]
			: [
					...TRANSIENT_AUTHORITY_BASE_KEYS,
					"state",
					"controller",
					"canonical",
					"providerWorkspace",
					"runtime",
					"cleanup",
				];
	if (!strictRecord(input, keys) || !validLifecycleAuthorityBase(input)) return false;
	if (input.state === "preparing") {
		if (
			!validLifecycleLeaseAuthority(input.controller, "controller") ||
			!validLifecycleIsolationPreparation(input.isolationPreparation) ||
			input.canonical !== null ||
			input.providerWorkspace !== null ||
			input.runtime !== null ||
			input.cleanup !== null
		)
			return false;
		const controller = input.controller as TransientTaskControllerAuthorityV1;
		const preparation = input.isolationPreparation as ConfidentialTransientTaskIsolationPreparingAuthorityV1;
		if (!lifecycleControllerJoins(input, controller)) return false;
		if (preparation.state === "released_before_bind")
			return preparation.creatorDescriptorSha256 === input.isolationCreatorDescriptorSha256;
		const descriptor =
			preparation.state === "ready_to_bind" || preparation.state === "bound"
				? preparation.ready.creatorDescriptor
				: preparation.creatorDescriptor;
		const manifest = input.effectIdentityManifest as TransientTaskEffectIdentityManifestV1;
		return (
			descriptor.taskId === input.taskId &&
			descriptor.runId === input.runId &&
			descriptor.createId === input.createId &&
			descriptor.publicationTargetId === input.publicationTargetId &&
			descriptor.worktreePublicationId === manifest.worktreePublicationId &&
			descriptor.isolationCleanupId === input.isolationCleanupId &&
			descriptor.effectIdentityManifestSha256 === manifest.manifestSha256 &&
			descriptor.namespaceSha256 === input.isolationNamespaceSha256 &&
			descriptor.ownerManifestSha256 === input.isolationOwnerManifestSha256 &&
			descriptor.creatorDescriptorSha256 === input.isolationCreatorDescriptorSha256
		);
	}
	if (input.state === "canonical_ready" || input.state === "acquiring" || input.state === "active") {
		if (
			!validLifecycleLeaseAuthority(input.controller, "controller") ||
			!validLifecycleManagedWorkspace(input.canonical) ||
			!validLifecycleRuntimeRecord(input.runtime, input.workspaceId as WorkspaceId) ||
			input.cleanup !== null
		)
			return false;
		const controller = input.controller as TransientTaskControllerAuthorityV1;
		const canonical = input.canonical as TransientTaskManagedWorkspaceRefV1;
		const runtime = input.runtime as RuntimeAttachmentRecordV1;
		if (
			!lifecycleControllerJoins(input, controller) ||
			canonical.taskId !== input.taskId ||
			canonical.runId !== input.runId ||
			canonical.workspaceId !== input.workspaceId ||
			canonical.createId !== input.createId ||
			runtime.createId !== input.createId
		)
			return false;
		if (input.state === "canonical_ready")
			return input.providerWorkspace === null && runtime.attachment.state === "none";
		if (!validLifecycleProviderWorkspace(input.providerWorkspace)) return false;
		const provider = input.providerWorkspace as TransientTaskProviderWorkspaceIdentityV1;
		if (
			provider.taskId !== input.taskId ||
			provider.runId !== input.runId ||
			provider.workspaceId !== input.workspaceId
		)
			return false;
		return input.state === "acquiring"
			? runtime.attachment.state === "acquiring"
			: runtime.attachment.state === "active";
	}
	if (input.state !== "cleanup" && input.state !== "deleted" && input.state !== "discarded") return false;
	if (!validLifecycleProviderWorkspace(input.providerWorkspace)) return false;
	if (
		input.providerWorkspace.taskId !== input.taskId ||
		input.providerWorkspace.runId !== input.runId ||
		input.providerWorkspace.workspaceId !== input.workspaceId ||
		!strictRecord(input.cleanup, ["plan", "planSha256", "pendingOutcomeReceipt", "authority", "progress"]) ||
		!validLifecycleCleanupPlan(input.cleanup.plan) ||
		!lifecycleSha256Ref(input.cleanup.planSha256) ||
		input.cleanup.planSha256 !== lifecycleTupleRef(lifecycleCleanupPlanTuple(input.cleanup.plan)) ||
		!validLifecyclePendingReceipt(input.cleanup.pendingOutcomeReceipt) ||
		!lifecyclePlanJoinsAuthority(input.cleanup.plan, input) ||
		!lifecyclePendingJoinsAuthority(input.cleanup.pendingOutcomeReceipt, input) ||
		input.cleanup.plan.pendingOutcomeSha256 !== input.cleanup.pendingOutcomeReceipt.outcomeSha256 ||
		input.cleanup.plan.pendingOutcomeReceiptSha256 !== input.cleanup.pendingOutcomeReceipt.receiptSha256 ||
		input.cleanup.plan.outcome !== input.cleanup.pendingOutcomeReceipt.outcome ||
		input.cleanup.plan.expectedAuthorityRevision >= Number(input.revision)
	)
		return false;
	if (input.state === "cleanup") {
		if (
			input.controller !== null ||
			!validLifecycleManagedWorkspace(input.canonical) ||
			!validLifecycleRuntimeRecord(input.runtime, input.workspaceId as WorkspaceId) ||
			!validLifecycleLeaseAuthority(input.cleanup.authority, "cleanup") ||
			!validLifecycleCleanupProgress(input.cleanup.progress, input.workspaceId as WorkspaceId) ||
			input.cleanup.progress.state === "canonical_provider_terminal"
		)
			return false;
		const proof = (input.cleanup.authority as TransientTaskCleanupAuthorityV1).proof;
		return (
			proof.taskId === input.taskId &&
			proof.runId === input.runId &&
			proof.cleanupId === input.cleanup.plan.cleanupId &&
			proof.cleanupAuthorityId === input.cleanupAuthorityId &&
			proof.workspaceId === input.workspaceId &&
			lifecycleCleanupProgressJoinsAuthority(input.cleanup.progress, input) &&
			(input.canonical as TransientTaskManagedWorkspaceRefV1).taskId === input.taskId &&
			(input.canonical as TransientTaskManagedWorkspaceRefV1).runId === input.runId &&
			(input.canonical as TransientTaskManagedWorkspaceRefV1).workspaceId === input.workspaceId
		);
	}
	if (
		input.controller !== null ||
		input.canonical !== null ||
		input.runtime !== null ||
		input.cleanup.authority !== null ||
		!validLifecycleCleanupProgress(input.cleanup.progress, input.workspaceId as WorkspaceId) ||
		input.cleanup.progress.state !== "canonical_provider_terminal"
	)
		return false;
	const evidence = input.cleanup.progress.evidence;
	const plan = input.cleanup.plan;
	const provider = input.providerWorkspace;
	const selectedDrain = evidence.branch.kind === "preserve" ? plan.preservingDrain : plan.fastDiscardDrain;
	return (
		evidence.taskId === input.taskId &&
		evidence.runId === input.runId &&
		evidence.postTerminalCleanupEvidenceId === plan.terminalEvidenceId &&
		evidence.cleanupId === plan.cleanupId &&
		evidence.cleanupAuthorityId === input.cleanupAuthorityId &&
		evidence.workspaceId === input.workspaceId &&
		evidence.resultPublicationId === input.resultPublicationId &&
		evidence.publicationTargetId === input.publicationTargetId &&
		exactJson(evidence.publicationTargetKey, plan.publicationTargetKey) &&
		evidence.isolationCleanupId === input.isolationCleanupId &&
		evidence.worktreePublicationId === plan.worktreePublicationId &&
		evidence.effectIdentityManifestSha256 === plan.effectIdentityManifestSha256 &&
		evidence.isolationNamespaceSha256 === input.isolationNamespaceSha256 &&
		evidence.isolationOwnerManifestSha256 === input.isolationOwnerManifestSha256 &&
		evidence.isolationCreatorDescriptorSha256 === input.isolationCreatorDescriptorSha256 &&
		evidence.resultPublicationTargetId === input.resultPublicationTargetId &&
		evidence.pendingPayloadId === input.pendingPayloadId &&
		evidence.pendingPayloadDeleteId === input.pendingPayloadDeleteId &&
		evidence.composedPayloadId === input.composedPayloadId &&
		evidence.composedPayloadDeleteId === input.composedPayloadDeleteId &&
		evidence.pendingOutcomeSha256 === input.cleanup.pendingOutcomeReceipt.outcomeSha256 &&
		evidence.outcome === plan.outcome &&
		lifecycleCleanupBranchJoinsPlan(evidence.branch, plan) &&
		evidence.planSha256 === input.cleanup.planSha256 &&
		evidence.canonicalDiscard.canonicalDiscardId === plan.canonicalDiscardId &&
		exactJson(
			evidence.preparedReplicaDelete.authorization.finalCheckpoint,
			evidence.canonicalDiscard.finalCheckpoint,
		) &&
		exactJson(evidence.release.replica, provider.lease.replica) &&
		evidence.release.leaseId === provider.lease.leaseId &&
		exactJson(evidence.release.request, selectedDrain.requests.release) &&
		exactJson(evidence.preparedReplicaDelete.replica, provider.lease.replica) &&
		evidence.preparedReplicaDelete.requestId === plan.replicaDeleteRequestId &&
		evidence.preparedReplicaDelete.authorization.replicaDeletionQuarantineId === plan.replicaDeletionQuarantineId &&
		evidence.preparedReplicaDelete.authorization.replicaDeletionPlannedAt === plan.replicaDeletionPlannedAt &&
		evidence.preparedReplicaDelete.authorization.replicaDeletionPurgeAfter === plan.replicaDeletionPurgeAfter &&
		(evidence.worktreePublication === null ||
			(evidence.worktreePublication.worktreePublicationId === plan.worktreePublicationId &&
				evidence.worktreePublication.effectIdentityManifestSha256 === plan.effectIdentityManifestSha256 &&
				exactJson(evidence.worktreePublication.publicationTargetKey, plan.publicationTargetKey) &&
				exactJson(evidence.worktreePublication.checkpoint, evidence.canonicalDiscard.finalCheckpoint) &&
				lifecyclePublicationClaimJoinsAuthority(evidence.worktreePublication.publicationClaim, input))) &&
		(evidence.branch.kind === "fast_discard" ||
			(evidence.canonicalCommit?.commitId === plan.preservingDrain.canonicalCommitId &&
				evidence.checkpointAcknowledgement?.reference.checkpointId === plan.preservingDrain.checkpointId)) &&
		evidence.tombstone.terminalState === input.state &&
		(input.state === "discarded") === (evidence.branch.kind === "fast_discard")
	);
}

function lifecycleImmutableAuthorityTuple(authority: TransientTaskWorkspaceAuthorityV1): readonly unknown[] {
	return [
		authority.schemaVersion,
		authority.taskId,
		authority.runId,
		authority.createId,
		authority.cleanupAuthorityId,
		authority.resultPublicationId,
		authority.capturePreparationId,
		authority.captureId,
		authority.semanticMergeId,
		authority.semanticMergeFinishId,
		authority.isolationCleanupId,
		authority.resultCompositionId,
		authority.effectIdentityManifest,
		authority.postTerminalIntentSha256,
		authority.isolationNamespaceSha256,
		authority.isolationOwnerManifestSha256,
		authority.isolationCreatorDescriptorSha256,
		authority.publicationTargetId,
		authority.resultPublicationTargetId,
		authority.resultPublicationTargetCleanupId,
		authority.pendingPayloadId,
		authority.pendingPayloadDeleteId,
		authority.composedPayloadId,
		authority.composedPayloadDeleteId,
		authority.resultlessIdentity,
		authority.resultlessMaximumUtf8ByteLength,
		authority.resultlessRepresentabilityPreflightSha256,
		authority.resultPublicationPrePendingPlanSha256,
		authority.workspaceId,
		authority.controlHostId,
		authority.createdAt,
	];
}

function sameLifecycleImmutableAuthority(
	left: TransientTaskWorkspaceAuthorityV1,
	right: TransientTaskWorkspaceAuthorityV1,
): boolean {
	return exactJson(lifecycleImmutableAuthorityTuple(left), lifecycleImmutableAuthorityTuple(right));
}

function lifecycleControlledTransitionAllowed(
	current: TransientTaskWorkspaceAuthorityV1,
	next: TransientTaskWorkspaceAuthorityV1,
): boolean {
	if (
		current.state === "cleanup" ||
		current.state === "deleted" ||
		current.state === "discarded" ||
		next.state === "cleanup" ||
		next.state === "deleted" ||
		next.state === "discarded"
	)
		return false;
	if (current.state === "preparing") return next.state === "preparing" || next.state === "canonical_ready";
	if (current.state === "canonical_ready") return next.state === "canonical_ready" || next.state === "acquiring";
	if (current.state === "acquiring")
		return next.state === "acquiring" || next.state === "canonical_ready" || next.state === "active";
	return next.state === "active";
}

function lifecycleCleanupTransitionAllowed(
	current: TransientTaskCleanupProgressV1,
	next: TransientTaskCleanupProgressV1,
): boolean {
	if (current.state === next.state) return true;
	if (next.state === "blocked") return true;
	if (current.state === "planned") return next.state === "admission_closed";
	if (current.state === "admission_closed")
		return next.state === "assessment_outcome_unknown" || next.state === "branch_selected";
	if (current.state === "assessment_outcome_unknown") return next.state === "branch_selected";
	if (current.state === "branch_selected") return next.state === "runtime_draining";
	if (current.state === "runtime_draining")
		return current.branch.reason === "task_succeeded"
			? next.state === "worktree_publication_outcome_unknown"
			: next.state === "runtime_released";
	if (current.state === "worktree_publication_outcome_unknown")
		return next.state === "worktree_publication_not_applied" || next.state === "worktree_published";
	if (current.state === "worktree_publication_not_applied")
		return next.state === "worktree_publication_outcome_unknown" || next.state === "worktree_published";
	if (current.state === "worktree_published") return next.state === "runtime_released";
	if (current.state === "runtime_released") return next.state === "replica_delete_prepared";
	if (current.state === "replica_delete_prepared") return next.state === "replica_delete_outcome_unknown";
	if (current.state === "replica_delete_outcome_unknown") return next.state === "replica_deleted";
	if (current.state === "replica_deleted") return next.state === "canonical_discard_outcome_unknown";
	return false;
}

function transientRuntimeState(key: TransientTaskWorkspaceKeyV1, input: unknown | null): TransientTaskRuntimeStateV1 {
	if (input === null) return emptyTransientState(key);
	if (
		!strictRecord(input, [
			"schemaVersion",
			"key",
			"authority",
			"bindings",
			"payloads",
			"resultTargets",
			"publications",
			"parentDeliveries",
		]) ||
		input.schemaVersion !== 1 ||
		!strictRecord(input.key, ["taskId", "runId"]) ||
		input.key.taskId !== key.taskId ||
		input.key.runId !== key.runId ||
		(input.authority !== null && !validLifecycleAuthority(input.authority)) ||
		!strictMap(input.bindings) ||
		!strictMap(input.payloads) ||
		!strictMap(input.resultTargets) ||
		!strictMap(input.publications) ||
		!strictMap(input.parentDeliveries)
	) {
		throw new Error("Transient task runtime state is invalid");
	}
	return input as unknown as TransientTaskRuntimeStateV1;
}

function transientKey(key: TransientTaskWorkspaceKeyV1): string {
	return `${key.taskId}\u0000${key.runId}`;
}

function controllerProofMatches(
	left: TransientTaskControllerAuthorityProofV1,
	right: TransientTaskControllerAuthorityProofV1,
): boolean {
	return exactJson(left, right);
}

function cleanupProofMatches(
	left: TransientTaskCleanupAuthorityProofV1,
	right: TransientTaskCleanupAuthorityProofV1,
): boolean {
	return exactJson(left, right);
}

export interface RuntimeTransientAuthorityV1 {
	authorizeController(
		proof: TransientTaskControllerAuthorityProofV1,
	): Promise<"current" | "controller_lost" | "cleanup_latched">;
	authorizeCleanup(proof: TransientTaskCleanupAuthorityProofV1): Promise<boolean>;
	authorizeTerminal(request: {
		readonly key: TransientTaskWorkspaceKeyV1;
		readonly terminalEvidenceId: OperationId;
		readonly terminalEvidenceSha256: Sha256Ref;
	}): Promise<boolean>;
	inspectRevision(key: TransientTaskWorkspaceKeyV1): Promise<number | null>;
}

function lifecycleIsolationEnsureTuple(
	request: Omit<ConfidentialTransientTaskEnsureIsolationRequestV1, "requestSha256">,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-isolation-creator-v1",
		"ensure",
		1,
		lifecycleIsolationDescriptorTuple(request.preparation.creatorDescriptor),
		request.preparation.orderedClaimAttempts.map(lifecycleIsolationClaimAttemptTuple),
		request.preparation.orderedClaimReceipts.map(lifecycleIsolationClaimReceiptTuple),
		lifecycleIsolationClaimTuple(request.preparation.ownershipClaim),
		lifecycleIsolationClaimReceiptTuple(request.preparation.ownershipClaimReceipt),
		controllerProofTuple(request.controller),
		request.authoritySha256,
		request.requestedAt,
	];
}

function isolationClaimInspectionSha256(
	request: TransientTaskIsolationOwnershipClaimEffectInspectRequestV1,
	fields: readonly CanonicalRuntimeValue[],
): Sha256Ref {
	return lifecycleTupleRef([
		"omp-transient-task-isolation-claim-effect-v1",
		"inspection",
		1,
		request.taskId,
		request.runId,
		request.createId,
		request.operation,
		request.effectOperationId,
		request.creatorDescriptorSha256,
		request.requestSha256,
		request.attemptSha256,
		...fields,
	]);
}

function validIsolationClaimInspectRequest(
	request: unknown,
): request is TransientTaskIsolationOwnershipClaimEffectInspectRequestV1 {
	return Boolean(
		proxyFreeData(request) &&
			strictRecord(request, [
				"schemaVersion",
				"taskId",
				"runId",
				"createId",
				"operation",
				"effectOperationId",
				"creatorDescriptorSha256",
				"requestSha256",
				"attemptSha256",
			]) &&
			request.schemaVersion === 1 &&
			isOneOf(request.operation, ["exclusive_create", "stale_same_owner_cas_adopt", "pre_bind_cas_release"]) &&
			[request.taskId, request.runId, request.createId, request.effectOperationId].every(lifecycleIdentity) &&
			[request.creatorDescriptorSha256, request.requestSha256, request.attemptSha256].every(lifecycleSha256Ref),
	);
}

function invalidIsolationClaimInspection(): TransientTaskIsolationOwnershipClaimEffectInspectResultV1 {
	return {
		status: "invalid",
		inspectionSha256: lifecycleTupleRef([
			"omp-transient-task-isolation-claim-effect-v1",
			"inspection",
			1,
			"invalid_request",
		]),
	};
}

function publicIsolationClaimInspection(
	request: TransientTaskIsolationOwnershipClaimEffectInspectRequestV1,
	inspection: PackageInternalNativeTransientTaskIsolationOwnershipClaimInspectionV1,
): TransientTaskIsolationOwnershipClaimEffectInspectResultV1 {
	if (inspection.status === "matching") {
		const observedClaimSha256 =
			inspection.receipt.operation === "pre_bind_cas_release" ? null : inspection.receipt.currentClaimSha256;
		return {
			status: "matching",
			observedClaimSha256,
			inspectionSha256: isolationClaimInspectionSha256(request, ["matching", observedClaimSha256]),
		};
	}
	if (inspection.status === "not_applied") {
		return {
			status: "not_applied",
			proofSha256: inspection.proof.proofSha256,
			inspectionSha256: isolationClaimInspectionSha256(request, ["not_applied", inspection.proof.proofSha256]),
		};
	}
	if (
		inspection.status === "stale_same_owner" ||
		inspection.status === "same_owner_live" ||
		inspection.status === "same_owner_liveness_indeterminate"
	) {
		return {
			status: inspection.status,
			observedClaimSha256: inspection.observedClaim.claimSha256,
			ownerManifestSha256: inspection.observedClaim.ownerManifestSha256,
			ownerLivenessEvidenceSha256: inspection.ownerLivenessEvidence.evidenceSha256,
			inspectionSha256: isolationClaimInspectionSha256(request, [
				inspection.status,
				inspection.observedClaim.claimSha256,
				inspection.observedClaim.ownerManifestSha256,
				inspection.ownerLivenessEvidence.evidenceSha256,
			]),
		};
	}
	if (inspection.status === "live_different_owner") {
		return {
			status: inspection.status,
			observedClaimSha256: inspection.observedClaim.claimSha256,
			inspectionSha256: isolationClaimInspectionSha256(request, [
				inspection.status,
				inspection.observedClaim.claimSha256,
			]),
		};
	}
	return {
		status: inspection.status,
		inspectionSha256: isolationClaimInspectionSha256(request, [inspection.status]),
	};
}

/** Same-CAS-domain owner of every native sibling-claim attempt and receipt. */

const ORDINARY_TRANSIENT_TASK_ENVIRONMENT_RELEASE_NAMESPACE_V1 =
	"ordinary-transient-task-execution-environment-release-v1";

interface PrivateOrdinaryTransientTaskEnvironmentReleaseAuthorityV1 {
	readonly providerId: string;
	readonly lease: RuntimeLeaseRef;
	readonly fence: RuntimeFence;
	readonly request: RuntimeLeaseReleaseInspectRequest;
	readonly authoritySha256: Sha256Ref;
}

interface PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1 extends TransientTaskWorkspaceKeyV1 {
	readonly schemaVersion: 1;
	readonly createId: OperationId;
	readonly authority: PrivateOrdinaryTransientTaskEnvironmentReleaseAuthorityV1;
	readonly state: "release_not_applied" | "release_outcome_unknown" | "released";
	readonly receipt: RuntimeLeaseReleaseResult | null;
	readonly openedAt: ISO8601;
	readonly updatedAt: ISO8601;
	readonly rowSha256: Sha256Ref;
}

interface PrivateOrdinaryTransientTaskEnvironmentReleaseIndexV1 {
	readonly schemaVersion: 1;
	readonly ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1;
	readonly entries: readonly PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1[];
	readonly indexSha256: Sha256Ref;
}

export type OrdinaryTransientTaskExecutionEnvironmentReleaseStartupResultV1 =
	| { readonly status: "ready" }
	| { readonly status: "invalid" }
	| {
			readonly status: "blocked";
			readonly entries: readonly {
				readonly taskId: string;
				readonly runId: string;
				readonly createId: OperationId;
				readonly providerId: string;
				readonly reason: "provider_unavailable" | "release_outcome_unknown";
			}[];
	  };

function executionEnvironmentReleaseReplicaTuple(replica: RuntimeReplicaRef): readonly CanonicalRuntimeValue[] {
	return [replica.providerId, replica.profileId, replica.replicaId, replica.workspaceId];
}

function executionEnvironmentReleaseLeaseTuple(lease: RuntimeLeaseRef): readonly CanonicalRuntimeValue[] {
	return [
		lease.leaseId,
		executionEnvironmentReleaseReplicaTuple(lease.replica),
		lease.fenceId,
		lease.baseGeneration,
		lease.renewalSequence,
		lease.acquiredAt,
		lease.renewBy,
		lease.expiresAt,
	];
}

function executionEnvironmentReleaseRequestTuple(
	request: RuntimeLeaseReleaseInspectRequest,
): readonly CanonicalRuntimeValue[] {
	return [
		request.requestId,
		request.requestSha256,
		request.parentOperationId,
		executionEnvironmentReleaseReplicaTuple(request.replica),
		request.leaseId,
	];
}

function executionEnvironmentReleaseRequestSha256(request: RuntimeLeaseReleaseInspectRequest): Sha256Hex {
	return lifecycleTupleRef([
		"omp-runtime-provider-v1",
		"release",
		request.parentOperationId,
		request.replica.providerId,
		request.replica.profileId,
		request.replica.workspaceId,
		request.replica.replicaId,
		request.leaseId,
	]).slice("sha256:".length) as Sha256Hex;
}

function executionEnvironmentReleaseResultTuple(result: RuntimeLeaseReleaseResult): readonly CanonicalRuntimeValue[] {
	return [
		result.status,
		[result.request.requestId, result.request.requestSha256, result.request.parentOperationId],
		executionEnvironmentReleaseReplicaTuple(result.replica),
		result.leaseId,
		result.compute,
	];
}

function executionEnvironmentReleaseAuthoritySha256(
	authority: Omit<PrivateOrdinaryTransientTaskEnvironmentReleaseAuthorityV1, "authoritySha256">,
): Sha256Ref {
	return lifecycleTupleRef([
		"omp-ordinary-transient-task-execution-environment-release-authority-v1",
		1,
		authority.providerId,
		executionEnvironmentReleaseLeaseTuple(authority.lease),
		[authority.fence.fenceId, authority.fence.token],
		executionEnvironmentReleaseRequestTuple(authority.request),
	]);
}

function ordinaryTransientTaskEnvironmentReleaseRowSha256(
	row: Omit<PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1, "rowSha256">,
): Sha256Ref {
	return lifecycleTupleRef([
		"omp-ordinary-transient-task-execution-environment-release-row-v1",
		1,
		row.taskId,
		row.runId,
		row.createId,
		row.authority.authoritySha256,
		row.state,
		row.receipt === null ? null : executionEnvironmentReleaseResultTuple(row.receipt),
		row.openedAt,
		row.updatedAt,
	]);
}

function ordinaryTransientTaskEnvironmentReleaseIndexSha256(
	ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1,
	entries: readonly PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1[],
): Sha256Ref {
	return lifecycleTupleRef([
		"omp-ordinary-transient-task-execution-environment-release-index-v1",
		1,
		ownerSessionIndex.indexSha256,
		entries.map(entry => entry.rowSha256),
	]);
}

function validExecutionEnvironmentReleaseReplica(input: unknown): input is RuntimeReplicaRef {
	return Boolean(
		strictRecord(input, ["providerId", "profileId", "replicaId", "workspaceId"]) &&
			[input.providerId, input.profileId, input.replicaId, input.workspaceId].every(lifecycleIdentity),
	);
}

function validExecutionEnvironmentReleaseLease(input: unknown): input is RuntimeLeaseRef {
	if (
		!strictRecord(input, [
			"leaseId",
			"replica",
			"fenceId",
			"baseGeneration",
			"renewalSequence",
			"acquiredAt",
			"renewBy",
			"expiresAt",
		]) ||
		!lifecycleIdentity(input.leaseId) ||
		!validExecutionEnvironmentReleaseReplica(input.replica) ||
		!lifecycleIdentity(input.fenceId) ||
		!lifecycleSafeInteger(input.baseGeneration) ||
		!lifecycleSafeInteger(input.renewalSequence) ||
		!lifecycleIso8601(input.acquiredAt) ||
		!lifecycleIso8601(input.renewBy) ||
		!lifecycleIso8601(input.expiresAt)
	)
		return false;
	return (
		Date.parse(input.acquiredAt) <= Date.parse(input.renewBy) &&
		Date.parse(input.renewBy) <= Date.parse(input.expiresAt)
	);
}

function validExecutionEnvironmentReleaseRequest(input: unknown): input is RuntimeLeaseReleaseInspectRequest {
	if (
		!strictRecord(input, ["requestId", "requestSha256", "parentOperationId", "replica", "leaseId"]) ||
		!lifecycleSha256Hex(input.requestId) ||
		!lifecycleSha256Hex(input.requestSha256) ||
		!lifecycleIdentity(input.parentOperationId) ||
		!validExecutionEnvironmentReleaseReplica(input.replica) ||
		!lifecycleIdentity(input.leaseId)
	)
		return false;
	const request: RuntimeLeaseReleaseInspectRequest = {
		requestId: input.requestId,
		requestSha256: input.requestSha256,
		parentOperationId: input.parentOperationId,
		replica: input.replica,
		leaseId: input.leaseId,
	};
	return request.requestSha256 === executionEnvironmentReleaseRequestSha256(request);
}

function validExecutionEnvironmentReleaseResult(
	input: unknown,
	authority: PrivateOrdinaryTransientTaskEnvironmentReleaseAuthorityV1,
): input is RuntimeLeaseReleaseResult {
	if (
		!strictRecord(input, ["status", "request", "replica", "leaseId", "compute"]) ||
		!isOneOf(input.status, ["released", "already_released", "expired", "absent"]) ||
		!strictRecord(input.request, ["requestId", "requestSha256", "parentOperationId"]) ||
		!lifecycleSha256Hex(input.request.requestId) ||
		!lifecycleSha256Hex(input.request.requestSha256) ||
		!lifecycleIdentity(input.request.parentOperationId) ||
		!validExecutionEnvironmentReleaseReplica(input.replica) ||
		!lifecycleIdentity(input.leaseId) ||
		!isOneOf(input.compute, ["stopped", "not_applicable"])
	)
		return false;
	return (
		input.request.requestId === authority.request.requestId &&
		input.request.requestSha256 === authority.request.requestSha256 &&
		input.request.parentOperationId === authority.request.parentOperationId &&
		exactJson(input.replica, authority.lease.replica) &&
		input.leaseId === authority.lease.leaseId
	);
}

function decodeOrdinaryTransientTaskEnvironmentReleaseAuthority(
	input: unknown,
): PrivateOrdinaryTransientTaskEnvironmentReleaseAuthorityV1 {
	if (
		!strictRecord(input, ["providerId", "lease", "fence", "request", "authoritySha256"]) ||
		!lifecycleIdentity(input.providerId) ||
		!validExecutionEnvironmentReleaseLease(input.lease) ||
		!strictRecord(input.fence, ["fenceId", "token"]) ||
		!lifecycleIdentity(input.fence.fenceId) ||
		!lifecycleIdentity(input.fence.token) ||
		!validExecutionEnvironmentReleaseRequest(input.request) ||
		!lifecycleSha256Ref(input.authoritySha256)
	)
		throw new TypeError("Transient task execution-environment release authority is invalid");
	const authority = input as unknown as PrivateOrdinaryTransientTaskEnvironmentReleaseAuthorityV1;
	if (
		authority.providerId !== authority.lease.replica.providerId ||
		authority.fence.fenceId !== authority.lease.fenceId ||
		authority.request.leaseId !== authority.lease.leaseId ||
		!exactJson(authority.request.replica, authority.lease.replica) ||
		authority.authoritySha256 !== executionEnvironmentReleaseAuthoritySha256(authority)
	)
		throw new TypeError("Transient task execution-environment release authority join is invalid");
	return authority;
}

function decodeOrdinaryTransientTaskEnvironmentReleaseRow(
	input: unknown,
): PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"authority",
			"state",
			"receipt",
			"openedAt",
			"updatedAt",
			"rowSha256",
		]) ||
		input.schemaVersion !== 1 ||
		![input.taskId, input.runId, input.createId].every(lifecycleIdentity) ||
		!isOneOf(input.state, ["release_not_applied", "release_outcome_unknown", "released"]) ||
		!lifecycleIso8601(input.openedAt) ||
		!lifecycleIso8601(input.updatedAt) ||
		Date.parse(input.updatedAt) < Date.parse(input.openedAt) ||
		!lifecycleSha256Ref(input.rowSha256)
	)
		throw new TypeError("Transient task execution-environment release row is invalid");
	const authority = decodeOrdinaryTransientTaskEnvironmentReleaseAuthority(input.authority);
	if ((input.state === "released") !== (input.receipt !== null))
		throw new TypeError("Transient task execution-environment release receipt state is invalid");
	if (input.receipt !== null && !validExecutionEnvironmentReleaseResult(input.receipt, authority))
		throw new TypeError("Transient task execution-environment release receipt is invalid");
	const row = input as unknown as PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1;
	const { rowSha256: _rowSha256, ...core } = row;
	if (row.rowSha256 !== ordinaryTransientTaskEnvironmentReleaseRowSha256(core))
		throw new TypeError("Transient task execution-environment release row digest is invalid");
	return row;
}

function decodeOrdinaryTransientTaskEnvironmentReleaseIndex(
	input: unknown | null,
	ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1,
): PrivateOrdinaryTransientTaskEnvironmentReleaseIndexV1 {
	if (input === null) {
		const entries: readonly PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1[] = [];
		return {
			schemaVersion: 1,
			ownerSessionIndex,
			entries,
			indexSha256: ordinaryTransientTaskEnvironmentReleaseIndexSha256(ownerSessionIndex, entries),
		};
	}
	if (
		!strictRecord(input, ["schemaVersion", "ownerSessionIndex", "entries", "indexSha256"]) ||
		input.schemaVersion !== 1 ||
		!exactJson(input.ownerSessionIndex, ownerSessionIndex) ||
		!strictArray(input.entries) ||
		!lifecycleSha256Ref(input.indexSha256)
	)
		throw new TypeError("Transient task execution-environment release index is invalid");
	const entries = input.entries.map(decodeOrdinaryTransientTaskEnvironmentReleaseRow);
	const identities = new Set(entries.map(entry => `${entry.taskId}\u0000${entry.runId}\u0000${entry.createId}`));
	if (
		identities.size !== entries.length ||
		input.indexSha256 !== ordinaryTransientTaskEnvironmentReleaseIndexSha256(ownerSessionIndex, entries)
	)
		throw new TypeError("Transient task execution-environment release index digest is invalid");
	return input as unknown as PrivateOrdinaryTransientTaskEnvironmentReleaseIndexV1;
}

function ordinaryTransientTaskEnvironmentReleaseIndexWithEntries(
	index: PrivateOrdinaryTransientTaskEnvironmentReleaseIndexV1,
	entries: readonly PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1[],
): PrivateOrdinaryTransientTaskEnvironmentReleaseIndexV1 {
	return {
		...index,
		entries,
		indexSha256: ordinaryTransientTaskEnvironmentReleaseIndexSha256(index.ownerSessionIndex, entries),
	};
}

/** Durable owner of every environment-release dispatch and restart replay for one owner session. */

function sha256Ref(hex: Sha256Hex): Sha256Ref {
	return `sha256:${hex}`;
}

async function tupleRef(tuple: readonly CanonicalRuntimeValue[]): Promise<Sha256Ref> {
	return sha256Ref(await canonicalRuntimeSha256(tuple));
}

function controllerProofTuple(proof: TransientTaskControllerAuthorityProofV1): readonly CanonicalRuntimeValue[] {
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

function cleanupProofTuple(proof: TransientTaskCleanupAuthorityProofV1): readonly CanonicalRuntimeValue[] {
	return [
		1,
		proof.taskId,
		proof.runId,
		proof.cleanupId,
		proof.cleanupAuthorityId,
		proof.workspaceId,
		proof.controlHostId,
		proof.cleanupEpoch,
		proof.fencingGeneration,
	];
}

type PublicationBindRequestV1 = Parameters<TransientTaskPublicationTargetBindingStoreV1["bind"]>[0];
type PublicationRenewRequestV1 = Parameters<TransientTaskPublicationTargetBindingStoreV1["renew"]>[0];
type PublicationOpenRequestV1 = Parameters<TransientTaskPublicationTargetBindingStoreV1["open"]>[0];
type PublicationSettleRequestV1 = Parameters<TransientTaskPublicationTargetBindingStoreV1["settlePublicationClaim"]>[0];
type PublicationBindInspectStatusV1 =
	| "absent"
	| "outcome_unknown"
	| "not_applied"
	| "matching"
	| "conflict"
	| "invalid";
type PublicationReleaseInspectStatusV1 =
	| "absent"
	| "outcome_unknown"
	| "not_applied"
	| "matching"
	| "target_missing"
	| "conflict"
	| "invalid";
type PrivatePublicationTargetBindingStateV1 = TransientTaskPublicationTargetBindingV1["progress"]["state"];
type PrivatePublicationTargetBindingV1<State extends PrivatePublicationTargetBindingStateV1> = Pick<
	TransientTaskPublicationTargetBindingV1,
	"schemaVersion" | "key" | "isolationCleanupId" | "updatedAt"
> & {
	readonly bindingRevision: State extends "bind_outcome_unknown" | "bind_not_applied" ? 0 : number;
	readonly renewalSequence: State extends "bind_outcome_unknown" | "bind_not_applied" ? 0 : number;
	readonly progress: Extract<TransientTaskPublicationTargetBindingV1["progress"], { state: State }>;
};
type PrivatePublicationTargetConfidentialBindingV1 =
	| {
			readonly state: "bind_outcome_unknown" | "bind_not_applied";
			readonly binding: PrivatePublicationTargetBindingV1<"bind_outcome_unknown" | "bind_not_applied">;
			readonly bindAttempt: ConfidentialTransientTaskPublicationTargetBindAttemptV1;
	  }
	| {
			readonly state: "live";
			readonly binding: PrivatePublicationTargetBindingV1<"live">;
			readonly creatorPreparation: ConfidentialTransientTaskIsolationReadyToBindReceiptV1;
			readonly bindAttempt: ConfidentialTransientTaskPublicationTargetBindAttemptV1;
			readonly completedRenewals: readonly {
				readonly attempt: ConfidentialTransientTaskPublicationTargetRenewalAttemptV1;
				readonly receipt: TransientTaskPublicationTargetRenewalReceiptV1;
			}[];
			readonly activeAttempt: ConfidentialTransientTaskPublicationTargetActiveAttemptV1 | null;
	  }
	| {
			readonly state: "cleanup_due";
			readonly binding: PrivatePublicationTargetBindingV1<"cleanup_due">;
			readonly creatorPreparation: ConfidentialTransientTaskIsolationReadyToBindReceiptV1;
			readonly bindAttempt: ConfidentialTransientTaskPublicationTargetBindAttemptV1;
			readonly completedRenewals: readonly {
				readonly attempt: ConfidentialTransientTaskPublicationTargetRenewalAttemptV1;
				readonly receipt: TransientTaskPublicationTargetRenewalReceiptV1;
			}[];
			readonly activeAttempt: Extract<
				ConfidentialTransientTaskPublicationTargetActiveAttemptV1,
				{ operation: "release" }
			> | null;
	  }
	| {
			readonly state: "terminal";
			readonly binding: PrivatePublicationTargetBindingV1<"terminal">;
			readonly evidence: TransientTaskPublicationTargetBindingEvidenceV1;
	  };

interface PrivatePublicationTargetBindingRowV1 {
	readonly schemaVersion: 1;
	readonly confidential: PrivatePublicationTargetConfidentialBindingV1;
	readonly bindInspectStatuses: readonly PublicationBindInspectStatusV1[];
	readonly renewalInspectStatuses: readonly PublicationBindInspectStatusV1[];
	readonly releaseInspectStatuses: readonly PublicationReleaseInspectStatusV1[];
	readonly expiryInspectStatuses: readonly PublicationReleaseInspectStatusV1[];
	readonly adoptedAttemptSha256s: readonly Sha256Ref[];
	readonly publicationSettlement: {
		readonly publicationClaimSha256: Sha256Ref;
		readonly publicationReceiptSha256: Sha256Ref;
		readonly requestSha256: Sha256Hex;
	} | null;
	readonly completedExpiryAttempt: ConfidentialTransientTaskPublicationTargetExpiryAttemptV1 | null;
	readonly terminalReleaseAttempt: ConfidentialTransientTaskPublicationTargetReleaseAttemptV1 | null;
}

const PUBLICATION_BIND_INSPECT_STATUSES: Record<PublicationBindInspectStatusV1, true> = {
	absent: true,
	outcome_unknown: true,
	not_applied: true,
	matching: true,
	conflict: true,
	invalid: true,
};
const PUBLICATION_RELEASE_INSPECT_STATUSES: Record<PublicationReleaseInspectStatusV1, true> = {
	...PUBLICATION_BIND_INSPECT_STATUSES,
	target_missing: true,
};

function publicationTargetKeyTuple(key: TransientTaskPublicationTargetKeyV1): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"key",
		1,
		key.taskId,
		key.runId,
		key.createId,
		key.publicationTargetId,
	];
}

function publicationTargetKeyMatches(
	left: TransientTaskPublicationTargetKeyV1,
	right: TransientTaskPublicationTargetKeyV1,
): boolean {
	return exactJson(left, right);
}

function publicationAuthorityTuple(
	authority: TransientTaskPublicationTargetAuthorityV1,
): readonly CanonicalRuntimeValue[] {
	if (authority.kind === "controller") return ["controller", controllerProofTuple(authority.proof)];
	if (authority.kind === "cleanup") return ["cleanup", cleanupProofTuple(authority.proof)];
	return ["terminal", authority.evidenceId, authority.evidenceSha256];
}

function validPublicationTargetKey(input: unknown): input is TransientTaskPublicationTargetKeyV1 {
	return (
		strictRecord(input, ["schemaVersion", "taskId", "runId", "createId", "publicationTargetId"]) &&
		validateTransientTaskPublicationTargetKeyV1(input)
	);
}

function validPublicationAuthority(input: unknown): input is TransientTaskPublicationTargetAuthorityV1 {
	if (
		!proxyFreeData(input) ||
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		!("kind" in input)
	)
		return false;
	if (input.kind === "controller")
		return strictRecord(input, ["kind", "proof"]) && validLifecycleControllerProof(input.proof);
	if (input.kind === "cleanup")
		return strictRecord(input, ["kind", "proof"]) && validLifecycleCleanupProof(input.proof);
	return Boolean(
		input.kind === "terminal" &&
			strictRecord(input, ["kind", "evidenceId", "evidenceSha256"]) &&
			lifecycleIdentity(input.evidenceId) &&
			lifecycleSha256Ref(input.evidenceSha256),
	);
}

function publicationBindRequestTuple(request: PublicationBindRequestV1): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"bind_request",
		1,
		publicationTargetKeyTuple(request.key),
		request.isolationCleanupId,
		request.bindingOperationId,
		request.creatorPreparation.receiptSha256,
		request.ttlMs,
		publicationAuthorityTuple(request.authority),
		request.authoritySha256,
	];
}

function publicationRenewRequestTuple(request: PublicationRenewRequestV1): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"renew_request",
		1,
		publicationTargetKeyTuple(request.key),
		request.isolationCleanupId,
		request.bindingOperationId,
		request.expectedBindingRevision,
		request.expectedRenewalSequence,
		request.previousReceiptSha256,
		request.expectedExpiresAt,
		request.ttlMs,
		publicationAuthorityTuple(request.authority),
		request.authoritySha256,
	];
}

function publicationOpenRequestTuple(request: PublicationOpenRequestV1): readonly CanonicalRuntimeValue[] {
	const prefix: CanonicalRuntimeValue[] = [
		"omp-transient-task-publication-target-v1",
		"open_request",
		1,
		request.purpose,
		request.access,
		publicationTargetKeyTuple(request.key),
		request.isolationCleanupId,
	];
	if (request.purpose === "worktree_publication") prefix.push(request.worktreePublicationId, request.openOperationId);
	else prefix.push(request.openOperationId, request.cleanupClaimOperationId);
	return [
		...prefix,
		request.expectedBindingRevision,
		request.expectedRenewalSequence,
		request.expectedReceiptSha256,
		publicationAuthorityTuple(request.authority),
		request.authoritySha256,
	];
}

function publicationSettlementRequestTuple(request: PublicationSettleRequestV1): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"publication_claim_settle_request",
		1,
		publicationTargetKeyTuple(request.key),
		request.isolationCleanupId,
		request.worktreePublicationId,
		request.publicationClaimSha256,
		request.publicationReceiptSha256,
		publicationAuthorityTuple(request.authority),
		request.authoritySha256,
	];
}

function publicationCleanupClaimTuple(
	claim: TransientTaskPublicationTargetCleanupClaimV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"cleanup_claim",
		1,
		publicationTargetKeyTuple(claim.key),
		claim.isolationCleanupId,
		claim.openOperationId,
		claim.cleanupClaimOperationId,
		claim.access,
		claim.bindingRevision,
		claim.renewalSequence,
		claim.bindingReceiptSha256,
		claim.bindingAuthoritySha256,
		claim.bindingOpenRequestSha256,
		claim.cleanupDescriptorSha256,
		claim.isolationNamespaceSha256,
		claim.isolationOwnerManifestSha256,
		claim.isolationCreatorDescriptorSha256,
		claim.claimedAt,
	];
}

function publicationClaimTuple(
	claim: TransientTaskPublicationTargetPublicationClaimV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"publication_claim",
		1,
		publicationTargetKeyTuple(claim.key),
		claim.isolationCleanupId,
		claim.worktreePublicationId,
		claim.openOperationId,
		"live",
		claim.bindingRevision,
		claim.renewalSequence,
		claim.bindingReceiptSha256,
		claim.bindingAuthoritySha256,
		claim.bindingOpenRequestSha256,
		claim.isolationNamespaceSha256,
		claim.isolationOwnerManifestSha256,
		claim.isolationCreatorDescriptorSha256,
		claim.claimedAt,
	];
}

function publicationBindReceiptTuple(
	receipt: TransientTaskPublicationTargetBindReceiptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"bind_receipt",
		publicationTargetKeyTuple(receipt.key),
		receipt.isolationCleanupId,
		receipt.bindingOperationId,
		receipt.bindingRevision,
		receipt.renewalSequence,
		receipt.cleanupDescriptorSha256,
		receipt.isolationCreatorPreparationReceiptSha256,
		receipt.isolationOwnershipClaimReceiptSha256,
		receipt.isolationCreatorDescriptorSha256,
		receipt.isolationNamespaceSha256,
		receipt.isolationOwnerManifestSha256,
		receipt.bindRequestSha256,
		receipt.authoritySha256,
		receipt.boundAt,
		receipt.renewBy,
		receipt.expiresAt,
	];
}

function publicationRenewalReceiptTuple(
	receipt: TransientTaskPublicationTargetRenewalReceiptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"renew_receipt",
		publicationTargetKeyTuple(receipt.key),
		receipt.isolationCleanupId,
		receipt.bindingOperationId,
		receipt.bindingRevision,
		receipt.renewalSequence,
		receipt.previousReceiptSha256,
		receipt.renewRequestSha256,
		receipt.authoritySha256,
		receipt.renewedAt,
		receipt.renewBy,
		receipt.expiresAt,
	];
}

function publicationCleanupDueReceiptTuple(
	receipt: TransientTaskPublicationTargetCleanupDueReceiptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"cleanup_due_receipt",
		publicationTargetKeyTuple(receipt.key),
		receipt.isolationCleanupId,
		receipt.bindingOperationId,
		receipt.bindingRevision,
		receipt.renewalSequence,
		receipt.previousReceiptSha256,
		receipt.expiresAt,
		receipt.expiryRequestSha256,
		receipt.expiryPlanSha256,
		receipt.authoritySha256,
		receipt.cleanupDueAt,
	];
}

function publicationReleaseReceiptTuple(
	receipt: TransientTaskPublicationTargetReleaseReceiptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"release_receipt",
		publicationTargetKeyTuple(receipt.key),
		receipt.isolationCleanupId,
		receipt.bindingOperationId,
		receipt.state,
		receipt.bindingAccess,
		receipt.bindingRevision,
		receipt.renewalSequence,
		receipt.reason,
		receipt.previousReceiptSha256,
		receipt.bindingAuthoritySha256,
		receipt.bindingOpenRequestSha256,
		receipt.cleanupDescriptorSha256,
		receipt.cleanupClaimSha256,
		receipt.isolationCleanupReceiptSha256,
		receipt.releaseRequestSha256,
		receipt.releasePlanSha256,
		receipt.authoritySha256,
		receipt.terminalAt,
	];
}

function isolationCleanupTerminalTuple(
	evidence: TransientTaskIsolationCleanupTerminalEvidenceV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-post-terminal-v1",
		"isolation_cleanup_terminal_evidence",
		1,
		evidence.taskId,
		evidence.runId,
		evidence.isolationCleanupId,
		evidence.planSha256,
		evidence.cleanupRequestSha256,
		evidence.componentOrder,
		evidence.componentOperationIds,
		evidence.orderedComponentReceiptSha256s,
		true,
		true,
		true,
		true,
	];
}

function isolationCleanupReceiptTuple(
	receipt: TransientTaskIsolationCleanupReceiptV1,
): readonly CanonicalRuntimeValue[] {
	const dependency: readonly CanonicalRuntimeValue[] =
		receipt.cleanupKind === "after_capture"
			? [receipt.captureId, receipt.captureReceiptSha256]
			: [receipt.outcome, receipt.pendingOutcomeSha256, receipt.canonicalProviderTerminalEvidenceSha256];
	return [
		"omp-transient-task-post-terminal-v1",
		"isolation_cleanup_receipt",
		1,
		receipt.taskId,
		receipt.runId,
		receipt.isolationCleanupId,
		receipt.publicationTargetId,
		publicationTargetKeyTuple(receipt.publicationTargetKey),
		receipt.bindingAccess,
		receipt.bindingRevision,
		receipt.bindingRenewalSequence,
		receipt.bindingReceiptSha256,
		receipt.bindingAuthoritySha256,
		receipt.bindingOpenRequestSha256,
		receipt.cleanupDescriptorSha256,
		receipt.isolationNamespaceSha256,
		receipt.isolationOwnerManifestSha256,
		receipt.isolationCreatorDescriptorSha256,
		publicationCleanupClaimTuple(receipt.cleanupClaim),
		receipt.planSha256,
		receipt.cleanupRequestSha256,
		receipt.cleanupAttemptSha256,
		isolationCleanupTerminalTuple(receipt.terminalEvidence),
		receipt.terminalEvidenceSha256,
		receipt.cleanupKind,
		dependency,
		receipt.cleanedAt,
	];
}

function publicationReleaseRequestTuple(
	plan: TransientTaskPublicationTargetReleasePlanV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"release_request",
		1,
		publicationTargetKeyTuple(plan.key),
		plan.isolationCleanupId,
		plan.bindingOperationId,
		plan.expectedBindingRevision,
		plan.expectedRenewalSequence,
		plan.previousReceiptSha256,
		plan.bindingAuthoritySha256,
		plan.bindingOpenRequestSha256,
		plan.cleanupDescriptorSha256,
		publicationCleanupClaimTuple(plan.cleanupClaim),
		isolationCleanupReceiptTuple(plan.isolationCleanupReceipt),
		plan.isolationCleanupReceiptSha256,
		plan.reason,
		publicationAuthorityTuple(plan.authority),
		plan.authoritySha256,
	];
}

function publicationReleasePlanTuple(
	plan: TransientTaskPublicationTargetReleasePlanV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"release_plan",
		1,
		publicationReleaseRequestTuple(plan),
		plan.releaseRequestSha256,
		plan.plannedAt,
	];
}

function publicationExpiryRequestTuple(
	plan: TransientTaskPublicationTargetExpiryPlanV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"expiry_request",
		1,
		publicationTargetKeyTuple(plan.key),
		plan.isolationCleanupId,
		plan.bindingOperationId,
		plan.expectedBindingRevision,
		plan.expectedRenewalSequence,
		plan.previousReceiptSha256,
		plan.expectedExpiresAt,
		publicationAuthorityTuple(plan.authority),
		plan.authoritySha256,
	];
}

function publicationExpiryPlanTuple(
	plan: TransientTaskPublicationTargetExpiryPlanV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"expiry_plan",
		1,
		publicationExpiryRequestTuple(plan),
		plan.expiryRequestSha256,
		plan.plannedAt,
	];
}

function publicationAttemptInspection(
	operationId: OperationId,
	requestSha256: Sha256Hex,
	authoritySha256: Sha256Ref,
	attemptSha256: Sha256Ref,
) {
	return { bindingOperationId: operationId, requestSha256, authoritySha256, attemptSha256 } as const;
}

function publicationBindAttemptTuple(
	attempt: ConfidentialTransientTaskPublicationTargetBindAttemptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"bind_attempt",
		1,
		publicationBindRequestTuple(attempt.request),
		attempt.openedAt,
	];
}

function publicationRenewalAttemptTuple(
	attempt: ConfidentialTransientTaskPublicationTargetRenewalAttemptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"renewal_attempt",
		1,
		publicationRenewRequestTuple(attempt.request),
		attempt.previousReceipt.receiptSha256,
		attempt.openedAt,
	];
}

function publicationReleaseAttemptTuple(
	attempt: ConfidentialTransientTaskPublicationTargetReleaseAttemptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"release_attempt",
		1,
		publicationReleasePlanTuple(attempt.plan),
		attempt.openedAt,
	];
}

function publicationExpiryAttemptTuple(
	attempt: ConfidentialTransientTaskPublicationTargetExpiryAttemptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"expiry_attempt",
		1,
		publicationExpiryPlanTuple(attempt.plan),
		attempt.openedAt,
	];
}

function publicationBindingEvidenceTuple(
	evidence: TransientTaskPublicationTargetBindingEvidenceV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-publication-target-v1",
		"binding_evidence",
		1,
		publicationTargetKeyTuple(evidence.key),
		evidence.isolationCleanupId,
		publicationBindReceiptTuple(evidence.bindReceipt),
		evidence.renewalReceipts.map(publicationRenewalReceiptTuple),
		evidence.effectAccess,
		evidence.effectBindingRevision,
		evidence.effectBindingRenewalSequence,
		evidence.effectBindingReceiptSha256,
		evidence.effectBindingAuthoritySha256,
		evidence.effectBindingOpenRequestSha256,
		evidence.cleanupDescriptorSha256,
		publicationCleanupClaimTuple(evidence.cleanupClaim),
		evidence.worktreePublicationReceiptSha256,
		evidence.cleanupDueReceipt === null ? null : publicationCleanupDueReceiptTuple(evidence.cleanupDueReceipt),
		isolationCleanupReceiptTuple(evidence.isolationCleanupReceipt),
		evidence.isolationCleanupReceiptSha256,
		evidence.releasePlanSha256,
		publicationReleaseReceiptTuple(evidence.terminalReceipt),
		evidence.bindInspectStatuses,
		evidence.renewalInspectStatuses,
		evidence.releaseInspectStatuses,
		evidence.expiryInspectStatuses,
		evidence.bindAttemptSha256,
		evidence.renewalAttemptSha256s,
		evidence.releaseAttemptSha256,
		evidence.expiryAttemptSha256,
		evidence.adoptedAttemptSha256s,
		evidence.cleanupClaimSurvivedWallClockExpiry,
		0,
		0,
		0,
	];
}

function validPublicationCleanupClaim(
	input: unknown,
	key?: TransientTaskPublicationTargetKeyV1,
	isolationCleanupId?: OperationId,
): input is TransientTaskPublicationTargetCleanupClaimV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"key",
			"isolationCleanupId",
			"openOperationId",
			"cleanupClaimOperationId",
			"access",
			"bindingRevision",
			"renewalSequence",
			"bindingReceiptSha256",
			"bindingAuthoritySha256",
			"bindingOpenRequestSha256",
			"cleanupDescriptorSha256",
			"isolationNamespaceSha256",
			"isolationOwnerManifestSha256",
			"isolationCreatorDescriptorSha256",
			"claimedAt",
			"claimSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validPublicationTargetKey(input.key) ||
		!lifecycleIdentity(input.isolationCleanupId) ||
		!lifecycleIdentity(input.openOperationId) ||
		!lifecycleIdentity(input.cleanupClaimOperationId) ||
		input.openOperationId === input.cleanupClaimOperationId ||
		(input.access !== "live" && input.access !== "cleanup_due") ||
		!lifecycleSafeInteger(input.bindingRevision, 1) ||
		!lifecycleSafeInteger(input.renewalSequence) ||
		input.bindingRevision !== input.renewalSequence + (input.access === "live" ? 1 : 2) ||
		![
			input.bindingReceiptSha256,
			input.bindingAuthoritySha256,
			input.cleanupDescriptorSha256,
			input.isolationOwnerManifestSha256,
			input.isolationCreatorDescriptorSha256,
			input.claimSha256,
		].every(lifecycleSha256Ref) ||
		!lifecycleSha256Hex(input.bindingOpenRequestSha256) ||
		!lifecycleSha256Hex(input.isolationNamespaceSha256) ||
		!lifecycleIso8601(input.claimedAt)
	)
		return false;
	const claim = input as unknown as TransientTaskPublicationTargetCleanupClaimV1;
	return (
		(key === undefined || publicationTargetKeyMatches(claim.key, key)) &&
		(isolationCleanupId === undefined || claim.isolationCleanupId === isolationCleanupId) &&
		claim.claimSha256 === lifecycleTupleRef(publicationCleanupClaimTuple(claim))
	);
}

function validIsolationCleanupTerminalEvidence(
	input: unknown,
): input is TransientTaskIsolationCleanupTerminalEvidenceV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"isolationCleanupId",
			"planSha256",
			"cleanupRequestSha256",
			"componentOrder",
			"componentOperationIds",
			"orderedComponentReceiptSha256s",
			"backendStoppedOrNotApplicable",
			"directoryAbsent",
			"captureRefAbsentAfterExpectedOldCas",
			"ownershipClaimReleasedLast",
			"evidenceSha256",
		]) ||
		input.schemaVersion !== 1 ||
		![input.taskId, input.runId, input.isolationCleanupId].every(lifecycleIdentity) ||
		!lifecycleSha256Ref(input.planSha256) ||
		!lifecycleSha256Hex(input.cleanupRequestSha256) ||
		!strictArray(input.componentOrder) ||
		!exactJson(input.componentOrder, [
			"backend_stop",
			"directory_delete",
			"capture_ref_cas_delete",
			"ownership_claim_release",
		]) ||
		!strictArray(input.componentOperationIds) ||
		input.componentOperationIds.length !== 4 ||
		!input.componentOperationIds.every(lifecycleIdentity) ||
		!strictArray(input.orderedComponentReceiptSha256s) ||
		input.orderedComponentReceiptSha256s.length !== 4 ||
		!input.orderedComponentReceiptSha256s.every(lifecycleSha256Ref) ||
		input.backendStoppedOrNotApplicable !== true ||
		input.directoryAbsent !== true ||
		input.captureRefAbsentAfterExpectedOldCas !== true ||
		input.ownershipClaimReleasedLast !== true ||
		!lifecycleSha256Ref(input.evidenceSha256)
	)
		return false;
	const evidence = input as unknown as TransientTaskIsolationCleanupTerminalEvidenceV1;
	return evidence.evidenceSha256 === lifecycleTupleRef(isolationCleanupTerminalTuple(evidence));
}

function validIsolationCleanupReceipt(input: unknown): input is TransientTaskIsolationCleanupReceiptV1 {
	if (
		!proxyFreeData(input) ||
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		!("cleanupKind" in input)
	)
		return false;
	const base = [
		"schemaVersion",
		"taskId",
		"runId",
		"isolationCleanupId",
		"publicationTargetId",
		"publicationTargetKey",
		"bindingAccess",
		"bindingRevision",
		"bindingRenewalSequence",
		"bindingReceiptSha256",
		"bindingAuthoritySha256",
		"bindingOpenRequestSha256",
		"cleanupDescriptorSha256",
		"isolationNamespaceSha256",
		"isolationOwnerManifestSha256",
		"isolationCreatorDescriptorSha256",
		"cleanupClaim",
		"planSha256",
		"cleanupRequestSha256",
		"cleanupAttemptSha256",
		"terminalEvidence",
		"terminalEvidenceSha256",
		"cleanedAt",
		"receiptSha256",
		"cleanupKind",
	];
	const fields =
		input.cleanupKind === "after_capture"
			? [...base, "captureId", "captureReceiptSha256"]
			: [...base, "outcome", "pendingOutcomeSha256", "canonicalProviderTerminalEvidenceSha256"];
	if (
		!strictRecord(input, fields) ||
		input.schemaVersion !== 1 ||
		![input.taskId, input.runId, input.isolationCleanupId, input.publicationTargetId].every(lifecycleIdentity) ||
		!validPublicationTargetKey(input.publicationTargetKey) ||
		(input.bindingAccess !== "live" && input.bindingAccess !== "cleanup_due") ||
		!lifecycleSafeInteger(input.bindingRevision, 1) ||
		!lifecycleSafeInteger(input.bindingRenewalSequence) ||
		input.bindingRevision !== input.bindingRenewalSequence + (input.bindingAccess === "live" ? 1 : 2) ||
		![
			input.bindingReceiptSha256,
			input.bindingAuthoritySha256,
			input.cleanupDescriptorSha256,
			input.isolationOwnerManifestSha256,
			input.isolationCreatorDescriptorSha256,
			input.planSha256,
			input.cleanupAttemptSha256,
			input.terminalEvidenceSha256,
			input.receiptSha256,
		].every(lifecycleSha256Ref) ||
		!lifecycleSha256Hex(input.bindingOpenRequestSha256) ||
		!lifecycleSha256Hex(input.isolationNamespaceSha256) ||
		!lifecycleSha256Hex(input.cleanupRequestSha256) ||
		!lifecycleIdentity(input.isolationCleanupId) ||
		!validPublicationCleanupClaim(input.cleanupClaim, input.publicationTargetKey, input.isolationCleanupId) ||
		!validIsolationCleanupTerminalEvidence(input.terminalEvidence) ||
		!lifecycleIso8601(input.cleanedAt)
	)
		return false;
	if (input.cleanupKind === "after_capture") {
		if (!lifecycleIdentity(input.captureId) || !lifecycleSha256Ref(input.captureReceiptSha256)) return false;
	} else if (
		input.cleanupKind !== "non_success" ||
		(input.outcome !== "failed" && input.outcome !== "cancelled") ||
		!lifecycleSha256Ref(input.pendingOutcomeSha256) ||
		!lifecycleSha256Ref(input.canonicalProviderTerminalEvidenceSha256)
	)
		return false;
	const receipt = input as unknown as TransientTaskIsolationCleanupReceiptV1;
	return (
		receipt.taskId === receipt.publicationTargetKey.taskId &&
		receipt.runId === receipt.publicationTargetKey.runId &&
		receipt.publicationTargetId === receipt.publicationTargetKey.publicationTargetId &&
		receipt.bindingAccess === receipt.cleanupClaim.access &&
		receipt.bindingRevision === receipt.cleanupClaim.bindingRevision &&
		receipt.bindingRenewalSequence === receipt.cleanupClaim.renewalSequence &&
		receipt.bindingReceiptSha256 === receipt.cleanupClaim.bindingReceiptSha256 &&
		receipt.bindingAuthoritySha256 === receipt.cleanupClaim.bindingAuthoritySha256 &&
		receipt.bindingOpenRequestSha256 === receipt.cleanupClaim.bindingOpenRequestSha256 &&
		receipt.cleanupDescriptorSha256 === receipt.cleanupClaim.cleanupDescriptorSha256 &&
		receipt.isolationNamespaceSha256 === receipt.cleanupClaim.isolationNamespaceSha256 &&
		receipt.isolationOwnerManifestSha256 === receipt.cleanupClaim.isolationOwnerManifestSha256 &&
		receipt.isolationCreatorDescriptorSha256 === receipt.cleanupClaim.isolationCreatorDescriptorSha256 &&
		receipt.terminalEvidence.taskId === receipt.taskId &&
		receipt.terminalEvidence.runId === receipt.runId &&
		receipt.terminalEvidence.isolationCleanupId === receipt.isolationCleanupId &&
		receipt.terminalEvidence.planSha256 === receipt.planSha256 &&
		receipt.terminalEvidence.cleanupRequestSha256 === receipt.cleanupRequestSha256 &&
		receipt.terminalEvidenceSha256 === receipt.terminalEvidence.evidenceSha256 &&
		receipt.receiptSha256 === lifecycleTupleRef(isolationCleanupReceiptTuple(receipt))
	);
}

async function validPublicationBindRequest(input: unknown): Promise<boolean> {
	if (
		!strictRecord(input, [
			"key",
			"isolationCleanupId",
			"bindingOperationId",
			"creatorPreparation",
			"ttlMs",
			"authority",
			"authoritySha256",
			"bindRequestSha256",
		]) ||
		!validPublicationTargetKey(input.key) ||
		!lifecycleIdentity(input.isolationCleanupId) ||
		!lifecycleIdentity(input.bindingOperationId) ||
		!validLifecycleIsolationReady(input.creatorPreparation) ||
		!lifecycleSafeInteger(input.ttlMs, TRANSIENT_TASK_PUBLICATION_TARGET_TTL_MS_MIN_V1) ||
		Number(input.ttlMs) > TRANSIENT_TASK_PUBLICATION_TARGET_TTL_MS_MAX_V1 ||
		!validPublicationAuthority(input.authority) ||
		input.authority.kind !== "controller" ||
		!lifecycleSha256Ref(input.authoritySha256) ||
		!lifecycleSha256Hex(input.bindRequestSha256)
	)
		return false;
	const request = input as unknown as PublicationBindRequestV1;
	const ready = request.creatorPreparation;
	return (
		ready.taskId === request.key.taskId &&
		ready.runId === request.key.runId &&
		ready.createId === request.key.createId &&
		ready.creatorDescriptor.publicationTargetId === request.key.publicationTargetId &&
		ready.creatorDescriptor.isolationCleanupId === request.isolationCleanupId &&
		ready.creatorDescriptor.bindingOperationId === request.bindingOperationId &&
		ready.authoritySha256 === request.authoritySha256 &&
		request.authority.proof.taskId === request.key.taskId &&
		request.authority.proof.runId === request.key.runId &&
		request.authority.proof.createId === request.key.createId &&
		request.bindRequestSha256 === (await canonicalRuntimeSha256(publicationBindRequestTuple(request)))
	);
}

async function validPublicationRenewRequest(input: unknown): Promise<boolean> {
	if (
		!strictRecord(input, [
			"key",
			"isolationCleanupId",
			"bindingOperationId",
			"expectedBindingRevision",
			"expectedRenewalSequence",
			"previousReceiptSha256",
			"expectedExpiresAt",
			"ttlMs",
			"authority",
			"authoritySha256",
			"renewRequestSha256",
		]) ||
		!validPublicationTargetKey(input.key) ||
		![input.isolationCleanupId, input.bindingOperationId].every(lifecycleIdentity) ||
		!lifecycleSafeInteger(input.expectedBindingRevision, 1) ||
		!lifecycleSafeInteger(input.expectedRenewalSequence) ||
		!lifecycleSha256Ref(input.previousReceiptSha256) ||
		!lifecycleIso8601(input.expectedExpiresAt) ||
		!lifecycleSafeInteger(input.ttlMs, TRANSIENT_TASK_PUBLICATION_TARGET_TTL_MS_MIN_V1) ||
		Number(input.ttlMs) > TRANSIENT_TASK_PUBLICATION_TARGET_TTL_MS_MAX_V1 ||
		!validPublicationAuthority(input.authority) ||
		!lifecycleSha256Ref(input.authoritySha256) ||
		!lifecycleSha256Hex(input.renewRequestSha256)
	)
		return false;
	const request = input as unknown as PublicationRenewRequestV1;
	return request.renewRequestSha256 === (await canonicalRuntimeSha256(publicationRenewRequestTuple(request)));
}

async function validPublicationOpenRequest(input: unknown): Promise<boolean> {
	if (
		!proxyFreeData(input) ||
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		!("purpose" in input)
	)
		return false;
	const fields =
		input.purpose === "worktree_publication"
			? [
					"purpose",
					"access",
					"key",
					"isolationCleanupId",
					"worktreePublicationId",
					"openOperationId",
					"expectedBindingRevision",
					"expectedRenewalSequence",
					"expectedReceiptSha256",
					"authority",
					"authoritySha256",
					"openRequestSha256",
				]
			: [
					"purpose",
					"access",
					"key",
					"isolationCleanupId",
					"openOperationId",
					"cleanupClaimOperationId",
					"expectedBindingRevision",
					"expectedRenewalSequence",
					"expectedReceiptSha256",
					"authority",
					"authoritySha256",
					"openRequestSha256",
				];
	if (
		!strictRecord(input, fields) ||
		!validPublicationTargetKey(input.key) ||
		!lifecycleIdentity(input.isolationCleanupId) ||
		!lifecycleIdentity(input.openOperationId) ||
		!lifecycleSafeInteger(input.expectedBindingRevision, 1) ||
		!lifecycleSafeInteger(input.expectedRenewalSequence) ||
		!lifecycleSha256Ref(input.expectedReceiptSha256) ||
		!validPublicationAuthority(input.authority) ||
		!lifecycleSha256Ref(input.authoritySha256) ||
		!lifecycleSha256Hex(input.openRequestSha256)
	)
		return false;
	if (input.purpose === "worktree_publication") {
		if (input.access !== "live" || !lifecycleIdentity(input.worktreePublicationId)) return false;
	} else if (
		input.purpose !== "physical_cleanup" ||
		(input.access !== "live" && input.access !== "cleanup_due") ||
		!lifecycleIdentity(input.cleanupClaimOperationId) ||
		input.openOperationId === input.cleanupClaimOperationId
	)
		return false;
	const request = input as unknown as PublicationOpenRequestV1;
	return request.openRequestSha256 === (await canonicalRuntimeSha256(publicationOpenRequestTuple(request)));
}

async function validPublicationSettlementRequest(input: unknown): Promise<boolean> {
	if (
		!strictRecord(input, [
			"key",
			"isolationCleanupId",
			"worktreePublicationId",
			"publicationClaimSha256",
			"publicationReceiptSha256",
			"authority",
			"authoritySha256",
			"requestSha256",
		]) ||
		!validPublicationTargetKey(input.key) ||
		![input.isolationCleanupId, input.worktreePublicationId].every(lifecycleIdentity) ||
		![input.publicationClaimSha256, input.publicationReceiptSha256, input.authoritySha256].every(
			lifecycleSha256Ref,
		) ||
		!validPublicationAuthority(input.authority) ||
		!lifecycleSha256Hex(input.requestSha256)
	)
		return false;
	const request = input as unknown as PublicationSettleRequestV1;
	return request.requestSha256 === (await canonicalRuntimeSha256(publicationSettlementRequestTuple(request)));
}

async function validPublicationReleasePlan(input: unknown): Promise<boolean> {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"key",
			"isolationCleanupId",
			"bindingOperationId",
			"expectedBindingRevision",
			"expectedRenewalSequence",
			"previousReceiptSha256",
			"bindingAuthoritySha256",
			"bindingOpenRequestSha256",
			"cleanupDescriptorSha256",
			"cleanupClaim",
			"isolationCleanupReceipt",
			"isolationCleanupReceiptSha256",
			"reason",
			"authority",
			"authoritySha256",
			"releaseRequestSha256",
			"planSha256",
			"plannedAt",
		]) ||
		input.schemaVersion !== 1 ||
		!validPublicationTargetKey(input.key) ||
		![input.isolationCleanupId, input.bindingOperationId].every(lifecycleIdentity) ||
		!lifecycleSafeInteger(input.expectedBindingRevision, 1) ||
		!lifecycleSafeInteger(input.expectedRenewalSequence) ||
		![
			input.previousReceiptSha256,
			input.bindingAuthoritySha256,
			input.cleanupDescriptorSha256,
			input.isolationCleanupReceiptSha256,
			input.authoritySha256,
			input.planSha256,
		].every(lifecycleSha256Ref) ||
		!lifecycleSha256Hex(input.bindingOpenRequestSha256) ||
		!lifecycleIdentity(input.isolationCleanupId) ||
		!validPublicationCleanupClaim(input.cleanupClaim, input.key, input.isolationCleanupId) ||
		!validIsolationCleanupReceipt(input.isolationCleanupReceipt) ||
		input.isolationCleanupReceiptSha256 !== input.isolationCleanupReceipt.receiptSha256 ||
		(input.reason !== "ordinary_isolation_cleanup" &&
			input.reason !== "create_aborted" &&
			input.reason !== "expired") ||
		!validPublicationAuthority(input.authority) ||
		!lifecycleSha256Hex(input.releaseRequestSha256) ||
		!lifecycleIso8601(input.plannedAt)
	)
		return false;
	const plan = input as unknown as TransientTaskPublicationTargetReleasePlanV1;
	return (
		plan.releaseRequestSha256 === (await canonicalRuntimeSha256(publicationReleaseRequestTuple(plan))) &&
		plan.planSha256 === (await tupleRef(publicationReleasePlanTuple(plan)))
	);
}

async function validPublicationExpiryPlan(input: unknown): Promise<boolean> {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"key",
			"isolationCleanupId",
			"bindingOperationId",
			"expectedBindingRevision",
			"expectedRenewalSequence",
			"previousReceiptSha256",
			"expectedExpiresAt",
			"authority",
			"authoritySha256",
			"expiryRequestSha256",
			"planSha256",
			"plannedAt",
		]) ||
		input.schemaVersion !== 1 ||
		!validPublicationTargetKey(input.key) ||
		![input.isolationCleanupId, input.bindingOperationId].every(lifecycleIdentity) ||
		!lifecycleSafeInteger(input.expectedBindingRevision, 1) ||
		!lifecycleSafeInteger(input.expectedRenewalSequence) ||
		!lifecycleSha256Ref(input.previousReceiptSha256) ||
		!lifecycleIso8601(input.expectedExpiresAt) ||
		!validPublicationAuthority(input.authority) ||
		!lifecycleSha256Ref(input.authoritySha256) ||
		!lifecycleSha256Hex(input.expiryRequestSha256) ||
		!lifecycleSha256Ref(input.planSha256) ||
		!lifecycleIso8601(input.plannedAt)
	)
		return false;
	const plan = input as unknown as TransientTaskPublicationTargetExpiryPlanV1;
	return (
		plan.expiryRequestSha256 === (await canonicalRuntimeSha256(publicationExpiryRequestTuple(plan))) &&
		plan.planSha256 === (await tupleRef(publicationExpiryPlanTuple(plan)))
	);
}

async function decodePublicationBindAttempt(
	input: unknown,
): Promise<ConfidentialTransientTaskPublicationTargetBindAttemptV1 | null> {
	if (
		!strictRecord(input, ["request", "openedAt", "attemptSha256"]) ||
		!(await validPublicationBindRequest(input.request)) ||
		!lifecycleIso8601(input.openedAt) ||
		!lifecycleSha256Ref(input.attemptSha256)
	)
		return null;
	const attempt = input as unknown as ConfidentialTransientTaskPublicationTargetBindAttemptV1;
	return attempt.attemptSha256 === (await tupleRef(publicationBindAttemptTuple(attempt))) ? attempt : null;
}

async function decodePublicationRenewalAttempt(
	input: unknown,
): Promise<ConfidentialTransientTaskPublicationTargetRenewalAttemptV1 | null> {
	if (
		!strictRecord(input, ["request", "previousReceipt", "openedAt", "attemptSha256"]) ||
		!(await validPublicationRenewRequest(input.request)) ||
		(!validateTransientTaskPublicationTargetBindReceiptV1(input.previousReceipt) &&
			!validateTransientTaskPublicationTargetRenewalReceiptV1(input.previousReceipt)) ||
		!lifecycleIso8601(input.openedAt) ||
		!lifecycleSha256Ref(input.attemptSha256)
	)
		return null;
	const attempt = input as unknown as ConfidentialTransientTaskPublicationTargetRenewalAttemptV1;
	return attempt.attemptSha256 === (await tupleRef(publicationRenewalAttemptTuple(attempt))) ? attempt : null;
}

async function decodePublicationReleaseAttempt(
	input: unknown,
): Promise<ConfidentialTransientTaskPublicationTargetReleaseAttemptV1 | null> {
	if (
		!strictRecord(input, ["plan", "openedAt", "attemptSha256"]) ||
		!(await validPublicationReleasePlan(input.plan)) ||
		!lifecycleIso8601(input.openedAt) ||
		!lifecycleSha256Ref(input.attemptSha256)
	)
		return null;
	const attempt = input as unknown as ConfidentialTransientTaskPublicationTargetReleaseAttemptV1;
	return attempt.attemptSha256 === (await tupleRef(publicationReleaseAttemptTuple(attempt))) ? attempt : null;
}

async function decodePublicationExpiryAttempt(
	input: unknown,
): Promise<ConfidentialTransientTaskPublicationTargetExpiryAttemptV1 | null> {
	if (
		!strictRecord(input, ["plan", "openedAt", "attemptSha256"]) ||
		!(await validPublicationExpiryPlan(input.plan)) ||
		!lifecycleIso8601(input.openedAt) ||
		!lifecycleSha256Ref(input.attemptSha256)
	)
		return null;
	const attempt = input as unknown as ConfidentialTransientTaskPublicationTargetExpiryAttemptV1;
	return attempt.attemptSha256 === (await tupleRef(publicationExpiryAttemptTuple(attempt))) ? attempt : null;
}

async function decodePublicationBindingEvidence(
	input: unknown,
): Promise<TransientTaskPublicationTargetBindingEvidenceV1 | null> {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"key",
			"isolationCleanupId",
			"bindReceipt",
			"renewalReceipts",
			"effectAccess",
			"effectBindingRevision",
			"effectBindingRenewalSequence",
			"effectBindingReceiptSha256",
			"effectBindingAuthoritySha256",
			"effectBindingOpenRequestSha256",
			"cleanupDescriptorSha256",
			"cleanupClaim",
			"worktreePublicationReceiptSha256",
			"cleanupDueReceipt",
			"isolationCleanupReceipt",
			"isolationCleanupReceiptSha256",
			"releasePlanSha256",
			"terminalReceipt",
			"bindInspectStatuses",
			"renewalInspectStatuses",
			"releaseInspectStatuses",
			"expiryInspectStatuses",
			"bindAttemptSha256",
			"renewalAttemptSha256s",
			"releaseAttemptSha256",
			"expiryAttemptSha256",
			"adoptedAttemptSha256s",
			"cleanupClaimSurvivedWallClockExpiry",
			"publicPhysicalPathFieldCount",
			"publicBackendFieldCount",
			"publicPrivateRequestDigestFieldCount",
			"evidenceSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validPublicationTargetKey(input.key) ||
		!lifecycleIdentity(input.isolationCleanupId) ||
		!validateTransientTaskPublicationTargetBindReceiptV1(input.bindReceipt) ||
		!strictArray(input.renewalReceipts) ||
		!input.renewalReceipts.every(validateTransientTaskPublicationTargetRenewalReceiptV1) ||
		(input.effectAccess !== "live" && input.effectAccess !== "cleanup_due") ||
		!lifecycleSafeInteger(input.effectBindingRevision, 1) ||
		!lifecycleSafeInteger(input.effectBindingRenewalSequence) ||
		![
			input.effectBindingReceiptSha256,
			input.effectBindingAuthoritySha256,
			input.cleanupDescriptorSha256,
			input.isolationCleanupReceiptSha256,
			input.releasePlanSha256,
			input.bindAttemptSha256,
			input.releaseAttemptSha256,
			input.evidenceSha256,
		].every(lifecycleSha256Ref) ||
		!lifecycleSha256Hex(input.effectBindingOpenRequestSha256) ||
		!validPublicationCleanupClaim(input.cleanupClaim, input.key, input.isolationCleanupId) ||
		(input.worktreePublicationReceiptSha256 !== null &&
			!lifecycleSha256Ref(input.worktreePublicationReceiptSha256)) ||
		(input.cleanupDueReceipt !== null &&
			!validateTransientTaskPublicationTargetCleanupDueReceiptV1(input.cleanupDueReceipt)) ||
		!validIsolationCleanupReceipt(input.isolationCleanupReceipt) ||
		!validateTransientTaskPublicationTargetReleaseReceiptV1(input.terminalReceipt) ||
		!strictArray(input.bindInspectStatuses) ||
		!input.bindInspectStatuses.every(
			status => PUBLICATION_BIND_INSPECT_STATUSES[status as PublicationBindInspectStatusV1] === true,
		) ||
		!strictArray(input.renewalInspectStatuses) ||
		!input.renewalInspectStatuses.every(
			status => PUBLICATION_BIND_INSPECT_STATUSES[status as PublicationBindInspectStatusV1] === true,
		) ||
		!strictArray(input.releaseInspectStatuses) ||
		!input.releaseInspectStatuses.every(
			status => PUBLICATION_RELEASE_INSPECT_STATUSES[status as PublicationReleaseInspectStatusV1] === true,
		) ||
		!strictArray(input.expiryInspectStatuses) ||
		!input.expiryInspectStatuses.every(
			status => PUBLICATION_RELEASE_INSPECT_STATUSES[status as PublicationReleaseInspectStatusV1] === true,
		) ||
		!strictArray(input.renewalAttemptSha256s) ||
		!input.renewalAttemptSha256s.every(lifecycleSha256Ref) ||
		(input.expiryAttemptSha256 !== null && !lifecycleSha256Ref(input.expiryAttemptSha256)) ||
		!strictArray(input.adoptedAttemptSha256s) ||
		!input.adoptedAttemptSha256s.every(lifecycleSha256Ref) ||
		typeof input.cleanupClaimSurvivedWallClockExpiry !== "boolean" ||
		input.publicPhysicalPathFieldCount !== 0 ||
		input.publicBackendFieldCount !== 0 ||
		input.publicPrivateRequestDigestFieldCount !== 0
	)
		return null;
	const evidence = input as unknown as TransientTaskPublicationTargetBindingEvidenceV1;
	return publicationTargetKeyMatches(evidence.bindReceipt.key, evidence.key) &&
		evidence.bindReceipt.isolationCleanupId === evidence.isolationCleanupId &&
		evidence.effectBindingRevision === evidence.cleanupClaim.bindingRevision &&
		evidence.effectBindingRenewalSequence === evidence.cleanupClaim.renewalSequence &&
		evidence.effectBindingReceiptSha256 === evidence.cleanupClaim.bindingReceiptSha256 &&
		evidence.effectBindingAuthoritySha256 === evidence.cleanupClaim.bindingAuthoritySha256 &&
		evidence.effectBindingOpenRequestSha256 === evidence.cleanupClaim.bindingOpenRequestSha256 &&
		evidence.cleanupDescriptorSha256 === evidence.cleanupClaim.cleanupDescriptorSha256 &&
		evidence.isolationCleanupReceiptSha256 === evidence.isolationCleanupReceipt.receiptSha256 &&
		evidence.releasePlanSha256 === evidence.terminalReceipt.releasePlanSha256 &&
		evidence.terminalReceipt.cleanupClaimSha256 === evidence.cleanupClaim.claimSha256 &&
		evidence.terminalReceipt.isolationCleanupReceiptSha256 === evidence.isolationCleanupReceiptSha256 &&
		evidence.evidenceSha256 === (await tupleRef(publicationBindingEvidenceTuple(evidence)))
		? evidence
		: null;
}

async function decodePublicationActiveAttempt(
	input: unknown,
): Promise<ConfidentialTransientTaskPublicationTargetActiveAttemptV1 | null> {
	if (
		!strictRecord(input, ["certainty", "operation", "attempt"]) ||
		(input.certainty !== "outcome_unknown" && input.certainty !== "not_applied")
	)
		return null;
	if (input.operation === "renewal") {
		const attempt = await decodePublicationRenewalAttempt(input.attempt);
		return attempt === null ? null : { certainty: input.certainty, operation: "renewal", attempt };
	}
	if (input.operation === "release") {
		const attempt = await decodePublicationReleaseAttempt(input.attempt);
		return attempt === null ? null : { certainty: input.certainty, operation: "release", attempt };
	}
	if (input.operation === "expiry") {
		const attempt = await decodePublicationExpiryAttempt(input.attempt);
		return attempt === null ? null : { certainty: input.certainty, operation: "expiry", attempt };
	}
	return null;
}

async function publicationBindingRow(input: unknown): Promise<PrivatePublicationTargetBindingRowV1 | null> {
	if (input === undefined) return null;
	if (
		!strictRecord(input, [
			"schemaVersion",
			"confidential",
			"bindInspectStatuses",
			"renewalInspectStatuses",
			"releaseInspectStatuses",
			"expiryInspectStatuses",
			"adoptedAttemptSha256s",
			"publicationSettlement",
			"completedExpiryAttempt",
			"terminalReleaseAttempt",
		]) ||
		input.schemaVersion !== 1 ||
		!strictArray(input.bindInspectStatuses) ||
		!input.bindInspectStatuses.every(
			status => PUBLICATION_BIND_INSPECT_STATUSES[status as PublicationBindInspectStatusV1] === true,
		) ||
		!strictArray(input.renewalInspectStatuses) ||
		!input.renewalInspectStatuses.every(
			status => PUBLICATION_BIND_INSPECT_STATUSES[status as PublicationBindInspectStatusV1] === true,
		) ||
		!strictArray(input.releaseInspectStatuses) ||
		!input.releaseInspectStatuses.every(
			status => PUBLICATION_RELEASE_INSPECT_STATUSES[status as PublicationReleaseInspectStatusV1] === true,
		) ||
		!strictArray(input.expiryInspectStatuses) ||
		!input.expiryInspectStatuses.every(
			status => PUBLICATION_RELEASE_INSPECT_STATUSES[status as PublicationReleaseInspectStatusV1] === true,
		) ||
		!strictArray(input.adoptedAttemptSha256s) ||
		!input.adoptedAttemptSha256s.every(lifecycleSha256Ref) ||
		(input.publicationSettlement !== null &&
			(!strictRecord(input.publicationSettlement, [
				"publicationClaimSha256",
				"publicationReceiptSha256",
				"requestSha256",
			]) ||
				!lifecycleSha256Ref(input.publicationSettlement.publicationClaimSha256) ||
				!lifecycleSha256Ref(input.publicationSettlement.publicationReceiptSha256) ||
				!lifecycleSha256Hex(input.publicationSettlement.requestSha256))) ||
		!proxyFreeData(input.confidential) ||
		input.confidential === null ||
		typeof input.confidential !== "object" ||
		Array.isArray(input.confidential) ||
		!("state" in input.confidential)
	)
		throw new Error("Transient publication target binding row is invalid");
	const completedExpiryAttempt =
		input.completedExpiryAttempt === null ? null : await decodePublicationExpiryAttempt(input.completedExpiryAttempt);
	const terminalReleaseAttempt =
		input.terminalReleaseAttempt === null
			? null
			: await decodePublicationReleaseAttempt(input.terminalReleaseAttempt);
	if (
		(input.completedExpiryAttempt !== null && completedExpiryAttempt === null) ||
		(input.terminalReleaseAttempt !== null && terminalReleaseAttempt === null)
	)
		throw new Error("Transient publication target binding attempts are invalid");
	const confidential = input.confidential;
	if (confidential.state === "bind_outcome_unknown" || confidential.state === "bind_not_applied") {
		if (
			!strictRecord(confidential, ["state", "binding", "bindAttempt"]) ||
			!validateTransientTaskPublicationTargetBindingV1(confidential.binding) ||
			confidential.binding.progress.state !== confidential.state ||
			completedExpiryAttempt !== null ||
			terminalReleaseAttempt !== null
		)
			throw new Error("Transient publication target bind attempt row is invalid");
		const bindAttempt = await decodePublicationBindAttempt(confidential.bindAttempt);
		if (bindAttempt === null || confidential.binding.progress.attempt.attemptSha256 !== bindAttempt.attemptSha256)
			throw new Error("Transient publication target bind attempt lineage is invalid");
		return input as unknown as PrivatePublicationTargetBindingRowV1;
	}
	if (confidential.state === "terminal") {
		if (
			!strictRecord(confidential, ["state", "binding", "evidence"]) ||
			!validateTransientTaskPublicationTargetBindingV1(confidential.binding) ||
			confidential.binding.progress.state !== "terminal" ||
			terminalReleaseAttempt === null
		)
			throw new Error("Transient publication target terminal row is invalid");
		const evidence = await decodePublicationBindingEvidence(confidential.evidence);
		if (evidence === null || terminalReleaseAttempt.attemptSha256 !== evidence.releaseAttemptSha256)
			throw new Error("Transient publication target terminal evidence is invalid");
		return input as unknown as PrivatePublicationTargetBindingRowV1;
	}
	if (confidential.state !== "live" && confidential.state !== "cleanup_due")
		throw new Error("Transient publication target binding state is invalid");
	if (
		!strictRecord(confidential, [
			"state",
			"binding",
			"creatorPreparation",
			"bindAttempt",
			"completedRenewals",
			"activeAttempt",
		]) ||
		!validateTransientTaskPublicationTargetBindingV1(confidential.binding) ||
		confidential.binding.progress.state !== confidential.state ||
		!validLifecycleIsolationReady(confidential.creatorPreparation) ||
		!strictArray(confidential.completedRenewals)
	)
		throw new Error("Transient publication target live row is invalid");
	const bindAttempt = await decodePublicationBindAttempt(confidential.bindAttempt);
	if (bindAttempt === null || !exactJson(confidential.creatorPreparation, bindAttempt.request.creatorPreparation))
		throw new Error("Transient publication target bind attempt is invalid");
	const derivedBindReceipt = await publicationBindReceiptFromAttempt(bindAttempt);
	const bindReceipt =
		confidential.binding.progress.state === "live" ? confidential.binding.progress.bindReceipt : derivedBindReceipt;
	if (!validateTransientTaskPublicationTargetBindReceiptV1(bindReceipt) || !exactJson(bindReceipt, derivedBindReceipt))
		throw new Error("Transient publication target bind receipt lineage is invalid");
	let previous: TransientTaskPublicationTargetBindReceiptV1 | TransientTaskPublicationTargetRenewalReceiptV1 =
		bindReceipt;
	for (const entryInput of confidential.completedRenewals) {
		if (!strictRecord(entryInput, ["attempt", "receipt"]))
			throw new Error("Transient publication target renewal entry is invalid");
		const attempt = await decodePublicationRenewalAttempt(entryInput.attempt);
		const receiptInput = entryInput.receipt;
		if (attempt === null || !validateTransientTaskPublicationTargetRenewalReceiptV1(receiptInput))
			throw new Error("Transient publication target renewal entry is invalid");
		const receipt = receiptInput;
		if (
			attempt.previousReceipt.receiptSha256 !== previous.receiptSha256 ||
			receipt.previousReceiptSha256 !== previous.receiptSha256 ||
			receipt.bindingRevision !== previous.bindingRevision + 1 ||
			receipt.renewalSequence !== previous.renewalSequence + 1 ||
			receipt.bindingOperationId !== attempt.request.bindingOperationId ||
			receipt.renewRequestSha256 !== attempt.request.renewRequestSha256 ||
			receipt.authoritySha256 !== attempt.request.authoritySha256
		)
			throw new Error("Transient publication target renewal lineage is invalid");
		previous = receipt;
	}
	if (confidential.binding.progress.state === "live") {
		const currentReceipt =
			confidential.binding.progress.lastRenewalReceipt ?? confidential.binding.progress.bindReceipt;
		if (
			confidential.binding.bindingRevision !== currentReceipt.bindingRevision ||
			confidential.binding.renewalSequence !== currentReceipt.renewalSequence ||
			currentReceipt.receiptSha256 !== previous.receiptSha256
		)
			throw new Error("Transient publication target current receipt is invalid");
	} else {
		const currentReceipt = confidential.binding.progress.cleanupDueReceipt;
		if (
			confidential.binding.bindingRevision !== currentReceipt.bindingRevision ||
			confidential.binding.renewalSequence !== currentReceipt.renewalSequence ||
			currentReceipt.previousReceiptSha256 !== previous.receiptSha256 ||
			currentReceipt.bindingRevision !== previous.bindingRevision + 1 ||
			currentReceipt.renewalSequence !== previous.renewalSequence
		)
			throw new Error("Transient publication target current receipt is invalid");
	}
	if (confidential.activeAttempt !== null) {
		const activeAttempt = await decodePublicationActiveAttempt(confidential.activeAttempt);
		if (activeAttempt === null) throw new Error("Transient publication target active attempt is invalid");
		const transition = confidential.binding.progress.transition;
		if (
			transition === null ||
			!transition.state.startsWith(`${activeAttempt.operation}_`) ||
			transition.attempt.attemptSha256 !== activeAttempt.attempt.attemptSha256 ||
			transition.state.endsWith("outcome_unknown") !== (activeAttempt.certainty === "outcome_unknown")
		)
			throw new Error("Transient publication target transition is invalid");
	} else if (confidential.binding.progress.transition !== null) {
		throw new Error("Transient publication target transition is orphaned");
	}
	return input as unknown as PrivatePublicationTargetBindingRowV1;
}

function publicationBindingMapKey(key: TransientTaskPublicationTargetKeyV1): string {
	return `${key.createId}\u0000${key.publicationTargetId}`;
}

function publicationBindingLifecycleMatches(
	state: TransientTaskRuntimeStateV1,
	key: TransientTaskPublicationTargetKeyV1,
	authority: TransientTaskPublicationTargetAuthorityV1,
): boolean {
	const current = state.authority;
	if (
		current === null ||
		current.taskId !== key.taskId ||
		current.runId !== key.runId ||
		current.createId !== key.createId ||
		current.publicationTargetId !== key.publicationTargetId
	)
		return false;
	if (authority.kind === "controller")
		return (
			current.state !== "cleanup" &&
			current.state !== "deleted" &&
			current.state !== "discarded" &&
			current.controller !== null &&
			controllerProofMatches(current.controller.proof, authority.proof)
		);
	if (authority.kind === "cleanup")
		return current.state === "cleanup" && cleanupProofMatches(current.cleanup.authority.proof, authority.proof);
	return (
		(current.state === "deleted" || current.state === "discarded") &&
		current.cleanup.progress.evidence.postTerminalCleanupEvidenceId === authority.evidenceId &&
		current.cleanup.progress.evidence.evidenceSha256 === authority.evidenceSha256
	);
}

function publicationBindCreatorMatches(state: TransientTaskRuntimeStateV1, request: PublicationBindRequestV1): boolean {
	const current = state.authority;
	return Boolean(
		publicationBindingLifecycleMatches(state, request.key, request.authority) &&
			current?.state === "preparing" &&
			current.isolationPreparation.state === "ready_to_bind" &&
			exactJson(current.isolationPreparation.ready, request.creatorPreparation) &&
			current.isolationCleanupId === request.isolationCleanupId &&
			current.isolationNamespaceSha256 === request.creatorPreparation.creatorDescriptor.namespaceSha256 &&
			current.isolationOwnerManifestSha256 === request.creatorPreparation.creatorDescriptor.ownerManifestSha256 &&
			current.isolationCreatorDescriptorSha256 ===
				request.creatorPreparation.creatorDescriptor.creatorDescriptorSha256,
	);
}

function publicationCurrentReceipt(
	confidential: Extract<PrivatePublicationTargetConfidentialBindingV1, { state: "live" }>,
): TransientTaskPublicationTargetBindReceiptV1 | TransientTaskPublicationTargetRenewalReceiptV1 {
	const progress = confidential.binding.progress;
	if (progress.state !== "live") throw new Error("Transient publication target live binding is invalid");
	return progress.lastRenewalReceipt ?? progress.bindReceipt;
}

function appendSha256(values: readonly Sha256Ref[], value: Sha256Ref): readonly Sha256Ref[] {
	return values.includes(value) ? values : [...values, value];
}

function publishedWorktreeReceiptSha256(
	state: TransientTaskRuntimeStateV1,
	worktreePublicationId: OperationId,
): Sha256Ref | null {
	const authority = state.authority;
	if (authority === null) return null;
	if (authority.state === "cleanup") {
		const progress = authority.cleanup.progress;
		if (progress.state === "worktree_published" && progress.receipt.worktreePublicationId === worktreePublicationId)
			return progress.receipt.receiptSha256;
		if (
			progress.state === "runtime_released" &&
			progress.worktreePublication?.worktreePublicationId === worktreePublicationId
		)
			return progress.worktreePublication.receiptSha256;
		return null;
	}
	if (authority.state !== "deleted" && authority.state !== "discarded") return null;
	const receipt = authority.cleanup.progress.evidence.worktreePublication;
	return receipt?.worktreePublicationId === worktreePublicationId ? receipt.receiptSha256 : null;
}

async function publicationBindReceiptFromAttempt(
	attempt: ConfidentialTransientTaskPublicationTargetBindAttemptV1,
): Promise<TransientTaskPublicationTargetBindReceiptV1> {
	const request = attempt.request;
	const ready = request.creatorPreparation;
	const boundAt = attempt.openedAt;
	const receipt: TransientTaskPublicationTargetBindReceiptV1 = {
		schemaVersion: 1,
		key: request.key,
		isolationCleanupId: request.isolationCleanupId,
		bindingOperationId: request.bindingOperationId,
		state: "bound",
		bindingRevision: 1,
		renewalSequence: 0,
		cleanupDescriptorSha256: ready.cleanupDescriptor.cleanupDescriptorSha256,
		isolationCreatorPreparationReceiptSha256: ready.receiptSha256,
		isolationOwnershipClaimReceiptSha256: ready.ownershipClaimReceipt.receiptSha256,
		isolationCreatorDescriptorSha256: ready.creatorDescriptor.creatorDescriptorSha256,
		isolationNamespaceSha256: ready.creatorDescriptor.namespaceSha256,
		isolationOwnerManifestSha256: ready.creatorDescriptor.ownerManifestSha256,
		bindRequestSha256: request.bindRequestSha256,
		authoritySha256: request.authoritySha256,
		boundAt,
		renewBy: renewalDeadline(boundAt, request.ttlMs),
		expiresAt: addMilliseconds(boundAt, request.ttlMs),
		receiptSha256: "sha256:" as Sha256Ref,
	};
	return { ...receipt, receiptSha256: await tupleRef(publicationBindReceiptTuple(receipt)) };
}

async function publicationRenewalReceiptFromAttempt(
	attempt: ConfidentialTransientTaskPublicationTargetRenewalAttemptV1,
): Promise<TransientTaskPublicationTargetRenewalReceiptV1> {
	const request = attempt.request;
	const previous = attempt.previousReceipt;
	const renewedAt = attempt.openedAt;
	const receipt: TransientTaskPublicationTargetRenewalReceiptV1 = {
		schemaVersion: 1,
		key: request.key,
		isolationCleanupId: request.isolationCleanupId,
		bindingOperationId: request.bindingOperationId,
		state: "renewed",
		bindingRevision: previous.bindingRevision + 1,
		renewalSequence: previous.renewalSequence + 1,
		previousReceiptSha256: previous.receiptSha256,
		renewRequestSha256: request.renewRequestSha256,
		authoritySha256: request.authoritySha256,
		renewedAt,
		renewBy: renewalDeadline(renewedAt, request.ttlMs),
		expiresAt: addMilliseconds(renewedAt, request.ttlMs),
		receiptSha256: "sha256:" as Sha256Ref,
	};
	return { ...receipt, receiptSha256: await tupleRef(publicationRenewalReceiptTuple(receipt)) };
}

async function publicationCleanupDueReceiptFromAttempt(
	attempt: ConfidentialTransientTaskPublicationTargetExpiryAttemptV1,
): Promise<TransientTaskPublicationTargetCleanupDueReceiptV1> {
	const plan = attempt.plan;
	const receipt: TransientTaskPublicationTargetCleanupDueReceiptV1 = {
		schemaVersion: 1,
		key: plan.key,
		isolationCleanupId: plan.isolationCleanupId,
		bindingOperationId: plan.bindingOperationId,
		state: "cleanup_due",
		bindingRevision: plan.expectedBindingRevision + 1,
		renewalSequence: plan.expectedRenewalSequence,
		previousReceiptSha256: plan.previousReceiptSha256,
		expiresAt: plan.expectedExpiresAt,
		expiryRequestSha256: plan.expiryRequestSha256,
		expiryPlanSha256: plan.planSha256,
		authoritySha256: plan.authoritySha256,
		cleanupDueAt: attempt.openedAt,
		receiptSha256: "sha256:" as Sha256Ref,
	};
	return { ...receipt, receiptSha256: await tupleRef(publicationCleanupDueReceiptTuple(receipt)) };
}

async function publicationReleaseReceiptFromAttempt(
	attempt: ConfidentialTransientTaskPublicationTargetReleaseAttemptV1,
): Promise<TransientTaskPublicationTargetReleaseReceiptV1> {
	const plan = attempt.plan;
	const receipt: TransientTaskPublicationTargetReleaseReceiptV1 = {
		schemaVersion: 1,
		key: plan.key,
		isolationCleanupId: plan.isolationCleanupId,
		bindingOperationId: plan.bindingOperationId,
		state: plan.reason === "expired" ? "expired" : "released",
		bindingAccess: plan.cleanupClaim.access,
		bindingRevision: plan.expectedBindingRevision,
		renewalSequence: plan.expectedRenewalSequence,
		reason: plan.reason,
		previousReceiptSha256: plan.previousReceiptSha256,
		bindingAuthoritySha256: plan.bindingAuthoritySha256,
		bindingOpenRequestSha256: plan.bindingOpenRequestSha256,
		cleanupDescriptorSha256: plan.cleanupDescriptorSha256,
		cleanupClaimSha256: plan.cleanupClaim.claimSha256,
		isolationCleanupReceiptSha256: plan.isolationCleanupReceiptSha256,
		releaseRequestSha256: plan.releaseRequestSha256,
		releasePlanSha256: plan.planSha256,
		authoritySha256: plan.authoritySha256,
		terminalAt: attempt.openedAt,
		receiptSha256: "sha256:" as Sha256Ref,
	};
	return { ...receipt, receiptSha256: await tupleRef(publicationReleaseReceiptTuple(receipt)) };
}

type PublicationBindInspectRequestV1 = Parameters<TransientTaskPublicationTargetBindingStoreV1["inspectBind"]>[0];

function validPublicationBindInspectRequest(input: unknown, withAuthority: boolean): boolean {
	const fields = [
		"key",
		"isolationCleanupId",
		"bindingOperationId",
		"cleanupDescriptorSha256",
		"isolationCreatorPreparationReceiptSha256",
		"isolationOwnershipClaimReceiptSha256",
		"isolationCreatorDescriptorSha256",
		"isolationNamespaceSha256",
		"isolationOwnerManifestSha256",
		"bindRequestSha256",
	];
	if (withAuthority) fields.push("authority");
	if (
		!strictRecord(input, fields) ||
		!validPublicationTargetKey(input.key) ||
		![input.isolationCleanupId, input.bindingOperationId].every(lifecycleIdentity) ||
		![
			input.cleanupDescriptorSha256,
			input.isolationCreatorPreparationReceiptSha256,
			input.isolationOwnershipClaimReceiptSha256,
			input.isolationCreatorDescriptorSha256,
			input.isolationOwnerManifestSha256,
		].every(lifecycleSha256Ref) ||
		!lifecycleSha256Hex(input.isolationNamespaceSha256) ||
		!lifecycleSha256Hex(input.bindRequestSha256)
	)
		return false;
	return !withAuthority || (validPublicationAuthority(input.authority) && input.authority.kind === "controller");
}

function validPublicationRenewInspectRequest(input: unknown, withAuthority: boolean): boolean {
	const fields = ["key", "isolationCleanupId", "bindingOperationId", "renewRequestSha256"];
	if (withAuthority) fields.push("authority");
	return Boolean(
		strictRecord(input, fields) &&
			validPublicationTargetKey(input.key) &&
			lifecycleIdentity(input.isolationCleanupId) &&
			lifecycleIdentity(input.bindingOperationId) &&
			lifecycleSha256Hex(input.renewRequestSha256) &&
			(!withAuthority || validPublicationAuthority(input.authority)),
	);
}

function validPublicationReleaseInspectRequest(input: unknown, withAuthority: boolean): boolean {
	const fields = ["key", "isolationCleanupId", "bindingOperationId", "planSha256", "releaseRequestSha256"];
	if (withAuthority) fields.push("authority");
	return Boolean(
		strictRecord(input, fields) &&
			validPublicationTargetKey(input.key) &&
			lifecycleIdentity(input.isolationCleanupId) &&
			lifecycleIdentity(input.bindingOperationId) &&
			lifecycleSha256Ref(input.planSha256) &&
			lifecycleSha256Hex(input.releaseRequestSha256) &&
			(!withAuthority || validPublicationAuthority(input.authority)),
	);
}

function validPublicationExpiryInspectRequest(input: unknown, withAuthority: boolean): boolean {
	const fields = ["key", "isolationCleanupId", "bindingOperationId", "planSha256", "expiryRequestSha256"];
	if (withAuthority) fields.push("authority");
	return Boolean(
		strictRecord(input, fields) &&
			validPublicationTargetKey(input.key) &&
			lifecycleIdentity(input.isolationCleanupId) &&
			lifecycleIdentity(input.bindingOperationId) &&
			lifecycleSha256Ref(input.planSha256) &&
			lifecycleSha256Hex(input.expiryRequestSha256) &&
			(!withAuthority || validPublicationAuthority(input.authority)),
	);
}

function publicationBindInspectMatches(
	request: PublicationBindInspectRequestV1,
	attempt: ConfidentialTransientTaskPublicationTargetBindAttemptV1,
): boolean {
	const bind = attempt.request;
	const ready = bind.creatorPreparation;
	return (
		publicationTargetKeyMatches(request.key, bind.key) &&
		request.isolationCleanupId === bind.isolationCleanupId &&
		request.bindingOperationId === bind.bindingOperationId &&
		request.cleanupDescriptorSha256 === ready.cleanupDescriptor.cleanupDescriptorSha256 &&
		request.isolationCreatorPreparationReceiptSha256 === ready.receiptSha256 &&
		request.isolationOwnershipClaimReceiptSha256 === ready.ownershipClaimReceipt.receiptSha256 &&
		request.isolationCreatorDescriptorSha256 === ready.creatorDescriptor.creatorDescriptorSha256 &&
		request.isolationNamespaceSha256 === ready.creatorDescriptor.namespaceSha256 &&
		request.isolationOwnerManifestSha256 === ready.creatorDescriptor.ownerManifestSha256 &&
		request.bindRequestSha256 === bind.bindRequestSha256
	);
}

function publicationAttemptInspectionFromBind(attempt: ConfidentialTransientTaskPublicationTargetBindAttemptV1) {
	return publicationAttemptInspection(
		attempt.request.bindingOperationId,
		attempt.request.bindRequestSha256,
		attempt.request.authoritySha256,
		attempt.attemptSha256,
	);
}

const publicationWorktreeHandleState = new WeakMap<
	TransientTaskWorktreePublicationTargetHandleV1,
	ConfidentialTransientTaskIsolationReadyToBindReceiptV1
>();

export function isDurableTransientTaskWorktreePublicationTargetHandleV1(
	value: unknown,
): value is TransientTaskWorktreePublicationTargetHandleV1 {
	return (
		value !== null &&
		typeof value === "object" &&
		publicationWorktreeHandleState.has(value as TransientTaskWorktreePublicationTargetHandleV1)
	);
}

export function resolveDurableTransientTaskWorktreePublicationTargetHandleV1(
	value: unknown,
): ConfidentialTransientTaskIsolationReadyToBindReceiptV1 | null {
	return value !== null && typeof value === "object"
		? (publicationWorktreeHandleState.get(value as TransientTaskWorktreePublicationTargetHandleV1) ?? null)
		: null;
}

const publicationCleanupHandleState = new WeakMap<
	TransientTaskIsolationCleanupHandleV1,
	ConfidentialTransientTaskIsolationReadyToBindReceiptV1
>();

export function resolveDurableTransientTaskIsolationCleanupHandleV1(
	value: unknown,
): ConfidentialTransientTaskIsolationReadyToBindReceiptV1 | null {
	return value !== null && typeof value === "object"
		? (publicationCleanupHandleState.get(value as TransientTaskIsolationCleanupHandleV1) ?? null)
		: null;
}

function publicationTargetHandle(
	request: PublicationOpenRequestV1,
	claim: TransientTaskPublicationTargetPublicationClaimV1 | TransientTaskPublicationTargetCleanupClaimV1,
	creatorPreparation: ConfidentialTransientTaskIsolationReadyToBindReceiptV1,
	registerWorktreePublicationTarget:
		| ((
				handle: TransientTaskWorktreePublicationTargetHandleV1,
				creatorPreparation: ConfidentialTransientTaskIsolationReadyToBindReceiptV1,
		  ) => void)
		| null,
): TransientTaskWorktreePublicationTargetHandleV1 | TransientTaskIsolationCleanupHandleV1 {
	const target = Object.freeze({ claim: Object.freeze({ ...claim, key: Object.freeze({ ...claim.key }) }) });
	if (request.purpose === "worktree_publication") {
		const publicationTarget = target as TransientTaskWorktreePublicationTargetHandleV1;
		publicationWorktreeHandleState.set(publicationTarget, creatorPreparation);
		registerWorktreePublicationTarget?.(publicationTarget, creatorPreparation);
		return publicationTarget;
	}
	const cleanupTarget = target as TransientTaskIsolationCleanupHandleV1;
	publicationCleanupHandleState.set(cleanupTarget, creatorPreparation);
	return cleanupTarget;
}

const INVALID_PUBLICATION_TARGET_REQUEST_KEY: TransientTaskPublicationTargetKeyV1 = Object.freeze({
	schemaVersion: 1,
	taskId: "invalid-publication-target-request",
	runId: "invalid-publication-target-request",
	createId: "invalid-publication-target-request",
	publicationTargetId: "invalid-publication-target-request",
});

function payloadRefTuple(ref: TransientTaskOutcomePayloadRefV1): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-outcome-payload-v1",
		"ref",
		1,
		ref.taskId,
		ref.runId,
		ref.resultPublicationId,
		ref.payloadRole,
		ref.payloadId,
		ref.mediaType,
		ref.byteLength,
		ref.payloadSha256,
	];
}

function payloadActiveAuthorityTuple(
	authority: TransientTaskOutcomePayloadActiveRetentionAuthorityV1,
): readonly CanonicalRuntimeValue[] {
	const prefix: CanonicalRuntimeValue[] = [
		"omp-transient-task-outcome-payload-v1",
		"active_authority",
		1,
		authority.taskId,
		authority.runId,
		authority.resultPublicationId,
		authority.payloadRole,
		authority.payloadId,
		authority.payloadDeleteId,
		"active_task",
		authority.kind,
		authority.expectedAuthorityRevision,
	];
	if (authority.kind === "controller") return [...prefix, controllerProofTuple(authority.proof)];
	if (authority.kind === "cleanup") return [...prefix, cleanupProofTuple(authority.proof)];
	return [...prefix, [authority.terminalEvidence.evidenceId, authority.terminalEvidence.evidenceSha256]];
}

function payloadRecoveryAuthorityTuple(
	authority: TransientTaskOutcomePayloadRecoveryAuthorityV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-outcome-payload-v1",
		"recovery_authority",
		1,
		authority.taskId,
		authority.runId,
		authority.resultPublicationId,
		authority.payloadRole,
		authority.payloadId,
		authority.payloadDeleteId,
		authority.source,
		authority.pendingOutcomeReceiptSha256,
		authority.terminalEvidenceId,
		authority.terminalEvidenceSha256,
		authority.singleResultCompositionReceiptSha256,
	];
}

function payloadRetentionAuthorityTuple(
	authority: TransientTaskOutcomePayloadRetentionAuthorityV1,
): readonly CanonicalRuntimeValue[] {
	return authority.phase === "active_task"
		? payloadActiveAuthorityTuple(authority)
		: [
				"recovery_retention",
				payloadRecoveryAuthorityTuple(authority.recoveryAuthority),
				authority.recoveryAuthoritySha256,
			];
}

function payloadLifetimeTuple(lifetime: TransientTaskOutcomePayloadLifetimeV1): readonly CanonicalRuntimeValue[] {
	return [
		lifetime.phase,
		lifetime.renewBy,
		lifetime.expiresAt,
		lifetime.recoveryAuthoritySha256,
		lifetime.recoveryStartedAt,
		lifetime.maxExpiresAt,
	];
}

function payloadDeleteAuthorityTuple(
	authority: TransientTaskOutcomePayloadDeleteAuthorityV1,
): readonly CanonicalRuntimeValue[] {
	return authority.reason === "published"
		? [
				"published",
				authority.publicationReceiptSha256,
				authority.foregroundSettlementCompletionEvidenceSha256,
				null,
				null,
				null,
			]
		: [
				"expired",
				null,
				payloadRecoveryAuthorityTuple(authority.recoveryAuthority),
				authority.recoveryAuthoritySha256,
				payloadLifetimeTuple(authority.recoveryLifetime),
				authority.observedAt,
			];
}

function payloadStoreKey(ref: TransientTaskOutcomePayloadRefV1): string {
	return `${ref.resultPublicationId}\u0000${ref.payloadRole}\u0000${ref.payloadId}`;
}

function payloadInspection(
	state: TransientTaskOutcomePayloadAvailableStateV1,
): TransientTaskOutcomePayloadAvailableInspectionV1 {
	return {
		state: "available",
		ref: state.ref,
		payloadDeleteId: state.payloadDeleteId,
		revision: state.revision,
		currentReceiptSha256: state.currentReceiptSha256,
		putReceiptSha256: state.putReceipt.receiptSha256,
		latestRetentionReceiptSha256: state.latestRetentionReceipt?.receiptSha256 ?? null,
		lifetime: state.lifetime,
	};
}

type PayloadRenewalHistoryEntryV1 = {
	readonly attempt: {
		readonly request: TransientTaskOutcomePayloadRetentionRequestV1;
		readonly openedAt: ISO8601;
	};
	readonly receipt: TransientTaskOutcomePayloadRetentionReceiptV1;
};

type PayloadAvailableRowV1 = TransientTaskOutcomePayloadAvailableStateV1 & {
	readonly renewalHistory: readonly PayloadRenewalHistoryEntryV1[];
};

type PayloadAttemptRowV1 =
	| (Omit<
			Extract<
				ConfidentialTransientTaskOutcomePayloadAttemptV1,
				{ readonly request: TransientTaskOutcomePayloadPutRequestV1 }
			>,
			"state"
	  > & {
			readonly state: "put_not_applied";
			readonly renewalHistory: readonly [];
	  })
	| (Omit<
			Extract<
				ConfidentialTransientTaskOutcomePayloadAttemptV1,
				{ readonly request: TransientTaskOutcomePayloadPutRequestV1 }
			>,
			"state"
	  > & {
			readonly state: "put_outcome_unknown";
			readonly renewalHistory: readonly [];
	  })
	| (Omit<
			Extract<
				ConfidentialTransientTaskOutcomePayloadAttemptV1,
				{ readonly request: TransientTaskOutcomePayloadRetentionRequestV1 }
			>,
			"state" | "prior"
	  > & {
			readonly state: "renewal_not_applied";
			readonly prior: PayloadAvailableRowV1;
			readonly renewalHistory: readonly PayloadRenewalHistoryEntryV1[];
	  })
	| (Omit<
			Extract<
				ConfidentialTransientTaskOutcomePayloadAttemptV1,
				{ readonly request: TransientTaskOutcomePayloadRetentionRequestV1 }
			>,
			"state" | "prior"
	  > & {
			readonly state: "renewal_outcome_unknown";
			readonly prior: PayloadAvailableRowV1;
			readonly renewalHistory: readonly PayloadRenewalHistoryEntryV1[];
	  })
	| (Omit<
			Extract<
				ConfidentialTransientTaskOutcomePayloadAttemptV1,
				{ readonly request: TransientTaskOutcomePayloadDeleteRequestV1 }
			>,
			"state" | "prior"
	  > & {
			readonly state: "delete_not_applied";
			readonly prior: PayloadAvailableRowV1;
			readonly renewalHistory: readonly PayloadRenewalHistoryEntryV1[];
	  })
	| (Omit<
			Extract<
				ConfidentialTransientTaskOutcomePayloadAttemptV1,
				{ readonly request: TransientTaskOutcomePayloadDeleteRequestV1 }
			>,
			"state" | "prior"
	  > & {
			readonly state: "delete_outcome_unknown";
			readonly prior: PayloadAvailableRowV1;
			readonly renewalHistory: readonly PayloadRenewalHistoryEntryV1[];
	  });

type PayloadDeletedRowV1 = Extract<
	ConfidentialTransientTaskOutcomePayloadStoreStateV1,
	{ readonly state: "deleted" }
> & {
	readonly renewalHistory: readonly PayloadRenewalHistoryEntryV1[];
};

type PayloadStoreRowV1 = PayloadAttemptRowV1 | PayloadAvailableRowV1 | PayloadDeletedRowV1;

type DecodedPayloadRowV1 =
	| { readonly status: "absent" }
	| { readonly status: "invalid" }
	| {
			readonly status: "present";
			readonly row: PayloadStoreRowV1;
			readonly bytesBase64: string | null;
	  };

function payloadTupleRef(tuple: readonly CanonicalRuntimeValue[]): Sha256Ref {
	return `sha256:${tupleSha256(tuple)}`;
}

function payloadPlainData(input: unknown, seen = new Set<object>()): input is CanonicalRuntimeValue {
	if (!proxyFreeData(input)) return false;
	if (
		input === null ||
		typeof input === "boolean" ||
		(typeof input === "string" && (input === "" || isWellFormedString(input))) ||
		(typeof input === "number" && Number.isSafeInteger(input))
	)
		return true;
	if (strictArray(input)) {
		if (seen.has(input)) return false;
		seen.add(input);
		try {
			return input.every(value => payloadPlainData(value, seen));
		} finally {
			seen.delete(input);
		}
	}
	if (input === null || typeof input !== "object" || seen.has(input)) return false;
	seen.add(input);
	try {
		const prototype = Object.getPrototypeOf(input);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const descriptors = Object.getOwnPropertyDescriptors(input);
		for (const key of Reflect.ownKeys(input)) {
			if (typeof key !== "string") return false;
			const descriptor = descriptors[key];
			if (!descriptor?.enumerable || !("value" in descriptor)) return false;
			if (!payloadPlainData(descriptor.value, seen)) return false;
		}
		return true;
	} catch {
		return false;
	} finally {
		seen.delete(input);
	}
}

function validPayloadRef(input: unknown): input is TransientTaskOutcomePayloadRefV1 {
	return (
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"resultPublicationId",
			"payloadRole",
			"payloadId",
			"mediaType",
			"byteLength",
			"payloadSha256",
		]) &&
		input.schemaVersion === 1 &&
		isWellFormedString(input.taskId) &&
		isWellFormedString(input.runId) &&
		isWellFormedString(input.resultPublicationId) &&
		(input.payloadRole === "pending" || input.payloadRole === "composed") &&
		isWellFormedString(input.payloadId) &&
		input.mediaType === "application/vnd.omp.task-outcome.v1+json" &&
		isSafeCount(input.byteLength) &&
		input.byteLength <= TRANSIENT_TASK_OUTCOME_PAYLOAD_BYTES_MAX_V1 &&
		isSha256Ref(input.payloadSha256)
	);
}

function payloadBytesMatch(ref: TransientTaskOutcomePayloadRefV1, bytesBase64: unknown): bytesBase64 is string {
	if (typeof bytesBase64 !== "string") return false;
	try {
		const bytes = Buffer.from(bytesBase64, "base64");
		return (
			bytes.toString("base64") === bytesBase64 &&
			bytes.byteLength === ref.byteLength &&
			`sha256:${createHash("sha256").update(bytes).digest("hex")}` === ref.payloadSha256
		);
	} catch {
		return false;
	}
}

function validPayloadControllerProof(input: unknown): input is TransientTaskControllerAuthorityProofV1 {
	return (
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"controllerId",
			"workspaceId",
			"controlHostId",
			"controllerEpoch",
			"fencingGeneration",
		]) &&
		input.schemaVersion === 1 &&
		isWellFormedString(input.taskId) &&
		isWellFormedString(input.runId) &&
		isWellFormedString(input.createId) &&
		isWellFormedString(input.controllerId) &&
		isWellFormedString(input.workspaceId) &&
		isWellFormedString(input.controlHostId) &&
		isSafeCount(input.controllerEpoch, 1) &&
		isSafeCount(input.fencingGeneration, 1)
	);
}

function validPayloadCleanupProof(input: unknown): input is TransientTaskCleanupAuthorityProofV1 {
	return (
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"cleanupId",
			"cleanupAuthorityId",
			"workspaceId",
			"controlHostId",
			"cleanupEpoch",
			"fencingGeneration",
		]) &&
		input.schemaVersion === 1 &&
		isWellFormedString(input.taskId) &&
		isWellFormedString(input.runId) &&
		isWellFormedString(input.cleanupId) &&
		isWellFormedString(input.cleanupAuthorityId) &&
		isWellFormedString(input.workspaceId) &&
		isWellFormedString(input.controlHostId) &&
		isSafeCount(input.cleanupEpoch, 1) &&
		isSafeCount(input.fencingGeneration, 1)
	);
}

function validPayloadTerminalEvidence(
	input: unknown,
): input is Extract<TransientTaskOutcomePayloadActiveRetentionAuthorityV1, { kind: "terminal" }>["terminalEvidence"] {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"evidenceId",
			"cleanupId",
			"cleanupAuthorityId",
			"workspaceId",
			"resultPublicationId",
			"publicationTargetId",
			"publicationTargetKey",
			"isolationCleanupId",
			"worktreePublicationId",
			"effectIdentityManifestSha256",
			"isolationNamespaceSha256",
			"isolationOwnerManifestSha256",
			"isolationCreatorDescriptorSha256",
			"worktreePublicationUse",
			"worktreePublicationAttemptSha256",
			"worktreePublication",
			"canonicalProviderTerminalEvidence",
			"canonicalProviderTerminalEvidenceSha256",
			"physicalCleanupBindingAccess",
			"physicalCleanupBindingRevision",
			"physicalCleanupBindingRenewalSequence",
			"physicalCleanupBindingReceiptSha256",
			"physicalCleanupBindingAuthoritySha256",
			"physicalCleanupBindingOpenRequestSha256",
			"cleanupDescriptorSha256",
			"cleanupClaim",
			"isolationCleanupReceipt",
			"isolationCleanupTerminalEvidence",
			"isolationCleanupTerminalEvidenceSha256",
			"publicationTargetReleaseReceipt",
			"publicationTargetBindingEvidence",
			"publicationTargetBindingEvidenceSha256",
			"resultPublicationTargetId",
			"pendingPayloadId",
			"pendingPayloadDeleteId",
			"composedPayloadId",
			"composedPayloadDeleteId",
			"pendingOutcomeSha256",
			"branch",
			"planSha256",
			"canonicalCommit",
			"checkpointAcknowledgement",
			"release",
			"preparedReplicaDelete",
			"replicaDelete",
			"canonicalDiscard",
			"tombstone",
			"completedAt",
			"evidenceSha256",
			"outcome",
			"captureReceipt",
			"captureReceiptSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!isWellFormedString(input.taskId) ||
		!isWellFormedString(input.runId) ||
		!isWellFormedString(input.evidenceId) ||
		!isWellFormedString(input.cleanupId) ||
		!isWellFormedString(input.cleanupAuthorityId) ||
		!isWellFormedString(input.workspaceId) ||
		!isWellFormedString(input.resultPublicationId) ||
		!isWellFormedString(input.publicationTargetId) ||
		!isWellFormedString(input.isolationCleanupId) ||
		!isWellFormedString(input.worktreePublicationId) ||
		!isSha256Ref(input.effectIdentityManifestSha256) ||
		!isSha256Hex(input.isolationNamespaceSha256) ||
		!isSha256Ref(input.isolationOwnerManifestSha256) ||
		!isSha256Ref(input.isolationCreatorDescriptorSha256) ||
		(input.worktreePublicationUse !== "published" && input.worktreePublicationUse !== "unused_non_success") ||
		(input.worktreePublicationAttemptSha256 !== null && !isSha256Ref(input.worktreePublicationAttemptSha256)) ||
		!isSha256Ref(input.canonicalProviderTerminalEvidenceSha256) ||
		(input.physicalCleanupBindingAccess !== "live" && input.physicalCleanupBindingAccess !== "cleanup_due") ||
		!isSafeCount(input.physicalCleanupBindingRevision, 1) ||
		!isSafeCount(input.physicalCleanupBindingRenewalSequence) ||
		!isSha256Ref(input.physicalCleanupBindingReceiptSha256) ||
		!isSha256Ref(input.physicalCleanupBindingAuthoritySha256) ||
		!isSha256Hex(input.physicalCleanupBindingOpenRequestSha256) ||
		!isSha256Ref(input.cleanupDescriptorSha256) ||
		!isSha256Ref(input.isolationCleanupTerminalEvidenceSha256) ||
		!isSha256Ref(input.publicationTargetBindingEvidenceSha256) ||
		!isWellFormedString(input.resultPublicationTargetId) ||
		!isWellFormedString(input.pendingPayloadId) ||
		!isWellFormedString(input.pendingPayloadDeleteId) ||
		!isWellFormedString(input.composedPayloadId) ||
		!isWellFormedString(input.composedPayloadDeleteId) ||
		!isSha256Ref(input.pendingOutcomeSha256) ||
		!isSha256Ref(input.planSha256) ||
		!isIso8601(input.completedAt) ||
		!isSha256Ref(input.evidenceSha256) ||
		!isOneOf(input.outcome, ["succeeded", "failed", "cancelled"]) ||
		!validateTransientTaskPublicationTargetKeyV1(input.publicationTargetKey) ||
		(input.worktreePublicationUse === "published"
			? !isSha256Ref(input.worktreePublicationAttemptSha256) ||
				!validLifecycleWorktreeReceipt(input.worktreePublication)
			: input.worktreePublicationUse !== "unused_non_success" ||
				input.worktreePublicationAttemptSha256 !== null ||
				input.worktreePublication !== null) ||
		!validLifecycleTerminalEvidence(input.canonicalProviderTerminalEvidence) ||
		!payloadPlainData(input.cleanupClaim) ||
		!payloadPlainData(input.isolationCleanupReceipt) ||
		!payloadPlainData(input.isolationCleanupTerminalEvidence) ||
		!payloadPlainData(input.publicationTargetReleaseReceipt) ||
		!payloadPlainData(input.publicationTargetBindingEvidence) ||
		!validLifecycleCleanupBranch(input.branch) ||
		(input.canonicalCommit !== null && !validLifecycleCanonicalCommit(input.canonicalCommit)) ||
		(input.checkpointAcknowledgement !== null &&
			!validLifecycleCheckpointAcknowledgement(input.checkpointAcknowledgement)) ||
		!validLifecycleRelease(input.release) ||
		!validLifecyclePreparedDelete(input.preparedReplicaDelete) ||
		!validLifecycleReplicaDelete(input.replicaDelete) ||
		!validLifecycleDiscardReceipt(input.canonicalDiscard) ||
		!validLifecycleTombstone(input.tombstone) ||
		!payloadPlainData(input.captureReceipt)
	)
		return false;
	const canonical = input.canonicalProviderTerminalEvidence;
	if (
		canonical.evidenceSha256 !== input.canonicalProviderTerminalEvidenceSha256 ||
		canonical.postTerminalCleanupEvidenceId !== input.evidenceId ||
		canonical.taskId !== input.taskId ||
		canonical.runId !== input.runId ||
		canonical.cleanupId !== input.cleanupId ||
		canonical.cleanupAuthorityId !== input.cleanupAuthorityId ||
		canonical.workspaceId !== input.workspaceId ||
		canonical.resultPublicationId !== input.resultPublicationId ||
		canonical.publicationTargetId !== input.publicationTargetId ||
		!exactJson(canonical.publicationTargetKey, input.publicationTargetKey) ||
		canonical.isolationCleanupId !== input.isolationCleanupId ||
		canonical.worktreePublicationId !== input.worktreePublicationId ||
		canonical.effectIdentityManifestSha256 !== input.effectIdentityManifestSha256 ||
		canonical.isolationNamespaceSha256 !== input.isolationNamespaceSha256 ||
		canonical.isolationOwnerManifestSha256 !== input.isolationOwnerManifestSha256 ||
		canonical.isolationCreatorDescriptorSha256 !== input.isolationCreatorDescriptorSha256 ||
		canonical.worktreePublicationUse !== input.worktreePublicationUse ||
		canonical.worktreePublicationAttemptSha256 !== input.worktreePublicationAttemptSha256 ||
		!exactJson(canonical.worktreePublication, input.worktreePublication) ||
		canonical.resultPublicationTargetId !== input.resultPublicationTargetId ||
		canonical.pendingPayloadId !== input.pendingPayloadId ||
		canonical.pendingPayloadDeleteId !== input.pendingPayloadDeleteId ||
		canonical.composedPayloadId !== input.composedPayloadId ||
		canonical.composedPayloadDeleteId !== input.composedPayloadDeleteId ||
		canonical.pendingOutcomeSha256 !== input.pendingOutcomeSha256 ||
		canonical.outcome !== input.outcome ||
		!exactJson(canonical.branch, input.branch) ||
		canonical.planSha256 !== input.planSha256 ||
		!exactJson(canonical.canonicalCommit, input.canonicalCommit) ||
		!exactJson(canonical.checkpointAcknowledgement, input.checkpointAcknowledgement) ||
		!exactJson(canonical.release, input.release) ||
		!exactJson(canonical.preparedReplicaDelete, input.preparedReplicaDelete) ||
		!exactJson(canonical.replicaDelete, input.replicaDelete) ||
		!exactJson(canonical.canonicalDiscard, input.canonicalDiscard) ||
		!exactJson(canonical.tombstone, input.tombstone)
	)
		return false;
	return input.outcome === "succeeded"
		? input.captureReceipt !== null &&
				typeof input.captureReceipt === "object" &&
				!Array.isArray(input.captureReceipt) &&
				payloadPlainData(input.captureReceipt) &&
				isSha256Ref(input.captureReceiptSha256) &&
				Object.getOwnPropertyDescriptor(input.captureReceipt, "receiptSha256")?.value === input.captureReceiptSha256
		: input.captureReceipt === null && input.captureReceiptSha256 === null;
}

function validPayloadActiveAuthority(input: unknown): input is TransientTaskOutcomePayloadActiveRetentionAuthorityV1 {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input)) return false;
	const kind = Object.getOwnPropertyDescriptor(input, "kind")?.value;
	const keys = [
		"schemaVersion",
		"taskId",
		"runId",
		"resultPublicationId",
		"payloadRole",
		"payloadId",
		"payloadDeleteId",
		"phase",
		"expectedAuthorityRevision",
		"kind",
		kind === "terminal" ? "terminalEvidence" : "proof",
	];
	if (
		!strictRecord(input, keys) ||
		input.schemaVersion !== 1 ||
		!isWellFormedString(input.taskId) ||
		!isWellFormedString(input.runId) ||
		!isWellFormedString(input.resultPublicationId) ||
		!isOneOf(input.payloadRole, ["pending", "composed"]) ||
		!isWellFormedString(input.payloadId) ||
		!isWellFormedString(input.payloadDeleteId) ||
		input.phase !== "active_task" ||
		!isSafeCount(input.expectedAuthorityRevision, 1) ||
		!isOneOf(kind, ["controller", "cleanup", "terminal"])
	)
		return false;
	if (kind === "controller") {
		return (
			input.payloadRole === "pending" &&
			validPayloadControllerProof(input.proof) &&
			input.proof.taskId === input.taskId &&
			input.proof.runId === input.runId
		);
	}
	if (kind === "cleanup") {
		return (
			input.payloadRole === "pending" &&
			validPayloadCleanupProof(input.proof) &&
			input.proof.taskId === input.taskId &&
			input.proof.runId === input.runId
		);
	}
	return (
		validPayloadTerminalEvidence(input.terminalEvidence) &&
		input.terminalEvidence.taskId === input.taskId &&
		input.terminalEvidence.runId === input.runId &&
		input.terminalEvidence.resultPublicationId === input.resultPublicationId &&
		(input.payloadRole === "pending"
			? input.terminalEvidence.pendingPayloadId === input.payloadId &&
				input.terminalEvidence.pendingPayloadDeleteId === input.payloadDeleteId
			: input.terminalEvidence.composedPayloadId === input.payloadId &&
				input.terminalEvidence.composedPayloadDeleteId === input.payloadDeleteId)
	);
}

function validPayloadRecoveryAuthority(input: unknown): input is TransientTaskOutcomePayloadRecoveryAuthorityV1 {
	return (
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"resultPublicationId",
			"payloadRole",
			"payloadId",
			"payloadDeleteId",
			"source",
			"pendingOutcomeReceiptSha256",
			"terminalEvidenceId",
			"terminalEvidenceSha256",
			"singleResultCompositionReceiptSha256",
		]) &&
		input.schemaVersion === 1 &&
		isWellFormedString(input.taskId) &&
		isWellFormedString(input.runId) &&
		isWellFormedString(input.resultPublicationId) &&
		isWellFormedString(input.payloadId) &&
		isWellFormedString(input.payloadDeleteId) &&
		isSha256Ref(input.pendingOutcomeReceiptSha256) &&
		isWellFormedString(input.terminalEvidenceId) &&
		isSha256Ref(input.terminalEvidenceSha256) &&
		((input.source === "pending_outcome" &&
			input.payloadRole === "pending" &&
			input.singleResultCompositionReceiptSha256 === null) ||
			(input.source === "composed_output" &&
				input.payloadRole === "composed" &&
				isSha256Ref(input.singleResultCompositionReceiptSha256)))
	);
}

function validPayloadRetentionAuthority(input: unknown): input is TransientTaskOutcomePayloadRetentionAuthorityV1 {
	if (validPayloadActiveAuthority(input)) return true;
	return (
		strictRecord(input, ["phase", "recoveryAuthority", "recoveryAuthoritySha256"]) &&
		input.phase === "recovery_retention" &&
		validPayloadRecoveryAuthority(input.recoveryAuthority) &&
		isSha256Ref(input.recoveryAuthoritySha256) &&
		payloadTupleRef(payloadRecoveryAuthorityTuple(input.recoveryAuthority)) === input.recoveryAuthoritySha256
	);
}

function validPayloadLifetime(input: unknown): input is TransientTaskOutcomePayloadLifetimeV1 {
	if (
		!strictRecord(input, [
			"phase",
			"renewBy",
			"expiresAt",
			"recoveryAuthoritySha256",
			"recoveryStartedAt",
			"maxExpiresAt",
		]) ||
		!isIso8601(input.renewBy) ||
		!isIso8601(input.expiresAt) ||
		Date.parse(input.renewBy) > Date.parse(input.expiresAt)
	)
		return false;
	if (input.phase === "active_task") {
		return input.recoveryAuthoritySha256 === null && input.recoveryStartedAt === null && input.maxExpiresAt === null;
	}
	return (
		input.phase === "recovery_retention" &&
		isSha256Ref(input.recoveryAuthoritySha256) &&
		isIso8601(input.recoveryStartedAt) &&
		isIso8601(input.maxExpiresAt) &&
		Date.parse(input.recoveryStartedAt) <= Date.parse(input.expiresAt) &&
		Date.parse(input.expiresAt) <= Date.parse(input.maxExpiresAt)
	);
}

function payloadAuthorityMatchesRef(
	ref: TransientTaskOutcomePayloadRefV1,
	payloadDeleteId: OperationId,
	authority: TransientTaskOutcomePayloadRetentionAuthorityV1,
): boolean {
	const bound = authority.phase === "active_task" ? authority : authority.recoveryAuthority;
	return (
		bound.taskId === ref.taskId &&
		bound.runId === ref.runId &&
		bound.resultPublicationId === ref.resultPublicationId &&
		bound.payloadRole === ref.payloadRole &&
		bound.payloadId === ref.payloadId &&
		bound.payloadDeleteId === payloadDeleteId
	);
}

function validPayloadTtl(retentionMs: unknown): retentionMs is number {
	return (
		isSafeCount(retentionMs, TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MIN_V1) &&
		retentionMs <= TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MAX_V1
	);
}

function validPayloadPutRequest(input: unknown): input is TransientTaskOutcomePayloadPutRequestV1 {
	return (
		strictRecord(input, ["ref", "payloadDeleteId", "bytesBase64", "retentionMs", "requestSha256", "authority"]) &&
		validPayloadRef(input.ref) &&
		isWellFormedString(input.payloadDeleteId) &&
		payloadBytesMatch(input.ref, input.bytesBase64) &&
		validPayloadTtl(input.retentionMs) &&
		isSha256Hex(input.requestSha256) &&
		validPayloadActiveAuthority(input.authority) &&
		payloadAuthorityMatchesRef(input.ref, input.payloadDeleteId, input.authority) &&
		((input.ref.payloadRole === "pending" &&
			input.authority.payloadRole === "pending" &&
			input.authority.kind === "controller") ||
			(input.ref.payloadRole === "composed" &&
				input.authority.payloadRole === "composed" &&
				input.authority.kind === "terminal")) &&
		tupleSha256([
			"omp-transient-task-outcome-payload-v1",
			"put",
			payloadRefTuple(input.ref),
			input.payloadDeleteId,
			input.bytesBase64,
			payloadActiveAuthorityTuple(input.authority),
			input.retentionMs,
		]) === input.requestSha256
	);
}

function validPayloadRetentionRequest(input: unknown): input is TransientTaskOutcomePayloadRetentionRequestV1 {
	return (
		strictRecord(input, [
			"ref",
			"payloadDeleteId",
			"retentionRenewalId",
			"expectedRevision",
			"expectedCurrentReceiptSha256",
			"expectedLifetime",
			"authority",
			"retentionMs",
			"requestSha256",
		]) &&
		validPayloadRef(input.ref) &&
		isWellFormedString(input.payloadDeleteId) &&
		isWellFormedString(input.retentionRenewalId) &&
		isSafeCount(input.expectedRevision, 1) &&
		isSha256Ref(input.expectedCurrentReceiptSha256) &&
		validPayloadLifetime(input.expectedLifetime) &&
		validPayloadRetentionAuthority(input.authority) &&
		payloadAuthorityMatchesRef(input.ref, input.payloadDeleteId, input.authority) &&
		validPayloadTtl(input.retentionMs) &&
		isSha256Hex(input.requestSha256) &&
		tupleSha256([
			"omp-transient-task-outcome-payload-v1",
			"renew",
			payloadRefTuple(input.ref),
			input.payloadDeleteId,
			input.retentionRenewalId,
			input.expectedRevision,
			input.expectedCurrentReceiptSha256,
			payloadLifetimeTuple(input.expectedLifetime),
			payloadRetentionAuthorityTuple(input.authority),
			input.retentionMs,
		]) === input.requestSha256
	);
}

function validPayloadDeleteAuthorityFields(
	input: Record<string, unknown>,
): input is Record<string, unknown> & TransientTaskOutcomePayloadDeleteAuthorityV1 {
	if (input.reason === "published") {
		return (
			isSha256Ref(input.publicationReceiptSha256) &&
			(input.foregroundSettlementCompletionEvidenceSha256 === null ||
				isSha256Ref(input.foregroundSettlementCompletionEvidenceSha256)) &&
			input.recoveryAuthority === null &&
			input.recoveryAuthoritySha256 === null &&
			input.recoveryLifetime === null &&
			input.observedAt === null
		);
	}
	return (
		input.reason === "expired" &&
		input.publicationReceiptSha256 === null &&
		input.foregroundSettlementCompletionEvidenceSha256 === null &&
		validPayloadRecoveryAuthority(input.recoveryAuthority) &&
		isSha256Ref(input.recoveryAuthoritySha256) &&
		payloadTupleRef(payloadRecoveryAuthorityTuple(input.recoveryAuthority)) === input.recoveryAuthoritySha256 &&
		validPayloadLifetime(input.recoveryLifetime) &&
		input.recoveryLifetime.phase === "recovery_retention" &&
		input.recoveryLifetime.recoveryAuthoritySha256 === input.recoveryAuthoritySha256 &&
		isIso8601(input.observedAt)
	);
}

function validPayloadDeleteAuthority(input: unknown): input is TransientTaskOutcomePayloadDeleteAuthorityV1 {
	return (
		strictRecord(input, [
			"reason",
			"publicationReceiptSha256",
			"foregroundSettlementCompletionEvidenceSha256",
			"recoveryAuthority",
			"recoveryAuthoritySha256",
			"recoveryLifetime",
			"observedAt",
		]) && validPayloadDeleteAuthorityFields(input)
	);
}

function validPayloadDeleteRequest(input: unknown): input is TransientTaskOutcomePayloadDeleteRequestV1 {
	return (
		strictRecord(input, [
			"ref",
			"payloadDeleteId",
			"expectedRevision",
			"expectedCurrentReceiptSha256",
			"expectedLifetime",
			"requestSha256",
			"reason",
			"publicationReceiptSha256",
			"foregroundSettlementCompletionEvidenceSha256",
			"recoveryAuthority",
			"recoveryAuthoritySha256",
			"recoveryLifetime",
			"observedAt",
		]) &&
		validPayloadRef(input.ref) &&
		isWellFormedString(input.payloadDeleteId) &&
		isSafeCount(input.expectedRevision, 1) &&
		isSha256Ref(input.expectedCurrentReceiptSha256) &&
		validPayloadLifetime(input.expectedLifetime) &&
		isSha256Hex(input.requestSha256) &&
		validPayloadDeleteAuthorityFields(input) &&
		tupleSha256([
			"omp-transient-task-outcome-payload-v1",
			"delete",
			payloadRefTuple(input.ref),
			input.payloadDeleteId,
			input.expectedRevision,
			input.expectedCurrentReceiptSha256,
			payloadLifetimeTuple(input.expectedLifetime),
			payloadDeleteAuthorityTuple(input),
		]) === input.requestSha256
	);
}

function validPayloadPutReceipt(input: unknown): input is TransientTaskOutcomePayloadPutReceiptV1 {
	return (
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"ref",
			"payloadDeleteId",
			"revision",
			"lifetime",
			"storedAt",
			"requestSha256",
			"receiptSha256",
			"authority",
		]) &&
		input.schemaVersion === 1 &&
		validPayloadRef(input.ref) &&
		input.taskId === input.ref.taskId &&
		input.runId === input.ref.runId &&
		isWellFormedString(input.payloadDeleteId) &&
		input.revision === 1 &&
		validPayloadLifetime(input.lifetime) &&
		input.lifetime.phase === "active_task" &&
		isIso8601(input.storedAt) &&
		validPayloadTtl(Date.parse(input.lifetime.expiresAt) - Date.parse(input.storedAt)) &&
		input.lifetime.renewBy ===
			renewalDeadline(input.storedAt, Date.parse(input.lifetime.expiresAt) - Date.parse(input.storedAt)) &&
		isSha256Hex(input.requestSha256) &&
		isSha256Ref(input.receiptSha256) &&
		validPayloadActiveAuthority(input.authority) &&
		payloadAuthorityMatchesRef(input.ref, input.payloadDeleteId, input.authority) &&
		((input.ref.payloadRole === "pending" && input.authority.kind === "controller") ||
			(input.ref.payloadRole === "composed" && input.authority.kind === "terminal")) &&
		payloadTupleRef([
			"omp-transient-task-outcome-payload-v1",
			"put_receipt",
			1,
			payloadRefTuple(input.ref),
			input.payloadDeleteId,
			1,
			payloadActiveAuthorityTuple(input.authority),
			payloadLifetimeTuple(input.lifetime),
			input.storedAt,
			input.requestSha256,
		]) === input.receiptSha256
	);
}

function validPayloadRetentionReceipt(input: unknown): input is TransientTaskOutcomePayloadRetentionReceiptV1 {
	return (
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"ref",
			"payloadDeleteId",
			"retentionRenewalId",
			"previousRevision",
			"revision",
			"previousReceiptSha256",
			"previousLifetime",
			"authority",
			"lifetime",
			"renewedAt",
			"requestSha256",
			"receiptSha256",
		]) &&
		input.schemaVersion === 1 &&
		validPayloadRef(input.ref) &&
		input.taskId === input.ref.taskId &&
		input.runId === input.ref.runId &&
		isWellFormedString(input.payloadDeleteId) &&
		isWellFormedString(input.retentionRenewalId) &&
		isSafeCount(input.previousRevision, 1) &&
		input.revision === input.previousRevision + 1 &&
		isSha256Ref(input.previousReceiptSha256) &&
		validPayloadLifetime(input.previousLifetime) &&
		validPayloadRetentionAuthority(input.authority) &&
		payloadAuthorityMatchesRef(input.ref, input.payloadDeleteId, input.authority) &&
		validPayloadLifetime(input.lifetime) &&
		isIso8601(input.renewedAt) &&
		validPayloadTtl(Date.parse(input.lifetime.expiresAt) - Date.parse(input.renewedAt)) &&
		input.lifetime.renewBy ===
			renewalDeadline(input.renewedAt, Date.parse(input.lifetime.expiresAt) - Date.parse(input.renewedAt)) &&
		((input.authority.phase === "active_task" &&
			input.previousLifetime.phase === "active_task" &&
			input.lifetime.phase === "active_task") ||
			(input.authority.phase === "recovery_retention" &&
				input.lifetime.phase === "recovery_retention" &&
				input.lifetime.recoveryAuthoritySha256 === input.authority.recoveryAuthoritySha256 &&
				(input.previousLifetime.phase === "active_task"
					? input.lifetime.recoveryStartedAt === input.renewedAt &&
						input.lifetime.maxExpiresAt ===
							addMilliseconds(input.renewedAt, TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MAX_V1)
					: input.previousLifetime.recoveryAuthoritySha256 === input.authority.recoveryAuthoritySha256 &&
						input.lifetime.recoveryStartedAt === input.previousLifetime.recoveryStartedAt &&
						input.lifetime.maxExpiresAt === input.previousLifetime.maxExpiresAt))) &&
		isSha256Hex(input.requestSha256) &&
		tupleSha256([
			"omp-transient-task-outcome-payload-v1",
			"renew",
			payloadRefTuple(input.ref),
			input.payloadDeleteId,
			input.retentionRenewalId,
			input.previousRevision,
			input.previousReceiptSha256,
			payloadLifetimeTuple(input.previousLifetime),
			payloadRetentionAuthorityTuple(input.authority),
			Date.parse(input.lifetime.expiresAt) - Date.parse(input.renewedAt),
		]) === input.requestSha256 &&
		isSha256Ref(input.receiptSha256) &&
		payloadTupleRef([
			"omp-transient-task-outcome-payload-v1",
			"renew_receipt",
			1,
			payloadRefTuple(input.ref),
			input.payloadDeleteId,
			input.retentionRenewalId,
			input.previousRevision,
			input.revision,
			input.previousReceiptSha256,
			payloadLifetimeTuple(input.previousLifetime),
			payloadRetentionAuthorityTuple(input.authority),
			payloadLifetimeTuple(input.lifetime),
			input.renewedAt,
			input.requestSha256,
		]) === input.receiptSha256
	);
}

function validPayloadDeleteReceipt(input: unknown): input is TransientTaskOutcomePayloadDeleteReceiptV1 {
	return (
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"ref",
			"payloadDeleteId",
			"previousRevision",
			"revision",
			"previousReceiptSha256",
			"previousLifetime",
			"reason",
			"publicationReceiptSha256",
			"foregroundSettlementCompletionEvidenceSha256",
			"recoveryAuthority",
			"recoveryAuthoritySha256",
			"recoveryLifetime",
			"observedAt",
			"deletedAt",
			"requestSha256",
			"receiptSha256",
		]) &&
		input.schemaVersion === 1 &&
		validPayloadRef(input.ref) &&
		input.taskId === input.ref.taskId &&
		input.runId === input.ref.runId &&
		isWellFormedString(input.payloadDeleteId) &&
		isSafeCount(input.previousRevision, 1) &&
		input.revision === input.previousRevision + 1 &&
		isSha256Ref(input.previousReceiptSha256) &&
		validPayloadLifetime(input.previousLifetime) &&
		validPayloadDeleteAuthorityFields(input) &&
		isIso8601(input.deletedAt) &&
		(input.reason === "published" ||
			(exactJson(input.recoveryLifetime, input.previousLifetime) &&
				Date.parse(input.observedAt) >= Date.parse(input.previousLifetime.expiresAt) &&
				Date.parse(input.deletedAt) >= Date.parse(input.observedAt))) &&
		isSha256Hex(input.requestSha256) &&
		tupleSha256([
			"omp-transient-task-outcome-payload-v1",
			"delete",
			payloadRefTuple(input.ref),
			input.payloadDeleteId,
			input.previousRevision,
			input.previousReceiptSha256,
			payloadLifetimeTuple(input.previousLifetime),
			payloadDeleteAuthorityTuple(input),
		]) === input.requestSha256 &&
		isSha256Ref(input.receiptSha256) &&
		payloadTupleRef([
			"omp-transient-task-outcome-payload-v1",
			"delete_receipt",
			1,
			payloadRefTuple(input.ref),
			input.payloadDeleteId,
			input.previousRevision,
			input.revision,
			input.previousReceiptSha256,
			payloadLifetimeTuple(input.previousLifetime),
			payloadDeleteAuthorityTuple(input),
			input.deletedAt,
			input.requestSha256,
		]) === input.receiptSha256
	);
}

type PayloadReceiptAnchorV1 = {
	readonly ref: TransientTaskOutcomePayloadRefV1;
	readonly payloadDeleteId: OperationId;
	readonly revision: number;
	readonly receiptSha256: Sha256Ref;
	readonly lifetime: TransientTaskOutcomePayloadLifetimeV1;
};

function payloadRetentionReceiptFromAttempt(
	previous: PayloadReceiptAnchorV1,
	attempt: PayloadRenewalHistoryEntryV1["attempt"],
): TransientTaskOutcomePayloadRetentionReceiptV1 | null {
	const { request, openedAt } = attempt;
	if (
		!exactJson(request.ref, previous.ref) ||
		request.payloadDeleteId !== previous.payloadDeleteId ||
		request.expectedRevision !== previous.revision ||
		request.expectedCurrentReceiptSha256 !== previous.receiptSha256 ||
		!exactJson(request.expectedLifetime, previous.lifetime)
	)
		return null;
	let lifetime: TransientTaskOutcomePayloadLifetimeV1;
	if (request.authority.phase === "recovery_retention") {
		if (
			previous.lifetime.phase === "recovery_retention" &&
			previous.lifetime.recoveryAuthoritySha256 !== request.authority.recoveryAuthoritySha256
		)
			return null;
		const recoveryStartedAt =
			previous.lifetime.phase === "recovery_retention" ? previous.lifetime.recoveryStartedAt : openedAt;
		const maxExpiresAt =
			previous.lifetime.phase === "recovery_retention"
				? previous.lifetime.maxExpiresAt
				: addMilliseconds(openedAt, TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MAX_V1);
		const expiresAt = addMilliseconds(openedAt, request.retentionMs);
		if (Date.parse(expiresAt) > Date.parse(maxExpiresAt)) return null;
		lifetime = {
			phase: "recovery_retention",
			renewBy: renewalDeadline(openedAt, request.retentionMs),
			expiresAt,
			recoveryAuthoritySha256: request.authority.recoveryAuthoritySha256,
			recoveryStartedAt,
			maxExpiresAt,
		};
	} else {
		if (previous.lifetime.phase !== "active_task") return null;
		lifetime = {
			phase: "active_task",
			renewBy: renewalDeadline(openedAt, request.retentionMs),
			expiresAt: addMilliseconds(openedAt, request.retentionMs),
			recoveryAuthoritySha256: null,
			recoveryStartedAt: null,
			maxExpiresAt: null,
		};
	}
	const receiptCore = {
		schemaVersion: 1 as const,
		taskId: request.ref.taskId,
		runId: request.ref.runId,
		ref: request.ref,
		payloadDeleteId: request.payloadDeleteId,
		retentionRenewalId: request.retentionRenewalId,
		previousRevision: previous.revision,
		revision: previous.revision + 1,
		previousReceiptSha256: previous.receiptSha256,
		previousLifetime: previous.lifetime,
		authority: request.authority,
		lifetime,
		renewedAt: openedAt,
		requestSha256: request.requestSha256,
	};
	return {
		...receiptCore,
		receiptSha256: payloadTupleRef([
			"omp-transient-task-outcome-payload-v1",
			"renew_receipt",
			1,
			payloadRefTuple(request.ref),
			request.payloadDeleteId,
			request.retentionRenewalId,
			previous.revision,
			previous.revision + 1,
			previous.receiptSha256,
			payloadLifetimeTuple(previous.lifetime),
			payloadRetentionAuthorityTuple(request.authority),
			payloadLifetimeTuple(lifetime),
			openedAt,
			request.requestSha256,
		]),
	};
}

function payloadPutReceiptFromRequest(
	request: TransientTaskOutcomePayloadPutRequestV1,
	lifetime: Extract<TransientTaskOutcomePayloadLifetimeV1, { readonly phase: "active_task" }>,
	storedAt: ISO8601,
): TransientTaskOutcomePayloadPutReceiptV1 {
	const receiptCore: Omit<TransientTaskOutcomePayloadPutReceiptV1, "ref" | "authority"> = {
		schemaVersion: 1,
		taskId: request.ref.taskId,
		runId: request.ref.runId,
		payloadDeleteId: request.payloadDeleteId,
		revision: 1,
		lifetime,
		storedAt,
		requestSha256: request.requestSha256,
		receiptSha256: payloadTupleRef([
			"omp-transient-task-outcome-payload-v1",
			"put_receipt",
			1,
			payloadRefTuple(request.ref),
			request.payloadDeleteId,
			1,
			payloadActiveAuthorityTuple(request.authority),
			payloadLifetimeTuple(lifetime),
			storedAt,
			request.requestSha256,
		]),
	};
	if (request.ref.payloadRole === "pending") {
		if (request.authority.payloadRole !== "pending" || request.authority.kind !== "controller")
			throw new Error("Invalid pending outcome payload put authority");
		return { ...receiptCore, ref: request.ref, authority: request.authority };
	}
	if (request.authority.payloadRole !== "composed" || request.authority.kind !== "terminal")
		throw new Error("Invalid composed outcome payload put authority");
	return { ...receiptCore, ref: request.ref, authority: request.authority };
}

function validPayloadRenewalHistory(
	input: unknown,
	putReceipt: TransientTaskOutcomePayloadPutReceiptV1,
	retentionNamespaceId: OperationId | null,
): input is readonly PayloadRenewalHistoryEntryV1[] {
	if (!strictArray(input)) return false;
	let previous: PayloadReceiptAnchorV1 = {
		ref: putReceipt.ref,
		payloadDeleteId: putReceipt.payloadDeleteId,
		revision: putReceipt.revision,
		receiptSha256: putReceipt.receiptSha256,
		lifetime: putReceipt.lifetime,
	};
	for (const entry of input) {
		if (
			!strictRecord(entry, ["attempt", "receipt"]) ||
			!strictRecord(entry.attempt, ["request", "openedAt"]) ||
			!validPayloadRetentionRequest(entry.attempt.request) ||
			!isIso8601(entry.attempt.openedAt) ||
			retentionNamespaceId === null ||
			entry.attempt.request.retentionRenewalId !==
				derivedPayloadRetentionId(
					retentionNamespaceId,
					entry.attempt.request.ref.payloadRole,
					entry.attempt.request.expectedRevision,
				)
		)
			return false;
		const attempt = { request: entry.attempt.request, openedAt: entry.attempt.openedAt };
		const expected = payloadRetentionReceiptFromAttempt(previous, attempt);
		if (expected === null || !validPayloadRetentionReceipt(entry.receipt) || !exactJson(entry.receipt, expected))
			return false;
		previous = {
			ref: expected.ref,
			payloadDeleteId: expected.payloadDeleteId,
			revision: expected.revision,
			receiptSha256: expected.receiptSha256,
			lifetime: expected.lifetime,
		};
	}
	return true;
}

function validPayloadAvailableState(
	input: unknown,
	retentionNamespaceId: OperationId | null,
): input is PayloadAvailableRowV1 {
	if (
		!strictRecord(input, [
			"state",
			"ref",
			"payloadDeleteId",
			"revision",
			"currentReceiptSha256",
			"putReceipt",
			"renewalHistory",
			"latestRetentionReceipt",
			"lifetime",
		]) ||
		input.state !== "available" ||
		!validPayloadRef(input.ref) ||
		!isWellFormedString(input.payloadDeleteId) ||
		!isSafeCount(input.revision, 1) ||
		!isSha256Ref(input.currentReceiptSha256) ||
		!validPayloadPutReceipt(input.putReceipt) ||
		!exactJson(input.putReceipt.ref, input.ref) ||
		input.putReceipt.payloadDeleteId !== input.payloadDeleteId ||
		!validPayloadRenewalHistory(input.renewalHistory, input.putReceipt, retentionNamespaceId) ||
		!validPayloadLifetime(input.lifetime)
	)
		return false;
	const latest = input.renewalHistory[input.renewalHistory.length - 1]?.receipt ?? null;
	return (
		input.revision === (latest?.revision ?? input.putReceipt.revision) &&
		input.currentReceiptSha256 === (latest?.receiptSha256 ?? input.putReceipt.receiptSha256) &&
		exactJson(input.latestRetentionReceipt, latest) &&
		exactJson(input.lifetime, latest?.lifetime ?? input.putReceipt.lifetime)
	);
}

function payloadRow(input: unknown, retentionNamespaceId: OperationId | null): DecodedPayloadRowV1 {
	if (input === undefined) return { status: "absent" };
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input))
		return { status: "invalid" };
	const rowState = Object.getOwnPropertyDescriptor(input, "state")?.value;
	if (rowState === "available") {
		if (
			!strictRecord(input, [
				"state",
				"ref",
				"payloadDeleteId",
				"revision",
				"currentReceiptSha256",
				"putReceipt",
				"renewalHistory",
				"latestRetentionReceipt",
				"lifetime",
				"bytesBase64",
			])
		)
			return { status: "invalid" };
		const core = {
			state: input.state,
			ref: input.ref,
			payloadDeleteId: input.payloadDeleteId,
			revision: input.revision,
			currentReceiptSha256: input.currentReceiptSha256,
			putReceipt: input.putReceipt,
			renewalHistory: input.renewalHistory,
			latestRetentionReceipt: input.latestRetentionReceipt,
			lifetime: input.lifetime,
		};
		if (
			!validPayloadAvailableState(core, retentionNamespaceId) ||
			!payloadBytesMatch(core.ref, input.bytesBase64) ||
			tupleSha256([
				"omp-transient-task-outcome-payload-v1",
				"put",
				payloadRefTuple(core.ref),
				core.payloadDeleteId,
				input.bytesBase64,
				payloadActiveAuthorityTuple(core.putReceipt.authority),
				Date.parse(core.putReceipt.lifetime.expiresAt) - Date.parse(core.putReceipt.storedAt),
			]) !== core.putReceipt.requestSha256
		)
			return { status: "invalid" };
		const row: PayloadAvailableRowV1 = core;
		return {
			status: "present",
			row,
			bytesBase64: input.bytesBase64,
		};
	}
	if (rowState === "put_not_applied" || rowState === "put_outcome_unknown") {
		if (
			!strictRecord(input, ["state", "request", "openedAt", "renewalHistory"]) ||
			!validPayloadPutRequest(input.request) ||
			!isIso8601(input.openedAt) ||
			!strictArray(input.renewalHistory) ||
			input.renewalHistory.length !== 0
		)
			return { status: "invalid" };
		const row: PayloadAttemptRowV1 = {
			state: rowState,
			request: input.request,
			openedAt: input.openedAt,
			renewalHistory: [],
		};
		return { status: "present", row, bytesBase64: null };
	}
	if (rowState === "renewal_not_applied" || rowState === "renewal_outcome_unknown") {
		if (
			!strictRecord(input, ["state", "prior", "request", "openedAt", "renewalHistory", "bytesBase64"]) ||
			!validPayloadAvailableState(input.prior, retentionNamespaceId) ||
			!validPayloadRetentionRequest(input.request) ||
			retentionNamespaceId === null ||
			input.request.retentionRenewalId !==
				derivedPayloadRetentionId(
					retentionNamespaceId,
					input.request.ref.payloadRole,
					input.request.expectedRevision,
				) ||
			!strictArray(input.renewalHistory) ||
			!exactJson(input.renewalHistory, input.prior.renewalHistory) ||
			!isIso8601(input.openedAt) ||
			!payloadBytesMatch(input.prior.ref, input.bytesBase64) ||
			tupleSha256([
				"omp-transient-task-outcome-payload-v1",
				"put",
				payloadRefTuple(input.prior.ref),
				input.prior.payloadDeleteId,
				input.bytesBase64,
				payloadActiveAuthorityTuple(input.prior.putReceipt.authority),
				Date.parse(input.prior.putReceipt.lifetime.expiresAt) - Date.parse(input.prior.putReceipt.storedAt),
			]) !== input.prior.putReceipt.requestSha256 ||
			!exactJson(input.request.ref, input.prior.ref) ||
			input.request.payloadDeleteId !== input.prior.payloadDeleteId ||
			input.request.expectedRevision !== input.prior.revision ||
			input.request.expectedCurrentReceiptSha256 !== input.prior.currentReceiptSha256 ||
			!exactJson(input.request.expectedLifetime, input.prior.lifetime)
		)
			return { status: "invalid" };
		const row: PayloadAttemptRowV1 = {
			state: rowState,
			prior: input.prior,
			request: input.request,
			openedAt: input.openedAt,
			renewalHistory: input.prior.renewalHistory,
		};
		return { status: "present", row, bytesBase64: input.bytesBase64 };
	}
	if (rowState === "delete_not_applied" || rowState === "delete_outcome_unknown") {
		if (
			!strictRecord(input, ["state", "prior", "request", "openedAt", "renewalHistory"]) ||
			!validPayloadAvailableState(input.prior, retentionNamespaceId) ||
			!validPayloadDeleteRequest(input.request) ||
			!strictArray(input.renewalHistory) ||
			!exactJson(input.renewalHistory, input.prior.renewalHistory) ||
			!isIso8601(input.openedAt) ||
			!exactJson(input.request.ref, input.prior.ref) ||
			input.request.payloadDeleteId !== input.prior.payloadDeleteId ||
			input.request.expectedRevision !== input.prior.revision ||
			input.request.expectedCurrentReceiptSha256 !== input.prior.currentReceiptSha256 ||
			!exactJson(input.request.expectedLifetime, input.prior.lifetime)
		)
			return { status: "invalid" };
		const row: PayloadAttemptRowV1 = {
			state: rowState,
			prior: input.prior,
			request: input.request,
			openedAt: input.openedAt,
			renewalHistory: input.prior.renewalHistory,
		};
		return { status: "present", row, bytesBase64: null };
	}
	if (rowState === "deleted") {
		if (
			!strictRecord(input, [
				"state",
				"ref",
				"payloadDeleteId",
				"putReceipt",
				"renewalHistory",
				"latestRetentionReceipt",
				"deleteReceipt",
			]) ||
			!validPayloadRef(input.ref) ||
			!isWellFormedString(input.payloadDeleteId) ||
			!validPayloadPutReceipt(input.putReceipt) ||
			!exactJson(input.putReceipt.ref, input.ref) ||
			input.putReceipt.payloadDeleteId !== input.payloadDeleteId ||
			!validPayloadRenewalHistory(input.renewalHistory, input.putReceipt, retentionNamespaceId) ||
			!validPayloadDeleteReceipt(input.deleteReceipt) ||
			!exactJson(input.deleteReceipt.ref, input.ref) ||
			input.deleteReceipt.payloadDeleteId !== input.payloadDeleteId
		)
			return { status: "invalid" };
		const latest = input.renewalHistory[input.renewalHistory.length - 1]?.receipt ?? null;
		const latestRevision = latest?.revision ?? input.putReceipt.revision;
		const latestReceiptSha256 = latest?.receiptSha256 ?? input.putReceipt.receiptSha256;
		const latestLifetime = latest?.lifetime ?? input.putReceipt.lifetime;
		if (
			!exactJson(input.latestRetentionReceipt, latest) ||
			input.deleteReceipt.previousRevision !== latestRevision ||
			input.deleteReceipt.previousReceiptSha256 !== latestReceiptSha256 ||
			!exactJson(input.deleteReceipt.previousLifetime, latestLifetime)
		)
			return { status: "invalid" };
		const row: PayloadDeletedRowV1 = {
			state: "deleted",
			ref: input.ref,
			payloadDeleteId: input.payloadDeleteId,
			putReceipt: input.putReceipt,
			latestRetentionReceipt: latest,
			deleteReceipt: input.deleteReceipt,
			renewalHistory: input.renewalHistory,
		};
		return { status: "present", row, bytesBase64: null };
	}
	return { status: "invalid" };
}

function isPayloadAttempt(row: PayloadStoreRowV1): row is PayloadAttemptRowV1 {
	return (
		row.state === "put_not_applied" ||
		row.state === "put_outcome_unknown" ||
		row.state === "renewal_not_applied" ||
		row.state === "renewal_outcome_unknown" ||
		row.state === "delete_not_applied" ||
		row.state === "delete_outcome_unknown"
	);
}

function payloadAvailableStateProjection(row: PayloadAvailableRowV1): TransientTaskOutcomePayloadAvailableStateV1 {
	return {
		state: "available",
		ref: row.ref,
		payloadDeleteId: row.payloadDeleteId,
		revision: row.revision,
		currentReceiptSha256: row.currentReceiptSha256,
		putReceipt: row.putReceipt,
		latestRetentionReceipt: row.latestRetentionReceipt,
		lifetime: row.lifetime,
	};
}

function payloadAttemptProjection(row: PayloadAttemptRowV1): ConfidentialTransientTaskOutcomePayloadAttemptV1 {
	if (row.state === "put_not_applied" || row.state === "put_outcome_unknown") {
		return { state: row.state, request: row.request, openedAt: row.openedAt };
	}
	if (row.state === "renewal_not_applied" || row.state === "renewal_outcome_unknown") {
		return {
			state: row.state,
			prior: payloadAvailableStateProjection(row.prior),
			request: row.request,
			openedAt: row.openedAt,
		};
	}
	return {
		state: row.state,
		prior: payloadAvailableStateProjection(row.prior),
		request: row.request,
		openedAt: row.openedAt,
	};
}

function derivedPayloadRetentionId(
	namespaceId: OperationId,
	payloadRole: TransientTaskOutcomePayloadRefV1["payloadRole"],
	expectedRevision: number,
): OperationId {
	return `ttei1_${tupleSha256([
		"omp-transient-task-effect-identity-v1",
		"derive",
		1,
		namespaceId,
		payloadRole === "pending" ? "pending_renewal" : "composed_renewal",
		["ordinal", expectedRevision],
	])}`;
}

export interface RuntimeControllerDependenciesV1 extends TransientTaskRuntimeStoreFacadeV1 {
	readonly canonicalWorkspaceStore: CanonicalWorkspaceStore;
	readonly runtimeAttachmentStore: RuntimeAttachmentStore;
	readonly providerRegistry: RuntimeProviderRegistry;
	readonly scheduler: RuntimeScheduler;
}

const RESULT_STORE_SHA256_HEX_V1 = /^[0-9a-f]{64}$/;
const RESULT_STORE_SHA256_REF_V1 = /^sha256:[0-9a-f]{64}$/;

function validResultStoreIdentity(input: unknown): input is string {
	return typeof input === "string" && input.length > 0;
}

function validResultStoreInteger(input: unknown, minimum = 0): input is number {
	return typeof input === "number" && Number.isSafeInteger(input) && !Object.is(input, -0) && input >= minimum;
}

function validResultStoreIso8601(input: unknown): input is ISO8601 {
	return (
		typeof input === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input) &&
		new Date(input).toISOString() === input
	);
}

function validResultStoreSha256Hex(input: unknown): input is Sha256Hex {
	return typeof input === "string" && RESULT_STORE_SHA256_HEX_V1.test(input);
}

function validResultStoreSha256Ref(input: unknown): input is Sha256Ref {
	return typeof input === "string" && RESULT_STORE_SHA256_REF_V1.test(input);
}

function validResultTargetKey(input: unknown): input is TransientTaskResultPublicationTargetKeyV1 {
	return (
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
		]) &&
		input.schemaVersion === 1 &&
		validResultStoreIdentity(input.taskId) &&
		validResultStoreIdentity(input.runId) &&
		validResultStoreIdentity(input.createId) &&
		validResultStoreIdentity(input.resultPublicationId) &&
		validResultStoreIdentity(input.resultPublicationTargetId) &&
		validResultStoreIdentity(input.resultPublicationTargetCleanupId)
	);
}

function resultTargetKeyMatches(
	left: TransientTaskResultPublicationTargetKeyV1,
	right: TransientTaskResultPublicationTargetKeyV1,
): boolean {
	return exactJson(resultTargetKeyTuple(left), resultTargetKeyTuple(right));
}

function validResultTargetRoute(input: unknown): boolean {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input)) return false;
	const kind = Object.getOwnPropertyDescriptor(input, "kind")?.value;
	if (kind === "foreground_tool_call") {
		return (
			strictRecord(input, ["kind", "parentSessionId", "toolCallId", "sinkLocator", "sinkAuthorization"]) &&
			validResultStoreIdentity(input.parentSessionId) &&
			validResultStoreIdentity(input.toolCallId) &&
			validResultStoreIdentity(input.sinkLocator) &&
			(input.sinkAuthorization === null || typeof input.sinkAuthorization === "string")
		);
	}
	return (
		kind === "owner_routed_async_result" &&
		strictRecord(input, ["kind", "ownerAgentId", "jobId", "deliveryEpoch", "sinkLocator", "sinkAuthorization"]) &&
		validResultStoreIdentity(input.ownerAgentId) &&
		validResultStoreIdentity(input.jobId) &&
		validResultStoreInteger(input.deliveryEpoch) &&
		validResultStoreIdentity(input.sinkLocator) &&
		(input.sinkAuthorization === null || typeof input.sinkAuthorization === "string")
	);
}

function validResultTargetBinding(input: unknown): input is ConfidentialTransientTaskResultPublicationBindingV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"route",
		])
	)
		return false;
	const key = {
		schemaVersion: input.schemaVersion,
		taskId: input.taskId,
		runId: input.runId,
		createId: input.createId,
		resultPublicationId: input.resultPublicationId,
		resultPublicationTargetId: input.resultPublicationTargetId,
		resultPublicationTargetCleanupId: input.resultPublicationTargetCleanupId,
	};
	return validResultTargetKey(key) && validResultTargetRoute(input.route);
}

function validResultTargetControllerProof(input: unknown): input is TransientTaskControllerAuthorityProofV1 {
	return (
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"controllerId",
			"workspaceId",
			"controlHostId",
			"controllerEpoch",
			"fencingGeneration",
		]) &&
		input.schemaVersion === 1 &&
		validResultStoreIdentity(input.taskId) &&
		validResultStoreIdentity(input.runId) &&
		validResultStoreIdentity(input.createId) &&
		validResultStoreIdentity(input.controllerId) &&
		validResultStoreIdentity(input.workspaceId) &&
		validResultStoreIdentity(input.controlHostId) &&
		validResultStoreInteger(input.controllerEpoch, 1) &&
		validResultStoreInteger(input.fencingGeneration, 1)
	);
}

function validResultTargetCleanupProof(input: unknown): input is TransientTaskCleanupAuthorityProofV1 {
	return (
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"cleanupId",
			"cleanupAuthorityId",
			"workspaceId",
			"controlHostId",
			"cleanupEpoch",
			"fencingGeneration",
		]) &&
		input.schemaVersion === 1 &&
		validResultStoreIdentity(input.taskId) &&
		validResultStoreIdentity(input.runId) &&
		validResultStoreIdentity(input.cleanupId) &&
		validResultStoreIdentity(input.cleanupAuthorityId) &&
		validResultStoreIdentity(input.workspaceId) &&
		validResultStoreIdentity(input.controlHostId) &&
		validResultStoreInteger(input.cleanupEpoch, 1) &&
		validResultStoreInteger(input.fencingGeneration, 1)
	);
}

function validResultTargetAuthority(
	input: unknown,
): input is ConfidentialTransientTaskResultPublicationTargetAuthorityV1 {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input)) return false;
	const kind = Object.getOwnPropertyDescriptor(input, "kind")?.value;
	if (kind === "controller")
		return strictRecord(input, ["kind", "proof"]) && validResultTargetControllerProof(input.proof);
	if (kind === "cleanup") return strictRecord(input, ["kind", "proof"]) && validResultTargetCleanupProof(input.proof);
	return (
		kind === "terminal" &&
		strictRecord(input, ["kind", "terminalEvidenceId", "terminalEvidenceSha256"]) &&
		validResultStoreIdentity(input.terminalEvidenceId) &&
		validResultStoreSha256Ref(input.terminalEvidenceSha256)
	);
}

function validResultTargetManifest(input: unknown, key: TransientTaskResultPublicationTargetKeyV1): boolean {
	return (
		strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"worktreePublicationId",
			"captureMemberNamespaceId",
			"captureMaterializationNamespaceId",
			"messageGenerationNamespaceId",
			"captureSubeffectNamespaceId",
			"semanticMergeStepNamespaceId",
			"semanticMergeSubeffectNamespaceId",
			"bindingOperationNamespaceId",
			"payloadRetentionNamespaceId",
			"parentDeliveryNamespaceId",
			"manifestSha256",
		]) &&
		input.schemaVersion === 1 &&
		input.taskId === key.taskId &&
		input.runId === key.runId &&
		[
			input.worktreePublicationId,
			input.captureMemberNamespaceId,
			input.captureMaterializationNamespaceId,
			input.messageGenerationNamespaceId,
			input.captureSubeffectNamespaceId,
			input.semanticMergeStepNamespaceId,
			input.semanticMergeSubeffectNamespaceId,
			input.bindingOperationNamespaceId,
			input.payloadRetentionNamespaceId,
			input.parentDeliveryNamespaceId,
		].every(validResultStoreIdentity) &&
		validResultStoreSha256Ref(input.manifestSha256)
	);
}

function resultTargetLifecycleKeyMatches(
	state: TransientTaskRuntimeStateV1,
	key: TransientTaskResultPublicationTargetKeyV1,
): boolean {
	const current = state.authority;
	return (
		current !== null &&
		current.taskId === key.taskId &&
		current.runId === key.runId &&
		current.createId === key.createId &&
		current.resultPublicationId === key.resultPublicationId &&
		current.resultPublicationTargetId === key.resultPublicationTargetId &&
		current.resultPublicationTargetCleanupId === key.resultPublicationTargetCleanupId &&
		validResultStoreInteger(current.revision) &&
		validResultTargetManifest(current.effectIdentityManifest, key)
	);
}

function resultTargetLifecycleMatches(
	state: TransientTaskRuntimeStateV1,
	key: TransientTaskResultPublicationTargetKeyV1,
	authority: ConfidentialTransientTaskResultPublicationTargetAuthorityV1,
): boolean {
	const current = state.authority;
	if (!resultTargetLifecycleKeyMatches(state, key) || current === null) return false;
	if (authority.kind === "controller") {
		return (
			current.state !== "cleanup" &&
			current.state !== "deleted" &&
			current.state !== "discarded" &&
			current.controller !== null &&
			authority.proof.taskId === key.taskId &&
			authority.proof.runId === key.runId &&
			authority.proof.createId === key.createId &&
			authority.proof.workspaceId === current.workspaceId &&
			controllerProofMatches(current.controller.proof, authority.proof)
		);
	}
	if (authority.kind === "cleanup") {
		return (
			current.state === "cleanup" &&
			authority.proof.taskId === key.taskId &&
			authority.proof.runId === key.runId &&
			authority.proof.workspaceId === current.workspaceId &&
			authority.proof.cleanupAuthorityId === current.cleanup.plan.cleanupAuthorityId &&
			cleanupProofMatches(current.cleanup.authority.proof, authority.proof)
		);
	}
	return (
		(current.state === "deleted" || current.state === "discarded") &&
		current.cleanup.progress.evidence.postTerminalCleanupEvidenceId === authority.terminalEvidenceId &&
		current.cleanup.progress.evidence.evidenceSha256 === authority.terminalEvidenceSha256
	);
}
function resultTargetKeyTuple(key: TransientTaskResultPublicationTargetKeyV1): readonly CanonicalRuntimeValue[] {
	return [
		key.taskId,
		key.runId,
		key.createId,
		key.resultPublicationId,
		key.resultPublicationTargetId,
		key.resultPublicationTargetCleanupId,
	];
}

function resultTargetRouteTuple(
	binding: ConfidentialTransientTaskResultPublicationBindingV1,
): readonly CanonicalRuntimeValue[] {
	return binding.route.kind === "foreground_tool_call"
		? [
				"foreground_tool_call",
				binding.route.parentSessionId,
				binding.route.toolCallId,
				binding.route.sinkLocator,
				binding.route.sinkAuthorization,
			]
		: [
				"owner_routed_async_result",
				binding.route.ownerAgentId,
				binding.route.jobId,
				binding.route.deliveryEpoch,
				binding.route.sinkLocator,
				binding.route.sinkAuthorization,
			];
}

function resultTargetAuthorityTuple(
	authority: ConfidentialTransientTaskResultPublicationTargetAuthorityV1,
): readonly CanonicalRuntimeValue[] {
	if (authority.kind === "controller") return ["controller", controllerProofTuple(authority.proof)];
	if (authority.kind === "cleanup") return ["cleanup", cleanupProofTuple(authority.proof)];
	return ["terminal", authority.terminalEvidenceId, authority.terminalEvidenceSha256];
}

function resultTargetLifetimeTuple(
	lifetime: TransientTaskResultPublicationTargetLifetimeV1,
): readonly CanonicalRuntimeValue[] {
	return [
		lifetime.phase,
		lifetime.recoveryAuthoritySha256,
		lifetime.recoveryRetentionStartedAt,
		lifetime.maxExpiresAt,
	];
}
function resultTargetRecoveryAuthorityTuple(
	authority: TransientTaskResultPublicationTargetRecoveryAuthorityV1,
): readonly CanonicalRuntimeValue[] {
	return [
		authority.kind,
		authority.pendingOutcomeReceiptSha256,
		authority.terminalEvidenceId,
		authority.terminalEvidenceSha256,
		authority.singleResultCompositionReceiptSha256,
	];
}

function resultTargetRenewalModeTuple(
	mode: Parameters<TransientTaskResultPublicationTargetStoreV1["renew"]>[0]["mode"],
): readonly CanonicalRuntimeValue[] {
	if (mode.kind === "active_task") return ["active_task", null, null, null];
	if (mode.kind === "freeze_recovery_retention") {
		return [
			"freeze_recovery_retention",
			resultTargetRecoveryAuthorityTuple(mode.recoveryAuthority),
			mode.recoveryAuthoritySha256,
			mode.recoveryRetentionMs,
		];
	}
	return ["recovery_retention", null, mode.recoveryAuthoritySha256, null];
}

function validResultTargetLifetime(input: unknown): input is TransientTaskResultPublicationTargetLifetimeV1 {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input)) return false;
	const phase = Object.getOwnPropertyDescriptor(input, "phase")?.value;
	if (phase === "active_task") {
		return (
			strictRecord(input, ["phase", "recoveryAuthoritySha256", "recoveryRetentionStartedAt", "maxExpiresAt"]) &&
			input.recoveryAuthoritySha256 === null &&
			input.recoveryRetentionStartedAt === null &&
			input.maxExpiresAt === null
		);
	}
	return (
		phase === "recovery_retention" &&
		strictRecord(input, ["phase", "recoveryAuthoritySha256", "recoveryRetentionStartedAt", "maxExpiresAt"]) &&
		validResultStoreSha256Ref(input.recoveryAuthoritySha256) &&
		validResultStoreIso8601(input.recoveryRetentionStartedAt) &&
		validResultStoreIso8601(input.maxExpiresAt) &&
		Date.parse(input.recoveryRetentionStartedAt) <= Date.parse(input.maxExpiresAt)
	);
}

function resultTargetKeyFromRecord(input: unknown): TransientTaskResultPublicationTargetKeyV1 | null {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input)) return null;
	try {
		const prototype = Object.getPrototypeOf(input);
		if (prototype !== Object.prototype && prototype !== null) return null;
		const descriptors = Object.getOwnPropertyDescriptors(input);
		const keyNames = [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
		] as const;
		if (
			!keyNames.every(key => {
				const descriptor = descriptors[key];
				return descriptor?.enumerable === true && "value" in descriptor;
			})
		)
			return null;
		const key = {
			schemaVersion: descriptors.schemaVersion?.value,
			taskId: descriptors.taskId?.value,
			runId: descriptors.runId?.value,
			createId: descriptors.createId?.value,
			resultPublicationId: descriptors.resultPublicationId?.value,
			resultPublicationTargetId: descriptors.resultPublicationTargetId?.value,
			resultPublicationTargetCleanupId: descriptors.resultPublicationTargetCleanupId?.value,
		};
		return validResultTargetKey(key) ? key : null;
	} catch {
		return null;
	}
}

async function validResultTargetBindingReceipt(
	input: unknown,
	key: TransientTaskResultPublicationTargetKeyV1,
	bindingSha256: Sha256Ref,
): Promise<boolean> {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"bindingSha256",
			"bindingRevision",
			"renewalSequence",
			"previousReceiptSha256",
			"lifetime",
			"boundAt",
			"renewBy",
			"expiresAt",
			"receiptSha256",
		])
	)
		return false;
	const receiptKey = resultTargetKeyFromRecord(input);
	if (
		!receiptKey ||
		!resultTargetKeyMatches(receiptKey, key) ||
		input.bindingSha256 !== bindingSha256 ||
		input.bindingRevision !== 1 ||
		input.renewalSequence !== 0 ||
		input.previousReceiptSha256 !== null ||
		!validResultTargetLifetime(input.lifetime) ||
		input.lifetime.phase !== "active_task" ||
		!validResultStoreIso8601(input.boundAt) ||
		!validResultStoreIso8601(input.renewBy) ||
		!validResultStoreIso8601(input.expiresAt) ||
		Date.parse(input.boundAt) > Date.parse(input.renewBy) ||
		Date.parse(input.renewBy) > Date.parse(input.expiresAt) ||
		!validResultStoreSha256Ref(input.receiptSha256)
	)
		return false;
	return (
		input.receiptSha256 ===
		(await tupleRef([
			"omp-transient-task-result-target-v1",
			"binding-receipt",
			1,
			resultTargetKeyTuple(receiptKey),
			bindingSha256,
			1,
			0,
			null,
			resultTargetLifetimeTuple(input.lifetime),
			input.boundAt,
			input.renewBy,
			input.expiresAt,
		]))
	);
}

async function validResultTargetRenewalReceipt(
	input: unknown,
	key: TransientTaskResultPublicationTargetKeyV1,
): Promise<boolean> {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"renewalId",
			"previousBindingRevision",
			"bindingRevision",
			"previousRenewalSequence",
			"renewalSequence",
			"previousReceiptSha256",
			"previousExpiresAt",
			"lifetime",
			"renewBy",
			"expiresAt",
			"renewedAt",
			"receiptSha256",
		])
	)
		return false;
	const receiptKey = resultTargetKeyFromRecord(input);
	if (
		!receiptKey ||
		!resultTargetKeyMatches(receiptKey, key) ||
		!validResultStoreIdentity(input.renewalId) ||
		!validResultStoreInteger(input.previousBindingRevision, 1) ||
		input.bindingRevision !== input.previousBindingRevision + 1 ||
		!validResultStoreInteger(input.previousRenewalSequence) ||
		input.renewalSequence !== input.previousRenewalSequence + 1 ||
		!validResultStoreSha256Ref(input.previousReceiptSha256) ||
		!validResultStoreIso8601(input.previousExpiresAt) ||
		!validResultTargetLifetime(input.lifetime) ||
		!validResultStoreIso8601(input.renewBy) ||
		!validResultStoreIso8601(input.expiresAt) ||
		!validResultStoreIso8601(input.renewedAt) ||
		Date.parse(input.renewedAt) > Date.parse(input.renewBy) ||
		Date.parse(input.renewBy) > Date.parse(input.expiresAt) ||
		!validResultStoreSha256Ref(input.receiptSha256)
	)
		return false;
	return (
		input.receiptSha256 ===
		(await tupleRef([
			"omp-transient-task-result-target-v1",
			"renewal-receipt",
			1,
			resultTargetKeyTuple(receiptKey),
			input.renewalId,
			input.previousBindingRevision,
			input.bindingRevision,
			input.previousRenewalSequence,
			input.renewalSequence,
			input.previousReceiptSha256,
			input.previousExpiresAt,
			resultTargetLifetimeTuple(input.lifetime),
			input.renewBy,
			input.expiresAt,
			input.renewedAt,
		]))
	);
}

async function validResultTargetLiveReceipt(
	input: unknown,
	key: TransientTaskResultPublicationTargetKeyV1,
	bindingSha256: Sha256Ref,
): Promise<boolean> {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input)) return false;
	return Object.getOwnPropertyDescriptor(input, "renewalId") !== undefined
		? validResultTargetRenewalReceipt(input, key)
		: validResultTargetBindingReceipt(input, key, bindingSha256);
}

async function validResultTargetCleanupReceipt(
	input: unknown,
	key: TransientTaskResultPublicationTargetKeyV1,
): Promise<boolean> {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"bindingRevision",
			"renewalSequence",
			"previousReceiptSha256",
			"cleanedAt",
			"receiptSha256",
			"reason",
			"publicationReceiptSha256",
			"foregroundSettlementCompletionEvidenceSha256",
			"recoveryAuthoritySha256",
		])
	)
		return false;
	const receiptKey = resultTargetKeyFromRecord(input);
	if (
		!receiptKey ||
		!resultTargetKeyMatches(receiptKey, key) ||
		!validResultStoreInteger(input.bindingRevision, 1) ||
		!validResultStoreInteger(input.renewalSequence) ||
		!validResultStoreSha256Ref(input.previousReceiptSha256) ||
		!validResultStoreIso8601(input.cleanedAt) ||
		!validResultStoreSha256Ref(input.receiptSha256)
	)
		return false;
	if (input.reason === "published") {
		if (
			!validResultStoreSha256Ref(input.publicationReceiptSha256) ||
			(input.foregroundSettlementCompletionEvidenceSha256 !== null &&
				!validResultStoreSha256Ref(input.foregroundSettlementCompletionEvidenceSha256)) ||
			input.recoveryAuthoritySha256 !== null
		)
			return false;
	} else if (
		input.reason !== "expired" ||
		input.publicationReceiptSha256 !== null ||
		input.foregroundSettlementCompletionEvidenceSha256 !== null ||
		!validResultStoreSha256Ref(input.recoveryAuthoritySha256)
	) {
		return false;
	}
	return (
		input.receiptSha256 ===
		(await tupleRef([
			"omp-transient-task-result-target-v1",
			"cleanup-receipt",
			1,
			resultTargetKeyTuple(receiptKey),
			input.bindingRevision,
			input.renewalSequence,
			input.previousReceiptSha256,
			input.reason,
			input.publicationReceiptSha256,
			input.foregroundSettlementCompletionEvidenceSha256,
			input.recoveryAuthoritySha256,
			input.cleanedAt,
		]))
	);
}

async function resultTargetBindingReceiptFromAttempt(
	key: TransientTaskResultPublicationTargetKeyV1,
	bindingSha256: Sha256Ref,
	attempt: ConfidentialTransientTaskResultPublicationTargetBindingAttemptV1,
): Promise<TransientTaskResultPublicationTargetBindingReceiptV1> {
	const boundAt = attempt.openedAt;
	const lifetime: Extract<TransientTaskResultPublicationTargetLifetimeV1, { phase: "active_task" }> = {
		phase: "active_task",
		recoveryAuthoritySha256: null,
		recoveryRetentionStartedAt: null,
		maxExpiresAt: null,
	};
	const renewBy = renewalDeadline(boundAt, attempt.request.ttlMs);
	const expiresAt = addMilliseconds(boundAt, attempt.request.ttlMs);
	return {
		schemaVersion: 1,
		taskId: key.taskId,
		runId: key.runId,
		createId: key.createId,
		resultPublicationId: key.resultPublicationId,
		resultPublicationTargetId: key.resultPublicationTargetId,
		resultPublicationTargetCleanupId: key.resultPublicationTargetCleanupId,
		bindingSha256,
		bindingRevision: 1,
		renewalSequence: 0,
		previousReceiptSha256: null,
		lifetime,
		boundAt,
		renewBy,
		expiresAt,
		receiptSha256: await tupleRef([
			"omp-transient-task-result-target-v1",
			"binding-receipt",
			1,
			resultTargetKeyTuple(key),
			bindingSha256,
			1,
			0,
			null,
			resultTargetLifetimeTuple(lifetime),
			boundAt,
			renewBy,
			expiresAt,
		]),
	};
}

async function resultTargetRenewalReceiptFromAttempt(
	key: TransientTaskResultPublicationTargetKeyV1,
	attempt: ConfidentialTransientTaskResultPublicationTargetRenewalAttemptV1,
): Promise<TransientTaskResultPublicationTargetRenewalReceiptV1> {
	const request = attempt.request;
	const live = attempt.previousLiveReceipt;
	const renewedAt = attempt.openedAt;
	const lifetime: TransientTaskResultPublicationTargetLifetimeV1 =
		request.mode.kind === "active_task"
			? live.lifetime
			: request.mode.kind === "freeze_recovery_retention"
				? {
						phase: "recovery_retention",
						recoveryAuthoritySha256: request.mode.recoveryAuthoritySha256,
						recoveryRetentionStartedAt: renewedAt,
						maxExpiresAt: addMilliseconds(renewedAt, TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MAX_V1),
					}
				: live.lifetime;
	const renewBy = renewalDeadline(renewedAt, request.ttlMs);
	const expiresAt = addMilliseconds(renewedAt, request.ttlMs);
	return {
		schemaVersion: 1,
		taskId: key.taskId,
		runId: key.runId,
		createId: key.createId,
		resultPublicationId: key.resultPublicationId,
		resultPublicationTargetId: key.resultPublicationTargetId,
		resultPublicationTargetCleanupId: key.resultPublicationTargetCleanupId,
		renewalId: request.renewalId,
		previousBindingRevision: live.bindingRevision,
		bindingRevision: live.bindingRevision + 1,
		previousRenewalSequence: live.renewalSequence,
		renewalSequence: live.renewalSequence + 1,
		previousReceiptSha256: live.receiptSha256,
		previousExpiresAt: live.expiresAt,
		lifetime,
		renewBy,
		expiresAt,
		renewedAt,
		receiptSha256: await tupleRef([
			"omp-transient-task-result-target-v1",
			"renewal-receipt",
			1,
			resultTargetKeyTuple(key),
			request.renewalId,
			live.bindingRevision,
			live.bindingRevision + 1,
			live.renewalSequence,
			live.renewalSequence + 1,
			live.receiptSha256,
			live.expiresAt,
			resultTargetLifetimeTuple(lifetime),
			renewBy,
			expiresAt,
			renewedAt,
		]),
	};
}

async function resultTargetCleanupReceiptFromAttempt(
	key: TransientTaskResultPublicationTargetKeyV1,
	attempt: ConfidentialTransientTaskResultPublicationTargetCleanupAttemptV1,
): Promise<TransientTaskResultPublicationTargetCleanupReceiptV1> {
	const request = attempt.request;
	const live = attempt.previousLiveReceipt;
	const cleanedAt = attempt.openedAt;
	const receiptSha256 = await tupleRef([
		"omp-transient-task-result-target-v1",
		"cleanup-receipt",
		1,
		resultTargetKeyTuple(key),
		live.bindingRevision,
		live.renewalSequence,
		live.receiptSha256,
		request.reason,
		request.publicationReceiptSha256,
		request.foregroundSettlementCompletionEvidenceSha256,
		request.recoveryAuthoritySha256,
		cleanedAt,
	]);
	const receiptCore = {
		schemaVersion: 1 as const,
		taskId: key.taskId,
		runId: key.runId,
		createId: key.createId,
		resultPublicationId: key.resultPublicationId,
		resultPublicationTargetId: key.resultPublicationTargetId,
		resultPublicationTargetCleanupId: key.resultPublicationTargetCleanupId,
		bindingRevision: live.bindingRevision,
		renewalSequence: live.renewalSequence,
		previousReceiptSha256: live.receiptSha256,
		cleanedAt,
		receiptSha256,
	};
	return request.reason === "published"
		? {
				...receiptCore,
				reason: "published",
				publicationReceiptSha256: request.publicationReceiptSha256,
				foregroundSettlementCompletionEvidenceSha256: request.foregroundSettlementCompletionEvidenceSha256,
				recoveryAuthoritySha256: null,
			}
		: {
				...receiptCore,
				reason: "expired",
				publicationReceiptSha256: null,
				foregroundSettlementCompletionEvidenceSha256: null,
				recoveryAuthoritySha256: request.recoveryAuthoritySha256,
			};
}

function resultTargetExpiredCleanupDue(
	attempt: ConfidentialTransientTaskResultPublicationTargetCleanupAttemptV1,
): boolean {
	const expiresAt = Date.parse(attempt.previousLiveReceipt.expiresAt);
	const observedAt = Date.parse(attempt.request.observedAt);
	const openedAt = Date.parse(attempt.openedAt);
	return expiresAt <= observedAt && observedAt <= openedAt && expiresAt <= openedAt;
}

function validResultTargetRecoveryAuthority(
	input: unknown,
): input is TransientTaskResultPublicationTargetRecoveryAuthorityV1 {
	if (
		!strictRecord(input, [
			"kind",
			"pendingOutcomeReceiptSha256",
			"terminalEvidenceId",
			"terminalEvidenceSha256",
			"singleResultCompositionReceiptSha256",
		]) ||
		(input.kind !== "terminal_pending_delivery" && input.kind !== "terminal_composed_delivery") ||
		!validResultStoreSha256Ref(input.pendingOutcomeReceiptSha256) ||
		!validResultStoreIdentity(input.terminalEvidenceId) ||
		!validResultStoreSha256Ref(input.terminalEvidenceSha256)
	)
		return false;
	return input.kind === "terminal_pending_delivery"
		? input.singleResultCompositionReceiptSha256 === null
		: validResultStoreSha256Ref(input.singleResultCompositionReceiptSha256);
}

function validResultTargetRenewalMode(
	input: unknown,
): input is Parameters<TransientTaskResultPublicationTargetStoreV1["renew"]>[0]["mode"] {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input)) return false;
	const kind = Object.getOwnPropertyDescriptor(input, "kind")?.value;
	if (kind === "active_task") {
		return (
			strictRecord(input, ["kind", "recoveryAuthority", "recoveryAuthoritySha256", "recoveryRetentionMs"]) &&
			input.recoveryAuthority === null &&
			input.recoveryAuthoritySha256 === null &&
			input.recoveryRetentionMs === null
		);
	}
	if (kind === "recovery_retention") {
		return (
			strictRecord(input, ["kind", "recoveryAuthority", "recoveryAuthoritySha256", "recoveryRetentionMs"]) &&
			input.recoveryAuthority === null &&
			validResultStoreSha256Ref(input.recoveryAuthoritySha256) &&
			input.recoveryRetentionMs === null
		);
	}
	return (
		kind === "freeze_recovery_retention" &&
		strictRecord(input, ["kind", "recoveryAuthority", "recoveryAuthoritySha256", "recoveryRetentionMs"]) &&
		validResultTargetRecoveryAuthority(input.recoveryAuthority) &&
		validResultStoreSha256Ref(input.recoveryAuthoritySha256) &&
		input.recoveryAuthoritySha256 ===
			`sha256:${createHash("sha256")
				.update(JSON.stringify(resultTargetRecoveryAuthorityTuple(input.recoveryAuthority)))
				.digest("hex")}` &&
		validResultStoreInteger(input.recoveryRetentionMs, 1)
	);
}

async function validResultTargetBindRequest(input: unknown): Promise<boolean> {
	if (!strictRecord(input, ["binding", "ttlMs", "authority", "requestSha256"])) return false;
	if (
		!validResultTargetBinding(input.binding) ||
		!validResultStoreInteger(input.ttlMs, 1) ||
		!validResultTargetAuthority(input.authority) ||
		input.authority.kind !== "controller" ||
		!validResultStoreSha256Hex(input.requestSha256)
	)
		return false;
	return (
		input.requestSha256 ===
		(await canonicalRuntimeSha256([
			"omp-transient-task-result-target-v1",
			"bind",
			1,
			resultTargetKeyTuple(input.binding),
			resultTargetRouteTuple(input.binding),
			input.ttlMs,
			resultTargetAuthorityTuple(input.authority),
		]))
	);
}

async function validResultTargetRenewRequest(input: unknown): Promise<boolean> {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"expectedBindingSha256",
			"expectedBindRequestSha256",
			"renewalId",
			"expectedBindingRevision",
			"expectedRenewalSequence",
			"expectedLiveReceiptSha256",
			"expectedExpiresAt",
			"ttlMs",
			"mode",
			"authority",
			"requestSha256",
		])
	)
		return false;
	const key = resultTargetKeyFromRecord(input);
	if (
		!key ||
		!validResultStoreSha256Ref(input.expectedBindingSha256) ||
		!validResultStoreSha256Hex(input.expectedBindRequestSha256) ||
		!validResultStoreIdentity(input.renewalId) ||
		!validResultStoreInteger(input.expectedBindingRevision, 1) ||
		!validResultStoreInteger(input.expectedRenewalSequence) ||
		!validResultStoreSha256Ref(input.expectedLiveReceiptSha256) ||
		!validResultStoreIso8601(input.expectedExpiresAt) ||
		!validResultStoreInteger(input.ttlMs, 1) ||
		!validResultTargetRenewalMode(input.mode) ||
		!validResultTargetAuthority(input.authority) ||
		!validResultStoreSha256Hex(input.requestSha256)
	)
		return false;
	return (
		input.requestSha256 ===
		(await canonicalRuntimeSha256([
			"omp-transient-task-result-target-v1",
			"renew",
			1,
			resultTargetKeyTuple(key),
			input.renewalId,
			input.expectedBindingRevision,
			input.expectedRenewalSequence,
			input.expectedLiveReceiptSha256,
			input.expectedExpiresAt,
			input.ttlMs,
			resultTargetRenewalModeTuple(input.mode),
			resultTargetAuthorityTuple(input.authority),
		]))
	);
}

async function validResultTargetCleanupRequest(input: unknown): Promise<boolean> {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"expectedBindingSha256",
			"expectedBindRequestSha256",
			"expectedBindingRevision",
			"expectedRenewalSequence",
			"expectedLiveReceiptSha256",
			"expectedExpiresAt",
			"observedAt",
			"authority",
			"requestSha256",
			"reason",
			"publicationReceiptSha256",
			"foregroundSettlementCompletionEvidenceSha256",
			"recoveryAuthoritySha256",
		])
	)
		return false;
	const key = resultTargetKeyFromRecord(input);
	if (
		!key ||
		!validResultStoreSha256Ref(input.expectedBindingSha256) ||
		!validResultStoreSha256Hex(input.expectedBindRequestSha256) ||
		!validResultStoreInteger(input.expectedBindingRevision, 1) ||
		!validResultStoreInteger(input.expectedRenewalSequence) ||
		!validResultStoreSha256Ref(input.expectedLiveReceiptSha256) ||
		!validResultStoreIso8601(input.expectedExpiresAt) ||
		!validResultStoreIso8601(input.observedAt) ||
		!validResultTargetAuthority(input.authority) ||
		!validResultStoreSha256Hex(input.requestSha256)
	)
		return false;
	if (input.reason === "published") {
		if (
			!validResultStoreSha256Ref(input.publicationReceiptSha256) ||
			(input.foregroundSettlementCompletionEvidenceSha256 !== null &&
				!validResultStoreSha256Ref(input.foregroundSettlementCompletionEvidenceSha256)) ||
			input.recoveryAuthoritySha256 !== null
		)
			return false;
	} else if (
		input.reason !== "expired" ||
		input.publicationReceiptSha256 !== null ||
		input.foregroundSettlementCompletionEvidenceSha256 !== null ||
		!validResultStoreSha256Ref(input.recoveryAuthoritySha256)
	) {
		return false;
	}
	return (
		input.requestSha256 ===
		(await canonicalRuntimeSha256([
			"omp-transient-task-result-target-v1",
			"cleanup",
			1,
			resultTargetKeyTuple(key),
			input.expectedBindingRevision,
			input.expectedRenewalSequence,
			input.expectedLiveReceiptSha256,
			input.expectedExpiresAt,
			input.reason,
			input.publicationReceiptSha256,
			input.foregroundSettlementCompletionEvidenceSha256,
			input.recoveryAuthoritySha256,
			input.observedAt,
			resultTargetAuthorityTuple(input.authority),
		]))
	);
}
function validResultTargetRenewInspectRequest(input: unknown, withAuthority: boolean): boolean {
	const fields = [
		"schemaVersion",
		"taskId",
		"runId",
		"createId",
		"resultPublicationId",
		"resultPublicationTargetId",
		"resultPublicationTargetCleanupId",
		"expectedBindingSha256",
		"expectedBindRequestSha256",
		"renewalId",
		"requestSha256",
	];
	if (withAuthority) fields.push("authority");
	return Boolean(
		strictRecord(input, fields) &&
			resultTargetKeyFromRecord(input) !== null &&
			validResultStoreSha256Ref(input.expectedBindingSha256) &&
			validResultStoreSha256Hex(input.expectedBindRequestSha256) &&
			validResultStoreIdentity(input.renewalId) &&
			validResultStoreSha256Hex(input.requestSha256) &&
			(!withAuthority || validResultTargetAuthority(input.authority)),
	);
}

function validResultTargetCleanupInspectRequest(input: unknown, withAuthority: boolean): boolean {
	const fields = [
		"schemaVersion",
		"taskId",
		"runId",
		"createId",
		"resultPublicationId",
		"resultPublicationTargetId",
		"resultPublicationTargetCleanupId",
		"expectedBindingSha256",
		"expectedBindRequestSha256",
		"requestSha256",
	];
	if (withAuthority) fields.push("authority");
	return Boolean(
		strictRecord(input, fields) &&
			resultTargetKeyFromRecord(input) !== null &&
			validResultStoreSha256Ref(input.expectedBindingSha256) &&
			validResultStoreSha256Hex(input.expectedBindRequestSha256) &&
			validResultStoreSha256Hex(input.requestSha256) &&
			(!withAuthority || validResultTargetAuthority(input.authority)),
	);
}

interface PrivateResultTargetRenewalHistoryEntryV1 {
	readonly attempt: ConfidentialTransientTaskResultPublicationTargetRenewalAttemptV1;
	readonly receipt: TransientTaskResultPublicationTargetRenewalReceiptV1;
}

interface PrivateResultTargetRowV1 {
	readonly binding: ConfidentialTransientTaskResultPublicationBindingV1 | null;
	readonly bindingSha256: Sha256Ref;
	readonly bindRequestSha256: Sha256Hex;
	readonly state: TransientTaskResultPublicationTargetStateV1;
	readonly bindingAttempt: ConfidentialTransientTaskResultPublicationTargetBindingAttemptV1;
	readonly renewalHistory: readonly PrivateResultTargetRenewalHistoryEntryV1[];
	readonly renewalAttempt: ConfidentialTransientTaskResultPublicationTargetRenewalAttemptV1 | null;
	readonly cleanupAttempt: ConfidentialTransientTaskResultPublicationTargetCleanupAttemptV1 | null;
}

function resultTargetMapKey(key: TransientTaskResultPublicationTargetKeyV1): string {
	return `${key.createId}\u0000${key.resultPublicationId}\u0000${key.resultPublicationTargetId}\u0000${key.resultPublicationTargetCleanupId}`;
}

function resultTargetRenewalAttemptFollows(
	attempt: ConfidentialTransientTaskResultPublicationTargetRenewalAttemptV1,
	key: TransientTaskResultPublicationTargetKeyV1,
	bindingSha256: Sha256Ref,
	bindRequestSha256: Sha256Hex,
	previousLiveReceipt:
		| TransientTaskResultPublicationTargetBindingReceiptV1
		| TransientTaskResultPublicationTargetRenewalReceiptV1,
): boolean {
	const request = attempt.request;
	if (
		!resultTargetKeyMatches(request, key) ||
		request.expectedBindingSha256 !== bindingSha256 ||
		request.expectedBindRequestSha256 !== bindRequestSha256 ||
		request.expectedBindingRevision !== previousLiveReceipt.bindingRevision ||
		request.expectedRenewalSequence !== previousLiveReceipt.renewalSequence ||
		request.expectedLiveReceiptSha256 !== previousLiveReceipt.receiptSha256 ||
		request.expectedExpiresAt !== previousLiveReceipt.expiresAt ||
		!isDeepStrictEqual(attempt.previousLiveReceipt, previousLiveReceipt) ||
		Date.parse(attempt.openedAt) >= Date.parse(previousLiveReceipt.expiresAt)
	)
		return false;
	if (request.mode.kind === "active_task") return previousLiveReceipt.lifetime.phase === "active_task";
	if (request.mode.kind === "freeze_recovery_retention") {
		return (
			request.mode.recoveryRetentionMs >= TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MIN_V1 &&
			request.mode.recoveryRetentionMs <= TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MAX_V1
		);
	}
	return (
		previousLiveReceipt.lifetime.phase === "recovery_retention" &&
		previousLiveReceipt.lifetime.recoveryAuthoritySha256 === request.mode.recoveryAuthoritySha256
	);
}

function resultTargetCleanupAttemptFollows(
	attempt: ConfidentialTransientTaskResultPublicationTargetCleanupAttemptV1,
	key: TransientTaskResultPublicationTargetKeyV1,
	bindingSha256: Sha256Ref,
	bindRequestSha256: Sha256Hex,
	previousLiveReceipt:
		| TransientTaskResultPublicationTargetBindingReceiptV1
		| TransientTaskResultPublicationTargetRenewalReceiptV1,
): boolean {
	const request = attempt.request;
	return (
		resultTargetKeyMatches(request, key) &&
		request.expectedBindingSha256 === bindingSha256 &&
		request.expectedBindRequestSha256 === bindRequestSha256 &&
		request.expectedBindingRevision === previousLiveReceipt.bindingRevision &&
		request.expectedRenewalSequence === previousLiveReceipt.renewalSequence &&
		request.expectedLiveReceiptSha256 === previousLiveReceipt.receiptSha256 &&
		request.expectedExpiresAt === previousLiveReceipt.expiresAt &&
		isDeepStrictEqual(attempt.previousLiveReceipt, previousLiveReceipt) &&
		(request.reason === "published" ||
			(previousLiveReceipt.lifetime.phase === "recovery_retention" &&
				request.recoveryAuthoritySha256 === previousLiveReceipt.lifetime.recoveryAuthoritySha256))
	);
}

async function resultTargetRenewalHistory(
	input: unknown,
	key: TransientTaskResultPublicationTargetKeyV1,
	bindingSha256: Sha256Ref,
	bindRequestSha256: Sha256Hex,
	bindReceipt: TransientTaskResultPublicationTargetBindingReceiptV1,
): Promise<{
	readonly entries: readonly PrivateResultTargetRenewalHistoryEntryV1[];
	readonly liveReceipt:
		| TransientTaskResultPublicationTargetBindingReceiptV1
		| TransientTaskResultPublicationTargetRenewalReceiptV1;
}> {
	if (!strictArray(input)) throw new Error("Transient result target renewal history is invalid");
	const entries: PrivateResultTargetRenewalHistoryEntryV1[] = [];
	const renewalIds = new Set<OperationId>();
	let liveReceipt:
		| TransientTaskResultPublicationTargetBindingReceiptV1
		| TransientTaskResultPublicationTargetRenewalReceiptV1 = bindReceipt;
	for (let index = 0; index < input.length; index++) {
		const inputEntry = input[index];
		if (
			!strictRecord(inputEntry, ["attempt", "receipt"]) ||
			!strictRecord(inputEntry.attempt, ["request", "previousLiveReceipt", "openedAt"]) ||
			!(await validResultTargetRenewRequest(inputEntry.attempt.request)) ||
			!validResultStoreIso8601(inputEntry.attempt.openedAt) ||
			!(await validResultTargetRenewalReceipt(inputEntry.receipt, key))
		)
			throw new Error("Transient result target renewal history is invalid");
		const attempt = inputEntry.attempt as unknown as ConfidentialTransientTaskResultPublicationTargetRenewalAttemptV1;
		const receipt = inputEntry.receipt as unknown as TransientTaskResultPublicationTargetRenewalReceiptV1;
		if (renewalIds.has(attempt.request.renewalId))
			throw new Error("Transient result target renewal history is invalid");
		renewalIds.add(attempt.request.renewalId);
		if (!resultTargetRenewalAttemptFollows(attempt, key, bindingSha256, bindRequestSha256, liveReceipt))
			throw new Error("Transient result target renewal history is invalid");
		const expectedReceipt = await resultTargetRenewalReceiptFromAttempt(key, attempt);
		if (
			expectedReceipt.lifetime.phase === "recovery_retention" &&
			Date.parse(expectedReceipt.expiresAt) > Date.parse(expectedReceipt.lifetime.maxExpiresAt)
		)
			throw new Error("Transient result target renewal history is invalid");
		if (!isDeepStrictEqual(receipt, expectedReceipt))
			throw new Error("Transient result target renewal history is invalid");
		entries.push({ attempt, receipt });
		liveReceipt = receipt;
	}
	return { entries, liveReceipt };
}

async function resultTargetRow(input: unknown): Promise<PrivateResultTargetRowV1 | null> {
	if (input === undefined) return null;
	if (
		!proxyFreeData(input) ||
		!strictRecord(input, [
			"binding",
			"bindingSha256",
			"bindRequestSha256",
			"state",
			"bindingAttempt",
			"renewalHistory",
			"renewalAttempt",
			"cleanupAttempt",
		]) ||
		!validResultStoreSha256Ref(input.bindingSha256) ||
		!validResultStoreSha256Hex(input.bindRequestSha256) ||
		!strictRecord(input.bindingAttempt, ["request", "openedAt"]) ||
		!(await validResultTargetBindRequest(input.bindingAttempt.request)) ||
		!validResultStoreIso8601(input.bindingAttempt.openedAt)
	)
		throw new Error("Transient result target row is invalid");
	const bindingAttempt =
		input.bindingAttempt as unknown as ConfidentialTransientTaskResultPublicationTargetBindingAttemptV1;
	const key = bindingAttempt.request.binding;
	if (
		input.bindingSha256 !==
			(await tupleRef([
				"omp-transient-task-result-target-v1",
				"binding",
				1,
				resultTargetKeyTuple(key),
				resultTargetRouteTuple(key),
			])) ||
		input.bindRequestSha256 !== bindingAttempt.request.requestSha256
	)
		throw new Error("Transient result target row binding is invalid");
	if (input.binding !== null && (!validResultTargetBinding(input.binding) || !isDeepStrictEqual(input.binding, key)))
		throw new Error("Transient result target binding is invalid");
	const bindReceipt = await resultTargetBindingReceiptFromAttempt(key, input.bindingSha256, bindingAttempt);
	const renewalHistory = await resultTargetRenewalHistory(
		input.renewalHistory,
		key,
		input.bindingSha256,
		input.bindRequestSha256,
		bindReceipt,
	);

	let renewalAttempt: ConfidentialTransientTaskResultPublicationTargetRenewalAttemptV1 | null = null;
	if (input.renewalAttempt !== null) {
		if (
			!strictRecord(input.renewalAttempt, ["request", "previousLiveReceipt", "openedAt"]) ||
			!(await validResultTargetRenewRequest(input.renewalAttempt.request)) ||
			!validResultStoreIso8601(input.renewalAttempt.openedAt) ||
			!(await validResultTargetLiveReceipt(input.renewalAttempt.previousLiveReceipt, key, input.bindingSha256))
		)
			throw new Error("Transient result target renewal attempt is invalid");
		renewalAttempt =
			input.renewalAttempt as unknown as ConfidentialTransientTaskResultPublicationTargetRenewalAttemptV1;
	}
	let cleanupAttempt: ConfidentialTransientTaskResultPublicationTargetCleanupAttemptV1 | null = null;
	if (input.cleanupAttempt !== null) {
		if (
			!strictRecord(input.cleanupAttempt, ["request", "previousLiveReceipt", "openedAt"]) ||
			!(await validResultTargetCleanupRequest(input.cleanupAttempt.request)) ||
			!validResultStoreIso8601(input.cleanupAttempt.openedAt) ||
			!(await validResultTargetLiveReceipt(input.cleanupAttempt.previousLiveReceipt, key, input.bindingSha256))
		)
			throw new Error("Transient result target cleanup attempt is invalid");
		cleanupAttempt =
			input.cleanupAttempt as unknown as ConfidentialTransientTaskResultPublicationTargetCleanupAttemptV1;
	}
	const lastRenewal =
		renewalHistory.entries.length === 0 ? null : (renewalHistory.entries[renewalHistory.entries.length - 1] ?? null);
	const completedRenewalAttemptMatches =
		lastRenewal === null
			? renewalAttempt === null
			: renewalAttempt !== null && isDeepStrictEqual(renewalAttempt, lastRenewal.attempt);

	const stateInput = input.state;
	if (!proxyFreeData(stateInput) || stateInput === null || typeof stateInput !== "object" || Array.isArray(stateInput))
		throw new Error("Transient result target state is invalid");
	const stateDiscriminator = Object.getOwnPropertyDescriptor(stateInput, "state")?.value;
	let state: TransientTaskResultPublicationTargetStateV1;
	if (stateDiscriminator === "binding_not_applied" || stateDiscriminator === "binding_outcome_unknown") {
		if (
			!strictRecord(stateInput, [
				"state",
				"resultPublicationTargetId",
				"resultPublicationTargetCleanupId",
				"bindingSha256",
				"requestSha256",
				"openedAt",
			])
		)
			throw new Error("Transient result target bind state is invalid");
		const candidate = stateInput as unknown as Extract<
			TransientTaskResultPublicationTargetStateV1,
			{ state: "binding_not_applied" | "binding_outcome_unknown" }
		>;
		if (
			candidate.resultPublicationTargetId !== key.resultPublicationTargetId ||
			candidate.resultPublicationTargetCleanupId !== key.resultPublicationTargetCleanupId ||
			candidate.bindingSha256 !== input.bindingSha256 ||
			candidate.requestSha256 !== input.bindRequestSha256 ||
			candidate.openedAt !== bindingAttempt.openedAt ||
			input.binding === null ||
			renewalHistory.entries.length !== 0 ||
			renewalAttempt !== null ||
			cleanupAttempt !== null
		)
			throw new Error("Transient result target bind state is invalid");
		state = candidate;
	} else if (stateDiscriminator === "bound") {
		if (!strictRecord(stateInput, ["state", "bindReceipt", "liveReceipt"]))
			throw new Error("Transient result target bound state is invalid");
		const candidate = stateInput as unknown as Extract<
			TransientTaskResultPublicationTargetStateV1,
			{ state: "bound" }
		>;
		if (
			!(await validResultTargetBindingReceipt(candidate.bindReceipt, key, input.bindingSha256)) ||
			!(await validResultTargetLiveReceipt(candidate.liveReceipt, key, input.bindingSha256)) ||
			!isDeepStrictEqual(candidate.bindReceipt, bindReceipt) ||
			!isDeepStrictEqual(candidate.liveReceipt, renewalHistory.liveReceipt) ||
			!completedRenewalAttemptMatches ||
			input.binding === null ||
			cleanupAttempt !== null
		)
			throw new Error("Transient result target bound state is invalid");
		state = candidate;
	} else if (stateDiscriminator === "renewal_not_applied" || stateDiscriminator === "renewal_outcome_unknown") {
		if (
			!strictRecord(stateInput, [
				"state",
				"bindReceipt",
				"previousLiveReceipt",
				"renewalId",
				"requestSha256",
				"openedAt",
			])
		)
			throw new Error("Transient result target renewal state is invalid");
		const candidate = stateInput as unknown as Extract<
			TransientTaskResultPublicationTargetStateV1,
			{ state: "renewal_not_applied" | "renewal_outcome_unknown" }
		>;
		if (
			!(await validResultTargetBindingReceipt(candidate.bindReceipt, key, input.bindingSha256)) ||
			!isDeepStrictEqual(candidate.bindReceipt, bindReceipt) ||
			!renewalAttempt ||
			!resultTargetRenewalAttemptFollows(
				renewalAttempt,
				key,
				input.bindingSha256,
				input.bindRequestSha256,
				renewalHistory.liveReceipt,
			) ||
			candidate.renewalId !== renewalAttempt.request.renewalId ||
			candidate.requestSha256 !== renewalAttempt.request.requestSha256 ||
			candidate.openedAt !== renewalAttempt.openedAt ||
			!isDeepStrictEqual(candidate.previousLiveReceipt, renewalHistory.liveReceipt) ||
			input.binding === null ||
			cleanupAttempt !== null
		)
			throw new Error("Transient result target renewal state is invalid");
		state = candidate;
	} else if (stateDiscriminator === "cleanup_not_applied" || stateDiscriminator === "cleanup_outcome_unknown") {
		if (
			!strictRecord(stateInput, [
				"state",
				"bindReceipt",
				"previousLiveReceipt",
				"resultPublicationTargetCleanupId",
				"requestSha256",
				"openedAt",
			])
		)
			throw new Error("Transient result target cleanup state is invalid");
		const candidate = stateInput as unknown as Extract<
			TransientTaskResultPublicationTargetStateV1,
			{ state: "cleanup_not_applied" | "cleanup_outcome_unknown" }
		>;
		if (
			!(await validResultTargetBindingReceipt(candidate.bindReceipt, key, input.bindingSha256)) ||
			!isDeepStrictEqual(candidate.bindReceipt, bindReceipt) ||
			!cleanupAttempt ||
			!resultTargetCleanupAttemptFollows(
				cleanupAttempt,
				key,
				input.bindingSha256,
				input.bindRequestSha256,
				renewalHistory.liveReceipt,
			) ||
			candidate.resultPublicationTargetCleanupId !== key.resultPublicationTargetCleanupId ||
			candidate.requestSha256 !== cleanupAttempt.request.requestSha256 ||
			candidate.openedAt !== cleanupAttempt.openedAt ||
			!isDeepStrictEqual(candidate.previousLiveReceipt, renewalHistory.liveReceipt) ||
			!completedRenewalAttemptMatches ||
			input.binding === null
		)
			throw new Error("Transient result target cleanup state is invalid");
		state = candidate;
	} else if (stateDiscriminator === "cleaned") {
		if (!strictRecord(stateInput, ["state", "receipt"]))
			throw new Error("Transient result target cleaned state is invalid");
		const candidate = stateInput as unknown as Extract<
			TransientTaskResultPublicationTargetStateV1,
			{ state: "cleaned" }
		>;
		if (
			!(await validResultTargetCleanupReceipt(candidate.receipt, key)) ||
			!cleanupAttempt ||
			!resultTargetCleanupAttemptFollows(
				cleanupAttempt,
				key,
				input.bindingSha256,
				input.bindRequestSha256,
				renewalHistory.liveReceipt,
			) ||
			(cleanupAttempt.request.reason === "expired" && !resultTargetExpiredCleanupDue(cleanupAttempt)) ||
			!isDeepStrictEqual(candidate.receipt, await resultTargetCleanupReceiptFromAttempt(key, cleanupAttempt)) ||
			!completedRenewalAttemptMatches ||
			input.binding !== null
		)
			throw new Error("Transient result target cleaned state is invalid");
		state = candidate;
	} else {
		throw new Error("Transient result target state discriminator is invalid");
	}
	return {
		binding: input.binding as ConfidentialTransientTaskResultPublicationBindingV1 | null,
		bindingSha256: input.bindingSha256,
		bindRequestSha256: input.bindRequestSha256,
		state,
		bindingAttempt,
		renewalHistory: renewalHistory.entries,
		renewalAttempt,
		cleanupAttempt,
	};
}

function payloadEnvelopeTuple(payload: TransientTaskOutcomePayloadV1): readonly CanonicalRuntimeValue[] {
	return payload.storage === "inline_base64"
		? [
				"inline_base64",
				payload.payloadRole,
				payload.mediaType,
				payload.bytesBase64,
				payload.byteLength,
				payload.payloadSha256,
			]
		: ["opaque_immutable_ref", payloadRefTuple(payload.payloadRef)];
}
function compositionDiagnosticTuple(
	diagnostic: TransientTaskSingleResultCompositionDiagnosticV1 | null,
): CanonicalRuntimeValue {
	if (diagnostic === null) return null;
	return [
		diagnostic.compositionStatus,
		diagnostic.sourceDisposition,
		diagnostic.observedUtf8ByteLength,
		diagnostic.maximumUtf8ByteLength,
	];
}

function prePendingInitializationReceiptTuple(
	receipt: TransientTaskResultPublicationPrePendingInitializationReceiptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-result-publication-v1",
		"pre-pending-initialization-receipt",
		1,
		resultTargetKeyTuple(receipt.resultTargetKey),
		receipt.planSha256,
		receipt.requestSha256,
		receipt.initializedAt,
	];
}

function cancellationReceiptTuple(
	receipt: TransientTaskCancellationAcknowledgementReceiptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-result-publication-v1",
		"cancellation-acknowledgement-receipt",
		1,
		[
			"omp-transient-task-result-publication-v1",
			"cancellation-acknowledgement-core",
			1,
			resultTargetKeyTuple(receipt.core.resultTargetKey),
			receipt.core.planSha256,
			receipt.core.kind,
			receipt.core.message,
		],
		receipt.initializationReceiptSha256,
		receipt.requestSha256,
		receipt.acknowledgedAt,
	];
}

function isCancellationPredecessor(
	receipt:
		| TransientTaskCancellationAcknowledgementReceiptV1
		| TransientTaskResultPublicationPrePendingInitializationReceiptV1,
): receipt is TransientTaskCancellationAcknowledgementReceiptV1 {
	return "core" in receipt;
}
function resultlessEncodingTuple(encoding: TransientTaskOutcomeDocumentEncodingV1): readonly CanonicalRuntimeValue[] {
	const document = encoding.outcomeDocument;
	if (document.documentKind !== "resultless_terminal") throw new TypeError("Resultless preflight encoding is invalid");
	const error = document.error;
	const errorTuple: readonly CanonicalRuntimeValue[] =
		error.code === "single_result_payload_too_large"
			? [
					error.code,
					error.source,
					error.structuredSubagentKind,
					error.sourceMessage,
					error.observedUtf8ByteLength,
					error.maximumUtf8ByteLength,
				]
			: [error.code, error.source, error.structuredSubagentKind, error.sourceMessage];
	return [
		1,
		[1, "resultless_terminal", document.index, document.id, document.agent, document.terminalOutcome, errorTuple],
		encoding.outcomeDocumentUtf8,
		encoding.outcomeDocumentUtf8ByteLength,
		encoding.outcomeDocumentUtf8Sha256,
	];
}

function representabilityPreflightTuple(
	preflight: TransientTaskResultlessRepresentabilityPreflightV1,
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

function prePendingPlanTuple(
	plan: Parameters<TransientTaskResultPublicationStoreV1["initializePrePending"]>[0]["plan"],
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-result-publication-v1",
		"pre-pending-plan",
		1,
		resultTargetKeyTuple(plan.resultTargetKey),
		[plan.resultlessIdentity.index, plan.resultlessIdentity.id, plan.resultlessIdentity.agent],
		plan.maximumUtf8ByteLength,
		representabilityPreflightTuple(plan.representabilityPreflight),
		plan.preflightSha256,
	];
}

async function validPrePendingPlan(
	plan: Parameters<TransientTaskResultPublicationStoreV1["initializePrePending"]>[0]["plan"],
): Promise<boolean> {
	const preflight = plan.representabilityPreflight;
	if (
		plan.schemaVersion !== 1 ||
		!Number.isSafeInteger(plan.resultlessIdentity.index) ||
		plan.resultlessIdentity.index < 0 ||
		plan.resultlessIdentity.id.length === 0 ||
		plan.resultlessIdentity.agent.length === 0 ||
		plan.maximumUtf8ByteLength !== preflight.maximumUtf8ByteLength ||
		!exactJson(plan.resultlessIdentity, preflight.identity) ||
		preflight.fallbackEncodings.failed.outcomeDocument.documentKind !== "resultless_terminal" ||
		preflight.fallbackEncodings.failed.outcomeDocument.terminalOutcome !== "failed" ||
		preflight.fallbackEncodings.cancelled.outcomeDocument.documentKind !== "resultless_terminal" ||
		preflight.fallbackEncodings.cancelled.outcomeDocument.terminalOutcome !== "cancelled"
	)
		return false;
	for (const encoding of [preflight.fallbackEncodings.failed, preflight.fallbackEncodings.cancelled]) {
		const bytes = Buffer.from(encoding.outcomeDocumentUtf8, "utf8");
		if (
			encoding.schemaVersion !== 1 ||
			bytes.byteLength !== encoding.outcomeDocumentUtf8ByteLength ||
			sha256Ref(createHash("sha256").update(bytes).digest("hex") as Sha256Hex) !==
				encoding.outcomeDocumentUtf8Sha256 ||
			JSON.stringify(encoding.outcomeDocument) !== encoding.outcomeDocumentUtf8
		)
			return false;
	}
	return (
		plan.preflightSha256 === (await tupleRef(representabilityPreflightTuple(preflight))) &&
		plan.planSha256 === (await tupleRef(prePendingPlanTuple(plan)))
	);
}

function pendingOutcomeTuple(pending: TransientTaskPendingOutcomeV1): readonly CanonicalRuntimeValue[] {
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
		payloadEnvelopeTuple(pending.payload),
		pending.payloadPutReceipt?.receiptSha256 ?? null,
		pending.capturedAt,
	];
}

function publicationMapKey(key: TransientTaskResultPublicationTargetKeyV1): string {
	return `${key.createId}\u0000${key.resultPublicationId}\u0000${key.resultPublicationTargetId}\u0000${key.resultPublicationTargetCleanupId}`;
}

function validParentDeliveryReceipt(input: unknown): input is TransientTaskParentResultDeliveryReceiptV1 {
	if (
		!proxyFreeData(input) ||
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		!("routeKind" in input) ||
		!("outcome" in input)
	)
		return false;
	const foreground = input.routeKind === "foreground_tool_call";
	const keys = [
		"schemaVersion",
		"taskId",
		"runId",
		"createId",
		"resultPublicationId",
		"resultPublicationTargetId",
		"resultPublicationTargetCleanupId",
		"deliveryOperationId",
		"targetBindingRevision",
		"targetRenewalSequence",
		"targetLiveReceiptSha256",
		"deliveryAuthoritySha256",
		"deliveryAttemptSha256",
		"sinkResultUtf8Sha256",
		"sinkResultUtf8ByteLength",
		"pendingOutcomeSha256",
		"singleResultCompositionReceiptSha256",
		"deliveryPayloadRole",
		"deliveryPayloadId",
		"deliveryPayloadDeleteId",
		"deliveryPayloadPutReceiptSha256",
		"deliveryPayloadSha256",
		"deliveryPayloadByteLength",
		"deliveryPayloadEnvelopeSha256",
		"deliveryPayloadTupleSha256",
		"deliveryRequestSha256",
		"completedAt",
		"receiptSha256",
		"outcome",
		"routeKind",
		"sinkReceiptSha256",
		"foregroundSettlementIdentitySha256",
		...(foreground ? ["foregroundAppendBatchKeySha256"] : []),
		"foregroundPrimaryReceiptSha256",
		"foregroundBatchTransitionReceiptSha256",
		"detachedSettlement",
	];
	if (!strictRecord(input, keys)) return false;
	const key = resultTargetKeyFromRecord(input);
	if (
		!key ||
		!validResultStoreIdentity(input.deliveryOperationId) ||
		!validResultStoreInteger(input.targetBindingRevision, 1) ||
		!validResultStoreInteger(input.targetRenewalSequence) ||
		!validResultStoreSha256Ref(input.targetLiveReceiptSha256) ||
		!validResultStoreSha256Ref(input.deliveryAuthoritySha256) ||
		!validResultStoreSha256Ref(input.deliveryAttemptSha256) ||
		!validResultStoreSha256Ref(input.sinkResultUtf8Sha256) ||
		!validResultStoreInteger(input.sinkResultUtf8ByteLength) ||
		!validResultStoreSha256Ref(input.pendingOutcomeSha256) ||
		(input.singleResultCompositionReceiptSha256 !== null &&
			!validResultStoreSha256Ref(input.singleResultCompositionReceiptSha256)) ||
		(input.deliveryPayloadRole !== "pending" && input.deliveryPayloadRole !== "composed") ||
		!validResultStoreIdentity(input.deliveryPayloadId) ||
		!validResultStoreIdentity(input.deliveryPayloadDeleteId) ||
		(input.deliveryPayloadPutReceiptSha256 !== null &&
			!validResultStoreSha256Ref(input.deliveryPayloadPutReceiptSha256)) ||
		!validResultStoreSha256Ref(input.deliveryPayloadSha256) ||
		!validResultStoreInteger(input.deliveryPayloadByteLength) ||
		!validResultStoreSha256Ref(input.deliveryPayloadEnvelopeSha256) ||
		!validResultStoreSha256Ref(input.deliveryPayloadTupleSha256) ||
		!validResultStoreSha256Hex(input.deliveryRequestSha256) ||
		!validResultStoreIso8601(input.completedAt) ||
		!validResultStoreSha256Ref(input.receiptSha256)
	)
		return false;
	if (foreground) {
		return (
			input.outcome === "delivered" &&
			validResultStoreSha256Ref(input.sinkReceiptSha256) &&
			validResultStoreSha256Ref(input.foregroundSettlementIdentitySha256) &&
			validResultStoreSha256Ref(input.foregroundAppendBatchKeySha256) &&
			validResultStoreSha256Ref(input.foregroundPrimaryReceiptSha256) &&
			validResultStoreSha256Ref(input.foregroundBatchTransitionReceiptSha256) &&
			input.detachedSettlement === null
		);
	}
	return (
		input.routeKind === "owner_routed_async_result" &&
		(input.outcome === "delivered" || input.outcome === "consumed_without_enqueue") &&
		(input.outcome === "delivered"
			? validResultStoreSha256Ref(input.sinkReceiptSha256)
			: input.sinkReceiptSha256 === null) &&
		input.foregroundSettlementIdentitySha256 === null &&
		input.foregroundPrimaryReceiptSha256 === null &&
		input.foregroundBatchTransitionReceiptSha256 === null &&
		input.detachedSettlement !== null &&
		payloadPlainData(input.detachedSettlement)
	);
}

async function validPublicationReceipt(receipt: TransientTaskResultPublicationReceiptV1): Promise<boolean> {
	if (
		!strictRecord(receipt, [
			"schemaVersion",
			"taskId",
			"runId",
			"state",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"childOutcome",
			"publishedTerminalOutcome",
			"outcomeSha256",
			"deliveryPayloadRole",
			"deliveryPayloadId",
			"deliveryPayloadDeleteId",
			"deliveryPayloadPutReceiptSha256",
			"deliveryPayloadSha256",
			"singleResultCompositionReceiptSha256",
			"singleResultCompositionDiagnostic",
			"deliveryPayloadByteLength",
			"deliveryPayloadEnvelopeSha256",
			"deliveryPayloadTupleSha256",
			"sinkResultUtf8Sha256",
			"sinkResultUtf8ByteLength",
			"terminalEvidenceId",
			"terminalEvidenceSha256",
			"targetBindingRevision",
			"targetRenewalSequence",
			"targetLiveReceiptSha256",
			"deliveryOperationId",
			"parentDeliveryAuthoritySha256",
			"parentDeliveryAttemptSha256",
			"parentDelivery",
			"publishedAt",
			"receiptSha256",
		]) ||
		receipt.schemaVersion !== 1 ||
		receipt.state !== "published"
	)
		return false;
	const key = resultTargetKeyFromRecord(receipt);
	if (
		!key ||
		(receipt.childOutcome !== "succeeded" &&
			receipt.childOutcome !== "failed" &&
			receipt.childOutcome !== "cancelled") ||
		(receipt.publishedTerminalOutcome !== "succeeded" &&
			receipt.publishedTerminalOutcome !== "failed" &&
			receipt.publishedTerminalOutcome !== "cancelled") ||
		!validResultStoreSha256Ref(receipt.outcomeSha256) ||
		(receipt.deliveryPayloadRole !== "pending" && receipt.deliveryPayloadRole !== "composed") ||
		!validResultStoreIdentity(receipt.deliveryPayloadId) ||
		!validResultStoreIdentity(receipt.deliveryPayloadDeleteId) ||
		(receipt.deliveryPayloadPutReceiptSha256 !== null &&
			!validResultStoreSha256Ref(receipt.deliveryPayloadPutReceiptSha256)) ||
		!validResultStoreSha256Ref(receipt.deliveryPayloadSha256) ||
		(receipt.singleResultCompositionReceiptSha256 !== null &&
			!validResultStoreSha256Ref(receipt.singleResultCompositionReceiptSha256)) ||
		(receipt.singleResultCompositionDiagnostic !== null &&
			!strictRecord(receipt.singleResultCompositionDiagnostic, [
				"compositionStatus",
				"sourceDisposition",
				"observedUtf8ByteLength",
				"maximumUtf8ByteLength",
			])) ||
		!validResultStoreInteger(receipt.deliveryPayloadByteLength) ||
		!validResultStoreSha256Ref(receipt.deliveryPayloadEnvelopeSha256) ||
		!validResultStoreSha256Ref(receipt.deliveryPayloadTupleSha256) ||
		!validResultStoreSha256Ref(receipt.sinkResultUtf8Sha256) ||
		!validResultStoreInteger(receipt.sinkResultUtf8ByteLength) ||
		!validResultStoreIdentity(receipt.terminalEvidenceId) ||
		!validResultStoreSha256Ref(receipt.terminalEvidenceSha256) ||
		!validResultStoreInteger(receipt.targetBindingRevision, 1) ||
		!validResultStoreInteger(receipt.targetRenewalSequence) ||
		!validResultStoreSha256Ref(receipt.targetLiveReceiptSha256) ||
		!validResultStoreIdentity(receipt.deliveryOperationId) ||
		!validResultStoreSha256Ref(receipt.parentDeliveryAuthoritySha256) ||
		!validResultStoreSha256Ref(receipt.parentDeliveryAttemptSha256) ||
		!validParentDeliveryReceipt(receipt.parentDelivery) ||
		!validResultStoreIso8601(receipt.publishedAt) ||
		!validResultStoreSha256Ref(receipt.receiptSha256)
	)
		return false;
	if (
		!resultTargetKeyMatches(receipt.parentDelivery, key) ||
		receipt.parentDelivery.deliveryOperationId !== receipt.deliveryOperationId ||
		receipt.parentDelivery.deliveryAuthoritySha256 !== receipt.parentDeliveryAuthoritySha256 ||
		receipt.parentDelivery.deliveryAttemptSha256 !== receipt.parentDeliveryAttemptSha256 ||
		receipt.parentDelivery.targetBindingRevision !== receipt.targetBindingRevision ||
		receipt.parentDelivery.targetRenewalSequence !== receipt.targetRenewalSequence ||
		receipt.parentDelivery.targetLiveReceiptSha256 !== receipt.targetLiveReceiptSha256 ||
		receipt.parentDelivery.pendingOutcomeSha256 !== receipt.outcomeSha256 ||
		receipt.parentDelivery.deliveryPayloadRole !== receipt.deliveryPayloadRole ||
		receipt.parentDelivery.deliveryPayloadId !== receipt.deliveryPayloadId ||
		receipt.parentDelivery.deliveryPayloadDeleteId !== receipt.deliveryPayloadDeleteId ||
		receipt.parentDelivery.deliveryPayloadPutReceiptSha256 !== receipt.deliveryPayloadPutReceiptSha256 ||
		receipt.parentDelivery.deliveryPayloadSha256 !== receipt.deliveryPayloadSha256 ||
		receipt.parentDelivery.deliveryPayloadByteLength !== receipt.deliveryPayloadByteLength ||
		receipt.parentDelivery.deliveryPayloadEnvelopeSha256 !== receipt.deliveryPayloadEnvelopeSha256 ||
		receipt.parentDelivery.deliveryPayloadTupleSha256 !== receipt.deliveryPayloadTupleSha256 ||
		receipt.parentDelivery.sinkResultUtf8Sha256 !== receipt.sinkResultUtf8Sha256 ||
		receipt.parentDelivery.sinkResultUtf8ByteLength !== receipt.sinkResultUtf8ByteLength
	)
		return false;
	return (
		receipt.receiptSha256 ===
		(await tupleRef([
			"omp-transient-task-result-publication-v1",
			"receipt",
			1,
			resultTargetKeyTuple(key),
			receipt.childOutcome,
			receipt.publishedTerminalOutcome,
			receipt.outcomeSha256,
			receipt.deliveryPayloadRole,
			receipt.deliveryPayloadId,
			receipt.deliveryPayloadDeleteId,
			receipt.deliveryPayloadPutReceiptSha256,
			receipt.deliveryPayloadEnvelopeSha256,
			receipt.deliveryPayloadSha256,
			receipt.deliveryPayloadByteLength,
			receipt.deliveryPayloadTupleSha256,
			receipt.singleResultCompositionReceiptSha256,
			receipt.singleResultCompositionDiagnostic === null
				? null
				: JSON.stringify(receipt.singleResultCompositionDiagnostic),
			receipt.sinkResultUtf8Sha256,
			receipt.sinkResultUtf8ByteLength,
			receipt.terminalEvidenceId,
			receipt.terminalEvidenceSha256,
			[receipt.targetBindingRevision, receipt.targetRenewalSequence, receipt.targetLiveReceiptSha256],
			receipt.deliveryOperationId,
			receipt.parentDeliveryAuthoritySha256,
			receipt.parentDeliveryAttemptSha256,
			receipt.parentDelivery.receiptSha256,
			receipt.publishedAt,
		]))
	);
}

type PublicationPayloadIdentityMismatch = {
	readonly status: "payload_identity_mismatch";
	readonly code:
		| "source_document_sha256_mismatch"
		| "source_document_byte_length_mismatch"
		| "payload_envelope_mismatch"
		| "payload_role_mismatch"
		| "payload_id_mismatch"
		| "parent_delivery_tuple_mismatch"
		| "publication_embedded_parent_delivery_tuple_mismatch";
};

function publicationPayloadMismatch(
	code: PublicationPayloadIdentityMismatch["code"],
): PublicationPayloadIdentityMismatch {
	return { status: "payload_identity_mismatch", code };
}

class PublicationPayloadIdentityMismatchError extends Error {
	readonly mismatch: PublicationPayloadIdentityMismatch;

	constructor(mismatch: PublicationPayloadIdentityMismatch) {
		super("Transient result payload identity is invalid");
		this.mismatch = mismatch;
	}
}

async function validatePendingPayloadIdentity(pending: TransientTaskPendingOutcomeV1) {
	const payload = pending.payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return publicationPayloadMismatch("payload_envelope_mismatch");
	if (payload.storage === "inline_base64") {
		if (
			!strictRecord(payload, [
				"storage",
				"payloadRole",
				"mediaType",
				"bytesBase64",
				"byteLength",
				"payloadSha256",
			]) ||
			payload.payloadRole !== "pending"
		)
			return publicationPayloadMismatch("payload_role_mismatch");
		if (payload.mediaType !== "application/vnd.omp.task-outcome.v1+json")
			return publicationPayloadMismatch("payload_envelope_mismatch");
		const bytes = Buffer.from(payload.bytesBase64, "base64");
		if (bytes.toString("base64") !== payload.bytesBase64)
			return publicationPayloadMismatch("payload_envelope_mismatch");
		if (bytes.byteLength !== payload.byteLength)
			return publicationPayloadMismatch("source_document_byte_length_mismatch");
		if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== payload.payloadSha256)
			return publicationPayloadMismatch("source_document_sha256_mismatch");
		if (pending.payloadPutReceipt !== null) return publicationPayloadMismatch("payload_envelope_mismatch");
	} else if (payload.storage === "opaque_immutable_ref") {
		if (!strictRecord(payload, ["storage", "payloadRef"]) || !validPayloadRef(payload.payloadRef))
			return publicationPayloadMismatch("payload_envelope_mismatch");
		const ref = payload.payloadRef;
		if (ref.payloadRole !== "pending") return publicationPayloadMismatch("payload_role_mismatch");
		if (
			ref.taskId !== pending.taskId ||
			ref.runId !== pending.runId ||
			ref.resultPublicationId !== pending.resultPublicationId ||
			ref.payloadId !== pending.pendingPayloadId
		)
			return publicationPayloadMismatch("payload_id_mismatch");
		if (
			!validPayloadPutReceipt(pending.payloadPutReceipt) ||
			!exactJson(pending.payloadPutReceipt.ref, ref) ||
			pending.payloadPutReceipt.payloadDeleteId !== pending.pendingPayloadDeleteId
		)
			return publicationPayloadMismatch("payload_envelope_mismatch");
	} else {
		return publicationPayloadMismatch("payload_envelope_mismatch");
	}
	return {
		status: "matching",
		deliveryPayloadEnvelopeSha256: await tupleRef(payloadEnvelopeTuple(payload)),
	} as const;
}

function validParentDeliveryEffectDescriptor(
	input: unknown,
	route: Readonly<Record<string, unknown>>,
	parentDeliveryNamespaceId: unknown,
	resultPublicationTargetId: unknown,
): boolean {
	if (input === null) return route.kind === "owner_routed_async_result";
	if (
		!strictRecord(input, ["schemaVersion", "derivation", "descriptorSha256"]) ||
		input.schemaVersion !== 1 ||
		!validResultStoreSha256Ref(input.descriptorSha256) ||
		!strictRecord(input.derivation, ["namespace", "namespaceId", "selector", "domain", "selectorBinding"]) ||
		input.derivation.namespace !== "parent_delivery" ||
		input.derivation.namespaceId !== parentDeliveryNamespaceId ||
		!strictRecord(input.derivation.selector, ["kind", "keyUtf8"]) ||
		input.derivation.selector.kind !== "key" ||
		!isWellFormedString(input.derivation.selector.keyUtf8) ||
		input.derivation.selector.keyUtf8.length === 0
	)
		return false;
	if (route.kind === "foreground_tool_call")
		return (
			input.derivation.domain === "foreground_settlement" &&
			strictRecord(input.derivation.selectorBinding, [
				"resultPublicationTargetId",
				"parentSessionId",
				"toolCallId",
				"foregroundMemberIndex",
			]) &&
			input.derivation.selectorBinding.resultPublicationTargetId === resultPublicationTargetId &&
			input.derivation.selectorBinding.parentSessionId === route.parentSessionId &&
			input.derivation.selectorBinding.toolCallId === route.toolCallId &&
			validResultStoreInteger(input.derivation.selectorBinding.foregroundMemberIndex)
		);
	return (
		route.kind === "owner_routed_async_result" &&
		input.derivation.domain === "detached_enqueue" &&
		strictRecord(input.derivation.selectorBinding, [
			"resultPublicationTargetId",
			"ownerId",
			"jobId",
			"deliveryEpoch",
		]) &&
		input.derivation.selectorBinding.resultPublicationTargetId === resultPublicationTargetId &&
		input.derivation.selectorBinding.ownerId === route.ownerAgentId &&
		input.derivation.selectorBinding.jobId === route.jobId &&
		input.derivation.selectorBinding.deliveryEpoch === route.deliveryEpoch
	);
}

async function validParentDeliveryRequest(
	input: unknown,
	key: TransientTaskResultPublicationTargetKeyV1,
): Promise<boolean> {
	if (!proxyFreeData(input) || !input || typeof input !== "object" || Array.isArray(input) || !("route" in input))
		return false;
	if (input.route === null || typeof input.route !== "object" || Array.isArray(input.route)) return false;
	const routeKind = Object.getOwnPropertyDescriptor(input.route, "kind")?.value;
	if (routeKind !== "foreground_tool_call" && routeKind !== "owner_routed_async_result") return false;
	const detached = routeKind === "owner_routed_async_result";
	if (
		!strictRecord(
			input.route,
			detached
				? ["kind", "ownerAgentId", "jobId", "deliveryEpoch", "sinkLocator", "sinkAuthorization"]
				: ["kind", "parentSessionId", "toolCallId", "sinkLocator", "sinkAuthorization"],
		) ||
		!validResultTargetRoute(input.route)
	)
		return false;
	const route = input.route;
	const keys = [
		"schemaVersion",
		"taskId",
		"runId",
		"createId",
		"resultPublicationId",
		"resultPublicationTargetId",
		"resultPublicationTargetCleanupId",
		"deliveryOperationId",
		"parentDeliveryEffectDerivationDescriptorOrNull",
		"targetBindingRevision",
		"targetRenewalSequence",
		"targetLiveReceiptSha256",
		"deliveryAuthority",
		"deliveryAuthoritySha256",
		"sinkResultUtf8Sha256",
		"sinkResultUtf8ByteLength",
		"pendingOutcomeSha256",
		"singleResultCompositionReceiptSha256",
		"deliveryPayloadRole",
		"deliveryPayloadId",
		"deliveryPayloadDeleteId",
		"deliveryPayloadPutReceiptSha256",
		"deliveryPayload",
		"deliveryPayloadSha256",
		"deliveryPayloadByteLength",
		"deliveryPayloadEnvelopeSha256",
		"deliveryPayloadTupleSha256",
		"deliveryRequestSha256",
		"route",
		"sinkProjection",
		...(detached ? ["detachedDeliveryPolicy"] : ["sourceProjection"]),
	];
	if (!strictRecord(input, keys)) return false;
	const requestKey = resultTargetKeyFromRecord(input);
	if (
		input.schemaVersion !== 1 ||
		!requestKey ||
		!resultTargetKeyMatches(requestKey, key) ||
		!validResultStoreIdentity(input.deliveryOperationId) ||
		!validResultStoreInteger(input.targetBindingRevision, 1) ||
		!validResultStoreInteger(input.targetRenewalSequence) ||
		!validResultStoreSha256Ref(input.targetLiveReceiptSha256) ||
		!validResultStoreSha256Ref(input.deliveryAuthoritySha256) ||
		!validResultStoreSha256Ref(input.sinkResultUtf8Sha256) ||
		!validResultStoreInteger(input.sinkResultUtf8ByteLength) ||
		!validResultStoreSha256Ref(input.pendingOutcomeSha256) ||
		(input.singleResultCompositionReceiptSha256 !== null &&
			!validResultStoreSha256Ref(input.singleResultCompositionReceiptSha256)) ||
		(input.deliveryPayloadRole !== "pending" && input.deliveryPayloadRole !== "composed") ||
		!validResultStoreIdentity(input.deliveryPayloadId) ||
		!validResultStoreIdentity(input.deliveryPayloadDeleteId) ||
		(input.deliveryPayloadPutReceiptSha256 !== null &&
			!validResultStoreSha256Ref(input.deliveryPayloadPutReceiptSha256)) ||
		!validResultStoreSha256Ref(input.deliveryPayloadSha256) ||
		!validResultStoreInteger(input.deliveryPayloadByteLength) ||
		!validResultStoreSha256Ref(input.deliveryPayloadEnvelopeSha256) ||
		!validResultStoreSha256Ref(input.deliveryPayloadTupleSha256) ||
		!validResultStoreSha256Hex(input.deliveryRequestSha256) ||
		!payloadPlainData(input.sinkProjection) ||
		(!detached &&
			(!("sourceProjection" in input) ||
				!payloadPlainData(input.sourceProjection) ||
				input.sourceProjection === null ||
				typeof input.sourceProjection !== "object" ||
				Array.isArray(input.sourceProjection) ||
				Object.getOwnPropertyDescriptor(input.sourceProjection, "kind")?.value !== "foreground_tool_result")) ||
		!strictRecord(input.deliveryAuthority, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"targetBindingRevision",
			"targetRenewalSequence",
			"targetLiveReceiptSha256",
			"effectIdentityManifest",
			"targetAuthority",
			"targetAuthoritySha256",
		])
	)
		return false;
	const authorityKey = resultTargetKeyFromRecord(input.deliveryAuthority);
	if (
		input.deliveryAuthority.schemaVersion !== 1 ||
		!authorityKey ||
		!resultTargetKeyMatches(authorityKey, key) ||
		input.deliveryAuthority.targetBindingRevision !== input.targetBindingRevision ||
		input.deliveryAuthority.targetRenewalSequence !== input.targetRenewalSequence ||
		input.deliveryAuthority.targetLiveReceiptSha256 !== input.targetLiveReceiptSha256 ||
		!validResultTargetManifest(input.deliveryAuthority.effectIdentityManifest, key) ||
		!validResultTargetAuthority(input.deliveryAuthority.targetAuthority) ||
		!validResultStoreSha256Ref(input.deliveryAuthority.targetAuthoritySha256) ||
		input.deliveryAuthority.targetAuthoritySha256 !==
			(await tupleRef(resultTargetAuthorityTuple(input.deliveryAuthority.targetAuthority)))
	)
		return false;
	const manifest = input.deliveryAuthority.effectIdentityManifest;
	if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return false;
	if (
		!validParentDeliveryEffectDescriptor(
			input.parentDeliveryEffectDerivationDescriptorOrNull,
			route,
			Object.getOwnPropertyDescriptor(manifest, "parentDeliveryNamespaceId")?.value,
			input.resultPublicationTargetId,
		)
	)
		return false;
	if (!detached) return route.kind === "foreground_tool_call";
	if (input.sinkProjection === null || typeof input.sinkProjection !== "object" || Array.isArray(input.sinkProjection))
		return false;
	const sinkKind = Object.getOwnPropertyDescriptor(input.sinkProjection, "kind")?.value;
	if (sinkKind === "detached_async_result_entry")
		return (
			route.kind === "owner_routed_async_result" && input.detachedDeliveryPolicy === "current_epoch_enqueue_eligible"
		);
	return (
		sinkKind === "detached_cancelled_job_error" &&
		route.kind === "owner_routed_async_result" &&
		input.detachedDeliveryPolicy === "consumed_without_enqueue_only"
	);
}

async function validatePublicationPayloadIdentity(
	pending: TransientTaskPendingOutcomeV1,
	parentDeliveryRequest: ConfidentialTransientTaskParentResultDeliveryRequestV1,
	publicationRequest: Parameters<TransientTaskResultPublicationStoreV1["publish"]>[0] | null,
	publicationReceipt: TransientTaskResultPublicationReceiptV1 | null,
) {
	const pendingValidation = await validatePendingPayloadIdentity(pending);
	if (pendingValidation.status !== "matching") return pendingValidation;
	const key: TransientTaskResultPublicationTargetKeyV1 = {
		schemaVersion: 1,
		taskId: pending.taskId,
		runId: pending.runId,
		createId: pending.createId,
		resultPublicationId: pending.resultPublicationId,
		resultPublicationTargetId: pending.resultPublicationTargetId,
		resultPublicationTargetCleanupId: pending.resultPublicationTargetCleanupId,
	};
	if (!(await validParentDeliveryRequest(parentDeliveryRequest, key)))
		return publicationPayloadMismatch("parent_delivery_tuple_mismatch");
	const payload = parentDeliveryRequest.deliveryPayload;
	const role = payload.storage === "inline_base64" ? payload.payloadRole : payload.payloadRef.payloadRole;
	const payloadId =
		payload.storage === "opaque_immutable_ref"
			? payload.payloadRef.payloadId
			: parentDeliveryRequest.deliveryPayloadId;
	const payloadSha = payload.storage === "inline_base64" ? payload.payloadSha256 : payload.payloadRef.payloadSha256;
	if (payload.storage === "inline_base64") {
		if (
			!strictRecord(payload, [
				"storage",
				"payloadRole",
				"mediaType",
				"bytesBase64",
				"byteLength",
				"payloadSha256",
			]) ||
			payload.mediaType !== "application/vnd.omp.task-outcome.v1+json" ||
			parentDeliveryRequest.deliveryPayloadPutReceiptSha256 !== null
		)
			return publicationPayloadMismatch("payload_envelope_mismatch");
		const bytes = Buffer.from(payload.bytesBase64, "base64");
		if (bytes.toString("base64") !== payload.bytesBase64)
			return publicationPayloadMismatch("payload_envelope_mismatch");
		if (bytes.byteLength !== payload.byteLength)
			return publicationPayloadMismatch("source_document_byte_length_mismatch");
		if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== payload.payloadSha256)
			return publicationPayloadMismatch("source_document_sha256_mismatch");
	} else if (
		!strictRecord(payload, ["storage", "payloadRef"]) ||
		!validPayloadRef(payload.payloadRef) ||
		payload.payloadRef.taskId !== key.taskId ||
		payload.payloadRef.runId !== key.runId ||
		payload.payloadRef.resultPublicationId !== key.resultPublicationId ||
		parentDeliveryRequest.deliveryPayloadPutReceiptSha256 === null
	) {
		return publicationPayloadMismatch("payload_envelope_mismatch");
	}
	if (
		(pending.outcome === "succeeded" && role !== "composed") ||
		(pending.outcome !== "succeeded" && role !== "pending")
	)
		return publicationPayloadMismatch("payload_role_mismatch");
	const payloadByteLength = payload.storage === "inline_base64" ? payload.byteLength : payload.payloadRef.byteLength;
	if (role !== parentDeliveryRequest.deliveryPayloadRole) return publicationPayloadMismatch("payload_role_mismatch");
	if (payloadId !== parentDeliveryRequest.deliveryPayloadId) return publicationPayloadMismatch("payload_id_mismatch");
	if (payloadSha !== parentDeliveryRequest.deliveryPayloadSha256)
		return publicationPayloadMismatch("source_document_sha256_mismatch");
	if (payloadByteLength !== parentDeliveryRequest.deliveryPayloadByteLength)
		return publicationPayloadMismatch("source_document_byte_length_mismatch");
	const sourceProjection =
		"sourceProjection" in parentDeliveryRequest
			? parentDeliveryRequest.sourceProjection
			: parentDeliveryRequest.sinkProjection;
	if (sourceProjection.sourceOutcomeDocumentSha256 !== payloadSha)
		return publicationPayloadMismatch("source_document_sha256_mismatch");
	if (sourceProjection.sourceOutcomeDocumentByteLength !== payloadByteLength)
		return publicationPayloadMismatch("source_document_byte_length_mismatch");
	const envelopeSha256 = await tupleRef(payloadEnvelopeTuple(payload));
	if (envelopeSha256 !== parentDeliveryRequest.deliveryPayloadEnvelopeSha256)
		return publicationPayloadMismatch("payload_envelope_mismatch");
	if (publicationRequest !== null) {
		if (
			!exactJson(publicationRequest.parentDeliveryRequest, parentDeliveryRequest) ||
			publicationRequest.deliveryPayloadRole !== parentDeliveryRequest.deliveryPayloadRole ||
			publicationRequest.deliveryPayloadId !== parentDeliveryRequest.deliveryPayloadId ||
			publicationRequest.deliveryPayloadDeleteId !== parentDeliveryRequest.deliveryPayloadDeleteId ||
			publicationRequest.deliveryPayloadPutReceiptSha256 !== parentDeliveryRequest.deliveryPayloadPutReceiptSha256 ||
			!exactJson(publicationRequest.deliveryPayload, parentDeliveryRequest.deliveryPayload) ||
			publicationRequest.deliveryPayloadSha256 !== parentDeliveryRequest.deliveryPayloadSha256 ||
			publicationRequest.deliveryPayloadByteLength !== parentDeliveryRequest.deliveryPayloadByteLength ||
			publicationRequest.deliveryPayloadEnvelopeSha256 !== parentDeliveryRequest.deliveryPayloadEnvelopeSha256 ||
			publicationRequest.deliveryPayloadTupleSha256 !== parentDeliveryRequest.deliveryPayloadTupleSha256
		)
			return publicationPayloadMismatch("publication_embedded_parent_delivery_tuple_mismatch");
	}
	if (publicationReceipt !== null) {
		if (!(await validPublicationReceipt(publicationReceipt)))
			return publicationPayloadMismatch("publication_embedded_parent_delivery_tuple_mismatch");
		if (
			publicationReceipt.deliveryPayloadRole !== parentDeliveryRequest.deliveryPayloadRole ||
			publicationReceipt.deliveryPayloadId !== parentDeliveryRequest.deliveryPayloadId ||
			publicationReceipt.deliveryPayloadDeleteId !== parentDeliveryRequest.deliveryPayloadDeleteId ||
			publicationReceipt.deliveryPayloadPutReceiptSha256 !== parentDeliveryRequest.deliveryPayloadPutReceiptSha256 ||
			publicationReceipt.deliveryPayloadSha256 !== parentDeliveryRequest.deliveryPayloadSha256 ||
			publicationReceipt.deliveryPayloadByteLength !== parentDeliveryRequest.deliveryPayloadByteLength ||
			publicationReceipt.deliveryPayloadEnvelopeSha256 !== parentDeliveryRequest.deliveryPayloadEnvelopeSha256 ||
			publicationReceipt.deliveryPayloadTupleSha256 !== parentDeliveryRequest.deliveryPayloadTupleSha256
		)
			return publicationPayloadMismatch("publication_embedded_parent_delivery_tuple_mismatch");
	}
	return {
		status: "matching",
		deliveryPayloadEnvelopeSha256: envelopeSha256,
		deliveryPayloadTupleSha256: parentDeliveryRequest.deliveryPayloadTupleSha256,
	} as const;
}

function validResultlessEncodingRecord(input: unknown): boolean {
	return (
		strictRecord(input, [
			"schemaVersion",
			"outcomeDocument",
			"outcomeDocumentUtf8",
			"outcomeDocumentUtf8ByteLength",
			"outcomeDocumentUtf8Sha256",
		]) &&
		input.schemaVersion === 1 &&
		strictRecord(input.outcomeDocument, [
			"schemaVersion",
			"documentKind",
			"index",
			"id",
			"agent",
			"terminalOutcome",
			"error",
		]) &&
		input.outcomeDocument.schemaVersion === 1 &&
		input.outcomeDocument.documentKind === "resultless_terminal" &&
		validResultStoreInteger(input.outcomeDocument.index) &&
		validResultStoreIdentity(input.outcomeDocument.id) &&
		validResultStoreIdentity(input.outcomeDocument.agent) &&
		(input.outcomeDocument.terminalOutcome === "failed" || input.outcomeDocument.terminalOutcome === "cancelled") &&
		strictRecord(input.outcomeDocument.error, ["code", "source", "structuredSubagentKind", "sourceMessage"]) &&
		input.outcomeDocument.error.code === "resultless_source_unrepresentable" &&
		input.outcomeDocument.error.source === "resultless_projection" &&
		input.outcomeDocument.error.structuredSubagentKind === null &&
		input.outcomeDocument.error.sourceMessage === null &&
		typeof input.outcomeDocumentUtf8 === "string" &&
		validResultStoreInteger(input.outcomeDocumentUtf8ByteLength) &&
		validResultStoreSha256Ref(input.outcomeDocumentUtf8Sha256)
	);
}

async function validStrictPrePendingPlan(input: unknown): Promise<boolean> {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"resultTargetKey",
			"resultlessIdentity",
			"maximumUtf8ByteLength",
			"representabilityPreflight",
			"preflightSha256",
			"planSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validResultTargetKey(input.resultTargetKey) ||
		!strictRecord(input.resultlessIdentity, ["index", "id", "agent"]) ||
		!validResultStoreInteger(input.resultlessIdentity.index) ||
		!validResultStoreIdentity(input.resultlessIdentity.id) ||
		!validResultStoreIdentity(input.resultlessIdentity.agent) ||
		!validResultStoreInteger(input.maximumUtf8ByteLength, 1) ||
		!strictRecord(input.representabilityPreflight, [
			"schemaVersion",
			"identity",
			"maximumUtf8ByteLength",
			"requiredResultlessFallbackUtf8ByteLength",
			"fallbackEncodings",
		]) ||
		input.representabilityPreflight.schemaVersion !== 1 ||
		!strictRecord(input.representabilityPreflight.identity, ["index", "id", "agent"]) ||
		!strictRecord(input.representabilityPreflight.fallbackEncodings, ["failed", "cancelled"]) ||
		!validResultlessEncodingRecord(input.representabilityPreflight.fallbackEncodings.failed) ||
		!validResultlessEncodingRecord(input.representabilityPreflight.fallbackEncodings.cancelled) ||
		!validResultStoreSha256Ref(input.preflightSha256) ||
		!validResultStoreSha256Ref(input.planSha256)
	)
		return false;
	return validPrePendingPlan(
		input as unknown as Parameters<TransientTaskResultPublicationStoreV1["initializePrePending"]>[0]["plan"],
	);
}

async function validInitializationReceipt(
	input: unknown,
	key: TransientTaskResultPublicationTargetKeyV1,
): Promise<boolean> {
	return (
		strictRecord(input, ["resultTargetKey", "planSha256", "requestSha256", "initializedAt", "receiptSha256"]) &&
		validResultTargetKey(input.resultTargetKey) &&
		resultTargetKeyMatches(input.resultTargetKey, key) &&
		validResultStoreSha256Ref(input.planSha256) &&
		validResultStoreSha256Hex(input.requestSha256) &&
		validResultStoreIso8601(input.initializedAt) &&
		validResultStoreSha256Ref(input.receiptSha256) &&
		input.receiptSha256 ===
			(await tupleRef(
				prePendingInitializationReceiptTuple(
					input as unknown as TransientTaskResultPublicationPrePendingInitializationReceiptV1,
				),
			))
	);
}

async function validCancellationReceipt(
	input: unknown,
	key: TransientTaskResultPublicationTargetKeyV1,
): Promise<boolean> {
	if (
		!strictRecord(input, [
			"core",
			"initializationReceiptSha256",
			"requestSha256",
			"acknowledgedAt",
			"receiptSha256",
		]) ||
		!strictRecord(input.core, ["schemaVersion", "resultTargetKey", "planSha256", "kind", "message", "coreSha256"]) ||
		input.core.schemaVersion !== 1 ||
		!validResultTargetKey(input.core.resultTargetKey) ||
		!resultTargetKeyMatches(input.core.resultTargetKey, key) ||
		!validResultStoreSha256Ref(input.core.planSha256) ||
		input.core.kind !== "detached_pre_execution_abort" ||
		input.core.message !== "Aborted before execution" ||
		!validResultStoreSha256Ref(input.core.coreSha256) ||
		!validResultStoreSha256Ref(input.initializationReceiptSha256) ||
		!validResultStoreSha256Hex(input.requestSha256) ||
		!validResultStoreIso8601(input.acknowledgedAt) ||
		!validResultStoreSha256Ref(input.receiptSha256)
	)
		return false;
	const receipt = input as unknown as TransientTaskCancellationAcknowledgementReceiptV1;
	return (
		receipt.core.coreSha256 ===
			(await tupleRef([
				"omp-transient-task-result-publication-v1",
				"cancellation-acknowledgement-core",
				1,
				resultTargetKeyTuple(key),
				receipt.core.planSha256,
				receipt.core.kind,
				receipt.core.message,
			])) && receipt.receiptSha256 === (await tupleRef(cancellationReceiptTuple(receipt)))
	);
}

async function validPendingOutcome(input: unknown, surfacePayloadMismatch = false): Promise<boolean> {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"pendingPayloadId",
			"pendingPayloadDeleteId",
			"outcome",
			"classification",
			"cancellationAcknowledgementReceiptSha256",
			"payload",
			"payloadPutReceipt",
			"capturedAt",
			"outcomeSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!resultTargetKeyFromRecord(input) ||
		!validResultStoreIdentity(input.pendingPayloadId) ||
		!validResultStoreIdentity(input.pendingPayloadDeleteId) ||
		!validResultStoreIso8601(input.capturedAt) ||
		!validResultStoreSha256Ref(input.outcomeSha256)
	)
		return false;
	if (
		(input.outcome === "succeeded" &&
			(input.classification !== "child_completion" || input.cancellationAcknowledgementReceiptSha256 !== null)) ||
		(input.outcome === "failed" &&
			input.classification !== "child_failure" &&
			input.classification !== "controller_interrupted_before_cleanup") ||
		(input.outcome === "failed" && input.cancellationAcknowledgementReceiptSha256 !== null) ||
		(input.outcome === "cancelled" &&
			(input.classification !== "durable_cancellation_acknowledgement" ||
				!validResultStoreSha256Ref(input.cancellationAcknowledgementReceiptSha256))) ||
		(input.outcome !== "succeeded" && input.outcome !== "failed" && input.outcome !== "cancelled")
	)
		return false;
	const pending = input as unknown as TransientTaskPendingOutcomeV1;
	const payload = await validatePendingPayloadIdentity(pending);
	if (payload.status !== "matching") {
		if (surfacePayloadMismatch) throw new PublicationPayloadIdentityMismatchError(payload);
		return false;
	}
	return pending.outcomeSha256 === (await tupleRef(pendingOutcomeTuple(pending)));
}

async function validPendingReceipt(input: unknown, pending: TransientTaskPendingOutcomeV1): Promise<boolean> {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"state",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"pendingPayloadId",
			"pendingPayloadDeleteId",
			"outcome",
			"outcomeSha256",
			"initializationReceiptSha256",
			"predecessorReceiptSha256",
			"cancellationAcknowledgementReceiptSha256",
			"payloadSha256",
			"payloadPutReceiptSha256",
			"requestSha256",
			"recordedAt",
			"receiptSha256",
		]) ||
		input.schemaVersion !== 1 ||
		input.state !== "pending" ||
		!validResultStoreSha256Ref(input.initializationReceiptSha256) ||
		!validResultStoreSha256Ref(input.predecessorReceiptSha256) ||
		!validResultStoreSha256Ref(input.payloadSha256) ||
		(input.payloadPutReceiptSha256 !== null && !validResultStoreSha256Ref(input.payloadPutReceiptSha256)) ||
		!validResultStoreSha256Hex(input.requestSha256) ||
		!validResultStoreIso8601(input.recordedAt) ||
		!validResultStoreSha256Ref(input.receiptSha256)
	)
		return false;
	const receipt = input as unknown as TransientTaskPendingOutcomeReceiptV1;
	const payloadSha256 =
		pending.payload.storage === "inline_base64"
			? pending.payload.payloadSha256
			: pending.payload.payloadRef.payloadSha256;
	return (
		resultTargetKeyMatches(receipt, pending) &&
		receipt.pendingPayloadId === pending.pendingPayloadId &&
		receipt.pendingPayloadDeleteId === pending.pendingPayloadDeleteId &&
		receipt.outcome === pending.outcome &&
		receipt.outcomeSha256 === pending.outcomeSha256 &&
		receipt.cancellationAcknowledgementReceiptSha256 === pending.cancellationAcknowledgementReceiptSha256 &&
		receipt.payloadSha256 === payloadSha256 &&
		receipt.payloadPutReceiptSha256 === (pending.payloadPutReceipt?.receiptSha256 ?? null) &&
		receipt.receiptSha256 ===
			(await tupleRef([
				"omp-transient-task-pending-outcome-v1",
				"receipt",
				1,
				receipt.taskId,
				receipt.runId,
				"pending",
				receipt.createId,
				receipt.resultPublicationId,
				receipt.resultPublicationTargetId,
				receipt.resultPublicationTargetCleanupId,
				receipt.pendingPayloadId,
				receipt.pendingPayloadDeleteId,
				receipt.outcome,
				receipt.outcomeSha256,
				receipt.initializationReceiptSha256,
				receipt.predecessorReceiptSha256,
				receipt.cancellationAcknowledgementReceiptSha256,
				receipt.payloadSha256,
				receipt.payloadPutReceiptSha256,
				receipt.requestSha256,
				receipt.recordedAt,
			]))
	);
}

async function publicationState(input: unknown): Promise<TransientTaskResultPublicationStateV1 | null> {
	if (input === undefined) return null;
	if (!proxyFreeData(input) || !input || typeof input !== "object" || Array.isArray(input) || !("state" in input))
		throw new Error("Transient result publication state is invalid");
	if (input.state === "ready" || input.state === "cancellation_acknowledged") {
		const keys =
			input.state === "ready"
				? ["state", "plan", "initializationReceipt"]
				: ["state", "plan", "initializationReceipt", "cancellationAcknowledgementReceipt"];
		if (!strictRecord(input, keys) || !(await validStrictPrePendingPlan(input.plan)))
			throw new Error("Transient result pre-pending state is invalid");
		const plan = input.plan as unknown as Parameters<
			TransientTaskResultPublicationStoreV1["initializePrePending"]
		>[0]["plan"];
		const key = plan.resultTargetKey;
		const candidate = input as unknown as TransientTaskResultPublicationPrePendingStateV1;
		if (
			!(await validInitializationReceipt(candidate.initializationReceipt, key)) ||
			candidate.initializationReceipt.planSha256 !== plan.planSha256
		)
			throw new Error("Transient result initialization receipt is invalid");
		if (candidate.state === "cancellation_acknowledged") {
			if (
				!(await validCancellationReceipt(candidate.cancellationAcknowledgementReceipt, key)) ||
				candidate.cancellationAcknowledgementReceipt.initializationReceiptSha256 !==
					candidate.initializationReceipt.receiptSha256 ||
				candidate.cancellationAcknowledgementReceipt.core.planSha256 !== plan.planSha256
			)
				throw new Error("Transient result cancellation receipt is invalid");
		}
		return candidate;
	}
	if (input.state === "pending") {
		if (
			!strictRecord(input, [
				"state",
				"childOutcome",
				"publishedTerminalOutcome",
				"singleResultCompositionDiagnostic",
				"initializationReceipt",
				"predecessorReceipt",
				"pending",
				"receipt",
			]) ||
			input.publishedTerminalOutcome !== null ||
			input.singleResultCompositionDiagnostic !== null ||
			!(await validPendingOutcome(input.pending, true))
		)
			throw new Error("Transient result pending state is invalid");
		const pending = input.pending as unknown as TransientTaskPendingOutcomeV1;
		const key = resultTargetKeyFromRecord(pending as unknown as Record<string, unknown>);
		const candidate = input as unknown as Extract<TransientTaskResultPublicationStateV1, { state: "pending" }>;
		if (
			!key ||
			candidate.childOutcome !== pending.outcome ||
			!(await validInitializationReceipt(candidate.initializationReceipt, key)) ||
			!(await validPendingReceipt(candidate.receipt, pending))
		)
			throw new Error("Transient result pending receipts are invalid");
		if (pending.outcome === "cancelled") {
			if (
				!(await validCancellationReceipt(candidate.predecessorReceipt, key)) ||
				candidate.predecessorReceipt.receiptSha256 !== pending.cancellationAcknowledgementReceiptSha256
			)
				throw new Error("Transient result pending cancellation predecessor is invalid");
		} else if (!exactJson(candidate.predecessorReceipt, candidate.initializationReceipt)) {
			throw new Error("Transient result pending predecessor is invalid");
		}
		return candidate;
	}
	if (input.state === "publication_outcome_unknown") {
		if (
			!strictRecord(input, [
				"state",
				"childOutcome",
				"publishedTerminalOutcome",
				"pending",
				"receipt",
				"createId",
				"resultPublicationTargetId",
				"resultPublicationTargetCleanupId",
				"targetBindingRevision",
				"targetRenewalSequence",
				"targetLiveReceiptSha256",
				"deliveryPayloadRole",
				"deliveryPayloadId",
				"deliveryPayloadDeleteId",
				"deliveryPayloadPutReceiptSha256",
				"deliveryPayload",
				"deliveryPayloadSha256",
				"deliveryPayloadByteLength",
				"deliveryPayloadEnvelopeSha256",
				"deliveryPayloadTupleSha256",
				"sinkResultUtf8Sha256",
				"sinkResultUtf8ByteLength",
				"singleResultComposition",
				"singleResultCompositionDiagnostic",
				"terminalEvidenceId",
				"terminalEvidenceSha256",
				"parentDeliveryRequest",
				"parentDeliveryAttemptSha256",
				"publicationRequestSha256",
				"openedAt",
			]) ||
			!(await validPendingOutcome(input.pending, true))
		)
			throw new Error("Transient result publication attempt is invalid");
		const pending = input.pending as unknown as TransientTaskPendingOutcomeV1;
		const key = resultTargetKeyFromRecord(pending as unknown as Record<string, unknown>);
		if (!key || !(await validPendingReceipt(input.receipt, pending)))
			throw new Error("Transient result publication pending receipt is invalid");
		const candidate = input as unknown as Extract<
			TransientTaskResultPublicationStateV1,
			{ state: "publication_outcome_unknown" }
		>;
		const payload = await validatePublicationPayloadIdentity(
			candidate.pending,
			candidate.parentDeliveryRequest,
			null,
			null,
		);
		if (payload.status !== "matching") throw new PublicationPayloadIdentityMismatchError(payload);
		if (
			!resultTargetKeyMatches(candidate.parentDeliveryRequest, key) ||
			candidate.createId !== key.createId ||
			candidate.resultPublicationTargetId !== key.resultPublicationTargetId ||
			candidate.resultPublicationTargetCleanupId !== key.resultPublicationTargetCleanupId ||
			candidate.childOutcome !== candidate.pending.outcome ||
			candidate.receipt.outcomeSha256 !== candidate.pending.outcomeSha256 ||
			candidate.targetBindingRevision !== candidate.parentDeliveryRequest.targetBindingRevision ||
			candidate.targetRenewalSequence !== candidate.parentDeliveryRequest.targetRenewalSequence ||
			candidate.targetLiveReceiptSha256 !== candidate.parentDeliveryRequest.targetLiveReceiptSha256 ||
			candidate.deliveryPayloadRole !== candidate.parentDeliveryRequest.deliveryPayloadRole ||
			candidate.deliveryPayloadId !== candidate.parentDeliveryRequest.deliveryPayloadId ||
			candidate.deliveryPayloadDeleteId !== candidate.parentDeliveryRequest.deliveryPayloadDeleteId ||
			candidate.deliveryPayloadPutReceiptSha256 !==
				candidate.parentDeliveryRequest.deliveryPayloadPutReceiptSha256 ||
			!exactJson(candidate.deliveryPayload, candidate.parentDeliveryRequest.deliveryPayload) ||
			candidate.deliveryPayloadSha256 !== candidate.parentDeliveryRequest.deliveryPayloadSha256 ||
			candidate.deliveryPayloadByteLength !== candidate.parentDeliveryRequest.deliveryPayloadByteLength ||
			candidate.deliveryPayloadEnvelopeSha256 !== candidate.parentDeliveryRequest.deliveryPayloadEnvelopeSha256 ||
			candidate.deliveryPayloadTupleSha256 !== candidate.parentDeliveryRequest.deliveryPayloadTupleSha256 ||
			candidate.sinkResultUtf8Sha256 !== candidate.parentDeliveryRequest.sinkResultUtf8Sha256 ||
			candidate.sinkResultUtf8ByteLength !== candidate.parentDeliveryRequest.sinkResultUtf8ByteLength ||
			!validResultStoreSha256Ref(candidate.parentDeliveryAttemptSha256) ||
			!validResultStoreSha256Hex(candidate.publicationRequestSha256) ||
			!validResultStoreIso8601(candidate.openedAt)
		)
			throw new Error("Transient result publication attempt identity is invalid");
		return candidate;
	}
	if (input.state === "published") {
		if (
			!strictRecord(input, [
				"state",
				"childOutcome",
				"publishedTerminalOutcome",
				"singleResultCompositionDiagnostic",
				"pending",
				"pendingReceipt",
				"publicationReceipt",
			]) ||
			!(await validPendingOutcome(input.pending, true))
		)
			throw new Error("Transient result published state is invalid");
		const pending = input.pending as unknown as TransientTaskPendingOutcomeV1;
		const candidate = input as unknown as Extract<TransientTaskResultPublicationStateV1, { state: "published" }>;
		if (
			!(await validPendingReceipt(candidate.pendingReceipt, pending)) ||
			!(await validPublicationReceipt(candidate.publicationReceipt)) ||
			candidate.childOutcome !== pending.outcome ||
			candidate.publicationReceipt.childOutcome !== candidate.childOutcome ||
			candidate.publicationReceipt.publishedTerminalOutcome !== candidate.publishedTerminalOutcome ||
			candidate.publicationReceipt.outcomeSha256 !== pending.outcomeSha256 ||
			!resultTargetKeyMatches(candidate.publicationReceipt, pending)
		)
			throw new Error("Transient result publication receipt is invalid");
		return candidate;
	}
	throw new Error("Transient result publication state discriminator is invalid");
}

export type TransientTaskResultPublicationDeliveryResultV1 =
	| {
			readonly status: "delivered" | "already_delivered";
			readonly receipt: TransientTaskParentResultDeliveryReceiptV1;
	  }
	| {
			readonly status: "consumed_without_enqueue" | "already_consumed_without_enqueue";
			readonly receipt: TransientTaskParentResultDeliveryReceiptV1;
	  }
	| { readonly status: "delivery_outcome_unknown" }
	| { readonly status: "terminal_non_delivery" | "conflict" | "invalid" };

export interface TransientTaskResultPublicationDeliveryV1 {
	deliver(
		request: ConfidentialTransientTaskParentResultDeliveryRequestV1,
		expectedAttemptSha256: Sha256Ref,
	): Promise<TransientTaskResultPublicationDeliveryResultV1>;
}

type PrivateTransientTaskResultPublicationDeliveryReconciliationV1 =
	| TransientTaskResultPublicationDeliveryResultV1
	| { readonly status: "not_applied" };

type PrivateTransientTaskResultPublicationDeliveryDispatchV1 =
	| TransientTaskResultPublicationDeliveryResultV1
	| { readonly status: "response_lost" };

function parentDeliveryInspectRequestForPublication(
	request: ConfidentialTransientTaskParentResultDeliveryRequestV1,
	expectedAttemptSha256: Sha256Ref,
): TransientTaskParentResultDeliveryInspectRequestV1 {
	return {
		schemaVersion: request.schemaVersion,
		taskId: request.taskId,
		runId: request.runId,
		createId: request.createId,
		resultPublicationId: request.resultPublicationId,
		resultPublicationTargetId: request.resultPublicationTargetId,
		resultPublicationTargetCleanupId: request.resultPublicationTargetCleanupId,
		deliveryOperationId: request.deliveryOperationId,
		targetBindingRevision: request.targetBindingRevision,
		targetRenewalSequence: request.targetRenewalSequence,
		targetLiveReceiptSha256: request.targetLiveReceiptSha256,
		deliveryAuthoritySha256: request.deliveryAuthoritySha256,
		expectedAttemptSha256,
		sinkResultUtf8Sha256: request.sinkResultUtf8Sha256,
		sinkResultUtf8ByteLength: request.sinkResultUtf8ByteLength,
		pendingOutcomeSha256: request.pendingOutcomeSha256,
		singleResultCompositionReceiptSha256: request.singleResultCompositionReceiptSha256,
		deliveryPayloadRole: request.deliveryPayloadRole,
		deliveryPayloadId: request.deliveryPayloadId,
		deliveryPayloadDeleteId: request.deliveryPayloadDeleteId,
		deliveryPayloadPutReceiptSha256: request.deliveryPayloadPutReceiptSha256,
		deliveryPayloadSha256: request.deliveryPayloadSha256,
		deliveryPayloadByteLength: request.deliveryPayloadByteLength,
		deliveryPayloadEnvelopeSha256: request.deliveryPayloadEnvelopeSha256,
		deliveryPayloadTupleSha256: request.deliveryPayloadTupleSha256,
		deliveryRequestSha256: request.deliveryRequestSha256,
	};
}

function parentDeliveryReceiptMatchesPublication(
	receipt: TransientTaskParentResultDeliveryReceiptV1 | ConfidentialTransientTaskParentResultNonDeliveryReceiptV1,
	request: ConfidentialTransientTaskParentResultDeliveryRequestV1,
	expectedAttemptSha256: Sha256Ref,
): boolean {
	if (!validParentDeliveryReceipt(receipt) && !validParentNonDeliveryReceipt(receipt)) return false;
	return (
		resultTargetKeyMatches(receipt, request) &&
		receipt.deliveryOperationId === request.deliveryOperationId &&
		receipt.targetBindingRevision === request.targetBindingRevision &&
		receipt.targetRenewalSequence === request.targetRenewalSequence &&
		receipt.targetLiveReceiptSha256 === request.targetLiveReceiptSha256 &&
		receipt.deliveryAuthoritySha256 === request.deliveryAuthoritySha256 &&
		receipt.deliveryAttemptSha256 === expectedAttemptSha256 &&
		receipt.sinkResultUtf8Sha256 === request.sinkResultUtf8Sha256 &&
		receipt.sinkResultUtf8ByteLength === request.sinkResultUtf8ByteLength &&
		receipt.pendingOutcomeSha256 === request.pendingOutcomeSha256 &&
		receipt.singleResultCompositionReceiptSha256 === request.singleResultCompositionReceiptSha256 &&
		receipt.deliveryPayloadRole === request.deliveryPayloadRole &&
		receipt.deliveryPayloadId === request.deliveryPayloadId &&
		receipt.deliveryPayloadDeleteId === request.deliveryPayloadDeleteId &&
		receipt.deliveryPayloadPutReceiptSha256 === request.deliveryPayloadPutReceiptSha256 &&
		receipt.deliveryPayloadSha256 === request.deliveryPayloadSha256 &&
		receipt.deliveryPayloadByteLength === request.deliveryPayloadByteLength &&
		receipt.deliveryPayloadEnvelopeSha256 === request.deliveryPayloadEnvelopeSha256 &&
		receipt.deliveryPayloadTupleSha256 === request.deliveryPayloadTupleSha256 &&
		receipt.deliveryRequestSha256 === request.deliveryRequestSha256 &&
		receipt.routeKind === request.route.kind
	);
}
function detachedParentDeliveryRequest(
	request: ConfidentialTransientTaskParentResultDeliveryRequestV1,
): request is Extract<
	ConfidentialTransientTaskParentResultDeliveryRequestV1,
	{ readonly route: { readonly kind: "owner_routed_async_result" } }
> {
	return request.route.kind === "owner_routed_async_result" && "detachedDeliveryPolicy" in request;
}

/** Production result-publication adapter over the sole authoritative parent-delivery store. */

function publicationControllerLifecycleMatches(
	state: TransientTaskRuntimeStateV1,
	key: TransientTaskResultPublicationTargetKeyV1,
	proof: TransientTaskControllerAuthorityProofV1,
	expectedRevision?: number,
	expectedFencingGeneration?: number,
): boolean {
	const current = state.authority;
	return (
		validResultTargetControllerProof(proof) &&
		resultTargetLifecycleMatches(state, key, { kind: "controller", proof }) &&
		current !== null &&
		(expectedRevision === undefined || current.revision === expectedRevision) &&
		(expectedFencingGeneration === undefined || proof.fencingGeneration === expectedFencingGeneration)
	);
}

function publicationTerminalLifecycleMatches(
	state: TransientTaskRuntimeStateV1,
	key: TransientTaskResultPublicationTargetKeyV1,
	evidence: Parameters<TransientTaskResultPublicationStoreV1["publish"]>[0]["terminalEvidence"],
): boolean {
	const current = state.authority;
	return (
		validPayloadTerminalEvidence(evidence) &&
		resultTargetLifecycleMatches(state, key, {
			kind: "terminal",
			terminalEvidenceId: evidence.evidenceId,
			terminalEvidenceSha256: evidence.evidenceSha256,
		}) &&
		current !== null &&
		(current.state === "deleted" || current.state === "discarded") &&
		exactJson(current.cleanup.progress.evidence, evidence)
	);
}

async function publicationLiveTarget(
	state: TransientTaskRuntimeStateV1,
	key: TransientTaskResultPublicationTargetKeyV1,
	targetBindingRevision: number,
	targetRenewalSequence: number,
	targetLiveReceiptSha256: Sha256Ref,
	route: ConfidentialTransientTaskParentResultDeliveryRequestV1["route"],
	observedAt: ISO8601,
): Promise<PrivateResultTargetRowV1 | null> {
	const row = await resultTargetRow(state.resultTargets[resultTargetMapKey(key)]);
	if (!row?.binding || row.state.state !== "bound" || !exactJson(row.binding.route, route)) return null;
	const live = row.state.liveReceipt;
	return live.bindingRevision === targetBindingRevision &&
		live.renewalSequence === targetRenewalSequence &&
		live.receiptSha256 === targetLiveReceiptSha256 &&
		Date.parse(live.expiresAt) > Date.parse(observedAt)
		? row
		: null;
}

async function publicationRequestMatchesCurrentLifecycle(
	state: TransientTaskRuntimeStateV1,
	request: Parameters<TransientTaskResultPublicationStoreV1["publish"]>[0],
	observedAt: ISO8601,
): Promise<boolean> {
	const key = resultTargetKeyFromRecord(request as unknown as Record<string, unknown>);
	if (
		!key ||
		!publicationTerminalLifecycleMatches(state, key, request.terminalEvidence) ||
		!(await validParentDeliveryRequest(request.parentDeliveryRequest, key)) ||
		!(await publicationLiveTarget(
			state,
			key,
			request.targetBindingRevision,
			request.targetRenewalSequence,
			request.targetLiveReceiptSha256,
			request.parentDeliveryRequest.route,
			observedAt,
		))
	)
		return false;
	const current = state.authority;
	const deliveryAuthority = request.parentDeliveryRequest.deliveryAuthority;
	return (
		current !== null &&
		exactJson(deliveryAuthority.effectIdentityManifest, current.effectIdentityManifest) &&
		deliveryAuthority.targetAuthority.kind === "terminal" &&
		deliveryAuthority.targetAuthority.terminalEvidenceId === request.terminalEvidence.evidenceId &&
		deliveryAuthority.targetAuthority.terminalEvidenceSha256 === request.terminalEvidence.evidenceSha256 &&
		request.parentDeliveryRequest.targetBindingRevision === request.targetBindingRevision &&
		request.parentDeliveryRequest.targetRenewalSequence === request.targetRenewalSequence &&
		request.parentDeliveryRequest.targetLiveReceiptSha256 === request.targetLiveReceiptSha256
	);
}

function validCompositionDiagnostic(input: unknown): input is TransientTaskSingleResultCompositionDiagnosticV1 {
	if (
		!strictRecord(input, [
			"compositionStatus",
			"sourceDisposition",
			"observedUtf8ByteLength",
			"maximumUtf8ByteLength",
		])
	)
		return false;
	if (input.compositionStatus === "composed")
		return (
			input.sourceDisposition === null &&
			input.observedUtf8ByteLength === null &&
			input.maximumUtf8ByteLength === null
		);
	if (input.compositionStatus === "single_result_invalid")
		return (
			(input.sourceDisposition === "exact" || input.sourceDisposition === "fixed_unrepresentable_fallback") &&
			input.observedUtf8ByteLength === null &&
			input.maximumUtf8ByteLength === null
		);
	return (
		input.compositionStatus === "single_result_payload_too_large" &&
		(input.sourceDisposition === "exact" || input.sourceDisposition === "fixed_unrepresentable_fallback") &&
		validResultStoreInteger(input.observedUtf8ByteLength) &&
		validResultStoreInteger(input.maximumUtf8ByteLength)
	);
}

function validSingleResultCompositionReceipt(
	input: unknown,
): input is NonNullable<Parameters<TransientTaskResultPublicationStoreV1["publish"]>[0]["singleResultComposition"]> {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"resultCompositionId",
			"resultPublicationId",
			"pendingOutcomeSha256",
			"childOutcome",
			"publishedTerminalOutcome",
			"captureId",
			"captureReceiptSha256",
			"isolationCleanupReceiptSha256",
			"publicationTargetReleaseReceiptSha256",
			"capturedFieldsSha256",
			"composedPayloadId",
			"composedPayloadDeleteId",
			"composedPayloadPutReceiptSha256",
			"outcomeDocumentUtf8Sha256",
			"outcomeDocumentUtf8ByteLength",
			"deliveryPayloadSha256",
			"deliveryPayloadByteLength",
			"compositionRequestSha256",
			"composedAt",
			"receiptSha256",
			"compositionStatus",
			"sourceDisposition",
			"observedUtf8ByteLength",
			"maximumUtf8ByteLength",
			"applyChanges",
			"semanticMergeId",
			"semanticMergeFinishId",
			"semanticMergeReceiptSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validResultStoreIdentity(input.taskId) ||
		!validResultStoreIdentity(input.runId) ||
		!validResultStoreIdentity(input.resultCompositionId) ||
		!validResultStoreIdentity(input.resultPublicationId) ||
		!validResultStoreSha256Ref(input.pendingOutcomeSha256) ||
		input.childOutcome !== "succeeded" ||
		(input.publishedTerminalOutcome !== "succeeded" && input.publishedTerminalOutcome !== "failed") ||
		!validResultStoreIdentity(input.captureId) ||
		!validResultStoreSha256Ref(input.captureReceiptSha256) ||
		!validResultStoreSha256Ref(input.isolationCleanupReceiptSha256) ||
		!validResultStoreSha256Ref(input.publicationTargetReleaseReceiptSha256) ||
		!validResultStoreSha256Ref(input.capturedFieldsSha256) ||
		!validResultStoreIdentity(input.composedPayloadId) ||
		!validResultStoreIdentity(input.composedPayloadDeleteId) ||
		(input.composedPayloadPutReceiptSha256 !== null &&
			!validResultStoreSha256Ref(input.composedPayloadPutReceiptSha256)) ||
		!validResultStoreSha256Ref(input.outcomeDocumentUtf8Sha256) ||
		!validResultStoreInteger(input.outcomeDocumentUtf8ByteLength) ||
		!validResultStoreSha256Ref(input.deliveryPayloadSha256) ||
		!validResultStoreInteger(input.deliveryPayloadByteLength) ||
		!validResultStoreSha256Hex(input.compositionRequestSha256) ||
		!validResultStoreIso8601(input.composedAt) ||
		!validResultStoreSha256Ref(input.receiptSha256) ||
		!validCompositionDiagnostic({
			compositionStatus: input.compositionStatus,
			sourceDisposition: input.sourceDisposition,
			observedUtf8ByteLength: input.observedUtf8ByteLength,
			maximumUtf8ByteLength: input.maximumUtf8ByteLength,
		})
	)
		return false;
	return input.applyChanges === false
		? input.semanticMergeId === null &&
				input.semanticMergeFinishId === null &&
				input.semanticMergeReceiptSha256 === null
		: input.applyChanges === true &&
				((input.semanticMergeId === null &&
					input.semanticMergeFinishId === null &&
					input.semanticMergeReceiptSha256 === null) ||
					(validResultStoreIdentity(input.semanticMergeId) &&
						validResultStoreIdentity(input.semanticMergeFinishId) &&
						validResultStoreSha256Ref(input.semanticMergeReceiptSha256)));
}

function validPublicationRequestShape(
	request: Parameters<TransientTaskResultPublicationStoreV1["publish"]>[0],
): boolean {
	const key = resultTargetKeyFromRecord(request as unknown as Record<string, unknown>);
	if (
		!strictRecord(request, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"targetBindingRevision",
			"targetRenewalSequence",
			"targetLiveReceiptSha256",
			"pendingOutcomeSha256",
			"childOutcome",
			"publishedTerminalOutcome",
			"deliveryPayloadRole",
			"deliveryPayloadId",
			"deliveryPayloadDeleteId",
			"deliveryPayloadPutReceiptSha256",
			"deliveryPayload",
			"deliveryPayloadSha256",
			"deliveryPayloadByteLength",
			"deliveryPayloadEnvelopeSha256",
			"deliveryPayloadTupleSha256",
			"singleResultComposition",
			"singleResultCompositionDiagnostic",
			"terminalEvidence",
			"parentDeliveryRequest",
			"parentDeliveryAttemptSha256",
			"publicationRequestSha256",
		]) ||
		!key ||
		!validResultTargetKey(key) ||
		!validResultStoreInteger(request.targetBindingRevision, 1) ||
		!validResultStoreInteger(request.targetRenewalSequence) ||
		!validResultStoreSha256Ref(request.targetLiveReceiptSha256) ||
		!validResultStoreSha256Ref(request.pendingOutcomeSha256) ||
		(request.childOutcome !== "succeeded" &&
			request.childOutcome !== "failed" &&
			request.childOutcome !== "cancelled") ||
		(request.publishedTerminalOutcome !== "succeeded" &&
			request.publishedTerminalOutcome !== "failed" &&
			request.publishedTerminalOutcome !== "cancelled") ||
		(request.deliveryPayloadRole !== "pending" && request.deliveryPayloadRole !== "composed") ||
		!validResultStoreIdentity(request.deliveryPayloadId) ||
		!validResultStoreIdentity(request.deliveryPayloadDeleteId) ||
		(request.deliveryPayloadPutReceiptSha256 !== null &&
			!validResultStoreSha256Ref(request.deliveryPayloadPutReceiptSha256)) ||
		!validResultStoreSha256Ref(request.deliveryPayloadSha256) ||
		!validResultStoreInteger(request.deliveryPayloadByteLength) ||
		!validResultStoreSha256Ref(request.deliveryPayloadEnvelopeSha256) ||
		!validResultStoreSha256Ref(request.deliveryPayloadTupleSha256) ||
		!validPayloadTerminalEvidence(request.terminalEvidence) ||
		!validResultStoreSha256Ref(request.parentDeliveryAttemptSha256) ||
		!validResultStoreSha256Hex(request.publicationRequestSha256)
	)
		return false;
	if (request.childOutcome === "succeeded") {
		return (
			request.deliveryPayloadRole === "composed" &&
			validSingleResultCompositionReceipt(request.singleResultComposition) &&
			validCompositionDiagnostic(request.singleResultCompositionDiagnostic) &&
			exactJson(
				compositionDiagnosticTuple(request.singleResultCompositionDiagnostic),
				compositionDiagnosticTuple(request.singleResultComposition),
			) &&
			request.singleResultComposition.taskId === request.taskId &&
			request.singleResultComposition.runId === request.runId &&
			request.singleResultComposition.resultPublicationId === request.resultPublicationId &&
			request.singleResultComposition.pendingOutcomeSha256 === request.pendingOutcomeSha256 &&
			request.singleResultComposition.publishedTerminalOutcome === request.publishedTerminalOutcome &&
			request.singleResultComposition.composedPayloadId === request.deliveryPayloadId &&
			request.singleResultComposition.composedPayloadDeleteId === request.deliveryPayloadDeleteId &&
			request.singleResultComposition.composedPayloadPutReceiptSha256 === request.deliveryPayloadPutReceiptSha256 &&
			request.singleResultComposition.deliveryPayloadSha256 === request.deliveryPayloadSha256 &&
			request.singleResultComposition.deliveryPayloadByteLength === request.deliveryPayloadByteLength
		);
	}
	return (
		request.deliveryPayloadRole === "pending" &&
		request.singleResultComposition === null &&
		request.singleResultCompositionDiagnostic === null
	);
}

function parentDeliveryReceiptMatchesPublicationRequest(
	receipt: TransientTaskParentResultDeliveryReceiptV1,
	request: Parameters<TransientTaskResultPublicationStoreV1["publish"]>[0],
): boolean {
	const parent = request.parentDeliveryRequest;
	return (
		validParentDeliveryReceipt(receipt) &&
		resultTargetKeyMatches(receipt, request) &&
		receipt.deliveryOperationId === parent.deliveryOperationId &&
		receipt.deliveryAuthoritySha256 === parent.deliveryAuthoritySha256 &&
		receipt.deliveryAttemptSha256 === request.parentDeliveryAttemptSha256 &&
		receipt.targetBindingRevision === request.targetBindingRevision &&
		receipt.targetRenewalSequence === request.targetRenewalSequence &&
		receipt.targetLiveReceiptSha256 === request.targetLiveReceiptSha256 &&
		receipt.pendingOutcomeSha256 === request.pendingOutcomeSha256 &&
		receipt.singleResultCompositionReceiptSha256 === (request.singleResultComposition?.receiptSha256 ?? null) &&
		receipt.deliveryPayloadRole === request.deliveryPayloadRole &&
		receipt.deliveryPayloadId === request.deliveryPayloadId &&
		receipt.deliveryPayloadDeleteId === request.deliveryPayloadDeleteId &&
		receipt.deliveryPayloadPutReceiptSha256 === request.deliveryPayloadPutReceiptSha256 &&
		receipt.deliveryPayloadSha256 === request.deliveryPayloadSha256 &&
		receipt.deliveryPayloadByteLength === request.deliveryPayloadByteLength &&
		receipt.deliveryPayloadEnvelopeSha256 === request.deliveryPayloadEnvelopeSha256 &&
		receipt.deliveryPayloadTupleSha256 === request.deliveryPayloadTupleSha256 &&
		receipt.sinkResultUtf8Sha256 === parent.sinkResultUtf8Sha256 &&
		receipt.sinkResultUtf8ByteLength === parent.sinkResultUtf8ByteLength &&
		receipt.deliveryRequestSha256 === parent.deliveryRequestSha256 &&
		receipt.routeKind === parent.route.kind
	);
}

type PrivateParentDeliveryReceiptV1 =
	| TransientTaskParentResultDeliveryReceiptV1
	| ConfidentialTransientTaskParentResultNonDeliveryReceiptV1;
type WithoutReceiptSha256<Value extends { readonly receiptSha256: Sha256Ref }> = Value extends unknown
	? Omit<Value, "receiptSha256">
	: never;
type PrivateParentDeliveryReceiptCoreV1 = WithoutReceiptSha256<PrivateParentDeliveryReceiptV1>;
type PrivateParentDeliveryReceiptTupleInputV1 = PrivateParentDeliveryReceiptV1 | PrivateParentDeliveryReceiptCoreV1;

type PrivateParentDeliveryRowV1 =
	| {
			readonly state: "not_applied" | "outcome_unknown";
			readonly attempt: ConfidentialTransientTaskParentResultDeliveryAttemptV1;
			readonly receipt: null;
	  }
	| {
			readonly state: "terminal";
			readonly attempt: ConfidentialTransientTaskParentResultDeliveryAttemptV1;
			readonly receipt: PrivateParentDeliveryReceiptV1;
	  };

type PrivateParentDeliveryEffectRequestV1 = Parameters<TransientTaskParentResultDeliveryStoreV1["deliver"]>[0];
type PrivateForegroundParentDeliveryEffectRequestV1 = Extract<
	PrivateParentDeliveryEffectRequestV1,
	{ request: { route: { kind: "foreground_tool_call" } } }
>;
type PrivateDetachedParentDeliveryEffectRequestV1 = Extract<
	PrivateParentDeliveryEffectRequestV1,
	{ request: { route: { kind: "owner_routed_async_result" } } }
>;

function parentDeliveryReceiptBase(
	request: ConfidentialTransientTaskParentResultDeliveryRequestV1,
	deliveryAttemptSha256: Sha256Ref,
	completedAt: ISO8601,
) {
	return {
		schemaVersion: 1 as const,
		taskId: request.taskId,
		runId: request.runId,
		createId: request.createId,
		resultPublicationId: request.resultPublicationId,
		resultPublicationTargetId: request.resultPublicationTargetId,
		resultPublicationTargetCleanupId: request.resultPublicationTargetCleanupId,
		deliveryOperationId: request.deliveryOperationId,
		targetBindingRevision: request.targetBindingRevision,
		targetRenewalSequence: request.targetRenewalSequence,
		targetLiveReceiptSha256: request.targetLiveReceiptSha256,
		deliveryAuthoritySha256: request.deliveryAuthoritySha256,
		deliveryAttemptSha256,
		sinkResultUtf8Sha256: request.sinkResultUtf8Sha256,
		sinkResultUtf8ByteLength: request.sinkResultUtf8ByteLength,
		pendingOutcomeSha256: request.pendingOutcomeSha256,
		singleResultCompositionReceiptSha256: request.singleResultCompositionReceiptSha256,
		deliveryPayloadRole: request.deliveryPayloadRole,
		deliveryPayloadId: request.deliveryPayloadId,
		deliveryPayloadDeleteId: request.deliveryPayloadDeleteId,
		deliveryPayloadPutReceiptSha256: request.deliveryPayloadPutReceiptSha256,
		deliveryPayloadSha256: request.deliveryPayloadSha256,
		deliveryPayloadByteLength: request.deliveryPayloadByteLength,
		deliveryPayloadEnvelopeSha256: request.deliveryPayloadEnvelopeSha256,
		deliveryPayloadTupleSha256: request.deliveryPayloadTupleSha256,
		deliveryRequestSha256: request.deliveryRequestSha256,
		completedAt,
	};
}
function parentDeliveryOutcomeTuple(
	receipt: PrivateParentDeliveryReceiptTupleInputV1,
): readonly CanonicalRuntimeValue[] {
	if (receipt.routeKind === "foreground_tool_call") {
		return [
			receipt.outcome,
			receipt.routeKind,
			receipt.sinkReceiptSha256,
			receipt.foregroundSettlementIdentitySha256,
			receipt.foregroundAppendBatchKeySha256,
			receipt.foregroundPrimaryReceiptSha256,
			receipt.foregroundBatchTransitionReceiptSha256,
			null,
		];
	}
	if (receipt.outcome === "delivered" || receipt.outcome === "consumed_without_enqueue") {
		return [
			receipt.outcome,
			receipt.routeKind,
			receipt.sinkReceiptSha256,
			receipt.foregroundSettlementIdentitySha256,
			receipt.foregroundPrimaryReceiptSha256,
			receipt.foregroundBatchTransitionReceiptSha256,
			receipt.detachedSettlement.receiptSha256,
		];
	}
	return [receipt.outcome, receipt.routeKind, receipt.detachedSettlement.receiptSha256];
}

function parentDeliveryReceiptTuple(
	receipt: PrivateParentDeliveryReceiptTupleInputV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-parent-result-delivery-v1",
		"receipt",
		1,
		resultTargetKeyTuple(receipt),
		receipt.deliveryOperationId,
		[receipt.targetBindingRevision, receipt.targetRenewalSequence, receipt.targetLiveReceiptSha256],
		receipt.deliveryAuthoritySha256,
		receipt.deliveryAttemptSha256,
		receipt.sinkResultUtf8Sha256,
		receipt.sinkResultUtf8ByteLength,
		receipt.pendingOutcomeSha256,
		receipt.singleResultCompositionReceiptSha256,
		receipt.deliveryPayloadRole,
		receipt.deliveryPayloadId,
		receipt.deliveryPayloadDeleteId,
		receipt.deliveryPayloadPutReceiptSha256,
		receipt.deliveryPayloadEnvelopeSha256,
		receipt.deliveryPayloadSha256,
		receipt.deliveryPayloadByteLength,
		receipt.deliveryPayloadTupleSha256,
		receipt.deliveryRequestSha256,
		parentDeliveryOutcomeTuple(receipt),
		receipt.completedAt,
	];
}

function parentDeliveryTerminalResult(receipt: PrivateParentDeliveryReceiptV1, repeated: boolean) {
	if (receipt.outcome === "delivered")
		return { status: repeated ? ("already_delivered" as const) : ("delivered" as const), receipt };
	if (receipt.outcome === "consumed_without_enqueue")
		return {
			status: repeated ? ("already_consumed_without_enqueue" as const) : ("consumed_without_enqueue" as const),
			receipt,
		};
	if (receipt.outcome === "delivery_epoch_invalidated")
		return { status: "delivery_epoch_invalidated" as const, receipt };
	return { status: "dead_lettered" as const, receipt };
}

function parentDeliveryMapKey(key: TransientTaskResultPublicationTargetKeyV1): string {
	return `parent\u0000${publicationMapKey(key)}`;
}

function foregroundDomainIndexKey(foregroundAppendBatchKeySha256: Sha256Ref): string {
	return `foreground-domain-index\u0000${foregroundAppendBatchKeySha256}`;
}

function foregroundSessionIndexKey(parentSessionId: string): string {
	return `foreground-session-index\u0000${parentSessionId}`;
}

type PrivateForegroundHandoffBatchV1 = Parameters<TransientTaskForegroundResultSettlementStoreV1["prepareHandoff"]>[0];
type PrivateForegroundRenderedResultV1 = Parameters<
	TransientTaskForegroundResultSettlementStoreV1["prepareRenderedResult"]
>[0];
type PrivateForegroundAppendPrepareRequestV1 = Parameters<
	TransientTaskForegroundResultSettlementStoreV1["prepareAppend"]
>[0];
type PrivateForegroundInspectRequestV1 = Parameters<TransientTaskForegroundResultSettlementStoreV1["inspect"]>[0];
type PrivateForegroundAdoptRequestV1 = Parameters<TransientTaskForegroundResultSettlementStoreV1["adopt"]>[0];
type PrivateForegroundPendingRequestV1 = Parameters<
	TransientTaskForegroundResultSettlementStoreV1["enumeratePendingHandoffs"]
>[0];
type PrivateForegroundRenderedResumeRequestV1 = Parameters<
	TransientTaskForegroundResultSettlementStoreV1["resumeRenderedResult"]
>[0];
type PrivateForegroundPreOverlayGateV1 = Parameters<
	TransientTaskForegroundAfterToolCallGateBridgeV1["appendPreOverlayGate"]
>[0];
type PrivateForegroundRenderedGateV1 = Parameters<
	TransientTaskForegroundAfterToolCallGateBridgeV1["appendRenderedGate"]
>[0];
type PrivateForegroundGateInspectRequestV1 = Parameters<
	TransientTaskForegroundAfterToolCallGateBridgeV1["inspectAfterToolCallGate"]
>[0];
type PrivateForegroundSuspensionV1 = PrivateForegroundRenderedResumeRequestV1["suspension"];
type PrivateForegroundAppendBatchV1 = PrivateForegroundAppendPrepareRequestV1["batch"];
type PrivateForegroundAppendAttemptV1 = PrivateForegroundAppendPrepareRequestV1["attempts"][number];
type PrivateForegroundNotAppliedProofV1 = TransientTaskForegroundResultAppendNotAppliedProofV1;

type PrivateForegroundTaggedValueV1 =
	| { readonly t: "undefined" }
	| { readonly t: "null" }
	| { readonly t: "boolean"; readonly v: boolean }
	| { readonly t: "number"; readonly v: number }
	| { readonly t: "string"; readonly v: string }
	| { readonly t: "array"; readonly v: readonly PrivateForegroundTaggedValueV1[] }
	| {
			readonly t: "object";
			readonly p: "object" | "null";
			readonly v: readonly (readonly [string, PrivateForegroundTaggedValueV1])[];
	  };

interface PrivateForegroundStoredEnvelopeV1 {
	readonly schemaVersion: 1;
	readonly kind: "foreground_lossless";
	readonly tagged: PrivateForegroundTaggedValueV1;
	readonly taggedSha256: Sha256Ref;
}

interface PrivateForegroundDomainV1 {
	readonly taskId: string;
	readonly runId: string;
	readonly parentSessionId: string;
	readonly parentSessionGenerationSha256: Sha256Ref;
	readonly parentBranchGenerationSha256: Sha256Ref;
	readonly parentBranchAnchorEntryId: string;
	readonly foregroundAppendBatchKeySha256: Sha256Ref;
}

interface PrivateForegroundDomainIndexV1 {
	readonly schemaVersion: 1;
	readonly foregroundAppendBatchKeySha256: Sha256Ref;
	readonly taskId: string;
	readonly runId: string;
	readonly parentSessionId: string;
	readonly parentSessionGenerationSha256: Sha256Ref;
}

interface PrivateForegroundSessionLocatorV1 {
	readonly foregroundAppendBatchKeySha256: Sha256Ref;
	readonly taskId: string;
	readonly runId: string;
	readonly parentSessionGenerationSha256: Sha256Ref;
}

interface PrivateForegroundSessionIndexV1 {
	readonly schemaVersion: 1;
	readonly parentSessionId: string;
	readonly locators: readonly PrivateForegroundSessionLocatorV1[];
}

interface PrivateForegroundBatchRowV1 {
	readonly kind: "foreground_batch";
	readonly batch: PrivateForegroundHandoffBatchV1;
}

interface PrivateForegroundMemberRowV1 {
	readonly kind: "foreground_member";
	readonly foregroundAppendBatchKeySha256: Sha256Ref;
	readonly memberIndex: number;
}

interface PrivateForegroundGateRowV1 {
	readonly kind: "foreground_gate";
	readonly preOverlayGate: PrivateForegroundPreOverlayGateV1;
	readonly renderedGate: PrivateForegroundRenderedGateV1 | null;
	readonly renderedResult: PrivateForegroundRenderedResultV1 | null;
	readonly suspension: PrivateForegroundSuspensionV1 | null;
	readonly lastInspectionSha256: Sha256Ref | null;
	readonly overlayCommitReceipt: ConfidentialTransientTaskForegroundTtsrOverlayCommitReceiptV1 | null;
}

interface PrivateForegroundAppendRowV1 {
	readonly kind: "foreground_append";
	readonly batch: PrivateForegroundAppendBatchV1;
	readonly attempts: readonly PrivateForegroundAppendAttemptV1[];
	readonly notAppliedProofs: readonly PrivateForegroundNotAppliedProofV1[];
	readonly parentDeliveryAttempts: readonly ConfidentialTransientTaskParentResultDeliveryAttemptV1[];
	readonly batchTransitionReceipt: ConfidentialTransientTaskForegroundAppendDeliveryBatchTransitionReceiptV1 | null;
	readonly batchReplayProof: ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayProofV1 | null;
	readonly primaryReceipt: ConfidentialTransientTaskForegroundSessionAppendReceiptV1 | null;
}

function foregroundBatchMapKey(foregroundAppendBatchKeySha256: Sha256Ref): string {
	return `foreground-batch\u0000${foregroundAppendBatchKeySha256}`;
}

function foregroundGateMapKey(foregroundAppendBatchKeySha256: Sha256Ref): string {
	return `foreground-gate\u0000${foregroundAppendBatchKeySha256}`;
}

function foregroundAppendMapKey(foregroundAppendBatchKeySha256: Sha256Ref): string {
	return `foreground-append\u0000${foregroundAppendBatchKeySha256}`;
}

function foregroundMemberMapKey(key: TransientTaskResultPublicationTargetKeyV1): string {
	return `foreground-member\u0000${publicationMapKey(key)}`;
}

export type DurableTransientTaskForegroundAppendDeliveryBatchInspectResultV1 =
	| Exclude<
			ConfidentialTransientTaskForegroundAppendDeliveryBatchInspectResultV1,
			{ readonly status: "outcome_unknown" }
	  >
	| {
			readonly status: "outcome_unknown";
			readonly transitionReceipt: ConfidentialTransientTaskForegroundAppendDeliveryBatchTransitionReceiptV1;
			readonly sessionAppendInspectionRequest: ConfidentialTransientTaskForegroundSessionAppendInspectRequestV1;
			readonly parentDeliveryInspections: readonly [
				TransientTaskParentResultDeliveryInspectResultV1,
				...TransientTaskParentResultDeliveryInspectResultV1[],
			];
	  };

export interface DurableTransientTaskForegroundAppendDeliveryBatchStateAuthorityV1 {
	transitionPreparedForegroundAppendDeliveryBatch(
		request: ConfidentialTransientTaskForegroundAppendDeliveryBatchRequestV1,
	): Promise<TransientTaskForegroundAppendDeliveryBatchResultV1>;
	inspectPreparedForegroundAppendDeliveryBatch(
		request: ConfidentialTransientTaskForegroundAppendDeliveryBatchInspectRequestV1,
	): Promise<DurableTransientTaskForegroundAppendDeliveryBatchInspectResultV1>;
	restoreExactAbsentForegroundAppendDeliveryBatchForReplay(
		request: ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayAdoptRequestV1,
		sessionAppendInspection: TransientTaskForegroundSessionAppendInspectResultV1,
	): Promise<ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayAdoptResultV1>;
}

export async function canonicalTransientTaskForegroundAppendDeliveryBatchCoordinatorRequestSha256V1(
	request: Omit<ConfidentialTransientTaskForegroundAppendDeliveryBatchRequestV1, "coordinatorRequestSha256">,
): Promise<Sha256Ref> {
	return tupleRef([
		"omp-transient-task-foreground-append-delivery-batch-v1",
		"transition-request",
		1,
		request.append.batch.foregroundAppendBatchKeySha256,
		request.append.batch.appendBatchSha256,
		request.append.expectedAttemptSha256s,
		request.append.expectedNotAppliedProofSha256s,
		request.parentDeliveryAttempts.map(attempt => attempt.attemptSha256),
		request.transitionRequestedAt,
	]);
}

export async function canonicalTransientTaskForegroundAppendDeliveryBatchInspectRequestSha256V1(
	request: Omit<ConfidentialTransientTaskForegroundAppendDeliveryBatchInspectRequestV1, "requestSha256">,
): Promise<Sha256Hex> {
	return canonicalRuntimeSha256([
		"omp-transient-task-foreground-append-delivery-batch-v1",
		"inspect-request",
		1,
		request.batchRequest.coordinatorRequestSha256,
		request.expectedTransitionReceiptSha256,
		request.requestedAt,
	]);
}

export async function canonicalTransientTaskForegroundAppendDeliveryBatchReplayAdoptRequestSha256V1(
	request: Omit<ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayAdoptRequestV1, "requestSha256">,
): Promise<Sha256Hex> {
	return canonicalRuntimeSha256([
		"omp-transient-task-foreground-append-delivery-batch-v1",
		"replay-adopt-request",
		1,
		request.inspectionRequest.requestSha256,
		request.expectedSessionAppendInspectionSha256,
		request.inspectionRequest.batchRequest.parentDeliveryAttempts.map(
			attempt => attempt.request.deliveryAuthoritySha256,
		),
		request.requestedAt,
	]);
}

interface PrivateForegroundBatchStateJoinV1 {
	readonly domain: PrivateForegroundDomainV1;
	readonly append: PrivateForegroundAppendRowV1;
	readonly parents: readonly [PrivateParentDeliveryRowV1, ...PrivateParentDeliveryRowV1[]];
}

type PrivateForegroundBatchJoinResultV1 =
	| { readonly status: "matching"; readonly joined: PrivateForegroundBatchStateJoinV1 }
	| {
			readonly status:
				| "append_not_prepared"
				| "delivery_not_prepared"
				| "member_set_conflict"
				| "conflict"
				| "invalid";
	  };

async function foregroundBatchRequestDomain(
	request: ConfidentialTransientTaskForegroundAppendDeliveryBatchRequestV1,
): Promise<PrivateForegroundDomainV1 | null> {
	if (!proxyFreeData(request)) return null;
	try {
		encodeForegroundTaggedValue(request);
	} catch {
		return null;
	}
	if (
		!strictRecord(request, [
			"schemaVersion",
			"append",
			"parentDeliveryAttempts",
			"transitionRequestedAt",
			"coordinatorRequestSha256",
		]) ||
		request.schemaVersion !== 1 ||
		!strictRecord(request.append, ["batch", "expectedAttemptSha256s", "expectedNotAppliedProofSha256s"]) ||
		!strictRecord(request.append.batch, [
			"schemaVersion",
			"handoffBatch",
			"renderedResult",
			"foregroundAppendBatchKeySha256",
			"injectionAppendRequest",
			"entry",
			"requests",
			"appendBatchSha256",
		]) ||
		request.append.batch.schemaVersion !== 1 ||
		!strictArray(request.append.batch.requests) ||
		request.append.batch.requests.length === 0 ||
		!strictArray(request.append.expectedAttemptSha256s) ||
		!strictArray(request.append.expectedNotAppliedProofSha256s) ||
		!strictArray(request.parentDeliveryAttempts) ||
		request.parentDeliveryAttempts.length !== request.append.batch.requests.length ||
		request.append.expectedAttemptSha256s.length !== request.append.batch.requests.length ||
		request.append.expectedNotAppliedProofSha256s.length !== request.append.batch.requests.length ||
		!validResultStoreSha256Ref(request.append.batch.foregroundAppendBatchKeySha256) ||
		!validResultStoreSha256Ref(request.append.batch.appendBatchSha256) ||
		!validResultStoreIso8601(request.transitionRequestedAt) ||
		!validResultStoreSha256Ref(request.coordinatorRequestSha256) ||
		!request.append.expectedAttemptSha256s.every(validResultStoreSha256Ref) ||
		!request.append.expectedNotAppliedProofSha256s.every(validResultStoreSha256Ref)
	)
		return null;
	const domain = foregroundBatchDomain(request.append.batch.handoffBatch);
	if (!domain || domain.foregroundAppendBatchKeySha256 !== request.append.batch.foregroundAppendBatchKeySha256)
		return null;
	const { coordinatorRequestSha256: _coordinatorRequestSha256, ...requestCore } = request;
	if (
		(await canonicalTransientTaskForegroundAppendDeliveryBatchCoordinatorRequestSha256V1(requestCore)) !==
		request.coordinatorRequestSha256
	)
		return null;
	for (let index = 0; index < request.append.batch.requests.length; index++) {
		const appendRequest = request.append.batch.requests[index];
		const parentAttempt = request.parentDeliveryAttempts[index];
		if (
			!strictRecord(appendRequest, [
				"schemaVersion",
				"identity",
				"preReturnIdentity",
				"handoffSha256",
				"handoffBatchSha256",
				"foregroundAppendBatchKeySha256",
				"renderedResultSha256",
				"injectionAppendRequestSha256",
				"entry",
				"toolResultMessageUtf8",
				"toolResultMessageUtf8Sha256",
				"toolResultMessageUtf8ByteLength",
				"deliveryAuthority",
				"appendRequestSha256",
			]) ||
			appendRequest.schemaVersion !== 1 ||
			!strictRecord(appendRequest.identity, ["core", "identitySha256"]) ||
			!strictRecord(appendRequest.identity.core, [
				"schemaVersion",
				"preReturnIdentitySha256",
				"sinkProjection",
				"deliveryRequestSha256",
				"deliveryAuthority",
				"deliveryAuthoritySha256",
			]) ||
			appendRequest.identity.core.schemaVersion !== 1 ||
			!strictRecord(parentAttempt, ["schemaVersion", "request", "preparedAt", "attemptSha256"]) ||
			parentAttempt.schemaVersion !== 1 ||
			!validResultStoreIso8601(parentAttempt.preparedAt) ||
			!validResultStoreSha256Ref(parentAttempt.attemptSha256) ||
			!validResultStoreSha256Ref(appendRequest.identity.identitySha256) ||
			!validResultStoreSha256Hex(appendRequest.identity.core.deliveryRequestSha256) ||
			!validResultStoreSha256Ref(appendRequest.identity.core.deliveryAuthoritySha256) ||
			appendRequest.foregroundAppendBatchKeySha256 !== domain.foregroundAppendBatchKeySha256 ||
			appendRequest.identity.core.deliveryRequestSha256 !== parentAttempt.request.deliveryRequestSha256 ||
			appendRequest.identity.core.deliveryAuthoritySha256 !== parentAttempt.request.deliveryAuthoritySha256 ||
			!exactJson(appendRequest.identity.core.deliveryAuthority, parentAttempt.request.deliveryAuthority) ||
			!exactJson(appendRequest.deliveryAuthority, parentAttempt.request.deliveryAuthority) ||
			parentAttempt.request.route.kind !== "foreground_tool_call" ||
			parentAttempt.request.taskId !== domain.taskId ||
			parentAttempt.request.runId !== domain.runId ||
			parentAttempt.request.deliveryOperationId !== appendRequest.preReturnIdentity.core.deliveryOperationId ||
			!resultTargetKeyMatches(parentAttempt.request, appendRequest.preReturnIdentity.core)
		)
			return null;
		try {
			if (!(await parentDeliveryRow({ state: "not_applied", attempt: parentAttempt, receipt: null }))) return null;
		} catch {
			return null;
		}
	}
	return domain;
}

function foregroundSessionAppendInspectionRequest(
	append: PrivateForegroundAppendRowV1,
): ConfidentialTransientTaskForegroundSessionAppendInspectRequestV1 {
	const batch = append.batch;
	const domain = foregroundBatchDomain(batch.handoffBatch);
	const first = batch.requests[0];
	if (!domain || !first) throw new TypeError("Foreground append inspection request is invalid");
	for (const request of batch.requests) {
		if (
			!exactJson(request.entry, batch.entry) ||
			request.toolResultMessageUtf8Sha256 !== first.toolResultMessageUtf8Sha256 ||
			request.toolResultMessageUtf8ByteLength !== first.toolResultMessageUtf8ByteLength
		)
			throw new TypeError("Foreground append inspection members conflict");
	}
	return {
		foregroundAppendBatchKeySha256: batch.foregroundAppendBatchKeySha256,
		appendBatchSha256: batch.appendBatchSha256,
		injectionAppendRequestSha256: batch.injectionAppendRequest.requestSha256,
		parentSessionId: domain.parentSessionId,
		parentSessionGenerationSha256: domain.parentSessionGenerationSha256,
		parentBranchGenerationSha256: domain.parentBranchGenerationSha256,
		parentBranchAnchorEntryId: domain.parentBranchAnchorEntryId,
		appendParentEntryId: batch.entry.parentId,
		toolCallId: batch.handoffBatch.toolCallId,
		toolResultEntryId: batch.entry.id,
		orderedAppendOperationIds: batch.requests.map(request => request.preReturnIdentity.core.appendOperationId) as [
			OperationId,
			...OperationId[],
		],
		orderedSettlementIdentitySha256s: batch.requests.map(request => request.identity.identitySha256) as [
			Sha256Ref,
			...Sha256Ref[],
		],
		sessionEntryJsonlUtf8Sha256: batch.entry.sessionEntryJsonlUtf8Sha256,
		sessionEntryJsonlUtf8ByteLength: batch.entry.sessionEntryJsonlUtf8ByteLength,
		toolResultMessageUtf8Sha256: first.toolResultMessageUtf8Sha256,
		toolResultMessageUtf8ByteLength: first.toolResultMessageUtf8ByteLength,
	};
}

function foregroundParentDeliveryInspection(
	row: PrivateParentDeliveryRowV1,
): TransientTaskParentResultDeliveryInspectResultV1 {
	if (row.state !== "terminal")
		return {
			status: row.state,
			attemptSha256: row.attempt.attemptSha256,
			deliveryAuthoritySha256: row.attempt.request.deliveryAuthoritySha256,
			deliveryRequestSha256: row.attempt.request.deliveryRequestSha256,
			deliveryPayloadTupleSha256: row.attempt.request.deliveryPayloadTupleSha256,
		};
	return {
		status:
			row.receipt.outcome === "delivery_epoch_invalidated" || row.receipt.outcome === "dead_lettered"
				? "terminal_non_delivery"
				: "matching",
		attemptSha256: row.attempt.attemptSha256,
		receiptSha256: row.receipt.receiptSha256,
		deliveryAuthoritySha256: row.attempt.request.deliveryAuthoritySha256,
		deliveryRequestSha256: row.attempt.request.deliveryRequestSha256,
		deliveryPayloadTupleSha256: row.attempt.request.deliveryPayloadTupleSha256,
	};
}

async function foregroundBatchTransitionReceiptSha256(
	receipt: Omit<ConfidentialTransientTaskForegroundAppendDeliveryBatchTransitionReceiptV1, "receiptSha256">,
): Promise<Sha256Ref> {
	return tupleRef([
		"omp-transient-task-foreground-append-delivery-batch-v1",
		"transition-receipt",
		1,
		receipt.coordinatorRequestSha256,
		receipt.foregroundAppendBatchKeySha256,
		receipt.appendBatchSha256,
		receipt.transitionSequence,
		receipt.previousTransitionReceiptSha256,
		receipt.replayProofSha256,
		receipt.orderedSettlementIdentitySha256s,
		receipt.orderedAppendAttemptSha256s,
		receipt.orderedAppendNotAppliedProofSha256s,
		receipt.orderedParentDeliveryAttemptSha256s,
		receipt.transitionedImmediatelyBeforeDispatchAt,
	]);
}

async function foregroundBatchReplayProofSha256(
	proof: Omit<ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayProofV1, "proofSha256">,
): Promise<Sha256Ref> {
	return tupleRef([
		"omp-transient-task-foreground-append-delivery-batch-v1",
		"replay-proof",
		1,
		proof.coordinatorRequestSha256,
		proof.priorTransitionReceipt.receiptSha256,
		proof.sessionAppendInspectionSha256,
		proof.orderedCurrentDeliveryAuthoritySha256s,
		proof.restoredAppendAttemptSha256s,
		proof.restoredAppendNotAppliedProofSha256s,
		proof.restoredParentDeliveryAttemptSha256s,
		proof.restoredAt,
	]);
}

function validForegroundSha256RefList(input: unknown): input is readonly [Sha256Ref, ...Sha256Ref[]] {
	return strictArray(input) && input.length > 0 && input.every(validResultStoreSha256Ref);
}

function foregroundBatchTransitionReceiptShape(
	input: unknown,
	append: PrivateForegroundAppendRowV1,
): input is ConfidentialTransientTaskForegroundAppendDeliveryBatchTransitionReceiptV1 {
	return (
		proxyFreeData(input) &&
		strictRecord(input, [
			"schemaVersion",
			"coordinatorRequestSha256",
			"foregroundAppendBatchKeySha256",
			"appendBatchSha256",
			"transitionSequence",
			"previousTransitionReceiptSha256",
			"replayProofSha256",
			"orderedSettlementIdentitySha256s",
			"orderedAppendAttemptSha256s",
			"orderedAppendNotAppliedProofSha256s",
			"orderedParentDeliveryAttemptSha256s",
			"transitionedImmediatelyBeforeDispatchAt",
			"receiptSha256",
		]) &&
		input.schemaVersion === 1 &&
		validResultStoreSha256Ref(input.coordinatorRequestSha256) &&
		input.foregroundAppendBatchKeySha256 === append.batch.foregroundAppendBatchKeySha256 &&
		input.appendBatchSha256 === append.batch.appendBatchSha256 &&
		validResultStoreInteger(input.transitionSequence, 1) &&
		(input.previousTransitionReceiptSha256 === null ||
			validResultStoreSha256Ref(input.previousTransitionReceiptSha256)) &&
		(input.replayProofSha256 === null || validResultStoreSha256Ref(input.replayProofSha256)) &&
		validForegroundSha256RefList(input.orderedSettlementIdentitySha256s) &&
		validForegroundSha256RefList(input.orderedAppendAttemptSha256s) &&
		validForegroundSha256RefList(input.orderedAppendNotAppliedProofSha256s) &&
		validForegroundSha256RefList(input.orderedParentDeliveryAttemptSha256s) &&
		validResultStoreIso8601(input.transitionedImmediatelyBeforeDispatchAt) &&
		validResultStoreSha256Ref(input.receiptSha256) &&
		exactJson(
			input.orderedSettlementIdentitySha256s,
			append.batch.requests.map(request => request.identity.identitySha256),
		) &&
		exactJson(
			input.orderedAppendAttemptSha256s,
			append.attempts.map(attempt => attempt.attemptSha256),
		) &&
		exactJson(
			input.orderedAppendNotAppliedProofSha256s,
			append.notAppliedProofs.map(proof => proof.proofSha256),
		) &&
		exactJson(
			input.orderedParentDeliveryAttemptSha256s,
			append.parentDeliveryAttempts.map(attempt => attempt.attemptSha256),
		)
	);
}

async function validForegroundBatchTransitionReceipt(
	input: unknown,
	append: PrivateForegroundAppendRowV1,
): Promise<boolean> {
	if (!foregroundBatchTransitionReceiptShape(input, append)) return false;
	const core: Omit<ConfidentialTransientTaskForegroundAppendDeliveryBatchTransitionReceiptV1, "receiptSha256"> = {
		schemaVersion: input.schemaVersion,
		coordinatorRequestSha256: input.coordinatorRequestSha256,
		foregroundAppendBatchKeySha256: input.foregroundAppendBatchKeySha256,
		appendBatchSha256: input.appendBatchSha256,
		transitionSequence: input.transitionSequence,
		previousTransitionReceiptSha256: input.previousTransitionReceiptSha256,
		replayProofSha256: input.replayProofSha256,
		orderedSettlementIdentitySha256s: input.orderedSettlementIdentitySha256s,
		orderedAppendAttemptSha256s: input.orderedAppendAttemptSha256s,
		orderedAppendNotAppliedProofSha256s: input.orderedAppendNotAppliedProofSha256s,
		orderedParentDeliveryAttemptSha256s: input.orderedParentDeliveryAttemptSha256s,
		transitionedImmediatelyBeforeDispatchAt: input.transitionedImmediatelyBeforeDispatchAt,
	};
	return input.receiptSha256 === (await foregroundBatchTransitionReceiptSha256(core));
}

async function validForegroundBatchReplayProof(input: unknown, append: PrivateForegroundAppendRowV1): Promise<boolean> {
	if (
		!proxyFreeData(input) ||
		!strictRecord(input, [
			"schemaVersion",
			"coordinatorRequestSha256",
			"priorTransitionReceipt",
			"sessionAppendInspectionSha256",
			"orderedCurrentDeliveryAuthoritySha256s",
			"restoredAppendAttemptSha256s",
			"restoredAppendNotAppliedProofSha256s",
			"restoredParentDeliveryAttemptSha256s",
			"restoredAt",
			"proofSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validResultStoreSha256Ref(input.coordinatorRequestSha256) ||
		!validResultStoreSha256Ref(input.sessionAppendInspectionSha256) ||
		!validForegroundSha256RefList(input.orderedCurrentDeliveryAuthoritySha256s) ||
		!validForegroundSha256RefList(input.restoredAppendAttemptSha256s) ||
		!validForegroundSha256RefList(input.restoredAppendNotAppliedProofSha256s) ||
		!validForegroundSha256RefList(input.restoredParentDeliveryAttemptSha256s) ||
		!validResultStoreIso8601(input.restoredAt) ||
		!validResultStoreSha256Ref(input.proofSha256) ||
		!foregroundBatchTransitionReceiptShape(input.priorTransitionReceipt, append) ||
		!(await validForegroundBatchTransitionReceipt(input.priorTransitionReceipt, append)) ||
		input.coordinatorRequestSha256 !== input.priorTransitionReceipt.coordinatorRequestSha256 ||
		!exactJson(
			input.orderedCurrentDeliveryAuthoritySha256s,
			append.parentDeliveryAttempts.map(attempt => attempt.request.deliveryAuthoritySha256),
		) ||
		!exactJson(
			input.restoredAppendAttemptSha256s,
			append.attempts.map(attempt => attempt.attemptSha256),
		) ||
		!exactJson(
			input.restoredAppendNotAppliedProofSha256s,
			append.notAppliedProofs.map(proof => proof.proofSha256),
		) ||
		!exactJson(
			input.restoredParentDeliveryAttemptSha256s,
			append.parentDeliveryAttempts.map(attempt => attempt.attemptSha256),
		)
	)
		return false;
	const core: Omit<ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayProofV1, "proofSha256"> = {
		schemaVersion: input.schemaVersion,
		coordinatorRequestSha256: input.coordinatorRequestSha256,
		priorTransitionReceipt: input.priorTransitionReceipt,
		sessionAppendInspectionSha256: input.sessionAppendInspectionSha256,
		orderedCurrentDeliveryAuthoritySha256s: input.orderedCurrentDeliveryAuthoritySha256s,
		restoredAppendAttemptSha256s: input.restoredAppendAttemptSha256s,
		restoredAppendNotAppliedProofSha256s: input.restoredAppendNotAppliedProofSha256s,
		restoredParentDeliveryAttemptSha256s: input.restoredParentDeliveryAttemptSha256s,
		restoredAt: input.restoredAt,
	};
	return input.proofSha256 === (await foregroundBatchReplayProofSha256(core));
}

function validForegroundPrimaryReceipt(
	input: unknown,
	append: PrivateForegroundAppendRowV1,
): input is ConfidentialTransientTaskForegroundSessionAppendReceiptV1 {
	const first = append.batch.requests[0];
	if (
		!first ||
		!payloadPlainData(input) ||
		!strictRecord(input, [
			"schemaVersion",
			"foregroundAppendBatchKeySha256",
			"appendBatchSha256",
			"orderedAppendOperationIds",
			"orderedSettlementIdentitySha256s",
			"sessionAppendRequestSha256",
			"injectionAppendReceiptSha256",
			"entry",
			"toolResultMessageUtf8",
			"toolResultMessageUtf8Sha256",
			"toolResultMessageUtf8ByteLength",
			"committedAt",
			"primaryReceiptSha256",
		]) ||
		input.schemaVersion !== 1 ||
		input.foregroundAppendBatchKeySha256 !== append.batch.foregroundAppendBatchKeySha256 ||
		input.appendBatchSha256 !== append.batch.appendBatchSha256 ||
		!strictArray(input.orderedAppendOperationIds) ||
		!strictArray(input.orderedSettlementIdentitySha256s) ||
		!exactJson(
			input.orderedAppendOperationIds,
			append.batch.requests.map(request => request.preReturnIdentity.core.appendOperationId),
		) ||
		!exactJson(
			input.orderedSettlementIdentitySha256s,
			append.batch.requests.map(request => request.identity.identitySha256),
		) ||
		!validResultStoreSha256Ref(input.sessionAppendRequestSha256) ||
		!validResultStoreSha256Ref(input.injectionAppendReceiptSha256) ||
		!exactJson(input.entry, append.batch.entry) ||
		input.toolResultMessageUtf8 !== first.toolResultMessageUtf8 ||
		input.toolResultMessageUtf8Sha256 !== first.toolResultMessageUtf8Sha256 ||
		input.toolResultMessageUtf8ByteLength !== first.toolResultMessageUtf8ByteLength ||
		foregroundUtf8Sha256(input.toolResultMessageUtf8) !== input.toolResultMessageUtf8Sha256 ||
		Buffer.byteLength(input.toolResultMessageUtf8, "utf8") !== input.toolResultMessageUtf8ByteLength ||
		!validResultStoreIso8601(input.committedAt) ||
		!validResultStoreSha256Ref(input.primaryReceiptSha256)
	)
		return false;
	return append.batch.requests.every(
		request =>
			request.toolResultMessageUtf8 === input.toolResultMessageUtf8 &&
			request.toolResultMessageUtf8Sha256 === input.toolResultMessageUtf8Sha256 &&
			request.toolResultMessageUtf8ByteLength === input.toolResultMessageUtf8ByteLength &&
			exactJson(request.entry, input.entry),
	);
}

function foregroundString(input: unknown): input is string {
	if (typeof input !== "string") return false;
	for (let index = 0; index < input.length; index++) {
		const code = input.charCodeAt(index);
		if (code < 0xd800 || code > 0xdfff) continue;
		if (code >= 0xdc00 || index + 1 >= input.length) return false;
		const next = input.charCodeAt(++index);
		if (next < 0xdc00 || next > 0xdfff) return false;
	}
	return true;
}

function encodeForegroundTaggedValue(input: unknown): PrivateForegroundTaggedValueV1 {
	if (input === undefined) return { t: "undefined" };
	if (input === null) return { t: "null" };
	if (typeof input === "boolean") return { t: "boolean", v: input };
	if (typeof input === "number") {
		if (!Number.isFinite(input) || Object.is(input, -0)) throw new TypeError("Invalid foreground number");
		return { t: "number", v: input };
	}
	if (typeof input === "string") {
		if (!foregroundString(input)) throw new TypeError("Invalid foreground string");
		return { t: "string", v: input };
	}
	if (typeof input !== "object" || isProxy(input)) throw new TypeError("Invalid foreground value");
	if (Array.isArray(input)) {
		if (!strictArray(input)) throw new TypeError("Invalid foreground array");
		return { t: "array", v: input.map(encodeForegroundTaggedValue) };
	}
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Invalid foreground object");
	const entries: Array<readonly [string, PrivateForegroundTaggedValueV1]> = [];
	for (const key of Reflect.ownKeys(input)) {
		if (typeof key !== "string" || !foregroundString(key)) throw new TypeError("Invalid foreground key");
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (descriptor?.enumerable !== true || !("value" in descriptor))
			throw new TypeError("Invalid foreground property");
		entries.push([key, encodeForegroundTaggedValue(descriptor.value)]);
	}
	return { t: "object", p: prototype === null ? "null" : "object", v: entries };
}

function decodeForegroundTaggedValue(input: unknown): unknown {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input) || !("t" in input))
		throw new TypeError("Invalid stored foreground value");
	if (input.t === "undefined" && strictRecord(input, ["t"])) return undefined;
	if (input.t === "null" && strictRecord(input, ["t"])) return null;
	if (input.t === "boolean" && strictRecord(input, ["t", "v"]) && typeof input.v === "boolean") return input.v;
	if (
		input.t === "number" &&
		strictRecord(input, ["t", "v"]) &&
		typeof input.v === "number" &&
		Number.isFinite(input.v) &&
		!Object.is(input.v, -0)
	)
		return input.v;
	if (input.t === "string" && strictRecord(input, ["t", "v"]) && foregroundString(input.v)) return input.v;
	if (input.t === "array" && strictRecord(input, ["t", "v"]) && strictArray(input.v))
		return input.v.map(decodeForegroundTaggedValue);
	if (
		input.t === "object" &&
		strictRecord(input, ["t", "p", "v"]) &&
		(input.p === "object" || input.p === "null") &&
		strictArray(input.v)
	) {
		const output: Record<string, unknown> = input.p === "null" ? Object.create(null) : {};
		for (const entry of input.v) {
			if (
				!strictArray(entry) ||
				entry.length !== 2 ||
				!foregroundString(entry[0]) ||
				Object.hasOwn(output, entry[0])
			)
				throw new TypeError("Invalid stored foreground entry");
			output[entry[0]] = decodeForegroundTaggedValue(entry[1]);
		}
		return output;
	}
	throw new TypeError("Invalid stored foreground tag");
}

function foregroundTaggedSha256(tagged: PrivateForegroundTaggedValueV1): Sha256Ref {
	return `sha256:${createHash("sha256").update(JSON.stringify(tagged), "utf8").digest("hex")}`;
}

function storeForegroundValue(input: unknown): PrivateForegroundStoredEnvelopeV1 {
	const tagged = encodeForegroundTaggedValue(input);
	return { schemaVersion: 1, kind: "foreground_lossless", tagged, taggedSha256: foregroundTaggedSha256(tagged) };
}

function loadForegroundValue<Value>(input: unknown): Value {
	if (
		!strictRecord(input, ["schemaVersion", "kind", "tagged", "taggedSha256"]) ||
		input.schemaVersion !== 1 ||
		input.kind !== "foreground_lossless" ||
		!validResultStoreSha256Ref(input.taggedSha256)
	)
		throw new TypeError("Invalid stored foreground envelope");
	const tagged = input.tagged as PrivateForegroundTaggedValueV1;
	if (foregroundTaggedSha256(tagged) !== input.taggedSha256)
		throw new TypeError("Stored foreground envelope digest mismatch");
	const value = decodeForegroundTaggedValue(tagged);
	if (!exactJson(encodeForegroundTaggedValue(value), tagged))
		throw new TypeError("Stored foreground value is non-canonical");
	return value as Value;
}

function foregroundUtf8Sha256(input: string): Sha256Ref {
	return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

function foregroundTupleRef(tuple: readonly unknown[]): Sha256Ref {
	encodeForegroundTaggedValue(tuple);
	const utf8 = JSON.stringify(tuple);
	if (utf8 === undefined) throw new TypeError("Invalid foreground digest tuple");
	return foregroundUtf8Sha256(utf8);
}

function validForegroundBinding(input: unknown): boolean {
	if (
		!strictRecord(input, [
			"preDispatchBinding",
			"parentBranchGenerationSha256",
			"parentBranchAnchorEntryId",
			"bindingSha256",
		]) ||
		!strictRecord(input.preDispatchBinding, [
			"keySha256",
			"finalVersion",
			"finalVersionSha256",
			"captureOutcomeHistorySha256",
			"finalCaptureOutcomeSha256",
			"pendingOverlaySnapshotSha256",
			"bindingSha256",
		])
	)
		return false;
	return (
		validResultStoreSha256Ref(input.parentBranchGenerationSha256) &&
		validResultStoreIdentity(input.parentBranchAnchorEntryId) &&
		validResultStoreSha256Ref(input.bindingSha256) &&
		validResultStoreSha256Ref(input.preDispatchBinding.keySha256) &&
		validResultStoreInteger(input.preDispatchBinding.finalVersion) &&
		validResultStoreSha256Ref(input.preDispatchBinding.finalVersionSha256) &&
		validResultStoreSha256Ref(input.preDispatchBinding.captureOutcomeHistorySha256) &&
		validResultStoreSha256Ref(input.preDispatchBinding.finalCaptureOutcomeSha256) &&
		validResultStoreSha256Ref(input.preDispatchBinding.pendingOverlaySnapshotSha256) &&
		validResultStoreSha256Ref(input.preDispatchBinding.bindingSha256)
	);
}

function foregroundBatchDomain(batch: unknown): PrivateForegroundDomainV1 | null {
	try {
		encodeForegroundTaggedValue(batch);
	} catch {
		return null;
	}
	if (
		!strictRecord(batch, [
			"schemaVersion",
			"parentSessionId",
			"toolCallId",
			"toolResultSerializerKeySha256",
			"sourceToolCallOrdinal",
			"foregroundAppendBatchKeySha256",
			"toolResultEntryId",
			"pendingOverlayBinding",
			"orderedAppendOperationIds",
			"orderedPreReturnIdentities",
			"orderedPreReturnIdentitySha256s",
			"returnedAgentToolResultUtf8Sha256",
			"returnedAgentToolResultUtf8ByteLength",
			"returnedSourceResultSnapshotSha256",
			"returnedSourceResultSnapshotByteLength",
			"handoffs",
			"handoffBatchSha256",
		]) ||
		batch.schemaVersion !== 1 ||
		!validResultStoreIdentity(batch.parentSessionId) ||
		!validResultStoreIdentity(batch.toolCallId) ||
		!validResultStoreSha256Ref(batch.toolResultSerializerKeySha256) ||
		!validResultStoreInteger(batch.sourceToolCallOrdinal) ||
		!validResultStoreSha256Ref(batch.foregroundAppendBatchKeySha256) ||
		typeof batch.toolResultEntryId !== "string" ||
		!/^[0-9a-f]{8}$/.test(batch.toolResultEntryId) ||
		!validForegroundBinding(batch.pendingOverlayBinding) ||
		!strictArray(batch.orderedAppendOperationIds) ||
		!strictArray(batch.orderedPreReturnIdentities) ||
		!strictArray(batch.orderedPreReturnIdentitySha256s) ||
		!strictArray(batch.handoffs) ||
		batch.handoffs.length === 0 ||
		batch.orderedAppendOperationIds.length !== batch.handoffs.length ||
		batch.orderedPreReturnIdentities.length !== batch.handoffs.length ||
		batch.orderedPreReturnIdentitySha256s.length !== batch.handoffs.length ||
		!validResultStoreSha256Ref(batch.returnedAgentToolResultUtf8Sha256) ||
		!validResultStoreInteger(batch.returnedAgentToolResultUtf8ByteLength) ||
		!validResultStoreSha256Ref(batch.returnedSourceResultSnapshotSha256) ||
		!validResultStoreInteger(batch.returnedSourceResultSnapshotByteLength) ||
		!validResultStoreSha256Ref(batch.handoffBatchSha256)
	)
		return null;
	let domain: PrivateForegroundDomainV1 | null = null;
	for (let index = 0; index < batch.handoffs.length; index++) {
		const handoff = batch.handoffs[index];
		const identity = batch.orderedPreReturnIdentities[index];
		if (
			!strictRecord(handoff, [
				"schemaVersion",
				"preReturnIdentity",
				"pendingOverlayBinding",
				"returnedAgentToolResult",
				"returnedSourceResultSnapshot",
				"returnedAgentToolResultWire",
				"returnedAgentToolResultUtf8",
				"preparedBeforeReturnAt",
				"handoffSha256",
			]) ||
			handoff.schemaVersion !== 1 ||
			!strictRecord(identity, ["core", "preReturnIdentitySha256"]) ||
			!strictRecord(identity.core, [
				"schemaVersion",
				"taskId",
				"runId",
				"createId",
				"resultPublicationId",
				"resultPublicationTargetId",
				"resultPublicationTargetCleanupId",
				"effectIdentityManifestSha256",
				"deliveryOperationId",
				"appendOperationId",
				"foregroundMemberIndex",
				"foregroundMemberCount",
				"parentSessionId",
				"parentSessionGenerationSha256",
				"parentBranchGenerationSha256",
				"parentBranchAnchorEntryId",
				"toolCallId",
				"toolResultSerializerKeySha256",
				"sourceToolCallOrdinal",
				"entryPreallocationOperationId",
				"toolResultEntryId",
				"returnedAgentToolResultUtf8Sha256",
				"returnedAgentToolResultUtf8ByteLength",
				"returnedSourceResultSnapshotSha256",
				"returnedSourceResultSnapshotByteLength",
			]) ||
			!exactJson(handoff.preReturnIdentity, identity) ||
			!exactJson(handoff.pendingOverlayBinding, batch.pendingOverlayBinding) ||
			!validResultStoreSha256Ref(identity.preReturnIdentitySha256) ||
			batch.orderedPreReturnIdentitySha256s[index] !== identity.preReturnIdentitySha256 ||
			batch.orderedAppendOperationIds[index] !== identity.core.appendOperationId ||
			identity.core.schemaVersion !== 1 ||
			!resultTargetKeyFromRecord(identity.core) ||
			!validResultStoreSha256Ref(identity.core.effectIdentityManifestSha256) ||
			!validResultStoreIdentity(identity.core.deliveryOperationId) ||
			!validResultStoreIdentity(identity.core.appendOperationId) ||
			identity.core.foregroundMemberIndex !== index ||
			identity.core.foregroundMemberCount !== batch.handoffs.length ||
			identity.core.parentSessionId !== batch.parentSessionId ||
			!validResultStoreSha256Ref(identity.core.parentSessionGenerationSha256) ||
			!validResultStoreSha256Ref(identity.core.parentBranchGenerationSha256) ||
			!validResultStoreIdentity(identity.core.parentBranchAnchorEntryId) ||
			identity.core.toolCallId !== batch.toolCallId ||
			identity.core.toolResultSerializerKeySha256 !== batch.toolResultSerializerKeySha256 ||
			identity.core.sourceToolCallOrdinal !== batch.sourceToolCallOrdinal ||
			identity.core.toolResultEntryId !== batch.toolResultEntryId ||
			identity.core.returnedAgentToolResultUtf8Sha256 !== batch.returnedAgentToolResultUtf8Sha256 ||
			identity.core.returnedAgentToolResultUtf8ByteLength !== batch.returnedAgentToolResultUtf8ByteLength ||
			identity.core.returnedSourceResultSnapshotSha256 !== batch.returnedSourceResultSnapshotSha256 ||
			identity.core.returnedSourceResultSnapshotByteLength !== batch.returnedSourceResultSnapshotByteLength ||
			!validResultStoreIso8601(handoff.preparedBeforeReturnAt) ||
			!validResultStoreSha256Ref(handoff.handoffSha256) ||
			typeof handoff.returnedAgentToolResultUtf8 !== "string" ||
			foregroundUtf8Sha256(handoff.returnedAgentToolResultUtf8) !== batch.returnedAgentToolResultUtf8Sha256 ||
			Buffer.byteLength(handoff.returnedAgentToolResultUtf8, "utf8") !==
				batch.returnedAgentToolResultUtf8ByteLength ||
			!strictRecord(handoff.returnedSourceResultSnapshot, [
				"schemaVersion",
				"taggedSourceResult",
				"ownUndefinedJsonPointers",
				"sourceSnapshotUtf8",
				"sourceSnapshotUtf8Sha256",
				"sourceSnapshotUtf8ByteLength",
			]) ||
			handoff.returnedSourceResultSnapshot.schemaVersion !== 1 ||
			typeof handoff.returnedSourceResultSnapshot.sourceSnapshotUtf8 !== "string" ||
			!validResultStoreInteger(handoff.returnedSourceResultSnapshot.sourceSnapshotUtf8ByteLength) ||
			handoff.returnedSourceResultSnapshot.sourceSnapshotUtf8Sha256 !== batch.returnedSourceResultSnapshotSha256 ||
			handoff.returnedSourceResultSnapshot.sourceSnapshotUtf8ByteLength !==
				batch.returnedSourceResultSnapshotByteLength ||
			foregroundUtf8Sha256(handoff.returnedSourceResultSnapshot.sourceSnapshotUtf8) !==
				batch.returnedSourceResultSnapshotSha256 ||
			Buffer.byteLength(handoff.returnedSourceResultSnapshot.sourceSnapshotUtf8, "utf8") !==
				batch.returnedSourceResultSnapshotByteLength
		)
			return null;
		const targetKey = resultTargetKeyFromRecord(identity.core);
		if (!targetKey) return null;
		const nextDomain: PrivateForegroundDomainV1 = {
			taskId: targetKey.taskId,
			runId: targetKey.runId,
			parentSessionId: identity.core.parentSessionId,
			parentSessionGenerationSha256: identity.core.parentSessionGenerationSha256,
			parentBranchGenerationSha256: identity.core.parentBranchGenerationSha256,
			parentBranchAnchorEntryId: identity.core.parentBranchAnchorEntryId,
			foregroundAppendBatchKeySha256: batch.foregroundAppendBatchKeySha256,
		};
		if (domain && !exactJson(domain, nextDomain)) return null;
		domain = nextDomain;
	}
	return domain;
}

function validForegroundDomainIndex(input: unknown): input is PrivateForegroundDomainIndexV1 {
	return (
		strictRecord(input, [
			"schemaVersion",
			"foregroundAppendBatchKeySha256",
			"taskId",
			"runId",
			"parentSessionId",
			"parentSessionGenerationSha256",
		]) &&
		input.schemaVersion === 1 &&
		validResultStoreSha256Ref(input.foregroundAppendBatchKeySha256) &&
		validResultStoreIdentity(input.taskId) &&
		validResultStoreIdentity(input.runId) &&
		validResultStoreIdentity(input.parentSessionId) &&
		validResultStoreSha256Ref(input.parentSessionGenerationSha256)
	);
}

function validForegroundSessionIndex(
	input: unknown,
	parentSessionId: string,
): input is PrivateForegroundSessionIndexV1 {
	if (
		!strictRecord(input, ["schemaVersion", "parentSessionId", "locators"]) ||
		input.schemaVersion !== 1 ||
		input.parentSessionId !== parentSessionId ||
		!strictArray(input.locators)
	)
		return false;
	const seen = new Set<string>();
	for (const locator of input.locators) {
		if (
			!strictRecord(locator, [
				"foregroundAppendBatchKeySha256",
				"taskId",
				"runId",
				"parentSessionGenerationSha256",
			]) ||
			!validResultStoreSha256Ref(locator.foregroundAppendBatchKeySha256) ||
			!validResultStoreIdentity(locator.taskId) ||
			!validResultStoreIdentity(locator.runId) ||
			!validResultStoreSha256Ref(locator.parentSessionGenerationSha256) ||
			seen.has(locator.foregroundAppendBatchKeySha256)
		)
			return false;
		seen.add(locator.foregroundAppendBatchKeySha256);
	}
	return true;
}

type PrivateDetachedOperationV1 = ConfidentialTransientTaskDetachedSettlementAttemptV1["operation"];
type PrivateDetachedEffectRequestV1 =
	| Parameters<TransientTaskDetachedSettlementStoreV1["publishSettledResult"]>[0]
	| Parameters<TransientTaskDetachedSettlementStoreV1["reserve"]>[0]
	| Parameters<TransientTaskDetachedSettlementStoreV1["applyReservedEnqueue"]>[0]
	| Parameters<TransientTaskDetachedSettlementStoreV1["commit"]>[0]
	| Parameters<TransientTaskDetachedSettlementStoreV1["releaseReservation"]>[0];

type PrivateDetachedPrimaryAppendResolutionV1 =
	| {
			readonly status: "applied";
			readonly receipt: ConfidentialTransientTaskDetachedPrimarySessionPersistenceReceiptV1;
	  }
	| { readonly status: "not_applied" | "rejected" | "outcome_unknown" };

interface PrivateDetachedAttemptStateV1 {
	readonly attempt: ConfidentialTransientTaskDetachedSettlementAttemptV1;
	readonly notAppliedReceipt: TransientTaskDetachedSettlementNotAppliedReceiptV1;
	readonly state: "not_applied" | "outcome_unknown" | "applied";
	readonly receipt: ConfidentialTransientTaskDetachedSettlementOperationReceiptV1 | null;
}

interface PrivateDetachedSettlementRowV1 {
	readonly kind: "detached_settlement";
	readonly identitySha256: Sha256Ref;
	readonly settlement: ConfidentialTransientTaskDetachedSettlementRequestV1;
	readonly attempts: readonly PrivateDetachedAttemptStateV1[];
	readonly terminalReceipt: ConfidentialTransientTaskDetachedSettlementTerminalReceiptV1 | null;
}

type PrivateDetachedEffectBlockStatusV1 =
	| "cancellation_enqueue_forbidden"
	| "settled_result_missing"
	| "reservation_missing"
	| "reservation_released"
	| "reservation_conflict"
	| "reservation_busy"
	| "sink_receipt_required"
	| "sink_receipt_conflict"
	| "already_terminal"
	| "authority_lost"
	| "stale_owner_epoch"
	| "identity_conflict"
	| "request_conflict"
	| "invalid";

type PrivateDetachedEffectOpenResultV1 =
	| {
			readonly status: "opened";
			readonly attempt: PrivateDetachedAttemptStateV1;
	  }
	| {
			readonly status: "applied";
			readonly receipt: ConfidentialTransientTaskDetachedSettlementOperationReceiptV1;
	  }
	| {
			readonly status: "outcome_unknown";
			readonly attempt: PrivateDetachedAttemptStateV1;
	  }
	| { readonly status: "blocked"; readonly reason: PrivateDetachedEffectBlockStatusV1 }
	| { readonly status: "absent" | "attempt_conflict" | "invalid" };

interface PrivateDetachedRecoveryRowV1 {
	readonly kind: "detached_recovery";
	readonly record: ConfidentialAsyncJobTransientTaskRecoveryRecordV1;
	readonly receipt: ConfidentialAsyncJobTransientTaskRecoveryWriteReceiptV1;
}

interface PrivateDetachedHubWinnerRowV1 {
	readonly kind: "detached_hub_winner";
	readonly captureRequest: Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0];
	readonly continuation: ConfidentialTransientTaskHubWaitMessageWinnerContinuationV1 | null;
	readonly completionReceipt: ConfidentialTransientTaskHubWaitMessageWinnerCompletionReceiptV1 | null;
	readonly authoritativeAbsenceReceipt: ConfidentialTransientTaskHubWaitMessageWinnerAuthoritativeAbsenceReceiptV1 | null;
	readonly acknowledgementRequest: ConfidentialTransientTaskHubWaitMessageReturnAcknowledgementRequestV1 | null;
	readonly acknowledgementReceipt: ConfidentialTransientTaskHubWaitMessageReturnAcknowledgementReceiptV1 | null;
}

interface PrivateDetachedHubReturnDeliveryV1 {
	readonly request: ConfidentialTransientTaskHubWaitMessageReturnDeliveryRequestV1;
	readonly receipt: ConfidentialTransientTaskHubWaitMessageReturnDeliveryReceiptV1;
}

interface PrivateDetachedHubReturnTargetRowV1 {
	readonly kind: "detached_hub_return_target";
	readonly registrationReceipt: ConfidentialTransientTaskHubWaitMessageReturnTargetRegistrationReceiptV1;
	readonly sendAwaitOutboundState: ConfidentialTransientTaskHubSendAwaitOutboundStateV1 | null;
	readonly preselectionAdoptionReceipt: ConfidentialTransientTaskHubWaitMessagePreselectionAdoptionReceiptV1 | null;
	readonly selectionReceiptSha256: Sha256Ref | null;
	readonly retirementReceipt: ConfidentialTransientTaskHubWaitMessageReturnTargetRetirementReceiptV1 | null;
	readonly retiredPlanAdoptionReceipt: ConfidentialTransientTaskHubWaitMessageRetiredPlanAdoptionReceiptV1 | null;
	readonly delivery: PrivateDetachedHubReturnDeliveryV1 | null;
}

interface PrivateDetachedHubReturnTargetLocatorV1 {
	readonly taskId: string;
	readonly runId: string;
	readonly ref: TransientTaskHubWaitMessagePreselectionRecoveryRefV1;
}

interface PrivateDetachedHubReturnTargetRecoveryIndexV1 {
	readonly schemaVersion: 1;
	readonly ownerId: string;
	readonly senderId: string;
	readonly currentAuthoritySha256: Sha256Ref;
	readonly locators: readonly PrivateDetachedHubReturnTargetLocatorV1[];
}

function detachedHubOutboundTransitionMatchesRegistration(
	state: Extract<
		ConfidentialTransientTaskHubSendAwaitOutboundStateV1,
		{ state: "outcome_unknown" | "blocked_indeterminate" }
	>,
	registration: ConfidentialTransientTaskHubWaitMessageReturnTargetRegistrationReceiptV1,
	registeredState: Extract<ConfidentialTransientTaskHubSendAwaitOutboundStateV1, { state: "not_applied" }>,
): boolean {
	const request = state.transitionRequest;
	const receipt = state.transitionReceipt;
	return (
		validateTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-transition-request", request) &&
		validateTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-transition-receipt", receipt) &&
		exactJson(request.currentAuthority, registration.claim.currentAuthority) &&
		exactJson(request.registration, registration) &&
		exactJson(request.plan, registeredState.plan) &&
		request.expectedPriorStateSha256 === registeredState.stateSha256 &&
		request.targetDeliveryPermit.targetAgentId === request.plan.message.to &&
		request.targetDeliveryPermit.sendOperationId === request.plan.sendOperationId &&
		request.targetDeliveryPermit.messageSha256 === request.plan.message.messageSha256 &&
		receipt.planSha256 === request.plan.planSha256 &&
		receipt.registrationReceiptSha256 === registration.receiptSha256 &&
		receipt.targetDeliveryPermitSha256 === request.targetDeliveryPermit.permitSha256 &&
		receipt.transitionRequestSha256 === request.requestSha256 &&
		receipt.expectedPriorStateSha256 === registeredState.stateSha256 &&
		receipt.transitionedAt === request.transitionedAt
	);
}

function detachedHubOutboundReceiptMatchesRegistration(
	receipt: ConfidentialTransientTaskHubSendAwaitOutboundReceiptV1,
	registeredState: Extract<ConfidentialTransientTaskHubSendAwaitOutboundStateV1, { state: "not_applied" }>,
): boolean {
	const entry = receipt.targetDeliverySettledEntry;
	return (
		validateTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-receipt", receipt) &&
		receipt.planSha256 === registeredState.plan.planSha256 &&
		exactJson(receipt.sourceReceipt, entry.sourceReceipt) &&
		receipt.settledAt === entry.settledAt &&
		exactJson(entry.message, registeredState.plan.message) &&
		exactJson(entry.request.message, registeredState.plan.message) &&
		exactJson(entry.request.permit, entry.permit) &&
		entry.permit.targetAgentId === registeredState.plan.message.to &&
		entry.permit.sendOperationId === registeredState.plan.sendOperationId &&
		entry.permit.messageSha256 === registeredState.plan.message.messageSha256 &&
		entry.request.outboundTransitionReceiptSha256 === receipt.transitionReceiptSha256 &&
		entry.request.expectsReply === true
	);
}

function detachedHubOutboundStateMatchesRegistration(
	state: ConfidentialTransientTaskHubSendAwaitOutboundStateV1 | null,
	registration: ConfidentialTransientTaskHubWaitMessageReturnTargetRegistrationReceiptV1,
): boolean {
	const registeredState = registration.sendAwaitOutboundState;
	if (registeredState === null || state === null) return registeredState === null && state === null;
	if (
		!validateTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-state", state) ||
		!exactJson(state.plan, registeredState.plan)
	)
		return false;
	if (state.state === "not_applied") return exactJson(state, registeredState);
	if (state.state === "settled") return detachedHubOutboundReceiptMatchesRegistration(state.receipt, registeredState);
	if (!detachedHubOutboundTransitionMatchesRegistration(state, registration, registeredState)) return false;
	return (
		state.state !== "blocked_indeterminate" ||
		validateTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", state.inspection)
	);
}

function loadDetachedHubReturnTargetRow(input: unknown): PrivateDetachedHubReturnTargetRowV1 {
	const value = loadForegroundValue<unknown>(input);
	if (
		!strictHubRecord(value, [
			"kind",
			"registrationReceipt",
			"sendAwaitOutboundState",
			"preselectionAdoptionReceipt",
			"selectionReceiptSha256",
			"retirementReceipt",
			"retiredPlanAdoptionReceipt",
			"delivery",
		]) ||
		value.kind !== "detached_hub_return_target" ||
		!validateTransientTaskHubWaitMessageCanonicalRecordV1(
			"return-target-registration-receipt",
			value.registrationReceipt,
		) ||
		(value.sendAwaitOutboundState !== null &&
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-outbound-state",
				value.sendAwaitOutboundState,
			)) ||
		(value.selectionReceiptSha256 !== null && !validResultStoreSha256Ref(value.selectionReceiptSha256)) ||
		(value.preselectionAdoptionReceipt !== null &&
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"preselection-adoption-receipt",
				value.preselectionAdoptionReceipt,
			)) ||
		(value.retirementReceipt !== null &&
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"return-target-retirement-receipt",
				value.retirementReceipt,
			)) ||
		(value.retiredPlanAdoptionReceipt !== null &&
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"retired-plan-adoption-receipt",
				value.retiredPlanAdoptionReceipt,
			))
	)
		throw new TypeError("Invalid detached Hub return-target row");
	const row = value as unknown as PrivateDetachedHubReturnTargetRowV1;
	if (!detachedHubOutboundStateMatchesRegistration(row.sendAwaitOutboundState, row.registrationReceipt))
		throw new TypeError("Detached Hub outbound state lineage conflict");
	if (
		(row.selectionReceiptSha256 !== null && row.retirementReceipt !== null) ||
		(row.preselectionAdoptionReceipt !== null &&
			(!exactJson(row.preselectionAdoptionReceipt.registration, row.registrationReceipt) ||
				row.preselectionAdoptionReceipt.currentAuthoritySha256 !==
					row.registrationReceipt.claim.currentAuthority.authoritySha256)) ||
		(row.retirementReceipt !== null &&
			(!exactJson(row.retirementReceipt.registration, row.registrationReceipt) ||
				row.retirementReceipt.keySha256 !==
					hashTransientTaskHubWaitMessageCanonicalRecordV1(
						"winner-key",
						row.registrationReceipt.claim.selector.key,
					))) ||
		(row.retiredPlanAdoptionReceipt !== null &&
			(row.retirementReceipt === null ||
				row.retiredPlanAdoptionReceipt.retirementReceiptSha256 !== row.retirementReceipt.receiptSha256 ||
				!exactJson(row.retiredPlanAdoptionReceipt.target, row.registrationReceipt.target) ||
				!exactJson(row.retiredPlanAdoptionReceipt.afterToolCallPlan, row.registrationReceipt.afterToolCallPlan) ||
				!exactJson(
					row.retiredPlanAdoptionReceipt.sendAwaitOutboundReceipt,
					row.retirementReceipt.sendAwaitOutboundReceipt,
				)))
	)
		throw new TypeError("Detached Hub return-target lineage conflict");
	if (row.delivery !== null) {
		if (
			row.selectionReceiptSha256 === null ||
			row.retirementReceipt !== null ||
			!strictHubRecord(row.delivery, ["request", "receipt"]) ||
			!validateTransientTaskHubWaitMessageCanonicalRecordV1("return-delivery-request", row.delivery.request) ||
			!validateTransientTaskHubWaitMessageCanonicalRecordV1("return-delivery-receipt", row.delivery.receipt) ||
			!exactJson(row.delivery.request.targetRegistration, row.registrationReceipt) ||
			!exactJson(row.delivery.receipt.target, row.registrationReceipt.target) ||
			row.delivery.receipt.targetRegistrationReceiptSha256 !== row.registrationReceipt.receiptSha256 ||
			row.delivery.receipt.completionReceiptSha256 !== row.delivery.request.completionReceiptSha256 ||
			row.delivery.receipt.returnResultSha256 !== row.delivery.request.returnResult.resultSha256 ||
			row.delivery.receipt.returnDeliveryOperationId !== row.delivery.request.returnDeliveryOperationId ||
			row.delivery.receipt.deliveredAt !== row.delivery.request.requestedAt ||
			row.delivery.receipt.deliveryRequestSha256 !== row.delivery.request.requestSha256
		)
			throw new TypeError("Detached Hub return delivery conflict");
	}
	return row;
}

function validDetachedHubReturnTargetRecoveryIndex(
	input: unknown,
	ownerId: string,
	senderId: string,
): input is PrivateDetachedHubReturnTargetRecoveryIndexV1 {
	if (
		!strictHubRecord(input, ["schemaVersion", "ownerId", "senderId", "currentAuthoritySha256", "locators"]) ||
		input.schemaVersion !== 1 ||
		input.ownerId !== ownerId ||
		input.senderId !== senderId ||
		!validResultStoreSha256Ref(input.currentAuthoritySha256) ||
		!strictArray(input.locators)
	)
		return false;
	const invocationIds = new Set<string>();
	const refSha256s = new Set<string>();
	for (const locator of input.locators) {
		if (
			!strictHubRecord(locator, ["taskId", "runId", "ref"]) ||
			!validResultStoreIdentity(locator.taskId) ||
			!validResultStoreIdentity(locator.runId)
		)
			return false;
		const ref = locator.ref;
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1("preselection-recovery-ref", ref) ||
			ref.currentAuthoritySha256 !== input.currentAuthoritySha256 ||
			invocationIds.has(ref.hubWaitInvocationId) ||
			refSha256s.has(ref.refSha256)
		)
			return false;
		invocationIds.add(ref.hubWaitInvocationId);
		refSha256s.add(ref.refSha256);
	}
	return true;
}

type PrivateDetachedRowV1 =
	| PrivateDetachedSettlementRowV1
	| PrivateDetachedRecoveryRowV1
	| PrivateDetachedHubWinnerRowV1;

interface PrivateDetachedIdentityLocatorV1 {
	readonly schemaVersion: 1;
	readonly identitySha256: Sha256Ref;
	readonly taskId: string;
	readonly runId: string;
	readonly ownerId: string;
	readonly jobId: string;
}

interface PrivateDetachedRecoveryIndexEntryV1 {
	readonly taskId: string;
	readonly runId: string;
	readonly jobId: string;
	readonly recoveryRecordSha256: Sha256Ref;
	readonly row: PrivateDetachedRecoveryRowV1;
}

interface PrivateDetachedRecoveryIndexV1 {
	readonly schemaVersion: 1;
	readonly ownerSessionIndexSha256: Sha256Ref;
	readonly entries: readonly PrivateDetachedRecoveryIndexEntryV1[];
}

interface PrivateDetachedHubLocatorV1 {
	readonly schemaVersion: 1;
	readonly keySha256: Sha256Ref;
	readonly taskId: string;
	readonly runId: string;
}

interface PrivateDetachedHubRecoveryLocatorV1 extends PrivateDetachedHubLocatorV1 {
	readonly key: Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0]["selector"]["key"];
}

interface PrivateDetachedHubRecoveryIndexV1 {
	readonly schemaVersion: 1;
	readonly ownerId: string;
	readonly senderId: string;
	readonly locators: readonly PrivateDetachedHubRecoveryLocatorV1[];
}

function detachedIdentityLocatorKey(identitySha256: Sha256Ref): string {
	return `detached-identity-index\u0000${identitySha256}`;
}

function detachedJobLocatorKey(ownerId: string, jobId: string): string {
	return `detached-job-index\u0000${ownerId}\u0000${jobId}`;
}

function detachedRecoveryIndexKey(ownerSessionIndexSha256: Sha256Ref): string {
	return `detached-recovery-index\u0000${ownerSessionIndexSha256}`;
}

function detachedHubLocatorKey(keySha256: Sha256Ref): string {
	return `detached-hub-index\u0000${keySha256}`;
}

function detachedHubRecoveryIndexKey(ownerId: string, senderId: string): string {
	return `detached-hub-recovery-index\u0000${ownerId}\u0000${senderId}`;
}

function detachedHubReturnTargetMapKey(hubWaitInvocationId: OperationId): string {
	return `detached-hub-return-target\u0000${hubWaitInvocationId}`;
}

function detachedHubReturnTargetRecoveryIndexKey(ownerId: string, senderId: string): string {
	return `detached-hub-return-target-recovery-index\u0000${ownerId}\u0000${senderId}`;
}

function detachedTaskKey(
	settlement: ConfidentialTransientTaskDetachedSettlementRequestV1,
): TransientTaskWorkspaceKeyV1 {
	return { taskId: settlement.identity.taskId, runId: settlement.identity.runId };
}

function validDetachedIdentityLocator(input: unknown): input is PrivateDetachedIdentityLocatorV1 {
	return Boolean(
		strictRecord(input, ["schemaVersion", "identitySha256", "taskId", "runId", "ownerId", "jobId"]) &&
			input.schemaVersion === 1 &&
			validResultStoreSha256Ref(input.identitySha256) &&
			validResultStoreIdentity(input.taskId) &&
			validResultStoreIdentity(input.runId) &&
			validResultStoreIdentity(input.ownerId) &&
			validResultStoreIdentity(input.jobId),
	);
}

function validDetachedHubLocator(input: unknown): input is PrivateDetachedHubLocatorV1 {
	return Boolean(
		strictRecord(input, ["schemaVersion", "keySha256", "taskId", "runId"]) &&
			input.schemaVersion === 1 &&
			validResultStoreSha256Ref(input.keySha256) &&
			validResultStoreIdentity(input.taskId) &&
			validResultStoreIdentity(input.runId),
	);
}

function validDetachedHubRecoveryIndex(
	input: unknown,
	ownerId: string,
	senderId: string,
): input is PrivateDetachedHubRecoveryIndexV1 {
	if (
		!strictRecord(input, ["schemaVersion", "ownerId", "senderId", "locators"]) ||
		input.schemaVersion !== 1 ||
		input.ownerId !== ownerId ||
		input.senderId !== senderId ||
		!strictArray(input.locators)
	)
		return false;
	const keyDigests = new Set<string>();
	const invocationIds = new Set<string>();
	for (const locator of input.locators) {
		if (
			!strictRecord(locator, ["schemaVersion", "keySha256", "taskId", "runId", "key"]) ||
			!validDetachedHubLocator({
				schemaVersion: locator.schemaVersion,
				keySha256: locator.keySha256,
				taskId: locator.taskId,
				runId: locator.runId,
			}) ||
			!validDetachedHubKey(locator.key) ||
			locator.key.ownerId !== ownerId ||
			locator.key.senderId !== senderId ||
			locator.keySha256 !== hashTransientTaskHubWaitMessageCanonicalRecordV1("winner-key", locator.key) ||
			keyDigests.has(locator.keySha256) ||
			invocationIds.has(locator.key.hubWaitInvocationId)
		)
			return false;
		keyDigests.add(locator.keySha256);
		invocationIds.add(locator.key.hubWaitInvocationId);
	}
	return true;
}

function validDetachedHubKey(
	input: unknown,
): input is Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0]["selector"]["key"] {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"hubWaitInvocationId",
			"ownerId",
			"senderId",
			"fromFilter",
			"watchedJobIds",
			"returnTargetSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validResultStoreIdentity(input.hubWaitInvocationId) ||
		!validResultStoreIdentity(input.ownerId) ||
		!validResultStoreIdentity(input.senderId) ||
		(input.fromFilter !== null && typeof input.fromFilter !== "string") ||
		!strictArray(input.watchedJobIds) ||
		!validResultStoreSha256Ref(input.returnTargetSha256)
	)
		return false;
	const seen = new Set<string>();
	for (const jobId of input.watchedJobIds) {
		if (!validResultStoreIdentity(jobId) || seen.has(jobId)) return false;
		seen.add(jobId);
	}
	return input.watchedJobIds.length > 0;
}

function strictHubRecord<Input>(input: Input, keys: readonly string[]): input is Input & Record<string, unknown> {
	return strictRecord(input, keys) && Reflect.ownKeys(input as object).every((key, index) => key === keys[index]);
}

function validDetachedHubSerializerKey(input: unknown): input is ConfidentialAgentSessionToolResultSerializerKeyV1 {
	if (
		!strictHubRecord(input, [
			"schemaVersion",
			"parentSessionId",
			"parentSessionGenerationSha256",
			"parentBranchGenerationSha256",
			"assistantAnchorEntryId",
			"serializerKeySha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validResultStoreIdentity(input.parentSessionId) ||
		!validResultStoreSha256Ref(input.parentSessionGenerationSha256) ||
		!validResultStoreSha256Ref(input.parentBranchGenerationSha256) ||
		!validResultStoreIdentity(input.assistantAnchorEntryId) ||
		!validResultStoreSha256Ref(input.serializerKeySha256)
	)
		return false;
	const { serializerKeySha256: _serializerKeySha256, ...core } = input;
	return input.serializerKeySha256 === detachedDigest("agent-session-tool-result-serializer-key", core);
}

function validDetachedHubReturnTarget(input: unknown): input is ConfidentialTransientTaskHubWaitMessageReturnTargetV1 {
	if (
		!strictHubRecord(input, [
			"schemaVersion",
			"serializerKey",
			"toolCallId",
			"toolName",
			"returnDeliveryOperationId",
			"returnTargetSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validDetachedHubSerializerKey(input.serializerKey) ||
		!validResultStoreIdentity(input.toolCallId) ||
		input.toolName !== "hub" ||
		!validResultStoreIdentity(input.returnDeliveryOperationId) ||
		!validResultStoreSha256Ref(input.returnTargetSha256)
	)
		return false;
	const { returnTargetSha256: _returnTargetSha256, ...core } = input;
	return input.returnTargetSha256 === detachedDigest("hub-wait-message-return-target", core);
}

function validDetachedHubContentPlan(
	input: unknown,
): input is ConfidentialTransientTaskForegroundTtsrInjectionContentPlanV1 {
	if (strictHubRecord(input, ["disposition", "injectedRuleNames", "contentPlanSha256"])) {
		if (
			input.disposition !== "no_entry" ||
			!strictArray(input.injectedRuleNames) ||
			input.injectedRuleNames.length !== 0 ||
			!validResultStoreSha256Ref(input.contentPlanSha256)
		)
			return false;
		const { contentPlanSha256: _contentPlanSha256, ...core } = input;
		return input.contentPlanSha256 === detachedDigest("foreground-ttsr-injection-content-plan", core);
	}
	if (
		!strictHubRecord(input, [
			"disposition",
			"entryTimestamp",
			"injectedRuleNames",
			"overlaySnapshotSha256",
			"contentPlanSha256",
		]) ||
		input.disposition !== "exact_entry" ||
		!validResultStoreIso8601(input.entryTimestamp) ||
		!strictArray(input.injectedRuleNames) ||
		input.injectedRuleNames.length === 0 ||
		!input.injectedRuleNames.every(validResultStoreIdentity) ||
		!validResultStoreSha256Ref(input.overlaySnapshotSha256) ||
		!validResultStoreSha256Ref(input.contentPlanSha256)
	)
		return false;
	const { contentPlanSha256: _contentPlanSha256, ...core } = input;
	return input.contentPlanSha256 === detachedDigest("foreground-ttsr-injection-content-plan", core);
}

function validDetachedHubCurrentParentAuthority(
	input: unknown,
): input is ConfidentialTransientTaskHubWaitMessageCurrentParentSessionAuthorityV1 {
	if (
		!strictHubRecord(input, ["schemaVersion", "ownerId", "senderId", "serializerKey", "authoritySha256"]) ||
		input.schemaVersion !== 1 ||
		!validResultStoreIdentity(input.ownerId) ||
		!validResultStoreIdentity(input.senderId) ||
		!validDetachedHubSerializerKey(input.serializerKey) ||
		!validResultStoreSha256Ref(input.authoritySha256)
	)
		return false;
	const { authoritySha256: _authoritySha256, ...core } = input;
	return input.authoritySha256 === detachedDigest("hub-wait-message-current-parent-session-authority", core);
}

function validDetachedHubSelector(
	input: unknown,
): input is ConfidentialTransientTaskHubWaitMessageSelectorInstallRequestV1 {
	if (
		!strictHubRecord(input, [
			"schemaVersion",
			"key",
			"returnTarget",
			"releaseAttemptPreparedAt",
			"completionOperationId",
			"selectionPreparedAt",
			"selectorInstallRequestSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validDetachedHubKey(input.key) ||
		!validDetachedHubReturnTarget(input.returnTarget) ||
		input.key.returnTargetSha256 !== input.returnTarget.returnTargetSha256 ||
		!validResultStoreIso8601(input.releaseAttemptPreparedAt) ||
		!validResultStoreIdentity(input.completionOperationId) ||
		!validResultStoreIso8601(input.selectionPreparedAt) ||
		!validResultStoreSha256Hex(input.selectorInstallRequestSha256)
	)
		return false;
	const { selectorInstallRequestSha256: _selectorInstallRequestSha256, ...core } = input;
	return input.selectorInstallRequestSha256 === detachedHex("hub-wait-message-selector-install-request", core);
}

function validDetachedHubSendAwaitPlan(input: unknown): input is ConfidentialTransientTaskHubSendAwaitOutboundPlanV1 {
	if (
		!strictHubRecord(input, [
			"schemaVersion",
			"sendOperationId",
			"message",
			"expectsReply",
			"waitStartedAtEpochMs",
			"effectiveTimeoutMs",
			"deadlineEpochMs",
			"planSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validResultStoreIdentity(input.sendOperationId) ||
		!strictHubRecord(input.message, [
			"schemaVersion",
			"id",
			"from",
			"to",
			"body",
			"ts",
			"replyTo",
			"messageSha256",
		]) ||
		input.message.schemaVersion !== 1 ||
		!validResultStoreIdentity(input.message.id) ||
		!validResultStoreIdentity(input.message.from) ||
		!validResultStoreIdentity(input.message.to) ||
		typeof input.message.body !== "string" ||
		(input.message.body !== "" && !isWellFormedString(input.message.body)) ||
		!Number.isSafeInteger(input.message.ts) ||
		(input.message.replyTo !== null && !validResultStoreIdentity(input.message.replyTo)) ||
		!validResultStoreSha256Ref(input.message.messageSha256) ||
		input.expectsReply !== true ||
		!validResultStoreInteger(input.waitStartedAtEpochMs) ||
		!validResultStoreInteger(input.effectiveTimeoutMs) ||
		input.effectiveTimeoutMs <= 0 ||
		(input.deadlineEpochMs !== null &&
			(!validResultStoreInteger(input.deadlineEpochMs) ||
				input.deadlineEpochMs !== input.waitStartedAtEpochMs + input.effectiveTimeoutMs)) ||
		!validResultStoreSha256Ref(input.planSha256)
	)
		return false;
	const { messageSha256: _messageSha256, ...messageCore } = input.message;
	if (input.message.messageSha256 !== detachedDigest("hub-send-await-outbound-message", messageCore)) return false;
	const { planSha256: _planSha256, ...core } = input;
	return input.planSha256 === detachedDigest("hub-send-await-outbound-plan", core);
}

function validDetachedHubResumePlan(
	input: unknown,
): input is ConfidentialTransientTaskHubWaitMessageSelectionResumePlanV1 {
	if (
		!strictHubRecord(input, [
			"schemaVersion",
			"mode",
			"deadlineEpochMs",
			"sendAwaitOutboundPlan",
			"resumePlanSha256",
		]) ||
		input.schemaVersion !== 1 ||
		(input.mode !== "combined_job_message_wait" && input.mode !== "message_wait" && input.mode !== "send_await") ||
		(input.deadlineEpochMs !== null && !validResultStoreInteger(input.deadlineEpochMs)) ||
		!validResultStoreSha256Ref(input.resumePlanSha256)
	)
		return false;
	if (input.mode === "send_await") {
		if (
			!validDetachedHubSendAwaitPlan(input.sendAwaitOutboundPlan) ||
			input.deadlineEpochMs !== input.sendAwaitOutboundPlan.deadlineEpochMs
		)
			return false;
	} else if (input.sendAwaitOutboundPlan !== null) return false;
	const { resumePlanSha256: _resumePlanSha256, ...core } = input;
	return input.resumePlanSha256 === detachedDigest("hub-wait-message-selection-resume-plan", core);
}

function validDetachedHubPreselectionClaim(
	input: unknown,
): input is ConfidentialTransientTaskHubWaitMessagePreselectionClaimV1 {
	if (
		!strictHubRecord(input, [
			"schemaVersion",
			"currentAuthority",
			"selector",
			"resumePlan",
			"returnTargetSha256",
			"afterToolCallPlanSha256",
			"claimSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validResultStoreSha256Ref(input.returnTargetSha256) ||
		!validResultStoreSha256Ref(input.afterToolCallPlanSha256) ||
		!validResultStoreSha256Ref(input.claimSha256)
	)
		return false;
	if (!validDetachedHubCurrentParentAuthority(input.currentAuthority)) return false;
	if (!validDetachedHubSelector(input.selector)) return false;
	if (!validDetachedHubResumePlan(input.resumePlan)) return false;
	if (
		input.returnTargetSha256 !== input.selector.returnTarget.returnTargetSha256 ||
		input.currentAuthority.ownerId !== input.selector.key.ownerId ||
		input.currentAuthority.senderId !== input.selector.key.senderId ||
		!exactJson(input.currentAuthority.serializerKey, input.selector.returnTarget.serializerKey)
	)
		return false;
	const { claimSha256: _claimSha256, ...core } = input;
	return input.claimSha256 === detachedDigest("hub-wait-message-preselection-claim", core);
}

function validDetachedHubRegistrationReceipt(
	input: unknown,
): input is ConfidentialTransientTaskHubWaitMessageReturnTargetRegistrationReceiptV1 {
	return validateTransientTaskHubWaitMessageCanonicalRecordV1("return-target-registration-receipt", input);
}

function validDetachedHubConsumedMessage(input: unknown): input is ConfidentialTransientTaskHubWaitConsumedMessageV1 {
	if (
		!strictHubRecord(input, ["schemaVersion", "id", "from", "to", "body", "ts", "replyTo", "messageSha256"]) ||
		input.schemaVersion !== 1 ||
		!validResultStoreIdentity(input.id) ||
		!validResultStoreIdentity(input.from) ||
		!validResultStoreIdentity(input.to) ||
		typeof input.body !== "string" ||
		(input.body !== "" && !isWellFormedString(input.body)) ||
		!Number.isSafeInteger(input.ts) ||
		(input.replyTo !== null && !validResultStoreIdentity(input.replyTo)) ||
		!validResultStoreSha256Ref(input.messageSha256)
	)
		return false;
	const { messageSha256: _messageSha256, ...core } = input;
	return input.messageSha256 === detachedDigest("hub-wait-consumed-message", core);
}

function validDetachedHubCaptureRequest(
	input: unknown,
): input is Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0] {
	if (
		!payloadPlainData(input) ||
		!strictHubRecord(input, [
			"selector",
			"preselectionClaimSha256",
			"message",
			"returnTargetRegistrationReceipt",
			"sendAwaitOutboundReceipt",
			"captureRequestSha256",
		]) ||
		!validDetachedHubSelector(input.selector) ||
		!validResultStoreSha256Ref(input.preselectionClaimSha256) ||
		!validDetachedHubConsumedMessage(input.message) ||
		!validDetachedHubRegistrationReceipt(input.returnTargetRegistrationReceipt) ||
		!validResultStoreSha256Hex(input.captureRequestSha256)
	)
		return false;
	const capture = input as unknown as Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0];
	const registration = capture.returnTargetRegistrationReceipt;
	if (
		!exactJson(capture.selector, registration.claim.selector) ||
		!exactJson(capture.selector.returnTarget, registration.target) ||
		capture.preselectionClaimSha256 !== registration.claim.claimSha256 ||
		capture.selector.key.returnTargetSha256 !== registration.target.returnTargetSha256 ||
		(capture.sendAwaitOutboundReceipt === null
			? registration.claim.resumePlan.mode === "send_await"
			: registration.claim.resumePlan.mode !== "send_await" ||
				!payloadPlainData(capture.sendAwaitOutboundReceipt) ||
				capture.sendAwaitOutboundReceipt.planSha256 !==
					registration.claim.resumePlan.sendAwaitOutboundPlan.planSha256 ||
				!validResultStoreSha256Ref(capture.sendAwaitOutboundReceipt.receiptSha256))
	)
		return false;
	return detachedHubCaptureRequestMatches(capture);
}

function detachedHubReleaseTerminal(
	release: ConfidentialTransientTaskHubWaitMessageWinnerContinuationV1["releases"][number],
): boolean {
	return release.state === "released" || release.state === "already_terminal";
}

function detachedStoreMapKey(identitySha256: Sha256Ref): string {
	return `detached-settlement\u0000${identitySha256}`;
}

function detachedHubWinnerMapKey(
	key: Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0]["selector"]["key"],
): string {
	return `detached-hub-winner\u0000${hashTransientTaskHubWaitMessageCanonicalRecordV1("winner-key", key)}`;
}

function detachedDigest(label: string, input: unknown): Sha256Ref {
	return foregroundTaggedSha256(encodeForegroundTaggedValue(["omp-transient-task-detached-store-v1", label, input]));
}

function detachedHex(label: string, input: unknown): Sha256Hex {
	return detachedDigest(label, input).slice("sha256:".length) as Sha256Hex;
}

interface PrivateCurrentEpochReservationReceiptV1 {
	readonly schemaVersion: 1;
	readonly identity: ConfidentialTransientTaskDetachedSettlementReservationReceiptV1["identity"];
	readonly reservationId: OperationId;
	readonly disposition: "current_epoch_enqueue";
	readonly currentAuthoritySha256: Sha256Ref;
	readonly reservationRequestSha256: Sha256Hex;
	readonly reservedAt: ISO8601;
	readonly receiptSha256: Sha256Ref;
	readonly suppression: null;
}

function validCurrentEpochReservationReceipt(input: unknown): input is PrivateCurrentEpochReservationReceiptV1 {
	if (
		!payloadPlainData(input) ||
		!strictRecord(input, [
			"schemaVersion",
			"identity",
			"reservationId",
			"disposition",
			"currentAuthoritySha256",
			"reservationRequestSha256",
			"reservedAt",
			"receiptSha256",
			"suppression",
		]) ||
		input.schemaVersion !== 1 ||
		!validDetachedIdentity(input.identity) ||
		!validResultStoreIdentity(input.reservationId) ||
		input.disposition !== "current_epoch_enqueue" ||
		!validResultStoreSha256Ref(input.currentAuthoritySha256) ||
		!validResultStoreSha256Hex(input.reservationRequestSha256) ||
		!validResultStoreIso8601(input.reservedAt) ||
		!validResultStoreSha256Ref(input.receiptSha256) ||
		input.suppression !== null
	)
		return false;
	const core = {
		schemaVersion: input.schemaVersion,
		identity: input.identity,
		reservationId: input.reservationId,
		disposition: input.disposition,
		currentAuthoritySha256: input.currentAuthoritySha256,
		reservationRequestSha256: input.reservationRequestSha256,
		reservedAt: input.reservedAt,
		suppression: input.suppression,
	};
	return input.receiptSha256 === detachedDigest("reservation-receipt", core);
}

function detachedPrimaryAppendRequest(
	sink: Parameters<TransientTaskDetachedSettlementStoreV1["applyReservedEnqueue"]>[0]["operation"]["request"],
): ConfidentialTransientTaskDetachedPrimarySessionAppendRequestV1 {
	const core = {
		plan: sink.primaryAppendPlan,
		orderedOutboxReceipts: [sink.outboxReceipt] as const,
	};
	return {
		...core,
		primaryAppendRequestSha256: detachedDigest("primary-session-append-request", core),
	};
}

function detachedPrimaryAppendReceiptMatches(
	input: unknown,
	request: ConfidentialTransientTaskDetachedPrimarySessionAppendRequestV1,
): input is ConfidentialTransientTaskDetachedPrimarySessionPersistenceReceiptV1 {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"primaryAppendOperationId",
			"primaryAppendBatchKeySha256",
			"primaryAppendPlanSha256",
			"orderedOutboxReceiptSha256s",
			"primarySessionId",
			"primarySessionGenerationSha256",
			"primaryBranchGenerationSha256",
			"primaryBranchAnchorEntryId",
			"appendParentEntryId",
			"primarySessionEntryId",
			"primarySessionEntryJsonlUtf8Sha256",
			"primarySessionEntryJsonlUtf8ByteLength",
			"primaryAppendRequestSha256",
			"receiptSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!payloadPlainData(input) ||
		!validResultStoreSha256Ref(input.receiptSha256)
	)
		return false;
	const receipt = input as unknown as ConfidentialTransientTaskDetachedPrimarySessionPersistenceReceiptV1;
	const plan = request.plan;
	return (
		receipt.primaryAppendOperationId === plan.primaryAppendOperationId &&
		receipt.primaryAppendBatchKeySha256 === plan.primaryAppendBatchKeySha256 &&
		receipt.primaryAppendPlanSha256 === plan.primaryAppendPlanSha256 &&
		exactJson(
			receipt.orderedOutboxReceiptSha256s,
			request.orderedOutboxReceipts.map(outbox => outbox.receiptSha256),
		) &&
		receipt.primarySessionId === plan.primarySessionId &&
		receipt.primarySessionGenerationSha256 === plan.primarySessionGenerationSha256 &&
		receipt.primaryBranchGenerationSha256 === plan.primaryBranchGenerationSha256 &&
		receipt.primaryBranchAnchorEntryId === plan.primaryBranchAnchorEntryId &&
		receipt.appendParentEntryId === plan.appendParentEntryId &&
		receipt.primarySessionEntryId === plan.primarySessionEntryId &&
		receipt.primarySessionEntryJsonlUtf8Sha256 === plan.primarySessionEntryJsonlUtf8Sha256 &&
		receipt.primarySessionEntryJsonlUtf8ByteLength === plan.primarySessionEntryJsonlUtf8ByteLength &&
		receipt.primaryAppendRequestSha256 === request.primaryAppendRequestSha256
	);
}

function detachedPrimaryAppendAbsenceProofMatches(
	input: unknown,
	plan: ConfidentialTransientTaskDetachedPrimarySessionAppendRequestV1["plan"],
): boolean {
	return Boolean(
		strictRecord(input, [
			"schemaVersion",
			"primaryAppendOperationId",
			"primaryAppendPlanSha256",
			"primarySessionId",
			"primarySessionGenerationSha256",
			"primaryBranchGenerationSha256",
			"primaryBranchAnchorEntryId",
			"appendParentEntryId",
			"primarySessionEntryId",
			"expectedPrimarySessionEntryJsonlUtf8Sha256",
			"observedCurrentLeafEntryId",
			"proofSha256",
		]) &&
			input.schemaVersion === 1 &&
			input.primaryAppendOperationId === plan.primaryAppendOperationId &&
			input.primaryAppendPlanSha256 === plan.primaryAppendPlanSha256 &&
			input.primarySessionId === plan.primarySessionId &&
			input.primarySessionGenerationSha256 === plan.primarySessionGenerationSha256 &&
			input.primaryBranchGenerationSha256 === plan.primaryBranchGenerationSha256 &&
			input.primaryBranchAnchorEntryId === plan.primaryBranchAnchorEntryId &&
			input.appendParentEntryId === plan.appendParentEntryId &&
			input.primarySessionEntryId === plan.primarySessionEntryId &&
			input.expectedPrimarySessionEntryJsonlUtf8Sha256 === plan.primarySessionEntryJsonlUtf8Sha256 &&
			(input.observedCurrentLeafEntryId === null || typeof input.observedCurrentLeafEntryId === "string") &&
			validResultStoreSha256Ref(input.proofSha256),
	);
}

function detachedHubCaptureRequestMatches(
	request: Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0],
): boolean {
	const { captureRequestSha256: _captureRequestSha256, ...core } = request;
	return request.captureRequestSha256 === detachedHex("hub-winner-capture-request", core);
}

function detachedHubCompletionRequestMatches(
	request: Parameters<TransientTaskDetachedSettlementStoreV1["completeMessageWinner"]>[0],
): boolean {
	const { completionRequestSha256: _completionRequestSha256, ...core } = request;
	return request.completionRequestSha256 === detachedHex("hub-winner-completion-request", core);
}

function validDetachedHubWaitReservationReceipt(
	input: ConfidentialTransientTaskDetachedSettlementOperationReceiptV1,
): input is Extract<
	ConfidentialTransientTaskDetachedSettlementReservationReceiptV1,
	{ disposition: "hub_wait_consumption" }
> {
	return Boolean(
		strictHubRecord(input, [
			"schemaVersion",
			"identity",
			"reservationId",
			"disposition",
			"currentAuthoritySha256",
			"reservationRequestSha256",
			"reservedAt",
			"hubWaitInvocationId",
			"suppression",
			"receiptSha256",
		]) &&
			input.schemaVersion === 1 &&
			input.disposition === "hub_wait_consumption" &&
			validDetachedIdentity(input.identity) &&
			validResultStoreIdentity(input.reservationId) &&
			validResultStoreSha256Ref(input.currentAuthoritySha256) &&
			validResultStoreSha256Hex(input.reservationRequestSha256) &&
			validResultStoreIso8601(input.reservedAt) &&
			validResultStoreIdentity(input.hubWaitInvocationId) &&
			strictHubRecord(input.suppression, [
				"schemaVersion",
				"identity",
				"reservationId",
				"suppressionOperationId",
				"consumer",
				"currentAuthoritySha256",
				"reservationRequestSha256",
				"suppressedAt",
				"receiptSha256",
			]) &&
			input.suppression.schemaVersion === 1 &&
			input.suppression.consumer === "hub_wait" &&
			exactJson(input.suppression.identity, input.identity) &&
			input.suppression.reservationId === input.reservationId &&
			validResultStoreIdentity(input.suppression.suppressionOperationId) &&
			input.suppression.currentAuthoritySha256 === input.currentAuthoritySha256 &&
			input.suppression.reservationRequestSha256 === input.reservationRequestSha256 &&
			input.suppression.suppressedAt === input.reservedAt &&
			validResultStoreSha256Ref(input.suppression.receiptSha256) &&
			validResultStoreSha256Ref(input.receiptSha256),
	);
}

function hasDetachedHubReleaseStateShape(
	input: unknown,
): input is ConfidentialTransientTaskHubWaitMessageWinnerContinuationV1["releases"][number] {
	if (!payloadPlainData(input) || input === null || typeof input !== "object") return false;
	const released = "state" in input && input.state === "released";
	if (
		!strictHubRecord(
			input,
			released
				? [
						"reservation",
						"releaseAttempt",
						"state",
						"releaseResultStatus",
						"notAppliedReceipt",
						"releaseReceipt",
						"terminalDisposition",
						"terminalReceiptSha256",
						"releaseStateSha256",
					]
				: [
						"reservation",
						"releaseAttempt",
						"state",
						"notAppliedReceipt",
						"releaseReceipt",
						"terminalDisposition",
						"terminalReceiptSha256",
						"releaseStateSha256",
					],
		) ||
		!strictHubRecord(input.reservation, [
			"schemaVersion",
			"identity",
			"reservationId",
			"disposition",
			"currentAuthoritySha256",
			"reservationRequestSha256",
			"reservedAt",
			"hubWaitInvocationId",
			"suppression",
			"receiptSha256",
		]) ||
		!strictHubRecord(input.reservation.suppression, [
			"schemaVersion",
			"identity",
			"reservationId",
			"suppressionOperationId",
			"consumer",
			"currentAuthoritySha256",
			"reservationRequestSha256",
			"suppressedAt",
			"receiptSha256",
		]) ||
		!strictHubRecord(input.releaseAttempt, [
			"schemaVersion",
			"operation",
			"operationId",
			"requestSha256",
			"preparedAt",
			"attemptSha256",
		]) ||
		!strictHubRecord(input.releaseAttempt.operation, ["stage", "operationId", "requestSha256", "request"]) ||
		!strictHubRecord(input.releaseAttempt.operation.request, [
			"settlement",
			"currentAuthority",
			"reservation",
			"releaseOperationId",
			"reason",
			"releaseRequestSha256",
		]) ||
		!payloadPlainData(input.releaseAttempt.operation.request.settlement) ||
		!payloadPlainData(input.releaseAttempt.operation.request.currentAuthority)
	)
		return false;
	return true;
}

function validDetachedHubReleaseState(
	input: unknown,
): input is ConfidentialTransientTaskHubWaitMessageWinnerContinuationV1["releases"][number] {
	if (!hasDetachedHubReleaseStateShape(input)) return false;
	const released = input.state === "released";
	if (
		!strictHubRecord(
			input,
			released
				? [
						"reservation",
						"releaseAttempt",
						"state",
						"releaseResultStatus",
						"notAppliedReceipt",
						"releaseReceipt",
						"terminalDisposition",
						"terminalReceiptSha256",
						"releaseStateSha256",
					]
				: [
						"reservation",
						"releaseAttempt",
						"state",
						"notAppliedReceipt",
						"releaseReceipt",
						"terminalDisposition",
						"terminalReceiptSha256",
						"releaseStateSha256",
					],
		) ||
		!strictHubRecord(input.reservation, [
			"schemaVersion",
			"identity",
			"reservationId",
			"disposition",
			"currentAuthoritySha256",
			"reservationRequestSha256",
			"reservedAt",
			"hubWaitInvocationId",
			"suppression",
			"receiptSha256",
		]) ||
		input.reservation.schemaVersion !== 1 ||
		input.reservation.disposition !== "hub_wait_consumption" ||
		!payloadPlainData(input.reservation.identity) ||
		!validResultStoreIdentity(input.reservation.reservationId) ||
		!validResultStoreSha256Ref(input.reservation.currentAuthoritySha256) ||
		!validResultStoreSha256Hex(input.reservation.reservationRequestSha256) ||
		!validResultStoreIso8601(input.reservation.reservedAt) ||
		!validResultStoreIdentity(input.reservation.hubWaitInvocationId) ||
		!strictHubRecord(input.reservation.suppression, [
			"schemaVersion",
			"identity",
			"reservationId",
			"suppressionOperationId",
			"consumer",
			"currentAuthoritySha256",
			"reservationRequestSha256",
			"suppressedAt",
			"receiptSha256",
		]) ||
		input.reservation.suppression.schemaVersion !== 1 ||
		input.reservation.suppression.consumer !== "hub_wait" ||
		!exactJson(input.reservation.suppression.identity, input.reservation.identity) ||
		input.reservation.suppression.reservationId !== input.reservation.reservationId ||
		!validResultStoreIdentity(input.reservation.suppression.suppressionOperationId) ||
		input.reservation.suppression.currentAuthoritySha256 !== input.reservation.currentAuthoritySha256 ||
		input.reservation.suppression.reservationRequestSha256 !== input.reservation.reservationRequestSha256 ||
		input.reservation.suppression.suppressedAt !== input.reservation.reservedAt ||
		!validResultStoreSha256Ref(input.reservation.suppression.receiptSha256) ||
		!validResultStoreSha256Ref(input.reservation.receiptSha256) ||
		!strictHubRecord(input.releaseAttempt, [
			"schemaVersion",
			"operation",
			"operationId",
			"requestSha256",
			"preparedAt",
			"attemptSha256",
		]) ||
		input.releaseAttempt.schemaVersion !== 1 ||
		!strictHubRecord(input.releaseAttempt.operation, ["stage", "operationId", "requestSha256", "request"]) ||
		input.releaseAttempt.operation.stage !== "reservation_release" ||
		!strictHubRecord(input.releaseAttempt.operation.request, [
			"settlement",
			"currentAuthority",
			"reservation",
			"releaseOperationId",
			"reason",
			"releaseRequestSha256",
		]) ||
		!payloadPlainData(input.releaseAttempt.operation.request.settlement) ||
		!payloadPlainData(input.releaseAttempt.operation.request.currentAuthority) ||
		!exactJson(input.releaseAttempt.operation.request.reservation, input.reservation) ||
		!validResultStoreIdentity(input.releaseAttempt.operation.request.releaseOperationId) ||
		input.releaseAttempt.operation.request.reason !== "hub_message_won" ||
		input.releaseAttempt.operation.operationId !== input.releaseAttempt.operation.request.releaseOperationId ||
		input.releaseAttempt.operation.requestSha256 !== input.releaseAttempt.operation.request.releaseRequestSha256 ||
		input.releaseAttempt.operationId !== input.releaseAttempt.operation.operationId ||
		input.releaseAttempt.requestSha256 !== input.releaseAttempt.operation.requestSha256 ||
		!validResultStoreIso8601(input.releaseAttempt.preparedAt) ||
		!validResultStoreSha256Ref(input.releaseAttempt.attemptSha256) ||
		!validResultStoreSha256Ref(input.releaseStateSha256)
	)
		return false;
	const releaseState = input;
	const releaseRequest = releaseState.releaseAttempt.operation.request;
	if (releaseRequest.currentAuthority.kind !== "current_owner_epoch") return false;
	const { receiptSha256: _suppressionReceiptSha256, ...suppressionCore } = releaseState.reservation.suppression;
	const { receiptSha256: _reservationReceiptSha256, ...reservationCore } = releaseState.reservation;
	try {
		const canonicalReservation = deriveTransientTaskHubDetachedReservationAttemptV1({
			settlement: releaseRequest.settlement,
			currentAuthority: releaseRequest.currentAuthority,
			disposition: "hub_wait_consumption",
			hubWaitInvocationId: releaseState.reservation.hubWaitInvocationId,
			preparedAt: releaseState.reservation.reservedAt,
		});
		const canonicalReleaseAttempt = deriveTransientTaskHubDetachedReleaseAttemptV1({
			settlement: releaseRequest.settlement,
			currentAuthority: releaseRequest.currentAuthority,
			reservation: releaseState.reservation,
			reason: "hub_message_won",
			preparedAt: releaseState.releaseAttempt.preparedAt,
		}).attempt;
		if (
			!exactJson(releaseState.reservation.identity, releaseRequest.settlement.identity) ||
			releaseState.reservation.currentAuthoritySha256 !== releaseRequest.currentAuthority.currentAuthoritySha256 ||
			releaseState.reservation.reservationId !== canonicalReservation.request.reservationId ||
			releaseState.reservation.reservationRequestSha256 !== canonicalReservation.request.reservationRequestSha256 ||
			releaseState.reservation.suppression.suppressionOperationId !==
				canonicalReservation.request.suppressionOperationId ||
			releaseState.reservation.suppression.receiptSha256 !==
				detachedDigest("suppression-receipt", suppressionCore) ||
			releaseState.reservation.receiptSha256 !== detachedDigest("reservation-receipt", reservationCore) ||
			!exactJson(releaseState.releaseAttempt, canonicalReleaseAttempt)
		)
			return false;
	} catch {
		return false;
	}
	const state = input.state;
	if (state === "attempt_frozen" || state === "prepare_outcome_unknown") {
		if (
			input.notAppliedReceipt !== null ||
			input.releaseReceipt !== null ||
			input.terminalDisposition !== null ||
			input.terminalReceiptSha256 !== null
		)
			return false;
	} else if (state === "not_applied" || state === "outcome_unknown" || state === "released") {
		if (
			!strictHubRecord(input.notAppliedReceipt, [
				"schemaVersion",
				"identitySha256",
				"stage",
				"operationId",
				"requestSha256",
				"attemptSha256",
				"storedAt",
				"receiptSha256",
			]) ||
			input.notAppliedReceipt.schemaVersion !== 1 ||
			input.notAppliedReceipt.stage !== "reservation_release" ||
			input.notAppliedReceipt.operationId !== input.releaseAttempt.operationId ||
			input.notAppliedReceipt.requestSha256 !== input.releaseAttempt.requestSha256 ||
			input.notAppliedReceipt.attemptSha256 !== input.releaseAttempt.attemptSha256 ||
			!validResultStoreSha256Ref(input.notAppliedReceipt.identitySha256) ||
			!validResultStoreIso8601(input.notAppliedReceipt.storedAt) ||
			!validResultStoreSha256Ref(input.notAppliedReceipt.receiptSha256)
		)
			return false;
		const { receiptSha256: _notAppliedReceiptSha256, ...notAppliedCore } = input.notAppliedReceipt;
		if (input.notAppliedReceipt.receiptSha256 !== detachedDigest("settlement-not-applied-receipt", notAppliedCore))
			return false;
		if (state === "released") {
			if (
				(input.releaseResultStatus !== "released" && input.releaseResultStatus !== "already_released") ||
				!strictHubRecord(input.releaseReceipt, [
					"schemaVersion",
					"identity",
					"reservationReceiptSha256",
					"releaseOperationId",
					"reason",
					"releaseRequestSha256",
					"releasedAt",
					"receiptSha256",
				]) ||
				input.releaseReceipt.schemaVersion !== 1 ||
				!exactJson(input.releaseReceipt.identity, input.reservation.identity) ||
				input.releaseReceipt.reservationReceiptSha256 !== input.reservation.receiptSha256 ||
				input.releaseReceipt.releaseOperationId !== input.releaseAttempt.operationId ||
				input.releaseReceipt.reason !== "hub_message_won" ||
				input.releaseReceipt.releaseRequestSha256 !== input.releaseAttempt.requestSha256 ||
				!validResultStoreIso8601(input.releaseReceipt.releasedAt) ||
				!validResultStoreSha256Ref(input.releaseReceipt.receiptSha256) ||
				input.terminalDisposition !== null ||
				input.terminalReceiptSha256 !== null
			)
				return false;
			const { receiptSha256: _releaseReceiptSha256, ...releaseReceiptCore } = input.releaseReceipt;
			if (input.releaseReceipt.receiptSha256 !== detachedDigest("reservation-release-receipt", releaseReceiptCore))
				return false;
		} else if (
			input.releaseReceipt !== null ||
			input.terminalDisposition !== null ||
			input.terminalReceiptSha256 !== null
		)
			return false;
	} else if (state === "already_terminal") {
		if (
			(input.notAppliedReceipt !== null && !payloadPlainData(input.notAppliedReceipt)) ||
			input.releaseReceipt !== null ||
			!validResultStoreIdentity(input.terminalDisposition) ||
			!validResultStoreSha256Ref(input.terminalReceiptSha256)
		)
			return false;
	} else return false;
	const { releaseStateSha256: _releaseStateSha256, ...releaseCore } = input;
	return input.releaseStateSha256 === detachedDigest("hub-release-state", releaseCore);
}

function detachedHubContinuationMatches(row: PrivateDetachedHubWinnerRowV1): boolean {
	const continuation = row.continuation;
	if (
		continuation === null ||
		!validDetachedHubCaptureRequest(row.captureRequest) ||
		!strictHubRecord(continuation, [
			"schemaVersion",
			"selector",
			"preselectionClaimSha256",
			"message",
			"selectionReceipt",
			"returnTargetSha256",
			"returnTargetRegistration",
			"captureRequestSha256",
			"sendAwaitOutboundReceipt",
			"revision",
			"releases",
			"continuationSha256",
		]) ||
		continuation.schemaVersion !== 1 ||
		!validDetachedHubSelector(continuation.selector) ||
		!validDetachedHubConsumedMessage(continuation.message) ||
		!validDetachedHubRegistrationReceipt(continuation.returnTargetRegistration) ||
		!validResultStoreInteger(continuation.revision) ||
		!strictArray(continuation.releases) ||
		!continuation.releases.every(validDetachedHubReleaseState) ||
		!validResultStoreSha256Ref(continuation.continuationSha256) ||
		!strictHubRecord(continuation.selectionReceipt, [
			"schemaVersion",
			"key",
			"preselectionClaimSha256",
			"messageSha256",
			"returnTargetSha256",
			"returnTargetRegistrationReceiptSha256",
			"selectorInstallRequestSha256",
			"captureRequestSha256",
			"sendAwaitOutboundReceiptSha256",
			"selectedReservationReceiptSha256s",
			"releaseAttemptSha256s",
			"completionOperationId",
			"selectionPreparedAt",
			"receiptSha256",
		]) ||
		continuation.selectionReceipt.schemaVersion !== 1 ||
		!validResultStoreSha256Ref(continuation.selectionReceipt.receiptSha256)
	)
		return false;
	const capture = row.captureRequest;
	const selection = continuation.selectionReceipt;
	const { receiptSha256: _selectionReceiptSha256, ...selectionCore } = selection;
	const expectedSelectionCore = {
		schemaVersion: 1 as const,
		key: capture.selector.key,
		preselectionClaimSha256: capture.preselectionClaimSha256,
		messageSha256: capture.message.messageSha256,
		returnTargetSha256: capture.selector.key.returnTargetSha256,
		returnTargetRegistrationReceiptSha256: capture.returnTargetRegistrationReceipt.receiptSha256,
		selectorInstallRequestSha256: capture.selector.selectorInstallRequestSha256,
		captureRequestSha256: capture.captureRequestSha256,
		sendAwaitOutboundReceiptSha256: capture.sendAwaitOutboundReceipt?.receiptSha256 ?? null,
		selectedReservationReceiptSha256s: continuation.releases.map(entry => entry.reservation.receiptSha256),
		releaseAttemptSha256s: continuation.releases.map(entry => entry.releaseAttempt.attemptSha256),
		completionOperationId: capture.selector.completionOperationId,
		selectionPreparedAt: capture.selector.selectionPreparedAt,
	};
	if (
		!exactJson(selectionCore, expectedSelectionCore) ||
		selection.receiptSha256 !== detachedDigest("hub-message-selection-receipt", expectedSelectionCore) ||
		!exactJson(continuation.selector, capture.selector) ||
		continuation.preselectionClaimSha256 !== capture.preselectionClaimSha256 ||
		!exactJson(continuation.message, capture.message) ||
		!exactJson(continuation.returnTargetRegistration, capture.returnTargetRegistrationReceipt) ||
		continuation.captureRequestSha256 !== capture.captureRequestSha256 ||
		!exactJson(continuation.sendAwaitOutboundReceipt, capture.sendAwaitOutboundReceipt) ||
		continuation.returnTargetSha256 !== capture.selector.returnTarget.returnTargetSha256
	)
		return false;
	const { continuationSha256: _continuationSha256, ...continuationCore } = continuation;
	return continuation.continuationSha256 === detachedDigest("hub-winner-continuation", continuationCore);
}
function validDetachedHubCurrentSelectorAuthority(
	input: unknown,
	capture: Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0],
): input is Parameters<TransientTaskDetachedSettlementStoreV1["adoptMessageWinner"]>[0]["currentSelectorAuthority"] {
	if (
		!strictHubRecord(input, [
			"schemaVersion",
			"currentParentSessionAuthority",
			"preselectionClaim",
			"captureRequestSha256",
			"messageSha256",
			"returnTargetRegistrationReceiptSha256",
			"authoritySha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validDetachedHubCurrentParentAuthority(input.currentParentSessionAuthority) ||
		!validDetachedHubPreselectionClaim(input.preselectionClaim) ||
		!exactJson(input.currentParentSessionAuthority, input.preselectionClaim.currentAuthority) ||
		!exactJson(input.preselectionClaim, capture.returnTargetRegistrationReceipt.claim) ||
		input.captureRequestSha256 !== capture.captureRequestSha256 ||
		input.messageSha256 !== capture.message.messageSha256 ||
		input.returnTargetRegistrationReceiptSha256 !== capture.returnTargetRegistrationReceipt.receiptSha256 ||
		!validResultStoreSha256Ref(input.authoritySha256)
	)
		return false;
	const { authoritySha256: _authoritySha256, ...core } = input;
	return input.authoritySha256 === detachedDigest("hub-wait-message-winner-current-selector-authority", core);
}

function validDetachedHubInspectRequest(
	input: unknown,
): input is Parameters<TransientTaskDetachedSettlementStoreV1["inspectMessageWinner"]>[0] {
	if (
		!strictHubRecord(input, [
			"key",
			"expectedPreselectionClaimSha256",
			"expectedCurrentSelectorAuthoritySha256",
			"expectedMessageSha256",
			"expectedCaptureRequestSha256",
			"expectedSelectorInstallRequestSha256",
			"expectedReturnTargetSha256",
			"expectedReturnTargetRegistrationReceiptSha256",
			"inspectRequestSha256",
		]) ||
		!validDetachedHubKey(input.key) ||
		!validResultStoreSha256Ref(input.expectedPreselectionClaimSha256) ||
		!validResultStoreSha256Ref(input.expectedCurrentSelectorAuthoritySha256) ||
		!validResultStoreSha256Ref(input.expectedMessageSha256) ||
		!validResultStoreSha256Hex(input.expectedCaptureRequestSha256) ||
		!validResultStoreSha256Hex(input.expectedSelectorInstallRequestSha256) ||
		!validResultStoreSha256Ref(input.expectedReturnTargetSha256) ||
		!validResultStoreSha256Ref(input.expectedReturnTargetRegistrationReceiptSha256) ||
		!validResultStoreSha256Hex(input.inspectRequestSha256)
	)
		return false;
	const { inspectRequestSha256: _inspectRequestSha256, ...core } = input;
	return input.inspectRequestSha256 === detachedHex("hub-winner-inspect-request", core);
}

function detachedHubInspectRequestMatchesCapture(
	request: Parameters<TransientTaskDetachedSettlementStoreV1["inspectMessageWinner"]>[0],
	capture: Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0],
): boolean {
	return (
		exactJson(request.key, capture.selector.key) &&
		request.expectedPreselectionClaimSha256 === capture.preselectionClaimSha256 &&
		request.expectedMessageSha256 === capture.message.messageSha256 &&
		request.expectedCaptureRequestSha256 === capture.captureRequestSha256 &&
		request.expectedSelectorInstallRequestSha256 === capture.selector.selectorInstallRequestSha256 &&
		request.expectedReturnTargetSha256 === capture.selector.returnTarget.returnTargetSha256 &&
		request.expectedReturnTargetRegistrationReceiptSha256 === capture.returnTargetRegistrationReceipt.receiptSha256
	);
}

function detachedHubInspectRequestMatchesAuthority(
	request: Parameters<TransientTaskDetachedSettlementStoreV1["inspectMessageWinner"]>[0],
	capture: Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0],
	authority: Parameters<TransientTaskDetachedSettlementStoreV1["adoptMessageWinner"]>[0]["currentSelectorAuthority"],
): boolean {
	return (
		detachedHubInspectRequestMatchesCapture(request, capture) &&
		request.expectedCurrentSelectorAuthoritySha256 === authority.authoritySha256
	);
}

function detachedHubInspectionBinding(
	request: Parameters<TransientTaskDetachedSettlementStoreV1["inspectMessageWinner"]>[0],
) {
	const core = {
		keySha256: hashTransientTaskHubWaitMessageCanonicalRecordV1("winner-key", request.key),
		preselectionClaimSha256: request.expectedPreselectionClaimSha256,
		currentSelectorAuthoritySha256: request.expectedCurrentSelectorAuthoritySha256,
		messageSha256: request.expectedMessageSha256,
		captureRequestSha256: request.expectedCaptureRequestSha256,
		selectorInstallRequestSha256: request.expectedSelectorInstallRequestSha256,
		returnTargetSha256: request.expectedReturnTargetSha256,
		returnTargetRegistrationReceiptSha256: request.expectedReturnTargetRegistrationReceiptSha256,
		inspectRequestSha256: request.inspectRequestSha256,
	};
	return { ...core, inspectionSha256: detachedDigest("hub-winner-inspection", core) };
}

function validDetachedHubInspection(
	input: unknown,
	request: Parameters<TransientTaskDetachedSettlementStoreV1["inspectMessageWinner"]>[0],
	allowed: readonly ("absent" | "active" | "completed")[],
): boolean {
	if (!payloadPlainData(input) || input === null || typeof input !== "object" || !("status" in input)) return false;
	const binding = detachedHubInspectionBinding(request);
	const status = input.status;
	const keys =
		status === "active"
			? [
					"status",
					...Object.keys(binding),
					"selectionReceiptSha256",
					"revision",
					"continuationSha256",
					"releaseStateSha256s",
					"allReleasesTerminal",
				]
			: status === "completed"
				? ["status", ...Object.keys(binding), "selectionReceiptSha256", "completionReceiptSha256"]
				: ["status", ...Object.keys(binding)];
	if (
		typeof status !== "string" ||
		!allowed.includes(status as "absent" | "active" | "completed") ||
		!strictHubRecord(input, keys) ||
		!Object.entries(binding).every(([key, value]) => input[key] === value)
	)
		return false;
	if (status === "active")
		return (
			validResultStoreSha256Ref(input.selectionReceiptSha256) &&
			validResultStoreInteger(input.revision) &&
			validResultStoreSha256Ref(input.continuationSha256) &&
			strictArray(input.releaseStateSha256s) &&
			input.releaseStateSha256s.every(validResultStoreSha256Ref) &&
			typeof input.allReleasesTerminal === "boolean"
		);
	if (status === "completed")
		return (
			validResultStoreSha256Ref(input.selectionReceiptSha256) &&
			validResultStoreSha256Ref(input.completionReceiptSha256)
		);
	return status === "absent";
}

function validDetachedHubAuthoritativeAbsenceReceipt(
	input: unknown,
	capture: Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0],
): input is ConfidentialTransientTaskHubWaitMessageWinnerAuthoritativeAbsenceReceiptV1 {
	if (
		!strictHubRecord(input, ["schemaVersion", "proof", "absenceRequestSha256", "receiptSha256"]) ||
		input.schemaVersion !== 1 ||
		!strictHubRecord(input.proof, [
			"schemaVersion",
			"captureRequest",
			"currentSelectorAuthority",
			"inspectRequest",
			"absenceInspection",
			"absenceRequestSha256",
			"observedSelectorRevision",
			"observedInvocationState",
			"observedWinnerState",
			"observedSelectionEffectState",
			"proofSource",
			"provenAt",
			"proofSha256",
		]) ||
		input.proof.schemaVersion !== 1 ||
		!exactJson(input.proof.captureRequest, capture) ||
		!validDetachedHubCurrentSelectorAuthority(input.proof.currentSelectorAuthority, capture) ||
		!validDetachedHubInspectRequest(input.proof.inspectRequest) ||
		!validDetachedHubInspection(input.proof.absenceInspection, input.proof.inspectRequest, ["absent"]) ||
		!detachedHubInspectRequestMatchesAuthority(
			input.proof.inspectRequest,
			capture,
			input.proof.currentSelectorAuthority,
		) ||
		input.proof.absenceRequestSha256 !== input.absenceRequestSha256 ||
		input.proof.observedSelectorRevision !== 0 ||
		input.proof.observedInvocationState !== "open" ||
		input.proof.observedWinnerState !== "absent" ||
		input.proof.observedSelectionEffectState !== "not_applied" ||
		input.proof.proofSource !== "atomic_selector_transaction_index" ||
		!validResultStoreIso8601(input.proof.provenAt) ||
		!validResultStoreSha256Hex(input.absenceRequestSha256) ||
		!validResultStoreSha256Ref(input.proof.proofSha256) ||
		!validResultStoreSha256Ref(input.receiptSha256)
	)
		return false;
	const { proofSha256: _proofSha256, ...proofCore } = input.proof;
	const { receiptSha256: _receiptSha256, ...receiptCore } = input;
	return (
		input.proof.proofSha256 === detachedDigest("hub-winner-authoritative-absence-proof", proofCore) &&
		input.receiptSha256 === detachedDigest("hub-winner-authoritative-absence-receipt", receiptCore)
	);
}

function detachedHubSelectedReturnResult(
	continuation: ConfidentialTransientTaskHubWaitMessageWinnerContinuationV1,
): ConfidentialTransientTaskHubWaitMessageReturnResultV1 | null {
	const registration = continuation.returnTargetRegistration;
	const message = continuation.message;
	const waited = {
		id: message.id,
		from: message.from,
		to: message.to,
		body: message.body,
		ts: message.ts,
		...(message.replyTo === null ? {} : { replyTo: message.replyTo }),
	};
	if (registration.claim.resumePlan.mode === "send_await") {
		const outbound = continuation.sendAwaitOutboundReceipt;
		const outboundPlan = registration.claim.resumePlan.sendAwaitOutboundPlan;
		if (
			outbound === null ||
			outbound.sourceReceipt.outcome === "failed" ||
			outbound.planSha256 !== outboundPlan.planSha256 ||
			outbound.sourceReceipt.to !== outboundPlan.message.to ||
			outboundPlan.message.from !== continuation.selector.key.senderId
		)
			return null;
		const result: ConfidentialTransientTaskHubSendAwaitSelectedReplyAgentToolResultV1 = {
			content: [
				{
					type: "text",
					text: `Delivered to 1 peer(s):\n- ${outbound.sourceReceipt.to}: ${outbound.sourceReceipt.outcome}\n\nReply from ${message.from}:\n${message.body}`,
				},
			],
			details: {
				op: "send",
				from: continuation.selector.key.senderId,
				to: outboundPlan.message.to,
				receipts: [outbound.sourceReceipt],
				waited,
			},
			isError: false,
		};
		const resultJsonUtf8 = JSON.stringify(result);
		const core = {
			schemaVersion: 1 as const,
			result,
			resultJsonUtf8,
			resultJsonUtf8Sha256: foregroundUtf8Sha256(resultJsonUtf8),
			resultJsonUtf8ByteLength: Buffer.byteLength(resultJsonUtf8, "utf8"),
		};
		return { ...core, resultSha256: detachedDigest("hub-wait-message-return-result", core) };
	}
	if (continuation.sendAwaitOutboundReceipt !== null) return null;
	const replyTag = message.replyTo === null ? "" : ` (reply to ${message.replyTo})`;
	const result: ConfidentialTransientTaskHubWaitSelectedMessageAgentToolResultV1 = {
		content: [{ type: "text", text: `[${message.id}] ${message.from}${replyTag}: ${message.body}` }],
		details: { op: "wait", from: continuation.selector.key.senderId, waited },
	};
	const resultJsonUtf8 = JSON.stringify(result);
	const core = {
		schemaVersion: 1 as const,
		result,
		resultJsonUtf8,
		resultJsonUtf8Sha256: foregroundUtf8Sha256(resultJsonUtf8),
		resultJsonUtf8ByteLength: Buffer.byteLength(resultJsonUtf8, "utf8"),
	};
	return { ...core, resultSha256: detachedDigest("hub-wait-message-return-result", core) };
}

function detachedHubPostHookFinalization(
	continuation: ConfidentialTransientTaskHubWaitMessageWinnerContinuationV1,
	raw: ConfidentialTransientTaskHubWaitMessageReturnResultV1,
	toolResultMessageTimestamp: number,
): ConfidentialTransientTaskHubWaitMessagePostHookFinalizationV1 {
	const plan = continuation.returnTargetRegistration.afterToolCallPlan;
	const rawText = raw.result.content[0].text;
	const finalAgentToolResult: ConfidentialTransientTaskHubWaitMessagePostHookFinalizationV1["finalAgentToolResult"] =
		plan.overlaySnapshot.mode === "prepend_ttsr_reminder"
			? {
					content: [
						{ type: "text", text: plan.overlaySnapshot.renderedReminderUtf8 },
						{ type: "text", text: rawText },
					],
					details: raw.result.details,
					providerMetadata: undefined,
					isError: false,
				}
			: {
					content: [{ type: "text", text: rawText }],
					details: raw.result.details,
					providerMetadata: undefined,
					isError: false,
				};
	const target = continuation.returnTargetRegistration.target;
	const exactToolResultMessage: ConfidentialTransientTaskHubWaitMessagePostHookFinalizationV1["exactToolResultMessage"] =
		{
			role: "toolResult",
			toolCallId: target.toolCallId,
			toolName: "hub",
			content: finalAgentToolResult.content,
			details: finalAgentToolResult.details,
			providerMetadata: undefined,
			isError: finalAgentToolResult.isError,
			timestamp: toolResultMessageTimestamp,
		};
	const finalAgentToolResultJsonUtf8 = JSON.stringify(finalAgentToolResult);
	const exactToolResultMessageJsonUtf8 = JSON.stringify(exactToolResultMessage);
	const core = {
		schemaVersion: 1 as const,
		returnResultSha256: raw.resultSha256,
		afterToolCallPlanSha256: plan.planSha256,
		finalAgentToolResult,
		finalAgentToolResultJsonUtf8,
		finalAgentToolResultJsonUtf8Sha256: foregroundUtf8Sha256(finalAgentToolResultJsonUtf8),
		finalAgentToolResultJsonUtf8ByteLength: Buffer.byteLength(finalAgentToolResultJsonUtf8, "utf8"),
		exactToolResultMessage,
		exactToolResultMessageJsonUtf8,
		exactToolResultMessageJsonUtf8Sha256: foregroundUtf8Sha256(exactToolResultMessageJsonUtf8),
		exactToolResultMessageJsonUtf8ByteLength: Buffer.byteLength(exactToolResultMessageJsonUtf8, "utf8"),
	};
	return { ...core, finalizationSha256: detachedDigest("hub-wait-message-post-hook-finalization", core) };
}

function detachedHubMutableToolResultMessage(
	exact: ConfidentialTransientTaskHubWaitMessagePostHookFinalizationV1["exactToolResultMessage"],
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: exact.toolCallId,
		toolName: "hub",
		content: exact.content.map(part => ({ type: "text", text: part.text })),
		details: exact.details,
		isError: exact.isError,
		timestamp: exact.timestamp,
	};
}

function detachedHubSerializerQueueMatches(
	input: unknown,
	serializerKey: ConfidentialAgentSessionToolResultSerializerQueueStateV1["core"]["serializerKey"],
): input is ConfidentialAgentSessionToolResultSerializerQueueStateV1 {
	if (!strictRecord(input, ["core", "queueStateSha256"])) return false;
	const core = input.core;
	if (
		!strictRecord(core, [
			"serializerKey",
			"orderedTickets",
			"committedTicketCount",
			"previousPrimaryReceiptSha256",
			"updatedAt",
		]) ||
		!validDetachedHubSerializerKey(core.serializerKey) ||
		!exactJson(core.serializerKey, serializerKey) ||
		!strictArray(core.orderedTickets) ||
		!validResultStoreInteger(core.committedTicketCount) ||
		core.committedTicketCount > core.orderedTickets.length ||
		(core.previousPrimaryReceiptSha256 !== null && !validResultStoreSha256Ref(core.previousPrimaryReceiptSha256)) ||
		!validResultStoreIso8601(core.updatedAt) ||
		!validResultStoreSha256Ref(input.queueStateSha256)
	)
		return false;
	for (const ticket of core.orderedTickets) {
		if (!strictRecord(ticket, ["core", "ticketSha256"])) return false;
		const ticketCore = ticket.core;
		if (
			!payloadPlainData(ticketCore) ||
			ticketCore === null ||
			typeof ticketCore !== "object" ||
			!strictRecord(ticketCore, Object.keys(ticketCore)) ||
			!validResultStoreSha256Ref(ticket.ticketSha256) ||
			ticket.ticketSha256 !== foregroundUtf8Sha256(JSON.stringify(ticketCore))
		)
			return false;
	}
	return input.queueStateSha256 === foregroundUtf8Sha256(JSON.stringify(core));
}

function detachedHubAllocationReceipt(
	result: ConfidentialAgentSessionToolResultTicketAllocationResultV1,
	request: ConfidentialAgentSessionToolResultTicketAllocationRequestV1,
	ticketInput: ConfidentialAgentSessionToolResultPersistenceTicketInputV1,
	completedAt: ISO8601,
): ConfidentialAgentSessionToolResultTicketAllocationReceiptV1 | null {
	if (
		!proxyFreeData(result) ||
		!strictRecord(result, ["status", "receipt"]) ||
		(result.status !== "allocated" && result.status !== "already_allocated") ||
		!strictRecord(result.receipt, ["core", "receiptSha256"]) ||
		!strictRecord(result.receipt.core, [
			"allocationRequestSha256",
			"ticket",
			"previousSerializerQueueState",
			"registeredSerializerQueueState",
			"previousAllocatedTicketCount",
			"allocatedTicketCount",
			"allocatedAt",
		]) ||
		!validResultStoreSha256Ref(result.receipt.receiptSha256)
	)
		return null;
	const core = result.receipt.core;
	if (
		core.allocationRequestSha256 !== request.requestSha256 ||
		!strictRecord(core.ticket, ["core", "ticketSha256"]) ||
		!strictRecord(core.ticket.core, [
			"schemaVersion",
			"serializerKey",
			"completionOrdinal",
			"toolCallId",
			"toolName",
			"exactToolResultMessage",
			"exactToolResultMessageSha256",
			"registeredBeforeEmissionAt",
			"route",
			"ordinaryPersistence",
		]) ||
		!validResultStoreSha256Ref(core.ticket.ticketSha256) ||
		!detachedHubSerializerQueueMatches(core.previousSerializerQueueState, ticketInput.serializerKey) ||
		!detachedHubSerializerQueueMatches(core.registeredSerializerQueueState, ticketInput.serializerKey) ||
		!validResultStoreInteger(core.previousAllocatedTicketCount) ||
		!validResultStoreInteger(core.allocatedTicketCount) ||
		core.allocatedAt !== completedAt
	)
		return null;
	const ticket = core.ticket;
	const { completionOrdinal, registeredBeforeEmissionAt, ...returnedTicketInput } = ticket.core;
	const previous = core.previousSerializerQueueState;
	const registered = core.registeredSerializerQueueState;
	if (
		!exactJson(returnedTicketInput, ticketInput) ||
		registeredBeforeEmissionAt !== completedAt ||
		completionOrdinal !== previous.core.orderedTickets.length ||
		core.previousAllocatedTicketCount !== previous.core.orderedTickets.length ||
		core.allocatedTicketCount !== core.previousAllocatedTicketCount + 1 ||
		registered.core.orderedTickets.length !== core.allocatedTicketCount ||
		!exactJson(registered.core.orderedTickets.slice(0, -1), previous.core.orderedTickets) ||
		!exactJson(registered.core.orderedTickets.at(-1), ticket) ||
		registered.core.committedTicketCount !== previous.core.committedTicketCount ||
		registered.core.previousPrimaryReceiptSha256 !== previous.core.previousPrimaryReceiptSha256 ||
		registered.core.updatedAt !== completedAt
	)
		return null;
	if (
		core.ticket.ticketSha256 !== foregroundUtf8Sha256(JSON.stringify(core.ticket.core)) ||
		result.receipt.receiptSha256 !== foregroundUtf8Sha256(JSON.stringify(core))
	)
		return null;
	return result.receipt;
}

function detachedHubOrdinaryPersistenceTicket(
	input: ConfidentialAgentSessionToolResultTicketAllocationReceiptV1["core"]["ticket"],
): input is ConfidentialTransientTaskHubWaitMessageOrdinaryPersistenceTicketV1 {
	return input.core.route === "non_task_ordinary" && input.core.toolName === "hub";
}

function validDetachedHubReleaseProgressRequest(
	input: unknown,
): input is Parameters<TransientTaskDetachedSettlementStoreV1["recordReleaseProgress"]>[0] {
	if (
		!strictHubRecord(input, [
			"key",
			"expectedRevision",
			"expectedContinuationSha256",
			"releaseIndex",
			"expectedReleaseStateSha256",
			"nextReleaseState",
			"progressRequestSha256",
		]) ||
		!validDetachedHubKey(input.key) ||
		!validResultStoreInteger(input.expectedRevision) ||
		!validResultStoreSha256Ref(input.expectedContinuationSha256) ||
		!validResultStoreInteger(input.releaseIndex) ||
		!validResultStoreSha256Ref(input.expectedReleaseStateSha256) ||
		!validDetachedHubReleaseState(input.nextReleaseState) ||
		!validResultStoreSha256Hex(input.progressRequestSha256)
	)
		return false;
	const { progressRequestSha256: _progressRequestSha256, ...core } = input;
	return input.progressRequestSha256 === detachedHex("hub-winner-release-progress-request", core);
}

function validDetachedHubAdoptRequest(
	input: unknown,
): input is Parameters<TransientTaskDetachedSettlementStoreV1["adoptMessageWinner"]>[0] {
	if (
		!strictHubRecord(input, [
			"captureRequest",
			"currentSelectorAuthority",
			"inspectRequest",
			"matchingInspection",
			"expectedInspectionSha256",
			"adoptRequestSha256",
		]) ||
		!validDetachedHubCaptureRequest(input.captureRequest) ||
		!validDetachedHubCurrentSelectorAuthority(input.currentSelectorAuthority, input.captureRequest) ||
		!validDetachedHubInspectRequest(input.inspectRequest)
	)
		return false;
	const request = input as unknown as Parameters<TransientTaskDetachedSettlementStoreV1["adoptMessageWinner"]>[0];
	if (
		!detachedHubInspectRequestMatchesAuthority(
			request.inspectRequest,
			request.captureRequest,
			request.currentSelectorAuthority,
		) ||
		!validDetachedHubInspection(request.matchingInspection, request.inspectRequest, ["active", "completed"]) ||
		request.matchingInspection.inspectionSha256 !== request.expectedInspectionSha256 ||
		!validResultStoreSha256Ref(request.expectedInspectionSha256) ||
		!validResultStoreSha256Hex(request.adoptRequestSha256)
	)
		return false;
	const { adoptRequestSha256: _adoptRequestSha256, ...core } = request;
	return request.adoptRequestSha256 === detachedHex("hub-winner-adopt-request", core);
}

function validDetachedHubAbsenceRequest(
	input: unknown,
): input is Parameters<TransientTaskDetachedSettlementStoreV1["proveMessageWinnerAuthoritativeAbsence"]>[0] {
	if (
		!strictHubRecord(input, [
			"captureRequest",
			"currentSelectorAuthority",
			"inspectRequest",
			"matchingAbsenceInspection",
			"expectedInspectionSha256",
			"proofPreparedAt",
			"absenceRequestSha256",
		]) ||
		!validDetachedHubCaptureRequest(input.captureRequest) ||
		!validDetachedHubCurrentSelectorAuthority(input.currentSelectorAuthority, input.captureRequest) ||
		!validDetachedHubInspectRequest(input.inspectRequest)
	)
		return false;
	const request = input as unknown as Parameters<
		TransientTaskDetachedSettlementStoreV1["proveMessageWinnerAuthoritativeAbsence"]
	>[0];
	if (
		!detachedHubInspectRequestMatchesAuthority(
			request.inspectRequest,
			request.captureRequest,
			request.currentSelectorAuthority,
		) ||
		!validDetachedHubInspection(request.matchingAbsenceInspection, request.inspectRequest, ["absent"]) ||
		request.matchingAbsenceInspection.inspectionSha256 !== request.expectedInspectionSha256 ||
		!validResultStoreSha256Ref(request.expectedInspectionSha256) ||
		!validResultStoreIso8601(request.proofPreparedAt) ||
		!validResultStoreSha256Hex(request.absenceRequestSha256)
	)
		return false;
	const { absenceRequestSha256: _absenceRequestSha256, ...core } = request;
	return request.absenceRequestSha256 === detachedHex("hub-winner-authoritative-absence-request", core);
}

function validDetachedHubRetryRequest(
	input: unknown,
): input is Parameters<TransientTaskDetachedSettlementStoreV1["retryMessageWinnerAfterAuthoritativeAbsence"]>[0] {
	if (
		!strictHubRecord(input, [
			"captureRequest",
			"currentSelectorAuthority",
			"authoritativeAbsenceReceipt",
			"retryRequestSha256",
		]) ||
		!validDetachedHubCaptureRequest(input.captureRequest) ||
		!validDetachedHubCurrentSelectorAuthority(input.currentSelectorAuthority, input.captureRequest) ||
		!validDetachedHubAuthoritativeAbsenceReceipt(input.authoritativeAbsenceReceipt, input.captureRequest) ||
		!exactJson(input.authoritativeAbsenceReceipt.proof.currentSelectorAuthority, input.currentSelectorAuthority) ||
		!validResultStoreSha256Hex(input.retryRequestSha256)
	)
		return false;
	const { retryRequestSha256: _retryRequestSha256, ...core } = input;
	return input.retryRequestSha256 === detachedHex("hub-winner-authoritative-absence-retry-request", core);
}

function validDetachedHubRecoveryEnumerateRequest(
	input: unknown,
): input is Parameters<TransientTaskDetachedSettlementStoreV1["enumerateRecoverableMessageWinners"]>[0] {
	return validateTransientTaskHubWaitMessageCanonicalRecordV1("winner-recovery-enumerate-request", input);
}

function validDetachedHubPrimaryCommitJoin(
	input: unknown,
): input is ConfidentialTransientTaskHubWaitMessagePrimaryCommitJoinV1 {
	return Boolean(
		strictHubRecord(input, [
			"primaryCommitReceiptSha256",
			"primaryPersistenceReceiptSha256",
			"primaryCommitTransitionReceiptSha256",
			"ticketAllocationReceiptSha256",
			"ordinaryAppendPlanSha256",
			"ordinaryAppendReceiptSha256",
			"injectionResultPersistenceReceiptSha256",
			"previousSerializerQueueStateSha256",
			"advancedSerializerQueueStateSha256",
			"previousCommittedTicketCount",
			"committedTicketCount",
			"previousPrimaryPersistenceReceiptSha256",
			"newPrimaryPersistenceReceiptSha256",
			"nextPriorLeafEntryId",
			"nextHeadTicketSha256",
		]) &&
			[
				input.primaryCommitReceiptSha256,
				input.primaryPersistenceReceiptSha256,
				input.primaryCommitTransitionReceiptSha256,
				input.ticketAllocationReceiptSha256,
				input.ordinaryAppendPlanSha256,
				input.ordinaryAppendReceiptSha256,
				input.injectionResultPersistenceReceiptSha256,
				input.previousSerializerQueueStateSha256,
				input.advancedSerializerQueueStateSha256,
				input.newPrimaryPersistenceReceiptSha256,
			].every(validResultStoreSha256Ref) &&
			validResultStoreInteger(input.previousCommittedTicketCount) &&
			input.committedTicketCount === input.previousCommittedTicketCount + 1 &&
			(input.previousPrimaryPersistenceReceiptSha256 === null ||
				validResultStoreSha256Ref(input.previousPrimaryPersistenceReceiptSha256)) &&
			validResultStoreIdentity(input.nextPriorLeafEntryId) &&
			(input.nextHeadTicketSha256 === null || validResultStoreSha256Ref(input.nextHeadTicketSha256)),
	);
}

function hasDetachedHubSerializerHeadCommitReceiptShape(
	input: unknown,
): input is ConfidentialTransientTaskHubWaitMessageSerializerHeadCommitReceiptV1 {
	return Boolean(
		strictRecord(input, ["core", "commitReceiptSha256"]) &&
			strictRecord(input.core, [
				"schemaVersion",
				"requestSha256",
				"attemptSha256",
				"transitionReceiptSha256",
				"previousSerializerQueueState",
				"advancedSerializerQueueState",
				"previousSerializerQueueStateSha256",
				"advancedSerializerQueueStateSha256",
				"previousCommittedTicketCount",
				"committedTicketCount",
				"previousPrimaryPersistenceReceiptSha256",
				"newPrimaryPersistenceReceiptSha256",
				"nextPriorLeafEntryId",
				"nextHeadTicketSha256",
				"committedAt",
				"route",
				"primaryPersistenceReceipt",
			]),
	);
}

function validDetachedHubSerializerHeadCommitReceipt(
	input: unknown,
	completion: ConfidentialTransientTaskHubWaitMessageWinnerCompletionReceiptV1,
	join: ConfidentialTransientTaskHubWaitMessagePrimaryCommitJoinV1,
): input is ConfidentialTransientTaskHubWaitMessageSerializerHeadCommitReceiptV1 {
	if (
		!hasDetachedHubSerializerHeadCommitReceiptShape(input) ||
		input.core.schemaVersion !== 1 ||
		input.core.route !== "hub_wait_message_return" ||
		!validResultStoreSha256Ref(input.commitReceiptSha256)
	)
		return false;
	const receipt = input;
	const primary = receipt.core.primaryPersistenceReceipt;
	if (
		!strictRecord(primary, ["core", "primaryReceiptSha256"]) ||
		!strictRecord(primary.core, [
			"schemaVersion",
			"route",
			"requestSha256",
			"transitionReceiptSha256",
			"hubWaitMessageInjectionResultReceipt",
			"nextPriorLeafEntryId",
			"committedAt",
		]) ||
		primary.core.schemaVersion !== 1 ||
		primary.core.route !== "hub_wait_message_return" ||
		!validResultStoreSha256Ref(primary.primaryReceiptSha256) ||
		!strictHubRecord(primary.core.hubWaitMessageInjectionResultReceipt, [
			"schemaVersion",
			"primaryCommitRequestSha256",
			"primaryCommitAttemptSha256",
			"primaryCommitTransitionReceiptSha256",
			"ordinaryPersistenceTicketSha256",
			"headPermitSha256",
			"injectionRegistrationReceiptSha256",
			"injectionAppendReceipt",
			"ordinaryAppendPlanSha256",
			"ordinaryAppendReceipt",
			"nextPriorLeafEntryId",
			"committedAt",
			"receiptSha256",
		])
	)
		return false;
	const effectReceipt = primary.core.hubWaitMessageInjectionResultReceipt;
	if (
		!strictRecord(effectReceipt.injectionAppendReceipt, ["core", "receiptSha256"]) ||
		!payloadPlainData(effectReceipt.injectionAppendReceipt.core) ||
		!validResultStoreSha256Ref(effectReceipt.injectionAppendReceipt.receiptSha256) ||
		!strictRecord(effectReceipt.ordinaryAppendReceipt, ["core", "receiptSha256"]) ||
		!payloadPlainData(effectReceipt.ordinaryAppendReceipt.core) ||
		!validResultStoreSha256Ref(effectReceipt.ordinaryAppendReceipt.receiptSha256) ||
		!validResultStoreSha256Ref(effectReceipt.receiptSha256) ||
		!detachedHubSerializerQueueMatches(
			receipt.core.previousSerializerQueueState,
			completion.returnTarget.serializerKey,
		) ||
		!detachedHubSerializerQueueMatches(
			receipt.core.advancedSerializerQueueState,
			completion.returnTarget.serializerKey,
		)
	)
		return false;
	const previous = receipt.core.previousSerializerQueueState;
	const advanced = receipt.core.advancedSerializerQueueState;
	const nextHeadTicket = advanced.core.orderedTickets[advanced.core.committedTicketCount]?.ticketSha256 ?? null;
	const { receiptSha256: _effectReceiptSha256, ...effectCore } = effectReceipt;
	return (
		receipt.commitReceiptSha256 === foregroundUtf8Sha256(JSON.stringify(receipt.core)) &&
		primary.primaryReceiptSha256 === foregroundUtf8Sha256(JSON.stringify(primary.core)) &&
		effectReceipt.receiptSha256 === foregroundUtf8Sha256(JSON.stringify(effectCore)) &&
		exactJson(previous, completion.registeredSerializerQueueState) &&
		exactJson(advanced.core.orderedTickets, previous.core.orderedTickets) &&
		receipt.core.previousCommittedTicketCount === previous.core.committedTicketCount &&
		receipt.core.committedTicketCount === receipt.core.previousCommittedTicketCount + 1 &&
		advanced.core.committedTicketCount === receipt.core.committedTicketCount &&
		receipt.core.previousPrimaryPersistenceReceiptSha256 === previous.core.previousPrimaryReceiptSha256 &&
		advanced.core.previousPrimaryReceiptSha256 === primary.primaryReceiptSha256 &&
		receipt.core.nextPriorLeafEntryId === primary.core.nextPriorLeafEntryId &&
		receipt.core.nextHeadTicketSha256 === nextHeadTicket &&
		receipt.core.newPrimaryPersistenceReceiptSha256 === primary.primaryReceiptSha256 &&
		primary.core.requestSha256 === receipt.core.requestSha256 &&
		primary.core.transitionReceiptSha256 === receipt.core.transitionReceiptSha256 &&
		effectReceipt.primaryCommitRequestSha256 === receipt.core.requestSha256 &&
		effectReceipt.primaryCommitAttemptSha256 === receipt.core.attemptSha256 &&
		effectReceipt.primaryCommitTransitionReceiptSha256 === receipt.core.transitionReceiptSha256 &&
		effectReceipt.ordinaryPersistenceTicketSha256 === completion.ordinaryPersistenceTicket.ticketSha256 &&
		effectReceipt.injectionRegistrationReceiptSha256 === completion.ttsrInjectionRegistrationReceipt.receiptSha256 &&
		effectReceipt.ordinaryAppendPlanSha256 === join.ordinaryAppendPlanSha256 &&
		effectReceipt.ordinaryAppendReceipt.receiptSha256 === join.ordinaryAppendReceiptSha256 &&
		effectReceipt.nextPriorLeafEntryId === join.nextPriorLeafEntryId &&
		receipt.commitReceiptSha256 === join.primaryCommitReceiptSha256 &&
		primary.primaryReceiptSha256 === join.primaryPersistenceReceiptSha256 &&
		receipt.core.transitionReceiptSha256 === join.primaryCommitTransitionReceiptSha256 &&
		completion.ticketAllocationReceipt.receiptSha256 === join.ticketAllocationReceiptSha256 &&
		effectReceipt.receiptSha256 === join.injectionResultPersistenceReceiptSha256 &&
		previous.queueStateSha256 === join.previousSerializerQueueStateSha256 &&
		advanced.queueStateSha256 === join.advancedSerializerQueueStateSha256 &&
		receipt.core.previousCommittedTicketCount === join.previousCommittedTicketCount &&
		receipt.core.committedTicketCount === join.committedTicketCount &&
		receipt.core.previousPrimaryPersistenceReceiptSha256 === join.previousPrimaryPersistenceReceiptSha256 &&
		receipt.core.newPrimaryPersistenceReceiptSha256 === join.newPrimaryPersistenceReceiptSha256 &&
		receipt.core.nextPriorLeafEntryId === join.nextPriorLeafEntryId &&
		receipt.core.nextHeadTicketSha256 === join.nextHeadTicketSha256
	);
}

function hasDetachedHubCompletionReceiptShape(
	input: unknown,
): input is ConfidentialTransientTaskHubWaitMessageWinnerCompletionReceiptV1 {
	return Boolean(
		strictHubRecord(input, [
			"schemaVersion",
			"key",
			"message",
			"selectionReceipt",
			"returnTarget",
			"returnTargetRegistration",
			"returnResult",
			"postHookFinalization",
			"ordinaryPersistenceTicket",
			"ticketAllocationReceipt",
			"ttsrInjectionRegistrationReceipt",
			"registeredSerializerQueueState",
			"registeredSerializerQueueStateSha256",
			"finalContinuationSha256",
			"terminalReleaseStateSha256s",
			"completionOperationId",
			"completionRequestSha256",
			"completedAt",
			"receiptSha256",
		]) &&
			strictHubRecord(input.postHookFinalization, [
				"schemaVersion",
				"returnResultSha256",
				"afterToolCallPlanSha256",
				"finalAgentToolResult",
				"finalAgentToolResultJsonUtf8",
				"finalAgentToolResultJsonUtf8Sha256",
				"finalAgentToolResultJsonUtf8ByteLength",
				"exactToolResultMessage",
				"exactToolResultMessageJsonUtf8",
				"exactToolResultMessageJsonUtf8Sha256",
				"exactToolResultMessageJsonUtf8ByteLength",
				"finalizationSha256",
			]) &&
			strictHubRecord(input.postHookFinalization.exactToolResultMessage, [
				"role",
				"toolCallId",
				"toolName",
				"content",
				"details",
				"isError",
				"timestamp",
			]) &&
			strictHubRecord(input.ttsrInjectionRegistrationReceipt, [
				"afterToolCallPlanSha256",
				"contentPlan",
				"ordinaryPersistenceTicketSha256",
				"registeredAt",
				"receiptSha256",
			]),
	);
}

function validDetachedHubCompletionReceipt(
	input: unknown,
	row: PrivateDetachedHubWinnerRowV1,
): input is ConfidentialTransientTaskHubWaitMessageWinnerCompletionReceiptV1 {
	if (
		row.continuation === null ||
		!detachedHubContinuationMatches(row) ||
		!hasDetachedHubCompletionReceiptShape(input) ||
		input.schemaVersion !== 1 ||
		!Number.isSafeInteger(input.postHookFinalization.exactToolResultMessage.timestamp) ||
		!validResultStoreIso8601(input.completedAt) ||
		!validResultStoreIdentity(input.completionOperationId) ||
		!validResultStoreSha256Hex(input.completionRequestSha256) ||
		!validResultStoreSha256Ref(input.registeredSerializerQueueStateSha256) ||
		!validResultStoreSha256Ref(input.finalContinuationSha256) ||
		!strictArray(input.terminalReleaseStateSha256s) ||
		!input.terminalReleaseStateSha256s.every(validResultStoreSha256Ref) ||
		!validResultStoreSha256Ref(input.receiptSha256)
	)
		return false;
	const continuation = row.continuation;
	const receipt = input;
	const returnResult = detachedHubSelectedReturnResult(continuation);
	if (returnResult === null || !exactJson(receipt.returnResult, returnResult)) return false;
	const postHookFinalization = detachedHubPostHookFinalization(
		continuation,
		returnResult,
		receipt.postHookFinalization.exactToolResultMessage.timestamp,
	);
	if (!exactJson(receipt.postHookFinalization, postHookFinalization)) return false;
	const completionRequestCore = {
		key: continuation.selector.key,
		expectedRevision: continuation.revision,
		expectedContinuationSha256: continuation.continuationSha256,
		expectedReleaseStateSha256s: continuation.releases.map(entry => entry.releaseStateSha256),
		expectedReturnTargetSha256: continuation.returnTargetSha256,
		expectedReturnTargetRegistrationReceiptSha256: continuation.returnTargetRegistration.receiptSha256,
		completionOperationId: continuation.selector.completionOperationId,
		toolResultMessageTimestamp: receipt.postHookFinalization.exactToolResultMessage.timestamp,
		completedAt: receipt.completedAt,
	};
	if (receipt.completionRequestSha256 !== detachedHex("hub-winner-completion-request", completionRequestCore))
		return false;
	const target = continuation.returnTargetRegistration.target;
	const exactToolResultMessage = detachedHubMutableToolResultMessage(postHookFinalization.exactToolResultMessage);
	const ordinaryPersistenceCore = {
		toolCallId: target.toolCallId,
		toolName: "hub" as const,
		sourceToolResultMessage: exactToolResultMessage,
		sourceToolResultMessageSha256: postHookFinalization.exactToolResultMessageJsonUtf8Sha256,
	};
	const ordinaryPersistence = {
		...ordinaryPersistenceCore,
		ordinaryPersistenceRequestSha256: detachedDigest("hub-winner-ordinary-persistence-request", {
			serializerKeySha256: target.serializerKey.serializerKeySha256,
			...ordinaryPersistenceCore,
			completionRequestSha256: receipt.completionRequestSha256,
		}),
	};
	const ticketInput: ConfidentialAgentSessionToolResultPersistenceTicketInputV1 = {
		schemaVersion: 1,
		serializerKey: target.serializerKey,
		toolCallId: target.toolCallId,
		toolName: "hub",
		exactToolResultMessage,
		exactToolResultMessageSha256: postHookFinalization.exactToolResultMessageJsonUtf8Sha256,
		route: "non_task_ordinary",
		ordinaryPersistence,
	};
	const allocationCore = {
		schemaVersion: 1 as const,
		mode: "allocate" as const,
		ticketInput,
		requestedAt: receipt.completedAt,
	};
	const allocationRequest: ConfidentialAgentSessionToolResultTicketAllocationRequestV1 = {
		core: allocationCore,
		requestSha256: detachedDigest("hub-winner-ticket-allocation-request", allocationCore),
	};
	const allocationReceipt = detachedHubAllocationReceipt(
		{ status: "allocated", receipt: receipt.ticketAllocationReceipt },
		allocationRequest,
		ticketInput,
		receipt.completedAt,
	);
	if (allocationReceipt === null || !exactJson(allocationReceipt, receipt.ticketAllocationReceipt)) return false;
	const injection = receipt.ttsrInjectionRegistrationReceipt;
	const { receiptSha256: _injectionReceiptSha256, ...injectionCore } = injection;
	if (
		injection.afterToolCallPlanSha256 !== continuation.returnTargetRegistration.afterToolCallPlan.planSha256 ||
		!validDetachedHubContentPlan(injection.contentPlan) ||
		!exactJson(
			injection.contentPlan,
			continuation.returnTargetRegistration.afterToolCallPlan.ttsrInjectionContentPlan,
		) ||
		injection.ordinaryPersistenceTicketSha256 !== receipt.ordinaryPersistenceTicket.ticketSha256 ||
		injection.registeredAt !== receipt.completedAt ||
		injection.receiptSha256 !== detachedDigest("hub-winner-ttsr-injection-registration-receipt", injectionCore)
	)
		return false;
	const { receiptSha256: _receiptSha256, ...receiptCore } = receipt;
	return (
		exactJson(receipt.key, continuation.selector.key) &&
		exactJson(receipt.message, continuation.message) &&
		exactJson(receipt.selectionReceipt, continuation.selectionReceipt) &&
		exactJson(receipt.returnTarget, target) &&
		exactJson(receipt.returnTargetRegistration, continuation.returnTargetRegistration) &&
		exactJson(receipt.ordinaryPersistenceTicket, allocationReceipt.core.ticket) &&
		exactJson(receipt.registeredSerializerQueueState, allocationReceipt.core.registeredSerializerQueueState) &&
		receipt.registeredSerializerQueueStateSha256 === receipt.registeredSerializerQueueState.queueStateSha256 &&
		receipt.finalContinuationSha256 === continuation.continuationSha256 &&
		exactJson(
			receipt.terminalReleaseStateSha256s,
			continuation.releases.map(entry => entry.releaseStateSha256),
		) &&
		continuation.releases.every(detachedHubReleaseTerminal) &&
		receipt.completionOperationId === continuation.selector.completionOperationId &&
		receipt.receiptSha256 === detachedDigest("hub-winner-completion-receipt", receiptCore)
	);
}

function validDetachedHubAcknowledgementReceipt(
	input: unknown,
	completion: ConfidentialTransientTaskHubWaitMessageWinnerCompletionReceiptV1,
): input is ConfidentialTransientTaskHubWaitMessageReturnAcknowledgementReceiptV1 {
	if (
		!strictHubRecord(input, [
			"key",
			"completionReceiptSha256",
			"deliveryReceiptSha256",
			"postHookFinalizationSha256",
			"ordinaryPersistenceTicketSha256",
			"ticketAllocationReceiptSha256",
			"ttsrInjectionRegistrationReceiptSha256",
			"primaryCommitJoin",
			"returnDeliveryOperationId",
			"acknowledgementRequestSha256",
			"acknowledgedAt",
			"receiptSha256",
		]) ||
		!validDetachedHubKey(input.key) ||
		!validResultStoreSha256Ref(input.deliveryReceiptSha256) ||
		!validDetachedHubPrimaryCommitJoin(input.primaryCommitJoin) ||
		!validResultStoreIdentity(input.returnDeliveryOperationId) ||
		!validResultStoreSha256Hex(input.acknowledgementRequestSha256) ||
		!validResultStoreIso8601(input.acknowledgedAt) ||
		!validResultStoreSha256Ref(input.receiptSha256)
	)
		return false;
	return (
		exactJson(input.key, completion.key) &&
		input.completionReceiptSha256 === completion.receiptSha256 &&
		input.postHookFinalizationSha256 === completion.postHookFinalization.finalizationSha256 &&
		input.ordinaryPersistenceTicketSha256 === completion.ordinaryPersistenceTicket.ticketSha256 &&
		input.ticketAllocationReceiptSha256 === completion.ticketAllocationReceipt.receiptSha256 &&
		input.ttsrInjectionRegistrationReceiptSha256 === completion.ttsrInjectionRegistrationReceipt.receiptSha256 &&
		input.primaryCommitJoin.ticketAllocationReceiptSha256 === completion.ticketAllocationReceipt.receiptSha256 &&
		validateTransientTaskHubWaitMessageCanonicalRecordV1("return-acknowledgement-receipt", input)
	);
}

function loadDetachedHubWinnerRow(input: unknown): PrivateDetachedHubWinnerRowV1 {
	const value = loadForegroundValue<unknown>(input);
	if (
		!strictHubRecord(value, [
			"kind",
			"captureRequest",
			"continuation",
			"completionReceipt",
			"authoritativeAbsenceReceipt",
			"acknowledgementRequest",
			"acknowledgementReceipt",
		]) ||
		value.kind !== "detached_hub_winner" ||
		!validDetachedHubCaptureRequest(value.captureRequest)
	)
		throw new TypeError("Invalid detached Hub winner row");
	const row = value as unknown as PrivateDetachedHubWinnerRowV1;
	if (row.continuation === null) {
		if (
			row.acknowledgementRequest !== null ||
			row.completionReceipt !== null ||
			row.acknowledgementReceipt !== null ||
			!validDetachedHubAuthoritativeAbsenceReceipt(row.authoritativeAbsenceReceipt, row.captureRequest)
		)
			throw new TypeError("Invalid detached Hub absence row");
		return row;
	}
	if (row.authoritativeAbsenceReceipt !== null || !detachedHubContinuationMatches(row))
		throw new TypeError("Invalid detached Hub continuation row");
	if (row.completionReceipt === null) {
		if (row.acknowledgementRequest !== null || row.acknowledgementReceipt !== null)
			throw new TypeError("Invalid detached Hub acknowledgement row");
		return row;
	}
	if (!validDetachedHubCompletionReceipt(row.completionReceipt, row))
		throw new TypeError("Invalid detached Hub completion row");
	if (
		(row.acknowledgementRequest === null) !== (row.acknowledgementReceipt === null) ||
		(row.acknowledgementRequest !== null &&
			(!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"return-acknowledgement-request",
				row.acknowledgementRequest,
			) ||
				row.acknowledgementRequest.completionReceiptSha256 !== row.completionReceipt.receiptSha256)) ||
		(row.acknowledgementReceipt !== null &&
			!validDetachedHubAcknowledgementReceipt(row.acknowledgementReceipt, row.completionReceipt)) ||
		(row.acknowledgementRequest !== null &&
			row.acknowledgementReceipt !== null &&
			row.acknowledgementReceipt.acknowledgementRequestSha256 !== row.acknowledgementRequest.requestSha256)
	)
		throw new TypeError("Invalid detached Hub acknowledgement row");
	return row;
}

function loadDetachedRow<Value extends PrivateDetachedRowV1>(input: unknown): Value {
	const value = loadForegroundValue<Value>(input);
	if (!payloadPlainData(value) || !strictRecord(value, Object.keys(value)))
		throw new TypeError("Invalid detached durable row");
	return value;
}

function detachedSettlementFromOperation(
	operation: PrivateDetachedOperationV1,
): ConfidentialTransientTaskDetachedSettlementRequestV1 {
	return operation.stage === "settled_result_publication" ? operation.request : operation.request.settlement;
}

function detachedAttemptIndex(
	row: PrivateDetachedSettlementRowV1,
	stage: PrivateDetachedOperationV1["stage"],
	operationId: OperationId,
): number {
	return row.attempts.findIndex(
		entry => entry.attempt.operation.stage === stage && entry.attempt.operationId === operationId,
	);
}

function detachedAttemptState(
	row: PrivateDetachedSettlementRowV1,
	stage: PrivateDetachedOperationV1["stage"],
	operationId: OperationId,
): PrivateDetachedAttemptStateV1 | null {
	const index = detachedAttemptIndex(row, stage, operationId);
	return index < 0 ? null : row.attempts[index];
}

function replaceDetachedAttempt(
	row: PrivateDetachedSettlementRowV1,
	index: number,
	next: PrivateDetachedAttemptStateV1,
): PrivateDetachedSettlementRowV1 {
	const attempts = [...row.attempts];
	attempts[index] = next;
	return { ...row, attempts };
}

function validDetachedIdentity(
	input: unknown,
): input is ConfidentialTransientTaskDetachedSettlementRequestV1["identity"] {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"deliveryOperationId",
			"ownerId",
			"jobId",
			"deliveryEpoch",
			"deliveryRequestSha256",
			"sinkResultUtf8Sha256",
			"sinkResultUtf8ByteLength",
			"identitySha256",
			"terminalStatus",
			"sinkProjectionKind",
			"cancellationKind",
			"jobErrorTextUtf8Sha256",
			"jobErrorTextUtf8ByteLength",
		]) ||
		input.schemaVersion !== 1 ||
		!resultTargetKeyFromRecord(input) ||
		!validResultStoreIdentity(input.deliveryOperationId) ||
		!validResultStoreIdentity(input.ownerId) ||
		!validResultStoreIdentity(input.jobId) ||
		!validResultStoreInteger(input.deliveryEpoch) ||
		!validResultStoreSha256Hex(input.deliveryRequestSha256) ||
		!validResultStoreSha256Ref(input.sinkResultUtf8Sha256) ||
		!validResultStoreInteger(input.sinkResultUtf8ByteLength) ||
		!validResultStoreSha256Ref(input.identitySha256)
	)
		return false;
	if (input.terminalStatus === "cancelled")
		return (
			input.sinkProjectionKind === "detached_cancelled_job_error" &&
			input.cancellationKind === "detached_pre_execution_abort" &&
			validResultStoreSha256Ref(input.jobErrorTextUtf8Sha256) &&
			validResultStoreInteger(input.jobErrorTextUtf8ByteLength)
		);
	return (
		(input.terminalStatus === "completed" || input.terminalStatus === "failed") &&
		input.sinkProjectionKind === "detached_async_result_entry" &&
		input.cancellationKind === null &&
		input.jobErrorTextUtf8Sha256 === null &&
		input.jobErrorTextUtf8ByteLength === null
	);
}

function validDetachedTerminalReceiptForParent(
	input: unknown,
	request: Extract<
		ConfidentialTransientTaskParentResultDeliveryRequestV1,
		{ route: { kind: "owner_routed_async_result" } }
	>,
): input is ConfidentialTransientTaskDetachedSettlementTerminalReceiptV1 {
	if (!payloadPlainData(input) || !input || typeof input !== "object" || !("parentDeliveryOutcome" in input))
		return false;
	const outcome = input.parentDeliveryOutcome;
	const extraKeys =
		outcome === "delivered"
			? ["disposition", "parentDeliveryOutcome", "sinkReceipt", "sinkReceiptSha256"]
			: outcome === "consumed_without_enqueue"
				? ["disposition", "parentDeliveryOutcome", "consumer", "suppression"]
				: outcome === "delivery_epoch_invalidated"
					? ["disposition", "parentDeliveryOutcome", "observedDeliveryEpoch", "invalidationAuthoritySha256"]
					: outcome === "dead_lettered"
						? ["disposition", "parentDeliveryOutcome", "ownerAbsenceAuthoritySha256"]
						: null;
	if (
		!extraKeys ||
		!strictRecord(input, [
			"schemaVersion",
			"identity",
			"reservationReceiptSha256",
			"commitOperationId",
			"commitRequestSha256",
			"currentAuthoritySha256",
			"committedAt",
			"receiptSha256",
			...extraKeys,
		]) ||
		input.schemaVersion !== 1 ||
		!validDetachedIdentity(input.identity) ||
		!resultTargetKeyMatches(input.identity, request) ||
		input.identity.deliveryOperationId !== request.deliveryOperationId ||
		input.identity.ownerId !== request.route.ownerAgentId ||
		input.identity.jobId !== request.route.jobId ||
		input.identity.deliveryEpoch !== request.route.deliveryEpoch ||
		input.identity.deliveryRequestSha256 !== request.deliveryRequestSha256 ||
		input.identity.sinkResultUtf8Sha256 !== request.sinkResultUtf8Sha256 ||
		input.identity.sinkResultUtf8ByteLength !== request.sinkResultUtf8ByteLength ||
		!validResultStoreSha256Ref(input.reservationReceiptSha256) ||
		!validResultStoreIdentity(input.commitOperationId) ||
		!validResultStoreSha256Hex(input.commitRequestSha256) ||
		!validResultStoreSha256Ref(input.currentAuthoritySha256) ||
		!validResultStoreIso8601(input.committedAt) ||
		!validResultStoreSha256Ref(input.receiptSha256)
	)
		return false;
	const { receiptSha256: _receiptSha256, ...terminalCore } = input;
	if (input.receiptSha256 !== detachedDigest("terminal-settlement-receipt", terminalCore)) return false;
	if (outcome === "delivered") {
		if (
			input.disposition !== "current_epoch_enqueue" ||
			input.identity.terminalStatus === "cancelled" ||
			!strictRecord(input.sinkReceipt, [
				"schemaVersion",
				"deliveryOperationId",
				"deliveryRequestSha256",
				"deliveryAuthoritySha256",
				"sinkResultUtf8",
				"sinkResultUtf8Sha256",
				"sinkResultUtf8ByteLength",
				"authorityJoinSha256",
				"appliedAt",
				"routeKind",
				"foregroundSessionAppendReceipt",
				"detachedSettlementIdentity",
				"detachedCurrentAuthoritySha256",
				"reservationReceiptSha256",
				"detachedSessionOutboxReceipt",
				"detachedPrimarySessionPersistenceReceipt",
				"sinkReceiptSha256",
			]) ||
			input.sinkReceipt.schemaVersion !== 1 ||
			input.sinkReceipt.routeKind !== "owner_routed_async_result" ||
			input.sinkReceipt.foregroundSessionAppendReceipt !== null ||
			input.sinkReceipt.deliveryOperationId !== request.deliveryOperationId ||
			input.sinkReceipt.deliveryRequestSha256 !== request.deliveryRequestSha256 ||
			input.sinkReceipt.deliveryAuthoritySha256 !== request.deliveryAuthoritySha256 ||
			input.sinkReceipt.sinkResultUtf8Sha256 !== request.sinkResultUtf8Sha256 ||
			input.sinkReceipt.sinkResultUtf8ByteLength !== request.sinkResultUtf8ByteLength ||
			input.sinkReceipt.sinkResultUtf8 !==
				(request.sinkProjection.kind === "detached_async_result_entry"
					? request.sinkProjection.asyncResultEntryResult
					: request.sinkProjection.jobErrorTextUtf8) ||
			!exactJson(input.sinkReceipt.detachedSettlementIdentity, input.identity) ||
			!validResultStoreSha256Ref(input.sinkReceipt.detachedCurrentAuthoritySha256) ||
			input.sinkReceipt.reservationReceiptSha256 !== input.reservationReceiptSha256 ||
			!payloadPlainData(input.sinkReceipt.detachedSessionOutboxReceipt) ||
			!payloadPlainData(input.sinkReceipt.detachedPrimarySessionPersistenceReceipt) ||
			!validResultStoreSha256Ref(input.sinkReceipt.authorityJoinSha256) ||
			!validResultStoreIso8601(input.sinkReceipt.appliedAt) ||
			!validResultStoreSha256Ref(input.sinkReceipt.sinkReceiptSha256) ||
			input.sinkReceiptSha256 !== input.sinkReceipt.sinkReceiptSha256
		)
			return false;
		const { sinkReceiptSha256: _sinkReceiptSha256, ...sinkCore } = input.sinkReceipt;
		return input.sinkReceipt.sinkReceiptSha256 === detachedDigest("parent-result-sink-receipt", sinkCore);
	}
	if (outcome === "consumed_without_enqueue")
		return (
			(input.disposition === "hub_jobs_consumption" ||
				input.disposition === "hub_wait_consumption" ||
				input.disposition === "hub_cancel_consumption") &&
			(input.consumer === "hub_jobs" || input.consumer === "hub_wait" || input.consumer === "hub_cancel") &&
			input.disposition === `${input.consumer}_consumption` &&
			payloadPlainData(input.suppression)
		);
	if (outcome === "delivery_epoch_invalidated")
		return (
			input.disposition === "delivery_epoch_invalidation" &&
			validResultStoreInteger(input.observedDeliveryEpoch) &&
			input.observedDeliveryEpoch !== input.identity.deliveryEpoch &&
			validResultStoreSha256Ref(input.invalidationAuthoritySha256)
		);
	return (
		input.disposition === "missing_owner_dead_letter" && validResultStoreSha256Ref(input.ownerAbsenceAuthoritySha256)
	);
}

async function validDetachedSettlement(input: unknown): Promise<boolean> {
	if (
		!strictRecord(input, [
			"identity",
			"settledResultOperationId",
			"sinkResultUtf8",
			"deliveryAuthority",
			"deliveryAuthoritySha256",
			"settlementRequestSha256",
			"terminalStatus",
			"jobErrorTextUtf8",
			"settlementPolicy",
			"parentDeliveryRequest",
		]) ||
		!validDetachedIdentity(input.identity) ||
		!validResultStoreIdentity(input.settledResultOperationId) ||
		typeof input.sinkResultUtf8 !== "string" ||
		!validResultStoreSha256Ref(input.deliveryAuthoritySha256) ||
		!validResultStoreSha256Hex(input.settlementRequestSha256) ||
		!payloadPlainData(input.deliveryAuthority) ||
		!payloadPlainData(input.parentDeliveryRequest)
	)
		return false;
	const request = input as unknown as ConfidentialTransientTaskDetachedSettlementRequestV1;
	const key = resultTargetKeyFromRecord(request.identity as unknown as Record<string, unknown>);
	if (!key || !(await validParentDeliveryRequest(request.parentDeliveryRequest, key))) return false;
	const route = request.parentDeliveryRequest.route;
	if (
		route.kind !== "owner_routed_async_result" ||
		request.identity.deliveryOperationId !== request.parentDeliveryRequest.deliveryOperationId ||
		request.identity.ownerId !== route.ownerAgentId ||
		request.identity.jobId !== route.jobId ||
		request.identity.deliveryEpoch !== route.deliveryEpoch ||
		request.identity.deliveryRequestSha256 !== request.parentDeliveryRequest.deliveryRequestSha256 ||
		request.identity.sinkResultUtf8Sha256 !== request.parentDeliveryRequest.sinkResultUtf8Sha256 ||
		request.identity.sinkResultUtf8ByteLength !== request.parentDeliveryRequest.sinkResultUtf8ByteLength ||
		request.settledResultOperationId !== request.identity.deliveryOperationId ||
		request.deliveryAuthoritySha256 !== request.parentDeliveryRequest.deliveryAuthoritySha256 ||
		!exactJson(request.deliveryAuthority, request.parentDeliveryRequest.deliveryAuthority) ||
		Buffer.byteLength(request.sinkResultUtf8, "utf8") !== request.identity.sinkResultUtf8ByteLength ||
		foregroundUtf8Sha256(request.sinkResultUtf8) !== request.identity.sinkResultUtf8Sha256
	)
		return false;
	return request.terminalStatus === "cancelled"
		? request.identity.terminalStatus === "cancelled" &&
				request.sinkResultUtf8 === "Aborted before execution" &&
				request.jobErrorTextUtf8 === "Aborted before execution" &&
				request.settlementPolicy === "consumed_without_enqueue_only"
		: request.identity.terminalStatus === request.terminalStatus &&
				request.jobErrorTextUtf8 === null &&
				request.settlementPolicy === "current_epoch_enqueue_eligible";
}

async function validDetachedOperation(input: unknown): Promise<boolean> {
	if (
		!strictRecord(input, ["stage", "operationId", "requestSha256", "request"]) ||
		!validResultStoreIdentity(input.operationId) ||
		!validResultStoreSha256Hex(input.requestSha256) ||
		!payloadPlainData(input.request)
	)
		return false;
	const operation = input as unknown as PrivateDetachedOperationV1;
	const settlement = detachedSettlementFromOperation(operation);
	if (!(await validDetachedSettlement(settlement))) return false;
	if (operation.stage === "settled_result_publication")
		return (
			operation.operationId === settlement.settledResultOperationId &&
			operation.requestSha256 === settlement.settlementRequestSha256 &&
			exactJson(operation.request, settlement)
		);
	if (operation.stage === "reservation")
		return (
			operation.operationId === operation.request.reservationId &&
			operation.requestSha256 === operation.request.reservationRequestSha256
		);
	if (operation.stage === "sink_enqueue") return operation.requestSha256 === operation.request.sinkRequestSha256;
	if (operation.stage === "terminal_commit")
		return (
			operation.operationId === operation.request.commitOperationId &&
			operation.requestSha256 === operation.request.commitRequestSha256
		);
	return (
		operation.operationId === operation.request.releaseOperationId &&
		operation.requestSha256 === operation.request.releaseRequestSha256
	);
}

async function validDetachedAttempt(input: unknown): Promise<boolean> {
	if (
		!strictRecord(input, [
			"schemaVersion",
			"operation",
			"operationId",
			"requestSha256",
			"preparedAt",
			"attemptSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validResultStoreIso8601(input.preparedAt) ||
		!validResultStoreSha256Ref(input.attemptSha256)
	)
		return false;
	if (!(await validDetachedOperation(input.operation))) return false;
	const attempt = input as unknown as ConfidentialTransientTaskDetachedSettlementAttemptV1;
	if (
		attempt.operationId !== attempt.operation.operationId ||
		attempt.requestSha256 !== attempt.operation.requestSha256
	)
		return false;
	const operation = attempt.operation;
	try {
		if (operation.stage === "reservation") {
			const reservation = operation.request;
			if (reservation.disposition === "hub_jobs_consumption" || reservation.disposition === "hub_cancel_consumption")
				return exactJson(
					attempt,
					deriveTransientTaskHubDetachedReservationAttemptV1({
						settlement: reservation.settlement,
						currentAuthority: reservation.currentAuthority,
						disposition: reservation.disposition,
						preparedAt: attempt.preparedAt,
					}).attempt,
				);
			if (reservation.disposition === "hub_wait_consumption")
				return exactJson(
					attempt,
					deriveTransientTaskHubDetachedReservationAttemptV1({
						settlement: reservation.settlement,
						currentAuthority: reservation.currentAuthority,
						disposition: reservation.disposition,
						hubWaitInvocationId: reservation.hubWaitInvocationId,
						preparedAt: attempt.preparedAt,
					}).attempt,
				);
		} else if (operation.stage === "terminal_commit") {
			const commit = operation.request;
			if (
				commit.disposition === "hub_jobs_consumption" ||
				commit.disposition === "hub_wait_consumption" ||
				commit.disposition === "hub_cancel_consumption"
			) {
				if (
					commit.reservation.disposition !== "hub_jobs_consumption" &&
					commit.reservation.disposition !== "hub_wait_consumption" &&
					commit.reservation.disposition !== "hub_cancel_consumption"
				)
					return false;
				return exactJson(
					attempt,
					deriveTransientTaskHubDetachedCommitAttemptV1({
						settlement: commit.settlement,
						currentAuthority: commit.currentAuthority,
						reservation: commit.reservation,
						preparedAt: attempt.preparedAt,
					}).attempt,
				);
			}
		} else if (operation.stage === "reservation_release") {
			const release = operation.request;
			if (release.reservation.disposition !== "hub_wait_consumption") return true;
			if (release.currentAuthority.kind !== "current_owner_epoch" || release.reason === "sink_proven_not_applied")
				return false;
			return exactJson(
				attempt,
				deriveTransientTaskHubDetachedReleaseAttemptV1({
					settlement: release.settlement,
					currentAuthority: release.currentAuthority,
					reservation: release.reservation,
					reason: release.reason,
					preparedAt: attempt.preparedAt,
				}).attempt,
			);
		}
	} catch {
		return false;
	}
	return true;
}

function validDetachedEffectRequest(input: unknown): input is PrivateDetachedEffectRequestV1 {
	return Boolean(
		strictRecord(input, ["operation", "expectedAttemptSha256", "expectedNotAppliedReceiptSha256"]) &&
			validResultStoreSha256Ref(input.expectedAttemptSha256) &&
			validResultStoreSha256Ref(input.expectedNotAppliedReceiptSha256),
	);
}

function detachedCurrentAuthorityMatches(
	authority: ConfidentialTransientTaskDetachedSettlementCurrentAuthorityV1,
	settlement: ConfidentialTransientTaskDetachedSettlementRequestV1,
	settledResultReceiptSha256: Sha256Ref,
): boolean {
	if (!payloadPlainData(authority)) return false;
	if (
		!exactJson(authority.identity, settlement.identity) ||
		!exactJson(authority.deliveryAuthority, settlement.deliveryAuthority) ||
		authority.deliveryAuthoritySha256 !== settlement.deliveryAuthoritySha256 ||
		authority.settledResultReceiptSha256 !== settledResultReceiptSha256 ||
		!validResultStoreSha256Ref(authority.currentAuthoritySha256)
	)
		return false;
	if (authority.kind === "current_owner_epoch")
		return (
			authority.ownerId === settlement.identity.ownerId &&
			authority.deliveryEpoch === settlement.identity.deliveryEpoch &&
			validResultStoreSha256Ref(authority.ownerSinkAuthoritySha256)
		);
	if (authority.kind === "epoch_invalidated")
		return (
			authority.ownerId === settlement.identity.ownerId &&
			authority.deliveryEpoch === settlement.identity.deliveryEpoch &&
			validResultStoreInteger(authority.observedDeliveryEpoch) &&
			authority.observedDeliveryEpoch !== authority.deliveryEpoch &&
			validResultStoreSha256Ref(authority.invalidationAuthoritySha256)
		);
	return (
		authority.ownerId === settlement.identity.ownerId &&
		authority.deliveryEpoch === settlement.identity.deliveryEpoch &&
		validResultStoreSha256Ref(authority.ownerAbsenceAuthoritySha256)
	);
}

function validDetachedRecoveryOwnerIndex(input: unknown): boolean {
	return Boolean(
		strictRecord(input, [
			"schemaVersion",
			"ownerId",
			"ownerSessionId",
			"ownerSessionGenerationSha256",
			"deliveryEpoch",
			"indexSha256",
		]) &&
			input.schemaVersion === 1 &&
			validResultStoreIdentity(input.ownerId) &&
			validResultStoreIdentity(input.ownerSessionId) &&
			validResultStoreSha256Ref(input.ownerSessionGenerationSha256) &&
			validResultStoreInteger(input.deliveryEpoch) &&
			validResultStoreSha256Ref(input.indexSha256),
	);
}

async function validDetachedRecoveryRecord(input: unknown): Promise<boolean> {
	if (
		!payloadPlainData(input) ||
		!strictRecord(input, [
			"schemaVersion",
			"jobType",
			"coordinates",
			"settlementIdentitySha256",
			"settlementRequestSha256",
			"attemptSha256",
			"terminalStatus",
			"text",
			"jobErrorTextUtf8",
			"parentDeliveryRequest",
			"attempt",
			"inspectRequest",
			"recoveryState",
			"status",
			"resultText",
			"errorText",
			"transientTaskCompletion",
			"transientTaskSettlementBlock",
			"notAppliedReceiptSha256",
			"blockSha256",
			"handoffSha256",
			"recoveryRecordSha256",
		]) ||
		input.schemaVersion !== 1 ||
		input.jobType !== "task" ||
		!strictRecord(input.coordinates, [
			"schemaVersion",
			"ownerSessionIndex",
			"jobId",
			"agentId",
			"label",
			"startedAtEpochMs",
			"coordinatesSha256",
		]) ||
		input.coordinates.schemaVersion !== 1 ||
		!validDetachedRecoveryOwnerIndex(input.coordinates.ownerSessionIndex) ||
		!validResultStoreIdentity(input.coordinates.jobId) ||
		!validResultStoreIdentity(input.coordinates.agentId) ||
		typeof input.coordinates.label !== "string" ||
		!validResultStoreInteger(input.coordinates.startedAtEpochMs) ||
		!validResultStoreSha256Ref(input.coordinates.coordinatesSha256) ||
		!validResultStoreSha256Ref(input.settlementIdentitySha256) ||
		!validResultStoreSha256Hex(input.settlementRequestSha256) ||
		!validResultStoreSha256Ref(input.attemptSha256) ||
		!(await validDetachedAttempt(input.attempt)) ||
		!validResultStoreSha256Ref(input.recoveryRecordSha256)
	)
		return false;
	const record = input as unknown as ConfidentialAsyncJobTransientTaskRecoveryRecordV1;
	if (record.attempt.operation.stage !== "settled_result_publication") return false;
	const settlement = record.attempt.operation.request;
	return (
		record.coordinates.jobId === settlement.identity.jobId &&
		record.coordinates.ownerSessionIndex.ownerId === settlement.identity.ownerId &&
		record.coordinates.ownerSessionIndex.deliveryEpoch === settlement.identity.deliveryEpoch &&
		record.settlementIdentitySha256 === settlement.identity.identitySha256 &&
		record.settlementRequestSha256 === settlement.settlementRequestSha256 &&
		record.attemptSha256 === record.attempt.attemptSha256 &&
		record.terminalStatus === settlement.terminalStatus &&
		exactJson(record.parentDeliveryRequest, settlement.parentDeliveryRequest) &&
		record.inspectRequest.identitySha256 === settlement.identity.identitySha256 &&
		record.inspectRequest.stage === "settled_result_publication" &&
		record.inspectRequest.operationId === settlement.settledResultOperationId &&
		record.inspectRequest.expectedRequestSha256 === settlement.settlementRequestSha256 &&
		record.inspectRequest.expectedAttemptSha256 === record.attemptSha256
	);
}

async function decodeDetachedRecoveryIndex(
	input: unknown,
	ownerSessionIndexSha256: Sha256Ref,
): Promise<PrivateDetachedRecoveryIndexV1 | null> {
	if (
		!strictRecord(input, ["schemaVersion", "ownerSessionIndexSha256", "entries"]) ||
		input.schemaVersion !== 1 ||
		input.ownerSessionIndexSha256 !== ownerSessionIndexSha256 ||
		!strictArray(input.entries)
	)
		return null;
	const seen = new Set<string>();
	const entries: PrivateDetachedRecoveryIndexEntryV1[] = [];
	for (const entry of input.entries) {
		if (
			!strictRecord(entry, ["taskId", "runId", "jobId", "recoveryRecordSha256", "row"]) ||
			!validResultStoreIdentity(entry.taskId) ||
			!validResultStoreIdentity(entry.runId) ||
			!validResultStoreIdentity(entry.jobId) ||
			!validResultStoreSha256Ref(entry.recoveryRecordSha256) ||
			seen.has(entry.jobId) ||
			!strictRecord(entry.row, ["kind", "record", "receipt"]) ||
			entry.row.kind !== "detached_recovery" ||
			!(await validDetachedRecoveryRecord(entry.row.record)) ||
			!strictRecord(entry.row.receipt, [
				"schemaVersion",
				"ownerSessionIndexSha256",
				"coordinatesSha256",
				"requestSha256",
				"previousRecoveryRecordSha256",
				"recoveryRecordSha256",
				"recoveryState",
				"storedAt",
				"receiptSha256",
			])
		)
			return null;
		const record = entry.row.record as unknown as ConfidentialAsyncJobTransientTaskRecoveryRecordV1;
		const receipt = entry.row.receipt;
		if (
			record.coordinates.ownerSessionIndex.indexSha256 !== ownerSessionIndexSha256 ||
			record.coordinates.jobId !== entry.jobId ||
			record.attempt.operation.request.identity.taskId !== entry.taskId ||
			record.attempt.operation.request.identity.runId !== entry.runId ||
			record.recoveryRecordSha256 !== entry.recoveryRecordSha256 ||
			receipt.schemaVersion !== 1 ||
			receipt.ownerSessionIndexSha256 !== ownerSessionIndexSha256 ||
			receipt.coordinatesSha256 !== record.coordinates.coordinatesSha256 ||
			!validResultStoreSha256Ref(receipt.requestSha256) ||
			(receipt.previousRecoveryRecordSha256 !== null &&
				!validResultStoreSha256Ref(receipt.previousRecoveryRecordSha256)) ||
			receipt.recoveryRecordSha256 !== record.recoveryRecordSha256 ||
			receipt.recoveryState !== record.recoveryState ||
			!validResultStoreIso8601(receipt.storedAt) ||
			!validResultStoreSha256Ref(receipt.receiptSha256)
		)
			return null;
		const { receiptSha256: _receiptSha256, ...receiptCore } = receipt;
		if (receipt.receiptSha256 !== detachedDigest("async-recovery-write-receipt", receiptCore)) return null;
		const row: PrivateDetachedRecoveryRowV1 = {
			kind: "detached_recovery",
			record,
			receipt: receipt as unknown as ConfidentialAsyncJobTransientTaskRecoveryWriteReceiptV1,
		};
		entries.push({
			taskId: entry.taskId,
			runId: entry.runId,
			jobId: entry.jobId,
			recoveryRecordSha256: entry.recoveryRecordSha256,
			row,
		});
		seen.add(entry.jobId);
	}
	return { schemaVersion: 1, ownerSessionIndexSha256, entries };
}

function detachedRecoveryIndexEntry(
	record: ConfidentialAsyncJobTransientTaskRecoveryRecordV1,
): ConfidentialAsyncJobTransientTaskRecoveryIndexEntryV1 {
	return {
		jobId: record.coordinates.jobId,
		startedAtEpochMs: record.coordinates.startedAtEpochMs,
		recoveryState: record.recoveryState,
		coordinatesSha256: record.coordinates.coordinatesSha256,
		settlementIdentitySha256: record.settlementIdentitySha256,
		settlementRequestSha256: record.settlementRequestSha256,
		attemptSha256: record.attemptSha256,
		notAppliedReceiptSha256: record.notAppliedReceiptSha256,
		blockSha256: record.blockSha256,
		handoffSha256: record.handoffSha256,
		recoveryRecordSha256: record.recoveryRecordSha256,
	};
}

function detachedSettlementTerminalSha256(
	parentDeliveries: Readonly<Record<string, unknown>>,
	identitySha256: Sha256Ref,
): Sha256Ref | null {
	const stored = parentDeliveries[detachedStoreMapKey(identitySha256)];
	if (stored === undefined) return null;
	const row = loadDetachedRow<PrivateDetachedSettlementRowV1>(stored);
	if (row.kind !== "detached_settlement" || row.identitySha256 !== identitySha256)
		throw new TypeError("Detached settlement row conflict");
	return row.terminalReceipt?.receiptSha256 ?? null;
}

function detachedOperationReceiptSha256(
	receipt: ConfidentialTransientTaskDetachedSettlementOperationReceiptV1,
): Sha256Ref {
	return "sinkReceiptSha256" in receipt ? receipt.sinkReceiptSha256 : receipt.receiptSha256;
}

function parentDeliverySinkProjectionMatches(request: ConfidentialTransientTaskParentResultDeliveryRequestV1): boolean {
	let projection: {
		readonly sinkResultUtf8Sha256: Sha256Ref;
		readonly sinkResultUtf8ByteLength: number;
	};
	let sink: string;
	if (request.route.kind === "foreground_tool_call") {
		if (!("core" in request.sinkProjection)) return false;
		projection = request.sinkProjection.core;
		sink = request.sinkProjection.core.sinkResultUtf8;
	} else {
		if ("core" in request.sinkProjection) return false;
		const detachedProjection = request.sinkProjection;
		projection = detachedProjection;
		sink =
			detachedProjection.kind === "detached_async_result_entry"
				? detachedProjection.asyncResultEntryResult
				: detachedProjection.jobErrorTextUtf8;
	}
	return (
		projection.sinkResultUtf8Sha256 === request.sinkResultUtf8Sha256 &&
		projection.sinkResultUtf8ByteLength === request.sinkResultUtf8ByteLength &&
		Buffer.byteLength(sink, "utf8") === request.sinkResultUtf8ByteLength &&
		foregroundUtf8Sha256(sink) === request.sinkResultUtf8Sha256
	);
}

function parentDeliveryConflict(
	current: ConfidentialTransientTaskParentResultDeliveryRequestV1,
	next: ConfidentialTransientTaskParentResultDeliveryRequestV1,
) {
	if (current.deliveryOperationId !== next.deliveryOperationId)
		return { status: "operation_identity_conflict" } as const;
	if (!exactJson(current.route, next.route)) return { status: "route_conflict" } as const;
	if (
		!exactJson(current.sinkProjection, next.sinkProjection) ||
		"sourceProjection" in current !== "sourceProjection" in next ||
		("sourceProjection" in current &&
			"sourceProjection" in next &&
			!exactJson(current.sourceProjection, next.sourceProjection))
	)
		return { status: "projection_conflict" } as const;
	if (
		current.deliveryPayloadRole !== next.deliveryPayloadRole ||
		current.deliveryPayloadId !== next.deliveryPayloadId ||
		current.deliveryPayloadDeleteId !== next.deliveryPayloadDeleteId ||
		current.deliveryPayloadPutReceiptSha256 !== next.deliveryPayloadPutReceiptSha256 ||
		current.deliveryPayloadSha256 !== next.deliveryPayloadSha256 ||
		current.deliveryPayloadByteLength !== next.deliveryPayloadByteLength ||
		current.deliveryPayloadEnvelopeSha256 !== next.deliveryPayloadEnvelopeSha256 ||
		current.deliveryPayloadTupleSha256 !== next.deliveryPayloadTupleSha256 ||
		!exactJson(current.deliveryPayload, next.deliveryPayload)
	)
		return { status: "payload_conflict" } as const;
	return { status: "same_id_different_delivery" } as const;
}

function parentDeliveryInspectRequest(
	input: unknown,
): input is Parameters<TransientTaskParentResultDeliveryStoreV1["inspect"]>[0] {
	return Boolean(
		proxyFreeData(input) &&
			strictRecord(input, [
				"schemaVersion",
				"taskId",
				"runId",
				"createId",
				"resultPublicationId",
				"resultPublicationTargetId",
				"resultPublicationTargetCleanupId",
				"deliveryOperationId",
				"targetBindingRevision",
				"targetRenewalSequence",
				"targetLiveReceiptSha256",
				"deliveryAuthoritySha256",
				"expectedAttemptSha256",
				"sinkResultUtf8Sha256",
				"sinkResultUtf8ByteLength",
				"pendingOutcomeSha256",
				"singleResultCompositionReceiptSha256",
				"deliveryPayloadRole",
				"deliveryPayloadId",
				"deliveryPayloadDeleteId",
				"deliveryPayloadPutReceiptSha256",
				"deliveryPayloadSha256",
				"deliveryPayloadByteLength",
				"deliveryPayloadEnvelopeSha256",
				"deliveryPayloadTupleSha256",
				"deliveryRequestSha256",
			]) &&
			resultTargetKeyFromRecord(input) !== null &&
			validResultStoreIdentity(input.deliveryOperationId) &&
			validResultStoreInteger(input.targetBindingRevision, 1) &&
			validResultStoreInteger(input.targetRenewalSequence) &&
			validResultStoreSha256Ref(input.targetLiveReceiptSha256) &&
			validResultStoreSha256Ref(input.deliveryAuthoritySha256) &&
			validResultStoreSha256Ref(input.expectedAttemptSha256) &&
			validResultStoreSha256Ref(input.sinkResultUtf8Sha256) &&
			validResultStoreInteger(input.sinkResultUtf8ByteLength) &&
			validResultStoreSha256Ref(input.pendingOutcomeSha256) &&
			(input.singleResultCompositionReceiptSha256 === null ||
				validResultStoreSha256Ref(input.singleResultCompositionReceiptSha256)) &&
			(input.deliveryPayloadRole === "pending" || input.deliveryPayloadRole === "composed") &&
			validResultStoreIdentity(input.deliveryPayloadId) &&
			validResultStoreIdentity(input.deliveryPayloadDeleteId) &&
			(input.deliveryPayloadPutReceiptSha256 === null ||
				validResultStoreSha256Ref(input.deliveryPayloadPutReceiptSha256)) &&
			validResultStoreSha256Ref(input.deliveryPayloadSha256) &&
			validResultStoreInteger(input.deliveryPayloadByteLength) &&
			validResultStoreSha256Ref(input.deliveryPayloadEnvelopeSha256) &&
			validResultStoreSha256Ref(input.deliveryPayloadTupleSha256) &&
			validResultStoreSha256Hex(input.deliveryRequestSha256),
	);
}

async function validParentDeliveryAdoptAuthority(
	input: unknown,
	key: TransientTaskResultPublicationTargetKeyV1,
	inspect: Parameters<TransientTaskParentResultDeliveryStoreV1["inspect"]>[0],
): Promise<boolean> {
	if (
		!payloadPlainData(input) ||
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"targetBindingRevision",
			"targetRenewalSequence",
			"targetLiveReceiptSha256",
			"effectIdentityManifest",
			"targetAuthority",
			"targetAuthoritySha256",
		]) ||
		input.schemaVersion !== 1
	)
		return false;
	const authorityKey = resultTargetKeyFromRecord(input);
	return Boolean(
		authorityKey &&
			resultTargetKeyMatches(authorityKey, key) &&
			input.targetBindingRevision === inspect.targetBindingRevision &&
			input.targetRenewalSequence === inspect.targetRenewalSequence &&
			input.targetLiveReceiptSha256 === inspect.targetLiveReceiptSha256 &&
			validResultTargetManifest(input.effectIdentityManifest, key) &&
			validResultTargetAuthority(input.targetAuthority) &&
			validResultStoreSha256Ref(input.targetAuthoritySha256) &&
			input.targetAuthoritySha256 === (await tupleRef(resultTargetAuthorityTuple(input.targetAuthority))),
	);
}

function parentDeliveryRequestMatchesInspect(
	request: ConfidentialTransientTaskParentResultDeliveryRequestV1,
	inspect: Parameters<TransientTaskParentResultDeliveryStoreV1["inspect"]>[0],
): boolean {
	return (
		resultTargetKeyMatches(request, inspect) &&
		request.deliveryOperationId === inspect.deliveryOperationId &&
		request.targetBindingRevision === inspect.targetBindingRevision &&
		request.targetRenewalSequence === inspect.targetRenewalSequence &&
		request.targetLiveReceiptSha256 === inspect.targetLiveReceiptSha256 &&
		request.deliveryAuthoritySha256 === inspect.deliveryAuthoritySha256 &&
		request.sinkResultUtf8Sha256 === inspect.sinkResultUtf8Sha256 &&
		request.sinkResultUtf8ByteLength === inspect.sinkResultUtf8ByteLength &&
		request.pendingOutcomeSha256 === inspect.pendingOutcomeSha256 &&
		request.singleResultCompositionReceiptSha256 === inspect.singleResultCompositionReceiptSha256 &&
		request.deliveryPayloadRole === inspect.deliveryPayloadRole &&
		request.deliveryPayloadId === inspect.deliveryPayloadId &&
		request.deliveryPayloadDeleteId === inspect.deliveryPayloadDeleteId &&
		request.deliveryPayloadPutReceiptSha256 === inspect.deliveryPayloadPutReceiptSha256 &&
		request.deliveryPayloadSha256 === inspect.deliveryPayloadSha256 &&
		request.deliveryPayloadByteLength === inspect.deliveryPayloadByteLength &&
		request.deliveryPayloadEnvelopeSha256 === inspect.deliveryPayloadEnvelopeSha256 &&
		request.deliveryPayloadTupleSha256 === inspect.deliveryPayloadTupleSha256 &&
		request.deliveryRequestSha256 === inspect.deliveryRequestSha256
	);
}

function validParentNonDeliveryReceipt(
	input: unknown,
): input is ConfidentialTransientTaskParentResultNonDeliveryReceiptV1 {
	if (
		!proxyFreeData(input) ||
		!strictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"deliveryOperationId",
			"targetBindingRevision",
			"targetRenewalSequence",
			"targetLiveReceiptSha256",
			"deliveryAuthoritySha256",
			"deliveryAttemptSha256",
			"sinkResultUtf8Sha256",
			"sinkResultUtf8ByteLength",
			"pendingOutcomeSha256",
			"singleResultCompositionReceiptSha256",
			"deliveryPayloadRole",
			"deliveryPayloadId",
			"deliveryPayloadDeleteId",
			"deliveryPayloadPutReceiptSha256",
			"deliveryPayloadSha256",
			"deliveryPayloadByteLength",
			"deliveryPayloadEnvelopeSha256",
			"deliveryPayloadTupleSha256",
			"deliveryRequestSha256",
			"completedAt",
			"receiptSha256",
			"outcome",
			"routeKind",
			"detachedSettlement",
		])
	)
		return false;
	return (
		resultTargetKeyFromRecord(input) !== null &&
		(input.outcome === "delivery_epoch_invalidated" || input.outcome === "dead_lettered") &&
		input.routeKind === "owner_routed_async_result" &&
		validResultStoreIdentity(input.deliveryOperationId) &&
		validResultStoreInteger(input.targetBindingRevision, 1) &&
		validResultStoreInteger(input.targetRenewalSequence) &&
		validResultStoreSha256Ref(input.targetLiveReceiptSha256) &&
		validResultStoreSha256Ref(input.deliveryAuthoritySha256) &&
		validResultStoreSha256Ref(input.deliveryAttemptSha256) &&
		validResultStoreSha256Ref(input.sinkResultUtf8Sha256) &&
		validResultStoreInteger(input.sinkResultUtf8ByteLength) &&
		validResultStoreSha256Ref(input.pendingOutcomeSha256) &&
		(input.singleResultCompositionReceiptSha256 === null ||
			validResultStoreSha256Ref(input.singleResultCompositionReceiptSha256)) &&
		(input.deliveryPayloadRole === "pending" || input.deliveryPayloadRole === "composed") &&
		validResultStoreIdentity(input.deliveryPayloadId) &&
		validResultStoreIdentity(input.deliveryPayloadDeleteId) &&
		(input.deliveryPayloadPutReceiptSha256 === null ||
			validResultStoreSha256Ref(input.deliveryPayloadPutReceiptSha256)) &&
		validResultStoreSha256Ref(input.deliveryPayloadSha256) &&
		validResultStoreInteger(input.deliveryPayloadByteLength) &&
		validResultStoreSha256Ref(input.deliveryPayloadEnvelopeSha256) &&
		validResultStoreSha256Ref(input.deliveryPayloadTupleSha256) &&
		validResultStoreSha256Hex(input.deliveryRequestSha256) &&
		validResultStoreIso8601(input.completedAt) &&
		validResultStoreSha256Ref(input.receiptSha256) &&
		payloadPlainData(input.detachedSettlement)
	);
}

async function parentDeliveryRow(input: unknown): Promise<PrivateParentDeliveryRowV1 | null> {
	if (input === undefined) return null;
	if (
		!proxyFreeData(input) ||
		!strictRecord(input, ["state", "attempt", "receipt"]) ||
		(input.state !== "not_applied" && input.state !== "outcome_unknown" && input.state !== "terminal") ||
		!strictRecord(input.attempt, ["schemaVersion", "request", "preparedAt", "attemptSha256"]) ||
		input.attempt.schemaVersion !== 1 ||
		!validResultStoreIso8601(input.attempt.preparedAt) ||
		!validResultStoreSha256Ref(input.attempt.attemptSha256)
	)
		throw new Error("Transient parent delivery row is invalid");
	const attempt = input.attempt as unknown as ConfidentialTransientTaskParentResultDeliveryAttemptV1;
	const key = resultTargetKeyFromRecord(attempt.request);
	if (
		!key ||
		!(await validParentDeliveryRequest(attempt.request, key)) ||
		!parentDeliverySinkProjectionMatches(attempt.request)
	)
		throw new Error("Transient parent delivery attempt is invalid");
	if (
		attempt.attemptSha256 !==
		(await tupleRef([
			"omp-transient-task-parent-result-delivery-v1",
			"attempt",
			1,
			attempt.request.deliveryRequestSha256,
			attempt.preparedAt,
		]))
	)
		throw new Error("Transient parent delivery attempt digest is invalid");
	if (input.state !== "terminal") {
		if (input.receipt !== null) throw new Error("Transient parent delivery nonterminal row is invalid");
		return { state: input.state, attempt, receipt: null };
	}
	if (!validParentDeliveryReceipt(input.receipt) && !validParentNonDeliveryReceipt(input.receipt))
		throw new Error("Transient parent delivery receipt is invalid");
	const receipt = input.receipt;
	if (receipt.receiptSha256 !== (await tupleRef(parentDeliveryReceiptTuple(receipt)))) {
		throw new Error("Transient parent delivery receipt digest is invalid");
	}
	if (
		receipt.routeKind !== attempt.request.route.kind ||
		(receipt.routeKind === "owner_routed_async_result" &&
			(!detachedParentDeliveryRequest(attempt.request) ||
				!validDetachedTerminalReceiptForParent(receipt.detachedSettlement, attempt.request))) ||
		!resultTargetKeyMatches(receipt, attempt.request) ||
		receipt.deliveryOperationId !== attempt.request.deliveryOperationId ||
		receipt.deliveryAuthoritySha256 !== attempt.request.deliveryAuthoritySha256 ||
		receipt.deliveryAttemptSha256 !== attempt.attemptSha256 ||
		receipt.deliveryRequestSha256 !== attempt.request.deliveryRequestSha256 ||
		receipt.deliveryPayloadTupleSha256 !== attempt.request.deliveryPayloadTupleSha256
	)
		throw new Error("Transient parent delivery receipt join is invalid");
	return { state: "terminal", attempt, receipt };
}

const TRANSIENT_SOURCE_OBSERVATION_NAMESPACE = "transient-task-source-observation-v1";

interface DurableTransientTaskSourceObservationActiveDraftV1 {
	readonly draft: ConfidentialTransientTaskSourceObservationDraftRowV1;
	readonly receipt: ConfidentialTransientTaskSourceObservationDraftReceiptV1;
}

interface DurableTransientTaskSourceObservationEnumerationV1 {
	readonly recordSha256: Sha256Ref | null;
	readonly executionUnknown: boolean;
}

interface DurableTransientTaskSourceObservationStateV1 {
	readonly schemaVersion: 1;
	readonly indexKey: ConfidentialTransientTaskPendingCaptureIndexKeyV1;
	readonly head: ConfidentialTransientTaskSourceObservationHeadV1;
	readonly activeDraft: DurableTransientTaskSourceObservationActiveDraftV1 | null;
	readonly acceptedRows: Readonly<Record<string, ConfidentialTransientTaskSourceObservationAcceptedRowV1>>;
	readonly draftAdoptions: Readonly<Record<string, Sha256Ref>>;
	readonly observationAdoptions: Readonly<Record<string, Sha256Ref>>;
	readonly pendingRecords: readonly ConfidentialTransientTaskPendingCaptureRecordV1[];
	readonly startedReceipt: ConfidentialTransientTaskPendingCaptureStartedReceiptV1 | null;
	readonly executeEntryReceipt: ConfidentialTransientTaskSourceObservationReceiptV1 | null;
	readonly pendingEnumerations: Readonly<Record<string, DurableTransientTaskSourceObservationEnumerationV1>>;
	readonly pendingAdoptions: Readonly<Record<string, Sha256Ref>>;
}

interface DurableTransientTaskSourceObservationStoredEnvelopeV1 {
	readonly schemaVersion: 1;
	readonly kind: "transient_task_source_observation";
	readonly tagged: PrivateForegroundTaggedValueV1;
	readonly stateSha256: Sha256Ref;
}

function sourceObservationDigest(
	domain: Parameters<typeof canonicalTransientTaskSourceObservationDigestV1>[0],
	input: unknown,
): Sha256Ref {
	return canonicalTransientTaskSourceObservationDigestV1(domain, input);
}

function sourceObservationUndigestedBody(input: object, digestKey: string): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) if (key !== digestKey) body[key] = value;
	return body;
}

function sourceObservationPlainRecord(input: unknown): input is Record<string, unknown> {
	if (!proxyFreeData(input) || input === null || typeof input !== "object" || Array.isArray(input)) return false;
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const descriptors = Object.getOwnPropertyDescriptors(input);
	return Reflect.ownKeys(input).every(key => {
		if (typeof key !== "string") return false;
		const descriptor = descriptors[key];
		return descriptor?.enumerable === true && "value" in descriptor;
	});
}

function projectSourceObservationResult(input: unknown): ConfidentialTransientTaskSourceObservationResultV1 | null {
	const projected = validateAndProjectTransientTaskForegroundSourceAgentToolResultV1(input);
	return projected.status === "projected" ? projected.projection : null;
}

function decodeSourceObservationResult(input: unknown): ConfidentialTransientTaskSourceObservationResultV1 {
	if (
		!strictRecord(input, ["core", "resultProjectionSha256"]) ||
		!strictRecord(input.core, [
			"sourceResult",
			"sourceResultSnapshot",
			"wireResult",
			"resultUtf8",
			"resultUtf8Sha256",
			"resultUtf8ByteLength",
		]) ||
		!isSha256Ref(input.resultProjectionSha256)
	)
		throw new TypeError("Invalid source observation result projection");
	const projected = projectSourceObservationResult(input.core.sourceResult);
	if (projected === null || !exactJson(projected, input))
		throw new TypeError("Invalid source observation result projection join");
	return projected;
}

function validSourceObservationProducer(input: unknown): input is ConfidentialTransientTaskSourceObservationProducerV1 {
	return input === "task_tool" || input === "eval_tool" || input === "agent_loop";
}

function validSourceObservationEventKind(
	input: unknown,
): input is ConfidentialTransientTaskSourceObservationRecordV1["core"]["eventKind"] {
	return isOneOf(input, [
		"task_execute_entry",
		"task_execute_result_classification",
		"eval_execute_entry",
		"eval_execute_result_classification",
		"soft_requirement_detour",
		"steering_skip",
		"signal_pre_execution_skip",
		"assistant_stream_terminal",
		"tool_missing",
		"validation_result",
		"before_tool_block",
		"before_tool_prepare_error",
		"after_hook_result",
	]);
}

function sourceObservationProducerOwnsEvent(
	producer: ConfidentialTransientTaskSourceObservationReservationRequestV1["core"]["producer"],
	eventKind: ConfidentialTransientTaskSourceObservationRecordV1["core"]["eventKind"],
): boolean {
	if (producer === "task_tool") {
		return eventKind === "task_execute_entry" || eventKind === "task_execute_result_classification";
	}
	if (producer === "eval_tool") {
		return eventKind === "eval_execute_entry" || eventKind === "eval_execute_result_classification";
	}
	return !isOneOf(eventKind, [
		"task_execute_entry",
		"task_execute_result_classification",
		"eval_execute_entry",
		"eval_execute_result_classification",
	]);
}

function assertSourceObservationReservationRequest(
	input: unknown,
): asserts input is ConfidentialTransientTaskSourceObservationReservationRequestV1 {
	if (
		!strictRecord(input, ["core", "requestSha256"]) ||
		!strictRecord(input.core, [
			"indexKey",
			"producer",
			"eventKind",
			"observationInput",
			"observedAt",
			"reservationId",
			"expectedHead",
			"expectedPredecessorObservationReceipt",
			"requestedAt",
		]) ||
		!isSha256Ref(input.requestSha256) ||
		!validSourceObservationProducer(input.core.producer) ||
		!validSourceObservationEventKind(input.core.eventKind) ||
		!sourceObservationPlainRecord(input.core.observationInput) ||
		input.core.observationInput.eventKind !== input.core.eventKind ||
		!isIso8601(input.core.observedAt) ||
		!isWellFormedString(input.core.reservationId) ||
		!isIso8601(input.core.requestedAt) ||
		input.requestSha256 !== sourceObservationDigest("source_observation_reservation_request", input.core)
	)
		throw new TypeError("Invalid source observation reservation request");
	if (!sourceObservationProducerOwnsEvent(input.core.producer, input.core.eventKind)) {
		throw new TypeError("Invalid source observation producer event");
	}
	const indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(input.core.indexKey);
	const head = decodeTransientTaskSourceObservationHeadV1(input.core.expectedHead, indexKey.indexKeySha256);
	const predecessor =
		input.core.expectedPredecessorObservationReceipt === null
			? null
			: decodeSourceObservationReceipt(input.core.expectedPredecessorObservationReceipt, indexKey.indexKeySha256);
	if (
		(predecessor === null) !== (head.core.acceptedObservationCount === 0) ||
		(predecessor !== null &&
			(predecessor.core.acceptedHeadSha256 !== head.headSha256 ||
				predecessor.core.observationSequence + 1 !== head.core.nextObservationSequence))
	)
		throw new TypeError("Invalid source observation predecessor join");
}

function decodeSourceObservationReservationRequest(
	input: unknown,
): ConfidentialTransientTaskSourceObservationReservationRequestV1 {
	assertSourceObservationReservationRequest(input);
	return input;
}

function decodeSourceObservationReservationReceipt(
	input: unknown,
	expectedIndexKeySha256?: Sha256Ref,
	expectedRequest?: ConfidentialTransientTaskSourceObservationReservationRequestV1,
): ConfidentialTransientTaskSourceObservationReservationReceiptV1 {
	if (
		!strictRecord(input, ["core", "reservationReceiptSha256"]) ||
		!strictRecord(input.core, [
			"schemaVersion",
			"indexKeySha256",
			"producer",
			"eventKind",
			"reservationId",
			"lifecycleOrdinal",
			"observationSequence",
			"predecessorObservationReceiptSha256",
			"priorHeadSha256",
			"reservationRequestSha256",
			"reservedAt",
		]) ||
		input.core.schemaVersion !== 1 ||
		!isSha256Ref(input.core.indexKeySha256) ||
		(expectedIndexKeySha256 !== undefined && input.core.indexKeySha256 !== expectedIndexKeySha256) ||
		!validSourceObservationProducer(input.core.producer) ||
		!validSourceObservationEventKind(input.core.eventKind) ||
		!isWellFormedString(input.core.reservationId) ||
		!isSafeCount(input.core.lifecycleOrdinal) ||
		input.core.lifecycleOrdinal !== input.core.observationSequence ||
		!isSafeCount(input.core.observationSequence) ||
		(input.core.predecessorObservationReceiptSha256 !== null &&
			!isSha256Ref(input.core.predecessorObservationReceiptSha256)) ||
		!isSha256Ref(input.core.priorHeadSha256) ||
		!isSha256Ref(input.core.reservationRequestSha256) ||
		!isIso8601(input.core.reservedAt) ||
		!isSha256Ref(input.reservationReceiptSha256) ||
		input.reservationReceiptSha256 !== sourceObservationDigest("source_observation_reservation_receipt", input.core)
	)
		throw new TypeError("Invalid source observation reservation receipt");
	if (
		expectedRequest !== undefined &&
		(input.core.indexKeySha256 !== expectedRequest.core.indexKey.indexKeySha256 ||
			input.core.producer !== expectedRequest.core.producer ||
			input.core.eventKind !== expectedRequest.core.eventKind ||
			input.core.reservationId !== expectedRequest.core.reservationId ||
			input.core.lifecycleOrdinal !== expectedRequest.core.expectedHead.core.nextObservationSequence ||
			input.core.predecessorObservationReceiptSha256 !==
				(expectedRequest.core.expectedPredecessorObservationReceipt?.receiptSha256 ?? null) ||
			input.core.priorHeadSha256 !== expectedRequest.core.expectedHead.headSha256 ||
			input.core.reservationRequestSha256 !== expectedRequest.requestSha256 ||
			input.core.reservedAt !== expectedRequest.core.requestedAt)
	)
		throw new TypeError("Invalid source observation reservation receipt join");
	const commonCore = {
		schemaVersion: 1 as const,
		indexKeySha256: input.core.indexKeySha256,
		reservationId: input.core.reservationId,
		lifecycleOrdinal: input.core.lifecycleOrdinal,
		observationSequence: input.core.observationSequence,
		predecessorObservationReceiptSha256: input.core.predecessorObservationReceiptSha256,
		priorHeadSha256: input.core.priorHeadSha256,
		reservationRequestSha256: input.core.reservationRequestSha256,
		reservedAt: input.core.reservedAt,
	};
	if (!sourceObservationProducerOwnsEvent(input.core.producer, input.core.eventKind)) {
		throw new TypeError("Invalid source observation reservation producer event");
	}
	return {
		core: {
			...commonCore,
			producer: input.core.producer,
			eventKind: input.core.eventKind,
		},
		reservationReceiptSha256: input.reservationReceiptSha256,
	};
}

function decodeSourceObservationDraftReceipt(
	input: unknown,
	expectedIndexKeySha256?: Sha256Ref,
	expectedDraft?: ConfidentialTransientTaskSourceObservationDraftRowV1,
): ConfidentialTransientTaskSourceObservationDraftReceiptV1 {
	if (
		!strictRecord(input, ["core", "receiptSha256"]) ||
		!strictRecord(input.core, [
			"schemaVersion",
			"indexKeySha256",
			"reservationId",
			"reservationRequestSha256",
			"reservationReceiptSha256",
			"observationSha256",
			"prepareRequestSha256",
			"draftSha256",
			"recordedAt",
		]) ||
		input.core.schemaVersion !== 1 ||
		!isSha256Ref(input.core.indexKeySha256) ||
		(expectedIndexKeySha256 !== undefined && input.core.indexKeySha256 !== expectedIndexKeySha256) ||
		!isWellFormedString(input.core.reservationId) ||
		!isSha256Ref(input.core.reservationRequestSha256) ||
		!isSha256Ref(input.core.reservationReceiptSha256) ||
		!isSha256Ref(input.core.observationSha256) ||
		!isSha256Ref(input.core.prepareRequestSha256) ||
		!isSha256Ref(input.core.draftSha256) ||
		!isIso8601(input.core.recordedAt) ||
		!isSha256Ref(input.receiptSha256) ||
		input.receiptSha256 !== sourceObservationDigest("source_observation_draft_receipt", input.core)
	)
		throw new TypeError("Invalid source observation draft receipt");
	if (
		expectedDraft !== undefined &&
		(input.core.indexKeySha256 !== expectedDraft.core.reservationRequest.core.indexKey.indexKeySha256 ||
			input.core.reservationId !== expectedDraft.core.reservationReceipt.core.reservationId ||
			input.core.reservationRequestSha256 !== expectedDraft.core.reservationRequest.requestSha256 ||
			input.core.reservationReceiptSha256 !== expectedDraft.core.reservationReceipt.reservationReceiptSha256 ||
			input.core.observationSha256 !== expectedDraft.core.record.observationSha256 ||
			input.core.prepareRequestSha256 !== expectedDraft.core.prepareRequest.requestSha256 ||
			input.core.draftSha256 !== expectedDraft.draftSha256 ||
			input.core.recordedAt !== expectedDraft.core.draftedAt)
	)
		throw new TypeError("Invalid source observation draft receipt join");
	return {
		core: {
			schemaVersion: 1,
			indexKeySha256: input.core.indexKeySha256,
			reservationId: input.core.reservationId,
			reservationRequestSha256: input.core.reservationRequestSha256,
			reservationReceiptSha256: input.core.reservationReceiptSha256,
			observationSha256: input.core.observationSha256,
			prepareRequestSha256: input.core.prepareRequestSha256,
			draftSha256: input.core.draftSha256,
			recordedAt: input.core.recordedAt,
		},
		receiptSha256: input.receiptSha256,
	};
}

function decodePendingCaptureStartedReceipt(
	input: unknown,
	expectedIndexKeySha256?: Sha256Ref,
): ConfidentialTransientTaskPendingCaptureStartedReceiptV1 {
	if (
		!strictRecord(input, ["core", "receiptSha256"]) ||
		!strictRecord(input.core, [
			"schemaVersion",
			"indexKeySha256",
			"captureKeySha256",
			"firstVersionSha256",
			"startedRecordSha256",
			"initialSourceObservationHeadSha256",
			"recordedAt",
		]) ||
		input.core.schemaVersion !== 1 ||
		!isSha256Ref(input.core.indexKeySha256) ||
		(expectedIndexKeySha256 !== undefined && input.core.indexKeySha256 !== expectedIndexKeySha256) ||
		!isSha256Ref(input.core.captureKeySha256) ||
		!isSha256Ref(input.core.firstVersionSha256) ||
		!isSha256Ref(input.core.startedRecordSha256) ||
		!isSha256Ref(input.core.initialSourceObservationHeadSha256) ||
		!isIso8601(input.core.recordedAt) ||
		!isSha256Ref(input.receiptSha256) ||
		input.receiptSha256 !== sourceObservationDigest("pending_capture_started_receipt", input.core)
	)
		throw new TypeError("Invalid pending capture started receipt");
	return {
		core: {
			schemaVersion: 1,
			indexKeySha256: input.core.indexKeySha256,
			captureKeySha256: input.core.captureKeySha256,
			firstVersionSha256: input.core.firstVersionSha256,
			startedRecordSha256: input.core.startedRecordSha256,
			initialSourceObservationHeadSha256: input.core.initialSourceObservationHeadSha256,
			recordedAt: input.core.recordedAt,
		},
		receiptSha256: input.receiptSha256,
	};
}

function decodeSourceObservationReceipt(
	input: unknown,
	expectedIndexKeySha256?: Sha256Ref,
): ConfidentialTransientTaskSourceObservationReceiptV1 {
	if (
		!strictRecord(input, ["core", "receiptSha256"]) ||
		!strictRecord(input.core, [
			"schemaVersion",
			"indexKeySha256",
			"observationSha256",
			"eventKind",
			"lifecycleOrdinal",
			"observationSequence",
			"reservationReceiptSha256",
			"predecessorObservationReceiptSha256",
			"priorHeadSha256",
			"acceptedHeadSha256",
			"recordedAt",
		]) ||
		input.core.schemaVersion !== 1 ||
		!isSha256Ref(input.core.indexKeySha256) ||
		(expectedIndexKeySha256 !== undefined && input.core.indexKeySha256 !== expectedIndexKeySha256) ||
		!isSha256Ref(input.core.observationSha256) ||
		!validSourceObservationEventKind(input.core.eventKind) ||
		!isSafeCount(input.core.lifecycleOrdinal) ||
		input.core.lifecycleOrdinal !== input.core.observationSequence ||
		!isSafeCount(input.core.observationSequence) ||
		!isSha256Ref(input.core.reservationReceiptSha256) ||
		(input.core.predecessorObservationReceiptSha256 !== null &&
			!isSha256Ref(input.core.predecessorObservationReceiptSha256)) ||
		!isSha256Ref(input.core.priorHeadSha256) ||
		!isSha256Ref(input.core.acceptedHeadSha256) ||
		!isIso8601(input.core.recordedAt) ||
		!isSha256Ref(input.receiptSha256) ||
		input.receiptSha256 !== sourceObservationDigest("source_observation_receipt", input.core)
	)
		throw new TypeError("Invalid source observation receipt");
	return {
		core: {
			schemaVersion: 1,
			indexKeySha256: input.core.indexKeySha256,
			observationSha256: input.core.observationSha256,
			eventKind: input.core.eventKind,
			lifecycleOrdinal: input.core.lifecycleOrdinal,
			observationSequence: input.core.observationSequence,
			reservationReceiptSha256: input.core.reservationReceiptSha256,
			predecessorObservationReceiptSha256: input.core.predecessorObservationReceiptSha256,
			priorHeadSha256: input.core.priorHeadSha256,
			acceptedHeadSha256: input.core.acceptedHeadSha256,
			recordedAt: input.core.recordedAt,
		},
		receiptSha256: input.receiptSha256,
	};
}

function decodeSourceObservationRecordPayload(
	input: unknown,
	authority: ConfidentialAgentSessionTransientTaskLifecycleAuthorityV1,
	predecessor: ConfidentialTransientTaskSourceObservationReceiptV1 | null,
	indexKeySha256: Sha256Ref,
): asserts input is ConfidentialTransientTaskSourceObservationRecordV1["core"] {
	if (!sourceObservationPlainRecord(input)) throw new TypeError("Invalid source observation payload");
	const core = input;
	if (core.eventKind === "task_execute_entry") {
		if (
			!strictRecord(core, [
				"schemaVersion",
				"authority",
				"observedAt",
				"eventKind",
				"effectiveTaskArgumentsSha256",
				"effectiveArgumentRevisionChainSha256",
			]) ||
			!isSha256Ref(core.effectiveTaskArgumentsSha256) ||
			!isSha256Ref(core.effectiveArgumentRevisionChainSha256)
		)
			throw new TypeError("Invalid task execute-entry source observation");
		return;
	}
	if (core.eventKind === "eval_execute_entry") {
		if (
			!strictRecord(core, [
				"schemaVersion",
				"authority",
				"observedAt",
				"eventKind",
				"effectiveEvalArgumentsSha256",
				"effectiveArgumentRevisionChainSha256",
			]) ||
			!isSha256Ref(core.effectiveEvalArgumentsSha256) ||
			!isSha256Ref(core.effectiveArgumentRevisionChainSha256)
		)
			throw new TypeError("Invalid eval execute-entry source observation");
		return;
	}
	if (core.eventKind === "task_execute_result_classification") {
		const keys = [
			"schemaVersion",
			"authority",
			"observedAt",
			"eventKind",
			"executeEntryObservationReceipt",
			"result",
			"dispatchClassification",
			"resultDisposition",
			"noHandoffReason",
			"completedBlockingChildCount",
		];
		if (Object.hasOwn(core, "sourceProjectionRejection")) keys.push("sourceProjectionRejection");
		if (!strictRecord(core, keys) || !isSafeCount(core.completedBlockingChildCount))
			throw new TypeError("Invalid task execute-result source observation");
		const executeEntry = decodeSourceObservationReceipt(core.executeEntryObservationReceipt, indexKeySha256);
		decodeSourceObservationResult(core.result);
		if (
			executeEntry.core.eventKind !== "task_execute_entry" ||
			predecessor?.receiptSha256 !== executeEntry.receiptSha256
		)
			throw new TypeError("Invalid task execute-result predecessor");
		return;
	}
	if (core.eventKind === "eval_execute_result_classification") {
		const keys = [
			"schemaVersion",
			"authority",
			"observedAt",
			"eventKind",
			"executeEntryObservationReceipt",
			"result",
			"dispatchClassification",
			"resultDisposition",
			"noHandoffReason",
			"createdInlineChildCount",
			"terminalizedInlineChildCount",
			"resultfulInlineChildCount",
		];
		if (Object.hasOwn(core, "sourceProjectionRejection")) keys.push("sourceProjectionRejection");
		if (
			!strictRecord(core, keys) ||
			!isSafeCount(core.createdInlineChildCount) ||
			!isSafeCount(core.terminalizedInlineChildCount) ||
			!isSafeCount(core.resultfulInlineChildCount) ||
			core.createdInlineChildCount !== core.terminalizedInlineChildCount ||
			core.resultfulInlineChildCount > core.terminalizedInlineChildCount ||
			!strictRecord(core.dispatchClassification, ["core", "classificationSha256"]) ||
			!strictRecord(core.dispatchClassification.core, [
				"schemaVersion",
				"classification",
				"toolName",
				"effectiveEvalArgumentsSha256",
				"effectiveArgumentRevisionChainSha256",
				"classifiedAt",
			]) ||
			core.dispatchClassification.core.schemaVersion !== 1 ||
			core.dispatchClassification.core.classification !== "inline_dynamic" ||
			core.dispatchClassification.core.toolName !== "eval" ||
			!isSha256Ref(core.dispatchClassification.core.effectiveEvalArgumentsSha256) ||
			!isSha256Ref(core.dispatchClassification.core.effectiveArgumentRevisionChainSha256) ||
			!isIso8601(core.dispatchClassification.core.classifiedAt) ||
			!isSha256Ref(core.dispatchClassification.classificationSha256)
		)
			throw new TypeError("Invalid eval execute-result source observation");
		const hasHandoff = core.resultDisposition === "eval_inline_dynamic_handoff_present";
		if (
			(!hasHandoff && core.resultDisposition !== "eval_inline_dynamic_executed_without_handoff") ||
			(hasHandoff &&
				(core.resultfulInlineChildCount === 0 ||
					core.noHandoffReason !== null ||
					Object.hasOwn(core, "sourceProjectionRejection"))) ||
			(!hasHandoff &&
				(core.resultfulInlineChildCount !== 0 ||
					!isOneOf(core.noHandoffReason, ["zero_resultful_inline_children", "source_value_unrepresentable"]) ||
					Object.hasOwn(core, "sourceProjectionRejection") !==
						(core.noHandoffReason === "source_value_unrepresentable")))
		)
			throw new TypeError("Invalid eval execute-result disposition");
		if (
			Object.hasOwn(core, "sourceProjectionRejection") &&
			(!sourceObservationPlainRecord(core.sourceProjectionRejection) ||
				!isSha256Ref(core.sourceProjectionRejection.rejectionSha256))
		)
			throw new TypeError("Invalid eval source projection rejection");
		const executeEntry = decodeSourceObservationReceipt(core.executeEntryObservationReceipt, indexKeySha256);
		decodeSourceObservationResult(core.result);
		if (
			executeEntry.core.eventKind !== "eval_execute_entry" ||
			predecessor?.receiptSha256 !== executeEntry.receiptSha256
		)
			throw new TypeError("Invalid eval execute-result predecessor");
		return;
	}
	if (!sourceObservationPlainRecord(core.lifecycleObservation))
		throw new TypeError("Invalid agent-loop lifecycle observation");
	const lifecycle = core.lifecycleObservation;
	const lifecycleKeys = [
		"schemaVersion",
		"toolCallId",
		"toolName",
		"sourceToolCallOrdinal",
		"eventKind",
		"lifecycleOrdinal",
		"observationSequence",
		"predecessorObservationReceiptSha256",
		"sourceObservationReservationSha256",
		"observedAt",
	];
	const coreKeys = ["schemaVersion", "authority", "observedAt", "eventKind", "lifecycleObservation"];
	switch (core.eventKind) {
		case "steering_skip":
			lifecycleKeys.push("steeringSource", "result");
			coreKeys.push("steeringSource", "result");
			if (!isOneOf(core.steeringSource, ["user", "agent", "system", "unknown", "irc"]))
				throw new TypeError("Invalid steering source");
			decodeSourceObservationResult(core.result);
			break;
		case "signal_pre_execution_skip":
			lifecycleKeys.push("signalKind", "result");
			coreKeys.push("signalKind", "result");
			if (!isOneOf(core.signalKind, ["external_abort", "deadline", "pre_execution_skip"]))
				throw new TypeError("Invalid signal kind");
			decodeSourceObservationResult(core.result);
			break;
		case "validation_result":
			lifecycleKeys.push("stage", "result");
			coreKeys.push("stage", "result");
			if (!isOneOf(core.stage, ["initial_validation", "hook_revision_validation"]))
				throw new TypeError("Invalid validation stage");
			decodeSourceObservationResult(core.result);
			break;
		case "before_tool_block":
			lifecycleKeys.push("blockReasonUtf8", "preAfterHookResult");
			coreKeys.push("blockReasonUtf8", "preAfterHookResult");
			if (!isWellFormedString(core.blockReasonUtf8)) throw new TypeError("Invalid block reason");
			decodeSourceObservationResult(core.preAfterHookResult);
			break;
		case "before_tool_prepare_error":
			lifecycleKeys.push("prepareErrorUtf8", "preAfterHookResult");
			coreKeys.push("prepareErrorUtf8", "preAfterHookResult");
			if (!isWellFormedString(core.prepareErrorUtf8)) throw new TypeError("Invalid prepare error");
			decodeSourceObservationResult(core.preAfterHookResult);
			break;
		case "after_hook_result":
			lifecycleKeys.push("executionState", "nonExecutionReason", "afterToolCallInputResult", "finalResult");
			coreKeys.push(
				"priorSourceObservationReceipt",
				"executionState",
				"nonExecutionReason",
				"afterToolCallInputResult",
				"finalResult",
			);
			if (
				!isOneOf(core.executionState, ["not_started", "started"]) ||
				(core.nonExecutionReason !== null &&
					!isOneOf(core.nonExecutionReason, [
						"before_tool_block",
						"before_tool_prepare_error",
						"argument_transform_error",
						"pre_execute_error",
					])) ||
				!exactJson(core.priorSourceObservationReceipt, predecessor)
			)
				throw new TypeError("Invalid after-hook predecessor");
			decodeSourceObservationResult(core.afterToolCallInputResult);
			decodeSourceObservationResult(core.finalResult);
			break;
		case "assistant_stream_terminal":
			lifecycleKeys.push("syntheticSource", "result");
			coreKeys.push("result");
			if (
				!isOneOf(lifecycle.syntheticSource, [
					"assistant_stop_aborted",
					"assistant_stop_error",
					"assistant_stop_length",
					"assistant_stop_skipped",
				])
			)
				throw new TypeError("Invalid assistant terminal source");
			decodeSourceObservationResult(core.result);
			break;
		case "soft_requirement_detour":
		case "tool_missing":
			lifecycleKeys.push("result");
			coreKeys.push("result");
			decodeSourceObservationResult(core.result);
			break;
		default:
			throw new TypeError("Invalid agent-loop source observation event");
	}
	if (
		!strictRecord(core, coreKeys) ||
		!strictRecord(lifecycle, lifecycleKeys) ||
		lifecycle.schemaVersion !== 1 ||
		lifecycle.eventKind !== core.eventKind ||
		lifecycle.toolCallId !== authority.toolCallId ||
		lifecycle.toolName !== authority.toolName ||
		lifecycle.sourceToolCallOrdinal !== authority.sourceToolCallOrdinal ||
		lifecycle.lifecycleOrdinal !== authority.lifecycleOrdinal ||
		lifecycle.observationSequence !== authority.observationSequence ||
		lifecycle.predecessorObservationReceiptSha256 !== (predecessor?.receiptSha256 ?? null) ||
		lifecycle.sourceObservationReservationSha256 !== authority.reservation.reservationReceiptSha256 ||
		lifecycle.observedAt !== core.observedAt
	)
		throw new TypeError("Invalid agent-loop lifecycle observation join");
}

function decodeSourceObservationRecord(
	input: unknown,
	expectedIndexKeySha256?: Sha256Ref,
): ConfidentialTransientTaskSourceObservationRecordV1 {
	if (!strictRecord(input, ["core", "observationSha256"]) || !sourceObservationPlainRecord(input.core))
		throw new TypeError("Invalid source observation record");
	const core = input.core;
	if (
		core.schemaVersion !== 1 ||
		!validSourceObservationEventKind(core.eventKind) ||
		!isIso8601(core.observedAt) ||
		!strictRecord(core.authority, [
			"pendingCaptureIndexKey",
			"pendingCaptureKey",
			"startedCaptureReceipt",
			"parentSessionId",
			"parentSessionGenerationSha256",
			"parentBranchGenerationSha256",
			"assistantAnchorEntryId",
			"toolCallId",
			"toolName",
			"sourceToolCallOrdinal",
			"priorObservationHead",
			"predecessorObservationReceipt",
			"reservation",
			"lifecycleOrdinal",
			"observationSequence",
		])
	)
		throw new TypeError("Invalid source observation record authority");
	const authority = core.authority;
	const indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(authority.pendingCaptureIndexKey);
	if (expectedIndexKeySha256 !== undefined && indexKey.indexKeySha256 !== expectedIndexKeySha256)
		throw new TypeError("Source observation index mismatch");
	if (
		!strictRecord(authority.pendingCaptureKey, [
			"schemaVersion",
			"parentSessionId",
			"parentSessionGenerationSha256",
			"preAssistantBranchGenerationSha256",
			"preAssistantAnchorEntryId",
			"toolCallId",
			"toolName",
			"captureGeneration",
			"assistantStreamSha256",
			"keySha256",
		]) ||
		authority.pendingCaptureKey.schemaVersion !== 1 ||
		authority.pendingCaptureKey.parentSessionId !== indexKey.core.parentSessionId ||
		authority.pendingCaptureKey.parentSessionGenerationSha256 !== indexKey.core.parentSessionGenerationSha256 ||
		authority.pendingCaptureKey.preAssistantBranchGenerationSha256 !== indexKey.core.parentBranchGenerationSha256 ||
		(authority.pendingCaptureKey.preAssistantAnchorEntryId !== null &&
			!isWellFormedString(authority.pendingCaptureKey.preAssistantAnchorEntryId)) ||
		authority.pendingCaptureKey.toolCallId !== indexKey.core.toolCallId ||
		authority.pendingCaptureKey.toolName !== indexKey.core.toolName ||
		!isSafeCount(authority.pendingCaptureKey.captureGeneration) ||
		!isSha256Ref(authority.pendingCaptureKey.assistantStreamSha256) ||
		!isSha256Ref(authority.pendingCaptureKey.keySha256)
	)
		throw new TypeError("Invalid source observation capture key");
	const priorHead = decodeTransientTaskSourceObservationHeadV1(
		authority.priorObservationHead,
		indexKey.indexKeySha256,
	);
	const predecessor =
		authority.predecessorObservationReceipt === null
			? null
			: decodeSourceObservationReceipt(authority.predecessorObservationReceipt, indexKey.indexKeySha256);
	const reservation = decodeSourceObservationReservationReceipt(authority.reservation, indexKey.indexKeySha256);
	const startedReceipt = decodePendingCaptureStartedReceipt(authority.startedCaptureReceipt, indexKey.indexKeySha256);
	if (
		!isSafeCount(authority.lifecycleOrdinal) ||
		authority.lifecycleOrdinal !== authority.observationSequence ||
		authority.lifecycleOrdinal !== reservation.core.lifecycleOrdinal ||
		authority.parentSessionId !== indexKey.core.parentSessionId ||
		authority.parentSessionGenerationSha256 !== indexKey.core.parentSessionGenerationSha256 ||
		authority.parentBranchGenerationSha256 !== indexKey.core.parentBranchGenerationSha256 ||
		authority.assistantAnchorEntryId !== indexKey.core.assistantAnchorEntryId ||
		authority.toolCallId !== indexKey.core.toolCallId ||
		authority.toolName !== indexKey.core.toolName ||
		authority.sourceToolCallOrdinal !== indexKey.core.sourceToolCallOrdinal ||
		reservation.core.eventKind !== core.eventKind ||
		reservation.core.priorHeadSha256 !== priorHead.headSha256 ||
		reservation.core.predecessorObservationReceiptSha256 !== (predecessor?.receiptSha256 ?? null) ||
		startedReceipt.core.captureKeySha256 !== authority.pendingCaptureKey.keySha256 ||
		startedReceipt.core.initialSourceObservationHeadSha256 !== initialSourceObservationHead(indexKey).headSha256 ||
		!isSha256Ref(input.observationSha256) ||
		input.observationSha256 !== sourceObservationDigest("source_observation_record", core)
	)
		throw new TypeError("Invalid source observation record join");
	const pendingCaptureKey = {
		schemaVersion: 1 as const,
		parentSessionId: authority.pendingCaptureKey.parentSessionId,
		parentSessionGenerationSha256: authority.pendingCaptureKey.parentSessionGenerationSha256,
		preAssistantBranchGenerationSha256: authority.pendingCaptureKey.preAssistantBranchGenerationSha256,
		preAssistantAnchorEntryId: authority.pendingCaptureKey.preAssistantAnchorEntryId,
		toolCallId: authority.pendingCaptureKey.toolCallId,
		toolName: indexKey.core.toolName,
		captureGeneration: authority.pendingCaptureKey.captureGeneration,
		assistantStreamSha256: authority.pendingCaptureKey.assistantStreamSha256,
		keySha256: authority.pendingCaptureKey.keySha256,
	};
	const decodedAuthority: ConfidentialAgentSessionTransientTaskLifecycleAuthorityV1 = {
		pendingCaptureIndexKey: indexKey,
		pendingCaptureKey,
		startedCaptureReceipt: startedReceipt,
		parentSessionId: authority.parentSessionId,
		parentSessionGenerationSha256: authority.parentSessionGenerationSha256,
		parentBranchGenerationSha256: authority.parentBranchGenerationSha256,
		assistantAnchorEntryId: authority.assistantAnchorEntryId,
		toolCallId: authority.toolCallId,
		toolName: indexKey.core.toolName,
		sourceToolCallOrdinal: authority.sourceToolCallOrdinal,
		priorObservationHead: priorHead,
		predecessorObservationReceipt: predecessor,
		reservation,
		lifecycleOrdinal: authority.lifecycleOrdinal,
		observationSequence: authority.observationSequence,
	};
	decodeSourceObservationRecordPayload(core, decodedAuthority, predecessor, indexKey.indexKeySha256);
	return { core, observationSha256: input.observationSha256 };
}

function assertPendingCaptureRecord(
	input: unknown,
	expectedIndexKeySha256?: Sha256Ref,
): asserts input is ConfidentialTransientTaskPendingCaptureRecordV1 {
	if (
		!strictRecord(input, ["core", "recordSha256"]) ||
		!strictRecord(input.core, [
			"schemaVersion",
			"indexKey",
			"captureKey",
			"durableVersions",
			"executeEntryObservationReceipt",
			"state",
			"finalizedSnapshot",
			"preDispatchBinding",
			"anchoredBinding",
		]) ||
		input.core.schemaVersion !== 1
	)
		throw new TypeError("Invalid pending capture record");
	const core = input.core;
	const indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(core.indexKey);
	if (
		!strictRecord(core.captureKey, [
			"schemaVersion",
			"parentSessionId",
			"parentSessionGenerationSha256",
			"preAssistantBranchGenerationSha256",
			"preAssistantAnchorEntryId",
			"toolCallId",
			"toolName",
			"captureGeneration",
			"assistantStreamSha256",
			"keySha256",
		]) ||
		core.captureKey.schemaVersion !== 1 ||
		core.captureKey.parentSessionId !== indexKey.core.parentSessionId ||
		core.captureKey.parentSessionGenerationSha256 !== indexKey.core.parentSessionGenerationSha256 ||
		core.captureKey.toolCallId !== indexKey.core.toolCallId ||
		core.captureKey.toolName !== indexKey.core.toolName ||
		!isSafeCount(core.captureKey.captureGeneration) ||
		!isSha256Ref(core.captureKey.preAssistantBranchGenerationSha256) ||
		core.captureKey.preAssistantBranchGenerationSha256 !== indexKey.core.parentBranchGenerationSha256 ||
		(core.captureKey.preAssistantAnchorEntryId !== null &&
			!isWellFormedString(core.captureKey.preAssistantAnchorEntryId)) ||
		!isSha256Ref(core.captureKey.assistantStreamSha256) ||
		!isSha256Ref(core.captureKey.keySha256) ||
		(expectedIndexKeySha256 !== undefined && indexKey.indexKeySha256 !== expectedIndexKeySha256) ||
		!isOneOf(core.state, ["started", "finalized_unanchored", "anchored"]) ||
		!strictArray(core.durableVersions) ||
		core.durableVersions.length === 0 ||
		!isSha256Ref(input.recordSha256) ||
		input.recordSha256 !== sourceObservationDigest("pending_capture_record", core)
	)
		throw new TypeError("Invalid pending capture record join");
	let priorVersionSha256: Sha256Ref | null = null;
	for (let index = 0; index < core.durableVersions.length; index++) {
		const version = core.durableVersions[index];
		if (
			!strictRecord(version, [
				"schemaVersion",
				"key",
				"version",
				"priorVersionSha256",
				"captureRequest",
				"outcome",
				"capturedAt",
				"versionSha256",
			]) ||
			version.schemaVersion !== 1 ||
			!exactJson(version.key, core.captureKey) ||
			version.version !== index ||
			version.priorVersionSha256 !== priorVersionSha256 ||
			!sourceObservationPlainRecord(version.captureRequest) ||
			!sourceObservationPlainRecord(version.outcome) ||
			!isIso8601(version.capturedAt) ||
			!isSha256Ref(version.versionSha256)
		)
			throw new TypeError("Invalid pending capture version chain");
		priorVersionSha256 = version.versionSha256;
	}
	if (core.executeEntryObservationReceipt !== null) {
		const receipt = decodeSourceObservationReceipt(core.executeEntryObservationReceipt, indexKey.indexKeySha256);
		const expectedEventKind = indexKey.core.toolName === "task" ? "task_execute_entry" : "eval_execute_entry";
		if (receipt.core.eventKind !== expectedEventKind) throw new TypeError("Invalid pending execute-entry receipt");
	}
	if (
		(core.state === "started" &&
			(core.finalizedSnapshot !== null || core.preDispatchBinding !== null || core.anchoredBinding !== null)) ||
		(core.state === "finalized_unanchored" &&
			(core.finalizedSnapshot === null || core.preDispatchBinding === null || core.anchoredBinding !== null)) ||
		(core.state === "anchored" &&
			(core.finalizedSnapshot === null || core.preDispatchBinding === null || core.anchoredBinding === null))
	)
		throw new TypeError("Invalid pending capture state");
}

function decodePendingCaptureRecord(
	input: unknown,
	expectedIndexKeySha256?: Sha256Ref,
): ConfidentialTransientTaskPendingCaptureRecordV1 {
	assertPendingCaptureRecord(input, expectedIndexKeySha256);
	return input;
}

function decodeSourceObservationDraft(
	input: unknown,
	expectedIndexKeySha256: Sha256Ref,
): ConfidentialTransientTaskSourceObservationDraftRowV1 {
	if (
		!strictRecord(input, ["core", "draftSha256"]) ||
		!strictRecord(input.core, [
			"reservationRequest",
			"reservationReceipt",
			"priorHead",
			"predecessorObservationReceipt",
			"record",
			"acceptedHead",
			"prepareRequest",
			"draftedAt",
		]) ||
		!isIso8601(input.core.draftedAt) ||
		!isSha256Ref(input.draftSha256) ||
		input.draftSha256 !== sourceObservationDigest("source_observation_draft", input.core)
	)
		throw new TypeError("Invalid source observation draft");
	const reservationRequest = decodeSourceObservationReservationRequest(input.core.reservationRequest);
	if (reservationRequest.core.indexKey.indexKeySha256 !== expectedIndexKeySha256)
		throw new TypeError("Invalid source observation draft index");
	const reservationReceipt = decodeSourceObservationReservationReceipt(
		input.core.reservationReceipt,
		expectedIndexKeySha256,
		reservationRequest,
	);
	const priorHead = decodeTransientTaskSourceObservationHeadV1(input.core.priorHead, expectedIndexKeySha256);
	const acceptedHead = decodeTransientTaskSourceObservationHeadV1(input.core.acceptedHead, expectedIndexKeySha256);
	const record = decodeSourceObservationRecord(input.core.record, expectedIndexKeySha256);
	const predecessor =
		input.core.predecessorObservationReceipt === null
			? null
			: decodeSourceObservationReceipt(input.core.predecessorObservationReceipt, expectedIndexKeySha256);
	if (
		!strictRecord(input.core.prepareRequest, ["core", "requestSha256"]) ||
		!strictRecord(input.core.prepareRequest.core, [
			"record",
			"reservation",
			"priorHead",
			"predecessorObservationReceipt",
			"acceptedHead",
			"requestedAt",
		]) ||
		!isIso8601(input.core.prepareRequest.core.requestedAt) ||
		!isSha256Ref(input.core.prepareRequest.requestSha256) ||
		input.core.prepareRequest.requestSha256 !==
			sourceObservationDigest("source_observation_prepare_request", input.core.prepareRequest.core) ||
		!exactJson(input.core.prepareRequest.core.record, record) ||
		!exactJson(input.core.prepareRequest.core.reservation, reservationReceipt) ||
		!exactJson(input.core.prepareRequest.core.priorHead, priorHead) ||
		!exactJson(input.core.prepareRequest.core.predecessorObservationReceipt, predecessor) ||
		!exactJson(input.core.prepareRequest.core.acceptedHead, acceptedHead) ||
		input.core.prepareRequest.core.requestedAt !== reservationRequest.core.requestedAt ||
		input.core.draftedAt !== reservationRequest.core.requestedAt ||
		!exactJson(priorHead, reservationRequest.core.expectedHead) ||
		!exactJson(predecessor, reservationRequest.core.expectedPredecessorObservationReceipt) ||
		reservationReceipt.core.observationSequence !== priorHead.core.nextObservationSequence ||
		acceptedHead.core.nextObservationSequence !== priorHead.core.nextObservationSequence + 1 ||
		acceptedHead.core.acceptedObservationCount !== priorHead.core.acceptedObservationCount + 1 ||
		acceptedHead.core.lastAcceptedObservationSha256 !== record.observationSha256
	)
		throw new TypeError("Invalid source observation draft join");
	return {
		core: {
			reservationRequest,
			reservationReceipt,
			priorHead,
			predecessorObservationReceipt: predecessor,
			record,
			acceptedHead,
			prepareRequest: {
				core: {
					record,
					reservation: reservationReceipt,
					priorHead,
					predecessorObservationReceipt: predecessor,
					acceptedHead,
					requestedAt: input.core.prepareRequest.core.requestedAt,
				},
				requestSha256: input.core.prepareRequest.requestSha256,
			},
			draftedAt: input.core.draftedAt,
		},
		draftSha256: input.draftSha256,
	};
}

function decodeSourceObservationAcceptedRow(
	input: unknown,
	expectedIndexKeySha256: Sha256Ref,
): ConfidentialTransientTaskSourceObservationAcceptedRowV1 {
	if (
		!strictRecord(input, ["core", "acceptedRowSha256"]) ||
		!strictRecord(input.core, ["schemaVersion", "draft", "draftReceipt", "observationReceipt"]) ||
		input.core.schemaVersion !== 1 ||
		!isSha256Ref(input.acceptedRowSha256) ||
		input.acceptedRowSha256 !== sourceObservationDigest("source_observation_accepted_row", input.core)
	)
		throw new TypeError("Invalid accepted source observation row");
	const draft = decodeSourceObservationDraft(input.core.draft, expectedIndexKeySha256);
	const draftReceipt = decodeSourceObservationDraftReceipt(input.core.draftReceipt, expectedIndexKeySha256, draft);
	const observationReceipt = decodeSourceObservationReceipt(input.core.observationReceipt, expectedIndexKeySha256);
	const reservationReceipt = draft.core.reservationReceipt;
	if (
		observationReceipt.core.observationSha256 !== draft.core.record.observationSha256 ||
		observationReceipt.core.eventKind !== draft.core.record.core.eventKind ||
		observationReceipt.core.lifecycleOrdinal !== reservationReceipt.core.lifecycleOrdinal ||
		observationReceipt.core.reservationReceiptSha256 !== reservationReceipt.reservationReceiptSha256 ||
		observationReceipt.core.predecessorObservationReceiptSha256 !==
			(draft.core.predecessorObservationReceipt?.receiptSha256 ?? null) ||
		observationReceipt.core.priorHeadSha256 !== draft.core.priorHead.headSha256 ||
		observationReceipt.core.acceptedHeadSha256 !== draft.core.acceptedHead.headSha256
	)
		throw new TypeError("Invalid accepted source observation receipt join");
	return {
		core: {
			schemaVersion: 1,
			draft,
			draftReceipt,
			observationReceipt,
		},
		acceptedRowSha256: input.acceptedRowSha256,
	};
}

function encodeSourceObservationState(
	state: DurableTransientTaskSourceObservationStateV1,
): DurableTransientTaskSourceObservationStoredEnvelopeV1 {
	const tagged = encodeForegroundTaggedValue(state);
	return {
		schemaVersion: 1,
		kind: "transient_task_source_observation",
		tagged,
		stateSha256: sourceObservationDigest("source_observation_store_state", tagged),
	};
}

function decodeSourceObservationState(input: unknown | null): DurableTransientTaskSourceObservationStateV1 | null {
	if (input === null) return null;
	if (
		!strictRecord(input, ["schemaVersion", "kind", "tagged", "stateSha256"]) ||
		input.schemaVersion !== 1 ||
		input.kind !== "transient_task_source_observation" ||
		!isSha256Ref(input.stateSha256) ||
		input.stateSha256 !== sourceObservationDigest("source_observation_store_state", input.tagged)
	)
		throw new TypeError("Invalid source observation state envelope");
	const decoded = decodeForegroundTaggedValue(input.tagged);
	if (
		!strictRecord(decoded, [
			"schemaVersion",
			"indexKey",
			"head",
			"activeDraft",
			"acceptedRows",
			"draftAdoptions",
			"observationAdoptions",
			"pendingRecords",
			"startedReceipt",
			"executeEntryReceipt",
			"pendingEnumerations",
			"pendingAdoptions",
		]) ||
		decoded.schemaVersion !== 1
	)
		throw new TypeError("Invalid source observation state");
	const indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(decoded.indexKey);
	const head = decodeTransientTaskSourceObservationHeadV1(decoded.head, indexKey.indexKeySha256);
	if (
		!strictMap(decoded.acceptedRows) ||
		!strictMap(decoded.draftAdoptions) ||
		!strictMap(decoded.observationAdoptions)
	)
		throw new TypeError("Invalid source observation maps");
	const acceptedRows: Record<string, ConfidentialTransientTaskSourceObservationAcceptedRowV1> = {};
	const draftAdoptions: Record<string, Sha256Ref> = {};
	for (const [key, value] of Object.entries(decoded.draftAdoptions)) {
		if (!isSha256Ref(key) || !isSha256Ref(value)) throw new TypeError("Invalid draft adoption map");
		draftAdoptions[key] = value;
	}
	const observationAdoptions: Record<string, Sha256Ref> = {};
	for (const [key, value] of Object.entries(decoded.observationAdoptions)) {
		if (!isSha256Ref(key) || !isSha256Ref(value)) throw new TypeError("Invalid observation adoption map");
		observationAdoptions[key] = value;
	}
	if (Object.keys(decoded.acceptedRows).length !== head.core.acceptedObservationCount)
		throw new TypeError("Invalid accepted observation count");
	let latestAccepted: ConfidentialTransientTaskSourceObservationAcceptedRowV1 | null = null;
	for (let sequence = 0; sequence < head.core.acceptedObservationCount; sequence++) {
		const row = decodeSourceObservationAcceptedRow(decoded.acceptedRows[String(sequence)], indexKey.indexKeySha256);
		if (row.core.observationReceipt.core.observationSequence !== sequence)
			throw new TypeError("Invalid accepted observation sequence");
		acceptedRows[String(sequence)] = row;
		latestAccepted = row;
	}
	if ((latestAccepted?.core.draft.core.record.observationSha256 ?? null) !== head.core.lastAcceptedObservationSha256)
		throw new TypeError("Invalid accepted observation head join");
	let activeDraft: DurableTransientTaskSourceObservationActiveDraftV1 | null = null;
	if (decoded.activeDraft !== null) {
		if (!strictRecord(decoded.activeDraft, ["draft", "receipt"])) throw new TypeError("Invalid active draft");
		const draft = decodeSourceObservationDraft(decoded.activeDraft.draft, indexKey.indexKeySha256);
		const receipt = decodeSourceObservationDraftReceipt(decoded.activeDraft.receipt, indexKey.indexKeySha256, draft);
		if (draft.core.priorHead.headSha256 !== head.headSha256) throw new TypeError("Invalid active draft head join");
		activeDraft = { draft, receipt };
	}
	if (!strictArray(decoded.pendingRecords)) throw new TypeError("Invalid pending records");
	const pendingRecords = decoded.pendingRecords.map(record =>
		decodePendingCaptureRecord(record, indexKey.indexKeySha256),
	);
	const startedReceipt =
		decoded.startedReceipt === null
			? null
			: decodePendingCaptureStartedReceipt(decoded.startedReceipt, indexKey.indexKeySha256);
	if ((startedReceipt === null) !== (pendingRecords.length === 0))
		throw new TypeError("Invalid pending capture start state");
	if (startedReceipt !== null) {
		if (startedReceipt.core.initialSourceObservationHeadSha256 !== initialSourceObservationHead(indexKey).headSha256)
			throw new TypeError("Invalid pending capture initial head");
		for (const record of pendingRecords) {
			if (
				startedReceipt.core.captureKeySha256 !== record.core.captureKey.keySha256 ||
				startedReceipt.core.firstVersionSha256 !== record.core.durableVersions[0].versionSha256
			)
				throw new TypeError("Invalid pending capture started receipt join");
		}
	}
	const executeEntryReceipt =
		decoded.executeEntryReceipt === null
			? null
			: decodeSourceObservationReceipt(decoded.executeEntryReceipt, indexKey.indexKeySha256);
	const expectedExecuteEntryEventKind =
		indexKey.core.toolName === "task" ? "task_execute_entry" : "eval_execute_entry";
	if (executeEntryReceipt !== null && executeEntryReceipt.core.eventKind !== expectedExecuteEntryEventKind) {
		throw new TypeError("Invalid execute-entry receipt");
	}
	for (const record of pendingRecords)
		if (
			(record.core.executeEntryObservationReceipt?.receiptSha256 ?? null) !==
			(executeEntryReceipt?.receiptSha256 ?? null)
		)
			throw new TypeError("Invalid pending execute-entry receipt join");
	if (!strictMap(decoded.pendingEnumerations) || !strictMap(decoded.pendingAdoptions))
		throw new TypeError("Invalid pending observation maps");
	const pendingEnumerations: Record<string, DurableTransientTaskSourceObservationEnumerationV1> = {};
	for (const [key, value] of Object.entries(decoded.pendingEnumerations)) {
		if (
			!isSha256Ref(key) ||
			!strictRecord(value, ["recordSha256", "executionUnknown"]) ||
			(value.recordSha256 !== null && !isSha256Ref(value.recordSha256)) ||
			typeof value.executionUnknown !== "boolean"
		)
			throw new TypeError("Invalid pending enumeration map");
		pendingEnumerations[key] = {
			recordSha256: value.recordSha256,
			executionUnknown: value.executionUnknown,
		};
	}
	const pendingAdoptions: Record<string, Sha256Ref> = {};
	for (const [key, value] of Object.entries(decoded.pendingAdoptions)) {
		if (!isSha256Ref(key) || !isSha256Ref(value)) throw new TypeError("Invalid pending adoption map");
		pendingAdoptions[key] = value;
	}
	return {
		schemaVersion: 1,
		indexKey,
		head,
		activeDraft,
		acceptedRows,
		draftAdoptions,
		observationAdoptions,
		pendingRecords,
		startedReceipt,
		executeEntryReceipt,
		pendingEnumerations,
		pendingAdoptions,
	};
}

function initialSourceObservationHead(
	indexKey: ConfidentialTransientTaskPendingCaptureIndexKeyV1,
): ConfidentialTransientTaskSourceObservationHeadV1 {
	const core = {
		schemaVersion: 1 as const,
		indexKeySha256: indexKey.indexKeySha256,
		nextObservationSequence: 0,
		acceptedObservationCount: 0,
		lastAcceptedObservationSha256: null,
	};
	return { core, headSha256: sourceObservationDigest("source_observation_head", core) };
}

function sourceObservationAuthority(
	state: DurableTransientTaskSourceObservationStateV1,
	priorHead: ConfidentialTransientTaskSourceObservationHeadV1,
	predecessor: ConfidentialTransientTaskSourceObservationReceiptV1 | null,
	reservation: ConfidentialTransientTaskSourceObservationDraftRowV1["core"]["reservationReceipt"],
): ConfidentialAgentSessionTransientTaskLifecycleAuthorityV1 | null {
	if (state.pendingRecords.length !== 1 || state.startedReceipt === null) return null;
	const pending = state.pendingRecords[0];
	const key = state.indexKey.core;
	return {
		pendingCaptureIndexKey: state.indexKey,
		pendingCaptureKey: pending.core.captureKey,
		startedCaptureReceipt: state.startedReceipt,
		parentSessionId: key.parentSessionId,
		parentSessionGenerationSha256: key.parentSessionGenerationSha256,
		parentBranchGenerationSha256: key.parentBranchGenerationSha256,
		assistantAnchorEntryId: key.assistantAnchorEntryId,
		toolCallId: key.toolCallId,
		toolName: key.toolName,
		sourceToolCallOrdinal: key.sourceToolCallOrdinal,
		priorObservationHead: priorHead,
		predecessorObservationReceipt: predecessor,
		reservation,
		lifecycleOrdinal: reservation.core.lifecycleOrdinal,
		observationSequence: reservation.core.observationSequence,
	};
}

function buildSourceObservationRecord(
	request: Parameters<TransientTaskSourceObservationStoreV1["reserveAndFreezeObservationDraft"]>[0],
	authority: ConfidentialAgentSessionTransientTaskLifecycleAuthorityV1,
): ConfidentialTransientTaskSourceObservationRecordV1 | null {
	const input = request.core.observationInput;
	if (!sourceObservationPlainRecord(input) || input.eventKind !== request.core.eventKind) return null;
	let core: Record<string, unknown>;
	if (request.core.producer === "task_tool" || request.core.producer === "eval_tool") {
		core = { ...structuredClone(input), authority, observedAt: request.core.observedAt };
	} else {
		const assigned = {
			...structuredClone(input),
			lifecycleOrdinal: authority.lifecycleOrdinal,
			observationSequence: authority.observationSequence,
			predecessorObservationReceiptSha256: authority.predecessorObservationReceipt?.receiptSha256 ?? null,
			sourceObservationReservationSha256: authority.reservation.reservationReceiptSha256,
			observedAt: request.core.observedAt,
		};
		core = {
			schemaVersion: 1,
			authority,
			observedAt: request.core.observedAt,
			eventKind: request.core.eventKind,
			lifecycleObservation: assigned,
		};
		if (input.eventKind === "before_tool_block" || input.eventKind === "before_tool_prepare_error") {
			if (!sourceObservationPlainRecord(input.preAfterHookResult)) return null;
			const projection = projectSourceObservationResult(input.preAfterHookResult.result);
			if (projection === null) return null;
			core.preAfterHookResult = projection;
			if (input.eventKind === "before_tool_block") core.blockReasonUtf8 = input.blockReasonUtf8;
			else core.prepareErrorUtf8 = input.prepareErrorUtf8;
		} else if (input.eventKind === "after_hook_result") {
			if (
				!sourceObservationPlainRecord(input.afterToolCallInputResult) ||
				!sourceObservationPlainRecord(input.finalResult)
			)
				return null;
			const afterInput = projectSourceObservationResult(input.afterToolCallInputResult.result);
			const final = projectSourceObservationResult(input.finalResult.result);
			if (afterInput === null || final === null) return null;
			core.priorSourceObservationReceipt = authority.predecessorObservationReceipt;
			core.executionState = input.executionState;
			core.nonExecutionReason = input.nonExecutionReason;
			core.afterToolCallInputResult = afterInput;
			core.finalResult = final;
		} else {
			if (!("result" in input) || !sourceObservationPlainRecord(input.result)) return null;
			const projection = projectSourceObservationResult(input.result.result);
			if (projection === null) return null;
			core.result = projection;
			if (input.eventKind === "steering_skip") core.steeringSource = input.steeringSource;
			if (input.eventKind === "signal_pre_execution_skip") core.signalKind = input.signalKind;
			if (input.eventKind === "validation_result") core.stage = input.stage;
		}
	}
	const observationSha256 = sourceObservationDigest("source_observation_record", core);
	try {
		return decodeSourceObservationRecord(
			{ core, observationSha256 },
			authority.pendingCaptureIndexKey.indexKeySha256,
		);
	} catch {
		return null;
	}
}

export type {
	DurableTransientTaskSourceObservationStateV1,
	PayloadAvailableRowV1,
	PayloadDeletedRowV1,
	PrivateDetachedAttemptStateV1,
	PrivateDetachedEffectBlockStatusV1,
	PrivateDetachedEffectOpenResultV1,
	PrivateDetachedEffectRequestV1,
	PrivateDetachedHubLocatorV1,
	PrivateDetachedHubRecoveryIndexV1,
	PrivateDetachedHubRecoveryLocatorV1,
	PrivateDetachedHubReturnTargetLocatorV1,
	PrivateDetachedHubReturnTargetRecoveryIndexV1,
	PrivateDetachedHubReturnTargetRowV1,
	PrivateDetachedHubWinnerRowV1,
	PrivateDetachedIdentityLocatorV1,
	PrivateDetachedParentDeliveryEffectRequestV1,
	PrivateDetachedPrimaryAppendResolutionV1,
	PrivateDetachedRecoveryIndexEntryV1,
	PrivateDetachedRecoveryIndexV1,
	PrivateDetachedRecoveryRowV1,
	PrivateDetachedSettlementRowV1,
	PrivateForegroundAdoptRequestV1,
	PrivateForegroundAppendPrepareRequestV1,
	PrivateForegroundAppendRowV1,
	PrivateForegroundBatchJoinResultV1,
	PrivateForegroundBatchRowV1,
	PrivateForegroundDomainIndexV1,
	PrivateForegroundDomainV1,
	PrivateForegroundGateInspectRequestV1,
	PrivateForegroundGateRowV1,
	PrivateForegroundHandoffBatchV1,
	PrivateForegroundInspectRequestV1,
	PrivateForegroundMemberRowV1,
	PrivateForegroundNotAppliedProofV1,
	PrivateForegroundParentDeliveryEffectRequestV1,
	PrivateForegroundPendingRequestV1,
	PrivateForegroundPreOverlayGateV1,
	PrivateForegroundRenderedGateV1,
	PrivateForegroundRenderedResultV1,
	PrivateForegroundRenderedResumeRequestV1,
	PrivateForegroundSessionIndexV1,
	PrivateForegroundSessionLocatorV1,
	PrivateForegroundSuspensionV1,
	PrivateOrdinaryTransientTaskEnvironmentReleaseAuthorityV1,
	PrivateOrdinaryTransientTaskEnvironmentReleaseIndexV1,
	PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1,
	PrivateParentDeliveryEffectRequestV1,
	PrivateParentDeliveryReceiptV1,
	PrivateParentDeliveryRowV1,
	PrivatePublicationTargetBindingRowV1,
	PrivatePublicationTargetBindingV1,
	PrivatePublicationTargetConfidentialBindingV1,
	PrivateResultTargetRowV1,
	PrivateTransientTaskResultPublicationDeliveryDispatchV1,
	PrivateTransientTaskResultPublicationDeliveryReconciliationV1,
	RuntimeTimingStateV1,
	TransientTaskRuntimeStateV1,
	WorkspaceControllerStateV1,
};
export {
	addMilliseconds,
	advanceRuntimeTiming,
	appendSha256,
	buildSourceObservationRecord,
	CONTROLLER_NAMESPACE,
	cancellationReceiptTuple,
	cleanupProofMatches,
	compositionDiagnosticTuple,
	controllerObservation,
	controllerProofMatches,
	controllerProofTuple,
	controllerState,
	decodeDetachedRecoveryIndex,
	decodeOrdinaryTransientTaskEnvironmentReleaseIndex,
	decodePendingCaptureRecord,
	decodePublicationBindingEvidence,
	decodeRuntimeAttachmentRecordV1,
	decodeSourceObservationAcceptedRow,
	decodeSourceObservationDraft,
	decodeSourceObservationDraftReceipt,
	decodeSourceObservationReceipt,
	decodeSourceObservationRecord,
	decodeSourceObservationReservationReceipt,
	decodeSourceObservationReservationRequest,
	decodeSourceObservationState,
	deletionObservation,
	deletionProofMatches,
	derivedPayloadRetentionId,
	detachedAttemptIndex,
	detachedAttemptState,
	detachedCurrentAuthorityMatches,
	detachedDigest,
	detachedHubAllocationReceipt,
	detachedHubCompletionRequestMatches,
	detachedHubContinuationMatches,
	detachedHubInspectionBinding,
	detachedHubInspectRequestMatchesCapture,
	detachedHubLocatorKey,
	detachedHubMutableToolResultMessage,
	detachedHubOrdinaryPersistenceTicket,
	detachedHubOutboundTransitionMatchesRegistration,
	detachedHubPostHookFinalization,
	detachedHubRecoveryIndexKey,
	detachedHubReleaseTerminal,
	detachedHubReturnTargetMapKey,
	detachedHubReturnTargetRecoveryIndexKey,
	detachedHubSelectedReturnResult,
	detachedHubWinnerMapKey,
	detachedIdentityLocatorKey,
	detachedJobLocatorKey,
	detachedOperationReceiptSha256,
	detachedParentDeliveryRequest,
	detachedPrimaryAppendAbsenceProofMatches,
	detachedPrimaryAppendReceiptMatches,
	detachedPrimaryAppendRequest,
	detachedRecoveryIndexEntry,
	detachedRecoveryIndexKey,
	detachedSettlementFromOperation,
	detachedSettlementTerminalSha256,
	detachedStoreMapKey,
	detachedTaskKey,
	encodeForegroundTaggedValue,
	encodeSourceObservationState,
	exactJson,
	executionEnvironmentReleaseAuthoritySha256,
	foregroundAppendMapKey,
	foregroundBatchDomain,
	foregroundBatchMapKey,
	foregroundBatchReplayProofSha256,
	foregroundBatchRequestDomain,
	foregroundBatchTransitionReceiptSha256,
	foregroundDomainIndexKey,
	foregroundGateMapKey,
	foregroundMemberMapKey,
	foregroundParentDeliveryInspection,
	foregroundSessionAppendInspectionRequest,
	foregroundSessionIndexKey,
	foregroundTupleRef,
	foregroundUtf8Sha256,
	INVALID_PUBLICATION_TARGET_REQUEST_KEY,
	initialRuntimeTiming,
	initialSourceObservationHead,
	invalidIsolationClaimInspection,
	isCancellationPredecessor,
	isIso8601,
	isOneOf,
	isPayloadAttempt,
	isSafeCount,
	isSha256Hex,
	isSha256Ref,
	isWellFormedString,
	leaseProofMatches,
	lifecycleCleanupPlanTuple,
	lifecycleCleanupTransitionAllowed,
	lifecycleControlledTransitionAllowed,
	lifecycleIdentity,
	lifecycleIso8601,
	lifecycleIsolationClaimAttemptTuple,
	lifecycleIsolationEnsureTuple,
	lifecycleIsolationReadyTuple,
	lifecyclePendingJoinsAuthority,
	lifecyclePlanJoinsAuthority,
	lifecycleSafeInteger,
	lifecycleSha256Ref,
	lifecycleTupleRef,
	loadDetachedHubReturnTargetRow,
	loadDetachedHubWinnerRow,
	loadDetachedRow,
	loadForegroundValue,
	nowIso,
	ORDINARY_TRANSIENT_TASK_ENVIRONMENT_RELEASE_NAMESPACE_V1,
	ordinaryTransientTaskEnvironmentReleaseIndexWithEntries,
	ordinaryTransientTaskEnvironmentReleaseRowSha256,
	ownershipMatches,
	PublicationPayloadIdentityMismatchError,
	parentDeliveryConflict,
	parentDeliveryInspectRequest,
	parentDeliveryInspectRequestForPublication,
	parentDeliveryMapKey,
	parentDeliveryReceiptBase,
	parentDeliveryReceiptMatchesPublication,
	parentDeliveryReceiptMatchesPublicationRequest,
	parentDeliveryReceiptTuple,
	parentDeliveryRequestMatchesInspect,
	parentDeliveryRow,
	parentDeliverySinkProjectionMatches,
	parentDeliveryTerminalResult,
	payloadAttemptProjection,
	payloadAuthorityMatchesRef,
	payloadDeleteAuthorityTuple,
	payloadEnvelopeTuple,
	payloadInspection,
	payloadLifetimeTuple,
	payloadPlainData,
	payloadPutReceiptFromRequest,
	payloadRecoveryAuthorityTuple,
	payloadRefTuple,
	payloadRetentionReceiptFromAttempt,
	payloadRow,
	payloadStoreKey,
	payloadTupleRef,
	pendingOutcomeTuple,
	prePendingInitializationReceiptTuple,
	prePendingPlanTuple,
	proxyFreeData,
	publicationAttemptInspection,
	publicationAttemptInspectionFromBind,
	publicationBindAttemptTuple,
	publicationBindCreatorMatches,
	publicationBindInspectMatches,
	publicationBindingEvidenceTuple,
	publicationBindingLifecycleMatches,
	publicationBindingMapKey,
	publicationBindingRow,
	publicationBindReceiptFromAttempt,
	publicationClaimTuple,
	publicationCleanupClaimTuple,
	publicationCleanupDueReceiptFromAttempt,
	publicationControllerLifecycleMatches,
	publicationCurrentReceipt,
	publicationExpiryAttemptTuple,
	publicationMapKey,
	publicationPayloadMismatch,
	publicationReleaseAttemptTuple,
	publicationReleaseReceiptFromAttempt,
	publicationRenewalAttemptTuple,
	publicationRenewalReceiptFromAttempt,
	publicationRequestMatchesCurrentLifecycle,
	publicationState,
	publicationTargetHandle,
	publicationTargetKeyMatches,
	publicationTerminalLifecycleMatches,
	publicIsolationClaimInspection,
	publishedWorktreeReceiptSha256,
	renewalDeadline,
	replaceDetachedAttempt,
	resultTargetBindingReceiptFromAttempt,
	resultTargetCleanupReceiptFromAttempt,
	resultTargetExpiredCleanupDue,
	resultTargetKeyFromRecord,
	resultTargetKeyMatches,
	resultTargetKeyTuple,
	resultTargetLifecycleKeyMatches,
	resultTargetLifecycleMatches,
	resultTargetMapKey,
	resultTargetRenewalReceiptFromAttempt,
	resultTargetRouteTuple,
	resultTargetRow,
	runtimeLeaseMatches,
	runtimeTimingReadersV1,
	sameLifecycleImmutableAuthority,
	sourceObservationAuthority,
	sourceObservationDigest,
	sourceObservationPlainRecord,
	sourceObservationUndigestedBody,
	storeForegroundValue,
	strictArray,
	strictRecord,
	TRANSIENT_NAMESPACE,
	TRANSIENT_SOURCE_OBSERVATION_NAMESPACE,
	transientKey,
	transientRuntimeState,
	tupleRef,
	validatePendingPayloadIdentity,
	validatePublicationPayloadIdentity,
	validCancellationReceipt,
	validCompositionDiagnostic,
	validCurrentEpochReservationReceipt,
	validDetachedAttempt,
	validDetachedEffectRequest,
	validDetachedHubAbsenceRequest,
	validDetachedHubAdoptRequest,
	validDetachedHubCaptureRequest,
	validDetachedHubInspectRequest,
	validDetachedHubKey,
	validDetachedHubLocator,
	validDetachedHubRecoveryEnumerateRequest,
	validDetachedHubRecoveryIndex,
	validDetachedHubReleaseProgressRequest,
	validDetachedHubReleaseState,
	validDetachedHubRetryRequest,
	validDetachedHubReturnTargetRecoveryIndex,
	validDetachedHubSerializerHeadCommitReceipt,
	validDetachedHubSerializerKey,
	validDetachedHubWaitReservationReceipt,
	validDetachedIdentity,
	validDetachedIdentityLocator,
	validDetachedOperation,
	validDetachedRecoveryOwnerIndex,
	validDetachedRecoveryRecord,
	validDetachedSettlement,
	validDetachedTerminalReceiptForParent,
	validExecutionEnvironmentReleaseResult,
	validForegroundBatchReplayProof,
	validForegroundBatchTransitionReceipt,
	validForegroundDomainIndex,
	validForegroundPrimaryReceipt,
	validForegroundSessionIndex,
	validInitializationReceipt,
	validIsolationClaimInspectRequest,
	validLifecycleAuthority,
	validLifecycleCleanupPlan,
	validLifecycleControllerProof,
	validLifecycleDiscardReceipt,
	validLifecycleIsolationClaimRequest,
	validLifecycleIsolationCleanupDescriptor,
	validLifecyclePendingReceipt,
	validLifecycleTerminalEvidence,
	validParentDeliveryAdoptAuthority,
	validParentDeliveryRequest,
	validPayloadDeleteAuthority,
	validPayloadDeleteRequest,
	validPayloadPutRequest,
	validPayloadRef,
	validPayloadRetentionAuthority,
	validPayloadRetentionRequest,
	validPayloadTtl,
	validPendingOutcome,
	validPrePendingPlan,
	validPublicationBindInspectRequest,
	validPublicationBindRequest,
	validPublicationExpiryInspectRequest,
	validPublicationExpiryPlan,
	validPublicationOpenRequest,
	validPublicationReceipt,
	validPublicationReleaseInspectRequest,
	validPublicationReleasePlan,
	validPublicationRenewInspectRequest,
	validPublicationRenewRequest,
	validPublicationRequestShape,
	validPublicationSettlementRequest,
	validPublicationTargetKey,
	validResultStoreIdentity,
	validResultStoreInteger,
	validResultStoreIso8601,
	validResultStoreSha256Hex,
	validResultStoreSha256Ref,
	validResultTargetAuthority,
	validResultTargetBindRequest,
	validResultTargetCleanupInspectRequest,
	validResultTargetCleanupRequest,
	validResultTargetControllerProof,
	validResultTargetKey,
	validResultTargetRenewInspectRequest,
	validResultTargetRenewRequest,
	validSourceObservationEventKind,
	workspaceImagesMatch,
};
