import type {
	Agent,
	AgentMessage,
	AgentTool,
	AgentToolContext,
	StreamFn,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	Context,
	Effort,
	ImageContent,
	Message,
	MessageAttribution,
	Model,
	OAuthAccountSummary,
	ServiceTierByFamily,
	SimpleStreamOptions,
	ToolChoice,
} from "@oh-my-pi/pi-ai";
import type { postmortem } from "@oh-my-pi/pi-utils";
import type { AdvisorConfig } from "../advisor";
import type { AsyncJob, AsyncJobDeliveryState, AsyncJobManager } from "../async";
import type { ModelConnectionResolver } from "../config/model-connection-contracts.js";
import type { ModelRegistry } from "../config/model-registry";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings, SkillsSettings } from "../config/settings";
import type { CursorMcpResourceAdapter } from "../cursor";
import type { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import type { TtsrManager } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { ExtensionRunner } from "../extensibility/extensions";
import type { ContextUsage } from "../extensibility/extensions/types";
import type { Skill, SkillWarning } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import type {
	ISO8601,
	OperationId,
	PersistentAgentStore,
	PersistentToolSet,
	Sha256Ref,
} from "../registry/persistent-agent-contracts.js";
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { XdevState } from "../tools/xdev";
import type { CodexAutoRedeemCoordinator } from "./codex-auto-reset";
import type { ExecutionEnvironmentProvider } from "./execution-environment";
import type { SessionJournalService } from "./session-journal-contracts.js";
import type { SessionManager } from "./session-manager";
import type { TransientTaskRuntimeStoreFacadeV1 } from "./workspace-controller.js";
import type {
	AgentSessionTransientTaskLifecycleObservationAdapterV1,
	AgentSessionTransientTaskSourceObservationProducerV1,
	ConfidentialAgentSessionToolResultSerializerKeyV1,
	ConfidentialAgentSessionTransientTaskLifecycleAuthorityV1,
	ConfidentialAgentSessionTransientTaskSourceObservationProducerResultV1,
	ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1,
	ConfidentialTransientEvalExecuteEntryObservationReceiptV1,
	ConfidentialTransientTaskForegroundPendingTtsrOverlayPreDispatchBindingV1,
	ConfidentialTransientTaskForegroundPendingTtsrOverlaySnapshotV1,
	ConfidentialTransientTaskHubWaitMessageAfterToolCallPlanV1,
	ConfidentialTransientTaskHubWaitMessageCurrentParentSessionAuthorityV1,
	ConfidentialTransientTaskLifecycleGateStateV1,
	ConfidentialTransientTaskPendingCaptureIndexKeyV1,
	ConfidentialTransientTaskSourceObservationReceiptV1,
	ConfidentialTransientTaskSourceObservationRecordV1,
	OrdinaryTransientTaskLifecycleV1,
	RuntimeProviderRegistry,
	SessionManagerJournalGenerationAuthorityResolverV1,
	TransientEvalInlineDynamicPostExecutionRouteV1,
	TransientTaskDetachedPrimarySessionAppendBridgeV1,
	TransientTaskForegroundBeforeReturnRecoveryBridgeV1,
	TransientTaskForegroundPendingTtsrOverlayBindingResolverV1,
	TransientTaskForegroundPostExecutionRouteV1,
	TransientTaskForegroundResultSettlementStoreV1,
	TransientTaskForegroundSessionAppendBridgeV1,
	TransientTaskHubSendAwaitOutboundEffectV1,
	TransientTaskHubSendAwaitTargetSourceEffectV1,
	TransientTaskHubWaitMessagePreselectionRecoveryStoreV1,
	TransientTaskHubWaitMessagePreselectionStartupRecoveryV1,
	TransientTaskHubWaitMessageReturnTargetBridgeV1,
	TransientTaskHubWaitMessageWinnerCompletionEffectV1,
	TransientTaskHubWaitMessageWinnerContinuationStoreV1,
	TransientTaskHubWaitMessageWinnerStartupRecoveryV1,
	TransientTaskLifecycleGateStoreV1,
	TransientTaskSourceObservationStoreV1,
} from "./workspace-runtime-contracts.js";

/** Maximum time the interactive shutdown path waits for Mnemopi consolidation. */
export const SHUTDOWN_CONSOLIDATE_BUDGET_MS = 1_500;

/** Options controlling session disposal. */
export interface AgentSessionDisposeOptions {
	mnemopiConsolidateTimeoutMs?: number;
	/**
	 * Postmortem reason that triggered this dispose (signal/fatal teardown
	 * paths). When set, the persisted `session_exit` diagnostic records it
	 * instead of the generic `"dispose"` used for normal programmatic disposal
	 * (`/quit`, test teardown, subagent completion).
	 */
	reason?: postmortem.Reason;
}

/** Listener notified when command metadata changes. */
export type CommandMetadataChangedListener = () => void | Promise<void>;
/** Public summary of an asynchronous job. */
export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime">;

/** Snapshot of running, recent, and pending-delivery asynchronous jobs. */
export interface AsyncJobSnapshot {
	running: AsyncJobSnapshotItem[];
	recent: AsyncJobSnapshotItem[];
	delivery: AsyncJobDeliveryState;
}

export type { ShakeMode, ShakeResult } from "./shake-types";

/**
 * Prewalk switches an active session one-way from its starting model to a
 * fast/cheap target after implementation begins.
 */
export interface Prewalk {
	target: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/**
 * PlanYolo starts in read-only plan mode, auto-approves the proposal, then
 * switches to a target model for implementation.
 */
export interface PlanYolo {
	target: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/** Details shown when confirming a usage-reserve-triggered model fallback. */
export interface UsageFallbackConfirmation {
	from: string;
	to: string;
	remainingPercent: number | undefined;
}

/** Identifies a retry fallback chain already entered during startup model resolution. */
export interface InitialRetryFallbackState {
	/** Role whose configured primary was unavailable. */
	role: string;
	/** Configured primary selector retained for restoration when it becomes available. */
	originalSelector: string;
	/** Thinking selector configured for the unavailable primary. */
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	/** Prevent cooldown restoration when startup selected this fallback from live usage health. */
	pinned?: boolean;
}

/** @internal Exact session-owned effect authorities required to assemble one transient runtime facade. */
export interface ProcessOwnedTransientTaskRuntimeEffectOwnersV1 {
	readonly asyncJobManager: AsyncJobManager;
	readonly ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1;
	readonly hubWinnerCompletion: TransientTaskHubWaitMessageWinnerCompletionEffectV1;
	readonly transientTaskHubSendAwaitTargetSourceEffect: TransientTaskHubSendAwaitTargetSourceEffectV1;
	readonly primarySessionAppend: TransientTaskDetachedPrimarySessionAppendBridgeV1;
}

/** @internal Owner-session-scoped assembly; release removes only this guarded manager binding. */
export interface ProcessOwnedTransientTaskRuntimeStoreAssemblyV1 {
	readonly facade: TransientTaskRuntimeStoreFacadeV1;
	/** Exact non-recursive route preparation owned by the process assembly. */
	readonly resolveTransientTaskLifecyclePreparation: PackageInternalAgentSessionTransientTaskLifecycleObservationAdapterOptionsV1["resolveLifecyclePreparation"];
	/** Exact non-recursive general-primary persistence owned by the process assembly. */
	readonly transientTaskLifecyclePrimaryPersistence: PackageInternalAgentSessionTransientTaskLifecycleObservationAdapterOptionsV1["primaryPersistence"];
	readonly transientTaskLifecycleObservationAdapter: AgentSessionTransientTaskLifecycleObservationAdapterV1;
	readonly installTransientTaskLifecycleObservationAdapter: (
		adapter: AgentSessionTransientTaskLifecycleObservationAdapterV1,
	) => () => void;
	readonly createOrdinaryTransientTaskLifecycle: (input: {
		readonly effects: ProcessOwnedTransientTaskRuntimeEffectOwnersV1;
		readonly ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1;
		readonly resolveTransientTaskLifecycleAuthority: (
			parentToolCallId: string,
		) => ConfidentialAgentSessionTransientTaskLifecycleAuthorityV1 | null;
	}) => OrdinaryTransientTaskLifecycleV1;
	readonly installOrdinaryTransientTaskLifecycle: (lifecycle: OrdinaryTransientTaskLifecycleV1) => () => void;
	readonly transientTaskHubWaitMessageWinnerContinuationStore: TransientTaskHubWaitMessageWinnerContinuationStoreV1;
	readonly transientTaskHubWaitMessageReturnTargetBridge: TransientTaskHubWaitMessageReturnTargetBridgeV1;
	readonly transientTaskHubWaitMessagePreselectionRecoveryStore: TransientTaskHubWaitMessagePreselectionRecoveryStoreV1;
	readonly transientTaskHubSendAwaitOutboundEffect: TransientTaskHubSendAwaitOutboundEffectV1;
	readonly transientTaskHubWaitMessageWinnerStartupRecovery: TransientTaskHubWaitMessageWinnerStartupRecoveryV1;
	readonly release: () => void;
}

type PackageInternalLifecycleEventV1 = Parameters<
	AgentSessionTransientTaskLifecycleObservationAdapterV1["onTransientTaskLifecycleObservation"]
>[0];
type PackageInternalLifecycleResumeRequestV1 = Parameters<
	AgentSessionTransientTaskLifecycleObservationAdapterV1["resumeTransientTaskLifecycleObservation"]
>[0];

/** @internal Sole AgentSession callback seam: resolve current non-reconstructable capture/route authority. */
export interface PackageInternalAgentSessionTransientTaskLifecyclePreparationV1 {
	readonly disposition: "ready" | "suspended";
	readonly route: TransientTaskForegroundPostExecutionRouteV1 | TransientEvalInlineDynamicPostExecutionRouteV1;
	readonly pendingCaptureRecordSha256: Sha256Ref;
}

/** @internal Exact managed transient aggregate locator; absent for ordinary/top-level sessions. */
export type AgentSessionTransientTaskCurrentParentLocatorV1 = Pick<
	ConfidentialTransientTaskHubWaitMessageCurrentParentSessionAuthorityV1,
	"taskId" | "runId" | "createId"
>;

/** @internal Exact low authorities used by the non-recursive lifecycle adapter. */
export interface PackageInternalAgentSessionTransientTaskLifecycleObservationAdapterOptionsV1 {
	readonly sourceObservationStore: TransientTaskSourceObservationStoreV1;
	readonly lifecycleGateStore: TransientTaskLifecycleGateStoreV1;
	/** AgentSession hydrates this same map from durable execute-entry observations before admission. */
	readonly lifecycleAuthorities: Map<string, ConfidentialAgentSessionTransientTaskLifecycleAuthorityV1>;
	readonly resolveTransientTaskLifecycleAuthority: (
		parentToolCallId: string,
	) => ConfidentialAgentSessionTransientTaskLifecycleAuthorityV1 | null;
	readonly resolveLifecyclePreparation: (input: {
		readonly authority: ConfidentialAgentSessionTransientTaskLifecycleAuthorityV1;
		readonly acceptedObservation: ConfidentialTransientTaskSourceObservationRecordV1;
		readonly observationReceipt: ConfidentialTransientTaskSourceObservationReceiptV1;
	}) => Promise<PackageInternalAgentSessionTransientTaskLifecyclePreparationV1>;
	readonly primaryPersistence: Pick<
		AgentSessionTransientTaskLifecycleObservationAdapterV1,
		"persistToolResultBeforeEmission"
	>;
	readonly hubWinnerCompletion: TransientTaskHubWaitMessageWinnerCompletionEffectV1;
	readonly createOperationId: () => OperationId;
	readonly now: () => ISO8601;
	readonly digestTuple: (tuple: readonly unknown[]) => Sha256Ref;
	readonly digestRecord: (domain: string, value: unknown) => Sha256Ref;
}

type PackageInternalSourceProductionInputV1 = {
	readonly indexKey: ConfidentialTransientTaskPendingCaptureIndexKeyV1;
	readonly producer: "task_tool" | "eval_tool" | "agent_loop";
	readonly observationInput:
		| Parameters<
				AgentSessionTransientTaskSourceObservationProducerV1["reserveAndFreezeTransientTaskSourceObservationDraft"]
		  >[0]["core"]["observationInput"]
		| PackageInternalLifecycleEventV1;
	readonly reservationId: OperationId;
	readonly observedAt: ISO8601;
	readonly requestedAt: ISO8601;
};

function packageInternalSourceReservationV1(
	options: PackageInternalAgentSessionTransientTaskLifecycleObservationAdapterOptionsV1,
	input: PackageInternalSourceProductionInputV1,
	expectedHead: Parameters<
		TransientTaskSourceObservationStoreV1["reserveAndFreezeObservationDraft"]
	>[0]["core"]["expectedHead"],
	expectedPredecessorObservationReceipt: ConfidentialTransientTaskSourceObservationReceiptV1 | null,
) {
	const core = {
		indexKey: input.indexKey,
		observedAt: input.observedAt,
		reservationId: input.reservationId,
		expectedHead,
		expectedPredecessorObservationReceipt,
		requestedAt: input.requestedAt,
		producer: input.producer,
		eventKind: input.observationInput.eventKind,
		observationInput: input.observationInput,
	};
	return {
		core,
		requestSha256: options.digestRecord("source_observation_reservation_request", core),
	} as Parameters<TransientTaskSourceObservationStoreV1["reserveAndFreezeObservationDraft"]>[0];
}

async function packageInternalCommitSourceObservationV1(
	options: PackageInternalAgentSessionTransientTaskLifecycleObservationAdapterOptionsV1,
	input: PackageInternalSourceProductionInputV1,
): Promise<ConfidentialAgentSessionTransientTaskSourceObservationProducerResultV1> {
	for (;;) {
		const inspectionCore = { indexKey: input.indexKey, requestedAt: input.requestedAt };
		const inspection = await options.sourceObservationStore.inspectObservationState({
			core: inspectionCore,
			requestSha256: options.digestRecord("source_observation_state_inspect_request", inspectionCore),
		});
		if (inspection.status !== "matching") {
			return { status: inspection.status === "sequence_conflict" ? "sequence_conflict" : "invalid" };
		}
		if (inspection.activeDraft) {
			const active = inspection.activeDraft;
			const inspectedAt = options.now();
			const inspectCore = {
				indexKey: input.indexKey,
				reservationId: active.core.reservationId,
				expectedReservationRequestSha256: active.core.reservationRequestSha256,
				expectedDraftSha256: active.core.draftSha256,
				inspectedAt,
			};
			const inspected = await options.sourceObservationStore.inspectObservationDraft({
				...inspectCore,
				requestSha256: options.digestRecord("source_observation_draft_inspect_request", inspectCore),
			});
			if (inspected.status !== "matching") {
				return {
					status:
						inspected.status === "sequence_conflict"
							? "sequence_conflict"
							: inspected.status === "observation_conflict"
								? "observation_conflict"
								: "invalid",
				};
			}
			const adoptedAt = options.now();
			const adoptCore = {
				inspection: inspected,
				expectedInspectionSha256: inspected.inspectionSha256,
				adoptedAt,
			};
			const adopted = await options.sourceObservationStore.adoptObservationDraft({
				...adoptCore,
				requestSha256: options.digestRecord("source_observation_draft_adopt_request", adoptCore),
			});
			if (adopted.status !== "adopted" && adopted.status !== "already_adopted") {
				return {
					status:
						adopted.status === "sequence_conflict"
							? "sequence_conflict"
							: adopted.status === "observation_conflict"
								? "observation_conflict"
								: "invalid",
				};
			}
			const activeRequest = packageInternalSourceReservationV1(
				options,
				input,
				adopted.draft.core.priorHead,
				adopted.draft.core.predecessorObservationReceipt,
			);
			const commitCore = {
				draft: adopted.draft,
				draftReceipt: adopted.receipt,
				expectedHeadSha256: adopted.draft.core.priorHead.headSha256,
				expectedPredecessorObservationReceiptSha256:
					adopted.draft.core.predecessorObservationReceipt?.receiptSha256 ?? null,
				committedAt: options.now(),
			};
			const committed = await options.sourceObservationStore.commitObservationDraft({
				...commitCore,
				requestSha256: options.digestRecord("source_observation_draft_commit_request", commitCore),
			});
			if (committed.status !== "committed" && committed.status !== "already_committed") {
				return {
					status:
						committed.status === "sequence_conflict"
							? "sequence_conflict"
							: committed.status === "observation_conflict"
								? "observation_conflict"
								: "invalid",
				};
			}
			if (adopted.draft.core.reservationRequest.requestSha256 !== activeRequest.requestSha256) continue;
			const accepted = committed.acceptedRow.core;
			return {
				status: committed.status,
				authority: accepted.draft.core.record.core.authority,
				draft: accepted.draft,
				draftReceipt: accepted.draftReceipt,
				observationReceipt: accepted.observationReceipt,
			};
		}
		const reservationRequest = packageInternalSourceReservationV1(
			options,
			input,
			inspection.head,
			inspection.latestAcceptedObservationReceipt,
		);
		const drafted = await options.sourceObservationStore.reserveAndFreezeObservationDraft(reservationRequest);
		if (drafted.status !== "drafted" && drafted.status !== "already_drafted") return { status: drafted.status };
		const commitCore = {
			draft: drafted.draft,
			draftReceipt: drafted.receipt,
			expectedHeadSha256: drafted.draft.core.priorHead.headSha256,
			expectedPredecessorObservationReceiptSha256:
				drafted.draft.core.predecessorObservationReceipt?.receiptSha256 ?? null,
			committedAt: options.now(),
		};
		const committed = await options.sourceObservationStore.commitObservationDraft({
			...commitCore,
			requestSha256: options.digestRecord("source_observation_draft_commit_request", commitCore),
		});
		if (committed.status !== "committed" && committed.status !== "already_committed") {
			return {
				status:
					committed.status === "sequence_conflict"
						? "sequence_conflict"
						: committed.status === "observation_conflict"
							? "observation_conflict"
							: "invalid",
			};
		}
		const accepted = committed.acceptedRow.core;
		return {
			status: committed.status,
			authority: accepted.draft.core.record.core.authority,
			draft: accepted.draft,
			draftReceipt: accepted.draftReceipt,
			observationReceipt: accepted.observationReceipt,
		};
	}
}

function packageInternalLifecycleKeyV1(
	options: PackageInternalAgentSessionTransientTaskLifecycleObservationAdapterOptionsV1,
	observation: ConfidentialTransientTaskSourceObservationRecordV1,
	receipt: ConfidentialTransientTaskSourceObservationReceiptV1,
) {
	const core = {
		schemaVersion: 1 as const,
		indexKeySha256: receipt.core.indexKeySha256,
		observationSha256: observation.observationSha256,
		observationReceiptSha256: receipt.receiptSha256,
		lifecycleOrdinal: receipt.core.lifecycleOrdinal,
	};
	return {
		core,
		keySha256: options.digestTuple([
			"omp-transient-task-lifecycle-gate-v1",
			"key",
			1,
			core.indexKeySha256,
			core.observationSha256,
			core.observationReceiptSha256,
			core.lifecycleOrdinal,
		]),
	};
}

function packageInternalLifecyclePrepareV1(
	options: PackageInternalAgentSessionTransientTaskLifecycleObservationAdapterOptionsV1,
	observation: ConfidentialTransientTaskSourceObservationRecordV1,
	receipt: ConfidentialTransientTaskSourceObservationReceiptV1,
	preparation: PackageInternalAgentSessionTransientTaskLifecyclePreparationV1,
) {
	const key = packageInternalLifecycleKeyV1(options, observation, receipt);
	const gateResultRecordedAt = options.now();
	let suspension: PackageInternalLifecycleResumeRequestV1["core"]["suspension"] | null = null;
	let resumeRequest: PackageInternalLifecycleResumeRequestV1 | null = null;
	if (preparation.disposition === "suspended") {
		if (!("lifecycleObservation" in observation.core)) {
			throw new Error("Transient Task lifecycle suspension lacks an AgentLoop observation");
		}
		const suspensionCore = {
			schemaVersion: 1 as const,
			lifecycleObservationSha256: observation.observationSha256,
			suspensionId: options.createOperationId(),
			suspendedAt: gateResultRecordedAt,
		};
		suspension = {
			core: suspensionCore,
			suspensionSha256: options.digestTuple([
				"omp-agent-loop-transient-task-lifecycle-gate-v1",
				"suspension-core",
				1,
				suspensionCore.lifecycleObservationSha256,
				suspensionCore.suspensionId,
				suspensionCore.suspendedAt,
			]),
		};
		const resumeCore = {
			lifecycleObservation: observation.core.lifecycleObservation,
			suspension,
			requestedAt: gateResultRecordedAt,
		};
		resumeRequest = {
			core: resumeCore,
			requestSha256: options.digestTuple([
				"omp-agent-loop-transient-task-lifecycle-gate-v1",
				"resume-core",
				1,
				resumeCore.lifecycleObservation,
				resumeCore.suspension,
				resumeCore.requestedAt,
			]),
		};
	}
	const core = {
		desiredState: preparation.disposition === "ready" ? ("awaiting_primary" as const) : ("suspended" as const),
		key,
		acceptedObservation: observation,
		observationReceipt: receipt,
		pendingCaptureRecordSha256: preparation.pendingCaptureRecordSha256,
		route: preparation.route,
		suspension,
		resumeRequest,
		gateResultRecordedAt,
	};
	return {
		core,
		requestSha256: options.digestTuple([
			"omp-transient-task-lifecycle-gate-v1",
			"prepare",
			1,
			core.desiredState,
			core.key,
			core.acceptedObservation,
			core.observationReceipt,
			core.pendingCaptureRecordSha256,
			core.route,
			core.suspension,
			core.resumeRequest,
			core.gateResultRecordedAt,
		]),
	} as Parameters<TransientTaskLifecycleGateStoreV1["prepareLifecycleGate"]>[0];
}

async function packageInternalAdoptLifecycleStatesV1(
	options: PackageInternalAgentSessionTransientTaskLifecycleObservationAdapterOptionsV1,
	authority: ConfidentialAgentSessionTransientTaskLifecycleAuthorityV1,
	requestedAt: ISO8601,
): Promise<readonly ConfidentialTransientTaskLifecycleGateStateV1[]> {
	const enumerateRequest = {
		schemaVersion: 1 as const,
		parentSessionId: authority.parentSessionId,
		parentSessionGenerationSha256: authority.parentSessionGenerationSha256,
		parentBranchAnchorEntryId: authority.assistantAnchorEntryId,
		parentBranchGenerationSha256: authority.parentBranchGenerationSha256,
		indexKey: authority.pendingCaptureIndexKey,
		requestedAt,
		requestSha256: options.digestTuple([
			"omp-transient-task-lifecycle-gate-v1",
			"enumerate",
			1,
			authority.parentSessionId,
			authority.parentSessionGenerationSha256,
			authority.assistantAnchorEntryId,
			authority.parentBranchGenerationSha256,
			authority.pendingCaptureIndexKey,
			requestedAt,
		]),
	};
	const enumerated = await options.lifecycleGateStore.enumerateLifecycleGates(enumerateRequest);
	if (enumerated.status !== "matching")
		throw new Error(`Transient Task lifecycle enumeration failed: ${enumerated.status}`);
	const states: ConfidentialTransientTaskLifecycleGateStateV1[] = [];
	for (let memberIndex = 0; memberIndex < enumerated.inspection.core.unresolved.length; memberIndex++) {
		const inspectRequest = {
			schemaVersion: 1 as const,
			enumerationInspection: enumerated.inspection,
			memberIndex,
			requestedAt,
			requestSha256: options.digestTuple([
				"omp-transient-task-lifecycle-gate-v1",
				"inspect",
				1,
				enumerated.inspection,
				enumerated.inspection.inspectionSha256,
				memberIndex,
				requestedAt,
			]),
		};
		const inspected = await options.lifecycleGateStore.inspectLifecycleGate(inspectRequest);
		if (inspected.status !== "matching")
			throw new Error(`Transient Task lifecycle inspection failed: ${inspected.status}`);
		const adoptRequest = {
			inspection: inspected.inspection,
			expectedInspectionSha256: inspected.inspection.inspectionSha256,
			adoptedAt: requestedAt,
			requestSha256: options.digestTuple([
				"omp-transient-task-lifecycle-gate-v1",
				"adopt",
				1,
				inspected.inspection,
				inspected.inspection.inspectionSha256,
				requestedAt,
			]),
		};
		const adopted = await options.lifecycleGateStore.adoptLifecycleGate(adoptRequest);
		if (adopted.status !== "adopted" && adopted.status !== "already_adopted") {
			throw new Error(`Transient Task lifecycle adoption failed: ${adopted.status}`);
		}
		states.push(adopted.state);
	}
	return states;
}

/** @internal Sole non-recursive constructor for the immutable AgentSession lifecycle adapter. */
export function createPackageInternalAgentSessionTransientTaskLifecycleObservationAdapterV1(
	options: PackageInternalAgentSessionTransientTaskLifecycleObservationAdapterOptionsV1,
): AgentSessionTransientTaskLifecycleObservationAdapterV1 {
	const admitAuthority = (
		authority: ConfidentialAgentSessionTransientTaskLifecycleAuthorityV1,
	): ConfidentialAgentSessionTransientTaskLifecycleAuthorityV1 => {
		const existing = options.lifecycleAuthorities.get(authority.toolCallId);
		if (existing && JSON.stringify(existing) !== JSON.stringify(authority)) {
			throw new Error("Transient Task lifecycle authority changed for one Task invocation");
		}
		const admitted = existing ?? authority;
		if (!existing) options.lifecycleAuthorities.set(authority.toolCallId, admitted);
		if (options.resolveTransientTaskLifecycleAuthority(authority.toolCallId) !== admitted) {
			throw new Error("Transient Task lifecycle authority map and resolver diverged");
		}
		return admitted;
	};
	return Object.freeze({
		hasTransientTaskLifecycleAuthority: (toolCallId: string) =>
			options.resolveTransientTaskLifecycleAuthority(toolCallId) !== null,
		async onTransientTaskLifecycleObservation(
			event: Parameters<
				AgentSessionTransientTaskLifecycleObservationAdapterV1["onTransientTaskLifecycleObservation"]
			>[0],
		) {
			const authority = options.resolveTransientTaskLifecycleAuthority(event.toolCallId);
			if (!authority) throw new Error("Transient Task lifecycle authority is unavailable");
			const observedAt = options.now();
			const committed = await packageInternalCommitSourceObservationV1(options, {
				indexKey: authority.pendingCaptureIndexKey,
				producer: "agent_loop",
				observationInput: event,
				reservationId: options.createOperationId(),
				observedAt,
				requestedAt: observedAt,
			});
			if (committed.status !== "committed" && committed.status !== "already_committed") {
				throw new Error(`Transient Task lifecycle observation commit failed: ${committed.status}`);
			}
			if (JSON.stringify(committed.authority) !== JSON.stringify(authority)) {
				throw new Error("Transient Task lifecycle observation changed execute-entry authority");
			}
			const observation = committed.draft.core.record;
			const preparation = await options.resolveLifecyclePreparation({
				authority,
				acceptedObservation: observation,
				observationReceipt: committed.observationReceipt,
			});
			const prepared = await options.lifecycleGateStore.prepareLifecycleGate(
				packageInternalLifecyclePrepareV1(options, observation, committed.observationReceipt, preparation),
			);
			if (prepared.status !== "prepared" && prepared.status !== "already_prepared") {
				throw new Error(`Transient Task lifecycle gate preparation failed: ${prepared.status}`);
			}
			return prepared.state.core.gateResult;
		},
		async resumeTransientTaskLifecycleObservation(
			request: Parameters<
				AgentSessionTransientTaskLifecycleObservationAdapterV1["resumeTransientTaskLifecycleObservation"]
			>[0],
		) {
			const authority = options.resolveTransientTaskLifecycleAuthority(request.core.lifecycleObservation.toolCallId);
			if (!authority) throw new Error("Transient Task lifecycle resume authority is unavailable");
			const states = await packageInternalAdoptLifecycleStatesV1(options, authority, request.core.requestedAt);
			const state = states.find(
				candidate =>
					candidate.core.key.core.observationSha256 === request.core.suspension.core.lifecycleObservationSha256,
			);
			if (!state) throw new Error("Transient Task suspended lifecycle gate is unavailable");
			if (state.core.state !== "suspended" || JSON.stringify(state.core.resumeRequest) !== JSON.stringify(request)) {
				return state.core.gateResult;
			}
			const preparation = await options.resolveLifecyclePreparation({
				authority,
				acceptedObservation: state.core.acceptedObservation,
				observationReceipt: state.core.observationReceipt,
			});
			if (preparation.disposition === "suspended") return state.core.gateResult;
			const gateResult = {
				status: "observation_durable" as const,
				resultExposure: "continue_original_emission" as const,
				terminalization: "awaiting_message_end_primary_persistence" as const,
				observationReceiptSha256: state.core.observationReceipt.receiptSha256,
				terminalReceiptSha256: null,
				suspension: null,
				resumeRequest: null,
			};
			const resumedAt = options.now();
			const core = {
				expectedSuspendedStateSha256: state.stateSha256,
				resumeRequest: request,
				gateResult,
				terminalCaptureReceipt: null,
				terminalMarker: null,
				resumedAt,
			};
			const resumed = await options.lifecycleGateStore.resumeLifecycleGate({
				core,
				requestSha256: options.digestTuple([
					"omp-transient-task-lifecycle-gate-v1",
					"resume",
					1,
					core.expectedSuspendedStateSha256,
					core.resumeRequest,
					core.gateResult,
					core.terminalCaptureReceipt,
					core.terminalMarker,
					core.resumedAt,
				]),
			});
			if (!("state" in resumed)) throw new Error(`Transient Task lifecycle resume failed: ${resumed.status}`);
			return resumed.state.core.gateResult;
		},
		async reserveAndFreezeTransientTaskSourceObservationDraft(
			request: Parameters<
				AgentSessionTransientTaskLifecycleObservationAdapterV1["reserveAndFreezeTransientTaskSourceObservationDraft"]
			>[0],
		) {
			if (
				request.requestSha256 !==
				options.digestTuple([
					"omp-agent-session-transient-task-lifecycle-v1",
					"producer-draft-request-core",
					1,
					request.core.indexKey,
					request.core.producer,
					request.core.observationInput,
					request.core.reservationId,
					request.core.observedAt,
					request.core.requestedAt,
				])
			)
				return { status: "invalid" as const };
			const result = await packageInternalCommitSourceObservationV1(options, request.core);
			if (
				(result.status === "committed" || result.status === "already_committed") &&
				(request.core.observationInput.eventKind === "task_execute_entry" ||
					request.core.observationInput.eventKind === "eval_execute_entry")
			) {
				const admitted = admitAuthority(result.authority);
				return admitted === result.authority ? result : { ...result, authority: admitted };
			}
			return result;
		},
		persistToolResultBeforeEmission: (
			request: Parameters<
				AgentSessionTransientTaskLifecycleObservationAdapterV1["persistToolResultBeforeEmission"]
			>[0],
		) => options.primaryPersistence.persistToolResultBeforeEmission(request),
		async awaitTransientTaskLifecyclePromptAdmissionBarrier(
			request: Parameters<
				AgentSessionTransientTaskLifecycleObservationAdapterV1["awaitTransientTaskLifecyclePromptAdmissionBarrier"]
			>[0],
		) {
			const requestCore = {
				parentSessionId: request.parentSessionId,
				parentSessionGenerationSha256: request.parentSessionGenerationSha256,
				requestedAt: request.requestedAt,
			};
			if (request.requestSha256 !== options.digestRecord("transient-task-lifecycle-prompt-admission", requestCore)) {
				throw new Error("Transient Task lifecycle admission request digest is invalid");
			}
			const authorities = [...options.lifecycleAuthorities.values()]
				.filter(
					authority =>
						authority.parentSessionId === request.parentSessionId &&
						authority.parentSessionGenerationSha256 === request.parentSessionGenerationSha256,
				)
				.sort((left, right) => left.sourceToolCallOrdinal - right.sourceToolCallOrdinal);
			const blocked: ConfidentialTransientTaskPendingCaptureIndexKeyV1[] = [];
			const adoptedStateSha256s: Sha256Ref[] = [];
			for (const authority of authorities) {
				const states = await packageInternalAdoptLifecycleStatesV1(options, authority, request.requestedAt);
				if (states.length > 0) blocked.push(authority.pendingCaptureIndexKey);
				adoptedStateSha256s.push(...states.map(state => state.stateSha256));
			}
			if (blocked.length > 0) {
				return {
					status: "blocked" as const,
					orderedIndexKeys: blocked as [
						ConfidentialTransientTaskPendingCaptureIndexKeyV1,
						...ConfidentialTransientTaskPendingCaptureIndexKeyV1[],
					],
					claimsPinned: true as const,
					statePinned: true as const,
					barrierSha256: options.digestTuple([
						"omp-agent-session-transient-task-lifecycle-v1",
						"prompt-admission-blocked",
						1,
						request,
						blocked,
						adoptedStateSha256s,
					]),
				};
			}
			return {
				status: "ready" as const,
				barrierReceiptSha256: options.digestTuple([
					"omp-agent-session-transient-task-lifecycle-v1",
					"prompt-admission-ready",
					1,
					request,
					authorities.map(authority => authority.pendingCaptureIndexKey.indexKeySha256),
					adoptedStateSha256s,
				]),
			};
		},
	});
}

/** @internal Claimed owner-session authority exposed only to the Task caller adapter. */
/** @internal AgentSession-owned foreground bridge consumed only by the live Task invocation. */
export interface AgentSessionTransientTaskForegroundRuntimeAuthorityV1 {
	readonly sourceObservationProducer: AgentSessionTransientTaskSourceObservationProducerV1;
	readonly pendingOverlayBindingResolver: TransientTaskForegroundPendingTtsrOverlayBindingResolverV1;
	readonly takePreDispatchBinding: (toolCallId: string) => {
		readonly indexKey: ConfidentialTransientTaskPendingCaptureIndexKeyV1;
		readonly snapshot: ConfidentialTransientTaskForegroundPendingTtsrOverlaySnapshotV1;
		readonly binding: ConfidentialTransientTaskForegroundPendingTtsrOverlayPreDispatchBindingV1;
		readonly sourceToolCallOrdinal: number;
		readonly assistantAnchorEntryId: string;
		readonly serializerKey: ConfidentialAgentSessionToolResultSerializerKeyV1;
	} | null;
	readonly beforeReturnRecovery: TransientTaskForegroundBeforeReturnRecoveryBridgeV1;
	readonly sessionAppend: TransientTaskForegroundSessionAppendBridgeV1;
	readonly settlement: TransientTaskForegroundResultSettlementStoreV1;
	readonly resolveJournalGenerationAuthority: SessionManagerJournalGenerationAuthorityResolverV1["resolveTransientTaskJournalGenerationAuthority"];
}

/** @internal Exact runtime-assembly Hub stores; never widened through ToolSession. */
export interface AgentSessionTransientTaskHubWaitRuntimeAuthorityV1 {
	readonly returnTargetBridge: TransientTaskHubWaitMessageReturnTargetBridgeV1;
	readonly winnerContinuationStore: TransientTaskHubWaitMessageWinnerContinuationStoreV1;
	readonly preselectionRecoveryStore: TransientTaskHubWaitMessagePreselectionRecoveryStoreV1;
	readonly outboundEffect: TransientTaskHubSendAwaitOutboundEffectV1;
	readonly currentParentTaskLocator: AgentSessionTransientTaskCurrentParentLocatorV1 | null;
	readonly preselectionStartupRecovery: TransientTaskHubWaitMessagePreselectionStartupRecoveryV1;
	readonly winnerStartupRecovery: TransientTaskHubWaitMessageWinnerStartupRecoveryV1;
	readonly selectorOwnership: Pick<
		TransientTaskHubWaitMessageWinnerCompletionEffectV1,
		"verifyCurrentHubWaitMessageSelectorOwnership"
	>;
	readonly claimMessageReturnPreparation: (
		locator: AgentSessionTransientTaskCurrentParentLocatorV1,
		toolCallId: string,
		frozenAt: ISO8601,
	) => Promise<{
		readonly currentParentSessionAuthority: ConfidentialTransientTaskHubWaitMessageCurrentParentSessionAuthorityV1;
		readonly afterToolCallPlan: ConfidentialTransientTaskHubWaitMessageAfterToolCallPlanV1;
	}>;
}

export interface AgentSessionTransientTaskRuntimeAuthorityV1 {
	readonly stores: TransientTaskRuntimeStoreFacadeV1;
	readonly ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1;
	readonly executionEnvironmentProvider: ExecutionEnvironmentProvider;
	readonly foregroundTask: AgentSessionTransientTaskForegroundRuntimeAuthorityV1;
	readonly foregroundEval: AgentSessionTransientTaskForegroundRuntimeAuthorityV1;
	readonly hubWait: AgentSessionTransientTaskHubWaitRuntimeAuthorityV1;
}

/** @internal Exact outer Eval foreground authority, acquired lazily by its first isolated child. */
export interface AgentSessionTransientEvalInlineDynamicInvocationV1 {
	readonly runtimeAuthority: AgentSessionTransientTaskRuntimeAuthorityV1;
	readonly authority: AgentSessionTransientTaskForegroundRuntimeAuthorityV1;
	readonly indexKey: ConfidentialTransientTaskPendingCaptureIndexKeyV1;
	readonly snapshot: ConfidentialTransientTaskForegroundPendingTtsrOverlaySnapshotV1;
	readonly preDispatchBinding: ConfidentialTransientTaskForegroundPendingTtsrOverlayPreDispatchBindingV1;
	readonly sourceToolCallOrdinal: number;
	readonly assistantAnchorEntryId: string;
	readonly serializerKey: ConfidentialAgentSessionToolResultSerializerKeyV1;
	readonly effectiveEvalArgumentsSha256: Sha256Ref;
	readonly effectiveArgumentRevisionChainSha256: Sha256Ref;
	readonly executeEntryObservationReceipt: ConfidentialTransientEvalExecuteEntryObservationReceiptV1;
}

/** @internal Sole process-owned persistent authority and session-scoped transient assembly seam. */
export interface ProcessOwnedAgentDependenciesV1 {
	readonly persistentAgentStore: PersistentAgentStore;
	readonly assembleTransientTaskRuntimeStoreFacade: (
		effects: ProcessOwnedTransientTaskRuntimeEffectOwnersV1,
	) => ProcessOwnedTransientTaskRuntimeStoreAssemblyV1;
}

/** Dependencies and initial state used to construct an AgentSession. */
export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	/** Model-visible operational workspace root; persistent sessions use exactly `/workspace`. */
	operationalCwd?: string;
	/** Optional post-primary journal service supplied explicitly by the control process. */
	sessionJournal?: SessionJournalService;
	/** Resolved core-only tool contract for a persistent session. */
	persistentToolSet?: PersistentToolSet;
	/** Shared adaptive runtime providers supplied by the control process. */
	runtimeProviderRegistry: RuntimeProviderRegistry;
	/** Session-affine model/auth resolver supplied explicitly by the control process. */
	modelConnectionResolver: ModelConnectionResolver;
	/** @internal Process-owned authority seam for persistent advisor/history and caller propagation. */
	processOwnedDependencies?: ProcessOwnedAgentDependenciesV1;
	/** @internal Exact managed transient locator; never synthesized for ordinary/top-level sessions. */
	readonly transientTaskCurrentParentTaskLocator?: AgentSessionTransientTaskCurrentParentLocatorV1;
	/** Exact resolved provider required for managed transient environment execution. */
	readonly executionEnvironmentProvider?: ExecutionEnvironmentProvider;
	/** Whether the session spawn policy permits the read-only `scout` subagent. Defaults to true. */
	scoutAllowedBySpawnPolicy?: boolean;
	/** Whether the caller explicitly requested yolo/auto-approve behavior for this session. */
	autoApprove?: boolean;
	/** Models to cycle through with Ctrl+P (from --models flag). */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/** Initial session thinking selector. */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Hard ceiling on the session's thinking effort (e.g. a task spawn's `task.maxEffort`-capped hint); every later change, including retry-fallback recovery, is re-clamped to it. */
	thinkingLevelCeiling?: Effort;
	/** Retry chain ownership when startup selected one of its fallback entries. */
	initialRetryFallback?: InitialRetryFallbackState;
	/** Prewalk from the starting model to a fast/cheap target after implementation begins. */
	prewalk?: Prewalk;
	/** Force read-only plan mode at start, auto-approve, then switch to the target. */
	planYolo?: PlanYolo;
	/** Initial per-family service tiers for the live session. */
	serviceTierByFamily?: ServiceTierByFamily;
	/** Prompt templates for expansion. */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands for expansion. */
	slashCommands?: FileSlashCommand[];
	/** Extension runner created with wrapped tools. */
	extensionRunner?: ExtensionRunner;
	/** Loaded skills already discovered by the SDK. */
	skills?: Skill[];
	/** Skill loading warnings already captured by the SDK. */
	skillWarnings?: SkillWarning[];
	/** Whether runtime reloads may rediscover disk-backed skills. */
	skillsReloadable?: boolean;
	/** Custom TypeScript slash commands. */
	customCommands?: LoadedCustomCommand[];
	skillsSettings?: SkillsSettings;
	/** Agent directory used when changing memory backends in a live session. */
	memoryAgentDir?: string;
	/** Recursion depth used to suppress live backend replacement in subagents. */
	memoryTaskDepth?: number;
	/** Creates built-in memory tools for the current backend. */
	createMemoryTools?: () => Promise<AgentTool[]>;
	/** Creates the built-in `computer` tool for session-scoped runtime enablement (see {@link AgentSession.setComputerToolEnabled}). */
	createComputerTool?: () => Promise<AgentTool | null>;
	/** Creates the built-in `inspect_image` tool for session-scoped runtime enablement (see {@link AgentSession.setInspectImageMode}). */
	createInspectImageTool?: () => Promise<AgentTool | null>;
	/** Model registry for API key resolution and model discovery. */
	modelRegistry: ModelRegistry;
	/** Tool registry for LSP and settings. */
	toolRegistry?: Map<string, AgentTool>;
	/** Creates tools registered only while vibe mode is active. */
	createVibeTools?: () => AgentTool[];
	/** Names whose current registry entry is the built-in implementation. */
	builtInToolNames?: Iterable<string>;
	/** Updates tool-session predicates from the live active tool set. */
	setActiveToolNames?: (names: Iterable<string>) => void;
	/** Registers the write transport when runtime xdev mounts first need it. */
	ensureWriteRegistered?: () => Promise<boolean>;
	/** Current session pre-LLM message transform pipeline. */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	/** Provider request transform applied after message conversion. */
	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;
	/** Stream wrapper for side-channel requests. */
	sideStreamFn?: StreamFn;
	/** Stream wrapper for advisor requests. */
	advisorStreamFn?: StreamFn;
	/** Advisor spend already recorded for the session being opened, restored on resume. */
	initialAdvisorCosts?: ReadonlyMap<string, number>;
	/** Prefer websocket transport for OpenAI Codex requests when supported. */
	preferWebsockets?: boolean;
	/** Codex saved-reset coordinator; defaults to the process-wide singleton so concurrent sessions can't double-spend. Inject a fresh one in tests. */
	codexResetCoordinator?: CodexAutoRedeemCoordinator;
	/** Provider payload hook used by the active session request path. */
	onPayload?: SimpleStreamOptions["onPayload"];
	/** Provider response hook used by the active session request path. */
	onResponse?: SimpleStreamOptions["onResponse"];
	/** Raw SSE hook used by the active session request path. */
	onSseEvent?: SimpleStreamOptions["onSseEvent"];
	/** Per-session raw SSE diagnostic buffer. */
	rawSseDebugBuffer?: RawSseDebugBuffer;
	/** Current session message-to-LLM conversion pipeline. */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** System prompt builder that can consider tool availability. */
	rebuildSystemPrompt?: (
		toolNames: string[],
		tools: Map<string, AgentTool>,
	) => Promise<{ systemPrompt: string[]; xdevCatalogNames?: readonly string[] }>;
	/** Local calendar date provider used by prompt-cache invalidation. */
	getLocalCalendarDate?: () => string;
	/** Tools mounted under `xd://`, for `/tools` display. */
	getXdevToolEntries?: () => Array<{ name: string; summary: string }>;
	/** `xd://` presentation state backed by the canonical tool map. */
	xdev?: XdevState;
	/** Names pinned top-level during runtime repartitioning. */
	presentationPinnedToolNames?: ReadonlySet<string>;
	/** Accessor for live MCP server instructions. */
	getMcpServerInstructions?: () => Map<string, string> | undefined;
	/** Time-traveling stream-rule manager. */
	ttsrManager?: TtsrManager;
	/** Secret obfuscator for provider and edit content. */
	obfuscator?: SecretObfuscator;
	/** Inherited eval executor session id from a parent agent. */
	parentEvalSessionId?: string;
	/** Logical owner for retained eval kernels created by this session. */
	evalKernelOwnerId?: string;
	/** Async job manager owned and disposed by this session. */
	ownedAsyncJobManager?: AsyncJobManager;
	/** @internal Release the SDK process-manager binding only after this session has torn down its owned manager. */
	releaseProcessAsyncJobManagerBinding?: () => void;
	/** Async job manager visible to this session. */
	asyncJobManager?: AsyncJobManager;
	/** Registry identity used for IRC routing. */
	agentId?: string;
	/** Whether this is a top-level or subagent session. */
	agentKind?: "main" | "sub";
	/** Provider-facing session ID override. */
	providerSessionId?: string;
	/** Whether the provider prompt-cache key was explicit or fork-inherited. */
	providerPromptCacheKeySource?: "explicit" | "fork";
	/** Full advisor toolset built against an advisor-scoped tool session. */
	advisorTools?: AgentTool[];
	/**
	 * Build a `grep` honoring a Cursor `pi_grep` frame's own context width and
	 * match cap, against the advisor-scoped tool session. Without it an advisor
	 * running on Cursor silently drops both fields.
	 */
	advisorCreateGrepTool?(options: { context?: number; totalMatchLimit?: number }): AgentTool | undefined;
	/**
	 * Build the `replace`-mode `edit` a Cursor `pi_edit` frame needs, against the
	 * advisor-scoped tool session. The advisor's ordinary instance follows the
	 * configured `edit.mode` and rejects the frame's `old_string`/`new_string` args.
	 */
	advisorCreateEditTool?(): AgentTool | undefined;
	/**
	 * The execute-time context the advisor's bridge tools resolve approval from.
	 *
	 * `ExtensionToolWrapper` reads `tools.approvalMode`, per-tool
	 * `tools.approval.<tool>` policies and `autoApprove` only from this context;
	 * with none it defaults to `yolo` with empty policies, so a bridge tool would
	 * run a native frame the user configured `ask` or `deny` for.
	 */
	advisorGetToolContext?: () => AgentToolContext | undefined;
	/**
	 * The live MCP connections the advisor's Cursor resource frames answer from.
	 *
	 * Advisors share the session's connections and may be granted tools from
	 * those same servers; without this their `list_mcp_resources` reports an
	 * empty catalog and every `read_mcp_resource` a `not_found`.
	 */
	advisorMcpResources?: CursorMcpResourceAdapter;
	/** Preloaded watchdog prompt content for the advisor. */
	advisorWatchdogPrompt?: string;
	/** Shared advisor instructions loaded from WATCHDOG.yml. */
	advisorSharedInstructions?: string;
	/** Project context rendered for advisor sessions. */
	advisorContextPrompt?: string;
	/** Advisors discovered from WATCHDOG.yml. */
	advisorConfigs?: AdvisorConfig[];
	/** Strip tool descriptions from provider-bound side-request tool specs. */
	pruneToolDescriptions?: boolean;
	/** Disconnect the MCP manager owned by this session during disposal. */
	disconnectOwnedMcpManager?: () => Promise<void>;
	/** System prompt used by automatic session-title generation. */
	titleSystemPrompt?: string;
}

/** Options for AgentSession.prompt(). */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true). */
	expandPromptTemplates?: boolean;
	/** Image attachments. */
	images?: ImageContent[];
	/** Queue behavior while streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Optional tool choice override for the next LLM call. */
	toolChoice?: ToolChoice;
	/** Send as a developer/system message instead of user. */
	synthetic?: boolean;
	/** Whether this prompt is a deliberate user action. */
	userInitiated?: boolean;
	/** Explicit billing/initiator attribution. */
	attribution?: MessageAttribution;
	/** Skip pre-send compaction checks for this prompt. */
	skipCompactionCheck?: boolean;
}

/** Options for AgentSession.followUp(). */
export interface FollowUpOptions {
	/** Enqueue as a hidden developer message instead of a user follow-up. */
	synthetic?: boolean;
	/** Whether to expand file-based prompt templates (default: true). */
	expandPromptTemplates?: boolean;
	/** Explicit billing/initiator attribution. */
	attribution?: MessageAttribution;
}

/** Result from a handoff operation. */
export interface HandoffResult {
	document: string;
	savedPath?: string;
}

/** Options controlling handoff generation. */
export interface SessionHandoffOptions {
	autoTriggered?: boolean;
	signal?: AbortSignal;
	onSwitchCancelled?: () => void;
}

/** Result from cycleModel(). */
export interface ModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	/** Whether cycling through scoped models or all available models. */
	isScoped: boolean;
}

/** Result from cycleRoleModels(). */
export interface RoleModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	role: string;
}

/** A configured role resolved to a concrete model. */
export interface ResolvedRoleModel {
	role: string;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
}

/** Resolvable role models and the currently active index. */
export interface RoleModelCycle {
	models: ResolvedRoleModel[];
	currentIndex: number;
}

/** Token breakdown for the current provider context. */
export interface ContextUsageBreakdown {
	contextWindow: number;
	anchored: boolean;
	usedTokens: number;
	systemPromptTokens: number;
	systemToolsTokens: number;
	systemContextTokens: number;
	skillsTokens: number;
	messagesTokens: number;
}

/** Session statistics for the `/session` command. */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
	contextUsage?: ContextUsage;
}

/** Stored OAuth accounts available to the current model provider. */
export interface SessionOAuthAccountList {
	provider: string;
	accounts: OAuthAccountSummary[];
}

/** IDs for a newly created session and the session it replaced. */
export interface FreshSessionResult {
	previousSessionId: string;
	sessionId: string;
	closedProviderSessions: number;
}

/** Outcome of an in-place `/clear` conversation-context reset. */
export interface ResetSessionContextResult {
	/** Number of live messages dropped from the model's context. */
	droppedCount: number;
}

/** Queued user content restored to the editor. */
export type RestoredQueuedMessage = { text: string; images?: ImageContent[] };
