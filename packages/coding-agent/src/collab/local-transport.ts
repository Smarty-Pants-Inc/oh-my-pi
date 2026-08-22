import { OMP_BUILD_ID } from "../build-identity";
import {
	type CollabFrame,
	MAX_LOCAL_BRIDGE_INBOUND_RECORD_BYTES,
	MAX_LOCAL_BRIDGE_OUTBOUND_RECORD_BYTES,
} from "./protocol";
import type { CollabTransport, CollabTransportControl } from "./relay-client";

const MAX_MALFORMED_RECORDS = 16;

type BridgeFrameRecord = {
	t: "frame";
	fromPeer?: number;
	displayName?: string;
	displayNameRevision?: number;
	frame: CollabFrame;
};

export class NdjsonRecordParser {
	#pending = "";
	#malformed = 0;
	#pendingBytes = 0;
	#decoder = new TextDecoder();

	push(chunk: Uint8Array | string): unknown[] {
		this.#pendingBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
		this.#pending += typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
		const records: unknown[] = [];
		let newline = this.#pending.indexOf("\n");
		while (newline >= 0) {
			const line = this.#pending.slice(0, newline);
			this.#pending = this.#pending.slice(newline + 1);
			const recordBytes = Buffer.byteLength(`${line}\n`);
			this.#pendingBytes = Math.max(0, this.#pendingBytes - recordBytes);
			if (recordBytes > MAX_LOCAL_BRIDGE_INBOUND_RECORD_BYTES) throw new Error("collab bridge record too large");
			if (!line.trim()) {
				newline = this.#pending.indexOf("\n");
				continue;
			}
			try {
				records.push(JSON.parse(line));
				this.#malformed = 0;
			} catch {
				this.#malformed += 1;
				if (this.#malformed >= MAX_MALFORMED_RECORDS) throw new Error("too many malformed collab bridge records");
			}
			newline = this.#pending.indexOf("\n");
		}
		if (this.#pendingBytes > MAX_LOCAL_BRIDGE_INBOUND_RECORD_BYTES) throw new Error("collab bridge record too large");
		return records;
	}
}

export function parseAddress(address: string): { hostname: string; port: number } {
	const match = /^([^:]+):(\d+)$/.exec(address);
	if (!match) throw new Error(`invalid collab bridge address: ${address}`);
	const hostname = match[1];
	const port = Number(match[2]);
	if (!hostname || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`invalid collab bridge address: ${address}`);
	}
	return { hostname, port };
}

function isFrameRecord(record: unknown): record is BridgeFrameRecord {
	if (!record || typeof record !== "object") return false;
	const value = record as Record<string, unknown>;
	return value.t === "frame" && typeof value.frame === "object" && value.frame !== null;
}
export function serializeBridgeFrameRecord(frame: CollabFrame, targetPeer = 0): string {
	const mutation = frame.t === "prompt" || frame.t === "abort" || frame.t === "agent-cmd" || frame.t === "ui-response";
	const record = `${JSON.stringify({ t: "frame", targetPeer, mutation, frame })}\n`;
	if (Buffer.byteLength(record) > MAX_LOCAL_BRIDGE_OUTBOUND_RECORD_BYTES)
		throw new Error("collab bridge record too large");
	return record;
}

/** Loopback NDJSON adapter used by the hidden Herdr collaboration bridge. */
export class LocalCollabTransport implements CollabTransport {
	onOpen?: () => void;
	onFrame?: (
		frame: CollabFrame,
		fromPeer: number,
		metadata?: { displayName?: string; displayNameRevision?: number },
	) => void;
	readonly requiresHerdrAttribution: boolean;
	onControl?: (msg: CollabTransportControl) => void;
	onClose?: (reason: string, willReconnect: boolean) => void;
	#socket: Bun.Socket<undefined> | undefined;
	#closed = false;
	#opened = false;
	#connecting = false;
	readonly #address: string;
	readonly #announce?: Record<string, unknown>;
	readonly #waitForHerdrReady: boolean;

	constructor(
		address: string,
		announce?: Record<string, unknown>,
		requiresHerdrAttribution = false,
		waitForHerdrReady = false,
	) {
		this.#address = address;
		this.#announce = announce;
		this.requiresHerdrAttribution = requiresHerdrAttribution;
		this.#waitForHerdrReady = waitForHerdrReady;
	}

	get isOpen(): boolean {
		return this.#opened && !this.#closed;
	}

	connect(): void {
		if (this.#socket || this.#connecting || this.#closed) return;
		this.#connecting = true;
		const { hostname, port } = parseAddress(this.#address);
		void Bun.connect({
			hostname,
			port,
			socket: {
				open: socket => {
					this.#connecting = false;
					if (this.#closed) {
						socket.end();
						return;
					}
					this.#socket = socket;
					if (this.#announce) socket.write(`${JSON.stringify(this.#announce)}\n`);
					if (!this.#waitForHerdrReady) this.#open();
				},
				data: (_socket, data) => this.#receive(data),
				close: () => this.#finish("bridge closed"),
				error: (_socket, error) => this.#finish(error.message || "bridge error"),
			},
		}).catch(error => this.#finish(error instanceof Error ? error.message : String(error)));
	}

	send(frame: CollabFrame, targetPeer = 0): boolean {
		if (!this.isOpen || !this.#socket) return false;
		this.#socket.write(serializeBridgeFrameRecord(frame, targetPeer));
		return true;
	}

	notifyReplicaReady(): void {
		if (!this.isOpen || !this.#socket) return;
		this.#socket.write('{"t":"replica-ready"}\n');
	}

	requestAuthority(action: "request" | "release"): boolean {
		if (!this.isOpen || !this.#socket) return false;
		this.#socket.write(`${JSON.stringify({ t: "control", action: `${action}-controller` })}\n`);
		return true;
	}

	close(): void {
		if (this.#closed) return;
		this.#socket?.end();
		this.#finish("closed");
	}

	#parser = new NdjsonRecordParser();

	#receive(data: Uint8Array): void {
		try {
			for (const record of this.#parser.push(data)) this.#dispatch(record);
		} catch (error) {
			this.#finish(error instanceof Error ? error.message : String(error));
			this.#socket?.end();
		}
	}

	#dispatch(record: unknown): void {
		if (isFrameRecord(record) && typeof record.fromPeer === "number") {
			const frame =
				record.frame.t === "prompt"
					? { t: "prompt" as const, text: record.frame.text, images: record.frame.images }
					: record.frame;
			const metadata =
				this.requiresHerdrAttribution && record.frame.t === "prompt"
					? {
							displayName: typeof record.displayName === "string" ? record.displayName : undefined,
							displayNameRevision:
								typeof record.displayNameRevision === "number" ? record.displayNameRevision : undefined,
						}
					: undefined;
			this.onFrame?.(frame, record.fromPeer, metadata);
			return;
		}
		if (!record || typeof record !== "object") return;
		const value = record as Record<string, unknown>;
		if (value.t === "ready" && this.#waitForHerdrReady) {
			this.#open();
		} else if (value.t === "error" && typeof value.message === "string") {
			const reason =
				typeof value.code === "string" && value.code.length > 0 ? `${value.code}: ${value.message}` : value.message;
			this.#finish(reason);
			this.#socket?.end();
		} else if (value.t === "peer-left" && typeof value.peer === "number") {
			this.onControl?.({ t: "peer-left", peer: value.peer });
		} else if (
			value.t === "peer-authority" &&
			typeof value.peer === "number" &&
			typeof value.canWrite === "boolean"
		) {
			this.onControl?.({ t: "peer-authority", peer: value.peer, canWrite: value.canWrite });
		} else if (value.t === "close" && typeof value.reason === "string") {
			this.#finish(value.reason);
			this.#socket?.end();
		}
	}

	#open(): void {
		if (this.#opened || this.#closed) return;
		this.#opened = true;
		try {
			this.onOpen?.();
		} catch (error) {
			this.#finish(error instanceof Error ? error.message : String(error));
			this.#socket?.end();
		}
	}

	#finish(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#connecting = false;
		this.#opened = false;
		this.onClose?.(reason, false);
	}
}

export function createHostBridgeTransport(
	address: string,
	token: string,
	paneId: string,
	ompSessionId: string,
	routeGeneration: number,
): LocalCollabTransport {
	return new LocalCollabTransport(
		address,
		{ t: "host", token, paneId, ompSessionId, routeGeneration, ompBuildId: OMP_BUILD_ID },
		true,
		true,
	);
}
