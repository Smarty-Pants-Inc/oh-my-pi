import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { CollabHost, type CollabHostContext } from "../src/collab/host";
import { captureHerdrAgentdHostBridge } from "../src/collab/agentd-local-transport";
import { COLLAB_PROTO, type CollabFrame } from "../src/collab/protocol";
import type { CollabTransport, CollabTransportControl } from "../src/collab/relay-client";
import { CollabRpcFrameReassembler } from "../src/collab/rpc-frames";
import { dispatchRpcCanonicalCommand } from "../src/modes/rpc/rpc-mode";
import { RpcMutationLedger } from "../src/modes/rpc/rpc-mutation";
import {
	RPC_CAPABILITIES,
	type RpcCanonicalAuthority,
	type RpcCanonicalDispatchContext,
	type RpcCommand,
	type RpcCommandDispatchResult,
	type RpcMutationCommand,
	type RpcResponse,
} from "../src/modes/rpc/rpc-types";
import type { AgentSession, AgentSessionEvent } from "../src/session/agent-session";

const BRIDGE_ENV_KEYS = [
	"HERDR_OMP_BRIDGE",
	"HERDR_OMP_BRIDGE_TOKEN",
	"HERDR_PANE_ID",
	"HERDR_OMP_ROUTE_GENERATION",
	"HERDR_SOCKET_PATH",
	"HERDR_OMP_GUEST_BRIDGE_TOKEN",
] as const;

class TestTransport implements CollabTransport {
	onOpen?: () => void;
	onFrame?: (frame: CollabFrame, fromPeer: number) => void;
	onControl?: (message: CollabTransportControl) => void;
	onClose?: (reason: string, willReconnect: boolean) => void;
	readonly sent: Array<{ frame: CollabFrame; targetPeer: number }> = [];
	flushGate: Promise<void> | undefined;
	onFlush: (() => void) | undefined;
	closed = false;

	get isOpen(): boolean {
		return !this.closed;
	}
	#frameWaiters = new Set<{ type: CollabFrame["t"]; occurrence: number; resolve(frame: CollabFrame): void }>();

	connect(): void {
		queueMicrotask(() => this.onOpen?.());
	}

	send(frame: CollabFrame, targetPeer = 0): boolean {
		this.sent.push({ frame, targetPeer });
		for (const waiter of this.#frameWaiters) {
			const matches = sentFrames(this, waiter.type);
			const matched = matches[waiter.occurrence - 1];
			if (!matched) continue;
			this.#frameWaiters.delete(waiter);
			waiter.resolve(matched);
		}
		return true;
	}

	async flush(): Promise<void> {
		this.onFlush?.();
		await this.flushGate;
	}

	close(): void {
		this.closed = true;
	}

	deliver(frame: CollabFrame, fromPeer = 7): void {
		this.onFrame?.(frame, fromPeer);
	}

	control(message: CollabTransportControl): void {
		this.onControl?.(message);
	}

	waitForFrame(type: CollabFrame["t"], occurrence = 1): Promise<CollabFrame> {
		const existing = sentFrames(this, type)[occurrence - 1];
		if (existing) return Promise.resolve(existing);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		this.#frameWaiters.add({ type, occurrence, resolve });
		return promise;
	}
}

interface TestContext {
	context: CollabHostContext;
	emit(event: AgentSessionEvent): void;
	setSessionId(sessionId: string): void;
}

function createContext(): TestContext {
	let sessionId = "session-parent";
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const sessionManager = {
		getSessionId: () => sessionId,
		getCwd: () => "/test",
		snapshotForReplication: () => ({
			header: {
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: "2026-08-31T00:00:00.000Z",
				cwd: "/test",
			},
			entries: [],
		}),
		onEntryAppended: undefined as ((entry: unknown) => void) | undefined,
	};
	const session = {
		isStreaming: false,
		isAborting: false,
		queuedMessageCount: 0,
		sessionName: undefined,
		model: undefined,
		thinkingLevel: "medium",
		subscribe: (next: (event: AgentSessionEvent) => void) => {
			listener = next;
			return () => {
				if (listener === next) listener = undefined;
			};
		},
		emitNotice: () => {},
	};
	return {
		context: {
			session,
			sessionManager,
			settings: { get: () => undefined },
			statusLine: {
				setCollabStatus: () => {},
				invalidate: () => {},
				getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 200_000 }),
			},
			ui: { requestRender: () => {} },
			showStatus: () => {},
			updatePendingMessagesDisplay: () => {},
		} as unknown as CollabHostContext,
		emit: event => listener?.(event),
		setSessionId: next => {
			sessionId = next;
		},
	};
}

interface TestAuthority extends RpcCanonicalAuthority {
	readonly commands: RpcCommand[];
	readonly controls: unknown[];
	readonly listeners: Set<(output: object) => void>;
	emit(output: object): void;
	waitForControl(occurrence?: number): Promise<unknown>;
}

function createAuthority(
	dispatch?: (
		command: RpcCommand,
		context?: RpcCanonicalDispatchContext,
	) => Promise<RpcResponse | RpcCommandDispatchResult>,
): TestAuthority {
	const commands: RpcCommand[] = [];
	const controls: unknown[] = [];
	const listeners = new Set<(output: object) => void>();
	const controlWaiters = new Set<{ occurrence: number; resolve(frame: unknown): void }>();
	return {
		identity: {
			buildId: "test-build",
			version: "18.0.11",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			capabilities: ["stdio-rpc"],
		},
		commands,
		controls,
		listeners,
		async dispatch(command, context) {
			commands.push(command);
			if (dispatch) return dispatch(command, context);
			return {
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
				data: {},
			} as RpcResponse;
		},
		dispatchControl(frame) {
			controls.push(frame);
			for (const waiter of controlWaiters) {
				const matched = controls[waiter.occurrence - 1];
				if (matched === undefined) continue;
				controlWaiters.delete(waiter);
				waiter.resolve(matched);
			}
			return true;
		},
		subscribeOutput(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(output) {
			for (const listener of listeners) listener(output);
		},
		waitForControl(occurrence = 1) {
			const existing = controls[occurrence - 1];
			if (existing !== undefined) return Promise.resolve(existing);
			const { promise, resolve } = Promise.withResolvers<unknown>();
			controlWaiters.add({ occurrence, resolve });
			return promise;
		},
	};
}

function sentFrames(transport: TestTransport, type: CollabFrame["t"]): CollabFrame[] {
	return transport.sent.map(({ frame }) => frame).filter(frame => frame.t === type);
}

describe("hidden agentd RPC host bootstrap", () => {
	test.skipIf(process.platform === "win32")("captures the direct tuple once and deletes every bridge claim", () => {
		const env: Record<string, string | undefined> = {
			HERDR_OMP_BRIDGE: "127.0.0.1:43123",
			HERDR_OMP_BRIDGE_TOKEN: "direct-secret",
			HERDR_PANE_ID: "pane-7",
			HERDR_OMP_ROUTE_GENERATION: "3",
			HERDR_SOCKET_PATH: "/legacy/discovery.sock",
			HERDR_OMP_GUEST_BRIDGE_TOKEN: "guest-secret",
		};

		expect(captureHerdrAgentdHostBridge(env.HERDR_OMP_BRIDGE_TOKEN, env)).toEqual({
			address: "127.0.0.1:43123",
			paneId: "pane-7",
			routeGeneration: 3,
			token: "direct-secret",
		});
		for (const key of BRIDGE_ENV_KEYS) expect(env[key]).toBeUndefined();
	});

	test("rejects a legacy path/token claim and still deletes it", () => {
		const env: Record<string, string | undefined> = {
			HERDR_SOCKET_PATH: "/legacy/discovery.sock",
			HERDR_OMP_BRIDGE_TOKEN: "must-not-survive",
			HERDR_PANE_ID: "pane-7",
			HERDR_OMP_ROUTE_GENERATION: "1",
		};

		expect(() => captureHerdrAgentdHostBridge(env.HERDR_OMP_BRIDGE_TOKEN, env)).toThrow(
			"valid direct Herdr bridge tuple",
		);
		for (const key of BRIDGE_ENV_KEYS) expect(env[key]).toBeUndefined();
	});

	test("waits for dispatcher readiness, advertises parity, and enforces peer write authority", async () => {
		const testContext = createContext();
		const transport = new TestTransport();
		const authorityReady = Promise.withResolvers<RpcCanonicalAuthority>();
		const authority = createAuthority();
		const host = new CollabHost(testContext.context);
		await host.startWithTransport(transport, { rpcAuthority: authorityReady.promise });
		transport.deliver({ t: "hello", proto: COLLAB_PROTO, name: "guest" });
		expect(sentFrames(transport, "welcome")).toHaveLength(0);

		authorityReady.resolve(authority);
		await transport.waitForFrame("welcome");
		const welcome = sentFrames(transport, "welcome")[0];
		if (welcome?.t !== "welcome" || !welcome.rpc) throw new Error("Expected RPC welcome");
		for (const capability of [...RPC_CAPABILITIES, "collab-rpc-guest", "rpc-all-commands", "rpc-inner-chunks"]) {
			expect(welcome.rpc.capabilities).toContain(capability);
		}

		transport.deliver({ t: "rpc-read", requestId: 1, command: { id: "read-1", type: "get_state" } });
		await transport.waitForFrame("rpc-read-result");
		expect(authority.commands.map(command => command.type)).toEqual(["get_state"]);

		const mutation = { commandId: "authority-fast", runtimeId: "runtime-1", generation: 1 };
		transport.deliver({
			t: "rpc-mutation",
			requestId: 2,
			command: { id: "mutation-1", type: "set_fast_mode", enabled: true, mutation },
		});
		await transport.waitForFrame("rpc-mutation-result");
		const denied = sentFrames(transport, "rpc-mutation-result")[0];
		expect(denied).toMatchObject({ response: { success: false, code: "read-only" } });
		expect(authority.commands.map(command => command.type)).toEqual(["get_state"]);

		transport.control({ t: "peer-authority", peer: 7, canWrite: true });
		expect(sentFrames(transport, "authority")).toHaveLength(1);
		transport.deliver({
			t: "rpc-mutation",
			requestId: 3,
			command: { id: "mutation-2", type: "set_fast_mode", enabled: true, mutation },
		});
		await transport.waitForFrame("rpc-mutation-result", 2);
		expect(authority.commands.map(command => command.type)).toEqual(["get_state", "set_fast_mode"]);
		await host.stop("test complete");
	});

	test("rejects every guest session lifecycle command before Agentd route side effects", async () => {
		const transport = new TestTransport();
		const authority = createAuthority();
		const host = new CollabHost(createContext().context);
		const commands: RpcMutationCommand[] = [
			{ id: "managed-fork", type: "fork" },
			{ id: "managed-new", type: "new_session" },
			{ id: "managed-switch", type: "switch_session", sessionPath: "/sessions/other.jsonl" },
			{ id: "managed-branch", type: "branch", entryId: "entry-1" },
		];
		await host.startWithTransport(transport, {
			agentdManagedHost: true,
			rpcAuthority: Promise.resolve(authority),
		});
		try {
			transport.control({ t: "peer-authority", peer: 7, canWrite: true });
			transport.deliver({ t: "hello", proto: COLLAB_PROTO, name: "guest" });
			await transport.waitForFrame("welcome");

			for (const [index, command] of commands.entries()) {
				transport.deliver({ t: "rpc-mutation", requestId: index, command });
				const result = await transport.waitForFrame("rpc-mutation-result", index + 1);
				expect(result).toMatchObject({
					response: {
						id: command.id,
						command: command.type,
						success: false,
						code: "agentd-managed",
						error: "Session lifecycle transitions are managed by Agentd",
					},
				});
			}

			expect(authority.commands).toEqual([]);
			expect(transport.closed).toBe(false);
		} finally {
			await host.stop("test complete");
		}
	});

	test("forwards controls and sidechannels once without duplicating session events", async () => {
		const testContext = createContext();
		const transport = new TestTransport();
		const authority = createAuthority();
		const host = new CollabHost(testContext.context);
		await host.startWithTransport(transport, { rpcAuthority: Promise.resolve(authority) });
		transport.control({ t: "peer-authority", peer: 7, canWrite: true });
		transport.deliver({ t: "hello", proto: COLLAB_PROTO, name: "guest" });
		await transport.waitForFrame("welcome");

		const event: AgentSessionEvent = { type: "notice", level: "info", message: "once" };
		testContext.emit(event);
		authority.emit(event);
		authority.emit({ type: "extension_ui_request", id: "ui-1", method: "notify", message: "sidechannel" });
		expect(sentFrames(transport, "event")).toHaveLength(1);
		expect(sentFrames(transport, "rpc-output")).toHaveLength(1);

		transport.deliver({
			t: "rpc-control",
			frame: { type: "extension_ui_response", id: "ui-1", cancelled: true },
		});
		await authority.waitForControl();
		expect(authority.controls[0]).toMatchObject({ type: "extension_ui_response", id: "ui-1" });
		await host.stop("test complete");
		expect(authority.listeners.size).toBe(0);
	});

	test("durably settles only authoritative pending Collab UI requests", async () => {
		using tempDir = TempDir.createSync("@omp-collab-rpc-ui-");
		const ledger = new RpcMutationLedger(path.join(tempDir.path(), "mutations.sqlite"));
		const testContext = createContext();
		const transport = new TestTransport();
		const session = { sessionId: "session-parent" } as unknown as AgentSession;
		const authority = createAuthority((command, context) =>
			dispatchRpcCanonicalCommand(session, command, ledger, async () => {
				if (command.type !== "collab_ui_response" || !context) {
					throw new Error(`Unexpected command ${command.type}`);
				}
				return context.handleCollabUiResponse(command);
			}),
		);
		const host = new CollabHost(testContext.context);
		try {
			await host.startWithTransport(transport, { rpcAuthority: Promise.resolve(authority) });
			transport.control({ t: "peer-authority", peer: 7, canWrite: true });
			transport.deliver({ t: "hello", proto: COLLAB_PROTO, name: "guest" });
			await transport.waitForFrame("welcome");

			const pendingUi = host.requestGuestUi({ kind: "editor", title: "Durable answer" });
			if (!pendingUi) throw new Error("Expected pending Collab UI request");
			const requestFrame = sentFrames(transport, "ui-request").at(-1);
			if (requestFrame?.t !== "ui-request") throw new Error("Expected Collab UI request frame");
			const accepted: RpcMutationCommand = {
				id: "ui-response-1",
				type: "collab_ui_response",
				reqId: requestFrame.request.reqId,
				value: "authoritative answer",
				mutation: { commandId: "authority-ui-1", runtimeId: "runtime-1", generation: 1 },
			};
			transport.deliver({ t: "rpc-mutation", requestId: 20, command: accepted });
			await transport.waitForFrame("rpc-mutation-result");
			expect(sentFrames(transport, "rpc-mutation-result").at(-1)).toMatchObject({
				response: {
					success: true,
					receipt: { operation: "collab_ui_response", replayed: false, session: { status: "completed" } },
				},
			});
			expect(await pendingUi).toEqual({ kind: "answered", value: "authoritative answer" });

			transport.deliver({ t: "rpc-mutation", requestId: 21, command: { ...accepted, id: "ui-response-replay" } });
			await transport.waitForFrame("rpc-mutation-result", 2);
			expect(sentFrames(transport, "rpc-mutation-result").at(-1)).toMatchObject({
				response: { success: true, receipt: { operation: "collab_ui_response", replayed: true } },
			});

			transport.deliver({
				t: "rpc-mutation",
				requestId: 22,
				command: {
					...accepted,
					id: "ui-response-missing",
					mutation: { commandId: "authority-ui-2", runtimeId: "runtime-1", generation: 1 },
				},
			});
			await transport.waitForFrame("rpc-mutation-result", 3);
			expect(sentFrames(transport, "rpc-mutation-result").at(-1)).toMatchObject({
				response: {
					success: false,
					code: "not-found",
					receipt: { operation: "collab_ui_response", session: { status: "rejected" } },
				},
			});
		} finally {
			ledger.close();
			await host.stop("test complete");
		}
	});

	test("chunks large results and flushes a fork receipt before publishing the session change", async () => {
		const testContext = createContext();
		const transport = new TestTransport();
		const order: string[] = [];
		const published = Promise.withResolvers<void>();
		const authority = createAuthority(async command => {
			if (command.type === "artifact_read") {
				const content = "x".repeat(2 * 1024 * 1024);
				return {
					id: command.id,
					type: "response",
					command: "artifact_read",
					success: true,
					data: { id: command.artifactId, content, size: Buffer.byteLength(content) },
				};
			}
			if (command.type !== "fork") throw new Error(`Unexpected command ${command.type}`);
			order.push("dispatch");
			testContext.setSessionId("session-child");
			testContext.emit({ type: "notice", level: "info", message: "session changed" });
			return {
				response: {
					id: command.id,
					type: "response",
					command: "fork",
					success: true,
					data: { sessionId: "session-child", cancelled: false },
				} as RpcResponse,
				afterResponse: () => {
					order.push("publish");
					published.resolve();
				},
			};
		});
		const host = new CollabHost(testContext.context);
		await host.startWithTransport(transport, { rpcAuthority: Promise.resolve(authority) });
		transport.control({ t: "peer-authority", peer: 7, canWrite: true });
		transport.deliver({ t: "hello", proto: COLLAB_PROTO, name: "guest" });
		await transport.waitForFrame("welcome");

		const chunkStart = transport.sent.length;
		transport.deliver({
			t: "rpc-read",
			requestId: 10,
			command: { id: "large-read", type: "artifact_read", artifactId: "1" },
		});
		const firstChunk = await transport.waitForFrame("rpc-chunk");
		if (firstChunk.t !== "rpc-chunk") throw new Error("Expected chunked RPC result");
		await transport.waitForFrame("rpc-chunk", firstChunk.count);
		const reassembler = new CollabRpcFrameReassembler();
		let logical: CollabFrame | undefined;
		for (const { frame } of transport.sent.slice(chunkStart)) {
			if (frame.t !== "rpc-chunk") continue;
			const result = reassembler.push(frame, 0);
			if (result.handled && result.frame) logical = result.frame;
		}
		reassembler.close();
		expect(logical).toMatchObject({ t: "rpc-read-result", requestId: 10, response: { success: true } });
		if (logical?.t !== "rpc-read-result" || !logical.response.success) {
			throw new Error("Expected reassembled RPC read result");
		}
		if (logical.response.command !== "artifact_read") throw new Error("Expected artifact RPC response");
		const payload = logical.response.data.content;
		expect(payload).toHaveLength(2 * 1024 * 1024);

		const flush = Promise.withResolvers<void>();
		transport.flushGate = flush.promise;
		transport.onFlush = () => order.push("flush");
		transport.deliver({
			t: "rpc-mutation",
			requestId: 11,
			command: {
				id: "fork-1",
				type: "fork",
				mutation: { commandId: "authority-fork", runtimeId: "runtime-1", generation: 1 },
			},
		});
		await transport.waitForFrame("rpc-mutation-result");
		expect(order).toEqual(["dispatch", "flush"]);
		expect(transport.closed).toBe(false);
		flush.resolve();
		await published.promise;
		expect(order).toEqual(["dispatch", "flush", "publish"]);
		expect(transport.closed).toBe(false);
		transport.flushGate = undefined;
		await host.stop("test complete");
	});
});
