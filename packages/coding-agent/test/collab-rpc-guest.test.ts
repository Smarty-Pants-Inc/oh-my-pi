import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { COLLAB_PROTO, type CollabFrame } from "../src/collab/protocol";
import type { CollabTransport } from "../src/collab/relay-client";
import { CollabRpcGuest, type CollabRpcGuestSession } from "../src/collab/rpc-guest";
import { fingerprintRpcMutation } from "../src/modes/rpc/rpc-mutation";
import type { RpcMutationCommand, RpcMutationReceipt } from "../src/modes/rpc/rpc-types";
import { RPC_CAPABILITIES } from "../src/modes/rpc/rpc-types";
import type { SessionEntry } from "../src/session/session-entries";

class TestTransport implements CollabTransport {
	onOpen: CollabTransport["onOpen"];
	onFrame: CollabTransport["onFrame"];
	onControl: CollabTransport["onControl"];
	onClose: CollabTransport["onClose"];
	readonly sent: CollabFrame[] = [];
	#open = false;

	get isOpen(): boolean {
		return this.#open;
	}

	connect(): void {
		this.#open = true;
		this.onOpen?.();
	}

	send(frame: CollabFrame): boolean {
		if (!this.#open) return false;
		this.sent.push(frame);
		return true;
	}

	close(): void {
		this.#open = false;
	}

	deliver(frame: CollabFrame): void {
		this.onFrame?.(frame, 1);
	}

	terminate(reason: string): void {
		this.#open = false;
		this.onClose?.(reason, false);
	}
}

const entry = {
	type: "message",
	id: "replicated-entry",
	parentId: null,
	timestamp: "2026-08-30T00:00:00.000Z",
	message: { role: "user", content: "from host", timestamp: Date.now() } as AgentMessage,
} as unknown as SessionEntry;

const identity = {
	buildId: "host-build",
	version: "18.0.11",
	protocolVersion: 1,
	supportedProtocolVersions: [1, 2],
	capabilities: [...RPC_CAPABILITIES, "collab-rpc-guest", "rpc-all-commands", "rpc-inner-chunks"],
} as const;

function welcome(entryCount = 1): Extract<CollabFrame, { t: "welcome" }> {
	return {
		t: "welcome",
		proto: COLLAB_PROTO,
		rpc: identity,
		header: { type: "session", id: "host-session", timestamp: "2026-08-30T00:00:00.000Z", cwd: process.cwd() },
		state: { participants: [], isStreaming: false, queuedMessageCount: 0, cwd: process.cwd() },
		agents: [],
		participant: { name: "authoritative host guest", role: "guest" },
		entryCount,
	};
}

function createSession(
	options: { onReload?: (replicaPath: string) => void; onRefresh?: () => void } = {},
): CollabRpcGuestSession {
	const agent: CollabRpcGuestSession["agent"] = {
		state: {},
		setModel(model) {
			this.state.model = model;
		},
		setThinkingLevel() {},
		setDisableReasoning() {},
	};
	return {
		reloadReplicatedSession: async replicaPath => options.onReload?.(replicaPath),
		refreshReplicatedSessionContext: () => options.onRefresh?.(),
		sessionManager: { ingestReplicatedEntry() {} },
		agent,
	};
}

async function hydrate(guest: CollabRpcGuest, transport: TestTransport): Promise<void> {
	const hydration = guest.start();
	transport.deliver(welcome());
	transport.deliver({ t: "snapshot-chunk", entries: [entry], final: true });
	await hydration;
}

function mutation(commandId: string): RpcMutationCommand {
	return {
		id: "prompt",
		type: "prompt",
		message: "run once",
		mutation: { commandId, runtimeId: "runtime-1", generation: 2 },
	};
}

function receipt(command: RpcMutationCommand): RpcMutationReceipt {
	if (!command.mutation) throw new Error("Expected mutation context");
	return {
		...command.mutation,
		owner: "omp",
		operation: command.type,
		fingerprint: fingerprintRpcMutation(command),
		replayed: false,
		session: { status: "completed", sessionId: "host-session" },
	};
}

describe("CollabRpcGuest", () => {
	it("hydrates the replica before exposing authoritative reads and mutations", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-rpc-guest-"));
		try {
			const transport = new TestTransport();
			const replicaPath = path.join(root, "replica.jsonl");
			const guest = new CollabRpcGuest({ transport, session: createSession(), roomId: "room-1", replicaPath });
			const hydration = guest.start();
			expect(await guest.handleCommand({ id: "early", type: "get_state" })).toMatchObject({
				success: false,
				code: "unavailable",
			});
			expect(transport.sent).toContainEqual({ t: "hello", proto: COLLAB_PROTO, name: "OMP RPC guest" });
			transport.deliver(welcome());
			transport.deliver({ t: "snapshot-chunk", entries: [entry], final: true });
			await hydration;
			expect(await Bun.file(replicaPath).text()).toContain("from host");
			expect(guest.identity).toEqual(identity);
			const read = guest.handleCommand({ id: "history", type: "history_digest" });
			await Promise.resolve();
			const readRequest = transport.sent.at(-1);
			if (readRequest?.t !== "rpc-request") throw new Error("Expected forwarded history request");
			transport.deliver({
				t: "rpc-result",
				requestId: readRequest.requestId,
				response: {
					id: "history",
					type: "response",
					command: "history_digest",
					success: true,
					data: {
						algorithm: "sha256",
						value: "a".repeat(64),
						byteLength: 0,
						entryCount: 0,
						branchEntryCount: 0,
						leafId: null,
					},
				},
			});
			expect(await read).toMatchObject({ success: true, command: "history_digest" });

			const command = mutation("command-prompt");
			const pending = guest.handleCommand(command);
			await Promise.resolve();
			const mutationRequest = transport.sent.at(-1);
			if (mutationRequest?.t !== "rpc-request") throw new Error("Expected forwarded mutation request");
			transport.deliver({
				t: "rpc-result",
				requestId: mutationRequest.requestId,
				response: {
					id: command.id,
					type: "response",
					command: "prompt",
					success: true,
					data: { agentInvoked: true },
					receipt: receipt(command),
				},
			});
			expect(await pending).toMatchObject({ success: true, receipt: { commandId: "command-prompt" } });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("forwards collab events, RPC output, and control sidechannels without local authority", async () => {
		const transport = new TestTransport();
		const guest = new CollabRpcGuest({ transport, session: createSession(), roomId: "room-events" });
		await hydrate(guest, transport);
		const events: object[] = [];
		const delivered = Promise.withResolvers<void>();
		guest.subscribe(event => {
			events.push(event);
			if (
				"type" in event &&
				event.type === "collab_frame" &&
				"frame" in event &&
				typeof event.frame === "object" &&
				event.frame !== null &&
				"t" in event.frame &&
				event.frame.t === "error"
			) {
				delivered.resolve();
			}
		});
		transport.deliver({ t: "bus", channel: "task:subagent:progress", data: { id: "sub-1" } });
		transport.deliver({ t: "rpc-output", output: { type: "host_tool_call", id: "tool-1" } });
		transport.deliver({ t: "error", message: "recoverable rejection" });
		await delivered.promise;
		expect(events).toContainEqual({ type: "collab_frame", frame: { t: "error", message: "recoverable rejection" } });
		expect(events).toContainEqual({
			type: "collab_frame",
			frame: { t: "bus", channel: "task:subagent:progress", data: { id: "sub-1" } },
		});
		expect(events).toContainEqual({ type: "host_tool_call", id: "tool-1" });
		guest.handleControlFrame({ type: "extension_ui_response", id: "ui-1", cancelled: true });
		expect(transport.sent.at(-1)).toEqual({
			t: "rpc-control",
			frame: { type: "extension_ui_response", id: "ui-1", cancelled: true },
		});
	});

	it("preserves ambiguous mutation terminals and announces the unavailable authority", async () => {
		const transport = new TestTransport();
		const guest = new CollabRpcGuest({ transport, session: createSession(), roomId: "room-terminal" });
		await hydrate(guest, transport);
		const terminals: string[] = [];
		guest.onTerminal(reason => terminals.push(reason));
		const pendingMutation = guest.handleCommand(mutation("command-terminal"));
		const pendingRead = guest.handleCommand({ id: "read-terminal", type: "get_state" });
		await Promise.resolve();
		transport.terminate("host closed");
		expect(await pendingMutation).toMatchObject({ success: false, code: "ambiguous" });
		expect(await pendingRead).toMatchObject({ success: false, code: "unavailable" });
		expect(terminals).toEqual(["host closed"]);
	});

	it("rejects a welcome that lacks the durable guest capability handshake", async () => {
		const transport = new TestTransport();
		const guest = new CollabRpcGuest({ transport, session: createSession(), roomId: "room-capability" });
		const hydration = guest.start();
		const missingCapability = {
			...identity,
			capabilities: identity.capabilities.filter(capability => capability !== "mutation-receipts"),
		};
		transport.deliver({ ...welcome(), rpc: missingCapability });
		await expect(hydration).rejects.toThrow("missing required RPC capability: mutation-receipts");
	});

	it("rejects a failed host handshake and a public welcome without RPC identity", async () => {
		const deniedTransport = new TestTransport();
		const denied = new CollabRpcGuest({
			transport: deniedTransport,
			session: createSession(),
			roomId: "room-denied",
		}).start();
		deniedTransport.deliver({ t: "error", message: "startup denied" });
		await expect(denied).rejects.toThrow("startup denied");

		const publicTransport = new TestTransport();
		const publicGuest = new CollabRpcGuest({
			transport: publicTransport,
			session: createSession(),
			roomId: "room-public",
		}).start();
		const { rpc: _rpc, ...publicWelcome } = welcome();
		publicTransport.deliver(publicWelcome);
		await expect(publicGuest).rejects.toThrow("invalid RPC identity");
	});
});
