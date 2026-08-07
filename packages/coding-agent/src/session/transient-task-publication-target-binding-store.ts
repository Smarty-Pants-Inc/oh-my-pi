import type { ISO8601, Sha256Ref } from "../registry/persistent-agent-contracts.js";
import type { RuntimeDurableStateStoreV1 } from "./managed-workspace.js";
import type {
	PrivatePublicationTargetBindingRowV1,
	PrivatePublicationTargetBindingV1,
	PrivatePublicationTargetConfidentialBindingV1,
	RuntimeTransientAuthorityV1,
} from "./workspace-controller-codecs.js";
import {
	appendSha256,
	decodePublicationBindingEvidence,
	exactJson,
	INVALID_PUBLICATION_TARGET_REQUEST_KEY,
	nowIso,
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
	publicationCurrentReceipt,
	publicationExpiryAttemptTuple,
	publicationReleaseAttemptTuple,
	publicationReleaseReceiptFromAttempt,
	publicationRenewalAttemptTuple,
	publicationRenewalReceiptFromAttempt,
	publicationTargetHandle,
	publicationTargetKeyMatches,
	publishedWorktreeReceiptSha256,
	strictRecord,
	TRANSIENT_NAMESPACE,
	transientKey,
	transientRuntimeState,
	tupleRef,
	validPublicationBindInspectRequest,
	validPublicationBindRequest,
	validPublicationExpiryInspectRequest,
	validPublicationExpiryPlan,
	validPublicationOpenRequest,
	validPublicationReleaseInspectRequest,
	validPublicationReleasePlan,
	validPublicationRenewInspectRequest,
	validPublicationRenewRequest,
	validPublicationSettlementRequest,
	validPublicationTargetKey,
} from "./workspace-controller-codecs.js";
import type {
	ConfidentialTransientTaskIsolationReadyToBindReceiptV1,
	ConfidentialTransientTaskPublicationTargetBindAttemptV1,
	ConfidentialTransientTaskPublicationTargetExpiryAttemptV1,
	ConfidentialTransientTaskPublicationTargetReleaseAttemptV1,
	ConfidentialTransientTaskPublicationTargetRenewalAttemptV1,
	TransientTaskPublicationTargetAuthorityV1,
	TransientTaskPublicationTargetBindingEvidenceV1,
	TransientTaskPublicationTargetBindingStoreV1,
	TransientTaskPublicationTargetBindResultV1,
	TransientTaskPublicationTargetCleanupClaimV1,
	TransientTaskPublicationTargetExpireResultV1,
	TransientTaskPublicationTargetKeyV1,
	TransientTaskPublicationTargetPublicationClaimV1,
	TransientTaskPublicationTargetReleaseResultV1,
	TransientTaskPublicationTargetRenewResultV1,
	TransientTaskWorktreePublicationTargetHandleV1,
} from "./workspace-runtime-contracts.js";
import { decodeTransientTaskPublicationTargetBindingV1 } from "./workspace-runtime-contracts.js";

export class DurableTransientTaskPublicationTargetBindingStoreV1
	implements TransientTaskPublicationTargetBindingStoreV1
{
	readonly #durable: RuntimeDurableStateStoreV1;
	readonly #authority: RuntimeTransientAuthorityV1;
	readonly #registerWorktreePublicationTarget:
		| ((
				handle: TransientTaskWorktreePublicationTargetHandleV1,
				creatorPreparation: ConfidentialTransientTaskIsolationReadyToBindReceiptV1,
		  ) => void)
		| null;
	readonly #now: () => ISO8601;

	constructor(options: {
		readonly durable: RuntimeDurableStateStoreV1;
		readonly authority: RuntimeTransientAuthorityV1;
		readonly registerWorktreePublicationTarget?: (
			handle: TransientTaskWorktreePublicationTargetHandleV1,
			creatorPreparation: ConfidentialTransientTaskIsolationReadyToBindReceiptV1,
		) => void;
		readonly now?: () => ISO8601;
	}) {
		this.#durable = options.durable;
		this.#authority = options.authority;
		this.#registerWorktreePublicationTarget = options.registerWorktreePublicationTarget ?? null;
		this.#now = options.now ?? nowIso;
	}

	async #authorized(key: TransientTaskPublicationTargetKeyV1, authority: TransientTaskPublicationTargetAuthorityV1) {
		try {
			if (authority.kind === "controller")
				return (await this.#authority.authorizeController(authority.proof)) === "current";
			if (authority.kind === "cleanup") return this.#authority.authorizeCleanup(authority.proof);
			return this.#authority.authorizeTerminal({
				key,
				terminalEvidenceId: authority.evidenceId,
				terminalEvidenceSha256: authority.evidenceSha256,
			});
		} catch {
			return false;
		}
	}

	async bind(
		request: Parameters<TransientTaskPublicationTargetBindingStoreV1["bind"]>[0],
	): Promise<TransientTaskPublicationTargetBindResultV1> {
		if (!proxyFreeData(request))
			return {
				status: "invalid",
				key: INVALID_PUBLICATION_TARGET_REQUEST_KEY,
				code: "record_invariant_violation",
			} as const;
		if (!(await validPublicationBindRequest(request)))
			return { status: "invalid", key: request.key, code: "record_invariant_violation" } as const;
		if (!(await this.#authorized(request.key, request.authority)))
			return {
				status: "conflict",
				key: request.key,
				code: "authority_conflict",
			} as const;
		const taskKey = { taskId: request.key.taskId, runId: request.key.runId };
		const mapKey = publicationBindingMapKey(request.key);
		try {
			const prepared = await this.#durable.transact(
				TRANSIENT_NAMESPACE,
				transientKey(taskKey),
				async currentInput => {
					const state = transientRuntimeState(taskKey, currentInput);
					if (!publicationBindingLifecycleMatches(state, request.key, request.authority))
						return {
							state,
							result: {
								kind: "return",
								value: { status: "conflict", key: request.key, code: "authority_conflict" } as const,
							},
						};
					const prior = await publicationBindingRow(state.bindings[mapKey]);
					if (prior !== null) {
						const confidential = prior.confidential;
						if (confidential.state === "terminal")
							return {
								state,
								result: {
									kind: "return",
									value: { status: "conflict", key: request.key, code: "terminal_key_reuse" } as const,
								},
							};
						if (!exactJson(confidential.bindAttempt.request, request))
							return {
								state,
								result: {
									kind: "return",
									value: { status: "conflict", key: request.key, code: "same_key_different_request" } as const,
								},
							};
						if (confidential.state === "live" || confidential.state === "cleanup_due") {
							const receipt = await publicationBindReceiptFromAttempt(confidential.bindAttempt);
							if (confidential.state === "cleanup_due")
								return {
									state,
									result: {
										kind: "return",
										value: { status: "conflict", key: request.key, code: "terminal_key_reuse" } as const,
									},
								};
							return {
								state,
								result: {
									kind: "return",
									value: { status: "already_bound", binding: confidential.binding, receipt } as const,
								},
							};
						}
						if (confidential.state === "bind_outcome_unknown")
							return { state, result: { kind: "return", value: { status: "bind_outcome_unknown" } as const } };
						return { state, result: { kind: "continue", attempt: confidential.bindAttempt } as const };
					}
					if (!publicationBindCreatorMatches(state, request))
						return {
							state,
							result: {
								kind: "return",
								value: { status: "conflict", key: request.key, code: "creator_preparation_conflict" } as const,
							},
						};
					const openedAt = this.#now();
					const incomplete: ConfidentialTransientTaskPublicationTargetBindAttemptV1 = {
						request,
						openedAt,
						attemptSha256: "sha256:" as Sha256Ref,
					};
					const attempt = {
						...incomplete,
						attemptSha256: await tupleRef(publicationBindAttemptTuple(incomplete)),
					};
					const inspection = publicationAttemptInspectionFromBind(attempt);
					const binding = {
						schemaVersion: 1,
						key: request.key,
						isolationCleanupId: request.isolationCleanupId,
						bindingRevision: 0,
						renewalSequence: 0,
						progress: {
							state: "bind_not_applied",
							attempt: inspection,
							cleanupDescriptorSha256: request.creatorPreparation.cleanupDescriptor.cleanupDescriptorSha256,
							isolationCreatorPreparationReceiptSha256: request.creatorPreparation.receiptSha256,
							isolationOwnershipClaimReceiptSha256:
								request.creatorPreparation.ownershipClaimReceipt.receiptSha256,
						},
						updatedAt: openedAt,
					} as const;
					const row: PrivatePublicationTargetBindingRowV1 = {
						schemaVersion: 1,
						confidential: { state: "bind_not_applied", binding, bindAttempt: attempt },
						bindInspectStatuses: ["not_applied"],
						renewalInspectStatuses: [],
						releaseInspectStatuses: [],
						expiryInspectStatuses: [],
						adoptedAttemptSha256s: [],
						publicationSettlement: null,
						completedExpiryAttempt: null,
						terminalReleaseAttempt: null,
					};
					return {
						state: { ...state, bindings: { ...state.bindings, [mapKey]: row } },
						result: { kind: "continue", attempt } as const,
					};
				},
			);
			if (prepared.kind === "return") return prepared.value;
			const preparedAttempt = prepared.attempt;
			if (preparedAttempt === undefined)
				return { status: "invalid", key: request.key, code: "record_invariant_violation" };
			return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
				const state = transientRuntimeState(taskKey, currentInput);
				if (!publicationBindingLifecycleMatches(state, request.key, request.authority))
					return {
						state,
						result: { status: "conflict", key: request.key, code: "authority_conflict" } as const,
					};
				const row = await publicationBindingRow(state.bindings[mapKey]);
				if (
					row?.confidential.state !== "bind_not_applied" ||
					row.confidential.bindAttempt.attemptSha256 !== preparedAttempt.attemptSha256 ||
					!exactJson(row.confidential.bindAttempt.request, request)
				)
					return {
						state,
						result: { status: "conflict", key: request.key, code: "record_invariant_violation" } as const,
					};
				const receipt = await publicationBindReceiptFromAttempt(row.confidential.bindAttempt);
				const currentAuthority = state.authority;
				if (
					currentAuthority?.state !== "preparing" ||
					currentAuthority.isolationPreparation.state !== "ready_to_bind" ||
					!exactJson(currentAuthority.isolationPreparation.ready, request.creatorPreparation)
				)
					return {
						state,
						result: { status: "conflict", key: request.key, code: "creator_preparation_conflict" } as const,
					};
				const binding = {
					schemaVersion: 1,
					key: request.key,
					isolationCleanupId: request.isolationCleanupId,
					bindingRevision: 1,
					renewalSequence: 0,
					progress: {
						state: "live",
						bindReceipt: receipt,
						lastRenewalReceipt: null,
						currentReceiptSha256: receipt.receiptSha256,
						renewBy: receipt.renewBy,
						expiresAt: receipt.expiresAt,
						publicationClaim: null,
						cleanupClaim: null,
						transition: null,
					},
					updatedAt: receipt.boundAt,
				} as const;
				const next: PrivatePublicationTargetBindingRowV1 = {
					...row,
					confidential: {
						state: "live",
						binding,
						creatorPreparation: request.creatorPreparation,
						bindAttempt: row.confidential.bindAttempt,
						completedRenewals: [],
						activeAttempt: null,
					},
					bindInspectStatuses: [...row.bindInspectStatuses, "matching"],
				};
				const authority = {
					...currentAuthority,
					isolationPreparation: {
						state: "bound",
						ready: request.creatorPreparation,
						bindReceipt: receipt,
						updatedAt: receipt.boundAt,
					},
					updatedAt: receipt.boundAt,
				} as const;
				return {
					state: { ...state, authority, bindings: { ...state.bindings, [mapKey]: next } },
					result: { status: "bound", binding, receipt } as const,
				};
			});
		} catch {
			return { status: "invalid", key: request.key, code: "record_invariant_violation" } as const;
		}
	}

	async inspect(request: Parameters<TransientTaskPublicationTargetBindingStoreV1["inspect"]>[0]) {
		if (!strictRecord(request, ["key"]) || !validPublicationTargetKey(request.key))
			return { status: "invalid", key: request.key, code: "record_invariant_violation" } as const;
		const taskKey = { taskId: request.key.taskId, runId: request.key.runId };
		try {
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			const row = await publicationBindingRow(state.bindings[publicationBindingMapKey(request.key)]);
			if (row === null) return { status: "absent", key: request.key } as const;
			if (!publicationTargetKeyMatches(row.confidential.binding.key, request.key))
				return { status: "conflict", key: request.key, code: "key_body_mismatch" } as const;
			return {
				status: "matching",
				binding: decodeTransientTaskPublicationTargetBindingV1(row.confidential.binding),
			} as const;
		} catch {
			return { status: "invalid", key: request.key, code: "record_invariant_violation" } as const;
		}
	}

	async inspectBind(request: Parameters<TransientTaskPublicationTargetBindingStoreV1["inspectBind"]>[0]) {
		if (!validPublicationBindInspectRequest(request, false)) return { status: "invalid" } as const;
		const taskKey = { taskId: request.key.taskId, runId: request.key.runId };
		try {
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			const row = await publicationBindingRow(state.bindings[publicationBindingMapKey(request.key)]);
			if (row === null) return { status: "absent", bindingOperationId: request.bindingOperationId } as const;
			const confidential = row.confidential;
			if (confidential.state === "terminal") {
				const receipt = confidential.evidence.bindReceipt;
				return publicationTargetKeyMatches(receipt.key, request.key) &&
					receipt.isolationCleanupId === request.isolationCleanupId &&
					receipt.bindingOperationId === request.bindingOperationId &&
					receipt.cleanupDescriptorSha256 === request.cleanupDescriptorSha256 &&
					receipt.isolationCreatorPreparationReceiptSha256 === request.isolationCreatorPreparationReceiptSha256 &&
					receipt.isolationOwnershipClaimReceiptSha256 === request.isolationOwnershipClaimReceiptSha256 &&
					receipt.isolationCreatorDescriptorSha256 === request.isolationCreatorDescriptorSha256 &&
					receipt.isolationNamespaceSha256 === request.isolationNamespaceSha256 &&
					receipt.isolationOwnerManifestSha256 === request.isolationOwnerManifestSha256 &&
					receipt.bindRequestSha256 === request.bindRequestSha256
					? ({ status: "matching", receipt } as const)
					: ({ status: "conflict" } as const);
			}
			if (!publicationBindInspectMatches(request, confidential.bindAttempt)) return { status: "conflict" } as const;
			if (confidential.state === "bind_outcome_unknown" || confidential.state === "bind_not_applied") {
				const ready = confidential.bindAttempt.request.creatorPreparation;
				return {
					status: confidential.state === "bind_outcome_unknown" ? "outcome_unknown" : "not_applied",
					attempt: publicationAttemptInspectionFromBind(confidential.bindAttempt),
					cleanupDescriptorSha256: ready.cleanupDescriptor.cleanupDescriptorSha256,
					isolationCreatorPreparationReceiptSha256: ready.receiptSha256,
					isolationOwnershipClaimReceiptSha256: ready.ownershipClaimReceipt.receiptSha256,
					isolationCreatorDescriptorSha256: ready.creatorDescriptor.creatorDescriptorSha256,
					isolationNamespaceSha256: ready.creatorDescriptor.namespaceSha256,
					isolationOwnerManifestSha256: ready.creatorDescriptor.ownerManifestSha256,
				} as const;
			}
			return {
				status: "matching",
				receipt: await publicationBindReceiptFromAttempt(confidential.bindAttempt),
			} as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async adoptBind(request: Parameters<TransientTaskPublicationTargetBindingStoreV1["adoptBind"]>[0]) {
		if (!validPublicationBindInspectRequest(request, true)) return { status: "invalid" } as const;
		if (!(await this.#authorized(request.key, request.authority))) return { status: "authority_lost" } as const;
		const taskKey = { taskId: request.key.taskId, runId: request.key.runId };
		const mapKey = publicationBindingMapKey(request.key);
		try {
			return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
				const state = transientRuntimeState(taskKey, currentInput);
				if (!publicationBindingLifecycleMatches(state, request.key, request.authority))
					return { state, result: { status: "authority_lost" } as const };
				const row = await publicationBindingRow(state.bindings[mapKey]);
				if (row === null) return { state, result: { status: "absent" } as const };
				const confidential = row.confidential;
				if (confidential.state === "terminal" || !publicationBindInspectMatches(request, confidential.bindAttempt))
					return { state, result: { status: "conflict" } as const };
				const attempt = confidential.bindAttempt;
				if (confidential.state === "bind_outcome_unknown")
					return { state, result: { status: "outcome_unknown", attempt } as const };
				const receipt = await publicationBindReceiptFromAttempt(attempt);
				if (confidential.state === "live" || confidential.state === "cleanup_due")
					return { state, result: { status: "adopted", attempt, receipt } as const };
				const currentAuthority = state.authority;
				if (
					currentAuthority?.state !== "preparing" ||
					currentAuthority.isolationPreparation.state !== "ready_to_bind" ||
					!exactJson(currentAuthority.isolationPreparation.ready, attempt.request.creatorPreparation)
				)
					return { state, result: { status: "conflict" } as const };
				const binding = {
					schemaVersion: 1,
					key: request.key,
					isolationCleanupId: request.isolationCleanupId,
					bindingRevision: 1,
					renewalSequence: 0,
					progress: {
						state: "live",
						bindReceipt: receipt,
						lastRenewalReceipt: null,
						currentReceiptSha256: receipt.receiptSha256,
						renewBy: receipt.renewBy,
						expiresAt: receipt.expiresAt,
						publicationClaim: null,
						cleanupClaim: null,
						transition: null,
					},
					updatedAt: receipt.boundAt,
				} as const;
				const next: PrivatePublicationTargetBindingRowV1 = {
					...row,
					confidential: {
						state: "live",
						binding,
						creatorPreparation: attempt.request.creatorPreparation,
						bindAttempt: attempt,
						completedRenewals: [],
						activeAttempt: null,
					},
					bindInspectStatuses: [...row.bindInspectStatuses, "matching"],
					adoptedAttemptSha256s: appendSha256(row.adoptedAttemptSha256s, attempt.attemptSha256),
				};
				const authority = {
					...currentAuthority,
					isolationPreparation: {
						state: "bound",
						ready: attempt.request.creatorPreparation,
						bindReceipt: receipt,
						updatedAt: receipt.boundAt,
					},
					updatedAt: receipt.boundAt,
				} as const;
				return {
					state: { ...state, authority, bindings: { ...state.bindings, [mapKey]: next } },
					result: { status: "adopted", attempt, receipt } as const,
				};
			});
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async renew(
		request: Parameters<TransientTaskPublicationTargetBindingStoreV1["renew"]>[0],
	): Promise<TransientTaskPublicationTargetRenewResultV1> {
		if (!(await validPublicationRenewRequest(request)))
			return { status: "invalid", key: request.key, code: "record_invariant_violation" } as const;
		if (!(await this.#authorized(request.key, request.authority)))
			return { status: "conflict", key: request.key, code: "authority_conflict" } as const;
		const taskKey = { taskId: request.key.taskId, runId: request.key.runId };
		const mapKey = publicationBindingMapKey(request.key);
		try {
			const prepared = await this.#durable.transact(
				TRANSIENT_NAMESPACE,
				transientKey(taskKey),
				async currentInput => {
					const state = transientRuntimeState(taskKey, currentInput);
					if (!publicationBindingLifecycleMatches(state, request.key, request.authority))
						return {
							state,
							result: {
								kind: "return",
								value: { status: "conflict", key: request.key, code: "authority_conflict" } as const,
							},
						};
					const row = await publicationBindingRow(state.bindings[mapKey]);
					if (row === null)
						return {
							state,
							result: { kind: "return", value: { status: "target_missing", key: request.key } as const },
						};
					const confidential = row.confidential;
					if (confidential.state === "cleanup_due")
						return {
							state,
							result: {
								kind: "return",
								value: {
									status: "cleanup_due",
									binding: confidential.binding,
									receipt: confidential.binding.progress.cleanupDueReceipt,
								} as const,
							},
						};
					if (confidential.state !== "live")
						return {
							state,
							result: { kind: "return", value: { status: "target_missing", key: request.key } as const },
						};
					const priorRenewal = confidential.completedRenewals.find(
						entry => entry.attempt.request.bindingOperationId === request.bindingOperationId,
					);
					if (priorRenewal !== undefined)
						return exactJson(priorRenewal.attempt.request, request)
							? {
									state,
									result: {
										kind: "return",
										value: {
											status: "already_renewed",
											binding: confidential.binding,
											receipt: priorRenewal.receipt,
										} as const,
									},
								}
							: {
									state,
									result: {
										kind: "return",
										value: {
											status: "conflict",
											key: request.key,
											code: "binding_operation_identity_conflict",
										} as const,
									},
								};
					if (confidential.activeAttempt !== null) {
						if (
							confidential.activeAttempt.operation !== "renewal" ||
							!exactJson(confidential.activeAttempt.attempt.request, request)
						)
							return {
								state,
								result: {
									kind: "return",
									value: { status: "conflict", key: request.key, code: "transition_in_progress" } as const,
								},
							};
						if (confidential.activeAttempt.certainty === "outcome_unknown")
							return {
								state,
								result: { kind: "return", value: { status: "renewal_outcome_unknown" } as const },
							};
						return { state, result: { kind: "continue", attempt: confidential.activeAttempt.attempt } as const };
					}
					if (confidential.binding.progress.cleanupClaim !== null)
						return {
							state,
							result: {
								kind: "return",
								value: { status: "conflict", key: request.key, code: "cleanup_claimed" } as const,
							},
						};
					if (confidential.binding.progress.publicationClaim !== null)
						return {
							state,
							result: {
								kind: "return",
								value: { status: "conflict", key: request.key, code: "publication_claimed" } as const,
							},
						};
					if (request.bindingOperationId === confidential.bindAttempt.request.bindingOperationId)
						return {
							state,
							result: {
								kind: "return",
								value: {
									status: "conflict",
									key: request.key,
									code: "binding_operation_identity_conflict",
								} as const,
							},
						};
					const current = publicationCurrentReceipt(confidential);
					if (confidential.binding.isolationCleanupId !== request.isolationCleanupId)
						return {
							state,
							result: {
								kind: "return",
								value: {
									status: "conflict",
									key: request.key,
									code: "isolation_cleanup_identity_conflict",
								} as const,
							},
						};
					if (request.expectedBindingRevision !== confidential.binding.bindingRevision)
						return {
							state,
							result: {
								kind: "return",
								value: { status: "conflict", key: request.key, code: "revision_conflict" } as const,
							},
						};
					if (request.expectedRenewalSequence !== confidential.binding.renewalSequence)
						return {
							state,
							result: {
								kind: "return",
								value: { status: "conflict", key: request.key, code: "renewal_sequence_conflict" } as const,
							},
						};
					if (
						request.previousReceiptSha256 !== current.receiptSha256 ||
						request.expectedExpiresAt !== current.expiresAt
					)
						return {
							state,
							result: {
								kind: "return",
								value: { status: "conflict", key: request.key, code: "receipt_conflict" } as const,
							},
						};
					const openedAt = this.#now();
					if (Date.parse(openedAt) >= Date.parse(current.expiresAt))
						return {
							state,
							result: {
								kind: "return",
								value: { status: "expiry_required", key: request.key, expiresAt: current.expiresAt } as const,
							},
						};
					const incomplete: ConfidentialTransientTaskPublicationTargetRenewalAttemptV1 = {
						request,
						previousReceipt: current,
						openedAt,
						attemptSha256: "sha256:" as Sha256Ref,
					};
					const attempt = {
						...incomplete,
						attemptSha256: await tupleRef(publicationRenewalAttemptTuple(incomplete)),
					};
					const inspection = publicationAttemptInspection(
						request.bindingOperationId,
						request.renewRequestSha256,
						request.authoritySha256,
						attempt.attemptSha256,
					);
					const binding = {
						...confidential.binding,
						progress: {
							...confidential.binding.progress,
							transition: { state: "renewal_not_applied", attempt: inspection },
						},
						updatedAt: openedAt,
					} as const;
					const next: PrivatePublicationTargetBindingRowV1 = {
						...row,
						confidential: {
							...confidential,
							binding,
							activeAttempt: { certainty: "not_applied", operation: "renewal", attempt },
						},
						renewalInspectStatuses: [...row.renewalInspectStatuses, "not_applied"],
					};
					return {
						state: { ...state, bindings: { ...state.bindings, [mapKey]: next } },
						result: { kind: "continue", attempt } as const,
					};
				},
			);
			if (prepared.kind === "return") return prepared.value;
			const preparedAttempt = prepared.attempt;
			if (preparedAttempt === undefined)
				return { status: "invalid", key: request.key, code: "record_invariant_violation" };
			return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
				const state = transientRuntimeState(taskKey, currentInput);
				if (!publicationBindingLifecycleMatches(state, request.key, request.authority))
					return { state, result: { status: "conflict", key: request.key, code: "authority_conflict" } as const };
				const row = await publicationBindingRow(state.bindings[mapKey]);
				if (row?.confidential.state !== "live")
					return {
						state,
						result: { status: "conflict", key: request.key, code: "record_invariant_violation" } as const,
					};
				const confidential = row.confidential;
				const activeAttempt = confidential.activeAttempt;
				if (
					activeAttempt?.operation !== "renewal" ||
					activeAttempt.certainty !== "not_applied" ||
					activeAttempt.attempt.attemptSha256 !== preparedAttempt.attemptSha256
				)
					return {
						state,
						result: { status: "conflict", key: request.key, code: "record_invariant_violation" } as const,
					};
				const attempt = activeAttempt.attempt;
				const receipt = await publicationRenewalReceiptFromAttempt(attempt);
				const binding = {
					...confidential.binding,
					bindingRevision: receipt.bindingRevision,
					renewalSequence: receipt.renewalSequence,
					progress: {
						...confidential.binding.progress,
						lastRenewalReceipt: receipt,
						currentReceiptSha256: receipt.receiptSha256,
						renewBy: receipt.renewBy,
						expiresAt: receipt.expiresAt,
						transition: null,
					},
					updatedAt: receipt.renewedAt,
				} as const;
				const next: PrivatePublicationTargetBindingRowV1 = {
					...row,
					confidential: {
						...confidential,
						binding,
						completedRenewals: [...confidential.completedRenewals, { attempt, receipt }],
						activeAttempt: null,
					},
					renewalInspectStatuses: [...row.renewalInspectStatuses, "matching"],
				};
				return {
					state: { ...state, bindings: { ...state.bindings, [mapKey]: next } },
					result: { status: "renewed", binding, receipt } as const,
				};
			});
		} catch {
			return { status: "invalid", key: request.key, code: "record_invariant_violation" } as const;
		}
	}

	async inspectRenewal(request: Parameters<TransientTaskPublicationTargetBindingStoreV1["inspectRenewal"]>[0]) {
		if (!validPublicationRenewInspectRequest(request, false)) return { status: "invalid" } as const;
		const taskKey = { taskId: request.key.taskId, runId: request.key.runId };
		try {
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			const row = await publicationBindingRow(state.bindings[publicationBindingMapKey(request.key)]);
			if (row === null) return { status: "absent", bindingOperationId: request.bindingOperationId } as const;
			if (row.confidential.state === "terminal") {
				const receipt = row.confidential.evidence.renewalReceipts.find(
					entry => entry.bindingOperationId === request.bindingOperationId,
				);
				return receipt?.renewRequestSha256 === request.renewRequestSha256
					? ({ status: "matching", receipt } as const)
					: ({ status: "conflict" } as const);
			}
			if (row.confidential.state !== "live" && row.confidential.state !== "cleanup_due")
				return { status: "conflict" } as const;
			const confidential = row.confidential;
			const completed = confidential.completedRenewals.find(
				entry => entry.attempt.request.bindingOperationId === request.bindingOperationId,
			);
			if (completed !== undefined)
				return completed.attempt.request.renewRequestSha256 === request.renewRequestSha256
					? ({ status: "matching", receipt: completed.receipt } as const)
					: ({ status: "conflict" } as const);
			if (confidential.state !== "live") return { status: "conflict" } as const;
			const active = confidential.activeAttempt;
			if (active?.operation !== "renewal") return { status: "conflict" } as const;
			if (
				active.attempt.request.bindingOperationId !== request.bindingOperationId ||
				active.attempt.request.renewRequestSha256 !== request.renewRequestSha256
			)
				return { status: "conflict" } as const;
			return {
				status: active.certainty,
				attempt: publicationAttemptInspection(
					active.attempt.request.bindingOperationId,
					active.attempt.request.renewRequestSha256,
					active.attempt.request.authoritySha256,
					active.attempt.attemptSha256,
				),
				previousReceiptSha256: active.attempt.previousReceipt.receiptSha256,
			} as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async adoptRenewal(request: Parameters<TransientTaskPublicationTargetBindingStoreV1["adoptRenewal"]>[0]) {
		if (!validPublicationRenewInspectRequest(request, true)) return { status: "invalid" } as const;
		if (!(await this.#authorized(request.key, request.authority))) return { status: "authority_lost" } as const;
		const taskKey = { taskId: request.key.taskId, runId: request.key.runId };
		const mapKey = publicationBindingMapKey(request.key);
		try {
			return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
				const state = transientRuntimeState(taskKey, currentInput);
				if (!publicationBindingLifecycleMatches(state, request.key, request.authority))
					return { state, result: { status: "authority_lost" } as const };
				const row = await publicationBindingRow(state.bindings[mapKey]);
				if (row === null) return { state, result: { status: "absent" } as const };
				if (row.confidential.state !== "live" && row.confidential.state !== "cleanup_due")
					return { state, result: { status: "conflict" } as const };
				const confidential = row.confidential;
				const completed = confidential.completedRenewals.find(
					entry => entry.attempt.request.bindingOperationId === request.bindingOperationId,
				);
				if (completed !== undefined) {
					if (completed.attempt.request.renewRequestSha256 !== request.renewRequestSha256)
						return { state, result: { status: "conflict" } as const };
					const next = {
						...row,
						adoptedAttemptSha256s: appendSha256(row.adoptedAttemptSha256s, completed.attempt.attemptSha256),
					};
					return {
						state: { ...state, bindings: { ...state.bindings, [mapKey]: next } },
						result: { status: "adopted", attempt: completed.attempt, receipt: completed.receipt } as const,
					};
				}
				if (confidential.state !== "live") return { state, result: { status: "conflict" } as const };
				const active = confidential.activeAttempt;
				if (active?.operation !== "renewal") return { state, result: { status: "conflict" } as const };
				if (
					active.attempt.request.bindingOperationId !== request.bindingOperationId ||
					active.attempt.request.renewRequestSha256 !== request.renewRequestSha256
				)
					return { state, result: { status: "conflict" } as const };
				if (active.certainty === "outcome_unknown")
					return { state, result: { status: "outcome_unknown", attempt: active.attempt } as const };
				const receipt = await publicationRenewalReceiptFromAttempt(active.attempt);
				const binding = {
					...confidential.binding,
					bindingRevision: receipt.bindingRevision,
					renewalSequence: receipt.renewalSequence,
					progress: {
						...confidential.binding.progress,
						lastRenewalReceipt: receipt,
						currentReceiptSha256: receipt.receiptSha256,
						renewBy: receipt.renewBy,
						expiresAt: receipt.expiresAt,
						transition: null,
					},
					updatedAt: receipt.renewedAt,
				} as const;
				const next: PrivatePublicationTargetBindingRowV1 = {
					...row,
					confidential: {
						...confidential,
						binding,
						completedRenewals: [...confidential.completedRenewals, { attempt: active.attempt, receipt }],
						activeAttempt: null,
					},
					renewalInspectStatuses: [...row.renewalInspectStatuses, "matching"],
					adoptedAttemptSha256s: appendSha256(row.adoptedAttemptSha256s, active.attempt.attemptSha256),
				};
				return {
					state: { ...state, bindings: { ...state.bindings, [mapKey]: next } },
					result: { status: "adopted", attempt: active.attempt, receipt } as const,
				};
			});
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async open(request: Parameters<TransientTaskPublicationTargetBindingStoreV1["open"]>[0]) {
		if (!(await validPublicationOpenRequest(request)))
			return { status: "invalid", key: request.key, code: "record_invariant_violation" } as const;
		if (!(await this.#authorized(request.key, request.authority)))
			return { status: "conflict", key: request.key, code: "authority_conflict" } as const;
		const taskKey = { taskId: request.key.taskId, runId: request.key.runId };
		const mapKey = publicationBindingMapKey(request.key);
		try {
			const opened = await this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
				const state = transientRuntimeState(taskKey, currentInput);
				if (!publicationBindingLifecycleMatches(state, request.key, request.authority))
					return { state, result: { status: "conflict", key: request.key, code: "authority_conflict" } as const };
				const row = await publicationBindingRow(state.bindings[mapKey]);
				if (row === null) return { state, result: { status: "target_missing", key: request.key } as const };
				if (row.confidential.state !== "live" && row.confidential.state !== "cleanup_due")
					return { state, result: { status: "target_missing", key: request.key } as const };
				const confidential = row.confidential;
				if (confidential.binding.isolationCleanupId !== request.isolationCleanupId)
					return {
						state,
						result: {
							status: "conflict",
							key: request.key,
							code: "isolation_cleanup_identity_conflict",
						} as const,
					};
				if (request.access !== confidential.state)
					return {
						state,
						result: { status: "conflict", key: request.key, code: "access_state_conflict" } as const,
					};
				const progress = confidential.binding.progress;
				const current =
					confidential.state === "live"
						? publicationCurrentReceipt(confidential)
						: confidential.binding.progress.cleanupDueReceipt;
				const existing =
					confidential.state === "live"
						? (confidential.binding.progress.publicationClaim ?? confidential.binding.progress.cleanupClaim)
						: confidential.binding.progress.cleanupClaim;
				if (existing !== null) {
					const matching =
						request.purpose === "worktree_publication"
							? "worktreePublicationId" in existing &&
								existing.worktreePublicationId === request.worktreePublicationId &&
								existing.openOperationId === request.openOperationId &&
								existing.bindingOpenRequestSha256 === request.openRequestSha256
							: "cleanupClaimOperationId" in existing &&
								existing.openOperationId === request.openOperationId &&
								existing.cleanupClaimOperationId === request.cleanupClaimOperationId &&
								existing.bindingOpenRequestSha256 === request.openRequestSha256;
					if (matching)
						return {
							state,
							result: {
								status: "already_opened",
								claim: existing,
								creatorPreparation: confidential.creatorPreparation,
							} as const,
						};
					return {
						state,
						result: {
							status: "conflict",
							key: request.key,
							code: "worktreePublicationId" in existing ? "publication_claimed" : "cleanup_claimed",
						} as const,
					};
				}
				if (progress.transition !== null)
					return {
						state,
						result: { status: "conflict", key: request.key, code: "transition_in_progress" } as const,
					};
				if (
					request.expectedBindingRevision !== confidential.binding.bindingRevision ||
					request.expectedRenewalSequence !== confidential.binding.renewalSequence ||
					request.expectedReceiptSha256 !== current.receiptSha256
				)
					return {
						state,
						result: {
							status: "conflict",
							key: request.key,
							code:
								request.expectedBindingRevision !== confidential.binding.bindingRevision
									? "revision_conflict"
									: request.expectedRenewalSequence !== confidential.binding.renewalSequence
										? "renewal_sequence_conflict"
										: "receipt_conflict",
						} as const,
					};
				const claimedAt = this.#now();
				if (confidential.state === "live" && Date.parse(claimedAt) >= Date.parse(current.expiresAt))
					return {
						state,
						result: { status: "expiry_required", key: request.key, expiresAt: current.expiresAt } as const,
					};
				const bindReceipt = await publicationBindReceiptFromAttempt(confidential.bindAttempt);
				if (request.purpose === "worktree_publication") {
					if (confidential.state !== "live")
						return {
							state,
							result: { status: "conflict", key: request.key, code: "access_state_conflict" } as const,
						};
					const incomplete: TransientTaskPublicationTargetPublicationClaimV1 = {
						schemaVersion: 1,
						key: request.key,
						isolationCleanupId: request.isolationCleanupId,
						worktreePublicationId: request.worktreePublicationId,
						openOperationId: request.openOperationId,
						access: "live",
						bindingRevision: confidential.binding.bindingRevision,
						renewalSequence: confidential.binding.renewalSequence,
						bindingReceiptSha256: current.receiptSha256,
						bindingAuthoritySha256: current.authoritySha256,
						bindingOpenRequestSha256: request.openRequestSha256,
						isolationNamespaceSha256: bindReceipt.isolationNamespaceSha256,
						isolationOwnerManifestSha256: bindReceipt.isolationOwnerManifestSha256,
						isolationCreatorDescriptorSha256: bindReceipt.isolationCreatorDescriptorSha256,
						claimedAt,
						claimSha256: "sha256:" as Sha256Ref,
					};
					const claim = { ...incomplete, claimSha256: await tupleRef(publicationClaimTuple(incomplete)) };
					const binding = {
						...confidential.binding,
						progress: { ...confidential.binding.progress, publicationClaim: claim },
						updatedAt: claimedAt,
					} as const;
					const next: PrivatePublicationTargetBindingRowV1 = {
						...row,
						confidential: { ...confidential, binding },
					};
					return {
						state: { ...state, bindings: { ...state.bindings, [mapKey]: next } },
						result: { status: "opened", claim, creatorPreparation: confidential.creatorPreparation } as const,
					};
				}
				const incomplete: TransientTaskPublicationTargetCleanupClaimV1 = {
					schemaVersion: 1,
					key: request.key,
					isolationCleanupId: request.isolationCleanupId,
					openOperationId: request.openOperationId,
					cleanupClaimOperationId: request.cleanupClaimOperationId,
					access: request.access,
					bindingRevision: confidential.binding.bindingRevision,
					renewalSequence: confidential.binding.renewalSequence,
					bindingReceiptSha256: current.receiptSha256,
					bindingAuthoritySha256: current.authoritySha256,
					bindingOpenRequestSha256: request.openRequestSha256,
					cleanupDescriptorSha256: bindReceipt.cleanupDescriptorSha256,
					isolationNamespaceSha256: bindReceipt.isolationNamespaceSha256,
					isolationOwnerManifestSha256: bindReceipt.isolationOwnerManifestSha256,
					isolationCreatorDescriptorSha256: bindReceipt.isolationCreatorDescriptorSha256,
					claimedAt,
					claimSha256: "sha256:" as Sha256Ref,
				};
				const claim = { ...incomplete, claimSha256: await tupleRef(publicationCleanupClaimTuple(incomplete)) };
				if (confidential.state === "live") {
					const binding = {
						...confidential.binding,
						progress: { ...confidential.binding.progress, cleanupClaim: claim },
						updatedAt: claimedAt,
					} as const;
					const next: PrivatePublicationTargetBindingRowV1 = {
						...row,
						confidential: { ...confidential, binding },
					};
					return {
						state: { ...state, bindings: { ...state.bindings, [mapKey]: next } },
						result: { status: "opened", claim, creatorPreparation: confidential.creatorPreparation } as const,
					};
				}
				const binding = {
					...confidential.binding,
					progress: { ...confidential.binding.progress, cleanupClaim: claim },
					updatedAt: claimedAt,
				} as const;
				const next: PrivatePublicationTargetBindingRowV1 = {
					...row,
					confidential: { ...confidential, binding },
				};
				return {
					state: { ...state, bindings: { ...state.bindings, [mapKey]: next } },
					result: { status: "opened", claim, creatorPreparation: confidential.creatorPreparation } as const,
				};
			});
			if ((opened.status === "opened" || opened.status === "already_opened") && "claim" in opened)
				return {
					status: opened.status,
					target: publicationTargetHandle(
						request,
						opened.claim,
						opened.creatorPreparation,
						this.#registerWorktreePublicationTarget,
					),
				} as const;
			return opened;
		} catch {
			return { status: "invalid", key: request.key, code: "record_invariant_violation" } as const;
		}
	}

	async settlePublicationClaim(
		request: Parameters<TransientTaskPublicationTargetBindingStoreV1["settlePublicationClaim"]>[0],
	) {
		if (!(await validPublicationSettlementRequest(request))) return { status: "invalid" } as const;
		if (!(await this.#authorized(request.key, request.authority))) return { status: "authority_lost" } as const;
		const taskKey = { taskId: request.key.taskId, runId: request.key.runId };
		const mapKey = publicationBindingMapKey(request.key);
		try {
			return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
				const state = transientRuntimeState(taskKey, currentInput);
				if (!publicationBindingLifecycleMatches(state, request.key, request.authority))
					return { state, result: { status: "authority_lost" } as const };
				const row = await publicationBindingRow(state.bindings[mapKey]);
				if (row === null || row.confidential.state !== "live")
					return { state, result: { status: "target_missing" } as const };
				const claim = row.confidential.binding.progress.publicationClaim;
				if (claim === null) {
					const settlement = row.publicationSettlement;
					return settlement !== null &&
						settlement.publicationClaimSha256 === request.publicationClaimSha256 &&
						settlement.publicationReceiptSha256 === request.publicationReceiptSha256 &&
						settlement.requestSha256 === request.requestSha256
						? { state, result: { status: "already_settled" } as const }
						: { state, result: { status: "conflict" } as const };
				}
				if (
					claim.isolationCleanupId !== request.isolationCleanupId ||
					claim.worktreePublicationId !== request.worktreePublicationId ||
					claim.claimSha256 !== request.publicationClaimSha256
				)
					return { state, result: { status: "conflict" } as const };
				if (
					publishedWorktreeReceiptSha256(state, request.worktreePublicationId) !== request.publicationReceiptSha256
				)
					return { state, result: { status: "conflict" } as const };
				const updatedAt = this.#now();
				const binding = {
					...row.confidential.binding,
					progress: { ...row.confidential.binding.progress, publicationClaim: null },
					updatedAt,
				} as const;
				const next: PrivatePublicationTargetBindingRowV1 = {
					...row,
					confidential: { ...row.confidential, binding },
					publicationSettlement: {
						publicationClaimSha256: request.publicationClaimSha256,
						publicationReceiptSha256: request.publicationReceiptSha256,
						requestSha256: request.requestSha256,
					},
				};
				return {
					state: { ...state, bindings: { ...state.bindings, [mapKey]: next } },
					result: { status: "settled" } as const,
				};
			});
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async #terminalRelease(
		row: PrivatePublicationTargetBindingRowV1,
		attempt: ConfidentialTransientTaskPublicationTargetReleaseAttemptV1,
		adopted: boolean,
	) {
		const confidential = row.confidential;
		if (confidential.state !== "live" && confidential.state !== "cleanup_due")
			throw new Error("Transient publication release source is invalid");
		const plan = attempt.plan;
		const current =
			confidential.state === "live"
				? publicationCurrentReceipt(confidential)
				: confidential.binding.progress.cleanupDueReceipt;
		const bindReceipt = await publicationBindReceiptFromAttempt(confidential.bindAttempt);
		const receipt = await publicationReleaseReceiptFromAttempt(attempt);
		const adoptedAttemptSha256s = adopted
			? appendSha256(row.adoptedAttemptSha256s, attempt.attemptSha256)
			: row.adoptedAttemptSha256s;
		const releaseInspectStatuses = [...row.releaseInspectStatuses, "matching"] as const;
		const incomplete: TransientTaskPublicationTargetBindingEvidenceV1 = {
			schemaVersion: 1,
			key: plan.key,
			isolationCleanupId: plan.isolationCleanupId,
			bindReceipt,
			renewalReceipts: confidential.completedRenewals.map(entry => entry.receipt),
			effectAccess: confidential.state,
			effectBindingRevision: confidential.binding.bindingRevision,
			effectBindingRenewalSequence: confidential.binding.renewalSequence,
			effectBindingReceiptSha256: current.receiptSha256,
			effectBindingAuthoritySha256: current.authoritySha256,
			effectBindingOpenRequestSha256: plan.cleanupClaim.bindingOpenRequestSha256,
			cleanupDescriptorSha256: bindReceipt.cleanupDescriptorSha256,
			cleanupClaim: plan.cleanupClaim,
			worktreePublicationReceiptSha256: row.publicationSettlement?.publicationReceiptSha256 ?? null,
			cleanupDueReceipt:
				confidential.state === "cleanup_due" ? confidential.binding.progress.cleanupDueReceipt : null,
			isolationCleanupReceipt: plan.isolationCleanupReceipt,
			isolationCleanupReceiptSha256: plan.isolationCleanupReceiptSha256,
			releasePlanSha256: plan.planSha256,
			terminalReceipt: receipt,
			bindInspectStatuses: row.bindInspectStatuses,
			renewalInspectStatuses: row.renewalInspectStatuses,
			releaseInspectStatuses,
			expiryInspectStatuses: row.expiryInspectStatuses,
			bindAttemptSha256: confidential.bindAttempt.attemptSha256,
			renewalAttemptSha256s: confidential.completedRenewals.map(entry => entry.attempt.attemptSha256),
			releaseAttemptSha256: attempt.attemptSha256,
			expiryAttemptSha256: row.completedExpiryAttempt?.attemptSha256 ?? null,
			adoptedAttemptSha256s,
			cleanupClaimSurvivedWallClockExpiry: Date.parse(attempt.openedAt) >= Date.parse(current.expiresAt),
			publicPhysicalPathFieldCount: 0,
			publicBackendFieldCount: 0,
			publicPrivateRequestDigestFieldCount: 0,
			evidenceSha256: "sha256:" as Sha256Ref,
		};
		const evidence = await decodePublicationBindingEvidence({
			...incomplete,
			evidenceSha256: await tupleRef(publicationBindingEvidenceTuple(incomplete)),
		});
		if (evidence === null) throw new Error("Transient publication release evidence is invalid");
		const binding = {
			schemaVersion: 1,
			key: plan.key,
			isolationCleanupId: plan.isolationCleanupId,
			bindingRevision: receipt.bindingRevision,
			renewalSequence: receipt.renewalSequence,
			progress: { state: "terminal", terminalState: receipt.state, releaseReceipt: receipt },
			updatedAt: receipt.terminalAt,
		} as const;
		const next: PrivatePublicationTargetBindingRowV1 = {
			...row,
			confidential: { state: "terminal", binding, evidence },
			releaseInspectStatuses,
			adoptedAttemptSha256s,
			terminalReleaseAttempt: attempt,
		};
		return { next, binding, receipt, evidence };
	}

	async release(
		request: Parameters<TransientTaskPublicationTargetBindingStoreV1["release"]>[0],
	): Promise<TransientTaskPublicationTargetReleaseResultV1> {
		if (!strictRecord(request, ["plan"]) || !(await validPublicationReleasePlan(request.plan)))
			return { status: "invalid" } as const;
		const plan = request.plan;
		if (!(await this.#authorized(plan.key, plan.authority))) return { status: "conflict" } as const;
		const taskKey = { taskId: plan.key.taskId, runId: plan.key.runId };
		const mapKey = publicationBindingMapKey(plan.key);
		try {
			const prepared = await this.#durable.transact(
				TRANSIENT_NAMESPACE,
				transientKey(taskKey),
				async currentInput => {
					const state = transientRuntimeState(taskKey, currentInput);
					if (!publicationBindingLifecycleMatches(state, plan.key, plan.authority))
						return { state, result: { kind: "return", value: { status: "conflict" } as const } };
					const row = await publicationBindingRow(state.bindings[mapKey]);
					if (row === null)
						return { state, result: { kind: "return", value: { status: "target_missing" } as const } };
					const confidential = row.confidential;
					if (confidential.state === "terminal") {
						const receipt = confidential.evidence.terminalReceipt;
						return receipt.releasePlanSha256 === plan.planSha256 &&
							receipt.releaseRequestSha256 === plan.releaseRequestSha256
							? {
									state,
									result: {
										kind: "return",
										value: {
											status: receipt.state === "expired" ? "already_expired" : "already_released",
											binding: confidential.binding,
											receipt,
											evidence: confidential.evidence,
										} as const,
									},
								}
							: { state, result: { kind: "return", value: { status: "conflict" } as const } };
					}
					if (confidential.state !== "live" && confidential.state !== "cleanup_due")
						return { state, result: { kind: "return", value: { status: "target_missing" } as const } };
					const activeAttempt = confidential.activeAttempt;
					if (activeAttempt !== null) {
						if (activeAttempt.operation !== "release" || !exactJson(activeAttempt.attempt.plan, plan))
							return { state, result: { kind: "return", value: { status: "conflict" } as const } };
						if (activeAttempt.certainty === "outcome_unknown")
							return {
								state,
								result: { kind: "return", value: { status: "release_outcome_unknown" } as const },
							};
						return { state, result: { kind: "continue", attempt: activeAttempt.attempt } as const };
					}
					const current =
						confidential.state === "live"
							? publicationCurrentReceipt(confidential)
							: confidential.binding.progress.cleanupDueReceipt;
					const claim = confidential.binding.progress.cleanupClaim;
					if (
						claim === null ||
						!exactJson(claim, plan.cleanupClaim) ||
						plan.isolationCleanupId !== confidential.binding.isolationCleanupId ||
						plan.bindingOperationId === confidential.bindAttempt.request.bindingOperationId ||
						plan.expectedBindingRevision !== confidential.binding.bindingRevision ||
						plan.expectedRenewalSequence !== confidential.binding.renewalSequence ||
						plan.previousReceiptSha256 !== current.receiptSha256 ||
						plan.bindingAuthoritySha256 !== current.authoritySha256 ||
						confidential.completedRenewals.some(
							entry => entry.attempt.request.bindingOperationId === plan.bindingOperationId,
						) ||
						row.completedExpiryAttempt?.plan.bindingOperationId === plan.bindingOperationId ||
						plan.bindingOpenRequestSha256 !== claim.bindingOpenRequestSha256 ||
						plan.cleanupDescriptorSha256 !== claim.cleanupDescriptorSha256 ||
						plan.isolationCleanupReceipt.cleanupClaim.claimSha256 !== claim.claimSha256 ||
						plan.isolationCleanupReceipt.bindingReceiptSha256 !== current.receiptSha256 ||
						plan.isolationCleanupReceipt.bindingAuthoritySha256 !== current.authoritySha256 ||
						(plan.reason === "expired" && confidential.state !== "cleanup_due")
					)
						return { state, result: { kind: "return", value: { status: "conflict" } as const } };
					const openedAt = this.#now();
					const incomplete: ConfidentialTransientTaskPublicationTargetReleaseAttemptV1 = {
						plan,
						openedAt,
						attemptSha256: "sha256:" as Sha256Ref,
					};
					const attempt = {
						...incomplete,
						attemptSha256: await tupleRef(publicationReleaseAttemptTuple(incomplete)),
					};
					const inspection = publicationAttemptInspection(
						plan.bindingOperationId,
						plan.releaseRequestSha256,
						plan.authoritySha256,
						attempt.attemptSha256,
					);
					let nextConfidential: Extract<
						PrivatePublicationTargetConfidentialBindingV1,
						{ state: "live" | "cleanup_due" }
					>;
					if (confidential.state === "live") {
						const binding: PrivatePublicationTargetBindingV1<"live"> = {
							...confidential.binding,
							progress: {
								...confidential.binding.progress,
								transition: {
									state: "release_not_applied",
									attempt: inspection,
									planSha256: plan.planSha256,
								},
							},
							updatedAt: openedAt,
						};
						nextConfidential = {
							...confidential,
							binding,
							activeAttempt: { certainty: "not_applied", operation: "release", attempt },
						};
					} else {
						const binding: PrivatePublicationTargetBindingV1<"cleanup_due"> = {
							...confidential.binding,
							progress: {
								...confidential.binding.progress,
								transition: {
									state: "release_not_applied",
									attempt: inspection,
									planSha256: plan.planSha256,
								},
							},
							updatedAt: openedAt,
						};
						nextConfidential = {
							...confidential,
							binding,
							activeAttempt: { certainty: "not_applied", operation: "release", attempt },
						};
					}
					const next: PrivatePublicationTargetBindingRowV1 = {
						...row,
						confidential: nextConfidential,
						releaseInspectStatuses: [...row.releaseInspectStatuses, "not_applied"],
					};
					return {
						state: { ...state, bindings: { ...state.bindings, [mapKey]: next } },
						result: { kind: "continue", attempt } as const,
					};
				},
			);
			if (prepared.kind === "return") return prepared.value;
			const preparedAttempt = prepared.attempt;
			if (preparedAttempt === undefined) return { status: "invalid" };
			return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
				const state = transientRuntimeState(taskKey, currentInput);
				if (!publicationBindingLifecycleMatches(state, plan.key, plan.authority))
					return { state, result: { status: "conflict" } as const };
				const row = await publicationBindingRow(state.bindings[mapKey]);
				if (row?.confidential.state !== "live" && row?.confidential.state !== "cleanup_due")
					return { state, result: { status: "conflict" } as const };
				const activeAttempt = row.confidential.activeAttempt;
				if (
					activeAttempt?.operation !== "release" ||
					activeAttempt.certainty !== "not_applied" ||
					activeAttempt.attempt.attemptSha256 !== preparedAttempt.attemptSha256
				)
					return { state, result: { status: "conflict" } as const };
				const completed = await this.#terminalRelease(row, activeAttempt.attempt, false);
				return {
					state: { ...state, bindings: { ...state.bindings, [mapKey]: completed.next } },
					result: {
						status: completed.receipt.state === "expired" ? "expired" : "released",
						binding: completed.binding,
						receipt: completed.receipt,
						evidence: completed.evidence,
					} as const,
				};
			});
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async inspectRelease(request: Parameters<TransientTaskPublicationTargetBindingStoreV1["inspectRelease"]>[0]) {
		if (!validPublicationReleaseInspectRequest(request, false)) return { status: "invalid" } as const;
		const taskKey = { taskId: request.key.taskId, runId: request.key.runId };
		try {
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			const row = await publicationBindingRow(state.bindings[publicationBindingMapKey(request.key)]);
			if (row === null) return { status: "absent", bindingOperationId: request.bindingOperationId } as const;
			if (row.confidential.state === "terminal") {
				const receipt = row.confidential.evidence.terminalReceipt;
				return receipt.bindingOperationId === request.bindingOperationId &&
					receipt.releasePlanSha256 === request.planSha256 &&
					receipt.releaseRequestSha256 === request.releaseRequestSha256
					? ({ status: "matching", receipt } as const)
					: ({ status: "conflict" } as const);
			}
			if (row.confidential.state !== "live" && row.confidential.state !== "cleanup_due")
				return { status: "target_missing" } as const;
			const active = row.confidential.activeAttempt;
			if (active?.operation !== "release") return { status: "conflict" } as const;
			if (
				active.attempt.plan.bindingOperationId !== request.bindingOperationId ||
				active.attempt.plan.planSha256 !== request.planSha256 ||
				active.attempt.plan.releaseRequestSha256 !== request.releaseRequestSha256
			)
				return { status: "conflict" } as const;
			return {
				status: active.certainty,
				attempt: publicationAttemptInspection(
					active.attempt.plan.bindingOperationId,
					active.attempt.plan.releaseRequestSha256,
					active.attempt.plan.authoritySha256,
					active.attempt.attemptSha256,
				),
				planSha256: active.attempt.plan.planSha256,
			} as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async adoptRelease(request: Parameters<TransientTaskPublicationTargetBindingStoreV1["adoptRelease"]>[0]) {
		if (!validPublicationReleaseInspectRequest(request, true)) return { status: "invalid" } as const;
		if (!(await this.#authorized(request.key, request.authority))) return { status: "authority_lost" } as const;
		const taskKey = { taskId: request.key.taskId, runId: request.key.runId };
		const mapKey = publicationBindingMapKey(request.key);
		try {
			return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
				const state = transientRuntimeState(taskKey, currentInput);
				if (!publicationBindingLifecycleMatches(state, request.key, request.authority))
					return { state, result: { status: "authority_lost" } as const };
				const row = await publicationBindingRow(state.bindings[mapKey]);
				if (row === null) return { state, result: { status: "absent" } as const };
				if (row.confidential.state === "terminal") {
					const attempt = row.terminalReleaseAttempt;
					const receipt = row.confidential.evidence.terminalReceipt;
					return attempt !== null &&
						attempt.plan.bindingOperationId === request.bindingOperationId &&
						attempt.plan.planSha256 === request.planSha256 &&
						attempt.plan.releaseRequestSha256 === request.releaseRequestSha256
						? {
								state,
								result: { status: "adopted", attempt, receipt, evidence: row.confidential.evidence } as const,
							}
						: { state, result: { status: "conflict" } as const };
				}
				if (row.confidential.state !== "live" && row.confidential.state !== "cleanup_due")
					return { state, result: { status: "conflict" } as const };
				const active = row.confidential.activeAttempt;
				if (
					active?.operation !== "release" ||
					active.attempt.plan.bindingOperationId !== request.bindingOperationId ||
					active.attempt.plan.planSha256 !== request.planSha256 ||
					active.attempt.plan.releaseRequestSha256 !== request.releaseRequestSha256
				)
					return { state, result: { status: "conflict" } as const };
				if (active.certainty === "outcome_unknown")
					return { state, result: { status: "outcome_unknown", attempt: active.attempt } as const };
				const completed = await this.#terminalRelease(row, active.attempt, true);
				return {
					state: { ...state, bindings: { ...state.bindings, [mapKey]: completed.next } },
					result: {
						status: "adopted",
						attempt: active.attempt,
						receipt: completed.receipt,
						evidence: completed.evidence,
					} as const,
				};
			});
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async expire(
		request: Parameters<TransientTaskPublicationTargetBindingStoreV1["expire"]>[0],
	): Promise<TransientTaskPublicationTargetExpireResultV1> {
		if (!strictRecord(request, ["plan"]) || !(await validPublicationExpiryPlan(request.plan)))
			return { status: "invalid" } as const;
		const plan = request.plan;
		if (!(await this.#authorized(plan.key, plan.authority))) return { status: "conflict" } as const;
		const taskKey = { taskId: plan.key.taskId, runId: plan.key.runId };
		const mapKey = publicationBindingMapKey(plan.key);
		try {
			const prepared = await this.#durable.transact(
				TRANSIENT_NAMESPACE,
				transientKey(taskKey),
				async currentInput => {
					const state = transientRuntimeState(taskKey, currentInput);
					if (!publicationBindingLifecycleMatches(state, plan.key, plan.authority))
						return { state, result: { kind: "return", value: { status: "conflict" } as const } };
					const row = await publicationBindingRow(state.bindings[mapKey]);
					if (row === null)
						return { state, result: { kind: "return", value: { status: "target_missing" } as const } };
					const confidential = row.confidential;
					if (confidential.state === "cleanup_due") {
						const attempt = row.completedExpiryAttempt;
						const receipt = confidential.binding.progress.cleanupDueReceipt;
						return attempt !== null && exactJson(attempt.plan, plan)
							? {
									state,
									result: {
										kind: "return",
										value: { status: "already_cleanup_due", binding: confidential.binding, receipt } as const,
									},
								}
							: { state, result: { kind: "return", value: { status: "conflict" } as const } };
					}
					if (confidential.state !== "live")
						return { state, result: { kind: "return", value: { status: "target_missing" } as const } };
					if (confidential.activeAttempt !== null) {
						if (
							confidential.activeAttempt.operation !== "expiry" ||
							!exactJson(confidential.activeAttempt.attempt.plan, plan)
						)
							return { state, result: { kind: "return", value: { status: "conflict" } as const } };
						if (confidential.activeAttempt.certainty === "outcome_unknown")
							return { state, result: { kind: "return", value: { status: "expiry_outcome_unknown" } as const } };
						return { state, result: { kind: "continue", attempt: confidential.activeAttempt.attempt } as const };
					}
					if (
						confidential.binding.progress.cleanupClaim !== null ||
						confidential.binding.progress.publicationClaim !== null
					)
						return { state, result: { kind: "return", value: { status: "conflict" } as const } };
					const current = publicationCurrentReceipt(confidential);
					if (
						plan.isolationCleanupId !== confidential.binding.isolationCleanupId ||
						plan.bindingOperationId === confidential.bindAttempt.request.bindingOperationId ||
						confidential.completedRenewals.some(
							entry => entry.attempt.request.bindingOperationId === plan.bindingOperationId,
						) ||
						plan.expectedBindingRevision !== confidential.binding.bindingRevision ||
						plan.expectedRenewalSequence !== confidential.binding.renewalSequence ||
						plan.previousReceiptSha256 !== current.receiptSha256 ||
						plan.expectedExpiresAt !== current.expiresAt
					)
						return { state, result: { kind: "return", value: { status: "conflict" } as const } };
					const openedAt = this.#now();
					if (Date.parse(openedAt) < Date.parse(current.expiresAt))
						return {
							state,
							result: {
								kind: "return",
								value: { status: "not_due", key: plan.key, expiresAt: current.expiresAt } as const,
							},
						};
					const incomplete: ConfidentialTransientTaskPublicationTargetExpiryAttemptV1 = {
						plan,
						openedAt,
						attemptSha256: "sha256:" as Sha256Ref,
					};
					const attempt = {
						...incomplete,
						attemptSha256: await tupleRef(publicationExpiryAttemptTuple(incomplete)),
					};
					const inspection = publicationAttemptInspection(
						plan.bindingOperationId,
						plan.expiryRequestSha256,
						plan.authoritySha256,
						attempt.attemptSha256,
					);
					const binding = {
						...confidential.binding,
						progress: {
							...confidential.binding.progress,
							transition: { state: "expiry_not_applied", attempt: inspection, planSha256: plan.planSha256 },
						},
						updatedAt: openedAt,
					} as const;
					const next: PrivatePublicationTargetBindingRowV1 = {
						...row,
						confidential: {
							...confidential,
							binding,
							activeAttempt: { certainty: "not_applied", operation: "expiry", attempt },
						},
						expiryInspectStatuses: [...row.expiryInspectStatuses, "not_applied"],
					};
					return {
						state: { ...state, bindings: { ...state.bindings, [mapKey]: next } },
						result: { kind: "continue", attempt } as const,
					};
				},
			);
			if (prepared.kind === "return") return prepared.value;
			const preparedAttempt = prepared.attempt;
			if (preparedAttempt === undefined) return { status: "invalid" };
			return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
				const state = transientRuntimeState(taskKey, currentInput);
				if (!publicationBindingLifecycleMatches(state, plan.key, plan.authority))
					return { state, result: { status: "conflict" } as const };
				const row = await publicationBindingRow(state.bindings[mapKey]);
				if (
					row?.confidential.state !== "live" ||
					row.confidential.activeAttempt?.operation !== "expiry" ||
					row.confidential.activeAttempt.certainty !== "not_applied" ||
					row.confidential.activeAttempt.attempt.attemptSha256 !== preparedAttempt.attemptSha256
				)
					return { state, result: { status: "conflict" } as const };
				const attempt = row.confidential.activeAttempt.attempt;
				const receipt = await publicationCleanupDueReceiptFromAttempt(attempt);
				const binding = {
					schemaVersion: 1,
					key: plan.key,
					isolationCleanupId: plan.isolationCleanupId,
					bindingRevision: receipt.bindingRevision,
					renewalSequence: receipt.renewalSequence,
					progress: {
						state: "cleanup_due",
						cleanupDueReceipt: receipt,
						currentReceiptSha256: receipt.receiptSha256,
						expiresAt: receipt.expiresAt,
						cleanupClaim: null,
						transition: null,
					},
					updatedAt: receipt.cleanupDueAt,
				} as const;
				const next: PrivatePublicationTargetBindingRowV1 = {
					...row,
					confidential: {
						state: "cleanup_due",
						binding,
						creatorPreparation: row.confidential.creatorPreparation,
						bindAttempt: row.confidential.bindAttempt,
						completedRenewals: row.confidential.completedRenewals,
						activeAttempt: null,
					},
					expiryInspectStatuses: [...row.expiryInspectStatuses, "matching"],
					completedExpiryAttempt: attempt,
				};
				return {
					state: { ...state, bindings: { ...state.bindings, [mapKey]: next } },
					result: { status: "cleanup_due", binding, receipt } as const,
				};
			});
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async inspectExpiry(request: Parameters<TransientTaskPublicationTargetBindingStoreV1["inspectExpiry"]>[0]) {
		if (!validPublicationExpiryInspectRequest(request, false)) return { status: "invalid" } as const;
		const taskKey = { taskId: request.key.taskId, runId: request.key.runId };
		try {
			const state = transientRuntimeState(
				taskKey,
				await this.#durable.inspect(TRANSIENT_NAMESPACE, transientKey(taskKey)),
			);
			const row = await publicationBindingRow(state.bindings[publicationBindingMapKey(request.key)]);
			if (row === null) return { status: "absent", bindingOperationId: request.bindingOperationId } as const;
			const completed = row.completedExpiryAttempt;
			if (
				completed !== null &&
				completed.plan.bindingOperationId === request.bindingOperationId &&
				completed.plan.planSha256 === request.planSha256 &&
				completed.plan.expiryRequestSha256 === request.expiryRequestSha256
			) {
				const receipt = await publicationCleanupDueReceiptFromAttempt(completed);
				return { status: "matching", receipt } as const;
			}
			if (row.confidential.state !== "live") return { status: "target_missing" } as const;
			const active = row.confidential.activeAttempt;
			if (active?.operation !== "expiry") return { status: "conflict" } as const;
			if (
				active.attempt.plan.bindingOperationId !== request.bindingOperationId ||
				active.attempt.plan.planSha256 !== request.planSha256 ||
				active.attempt.plan.expiryRequestSha256 !== request.expiryRequestSha256
			)
				return { status: "conflict" } as const;
			return {
				status: active.certainty,
				attempt: publicationAttemptInspection(
					active.attempt.plan.bindingOperationId,
					active.attempt.plan.expiryRequestSha256,
					active.attempt.plan.authoritySha256,
					active.attempt.attemptSha256,
				),
				planSha256: active.attempt.plan.planSha256,
			} as const;
		} catch {
			return { status: "invalid" } as const;
		}
	}

	async adoptExpiry(request: Parameters<TransientTaskPublicationTargetBindingStoreV1["adoptExpiry"]>[0]) {
		if (!validPublicationExpiryInspectRequest(request, true)) return { status: "invalid" } as const;
		if (!(await this.#authorized(request.key, request.authority))) return { status: "authority_lost" } as const;
		const taskKey = { taskId: request.key.taskId, runId: request.key.runId };
		const mapKey = publicationBindingMapKey(request.key);
		try {
			return this.#durable.transact(TRANSIENT_NAMESPACE, transientKey(taskKey), async currentInput => {
				const state = transientRuntimeState(taskKey, currentInput);
				if (!publicationBindingLifecycleMatches(state, request.key, request.authority))
					return { state, result: { status: "authority_lost" } as const };
				const row = await publicationBindingRow(state.bindings[mapKey]);
				if (row === null) return { state, result: { status: "absent" } as const };
				const completed = row.completedExpiryAttempt;
				if (
					completed !== null &&
					completed.plan.bindingOperationId === request.bindingOperationId &&
					completed.plan.planSha256 === request.planSha256 &&
					completed.plan.expiryRequestSha256 === request.expiryRequestSha256
				) {
					const receipt = await publicationCleanupDueReceiptFromAttempt(completed);
					const next = {
						...row,
						adoptedAttemptSha256s: appendSha256(row.adoptedAttemptSha256s, completed.attemptSha256),
					};
					return {
						state: { ...state, bindings: { ...state.bindings, [mapKey]: next } },
						result: { status: "adopted", attempt: completed, receipt } as const,
					};
				}
				if (row.confidential.state !== "live" || row.confidential.activeAttempt?.operation !== "expiry")
					return { state, result: { status: "conflict" } as const };
				const active = row.confidential.activeAttempt;
				if (
					active.attempt.plan.bindingOperationId !== request.bindingOperationId ||
					active.attempt.plan.planSha256 !== request.planSha256 ||
					active.attempt.plan.expiryRequestSha256 !== request.expiryRequestSha256
				)
					return { state, result: { status: "conflict" } as const };
				if (active.certainty === "outcome_unknown")
					return { state, result: { status: "outcome_unknown", attempt: active.attempt } as const };
				const receipt = await publicationCleanupDueReceiptFromAttempt(active.attempt);
				const binding = {
					schemaVersion: 1,
					key: request.key,
					isolationCleanupId: request.isolationCleanupId,
					bindingRevision: receipt.bindingRevision,
					renewalSequence: receipt.renewalSequence,
					progress: {
						state: "cleanup_due",
						cleanupDueReceipt: receipt,
						currentReceiptSha256: receipt.receiptSha256,
						expiresAt: receipt.expiresAt,
						cleanupClaim: null,
						transition: null,
					},
					updatedAt: receipt.cleanupDueAt,
				} as const;
				const next: PrivatePublicationTargetBindingRowV1 = {
					...row,
					confidential: {
						state: "cleanup_due",
						binding,
						creatorPreparation: row.confidential.creatorPreparation,
						bindAttempt: row.confidential.bindAttempt,
						completedRenewals: row.confidential.completedRenewals,
						activeAttempt: null,
					},
					expiryInspectStatuses: [...row.expiryInspectStatuses, "matching"],
					adoptedAttemptSha256s: appendSha256(row.adoptedAttemptSha256s, active.attempt.attemptSha256),
					completedExpiryAttempt: active.attempt,
				};
				return {
					state: { ...state, bindings: { ...state.bindings, [mapKey]: next } },
					result: { status: "adopted", attempt: active.attempt, receipt } as const,
				};
			});
		} catch {
			return { status: "invalid" } as const;
		}
	}
}
