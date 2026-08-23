import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import {
	type AgentSnapshot,
	COLLAB_PROTO,
	type CollabFrame,
	formatCollabLink,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import {
	countRunningSubagentBadgeAgents,
	getRunningSubagentBadgeRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/running-subagent-badge";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import { InMemoryCollabRouter } from "./helpers/in-memory-transport";

// In-memory transport: shared FakeWebSocket + InMemoryRelay harness (see
// ./helpers/in-memory-relay), mirroring the relay's forwarding contract.

function makeState(): Extract<CollabFrame, { t: "welcome" }>["state"] {
	return {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "host session",
		cwd: "/tmp",
		participants: [{ name: "Host", role: "host" }],
	};
}

function makeAgents(ids: string[]): AgentSnapshot[] {
	return ids.map((id, index) => ({
		id,
		displayName: `Remote ${index + 1}`,
		kind: "sub",
		parentId: "Main",
		status: "running",
		hasSessionFile: true,
		createdAt: 1000 + index,
		lastActivity: 2000 + index,
	}));
}

function makeGuestContext(counts: number[], refreshedModels: string[] = []): InteractiveModeContext {
	let statusLineCount = 0;
	const agentState: { model: Model | undefined } = { model: undefined };
	const ctx = {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: { get: () => "" },
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
		},
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			agent: {
				state: agentState,
				setModel: (model: Model) => {
					agentState.model = model;
				},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setSubagentCount: (count: number) => {
				statusLineCount = count;
			},
			get subagentCount() {
				return statusLineCount;
			},
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: { handleEvent: () => Promise.resolve() },
		refreshModelDisplay: () => refreshedModels.push(agentState.model?.name ?? "Unknown"),
		syncRunningSubagentBadge: () => {
			const registry = getRunningSubagentBadgeRegistry(ctx.collabGuest);
			const count = countRunningSubagentBadgeAgents(registry);
			ctx.statusLine.setSubagentCount(count);
			counts.push(count);
		},
	} as unknown as InteractiveModeContext;
	return ctx;
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

describe("collab guest running-subagents badge", () => {
	it("uses the guest mirror registry and refreshes on join, resnapshot, and leave", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const roomId = "badge-room-1";
		const roomKey = generateRoomKey();
		const cryptoKey = await importRoomKey(roomKey);
		const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
		const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
		const hostOpen = Promise.withResolvers<void>();
		let nextWelcomeAgents = makeAgents(["remote-one"]);
		const sendWelcome = (agents: AgentSnapshot[]) => {
			hostSocket.send({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" },
				state: makeState(),
				agents,
				entryCount: 0,
			});
		};
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t === "hello") sendWelcome(nextWelcomeAgents);
		};
		hostSocket.connect();
		await hostOpen.promise;

		const counts: number[] = [];
		const ctx = makeGuestContext(counts);
		const guest = new CollabGuestLink(ctx);

		try {
			await guest.join(link);
			expect(ctx.collabGuest).toBe(guest);
			expect(counts).toEqual([0, 1]);
			expect(ctx.statusLine.subagentCount).toBe(1);

			nextWelcomeAgents = makeAgents(["remote-one", "remote-two"]);
			const secondSnapshot = Promise.withResolvers<void>();
			const originalSync = ctx.syncRunningSubagentBadge.bind(ctx);
			ctx.syncRunningSubagentBadge = () => {
				originalSync();
				if (ctx.statusLine.subagentCount === 2) secondSnapshot.resolve();
			};
			sendWelcome(nextWelcomeAgents);
			await secondSnapshot.promise;
			expect(ctx.statusLine.subagentCount).toBe(2);

			await guest.leave("test cleanup");
			expect(ctx.collabGuest).toBeUndefined();
			expect(ctx.statusLine.subagentCount).toBe(0);
			expect(counts.at(-1)).toBe(0);
		} finally {
			hostSocket.close();
			writeSpy.mockRestore();
			await guest.leave("test cleanup").catch(() => {});
		}
	});
});

describe("collab guest replica readiness", () => {
	it("refreshes model-dependent UI after applying the authoritative host model", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled collab test model");
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const router = new InMemoryCollabRouter();
		const hostTransport = router.host();
		const guestTransport = router.guest();
		const refreshedModels: string[] = [];
		const ctx = makeGuestContext([], refreshedModels);
		hostTransport.onFrame = (frame, peer) => {
			if (frame.t !== "hello") return;
			hostTransport.send(
				{
					t: "welcome",
					proto: COLLAB_PROTO,
					header: {
						type: "session",
						id: "remote-model-session",
						timestamp: "2026-08-22T00:00:00Z",
						cwd: "/host/project",
					},
					state: { ...makeState(), cwd: "/host/project", model },
					agents: [],
					entryCount: 0,
				},
				peer,
			);
		};
		hostTransport.connect();
		const guest = new CollabGuestLink(ctx);

		try {
			await guest.joinWithTransport(guestTransport, { roomId: "authoritative-model-room" });
			expect(ctx.session.agent.state.model).toEqual(model);
			expect(refreshedModels).toEqual([model.name]);
		} finally {
			await guest.leave("test cleanup").catch(() => {});
			hostTransport.close();
			writeSpy.mockRestore();
		}
	});

	it("waits for snapshot-adjacent UI replay before signaling each active epoch", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const router = new InMemoryCollabRouter();
		const hostTransport = router.host();
		const readySignals: number[] = [];
		const firstReady = Promise.withResolvers<void>();
		const secondReady = Promise.withResolvers<void>();
		const guestTransport = Object.assign(router.guest(), {
			notifyReplicaReady: () => {
				readySignals.push(readySignals.length + 1);
				if (readySignals.length === 1) firstReady.resolve();
				if (readySignals.length === 2) secondReady.resolve();
			},
		});
		const firstUiApplied = Promise.withResolvers<void>();
		const secondUiApplied = Promise.withResolvers<void>();
		const ctx = makeGuestContext([]);
		ctx.showHookSelector = title => {
			if (title === "initial pending ask") firstUiApplied.resolve();
			if (title === "resync pending ask") secondUiApplied.resolve();
			return Promise.withResolvers<string | undefined>().promise;
		};
		const firstSnapshotSwitchStarted = Promise.withResolvers<void>();
		const finishFirstSnapshotSwitch = Promise.withResolvers<void>();
		let switchCount = 0;
		ctx.session.switchSession = async () => {
			switchCount += 1;
			if (switchCount === 1) {
				firstSnapshotSwitchStarted.resolve();
				await finishFirstSnapshotSwitch.promise;
			}
			return true;
		};
		const entries = [
			{
				type: "custom" as const,
				id: "snapshot-first",
				parentId: null,
				timestamp: "2026-08-21T00:00:00Z",
				customType: "test",
			},
			{
				type: "custom" as const,
				id: "snapshot-second",
				parentId: "snapshot-first",
				timestamp: "2026-08-21T00:00:01Z",
				customType: "test",
			},
		];
		const sendWelcome = (peer: number, replayEpoch: number): void => {
			hostTransport.send(
				{
					t: "welcome",
					proto: COLLAB_PROTO,
					header: { type: "session", id: "remote-session", timestamp: "2026-08-21T00:00:00Z", cwd: "/tmp" },
					state: makeState(),
					agents: [],
					entryCount: entries.length,
					replayEpoch,
				},
				peer,
			);
		};
		const initialWelcome = Promise.withResolvers<number>();
		hostTransport.onFrame = (frame, peer) => {
			if (frame.t !== "hello") return;
			sendWelcome(peer, 1);
			initialWelcome.resolve(peer);
		};
		hostTransport.connect();
		const guest = new CollabGuestLink(ctx);
		const joining = guest.joinWithTransport(guestTransport, { roomId: "replica-ready-room" });
		void joining.catch(() => {});

		try {
			const peer = await initialWelcome.promise;
			hostTransport.send({ t: "snapshot-chunk", entries: [entries[0]], final: false }, peer);
			hostTransport.send({ t: "snapshot-chunk", entries: [entries[1]], final: true }, peer);
			await firstSnapshotSwitchStarted.promise;
			expect(readySignals).toEqual([]);
			finishFirstSnapshotSwitch.resolve();
			await joining;
			expect(readySignals).toEqual([]);

			hostTransport.send(
				{
					t: "ui-request",
					request: { reqId: 1, kind: "select", title: "initial pending ask", options: ["Continue"] },
				},
				peer,
			);
			await firstUiApplied.promise;
			expect(readySignals).toEqual([]);
			hostTransport.send({ t: "replay-complete", replayEpoch: 1 }, peer);
			await firstReady.promise;
			expect(readySignals).toEqual([1]);

			sendWelcome(peer, 2);
			hostTransport.send({ t: "snapshot-chunk", entries: [entries[0]], final: false }, peer);
			hostTransport.send({ t: "snapshot-chunk", entries: [entries[1]], final: true }, peer);
			hostTransport.send({ t: "replay-complete", replayEpoch: 1 }, peer);
			hostTransport.send(
				{
					t: "ui-request",
					request: { reqId: 2, kind: "select", title: "resync pending ask", options: ["Continue"] },
				},
				peer,
			);
			await secondUiApplied.promise;
			expect(readySignals).toEqual([1]);
			hostTransport.send({ t: "replay-complete", replayEpoch: 2 }, peer);
			await secondReady.promise;
			hostTransport.send({ t: "replay-complete", replayEpoch: 2 }, peer);
			await flush();
			expect(readySignals).toEqual([1, 2]);

			await guest.leave("detached");
			guestTransport.onFrame?.({ t: "replay-complete", replayEpoch: 2 }, 0);
			await flush();
			expect(readySignals).toEqual([1, 2]);
		} finally {
			finishFirstSnapshotSwitch.resolve();
			await guest.leave("test cleanup").catch(() => {});
			hostTransport.close();
			writeSpy.mockRestore();
		}
	});
});
