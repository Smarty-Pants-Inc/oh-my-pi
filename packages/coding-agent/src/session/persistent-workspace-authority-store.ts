import { randomUUID } from "node:crypto";
import type {
	ISO8601,
	OperationId,
	PersistentAgentOwnership,
	Sha256Ref,
	TerminalReplicaCleanupProofV1,
	WorkspaceControllerLeaseId,
	WorkspaceId,
} from "../registry/persistent-agent-contracts.js";
import type {
	PersistentControllerAuthorizationV1,
	RuntimeDurableStateStoreV1,
	RuntimeWorkspaceAuthorityV1,
} from "./managed-workspace.js";
import { TransientTaskWorkspaceAuthorityStore } from "./transient-task-workspace-authority-store.js";
import {
	addMilliseconds,
	CONTROLLER_NAMESPACE,
	controllerObservation,
	controllerState,
	decodeRuntimeAttachmentRecordV1,
	deletionObservation,
	deletionProofMatches,
	exactJson,
	leaseProofMatches,
	nowIso,
	ownershipMatches,
	renewalDeadline,
} from "./workspace-controller-codecs.js";
import type {
	SafeDiagnosticCodeV1,
	TransientTaskCleanupAuthorityProofV1,
	TransientTaskControllerAuthorityProofV1,
	WorkspaceControllerLease,
	WorkspaceControllerLeaseAcquireResult,
	WorkspaceControllerLeaseInspectResult,
	WorkspaceControllerLeaseProof,
	WorkspaceControllerLeaseRenewResult,
	WorkspaceControllerLeaseStore,
	WorkspaceDeletionAuthority,
	WorkspaceDeletionAuthorityAcquireResult,
	WorkspaceDeletionAuthorityProof,
	WorkspaceDeletionAuthorityStore,
	WorkspaceDeletionVerificationReceiptV1,
	WorkspaceDeletionVerificationResultV1,
} from "./workspace-runtime-contracts.js";
import { canonicalRuntimeSha256 } from "./workspace-runtime-contracts.js";

export class PersistentWorkspaceAuthorityStoreV1 implements WorkspaceControllerLeaseStore, RuntimeWorkspaceAuthorityV1 {
	readonly #durable: RuntimeDurableStateStoreV1;
	readonly #now: () => ISO8601;
	readonly #id: () => OperationId;
	readonly #authorizePersistentCleanupProof: (
		deletionProof: WorkspaceDeletionAuthorityProof,
		cleanupProof: TerminalReplicaCleanupProofV1,
	) => Promise<boolean>;

	constructor(options: {
		readonly durable: RuntimeDurableStateStoreV1;
		readonly now?: () => ISO8601;
		readonly authorizePersistentCleanupProof: (
			deletionProof: WorkspaceDeletionAuthorityProof,
			cleanupProof: TerminalReplicaCleanupProofV1,
		) => Promise<boolean>;
		readonly id?: () => OperationId;
	}) {
		this.#durable = options.durable;
		this.#now = options.now ?? nowIso;
		this.#id = options.id ?? (() => randomUUID());
		this.#authorizePersistentCleanupProof = options.authorizePersistentCleanupProof;
	}

	async acquire(request: {
		readonly workspaceId: WorkspaceId;
		readonly ownership: PersistentAgentOwnership;
		readonly ttlMs: number;
	}): Promise<WorkspaceControllerLeaseAcquireResult> {
		if (!request.ownership.isHeld()) return { status: "ownership_lost" };
		return this.#durable.transact(CONTROLLER_NAMESPACE, request.workspaceId, currentInput => {
			const current = controllerState(request.workspaceId, currentInput);
			if (current.tombstone)
				return { state: current, result: { status: "tombstoned", tombstone: current.tombstone } as const };
			if (current.deletion)
				return {
					state: current,
					result: { status: "deleting", deleteId: current.deletion.proof.deleteId } as const,
				};
			const observedAt = this.#now();
			if (current.controller && Date.parse(current.controller.expiresAt) > Date.parse(observedAt)) {
				if (ownershipMatches(current.controller.proof, request.ownership)) {
					return { state: current, result: { status: "acquired", lease: current.controller } as const };
				}
				return {
					state: current,
					result: { status: "busy", current: controllerObservation(current.controller) } as const,
				};
			}
			const epoch = current.controllerEpoch + 1;
			const proof: WorkspaceControllerLeaseProof = {
				workspaceId: request.workspaceId,
				agentId: request.ownership.agentId,
				controlHostId: request.ownership.controlHostId,
				ownerEpoch: request.ownership.ownerEpoch,
				leaseId: this.#id() as WorkspaceControllerLeaseId,
				epoch,
			};
			const lease: WorkspaceControllerLease = {
				proof,
				acquiredAt: observedAt,
				renewBy: renewalDeadline(observedAt, request.ttlMs),
				expiresAt: addMilliseconds(observedAt, request.ttlMs),
			};
			return {
				state: { ...current, controllerEpoch: epoch, controller: lease },
				result: { status: "acquired", lease } as const,
			};
		});
	}

	async renew(request: {
		readonly proof: WorkspaceControllerLeaseProof;
		readonly ownership: PersistentAgentOwnership;
		readonly ttlMs: number;
	}): Promise<WorkspaceControllerLeaseRenewResult> {
		return this.#durable.transact(CONTROLLER_NAMESPACE, request.proof.workspaceId, currentInput => {
			const current = controllerState(request.proof.workspaceId, currentInput);
			const observedAt = this.#now();
			if (
				!current.controller ||
				current.deletion ||
				!leaseProofMatches(current.controller.proof, request.proof) ||
				!ownershipMatches(request.proof, request.ownership) ||
				Date.parse(current.controller.expiresAt) <= Date.parse(observedAt)
			) {
				return {
					state: current,
					result: {
						status: "lost",
						current: current.controller ? controllerObservation(current.controller) : null,
					} as const,
				};
			}
			const lease: WorkspaceControllerLease = {
				...current.controller,
				renewBy: renewalDeadline(observedAt, request.ttlMs),
				expiresAt: addMilliseconds(observedAt, request.ttlMs),
			};
			return { state: { ...current, controller: lease }, result: { status: "renewed", lease } as const };
		});
	}

	async inspect(workspaceId: WorkspaceId): Promise<WorkspaceControllerLeaseInspectResult> {
		const current = controllerState(workspaceId, await this.#durable.inspect(CONTROLLER_NAMESPACE, workspaceId));
		if (current.tombstone) return { status: "tombstoned", tombstone: current.tombstone };
		if (current.deletion) return { status: "deleting", deleteId: current.deletion.proof.deleteId };
		if (!current.controller) return { status: "absent", workspaceId };
		return Date.parse(current.controller.expiresAt) <= Date.parse(this.#now())
			? { status: "expired", lease: controllerObservation(current.controller) }
			: { status: "active", lease: controllerObservation(current.controller) };
	}

	async revoke(request: {
		readonly workspaceId: WorkspaceId;
		readonly expectedLeaseId: WorkspaceControllerLeaseId | null;
		readonly ownership: PersistentAgentOwnership;
		readonly reasonCode: SafeDiagnosticCodeV1;
	}) {
		return this.#durable.transact(CONTROLLER_NAMESPACE, request.workspaceId, currentInput => {
			const current = controllerState(request.workspaceId, currentInput);
			if (!request.ownership.isHeld()) return { state: current, result: { status: "lost" } as const };
			if (!current.controller)
				return {
					state: current,
					result: { status: "already_absent", nextEpoch: current.controllerEpoch + 1 } as const,
				};
			if (
				!ownershipMatches(current.controller.proof, request.ownership) ||
				(request.expectedLeaseId !== null && current.controller.proof.leaseId !== request.expectedLeaseId)
			) {
				return { state: current, result: { status: "lost" } as const };
			}
			const nextEpoch = current.controllerEpoch + 1;
			return {
				state: { ...current, controllerEpoch: nextEpoch, controller: null },
				result: { status: "revoked", nextEpoch } as const,
			};
		});
	}

	async release(request: {
		readonly proof: WorkspaceControllerLeaseProof;
		readonly ownership: PersistentAgentOwnership;
	}) {
		return this.#durable.transact(CONTROLLER_NAMESPACE, request.proof.workspaceId, currentInput => {
			const current = controllerState(request.proof.workspaceId, currentInput);
			if (!current.controller) return { state: current, result: { status: "already_released" } as const };
			if (
				!leaseProofMatches(current.controller.proof, request.proof) ||
				!ownershipMatches(request.proof, request.ownership)
			) {
				return { state: current, result: { status: "lost" } as const };
			}
			return { state: { ...current, controller: null }, result: { status: "released" } as const };
		});
	}

	async acquireDeletion(
		request: Parameters<WorkspaceDeletionAuthorityStore["acquire"]>[0],
	): Promise<WorkspaceDeletionAuthorityAcquireResult> {
		const core = request.deletion.core;
		if (!request.ownership.isHeld()) return { status: "ownership_lost" };
		return this.#durable.transact(CONTROLLER_NAMESPACE, core.workspaceId, currentInput => {
			const current = controllerState(core.workspaceId, currentInput);
			if (current.deletion) {
				if (current.deletion.proof.deleteId !== core.deleteId) {
					return {
						state: current,
						result: {
							status: "delete_conflict",
							code: "different_delete_id",
							currentDeleteId: current.deletion.proof.deleteId,
						} as const,
					};
				}
				const same =
					current.deletion.expectedGeneration === core.expectedCheckpoint.generation &&
					current.deletion.expectedRuntimeAttachmentCreateId === core.expectedRuntimeAttachmentCreateId &&
					current.deletion.expectedRuntimeAttachmentRevision === core.expectedRuntimeAttachmentRevision &&
					current.deletion.proof.deletionPlanCoreSha256 === request.deletionPlanCoreSha256 &&
					current.deletion.proof.deletionPlanSha256 === request.deletionPlanSha256;
				return same
					? { state: current, result: { status: "acquired", authority: current.deletion } as const }
					: {
							state: current,
							result: {
								status: "delete_conflict",
								code: "same_id_different_expectation",
								currentDeleteId: core.deleteId,
							} as const,
						};
			}
			const observedAt = this.#now();
			const deletionEpoch = current.deletionEpoch + 1;
			const controllerEpoch = current.controllerEpoch + 1;
			const proof: WorkspaceDeletionAuthorityProof = {
				workspaceId: core.workspaceId,
				deleteId: core.deleteId,
				deletionAuthorityId: core.deletionAuthorityId,
				deletionPlanCoreSha256: request.deletionPlanCoreSha256,
				deletionPlanSha256: request.deletionPlanSha256,
				agentId: request.ownership.agentId,
				controlHostId: request.ownership.controlHostId,
				ownerEpoch: request.ownership.ownerEpoch,
				epoch: deletionEpoch,
			};
			const authority: WorkspaceDeletionAuthority = {
				proof,
				expectedGeneration: core.expectedCheckpoint.generation,
				expectedRuntimeAttachmentCreateId: core.expectedRuntimeAttachmentCreateId,
				expectedRuntimeAttachmentRevision: core.expectedRuntimeAttachmentRevision,
				invalidatedControllerEpoch: controllerEpoch,
				verification: null,
				acquiredAt: observedAt,
				renewBy: renewalDeadline(observedAt, request.ttlMs),
				expiresAt: addMilliseconds(observedAt, request.ttlMs),
			};
			return {
				state: { ...current, controllerEpoch, controller: null, deletionEpoch, deletion: authority },
				result: { status: "acquired", authority } as const,
			};
		});
	}

	async renewDeletion(request: Parameters<WorkspaceDeletionAuthorityStore["renew"]>[0]) {
		return this.#durable.transact(CONTROLLER_NAMESPACE, request.proof.workspaceId, currentInput => {
			const current = controllerState(request.proof.workspaceId, currentInput);
			if (
				!current.deletion ||
				!deletionProofMatches(current.deletion.proof, request.proof) ||
				!ownershipMatches(request.proof, request.ownership) ||
				Date.parse(current.deletion.expiresAt) <= Date.parse(this.#now())
			) {
				return { state: current, result: { status: "lost" } as const };
			}
			const observedAt = this.#now();
			const authority: WorkspaceDeletionAuthority = {
				...current.deletion,
				renewBy: renewalDeadline(observedAt, request.ttlMs),
				expiresAt: addMilliseconds(observedAt, request.ttlMs),
			};
			return { state: { ...current, deletion: authority }, result: { status: "renewed", authority } as const };
		});
	}

	async inspectDeletion(workspaceId: WorkspaceId) {
		const current = controllerState(workspaceId, await this.#durable.inspect(CONTROLLER_NAMESPACE, workspaceId));
		if (current.tombstone) return { status: "tombstoned", tombstone: current.tombstone } as const;
		if (!current.deletion) return { status: "absent", workspaceId } as const;
		return Date.parse(current.deletion.expiresAt) <= Date.parse(this.#now())
			? ({ status: "expired", authority: deletionObservation(current.deletion) } as const)
			: ({ status: "active", authority: deletionObservation(current.deletion) } as const);
	}

	async verify(
		request: Parameters<WorkspaceDeletionAuthorityStore["verify"]>[0],
	): Promise<WorkspaceDeletionVerificationResultV1> {
		const attachment = decodeRuntimeAttachmentRecordV1(request.attachment, request.proof.workspaceId);
		return this.#durable.transact(CONTROLLER_NAMESPACE, request.proof.workspaceId, async currentInput => {
			const current = controllerState(request.proof.workspaceId, currentInput);
			if (
				!current.deletion ||
				!deletionProofMatches(current.deletion.proof, request.proof) ||
				!ownershipMatches(request.proof, request.ownership)
			)
				return { state: current, result: { status: "lost" } as const };
			if (request.observedCanonicalGeneration !== current.deletion.expectedGeneration) {
				return { state: current, result: { status: "mismatch", code: "canonical_generation_mismatch" } as const };
			}
			if (attachment.workspaceId !== request.proof.workspaceId) {
				return { state: current, result: { status: "mismatch", code: "attachment_workspace_mismatch" } as const };
			}
			if (attachment.createId !== current.deletion.expectedRuntimeAttachmentCreateId) {
				return { state: current, result: { status: "mismatch", code: "attachment_create_id_mismatch" } as const };
			}
			if (attachment.revision !== current.deletion.expectedRuntimeAttachmentRevision) {
				return { state: current, result: { status: "mismatch", code: "attachment_revision_mismatch" } as const };
			}
			if (attachment.attachment.state !== "none") {
				return { state: current, result: { status: "mismatch", code: "attachment_not_none" } as const };
			}
			const verifiedAt = this.#now();
			const receiptSha256 = `sha256:${await canonicalRuntimeSha256([
				"omp-workspace-deletion-verification-v1",
				request.proof.workspaceId,
				request.proof.deleteId,
				request.proof.deletionAuthorityId,
				request.proof.deletionPlanCoreSha256,
				request.proof.deletionPlanSha256,
				request.proof.epoch,
				request.observedCanonicalGeneration,
				attachment.createId,
				attachment.revision,
				"none",
				verifiedAt,
			])}` as Sha256Ref;
			const receipt: WorkspaceDeletionVerificationReceiptV1 = {
				schemaVersion: 1,
				workspaceId: request.proof.workspaceId,
				deleteId: request.proof.deleteId,
				deletionAuthorityId: request.proof.deletionAuthorityId,
				deletionPlanCoreSha256: request.proof.deletionPlanCoreSha256,
				deletionPlanSha256: request.proof.deletionPlanSha256,
				deletionEpoch: request.proof.epoch,
				canonicalGeneration: request.observedCanonicalGeneration,
				runtimeAttachmentCreateId: attachment.createId,
				runtimeAttachmentRevision: attachment.revision,
				runtimeAttachmentState: "none",
				verifiedAt,
				receiptSha256,
			};
			if (current.deletion.verification) {
				return exactJson(current.deletion.verification, receipt)
					? {
							state: current,
							result: { status: "already_verified", receipt: current.deletion.verification } as const,
						}
					: { state: current, result: { status: "conflict", current: current.deletion.verification } as const };
			}
			const authority: WorkspaceDeletionAuthority = { ...current.deletion, verification: receipt };
			return { state: { ...current, deletion: authority }, result: { status: "verified", receipt } as const };
		});
	}

	async releaseDeletion(request: Parameters<WorkspaceDeletionAuthorityStore["release"]>[0]) {
		return this.#durable.transact(CONTROLLER_NAMESPACE, request.proof.workspaceId, currentInput => {
			const current = controllerState(request.proof.workspaceId, currentInput);
			if (!current.deletion) return { state: current, result: { status: "already_released" } as const };
			if (
				!deletionProofMatches(current.deletion.proof, request.proof) ||
				!ownershipMatches(request.proof, request.ownership)
			) {
				return { state: current, result: { status: "lost" } as const };
			}
			return { state: { ...current, deletion: null }, result: { status: "released" } as const };
		});
	}

	async authorizePersistentController(
		proof: WorkspaceControllerLeaseProof,
	): Promise<PersistentControllerAuthorizationV1> {
		const current = controllerState(
			proof.workspaceId,
			await this.#durable.inspect(CONTROLLER_NAMESPACE, proof.workspaceId),
		);
		if (current.deletion) return { status: "deletion_latched", deleteId: current.deletion.proof.deleteId };
		if (
			!current.controller ||
			!leaseProofMatches(current.controller.proof, proof) ||
			Date.parse(current.controller.expiresAt) <= Date.parse(this.#now())
		)
			return { status: "controller_lost" };
		return { status: "current" };
	}

	async authorizePersistentDeletion(proof: WorkspaceDeletionAuthorityProof): Promise<boolean> {
		const current = controllerState(
			proof.workspaceId,
			await this.#durable.inspect(CONTROLLER_NAMESPACE, proof.workspaceId),
		);
		return (
			current.deletion !== null &&
			deletionProofMatches(current.deletion.proof, proof) &&
			Date.parse(current.deletion.expiresAt) > Date.parse(this.#now())
		);
	}

	async authorizePersistentCleanupProof(
		deletionProof: WorkspaceDeletionAuthorityProof,
		cleanupProof: TerminalReplicaCleanupProofV1,
	): Promise<boolean> {
		if (!(await this.authorizePersistentDeletion(deletionProof))) return false;
		return this.#authorizePersistentCleanupProof(deletionProof, cleanupProof);
	}

	async authorizeTransientController(proof: TransientTaskControllerAuthorityProofV1) {
		const store = new TransientTaskWorkspaceAuthorityStore({ durable: this.#durable, now: this.#now });
		return store.authorizeController(proof);
	}

	async authorizeTransientCleanup(proof: TransientTaskCleanupAuthorityProofV1): Promise<boolean> {
		const store = new TransientTaskWorkspaceAuthorityStore({ durable: this.#durable, now: this.#now });
		return store.authorizeCleanup(proof);
	}

	readonly deletionStore: WorkspaceDeletionAuthorityStore = {
		acquire: request => this.acquireDeletion(request),
		renew: request => this.renewDeletion(request),
		inspect: workspaceId => this.inspectDeletion(workspaceId),
		verify: request => this.verify(request),
		release: request => this.releaseDeletion(request),
	};
}
