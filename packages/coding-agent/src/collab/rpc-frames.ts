import { isRpcMutationCommand } from "../modes/rpc/rpc-types";
import type { CollabFrame } from "./protocol";
import type { CollabTransport } from "./relay-client";

const MAX_DIRECT_FRAME_BYTES = 1024 * 1024;
const CHUNK_DATA_BYTES = 256 * 1024;
const MAX_LOGICAL_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_COUNT = Math.ceil(MAX_LOGICAL_FRAME_BYTES / CHUNK_DATA_BYTES);
const MAX_ACTIVE_REASSEMBLIES = 32;
const MAX_BUFFERED_REASSEMBLY_BYTES = 128 * 1024 * 1024;
const REASSEMBLY_TIMEOUT_MS = 30_000;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type RpcChunkFrame = Extract<CollabFrame, { t: "rpc-chunk" }>;
type ReassembledRpcFrame = Exclude<CollabFrame, RpcChunkFrame>;

type Reassembly = {
	count: number;
	byteLength: number;
	mutation: boolean;
	chunks: Array<Uint8Array | undefined>;
	received: number;
	receivedBytes: number;
	timer: NodeJS.Timeout;
};

export type CollabRpcFrameReassemblyResult = { handled: false } | { handled: true; frame?: ReassembledRpcFrame };

function frameCarriesMutation(frame: ReassembledRpcFrame): boolean {
	if (frame.t === "rpc-mutation" || frame.t === "rpc-control") return true;
	return frame.t === "rpc-request" && isRpcMutationCommand(frame.command);
}

/** Send one logical RPC frame, splitting large records for the private bridge. */
export function sendCollabRpcFrame(transport: CollabTransport, frame: ReassembledRpcFrame, targetPeer = 0): boolean {
	const bytes = Buffer.from(JSON.stringify(frame));
	if (bytes.byteLength > MAX_LOGICAL_FRAME_BYTES) throw new Error("collab RPC logical frame too large");
	if (bytes.byteLength <= MAX_DIRECT_FRAME_BYTES) return transport.send(frame, targetPeer);

	const count = Math.ceil(bytes.byteLength / CHUNK_DATA_BYTES);
	const chunkId = crypto.randomUUID();
	const mutation = frameCarriesMutation(frame);
	for (let index = 0; index < count; index += 1) {
		const start = index * CHUNK_DATA_BYTES;
		const chunk: RpcChunkFrame = {
			t: "rpc-chunk",
			chunkId,
			index,
			count,
			byteLength: bytes.byteLength,
			mutation,
			data: bytes.subarray(start, Math.min(start + CHUNK_DATA_BYTES, bytes.byteLength)).toString("base64"),
		};
		if (!transport.send(chunk, targetPeer)) return false;
	}
	return true;
}

/** Bounded, timeout-backed reassembly for interleaved Collab RPC chunks. */
export class CollabRpcFrameReassembler {
	#active = new Map<string, Reassembly>();
	#bufferedBytes = 0;

	push(frame: CollabFrame, fromPeer: number): CollabRpcFrameReassemblyResult {
		if (frame.t !== "rpc-chunk") return { handled: false };
		this.#validateChunk(frame);
		const key = `${fromPeer}:${frame.chunkId}`;
		let state = this.#active.get(key);
		if (!state) {
			if (this.#active.size >= MAX_ACTIVE_REASSEMBLIES) throw new Error("too many active collab RPC chunks");
			if (this.#bufferedBytes + frame.byteLength > MAX_BUFFERED_REASSEMBLY_BYTES) {
				throw new Error("collab RPC chunk buffer limit exceeded");
			}
			state = {
				count: frame.count,
				byteLength: frame.byteLength,
				mutation: frame.mutation,
				chunks: new Array<Uint8Array | undefined>(frame.count),
				received: 0,
				receivedBytes: 0,
				timer: setTimeout(() => this.#drop(key), REASSEMBLY_TIMEOUT_MS),
			};
			this.#active.set(key, state);
			this.#bufferedBytes += frame.byteLength;
		} else if (
			state.count !== frame.count ||
			state.byteLength !== frame.byteLength ||
			state.mutation !== frame.mutation
		) {
			this.#drop(key);
			throw new Error("inconsistent collab RPC chunk metadata");
		}

		if (state.chunks[frame.index] !== undefined) return { handled: true };
		const decoded = Buffer.from(frame.data, "base64");
		if (decoded.toString("base64") !== frame.data) {
			this.#drop(key);
			throw new Error("invalid collab RPC chunk encoding");
		}
		const expectedChunkBytes =
			frame.index === frame.count - 1 ? frame.byteLength - frame.index * CHUNK_DATA_BYTES : CHUNK_DATA_BYTES;
		if (decoded.byteLength !== expectedChunkBytes) {
			this.#drop(key);
			throw new Error("invalid collab RPC chunk size");
		}
		state.chunks[frame.index] = decoded;
		state.received += 1;
		state.receivedBytes += decoded.byteLength;
		if (state.receivedBytes > state.byteLength) {
			this.#drop(key);
			throw new Error("collab RPC chunk length exceeded");
		}
		if (state.received < state.count) return { handled: true };
		if (state.receivedBytes !== state.byteLength) {
			this.#drop(key);
			throw new Error("collab RPC chunk length mismatch");
		}

		const complete = Buffer.concat(state.chunks as Uint8Array[], state.byteLength);
		this.#drop(key);
		let parsed: unknown;
		try {
			parsed = JSON.parse(complete.toString("utf8"));
		} catch {
			throw new Error("invalid collab RPC chunk payload");
		}
		if (!parsed || typeof parsed !== "object" || !("t" in parsed) || parsed.t === "rpc-chunk") {
			throw new Error("invalid reassembled collab RPC frame");
		}
		const logical = parsed as ReassembledRpcFrame;
		if (frameCarriesMutation(logical) !== frame.mutation) throw new Error("collab RPC chunk authority mismatch");
		return { handled: true, frame: logical };
	}

	close(): void {
		for (const state of this.#active.values()) clearTimeout(state.timer);
		this.#active.clear();
		this.#bufferedBytes = 0;
	}

	#validateChunk(frame: RpcChunkFrame): void {
		if (!frame.chunkId || frame.chunkId.length > 128) throw new Error("invalid collab RPC chunk id");
		if (!Number.isSafeInteger(frame.index) || !Number.isSafeInteger(frame.count)) {
			throw new Error("invalid collab RPC chunk index");
		}
		if (
			frame.count < 1 ||
			frame.count > MAX_CHUNK_COUNT ||
			frame.count !== Math.ceil(frame.byteLength / CHUNK_DATA_BYTES) ||
			frame.index < 0 ||
			frame.index >= frame.count
		) {
			throw new Error("invalid collab RPC chunk range");
		}
		if (
			!Number.isSafeInteger(frame.byteLength) ||
			frame.byteLength < 1 ||
			frame.byteLength > MAX_LOGICAL_FRAME_BYTES
		) {
			throw new Error("invalid collab RPC chunk length");
		}
		if (typeof frame.mutation !== "boolean" || !BASE64_RE.test(frame.data)) {
			throw new Error("invalid collab RPC chunk metadata");
		}
	}

	#drop(key: string): void {
		const state = this.#active.get(key);
		if (!state) return;
		clearTimeout(state.timer);
		this.#active.delete(key);
		this.#bufferedBytes -= state.byteLength;
	}
}
