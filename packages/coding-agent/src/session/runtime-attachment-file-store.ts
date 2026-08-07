import type { ISO8601, OperationId, WorkspaceId } from "../registry/persistent-agent-contracts.js";
import type { RuntimeDurableStateStoreV1, RuntimeWorkspaceAuthorityV1 } from "./managed-workspace.js";
import type { RuntimeTimingStateV1, WorkspaceControllerStateV1 } from "./workspace-controller-codecs.js";
import {
	advanceRuntimeTiming,
	CONTROLLER_NAMESPACE,
	controllerState,
	decodeRuntimeAttachmentRecordV1,
	exactJson,
	initialRuntimeTiming,
	runtimeTimingReadersV1,
} from "./workspace-controller-codecs.js";
import type { RuntimeAttachmentRecordV1, RuntimeAttachmentStore } from "./workspace-runtime-contracts.js";

export class RuntimeAttachmentFileStoreV1 implements RuntimeAttachmentStore {
	readonly #durable: RuntimeDurableStateStoreV1;
	readonly #authority: RuntimeWorkspaceAuthorityV1;

	constructor(options: {
		readonly durable: RuntimeDurableStateStoreV1;
		readonly authority: RuntimeWorkspaceAuthorityV1;
	}) {
		this.#durable = options.durable;
		this.#authority = options.authority;
		runtimeTimingReadersV1.set(this, async workspaceId => {
			const current = controllerState(workspaceId, await this.#durable.inspect(CONTROLLER_NAMESPACE, workspaceId));
			return current.timing;
		});
	}

	async create(request: Parameters<RuntimeAttachmentStore["create"]>[0]) {
		const workspaceId = request.controllerLease.workspaceId;
		let initial: RuntimeAttachmentRecordV1;
		try {
			initial = decodeRuntimeAttachmentRecordV1(request.initial, workspaceId);
		} catch {
			return {
				status: "invalid",
				workspaceId,
				createId: request.createId,
				code: "record_invariant_violation",
			} as const;
		}
		if (
			initial.createId !== request.createId ||
			initial.revision !== 1 ||
			initial.attachment.state !== "none" ||
			initial.attachment.transitionId !== null ||
			initial.attachment.active !== null ||
			initial.scheduler.decision.status !== "not_evaluated" ||
			initial.scheduler.input !== null ||
			initial.scheduler.evaluatedAt !== null ||
			initial.lastCompletedTransition !== null
		) {
			return {
				status: "invalid",
				workspaceId,
				createId: request.createId,
				code: "record_invariant_violation",
			} as const;
		}
		try {
			controllerState(workspaceId, await this.#durable.inspect(CONTROLLER_NAMESPACE, workspaceId));
		} catch {
			return {
				status: "invalid",
				workspaceId,
				createId: request.createId,
				code: "record_invariant_violation",
			} as const;
		}
		const authorization = await this.#authority.authorizePersistentController(request.controllerLease);
		if (authorization.status !== "current") return authorization;
		return this.#durable.transact(CONTROLLER_NAMESPACE, workspaceId, currentInput => {
			let current: WorkspaceControllerStateV1;
			try {
				current = controllerState(workspaceId, currentInput);
			} catch {
				return {
					state: currentInput,
					result: {
						status: "invalid",
						workspaceId,
						createId: request.createId,
						code: "record_invariant_violation",
					} as const,
				};
			}
			if (!current.attachment) {
				const timing = initialRuntimeTiming(initial);
				return {
					state: { ...current, attachment: initial, timing },
					result: { status: "complete", disposition: "created", record: initial } as const,
				};
			}
			if (current.attachment.createId !== request.createId) {
				return {
					state: current,
					result: {
						status: "conflict",
						workspaceId,
						createId: request.createId,
						code: "create_id_mismatch",
						existingCreateId: current.attachment.createId,
					} as const,
				};
			}
			if (current.attachment.revision === 1 && exactJson(current.attachment, initial)) {
				return {
					state: current,
					result: { status: "complete", disposition: "already_complete", record: current.attachment } as const,
				};
			}
			return {
				state: current,
				result: {
					status: "conflict",
					workspaceId,
					createId: request.createId,
					code: "record_advanced",
					existingCreateId: current.attachment.createId,
				} as const,
			};
		});
	}

	async inspectCreate(request: Parameters<RuntimeAttachmentStore["inspectCreate"]>[0]) {
		let current: WorkspaceControllerStateV1;
		try {
			current = controllerState(
				request.workspaceId,
				await this.#durable.inspect(CONTROLLER_NAMESPACE, request.workspaceId),
			);
		} catch {
			return {
				status: "invalid",
				workspaceId: request.workspaceId,
				createId: request.createId,
				code: "record_invariant_violation",
			} as const;
		}
		if (!current.attachment)
			return { status: "missing", workspaceId: request.workspaceId, createId: request.createId } as const;
		return current.attachment.createId === request.createId
			? ({ status: "complete", record: current.attachment } as const)
			: ({
					status: "conflict",
					workspaceId: request.workspaceId,
					createId: request.createId,
					code: "create_id_mismatch",
					existingCreateId: current.attachment.createId,
				} as const);
	}

	async abortCreate(request: Parameters<RuntimeAttachmentStore["abortCreate"]>[0]) {
		try {
			controllerState(request.workspaceId, await this.#durable.inspect(CONTROLLER_NAMESPACE, request.workspaceId));
		} catch {
			return {
				status: "invalid",
				workspaceId: request.workspaceId,
				createId: request.createId,
				code: "record_invariant_violation",
			} as const;
		}
		const authorization = await this.#authority.authorizePersistentController(request.controllerLease);
		if (authorization.status !== "current") return authorization;
		return this.#durable.transact(CONTROLLER_NAMESPACE, request.workspaceId, currentInput => {
			let current: WorkspaceControllerStateV1;
			try {
				current = controllerState(request.workspaceId, currentInput);
			} catch {
				return {
					state: currentInput,
					result: {
						status: "invalid",
						workspaceId: request.workspaceId,
						createId: request.createId,
						code: "record_invariant_violation",
					} as const,
				};
			}
			if (!current.attachment)
				return {
					state: current,
					result: {
						status: "missing",
						disposition: "already_missing",
						workspaceId: request.workspaceId,
						createId: request.createId,
					} as const,
				};
			if (current.attachment.createId !== request.createId || current.attachment.revision !== 1) {
				return {
					state: current,
					result: {
						status: "conflict",
						workspaceId: request.workspaceId,
						createId: request.createId,
						code: current.attachment.createId !== request.createId ? "create_id_mismatch" : "record_advanced",
						existingCreateId: current.attachment.createId,
					} as const,
				};
			}
			return {
				state: { ...current, attachment: null, timing: null },
				result: {
					status: "missing",
					disposition: "aborted",
					workspaceId: request.workspaceId,
					createId: request.createId,
				} as const,
			};
		});
	}

	async readTransitionStartedAt(workspaceId: WorkspaceId, expectedTransitionId: OperationId): Promise<ISO8601> {
		const current = controllerState(workspaceId, await this.#durable.inspect(CONTROLLER_NAMESPACE, workspaceId));
		const transition = current.timing?.transition;
		if (!transition || transition.transitionId !== expectedTransitionId) {
			throw new Error("Runtime transition timing is missing or mismatched");
		}
		return transition.startedAt;
	}

	async read(workspaceId: WorkspaceId) {
		let current: WorkspaceControllerStateV1;
		try {
			current = controllerState(workspaceId, await this.#durable.inspect(CONTROLLER_NAMESPACE, workspaceId));
		} catch {
			return { status: "invalid", workspaceId, code: "record_invariant_violation" } as const;
		}
		return current.attachment
			? ({ status: "present", record: current.attachment } as const)
			: ({ status: "missing", workspaceId } as const);
	}

	async replace(request: Parameters<RuntimeAttachmentStore["replace"]>[0]) {
		const workspaceId = request.controllerLease.workspaceId;
		let next: RuntimeAttachmentRecordV1;
		try {
			next = decodeRuntimeAttachmentRecordV1(request.next, workspaceId);
		} catch {
			return { status: "invalid", workspaceId, code: "record_invariant_violation" } as const;
		}
		try {
			controllerState(workspaceId, await this.#durable.inspect(CONTROLLER_NAMESPACE, workspaceId));
		} catch {
			return { status: "invalid", workspaceId, code: "record_invariant_violation" } as const;
		}
		const authorization = await this.#authority.authorizePersistentController(request.controllerLease);
		if (authorization.status !== "current") return authorization;
		return this.#durable.transact(CONTROLLER_NAMESPACE, workspaceId, currentInput => {
			let current: WorkspaceControllerStateV1;
			try {
				current = controllerState(workspaceId, currentInput);
			} catch {
				return {
					state: currentInput,
					result: { status: "invalid", workspaceId, code: "record_invariant_violation" } as const,
				};
			}
			if (!current.attachment || !current.timing) {
				return { state: current, result: { status: "missing", workspaceId } as const };
			}
			if (current.attachment.createId !== next.createId) {
				return {
					state: current,
					result: { status: "create_id_conflict", currentCreateId: current.attachment.createId } as const,
				};
			}
			if (current.attachment.revision !== request.expectedRevision) {
				return {
					state: current,
					result: { status: "revision_conflict", currentRevision: current.attachment.revision } as const,
				};
			}
			if (next.revision !== request.expectedRevision + 1) {
				return {
					state: current,
					result: { status: "invalid", workspaceId, code: "record_invariant_violation" } as const,
				};
			}
			let timing: RuntimeTimingStateV1;
			try {
				timing = advanceRuntimeTiming(current.timing, next);
			} catch {
				return {
					state: current,
					result: { status: "invalid", workspaceId, code: "record_invariant_violation" } as const,
				};
			}
			return {
				state: { ...current, attachment: next, timing },
				result: { status: "replaced", record: next } as const,
			};
		});
	}
}
