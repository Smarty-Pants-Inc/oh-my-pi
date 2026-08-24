import { createHash } from "node:crypto";
import type {
	ContextInstruction,
	ContextTarget,
	ImageContent,
	Message,
	MessageAttribution,
	ProviderPayload,
	TextContent,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "../types";
import branchSummaryContextPrompt from "./prompts/branch-summary-context.md" with { type: "text" };
import compactionSummaryContextPrompt from "./prompts/compaction-summary-context.md" with { type: "text" };
import handoffSummaryContextPrompt from "./prompts/handoff-summary-context.md" with { type: "text" };

const COMPACTION_SUMMARY_TEMPLATE = compactionSummaryContextPrompt;
const HANDOFF_SUMMARY_TEMPLATE = handoffSummaryContextPrompt;
const BRANCH_SUMMARY_TEMPLATE = branchSummaryContextPrompt;
const BRANCH_SUMMARY_SOURCE = "packages/agent/src/compaction/prompts/branch-summary-context.md";
const COMPACTION_SUMMARY_SOURCE = "packages/agent/src/compaction/prompts/compaction-summary-context.md";

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/** Legacy hook message type (pre-extensions). Kept for session migration. */
export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	/** Estimated context tokens after the rewrite (display metadata). */
	tokensAfter?: number;
	/** Harness compaction method that produced this summary (display metadata). */
	method?: string;
	providerPayload?: ProviderPayload;
	/** Runtime-only ordered archive blocks for snapcompact: old text region,
	 *  imaged middle, then new text region. When present, `summary` is already
	 *  the final lead-in text (no legacy wrapper applied). */
	blocks?: (TextContent | ImageContent)[];
	/** Snapcompact image blocks, kept for display counts / legacy consumers. */
	images?: ImageContent[];
	/** Post-pass dead-end warning attached to this compaction (progress guard). */
	warning?: string;
	timestamp: number;
}

export type CoreCompactionMessage = CustomMessage | HookMessage | BranchSummaryMessage | CompactionSummaryMessage;

declare module "../types" {
	interface CustomAgentMessages {
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}
export type ConvertToLlm = (messages: AgentMessage[]) => Message[];

function getPrunedToolResultContent(message: ToolResultMessage): (TextContent | ImageContent)[] {
	if (message.prunedAt === undefined) {
		return message.content;
	}
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const text = textBlocks.map(block => block.text).join("") || "[Output truncated]";
	return [{ type: "text", text }];
}

export function renderBranchSummaryContext(summary: string): string {
	return prompt.render(BRANCH_SUMMARY_TEMPLATE, { summary });
}

export function renderCompactionSummaryContext(summary: string): string {
	return prompt.render(COMPACTION_SUMMARY_TEMPLATE, { summary });
}
/**
 * Wrap a handoff document for injection into the successor context. Unlike the
 * generic compaction wrapper, this names the mechanism and pins authorship —
 * the document was written by a prior instance in its own voice, so without
 * this framing the successor misreads first-person "Next Steps" as fresh user
 * instructions (or tries to write the handoff again).
 */
export function renderHandoffSummaryContext(summary: string): string {
	return prompt.render(HANDOFF_SUMMARY_TEMPLATE, { summary });
}

function compactionSummaryInstructionText(message: CompactionSummaryMessage): string {
	if (message.blocks === undefined) return renderCompactionSummaryContext(message.summary);
	return [
		message.summary,
		...message.blocks.filter((block): block is TextContent => block.type === "text").map(block => block.text),
	]
		.filter(text => text.length > 0)
		.join("\n\n");
}

/**
 * Project persisted compaction summaries onto the semantic instruction seam.
 * Their model-authored text is context, never a synthetic user turn.
 */
export function collectCompactionContextInstructions(
	messages: readonly AgentMessage[],
	target: ContextTarget,
): ContextInstruction[] {
	const instructions: ContextInstruction[] = [];
	for (const message of messages) {
		let id: string;
		let sourcePath: string;
		let renderedText: string;
		let order: number;
		if (message.role === "branchSummary") {
			id = "agent.compaction.prompts.branch-summary-context";
			sourcePath = BRANCH_SUMMARY_SOURCE;
			renderedText = renderBranchSummaryContext(message.summary);
			order = 110;
		} else if (message.role === "compactionSummary") {
			id = "agent.compaction.prompts.compaction-summary-context";
			sourcePath = COMPACTION_SUMMARY_SOURCE;
			renderedText = compactionSummaryInstructionText(message);
			order = 150;
		} else {
			continue;
		}
		if (renderedText.trim().length === 0) continue;
		instructions.push({
			id,
			sourcePath,
			role: "internal_context",
			target,
			trigger: "compaction",
			sha256: createHash("sha256").update(renderedText).digest("hex"),
			renderedText,
			order,
		});
	}
	return instructions;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Optional metadata for {@link createCompactionSummaryMessage}. */
export interface CompactionSummaryMessageOptions {
	shortSummary?: string;
	providerPayload?: ProviderPayload;
	images?: ImageContent[];
	blocks?: (TextContent | ImageContent)[];
	warning?: string;
	/** Harness compaction method that produced this summary (e.g. "remote", "soft", "handoff"). */
	method?: string;
	/** Estimated context tokens after the rewrite, for display alongside `tokensBefore`. */
	tokensAfter?: number;
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	options: CompactionSummaryMessageOptions = {},
): CompactionSummaryMessage {
	const { shortSummary, providerPayload, images, blocks, warning, method, tokensAfter } = options;
	const imageBlocks =
		blocks?.filter((block): block is ImageContent => block.type === "image") ??
		(images && images.length > 0 ? images : undefined);
	return {
		role: "compactionSummary",
		summary,
		shortSummary,
		tokensBefore,
		tokensAfter,
		method,
		providerPayload,
		blocks: blocks && blocks.length > 0 ? blocks : undefined,
		images: imageBlocks && imageBlocks.length > 0 ? imageBlocks : undefined,
		warning,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	attribution?: MessageAttribution,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		attribution,
		timestamp: new Date(timestamp).getTime(),
	};
}

function isCoreCompactionMessage(message: AgentMessage): message is AgentMessage & CoreCompactionMessage {
	return (
		message.role === "custom" ||
		message.role === "hookMessage" ||
		message.role === "branchSummary" ||
		message.role === "compactionSummary"
	);
}

/**
 * Transform a single core-domain agent message to its LLM form; `undefined`
 * drops it from the provider request.
 *
 * Single source of truth for the core roles (user/developer/assistant/
 * toolResult) and the compaction messages owned by this package. Embedders
 * with their own app messages (e.g. the coding agent) handle their custom
 * roles and delegate every core role here — duplicating these cases is how
 * snapcompact frames once silently fell off the provider request.
 */
export function convertMessageToLlm(message: AgentMessage): Message | undefined {
	if (isCoreCompactionMessage(message)) {
		switch (message.role) {
			case "custom":
			case "hookMessage": {
				const content =
					typeof message.content === "string"
						? [{ type: "text" as const, text: message.content }]
						: message.content;
				return {
					role: "developer",
					content,
					attribution: message.attribution,
					timestamp: message.timestamp,
				};
			}
			case "branchSummary":
				return undefined;
			case "compactionSummary": {
				const images = (message.blocks ?? message.images ?? []).filter(
					(block): block is ImageContent => block.type === "image",
				);
				if (images.length === 0 && message.providerPayload === undefined) return undefined;
				// Native replacement history and snapcompact image frames are data
				// carriers. The authoritative summary text is emitted separately as
				// typed internal_context by collectCompactionContextInstructions().
				return {
					role: "developer",
					content: images,
					attribution: "agent",
					providerPayload: message.providerPayload,
					timestamp: message.timestamp,
				};
			}
		}
	}

	switch (message.role) {
		case "user":
			return { ...message, attribution: message.attribution ?? "user" };
		case "developer":
			return { ...message, attribution: message.attribution ?? "agent" };
		case "assistant":
			return message;
		case "toolResult":
			return {
				...message,
				content: getPrunedToolResultContent(message as ToolResultMessage),
				attribution: message.attribution ?? "agent",
			};
		default:
			return undefined;
	}
}

/**
 * Default compaction-domain transformer.
 *
 * Embedders with their own app messages should pass a richer transformer through
 * `SummaryOptions.convertToLlm`; this default intentionally preserves only the
 * core LLM roles and the compaction messages owned by this package.
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.map(convertMessageToLlm).filter(message => message !== undefined);
}
