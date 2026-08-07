import type { ISO8601, Sha256Ref } from "../registry/persistent-agent-contracts.js";
import type { RuntimeDurableStateStoreV1 } from "./managed-workspace.js";
import type { DurableTransientTaskSourceObservationStateV1 } from "./workspace-controller-codecs.js";
import {
	decodePendingCaptureRecord,
	decodeSourceObservationReceipt,
	decodeSourceObservationState,
	encodeSourceObservationState,
	exactJson,
	initialSourceObservationHead,
	isIso8601,
	isOneOf,
	isSha256Ref,
	sourceObservationDigest,
	sourceObservationPlainRecord,
	sourceObservationUndigestedBody,
	strictArray,
	strictRecord,
	TRANSIENT_SOURCE_OBSERVATION_NAMESPACE,
	validDetachedHubSerializerKey,
} from "./workspace-controller-codecs.js";
import type {
	ConfidentialTransientTaskPendingCaptureIndexKeyV1,
	ConfidentialTransientTaskPendingCaptureRecordV1,
	TransientTaskPendingCaptureIndexStoreV1,
	TransientTaskPendingCaptureRestartCoordinatorV1,
	TransientTaskPendingCaptureRestartItemResultV1,
} from "./workspace-runtime-contracts.js";
import { decodeTransientTaskPendingCaptureIndexKeyV1 } from "./workspace-runtime-contracts.js";

export class DurableTransientTaskPendingCaptureIndexStoreV1 implements TransientTaskPendingCaptureIndexStoreV1 {
	readonly #durable: RuntimeDurableStateStoreV1;

	constructor(options: { readonly durable: RuntimeDurableStateStoreV1 }) {
		this.#durable = options.durable;
	}

	async recordStartedCapture(request: {
		readonly record: ConfidentialTransientTaskPendingCaptureRecordV1;
		readonly recordedAt: ISO8601;
		readonly requestSha256: Sha256Ref;
	}) {
		try {
			if (
				!strictRecord(request, ["record", "recordedAt", "requestSha256"]) ||
				!isIso8601(request.recordedAt) ||
				!isSha256Ref(request.requestSha256)
			)
				return { status: "invalid" } as const;
			const record = decodePendingCaptureRecord(request.record);
			if (record.core.state !== "started") return { status: "invalid" } as const;
			const indexKey = record.core.indexKey;
			const firstVersion = record.core.durableVersions[0];
			const captureKey = record.core.captureKey;
			return this.#durable.transact(
				TRANSIENT_SOURCE_OBSERVATION_NAMESPACE,
				indexKey.indexKeySha256,
				currentInput => {
					let current: DurableTransientTaskSourceObservationStateV1 | null;
					try {
						current = decodeSourceObservationState(currentInput);
					} catch {
						return { state: currentInput, result: { status: "invalid" } as const };
					}
					if (current !== null) {
						if (
							current.pendingRecords.length === 1 &&
							current.pendingRecords[0].recordSha256 === record.recordSha256 &&
							current.startedReceipt !== null
						) {
							return {
								state: currentInput,
								result: {
									status: "already_recorded",
									record: current.pendingRecords[0],
									receipt: current.startedReceipt,
								} as const,
							};
						}
						return { state: currentInput, result: { status: "conflict" } as const };
					}
					const head = initialSourceObservationHead(indexKey);
					const receiptCore = {
						schemaVersion: 1 as const,
						indexKeySha256: indexKey.indexKeySha256,
						captureKeySha256: captureKey.keySha256,
						firstVersionSha256: firstVersion.versionSha256,
						startedRecordSha256: record.recordSha256,
						initialSourceObservationHeadSha256: head.headSha256,
						recordedAt: request.recordedAt,
					};
					const receipt = {
						core: receiptCore,
						receiptSha256: sourceObservationDigest("pending_capture_started_receipt", receiptCore),
					};
					const state: DurableTransientTaskSourceObservationStateV1 = {
						schemaVersion: 1,
						indexKey,
						head,
						activeDraft: null,
						acceptedRows: {},
						draftAdoptions: {},
						observationAdoptions: {},
						pendingRecords: [record],
						startedReceipt: receipt,
						executeEntryReceipt: null,
						pendingEnumerations: {},
						pendingAdoptions: {},
					};
					return {
						state: encodeSourceObservationState(state),
						result: { status: "recorded", record, receipt } as const,
					};
				},
			);
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async #advance(
		expectedRecordSha256: Sha256Ref,
		recordInput: ConfidentialTransientTaskPendingCaptureRecordV1,
		expectedPriorState: "started" | "finalized_unanchored",
	) {
		let record: ConfidentialTransientTaskPendingCaptureRecordV1;
		try {
			record = decodePendingCaptureRecord(recordInput);
			if (
				(expectedPriorState === "started" && record.core.state !== "finalized_unanchored") ||
				(expectedPriorState === "finalized_unanchored" && record.core.state !== "anchored")
			)
				return { status: "state_conflict" } as const;
		} catch {
			return { status: "conflict" } as const;
		}
		return this.#durable.transact(
			TRANSIENT_SOURCE_OBSERVATION_NAMESPACE,
			record.core.indexKey.indexKeySha256,
			currentInput => {
				let state: DurableTransientTaskSourceObservationStateV1 | null;
				try {
					state = decodeSourceObservationState(currentInput);
				} catch {
					return { state: currentInput, result: { status: "conflict" } as const };
				}
				if (state === null || state.pendingRecords.length !== 1)
					return { state: currentInput, result: { status: "state_conflict" } as const };
				const current = state.pendingRecords[0];
				if (current.recordSha256 === record.recordSha256)
					return {
						state: currentInput,
						result: { status: "already_advanced", recordSha256: record.recordSha256 } as const,
					};
				if (current.recordSha256 !== expectedRecordSha256 || current.core.state !== expectedPriorState)
					return { state: currentInput, result: { status: "state_conflict" } as const };
				const versionsExtend =
					record.core.durableVersions.length >= current.core.durableVersions.length &&
					current.core.durableVersions.every((version, index) =>
						exactJson(version, record.core.durableVersions[index]),
					);
				if (
					!exactJson(record.core.indexKey, current.core.indexKey) ||
					!exactJson(record.core.captureKey, current.core.captureKey) ||
					record.core.executeEntryObservationReceipt?.receiptSha256 !==
						current.core.executeEntryObservationReceipt?.receiptSha256 ||
					!versionsExtend
				)
					return { state: currentInput, result: { status: "conflict" } as const };
				const next = { ...state, pendingRecords: [record] };
				return {
					state: encodeSourceObservationState(next),
					result: { status: "advanced", recordSha256: record.recordSha256 } as const,
				};
			},
		);
	}

	async advanceFinalizedCapture(
		request: Parameters<TransientTaskPendingCaptureIndexStoreV1["advanceFinalizedCapture"]>[0],
	) {
		if (
			!strictRecord(request, ["expectedStartedRecordSha256", "record", "requestSha256"]) ||
			!isSha256Ref(request.expectedStartedRecordSha256) ||
			!isSha256Ref(request.requestSha256)
		)
			return { status: "conflict" } as const;
		return this.#advance(request.expectedStartedRecordSha256, request.record, "started");
	}

	async advanceAnchoredCapture(
		request: Parameters<TransientTaskPendingCaptureIndexStoreV1["advanceAnchoredCapture"]>[0],
	) {
		if (
			!strictRecord(request, ["expectedFinalizedRecordSha256", "record", "requestSha256"]) ||
			!isSha256Ref(request.expectedFinalizedRecordSha256) ||
			!isSha256Ref(request.requestSha256)
		)
			return { status: "conflict" } as const;
		return this.#advance(request.expectedFinalizedRecordSha256, request.record, "finalized_unanchored");
	}

	async recordExecuteEntryReceipt(
		request: Parameters<TransientTaskPendingCaptureIndexStoreV1["recordExecuteEntryReceipt"]>[0],
	) {
		try {
			if (!strictRecord(request, ["indexKey", "receipt", "requestSha256"]) || !isSha256Ref(request.requestSha256))
				return { status: "conflict" } as const;
			const indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(request.indexKey);
			const receipt = decodeSourceObservationReceipt(request.receipt, indexKey.indexKeySha256);
			const expectedEventKind = indexKey.core.toolName === "task" ? "task_execute_entry" : "eval_execute_entry";
			if (receipt.core.eventKind !== expectedEventKind) return { status: "conflict" } as const;
			return this.#durable.transact(
				TRANSIENT_SOURCE_OBSERVATION_NAMESPACE,
				indexKey.indexKeySha256,
				currentInput => {
					let state: DurableTransientTaskSourceObservationStateV1 | null;
					try {
						state = decodeSourceObservationState(currentInput);
					} catch {
						return { state: currentInput, result: { status: "conflict" } as const };
					}
					if (state === null || state.pendingRecords.length !== 1)
						return { state: currentInput, result: { status: "conflict" } as const };
					const accepted = state.acceptedRows[String(receipt.core.observationSequence)];
					if (!accepted || accepted.core.observationReceipt.receiptSha256 !== receipt.receiptSha256)
						return { state: currentInput, result: { status: "conflict" } as const };
					if (state.executeEntryReceipt !== null) {
						if (state.executeEntryReceipt.receiptSha256 === receipt.receiptSha256)
							return { state: currentInput, result: { status: "already_recorded" } as const };
						return { state: currentInput, result: { status: "conflict" } as const };
					}
					const record = state.pendingRecords[0];
					const core = { ...record.core, executeEntryObservationReceipt: receipt };
					const nextRecord = decodePendingCaptureRecord(
						{ core, recordSha256: sourceObservationDigest("pending_capture_record", core) },
						indexKey.indexKeySha256,
					);
					const next = { ...state, executeEntryReceipt: receipt, pendingRecords: [nextRecord] };
					return { state: encodeSourceObservationState(next), result: { status: "recorded" } as const };
				},
			);
		} catch {
			return { status: "conflict" } as const;
		}
	}

	async enumeratePendingTaskCaptures(
		request: Parameters<TransientTaskPendingCaptureIndexStoreV1["enumeratePendingTaskCaptures"]>[0],
	) {
		try {
			if (
				!strictRecord(request, ["core", "requestSha256"]) ||
				!strictRecord(request.core, ["indexKey", "requestedAt"]) ||
				!isIso8601(request.core.requestedAt) ||
				!isSha256Ref(request.requestSha256)
			)
				return { status: "invalid" } as const;
			const indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(request.core.indexKey);
			if (request.requestSha256 !== sourceObservationDigest("pending_capture_enumerate_request", request.core))
				return { status: "invalid" } as const;
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
					if (state === null) {
						const inspectionSha256 = sourceObservationDigest("pending_capture_enumeration", [
							request.requestSha256,
							"absent",
						]);
						return {
							state: currentInput,
							result: {
								status: "matching",
								pending: [],
								inspectedAt: request.core.requestedAt,
								inspectionSha256,
							} as const,
						};
					}
					if (!exactJson(state.indexKey, indexKey))
						return { state: currentInput, result: { status: "invalid" } as const };
					if (state.pendingRecords.length > 1) {
						const conflictSha256 = sourceObservationDigest("pending_capture_enumeration", [
							request.requestSha256,
							"duplicate",
							state.pendingRecords.map(record => record.recordSha256),
						]);
						return {
							state: currentInput,
							result: {
								status: "duplicate_pending_conflict",
								physicalMatchCount: state.pendingRecords.length,
								claimsPinned: true,
								statePinned: true,
								conflictSha256,
							} as const,
						};
					}
					const record = state.pendingRecords[0] ?? null;
					const executionUnknown = record !== null && record.core.executeEntryObservationReceipt === null;
					const inspectionSha256 = sourceObservationDigest("pending_capture_enumeration", [
						request.requestSha256,
						record?.recordSha256 ?? null,
						executionUnknown,
						request.core.requestedAt,
					]);
					const next = {
						...state,
						pendingEnumerations: {
							...state.pendingEnumerations,
							[inspectionSha256]: { recordSha256: record?.recordSha256 ?? null, executionUnknown },
						},
					};
					if (record === null)
						return {
							state: encodeSourceObservationState(next),
							result: {
								status: "matching",
								pending: [],
								inspectedAt: request.core.requestedAt,
								inspectionSha256,
							} as const,
						};
					if (executionUnknown)
						return {
							state: encodeSourceObservationState(next),
							result: {
								status: "execution_unknown",
								reason: "execute_entry_or_terminal_route_missing",
								pending: [record],
								claimsPinned: true,
								statePinned: true,
								inspectedAt: request.core.requestedAt,
								inspectionSha256,
							} as const,
						};
					return {
						state: encodeSourceObservationState(next),
						result: {
							status: "matching",
							pending: [record],
							inspectedAt: request.core.requestedAt,
							inspectionSha256,
						} as const,
					};
				},
			);
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async inspectPendingTaskCapture(
		request: Parameters<TransientTaskPendingCaptureIndexStoreV1["inspectPendingTaskCapture"]>[0],
	) {
		try {
			if (
				!strictRecord(request, ["core", "requestSha256"]) ||
				!strictRecord(request.core, ["indexKey", "expectedEnumerationInspectionSha256", "requestedAt"]) ||
				!isSha256Ref(request.core.expectedEnumerationInspectionSha256) ||
				!isIso8601(request.core.requestedAt) ||
				!isSha256Ref(request.requestSha256)
			)
				return { status: "invalid" } as const;
			const indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(request.core.indexKey);
			if (request.requestSha256 !== sourceObservationDigest("pending_capture_inspect_request", request.core))
				return { status: "invalid" } as const;
			const state = decodeSourceObservationState(
				await this.#durable.inspect(TRANSIENT_SOURCE_OBSERVATION_NAMESPACE, indexKey.indexKeySha256),
			);
			if (state === null)
				return {
					status: "absent",
					inspectionSha256: sourceObservationDigest("pending_capture_inspection", [
						request.requestSha256,
						"absent",
					]),
				} as const;
			const enumerated = state.pendingEnumerations[request.core.expectedEnumerationInspectionSha256];
			if (!enumerated) return { status: "enumeration_stale" } as const;
			if (state.pendingRecords.length > 1)
				return {
					status: "duplicate_pending_conflict",
					claimsPinned: true,
					statePinned: true,
					conflictSha256: sourceObservationDigest("pending_capture_inspection", [
						request.requestSha256,
						"duplicate",
						state.pendingRecords.map(record => record.recordSha256),
					]),
				} as const;
			const record = state.pendingRecords[0] ?? null;
			if ((record?.recordSha256 ?? null) !== enumerated.recordSha256)
				return { status: "enumeration_stale" } as const;
			if (record === null)
				return {
					status: "absent",
					inspectionSha256: sourceObservationDigest("pending_capture_inspection", [
						request.requestSha256,
						"absent",
					]),
				} as const;
			const inspectionSha256 = sourceObservationDigest("pending_capture_inspection", [
				request.requestSha256,
				record.recordSha256,
				enumerated.executionUnknown,
				request.core.requestedAt,
			]);
			if (enumerated.executionUnknown) {
				return {
					status: "execution_unknown",
					pending: record,
					claimsPinned: true,
					statePinned: true,
					inspectedAt: request.core.requestedAt,
					inspectionSha256,
				} as const;
			}
			return {
				status: "matching",
				pending: record,
				inspectedAt: request.core.requestedAt,
				inspectionSha256,
			} as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async adoptPendingTaskCapture(
		request: Parameters<TransientTaskPendingCaptureIndexStoreV1["adoptPendingTaskCapture"]>[0],
	) {
		try {
			if (
				!strictRecord(request, ["core", "requestSha256"]) ||
				!strictRecord(request.core, ["inspection", "expectedInspectionSha256", "requestedAt"]) ||
				!sourceObservationPlainRecord(request.core.inspection) ||
				!isOneOf(request.core.inspection.status, ["matching", "execution_unknown"]) ||
				!isSha256Ref(request.core.inspection.inspectionSha256) ||
				!isIso8601(request.core.inspection.inspectedAt) ||
				!isSha256Ref(request.core.expectedInspectionSha256) ||
				!isIso8601(request.core.requestedAt) ||
				!isSha256Ref(request.requestSha256) ||
				request.core.expectedInspectionSha256 !== request.core.inspection.inspectionSha256 ||
				request.requestSha256 !== sourceObservationDigest("pending_capture_adopt_request", request.core)
			)
				return { status: "invalid" } as const;
			const inspectionKeys = Object.keys(request.core.inspection).sort();
			const expectedInspectionKeys =
				request.core.inspection.status === "execution_unknown"
					? ["claimsPinned", "inspectedAt", "inspectionSha256", "pending", "statePinned", "status"]
					: ["inspectedAt", "inspectionSha256", "pending", "status"];
			if (
				!exactJson(inspectionKeys, expectedInspectionKeys) ||
				(request.core.inspection.status === "execution_unknown" &&
					(request.core.inspection.claimsPinned !== true || request.core.inspection.statePinned !== true))
			)
				return { status: "invalid" } as const;
			const record = decodePendingCaptureRecord(request.core.inspection.pending);
			const indexKey = record.core.indexKey;
			if (
				(request.core.inspection.status === "execution_unknown") !==
				(record.core.executeEntryObservationReceipt === null)
			)
				return { status: "conflict" } as const;
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
					if (state === null || state.pendingRecords.length !== 1)
						return { state: currentInput, result: { status: "inspection_stale" } as const };
					if (state.pendingRecords[0].recordSha256 !== record.recordSha256)
						return { state: currentInput, result: { status: "inspection_stale" } as const };
					const adoptionReceiptSha256 = sourceObservationDigest("pending_capture_adoption", [
						request.requestSha256,
						record.recordSha256,
						request.core.expectedInspectionSha256,
						request.core.requestedAt,
					]);
					const prior = state.pendingAdoptions[request.requestSha256];
					const next = prior
						? state
						: {
								...state,
								pendingAdoptions: { ...state.pendingAdoptions, [request.requestSha256]: adoptionReceiptSha256 },
							};
					const executionUnknown = request.core.inspection.status === "execution_unknown";
					if (executionUnknown) {
						return {
							state: encodeSourceObservationState(next),
							result: {
								status: "execution_unknown",
								pending: record,
								claimsPinned: true,
								statePinned: true,
								adoptionReceiptSha256,
							} as const,
						};
					}
					if (prior) {
						return {
							state: encodeSourceObservationState(next),
							result: {
								status: "already_adopted",
								pending: record,
								adoptionReceiptSha256,
							} as const,
						};
					}
					return {
						state: encodeSourceObservationState(next),
						result: {
							status: "adopted",
							pending: record,
							adoptionReceiptSha256,
						} as const,
					};
				},
			);
		} catch {
			return { status: "invalid" } as const;
		}
	}
}
export class DurableTransientTaskPendingCaptureRestartCoordinatorV1
	implements TransientTaskPendingCaptureRestartCoordinatorV1
{
	readonly #store: TransientTaskPendingCaptureIndexStoreV1;

	constructor(options: { readonly store: TransientTaskPendingCaptureIndexStoreV1 }) {
		this.#store = options.store;
		Object.freeze(this);
	}

	async resumePersistedAssistantTaskCaptures(
		request: Parameters<TransientTaskPendingCaptureRestartCoordinatorV1["resumePersistedAssistantTaskCaptures"]>[0],
	): Promise<readonly TransientTaskPendingCaptureRestartItemResultV1[]> {
		if (
			!strictRecord(request, ["serializerKey", "orderedIndexKeys", "requestedAt", "requestSha256"]) ||
			!validDetachedHubSerializerKey(request.serializerKey) ||
			!strictArray(request.orderedIndexKeys) ||
			!isIso8601(request.requestedAt) ||
			!isSha256Ref(request.requestSha256) ||
			request.requestSha256 !==
				sourceObservationDigest(
					"pending_capture_restart_request",
					sourceObservationUndigestedBody(request, "requestSha256"),
				)
		)
			throw new TypeError("Invalid pending-capture restart request");
		const serializer = request.serializerKey;
		const ordered: ConfidentialTransientTaskPendingCaptureIndexKeyV1[] = [];
		let priorOrdinal = -1;
		for (const input of request.orderedIndexKeys) {
			let key: ConfidentialTransientTaskPendingCaptureIndexKeyV1;
			try {
				key = decodeTransientTaskPendingCaptureIndexKeyV1(input);
			} catch {
				throw new TypeError("Invalid pending-capture restart index key");
			}
			const core = key.core;
			if (
				core.parentSessionId !== serializer.parentSessionId ||
				core.parentSessionGenerationSha256 !== serializer.parentSessionGenerationSha256 ||
				core.parentBranchGenerationSha256 !== serializer.parentBranchGenerationSha256 ||
				core.assistantAnchorEntryId !== serializer.assistantAnchorEntryId ||
				core.sourceToolCallOrdinal <= priorOrdinal
			)
				throw new TypeError("Pending-capture restart authority conflict");
			priorOrdinal = core.sourceToolCallOrdinal;
			ordered.push(key);
		}
		const results: TransientTaskPendingCaptureRestartItemResultV1[] = [];
		for (const key of ordered) {
			const enumerateCore = { indexKey: key, requestedAt: request.requestedAt };
			const enumerated = await this.#store.enumeratePendingTaskCaptures({
				core: enumerateCore,
				requestSha256: sourceObservationDigest("pending_capture_enumerate_request", enumerateCore),
			});
			if (enumerated.status === "duplicate_pending_conflict") {
				results.push({
					status: "duplicate_pending_conflict",
					indexKeySha256: key.indexKeySha256,
					conflictSha256: enumerated.conflictSha256,
					claimsPinned: true,
					statePinned: true,
				});
				continue;
			}
			if (
				enumerated.status === "session_generation_replaced" ||
				enumerated.status === "branch_generation_replaced" ||
				enumerated.status === "invalid"
			)
				throw new TypeError("Pending-capture restart enumeration conflict");
			if (enumerated.status !== "matching" && enumerated.status !== "execution_unknown")
				throw new TypeError("Invalid pending-capture restart enumeration");
			if (enumerated.pending.length === 0) {
				results.push({ status: "absent", indexKeySha256: key.indexKeySha256 });
				continue;
			}
			const inspectCore = {
				indexKey: key,
				expectedEnumerationInspectionSha256: enumerated.inspectionSha256,
				requestedAt: request.requestedAt,
			};
			const inspected = await this.#store.inspectPendingTaskCapture({
				core: inspectCore,
				requestSha256: sourceObservationDigest("pending_capture_inspect_request", inspectCore),
			});
			if (inspected.status === "absent") {
				results.push({ status: "absent", indexKeySha256: key.indexKeySha256 });
				continue;
			}
			if (inspected.status === "duplicate_pending_conflict") {
				results.push({
					status: "duplicate_pending_conflict",
					indexKeySha256: key.indexKeySha256,
					conflictSha256: inspected.conflictSha256,
					claimsPinned: true,
					statePinned: true,
				});
				continue;
			}
			if (inspected.status !== "matching" && inspected.status !== "execution_unknown")
				throw new TypeError("Pending-capture restart inspection conflict");
			const adoptCore = {
				inspection: inspected,
				expectedInspectionSha256: inspected.inspectionSha256,
				requestedAt: request.requestedAt,
			};
			const adopted = await this.#store.adoptPendingTaskCapture({
				core: adoptCore,
				requestSha256: sourceObservationDigest("pending_capture_adopt_request", adoptCore),
			});
			if (adopted.status === "execution_unknown") {
				results.push({
					status: "execution_unknown",
					indexKeySha256: key.indexKeySha256,
					pendingRecordSha256: adopted.pending.recordSha256,
					claimsPinned: true,
					statePinned: true,
				});
			} else if (adopted.status === "adopted" || adopted.status === "already_adopted") {
				results.push({
					status: "continued",
					indexKeySha256: key.indexKeySha256,
					adoptedPendingRecordSha256: adopted.pending.recordSha256,
				});
			} else if (adopted.status === "duplicate_pending_conflict") {
				results.push({
					status: "duplicate_pending_conflict",
					indexKeySha256: key.indexKeySha256,
					conflictSha256: sourceObservationDigest("pending_capture_restart_barrier", [
						key.indexKeySha256,
						"duplicate",
					]),
					claimsPinned: true,
					statePinned: true,
				});
			} else {
				throw new TypeError("Pending-capture restart adoption conflict");
			}
		}
		return results;
	}
}
