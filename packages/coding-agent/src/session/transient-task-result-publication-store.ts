import type { ISO8601, Sha256Ref } from "../registry/persistent-agent-contracts.js";
import type { RuntimeDurableStateStoreV1 } from "./managed-workspace.js";
import type {
	PrivateResultTargetRowV1,
	PrivateTransientTaskResultPublicationDeliveryDispatchV1,
	PrivateTransientTaskResultPublicationDeliveryReconciliationV1,
	RuntimeTransientAuthorityV1,
	TransientTaskResultPublicationDeliveryResultV1,
	TransientTaskResultPublicationDeliveryV1,
	TransientTaskRuntimeStateV1,
} from "./workspace-controller-codecs.js";
import {
	cancellationReceiptTuple,
	compositionDiagnosticTuple,
	controllerProofTuple,
	detachedParentDeliveryRequest,
	exactJson,
	isCancellationPredecessor,
	nowIso,
	PublicationPayloadIdentityMismatchError,
	parentDeliveryInspectRequestForPublication,
	parentDeliveryReceiptMatchesPublication,
	parentDeliveryReceiptMatchesPublicationRequest,
	payloadEnvelopeTuple,
	pendingOutcomeTuple,
	prePendingInitializationReceiptTuple,
	prePendingPlanTuple,
	publicationControllerLifecycleMatches,
	publicationMapKey,
	publicationPayloadMismatch,
	publicationRequestMatchesCurrentLifecycle,
	publicationState,
	publicationTerminalLifecycleMatches,
	resultTargetKeyFromRecord,
	resultTargetKeyTuple,
	resultTargetLifecycleKeyMatches,
	resultTargetLifecycleMatches,
	resultTargetMapKey,
	resultTargetRow,
	strictRecord,
	TRANSIENT_NAMESPACE,
	transientKey,
	transientRuntimeState,
	tupleRef,
	validatePendingPayloadIdentity,
	validatePublicationPayloadIdentity,
	validCancellationReceipt,
	validCompositionDiagnostic,
	validInitializationReceipt,
	validParentDeliveryRequest,
	validPendingOutcome,
	validPrePendingPlan,
	validPublicationReceipt,
	validPublicationRequestShape,
	validResultStoreIdentity,
	validResultStoreInteger,
	validResultStoreIso8601,
	validResultStoreSha256Hex,
	validResultStoreSha256Ref,
	validResultTargetAuthority,
	validResultTargetControllerProof,
	validResultTargetKey,
} from "./workspace-controller-codecs.js";
import type {
	CanonicalRuntimeValue,
	ConfidentialTransientTaskParentResultDeliveryAdoptResultV1,
	ConfidentialTransientTaskParentResultDeliveryRequestV1,
	TransientTaskCancellationAcknowledgementReceiptV1,
	TransientTaskParentResultDeliveryInspectResultV1,
	TransientTaskParentResultDeliveryResultV1,
	TransientTaskParentResultDeliveryStoreV1,
	TransientTaskPendingOutcomeReceiptV1,
	TransientTaskResultPublicationPrePendingInitializationReceiptV1,
	TransientTaskResultPublicationPrePendingStateV1,
	TransientTaskResultPublicationReceiptV1,
	TransientTaskResultPublicationStateV1,
	TransientTaskResultPublicationStoreV1,
} from "./workspace-runtime-contracts.js";
import { canonicalRuntimeSha256 } from "./workspace-runtime-contracts.js";

export class TransientTaskParentResultPublicationDeliveryAdapterV1 implements TransientTaskResultPublicationDeliveryV1 {
	readonly #parentDeliveryStore: TransientTaskParentResultDeliveryStoreV1;

	constructor(parentDeliveryStore: TransientTaskParentResultDeliveryStoreV1) {
		this.#parentDeliveryStore = parentDeliveryStore;
	}

	async #reconcile(
		request: ConfidentialTransientTaskParentResultDeliveryRequestV1,
		expectedAttemptSha256: Sha256Ref,
	): Promise<PrivateTransientTaskResultPublicationDeliveryReconciliationV1> {
		const inspectRequest = parentDeliveryInspectRequestForPublication(request, expectedAttemptSha256);
		for (let pass = 0; pass < 2; pass++) {
			let inspection: TransientTaskParentResultDeliveryInspectResultV1;
			try {
				inspection = await this.#parentDeliveryStore.inspect(inspectRequest);
			} catch {
				return { status: "delivery_outcome_unknown" };
			}
			if (inspection.status === "invalid") return { status: "invalid" };
			if (
				inspection.status === "absent" ||
				inspection.status === "conflict" ||
				inspection.status === "payload_identity_mismatch"
			)
				return { status: "conflict" };
			const expectedReceiptSha256 =
				inspection.status === "matching" || inspection.status === "terminal_non_delivery"
					? inspection.receiptSha256
					: null;
			let adopted: ConfidentialTransientTaskParentResultDeliveryAdoptResultV1;
			try {
				adopted = await this.#parentDeliveryStore.adopt({
					...inspectRequest,
					deliveryAuthority: request.deliveryAuthority,
					expectedReceiptSha256,
				});
			} catch {
				return { status: "delivery_outcome_unknown" };
			}
			if (adopted.status === "conflict" && pass === 0) continue;
			if (adopted.status === "invalid") return { status: "invalid" };
			if (
				adopted.status === "absent" ||
				adopted.status === "authority_lost" ||
				adopted.status === "stale_live_receipt" ||
				adopted.status === "conflict" ||
				adopted.status === "payload_identity_mismatch"
			)
				return { status: "conflict" };
			switch (adopted.status) {
				case "not_applied":
					if (
						adopted.attempt.attemptSha256 !== expectedAttemptSha256 ||
						!exactJson(adopted.attempt.request, request)
					)
						return { status: "conflict" };
					return { status: "not_applied" };
				case "outcome_unknown":
					if (
						adopted.attempt.attemptSha256 !== expectedAttemptSha256 ||
						!exactJson(adopted.attempt.request, request)
					)
						return { status: "conflict" };
					return { status: "delivery_outcome_unknown" };
				case "terminal_non_delivery":
					if (
						adopted.attempt.attemptSha256 !== expectedAttemptSha256 ||
						!exactJson(adopted.attempt.request, request) ||
						!parentDeliveryReceiptMatchesPublication(adopted.receipt, request, expectedAttemptSha256)
					)
						return { status: "conflict" };
					return { status: "terminal_non_delivery" };
				case "adopted":
					if (
						adopted.attempt.attemptSha256 !== expectedAttemptSha256 ||
						!exactJson(adopted.attempt.request, request) ||
						!parentDeliveryReceiptMatchesPublication(adopted.receipt, request, expectedAttemptSha256)
					)
						return { status: "conflict" };
					return adopted.receipt.outcome === "delivered"
						? { status: "already_delivered", receipt: adopted.receipt }
						: { status: "already_consumed_without_enqueue", receipt: adopted.receipt };
				default:
					return { status: "conflict" };
			}
		}
		return { status: "conflict" };
	}

	#mapDispatchResult(
		result: TransientTaskParentResultDeliveryResultV1,
		request: ConfidentialTransientTaskParentResultDeliveryRequestV1,
		expectedAttemptSha256: Sha256Ref,
	): PrivateTransientTaskResultPublicationDeliveryDispatchV1 {
		if (result.status === "delivery_outcome_unknown") return { status: "response_lost" };
		if (result.status === "invalid") return { status: "invalid" };
		if (
			result.status === "delivered" ||
			result.status === "already_delivered" ||
			result.status === "consumed_without_enqueue" ||
			result.status === "already_consumed_without_enqueue"
		) {
			if (
				!parentDeliveryReceiptMatchesPublication(result.receipt, request, expectedAttemptSha256) ||
				(result.status === "delivered" || result.status === "already_delivered") !==
					(result.receipt.outcome === "delivered")
			)
				return { status: "conflict" };
			return result;
		}
		if (result.status === "delivery_epoch_invalidated" || result.status === "dead_lettered")
			return parentDeliveryReceiptMatchesPublication(result.receipt, request, expectedAttemptSha256) &&
				result.receipt.outcome === result.status
				? { status: "terminal_non_delivery" }
				: { status: "conflict" };
		return { status: "conflict" };
	}

	async #dispatch(
		request: ConfidentialTransientTaskParentResultDeliveryRequestV1,
		expectedAttemptSha256: Sha256Ref,
	): Promise<PrivateTransientTaskResultPublicationDeliveryDispatchV1> {
		if (!detachedParentDeliveryRequest(request)) return { status: "conflict" };
		try {
			return this.#mapDispatchResult(
				await this.#parentDeliveryStore.deliver({ request, expectedAttemptSha256 }),
				request,
				expectedAttemptSha256,
			);
		} catch {
			return { status: "response_lost" };
		}
	}

	async deliver(
		request: ConfidentialTransientTaskParentResultDeliveryRequestV1,
		expectedAttemptSha256: Sha256Ref,
	): Promise<TransientTaskResultPublicationDeliveryResultV1> {
		let reconciled = await this.#reconcile(request, expectedAttemptSha256);
		if (reconciled.status !== "not_applied") return reconciled;
		if (!detachedParentDeliveryRequest(request)) return { status: "conflict" };
		for (let dispatch = 0; dispatch < 2; dispatch++) {
			const result = await this.#dispatch(request, expectedAttemptSha256);
			if (result.status !== "response_lost") return result;
			reconciled = await this.#reconcile(request, expectedAttemptSha256);
			if (reconciled.status !== "not_applied") return reconciled;
			if (dispatch === 1) return { status: "delivery_outcome_unknown" };
		}
		return { status: "delivery_outcome_unknown" };
	}
}
export class DurableTransientTaskResultPublicationStoreV1 implements TransientTaskResultPublicationStoreV1 {
	readonly #durable: RuntimeDurableStateStoreV1;
	readonly #authority: RuntimeTransientAuthorityV1;
	readonly #delivery: TransientTaskResultPublicationDeliveryV1;
	readonly #now: () => ISO8601;

	constructor(options: {
		readonly durable: RuntimeDurableStateStoreV1;
		readonly authority: RuntimeTransientAuthorityV1;
		readonly delivery: TransientTaskResultPublicationDeliveryV1;
		readonly now?: () => ISO8601;
	}) {
		this.#durable = options.durable;
		this.#authority = options.authority;
		this.#delivery = options.delivery;
		this.#now = options.now ?? nowIso;
	}

	async initializePrePending(request: Parameters<TransientTaskResultPublicationStoreV1["initializePrePending"]>[0]) {
		const key = request.plan.resultTargetKey;
		if (
			!(await validPrePendingPlan(request.plan)) ||
			!validResultTargetControllerProof(request.controller) ||
			!validResultStoreInteger(request.expectedAuthorityRevision) ||
			!validResultStoreInteger(request.fencingGeneration) ||
			!validResultStoreIso8601(request.initializedAt) ||
			request.controller.taskId !== key.taskId ||
			request.controller.runId !== key.runId ||
			request.controller.createId !== key.createId
		)
			return { status: "invalid" } as const;
		const expectedRequestSha256 = await canonicalRuntimeSha256([
			"omp-transient-task-result-publication-v1",
			"pre-pending-initialize",
			1,
			prePendingPlanTuple(request.plan),
			request.expectedAuthorityRevision,
			request.fencingGeneration,
			controllerProofTuple(request.controller),
			request.initializedAt,
		]);
		if (expectedRequestSha256 !== request.requestSha256) return { status: "invalid" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const currentState = transientRuntimeState(
			taskKey,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
		);
		if (currentState.authority?.revision !== request.expectedAuthorityRevision)
			return { status: "revision_conflict" } as const;
		if (
			!publicationControllerLifecycleMatches(
				currentState,
				key,
				request.controller,
				request.expectedAuthorityRevision,
				request.fencingGeneration,
			) ||
			(await this.#authority.authorizeController(request.controller)) !== "current"
		)
			return { status: "controller_lost" } as const;
		const initializationReceipt: TransientTaskResultPublicationPrePendingInitializationReceiptV1 = {
			resultTargetKey: key,
			planSha256: request.plan.planSha256,
			requestSha256: request.requestSha256,
			initializedAt: request.initializedAt,
			receiptSha256: await tupleRef([
				"omp-transient-task-result-publication-v1",
				"pre-pending-initialization-receipt",
				1,
				resultTargetKeyTuple(key),
				request.plan.planSha256,
				request.requestSha256,
				request.initializedAt,
			]),
		};
		const ready: Extract<TransientTaskResultPublicationPrePendingStateV1, { state: "ready" }> = {
			state: "ready",
			plan: request.plan,
			initializationReceipt,
		};
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			if (state.authority?.revision !== request.expectedAuthorityRevision)
				return { state, result: { status: "revision_conflict" } as const };
			if (
				!publicationControllerLifecycleMatches(
					state,
					key,
					request.controller,
					request.expectedAuthorityRevision,
					request.fencingGeneration,
				)
			)
				return { state, result: { status: "controller_lost" } as const };
			let prior: TransientTaskResultPublicationStateV1 | null;
			try {
				prior = await publicationState(state.publications[publicationMapKey(key)]);
			} catch {
				return { state, result: { status: "invalid" } as const };
			}
			if (prior) {
				if (
					prior.state === "pending" ||
					prior.state === "publication_outcome_unknown" ||
					prior.state === "published"
				) {
					return { state, result: { status: "pending_already_exists" } as const };
				}
				if (
					prior.plan.planSha256 !== request.plan.planSha256 ||
					prior.initializationReceipt.requestSha256 !== request.requestSha256
				) {
					return { state, result: { status: "plan_conflict" } as const };
				}
				const initializedState: Extract<TransientTaskResultPublicationPrePendingStateV1, { state: "ready" }> =
					prior.state === "ready"
						? prior
						: {
								state: "ready",
								plan: prior.plan,
								initializationReceipt: prior.initializationReceipt,
							};
				return { state, result: { status: "already_initialized", state: initializedState } as const };
			}
			return {
				state: { ...state, publications: { ...state.publications, [publicationMapKey(key)]: ready } },
				result: { status: "initialized", state: ready } as const,
			};
		});
	}

	async acknowledgeCancellation(
		request: Parameters<TransientTaskResultPublicationStoreV1["acknowledgeCancellation"]>[0],
	) {
		const key = request.core.resultTargetKey;
		if (
			!strictRecord(request, [
				"core",
				"expectedInitializationReceiptSha256",
				"expectedAuthorityRevision",
				"fencingGeneration",
				"controller",
				"requestedAt",
				"requestSha256",
			]) ||
			!strictRecord(request.core, [
				"schemaVersion",
				"resultTargetKey",
				"planSha256",
				"kind",
				"message",
				"coreSha256",
			]) ||
			!validResultTargetKey(key) ||
			!validResultTargetControllerProof(request.controller) ||
			!validResultStoreSha256Ref(request.core.planSha256) ||
			!validResultStoreSha256Ref(request.expectedInitializationReceiptSha256) ||
			!validResultStoreInteger(request.expectedAuthorityRevision) ||
			!validResultStoreInteger(request.fencingGeneration) ||
			!validResultStoreIso8601(request.requestedAt)
		)
			return { status: "invalid" } as const;
		const expectedCoreSha256 = await tupleRef([
			"omp-transient-task-result-publication-v1",
			"cancellation-acknowledgement-core",
			1,
			resultTargetKeyTuple(key),
			request.core.planSha256,
			"detached_pre_execution_abort",
			"Aborted before execution",
		]);
		if (expectedCoreSha256 !== request.core.coreSha256) return { status: "invalid" } as const;
		const expectedRequestSha256 = await canonicalRuntimeSha256([
			"omp-transient-task-result-publication-v1",
			"cancellation-acknowledgement-request",
			1,
			[
				"omp-transient-task-result-publication-v1",
				"cancellation-acknowledgement-core",
				1,
				resultTargetKeyTuple(key),
				request.core.planSha256,
				request.core.kind,
				request.core.message,
			],
			request.expectedInitializationReceiptSha256,
			request.expectedAuthorityRevision,
			request.fencingGeneration,
			controllerProofTuple(request.controller),
			request.requestedAt,
		]);
		if (expectedRequestSha256 !== request.requestSha256) return { status: "invalid" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const currentState = transientRuntimeState(
			taskKey,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
		);
		if (currentState.authority?.revision !== request.expectedAuthorityRevision)
			return { status: "revision_conflict" } as const;
		if (
			!publicationControllerLifecycleMatches(
				currentState,
				key,
				request.controller,
				request.expectedAuthorityRevision,
				request.fencingGeneration,
			) ||
			(await this.#authority.authorizeController(request.controller)) !== "current"
		)
			return { status: "controller_lost" } as const;
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			if (state.authority?.revision !== request.expectedAuthorityRevision)
				return { state, result: { status: "revision_conflict" } as const };
			if (
				!publicationControllerLifecycleMatches(
					state,
					key,
					request.controller,
					request.expectedAuthorityRevision,
					request.fencingGeneration,
				)
			)
				return { state, result: { status: "controller_lost" } as const };
			let prior: TransientTaskResultPublicationStateV1 | null;
			try {
				prior = await publicationState(state.publications[publicationMapKey(key)]);
			} catch {
				return { state, result: { status: "invalid" } as const };
			}
			if (!prior) return { state, result: { status: "initialization_missing" } as const };
			if (
				prior.state === "pending" ||
				prior.state === "publication_outcome_unknown" ||
				prior.state === "published"
			) {
				return { state, result: { status: "pending_already_exists" } as const };
			}
			if (
				prior.plan.planSha256 !== request.core.planSha256 ||
				prior.initializationReceipt.receiptSha256 !== request.expectedInitializationReceiptSha256
			) {
				return { state, result: { status: "acknowledgement_conflict" } as const };
			}
			if (prior.state === "cancellation_acknowledged")
				return prior.cancellationAcknowledgementReceipt.requestSha256 === request.requestSha256
					? { state, result: { status: "already_acknowledged", state: prior } as const }
					: { state, result: { status: "acknowledgement_conflict" } as const };
			const receipt: TransientTaskCancellationAcknowledgementReceiptV1 = {
				core: request.core,
				initializationReceiptSha256: prior.initializationReceipt.receiptSha256,
				requestSha256: request.requestSha256,
				acknowledgedAt: request.requestedAt,
				receiptSha256: await tupleRef([
					"omp-transient-task-result-publication-v1",
					"cancellation-acknowledgement-receipt",
					1,
					[
						"omp-transient-task-result-publication-v1",
						"cancellation-acknowledgement-core",
						1,
						resultTargetKeyTuple(key),
						request.core.planSha256,
						request.core.kind,
						request.core.message,
					],
					prior.initializationReceipt.receiptSha256,
					request.requestSha256,
					request.requestedAt,
				]),
			};
			const next: Extract<TransientTaskResultPublicationPrePendingStateV1, { state: "cancellation_acknowledged" }> =
				{
					state: "cancellation_acknowledged",
					plan: prior.plan,
					initializationReceipt: prior.initializationReceipt,
					cancellationAcknowledgementReceipt: receipt,
				};
			return {
				state: { ...state, publications: { ...state.publications, [publicationMapKey(key)]: next } },
				result: { status: "acknowledged", state: next } as const,
			};
		});
	}

	async inspectPrePending(request: Parameters<TransientTaskResultPublicationStoreV1["inspectPrePending"]>[0]) {
		const key = request.resultTargetKey;
		const requestValid =
			strictRecord(request, ["resultTargetKey", "expectedPlanSha256", "inspectedAt", "requestSha256"]) &&
			validResultTargetKey(key) &&
			validResultStoreSha256Ref(request.expectedPlanSha256) &&
			validResultStoreIso8601(request.inspectedAt) &&
			validResultStoreSha256Hex(request.requestSha256);
		const expectedRequestSha256 = requestValid
			? await canonicalRuntimeSha256([
					"omp-transient-task-result-publication-v1",
					"pre-pending-inspect",
					1,
					resultTargetKeyTuple(key),
					request.expectedPlanSha256,
					request.inspectedAt,
				])
			: null;
		if (!requestValid || expectedRequestSha256 !== request.requestSha256) {
			return {
				state: "invalid",
				inspectionSha256: await tupleRef([
					"omp-transient-task-result-publication-v1",
					"pre-pending-inspection",
					1,
					"invalid",
					null,
					null,
					null,
				]),
			} as const;
		}
		const taskKey = { taskId: key.taskId, runId: key.runId };
		let state: TransientTaskRuntimeStateV1;
		try {
			state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
		} catch {
			return {
				state: "invalid",
				inspectionSha256: await tupleRef([
					"omp-transient-task-result-publication-v1",
					"pre-pending-inspection",
					1,
					"invalid",
					null,
					null,
					null,
				]),
			} as const;
		}
		if (!resultTargetLifecycleKeyMatches(state, key)) {
			return {
				state: "conflict",
				inspectionSha256: await tupleRef([
					"omp-transient-task-result-publication-v1",
					"pre-pending-inspection",
					1,
					"conflict",
					null,
					null,
					null,
				]),
			} as const;
		}
		let prior: TransientTaskResultPublicationStateV1 | null;
		try {
			prior = await publicationState(state.publications[publicationMapKey(key)]);
		} catch {
			return {
				state: "invalid",
				inspectionSha256: await tupleRef([
					"omp-transient-task-result-publication-v1",
					"pre-pending-inspection",
					1,
					"invalid",
					null,
					null,
					null,
				]),
			} as const;
		}
		if (!prior) {
			return {
				state: "absent",
				initializationReceiptSha256: null,
				cancellationAcknowledgementReceiptSha256: null,
				pendingReceiptSha256: null,
				inspectionSha256: await tupleRef([
					"omp-transient-task-result-publication-v1",
					"pre-pending-inspection",
					1,
					"absent",
					null,
					null,
					null,
				]),
			} as const;
		}
		if (prior.state === "ready") {
			if (prior.plan.planSha256 !== request.expectedPlanSha256) {
				return {
					state: "conflict",
					inspectionSha256: await tupleRef([
						"omp-transient-task-result-publication-v1",
						"pre-pending-inspection",
						1,
						"conflict",
						null,
						null,
						null,
					]),
				} as const;
			}
			const initializationReceiptSha256 = prior.initializationReceipt.receiptSha256;
			return {
				state: "ready",
				initializationReceiptSha256,
				cancellationAcknowledgementReceiptSha256: null,
				pendingReceiptSha256: null,
				inspectionSha256: await tupleRef([
					"omp-transient-task-result-publication-v1",
					"pre-pending-inspection",
					1,
					"ready",
					initializationReceiptSha256,
					null,
					null,
				]),
			} as const;
		}
		if (prior.state === "cancellation_acknowledged") {
			if (prior.plan.planSha256 !== request.expectedPlanSha256) {
				return {
					state: "conflict",
					inspectionSha256: await tupleRef([
						"omp-transient-task-result-publication-v1",
						"pre-pending-inspection",
						1,
						"conflict",
						null,
						null,
						null,
					]),
				} as const;
			}
			const initializationReceiptSha256 = prior.initializationReceipt.receiptSha256;
			const cancellationAcknowledgementReceiptSha256 = prior.cancellationAcknowledgementReceipt.receiptSha256;
			return {
				state: "cancellation_acknowledged",
				initializationReceiptSha256,
				cancellationAcknowledgementReceiptSha256,
				pendingReceiptSha256: null,
				inspectionSha256: await tupleRef([
					"omp-transient-task-result-publication-v1",
					"pre-pending-inspection",
					1,
					"cancellation_acknowledged",
					initializationReceiptSha256,
					cancellationAcknowledgementReceiptSha256,
					null,
				]),
			} as const;
		}
		const initializationReceiptSha256 =
			prior.state === "pending"
				? prior.initializationReceipt.receiptSha256
				: prior.state === "publication_outcome_unknown"
					? prior.receipt.initializationReceiptSha256
					: prior.pendingReceipt.initializationReceiptSha256;
		const cancellationAcknowledgementReceiptSha256 =
			prior.state === "pending" && prior.childOutcome === "cancelled"
				? prior.predecessorReceipt.receiptSha256
				: null;
		const pendingReceiptSha256 =
			prior.state === "pending"
				? prior.receipt.receiptSha256
				: prior.state === "publication_outcome_unknown"
					? prior.receipt.receiptSha256
					: prior.pendingReceipt.receiptSha256;
		return {
			state: "pending",
			initializationReceiptSha256,
			cancellationAcknowledgementReceiptSha256,
			pendingReceiptSha256,
			inspectionSha256: await tupleRef([
				"omp-transient-task-result-publication-v1",
				"pre-pending-inspection",
				1,
				"pending",
				initializationReceiptSha256,
				cancellationAcknowledgementReceiptSha256,
				pendingReceiptSha256,
			]),
		} as const;
	}

	async adoptPrePending(request: Parameters<TransientTaskResultPublicationStoreV1["adoptPrePending"]>[0]) {
		const key = request.inspectRequest.resultTargetKey;
		if (
			!validResultTargetKey(key) ||
			!validResultTargetControllerProof(request.controller) ||
			request.controller.taskId !== key.taskId ||
			request.controller.runId !== key.runId ||
			request.controller.createId !== key.createId ||
			!validResultStoreIso8601(request.inspectRequest.inspectedAt) ||
			!validResultStoreIso8601(request.adoptedAt) ||
			!validResultStoreSha256Ref(request.inspectRequest.expectedPlanSha256) ||
			!validResultStoreSha256Hex(request.inspectRequest.requestSha256) ||
			!validResultStoreSha256Ref(request.expectedInspectionSha256) ||
			!validResultStoreSha256Hex(request.requestSha256)
		)
			return { status: "invalid" } as const;
		const inspectRequestTuple = [
			"omp-transient-task-result-publication-v1",
			"pre-pending-inspect",
			1,
			resultTargetKeyTuple(request.inspectRequest.resultTargetKey),
			request.inspectRequest.expectedPlanSha256,
			request.inspectRequest.inspectedAt,
		] as const;
		if ((await canonicalRuntimeSha256(inspectRequestTuple)) !== request.inspectRequest.requestSha256)
			return { status: "invalid" } as const;
		const inspectionTuple = [
			"omp-transient-task-result-publication-v1",
			"pre-pending-inspection",
			1,
			request.inspection.state,
			request.inspection.initializationReceiptSha256,
			request.inspection.cancellationAcknowledgementReceiptSha256,
			request.inspection.pendingReceiptSha256,
		] as const;
		const inspectionSha256 = await tupleRef(inspectionTuple);
		if (
			request.inspection.inspectionSha256 !== inspectionSha256 ||
			inspectionSha256 !== request.expectedInspectionSha256
		) {
			return { status: "inspection_stale" } as const;
		}
		const expectedAdoptRequestSha256 = await canonicalRuntimeSha256([
			"omp-transient-task-result-publication-v1",
			"pre-pending-adopt",
			1,
			inspectRequestTuple,
			inspectionTuple,
			request.expectedInspectionSha256,
			controllerProofTuple(request.controller),
			request.adoptedAt,
		]);
		if (expectedAdoptRequestSha256 !== request.requestSha256) return { status: "invalid" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const state = transientRuntimeState(
			taskKey,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
		);
		if (
			!publicationControllerLifecycleMatches(state, key, request.controller) ||
			(await this.#authority.authorizeController(request.controller)) !== "current"
		)
			return { status: "controller_lost" } as const;
		let prior: TransientTaskResultPublicationStateV1 | null;
		try {
			prior = await publicationState(state.publications[publicationMapKey(key)]);
		} catch {
			return { status: "invalid" } as const;
		}
		if (!prior) return { status: "absent" } as const;
		if (prior.state === "publication_outcome_unknown" || prior.state === "published")
			return { status: "pending" } as const;
		if (prior.state === "ready") {
			return request.inspection.state === "ready" &&
				prior.plan.planSha256 === request.inspectRequest.expectedPlanSha256 &&
				prior.initializationReceipt.receiptSha256 === request.inspection.initializationReceiptSha256
				? ({ status: "adopted", state: prior } as const)
				: ({ status: "conflict" } as const);
		}
		if (prior.state === "cancellation_acknowledged") {
			return request.inspection.state === "cancellation_acknowledged" &&
				prior.plan.planSha256 === request.inspectRequest.expectedPlanSha256 &&
				prior.initializationReceipt.receiptSha256 === request.inspection.initializationReceiptSha256 &&
				prior.cancellationAcknowledgementReceipt.receiptSha256 ===
					request.inspection.cancellationAcknowledgementReceiptSha256
				? ({ status: "adopted", state: prior } as const)
				: ({ status: "conflict" } as const);
		}
		return request.inspection.state === "pending" &&
			prior.receipt.receiptSha256 === request.inspection.pendingReceiptSha256 &&
			prior.initializationReceipt.receiptSha256 === request.inspection.initializationReceiptSha256
			? ({ status: "adopted", state: prior } as const)
			: ({ status: "conflict" } as const);
	}

	async putPending(request: Parameters<TransientTaskResultPublicationStoreV1["putPending"]>[0]) {
		const key = request.pending;
		if (
			!(await validPendingOutcome(request.pending)) ||
			!validResultTargetControllerProof(request.controller) ||
			!validResultStoreInteger(request.expectedAuthorityRevision) ||
			!validResultStoreInteger(request.fencingGeneration) ||
			!validResultStoreSha256Hex(request.requestSha256)
		)
			return { status: "invalid" } as const;
		const payloadValidation = await validatePendingPayloadIdentity(request.pending);
		if (payloadValidation.status !== "matching") return { status: "payload_conflict" } as const;
		const predecessor = request.predecessorReceipt;
		let predecessorTuple: readonly CanonicalRuntimeValue[];
		if (request.pending.outcome === "cancelled") {
			if (!isCancellationPredecessor(predecessor) || !(await validCancellationReceipt(predecessor, key)))
				return { status: "invalid" } as const;
			predecessorTuple = cancellationReceiptTuple(predecessor);
		} else {
			if (isCancellationPredecessor(predecessor) || !(await validInitializationReceipt(predecessor, key)))
				return { status: "invalid" } as const;
			predecessorTuple = prePendingInitializationReceiptTuple(predecessor);
		}
		const expectedRequestSha256 = await canonicalRuntimeSha256([
			"omp-transient-task-pending-outcome-v1",
			"put-request",
			1,
			pendingOutcomeTuple(request.pending),
			predecessorTuple,
			request.expectedAuthorityRevision,
			request.fencingGeneration,
			controllerProofTuple(request.controller),
		]);
		if (expectedRequestSha256 !== request.requestSha256) return { status: "invalid" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const currentState = transientRuntimeState(
			taskKey,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
		);
		if (currentState.authority?.revision !== request.expectedAuthorityRevision)
			return { status: "revision_conflict" } as const;
		if (currentState.authority === null) return { status: "controller_lost" } as const;
		if (
			currentState.authority.state === "cleanup" ||
			currentState.authority.state === "deleted" ||
			currentState.authority.state === "discarded"
		)
			return { status: "cleanup_latched" } as const;
		if (
			!publicationControllerLifecycleMatches(
				currentState,
				key,
				request.controller,
				request.expectedAuthorityRevision,
				request.fencingGeneration,
			)
		)
			return { status: "controller_lost" } as const;
		const authorization = await this.#authority.authorizeController(request.controller);
		if (authorization !== "current") return { status: authorization } as const;
		const mapKey = publicationMapKey(key);
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			if (state.authority?.revision !== request.expectedAuthorityRevision)
				return { state, result: { status: "revision_conflict" } as const };
			if (state.authority === null) return { state, result: { status: "controller_lost" } as const };
			if (
				state.authority.state === "cleanup" ||
				state.authority.state === "deleted" ||
				state.authority.state === "discarded"
			)
				return { state, result: { status: "cleanup_latched" } as const };
			if (
				!publicationControllerLifecycleMatches(
					state,
					key,
					request.controller,
					request.expectedAuthorityRevision,
					request.fencingGeneration,
				)
			)
				return { state, result: { status: "controller_lost" } as const };
			let prior: TransientTaskResultPublicationStateV1 | null;
			try {
				prior = await publicationState(state.publications[mapKey]);
			} catch (error) {
				return {
					state,
					result:
						error instanceof PublicationPayloadIdentityMismatchError
							? ({ status: "payload_conflict" } as const)
							: ({ status: "invalid" } as const),
				};
			}
			if (!prior) return { state, result: { status: "invalid" } as const };
			if (prior.state === "pending")
				return prior.receipt.requestSha256 === request.requestSha256
					? { state, result: { status: "already_recorded", state: prior } as const }
					: { state, result: { status: "same_id_different_outcome" } as const };
			if (prior.state === "publication_outcome_unknown" || prior.state === "published")
				return { state, result: { status: "same_id_different_outcome" } as const };
			if (request.pending.outcome === "cancelled") {
				if (
					!isCancellationPredecessor(predecessor) ||
					prior.state !== "cancellation_acknowledged" ||
					predecessor.initializationReceiptSha256 !== prior.initializationReceipt.receiptSha256 ||
					predecessor.receiptSha256 !== prior.cancellationAcknowledgementReceipt.receiptSha256
				)
					return { state, result: { status: "invalid" } as const };
			} else if (
				isCancellationPredecessor(predecessor) ||
				prior.state !== "ready" ||
				!exactJson(predecessor, prior.initializationReceipt)
			) {
				return { state, result: { status: "invalid" } as const };
			}
			const payloadPutReceiptSha256 = request.pending.payloadPutReceipt?.receiptSha256 ?? null;
			const receipt: TransientTaskPendingOutcomeReceiptV1 = {
				schemaVersion: 1,
				taskId: key.taskId,
				runId: key.runId,
				state: "pending",
				createId: key.createId,
				resultPublicationId: key.resultPublicationId,
				resultPublicationTargetId: key.resultPublicationTargetId,
				resultPublicationTargetCleanupId: key.resultPublicationTargetCleanupId,
				pendingPayloadId: key.pendingPayloadId,
				pendingPayloadDeleteId: key.pendingPayloadDeleteId,
				outcome: key.outcome,
				outcomeSha256: key.outcomeSha256,
				initializationReceiptSha256: prior.initializationReceipt.receiptSha256,
				predecessorReceiptSha256: predecessor.receiptSha256,
				cancellationAcknowledgementReceiptSha256: key.cancellationAcknowledgementReceiptSha256,
				payloadSha256:
					key.payload.storage === "inline_base64"
						? key.payload.payloadSha256
						: key.payload.payloadRef.payloadSha256,
				payloadPutReceiptSha256,
				requestSha256: request.requestSha256,
				recordedAt: this.#now(),
				receiptSha256: "sha256:" as Sha256Ref,
			};
			const finalReceipt: TransientTaskPendingOutcomeReceiptV1 = {
				...receipt,
				receiptSha256: await tupleRef([
					"omp-transient-task-pending-outcome-v1",
					"receipt",
					1,
					key.taskId,
					key.runId,
					"pending",
					key.createId,
					key.resultPublicationId,
					key.resultPublicationTargetId,
					key.resultPublicationTargetCleanupId,
					key.pendingPayloadId,
					key.pendingPayloadDeleteId,
					key.outcome,
					key.outcomeSha256,
					prior.initializationReceipt.receiptSha256,
					predecessor.receiptSha256,
					key.cancellationAcknowledgementReceiptSha256,
					receipt.payloadSha256,
					payloadPutReceiptSha256,
					request.requestSha256,
					receipt.recordedAt,
				]),
			};
			let next: Extract<TransientTaskResultPublicationStateV1, { state: "pending" }>;
			if (request.pending.outcome === "cancelled") {
				if (!isCancellationPredecessor(predecessor)) return { state, result: { status: "invalid" } as const };
				next = {
					state: "pending",
					childOutcome: "cancelled",
					publishedTerminalOutcome: null,
					singleResultCompositionDiagnostic: null,
					initializationReceipt: prior.initializationReceipt,
					predecessorReceipt: predecessor,
					pending: request.pending,
					receipt: finalReceipt,
				};
			} else {
				next = {
					state: "pending",
					childOutcome: request.pending.outcome,
					publishedTerminalOutcome: null,
					singleResultCompositionDiagnostic: null,
					initializationReceipt: prior.initializationReceipt,
					predecessorReceipt: prior.initializationReceipt,
					pending: request.pending,
					receipt: finalReceipt,
				};
			}
			return {
				state: { ...state, publications: { ...state.publications, [mapKey]: next } },
				result: { status: "recorded", state: next } as const,
			};
		});
	}

	async publish(request: Parameters<TransientTaskResultPublicationStoreV1["publish"]>[0]) {
		if (!validPublicationRequestShape(request)) return { status: "invalid" } as const;
		const key = resultTargetKeyFromRecord(request as unknown as Record<string, unknown>);
		if (!key) return { status: "invalid" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const initialState = transientRuntimeState(
			taskKey,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
		);
		if (!publicationTerminalLifecycleMatches(initialState, key, request.terminalEvidence))
			return { status: "post_terminal_cleanup_evidence_conflict" } as const;
		if (
			!(await this.#authority.authorizeTerminal({
				key,
				terminalEvidenceId: request.terminalEvidence.evidenceId,
				terminalEvidenceSha256: request.terminalEvidence.evidenceSha256,
			}))
		)
			return { status: "post_terminal_cleanup_evidence_conflict" } as const;
		if (!(await validParentDeliveryRequest(request.parentDeliveryRequest, key)))
			return publicationPayloadMismatch("parent_delivery_tuple_mismatch");
		let target: PrivateResultTargetRowV1 | null;
		try {
			target = await resultTargetRow(initialState.resultTargets[resultTargetMapKey(key)]);
		} catch {
			return { status: "invalid" } as const;
		}
		if (!target?.binding) return { status: "target_missing" } as const;
		let lifecycleMatches = false;
		try {
			lifecycleMatches = await publicationRequestMatchesCurrentLifecycle(initialState, request, this.#now());
		} catch {
			return { status: "invalid" } as const;
		}
		if (!lifecycleMatches) return { status: "target_conflict" } as const;
		const current = initialState.authority;
		if (!current) return { status: "post_terminal_cleanup_evidence_conflict" } as const;
		const expectedPayloadId =
			request.childOutcome === "succeeded" ? current.composedPayloadId : current.pendingPayloadId;
		const expectedPayloadDeleteId =
			request.childOutcome === "succeeded" ? current.composedPayloadDeleteId : current.pendingPayloadDeleteId;
		if (
			request.deliveryPayloadId !== expectedPayloadId ||
			request.deliveryPayloadDeleteId !== expectedPayloadDeleteId
		)
			return publicationPayloadMismatch("payload_id_mismatch");
		if (
			request.childOutcome === "succeeded" &&
			request.singleResultComposition?.resultCompositionId !== current.resultCompositionId
		)
			return { status: "invalid" } as const;
		const mapKey = publicationMapKey(key);
		const prepared = await this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			if (!publicationTerminalLifecycleMatches(state, key, request.terminalEvidence))
				return { state, result: { status: "post_terminal_cleanup_evidence_conflict" } as const };
			let currentMatches = false;
			try {
				currentMatches = await publicationRequestMatchesCurrentLifecycle(state, request, this.#now());
			} catch {
				return { state, result: { status: "invalid" } as const };
			}
			if (!currentMatches) return { state, result: { status: "target_conflict" } as const };
			const currentAuthority = state.authority;
			if (!currentAuthority)
				return { state, result: { status: "post_terminal_cleanup_evidence_conflict" } as const };
			const expectedPayloadId =
				request.childOutcome === "succeeded"
					? currentAuthority.composedPayloadId
					: currentAuthority.pendingPayloadId;
			const expectedPayloadDeleteId =
				request.childOutcome === "succeeded"
					? currentAuthority.composedPayloadDeleteId
					: currentAuthority.pendingPayloadDeleteId;
			if (
				request.deliveryPayloadId !== expectedPayloadId ||
				request.deliveryPayloadDeleteId !== expectedPayloadDeleteId
			)
				return { state, result: publicationPayloadMismatch("payload_id_mismatch") };
			let prior: TransientTaskResultPublicationStateV1 | null;
			try {
				prior = await publicationState(state.publications[mapKey]);
			} catch (error) {
				return {
					state,
					result:
						error instanceof PublicationPayloadIdentityMismatchError
							? error.mismatch
							: ({ status: "invalid" } as const),
				};
			}
			if (!prior) return { state, result: { status: "missing_pending_outcome" } as const };
			if (prior.state === "published") {
				const receipt = prior.publicationReceipt;
				const matching =
					receipt.childOutcome === request.childOutcome &&
					receipt.publishedTerminalOutcome === request.publishedTerminalOutcome &&
					receipt.outcomeSha256 === request.pendingOutcomeSha256 &&
					receipt.deliveryPayloadRole === request.deliveryPayloadRole &&
					receipt.deliveryPayloadId === request.deliveryPayloadId &&
					receipt.deliveryPayloadDeleteId === request.deliveryPayloadDeleteId &&
					receipt.deliveryPayloadPutReceiptSha256 === request.deliveryPayloadPutReceiptSha256 &&
					receipt.deliveryPayloadSha256 === request.deliveryPayloadSha256 &&
					receipt.deliveryPayloadByteLength === request.deliveryPayloadByteLength &&
					receipt.deliveryPayloadEnvelopeSha256 === request.deliveryPayloadEnvelopeSha256 &&
					receipt.deliveryPayloadTupleSha256 === request.deliveryPayloadTupleSha256 &&
					receipt.terminalEvidenceId === request.terminalEvidence.evidenceId &&
					receipt.terminalEvidenceSha256 === request.terminalEvidence.evidenceSha256 &&
					parentDeliveryReceiptMatchesPublicationRequest(receipt.parentDelivery, request);
				return matching
					? { state, result: { status: "already_published", receipt } as const }
					: { state, result: { status: "delivery_conflict" } as const };
			}
			if (prior.state === "publication_outcome_unknown") {
				const payload = await validatePublicationPayloadIdentity(
					prior.pending,
					prior.parentDeliveryRequest,
					request,
					null,
				);
				if (payload.status !== "matching") return { state, result: payload };
				return prior.publicationRequestSha256 === request.publicationRequestSha256 &&
					exactJson(prior.parentDeliveryRequest, request.parentDeliveryRequest) &&
					prior.parentDeliveryAttemptSha256 === request.parentDeliveryAttemptSha256
					? { state, result: { status: "publication_outcome_unknown" } as const }
					: { state, result: { status: "delivery_conflict" } as const };
			}
			if (
				prior.state !== "pending" ||
				prior.receipt.outcomeSha256 !== request.pendingOutcomeSha256 ||
				prior.childOutcome !== request.childOutcome
			)
				return { state, result: { status: "outcome_conflict" } as const };
			const payload = await validatePublicationPayloadIdentity(
				prior.pending,
				request.parentDeliveryRequest,
				request,
				null,
			);
			if (payload.status !== "matching") return { state, result: payload };
			const next: Extract<TransientTaskResultPublicationStateV1, { state: "publication_outcome_unknown" }> = {
				state: "publication_outcome_unknown",
				childOutcome: request.childOutcome,
				publishedTerminalOutcome: request.publishedTerminalOutcome,
				pending: prior.pending,
				receipt: prior.receipt,
				createId: request.createId,
				resultPublicationTargetId: request.resultPublicationTargetId,
				resultPublicationTargetCleanupId: request.resultPublicationTargetCleanupId,
				targetBindingRevision: request.targetBindingRevision,
				targetRenewalSequence: request.targetRenewalSequence,
				targetLiveReceiptSha256: request.targetLiveReceiptSha256,
				deliveryPayloadRole: request.deliveryPayloadRole,
				deliveryPayloadId: request.deliveryPayloadId,
				deliveryPayloadDeleteId: request.deliveryPayloadDeleteId,
				deliveryPayloadPutReceiptSha256: request.deliveryPayloadPutReceiptSha256,
				deliveryPayload: request.deliveryPayload,
				deliveryPayloadSha256: request.deliveryPayloadSha256,
				deliveryPayloadByteLength: request.deliveryPayloadByteLength,
				deliveryPayloadEnvelopeSha256: request.deliveryPayloadEnvelopeSha256,
				deliveryPayloadTupleSha256: request.deliveryPayloadTupleSha256,
				sinkResultUtf8Sha256: request.parentDeliveryRequest.sinkResultUtf8Sha256,
				sinkResultUtf8ByteLength: request.parentDeliveryRequest.sinkResultUtf8ByteLength,
				singleResultComposition: request.singleResultComposition,
				singleResultCompositionDiagnostic: request.singleResultCompositionDiagnostic,
				terminalEvidenceId: request.terminalEvidence.evidenceId,
				terminalEvidenceSha256: request.terminalEvidence.evidenceSha256,
				parentDeliveryRequest: request.parentDeliveryRequest,
				parentDeliveryAttemptSha256: request.parentDeliveryAttemptSha256,
				publicationRequestSha256: request.publicationRequestSha256,
				openedAt: this.#now(),
			};
			return { state: { ...state, publications: { ...state.publications, [mapKey]: next } }, result: null };
		});
		if (prepared) return prepared;
		const dispatchState = transientRuntimeState(
			taskKey,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
		);
		let dispatchCurrent = false;
		try {
			dispatchCurrent = await publicationRequestMatchesCurrentLifecycle(dispatchState, request, this.#now());
		} catch {
			return { status: "invalid" } as const;
		}
		if (
			!dispatchCurrent ||
			!(await this.#authority.authorizeTerminal({
				key,
				terminalEvidenceId: request.terminalEvidence.evidenceId,
				terminalEvidenceSha256: request.terminalEvidence.evidenceSha256,
			}))
		)
			return { status: "delivery_authority_lost" } as const;
		let dispatchAttempt: TransientTaskResultPublicationStateV1 | null;
		try {
			dispatchAttempt = await publicationState(dispatchState.publications[mapKey]);
		} catch (error) {
			return error instanceof PublicationPayloadIdentityMismatchError
				? error.mismatch
				: ({ status: "invalid" } as const);
		}
		if (
			dispatchAttempt?.state !== "publication_outcome_unknown" ||
			dispatchAttempt.publicationRequestSha256 !== request.publicationRequestSha256 ||
			dispatchAttempt.parentDeliveryAttemptSha256 !== request.parentDeliveryAttemptSha256 ||
			!exactJson(dispatchAttempt.parentDeliveryRequest, request.parentDeliveryRequest)
		)
			return { status: "delivery_conflict" } as const;
		const dispatchPayload = await validatePublicationPayloadIdentity(
			dispatchAttempt.pending,
			dispatchAttempt.parentDeliveryRequest,
			request,
			null,
		);
		if (dispatchPayload.status !== "matching") return dispatchPayload;
		const delivery = await this.#delivery.deliver(request.parentDeliveryRequest, request.parentDeliveryAttemptSha256);
		if (delivery.status === "delivery_outcome_unknown") return { status: "publication_outcome_unknown" } as const;
		if (
			delivery.status !== "delivered" &&
			delivery.status !== "already_delivered" &&
			delivery.status !== "consumed_without_enqueue" &&
			delivery.status !== "already_consumed_without_enqueue"
		) {
			return {
				status: delivery.status === "terminal_non_delivery" ? "delivery_terminal_non_success" : "delivery_conflict",
			} as const;
		}
		const deliveredStatus = delivery.status === "delivered" || delivery.status === "already_delivered";
		if (
			!parentDeliveryReceiptMatchesPublicationRequest(delivery.receipt, request) ||
			(deliveredStatus
				? delivery.receipt.outcome !== "delivered"
				: delivery.receipt.outcome !== "consumed_without_enqueue")
		)
			return { status: "delivery_conflict" } as const;
		const publishedAt = this.#now();
		const receipt: TransientTaskResultPublicationReceiptV1 = {
			schemaVersion: 1,
			taskId: request.taskId,
			runId: request.runId,
			state: "published",
			createId: request.createId,
			resultPublicationId: request.resultPublicationId,
			resultPublicationTargetId: request.resultPublicationTargetId,
			resultPublicationTargetCleanupId: request.resultPublicationTargetCleanupId,
			childOutcome: request.childOutcome,
			publishedTerminalOutcome: request.publishedTerminalOutcome,
			outcomeSha256: request.pendingOutcomeSha256,
			deliveryPayloadRole: request.deliveryPayloadRole,
			deliveryPayloadId: request.deliveryPayloadId,
			deliveryPayloadDeleteId: request.deliveryPayloadDeleteId,
			deliveryPayloadPutReceiptSha256: request.deliveryPayloadPutReceiptSha256,
			deliveryPayloadSha256: request.deliveryPayloadSha256,
			singleResultCompositionReceiptSha256: request.singleResultComposition?.receiptSha256 ?? null,
			singleResultCompositionDiagnostic: request.singleResultCompositionDiagnostic,
			deliveryPayloadByteLength: request.deliveryPayloadByteLength,
			deliveryPayloadEnvelopeSha256: request.deliveryPayloadEnvelopeSha256,
			deliveryPayloadTupleSha256: request.deliveryPayloadTupleSha256,
			sinkResultUtf8Sha256: request.parentDeliveryRequest.sinkResultUtf8Sha256,
			sinkResultUtf8ByteLength: request.parentDeliveryRequest.sinkResultUtf8ByteLength,
			terminalEvidenceId: request.terminalEvidence.evidenceId,
			terminalEvidenceSha256: request.terminalEvidence.evidenceSha256,
			targetBindingRevision: request.targetBindingRevision,
			targetRenewalSequence: request.targetRenewalSequence,
			targetLiveReceiptSha256: request.targetLiveReceiptSha256,
			deliveryOperationId: request.parentDeliveryRequest.deliveryOperationId,
			parentDeliveryAuthoritySha256: request.parentDeliveryRequest.deliveryAuthoritySha256,
			parentDeliveryAttemptSha256: request.parentDeliveryAttemptSha256,
			parentDelivery: delivery.receipt,
			publishedAt,
			receiptSha256: await tupleRef([
				"omp-transient-task-result-publication-v1",
				"receipt",
				1,
				resultTargetKeyTuple(request),
				request.childOutcome,
				request.publishedTerminalOutcome,
				request.pendingOutcomeSha256,
				request.deliveryPayloadRole,
				request.deliveryPayloadId,
				request.deliveryPayloadDeleteId,
				request.deliveryPayloadPutReceiptSha256,
				request.deliveryPayloadEnvelopeSha256,
				request.deliveryPayloadSha256,
				request.deliveryPayloadByteLength,
				request.deliveryPayloadTupleSha256,
				request.singleResultComposition?.receiptSha256 ?? null,
				request.singleResultCompositionDiagnostic === null
					? null
					: JSON.stringify(request.singleResultCompositionDiagnostic),
				request.parentDeliveryRequest.sinkResultUtf8Sha256,
				request.parentDeliveryRequest.sinkResultUtf8ByteLength,
				request.terminalEvidence.evidenceId,
				request.terminalEvidence.evidenceSha256,
				[request.targetBindingRevision, request.targetRenewalSequence, request.targetLiveReceiptSha256],
				request.parentDeliveryRequest.deliveryOperationId,
				request.parentDeliveryRequest.deliveryAuthoritySha256,
				request.parentDeliveryAttemptSha256,
				delivery.receipt.receiptSha256,
				publishedAt,
			]),
		};
		if (!(await validPublicationReceipt(receipt))) return { status: "delivery_conflict" } as const;
		const finalPayload = await validatePublicationPayloadIdentity(
			dispatchAttempt.pending,
			request.parentDeliveryRequest,
			request,
			receipt,
		);
		if (finalPayload.status !== "matching") return finalPayload;
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			if (!publicationTerminalLifecycleMatches(state, key, request.terminalEvidence))
				return { state, result: { status: "delivery_authority_lost" } as const };
			let prior: TransientTaskResultPublicationStateV1 | null;
			try {
				prior = await publicationState(state.publications[mapKey]);
			} catch (error) {
				return {
					state,
					result:
						error instanceof PublicationPayloadIdentityMismatchError
							? error.mismatch
							: ({ status: "delivery_conflict" } as const),
				};
			}
			if (prior?.state === "published")
				return prior.publicationReceipt.receiptSha256 === receipt.receiptSha256
					? { state, result: { status: "already_published", receipt: prior.publicationReceipt } as const }
					: { state, result: { status: "delivery_conflict" } as const };
			if (
				prior?.state !== "publication_outcome_unknown" ||
				prior.publicationRequestSha256 !== request.publicationRequestSha256 ||
				prior.parentDeliveryAttemptSha256 !== request.parentDeliveryAttemptSha256 ||
				!exactJson(prior.parentDeliveryRequest, request.parentDeliveryRequest)
			)
				return { state, result: { status: "delivery_conflict" } as const };
			const payload = await validatePublicationPayloadIdentity(
				prior.pending,
				prior.parentDeliveryRequest,
				request,
				receipt,
			);
			if (payload.status !== "matching") return { state, result: payload };
			const next: Extract<TransientTaskResultPublicationStateV1, { state: "published" }> = {
				state: "published",
				childOutcome: request.childOutcome,
				publishedTerminalOutcome: request.publishedTerminalOutcome,
				singleResultCompositionDiagnostic: request.singleResultCompositionDiagnostic,
				pending: prior.pending,
				pendingReceipt: prior.receipt,
				publicationReceipt: receipt,
			};
			return {
				state: { ...state, publications: { ...state.publications, [mapKey]: next } },
				result: { status: "published", receipt } as const,
			};
		});
	}

	async inspect(request: Parameters<TransientTaskResultPublicationStoreV1["inspect"]>[0]) {
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
				"deliveryOperationId",
				"parentDeliveryAuthoritySha256",
				"parentDeliveryAttemptSha256",
				"sinkResultUtf8Sha256",
				"sinkResultUtf8ByteLength",
				"pendingOutcomeSha256",
				"childOutcome",
				"publishedTerminalOutcome",
				"deliveryPayloadRole",
				"deliveryPayloadId",
				"deliveryPayloadDeleteId",
				"deliveryPayloadPutReceiptSha256",
				"deliveryPayloadSha256",
				"deliveryPayloadByteLength",
				"deliveryPayloadEnvelopeSha256",
				"deliveryPayloadTupleSha256",
				"singleResultCompositionReceiptSha256",
				"singleResultCompositionDiagnostic",
				"terminalEvidenceId",
				"terminalEvidenceSha256",
				"publicationRequestSha256",
			]) ||
			!key ||
			!validResultTargetKey(key) ||
			!validResultStoreInteger(request.targetBindingRevision, 1) ||
			!validResultStoreInteger(request.targetRenewalSequence) ||
			!validResultStoreSha256Ref(request.targetLiveReceiptSha256) ||
			!validResultStoreIdentity(request.deliveryOperationId) ||
			!validResultStoreSha256Ref(request.parentDeliveryAuthoritySha256) ||
			!validResultStoreSha256Ref(request.parentDeliveryAttemptSha256) ||
			!validResultStoreSha256Ref(request.sinkResultUtf8Sha256) ||
			!validResultStoreInteger(request.sinkResultUtf8ByteLength) ||
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
			(request.singleResultCompositionReceiptSha256 !== null &&
				!validResultStoreSha256Ref(request.singleResultCompositionReceiptSha256)) ||
			(request.singleResultCompositionDiagnostic !== null &&
				!validCompositionDiagnostic(request.singleResultCompositionDiagnostic)) ||
			!validResultStoreIdentity(request.terminalEvidenceId) ||
			!validResultStoreSha256Ref(request.terminalEvidenceSha256) ||
			!validResultStoreSha256Hex(request.publicationRequestSha256)
		)
			return { status: "invalid_json" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const state = transientRuntimeState(
			taskKey,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
		);
		if (!resultTargetLifecycleKeyMatches(state, key)) return { status: "target_missing" } as const;
		let prior: TransientTaskResultPublicationStateV1 | null;
		try {
			prior = await publicationState(state.publications[publicationMapKey(key)]);
		} catch (error) {
			return error instanceof PublicationPayloadIdentityMismatchError
				? error.mismatch
				: ({ status: "record_invariant_violation" } as const);
		}
		if (!prior)
			return {
				status: "absent",
				resultPublicationId: request.resultPublicationId,
				resultPublicationTargetId: request.resultPublicationTargetId,
			} as const;
		if (prior.state === "ready" || prior.state === "cancellation_acknowledged")
			return { status: "conflict" } as const;
		const pending = prior.state === "pending" ? prior : null;
		const unknown = prior.state === "publication_outcome_unknown" ? prior : null;
		const published = prior.state === "published" ? prior : null;
		const pendingReceipt = pending?.receipt ?? unknown?.receipt ?? published?.pendingReceipt;
		const pendingValue = pending?.pending ?? unknown?.pending ?? published?.pending;
		if (!pendingReceipt || !pendingValue || pendingReceipt.outcomeSha256 !== request.pendingOutcomeSha256)
			return { status: "conflict" } as const;
		const pendingPayload = await validatePendingPayloadIdentity(pendingValue);
		if (pendingPayload.status !== "matching") return pendingPayload;
		if (unknown) {
			const publicationPayload = await validatePublicationPayloadIdentity(
				unknown.pending,
				unknown.parentDeliveryRequest,
				null,
				null,
			);
			if (publicationPayload.status !== "matching") return publicationPayload;
		}
		const payload = pendingValue.payload;
		const payloadByteLength =
			payload.storage === "inline_base64" ? payload.byteLength : payload.payloadRef.byteLength;
		const payloadSha = payload.storage === "inline_base64" ? payload.payloadSha256 : payload.payloadRef.payloadSha256;
		const payloadEnvelopeSha = await tupleRef(payloadEnvelopeTuple(payload));
		if (pending) {
			const inspectionCore = [
				"omp-transient-task-result-publication-v1",
				"inspection",
				1,
				resultTargetKeyTuple(request),
				[request.targetBindingRevision, request.targetRenewalSequence, request.targetLiveReceiptSha256],
				request.pendingOutcomeSha256,
				pendingReceipt.receiptSha256,
				"pending",
				pending.childOutcome,
				null,
				null,
				"pending",
				pendingValue.pendingPayloadId,
				pendingValue.pendingPayloadDeleteId,
				pendingValue.payloadPutReceipt?.receiptSha256 ?? null,
				payloadEnvelopeSha,
				payloadSha,
				payloadByteLength,
				request.deliveryPayloadTupleSha256,
			] as const;
			return {
				status: "matching",
				inspection: {
					schemaVersion: 1,
					taskId: request.taskId,
					runId: request.runId,
					createId: request.createId,
					resultPublicationId: request.resultPublicationId,
					resultPublicationTargetId: request.resultPublicationTargetId,
					resultPublicationTargetCleanupId: request.resultPublicationTargetCleanupId,
					targetBindingRevision: request.targetBindingRevision,
					targetRenewalSequence: request.targetRenewalSequence,
					targetLiveReceiptSha256: request.targetLiveReceiptSha256,
					pendingOutcomeSha256: request.pendingOutcomeSha256,
					pendingReceiptSha256: pendingReceipt.receiptSha256,
					state: "pending",
					childOutcome: pending.childOutcome,
					publishedTerminalOutcome: null,
					singleResultCompositionDiagnostic: null,
					deliveryPayloadRole: "pending",
					pendingPayloadId: pendingValue.pendingPayloadId,
					pendingPayloadDeleteId: pendingValue.pendingPayloadDeleteId,
					pendingPayloadPutReceiptSha256: pendingValue.payloadPutReceipt?.receiptSha256 ?? null,
					pendingPayloadSha256: payloadSha,
					pendingPayloadByteLength: payloadByteLength,
					pendingPayloadEnvelopeSha256: payloadEnvelopeSha,
					pendingPayloadTupleSha256: request.deliveryPayloadTupleSha256,
					inspectionSha256: await tupleRef(inspectionCore),
				},
			} as const;
		}
		if (unknown) {
			if (
				unknown.targetBindingRevision !== request.targetBindingRevision ||
				unknown.targetRenewalSequence !== request.targetRenewalSequence ||
				unknown.targetLiveReceiptSha256 !== request.targetLiveReceiptSha256 ||
				unknown.childOutcome !== request.childOutcome ||
				unknown.publishedTerminalOutcome !== request.publishedTerminalOutcome ||
				!exactJson(unknown.singleResultCompositionDiagnostic, request.singleResultCompositionDiagnostic) ||
				unknown.deliveryPayloadRole !== request.deliveryPayloadRole ||
				unknown.deliveryPayloadId !== request.deliveryPayloadId ||
				unknown.deliveryPayloadDeleteId !== request.deliveryPayloadDeleteId ||
				unknown.deliveryPayloadPutReceiptSha256 !== request.deliveryPayloadPutReceiptSha256 ||
				unknown.deliveryPayloadSha256 !== request.deliveryPayloadSha256 ||
				unknown.deliveryPayloadByteLength !== request.deliveryPayloadByteLength ||
				unknown.deliveryPayloadEnvelopeSha256 !== request.deliveryPayloadEnvelopeSha256 ||
				unknown.deliveryPayloadTupleSha256 !== request.deliveryPayloadTupleSha256 ||
				unknown.parentDeliveryRequest.deliveryOperationId !== request.deliveryOperationId ||
				unknown.parentDeliveryRequest.deliveryAuthoritySha256 !== request.parentDeliveryAuthoritySha256 ||
				unknown.parentDeliveryAttemptSha256 !== request.parentDeliveryAttemptSha256 ||
				unknown.sinkResultUtf8Sha256 !== request.sinkResultUtf8Sha256 ||
				unknown.sinkResultUtf8ByteLength !== request.sinkResultUtf8ByteLength ||
				unknown.singleResultComposition?.receiptSha256 !== request.singleResultCompositionReceiptSha256 ||
				unknown.terminalEvidenceId !== request.terminalEvidenceId ||
				unknown.terminalEvidenceSha256 !== request.terminalEvidenceSha256 ||
				unknown.publicationRequestSha256 !== request.publicationRequestSha256
			)
				return { status: "conflict" } as const;
			const inspectionCore = [
				"omp-transient-task-result-publication-v1",
				"inspection",
				1,
				resultTargetKeyTuple(request),
				[request.targetBindingRevision, request.targetRenewalSequence, request.targetLiveReceiptSha256],
				request.pendingOutcomeSha256,
				pendingReceipt.receiptSha256,
				"publication_outcome_unknown",
				request.childOutcome,
				request.publishedTerminalOutcome,
				compositionDiagnosticTuple(request.singleResultCompositionDiagnostic),
				request.deliveryPayloadRole,
				request.deliveryPayloadId,
				request.deliveryPayloadDeleteId,
				request.deliveryPayloadPutReceiptSha256,
				request.deliveryPayloadEnvelopeSha256,
				request.deliveryPayloadSha256,
				request.deliveryPayloadByteLength,
				request.deliveryPayloadTupleSha256,
				request.deliveryOperationId,
				request.parentDeliveryAuthoritySha256,
				request.parentDeliveryAttemptSha256,
				request.sinkResultUtf8Sha256,
				request.sinkResultUtf8ByteLength,
				request.singleResultCompositionReceiptSha256,
				request.terminalEvidenceId,
				request.terminalEvidenceSha256,
				unknown.parentDeliveryRequest.deliveryRequestSha256,
				request.publicationRequestSha256,
				unknown.openedAt,
			] as const;
			return {
				status: "matching",
				inspection: {
					schemaVersion: 1,
					taskId: request.taskId,
					runId: request.runId,
					createId: request.createId,
					resultPublicationId: request.resultPublicationId,
					resultPublicationTargetId: request.resultPublicationTargetId,
					resultPublicationTargetCleanupId: request.resultPublicationTargetCleanupId,
					targetBindingRevision: request.targetBindingRevision,
					targetRenewalSequence: request.targetRenewalSequence,
					targetLiveReceiptSha256: request.targetLiveReceiptSha256,
					pendingOutcomeSha256: request.pendingOutcomeSha256,
					pendingReceiptSha256: pendingReceipt.receiptSha256,
					state: "publication_outcome_unknown",
					childOutcome: request.childOutcome,
					publishedTerminalOutcome: request.publishedTerminalOutcome,
					singleResultCompositionDiagnostic: request.singleResultCompositionDiagnostic,
					deliveryPayloadRole: request.deliveryPayloadRole,
					deliveryPayloadId: request.deliveryPayloadId,
					deliveryPayloadDeleteId: request.deliveryPayloadDeleteId,
					deliveryPayloadPutReceiptSha256: request.deliveryPayloadPutReceiptSha256,
					deliveryPayloadSha256: request.deliveryPayloadSha256,
					deliveryPayloadByteLength: request.deliveryPayloadByteLength,
					deliveryPayloadEnvelopeSha256: request.deliveryPayloadEnvelopeSha256,
					deliveryPayloadTupleSha256: request.deliveryPayloadTupleSha256,
					deliveryOperationId: request.deliveryOperationId,
					parentDeliveryAuthoritySha256: request.parentDeliveryAuthoritySha256,
					parentDeliveryAttemptSha256: request.parentDeliveryAttemptSha256,
					sinkResultUtf8Sha256: request.sinkResultUtf8Sha256,
					sinkResultUtf8ByteLength: request.sinkResultUtf8ByteLength,
					singleResultCompositionReceiptSha256: request.singleResultCompositionReceiptSha256,
					terminalEvidenceId: request.terminalEvidenceId,
					terminalEvidenceSha256: request.terminalEvidenceSha256,
					deliveryRequestSha256: unknown.parentDeliveryRequest.deliveryRequestSha256,
					publicationRequestSha256: request.publicationRequestSha256,
					openedAt: unknown.openedAt,
					inspectionSha256: await tupleRef(inspectionCore),
				},
			} as const;
		}
		if (!published) return { status: "conflict" } as const;
		const receipt = published.publicationReceipt;
		if (
			receipt.childOutcome !== request.childOutcome ||
			receipt.publishedTerminalOutcome !== request.publishedTerminalOutcome ||
			receipt.targetBindingRevision !== request.targetBindingRevision ||
			receipt.targetRenewalSequence !== request.targetRenewalSequence ||
			receipt.targetLiveReceiptSha256 !== request.targetLiveReceiptSha256 ||
			receipt.deliveryPayloadRole !== request.deliveryPayloadRole ||
			receipt.deliveryPayloadId !== request.deliveryPayloadId ||
			receipt.deliveryPayloadDeleteId !== request.deliveryPayloadDeleteId ||
			receipt.deliveryPayloadPutReceiptSha256 !== request.deliveryPayloadPutReceiptSha256 ||
			receipt.deliveryPayloadEnvelopeSha256 !== request.deliveryPayloadEnvelopeSha256 ||
			receipt.deliveryPayloadSha256 !== request.deliveryPayloadSha256 ||
			receipt.deliveryPayloadByteLength !== request.deliveryPayloadByteLength ||
			receipt.deliveryPayloadTupleSha256 !== request.deliveryPayloadTupleSha256 ||
			receipt.deliveryOperationId !== request.deliveryOperationId ||
			receipt.parentDeliveryAuthoritySha256 !== request.parentDeliveryAuthoritySha256 ||
			receipt.parentDeliveryAttemptSha256 !== request.parentDeliveryAttemptSha256 ||
			receipt.sinkResultUtf8Sha256 !== request.sinkResultUtf8Sha256 ||
			receipt.sinkResultUtf8ByteLength !== request.sinkResultUtf8ByteLength ||
			receipt.singleResultCompositionReceiptSha256 !== request.singleResultCompositionReceiptSha256 ||
			!exactJson(receipt.singleResultCompositionDiagnostic, request.singleResultCompositionDiagnostic) ||
			receipt.terminalEvidenceId !== request.terminalEvidenceId ||
			receipt.terminalEvidenceSha256 !== request.terminalEvidenceSha256
		) {
			return { status: "conflict" } as const;
		}
		const inspectionCore = [
			"omp-transient-task-result-publication-v1",
			"inspection",
			1,
			resultTargetKeyTuple(request),
			[request.targetBindingRevision, request.targetRenewalSequence, request.targetLiveReceiptSha256],
			request.pendingOutcomeSha256,
			pendingReceipt.receiptSha256,
			"published",
			request.childOutcome,
			request.publishedTerminalOutcome,
			compositionDiagnosticTuple(request.singleResultCompositionDiagnostic),
			request.deliveryPayloadRole,
			request.deliveryPayloadId,
			request.deliveryPayloadDeleteId,
			request.deliveryPayloadPutReceiptSha256,
			request.deliveryPayloadEnvelopeSha256,
			request.deliveryPayloadSha256,
			request.deliveryPayloadByteLength,
			request.deliveryPayloadTupleSha256,
			request.deliveryOperationId,
			request.parentDeliveryAuthoritySha256,
			request.parentDeliveryAttemptSha256,
			request.sinkResultUtf8Sha256,
			request.sinkResultUtf8ByteLength,
			request.singleResultCompositionReceiptSha256,
			request.terminalEvidenceId,
			request.terminalEvidenceSha256,
			receipt.parentDelivery.receiptSha256,
			receipt.receiptSha256,
			receipt.publishedAt,
		] as const;
		return {
			status: "matching",
			inspection: {
				schemaVersion: 1,
				taskId: request.taskId,
				runId: request.runId,
				createId: request.createId,
				resultPublicationId: request.resultPublicationId,
				resultPublicationTargetId: request.resultPublicationTargetId,
				resultPublicationTargetCleanupId: request.resultPublicationTargetCleanupId,
				targetBindingRevision: request.targetBindingRevision,
				targetRenewalSequence: request.targetRenewalSequence,
				targetLiveReceiptSha256: request.targetLiveReceiptSha256,
				pendingOutcomeSha256: request.pendingOutcomeSha256,
				pendingReceiptSha256: pendingReceipt.receiptSha256,
				state: "published",
				childOutcome: request.childOutcome,
				publishedTerminalOutcome: request.publishedTerminalOutcome,
				singleResultCompositionDiagnostic: request.singleResultCompositionDiagnostic,
				deliveryPayloadRole: request.deliveryPayloadRole,
				deliveryPayloadId: request.deliveryPayloadId,
				deliveryPayloadDeleteId: request.deliveryPayloadDeleteId,
				deliveryPayloadPutReceiptSha256: request.deliveryPayloadPutReceiptSha256,
				deliveryPayloadSha256: request.deliveryPayloadSha256,
				deliveryPayloadByteLength: request.deliveryPayloadByteLength,
				deliveryPayloadEnvelopeSha256: request.deliveryPayloadEnvelopeSha256,
				deliveryPayloadTupleSha256: request.deliveryPayloadTupleSha256,
				deliveryOperationId: request.deliveryOperationId,
				parentDeliveryAuthoritySha256: request.parentDeliveryAuthoritySha256,
				parentDeliveryAttemptSha256: request.parentDeliveryAttemptSha256,
				sinkResultUtf8Sha256: request.sinkResultUtf8Sha256,
				sinkResultUtf8ByteLength: request.sinkResultUtf8ByteLength,
				singleResultCompositionReceiptSha256: request.singleResultCompositionReceiptSha256,
				terminalEvidenceId: request.terminalEvidenceId,
				terminalEvidenceSha256: request.terminalEvidenceSha256,
				parentDeliveryReceiptSha256: receipt.parentDelivery.receiptSha256,
				publicationReceiptSha256: receipt.receiptSha256,
				publishedAt: receipt.publishedAt,
				inspectionSha256: await tupleRef(inspectionCore),
			},
		} as const;
	}

	async resolve(request: Parameters<TransientTaskResultPublicationStoreV1["resolve"]>[0]) {
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
				"deliveryOperationId",
				"parentDeliveryAuthoritySha256",
				"parentDeliveryAttemptSha256",
				"sinkResultUtf8Sha256",
				"sinkResultUtf8ByteLength",
				"pendingOutcomeSha256",
				"childOutcome",
				"publishedTerminalOutcome",
				"deliveryPayloadRole",
				"deliveryPayloadId",
				"deliveryPayloadDeleteId",
				"deliveryPayloadPutReceiptSha256",
				"deliveryPayloadSha256",
				"deliveryPayloadByteLength",
				"deliveryPayloadEnvelopeSha256",
				"deliveryPayloadTupleSha256",
				"singleResultCompositionReceiptSha256",
				"singleResultCompositionDiagnostic",
				"terminalEvidenceId",
				"terminalEvidenceSha256",
				"publicationRequestSha256",
				"expectedInspectionSha256",
				"authority",
			]) ||
			!validResultTargetAuthority(request.authority) ||
			!validResultStoreSha256Ref(request.expectedInspectionSha256)
		)
			return { status: "invalid" } as const;
		const { expectedInspectionSha256: _expectedInspectionSha256, authority: _authority, ...inspectRequest } = request;
		const inspected = await this.inspect(inspectRequest);
		if (inspected.status !== "matching")
			return inspected.status === "absent" || inspected.status === "target_missing"
				? ({ status: "target_missing" } as const)
				: inspected.status === "payload_identity_mismatch"
					? inspected
					: ({ status: "conflict" } as const);
		if (inspected.inspection.inspectionSha256 !== request.expectedInspectionSha256)
			return { status: "inspection_mismatch" } as const;
		const key = resultTargetKeyFromRecord(request as unknown as Record<string, unknown>);
		if (!key) return { status: "invalid" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const authorityState = transientRuntimeState(
			taskKey,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
		);
		if (!resultTargetLifecycleKeyMatches(authorityState, key)) return { status: "stale_target" } as const;
		if (!resultTargetLifecycleMatches(authorityState, key, request.authority))
			return { status: "authority_lost" } as const;
		const authorized =
			request.authority.kind === "controller"
				? (await this.#authority.authorizeController(request.authority.proof)) === "current"
				: request.authority.kind === "cleanup"
					? await this.#authority.authorizeCleanup(request.authority.proof)
					: await this.#authority.authorizeTerminal({
							key,
							terminalEvidenceId: request.authority.terminalEvidenceId,
							terminalEvidenceSha256: request.authority.terminalEvidenceSha256,
						});
		if (!authorized) return { status: "authority_lost" } as const;
		const currentInspection = await this.inspect(inspectRequest);
		if (currentInspection.status !== "matching")
			return currentInspection.status === "payload_identity_mismatch"
				? currentInspection
				: ({ status: "stale_target" } as const);
		if (currentInspection.inspection.inspectionSha256 !== request.expectedInspectionSha256)
			return { status: "inspection_mismatch" } as const;
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			if (!resultTargetLifecycleKeyMatches(state, key))
				return { state, result: { status: "stale_target" } as const };
			if (!resultTargetLifecycleMatches(state, key, request.authority))
				return { state, result: { status: "authority_lost" } as const };
			let prior: TransientTaskResultPublicationStateV1 | null;
			try {
				prior = await publicationState(state.publications[publicationMapKey(key)]);
			} catch (error) {
				return {
					state,
					result:
						error instanceof PublicationPayloadIdentityMismatchError
							? error.mismatch
							: ({ status: "invalid" } as const),
				};
			}
			if (!prior) return { state, result: { status: "target_missing" } as const };
			const pending =
				prior.state === "pending"
					? prior.pending
					: prior.state === "publication_outcome_unknown"
						? prior.pending
						: prior.state === "published"
							? prior.pending
							: null;
			if (!pending) return { state, result: { status: "conflict" } as const };
			const pendingPayload = await validatePendingPayloadIdentity(pending);
			if (pendingPayload.status !== "matching") return { state, result: pendingPayload };
			if (prior.state === "publication_outcome_unknown") {
				const payload = await validatePublicationPayloadIdentity(
					prior.pending,
					prior.parentDeliveryRequest,
					null,
					null,
				);
				if (payload.status !== "matching") return { state, result: payload };
			}
			return { state, result: { status: "resolved", state: prior } as const };
		});
	}
}
