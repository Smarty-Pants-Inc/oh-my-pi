import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { serializeBridgeFrameRecord } from "../src/collab/local-transport";
import {
	COLLAB_PROTO,
	type CollabFrame,
	type CollabSessionState,
	MAX_LOCAL_BRIDGE_OUTBOUND_RECORD_BYTES,
} from "../src/collab/protocol";
import type { CollabTransport, CollabTransportControl } from "../src/collab/relay-client";
import { CollabRpcGuest } from "../src/collab/rpc-guest";
import { MAX_RPC_FRAME_BYTES, RpcFrameDecoder } from "../src/modes/rpc/rpc-frame";
import type {
	RpcChunkFrame,
	RpcCollabAuthorityUpdateFrame,
	RpcCollabStateUpdateFrame,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolResult,
} from "../src/modes/rpc/rpc-types";
import type { SessionEntry, SessionHeader } from "../src/session/session-entries";

interface ControlledInput {
	stream: ReadableStream<Uint8Array>;
	send(frame: object): void;
	close(): void;
}

interface GuestFixture {
	transport: TestTransport;
	input: ControlledInput;
	frames: FrameCollector;
	running: Promise<void>;
}

type FrameGuard<T extends object> = (frame: object) => frame is T;

class FrameCollector {
	readonly frames: object[] = [];
	#waiters: Array<{ guard: FrameGuard<object>; resolve: (frame: object) => void }> = [];

	push(frame: object): void {
		this.frames.push(frame);
		const remaining: Array<{ guard: FrameGuard<object>; resolve: (frame: object) => void }> = [];
		for (const waiter of this.#waiters) {
			if (waiter.guard(frame)) waiter.resolve(frame);
			else remaining.push(waiter);
		}
		this.#waiters = remaining;
	}

	waitFor<T extends object>(guard: FrameGuard<T>): Promise<T> {
		const existing = this.frames.find(guard);
		if (existing) return Promise.resolve(existing);
		const { promise, resolve } = Promise.withResolvers<T>();
		this.#waiters.push({ guard, resolve: resolve as (frame: object) => void });
		return promise;
	}
}

class TestTransport implements CollabTransport {
	onOpen?: () => void;
	onFrame?: (frame: CollabFrame, fromPeer: number) => void;
	onControl?: (msg: CollabTransportControl) => void;
	onClose?: (reason: string, willReconnect: boolean) => void;
	isOpen = true;
	authorityResult = true;
	enforceBridgeLimit = false;
	rejectHostToolResults = false;
	readonly sent: CollabFrame[] = [];
	readonly authorityActions: Array<"request" | "release"> = [];
	#sentWaiters: Array<{ guard: (frame: CollabFrame) => boolean; resolve: (frame: CollabFrame) => void }> = [];

	connect(): void {
		this.onOpen?.();
	}
	send(frame: CollabFrame): boolean {
		if (this.enforceBridgeLimit) serializeBridgeFrameRecord(frame);
		if (!this.isOpen || (this.rejectHostToolResults && frame.t === "host-tool-result")) return false;
		this.sent.push(frame);
		const remaining: Array<{ guard: (frame: CollabFrame) => boolean; resolve: (frame: CollabFrame) => void }> = [];
		for (const waiter of this.#sentWaiters) {
			if (waiter.guard(frame)) waiter.resolve(frame);
			else remaining.push(waiter);
		}
		this.#sentWaiters = remaining;
		return true;
	}

	requestAuthority(action: "request" | "release"): boolean {
		this.authorityActions.push(action);
		return this.isOpen && this.authorityResult;
	}

	waitForSent<T extends CollabFrame>(guard: (frame: CollabFrame) => frame is T): Promise<T> {
		const existing = this.sent.find(guard);
		if (existing) return Promise.resolve(existing);
		const { promise, resolve } = Promise.withResolvers<T>();
		this.#sentWaiters.push({ guard, resolve: resolve as (frame: CollabFrame) => void });
		return promise;
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.onClose?.("closed", false);
	}

	deliver(frame: CollabFrame): void {
		this.onFrame?.(frame, 1);
	}

	disconnect(reason = "bridge closed"): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.onClose?.(reason, false);
	}
}

function sessionHeader(): SessionHeader {
	return { type: "session", id: "host-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/host" };
}

function sessionState(): CollabSessionState {
	return { isStreaming: false, queuedMessageCount: 0, cwd: "/host", participants: [] };
}

function messageEntry(text: string): SessionEntry {
	return {
		type: "message",
		id: `entry-${text}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text },
	} as SessionEntry;
}

function controlledInput(): ControlledInput {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(nextController) {
			controller = nextController;
		},
	});
	return {
		stream,
		send(frame) {
			controller?.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
		},
		close() {
			controller?.close();
		},
	};
}

function isResponse(
	command: string,
	id: string,
): (frame: object) => frame is {
	id: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	code?: string;
} {
	return (
		frame,
	): frame is {
		id: string;
		type: "response";
		command: string;
		success: boolean;
		data?: unknown;
		code?: string;
	} =>
		"type" in frame &&
		frame.type === "response" &&
		"command" in frame &&
		frame.command === command &&
		"id" in frame &&
		frame.id === id;
}

function isReady(frame: object): frame is { type: "ready" } {
	return "type" in frame && frame.type === "ready";
}

function isCollabStateUpdate(frame: object): frame is RpcCollabStateUpdateFrame {
	return "type" in frame && frame.type === "collab_state_update";
}

function isCollabAuthorityUpdate(frame: object, canWrite?: boolean): frame is RpcCollabAuthorityUpdateFrame {
	return (
		"type" in frame &&
		frame.type === "collab_authority_update" &&
		"canWrite" in frame &&
		typeof frame.canWrite === "boolean" &&
		(canWrite === undefined || frame.canWrite === canWrite)
	);
}

function isRpcChunk(frame: object): frame is RpcChunkFrame {
	return "type" in frame && frame.type === "rpc_chunk";
}

function isHostToolCall(id: string): (frame: object) => frame is RpcHostToolCallRequest {
	return (frame): frame is RpcHostToolCallRequest =>
		"type" in frame && frame.type === "host_tool_call" && "id" in frame && frame.id === id;
}

function isHostToolCancel(targetId: string): (frame: object) => frame is RpcHostToolCancelRequest {
	return (frame): frame is RpcHostToolCancelRequest =>
		"type" in frame && frame.type === "host_tool_cancel" && "targetId" in frame && frame.targetId === targetId;
}

function createGuest(): GuestFixture {
	const transport = new TestTransport();
	const input = controlledInput();
	const frames = new FrameCollector();
	const guest = new CollabRpcGuest({
		address: "127.0.0.1:1",
		roomId: "room",
		token: "token",
		transport,
		writeLine: line => frames.push(JSON.parse(line) as object),
	});
	const running = guest.run(input.stream);
	return { transport, input, frames, running };
}

async function startGuest(
	readOnly = false,
	entries: SessionEntry[] = [messageEntry("snapshot")],
): Promise<GuestFixture> {
	const fixture = createGuest();
	fixture.transport.deliver({
		t: "welcome",
		proto: COLLAB_PROTO,
		header: sessionHeader(),
		state: sessionState(),
		agents: [],
		entryCount: entries.length,
		readOnly,
	});
	fixture.transport.deliver({ t: "snapshot-chunk", entries, final: true });
	await fixture.frames.waitFor(isReady);
	return fixture;
}

let previousConfigRoot: string | undefined;
let temporaryConfigRoot: string | undefined;
let previousNotifications: string | undefined;

beforeEach(() => {
	previousNotifications = process.env.PI_NOTIFICATIONS;
});

afterEach(() => {
	if (previousConfigRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousConfigRoot;
	if (previousNotifications === undefined) delete process.env.PI_NOTIFICATIONS;
	else process.env.PI_NOTIFICATIONS = previousNotifications;
	if (temporaryConfigRoot) fs.rmSync(temporaryConfigRoot, { recursive: true, force: true });
	previousConfigRoot = undefined;
	previousNotifications = undefined;
	temporaryConfigRoot = undefined;
});

describe("headless Collab RPC guest", () => {
	it("does not emit RPC ready before the authoritative snapshot is complete", async () => {
		const { transport, input, frames, running } = createGuest();
		transport.deliver({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: sessionHeader(),
			state: sessionState(),
			agents: [],
			entryCount: 2,
		});
		transport.deliver({ t: "snapshot-chunk", entries: [messageEntry("first")], final: false });

		expect(frames.frames.some(isReady)).toBe(false);
		transport.deliver({ t: "snapshot-chunk", entries: [messageEntry("second")], final: true });
		await frames.waitFor(isReady);

		input.send({ id: "messages", type: "get_messages" });
		expect(await frames.waitFor(isResponse("get_messages", "messages"))).toMatchObject({
			data: {
				messages: [
					{ role: "user", content: "first" },
					{ role: "user", content: "second" },
				],
			},
		});
		input.close();
		await running;
	});

	it("rejects startup when the transport closes after welcome but before the final snapshot chunk", async () => {
		const { transport, frames, running } = createGuest();
		transport.deliver({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: sessionHeader(),
			state: sessionState(),
			agents: [],
			entryCount: 1,
		});
		transport.disconnect("snapshot interrupted");

		await expect(running).rejects.toThrow("snapshot interrupted");
		expect(frames.frames.some(isReady)).toBe(false);
	});

	it("negotiates protocol v2 and reassembles oversized output from rpc_chunk frames", async () => {
		const content = "😀".repeat(300_000);
		const { input, frames, running } = await startGuest(false, [messageEntry(content)]);
		input.send({ id: "protocol", type: "negotiate_protocol", protocolVersion: 2 });
		expect(await frames.waitFor(isResponse("negotiate_protocol", "protocol"))).toEqual({
			id: "protocol",
			type: "response",
			command: "negotiate_protocol",
			success: true,
			data: { protocolVersion: 2 },
		});

		const expected = {
			id: "messages",
			type: "response",
			command: "get_messages",
			success: true,
			data: { messages: [{ role: "user", content }] },
		};
		expect(Buffer.byteLength(JSON.stringify(expected), "utf8")).toBeGreaterThan(MAX_RPC_FRAME_BYTES);
		const firstOutputFrame = frames.frames.length;
		input.send({ id: "messages", type: "get_messages" });
		await frames.waitFor((frame): frame is RpcChunkFrame => isRpcChunk(frame) && frame.index === frame.count - 1);

		const chunks = frames.frames.slice(firstOutputFrame);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every(isRpcChunk)).toBe(true);
		const decoder = new RpcFrameDecoder();
		let decoded: object | undefined;
		for (const chunk of chunks) decoded = decoder.push(chunk);
		expect(decoded).toEqual(expected);

		input.close();
		await running;
	});

	it("reconstructs welcome snapshots in memory for RPC state and messages without creating a session file", async () => {
		previousConfigRoot = process.env.PI_CODING_AGENT_DIR;
		temporaryConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-collab-rpc-"));
		process.env.PI_CODING_AGENT_DIR = temporaryConfigRoot;
		const { input, frames, running } = await startGuest();

		input.send({ id: "state", type: "get_state" });
		input.send({ id: "messages", type: "get_messages" });
		input.send({ id: "page", type: "get_messages_page", limit: 1 });
		const state = await frames.waitFor(isResponse("get_state", "state"));
		const messages = await frames.waitFor(isResponse("get_messages", "messages"));
		const page = await frames.waitFor(isResponse("get_messages_page", "page"));

		expect(state.data).toMatchObject({ sessionId: "host-session", messageCount: 1 });
		expect(messages.data).toEqual({ messages: [{ role: "user", content: "snapshot" }] });
		expect(page.data).toEqual({ messages: [{ role: "user", content: "snapshot" }], totalMessages: 1 });
		expect(
			fs
				.readdirSync(temporaryConfigRoot, { recursive: true })
				.filter(name => typeof name === "string" && name.endsWith(".jsonl")),
		).toEqual([]);

		input.close();
		await running;
	});

	it("forwards live Collab agent events as raw RPC events", async () => {
		const { transport, input, frames, running } = await startGuest();
		const event = { type: "notice" as const, level: "info" as const, message: "host event" };
		transport.deliver({ t: "event", event });

		expect(
			await frames.waitFor((frame): frame is typeof event => "type" in frame && frame.type === "notice"),
		).toEqual(event);
		input.close();
		await running;
	});

	it("forwards live Collab state and authority changes as typed RPC notifications", async () => {
		const { transport, input, frames, running } = await startGuest(true);
		const state = { ...sessionState(), isStreaming: true, queuedMessageCount: 2 };
		transport.deliver({ t: "state", state });
		expect(await frames.waitFor(isCollabStateUpdate)).toEqual({ type: "collab_state_update", state });

		transport.deliver({ t: "authority", canWrite: true });
		expect(await frames.waitFor(frame => isCollabAuthorityUpdate(frame, true))).toEqual({
			type: "collab_authority_update",
			canWrite: true,
		});

		transport.onControl?.({ t: "peer-authority", peer: 1, canWrite: false });
		expect(await frames.waitFor(frame => isCollabAuthorityUpdate(frame, false))).toEqual({
			type: "collab_authority_update",
			canWrite: false,
		});
		input.close();
		await running;
	});

	it("queues live Collab state and authority notifications until the snapshot is ready", async () => {
		const { transport, input, frames, running } = createGuest();
		transport.deliver({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: sessionHeader(),
			state: sessionState(),
			agents: [],
			entryCount: 1,
			readOnly: true,
		});
		const state = { ...sessionState(), isStreaming: true };
		transport.deliver({ t: "state", state });
		transport.onControl?.({ t: "peer-authority", peer: 1, canWrite: true });
		expect(frames.frames.some(isCollabStateUpdate)).toBe(false);
		expect(frames.frames.some(frame => isCollabAuthorityUpdate(frame))).toBe(false);

		transport.deliver({ t: "snapshot-chunk", entries: [messageEntry("snapshot")], final: true });
		await frames.waitFor(isReady);
		expect(await frames.waitFor(isCollabStateUpdate)).toEqual({ type: "collab_state_update", state });
		expect(await frames.waitFor(frame => isCollabAuthorityUpdate(frame, true))).toEqual({
			type: "collab_authority_update",
			canWrite: true,
		});
		input.close();
		await running;
	});

	it("rejects observer mutations, then sends prompts only after controller authority is granted and releases it", async () => {
		const { transport, input, frames, running } = await startGuest(true);
		input.send({ id: "observer", type: "prompt", message: "blocked" });
		expect(await frames.waitFor(isResponse("prompt", "observer"))).toMatchObject({
			success: false,
			code: "collab_read_only",
		});

		input.send({ id: "request", type: "request_control" });
		expect(await frames.waitFor(isResponse("request_control", "request"))).toMatchObject({ success: true });
		expect(transport.authorityActions).toEqual(["request"]);
		transport.deliver({ t: "authority", canWrite: true });

		input.send({ id: "prompt", type: "prompt", message: "granted", streamingBehavior: "followUp" });
		expect(await frames.waitFor(isResponse("prompt", "prompt"))).toMatchObject({
			success: true,
			data: { agentInvoked: true },
		});
		expect(
			await transport.waitForSent(
				(frame): frame is Extract<CollabFrame, { t: "prompt" }> => "t" in frame && frame.t === "prompt",
			),
		).toEqual({
			t: "prompt",
			text: "granted",
			images: undefined,
			streamingBehavior: "followUp",
			requestId: "prompt",
		});
		transport.deliver({ t: "prompt-error", requestId: "prompt", message: "prompt failed: rejected" });
		expect(
			await frames.waitFor(
				(frame): frame is object => isResponse("prompt", "prompt")(frame) && frame.success === false,
			),
		).toMatchObject({
			success: false,
			error: "prompt failed: rejected",
		});

		input.send({ id: "abort", type: "abort" });
		expect(await frames.waitFor(isResponse("abort", "abort"))).toMatchObject({ success: true });
		expect(
			await transport.waitForSent(
				(frame): frame is Extract<CollabFrame, { t: "abort" }> => "t" in frame && frame.t === "abort",
			),
		).toEqual({ t: "abort" });

		input.send({ id: "release", type: "release_control" });
		expect(await frames.waitFor(isResponse("release_control", "release"))).toMatchObject({ success: true });
		expect(transport.authorityActions).toEqual(["request", "release"]);
		input.close();
		await running;
	});

	it("registers managed tools and relays calls, updates, results, and cancellation through Collab", async () => {
		const { transport, input, frames, running } = await startGuest();
		const tools = [{ name: "managed", description: "Managed host tool", parameters: { type: "object" } }];
		input.send({ id: "tools", type: "set_host_tools", tools });
		const registration = await transport.waitForSent(
			(frame): frame is Extract<CollabFrame, { t: "set-host-tools" }> =>
				"t" in frame && frame.t === "set-host-tools",
		);
		expect(registration.tools).toEqual(tools);
		transport.deliver({ t: "host-tools-set", reqId: registration.reqId, toolNames: ["managed"] });
		expect(await frames.waitFor(isResponse("set_host_tools", "tools"))).toMatchObject({
			success: true,
			data: { toolNames: ["managed"] },
		});

		const call: RpcHostToolCallRequest = {
			type: "host_tool_call",
			id: "call-1",
			toolCallId: "toolu-1",
			toolName: "managed",
			arguments: { value: 1 },
		};
		transport.deliver({ t: "host-tool-call", frame: call });
		expect(await frames.waitFor(isHostToolCall(call.id))).toEqual(call);

		input.send({
			type: "host_tool_update",
			id: call.id,
			partialResult: { content: [{ type: "text", text: "working" }] },
		});
		expect(
			await transport.waitForSent(
				(frame): frame is Extract<CollabFrame, { t: "host-tool-update" }> =>
					"t" in frame && frame.t === "host-tool-update",
			),
		).toMatchObject({ frame: { type: "host_tool_update", id: call.id } });

		input.send({
			type: "host_tool_result",
			id: call.id,
			result: { content: [{ type: "text", text: "done" }] },
		});
		expect(
			await transport.waitForSent(
				(frame): frame is Extract<CollabFrame, { t: "host-tool-result" }> =>
					"t" in frame && frame.t === "host-tool-result",
			),
		).toMatchObject({ frame: { type: "host_tool_result", id: call.id } });

		const cancelledCall = { ...call, id: "call-2", toolCallId: "toolu-2" };
		transport.deliver({ t: "host-tool-call", frame: cancelledCall });
		await frames.waitFor(isHostToolCall(cancelledCall.id));
		transport.deliver({
			t: "host-tool-cancel",
			frame: { type: "host_tool_cancel", id: "cancel-2", targetId: cancelledCall.id },
		});
		expect(await frames.waitFor(isHostToolCancel(cancelledCall.id))).toMatchObject({ targetId: cancelledCall.id });

		const replacedCall = { ...call, id: "call-3", toolCallId: "toolu-3" };
		transport.deliver({ t: "host-tool-call", frame: replacedCall });
		await frames.waitFor(isHostToolCall(replacedCall.id));
		transport.deliver({ t: "authority", canWrite: false });
		expect(await frames.waitFor(isHostToolCancel(replacedCall.id))).toMatchObject({ targetId: replacedCall.id });

		input.close();
		await running;
	});

	it("does not let an observer register tools or relay another guest's result", async () => {
		const { transport, input, frames, running } = await startGuest(true);
		input.send({
			id: "tools",
			type: "set_host_tools",
			tools: [{ name: "blocked", description: "Blocked", parameters: { type: "object" } }],
		});
		expect(await frames.waitFor(isResponse("set_host_tools", "tools"))).toMatchObject({
			success: false,
			code: "collab_read_only",
		});
		input.send({
			type: "host_tool_result",
			id: "another-guests-call",
			result: { content: [{ type: "text", text: "spoofed" }] },
		});
		input.send({ id: "state", type: "get_state" });
		await frames.waitFor(isResponse("get_state", "state"));
		expect(transport.sent.filter(frame => frame.t === "set-host-tools" || frame.t === "host-tool-result")).toEqual(
			[],
		);

		input.close();
		await running;
	});

	it("drops an oversized host-tool update without terminating the guest or final call", async () => {
		const { transport, input, frames, running } = await startGuest();
		transport.enforceBridgeLimit = true;
		const call: RpcHostToolCallRequest = {
			type: "host_tool_call",
			id: "oversized-update",
			toolCallId: "toolu-oversized-update",
			toolName: "managed",
			arguments: {},
		};
		transport.deliver({ t: "host-tool-call", frame: call });
		await frames.waitFor(isHostToolCall(call.id));

		input.send({
			type: "host_tool_update",
			id: call.id,
			partialResult: {
				content: [{ type: "text", text: "x".repeat(MAX_LOCAL_BRIDGE_OUTBOUND_RECORD_BYTES) }],
			},
		});
		input.send({ id: "still-running", type: "get_state" });
		await frames.waitFor(isResponse("get_state", "still-running"));
		expect(transport.sent.filter(frame => frame.t === "host-tool-update")).toEqual([]);

		input.send({
			type: "host_tool_result",
			id: call.id,
			result: { content: [{ type: "text", text: "done" }] },
		});
		expect(
			await transport.waitForSent(
				(frame): frame is Extract<CollabFrame, { t: "host-tool-result" }> =>
					frame.t === "host-tool-result" && frame.frame.id === call.id,
			),
		).toMatchObject({ frame: { result: { content: [{ type: "text", text: "done" }] } } });

		input.close();
		await running;
	});

	it("falls back for an oversized final result and retains the call if fallback delivery fails", async () => {
		const { transport, input, frames, running } = await startGuest();
		transport.enforceBridgeLimit = true;
		const call: RpcHostToolCallRequest = {
			type: "host_tool_call",
			id: "oversized-result",
			toolCallId: "toolu-oversized-result",
			toolName: "managed",
			arguments: {},
		};
		transport.deliver({ t: "host-tool-call", frame: call });
		await frames.waitFor(isHostToolCall(call.id));
		input.send({
			type: "host_tool_result",
			id: call.id,
			result: { content: [{ type: "text", text: "x".repeat(MAX_LOCAL_BRIDGE_OUTBOUND_RECORD_BYTES) }] },
		});
		const fallback = await transport.waitForSent(
			(frame): frame is Extract<CollabFrame, { t: "host-tool-result" }> =>
				frame.t === "host-tool-result" && frame.frame.id === call.id,
		);
		expect(fallback.frame).toEqual({
			type: "host_tool_result",
			id: call.id,
			result: { content: [{ type: "text", text: "Host tool result could not be delivered over Collab" }] },
			isError: true,
		} satisfies RpcHostToolResult);

		input.send({
			type: "host_tool_result",
			id: call.id,
			result: { content: [{ type: "text", text: "duplicate" }] },
		});
		input.send({ id: "fallback-complete", type: "get_state" });
		await frames.waitFor(isResponse("get_state", "fallback-complete"));
		expect(transport.sent.filter(frame => frame.t === "host-tool-result" && frame.frame.id === call.id)).toHaveLength(
			1,
		);

		const retainedCall = { ...call, id: "fallback-undeliverable", toolCallId: "toolu-fallback-undeliverable" };
		transport.deliver({ t: "host-tool-call", frame: retainedCall });
		await frames.waitFor(isHostToolCall(retainedCall.id));
		transport.rejectHostToolResults = true;
		input.send({
			type: "host_tool_result",
			id: retainedCall.id,
			result: { content: [{ type: "text", text: "x".repeat(MAX_LOCAL_BRIDGE_OUTBOUND_RECORD_BYTES) }] },
		});
		input.send({ id: "fallback-failed", type: "get_state" });
		await frames.waitFor(isResponse("get_state", "fallback-failed"));
		transport.disconnect();
		expect(await frames.waitFor(isHostToolCancel(retainedCall.id))).toMatchObject({ targetId: retainedCall.id });
		await running;
	});

	it("does not report authority request success when the transport rejects it", async () => {
		const { transport, input, frames, running } = await startGuest(true);
		transport.authorityResult = false;
		input.send({ id: "unavailable", type: "request_control" });
		expect(await frames.waitFor(isResponse("request_control", "unavailable"))).toMatchObject({
			success: false,
			error: "Collab transport is unavailable",
		});
		expect(transport.authorityActions).toEqual(["request"]);
		input.close();
		await running;
	});

	it("round-trips Collab UI requests through the RPC extension UI response contract", async () => {
		const { transport, input, frames, running } = await startGuest();
		transport.deliver({
			t: "ui-request",
			request: {
				reqId: 7,
				kind: "select",
				title: "Choose",
				options: ["Keep", { label: "Deploy", description: "Publish it" }],
			},
		});
		const request = await frames.waitFor(
			(frame): frame is { id: string } =>
				"type" in frame && frame.type === "extension_ui_request" && "method" in frame && frame.method === "select",
		);
		expect(request).toMatchObject({
			method: "select",
			title: "Choose",
			options: ["Keep", "Deploy"],
			optionDetails: [{}, { description: "Publish it" }],
		});

		input.send({ type: "extension_ui_response", id: request.id, value: "Deploy" });
		expect(
			await transport.waitForSent(
				(frame): frame is Extract<CollabFrame, { t: "ui-response" }> => "t" in frame && frame.t === "ui-response",
			),
		).toEqual({ t: "ui-response", reqId: 7, value: "Deploy" });
		input.close();
		await running;
	});

	it("exits on transport disconnect without waiting for stdin or changing the host", async () => {
		const { transport, running } = await startGuest();
		transport.disconnect();
		await running;
		expect(transport.sent.filter(frame => frame.t === "bye")).toEqual([]);
	});
});
