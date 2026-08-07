import type { ISO8601, OperationId, Sha256Ref } from "../registry/persistent-agent-contracts.js";
import type { RuntimeDurableStateStoreV1, RuntimeDurableStateTransactionResultV1 } from "./managed-workspace.js";
import type {
	PayloadAvailableRowV1,
	PayloadDeletedRowV1,
	RuntimeTransientAuthorityV1,
	TransientTaskRuntimeStateV1,
} from "./workspace-controller-codecs.js";
import {
	addMilliseconds,
	cleanupProofMatches,
	controllerProofMatches,
	derivedPayloadRetentionId,
	exactJson,
	isOneOf,
	isPayloadAttempt,
	isSafeCount,
	isSha256Hex,
	isSha256Ref,
	isWellFormedString,
	nowIso,
	payloadAttemptProjection,
	payloadAuthorityMatchesRef,
	payloadDeleteAuthorityTuple,
	payloadInspection,
	payloadLifetimeTuple,
	payloadPutReceiptFromRequest,
	payloadRecoveryAuthorityTuple,
	payloadRefTuple,
	payloadRetentionReceiptFromAttempt,
	payloadRow,
	payloadStoreKey,
	payloadTupleRef,
	proxyFreeData,
	publicationMapKey,
	publicationState,
	renewalDeadline,
	strictRecord,
	TRANSIENT_NAMESPACE,
	transientKey,
	transientRuntimeState,
	validPayloadDeleteAuthority,
	validPayloadDeleteRequest,
	validPayloadPutRequest,
	validPayloadRef,
	validPayloadRetentionAuthority,
	validPayloadRetentionRequest,
	validPayloadTtl,
	validPublicationReceipt,
} from "./workspace-controller-codecs.js";
import type {
	TransientTaskOutcomePayloadActiveRetentionAuthorityV1,
	TransientTaskOutcomePayloadDeleteAuthorityV1,
	TransientTaskOutcomePayloadDeleteReceiptV1,
	TransientTaskOutcomePayloadDeleteRequestV1,
	TransientTaskOutcomePayloadDeleteResultV1,
	TransientTaskOutcomePayloadLifetimeV1,
	TransientTaskOutcomePayloadPutRequestV1,
	TransientTaskOutcomePayloadPutResultV1,
	TransientTaskOutcomePayloadRefV1,
	TransientTaskOutcomePayloadRetentionAuthorityV1,
	TransientTaskOutcomePayloadRetentionReceiptV1,
	TransientTaskOutcomePayloadRetentionRequestV1,
	TransientTaskOutcomePayloadRetentionResultV1,
	TransientTaskOutcomePayloadStoreV1,
	TransientTaskResultPublicationStateV1,
} from "./workspace-runtime-contracts.js";
import {
	TRANSIENT_TASK_OUTCOME_PAYLOAD_BYTES_MAX_V1,
	TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MAX_V1,
} from "./workspace-runtime-contracts.js";

export class DurableTransientTaskOutcomePayloadStoreV1 implements TransientTaskOutcomePayloadStoreV1 {
	readonly #durable: RuntimeDurableStateStoreV1;
	readonly #authority: RuntimeTransientAuthorityV1;
	readonly #now: () => ISO8601;

	constructor(options: {
		readonly durable: RuntimeDurableStateStoreV1;
		readonly authority: RuntimeTransientAuthorityV1;
		readonly now?: () => ISO8601;
	}) {
		this.#durable = options.durable;
		this.#authority = options.authority;
		this.#now = options.now ?? nowIso;
	}

	#fixedPayloadIdentity(
		state: TransientTaskRuntimeStateV1,
		ref: TransientTaskOutcomePayloadRefV1,
		payloadDeleteId: OperationId,
	): boolean {
		const current = state.authority;
		if (
			!current ||
			current.taskId !== ref.taskId ||
			current.runId !== ref.runId ||
			current.resultPublicationId !== ref.resultPublicationId ||
			current.effectIdentityManifest.taskId !== ref.taskId ||
			current.effectIdentityManifest.runId !== ref.runId ||
			!isWellFormedString(current.effectIdentityManifest.payloadRetentionNamespaceId)
		)
			return false;
		return ref.payloadRole === "pending"
			? current.pendingPayloadId === ref.payloadId && current.pendingPayloadDeleteId === payloadDeleteId
			: current.composedPayloadId === ref.payloadId && current.composedPayloadDeleteId === payloadDeleteId;
	}

	#activeAuthorityCurrent(
		state: TransientTaskRuntimeStateV1,
		ref: TransientTaskOutcomePayloadRefV1,
		payloadDeleteId: OperationId,
		authority: TransientTaskOutcomePayloadActiveRetentionAuthorityV1,
		observedAt: ISO8601,
	): boolean {
		const current = state.authority;
		if (
			!current ||
			!this.#fixedPayloadIdentity(state, ref, payloadDeleteId) ||
			!payloadAuthorityMatchesRef(ref, payloadDeleteId, authority) ||
			authority.expectedAuthorityRevision !== current.revision
		)
			return false;
		if (authority.kind === "controller") {
			return (
				current.state !== "cleanup" &&
				current.state !== "deleted" &&
				current.state !== "discarded" &&
				current.controller !== null &&
				controllerProofMatches(current.controller.proof, authority.proof) &&
				Date.parse(current.controller.expiresAt) > Date.parse(observedAt)
			);
		}
		if (authority.kind === "cleanup") {
			return (
				current.state === "cleanup" &&
				cleanupProofMatches(current.cleanup.authority.proof, authority.proof) &&
				Date.parse(current.cleanup.authority.expiresAt) > Date.parse(observedAt)
			);
		}
		if (current.state !== "deleted" && current.state !== "discarded") return false;
		const evidence = current.cleanup.progress.evidence;
		return (
			exactJson(evidence, authority.terminalEvidence) &&
			evidence.taskId === ref.taskId &&
			evidence.runId === ref.runId &&
			evidence.resultPublicationId === ref.resultPublicationId &&
			(ref.payloadRole === "pending"
				? evidence.pendingPayloadId === ref.payloadId && evidence.pendingPayloadDeleteId === payloadDeleteId
				: evidence.composedPayloadId === ref.payloadId && evidence.composedPayloadDeleteId === payloadDeleteId)
		);
	}

	async #recoveryAuthorityCurrent(
		state: TransientTaskRuntimeStateV1,
		ref: TransientTaskOutcomePayloadRefV1,
		payloadDeleteId: OperationId,
		authority: Extract<TransientTaskOutcomePayloadRetentionAuthorityV1, { phase: "recovery_retention" }>,
	): Promise<boolean> {
		const current = state.authority;
		if (
			!current ||
			(current.state !== "deleted" && current.state !== "discarded") ||
			!this.#fixedPayloadIdentity(state, ref, payloadDeleteId) ||
			!payloadAuthorityMatchesRef(ref, payloadDeleteId, authority) ||
			payloadTupleRef(payloadRecoveryAuthorityTuple(authority.recoveryAuthority)) !==
				authority.recoveryAuthoritySha256
		)
			return false;
		const recovery = authority.recoveryAuthority;
		const evidence = current.cleanup.progress.evidence;
		const pendingReceipt = current.cleanup.pendingOutcomeReceipt;
		if (
			recovery.pendingOutcomeReceiptSha256 !== pendingReceipt.receiptSha256 ||
			pendingReceipt.taskId !== ref.taskId ||
			pendingReceipt.runId !== ref.runId ||
			pendingReceipt.resultPublicationId !== ref.resultPublicationId ||
			recovery.terminalEvidenceId !== evidence.postTerminalCleanupEvidenceId ||
			recovery.terminalEvidenceSha256 !== evidence.evidenceSha256 ||
			evidence.taskId !== ref.taskId ||
			evidence.runId !== ref.runId ||
			evidence.resultPublicationId !== ref.resultPublicationId
		)
			return false;
		if (recovery.source === "pending_outcome") return true;
		if (evidence.outcome !== "succeeded") return false;
		let publication: TransientTaskResultPublicationStateV1 | null;
		try {
			publication = await publicationState(
				state.publications[
					publicationMapKey({
						schemaVersion: 1,
						taskId: current.taskId,
						runId: current.runId,
						createId: current.createId,
						resultPublicationId: current.resultPublicationId,
						resultPublicationTargetId: current.resultPublicationTargetId,
						resultPublicationTargetCleanupId: current.resultPublicationTargetCleanupId,
					})
				],
			);
		} catch {
			return false;
		}
		if (publication?.state === "publication_outcome_unknown") {
			return (
				publication.deliveryPayloadRole === "composed" &&
				publication.deliveryPayloadId === ref.payloadId &&
				publication.deliveryPayloadDeleteId === payloadDeleteId &&
				publication.singleResultComposition?.receiptSha256 === recovery.singleResultCompositionReceiptSha256 &&
				publication.terminalEvidenceId === evidence.postTerminalCleanupEvidenceId &&
				publication.terminalEvidenceSha256 === evidence.evidenceSha256
			);
		}
		if (publication?.state === "published") {
			return (
				publication.publicationReceipt.deliveryPayloadRole === "composed" &&
				publication.publicationReceipt.deliveryPayloadId === ref.payloadId &&
				publication.publicationReceipt.deliveryPayloadDeleteId === payloadDeleteId &&
				publication.publicationReceipt.singleResultCompositionReceiptSha256 ===
					recovery.singleResultCompositionReceiptSha256 &&
				publication.publicationReceipt.terminalEvidenceId === evidence.postTerminalCleanupEvidenceId &&
				publication.publicationReceipt.terminalEvidenceSha256 === evidence.evidenceSha256
			);
		}
		return false;
	}

	async #retentionAuthorityCurrent(
		state: TransientTaskRuntimeStateV1,
		ref: TransientTaskOutcomePayloadRefV1,
		payloadDeleteId: OperationId,
		authority: TransientTaskOutcomePayloadRetentionAuthorityV1,
		observedAt: ISO8601,
	): Promise<boolean> {
		return authority.phase === "active_task"
			? this.#activeAuthorityCurrent(state, ref, payloadDeleteId, authority, observedAt)
			: this.#recoveryAuthorityCurrent(state, ref, payloadDeleteId, authority);
	}

	async #authorized(
		ref: TransientTaskOutcomePayloadRefV1,
		payloadDeleteId: OperationId,
		authority: TransientTaskOutcomePayloadRetentionAuthorityV1,
	): Promise<boolean> {
		if (!payloadAuthorityMatchesRef(ref, payloadDeleteId, authority)) return false;
		if (authority.phase === "recovery_retention") {
			if (
				payloadTupleRef(payloadRecoveryAuthorityTuple(authority.recoveryAuthority)) !==
				authority.recoveryAuthoritySha256
			)
				return false;
			return this.#authority.authorizeTerminal({
				key: { taskId: ref.taskId, runId: ref.runId },
				terminalEvidenceId: authority.recoveryAuthority.terminalEvidenceId,
				terminalEvidenceSha256: authority.recoveryAuthority.terminalEvidenceSha256,
			});
		}
		const revision = await this.#authority.inspectRevision({ taskId: ref.taskId, runId: ref.runId });
		if (revision !== authority.expectedAuthorityRevision) return false;
		if (authority.kind === "controller")
			return (await this.#authority.authorizeController(authority.proof)) === "current";
		if (authority.kind === "cleanup") return this.#authority.authorizeCleanup(authority.proof);
		return this.#authority.authorizeTerminal({
			key: { taskId: ref.taskId, runId: ref.runId },
			terminalEvidenceId: authority.terminalEvidence.evidenceId,
			terminalEvidenceSha256: authority.terminalEvidence.evidenceSha256,
		});
	}

	async #deleteExternallyAuthorized(
		ref: TransientTaskOutcomePayloadRefV1,
		payloadDeleteId: OperationId,
		authority: TransientTaskOutcomePayloadDeleteAuthorityV1,
	): Promise<boolean> {
		if (authority.reason === "published") return true;
		if (
			authority.recoveryAuthority.taskId !== ref.taskId ||
			authority.recoveryAuthority.runId !== ref.runId ||
			authority.recoveryAuthority.resultPublicationId !== ref.resultPublicationId ||
			authority.recoveryAuthority.payloadRole !== ref.payloadRole ||
			authority.recoveryAuthority.payloadId !== ref.payloadId ||
			authority.recoveryAuthority.payloadDeleteId !== payloadDeleteId ||
			payloadTupleRef(payloadRecoveryAuthorityTuple(authority.recoveryAuthority)) !==
				authority.recoveryAuthoritySha256
		)
			return false;
		return this.#authority.authorizeTerminal({
			key: { taskId: ref.taskId, runId: ref.runId },
			terminalEvidenceId: authority.recoveryAuthority.terminalEvidenceId,
			terminalEvidenceSha256: authority.recoveryAuthority.terminalEvidenceSha256,
		});
	}

	async #publishedDeleteAuthorized(
		state: TransientTaskRuntimeStateV1,
		ref: TransientTaskOutcomePayloadRefV1,
		payloadDeleteId: OperationId,
		authority: Extract<TransientTaskOutcomePayloadDeleteAuthorityV1, { reason: "published" }>,
		putReceiptSha256: Sha256Ref | null,
	): Promise<boolean> {
		const current = state.authority;
		if (
			!current ||
			(current.state !== "deleted" && current.state !== "discarded") ||
			!this.#fixedPayloadIdentity(state, ref, payloadDeleteId)
		)
			return false;
		const evidence = current.cleanup.progress.evidence;
		let publication: TransientTaskResultPublicationStateV1 | null;
		try {
			publication = await publicationState(
				state.publications[
					publicationMapKey({
						schemaVersion: 1,
						taskId: current.taskId,
						runId: current.runId,
						createId: current.createId,
						resultPublicationId: current.resultPublicationId,
						resultPublicationTargetId: current.resultPublicationTargetId,
						resultPublicationTargetCleanupId: current.resultPublicationTargetCleanupId,
					})
				],
			);
		} catch {
			return false;
		}
		if (publication?.state !== "published") return false;
		const receipt = publication.publicationReceipt;
		if (
			receipt.receiptSha256 !== authority.publicationReceiptSha256 ||
			receipt.taskId !== ref.taskId ||
			receipt.runId !== ref.runId ||
			receipt.createId !== current.createId ||
			receipt.resultPublicationId !== ref.resultPublicationId ||
			receipt.resultPublicationTargetId !== current.resultPublicationTargetId ||
			receipt.resultPublicationTargetCleanupId !== current.resultPublicationTargetCleanupId ||
			receipt.outcomeSha256 !== current.cleanup.pendingOutcomeReceipt.outcomeSha256 ||
			receipt.deliveryPayloadRole !== ref.payloadRole ||
			receipt.deliveryPayloadId !== ref.payloadId ||
			receipt.deliveryPayloadDeleteId !== payloadDeleteId ||
			receipt.deliveryPayloadSha256 !== ref.payloadSha256 ||
			receipt.deliveryPayloadByteLength !== ref.byteLength ||
			(putReceiptSha256 !== null && receipt.deliveryPayloadPutReceiptSha256 !== putReceiptSha256) ||
			receipt.terminalEvidenceId !== evidence.postTerminalCleanupEvidenceId ||
			receipt.terminalEvidenceSha256 !== evidence.evidenceSha256 ||
			!(await validPublicationReceipt(receipt))
		)
			return false;
		return receipt.parentDelivery.routeKind === "foreground_tool_call"
			? authority.foregroundSettlementCompletionEvidenceSha256 !== null
			: authority.foregroundSettlementCompletionEvidenceSha256 === null;
	}

	async #deleteAuthorityCurrent(
		state: TransientTaskRuntimeStateV1,
		ref: TransientTaskOutcomePayloadRefV1,
		payloadDeleteId: OperationId,
		putReceiptSha256: Sha256Ref,
		lifetime: TransientTaskOutcomePayloadLifetimeV1,
		latestRetentionReceipt: TransientTaskOutcomePayloadRetentionReceiptV1 | null,
		authority: TransientTaskOutcomePayloadDeleteAuthorityV1,
		observedNow: ISO8601,
	): Promise<
		| "authorized"
		| "active_lifetime_not_deletable"
		| "not_expired"
		| "publication_authority_required"
		| "recovery_authority_required"
	> {
		if (authority.reason === "published") {
			return (await this.#publishedDeleteAuthorized(state, ref, payloadDeleteId, authority, putReceiptSha256))
				? "authorized"
				: "publication_authority_required";
		}
		const recoveryAuthority: Extract<
			TransientTaskOutcomePayloadRetentionAuthorityV1,
			{ phase: "recovery_retention" }
		> = {
			phase: "recovery_retention",
			recoveryAuthority: authority.recoveryAuthority,
			recoveryAuthoritySha256: authority.recoveryAuthoritySha256,
		};
		if (!(await this.#recoveryAuthorityCurrent(state, ref, payloadDeleteId, recoveryAuthority)))
			return "recovery_authority_required";
		if (lifetime.phase !== "recovery_retention") return "active_lifetime_not_deletable";
		if (
			!exactJson(authority.recoveryLifetime, lifetime) ||
			authority.recoveryAuthoritySha256 !== lifetime.recoveryAuthoritySha256 ||
			latestRetentionReceipt?.authority.phase !== "recovery_retention" ||
			!exactJson(latestRetentionReceipt.authority.recoveryAuthority, authority.recoveryAuthority) ||
			latestRetentionReceipt.authority.recoveryAuthoritySha256 !== authority.recoveryAuthoritySha256 ||
			!exactJson(latestRetentionReceipt.lifetime, lifetime)
		)
			return "recovery_authority_required";
		const observed = Date.parse(authority.observedAt);
		const expiresAt = Date.parse(lifetime.expiresAt);
		const actualNow = Date.parse(observedNow);
		if (observed < expiresAt || actualNow < expiresAt) return "not_expired";
		return observed <= actualNow ? "authorized" : "recovery_authority_required";
	}

	async put(request: TransientTaskOutcomePayloadPutRequestV1): Promise<TransientTaskOutcomePayloadPutResultV1> {
		if (!proxyFreeData(request)) return { status: "invalid" } as const;
		if (!validPayloadTtl(request?.retentionMs)) return { status: "retention_invalid" } as const;
		if (
			request?.ref !== null &&
			typeof request?.ref === "object" &&
			!Array.isArray(request.ref) &&
			typeof request.ref.byteLength === "number" &&
			request.ref.byteLength > TRANSIENT_TASK_OUTCOME_PAYLOAD_BYTES_MAX_V1
		)
			return { status: "payload_too_large" } as const;
		if (!validPayloadPutRequest(request)) return { status: "invalid" } as const;
		if (!(await this.#authorized(request.ref, request.payloadDeleteId, request.authority)))
			return { status: "authority_conflict" } as const;
		const key = { taskId: request.ref.taskId, runId: request.ref.runId };
		const mapKey = payloadStoreKey(request.ref);
		return this.#durable.transact<RuntimeDurableStateTransactionResultV1<TransientTaskOutcomePayloadPutResultV1>>(
			TRANSIENT_NAMESPACE,
			transientKey(key),
			currentInput => {
				const state = transientRuntimeState(key, currentInput);
				const observedAt = this.#now();
				if (
					!this.#activeAuthorityCurrent(state, request.ref, request.payloadDeleteId, request.authority, observedAt)
				)
					return { state, result: { status: "authority_conflict" } as const };
				const decoded = payloadRow(
					state.payloads[mapKey],
					state.authority?.effectIdentityManifest.payloadRetentionNamespaceId ?? null,
				);
				if (decoded.status === "invalid") return { state, result: { status: "invalid" } as const };
				let storedAt = observedAt;
				if (decoded.status === "present") {
					const row = decoded.row;
					const exactPut =
						(row.state === "available" || row.state === "deleted") &&
						row.putReceipt.requestSha256 === request.requestSha256 &&
						exactJson(row.putReceipt.ref, request.ref) &&
						row.putReceipt.payloadDeleteId === request.payloadDeleteId;
					if (exactPut) return { state, result: { status: "already_stored", receipt: row.putReceipt } as const };
					if (
						(row.state !== "put_not_applied" && row.state !== "put_outcome_unknown") ||
						row.request.requestSha256 !== request.requestSha256 ||
						!exactJson(row.request, request)
					)
						return { state, result: { status: "same_id_different_payload" } as const };
					storedAt = row.openedAt;
				}
				const lifetime: Extract<TransientTaskOutcomePayloadLifetimeV1, { phase: "active_task" }> = {
					phase: "active_task",
					renewBy: renewalDeadline(storedAt, request.retentionMs),
					expiresAt: addMilliseconds(storedAt, request.retentionMs),
					recoveryAuthoritySha256: null,
					recoveryStartedAt: null,
					maxExpiresAt: null,
				};
				const receipt = payloadPutReceiptFromRequest(request, lifetime, storedAt);
				const available: PayloadAvailableRowV1 = {
					state: "available",
					ref: request.ref,
					payloadDeleteId: request.payloadDeleteId,
					revision: 1,
					currentReceiptSha256: receipt.receiptSha256,
					putReceipt: receipt,
					renewalHistory: [],
					latestRetentionReceipt: null,
					lifetime,
				};
				return {
					state: {
						...state,
						payloads: { ...state.payloads, [mapKey]: { ...available, bytesBase64: request.bytesBase64 } },
					},
					result: { status: "stored", receipt } as const,
				};
			},
		);
	}

	async inspect(request: Parameters<TransientTaskOutcomePayloadStoreV1["inspect"]>[0]) {
		if (
			!strictRecord(request, ["ref", "operation", "operationId", "requestSha256"]) ||
			!validPayloadRef(request.ref) ||
			!isOneOf(request.operation, ["put", "renewal", "delete"]) ||
			!isWellFormedString(request.operationId) ||
			!isSha256Hex(request.requestSha256)
		)
			return { status: "invalid" } as const;
		const key = { taskId: request.ref.taskId, runId: request.ref.runId };
		const state = transientRuntimeState(key, await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(key)));
		const decoded = payloadRow(
			state.payloads[payloadStoreKey(request.ref)],
			state.authority?.effectIdentityManifest.payloadRetentionNamespaceId ?? null,
		);
		if (decoded.status === "absent") return { status: "absent", payloadId: request.ref.payloadId } as const;
		if (decoded.status === "invalid") return { status: "invalid" } as const;
		const row = decoded.row;
		const storedRef = isPayloadAttempt(row) ? row.request.ref : row.ref;
		if (!exactJson(storedRef, request.ref)) return { status: "conflict" } as const;
		if (isPayloadAttempt(row)) {
			const operation =
				row.state === "put_not_applied" || row.state === "put_outcome_unknown"
					? "put"
					: row.state === "renewal_not_applied" || row.state === "renewal_outcome_unknown"
						? "renewal"
						: "delete";
			const operationId =
				row.state === "put_not_applied" || row.state === "put_outcome_unknown"
					? row.request.ref.payloadId
					: row.state === "renewal_not_applied" || row.state === "renewal_outcome_unknown"
						? row.request.retentionRenewalId
						: row.request.payloadDeleteId;
			return operation === request.operation &&
				operationId === request.operationId &&
				row.request.requestSha256 === request.requestSha256
				? ({ status: "not_applied", operation, operationId, requestSha256: request.requestSha256 } as const)
				: ({ status: "conflict" } as const);
		}
		if (request.operation === "put") {
			if (request.operationId !== request.ref.payloadId || row.putReceipt.requestSha256 !== request.requestSha256)
				return { status: "conflict" } as const;
		} else if (request.operation === "renewal") {
			const receipt = row.renewalHistory.find(
				entry =>
					entry.receipt.retentionRenewalId === request.operationId &&
					entry.receipt.requestSha256 === request.requestSha256,
			)?.receipt;
			if (!receipt) return { status: "conflict" } as const;
		} else {
			if (
				row.state !== "deleted" ||
				row.payloadDeleteId !== request.operationId ||
				row.deleteReceipt.requestSha256 !== request.requestSha256
			)
				return { status: "conflict" } as const;
		}
		return row.state === "available"
			? ({ status: "matching", state: payloadInspection(row) } as const)
			: ({
					status: "matching",
					state: {
						state: "deleted",
						ref: row.ref,
						payloadDeleteId: row.payloadDeleteId,
						putReceiptSha256: row.putReceipt.receiptSha256,
						latestRetentionReceiptSha256: row.latestRetentionReceipt?.receiptSha256 ?? null,
						deleteReceiptSha256: row.deleteReceipt.receiptSha256,
					},
				} as const);
	}

	async adopt(request: Parameters<TransientTaskOutcomePayloadStoreV1["adopt"]>[0]) {
		if (
			!strictRecord(request, ["ref", "operation", "requestSha256", "authority"]) ||
			!validPayloadRef(request.ref) ||
			!isOneOf(request.operation, ["put", "renewal", "delete"]) ||
			!isSha256Hex(request.requestSha256)
		)
			return { status: "invalid" } as const;
		if (request.operation === "delete") {
			if (!validPayloadDeleteAuthority(request.authority)) return { status: "invalid" } as const;
		} else {
			if (!validPayloadRetentionAuthority(request.authority)) return { status: "invalid" } as const;
			if (
				request.operation === "put" &&
				(request.authority.phase !== "active_task" ||
					(request.ref.payloadRole === "pending"
						? request.authority.payloadRole !== "pending" || request.authority.kind !== "controller"
						: request.authority.payloadRole !== "composed" || request.authority.kind !== "terminal"))
			)
				return { status: "invalid" } as const;
		}
		const key = { taskId: request.ref.taskId, runId: request.ref.runId };
		if (
			request.operation === "delete"
				? !(await this.#deleteExternallyAuthorized(
						request.ref,
						request.authority.recoveryAuthority?.payloadDeleteId ?? "",
						request.authority,
					))
				: !(await this.#authorized(
						request.ref,
						request.authority.phase === "active_task"
							? request.authority.payloadDeleteId
							: request.authority.recoveryAuthority.payloadDeleteId,
						request.authority,
					))
		)
			return { status: "authority_conflict" } as const;
		const state = transientRuntimeState(key, await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(key)));
		const requestedDeleteId =
			request.operation === "delete"
				? request.authority.reason === "expired"
					? request.authority.recoveryAuthority.payloadDeleteId
					: state.authority && request.ref.payloadRole === "pending"
						? state.authority.pendingPayloadDeleteId
						: state.authority?.composedPayloadDeleteId
				: request.authority.phase === "active_task"
					? request.authority.payloadDeleteId
					: request.authority.recoveryAuthority.payloadDeleteId;
		if (!requestedDeleteId || !this.#fixedPayloadIdentity(state, request.ref, requestedDeleteId))
			return { status: "authority_conflict" } as const;
		if (request.operation === "put" || request.operation === "renewal") {
			if (
				!(await this.#retentionAuthorityCurrent(
					state,
					request.ref,
					requestedDeleteId,
					request.authority,
					this.#now(),
				))
			)
				return { status: "authority_conflict" } as const;
		} else if (request.authority.reason === "expired") {
			const recoveryAuthority: Extract<
				TransientTaskOutcomePayloadRetentionAuthorityV1,
				{ phase: "recovery_retention" }
			> = {
				phase: "recovery_retention",
				recoveryAuthority: request.authority.recoveryAuthority,
				recoveryAuthoritySha256: request.authority.recoveryAuthoritySha256,
			};
			if (!(await this.#recoveryAuthorityCurrent(state, request.ref, requestedDeleteId, recoveryAuthority)))
				return { status: "authority_conflict" } as const;
		} else if (
			!(await this.#publishedDeleteAuthorized(state, request.ref, requestedDeleteId, request.authority, null))
		) {
			return { status: "authority_conflict" } as const;
		}
		const decoded = payloadRow(
			state.payloads[payloadStoreKey(request.ref)],
			state.authority?.effectIdentityManifest.payloadRetentionNamespaceId ?? null,
		);
		if (decoded.status === "absent") return { status: "absent" } as const;
		if (decoded.status === "invalid") return { status: "invalid" } as const;
		const row = decoded.row;
		const storedRef = isPayloadAttempt(row) ? row.request.ref : row.ref;
		if (!exactJson(storedRef, request.ref)) return { status: "conflict" } as const;
		if (isPayloadAttempt(row)) {
			if (row.request.requestSha256 !== request.requestSha256) return { status: "conflict" } as const;
			if (request.operation === "delete") {
				if (row.state !== "delete_not_applied" && row.state !== "delete_outcome_unknown")
					return { status: "conflict" } as const;
				return exactJson(request.authority, {
					reason: row.request.reason,
					publicationReceiptSha256: row.request.publicationReceiptSha256,
					foregroundSettlementCompletionEvidenceSha256: row.request.foregroundSettlementCompletionEvidenceSha256,
					recoveryAuthority: row.request.recoveryAuthority,
					recoveryAuthoritySha256: row.request.recoveryAuthoritySha256,
					recoveryLifetime: row.request.recoveryLifetime,
					observedAt: row.request.observedAt,
				})
					? ({ status: "attempt", attempt: payloadAttemptProjection(row) } as const)
					: ({ status: "authority_conflict" } as const);
			}
			if (request.operation === "put") {
				if (row.state !== "put_not_applied" && row.state !== "put_outcome_unknown")
					return { status: "conflict" } as const;
				return exactJson(request.authority, row.request.authority)
					? ({ status: "attempt", attempt: payloadAttemptProjection(row) } as const)
					: ({ status: "authority_conflict" } as const);
			}
			if (row.state !== "renewal_not_applied" && row.state !== "renewal_outcome_unknown")
				return { status: "conflict" } as const;
			return exactJson(request.authority, row.request.authority)
				? ({ status: "attempt", attempt: payloadAttemptProjection(row) } as const)
				: ({ status: "authority_conflict" } as const);
		}
		if (request.operation === "put") {
			return row.putReceipt.requestSha256 === request.requestSha256 &&
				exactJson(row.putReceipt.authority, request.authority)
				? ({ status: "receipt", operation: "put", receipt: row.putReceipt } as const)
				: ({ status: "conflict" } as const);
		}
		if (request.operation === "renewal") {
			const receipt = row.renewalHistory.find(
				entry => entry.receipt.requestSha256 === request.requestSha256,
			)?.receipt;
			return receipt !== undefined && exactJson(receipt.authority, request.authority)
				? ({ status: "receipt", operation: "renewal", receipt } as const)
				: ({ status: "conflict" } as const);
		}
		if (row.state !== "deleted" || row.deleteReceipt.requestSha256 !== request.requestSha256)
			return { status: "conflict" } as const;
		const receiptAuthority: TransientTaskOutcomePayloadDeleteAuthorityV1 =
			row.deleteReceipt.reason === "published"
				? {
						reason: "published",
						publicationReceiptSha256: row.deleteReceipt.publicationReceiptSha256,
						foregroundSettlementCompletionEvidenceSha256:
							row.deleteReceipt.foregroundSettlementCompletionEvidenceSha256,
						recoveryAuthority: null,
						recoveryAuthoritySha256: null,
						recoveryLifetime: null,
						observedAt: null,
					}
				: {
						reason: "expired",
						publicationReceiptSha256: null,
						foregroundSettlementCompletionEvidenceSha256: null,
						recoveryAuthority: row.deleteReceipt.recoveryAuthority,
						recoveryAuthoritySha256: row.deleteReceipt.recoveryAuthoritySha256,
						recoveryLifetime: row.deleteReceipt.recoveryLifetime,
						observedAt: row.deleteReceipt.observedAt,
					};
		return exactJson(receiptAuthority, request.authority)
			? ({ status: "receipt", operation: "delete", receipt: row.deleteReceipt } as const)
			: ({ status: "authority_conflict" } as const);
	}

	async fetch(request: Parameters<TransientTaskOutcomePayloadStoreV1["fetch"]>[0]) {
		if (
			!strictRecord(request, [
				"ref",
				"payloadDeleteId",
				"expectedRevision",
				"expectedCurrentReceiptSha256",
				"authority",
			]) ||
			!validPayloadRef(request.ref) ||
			!isWellFormedString(request.payloadDeleteId) ||
			!isSafeCount(request.expectedRevision, 1) ||
			!isSha256Ref(request.expectedCurrentReceiptSha256) ||
			!validPayloadRetentionAuthority(request.authority) ||
			!payloadAuthorityMatchesRef(request.ref, request.payloadDeleteId, request.authority)
		)
			return { status: "invalid" } as const;
		if (!(await this.#authorized(request.ref, request.payloadDeleteId, request.authority)))
			return { status: "authority_conflict" } as const;
		const key = { taskId: request.ref.taskId, runId: request.ref.runId };
		const state = transientRuntimeState(key, await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(key)));
		const observedAt = this.#now();
		if (
			!(await this.#retentionAuthorityCurrent(
				state,
				request.ref,
				request.payloadDeleteId,
				request.authority,
				observedAt,
			))
		)
			return { status: "authority_conflict" } as const;
		const decoded = payloadRow(
			state.payloads[payloadStoreKey(request.ref)],
			state.authority?.effectIdentityManifest.payloadRetentionNamespaceId ?? null,
		);
		if (decoded.status === "absent") return { status: "absent" } as const;
		if (decoded.status === "invalid") return { status: "invalid" } as const;
		const row = decoded.row;
		if (isPayloadAttempt(row)) return { status: "outcome_unknown" } as const;
		if (!exactJson(row.ref, request.ref) || row.payloadDeleteId !== request.payloadDeleteId)
			return { status: "conflict" } as const;
		if (row.state === "deleted") return { status: "deleted" } as const;
		if (
			row.revision !== request.expectedRevision ||
			row.currentReceiptSha256 !== request.expectedCurrentReceiptSha256
		)
			return { status: "conflict" } as const;
		if (row.lifetime.phase === "recovery_retention" && Date.parse(observedAt) >= Date.parse(row.lifetime.expiresAt)) {
			return {
				status: "recovery_expired",
				recoveryAuthoritySha256: row.lifetime.recoveryAuthoritySha256,
				lifetime: row.lifetime,
				observedAt,
			} as const;
		}
		if (decoded.bytesBase64 === null) return { status: "invalid" } as const;
		return { status: "found", ref: row.ref, bytesBase64: decoded.bytesBase64 } as const;
	}

	async renewRetention(
		request: TransientTaskOutcomePayloadRetentionRequestV1,
	): Promise<TransientTaskOutcomePayloadRetentionResultV1> {
		if (!proxyFreeData(request)) return { status: "invalid" } as const;
		if (!validPayloadTtl(request?.retentionMs)) return { status: "retention_invalid" } as const;
		if (!validPayloadRetentionRequest(request)) return { status: "invalid" } as const;
		if (!(await this.#authorized(request.ref, request.payloadDeleteId, request.authority)))
			return { status: "authority_conflict" } as const;
		const key = { taskId: request.ref.taskId, runId: request.ref.runId };
		const mapKey = payloadStoreKey(request.ref);
		return this.#durable.transact<
			RuntimeDurableStateTransactionResultV1<TransientTaskOutcomePayloadRetentionResultV1>
		>(TRANSIENT_NAMESPACE, transientKey(key), async currentInput => {
			const state = transientRuntimeState(key, currentInput);
			const observedAt = this.#now();
			if (
				!(await this.#retentionAuthorityCurrent(
					state,
					request.ref,
					request.payloadDeleteId,
					request.authority,
					observedAt,
				))
			)
				return { state, result: { status: "authority_conflict" } as const };
			const current = state.authority;
			if (
				!current ||
				request.retentionRenewalId !==
					derivedPayloadRetentionId(
						current.effectIdentityManifest.payloadRetentionNamespaceId,
						request.ref.payloadRole,
						request.expectedRevision,
					)
			)
				return { state, result: { status: "invalid" } as const };
			const decoded = payloadRow(
				state.payloads[mapKey],
				state.authority?.effectIdentityManifest.payloadRetentionNamespaceId ?? null,
			);
			if (decoded.status === "absent") return { state, result: { status: "absent" } as const };
			if (decoded.status === "invalid") return { state, result: { status: "invalid" } as const };
			let prior: PayloadAvailableRowV1;
			let bytesBase64: string | null;
			let renewedAt = observedAt;
			const row = decoded.row;
			if (row.state === "renewal_not_applied" || row.state === "renewal_outcome_unknown") {
				if (
					row.request.retentionRenewalId === request.retentionRenewalId &&
					row.request.requestSha256 !== request.requestSha256
				)
					return { state, result: { status: "same_id_different_retention" } as const };
				if (row.request.requestSha256 !== request.requestSha256 || !exactJson(row.request, request))
					return { state, result: { status: "renewal_outcome_unknown" } as const };
				prior = row.prior;
				bytesBase64 = decoded.bytesBase64;
				renewedAt = row.openedAt;
			} else {
				const existing = row.renewalHistory.find(
					entry => entry.receipt.retentionRenewalId === request.retentionRenewalId,
				)?.receipt;
				if (existing) {
					return existing.requestSha256 === request.requestSha256 &&
						exactJson(existing.authority, request.authority)
						? { state, result: { status: "already_renewed", receipt: existing } as const }
						: { state, result: { status: "same_id_different_retention" } as const };
				}
				if (row.state === "deleted") return { state, result: { status: "deleted" } as const };
				if (row.state !== "available") return { state, result: { status: "renewal_outcome_unknown" } as const };
				prior = row;
				bytesBase64 = decoded.bytesBase64;
			}
			if (!exactJson(prior.ref, request.ref) || prior.payloadDeleteId !== request.payloadDeleteId)
				return { state, result: { status: "conflict" } as const };
			if (
				prior.revision !== request.expectedRevision ||
				prior.currentReceiptSha256 !== request.expectedCurrentReceiptSha256 ||
				!exactJson(prior.lifetime, request.expectedLifetime)
			)
				return { state, result: { status: "conflict" } as const };
			if (
				prior.lifetime.phase === "recovery_retention" &&
				Date.parse(observedAt) >= Date.parse(prior.lifetime.expiresAt)
			) {
				return {
					state,
					result: {
						status: "recovery_expired",
						recoveryAuthoritySha256: prior.lifetime.recoveryAuthoritySha256,
						lifetime: prior.lifetime,
						observedAt,
					} as const,
				};
			}
			if (request.authority.phase === "recovery_retention") {
				const maxExpiresAt =
					prior.lifetime.phase === "recovery_retention"
						? prior.lifetime.maxExpiresAt
						: addMilliseconds(renewedAt, TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MAX_V1);
				if (Date.parse(addMilliseconds(renewedAt, request.retentionMs)) > Date.parse(maxExpiresAt))
					return { state, result: { status: "retention_invalid" } as const };
			} else if (prior.lifetime.phase !== "active_task") {
				return { state, result: { status: "lifetime_transition_invalid" } as const };
			}
			if (bytesBase64 === null) return { state, result: { status: "invalid" } as const };
			const attempt = { request, openedAt: renewedAt };
			const receipt = payloadRetentionReceiptFromAttempt(
				{
					ref: prior.ref,
					payloadDeleteId: prior.payloadDeleteId,
					revision: prior.revision,
					receiptSha256: prior.currentReceiptSha256,
					lifetime: prior.lifetime,
				},
				attempt,
			);
			if (receipt === null) return { state, result: { status: "invalid" } as const };
			const available: PayloadAvailableRowV1 = {
				...prior,
				revision: receipt.revision,
				currentReceiptSha256: receipt.receiptSha256,
				renewalHistory: [...prior.renewalHistory, { attempt, receipt }],
				latestRetentionReceipt: receipt,
				lifetime: receipt.lifetime,
			};
			return {
				state: {
					...state,
					payloads: { ...state.payloads, [mapKey]: { ...available, bytesBase64 } },
				},
				result: { status: "renewed", receipt } as const,
			};
		});
	}

	async delete(
		request: TransientTaskOutcomePayloadDeleteRequestV1,
	): Promise<TransientTaskOutcomePayloadDeleteResultV1> {
		if (!validPayloadDeleteRequest(request)) return { status: "invalid" } as const;
		if (!(await this.#deleteExternallyAuthorized(request.ref, request.payloadDeleteId, request)))
			return { status: "authority_conflict" } as const;
		const key = { taskId: request.ref.taskId, runId: request.ref.runId };
		const mapKey = payloadStoreKey(request.ref);
		return this.#durable.transact<RuntimeDurableStateTransactionResultV1<TransientTaskOutcomePayloadDeleteResultV1>>(
			TRANSIENT_NAMESPACE,
			transientKey(key),
			async currentInput => {
				const state = transientRuntimeState(key, currentInput);
				if (request.reason === "published") {
					if (!(await this.#publishedDeleteAuthorized(state, request.ref, request.payloadDeleteId, request, null)))
						return { state, result: { status: "publication_authority_required" } as const };
				} else {
					const recoveryAuthority: Extract<
						TransientTaskOutcomePayloadRetentionAuthorityV1,
						{ phase: "recovery_retention" }
					> = {
						phase: "recovery_retention",
						recoveryAuthority: request.recoveryAuthority,
						recoveryAuthoritySha256: request.recoveryAuthoritySha256,
					};
					if (
						!(await this.#recoveryAuthorityCurrent(
							state,
							request.ref,
							request.payloadDeleteId,
							recoveryAuthority,
						))
					)
						return { state, result: { status: "recovery_authority_required" } as const };
				}
				const decoded = payloadRow(
					state.payloads[mapKey],
					state.authority?.effectIdentityManifest.payloadRetentionNamespaceId ?? null,
				);
				if (decoded.status === "absent") return { state, result: { status: "absent" } as const };
				if (decoded.status === "invalid") return { state, result: { status: "invalid" } as const };
				const row = decoded.row;
				let prior: PayloadAvailableRowV1;
				let deletedAt = this.#now();
				if (row.state === "delete_not_applied" || row.state === "delete_outcome_unknown") {
					if (row.request.requestSha256 !== request.requestSha256 || !exactJson(row.request, request))
						return { state, result: { status: "same_id_different_delete" } as const };
					prior = row.prior;
					deletedAt = row.openedAt;
				} else if (row.state === "deleted") {
					if (row.deleteReceipt.requestSha256 !== request.requestSha256)
						return { state, result: { status: "same_id_different_delete" } as const };
					const authorization = await this.#deleteAuthorityCurrent(
						state,
						request.ref,
						request.payloadDeleteId,
						row.putReceipt.receiptSha256,
						row.deleteReceipt.previousLifetime,
						row.latestRetentionReceipt,
						request,
						this.#now(),
					);
					return authorization === "authorized"
						? { state, result: { status: "already_deleted", receipt: row.deleteReceipt } as const }
						: { state, result: { status: authorization } as const };
				} else {
					if (row.state !== "available") return { state, result: { status: "delete_outcome_unknown" } as const };
					prior = row;
				}
				if (!exactJson(prior.ref, request.ref) || prior.payloadDeleteId !== request.payloadDeleteId)
					return { state, result: { status: "conflict" } as const };
				if (
					prior.revision !== request.expectedRevision ||
					prior.currentReceiptSha256 !== request.expectedCurrentReceiptSha256 ||
					!exactJson(prior.lifetime, request.expectedLifetime)
				)
					return { state, result: { status: "conflict" } as const };
				const authorization = await this.#deleteAuthorityCurrent(
					state,
					request.ref,
					request.payloadDeleteId,
					prior.putReceipt.receiptSha256,
					prior.lifetime,
					prior.latestRetentionReceipt,
					request,
					this.#now(),
				);
				if (authorization !== "authorized") return { state, result: { status: authorization } as const };
				const receipt: TransientTaskOutcomePayloadDeleteReceiptV1 = {
					schemaVersion: 1,
					taskId: request.ref.taskId,
					runId: request.ref.runId,
					ref: request.ref,
					payloadDeleteId: request.payloadDeleteId,
					previousRevision: prior.revision,
					revision: prior.revision + 1,
					previousReceiptSha256: prior.currentReceiptSha256,
					previousLifetime: prior.lifetime,
					...(request.reason === "published"
						? {
								reason: "published" as const,
								publicationReceiptSha256: request.publicationReceiptSha256,
								foregroundSettlementCompletionEvidenceSha256:
									request.foregroundSettlementCompletionEvidenceSha256,
								recoveryAuthority: null,
								recoveryAuthoritySha256: null,
								recoveryLifetime: null,
								observedAt: null,
							}
						: {
								reason: "expired" as const,
								publicationReceiptSha256: null,
								foregroundSettlementCompletionEvidenceSha256: null,
								recoveryAuthority: request.recoveryAuthority,
								recoveryAuthoritySha256: request.recoveryAuthoritySha256,
								recoveryLifetime: request.recoveryLifetime,
								observedAt: request.observedAt,
							}),
					deletedAt,
					requestSha256: request.requestSha256,
					receiptSha256: payloadTupleRef([
						"omp-transient-task-outcome-payload-v1",
						"delete_receipt",
						1,
						payloadRefTuple(request.ref),
						request.payloadDeleteId,
						prior.revision,
						prior.revision + 1,
						prior.currentReceiptSha256,
						payloadLifetimeTuple(prior.lifetime),
						payloadDeleteAuthorityTuple(request),
						deletedAt,
						request.requestSha256,
					]),
				};
				const deleted: PayloadDeletedRowV1 = {
					state: "deleted",
					ref: request.ref,
					payloadDeleteId: request.payloadDeleteId,
					putReceipt: prior.putReceipt,
					renewalHistory: prior.renewalHistory,
					latestRetentionReceipt: prior.latestRetentionReceipt,
					deleteReceipt: receipt,
				};
				return {
					state: { ...state, payloads: { ...state.payloads, [mapKey]: deleted } },
					result: { status: "deleted", receipt } as const,
				};
			},
		);
	}
}
