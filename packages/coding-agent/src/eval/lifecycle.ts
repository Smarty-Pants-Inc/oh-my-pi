import { createHash, randomUUID } from "node:crypto";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { OperationId, Sha256Ref } from "../registry/persistent-agent-contracts";
import type { AgentSessionTransientEvalInlineDynamicInvocationV1 } from "../session/agent-session-types";
import {
	type ConfidentialTransientEvalToolSourceObservationInputV1,
	type ConfidentialTransientTaskForegroundBeforeReturnRecordV1,
	type ConfidentialTransientTaskForegroundBeforeReturnSuspensionV1,
	type ConfidentialTransientTaskForegroundPendingTtsrOverlayBindingV1,
	type ConfidentialTransientTaskForegroundResultHandoffBatchV1,
	type ConfidentialTransientTaskForegroundResultHandoffV1,
	type ConfidentialTransientTaskSourceObservationReceiptV1,
	type ConfidentialTransientTaskSourceObservationResultV1,
	deriveTransientTaskEffectOperationIdV1,
	deriveTransientTaskForegroundAppendBatchKeyV1,
	type TransientEvalInlineDynamicDispatchClassificationV1,
	type TransientTaskForegroundPreReturnIdentityEnvelopeListV1,
	type TransientTaskForegroundPreReturnIdentityV1,
	type TransientTaskPostTerminalCleanupEvidenceV1,
} from "../session/workspace-runtime-contracts";
import {
	createStructuredSubagentTransientTaskRuntimeV1,
	type EffectiveSubagentPolicy,
	type StructuredSubagentForegroundHandoffIdentityV1,
	type StructuredSubagentTransientTaskRuntimeAssemblyV1,
} from "../task/structured-subagent";
import {
	StructuredSubagentError,
	validateAndProjectTransientEvalForegroundSourceAgentToolResultV1,
} from "../task/types";
import type { ToolSession } from "../tools";

const stringifyEvalForeground = JSON.stringify.bind(JSON);

function evalForegroundSha256(value: string): Sha256Ref {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}` as Sha256Ref;
}

function evalForegroundTupleSha256(tuple: readonly unknown[]): Sha256Ref {
	const value = stringifyEvalForeground(tuple);
	if (value === undefined) throw new TypeError("Eval foreground canonical tuple is not JSON-representable");
	return evalForegroundSha256(value);
}

function evalForegroundOperationId(): OperationId {
	return randomUUID() as OperationId;
}

function resultTargetTuple(key: StructuredSubagentForegroundHandoffIdentityV1["resultTargetKey"]): readonly unknown[] {
	return [
		key.taskId,
		key.runId,
		key.createId,
		key.resultPublicationId,
		key.resultPublicationTargetId,
		key.resultPublicationTargetCleanupId,
	];
}

function pendingForever(): Promise<never> {
	return new Promise<never>(() => {});
}

interface EvalAgentSpawnClaimV1 {
	readonly spawnIndex: number;
	readonly normalizedArgsSha256: Sha256Ref;
}

interface EvalForegroundCompletedChildV1 {
	readonly spawnIndex: number;
	readonly handoffIdentity: StructuredSubagentForegroundHandoffIdentityV1;
}

export interface EvalAgentLifecycleContextV1 {
	claimAgentBridgeCall(bridgeCallKey: string, normalizedArgs: unknown): number;
	createIsolatedRuntime(
		spawnIndex: number,
		childId: string,
		policy: EffectiveSubagentPolicy,
	): Promise<StructuredSubagentTransientTaskRuntimeAssemblyV1>;
	recordTerminal(spawnIndex: number, evidence: TransientTaskPostTerminalCleanupEvidenceV1): void;
	recordResultful(spawnIndex: number, handoffIdentity: StructuredSubagentForegroundHandoffIdentityV1): void;
	complete<Result extends AgentToolResult>(sourceResult: Result): Promise<Result>;
	readonly parentToolCallId: string;
}

class EvalAgentLifecycleContext implements EvalAgentLifecycleContextV1 {
	readonly #claims = new Map<string, EvalAgentSpawnClaimV1>();
	readonly #created = new Map<number, StructuredSubagentTransientTaskRuntimeAssemblyV1>();
	readonly #terminal = new Map<number, TransientTaskPostTerminalCleanupEvidenceV1>();
	readonly #resultful = new Map<number, EvalForegroundCompletedChildV1>();
	#nextSpawnIndex = 0;
	#invocation: Promise<AgentSessionTransientEvalInlineDynamicInvocationV1> | undefined;
	readonly #session: ToolSession;
	readonly #toolCallId: string;
	readonly #effectiveArgs: unknown;

	constructor(session: ToolSession, toolCallId: string, effectiveArgs: unknown) {
		this.#session = session;
		this.#toolCallId = toolCallId;
		this.#effectiveArgs = effectiveArgs;
	}

	get parentToolCallId(): string {
		return this.#toolCallId;
	}

	claimAgentBridgeCall(bridgeCallKey: string, normalizedArgs: unknown): number {
		if (!bridgeCallKey) throw new StructuredSubagentError("preflight", "Eval agent bridge call identity is missing.");
		const normalizedArgsUtf8 = stringifyEvalForeground(normalizedArgs);
		if (normalizedArgsUtf8 === undefined) {
			throw new StructuredSubagentError("preflight", "Eval agent arguments are not canonically representable.");
		}
		const normalizedArgsSha256 = evalForegroundSha256(normalizedArgsUtf8);
		const existing = this.#claims.get(bridgeCallKey);
		if (existing) {
			if (existing.normalizedArgsSha256 !== normalizedArgsSha256) {
				throw new StructuredSubagentError(
					"preflight",
					"Eval agent bridge call identity was reused with different arguments.",
				);
			}
			return existing.spawnIndex;
		}
		const spawnIndex = this.#nextSpawnIndex++;
		this.#claims.set(bridgeCallKey, { spawnIndex, normalizedArgsSha256 });
		return spawnIndex;
	}

	async #ensureInvocation(): Promise<AgentSessionTransientEvalInlineDynamicInvocationV1> {
		if (!this.#invocation) {
			const begin = this.#session.beginTransientEvalInlineDynamicInvocation;
			if (typeof begin !== "function") {
				throw new StructuredSubagentError(
					"preflight",
					"Isolated eval execution requires session-owned Eval foreground lifecycle authority.",
				);
			}
			this.#invocation = begin.call(this.#session, this.#toolCallId, this.#effectiveArgs).then(invocation => {
				if (!invocation) {
					throw new StructuredSubagentError(
						"preflight",
						"Isolated eval execution requires the exact persisted outer Eval tool-call authority.",
					);
				}
				return invocation;
			});
		}
		return this.#invocation;
	}

	async createIsolatedRuntime(
		spawnIndex: number,
		childId: string,
		policy: EffectiveSubagentPolicy,
	): Promise<StructuredSubagentTransientTaskRuntimeAssemblyV1> {
		if (this.#created.has(spawnIndex)) {
			throw new StructuredSubagentError(
				"preflight",
				"Eval isolated child spawn index was assembled more than once.",
			);
		}
		const invocation = await this.#ensureInvocation();
		const assembly = await createStructuredSubagentTransientTaskRuntimeV1({
			authority: invocation.runtimeAuthority,
			parentToolCallId: this.#toolCallId,
			spawnIndex,
			detachedJobId: null,
			childId,
			agentName: policy.agent.name,
			captureMode: policy.mergeMode,
			applyChanges: policy.applyChanges,
		});
		this.#created.set(spawnIndex, assembly);
		return assembly;
	}

	recordTerminal(spawnIndex: number, evidence: TransientTaskPostTerminalCleanupEvidenceV1): void {
		if (!this.#created.has(spawnIndex)) {
			throw new StructuredSubagentError(
				"execution",
				"Eval isolated child terminal evidence lacks a created runtime.",
			);
		}
		const existing = this.#terminal.get(spawnIndex);
		if (existing && stringifyEvalForeground(existing) !== stringifyEvalForeground(evidence)) {
			throw new StructuredSubagentError("execution", "Eval isolated child terminal evidence changed.");
		}
		this.#terminal.set(spawnIndex, evidence);
	}

	recordResultful(spawnIndex: number, handoffIdentity: StructuredSubagentForegroundHandoffIdentityV1): void {
		if (!this.#terminal.has(spawnIndex)) {
			throw new StructuredSubagentError(
				"execution",
				"Eval isolated child result became visible before terminal evidence.",
			);
		}
		const child = { spawnIndex, handoffIdentity };
		const existing = this.#resultful.get(spawnIndex);
		if (existing && stringifyEvalForeground(existing) !== stringifyEvalForeground(child)) {
			throw new StructuredSubagentError("execution", "Eval isolated child handoff identity changed.");
		}
		this.#resultful.set(spawnIndex, child);
	}

	async #recordObservation(
		invocation: AgentSessionTransientEvalInlineDynamicInvocationV1,
		observationInput: ConfidentialTransientEvalToolSourceObservationInputV1,
	): Promise<ConfidentialTransientTaskSourceObservationReceiptV1> {
		const observedAt = new Date().toISOString();
		const core = {
			indexKey: invocation.indexKey,
			producer: "eval_tool" as const,
			observationInput,
			reservationId: evalForegroundOperationId(),
			observedAt,
			requestedAt: observedAt,
		};
		const result =
			await invocation.authority.sourceObservationProducer.reserveAndFreezeTransientTaskSourceObservationDraft({
				core,
				requestSha256: evalForegroundTupleSha256([
					"omp-agent-session-transient-task-lifecycle-v1",
					"producer-draft-request-core",
					1,
					core.indexKey,
					core.producer,
					core.observationInput,
					core.reservationId,
					core.observedAt,
					core.requestedAt,
				]),
			});
		if (result.status !== "committed" && result.status !== "already_committed") {
			throw new StructuredSubagentError(
				"execution",
				`Eval foreground source observation was rejected: ${result.status}`,
			);
		}
		return result.observationReceipt;
	}

	#createClassification(
		invocation: AgentSessionTransientEvalInlineDynamicInvocationV1,
	): TransientEvalInlineDynamicDispatchClassificationV1 {
		const classifiedAt = new Date().toISOString();
		const core = {
			schemaVersion: 1 as const,
			classification: "inline_dynamic" as const,
			toolName: "eval" as const,
			effectiveEvalArgumentsSha256: invocation.effectiveEvalArgumentsSha256,
			effectiveArgumentRevisionChainSha256: invocation.effectiveArgumentRevisionChainSha256,
			classifiedAt,
		};
		return {
			core,
			classificationSha256: evalForegroundTupleSha256([
				"omp-transient-eval-inline-dynamic-route-v1",
				"classification-core",
				1,
				core.classification,
				core.toolName,
				core.effectiveEvalArgumentsSha256,
				core.effectiveArgumentRevisionChainSha256,
				core.classifiedAt,
			]),
		};
	}

	async #suspendBeforeReturn(
		invocation: AgentSessionTransientEvalInlineDynamicInvocationV1,
		record: ConfidentialTransientTaskForegroundBeforeReturnRecordV1,
		reason: ConfidentialTransientTaskForegroundBeforeReturnSuspensionV1["reason"],
	): Promise<never> {
		const suspendedAt = new Date().toISOString();
		const projection = {
			schemaVersion: 1 as const,
			state: "before_return_suspended" as const,
			foregroundAppendBatchKeySha256: record.preallocationRequest.foregroundAppendBatchKeySha256,
			beforeReturnRecordSha256: record.recordSha256,
			returnedSourceResultSnapshotSha256: record.returnedSourceResultSnapshot.sourceSnapshotUtf8Sha256,
			reason,
		};
		const suspension: ConfidentialTransientTaskForegroundBeforeReturnSuspensionV1 = {
			schemaVersion: 1,
			record,
			projection,
			reason,
			suspendedAt,
			suspensionSha256: evalForegroundTupleSha256([
				"omp-transient-task-foreground-settlement-v1",
				"before-return-suspension-core",
				1,
				record,
				projection.foregroundAppendBatchKeySha256,
				projection.returnedSourceResultSnapshotSha256,
				reason,
				suspendedAt,
			]),
		};
		await invocation.authority.beforeReturnRecovery.persistBeforeReturnSuspension(suspension).catch(() => undefined);
		return pendingForever();
	}

	async #prepareHandoff(
		invocation: AgentSessionTransientEvalInlineDynamicInvocationV1,
		classification: TransientEvalInlineDynamicDispatchClassificationV1,
		children: readonly EvalForegroundCompletedChildV1[],
		result: ConfidentialTransientTaskSourceObservationResultV1,
	): Promise<ConfidentialTransientTaskForegroundResultHandoffBatchV1> {
		const parentSessionId = invocation.serializerKey.parentSessionId;
		const parentSessionGenerationSha256 = invocation.serializerKey.parentSessionGenerationSha256;
		const parentBranchGenerationSha256 = invocation.serializerKey.parentBranchGenerationSha256;
		const parentBranchAnchorEntryId = invocation.assistantAnchorEntryId;
		const bindingRequestedAt = new Date().toISOString();
		const bindingRequest = {
			schemaVersion: 1 as const,
			preDispatchBinding: invocation.preDispatchBinding,
			parentSessionId,
			parentSessionGenerationSha256,
			parentBranchGenerationSha256,
			parentBranchAnchorEntryId,
			toolCallId: this.#toolCallId,
			requestedAt: bindingRequestedAt,
			requestSha256: evalForegroundTupleSha256([
				"omp-transient-task-foreground-settlement-v1",
				"pending-ttsr-anchor-resolve-core",
				1,
				invocation.preDispatchBinding,
				parentSessionId,
				parentSessionGenerationSha256,
				parentBranchGenerationSha256,
				parentBranchAnchorEntryId,
				this.#toolCallId,
				bindingRequestedAt,
			]),
		};
		const bindingResult = await invocation.authority.pendingOverlayBindingResolver
			.resolveFinalizedPendingOverlayForBeforeReturn(bindingRequest)
			.catch(() => null);
		if (bindingResult === null) return pendingForever();
		if (bindingResult.status !== "resolved" && bindingResult.status !== "already_resolved") return pendingForever();
		const pendingOverlayBinding: ConfidentialTransientTaskForegroundPendingTtsrOverlayBindingV1 =
			bindingResult.binding;
		if (
			pendingOverlayBinding.parentBranchGenerationSha256 !== parentBranchGenerationSha256 ||
			pendingOverlayBinding.parentBranchAnchorEntryId !== parentBranchAnchorEntryId ||
			pendingOverlayBinding.preDispatchBinding.bindingSha256 !== invocation.preDispatchBinding.bindingSha256
		) {
			return pendingForever();
		}

		const orderedChildren = [...children].sort((left, right) => left.spawnIndex - right.spawnIndex);
		if (orderedChildren.length === 0) return pendingForever();
		for (let index = 1; index < orderedChildren.length; index++) {
			if (orderedChildren[index - 1]!.spawnIndex === orderedChildren[index]!.spawnIndex) return pendingForever();
		}

		const entryPreallocationOperationId = evalForegroundOperationId();
		const entryIdUtf8 = stringifyEvalForeground([
			"omp-transient-task-foreground-session-entry-id-v1",
			1,
			entryPreallocationOperationId,
		]);
		if (entryIdUtf8 === undefined) return pendingForever();
		const toolResultEntryId = createHash("sha256").update(entryIdUtf8, "utf8").digest("hex").slice(0, 8);
		const memberCount = orderedChildren.length;
		const orderedPreReturnIdentities = orderedChildren.map((child, foregroundMemberIndex) => {
			const target = child.handoffIdentity.resultTargetKey;
			const manifest = child.handoffIdentity.effectIdentityManifest;
			const deliverySelectorBinding = {
				resultPublicationTargetId: target.resultPublicationTargetId,
				parentSessionId,
				toolCallId: this.#toolCallId,
				foregroundMemberIndex,
			};
			const appendSelectorBinding = {
				parentSessionId,
				toolCallId: this.#toolCallId,
				foregroundMemberIndex,
			};
			const deliverySelectorUtf8 = stringifyEvalForeground([
				"omp-transient-task-parent-delivery-selector-v1",
				"foreground-settlement",
				1,
				target.resultPublicationTargetId,
				parentSessionId,
				this.#toolCallId,
				foregroundMemberIndex,
			]);
			const appendSelectorUtf8 = stringifyEvalForeground([
				"omp-transient-task-parent-delivery-selector-v1",
				"foreground-session-append",
				1,
				parentSessionId,
				this.#toolCallId,
				foregroundMemberIndex,
			]);
			if (deliverySelectorUtf8 === undefined || appendSelectorUtf8 === undefined) {
				throw new TypeError("Foreground effect selector is not JSON-representable");
			}
			const deliveryOperationId = deriveTransientTaskEffectOperationIdV1({
				namespace: "parent_delivery",
				namespaceId: manifest.parentDeliveryNamespaceId,
				domain: "foreground_settlement",
				selector: { kind: "key", keyUtf8: deliverySelectorUtf8 },
				selectorBinding: deliverySelectorBinding,
			});
			const appendOperationId = deriveTransientTaskEffectOperationIdV1({
				namespace: "parent_delivery",
				namespaceId: manifest.parentDeliveryNamespaceId,
				domain: "foreground_session_append",
				selector: { kind: "key", keyUtf8: appendSelectorUtf8 },
				selectorBinding: appendSelectorBinding,
			});
			const core = {
				...target,
				schemaVersion: 1 as const,
				effectIdentityManifestSha256: manifest.manifestSha256,
				deliveryOperationId,
				appendOperationId,
				foregroundMemberIndex,
				foregroundMemberCount: memberCount,
				parentSessionId,
				parentSessionGenerationSha256,
				parentBranchGenerationSha256,
				parentBranchAnchorEntryId,
				toolCallId: this.#toolCallId,
				toolResultSerializerKeySha256: invocation.serializerKey.serializerKeySha256,
				sourceToolCallOrdinal: invocation.sourceToolCallOrdinal,
				entryPreallocationOperationId,
				toolResultEntryId,
				returnedAgentToolResultUtf8Sha256: result.core.resultUtf8Sha256,
				returnedAgentToolResultUtf8ByteLength: result.core.resultUtf8ByteLength,
				returnedSourceResultSnapshotSha256: result.core.sourceResultSnapshot.sourceSnapshotUtf8Sha256,
				returnedSourceResultSnapshotByteLength: result.core.sourceResultSnapshot.sourceSnapshotUtf8ByteLength,
			};
			return {
				core,
				preReturnIdentitySha256: evalForegroundTupleSha256([
					"omp-transient-task-foreground-settlement-v1",
					"pre-return-identity-core",
					1,
					resultTargetTuple(target),
					core.effectIdentityManifestSha256,
					core.deliveryOperationId,
					core.appendOperationId,
					core.foregroundMemberIndex,
					core.foregroundMemberCount,
					core.parentSessionId,
					core.parentSessionGenerationSha256,
					core.parentBranchGenerationSha256,
					core.parentBranchAnchorEntryId,
					core.toolCallId,
					core.toolResultSerializerKeySha256,
					core.sourceToolCallOrdinal,
					core.entryPreallocationOperationId,
					core.toolResultEntryId,
					core.returnedAgentToolResultUtf8Sha256,
					core.returnedAgentToolResultUtf8ByteLength,
					core.returnedSourceResultSnapshotSha256,
					core.returnedSourceResultSnapshotByteLength,
				]),
			} satisfies TransientTaskForegroundPreReturnIdentityV1;
		}) as unknown as TransientTaskForegroundPreReturnIdentityEnvelopeListV1;
		const orderedPreReturnIdentitySha256s = orderedPreReturnIdentities.map(
			identity => identity.preReturnIdentitySha256,
		) as [Sha256Ref, ...Sha256Ref[]];
		const orderedAppendOperationIds = orderedPreReturnIdentities.map(identity => identity.core.appendOperationId) as [
			OperationId,
			...OperationId[],
		];
		const batchKeyInput = {
			parentSessionId,
			parentSessionGenerationSha256,
			parentBranchGenerationSha256,
			parentBranchAnchorEntryId,
			toolCallId: this.#toolCallId,
			orderedPreReturnIdentitySha256s,
		};
		const foregroundAppendBatchKeySha256 = deriveTransientTaskForegroundAppendBatchKeyV1(batchKeyInput);
		const preallocationRequest = {
			schemaVersion: 1 as const,
			entryPreallocationOperationId,
			expectedToolResultEntryId: toolResultEntryId,
			foregroundAppendBatchKeySha256,
			parentSessionId,
			parentSessionGenerationSha256,
			parentBranchGenerationSha256,
			parentBranchAnchorEntryId,
			toolCallId: this.#toolCallId,
			orderedPreReturnIdentitySha256s,
		};
		const frozenBeforeReturnAt = new Date().toISOString();
		const recordCoreTuple = [
			"omp-transient-task-foreground-settlement-v1",
			"before-return-core",
			1,
			classification,
			invocation.serializerKey.serializerKeySha256,
			invocation.sourceToolCallOrdinal,
			[
				"omp-transient-task-foreground-settlement-v1",
				"batch-key-core",
				1,
				parentSessionId,
				parentSessionGenerationSha256,
				parentBranchGenerationSha256,
				parentBranchAnchorEntryId,
				this.#toolCallId,
				orderedPreReturnIdentitySha256s,
			],
			[
				"omp-transient-task-foreground-settlement-v1",
				"entry-preallocation-core",
				1,
				entryPreallocationOperationId,
				toolResultEntryId,
				foregroundAppendBatchKeySha256,
				parentSessionId,
				parentSessionGenerationSha256,
				parentBranchGenerationSha256,
				parentBranchAnchorEntryId,
				this.#toolCallId,
				orderedPreReturnIdentitySha256s,
			],
			pendingOverlayBinding,
			result.core.sourceResult,
			result.core.sourceResultSnapshot,
			result.core.wireResult,
			result.core.resultUtf8,
			orderedPreReturnIdentities,
			orderedPreReturnIdentitySha256s,
			frozenBeforeReturnAt,
		] as const;
		const record: ConfidentialTransientTaskForegroundBeforeReturnRecordV1 = {
			schemaVersion: 1,
			dispatchClassification: classification,
			toolResultSerializerKeySha256: invocation.serializerKey.serializerKeySha256,
			sourceToolCallOrdinal: invocation.sourceToolCallOrdinal,
			batchKeyInput,
			preallocationRequest,
			pendingOverlayBinding,
			returnedAgentToolResult: result.core.sourceResult,
			returnedSourceResultSnapshot: result.core.sourceResultSnapshot,
			returnedAgentToolResultWire: result.core.wireResult,
			returnedAgentToolResultUtf8: result.core.resultUtf8,
			orderedPreReturnIdentities,
			orderedPreReturnIdentitySha256s,
			frozenBeforeReturnAt,
			recordSha256: evalForegroundTupleSha256(recordCoreTuple),
		};
		const recordPrepare = await invocation.authority.beforeReturnRecovery
			.prepareBeforeReturnRecord(record)
			.catch(() => null);
		if (recordPrepare === null) {
			return this.#suspendBeforeReturn(invocation, record, "record_prepare_response_lost");
		}
		if (recordPrepare.status !== "prepared" && recordPrepare.status !== "already_prepared") {
			const reason =
				recordPrepare.status === "pending_overlay_missing"
					? "pending_overlay_missing"
					: recordPrepare.status === "pending_overlay_conflict"
						? "pending_overlay_conflict"
						: recordPrepare.status === "session_generation_replaced"
							? "session_generation_replaced"
							: recordPrepare.status === "branch_generation_replaced"
								? "branch_generation_replaced"
								: recordPrepare.status === "branch_anchor_missing"
									? "branch_anchor_missing"
									: recordPrepare.status === "invalid"
										? "invalid"
										: "conflict";
			return this.#suspendBeforeReturn(invocation, record, reason);
		}
		const preallocation = await invocation.authority.sessionAppend
			.preallocateExactToolResultEntry(preallocationRequest)
			.catch(() => null);
		if (preallocation === null) {
			return this.#suspendBeforeReturn(invocation, record, "preallocation_response_lost");
		}
		if (preallocation.status !== "preallocated" && preallocation.status !== "already_preallocated") {
			const reason =
				preallocation.status === "session_generation_replaced"
					? "session_generation_replaced"
					: preallocation.status === "branch_generation_replaced"
						? "branch_generation_replaced"
						: preallocation.status === "branch_anchor_missing"
							? "branch_anchor_missing"
							: preallocation.status === "invalid"
								? "invalid"
								: "conflict";
			return this.#suspendBeforeReturn(invocation, record, reason);
		}
		if (
			preallocation.foregroundAppendBatchKeySha256 !== foregroundAppendBatchKeySha256 ||
			preallocation.toolResultEntryId !== toolResultEntryId
		) {
			return this.#suspendBeforeReturn(invocation, record, "conflict");
		}
		const preparedBeforeReturnAt = new Date().toISOString();
		const handoffs = orderedPreReturnIdentities.map(preReturnIdentity => {
			const handoff: ConfidentialTransientTaskForegroundResultHandoffV1 = {
				schemaVersion: 1,
				preReturnIdentity,
				pendingOverlayBinding,
				returnedAgentToolResult: result.core.sourceResult,
				returnedSourceResultSnapshot: result.core.sourceResultSnapshot,
				returnedAgentToolResultWire: result.core.wireResult,
				returnedAgentToolResultUtf8: result.core.resultUtf8,
				preparedBeforeReturnAt,
				handoffSha256: evalForegroundTupleSha256([
					"omp-transient-task-foreground-settlement-v1",
					"handoff-core",
					1,
					preReturnIdentity,
					pendingOverlayBinding,
					result.core.sourceResult,
					result.core.sourceResultSnapshot,
					result.core.wireResult,
					result.core.resultUtf8,
					preparedBeforeReturnAt,
				]),
			};
			return handoff;
		}) as [
			ConfidentialTransientTaskForegroundResultHandoffV1,
			...ConfidentialTransientTaskForegroundResultHandoffV1[],
		];
		const batchCore = [
			"omp-transient-task-foreground-settlement-v1",
			"handoff-batch-core",
			1,
			parentSessionId,
			this.#toolCallId,
			invocation.serializerKey.serializerKeySha256,
			invocation.sourceToolCallOrdinal,
			foregroundAppendBatchKeySha256,
			toolResultEntryId,
			pendingOverlayBinding,
			orderedAppendOperationIds,
			orderedPreReturnIdentities,
			orderedPreReturnIdentitySha256s,
			result.core.resultUtf8Sha256,
			result.core.resultUtf8ByteLength,
			result.core.sourceResultSnapshot.sourceSnapshotUtf8Sha256,
			result.core.sourceResultSnapshot.sourceSnapshotUtf8ByteLength,
			handoffs,
		] as const;
		const batch: ConfidentialTransientTaskForegroundResultHandoffBatchV1 = {
			schemaVersion: 1,
			parentSessionId,
			toolCallId: this.#toolCallId,
			toolResultSerializerKeySha256: invocation.serializerKey.serializerKeySha256,
			sourceToolCallOrdinal: invocation.sourceToolCallOrdinal,
			foregroundAppendBatchKeySha256,
			toolResultEntryId,
			pendingOverlayBinding,
			orderedAppendOperationIds,
			orderedPreReturnIdentities,
			orderedPreReturnIdentitySha256s,
			returnedAgentToolResultUtf8Sha256: result.core.resultUtf8Sha256,
			returnedAgentToolResultUtf8ByteLength: result.core.resultUtf8ByteLength,
			returnedSourceResultSnapshotSha256: result.core.sourceResultSnapshot.sourceSnapshotUtf8Sha256,
			returnedSourceResultSnapshotByteLength: result.core.sourceResultSnapshot.sourceSnapshotUtf8ByteLength,
			handoffs,
			handoffBatchSha256: evalForegroundTupleSha256(batchCore),
		};
		const prepared = await invocation.authority.settlement.prepareHandoff(batch).catch(() => null);
		if (prepared === null) {
			return this.#suspendBeforeReturn(invocation, record, "handoff_prepare_response_lost");
		}
		if (prepared.status !== "prepared" && prepared.status !== "already_prepared") {
			const reason =
				prepared.status === "session_generation_replaced"
					? "session_generation_replaced"
					: prepared.status === "branch_generation_replaced"
						? "branch_generation_replaced"
						: prepared.status === "invalid"
							? "invalid"
							: "conflict";
			return this.#suspendBeforeReturn(invocation, record, reason);
		}
		if (
			prepared.handoffBatchSha256 !== batch.handoffBatchSha256 ||
			stringifyEvalForeground(prepared.orderedPreReturnIdentitySha256s) !==
				stringifyEvalForeground(orderedPreReturnIdentitySha256s)
		) {
			return this.#suspendBeforeReturn(invocation, record, "conflict");
		}
		return batch;
	}

	async complete<Result extends AgentToolResult>(sourceResult: Result): Promise<Result> {
		if (!this.#invocation) return sourceResult;
		const invocation = await this.#invocation;
		if (this.#terminal.size !== this.#created.size) {
			throw new StructuredSubagentError(
				"execution",
				"Eval execution completed before every created isolated child had exact terminal evidence.",
			);
		}
		const projectionResult = validateAndProjectTransientEvalForegroundSourceAgentToolResultV1(sourceResult);
		const returnedResult = (
			projectionResult.status === "projected"
				? projectionResult.sourceResult
				: projectionResult.rejection.core.toolResult
		) as Result;
		const resultProjection =
			projectionResult.status === "projected"
				? projectionResult.projection
				: projectionResult.rejection.core.toolResultProjection;
		const classification = this.#createClassification(invocation);
		const createdInlineChildCount = this.#created.size;
		const terminalizedInlineChildCount = this.#terminal.size;
		const resultfulInlineChildCount = projectionResult.status === "projected" ? this.#resultful.size : 0;
		const hasHandoff = resultfulInlineChildCount > 0;
		const observationInput = {
			schemaVersion: 1 as const,
			eventKind: "eval_execute_result_classification" as const,
			executeEntryObservationReceipt: invocation.executeEntryObservationReceipt,
			result: resultProjection,
			dispatchClassification: classification,
			resultDisposition: hasHandoff
				? ("eval_inline_dynamic_handoff_present" as const)
				: ("eval_inline_dynamic_executed_without_handoff" as const),
			noHandoffReason: hasHandoff
				? null
				: projectionResult.status === "rejected"
					? ("source_value_unrepresentable" as const)
					: ("zero_resultful_inline_children" as const),
			...(projectionResult.status === "rejected" ? { sourceProjectionRejection: projectionResult.rejection } : {}),
			createdInlineChildCount,
			terminalizedInlineChildCount,
			resultfulInlineChildCount,
		};
		const receipt = await this.#recordObservation(invocation, observationInput);
		if (receipt.core.eventKind !== "eval_execute_result_classification") {
			throw new StructuredSubagentError("execution", "Eval execute-result observation receipt changed event kind.");
		}
		if (hasHandoff) {
			await this.#prepareHandoff(invocation, classification, [...this.#resultful.values()], resultProjection);
		}
		return returnedResult;
	}
}

export function createEvalAgentLifecycleV1(
	session: ToolSession,
	toolCallId: string,
	effectiveArgs: unknown,
): EvalAgentLifecycleContextV1 {
	return new EvalAgentLifecycleContext(session, toolCallId, effectiveArgs);
}
