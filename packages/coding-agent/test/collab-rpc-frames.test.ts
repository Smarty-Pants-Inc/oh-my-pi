import { expect, it } from "bun:test";
import type { CollabFrame } from "../src/collab/protocol";
import type { CollabTransport } from "../src/collab/relay-client";
import { CollabRpcFrameReassembler, sendCollabRpcFrame } from "../src/collab/rpc-frames";

class RecordingTransport implements CollabTransport {
	onOpen: CollabTransport["onOpen"];
	onFrame: CollabTransport["onFrame"];
	onControl: CollabTransport["onControl"];
	onClose: CollabTransport["onClose"];
	readonly sent: CollabFrame[] = [];

	get isOpen(): boolean {
		return true;
	}

	connect(): void {}
	close(): void {}

	send(frame: CollabFrame): boolean {
		this.sent.push(frame);
		return true;
	}
}

it("reassembles multi-record RPC output without changing its authority classification", () => {
	const transport = new RecordingTransport();
	const logical = { t: "rpc-output" as const, output: { type: "artifact", payload: "x".repeat(2 * 1024 * 1024) } };
	expect(sendCollabRpcFrame(transport, logical, 7)).toBe(true);
	expect(transport.sent.length).toBeGreaterThan(1);
	expect(transport.sent.every(frame => frame.t === "rpc-chunk")).toBe(true);

	const reassembler = new CollabRpcFrameReassembler();
	let reassembled: CollabFrame | undefined;
	for (const frame of transport.sent) {
		const result = reassembler.push(frame, 7);
		if (result.handled && result.frame) reassembled = result.frame;
	}
	expect(reassembled).toEqual(logical);
	reassembler.close();
});

it("rejects chunk metadata that could allocate beyond the logical frame bound", () => {
	const reassembler = new CollabRpcFrameReassembler();
	expect(() =>
		reassembler.push(
			{
				t: "rpc-chunk",
				chunkId: "oversized-count",
				index: 0,
				count: 1_000_000,
				byteLength: 1,
				mutation: false,
				data: "eA==",
			},
			7,
		),
	).toThrow("invalid collab RPC chunk range");
	reassembler.close();
});
