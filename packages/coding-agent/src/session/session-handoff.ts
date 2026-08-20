/** Handoff document generation and fresh-session transition orchestration. */

import * as path from "node:path";
import {
	type Agent,
	type AgentMessage,
	resolveTelemetry,
	type StreamFn,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import { generateHandoffFromContext, renderHandoffPrompt } from "@oh-my-pi/pi-agent-core/compaction";
import type { Message, Model, ServiceTier, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { ExtensionRunner, SessionBeforeSwitchResult } from "../extensibility/extensions";
import { isFinalStatus } from "../goals/runtime";
import type { GoalModeState } from "../goals/state";
import { copyLocalArtifacts, resolveLocalUrlToPath } from "../internal-urls";
import { obfuscateProviderContext } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { HandoffResult, SessionHandoffOptions } from "./agent-session-types";
import type { SessionContext } from "./session-context";
import type { SessionLifecycleTransaction } from "./session-lifecycle-transaction";
import type { SessionManager } from "./session-manager";

function createHandoffContext(document: string): string {
	return `<handoff-context>\n${document}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`;
}

function createHandoffFileName(date = new Date()): string {
	const fileTimestamp = date.toISOString().replace(/[:.]/g, "-");
	return `handoff-${fileTimestamp}.md`;
}

function throwIfHandoffAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	const reason = signal.reason;
	if (reason instanceof DOMException && reason.name === "AbortError") {
		throw new Error("Handoff cancelled");
	}
	if (reason instanceof Error) throw reason;
	if (typeof reason === "string" && reason.length > 0) throw new Error(reason);
	throw new Error("Handoff aborted by session");
}

const EMPTY_AUTO_HANDOFF = Symbol("empty auto-handoff");

export interface PendingSemanticDeliveryHandoffQueues {
	steering: AgentMessage[];
	followUp: AgentMessage[];
	companions: Array<{ owner: AgentMessage; messages: AgentMessage[] }>;
}

export interface PendingSemanticDeliveryHandoff {
	migrate(): Promise<PendingSemanticDeliveryHandoffQueues>;
	release(): Promise<void>;
}

/** Capabilities borrowed from the owning AgentSession. */
export interface SessionHandoffHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	extensionRunner: ExtensionRunner | undefined;
	sideStreamFn: StreamFn;
	beginLifecycleTransaction(
		semanticDeliveryAcceptance: Promise<void> | undefined,
		signal: AbortSignal,
		quiesceAgent: boolean,
	): Promise<SessionLifecycleTransaction>;
	obfuscator: SecretObfuscator | undefined;
	model(): Model | undefined;
	thinkingLevel(): ThinkingLevel | undefined;
	sessionId(): string;
	sessionFile(): string | undefined;
	goalModeState(): GoalModeState | undefined;
	baseSystemPrompt(): string[];
	assertVibeSessionTransitionAllowed(action: string): void;
	setSkipPostTurnMaintenance(timestamp: number | undefined): void;
	obfuscateTextForProvider(text: string | undefined): string | undefined;
	deobfuscateFromProvider(text: string): string;
	convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]>;
	prepareSimpleStreamOptions(options: SimpleStreamOptions, provider?: string): SimpleStreamOptions;
	effectiveServiceTier(model: Model | undefined): ServiceTier | undefined;
	flushPendingBash(): Promise<void>;
	closeAllProviderSessions(reason: string): void;
	clearCheckpointRuntimeState(): void;
	clearFreshProviderSessionId(): void;
	syncAgentSessionId(notifyChange?: boolean, refreshAdvisors?: boolean): void;
	rekeyMemoryForCurrentSessionId(): void;
	resetMemoryContextForNewTranscript(): Promise<void>;
	clearPendingNextTurnMessages(): void;
	preparePendingSemanticDeliveryHandoff(
		steering: AgentMessage[],
		followUp: AgentMessage[],
		companions: Array<{ owner: AgentMessage; messages: AgentMessage[] }>,
	): Promise<PendingSemanticDeliveryHandoff>;
	restoreExplicitPromptMessages(messages: AgentMessage[]): void;
	resetTodoCycle(): void;
	buildDisplaySessionContext(): SessionContext;
	replaceMessagesFromSessionContext(context: SessionContext): void;
	drainAndDetachAdvisorRecorders(): Promise<void>;
	syncTodoPhasesFromBranch(): void;
}

/** Generates handoff documents and applies them through a fresh-session transaction. */
export class SessionHandoff {
	#handoffAbortController: AbortController | undefined;
	readonly #host: SessionHandoffHost;

	constructor(host: SessionHandoffHost) {
		this.#host = host;
	}

	/** Cancel an in-progress transactional handoff, preserving a harness-provided reason. */
	abortHandoff(reason?: Error): void {
		this.#handoffAbortController?.abort(reason);
	}

	/** Check if a transactional handoff is in progress. */
	get isGeneratingHandoff(): boolean {
		return this.#handoffAbortController !== undefined;
	}

	/** Generate a handoff document without mutating session or lifecycle state. */
	async generateDocument(
		customInstructions?: string,
		options?: SessionHandoffOptions,
	): Promise<HandoffResult | undefined> {
		const signal = options?.signal ?? new AbortController().signal;
		try {
			return await this.#generateDocument(customInstructions, options, signal);
		} catch (error) {
			throwIfHandoffAborted(signal);
			throw error;
		}
	}

	/** Generate or apply a prepared handoff document through the fresh-session transaction. */
	async handoffToNewSession(
		customInstructions?: string,
		options?: SessionHandoffOptions,
		semanticDeliveryAcceptance?: Promise<void>,
		prepared?: HandoffResult,
	): Promise<HandoffResult | undefined> {
		this.#host.assertVibeSessionTransitionAllowed("handoff to a new session");
		const entries = this.#host.sessionManager.getBranch();
		const messageCount = entries.filter(entry => entry.type === "message").length;
		if (messageCount < 2) throw new Error("Nothing to hand off (no messages yet)");

		this.#host.setSkipPostTurnMaintenance(undefined);
		const handoffAbortController = new AbortController();
		this.#handoffAbortController = handoffAbortController;
		const handoffSignal = handoffAbortController.signal;
		const sourceSignal = options?.signal;
		const onSourceAbort = () => {
			if (!handoffSignal.aborted) handoffAbortController.abort(sourceSignal?.reason);
		};
		if (sourceSignal) {
			sourceSignal.addEventListener("abort", onSourceAbort, { once: true });
			if (sourceSignal.aborted) onSourceAbort();
		}

		let lifecycle: SessionLifecycleTransaction | undefined;
		let pendingSemanticDeliveryHandoff: PendingSemanticDeliveryHandoff | undefined;
		try {
			throwIfHandoffAborted(handoffSignal);
			const previousSessionFile = this.#host.sessionFile();
			if (this.#host.extensionRunner?.hasHandlers("session_before_switch")) {
				const result = (await this.#host.extensionRunner.emit({
					type: "session_before_switch",
					reason: "handoff",
				})) as SessionBeforeSwitchResult | undefined;
				if (result?.cancel) {
					options?.onSwitchCancelled?.();
					return undefined;
				}
			}

			// External handoffs settle the active prompt before capture. Auto-handoffs
			// already run inside prompt maintenance and must not wait on themselves.
			lifecycle = await this.#host.beginLifecycleTransaction(
				semanticDeliveryAcceptance,
				handoffSignal,
				options?.autoTriggered !== true && semanticDeliveryAcceptance === undefined,
			);

			const handoffResult = prepared ?? (await this.#generateDocument(customInstructions, options, handoffSignal));
			if (!handoffResult) throw EMPTY_AUTO_HANDOFF;
			throwIfHandoffAborted(handoffSignal);

			if (this.#host.extensionRunner) {
				lifecycle.markPublicationStarted();
				await this.#host.extensionRunner.emitBeforeSessionMutation({ type: "session_switch" });
			}
			await lifecycle.captureRetained({ capturePersistedSessionFile: true });
			await this.#host.flushPendingBash();
			await this.#host.sessionManager.flush();
			await this.#host.drainAndDetachAdvisorRecorders();
			await lifecycle.recaptureRetained({ capturePersistedSessionFile: true });
			await lifecycle.acquireOwnership();

			if (this.#host.extensionRunner) {
				await this.#host.extensionRunner.emit({ type: "session_switch", reason: "handoff", previousSessionFile });
			}

			const localProtocolOptions = {
				getArtifactsDir: () => this.#host.sessionManager.getArtifactsDir(),
				getSessionId: () => this.#host.sessionManager.getSessionId(),
			};
			const previousLocalRoot = resolveLocalUrlToPath("local://", localProtocolOptions);
			const preservedSteering = this.#host.agent.peekSteeringQueue().slice();
			const preservedFollowUp = this.#host.agent.peekFollowUpQueue().slice();
			const preservedCompanions = this.#host.agent.captureQueuedMessageCompanions();
			const goalModeState = this.#host.goalModeState();
			const preservedGoal =
				goalModeState && !isFinalStatus(goalModeState.goal) ? structuredClone(goalModeState.goal) : undefined;
			pendingSemanticDeliveryHandoff = await this.#host.preparePendingSemanticDeliveryHandoff(
				preservedSteering,
				preservedFollowUp,
				preservedCompanions,
			);
			await this.#host.sessionManager.newSession(
				previousSessionFile ? { parentSession: previousSessionFile } : undefined,
			);
			if (preservedGoal) {
				this.#host.sessionManager.appendModeChange(preservedGoal.status === "paused" ? "goal_paused" : "goal", {
					goal: preservedGoal,
				});
			}
			lifecycle.markTarget();
			this.#host.clearFreshProviderSessionId();
			this.#host.syncAgentSessionId(false, false);
			this.#host.rekeyMemoryForCurrentSessionId();
			await this.#host.resetMemoryContextForNewTranscript();

			try {
				const newLocalRoot = resolveLocalUrlToPath("local://", localProtocolOptions);
				await copyLocalArtifacts(previousLocalRoot, newLocalRoot);
			} catch (error) {
				logger.warn("Failed to copy local artifacts into handoff session", {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			const handoffContent = createHandoffContext(handoffResult.document);
			this.#host.sessionManager.appendCustomMessageEntry("handoff", handoffContent, true, undefined, "agent");
			await this.#host.sessionManager.ensureOnDisk();

			const sessionContext = this.#host.buildDisplaySessionContext();
			this.#host.agent.reset();
			this.#host.clearCheckpointRuntimeState();
			this.#host.clearPendingNextTurnMessages();
			const migratedQueues = await pendingSemanticDeliveryHandoff.migrate();
			this.#host.agent.replaceQueues(migratedQueues.steering, migratedQueues.followUp);
			this.#host.agent.restoreQueuedMessageCompanions(migratedQueues.companions, messages =>
				this.#host.restoreExplicitPromptMessages(messages),
			);
			this.#host.replaceMessagesFromSessionContext(sessionContext);
			this.#host.resetTodoCycle();
			this.#host.syncTodoPhasesFromBranch();

			const commitOptions = {
				finalizeProviderSessions: () => this.#host.closeAllProviderSessions("handoff"),
			};
			if (this.#host.extensionRunner) {
				const transaction = lifecycle;
				await this.#host.extensionRunner.emitWithHostCompletion({ type: "session_ready" }, () =>
					transaction.prepareCommit(commitOptions),
				);
				await lifecycle.activateCommitAfterHostPublication();
			} else {
				await lifecycle.commit(commitOptions);
			}
			return handoffResult;
		} catch (error) {
			// Clear the generation gate before rollback publication so retained host
			// activation cannot be rejected as another in-progress handoff.
			if (this.#handoffAbortController === handoffAbortController) this.#handoffAbortController = undefined;
			if (lifecycle) {
				await lifecycle.rollback({
					cause: error,
					message: "Handoff failed and rollback was incomplete",
					cleanupReplacement: true,
				});
			}
			if (error === EMPTY_AUTO_HANDOFF) return undefined;
			throwIfHandoffAborted(handoffSignal);
			throw error;
		} finally {
			sourceSignal?.removeEventListener("abort", onSourceAbort);
			if (this.#handoffAbortController === handoffAbortController) this.#handoffAbortController = undefined;
			try {
				await pendingSemanticDeliveryHandoff?.release();
			} catch (error) {
				logger.warn("Failed to release pending semantic handoff state", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	async #generateDocument(
		customInstructions: string | undefined,
		options: SessionHandoffOptions | undefined,
		signal: AbortSignal,
	): Promise<HandoffResult | undefined> {
		throwIfHandoffAborted(signal);
		const model = this.#host.model();
		if (!model) throw new Error("No model selected for handoff");
		const apiKey = await this.#host.modelRegistry.getApiKey(model, this.#host.sessionId());
		if (!apiKey) throw new Error(`No API key for ${model.provider}`);

		// Build through the live-turn request pipeline so the side request reuses
		// the same provider prompt cache without sharing append-only session state.
		const cacheSessionId = this.#host.sessionId();
		const handoffPromptCacheKey = this.#host.agent.promptCacheKey ?? this.#host.agent.sessionId;
		const handoffPromptText = renderHandoffPrompt(this.#host.obfuscateTextForProvider(customInstructions));
		const handoffSnapshot: AgentMessage[] = [
			...this.#host.agent.state.messages,
			{
				role: "user",
				content: [{ type: "text", text: handoffPromptText }],
				attribution: "agent",
				timestamp: Date.now(),
			},
		];
		const handoffLlmMessages = await this.#host.convertMessagesToLlm(handoffSnapshot, signal);
		const handoffContext = await this.#host.agent.buildSideRequestContext(
			handoffLlmMessages,
			this.#host.baseSystemPrompt(),
			handoffSnapshot,
		);
		const handoffStreamOptions = this.#host.prepareSimpleStreamOptions(
			{
				apiKey: this.#host.modelRegistry.resolver(model, cacheSessionId),
				sessionId: `${cacheSessionId}:side:${Snowflake.next()}`,
				promptCacheKey: handoffPromptCacheKey,
				preferWebsockets: false,
				serviceTier: this.#host.effectiveServiceTier(model),
				hideThinkingSummary: this.#host.agent.hideThinkingSummary,
				initiatorOverride: "agent",
				signal,
			},
			model.provider,
		);
		const rawHandoffText = await generateHandoffFromContext(
			obfuscateProviderContext(this.#host.obfuscator, handoffContext),
			model,
			{
				streamOptions: handoffStreamOptions,
				completeImpl: async (requestModel, requestContext, requestOptions) => {
					const stream = await this.#host.sideStreamFn(requestModel, requestContext, requestOptions);
					return stream.result();
				},
				telemetry: resolveTelemetry(this.#host.agent.telemetry, this.#host.sessionId()),
				thinkingLevel: this.#host.thinkingLevel(),
			},
		);
		const handoffText = this.#host.deobfuscateFromProvider(rawHandoffText);

		throwIfHandoffAborted(signal);
		if (!handoffText || handoffText.trim().length === 0) {
			logger.warn("Handoff generation produced no content", {
				sessionId: this.#host.sessionId(),
				autoTriggered: options?.autoTriggered ?? false,
			});
			if (options?.autoTriggered) return undefined;
			throw new Error("Handoff generation produced no content");
		}

		let savedPath: string | undefined;
		if (options?.autoTriggered && this.#host.settings.get("compaction.handoffSaveToDisk")) {
			const artifactsDir = this.#host.sessionManager.getArtifactsDir();
			if (artifactsDir) {
				const handoffFilePath = path.join(artifactsDir, createHandoffFileName());
				try {
					await Bun.write(handoffFilePath, `${handoffText}\n`);
					savedPath = handoffFilePath;
				} catch (error) {
					logger.warn("Failed to save handoff document to disk", {
						path: handoffFilePath,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			} else {
				logger.debug("Skipping handoff document save because session is not persisted");
			}
		}
		return { document: handoffText, savedPath };
	}
}
