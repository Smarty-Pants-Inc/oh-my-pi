import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Usage } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { type Component, matchesKey, Spacer, Text, TruncatedText } from "@oh-my-pi/pi-tui";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { AdvisorMessageDetails } from "../../advisor";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "../../collab/protocol";
import { formatKeyHints } from "../../config/keybindings";
import { settings } from "../../config/settings";
import { getEditClipboard } from "../../edit/edit-clipboard";
import { getFileSnapshotStore } from "../../edit/file-snapshot-store";
import type { QueuedPrompt, QueuedPromptDelivery } from "../../extensibility/extensions";
import { createAdvisorMessageCard } from "../../modes/components/advisor-message";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { createBackgroundTanDispatchBlock } from "../../modes/components/background-tan-message";
import { BashExecutionComponent } from "../../modes/components/bash-execution";
import { detectCacheInvalidation } from "../../modes/components/cache-invalidation-marker";
import { CollabPromptMessageComponent } from "../../modes/components/collab-prompt-message";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	createHandoffSummaryMessageComponent,
} from "../../modes/components/compaction-summary-message";
import { CustomMessageComponent } from "../../modes/components/custom-message";
import { DynamicBorder } from "../../modes/components/dynamic-border";
import { EvalExecutionComponent } from "../../modes/components/eval-execution";
import {
	type LateDiagnosticsFile,
	LateDiagnosticsMessageComponent,
} from "../../modes/components/late-diagnostics-message";
import {
	groupedReadUsageCallIds,
	ReadToolGroupComponent,
	readArgsCollapseIntoGroup,
} from "../../modes/components/read-tool-group";
import { SkillMessageComponent } from "../../modes/components/skill-message";
import { StrippedToolCallsPlaceholder } from "../../modes/components/stripped-tool-calls-placeholder";
import { ToolActivityContainer } from "../../modes/components/tool-activity";
import { ToolExecutionComponent, type ToolExecutionHandle } from "../../modes/components/tool-execution";
import { TranscriptBlock, TranscriptContainer } from "../../modes/components/transcript-container";
import { createUsageRowBlock } from "../../modes/components/usage-row";
import { UserMessageComponent } from "../../modes/components/user-message";
import { shiftImageMarkers } from "../../modes/composer-attachments";
import { decodeStreamedToolArgs, streamingStringKeysForTool } from "../../modes/controllers/tool-args-reveal";
import { materializeImageReferenceLinksSync } from "../../modes/image-references";
import { theme } from "../../modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext, RenderSessionContextOptions } from "../../modes/types";
import { LAUNCH_COMPLETION_MESSAGE_TYPE } from "../../session/launch-completion";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	type CustomMessage,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "../../session/messages";
import { localSubmissionSignature, queuedPromptSignature } from "../../session/queued-messages";
import type { SessionContext, StrippedToolCallsMarker } from "../../session/session-context";
import { replaceTabs } from "../../tools/render-utils";
import { buildSkillCommandPrompt, invokeSkillCommandFromText, isKnownSkillCommand } from "../skill-command";
import { createAssistantMessageComponent } from "./interactive-context-helpers";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	buildAsyncResultBlock,
	buildFileMentionBlock,
	buildIrcMessageCard,
	buildLaunchCompletionBlock,
	normalizeToolArgs,
	resolveAssistantErrorPresentation,
	splitAssistantMessageToolTimeline,
} from "./transcript-render-helpers";

type TextBlock = { type: "text"; text: string };
interface RenderInitialMessagesOptions {
	preserveExistingChat?: boolean;
	clearTerminalHistory?: boolean;
}

const TRANSCRIPT_RENDER_CHUNK_MESSAGES = 32;
const TRANSCRIPT_RENDER_CHUNK_MS = 8;
/**
 * Upper bound on full-transcript replay restarts inside
 * {@link UiHelpers.renderInitialMessages}. Each restart discards the staged
 * tree and replays every message from scratch, so on a large resumed session
 * (issue #7811: ~6k entries) a single pass takes longer than the interval
 * between entries persisted by background sources — the restart condition
 * becomes permanently true and an unbounded loop livelocks at 100% CPU.
 * Entries that land after the final accepted pass are
 * durable in the session file and reach the display on the next rebuild.
 */
const TRANSCRIPT_REPLAY_MAX_ATTEMPTS = 5;

function waitForImmediate(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

const QUEUED_PROMPT_DELIVERIES: readonly QueuedPromptDelivery[] = ["interrupt", "steer", "afterCurrent"];
const QUEUED_PROMPT_TIMING_LABELS: Record<QueuedPromptDelivery, string> = {
	interrupt: "NOW",
	steer: "NEXT",
	afterCurrent: "AFTER",
};
type QueuedPromptEditMode = "manage" | "confirmRemove" | "editText" | "savingEdit" | "savingRemove";
type QueuedPromptComposerDraft = {
	text: string;
	images: ImageContent[];
	imageLinks: (string | undefined)[];
};
type QueuedPromptEditorEntry = {
	prompt: QueuedPrompt;
	local?: CompactionQueuedMessage;
};
type QueuedPromptEditState = {
	session: InteractiveModeContext["viewSession"];
	selectedId: string;
	selectedIndex: number;
	persistedDelivery: QueuedPromptDelivery;
	draftDelivery: QueuedPromptDelivery;
	draftDeliveries: Map<string, QueuedPromptDelivery>;
	mode: QueuedPromptEditMode;
	priorDraft?: QueuedPromptComposerDraft;
	queuedImages?: ImageContent[];
	originalSignature?: string;
	originalCustomType?: string;
	unsubscribeQueue: () => void;
};
function queuedPromptSummary(text: string, imageCount = 0): string {
	const lines = stripVTControlCharacters(replaceTabs(text))
		.split(/\r?\n/)
		.map(line => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "));
	const firstLine = lines[0]?.trim() || (imageCount > 0 ? "[Image]" : "(empty prompt)");
	const multiline = lines.length > 1 ? ` ↵ +${lines.length - 1} line${lines.length === 2 ? "" : "s"}` : "";
	const images = imageCount > 0 ? ` · ${imageCount} image${imageCount === 1 ? "" : "s"}` : "";
	return `${firstLine}${multiline}${images}`;
}

function queuedPromptBadge(delivery: QueuedPromptDelivery): string {
	const label = `[${QUEUED_PROMPT_TIMING_LABELS[delivery]}]`;
	if (delivery === "interrupt") return theme.bold(theme.fg("warning", label));
	if (delivery === "steer") return theme.bold(theme.fg("mdLink", label));
	return theme.bold(theme.fg("success", label));
}

function queuedPromptRow(
	prompt: Pick<QueuedPrompt, "text" | "delivery" | "imageCount">,
	index: number,
	options?: { selected?: boolean; delivery?: QueuedPromptDelivery; interrupting?: boolean },
): string {
	const selected = options?.selected === true;
	const delivery = options?.delivery ?? prompt.delivery;
	const marker = selected ? theme.bold(theme.fg("accent", "›")) : " ";
	const number = selected ? theme.bold(theme.fg("accent", `${index + 1}.`)) : theme.fg("dim", `${index + 1}.`);
	const summary = queuedPromptSummary(prompt.text, prompt.imageCount);
	const body = selected ? theme.bold(theme.fg("accent", summary)) : theme.fg("dim", summary);
	const state = options?.interrupting ? theme.fg("warning", " (interrupting)") : "";
	return `  ${marker} ${number} ${queuedPromptBadge(delivery)} ${body}${state}`;
}

type AddMessageOptions = {
	imageLinks?: readonly (string | undefined)[];
	reuseSettledComponent?: boolean;
};

function imageLinksForMessage(
	message: Extract<AgentMessage, { role: "developer" | "user" }>,
	putBlobSync: InteractiveModeContext["sessionManager"]["putBlobSync"],
): (string | undefined)[] | undefined {
	if (typeof message.content === "string") return undefined;
	const images = message.content.filter(
		(content): content is ImageContent =>
			content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string",
	);
	return materializeImageReferenceLinksSync(images, putBlobSync);
}

class StatusText extends Text {
	#rebuild: (() => string) | undefined;

	constructor(message: string, rebuild?: () => string) {
		super(message, 1, 0);
		this.#rebuild = rebuild;
	}

	setStatus(message: string, rebuild?: () => string): void {
		this.#rebuild = rebuild;
		this.setText(message);
	}

	override invalidate(): void {
		if (this.#rebuild) this.setText(this.#rebuild());
		super.invalidate();
	}
}

export class UiHelpers {
	constructor(private ctx: InteractiveModeContext) {
		this.ctx.ui?.addInputListener?.(data => this.#handleQueuedPromptEditInput(data));
	}
	#queuedPromptEdit: QueuedPromptEditState | undefined;
	#interruptingQueuedPromptIds = new Set<string>();
	#pendingQueuedPromptDeliveries = new Map<string, { delivery: QueuedPromptDelivery }>();

	/** Extract text content from a user message */
	getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((content): content is TextBlock => content.type === "text");
		return textBlocks.map(block => block.text).join("");
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	showStatus(message: string, options?: { dim?: boolean }, rebuild?: () => string): void {
		const children = this.ctx.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;
		const useDim = options?.dim ?? true;
		// Resolve the dim color lazily so a later theme change re-shapes the line
		// instead of leaving the palette that was active when it was presented.
		const styleFn = useDim ? (t: string) => theme.fg("dim", t) : undefined;

		if (last && secondLast && last === this.ctx.lastStatusText && secondLast === this.ctx.lastStatusSpacer) {
			this.ctx.lastStatusText.setStyleFn(styleFn);
			if (this.ctx.lastStatusText instanceof StatusText) {
				this.ctx.lastStatusText.setStatus(message, rebuild);
			} else {
				this.ctx.lastStatusText.setText(message);
			}
			this.ctx.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new StatusText(message, rebuild).setStyleFn(styleFn);
		this.ctx.present([spacer, text]);
		this.ctx.lastStatusSpacer = spacer;
		this.ctx.lastStatusText = text;
	}

	addMessageToChat(message: AgentMessage, options?: AddMessageOptions): Component[] {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ctx.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
				});
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "pythonExecution": {
				const component = new EvalExecutionComponent(message.code, this.ctx.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
				});
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "hookMessage":
			case "custom": {
				if (message.display) {
					if (message.customType === "async-result") {
						const component = buildAsyncResultBlock(message);
						this.ctx.chatContainer.addChild(component);
						break;
					}
					if (message.customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE) {
						const details = (
							message as CustomMessage<{
								files?: LateDiagnosticsFile[];
							}>
						).details;
						const component = new LateDiagnosticsMessageComponent(details?.files ?? []);
						component.setExpanded(this.ctx.toolOutputExpanded);
						this.ctx.chatContainer.addChild(component);
						break;
					}
					if (message.customType === LAUNCH_COMPLETION_MESSAGE_TYPE) {
						this.ctx.chatContainer.addChild(buildLaunchCompletionBlock(message));
						break;
					}
					if (message.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
						const component = new CollabPromptMessageComponent(message as CustomMessage<CollabPromptDetails>);
						this.ctx.chatContainer.addChild(component);
						break;
					}
					if (message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
						const component = new SkillMessageComponent(message as CustomMessage<SkillPromptDetails>);
						component.setExpanded(this.ctx.toolOutputExpanded);
						this.ctx.chatContainer.addChild(component);
						break;
					}
					if (
						message.customType === "irc:incoming" ||
						message.customType === "irc:autoreply" ||
						message.customType === "irc:relay"
					) {
						const card = buildIrcMessageCard(message, () => this.ctx.toolOutputExpanded);
						this.ctx.chatContainer.addChild(card);
						return [card];
					}
					if (message.customType === "advisor") {
						const details = (message as CustomMessage<AdvisorMessageDetails>).details;
						this.ctx.chatContainer.addChild(
							createAdvisorMessageCard(details, () => this.ctx.toolOutputExpanded, theme),
						);
						break;
					}
					if (message.customType === BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE) {
						this.ctx.chatContainer.addChild(createBackgroundTanDispatchBlock(message as CustomMessage<unknown>));
						break;
					}
					const handoffComponent = createHandoffSummaryMessageComponent(
						message as CustomMessage<unknown>,
						this.ctx.toolOutputExpanded,
					);
					if (handoffComponent) {
						this.ctx.chatContainer.addChild(handoffComponent);
						break;
					}
					const renderer = this.ctx.viewSession.extensionRunner?.getMessageRenderer(message.customType);
					// Both HookMessage and CustomMessage have the same structure, cast for compatibility
					const component = new CustomMessageComponent(message as CustomMessage<unknown>, renderer);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(message);
				component.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(message);
				component.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "fileMention": {
				// Render compact file mention display
				const block = buildFileMentionBlock(message.files, 0);
				if (block.children.length > 0) this.ctx.chatContainer.addChild(block);
				break;
			}
			case "user":
			case "developer": {
				const textContent = this.ctx.getUserMessageText(message);
				if (textContent) {
					const isSynthetic = message.role === "developer" ? true : (message.synthetic ?? false);
					const cached = options?.reuseSettledComponent
						? this.ctx.transcriptMessageComponents.get(message)
						: undefined;
					let userComponent: UserMessageComponent;
					if (cached instanceof UserMessageComponent) {
						userComponent = cached;
					} else {
						const imageLinks =
							options?.imageLinks ??
							imageLinksForMessage(
								message,
								this.ctx.viewSession.sessionManager.putBlobSync.bind(this.ctx.viewSession.sessionManager),
							);
						userComponent = new UserMessageComponent(textContent, isSynthetic, imageLinks);
						this.ctx.transcriptMessageComponents.set(message, userComponent);
					}
					this.ctx.chatContainer.addChild(userComponent);
				}
				break;
			}
			case "assistant": {
				const cached = options?.reuseSettledComponent
					? this.ctx.transcriptMessageComponents.get(message)
					: undefined;
				const assistantComponent =
					cached instanceof AssistantMessageComponent
						? cached
						: createAssistantMessageComponent(this.ctx, splitAssistantMessageToolTimeline(message).beforeTools);
				if (cached !== assistantComponent) {
					this.ctx.transcriptMessageComponents.set(message, assistantComponent);
				}
				this.ctx.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				message satisfies never;
			}
		}
		return [];
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	renderSessionContext(sessionContext: SessionContext, options: RenderSessionContextOptions = {}): void {
		const steps = this.#renderSessionContextSteps(sessionContext, options);
		while (!steps.next().done) {}
	}

	/** Build a session context in bounded chunks so terminal input runs between event-loop turns. */
	async renderSessionContextIncrementally(
		sessionContext: SessionContext,
		options: RenderSessionContextOptions,
		renderChunk?: () => void,
	): Promise<void> {
		const steps = this.#renderSessionContextSteps(sessionContext, options);
		let messagesSinceYield = 0;
		let chunkStartedAt = performance.now();
		while (!steps.next().done) {
			messagesSinceYield++;
			if (
				messagesSinceYield < TRANSCRIPT_RENDER_CHUNK_MESSAGES &&
				performance.now() - chunkStartedAt < TRANSCRIPT_RENDER_CHUNK_MS
			) {
				continue;
			}
			renderChunk?.();
			await waitForImmediate();
			messagesSinceYield = 0;
			chunkStartedAt = performance.now();
		}
	}

	*#renderSessionContextSteps(
		sessionContext: SessionContext,
		options: RenderSessionContextOptions = {},
	): Generator<void, void, void> {
		// Preserved: message_start handler owns this lifecycle (see #783)
		this.ctx.pendingTools.clear();
		// Reseed the cache-invalidation baseline: this rebuild re-derives every
		// turn's marker from usage, and the last turn becomes the live baseline.
		this.ctx.lastAssistantUsage = undefined;

		if (options.updateFooter) {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}

		let readGroup: ReadToolGroupComponent | null = null;
		const reattachedLiveToolComponents = new Set<Component>();
		const readToolCallArgs = new Map<string, Record<string, unknown>>();
		const readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
		// Defer per-turn metrics until the turn's tool results have materialized.
		// Read-only invisible turns attach the metrics to their shared compact
		// group; every other turn keeps the standalone row below its tool blocks.
		let pendingUsage: Usage | undefined;
		let pendingUsageDuration: number | undefined;
		let pendingUsageTtft: number | undefined;
		let pendingUsageTimestamp: number | undefined;
		let pendingReadUsageCallIds: string[] | undefined;
		const flushPendingUsage = () => {
			if (!pendingUsage) return;
			const usageAttached =
				pendingReadUsageCallIds !== undefined &&
				(readGroup?.attachUsage(
					pendingReadUsageCallIds,
					pendingUsage,
					pendingUsageDuration,
					pendingUsageTtft,
					pendingUsageTimestamp,
				) ??
					false);
			if (!usageAttached) {
				readGroup?.seal();
				readGroup = null;
				this.ctx.chatContainer.addChild(
					createUsageRowBlock(pendingUsage, pendingUsageDuration, pendingUsageTtft, pendingUsageTimestamp),
				);
			}
			pendingUsage = undefined;
			pendingUsageDuration = undefined;
			pendingUsageTtft = undefined;
			pendingUsageTimestamp = undefined;
			pendingReadUsageCallIds = undefined;
		};
		// Rebuild-time mirror of the event controller's displaceable-poll
		// bookkeeping: a `hub` wait that found every watched job still running is
		// superseded by the next `hub` call, so a rebuilt transcript collapses a
		// repeated-poll run to its final snapshot instead of replaying the spam.
		let waitingPoll: ToolExecutionComponent | null = null;
		const resolveWaitingPoll = (nextToolName?: string) => {
			const previous = waitingPoll;
			if (!previous) return;
			waitingPoll = null;
			if (
				nextToolName === "hub" &&
				previous.isDisplaceableBlock() &&
				this.ctx.chatContainer.canRemoveBlock(previous)
			) {
				this.ctx.chatContainer.removeChild(previous);
			}
			// Sealing finalizes the block and stops the waiting-poll spinner that
			// updateResult armed.
			previous.seal();
		};
		let todoSnapshot: ToolExecutionComponent | null = null;
		const resolveTodoSnapshot = (nextToolName?: string) => {
			const previous = todoSnapshot;
			if (!previous) return;
			if (!previous.isDisplaceableBlock()) {
				todoSnapshot = null;
				return;
			}
			if (previous.canBeDisplacedBy(nextToolName)) {
				todoSnapshot = null;
				if (this.ctx.chatContainer.canRemoveBlock(previous)) {
					this.ctx.chatContainer.removeChild(previous);
				}
				previous.seal();
				return;
			}
			if (nextToolName !== undefined) return;
			todoSnapshot = null;
			previous.seal();
		};
		let preservedLiveResponseAnchorCandidate = options.preservedLiveResponseAnchorCandidate;
		const preservedLivePostToolComponents = [...(options.preservedLivePostToolComponents ?? [])];
		const messages = sessionContext.messages;
		const count = messages.length;
		for (let i = 0; i < count; i++) {
			// Yield BEFORE each message (except the first) rather than after: the
			// per-message body has several early `continue` paths (preserved live
			// results, image-only and grouped `read` results), and a trailing yield
			// is skipped by all of them. A large parallel-read batch is entirely
			// such results, so an after-body yield never trips the chunk counter and
			// the whole batch replays in one event-loop turn. Yielding at the top of
			// the next iteration is reached no matter how the prior message exited.
			if (i > 0) yield;
			const message = messages[i]!;
			if (message.role !== "toolResult") flushPendingUsage();
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				const timeline = splitAssistantMessageToolTimeline(message);
				const terminalReplySegment = timeline.terminalReplySegment;
				const candidate = preservedLiveResponseAnchorCandidate;
				const preserveLeadingCandidate = candidate?.matchesReplayMessage(message) ?? false;
				if (preserveLeadingCandidate && candidate) {
					this.ctx.chatContainer.addChild(candidate);
					preservedLiveResponseAnchorCandidate = undefined;
				} else {
					this.ctx.addMessageToChat(message, { reuseSettledComponent: options.reuseSettledComponents });
				}
				const lastChild = this.ctx.chatContainer.children[this.ctx.chatContainer.children.length - 1];
				const assistantComponent = lastChild instanceof AssistantMessageComponent ? lastChild : undefined;
				if (!preserveLeadingCandidate) {
					assistantComponent?.setResponseAnchor(terminalReplySegment === timeline.beforeTools);
				}
				if (assistantComponent) {
					const usage = message.usage;
					const explained = sessionContext.cacheMissExplainedAt?.[i] ?? false;
					if (this.ctx.settings.get("display.cacheMissMarker") && !explained) {
						const invalidation = detectCacheInvalidation(this.ctx.lastAssistantUsage, usage);
						if (invalidation) assistantComponent.setCacheInvalidation(invalidation);
					}
					if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
						this.ctx.lastAssistantUsage = usage;
					}
				}
				const hasVisibleAssistantContent = assistantHasVisibleContent(message);
				if (hasVisibleAssistantContent) {
					// Rebuild reconstructs immutable history; seal (not finalize) because
					// a pending entry otherwise keeps the group active indefinitely.
					readGroup?.seal();
					readGroup = null;
				}
				const errorPresentation = resolveAssistantErrorPresentation(message, this.ctx.viewSession.retryAttempt);
				const hasErrorStop = errorPresentation.kind === "full";
				const errorMessage = hasErrorStop ? errorPresentation.text : null;
				const appendAssistantSegment = (toolCallIndex: number, segment: AssistantMessage | undefined) => {
					const preservedIndex = preservedLivePostToolComponents.findIndex(
						preserved => preserved.toolCallIndex === toolCallIndex && preserved.matchesReplayMessage(message),
					);
					if (preservedIndex >= 0) {
						const preserved = preservedLivePostToolComponents.splice(preservedIndex, 1)[0]!;
						this.ctx.chatContainer.addChild(preserved.component);
						return;
					}
					if (!segment || !assistantHasVisibleContent(segment)) return;
					const component = createAssistantMessageComponent(this.ctx, segment);
					component.setResponseAnchor(segment === terminalReplySegment);
					this.ctx.chatContainer.addChild(component);
				};

				// Render tool call components
				for (const [toolCallIndex, content] of message.content.entries()) {
					if (content.type !== "toolCall") {
						continue;
					}
					const afterToolSegment = timeline.afterToolCalls.get(toolCallIndex);
					const preservedToolComponent = options.preservedLiveToolComponents?.get(content.id);
					if (preservedToolComponent) {
						resolveWaitingPoll(content.name);
						readGroup?.seal();
						readGroup = null;
						if (!reattachedLiveToolComponents.has(preservedToolComponent)) {
							this.ctx.chatContainer.addChild(preservedToolComponent);
							reattachedLiveToolComponents.add(preservedToolComponent);
						}
						appendAssistantSegment(toolCallIndex, afterToolSegment);
						continue;
					}
					resolveWaitingPoll(content.name);

					if (content.name === "read" && readArgsCollapseIntoGroup(content.arguments)) {
						if (hasErrorStop && errorMessage) {
							if (!readGroup) {
								readGroup = new ReadToolGroupComponent({
									showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
								});
								readGroup.setExpanded(this.ctx.toolOutputExpanded);
								this.ctx.chatContainer.addChild(readGroup);
							}
							readGroup.updateArgs(content.arguments, content.id);
							readGroup.updateResult(
								{ content: [{ type: "text", text: errorMessage }], isError: true },
								false,
								content.id,
							);
						} else if (afterToolSegment) {
							if (!readGroup) {
								readGroup = new ReadToolGroupComponent({
									showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
								});
								readGroup.setExpanded(this.ctx.toolOutputExpanded);
								this.ctx.chatContainer.addChild(readGroup);
							}
							readGroup.updateArgs(content.arguments, content.id);
							this.ctx.pendingTools.set(content.id, readGroup);
							if (assistantComponent) {
								readToolCallAssistantComponents.set(content.id, assistantComponent);
							}
						} else {
							const normalizedArgs = normalizeToolArgs(content.arguments);
							readToolCallArgs.set(content.id, normalizedArgs);
							if (assistantComponent) {
								readToolCallAssistantComponents.set(content.id, assistantComponent);
							}
						}
						appendAssistantSegment(toolCallIndex, afterToolSegment);
						continue;
					}

					readGroup?.seal();
					readGroup = null;
					const tool = this.ctx.viewSession.getToolByName(content.name);
					const partialJson = getStreamingPartialJson(content);
					// Mid-stream rebuild (theme change, settings, focus replay): decode
					// display args from the raw stream exactly like the live reveal path.
					// The provider-parsed `arguments` lag the stream by up to a throttled
					// parse window, so spreading them alone would freeze a long write/edit
					// preview at its last full parse.
					const rawInput = content.customWireName !== undefined;
					const renderArgs = partialJson
						? decodeStreamedToolArgs(partialJson, {
								rawInput,
								fullArgs: content.arguments,
								streamingStringKeys: streamingStringKeysForTool(content.name, rawInput),
							})
						: content.arguments;
					const component = new ToolExecutionComponent(
						content.name,
						renderArgs,
						{
							useBuiltInRenderer: this.ctx.viewSession.hasBuiltInTool(content.name),
							snapshots: getFileSnapshotStore(this.ctx.viewSession),
							clipboard: getEditClipboard(this.ctx.viewSession),
							showImages: settings.get("terminal.showImages"),
							editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
							editAllowFuzzy: settings.get("edit.fuzzyMatch"),
						},
						tool,
						this.ctx.ui,
						this.ctx.viewSession.sessionManager.getCwd(),
						content.id,
					);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.chatContainer.addChild(component);

					if (hasErrorStop && errorMessage) {
						component.updateResult(
							{ content: [{ type: "text", text: errorMessage }], isError: true },
							false,
							content.id,
						);
					} else {
						this.ctx.pendingTools.set(content.id, component);
					}
					appendAssistantSegment(toolCallIndex, afterToolSegment);
				}
				// Dangling toolCalls (no result on the resolved path — failed or
				// retried turns, results on sibling branches) were stripped by the
				// context build; surface a placeholder so the turn's activity is
				// visibly elided instead of silently vanishing (the "bare thinking
				// lines" transcript trap).
				const strippedToolCalls = (message as AgentMessage & StrippedToolCallsMarker).strippedToolCalls ?? 0;
				if (strippedToolCalls > 0) {
					this.ctx.chatContainer.addChild(
						new StrippedToolCallsPlaceholder(strippedToolCalls, !this.ctx.hideToolActivity),
					);
				}
				pendingUsage =
					this.ctx.settings.get("display.showTokenUsage") && assistantUsageIsBilled(message.usage)
						? message.usage
						: undefined;
				pendingUsageDuration = message.duration;
				pendingUsageTtft = message.ttft;
				pendingUsageTimestamp = message.timestamp;
				pendingReadUsageCallIds = pendingUsage ? groupedReadUsageCallIds(message) : undefined;
			} else if (message.role === "toolResult") {
				if (options.preservedLiveToolComponents?.has(message.toolCallId)) continue;
				const pendingReadComponent = this.ctx.pendingTools.get(message.toolCallId);
				const isReadGroupResult =
					message.toolName === "read" &&
					(!pendingReadComponent || pendingReadComponent instanceof ReadToolGroupComponent);
				if (isReadGroupResult) {
					const assistantComponent = readToolCallAssistantComponents.get(message.toolCallId);
					const images: ImageContent[] = message.content.filter(
						(content): content is ImageContent => content.type === "image",
					);
					if (images.length > 0 && assistantComponent) {
						assistantComponent.setToolResultImages(message.toolCallId, images);
						const hasText = message.content.some(c => c.type === "text");
						if (!hasText && settings.get("terminal.showImages")) {
							readToolCallArgs.delete(message.toolCallId);
							readToolCallAssistantComponents.delete(message.toolCallId);
							continue;
						}
					}
					let component = this.ctx.pendingTools.get(message.toolCallId);
					if (!component) {
						if (!readGroup) {
							readGroup = new ReadToolGroupComponent({
								showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
							});
							readGroup.setExpanded(this.ctx.toolOutputExpanded);
							this.ctx.chatContainer.addChild(readGroup);
						}
						const args = readToolCallArgs.get(message.toolCallId);
						if (args) {
							readGroup.updateArgs(args, message.toolCallId);
						}
						component = readGroup;
						this.ctx.pendingTools.set(message.toolCallId, readGroup);
					}
					component.updateResult(message, false, message.toolCallId);
					this.ctx.pendingTools.delete(message.toolCallId);
					readToolCallArgs.delete(message.toolCallId);
					readToolCallAssistantComponents.delete(message.toolCallId);
					continue;
				}

				// Match tool results to pending tool components
				const component = this.ctx.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message, false, message.toolCallId);
					this.ctx.pendingTools.delete(message.toolCallId);
					if (
						message.toolName === "hub" &&
						component instanceof ToolExecutionComponent &&
						component.isDisplaceableBlock()
					) {
						waitingPoll = component;
					} else if (
						message.toolName === "todo" &&
						component instanceof ToolExecutionComponent &&
						component.canBeDisplacedBy("todo")
					) {
						// A successful todo result supersedes the prior live snapshot. Failed
						// follow-ups return false from canBeDisplacedBy("todo"), so the
						// last-good panel stays on screen.
						resolveTodoSnapshot("todo");
						todoSnapshot = component;
					}
				}
			} else {
				readGroup?.seal();
				readGroup = null;
				// A user prompt closes the displacement window, same as the live path.
				if (message.role === "user") resolveWaitingPoll();
				if (message.role === "user") resolveTodoSnapshot();
				// All other messages use standard rendering
				this.ctx.addMessageToChat(message, { reuseSettledComponent: options.reuseSettledComponents });
			}
		}
		flushPendingUsage();

		// The trailing read run has no following break to close it; seal so the
		// rebuilt group can retire as history even with a never-persisted result.
		readGroup?.seal();
		// A trailing waiting poll is final history on rebuild; seal it and stop
		// its spinner timer.
		resolveWaitingPoll();
		// A trailing todo snapshot is live state, not history: when the rebuild
		// runs mid-turn (settings overlay close, focus attach during streaming),
		// hand it back to the controller so a follow-up `todo` update keeps
		// displacing instead of stacking. Idle rebuilds (resume / compaction)
		// fall through to the seal path so the snapshot retires as history.
		if (todoSnapshot && this.ctx.viewSession.isStreaming) {
			this.ctx.eventController?.inheritDisplaceableTodo(todoSnapshot);
			todoSnapshot = null;
		} else {
			resolveTodoSnapshot();
		}

		// Entries still in `pendingTools` are toolCalls whose result never landed
		// during the replay — with `keepDanglingToolCalls` these are exactly the
		// turn's in-flight calls (assistant turn persisted at message_end, tool
		// still executing). While the viewed session streams, keep them tracked so
		// the live event stream routes `tool_execution_update`/`_end` into the
		// rebuilt components instead of dropping the result; their args are final,
		// so mark them complete. Idle rebuilds have no result coming: seal so the
		// blocks can retire as history, then clear them so reconstructed historical
		// components never leak into active tracking.
		// (`rebuildChatFromMessages` builds its context WITHOUT dangling calls and
		// restores its own preserved live components afterwards — for that caller
		// the map is empty here either way.)
		if (this.ctx.viewSession.isStreaming) {
			for (const [toolCallId, component] of this.ctx.pendingTools) {
				component.setArgsComplete(toolCallId);
				if (this.ctx.eventController?.hasToolExecutionStarted(toolCallId)) {
					component.setExecutionStarted(toolCallId);
				}
			}
		} else {
			for (const component of this.ctx.pendingTools.values()) {
				component.seal();
			}
			this.ctx.pendingTools.clear();
		}
		this.ctx.ui.requestRender();
	}

	/**
	 * Fast-path history rewind (esc-esc branch, /tree rewind to an ancestor):
	 * drop the rendered components at/after `message` in place instead of the
	 * destructive clear-scrollback replay. Rows already committed to native
	 * scrollback are immutable, so the drop is expressible only while every
	 * affected block is still wholly inside the visible window; returns false
	 * when the caller must fall back to
	 * `renderInitialMessages({ clearTerminalHistory: true })`.
	 *
	 * Callers must have already rewound the session so that `message` and
	 * everything after it are no longer part of the view session's transcript.
	 */
	truncateTranscriptFromMessage(message: AgentMessage): boolean {
		if (!this.ctx.initialChatRendered || this.ctx.focusedAgentId || this.ctx.viewSession.isStreaming) return false;
		// In-flight blocks route future events into their components; a rewind
		// with any of them live takes the full-replay path instead.
		if (
			this.ctx.pendingTools.size > 0 ||
			this.ctx.pendingBashComponents.length > 0 ||
			this.ctx.pendingPythonComponents.length > 0
		) {
			return false;
		}
		const chat = this.ctx.chatContainer;
		const cut = this.ctx.transcriptMessageComponents.get(message);
		if (!cut) return false;
		const index = chat.children.indexOf(cut);
		if (index < 0) return false;
		// Every dropped block must still be uncommitted: removing rows already on
		// the tape is an interior deletion of committed history the render engine
		// cannot express (see TranscriptContainer.isBlockUncommitted).
		for (let i = index; i < chat.children.length; i++) {
			if (!chat.canRemoveBlock(chat.children[i]!)) return false;
		}
		// Ground truth for the surviving prefix. The cut message still present
		// means the session was not actually rewound past it — bail before
		// mutating anything.
		const context = this.ctx.viewSession.buildTranscriptSessionContext({
			collapseCompactedHistory: settings.get("display.collapseCompacted"),
		});
		for (const remaining of context.messages) {
			if (remaining === message) return false;
		}
		const dropped = chat.children.slice(index);
		for (let i = dropped.length - 1; i >= 0; i--) {
			const child = dropped[i]!;
			chat.removeChild(child);
			child.dispose?.();
		}
		// Prune the settled-component cache to the surviving messages — dropped
		// entries stay strongly reachable through the session tree and would
		// otherwise pin their components' layout caches (same rationale as
		// rebuildChatFromMessages).
		const retained = new WeakMap<AgentMessage, Component>();
		for (const remaining of context.messages) {
			const component = this.ctx.transcriptMessageComponents.get(remaining);
			if (component) retained.set(remaining, component);
		}
		this.ctx.transcriptMessageComponents = retained;
		// Reseed the cache-invalidation baseline from the surviving transcript
		// (mirrors the replay path's billed-usage rule).
		let baseline: Usage | undefined;
		for (let i = context.messages.length - 1; i >= 0; i--) {
			const candidate = context.messages[i]!;
			if (candidate.role !== "assistant") continue;
			const usage = candidate.usage;
			if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
				baseline = usage;
				break;
			}
		}
		this.ctx.lastAssistantUsage = baseline;
		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorBorderColor();
		this.ctx.ui.requestRender();
		return true;
	}

	async renderInitialMessages(options: RenderInitialMessagesOptions = {}): Promise<void> {
		// Build against a detached container. Incremental construction still yields
		// to terminal input, while paints keep using the complete visible transcript
		// until the replacement is ready to swap in.
		const visibleChatContainer = this.ctx.chatContainer;
		const stagedChatContainer = new TranscriptContainer();
		stagedChatContainer.setToolActivityVisible(!this.ctx.hideToolActivity);
		const preservedChatChildren = options.preserveExistingChat ? [...visibleChatContainer.children] : undefined;
		const previousTranscriptMessageComponents = this.ctx.transcriptMessageComponents;
		const previousPendingTools = this.ctx.pendingTools;
		const previousPendingBashComponents = this.ctx.pendingBashComponents;
		const previousPendingPythonComponents = this.ctx.pendingPythonComponents;
		const previousLastAssistantUsage = this.ctx.lastAssistantUsage;
		const chatWasAlreadyRendered = this.ctx.initialChatRendered;

		this.ctx.chatContainer = stagedChatContainer;
		this.ctx.transcriptMessageComponents = new WeakMap<AgentMessage, Component>();
		this.ctx.pendingTools = new Map<string, ToolExecutionHandle>();
		this.ctx.pendingMessagesContainer.disposeChildren();
		this.ctx.pendingBashComponents = [];
		this.ctx.pendingPythonComponents = [];

		// Live display collapses to the compacted transcript tail unless the
		// user opted into the full inline history; export/resume callers can
		// still request either mode. Mid-turn rebuilds
		// (focus attach/unfocus while a tool executes) keep dangling toolCalls so
		// the in-flight call re-renders as pending instead of vanishing;
		// renderSessionContext then keeps it in `pendingTools` for live routing.
		let context = this.ctx.viewSession.buildTranscriptSessionContext({
			collapseCompactedHistory: settings.get("display.collapseCompacted"),
			keepDanglingToolCalls: this.ctx.viewSession.isStreaming,
		});
		let replayEntryCount = this.ctx.viewSession.sessionManager.getEntries().length;
		const renderOptions = {
			updateFooter: true,
		};
		let committed = false;
		let replayAttempts = 0;
		this.ctx.initialChatRendered = false;
		try {
			while (true) {
				if (this.ctx.viewSession.isStreaming) {
					// Live events mutate the same component maps; keep their replay atomic so
					// a delta cannot land halfway through rebuilding its pending tool block.
					this.ctx.renderSessionContext(context, renderOptions);
				} else {
					await this.ctx.renderSessionContextIncrementally(context, renderOptions);
				}
				if (this.ctx.viewSession.sessionManager.getEntries().length === replayEntryCount) {
					break;
				}
				replayAttempts++;
				if (replayAttempts >= TRANSCRIPT_REPLAY_MAX_ATTEMPTS) {
					// A source keeps persisting entries faster than a full replay pass
					// completes. Accept the transcript just replayed instead of
					// restarting forever (see TRANSCRIPT_REPLAY_MAX_ATTEMPTS).
					logger.warn("renderInitialMessages: transcript replay did not converge; accepting current replay", {
						attempts: replayAttempts,
						replayEntryCount,
						currentEntryCount: this.ctx.viewSession.sessionManager.getEntries().length,
					});
					break;
				}
				// An extension persisted a display message while the transcript replay
				// yielded. The display callback stayed gated by initialChatRendered;
				// discard the stale partial tree and replay the current session once
				// more instead of letting a reentrant synchronous rebuild interleave.
				stagedChatContainer.disposeChildren();
				this.ctx.transcriptMessageComponents = new WeakMap<AgentMessage, Component>();
				this.ctx.pendingTools.clear();
				this.ctx.pendingBashComponents = [];
				this.ctx.pendingPythonComponents = [];
				context = this.ctx.viewSession.buildTranscriptSessionContext({
					collapseCompactedHistory: settings.get("display.collapseCompacted"),
					keepDanglingToolCalls: this.ctx.viewSession.isStreaming,
				});
				replayEntryCount = this.ctx.viewSession.sessionManager.getEntries().length;
			}

			const replayedChatChildren = [...stagedChatContainer.children];
			stagedChatContainer.clear();
			this.ctx.chatContainer = visibleChatContainer;
			if (preservedChatChildren) {
				visibleChatContainer.clear();
			} else {
				visibleChatContainer.disposeChildren();
			}
			for (const child of replayedChatChildren) {
				visibleChatContainer.addChild(child);
			}
			if (preservedChatChildren) {
				for (const child of preservedChatChildren) {
					visibleChatContainer.addChild(child);
				}
			}
			committed = true;

			// Show compaction info if session was compacted.
			const allEntries = this.ctx.viewSession.sessionManager.getEntries();
			let compactionCount = 0;
			for (const entry of allEntries) {
				if (entry.type === "compaction") {
					compactionCount++;
				}
			}
			if (compactionCount > 0) {
				const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
				this.ctx.showStatus(`Session compacted ${times}`);
			}
			if (options.clearTerminalHistory) {
				this.ctx.ui.requestRender(true, { clearScrollback: true });
			} else {
				this.ctx.ui.requestRender();
			}
		} finally {
			if (!committed) {
				this.ctx.chatContainer = visibleChatContainer;
				this.ctx.transcriptMessageComponents = previousTranscriptMessageComponents;
				this.ctx.pendingTools = previousPendingTools;
				this.ctx.pendingBashComponents = previousPendingBashComponents;
				this.ctx.pendingPythonComponents = previousPendingPythonComponents;
				this.ctx.lastAssistantUsage = previousLastAssistantUsage;
				stagedChatContainer.disposeChildren();
			}
			this.ctx.initialChatRendered = committed ? true : chatWasAlreadyRendered;
		}
	}

	clearEditor(): void {
		this.ctx.editor.clearDraft();
		this.ctx.ui.requestRender();
	}

	showError(errorMessage: string): void {
		const text = new Text(`Error: ${errorMessage}`, 1, 0).setStyleFn(t => theme.fg("error", t));
		this.ctx.present([new Spacer(1), text]);
	}

	showWarning(warningMessage: string, options?: { hideWithToolActivity?: boolean }): void {
		const text = new Text(`Warning: ${warningMessage}`, 1, 0).setStyleFn(t => theme.fg("warning", t));
		const content = [new Spacer(1), text];
		this.ctx.present(options?.hideWithToolActivity ? new ToolActivityContainer(content) : content);
	}

	showNewVersionNotification(newVersion: string): void {
		const block = new TranscriptBlock();
		block.addChild(new DynamicBorder(text => theme.fg("warning", text)));
		const title = "Update Available";
		const prefix = `New version ${newVersion} is available. Run: `;
		const command = "omp update";
		block.addChild(
			new Text(`${title}\n${prefix}${command}`, 1, 0).setStyleFn(
				() =>
					`${theme.bold(theme.fg("warning", title))}\n${theme.fg("muted", prefix)}${theme.fg("accent", command)}`,
			),
		);
		block.addChild(new DynamicBorder(text => theme.fg("warning", text)));
		this.ctx.present(block);
	}
	editQueuedPrompts(): void {
		const session = this.ctx.viewSession;
		const entries = this.#queuedPromptEntries(session);
		if (entries.length === 0) {
			this.ctx.showStatus("No user prompts are queued.");
			return;
		}
		this.#stopQueuedPromptEditing(false);
		const selectedIndex = entries.length - 1;
		const selected = entries[selectedIndex]!.prompt;
		const state: QueuedPromptEditState = {
			session,
			selectedId: selected.id,
			selectedIndex,
			draftDelivery: selected.delivery,
			persistedDelivery: selected.delivery,
			draftDeliveries: new Map(),
			mode: "manage",
			unsubscribeQueue: () => {},
		};
		this.#queuedPromptEdit = state;
		state.unsubscribeQueue = session.onQueuedPromptsChanged(() => this.#refreshQueuedPromptEditor(state));
		this.updatePendingMessagesDisplay();
	}

	#stopQueuedPromptEditing(render = true): void {
		const state = this.#queuedPromptEdit;
		if (!state) return;
		this.#queuedPromptEdit = undefined;
		state.unsubscribeQueue();
		if (render) this.updatePendingMessagesDisplay();
	}

	stopQueuedPromptEditing(render = true): void {
		this.#stopQueuedPromptEditing(render);
	}

	#queuedPromptEntries(session: InteractiveModeContext["viewSession"]): QueuedPromptEditorEntry[] {
		const entries: QueuedPromptEditorEntry[] = session.getQueuedPrompts().map(prompt => {
			const pending = this.#pendingQueuedPromptDeliveries.get(prompt.id);
			return { prompt: pending ? { ...prompt, delivery: pending.delivery } : prompt };
		});
		if (session === this.ctx.session) {
			entries.push(
				...this.ctx.compactionQueuedMessages.map(local => ({
					local,
					prompt: {
						id: local.id,
						text: local.text,
						delivery: local.mode === "steer" ? ("steer" as const) : ("afterCurrent" as const),
						...(local.images?.length ? { imageCount: local.images.length } : {}),
					},
				})),
			);
		}
		return entries.sort((left, right) => {
			const leftTime = left.local?.timestamp ?? session.getQueuedPromptTimestamp(left.prompt.id) ?? 0;
			const rightTime = right.local?.timestamp ?? session.getQueuedPromptTimestamp(right.prompt.id) ?? 0;
			return leftTime - rightTime || left.prompt.id.localeCompare(right.prompt.id);
		});
	}

	#queuedPromptEntry(session: InteractiveModeContext["viewSession"], id: string): QueuedPromptEditorEntry | undefined {
		return this.#queuedPromptEntries(session).find(entry => entry.prompt.id === id);
	}

	#releaseQueuedPromptSignature(session: InteractiveModeContext["viewSession"], signature: string | undefined): void {
		if (!signature) return;
		const remains = this.#queuedPromptEntries(session).some(entry => {
			if (entry.prompt.customType !== undefined) return false;
			const draft = entry.local ? undefined : session.getQueuedPromptDraft(entry.prompt.id);
			const text = entry.local?.text ?? draft?.text ?? entry.prompt.text;
			const imageCount = entry.local?.images?.length ?? draft?.images?.length ?? entry.prompt.imageCount ?? 0;
			return localSubmissionSignature(text, imageCount) === signature;
		});
		if (!remains) this.ctx.locallySubmittedUserSignatures.delete(signature);
	}

	#setComposerDraft(draft: QueuedPromptComposerDraft): void {
		this.ctx.editor.setText(draft.text);
		this.ctx.editor.pendingImages = [...draft.images];
		this.ctx.editor.pendingImageLinks = [...draft.imageLinks];
		this.ctx.editor.imageLinks = draft.images.length > 0 ? this.ctx.editor.pendingImageLinks : undefined;
	}

	#restorePriorComposerDraft(state: QueuedPromptEditState): void {
		if (!state.priorDraft) return;
		this.#setComposerDraft(state.priorDraft);
		state.priorDraft = undefined;
		state.queuedImages = undefined;
		state.originalSignature = undefined;
		state.originalCustomType = undefined;
	}

	#preserveEditedPromptAsDraft(state: QueuedPromptEditState): void {
		const prior = state.priorDraft;
		if (!prior) return;
		const editedImages = [...this.ctx.editor.pendingImages];
		const editedImageLinks = [...this.ctx.editor.pendingImageLinks];
		const editedText =
			editedImages.length > 0
				? shiftImageMarkers(this.ctx.editor.getText(), prior.images.length)
				: this.ctx.editor.getText();
		const combinedText = [editedText, prior.text].filter(text => text.trim()).join("\n\n");
		this.ctx.editor.setText(combinedText);
		this.ctx.editor.pendingImages = [...prior.images, ...editedImages];
		this.ctx.editor.pendingImageLinks = [...prior.imageLinks, ...editedImageLinks];
		this.ctx.editor.imageLinks =
			this.ctx.editor.pendingImages.length > 0 ? this.ctx.editor.pendingImageLinks : undefined;
		this.#releaseQueuedPromptSignature(state.session, state.originalSignature);
		state.priorDraft = undefined;
		state.queuedImages = undefined;
		state.originalCustomType = undefined;
		state.originalSignature = undefined;
	}

	#selectQueuedPrompt(state: QueuedPromptEditState, prompt: QueuedPrompt, index: number): void {
		state.selectedId = prompt.id;
		state.selectedIndex = index;
		state.persistedDelivery = prompt.delivery;
		state.draftDelivery = state.draftDeliveries.get(prompt.id) ?? prompt.delivery;
		state.mode = "manage";
		state.originalCustomType = undefined;
		state.originalSignature = undefined;
	}

	#refreshQueuedPromptEditor(state: QueuedPromptEditState): void {
		if (this.#queuedPromptEdit !== state) return;
		if (state.session !== this.ctx.viewSession) {
			if (state.mode === "editText" || state.mode === "savingEdit") this.#preserveEditedPromptAsDraft(state);
			this.#stopQueuedPromptEditing();
			return;
		}
		const entries = this.#queuedPromptEntries(state.session);
		const liveIds = new Set(entries.map(entry => entry.prompt.id));
		for (const id of state.draftDeliveries.keys()) {
			if (!liveIds.has(id)) state.draftDeliveries.delete(id);
		}
		for (const entry of entries) {
			if (state.draftDeliveries.get(entry.prompt.id) === entry.prompt.delivery) {
				state.draftDeliveries.delete(entry.prompt.id);
			}
		}
		for (const id of this.#interruptingQueuedPromptIds) {
			if (!liveIds.has(id)) this.#interruptingQueuedPromptIds.delete(id);
		}
		if (entries.length === 0) {
			if (state.mode === "editText" || state.mode === "savingEdit") {
				this.#preserveEditedPromptAsDraft(state);
				this.ctx.showWarning("That prompt ran while you were editing it. Your edit remains in the composer.");
			}
			this.#stopQueuedPromptEditing();
			return;
		}
		const selectedIndex = entries.findIndex(entry => entry.prompt.id === state.selectedId);
		if (selectedIndex === -1) {
			if (state.mode === "editText" || state.mode === "savingEdit") {
				this.#preserveEditedPromptAsDraft(state);
				this.#stopQueuedPromptEditing();
				this.ctx.showWarning("That prompt ran while you were editing it. Your edit remains in the composer.");
				return;
			}
			if (state.mode === "savingRemove") {
				this.updatePendingMessagesDisplay();
				return;
			}
			const nextIndex = Math.min(state.selectedIndex, entries.length - 1);
			this.#selectQueuedPrompt(state, entries[nextIndex]!.prompt, nextIndex);
			this.updatePendingMessagesDisplay();
			return;
		}
		const selected = entries[selectedIndex]!.prompt;
		state.selectedIndex = selectedIndex;
		state.persistedDelivery = selected.delivery;
		state.draftDelivery = state.draftDeliveries.get(selected.id) ?? selected.delivery;
		this.updatePendingMessagesDisplay();
	}

	#queuedPromptEditorOwnsInput(state: QueuedPromptEditState): boolean {
		return (
			this.#queuedPromptEdit === state &&
			state.session === this.ctx.viewSession &&
			!this.ctx.ui.hasOverlay() &&
			this.ctx.ui.getFocused() === this.ctx.editor
		);
	}

	#beginQueuedPromptTextEdit(state: QueuedPromptEditState): void {
		const entry = this.#queuedPromptEntry(state.session, state.selectedId);
		const draft = entry?.local
			? { text: entry.local.text, images: entry.local.images }
			: state.session.getQueuedPromptDraft(state.selectedId);
		if (!entry || !draft) {
			this.#refreshQueuedPromptEditor(state);
			return;
		}
		state.priorDraft = {
			text: this.ctx.editor.getText(),
			images: [...this.ctx.editor.pendingImages],
			imageLinks: [...this.ctx.editor.pendingImageLinks],
		};
		state.queuedImages = [...(draft.images ?? [])];
		state.originalCustomType = entry.prompt.customType;
		state.originalSignature = entry.local
			? draft.text.startsWith("/")
				? undefined
				: localSubmissionSignature(draft.text, state.queuedImages.length)
			: queuedPromptSignature(entry.prompt, draft.text);
		if (state.originalSignature) this.ctx.locallySubmittedUserSignatures.add(state.originalSignature);
		state.mode = "editText";
		this.#setComposerDraft({
			text: draft.text,
			images: state.queuedImages,
			imageLinks: state.queuedImages.map(() => undefined),
		});
		this.updatePendingMessagesDisplay();
	}

	#handleQueuedPromptEditInput(data: string): { consume: true } | undefined {
		const state = this.#queuedPromptEdit;
		if (!state) return undefined;
		if (!this.#queuedPromptEditorOwnsInput(state)) {
			if (state.mode === "editText" || state.mode === "savingEdit") this.#preserveEditedPromptAsDraft(state);
			this.#stopQueuedPromptEditing();
			return undefined;
		}
		const cancel =
			this.ctx.keybindings.matches(data, "tui.select.cancel") ||
			matchesKey(data, "escape") ||
			matchesKey(data, "esc");
		const confirm =
			this.ctx.keybindings.matches(data, "tui.select.confirm") ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			data === "\n";
		if (state.mode === "savingEdit" || state.mode === "savingRemove") return { consume: true };
		if (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) {
			if (state.mode === "editText") this.#restorePriorComposerDraft(state);
			this.#stopQueuedPromptEditing();
			return undefined;
		}
		const entries = this.#queuedPromptEntries(state.session);
		const selectedIndex = entries.findIndex(entry => entry.prompt.id === state.selectedId);
		if (selectedIndex === -1) {
			this.#refreshQueuedPromptEditor(state);
			return undefined;
		}
		state.selectedIndex = selectedIndex;
		if (cancel) {
			if (state.mode === "editText") {
				this.#restorePriorComposerDraft(state);
				state.mode = "manage";
				this.updatePendingMessagesDisplay();
			} else if (state.mode === "confirmRemove") {
				state.mode = "manage";
				this.updatePendingMessagesDisplay();
			} else {
				this.#stopQueuedPromptEditing();
			}
			return { consume: true };
		}
		if (state.mode === "editText") {
			if (confirm) {
				state.mode = "savingEdit";
				this.updatePendingMessagesDisplay();
				void this.#commitQueuedPromptTextEdit(state);
				return { consume: true };
			}
			return undefined;
		}
		if (state.mode === "confirmRemove") {
			if (confirm) {
				state.mode = "savingRemove";
				this.updatePendingMessagesDisplay();
				void this.#commitQueuedPromptRemoval(state);
			}
			return { consume: true };
		}

		const move =
			this.ctx.keybindings.matches(data, "tui.select.up") || matchesKey(data, "up")
				? -1
				: this.ctx.keybindings.matches(data, "tui.select.down") || matchesKey(data, "down")
					? 1
					: 0;
		if (move !== 0) {
			const nextIndex = Math.max(0, Math.min(entries.length - 1, state.selectedIndex + move));
			this.#selectQueuedPrompt(state, entries[nextIndex]!.prompt, nextIndex);
			this.updatePendingMessagesDisplay();
			return { consume: true };
		}
		const timingMove = matchesKey(data, "left") ? -1 : matchesKey(data, "right") ? 1 : 0;
		if (timingMove !== 0) {
			const deliveryIndex = QUEUED_PROMPT_DELIVERIES.indexOf(state.draftDelivery);
			const nextIndex = Math.max(0, Math.min(QUEUED_PROMPT_DELIVERIES.length - 1, deliveryIndex + timingMove));
			const nextDelivery = QUEUED_PROMPT_DELIVERIES[nextIndex]!;
			if (nextDelivery !== state.draftDelivery) {
				state.draftDelivery = nextDelivery;
				if (nextDelivery === "interrupt") {
					for (const [id, delivery] of state.draftDeliveries) {
						if (id !== state.selectedId && delivery === "interrupt") state.draftDeliveries.delete(id);
					}
				}
				if (nextDelivery === state.persistedDelivery) state.draftDeliveries.delete(state.selectedId);
				else state.draftDeliveries.set(state.selectedId, nextDelivery);
				this.updatePendingMessagesDisplay();
			}
			return { consume: true };
		}
		if (data === "e" || data === "E") {
			this.#beginQueuedPromptTextEdit(state);
			return { consume: true };
		}
		if (data === "d" || data === "D" || matchesKey(data, "delete")) {
			state.mode = "confirmRemove";
			this.updatePendingMessagesDisplay();
			return { consume: true };
		}
		if (confirm) {
			const changes = entries.flatMap(entry => {
				const delivery = state.draftDeliveries.get(entry.prompt.id);
				return delivery === undefined || delivery === entry.prompt.delivery
					? []
					: [{ id: entry.prompt.id, delivery }];
			});
			this.#stopQueuedPromptEditing();
			if (changes.length > 0) void this.#commitQueuedPromptDeliveries(state.session, changes);
			return { consume: true };
		}
		return { consume: true };
	}

	async #commitQueuedPromptDeliveries(
		session: InteractiveModeContext["viewSession"],
		changes: readonly { id: string; delivery: QueuedPromptDelivery }[],
	): Promise<void> {
		for (const interrupt of [false, true]) {
			for (const change of changes) {
				if ((change.delivery === "interrupt") !== interrupt) continue;
				await this.#commitQueuedPromptDelivery(session, change.id, change.delivery);
			}
		}
	}

	async #commitQueuedPromptDelivery(
		session: InteractiveModeContext["viewSession"],
		selectedId: string,
		draftDelivery: QueuedPromptDelivery,
	): Promise<void> {
		let pendingDelivery: { delivery: QueuedPromptDelivery } | undefined;
		try {
			const entry = this.#queuedPromptEntry(session, selectedId);
			const local = entry?.local;
			if (local) {
				if (draftDelivery !== "interrupt") {
					local.mode = draftDelivery === "afterCurrent" ? "followUp" : "steer";
					this.ctx.showStatus(`Queued prompt set to ${QUEUED_PROMPT_TIMING_LABELS[draftDelivery]}.`);
					this.updatePendingMessagesDisplay();
					return;
				}
				if (session.isCompacting) {
					this.ctx.showWarning("NOW is unavailable during compaction; choose NEXT or AFTER.");
					this.updatePendingMessagesDisplay();
					return;
				}
				if (!session.isStreaming) {
					this.ctx.showWarning("Current work already ended; the queued prompt timing was not changed.");
					this.updatePendingMessagesDisplay();
					return;
				}
				await session.abort({ reason: "Interrupted by user" });
				await this.#deliverQueuedMessage({ ...local, mode: "steer" });
				const localIndex = this.ctx.compactionQueuedMessages.findIndex(entry => entry.id === selectedId);
				if (localIndex !== -1) this.ctx.compactionQueuedMessages.splice(localIndex, 1);
				this.ctx.showStatus("Interrupting current work with the selected queued prompt.");
				this.updatePendingMessagesDisplay();
				return;
			}
			pendingDelivery = { delivery: draftDelivery };
			this.#pendingQueuedPromptDeliveries.set(selectedId, pendingDelivery);
			this.updatePendingMessagesDisplay();
			const result = await session.setQueuedPromptDelivery(selectedId, draftDelivery);
			if (result.status === "updated") {
				if (draftDelivery === "interrupt") {
					this.#interruptingQueuedPromptIds.add(selectedId);
					this.ctx.showStatus("Interrupting current work with the selected queued prompt.");
				} else {
					this.#interruptingQueuedPromptIds.delete(selectedId);
					this.ctx.showStatus(`Queued prompt set to ${QUEUED_PROMPT_TIMING_LABELS[draftDelivery]}.`);
				}
			} else if (result.status === "unavailable" && result.reason !== "queue_mutation") {
				this.ctx.showWarning(
					result.reason === "no_active_turn"
						? "Current work already ended; the queued prompt timing was not changed."
						: "Queued prompt timing is unavailable during a session transition.",
				);
			}
		} catch (error) {
			this.showError(
				`Failed to save queued prompt timing: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (pendingDelivery && this.#pendingQueuedPromptDeliveries.get(selectedId) === pendingDelivery) {
			this.#pendingQueuedPromptDeliveries.delete(selectedId);
		}
		this.updatePendingMessagesDisplay();
	}

	async #commitQueuedPromptTextEdit(state: QueuedPromptEditState): Promise<void> {
		const text = this.ctx.editor.getText();
		const editedImages = [...this.ctx.editor.pendingImages];
		if (!text.trim() && editedImages.length === 0) {
			state.mode = "editText";
			this.ctx.showWarning("A queued prompt cannot be empty.");
			this.updatePendingMessagesDisplay();
			return;
		}
		let addedSignature: string | undefined;
		try {
			const localIndex = this.ctx.compactionQueuedMessages.findIndex(entry => entry.id === state.selectedId);
			if (localIndex !== -1) {
				const signature = localSubmissionSignature(text, editedImages.length);
				if (!this.ctx.locallySubmittedUserSignatures.has(signature)) {
					this.ctx.locallySubmittedUserSignatures.add(signature);
					addedSignature = signature;
				}
				const local = this.ctx.compactionQueuedMessages[localIndex]!;
				this.ctx.compactionQueuedMessages[localIndex] = {
					...local,
					text,
					images: editedImages.length > 0 ? editedImages : undefined,
				};
				this.#releaseQueuedPromptSignature(state.session, state.originalSignature);
				if (this.#queuedPromptEdit === state) {
					this.#restorePriorComposerDraft(state);
					state.mode = "manage";
					this.#refreshQueuedPromptEditor(state);
				}
				this.ctx.showStatus("Queued prompt updated.");
				await waitForImmediate();
				this.updatePendingMessagesDisplay();
				return;
			}

			const built = isKnownSkillCommand(this.ctx, text)
				? await buildSkillCommandPrompt(
						this.ctx,
						text,
						state.persistedDelivery === "afterCurrent" ? "followUp" : "steer",
						editedImages,
					)
				: undefined;
			const becomesUserMessage =
				built === undefined &&
				(state.originalCustomType === undefined || state.originalCustomType === SKILL_PROMPT_MESSAGE_TYPE);
			if (becomesUserMessage) {
				const signature = localSubmissionSignature(text, editedImages.length);
				if (!this.ctx.locallySubmittedUserSignatures.has(signature)) {
					this.ctx.locallySubmittedUserSignatures.add(signature);
					addedSignature = signature;
				}
			}
			const result = await state.session.updateQueuedPromptText(
				state.selectedId,
				text,
				editedImages,
				built?.message,
			);
			if (result.status === "updated") {
				this.#releaseQueuedPromptSignature(state.session, state.originalSignature);
				if (this.#queuedPromptEdit === state) {
					this.#restorePriorComposerDraft(state);
					state.mode = "manage";
					this.#refreshQueuedPromptEditor(state);
				}
				this.ctx.showStatus("Queued prompt updated.");
			} else {
				if (addedSignature) this.ctx.locallySubmittedUserSignatures.delete(addedSignature);
				if (this.#queuedPromptEdit === state) {
					this.#preserveEditedPromptAsDraft(state);
					this.#stopQueuedPromptEditing(false);
				}
				this.ctx.showWarning(
					result.status === "stale"
						? "That prompt ran while you were editing it. Your edit remains in the composer."
						: result.reason === "queue_mutation"
							? "Another queue change won the race. Your edit remains in the composer."
							: "Queued prompt editing is unavailable during a session transition. Your edit remains in the composer.",
				);
			}
		} catch (error) {
			if (addedSignature) this.ctx.locallySubmittedUserSignatures.delete(addedSignature);
			if (this.#queuedPromptEdit === state) {
				this.#preserveEditedPromptAsDraft(state);
				this.#stopQueuedPromptEditing(false);
			}
			this.showError(`Failed to update queued prompt: ${error instanceof Error ? error.message : String(error)}`);
		}
		await waitForImmediate();
		this.updatePendingMessagesDisplay();
	}
	async #commitQueuedPromptRemoval(state: QueuedPromptEditState): Promise<void> {
		const entry = this.#queuedPromptEntry(state.session, state.selectedId);
		const selectedDraft = entry?.local
			? { text: entry.local.text }
			: state.session.getQueuedPromptDraft(state.selectedId);
		const removedSignature = entry?.local
			? localSubmissionSignature(entry.local.text, entry.local.images?.length ?? 0)
			: entry
				? queuedPromptSignature(entry.prompt, selectedDraft?.text)
				: undefined;
		try {
			const localIndex = this.ctx.compactionQueuedMessages.findIndex(local => local.id === state.selectedId);
			const result =
				localIndex === -1
					? await state.session.removeQueuedPrompt(state.selectedId)
					: (() => {
							this.ctx.compactionQueuedMessages.splice(localIndex, 1);
							return { status: "updated" } as const;
						})();
			if (result.status === "updated") {
				this.#interruptingQueuedPromptIds.delete(state.selectedId);
				this.#releaseQueuedPromptSignature(state.session, removedSignature);
				const entries = this.#queuedPromptEntries(state.session);
				if (this.#queuedPromptEdit === state) {
					if (entries.length === 0) this.#stopQueuedPromptEditing(false);
					else {
						const nextIndex = Math.min(state.selectedIndex, entries.length - 1);
						this.#selectQueuedPrompt(state, entries[nextIndex]!.prompt, nextIndex);
					}
				}
				this.ctx.showStatus("Queued prompt removed.");
			} else if (result.status === "stale") {
				this.ctx.showWarning("That prompt is no longer queued.");
				if (this.#queuedPromptEdit === state) this.#refreshQueuedPromptEditor(state);
			} else {
				state.mode = "manage";
				this.ctx.showWarning(
					result.reason === "queue_mutation"
						? "Another queue change is still being saved."
						: "Queued prompt removal is unavailable during a session transition.",
				);
			}
		} catch (error) {
			state.mode = "manage";
			this.showError(`Failed to remove queued prompt: ${error instanceof Error ? error.message : String(error)}`);
		}
		await waitForImmediate();
		this.updatePendingMessagesDisplay();
	}

	#renderQueuedPromptEditor(state: QueuedPromptEditState): boolean {
		const entries = this.#queuedPromptEntries(state.session);
		if (entries.length === 0) return false;
		this.ctx.pendingMessagesContainer.addChild(new Spacer(1));
		const heading = theme.fg("muted", `Queued${theme.sep.dot}${entries.length}`);
		this.ctx.pendingMessagesContainer.addChild(new TruncatedText(heading, 1, 0));
		for (let index = 0; index < entries.length; index++) {
			const prompt = entries[index]!.prompt;
			const selected = prompt.id === state.selectedId;
			const delivery = this.#interruptingQueuedPromptIds.has(prompt.id)
				? "interrupt"
				: (state.draftDeliveries.get(prompt.id) ?? prompt.delivery);
			this.ctx.pendingMessagesContainer.addChild(
				new TruncatedText(
					queuedPromptRow(prompt, index, {
						selected,
						delivery,
						interrupting: this.#interruptingQueuedPromptIds.has(prompt.id),
					}),
					1,
					0,
				),
			);
		}
		let hint: string;
		if (state.mode === "confirmRemove") {
			hint = "  Remove only this queued prompt and its attachments? Enter confirm · Esc keep";
		} else if (state.mode === "editText") {
			hint = "  Editing selected prompt in composer · Enter save · Esc cancel";
		} else if (state.mode === "savingEdit" || state.mode === "savingRemove") {
			hint = "  Saving queued prompt change…";
		} else {
			hint = "  ↑/↓ select · ←/→ preview · E edit · D/Delete remove · Enter apply · Esc undo";
		}
		this.ctx.pendingMessagesContainer.addChild(new TruncatedText(theme.fg("dim", hint), 1, 0));
		return true;
	}

	updatePendingMessagesDisplay(): void {
		this.ctx.pendingMessagesContainer.disposeChildren();
		const editState = this.#queuedPromptEdit;
		if (editState) {
			if (editState.session !== this.ctx.viewSession) {
				if (editState.mode === "editText" || editState.mode === "savingEdit") {
					this.#preserveEditedPromptAsDraft(editState);
				}
				this.#stopQueuedPromptEditing(false);
			} else if (this.#renderQueuedPromptEditor(editState)) {
				this.ctx.ui.requestComponentRender(this.ctx.pendingMessagesContainer);
				return;
			} else {
				this.#stopQueuedPromptEditing(false);
			}
		}

		const prompts = this.ctx.viewSession.getQueuedPrompts();
		const liveIds = new Set(prompts.map(prompt => prompt.id));
		for (const id of this.#interruptingQueuedPromptIds) {
			if (!liveIds.has(id)) this.#interruptingQueuedPromptIds.delete(id);
		}
		const queuedRows: Array<
			Pick<QueuedPrompt, "id" | "text" | "delivery" | "imageCount"> & {
				submittedAt: number;
				orderId: string;
			}
		> = [
			...prompts.map(prompt => ({
				...prompt,
				delivery: this.#pendingQueuedPromptDeliveries.get(prompt.id)?.delivery ?? prompt.delivery,
				submittedAt: this.ctx.viewSession.getQueuedPromptTimestamp(prompt.id)!,
				orderId: prompt.id,
			})),
			...this.ctx.compactionQueuedMessages.map(entry => ({
				id: entry.id,
				text: entry.text,
				delivery: entry.mode === "steer" ? ("steer" as const) : ("afterCurrent" as const),
				...(entry.images?.length ? { imageCount: entry.images.length } : {}),
				submittedAt: entry.timestamp,
				orderId: entry.id,
			})),
		].sort((left, right) => left.submittedAt - right.submittedAt || left.orderId.localeCompare(right.orderId));
		if (queuedRows.length > 0) {
			this.ctx.pendingMessagesContainer.addChild(new Spacer(1));
			const heading = theme.fg("muted", `Queued${theme.sep.dot}${queuedRows.length}`);
			this.ctx.pendingMessagesContainer.addChild(new TruncatedText(heading, 1, 0));
			for (let index = 0; index < queuedRows.length; index++) {
				const prompt = queuedRows[index]!;
				const interrupting = this.#interruptingQueuedPromptIds.has(prompt.id);
				this.ctx.pendingMessagesContainer.addChild(
					new TruncatedText(
						queuedPromptRow(prompt, index, {
							delivery: interrupting ? "interrupt" : prompt.delivery,
							interrupting,
						}),
						1,
						0,
					),
				);
			}

			const dequeueKeys = this.ctx.keybindings.getKeys("app.message.dequeue");
			const shortcuts = this.ctx.session.extensionRunner?.getShortcuts();
			const restoreKeys: typeof dequeueKeys = [];
			const hints: string[] = [];
			for (const key of dequeueKeys) {
				const shortcut = shortcuts?.get(key);
				const activeShortcut =
					shortcut &&
					(!shortcut.whenKeybinding || this.ctx.keybindings.getKeys(shortcut.whenKeybinding).includes(key));
				if (activeShortcut) {
					if (shortcut.description) hints.push(`${formatKeyHints(key)}: ${shortcut.description}`);
				} else if (key === "shift+up") {
					hints.push(`${formatKeyHints(key)}: Manage queued prompts`);
				} else {
					restoreKeys.push(key);
				}
			}
			if (restoreKeys.length > 0) hints.push(`${formatKeyHints(restoreKeys)} to restore newest`);
			if (hints.length > 0) {
				const hintText = theme.fg("dim", `  ${theme.tree.hook} ${hints.join(" · ")}`);
				this.ctx.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
			}
		}
		this.ctx.ui.requestComponentRender(this.ctx.pendingMessagesContainer);
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		const queuedImages = images && images.length > 0 ? images : undefined;
		this.ctx.compactionQueuedMessages.push({
			id: Snowflake.next(),
			timestamp: Date.now(),
			text,
			mode,
			images: queuedImages,
		} satisfies CompactionQueuedMessage);
		this.ctx.editor.clearDraft(text);
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.showStatus(
			queuedImages ? "Queued message with image for after compaction" : "Queued message for after compaction",
		);
	}

	async #deliverQueuedMessage(message: CompactionQueuedMessage): Promise<void> {
		if (
			await invokeSkillCommandFromText(this.ctx, message.text, message.mode, {
				propagateErrors: true,
				queueOnly: true,
				images: message.images,
			})
		) {
			return;
		}
		if (this.ctx.isKnownSlashCommand(message.text)) {
			await this.ctx.session.prompt(message.text);
			return;
		}
		await this.ctx.withLocalSubmission(
			message.text,
			() =>
				message.mode === "followUp"
					? this.ctx.session.followUp(message.text, message.images)
					: this.ctx.session.steer(message.text, message.images),
			{ imageCount: message.images?.length ?? 0 },
		);
	}

	isKnownSlashCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		if (!commandName) return false;

		if (this.ctx.session.extensionRunner?.getCommand(commandName)) {
			return true;
		}

		for (const command of this.ctx.session.customCommands) {
			if (command.command.name === commandName) {
				return true;
			}
		}

		return this.ctx.fileSlashCommands.has(commandName);
	}

	async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.ctx.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...(this.ctx.compactionQueuedMessages as CompactionQueuedMessage[])];
		this.ctx.compactionQueuedMessages = [] as CompactionQueuedMessage[];
		this.ctx.updatePendingMessagesDisplay();

		const restoreQueue = async (error: unknown): Promise<void> => {
			try {
				await this.ctx.session.clearQueueDurably();
			} catch (clearError) {
				this.ctx.compactionQueuedMessages = queuedMessages;
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.showError(
					`Failed to restore queued messages: ${clearError instanceof Error ? clearError.message : String(clearError)}`,
				);
				return;
			}
			this.ctx.compactionQueuedMessages = queuedMessages;
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				for (const message of queuedMessages) {
					await this.#deliverQueuedMessage(message);
				}
				this.ctx.updatePendingMessagesDisplay();
				return;
			}

			let firstPromptIndex = -1;
			for (let i = 0; i < queuedMessages.length; i++) {
				if (!this.ctx.isKnownSlashCommand(queuedMessages[i].text)) {
					firstPromptIndex = i;
					break;
				}
			}
			if (firstPromptIndex === -1) {
				for (const message of queuedMessages) {
					await this.ctx.session.prompt(message.text);
				}
				return;
			}

			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				// preCommands are all slash commands; #deliverQueuedMessage handles
				// that branch (no local-submission marking needed since slash
				// commands don't generate a matching user message_start).
				await this.#deliverQueuedMessage(message);
			}

			// First prompt is fire-and-forget — its rejection is funneled through
			// `restoreQueue` rather than rethrown. Plain prompts use primitive
			// recordLocalSubmission and dispose manually in the catch. Skill prompts
			// are rebuilt as user-attributed custom messages so queued `/skill:` text
			// is not sent as a literal prompt after compaction.
			let promptPromise: Promise<unknown>;
			if (isKnownSkillCommand(this.ctx, firstPrompt.text)) {
				const built = await buildSkillCommandPrompt(
					this.ctx,
					firstPrompt.text,
					firstPrompt.mode,
					firstPrompt.images,
				);
				promptPromise = built
					? this.ctx.session.promptCustomMessage(built.message, built.options).catch(restoreQueue)
					: Promise.resolve();
			} else {
				const disposeFirstPrompt = this.ctx.recordLocalSubmission(
					firstPrompt.text,
					firstPrompt.images?.length ?? 0,
				);
				promptPromise = this.ctx.session
					.prompt(firstPrompt.text, {
						streamingBehavior: firstPrompt.mode === "followUp" ? "followUp" : "steer",
						images: firstPrompt.images,
					})
					.catch(async (error: unknown) => {
						disposeFirstPrompt();
						await restoreQueue(error);
					});
			}

			for (const message of rest) {
				await this.#deliverQueuedMessage(message);
			}
			this.ctx.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			await restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	flushPendingBashComponents(): void {
		for (const component of this.ctx.pendingBashComponents) {
			this.ctx.pendingMessagesContainer.removeChild(component);
			this.ctx.chatContainer.addChild(component);
		}
		this.ctx.pendingBashComponents = [];
		for (const component of this.ctx.pendingPythonComponents) {
			this.ctx.pendingMessagesContainer.removeChild(component);
			this.ctx.chatContainer.addChild(component);
		}
		this.ctx.pendingPythonComponents = [];
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.ctx.viewSession.messages.length - 1; i >= 0; i--) {
			const message = this.ctx.viewSession.messages[i];
			if (message?.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	extractAssistantText(message: AssistantMessage): string {
		let text = "";
		for (const content of message.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}
		return text.trim();
	}
}
