import type { RuntimeDurableStateStoreV1 } from "./managed-workspace.js";
import type { DurableTransientTaskSourceObservationStateV1 } from "./workspace-controller-codecs.js";
import {
	buildSourceObservationRecord,
	decodePendingCaptureRecord,
	decodeSourceObservationAcceptedRow,
	decodeSourceObservationDraft,
	decodeSourceObservationDraftReceipt,
	decodeSourceObservationRecord,
	decodeSourceObservationReservationReceipt,
	decodeSourceObservationReservationRequest,
	decodeSourceObservationState,
	encodeSourceObservationState,
	exactJson,
	isIso8601,
	isSafeCount,
	isSha256Ref,
	isWellFormedString,
	sourceObservationAuthority,
	sourceObservationDigest,
	sourceObservationUndigestedBody,
	strictRecord,
	TRANSIENT_SOURCE_OBSERVATION_NAMESPACE,
	validSourceObservationEventKind,
} from "./workspace-controller-codecs.js";
import type {
	ConfidentialTransientTaskPendingCaptureIndexKeyV1,
	TransientTaskSourceObservationStoreV1,
} from "./workspace-runtime-contracts.js";
import { decodeTransientTaskPendingCaptureIndexKeyV1 } from "./workspace-runtime-contracts.js";

export class DurableTransientTaskSourceObservationStoreV1 implements TransientTaskSourceObservationStoreV1 {
	readonly #durable: RuntimeDurableStateStoreV1;

	constructor(options: { readonly durable: RuntimeDurableStateStoreV1 }) {
		this.#durable = options.durable;
	}

	async inspectObservationState(
		request: Parameters<TransientTaskSourceObservationStoreV1["inspectObservationState"]>[0],
	) {
		try {
			const indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(request.core.indexKey);
			if (
				!strictRecord(request, ["core", "requestSha256"]) ||
				!strictRecord(request.core, ["indexKey", "requestedAt"]) ||
				!isIso8601(request.core.requestedAt) ||
				request.requestSha256 !== sourceObservationDigest("source_observation_state_inspect_request", request.core)
			)
				return { status: "invalid" } as const;
			const state = decodeSourceObservationState(
				await this.#durable.inspect(TRANSIENT_SOURCE_OBSERVATION_NAMESPACE, indexKey.indexKeySha256),
			);
			if (state === null) {
				return {
					status: "absent",
					inspectionSha256: sourceObservationDigest("source_observation_state_inspection", [
						request.requestSha256,
						"absent",
					]),
				} as const;
			}
			if (state.indexKey.indexKeySha256 !== indexKey.indexKeySha256) return { status: "sequence_conflict" } as const;
			const inspectedAt = request.core.requestedAt;
			const latestRow =
				state.head.core.acceptedObservationCount === 0
					? null
					: (state.acceptedRows[String(state.head.core.acceptedObservationCount - 1)] ?? null);
			const latest = latestRow?.core.observationReceipt ?? null;
			if (
				(latestRow?.core.draft.core.record.observationSha256 ?? null) !==
				state.head.core.lastAcceptedObservationSha256
			)
				return { status: "sequence_conflict" } as const;
			const body = {
				requestSha256: request.requestSha256,
				headSha256: state.head.headSha256,
				latestAcceptedObservationReceiptSha256: latest?.receiptSha256 ?? null,
				activeDraftReceiptSha256: state.activeDraft?.receipt.receiptSha256 ?? null,
				inspectedAt,
			};
			return {
				status: "matching",
				head: state.head,
				latestAcceptedObservationReceipt: latest,
				activeDraft: state.activeDraft?.receipt ?? null,
				inspectedAt,
				inspectionSha256: sourceObservationDigest("source_observation_state_inspection", body),
			} as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async reserveAndFreezeObservationDraft(
		request: Parameters<TransientTaskSourceObservationStoreV1["reserveAndFreezeObservationDraft"]>[0],
	) {
		let indexKey: ConfidentialTransientTaskPendingCaptureIndexKeyV1;
		try {
			const decodedRequest = decodeSourceObservationReservationRequest(request);
			indexKey = decodedRequest.core.indexKey;
		} catch {
			return { status: "invalid" } as const;
		}
		return this.#durable.transact(TRANSIENT_SOURCE_OBSERVATION_NAMESPACE, indexKey.indexKeySha256, currentInput => {
			let state: DurableTransientTaskSourceObservationStateV1 | null;
			try {
				state = decodeSourceObservationState(currentInput);
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
			if (state === null || state.pendingRecords.length !== 1 || state.startedReceipt === null)
				return { state: currentInput, result: { status: "observation_conflict" } as const };
			if (!exactJson(state.head, request.core.expectedHead))
				return { state: currentInput, result: { status: "sequence_conflict" } as const };
			const predecessor =
				state.head.core.acceptedObservationCount === 0
					? null
					: (state.acceptedRows[String(state.head.core.acceptedObservationCount - 1)]?.core.observationReceipt ??
						null);
			if (!exactJson(predecessor, request.core.expectedPredecessorObservationReceipt))
				return { state: currentInput, result: { status: "sequence_conflict" } as const };
			if (state.activeDraft !== null) {
				const same = state.activeDraft.draft.core.reservationRequest.requestSha256 === request.requestSha256;
				if (same) {
					return {
						state: currentInput,
						result: {
							status: "already_drafted",
							draft: state.activeDraft.draft,
							receipt: state.activeDraft.receipt,
						} as const,
					};
				}
				return { state: currentInput, result: { status: "sequence_conflict" } as const };
			}
			const sequence = state.head.core.nextObservationSequence;
			const reservationReceiptCore = {
				schemaVersion: 1 as const,
				indexKeySha256: indexKey.indexKeySha256,
				producer: request.core.producer,
				eventKind: request.core.eventKind,
				reservationId: request.core.reservationId,
				lifecycleOrdinal: sequence,
				observationSequence: sequence,
				predecessorObservationReceiptSha256: predecessor?.receiptSha256 ?? null,
				priorHeadSha256: state.head.headSha256,
				reservationRequestSha256: request.requestSha256,
				reservedAt: request.core.requestedAt,
			};
			const reservationReceipt = decodeSourceObservationReservationReceipt(
				{
					core: reservationReceiptCore,
					reservationReceiptSha256: sourceObservationDigest(
						"source_observation_reservation_receipt",
						reservationReceiptCore,
					),
				},
				indexKey.indexKeySha256,
				request,
			);
			const authority = sourceObservationAuthority(state, state.head, predecessor, reservationReceipt);
			if (authority === null) return { state: currentInput, result: { status: "observation_conflict" } as const };
			const record = buildSourceObservationRecord(request, authority);
			if (record === null) return { state: currentInput, result: { status: "invalid" } as const };
			try {
				decodeSourceObservationRecord(record, indexKey.indexKeySha256);
			} catch {
				return { state: currentInput, result: { status: "invalid" } as const };
			}
			const acceptedHeadCore = {
				schemaVersion: 1 as const,
				indexKeySha256: indexKey.indexKeySha256,
				nextObservationSequence: sequence + 1,
				acceptedObservationCount: sequence + 1,
				lastAcceptedObservationSha256: record.observationSha256,
			};
			const acceptedHead = {
				core: acceptedHeadCore,
				headSha256: sourceObservationDigest("source_observation_head", acceptedHeadCore),
			};
			const prepareRequestCore = {
				record,
				reservation: reservationReceipt,
				priorHead: state.head,
				predecessorObservationReceipt: predecessor,
				acceptedHead,
				requestedAt: request.core.requestedAt,
			};
			const prepareRequest = {
				core: prepareRequestCore,
				requestSha256: sourceObservationDigest("source_observation_prepare_request", prepareRequestCore),
			};
			const draftCore = {
				reservationRequest: request,
				reservationReceipt,
				priorHead: state.head,
				predecessorObservationReceipt: predecessor,
				record,
				acceptedHead,
				prepareRequest,
				draftedAt: request.core.requestedAt,
			};
			const draft = { core: draftCore, draftSha256: sourceObservationDigest("source_observation_draft", draftCore) };
			const draftReceiptCore = {
				schemaVersion: 1 as const,
				indexKeySha256: indexKey.indexKeySha256,
				reservationId: request.core.reservationId,
				reservationRequestSha256: request.requestSha256,
				reservationReceiptSha256: reservationReceipt.reservationReceiptSha256,
				observationSha256: record.observationSha256,
				prepareRequestSha256: prepareRequest.requestSha256,
				draftSha256: draft.draftSha256,
				recordedAt: request.core.requestedAt,
			};
			const receipt = {
				core: draftReceiptCore,
				receiptSha256: sourceObservationDigest("source_observation_draft_receipt", draftReceiptCore),
			};
			const next = { ...state, activeDraft: { draft, receipt } };
			return { state: encodeSourceObservationState(next), result: { status: "drafted", draft, receipt } as const };
		});
	}

	async inspectObservationDraft(
		request: Parameters<TransientTaskSourceObservationStoreV1["inspectObservationDraft"]>[0],
	) {
		try {
			const indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(request.indexKey);
			if (
				!strictRecord(request, [
					"indexKey",
					"reservationId",
					"expectedReservationRequestSha256",
					"expectedDraftSha256",
					"inspectedAt",
					"requestSha256",
				]) ||
				!isWellFormedString(request.reservationId) ||
				!isSha256Ref(request.expectedReservationRequestSha256) ||
				!isSha256Ref(request.expectedDraftSha256) ||
				!isIso8601(request.inspectedAt) ||
				!isSha256Ref(request.requestSha256) ||
				request.requestSha256 !==
					sourceObservationDigest(
						"source_observation_draft_inspect_request",
						sourceObservationUndigestedBody(request, "requestSha256"),
					)
			)
				return { status: "invalid" } as const;
			const state = decodeSourceObservationState(
				await this.#durable.inspect(TRANSIENT_SOURCE_OBSERVATION_NAMESPACE, indexKey.indexKeySha256),
			);
			const absentSha = sourceObservationDigest("source_observation_draft_inspection", [
				request.requestSha256,
				"absent",
			]);
			if (state === null || state.activeDraft === null)
				return { status: "absent", inspectionSha256: absentSha } as const;
			const active = state.activeDraft;
			if (active.draft.core.reservationReceipt.core.reservationId !== request.reservationId)
				return { status: "sequence_conflict" } as const;
			if (
				active.draft.core.reservationRequest.requestSha256 !== request.expectedReservationRequestSha256 ||
				active.draft.draftSha256 !== request.expectedDraftSha256
			)
				return { status: "observation_conflict" } as const;
			const inspectionSha256 = sourceObservationDigest("source_observation_draft_inspection", [
				request.requestSha256,
				active.draft.draftSha256,
				active.receipt.receiptSha256,
				request.inspectedAt,
			]);
			return { status: "matching", draft: active.draft, receipt: active.receipt, inspectionSha256 } as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async adoptObservationDraft(request: Parameters<TransientTaskSourceObservationStoreV1["adoptObservationDraft"]>[0]) {
		try {
			if (
				!strictRecord(request, ["inspection", "expectedInspectionSha256", "adoptedAt", "requestSha256"]) ||
				!strictRecord(request.inspection, ["status", "draft", "receipt", "inspectionSha256"]) ||
				request.inspection.status !== "matching" ||
				!isSha256Ref(request.inspection.inspectionSha256) ||
				!isSha256Ref(request.expectedInspectionSha256) ||
				!isIso8601(request.adoptedAt) ||
				!isSha256Ref(request.requestSha256) ||
				request.expectedInspectionSha256 !== request.inspection.inspectionSha256 ||
				request.requestSha256 !==
					sourceObservationDigest(
						"source_observation_draft_adopt_request",
						sourceObservationUndigestedBody(request, "requestSha256"),
					)
			)
				return { status: "invalid" } as const;
			const indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(
				request.inspection.draft.core.reservationRequest.core.indexKey,
			);
			const draft = decodeSourceObservationDraft(request.inspection.draft, indexKey.indexKeySha256);
			decodeSourceObservationDraftReceipt(request.inspection.receipt, indexKey.indexKeySha256, draft);
			return this.#durable.transact(
				TRANSIENT_SOURCE_OBSERVATION_NAMESPACE,
				indexKey.indexKeySha256,
				currentInput => {
					let state: DurableTransientTaskSourceObservationStateV1 | null;
					try {
						state = decodeSourceObservationState(currentInput);
					} catch {
						return { state: currentInput, result: { status: "invalid" } as const };
					}
					if (state?.activeDraft === null || state === null)
						return { state: currentInput, result: { status: "inspection_stale" } as const };
					if (
						!exactJson(state.activeDraft.draft, request.inspection.draft) ||
						!exactJson(state.activeDraft.receipt, request.inspection.receipt)
					)
						return { state: currentInput, result: { status: "observation_conflict" } as const };
					const prior = state.draftAdoptions[request.requestSha256];
					const next = prior
						? state
						: {
								...state,
								draftAdoptions: {
									...state.draftAdoptions,
									[request.requestSha256]: request.expectedInspectionSha256,
								},
							};
					if (prior) {
						return {
							state: encodeSourceObservationState(next),
							result: {
								status: "already_adopted",
								draft: state.activeDraft.draft,
								receipt: state.activeDraft.receipt,
							} as const,
						};
					}
					return {
						state: encodeSourceObservationState(next),
						result: {
							status: "adopted",
							draft: state.activeDraft.draft,
							receipt: state.activeDraft.receipt,
						} as const,
					};
				},
			);
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async commitObservationDraft(
		request: Parameters<TransientTaskSourceObservationStoreV1["commitObservationDraft"]>[0],
	) {
		try {
			if (
				!strictRecord(request, [
					"draft",
					"draftReceipt",
					"expectedHeadSha256",
					"expectedPredecessorObservationReceiptSha256",
					"committedAt",
					"requestSha256",
				]) ||
				!isSha256Ref(request.expectedHeadSha256) ||
				(request.expectedPredecessorObservationReceiptSha256 !== null &&
					!isSha256Ref(request.expectedPredecessorObservationReceiptSha256)) ||
				!isIso8601(request.committedAt) ||
				!isSha256Ref(request.requestSha256) ||
				request.requestSha256 !==
					sourceObservationDigest(
						"source_observation_draft_commit_request",
						sourceObservationUndigestedBody(request, "requestSha256"),
					)
			)
				return { status: "invalid" } as const;
			const indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(
				request.draft.core.reservationRequest.core.indexKey,
			);
			const draft = decodeSourceObservationDraft(request.draft, indexKey.indexKeySha256);
			decodeSourceObservationDraftReceipt(request.draftReceipt, indexKey.indexKeySha256, draft);
			return this.#durable.transact(
				TRANSIENT_SOURCE_OBSERVATION_NAMESPACE,
				indexKey.indexKeySha256,
				currentInput => {
					let state: DurableTransientTaskSourceObservationStateV1 | null;
					try {
						state = decodeSourceObservationState(currentInput);
					} catch {
						return { state: currentInput, result: { status: "invalid" } as const };
					}
					if (state === null) return { state: currentInput, result: { status: "draft_missing" } as const };
					const sequence = request.draft.core.reservationReceipt.core.observationSequence;
					const existing = state.acceptedRows[String(sequence)];
					if (existing) {
						return {
							state: currentInput,
							result:
								existing.core.draft.draftSha256 === request.draft.draftSha256
									? ({ status: "already_committed", acceptedRow: existing } as const)
									: ({ status: "observation_conflict" } as const),
						};
					}
					if (state.activeDraft === null)
						return { state: currentInput, result: { status: "draft_missing" } as const };
					if (
						!exactJson(state.activeDraft.draft, request.draft) ||
						!exactJson(state.activeDraft.receipt, request.draftReceipt)
					)
						return { state: currentInput, result: { status: "observation_conflict" } as const };
					if (
						state.head.headSha256 !== request.expectedHeadSha256 ||
						state.head.headSha256 !== request.draft.core.priorHead.headSha256
					)
						return { state: currentInput, result: { status: "sequence_conflict" } as const };
					if (
						(request.draft.core.predecessorObservationReceipt?.receiptSha256 ?? null) !==
						request.expectedPredecessorObservationReceiptSha256
					)
						return { state: currentInput, result: { status: "sequence_conflict" } as const };
					const receiptCore = {
						schemaVersion: 1 as const,
						indexKeySha256: indexKey.indexKeySha256,
						observationSha256: request.draft.core.record.observationSha256,
						eventKind: request.draft.core.record.core.eventKind,
						lifecycleOrdinal: sequence,
						observationSequence: sequence,
						reservationReceiptSha256: request.draft.core.reservationReceipt.reservationReceiptSha256,
						predecessorObservationReceiptSha256: request.expectedPredecessorObservationReceiptSha256,
						priorHeadSha256: request.expectedHeadSha256,
						acceptedHeadSha256: request.draft.core.acceptedHead.headSha256,
						recordedAt: request.committedAt,
					};
					const observationReceipt = {
						core: receiptCore,
						receiptSha256: sourceObservationDigest("source_observation_receipt", receiptCore),
					};
					const acceptedCore = {
						schemaVersion: 1 as const,
						draft: request.draft,
						draftReceipt: request.draftReceipt,
						observationReceipt,
					};
					const acceptedRow = {
						core: acceptedCore,
						acceptedRowSha256: sourceObservationDigest("source_observation_accepted_row", acceptedCore),
					};
					let pendingRecords = state.pendingRecords;
					let executeEntryReceipt = state.executeEntryReceipt;
					if (receiptCore.eventKind === "task_execute_entry" || receiptCore.eventKind === "eval_execute_entry") {
						executeEntryReceipt = observationReceipt;
						pendingRecords = pendingRecords.map(record => {
							const core = { ...record.core, executeEntryObservationReceipt: observationReceipt };
							return decodePendingCaptureRecord(
								{ core, recordSha256: sourceObservationDigest("pending_capture_record", core) },
								indexKey.indexKeySha256,
							);
						});
					}
					const next: DurableTransientTaskSourceObservationStateV1 = {
						...state,
						head: request.draft.core.acceptedHead,
						activeDraft: null,
						acceptedRows: { ...state.acceptedRows, [String(sequence)]: acceptedRow },
						pendingRecords,
						executeEntryReceipt,
					};
					return {
						state: encodeSourceObservationState(next),
						result: { status: "committed", acceptedRow } as const,
					};
				},
			);
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async inspectObservation(request: Parameters<TransientTaskSourceObservationStoreV1["inspectObservation"]>[0]) {
		try {
			if (
				!strictRecord(request, ["core", "requestSha256"]) ||
				!strictRecord(request.core, [
					"indexKey",
					"eventKind",
					"lifecycleOrdinal",
					"observationSequence",
					"expectedObservationSha256",
					"expectedReservationReceiptSha256",
					"expectedPredecessorObservationReceiptSha256",
					"expectedPriorHeadSha256",
					"expectedAcceptedHeadSha256",
					"requestedAt",
				]) ||
				!validSourceObservationEventKind(request.core.eventKind) ||
				!isSafeCount(request.core.lifecycleOrdinal) ||
				request.core.lifecycleOrdinal !== request.core.observationSequence ||
				!isSha256Ref(request.core.expectedObservationSha256) ||
				!isSha256Ref(request.core.expectedReservationReceiptSha256) ||
				(request.core.expectedPredecessorObservationReceiptSha256 !== null &&
					!isSha256Ref(request.core.expectedPredecessorObservationReceiptSha256)) ||
				!isSha256Ref(request.core.expectedPriorHeadSha256) ||
				!isSha256Ref(request.core.expectedAcceptedHeadSha256) ||
				!isIso8601(request.core.requestedAt) ||
				!isSha256Ref(request.requestSha256)
			)
				return { status: "invalid" } as const;
			const indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(request.core.indexKey);
			if (request.requestSha256 !== sourceObservationDigest("source_observation_inspect_request", request.core))
				return { status: "invalid" } as const;
			const state = decodeSourceObservationState(
				await this.#durable.inspect(TRANSIENT_SOURCE_OBSERVATION_NAMESPACE, indexKey.indexKeySha256),
			);
			const row = state?.acceptedRows[String(request.core.observationSequence)];
			if (!row)
				return {
					status: "absent",
					inspectionSha256: sourceObservationDigest("source_observation_inspection", [
						request.requestSha256,
						"absent",
					]),
				} as const;
			const receipt = row.core.observationReceipt.core;
			if (
				receipt.lifecycleOrdinal !== request.core.lifecycleOrdinal ||
				receipt.observationSequence !== request.core.observationSequence
			)
				return { status: "sequence_conflict" } as const;
			if (
				row.core.draft.core.record.observationSha256 !== request.core.expectedObservationSha256 ||
				receipt.reservationReceiptSha256 !== request.core.expectedReservationReceiptSha256 ||
				receipt.predecessorObservationReceiptSha256 !== request.core.expectedPredecessorObservationReceiptSha256 ||
				receipt.priorHeadSha256 !== request.core.expectedPriorHeadSha256 ||
				receipt.acceptedHeadSha256 !== request.core.expectedAcceptedHeadSha256 ||
				receipt.eventKind !== request.core.eventKind
			)
				return { status: "observation_conflict" } as const;
			const inspectionSha256 = sourceObservationDigest("source_observation_inspection", [
				request.requestSha256,
				row.acceptedRowSha256,
				request.core.requestedAt,
			]);
			return {
				status: "matching",
				acceptedRow: row,
				inspectedAt: request.core.requestedAt,
				inspectionSha256,
			} as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async adoptObservation(request: Parameters<TransientTaskSourceObservationStoreV1["adoptObservation"]>[0]) {
		try {
			if (
				!strictRecord(request, ["core", "requestSha256"]) ||
				!strictRecord(request.core, ["inspection", "expectedInspectionSha256", "requestedAt"]) ||
				!strictRecord(request.core.inspection, ["status", "acceptedRow", "inspectedAt", "inspectionSha256"]) ||
				request.core.inspection.status !== "matching" ||
				!isIso8601(request.core.inspection.inspectedAt) ||
				!isSha256Ref(request.core.inspection.inspectionSha256) ||
				!isSha256Ref(request.core.expectedInspectionSha256) ||
				!isIso8601(request.core.requestedAt) ||
				!isSha256Ref(request.requestSha256) ||
				request.core.expectedInspectionSha256 !== request.core.inspection.inspectionSha256 ||
				request.requestSha256 !== sourceObservationDigest("source_observation_adopt_request", request.core)
			)
				return { status: "invalid" } as const;
			const indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(
				request.core.inspection.acceptedRow.core.draft.core.reservationRequest.core.indexKey,
			);
			decodeSourceObservationAcceptedRow(request.core.inspection.acceptedRow, indexKey.indexKeySha256);
			return this.#durable.transact(
				TRANSIENT_SOURCE_OBSERVATION_NAMESPACE,
				indexKey.indexKeySha256,
				currentInput => {
					let state: DurableTransientTaskSourceObservationStateV1 | null;
					try {
						state = decodeSourceObservationState(currentInput);
					} catch {
						return { state: currentInput, result: { status: "invalid" } as const };
					}
					if (state === null) return { state: currentInput, result: { status: "inspection_stale" } as const };
					const sequence = request.core.inspection.acceptedRow.core.observationReceipt.core.observationSequence;
					const row = state.acceptedRows[String(sequence)];
					if (!row) return { state: currentInput, result: { status: "inspection_stale" } as const };
					if (!exactJson(row, request.core.inspection.acceptedRow))
						return { state: currentInput, result: { status: "observation_conflict" } as const };
					const prior = state.observationAdoptions[request.requestSha256];
					const next = prior
						? state
						: {
								...state,
								observationAdoptions: {
									...state.observationAdoptions,
									[request.requestSha256]: request.core.expectedInspectionSha256,
								},
							};
					if (prior) {
						return {
							state: encodeSourceObservationState(next),
							result: { status: "already_adopted", acceptedRow: row } as const,
						};
					}
					return {
						state: encodeSourceObservationState(next),
						result: { status: "adopted", acceptedRow: row } as const,
					};
				},
			);
		} catch {
			return { status: "invalid" } as const;
		}
	}
}
