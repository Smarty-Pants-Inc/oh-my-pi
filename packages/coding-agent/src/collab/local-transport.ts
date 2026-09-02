import * as path from "node:path";
import { OMP_BUILD_ID } from "../build-identity";
import type { RpcHerdrAgentdHostBridge } from "../modes/rpc/rpc-types";
import type { CollabFrame } from "./protocol";
import type { CollabTransport, CollabTransportControl } from "./relay-client";

const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_WRITE_BYTES = 128 * 1024 * 1024;

interface FlushWaiter {
	resolve(): void;
	reject(error: Error): void;
}

type BridgeFrame = { t: "frame"; fromPeer: number; frame: CollabFrame };

function parseAddress(address: string): { hostname: string; port: number } {
	const match = /^([^:]+):(\d+)$/.exec(address);
	if (!match) throw new Error("Invalid Herdr bridge address");
	const hostname = match[1];
	const port = Number(match[2]);
	if (!hostname || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error("Invalid Herdr bridge address");
	}
	return { hostname, port };
}

export function validateHerdrBridgeAddress(address: string): string {
	if (!address || address.trim() !== address || address.includes("\0")) {
		throw new Error("Invalid Herdr bridge address");
	}
	if (!path.isAbsolute(address)) parseAddress(address);
	return address;
}

const AGENTD_BRIDGE_ENV_KEYS = [
	"HERDR_OMP_BRIDGE",
	"HERDR_OMP_BRIDGE_TOKEN",
	"HERDR_PANE_ID",
	"HERDR_OMP_ROUTE_GENERATION",
	"HERDR_SOCKET_PATH",
	"HERDR_OMP_GUEST_BRIDGE_TOKEN",
] as const;

/** Capture the redeemed direct tuple once, then remove every bridge claim from the child environment. */
export function captureHerdrAgentdHostBridge(
	env: Record<string, string | undefined> = process.env,
): RpcHerdrAgentdHostBridge {
	const address = env.HERDR_OMP_BRIDGE;
	const token = env.HERDR_OMP_BRIDGE_TOKEN;
	const paneId = env.HERDR_PANE_ID;
	const routeGeneration = Number(env.HERDR_OMP_ROUTE_GENERATION);
	for (const key of AGENTD_BRIDGE_ENV_KEYS) delete env[key];
	let directAddress: string;
	try {
		if (process.platform === "win32") throw new Error("unsupported");
		directAddress = validateHerdrBridgeAddress(address ?? "");
	} catch {
		throw new Error("__collab-rpc-host requires a valid direct Herdr bridge tuple");
	}
	if (
		!token ||
		token.trim() !== token ||
		token.includes("\0") ||
		!paneId ||
		paneId.trim() !== paneId ||
		paneId.includes("\0") ||
		paneId.length > 256 ||
		!Number.isSafeInteger(routeGeneration) ||
		routeGeneration < 1
	) {
		throw new Error("__collab-rpc-host requires a valid direct Herdr bridge tuple");
	}
	return { address: directAddress, paneId, routeGeneration, token };
}

/** NDJSON adapter for Herdr's authenticated private bridge. */
export class LocalCollabTransport implements CollabTransport {
	onOpen?: () => void;
	onFrame?: (frame: CollabFrame, fromPeer: number) => void;
	onControl?: (message: CollabTransportControl) => void;
	onClose?: (reason: string, willReconnect: boolean) => void;
	#socket: Bun.Socket<undefined> | undefined;
	#closed = false;
	#opened = false;
	#decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	#pending = "";
	#pendingBytes = 0;
	readonly #address: string;
	#announce: object | undefined;
	#writeQueue: Buffer[] = [];
	#writeOffset = 0;
	#pendingWriteBytes = 0;
	#flushWaiters = new Set<FlushWaiter>();

	constructor(address: string, announce: object) {
		this.#address = validateHerdrBridgeAddress(address);
		this.#announce = announce;
	}

	connect(): void {
		if (this.#socket || this.#closed) return;
		const socket: Bun.SocketHandler<undefined> = {
			open: next => {
				if (this.#closed) {
					next.end();
					return;
				}
				this.#socket = next;
				const announce = this.#announce;
				this.#announce = undefined;
				if (!announce) {
					next.end();
					this.#finish("Herdr bridge credentials unavailable");
					return;
				}
				this.#queueRecord(`${JSON.stringify(announce)}\n`);
			},
			data: (_socket, data) => this.#receive(data),
			drain: () => this.#drainWrites(),
			close: () => this.#finish("Herdr bridge closed"),
			error: (_socket, error) => this.#finish(error.message || "Herdr bridge error"),
		};
		const connecting = path.isAbsolute(this.#address)
			? Bun.connect({ unix: this.#address, socket })
			: Bun.connect({ ...parseAddress(this.#address), socket });
		void connecting.catch(error => this.#finish(error instanceof Error ? error.message : String(error)));
	}

	send(frame: CollabFrame, targetPeer = 0): void {
		if (!this.#opened || this.#closed || !this.#socket) return;
		const record = `${JSON.stringify({ t: "frame", targetPeer, frame })}\n`;
		if (Buffer.byteLength(record) > MAX_RECORD_BYTES) {
			this.#finish("Herdr bridge record too large");
			this.#socket.end();
			return;
		}
		this.#queueRecord(record);
	}

	flush(): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("Herdr bridge is closed"));
		this.#drainWrites();
		if (this.#closed) return Promise.reject(new Error("Herdr bridge is closed"));
		if (this.#pendingWriteBytes === 0) return Promise.resolve();
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#flushWaiters.add({ resolve, reject });
		return promise;
	}

	#queueRecord(record: string): void {
		const bytes = Buffer.from(record);
		if (this.#pendingWriteBytes + bytes.byteLength > MAX_PENDING_WRITE_BYTES) {
			this.#finish("Herdr bridge write queue exceeded its limit");
			this.#socket?.end();
			return;
		}
		this.#writeQueue.push(bytes);
		this.#pendingWriteBytes += bytes.byteLength;
		this.#drainWrites();
	}

	#drainWrites(): void {
		const socket = this.#socket;
		if (!socket || this.#closed) return;
		while (this.#writeQueue.length > 0) {
			const record = this.#writeQueue[0];
			if (!record) break;
			const remaining = record.byteLength - this.#writeOffset;
			let written: number;
			try {
				written = socket.write(record, this.#writeOffset, remaining);
			} catch (error) {
				this.#finish(error instanceof Error ? error.message : String(error));
				socket.end();
				return;
			}
			if (written < 0 || written > remaining) {
				this.#finish("Herdr bridge write failed");
				socket.end();
				return;
			}
			if (written === 0) return;
			this.#writeOffset += written;
			this.#pendingWriteBytes -= written;
			if (this.#writeOffset < record.byteLength) return;
			this.#writeQueue.shift();
			this.#writeOffset = 0;
		}
		if (this.#pendingWriteBytes !== 0) return;
		for (const waiter of this.#flushWaiters) waiter.resolve();
		this.#flushWaiters.clear();
	}

	close(): void {
		this.#socket?.end();
		this.#finish("closed");
	}

	#receive(data: Uint8Array): void {
		try {
			this.#pending += this.#decoder.decode(data, { stream: true });
		} catch {
			this.#finish("Herdr bridge sent invalid UTF-8");
			this.#socket?.end();
			return;
		}
		this.#pendingBytes += data.byteLength;
		let newline = this.#pending.indexOf("\n");
		while (newline >= 0) {
			const line = this.#pending.slice(0, newline);
			this.#pending = this.#pending.slice(newline + 1);
			const recordBytes = Buffer.byteLength(line) + 1;
			this.#pendingBytes -= recordBytes;
			if (recordBytes > MAX_RECORD_BYTES) {
				this.#finish("Herdr bridge record too large");
				this.#socket?.end();
				return;
			}
			try {
				this.#dispatch(JSON.parse(line) as unknown);
			} catch {
				this.#finish("Herdr bridge sent invalid JSON");
				this.#socket?.end();
				return;
			}
			newline = this.#pending.indexOf("\n");
		}
		if (this.#pendingBytes > MAX_RECORD_BYTES) {
			this.#finish("Herdr bridge record too large");
			this.#socket?.end();
		}
	}

	#dispatch(record: unknown): void {
		if (!record || typeof record !== "object") return;
		const value = record as Record<string, unknown>;
		if (value.t === "ready") {
			if (this.#opened) return;
			this.#opened = true;
			this.onOpen?.();
			return;
		}
		if (value.t === "frame" && typeof value.fromPeer === "number" && value.frame && typeof value.frame === "object") {
			this.onFrame?.(value.frame as BridgeFrame["frame"], value.fromPeer);
			return;
		}
		if (value.t === "peer-left" && typeof value.peer === "number") {
			this.onControl?.({ t: "peer-left", peer: value.peer });
			return;
		}
		if (
			value.t === "peer-authority" &&
			typeof value.peer === "number" &&
			Number.isSafeInteger(value.peer) &&
			value.peer >= 0 &&
			typeof value.canWrite === "boolean"
		) {
			this.onControl?.({ t: "peer-authority", peer: value.peer, canWrite: value.canWrite });
			return;
		}
		if (value.t === "error") {
			const message =
				typeof value.message === "string"
					? value.message
					: typeof value.reason === "string"
						? value.reason
						: "Herdr bridge rejected connection";
			const reason =
				typeof value.code === "string" && value.code
					? value.code === "route_busy"
						? value.code
						: `${value.code}: ${message}`
					: `rejected: ${message}`;
			this.#finish(reason);
			this.#socket?.end();
			return;
		}
		if (value.t === "close") {
			this.#finish(typeof value.reason === "string" ? value.reason : "Herdr bridge closed");
			this.#socket?.end();
		}
	}

	#finish(reason: string): void {
		if (this.#closed) return;
		try {
			this.#pending += this.#decoder.decode();
		} catch {
			reason = "Herdr bridge sent invalid UTF-8";
		}
		this.#closed = true;
		const error = new Error(reason);
		for (const waiter of this.#flushWaiters) waiter.reject(error);
		this.#flushWaiters.clear();
		this.#writeQueue = [];
		this.#writeOffset = 0;
		this.#pendingWriteBytes = 0;
		this.#announce = undefined;
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
	return new LocalCollabTransport(address, {
		t: "host",
		token,
		paneId,
		ompSessionId,
		routeGeneration,
		ompBuildId: OMP_BUILD_ID,
		runtimeOwner: "agentd",
	});
}
