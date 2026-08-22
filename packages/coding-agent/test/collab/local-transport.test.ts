import { describe, expect, it } from "bun:test";
import { OMP_BUILD_ID } from "../../src/build-identity";
import {
	createHostBridgeTransport,
	LocalCollabTransport,
	NdjsonRecordParser,
	serializeBridgeFrameRecord,
} from "../../src/collab/local-transport";
import {
	COLLAB_PROTO,
	MAX_LOCAL_BRIDGE_INBOUND_RECORD_BYTES,
	MAX_LOCAL_BRIDGE_OUTBOUND_RECORD_BYTES,
} from "../../src/collab/protocol";

const encoder = new TextEncoder();

describe("NdjsonRecordParser", () => {
	it("joins partial and multiple records without corrupting split UTF-8", () => {
		const parser = new NdjsonRecordParser();
		const text = '{"t":"frame","frame":{"t":"hello","name":"é"}}\n{"t":"close","reason":"done"}\n';
		const bytes = encoder.encode(text);
		const split = bytes.indexOf(0xc3) + 1;
		expect(parser.push(bytes.subarray(0, split))).toEqual([]);
		expect(parser.push(bytes.subarray(split))).toEqual([
			{ t: "frame", frame: { t: "hello", name: "é" } },
			{ t: "close", reason: "done" },
		]);
	});

	it("drops bounded malformed lines and rejects a malformed stream", () => {
		const parser = new NdjsonRecordParser();
		expect(parser.push('bad\n{"t":"close","reason":"ok"}\n')).toEqual([{ t: "close", reason: "ok" }]);
		expect(() =>
			parser.push("bad\nbad\nbad\nbad\nbad\nbad\nbad\nbad\nbad\nbad\nbad\nbad\nbad\nbad\nbad\nbad\n"),
		).toThrow("too many malformed collab bridge records");
	});

	it("bounds incomplete records by UTF-8 bytes", () => {
		const parser = new NdjsonRecordParser();
		expect(() => parser.push("é".repeat(1_100_000))).toThrow("collab bridge record too large");
	});

	it("rejects complete records over the byte cap", () => {
		const parser = new NdjsonRecordParser();
		expect(() => parser.push(`${"é".repeat(1_100_000)}\n`)).toThrow("collab bridge record too large");
	});

	it("rejects oversized outbound records before socket write", () => {
		expect(() => serializeBridgeFrameRecord({ t: "prompt", text: "é".repeat(1_100_000) })).toThrow(
			"collab bridge record too large",
		);
	});

	it("preserves two 500 KiB images in one bounded bridge record", () => {
		expect(MAX_LOCAL_BRIDGE_OUTBOUND_RECORD_BYTES).toBe(2 * 1024 * 1024 - 1024);
		expect(MAX_LOCAL_BRIDGE_INBOUND_RECORD_BYTES).toBe(2 * 1024 * 1024);
		const data = Buffer.alloc(500 * 1024, 0x7f).toString("base64");
		const frame = {
			t: "prompt" as const,
			text: "two images",
			images: [
				{ type: "image" as const, data, mimeType: "image/png" },
				{ type: "image" as const, data, mimeType: "image/png" },
			],
		};
		const record = serializeBridgeFrameRecord(frame);
		expect(Buffer.byteLength(record)).toBeGreaterThan(1024 * 1024);
		expect(Buffer.byteLength(record)).toBeLessThanOrEqual(MAX_LOCAL_BRIDGE_OUTBOUND_RECORD_BYTES);
		expect(new NdjsonRecordParser().push(record)).toEqual([{ t: "frame", targetPeer: 0, mutation: true, frame }]);
	});

	it("accepts a near-limit outbound prompt after Herdr adds inbound metadata", () => {
		const emptyRecord = serializeBridgeFrameRecord({ t: "prompt", text: "" });
		const frame = {
			t: "prompt" as const,
			text: "x".repeat(MAX_LOCAL_BRIDGE_OUTBOUND_RECORD_BYTES - Buffer.byteLength(emptyRecord)),
		};
		const outboundRecord = serializeBridgeFrameRecord(frame);
		expect(Buffer.byteLength(outboundRecord)).toBe(MAX_LOCAL_BRIDGE_OUTBOUND_RECORD_BYTES);

		const outboundPayload = JSON.parse(outboundRecord) as { frame: typeof frame };
		const inboundRecord = `${JSON.stringify({
			t: "frame",
			fromPeer: 7,
			displayName: "Alice",
			displayNameRevision: 12,
			frame: outboundPayload.frame,
		})}\n`;
		expect(Buffer.byteLength(inboundRecord)).toBeGreaterThan(MAX_LOCAL_BRIDGE_OUTBOUND_RECORD_BYTES);
		expect(Buffer.byteLength(inboundRecord)).toBeLessThanOrEqual(MAX_LOCAL_BRIDGE_INBOUND_RECORD_BYTES);
		expect(new NdjsonRecordParser().push(inboundRecord)).toEqual([JSON.parse(inboundRecord)]);
	});

	it("keeps the transport usable after rejecting an oversized outbound record", async () => {
		const received = Promise.withResolvers<string>();
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					socket.write('{"t":"ready"}\n');
				},
				data(_socket, data) {
					received.resolve(data.toString());
				},
			},
		});
		try {
			const transport = new LocalCollabTransport(`127.0.0.1:${server.port}`);
			const opened = Promise.withResolvers<void>();
			transport.onOpen = () => opened.resolve();
			transport.connect();
			await opened.promise;
			expect(() => transport.send({ t: "prompt", text: "é".repeat(1_100_000) })).toThrow(
				"collab bridge record too large",
			);
			transport.send({ t: "abort" });
			expect(await received.promise).toContain('"t":"abort"');
			transport.close();
		} finally {
			server.stop(true);
		}
	});

	it("announces before exposing an open route and waits for Herdr ready", async () => {
		const received = Promise.withResolvers<{ text: string; socket: Bun.Socket<undefined> }>();
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open() {},
				data(socket, data) {
					received.resolve({ text: data.toString(), socket });
				},
			},
		});
		try {
			const transport = createHostBridgeTransport(
				`127.0.0.1:${server.port}`,
				"route-token",
				"pane-7",
				"session-result",
				1,
			);
			let opened = false;
			const ready = Promise.withResolvers<void>();
			transport.onOpen = () => {
				opened = true;
				ready.resolve();
			};
			transport.connect();
			const announced = await received.promise;
			expect(JSON.parse(announced.text.trim())).toEqual({
				t: "host",
				token: "route-token",
				paneId: "pane-7",
				ompSessionId: "session-result",
				routeGeneration: 1,
				ompBuildId: OMP_BUILD_ID,
			});
			expect(opened).toBe(false);
			expect(transport.isOpen).toBe(false);
			announced.socket.write('{"t":"ready"}\n');
			await ready.promise;
			expect(transport.isOpen).toBe(true);
			transport.close();
		} finally {
			server.stop(true);
		}
	});

	it("opens a guest bridge on TCP connection and sends hello without Herdr ready", async () => {
		const received = Promise.withResolvers<unknown[]>();
		const records: unknown[] = [];
		let pending = "";
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open() {},
				data(_socket, data) {
					pending += data.toString();
					let newline = pending.indexOf("\n");
					while (newline >= 0) {
						const line = pending.slice(0, newline);
						pending = pending.slice(newline + 1);
						if (line.trim()) records.push(JSON.parse(line));
						if (records.length === 2) received.resolve(records);
						newline = pending.indexOf("\n");
					}
				},
			},
		});
		try {
			const transport = new LocalCollabTransport(`127.0.0.1:${server.port}`, { t: "guest", token: "route-token" });
			const opened = Promise.withResolvers<boolean>();
			transport.onOpen = () => opened.resolve(transport.send({ t: "hello", proto: COLLAB_PROTO, name: "guest" }));
			transport.connect();
			expect(await opened.promise).toBe(true);
			expect(transport.isOpen).toBe(true);
			expect(await received.promise).toEqual([
				{ t: "guest", token: "route-token" },
				{
					t: "frame",
					targetPeer: 0,
					mutation: false,
					frame: { t: "hello", proto: COLLAB_PROTO, name: "guest" },
				},
			]);
			transport.close();
		} finally {
			server.stop(true);
		}
	});

	it("maps a post-ready Herdr error code and message to the close reason", async () => {
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					socket.write('{"t":"ready"}\n');
					socket.write('{"t":"error","code":"route-replaced","message":"newer route won"}\n');
				},
				data() {},
			},
		});
		try {
			const transport = new LocalCollabTransport(`127.0.0.1:${server.port}`);
			const closed = Promise.withResolvers<string>();
			transport.onClose = reason => closed.resolve(reason);
			transport.connect();
			expect(await closed.promise).toBe("route-replaced: newer route won");
			expect(transport.isOpen).toBe(false);
		} finally {
			server.stop(true);
		}
	});

	it("does not swallow frame-handler errors", async () => {
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					socket.write(
						`{"t":"ready"}\n{"t":"frame","fromPeer":1,"frame":{"t":"hello","proto":${COLLAB_PROTO},"name":"x"}}\n`,
					);
				},
				data() {},
			},
		});
		try {
			const transport = new LocalCollabTransport(`127.0.0.1:${server.port}`);
			const closed = Promise.withResolvers<string>();
			transport.onFrame = () => {
				throw new Error("bad frame");
			};
			transport.onClose = reason => closed.resolve(reason);
			transport.connect();
			expect(await closed.promise).toBe("bad frame");
		} finally {
			server.stop(true);
		}
	});
});

describe("LocalCollabTransport attribution", () => {
	it("forwards trusted prompt attribution only as bridge metadata", async () => {
		const received = Promise.withResolvers<{ frame: unknown; peer: number; metadata?: unknown }>();
		const opened = Promise.withResolvers<Bun.Socket<undefined>>();
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					opened.resolve(socket);
				},
				data() {},
			},
		});
		try {
			const transport = new LocalCollabTransport(`127.0.0.1:${server.port}`, undefined, true);
			transport.onFrame = (frame, peer, metadata) => received.resolve({ frame, peer, metadata });
			transport.connect();
			const socket = await opened.promise;
			socket.write('{"t":"ready"}\n');
			socket.write(
				'{"t":"frame","fromPeer":7,"displayName":"Alice","displayNameRevision":2,"frame":{"t":"prompt","text":"hello","displayName":"forged","displayNameRevision":99}}\n',
			);
			expect(await received.promise).toEqual({
				frame: { t: "prompt", text: "hello" },
				peer: 7,
				metadata: { displayName: "Alice", displayNameRevision: 2 },
			});
			transport.close();
		} finally {
			server.stop(true);
		}
	});

	it("does not forward attribution metadata for public bridge prompts", async () => {
		const received = Promise.withResolvers<{ frame: unknown; metadata?: unknown }>();
		const opened = Promise.withResolvers<Bun.Socket<undefined>>();
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					opened.resolve(socket);
				},
				data() {},
			},
		});
		try {
			const transport = new LocalCollabTransport(`127.0.0.1:${server.port}`);
			transport.onFrame = (frame, _peer, metadata) => received.resolve({ frame, metadata });
			transport.connect();
			const socket = await opened.promise;
			socket.write('{"t":"ready"}\n');
			socket.write(
				'{"t":"frame","fromPeer":7,"displayName":"Alice","displayNameRevision":2,"frame":{"t":"prompt","text":"hello"}}\n',
			);
			expect(await received.promise).toEqual({ frame: { t: "prompt", text: "hello" }, metadata: undefined });
			transport.close();
		} finally {
			server.stop(true);
		}
	});
});
