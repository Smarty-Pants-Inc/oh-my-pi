import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { LocalCollabTransport } from "../../src/collab/agentd-local-transport";
import type { CollabFrame } from "../../src/collab/protocol";

function createBridge() {
	const writes: Buffer[] = [];
	let handler: Bun.SocketHandler<undefined> | undefined;
	const socket = {
		write(data: string | Uint8Array, byteOffset = 0, byteLength?: number): number {
			const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
			writes.push(
				Buffer.from(bytes.subarray(byteOffset, byteLength === undefined ? undefined : byteOffset + byteLength)),
			);
			return byteLength ?? bytes.byteLength - byteOffset;
		},
		end(): number {
			return 0;
		},
	} as Bun.Socket<undefined>;
	const connect = spyOn(Bun, "connect");
	connect.mockImplementation(
		(
			options: Bun.TCPSocketConnectOptions<undefined> | Bun.UnixSocketOptions<undefined>,
		): Promise<Bun.Socket<undefined>> => {
			handler = options.socket;
			handler.open?.(socket);
			return Promise.resolve(socket);
		},
	);
	return {
		announcement: (): Record<string, unknown> =>
			JSON.parse(Buffer.concat(writes).toString("utf8")) as Record<string, unknown>,
		receive: (chunk: Buffer): void => {
			if (!handler?.data) throw new Error("Bridge socket did not connect");
			handler.data(socket, chunk);
		},
		close: (): void => {
			handler?.close?.(socket);
		},
	};
}

async function receiveSplitFrame(character: string, boundary: number): Promise<void> {
	const bridge = createBridge();
	const transport = new LocalCollabTransport("127.0.0.1:1234", { t: "host", token: `token-${character}` });
	const { promise: received, resolve } = Promise.withResolvers<{ frame: CollabFrame; fromPeer: number }>();
	transport.onFrame = (frame, fromPeer) => resolve({ frame, fromPeer });
	transport.connect();
	expect(bridge.announcement()).toMatchObject({ t: "host", token: `token-${character}` });

	const frame = { t: "bye", reason: `before ${character} after` } as CollabFrame;
	const record = Buffer.from(`${JSON.stringify({ t: "frame", fromPeer: 7, frame })}\n`);
	const characterOffset = record.indexOf(Buffer.from(character));
	expect(characterOffset).toBeGreaterThanOrEqual(0);
	bridge.receive(Buffer.from('{"t":"ready"}\n'));
	bridge.receive(record.subarray(0, characterOffset + boundary));
	bridge.receive(record.subarray(characterOffset + boundary));

	expect(await received).toEqual({ frame, fromPeer: 7 });
	transport.close();
}

afterEach(() => vi.restoreAllMocks());

describe("LocalCollabTransport UTF-8 decoding", () => {
	for (const [name, character] of [
		["two-byte", "¢"],
		["three-byte", "€"],
		["four-byte", "😀"],
	] as const) {
		it(`preserves ${name} Unicode in host announcements and frames across every byte boundary`, async () => {
			for (let boundary = 1; boundary < Buffer.byteLength(character); boundary++) {
				await receiveSplitFrame(character, boundary);
			}
		});
	}

	for (const [name, chunks, closes] of [
		[
			"overlong sequences",
			[Buffer.from('{"t":"frame","fromPeer":1,"frame":{"t":"bye","reason":"'), Buffer.from([0xc0, 0xaf])],
			false,
		],
		[
			"invalid continuation bytes",
			[Buffer.from('{"t":"frame","fromPeer":1,"frame":{"t":"bye","reason":"'), Buffer.from([0xe2, 0x28, 0xa1])],
			false,
		],
		[
			"truncated sequences on close",
			[Buffer.from('{"t":"frame","fromPeer":1,"frame":{"t":"bye","reason":"'), Buffer.from([0xe2, 0x82])],
			true,
		],
	] as const) {
		it(`rejects ${name} without dispatching a replacement-character frame`, () => {
			const bridge = createBridge();
			const transport = new LocalCollabTransport("127.0.0.1:1234", { t: "guest", token: "token" });
			let closed: string | undefined;
			let frames = 0;
			transport.onFrame = () => frames++;
			transport.onClose = reason => {
				closed = reason;
			};
			transport.connect();
			for (const chunk of chunks) bridge.receive(chunk);
			if (closes) bridge.close();

			expect(closed).toBe("Herdr bridge sent invalid UTF-8");
			expect(frames).toBe(0);
			transport.close();
		});
	}
});
