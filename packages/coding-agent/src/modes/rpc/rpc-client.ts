/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import type { AgentEvent, AgentMessage, AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { isRecord, ptree, readJsonl } from "@oh-my-pi/pi-utils";
import type { CollabUiResponseValue } from "@oh-my-pi/pi-wire";
import { validateHerdrBridgeAddress } from "../../collab/agentd-local-transport";
import type { BashResult } from "../../exec/bash-executor";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameDecoder, type RpcProtocolVersion } from "./rpc-frame";
import type {
	RpcHistoryChunk,
	RpcHistoryChunkOptions,
	RpcHistoryDigest,
	RpcHistoryPage,
	RpcHistoryPageOptions,
	RpcHistorySnapshot,
} from "./rpc-history";
import {
	RPC_MESSAGES_PAGE_BUSY_ERROR,
	RPC_MESSAGES_PAGE_STALE_ERROR,
	type RpcMessagesPage,
	type RpcMessagesPageOptions,
} from "./rpc-messages";
import type {
	RpcArtifactListResult,
	RpcArtifactReadResult,
	RpcArtifactWriteResult,
	RpcBlobListResult,
	RpcBlobReadResult,
	RpcBlobWriteResult,
	RpcCustomMessagePayload,
	RpcCustomMessageResult,
} from "./rpc-session-data";
import type {
	RpcAvailableCommandsUpdateFrame,
	RpcAvailableSlashCommand,
	RpcCollabFrame,
	RpcCollabTerminalFrame,
	RpcCommand,
	RpcCommandInput,
	RpcControlFrame,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHandoffResult,
	RpcHerdrAgentdHostBridge,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcHostUriSchemeDefinition,
	RpcMutationContext,
	RpcMutationReceipt,
	RpcPrepareHerdrAgentdRebindFrame,
	RpcReadyFrame,
	RpcResponse,
	RpcSessionState,
	RpcSubagentEventFrame,
	RpcSubagentLifecycleFrame,
	RpcSubagentMessagesResult,
	RpcSubagentProgressFrame,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";
import { isRpcDurableMutationCommand, isRpcEndpointIdentity, RPC_HERDR_AGENTD_HOST_CAPABILITY } from "./rpc-types";

/** Process transport consumed by {@link RpcClient}. */
export interface RpcAgentProcess {
	stdin: {
		write(data: string | Uint8Array): unknown;
		flush?(): unknown;
	};
	stdout: ReadableStream<Uint8Array>;
	peekStderr(): string;
	kill(signal?: Parameters<ptree.ChildProcess["kill"]>[0], graceMs?: number): void;
	exited: Promise<number>;
}

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Complete executable command to run instead of the default `bun <cliPath> --mode rpc`. */
	launchCommand?: readonly string[];
	/**
	 * Agent launcher override. An argv prefix receives normal RPC/model args;
	 * a builder receives those args and returns the complete argv.
	 * Ignored when {@link spawn} or {@link launchCommand} is provided.
	 */
	command?: string[] | ((agentArgs: string[]) => string[]);
	/** Spawn the RPC agent over a custom transport instead of a local child process. */
	spawn?: (agentArgs: string[]) => RpcAgentProcess | Promise<RpcAgentProcess>;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Session directory for the agent */
	sessionDir?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** Grace period before escalating process termination (default: process utility default, 1000ms) */
	terminationGraceMs?: number;
	/** Custom tools owned by the embedding host and exposed over the RPC transport */
	customTools?: RpcClientCustomTool[];
	/** Already-redeemed direct tuple for the single-runtime `__collab-rpc-host` composition. */
	herdrAgentdHost?: RpcHerdrAgentdHostBridge;
}

export interface RpcPromptOptions {
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
}

export interface RpcDurablePromptOptions extends RpcPromptOptions {
	mutation: RpcMutationContext;
	/** Exact active tool name for this prompt's first model call. */
	toolChoice?: string;
}

export interface RpcForkAtEntryOptions {
	entryId: string;
	mutation: RpcMutationContext;
}

export type ModelInfo = Pick<Model, "provider" | "id" | "contextWindow" | "reasoning" | "thinking">;

export type RpcEventListener = (event: AgentEvent) => void;
export type RpcSessionEventListener = (event: AgentSessionEvent) => void;
export type RpcSubagentLifecycleListener = (payload: RpcSubagentLifecycleFrame["payload"]) => void;
export type RpcSubagentProgressListener = (payload: RpcSubagentProgressFrame["payload"]) => void;
export type RpcSubagentEventListener = (payload: RpcSubagentEventFrame["payload"]) => void;
export type RpcAvailableCommandsUpdateListener = (commands: RpcAvailableSlashCommand[]) => void;
export type RpcCollabFrameListener = (frame: RpcCollabFrame) => void;
export type RpcUnavailableListener = (frame: RpcCollabTerminalFrame) => void;
export type RpcExtensionUIRequestListener = (request: RpcExtensionUIRequest) => void;
export type RpcHostToolCallListener = (request: RpcHostToolCallRequest) => void;
export type RpcHostToolCancelListener = (request: RpcHostToolCancelRequest) => void;
export type RpcHostUriRequestListener = (request: RpcHostUriRequest) => void;
export type RpcHostUriCancelListener = (request: RpcHostUriCancelRequest) => void;

export interface RpcClientToolContext<TDetails = unknown> {
	toolCallId: string;
	signal: AbortSignal;
	sendUpdate(partialResult: RpcClientToolResult<TDetails>): void;
}

export type RpcClientToolResult<TDetails = unknown> = AgentToolResult<TDetails> | string;

export interface RpcClientCustomTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
> extends Omit<RpcHostToolDefinition, "parameters"> {
	parameters: Record<string, unknown>;
	execute(
		params: TParams,
		context: RpcClientToolContext<TDetails>,
	): Promise<RpcClientToolResult<TDetails>> | RpcClientToolResult<TDetails>;
}

export function defineRpcClientTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
>(tool: RpcClientCustomTool<TParams, TDetails>): RpcClientCustomTool<TParams, TDetails> {
	return tool;
}

const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_stream_update",
	"tool_execution_end",
]);

const sessionEventTypes = new Set<AgentSessionEvent["type"]>([
	...agentEventTypes,
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"advisor_yielded",
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"model_changed",
	"goal_updated",
]);

function validateLaunchCommand(command: unknown): string[] {
	if (
		!Array.isArray(command) ||
		command.length === 0 ||
		typeof command[0] !== "string" ||
		command[0].trim().length === 0
	) {
		throw new Error("RpcClient launchCommand must contain a non-empty executable");
	}
	if (command.some(argument => typeof argument !== "string")) {
		throw new Error("RpcClient launchCommand must contain only strings");
	}
	return [...command];
}

function validateHerdrAgentdHostBridge(value: RpcHerdrAgentdHostBridge): RpcHerdrAgentdHostBridge {
	if (process.platform === "win32") {
		throw new Error("RpcClient herdrAgentdHost is unavailable on Windows");
	}
	try {
		validateHerdrBridgeAddress(value.address);
	} catch {
		throw new Error("RpcClient herdrAgentdHost address is invalid");
	}
	if (
		!value.paneId ||
		value.paneId.trim() !== value.paneId ||
		value.paneId.includes("\0") ||
		value.paneId.length > 256
	) {
		throw new Error("RpcClient herdrAgentdHost paneId is invalid");
	}
	if (!Number.isSafeInteger(value.routeGeneration) || value.routeGeneration < 1) {
		throw new Error("RpcClient herdrAgentdHost routeGeneration must be a positive integer");
	}
	if (!value.token || value.token.trim() !== value.token || value.token.includes("\0")) {
		throw new Error("RpcClient herdrAgentdHost token is invalid");
	}
	return { ...value };
}

function buildHerdrAgentdRebindFrame(input: RpcHerdrAgentdHostBridge): RpcPrepareHerdrAgentdRebindFrame {
	const bridge = validateHerdrAgentdHostBridge(input);
	if (bridge.routeGeneration !== 1) {
		throw new Error("RpcClient Herdr agentd successor routeGeneration must be 1");
	}
	return { type: "prepare_herdr_agentd_rebind", ...bridge };
}

function redactSecretError(error: unknown, ...secrets: Array<string | undefined>): Error {
	const original = error instanceof Error ? error : new Error(String(error));
	let message = original.message;
	for (const secret of secrets) {
		if (secret) message = message.split(secret).join("[REDACTED]");
	}
	return message === original.message && original.cause === undefined ? original : new Error(message);
}

function isRpcResponse(value: unknown): value is RpcResponse {
	if (!isRecord(value)) return false;
	if (value.type !== "response") return false;
	if (typeof value.command !== "string") return false;
	if (typeof value.success !== "boolean") return false;
	if (value.id !== undefined && typeof value.id !== "string") return false;
	if (value.success === false) {
		return typeof value.error === "string";
	}
	return true;
}

function supportsRpcProtocolV2(value: RpcReadyFrame): boolean {
	return (
		value.type === "ready" &&
		Array.isArray(value.supportedProtocolVersions) &&
		value.supportedProtocolVersions.includes(2) &&
		value.maxFrameBytes === MAX_RPC_FRAME_BYTES &&
		value.maxReassembledFrameBytes === MAX_RPC_REASSEMBLED_BYTES
	);
}

function isRpcReadyFrame(value: unknown): value is RpcReadyFrame {
	if (!isRecord(value) || !isRpcEndpointIdentity(value)) return false;
	return (
		value.type === "ready" &&
		typeof value.maxFrameBytes === "number" &&
		typeof value.maxReassembledFrameBytes === "number" &&
		(value.participant === undefined ||
			(isRecord(value.participant) &&
				typeof value.participant.name === "string" &&
				(value.participant.role === "host" || value.participant.role === "guest") &&
				(value.participant.readOnly === undefined || typeof value.participant.readOnly === "boolean")))
	);
}

function isAgentEvent(value: unknown): value is AgentEvent {
	if (!isRecord(value)) return false;
	const type = value.type;
	if (typeof type !== "string") return false;
	return agentEventTypes.has(type as AgentEvent["type"]);
}

function isAgentSessionEvent(value: unknown): value is AgentSessionEvent {
	if (!isRecord(value)) return false;
	const type = value.type;
	if (typeof type !== "string") return false;
	return sessionEventTypes.has(type as AgentSessionEvent["type"]);
}

function isRpcSubagentLifecycleFrame(value: unknown): value is RpcSubagentLifecycleFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_lifecycle" && isRecord(value.payload);
}

function isRpcSubagentProgressFrame(value: unknown): value is RpcSubagentProgressFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_progress" && isRecord(value.payload);
}

function isRpcSubagentEventFrame(value: unknown): value is RpcSubagentEventFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_event" && isRecord(value.payload);
}

function isRpcAvailableCommandsUpdateFrame(value: unknown): value is RpcAvailableCommandsUpdateFrame {
	if (!isRecord(value)) return false;
	return value.type === "available_commands_update" && Array.isArray(value.commands);
}

function isRpcCollabFrameEvent(value: unknown): value is { type: "collab_frame"; frame: RpcCollabFrame } {
	return (
		isRecord(value) && value.type === "collab_frame" && isRecord(value.frame) && typeof value.frame.t === "string"
	);
}

function isRpcCollabTerminalFrame(value: unknown): value is RpcCollabTerminalFrame {
	return (
		isRecord(value) &&
		value.type === "collab_terminal" &&
		value.code === "unavailable" &&
		typeof value.reason === "string"
	);
}

function isRpcHostToolCallRequest(value: unknown): value is RpcHostToolCallRequest {
	if (!isRecord(value)) return false;
	return (
		value.type === "host_tool_call" &&
		typeof value.id === "string" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		isRecord(value.arguments)
	);
}

function isRpcHostToolCancelRequest(value: unknown): value is RpcHostToolCancelRequest {
	if (!isRecord(value)) return false;
	return value.type === "host_tool_cancel" && typeof value.id === "string" && typeof value.targetId === "string";
}

function isRpcHostUriRequest(value: unknown): value is RpcHostUriRequest {
	if (!isRecord(value)) return false;
	return (
		value.type === "host_uri_request" &&
		typeof value.id === "string" &&
		(value.operation === "read" || value.operation === "write") &&
		typeof value.url === "string"
	);
}

function isRpcHostUriCancelRequest(value: unknown): value is RpcHostUriCancelRequest {
	if (!isRecord(value)) return false;
	return value.type === "host_uri_cancel" && typeof value.id === "string" && typeof value.targetId === "string";
}

function isRpcExtensionUiRequest(value: unknown): value is RpcExtensionUIRequest {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_request" && typeof value.id === "string" && typeof value.method === "string";
}

function normalizeToolResult<TDetails>(result: RpcClientToolResult<TDetails>): AgentToolResult<TDetails> {
	if (typeof result === "string") {
		return {
			content: [{ type: "text", text: result }],
		};
	}
	return result;
}

/** Failed RPC command; `code` mirrors the server's machine-readable error code when present. */
export class RpcCommandError extends Error {
	constructor(
		message: string,
		readonly command: string,
		readonly code?: string,
		readonly receipt?: RpcMutationReceipt,
	) {
		super(message);
		this.name = "RpcCommandError";
	}
}

/** True when a high-level `getMessages()` drain should discard partial pages and fall back to `get_messages`. */
function isPageFallbackError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error instanceof RpcCommandError && (error.code === "session_busy" || error.code === "stale_cursor"))
		return true;
	return error.message === RPC_MESSAGES_PAGE_BUSY_ERROR || error.message === RPC_MESSAGES_PAGE_STALE_ERROR;
}

// ============================================================================
// RPC Client
// ============================================================================

interface PendingRpcRequest {
	command: RpcCommand["type"];
	durableMutation: boolean;
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
}

function transportLossError(request: PendingRpcRequest, error: Error): Error {
	if (!request.durableMutation) return error;
	return new RpcCommandError(
		`RPC mutation may have executed before transport loss: ${error.message}`,
		request.command,
		"ambiguous",
	);
}

export class RpcClient {
	#process: RpcAgentProcess | null = null;
	#reaping: Promise<void> | null = null;
	#eventListeners: RpcEventListener[] = [];
	#sessionEventListeners: RpcSessionEventListener[] = [];
	#subagentLifecycleListeners = new Set<RpcSubagentLifecycleListener>();
	#subagentProgressListeners = new Set<RpcSubagentProgressListener>();
	#subagentEventListeners = new Set<RpcSubagentEventListener>();
	#availableCommandsUpdateListeners = new Set<RpcAvailableCommandsUpdateListener>();
	#collabFrameListeners = new Set<RpcCollabFrameListener>();
	#unavailableListeners = new Set<RpcUnavailableListener>();
	#pendingRequests = new Map<string, PendingRpcRequest>();
	#customTools: RpcClientCustomTool[] = [];
	#pendingHostToolCalls = new Map<string, { controller: AbortController }>();
	#requestId = 0;
	#protocolVersion: RpcProtocolVersion = 1;
	#extensionUiListeners: Set<RpcExtensionUIRequestListener> = new Set();
	#hostToolCallListeners = new Set<RpcHostToolCallListener>();
	#hostToolCancelListeners = new Set<RpcHostToolCancelListener>();
	#hostUriRequestListeners = new Set<RpcHostUriRequestListener>();
	#hostUriCancelListeners = new Set<RpcHostUriCancelListener>();
	#pendingHostUriRequests = new Set<string>();
	#abortController = new AbortController();
	#ready: RpcReadyFrame | undefined;
	#unavailable: RpcCollabTerminalFrame | undefined;
	#herdrAgentdRebindTokens: string[] = [];

	constructor(private options: RpcClientOptions = {}) {
		this.#customTools = [...(options.customTools ?? [])];
	}

	/**
	 * Start the RPC agent process.
	 *
	 * Safe to call again after {@link stop} on the same instance: a fresh
	 * {@link AbortController} is minted for each start, and any failure after
	 * the child spawn kills the child and clears internal state so callers may
	 * retry without leaking processes.
	 */
	async start(): Promise<void> {
		await this.#reaping;
		if (this.#process) {
			throw new Error("Client already started");
		}

		// Mint a fresh controller so a previous stop()'s abort does not
		// short-circuit the new stdout reader (issue #4079).
		this.#abortController = new AbortController();
		this.#ready = undefined;
		this.#unavailable = undefined;
		this.#pendingHostUriRequests.clear();
		this.#protocolVersion = 1;
		this.#herdrAgentdRebindTokens = [];

		const herdrAgentdHost = this.options.herdrAgentdHost
			? validateHerdrAgentdHostBridge(this.options.herdrAgentdHost)
			: undefined;
		const args: string[] = [];
		if (this.options.provider) args.push("--provider", this.options.provider);
		if (this.options.model) args.push("--model", this.options.model);
		if (this.options.sessionDir) args.push("--session-dir", this.options.sessionDir);
		if (this.options.args) args.push(...this.options.args);

		const environment: Record<string, string | undefined> = { ...Bun.env, ...this.options.env };
		if (herdrAgentdHost) {
			delete environment.HERDR_SOCKET_PATH;
			delete environment.HERDR_OMP_GUEST_BRIDGE_TOKEN;
			environment.HERDR_OMP_BRIDGE = herdrAgentdHost.address;
			environment.HERDR_OMP_BRIDGE_TOKEN = herdrAgentdHost.token;
			environment.HERDR_PANE_ID = herdrAgentdHost.paneId;
			environment.HERDR_OMP_ROUTE_GENERATION = String(herdrAgentdHost.routeGeneration);
		}

		let child: RpcAgentProcess;
		try {
			if (this.options.spawn) {
				child = await this.options.spawn([...(herdrAgentdHost ? [] : ["--mode", "rpc"]), ...args]);
			} else {
				const cliPath = this.options.cliPath ?? "dist/cli.js";
				const launchCommand = this.options.launchCommand
					? validateLaunchCommand(this.options.launchCommand)
					: undefined;
				if (herdrAgentdHost && launchCommand && !launchCommand.includes("__collab-rpc-host")) {
					throw new Error("RpcClient herdrAgentdHost requires the __collab-rpc-host launch command");
				}
				let command: string[];
				if (launchCommand) {
					command = [...launchCommand, ...args];
				} else if (herdrAgentdHost) {
					command = ["bun", cliPath, "__collab-rpc-host", ...args];
				} else {
					const agentArgs = ["--mode", "rpc", ...args];
					command =
						typeof this.options.command === "function"
							? this.options.command(agentArgs)
							: [...(this.options.command ?? ["bun", cliPath]), ...agentArgs];
				}
				child = ptree.spawn(command, { cwd: this.options.cwd, env: environment, stdin: "pipe" });
			}
		} catch (error) {
			throw redactSecretError(error, herdrAgentdHost?.token);
		}
		this.#process = child;

		// Wait for the "ready" signal or process exit
		const { promise: readyPromise, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();
		let readySettled = false;
		let protocolV2Supported = false;
		let protocolV2Enabled = false;
		const frameDecoder = new RpcFrameDecoder();

		const reapAfterOutputFailure = async (error: Error) => {
			if (this.#process !== child) return;

			this.#process = null;
			this.#herdrAgentdRebindTokens = [];
			this.#abortController.abort(error);
			const pendingRequests = Array.from(this.#pendingRequests.values());
			this.#pendingRequests.clear();
			this.#pendingHostUriRequests.clear();
			for (const pendingCall of this.#pendingHostToolCalls.values()) pendingCall.controller.abort(error);
			this.#pendingHostToolCalls.clear();

			try {
				child.kill(undefined, this.options.terminationGraceMs);
			} catch {
				// The process may already have exited.
			}
			await this.#waitForExit(child);
			for (const request of pendingRequests) request.reject(transportLossError(request, error));
		};

		// Process lines in background, intercepting the ready signal.
		const lines = readJsonl(child.stdout, this.#abortController.signal);
		void (async () => {
			for await (const line of lines) {
				if (!readySettled && isRecord(line) && line.type === "ready") {
					if (!isRpcReadyFrame(line)) {
						throw new RpcCommandError(
							"RPC ready frame is missing required identity or capability fields",
							"ready",
							"protocol-error",
						);
					}
					if (herdrAgentdHost && !line.capabilities.includes(RPC_HERDR_AGENTD_HOST_CAPABILITY)) {
						throw new RpcCommandError(
							"RPC host composition did not advertise the required Herdr capability",
							"ready",
							"protocol-error",
						);
					}
					this.#ready = line;
					protocolV2Supported = supportsRpcProtocolV2(line);
					readySettled = true;
					readyResolve();
					continue;
				}
				if (isRecord(line) && line.type === "rpc_chunk" && !protocolV2Enabled)
					throw new Error("RPC chunk received before protocol negotiation");
				const decoded = frameDecoder.push(line);
				if (decoded) this.#handleLine(decoded);
			}
			// A closed stdout is terminal even if the child remains alive. Startup
			// failures are reaped by the readyPromise catch below; established
			// workers are reaped here so pending requests cannot hang indefinitely.
			if (!readySettled) {
				// Stdout can close before the exit reaper finishes draining stderr.
				// child.exited settles only after the stderr tail is complete (for
				// nonzero exits), so give it a bounded head start: the exit watcher
				// below was registered first and rejects with the real stderr text
				// instead of an empty "Stderr:" (flaked under full-suite load).
				await Promise.race([child.exited.catch(() => {}), Bun.sleep(250)]);
				if (readySettled) return;
				readySettled = true;
				readyReject(new Error(`Agent output stream ended before ready. Stderr: ${child.peekStderr()}`));
				return;
			}
			const exitResult = await Promise.race([
				child.exited.then(
					exitCode => ({ exitCode }),
					cause => ({ cause }),
				),
				Bun.sleep(100).then(() => null),
			]);
			const error = this.#unavailable
				? new RpcCommandError(this.#unavailable.reason, "collab", "unavailable")
				: exitResult === null
					? new Error(`Agent output stream ended unexpectedly. Stderr: ${child.peekStderr()}`)
					: "exitCode" in exitResult
						? new Error(`Agent process exited with code ${exitResult.exitCode}. Stderr: ${child.peekStderr()}`)
						: new Error(`Agent output stream ended. Stderr: ${child.peekStderr()}`, {
								cause: exitResult.cause,
							});
			await reapAfterOutputFailure(error);
		})().catch(async (cause: unknown) => {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			if (!readySettled) {
				readySettled = true;
				readyReject(error);
				return;
			}
			await reapAfterOutputFailure(
				this.#unavailable
					? new RpcCommandError(this.#unavailable.reason, "collab", "unavailable")
					: new Error(`Agent output reader failed: ${error.message}`, { cause: error }),
			);
		});

		// Also race against process exit (in case stdout closes before we read it)
		void child.exited.then(
			(exitCode: number) => {
				if (readySettled) return;
				readySettled = true;
				readyReject(new Error(`Agent process exited with code ${exitCode}. Stderr: ${child.peekStderr()}`));
			},
			(err: Error) => {
				// Killed or reaped without an exit code (e.g. stop() during
				// startup); surface it instead of leaking an unhandled rejection.
				if (readySettled) return;
				readySettled = true;
				readyReject(new Error(`Agent process exited before ready. Stderr: ${child.peekStderr()}`, { cause: err }));
			},
		);

		// Timeout to prevent hanging forever
		const readyTimeout = this.#startTimeout(30000, () => {
			if (readySettled) return;
			readySettled = true;
			readyReject(new Error(`Timeout waiting for agent to become ready. Stderr: ${child.peekStderr()}`));
		});

		try {
			await readyPromise;
			if (protocolV2Supported) {
				protocolV2Enabled = true;
				const response = await this.#send({ type: "negotiate_protocol", protocolVersion: 2 });
				if (
					!response.success ||
					response.command !== "negotiate_protocol" ||
					!isRecord(response.data) ||
					response.data.protocolVersion !== 2
				)
					throw new Error("RPC protocol v2 negotiation failed");
				this.#protocolVersion = 2;
			}
			if (this.#customTools.length > 0) {
				await this.setCustomTools(this.#customTools);
			}
		} catch (cause) {
			// Startup failed after spawning the child. Reap it before returning
			// so a retry cannot inherit a live worker or its session lock.
			const error = redactSecretError(cause, herdrAgentdHost?.token);
			await reapAfterOutputFailure(error);
			throw error;
		} finally {
			clearTimeout(readyTimeout);
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	stop(): Promise<void> {
		this.#herdrAgentdRebindTokens = [];
		if (!this.#process) return this.#reaping ?? Promise.resolve();

		const error = new Error("Client stopped");
		const child = this.#process;
		this.#pendingHostUriRequests.clear();
		child.kill(undefined, this.options.terminationGraceMs);
		this.#abortController.abort(error);
		this.#process = null;
		for (const request of this.#pendingRequests.values()) request.reject(transportLossError(request, error));
		this.#pendingRequests.clear();
		for (const pendingCall of this.#pendingHostToolCalls.values()) {
			pendingCall.controller.abort(error);
		}
		this.#pendingHostToolCalls.clear();
		return this.#waitForExit(child);
	}

	/**
	 * Stop the RPC agent process and clean up resources.
	 */
	[Symbol.dispose](): void {
		void this.stop();
	}

	#waitForExit(child: RpcAgentProcess): Promise<void> {
		const reaping = child.exited.then(
			() => {},
			() => {},
		);
		this.#reaping = reaping;
		void reaping.then(() => {
			if (this.#reaping === reaping) this.#reaping = null;
		});
		return reaping;
	}

	/** Immutable identity and capabilities received from the server's ready frame. */
	get ready(): RpcReadyFrame | undefined {
		return this.#ready;
	}

	/** Terminal authoritative availability state, when a replica-backed endpoint has closed. */
	get unavailable(): RpcCollabTerminalFrame | undefined {
		return this.#unavailable;
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.#eventListeners.push(listener);
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to all top-level session events, including non-core session state events.
	 */
	onSessionEvent(listener: RpcSessionEventListener): () => void {
		this.#sessionEventListeners.push(listener);
		return () => {
			const index = this.#sessionEventListeners.indexOf(listener);
			if (index !== -1) {
				this.#sessionEventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to subagent lifecycle frames after setSubagentSubscription("progress" | "events").
	 */
	onSubagentLifecycle(listener: RpcSubagentLifecycleListener): () => void {
		this.#subagentLifecycleListeners.add(listener);
		return () => this.#subagentLifecycleListeners.delete(listener);
	}

	/**
	 * Subscribe to aggregated subagent progress frames after setSubagentSubscription("progress" | "events").
	 */
	onSubagentProgress(listener: RpcSubagentProgressListener): () => void {
		this.#subagentProgressListeners.add(listener);
		return () => this.#subagentProgressListeners.delete(listener);
	}

	/**
	 * Subscribe to raw subagent session events. Call setSubagentSubscription(\"events\") to enable them server-side.
	 */
	onSubagentEvent(listener: RpcSubagentEventListener): () => void {
		this.#subagentEventListeners.add(listener);
		return () => this.#subagentEventListeners.delete(listener);
	}

	/**
	 * Subscribe to slash-command availability updates emitted by the RPC server.
	 */
	onAvailableCommandsUpdate(listener: RpcAvailableCommandsUpdateListener): () => void {
		this.#availableCommandsUpdateListeners.add(listener);
		return () => this.#availableCommandsUpdateListeners.delete(listener);
	}

	/** Subscribe to authoritative Collab host frames forwarded by a replica-backed RPC endpoint. */
	onCollabFrame(listener: RpcCollabFrameListener): () => void {
		this.#collabFrameListeners.add(listener);
		return () => this.#collabFrameListeners.delete(listener);
	}

	/** Subscribe to extension UI and permission requests emitted by the RPC server. */
	onExtensionUIRequest(listener: RpcExtensionUIRequestListener): () => void {
		this.#extensionUiListeners.add(listener);
		return () => this.#extensionUiListeners.delete(listener);
	}

	/**
	 * Subscribe to raw host-tool call frames. When at least one listener is
	 * registered, it takes precedence over `customTools` for new calls.
	 */
	onHostToolCall(listener: RpcHostToolCallListener): () => void {
		this.#hostToolCallListeners.add(listener);
		return () => this.#hostToolCallListeners.delete(listener);
	}

	/** Subscribe to raw host-tool cancellation frames. */
	onHostToolCancel(listener: RpcHostToolCancelListener): () => void {
		this.#hostToolCancelListeners.add(listener);
		return () => this.#hostToolCancelListeners.delete(listener);
	}

	/** Subscribe to raw host-URI request frames. */
	onHostUriRequest(listener: RpcHostUriRequestListener): () => void {
		this.#hostUriRequestListeners.add(listener);
		return () => this.#hostUriRequestListeners.delete(listener);
	}

	/** Subscribe to raw host-URI cancellation frames. */
	onHostUriCancel(listener: RpcHostUriCancelListener): () => void {
		this.#hostUriCancelListeners.add(listener);
		return () => this.#hostUriCancelListeners.delete(listener);
	}

	/** Subscribe to authoritative replica endpoint closure. */
	onUnavailable(listener: RpcUnavailableListener): () => void {
		this.#unavailableListeners.add(listener);
		return () => this.#unavailableListeners.delete(listener);
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.#process?.peekStderr() ?? "";
	}

	/**
	 * Send one canonical RPC command and return its validated raw response.
	 * Transport request IDs are assigned by this client.
	 */
	request(command: RpcCommandInput, timeout?: number | null): Promise<RpcResponse> {
		return this.#send(command, timeout);
	}

	#startTimeout(timeoutMs: number, onTimeout: () => void): NodeJS.Timeout {
		const timer = setTimeout(onTimeout, timeoutMs);
		timer.unref();
		return timer;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent. Legacy calls return after dispatch; calls with
	 * mutation provenance resolve only after the durable terminal receipt exists.
	 * Use onEvent() to receive streaming events.
	 */
	prompt(message: string, options: RpcDurablePromptOptions): Promise<RpcMutationReceipt>;
	prompt(message: string, options?: RpcPromptOptions): Promise<void>;
	prompt(message: string, images?: ImageContent[]): Promise<void>;
	prompt(
		message: string,
		images: ImageContent[] | undefined,
		mutation: RpcMutationContext,
	): Promise<RpcMutationReceipt>;
	async prompt(
		message: string,
		imagesOrOptions?: ImageContent[] | RpcPromptOptions | RpcDurablePromptOptions,
		legacyMutation?: RpcMutationContext,
	): Promise<void | RpcMutationReceipt> {
		const options = Array.isArray(imagesOrOptions) ? undefined : imagesOrOptions;
		const images = Array.isArray(imagesOrOptions) ? imagesOrOptions : options?.images;
		const durableOptions = options && "mutation" in options ? (options as RpcDurablePromptOptions) : undefined;
		const mutation = legacyMutation ?? durableOptions?.mutation;
		const toolChoice = durableOptions?.toolChoice;
		const receipt = this.#getMutationReceipt(
			await this.#send(
				{ type: "prompt", message, images, mutation, toolChoice, streamingBehavior: options?.streamingBehavior },
				mutation ? null : 30_000,
			),
		);
		if (mutation && !receipt)
			throw new RpcCommandError("Prompt response omitted its durable receipt", "prompt", "protocol-error");
		return receipt;
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	abort(): Promise<void>;
	abort(mutation: RpcMutationContext): Promise<RpcMutationReceipt>;
	async abort(mutation?: RpcMutationContext): Promise<void | RpcMutationReceipt> {
		const receipt = this.#getMutationReceipt(await this.#send({ type: "abort", mutation }, mutation ? null : 30_000));
		if (mutation && !receipt)
			throw new RpcCommandError("Abort response omitted its durable receipt", "abort", "protocol-error");
		return receipt;
	}

	/** Answer an authoritative Collab UI request forwarded by a replica-backed endpoint. */
	respondToCollabUi(reqId: number, value?: CollabUiResponseValue): Promise<void>;
	respondToCollabUi(
		reqId: number,
		value: CollabUiResponseValue | undefined,
		mutation: RpcMutationContext,
	): Promise<RpcMutationReceipt>;
	async respondToCollabUi(
		reqId: number,
		value?: CollabUiResponseValue,
		mutation?: RpcMutationContext,
	): Promise<void | RpcMutationReceipt> {
		const receipt = this.#getMutationReceipt(
			await this.#send({ type: "collab_ui_response", reqId, value, mutation }),
		);
		if (mutation && !receipt) {
			throw new RpcCommandError(
				"Collab UI response omitted its durable receipt",
				"collab_ui_response",
				"protocol-error",
			);
		}
		return receipt;
	}

	/** Stage one transient credential tuple for the next committed agentd-owned Herdr session route. */
	async prepareHerdrAgentdRebind(input: RpcHerdrAgentdHostBridge): Promise<void> {
		if (!this.#process?.stdin) throw new Error("Client not started");
		if (!this.#ready?.capabilities.includes(RPC_HERDR_AGENTD_HOST_CAPABILITY)) {
			throw new RpcCommandError(
				"RPC endpoint does not advertise agentd-owned Herdr hosting",
				"prepare_herdr_agentd_rebind",
				"protocol-error",
			);
		}
		const frame = buildHerdrAgentdRebindFrame(input);
		this.#herdrAgentdRebindTokens = [
			input.token,
			...this.#herdrAgentdRebindTokens.filter(token => token !== input.token),
		].slice(0, 2);
		try {
			await this.#writeFrame(frame);
		} catch (error) {
			throw redactSecretError(error, ...this.#herdrAgentdRebindTokens, this.options.herdrAgentdHost?.token);
		}
	}

	/** Discard any transient credential tuple staged for an agentd-owned Herdr successor route. */
	async clearHerdrAgentdRebind(): Promise<void> {
		if (!this.#process?.stdin) throw new Error("Client not started");
		if (!this.#ready?.capabilities.includes(RPC_HERDR_AGENTD_HOST_CAPABILITY)) {
			throw new RpcCommandError(
				"RPC endpoint does not advertise agentd-owned Herdr hosting",
				"clear_herdr_agentd_rebind",
				"protocol-error",
			);
		}
		try {
			await this.#writeFrame({ type: "clear_herdr_agentd_rebind" });
		} catch (error) {
			throw redactSecretError(error, ...this.#herdrAgentdRebindTokens, this.options.herdrAgentdHost?.token);
		}
		this.#herdrAgentdRebindTokens = [];
	}

	/** Respond to an extension UI or permission request after its frame is physically flushed. */
	respondToExtensionUI(response: RpcExtensionUIResponse): Promise<void> {
		return this.#writeFrame(response);
	}

	/** Send a canonical host-tool partial result frame and await its physical flush. */
	sendHostToolUpdate(update: RpcHostToolUpdate): Promise<void> {
		return this.#writeFrame(update);
	}

	/** Send a canonical host-tool terminal result frame and await its physical flush. */
	sendHostToolResult(result: RpcHostToolResult): Promise<void> {
		return this.#writeFrame(result);
	}

	/** Send a canonical host-URI terminal result frame and await its physical flush. */
	sendHostUriResult(result: RpcHostUriResult): Promise<void> {
		if (!this.#process?.stdin) return Promise.reject(new Error("Client not started"));
		if (!this.#pendingHostUriRequests.delete(result.id)) return Promise.resolve();
		return this.#writeFrame(result);
	}

	/**
	 * Abort current operation and immediately start a new turn with the given message.
	 */
	async abortAndPrompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "abort_and_prompt", message, images });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "new_session", parentSession });
		return this.#getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.#send({ type: "get_state" });
		const state = this.#getData<RpcSessionState>(response);
		return {
			...state,
			fastModeEnabled: state.fastModeEnabled === true,
			fastModeActive: state.fastModeActive === true,
			tokensPerSecond:
				typeof state.tokensPerSecond === "number" && Number.isFinite(state.tokensPerSecond)
					? state.tokensPerSecond
					: null,
		};
	}

	/**
	 * Enable or disable fast mode for the active model family.
	 */
	async setFastMode(enabled: boolean): Promise<{ enabled: boolean; active: boolean }> {
		const response = await this.#send({ type: "set_fast_mode", enabled });
		return this.#getData(response);
	}

	/**
	 * Configure subagent frames emitted by the RPC server. Servers default to "off".
	 * "progress" emits lifecycle/progress frames; "events" additionally emits raw subagent session events.
	 */
	async setSubagentSubscription(level: RpcSubagentSubscriptionLevel): Promise<RpcSubagentSubscriptionLevel> {
		const response = await this.#send({ type: "set_subagent_subscription", level });
		return this.#getData<{ level: RpcSubagentSubscriptionLevel }>(response).level;
	}

	/**
	 * Return the RPC server's current subagent snapshot.
	 */
	async getSubagents(): Promise<RpcSubagentSnapshot[]> {
		const response = await this.#send({ type: "get_subagents" });
		return this.#getData<{ subagents: RpcSubagentSnapshot[] }>(response).subagents;
	}

	/**
	 * Read persisted transcript entries for a tracked subagent session.
	 */
	async getSubagentMessages(selector: {
		subagentId?: string;
		sessionFile?: string;
		fromByte?: number;
	}): Promise<RpcSubagentMessagesResult> {
		const response = await this.#send({
			type: "get_subagent_messages",
			subagentId: selector.subagentId,
			sessionFile: selector.sessionFile,
			fromByte: selector.fromByte,
		});
		return this.#getData<RpcSubagentMessagesResult>(response);
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.#send({ type: "set_model", provider, modelId });
		return this.#getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel | undefined;
		isScoped: boolean;
	} | null> {
		const response = await this.#send({ type: "cycle_model" });
		return this.#getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.#send({ type: "get_available_models" });
		return this.#getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Get list of available slash commands.
	 */
	async getAvailableCommands(): Promise<RpcAvailableSlashCommand[]> {
		const response = await this.#send({ type: "get_available_commands" });
		return this.#getData<{ commands: RpcAvailableSlashCommand[] }>(response).commands;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.#send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.#send({ type: "cycle_thinking_level" });
		return this.#getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.#send({ type: "compact", customInstructions });
		return this.#getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.#send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.#send({ type: "bash", command });
		return this.#getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.#send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.#send({ type: "get_session_stats" });
		return this.#getData(response);
	}

	/**
	 * Hand off session context to a new session.
	 */
	async handoff(customInstructions?: string): Promise<RpcHandoffResult | null> {
		const response = await this.#send({ type: "handoff", customInstructions });
		return this.#getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.#send({ type: "export_html", outputPath });
		return this.#getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "switch_session", sessionPath });
		return this.#getData(response);
	}

	/**
	 * Branch from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.#send({ type: "branch", entryId });
		return this.#getData(response);
	}

	/** Fork the persisted native session. Provenance calls also return the durable receipt. */
	fork(): Promise<{ sessionId: string; cancelled: boolean }>;
	fork(mutation: RpcMutationContext): Promise<{ sessionId: string; cancelled: boolean; receipt: RpcMutationReceipt }>;
	fork(
		options: RpcForkAtEntryOptions,
	): Promise<{ sessionId: string; cancelled: boolean; receipt: RpcMutationReceipt }>;
	async fork(
		mutationOrOptions?: RpcMutationContext | RpcForkAtEntryOptions,
	): Promise<{ sessionId: string; cancelled: boolean; receipt?: RpcMutationReceipt }> {
		const atEntry = mutationOrOptions && "entryId" in mutationOrOptions ? mutationOrOptions : undefined;
		if (atEntry && !this.#ready?.capabilities.includes("fork-entry")) {
			throw new RpcCommandError("RPC endpoint does not advertise exact-entry forks", "fork", "protocol-error");
		}
		const mutation = atEntry ? atEntry.mutation : (mutationOrOptions as RpcMutationContext | undefined);
		const response = await this.#send(
			{ type: "fork", entryId: atEntry?.entryId, mutation },
			mutation ? null : 30_000,
		);
		const data = this.#getData<{ sessionId: string; cancelled: boolean }>(response);
		if (!mutation) return data;
		const receipt = this.#getMutationReceipt(response);
		if (!receipt) throw new RpcCommandError("Fork response omitted its durable receipt", "fork", "protocol-error");
		return { ...data, receipt };
	}

	/** List native ArtifactManager files for the current session. */
	async listArtifacts(): Promise<RpcArtifactListResult> {
		return this.#getData(await this.#send({ type: "artifact_list" }));
	}

	/** Read one bounded UTF-8 ArtifactManager file by canonical numeric ID. */
	async readArtifact(artifactId: string): Promise<RpcArtifactReadResult> {
		return this.#getData(await this.#send({ type: "artifact_read", artifactId }));
	}

	/** Write durable text through ArtifactManager and return its mutation receipt. */
	async writeArtifact(
		content: string,
		mutation: RpcMutationContext,
		toolType?: string,
	): Promise<RpcArtifactWriteResult & { receipt: RpcMutationReceipt }> {
		const response = await this.#send({ type: "artifact_write", content, toolType, mutation }, null);
		const data = this.#getData<RpcArtifactWriteResult>(response);
		const receipt = this.#getMutationReceipt(response);
		if (!receipt)
			throw new RpcCommandError(
				"Artifact write response omitted its durable receipt",
				"artifact_write",
				"protocol-error",
			);
		return { ...data, receipt };
	}

	/** List canonical content-addressed blobs. */
	async listBlobs(): Promise<RpcBlobListResult> {
		return this.#getData(await this.#send({ type: "blob_list" }));
	}

	/** Read one bounded blob as canonical base64. */
	async readBlob(hash: string): Promise<RpcBlobReadResult> {
		return this.#getData(await this.#send({ type: "blob_read", hash }));
	}

	/** Write one binary blob after hashing it into the canonical command shape. */
	async writeBlob(
		data: Buffer,
		mutation: RpcMutationContext,
	): Promise<RpcBlobWriteResult & { receipt: RpcMutationReceipt }> {
		const hash = new Bun.SHA256().update(data).digest("hex");
		const response = await this.#send(
			{ type: "blob_write", hash, size: data.byteLength, content: data.toString("base64"), mutation },
			null,
		);
		const result = this.#getData<RpcBlobWriteResult>(response);
		const receipt = this.#getMutationReceipt(response);
		if (!receipt)
			throw new RpcCommandError("Blob write response omitted its durable receipt", "blob_write", "protocol-error");
		return { ...result, receipt };
	}

	/** Inject one generic custom message without transport-specific delivery controls. */
	async sendCustomMessage(
		message: RpcCustomMessagePayload,
		mutation: RpcMutationContext,
	): Promise<RpcCustomMessageResult & { receipt: RpcMutationReceipt }> {
		const response = await this.#send({ type: "custom_message", ...message, mutation }, null);
		const result = this.#getData<RpcCustomMessageResult>(response);
		const receipt = this.#getMutationReceipt(response);
		if (!receipt)
			throw new RpcCommandError(
				"Custom message response omitted its durable receipt",
				"custom_message",
				"protocol-error",
			);
		return { ...result, receipt };
	}

	/** Return a complete exact history snapshot when it fits the bounded snapshot response. */
	async getHistorySnapshot(): Promise<RpcHistorySnapshot> {
		return this.#getData(await this.#send({ type: "history_snapshot" }));
	}

	/** Return one canonical typed history page. */
	async getHistoryPage(options: RpcHistoryPageOptions = {}): Promise<RpcHistoryPage> {
		return this.#getData(await this.#send({ type: "history_page", ...options }));
	}

	/** Return one byte-bounded chunk of the exact serialized history snapshot. */
	async getHistoryChunk(options: RpcHistoryChunkOptions = {}): Promise<RpcHistoryChunk> {
		return this.#getData(await this.#send({ type: "history_chunk", ...options }));
	}

	/** Return the SHA-256 digest and exact snapshot bounds without transferring history. */
	async getHistoryDigest(): Promise<RpcHistoryDigest> {
		return this.#getData(await this.#send({ type: "history_digest" }));
	}

	/**
	 * Get messages available for branching.
	 */
	async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.#send({ type: "get_branch_messages" });
		return this.#getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.#send({ type: "get_last_assistant_text" });
		return this.#getData<{ text: string | null }>(response).text;
	}

	/**
	 * Get one stable, byte-bounded message page.
	 */
	async getMessagesPage(options: RpcMessagesPageOptions = {}): Promise<RpcMessagesPage> {
		const response = await this.#send({ type: "get_messages_page", ...options });
		return this.#getData<RpcMessagesPage>(response);
	}

	/** Get all messages, draining stable pages when protocol v2 is available. */
	async getMessages(): Promise<AgentMessage[]> {
		if (this.#protocolVersion === 2) {
			try {
				const messages: AgentMessage[] = [];
				const seenCursors = new Set<string>();
				let totalMessages: number | undefined;
				let cursor: string | undefined;
				do {
					const page = await this.getMessagesPage({ cursor, limit: 256 });
					if (
						!Number.isSafeInteger(page.totalMessages) ||
						page.totalMessages < 0 ||
						(totalMessages !== undefined && page.totalMessages !== totalMessages)
					)
						throw new Error("RPC message pagination returned an inconsistent total");
					totalMessages = page.totalMessages;
					messages.push(...page.messages);
					cursor = page.nextCursor;
					if (cursor && seenCursors.has(cursor)) throw new Error("RPC message pagination repeated a cursor");
					if (cursor) seenCursors.add(cursor);
				} while (cursor);
				if (messages.length !== totalMessages)
					throw new Error("RPC message pagination ended before the advertised total");
				return messages;
			} catch (error) {
				if (!isPageFallbackError(error)) throw error;
			}
		}
		const response = await this.#send({ type: "get_messages" });
		return this.#getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get list of OAuth providers available for login, with their current authentication status.
	 */
	async getLoginProviders(): Promise<Array<{ id: string; name: string; available: boolean; authenticated: boolean }>> {
		const response = await this.#send({ type: "get_login_providers" });
		return this.#getData<{
			providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }>;
		}>(response).providers;
	}

	/**
	 * Trigger OAuth login for the given provider.
	 * The server will emit an `open_url` extension_ui_request for the auth URL.
	 * Providers that require pasted-code completion may then emit an `input`
	 * extension_ui_request; pass `onManualCodeInput` to satisfy it.
	 * Resolves when login completes or rejects on failure.
	 *
	 * @param onOpenUrl Called when the server emits the auth URL. The host must
	 *   open `url` in a browser. When the flow's callback server hosts a
	 *   `/launch` redirect, `launchUrl` is a short loopback URL that 302s to
	 *   `url` — hosts SHOULD surface it as the truncation-safe copy target so
	 *   terminal viewport clipping cannot corrupt trailing OAuth query
	 *   parameters (e.g. `code_challenge_method=S256`).
	 */
	async login(
		providerId: string,
		options?: {
			onOpenUrl?: (url: string, instructions?: string, launchUrl?: string) => void;
			onManualCodeInput?: (prompt: { title: string; placeholder?: string }) => string | Promise<string>;
		},
	): Promise<{ providerId: string }> {
		const { onManualCodeInput, onOpenUrl } = options ?? {};
		const listener =
			onOpenUrl || onManualCodeInput
				? (req: RpcExtensionUIRequest) => {
						if (req.method === "open_url") {
							onOpenUrl?.(req.url, req.instructions, req.launchUrl);
							return;
						}
						if (req.method !== "input" || !onManualCodeInput) return;
						void Promise.resolve(onManualCodeInput({ title: req.title, placeholder: req.placeholder }))
							.then(value =>
								this.respondToExtensionUI({
									type: "extension_ui_response",
									id: req.id,
									value,
								}),
							)
							.catch(() =>
								this.respondToExtensionUI({
									type: "extension_ui_response",
									id: req.id,
									cancelled: true,
								}),
							)
							.catch(() => {});
					}
				: undefined;
		const unsubscribe = listener ? this.onExtensionUIRequest(listener) : undefined;
		try {
			const response = await this.#send({ type: "login", providerId }, 600_000);
			return this.#getData<{ providerId: string }>(response);
		} finally {
			unsubscribe?.();
		}
	}

	/** Backward-compatible alias for resolving a host URI request. */
	respondHostUri(response: RpcHostUriResult): Promise<void> {
		this.#pendingHostUriRequests.delete(response.id);
		return this.#writeFrame(response);
	}

	/**
	 * Replace the host-owned custom tools exposed to the RPC session.
	 * Changes take effect before the next model call.
	 */
	async setCustomTools(tools: RpcClientCustomTool[]): Promise<string[]> {
		this.#customTools = [...tools];
		if (!this.#process) {
			return this.#customTools.map(tool => tool.name);
		}
		const definitions: RpcHostToolDefinition[] = this.#customTools.map(tool => ({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			hidden: tool.hidden,
			loadMode: tool.loadMode,
		}));
		const response = await this.#send({ type: "set_host_tools", tools: definitions });
		return this.#getData<{ toolNames: string[] }>(response).toolNames;
	}

	/**
	 * Replace the host-owned URI schemes exposed to the RPC session.
	 * Changes take effect before the next tool call.
	 */
	async setHostUriSchemes(schemes: RpcHostUriSchemeDefinition[]): Promise<string[]> {
		const response = await this.#send({ type: "set_host_uri_schemes", schemes });
		return this.#getData<{ schemes: string[] }>(response).schemes;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_end event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settled = false;
		const unsubscribe = this.onEvent(event => {
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve();
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent[]>();
		const events: AgentEvent[] = [];
		let settled = false;
		const unsubscribe = this.onEvent(event => {
			events.push(event);
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve(events);
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout collecting events. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	#handleLine(data: unknown): void {
		// Check if it's a response to a pending request
		if (isRpcResponse(data)) {
			const id = data.id;
			if (id && this.#pendingRequests.has(id)) {
				const pending = this.#pendingRequests.get(id)!;
				this.#pendingRequests.delete(id);
				pending.resolve(data);
				return;
			}
		}

		if (isRpcHostToolCallRequest(data)) {
			if (this.#hostToolCallListeners.size > 0) {
				for (const listener of this.#hostToolCallListeners) listener(data);
			} else {
				void this.#handleHostToolCall(data);
			}
			return;
		}

		if (isRpcExtensionUiRequest(data)) {
			for (const listener of this.#extensionUiListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcHostToolCancelRequest(data)) {
			for (const listener of this.#hostToolCancelListeners) listener(data);
			this.#pendingHostToolCalls.get(data.targetId)?.controller.abort();
			return;
		}

		if (isRpcHostUriRequest(data)) {
			this.#pendingHostUriRequests.add(data.id);
			if (this.#hostUriRequestListeners.size > 0) {
				for (const listener of this.#hostUriRequestListeners) listener(data);
			} else {
				void this.sendHostUriResult({
					type: "host_uri_result",
					id: data.id,
					isError: true,
					error: "No host URI request handler is registered",
				}).catch(() => {});
			}
			return;
		}

		if (isRpcHostUriCancelRequest(data)) {
			for (const listener of this.#hostUriCancelListeners) listener(data);
			return;
		}

		if (isRpcSubagentLifecycleFrame(data)) {
			for (const listener of this.#subagentLifecycleListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcSubagentProgressFrame(data)) {
			for (const listener of this.#subagentProgressListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcSubagentEventFrame(data)) {
			for (const listener of this.#subagentEventListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcAvailableCommandsUpdateFrame(data)) {
			for (const listener of this.#availableCommandsUpdateListeners) {
				listener(data.commands);
			}
			return;
		}

		if (isRpcCollabFrameEvent(data)) {
			for (const listener of this.#collabFrameListeners) {
				listener(data.frame);
			}
			return;
		}

		if (isRpcCollabTerminalFrame(data)) {
			this.#unavailable = data;
			for (const listener of this.#unavailableListeners) listener(data);
			for (const [id, pending] of this.#pendingRequests) {
				if (pending.durableMutation) continue;
				this.#pendingRequests.delete(id);
				pending.reject(new RpcCommandError(data.reason, pending.command, "unavailable"));
			}
			return;
		}

		if (!isAgentSessionEvent(data)) return;

		for (const listener of this.#sessionEventListeners) {
			listener(data);
		}

		if (!isAgentEvent(data)) return;

		for (const listener of this.#eventListeners) {
			listener(data);
		}
	}

	#send(command: RpcCommandInput, timeoutMs?: number | null): Promise<RpcResponse> {
		if (!this.#process?.stdin) {
			throw new Error("Client not started");
		}

		const durableMutation = isRpcDurableMutationCommand(command) && command.mutation !== undefined;
		if (durableMutation && !this.#ready?.capabilities.includes("mutation-receipts")) {
			return Promise.reject(
				new RpcCommandError(
					"RPC endpoint does not advertise durable mutation receipts",
					command.type,
					"protocol-error",
				),
			);
		}
		const effectiveTimeoutMs = timeoutMs === undefined ? (durableMutation ? null : 30_000) : timeoutMs;

		const id = `req_${++this.#requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;
		let serializedCommand: string;
		try {
			serializedCommand = this.#serializeFrame(fullCommand);
		} catch (error) {
			return Promise.reject(
				new RpcCommandError(
					`Failed to serialize RPC ${command.type} command: ${error instanceof Error ? error.message : String(error)}`,
					command.type,
					"protocol-error",
				),
			);
		}
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		let settled = false;
		const timeoutId =
			effectiveTimeoutMs === null
				? undefined
				: this.#startTimeout(effectiveTimeoutMs, () => {
						if (settled) return;
						this.#pendingRequests.delete(id);
						settled = true;
						reject(
							new Error(
								`Timeout waiting for response to ${command.type}. Stderr: ${this.#process?.peekStderr() ?? ""}`,
							),
						);
					});

		const pendingRequest: PendingRpcRequest = {
			command: command.type,
			durableMutation,
			resolve: response => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				resolve(response);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				reject(error);
			},
		};
		this.#pendingRequests.set(id, pendingRequest);

		const rejectWriteFailure = (error: Error): void => {
			if (this.#pendingRequests.get(id) !== pendingRequest) return;
			this.#pendingRequests.delete(id);
			pendingRequest.reject(transportLossError(pendingRequest, error));
		};
		void this.#writeSerializedFrame(serializedCommand).catch(rejectWriteFailure);
		return promise;
	}

	async #handleHostToolCall(request: RpcHostToolCallRequest): Promise<void> {
		const tool = this.#customTools.find(candidate => candidate.name === request.toolName);
		if (!tool) {
			await this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: `Host tool "${request.toolName}" is not registered` }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
			return;
		}

		const controller = new AbortController();
		this.#pendingHostToolCalls.set(request.id, { controller });

		const sendUpdate = (partialResult: RpcClientToolResult<unknown>): void => {
			if (controller.signal.aborted) return;
			void this.#writeFrame({
				type: "host_tool_update",
				id: request.id,
				partialResult: normalizeToolResult(partialResult),
			} satisfies RpcHostToolUpdate).catch(() => {});
		};

		try {
			const result = await tool.execute(request.arguments, {
				toolCallId: request.toolCallId,
				signal: controller.signal,
				sendUpdate,
			});
			if (controller.signal.aborted) return;
			await this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: normalizeToolResult(result),
			} satisfies RpcHostToolResult);
		} catch (error) {
			if (controller.signal.aborted) return;
			await this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult).catch(() => {});
		} finally {
			this.#pendingHostToolCalls.delete(request.id);
		}
	}

	#serializeFrame(frame: RpcCommand | RpcControlFrame): string {
		return `${JSON.stringify(frame)}\n`;
	}

	async #writeFrame(frame: RpcCommand | RpcControlFrame): Promise<void> {
		if (!this.#process?.stdin) throw new Error("Client not started");
		await this.#writeSerializedFrame(this.#serializeFrame(frame));
	}

	async #writeSerializedFrame(serializedFrame: string): Promise<void> {
		const stdin = this.#process?.stdin;
		if (!stdin) throw new Error("Client not started");
		await stdin.write(serializedFrame);
		await stdin.flush?.();
	}

	#getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new RpcCommandError(
				errorResponse.error,
				errorResponse.command,
				errorResponse.code,
				errorResponse.receipt,
			);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}

	#getMutationReceipt(response: RpcResponse): RpcMutationReceipt | undefined {
		if (!response.success)
			throw new RpcCommandError(response.error, response.command, response.code, response.receipt);
		return "receipt" in response ? response.receipt : undefined;
	}
}
