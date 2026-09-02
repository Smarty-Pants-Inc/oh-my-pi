import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort, Model } from "@oh-my-pi/pi-ai";
import { getConfigRootDir, logger } from "@oh-my-pi/pi-utils";
import { runRpcMode } from "../modes/rpc/rpc-mode";
import { fingerprintRpcMutation } from "../modes/rpc/rpc-mutation";
import {
	isRpcDurableMutationCommand,
	isRpcEndpointIdentity,
	isRpcMutationCommand,
	isRpcMutationContext,
	RPC_CAPABILITIES,
	type RpcCollabFrame,
	type RpcCommand,
	type RpcControlFrame,
	type RpcEndpointIdentity,
	type RpcResponse,
} from "../modes/rpc/rpc-types";
import type { AgentSession } from "../session/agent-session";
import type { SessionEntry } from "../session/session-entries";
import { shouldDisableReasoning, toReasoningEffort } from "../thinking";
import type { EventBus } from "../utils/event-bus";
import { LocalCollabTransport } from "./agentd-local-transport";
import { COLLAB_PROTO, type CollabFrame, type CollabParticipant, type CollabSessionState } from "./protocol";
import type { CollabTransport } from "./relay-client";
import { CollabRpcFrameReassembler, sendCollabRpcFrame } from "./rpc-frames";

const SNAPSHOT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const EVENT_BACKLOG_LIMIT = 1024;
const MAX_PENDING_REQUESTS = 256;
const REQUIRED_HOST_CAPABILITIES = [
	...RPC_CAPABILITIES,
	"collab-rpc-guest",
	"rpc-all-commands",
	"rpc-inner-chunks",
] as const;

export interface CollabRpcGuestSession {
	reloadReplicatedSession(sessionPath: string): Promise<void>;
	refreshReplicatedSessionContext(): void;
	sessionManager: {
		ingestReplicatedEntry(entry: SessionEntry): void;
	};
	agent: {
		state: { model?: Model };
		setModel(model: Model): void;
		setThinkingLevel(level: Effort | undefined): void;
		setDisableReasoning(disabled: boolean): void;
	};
}

export type CollabRpcGuestEventListener = (event: object) => void;
export type CollabRpcGuestTerminalListener = (reason: string) => void;

export interface CollabRpcGuestBridge {
	address: string;
	roomId: string;
	token: string;
}

/** Compose a hydrated Collab replica with RPC stdin/stdout as a pure transport adapter. */
export async function runCollabRpcGuest(
	session: AgentSession,
	bridge: CollabRpcGuestBridge,
	eventBus: EventBus | undefined,
	input: ReadableStream<Uint8Array> | undefined,
): Promise<never> {
	const guest = new CollabRpcGuest({
		transport: new LocalCollabTransport(bridge.address, { t: "guest", token: bridge.token }),
		session,
		roomId: bridge.roomId,
	});
	try {
		await guest.start();
		return await runRpcMode(session, undefined, eventBus, input, {
			identity: guest.identity,
			participant: guest.participant,
			externalEvents: guest,
			interceptCommand: command => guest.handleCommand(command),
			interceptControlFrame: frame => guest.handleControlFrame(frame),
			onBeforeSessionDispose: () => guest.close(),
		});
	} catch (error) {
		guest.close();
		throw error;
	}
}

type WelcomeFrame = Extract<CollabFrame, { t: "welcome" }>;
type SnapshotChunkFrame = Extract<CollabFrame, { t: "snapshot-chunk" }>;

type PendingSnapshot = {
	rpc: RpcEndpointIdentity;
	header: WelcomeFrame["header"];
	state: WelcomeFrame["state"];
	participant: CollabParticipant;
	entryCount: number;
	entries: SessionEntry[];
	entryIds: Set<string>;
};

type PendingRequest = {
	command: RpcCommand;
	resolve(response: RpcResponse): void;
	timer?: NodeJS.Timeout;
};

/** Hydrates the local replica while forwarding every RPC command to the authoritative host. */
export class CollabRpcGuest {
	#transport: CollabTransport;
	#replicaPath: string | undefined;
	#session: CollabRpcGuestSession;
	#roomId: string;
	readonly #replicaId = crypto.randomUUID();
	#pendingSnapshot: PendingSnapshot | undefined;
	#applyChain: Promise<void> = Promise.resolve();
	#hydrated = Promise.withResolvers<void>();
	#settled = false;
	#closed = false;
	#timer: NodeJS.Timeout | undefined;
	#listeners = new Set<CollabRpcGuestEventListener>();
	#eventBacklog: object[] = [];
	#terminalListeners = new Set<CollabRpcGuestTerminalListener>();
	#terminalReason: string | undefined;
	#participant: CollabParticipant | undefined;
	#identity: RpcEndpointIdentity | undefined;
	#nextRequestId = 1;
	#pendingRequests = new Map<number, PendingRequest>();
	#reassembler = new CollabRpcFrameReassembler();
	state: CollabSessionState | undefined;

	constructor(options: {
		transport: CollabTransport;
		session: CollabRpcGuestSession;
		roomId: string;
		replicaPath?: string;
	}) {
		this.#transport = options.transport;
		this.#session = options.session;
		this.#roomId = options.roomId;
		this.#replicaPath = options.replicaPath;
	}

	/** Connect and resolve only after the welcome snapshot has populated the replica. */
	start(): Promise<void> {
		this.#transport.onOpen = () => {
			this.#transport.send({ t: "hello", proto: COLLAB_PROTO, name: "OMP RPC guest" });
			this.#armSnapshotTimeout();
		};
		this.#transport.onFrame = (frame, fromPeer) => {
			this.#applyChain = this.#applyChain
				.then(async () => {
					const reassembled = this.#reassembler.push(frame, fromPeer);
					const inbound = reassembled.handled ? reassembled.frame : frame;
					if (!inbound) return;
					await this.#applyFrame(inbound);
				})
				.catch(error => this.#fail(error));
		};
		this.#transport.onClose = (reason, willReconnect) => {
			if (!willReconnect) this.#fail(new Error(reason));
		};
		this.#transport.connect();
		this.#armSnapshotTimeout();
		return this.#hydrated.promise;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearSnapshotTimeout();
		this.#reassembler.close();
		this.#settlePending("Collab guest closed", "unavailable");
		this.#transport.close();
	}

	subscribe(listener: CollabRpcGuestEventListener): () => void {
		this.#listeners.add(listener);
		for (const event of this.#eventBacklog.splice(0)) this.#notifyEventListener(listener, event);
		return () => this.#listeners.delete(listener);
	}

	onTerminal(listener: CollabRpcGuestTerminalListener): () => void {
		this.#terminalListeners.add(listener);
		if (this.#terminalReason !== undefined) this.#notifyTerminalListener(listener, this.#terminalReason);
		return () => this.#terminalListeners.delete(listener);
	}

	get participant(): CollabParticipant {
		if (!this.#participant) throw new Error("Collab guest did not receive host participant identity");
		return this.#participant;
	}

	get identity(): RpcEndpointIdentity {
		if (!this.#identity) throw new Error("Collab guest did not receive authoritative host RPC identity");
		return this.#identity;
	}

	/** Forward every classified RPC command without consulting local replica semantics. */
	handleCommand(command: RpcCommand): Promise<RpcResponse> {
		if (!this.#settled || this.#closed) {
			return Promise.resolve(this.#responseError(command, "Collab host is unavailable", "unavailable"));
		}
		if (this.#pendingRequests.size >= MAX_PENDING_REQUESTS) {
			return Promise.resolve(this.#responseError(command, "Too many pending Collab RPC requests", "unavailable"));
		}
		const requestId = this.#nextRequestId++;
		const { promise, resolve } = Promise.withResolvers<RpcResponse>();
		const pending: PendingRequest = { command, resolve };
		if (!isRpcMutationCommand(command)) {
			pending.timer = setTimeout(() => {
				this.#pendingRequests.delete(requestId);
				resolve(this.#responseError(command, "Timed out reading authoritative Collab data", "unavailable"));
			}, REQUEST_TIMEOUT_MS);
			pending.timer.unref();
		}
		this.#pendingRequests.set(requestId, pending);
		if (!sendCollabRpcFrame(this.#transport, { t: "rpc-request", requestId, command })) {
			if (pending.timer) clearTimeout(pending.timer);
			this.#pendingRequests.delete(requestId);
			resolve(this.#responseError(command, "Collab host rejected the RPC request before dispatch", "unavailable"));
		}
		return promise;
	}

	/** Forward extension UI and host tool/URI side-channel responses to the authoritative host. */
	handleControlFrame(frame: RpcControlFrame): void {
		if (!this.#settled || this.#closed) return;
		if (!sendCollabRpcFrame(this.#transport, { t: "rpc-control", frame })) {
			this.#fail(new Error("Collab host rejected an RPC control frame"));
		}
	}

	async #applyFrame(frame: CollabFrame): Promise<void> {
		if (this.#closed) return;
		if (frame.t === "welcome") {
			if (frame.proto !== COLLAB_PROTO) {
				throw new Error(`Collab protocol mismatch: host speaks v${frame.proto}, guest expects v${COLLAB_PROTO}`);
			}
			if (this.#pendingSnapshot) throw new Error("Collab host sent a duplicate welcome before snapshot completion");
			const rpc = frame.rpc;
			if (!isRpcEndpointIdentity(rpc)) throw new Error("Collab host returned an invalid RPC identity");
			if (!frame.participant) throw new Error("Collab host returned an invalid participant identity");
			if (!Number.isSafeInteger(frame.entryCount) || frame.entryCount < 0) {
				throw new Error("Collab host returned an invalid snapshot entry count");
			}
			for (const capability of REQUIRED_HOST_CAPABILITIES) {
				if (!rpc.capabilities.includes(capability)) {
					throw new Error(`Collab host is missing required RPC capability: ${capability}`);
				}
			}
			this.#settled = false;
			this.#pendingSnapshot = {
				rpc,
				header: frame.header,
				state: frame.state,
				participant: frame.participant,
				entryCount: frame.entryCount,
				entries: [],
				entryIds: new Set(),
			};
			this.#armSnapshotTimeout();
			return;
		}
		if (frame.t === "snapshot-chunk") {
			if (this.#accumulateSnapshotChunk(frame)) await this.#finalizeSnapshot();
			return;
		}
		if (!this.#settled) {
			if (frame.t === "error") this.#fail(new Error(frame.message));
			else if (frame.t === "bye") this.#fail(new Error(`Collab session ended: ${frame.reason}`));
			return;
		}
		switch (frame.t) {
			case "entry":
				this.#session.sessionManager.ingestReplicatedEntry(frame.entry);
				this.#session.refreshReplicatedSessionContext();
				break;
			case "event":
				this.#emit(frame.event);
				break;
			case "state":
				this.#applyState(frame.state);
				break;
			case "rpc-result":
			case "rpc-mutation-result":
			case "rpc-read-result":
				this.#resolveRequest(frame.requestId, frame.response);
				break;
			case "rpc-output":
				this.#emit(frame.output);
				break;
			case "authority":
			case "agents":
			case "bus":
			case "ui-request":
			case "ui-request-end":
			case "transcript":
				this.#emitCollabFrame(frame);
				break;
			case "bye":
				this.#emitCollabFrame(frame);
				this.#fail(new Error(`Collab session ended: ${frame.reason}`));
				break;
			case "error":
				this.#emitCollabFrame(frame);
				break;
		}
	}

	#resolveRequest(requestId: number, response: RpcResponse): void {
		const pending = this.#pendingRequests.get(requestId);
		if (!pending) return;
		if (pending.timer) clearTimeout(pending.timer);
		this.#pendingRequests.delete(requestId);
		const command = pending.command;
		if (response.command !== command.type) {
			pending.resolve(
				this.#responseError(command, "Collab host returned a mismatched RPC response", "protocol-error"),
			);
			return;
		}
		if (!isRpcDurableMutationCommand(command)) {
			pending.resolve(response);
			return;
		}
		const context = command.mutation;
		if (!isRpcMutationContext(context)) {
			pending.resolve(response);
			return;
		}
		const receipt = response.receipt;
		const receiptFreeTerminal =
			!response.success &&
			receipt === undefined &&
			(response.code === "ambiguous" ||
				response.code === "unavailable" ||
				response.code === "read-only" ||
				response.code === "agentd-managed");
		const validReceipt =
			receipt !== undefined &&
			receipt.commandId === context.commandId &&
			receipt.runtimeId === context.runtimeId &&
			receipt.generation === context.generation &&
			receipt.operation === command.type &&
			receipt.fingerprint === fingerprintRpcMutation(command);
		pending.resolve(
			receiptFreeTerminal || validReceipt
				? response
				: this.#responseError(command, "Collab host returned an invalid mutation receipt", "protocol-error"),
		);
	}

	#accumulateSnapshotChunk(frame: SnapshotChunkFrame): boolean {
		const pending = this.#pendingSnapshot;
		if (!pending) throw new Error("Collab host sent a snapshot chunk without an active welcome");
		if (!Array.isArray(frame.entries) || typeof frame.final !== "boolean") {
			throw new Error("Collab host sent an invalid snapshot chunk");
		}
		if (pending.entries.length + frame.entries.length > pending.entryCount) {
			throw new Error("Collab snapshot exceeded the advertised entry count");
		}
		for (const entry of frame.entries) {
			if (!entry || typeof entry.id !== "string" || pending.entryIds.has(entry.id)) {
				throw new Error("Collab snapshot contained a duplicate or invalid entry");
			}
			pending.entryIds.add(entry.id);
			pending.entries.push(entry);
		}
		this.#armSnapshotTimeout();
		if (!frame.final) return false;
		if (pending.entries.length !== pending.entryCount) {
			throw new Error("Collab snapshot ended before the advertised entry count");
		}
		return true;
	}

	async #finalizeSnapshot(): Promise<void> {
		const pending = this.#pendingSnapshot;
		if (!pending || this.#closed) return;
		const replicaPath =
			this.#replicaPath ?? path.join(getConfigRootDir(), "collab", `${this.#roomId}.${this.#replicaId}.jsonl`);
		const contents = [pending.header, ...pending.entries].map(entry => JSON.stringify(entry)).join("\n");
		await Bun.write(replicaPath, `${contents}\n`);
		await this.#session.reloadReplicatedSession(replicaPath);
		this.#identity = pending.rpc;
		this.#participant = pending.participant;
		this.#applyState(pending.state);
		this.#pendingSnapshot = undefined;
		this.#settled = true;
		this.#clearSnapshotTimeout();
		this.#hydrated.resolve();
	}

	#applyState(state: CollabSessionState): void {
		this.state = state;
		if (state.model && !Bun.deepEquals(this.#session.agent.state.model, state.model)) {
			this.#session.agent.setModel(state.model);
		}
		const thinkingLevel = state.thinkingLevel as ThinkingLevel | undefined;
		this.#session.agent.setThinkingLevel(toReasoningEffort(thinkingLevel));
		this.#session.agent.setDisableReasoning(shouldDisableReasoning(thinkingLevel));
	}

	#emit(event: object): void {
		if (this.#listeners.size === 0) {
			if (this.#eventBacklog.length === EVENT_BACKLOG_LIMIT) this.#eventBacklog.shift();
			this.#eventBacklog.push(event);
			return;
		}
		for (const listener of this.#listeners) this.#notifyEventListener(listener, event);
	}

	#emitCollabFrame(frame: RpcCollabFrame): void {
		this.#emit({ type: "collab_frame", frame });
	}

	#notifyEventListener(listener: CollabRpcGuestEventListener, event: object): void {
		try {
			listener(event);
		} catch (error) {
			logger.warn("collab RPC guest event listener failed", { error: String(error) });
		}
	}

	#notifyTerminalListener(listener: CollabRpcGuestTerminalListener, reason: string): void {
		try {
			listener(reason);
		} catch (error) {
			logger.warn("collab RPC guest terminal listener failed", { error: String(error) });
		}
	}

	#responseError(command: Pick<RpcCommand, "id" | "type">, error: string, code: string): RpcResponse {
		return { id: command.id, type: "response", command: command.type, success: false, error, code };
	}

	#armSnapshotTimeout(): void {
		this.#clearSnapshotTimeout();
		this.#timer = setTimeout(
			() => this.#fail(new Error("timed out waiting for the Collab snapshot")),
			SNAPSHOT_TIMEOUT_MS,
		);
		this.#timer.unref();
	}

	#clearSnapshotTimeout(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#settlePending(reason: string, mutationCode: "ambiguous" | "unavailable"): void {
		for (const [requestId, pending] of this.#pendingRequests) {
			if (pending.timer) clearTimeout(pending.timer);
			const mutation = isRpcDurableMutationCommand(pending.command);
			pending.resolve(
				this.#responseError(
					pending.command,
					mutation ? `Collab mutation may have executed before terminal closure: ${reason}` : reason,
					mutation ? mutationCode : "unavailable",
				),
			);
			this.#pendingRequests.delete(requestId);
		}
	}

	#fail(error: unknown): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearSnapshotTimeout();
		this.#reassembler.close();
		const failure = error instanceof Error ? error : new Error(String(error));
		this.#terminalReason = failure.message;
		this.#settlePending(failure.message, "ambiguous");
		this.#transport.close();
		if (!this.#settled) this.#hydrated.reject(failure);
		for (const listener of this.#terminalListeners) this.#notifyTerminalListener(listener, failure.message);
	}
}
