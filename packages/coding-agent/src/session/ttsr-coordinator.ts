import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	type AgentEvent,
	type AgentMessage,
	createToolScopedAbortReason,
} from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { isRecord, prompt, relativePathWithinRoot } from "@oh-my-pi/pi-utils";
import type { Rule } from "../capability/rule";
import type { Settings } from "../config/settings";
import type { TtsrManager, TtsrMatchContext } from "../export/ttsr";
import ttsrInterruptTemplate from "../prompts/system/ttsr-interrupt.md" with { type: "text" };
import ttsrToolReminderTemplate from "../prompts/system/ttsr-tool-reminder.md" with { type: "text" };
import type { ISO8601, Sha256Ref } from "../registry/persistent-agent-contracts.js";
import type { AgentSessionEvent } from "./agent-session-events";
import type { SessionManager } from "./session-manager";
import type * as RuntimeContracts from "./workspace-runtime-contracts.js";
import {
	buildTransientTaskHubWaitMessageCanonicalRecordV1,
	canonicalTransientTaskSourceObservationDigestV1,
	validateTransientTaskHubWaitMessageCanonicalRecordV1,
} from "./workspace-runtime-contracts.js";

function transientTtsrSha256Ref(input: string): Sha256Ref {
	return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}` as Sha256Ref;
}

function transientTtsrTupleSha256Ref(tuple: readonly unknown[]): Sha256Ref {
	return transientTtsrSha256Ref(JSON.stringify(tuple));
}

function transientTtsrExactJson(left: unknown, right: unknown): boolean {
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

function transientTtsrRenderedGateSha256(
	gate: Omit<RuntimeContracts.ConfidentialTransientTaskForegroundRenderedGateV1, "renderedGateSha256">,
): Sha256Ref {
	return transientTtsrTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"rendered-gate-core",
		1,
		gate.preOverlayGateSha256,
		gate.foregroundAppendBatchKeySha256,
		gate.overlaySnapshotSha256,
		gate.renderedResult,
		gate.ttsrInjectionContentPlan,
		gate.appendedAt,
	]);
}

function transientTtsrOverlayCommitReceiptSha256(
	receipt: Omit<RuntimeContracts.ConfidentialTransientTaskForegroundTtsrOverlayCommitReceiptV1, "receiptSha256">,
): Sha256Ref {
	return transientTtsrTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"ttsr-overlay-commit-core",
		1,
		receipt.disposition,
		receipt.preOverlayGateSha256,
		receipt.renderedGateSha256,
		receipt.overlaySnapshotSha256,
		receipt.pendingOverlaySnapshotSha256,
		receipt.pendingOverlayFinalVersion,
		receipt.pendingOverlayFinalVersionSha256,
		receipt.pendingOverlayCaptureOutcomeHistorySha256,
		receipt.pendingOverlayFinalCaptureOutcomeSha256,
		receipt.injectionContentPlanSha256,
		receipt.injectionAppendRequestSha256,
		receipt.injectionAppendReceiptSha256,
		receipt.primaryPersistenceReceiptSha256,
		receipt.injectedRuleNames,
		receipt.ttsrInjectionEntry,
		receipt.committedAt,
	]);
}

function transientTtsrContentPlanMatchesSnapshot(
	contentPlan: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrInjectionContentPlanV1,
	snapshot: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrOverlaySnapshotV1,
): boolean {
	if (
		!validateTransientTaskHubWaitMessageCanonicalRecordV1("foreground-ttsr-overlay-snapshot", snapshot) ||
		!validateTransientTaskHubWaitMessageCanonicalRecordV1("foreground-ttsr-injection-content-plan", contentPlan)
	)
		return false;
	if (snapshot.mode === "none") {
		return (
			contentPlan.disposition === "no_entry" &&
			snapshot.injectedRuleNames.length === 0 &&
			snapshot.renderedReminderUtf8 === ""
		);
	}
	return (
		contentPlan.disposition === "exact_entry" &&
		contentPlan.overlaySnapshotSha256 === snapshot.snapshotSha256 &&
		transientTtsrExactJson(contentPlan.injectedRuleNames, snapshot.injectedRuleNames)
	);
}

function transientTtsrRenderedGateMatchesSnapshot(
	snapshot: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrOverlaySnapshotV1,
	preOverlayGateSha256: Sha256Ref,
	gate: RuntimeContracts.ConfidentialTransientTaskForegroundRenderedGateV1,
): boolean {
	const { renderedGateSha256: _renderedGateSha256, ...core } = gate;
	return (
		gate.schemaVersion === 1 &&
		gate.preOverlayGateSha256 === preOverlayGateSha256 &&
		gate.overlaySnapshotSha256 === snapshot.snapshotSha256 &&
		gate.renderedResult.foregroundAppendBatchKeySha256 === gate.foregroundAppendBatchKeySha256 &&
		gate.renderedResult.preOverlayGateSha256 === preOverlayGateSha256 &&
		gate.renderedResult.ttsrOverlaySnapshotSha256 === snapshot.snapshotSha256 &&
		transientTtsrContentPlanMatchesSnapshot(gate.ttsrInjectionContentPlan, snapshot) &&
		gate.renderedGateSha256 === transientTtsrRenderedGateSha256(core)
	);
}

function transientTtsrNow(): ISO8601 {
	return new Date().toISOString() as ISO8601;
}

interface TransientTaskTtsrRuntimeBindingV1 {
	readonly overlayStore: RuntimeContracts.TransientTaskForegroundPendingTtsrOverlayStoreV1;
	readonly overlayCommitStore: Pick<
		RuntimeContracts.TransientTaskForegroundTtsrOverlaySnapshotAdapterV1,
		"commitForegroundOverlayAfterPrimaryPersistence"
	>;
}

interface TransientTaskTtsrFinalizedStateV1 {
	readonly snapshot: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlaySnapshotV1;
	readonly binding: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayPreDispatchBindingV1;
}

interface TransientTaskTtsrStreamStateV1 {
	readonly assistantStreamSha256: Sha256Ref;
	readonly preAssistantAuthority: RuntimeContracts.ConfidentialAgentSessionJournalGenerationAuthorityV1;
	readonly preAssistantAnchorEntryId: string | null;
	readonly taskStates: Map<string, TransientTaskTtsrCaptureStateV1>;
	readonly provisionalClaimsByRuleName: Map<
		string,
		{
			readonly state: TransientTaskTtsrCaptureStateV1;
			readonly captureRevision: number;
			readonly captureInputSha256: Sha256Ref;
			readonly versionSha256: Sha256Ref;
			readonly claimSha256: Sha256Ref;
			readonly provisionalClaim: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrProvisionalClaimV1;
		}
	>;
	captureTail: Promise<void>;
}

interface TransientTaskTtsrCaptureStateV1 {
	readonly stream: TransientTaskTtsrStreamStateV1;
	readonly key: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayKeyV1;
	readonly indexKey: RuntimeContracts.ConfidentialTransientTaskPendingCaptureIndexKeyV1;
	readonly sourceToolCallOrdinal: number;
	readonly orderedStreamedObservations: RuntimeContracts.ConfidentialTransientTaskForegroundStreamedToolCallObservationV1[];
	readonly startedCaptures: Map<
		number,
		Promise<RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayVersionV1>
	>;
	readonly preparedVersions: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayVersionV1[];
	readonly accumulatedRules: Rule[];
	observedStreamedToolCallEventCount: number;
	registeredMessageUpdateCaptureCount: number;
	nextCaptureRevision: number;
	finalized: TransientTaskTtsrFinalizedStateV1 | undefined;
	startedRecordSha256: Sha256Ref | undefined;
}

export interface TransientTaskTtsrPreDispatchStateV1 {
	readonly indexKey: RuntimeContracts.ConfidentialTransientTaskPendingCaptureIndexKeyV1;
	readonly snapshot: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlaySnapshotV1;
	readonly binding: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayPreDispatchBindingV1;
	readonly sourceToolCallOrdinal: number;
}

interface TransientTaskTtsrCaptureEvaluationV1 {
	readonly input: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrMessageUpdateCaptureInputV1;
	readonly matches: readonly Rule[];
	readonly matchContext: TtsrMatchContext;
	readonly interrupted: boolean;
}
type TransientTaskTtsrMessageUpdateCaptureInputWithoutDigestV1 =
	RuntimeContracts.ConfidentialTransientTaskForegroundTtsrMessageUpdateCaptureInputV1 extends infer Input
		? Input extends RuntimeContracts.ConfidentialTransientTaskForegroundTtsrMessageUpdateCaptureInputV1
			? Omit<Input, "captureInputSha256">
			: never
		: never;

interface TtsrContinueOptions {
	delayMs?: number;
	generation?: number;
	shouldContinue?: () => boolean;
	onSkip?: () => void;
	onError?: () => void;
}

/** Capabilities the TTSR coordinator borrows from its owning session. */
export interface TtsrCoordinatorHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	schedulePostPromptTask(task: (signal: AbortSignal) => Promise<void>, options?: { delayMs?: number }): void;
	scheduleAgentContinue(options: TtsrContinueOptions): void;
	promptGeneration(): number;
}

/** Coordinates TTSR stream matching, interruption, injection, and resume gates. */
export class TtsrCoordinator
	implements
		Pick<
			RuntimeContracts.TransientTaskForegroundTtsrOverlaySnapshotAdapterV1,
			| "snapshotForegroundAfterToolCallOverlay"
			| "applyForegroundAfterToolCallOverlaySnapshot"
			| "freezeForegroundAfterToolCallInjectionContent"
			| "restoreForegroundTtsrRepeatState"
			| "commitForegroundOverlayAfterPrimaryPersistence"
		>
{
	readonly #host: TtsrCoordinatorHost;
	readonly #manager: TtsrManager | undefined;
	#pendingInjections: Rule[] = [];
	#perToolInjections = new Map<string, Rule[]>();
	#abortPending = false;
	#retryToken = 0;
	#resumePromise: Promise<void> | undefined;
	#resumeResolve: (() => void) | undefined;
	#transientTaskRuntime: TransientTaskTtsrRuntimeBindingV1 | undefined;
	#transientTaskStreams = new WeakMap<AssistantMessage, TransientTaskTtsrStreamStateV1>();
	#transientTaskByToolCallId = new Map<string, TransientTaskTtsrCaptureStateV1>();
	#transientTaskCaptureByEvent = new WeakMap<object, Promise<boolean>>();
	#nextTransientTaskCaptureGeneration = 0;
	#restoredForegroundOverlayCommitReceipts = new Set<Sha256Ref>();

	constructor(host: TtsrCoordinatorHost, manager: TtsrManager | undefined) {
		this.#host = host;
		this.#manager = manager;
	}

	/** Binds the one SessionManager-owned durable overlay view for this owner-session generation. */
	bindTransientTaskRuntime(overlayStore: RuntimeContracts.TransientTaskForegroundPendingTtsrOverlayStoreV1): void {
		if (this.#transientTaskRuntime && this.#transientTaskRuntime.overlayStore !== overlayStore) {
			throw new Error("Transient Task TTSR runtime is already bound");
		}
		this.#transientTaskRuntime = {
			overlayStore,
			overlayCommitStore: this.#host.sessionManager.transientPersistence,
		};
	}

	/** Releases process-local capture ledgers only after the guarded durable binding is released. */
	releaseTransientTaskRuntime(): void {
		this.#transientTaskRuntime = undefined;
		this.#transientTaskStreams = new WeakMap();
		this.#transientTaskByToolCallId.clear();
		this.#transientTaskCaptureByEvent = new WeakMap();
	}

	/**
	 * Promotes only the rules named by an exact durable foreground-overlay
	 * receipt. The primary append already persisted the injection entry, so this
	 * deliberately never appends a second `ttsr_injection` journal record.
	 */
	restoreForegroundTtsrRepeatState(
		receipt: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrOverlayCommitReceiptV1,
	): void {
		const { receiptSha256: _receiptSha256, ...core } = receipt;
		if (receipt.receiptSha256 !== transientTtsrOverlayCommitReceiptSha256(core)) {
			throw new Error("Foreground overlay commit receipt digest was invalid");
		}
		if (receipt.disposition === "no_entry") {
			if (receipt.injectedRuleNames.length !== 0 || receipt.ttsrInjectionEntry !== null) {
				throw new Error("No-entry foreground overlay receipt carried an injection entry");
			}
		} else if (
			receipt.ttsrInjectionEntry === null ||
			receipt.ttsrInjectionEntry.injectedRules.length !== receipt.injectedRuleNames.length ||
			receipt.ttsrInjectionEntry.injectedRules.some((name, index) => name !== receipt.injectedRuleNames[index])
		) {
			throw new Error("Foreground overlay receipt injection entry did not match its rule names");
		}
		if (this.#restoredForegroundOverlayCommitReceipts.has(receipt.receiptSha256)) return;

		const finalizedStates: Array<readonly [string, TransientTaskTtsrCaptureStateV1]> = [];
		for (const [toolCallId, state] of this.#transientTaskByToolCallId) {
			if (state.finalized?.snapshot.pendingOverlaySnapshotSha256 !== receipt.pendingOverlaySnapshotSha256) continue;
			if (state.finalized.snapshot.overlaySnapshot.snapshotSha256 !== receipt.overlaySnapshotSha256) {
				throw new Error("Foreground overlay receipt did not match the finalized capture snapshot");
			}
			finalizedStates.push([toolCallId, state]);
		}

		this.#manager?.markInjectedByNames([...receipt.injectedRuleNames]);
		for (const [toolCallId, state] of finalizedStates) {
			state.stream.taskStates.delete(toolCallId);
			for (const [ruleName, claim] of state.stream.provisionalClaimsByRuleName) {
				if (claim.state === state) state.stream.provisionalClaimsByRuleName.delete(ruleName);
			}
			this.#transientTaskByToolCallId.delete(toolCallId);
			this.#perToolInjections.delete(toolCallId);
		}
		this.#restoredForegroundOverlayCommitReceipts.add(receipt.receiptSha256);
	}

	/** Extracts the exact durable Task overlay without consulting live rules, settings, or templates. */
	snapshotForegroundAfterToolCallOverlay(
		pendingOverlaySnapshot: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlaySnapshotV1,
	): RuntimeContracts.ConfidentialTransientTaskForegroundTtsrOverlaySnapshotV1 {
		const finalOutcome = pendingOverlaySnapshot.orderedCaptureOutcomes.at(-1);
		if (
			pendingOverlaySnapshot.key.toolName !== "task" ||
			pendingOverlaySnapshot.key.toolCallId !== pendingOverlaySnapshot.overlaySnapshot.toolCallId ||
			pendingOverlaySnapshot.finalVersion !== pendingOverlaySnapshot.orderedCaptureOutcomes.length - 1 ||
			!finalOutcome ||
			finalOutcome.outcomeSha256 !== pendingOverlaySnapshot.finalCaptureOutcomeSha256 ||
			!transientTtsrExactJson(finalOutcome.overlaySnapshot, pendingOverlaySnapshot.overlaySnapshot) ||
			pendingOverlaySnapshot.captureOutcomeHistorySha256 !==
				transientTtsrSha256Ref(JSON.stringify(pendingOverlaySnapshot.orderedCaptureOutcomes)) ||
			pendingOverlaySnapshot.pendingOverlaySnapshotSha256 !==
				transientTtsrTupleSha256Ref([
					"omp-transient-task-foreground-settlement-v1",
					"pending-ttsr-snapshot-core",
					1,
					pendingOverlaySnapshot.key,
					pendingOverlaySnapshot.finalVersion,
					pendingOverlaySnapshot.finalVersionSha256,
					pendingOverlaySnapshot.orderedCaptureOutcomes,
					pendingOverlaySnapshot.captureOutcomeHistorySha256,
					pendingOverlaySnapshot.finalCaptureOutcomeSha256,
					pendingOverlaySnapshot.overlaySnapshot,
					pendingOverlaySnapshot.finalizedAt,
				]) ||
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"foreground-ttsr-overlay-snapshot",
				pendingOverlaySnapshot.overlaySnapshot,
			)
		) {
			throw new Error("Durable foreground TTSR overlay snapshot was invalid");
		}
		return pendingOverlaySnapshot.overlaySnapshot;
	}

	/** Applies only the frozen overlay bytes, preserving every other source result field. */
	applyForegroundAfterToolCallOverlaySnapshot(
		rawResult: RuntimeContracts.TransientTaskForegroundSourceAgentToolResultV1,
		snapshot: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrOverlaySnapshotV1,
	): RuntimeContracts.TransientTaskForegroundSourceAgentToolResultV1 {
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("foreground-ttsr-overlay-snapshot", snapshot)) {
			throw new Error("Foreground TTSR overlay snapshot was invalid");
		}
		if (snapshot.mode === "none") return rawResult;
		return {
			...rawResult,
			content: [{ type: "text", text: snapshot.renderedReminderUtf8 }, ...rawResult.content],
		};
	}

	/** Returns the caller-frozen content-only plan after validating its exact rendered-gate joins. */
	async freezeForegroundAfterToolCallInjectionContent(
		snapshot: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrOverlaySnapshotV1,
		preOverlayGateSha256: Sha256Ref,
		renderedGate: RuntimeContracts.ConfidentialTransientTaskForegroundRenderedGateV1,
	): Promise<RuntimeContracts.ConfidentialTransientTaskForegroundTtsrInjectionContentPlanV1> {
		if (!transientTtsrRenderedGateMatchesSnapshot(snapshot, preOverlayGateSha256, renderedGate)) {
			throw new Error("Foreground rendered gate did not match its durable TTSR overlay snapshot");
		}
		return renderedGate.ttsrInjectionContentPlan;
	}

	/** Persists the exact post-primary overlay receipt before promoting repeat state. */
	async commitForegroundOverlayAfterPrimaryPersistence(
		snapshot: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrOverlaySnapshotV1,
		renderedGate: RuntimeContracts.ConfidentialTransientTaskForegroundRenderedGateV1,
		injectionAppendReceipt: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrInjectionAppendReceiptV1,
		primaryReceipt: RuntimeContracts.ConfidentialAgentSessionToolResultPrimaryPersistenceReceiptV1,
	): Promise<RuntimeContracts.TransientTaskForegroundTtsrOverlayCommitResultV1> {
		const runtime = this.#transientTaskRuntime;
		if (!runtime) return { status: "invalid" };
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("foreground-ttsr-overlay-snapshot", snapshot)) {
			return { status: "invalid" };
		}
		if (!transientTtsrRenderedGateMatchesSnapshot(snapshot, renderedGate.preOverlayGateSha256, renderedGate)) {
			return { status: "gate_conflict" };
		}
		const result = await runtime.overlayCommitStore.commitForegroundOverlayAfterPrimaryPersistence(
			snapshot,
			renderedGate,
			injectionAppendReceipt,
			primaryReceipt,
		);
		if (result.status === "committed" || result.status === "already_committed") {
			this.restoreForegroundTtsrRepeatState(result.receipt);
		}
		return result;
	}

	/**
	 * Synchronous outer-event producer. The exact Task observation and the
	 * promise representing its positive revision are registered before the
	 * AgentSession event path reaches an unrelated await.
	 */
	observeTransientTaskMessageUpdate(event: AgentEvent): void {
		if (
			event.type !== "message_update" ||
			event.message.role !== "assistant" ||
			!this.#transientTaskRuntime ||
			this.#transientTaskCaptureByEvent.has(event)
		)
			return;
		const assistantEvent = event.assistantMessageEvent;
		if (
			assistantEvent.type !== "toolcall_start" &&
			assistantEvent.type !== "toolcall_delta" &&
			assistantEvent.type !== "toolcall_end" &&
			assistantEvent.type !== "text_delta" &&
			assistantEvent.type !== "thinking_delta"
		)
			return;

		const stream = this.#transientTaskStream(event.message);
		if (!stream) return;
		if (
			assistantEvent.type === "toolcall_start" ||
			assistantEvent.type === "toolcall_delta" ||
			assistantEvent.type === "toolcall_end"
		) {
			const toolCall =
				assistantEvent.type === "toolcall_end"
					? assistantEvent.toolCall
					: this.#getStreamingToolCallBlock(event.message, assistantEvent.contentIndex);
			if (toolCall?.name !== "task" || !toolCall.id) return;
			const state = this.#transientTaskCaptureState(stream, event.message, toolCall);
			if (!state) return;
			this.#registerTransientTaskStreamedObservation(state, assistantEvent.type, assistantEvent.contentIndex);
			if (assistantEvent.type !== "toolcall_delta") return;
			const started = this.#captureTransientTaskMessageUpdate(state, event.message, assistantEvent, toolCall);
			this.#transientTaskCaptureByEvent.set(event, started);
			return;
		}

		if (!this.#manager || stream.taskStates.size === 0) return;
		const started = this.#captureTransientTaskSharedMessageUpdate(stream, event.message, assistantEvent);
		if (started) this.#transientTaskCaptureByEvent.set(event, started);
	}

	/** Finalizes the exact Task capture queue before core dispatch starts. */
	async prepareTransientTaskBeforeToolCall(
		assistantMessage: AssistantMessage,
		toolCall: ToolCall,
	): Promise<TransientTaskTtsrPreDispatchStateV1> {
		if (toolCall.name !== "task") throw new Error("Expected canonical Task tool call");
		return this.#prepareTransientForegroundBeforeToolCall(assistantMessage, toolCall);
	}

	/** Finalizes a nonstreamed Eval capture only when the outer eval can own isolated children. */
	async prepareTransientEvalBeforeToolCall(
		assistantMessage: AssistantMessage,
		toolCall: ToolCall,
	): Promise<TransientTaskTtsrPreDispatchStateV1> {
		if (toolCall.name !== "eval") throw new Error("Expected canonical Eval tool call");
		return this.#prepareTransientForegroundBeforeToolCall(assistantMessage, toolCall);
	}

	async #prepareTransientForegroundBeforeToolCall(
		assistantMessage: AssistantMessage,
		toolCall: ToolCall,
	): Promise<TransientTaskTtsrPreDispatchStateV1> {
		if ((toolCall.name !== "task" && toolCall.name !== "eval") || !toolCall.id) {
			throw new Error("Expected canonical foreground tool call");
		}
		const stream = this.#transientTaskStream(assistantMessage);
		const state = stream && this.#transientTaskCaptureState(stream, assistantMessage, toolCall);
		if (!state) throw new Error("Transient foreground capture authority is unavailable");
		const toolName = state.key.toolName;
		const queueInspectionSha256 = transientTtsrTupleSha256Ref([
			"omp-transient-task-foreground-settlement-v1",
			"pending-ttsr-queue-inspection-core",
			1,
			state.key.keySha256,
			state.observedStreamedToolCallEventCount,
			state.registeredMessageUpdateCaptureCount,
			state.orderedStreamedObservations,
		]);
		const baselineSourceMode =
			state.observedStreamedToolCallEventCount === 0
				? ("nonstreamed_no_match_baseline" as const)
				: ("streamed_no_match_baseline" as const);
		const baselineCore = {
			schemaVersion: 1 as const,
			key: state.key,
			parentSessionId: state.key.parentSessionId,
			parentSessionGenerationSha256: state.key.parentSessionGenerationSha256,
			preAssistantBranchGenerationSha256: state.key.preAssistantBranchGenerationSha256,
			preAssistantAnchorEntryId: state.key.preAssistantAnchorEntryId,
			toolCallId: state.key.toolCallId,
			toolName,
			captureGeneration: state.key.captureGeneration,
			assistantStreamSha256: state.key.assistantStreamSha256,
			captureRevision: 0 as const,
			queueInspectionSha256,
		};
		const captureInputSha256 = transientTtsrTupleSha256Ref([
			"omp-transient-task-foreground-settlement-v1",
			"pending-ttsr-no-match-baseline-core",
			1,
			state.key,
			state.key.parentSessionId,
			state.key.parentSessionGenerationSha256,
			state.key.preAssistantBranchGenerationSha256,
			state.key.preAssistantAnchorEntryId,
			state.key.toolCallId,
			toolName,
			state.key.captureGeneration,
			state.key.assistantStreamSha256,
			0,
			baselineSourceMode,
			state.observedStreamedToolCallEventCount,
			state.registeredMessageUpdateCaptureCount,
			queueInspectionSha256,
		]);
		let baseline: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrNoMatchBaselineInputV1;
		if (state.observedStreamedToolCallEventCount === 0) {
			if (state.registeredMessageUpdateCaptureCount !== 0) {
				throw new Error("Nonstreamed TTSR baseline cannot follow registered message-update captures");
			}
			baseline = {
				...baselineCore,
				sourceMode: "nonstreamed_no_match_baseline",
				observedStreamedToolCallEventCount: 0,
				registeredMessageUpdateCaptureCount: 0,
				captureInputSha256,
			};
		} else {
			baseline = {
				...baselineCore,
				sourceMode: "streamed_no_match_baseline",
				observedStreamedToolCallEventCount: state.observedStreamedToolCallEventCount,
				registeredMessageUpdateCaptureCount: state.registeredMessageUpdateCaptureCount,
				captureInputSha256,
			};
		}
		const requestedAt = transientTtsrNow();
		const requestCore = [
			"omp-transient-task-foreground-settlement-v1",
			"pending-ttsr-before-tool-call-core",
			1,
			state.key,
			baseline,
			state.registeredMessageUpdateCaptureCount,
			state.registeredMessageUpdateCaptureCount,
			requestedAt,
		] as const;
		const gate = await this.waitUntilPendingOverlayDurable({
			key: state.key,
			baseline,
			expectedMessageUpdateCaptureCount: state.registeredMessageUpdateCaptureCount,
			expectedFinalCaptureRevision: state.registeredMessageUpdateCaptureCount,
			requestedAt,
			requestSha256: transientTtsrTupleSha256Ref(requestCore),
		});
		if (gate.status !== "ready")
			throw new Error(`Transient foreground TTSR pre-dispatch barrier blocked: ${gate.reason}`);
		return {
			indexKey: state.indexKey,
			snapshot: gate.snapshot,
			binding: gate.binding,
			sourceToolCallOrdinal: state.sourceToolCallOrdinal,
		};
	}

	/** Binds a finalized opaque overlay to the exact persisted assistant entry. */
	async resolveFinalizedPendingOverlayForBeforeReturn(
		request: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayAnchorResolutionRequestV1,
	): Promise<RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayBindingResolutionResultV1> {
		const runtime = this.#transientTaskRuntime;
		const state = this.#transientTaskByToolCallId.get(request.toolCallId);
		if (
			!runtime ||
			!state?.finalized ||
			state.key.parentSessionId !== request.parentSessionId ||
			state.key.parentSessionGenerationSha256 !== request.parentSessionGenerationSha256 ||
			state.finalized.binding.bindingSha256 !== request.preDispatchBinding.bindingSha256
		)
			return { status: "invalid" };
		const bindRequestedAt = request.requestedAt;
		const bindCore = [
			"omp-transient-task-foreground-settlement-v1",
			"pending-ttsr-anchor-bind-core",
			1,
			state.finalized.snapshot,
			state.finalized.binding,
			request.parentBranchGenerationSha256,
			request.parentBranchAnchorEntryId,
			request.toolCallId,
			bindRequestedAt,
		] as const;
		const result = await runtime.overlayStore.bindPendingOverlayToAssistantAnchor({
			snapshot: state.finalized.snapshot,
			preDispatchBinding: state.finalized.binding,
			parentBranchGenerationSha256: request.parentBranchGenerationSha256,
			parentBranchAnchorEntryId: request.parentBranchAnchorEntryId,
			toolCallId: request.toolCallId,
			requestedAt: bindRequestedAt,
			requestSha256: transientTtsrTupleSha256Ref(bindCore),
		});
		return result.status === "bound" || result.status === "already_bound"
			? {
					status: result.status === "bound" ? "resolved" : "already_resolved",
					binding: result.binding,
					receiptSha256: result.receiptSha256,
				}
			: { status: result.status };
	}

	async waitUntilPendingOverlayDurable(
		request: RuntimeContracts.ConfidentialTransientTaskForegroundBeforeToolCallPendingOverlayRequestV1,
	): Promise<RuntimeContracts.TransientTaskForegroundBeforeToolCallPendingOverlayGateResultV1> {
		const runtime = this.#transientTaskRuntime;
		const state = this.#transientTaskByToolCallId.get(request.key.toolCallId);
		if (!runtime) return { status: "blocked", reason: "store_unavailable" };
		if (
			!state ||
			state.key.keySha256 !== request.key.keySha256 ||
			request.expectedMessageUpdateCaptureCount !== state.registeredMessageUpdateCaptureCount ||
			request.expectedFinalCaptureRevision !== state.registeredMessageUpdateCaptureCount
		)
			return { status: "blocked", reason: "invalid" };
		for (let revision = 1; revision <= request.expectedFinalCaptureRevision; revision++) {
			const started = state.startedCaptures.get(revision);
			if (!started) return { status: "blocked", reason: "expected_capture_missing" };
			try {
				await started;
			} catch {
				return { status: "blocked", reason: "version_conflict" };
			}
		}
		if (request.expectedFinalCaptureRevision === 0) {
			try {
				await this.#persistTransientTaskCapture(state, request.baseline, [], undefined);
			} catch {
				return { status: "blocked", reason: "version_conflict" };
			}
		}
		const versions = [...state.preparedVersions].sort((left, right) => left.version - right.version);
		if (
			versions.length !==
				request.expectedFinalCaptureRevision + (request.expectedFinalCaptureRevision === 0 ? 1 : 0) ||
			versions.some((version, ordinal) =>
				request.expectedFinalCaptureRevision === 0 ? version.version !== 0 : version.version !== ordinal + 1,
			)
		)
			return { status: "blocked", reason: "capture_version_gap" };
		const finalVersion = versions.at(-1);
		if (!finalVersion) return { status: "blocked", reason: "expected_capture_missing" };
		const outcomes = versions.map(version => version.outcome) as [
			RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrCaptureOutcomeV1,
			...RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrCaptureOutcomeV1[],
		];
		const captureOutcomeHistorySha256 = transientTtsrSha256Ref(JSON.stringify(outcomes));
		const finalizedAt = transientTtsrNow();
		const finalizeRequest: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayFinalizeRequestV1 = {
			key: state.key,
			expectedFinalVersion: finalVersion.version,
			expectedFinalVersionSha256: finalVersion.versionSha256,
			expectedCaptureOutcomeHistorySha256: captureOutcomeHistorySha256,
			finalizedAt,
			requestSha256: transientTtsrTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"pending-ttsr-finalize-core",
				1,
				state.key,
				finalVersion.version,
				finalVersion.versionSha256,
				captureOutcomeHistorySha256,
				finalizedAt,
			]),
		};
		const expectedSnapshotCore = {
			schemaVersion: 1 as const,
			key: state.key,
			finalVersion: finalVersion.version,
			finalVersionSha256: finalVersion.versionSha256,
			orderedCaptureOutcomes: outcomes,
			captureOutcomeHistorySha256,
			finalCaptureOutcomeSha256: finalVersion.outcome.outcomeSha256,
			overlaySnapshot: finalVersion.outcome.overlaySnapshot,
			finalizedAt,
		};
		const pendingOverlaySnapshotSha256 = transientTtsrTupleSha256Ref([
			"omp-transient-task-foreground-settlement-v1",
			"pending-ttsr-snapshot-core",
			1,
			state.key,
			finalVersion.version,
			finalVersion.versionSha256,
			outcomes,
			captureOutcomeHistorySha256,
			finalVersion.outcome.outcomeSha256,
			finalVersion.outcome.overlaySnapshot,
			finalizedAt,
		]);
		const expectedSnapshot = { ...expectedSnapshotCore, pendingOverlaySnapshotSha256 };
		const expectedBindingCore = {
			keySha256: state.key.keySha256,
			finalVersion: finalVersion.version,
			finalVersionSha256: finalVersion.versionSha256,
			captureOutcomeHistorySha256,
			finalCaptureOutcomeSha256: finalVersion.outcome.outcomeSha256,
			pendingOverlaySnapshotSha256,
		};
		const expectedBinding = {
			...expectedBindingCore,
			bindingSha256: transientTtsrTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"pending-ttsr-pre-dispatch-binding-core",
				1,
				expectedBindingCore.keySha256,
				expectedBindingCore.finalVersion,
				expectedBindingCore.finalVersionSha256,
				expectedBindingCore.captureOutcomeHistorySha256,
				expectedBindingCore.finalCaptureOutcomeSha256,
				expectedBindingCore.pendingOverlaySnapshotSha256,
			]),
		};
		try {
			const finalized = await runtime.overlayStore.finalizePendingOverlay(finalizeRequest);
			if (finalized.status === "finalized" || finalized.status === "already_finalized") {
				state.finalized = { snapshot: finalized.snapshot, binding: finalized.binding };
				return { status: "ready", snapshot: finalized.snapshot, binding: finalized.binding };
			}
		} catch {
			// The exact inspect/adopt path below resolves a lost finalization response.
		}
		const inspectedAt = transientTtsrNow();
		const inspectRequest: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayInspectRequestV1 = {
			key: state.key,
			expectedBinding,
			requestedAt: inspectedAt,
			requestSha256: transientTtsrTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"pending-ttsr-inspect-core",
				1,
				state.key,
				expectedBinding,
				inspectedAt,
			]),
		};
		const inspection = await runtime.overlayStore.inspectPendingOverlay(inspectRequest);
		if (inspection.status !== "matching")
			return { status: "blocked", reason: this.#pendingOverlayBlockReason(inspection.status) };
		const adoptedAt = transientTtsrNow();
		const adoption = await runtime.overlayStore.adoptPendingOverlay({
			inspection,
			expectedInspectionSha256: inspection.inspectionSha256,
			requestedAt: adoptedAt,
			requestSha256: transientTtsrTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"pending-ttsr-adopt-core",
				1,
				inspection,
				inspection.inspectionSha256,
				adoptedAt,
			]),
		});
		if (adoption.status !== "adopted" && adoption.status !== "already_adopted")
			return { status: "blocked", reason: this.#pendingOverlayBlockReason(adoption.status) };
		if (adoption.snapshot.pendingOverlaySnapshotSha256 !== expectedSnapshot.pendingOverlaySnapshotSha256)
			return { status: "blocked", reason: "finalization_conflict" };
		state.finalized = { snapshot: adoption.snapshot, binding: adoption.binding };
		return { status: "ready", snapshot: adoption.snapshot, binding: adoption.binding };
	}

	/** Configured TTSR manager, when stream rules are enabled. */
	get manager(): TtsrManager | undefined {
		return this.#manager;
	}

	/** Whether a TTSR-triggered stream abort is awaiting its continuation. */
	get abortPending(): boolean {
		return this.#abortPending;
	}

	/** Current resume gate awaited by post-prompt recovery. */
	get resumeGate(): Promise<void> | undefined {
		return this.#resumePromise;
	}

	/** Resets stream buffers at turn start. */
	onTurnStart(): void {
		this.#manager?.resetBuffer();
	}

	/** Advances repeat-after-gap tracking at turn end. */
	onTurnEnd(): void {
		this.#manager?.incrementMessageCount();
	}

	/** Checks one streamed message update and reports whether TTSR consumed it by aborting. */
	async checkMessageUpdate(event: AgentEvent): Promise<boolean> {
		this.observeTransientTaskMessageUpdate(event);
		const transientCapture = this.#transientTaskCaptureByEvent.get(event);
		if (transientCapture) return transientCapture;
		if (event.type !== "message_update" || !this.#manager?.hasRules()) return false;
		const assistantEvent = event.assistantMessageEvent;
		let matchContext: TtsrMatchContext | undefined;
		let streamingToolCall: ToolCall | undefined;
		if (assistantEvent.type === "text_delta") {
			matchContext = { source: "text" };
		} else if (assistantEvent.type === "thinking_delta") {
			matchContext = { source: "thinking" };
		} else if (assistantEvent.type === "toolcall_delta") {
			streamingToolCall = this.#getStreamingToolCallBlock(event.message, assistantEvent.contentIndex);
			matchContext = this.#getToolMatchContext(streamingToolCall, assistantEvent.contentIndex);
		}
		if (!matchContext || !("delta" in assistantEvent)) return false;
		const targetMessageTimestamp = event.message.role === "assistant" ? event.message.timestamp : undefined;
		const matches = this.#checkStream(assistantEvent.delta, matchContext, streamingToolCall);
		if (matches.length > 0 && this.#handleMatches(matches, matchContext, targetMessageTimestamp)) return true;
		// AST rules use the reconstructed edit/write snapshot and are awaited so
		// the manager self-throttles native matching.
		if (matchContext.source === "tool" && this.#manager.hasAstRules()) {
			const astMatches = await this.#checkAstStream(matchContext, streamingToolCall);
			if (astMatches.length > 0 && this.#handleMatches(astMatches, matchContext, targetMessageTimestamp))
				return true;
		}
		return false;
	}

	/** Settles the previous resume gate and queues any deferred injection. */
	onAssistantMessageEnd(message: AssistantMessage): void {
		// Gate on abortPending, not stopReason: unrelated aborts have no TTSR continuation.
		if (!this.#abortPending) this.resolveResume();
		this.#queueDeferredInjectionIfNeeded(message);
	}

	/** Marks names persisted with a delivered TTSR injection as injected. */
	markInjectedFromDetails(details: unknown): void {
		if (!details || typeof details !== "object" || Array.isArray(details)) return;
		const rules = "rules" in details ? details.rules : undefined;
		if (!Array.isArray(rules)) return;
		this.#markInjected(rules.filter((ruleName): ruleName is string => typeof ruleName === "string"));
	}

	/** Folds per-tool reminders into the matched tool's result. */
	afterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
		const rules = this.#perToolInjections.get(ctx.toolCall.id);
		if (!rules || rules.length === 0) return undefined;
		this.#perToolInjections.delete(ctx.toolCall.id);
		const reminder = rules
			.map(rule =>
				prompt.render(ttsrToolReminderTemplate, {
					name: rule.name,
					path: this.#displayRulePath(rule.path),
					content: rule.content,
				}),
			)
			.join("\n\n");
		const ruleNames = rules.map(rule => rule.name.trim()).filter(name => name.length > 0);
		if (ruleNames.length > 0) this.#host.sessionManager.appendTtsrInjection(ruleNames);
		return { content: [{ type: "text", text: reminder }, ...ctx.result.content] };
	}

	/** Atomically claims one Hub call's pending reminder bucket without appending session state. */
	claimHubWaitAfterToolCallPlan(
		toolCallId: string,
		frozenAt: ISO8601,
	): RuntimeContracts.ConfidentialTransientTaskHubWaitMessageAfterToolCallPlanV1 {
		const rules = this.#perToolInjections.get(toolCallId) ?? [];
		this.#perToolInjections.delete(toolCallId);
		const overlaySnapshot = this.#overlaySnapshotForRules(toolCallId, rules);
		const ttsrInjectionContentPlan =
			overlaySnapshot.mode === "none"
				? buildTransientTaskHubWaitMessageCanonicalRecordV1("foreground-ttsr-injection-content-plan", {
						disposition: "no_entry" as const,
						injectedRuleNames: [] as const,
					})
				: buildTransientTaskHubWaitMessageCanonicalRecordV1("foreground-ttsr-injection-content-plan", {
						disposition: "exact_entry" as const,
						entryTimestamp: frozenAt,
						injectedRuleNames: overlaySnapshot.injectedRuleNames as [string, ...string[]],
						overlaySnapshotSha256: overlaySnapshot.snapshotSha256,
					});
		return buildTransientTaskHubWaitMessageCanonicalRecordV1("after-tool-call-plan", {
			schemaVersion: 1 as const,
			toolCallId,
			toolName: "hub" as const,
			overlaySnapshot,
			ttsrInjectionContentPlan,
			frozenAt,
		});
	}

	/** Resolves and clears the current resume gate. */
	resolveResume(): void {
		if (!this.#resumeResolve) return;
		this.#resumeResolve();
		this.#resumeResolve = undefined;
		this.#resumePromise = undefined;
	}

	#ensureResumePromise(): void {
		if (this.#resumePromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#resumePromise = promise;
		this.#resumeResolve = resolve;
	}

	#formatAbortReason(rules: Rule[]): string {
		const label = rules.length === 1 ? "rule" : "rules";
		return `TTSR matched ${label}: ${rules.map(rule => rule.name).join(", ")}`;
	}

	#getInjectionContent(): { content: string; rules: Rule[] } | undefined {
		if (this.#pendingInjections.length === 0) return undefined;
		const rules = this.#pendingInjections;
		const content = rules
			.map(rule =>
				prompt.render(ttsrInterruptTemplate, {
					name: rule.name,
					path: this.#displayRulePath(rule.path),
					content: rule.content,
				}),
			)
			.join("\n\n");
		this.#pendingInjections = [];
		return { content, rules };
	}

	#displayRulePath(rulePath: string): string {
		const cwd = this.#host.sessionManager.getCwd();
		const cwdRelative = relativePathWithinRoot(cwd, rulePath) ?? this.#displayPathWithinRoot(cwd, rulePath);
		if (cwdRelative) return cwdRelative;
		const homeRelative = relativePathWithinRoot(os.homedir(), rulePath);
		if (homeRelative) return `~/${homeRelative}`;
		return rulePath;
	}

	#displayPathWithinRoot(root: string, candidate: string): string | null {
		const relative = path.relative(path.resolve(root), path.resolve(candidate));
		return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
	}

	#addPendingInjections(rules: Rule[]): void {
		const seen = new Set(this.#pendingInjections.map(rule => rule.name));
		for (const rule of rules) {
			if (seen.has(rule.name)) continue;
			this.#pendingInjections.push(rule);
			seen.add(rule.name);
		}
	}

	#extractToolCallId(matchContext: TtsrMatchContext): string | undefined {
		if (matchContext.source !== "tool") return undefined;
		const key = matchContext.streamKey;
		if (typeof key !== "string" || !key.startsWith("toolcall:")) return undefined;
		const id = key.slice("toolcall:".length);
		return id.length > 0 ? id : undefined;
	}

	#addPerToolInjections(toolCallId: string, rules: Rule[]): void {
		const bucket = this.#perToolInjections.get(toolCallId) ?? [];
		const seen = new Set(bucket.map(rule => rule.name));
		const claimedElsewhere = new Set<string>();
		for (const [otherId, otherBucket] of this.#perToolInjections) {
			if (otherId === toolCallId) continue;
			for (const rule of otherBucket) claimedElsewhere.add(rule.name);
		}
		const newlyAdded: string[] = [];
		for (const rule of rules) {
			if (seen.has(rule.name) || claimedElsewhere.has(rule.name)) continue;
			bucket.push(rule);
			seen.add(rule.name);
			newlyAdded.push(rule.name);
		}
		if (bucket.length === 0) return;
		this.#perToolInjections.set(toolCallId, bucket);
		if (newlyAdded.length > 0) this.#manager?.markInjectedByNames(newlyAdded);
	}

	#markInjected(ruleNames: string[]): void {
		const uniqueRuleNames = Array.from(
			new Set(ruleNames.map(ruleName => ruleName.trim()).filter(ruleName => ruleName.length > 0)),
		);
		if (uniqueRuleNames.length === 0) return;
		this.#manager?.markInjectedByNames(uniqueRuleNames);
		this.#host.sessionManager.appendTtsrInjection(uniqueRuleNames);
	}

	#findAssistantIndex(targetTimestamp: number | undefined): number {
		const messages = this.#host.agent.state.messages;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message.role === "assistant" && (targetTimestamp === undefined || message.timestamp === targetTimestamp)) {
				return index;
			}
		}
		return -1;
	}

	#shouldInterrupt(matches: Rule[], matchContext: TtsrMatchContext): boolean {
		const globalMode = this.#manager?.getSettings().interruptMode ?? "always";
		for (const rule of matches) {
			const mode = rule.interruptMode ?? globalMode;
			if (mode === "never") continue;
			if (mode === "prose-only" && (matchContext.source === "text" || matchContext.source === "thinking")) {
				return true;
			}
			if (mode === "tool-only" && matchContext.source === "tool") return true;
			if (mode === "always") return true;
		}
		return false;
	}

	#queueDeferredInjectionIfNeeded(message: AssistantMessage): void {
		if (message.stopReason === "aborted" || message.stopReason === "error") this.#perToolInjections.clear();
		if (this.#abortPending || this.#pendingInjections.length === 0) return;
		if (message.stopReason === "aborted" || message.stopReason === "error") {
			this.#pendingInjections = [];
			return;
		}
		const injection = this.#getInjectionContent();
		if (!injection) return;
		this.#host.agent.followUp({
			role: "custom",
			customType: "ttsr-injection",
			content: injection.content,
			display: false,
			details: { rules: injection.rules.map(rule => rule.name) },
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#ensureResumePromise();
		this.#host.scheduleAgentContinue({
			delayMs: 1,
			generation: this.#host.promptGeneration(),
			onSkip: () => this.resolveResume(),
			shouldContinue: () => {
				if (this.#host.agent.state.isStreaming || !this.#host.agent.hasQueuedMessages()) {
					this.resolveResume();
					return false;
				}
				return true;
			},
			onError: () => this.resolveResume(),
		});
	}

	#getStreamingToolCallBlock(message: AgentMessage, contentIndex: number): ToolCall | undefined {
		if (message.role !== "assistant") return undefined;
		const content = message.content;
		if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) return undefined;
		const block = content[contentIndex];
		return block && typeof block === "object" && block.type === "toolCall" ? (block as ToolCall) : undefined;
	}

	#getToolMatchContext(toolCall: ToolCall | undefined, contentIndex: number): TtsrMatchContext {
		const context: TtsrMatchContext = { source: "tool" };
		if (!toolCall) return context;
		context.toolName = toolCall.name;
		context.streamKey = toolCall.id ? `toolcall:${toolCall.id}` : `tool:${toolCall.name}:${contentIndex}`;
		context.filePaths = this.#extractToolFilePaths(toolCall);
		return context;
	}

	#extractToolFilePaths(toolCall: ToolCall): string[] | undefined {
		const args = toolCall.arguments ?? {};
		const tool = this.#resolveTool(toolCall);
		const toolPaths = tool?.matcherPaths?.(args);
		if (toolPaths && toolPaths.length > 0) {
			const normalized = toolPaths.flatMap(filePath => this.#normalizePathCandidates(filePath));
			if (normalized.length > 0) return Array.from(new Set(normalized));
		}
		return this.#extractFilePathsFromArgs(args);
	}

	#checkStream(delta: string, matchContext: TtsrMatchContext, toolCall: ToolCall | undefined): Rule[] {
		if (!this.#manager) return [];
		const entries = this.#resolveMatcherEntries(toolCall);
		if (entries) {
			const matches: Rule[] = [];
			for (const entry of entries) {
				matches.push(...this.#manager.checkSnapshot(entry.digest, this.#perFileContext(matchContext, entry.path)));
			}
			return matches;
		}
		const digest = this.#resolveMatcherDigest(toolCall);
		return digest !== undefined
			? this.#manager.checkSnapshot(digest, matchContext)
			: this.#manager.checkDelta(delta, matchContext);
	}

	#resolveMatcherDigest(toolCall: ToolCall | undefined): string | undefined {
		const tool = this.#resolveTool(toolCall);
		return tool?.matcherDigest?.(toolCall?.arguments ?? {});
	}

	#resolveMatcherEntries(toolCall: ToolCall | undefined): readonly { path: string; digest: string }[] | undefined {
		const tool = this.#resolveTool(toolCall);
		const entries = tool?.matcherEntries?.(toolCall?.arguments ?? {});
		return entries && entries.length > 0 ? entries : undefined;
	}

	#resolveTool(toolCall: ToolCall | undefined) {
		if (!toolCall) return undefined;
		const tools = this.#host.agent.state.tools;
		return (
			tools.find(tool => tool.name === toolCall.name) ??
			tools.find(tool => tool.customWireName !== undefined && tool.customWireName === toolCall.name)
		);
	}

	#perFileContext(base: TtsrMatchContext, filePath: string): TtsrMatchContext {
		const filePaths = this.#normalizePathCandidates(filePath);
		return {
			...base,
			filePaths: filePaths.length > 0 ? filePaths : [filePath],
			streamKey: base.streamKey ? `${base.streamKey}#${filePath}` : undefined,
		};
	}

	async #checkAstStream(matchContext: TtsrMatchContext, toolCall: ToolCall | undefined): Promise<Rule[]> {
		if (!this.#manager) return [];
		const entries = this.#resolveMatcherEntries(toolCall);
		if (entries) {
			const matches: Rule[] = [];
			for (const entry of entries) {
				matches.push(
					...(await this.#manager.checkAstSnapshot(entry.digest, this.#perFileContext(matchContext, entry.path))),
				);
			}
			return matches;
		}
		const digest = this.#resolveMatcherDigest(toolCall);
		return digest === undefined ? [] : this.#manager.checkAstSnapshot(digest, matchContext);
	}

	#handleMatches(matches: Rule[], matchContext: TtsrMatchContext, targetTimestamp: number | undefined): boolean {
		const shouldInterrupt = this.#shouldInterrupt(matches, matchContext);
		const matchedToolId = this.#extractToolCallId(matchContext);
		const perToolId = shouldInterrupt ? undefined : matchedToolId;
		if (perToolId) {
			this.#addPerToolInjections(perToolId, matches);
			this.#host.emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
			return false;
		}
		this.#addPendingInjections(matches);
		if (!shouldInterrupt) return false;

		this.#abortPending = true;
		this.#ensureResumePromise();
		const abortReason = this.#formatAbortReason(matches);
		this.#host.agent.abort(
			matchedToolId
				? createToolScopedAbortReason(
						abortReason,
						{ [matchedToolId]: abortReason },
						"TTSR interrupt on another tool call",
					)
				: abortReason,
		);
		this.#host.emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
		const retryToken = ++this.#retryToken;
		const generation = this.#host.promptGeneration();
		this.#host.schedulePostPromptTask(
			async () => {
				if (this.#retryToken !== retryToken) {
					this.resolveResume();
					return;
				}
				const targetAssistantIndex = this.#findAssistantIndex(targetTimestamp);
				if (!this.#abortPending || this.#host.promptGeneration() !== generation || targetAssistantIndex === -1) {
					this.#abortPending = false;
					this.#pendingInjections = [];
					this.#perToolInjections.clear();
					this.resolveResume();
					return;
				}
				this.#abortPending = false;
				this.#perToolInjections.clear();
				if (this.#manager?.getSettings().contextMode === "discard") {
					this.#host.agent.replaceMessages(this.#host.agent.state.messages.slice(0, targetAssistantIndex));
				}
				const injection = this.#getInjectionContent();
				if (injection) {
					const details = { rules: injection.rules.map(rule => rule.name) };
					this.#host.agent.appendMessage({
						role: "custom",
						customType: "ttsr-injection",
						content: injection.content,
						display: false,
						details,
						attribution: "agent",
						timestamp: Date.now(),
					});
					this.#host.sessionManager.appendCustomMessageEntry(
						"ttsr-injection",
						injection.content,
						false,
						details,
						"agent",
					);
					this.#markInjected(details.rules);
				}
				try {
					await this.#host.agent.continue();
				} catch {
					this.resolveResume();
				}
			},
			{ delayMs: 50 },
		);
		return true;
	}

	#transientTaskStream(message: AssistantMessage): TransientTaskTtsrStreamStateV1 | undefined {
		const existing = this.#transientTaskStreams.get(message);
		if (existing) return existing;
		const preAssistantAnchorEntryId = this.#host.sessionManager.getLeafId() ?? null;
		const resolved =
			this.#host.sessionManager.resolveTransientTaskJournalGenerationAuthority(preAssistantAnchorEntryId);
		if (resolved.status !== "matching") return undefined;
		const stream: TransientTaskTtsrStreamStateV1 = {
			assistantStreamSha256: transientTtsrSha256Ref(Bun.randomUUIDv7()),
			preAssistantAuthority: resolved.authority,
			preAssistantAnchorEntryId,
			taskStates: new Map(),
			provisionalClaimsByRuleName: new Map(),
			captureTail: Promise.resolve(),
		};
		this.#transientTaskStreams.set(message, stream);
		return stream;
	}

	#transientTaskCaptureState(
		stream: TransientTaskTtsrStreamStateV1,
		message: AssistantMessage,
		toolCall: ToolCall,
	): TransientTaskTtsrCaptureStateV1 | undefined {
		if (toolCall.name !== "task" && toolCall.name !== "eval") return undefined;
		const existing = stream.taskStates.get(toolCall.id);
		if (existing) return existing;
		if (stream.preAssistantAnchorEntryId === null) return undefined;
		let sourceToolCallOrdinal = 0;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			if (block.id === toolCall.id) break;
			sourceToolCallOrdinal += 1;
		}
		const authority = stream.preAssistantAuthority;
		const toolName = toolCall.name;
		const captureGeneration = this.#nextTransientTaskCaptureGeneration++;
		const keyCore = [
			"omp-transient-task-foreground-settlement-v1",
			"pending-ttsr-key-core",
			1,
			authority.sessionGeneration.core.sessionId,
			authority.sessionGeneration.sessionGenerationSha256,
			authority.branchGeneration.branchGenerationSha256,
			stream.preAssistantAnchorEntryId,
			toolCall.id,
			toolName,
			captureGeneration,
			stream.assistantStreamSha256,
		] as const;
		const key: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayKeyV1 = {
			schemaVersion: 1,
			parentSessionId: authority.sessionGeneration.core.sessionId,
			parentSessionGenerationSha256: authority.sessionGeneration.sessionGenerationSha256,
			preAssistantBranchGenerationSha256: authority.branchGeneration.branchGenerationSha256,
			preAssistantAnchorEntryId: stream.preAssistantAnchorEntryId,
			toolCallId: toolCall.id,
			toolName,
			captureGeneration,
			assistantStreamSha256: stream.assistantStreamSha256,
			keySha256: transientTtsrTupleSha256Ref(keyCore),
		};
		const indexCore: RuntimeContracts.ConfidentialTransientTaskPendingCaptureIndexKeyCoreV1 = {
			schemaVersion: 1,
			parentSessionId: key.parentSessionId,
			parentSessionGenerationSha256: key.parentSessionGenerationSha256,
			parentBranchGenerationSha256: key.preAssistantBranchGenerationSha256,
			assistantAnchorEntryId: stream.preAssistantAnchorEntryId,
			toolCallId: toolCall.id,
			toolName,
			sourceToolCallOrdinal,
		};
		const state: TransientTaskTtsrCaptureStateV1 = {
			stream,
			key,
			indexKey: {
				core: indexCore,
				indexKeySha256: canonicalTransientTaskSourceObservationDigestV1("pending_capture_index_key", indexCore),
			},
			sourceToolCallOrdinal,
			orderedStreamedObservations: [],
			startedCaptures: new Map(),
			preparedVersions: [],
			accumulatedRules: [],
			observedStreamedToolCallEventCount: 0,
			registeredMessageUpdateCaptureCount: 0,
			nextCaptureRevision: 1,
			finalized: undefined,
			startedRecordSha256: undefined,
		};
		stream.taskStates.set(toolCall.id, state);
		this.#transientTaskByToolCallId.set(toolCall.id, state);
		return state;
	}

	#registerTransientTaskStreamedObservation(
		state: TransientTaskTtsrCaptureStateV1,
		sourceEvent: RuntimeContracts.ConfidentialTransientTaskForegroundStreamedToolCallObservationCoreV1["sourceEvent"],
		contentIndex: number,
	): void {
		const core: RuntimeContracts.ConfidentialTransientTaskForegroundStreamedToolCallObservationCoreV1 = {
			keySha256: state.key.keySha256,
			sourceEvent,
			reconstructedToolCallId: state.key.toolCallId,
			reconstructedToolName: "task",
			contentIndex,
			observedAt: transientTtsrNow(),
		};
		state.orderedStreamedObservations.push({
			core,
			observationSha256: transientTtsrTupleSha256Ref([
				"omp-transient-task-capture-terminal-v1",
				"streamed-tool-call-observation-core",
				1,
				core.keySha256,
				core.sourceEvent,
				core.reconstructedToolCallId,
				"task",
				core.contentIndex,
				core.observedAt,
			]),
		});
		state.observedStreamedToolCallEventCount += 1;
	}

	#captureTransientTaskMessageUpdate(
		state: TransientTaskTtsrCaptureStateV1,
		message: AssistantMessage,
		assistantEvent: Extract<AgentEvent, { type: "message_update" }>["assistantMessageEvent"] & {
			readonly type: "toolcall_delta";
		},
		toolCall: ToolCall,
	): Promise<boolean> {
		const revision = state.nextCaptureRevision++;
		state.registeredMessageUpdateCaptureCount += 1;
		const priorTail = state.stream.captureTail;
		const work = (async () => {
			await priorTail;
			const evaluation = await this.#evaluateTransientTaskToolInput(
				state,
				message,
				assistantEvent,
				toolCall,
				revision,
			);
			const version = await this.#persistTransientTaskCapture(
				state,
				evaluation.input,
				evaluation.matches,
				evaluation.matchContext,
			);
			return { version, interrupted: evaluation.interrupted };
		})();
		const version = work.then(result => result.version);
		state.startedCaptures.set(revision, version);
		state.stream.captureTail = work.then(
			() => undefined,
			() => undefined,
		);
		return work.then(result => result.interrupted);
	}

	#captureTransientTaskSharedMessageUpdate(
		stream: TransientTaskTtsrStreamStateV1,
		message: AssistantMessage,
		assistantEvent: Extract<AgentEvent, { type: "message_update" }>["assistantMessageEvent"] &
			({ readonly type: "text_delta" } | { readonly type: "thinking_delta" }),
	): Promise<boolean> {
		const matchContext: TtsrMatchContext = {
			source: assistantEvent.type === "text_delta" ? "text" : "thinking",
			streamKey: assistantEvent.type === "text_delta" ? "text" : "thinking",
		};
		const matches = this.#dedupeRules(this.#manager?.checkDelta(assistantEvent.delta, matchContext) ?? []);
		if (matches.length === 0) return Promise.resolve(false);
		const associated = [...stream.taskStates.values()]
			.map(state => ({
				state,
				rules: matches.filter(rule => stream.provisionalClaimsByRuleName.get(rule.name)?.state === state),
			}))
			.filter(candidate => candidate.rules.length > 0);
		if (associated.length === 0) {
			return Promise.resolve(this.#handleMatches(matches, matchContext, message.timestamp));
		}
		const interrupted = this.#handleTransientTaskMatches(matches, matchContext, message.timestamp);
		const sourceMode: "streamed_text_delta" | "streamed_thinking_delta" =
			assistantEvent.type === "text_delta" ? "streamed_text_delta" : "streamed_thinking_delta";
		const origins = associated.map(({ state, rules }) => {
			const predecessor = stream.provisionalClaimsByRuleName.get(rules[0].name)!;
			const provisionalClaim = predecessor.provisionalClaim;
			const core: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrOriginAssociationCoreV1 = {
				originTaskToolCallId: state.key.toolCallId,
				originTaskSourceToolCallOrdinal: state.sourceToolCallOrdinal,
				originKeySha256: state.key.keySha256,
				provisionalClaim,
				associatedRuleNames: rules.map(rule => rule.name) as [string, ...string[]],
			};
			return {
				state,
				rules,
				association: {
					core,
					associationSha256: transientTtsrTupleSha256Ref([
						"omp-transient-task-foreground-settlement-v1",
						"ttsr-origin-association-core",
						1,
						core.originTaskToolCallId,
						core.originTaskSourceToolCallOrdinal,
						core.originKeySha256,
						core.provisionalClaim,
						core.associatedRuleNames,
					]),
				},
			};
		});
		const multiOriginCore: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrMultiOriginAssociationCoreV1 = {
			assistantStreamSha256: stream.assistantStreamSha256,
			sourceMode,
			contentIndex: assistantEvent.contentIndex,
			orderedTaskOrigins: origins.map(origin => origin.association) as [
				RuntimeContracts.ConfidentialTransientTaskForegroundTtsrOriginAssociationV1,
				...RuntimeContracts.ConfidentialTransientTaskForegroundTtsrOriginAssociationV1[],
			],
		};
		const multiOriginAssociation = {
			core: multiOriginCore,
			multiOriginAssociationSha256: transientTtsrTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"ttsr-multi-origin-core",
				1,
				multiOriginCore.assistantStreamSha256,
				multiOriginCore.sourceMode,
				multiOriginCore.contentIndex,
				multiOriginCore.orderedTaskOrigins,
			]),
		};
		const priorTail = stream.captureTail;
		const versions = origins.map((origin, currentOriginAssociationOrdinal) => {
			const revision = origin.state.nextCaptureRevision++;
			origin.state.registeredMessageUpdateCaptureCount += 1;
			const started = (async () => {
				await priorTail;
				const lexicalInput = this.#deltaLexicalInput(assistantEvent.delta);
				const inputBase = {
					schemaVersion: 1 as const,
					key: origin.state.key,
					parentSessionId: origin.state.key.parentSessionId,
					parentSessionGenerationSha256: origin.state.key.parentSessionGenerationSha256,
					preAssistantBranchGenerationSha256: origin.state.key.preAssistantBranchGenerationSha256,
					preAssistantAnchorEntryId: origin.state.key.preAssistantAnchorEntryId,
					toolCallId: origin.state.key.toolCallId,
					toolName: "task" as const,
					captureGeneration: origin.state.key.captureGeneration,
					assistantStreamSha256: origin.state.key.assistantStreamSha256,
					captureRevision: revision,
					assistantMessageTimestamp: message.timestamp ?? null,
					contentIndex: assistantEvent.contentIndex,
					currentOriginAssociationOrdinal,
					lexicalInput,
				};
				let input: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrMessageUpdateCaptureInputV1;
				if (multiOriginAssociation.core.sourceMode === "streamed_text_delta") {
					const context = {
						source: "text" as const,
						streamKey: "text" as const,
						contextSha256: transientTtsrTupleSha256Ref([
							"omp-transient-task-foreground-settlement-v1",
							"ttsr-match-context-core",
							1,
							"text",
							"text",
						]),
					};
					const inputWithoutDigest: Extract<
						TransientTaskTtsrMessageUpdateCaptureInputWithoutDigestV1,
						{ readonly sourceMode: "streamed_text_delta" }
					> = {
						...inputBase,
						sourceMode: "streamed_text_delta",
						matchContext: context,
						multiOriginAssociation: {
							...multiOriginAssociation,
							core: { ...multiOriginAssociation.core, sourceMode: "streamed_text_delta" },
						},
						astInput: this.#notRunAstInput("text_source"),
					};
					input = {
						...inputWithoutDigest,
						captureInputSha256: this.#messageUpdateCaptureInputDigest(inputWithoutDigest),
					};
				} else {
					const context = {
						source: "thinking" as const,
						streamKey: "thinking" as const,
						contextSha256: transientTtsrTupleSha256Ref([
							"omp-transient-task-foreground-settlement-v1",
							"ttsr-match-context-core",
							1,
							"thinking",
							"thinking",
						]),
					};
					const inputWithoutDigest: Extract<
						TransientTaskTtsrMessageUpdateCaptureInputWithoutDigestV1,
						{ readonly sourceMode: "streamed_thinking_delta" }
					> = {
						...inputBase,
						sourceMode: "streamed_thinking_delta",
						matchContext: context,
						multiOriginAssociation: {
							...multiOriginAssociation,
							core: { ...multiOriginAssociation.core, sourceMode: "streamed_thinking_delta" },
						},
						astInput: this.#notRunAstInput("thinking_source"),
					};
					input = {
						...inputWithoutDigest,
						captureInputSha256: this.#messageUpdateCaptureInputDigest(inputWithoutDigest),
					};
				}
				return this.#persistTransientTaskCapture(origin.state, input, origin.rules, matchContext);
			})();
			origin.state.startedCaptures.set(revision, started);
			return started;
		});
		stream.captureTail = Promise.all(versions).then(
			() => undefined,
			() => undefined,
		);
		return Promise.all(versions).then(() => interrupted);
	}

	async #evaluateTransientTaskToolInput(
		state: TransientTaskTtsrCaptureStateV1,
		message: AssistantMessage,
		assistantEvent: { readonly delta: string; readonly contentIndex: number },
		toolCall: ToolCall,
		revision: number,
	): Promise<TransientTaskTtsrCaptureEvaluationV1> {
		const matchContext = this.#getToolMatchContext(toolCall, assistantEvent.contentIndex);
		const orderedFilePaths = matchContext.filePaths ?? [];
		const context = {
			source: "tool" as const,
			toolName: "task" as const,
			streamKey: matchContext.streamKey ?? `toolcall:${toolCall.id}`,
			orderedFilePaths,
			contextSha256: transientTtsrTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"ttsr-match-context-core",
				1,
				"tool",
				"task",
				matchContext.streamKey ?? `toolcall:${toolCall.id}`,
				orderedFilePaths,
			]),
		};
		const entries = this.#resolveMatcherEntries(toolCall);
		const snapshot = entries ? undefined : this.#resolveMatcherDigest(toolCall);
		let lexicalInput: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrLexicalMatchInputV1;
		let lexicalMatches: Rule[];
		if (entries) {
			const frozenEntries = entries.map((entry, ordinal) =>
				this.#matcherEntry(ordinal, entry.path, entry.digest),
			) as [
				RuntimeContracts.ConfidentialTransientTaskForegroundTtsrMatcherEntryV1,
				...RuntimeContracts.ConfidentialTransientTaskForegroundTtsrMatcherEntryV1[],
			];
			lexicalInput = {
				mode: "entries",
				entries: frozenEntries,
				inputSha256: transientTtsrTupleSha256Ref([
					"omp-transient-task-foreground-settlement-v1",
					"ttsr-lexical-input-core",
					1,
					"entries",
					null,
					null,
					null,
					null,
					frozenEntries,
				]),
			};
			lexicalMatches = this.#dedupeRules(
				frozenEntries.flatMap(
					entry =>
						this.#manager?.checkSnapshot(
							entry.snapshot.snapshotUtf8,
							this.#perFileContext(matchContext, entry.path),
						) ?? [],
				),
			);
		} else if (snapshot !== undefined) {
			const frozenSnapshot = this.#matcherSnapshot(snapshot);
			lexicalInput = {
				mode: "snapshot",
				snapshot: frozenSnapshot,
				inputSha256: transientTtsrTupleSha256Ref([
					"omp-transient-task-foreground-settlement-v1",
					"ttsr-lexical-input-core",
					1,
					"snapshot",
					null,
					null,
					null,
					frozenSnapshot,
					[],
				]),
			};
			lexicalMatches = this.#dedupeRules(this.#manager?.checkSnapshot(snapshot, matchContext) ?? []);
		} else {
			lexicalInput = this.#deltaLexicalInput(assistantEvent.delta);
			lexicalMatches = this.#dedupeRules(this.#manager?.checkDelta(assistantEvent.delta, matchContext) ?? []);
		}
		const lexicalInterrupt = lexicalMatches.length > 0 && this.#shouldInterrupt(lexicalMatches, matchContext);
		let astInput: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrAstMatchInputV1;
		let astMatches: Rule[] = [];
		if (lexicalInterrupt) {
			astInput = this.#notRunAstInput("lexical_interrupt_short_circuit");
		} else if (!this.#manager?.hasAstRules()) {
			astInput = this.#notRunAstInput("no_ast_rules");
		} else if (lexicalInput.mode === "delta") {
			astInput = this.#notRunAstInput("no_snapshot");
		} else if (lexicalInput.mode === "snapshot") {
			const language = this.#matcherLanguage(orderedFilePaths[0]);
			if (!language) {
				astInput = this.#notRunAstInput("no_language");
			} else {
				astInput = {
					mode: "snapshot",
					language,
					snapshot: lexicalInput.snapshot,
					inputSha256: transientTtsrTupleSha256Ref([
						"omp-transient-task-foreground-settlement-v1",
						"ttsr-ast-input-core",
						1,
						"snapshot",
						null,
						language,
						lexicalInput.snapshot,
						[],
					]),
				};
				astMatches = this.#dedupeRules(
					await this.#manager.checkAstSnapshot(lexicalInput.snapshot.snapshotUtf8, matchContext),
				);
			}
		} else {
			const astEntries = lexicalInput.entries.flatMap(entry => {
				const language = this.#matcherLanguage(entry.path);
				return language ? [{ ordinal: entry.ordinal, language, matcherEntry: entry }] : [];
			});
			if (astEntries.length === 0) {
				astInput = this.#notRunAstInput("no_language");
			} else {
				const [firstAstEntry, ...remainingAstEntries] = astEntries;
				if (!firstAstEntry) throw new Error("Transient Task AST entry list unexpectedly became empty");
				const nonemptyAstEntries = [firstAstEntry, ...remainingAstEntries] as const;
				astInput = {
					mode: "entries",
					entries: nonemptyAstEntries,
					inputSha256: transientTtsrTupleSha256Ref([
						"omp-transient-task-foreground-settlement-v1",
						"ttsr-ast-input-core",
						1,
						"entries",
						null,
						null,
						null,
						nonemptyAstEntries,
					]),
				};
				for (const entry of astEntries) {
					astMatches.push(
						...(await this.#manager.checkAstSnapshot(
							entry.matcherEntry.snapshot.snapshotUtf8,
							this.#perFileContext(matchContext, entry.matcherEntry.path),
						)),
					);
				}
				astMatches = this.#dedupeRules(astMatches);
			}
		}
		const matches = this.#dedupeRules([...lexicalMatches, ...astMatches]);
		const interrupted = this.#handleTransientTaskMatches(matches, matchContext, message.timestamp);
		const inputWithoutDigest = {
			schemaVersion: 1 as const,
			key: state.key,
			parentSessionId: state.key.parentSessionId,
			parentSessionGenerationSha256: state.key.parentSessionGenerationSha256,
			preAssistantBranchGenerationSha256: state.key.preAssistantBranchGenerationSha256,
			preAssistantAnchorEntryId: state.key.preAssistantAnchorEntryId,
			toolCallId: state.key.toolCallId,
			toolName: "task" as const,
			captureGeneration: state.key.captureGeneration,
			assistantStreamSha256: state.key.assistantStreamSha256,
			captureRevision: revision,
			sourceMode: "streamed_toolcall_delta" as const,
			assistantMessageTimestamp: message.timestamp ?? null,
			contentIndex: assistantEvent.contentIndex,
			reconstructedToolCallId: toolCall.id,
			reconstructedToolName: "task" as const,
			matchContext: context,
			lexicalInput,
			astInput,
		};
		return {
			input: {
				...inputWithoutDigest,
				captureInputSha256: this.#messageUpdateCaptureInputDigest(inputWithoutDigest),
			},
			matches,
			matchContext,
			interrupted,
		};
	}

	#matcherSnapshot(snapshotUtf8: string): RuntimeContracts.ConfidentialTransientTaskForegroundTtsrMatcherSnapshotV1 {
		return {
			snapshotUtf8,
			snapshotUtf8Sha256: transientTtsrSha256Ref(snapshotUtf8),
			snapshotUtf8ByteLength: Buffer.byteLength(snapshotUtf8, "utf8"),
		};
	}

	#matcherEntry(
		ordinal: number,
		pathValue: string,
		snapshotUtf8: string,
	): RuntimeContracts.ConfidentialTransientTaskForegroundTtsrMatcherEntryV1 {
		const pathSha256 = transientTtsrSha256Ref(pathValue);
		const snapshot = this.#matcherSnapshot(snapshotUtf8);
		return {
			ordinal,
			path: pathValue,
			pathSha256,
			snapshot,
			entrySha256: transientTtsrTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"ttsr-matcher-entry-core",
				1,
				ordinal,
				pathValue,
				pathSha256,
				snapshot,
			]),
		};
	}

	#deltaLexicalInput(
		deltaUtf8: string,
	): Extract<RuntimeContracts.ConfidentialTransientTaskForegroundTtsrLexicalMatchInputV1, { readonly mode: "delta" }> {
		const deltaUtf8Sha256 = transientTtsrSha256Ref(deltaUtf8);
		const deltaUtf8ByteLength = Buffer.byteLength(deltaUtf8, "utf8");
		return {
			mode: "delta",
			deltaUtf8,
			deltaUtf8Sha256,
			deltaUtf8ByteLength,
			inputSha256: transientTtsrTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"ttsr-lexical-input-core",
				1,
				"delta",
				deltaUtf8,
				deltaUtf8Sha256,
				deltaUtf8ByteLength,
				null,
				[],
			]),
		};
	}

	#notRunAstInput<
		Reason extends Extract<
			RuntimeContracts.ConfidentialTransientTaskForegroundTtsrAstMatchInputV1,
			{ readonly mode: "not_run" }
		>["reason"],
	>(
		reason: Reason,
	): Extract<RuntimeContracts.ConfidentialTransientTaskForegroundTtsrAstMatchInputV1, { readonly mode: "not_run" }> & {
		readonly reason: Reason;
	} {
		return {
			mode: "not_run",
			reason,
			inputSha256: transientTtsrTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"ttsr-ast-input-core",
				1,
				"not_run",
				reason,
				null,
				null,
				[],
			]),
		};
	}

	#matcherLanguage(filePath: string | undefined): string | undefined {
		if (!filePath) return undefined;
		const extension = path.extname(filePath);
		return extension.length > 1 ? extension.slice(1).toLowerCase() : undefined;
	}

	#messageUpdateCaptureInputDigest(input: TransientTaskTtsrMessageUpdateCaptureInputWithoutDigestV1): Sha256Ref {
		const prefix = [
			"omp-transient-task-foreground-settlement-v1",
			"pending-ttsr-message-update-input-core",
			1,
			input.key,
			input.parentSessionId,
			input.parentSessionGenerationSha256,
			input.preAssistantBranchGenerationSha256,
			input.preAssistantAnchorEntryId,
			input.toolCallId,
			"task",
			input.captureGeneration,
			input.assistantStreamSha256,
			input.captureRevision,
			input.sourceMode,
			input.assistantMessageTimestamp,
			input.contentIndex,
		] as const;
		if (input.sourceMode === "streamed_text_delta" || input.sourceMode === "streamed_thinking_delta") {
			return transientTtsrTupleSha256Ref([
				...prefix,
				input.multiOriginAssociation,
				input.currentOriginAssociationOrdinal,
				input.matchContext,
				null,
				null,
				input.lexicalInput,
				input.astInput,
			]);
		}
		return transientTtsrTupleSha256Ref([
			...prefix,
			null,
			null,
			input.matchContext,
			input.reconstructedToolCallId,
			input.reconstructedToolName,
			input.lexicalInput,
			input.astInput,
		]);
	}

	#dedupeRules(rules: readonly Rule[]): Rule[] {
		const names = new Set<string>();
		return rules.filter(rule => {
			if (names.has(rule.name)) return false;
			names.add(rule.name);
			return true;
		});
	}

	#handleTransientTaskMatches(
		matches: readonly Rule[],
		matchContext: TtsrMatchContext,
		targetTimestamp: number | undefined,
	): boolean {
		if (matches.length === 0) return false;
		const exact = [...matches];
		if (this.#shouldInterrupt(exact, matchContext)) return this.#handleMatches(exact, matchContext, targetTimestamp);
		this.#host.emitSessionEvent({ type: "ttsr_triggered", rules: exact }).catch(() => {});
		return false;
	}

	#pendingOverlayBlockReason(
		status: string,
	): Extract<
		RuntimeContracts.TransientTaskForegroundBeforeToolCallPendingOverlayGateResultV1,
		{ readonly status: "blocked" }
	>["reason"] {
		switch (status) {
			case "session_generation_replaced":
			case "pre_assistant_branch_replaced":
			case "pre_assistant_anchor_replaced":
			case "version_conflict":
			case "finalization_conflict":
			case "invalid":
				return status;
			default:
				return "finalization_conflict";
		}
	}

	async #persistTransientTaskCapture(
		state: TransientTaskTtsrCaptureStateV1,
		input: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayCaptureInputV1,
		matches: readonly Rule[],
		_matchContext: TtsrMatchContext | undefined,
	): Promise<RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayVersionV1> {
		const runtime = this.#transientTaskRuntime;
		if (!runtime) throw new Error("Transient Task overlay store is unavailable");
		const rules = this.#dedupeRules(matches);
		const newRules = rules.filter(rule => !state.stream.provisionalClaimsByRuleName.has(rule.name));
		for (const rule of newRules) {
			if (!state.accumulatedRules.some(current => current.name === rule.name)) state.accumulatedRules.push(rule);
		}
		const overlaySnapshot = this.#transientTaskOverlaySnapshot(state);
		let outcome: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrCaptureOutcomeV1;
		let provisionalClaim: RuntimeContracts.ConfidentialTransientTaskForegroundTtsrProvisionalClaimV1 | undefined;
		if (rules.length === 0) {
			const reason = input.captureRevision === 0 ? ("baseline" as const) : ("matcher_returned_empty" as const);
			const outcomeCore = [
				"omp-transient-task-foreground-settlement-v1",
				"pending-ttsr-capture-outcome-core",
				1,
				"no_match",
				input.captureInputSha256,
				reason,
				[],
				null,
				null,
				null,
				overlaySnapshot,
			] as const;
			outcome = {
				status: "no_match",
				captureInputSha256: input.captureInputSha256,
				reason,
				overlaySnapshot,
				outcomeSha256: transientTtsrTupleSha256Ref(outcomeCore),
			};
		} else if (newRules.length > 0) {
			const orderedRuleNames = newRules.map(rule => rule.name) as [string, ...string[]];
			const claimCore = [
				"omp-transient-task-foreground-settlement-v1",
				"ttsr-provisional-claim-core",
				1,
				state.key.assistantStreamSha256,
				state.key.keySha256,
				input.captureRevision,
				input.captureInputSha256,
				orderedRuleNames,
			] as const;
			provisionalClaim = {
				assistantStreamSha256: state.key.assistantStreamSha256,
				originKeySha256: state.key.keySha256,
				originCaptureRevision: input.captureRevision,
				originCaptureInputSha256: input.captureInputSha256,
				orderedRuleNames,
				provisionalClaimSha256: transientTtsrTupleSha256Ref(claimCore),
			};
			const outcomeCore = [
				"omp-transient-task-foreground-settlement-v1",
				"pending-ttsr-capture-outcome-core",
				1,
				"matched",
				input.captureInputSha256,
				null,
				orderedRuleNames,
				provisionalClaim,
				null,
				null,
				overlaySnapshot,
			] as const;
			outcome = {
				status: "matched",
				captureInputSha256: input.captureInputSha256,
				matchedRuleNames: orderedRuleNames,
				provisionalClaim,
				overlaySnapshot,
				outcomeSha256: transientTtsrTupleSha256Ref(outcomeCore),
			};
		} else {
			const predecessor = state.stream.provisionalClaimsByRuleName.get(rules[0].name);
			if (!predecessor) throw new Error("Transient Task provisional predecessor is unavailable");
			const suppressedRuleNames = rules.map(rule => rule.name) as [string, ...string[]];
			const provisionalPredecessor = {
				originKeySha256: predecessor.state.key.keySha256,
				originCaptureRevision: predecessor.captureRevision,
				originCaptureInputSha256: predecessor.captureInputSha256,
				originVersionSha256: predecessor.versionSha256,
				provisionalClaimSha256: predecessor.claimSha256,
			};
			const outcomeCore = [
				"omp-transient-task-foreground-settlement-v1",
				"pending-ttsr-capture-outcome-core",
				1,
				"suppressed_same_stream",
				input.captureInputSha256,
				null,
				suppressedRuleNames,
				null,
				state.key.assistantStreamSha256,
				provisionalPredecessor,
				overlaySnapshot,
			] as const;
			outcome = {
				status: "suppressed_same_stream",
				captureInputSha256: input.captureInputSha256,
				assistantStreamSha256: state.key.assistantStreamSha256,
				suppressedRuleNames,
				provisionalPredecessor,
				overlaySnapshot,
				outcomeSha256: transientTtsrTupleSha256Ref(outcomeCore),
			};
		}
		const captureRequest: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayCaptureRequestV1 = {
			schemaVersion: 1,
			key: state.key,
			captureRevision: input.captureRevision,
			input,
			captureInputSha256: input.captureInputSha256,
			requestSha256: transientTtsrTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"pending-ttsr-capture-core",
				1,
				state.key,
				input.captureRevision,
				input,
				input.captureInputSha256,
			]),
		};
		const priorVersionSha256 = state.preparedVersions.at(-1)?.versionSha256 ?? null;
		const capturedAt = transientTtsrNow();
		const versionWithoutDigest = {
			schemaVersion: 1 as const,
			key: state.key,
			version: input.captureRevision,
			priorVersionSha256,
			captureRequest,
			outcome,
			capturedAt,
		};
		const version: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayVersionV1 = {
			...versionWithoutDigest,
			versionSha256: transientTtsrTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"pending-ttsr-version-core",
				1,
				state.key,
				input.captureRevision,
				priorVersionSha256,
				captureRequest,
				outcome,
				capturedAt,
			]),
		};
		let recorded: RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayVersionV1;
		if (state.preparedVersions.length === 0) {
			const recordCore = {
				schemaVersion: 1 as const,
				state: "started" as const,
				indexKey: state.indexKey,
				captureKey: state.key,
				durableVersions: [version] as [
					RuntimeContracts.ConfidentialTransientTaskForegroundPendingTtsrOverlayVersionV1,
				],
				executeEntryObservationReceipt: null,
				finalizedSnapshot: null,
				preDispatchBinding: null,
				anchoredBinding: null,
			};
			const startedRecord = {
				core: recordCore,
				recordSha256: canonicalTransientTaskSourceObservationDigestV1("pending_capture_record", recordCore),
			};
			const result = await runtime.overlayStore.prepareFirstVersionAndIndexStartedCapture({
				version,
				startedRecord,
				requestSha256: startedRecord.recordSha256,
			});
			if (result.status !== "recorded" && result.status !== "already_recorded")
				throw new Error(`Transient Task first overlay version was rejected: ${result.status}`);
			state.startedRecordSha256 = result.startedRecord.recordSha256;
			recorded = result.version;
		} else {
			const result = await runtime.overlayStore.prepareSubsequentVersion(version);
			if (result.status !== "recorded" && result.status !== "already_recorded")
				throw new Error(`Transient Task overlay version was rejected: ${result.status}`);
			recorded = result.version;
		}
		state.preparedVersions.push(recorded);
		if (provisionalClaim) {
			for (const ruleName of provisionalClaim.orderedRuleNames) {
				state.stream.provisionalClaimsByRuleName.set(ruleName, {
					state,
					captureRevision: input.captureRevision,
					captureInputSha256: input.captureInputSha256,
					versionSha256: recorded.versionSha256,
					claimSha256: provisionalClaim.provisionalClaimSha256,
					provisionalClaim,
				});
			}
		}
		return recorded;
	}

	#transientTaskOverlaySnapshot(
		state: TransientTaskTtsrCaptureStateV1,
	): RuntimeContracts.ConfidentialTransientTaskForegroundTtsrOverlaySnapshotV1 {
		const orderedRuleInputs = state.accumulatedRules.map((rule, ordinal) => ({
			ordinal,
			name: rule.name,
			displayPath: this.#displayRulePath(rule.path),
			content: rule.content,
			ruleInputSha256: transientTtsrTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"ttsr-rule-input-core",
				1,
				ordinal,
				rule.name,
				this.#displayRulePath(rule.path),
				rule.content,
			]),
		}));
		const renderedReminderUtf8 = state.accumulatedRules
			.map(rule =>
				prompt.render(ttsrToolReminderTemplate, {
					name: rule.name,
					path: this.#displayRulePath(rule.path),
					content: rule.content,
				}),
			)
			.join("\n\n");
		const mode = orderedRuleInputs.length === 0 ? ("none" as const) : ("prepend_ttsr_reminder" as const);
		const ttsrToolReminderTemplateSha256 = transientTtsrSha256Ref(ttsrToolReminderTemplate);
		const renderedReminderUtf8Sha256 = transientTtsrSha256Ref(renderedReminderUtf8);
		const renderedReminderUtf8ByteLength = Buffer.byteLength(renderedReminderUtf8, "utf8");
		const injectedRuleNames = state.accumulatedRules.map(rule => rule.name);
		const ruleTuples = orderedRuleInputs.map(rule => [
			"omp-transient-task-foreground-settlement-v1",
			"ttsr-rule-input-core",
			1,
			rule.ordinal,
			rule.name,
			rule.displayPath,
			rule.content,
		]);
		return {
			schemaVersion: 1,
			toolCallId: state.key.toolCallId,
			mode,
			orderedRuleInputs,
			ttsrToolReminderTemplateSha256,
			renderedReminderUtf8,
			renderedReminderUtf8Sha256,
			renderedReminderUtf8ByteLength,
			injectedRuleNames,
			snapshotSha256: transientTtsrTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"ttsr-overlay-core",
				1,
				state.key.toolCallId,
				mode,
				ruleTuples,
				ttsrToolReminderTemplateSha256,
				renderedReminderUtf8,
				renderedReminderUtf8Sha256,
				renderedReminderUtf8ByteLength,
				injectedRuleNames,
			]),
		};
	}

	#overlaySnapshotForRules(
		toolCallId: string,
		rules: readonly Rule[],
	): RuntimeContracts.ConfidentialTransientTaskForegroundTtsrOverlaySnapshotV1 {
		const orderedRuleInputs = rules.map((rule, ordinal) =>
			buildTransientTaskHubWaitMessageCanonicalRecordV1("foreground-ttsr-overlay-rule-input", {
				ordinal,
				name: rule.name,
				displayPath: this.#displayRulePath(rule.path),
				content: rule.content,
			}),
		);
		const renderedReminderUtf8 = rules
			.map(rule =>
				prompt.render(ttsrToolReminderTemplate, {
					name: rule.name,
					path: this.#displayRulePath(rule.path),
					content: rule.content,
				}),
			)
			.join("\n\n");
		const core = {
			schemaVersion: 1 as const,
			toolCallId,
			mode: orderedRuleInputs.length === 0 ? ("none" as const) : ("prepend_ttsr_reminder" as const),
			orderedRuleInputs,
			ttsrToolReminderTemplateSha256: transientTtsrSha256Ref(ttsrToolReminderTemplate),
			renderedReminderUtf8,
			renderedReminderUtf8Sha256: transientTtsrSha256Ref(renderedReminderUtf8),
			renderedReminderUtf8ByteLength: Buffer.byteLength(renderedReminderUtf8, "utf8"),
			injectedRuleNames: rules.map(rule => rule.name),
		};
		return buildTransientTaskHubWaitMessageCanonicalRecordV1("foreground-ttsr-overlay-snapshot", core);
	}

	#extractFilePathsFromArgs(args: unknown): string[] | undefined {
		if (!isRecord(args)) return undefined;
		const rawPaths: string[] = [];
		for (const key in args) {
			const value = args[key];
			const normalizedKey = key.toLowerCase();
			if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
				rawPaths.push(value);
				continue;
			}
			if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
				for (const candidate of value) if (typeof candidate === "string") rawPaths.push(candidate);
			}
		}
		const normalizedPaths = rawPaths.flatMap(filePath => this.#normalizePathCandidates(filePath));
		return normalizedPaths.length === 0 ? undefined : Array.from(new Set(normalizedPaths));
	}

	#normalizePathCandidates(rawPath: string): string[] {
		const trimmed = rawPath.trim();
		if (trimmed.length === 0) return [];
		const normalizedInput = trimmed.replaceAll("\\", "/");
		const candidates = new Set<string>([normalizedInput]);
		if (normalizedInput.startsWith("./")) candidates.add(normalizedInput.slice(2));
		const cwd = this.#host.sessionManager.getCwd();
		const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
		candidates.add(absolutePath.replaceAll("\\", "/"));
		const relative = path.relative(cwd, absolutePath).replaceAll("\\", "/");
		if (relative && relative !== "." && !relative.startsWith("../") && relative !== "..") candidates.add(relative);
		return Array.from(candidates);
	}
}
