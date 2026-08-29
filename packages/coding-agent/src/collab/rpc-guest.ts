import { once } from "node:events";
import * as os from "node:os";
import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import { isRpcHostToolResult, isRpcHostToolUpdate } from "../modes/rpc/host-tools";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "../modes/rpc/rpc-frame";
import { readRpcInputFrames } from "../modes/rpc/rpc-input";
import { pageRpcMessages, RPC_MESSAGES_PAGE_BUSY_ERROR, RpcMessagesPageError } from "../modes/rpc/rpc-messages";
import type {
	RpcCollabFrame,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcResponse,
	RpcSessionState,
} from "../modes/rpc/rpc-types";
import type { SessionEntry, SessionHeader } from "../session/session-entries";
import { LocalCollabTransport } from "./local-transport";
import { COLLAB_PROTO, type CollabFrame, type CollabSessionState, type CollabUiRequest } from "./protocol";
import type { CollabTransport } from "./relay-client";

type RpcLineWriter = (line: string) => void | Promise<void>;

export interface CollabRpcGuestOptions {
	address: string;
	roomId: string;
	token: string;
	input?: ReadableStream<Uint8Array>;
	transport?: CollabTransport;
	writeLine?: RpcLineWriter;
}

class RpcGuestOutput {
	#encoder = new RpcFrameEncoder();
	#tail: Promise<void> = Promise.resolve();
	readonly #writeLine: RpcLineWriter;

	constructor(writeLine: RpcLineWriter) {
		this.#writeLine = writeLine;
	}

	send(frame: object): void {
		const frames = this.#encoder.encodeFrames(frame);
		this.#tail = this.#tail
			.then(async () => {
				for (const line of frames) await this.#writeLine(line);
			})
			.catch(() => {});
		if (
			isRecord(frame) &&
			frame.type === "response" &&
			frame.command === "negotiate_protocol" &&
			frame.success === true
		) {
			this.#encoder.setProtocolVersion(2);
		}
	}

	flush(): Promise<void> {
		return this.#tail;
	}
}

function writeRpcLine(line: string): Promise<void> {
	if (process.stdout.write(line)) return Promise.resolve();
	return once(process.stdout, "drain").then(() => {});
}

function abortableInput(input: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
	const reader = input.getReader();
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		reader.releaseLock();
	};
	const cancel = () => {
		void reader.cancel().finally(release);
	};
	signal.addEventListener("abort", cancel, { once: true });
	return new ReadableStream({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					signal.removeEventListener("abort", cancel);
					release();
					controller.close();
					return;
				}
				controller.enqueue(result.value);
			} catch (error) {
				release();
				controller.error(error);
			}
		},
		cancel() {
			signal.removeEventListener("abort", cancel);
			cancel();
		},
	});
}

function errorResponse(id: string | undefined, command: string, error: string, code?: string): RpcResponse {
	return { id, type: "response", command, success: false, error, ...(code ? { code } : {}) };
}

function successResponse(id: string | undefined, command: string, data?: object): RpcResponse {
	return { id, type: "response", command, success: true, ...(data ? { data } : {}) } as RpcResponse;
}

function messageEntries(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries
		.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message")
		.map(entry => entry.message);
}

function uiRequestFrame(id: string, request: CollabUiRequest): RpcExtensionUIRequest {
	if (request.kind === "editor") {
		return { type: "extension_ui_request", id, method: "editor", title: request.title, prefill: request.prefill };
	}
	const options = request.options.map(option => (typeof option === "string" ? option : option.label));
	let optionDetails: Array<{ description?: string }> | undefined;
	for (let index = 0; index < request.options.length; index++) {
		const option = request.options[index]!;
		if (typeof option === "string" || !option.description?.trim()) continue;
		optionDetails ??= Array.from({ length: request.options.length }, () => ({}));
		optionDetails[index] = { description: option.description.trim() };
	}
	return {
		type: "extension_ui_request",
		id,
		method: "select",
		title: request.title,
		options,
		...(optionDetails ? { optionDetails } : {}),
	};
}

/**
 * In-memory Collab guest exposed through the normal OMP RPC wire protocol.
 * It deliberately owns no AgentSession or session file: the Collab host stays
 * authoritative and this guest only mirrors the host's replicated transcript.
 */
export class CollabRpcGuest {
	readonly #transport: CollabTransport;
	readonly #roomId: string;
	readonly #token: string;
	readonly #output: RpcGuestOutput;
	#header: SessionHeader | undefined;
	#state: CollabSessionState | undefined;
	#entries: SessionEntry[] = [];
	#snapshotEntryCount = 0;
	#snapshotLoading = false;
	#canWrite = false;
	#started = false;
	#ready = Promise.withResolvers<void>();
	#isReady = false;
	#ended = Promise.withResolvers<void>();
	#pendingUi = new Map<string, number>();
	#hostToolReqSeq = 0;
	#hostToolCancelSeq = 0;
	#pendingHostToolRegistrations = new Map<
		number,
		{ id: string | undefined; resolve: (response: RpcResponse) => void }
	>();
	#activeHostToolCalls = new Set<string>();
	#commandTail: Promise<void> = Promise.resolve();

	#acceptingLiveFrames = false;
	#queuedLiveFrames: CollabFrame[] = [];
	#queuedRpcFrames: RpcCollabFrame[] = [];
	constructor(options: Omit<CollabRpcGuestOptions, "input">) {
		this.#roomId = options.roomId;
		this.#token = options.token;
		this.#transport =
			options.transport ?? new LocalCollabTransport(options.address, { t: "guest", token: options.token });
		this.#output = new RpcGuestOutput(options.writeLine ?? writeRpcLine);
	}

	async run(input: ReadableStream<Uint8Array> = Bun.stdin.stream()): Promise<void> {
		if (this.#started) throw new Error("Collab RPC guest already started");
		this.#started = true;
		process.env.PI_NOTIFICATIONS = "off";
		this.#transport.onOpen = () => {
			this.#transport.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: os.userInfo().username,
				writeToken: this.#token,
			});
		};
		this.#transport.onFrame = frame => this.#onFrame(frame);
		this.#transport.onControl = msg => {
			if (msg.t === "peer-authority") this.#onFrame({ t: "authority", canWrite: msg.canWrite });
		};
		this.#transport.onClose = reason => this.#finish(reason);
		this.#transport.connect();
		await this.#ready.promise;
		this.#output.send({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
		});

		this.#acceptingLiveFrames = true;
		const queuedLiveFrames = this.#queuedLiveFrames;
		this.#queuedLiveFrames = [];
		for (const frame of queuedLiveFrames) this.#onFrame(frame);
		const queuedRpcFrames = this.#queuedRpcFrames;
		this.#queuedRpcFrames = [];
		for (const frame of queuedRpcFrames) this.#output.send(frame);
		const inputAbort = new AbortController();
		const readInput = readRpcInputFrames(
			abortableInput(input, inputAbort.signal),
			frame => this.#onInput(frame),
			message => this.#output.send(errorResponse(undefined, "parse", message)),
		);
		const outcome = await Promise.race([
			readInput.then(() => "input" as const),
			this.#ended.promise.then(() => "transport" as const),
		]);
		if (outcome === "input") this.#transport.close();
		else inputAbort.abort();
		await readInput;
		await this.#commandTail;
		await this.#output.flush();
	}

	#onFrame(frame: CollabFrame): void {
		if (!this.#acceptingLiveFrames && this.#header && frame.t !== "welcome" && frame.t !== "snapshot-chunk") {
			this.#queuedLiveFrames.push(frame);
			return;
		}

		switch (frame.t) {
			case "welcome":
				this.#header = frame.header;
				this.#state = frame.state;
				this.#entries = [];
				this.#snapshotEntryCount = frame.entryCount;
				this.#snapshotLoading = frame.entryCount > 0;
				this.#canWrite = frame.readOnly !== true;
				if (!this.#snapshotLoading) this.#markReady();
				return;
			case "snapshot-chunk":
				if (!this.#snapshotLoading) return;
				this.#entries.push(...frame.entries);
				if (frame.final || this.#entries.length >= this.#snapshotEntryCount) this.#markReady();
				return;
			case "entry":
				if (!this.#header) return;
				this.#entries.push(frame.entry);
				return;
			case "event":
				if (this.#header) this.#output.send(frame.event);
				return;
			case "state":
				this.#state = frame.state;
				this.#emitRpcFrame({ type: "collab_state_update", state: frame.state });
				return;
			case "authority":
				this.#canWrite = frame.canWrite;
				if (!this.#canWrite) {
					this.#cancelPendingUi();
					this.#cancelPendingHostToolRegistrations("Collab control is required", "collab_read_only");
					this.#cancelActiveHostToolCalls();
				}
				this.#emitRpcFrame({ type: "collab_authority_update", canWrite: frame.canWrite });
				return;
			case "ui-request":
				if (this.#canWrite) this.#presentUiRequest(frame.request);
				return;
			case "ui-request-end":
				this.#endUiRequest(frame.reqId);
				return;
			case "host-tools-set":
				this.#handleHostToolsSet(frame.reqId, frame.toolNames, frame.error);
				return;
			case "host-tool-call":
				if (!this.#canWrite) return;
				this.#activeHostToolCalls.add(frame.frame.id);
				this.#output.send(frame.frame);
				return;
			case "host-tool-cancel":
				if (!this.#activeHostToolCalls.delete(frame.frame.targetId)) return;
				this.#output.send(frame.frame);
				return;
			case "bye":
				this.#finish(frame.reason);
				return;
			case "error":
				if (!this.#header) this.#finish(frame.message);
				else this.#output.send({ type: "notice", level: "error", message: frame.message, source: "collab" });
				return;
			default:
				return;
		}
	}

	#emitRpcFrame(frame: RpcCollabFrame): void {
		if (!this.#acceptingLiveFrames) {
			this.#queuedRpcFrames.push(frame);
			return;
		}
		this.#output.send(frame);
	}

	#markReady(): void {
		if (this.#isReady) return;
		this.#snapshotLoading = false;
		this.#isReady = true;
		this.#ready.resolve();
	}

	#finish(reason: string): void {
		if (!this.#isReady) this.#ready.reject(new Error(reason));
		this.#cancelPendingUi();
		this.#cancelPendingHostToolRegistrations(reason);
		this.#cancelActiveHostToolCalls();
		this.#ended.resolve();
	}

	#onInput(frame: unknown): void {
		if (isRpcHostToolUpdate(frame)) {
			this.#relayHostToolUpdate(frame);
			return;
		}
		if (isRpcHostToolResult(frame)) {
			this.#relayHostToolResult(frame);
			return;
		}
		if (isRecord(frame) && frame.type === "extension_ui_response" && typeof frame.id === "string") {
			this.#respondToUi(frame as RpcExtensionUIResponse);
			return;
		}
		if (!isRecord(frame) || typeof frame.type !== "string") {
			this.#output.send(errorResponse(undefined, "command", "Invalid RPC command"));
			return;
		}
		this.#commandTail = this.#commandTail.then(async () => {
			this.#output.send(await this.#handleCommand(frame as RpcCommand));
		});
	}

	async #handleCommand(command: RpcCommand): Promise<RpcResponse> {
		const id = command.id;
		switch (command.type) {
			case "negotiate_protocol":
				return command.protocolVersion === 2
					? successResponse(id, "negotiate_protocol", { protocolVersion: 2 })
					: errorResponse(
							id,
							"negotiate_protocol",
							`Unsupported RPC protocol version: ${command.protocolVersion}`,
						);
			case "get_state":
				return successResponse(id, "get_state", this.#rpcState());
			case "get_messages":
				return successResponse(id, "get_messages", { messages: messageEntries(this.#entries) });
			case "get_messages_page":
				if (this.#state?.isStreaming)
					return errorResponse(id, "get_messages_page", RPC_MESSAGES_PAGE_BUSY_ERROR, "session_busy");
				try {
					const messages = messageEntries(this.#entries);
					return successResponse(
						id,
						"get_messages_page",
						pageRpcMessages(
							messages,
							{ sessionId: this.#requireHeader().id, leafId: null, messageCount: messages.length },
							command,
						),
					);
				} catch (error) {
					return errorResponse(
						id,
						"get_messages_page",
						error instanceof Error ? error.message : String(error),
						error instanceof RpcMessagesPageError ? error.code : undefined,
					);
				}
			case "prompt":
				if (!this.#canWrite) return errorResponse(id, "prompt", "Collab control is required", "collab_read_only");
				return this.#sendMutation(
					id,
					"prompt",
					{
						t: "prompt",
						text: command.message,
						images: command.images,
						streamingBehavior: command.streamingBehavior,
					},
					{ agentInvoked: true },
				);
			case "abort":
				if (!this.#canWrite) return errorResponse(id, "abort", "Collab control is required", "collab_read_only");
				return this.#sendMutation(id, "abort", { t: "abort" });
			case "set_host_tools":
				if (!this.#canWrite)
					return errorResponse(id, "set_host_tools", "Collab control is required", "collab_read_only");
				return this.#setHostTools(id, command.tools);
			case "request_control":
				return this.#requestAuthority(id, "request_control", "request");
			case "release_control":
				if (!this.#canWrite)
					return errorResponse(id, "release_control", "Collab control is required", "collab_read_only");
				return this.#requestAuthority(id, "release_control", "release");
			default:
				return errorResponse(id, command.type, `Unsupported in Collab RPC guest: ${command.type}`);
		}
	}

	#requireHeader(): SessionHeader {
		if (!this.#header) throw new Error("Collab session is not ready");
		return this.#header;
	}

	#sendMutation(id: string | undefined, command: string, frame: CollabFrame, data?: object): RpcResponse {
		try {
			return this.#transport.send(frame)
				? successResponse(id, command, data)
				: errorResponse(id, command, "Collab transport is unavailable");
		} catch (error) {
			return errorResponse(id, command, error instanceof Error ? error.message : String(error));
		}
	}

	#requestAuthority(
		id: string | undefined,
		command: "request_control" | "release_control",
		action: "request" | "release",
	): RpcResponse {
		if (!this.#transport.requestAuthority)
			return errorResponse(id, command, "This collab transport cannot change controller authority");
		try {
			return this.#transport.requestAuthority(action)
				? successResponse(id, command)
				: errorResponse(id, command, "Collab transport is unavailable");
		} catch (error) {
			return errorResponse(id, command, error instanceof Error ? error.message : String(error));
		}
	}

	#setHostTools(id: string | undefined, tools: RpcHostToolDefinition[]): Promise<RpcResponse> {
		const reqId = ++this.#hostToolReqSeq;
		const { promise, resolve } = Promise.withResolvers<RpcResponse>();
		this.#pendingHostToolRegistrations.set(reqId, { id, resolve });
		try {
			if (this.#transport.send({ t: "set-host-tools", reqId, tools })) return promise;
		} catch (error) {
			this.#pendingHostToolRegistrations.delete(reqId);
			return Promise.resolve(
				errorResponse(id, "set_host_tools", error instanceof Error ? error.message : String(error)),
			);
		}
		this.#pendingHostToolRegistrations.delete(reqId);
		return Promise.resolve(errorResponse(id, "set_host_tools", "Collab transport is unavailable"));
	}

	#handleHostToolsSet(reqId: number, toolNames: string[] | undefined, error: string | undefined): void {
		const pending = this.#pendingHostToolRegistrations.get(reqId);
		if (!pending) return;
		this.#pendingHostToolRegistrations.delete(reqId);
		pending.resolve(
			error
				? errorResponse(pending.id, "set_host_tools", error)
				: successResponse(pending.id, "set_host_tools", { toolNames: toolNames ?? [] }),
		);
	}

	#cancelPendingHostToolRegistrations(message: string, code?: string): void {
		for (const pending of this.#pendingHostToolRegistrations.values()) {
			pending.resolve(errorResponse(pending.id, "set_host_tools", message, code));
		}
		this.#pendingHostToolRegistrations.clear();
	}

	#relayHostToolUpdate(frame: RpcHostToolUpdate): void {
		if (!this.#canWrite || !this.#activeHostToolCalls.has(frame.id)) return;
		try {
			this.#transport.send({ t: "host-tool-update", frame });
		} catch {}
	}

	#relayHostToolResult(frame: RpcHostToolResult): void {
		if (!this.#canWrite || !this.#activeHostToolCalls.has(frame.id)) return;
		try {
			if (!this.#transport.send({ t: "host-tool-result", frame })) return;
		} catch {
			const fallback: RpcHostToolResult = {
				type: "host_tool_result",
				id: frame.id,
				result: { content: [{ type: "text", text: "Host tool result could not be delivered over Collab" }] },
				isError: true,
			};
			try {
				if (!this.#transport.send({ t: "host-tool-result", frame: fallback })) return;
			} catch {
				return;
			}
		}
		this.#activeHostToolCalls.delete(frame.id);
	}

	#cancelActiveHostToolCalls(): void {
		for (const targetId of this.#activeHostToolCalls) {
			this.#output.send({
				type: "host_tool_cancel",
				id: `collab-host-tool-cancel-${++this.#hostToolCancelSeq}`,
				targetId,
			} satisfies RpcHostToolCancelRequest);
		}
		this.#activeHostToolCalls.clear();
	}

	#rpcState(): RpcSessionState {
		const header = this.#requireHeader();
		const state = this.#state;
		return {
			model: state?.model,
			thinkingLevel: state?.thinkingLevel as ThinkingLevel | undefined,
			isStreaming: state?.isStreaming ?? false,
			isCompacting: false,
			steeringMode: "all",
			followUpMode: "all",
			interruptMode: "immediate",
			sessionId: header.id,
			sessionName: state?.sessionName ?? header.title,
			autoCompactionEnabled: false,
			fastModeEnabled: false,
			fastModeActive: false,
			tokensPerSecond: null,
			messageCount: messageEntries(this.#entries).length,
			queuedMessageCount: state?.queuedMessageCount ?? 0,
			todoPhases: [],
			contextUsage: state?.contextUsage,
		};
	}

	#presentUiRequest(request: CollabUiRequest): void {
		const id = `collab-ui-${this.#roomId}-${request.reqId}`;
		if (this.#pendingUi.has(id)) return;
		this.#pendingUi.set(id, request.reqId);
		this.#output.send(uiRequestFrame(id, request));
	}

	#endUiRequest(reqId: number): void {
		for (const [id, pendingReqId] of this.#pendingUi) {
			if (pendingReqId !== reqId) continue;
			this.#pendingUi.delete(id);
			this.#output.send({
				type: "extension_ui_request",
				id: `collab-ui-cancel-${reqId}`,
				method: "cancel",
				targetId: id,
			});
		}
	}

	#cancelPendingUi(): void {
		for (const [id] of this.#pendingUi) {
			this.#output.send({
				type: "extension_ui_request",
				id: `collab-ui-cancel-${id}`,
				method: "cancel",
				targetId: id,
			});
		}
		this.#pendingUi.clear();
	}

	#respondToUi(response: RpcExtensionUIResponse): void {
		const reqId = this.#pendingUi.get(response.id);
		if (reqId === undefined || !this.#canWrite) return;
		this.#pendingUi.delete(response.id);
		const value = "value" in response ? response.value : undefined;
		this.#transport.send({ t: "ui-response", reqId, value });
	}
}

export function runCollabRpcGuest(options: CollabRpcGuestOptions): Promise<void> {
	const guest = new CollabRpcGuest(options);
	return guest.run(options.input);
}
