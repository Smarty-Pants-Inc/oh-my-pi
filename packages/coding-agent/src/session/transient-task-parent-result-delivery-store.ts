import type { ISO8601, OperationId, Sha256Hex, Sha256Ref } from "../registry/persistent-agent-contracts.js";
import type { RuntimeDurableStateStoreV1 } from "./managed-workspace.js";
import type {
	DurableTransientTaskForegroundAppendDeliveryBatchInspectResultV1,
	DurableTransientTaskForegroundAppendDeliveryBatchStateAuthorityV1,
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
	PrivateParentDeliveryEffectRequestV1,
	PrivateParentDeliveryReceiptV1,
	PrivateParentDeliveryRowV1,
	PrivateResultTargetRowV1,
	RuntimeTransientAuthorityV1,
	TransientTaskRuntimeStateV1,
} from "./workspace-controller-codecs.js";
import {
	canonicalTransientTaskForegroundAppendDeliveryBatchInspectRequestSha256V1,
	canonicalTransientTaskForegroundAppendDeliveryBatchReplayAdoptRequestSha256V1,
	decodeDetachedRecoveryIndex,
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
	exactJson,
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
	isOneOf,
	loadDetachedHubReturnTargetRow,
	loadDetachedHubWinnerRow,
	loadDetachedRow,
	loadForegroundValue,
	nowIso,
	parentDeliveryConflict,
	parentDeliveryInspectRequest,
	parentDeliveryMapKey,
	parentDeliveryReceiptBase,
	parentDeliveryReceiptTuple,
	parentDeliveryRequestMatchesInspect,
	parentDeliveryRow,
	parentDeliverySinkProjectionMatches,
	parentDeliveryTerminalResult,
	payloadPlainData,
	proxyFreeData,
	publicationMapKey,
	publicationState,
	replaceDetachedAttempt,
	resultTargetKeyFromRecord,
	resultTargetKeyMatches,
	resultTargetLifecycleKeyMatches,
	resultTargetLifecycleMatches,
	resultTargetMapKey,
	resultTargetRow,
	storeForegroundValue,
	strictArray,
	strictRecord,
	TRANSIENT_NAMESPACE,
	transientKey,
	transientRuntimeState,
	tupleRef,
	validatePublicationPayloadIdentity,
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
	validDetachedHubWaitReservationReceipt,
	validDetachedIdentity,
	validDetachedIdentityLocator,
	validDetachedOperation,
	validDetachedRecoveryOwnerIndex,
	validDetachedRecoveryRecord,
	validDetachedSettlement,
	validDetachedTerminalReceiptForParent,
	validForegroundBatchReplayProof,
	validForegroundBatchTransitionReceipt,
	validForegroundDomainIndex,
	validForegroundPrimaryReceipt,
	validForegroundSessionIndex,
	validParentDeliveryAdoptAuthority,
	validParentDeliveryRequest,
	validResultStoreIdentity,
	validResultStoreInteger,
	validResultStoreIso8601,
	validResultStoreSha256Hex,
	validResultStoreSha256Ref,
} from "./workspace-controller-codecs.js";
import type {
	ConfidentialAgentSessionToolResultPersistenceTicketInputV1,
	ConfidentialAgentSessionToolResultTicketAllocationRequestV1,
	ConfidentialAsyncJobTransientTaskRecoveryIndexEntryV1,
	ConfidentialAsyncJobTransientTaskRecoveryWriteReceiptV1,
	ConfidentialTransientTaskDetachedCancellationSettlementAdoptRequestV1,
	ConfidentialTransientTaskDetachedCancellationSettlementAdoptResultV1,
	ConfidentialTransientTaskDetachedPrimarySessionAppendAdoptResultV1,
	ConfidentialTransientTaskDetachedPrimarySessionAppendInspectResultV1,
	ConfidentialTransientTaskDetachedPrimarySessionAppendRequestV1,
	ConfidentialTransientTaskDetachedPrimarySessionAppendResultV1,
	ConfidentialTransientTaskDetachedSettlementAdoptRequestV1,
	ConfidentialTransientTaskDetachedSettlementAdoptResultV1,
	ConfidentialTransientTaskDetachedSettlementOperationReceiptV1,
	ConfidentialTransientTaskDetachedSettlementReleaseReceiptV1,
	ConfidentialTransientTaskDetachedSettlementRequestV1,
	ConfidentialTransientTaskDetachedSettlementReservationReceiptV1,
	ConfidentialTransientTaskDetachedSettlementTerminalReceiptV1,
	ConfidentialTransientTaskForegroundAppendDeliveryBatchInspectRequestV1,
	ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayAdoptRequestV1,
	ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayAdoptResultV1,
	ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayProofV1,
	ConfidentialTransientTaskForegroundAppendDeliveryBatchRequestV1,
	ConfidentialTransientTaskForegroundAppendDeliveryBatchTransitionReceiptV1,
	ConfidentialTransientTaskForegroundResultSettlementAdoptRequestV1,
	ConfidentialTransientTaskForegroundResultSettlementAdoptResultV1,
	ConfidentialTransientTaskHubSendAwaitOutboundAdoptResultV1,
	ConfidentialTransientTaskHubSendAwaitOutboundInspectionV1,
	ConfidentialTransientTaskHubSendAwaitOutboundPlanV1,
	ConfidentialTransientTaskHubSendAwaitOutboundReceiptV1,
	ConfidentialTransientTaskHubSendAwaitOutboundStateV1,
	ConfidentialTransientTaskHubSendAwaitOutboundTransitionReceiptV1,
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionAdoptRequestV1,
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionAdoptResultV1,
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionInspectionV1,
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionReceiptV1,
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionStateV1,
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionTransitionReceiptV1,
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionTransitionRequestV1,
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryEffectResultV1,
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryInspectionV1,
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerEntryV1,
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerPermitV1,
	ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationPlanV1,
	ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationReceiptV1,
	ConfidentialTransientTaskHubWaitMessageCurrentParentSessionAuthorityV1,
	ConfidentialTransientTaskHubWaitMessageReturnBlockV1,
	ConfidentialTransientTaskHubWaitMessageReturnDeliveryRequestV1,
	ConfidentialTransientTaskHubWaitMessageTtsrInjectionRegistrationReceiptV1,
	ConfidentialTransientTaskHubWaitMessageWinnerAuthoritativeAbsenceReceiptV1,
	ConfidentialTransientTaskHubWaitMessageWinnerCompletionReceiptV1,
	ConfidentialTransientTaskHubWaitMessageWinnerContinuationV1,
	ConfidentialTransientTaskHubWaitMessageWinnerStartupResumeResultV1,
	ConfidentialTransientTaskParentResultDeliveryAdoptRequestV1,
	ConfidentialTransientTaskParentResultDeliveryAdoptResultV1,
	ConfidentialTransientTaskParentResultDeliveryAttemptV1,
	ConfidentialTransientTaskParentResultDeliveryRequestV1,
	ConfidentialTransientTaskParentResultNonDeliveryReceiptV1,
	ConfidentialTransientTaskParentResultSinkReceiptV1,
	TransientTaskDetachedCancellationSettlementInspectRequestV1,
	TransientTaskDetachedPrimarySessionAppendBridgeV1,
	TransientTaskDetachedSettledResultPublicationReceiptV1,
	TransientTaskDetachedSettledResultPublicationResultV1,
	TransientTaskDetachedSettlementCommitResultV1,
	TransientTaskDetachedSettlementInspectRequestV1,
	TransientTaskDetachedSettlementInspectResultV1,
	TransientTaskDetachedSettlementNotAppliedReceiptV1,
	TransientTaskDetachedSettlementPrepareResultV1,
	TransientTaskDetachedSettlementReleaseResultV1,
	TransientTaskDetachedSettlementReservationResultV1,
	TransientTaskDetachedSettlementStoreV1,
	TransientTaskDetachedSinkEnqueueResultV1,
	TransientTaskForegroundAfterToolCallGateBridgeV1,
	TransientTaskForegroundAppendDeliveryBatchResultV1,
	TransientTaskForegroundResultSettlementInspectRequestV1,
	TransientTaskForegroundResultSettlementInspectResultV1,
	TransientTaskForegroundResultSettlementStoreV1,
	TransientTaskForegroundSessionAppendInspectResultV1,
	TransientTaskHubSendAwaitOutboundEffectV1,
	TransientTaskHubSendAwaitTargetSourceEffectV1,
	TransientTaskHubWaitMessagePreselectionRecoveryStoreV1,
	TransientTaskHubWaitMessageReturnTargetBridgeV1,
	TransientTaskHubWaitMessageWinnerCompletionEffectV1,
	TransientTaskHubWaitMessageWinnerStartupRecoveryV1,
	TransientTaskParentResultDeliveryInspectRequestV1,
	TransientTaskParentResultDeliveryInspectResultV1,
	TransientTaskParentResultDeliveryPrepareResultV1,
	TransientTaskParentResultDeliveryReceiptV1,
	TransientTaskParentResultDeliveryStoreV1,
	TransientTaskResultPublicationStateV1,
	TransientTaskResultPublicationTargetKeyV1,
	TransientTaskWorkspaceKeyV1,
} from "./workspace-runtime-contracts.js";
import {
	buildTransientTaskHubWaitMessageCanonicalRecordV1,
	deriveTransientTaskHubDetachedReleaseAttemptV1,
	hashTransientTaskHubWaitMessageCanonicalRecordV1,
	validateTransientTaskHubWaitMessageCanonicalRecordV1,
} from "./workspace-runtime-contracts.js";

interface PrivateHubSendAwaitTargetLedgerRowV1 {
	readonly kind: "hub_send_await_target_ledger";
	readonly incarnationSha256: Sha256Ref;
	readonly revision: number;
	readonly entries: readonly ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerEntryV1[];
}

type HubTargetAcceptedLedgerEntryV1 = Extract<
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerEntryV1,
	{ readonly state: "accepted_pending_delivery" }
>;
type HubTargetSettledLedgerEntryV1 = Extract<
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerEntryV1,
	{ readonly state: "settled" }
>;
type HubTargetBlockedLedgerEntryV1 = Extract<
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerEntryV1,
	{ readonly state: "blocked_indeterminate" }
>;

function hubSendAwaitTargetLedgerMapKey(hubWaitInvocationId: OperationId): string {
	return `hub_send_await_target_ledger:${hubWaitInvocationId}`;
}

function hubSendAwaitTargetLedgerSha256(row: PrivateHubSendAwaitTargetLedgerRowV1): Sha256Ref {
	return detachedDigest("hub-send-await-target-ledger", {
		incarnationSha256: row.incarnationSha256,
		revision: row.revision,
		entrySha256s: row.entries.map(entry => entry.entrySha256),
	});
}

function loadHubSendAwaitTargetLedgerRow(input: unknown): PrivateHubSendAwaitTargetLedgerRowV1 {
	const row = loadForegroundValue<PrivateHubSendAwaitTargetLedgerRowV1>(input);
	if (
		!strictRecord(row, ["kind", "incarnationSha256", "revision", "entries"]) ||
		row.kind !== "hub_send_await_target_ledger" ||
		!validResultStoreSha256Ref(row.incarnationSha256) ||
		!validResultStoreInteger(row.revision) ||
		!strictArray(row.entries) ||
		!row.entries.every(entry =>
			validateTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-ledger-entry", entry),
		)
	)
		throw new TypeError("Invalid Hub send-await target ledger");
	return row;
}

function buildHubTargetAcceptedLedgerEntryV1(
	core: Omit<HubTargetAcceptedLedgerEntryV1, "entrySha256">,
): HubTargetAcceptedLedgerEntryV1 {
	const entry = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-ledger-entry", core);
	if (entry.state !== "accepted_pending_delivery") throw new TypeError("Invalid Hub target accepted entry");
	return entry;
}

function buildHubTargetSettledLedgerEntryV1(
	core: Omit<HubTargetSettledLedgerEntryV1, "entrySha256">,
): HubTargetSettledLedgerEntryV1 {
	const entry = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-ledger-entry", core);
	if (entry.state !== "settled") throw new TypeError("Invalid Hub target settled entry");
	return entry;
}

function buildHubTargetBlockedLedgerEntryV1(
	core: Omit<HubTargetBlockedLedgerEntryV1, "entrySha256">,
): HubTargetBlockedLedgerEntryV1 {
	const entry = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-ledger-entry", core);
	if (entry.state !== "blocked_indeterminate") throw new TypeError("Invalid Hub target blocked entry");
	return entry;
}

export class DurableTransientTaskParentResultDeliveryStoreV1
	implements
		TransientTaskParentResultDeliveryStoreV1,
		TransientTaskDetachedSettlementStoreV1,
		TransientTaskHubWaitMessageReturnTargetBridgeV1,
		TransientTaskHubWaitMessagePreselectionRecoveryStoreV1,
		TransientTaskHubWaitMessageWinnerStartupRecoveryV1,
		TransientTaskForegroundResultSettlementStoreV1,
		TransientTaskForegroundAfterToolCallGateBridgeV1,
		DurableTransientTaskForegroundAppendDeliveryBatchStateAuthorityV1
{
	readonly #durable: RuntimeDurableStateStoreV1;
	readonly #authority: RuntimeTransientAuthorityV1;
	readonly #hubWinnerCompletion: TransientTaskHubWaitMessageWinnerCompletionEffectV1;
	readonly #hubSendAwaitTargetSource: TransientTaskHubSendAwaitTargetSourceEffectV1;
	readonly #primarySessionAppend: TransientTaskDetachedPrimarySessionAppendBridgeV1;
	readonly #now: () => ISO8601;

	readonly detachedSettlement: TransientTaskDetachedSettlementStoreV1 = this;
	readonly foregroundSettlement: TransientTaskForegroundResultSettlementStoreV1 = this;
	readonly afterToolCallGate: TransientTaskForegroundAfterToolCallGateBridgeV1 = this;
	readonly transientTaskHubSendAwaitOutboundEffect: TransientTaskHubSendAwaitOutboundEffectV1;

	constructor(options: {
		readonly durable: RuntimeDurableStateStoreV1;
		readonly authority: RuntimeTransientAuthorityV1;
		readonly hubWinnerCompletion: TransientTaskHubWaitMessageWinnerCompletionEffectV1;
		readonly hubSendAwaitTargetSource: TransientTaskHubSendAwaitTargetSourceEffectV1;
		readonly primarySessionAppend: TransientTaskDetachedPrimarySessionAppendBridgeV1;
		readonly now?: () => ISO8601;
	}) {
		this.#durable = options.durable;
		this.#authority = options.authority;
		this.#hubWinnerCompletion = options.hubWinnerCompletion;
		this.#hubSendAwaitTargetSource = options.hubSendAwaitTargetSource;
		this.transientTaskHubSendAwaitOutboundEffect = Object.freeze({
			observeTargetDeliveryLedger: (
				input: Parameters<TransientTaskHubSendAwaitOutboundEffectV1["observeTargetDeliveryLedger"]>[0],
			) => this.#observeHubSendAwaitTargetDeliveryLedger(input),
			dispatch: (request: Parameters<TransientTaskHubSendAwaitOutboundEffectV1["dispatch"]>[0]) =>
				this.#dispatchHubSendAwaitOutbound(request),
			inspect: (request: Parameters<TransientTaskHubSendAwaitOutboundEffectV1["inspect"]>[0]) =>
				this.#inspectHubSendAwaitOutbound(request),
			adopt: (request: Parameters<TransientTaskHubSendAwaitOutboundEffectV1["adopt"]>[0]) =>
				this.#adoptHubSendAwaitOutbound(request),
			dispatchAndRecover: (request: Parameters<TransientTaskHubSendAwaitOutboundEffectV1["dispatchAndRecover"]>[0]) =>
				this.#dispatchAndRecoverHubSendAwaitOutbound(request),
		});
		this.#primarySessionAppend = options.primarySessionAppend;
		this.#now = options.now ?? nowIso;
	}
	#foregroundBatchRow(
		state: TransientTaskRuntimeStateV1,
		foregroundAppendBatchKeySha256: Sha256Ref,
	): PrivateForegroundBatchRowV1 | null {
		const input = state.parentDeliveries[foregroundBatchMapKey(foregroundAppendBatchKeySha256)];
		if (input === undefined) return null;
		const row = loadForegroundValue<PrivateForegroundBatchRowV1>(input);
		if (!strictRecord(row, ["kind", "batch"]) || row.kind !== "foreground_batch")
			throw new TypeError("Invalid foreground handoff row");
		const domain = foregroundBatchDomain(row.batch);
		if (!domain || domain.foregroundAppendBatchKeySha256 !== foregroundAppendBatchKeySha256)
			throw new TypeError("Invalid foreground handoff join");
		return row;
	}

	#foregroundGateRow(
		state: TransientTaskRuntimeStateV1,
		foregroundAppendBatchKeySha256: Sha256Ref,
	): PrivateForegroundGateRowV1 | null {
		const input = state.parentDeliveries[foregroundGateMapKey(foregroundAppendBatchKeySha256)];
		if (input === undefined) return null;
		const row = loadForegroundValue<PrivateForegroundGateRowV1>(input);
		if (
			!strictRecord(row, [
				"kind",
				"preOverlayGate",
				"renderedGate",
				"renderedResult",
				"suspension",
				"lastInspectionSha256",
				"overlayCommitReceipt",
			]) ||
			row.kind !== "foreground_gate"
		)
			throw new TypeError("Invalid foreground gate row");
		return row;
	}

	#foregroundAppendRow(
		state: TransientTaskRuntimeStateV1,
		foregroundAppendBatchKeySha256: Sha256Ref,
	): PrivateForegroundAppendRowV1 | null {
		const input = state.parentDeliveries[foregroundAppendMapKey(foregroundAppendBatchKeySha256)];
		if (input === undefined) return null;
		const row = loadForegroundValue<PrivateForegroundAppendRowV1>(input);
		if (
			!strictRecord(row, [
				"kind",
				"batch",
				"attempts",
				"notAppliedProofs",
				"parentDeliveryAttempts",
				"batchTransitionReceipt",
				"batchReplayProof",
				"primaryReceipt",
			]) ||
			row.kind !== "foreground_append" ||
			!strictArray(row.attempts) ||
			!strictArray(row.notAppliedProofs) ||
			!strictArray(row.parentDeliveryAttempts)
		)
			throw new TypeError("Invalid foreground append row");
		return row;
	}

	async #foregroundState(foregroundAppendBatchKeySha256: Sha256Ref) {
		const indexInput = await this.#durable.inspect(
			TRANSIENT_NAMESPACE,
			foregroundDomainIndexKey(foregroundAppendBatchKeySha256),
		);
		if (indexInput === null) return null;
		if (!validForegroundDomainIndex(indexInput)) throw new TypeError("Invalid foreground domain index");
		const taskKey = { taskId: indexInput.taskId, runId: indexInput.runId };
		const state = transientRuntimeState(
			taskKey,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
		);
		const batchRow = this.#foregroundBatchRow(state, foregroundAppendBatchKeySha256);
		if (!batchRow) throw new TypeError("Foreground domain index is stale");
		const domain = foregroundBatchDomain(batchRow.batch);
		if (
			!domain ||
			domain.taskId !== indexInput.taskId ||
			domain.runId !== indexInput.runId ||
			domain.parentSessionId !== indexInput.parentSessionId ||
			domain.parentSessionGenerationSha256 !== indexInput.parentSessionGenerationSha256
		)
			throw new TypeError("Foreground domain index join is invalid");
		return { index: indexInput, taskKey, state, batchRow, domain };
	}

	async #joinForegroundAppendDeliveryBatch(
		state: TransientTaskRuntimeStateV1,
		request: ConfidentialTransientTaskForegroundAppendDeliveryBatchRequestV1,
		domain: PrivateForegroundDomainV1,
	): Promise<PrivateForegroundBatchJoinResultV1> {
		const append = this.#foregroundAppendRow(state, domain.foregroundAppendBatchKeySha256);
		if (!append) return { status: "append_not_prepared" };
		if (
			!exactJson(storeForegroundValue(append.batch), storeForegroundValue(request.append.batch)) ||
			append.attempts.length === 0 ||
			append.attempts.length !== append.batch.requests.length ||
			append.notAppliedProofs.length !== append.attempts.length ||
			append.parentDeliveryAttempts.length !== append.attempts.length ||
			!exactJson(
				request.append.expectedAttemptSha256s,
				append.attempts.map(attempt => attempt.attemptSha256),
			) ||
			!exactJson(
				request.append.expectedNotAppliedProofSha256s,
				append.notAppliedProofs.map(proof => proof.proofSha256),
			) ||
			!exactJson(request.parentDeliveryAttempts, append.parentDeliveryAttempts)
		)
			return { status: "member_set_conflict" };
		const parents: PrivateParentDeliveryRowV1[] = [];
		for (let index = 0; index < append.attempts.length; index++) {
			const appendRequest = append.batch.requests[index];
			const appendAttempt = append.attempts[index];
			const notAppliedProof = append.notAppliedProofs[index];
			const parentAttempt = append.parentDeliveryAttempts[index];
			if (
				!appendRequest ||
				!appendAttempt ||
				!notAppliedProof ||
				!parentAttempt ||
				appendAttempt.state !== "not_applied" ||
				!exactJson(appendAttempt.request, appendRequest) ||
				appendAttempt.attemptSha256 !== request.append.expectedAttemptSha256s[index] ||
				notAppliedProof.proofSha256 !== request.append.expectedNotAppliedProofSha256s[index] ||
				notAppliedProof.settlementIdentitySha256 !== appendRequest.identity.identitySha256 ||
				notAppliedProof.preReturnIdentitySha256 !== appendRequest.preReturnIdentity.preReturnIdentitySha256 ||
				notAppliedProof.appendOperationId !== appendRequest.preReturnIdentity.core.appendOperationId ||
				notAppliedProof.appendBatchSha256 !== append.batch.appendBatchSha256 ||
				notAppliedProof.foregroundAppendBatchKeySha256 !== append.batch.foregroundAppendBatchKeySha256 ||
				notAppliedProof.appendRequestSha256 !== appendRequest.appendRequestSha256 ||
				notAppliedProof.appendAttemptSha256 !== appendAttempt.attemptSha256 ||
				notAppliedProof.deliveryAuthoritySha256 !== appendRequest.identity.core.deliveryAuthoritySha256 ||
				parentAttempt.attemptSha256 !== request.parentDeliveryAttempts[index]?.attemptSha256 ||
				!exactJson(parentAttempt.request, request.parentDeliveryAttempts[index]?.request) ||
				parentAttempt.request.route.kind !== "foreground_tool_call" ||
				parentAttempt.request.taskId !== domain.taskId ||
				parentAttempt.request.runId !== domain.runId ||
				parentAttempt.request.deliveryOperationId !== appendRequest.preReturnIdentity.core.deliveryOperationId ||
				parentAttempt.request.deliveryRequestSha256 !== appendRequest.identity.core.deliveryRequestSha256 ||
				parentAttempt.request.deliveryAuthoritySha256 !== appendRequest.identity.core.deliveryAuthoritySha256 ||
				!resultTargetKeyMatches(parentAttempt.request, appendRequest.preReturnIdentity.core)
			)
				return { status: "member_set_conflict" };
			const key = resultTargetKeyFromRecord(parentAttempt.request);
			if (!key) return { status: "invalid" };
			const parent = await parentDeliveryRow(state.parentDeliveries[parentDeliveryMapKey(key)]);
			if (!parent) return { status: "delivery_not_prepared" };
			if (!exactJson(parent.attempt, parentAttempt)) return { status: "member_set_conflict" };
			parents.push(parent);
		}
		if (append.batchReplayProof !== null && !(await validForegroundBatchReplayProof(append.batchReplayProof, append)))
			return { status: "invalid" };
		if (append.batchTransitionReceipt !== null) {
			if (!(await validForegroundBatchTransitionReceipt(append.batchTransitionReceipt, append)))
				return { status: "invalid" };
			if (append.batchReplayProof === null) {
				if (
					append.batchTransitionReceipt.transitionSequence !== 1 ||
					append.batchTransitionReceipt.previousTransitionReceiptSha256 !== null ||
					append.batchTransitionReceipt.replayProofSha256 !== null
				)
					return { status: "invalid" };
			} else if (
				append.batchTransitionReceipt.transitionSequence !==
					append.batchReplayProof.priorTransitionReceipt.transitionSequence + 1 ||
				append.batchTransitionReceipt.previousTransitionReceiptSha256 !==
					append.batchReplayProof.priorTransitionReceipt.receiptSha256 ||
				append.batchTransitionReceipt.replayProofSha256 !== append.batchReplayProof.proofSha256
			)
				return { status: "invalid" };
		} else if (append.primaryReceipt !== null) {
			return { status: "invalid" };
		}
		if (append.primaryReceipt !== null) {
			const primary = append.primaryReceipt;
			if (
				append.batchTransitionReceipt === null ||
				primary.foregroundAppendBatchKeySha256 !== append.batch.foregroundAppendBatchKeySha256 ||
				primary.appendBatchSha256 !== append.batch.appendBatchSha256 ||
				!exactJson(
					primary.orderedAppendOperationIds,
					append.batch.requests.map(member => member.preReturnIdentity.core.appendOperationId),
				) ||
				!exactJson(
					primary.orderedSettlementIdentitySha256s,
					append.batch.requests.map(member => member.identity.identitySha256),
				) ||
				!exactJson(primary.entry, append.batch.entry) ||
				!validResultStoreSha256Ref(primary.primaryReceiptSha256)
			)
				return { status: "invalid" };
		}
		return {
			status: "matching",
			joined: { domain, append, parents: parents as [PrivateParentDeliveryRowV1, ...PrivateParentDeliveryRowV1[]] },
		};
	}

	async transitionPreparedForegroundAppendDeliveryBatch(
		request: ConfidentialTransientTaskForegroundAppendDeliveryBatchRequestV1,
	): Promise<TransientTaskForegroundAppendDeliveryBatchResultV1> {
		let domain: PrivateForegroundDomainV1 | null;
		try {
			domain = await foregroundBatchRequestDomain(request);
		} catch {
			return { status: "invalid" };
		}
		if (!domain) return { status: "invalid" };
		const taskKey = { taskId: domain.taskId, runId: domain.runId };
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			let state: TransientTaskRuntimeStateV1;
			try {
				state = transientRuntimeState(taskKey, currentInput);
				const result = await this.#joinForegroundAppendDeliveryBatch(state, request, domain);
				if (result.status !== "matching") return { state, result: { status: result.status } as const };
				const { append, parents } = result.joined;
				if (append.batchTransitionReceipt !== null) {
					if (append.batchTransitionReceipt.coordinatorRequestSha256 !== request.coordinatorRequestSha256)
						return { state, result: { status: "conflict" } as const };
					const allDelivered = parents.every(
						parent => parent.state === "terminal" && parent.receipt.outcome === "delivered",
					);
					if (allDelivered && append.primaryReceipt !== null) {
						const receipts = parents.map(parent => {
							if (parent.state !== "terminal" || parent.receipt.outcome !== "delivered")
								throw new TypeError("Foreground parent receipt is invalid");
							return parent.receipt;
						}) as [
							Extract<TransientTaskParentResultDeliveryReceiptV1, { outcome: "delivered" }>,
							...Extract<TransientTaskParentResultDeliveryReceiptV1, { outcome: "delivered" }>[],
						];
						return {
							state,
							result: {
								status: "already_sink_committed",
								transitionReceipt: append.batchTransitionReceipt,
								primaryReceipt: append.primaryReceipt,
								parentDeliveryReceipts: receipts,
							} as const,
						};
					}
					if (
						parents.some(parent => parent.state === "not_applied") ||
						(append.primaryReceipt === null && parents.some(parent => parent.state === "terminal")) ||
						parents.some(parent => parent.state === "terminal" && parent.receipt.outcome !== "delivered")
					)
						return { state, result: { status: "member_set_conflict" } as const };
					return {
						state,
						result: {
							status: "batch_outcome_unknown",
							transitionReceipt: append.batchTransitionReceipt,
						} as const,
					};
				}
				if (parents.some(parent => parent.state !== "not_applied"))
					return { state, result: { status: "member_set_conflict" } as const };
				const observedAt = this.#now();
				for (const parent of parents) {
					const current = await this.#currentParentRequest(state, parent.attempt.request, observedAt);
					if (current.status !== "current")
						return {
							state,
							result: {
								status: current.status === "stale_live_receipt" ? "append_parent_stale" : "authority_lost",
							} as const,
						};
				}
				const priorTransition = append.batchReplayProof?.priorTransitionReceipt ?? null;
				const transitionSequence = (priorTransition?.transitionSequence ?? 0) + 1;
				if (!Number.isSafeInteger(transitionSequence)) return { state, result: { status: "invalid" } as const };
				const receiptCore = {
					schemaVersion: 1 as const,
					coordinatorRequestSha256: request.coordinatorRequestSha256,
					foregroundAppendBatchKeySha256: append.batch.foregroundAppendBatchKeySha256,
					appendBatchSha256: append.batch.appendBatchSha256,
					transitionSequence,
					previousTransitionReceiptSha256: priorTransition?.receiptSha256 ?? null,
					replayProofSha256: append.batchReplayProof?.proofSha256 ?? null,
					orderedSettlementIdentitySha256s: append.batch.requests.map(
						member => member.identity.identitySha256,
					) as [Sha256Ref, ...Sha256Ref[]],
					orderedAppendAttemptSha256s: append.attempts.map(attempt => attempt.attemptSha256) as [
						Sha256Ref,
						...Sha256Ref[],
					],
					orderedAppendNotAppliedProofSha256s: append.notAppliedProofs.map(proof => proof.proofSha256) as [
						Sha256Ref,
						...Sha256Ref[],
					],
					orderedParentDeliveryAttemptSha256s: append.parentDeliveryAttempts.map(
						attempt => attempt.attemptSha256,
					) as [Sha256Ref, ...Sha256Ref[]],
					transitionedImmediatelyBeforeDispatchAt: observedAt,
				};
				const transitionReceipt: ConfidentialTransientTaskForegroundAppendDeliveryBatchTransitionReceiptV1 = {
					...receiptCore,
					receiptSha256: await foregroundBatchTransitionReceiptSha256(receiptCore),
				};
				const parentDeliveries = { ...state.parentDeliveries };
				parentDeliveries[foregroundAppendMapKey(append.batch.foregroundAppendBatchKeySha256)] =
					storeForegroundValue({
						...append,
						batchTransitionReceipt: transitionReceipt,
						primaryReceipt: null,
					} satisfies PrivateForegroundAppendRowV1);
				for (const parent of parents) {
					const key = resultTargetKeyFromRecord(parent.attempt.request);
					if (!key) return { state, result: { status: "invalid" } as const };
					parentDeliveries[parentDeliveryMapKey(key)] = {
						state: "outcome_unknown",
						attempt: parent.attempt,
						receipt: null,
					} satisfies PrivateParentDeliveryRowV1;
				}
				return {
					state: { ...state, parentDeliveries },
					result: { status: "batch_outcome_unknown", transitionReceipt } as const,
				};
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
		});
	}

	async inspectPreparedForegroundAppendDeliveryBatch(
		request: ConfidentialTransientTaskForegroundAppendDeliveryBatchInspectRequestV1,
	): Promise<DurableTransientTaskForegroundAppendDeliveryBatchInspectResultV1> {
		let domain: PrivateForegroundDomainV1 | null;
		try {
			if (
				!proxyFreeData(request) ||
				!strictRecord(request, [
					"batchRequest",
					"expectedTransitionReceiptSha256",
					"requestedAt",
					"requestSha256",
				]) ||
				(request.expectedTransitionReceiptSha256 !== null &&
					!validResultStoreSha256Ref(request.expectedTransitionReceiptSha256)) ||
				!validResultStoreIso8601(request.requestedAt) ||
				!validResultStoreSha256Hex(request.requestSha256)
			)
				return { status: "invalid" };
			domain = await foregroundBatchRequestDomain(request.batchRequest);
			const { requestSha256: _requestSha256, ...requestCore } = request;
			if (
				!domain ||
				(await canonicalTransientTaskForegroundAppendDeliveryBatchInspectRequestSha256V1(requestCore)) !==
					request.requestSha256
			)
				return { status: "invalid" };
		} catch {
			return { status: "invalid" };
		}
		const taskKey = { taskId: domain.taskId, runId: domain.runId };
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			try {
				const state = transientRuntimeState(taskKey, currentInput);
				const result = await this.#joinForegroundAppendDeliveryBatch(state, request.batchRequest, domain);
				if (result.status !== "matching")
					return {
						state,
						result: {
							status:
								result.status === "append_not_prepared" || result.status === "delivery_not_prepared"
									? "conflict"
									: result.status,
						} as const,
					};
				const { append, parents } = result.joined;
				if (append.batchTransitionReceipt === null) {
					if (
						request.expectedTransitionReceiptSha256 !== null ||
						append.primaryReceipt !== null ||
						parents.some(parent => parent.state !== "not_applied")
					)
						return { state, result: { status: "member_set_conflict" } as const };
					return {
						state,
						result: {
							status: "not_applied",
							coordinatorRequestSha256: request.batchRequest.coordinatorRequestSha256,
							orderedAppendAttemptSha256s: append.attempts.map(attempt => attempt.attemptSha256) as [
								Sha256Ref,
								...Sha256Ref[],
							],
							orderedParentDeliveryAttemptSha256s: append.parentDeliveryAttempts.map(
								attempt => attempt.attemptSha256,
							) as [Sha256Ref, ...Sha256Ref[]],
							replayProof: append.batchReplayProof,
						} as const,
					};
				}
				if (
					request.expectedTransitionReceiptSha256 !== append.batchTransitionReceipt.receiptSha256 ||
					append.batchTransitionReceipt.coordinatorRequestSha256 !==
						request.batchRequest.coordinatorRequestSha256 ||
					parents.some(parent => parent.state === "not_applied") ||
					parents.some(parent => parent.state === "terminal" && parent.receipt.outcome !== "delivered") ||
					(append.primaryReceipt === null && parents.some(parent => parent.state === "terminal"))
				)
					return { state, result: { status: "member_set_conflict" } as const };
				const allDelivered = parents.every(
					parent => parent.state === "terminal" && parent.receipt.outcome === "delivered",
				);
				if (allDelivered) {
					if (append.primaryReceipt === null) return { state, result: { status: "member_set_conflict" } as const };
					const receipts = parents.map(parent => {
						if (parent.state !== "terminal" || parent.receipt.outcome !== "delivered")
							throw new TypeError("Foreground parent receipt is invalid");
						return parent.receipt;
					}) as [
						Extract<TransientTaskParentResultDeliveryReceiptV1, { outcome: "delivered" }>,
						...Extract<TransientTaskParentResultDeliveryReceiptV1, { outcome: "delivered" }>[],
					];
					return {
						state,
						result: {
							status: "sink_committed",
							transitionReceipt: append.batchTransitionReceipt,
							primaryReceipt: append.primaryReceipt,
							parentDeliveryReceipts: receipts,
						} as const,
					};
				}
				return {
					state,
					result: {
						status: "outcome_unknown",
						transitionReceipt: append.batchTransitionReceipt,
						sessionAppendInspectionRequest: foregroundSessionAppendInspectionRequest(append),
						parentDeliveryInspections: parents.map(foregroundParentDeliveryInspection) as [
							TransientTaskParentResultDeliveryInspectResultV1,
							...TransientTaskParentResultDeliveryInspectResultV1[],
						],
					} as const,
				};
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
		});
	}

	async restoreExactAbsentForegroundAppendDeliveryBatchForReplay(
		request: ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayAdoptRequestV1,
		sessionAppendInspection: TransientTaskForegroundSessionAppendInspectResultV1,
	): Promise<ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayAdoptResultV1> {
		let domain: PrivateForegroundDomainV1 | null;
		try {
			if (
				!proxyFreeData(request) ||
				!strictRecord(request, [
					"inspectionRequest",
					"expectedSessionAppendInspectionSha256",
					"currentDeliveryAuthorities",
					"requestedAt",
					"requestSha256",
				]) ||
				!strictArray(request.currentDeliveryAuthorities) ||
				request.currentDeliveryAuthorities.length === 0 ||
				!validResultStoreSha256Ref(request.expectedSessionAppendInspectionSha256) ||
				!validResultStoreIso8601(request.requestedAt) ||
				!validResultStoreSha256Hex(request.requestSha256)
			)
				return { status: "invalid" };
			domain = await foregroundBatchRequestDomain(request.inspectionRequest.batchRequest);
			const { requestSha256: _requestSha256, ...requestCore } = request;
			const { requestSha256: _inspectionRequestSha256, ...inspectionCore } = request.inspectionRequest;
			if (
				!domain ||
				(await canonicalTransientTaskForegroundAppendDeliveryBatchInspectRequestSha256V1(inspectionCore)) !==
					request.inspectionRequest.requestSha256 ||
				(await canonicalTransientTaskForegroundAppendDeliveryBatchReplayAdoptRequestSha256V1(requestCore)) !==
					request.requestSha256
			)
				return { status: "invalid" };
			if (
				!proxyFreeData(sessionAppendInspection) ||
				!sessionAppendInspection ||
				typeof sessionAppendInspection !== "object"
			)
				return { status: "invalid" };
			if (sessionAppendInspection.status !== "absent") return { status: "entry_not_absent" };
			if (
				!strictRecord(sessionAppendInspection, ["status", "inspectedAt", "inspectionSha256"]) ||
				!validResultStoreIso8601(sessionAppendInspection.inspectedAt) ||
				!validResultStoreSha256Ref(sessionAppendInspection.inspectionSha256)
			)
				return { status: "invalid" };
			if (
				sessionAppendInspection.inspectionSha256 !== request.expectedSessionAppendInspectionSha256 ||
				request.inspectionRequest.expectedTransitionReceiptSha256 === null
			)
				return { status: "inspection_stale" };
		} catch {
			return { status: "invalid" };
		}
		const taskKey = { taskId: domain.taskId, runId: domain.runId };
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			try {
				const state = transientRuntimeState(taskKey, currentInput);
				const result = await this.#joinForegroundAppendDeliveryBatch(
					state,
					request.inspectionRequest.batchRequest,
					domain,
				);
				if (result.status !== "matching")
					return {
						state,
						result: {
							status:
								result.status === "member_set_conflict" || result.status === "delivery_not_prepared"
									? "member_set_conflict"
									: result.status === "invalid"
										? "invalid"
										: "conflict",
						} as const,
					};
				const { append, parents } = result.joined;
				if (request.currentDeliveryAuthorities.length !== parents.length)
					return { state, result: { status: "member_set_conflict" } as const };
				for (let index = 0; index < parents.length; index++) {
					const parent = parents[index];
					const authority = request.currentDeliveryAuthorities[index];
					if (!parent || !authority || !exactJson(authority, parent.attempt.request.deliveryAuthority))
						return { state, result: { status: "member_set_conflict" } as const };
					const current = await this.#currentParentRequest(state, parent.attempt.request, this.#now());
					if (current.status !== "current") return { state, result: { status: "authority_lost" } as const };
				}
				const expectedTransitionReceiptSha256 = request.inspectionRequest.expectedTransitionReceiptSha256;
				if (append.batchTransitionReceipt === null) {
					if (
						append.primaryReceipt !== null ||
						parents.some(parent => parent.state !== "not_applied") ||
						append.batchReplayProof === null ||
						append.batchReplayProof.priorTransitionReceipt.receiptSha256 !== expectedTransitionReceiptSha256 ||
						append.batchReplayProof.sessionAppendInspectionSha256 !==
							request.expectedSessionAppendInspectionSha256 ||
						!exactJson(
							append.batchReplayProof.orderedCurrentDeliveryAuthoritySha256s,
							parents.map(parent => parent.attempt.request.deliveryAuthoritySha256),
						)
					)
						return { state, result: { status: "inspection_stale" } as const };
					return {
						state,
						result: {
							status: "already_restored_not_applied",
							replayProof: append.batchReplayProof,
						} as const,
					};
				}
				if (
					append.batchTransitionReceipt.receiptSha256 !== expectedTransitionReceiptSha256 ||
					append.batchTransitionReceipt.coordinatorRequestSha256 !==
						request.inspectionRequest.batchRequest.coordinatorRequestSha256
				)
					return { state, result: { status: "inspection_stale" } as const };
				if (append.primaryReceipt !== null || parents.some(parent => parent.state === "terminal"))
					return { state, result: { status: "entry_not_absent" } as const };
				if (parents.some(parent => parent.state !== "outcome_unknown"))
					return { state, result: { status: "member_set_conflict" } as const };
				const restoredAt = this.#now();
				const proofCore = {
					schemaVersion: 1 as const,
					coordinatorRequestSha256: append.batchTransitionReceipt.coordinatorRequestSha256,
					priorTransitionReceipt: append.batchTransitionReceipt,
					sessionAppendInspectionSha256: request.expectedSessionAppendInspectionSha256,
					orderedCurrentDeliveryAuthoritySha256s: parents.map(
						parent => parent.attempt.request.deliveryAuthoritySha256,
					) as [Sha256Ref, ...Sha256Ref[]],
					restoredAppendAttemptSha256s: append.attempts.map(attempt => attempt.attemptSha256) as [
						Sha256Ref,
						...Sha256Ref[],
					],
					restoredAppendNotAppliedProofSha256s: append.notAppliedProofs.map(proof => proof.proofSha256) as [
						Sha256Ref,
						...Sha256Ref[],
					],
					restoredParentDeliveryAttemptSha256s: append.parentDeliveryAttempts.map(
						attempt => attempt.attemptSha256,
					) as [Sha256Ref, ...Sha256Ref[]],
					restoredAt,
				};
				const replayProof: ConfidentialTransientTaskForegroundAppendDeliveryBatchReplayProofV1 = {
					...proofCore,
					proofSha256: await foregroundBatchReplayProofSha256(proofCore),
				};
				const parentDeliveries = { ...state.parentDeliveries };
				parentDeliveries[foregroundAppendMapKey(append.batch.foregroundAppendBatchKeySha256)] =
					storeForegroundValue({
						...append,
						batchTransitionReceipt: null,
						batchReplayProof: replayProof,
						primaryReceipt: null,
					} satisfies PrivateForegroundAppendRowV1);
				for (const parent of parents) {
					const key = resultTargetKeyFromRecord(parent.attempt.request);
					if (!key) return { state, result: { status: "invalid" } as const };
					parentDeliveries[parentDeliveryMapKey(key)] = {
						state: "not_applied",
						attempt: parent.attempt,
						receipt: null,
					} satisfies PrivateParentDeliveryRowV1;
				}
				return {
					state: { ...state, parentDeliveries },
					result: { status: "restored_not_applied", replayProof } as const,
				};
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
		});
	}

	async prepareHandoff(batch: PrivateForegroundHandoffBatchV1) {
		const domain = foregroundBatchDomain(batch);
		if (!domain) return { status: "invalid" } as const;
		let domainIndex: PrivateForegroundDomainIndexV1 | null = null;
		let sessionIndex: PrivateForegroundSessionIndexV1 | null = null;
		try {
			const domainInput = await this.#durable.inspect(
				TRANSIENT_NAMESPACE,
				foregroundDomainIndexKey(domain.foregroundAppendBatchKeySha256),
			);
			if (domainInput !== null) {
				if (!validForegroundDomainIndex(domainInput)) return { status: "invalid" } as const;
				domainIndex = domainInput;
				if (domainInput.parentSessionId !== domain.parentSessionId) return { status: "route_conflict" } as const;
				if (domainInput.parentSessionGenerationSha256 !== domain.parentSessionGenerationSha256)
					return { status: "session_generation_replaced" } as const;
				if (domainInput.taskId !== domain.taskId || domainInput.runId !== domain.runId)
					return { status: "route_conflict" } as const;
			}
			const sessionInput = await this.#durable.inspect(
				TRANSIENT_NAMESPACE,
				foregroundSessionIndexKey(domain.parentSessionId),
			);
			if (sessionInput !== null) {
				if (!validForegroundSessionIndex(sessionInput, domain.parentSessionId))
					return { status: "invalid" } as const;
				sessionIndex = sessionInput;
				const prior = sessionInput.locators.find(
					locator => locator.foregroundAppendBatchKeySha256 === domain.foregroundAppendBatchKeySha256,
				);
				if (prior && prior.parentSessionGenerationSha256 !== domain.parentSessionGenerationSha256)
					return { status: "session_generation_replaced" } as const;
			}
		} catch {
			return { status: "invalid" } as const;
		}
		const taskKey = { taskId: domain.taskId, runId: domain.runId };
		const prepared = await this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
			let state: TransientTaskRuntimeStateV1;
			try {
				state = transientRuntimeState(taskKey, currentInput);
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
			let prior: PrivateForegroundBatchRowV1 | null;
			try {
				prior = this.#foregroundBatchRow(state, domain.foregroundAppendBatchKeySha256);
			} catch {
				return { state, result: { status: "invalid" } as const };
			}
			if (prior) {
				if (exactJson(storeForegroundValue(prior.batch), storeForegroundValue(batch)))
					return {
						state,
						result: {
							status: "already_prepared",
							handoffBatchSha256: batch.handoffBatchSha256,
							orderedPreReturnIdentities: batch.orderedPreReturnIdentities,
							orderedPreReturnIdentitySha256s: batch.orderedPreReturnIdentitySha256s,
						} as const,
					};
				const priorDomain = foregroundBatchDomain(prior.batch);
				if (!priorDomain) return { state, result: { status: "invalid" } as const };
				if (priorDomain.parentSessionGenerationSha256 !== domain.parentSessionGenerationSha256)
					return { state, result: { status: "session_generation_replaced" } as const };
				if (priorDomain.parentBranchGenerationSha256 !== domain.parentBranchGenerationSha256)
					return { state, result: { status: "branch_generation_replaced" } as const };
				return { state, result: { status: "result_conflict" } as const };
			}
			const parentDeliveries = { ...state.parentDeliveries };
			for (let index = 0; index < batch.handoffs.length; index++) {
				const identity = batch.orderedPreReturnIdentities[index];
				const memberKey = foregroundMemberMapKey(identity.core);
				const memberInput = parentDeliveries[memberKey];
				if (memberInput !== undefined) {
					try {
						const member = loadForegroundValue<PrivateForegroundMemberRowV1>(memberInput);
						if (
							!strictRecord(member, ["kind", "foregroundAppendBatchKeySha256", "memberIndex"]) ||
							member.kind !== "foreground_member" ||
							member.foregroundAppendBatchKeySha256 !== domain.foregroundAppendBatchKeySha256 ||
							member.memberIndex !== index
						)
							return { state, result: { status: "route_conflict" } as const };
					} catch {
						return { state, result: { status: "invalid" } as const };
					}
				}
				parentDeliveries[memberKey] = storeForegroundValue({
					kind: "foreground_member",
					foregroundAppendBatchKeySha256: domain.foregroundAppendBatchKeySha256,
					memberIndex: index,
				} satisfies PrivateForegroundMemberRowV1);
			}
			parentDeliveries[foregroundBatchMapKey(domain.foregroundAppendBatchKeySha256)] = storeForegroundValue({
				kind: "foreground_batch",
				batch,
			} satisfies PrivateForegroundBatchRowV1);
			return {
				state: { ...state, parentDeliveries },
				result: {
					status: "prepared",
					handoffBatchSha256: batch.handoffBatchSha256,
					orderedPreReturnIdentities: batch.orderedPreReturnIdentities,
					orderedPreReturnIdentitySha256s: batch.orderedPreReturnIdentitySha256s,
				} as const,
			};
		});
		if (prepared.status !== "prepared" && prepared.status !== "already_prepared") return prepared;
		const nextDomainIndex: PrivateForegroundDomainIndexV1 = {
			schemaVersion: 1,
			foregroundAppendBatchKeySha256: domain.foregroundAppendBatchKeySha256,
			taskId: domain.taskId,
			runId: domain.runId,
			parentSessionId: domain.parentSessionId,
			parentSessionGenerationSha256: domain.parentSessionGenerationSha256,
		};
		const indexed = await this.#durable.transact(
			TRANSIENT_NAMESPACE,
			foregroundDomainIndexKey(domain.foregroundAppendBatchKeySha256),
			currentInput => {
				if (currentInput === null) return { state: nextDomainIndex, result: true };
				return {
					state: currentInput,
					result: validForegroundDomainIndex(currentInput) && exactJson(currentInput, nextDomainIndex),
				};
			},
		);
		if (!indexed) return { status: domainIndex ? "route_conflict" : "invalid" } as const;
		const locator: PrivateForegroundSessionLocatorV1 = {
			foregroundAppendBatchKeySha256: domain.foregroundAppendBatchKeySha256,
			taskId: domain.taskId,
			runId: domain.runId,
			parentSessionGenerationSha256: domain.parentSessionGenerationSha256,
		};
		const sessionIndexed = await this.#durable.transact(
			TRANSIENT_NAMESPACE,
			foregroundSessionIndexKey(domain.parentSessionId),
			currentInput => {
				if (currentInput === null)
					return {
						state: { schemaVersion: 1, parentSessionId: domain.parentSessionId, locators: [locator] },
						result: true,
					};
				if (!validForegroundSessionIndex(currentInput, domain.parentSessionId))
					return { state: currentInput, result: false };
				const prior = currentInput.locators.find(
					candidate => candidate.foregroundAppendBatchKeySha256 === domain.foregroundAppendBatchKeySha256,
				);
				if (prior) return { state: currentInput, result: exactJson(prior, locator) };
				return { state: { ...currentInput, locators: [...currentInput.locators, locator] }, result: true };
			},
		);
		if (!sessionIndexed) return { status: sessionIndex ? "session_generation_replaced" : "invalid" } as const;
		return prepared;
	}

	async appendPreOverlayGate(gate: PrivateForegroundPreOverlayGateV1) {
		try {
			encodeForegroundTaggedValue(gate);
		} catch {
			return { status: "invalid" } as const;
		}
		if (
			!strictRecord(gate, [
				"schemaVersion",
				"handoffBatch",
				"foregroundAppendBatchKeySha256",
				"rawAgentToolResult",
				"rawSourceResultSnapshot",
				"rawAgentToolResultWire",
				"rawAgentToolResultUtf8",
				"rawAgentToolResultUtf8Sha256",
				"rawAgentToolResultUtf8ByteLength",
				"overlaySnapshot",
				"pendingOverlaySnapshot",
				"pendingOverlayBinding",
				"armedAt",
				"preOverlayGateSha256",
			]) ||
			gate.schemaVersion !== 1 ||
			!validResultStoreSha256Ref(gate.foregroundAppendBatchKeySha256) ||
			!validResultStoreSha256Ref(gate.rawAgentToolResultUtf8Sha256) ||
			!validResultStoreInteger(gate.rawAgentToolResultUtf8ByteLength) ||
			typeof gate.rawAgentToolResultUtf8 !== "string" ||
			foregroundUtf8Sha256(gate.rawAgentToolResultUtf8) !== gate.rawAgentToolResultUtf8Sha256 ||
			Buffer.byteLength(gate.rawAgentToolResultUtf8, "utf8") !== gate.rawAgentToolResultUtf8ByteLength ||
			!validResultStoreIso8601(gate.armedAt) ||
			!validResultStoreSha256Ref(gate.preOverlayGateSha256)
		)
			return { status: "invalid" } as const;
		const located = await this.#foregroundState(gate.foregroundAppendBatchKeySha256).catch(() => undefined);
		if (located === undefined) return { status: "invalid" } as const;
		if (!located) return { status: "branch_anchor_missing" } as const;
		const firstHandoff = located.batchRow.batch.handoffs[0];
		if (
			!exactJson(storeForegroundValue(gate.handoffBatch), storeForegroundValue(located.batchRow.batch)) ||
			!exactJson(
				storeForegroundValue(gate.rawAgentToolResult),
				storeForegroundValue(firstHandoff.returnedAgentToolResult),
			) ||
			!exactJson(
				storeForegroundValue(gate.rawSourceResultSnapshot),
				storeForegroundValue(firstHandoff.returnedSourceResultSnapshot),
			) ||
			!exactJson(
				storeForegroundValue(gate.rawAgentToolResultWire),
				storeForegroundValue(firstHandoff.returnedAgentToolResultWire),
			) ||
			gate.rawAgentToolResultUtf8 !== firstHandoff.returnedAgentToolResultUtf8 ||
			!exactJson(
				storeForegroundValue(gate.pendingOverlayBinding),
				storeForegroundValue(located.batchRow.batch.pendingOverlayBinding),
			) ||
			!strictRecord(gate.overlaySnapshot, [
				"schemaVersion",
				"toolCallId",
				"mode",
				"orderedRuleInputs",
				"ttsrToolReminderTemplateSha256",
				"renderedReminderUtf8",
				"renderedReminderUtf8Sha256",
				"renderedReminderUtf8ByteLength",
				"injectedRuleNames",
				"snapshotSha256",
			]) ||
			gate.overlaySnapshot.schemaVersion !== 1 ||
			gate.overlaySnapshot.toolCallId !== located.batchRow.batch.toolCallId ||
			!validResultStoreSha256Ref(gate.overlaySnapshot.snapshotSha256)
		)
			return { status: "gate_conflict" } as const;
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(located.taskKey), currentInput => {
			let state: TransientTaskRuntimeStateV1;
			try {
				state = transientRuntimeState(located.taskKey, currentInput);
				const batchRow = this.#foregroundBatchRow(state, gate.foregroundAppendBatchKeySha256);
				if (!batchRow || !exactJson(storeForegroundValue(batchRow.batch), storeForegroundValue(gate.handoffBatch)))
					return { state, result: { status: "gate_conflict" } as const };
				const prior = this.#foregroundGateRow(state, gate.foregroundAppendBatchKeySha256);
				if (prior) {
					return exactJson(storeForegroundValue(prior.preOverlayGate), storeForegroundValue(gate))
						? { state, result: { status: "already_appended", gateSha256: gate.preOverlayGateSha256 } as const }
						: { state, result: { status: "gate_conflict" } as const };
				}
				const row: PrivateForegroundGateRowV1 = {
					kind: "foreground_gate",
					preOverlayGate: gate,
					renderedGate: null,
					renderedResult: null,
					suspension: null,
					lastInspectionSha256: null,
					overlayCommitReceipt: null,
				};
				return {
					state: {
						...state,
						parentDeliveries: {
							...state.parentDeliveries,
							[foregroundGateMapKey(gate.foregroundAppendBatchKeySha256)]: storeForegroundValue(row),
						},
					},
					result: { status: "appended", gateSha256: gate.preOverlayGateSha256 } as const,
				};
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
		});
	}

	async appendRenderedGate(gate: PrivateForegroundRenderedGateV1) {
		try {
			encodeForegroundTaggedValue(gate);
		} catch {
			return { status: "invalid" } as const;
		}
		if (
			!strictRecord(gate, [
				"schemaVersion",
				"preOverlayGateSha256",
				"foregroundAppendBatchKeySha256",
				"overlaySnapshotSha256",
				"renderedResult",
				"ttsrInjectionContentPlan",
				"appendedAt",
				"renderedGateSha256",
			]) ||
			gate.schemaVersion !== 1 ||
			!validResultStoreSha256Ref(gate.preOverlayGateSha256) ||
			!validResultStoreSha256Ref(gate.foregroundAppendBatchKeySha256) ||
			!validResultStoreSha256Ref(gate.overlaySnapshotSha256) ||
			!validResultStoreIso8601(gate.appendedAt) ||
			!validResultStoreSha256Ref(gate.renderedGateSha256)
		)
			return { status: "invalid" } as const;
		const located = await this.#foregroundState(gate.foregroundAppendBatchKeySha256).catch(() => undefined);
		if (located === undefined) return { status: "invalid" } as const;
		if (!located) return { status: "branch_anchor_missing" } as const;
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(located.taskKey), currentInput => {
			let state: TransientTaskRuntimeStateV1;
			try {
				state = transientRuntimeState(located.taskKey, currentInput);
				const batchRow = this.#foregroundBatchRow(state, gate.foregroundAppendBatchKeySha256);
				const prior = this.#foregroundGateRow(state, gate.foregroundAppendBatchKeySha256);
				if (!batchRow || !prior) return { state, result: { status: "branch_anchor_missing" } as const };
				if (
					gate.preOverlayGateSha256 !== prior.preOverlayGate.preOverlayGateSha256 ||
					gate.overlaySnapshotSha256 !== prior.preOverlayGate.overlaySnapshot.snapshotSha256 ||
					gate.renderedResult.foregroundAppendBatchKeySha256 !== gate.foregroundAppendBatchKeySha256 ||
					gate.renderedResult.handoffBatchSha256 !== batchRow.batch.handoffBatchSha256 ||
					gate.renderedResult.preOverlayGateSha256 !== gate.preOverlayGateSha256 ||
					gate.renderedResult.ttsrOverlaySnapshotSha256 !== gate.overlaySnapshotSha256
				)
					return { state, result: { status: "gate_conflict" } as const };
				if (prior.renderedGate) {
					return exactJson(storeForegroundValue(prior.renderedGate), storeForegroundValue(gate))
						? { state, result: { status: "already_appended", gateSha256: gate.renderedGateSha256 } as const }
						: { state, result: { status: "gate_conflict" } as const };
				}
				const row: PrivateForegroundGateRowV1 = { ...prior, renderedGate: gate };
				return {
					state: {
						...state,
						parentDeliveries: {
							...state.parentDeliveries,
							[foregroundGateMapKey(gate.foregroundAppendBatchKeySha256)]: storeForegroundValue(row),
						},
					},
					result: { status: "appended", gateSha256: gate.renderedGateSha256 } as const,
				};
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
		});
	}

	async inspectAfterToolCallGate(request: PrivateForegroundGateInspectRequestV1) {
		if (
			!strictRecord(request, [
				"parentSessionId",
				"parentSessionGenerationSha256",
				"foregroundAppendBatchKeySha256",
				"expectedPreOverlayGateSha256",
				"requestedAt",
				"requestSha256",
			]) ||
			!validResultStoreIdentity(request.parentSessionId) ||
			!validResultStoreSha256Ref(request.parentSessionGenerationSha256) ||
			!validResultStoreSha256Ref(request.foregroundAppendBatchKeySha256) ||
			!validResultStoreSha256Ref(request.expectedPreOverlayGateSha256) ||
			!validResultStoreIso8601(request.requestedAt) ||
			!validResultStoreSha256Hex(request.requestSha256)
		)
			return { status: "invalid" } as const;
		const located = await this.#foregroundState(request.foregroundAppendBatchKeySha256).catch(() => undefined);
		if (located === undefined) return { status: "invalid" } as const;
		if (!located) return { status: "absent" } as const;
		if (located.domain.parentSessionId !== request.parentSessionId) return { status: "gate_conflict" } as const;
		if (located.domain.parentSessionGenerationSha256 !== request.parentSessionGenerationSha256)
			return { status: "session_generation_replaced" } as const;
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(located.taskKey), async currentInput => {
			let state: TransientTaskRuntimeStateV1;
			try {
				state = transientRuntimeState(located.taskKey, currentInput);
				const row = this.#foregroundGateRow(state, request.foregroundAppendBatchKeySha256);
				if (!row) return { state, result: { status: "absent" } as const };
				if (row.preOverlayGate.preOverlayGateSha256 !== request.expectedPreOverlayGateSha256)
					return { state, result: { status: "gate_conflict" } as const };
				const inspectionSha256 = await tupleRef([
					"omp-transient-task-foreground-after-tool-call-gate-inspection-v1",
					1,
					request.requestSha256,
					row.preOverlayGate.preOverlayGateSha256,
					row.renderedGate?.renderedGateSha256 ?? null,
					row.overlayCommitReceipt?.receiptSha256 ?? null,
				]);
				const next = { ...row, lastInspectionSha256: inspectionSha256 } satisfies PrivateForegroundGateRowV1;
				return {
					state: {
						...state,
						parentDeliveries: {
							...state.parentDeliveries,
							[foregroundGateMapKey(request.foregroundAppendBatchKeySha256)]: storeForegroundValue(next),
						},
					},
					result: {
						status: "matching",
						preOverlayGate: row.preOverlayGate,
						renderedGate: row.renderedGate,
						overlayCommitReceipt: row.overlayCommitReceipt,
						inspectionSha256,
					} as const,
				};
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
		});
	}

	async #foregroundSuspension(
		row: PrivateForegroundGateRowV1,
		rendered: PrivateForegroundRenderedResultV1,
		reason: PrivateForegroundSuspensionV1["reason"],
	) {
		const projection = {
			schemaVersion: 1,
			state: "after_tool_call_suspended",
			foregroundAppendBatchKeySha256: rendered.foregroundAppendBatchKeySha256,
			handoffBatchSha256: rendered.handoffBatchSha256,
			preOverlayGateSha256: rendered.preOverlayGateSha256,
			renderedGateSha256: row.renderedGate?.renderedGateSha256 ?? null,
			renderedResultSha256: rendered.renderedResultSha256,
			reason,
		} as const;
		const suspendedAt = this.#now();
		const suspension: PrivateForegroundSuspensionV1 = {
			schemaVersion: 1,
			projection,
			preOverlayGate: row.preOverlayGate,
			renderedGate: row.renderedGate,
			overlayCommitReceipt: row.overlayCommitReceipt,
			reason,
			suspendedAt,
			suspensionSha256: foregroundTupleRef([
				"omp-transient-task-foreground-settlement-v1",
				"render-suspension-core",
				1,
				projection,
				row.preOverlayGate,
				row.renderedGate,
				row.overlayCommitReceipt,
				reason,
				suspendedAt,
			]),
		};
		return { suspension, projection };
	}

	async prepareRenderedResult(rendered: PrivateForegroundRenderedResultV1) {
		try {
			encodeForegroundTaggedValue(rendered);
		} catch {
			throw new TypeError("Invalid foreground rendered result");
		}
		if (
			!strictRecord(rendered, [
				"schemaVersion",
				"handoffBatchSha256",
				"foregroundAppendBatchKeySha256",
				"preOverlayGateSha256",
				"ttsrOverlaySnapshotSha256",
				"renderedSourceAgentToolResult",
				"renderedSourceResultSnapshot",
				"renderedAgentToolResultWire",
				"renderedAgentToolResultUtf8",
				"renderedAgentToolResultUtf8Sha256",
				"renderedAgentToolResultUtf8ByteLength",
				"preparedAfterToolCallAt",
				"renderedResultSha256",
			]) ||
			rendered.schemaVersion !== 1 ||
			!validResultStoreSha256Ref(rendered.handoffBatchSha256) ||
			!validResultStoreSha256Ref(rendered.foregroundAppendBatchKeySha256) ||
			!validResultStoreSha256Ref(rendered.preOverlayGateSha256) ||
			!validResultStoreSha256Ref(rendered.ttsrOverlaySnapshotSha256) ||
			typeof rendered.renderedAgentToolResultUtf8 !== "string" ||
			!validResultStoreSha256Ref(rendered.renderedAgentToolResultUtf8Sha256) ||
			foregroundUtf8Sha256(rendered.renderedAgentToolResultUtf8) !== rendered.renderedAgentToolResultUtf8Sha256 ||
			Buffer.byteLength(rendered.renderedAgentToolResultUtf8, "utf8") !==
				rendered.renderedAgentToolResultUtf8ByteLength ||
			!validResultStoreInteger(rendered.renderedAgentToolResultUtf8ByteLength) ||
			!validResultStoreIso8601(rendered.preparedAfterToolCallAt) ||
			!validResultStoreSha256Ref(rendered.renderedResultSha256)
		)
			throw new TypeError("Invalid foreground rendered result");
		const located = await this.#foregroundState(rendered.foregroundAppendBatchKeySha256).catch(() => null);
		if (!located || located.batchRow.batch.handoffBatchSha256 !== rendered.handoffBatchSha256)
			throw new Error("Foreground handoff is unavailable");
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(located.taskKey), async currentInput => {
			let state: TransientTaskRuntimeStateV1;
			try {
				state = transientRuntimeState(located.taskKey, currentInput);
				const row = this.#foregroundGateRow(state, rendered.foregroundAppendBatchKeySha256);
				if (!row || row.preOverlayGate.preOverlayGateSha256 !== rendered.preOverlayGateSha256)
					throw new Error("Foreground pre-overlay gate is unavailable");
				if (row.renderedResult) {
					if (exactJson(storeForegroundValue(row.renderedResult), storeForegroundValue(rendered)))
						return {
							state,
							result: {
								status: "already_prepared",
								renderedResultSha256: rendered.renderedResultSha256,
							} as const,
						};
					const { suspension, projection } = await this.#foregroundSuspension(row, rendered, "result_conflict");
					const next = { ...row, suspension } satisfies PrivateForegroundGateRowV1;
					return {
						state: {
							...state,
							parentDeliveries: {
								...state.parentDeliveries,
								[foregroundGateMapKey(rendered.foregroundAppendBatchKeySha256)]: storeForegroundValue(next),
							},
						},
						result: { status: "suspended", suspension, projection } as const,
					};
				}
				if (
					row.preOverlayGate.overlaySnapshot.snapshotSha256 !== rendered.ttsrOverlaySnapshotSha256 ||
					!row.renderedGate ||
					!exactJson(storeForegroundValue(row.renderedGate.renderedResult), storeForegroundValue(rendered))
				) {
					const reason = row.renderedGate ? "result_conflict" : "rendered_gate_unavailable";
					const { suspension, projection } = await this.#foregroundSuspension(row, rendered, reason);
					const next = { ...row, suspension } satisfies PrivateForegroundGateRowV1;
					return {
						state: {
							...state,
							parentDeliveries: {
								...state.parentDeliveries,
								[foregroundGateMapKey(rendered.foregroundAppendBatchKeySha256)]: storeForegroundValue(next),
							},
						},
						result: { status: "suspended", suspension, projection } as const,
					};
				}
				const next = { ...row, renderedResult: rendered, suspension: null } satisfies PrivateForegroundGateRowV1;
				return {
					state: {
						...state,
						parentDeliveries: {
							...state.parentDeliveries,
							[foregroundGateMapKey(rendered.foregroundAppendBatchKeySha256)]: storeForegroundValue(next),
						},
					},
					result: { status: "prepared", renderedResultSha256: rendered.renderedResultSha256 } as const,
				};
			} catch (error) {
				throw error instanceof Error ? error : new Error("Foreground rendered result storage failed");
			}
		});
	}

	async resumeRenderedResult(request: PrivateForegroundRenderedResumeRequestV1) {
		try {
			encodeForegroundTaggedValue(request);
		} catch {
			throw new TypeError("Invalid foreground rendered resume request");
		}
		if (
			!strictRecord(request, ["suspension", "expectedInspectionSha256", "requestedAt", "requestSha256"]) ||
			(request.expectedInspectionSha256 !== null && !validResultStoreSha256Ref(request.expectedInspectionSha256)) ||
			!validResultStoreIso8601(request.requestedAt) ||
			!validResultStoreSha256Hex(request.requestSha256) ||
			!strictRecord(request.suspension, [
				"schemaVersion",
				"projection",
				"preOverlayGate",
				"renderedGate",
				"overlayCommitReceipt",
				"reason",
				"suspendedAt",
				"suspensionSha256",
			]) ||
			request.suspension.schemaVersion !== 1 ||
			!validResultStoreSha256Ref(request.suspension.suspensionSha256)
		)
			return {
				status: "still_suspended",
				suspension: request.suspension,
				projection: request.suspension.projection,
			} as const;
		const located = await this.#foregroundState(request.suspension.projection.foregroundAppendBatchKeySha256).catch(
			() => null,
		);
		if (!located)
			return {
				status: "still_suspended",
				suspension: request.suspension,
				projection: request.suspension.projection,
			} as const;
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(located.taskKey), currentInput => {
			let state: TransientTaskRuntimeStateV1;
			try {
				state = transientRuntimeState(located.taskKey, currentInput);
				const row = this.#foregroundGateRow(state, request.suspension.projection.foregroundAppendBatchKeySha256);
				if (
					!row?.suspension ||
					!exactJson(storeForegroundValue(row.suspension), storeForegroundValue(request.suspension)) ||
					(request.expectedInspectionSha256 !== null &&
						row.lastInspectionSha256 !== request.expectedInspectionSha256) ||
					!row.renderedGate
				)
					return {
						state,
						result: {
							status: "still_suspended",
							suspension: row?.suspension ?? request.suspension,
							projection: (row?.suspension ?? request.suspension).projection,
						} as const,
					};
				const renderedResult = row.renderedGate.renderedResult;
				const next = { ...row, renderedResult, suspension: null } satisfies PrivateForegroundGateRowV1;
				return {
					state: {
						...state,
						parentDeliveries: {
							...state.parentDeliveries,
							[foregroundGateMapKey(renderedResult.foregroundAppendBatchKeySha256)]: storeForegroundValue(next),
						},
					},
					result: {
						status: "adopted_prepared",
						renderedResult,
						injectionContentPlan: row.renderedGate.ttsrInjectionContentPlan,
					} as const,
				};
			} catch {
				return {
					state: currentInput,
					result: {
						status: "still_suspended",
						suspension: request.suspension,
						projection: request.suspension.projection,
					} as const,
				};
			}
		});
	}

	async prepareAppend(request: PrivateForegroundAppendPrepareRequestV1) {
		try {
			encodeForegroundTaggedValue(request);
		} catch {
			return { status: "invalid" } as const;
		}
		if (
			!strictRecord(request, ["batch", "attempts"]) ||
			!strictArray(request.attempts) ||
			request.attempts.length === 0 ||
			!strictRecord(request.batch, [
				"schemaVersion",
				"handoffBatch",
				"renderedResult",
				"foregroundAppendBatchKeySha256",
				"injectionAppendRequest",
				"entry",
				"requests",
				"appendBatchSha256",
			]) ||
			request.batch.schemaVersion !== 1 ||
			!strictArray(request.batch.requests) ||
			request.batch.requests.length === 0 ||
			request.batch.requests.length !== request.attempts.length ||
			!validResultStoreSha256Ref(request.batch.foregroundAppendBatchKeySha256) ||
			!validResultStoreSha256Ref(request.batch.appendBatchSha256)
		)
			return { status: "invalid" } as const;
		const located = await this.#foregroundState(request.batch.foregroundAppendBatchKeySha256).catch(() => undefined);
		if (located === undefined) return { status: "invalid" } as const;
		if (!located) return { status: "handoff_missing" } as const;
		if (
			!exactJson(storeForegroundValue(request.batch.handoffBatch), storeForegroundValue(located.batchRow.batch)) ||
			request.batch.handoffBatch.handoffBatchSha256 !== request.batch.renderedResult.handoffBatchSha256
		)
			return { status: "conflict" } as const;
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(located.taskKey), async currentInput => {
			let state: TransientTaskRuntimeStateV1;
			try {
				state = transientRuntimeState(located.taskKey, currentInput);
				const batchRow = this.#foregroundBatchRow(state, request.batch.foregroundAppendBatchKeySha256);
				if (!batchRow) return { state, result: { status: "handoff_missing" } as const };
				const gateRow = this.#foregroundGateRow(state, request.batch.foregroundAppendBatchKeySha256);
				if (!gateRow?.renderedGate || !gateRow.renderedResult)
					return { state, result: { status: "rendered_result_missing" } as const };
				if (
					!exactJson(storeForegroundValue(batchRow.batch), storeForegroundValue(request.batch.handoffBatch)) ||
					!exactJson(
						storeForegroundValue(gateRow.renderedResult),
						storeForegroundValue(request.batch.renderedResult),
					) ||
					request.batch.renderedResult.renderedResultSha256 !==
						gateRow.renderedGate.renderedResult.renderedResultSha256 ||
					request.batch.entry.id !== batchRow.batch.toolResultEntryId ||
					request.batch.entry.sessionEntryJsonlUtf8Sha256 !==
						foregroundUtf8Sha256(request.batch.entry.sessionEntryJsonlUtf8) ||
					request.batch.entry.sessionEntryJsonlUtf8ByteLength !==
						Buffer.byteLength(request.batch.entry.sessionEntryJsonlUtf8, "utf8")
				)
					return { state, result: { status: "conflict" } as const };
				const prior = this.#foregroundAppendRow(state, request.batch.foregroundAppendBatchKeySha256);
				if (prior) {
					return exactJson(
						storeForegroundValue({ batch: prior.batch, attempts: prior.attempts }),
						storeForegroundValue(request),
					)
						? {
								state,
								result: {
									status: "already_prepared",
									appendBatchSha256: prior.batch.appendBatchSha256,
									appendAttemptSha256s: prior.attempts.map(attempt => attempt.attemptSha256) as [
										Sha256Ref,
										...Sha256Ref[],
									],
									notAppliedProofSha256s: prior.notAppliedProofs.map(proof => proof.proofSha256) as [
										Sha256Ref,
										...Sha256Ref[],
									],
								} as const,
							}
						: { state, result: { status: "conflict" } as const };
				}
				const parentDeliveryAttempts: ConfidentialTransientTaskParentResultDeliveryAttemptV1[] = [];
				const notAppliedProofs: PrivateForegroundNotAppliedProofV1[] = [];
				const storedAt = this.#now();
				for (let index = 0; index < request.attempts.length; index++) {
					const attempt = request.attempts[index];
					const appendRequest = request.batch.requests[index];
					const handoff = batchRow.batch.handoffs[index];
					const preReturnIdentity = batchRow.batch.orderedPreReturnIdentities[index];
					if (
						!strictRecord(attempt, ["schemaVersion", "state", "request", "preparedAt", "attemptSha256"]) ||
						attempt.schemaVersion !== 1 ||
						attempt.state !== "not_applied" ||
						!validResultStoreIso8601(attempt.preparedAt) ||
						!validResultStoreSha256Ref(attempt.attemptSha256) ||
						!exactJson(storeForegroundValue(attempt.request), storeForegroundValue(appendRequest)) ||
						!exactJson(
							storeForegroundValue(appendRequest.preReturnIdentity),
							storeForegroundValue(preReturnIdentity),
						) ||
						appendRequest.handoffSha256 !== handoff.handoffSha256 ||
						appendRequest.handoffBatchSha256 !== batchRow.batch.handoffBatchSha256 ||
						appendRequest.foregroundAppendBatchKeySha256 !== batchRow.batch.foregroundAppendBatchKeySha256 ||
						appendRequest.renderedResultSha256 !== gateRow.renderedResult.renderedResultSha256 ||
						appendRequest.identity.core.preReturnIdentitySha256 !== preReturnIdentity.preReturnIdentitySha256 ||
						appendRequest.identity.core.sinkProjection.core.renderedResultSha256 !==
							gateRow.renderedResult.renderedResultSha256 ||
						appendRequest.identity.core.sinkProjection.core.sinkResultUtf8 !==
							gateRow.renderedResult.renderedAgentToolResultUtf8 ||
						!exactJson(
							storeForegroundValue(appendRequest.identity.core.deliveryAuthority),
							storeForegroundValue(appendRequest.deliveryAuthority),
						) ||
						!exactJson(storeForegroundValue(appendRequest.entry), storeForegroundValue(request.batch.entry)) ||
						foregroundUtf8Sha256(appendRequest.toolResultMessageUtf8) !==
							appendRequest.toolResultMessageUtf8Sha256 ||
						Buffer.byteLength(appendRequest.toolResultMessageUtf8, "utf8") !==
							appendRequest.toolResultMessageUtf8ByteLength
					)
						return { state, result: { status: "conflict" } as const };
					const key = resultTargetKeyFromRecord(preReturnIdentity.core);
					if (!key) return { state, result: { status: "invalid" } as const };
					const parent = await parentDeliveryRow(state.parentDeliveries[parentDeliveryMapKey(key)]);
					if (!parent) return { state, result: { status: "authority_lost" } as const };
					if (
						parent.state !== "not_applied" ||
						parent.attempt.request.route.kind !== "foreground_tool_call" ||
						parent.attempt.request.deliveryOperationId !== preReturnIdentity.core.deliveryOperationId ||
						parent.attempt.request.deliveryRequestSha256 !== appendRequest.identity.core.deliveryRequestSha256 ||
						parent.attempt.request.deliveryAuthoritySha256 !==
							appendRequest.identity.core.deliveryAuthoritySha256 ||
						!exactJson(
							storeForegroundValue(parent.attempt.request.deliveryAuthority),
							storeForegroundValue(appendRequest.deliveryAuthority),
						) ||
						!exactJson(
							storeForegroundValue(parent.attempt.request.sinkProjection),
							storeForegroundValue(appendRequest.identity.core.sinkProjection),
						)
					)
						return { state, result: { status: "conflict" } as const };
					const authority = await this.#currentParentRequest(state, parent.attempt.request, storedAt);
					if (authority.status !== "current")
						return {
							state,
							result: {
								status: authority.status === "stale_live_receipt" ? "append_parent_stale" : "authority_lost",
							} as const,
						};
					const proofCore = {
						schemaVersion: 1,
						settlementIdentitySha256: appendRequest.identity.identitySha256,
						preReturnIdentitySha256: preReturnIdentity.preReturnIdentitySha256,
						appendOperationId: preReturnIdentity.core.appendOperationId,
						appendBatchSha256: request.batch.appendBatchSha256,
						foregroundAppendBatchKeySha256: request.batch.foregroundAppendBatchKeySha256,
						appendRequestSha256: appendRequest.appendRequestSha256,
						appendAttemptSha256: attempt.attemptSha256,
						parentSessionGenerationSha256: preReturnIdentity.core.parentSessionGenerationSha256,
						parentBranchGenerationSha256: preReturnIdentity.core.parentBranchGenerationSha256,
						appendParentEntryId: appendRequest.entry.parentId,
						toolResultEntryId: appendRequest.entry.id,
						sessionEntryJsonlUtf8Sha256: appendRequest.entry.sessionEntryJsonlUtf8Sha256,
						sessionEntryJsonlUtf8ByteLength: appendRequest.entry.sessionEntryJsonlUtf8ByteLength,
						toolResultMessageUtf8Sha256: appendRequest.toolResultMessageUtf8Sha256,
						toolResultMessageUtf8ByteLength: appendRequest.toolResultMessageUtf8ByteLength,
						deliveryAuthoritySha256: appendRequest.identity.core.deliveryAuthoritySha256,
						storedAt,
					} as const;
					notAppliedProofs.push({
						...proofCore,
						proofSha256: foregroundTupleRef([
							"omp-transient-task-foreground-settlement-v1",
							"not-applied-core",
							1,
							proofCore.settlementIdentitySha256,
							proofCore.preReturnIdentitySha256,
							proofCore.appendOperationId,
							proofCore.foregroundAppendBatchKeySha256,
							proofCore.appendBatchSha256,
							proofCore.appendRequestSha256,
							proofCore.appendAttemptSha256,
							proofCore.parentSessionGenerationSha256,
							proofCore.parentBranchGenerationSha256,
							proofCore.appendParentEntryId,
							proofCore.toolResultEntryId,
							proofCore.sessionEntryJsonlUtf8Sha256,
							proofCore.sessionEntryJsonlUtf8ByteLength,
							proofCore.toolResultMessageUtf8Sha256,
							proofCore.toolResultMessageUtf8ByteLength,
							proofCore.deliveryAuthoritySha256,
							proofCore.storedAt,
						]),
					});
					parentDeliveryAttempts.push(parent.attempt);
				}
				const row: PrivateForegroundAppendRowV1 = {
					kind: "foreground_append",
					batch: request.batch,
					attempts: request.attempts,
					notAppliedProofs,
					parentDeliveryAttempts,
					batchTransitionReceipt: null,
					batchReplayProof: null,
					primaryReceipt: null,
				};
				return {
					state: {
						...state,
						parentDeliveries: {
							...state.parentDeliveries,
							[foregroundAppendMapKey(request.batch.foregroundAppendBatchKeySha256)]: storeForegroundValue(row),
						},
					},
					result: {
						status: "prepared",
						appendBatchSha256: request.batch.appendBatchSha256,
						appendAttemptSha256s: request.attempts.map(attempt => attempt.attemptSha256) as [
							Sha256Ref,
							...Sha256Ref[],
						],
						notAppliedProofSha256s: notAppliedProofs.map(proof => proof.proofSha256) as [
							Sha256Ref,
							...Sha256Ref[],
						],
					} as const,
				};
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
		});
	}

	async #foregroundSettlement(
		state: TransientTaskRuntimeStateV1,
		batchRow: PrivateForegroundBatchRowV1,
		memberIndex: number,
	) {
		const batch = batchRow.batch;
		const handoff = batch.handoffs[memberIndex];
		const preReturnIdentity = batch.orderedPreReturnIdentities[memberIndex];
		if (!handoff || !preReturnIdentity) return null;
		const core = preReturnIdentity.core;
		const base = {
			schemaVersion: 1,
			resultPublicationTargetId: core.resultPublicationTargetId,
			resultPublicationId: core.resultPublicationId,
			deliveryOperationId: core.deliveryOperationId,
			preReturnIdentitySha256: preReturnIdentity.preReturnIdentitySha256,
			appendOperationId: core.appendOperationId,
			foregroundAppendBatchKeySha256: batch.foregroundAppendBatchKeySha256,
			foregroundMemberIndex: core.foregroundMemberIndex,
			foregroundMemberCount: core.foregroundMemberCount,
			returnedAgentToolResultUtf8Sha256: core.returnedAgentToolResultUtf8Sha256,
			returnedAgentToolResultUtf8ByteLength: core.returnedAgentToolResultUtf8ByteLength,
			returnedSourceResultSnapshotSha256: core.returnedSourceResultSnapshotSha256,
			returnedSourceResultSnapshotByteLength: core.returnedSourceResultSnapshotByteLength,
		} as const;
		const gate = this.#foregroundGateRow(state, batch.foregroundAppendBatchKeySha256);
		if (gate?.suspension)
			return {
				...base,
				state: "after_tool_call_suspended",
				settlementIdentitySha256: null,
				handoffSha256: handoff.handoffSha256,
				handoffBatchSha256: batch.handoffBatchSha256,
				preOverlayGateSha256: gate.preOverlayGate.preOverlayGateSha256,
				renderedGateSha256: gate.renderedGate?.renderedGateSha256 ?? null,
				renderedResultSha256: gate.renderedResult?.renderedResultSha256 ?? null,
				suspensionReason: gate.suspension.reason,
				suspensionSha256: gate.suspension.suspensionSha256,
			} as const;
		const append = this.#foregroundAppendRow(state, batch.foregroundAppendBatchKeySha256);
		if (!append)
			return {
				...base,
				state: "handoff_prepared",
				settlementIdentitySha256: null,
				handoffSha256: handoff.handoffSha256,
				handoffBatchSha256: batch.handoffBatchSha256,
			} as const;
		const appendRequest = append.batch.requests[memberIndex];
		const attempt = append.attempts[memberIndex];
		const proof = append.notAppliedProofs[memberIndex];
		const parentAttempt = append.parentDeliveryAttempts[memberIndex];
		if (
			!gate?.renderedGate ||
			!gate.renderedResult ||
			!gate.overlayCommitReceipt ||
			!appendRequest ||
			!attempt ||
			!proof ||
			!parentAttempt
		) {
			const blockCode = "invalid" as const;
			return {
				...base,
				state: "blocked",
				settlementIdentitySha256: appendRequest?.identity.identitySha256 ?? null,
				blockCode,
				blockSha256: await tupleRef([
					"omp-transient-task-foreground-result-settlement-block-v1",
					batch.foregroundAppendBatchKeySha256,
					memberIndex,
					blockCode,
				]),
			} as const;
		}
		const common = {
			...base,
			settlementIdentitySha256: appendRequest.identity.identitySha256,
			handoffSha256: handoff.handoffSha256,
			handoffBatchSha256: batch.handoffBatchSha256,
			renderedResultSha256: gate.renderedResult.renderedResultSha256,
			renderedAgentToolResultUtf8Sha256: gate.renderedResult.renderedAgentToolResultUtf8Sha256,
			renderedAgentToolResultUtf8ByteLength: gate.renderedResult.renderedAgentToolResultUtf8ByteLength,
			preOverlayGateSha256: gate.preOverlayGate.preOverlayGateSha256,
			renderedGateSha256: gate.renderedGate.renderedGateSha256,
			ttsrOverlayCommitReceiptSha256: gate.overlayCommitReceipt.receiptSha256,
			renderedSourceResultSnapshotSha256: gate.renderedResult.renderedSourceResultSnapshot.sourceSnapshotUtf8Sha256,
			appendBatchSha256: append.batch.appendBatchSha256,
			appendAttemptSha256: attempt.attemptSha256,
			notAppliedProofSha256: proof.proofSha256,
			parentDeliveryAttemptSha256: parentAttempt.attemptSha256,
			toolResultMessageUtf8Sha256: appendRequest.toolResultMessageUtf8Sha256,
			toolResultMessageUtf8ByteLength: appendRequest.toolResultMessageUtf8ByteLength,
		} as const;
		if (!append.batchTransitionReceipt)
			return {
				...common,
				state: "append_not_applied",
				priorBatchTransitionReceiptSha256: null,
				batchReplayProofSha256: append.batchReplayProof?.proofSha256 ?? null,
			} as const;
		if (!append.primaryReceipt)
			return {
				...common,
				state: "append_outcome_unknown",
				batchTransitionReceiptSha256: append.batchTransitionReceipt.receiptSha256,
			} as const;
		const key = resultTargetKeyFromRecord(core);
		const parent = key ? await parentDeliveryRow(state.parentDeliveries[parentDeliveryMapKey(key)]) : null;
		if (parent?.state === "terminal" && parent.receipt.outcome === "delivered")
			return {
				...common,
				state: "sink_committed",
				batchTransitionReceiptSha256: append.batchTransitionReceipt.receiptSha256,
				primaryReceiptSha256: append.primaryReceipt.primaryReceiptSha256,
				sinkReceiptSha256: parent.receipt.sinkReceiptSha256,
				parentDeliveryReceiptSha256: parent.receipt.receiptSha256,
				publicationReceiptSha256: null,
				completionEvidenceSha256: null,
			} as const;
		return {
			...common,
			state: "append_outcome_unknown",
			batchTransitionReceiptSha256: append.batchTransitionReceipt.receiptSha256,
		} as const;
	}

	async #inspectForeground(request: PrivateForegroundInspectRequestV1) {
		if (
			!strictRecord(request, [
				"taskId",
				"runId",
				"createId",
				"resultPublicationId",
				"resultPublicationTargetId",
				"resultPublicationTargetCleanupId",
				"deliveryOperationId",
				"preReturnIdentitySha256",
				"expectedSettlementIdentitySha256",
				"returnedAgentToolResultUtf8Sha256",
				"returnedAgentToolResultUtf8ByteLength",
				"foregroundAppendBatchKeySha256",
			]) ||
			!resultTargetKeyFromRecord(request) ||
			!validResultStoreIdentity(request.deliveryOperationId) ||
			!validResultStoreSha256Ref(request.preReturnIdentitySha256) ||
			(request.expectedSettlementIdentitySha256 !== null &&
				!validResultStoreSha256Ref(request.expectedSettlementIdentitySha256)) ||
			!validResultStoreSha256Ref(request.returnedAgentToolResultUtf8Sha256) ||
			!validResultStoreInteger(request.returnedAgentToolResultUtf8ByteLength) ||
			!validResultStoreSha256Ref(request.foregroundAppendBatchKeySha256)
		)
			return { status: "invalid" } as const;
		const taskKey = { taskId: request.taskId, runId: request.runId };
		let state: TransientTaskRuntimeStateV1;
		try {
			state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			const memberInput = state.parentDeliveries[foregroundMemberMapKey(request)];
			if (memberInput === undefined) return { status: "absent" } as const;
			const member = loadForegroundValue<PrivateForegroundMemberRowV1>(memberInput);
			if (
				!strictRecord(member, ["kind", "foregroundAppendBatchKeySha256", "memberIndex"]) ||
				member.kind !== "foreground_member" ||
				member.foregroundAppendBatchKeySha256 !== request.foregroundAppendBatchKeySha256
			)
				return { status: "conflict" } as const;
			const batchRow = this.#foregroundBatchRow(state, request.foregroundAppendBatchKeySha256);
			if (!batchRow) return { status: "conflict" } as const;
			const identity = batchRow.batch.orderedPreReturnIdentities[member.memberIndex];
			if (
				!identity ||
				!resultTargetKeyMatches(identity.core, request) ||
				identity.core.deliveryOperationId !== request.deliveryOperationId ||
				identity.preReturnIdentitySha256 !== request.preReturnIdentitySha256 ||
				identity.core.returnedAgentToolResultUtf8Sha256 !== request.returnedAgentToolResultUtf8Sha256 ||
				identity.core.returnedAgentToolResultUtf8ByteLength !== request.returnedAgentToolResultUtf8ByteLength
			)
				return { status: "conflict" } as const;
			const settlement = await this.#foregroundSettlement(state, batchRow, member.memberIndex);
			if (!settlement || settlement.settlementIdentitySha256 !== request.expectedSettlementIdentitySha256)
				return { status: "conflict" } as const;
			return {
				status: "matching",
				settlement,
				inspectionSha256: foregroundTupleRef([
					"omp-transient-task-foreground-result-settlement-inspection-v1",
					1,
					request,
					settlement,
				]),
			} as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async #adoptForeground(request: PrivateForegroundAdoptRequestV1) {
		try {
			encodeForegroundTaggedValue(request);
		} catch {
			return { status: "invalid" } as const;
		}
		if (
			!strictRecord(request, [
				"taskId",
				"runId",
				"createId",
				"resultPublicationId",
				"resultPublicationTargetId",
				"resultPublicationTargetCleanupId",
				"deliveryOperationId",
				"preReturnIdentitySha256",
				"expectedSettlementIdentitySha256",
				"returnedAgentToolResultUtf8Sha256",
				"returnedAgentToolResultUtf8ByteLength",
				"foregroundAppendBatchKeySha256",
				"expectedInspectionSha256",
				"deliveryAuthority",
			]) ||
			!validResultStoreSha256Ref(request.expectedInspectionSha256)
		)
			return { status: "invalid" } as const;
		const inspectRequest: PrivateForegroundInspectRequestV1 = (({
			expectedInspectionSha256: _inspection,
			deliveryAuthority: _authority,
			...rest
		}) => rest)(request);
		const taskKey = { taskId: request.taskId, runId: request.runId };
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			let state: TransientTaskRuntimeStateV1;
			try {
				state = transientRuntimeState(taskKey, currentInput);
				const memberInput = state.parentDeliveries[foregroundMemberMapKey(request)];
				if (memberInput === undefined) return { state, result: { status: "absent" } as const };
				const member = loadForegroundValue<PrivateForegroundMemberRowV1>(memberInput);
				if (
					!strictRecord(member, ["kind", "foregroundAppendBatchKeySha256", "memberIndex"]) ||
					member.kind !== "foreground_member" ||
					member.foregroundAppendBatchKeySha256 !== request.foregroundAppendBatchKeySha256
				)
					return { state, result: { status: "conflict" } as const };
				const batchRow = this.#foregroundBatchRow(state, request.foregroundAppendBatchKeySha256);
				if (!batchRow) return { state, result: { status: "conflict" } as const };
				const handoff = batchRow.batch.handoffs[member.memberIndex];
				const identity = batchRow.batch.orderedPreReturnIdentities[member.memberIndex];
				if (
					!handoff ||
					!identity ||
					!resultTargetKeyMatches(identity.core, request) ||
					identity.core.deliveryOperationId !== request.deliveryOperationId ||
					identity.preReturnIdentitySha256 !== request.preReturnIdentitySha256 ||
					identity.core.returnedAgentToolResultUtf8Sha256 !== request.returnedAgentToolResultUtf8Sha256 ||
					identity.core.returnedAgentToolResultUtf8ByteLength !== request.returnedAgentToolResultUtf8ByteLength
				)
					return { state, result: { status: "conflict" } as const };
				const settlement = await this.#foregroundSettlement(state, batchRow, member.memberIndex);
				if (!settlement || settlement.settlementIdentitySha256 !== request.expectedSettlementIdentitySha256)
					return { state, result: { status: "conflict" } as const };
				const inspectionSha256 = foregroundTupleRef([
					"omp-transient-task-foreground-result-settlement-inspection-v1",
					1,
					inspectRequest,
					settlement,
				]);
				if (inspectionSha256 !== request.expectedInspectionSha256)
					return { state, result: { status: "conflict" } as const };
				const gate = this.#foregroundGateRow(state, request.foregroundAppendBatchKeySha256);
				const append = this.#foregroundAppendRow(state, request.foregroundAppendBatchKeySha256);
				if (settlement.settlementIdentitySha256 === null) {
					if (request.deliveryAuthority !== null) return { state, result: { status: "conflict" } as const };
					if (settlement.state === "after_tool_call_suspended" && gate?.suspension)
						return {
							state,
							result: {
								status: "rendered_result_suspended",
								handoffBatch: batchRow.batch,
								handoff,
								renderedResult: gate.renderedResult,
								suspension: gate.suspension,
							} as const,
						};
					return {
						state,
						result: {
							status: "handoff_prepared",
							handoffBatch: batchRow.batch,
							handoff,
							renderedResult: null,
						} as const,
					};
				}
				if (!append || !gate?.renderedGate || !gate.renderedResult || !gate.overlayCommitReceipt)
					return { state, result: { status: "invalid" } as const };
				const appendRequest = append.batch.requests[member.memberIndex];
				const attempt = append.attempts[member.memberIndex];
				const proof = append.notAppliedProofs[member.memberIndex];
				const parentAttempt = append.parentDeliveryAttempts[member.memberIndex];
				if (
					!appendRequest ||
					!attempt ||
					!proof ||
					!parentAttempt ||
					request.deliveryAuthority === null ||
					!exactJson(
						storeForegroundValue(request.deliveryAuthority),
						storeForegroundValue(appendRequest.deliveryAuthority),
					)
				)
					return { state, result: { status: "conflict" } as const };
				const current = await this.#currentParentRequest(state, parentAttempt.request, this.#now());
				if (current.status !== "current")
					return {
						state,
						result: { status: current.status === "authority_lost" ? "authority_lost" : "conflict" } as const,
					};
				if (settlement.state === "append_not_applied")
					return {
						state,
						result: {
							status: "not_applied",
							handoffBatch: batchRow.batch,
							handoff,
							renderedResult: gate.renderedResult,
							appendBatch: append.batch,
							attempt,
							notAppliedProof: proof,
							parentDeliveryAttempt: parentAttempt,
							batchReplayProof: append.batchReplayProof,
						} as const,
					};
				if (settlement.state === "append_outcome_unknown" && append.batchTransitionReceipt)
					return {
						state,
						result: {
							status: "outcome_unknown",
							handoffBatch: batchRow.batch,
							handoff,
							renderedResult: gate.renderedResult,
							appendBatch: append.batch,
							attempt,
							notAppliedProof: proof,
							parentDeliveryAttempt: parentAttempt,
							batchTransitionReceipt: append.batchTransitionReceipt,
						} as const,
					};
				if (settlement.state === "sink_committed" && append.batchTransitionReceipt && append.primaryReceipt) {
					const parent = await parentDeliveryRow(state.parentDeliveries[parentDeliveryMapKey(identity.core)]);
					if (parent?.state !== "terminal" || parent.receipt.outcome !== "delivered")
						return { state, result: { status: "conflict" } as const };
					return {
						state,
						result: {
							status: settlement.state,
							handoffBatch: batchRow.batch,
							handoff,
							renderedResult: gate.renderedResult,
							appendBatch: append.batch,
							attempt,
							notAppliedProof: proof,
							parentDeliveryAttempt: parentAttempt,
							batchTransitionReceipt: append.batchTransitionReceipt,
							primaryReceipt: append.primaryReceipt,
							sinkReceiptSha256: parent.receipt.sinkReceiptSha256,
							parentDeliveryReceipt: parent.receipt,
							publicationReceiptSha256: settlement.publicationReceiptSha256,
						} as const,
					};
				}
				return { state, result: { status: "invalid" } as const };
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
		});
	}

	async enumeratePendingHandoffs(request: PrivateForegroundPendingRequestV1) {
		if (
			!strictRecord(request, ["parentSessionId", "parentSessionGenerationSha256", "requestedAt", "requestSha256"]) ||
			!validResultStoreIdentity(request.parentSessionId) ||
			!validResultStoreSha256Ref(request.parentSessionGenerationSha256) ||
			!validResultStoreIso8601(request.requestedAt) ||
			!validResultStoreSha256Hex(request.requestSha256)
		)
			return { status: "invalid" } as const;
		const input = await this.#durable
			.inspect(TRANSIENT_NAMESPACE, foregroundSessionIndexKey(request.parentSessionId))
			.catch(() => undefined);
		if (input === undefined) return { status: "invalid" } as const;
		if (input === null) return { status: "matching", batches: [], renderedResultSuspensions: [] } as const;
		if (!validForegroundSessionIndex(input, request.parentSessionId)) return { status: "invalid" } as const;
		const branchRanks = new Map<Sha256Ref, number>();
		const pending: Array<{
			readonly batch: PrivateForegroundHandoffBatchV1;
			readonly suspension: PrivateForegroundSuspensionV1 | null;
			readonly branchRank: number;
			readonly sourceToolCallOrdinal: number;
			readonly firstAppendOperationId: string;
		}> = [];
		for (const locator of input.locators) {
			if (locator.parentSessionGenerationSha256 !== request.parentSessionGenerationSha256)
				return { status: "session_generation_replaced" } as const;
			try {
				const located = await this.#foregroundState(locator.foregroundAppendBatchKeySha256);
				if (
					!located ||
					located.index.taskId !== locator.taskId ||
					located.index.runId !== locator.runId ||
					located.domain.parentSessionId !== request.parentSessionId ||
					located.domain.parentSessionGenerationSha256 !== request.parentSessionGenerationSha256
				)
					return { status: "conflict" } as const;
				let branchRank = branchRanks.get(located.domain.parentBranchGenerationSha256);
				if (branchRank === undefined) {
					branchRank = branchRanks.size;
					branchRanks.set(located.domain.parentBranchGenerationSha256, branchRank);
				}
				const gate = this.#foregroundGateRow(located.state, locator.foregroundAppendBatchKeySha256);
				pending.push({
					batch: located.batchRow.batch,
					suspension: gate?.suspension ?? null,
					branchRank,
					sourceToolCallOrdinal: located.batchRow.batch.sourceToolCallOrdinal,
					firstAppendOperationId: located.batchRow.batch.orderedAppendOperationIds[0],
				});
			} catch {
				return { status: "conflict" } as const;
			}
		}
		pending.sort(
			(left, right) =>
				left.branchRank - right.branchRank ||
				left.sourceToolCallOrdinal - right.sourceToolCallOrdinal ||
				left.firstAppendOperationId.localeCompare(right.firstAppendOperationId),
		);
		const batches = pending.map(item => item.batch);
		const renderedResultSuspensions = pending.flatMap(item => (item.suspension ? [item.suspension] : []));
		return { status: "matching", batches, renderedResultSuspensions } as const;
	}

	async #authorizeTarget(
		authority: ConfidentialTransientTaskParentResultDeliveryRequestV1["deliveryAuthority"]["targetAuthority"],
		key: TransientTaskResultPublicationTargetKeyV1,
	): Promise<boolean> {
		if (authority.kind === "controller")
			return (await this.#authority.authorizeController(authority.proof)) === "current";
		if (authority.kind === "cleanup") return this.#authority.authorizeCleanup(authority.proof);
		return this.#authority.authorizeTerminal({
			key,
			terminalEvidenceId: authority.terminalEvidenceId,
			terminalEvidenceSha256: authority.terminalEvidenceSha256,
		});
	}

	async #currentParentRequest(
		state: TransientTaskRuntimeStateV1,
		request: ConfidentialTransientTaskParentResultDeliveryRequestV1,
		observedAt: ISO8601,
	) {
		const key = resultTargetKeyFromRecord(request);
		if (!key || !resultTargetLifecycleKeyMatches(state, key)) return { status: "target_missing" } as const;
		const current = state.authority;
		if (
			current === null ||
			!exactJson(current.effectIdentityManifest, request.deliveryAuthority.effectIdentityManifest) ||
			!resultTargetLifecycleMatches(state, key, request.deliveryAuthority.targetAuthority) ||
			!(await this.#authorizeTarget(request.deliveryAuthority.targetAuthority, key))
		)
			return { status: "authority_lost" } as const;
		let target: PrivateResultTargetRowV1 | null;
		try {
			target = await resultTargetRow(state.resultTargets[resultTargetMapKey(key)]);
		} catch {
			return { status: "invalid" } as const;
		}
		if (!target?.binding || target.state.state !== "bound") return { status: "target_missing" } as const;
		if (!exactJson(target.binding.route, request.route)) return { status: "route_conflict" } as const;
		const live = target.state.liveReceipt;
		if (
			live.bindingRevision !== request.targetBindingRevision ||
			live.renewalSequence !== request.targetRenewalSequence ||
			live.receiptSha256 !== request.targetLiveReceiptSha256 ||
			Date.parse(live.expiresAt) <= Date.parse(observedAt)
		)
			return { status: "stale_live_receipt" } as const;
		let publication: TransientTaskResultPublicationStateV1 | null;
		try {
			publication = await publicationState(state.publications[publicationMapKey(key)]);
		} catch {
			return { status: "invalid" } as const;
		}
		const pending =
			publication?.state === "pending"
				? publication.pending
				: publication?.state === "publication_outcome_unknown" || publication?.state === "published"
					? publication.pending
					: null;
		if (!pending || pending.outcomeSha256 !== request.pendingOutcomeSha256)
			return { status: "payload_conflict" } as const;
		const payload = await validatePublicationPayloadIdentity(pending, request, null, null);
		return payload.status === "matching" ? ({ status: "current" } as const) : payload;
	}

	prepare(
		request: ConfidentialTransientTaskParentResultDeliveryRequestV1,
	): Promise<TransientTaskParentResultDeliveryPrepareResultV1>;
	prepare(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["prepare"]>[0],
	): Promise<TransientTaskDetachedSettlementPrepareResultV1>;
	async prepare(
		request:
			| ConfidentialTransientTaskParentResultDeliveryRequestV1
			| Parameters<TransientTaskDetachedSettlementStoreV1["prepare"]>[0],
	): Promise<TransientTaskParentResultDeliveryPrepareResultV1 | TransientTaskDetachedSettlementPrepareResultV1> {
		return "attempt" in request ? this.#prepareDetached(request) : this.#prepareParent(request);
	}

	async #prepareParent(request: ConfidentialTransientTaskParentResultDeliveryRequestV1) {
		const key = resultTargetKeyFromRecord(request);
		if (!key || !(await validParentDeliveryRequest(request, key)) || !parentDeliverySinkProjectionMatches(request))
			return { status: "invalid" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			let state: TransientTaskRuntimeStateV1;
			try {
				state = transientRuntimeState(taskKey, currentInput);
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
			const current = await this.#currentParentRequest(state, request, this.#now());
			if (current.status !== "current") return { state, result: current };
			const mapKey = parentDeliveryMapKey(key);
			let prior: PrivateParentDeliveryRowV1 | null;
			try {
				prior = await parentDeliveryRow(state.parentDeliveries[mapKey]);
			} catch {
				return { state, result: { status: "invalid" } as const };
			}
			if (prior) {
				return exactJson(prior.attempt.request, request)
					? { state, result: { status: "already_prepared", attemptSha256: prior.attempt.attemptSha256 } as const }
					: { state, result: parentDeliveryConflict(prior.attempt.request, request) };
			}
			const preparedAt = this.#now();
			const attempt: ConfidentialTransientTaskParentResultDeliveryAttemptV1 = {
				schemaVersion: 1,
				request,
				preparedAt,
				attemptSha256: await tupleRef([
					"omp-transient-task-parent-result-delivery-v1",
					"attempt",
					1,
					request.deliveryRequestSha256,
					preparedAt,
				]),
			};
			return {
				state: {
					...state,
					parentDeliveries: {
						...state.parentDeliveries,
						[mapKey]: { state: "not_applied", attempt, receipt: null } satisfies PrivateParentDeliveryRowV1,
					},
				},
				result: { status: "prepared", attemptSha256: attempt.attemptSha256 } as const,
			};
		});
	}

	async #indexDetachedSettlement(settlement: ConfidentialTransientTaskDetachedSettlementRequestV1): Promise<boolean> {
		const locator: PrivateDetachedIdentityLocatorV1 = {
			schemaVersion: 1,
			identitySha256: settlement.identity.identitySha256,
			taskId: settlement.identity.taskId,
			runId: settlement.identity.runId,
			ownerId: settlement.identity.ownerId,
			jobId: settlement.identity.jobId,
		};
		const install = (key: string) =>
			this.#durable.transact(TRANSIENT_NAMESPACE, key, currentInput => {
				if (currentInput === null) return { state: locator, result: true };
				return {
					state: currentInput,
					result: validDetachedIdentityLocator(currentInput) && exactJson(currentInput, locator),
				};
			});
		if (!(await install(detachedIdentityLocatorKey(locator.identitySha256)))) return false;
		return install(detachedJobLocatorKey(locator.ownerId, locator.jobId));
	}

	async #prepareDetached(request: Parameters<TransientTaskDetachedSettlementStoreV1["prepare"]>[0]) {
		if (
			!proxyFreeData(request) ||
			!strictRecord(request, ["attempt"]) ||
			!(await validDetachedAttempt(request.attempt))
		)
			return { status: "invalid" } as const;
		const attempt = request.attempt;
		const settlement = detachedSettlementFromOperation(attempt.operation);
		if (attempt.operation.stage === "sink_enqueue" && settlement.terminalStatus === "cancelled")
			return { status: "invalid" } as const;
		const taskKey = detachedTaskKey(settlement);
		const mapKey = detachedStoreMapKey(settlement.identity.identitySha256);
		const result = await this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			let state: TransientTaskRuntimeStateV1;
			try {
				state = transientRuntimeState(taskKey, currentInput);
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
			let row: PrivateDetachedSettlementRowV1 | null = null;
			const stored = state.parentDeliveries[mapKey];
			try {
				if (stored !== undefined) row = loadDetachedRow<PrivateDetachedSettlementRowV1>(stored);
			} catch {
				return { state, result: { status: "invalid" } as const };
			}
			if (row && (row.kind !== "detached_settlement" || row.identitySha256 !== settlement.identity.identitySha256))
				return { state, result: { status: "identity_conflict" } as const };
			if (row && !exactJson(row.settlement, settlement))
				return {
					state,
					result: {
						status: exactJson(row.settlement.identity, settlement.identity)
							? "request_conflict"
							: "identity_conflict",
					} as const,
				};
			const prior = row ? detachedAttemptState(row, attempt.operation.stage, attempt.operationId) : null;
			if (prior) {
				if (!exactJson(prior.attempt.operation, attempt.operation))
					return { state, result: { status: "request_conflict" } as const };
				if (!exactJson(prior.attempt, attempt)) return { state, result: { status: "attempt_conflict" } as const };
				return {
					state,
					result: {
						status: "already_prepared",
						attempt: prior.attempt,
						notAppliedReceipt: prior.notAppliedReceipt,
					} as const,
				};
			}
			const receiptCore = {
				schemaVersion: 1 as const,
				identitySha256: settlement.identity.identitySha256,
				stage: attempt.operation.stage,
				operationId: attempt.operationId,
				requestSha256: attempt.requestSha256,
				attemptSha256: attempt.attemptSha256,
				storedAt: attempt.preparedAt,
			};
			const notAppliedReceipt: TransientTaskDetachedSettlementNotAppliedReceiptV1 = {
				...receiptCore,
				receiptSha256: detachedDigest("settlement-not-applied-receipt", receiptCore),
			};
			const nextRow: PrivateDetachedSettlementRowV1 = {
				kind: "detached_settlement",
				identitySha256: settlement.identity.identitySha256,
				settlement,
				attempts: [...(row?.attempts ?? []), { attempt, notAppliedReceipt, state: "not_applied", receipt: null }],
				terminalReceipt: row?.terminalReceipt ?? null,
			};
			return {
				state: {
					...state,
					parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(nextRow) },
				},
				result: { status: "prepared", attempt, notAppliedReceipt } as const,
			};
		});
		if (result.status !== "prepared" && result.status !== "already_prepared") return result;
		try {
			if (await this.#indexDetachedSettlement(settlement)) return result;
		} catch {
			// The exact-domain row remains authoritative; retry preparation repairs only the locator.
		}
		return {
			status: "prepare_outcome_unknown",
			operationId: attempt.operationId,
			requestSha256: attempt.requestSha256,
			attemptSha256: attempt.attemptSha256,
		} as const;
	}

	async #loadDetachedSettlement(
		settlement: ConfidentialTransientTaskDetachedSettlementRequestV1,
	): Promise<PrivateDetachedSettlementRowV1 | null> {
		const taskKey = detachedTaskKey(settlement);
		const state = transientRuntimeState(
			taskKey,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
		);
		const stored = state.parentDeliveries[detachedStoreMapKey(settlement.identity.identitySha256)];
		if (stored === undefined) return null;
		const row = loadDetachedRow<PrivateDetachedSettlementRowV1>(stored);
		if (row.kind !== "detached_settlement" || row.identitySha256 !== settlement.identity.identitySha256)
			throw new TypeError("Detached settlement identity conflict");
		return row;
	}

	async #openDetachedEffect(
		request: PrivateDetachedEffectRequestV1,
		validate: (
			row: PrivateDetachedSettlementRowV1,
			state: TransientTaskRuntimeStateV1,
		) => PrivateDetachedEffectBlockStatusV1 | null,
	): Promise<PrivateDetachedEffectOpenResultV1> {
		if (
			!proxyFreeData(request) ||
			!validDetachedEffectRequest(request) ||
			!(await validDetachedOperation(request.operation))
		)
			return { status: "invalid" };
		const settlement = detachedSettlementFromOperation(request.operation);
		const taskKey = detachedTaskKey(settlement);
		const mapKey = detachedStoreMapKey(settlement.identity.identitySha256);
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			let state: TransientTaskRuntimeStateV1;
			try {
				state = transientRuntimeState(taskKey, currentInput);
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
			const stored = state.parentDeliveries[mapKey];
			if (stored === undefined) return { state, result: { status: "absent" } as const };
			let row: PrivateDetachedSettlementRowV1;
			try {
				row = loadDetachedRow<PrivateDetachedSettlementRowV1>(stored);
			} catch {
				return { state, result: { status: "invalid" } as const };
			}
			if (row.kind !== "detached_settlement" || row.identitySha256 !== settlement.identity.identitySha256)
				return { state, result: { status: "blocked", reason: "identity_conflict" } as const };
			if (!exactJson(row.settlement, settlement))
				return { state, result: { status: "blocked", reason: "request_conflict" } as const };
			const block = validate(row, state);
			if (block !== null) return { state, result: { status: "blocked", reason: block } as const };
			const index = detachedAttemptIndex(row, request.operation.stage, request.operation.operationId);
			if (index < 0) return { state, result: { status: "absent" } as const };
			const attempt = row.attempts[index];
			if (
				attempt.attempt.attemptSha256 !== request.expectedAttemptSha256 ||
				attempt.notAppliedReceipt.receiptSha256 !== request.expectedNotAppliedReceiptSha256 ||
				!exactJson(attempt.attempt.operation, request.operation)
			)
				return { state, result: { status: "attempt_conflict" } as const };
			if (attempt.state === "applied")
				return attempt.receipt === null
					? { state, result: { status: "invalid" } as const }
					: { state, result: { status: "applied", receipt: attempt.receipt } as const };
			if (attempt.state === "outcome_unknown")
				return { state, result: { status: "outcome_unknown", attempt } as const };
			const nextRow = replaceDetachedAttempt(row, index, { ...attempt, state: "outcome_unknown" });
			return {
				state: {
					...state,
					parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(nextRow) },
				},
				result: { status: "opened", attempt } as const,
			};
		});
	}

	async #finishDetachedEffect(
		request: PrivateDetachedEffectRequestV1,
		receipt: ConfidentialTransientTaskDetachedSettlementOperationReceiptV1,
		terminalReceipt: ConfidentialTransientTaskDetachedSettlementTerminalReceiptV1 | null,
	) {
		const settlement = detachedSettlementFromOperation(request.operation);
		const taskKey = detachedTaskKey(settlement);
		const mapKey = detachedStoreMapKey(settlement.identity.identitySha256);
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
			try {
				const state = transientRuntimeState(taskKey, currentInput);
				const row = loadDetachedRow<PrivateDetachedSettlementRowV1>(state.parentDeliveries[mapKey]);
				if (row.kind !== "detached_settlement" || !exactJson(row.settlement, settlement))
					return { state, result: { status: "invalid" } as const };
				const index = detachedAttemptIndex(row, request.operation.stage, request.operation.operationId);
				if (index < 0) return { state, result: { status: "invalid" } as const };
				const attempt = row.attempts[index];
				if (
					attempt.attempt.attemptSha256 !== request.expectedAttemptSha256 ||
					attempt.notAppliedReceipt.receiptSha256 !== request.expectedNotAppliedReceiptSha256
				)
					return { state, result: { status: "invalid" } as const };
				if (attempt.state === "applied")
					return attempt.receipt !== null && exactJson(attempt.receipt, receipt)
						? { state, result: { status: "already_applied", receipt: attempt.receipt } as const }
						: { state, result: { status: "invalid" } as const };
				if (attempt.state !== "outcome_unknown") return { state, result: { status: "outcome_unknown" } as const };
				if (
					terminalReceipt !== null &&
					row.terminalReceipt !== null &&
					!exactJson(row.terminalReceipt, terminalReceipt)
				)
					return { state, result: { status: "invalid" } as const };
				const nextRow = replaceDetachedAttempt(row, index, {
					...attempt,
					state: "applied",
					receipt,
				});
				const completedRow = terminalReceipt === null ? nextRow : { ...nextRow, terminalReceipt };
				return {
					state: {
						...state,
						parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(completedRow) },
					},
					result: { status: "applied", receipt } as const,
				};
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
		});
	}

	#detachedOutcomeUnknown(attempt: PrivateDetachedAttemptStateV1) {
		return {
			operationId: attempt.attempt.operationId,
			requestSha256: attempt.attempt.requestSha256,
			attemptSha256: attempt.attempt.attemptSha256,
			notAppliedReceiptSha256: attempt.notAppliedReceipt.receiptSha256,
		};
	}

	async #resolveDetachedTerminalForParentDelivery(
		request: ConfidentialTransientTaskParentResultDeliveryRequestV1,
		expectedParentAttemptSha256: Sha256Ref,
	) {
		if (request.route.kind !== "owner_routed_async_result") return { status: "invalid" } as const;
		const taskKey = { taskId: request.taskId, runId: request.runId };
		try {
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			const parent = await parentDeliveryRow(state.parentDeliveries[parentDeliveryMapKey(request)]);
			if (!parent) return { status: "absent" } as const;
			if (
				parent.attempt.attemptSha256 !== expectedParentAttemptSha256 ||
				!exactJson(parent.attempt.request, request)
			)
				return { status: "conflict" } as const;
			if (parent.state === "terminal") return { status: "parent_terminal", receipt: parent.receipt } as const;
			const locatorInput = await this.#durable.inspect(
				TRANSIENT_NAMESPACE,
				detachedJobLocatorKey(request.route.ownerAgentId, request.route.jobId),
			);
			if (!validDetachedIdentityLocator(locatorInput))
				return { status: locatorInput === null ? "absent" : "invalid" } as const;
			if (locatorInput.taskId !== taskKey.taskId || locatorInput.runId !== taskKey.runId)
				return { status: "conflict" } as const;
			const rowInput = state.parentDeliveries[detachedStoreMapKey(locatorInput.identitySha256)];
			if (rowInput === undefined) return { status: "absent" } as const;
			const row = loadDetachedRow<PrivateDetachedSettlementRowV1>(rowInput);
			if (row.kind !== "detached_settlement" || !exactJson(row.settlement.parentDeliveryRequest, request))
				return { status: "conflict" } as const;
			if (row.terminalReceipt !== null) return { status: "terminal", receipt: row.terminalReceipt } as const;
			return row.attempts.some(
				entry => entry.attempt.operation.stage === "terminal_commit" && entry.state === "outcome_unknown",
			)
				? ({ status: "outcome_unknown" } as const)
				: ({ status: "absent" } as const);
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async publishSettledResult(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["publishSettledResult"]>[0],
	): Promise<TransientTaskDetachedSettledResultPublicationResultV1> {
		let opened: PrivateDetachedEffectOpenResultV1;
		try {
			opened = await this.#openDetachedEffect(request, () => null);
		} catch {
			return {
				status: "settled_result_outcome_unknown",
				operationId: request.operation.operationId,
				requestSha256: request.operation.requestSha256,
				attemptSha256: request.expectedAttemptSha256,
				notAppliedReceiptSha256: request.expectedNotAppliedReceiptSha256,
			};
		}
		if (opened.status === "applied")
			return {
				status: "already_published",
				receipt: opened.receipt as TransientTaskDetachedSettledResultPublicationReceiptV1,
			};
		if (opened.status === "outcome_unknown")
			return { status: "settled_result_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		if (opened.status === "blocked")
			return {
				status:
					opened.reason === "identity_conflict" || opened.reason === "request_conflict"
						? opened.reason
						: "invalid",
			};
		if (opened.status !== "opened")
			return { status: opened.status === "attempt_conflict" ? "request_conflict" : "invalid" };
		const settlement = request.operation.request;
		const core = {
			schemaVersion: 1 as const,
			identity: settlement.identity,
			settledResultOperationId: settlement.settledResultOperationId,
			settlementRequestSha256: settlement.settlementRequestSha256,
			deliveryAuthoritySha256: settlement.deliveryAuthoritySha256,
			publishedAt: opened.attempt.notAppliedReceipt.storedAt,
		};
		const receipt: TransientTaskDetachedSettledResultPublicationReceiptV1 = {
			...core,
			receiptSha256: detachedDigest("settled-result-publication-receipt", core),
		};
		try {
			const finished = await this.#finishDetachedEffect(request, receipt, null);
			return finished.status === "applied" || finished.status === "already_applied"
				? { status: finished.status === "applied" ? "published" : "already_published", receipt }
				: { status: "settled_result_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		} catch {
			return { status: "settled_result_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		}
	}

	async reserve(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["reserve"]>[0],
	): Promise<TransientTaskDetachedSettlementReservationResultV1> {
		const reservation = request.operation.request;
		if (reservation.settlement.terminalStatus === "cancelled" && reservation.disposition === "current_epoch_enqueue")
			return { status: "cancellation_enqueue_forbidden" };
		let opened: PrivateDetachedEffectOpenResultV1;
		try {
			opened = await this.#openDetachedEffect(request, (row, state) => {
				if (
					reservation.settlement.terminalStatus === "cancelled" &&
					reservation.disposition === "current_epoch_enqueue"
				)
					return "cancellation_enqueue_forbidden";
				if (row.terminalReceipt !== null) return "already_terminal";
				const publication = detachedAttemptState(
					row,
					"settled_result_publication",
					row.settlement.settledResultOperationId,
				);
				if (publication?.state !== "applied" || publication.receipt === null) return "settled_result_missing";
				if (
					!detachedCurrentAuthorityMatches(
						reservation.currentAuthority,
						row.settlement,
						detachedOperationReceiptSha256(publication.receipt),
					)
				)
					return "authority_lost";
				if (
					(reservation.disposition === "current_epoch_enqueue" ||
						reservation.disposition.endsWith("consumption")) &&
					reservation.currentAuthority.kind !== "current_owner_epoch"
				)
					return "stale_owner_epoch";
				if (
					reservation.disposition === "delivery_epoch_invalidation" &&
					reservation.currentAuthority.kind !== "epoch_invalidated"
				)
					return "authority_lost";
				if (
					reservation.disposition === "missing_owner_dead_letter" &&
					reservation.currentAuthority.kind !== "owner_absent"
				)
					return "authority_lost";
				const released = new Set<Sha256Ref>();
				for (const entry of row.attempts) {
					if (entry.attempt.operation.stage === "reservation_release" && entry.state === "applied")
						released.add(entry.attempt.operation.request.reservation.receiptSha256);
				}
				for (const entry of row.attempts) {
					if (
						entry.attempt.operation.stage !== "reservation" ||
						entry.state !== "applied" ||
						entry.receipt === null
					)
						continue;
					if (entry.attempt.operation.operationId === reservation.reservationId) continue;
					if (!released.has(detachedOperationReceiptSha256(entry.receipt))) return "reservation_busy";
				}
				if (reservation.disposition === "hub_wait_consumption") {
					for (const stored of Object.values(state.parentDeliveries)) {
						const candidate = loadForegroundValue<unknown>(stored);
						if (
							candidate === null ||
							typeof candidate !== "object" ||
							Array.isArray(candidate) ||
							!("kind" in candidate) ||
							candidate.kind !== "detached_hub_winner"
						)
							continue;
						const winner = loadDetachedHubWinnerRow(stored);
						if (
							winner.captureRequest.selector.key.hubWaitInvocationId === reservation.hubWaitInvocationId &&
							winner.continuation !== null
						)
							return "reservation_busy";
					}
				}
				return null;
			});
		} catch {
			return {
				status: "reservation_outcome_unknown",
				operationId: request.operation.operationId,
				requestSha256: request.operation.requestSha256,
				attemptSha256: request.expectedAttemptSha256,
				notAppliedReceiptSha256: request.expectedNotAppliedReceiptSha256,
			};
		}
		if (opened.status === "applied")
			return {
				status: "already_reserved",
				receipt: opened.receipt as ConfidentialTransientTaskDetachedSettlementReservationReceiptV1,
			};
		if (opened.status === "outcome_unknown")
			return { status: "reservation_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		if (opened.status === "blocked") {
			if (opened.reason === "already_terminal") {
				try {
					const row = await this.#loadDetachedSettlement(reservation.settlement);
					if (row?.terminalReceipt)
						return {
							status: "already_terminal",
							terminalDisposition: row.terminalReceipt.disposition,
							terminalReceiptSha256: row.terminalReceipt.receiptSha256,
						};
				} catch {
					return { status: "invalid" };
				}
			}
			switch (opened.reason) {
				case "cancellation_enqueue_forbidden":
				case "settled_result_missing":
				case "authority_lost":
				case "stale_owner_epoch":
				case "reservation_busy":
				case "identity_conflict":
				case "request_conflict":
				case "invalid":
					return { status: opened.reason };
				default:
					return { status: "invalid" };
			}
		}
		if (opened.status !== "opened")
			return { status: opened.status === "absent" ? "settled_result_missing" : "request_conflict" };
		const reservedAt = opened.attempt.notAppliedReceipt.storedAt;
		const base = {
			schemaVersion: 1 as const,
			identity: reservation.settlement.identity,
			reservationId: reservation.reservationId,
			currentAuthoritySha256: reservation.currentAuthority.currentAuthoritySha256,
			reservationRequestSha256: reservation.reservationRequestSha256,
			reservedAt,
		};
		let receipt: ConfidentialTransientTaskDetachedSettlementReservationReceiptV1;
		if (reservation.disposition === "hub_jobs_consumption") {
			const suppressionCore = {
				schemaVersion: 1 as const,
				identity: reservation.settlement.identity,
				reservationId: reservation.reservationId,
				suppressionOperationId: reservation.suppressionOperationId,
				consumer: "hub_jobs" as const,
				currentAuthoritySha256: reservation.currentAuthority.currentAuthoritySha256,
				reservationRequestSha256: reservation.reservationRequestSha256,
				suppressedAt: reservedAt,
			};
			const suppression = {
				...suppressionCore,
				receiptSha256: detachedDigest("suppression-receipt", suppressionCore),
			};
			const receiptCore = { ...base, disposition: reservation.disposition, suppression };
			receipt = { ...receiptCore, receiptSha256: detachedDigest("reservation-receipt", receiptCore) };
		} else if (reservation.disposition === "hub_wait_consumption") {
			const suppressionCore = {
				schemaVersion: 1 as const,
				identity: reservation.settlement.identity,
				reservationId: reservation.reservationId,
				suppressionOperationId: reservation.suppressionOperationId,
				consumer: "hub_wait" as const,
				currentAuthoritySha256: reservation.currentAuthority.currentAuthoritySha256,
				reservationRequestSha256: reservation.reservationRequestSha256,
				suppressedAt: reservedAt,
			};
			const suppression = {
				...suppressionCore,
				receiptSha256: detachedDigest("suppression-receipt", suppressionCore),
			};
			const receiptCore = {
				...base,
				disposition: reservation.disposition,
				hubWaitInvocationId: reservation.hubWaitInvocationId,
				suppression,
			};
			receipt = { ...receiptCore, receiptSha256: detachedDigest("reservation-receipt", receiptCore) };
		} else if (reservation.disposition === "hub_cancel_consumption") {
			const suppressionCore = {
				schemaVersion: 1 as const,
				identity: reservation.settlement.identity,
				reservationId: reservation.reservationId,
				suppressionOperationId: reservation.suppressionOperationId,
				consumer: "hub_cancel" as const,
				currentAuthoritySha256: reservation.currentAuthority.currentAuthoritySha256,
				reservationRequestSha256: reservation.reservationRequestSha256,
				suppressedAt: reservedAt,
			};
			const suppression = {
				...suppressionCore,
				receiptSha256: detachedDigest("suppression-receipt", suppressionCore),
			};
			const receiptCore = { ...base, disposition: reservation.disposition, suppression };
			receipt = { ...receiptCore, receiptSha256: detachedDigest("reservation-receipt", receiptCore) };
		} else {
			const receiptCore = { ...base, disposition: reservation.disposition, suppression: null };
			receipt = { ...receiptCore, receiptSha256: detachedDigest("reservation-receipt", receiptCore) };
		}
		try {
			const finished = await this.#finishDetachedEffect(request, receipt, null);
			return finished.status === "applied" || finished.status === "already_applied"
				? { status: finished.status === "applied" ? "reserved" : "already_reserved", receipt }
				: { status: "reservation_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		} catch {
			return { status: "reservation_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		}
	}

	async #restoreDetachedPrimaryAppendNotApplied(request: PrivateDetachedEffectRequestV1): Promise<boolean> {
		const settlement = detachedSettlementFromOperation(request.operation);
		const taskKey = detachedTaskKey(settlement);
		const mapKey = detachedStoreMapKey(settlement.identity.identitySha256);
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
			try {
				const state = transientRuntimeState(taskKey, currentInput);
				const stored = state.parentDeliveries[mapKey];
				if (stored === undefined) return { state, result: false };
				const row = loadDetachedRow<PrivateDetachedSettlementRowV1>(stored);
				if (row.kind !== "detached_settlement" || !exactJson(row.settlement, settlement))
					return { state, result: false };
				const index = detachedAttemptIndex(row, request.operation.stage, request.operation.operationId);
				if (index < 0) return { state, result: false };
				const attempt = row.attempts[index];
				if (
					attempt.attempt.attemptSha256 !== request.expectedAttemptSha256 ||
					attempt.notAppliedReceipt.receiptSha256 !== request.expectedNotAppliedReceiptSha256 ||
					!exactJson(attempt.attempt.operation, request.operation) ||
					attempt.receipt !== null
				)
					return { state, result: false };
				if (attempt.state === "not_applied") return { state, result: true };
				if (attempt.state !== "outcome_unknown") return { state, result: false };
				const nextRow = replaceDetachedAttempt(row, index, { ...attempt, state: "not_applied" });
				return {
					state: {
						...state,
						parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(nextRow) },
					},
					result: true,
				};
			} catch {
				return { state: currentInput, result: false };
			}
		});
	}

	async #inspectDetachedPrimaryAppend(
		appendRequest: ConfidentialTransientTaskDetachedPrimarySessionAppendRequestV1,
	): Promise<PrivateDetachedPrimaryAppendResolutionV1> {
		const inspectCore = {
			plan: appendRequest.plan,
			expectedPrimaryAppendRequestSha256: appendRequest.primaryAppendRequestSha256,
		};
		const inspectRequest = {
			...inspectCore,
			inspectRequestSha256: detachedDigest("primary-session-append-inspect-request", inspectCore),
		};
		let inspection: ConfidentialTransientTaskDetachedPrimarySessionAppendInspectResultV1;
		try {
			inspection = await this.#primarySessionAppend.inspectFixedDetachedPrimarySessionAppend(inspectRequest);
		} catch {
			return { status: "outcome_unknown" };
		}
		if (!payloadPlainData(inspection)) return { status: "outcome_unknown" };
		if (inspection.status === "committed") {
			return strictRecord(inspection, ["status", "receipt", "inspectionSha256"]) &&
				validResultStoreSha256Ref(inspection.inspectionSha256) &&
				detachedPrimaryAppendReceiptMatches(inspection.receipt, appendRequest)
				? { status: "applied", receipt: inspection.receipt }
				: { status: "outcome_unknown" };
		}
		if (inspection.status === "not_applied") {
			return strictRecord(inspection, ["status", "plan", "inspectionSha256"]) &&
				exactJson(inspection.plan, appendRequest.plan) &&
				validResultStoreSha256Ref(inspection.inspectionSha256)
				? { status: "not_applied" }
				: { status: "outcome_unknown" };
		}
		if (inspection.status !== "append_outcome_unknown")
			return strictRecord(inspection, ["status"]) ? { status: "rejected" } : { status: "outcome_unknown" };
		if (
			!strictRecord(inspection, [
				"status",
				"plan",
				"inspectionSha256",
				"observation",
				"matchingEntryJsonlUtf8Sha256",
				"authoritativeAbsenceProof",
			]) ||
			!exactJson(inspection.plan, appendRequest.plan) ||
			!validResultStoreSha256Ref(inspection.inspectionSha256)
		)
			return { status: "outcome_unknown" };
		if (inspection.observation === "matching_entry") {
			if (
				inspection.matchingEntryJsonlUtf8Sha256 !== appendRequest.plan.primarySessionEntryJsonlUtf8Sha256 ||
				inspection.authoritativeAbsenceProof !== null
			)
				return { status: "outcome_unknown" };
		} else if (
			inspection.observation !== "authoritative_absence" ||
			inspection.matchingEntryJsonlUtf8Sha256 !== null ||
			!detachedPrimaryAppendAbsenceProofMatches(inspection.authoritativeAbsenceProof, appendRequest.plan)
		) {
			return { status: "outcome_unknown" };
		}
		const currentLeafEntryId =
			inspection.observation === "matching_entry"
				? appendRequest.plan.primarySessionEntryId
				: inspection.authoritativeAbsenceProof.observedCurrentLeafEntryId;
		const adoptCore = {
			plan: appendRequest.plan,
			expectedPrimaryAppendRequestSha256: appendRequest.primaryAppendRequestSha256,
			expectedInspectionSha256: inspection.inspectionSha256,
			currentPrimarySessionId: appendRequest.plan.primarySessionId,
			currentPrimarySessionGenerationSha256: appendRequest.plan.primarySessionGenerationSha256,
			currentPrimaryBranchGenerationSha256: appendRequest.plan.primaryBranchGenerationSha256,
			currentPrimaryBranchAnchorEntryId: appendRequest.plan.primaryBranchAnchorEntryId,
			currentLeafEntryId,
		};
		const adoptRequest = {
			...adoptCore,
			adoptRequestSha256: detachedDigest("primary-session-append-adopt-request", adoptCore),
		};
		let adopted: ConfidentialTransientTaskDetachedPrimarySessionAppendAdoptResultV1;
		try {
			adopted = await this.#primarySessionAppend.adoptFixedDetachedPrimarySessionAppend(adoptRequest);
		} catch {
			return { status: "outcome_unknown" };
		}
		if (!payloadPlainData(adopted)) return { status: "outcome_unknown" };
		if (adopted.status === "adopted" || adopted.status === "already_adopted")
			return strictRecord(adopted, ["status", "receipt"]) &&
				detachedPrimaryAppendReceiptMatches(adopted.receipt, appendRequest)
				? { status: "applied", receipt: adopted.receipt }
				: { status: "outcome_unknown" };
		if (adopted.status === "restored_not_applied" || adopted.status === "already_not_applied")
			return strictRecord(adopted, ["status", "plan"]) && exactJson(adopted.plan, appendRequest.plan)
				? { status: "not_applied" }
				: { status: "outcome_unknown" };
		return strictRecord(adopted, ["status"]) && adopted.status !== "append_outcome_unknown"
			? { status: "rejected" }
			: { status: "outcome_unknown" };
	}

	async #dispatchDetachedPrimaryAppend(
		appendRequest: ConfidentialTransientTaskDetachedPrimarySessionAppendRequestV1,
	): Promise<PrivateDetachedPrimaryAppendResolutionV1> {
		let appended: ConfidentialTransientTaskDetachedPrimarySessionAppendResultV1;
		try {
			appended = await this.#primarySessionAppend.appendFixedDetachedPrimarySessionPlan(appendRequest);
		} catch {
			return this.#inspectDetachedPrimaryAppend(appendRequest);
		}
		if (!payloadPlainData(appended)) return { status: "outcome_unknown" };
		if (appended.status === "appended" || appended.status === "already_appended")
			return strictRecord(appended, ["status", "receipt"]) &&
				detachedPrimaryAppendReceiptMatches(appended.receipt, appendRequest)
				? { status: "applied", receipt: appended.receipt }
				: { status: "outcome_unknown" };
		if (appended.status === "append_outcome_unknown")
			return strictRecord(appended, ["status", "primaryAppendPlanSha256"]) &&
				appended.primaryAppendPlanSha256 === appendRequest.plan.primaryAppendPlanSha256
				? this.#inspectDetachedPrimaryAppend(appendRequest)
				: { status: "outcome_unknown" };
		return strictRecord(appended, ["status"]) ? { status: "rejected" } : { status: "outcome_unknown" };
	}

	async applyReservedEnqueue(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["applyReservedEnqueue"]>[0],
	): Promise<TransientTaskDetachedSinkEnqueueResultV1> {
		const sink = request.operation.request;
		const reservationInput: unknown = sink.reservation;
		if (
			!validCurrentEpochReservationReceipt(reservationInput) ||
			!exactJson(reservationInput.identity, sink.settlement.identity) ||
			reservationInput.currentAuthoritySha256 !== sink.currentAuthority.currentAuthoritySha256
		)
			return { status: "invalid" };
		const reservation = reservationInput;
		if (detachedSettlementFromOperation(request.operation).terminalStatus === "cancelled")
			return { status: "cancellation_enqueue_forbidden" };
		let opened: PrivateDetachedEffectOpenResultV1;
		try {
			opened = await this.#openDetachedEffect(request, row => {
				if (row.terminalReceipt !== null) return "already_terminal";
				const publication = detachedAttemptState(
					row,
					"settled_result_publication",
					row.settlement.settledResultOperationId,
				);
				if (publication?.state !== "applied" || publication.receipt === null) return "reservation_missing";
				if (
					!detachedCurrentAuthorityMatches(
						sink.currentAuthority,
						row.settlement,
						detachedOperationReceiptSha256(publication.receipt),
					)
				)
					return "authority_lost";
				const reservationAttempt = row.attempts.find(
					entry =>
						entry.state === "applied" &&
						entry.receipt !== null &&
						detachedOperationReceiptSha256(entry.receipt) === reservation.receiptSha256,
				);
				if (reservationAttempt?.attempt.operation.stage !== "reservation") return "reservation_missing";
				if (!exactJson(reservationAttempt.receipt, reservation)) return "request_conflict";
				if (
					row.attempts.some(
						entry =>
							entry.attempt.operation.stage === "reservation_release" &&
							entry.state === "applied" &&
							entry.attempt.operation.request.reservation.receiptSha256 === reservation.receiptSha256,
					)
				)
					return "reservation_released";
				const plan = sink.primaryAppendPlan;
				const outbox = sink.outboxReceipt;
				if (
					!payloadPlainData(plan) ||
					!payloadPlainData(outbox) ||
					plan.orderedOutboxMemberSha256s.length !== 1 ||
					plan.orderedOutboxMemberSha256s[0] !== outbox.member.memberSha256 ||
					outbox.primaryAppendBatchKeySha256 !== plan.primaryAppendBatchKeySha256 ||
					outbox.primaryAppendPlanSha256 !== plan.primaryAppendPlanSha256 ||
					outbox.primaryAppendMemberIndex !== 0 ||
					outbox.primaryAppendMemberCount !== 1 ||
					!exactJson(outbox.member.core.identity, sink.settlement.identity) ||
					outbox.member.core.sinkOperationId !== request.operation.operationId ||
					outbox.member.core.currentAuthoritySha256 !== sink.currentAuthority.currentAuthoritySha256 ||
					outbox.member.core.reservationReceiptSha256 !== reservation.receiptSha256
				)
					return "invalid";
				return null;
			});
		} catch {
			return {
				status: "sink_outcome_unknown",
				operationId: request.operation.operationId,
				requestSha256: request.operation.requestSha256,
				attemptSha256: request.expectedAttemptSha256,
				notAppliedReceiptSha256: request.expectedNotAppliedReceiptSha256,
			};
		}
		if (opened.status === "applied")
			return {
				status: "already_enqueued",
				receipt: opened.receipt as Extract<
					ConfidentialTransientTaskParentResultSinkReceiptV1,
					{ routeKind: "owner_routed_async_result" }
				>,
			};
		if (opened.status === "blocked") {
			switch (opened.reason) {
				case "cancellation_enqueue_forbidden":
				case "reservation_missing":
				case "reservation_released":
				case "already_terminal":
				case "authority_lost":
				case "stale_owner_epoch":
				case "identity_conflict":
				case "request_conflict":
				case "invalid":
					return { status: opened.reason };
				default:
					return { status: "invalid" };
			}
		}
		if (opened.status !== "opened" && opened.status !== "outcome_unknown")
			return { status: opened.status === "absent" ? "reservation_missing" : "request_conflict" };
		const appendRequest = detachedPrimaryAppendRequest(sink);
		const effect =
			opened.status === "opened"
				? await this.#dispatchDetachedPrimaryAppend(appendRequest)
				: await this.#inspectDetachedPrimaryAppend(appendRequest);
		if (effect.status !== "applied") {
			if (effect.status === "not_applied" || effect.status === "rejected") {
				let restored = false;
				try {
					restored = await this.#restoreDetachedPrimaryAppendNotApplied(request);
				} catch {
					// The exact attempt remains outcome-unknown until recovery can prove its state.
				}
				if (restored && effect.status === "rejected") return { status: "invalid" };
			}
			return { status: "sink_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		}
		const receiptCore = {
			schemaVersion: 1 as const,
			deliveryOperationId: sink.settlement.identity.deliveryOperationId,
			deliveryRequestSha256: sink.settlement.identity.deliveryRequestSha256,
			deliveryAuthoritySha256: sink.settlement.deliveryAuthoritySha256,
			sinkResultUtf8: sink.settlement.sinkResultUtf8,
			sinkResultUtf8Sha256: sink.settlement.identity.sinkResultUtf8Sha256,
			sinkResultUtf8ByteLength: sink.settlement.identity.sinkResultUtf8ByteLength,
			authorityJoinSha256: sink.authorityJoinSha256,
			appliedAt: opened.attempt.notAppliedReceipt.storedAt,
			routeKind: "owner_routed_async_result" as const,
			foregroundSessionAppendReceipt: null,
			detachedSettlementIdentity: sink.settlement.identity,
			detachedCurrentAuthoritySha256: sink.currentAuthority.currentAuthoritySha256,
			reservationReceiptSha256: reservation.receiptSha256,
			detachedSessionOutboxReceipt: sink.outboxReceipt,
			detachedPrimarySessionPersistenceReceipt: effect.receipt,
		};
		const receipt = {
			...receiptCore,
			sinkReceiptSha256: detachedDigest("parent-result-sink-receipt", receiptCore),
		} as Extract<ConfidentialTransientTaskParentResultSinkReceiptV1, { routeKind: "owner_routed_async_result" }>;
		try {
			const finished = await this.#finishDetachedEffect(request, receipt, null);
			return finished.status === "applied" || finished.status === "already_applied"
				? { status: finished.status === "applied" ? "enqueued" : "already_enqueued", receipt }
				: { status: "sink_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		} catch {
			return { status: "sink_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		}
	}

	async commit(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["commit"]>[0],
	): Promise<TransientTaskDetachedSettlementCommitResultV1> {
		const commit = request.operation.request;
		const settlement = detachedSettlementFromOperation(request.operation);
		if (settlement.terminalStatus === "cancelled" && commit.disposition === "current_epoch_enqueue")
			return { status: "cancellation_enqueue_forbidden" };
		let opened: PrivateDetachedEffectOpenResultV1;
		try {
			opened = await this.#openDetachedEffect(request, row => {
				if (settlement.terminalStatus === "cancelled" && commit.disposition === "current_epoch_enqueue")
					return "cancellation_enqueue_forbidden";
				if (row.terminalReceipt !== null) return "already_terminal";
				const publication = detachedAttemptState(
					row,
					"settled_result_publication",
					row.settlement.settledResultOperationId,
				);
				if (publication?.state !== "applied" || publication.receipt === null) return "reservation_missing";
				if (
					!detachedCurrentAuthorityMatches(
						commit.currentAuthority,
						row.settlement,
						detachedOperationReceiptSha256(publication.receipt),
					)
				)
					return "authority_lost";
				const reservationAttempt = row.attempts.find(
					entry =>
						entry.state === "applied" &&
						entry.receipt !== null &&
						detachedOperationReceiptSha256(entry.receipt) === commit.reservation.receiptSha256,
				);
				if (reservationAttempt?.attempt.operation.stage !== "reservation") return "reservation_missing";
				if (
					!exactJson(reservationAttempt.receipt, commit.reservation) ||
					commit.reservation.disposition !== commit.disposition
				)
					return "reservation_conflict";
				if (
					row.attempts.some(
						entry =>
							entry.attempt.operation.stage === "reservation_release" &&
							entry.state === "applied" &&
							entry.attempt.operation.request.reservation.receiptSha256 === commit.reservation.receiptSha256,
					)
				)
					return "reservation_released";
				if (commit.disposition === "current_epoch_enqueue") {
					if (commit.sinkReceipt === null || commit.sinkReceiptSha256 === null) return "sink_receipt_required";
					const sinkAttempt = row.attempts.find(
						entry =>
							entry.attempt.operation.stage === "sink_enqueue" &&
							entry.state === "applied" &&
							entry.receipt !== null &&
							detachedOperationReceiptSha256(entry.receipt) === commit.sinkReceiptSha256,
					);
					if (!sinkAttempt || !exactJson(sinkAttempt.receipt, commit.sinkReceipt)) return "sink_receipt_conflict";
				} else if (commit.sinkReceipt !== null || commit.sinkReceiptSha256 !== null) return "sink_receipt_conflict";
				return null;
			});
		} catch {
			return {
				status: "commit_outcome_unknown",
				operationId: request.operation.operationId,
				requestSha256: request.operation.requestSha256,
				attemptSha256: request.expectedAttemptSha256,
				notAppliedReceiptSha256: request.expectedNotAppliedReceiptSha256,
			};
		}
		if (opened.status === "applied")
			return {
				status: "already_committed",
				receipt: opened.receipt as ConfidentialTransientTaskDetachedSettlementTerminalReceiptV1,
			};
		if (opened.status === "outcome_unknown")
			return { status: "commit_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		if (opened.status === "blocked") {
			if (opened.reason === "already_terminal") {
				try {
					const row = await this.#loadDetachedSettlement(commit.settlement);
					if (row?.terminalReceipt) return { status: "already_terminal", receipt: row.terminalReceipt };
				} catch {
					return { status: "invalid" };
				}
			}
			switch (opened.reason) {
				case "cancellation_enqueue_forbidden":
				case "reservation_missing":
				case "reservation_released":
				case "reservation_conflict":
				case "sink_receipt_required":
				case "sink_receipt_conflict":
				case "authority_lost":
				case "stale_owner_epoch":
				case "identity_conflict":
				case "request_conflict":
				case "invalid":
					return { status: opened.reason };
				default:
					return { status: "invalid" };
			}
		}
		if (opened.status !== "opened")
			return { status: opened.status === "absent" ? "reservation_missing" : "request_conflict" };
		const base = {
			schemaVersion: 1 as const,
			reservationReceiptSha256: commit.reservation.receiptSha256,
			commitOperationId: commit.commitOperationId,
			commitRequestSha256: commit.commitRequestSha256,
			currentAuthoritySha256: commit.currentAuthority.currentAuthoritySha256,
			committedAt: opened.attempt.notAppliedReceipt.storedAt,
		};
		let receipt: ConfidentialTransientTaskDetachedSettlementTerminalReceiptV1;
		if (commit.disposition === "hub_jobs_consumption") {
			if (
				commit.reservation.disposition !== "hub_jobs_consumption" ||
				commit.reservation.suppression.consumer !== "hub_jobs"
			)
				return { status: "invalid" };
			const terminalCore = {
				...base,
				identity: commit.settlement.identity,
				disposition: commit.disposition,
				parentDeliveryOutcome: "consumed_without_enqueue" as const,
				consumer: "hub_jobs" as const,
				suppression: { ...commit.reservation.suppression, consumer: "hub_jobs" as const },
			};
			receipt = {
				...terminalCore,
				receiptSha256: detachedDigest("terminal-settlement-receipt", terminalCore),
			};
		} else if (commit.disposition === "hub_wait_consumption") {
			if (
				commit.reservation.disposition !== "hub_wait_consumption" ||
				commit.reservation.suppression.consumer !== "hub_wait"
			)
				return { status: "invalid" };
			const terminalCore = {
				...base,
				identity: commit.settlement.identity,
				disposition: commit.disposition,
				parentDeliveryOutcome: "consumed_without_enqueue" as const,
				consumer: "hub_wait" as const,
				suppression: { ...commit.reservation.suppression, consumer: "hub_wait" as const },
			};
			receipt = {
				...terminalCore,
				receiptSha256: detachedDigest("terminal-settlement-receipt", terminalCore),
			};
		} else if (commit.disposition === "hub_cancel_consumption") {
			if (
				commit.reservation.disposition !== "hub_cancel_consumption" ||
				commit.reservation.suppression.consumer !== "hub_cancel"
			)
				return { status: "invalid" };
			const terminalCore = {
				...base,
				identity: commit.settlement.identity,
				disposition: commit.disposition,
				parentDeliveryOutcome: "consumed_without_enqueue" as const,
				consumer: "hub_cancel" as const,
				suppression: { ...commit.reservation.suppression, consumer: "hub_cancel" as const },
			};
			receipt = {
				...terminalCore,
				receiptSha256: detachedDigest("terminal-settlement-receipt", terminalCore),
			};
		} else if (commit.disposition === "current_epoch_enqueue") {
			const terminalCore = {
				...base,
				identity: commit.settlement.identity,
				disposition: commit.disposition,
				parentDeliveryOutcome: "delivered" as const,
				sinkReceipt: commit.sinkReceipt,
				sinkReceiptSha256: commit.sinkReceiptSha256,
			};
			receipt = {
				...terminalCore,
				receiptSha256: detachedDigest("terminal-settlement-receipt", terminalCore),
			};
		} else if (commit.disposition === "delivery_epoch_invalidation") {
			if (commit.currentAuthority.kind !== "epoch_invalidated") return { status: "invalid" };
			const terminalCore = {
				...base,
				identity: commit.settlement.identity,
				disposition: commit.disposition,
				parentDeliveryOutcome: "delivery_epoch_invalidated" as const,
				observedDeliveryEpoch: commit.currentAuthority.observedDeliveryEpoch,
				invalidationAuthoritySha256: commit.currentAuthority.invalidationAuthoritySha256,
			};
			receipt = {
				...terminalCore,
				receiptSha256: detachedDigest("terminal-settlement-receipt", terminalCore),
			};
		} else {
			if (commit.currentAuthority.kind !== "owner_absent") return { status: "invalid" };
			const terminalCore = {
				...base,
				identity: commit.settlement.identity,
				disposition: commit.disposition,
				parentDeliveryOutcome: "dead_lettered" as const,
				ownerAbsenceAuthoritySha256: commit.currentAuthority.ownerAbsenceAuthoritySha256,
			};
			receipt = {
				...terminalCore,
				receiptSha256: detachedDigest("terminal-settlement-receipt", terminalCore),
			};
		}
		try {
			const finished = await this.#finishDetachedEffect(request, receipt, receipt);
			return finished.status === "applied" || finished.status === "already_applied"
				? { status: finished.status === "applied" ? "committed" : "already_committed", receipt }
				: { status: "commit_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		} catch {
			return { status: "commit_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		}
	}

	async releaseReservation(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["releaseReservation"]>[0],
	): Promise<TransientTaskDetachedSettlementReleaseResultV1> {
		const release = request.operation.request;
		let opened: PrivateDetachedEffectOpenResultV1;
		try {
			opened = await this.#openDetachedEffect(request, row => {
				if (row.terminalReceipt !== null) return "already_terminal";
				const publication = detachedAttemptState(
					row,
					"settled_result_publication",
					row.settlement.settledResultOperationId,
				);
				if (publication?.state !== "applied" || publication.receipt === null) return "reservation_missing";
				if (
					!detachedCurrentAuthorityMatches(
						release.currentAuthority,
						row.settlement,
						detachedOperationReceiptSha256(publication.receipt),
					)
				)
					return "authority_lost";
				const reservationAttempt = row.attempts.find(
					entry =>
						entry.state === "applied" &&
						entry.receipt !== null &&
						detachedOperationReceiptSha256(entry.receipt) === release.reservation.receiptSha256,
				);
				if (reservationAttempt?.attempt.operation.stage !== "reservation") return "reservation_missing";
				if (!exactJson(reservationAttempt.receipt, release.reservation)) return "request_conflict";
				return null;
			});
		} catch {
			return {
				status: "release_outcome_unknown",
				operationId: request.operation.operationId,
				requestSha256: request.operation.requestSha256,
				attemptSha256: request.expectedAttemptSha256,
				notAppliedReceiptSha256: request.expectedNotAppliedReceiptSha256,
			};
		}
		if (opened.status === "applied")
			return {
				status: "already_released",
				receipt: opened.receipt as ConfidentialTransientTaskDetachedSettlementReleaseReceiptV1,
			};
		if (opened.status === "outcome_unknown")
			return { status: "release_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		if (opened.status === "blocked") {
			if (opened.reason === "already_terminal") {
				try {
					const row = await this.#loadDetachedSettlement(release.settlement);
					if (row?.terminalReceipt)
						return { status: "already_terminal", terminalReceiptSha256: row.terminalReceipt.receiptSha256 };
				} catch {
					return { status: "invalid" };
				}
			}
			switch (opened.reason) {
				case "reservation_missing":
				case "authority_lost":
				case "identity_conflict":
				case "request_conflict":
				case "invalid":
					return { status: opened.reason };
				default:
					return { status: "invalid" };
			}
		}
		if (opened.status !== "opened")
			return { status: opened.status === "absent" ? "reservation_missing" : "request_conflict" };
		const core = {
			schemaVersion: 1 as const,
			identity: release.settlement.identity,
			reservationReceiptSha256: release.reservation.receiptSha256,
			releaseOperationId: release.releaseOperationId,
			reason: release.reason,
			releaseRequestSha256: release.releaseRequestSha256,
			releasedAt: opened.attempt.notAppliedReceipt.storedAt,
		};
		const receipt: ConfidentialTransientTaskDetachedSettlementReleaseReceiptV1 = {
			...core,
			receiptSha256: detachedDigest("reservation-release-receipt", core),
		};
		try {
			const finished = await this.#finishDetachedEffect(request, receipt, null);
			return finished.status === "applied" || finished.status === "already_applied"
				? { status: finished.status === "applied" ? "released" : "already_released", receipt }
				: { status: "release_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		} catch {
			return { status: "release_outcome_unknown", ...this.#detachedOutcomeUnknown(opened.attempt) };
		}
	}

	async #inspectDetached(
		request:
			| TransientTaskDetachedSettlementInspectRequestV1
			| TransientTaskDetachedCancellationSettlementInspectRequestV1,
	): Promise<TransientTaskDetachedSettlementInspectResultV1> {
		if (!proxyFreeData(request)) return { status: "invalid" };
		const cancellation = strictRecord(request, [
			"identitySha256",
			"stage",
			"operationId",
			"expectedRequestSha256",
			"expectedAttemptSha256",
			"expectedTerminalStatus",
			"expectedCancellationKind",
			"expectedJobErrorTextUtf8Sha256",
			"expectedJobErrorTextUtf8ByteLength",
			"expectedCancellationIdentitySha256",
		]);
		if (
			!cancellation &&
			!strictRecord(request, [
				"identitySha256",
				"stage",
				"operationId",
				"expectedRequestSha256",
				"expectedAttemptSha256",
			])
		)
			return { status: "invalid" };
		if (
			!validResultStoreSha256Ref(request.identitySha256) ||
			!validResultStoreIdentity(request.operationId) ||
			!validResultStoreSha256Hex(request.expectedRequestSha256) ||
			!validResultStoreSha256Ref(request.expectedAttemptSha256) ||
			!isOneOf(request.stage, [
				"settled_result_publication",
				"reservation",
				"sink_enqueue",
				"terminal_commit",
				"reservation_release",
			])
		)
			return { status: "invalid" };
		if (
			cancellation &&
			(request.stage !== "settled_result_publication" ||
				request.expectedTerminalStatus !== "cancelled" ||
				request.expectedCancellationKind !== "detached_pre_execution_abort" ||
				!validResultStoreSha256Ref(request.expectedJobErrorTextUtf8Sha256) ||
				!validResultStoreInteger(request.expectedJobErrorTextUtf8ByteLength) ||
				request.expectedCancellationIdentitySha256 !== request.identitySha256)
		)
			return { status: "invalid" };
		const absent = {
			status: "absent" as const,
			identitySha256: request.identitySha256,
			stage: request.stage,
			operationId: request.operationId,
			requestSha256: request.expectedRequestSha256,
			attemptSha256: request.expectedAttemptSha256,
		};
		try {
			const locatorInput = await this.#durable.inspect(
				TRANSIENT_NAMESPACE,
				detachedIdentityLocatorKey(request.identitySha256),
			);
			if (locatorInput === null) return absent;
			if (!validDetachedIdentityLocator(locatorInput) || locatorInput.identitySha256 !== request.identitySha256)
				return { status: "conflict" };
			const taskKey = { taskId: locatorInput.taskId, runId: locatorInput.runId };
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			const stored = state.parentDeliveries[detachedStoreMapKey(request.identitySha256)];
			if (stored === undefined) return absent;
			const row = loadDetachedRow<PrivateDetachedSettlementRowV1>(stored);
			if (row.kind !== "detached_settlement" || row.identitySha256 !== request.identitySha256)
				return { status: "conflict" };
			if (
				cancellation &&
				(row.settlement.terminalStatus !== "cancelled" ||
					row.settlement.identity.jobErrorTextUtf8Sha256 !== request.expectedJobErrorTextUtf8Sha256 ||
					row.settlement.identity.jobErrorTextUtf8ByteLength !== request.expectedJobErrorTextUtf8ByteLength ||
					row.settlement.identity.identitySha256 !== request.expectedCancellationIdentitySha256)
			)
				return { status: "conflict" };
			const attempt = detachedAttemptState(row, request.stage, request.operationId);
			if (!attempt) return absent;
			if (
				attempt.attempt.requestSha256 !== request.expectedRequestSha256 ||
				attempt.attempt.attemptSha256 !== request.expectedAttemptSha256
			)
				return { status: "conflict" };
			const binding = {
				identitySha256: request.identitySha256,
				stage: request.stage,
				operationId: request.operationId,
				attemptSha256: attempt.attempt.attemptSha256,
				notAppliedReceiptSha256: attempt.notAppliedReceipt.receiptSha256,
				requestSha256: attempt.attempt.requestSha256,
			};
			if (attempt.state === "not_applied") return { status: "not_applied", ...binding };
			if (attempt.state === "outcome_unknown") return { status: "outcome_unknown", ...binding };
			return attempt.receipt === null
				? { status: "invalid" }
				: { status: "matching", ...binding, receiptSha256: detachedOperationReceiptSha256(attempt.receipt) };
		} catch {
			return { status: "invalid" };
		}
	}

	async #adoptDetached(
		request:
			| ConfidentialTransientTaskDetachedSettlementAdoptRequestV1
			| ConfidentialTransientTaskDetachedCancellationSettlementAdoptRequestV1,
	): Promise<
		| ConfidentialTransientTaskDetachedSettlementAdoptResultV1
		| ConfidentialTransientTaskDetachedCancellationSettlementAdoptResultV1
	> {
		if (!proxyFreeData(request)) return { status: "invalid" };
		const cancellation = strictRecord(request, [
			"identitySha256",
			"stage",
			"operationId",
			"expectedRequestSha256",
			"expectedAttemptSha256",
			"expectedIdentity",
			"expectedOperation",
			"expectedAttempt",
			"expectedNotAppliedReceiptSha256",
			"expectedReceiptSha256",
			"expectedCurrentAuthority",
			"expectedTerminalStatus",
			"expectedJobErrorTextUtf8Sha256",
			"expectedJobErrorTextUtf8ByteLength",
			"expectedCancellationIdentitySha256",
		]);
		if (
			!cancellation &&
			!strictRecord(request, [
				"identitySha256",
				"stage",
				"operationId",
				"expectedRequestSha256",
				"expectedAttemptSha256",
				"expectedIdentity",
				"expectedOperation",
				"expectedAttempt",
				"expectedNotAppliedReceiptSha256",
				"expectedReceiptSha256",
				"expectedCurrentAuthority",
			])
		)
			return { status: "invalid" };
		if (
			!validDetachedIdentity(request.expectedIdentity) ||
			!(await validDetachedOperation(request.expectedOperation)) ||
			!(await validDetachedAttempt(request.expectedAttempt)) ||
			request.expectedIdentity.identitySha256 !== request.identitySha256 ||
			request.expectedOperation.stage !== request.stage ||
			request.expectedOperation.operationId !== request.operationId ||
			request.expectedOperation.requestSha256 !== request.expectedRequestSha256 ||
			request.expectedAttempt.attemptSha256 !== request.expectedAttemptSha256 ||
			!exactJson(request.expectedAttempt.operation, request.expectedOperation) ||
			!validResultStoreSha256Ref(request.expectedNotAppliedReceiptSha256) ||
			(request.expectedReceiptSha256 !== null && !validResultStoreSha256Ref(request.expectedReceiptSha256))
		)
			return { status: "invalid" };
		if (
			cancellation &&
			(request.expectedTerminalStatus !== "cancelled" ||
				!validResultStoreSha256Ref(request.expectedJobErrorTextUtf8Sha256) ||
				!validResultStoreInteger(request.expectedJobErrorTextUtf8ByteLength) ||
				request.expectedCancellationIdentitySha256 !== request.identitySha256)
		)
			return { status: "invalid" };
		const settlement = detachedSettlementFromOperation(request.expectedOperation);
		if (!exactJson(settlement.identity, request.expectedIdentity)) return { status: "conflict" };
		const taskKey = detachedTaskKey(settlement);
		try {
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			const stored = state.parentDeliveries[detachedStoreMapKey(request.identitySha256)];
			if (stored === undefined) return { status: "absent" };
			const row = loadDetachedRow<PrivateDetachedSettlementRowV1>(stored);
			if (
				row.kind !== "detached_settlement" ||
				!exactJson(row.settlement, settlement) ||
				(cancellation &&
					(row.settlement.terminalStatus !== "cancelled" ||
						row.settlement.identity.jobErrorTextUtf8Sha256 !== request.expectedJobErrorTextUtf8Sha256 ||
						row.settlement.identity.jobErrorTextUtf8ByteLength !== request.expectedJobErrorTextUtf8ByteLength))
			)
				return { status: "conflict" };
			const attempt = detachedAttemptState(row, request.stage, request.operationId);
			if (
				!attempt ||
				!exactJson(attempt.attempt, request.expectedAttempt) ||
				attempt.notAppliedReceipt.receiptSha256 !== request.expectedNotAppliedReceiptSha256
			)
				return { status: "conflict" };
			if (request.stage === "settled_result_publication") {
				if (request.expectedCurrentAuthority !== null) return { status: "conflict" };
			} else {
				const publication = detachedAttemptState(
					row,
					"settled_result_publication",
					row.settlement.settledResultOperationId,
				);
				if (
					request.expectedCurrentAuthority === null ||
					publication?.state !== "applied" ||
					publication.receipt === null ||
					!detachedCurrentAuthorityMatches(
						request.expectedCurrentAuthority,
						row.settlement,
						detachedOperationReceiptSha256(publication.receipt),
					)
				)
					return { status: "authority_lost" };
				if (request.expectedCurrentAuthority.kind === "current_owner_epoch") {
					const current = await this.#currentParentRequest(
						state,
						row.settlement.parentDeliveryRequest,
						this.#now(),
					);
					if (current.status !== "current") return { status: "authority_lost" };
				}
			}
			if (attempt.state === "not_applied") {
				if (request.expectedReceiptSha256 !== null) return { status: "conflict" };
				return { status: "not_applied", attempt: attempt.attempt, notAppliedReceipt: attempt.notAppliedReceipt };
			}
			if (attempt.state === "outcome_unknown") {
				if (request.expectedReceiptSha256 !== null) return { status: "conflict" };
				return {
					status: "outcome_unknown",
					attempt: attempt.attempt,
					notAppliedReceipt: attempt.notAppliedReceipt,
				};
			}
			if (
				attempt.receipt === null ||
				request.expectedReceiptSha256 !== detachedOperationReceiptSha256(attempt.receipt)
			)
				return { status: "conflict" };
			return { status: "adopted", attempt: attempt.attempt, receipt: attempt.receipt };
		} catch {
			return { status: "invalid" };
		}
	}

	async #deliverDetachedParent(
		effect: PrivateDetachedParentDeliveryEffectRequestV1,
		terminalReceipt: ConfidentialTransientTaskDetachedSettlementTerminalReceiptV1,
	): ReturnType<TransientTaskParentResultDeliveryStoreV1["deliver"]> {
		const request = effect.request;
		const taskKey = { taskId: request.taskId, runId: request.runId };
		try {
			return await this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
				let state: TransientTaskRuntimeStateV1;
				try {
					state = transientRuntimeState(taskKey, currentInput);
				} catch {
					return { state: currentInput, result: { status: "invalid" } as const };
				}
				let parent: PrivateParentDeliveryRowV1 | null;
				try {
					parent = await parentDeliveryRow(state.parentDeliveries[parentDeliveryMapKey(request)]);
				} catch {
					return { state, result: { status: "invalid" } as const };
				}
				if (!parent) return { state, result: { status: "delivery_not_prepared" } as const };
				if (!exactJson(parent.attempt.request, request))
					return { state, result: parentDeliveryConflict(parent.attempt.request, request) };
				if (parent.attempt.attemptSha256 !== effect.expectedAttemptSha256)
					return { state, result: { status: "same_id_different_delivery" } as const };
				if (parent.state === "terminal")
					return { state, result: parentDeliveryTerminalResult(parent.receipt, true) };
				const detachedInput = state.parentDeliveries[detachedStoreMapKey(terminalReceipt.identity.identitySha256)];
				if (detachedInput === undefined) return { state, result: { status: "route_missing" } as const };
				let detached: PrivateDetachedSettlementRowV1;
				try {
					detached = loadDetachedRow<PrivateDetachedSettlementRowV1>(detachedInput);
				} catch {
					return { state, result: { status: "invalid" } as const };
				}
				if (
					!strictRecord(detached, ["kind", "identitySha256", "settlement", "attempts", "terminalReceipt"]) ||
					detached.kind !== "detached_settlement" ||
					!strictArray(detached.attempts) ||
					detached.identitySha256 !== terminalReceipt.identity.identitySha256 ||
					detached.terminalReceipt === null ||
					!exactJson(detached.terminalReceipt, terminalReceipt) ||
					!(await validDetachedSettlement(detached.settlement)) ||
					!exactJson(detached.settlement.parentDeliveryRequest, request) ||
					!validDetachedTerminalReceiptForParent(terminalReceipt, request)
				)
					return { state, result: { status: "route_conflict" } as const };
				const receiptBase = parentDeliveryReceiptBase(
					request,
					parent.attempt.attemptSha256,
					terminalReceipt.committedAt,
				);
				let receipt: PrivateParentDeliveryReceiptV1;
				if (terminalReceipt.parentDeliveryOutcome === "delivered") {
					const receiptCore: Omit<
						Extract<
							TransientTaskParentResultDeliveryReceiptV1,
							{ outcome: "delivered"; routeKind: "owner_routed_async_result" }
						>,
						"receiptSha256"
					> = {
						...receiptBase,
						outcome: "delivered",
						routeKind: "owner_routed_async_result",
						sinkReceiptSha256: terminalReceipt.sinkReceiptSha256,
						foregroundSettlementIdentitySha256: null,
						foregroundPrimaryReceiptSha256: null,
						foregroundBatchTransitionReceiptSha256: null,
						detachedSettlement: terminalReceipt,
					};
					receipt = {
						...receiptCore,
						receiptSha256: await tupleRef(parentDeliveryReceiptTuple(receiptCore)),
					};
				} else if (terminalReceipt.parentDeliveryOutcome === "consumed_without_enqueue") {
					const receiptCore: Omit<
						Extract<TransientTaskParentResultDeliveryReceiptV1, { outcome: "consumed_without_enqueue" }>,
						"receiptSha256"
					> = {
						...receiptBase,
						outcome: "consumed_without_enqueue",
						routeKind: "owner_routed_async_result",
						sinkReceiptSha256: null,
						foregroundSettlementIdentitySha256: null,
						foregroundPrimaryReceiptSha256: null,
						foregroundBatchTransitionReceiptSha256: null,
						detachedSettlement: terminalReceipt,
					};
					receipt = {
						...receiptCore,
						receiptSha256: await tupleRef(parentDeliveryReceiptTuple(receiptCore)),
					};
				} else if (terminalReceipt.parentDeliveryOutcome === "delivery_epoch_invalidated") {
					const receiptCore: Omit<
						Extract<
							ConfidentialTransientTaskParentResultNonDeliveryReceiptV1,
							{ outcome: "delivery_epoch_invalidated" }
						>,
						"receiptSha256"
					> = {
						...receiptBase,
						outcome: "delivery_epoch_invalidated",
						routeKind: "owner_routed_async_result",
						detachedSettlement: terminalReceipt,
					};
					receipt = {
						...receiptCore,
						receiptSha256: await tupleRef(parentDeliveryReceiptTuple(receiptCore)),
					};
				} else {
					const receiptCore: Omit<
						Extract<ConfidentialTransientTaskParentResultNonDeliveryReceiptV1, { outcome: "dead_lettered" }>,
						"receiptSha256"
					> = {
						...receiptBase,
						outcome: "dead_lettered",
						routeKind: "owner_routed_async_result",
						detachedSettlement: terminalReceipt,
					};
					receipt = {
						...receiptCore,
						receiptSha256: await tupleRef(parentDeliveryReceiptTuple(receiptCore)),
					};
				}
				return {
					state: {
						...state,
						parentDeliveries: {
							...state.parentDeliveries,
							[parentDeliveryMapKey(request)]: {
								state: "terminal",
								attempt: parent.attempt,
								receipt,
							} satisfies PrivateParentDeliveryRowV1,
						},
					},
					result: parentDeliveryTerminalResult(receipt, false),
				};
			});
		} catch {
			return { status: "invalid" };
		}
	}

	async #deliverForegroundParent(
		effect: PrivateForegroundParentDeliveryEffectRequestV1,
	): ReturnType<TransientTaskParentResultDeliveryStoreV1["deliver"]> {
		const request = effect.request;
		const context = effect.foregroundContext;
		const taskKey = { taskId: request.taskId, runId: request.runId };
		try {
			return await this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
				let state: TransientTaskRuntimeStateV1;
				try {
					state = transientRuntimeState(taskKey, currentInput);
				} catch {
					return { state: currentInput, result: { status: "invalid" } as const };
				}
				let parent: PrivateParentDeliveryRowV1 | null;
				try {
					parent = await parentDeliveryRow(state.parentDeliveries[parentDeliveryMapKey(request)]);
				} catch {
					return { state, result: { status: "invalid" } as const };
				}
				if (!parent) return { state, result: { status: "delivery_not_prepared" } as const };
				if (!exactJson(parent.attempt.request, request))
					return { state, result: parentDeliveryConflict(parent.attempt.request, request) };
				if (parent.attempt.attemptSha256 !== effect.expectedAttemptSha256)
					return { state, result: { status: "same_id_different_delivery" } as const };
				if (parent.state === "terminal")
					return { state, result: parentDeliveryTerminalResult(parent.receipt, true) };
				if (parent.state !== "outcome_unknown")
					return { state, result: { status: "delivery_not_prepared" } as const };
				const memberInput = state.parentDeliveries[foregroundMemberMapKey(request)];
				if (memberInput === undefined) return { state, result: { status: "route_missing" } as const };
				let member: PrivateForegroundMemberRowV1;
				try {
					member = loadForegroundValue<PrivateForegroundMemberRowV1>(memberInput);
				} catch {
					return { state, result: { status: "invalid" } as const };
				}
				if (
					!strictRecord(member, ["kind", "foregroundAppendBatchKeySha256", "memberIndex"]) ||
					member.kind !== "foreground_member" ||
					!validResultStoreInteger(member.memberIndex)
				)
					return { state, result: { status: "route_conflict" } as const };
				let batchRow: PrivateForegroundBatchRowV1 | null;
				let append: PrivateForegroundAppendRowV1 | null;
				try {
					batchRow = this.#foregroundBatchRow(state, member.foregroundAppendBatchKeySha256);
					append = this.#foregroundAppendRow(state, member.foregroundAppendBatchKeySha256);
				} catch {
					return { state, result: { status: "invalid" } as const };
				}
				if (!batchRow || !append) return { state, result: { status: "route_missing" } as const };
				const domain = foregroundBatchDomain(batchRow.batch);
				if (
					!domain ||
					domain.taskId !== request.taskId ||
					domain.runId !== request.runId ||
					domain.parentSessionId !== request.route.parentSessionId ||
					batchRow.batch.foregroundAppendBatchKeySha256 !== member.foregroundAppendBatchKeySha256 ||
					!exactJson(storeForegroundValue(append.batch.handoffBatch), storeForegroundValue(batchRow.batch))
				)
					return { state, result: { status: "route_conflict" } as const };
				const batchRequest: ConfidentialTransientTaskForegroundAppendDeliveryBatchRequestV1 = {
					schemaVersion: 1,
					append: {
						batch: append.batch,
						expectedAttemptSha256s: append.attempts.map(attempt => attempt.attemptSha256) as [
							Sha256Ref,
							...Sha256Ref[],
						],
						expectedNotAppliedProofSha256s: append.notAppliedProofs.map(proof => proof.proofSha256) as [
							Sha256Ref,
							...Sha256Ref[],
						],
					},
					parentDeliveryAttempts: append.parentDeliveryAttempts as [
						ConfidentialTransientTaskParentResultDeliveryAttemptV1,
						...ConfidentialTransientTaskParentResultDeliveryAttemptV1[],
					],
					transitionRequestedAt: context.batchTransitionReceipt.transitionedImmediatelyBeforeDispatchAt,
					coordinatorRequestSha256: context.coordinatorRequestSha256,
				};
				const joined = await this.#joinForegroundAppendDeliveryBatch(state, batchRequest, domain);
				if (joined.status !== "matching")
					return {
						state,
						result: {
							status:
								joined.status === "delivery_not_prepared"
									? "delivery_not_prepared"
									: joined.status === "append_not_prepared"
										? "route_missing"
										: joined.status === "invalid"
											? "invalid"
											: "route_conflict",
						} as const,
					};
				append = joined.joined.append;
				const joinedParent = joined.joined.parents[member.memberIndex];
				const appendRequest = append.batch.requests[member.memberIndex];
				const preReturnIdentity = batchRow.batch.orderedPreReturnIdentities[member.memberIndex];
				const derivation = request.parentDeliveryEffectDerivationDescriptorOrNull.derivation;
				if (
					joinedParent?.state !== "outcome_unknown" ||
					!exactJson(joinedParent.attempt, parent.attempt) ||
					!appendRequest ||
					!preReturnIdentity ||
					derivation.domain !== "foreground_settlement" ||
					derivation.selectorBinding.foregroundMemberIndex !== member.memberIndex ||
					preReturnIdentity.core.foregroundMemberIndex !== member.memberIndex ||
					preReturnIdentity.core.parentSessionId !== request.route.parentSessionId ||
					preReturnIdentity.core.toolCallId !== request.route.toolCallId ||
					!resultTargetKeyMatches(preReturnIdentity.core, request) ||
					preReturnIdentity.core.deliveryOperationId !== request.deliveryOperationId ||
					appendRequest.identity.identitySha256 !== context.settlementIdentitySha256 ||
					appendRequest.identity.core.preReturnIdentitySha256 !== preReturnIdentity.preReturnIdentitySha256 ||
					appendRequest.identity.core.deliveryRequestSha256 !== request.deliveryRequestSha256 ||
					appendRequest.identity.core.deliveryAuthoritySha256 !== request.deliveryAuthoritySha256 ||
					!exactJson(appendRequest.identity.core.deliveryAuthority, request.deliveryAuthority) ||
					!exactJson(appendRequest.identity.core.sinkProjection, request.sinkProjection) ||
					append.parentDeliveryAttempts[member.memberIndex]?.attemptSha256 !== effect.expectedAttemptSha256 ||
					append.batchTransitionReceipt === null ||
					context.coordinatorRequestSha256 !== context.batchTransitionReceipt.coordinatorRequestSha256 ||
					!exactJson(append.batchTransitionReceipt, context.batchTransitionReceipt) ||
					joined.joined.parents.some(candidate => candidate.state === "not_applied") ||
					joined.joined.parents.some(
						candidate => candidate.state === "terminal" && candidate.receipt.outcome !== "delivered",
					) ||
					!validForegroundPrimaryReceipt(context.primaryReceipt, append) ||
					(append.primaryReceipt !== null && !exactJson(append.primaryReceipt, context.primaryReceipt)) ||
					Date.parse(context.primaryReceipt.committedAt) <
						Date.parse(context.batchTransitionReceipt.transitionedImmediatelyBeforeDispatchAt)
				)
					return { state, result: { status: "route_conflict" } as const };
				const current = await this.#currentParentRequest(state, request, this.#now());
				if (current.status !== "current")
					return {
						state,
						result:
							current.status === "target_missing"
								? ({ status: "target_missing" } as const)
								: current.status === "stale_live_receipt"
									? ({ status: "stale_live_receipt" } as const)
									: current.status === "authority_lost"
										? ({ status: "authority_lost" } as const)
										: current,
					};
				const authorityJoinSha256 = await tupleRef([
					"omp-transient-task-parent-result-delivery-v1",
					"foreground-authority-join",
					1,
					request.deliveryAuthoritySha256,
					context.settlementIdentitySha256,
					context.batchTransitionReceipt.receiptSha256,
					context.primaryReceipt.primaryReceiptSha256,
				]);
				const sinkCore = {
					schemaVersion: 1 as const,
					deliveryOperationId: request.deliveryOperationId,
					deliveryRequestSha256: request.deliveryRequestSha256,
					deliveryAuthoritySha256: request.deliveryAuthoritySha256,
					sinkResultUtf8: request.sinkProjection.core.sinkResultUtf8,
					sinkResultUtf8Sha256: request.sinkResultUtf8Sha256,
					sinkResultUtf8ByteLength: request.sinkResultUtf8ByteLength,
					authorityJoinSha256,
					appliedAt: context.primaryReceipt.committedAt,
					routeKind: "foreground_tool_call" as const,
					foregroundSessionAppendReceipt: context.primaryReceipt,
					detachedSettlementIdentity: null,
					detachedCurrentAuthoritySha256: null,
					reservationReceiptSha256: null,
					detachedSessionOutboxReceipt: null,
					detachedPrimarySessionPersistenceReceipt: null,
				};
				const sinkReceipt: Extract<
					ConfidentialTransientTaskParentResultSinkReceiptV1,
					{ routeKind: "foreground_tool_call" }
				> = {
					...sinkCore,
					sinkReceiptSha256: detachedDigest("parent-result-sink-receipt", sinkCore),
				};
				const receiptBase = parentDeliveryReceiptBase(
					request,
					parent.attempt.attemptSha256,
					context.primaryReceipt.committedAt,
				);
				const receiptCore = {
					...receiptBase,
					outcome: "delivered" as const,
					routeKind: "foreground_tool_call" as const,
					sinkReceiptSha256: sinkReceipt.sinkReceiptSha256,
					foregroundSettlementIdentitySha256: context.settlementIdentitySha256,
					foregroundAppendBatchKeySha256: append.batch.foregroundAppendBatchKeySha256,
					foregroundPrimaryReceiptSha256: context.primaryReceipt.primaryReceiptSha256,
					foregroundBatchTransitionReceiptSha256: context.batchTransitionReceipt.receiptSha256,
					detachedSettlement: null,
				};
				const receipt: Extract<TransientTaskParentResultDeliveryReceiptV1, { outcome: "delivered" }> = {
					...receiptCore,
					receiptSha256: await tupleRef(parentDeliveryReceiptTuple(receiptCore)),
				};
				const nextAppend: PrivateForegroundAppendRowV1 = { ...append, primaryReceipt: context.primaryReceipt };
				return {
					state: {
						...state,
						parentDeliveries: {
							...state.parentDeliveries,
							[foregroundAppendMapKey(append.batch.foregroundAppendBatchKeySha256)]:
								storeForegroundValue(nextAppend),
							[parentDeliveryMapKey(request)]: {
								state: "terminal",
								attempt: parent.attempt,
								receipt,
							} satisfies PrivateParentDeliveryRowV1,
						},
					},
					result: { status: "delivered", receipt } as const,
				};
			});
		} catch {
			return { status: "invalid" };
		}
	}

	async deliver(
		effect: PrivateParentDeliveryEffectRequestV1,
	): ReturnType<TransientTaskParentResultDeliveryStoreV1["deliver"]> {
		if (!payloadPlainData(effect)) return { status: "invalid" };
		const carriesForegroundContext = Object.hasOwn(effect, "foregroundContext");
		if (
			!strictRecord(
				effect,
				carriesForegroundContext
					? ["request", "expectedAttemptSha256", "foregroundContext"]
					: ["request", "expectedAttemptSha256"],
			) ||
			!validResultStoreSha256Ref(effect.expectedAttemptSha256)
		)
			return { status: "invalid" };
		const key = resultTargetKeyFromRecord(effect.request);
		if (
			!key ||
			!(await validParentDeliveryRequest(effect.request, key)) ||
			!parentDeliverySinkProjectionMatches(effect.request)
		)
			return { status: "invalid" };
		if (effect.request.route.kind === "foreground_tool_call") {
			if (
				!carriesForegroundContext ||
				!strictRecord(effect.foregroundContext, [
					"coordinatorRequestSha256",
					"settlementIdentitySha256",
					"batchTransitionReceipt",
					"primaryReceipt",
				]) ||
				!validResultStoreSha256Ref(effect.foregroundContext.coordinatorRequestSha256) ||
				!validResultStoreSha256Ref(effect.foregroundContext.settlementIdentitySha256)
			)
				return { status: "invalid" };
			return this.#deliverForegroundParent(effect as PrivateForegroundParentDeliveryEffectRequestV1);
		}
		if (carriesForegroundContext) return { status: "invalid" };
		const detached = effect as PrivateDetachedParentDeliveryEffectRequestV1;
		const resolved = await this.#resolveDetachedTerminalForParentDelivery(
			detached.request,
			detached.expectedAttemptSha256,
		);
		if (resolved.status === "outcome_unknown") return { status: "delivery_outcome_unknown" };
		if (resolved.status === "absent") return { status: "route_missing" };
		if (resolved.status === "conflict") return { status: "route_conflict" };
		if (resolved.status === "parent_terminal") return parentDeliveryTerminalResult(resolved.receipt, true);
		if (resolved.status !== "terminal") return { status: "invalid" };
		return this.#deliverDetachedParent(detached, resolved.receipt);
	}

	async #inspectParent(request: TransientTaskParentResultDeliveryInspectRequestV1) {
		if (!parentDeliveryInspectRequest(request)) return { status: "invalid" } as const;
		const key = resultTargetKeyFromRecord(request);
		if (!key) return { status: "invalid" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		let state: TransientTaskRuntimeStateV1;
		try {
			state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
		} catch {
			return { status: "invalid" } as const;
		}
		let row: PrivateParentDeliveryRowV1 | null;
		try {
			row = await parentDeliveryRow(state.parentDeliveries[parentDeliveryMapKey(key)]);
		} catch {
			return { status: "invalid" } as const;
		}
		if (!row)
			return {
				status: "absent",
				resultPublicationTargetId: request.resultPublicationTargetId,
				resultPublicationId: request.resultPublicationId,
				deliveryOperationId: request.deliveryOperationId,
			} as const;
		if (
			row.attempt.attemptSha256 !== request.expectedAttemptSha256 ||
			!parentDeliveryRequestMatchesInspect(row.attempt.request, request)
		)
			return { status: "conflict" } as const;
		if (row.state !== "terminal")
			return {
				status: row.state,
				attemptSha256: row.attempt.attemptSha256,
				deliveryAuthoritySha256: row.attempt.request.deliveryAuthoritySha256,
				deliveryRequestSha256: row.attempt.request.deliveryRequestSha256,
				deliveryPayloadTupleSha256: row.attempt.request.deliveryPayloadTupleSha256,
			} as const;
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
		} as const;
	}

	async #adoptParent(request: ConfidentialTransientTaskParentResultDeliveryAdoptRequestV1) {
		if (
			!proxyFreeData(request) ||
			!strictRecord(request, [
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
				"deliveryAuthority",
				"expectedReceiptSha256",
			]) ||
			!validResultStoreSha256Ref(request.deliveryAuthoritySha256) ||
			(request.expectedReceiptSha256 !== null && !validResultStoreSha256Ref(request.expectedReceiptSha256))
		)
			return { status: "invalid" } as const;
		const key = resultTargetKeyFromRecord(request);
		const inspectRequest = (({ deliveryAuthority: _authority, expectedReceiptSha256: _receipt, ...rest }) => rest)(
			request,
		);
		if (
			!key ||
			!parentDeliveryInspectRequest(inspectRequest) ||
			!(await validParentDeliveryAdoptAuthority(request.deliveryAuthority, key, inspectRequest))
		)
			return { status: "invalid" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			let state: TransientTaskRuntimeStateV1;
			try {
				state = transientRuntimeState(taskKey, currentInput);
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
			let row: PrivateParentDeliveryRowV1 | null;
			try {
				row = await parentDeliveryRow(state.parentDeliveries[parentDeliveryMapKey(key)]);
			} catch {
				return { state, result: { status: "invalid" } as const };
			}
			if (!row) return { state, result: { status: "absent" } as const };
			if (
				row.attempt.attemptSha256 !== request.expectedAttemptSha256 ||
				!parentDeliveryRequestMatchesInspect(row.attempt.request, request) ||
				!exactJson(row.attempt.request.deliveryAuthority, request.deliveryAuthority)
			)
				return { state, result: { status: "conflict" } as const };
			const current = await this.#currentParentRequest(state, row.attempt.request, this.#now());
			if (current.status !== "current")
				return {
					state,
					result:
						current.status === "target_missing"
							? ({ status: "absent" } as const)
							: current.status === "stale_live_receipt"
								? ({ status: "stale_live_receipt" } as const)
								: current.status === "authority_lost"
									? ({ status: "authority_lost" } as const)
									: ({ status: "conflict" } as const),
				};
			if (row.state !== "terminal") {
				if (request.expectedReceiptSha256 !== null) return { state, result: { status: "conflict" } as const };
				return { state, result: { status: row.state, attempt: row.attempt } as const };
			}
			if (request.expectedReceiptSha256 !== row.receipt.receiptSha256)
				return { state, result: { status: "conflict" } as const };
			return row.receipt.outcome === "delivery_epoch_invalidated" || row.receipt.outcome === "dead_lettered"
				? {
						state,
						result: { status: "terminal_non_delivery", attempt: row.attempt, receipt: row.receipt } as const,
					}
				: { state, result: { status: "adopted", attempt: row.attempt, receipt: row.receipt } as const };
		});
	}
	inspect(
		request: TransientTaskForegroundResultSettlementInspectRequestV1,
	): Promise<TransientTaskForegroundResultSettlementInspectResultV1>;
	inspect(
		request: TransientTaskDetachedCancellationSettlementInspectRequestV1,
	): Promise<TransientTaskDetachedSettlementInspectResultV1>;
	inspect(
		request: TransientTaskDetachedSettlementInspectRequestV1,
	): Promise<TransientTaskDetachedSettlementInspectResultV1>;
	inspect(
		request: TransientTaskParentResultDeliveryInspectRequestV1,
	): Promise<TransientTaskParentResultDeliveryInspectResultV1>;
	async inspect(
		request:
			| TransientTaskForegroundResultSettlementInspectRequestV1
			| TransientTaskDetachedCancellationSettlementInspectRequestV1
			| TransientTaskDetachedSettlementInspectRequestV1
			| TransientTaskParentResultDeliveryInspectRequestV1,
	): Promise<
		| TransientTaskForegroundResultSettlementInspectResultV1
		| TransientTaskDetachedSettlementInspectResultV1
		| TransientTaskParentResultDeliveryInspectResultV1
	> {
		if (!proxyFreeData(request)) return { status: "invalid" } as const;
		if ("foregroundAppendBatchKeySha256" in request) return this.#inspectForeground(request);
		if ("identitySha256" in request) return this.#inspectDetached(request);
		return this.#inspectParent(request);
	}

	adopt(
		request: ConfidentialTransientTaskForegroundResultSettlementAdoptRequestV1,
	): Promise<ConfidentialTransientTaskForegroundResultSettlementAdoptResultV1>;
	adopt(
		request: ConfidentialTransientTaskDetachedCancellationSettlementAdoptRequestV1,
	): Promise<ConfidentialTransientTaskDetachedCancellationSettlementAdoptResultV1>;
	adopt(
		request: ConfidentialTransientTaskDetachedSettlementAdoptRequestV1,
	): Promise<ConfidentialTransientTaskDetachedSettlementAdoptResultV1>;
	adopt(
		request: ConfidentialTransientTaskParentResultDeliveryAdoptRequestV1,
	): Promise<ConfidentialTransientTaskParentResultDeliveryAdoptResultV1>;
	async adopt(
		request:
			| ConfidentialTransientTaskForegroundResultSettlementAdoptRequestV1
			| ConfidentialTransientTaskDetachedCancellationSettlementAdoptRequestV1
			| ConfidentialTransientTaskDetachedSettlementAdoptRequestV1
			| ConfidentialTransientTaskParentResultDeliveryAdoptRequestV1,
	): Promise<
		| ConfidentialTransientTaskForegroundResultSettlementAdoptResultV1
		| ConfidentialTransientTaskDetachedCancellationSettlementAdoptResultV1
		| ConfidentialTransientTaskDetachedSettlementAdoptResultV1
		| ConfidentialTransientTaskParentResultDeliveryAdoptResultV1
	> {
		if (!proxyFreeData(request)) return { status: "invalid" } as const;
		if ("foregroundAppendBatchKeySha256" in request) return this.#adoptForeground(request);
		if ("resultPublicationTargetId" in request) return this.#adoptParent(request);
		return this.#adoptDetached(request);
	}

	async prepareAsyncJobRecovery(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["prepareAsyncJobRecovery"]>[0],
	) {
		if (
			!proxyFreeData(request) ||
			!strictRecord(request, ["record", "requestSha256"]) ||
			!validResultStoreSha256Ref(request.requestSha256) ||
			!(await validDetachedRecoveryRecord(request.record)) ||
			request.record.recoveryState !== "attempt_frozen"
		)
			return { status: "invalid" } as const;
		const record = request.record;
		const settlement = record.attempt.operation.request;
		const taskKey = detachedTaskKey(settlement);
		const ownerSessionIndexSha256 = record.coordinates.ownerSessionIndex.indexSha256;
		return this.#durable.transact(
			TRANSIENT_NAMESPACE,
			detachedRecoveryIndexKey(ownerSessionIndexSha256),
			async currentInput => {
				let index: PrivateDetachedRecoveryIndexV1;
				if (currentInput === null) {
					index = { schemaVersion: 1, ownerSessionIndexSha256, entries: [] };
				} else {
					const decoded = await decodeDetachedRecoveryIndex(currentInput, ownerSessionIndexSha256);
					if (!decoded) return { state: currentInput, result: { status: "invalid" } as const };
					index = decoded;
				}
				const prior = index.entries.find(entry => entry.jobId === record.coordinates.jobId);
				if (prior) {
					const row = prior.row;
					if (prior.taskId !== taskKey.taskId || prior.runId !== taskKey.runId)
						return { state: index, result: { status: "coordinates_conflict" } as const };
					if (!exactJson(row.record.coordinates.ownerSessionIndex, record.coordinates.ownerSessionIndex))
						return { state: index, result: { status: "owner_session_conflict" } as const };
					if (!exactJson(row.record.coordinates, record.coordinates))
						return { state: index, result: { status: "coordinates_conflict" } as const };
					if (!exactJson(row.record.attempt, record.attempt))
						return { state: index, result: { status: "attempt_conflict" } as const };
					return exactJson(row.record, record)
						? { state: index, result: { status: "already_prepared", record, receipt: row.receipt } as const }
						: { state: index, result: { status: "attempt_conflict" } as const };
				}
				const receiptCore = {
					schemaVersion: 1 as const,
					ownerSessionIndexSha256,
					coordinatesSha256: record.coordinates.coordinatesSha256,
					requestSha256: request.requestSha256,
					previousRecoveryRecordSha256: null,
					recoveryRecordSha256: record.recoveryRecordSha256,
					recoveryState: record.recoveryState,
					storedAt: record.attempt.preparedAt,
				};
				const receipt: ConfidentialAsyncJobTransientTaskRecoveryWriteReceiptV1 = {
					...receiptCore,
					receiptSha256: detachedDigest("async-recovery-write-receipt", receiptCore),
				};
				const row: PrivateDetachedRecoveryRowV1 = { kind: "detached_recovery", record, receipt };
				const entry: PrivateDetachedRecoveryIndexEntryV1 = {
					taskId: taskKey.taskId,
					runId: taskKey.runId,
					jobId: record.coordinates.jobId,
					recoveryRecordSha256: record.recoveryRecordSha256,
					row,
				};
				return {
					state: { ...index, entries: [...index.entries, entry] },
					result: { status: "prepared", record, receipt } as const,
				};
			},
		);
	}

	async transitionAsyncJobRecovery(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["transitionAsyncJobRecovery"]>[0],
	) {
		if (
			!proxyFreeData(request) ||
			!strictRecord(request, ["expectedRecoveryRecordSha256", "record", "requestSha256"]) ||
			!validResultStoreSha256Ref(request.expectedRecoveryRecordSha256) ||
			!validResultStoreSha256Ref(request.requestSha256) ||
			!(await validDetachedRecoveryRecord(request.record)) ||
			(request.record.recoveryState !== "blocked_indeterminate" && request.record.recoveryState !== "handoff_ready")
		)
			return { status: "invalid" } as const;
		const record = request.record;
		const taskKey = detachedTaskKey(record.attempt.operation.request);
		const ownerSessionIndexSha256 = record.coordinates.ownerSessionIndex.indexSha256;
		return this.#durable.transact(
			TRANSIENT_NAMESPACE,
			detachedRecoveryIndexKey(ownerSessionIndexSha256),
			async currentInput => {
				if (currentInput === null) return { state: currentInput, result: { status: "absent" } as const };
				const index = await decodeDetachedRecoveryIndex(currentInput, ownerSessionIndexSha256);
				if (!index) return { state: currentInput, result: { status: "invalid" } as const };
				const entryIndex = index.entries.findIndex(entry => entry.jobId === record.coordinates.jobId);
				if (entryIndex < 0) return { state: index, result: { status: "absent" } as const };
				const entry = index.entries[entryIndex]!;
				const row = entry.row;
				if (entry.taskId !== taskKey.taskId || entry.runId !== taskKey.runId)
					return { state: index, result: { status: "coordinates_conflict" } as const };
				if (!exactJson(row.record.coordinates.ownerSessionIndex, record.coordinates.ownerSessionIndex))
					return { state: index, result: { status: "owner_session_conflict" } as const };
				if (!exactJson(row.record.coordinates, record.coordinates))
					return { state: index, result: { status: "coordinates_conflict" } as const };
				if (!exactJson(row.record.attempt, record.attempt))
					return { state: index, result: { status: "attempt_conflict" } as const };
				if (exactJson(row.record, record))
					return {
						state: index,
						result: { status: "already_transitioned", record, receipt: row.receipt } as const,
					};
				if (
					row.record.recoveryRecordSha256 !== request.expectedRecoveryRecordSha256 ||
					row.record.recoveryState === "handoff_ready" ||
					(row.record.recoveryState === "blocked_indeterminate" && record.recoveryState !== "handoff_ready")
				)
					return { state: index, result: { status: "state_conflict" } as const };
				const receiptCore = {
					schemaVersion: 1 as const,
					ownerSessionIndexSha256,
					coordinatesSha256: record.coordinates.coordinatesSha256,
					requestSha256: request.requestSha256,
					previousRecoveryRecordSha256: row.record.recoveryRecordSha256,
					recoveryRecordSha256: record.recoveryRecordSha256,
					recoveryState: record.recoveryState,
					storedAt:
						record.recoveryState === "blocked_indeterminate"
							? record.transientTaskSettlementBlock.blockedAt
							: record.transientTaskCompletion.settledResultReceipt.publishedAt,
				};
				const receipt: ConfidentialAsyncJobTransientTaskRecoveryWriteReceiptV1 = {
					...receiptCore,
					receiptSha256: detachedDigest("async-recovery-write-receipt", receiptCore),
				};
				const nextRow: PrivateDetachedRecoveryRowV1 = { kind: "detached_recovery", record, receipt };
				const entries = [...index.entries];
				entries[entryIndex] = {
					...entry,
					recoveryRecordSha256: record.recoveryRecordSha256,
					row: nextRow,
				};
				return {
					state: { ...index, entries },
					result: { status: "transitioned", record, receipt } as const,
				};
			},
		);
	}

	async #recoveryTaskState(entry: PrivateDetachedRecoveryIndexEntryV1) {
		const taskKey = { taskId: entry.taskId, runId: entry.runId };
		return transientRuntimeState(taskKey, await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)));
	}

	async enumerateAsyncJobRecovery(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["enumerateAsyncJobRecovery"]>[0],
	) {
		if (
			!proxyFreeData(request) ||
			!strictRecord(request, ["ownerSessionIndex", "requestedAt", "requestSha256"]) ||
			!validDetachedRecoveryOwnerIndex(request.ownerSessionIndex) ||
			!validResultStoreIso8601(request.requestedAt) ||
			!validResultStoreSha256Ref(request.requestSha256)
		)
			return { status: "invalid" } as const;
		try {
			const indexInput = await this.#durable.inspect(
				TRANSIENT_NAMESPACE,
				detachedRecoveryIndexKey(request.ownerSessionIndex.indexSha256),
			);
			if (indexInput === null) {
				const entries: readonly ConfidentialAsyncJobTransientTaskRecoveryIndexEntryV1[] = [];
				return {
					status: "matching",
					entries,
					enumerationSha256: detachedDigest("async-recovery-enumeration", {
						requestSha256: request.requestSha256,
						entries,
					}),
				} as const;
			}
			const index = await decodeDetachedRecoveryIndex(indexInput, request.ownerSessionIndex.indexSha256);
			if (!index) return { status: "owner_session_conflict" } as const;
			const entries: ConfidentialAsyncJobTransientTaskRecoveryIndexEntryV1[] = [];
			for (const storedEntry of index.entries) {
				const row = storedEntry.row;
				if (!exactJson(row.record.coordinates.ownerSessionIndex, request.ownerSessionIndex))
					return { status: "owner_session_conflict" } as const;
				const state = await this.#recoveryTaskState(storedEntry);
				if (detachedSettlementTerminalSha256(state.parentDeliveries, row.record.settlementIdentitySha256) !== null)
					continue;
				entries.push(detachedRecoveryIndexEntry(row.record));
			}
			entries.sort(
				(left, right) => left.startedAtEpochMs - right.startedAtEpochMs || left.jobId.localeCompare(right.jobId),
			);
			return {
				status: "matching",
				entries,
				enumerationSha256: detachedDigest("async-recovery-enumeration", {
					requestSha256: request.requestSha256,
					entries,
				}),
			} as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async inspectAsyncJobRecovery(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["inspectAsyncJobRecovery"]>[0],
	) {
		if (
			!proxyFreeData(request) ||
			!strictRecord(request, [
				"ownerSessionIndex",
				"jobId",
				"expectedRecoveryRecordSha256",
				"requestedAt",
				"requestSha256",
			]) ||
			!validDetachedRecoveryOwnerIndex(request.ownerSessionIndex) ||
			!validResultStoreIdentity(request.jobId) ||
			!validResultStoreSha256Ref(request.expectedRecoveryRecordSha256) ||
			!validResultStoreIso8601(request.requestedAt) ||
			!validResultStoreSha256Ref(request.requestSha256)
		)
			return { status: "invalid" } as const;
		try {
			const indexInput = await this.#durable.inspect(
				TRANSIENT_NAMESPACE,
				detachedRecoveryIndexKey(request.ownerSessionIndex.indexSha256),
			);
			if (indexInput === null) return { status: "absent" } as const;
			const index = await decodeDetachedRecoveryIndex(indexInput, request.ownerSessionIndex.indexSha256);
			if (!index) return { status: "owner_session_conflict" } as const;
			const storedEntry = index.entries.find(entry => entry.jobId === request.jobId);
			if (!storedEntry) return { status: "absent" } as const;
			const row = storedEntry.row;
			if (!exactJson(row.record.coordinates.ownerSessionIndex, request.ownerSessionIndex))
				return { status: "owner_session_conflict" } as const;
			if (row.record.recoveryRecordSha256 !== request.expectedRecoveryRecordSha256)
				return { status: "record_conflict" } as const;
			const state = await this.#recoveryTaskState(storedEntry);
			const terminalReceiptSha256 = detachedSettlementTerminalSha256(
				state.parentDeliveries,
				row.record.settlementIdentitySha256,
			);
			if (terminalReceiptSha256 !== null)
				return {
					status: "terminal",
					terminalReceiptSha256,
					inspectionSha256: detachedDigest("async-recovery-inspection", {
						requestSha256: request.requestSha256,
						terminalReceiptSha256,
					}),
				} as const;
			const entry = detachedRecoveryIndexEntry(row.record);
			return {
				status: "matching",
				entry,
				inspectionSha256: detachedDigest("async-recovery-inspection", {
					requestSha256: request.requestSha256,
					entry,
				}),
			} as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async adoptAsyncJobRecovery(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["adoptAsyncJobRecovery"]>[0],
	) {
		if (
			!proxyFreeData(request) ||
			!strictRecord(request, [
				"ownerSessionIndex",
				"inspection",
				"expectedRecoveryRecordSha256",
				"requestedAt",
				"requestSha256",
			]) ||
			!validDetachedRecoveryOwnerIndex(request.ownerSessionIndex) ||
			request.inspection.status !== "matching" ||
			!validResultStoreSha256Ref(request.expectedRecoveryRecordSha256) ||
			!validResultStoreIso8601(request.requestedAt) ||
			!validResultStoreSha256Ref(request.requestSha256)
		)
			return { status: "invalid" } as const;
		try {
			const indexInput = await this.#durable.inspect(
				TRANSIENT_NAMESPACE,
				detachedRecoveryIndexKey(request.ownerSessionIndex.indexSha256),
			);
			if (indexInput === null) return { status: "absent" } as const;
			const index = await decodeDetachedRecoveryIndex(indexInput, request.ownerSessionIndex.indexSha256);
			if (!index) return { status: "owner_session_conflict" } as const;
			const storedEntry = index.entries.find(entry => entry.jobId === request.inspection.entry.jobId);
			if (!storedEntry) return { status: "absent" } as const;
			const row = storedEntry.row;
			if (!exactJson(row.record.coordinates.ownerSessionIndex, request.ownerSessionIndex))
				return { status: "owner_session_conflict" } as const;
			const state = await this.#recoveryTaskState(storedEntry);
			const terminalReceiptSha256 = detachedSettlementTerminalSha256(
				state.parentDeliveries,
				row.record.settlementIdentitySha256,
			);
			if (terminalReceiptSha256 !== null) return { status: "terminal", terminalReceiptSha256 } as const;
			if (row.record.recoveryRecordSha256 !== request.expectedRecoveryRecordSha256)
				return { status: "record_conflict" } as const;
			if (!exactJson(detachedRecoveryIndexEntry(row.record), request.inspection.entry))
				return { status: "inspection_stale" } as const;
			if (!validResultStoreSha256Ref(request.inspection.inspectionSha256))
				return { status: "inspection_stale" } as const;
			return { status: "adopted", record: row.record } as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async resolveAsyncJobRecoveryCurrentAuthority(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["resolveAsyncJobRecoveryCurrentAuthority"]>[0],
	) {
		if (
			!proxyFreeData(request) ||
			!strictRecord(request, [
				"ownerSessionIndex",
				"jobId",
				"expectedRecoveryRecordSha256",
				"settlementRequest",
				"settledResultReceipt",
				"requestedAt",
				"requestSha256",
			]) ||
			!validDetachedRecoveryOwnerIndex(request.ownerSessionIndex) ||
			!validResultStoreIdentity(request.jobId) ||
			!validResultStoreSha256Ref(request.expectedRecoveryRecordSha256) ||
			!(await validDetachedSettlement(request.settlementRequest)) ||
			!payloadPlainData(request.settledResultReceipt) ||
			!validResultStoreIso8601(request.requestedAt) ||
			!validResultStoreSha256Ref(request.requestSha256)
		)
			return { status: "invalid" } as const;
		try {
			const indexInput = await this.#durable.inspect(
				TRANSIENT_NAMESPACE,
				detachedRecoveryIndexKey(request.ownerSessionIndex.indexSha256),
			);
			if (indexInput === null) return { status: "absent" } as const;
			const index = await decodeDetachedRecoveryIndex(indexInput, request.ownerSessionIndex.indexSha256);
			if (!index) return { status: "owner_session_conflict" } as const;
			const storedEntry = index.entries.find(entry => entry.jobId === request.jobId);
			if (!storedEntry) return { status: "absent" } as const;
			const row = storedEntry.row;
			if (!exactJson(row.record.coordinates.ownerSessionIndex, request.ownerSessionIndex))
				return { status: "owner_session_conflict" } as const;
			if (row.record.recoveryRecordSha256 !== request.expectedRecoveryRecordSha256)
				return { status: "record_conflict" } as const;
			const state = await this.#recoveryTaskState(storedEntry);
			if (
				row.record.settlementIdentitySha256 !== request.settlementRequest.identity.identitySha256 ||
				!exactJson(row.record.attempt.operation.request, request.settlementRequest)
			)
				return { status: "identity_conflict" } as const;
			if (
				!exactJson(request.settledResultReceipt.identity, request.settlementRequest.identity) ||
				request.settledResultReceipt.settlementRequestSha256 !== request.settlementRequest.settlementRequestSha256
			)
				return { status: "receipt_conflict" } as const;
			const settlementRow = loadDetachedRow<PrivateDetachedSettlementRowV1>(
				state.parentDeliveries[detachedStoreMapKey(request.settlementRequest.identity.identitySha256)],
			);
			const publication = detachedAttemptState(
				settlementRow,
				"settled_result_publication",
				request.settlementRequest.settledResultOperationId,
			);
			if (
				publication?.state !== "applied" ||
				publication.receipt === null ||
				!exactJson(publication.receipt, request.settledResultReceipt)
			)
				return { status: "receipt_conflict" } as const;
			const current = await this.#currentParentRequest(
				state,
				request.settlementRequest.parentDeliveryRequest,
				request.requestedAt,
			);
			if (current.status !== "current") {
				if (current.status === "target_missing") return { status: "target_missing" } as const;
				if (current.status === "stale_live_receipt") return { status: "stale_live_receipt" } as const;
				if (current.status === "authority_lost") return { status: "authority_lost" } as const;
				return { status: "invalid" } as const;
			}
			const authorityCore = {
				identity: request.settlementRequest.identity,
				deliveryAuthority: request.settlementRequest.deliveryAuthority,
				deliveryAuthoritySha256: request.settlementRequest.deliveryAuthoritySha256,
				settledResultReceiptSha256: request.settledResultReceipt.receiptSha256,
				kind: "current_owner_epoch" as const,
				ownerId: request.settlementRequest.identity.ownerId,
				deliveryEpoch: request.settlementRequest.identity.deliveryEpoch,
				ownerSinkAuthoritySha256: detachedDigest("owner-sink-authority", {
					deliveryAuthoritySha256: request.settlementRequest.deliveryAuthoritySha256,
					settledResultReceiptSha256: request.settledResultReceipt.receiptSha256,
				}),
			};
			const currentAuthority = {
				...authorityCore,
				currentAuthoritySha256: detachedDigest("detached-current-authority", authorityCore),
			};
			return {
				status: "resolved",
				currentAuthority,
				resolutionSha256: detachedDigest("async-recovery-current-authority-resolution", {
					requestSha256: request.requestSha256,
					currentAuthoritySha256: currentAuthority.currentAuthoritySha256,
				}),
			} as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	#hubSendAwaitTargetLedger(
		state: TransientTaskRuntimeStateV1,
		registration: Parameters<
			TransientTaskHubSendAwaitOutboundEffectV1["observeTargetDeliveryLedger"]
		>[0]["registration"],
	): PrivateHubSendAwaitTargetLedgerRowV1 | null {
		const stored =
			state.parentDeliveries[hubSendAwaitTargetLedgerMapKey(registration.claim.selector.key.hubWaitInvocationId)];
		return stored === undefined ? null : loadHubSendAwaitTargetLedgerRow(stored);
	}

	async #observeHubSendAwaitTargetDeliveryLedger(
		input: Parameters<TransientTaskHubSendAwaitOutboundEffectV1["observeTargetDeliveryLedger"]>[0],
	): Promise<ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerPermitV1> {
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"current-parent-session-authority",
				input.currentAuthority,
			) ||
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"return-target-registration-receipt",
				input.registration,
			) ||
			!validateTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-plan", input.plan) ||
			!validResultStoreIso8601(input.observedAt) ||
			!exactJson(input.currentAuthority, input.registration.claim.currentAuthority) ||
			input.registration.sendAwaitOutboundState?.state !== "not_applied" ||
			!exactJson(input.registration.sendAwaitOutboundState.plan, input.plan)
		)
			throw new TypeError("Invalid Hub send-await target-ledger observation");
		const taskKey = await this.#hubTaskKeyForCurrentAuthority(input.currentAuthority);
		if (taskKey === null) throw new TypeError("Hub send-await authority is stale");
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			const returnTargetStored =
				state.parentDeliveries[
					detachedHubReturnTargetMapKey(input.registration.claim.selector.key.hubWaitInvocationId)
				];
			if (returnTargetStored === undefined) throw new TypeError("Hub send-await return target is absent");
			const returnTarget = loadDetachedHubReturnTargetRow(returnTargetStored);
			if (!exactJson(returnTarget.registrationReceipt, input.registration))
				throw new TypeError("Hub send-await return target conflicts");
			const mapKey = hubSendAwaitTargetLedgerMapKey(input.registration.claim.selector.key.hubWaitInvocationId);
			const stored = state.parentDeliveries[mapKey];
			const ledger: PrivateHubSendAwaitTargetLedgerRowV1 =
				stored === undefined
					? {
							kind: "hub_send_await_target_ledger",
							incarnationSha256: detachedDigest("hub-send-await-target-ledger-incarnation", {
								taskId: taskKey.taskId,
								runId: taskKey.runId,
								createId: input.currentAuthority.createId,
								hubWaitInvocationId: input.registration.claim.selector.key.hubWaitInvocationId,
							}),
							revision: 0,
							entries: [],
						}
					: loadHubSendAwaitTargetLedgerRow(stored);
			const permit = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-permit", {
				schemaVersion: 1 as const,
				targetAgentId: input.plan.message.to,
				targetDeliveryLedgerIncarnationSha256: ledger.incarnationSha256,
				targetDeliveryLedgerRevision: ledger.revision,
				targetDeliveryLedgerSha256: hubSendAwaitTargetLedgerSha256(ledger),
				sendOperationId: input.plan.sendOperationId,
				messageSha256: input.plan.message.messageSha256,
				observedAt: input.observedAt,
			});
			if (stored !== undefined) return { state, result: permit };
			return {
				state: {
					...state,
					parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(ledger) },
				},
				result: permit,
			};
		});
	}

	async #transitionHubSendAwaitTargetConsumption(
		taskKey: TransientTaskWorkspaceKeyV1,
		registration: Parameters<
			TransientTaskHubSendAwaitOutboundEffectV1["observeTargetDeliveryLedger"]
		>[0]["registration"],
		request: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionTransitionRequestV1,
	): Promise<
		| {
				readonly status: "transitioned" | "already_transitioned";
				readonly receipt: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionTransitionReceiptV1;
		  }
		| { readonly status: "conflict" | "invalid" }
	> {
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-transition-request",
				request,
			)
		)
			return { status: "invalid" };
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			const ledger = this.#hubSendAwaitTargetLedger(state, registration);
			if (ledger === null) return { state, result: { status: "invalid" } as const };
			const index = ledger.entries.findIndex(
				entry => entry.request.requestSha256 === request.plan.request.requestSha256,
			);
			if (index < 0) return { state, result: { status: "conflict" } as const };
			const entry = ledger.entries[index];
			if (entry.state !== "accepted_pending_delivery" || !exactJson(entry.consumptionState.plan, request.plan))
				return { state, result: { status: "conflict" } as const };
			if (entry.consumptionState.state === "outcome_unknown")
				return exactJson(entry.consumptionState.transitionRequest, request)
					? {
							state,
							result: {
								status: "already_transitioned",
								receipt: entry.consumptionState.transitionReceipt,
							} as const,
						}
					: { state, result: { status: "conflict" } as const };
			if (entry.consumptionState.stateSha256 !== request.expectedNotAppliedStateSha256)
				return { state, result: { status: "conflict" } as const };
			const receipt = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-transition-receipt",
				{
					planSha256: request.plan.planSha256,
					transitionRequestSha256: request.requestSha256,
					priorStateSha256: entry.consumptionState.stateSha256,
					outcomeUnknownStateSha256: detachedDigest("hub-send-await-target-consumption-outcome-unknown", {
						planSha256: request.plan.planSha256,
						requestSha256: request.requestSha256,
					}),
					transitionedAt: request.transitionedAt,
				},
			);
			const consumptionState = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-state",
				{
					state: "outcome_unknown" as const,
					plan: request.plan,
					transitionRequest: request,
					transitionReceipt: receipt,
				},
			);
			if (consumptionState.state !== "outcome_unknown") return { state, result: { status: "invalid" } as const };
			const nextEntry = buildHubTargetAcceptedLedgerEntryV1({
				state: "accepted_pending_delivery",
				request: entry.request,
				message: entry.message,
				permit: entry.permit,
				consumptionState,
			});
			const entries = [...ledger.entries];
			entries[index] = nextEntry;
			const nextLedger = { ...ledger, revision: ledger.revision + 1, entries };
			const mapKey = hubSendAwaitTargetLedgerMapKey(registration.claim.selector.key.hubWaitInvocationId);
			return {
				state: {
					...state,
					parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(nextLedger) },
				},
				result: { status: "transitioned", receipt } as const,
			};
		});
	}

	async #settleHubSendAwaitTargetConsumption(
		taskKey: TransientTaskWorkspaceKeyV1,
		registration: Parameters<
			TransientTaskHubSendAwaitOutboundEffectV1["observeTargetDeliveryLedger"]
		>[0]["registration"],
		receipt: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionReceiptV1,
	): Promise<HubTargetSettledLedgerEntryV1> {
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-receipt",
				receipt,
			)
		)
			throw new TypeError("Invalid Hub send-await target consumption receipt");
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			const ledger = this.#hubSendAwaitTargetLedger(state, registration);
			if (ledger === null) throw new TypeError("Hub send-await target ledger is absent");
			const index = ledger.entries.findIndex(
				entry => entry.request.requestSha256 === receipt.plan.request.requestSha256,
			);
			if (index < 0) throw new TypeError("Hub send-await target entry is absent");
			const entry = ledger.entries[index];
			if (entry.state === "settled") {
				if (!exactJson(entry.consumptionReceipt, receipt)) throw new TypeError("Hub target settlement conflicts");
				return { state, result: entry };
			}
			if (
				entry.state !== "accepted_pending_delivery" ||
				entry.consumptionState.state !== "outcome_unknown" ||
				!exactJson(entry.consumptionState.transitionRequest, receipt.transitionRequest) ||
				!exactJson(entry.consumptionState.transitionReceipt, receipt.transitionReceipt)
			)
				throw new TypeError("Hub target settlement authority is stale");
			const consumptionState = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-state",
				{ state: "settled" as const, receipt },
			);
			if (consumptionState.state !== "settled") throw new TypeError("Invalid Hub target settled state");
			const settled = buildHubTargetSettledLedgerEntryV1({
				state: "settled",
				request: entry.request,
				message: entry.message,
				permit: entry.permit,
				consumptionState,
				consumptionReceipt: receipt,
				sourceReceipt: receipt.sourceReceipt,
				settledAt: receipt.settledAt,
			});
			const entries = [...ledger.entries];
			entries[index] = settled;
			const nextLedger = { ...ledger, revision: ledger.revision + 1, entries };
			const mapKey = hubSendAwaitTargetLedgerMapKey(registration.claim.selector.key.hubWaitInvocationId);
			return {
				state: {
					...state,
					parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(nextLedger) },
				},
				result: settled,
			};
		});
	}

	async #resumeAcceptedHubSendAwaitTarget(
		taskKey: TransientTaskWorkspaceKeyV1,
		registration: Parameters<
			TransientTaskHubSendAwaitOutboundEffectV1["observeTargetDeliveryLedger"]
		>[0]["registration"],
		entry: HubTargetAcceptedLedgerEntryV1 & {
			readonly consumptionState: Extract<
				ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionStateV1,
				{ state: "not_applied" }
			>;
		},
		observedAt: ISO8601,
		frozenMaterializationPlan?: ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationPlanV1,
	): Promise<ConfidentialTransientTaskHubSendAwaitTargetDeliveryEffectResultV1> {
		let materializationPlan: ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationPlanV1;
		try {
			materializationPlan =
				frozenMaterializationPlan ??
				(await this.#hubSendAwaitTargetSource.prepareAcceptedHubSendAwaitMessage({ entry, observedAt }));
		} catch {
			return { status: "outcome_unknown" };
		}
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-source-materialization-plan",
				materializationPlan,
			) ||
			materializationPlan.sourcePermit.acceptedEntrySha256 !== entry.entrySha256 ||
			materializationPlan.sourcePermit.targetAgentId !== entry.message.to
		)
			return { status: "invalid" };
		const transitionRequest = buildTransientTaskHubWaitMessageCanonicalRecordV1(
			"send-await-target-delivery-consumption-transition-request",
			{
				plan: entry.consumptionState.plan,
				materializationPlan,
				expectedNotAppliedStateSha256: entry.consumptionState.stateSha256,
				transitionedAt: observedAt,
			},
		);
		const transitioned = await this.#transitionHubSendAwaitTargetConsumption(
			taskKey,
			registration,
			transitionRequest,
		);
		if (transitioned.status !== "transitioned")
			return { status: transitioned.status === "already_transitioned" ? "outcome_unknown" : transitioned.status };
		let materializationReceipt: ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationReceiptV1;
		try {
			materializationReceipt = await this.#hubSendAwaitTargetSource.dispatchAcceptedHubSendAwaitMessage(
				transitionRequest,
				transitioned.receipt,
			);
		} catch {
			return { status: "outcome_unknown" };
		}
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-source-materialization-receipt",
				materializationReceipt,
			) ||
			materializationReceipt.route !== materializationPlan.route ||
			materializationReceipt.sourceReceipt.to !== entry.message.to
		)
			return { status: "outcome_unknown" };
		const consumptionReceipt = buildTransientTaskHubWaitMessageCanonicalRecordV1(
			"send-await-target-delivery-consumption-receipt",
			{
				plan: transitionRequest.plan,
				transitionRequest,
				transitionReceipt: transitioned.receipt,
				materializationReceipt,
				sourceReceipt: materializationReceipt.sourceReceipt,
				settledAt: materializationReceipt.materializedAt,
			},
		);
		const settled = await this.#settleHubSendAwaitTargetConsumption(taskKey, registration, consumptionReceipt);
		return { status: "settled", entry: settled };
	}

	async #inspectExactHubSendAwaitTargetMessage(
		taskKey: TransientTaskWorkspaceKeyV1,
		registration: Parameters<
			TransientTaskHubSendAwaitOutboundEffectV1["observeTargetDeliveryLedger"]
		>[0]["registration"],
		request: Parameters<TransientTaskHubSendAwaitOutboundEffectV1["inspect"]>[0]["targetDeliveryInspectRequest"],
	): Promise<ConfidentialTransientTaskHubSendAwaitTargetDeliveryInspectionV1> {
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspect-request", request))
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
				status: "invalid" as const,
			});
		try {
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			const ledger = this.#hubSendAwaitTargetLedger(state, registration);
			if (ledger === null)
				return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
					status: "invalid" as const,
				});
			const matches = ledger.entries.filter(
				candidate =>
					candidate.request.permit.sendOperationId === request.sendOperationId ||
					candidate.message.messageSha256 === request.messageSha256,
			);
			if (matches.length > 1)
				return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
					status: "conflict" as const,
				});
			const entry = matches[0];
			if (entry) {
				if (
					entry.request.requestSha256 !== request.expectedExactMessageRequestSha256 ||
					(entry.consumptionState.state !== "settled" &&
						entry.consumptionState.state !== "blocked_indeterminate" &&
						entry.consumptionState.plan.planSha256 !== request.expectedConsumptionPlanSha256)
				)
					return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
						status: "conflict" as const,
					});
				if (entry.state === "settled")
					return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
						status: "matching_settled_entry" as const,
						entry,
					});
				if (entry.state === "accepted_pending_delivery")
					return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
						status: "matching_pending_entry" as const,
						entry,
					});
				return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
					status: "outcome_unknown" as const,
					entry,
				});
			}
			if (
				request.permit.targetDeliveryLedgerIncarnationSha256 === ledger.incarnationSha256 &&
				request.permit.targetDeliveryLedgerRevision === ledger.revision &&
				request.permit.targetDeliveryLedgerSha256 === hubSendAwaitTargetLedgerSha256(ledger)
			) {
				const proof = buildTransientTaskHubWaitMessageCanonicalRecordV1(
					"send-await-target-delivery-authoritative-absence",
					{
						permit: request.permit,
						inspectRequest: request,
						unchangedTargetDeliveryLedgerIncarnationSha256: ledger.incarnationSha256,
						unchangedTargetDeliveryLedgerRevision: ledger.revision,
						unchangedTargetDeliveryLedgerSha256: hubSendAwaitTargetLedgerSha256(ledger),
						exactOperationAbsent: true as const,
						exactMessageAbsent: true as const,
						provenAt: request.inspectedAt,
					},
				);
				return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
					status: "authoritative_absence" as const,
					proof,
				});
			}
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
				status: "conflict" as const,
			});
		} catch {
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
				status: "invalid" as const,
			});
		}
	}

	async #applyHubSendAwaitTargetConsumptionAdoption(
		taskKey: TransientTaskWorkspaceKeyV1,
		registration: Parameters<
			TransientTaskHubSendAwaitOutboundEffectV1["observeTargetDeliveryLedger"]
		>[0]["registration"],
		request: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionAdoptRequestV1,
		result: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionAdoptResultV1,
	): Promise<ConfidentialTransientTaskHubSendAwaitTargetDeliveryEffectResultV1> {
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-adopt-request",
				request,
			) ||
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-adopt-result",
				result,
			)
		)
			return { status: "invalid" };
		if (result.status === "settled") {
			const settled = await this.#settleHubSendAwaitTargetConsumption(taskKey, registration, result.receipt);
			return { status: "settled", entry: settled };
		}
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			const ledger = this.#hubSendAwaitTargetLedger(state, registration);
			if (ledger === null) return { state, result: { status: "invalid" } as const };
			const index = ledger.entries.findIndex(
				candidate => candidate.request.requestSha256 === request.inspectRequest.plan.request.requestSha256,
			);
			if (index < 0) return { state, result: { status: "conflict" } as const };
			const entry = ledger.entries[index];
			if (
				entry.state !== "accepted_pending_delivery" ||
				entry.consumptionState.state !== "outcome_unknown" ||
				!exactJson(entry.consumptionState.transitionRequest, request.inspectRequest.transitionRequest) ||
				!exactJson(entry.consumptionState.transitionReceipt, request.inspectRequest.transitionReceipt)
			)
				return { state, result: { status: "conflict" } as const };
			let nextEntry: ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerEntryV1;
			let effectResult: ConfidentialTransientTaskHubSendAwaitTargetDeliveryEffectResultV1;
			if (result.status === "restored_not_applied") {
				nextEntry = buildHubTargetAcceptedLedgerEntryV1({
					state: "accepted_pending_delivery",
					request: entry.request,
					message: entry.message,
					permit: entry.permit,
					consumptionState: result.state,
				});
				effectResult = { status: "accepted", entry: nextEntry };
			} else {
				const consumptionState = buildTransientTaskHubWaitMessageCanonicalRecordV1(
					"send-await-target-delivery-consumption-state",
					{ state: "blocked_indeterminate" as const, block: result.block },
				);
				if (consumptionState.state !== "blocked_indeterminate")
					return { state, result: { status: "invalid" } as const };
				nextEntry = buildHubTargetBlockedLedgerEntryV1({
					state: "blocked_indeterminate",
					request: entry.request,
					message: entry.message,
					permit: entry.permit,
					consumptionState,
					block: result.block,
					blockedAt: request.adoptedAt,
				});
				effectResult = { status: "outcome_unknown" };
			}
			const entries = [...ledger.entries];
			entries[index] = nextEntry;
			const nextLedger = { ...ledger, revision: ledger.revision + 1, entries };
			const mapKey = hubSendAwaitTargetLedgerMapKey(registration.claim.selector.key.hubWaitInvocationId);
			return {
				state: {
					...state,
					parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(nextLedger) },
				},
				result: effectResult,
			};
		});
	}

	async #recoverAcceptedHubSendAwaitTarget(
		taskKey: TransientTaskWorkspaceKeyV1,
		registration: Parameters<
			TransientTaskHubSendAwaitOutboundEffectV1["observeTargetDeliveryLedger"]
		>[0]["registration"],
		entry: HubTargetAcceptedLedgerEntryV1,
		observedAt: ISO8601,
	): Promise<ConfidentialTransientTaskHubSendAwaitTargetDeliveryEffectResultV1> {
		if (entry.consumptionState.state === "not_applied")
			return this.#resumeAcceptedHubSendAwaitTarget(
				taskKey,
				registration,
				{ ...entry, consumptionState: entry.consumptionState },
				observedAt,
			);
		const inspectRequest = buildTransientTaskHubWaitMessageCanonicalRecordV1(
			"send-await-target-delivery-consumption-inspect-request",
			{
				plan: entry.consumptionState.plan,
				transitionRequest: entry.consumptionState.transitionRequest,
				transitionReceipt: entry.consumptionState.transitionReceipt,
				expectedOutcomeUnknownStateSha256: entry.consumptionState.stateSha256,
				inspectedAt: observedAt,
			},
		);
		let inspection: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionInspectionV1;
		try {
			inspection = await this.#hubSendAwaitTargetSource.inspectAcceptedHubSendAwaitMessage(inspectRequest);
		} catch {
			return { status: "outcome_unknown" };
		}
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-inspection",
				inspection,
			)
		)
			return { status: "invalid" };
		const adoptRequest = buildTransientTaskHubWaitMessageCanonicalRecordV1(
			"send-await-target-delivery-consumption-adopt-request",
			{
				inspectRequest,
				inspection,
				expectedInspectionSha256: inspection.inspectionSha256,
				adoptedAt: observedAt,
			},
		);
		let adoption: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionAdoptResultV1;
		try {
			adoption = await this.#hubSendAwaitTargetSource.adoptAcceptedHubSendAwaitMessage(adoptRequest);
		} catch {
			return { status: "outcome_unknown" };
		}
		const applied = await this.#applyHubSendAwaitTargetConsumptionAdoption(
			taskKey,
			registration,
			adoptRequest,
			adoption,
		);
		if (applied.status !== "accepted") return applied;
		const restored = applied.entry;
		if (restored.consumptionState.state !== "not_applied") return { status: "invalid" };
		return this.#resumeAcceptedHubSendAwaitTarget(
			taskKey,
			registration,
			{ ...restored, consumptionState: restored.consumptionState },
			observedAt,
			entry.consumptionState.transitionRequest.materializationPlan,
		);
	}

	#hubSendAwaitInitialState(
		plan: ConfidentialTransientTaskHubSendAwaitOutboundPlanV1,
	): Extract<ConfidentialTransientTaskHubSendAwaitOutboundStateV1, { state: "not_applied" }> {
		const state = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-state", {
			state: "not_applied" as const,
			plan,
		});
		if (state.state !== "not_applied") throw new TypeError("Invalid Hub send-await initial state");
		return state;
	}

	#hubSendAwaitTransitionReceipt(
		request: Parameters<TransientTaskHubSendAwaitOutboundEffectV1["dispatch"]>[0],
	): ConfidentialTransientTaskHubSendAwaitOutboundTransitionReceiptV1 {
		return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-transition-receipt", {
			planSha256: request.plan.planSha256,
			registrationReceiptSha256: request.registration.receiptSha256,
			targetDeliveryPermitSha256: request.targetDeliveryPermit.permitSha256,
			transitionRequestSha256: request.requestSha256,
			expectedPriorStateSha256: request.expectedPriorStateSha256,
			transitionedAt: request.transitionedAt,
		});
	}

	#hubSendAwaitExactMessageRequest(
		request: Parameters<TransientTaskHubSendAwaitOutboundEffectV1["dispatch"]>[0],
		transitionReceipt: ConfidentialTransientTaskHubSendAwaitOutboundTransitionReceiptV1,
	) {
		return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-exact-message-request", {
			permit: request.targetDeliveryPermit,
			outboundTransitionRequestSha256: request.requestSha256,
			outboundTransitionReceiptSha256: transitionReceipt.receiptSha256,
			message: request.plan.message,
			expectsReply: true as const,
			requestedAt: request.transitionedAt,
		});
	}

	#hubSendAwaitSettledState(
		plan: ConfidentialTransientTaskHubSendAwaitOutboundPlanV1,
		transitionReceiptSha256: Sha256Ref,
		entry: Extract<ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerEntryV1, { state: "settled" }>,
	): Extract<ConfidentialTransientTaskHubSendAwaitOutboundStateV1, { state: "settled" }> {
		const receipt = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-receipt", {
			planSha256: plan.planSha256,
			transitionReceiptSha256,
			targetDeliverySettledEntry: entry,
			sourceReceipt: entry.sourceReceipt,
			settledAt: entry.settledAt,
		});
		const state = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-state", {
			state: "settled" as const,
			plan,
			receipt,
		});
		if (state.state !== "settled") throw new TypeError("Invalid Hub send-await settled state");
		return state;
	}

	#hubSendAwaitRequestMatchesRegistration(
		request: Parameters<TransientTaskHubSendAwaitOutboundEffectV1["dispatch"]>[0],
	): request is Parameters<TransientTaskHubSendAwaitOutboundEffectV1["dispatch"]>[0] {
		const initial = request.registration.sendAwaitOutboundState;
		if (initial === null) return false;
		const receipt = this.#hubSendAwaitTransitionReceipt(request);
		const state = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-state", {
			state: "outcome_unknown" as const,
			plan: request.plan,
			transitionRequest: request,
			transitionReceipt: receipt,
		});
		if (state.state !== "outcome_unknown") return false;
		return detachedHubOutboundTransitionMatchesRegistration(state, request.registration, initial);
	}

	async #dispatchAndRecoverHubSendAwaitOutbound(
		request: Parameters<TransientTaskHubSendAwaitOutboundEffectV1["dispatchAndRecover"]>[0],
	) {
		const initial = request.registration.sendAwaitOutboundState;
		if (
			initial === null ||
			initial.state !== "not_applied" ||
			!exactJson(initial.plan, request.plan) ||
			!exactJson(request.currentAuthority, request.registration.claim.currentAuthority) ||
			!validResultStoreIso8601(request.dispatchedAt)
		)
			return { status: "invalid" } as const;
		let permit: ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerPermitV1;
		try {
			permit = await this.#observeHubSendAwaitTargetDeliveryLedger({
				currentAuthority: request.currentAuthority,
				registration: request.registration,
				plan: request.plan,
				observedAt: request.dispatchedAt,
			});
		} catch {
			return { status: "conflict" } as const;
		}
		const transitionRequest = buildTransientTaskHubWaitMessageCanonicalRecordV1(
			"send-await-outbound-transition-request",
			{
				currentAuthority: request.currentAuthority,
				registration: request.registration,
				plan: request.plan,
				targetDeliveryPermit: permit,
				expectedPriorStateSha256: initial.stateSha256,
				transitionedAt: request.dispatchedAt,
			},
		);
		const transitionReceipt = this.#hubSendAwaitTransitionReceipt(transitionRequest);
		const outcomeUnknown = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-state", {
			state: "outcome_unknown" as const,
			plan: request.plan,
			transitionRequest,
			transitionReceipt,
		});
		if (outcomeUnknown.state !== "outcome_unknown") return { status: "invalid" } as const;
		let state: ConfidentialTransientTaskHubSendAwaitOutboundStateV1 = outcomeUnknown;
		try {
			state = await this.#dispatchHubSendAwaitOutbound(transitionRequest);
		} catch {
			// Exact inspection below classifies a lost dispatch response.
		}
		if (state.state === "settled") return { status: "settled", receipt: state.receipt } as const;
		if (state.state === "blocked_indeterminate") return { status: "blocked_indeterminate" } as const;
		if (state.state === "not_applied") return { status: "conflict" } as const;
		const exactMessageRequest = this.#hubSendAwaitExactMessageRequest(transitionRequest, transitionReceipt);
		const consumptionPlan = buildTransientTaskHubWaitMessageCanonicalRecordV1(
			"send-await-target-delivery-consumption-plan",
			{
				schemaVersion: 1 as const,
				request: exactMessageRequest,
				permitSha256: permit.permitSha256,
				sendOperationId: request.plan.sendOperationId,
				messageSha256: request.plan.message.messageSha256,
				preparedAt: request.dispatchedAt,
			},
		);
		const targetDeliveryInspectRequest = buildTransientTaskHubWaitMessageCanonicalRecordV1(
			"send-await-target-delivery-inspect-request",
			{
				permit,
				sendOperationId: request.plan.sendOperationId,
				messageSha256: request.plan.message.messageSha256,
				expectedExactMessageRequestSha256: exactMessageRequest.requestSha256,
				expectedConsumptionPlanSha256: consumptionPlan.planSha256,
				inspectedAt: request.dispatchedAt,
			},
		);
		const inspectRequest = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-inspect-request", {
			currentAuthority: request.currentAuthority,
			registration: request.registration,
			plan: request.plan,
			expectedOutboundStateSha256: state.stateSha256,
			expectedTransitionRequestSha256: transitionRequest.requestSha256,
			expectedTransitionReceiptSha256: transitionReceipt.receiptSha256,
			targetDeliveryInspectRequest,
			inspectedAt: request.dispatchedAt,
		});
		const inspection = await this.#inspectHubSendAwaitOutbound(inspectRequest);
		const adoption = await this.#adoptHubSendAwaitOutbound(
			buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-adopt-request", {
				inspectRequest,
				inspection,
				expectedInspectionSha256: inspection.inspectionSha256,
				adoptedAt: request.dispatchedAt,
			}),
		);
		if (adoption.status === "settled") return { status: "settled", receipt: adoption.receipt } as const;
		if (adoption.status === "blocked_indeterminate") return { status: "blocked_indeterminate" } as const;
		if (adoption.status !== "restored_not_applied") return { status: adoption.status } as const;
		try {
			const replay = await this.#dispatchHubSendAwaitOutbound(transitionRequest);
			return replay.state === "settled"
				? ({ status: "settled", receipt: replay.receipt } as const)
				: ({ status: "blocked_indeterminate" } as const);
		} catch {
			return { status: "blocked_indeterminate" } as const;
		}
	}

	async #dispatchHubSendAwaitOutbound(
		request: Parameters<TransientTaskHubSendAwaitOutboundEffectV1["dispatch"]>[0],
	): Promise<ConfidentialTransientTaskHubSendAwaitOutboundStateV1> {
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-transition-request", request) ||
			!this.#hubSendAwaitRequestMatchesRegistration(request)
		)
			throw new TypeError("Invalid Hub send-await outbound transition");
		const taskKey = await this.#hubTaskKeyForCurrentAuthority(request.currentAuthority);
		if (taskKey === null) throw new TypeError("Hub send-await return target is absent");
		const invocationId = request.registration.claim.selector.key.hubWaitInvocationId;
		const mapKey = detachedHubReturnTargetMapKey(invocationId);
		const targetMapKey = hubSendAwaitTargetLedgerMapKey(invocationId);
		const transitionReceipt = this.#hubSendAwaitTransitionReceipt(request);
		const targetRequest = this.#hubSendAwaitExactMessageRequest(request, transitionReceipt);
		const outcomeUnknown = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-state", {
			state: "outcome_unknown" as const,
			plan: request.plan,
			transitionRequest: request,
			transitionReceipt,
		});
		if (outcomeUnknown.state !== "outcome_unknown")
			throw new TypeError("Invalid Hub send-await outcome-unknown state");
		const opened = await this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
			const runtime = transientRuntimeState(taskKey, currentInput);
			const stored = runtime.parentDeliveries[mapKey];
			if (stored === undefined) throw new TypeError("Hub send-await return target is absent");
			const row = loadDetachedHubReturnTargetRow(stored);
			if (!exactJson(row.registrationReceipt, request.registration) || row.sendAwaitOutboundState === null)
				throw new TypeError("Hub send-await return target conflicts");
			const ledgerStored = runtime.parentDeliveries[targetMapKey];
			if (ledgerStored === undefined) throw new TypeError("Hub send-await target ledger is absent");
			const ledger = loadHubSendAwaitTargetLedgerRow(ledgerStored);
			const matches = ledger.entries.filter(
				entry =>
					entry.request.permit.sendOperationId === request.plan.sendOperationId ||
					entry.message.messageSha256 === request.plan.message.messageSha256,
			);
			if (matches.length > 1) throw new TypeError("Hub send-await target ledger conflicts");
			const existing = matches[0] ?? null;
			const current = row.sendAwaitOutboundState;
			if (current.state === "not_applied") {
				if (
					current.stateSha256 !== request.expectedPriorStateSha256 ||
					!exactJson(current, request.registration.sendAwaitOutboundState) ||
					existing !== null ||
					request.targetDeliveryPermit.targetAgentId !== request.plan.message.to ||
					request.targetDeliveryPermit.sendOperationId !== request.plan.sendOperationId ||
					request.targetDeliveryPermit.messageSha256 !== request.plan.message.messageSha256 ||
					request.targetDeliveryPermit.targetDeliveryLedgerIncarnationSha256 !== ledger.incarnationSha256 ||
					request.targetDeliveryPermit.targetDeliveryLedgerRevision !== ledger.revision ||
					request.targetDeliveryPermit.targetDeliveryLedgerSha256 !== hubSendAwaitTargetLedgerSha256(ledger)
				)
					throw new TypeError("Hub send-await prior state conflicts");
				const plan = buildTransientTaskHubWaitMessageCanonicalRecordV1(
					"send-await-target-delivery-consumption-plan",
					{
						schemaVersion: 1 as const,
						request: targetRequest,
						permitSha256: targetRequest.permit.permitSha256,
						sendOperationId: request.plan.sendOperationId,
						messageSha256: request.plan.message.messageSha256,
						preparedAt: request.transitionedAt,
					},
				);
				const consumptionState = buildTransientTaskHubWaitMessageCanonicalRecordV1(
					"send-await-target-delivery-consumption-state",
					{ state: "not_applied" as const, plan },
				);
				if (consumptionState.state !== "not_applied") throw new TypeError("Invalid Hub target not-applied state");
				const entry = buildHubTargetAcceptedLedgerEntryV1({
					state: "accepted_pending_delivery",
					request: targetRequest,
					message: request.plan.message,
					permit: request.targetDeliveryPermit,
					consumptionState,
				});
				const nextRow = { ...row, sendAwaitOutboundState: outcomeUnknown };
				const nextLedger = { ...ledger, revision: ledger.revision + 1, entries: [...ledger.entries, entry] };
				return {
					state: {
						...runtime,
						parentDeliveries: {
							...runtime.parentDeliveries,
							[mapKey]: storeForegroundValue(nextRow),
							[targetMapKey]: storeForegroundValue(nextLedger),
						},
					},
					result: { state: outcomeUnknown, entry } as const,
				};
			}
			if (
				current.state === "outcome_unknown" &&
				exactJson(current.transitionRequest, request) &&
				exactJson(current.transitionReceipt, transitionReceipt)
			) {
				if (existing !== null && !exactJson(existing.request, targetRequest))
					throw new TypeError("Hub send-await target request conflicts");
				return { state: runtime, result: { state: current, entry: existing } as const };
			}
			if (
				current.state === "settled" &&
				current.receipt.targetDeliverySettledEntry.request.outboundTransitionRequestSha256 ===
					request.requestSha256 &&
				current.receipt.transitionReceiptSha256 === transitionReceipt.receiptSha256
			)
				return { state: runtime, result: { state: current, entry: null } as const };
			if (
				current.state === "blocked_indeterminate" &&
				exactJson(current.transitionRequest, request) &&
				exactJson(current.transitionReceipt, transitionReceipt)
			)
				return { state: runtime, result: { state: current, entry: null } as const };
			throw new TypeError("Hub send-await outbound state conflicts");
		});
		if (opened.state.state === "settled" || opened.state.state === "blocked_indeterminate" || opened.entry === null)
			return opened.state;
		const targetResult =
			opened.entry.state === "settled"
				? ({ status: "already_settled", entry: opened.entry } as const)
				: opened.entry.state === "accepted_pending_delivery"
					? await this.#recoverAcceptedHubSendAwaitTarget(
							taskKey,
							request.registration,
							opened.entry,
							request.transitionedAt,
						)
					: ({ status: "outcome_unknown" } as const);
		if (targetResult.status !== "settled" && targetResult.status !== "already_settled") return opened.state;
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-ledger-entry",
				targetResult.entry,
			) ||
			!exactJson(targetResult.entry.request, targetRequest)
		)
			throw new TypeError("Invalid Hub send-await target settlement");
		const settled = this.#hubSendAwaitSettledState(request.plan, transitionReceipt.receiptSha256, targetResult.entry);
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
			const runtime = transientRuntimeState(taskKey, currentInput);
			const stored = runtime.parentDeliveries[mapKey];
			if (stored === undefined) throw new TypeError("Hub send-await return target is absent");
			const row = loadDetachedHubReturnTargetRow(stored);
			if (!exactJson(row.registrationReceipt, request.registration) || row.sendAwaitOutboundState === null)
				throw new TypeError("Hub send-await return target conflicts");
			if (row.sendAwaitOutboundState.state === "settled") {
				if (!exactJson(row.sendAwaitOutboundState, settled))
					throw new TypeError("Hub send-await settled state conflicts");
				return { state: runtime, result: row.sendAwaitOutboundState };
			}
			if (
				row.sendAwaitOutboundState.state !== "outcome_unknown" ||
				!exactJson(row.sendAwaitOutboundState, outcomeUnknown)
			)
				throw new TypeError("Hub send-await transition state conflicts");
			const nextRow = { ...row, sendAwaitOutboundState: settled };
			return {
				state: {
					...runtime,
					parentDeliveries: { ...runtime.parentDeliveries, [mapKey]: storeForegroundValue(nextRow) },
				},
				result: settled,
			};
		});
	}

	async #inspectHubSendAwaitOutbound(
		request: Parameters<TransientTaskHubSendAwaitOutboundEffectV1["inspect"]>[0],
	): Promise<ConfidentialTransientTaskHubSendAwaitOutboundInspectionV1> {
		const invalid = () =>
			buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-inspection", {
				status: "invalid" as const,
			});
		const conflict = () =>
			buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-inspection", {
				status: "conflict" as const,
			});
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-inspect-request", request))
			return invalid();
		const registration = request.registration;
		const initial = registration.sendAwaitOutboundState;
		if (
			initial === null ||
			!exactJson(request.currentAuthority, registration.claim.currentAuthority) ||
			!exactJson(request.plan, initial.plan)
		)
			return conflict();
		const taskKey = await this.#hubTaskKeyForCurrentAuthority(registration.claim.currentAuthority);
		if (taskKey === null) return conflict();
		const runtime = transientRuntimeState(
			taskKey,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
		);
		const stored =
			runtime.parentDeliveries[detachedHubReturnTargetMapKey(registration.claim.selector.key.hubWaitInvocationId)];
		if (stored === undefined) return conflict();
		const row = loadDetachedHubReturnTargetRow(stored);
		if (!exactJson(row.registrationReceipt, registration) || row.sendAwaitOutboundState === null) return conflict();
		const current = row.sendAwaitOutboundState;
		if (current.state === "not_applied")
			return request.expectedOutboundStateSha256 === current.stateSha256 &&
				request.expectedTransitionRequestSha256 === null &&
				request.expectedTransitionReceiptSha256 === null
				? buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-inspection", {
						status: "not_applied" as const,
						state: current,
					})
				: conflict();
		if (current.state === "settled") {
			const targetRequest = current.receipt.targetDeliverySettledEntry.request;
			if (
				request.expectedOutboundStateSha256 !== current.stateSha256 &&
				(request.expectedTransitionRequestSha256 !== targetRequest.outboundTransitionRequestSha256 ||
					request.expectedTransitionReceiptSha256 !== targetRequest.outboundTransitionReceiptSha256)
			)
				return conflict();
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-inspection", {
				status: "settled" as const,
				receipt: current.receipt,
			});
		}
		if (current.state === "blocked_indeterminate") return conflict();
		if (
			request.expectedOutboundStateSha256 !== current.stateSha256 ||
			request.expectedTransitionRequestSha256 !== current.transitionRequest.requestSha256 ||
			request.expectedTransitionReceiptSha256 !== current.transitionReceipt.receiptSha256 ||
			!exactJson(request.targetDeliveryInspectRequest.permit, current.transitionRequest.targetDeliveryPermit) ||
			request.targetDeliveryInspectRequest.sendOperationId !== current.plan.sendOperationId ||
			request.targetDeliveryInspectRequest.messageSha256 !== current.plan.message.messageSha256
		)
			return conflict();
		let targetInspection: ConfidentialTransientTaskHubSendAwaitTargetDeliveryInspectionV1;
		try {
			targetInspection = await this.#inspectExactHubSendAwaitTargetMessage(
				taskKey,
				registration,
				request.targetDeliveryInspectRequest,
			);
		} catch {
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-inspection", {
				status: "outcome_unknown" as const,
				state: current,
			});
		}
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-inspection",
				targetInspection,
			)
		)
			return invalid();
		const exactRequest = this.#hubSendAwaitExactMessageRequest(current.transitionRequest, current.transitionReceipt);
		if (
			(targetInspection.status === "matching_pending_entry" || targetInspection.status === "outcome_unknown") &&
			!exactJson(targetInspection.entry.request, exactRequest)
		)
			return conflict();
		if (targetInspection.status === "matching_settled_entry") {
			if (!exactJson(targetInspection.entry.request, exactRequest)) return conflict();
			const settled = this.#hubSendAwaitSettledState(
				current.plan,
				current.transitionReceipt.receiptSha256,
				targetInspection.entry,
			);
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-inspection", {
				status: "settled" as const,
				receipt: settled.receipt,
			});
		}
		if (targetInspection.status === "authoritative_absence") {
			if (
				!exactJson(targetInspection.proof.permit, current.transitionRequest.targetDeliveryPermit) ||
				!exactJson(targetInspection.proof.inspectRequest, request.targetDeliveryInspectRequest)
			)
				return conflict();
			const proof = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-authoritative-absence", {
				inspectRequest: request,
				transitionRequest: current.transitionRequest,
				transitionReceipt: current.transitionReceipt,
				targetDeliveryAbsenceProof: targetInspection.proof,
				provenAt: targetInspection.proof.provenAt,
			});
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-inspection", {
				status: "authoritative_absence" as const,
				proof,
			});
		}
		if (targetInspection.status === "conflict" || targetInspection.status === "invalid")
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-inspection", {
				status: targetInspection.status,
			});
		return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-inspection", {
			status: "outcome_unknown" as const,
			state: current,
		});
	}

	async #adoptHubSendAwaitOutbound(
		request: Parameters<TransientTaskHubSendAwaitOutboundEffectV1["adopt"]>[0],
	): Promise<ConfidentialTransientTaskHubSendAwaitOutboundAdoptResultV1> {
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-adopt-request", request) ||
			request.expectedInspectionSha256 !== request.inspection.inspectionSha256
		)
			return { status: "invalid" } as const;
		if (request.inspection.status === "conflict" || request.inspection.status === "invalid")
			return { status: request.inspection.status } as const;
		const inspection = await this.#inspectHubSendAwaitOutbound(request.inspectRequest);
		if (!exactJson(inspection, request.inspection)) return { status: "conflict" } as const;
		const registration = request.inspectRequest.registration;
		const initial = registration.sendAwaitOutboundState;
		if (initial === null) return { status: "conflict" } as const;
		const taskKey = await this.#hubTaskKeyForCurrentAuthority(registration.claim.currentAuthority);
		if (taskKey === null) return { status: "conflict" } as const;
		const mapKey = detachedHubReturnTargetMapKey(registration.claim.selector.key.hubWaitInvocationId);
		let nextState: ConfidentialTransientTaskHubSendAwaitOutboundStateV1;
		let result:
			| { readonly status: "settled"; readonly receipt: ConfidentialTransientTaskHubSendAwaitOutboundReceiptV1 }
			| {
					readonly status: "restored_not_applied";
					readonly state: Extract<ConfidentialTransientTaskHubSendAwaitOutboundStateV1, { state: "not_applied" }>;
			  }
			| {
					readonly status: "blocked_indeterminate";
					readonly state: Extract<
						ConfidentialTransientTaskHubSendAwaitOutboundStateV1,
						{ state: "blocked_indeterminate" }
					>;
			  };
		if (inspection.status === "settled") {
			nextState = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-state", {
				state: "settled" as const,
				plan: request.inspectRequest.plan,
				receipt: inspection.receipt,
			});
			result = { status: "settled", receipt: inspection.receipt };
		} else if (inspection.status === "authoritative_absence" || inspection.status === "not_applied") {
			nextState = initial;
			result = { status: "restored_not_applied", state: initial };
		} else if (inspection.status === "outcome_unknown") {
			let targetInspection = await this.#inspectExactHubSendAwaitTargetMessage(
				taskKey,
				registration,
				request.inspectRequest.targetDeliveryInspectRequest,
			);
			if (targetInspection.status === "matching_pending_entry") {
				const recovered = await this.#recoverAcceptedHubSendAwaitTarget(
					taskKey,
					registration,
					targetInspection.entry,
					request.adoptedAt,
				);
				if (recovered.status === "settled" || recovered.status === "already_settled") {
					const settled = this.#hubSendAwaitSettledState(
						request.inspectRequest.plan,
						inspection.state.transitionReceipt.receiptSha256,
						recovered.entry,
					);
					nextState = settled;
					result = { status: "settled", receipt: settled.receipt };
				} else {
					targetInspection = await this.#inspectExactHubSendAwaitTargetMessage(
						taskKey,
						registration,
						request.inspectRequest.targetDeliveryInspectRequest,
					);
					if (targetInspection.status !== "outcome_unknown") return { status: "conflict" } as const;
					const current = inspection.state;
					const blocked = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-state", {
						state: "blocked_indeterminate" as const,
						plan: current.plan,
						transitionRequest: current.transitionRequest,
						transitionReceipt: current.transitionReceipt,
						inspection: targetInspection,
					});
					if (blocked.state !== "blocked_indeterminate") return { status: "conflict" } as const;
					nextState = blocked;
					result = { status: "blocked_indeterminate", state: blocked };
				}
			} else if (targetInspection.status === "matching_settled_entry") {
				const settled = this.#hubSendAwaitSettledState(
					request.inspectRequest.plan,
					inspection.state.transitionReceipt.receiptSha256,
					targetInspection.entry,
				);
				nextState = settled;
				result = { status: "settled", receipt: settled.receipt };
			} else if (targetInspection.status === "authoritative_absence") {
				return { status: "conflict" } as const;
			} else if (targetInspection.status === "outcome_unknown") {
				const current = inspection.state;
				const blocked = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-outbound-state", {
					state: "blocked_indeterminate" as const,
					plan: current.plan,
					transitionRequest: current.transitionRequest,
					transitionReceipt: current.transitionReceipt,
					inspection: targetInspection,
				});
				if (blocked.state !== "blocked_indeterminate") return { status: "conflict" } as const;
				nextState = blocked;
				result = { status: "blocked_indeterminate", state: blocked };
			} else {
				return { status: "conflict" } as const;
			}
		} else {
			return { status: "conflict" } as const;
		}
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
			const runtime = transientRuntimeState(taskKey, currentInput);
			const stored = runtime.parentDeliveries[mapKey];
			if (stored === undefined) return { state: runtime, result: { status: "conflict" } as const };
			const row = loadDetachedHubReturnTargetRow(stored);
			if (!exactJson(row.registrationReceipt, registration) || row.sendAwaitOutboundState === null)
				return { state: runtime, result: { status: "conflict" } as const };
			const current = row.sendAwaitOutboundState;
			if (exactJson(current, nextState)) return { state: runtime, result };
			if (inspection.status === "not_applied") return { state: runtime, result: { status: "conflict" } as const };
			if (
				current.state !== "outcome_unknown" ||
				current.stateSha256 !== request.inspectRequest.expectedOutboundStateSha256 ||
				current.transitionRequest.requestSha256 !== request.inspectRequest.expectedTransitionRequestSha256 ||
				current.transitionReceipt.receiptSha256 !== request.inspectRequest.expectedTransitionReceiptSha256
			)
				return { state: runtime, result: { status: "conflict" } as const };
			if (
				inspection.status === "authoritative_absence" &&
				(!exactJson(inspection.proof.transitionRequest, current.transitionRequest) ||
					!exactJson(inspection.proof.transitionReceipt, current.transitionReceipt))
			)
				return { state: runtime, result: { status: "conflict" } as const };
			const nextRow = { ...row, sendAwaitOutboundState: nextState };
			return {
				state: {
					...runtime,
					parentDeliveries: { ...runtime.parentDeliveries, [mapKey]: storeForegroundValue(nextRow) },
				},
				result,
			};
		});
	}

	#hubReturnBlock(
		request: ConfidentialTransientTaskHubWaitMessageReturnDeliveryRequestV1,
		reason: ConfidentialTransientTaskHubWaitMessageReturnBlockV1["reason"],
	): ConfidentialTransientTaskHubWaitMessageReturnBlockV1 {
		return buildTransientTaskHubWaitMessageCanonicalRecordV1("return-block", {
			key: request.targetRegistration.claim.selector.key,
			returnTargetSha256: request.targetRegistration.target.returnTargetSha256,
			completionReceiptSha256: request.completionReceiptSha256,
			reason,
		});
	}

	async registerMessageReturnTarget(
		request: Parameters<TransientTaskHubWaitMessageReturnTargetBridgeV1["registerMessageReturnTarget"]>[0],
	) {
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("return-target-registration-request", request))
			return { status: "invalid" } as const;
		const key = request.claim.selector.key;
		const taskKey = await this.#hubTaskKeyForCurrentAuthority(request.claim.currentAuthority);
		if (!taskKey) return { status: "invalid" } as const;
		const sendAwaitOutboundState =
			request.claim.resumePlan.mode === "send_await"
				? this.#hubSendAwaitInitialState(request.claim.resumePlan.sendAwaitOutboundPlan)
				: null;
		const receipt = buildTransientTaskHubWaitMessageCanonicalRecordV1("return-target-registration-receipt", {
			claim: request.claim,
			target: request.target,
			afterToolCallPlan: request.afterToolCallPlan,
			sendAwaitOutboundState,
			registrationRequestSha256: request.requestSha256,
			registeredAt: request.preparedAt,
		});
		const ref = buildTransientTaskHubWaitMessageCanonicalRecordV1("preselection-recovery-ref", {
			schemaVersion: 1 as const,
			hubWaitInvocationId: key.hubWaitInvocationId,
			currentAuthoritySha256: request.claim.currentAuthority.authoritySha256,
			keySha256: hashTransientTaskHubWaitMessageCanonicalRecordV1("winner-key", key),
			selectorInstallRequestSha256: request.claim.selector.selectorInstallRequestSha256,
			resumePlanSha256: request.claim.resumePlan.resumePlanSha256,
			returnTargetSha256: request.target.returnTargetSha256,
			afterToolCallPlanSha256: request.afterToolCallPlan.planSha256,
			preselectionClaimSha256: request.claim.claimSha256,
			registrationRequestSha256: request.requestSha256,
			registrationReceiptSha256: receipt.receiptSha256,
			selectionPreparedAt: request.claim.selector.selectionPreparedAt,
			registeredAt: receipt.registeredAt,
		});
		const locator: PrivateDetachedHubReturnTargetLocatorV1 = { taskId: taskKey.taskId, runId: taskKey.runId, ref };
		try {
			const indexed = await this.#durable.transact(
				TRANSIENT_NAMESPACE,
				detachedHubReturnTargetRecoveryIndexKey(key.ownerId, key.senderId),
				currentInput => {
					if (currentInput === null) {
						const state: PrivateDetachedHubReturnTargetRecoveryIndexV1 = {
							schemaVersion: 1,
							ownerId: key.ownerId,
							senderId: key.senderId,
							currentAuthoritySha256: request.claim.currentAuthority.authoritySha256,
							locators: [locator],
						};
						return { state, result: "indexed" as const };
					}
					if (!validDetachedHubReturnTargetRecoveryIndex(currentInput, key.ownerId, key.senderId))
						return { state: currentInput, result: "claim_conflict" as const };
					if (currentInput.currentAuthoritySha256 !== request.claim.currentAuthority.authoritySha256)
						return { state: currentInput, result: "stale_authority" as const };
					const prior = currentInput.locators.find(
						entry => entry.ref.hubWaitInvocationId === key.hubWaitInvocationId,
					);
					if (prior) {
						if (exactJson(prior, locator)) return { state: currentInput, result: "indexed" as const };
						return {
							state: currentInput,
							result:
								prior.ref.preselectionClaimSha256 === request.claim.claimSha256
									? ("target_conflict" as const)
									: ("claim_conflict" as const),
						};
					}
					return {
						state: { ...currentInput, locators: [...currentInput.locators, locator] },
						result: "indexed" as const,
					};
				},
			);
			if (indexed !== "indexed") return { status: indexed } as const;
			return await this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
				try {
					const state = transientRuntimeState(taskKey, currentInput);
					const mapKey = detachedHubReturnTargetMapKey(key.hubWaitInvocationId);
					const stored = state.parentDeliveries[mapKey];
					if (stored !== undefined) {
						const row = loadDetachedHubReturnTargetRow(stored);
						if (exactJson(row.registrationReceipt, receipt))
							return {
								state,
								result: { status: "already_registered", receipt: row.registrationReceipt } as const,
							};
						if (
							row.registrationReceipt.claim.currentAuthority.authoritySha256 !==
							request.claim.currentAuthority.authoritySha256
						)
							return { state, result: { status: "stale_authority" } as const };
						if (row.registrationReceipt.claim.claimSha256 !== request.claim.claimSha256)
							return { state, result: { status: "claim_conflict" } as const };
						return { state, result: { status: "target_conflict" } as const };
					}
					const row: PrivateDetachedHubReturnTargetRowV1 = {
						kind: "detached_hub_return_target",
						registrationReceipt: receipt,
						sendAwaitOutboundState,
						preselectionAdoptionReceipt: null,
						selectionReceiptSha256: null,
						retirementReceipt: null,
						retiredPlanAdoptionReceipt: null,
						delivery: null,
					};
					return {
						state: {
							...state,
							parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(row) },
						},
						result: { status: "registered", receipt } as const,
					};
				} catch {
					return { state: currentInput, result: { status: "invalid" } as const };
				}
			});
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async enumerateRegisteredMessageSelections(
		request: Parameters<
			TransientTaskHubWaitMessagePreselectionRecoveryStoreV1["enumerateRegisteredMessageSelections"]
		>[0],
	) {
		const requestSha256 = request.requestSha256;
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("preselection-enumerate-request", request))
			return { status: "invalid", requestSha256 } as const;
		try {
			const currentInput = await this.#durable.inspect(
				TRANSIENT_NAMESPACE,
				detachedHubReturnTargetRecoveryIndexKey(
					request.currentAuthority.ownerId,
					request.currentAuthority.senderId,
				),
			);
			if (currentInput !== null) {
				if (
					!validDetachedHubReturnTargetRecoveryIndex(
						currentInput,
						request.currentAuthority.ownerId,
						request.currentAuthority.senderId,
					)
				)
					return { status: "authority_conflict", requestSha256: request.requestSha256 } as const;
				if (currentInput.currentAuthoritySha256 !== request.currentAuthority.authoritySha256)
					return { status: "stale_authority", requestSha256: request.requestSha256 } as const;
			}
			const registrations = (currentInput?.locators ?? [])
				.map(entry => entry.ref)
				.sort((left, right) =>
					left.selectionPreparedAt === right.selectionPreparedAt
						? left.hubWaitInvocationId.localeCompare(right.hubWaitInvocationId)
						: left.selectionPreparedAt.localeCompare(right.selectionPreparedAt),
				);
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("preselection-enumeration", {
				status: "enumerated" as const,
				registrations,
				requestSha256: request.requestSha256,
			});
		} catch {
			return { status: "authority_conflict", requestSha256: request.requestSha256 } as const;
		}
	}

	async inspectRegisteredMessageSelection(
		request: Parameters<
			TransientTaskHubWaitMessagePreselectionRecoveryStoreV1["inspectRegisteredMessageSelection"]
		>[0],
	) {
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("preselection-inspect-request", request))
			return { status: "invalid" } as const;
		const absent = () =>
			buildTransientTaskHubWaitMessageCanonicalRecordV1("preselection-inspection", {
				status: "absent" as const,
				hubWaitInvocationId: request.hubWaitInvocationId,
				currentAuthoritySha256: request.currentAuthority.authoritySha256,
				requestSha256: request.requestSha256,
			});
		try {
			const indexInput = await this.#durable.inspect(
				TRANSIENT_NAMESPACE,
				detachedHubReturnTargetRecoveryIndexKey(
					request.currentAuthority.ownerId,
					request.currentAuthority.senderId,
				),
			);
			if (indexInput === null) return absent();
			if (
				!validDetachedHubReturnTargetRecoveryIndex(
					indexInput,
					request.currentAuthority.ownerId,
					request.currentAuthority.senderId,
				)
			)
				return { status: "conflict" } as const;
			if (indexInput.currentAuthoritySha256 !== request.currentAuthority.authoritySha256)
				return { status: "stale_authority" } as const;
			const locator = indexInput.locators.find(
				entry => entry.ref.hubWaitInvocationId === request.hubWaitInvocationId,
			);
			if (!locator) return absent();
			const ref = locator.ref;
			if (
				ref.keySha256 !== request.keySha256 ||
				ref.selectorInstallRequestSha256 !== request.selectorInstallRequestSha256 ||
				ref.resumePlanSha256 !== request.resumePlanSha256 ||
				ref.returnTargetSha256 !== request.returnTargetSha256 ||
				ref.afterToolCallPlanSha256 !== request.afterToolCallPlanSha256 ||
				ref.preselectionClaimSha256 !== request.preselectionClaimSha256 ||
				ref.registrationRequestSha256 !== request.registrationRequestSha256 ||
				(request.expectedRecoveryRefSha256 !== null && request.expectedRecoveryRefSha256 !== ref.refSha256)
			)
				return { status: "conflict" } as const;
			const taskKey = { taskId: locator.taskId, runId: locator.runId };
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			const stored = state.parentDeliveries[detachedHubReturnTargetMapKey(request.hubWaitInvocationId)];
			if (stored === undefined) return absent();
			const row = loadDetachedHubReturnTargetRow(stored);
			const registration = row.registrationReceipt;
			if (
				registration.receiptSha256 !== ref.registrationReceiptSha256 ||
				registration.registrationRequestSha256 !== ref.registrationRequestSha256 ||
				registration.claim.claimSha256 !== ref.preselectionClaimSha256 ||
				hashTransientTaskHubWaitMessageCanonicalRecordV1("winner-key", registration.claim.selector.key) !==
					ref.keySha256
			)
				return { status: "conflict" } as const;
			if (row.retirementReceipt !== null)
				return buildTransientTaskHubWaitMessageCanonicalRecordV1("preselection-inspection", {
					status: "retired" as const,
					ref,
					retirementReceiptSha256: row.retirementReceipt.receiptSha256,
				});
			if (row.selectionReceiptSha256 !== null)
				return buildTransientTaskHubWaitMessageCanonicalRecordV1("preselection-inspection", {
					status: "selection_committed" as const,
					ref,
					selectionReceiptSha256: row.selectionReceiptSha256,
				});
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("preselection-inspection", {
				status: "registered_unselected" as const,
				ref,
			});
		} catch {
			return { status: "conflict" } as const;
		}
	}

	async adoptRegisteredMessageSelection(
		request: Parameters<TransientTaskHubWaitMessagePreselectionRecoveryStoreV1["adoptRegisteredMessageSelection"]>[0],
	) {
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("preselection-adopt-request", request))
			return { status: "invalid" } as const;
		try {
			const currentAuthority = request.currentAuthority;
			const ref = request.matchingInspection.ref;
			const indexInput = await this.#durable.inspect(
				TRANSIENT_NAMESPACE,
				detachedHubReturnTargetRecoveryIndexKey(currentAuthority.ownerId, currentAuthority.senderId),
			);
			if (indexInput === null) return { status: "absent" } as const;
			if (
				!validDetachedHubReturnTargetRecoveryIndex(indexInput, currentAuthority.ownerId, currentAuthority.senderId)
			)
				return { status: "conflict" } as const;
			if (indexInput.currentAuthoritySha256 !== currentAuthority.authoritySha256)
				return { status: "stale_authority" } as const;
			const locator = indexInput.locators.find(entry => entry.ref.hubWaitInvocationId === ref.hubWaitInvocationId);
			if (!locator || !exactJson(locator.ref, ref)) return { status: "conflict" } as const;
			const taskKey = { taskId: locator.taskId, runId: locator.runId };
			const mapKey = detachedHubReturnTargetMapKey(ref.hubWaitInvocationId);
			return await this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
				try {
					const state = transientRuntimeState(taskKey, currentInput);
					const stored = state.parentDeliveries[mapKey];
					if (stored === undefined) return { state, result: { status: "absent" } as const };
					const row = loadDetachedHubReturnTargetRow(stored);
					if (
						row.registrationReceipt.receiptSha256 !== ref.registrationReceiptSha256 ||
						row.registrationReceipt.claim.currentAuthority.authoritySha256 !== currentAuthority.authoritySha256
					)
						return { state, result: { status: "conflict" } as const };
					if (row.selectionReceiptSha256 !== null)
						return { state, result: { status: "selection_committed" } as const };
					if (row.retirementReceipt !== null) return { state, result: { status: "retired" } as const };
					const receipt = buildTransientTaskHubWaitMessageCanonicalRecordV1("preselection-adoption-receipt", {
						currentAuthoritySha256: currentAuthority.authoritySha256,
						registration: row.registrationReceipt,
						inspectRequestSha256: request.request.requestSha256,
						inspectionSha256: request.matchingInspection.inspectionSha256,
						adoptRequestSha256: request.requestSha256,
						adoptedAt: request.adoptedAt,
					});
					if (row.preselectionAdoptionReceipt !== null) {
						if (exactJson(row.preselectionAdoptionReceipt, receipt))
							return {
								state,
								result: { status: "already_adopted", receipt: row.preselectionAdoptionReceipt } as const,
							};
						return { state, result: { status: "conflict" } as const };
					}
					const nextRow = { ...row, preselectionAdoptionReceipt: receipt };
					return {
						state: {
							...state,
							parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(nextRow) },
						},
						result: { status: "adopted", receipt } as const,
					};
				} catch {
					return { state: currentInput, result: { status: "conflict" } as const };
				}
			});
		} catch {
			return { status: "conflict" } as const;
		}
	}

	async resumeRegisteredMessageSelection(
		request: Parameters<
			TransientTaskHubWaitMessagePreselectionRecoveryStoreV1["resumeRegisteredMessageSelection"]
		>[0],
	) {
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("preselection-resume-request", request))
			return { status: "invalid" } as const;
		const registration = request.adoption.registration;
		const taskKey = await this.#hubTaskKeyForCurrentAuthority(registration.claim.currentAuthority);
		if (!taskKey) return { status: "claim_conflict" } as const;
		try {
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			const stored =
				state.parentDeliveries[detachedHubReturnTargetMapKey(registration.claim.selector.key.hubWaitInvocationId)];
			if (stored === undefined) return { status: "claim_conflict" } as const;
			const row = loadDetachedHubReturnTargetRow(stored);
			if (
				row.registrationReceipt.claim.currentAuthority.authoritySha256 !== request.currentAuthority.authoritySha256
			)
				return { status: "stale_authority" } as const;
			if (!exactJson(row.preselectionAdoptionReceipt, request.adoption))
				return { status: "claim_conflict" } as const;
			if (row.selectionReceiptSha256 !== null)
				return { status: "selection_committed", selectionReceiptSha256: row.selectionReceiptSha256 } as const;
			if (row.retirementReceipt !== null)
				return { status: "retired", retirementReceiptSha256: row.retirementReceipt.receiptSha256 } as const;
			return {
				status: "resumed",
				preselectionClaimSha256: row.registrationReceipt.claim.claimSha256,
				registrationReceiptSha256: row.registrationReceipt.receiptSha256,
			} as const;
		} catch {
			return { status: "claim_conflict" } as const;
		}
	}

	async retireMessageReturnTarget(
		request: Parameters<TransientTaskHubWaitMessageReturnTargetBridgeV1["retireMessageReturnTarget"]>[0],
	) {
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("return-target-retirement-request", request))
			return { status: "invalid" } as const;
		const taskKey = await this.#hubTaskKeyForCurrentAuthority(request.registration.claim.currentAuthority);
		if (!taskKey) return { status: "absent" } as const;
		const mapKey = detachedHubReturnTargetMapKey(request.key.hubWaitInvocationId);
		try {
			return await this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
				try {
					const state = transientRuntimeState(taskKey, currentInput);
					const stored = state.parentDeliveries[mapKey];
					if (stored === undefined) return { state, result: { status: "absent" } as const };
					const row = loadDetachedHubReturnTargetRow(stored);
					if (!exactJson(row.registrationReceipt, request.registration))
						return { state, result: { status: "conflict" } as const };
					if (row.selectionReceiptSha256 !== null)
						return { state, result: { status: "selection_committed" } as const };
					const outbound = row.sendAwaitOutboundState;
					if (
						request.registration.claim.resumePlan.mode === "send_await"
							? outbound?.state !== "settled" || !exactJson(outbound.receipt, request.sendAwaitOutboundReceipt)
							: outbound !== null || request.sendAwaitOutboundReceipt !== null
					)
						return { state, result: { status: "conflict" } as const };
					const receipt = buildTransientTaskHubWaitMessageCanonicalRecordV1("return-target-retirement-receipt", {
						registration: request.registration,
						keySha256: hashTransientTaskHubWaitMessageCanonicalRecordV1("winner-key", request.key),
						exitSha256: request.exit.exitSha256,
						sendAwaitOutboundReceipt: request.sendAwaitOutboundReceipt,
						retirementRequestSha256: request.requestSha256,
						retiredAt: request.retiredAt,
					});
					if (row.retirementReceipt !== null) {
						if (exactJson(row.retirementReceipt, receipt))
							return {
								state,
								result: { status: "already_retired", receipt: row.retirementReceipt } as const,
							};
						return { state, result: { status: "conflict" } as const };
					}
					const nextRow = { ...row, retirementReceipt: receipt };
					return {
						state: {
							...state,
							parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(nextRow) },
						},
						result: { status: "retired", receipt } as const,
					};
				} catch {
					return { state: currentInput, result: { status: "conflict" } as const };
				}
			});
		} catch {
			return { status: "conflict" } as const;
		}
	}

	async adoptRetiredMessageReturnPlan(
		request: Parameters<TransientTaskHubWaitMessageReturnTargetBridgeV1["adoptRetiredMessageReturnPlan"]>[0],
	) {
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("retired-plan-adopt-request", request))
			return { status: "invalid" } as const;
		const registration = request.retirementReceipt.registration;
		const key = registration.claim.selector.key;
		const taskKey = await this.#hubTaskKeyForCurrentAuthority(registration.claim.currentAuthority);
		if (!taskKey) return { status: "absent" } as const;
		const mapKey = detachedHubReturnTargetMapKey(key.hubWaitInvocationId);
		try {
			return await this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
				try {
					const state = transientRuntimeState(taskKey, currentInput);
					const stored = state.parentDeliveries[mapKey];
					if (stored === undefined) return { state, result: { status: "absent" } as const };
					const row = loadDetachedHubReturnTargetRow(stored);
					if (row.selectionReceiptSha256 !== null)
						return { state, result: { status: "selection_committed" } as const };
					if (!exactJson(row.retirementReceipt, request.retirementReceipt))
						return { state, result: { status: "consumer_conflict" } as const };
					const receipt = buildTransientTaskHubWaitMessageCanonicalRecordV1("retired-plan-adoption-receipt", {
						retirementReceiptSha256: request.retirementReceipt.receiptSha256,
						target: registration.target,
						afterToolCallPlan: registration.afterToolCallPlan,
						ordinaryReturnResult: request.ordinaryReturnResult,
						sendAwaitOutboundReceipt: request.retirementReceipt.sendAwaitOutboundReceipt,
						adoptionRequestSha256: request.requestSha256,
						adoptedAt: request.adoptedAt,
					});
					if (row.retiredPlanAdoptionReceipt !== null) {
						if (exactJson(row.retiredPlanAdoptionReceipt, receipt))
							return {
								state,
								result: { status: "already_adopted", receipt: row.retiredPlanAdoptionReceipt } as const,
							};
						return { state, result: { status: "consumer_conflict" } as const };
					}
					const nextRow = { ...row, retiredPlanAdoptionReceipt: receipt };
					return {
						state: {
							...state,
							parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(nextRow) },
						},
						result: { status: "adopted", receipt } as const,
					};
				} catch {
					return { state: currentInput, result: { status: "consumer_conflict" } as const };
				}
			});
		} catch {
			return { status: "consumer_conflict" } as const;
		}
	}

	async deliverMessageReturn(
		request: Parameters<TransientTaskHubWaitMessageReturnTargetBridgeV1["deliverMessageReturn"]>[0],
	) {
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("return-delivery-request", request))
			return { status: "blocked", block: this.#hubReturnBlock(request, "invalid") } as const;
		const registration = request.targetRegistration;
		const key = registration.claim.selector.key;
		const taskKey = await this.#hubTaskKeyForCurrentAuthority(registration.claim.currentAuthority);
		if (!taskKey) return { status: "blocked", block: this.#hubReturnBlock(request, "target_absent") } as const;
		const mapKey = detachedHubReturnTargetMapKey(key.hubWaitInvocationId);
		try {
			return await this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
				try {
					const state = transientRuntimeState(taskKey, currentInput);
					const stored = state.parentDeliveries[mapKey];
					if (stored === undefined)
						return {
							state,
							result: { status: "blocked", block: this.#hubReturnBlock(request, "target_absent") } as const,
						};
					const row = loadDetachedHubReturnTargetRow(stored);
					if (!exactJson(row.registrationReceipt, registration))
						return {
							state,
							result: { status: "blocked", block: this.#hubReturnBlock(request, "target_conflict") } as const,
						};
					if (row.retirementReceipt !== null || row.selectionReceiptSha256 === null)
						return {
							state,
							result: { status: "blocked", block: this.#hubReturnBlock(request, "target_stale") } as const,
						};
					const winnerStored = state.parentDeliveries[detachedHubWinnerMapKey(key)];
					if (winnerStored === undefined)
						return {
							state,
							result: { status: "blocked", block: this.#hubReturnBlock(request, "target_stale") } as const,
						};
					const winner = loadDetachedHubWinnerRow(winnerStored);
					const completion = winner.completionReceipt;
					if (completion === null || completion.receiptSha256 !== request.completionReceiptSha256)
						return {
							state,
							result: { status: "blocked", block: this.#hubReturnBlock(request, "operation_conflict") } as const,
						};
					if (
						!exactJson(completion.returnTargetRegistration, registration) ||
						!exactJson(completion.returnTarget, registration.target)
					)
						return {
							state,
							result: { status: "blocked", block: this.#hubReturnBlock(request, "target_conflict") } as const,
						};
					if (completion.selectionReceipt.receiptSha256 !== row.selectionReceiptSha256)
						return {
							state,
							result: { status: "blocked", block: this.#hubReturnBlock(request, "operation_conflict") } as const,
						};
					if (
						registration.target.serializerKey.serializerKeySha256 !==
						completion.returnTarget.serializerKey.serializerKeySha256
					)
						return {
							state,
							result: {
								status: "blocked",
								block: this.#hubReturnBlock(request, "serializer_key_mismatch"),
							} as const,
						};
					if (
						registration.target.toolCallId !==
							completion.postHookFinalization.exactToolResultMessage.toolCallId ||
						registration.target.toolCallId !== registration.afterToolCallPlan.toolCallId
					)
						return {
							state,
							result: { status: "blocked", block: this.#hubReturnBlock(request, "tool_call_mismatch") } as const,
						};
					if (
						completion.postHookFinalization.afterToolCallPlanSha256 !==
							registration.afterToolCallPlan.planSha256 ||
						completion.postHookFinalization.returnResultSha256 !== request.returnResult.resultSha256
					)
						return {
							state,
							result: {
								status: "blocked",
								block: this.#hubReturnBlock(request, "frozen_plan_mismatch"),
							} as const,
						};
					if (!exactJson(completion.returnResult, request.returnResult))
						return {
							state,
							result: { status: "blocked", block: this.#hubReturnBlock(request, "operation_conflict") } as const,
						};
					if (registration.target.returnDeliveryOperationId !== request.returnDeliveryOperationId)
						return {
							state,
							result: { status: "blocked", block: this.#hubReturnBlock(request, "operation_conflict") } as const,
						};
					if (row.delivery !== null) {
						if (exactJson(row.delivery.request, request))
							return { state, result: { status: "already_delivered", receipt: row.delivery.receipt } as const };
						return {
							state,
							result: { status: "blocked", block: this.#hubReturnBlock(request, "operation_conflict") } as const,
						};
					}
					const receipt = buildTransientTaskHubWaitMessageCanonicalRecordV1("return-delivery-receipt", {
						target: registration.target,
						targetRegistrationReceiptSha256: registration.receiptSha256,
						completionReceiptSha256: request.completionReceiptSha256,
						returnResultSha256: request.returnResult.resultSha256,
						returnDeliveryOperationId: request.returnDeliveryOperationId,
						deliveredAt: request.requestedAt,
						deliveryRequestSha256: request.requestSha256,
					});
					const nextRow = { ...row, delivery: { request, receipt } };
					return {
						state: {
							...state,
							parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(nextRow) },
						},
						result: { status: "delivered", receipt } as const,
					};
				} catch {
					return {
						state: currentInput,
						result: {
							status: "blocked",
							block: this.#hubReturnBlock(request, "delivery_outcome_indeterminate"),
						} as const,
					};
				}
			});
		} catch {
			return {
				status: "blocked",
				block: this.#hubReturnBlock(request, "delivery_outcome_indeterminate"),
			} as const;
		}
	}

	async inspectMessageReturnDelivery(
		request: Parameters<TransientTaskHubWaitMessageReturnTargetBridgeV1["inspectMessageReturnDelivery"]>[0],
	) {
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("return-delivery-inspect-request", request))
			return { status: "invalid" } as const;
		const registration = request.targetRegistration;
		const key = registration.claim.selector.key;
		const indeterminate = () => {
			const block = buildTransientTaskHubWaitMessageCanonicalRecordV1("return-block", {
				key,
				returnTargetSha256: registration.target.returnTargetSha256,
				completionReceiptSha256: request.completionReceiptSha256,
				reason: "delivery_outcome_indeterminate" as const,
			});
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("return-delivery-inspection", {
				status: "outcome_indeterminate" as const,
				inspectRequestSha256: request.requestSha256,
				block,
			});
		};
		const taskKey = await this.#hubTaskKeyForCurrentAuthority(registration.claim.currentAuthority);
		if (!taskKey) return { status: "absent" } as const;
		try {
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			const stored = state.parentDeliveries[detachedHubReturnTargetMapKey(key.hubWaitInvocationId)];
			if (stored === undefined) return { status: "absent" } as const;
			const row = loadDetachedHubReturnTargetRow(stored);
			if (!exactJson(row.registrationReceipt, registration)) return { status: "conflict" } as const;
			if (row.delivery === null)
				return buildTransientTaskHubWaitMessageCanonicalRecordV1("return-delivery-inspection", {
					status: "not_delivered" as const,
					inspectRequestSha256: request.requestSha256,
					targetRegistrationReceiptSha256: registration.receiptSha256,
					completionReceiptSha256: request.completionReceiptSha256,
					returnResultSha256: request.expectedReturnResultSha256,
					deliveryReceipt: null,
				});
			const delivery = row.delivery;
			if (
				delivery.request.completionReceiptSha256 !== request.completionReceiptSha256 ||
				delivery.request.returnResult.resultSha256 !== request.expectedReturnResultSha256 ||
				delivery.request.returnDeliveryOperationId !== request.returnDeliveryOperationId ||
				delivery.request.requestSha256 !== request.expectedDeliveryRequestSha256
			)
				return { status: "conflict" } as const;
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("return-delivery-inspection", {
				status: "delivered" as const,
				inspectRequestSha256: request.requestSha256,
				targetRegistrationReceiptSha256: registration.receiptSha256,
				completionReceiptSha256: request.completionReceiptSha256,
				returnResultSha256: request.expectedReturnResultSha256,
				deliveryReceipt: delivery.receipt,
			});
		} catch {
			return indeterminate();
		}
	}

	async #hubTaskKeyForCurrentAuthority(
		authority: ConfidentialTransientTaskHubWaitMessageCurrentParentSessionAuthorityV1,
	): Promise<TransientTaskWorkspaceKeyV1 | null> {
		const taskKey = { taskId: authority.taskId, runId: authority.runId };
		try {
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			return state.authority?.createId === authority.createId ? taskKey : null;
		} catch {
			return null;
		}
	}

	async #indexHubWinner(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0],
		taskKey: TransientTaskWorkspaceKeyV1,
	): Promise<boolean> {
		const keySha256 = hashTransientTaskHubWaitMessageCanonicalRecordV1("winner-key", request.selector.key);
		const locator: PrivateDetachedHubRecoveryLocatorV1 = {
			schemaVersion: 1,
			keySha256,
			taskId: taskKey.taskId,
			runId: taskKey.runId,
			key: request.selector.key,
		};
		const direct = await this.#durable.transact(
			TRANSIENT_NAMESPACE,
			detachedHubLocatorKey(keySha256),
			currentInput => {
				const directLocator: PrivateDetachedHubLocatorV1 = {
					schemaVersion: 1,
					keySha256,
					taskId: taskKey.taskId,
					runId: taskKey.runId,
				};
				if (currentInput === null) return { state: directLocator, result: true };
				return {
					state: currentInput,
					result: validDetachedHubLocator(currentInput) && exactJson(currentInput, directLocator),
				};
			},
		);
		if (!direct) return false;
		return this.#durable.transact(
			TRANSIENT_NAMESPACE,
			detachedHubRecoveryIndexKey(request.selector.key.ownerId, request.selector.key.senderId),
			currentInput => {
				if (currentInput === null) {
					const state: PrivateDetachedHubRecoveryIndexV1 = {
						schemaVersion: 1,
						ownerId: request.selector.key.ownerId,
						senderId: request.selector.key.senderId,
						locators: [locator],
					};
					return { state, result: true };
				}
				if (
					!validDetachedHubRecoveryIndex(currentInput, request.selector.key.ownerId, request.selector.key.senderId)
				)
					return { state: currentInput, result: false };
				const prior = currentInput.locators.find(entry => entry.keySha256 === keySha256);
				if (prior) return { state: currentInput, result: exactJson(prior, locator) };
				return { state: { ...currentInput, locators: [...currentInput.locators, locator] }, result: true };
			},
		);
	}

	async #verifyHubSelectorOwnership(
		operation: Parameters<
			TransientTaskHubWaitMessageWinnerCompletionEffectV1["verifyCurrentHubWaitMessageSelectorOwnership"]
		>[0]["operation"],
		captureRequest: Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0],
		currentSelectorAuthority: Parameters<
			TransientTaskDetachedSettlementStoreV1["adoptMessageWinner"]
		>[0]["currentSelectorAuthority"],
		boundaryRequestSha256: Sha256Hex,
	): Promise<"current" | "stale" | "outcome_unknown"> {
		try {
			const ownership = await this.#hubWinnerCompletion.verifyCurrentHubWaitMessageSelectorOwnership({
				operation,
				captureRequest,
				currentSelectorAuthority,
				boundaryRequestSha256,
			});
			return ownership === "current" || ownership === "stale" ? ownership : "outcome_unknown";
		} catch {
			return "outcome_unknown";
		}
	}

	async #hubRow(
		key: Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0]["selector"]["key"],
	) {
		const keySha256 = hashTransientTaskHubWaitMessageCanonicalRecordV1("winner-key", key);
		const locatorInput = await this.#durable.inspect(TRANSIENT_NAMESPACE, detachedHubLocatorKey(keySha256));
		if (locatorInput === null) return null;
		if (!validDetachedHubLocator(locatorInput) || locatorInput.keySha256 !== keySha256)
			throw new TypeError("Detached Hub locator conflict");
		const taskKey = { taskId: locatorInput.taskId, runId: locatorInput.runId };
		const state = transientRuntimeState(
			taskKey,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
		);
		const stored = state.parentDeliveries[detachedHubWinnerMapKey(key)];
		if (stored === undefined) throw new TypeError("Detached Hub indexed row is absent");
		const row = loadDetachedHubWinnerRow(stored);
		if (!exactJson(row.captureRequest.selector.key, key)) throw new TypeError("Detached Hub winner conflict");
		return { taskKey, state, row } as const;
	}

	async captureMessageWinner(request: Parameters<TransientTaskDetachedSettlementStoreV1["captureMessageWinner"]>[0]) {
		if (!validDetachedHubCaptureRequest(request)) return { status: "invalid" } as const;
		const taskKey = await this.#hubTaskKeyForCurrentAuthority(
			request.returnTargetRegistrationReceipt.claim.currentAuthority,
		);
		if (!taskKey) return { status: "invalid" } as const;
		const mapKey = detachedHubWinnerMapKey(request.selector.key);
		const targetMapKey = detachedHubReturnTargetMapKey(request.selector.key.hubWaitInvocationId);
		const keySha256 = hashTransientTaskHubWaitMessageCanonicalRecordV1("winner-key", request.selector.key);
		const outcomeUnknown = {
			status: "capture_outcome_unknown" as const,
			keySha256,
			preselectionClaimSha256: request.preselectionClaimSha256,
			messageSha256: request.message.messageSha256,
			selectorInstallRequestSha256: request.selector.selectorInstallRequestSha256,
			captureRequestSha256: request.captureRequestSha256,
		};
		const result = await this.#durable
			.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
				let state: TransientTaskRuntimeStateV1;
				try {
					state = transientRuntimeState(taskKey, currentInput);
					const targetStored = state.parentDeliveries[targetMapKey];
					if (targetStored === undefined) return { state, result: { status: "conflict" } as const };
					const targetRow = loadDetachedHubReturnTargetRow(targetStored);
					if (
						!exactJson(targetRow.registrationReceipt, request.returnTargetRegistrationReceipt) ||
						targetRow.retirementReceipt !== null
					)
						return { state, result: { status: "conflict" } as const };
					const outbound = targetRow.sendAwaitOutboundState;
					if (
						request.returnTargetRegistrationReceipt.claim.resumePlan.mode === "send_await"
							? outbound?.state !== "settled" || !exactJson(outbound.receipt, request.sendAwaitOutboundReceipt)
							: outbound !== null || request.sendAwaitOutboundReceipt !== null
					)
						return { state, result: { status: "conflict" } as const };
					const stored = state.parentDeliveries[mapKey];
					if (stored !== undefined) {
						const prior = loadDetachedHubWinnerRow(stored);
						if (!exactJson(prior.captureRequest, request))
							return { state, result: { status: "conflict" } as const };
						if (prior.continuation !== null) {
							if (targetRow.selectionReceiptSha256 !== prior.continuation.selectionReceipt.receiptSha256)
								return { state, result: { status: "conflict" } as const };
							return {
								state,
								result: {
									status: "already_captured",
									selectionReceipt: prior.continuation.selectionReceipt,
									continuation: prior.continuation,
								} as const,
							};
						}
					}
					if (targetRow.selectionReceiptSha256 !== null) return { state, result: { status: "conflict" } as const };
					const releases: ConfidentialTransientTaskHubWaitMessageWinnerContinuationV1["releases"][number][] = [];
					for (const jobId of request.selector.key.watchedJobIds) {
						const locator = await this.#durable.inspect(
							TRANSIENT_NAMESPACE,
							detachedJobLocatorKey(request.selector.key.ownerId, jobId),
						);
						if (
							!validDetachedIdentityLocator(locator) ||
							locator.taskId !== taskKey.taskId ||
							locator.runId !== taskKey.runId
						)
							return { state, result: { status: "invalid" } as const };
						const settlementStored = state.parentDeliveries[detachedStoreMapKey(locator.identitySha256)];
						if (settlementStored === undefined) continue;
						const settlementRow = loadDetachedRow<PrivateDetachedSettlementRowV1>(settlementStored);
						if (settlementRow.terminalReceipt !== null) continue;
						const released = new Set<Sha256Ref>();
						for (const entry of settlementRow.attempts) {
							if (entry.attempt.operation.stage === "reservation_release" && entry.state === "applied")
								released.add(entry.attempt.operation.request.reservation.receiptSha256);
						}
						const reserved = settlementRow.attempts.find(entry => {
							if (
								entry.attempt.operation.stage !== "reservation" ||
								entry.state !== "applied" ||
								entry.receipt === null
							)
								return false;
							const reservationRequest = entry.attempt.operation.request;
							return (
								reservationRequest.disposition === "hub_wait_consumption" &&
								reservationRequest.hubWaitInvocationId === request.selector.key.hubWaitInvocationId &&
								!released.has(detachedOperationReceiptSha256(entry.receipt))
							);
						});
						if (reserved?.attempt.operation.stage !== "reservation" || reserved.receipt === null) continue;
						if (!(await validDetachedAttempt(reserved.attempt)))
							return { state, result: { status: "invalid" } as const };
						const reservationRequest = reserved.attempt.operation.request;
						if (reservationRequest.disposition !== "hub_wait_consumption") continue;
						if (!validDetachedHubWaitReservationReceipt(reserved.receipt))
							return { state, result: { status: "invalid" } as const };
						const reservation = reserved.receipt;
						const { attempt: releaseAttempt } = deriveTransientTaskHubDetachedReleaseAttemptV1({
							settlement: reservationRequest.settlement,
							currentAuthority: reservationRequest.currentAuthority,
							reservation,
							reason: "hub_message_won",
							preparedAt: request.selector.releaseAttemptPreparedAt,
						});
						const releaseCore = {
							reservation,
							releaseAttempt,
							state: "attempt_frozen" as const,
							notAppliedReceipt: null,
							releaseReceipt: null,
							terminalDisposition: null,
							terminalReceiptSha256: null,
						};
						const release = {
							...releaseCore,
							releaseStateSha256: detachedDigest("hub-release-state", releaseCore),
						};
						if (!validDetachedHubReleaseState(release)) return { state, result: { status: "invalid" } as const };
						releases.push(release);
					}
					const selectionCore = {
						schemaVersion: 1 as const,
						key: request.selector.key,
						preselectionClaimSha256: request.preselectionClaimSha256,
						messageSha256: request.message.messageSha256,
						returnTargetSha256: request.selector.key.returnTargetSha256,
						returnTargetRegistrationReceiptSha256: request.returnTargetRegistrationReceipt.receiptSha256,
						selectorInstallRequestSha256: request.selector.selectorInstallRequestSha256,
						captureRequestSha256: request.captureRequestSha256,
						sendAwaitOutboundReceiptSha256: request.sendAwaitOutboundReceipt?.receiptSha256 ?? null,
						selectedReservationReceiptSha256s: releases.map(entry => entry.reservation.receiptSha256),
						releaseAttemptSha256s: releases.map(entry => entry.releaseAttempt.attemptSha256),
						completionOperationId: request.selector.completionOperationId,
						selectionPreparedAt: request.selector.selectionPreparedAt,
					};
					const selectionReceipt = {
						...selectionCore,
						receiptSha256: detachedDigest("hub-message-selection-receipt", selectionCore),
					};
					const continuationCore = {
						schemaVersion: 1 as const,
						selector: request.selector,
						preselectionClaimSha256: request.preselectionClaimSha256,
						message: request.message,
						selectionReceipt,
						returnTargetSha256: request.selector.key.returnTargetSha256,
						returnTargetRegistration: request.returnTargetRegistrationReceipt,
						captureRequestSha256: request.captureRequestSha256,
						sendAwaitOutboundReceipt: request.sendAwaitOutboundReceipt,
						revision: 0,
						releases,
					};
					const continuation: ConfidentialTransientTaskHubWaitMessageWinnerContinuationV1 = {
						...continuationCore,
						continuationSha256: detachedDigest("hub-winner-continuation", continuationCore),
					};
					const row: PrivateDetachedHubWinnerRowV1 = {
						kind: "detached_hub_winner",
						captureRequest: request,
						continuation,
						completionReceipt: null,
						authoritativeAbsenceReceipt: null,
						acknowledgementRequest: null,
						acknowledgementReceipt: null,
					};
					const selectedTargetRow = { ...targetRow, selectionReceiptSha256: selectionReceipt.receiptSha256 };
					return {
						state: {
							...state,
							parentDeliveries: {
								...state.parentDeliveries,
								[targetMapKey]: storeForegroundValue(selectedTargetRow),
								[mapKey]: storeForegroundValue(row),
							},
						},
						result: { status: "captured", selectionReceipt, continuation } as const,
					};
				} catch {
					return { state: currentInput, result: { status: "invalid" } as const };
				}
			})
			.catch(() => outcomeUnknown);
		if (result.status !== "captured" && result.status !== "already_captured") return result;
		if (await this.#indexHubWinner(request, taskKey)) return result;
		return {
			status: "capture_outcome_unknown",
			keySha256,
			preselectionClaimSha256: request.preselectionClaimSha256,
			messageSha256: request.message.messageSha256,
			selectorInstallRequestSha256: request.selector.selectorInstallRequestSha256,
			captureRequestSha256: request.captureRequestSha256,
		} as const;
	}

	async recordReleaseProgress(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["recordReleaseProgress"]>[0],
	) {
		if (!validDetachedHubReleaseProgressRequest(request)) return { status: "invalid" } as const;
		const located = await this.#hubRow(request.key);
		if (!located) return { status: "absent" } as const;
		const mapKey = detachedHubWinnerMapKey(request.key);
		try {
			return await this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(located.taskKey), currentInput => {
				try {
					const state = transientRuntimeState(located.taskKey, currentInput);
					const row = loadDetachedHubWinnerRow(state.parentDeliveries[mapKey]);
					if (row.continuation === null || row.completionReceipt !== null)
						return { state, result: { status: "conflict" } as const };
					const current = row.continuation;
					if (
						current.revision === request.expectedRevision + 1 &&
						current.releases[request.releaseIndex] &&
						exactJson(current.releases[request.releaseIndex], request.nextReleaseState)
					)
						return { state, result: { status: "already_advanced", continuation: current } as const };
					if (
						current.revision !== request.expectedRevision ||
						current.continuationSha256 !== request.expectedContinuationSha256 ||
						request.releaseIndex >= current.releases.length
					)
						return { state, result: { status: "conflict" } as const };
					const prior = current.releases[request.releaseIndex];
					if (
						prior.releaseStateSha256 !== request.expectedReleaseStateSha256 ||
						!exactJson(prior.reservation, request.nextReleaseState.reservation) ||
						!exactJson(prior.releaseAttempt, request.nextReleaseState.releaseAttempt)
					)
						return { state, result: { status: "conflict" } as const };
					const allowed =
						(prior.state === "attempt_frozen" &&
							["prepare_outcome_unknown", "not_applied", "already_terminal"].includes(
								request.nextReleaseState.state,
							)) ||
						(prior.state === "prepare_outcome_unknown" &&
							["not_applied", "already_terminal"].includes(request.nextReleaseState.state)) ||
						(prior.state === "not_applied" &&
							["outcome_unknown", "released", "already_terminal"].includes(request.nextReleaseState.state)) ||
						(prior.state === "outcome_unknown" &&
							["not_applied", "released", "already_terminal"].includes(request.nextReleaseState.state));
					if (!allowed) return { state, result: { status: "invalid_transition" } as const };
					const releases = [...current.releases];
					releases[request.releaseIndex] = request.nextReleaseState;
					const { continuationSha256: _priorSha256, ...priorCore } = current;
					const nextCore = { ...priorCore, revision: current.revision + 1, releases };
					const continuation: ConfidentialTransientTaskHubWaitMessageWinnerContinuationV1 = {
						...nextCore,
						continuationSha256: detachedDigest("hub-winner-continuation", nextCore),
					};
					const nextRow = { ...row, continuation };
					return {
						state: {
							...state,
							parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(nextRow) },
						},
						result: { status: "advanced", continuation } as const,
					};
				} catch {
					return { state: currentInput, result: { status: "invalid" } as const };
				}
			});
		} catch {
			return {
				status: "progress_outcome_unknown",
				expectedRevision: request.expectedRevision,
				expectedContinuationSha256: request.expectedContinuationSha256,
				progressRequestSha256: request.progressRequestSha256,
			} as const;
		}
	}

	async resumeMessageWinnerReleases(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["resumeMessageWinnerReleases"]>[0],
	) {
		if (!validResultStoreIso8601(request.resumedAt)) return { status: "invalid" } as const;
		let continuation = request.continuation;
		const storeState = async (
			releaseIndex: number,
			nextCore: Omit<ConfidentialTransientTaskHubWaitMessageWinnerContinuationV1["releases"][number], "releaseStateSha256">,
		): Promise<boolean> => {
			const nextReleaseState = {
				...nextCore,
				releaseStateSha256: detachedDigest("hub-release-state", nextCore),
			} as ConfidentialTransientTaskHubWaitMessageWinnerContinuationV1["releases"][number];
			if (!validDetachedHubReleaseState(nextReleaseState)) return false;
			const core = {
				key: continuation.selector.key,
				expectedRevision: continuation.revision,
				expectedContinuationSha256: continuation.continuationSha256,
				releaseIndex,
				expectedReleaseStateSha256: continuation.releases[releaseIndex].releaseStateSha256,
				nextReleaseState,
			};
			const progress = await this.recordReleaseProgress({
				...core,
				progressRequestSha256: detachedDigest("hub-winner-release-progress-request", core).slice(
					"sha256:".length,
				) as Sha256Hex,
			});
			if (progress.status !== "advanced" && progress.status !== "already_advanced") return false;
			continuation = progress.continuation;
			return true;
		};
		const recoverRelease = async (releaseIndex: number): Promise<"terminal" | "retry" | "blocked" | "invalid"> => {
			const release = continuation.releases[releaseIndex];
			const operation = release.releaseAttempt.operation;
			if (operation.stage !== "reservation_release") return "invalid";
			const inspectRequest = {
				identitySha256: operation.request.settlement.identity.identitySha256,
				stage: "reservation_release" as const,
				operationId: operation.operationId,
				expectedRequestSha256: operation.requestSha256,
				expectedAttemptSha256: release.releaseAttempt.attemptSha256,
			};
			const inspection = await this.inspect(inspectRequest);
			if (inspection.status === "absent") return release.state === "prepare_outcome_unknown" ? "retry" : "invalid";
			if (!("notAppliedReceiptSha256" in inspection)) return "invalid";
			const adoption = await this.adopt({
				...inspectRequest,
				expectedIdentity: operation.request.settlement.identity,
				expectedOperation: operation,
				expectedAttempt: release.releaseAttempt,
				expectedNotAppliedReceiptSha256: inspection.notAppliedReceiptSha256,
				expectedReceiptSha256: inspection.status === "matching" ? inspection.receiptSha256 : null,
				expectedCurrentAuthority: operation.request.currentAuthority,
			});
			if (adoption.status === "not_applied") {
				return (await storeState(releaseIndex, {
					reservation: release.reservation,
					releaseAttempt: release.releaseAttempt,
					state: "not_applied",
					notAppliedReceipt: adoption.notAppliedReceipt,
					releaseReceipt: null,
					terminalDisposition: null,
					terminalReceiptSha256: null,
				}))
					? "retry"
					: "invalid";
			}
			if (adoption.status === "outcome_unknown") return "blocked";
			if (adoption.status !== "adopted") return "invalid";
			if ("disposition" in adoption.receipt) {
				return (await storeState(releaseIndex, {
					reservation: release.reservation,
					releaseAttempt: release.releaseAttempt,
					state: "already_terminal",
					notAppliedReceipt: release.notAppliedReceipt,
					releaseReceipt: null,
					terminalDisposition: adoption.receipt.disposition,
					terminalReceiptSha256: adoption.receipt.receiptSha256,
				}))
					? "terminal"
					: "invalid";
			}
			if (!("releaseOperationId" in adoption.receipt) || release.notAppliedReceipt === null) return "invalid";
			return (await storeState(releaseIndex, {
				reservation: release.reservation,
				releaseAttempt: release.releaseAttempt,
				state: "released",
				notAppliedReceipt: release.notAppliedReceipt,
				releaseReceipt: adoption.receipt,
				terminalDisposition: null,
				terminalReceiptSha256: null,
			}))
				? "terminal"
				: "invalid";
		};
		for (let releaseIndex = 0; releaseIndex < continuation.releases.length; releaseIndex += 1) {
			let replayAuthorized = false;
			for (;;) {
				const release = continuation.releases[releaseIndex];
				if (release.state === "released" || release.state === "already_terminal") break;
				if (release.state === "prepare_outcome_unknown" || release.state === "outcome_unknown") {
					const recovered = await recoverRelease(releaseIndex);
					if (recovered === "terminal") break;
					if (recovered === "invalid") return { status: "conflict" } as const;
					if (recovered === "blocked") return { status: "blocked_indeterminate", continuation } as const;
					replayAuthorized = true;
					if (release.state === "prepare_outcome_unknown") {
						const prepared = await this.prepare({ attempt: release.releaseAttempt });
						if (prepared.status !== "prepared" && prepared.status !== "already_prepared")
							return { status: "blocked_indeterminate", continuation } as const;
						if (
							!(await storeState(releaseIndex, {
								reservation: release.reservation,
								releaseAttempt: release.releaseAttempt,
								state: "not_applied",
								notAppliedReceipt: prepared.notAppliedReceipt,
								releaseReceipt: null,
								terminalDisposition: null,
								terminalReceiptSha256: null,
							}))
						)
							return { status: "conflict" } as const;
					}
					continue;
				}
				if (release.state === "attempt_frozen") {
					const prepared = await this.prepare({ attempt: release.releaseAttempt });
					if (prepared.status === "prepare_outcome_unknown") {
						if (
							!(await storeState(releaseIndex, {
								reservation: release.reservation,
								releaseAttempt: release.releaseAttempt,
								state: "prepare_outcome_unknown",
								notAppliedReceipt: null,
								releaseReceipt: null,
								terminalDisposition: null,
								terminalReceiptSha256: null,
							}))
						)
							return { status: "conflict" } as const;
						continue;
					}
					if (prepared.status !== "prepared" && prepared.status !== "already_prepared")
						return { status: "conflict" } as const;
					if (
						!(await storeState(releaseIndex, {
							reservation: release.reservation,
							releaseAttempt: release.releaseAttempt,
							state: "not_applied",
							notAppliedReceipt: prepared.notAppliedReceipt,
							releaseReceipt: null,
							terminalDisposition: null,
							terminalReceiptSha256: null,
						}))
					)
						return { status: "conflict" } as const;
					continue;
				}
				if (release.state !== "not_applied") return { status: "invalid" } as const;
				const effect = await this.releaseReservation({
					operation: release.releaseAttempt.operation,
					expectedAttemptSha256: release.releaseAttempt.attemptSha256,
					expectedNotAppliedReceiptSha256: release.notAppliedReceipt.receiptSha256,
				});
				if (effect.status === "released" || effect.status === "already_released") {
					if (
						!(await storeState(releaseIndex, {
							reservation: release.reservation,
							releaseAttempt: release.releaseAttempt,
							state: "released",
							notAppliedReceipt: release.notAppliedReceipt,
							releaseReceipt: effect.receipt,
							terminalDisposition: null,
							terminalReceiptSha256: null,
						}))
					)
						return { status: "conflict" } as const;
					break;
				}
				if (effect.status === "already_terminal") {
					const recovered = await recoverRelease(releaseIndex);
					if (recovered !== "terminal") return { status: "conflict" } as const;
					break;
				}
				if (effect.status !== "release_outcome_unknown") return { status: "conflict" } as const;
				if (
					!(await storeState(releaseIndex, {
						reservation: release.reservation,
						releaseAttempt: release.releaseAttempt,
						state: "outcome_unknown",
						notAppliedReceipt: release.notAppliedReceipt,
						releaseReceipt: null,
						terminalDisposition: null,
						terminalReceiptSha256: null,
					}))
				)
					return { status: "conflict" } as const;
				if (replayAuthorized) return { status: "blocked_indeterminate", continuation } as const;
			}
		}
		return { status: "released", continuation } as const;
	}

	async inspectMessageWinner(request: Parameters<TransientTaskDetachedSettlementStoreV1["inspectMessageWinner"]>[0]) {
		if (!validDetachedHubInspectRequest(request)) return { status: "invalid" } as const;
		const binding = detachedHubInspectionBinding(request);
		try {
			const located = await this.#hubRow(request.key);
			if (!located) return { status: "absent", ...binding } as const;
			const row = located.row;
			if (!detachedHubInspectRequestMatchesCapture(request, row.captureRequest))
				return { status: "conflict", ...binding } as const;
			if (row.continuation === null) return { status: "absent", ...binding } as const;
			if (row.completionReceipt !== null)
				return {
					status: "completed",
					...binding,
					selectionReceiptSha256: row.continuation.selectionReceipt.receiptSha256,
					completionReceiptSha256: row.completionReceipt.receiptSha256,
				} as const;
			return {
				status: "active",
				...binding,
				selectionReceiptSha256: row.continuation.selectionReceipt.receiptSha256,
				revision: row.continuation.revision,
				continuationSha256: row.continuation.continuationSha256,
				releaseStateSha256s: row.continuation.releases.map(entry => entry.releaseStateSha256),
				allReleasesTerminal: row.continuation.releases.every(detachedHubReleaseTerminal),
			} as const;
		} catch {
			return { status: "outcome_unknown", ...binding } as const;
		}
	}

	async adoptMessageWinner(request: Parameters<TransientTaskDetachedSettlementStoreV1["adoptMessageWinner"]>[0]) {
		if (!validDetachedHubAdoptRequest(request)) return { status: "invalid" } as const;
		const inspected = await this.inspectMessageWinner(request.inspectRequest);
		if (!exactJson(inspected, request.matchingInspection))
			return inspected.status === "outcome_unknown"
				? ({ status: "outcome_unknown" } as const)
				: ({ status: "conflict" } as const);
		const ownership = await this.#verifyHubSelectorOwnership(
			"adopt",
			request.captureRequest,
			request.currentSelectorAuthority,
			request.adoptRequestSha256,
		);
		if (ownership === "stale") return { status: "conflict" } as const;
		if (ownership === "outcome_unknown") return { status: "outcome_unknown" } as const;
		try {
			const located = await this.#hubRow(request.captureRequest.selector.key);
			if (
				!located ||
				located.row.continuation === null ||
				!exactJson(located.row.captureRequest, request.captureRequest)
			)
				return { status: "conflict" } as const;
			return located.row.completionReceipt === null
				? ({ status: "active", continuation: located.row.continuation } as const)
				: ({ status: "completed", receipt: located.row.completionReceipt } as const);
		} catch {
			return { status: "outcome_unknown" } as const;
		}
	}

	async proveMessageWinnerAuthoritativeAbsence(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["proveMessageWinnerAuthoritativeAbsence"]>[0],
	) {
		if (!validDetachedHubAbsenceRequest(request)) return { status: "invalid" } as const;
		const inspected = await this.inspectMessageWinner(request.inspectRequest);
		if (!exactJson(inspected, request.matchingAbsenceInspection))
			return inspected.status === "outcome_unknown"
				? ({ status: "outcome_unknown" } as const)
				: ({ status: "conflict" } as const);
		const taskKey = await this.#hubTaskKeyForCurrentAuthority(
			request.captureRequest.returnTargetRegistrationReceipt.claim.currentAuthority,
		);
		if (!taskKey) return { status: "invalid" } as const;
		const mapKey = detachedHubWinnerMapKey(request.captureRequest.selector.key);
		const ownership = await this.#verifyHubSelectorOwnership(
			"prove_absence",
			request.captureRequest,
			request.currentSelectorAuthority,
			request.absenceRequestSha256,
		);
		if (ownership === "stale") return { status: "conflict" } as const;
		if (ownership === "outcome_unknown") return { status: "outcome_unknown" } as const;
		const result = await this.#durable
			.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), currentInput => {
				try {
					const state = transientRuntimeState(taskKey, currentInput);
					const stored = state.parentDeliveries[mapKey];
					if (stored !== undefined) {
						const prior = loadDetachedHubWinnerRow(stored);
						if (
							!exactJson(prior.captureRequest, request.captureRequest) ||
							prior.continuation !== null ||
							prior.authoritativeAbsenceReceipt === null
						)
							return { state, result: { status: "conflict" } as const };
						return prior.authoritativeAbsenceReceipt.absenceRequestSha256 === request.absenceRequestSha256 &&
							exactJson(
								prior.authoritativeAbsenceReceipt.proof.currentSelectorAuthority,
								request.currentSelectorAuthority,
							)
							? {
									state,
									result: {
										status: "already_proven",
										receipt: prior.authoritativeAbsenceReceipt,
									} as const,
								}
							: { state, result: { status: "conflict" } as const };
					}
					const proofCore = {
						schemaVersion: 1 as const,
						captureRequest: request.captureRequest,
						currentSelectorAuthority: request.currentSelectorAuthority,
						inspectRequest: request.inspectRequest,
						absenceInspection: request.matchingAbsenceInspection,
						absenceRequestSha256: request.absenceRequestSha256,
						observedSelectorRevision: 0,
						observedInvocationState: "open" as const,
						observedWinnerState: "absent" as const,
						observedSelectionEffectState: "not_applied" as const,
						proofSource: "atomic_selector_transaction_index" as const,
						provenAt: request.proofPreparedAt,
					};
					const proof = {
						...proofCore,
						proofSha256: detachedDigest("hub-winner-authoritative-absence-proof", proofCore),
					};
					const receiptCore = {
						schemaVersion: 1 as const,
						proof,
						absenceRequestSha256: request.absenceRequestSha256,
					};
					const receipt: ConfidentialTransientTaskHubWaitMessageWinnerAuthoritativeAbsenceReceiptV1 = {
						...receiptCore,
						receiptSha256: detachedDigest("hub-winner-authoritative-absence-receipt", receiptCore),
					};
					const row: PrivateDetachedHubWinnerRowV1 = {
						kind: "detached_hub_winner",
						captureRequest: request.captureRequest,
						continuation: null,
						completionReceipt: null,
						authoritativeAbsenceReceipt: receipt,
						acknowledgementRequest: null,
						acknowledgementReceipt: null,
					};
					return {
						state: {
							...state,
							parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(row) },
						},
						result: { status: "proven", receipt } as const,
					};
				} catch {
					return { state: currentInput, result: { status: "invalid" } as const };
				}
			})
			.catch(() => ({ status: "outcome_unknown" }) as const);
		if (result.status !== "proven" && result.status !== "already_proven") return result;
		return (await this.#indexHubWinner(request.captureRequest, taskKey))
			? result
			: ({ status: "outcome_unknown" } as const);
	}

	async retryMessageWinnerAfterAuthoritativeAbsence(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["retryMessageWinnerAfterAuthoritativeAbsence"]>[0],
	) {
		if (!validDetachedHubRetryRequest(request)) return { status: "invalid" } as const;
		const outcomeUnknown = {
			status: "capture_outcome_unknown" as const,
			keySha256: hashTransientTaskHubWaitMessageCanonicalRecordV1("winner-key", request.captureRequest.selector.key),
			preselectionClaimSha256: request.captureRequest.preselectionClaimSha256,
			messageSha256: request.captureRequest.message.messageSha256,
			selectorInstallRequestSha256: request.captureRequest.selector.selectorInstallRequestSha256,
			captureRequestSha256: request.captureRequest.captureRequestSha256,
		};
		try {
			const located = await this.#hubRow(request.captureRequest.selector.key);
			if (
				!located ||
				located.row.authoritativeAbsenceReceipt === null ||
				!exactJson(located.row.authoritativeAbsenceReceipt, request.authoritativeAbsenceReceipt)
			)
				return { status: "conflict" } as const;
		} catch {
			return outcomeUnknown;
		}
		const ownership = await this.#verifyHubSelectorOwnership(
			"retry",
			request.captureRequest,
			request.currentSelectorAuthority,
			request.retryRequestSha256,
		);
		if (ownership === "stale") return { status: "conflict" } as const;
		if (ownership === "outcome_unknown") return outcomeUnknown;
		return this.captureMessageWinner(request.captureRequest);
	}

	async enumerateRecoverableMessageWinners(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["enumerateRecoverableMessageWinners"]>[0],
	) {
		if (!validDetachedHubRecoveryEnumerateRequest(request))
			throw new TypeError("Invalid Hub winner recovery enumeration request");
		const indexInput = await this.#durable.inspect(
			TRANSIENT_NAMESPACE,
			detachedHubRecoveryIndexKey(request.ownerId, request.senderId),
		);
		if (indexInput === null) {
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("winner-recovery-enumeration", {
				status: "enumerated" as const,
				continuations: [],
				requestSha256: request.requestSha256,
			});
		}
		if (!validDetachedHubRecoveryIndex(indexInput, request.ownerId, request.senderId))
			throw new TypeError("Conflicting Hub winner recovery index");
		const recovered = [];
		for (const locator of indexInput.locators) {
			const located = await this.#hubRow(locator.key);
			if (
				!located ||
				located.taskKey.taskId !== locator.taskId ||
				located.taskKey.runId !== locator.runId ||
				!exactJson(located.row.captureRequest.selector.key, locator.key)
			)
				throw new TypeError("Conflicting Hub winner recovery locator");
			const continuation = located.row.continuation;
			if (continuation === null) continue;
			const ref = buildTransientTaskHubWaitMessageCanonicalRecordV1("winner-recovery-ref", {
				key: continuation.selector.key,
				returnTargetSha256: continuation.returnTargetSha256,
				returnTargetRegistrationReceiptSha256: continuation.returnTargetRegistration.receiptSha256,
				preselectionClaimSha256: continuation.preselectionClaimSha256,
				messageSha256: continuation.message.messageSha256,
				captureRequestSha256: continuation.captureRequestSha256,
				selectorInstallRequestSha256: continuation.selector.selectorInstallRequestSha256,
				selectionReceiptSha256: continuation.selectionReceipt.receiptSha256,
				state: located.row.completionReceipt === null ? ("active" as const) : ("completed" as const),
				stateSha256: located.row.completionReceipt?.receiptSha256 ?? continuation.continuationSha256,
			});
			recovered.push({ selectionPreparedAt: continuation.selector.selectionPreparedAt, ref });
		}
		recovered.sort(
			(left, right) =>
				left.selectionPreparedAt.localeCompare(right.selectionPreparedAt) ||
				left.ref.key.hubWaitInvocationId.localeCompare(right.ref.key.hubWaitInvocationId),
		);
		return buildTransientTaskHubWaitMessageCanonicalRecordV1("winner-recovery-enumeration", {
			status: "enumerated" as const,
			continuations: recovered.map(entry => entry.ref),
			requestSha256: request.requestSha256,
		});
	}

	async resumeMessageWinners(
		request: Parameters<TransientTaskHubWaitMessageWinnerStartupRecoveryV1["resumeMessageWinners"]>[0],
	): Promise<ConfidentialTransientTaskHubWaitMessageWinnerStartupResumeResultV1> {
		const recoveredReturns: ConfidentialTransientTaskHubWaitMessageWinnerStartupResumeResultV1["recoveredReturns"][number][] =
			[];
		const blockedReturns: ConfidentialTransientTaskHubWaitMessageWinnerStartupResumeResultV1["blockedReturns"][number][] =
			[];
		const blockedKeys: ConfidentialTransientTaskHubWaitMessageWinnerStartupResumeResultV1["blockedKeys"][number][] =
			[];
		const finish = () =>
			buildTransientTaskHubWaitMessageCanonicalRecordV1("winner-startup-resume-result", {
				status: blockedKeys.length === 0 ? ("resumed" as const) : ("blocked" as const),
				recoveredReturns,
				blockedReturns,
				blockedKeys,
			});
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("winner-startup-resume-request", request)) {
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("winner-startup-resume-result", {
				status: "blocked" as const,
				recoveredReturns,
				blockedReturns,
				blockedKeys,
			});
		}
		const enumeration = await this.enumerateRecoverableMessageWinners(request.enumeration).catch(() => null);
		if (enumeration === null)
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("winner-startup-resume-result", {
				status: "blocked" as const,
				recoveredReturns,
				blockedReturns,
				blockedKeys,
			});
		for (const ref of enumeration.continuations) {
			const located = await this.#hubRow(ref.key).catch(() => null);
			if (located === null) {
				blockedKeys.push(ref.key);
				continue;
			}
			const continuation = located.row.continuation;
			if (continuation === null) {
				blockedKeys.push(ref.key);
				continue;
			}
			const row = located.row;
			const expectedRef = buildTransientTaskHubWaitMessageCanonicalRecordV1("winner-recovery-ref", {
				key: continuation.selector.key,
				returnTargetSha256: continuation.returnTargetSha256,
				returnTargetRegistrationReceiptSha256: continuation.returnTargetRegistration.receiptSha256,
				preselectionClaimSha256: continuation.preselectionClaimSha256,
				messageSha256: continuation.message.messageSha256,
				captureRequestSha256: continuation.captureRequestSha256,
				selectorInstallRequestSha256: continuation.selector.selectorInstallRequestSha256,
				selectionReceiptSha256: continuation.selectionReceipt.receiptSha256,
				state: row.completionReceipt === null ? ("active" as const) : ("completed" as const),
				stateSha256: row.completionReceipt?.receiptSha256 ?? continuation.continuationSha256,
			});
			if (!exactJson(ref, expectedRef)) {
				blockedKeys.push(ref.key);
				continue;
			}
			const completion = row.completionReceipt;
			const acknowledgementRequest = row.acknowledgementRequest;
			const acknowledgementReceipt = row.acknowledgementReceipt;
			if (completion === null || acknowledgementRequest === null || acknowledgementReceipt === null) {
				blockedKeys.push(ref.key);
				if (completion !== null)
					blockedReturns.push(
						buildTransientTaskHubWaitMessageCanonicalRecordV1("return-block", {
							key: ref.key,
							returnTargetSha256: continuation.returnTargetSha256,
							completionReceiptSha256: completion.receiptSha256,
							reason: "delivery_outcome_indeterminate" as const,
						}),
					);
				continue;
			}
			const targetStored =
				located.state.parentDeliveries[detachedHubReturnTargetMapKey(ref.key.hubWaitInvocationId)];
			if (targetStored === undefined) {
				blockedKeys.push(ref.key);
				blockedReturns.push(
					buildTransientTaskHubWaitMessageCanonicalRecordV1("return-block", {
						key: ref.key,
						returnTargetSha256: continuation.returnTargetSha256,
						completionReceiptSha256: completion.receiptSha256,
						reason: "target_absent" as const,
					}),
				);
				continue;
			}
			let targetRow: PrivateDetachedHubReturnTargetRowV1;
			try {
				targetRow = loadDetachedHubReturnTargetRow(targetStored);
			} catch {
				blockedKeys.push(ref.key);
				blockedReturns.push(
					buildTransientTaskHubWaitMessageCanonicalRecordV1("return-block", {
						key: ref.key,
						returnTargetSha256: continuation.returnTargetSha256,
						completionReceiptSha256: completion.receiptSha256,
						reason: "target_conflict" as const,
					}),
				);
				continue;
			}
			if (
				!exactJson(targetRow.registrationReceipt, continuation.returnTargetRegistration) ||
				targetRow.delivery === null ||
				!exactJson(targetRow.delivery.receipt, acknowledgementRequest.deliveryReceipt)
			) {
				blockedKeys.push(ref.key);
				blockedReturns.push(
					buildTransientTaskHubWaitMessageCanonicalRecordV1("return-block", {
						key: ref.key,
						returnTargetSha256: continuation.returnTargetSha256,
						completionReceiptSha256: completion.receiptSha256,
						reason:
							targetRow.delivery === null
								? ("delivery_outcome_indeterminate" as const)
								: ("target_conflict" as const),
					}),
				);
				continue;
			}
			const serializerHeadCommitReceipt = acknowledgementRequest.serializerHeadCommitReceipt;
			const advancedSerializerQueueState = serializerHeadCommitReceipt.core.advancedSerializerQueueState;
			const nextHeadTicket =
				advancedSerializerQueueState.core.orderedTickets[advancedSerializerQueueState.core.committedTicketCount] ??
				null;
			if (
				(nextHeadTicket?.ticketSha256 ?? null) !== serializerHeadCommitReceipt.core.nextHeadTicketSha256 ||
				serializerHeadCommitReceipt.core.advancedSerializerQueueStateSha256 !==
					advancedSerializerQueueState.queueStateSha256
			) {
				blockedKeys.push(ref.key);
				blockedReturns.push(
					buildTransientTaskHubWaitMessageCanonicalRecordV1("return-block", {
						key: ref.key,
						returnTargetSha256: continuation.returnTargetSha256,
						completionReceiptSha256: completion.receiptSha256,
						reason: "ticket_registration_conflict" as const,
					}),
				);
				continue;
			}
			recoveredReturns.push(
				buildTransientTaskHubWaitMessageCanonicalRecordV1("startup-recovered-return", {
					acknowledgementReceipt,
					deliveryReceipt: targetRow.delivery.receipt,
					serializerHeadCommitReceipt,
					ticketAllocationReceipt: completion.ticketAllocationReceipt,
					advancedSerializerQueueState,
					nextHeadTicket,
					recoveredAt: request.requestedAt,
				}),
			);
		}
		return finish();
	}

	async completeMessageWinner(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["completeMessageWinner"]>[0],
	) {
		if (
			!proxyFreeData(request) ||
			!strictRecord(request, [
				"key",
				"expectedRevision",
				"expectedContinuationSha256",
				"expectedReleaseStateSha256s",
				"expectedReturnTargetSha256",
				"expectedReturnTargetRegistrationReceiptSha256",
				"completionOperationId",
				"toolResultMessageTimestamp",
				"completedAt",
				"completionRequestSha256",
			]) ||
			!validDetachedHubKey(request.key) ||
			!validResultStoreInteger(request.expectedRevision) ||
			!validResultStoreSha256Ref(request.expectedContinuationSha256) ||
			!strictArray(request.expectedReleaseStateSha256s) ||
			!request.expectedReleaseStateSha256s.every(validResultStoreSha256Ref) ||
			!validResultStoreSha256Ref(request.expectedReturnTargetSha256) ||
			!validResultStoreSha256Ref(request.expectedReturnTargetRegistrationReceiptSha256) ||
			!validResultStoreIdentity(request.completionOperationId) ||
			!Number.isSafeInteger(request.toolResultMessageTimestamp) ||
			!validResultStoreIso8601(request.completedAt) ||
			!validResultStoreSha256Hex(request.completionRequestSha256) ||
			!detachedHubCompletionRequestMatches(request)
		)
			return { status: "invalid" } as const;
		try {
			const located = await this.#hubRow(request.key);
			if (!located || located.row.continuation === null) return { status: "absent" } as const;
			const row = located.row;
			if (row.completionReceipt !== null) {
				return row.completionReceipt.completionOperationId === request.completionOperationId &&
					row.completionReceipt.completionRequestSha256 === request.completionRequestSha256
					? ({ status: "already_completed", receipt: row.completionReceipt } as const)
					: ({ status: "conflict" } as const);
			}
			if (!detachedHubContinuationMatches(row) || row.continuation === null) return { status: "invalid" } as const;
			const continuation = row.continuation;
			if (
				continuation.revision !== request.expectedRevision ||
				continuation.continuationSha256 !== request.expectedContinuationSha256 ||
				continuation.returnTargetSha256 !== request.expectedReturnTargetSha256 ||
				continuation.returnTargetRegistration.receiptSha256 !==
					request.expectedReturnTargetRegistrationReceiptSha256 ||
				continuation.selector.completionOperationId !== request.completionOperationId ||
				!exactJson(
					continuation.releases.map(entry => entry.releaseStateSha256),
					request.expectedReleaseStateSha256s,
				)
			)
				return { status: "conflict" } as const;
			if (!continuation.releases.every(detachedHubReleaseTerminal))
				return {
					status: "releases_pending",
					releaseStateSha256s: continuation.releases.map(entry => entry.releaseStateSha256),
				} as const;
			const returnResult = detachedHubSelectedReturnResult(continuation);
			if (returnResult === null) return { status: "invalid" } as const;
			const postHookFinalization = detachedHubPostHookFinalization(
				continuation,
				returnResult,
				request.toolResultMessageTimestamp,
			);
			const target = continuation.returnTargetRegistration.target;
			const exactToolResultMessage = detachedHubMutableToolResultMessage(
				postHookFinalization.exactToolResultMessage,
			);
			const ordinaryPersistenceCore = {
				toolCallId: target.toolCallId,
				toolName: "hub",
				sourceToolResultMessage: exactToolResultMessage,
				sourceToolResultMessageSha256: postHookFinalization.exactToolResultMessageJsonUtf8Sha256,
			};
			const ordinaryPersistence = {
				...ordinaryPersistenceCore,
				ordinaryPersistenceRequestSha256: detachedDigest("hub-winner-ordinary-persistence-request", {
					serializerKeySha256: target.serializerKey.serializerKeySha256,
					...ordinaryPersistenceCore,
					completionRequestSha256: request.completionRequestSha256,
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
				requestedAt: request.completedAt,
			};
			const allocationRequest: ConfidentialAgentSessionToolResultTicketAllocationRequestV1 = {
				core: allocationCore,
				requestSha256: detachedDigest("hub-winner-ticket-allocation-request", allocationCore),
			};
			const allocationResult =
				await this.#hubWinnerCompletion.allocateOrReuseTicketBeforeEmission(allocationRequest);
			const ticketAllocationReceipt = detachedHubAllocationReceipt(
				allocationResult,
				allocationRequest,
				ticketInput,
				request.completedAt,
			);
			if (ticketAllocationReceipt === null) return { status: "invalid" } as const;
			const allocatedTicket = ticketAllocationReceipt.core.ticket;
			if (!detachedHubOrdinaryPersistenceTicket(allocatedTicket)) return { status: "invalid" } as const;
			const ordinaryPersistenceTicket = allocatedTicket;
			const injectionRegistrationCore = {
				afterToolCallPlanSha256: continuation.returnTargetRegistration.afterToolCallPlan.planSha256,
				contentPlan: continuation.returnTargetRegistration.afterToolCallPlan.ttsrInjectionContentPlan,
				ordinaryPersistenceTicketSha256: ordinaryPersistenceTicket.ticketSha256,
				registeredAt: request.completedAt,
			};
			const ttsrInjectionRegistrationReceipt: ConfidentialTransientTaskHubWaitMessageTtsrInjectionRegistrationReceiptV1 =
				{
					...injectionRegistrationCore,
					receiptSha256: detachedDigest(
						"hub-winner-ttsr-injection-registration-receipt",
						injectionRegistrationCore,
					),
				};
			const receiptCore = {
				schemaVersion: 1 as const,
				key: continuation.selector.key,
				message: continuation.message,
				selectionReceipt: continuation.selectionReceipt,
				returnTarget: target,
				returnTargetRegistration: continuation.returnTargetRegistration,
				returnResult,
				postHookFinalization,
				ordinaryPersistenceTicket,
				ticketAllocationReceipt,
				ttsrInjectionRegistrationReceipt,
				registeredSerializerQueueState: ticketAllocationReceipt.core.registeredSerializerQueueState,
				registeredSerializerQueueStateSha256:
					ticketAllocationReceipt.core.registeredSerializerQueueState.queueStateSha256,
				finalContinuationSha256: continuation.continuationSha256,
				terminalReleaseStateSha256s: continuation.releases.map(entry => entry.releaseStateSha256),
				completionOperationId: request.completionOperationId,
				completionRequestSha256: request.completionRequestSha256,
				completedAt: request.completedAt,
			};
			const receipt: ConfidentialTransientTaskHubWaitMessageWinnerCompletionReceiptV1 = {
				...receiptCore,
				receiptSha256: detachedDigest("hub-winner-completion-receipt", receiptCore),
			};
			const mapKey = detachedHubWinnerMapKey(request.key);
			return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(located.taskKey), currentInput => {
				try {
					const state = transientRuntimeState(located.taskKey, currentInput);
					const stored = state.parentDeliveries[mapKey];
					if (stored === undefined) return { state, result: { status: "absent" } as const };
					const current = loadDetachedHubWinnerRow(stored);
					if (current.completionReceipt !== null)
						return exactJson(current.completionReceipt, receipt)
							? { state, result: { status: "already_completed", receipt: current.completionReceipt } as const }
							: { state, result: { status: "conflict" } as const };
					if (current.continuation === null || !exactJson(current, row))
						return { state, result: { status: "conflict" } as const };
					const nextRow = { ...current, completionReceipt: receipt };
					return {
						state: {
							...state,
							parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(nextRow) },
						},
						result: { status: "completed", receipt } as const,
					};
				} catch {
					return { state: currentInput, result: { status: "invalid" } as const };
				}
			});
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async acknowledgeMessageReturn(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["acknowledgeMessageReturn"]>[0],
	) {
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("return-acknowledgement-request", request))
			return { status: "invalid" } as const;
		const located = await this.#hubRow(request.key);
		if (!located || located.row.completionReceipt === null) return { status: "absent" } as const;
		const completion = located.row.completionReceipt;
		if (
			completion.receiptSha256 !== request.completionReceiptSha256 ||
			completion.postHookFinalization.finalizationSha256 !== request.postHookFinalizationSha256 ||
			completion.ordinaryPersistenceTicket.ticketSha256 !== request.ordinaryPersistenceTicketSha256 ||
			completion.ticketAllocationReceipt.receiptSha256 !== request.ticketAllocationReceiptSha256 ||
			completion.ttsrInjectionRegistrationReceipt.receiptSha256 !== request.ttsrInjectionRegistrationReceiptSha256 ||
			!exactJson(request.deliveryReceipt.target, completion.returnTarget) ||
			request.deliveryReceipt.targetRegistrationReceiptSha256 !==
				completion.returnTargetRegistration.receiptSha256 ||
			request.deliveryReceipt.completionReceiptSha256 !== completion.receiptSha256 ||
			request.deliveryReceipt.returnResultSha256 !== completion.returnResult.resultSha256 ||
			request.deliveryReceipt.returnDeliveryOperationId !== request.returnDeliveryOperationId ||
			!validDetachedHubSerializerHeadCommitReceipt(
				request.serializerHeadCommitReceipt,
				completion,
				request.primaryCommitJoin,
			)
		)
			return { status: "conflict" } as const;
		const mapKey = detachedHubWinnerMapKey(request.key);
		return await this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(located.taskKey), currentInput => {
			try {
				const state = transientRuntimeState(located.taskKey, currentInput);
				const row = loadDetachedHubWinnerRow(state.parentDeliveries[mapKey]);
				if (row.completionReceipt === null || !exactJson(row.completionReceipt, completion))
					return { state, result: { status: "conflict" } as const };
				const receiptCore = {
					key: request.key,
					completionReceiptSha256: request.completionReceiptSha256,
					deliveryReceiptSha256: request.deliveryReceipt.receiptSha256,
					postHookFinalizationSha256: request.postHookFinalizationSha256,
					ordinaryPersistenceTicketSha256: request.ordinaryPersistenceTicketSha256,
					ticketAllocationReceiptSha256: request.ticketAllocationReceiptSha256,
					ttsrInjectionRegistrationReceiptSha256: request.ttsrInjectionRegistrationReceiptSha256,
					primaryCommitJoin: request.primaryCommitJoin,
					returnDeliveryOperationId: request.returnDeliveryOperationId,
					acknowledgementRequestSha256: request.requestSha256,
					acknowledgedAt: request.acknowledgedAt,
				};
				const receipt = buildTransientTaskHubWaitMessageCanonicalRecordV1(
					"return-acknowledgement-receipt",
					receiptCore,
				);
				if (row.acknowledgementReceipt !== null)
					return exactJson(row.acknowledgementRequest, request) && exactJson(row.acknowledgementReceipt, receipt)
						? {
								state,
								result: {
									status: "already_acknowledged",
									receipt: row.acknowledgementReceipt,
								} as const,
							}
						: { state, result: { status: "conflict" } as const };
				const nextRow = { ...row, acknowledgementRequest: request, acknowledgementReceipt: receipt };
				return {
					state: {
						...state,
						parentDeliveries: { ...state.parentDeliveries, [mapKey]: storeForegroundValue(nextRow) },
					},
					result: { status: "acknowledged", receipt } as const,
				};
			} catch {
				return { state: currentInput, result: { status: "conflict" } as const };
			}
		});
	}

	async inspectMessageReturnAcknowledgement(
		request: Parameters<TransientTaskDetachedSettlementStoreV1["inspectMessageReturnAcknowledgement"]>[0],
	) {
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("return-acknowledgement-inspect-request", request))
			return { status: "invalid" } as const;
		const located = await this.#hubRow(request.key);
		if (!located || located.row.completionReceipt === null) return { status: "absent" } as const;
		const completion = located.row.completionReceipt;
		if (
			completion.receiptSha256 !== request.completionReceiptSha256 ||
			completion.postHookFinalization.finalizationSha256 !== request.postHookFinalizationSha256 ||
			completion.ordinaryPersistenceTicket.ticketSha256 !== request.ordinaryPersistenceTicketSha256 ||
			completion.ticketAllocationReceipt.receiptSha256 !== request.ticketAllocationReceiptSha256 ||
			completion.ttsrInjectionRegistrationReceipt.receiptSha256 !== request.ttsrInjectionRegistrationReceiptSha256 ||
			request.primaryCommitJoin.ticketAllocationReceiptSha256 !== completion.ticketAllocationReceipt.receiptSha256
		)
			return { status: "conflict" } as const;
		const base = {
			inspectRequestSha256: request.requestSha256,
			completionReceiptSha256: request.completionReceiptSha256,
			deliveryReceiptSha256: request.deliveryReceiptSha256,
			postHookFinalizationSha256: request.postHookFinalizationSha256,
			ordinaryPersistenceTicketSha256: request.ordinaryPersistenceTicketSha256,
			ticketAllocationReceiptSha256: request.ticketAllocationReceiptSha256,
			ttsrInjectionRegistrationReceiptSha256: request.ttsrInjectionRegistrationReceiptSha256,
			primaryCommitJoin: request.primaryCommitJoin,
		};
		const acknowledgement = located.row.acknowledgementReceipt;
		if (acknowledgement === null)
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("return-acknowledgement-inspection", {
				status: "pending_acknowledgement" as const,
				...base,
				acknowledgementReceipt: null,
			});
		if (
			acknowledgement.acknowledgementRequestSha256 !== request.expectedAcknowledgementRequestSha256 ||
			acknowledgement.deliveryReceiptSha256 !== request.deliveryReceiptSha256 ||
			acknowledgement.returnDeliveryOperationId !== request.returnDeliveryOperationId ||
			!exactJson(acknowledgement.primaryCommitJoin, request.primaryCommitJoin)
		)
			return { status: "conflict" } as const;
		return buildTransientTaskHubWaitMessageCanonicalRecordV1("return-acknowledgement-inspection", {
			status: "acknowledged" as const,
			...base,
			acknowledgementReceipt: acknowledgement,
		});
	}
}
