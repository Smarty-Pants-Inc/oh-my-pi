import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OMP_BUILD_ID } from "../../src/build-identity";
import * as herdrBridge from "../../src/collab/herdr-bridge";
import {
	HerdrAgentdHostLifecycle,
	type ManagedHerdrAgentdHostBridge,
} from "../../src/collab/herdr-agentd-host-lifecycle";
import type { CollabHostContext } from "../../src/collab/host";
import type { RpcHerdrAgentdHostBridge } from "../../src/modes/rpc/rpc-types";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";

type HostAnnouncement = {
	t: "host";
	token: string;
	paneId: string;
	ompSessionId: string;
	routeGeneration: number;
	ompBuildId: string;
	runtimeOwner: string;
};

function createBridgeServer(autoReady: boolean) {
	const announcements: HostAnnouncement[] = [];
	const byes: Record<string, unknown>[] = [];
	const hostWaiters: ((announcement: HostAnnouncement) => void)[] = [];
	const byeWaiters: ((bye: Record<string, unknown>) => void)[] = [];
	const pending = new Map<Bun.Socket<undefined>, string>();
	let hostSocket: Bun.Socket<undefined> | undefined;
	let nextAnnouncement = 0;
	let nextBye = 0;
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open() {},
			data(socket, data) {
				let text = `${pending.get(socket) ?? ""}${data.toString()}`;
				let newline = text.indexOf("\n");
				while (newline >= 0) {
					const line = text.slice(0, newline);
					text = text.slice(newline + 1);
					if (line) {
						const record = JSON.parse(line) as Record<string, unknown>;
						if (record.t === "host") {
							const announcement = record as unknown as HostAnnouncement;
							hostSocket = socket;
							announcements.push(announcement);
							hostWaiters.shift()?.(announcement);
							if (autoReady) socket.write('{"t":"ready"}\n');
						} else if (record.t === "bye") {
							byes.push(record);
							byeWaiters.shift()?.(record);
						}
					}
					newline = text.indexOf("\n");
				}
				pending.set(socket, text);
			},
			close(socket) {
				pending.delete(socket);
			},
		},
	});
	const waitFor = <T>(items: T[], cursor: () => number, increment: () => void, waiters: ((item: T) => void)[]) => {
		const item = items[cursor()];
		if (item) {
			increment();
			return Promise.resolve(item);
		}
		const { promise, resolve } = Promise.withResolvers<T>();
		waiters.push(item => {
			increment();
			resolve(item);
		});
		return promise;
	};
	return {
		server,
		announcements,
		waitForAnnouncement: () =>
			waitFor(
				announcements,
				() => nextAnnouncement,
				() => nextAnnouncement++,
				hostWaiters,
			),
		waitForBye: () =>
			waitFor(
				byes,
				() => nextBye,
				() => nextBye++,
				byeWaiters,
			),
		ready: () => hostSocket?.write('{"t":"ready"}\n'),
	};
}

function createPreparedBridgeServer(
	responses: Array<"ready" | "route_busy" | "route_busy_message" | "rejected" | "pending">,
) {
	const socketPath = path.join(os.tmpdir(), `omp-herdr-rebind-${crypto.randomUUID()}.sock`);
	const announcements: HostAnnouncement[] = [];
	const pending = new Map<Bun.Socket<undefined>, string>();
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	const server = Bun.listen({
		unix: socketPath,
		socket: {
			open() {},
			data(socket, data) {
				let text = `${pending.get(socket) ?? ""}${data.toString()}`;
				let newline = text.indexOf("\n");
				while (newline >= 0) {
					const line = text.slice(0, newline);
					text = text.slice(newline + 1);
					if (line) {
						const record = JSON.parse(line) as Record<string, unknown>;
						if (record.t === "host") {
							announcements.push(record as unknown as HostAnnouncement);
							for (const waiter of waiters.splice(0)) {
								if (announcements.length >= waiter.count) waiter.resolve();
								else waiters.push(waiter);
							}
							const response = responses[announcements.length - 1] ?? "rejected";
							if (response === "ready") socket.write('{"t":"ready"}\n');
							else if (response === "route_busy")
								socket.write(
									'{"t":"error","code":"route_busy","message":"OMP host route is already active"}\n',
								);
							else if (response === "route_busy_message") socket.write('{"t":"error","message":"route_busy"}\n');
							else if (response === "rejected")
								socket.write('{"t":"error","code":"rejected","message":"credential rejected"}\n');
						}
					}
					newline = text.indexOf("\n");
				}
				pending.set(socket, text);
			},
			close(socket) {
				pending.delete(socket);
			},
		},
	});
	return {
		address: socketPath,
		announcements,
		waitForAnnouncements(count: number): Promise<void> {
			if (announcements.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ count, resolve });
			return promise;
		},
		close(): void {
			server.stop(true);
			fs.rmSync(socketPath, { force: true });
		},
	};
}

function createContext(sessionManager: { getSessionId(): string }): CollabHostContext {
	return {
		session: {
			isStreaming: false,
			subscribe: () => () => {},
			emitNotice: () => {},
		},
		sessionManager,
		settings: { get: () => undefined },
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		updatePendingMessagesDisplay: () => {},
	} as unknown as CollabHostContext;
}

function createLifecycle(
	sessionManager: { getSessionId(): string },
	registerSessionChangeCallback: (callback: () => void) => () => void,
	bridge: RpcHerdrAgentdHostBridge,
): HerdrAgentdHostLifecycle {
	const session = {
		sessionManager,
		registerSessionChangeCallback,
	} as unknown as Pick<AgentSession, "registerSessionChangeCallback" | "sessionManager">;
	const managedBridge = bridge as ManagedHerdrAgentdHostBridge;
	managedBridge.role = "host";
	managedBridge.managed = true;
	managedBridge.runtimeOwner = "agentd";
	return new HerdrAgentdHostLifecycle(createContext(sessionManager), session, managedBridge);
}

function credentials(server: { port: number }, token = "bridge-token"): RpcHerdrAgentdHostBridge {
	return { address: `127.0.0.1:${server.port}`, token, paneId: "pane-1", routeGeneration: 1 };
}

afterEach(() => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
});

describe("agentd Herdr host lifecycle", () => {
	it("uses the redeemed direct tuple before RPC readiness without legacy discovery", async () => {
		const bridge = createBridgeServer(false);
		const initial = credentials(bridge.server);
		let sessionChange: (() => void) | undefined;
		const sessionManager = { getSessionId: () => "session-one" };
		const lifecycle = createLifecycle(
			sessionManager,
			callback => {
				sessionChange = callback;
				return () => {
					if (sessionChange === callback) sessionChange = undefined;
				};
			},
			initial,
		);
		const discovery = vi
			.spyOn(herdrBridge, "discoverHerdrHostBridge")
			.mockRejectedValue(new Error("legacy discovery must not run"));
		let started = false;

		try {
			const starting = lifecycle.start().then(() => {
				started = true;
			});
			const announcement = await bridge.waitForAnnouncement();
			expect(started).toBe(false);
			expect(announcement).toEqual({
				t: "host",
				token: "bridge-token",
				paneId: "pane-1",
				ompSessionId: "session-one",
				routeGeneration: 1,
				ompBuildId: OMP_BUILD_ID,
				runtimeOwner: "agentd",
			});
			expect(discovery).not.toHaveBeenCalled();
			expect(initial).toMatchObject({ address: "", paneId: "", routeGeneration: 0, token: "" });

			bridge.ready();
			await starting;
			expect(sessionChange).toBeDefined();
		} finally {
			await lifecycle.stop("test cleanup");
			bridge.server.stop(true);
		}
	});

	it("accepts a prepared tuple after more than one second, then consumes it exactly once", async () => {
		const initialBridge = createBridgeServer(false);
		const successorBridge = createPreparedBridgeServer(["ready"]);
		let sessionId = "session-one";
		let sessionChange: (() => void) | undefined;
		const lifecycle = createLifecycle(
			{ getSessionId: () => sessionId },
			callback => {
				sessionChange = callback;
				return () => {
					if (sessionChange === callback) sessionChange = undefined;
				};
			},
			credentials(initialBridge.server),
		);
		let now = 100;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

		try {
			const starting = lifecycle.start();
			await initialBridge.waitForAnnouncement();
			lifecycle.handleControlFrame({
				type: "prepare_herdr_agentd_rebind",
				address: successorBridge.address,
				paneId: "pane-1",
				routeGeneration: 1,
				token: "successor-token",
			});
			now = 1_200;
			sessionId = "session-two";
			expect(successorBridge.announcements).toEqual([]);
			if (!sessionChange) throw new Error("Expected a session change callback during route startup");
			sessionChange();
			initialBridge.ready();
			await starting;

			expect(successorBridge.announcements).toEqual([
				{
					t: "host",
					token: "successor-token",
					paneId: "pane-1",
					ompSessionId: "session-two",
					routeGeneration: 1,
					ompBuildId: OMP_BUILD_ID,
					runtimeOwner: "agentd",
				},
			]);

			sessionId = "session-three";
			sessionChange();
			await lifecycle.whenIdle();
			expect(successorBridge.announcements).toHaveLength(1);
		} finally {
			nowSpy.mockRestore();
			await lifecycle.stop("test cleanup");
			initialBridge.server.stop(true);
			successorBridge.close();
		}
	});

	it("unregisters and wipes a prepared tuple while a successor route is pending", async () => {
		const initialBridge = createBridgeServer(true);
		const successorBridge = createPreparedBridgeServer(["pending"]);
		let sessionId = "session-one";
		let sessionChange: (() => void) | undefined;
		let unregisters = 0;
		const lifecycle = createLifecycle(
			{ getSessionId: () => sessionId },
			callback => {
				sessionChange = callback;
				return () => {
					unregisters++;
					if (sessionChange === callback) sessionChange = undefined;
				};
			},
			credentials(initialBridge.server),
		);

		try {
			await lifecycle.start();
			lifecycle.handleControlFrame({
				type: "prepare_herdr_agentd_rebind",
				address: successorBridge.address,
				paneId: "pane-1",
				routeGeneration: 1,
				token: "pending-token",
			});
			sessionId = "session-two";
			if (!sessionChange) throw new Error("Expected a session change callback after route startup");
			sessionChange();
			await successorBridge.waitForAnnouncements(1);

			const stop = lifecycle.stop("RPC owner disposed");
			expect(lifecycle.stop("ignored duplicate stop")).toBe(stop);
			await stop;
			expect(unregisters).toBe(1);
			expect(sessionChange).toBeUndefined();
		} finally {
			await lifecycle.stop("test cleanup");
			initialBridge.server.stop(true);
			successorBridge.close();
		}
	});

	it("fails closed for missing, expired, wrong-generation, and explicitly cleared successor credentials", async () => {
		for (const scenario of ["missing", "expired", "wrong-generation", "cleared"] as const) {
			const initialBridge = createBridgeServer(true);
			const successorBridge = createPreparedBridgeServer(["ready"]);
			let sessionId = "session-one";
			let sessionChange: (() => void) | undefined;
			const lifecycle = createLifecycle(
				{ getSessionId: () => sessionId },
				callback => {
					sessionChange = callback;
					return () => {
						if (sessionChange === callback) sessionChange = undefined;
					};
				},
				credentials(initialBridge.server),
			);
			let now = 100;
			const nowSpy = scenario === "expired" ? vi.spyOn(Date, "now").mockImplementation(() => now) : undefined;

			try {
				await lifecycle.start();
				if (scenario !== "missing") {
					lifecycle.handleControlFrame({
						type: "prepare_herdr_agentd_rebind",
						address: successorBridge.address,
						paneId: "pane-1",
						routeGeneration: scenario === "wrong-generation" ? 2 : 1,
						token: `${scenario}-token`,
					});
				}
				if (scenario === "expired") now = 15_101;
				if (scenario === "cleared") lifecycle.handleControlFrame({ type: "clear_herdr_agentd_rebind" });
				sessionId = "session-two";
				if (!sessionChange) throw new Error("Expected a session change callback after route startup");
				sessionChange();
				await lifecycle.whenIdle();
				expect(successorBridge.announcements, scenario).toEqual([]);
			} finally {
				nowSpy?.mockRestore();
				await lifecycle.stop("test cleanup");
				initialBridge.server.stop(true);
				successorBridge.close();
			}
		}
	});

	it("retains the exact tuple for one exact route_busy retry and never retries another rejection", async () => {
		const scenarios = [
			{ name: "busy-then-ready", responses: ["route_busy", "ready"], attempts: 2 },
			{ name: "busy-twice", responses: ["route_busy", "route_busy", "ready"], attempts: 2 },
			{ name: "non-route-busy", responses: ["rejected", "ready"], attempts: 1 },
			{ name: "route-busy-message", responses: ["route_busy_message", "ready"], attempts: 1 },
		] as const;
		for (const scenario of scenarios) {
			const initialBridge = createBridgeServer(true);
			const successorBridge = createPreparedBridgeServer([...scenario.responses]);
			let sessionId = "session-one";
			let sessionChange: (() => void) | undefined;
			const lifecycle = createLifecycle(
				{ getSessionId: () => sessionId },
				callback => {
					sessionChange = callback;
					return () => {
						if (sessionChange === callback) sessionChange = undefined;
					};
				},
				credentials(initialBridge.server),
			);
			const token = `${scenario.name}-token`;

			try {
				await lifecycle.start();
				lifecycle.handleControlFrame({
					type: "prepare_herdr_agentd_rebind",
					address: successorBridge.address,
					paneId: "pane-1",
					routeGeneration: 1,
					token,
				});
				sessionId = "session-two";
				if (!sessionChange) throw new Error("Expected a session change callback after route startup");
				sessionChange();
				await successorBridge.waitForAnnouncements(scenario.attempts);
				await lifecycle.whenIdle();
				expect(successorBridge.announcements, scenario.name).toHaveLength(scenario.attempts);
				for (const announcement of successorBridge.announcements) {
					expect(announcement).toMatchObject({
						token,
						paneId: "pane-1",
						ompSessionId: "session-two",
						routeGeneration: 1,
					});
				}
			} finally {
				await lifecycle.stop("test cleanup");
				initialBridge.server.stop(true);
				successorBridge.close();
			}
		}
	});
});
