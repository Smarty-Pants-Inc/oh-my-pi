import type { ISO8601 } from "../registry/persistent-agent-contracts.js";
import type { RuntimeDurableStateStoreV1 } from "./managed-workspace.js";
import type { PrivateResultTargetRowV1, RuntimeTransientAuthorityV1 } from "./workspace-controller-codecs.js";
import {
	exactJson,
	nowIso,
	publicationMapKey,
	publicationState,
	resultTargetBindingReceiptFromAttempt,
	resultTargetCleanupReceiptFromAttempt,
	resultTargetExpiredCleanupDue,
	resultTargetKeyFromRecord,
	resultTargetKeyTuple,
	resultTargetLifecycleKeyMatches,
	resultTargetLifecycleMatches,
	resultTargetMapKey,
	resultTargetRenewalReceiptFromAttempt,
	resultTargetRouteTuple,
	resultTargetRow,
	strictRecord,
	TRANSIENT_NAMESPACE,
	transientKey,
	transientRuntimeState,
	tupleRef,
	validPublicationReceipt,
	validResultStoreSha256Hex,
	validResultStoreSha256Ref,
	validResultTargetAuthority,
	validResultTargetBindRequest,
	validResultTargetCleanupInspectRequest,
	validResultTargetCleanupRequest,
	validResultTargetKey,
	validResultTargetRenewInspectRequest,
	validResultTargetRenewRequest,
} from "./workspace-controller-codecs.js";
import type {
	ConfidentialTransientTaskResultPublicationTargetAuthorityV1,
	ConfidentialTransientTaskResultPublicationTargetBindingAttemptV1,
	ConfidentialTransientTaskResultPublicationTargetCleanupAttemptV1,
	ConfidentialTransientTaskResultPublicationTargetRenewalAttemptV1,
	TransientTaskResultPublicationTargetBindingReceiptV1,
	TransientTaskResultPublicationTargetKeyV1,
	TransientTaskResultPublicationTargetRenewalReceiptV1,
	TransientTaskResultPublicationTargetStoreV1,
} from "./workspace-runtime-contracts.js";
import {
	TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MAX_V1,
	TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MIN_V1,
} from "./workspace-runtime-contracts.js";

export class DurableTransientTaskResultPublicationTargetStoreV1 implements TransientTaskResultPublicationTargetStoreV1 {
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

	async #authorized(
		key: TransientTaskResultPublicationTargetKeyV1,
		authority: ConfidentialTransientTaskResultPublicationTargetAuthorityV1,
	): Promise<boolean> {
		if (!validResultTargetKey(key) || !validResultTargetAuthority(authority)) return false;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const state = transientRuntimeState(
			taskKey,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
		);
		if (!resultTargetLifecycleMatches(state, key, authority)) return false;
		if (authority.kind === "controller")
			return (await this.#authority.authorizeController(authority.proof)) === "current";
		if (authority.kind === "cleanup") return this.#authority.authorizeCleanup(authority.proof);
		return this.#authority.authorizeTerminal({
			key,
			terminalEvidenceId: authority.terminalEvidenceId,
			terminalEvidenceSha256: authority.terminalEvidenceSha256,
		});
	}
	async bind(request: Parameters<TransientTaskResultPublicationTargetStoreV1["bind"]>[0]) {
		if (!strictRecord(request, ["binding", "ttlMs", "authority", "requestSha256"]))
			return { status: "invalid" } as const;
		if (!Number.isSafeInteger(request.ttlMs) || request.ttlMs <= 0) return { status: "retention_invalid" } as const;
		if (!(await validResultTargetBindRequest(request))) return { status: "invalid" } as const;
		const key = resultTargetKeyFromRecord(request.binding as unknown as Record<string, unknown>);
		if (key === null) return { status: "invalid" } as const;
		if (!(await this.#authorized(key, request.authority))) return { status: "controller_lost" } as const;
		const expectedBindingSha256 = await tupleRef([
			"omp-transient-task-result-target-v1",
			"binding",
			1,
			resultTargetKeyTuple(key),
			resultTargetRouteTuple(request.binding),
		]);
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const mapKey = resultTargetMapKey(key);
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			if (!resultTargetLifecycleMatches(state, key, request.authority))
				return { state, result: { status: "controller_lost" } as const };
			const prior = await resultTargetRow(state.resultTargets[mapKey]);
			if (prior) {
				if (
					prior.bindingSha256 !== expectedBindingSha256 ||
					prior.bindRequestSha256 !== request.requestSha256 ||
					!exactJson(prior.binding, request.binding)
				)
					return { state, result: { status: "same_id_different_binding" } as const };
				if (prior.state.state === "bound")
					return { state, result: { status: "already_bound", receipt: prior.state.bindReceipt } as const };
				if (prior.state.state !== "binding_not_applied" && prior.state.state !== "binding_outcome_unknown")
					return { state, result: { status: "same_id_different_binding" } as const };
			}
			const attempt: ConfidentialTransientTaskResultPublicationTargetBindingAttemptV1 = prior?.bindingAttempt ?? {
				request,
				openedAt: this.#now(),
			};
			const receipt = await resultTargetBindingReceiptFromAttempt(key, expectedBindingSha256, attempt);
			const row: PrivateResultTargetRowV1 = {
				binding: request.binding,
				bindingSha256: expectedBindingSha256,
				bindRequestSha256: request.requestSha256,
				state: { state: "bound", bindReceipt: receipt, liveReceipt: receipt },
				bindingAttempt: attempt,
				renewalHistory: [],
				renewalAttempt: null,
				cleanupAttempt: null,
			};
			return {
				state: { ...state, resultTargets: { ...state.resultTargets, [mapKey]: row } },
				result: { status: "bound", receipt } as const,
			};
		});
	}

	async inspect(request: Parameters<TransientTaskResultPublicationTargetStoreV1["inspect"]>[0]) {
		const key = resultTargetKeyFromRecord(request as unknown as Record<string, unknown>);
		if (
			!key ||
			!validResultStoreSha256Ref(request.expectedBindingSha256) ||
			!validResultStoreSha256Hex(request.expectedBindRequestSha256)
		)
			return { status: "conflict" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		try {
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			if (!resultTargetLifecycleKeyMatches(state, key)) return { status: "conflict" } as const;
			const row = await resultTargetRow(state.resultTargets[resultTargetMapKey(key)]);
			if (!row)
				return {
					status: "absent",
					resultPublicationTargetId: key.resultPublicationTargetId,
					resultPublicationTargetCleanupId: key.resultPublicationTargetCleanupId,
				} as const;
			if (
				row.bindingSha256 !== request.expectedBindingSha256 ||
				row.bindRequestSha256 !== request.expectedBindRequestSha256
			)
				return { status: "conflict" } as const;
			return { status: "matching", state: row.state } as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async adoptBinding(request: Parameters<TransientTaskResultPublicationTargetStoreV1["adoptBinding"]>[0]) {
		const key = resultTargetKeyFromRecord(request);
		if (
			!key ||
			!validResultTargetAuthority(request.authority) ||
			request.authority.kind !== "controller" ||
			!validResultStoreSha256Ref(request.expectedBindingSha256) ||
			!validResultStoreSha256Hex(request.expectedBindRequestSha256)
		)
			return { status: "conflict" } as const;
		if (!(await this.#authorized(key, request.authority))) return { status: "controller_lost" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const mapKey = resultTargetMapKey(key);
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			if (!resultTargetLifecycleMatches(state, key, request.authority))
				return { state, result: { status: "controller_lost" } as const };
			const row = await resultTargetRow(state.resultTargets[mapKey]);
			if (!row?.bindingAttempt) return { state, result: { status: "absent" } as const };
			if (
				row.bindingSha256 !== request.expectedBindingSha256 ||
				row.bindRequestSha256 !== request.expectedBindRequestSha256
			)
				return { state, result: { status: "conflict" } as const };
			if (row.state.state === "bound")
				return {
					state,
					result: { status: "adopted", attempt: row.bindingAttempt, receipt: row.state.bindReceipt } as const,
				};
			if (row.state.state !== "binding_not_applied" && row.state.state !== "binding_outcome_unknown")
				return { state, result: { status: "conflict" } as const };
			const receipt = await resultTargetBindingReceiptFromAttempt(key, row.bindingSha256, row.bindingAttempt);
			const next: PrivateResultTargetRowV1 = {
				...row,
				state: { state: "bound", bindReceipt: receipt, liveReceipt: receipt },
			};
			return {
				state: { ...state, resultTargets: { ...state.resultTargets, [mapKey]: next } },
				result: { status: "adopted", attempt: row.bindingAttempt, receipt } as const,
			};
		});
	}

	async resolve(request: Parameters<TransientTaskResultPublicationTargetStoreV1["resolve"]>[0]) {
		const key = resultTargetKeyFromRecord(request as unknown as Record<string, unknown>);
		if (!key || !(await this.#authorized(key, request.authority))) return { status: "authority_lost" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const state = transientRuntimeState(
			taskKey,
			await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
		);
		if (!resultTargetLifecycleMatches(state, key, request.authority)) return { status: "authority_lost" } as const;
		const row = await resultTargetRow(state.resultTargets[resultTargetMapKey(key)]);
		if (!row?.binding) return { status: "target_missing" } as const;
		if (
			row.bindingSha256 !== request.expectedBindingSha256 ||
			row.bindRequestSha256 !== request.expectedBindRequestSha256 ||
			row.state.state !== "bound"
		)
			return { status: "conflict" } as const;
		const live = row.state.liveReceipt;
		if (
			live.bindingRevision !== request.expectedBindingRevision ||
			live.renewalSequence !== request.expectedRenewalSequence ||
			live.receiptSha256 !== request.expectedLiveReceiptSha256
		)
			return { status: "stale_live_receipt" } as const;
		if (Date.parse(live.expiresAt) <= Date.parse(this.#now())) return { status: "expired" } as const;
		return {
			status: "resolved",
			binding: row.binding,
			bindReceipt: row.state.bindReceipt,
			liveReceipt: live,
		} as const;
	}
	async renew(request: Parameters<TransientTaskResultPublicationTargetStoreV1["renew"]>[0]) {
		if (
			!strictRecord(request, [
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
			return { status: "invalid" } as const;
		if (!Number.isSafeInteger(request.ttlMs) || request.ttlMs <= 0) return { status: "retention_invalid" } as const;
		if (!(await validResultTargetRenewRequest(request))) return { status: "invalid" } as const;
		const key = resultTargetKeyFromRecord(request);
		if (!key || !(await this.#authorized(key, request.authority))) return { status: "authority_lost" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const mapKey = resultTargetMapKey(key);
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			if (!resultTargetLifecycleMatches(state, key, request.authority))
				return { state, result: { status: "authority_lost" } as const };
			const prior = await resultTargetRow(state.resultTargets[mapKey]);
			if (!prior?.binding) return { state, result: { status: "target_missing" } as const };
			const completed = prior.renewalHistory.find(entry => entry.attempt.request.renewalId === request.renewalId);
			if (completed)
				return exactJson(completed.attempt.request, request)
					? { state, result: { status: "already_renewed", receipt: completed.receipt } as const }
					: { state, result: { status: "same_id_different_renewal" } as const };
			let live:
				| TransientTaskResultPublicationTargetBindingReceiptV1
				| TransientTaskResultPublicationTargetRenewalReceiptV1;
			let bindReceipt: TransientTaskResultPublicationTargetBindingReceiptV1;
			let attempt: ConfidentialTransientTaskResultPublicationTargetRenewalAttemptV1;
			if (prior.state.state === "renewal_not_applied" || prior.state.state === "renewal_outcome_unknown") {
				if (
					!prior.renewalAttempt ||
					prior.renewalAttempt.request.renewalId !== request.renewalId ||
					prior.renewalAttempt.request.requestSha256 !== request.requestSha256 ||
					!exactJson(prior.renewalAttempt.request, request)
				)
					return { state, result: { status: "same_id_different_renewal" } as const };
				live = prior.renewalAttempt.previousLiveReceipt;
				bindReceipt = prior.state.bindReceipt;
				attempt = prior.renewalAttempt;
			} else {
				if (prior.state.state !== "bound") return { state, result: { status: "conflict" } as const };
				bindReceipt = prior.state.bindReceipt;
				live = prior.state.liveReceipt;
				if (
					live.bindingRevision !== request.expectedBindingRevision ||
					live.renewalSequence !== request.expectedRenewalSequence ||
					live.receiptSha256 !== request.expectedLiveReceiptSha256 ||
					live.expiresAt !== request.expectedExpiresAt
				)
					return { state, result: { status: "stale_live_receipt" } as const };
				const openedAt = this.#now();
				if (Date.parse(live.expiresAt) <= Date.parse(openedAt))
					return { state, result: { status: "expired" } as const };
				if (request.mode.kind === "active_task" && live.lifetime.phase !== "active_task")
					return { state, result: { status: "lifetime_transition_invalid" } as const };
				if (
					request.mode.kind === "freeze_recovery_retention" &&
					(request.mode.recoveryRetentionMs < TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MIN_V1 ||
						request.mode.recoveryRetentionMs > TRANSIENT_TASK_RESULT_RECOVERY_RETENTION_MS_MAX_V1)
				)
					return { state, result: { status: "retention_invalid" } as const };
				if (
					request.mode.kind === "recovery_retention" &&
					(live.lifetime.phase !== "recovery_retention" ||
						live.lifetime.recoveryAuthoritySha256 !== request.mode.recoveryAuthoritySha256)
				)
					return { state, result: { status: "lifetime_transition_invalid" } as const };
				attempt = { request, previousLiveReceipt: live, openedAt };
			}
			const receipt = await resultTargetRenewalReceiptFromAttempt(key, attempt);
			if (
				receipt.lifetime.phase === "recovery_retention" &&
				Date.parse(receipt.expiresAt) > Date.parse(receipt.lifetime.maxExpiresAt)
			)
				return { state, result: { status: "retention_invalid" } as const };
			const row: PrivateResultTargetRowV1 = {
				...prior,
				state: { state: "bound", bindReceipt, liveReceipt: receipt },
				renewalHistory: [...prior.renewalHistory, { attempt, receipt }],
				renewalAttempt: attempt,
			};
			return {
				state: { ...state, resultTargets: { ...state.resultTargets, [mapKey]: row } },
				result: { status: "renewed", receipt } as const,
			};
		});
	}

	async inspectRenewal(request: Parameters<TransientTaskResultPublicationTargetStoreV1["inspectRenewal"]>[0]) {
		if (!validResultTargetRenewInspectRequest(request, false)) return { status: "invalid" } as const;
		const key = resultTargetKeyFromRecord(request);
		if (key === null) return { status: "invalid" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		try {
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			if (!resultTargetLifecycleKeyMatches(state, key)) return { status: "conflict" } as const;
			const row = await resultTargetRow(state.resultTargets[resultTargetMapKey(key)]);
			if (!row) return { status: "absent", renewalId: request.renewalId } as const;
			if (
				row.bindingSha256 !== request.expectedBindingSha256 ||
				row.bindRequestSha256 !== request.expectedBindRequestSha256
			)
				return { status: "conflict" } as const;
			if (row.binding === null) return { status: "conflict" } as const;
			const completed = row.renewalHistory.find(entry => entry.attempt.request.renewalId === request.renewalId);
			if (completed)
				return completed.attempt.request.requestSha256 === request.requestSha256
					? ({ status: "matching", receipt: completed.receipt } as const)
					: ({ status: "conflict" } as const);
			if (row.state.state === "renewal_not_applied" || row.state.state === "renewal_outcome_unknown") {
				const attempt = row.renewalAttempt;
				if (
					attempt === null ||
					attempt.request.renewalId !== request.renewalId ||
					attempt.request.requestSha256 !== request.requestSha256
				)
					return { status: "conflict" } as const;
				return {
					status: row.state.state === "renewal_not_applied" ? "not_applied" : "outcome_unknown",
					renewalId: attempt.request.renewalId,
					requestSha256: attempt.request.requestSha256,
					previousLiveReceiptSha256: attempt.previousLiveReceipt.receiptSha256,
				} as const;
			}
			return { status: "conflict" } as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async adoptRenewal(request: Parameters<TransientTaskResultPublicationTargetStoreV1["adoptRenewal"]>[0]) {
		if (!validResultTargetRenewInspectRequest(request, true)) return { status: "invalid" } as const;
		const key = resultTargetKeyFromRecord(request);
		if (key === null) return { status: "invalid" } as const;
		if (!(await this.#authorized(key, request.authority))) return { status: "authority_lost" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const mapKey = resultTargetMapKey(key);
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			if (!resultTargetLifecycleMatches(state, key, request.authority))
				return { state, result: { status: "authority_lost" } as const };
			const row = await resultTargetRow(state.resultTargets[mapKey]);
			if (!row) return { state, result: { status: "absent" } as const };
			if (
				row.bindingSha256 !== request.expectedBindingSha256 ||
				row.bindRequestSha256 !== request.expectedBindRequestSha256
			)
				return { state, result: { status: "conflict" } as const };
			if (row.binding === null) return { state, result: { status: "conflict" } as const };
			const completed = row.renewalHistory.find(entry => entry.attempt.request.renewalId === request.renewalId);
			if (completed)
				return completed.attempt.request.requestSha256 === request.requestSha256
					? {
							state,
							result: { status: "adopted", attempt: completed.attempt, receipt: completed.receipt } as const,
						}
					: { state, result: { status: "conflict" } as const };
			if (!row.renewalAttempt) return { state, result: { status: "absent" } as const };
			const attempt = row.renewalAttempt;
			if (attempt.request.renewalId !== request.renewalId || attempt.request.requestSha256 !== request.requestSha256)
				return { state, result: { status: "conflict" } as const };
			if (row.state.state !== "renewal_not_applied" && row.state.state !== "renewal_outcome_unknown")
				return { state, result: { status: "conflict" } as const };
			const receipt = await resultTargetRenewalReceiptFromAttempt(key, attempt);
			if (
				receipt.lifetime.phase === "recovery_retention" &&
				Date.parse(receipt.expiresAt) > Date.parse(receipt.lifetime.maxExpiresAt)
			)
				return { state, result: { status: "conflict" } as const };
			const next: PrivateResultTargetRowV1 = {
				...row,
				state: { state: "bound", bindReceipt: row.state.bindReceipt, liveReceipt: receipt },
				renewalHistory: [...row.renewalHistory, { attempt, receipt }],
			};
			return {
				state: { ...state, resultTargets: { ...state.resultTargets, [mapKey]: next } },
				result: { status: "adopted", attempt, receipt } as const,
			};
		});
	}

	async cleanup(request: Parameters<TransientTaskResultPublicationTargetStoreV1["cleanup"]>[0]) {
		if (!(await validResultTargetCleanupRequest(request))) return { status: "invalid" } as const;
		const key = resultTargetKeyFromRecord(request as unknown as Record<string, unknown>);
		if (!key || !(await this.#authorized(key, request.authority))) return { status: "authority_lost" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const mapKey = resultTargetMapKey(key);
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			if (!resultTargetLifecycleMatches(state, key, request.authority))
				return { state, result: { status: "authority_lost" } as const };
			const prior = await resultTargetRow(state.resultTargets[mapKey]);
			if (!prior) return { state, result: { status: "target_missing" } as const };
			if (prior.state.state === "cleaned")
				return prior.cleanupAttempt?.request.requestSha256 === request.requestSha256
					? { state, result: { status: "already_cleaned", receipt: prior.state.receipt } as const }
					: { state, result: { status: "same_id_different_cleanup" } as const };
			let live:
				| TransientTaskResultPublicationTargetBindingReceiptV1
				| TransientTaskResultPublicationTargetRenewalReceiptV1;
			let attempt: ConfidentialTransientTaskResultPublicationTargetCleanupAttemptV1;
			if (prior.state.state === "cleanup_not_applied" || prior.state.state === "cleanup_outcome_unknown") {
				if (
					!prior.cleanupAttempt ||
					prior.cleanupAttempt.request.requestSha256 !== request.requestSha256 ||
					!exactJson(prior.cleanupAttempt.request, request)
				)
					return { state, result: { status: "same_id_different_cleanup" } as const };
				live = prior.cleanupAttempt.previousLiveReceipt;
				attempt = prior.cleanupAttempt;
			} else {
				if (prior.state.state !== "bound") return { state, result: { status: "conflict" } as const };
				live = prior.state.liveReceipt;
				if (
					live.bindingRevision !== request.expectedBindingRevision ||
					live.renewalSequence !== request.expectedRenewalSequence ||
					live.receiptSha256 !== request.expectedLiveReceiptSha256 ||
					live.expiresAt !== request.expectedExpiresAt
				)
					return { state, result: { status: "stale_live_receipt" } as const };
				attempt = { request, previousLiveReceipt: live, openedAt: this.#now() };
			}
			if (request.reason === "published") {
				const publication = await publicationState(state.publications[publicationMapKey(key)]);
				if (
					publication?.state !== "published" ||
					publication.publicationReceipt.receiptSha256 !== request.publicationReceiptSha256 ||
					!(await validPublicationReceipt(publication.publicationReceipt))
				)
					return { state, result: { status: "conflict" } as const };
			} else {
				if (live.lifetime.phase !== "recovery_retention")
					return { state, result: { status: "active_lifetime_not_cleanup_due" } as const };
				if (!resultTargetExpiredCleanupDue(attempt)) return { state, result: { status: "not_expired" } as const };
				if (request.recoveryAuthoritySha256 !== live.lifetime.recoveryAuthoritySha256)
					return { state, result: { status: "conflict" } as const };
			}
			const receipt = await resultTargetCleanupReceiptFromAttempt(key, attempt);
			const row: PrivateResultTargetRowV1 = {
				...prior,
				binding: null,
				state: { state: "cleaned", receipt },
				cleanupAttempt: attempt,
			};
			return {
				state: { ...state, resultTargets: { ...state.resultTargets, [mapKey]: row } },
				result: { status: "cleaned", receipt } as const,
			};
		});
	}

	async inspectCleanup(request: Parameters<TransientTaskResultPublicationTargetStoreV1["inspectCleanup"]>[0]) {
		if (!validResultTargetCleanupInspectRequest(request, false)) return { status: "invalid" } as const;
		const key = resultTargetKeyFromRecord(request);
		if (key === null) return { status: "invalid" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		try {
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			if (!resultTargetLifecycleKeyMatches(state, key)) return { status: "conflict" } as const;
			const row = await resultTargetRow(state.resultTargets[resultTargetMapKey(key)]);
			if (!row)
				return {
					status: "absent",
					resultPublicationTargetCleanupId: request.resultPublicationTargetCleanupId,
				} as const;
			if (
				row.bindingSha256 !== request.expectedBindingSha256 ||
				row.bindRequestSha256 !== request.expectedBindRequestSha256
			)
				return { status: "conflict" } as const;
			const attempt = row.cleanupAttempt;
			if (attempt === null || attempt.request.requestSha256 !== request.requestSha256)
				return { status: "conflict" } as const;
			if (row.state.state === "cleanup_not_applied" || row.state.state === "cleanup_outcome_unknown")
				return {
					status: row.state.state === "cleanup_not_applied" ? "not_applied" : "outcome_unknown",
					resultPublicationTargetCleanupId: attempt.request.resultPublicationTargetCleanupId,
					requestSha256: attempt.request.requestSha256,
					previousLiveReceiptSha256: attempt.previousLiveReceipt.receiptSha256,
				} as const;
			if (row.state.state === "cleaned") return { status: "matching", receipt: row.state.receipt } as const;
			return { status: "conflict" } as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async adoptCleanup(request: Parameters<TransientTaskResultPublicationTargetStoreV1["adoptCleanup"]>[0]) {
		if (!validResultTargetCleanupInspectRequest(request, true)) return { status: "invalid" } as const;
		const key = resultTargetKeyFromRecord(request);
		if (key === null) return { status: "invalid" } as const;
		if (!(await this.#authorized(key, request.authority))) return { status: "authority_lost" } as const;
		const taskKey = { taskId: key.taskId, runId: key.runId };
		const mapKey = resultTargetMapKey(key);
		return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
			const state = transientRuntimeState(taskKey, currentInput);
			if (!resultTargetLifecycleMatches(state, key, request.authority))
				return { state, result: { status: "authority_lost" } as const };
			const row = await resultTargetRow(state.resultTargets[mapKey]);
			if (!row?.cleanupAttempt) return { state, result: { status: "absent" } as const };
			if (
				row.bindingSha256 !== request.expectedBindingSha256 ||
				row.bindRequestSha256 !== request.expectedBindRequestSha256
			)
				return { state, result: { status: "conflict" } as const };
			const attempt = row.cleanupAttempt;
			if (attempt.request.requestSha256 !== request.requestSha256)
				return { state, result: { status: "conflict" } as const };
			if (row.state.state === "cleaned")
				return {
					state,
					result: { status: "adopted", attempt, receipt: row.state.receipt } as const,
				};
			if (row.state.state !== "cleanup_not_applied" && row.state.state !== "cleanup_outcome_unknown")
				return { state, result: { status: "conflict" } as const };
			const original = attempt.request;
			const live = attempt.previousLiveReceipt;
			if (original.reason === "published") {
				const publication = await publicationState(state.publications[publicationMapKey(key)]);
				if (
					publication?.state !== "published" ||
					publication.publicationReceipt.receiptSha256 !== original.publicationReceiptSha256 ||
					!(await validPublicationReceipt(publication.publicationReceipt))
				)
					return { state, result: { status: "conflict" } as const };
			} else if (
				live.lifetime.phase !== "recovery_retention" ||
				!resultTargetExpiredCleanupDue(attempt) ||
				original.recoveryAuthoritySha256 !== live.lifetime.recoveryAuthoritySha256
			) {
				return { state, result: { status: "conflict" } as const };
			}
			const receipt = await resultTargetCleanupReceiptFromAttempt(key, attempt);
			const next: PrivateResultTargetRowV1 = {
				...row,
				binding: null,
				state: { state: "cleaned", receipt },
			};
			return {
				state: { ...state, resultTargets: { ...state.resultTargets, [mapKey]: next } },
				result: { status: "adopted", attempt, receipt } as const,
			};
		});
	}
}
