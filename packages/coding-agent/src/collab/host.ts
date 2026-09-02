/**
 * Host side of a collab live session.
 *
 * Taps the host session's event stream and SessionManager append chokepoint,
 * broadcasting entries/events/state to guests through the relay. Guests prompt
 * and abort through us; the host machine runs the agent and tools. The host's
 * subagent ecosystem is mirrored too: task EventBus traffic (observer HUD),
 * agent-registry snapshots (Agent Hub table), hub chat/kill/revive commands,
 * and incremental subagent-transcript reads.
 */

import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type {
	BusChannel,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	AgentEvent as WireAgentEvent,
	SessionEntry as WireSessionEntry,
} from "@oh-my-pi/pi-wire";
import {
	isRpcMutationCommand,
	isRpcReadCommand,
	RPC_CAPABILITIES,
	type RpcCanonicalAuthority,
	type RpcCommand,
	type RpcCommandDispatchResult,
	type RpcResponse,
} from "../modes/rpc/rpc-types";
import type { InteractiveModeContext } from "../modes/types";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "../session/agent-session";
import { stripImagesFromMessage, USER_INTERRUPT_LABEL } from "../session/messages";
import type { SessionEntry as StoredSessionEntry } from "../session/session-entries";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task/types";
import type { EventBus } from "../utils/event-bus";
import { generateRoomKey, generateWriteToken, importRoomKey } from "./crypto";
import { collabDisplayName } from "./display-name";
import {
	type AgentSnapshot,
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	type CollabFrame,
	type CollabParticipant,
	type CollabPromptDetails,
	type CollabSessionState,
	formatCollabLink,
	formatCollabWebLink,
	generateRoomId,
	parseCollabLink,
} from "./protocol";
import { CollabSocket, type CollabTransport } from "./relay-client";
import { shrinkForReplication } from "./replication-shrink";
import { CollabRpcFrameReassembler, sendCollabRpcFrame } from "./rpc-frames";

/** Events that change the footer state guests render. */
const STATE_TRIGGER_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_end: true,
	tool_execution_end: true,
	thinking_level_changed: true,
	model_changed: true,
	advisor_cost_changed: true,
	auto_compaction_end: true,
};

const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
const STREAMING_STATE_INTERVAL_MS = 2000;
const WELCOME_IMAGE_STRIP_THRESHOLD = 24 * 1024 * 1024;
const COLLAB_RPC_CAPABILITIES = ["collab-rpc-guest", "rpc-all-commands", "rpc-inner-chunks"] as const;
const MAX_ACTIVE_RPC_REQUESTS = 256;
const WIRE_AGENT_EVENT_TYPES: Record<WireAgentEvent["type"], true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	notice: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	thinking_level_changed: true,
};

const WIRE_SESSION_ENTRY_TYPES: Record<WireSessionEntry["type"], true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
};
const COLLAB_BUS_CHANNELS = [
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
] as const satisfies readonly BusChannel[];

function isValidHerdrDisplayName(name: string): boolean {
	if (name.trim() !== name || Buffer.byteLength(name) > 64) return false;
	let scalars = 0;
	for (const char of name) {
		const code = char.codePointAt(0) ?? 0;
		if (++scalars > 64) return false;
		if (
			char === "[" ||
			char === "]" ||
			(code >= 0xd800 && code <= 0xdfff) ||
			code <= 0x1f ||
			(code >= 0x7f && code <= 0x9f) ||
			code === 0x2028 ||
			code === 0x2029 ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069) ||
			code === 0x200e ||
			code === 0x200f ||
			code === 0x61c ||
			code === 0x200b ||
			code === 0x200c ||
			code === 0x200d ||
			code === 0x2060 ||
			code === 0xfeff
		)
			return false;
	}
	return scalars > 0 && Bun.stringWidth(name, { countAnsiEscapeCodes: false }) <= 32;
}

function isValidHerdrDisplayNameRevision(revision: number | undefined): revision is number {
	return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 1;
}
type InboundGuestFrame = Extract<
	CollabFrame,
	{
		t:
			| "hello"
			| "prompt"
			| "abort"
			| "agent-cmd"
			| "ui-response"
			| "fetch-transcript"
			| "rpc-mutation"
			| "rpc-read"
			| "rpc-request"
			| "rpc-control";
	}
>;

/** Runtime boundary for untyped local bridge records before they enter host handlers. */
function isInboundGuestFrame(frame: unknown): frame is InboundGuestFrame {
	if (!frame || typeof frame !== "object") return false;
	const value = frame as Record<string, unknown>;
	switch (value.t) {
		case "hello":
			return (
				typeof value.proto === "number" &&
				typeof value.name === "string" &&
				(value.writeToken === undefined || typeof value.writeToken === "string")
			);
		case "prompt":
			return (
				typeof value.text === "string" &&
				(value.displayName === undefined || typeof value.displayName === "string") &&
				(value.images === undefined || Array.isArray(value.images))
			);
		case "abort":
			return true;
		case "agent-cmd":
			return (
				(value.cmd === "chat" || value.cmd === "kill" || value.cmd === "revive") &&
				typeof value.agentId === "string" &&
				(value.text === undefined || typeof value.text === "string")
			);
		case "ui-response":
			return typeof value.reqId === "number";
		case "fetch-transcript":
			return (
				typeof value.reqId === "number" && typeof value.agentId === "string" && typeof value.fromByte === "number"
			);
		case "rpc-mutation":
		case "rpc-read":
		case "rpc-request":
			return typeof value.requestId === "number" && isRecord(value.command);
		case "rpc-control":
			return isRecord(value.frame);
		default:
			return false;
	}
}

function isWireAgentEvent(event: AgentSessionEvent): event is AgentSessionEvent & WireAgentEvent {
	return event.type in WIRE_AGENT_EVENT_TYPES;
}

function isWireSessionEntry(entry: StoredSessionEntry): entry is StoredSessionEntry & WireSessionEntry {
	return entry.type in WIRE_SESSION_ENTRY_TYPES;
}
const CONNECT_TIMEOUT_MS = 15_000;
/** Max source bytes served per fetch-transcript reply (guest re-requests from `newSize`).
 * JSONL quotes/backslashes expand when embedded in bridge NDJSON, so keep this
 * well below the 2 MiB record cap with room for the frame wrapper. */
export const TRANSCRIPT_READ_CAP = 384 * 1024;
const TRANSCRIPT_ENTRY_TOO_LARGE_ERROR = `transcript entry exceeds transcript fetch cap (${TRANSCRIPT_READ_CAP} bytes)`;
/**
 * Soft byte cap per `snapshot-chunk` frame. The first MB of a snapshot takes
 * ~3s through the default relay, so a 512 KB chunk lands well under the
 * guest's 30 s per-chunk progress timeout; oversized single entries still
 * ship in a chunk of their own.
 */
const SNAPSHOT_CHUNK_BYTES = 512 * 1024;
/**
 * Outcome of {@link CollabHost.requestGuestUi}. `answered` carries the guest's
 * response (an `undefined` value is a genuine guest cancel); `unavailable`
 * means the collab channel went away (teardown, relay drop) or the request was
 * aborted before any guest answered — callers MUST NOT treat it as a cancel.
 */
export type CollabGuestUiResult = { kind: "answered"; value: CollabUiResponseValue } | { kind: "unavailable" };

export interface CollabHostTransportOptions {
	trustedLocal?: boolean;
	privateHost?: boolean;
	onTerminated?: (reason: string) => void;
	rpcAuthority?: Promise<RpcCanonicalAuthority>;
	/** Agentd owns session identity on this private route. */
	agentdManagedHost?: boolean;
}

type RpcResultFrameType = "rpc-result" | "rpc-mutation-result" | "rpc-read-result";

/** Narrow host surface shared by interactive and headless private bridges. */
export interface CollabHostContext {
	session: InteractiveModeContext["session"];
	sessionManager: InteractiveModeContext["sessionManager"];
	settings: Pick<InteractiveModeContext["settings"], "get">;
	subagentEventBus?: EventBus;
	eventBus?: EventBus;
	statusLine: Pick<
		InteractiveModeContext["statusLine"],
		"setCollabStatus" | "invalidate" | "getCachedContextBreakdown"
	>;
	ui: Pick<InteractiveModeContext["ui"], "requestRender">;
	showStatus: InteractiveModeContext["showStatus"];
	updatePendingMessagesDisplay: InteractiveModeContext["updatePendingMessagesDisplay"];
	collabHost?: CollabHost;
	herdrCollabHost?: CollabHost;
}

export class CollabHost {
	#ctx: CollabHostContext;
	#socket: CollabTransport | null = null;
	#link = "";
	#webLink = "";
	#viewLink = "";
	#webViewLink = "";
	#writeToken: Uint8Array | null = null;
	#sessionId = "";
	#unsubscribe?: () => void;
	#peers = new Map<number, { name: string; canWrite: boolean }>();
	#localPeerAuthority = new Map<number, boolean>();
	#rpcPeers = new Set<number>();
	#rpcAuthorityPromise: Promise<RpcCanonicalAuthority> | undefined;
	#agentdManagedHost = false;
	#rpcAuthority: RpcCanonicalAuthority | undefined;
	#rpcAuthorityEpoch = 0;
	#rpcAuthorityUnsubscribe: (() => void) | undefined;
	#rpcAuthoritySessionUnsubscribe: (() => void) | undefined;
	#rpcReassembler = new CollabRpcFrameReassembler();
	#activeRpcRequests = new Set<string>();
	#rpcSessionTransitions = new Set<string>();
	#uiReqSeq = 0;
	#pendingUi = new Map<number, { request: CollabUiRequest; settle(result: CollabGuestUiResult): void }>();
	#lastStateJson = "";
	#stateDebounce: Timer | null = null;
	#streamingInterval: Timer | null = null;
	#agentsDebounce: Timer | null = null;
	#busUnsubscribers: (() => void)[] = [];
	#registryUnsubscribe?: () => void;
	#stopped = false;
	#entryAppendedUnsubscribe?: () => void;

	#trustedLocalTransport = false;
	#privateHost = false;
	#requiresHerdrAttribution = false;
	#onTerminated?: (reason: string) => void;
	constructor(ctx: CollabHostContext) {
		this.#ctx = ctx;
	}

	get link(): string {
		return this.#link;
	}

	/** Browser deep link for the configured collab web UI. */
	get webLink(): string {
		return this.#webLink;
	}

	/** Read-only variant of {@link link}: bare room key, no write token. */
	get viewLink(): string {
		return this.#viewLink;
	}

	/** Read-only variant of {@link webLink}. */
	get webViewLink(): string {
		return this.#webViewLink;
	}

	get participants(): CollabParticipant[] {
		const list: CollabParticipant[] = [{ name: collabDisplayName(this.#ctx), role: "host" }];
		for (const peer of this.#peers.values()) {
			list.push({ name: peer.name, role: "guest", readOnly: peer.canWrite ? undefined : true });
		}
		return list;
	}

	requestGuestUi(request: CollabUiRequestDraft, signal?: AbortSignal): Promise<CollabGuestUiResult> | null {
		if (
			(this.#privateHost && this.#ctx.sessionManager.getSessionId() !== this.#sessionId) ||
			!this.#socket ||
			!this.#hasWritablePeers()
		)
			return null;
		const reqId = ++this.#uiReqSeq;
		const fullRequest: CollabUiRequest = { ...request, reqId };
		const { promise, resolve } = Promise.withResolvers<CollabGuestUiResult>();
		let settled = false;
		const settle = (result: CollabGuestUiResult): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			this.#pendingUi.delete(reqId);
			this.#sendWritablePeers({ t: "ui-request-end", reqId });
			resolve(result);
		};
		const onAbort = (): void => settle({ kind: "unavailable" });
		if (signal?.aborted) return Promise.resolve({ kind: "unavailable" });
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingUi.set(reqId, { request: fullRequest, settle });
		this.#sendWritablePeers({ t: "ui-request", request: fullRequest });
		return promise;
	}

	#hasWritablePeers(): boolean {
		for (const peer of this.#peers.values()) {
			if (peer.canWrite) return true;
		}
		return false;
	}

	#sendWritablePeers(frame: CollabFrame): void {
		const socket = this.#socket;
		if (!socket) return;
		for (const [peerId, peer] of this.#peers) {
			if (peer.canWrite) socket.send(frame, peerId);
		}
	}

	async start(relayUrl: string, webUrl = ""): Promise<void> {
		const rawKey = generateRoomKey();
		const writeToken = generateWriteToken();
		const roomId = generateRoomId();
		this.#writeToken = writeToken;
		this.#link = formatCollabLink(relayUrl, roomId, rawKey, writeToken);
		this.#webLink = formatCollabWebLink(relayUrl, roomId, rawKey, writeToken, webUrl);
		this.#viewLink = formatCollabLink(relayUrl, roomId, rawKey);
		this.#webViewLink = formatCollabWebLink(relayUrl, roomId, rawKey, undefined, webUrl);
		const parsed = parseCollabLink(this.#link);
		if ("error" in parsed) throw new Error(parsed.error);
		const key = await importRoomKey(rawKey);
		await this.startWithTransport(new CollabSocket({ wsUrl: parsed.wsUrl, role: "host", key }));
	}

	/** Start a trusted private bridge without creating a public relay room. */
	async startWithTransport(transport: CollabTransport, options: CollabHostTransportOptions = {}): Promise<void> {
		this.#trustedLocalTransport = options.trustedLocal === true || options.rpcAuthority !== undefined;
		this.#privateHost = options.privateHost === true;
		this.#onTerminated = options.onTerminated;
		this.#requiresHerdrAttribution = this.#trustedLocalTransport && transport.requiresHerdrAttribution === true;
		this.#rpcAuthorityPromise = options.rpcAuthority;
		this.#agentdManagedHost = options.agentdManagedHost === true;
		this.#socket = transport;
		this.#sessionId = this.#ctx.sessionManager.getSessionId();
		const firstOpen = Promise.withResolvers<void>();
		let opened = false;
		let terminalReason: string | undefined;
		transport.onOpen = () => {
			if (!opened) {
				opened = true;
				firstOpen.resolve();
			}
		};
		transport.onFrame = (frame, fromPeer, metadata) => {
			try {
				const reassembled = this.#rpcAuthorityPromise ? this.#rpcReassembler.push(frame, fromPeer) : undefined;
				const inbound = reassembled?.handled ? reassembled.frame : frame;
				if (!inbound) return;
				if (!isInboundGuestFrame(inbound)) {
					logger.warn("collab host rejected malformed inbound frame", { fromPeer });
					return;
				}
				this.#handleFrame(inbound, fromPeer, metadata);
			} catch (error) {
				logger.warn("collab host rejected invalid RPC chunks", { fromPeer, error: String(error) });
				this.#socket?.send({ t: "error", message: "invalid chunked RPC frame" }, fromPeer);
			}
		};
		transport.onControl = msg => {
			if (msg.t === "peer-left") this.#handlePeerLeft(msg.peer);
			else if (msg.t === "peer-authority") this.#setPeerAuthority(msg.peer, msg.canWrite);
		};
		transport.onClose = (reason, willReconnect) => {
			if (this.#stopped) return;
			if (!opened) {
				firstOpen.reject(new Error(reason));
				return;
			}
			if (willReconnect) {
				this.#ctx.showStatus(`Collab relay connection lost (${reason}), reconnecting…`, { dim: true });
				return;
			}
			terminalReason = reason;
			this.#notifyTerminated(reason);
			void this.#teardown();
			this.#emitCollabNotice("warning", `Collab ended: ${reason}`);
		};
		transport.connect();

		const timeout = setTimeout(
			() => firstOpen.reject(new Error("timed out connecting to relay")),
			CONNECT_TIMEOUT_MS,
		);
		try {
			await firstOpen.promise;
		} catch (error) {
			this.#stopped = true;
			transport.close();
			this.#socket = null;
			throw error;
		} finally {
			clearTimeout(timeout);
		}
		if (terminalReason !== undefined) throw new Error(terminalReason);
		if (this.#stopped) throw new Error("collab transport closed during startup");
		if (this.#privateHost && this.#rpcAuthorityPromise) {
			this.#rpcAuthoritySessionUnsubscribe = this.#ctx.session.registerSessionChangeCallback(() => {
				this.#rpcAuthorityEpoch++;
			});
		}
		this.#unsubscribe = this.#ctx.session.subscribe(event => {
			if (isWireAgentEvent(event)) this.#broadcast({ t: "event", event: shrinkForReplication(event) });
			this.#onEventForState(event);
		});
		const observabilityBus = this.#ctx.subagentEventBus ?? this.#ctx.eventBus;
		if (observabilityBus) {
			for (const channel of COLLAB_BUS_CHANNELS) {
				this.#busUnsubscribers.push(
					observabilityBus.on(channel, data => this.#broadcast({ t: "bus", channel, data })),
				);
			}
		}
		this.#registryUnsubscribe = AgentRegistry.global().onChange(() => this.#scheduleAgentsBroadcast());
		const entryListener = (entry: StoredSessionEntry): void => {
			if (isWireSessionEntry(entry)) this.#broadcast({ t: "entry", entry: shrinkForReplication(entry) });
			this.#scheduleStateBroadcast();
		};
		const subscribeEntryAppended = this.#ctx.sessionManager.subscribeEntryAppended;
		if (typeof subscribeEntryAppended === "function") {
			this.#entryAppendedUnsubscribe = subscribeEntryAppended.call(this.#ctx.sessionManager, entryListener);
		} else {
			const previous = this.#ctx.sessionManager.onEntryAppended;
			const handler = (entry: StoredSessionEntry): void => {
				previous?.(entry);
				entryListener(entry);
			};
			this.#ctx.sessionManager.onEntryAppended = handler;
			this.#entryAppendedUnsubscribe = () => {
				if (this.#ctx.sessionManager.onEntryAppended === handler) {
					this.#ctx.sessionManager.onEntryAppended = previous;
				}
			};
		}
		if (!this.#privateHost) this.#updateStatusSegment();
		if (this.#rpcAuthorityPromise) {
			void this.#getRpcAuthority().catch(error =>
				logger.warn("collab RPC authority initialization failed", { error: String(error) }),
			);
		}
	}

	/** Broadcast a goodbye, detach all taps, and close the socket. */
	async stop(reason: string): Promise<void> {
		if (this.#stopped) return;
		this.#socket?.send({ t: "bye", reason });
		await this.#teardown();
	}

	async #teardown(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#entryAppendedUnsubscribe?.();
		this.#entryAppendedUnsubscribe = undefined;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const unsubscribe of this.#busUnsubscribers) unsubscribe();
		this.#busUnsubscribers = [];
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
		clearTimeout(this.#stateDebounce ?? undefined);
		this.#stateDebounce = null;
		clearTimeout(this.#agentsDebounce ?? undefined);
		this.#agentsDebounce = null;
		clearInterval(this.#streamingInterval ?? undefined);
		this.#streamingInterval = null;
		for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
		this.#pendingUi.clear();
		this.#rpcAuthoritySessionUnsubscribe?.();
		this.#rpcAuthoritySessionUnsubscribe = undefined;
		this.#rpcAuthorityEpoch++;
		this.#rpcAuthorityUnsubscribe?.();
		this.#rpcAuthorityUnsubscribe = undefined;
		this.#rpcAuthority = undefined;
		this.#rpcAuthorityPromise = undefined;
		this.#agentdManagedHost = false;
		this.#rpcReassembler.close();
		this.#rpcPeers.clear();
		this.#activeRpcRequests.clear();
		this.#rpcSessionTransitions.clear();
		this.#localPeerAuthority.clear();
		this.#peers.clear();
		this.#socket?.close();
		this.#socket = null;
		if (this.#privateHost) {
			if (this.#ctx.herdrCollabHost === this) this.#ctx.herdrCollabHost = undefined;
		} else {
			if (this.#ctx.collabHost === this) this.#ctx.collabHost = undefined;
			this.#ctx.statusLine.setCollabStatus(null);
			this.#ctx.ui.requestRender();
		}
	}

	#broadcast(frame: CollabFrame): void {
		if (this.#stopped || !this.#socket || this.#rpcSessionTransitions.size > 0) return;
		if (this.#ctx.sessionManager.getSessionId() !== this.#sessionId) {
			if (this.#privateHost) return;
			void this.stop("session switched");
			this.#emitCollabNotice("warning", "Collab ended: session switched");
			return;
		}
		this.#socket.send(frame);
	}

	#emitCollabNotice(level: "info" | "warning", message: string): void {
		if (this.#privateHost) {
			logger.debug("private Herdr collab notice", { level, message });
			return;
		}
		this.#ctx.session.emitNotice(level, message, "collab");
	}

	#notifyTerminated(reason: string): void {
		try {
			this.#onTerminated?.(reason);
		} catch (error) {
			logger.warn("collab host termination observer failed", { error: String(error) });
		}
	}
	#handleFrame(
		frame: InboundGuestFrame,
		fromPeer: number,
		metadata?: { displayName?: string; displayNameRevision?: number },
	): void {
		if (this.#privateHost && this.#ctx.sessionManager.getSessionId() !== this.#sessionId) {
			if (frame.t === "ui-response") this.#pendingUi.get(frame.reqId)?.settle({ kind: "unavailable" });
			this.#socket?.send({ t: "error", message: "private collab route is rearming for a session switch" }, fromPeer);
			return;
		}
		switch (frame.t) {
			case "hello":
				void this.#handleHello(frame.name, frame.proto, frame.writeToken, fromPeer).catch(error => {
					logger.warn("collab host welcome failed", { fromPeer, error: String(error) });
					this.#socket?.send({ t: "error", message: "RPC authority failed to initialize" }, fromPeer);
				});
				break;
			case "prompt":
				this.#handlePrompt(
					frame.text,
					frame.images,
					metadata?.displayName,
					metadata?.displayNameRevision,
					fromPeer,
				);
				break;
			case "abort":
				this.#handleAbort(fromPeer);
				break;
			case "agent-cmd":
				this.#handleAgentCmd(frame.cmd, frame.agentId, frame.text, fromPeer);
				break;
			case "ui-response":
				this.#handleUiResponse(frame.reqId, frame.value, fromPeer);
				break;
			case "fetch-transcript":
				void this.#handleFetchTranscript(frame.reqId, frame.agentId, frame.fromByte, fromPeer);
				break;
			case "rpc-mutation":
				void this.#handleRpcMutation(frame.requestId, frame.command, fromPeer).catch(error =>
					logger.warn("collab RPC mutation transport failed", { fromPeer, error: String(error) }),
				);
				break;
			case "rpc-read":
				void this.#handleRpcRead(frame.requestId, frame.command, fromPeer).catch(error =>
					logger.warn("collab RPC read transport failed", { fromPeer, error: String(error) }),
				);
				break;
			case "rpc-request":
				void this.#handleRpcRequest(frame.requestId, frame.command, fromPeer, "rpc-result").catch(error =>
					logger.warn("collab RPC transport failed", { fromPeer, error: String(error) }),
				);
				break;
			case "rpc-control":
				void this.#handleRpcControl(frame.frame, fromPeer).catch(error =>
					logger.warn("collab RPC control failed", { fromPeer, error: String(error) }),
				);
				break;
		}
	}

	/** Timing-safe write-token check; peers without a valid token are read-only. */
	#verifyWriteToken(token: string | undefined): boolean {
		const expected = this.#writeToken;
		if (!expected || !token) return false;
		const bytes = Buffer.from(token, "base64url");
		return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
	}

	/** Reject a mutating frame from a read-only peer with a targeted error. */
	#rejectReadOnly(action: string, fromPeer: number): void {
		this.#socket?.send({ t: "error", message: `${action} is disabled on a read-only link` }, fromPeer);
	}

	async #handleHello(name: string, proto: number, writeToken: string | undefined, fromPeer: number): Promise<void> {
		if (proto !== COLLAB_PROTO) {
			this.#socket?.send(
				{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
				fromPeer,
			);
			return;
		}
		const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
		const canWrite = this.#trustedLocalTransport
			? this.#localPeerAuthority.get(fromPeer) === true
			: this.#verifyWriteToken(writeToken);
		this.#peers.set(fromPeer, { name: cleanName, canWrite });
		const authority = this.#rpcAuthorityPromise ? await this.#getRpcAuthority() : undefined;

		// Snapshot and send synchronously: no awaits between snapshot, welcome,
		// and chunk sends, so subsequent broadcast frames (entry/event/state/bus)
		// queue behind the snapshot on the same socket and the guest can't
		// observe a gap between the snapshot fragment and live traffic.
		const snapshot = this.#ctx.sessionManager.snapshotForReplication();
		if (JSON.stringify(snapshot).length > WELCOME_IMAGE_STRIP_THRESHOLD) {
			let stripped = 0;
			for (const entry of snapshot.entries) {
				if (entry.type === "message") stripped += stripImagesFromMessage(entry.message);
			}
			logger.info("collab welcome exceeded size threshold; stripped images", { stripped });
		}
		const entries = snapshot.entries.filter(isWireSessionEntry);
		const socket = this.#socket;
		if (!socket) return;
		socket.send(
			{
				t: "welcome",
				proto: COLLAB_PROTO,
				...(authority
					? {
							rpc: {
								...authority.identity,
								capabilities: [
									...new Set([
										...RPC_CAPABILITIES,
										...authority.identity.capabilities,
										...COLLAB_RPC_CAPABILITIES,
									]),
								],
							},
						}
					: {}),
				header: snapshot.header,
				state: this.#buildState(),
				agents: this.#snapshotAgents(),
				participant: { name: cleanName, role: "guest", readOnly: !canWrite },
				entryCount: entries.length,
				readOnly: canWrite ? undefined : true,
			},
			fromPeer,
		);
		this.#sendSnapshotChunks(entries, fromPeer);
		if (authority) this.#rpcPeers.add(fromPeer);
		if (canWrite) {
			for (const pending of this.#pendingUi.values()) {
				socket.send({ t: "ui-request", request: pending.request }, fromPeer);
			}
		}
		this.#emitCollabNotice("info", `${cleanName} joined the collab session${canWrite ? "" : " (read-only)"}`);
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	/**
	 * Slice {@link entries} into byte-bounded `snapshot-chunk` frames targeted
	 * at {@link fromPeer}. Each entry is first run through
	 * {@link shrinkForReplication} so a single oversized tool-result entry
	 * cannot ship as an oversized chunk that trips the relay's per-frame
	 * `maxPayloadLength` (issue #3739). Every batch carries at least one
	 * entry, and the last batch is tagged `final: true` so the guest can
	 * finalize the replica. An empty snapshot still emits one `final` chunk
	 * so the guest never blocks on a missing terminator.
	 */

	#sendSnapshotChunks(entries: (StoredSessionEntry & WireSessionEntry)[], fromPeer: number): void {
		const socket = this.#socket;
		if (!socket) return;
		if (entries.length === 0) {
			socket.send({ t: "snapshot-chunk", entries: [], final: true }, fromPeer);
			return;
		}
		let i = 0;
		while (i < entries.length) {
			const batch: (StoredSessionEntry & WireSessionEntry)[] = [];
			let batchBytes = 0;
			while (i < entries.length) {
				const entry = entries[i];
				if (!entry) break;
				const shrunk = shrinkForReplication(entry);
				const entryBytes = Buffer.byteLength(JSON.stringify(shrunk));
				if (batch.length > 0 && batchBytes + entryBytes > SNAPSHOT_CHUNK_BYTES) break;
				batch.push(shrunk);
				batchBytes += entryBytes;
				i++;
			}
			socket.send({ t: "snapshot-chunk", entries: batch, final: i >= entries.length }, fromPeer);
		}
	}

	async #getRpcAuthority(): Promise<RpcCanonicalAuthority> {
		if (this.#rpcAuthority) return this.#rpcAuthority;
		const pending = this.#rpcAuthorityPromise;
		if (!pending) throw new Error("Collab RPC is unavailable on this transport");
		const authority = await pending;
		if (this.#stopped) throw new Error("Collab host stopped before RPC authority became ready");
		if (this.#rpcAuthority) return this.#rpcAuthority;
		this.#rpcAuthority = authority;
		this.#rpcAuthorityEpoch++;
		this.#rpcAuthorityUnsubscribe = authority.subscribeOutput(output => this.#forwardRpcOutput(output));
		return authority;
	}

	#forwardRpcOutput(output: object): void {
		if (this.#stopped || !this.#socket || this.#rpcSessionTransitions.size > 0) return;
		if (isRecord(output) && output.type === "response") return;
		if (isWireAgentEvent(output as AgentSessionEvent)) return;
		if (
			isRecord(output) &&
			(output.type === "host_tool_call" ||
				output.type === "host_tool_cancel" ||
				output.type === "host_uri_request" ||
				output.type === "host_uri_cancel")
		)
			return;
		for (const peerId of this.#rpcPeers) {
			try {
				sendCollabRpcFrame(this.#socket, { t: "rpc-output", output }, peerId);
			} catch (error) {
				logger.warn("collab RPC output exceeded transport bounds", { peerId, error: String(error) });
			}
		}
	}

	#rpcFailure(command: Pick<RpcCommand, "id" | "type">, error: string, code: string): RpcResponse {
		return { id: command.id, type: "response", command: command.type, success: false, error, code };
	}

	async #handleRpcControl(frame: unknown, fromPeer: number): Promise<void> {
		if (!this.#rpcAuthorityPromise) return;
		const peer = this.#peers.get(fromPeer);
		if (!peer || !this.#rpcPeers.has(fromPeer)) return;
		if (!peer.canWrite) {
			this.#rejectReadOnly("RPC control", fromPeer);
			return;
		}
		if (
			isRecord(frame) &&
			(frame.type === "prepare_herdr_agentd_rebind" || frame.type === "clear_herdr_agentd_rebind")
		) {
			this.#socket?.send({ t: "error", message: "agentd rebind control is unavailable to Collab guests" }, fromPeer);
			return;
		}
		if (
			isRecord(frame) &&
			(frame.type === "host_tool_result" || frame.type === "host_tool_update" || frame.type === "host_uri_result")
		) {
			this.#socket?.send(
				{ t: "error", message: "host tool and URI responders are owned by the direct RPC client" },
				fromPeer,
			);
			return;
		}
		const authority = await this.#getRpcAuthority();
		if (!authority.dispatchControl(frame)) {
			this.#socket?.send({ t: "error", message: "invalid RPC control frame" }, fromPeer);
		}
	}

	async #handleRpcMutation(
		requestId: number,
		command: Extract<CollabFrame, { t: "rpc-mutation" }>["command"],
		fromPeer: number,
	): Promise<void> {
		await this.#handleRpcRequest(requestId, command, fromPeer, "rpc-mutation-result");
	}

	async #handleRpcRead(
		requestId: number,
		command: Extract<CollabFrame, { t: "rpc-read" }>["command"],
		fromPeer: number,
	): Promise<void> {
		await this.#handleRpcRequest(requestId, command, fromPeer, "rpc-read-result");
	}

	async #handleRpcRequest(
		requestId: number,
		command: RpcCommand,
		fromPeer: number,
		resultType: RpcResultFrameType,
	): Promise<void> {
		if (!this.#rpcAuthorityPromise) return;
		if (!Number.isSafeInteger(requestId) || requestId < 0) {
			this.#socket?.send({ t: "error", message: "invalid RPC request id" }, fromPeer);
			return;
		}
		const validCommand =
			resultType === "rpc-mutation-result"
				? isRpcMutationCommand(command)
				: resultType === "rpc-read-result"
					? isRpcReadCommand(command)
					: isRpcMutationCommand(command) || isRpcReadCommand(command);
		if (!validCommand) {
			await this.#sendRpcResult(
				resultType,
				requestId,
				this.#rpcFailure(command, `Unknown command: ${command.type}`, "protocol-error"),
				fromPeer,
			);
			return;
		}
		const requestKey = `${fromPeer}:${requestId}`;
		if (this.#activeRpcRequests.has(requestKey) || this.#activeRpcRequests.size >= MAX_ACTIVE_RPC_REQUESTS) {
			await this.#sendRpcResult(
				resultType,
				requestId,
				this.#rpcFailure(command, "Too many active or duplicate Collab RPC requests", "unavailable"),
				fromPeer,
			);
			return;
		}
		this.#activeRpcRequests.add(requestKey);
		const transition =
			command.type === "fork" ||
			command.type === "new_session" ||
			command.type === "switch_session" ||
			command.type === "branch";
		if (transition) this.#rpcSessionTransitions.add(requestKey);
		const predecessorSessionId = this.#ctx.sessionManager.getSessionId();
		let result: RpcCommandDispatchResult;
		try {
			const peer = this.#peers.get(fromPeer);
			if (!peer || !this.#rpcPeers.has(fromPeer)) {
				result = { response: this.#rpcFailure(command, "Collab RPC peer is unavailable", "unavailable") };
			} else if (isRpcMutationCommand(command) && !peer.canWrite) {
				result = {
					response: this.#rpcFailure(command, `${command.type} is disabled on a read-only link`, "read-only"),
				};
			} else if (
				command.type === "set_host_tools" ||
				command.type === "set_host_uri_schemes" ||
				command.type === "set_subagent_subscription"
			) {
				result = {
					response: this.#rpcFailure(command, `${command.type} is owned by the direct RPC client`, "unavailable"),
				};
			} else if (this.#agentdManagedHost && transition) {
				result = {
					response: this.#rpcFailure(
						command,
						"Session lifecycle transitions are managed by Agentd",
						"agentd-managed",
					),
				};
			} else {
				const authority = await this.#getRpcAuthority();
				const authorityEpoch = this.#rpcAuthorityEpoch;
				const handled = await authority.dispatch(command, {
					handleCollabUiResponse: uiResponse => {
						const pending = this.#pendingUi.get(uiResponse.reqId);
						if (!pending) {
							return this.#rpcFailure(uiResponse, `Unknown Collab UI request: ${uiResponse.reqId}`, "not-found");
						}
						pending.settle({ kind: "answered", value: uiResponse.value });
						return {
							id: uiResponse.id,
							type: "response",
							command: "collab_ui_response",
							success: true,
						};
					},
					validateExecution: this.#privateHost
						? queuedCommand => {
								if (
									this.#stopped ||
									this.#socket === null ||
									this.#ctx.sessionManager.getSessionId() !== predecessorSessionId ||
									this.#rpcAuthority !== authority ||
									this.#rpcAuthorityEpoch !== authorityEpoch
								) {
									return this.#rpcFailure(
										queuedCommand,
										"Private Collab RPC route was replaced before the command could execute",
										"unavailable",
									);
								}
								return undefined;
							}
						: undefined,
				});
				result = "response" in handled ? handled : { response: handled };
			}
		} catch (error) {
			result = {
				response: this.#rpcFailure(
					command,
					error instanceof Error ? error.message : String(error),
					isRpcMutationCommand(command) ? "ambiguous" : "unavailable",
				),
			};
		}
		try {
			await this.#sendRpcResult(resultType, requestId, result.response, fromPeer);
			const currentSessionId = this.#ctx.sessionManager.getSessionId();
			if (!this.#privateHost && currentSessionId !== this.#sessionId) this.#sessionId = currentSessionId;
			await result.afterResponse?.();
		} finally {
			this.#activeRpcRequests.delete(requestKey);
			this.#rpcSessionTransitions.delete(requestKey);
		}
	}

	async #sendRpcResult(
		resultType: RpcResultFrameType,
		requestId: number,
		response: RpcResponse,
		fromPeer: number,
	): Promise<void> {
		const socket = this.#socket;
		if (!socket) throw new Error("Collab transport closed before the RPC response was sent");
		const frame: CollabFrame =
			resultType === "rpc-result"
				? { t: "rpc-result", requestId, response }
				: resultType === "rpc-mutation-result"
					? { t: "rpc-mutation-result", requestId, response }
					: { t: "rpc-read-result", requestId, response };
		sendCollabRpcFrame(socket, frame, fromPeer);
		await socket.flush?.();
	}

	#handleUiResponse(reqId: number, value: CollabUiResponseValue, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("responding to ask", fromPeer);
			return;
		}
		this.#pendingUi.get(reqId)?.settle({ kind: "answered", value });
	}

	#handlePrompt(
		text: string,
		images: ImageContent[] | undefined,
		displayName: string | undefined,
		displayNameRevision: number | undefined,
		fromPeer: number,
	): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("prompting", fromPeer);
			return;
		}
		if (
			this.#requiresHerdrAttribution &&
			(typeof displayName !== "string" ||
				!isValidHerdrDisplayName(displayName) ||
				!isValidHerdrDisplayNameRevision(displayNameRevision))
		) {
			this.#socket?.send(
				{ t: "error", message: "trusted local prompt is missing valid attribution or display name revision" },
				fromPeer,
			);
			return;
		}
		const name = this.#requiresHerdrAttribution ? displayName : peer.name;
		const attributedText = this.#requiresHerdrAttribution ? `[${name}] says: ${text}` : text;
		const content: string | (TextContent | ImageContent)[] =
			images && images.length > 0 ? [{ type: "text", text: attributedText }, ...images] : attributedText;
		const details: CollabPromptDetails = this.#requiresHerdrAttribution
			? { from: name, displayNameRevision }
			: { from: name };
		if (this.#ctx.session.isStreaming) {
			this.#ctx.updatePendingMessagesDisplay();
			this.#ctx.ui.requestRender();
			this.#scheduleStateBroadcast();
		}
		this.#ctx.session
			.promptCustomMessage(
				{
					customType: COLLAB_PROMPT_MESSAGE_TYPE,
					content,
					display: true,
					details,
					attribution: "user",
				},
				{ streamingBehavior: "steer", queueChipText: attributedText },
			)
			.catch(err => {
				logger.warn("collab guest prompt failed", { error: String(err) });
				this.#socket?.send({ t: "error", message: `prompt failed: ${String(err)}` }, fromPeer);
			});
	}

	#handleAbort(fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("interrupting", fromPeer);
			return;
		}
		const name = peer.name;
		void this.#ctx.session
			.abort({ reason: USER_INTERRUPT_LABEL })
			.then(() => this.#emitCollabNotice("info", `${name} interrupted`))
			.catch(err => logger.warn("collab guest abort failed", { error: String(err) }));
	}

	#handlePeerLeft(peer: number): void {
		const name = this.#peers.get(peer)?.name;
		this.#peers.delete(peer);
		this.#rpcPeers.delete(peer);
		for (const requestKey of this.#activeRpcRequests) {
			if (requestKey.startsWith(`${peer}:`)) this.#activeRpcRequests.delete(requestKey);
		}
		this.#localPeerAuthority.delete(peer);
		if (!this.#privateHost && !this.#hasWritablePeers()) {
			for (const pending of [...this.#pendingUi.values()]) pending.settle({ kind: "unavailable" });
		}
		if (name) this.#emitCollabNotice("info", `${name} left the collab session`);
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	#setPeerAuthority(peer: number, canWrite: boolean): void {
		if (!this.#trustedLocalTransport) return;
		this.#localPeerAuthority.set(peer, canWrite);
		const participant = this.#peers.get(peer);
		if (!participant || participant.canWrite === canWrite) return;
		participant.canWrite = canWrite;
		this.#socket?.send({ t: "authority", canWrite }, peer);
		if (canWrite) {
			for (const pending of this.#pendingUi.values()) {
				this.#socket?.send({ t: "ui-request", request: pending.request }, peer);
			}
		} else {
			if (!this.#privateHost && !this.#hasWritablePeers()) {
				for (const pending of [...this.#pendingUi.values()]) pending.settle({ kind: "unavailable" });
			} else {
				for (const reqId of this.#pendingUi.keys()) this.#socket?.send({ t: "ui-request-end", reqId }, peer);
			}
		}
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	#buildState(): CollabSessionState {
		const session = this.#ctx.session;
		// Context numbers come from the status line's memoized breakdown so guests
		// render exactly the same anchored, provider-real count the host's own
		// status line shows.
		const breakdown = this.#ctx.statusLine.getCachedContextBreakdown();
		const tokens = breakdown.usedTokens ?? 0;
		return {
			isStreaming: session.isStreaming,
			isAborting: session.isAborting,
			queuedMessageCount: session.queuedMessageCount,
			sessionName: session.sessionName,
			cwd: this.#ctx.sessionManager.getCwd(),
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			contextUsage: {
				tokens,
				contextWindow: breakdown.contextWindow,
				percent: breakdown.contextWindow > 0 ? (tokens / breakdown.contextWindow) * 100 : 0,
			},
			participants: this.participants,
		};
	}

	#onEventForState(event: AgentSessionEvent): void {
		if (!STATE_TRIGGER_EVENTS[event.type]) return;
		this.#scheduleStateBroadcast();
		if (event.type === "agent_start" && !this.#streamingInterval) {
			this.#streamingInterval = setInterval(() => this.#scheduleStateBroadcast(), STREAMING_STATE_INTERVAL_MS);
		} else if (event.type === "agent_end" && this.#streamingInterval) {
			clearInterval(this.#streamingInterval);
			this.#streamingInterval = null;
		}
	}

	#snapshotAgents(): AgentSnapshot[] {
		return (
			AgentRegistry.global()
				.list()
				// Advisor transcripts are local observability only; never mirror them to
				// guests (the wire AgentSnapshot kind has no `advisor`, and guests must not
				// be able to chat/kill/revive them).
				.filter((ref): ref is AgentRef & { kind: "main" | "sub" } => ref.kind !== "advisor")
				.map(ref => ({
					id: ref.id,
					displayName: ref.displayName,
					kind: ref.kind,
					parentId: ref.parentId,
					status: ref.status,
					hasSessionFile: !!ref.sessionFile,
					createdAt: ref.createdAt,
					lastActivity: ref.lastActivity,
				}))
		);
	}

	#scheduleAgentsBroadcast(): void {
		if (this.#stopped || this.#agentsDebounce) return;
		this.#agentsDebounce = setTimeout(() => {
			this.#agentsDebounce = null;
			this.#broadcast({ t: "agents", agents: this.#snapshotAgents() });
		}, AGENTS_DEBOUNCE_MS);
	}

	#handleAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text: string | undefined, fromPeer: number): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("agent control", fromPeer);
			return;
		}
		// Advisor refs are excluded from snapshots, but reject control by id defensively:
		// a stale/malicious client must never chat/kill/revive a read-only advisor transcript.
		if (AgentRegistry.global().get(agentId)?.kind === "advisor") {
			this.#socket?.send({ t: "error", message: `agent ${agentId}: advisor transcripts are read-only` }, fromPeer);
			return;
		}
		const fail = (err: unknown) => {
			logger.warn("collab agent-cmd failed", { cmd, agentId, error: String(err) });
			this.#socket?.send({ t: "error", message: `agent ${agentId}: ${String(err)}` }, fromPeer);
		};
		switch (cmd) {
			case "chat": {
				const trimmed = text?.trim();
				if (!trimmed) {
					this.#socket?.send({ t: "error", message: `agent ${agentId}: empty chat message` }, fromPeer);
					return;
				}
				// Mirrors the hub's #submitChatMessage: revive if parked, steer if mid-turn.
				AgentLifecycleManager.global()
					.ensureLive(agentId)
					.then(session => session.prompt(trimmed, { streamingBehavior: "steer" }))
					.catch(fail);
				break;
			}
			case "kill": {
				const kill = async () => {
					const ref = AgentRegistry.global().get(agentId);
					if (!ref) return;
					if (ref.status === "running" && ref.session) {
						await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
					}
					await AgentLifecycleManager.global().release(agentId, ref, { tombstone: true });
				};
				kill().catch(fail);
				break;
			}
			case "revive":
				AgentLifecycleManager.global().ensureLive(agentId).catch(fail);
				break;
		}
	}

	/** Incremental transcript read mirroring the hub's readFileIncremental contract. */
	async #handleFetchTranscript(reqId: number, agentId: string, fromByte: number, fromPeer: number): Promise<void> {
		const reply = (text: string, newSize: number, error?: string) =>
			this.#socket?.send({ t: "transcript", reqId, text, newSize, error }, fromPeer);
		const file = AgentRegistry.global().get(agentId)?.sessionFile;
		if (!file) {
			reply("", fromByte, "no transcript available");
			return;
		}
		try {
			const stat = await fs.stat(file);
			if (stat.size <= fromByte) {
				reply("", stat.size);
				return;
			}
			const want = Math.min(stat.size - fromByte, TRANSCRIPT_READ_CAP);
			const handle = await fs.open(file, "r");
			let bytesRead: number;
			const buf = Buffer.allocUnsafe(want);
			try {
				({ bytesRead } = await handle.read(buf, 0, want, fromByte));
			} finally {
				await handle.close();
			}
			let slice = buf.subarray(0, bytesRead);
			const reachedEof = fromByte + bytesRead >= stat.size;
			if (!reachedEof) {
				// Trim to the last complete JSONL line so no line or UTF-8 char is split.
				const lastNewline = slice.lastIndexOf(0x0a);
				if (lastNewline < 0) {
					reply("", fromByte, TRANSCRIPT_ENTRY_TOO_LARGE_ERROR);
					return;
				}
				slice = slice.subarray(0, lastNewline + 1);
			}
			reply(slice.toString("utf-8"), reachedEof ? stat.size : fromByte + slice.byteLength);
		} catch (err) {
			logger.debug("collab transcript read failed", { agentId, error: String(err) });
			reply("", fromByte, String(err));
		}
	}

	#scheduleStateBroadcast(): void {
		if (this.#stopped || this.#stateDebounce) return;
		this.#stateDebounce = setTimeout(() => {
			this.#stateDebounce = null;
			const state = this.#buildState();
			const json = JSON.stringify(state);
			if (json === this.#lastStateJson) return;
			this.#lastStateJson = json;
			this.#broadcast({ t: "state", state });
		}, STATE_DEBOUNCE_MS);
	}

	#updateStatusSegment(): void {
		if (this.#privateHost) return;
		this.#ctx.statusLine.setCollabStatus({ role: "host", participantCount: this.#peers.size + 1 });
		this.#ctx.statusLine.invalidate();
		this.#ctx.ui.requestRender();
	}
}
