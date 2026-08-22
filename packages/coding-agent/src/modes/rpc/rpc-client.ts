/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { isPromise } from "node:util/types";
import type { AgentEvent, AgentMessage, AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { isRecord, ptree, readJsonl } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";
import type { BashResult } from "../../exec/bash-executor";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameDecoder, type RpcProtocolVersion } from "./rpc-frame";
import {
	RPC_MESSAGES_PAGE_BUSY_ERROR,
	RPC_MESSAGES_PAGE_STALE_ERROR,
	type RpcMessagesPage,
	type RpcMessagesPageOptions,
} from "./rpc-messages";
import type {
	RpcAvailableCommandsUpdateFrame,
	RpcAvailableSlashCommand,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHandoffResult,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcPromptResultFrame,
	RpcResponse,
	RpcSessionState,
	RpcSubagentEventFrame,
	RpcSubagentLifecycleFrame,
	RpcSubagentMessagesResult,
	RpcSubagentProgressFrame,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
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
}

export type ModelInfo = Pick<Model, "provider" | "id" | "contextWindow" | "reasoning" | "thinking">;

export type RpcEventListener = (event: AgentEvent) => void;
export type RpcSessionEventListener = (event: AgentSessionEvent) => void;
export type RpcSubagentLifecycleListener = (payload: RpcSubagentLifecycleFrame["payload"]) => void;
export type RpcSubagentProgressListener = (payload: RpcSubagentProgressFrame["payload"]) => void;
export type RpcSubagentEventListener = (payload: RpcSubagentEventFrame["payload"]) => void;
export type RpcAvailableCommandsUpdateListener = (commands: RpcAvailableSlashCommand[]) => void;

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
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"model_changed",
	"goal_updated",
]);

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

function isLocalOnlyPromptResponse(value: RpcResponse): boolean {
	return "data" in value && isRecord(value.data) && "agentInvoked" in value.data && value.data.agentInvoked === false;
}

function isRpcPromptResultFrame(value: unknown): value is RpcPromptResultFrame {
	return (
		isRecord(value) &&
		value.type === "prompt_result" &&
		(value.id === undefined || typeof value.id === "string") &&
		typeof value.agentInvoked === "boolean"
	);
}

function supportsRpcProtocolV2(value: Record<string, unknown>): boolean {
	return (
		value.type === "ready" &&
		Array.isArray(value.supportedProtocolVersions) &&
		value.supportedProtocolVersions.includes(2) &&
		value.maxFrameBytes === MAX_RPC_FRAME_BYTES &&
		value.maxReassembledFrameBytes === MAX_RPC_REASSEMBLED_BYTES
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

function closureRejectedError(event: AgentSessionEvent): Error | undefined {
	if (event.type !== "agent_end" || !event.closureRejected) return undefined;
	return new Error(`Completion rejected: ${event.closureRejected.todos.length} incomplete todo item(s) remain.`);
}

function isTerminalAgentEnd(event: AgentSessionEvent): boolean {
	return event.type === "agent_end" && (event.closureRejected !== undefined || event.isTerminal !== false);
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
	) {
		super(message);
		this.name = "RpcCommandError";
	}
}

/** Raised when prompt lifecycle collection overlaps on one client instance. */
export class RpcConcurrencyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RpcConcurrencyError";
	}
}

type RpcLifecycleBaseline = {
	scheduleOrder: number;
	generation: number;
	terminalSequence: number;
	asyncErrorSequence: number;
};
type RpcWrittenSchedule = {
	baseline: RpcLifecycleBaseline;
	predecessor: RpcLifecycleBaseline;
};

type RpcPendingRequest = {
	command: RpcCommandBody["type"];
	schedule?: RpcLifecycleBaseline;
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
};

type RpcAcceptedAsyncRequest = RpcLifecycleBaseline & {
	command: "prompt" | "abort_and_prompt";
};
type RpcAsyncError = {
	generation: number;
	scheduleOrder: number;
	sequence: number;
	error: Error;
};
type RpcLifecycleCollector = {
	operation: string;
	generation: number;
	controller: AbortController;
};

function isLateSchedulingCommand(command: string): command is RpcAcceptedAsyncRequest["command"] {
	return command === "prompt" || command === "abort_and_prompt";
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

export class RpcClient {
	#process: ptree.ChildProcess | null = null;
	#reaping: Promise<void> | null = null;
	#eventListeners: RpcEventListener[] = [];
	#sessionEventListeners: RpcSessionEventListener[] = [];
	#subagentLifecycleListeners = new Set<RpcSubagentLifecycleListener>();
	#subagentProgressListeners = new Set<RpcSubagentProgressListener>();
	#subagentEventListeners = new Set<RpcSubagentEventListener>();
	#availableCommandsUpdateListeners = new Set<RpcAvailableCommandsUpdateListener>();
	#pendingRequests = new Map<string, RpcPendingRequest>();
	#customTools: RpcClientCustomTool[] = [];
	#pendingHostToolCalls = new Map<string, { controller: AbortController }>();
	#requestId = 0;
	#protocolVersion: RpcProtocolVersion = 1;
	#idleBarrierSupported = false;
	#scheduleOrder = 0;
	#lifecycleGeneration = 0;
	#lastAcceptedSchedule: RpcLifecycleBaseline = {
		scheduleOrder: 0,
		generation: 0,
		terminalSequence: 0,
		asyncErrorSequence: 0,
	};
	#lastWrittenSchedule: RpcLifecycleBaseline = {
		scheduleOrder: 0,
		generation: 0,
		terminalSequence: 0,
		asyncErrorSequence: 0,
	};
	#writtenSchedules = new Map<number, RpcWrittenSchedule>();
	#legacyRollbackAliases = new Map<number, RpcLifecycleBaseline>();
	#terminalSequence = 0;
	#terminalOutcome: { sequence: number; error: Error | null } | undefined;
	#asyncErrorSequence = 0;
	#asyncErrors: RpcAsyncError[] = [];
	#acceptedAsyncRequests = new Map<string, RpcAcceptedAsyncRequest>();
	#legacyIdleBaseline: RpcLifecycleBaseline = {
		scheduleOrder: 0,
		generation: 0,
		terminalSequence: 0,
		asyncErrorSequence: 0,
	};
	#legacyInitialIdleKnown = false;
	#idleWaiters = new Set<() => void>();
	#activeLifecycleCollector: RpcLifecycleCollector | undefined;
	#sessionTransition = Promise.resolve();
	#sessionTransitionVersion = 0;
	#sessionTransitionPending = 0;
	#extensionUiListeners: Set<(req: RpcExtensionUIRequest) => void> = new Set();
	#abortController = new AbortController();
	#startEpoch = 0;

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
		const startEpoch = this.#startEpoch;
		await this.#reaping;
		if (this.#process) {
			throw new Error("Client already started");
		}
		await this.#sessionTransition;
		if (this.#process) {
			throw new Error("Client already started");
		}
		if (startEpoch !== this.#startEpoch) {
			throw new Error("Client start cancelled");
		}
		this.#cancelLifecycleCollector(new Error("Client restarted"));
		// Mint a fresh controller so a previous stop()'s abort does not
		// short-circuit the new stdout reader (issue #4079).
		this.#abortController = new AbortController();
		this.#protocolVersion = 1;
		this.#idleBarrierSupported = false;
		this.#scheduleOrder = 0;
		this.#lifecycleGeneration = 0;
		this.#lastAcceptedSchedule = {
			scheduleOrder: 0,
			generation: 0,
			terminalSequence: 0,
			asyncErrorSequence: 0,
		};
		this.#lastWrittenSchedule = { ...this.#lastAcceptedSchedule };
		this.#writtenSchedules.clear();
		this.#legacyRollbackAliases.clear();
		this.#legacyInitialIdleKnown = false;
		this.#terminalSequence = 0;
		this.#terminalOutcome = undefined;
		this.#asyncErrorSequence = 0;
		this.#asyncErrors = [];
		this.#acceptedAsyncRequests.clear();
		this.#legacyIdleBaseline = { ...this.#lastAcceptedSchedule };

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.sessionDir) {
			args.push("--session-dir", this.options.sessionDir);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const child = ptree.spawn(["bun", cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...Bun.env, ...this.options.env },
			stdin: "pipe",
		});
		this.#process = child;

		// Wait for the "ready" signal or process exit
		const { promise: readyPromise, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();
		let readySettled = false;
		let protocolV2Supported = false;
		let protocolV2Enabled = false;
		const frameDecoder = new RpcFrameDecoder();

		const reapAfterOutputFailure = async (error: Error) => {
			if (this.#process !== child) return;

			const reaping = this.#waitForExit(child);
			this.#process = null;
			this.#cancelLifecycleCollector(error);
			this.#abortController.abort(error);
			const pendingRequests = Array.from(this.#pendingRequests.values());
			this.#pendingRequests.clear();
			for (const pendingCall of this.#pendingHostToolCalls.values()) pendingCall.controller.abort(error);
			this.#pendingHostToolCalls.clear();

			try {
				child.kill(undefined, this.options.terminationGraceMs);
			} catch {
				// The process may already have exited.
			}
			await reaping;
			for (const request of pendingRequests) request.reject(error);
		};

		// Process lines in background, intercepting the ready signal.
		const lines = readJsonl(child.stdout, this.#abortController.signal);
		void (async () => {
			for await (const line of lines) {
				if (!readySettled && isRecord(line) && line.type === "ready") {
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
			const error =
				exitResult === null
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
			await reapAfterOutputFailure(new Error(`Agent output reader failed: ${error.message}`, { cause: error }));
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
				const response = await this.#send({
					type: "negotiate_protocol",
					protocolVersion: 2,
					closureRejection: true,
					idleBarrier: true,
				});
				if (
					!response.success ||
					response.command !== "negotiate_protocol" ||
					!isRecord(response.data) ||
					response.data.protocolVersion !== 2
				)
					throw new Error("RPC protocol v2 negotiation failed");
				this.#protocolVersion = 2;
				this.#idleBarrierSupported = response.data.closureRejection === true && response.data.idleBarrier === true;
			}
			if (this.#customTools.length > 0) {
				await this.setCustomTools(this.#customTools);
			}
		} catch (cause) {
			// Startup failed after spawning the child. Reap it before returning
			// so a retry cannot inherit a live worker or its session lock.
			const error = cause instanceof Error ? cause : new Error(String(cause));
			await reapAfterOutputFailure(error);
			throw cause;
		} finally {
			clearTimeout(readyTimeout);
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	stop(): Promise<void> {
		this.#startEpoch += 1;
		if (!this.#process) return this.#reaping ?? Promise.resolve();
		const error = new Error("Client stopped");
		const child = this.#process;
		const reaping = this.#waitForExit(child);
		this.#cancelLifecycleCollector(error);
		this.#abortController.abort(error);
		this.#process = null;
		for (const request of this.#pendingRequests.values()) request.reject(error);
		this.#pendingRequests.clear();
		for (const pendingCall of this.#pendingHostToolCalls.values()) {
			pendingCall.controller.abort(error);
		}
		this.#pendingHostToolCalls.clear();
		child.kill(undefined, this.options.terminationGraceMs);
		return reaping;
	}

	/**
	 * Stop the RPC agent process and clean up resources.
	 */
	[Symbol.dispose](): void {
		void this.stop();
	}

	#waitForExit(child: ptree.ChildProcess): Promise<void> {
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

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.#process?.peekStderr() ?? "";
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
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#sendScheduled({ type: "prompt", message, images });
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.#sendScheduled({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.#sendScheduled({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	/**
	 * Abort current operation and immediately start a new turn with the given message.
	 */
	async abortAndPrompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#sendScheduled({ type: "abort_and_prompt", message, images });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		return await this.#sendSessionReplacement({ type: "new_session", parentSession }, result => !result.cancelled);
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
		return await this.#sendSessionReplacement({ type: "handoff", customInstructions }, result => result !== null);
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
		return await this.#sendSessionReplacement({ type: "switch_session", sessionPath }, result => !result.cancelled);
	}

	/**
	 * Branch from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		return await this.#sendSessionReplacement({ type: "branch", entryId }, result => !result.cancelled);
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
							.then(value => {
								this.#writeFrame({
									type: "extension_ui_response",
									id: req.id,
									value,
								});
							})
							.catch(() => {
								this.#writeFrame({
									type: "extension_ui_response",
									id: req.id,
									cancelled: true,
								});
							});
					}
				: undefined;
		if (listener) this.#extensionUiListeners.add(listener);
		try {
			const response = await this.#send({ type: "login", providerId }, 600_000);
			return this.#getData<{ providerId: string }>(response);
		} finally {
			if (listener) this.#extensionUiListeners.delete(listener);
		}
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

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for the session to reach an authoritative idle fixed point.
	 * Legacy servers fall back to the first terminal agent_end frame.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return this.#runLifecycleCollector("waitForIdle", signal => this.#waitForIdle(timeout, signal));
	}

	/**
	 * Collect events until agent becomes idle.
	 * Rejects after forwarding a terminal closure rejection to session listeners.
	 */
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		return this.#runLifecycleCollector("collectEvents", signal => this.#collectEvents(timeout, signal));
	}

	/** Send a prompt and collect every event through the authoritative idle barrier. */
	promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		return this.#runLifecycleCollector("promptAndWait", async signal => {
			const events: AgentEvent[] = [];
			const unsubscribe = this.onEvent(event => events.push(event));
			try {
				await this.#sendScheduled({ type: "prompt", message, images }, signal);
				this.#throwIfAborted(signal);
				await this.#waitForIdle(timeout, signal);
				return events;
			} finally {
				unsubscribe();
			}
		});
	}

	// =========================================================================
	// Internal
	#runLifecycleCollector<T>(operation: string, collect: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.#sessionTransitionPending > 0) {
			return (async () => {
				await this.#waitForSessionTransition();
				return await this.#runLifecycleCollector(operation, collect);
			})();
		}
		const active = this.#activeLifecycleCollector;
		if (active) {
			return Promise.reject(
				new RpcConcurrencyError(
					`Cannot start ${operation} while ${active.operation} is already collecting prompt lifecycle events`,
				),
			);
		}

		const collector: RpcLifecycleCollector = {
			operation,
			generation: this.#lifecycleGeneration,
			controller: new AbortController(),
		};
		this.#activeLifecycleCollector = collector;
		return (async () => {
			try {
				return await this.#awaitAbortable(collect(collector.controller.signal), collector.controller.signal);
			} finally {
				if (this.#activeLifecycleCollector === collector) this.#activeLifecycleCollector = undefined;
			}
		})();
	}

	#cancelLifecycleCollector(error: Error, generation = this.#lifecycleGeneration): void {
		const collector = this.#activeLifecycleCollector;
		if (!collector || collector.generation !== generation) return;
		this.#activeLifecycleCollector = undefined;
		collector.controller.abort(error);
	}

	async #waitForSessionTransition(signal?: AbortSignal): Promise<void> {
		while (this.#sessionTransitionPending > 0) {
			await this.#awaitAbortable(this.#sessionTransition, signal ?? this.#abortController.signal);
		}
	}

	async #waitForSessionTransitionsAfter(version: number, signal: AbortSignal): Promise<void> {
		while (version !== this.#sessionTransitionVersion) {
			const transition = this.#sessionTransition;
			const transitionVersion = this.#sessionTransitionVersion;
			await this.#awaitAbortable(transition, signal);
			version = transitionVersion;
		}
	}

	async #sendSessionReplacement<T>(
		command: Extract<RpcCommandBody, { type: "new_session" | "switch_session" | "branch" | "handoff" }>,
		succeeded: (result: T) => boolean,
	): Promise<T> {
		const signal = this.#abortController.signal;
		const preceding = this.#sessionTransition;
		const waitForPreceding = this.#sessionTransitionPending > 0;
		const completion = Promise.withResolvers<void>();
		this.#sessionTransition = preceding.then(() => completion.promise);
		this.#sessionTransitionVersion += 1;
		this.#sessionTransitionPending += 1;
		try {
			if (waitForPreceding) await this.#awaitAbortable(preceding, signal);
			this.#throwIfAborted(signal);
			const lifecycleBaseline = {
				terminalSequence: this.#terminalSequence,
			};
			const result = this.#getData<T>(await this.#send(command, 30_000, undefined, signal));
			this.#throwIfAborted(signal);
			if (succeeded(result)) this.#clearLifecycleState(lifecycleBaseline);
			return result;
		} finally {
			this.#sessionTransitionPending -= 1;
			completion.resolve();
		}
	}
	#throwIfAborted(signal?: AbortSignal): void {
		if (signal?.aborted)
			throw signal.reason instanceof Error ? signal.reason : new Error("Lifecycle collector cancelled");
	}

	async #awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
		this.#throwIfAborted(signal);
		const { promise: aborted, reject } = Promise.withResolvers<never>();
		const onAbort = () =>
			reject(signal.reason instanceof Error ? signal.reason : new Error("Lifecycle collector cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([promise, aborted]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}
	async #waitForIdle(timeout: number, signal: AbortSignal): Promise<void> {
		if (this.#sessionTransitionPending > 0) await this.#waitForSessionTransition(signal);
		const transitionVersion = this.#sessionTransitionVersion;
		const baseline = { ...this.#lastWrittenSchedule };
		const rollbackBaseline = () => this.#resolveRollbackBaseline(baseline);
		if (this.#idleBarrierSupported) {
			const response = await this.#send({ type: "wait_for_idle" }, timeout, undefined, signal);
			await this.#waitForSessionTransitionsAfter(transitionVersion, signal);
			this.#throwIfAborted(signal);
			this.#getData(response);
			const outcome = this.#lifecycleOutcomeAfter(rollbackBaseline());
			this.#pruneLifecycleState(baseline);
			if (outcome) throw outcome;
			return;
		}

		const outcome = this.#lifecycleOutcomeAfter(rollbackBaseline());
		if (outcome !== undefined) {
			await this.#waitForSessionTransitionsAfter(transitionVersion, signal);
			this.#pruneLifecycleState(baseline);
			if (outcome) throw outcome;
			return;
		}
		if (this.#isLegacyIdleKnown(rollbackBaseline())) return;

		const { promise, resolve } = Promise.withResolvers<Error | undefined>();
		let settled = false;
		let timeoutId!: NodeJS.Timeout;
		const settle = (error?: Error) => {
			if (settled) return;
			settled = true;
			this.#idleWaiters.delete(settleIfIdle);
			clearTimeout(timeoutId);
			signal.removeEventListener("abort", onAbort);
			resolve(error);
		};
		const settleIfIdle = () => {
			const outcome = this.#lifecycleOutcomeAfter(rollbackBaseline());
			if (outcome !== undefined) {
				this.#pruneLifecycleState(baseline);
				settle(outcome ?? undefined);
				return;
			}
			if (this.#isLegacyIdleKnown(rollbackBaseline())) settle();
		};
		this.#idleWaiters.add(settleIfIdle);
		timeoutId = this.#startTimeout(timeout, () =>
			settle(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.#process?.peekStderr() ?? ""}`)),
		);
		const onAbort = () =>
			settle(signal.reason instanceof Error ? signal.reason : new Error("Lifecycle collector cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		settleIfIdle();
		const error = await promise;
		await this.#waitForSessionTransitionsAfter(transitionVersion, signal);
		this.#throwIfAborted(signal);
		this.#pruneLifecycleState(baseline);
		if (error) throw error;
	}
	async #collectEvents(timeout: number, signal: AbortSignal): Promise<AgentEvent[]> {
		if (this.#sessionTransitionPending > 0) await this.#waitForSessionTransition(signal);
		const transitionVersion = this.#sessionTransitionVersion;
		const { promise, resolve } = Promise.withResolvers<{ events: AgentEvent[]; error?: Error }>();
		const events: AgentEvent[] = [];
		let settled = false;
		const settle = (error?: Error) => {
			if (settled) return;
			settled = true;
			unsubscribe();
			clearTimeout(timeoutId);
			signal.removeEventListener("abort", onAbort);
			resolve({ events, error });
		};
		const unsubscribe = this.onSessionEvent(event => {
			if (isAgentEvent(event)) events.push(event);
			if (!isTerminalAgentEnd(event)) return;
			settle(closureRejectedError(event));
		});
		const timeoutId = this.#startTimeout(timeout, () =>
			settle(new Error(`Timeout collecting events. Stderr: ${this.#process?.peekStderr() ?? ""}`)),
		);
		const onAbort = () =>
			settle(signal.reason instanceof Error ? signal.reason : new Error("Lifecycle collector cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		const result = await promise;
		await this.#waitForSessionTransitionsAfter(transitionVersion, signal);
		this.#throwIfAborted(signal);
		if (result.error) throw result.error;
		return result.events;
	}
	async #sendScheduled(command: RpcCommandBody, signal?: AbortSignal): Promise<void> {
		if (this.#sessionTransitionPending > 0) await this.#waitForSessionTransition(signal);
		const baseline: RpcLifecycleBaseline = {
			scheduleOrder: ++this.#scheduleOrder,
			generation: this.#lifecycleGeneration,
			terminalSequence: this.#terminalSequence,
			asyncErrorSequence: this.#asyncErrorSequence,
		};
		let accepted = false;
		try {
			const response = await this.#send(command, 30_000, baseline, signal, () => {
				if (baseline.generation !== this.#lifecycleGeneration) return;
				const predecessor = { ...this.#lastWrittenSchedule };
				this.#writtenSchedules.set(baseline.scheduleOrder, { baseline, predecessor });
				if (baseline.scheduleOrder > this.#lastWrittenSchedule.scheduleOrder) {
					this.#lastWrittenSchedule = baseline;
				}
			});
			this.#getData(response);
			accepted = true;
			this.#throwIfAborted(signal);
			if (
				baseline.generation === this.#lifecycleGeneration &&
				baseline.scheduleOrder > this.#lastAcceptedSchedule.scheduleOrder
			) {
				this.#lastAcceptedSchedule = baseline;
				if (isLocalOnlyPromptResponse(response) || this.#terminalSequence > baseline.terminalSequence) {
					this.#markLegacyIdle(baseline);
				}
			}
		} finally {
			const written = this.#writtenSchedules.get(baseline.scheduleOrder);
			this.#writtenSchedules.delete(baseline.scheduleOrder);
			this.#refreshLastWrittenSchedule();
			if (written && !accepted) this.#recordLegacyRollback(baseline, written.predecessor);
		}
	}

	#lifecycleOutcomeAfter(baseline: RpcLifecycleBaseline): Error | null | undefined {
		const asyncError = this.#asyncErrors.find(
			error =>
				error.generation === baseline.generation &&
				error.scheduleOrder <= baseline.scheduleOrder &&
				error.sequence > baseline.asyncErrorSequence,
		);
		if (asyncError) return asyncError.error;
		const terminalOutcome = this.#terminalOutcome;
		if (!terminalOutcome || terminalOutcome.sequence <= baseline.terminalSequence) return undefined;
		return terminalOutcome.error;
	}

	#refreshLastWrittenSchedule(): void {
		let latest = this.#lastAcceptedSchedule;
		for (const { baseline: written } of this.#writtenSchedules.values()) {
			if (written.generation === this.#lifecycleGeneration && written.scheduleOrder > latest.scheduleOrder) {
				latest = written;
			}
		}
		this.#lastWrittenSchedule = latest;
	}

	#pruneLifecycleState(baseline: RpcLifecycleBaseline): void {
		for (const [id, request] of this.#acceptedAsyncRequests) {
			if (request.generation === baseline.generation && request.scheduleOrder <= baseline.scheduleOrder) {
				this.#acceptedAsyncRequests.delete(id);
			}
		}
		this.#asyncErrors = this.#asyncErrors.filter(
			error => error.generation !== baseline.generation || error.scheduleOrder > baseline.scheduleOrder,
		);
		if (this.#idleWaiters.size === 0) this.#legacyRollbackAliases.clear();
	}

	#clearLifecycleState(baseline: Pick<RpcLifecycleBaseline, "terminalSequence">): void {
		this.#cancelLifecycleCollector(new Error("Client session replaced"));
		this.#lifecycleGeneration += 1;
		this.#acceptedAsyncRequests.clear();
		this.#writtenSchedules.clear();
		this.#legacyRollbackAliases.clear();
		this.#legacyInitialIdleKnown = false;
		if (!this.#terminalOutcome || this.#terminalOutcome.sequence <= baseline.terminalSequence) {
			this.#terminalOutcome = undefined;
		}
		this.#asyncErrors = [];
		this.#lastAcceptedSchedule = {
			scheduleOrder: ++this.#scheduleOrder,
			generation: this.#lifecycleGeneration,
			terminalSequence: baseline.terminalSequence,
			asyncErrorSequence: this.#asyncErrorSequence,
		};
		this.#lastWrittenSchedule = this.#lastAcceptedSchedule;
		this.#markLegacyIdle(this.#lastAcceptedSchedule);
	}

	#resolveRollbackBaseline(baseline: RpcLifecycleBaseline): RpcLifecycleBaseline {
		let resolved = baseline;
		const visited = new Set<number>();
		while (visited.add(resolved.scheduleOrder)) {
			const predecessor = this.#legacyRollbackAliases.get(resolved.scheduleOrder);
			if (!predecessor || predecessor.generation !== resolved.generation) break;
			resolved = predecessor;
		}
		return resolved;
	}

	#recordLegacyRollback(baseline: RpcLifecycleBaseline, predecessor: RpcLifecycleBaseline): void {
		if (baseline.generation !== this.#lifecycleGeneration) return;
		this.#legacyRollbackAliases.set(baseline.scheduleOrder, predecessor);
		if (this.#resolveRollbackBaseline(predecessor).scheduleOrder === 0) this.#legacyInitialIdleKnown = true;
		this.#notifyIdleWaiters();
	}
	#isLegacyIdleKnown(baseline: RpcLifecycleBaseline): boolean {
		if (this.#legacyIdleBaseline.generation !== baseline.generation) return false;
		if (baseline.scheduleOrder === 0)
			return (
				(this.#legacyInitialIdleKnown && this.#lastWrittenSchedule.scheduleOrder === 0) ||
				this.#legacyIdleBaseline.scheduleOrder > 0
			);
		return this.#legacyIdleBaseline.scheduleOrder === baseline.scheduleOrder;
	}

	#markLegacyIdle(baseline: RpcLifecycleBaseline): void {
		if (baseline.generation !== this.#lifecycleGeneration) return;
		if (
			this.#legacyIdleBaseline.generation === baseline.generation &&
			this.#legacyIdleBaseline.scheduleOrder > baseline.scheduleOrder
		)
			return;
		this.#legacyIdleBaseline = { ...baseline };
		this.#notifyIdleWaiters();
	}

	#notifyIdleWaiters(): void {
		for (const waiter of this.#idleWaiters) waiter();
	}

	#handleLine(data: unknown): void {
		// Check if it's a response to a pending request or a late scheduling failure.
		if (isRpcResponse(data)) {
			const id = data.id;
			if (id && this.#pendingRequests.has(id)) {
				const pending = this.#pendingRequests.get(id)!;
				this.#pendingRequests.delete(id);
				if (
					data.success &&
					pending.schedule?.generation === this.#lifecycleGeneration &&
					isLateSchedulingCommand(pending.command) &&
					data.command === pending.command
				) {
					this.#acceptedAsyncRequests.set(id, { ...pending.schedule, command: pending.command });
				}
				pending.resolve(data);
				return;
			}

			if (!data.success && id) {
				const accepted = this.#acceptedAsyncRequests.get(id);
				if (accepted && accepted.command === data.command) {
					this.#acceptedAsyncRequests.delete(id);
					if (accepted.generation === this.#lifecycleGeneration) {
						this.#asyncErrors.push({
							generation: accepted.generation,
							scheduleOrder: accepted.scheduleOrder,
							sequence: ++this.#asyncErrorSequence,
							error: new RpcCommandError(data.error, data.command, data.code),
						});
						this.#notifyIdleWaiters();
					}
				}
			}
			return;
		}

		if (isRpcPromptResultFrame(data)) {
			if (data.id && data.agentInvoked === false) {
				const accepted = this.#acceptedAsyncRequests.get(data.id);
				if (accepted?.generation === this.#lifecycleGeneration) {
					this.#markLegacyIdle(accepted);
				}
			}
			return;
		}

		if (isRpcHostToolCallRequest(data)) {
			void this.#handleHostToolCall(data);
			return;
		}

		if (isRpcExtensionUiRequest(data)) {
			for (const listener of this.#extensionUiListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcHostToolCancelRequest(data)) {
			this.#pendingHostToolCalls.get(data.targetId)?.controller.abort();
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

		if (!isAgentSessionEvent(data)) return;
		const terminal = isTerminalAgentEnd(data);
		if (terminal) {
			this.#terminalSequence += 1;
			this.#terminalOutcome = { sequence: this.#terminalSequence, error: closureRejectedError(data) ?? null };
			this.#markLegacyIdle(this.#lastAcceptedSchedule);
		}

		for (const listener of [...this.#sessionEventListeners]) {
			listener(data);
		}

		if (!isAgentEvent(data)) {
			if (terminal) this.#notifyIdleWaiters();
			return;
		}

		for (const listener of this.#eventListeners) {
			listener(data);
		}
		if (terminal) this.#notifyIdleWaiters();
	}

	#send(
		command: RpcCommandBody,
		timeoutMs = 30_000,
		schedule?: RpcLifecycleBaseline,
		signal?: AbortSignal,
		onWritten?: () => void,
	): Promise<RpcResponse> {
		if (signal?.aborted)
			return Promise.reject(
				signal.reason instanceof Error ? signal.reason : new Error("Lifecycle collector cancelled"),
			);
		if (!this.#process?.stdin) {
			throw new Error("Client not started");
		}

		const id = `req_${++this.#requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		let settled = false;
		const cleanup = () => {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", abort);
		};
		const timeoutId = this.#startTimeout(timeoutMs, () => {
			if (settled) return;
			this.#pendingRequests.delete(id);
			settled = true;
			cleanup();
			reject(
				new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.#process?.peekStderr() ?? ""}`),
			);
		});
		const abort = () => {
			if (settled) return;
			this.#pendingRequests.delete(id);
			settled = true;
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Lifecycle collector cancelled"));
		};

		this.#pendingRequests.set(id, {
			command: command.type,
			schedule,
			resolve: response => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(response);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		});
		signal?.addEventListener("abort", abort, { once: true });

		try {
			this.#writeFrame(fullCommand, err => {
				this.#pendingRequests.delete(id);
				if (settled) return;
				settled = true;
				cleanup();
				reject(err);
			});
			onWritten?.();
		} catch (error) {
			this.#pendingRequests.delete(id);
			settled = true;
			cleanup();
			reject(error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	}

	async #handleHostToolCall(request: RpcHostToolCallRequest): Promise<void> {
		const tool = this.#customTools.find(candidate => candidate.name === request.toolName);
		if (!tool) {
			this.#writeFrame({
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
			this.#writeFrame({
				type: "host_tool_update",
				id: request.id,
				partialResult: normalizeToolResult(partialResult),
			} satisfies RpcHostToolUpdate);
		};

		try {
			const result = await tool.execute(request.arguments, {
				toolCallId: request.toolCallId,
				signal: controller.signal,
				sendUpdate,
			});
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: normalizeToolResult(result),
			} satisfies RpcHostToolResult);
		} catch (error) {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
		} finally {
			this.#pendingHostToolCalls.delete(request.id);
		}
	}

	#writeFrame(
		frame: RpcCommand | RpcExtensionUIResponse | RpcHostToolResult | RpcHostToolUpdate,
		onError?: (error: Error) => void,
	): void {
		if (!this.#process?.stdin) {
			throw new Error("Client not started");
		}
		const stdin = this.#process.stdin as FileSink;
		stdin.write(`${JSON.stringify(frame)}\n`);
		const flushResult = stdin.flush();
		if (isPromise(flushResult)) {
			flushResult.catch((err: Error) => {
				onError?.(err);
			});
		}
	}

	#getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new RpcCommandError(errorResponse.error, errorResponse.command, errorResponse.code);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
