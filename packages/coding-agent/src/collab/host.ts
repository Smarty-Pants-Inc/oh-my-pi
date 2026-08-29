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
import { logger } from "@oh-my-pi/pi-utils";
import type {
	BusChannel,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	AgentEvent as WireAgentEvent,
	SessionEntry as WireSessionEntry,
} from "@oh-my-pi/pi-wire";
import {
	isRpcHostToolResult,
	isRpcHostToolUpdate,
	normalizeHostToolDefinitions,
	RpcHostToolBridge,
} from "../modes/rpc/host-tools";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
} from "../modes/rpc/rpc-types";
import type { InteractiveModeContext } from "../modes/types";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionEvent } from "../session/agent-session";
import { stripImagesFromMessage, USER_INTERRUPT_LABEL } from "../session/messages";
import type { SessionEntry as StoredSessionEntry } from "../session/session-entries";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task/types";
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

/** Events that change the footer state guests render. */
const STATE_TRIGGER_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_end: true,
	tool_execution_end: true,
	thinking_level_changed: true,
	model_changed: true,
	auto_compaction_end: true,
};

const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
const STREAMING_STATE_INTERVAL_MS = 2000;
const WELCOME_IMAGE_STRIP_THRESHOLD = 24 * 1024 * 1024;
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
			| "set-host-tools"
			| "host-tool-update"
			| "host-tool-result";
	}
>;

type HostToolOwner = { peerId: number; bridge: RpcHostToolBridge };
type HostToolRegistrationFence = {
	peerId: number;
	peerGeneration: number;
	transport: CollabTransport;
	transportGeneration: number;
	sessionId: string;
};

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
		case "set-host-tools":
			return typeof value.reqId === "number" && Number.isSafeInteger(value.reqId) && Array.isArray(value.tools);
		case "host-tool-update":
			return isRpcHostToolUpdate(value.frame);
		case "host-tool-result":
			return isRpcHostToolResult(value.frame);
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

export class CollabHost {
	#ctx: InteractiveModeContext;
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
	#uiReqSeq = 0;
	#pendingUi = new Map<number, { request: CollabUiRequest; settle(result: CollabGuestUiResult): void }>();
	#hostToolOwner: HostToolOwner | undefined;
	#hostToolMutationTail: Promise<void> = Promise.resolve();
	#pendingHostToolRegistrations = new Map<number, number>();
	#hostToolPeerGenerations = new Map<number, number>();
	#hostToolTransportGeneration = 0;
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
	constructor(ctx: InteractiveModeContext) {
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

	/** Start over an injected transport instead of a relay link. */
	async startWithTransport(
		transport: CollabTransport,
		opts: { trustedLocal?: boolean; privateHost?: boolean; onTerminated?: (reason: string) => void } = {},
	): Promise<void> {
		this.#trustedLocalTransport = opts.trustedLocal === true;
		this.#privateHost = opts.privateHost === true;
		this.#onTerminated = opts.onTerminated;
		this.#requiresHerdrAttribution = this.#trustedLocalTransport && transport.requiresHerdrAttribution === true;
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
			if (!isInboundGuestFrame(frame)) {
				logger.warn("collab host rejected malformed inbound frame", { fromPeer });
				return;
			}
			this.#handleFrame(frame, fromPeer, metadata);
		};
		transport.onControl = msg => {
			if (msg.t === "peer-left") this.#handlePeerLeft(msg.peer);
			else if (msg.t === "peer-authority") this.#setPeerAuthority(msg.peer, msg.canWrite);
		};
		transport.onClose = (reason, willReconnect) => {
			if (this.#stopped) return;
			if (!opened) {
				this.#invalidateHostTools(
					undefined,
					`Collab connection lost before host tool execution completed: ${reason}`,
				);
				firstOpen.reject(new Error(reason));
				return;
			}
			if (willReconnect) {
				this.#invalidateHostTools(
					undefined,
					`Collab connection lost before host tool execution completed: ${reason}`,
				);
				this.#ctx.showStatus(`Collab relay connection lost (${reason}), reconnecting…`, { dim: true });
			} else {
				terminalReason = reason;
				this.#notifyTerminated(reason);
				void this.#teardown();
				this.#emitCollabNotice("warning", `Collab ended: ${reason}`);
			}
		};
		transport.connect();

		const timeout = setTimeout(
			() => firstOpen.reject(new Error("timed out connecting to relay")),
			CONNECT_TIMEOUT_MS,
		);
		try {
			await firstOpen.promise;
		} catch (err) {
			this.#stopped = true;
			transport.close();
			this.#socket = null;
			throw err;
		} finally {
			clearTimeout(timeout);
		}
		if (terminalReason !== undefined) throw new Error(terminalReason);
		if (this.#stopped) throw new Error("collab transport closed during startup");

		this.#unsubscribe = this.#ctx.session.subscribe(event => {
			if (isWireAgentEvent(event)) this.#broadcast({ t: "event", event: shrinkForReplication(event) });
			this.#onEventForState(event);
		});
		const bus = this.#ctx.eventBus;
		if (bus) {
			for (const channel of COLLAB_BUS_CHANNELS) {
				this.#busUnsubscribers.push(bus.on(channel, data => this.#broadcast({ t: "bus", channel, data })));
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
		this.#invalidateHostTools(undefined, "Collab host stopped before host tool execution completed");
		await this.#hostToolMutationTail;
		this.#peers.clear();
		this.#localPeerAuthority.clear();
		this.#pendingHostToolRegistrations.clear();
		this.#hostToolPeerGenerations.clear();
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
		if (this.#stopped || !this.#socket) return;
		if (this.#ctx.sessionManager.getSessionId() !== this.#sessionId) {
			this.#invalidateHostTools(undefined, "Collab route changed before host tool execution completed");
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
			this.#invalidateHostTools(undefined, "Collab route changed before host tool execution completed");
			if (frame.t === "ui-response") this.#pendingUi.get(frame.reqId)?.settle({ kind: "unavailable" });
			if (frame.t === "set-host-tools") {
				this.#socket?.send(
					{
						t: "host-tools-set",
						reqId: frame.reqId,
						error: "private collab route is rearming for a session switch",
					},
					fromPeer,
				);
			} else {
				this.#socket?.send(
					{ t: "error", message: "private collab route is rearming for a session switch" },
					fromPeer,
				);
			}
			return;
		}
		switch (frame.t) {
			case "hello":
				this.#handleHello(frame.name, frame.proto, frame.writeToken, fromPeer);
				break;
			case "prompt":
				this.#handlePrompt(
					frame.text,
					frame.images,
					frame.streamingBehavior,
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
			case "set-host-tools":
				this.#handleSetHostTools(frame.reqId, frame.tools, fromPeer);
				break;
			case "host-tool-update":
				this.#handleHostToolUpdate(frame.frame, fromPeer);
				break;
			case "host-tool-result":
				this.#handleHostToolResult(frame.frame, fromPeer);
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

	#handleHello(name: string, proto: number, writeToken: string | undefined, fromPeer: number): void {
		if (proto !== COLLAB_PROTO) {
			this.#socket?.send(
				{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
				fromPeer,
			);
			return;
		}
		this.#invalidateHostTools(fromPeer, "Collab host tool guest was replaced");
		const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
		const canWrite = this.#trustedLocalTransport
			? this.#localPeerAuthority.get(fromPeer) === true
			: this.#verifyWriteToken(writeToken);
		this.#peers.set(fromPeer, { name: cleanName, canWrite });

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
				header: snapshot.header,
				state: this.#buildState(),
				agents: this.#snapshotAgents(),
				entryCount: entries.length,
				readOnly: canWrite ? undefined : true,
			},
			fromPeer,
		);
		this.#sendSnapshotChunks(entries, fromPeer);
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
	#handleUiResponse(reqId: number, value: CollabUiResponseValue, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("responding to ask", fromPeer);
			return;
		}
		this.#pendingUi.get(reqId)?.settle({ kind: "answered", value });
	}

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

	#handlePrompt(
		text: string,
		images: ImageContent[] | undefined,
		streamingBehavior: "steer" | "followUp" | undefined,
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
				{
					streamingBehavior: streamingBehavior === "followUp" ? "followUp" : "steer",
					queueChipText: attributedText,
				},
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
		this.#invalidateHostTools(peer, "Collab host tool guest disconnected");
		this.#peers.delete(peer);
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
			this.#invalidateHostTools(peer, "Collab host tool guest lost controller authority");
			if (!this.#privateHost && !this.#hasWritablePeers()) {
				for (const pending of [...this.#pendingUi.values()]) pending.settle({ kind: "unavailable" });
			} else {
				for (const reqId of this.#pendingUi.keys()) this.#socket?.send({ t: "ui-request-end", reqId }, peer);
			}
		}
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	#handleSetHostTools(reqId: number, definitions: RpcHostToolDefinition[], fromPeer: number): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#sendHostToolsSet(fromPeer, {
				t: "host-tools-set",
				reqId,
				error: "registering host tools is disabled on a read-only link",
			});
			return;
		}
		const fence = this.#captureHostToolRegistration(fromPeer);
		if (!fence) {
			if (this.#ctx.sessionManager.getSessionId() !== this.#sessionId) {
				this.#invalidateHostTools(undefined, "Collab route changed before host tool execution completed");
			}
			this.#sendHostToolsSet(fromPeer, { t: "host-tools-set", reqId, error: "Collab transport is unavailable" });
			return;
		}
		this.#pendingHostToolRegistrations.set(fromPeer, (this.#pendingHostToolRegistrations.get(fromPeer) ?? 0) + 1);
		this.#hostToolMutationTail = this.#hostToolMutationTail
			.then(async () => {
				if (!this.#isHostToolRegistrationAccepted(fence)) {
					this.#sendHostToolsSet(fromPeer, {
						t: "host-tools-set",
						reqId,
						error: "Collab host tool registration is no longer accepted",
					});
					return;
				}
				const tools = normalizeHostToolDefinitions(definitions);
				const previous = this.#hostToolOwner;
				let owner = previous?.peerId === fromPeer ? previous : undefined;
				if (!owner) {
					let nextOwner: HostToolOwner;
					const bridge = new RpcHostToolBridge(frame => this.#sendHostToolRequest(nextOwner, frame));
					nextOwner = { peerId: fromPeer, bridge };
					if (previous) {
						previous.bridge.close("Collab host tool guest was replaced", this.#canSendHostToolOwner(previous));
					}
					owner = nextOwner;
					this.#hostToolOwner = owner;
				}
				try {
					await this.#ctx.session.refreshRpcHostTools(owner.bridge.setTools(tools));
				} catch (error) {
					if (owner !== previous && this.#hostToolOwner === owner) {
						this.#hostToolOwner = undefined;
						owner.bridge.close("Collab host tool registration failed");
						await this.#ctx.session.refreshRpcHostTools([]);
					}
					throw error;
				}
				if (this.#hostToolOwner !== owner || !this.#isHostToolRegistrationAccepted(fence)) {
					if (this.#hostToolOwner === owner) {
						this.#hostToolOwner = undefined;
						owner.bridge.close("Collab host tool registration expired");
						await this.#ctx.session.refreshRpcHostTools([]);
					}
					this.#sendHostToolsSet(fromPeer, {
						t: "host-tools-set",
						reqId,
						error: "Collab host tool registration is no longer accepted",
					});
					return;
				}
				if (
					!this.#sendHostToolsSet(fromPeer, {
						t: "host-tools-set",
						reqId,
						toolNames: tools.map(tool => tool.name),
					})
				) {
					this.#invalidateHostTools(fromPeer, "Collab host tool guest is unavailable");
				}
			})
			.catch(error => {
				logger.warn("collab host tool registration failed", { error: String(error) });
				this.#sendHostToolsSet(fromPeer, {
					t: "host-tools-set",
					reqId,
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				const remaining = (this.#pendingHostToolRegistrations.get(fromPeer) ?? 1) - 1;
				if (remaining > 0) this.#pendingHostToolRegistrations.set(fromPeer, remaining);
				else this.#pendingHostToolRegistrations.delete(fromPeer);
			});
	}

	#captureHostToolRegistration(peerId: number): HostToolRegistrationFence | undefined {
		const transport = this.#socket;
		const sessionId = this.#ctx.sessionManager.getSessionId();
		if (this.#stopped || !transport?.isOpen || !this.#peers.get(peerId)?.canWrite || sessionId !== this.#sessionId)
			return undefined;
		return {
			peerId,
			peerGeneration: this.#hostToolPeerGenerations.get(peerId) ?? 0,
			transport,
			transportGeneration: this.#hostToolTransportGeneration,
			sessionId,
		};
	}

	#isHostToolRegistrationAccepted(fence: HostToolRegistrationFence): boolean {
		return (
			!this.#stopped &&
			this.#socket === fence.transport &&
			fence.transport.isOpen &&
			this.#hostToolTransportGeneration === fence.transportGeneration &&
			(this.#hostToolPeerGenerations.get(fence.peerId) ?? 0) === fence.peerGeneration &&
			this.#ctx.sessionManager.getSessionId() === fence.sessionId &&
			fence.sessionId === this.#sessionId &&
			this.#peers.get(fence.peerId)?.canWrite === true
		);
	}

	#sendHostToolsSet(peerId: number, frame: Extract<CollabFrame, { t: "host-tools-set" }>): boolean {
		const socket = this.#socket;
		if (this.#stopped || !socket?.isOpen) return false;
		try {
			return socket.send(frame, peerId);
		} catch {
			return false;
		}
	}

	#canSendHostToolOwner(owner: HostToolOwner): boolean {
		return (
			!this.#stopped &&
			this.#hostToolOwner === owner &&
			this.#peers.get(owner.peerId)?.canWrite === true &&
			this.#socket?.isOpen === true
		);
	}

	#sendHostToolRequest(owner: HostToolOwner, frame: RpcHostToolCallRequest | RpcHostToolCancelRequest): void {
		const socket = this.#socket;
		if (this.#hostToolOwner !== owner || !this.#peers.get(owner.peerId)?.canWrite) {
			owner.bridge.close("Collab host tool guest is unavailable");
			return;
		}
		if (this.#stopped || !socket?.isOpen) {
			this.#invalidateHostTools(owner.peerId, "Collab host tool guest is unavailable");
			return;
		}
		const sent = socket.send(
			frame.type === "host_tool_call" ? { t: "host-tool-call", frame } : { t: "host-tool-cancel", frame },
			owner.peerId,
		);
		if (!sent) this.#invalidateHostTools(owner.peerId, "Collab host tool guest is unavailable");
	}

	#handleHostToolUpdate(frame: RpcHostToolUpdate, fromPeer: number): void {
		const bridge = this.#hostToolReplyBridge(fromPeer);
		if (bridge) bridge.handleUpdate(frame);
	}

	#handleHostToolResult(frame: RpcHostToolResult, fromPeer: number): void {
		const bridge = this.#hostToolReplyBridge(fromPeer);
		if (bridge) bridge.handleResult(frame);
	}

	#hostToolReplyBridge(fromPeer: number): RpcHostToolBridge | undefined {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("responding to host tools", fromPeer);
			return undefined;
		}
		if (this.#hostToolOwner?.peerId !== fromPeer) {
			this.#socket?.send({ t: "error", message: "host tool calls belong to another collab guest" }, fromPeer);
			return undefined;
		}
		return this.#hostToolOwner.bridge;
	}

	#invalidateHostTools(peerId: number | undefined, message: string): void {
		if (peerId === undefined) {
			this.#hostToolTransportGeneration++;
		} else {
			this.#hostToolPeerGenerations.set(peerId, (this.#hostToolPeerGenerations.get(peerId) ?? 0) + 1);
		}
		const owner = this.#hostToolOwner;
		const needsCleanup =
			(peerId === undefined
				? this.#pendingHostToolRegistrations.size > 0
				: (this.#pendingHostToolRegistrations.get(peerId) ?? 0) > 0) ||
			(owner !== undefined && (peerId === undefined || owner.peerId === peerId));
		if (owner && (peerId === undefined || owner.peerId === peerId)) {
			this.#hostToolOwner = undefined;
			owner.bridge.close(message);
		}
		if (!needsCleanup) return;
		this.#hostToolMutationTail = this.#hostToolMutationTail
			.then(async () => {
				const current = this.#hostToolOwner;
				if (peerId !== undefined && current && current.peerId !== peerId) return;
				if (current) {
					this.#hostToolOwner = undefined;
					current.bridge.close(message);
				}
				await this.#ctx.session.refreshRpcHostTools([]);
			})
			.catch(error => logger.warn("collab host tool cleanup failed", { error: String(error) }));
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
