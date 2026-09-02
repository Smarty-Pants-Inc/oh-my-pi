/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */
import type { AgentMessage, AgentToolResult, ThinkingLevel, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Effort, ImageContent, Model, ToolExample } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { CollabUiResponseValue, Participant } from "@oh-my-pi/pi-wire";
import type { CollabFrame } from "../../collab/protocol";
import type { BashResult } from "../../exec/bash-executor";
import type { ContextUsage } from "../../extensibility/extensions/types";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import type { FileEntry } from "../../session/session-entries";
import type { AvailableSlashCommandSource } from "../../slash-commands/available-commands";
import type {
	AgentProgress,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "../../task";
import type { TodoPhase } from "../../tools/todo";
import type { RpcHistoryChunk, RpcHistoryDigest, RpcHistoryPage, RpcHistorySnapshot } from "./rpc-history";
import type { RpcMessagesPage } from "./rpc-messages";
import type {
	RpcArtifactListResult,
	RpcArtifactReadResult,
	RpcArtifactWriteResult,
	RpcBlobListResult,
	RpcBlobReadResult,
	RpcBlobWriteResult,
	RpcCustomMessageContent,
	RpcCustomMessageResult,
} from "./rpc-session-data";

const MAX_RPC_MUTATION_ID_LENGTH = 256;

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

/** Authority provenance required for retry-safe OMP mutations. */
export interface RpcMutationContext {
	commandId: string;
	runtimeId: string;
	generation: number;
}

/** Canonical classification for every RPC command discriminator. */
export const RPC_COMMAND_CLASSIFICATION = {
	negotiate_protocol: "read",
	prompt: "mutation",
	steer: "mutation",
	follow_up: "mutation",
	abort: "mutation",
	abort_and_prompt: "mutation",
	new_session: "mutation",
	custom_message: "mutation",
	get_state: "read",
	set_fast_mode: "mutation",
	get_available_commands: "read",
	set_todos: "mutation",
	set_host_tools: "mutation",
	set_host_uri_schemes: "mutation",
	set_subagent_subscription: "mutation",
	get_subagents: "read",
	get_subagent_messages: "read",
	set_model: "mutation",
	cycle_model: "mutation",
	get_available_models: "read",
	set_thinking_level: "mutation",
	cycle_thinking_level: "mutation",
	set_steering_mode: "mutation",
	set_follow_up_mode: "mutation",
	set_interrupt_mode: "mutation",
	compact: "mutation",
	set_auto_compaction: "mutation",
	set_auto_retry: "mutation",
	abort_retry: "mutation",
	bash: "mutation",
	abort_bash: "mutation",
	get_session_stats: "read",
	export_html: "mutation",
	switch_session: "mutation",
	branch: "mutation",
	fork: "mutation",
	collab_ui_response: "mutation",
	artifact_list: "read",
	artifact_read: "read",
	artifact_write: "mutation",
	blob_list: "read",
	blob_read: "read",
	blob_write: "mutation",
	history_snapshot: "read",
	history_page: "read",
	history_chunk: "read",
	history_digest: "read",
	get_branch_messages: "read",
	get_last_assistant_text: "read",
	set_session_name: "mutation",
	handoff: "mutation",
	get_messages: "read",
	get_messages_page: "read",
	get_login_providers: "read",
	login: "mutation",
} as const satisfies Record<string, "read" | "mutation">;

export type RpcCommandType = keyof typeof RPC_COMMAND_CLASSIFICATION;
export type RpcMutationOperation = {
	[K in RpcCommandType]: (typeof RPC_COMMAND_CLASSIFICATION)[K] extends "mutation" ? K : never;
}[RpcCommandType];

const RPC_CONNECTION_LOCAL_MUTATION_OPERATIONS: Partial<Record<RpcMutationOperation, true>> = {
	set_host_tools: true,
	set_host_uri_schemes: true,
	set_subagent_subscription: true,
};

/** Bounded OMP-native session outcome recorded with a durable mutation receipt. */
export interface RpcMutationSessionOutcome {
	status: "completed" | "cancelled" | "rejected";
	sessionId: string;
	previousSessionId?: string;
	agentInvoked?: boolean;
}

/** Durable OMP evidence returned for authority-scoped mutations. */
export interface RpcMutationReceipt extends RpcMutationContext {
	owner: "omp";
	operation: RpcMutationOperation;
	fingerprint: string;
	replayed: boolean;
	session: RpcMutationSessionOutcome;
}

export const RPC_HERDR_AGENTD_HOST_CAPABILITY = "herdr-agentd-host";

export const RPC_CAPABILITIES = [
	"stdio-rpc",
	"messages-page",
	"extension-ui",
	"host-tools",
	"host-uris",
	"mutation-receipts",
	"fork",
	"fork-entry",
	"prompt-tool-choice",
	"custom-messages",
	"custom-message-when-idle",
	"artifacts",
	"blobs",
	"exact-history",
] as const satisfies readonly string[];

type RpcMutatingCommand<T extends { type: RpcMutationOperation }> = T & { mutation?: RpcMutationContext };
type RpcDurableMutatingCommand<T extends { type: RpcMutationOperation }> = T & { mutation: RpcMutationContext };

export type RpcCommand =
	// Protocol
	| { id?: string; type: "negotiate_protocol"; protocolVersion: number }

	// Prompting
	| RpcMutatingCommand<{
			id?: string;
			type: "prompt";
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
			toolChoice?: string;
	  }>
	| RpcMutatingCommand<{ id?: string; type: "steer"; message: string; images?: ImageContent[] }>
	| RpcMutatingCommand<{ id?: string; type: "follow_up"; message: string; images?: ImageContent[] }>
	| RpcMutatingCommand<{ id?: string; type: "abort" }>
	| RpcMutatingCommand<{ id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }>
	| RpcMutatingCommand<{ id?: string; type: "new_session"; parentSession?: string }>
	| RpcDurableMutatingCommand<{
			id?: string;
			type: "custom_message";
			customType: string;
			content: RpcCustomMessageContent;
			display: boolean;
			details?: unknown;
			when?: "idle" | "any";
	  }>

	// State
	| { id?: string; type: "get_state" }
	| RpcMutatingCommand<{ id?: string; type: "set_fast_mode"; enabled: boolean }>
	| { id?: string; type: "get_available_commands" }
	| RpcMutatingCommand<{ id?: string; type: "set_todos"; phases: TodoPhase[] }>
	| RpcMutatingCommand<{ id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }>
	| RpcMutatingCommand<{ id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }>
	| RpcMutatingCommand<{
			id?: string;
			type: "set_subagent_subscription";
			level: RpcSubagentSubscriptionLevel;
	  }>
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }

	// Model
	| RpcMutatingCommand<{ id?: string; type: "set_model"; provider: string; modelId: string }>
	| RpcMutatingCommand<{ id?: string; type: "cycle_model" }>
	| { id?: string; type: "get_available_models" }

	// Thinking
	| RpcMutatingCommand<{ id?: string; type: "set_thinking_level"; level: ThinkingLevel }>
	| RpcMutatingCommand<{ id?: string; type: "cycle_thinking_level" }>

	// Queue modes
	| RpcMutatingCommand<{ id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }>
	| RpcMutatingCommand<{ id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }>
	| RpcMutatingCommand<{ id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }>

	// Compaction
	| RpcMutatingCommand<{ id?: string; type: "compact"; customInstructions?: string }>
	| RpcMutatingCommand<{ id?: string; type: "set_auto_compaction"; enabled: boolean }>

	// Retry
	| RpcMutatingCommand<{ id?: string; type: "set_auto_retry"; enabled: boolean }>
	| RpcMutatingCommand<{ id?: string; type: "abort_retry" }>

	// Bash
	| RpcMutatingCommand<{ id?: string; type: "bash"; command: string }>
	| RpcMutatingCommand<{ id?: string; type: "abort_bash" }>

	// Session
	| { id?: string; type: "get_session_stats" }
	| RpcMutatingCommand<{ id?: string; type: "export_html"; outputPath?: string }>
	| RpcMutatingCommand<{ id?: string; type: "switch_session"; sessionPath: string }>
	| RpcMutatingCommand<{ id?: string; type: "branch"; entryId: string }>
	| RpcMutatingCommand<{ id?: string; type: "fork"; entryId?: string }>
	| RpcMutatingCommand<{ id?: string; type: "collab_ui_response"; reqId: number; value?: CollabUiResponseValue }>
	| { id?: string; type: "artifact_list" }
	| { id?: string; type: "artifact_read"; artifactId: string }
	| RpcDurableMutatingCommand<{ id?: string; type: "artifact_write"; content: string; toolType?: string }>
	| { id?: string; type: "blob_list" }
	| { id?: string; type: "blob_read"; hash: string }
	| RpcDurableMutatingCommand<{
			id?: string;
			type: "blob_write";
			hash: string;
			size: number;
			content: string;
	  }>
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| RpcMutatingCommand<{ id?: string; type: "set_session_name"; name: string }>
	| RpcMutatingCommand<{ id?: string; type: "handoff"; customInstructions?: string }>

	// Messages
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_messages_page"; cursor?: string; limit?: number }
	| { id?: string; type: "history_snapshot" }
	| { id?: string; type: "history_page"; scope?: "entries" | "branch"; cursor?: string; limit?: number }
	| { id?: string; type: "history_chunk"; cursor?: string; limit?: number }
	| { id?: string; type: "history_digest" }

	// Login
	| { id?: string; type: "get_login_providers" }
	| RpcMutatingCommand<{ id?: string; type: "login"; providerId: string }>;

/** A canonical RPC command before the client assigns its transport request ID. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type RpcCommandInput = DistributiveOmit<RpcCommand, "id">;

export type RpcMutationCommand = Extract<RpcCommand, { type: RpcMutationOperation }>;

/** Mutable connection-local configuration that must be applied again after reconnect. */
export type RpcDurableMutationCommand = Exclude<
	RpcMutationCommand,
	{ type: "set_host_tools" | "set_host_uri_schemes" | "set_subagent_subscription" }
>;
export type RpcReadCommand = Exclude<RpcCommand, RpcMutationCommand>;

type RpcCommandClassificationCoverage =
	| Exclude<RpcCommand["type"], RpcCommandType>
	| Exclude<RpcCommandType, RpcCommand["type"]>;
const rpcCommandClassificationCoverage: RpcCommandClassificationCoverage extends never ? true : false = true;
void rpcCommandClassificationCoverage;

export function isRpcMutationContext(value: unknown): value is RpcMutationContext {
	return (
		isRecord(value) &&
		typeof value.commandId === "string" &&
		value.commandId.length > 0 &&
		value.commandId.isWellFormed() &&
		Buffer.byteLength(value.commandId, "utf8") <= MAX_RPC_MUTATION_ID_LENGTH &&
		typeof value.runtimeId === "string" &&
		value.runtimeId.length > 0 &&
		value.runtimeId.isWellFormed() &&
		Buffer.byteLength(value.runtimeId, "utf8") <= MAX_RPC_MUTATION_ID_LENGTH &&
		typeof value.generation === "number" &&
		Number.isSafeInteger(value.generation) &&
		value.generation >= 0
	);
}

/** Canonical discriminator-only classification used by every RPC transport. */
export function isRpcMutationCommand(value: unknown): value is RpcMutationCommand {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	return RPC_COMMAND_CLASSIFICATION[value.type as RpcCommandType] === "mutation";
}

/** True for mutations whose outcomes can safely be persisted and replayed across processes. */
export function isRpcDurableMutationCommand(value: unknown): value is RpcDurableMutationCommand {
	return isRpcMutationCommand(value) && !RPC_CONNECTION_LOCAL_MUTATION_OPERATIONS[value.type];
}

/** Canonical discriminator-only read classification used by Collab routing. */
export function isRpcReadCommand(value: unknown): value is RpcReadCommand {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	return RPC_COMMAND_CLASSIFICATION[value.type as RpcCommandType] === "read";
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	tokensPerSecond: number | null;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: TodoPhase[];
	/** For session dump / export (plain-text parity with /dump). */
	systemPrompt?: string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	/** Current context window usage. */
	contextUsage?: ContextUsage;
}

export interface RpcAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface RpcAvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: RpcAvailableSlashCommand[];
}

export interface RpcPromptResultFrame {
	type: "prompt_result";
	id?: string;
	agentInvoked: boolean;
}

export interface RpcEndpointIdentity {
	/** Immutable build identity of the process accepting commands. */
	buildId: string;
	/** Exact OMP package version of the process accepting commands. */
	version: string;
	protocolVersion: 1;
	supportedProtocolVersions: readonly [1, 2];
	capabilities: readonly string[];
}

export function isRpcEndpointIdentity(value: unknown): value is RpcEndpointIdentity {
	return (
		isRecord(value) &&
		typeof value.buildId === "string" &&
		typeof value.version === "string" &&
		value.protocolVersion === 1 &&
		Array.isArray(value.supportedProtocolVersions) &&
		value.supportedProtocolVersions.length === 2 &&
		value.supportedProtocolVersions[0] === 1 &&
		value.supportedProtocolVersions[1] === 2 &&
		Array.isArray(value.capabilities) &&
		value.capabilities.every(capability => typeof capability === "string")
	);
}

export interface RpcReadyFrame extends RpcEndpointIdentity {
	type: "ready";
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
	/** Authoritative Collab participant identity for a replica-backed endpoint. */
	participant?: Participant;
}

export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

export interface RpcHandoffResult {
	savedPath?: string;
}

export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface RpcSubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: AgentProgress["agentSource"];
	description?: string;
	status: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: AgentProgress;
	parentToolCallId?: string;
}

export interface RpcSubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
type RpcResponsePayload =
	// Protocol
	| {
			id?: string;
			type: "response";
			command: "negotiate_protocol";
			success: true;
			data: { protocolVersion: 2 };
	  }

	// Prompting (async - events follow)
	| {
			id?: string;
			type: "response";
			command: "prompt";
			success: true;
			data?: { agentInvoked: boolean };
	  }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "abort_and_prompt"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "custom_message"; success: true; data: RpcCustomMessageResult }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| {
			id?: string;
			type: "response";
			command: "set_fast_mode";
			success: true;
			data: { enabled: boolean; active: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_commands";
			success: true;
			data: { commands: RpcAvailableSlashCommand[] };
	  }
	| { id?: string; type: "response"; command: "set_todos"; success: true; data: { todoPhases: TodoPhase[] } }
	| { id?: string; type: "response"; command: "set_host_tools"; success: true; data: { toolNames: string[] } }
	| { id?: string; type: "response"; command: "set_host_uri_schemes"; success: true; data: { schemes: string[] } }
	| {
			id?: string;
			type: "response";
			command: "set_subagent_subscription";
			success: true;
			data: { level: RpcSubagentSubscriptionLevel };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagents";
			success: true;
			data: { subagents: RpcSubagentSnapshot[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagent_messages";
			success: true;
			data: RpcSubagentMessagesResult;
	  }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: Effort } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "fork";
			success: true;
			data: { sessionId: string; cancelled: boolean };
	  }
	| { id?: string; type: "response"; command: "collab_ui_response"; success: true }
	| { id?: string; type: "response"; command: "artifact_list"; success: true; data: RpcArtifactListResult }
	| { id?: string; type: "response"; command: "artifact_read"; success: true; data: RpcArtifactReadResult }
	| { id?: string; type: "response"; command: "artifact_write"; success: true; data: RpcArtifactWriteResult }
	| { id?: string; type: "response"; command: "blob_list"; success: true; data: RpcBlobListResult }
	| { id?: string; type: "response"; command: "blob_read"; success: true; data: RpcBlobReadResult }
	| { id?: string; type: "response"; command: "blob_write"; success: true; data: RpcBlobWriteResult }
	| {
			id?: string;
			type: "response";
			command: "get_branch_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "handoff"; success: true; data: RpcHandoffResult | null }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| { id?: string; type: "response"; command: "get_messages_page"; success: true; data: RpcMessagesPage }
	| { id?: string; type: "response"; command: "history_snapshot"; success: true; data: RpcHistorySnapshot }
	| { id?: string; type: "response"; command: "history_page"; success: true; data: RpcHistoryPage }
	| { id?: string; type: "response"; command: "history_chunk"; success: true; data: RpcHistoryChunk }
	| { id?: string; type: "response"; command: "history_digest"; success: true; data: RpcHistoryDigest }

	// Login
	| {
			id?: string;
			type: "response";
			command: "get_login_providers";
			success: true;
			data: { providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }> };
	  }
	| { id?: string; type: "response"; command: "login"; success: true; data: { providerId: string } }

	// Error response (any command can fail); `code` is an optional machine-readable reason.
	| {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
			code?: string;
	  };

export type RpcResponse = RpcResponsePayload & { receipt?: RpcMutationReceipt };

/** A canonical command result whose publication may be deferred until its response is flushed. */
export interface RpcCommandDispatchResult {
	response: RpcResponse;
	afterResponse?: () => void | Promise<void>;
}

/** Per-dispatch authority owned by the exact private Collab host receiving a command. */
export interface RpcCanonicalDispatchContext {
	handleCollabUiResponse(
		command: Extract<RpcCommand, { type: "collab_ui_response" }>,
	): RpcResponse | Promise<RpcResponse>;
}

/** Shared authoritative dispatcher exposed by direct RPC mode to private Collab hosting. */
export interface RpcCanonicalAuthority {
	identity: RpcEndpointIdentity;
	dispatch(
		command: RpcCommand,
		context?: RpcCanonicalDispatchContext,
	): Promise<RpcResponse | RpcCommandDispatchResult>;
	dispatchControl(frame: unknown): boolean;
	subscribeOutput(listener: (output: object) => void): () => void;
}

// ============================================================================
// Subagent Events (stdout)
// ============================================================================

export interface RpcSubagentLifecycleFrame {
	type: "subagent_lifecycle";
	payload: SubagentLifecyclePayload;
}

export interface RpcSubagentProgressFrame {
	type: "subagent_progress";
	payload: SubagentProgressPayload;
}

export interface RpcSubagentEventFrame {
	type: "subagent_event";
	payload: SubagentEventPayload;
}

export type RpcSubagentFrame = RpcSubagentLifecycleFrame | RpcSubagentProgressFrame | RpcSubagentEventFrame;

/** Existing Collab host frames forwarded unchanged through the RPC composition. */
export type RpcCollabFrame = Extract<
	CollabFrame,
	{ t: "bus" | "agents" | "ui-request" | "ui-request-end" | "transcript" | "authority" | "bye" | "error" }
>;

export interface RpcCollabFrameEvent {
	type: "collab_frame";
	frame: RpcCollabFrame;
}

/** Authoritative terminal availability signal for a replica-backed RPC endpoint. */
export interface RpcCollabTerminalFrame {
	type: "collab_terminal";
	code: "unavailable";
	reason: string;
}

export type RpcSessionEventFrame = AgentSessionEvent | RpcSubagentFrame | RpcCollabFrameEvent | RpcCollabTerminalFrame;

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Positional presentation metadata for an RPC select option. */
export interface RpcExtensionUISelectOptionDetail {
	description?: string;
}

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| {
			id: string;
			type: "extension_ui_request";
			method: "select";
			title: string;
			options: string[];
			optionDetails?: RpcExtensionUISelectOptionDetail[];
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			/**
			 * Short loopback URL that 302-redirects to {@link url}. When present,
			 * hosts SHOULD surface it as the copy target so terminal viewport
			 * truncation cannot corrupt OAuth query parameters on the full URL.
			 */
			launchUrl?: string;
			instructions?: string;
	  };

// ============================================================================
// Host Tool Frames (bidirectional)
// ============================================================================

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
	/** How this host tool is presented when enabled; omission normalizes to `"discoverable"` at the adapter boundary. */
	loadMode?: ToolLoadMode;
}

/** Emitted by the RPC server when it needs the host to execute a registered tool. */
export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Emitted by the RPC server when a pending host tool call should be aborted. */
export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to stream partial tool updates back to the RPC server. */
export interface RpcHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: AgentToolResult<unknown>;
}

/** Sent by the host to complete a pending tool call. */
export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

// ============================================================================
// Host URI Frames (bidirectional)
// ============================================================================

export interface RpcHostUriSchemeDefinition {
	/** URL scheme without trailing `://` (e.g. `db`, `notion`). */
	scheme: string;
	/** Optional human-readable description for logs/diagnostics. */
	description?: string;
	/** When true, the write tool is allowed to dispatch writes to this scheme. */
	writable?: boolean;
	/** When true, downstream callers suppress hashline anchors for resolved content. */
	immutable?: boolean;
}

export type RpcHostUriOperation = "read" | "write";

/** Emitted by the RPC server when it needs the host to satisfy a URI operation. */
export interface RpcHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: RpcHostUriOperation;
	url: string;
	/** Present for write operations. */
	content?: string;
}

/** Emitted by the RPC server when a pending URI request should be aborted. */
export interface RpcHostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to complete a pending URI request. */
export interface RpcHostUriResult {
	type: "host_uri_result";
	id: string;
	/**
	 * Required for successful `read` results. Ignored for `write` success.
	 * Set on errors when a textual explanation accompanies `isError`.
	 */
	content?: string;
	/** Defaults to `text/plain` when omitted. */
	contentType?: "text/markdown" | "application/json" | "text/plain";
	/** Optional resolution notes propagated to the read tool. */
	notes?: string[];
	/** Overrides the scheme-level `immutable` flag for this single resolution. */
	immutable?: boolean;
	/** When true, surface the result content as an error to the caller. */
	isError?: boolean;
	/** Optional error message; preferred over `content` for error surfacing. */
	error?: string;
}

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

/** Direct one-use bridge tuple redeemed by agentd for an OMP-owned Herdr host route. */
export interface RpcHerdrAgentdHostBridge {
	address: string;
	paneId: string;
	routeGeneration: number;
	token: string;
}

/** One-use credential provision for the next committed agentd-owned Herdr session route. */
export interface RpcPrepareHerdrAgentdRebindFrame extends RpcHerdrAgentdHostBridge {
	type: "prepare_herdr_agentd_rebind";
}

/** Explicitly discard any staged agentd-owned Herdr successor route. */
export interface RpcClearHerdrAgentdRebindFrame {
	type: "clear_herdr_agentd_rebind";
}

export type RpcHerdrAgentdRebindControlFrame = RpcPrepareHerdrAgentdRebindFrame | RpcClearHerdrAgentdRebindFrame;

/** True for the two dedicated Herdr rebind control discriminators, even when malformed. */
export function isRpcHerdrAgentdRebindControl(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return value.type === "prepare_herdr_agentd_rebind" || value.type === "clear_herdr_agentd_rebind";
}

/** Structural guard for a valid dedicated Herdr rebind control frame. */
export function isRpcHerdrAgentdRebindControlFrame(value: unknown): value is RpcHerdrAgentdRebindControlFrame {
	if (!isRecord(value)) return false;
	if (value.type === "clear_herdr_agentd_rebind") return true;
	return (
		value.type === "prepare_herdr_agentd_rebind" &&
		typeof value.address === "string" &&
		typeof value.paneId === "string" &&
		typeof value.routeGeneration === "number" &&
		typeof value.token === "string"
	);
}

/** Client-to-agent side-channel frames that may overtake serialized commands. */
export type RpcControlFrame =
	| RpcExtensionUIResponse
	| RpcHostToolResult
	| RpcHostToolUpdate
	| RpcHostUriResult
	| RpcHerdrAgentdRebindControlFrame;
