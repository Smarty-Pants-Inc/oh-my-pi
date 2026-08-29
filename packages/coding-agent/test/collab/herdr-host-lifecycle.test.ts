import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	HerdrBridgeDiscovery,
	HerdrHostBridgeCredentials,
} from "@oh-my-pi/pi-coding-agent/collab/herdr-bridge-bootstrap";
import * as herdrBridgeBootstrapModule from "@oh-my-pi/pi-coding-agent/collab/herdr-bridge-bootstrap";
import {
	HerdrCollabHostLifecycle,
	type ManagedHerdrHostBridge,
} from "@oh-my-pi/pi-coding-agent/collab/herdr-host-lifecycle";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function makeContext(sessionManager: {
	getSessionId: () => string;
	snapshotForReplication: () => unknown;
}): InteractiveModeContext {
	return {
		settings: { get: () => "" },
		sessionManager,
		session: {
			isStreaming: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "host session",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {
				throw new Error("private Herdr host must not update public collab status");
			},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		showError: () => {},
		updatePendingMessagesDisplay: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

afterEach(() => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
});

const TEST_DISCOVERY: HerdrBridgeDiscovery = { socketPath: "/synthetic/herdr.sock", paneId: "pane-1" };

function createLifecycle(
	ctx: InteractiveModeContext,
	session: Pick<AgentSession, "registerSessionChangeCallback" | "sessionManager">,
	credentials: HerdrHostBridgeCredentials,
	discoverHostBridge: (discovery: HerdrBridgeDiscovery) => Promise<HerdrHostBridgeCredentials> = async () =>
		credentials,
): HerdrCollabHostLifecycle {
	vi.spyOn(herdrBridgeBootstrapModule, "discoverHerdrHostBridge").mockImplementation(discoverHostBridge);
	const bridge: ManagedHerdrHostBridge = {
		role: "host",
		managed: true,
		current: credentials,
		discovery: TEST_DISCOVERY,
		routeGeneration: 1,
	};
	return new HerdrCollabHostLifecycle(ctx, session, bridge);
}

describe("managed Herdr collab host lifecycle", () => {
	it("defers an initially suspended private route until the public guest session ends", async () => {
		let sessionId = "session-one";
		let sessionChange: (() => void) | undefined;
		const sessionManager = {
			getSessionId: () => sessionId,
			snapshotForReplication: () => ({
				header: { type: "session", id: sessionId, timestamp: "2026-01-01T00:00:00Z", cwd: "/host" },
				entries: [],
			}),
		};
		const ctx = makeContext(sessionManager);
		const publicHost = {} as InteractiveModeContext["collabHost"];
		ctx.collabHost = publicHost;

		const records: Record<string, unknown>[] = [];
		const waiters = new Map<number, (record: Record<string, unknown>) => void>();
		let pending = "";
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open() {},
				data(socket, data) {
					pending += data.toString();
					let newline = pending.indexOf("\n");
					while (newline >= 0) {
						const line = pending.slice(0, newline);
						pending = pending.slice(newline + 1);
						if (line.trim()) {
							const record = JSON.parse(line) as Record<string, unknown>;
							if (record.t === "host") {
								const index = records.push(record) - 1;
								waiters.get(index)?.(record);
								waiters.delete(index);
								socket.write('{"t":"ready","routeGeneration":1}\n');
							}
						}
						newline = pending.indexOf("\n");
					}
				},
			},
		});
		const waitForRecord = (index: number): Promise<Record<string, unknown>> => {
			const record = records[index];
			if (record) return Promise.resolve(record);
			const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
			waiters.set(index, resolve);
			return promise;
		};

		const session = {
			sessionManager,
			registerSessionChangeCallback(callback: () => void) {
				sessionChange = callback;
				return () => {
					if (sessionChange === callback) sessionChange = undefined;
				};
			},
		} as unknown as Pick<AgentSession, "registerSessionChangeCallback" | "sessionManager">;
		const credentials = {
			address: `127.0.0.1:${server.port}`,
			token: "bridge-token",
			paneId: "pane-1",
			routeGeneration: 1,
		};
		let discoveryRequests = 0;
		const lifecycle = createLifecycle(ctx, session, credentials, async discovery => {
			discoveryRequests += 1;
			expect(discovery).toEqual(TEST_DISCOVERY);
			return credentials;
		});

		try {
			await lifecycle.start(true);
			expect(discoveryRequests).toBe(0);
			expect(records).toHaveLength(0);
			await lifecycle.resume();
			const first = await waitForRecord(0);
			expect(discoveryRequests).toBe(1);
			const firstHost = ctx.herdrCollabHost;
			expect(first).toMatchObject({
				t: "host",
				ompSessionId: "session-one",
				routeGeneration: 1,
			});
			expect(firstHost).toBeDefined();
			expect(ctx.collabHost).toBe(publicHost);

			await lifecycle.suspend("public collab guest active");
			expect(ctx.herdrCollabHost).toBeUndefined();
			expect(ctx.collabHost).toBe(publicHost);

			ctx.collabGuest = {} as InteractiveModeContext["collabGuest"];
			await lifecycle.resume();
			expect(records).toHaveLength(1);
			expect(ctx.herdrCollabHost).toBeUndefined();

			await lifecycle.suspend("public collab guest active");
			sessionId = "session-two";
			sessionChange?.();
			await lifecycle.whenIdle();
			expect(records).toHaveLength(1);
			ctx.collabGuest = undefined;
			await lifecycle.resume();
			const second = await waitForRecord(1);
			expect(discoveryRequests).toBe(2);
			expect(second).toMatchObject({
				t: "host",
				ompSessionId: "session-two",
				routeGeneration: 1,
			});
			expect(ctx.herdrCollabHost).toBeDefined();
			expect(ctx.herdrCollabHost).not.toBe(firstHost);
			expect(ctx.collabHost).toBe(publicHost);
		} finally {
			await lifecycle.stop("test cleanup");
			server.stop(true);
		}
		expect(ctx.herdrCollabHost).toBeUndefined();
		expect(ctx.collabHost).toBe(publicHost);
	});

	it("uses the retained discovery and each canonical ready generation for the next managed rearm", async () => {
		const sessionManager = {
			getSessionId: () => "session-one",
			snapshotForReplication: () => ({
				header: { type: "session", id: "session-one", timestamp: "2026-01-01T00:00:00Z", cwd: "/host" },
				entries: [],
			}),
		};
		const ctx = makeContext(sessionManager);
		const announcedGenerations: number[] = [];
		let canonicalGeneration = 1;
		let pending = "";
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open() {},
				data(socket, data) {
					pending += data.toString();
					let newline = pending.indexOf("\n");
					while (newline >= 0) {
						const line = pending.slice(0, newline);
						pending = pending.slice(newline + 1);
						if (line.trim()) {
							const record = JSON.parse(line) as Record<string, unknown>;
							if (record.t === "host") {
								const routeGeneration = record.routeGeneration;
								if (typeof routeGeneration !== "number") throw new Error("Expected host route generation");
								announcedGenerations.push(routeGeneration);
								if (routeGeneration !== canonicalGeneration) {
									socket.write(
										`${JSON.stringify({
											t: "error",
											code: "route-generation-mismatch",
											message: `expected route generation ${canonicalGeneration}`,
										})}\n`,
									);
								} else {
									canonicalGeneration += 1;
									socket.write(`${JSON.stringify({ t: "ready", routeGeneration: canonicalGeneration })}\n`);
								}
							}
						}
						newline = pending.indexOf("\n");
					}
				},
			},
		});
		const session = {
			sessionManager,
			registerSessionChangeCallback: () => () => {},
		} as unknown as Pick<AgentSession, "registerSessionChangeCallback" | "sessionManager">;
		const credentials = {
			address: `127.0.0.1:${server.port}`,
			token: "bridge-token",
			paneId: "pane-1",
			routeGeneration: 1,
		};
		const lifecycle = createLifecycle(ctx, session, credentials, async () => ({
			...credentials,
			routeGeneration: canonicalGeneration,
		}));

		try {
			await lifecycle.start();
			await lifecycle.suspend("test rearm");
			await lifecycle.resume();
			await lifecycle.suspend("test rearm");
			await lifecycle.resume();
			expect(announcedGenerations).toEqual([1, 2, 3]);
			expect(canonicalGeneration).toBe(4);
		} finally {
			await lifecycle.stop("test cleanup");
			server.stop(true);
		}
	});

	it("does not announce a stale session when the session commits during bridge discovery", async () => {
		let sessionId = "session-one";
		let sessionChange: (() => void) | undefined;
		const sessionManager = {
			getSessionId: () => sessionId,
			snapshotForReplication: () => ({
				header: { type: "session", id: sessionId, timestamp: "2026-01-01T00:00:00Z", cwd: "/host" },
				entries: [],
			}),
		};
		const ctx = makeContext(sessionManager);
		const records: Record<string, unknown>[] = [];
		let pending = "";
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open() {},
				data(socket, data) {
					pending += data.toString();
					const newline = pending.indexOf("\n");
					if (newline < 0) return;
					const record = JSON.parse(pending.slice(0, newline)) as Record<string, unknown>;
					pending = pending.slice(newline + 1);
					if (record.t !== "host") return;
					records.push(record);
					socket.write('{"t":"ready","routeGeneration":1}\n');
				},
			},
		});
		const session = {
			sessionManager,
			registerSessionChangeCallback(callback: () => void) {
				sessionChange = callback;
				return () => {
					if (sessionChange === callback) sessionChange = undefined;
				};
			},
		} as unknown as Pick<AgentSession, "registerSessionChangeCallback" | "sessionManager">;
		const credentials = {
			address: `127.0.0.1:${server.port}`,
			token: "bridge-token",
			paneId: "pane-1",
			routeGeneration: 1,
		};
		const firstDiscovery = Promise.withResolvers<HerdrHostBridgeCredentials>();
		const discoveryStarted = Promise.withResolvers<void>();
		let discoveryRequests = 0;
		const lifecycle = createLifecycle(ctx, session, credentials, async () => {
			discoveryRequests += 1;
			if (discoveryRequests === 1) {
				discoveryStarted.resolve();
				return firstDiscovery.promise;
			}
			return credentials;
		});

		try {
			const starting = lifecycle.start();
			await discoveryStarted.promise;
			sessionId = "session-two";
			sessionChange?.();
			firstDiscovery.resolve(credentials);
			await starting;
			await lifecycle.whenIdle();

			expect(discoveryRequests).toBe(2);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({ t: "host", ompSessionId: "session-two" });
		} finally {
			await lifecycle.stop("test cleanup");
			server.stop(true);
		}
	});

	it("rejects initial activation when Herdr sends ready and terminal close in one read", async () => {
		const sessionManager = {
			getSessionId: () => "session-one",
			snapshotForReplication: () => ({
				header: { type: "session", id: "session-one", timestamp: "2026-01-01T00:00:00Z", cwd: "/host" },
				entries: [],
			}),
		};
		const ctx = makeContext(sessionManager);
		const socket = { write: () => 0, end: () => {} } as unknown as Bun.Socket<undefined>;
		const connectSpy = spyOn(Bun, "connect").mockImplementation(((
			options: Bun.TCPSocketConnectOptions<undefined>,
		) => {
			options.socket.open?.(socket);
			options.socket.data?.(
				socket,
				Buffer.from('{"t":"ready","routeGeneration":2}\n{"t":"close","reason":"bridge dropped"}\n'),
			);
			return Promise.resolve(socket);
		}) as typeof Bun.connect);
		const session = {
			sessionManager,
			registerSessionChangeCallback: () => () => {},
		} as unknown as Pick<AgentSession, "registerSessionChangeCallback" | "sessionManager">;
		const lifecycle = createLifecycle(ctx, session, {
			address: "127.0.0.1:1",
			token: "bridge-token",
			paneId: "pane-1",
			routeGeneration: 1,
		});

		try {
			await expect(lifecycle.start()).rejects.toThrow("bridge dropped");
			expect(ctx.herdrCollabHost).toBeUndefined();
		} finally {
			connectSpy.mockRestore();
			await lifecycle.stop("test cleanup");
		}
	});
	it("waits through a delayed route release and rearms one terminal private-route close", async () => {
		const sessionManager = {
			getSessionId: () => "session-one",
			snapshotForReplication: () => ({
				header: { type: "session", id: "session-one", timestamp: "2026-01-01T00:00:00Z", cwd: "/host" },
				entries: [],
			}),
		};
		const ctx = makeContext(sessionManager);
		const errors: string[] = [];
		const failClosed = Promise.withResolvers<void>();
		ctx.showError = message => {
			errors.push(message);
			if (message.includes("automatic rearm limit reached")) failClosed.resolve();
		};

		const records: Record<string, unknown>[] = [];
		const closers: (() => void)[] = [];
		const waiters = new Map<number, (record: Record<string, unknown>) => void>();
		let pending = "";
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open() {},
				data(socket, data) {
					pending += data.toString();
					let newline = pending.indexOf("\n");
					while (newline >= 0) {
						const line = pending.slice(0, newline);
						pending = pending.slice(newline + 1);
						if (line.trim()) {
							const record = JSON.parse(line) as Record<string, unknown>;
							if (record.t === "host") {
								const index = records.push(record) - 1;
								closers[index] = () => {
									socket.write('{"t":"close","reason":"bridge dropped"}\n');
								};
								waiters.get(index)?.(record);
								waiters.delete(index);
								const routeBusy = index >= 1 && index <= 3;
								socket.write(
									routeBusy
										? '{"t":"error","code":"route_busy","message":"OMP host route is already active"}\n'
										: '{"t":"ready","routeGeneration":1}\n',
								);
							}
						}
						newline = pending.indexOf("\n");
					}
				},
			},
		});
		const waitForRecord = (index: number): Promise<Record<string, unknown>> => {
			const record = records[index];
			if (record) return Promise.resolve(record);
			const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
			waiters.set(index, resolve);
			return promise;
		};
		const session = {
			sessionManager,
			registerSessionChangeCallback: () => () => {},
		} as unknown as Pick<AgentSession, "registerSessionChangeCallback" | "sessionManager">;
		const credentials = {
			address: `127.0.0.1:${server.port}`,
			token: "bridge-token",
			paneId: "pane-1",
			routeGeneration: 1,
		};
		let discoveryRequests = 0;
		const lifecycle = createLifecycle(ctx, session, credentials, async () => {
			discoveryRequests += 1;
			return credentials;
		});

		try {
			await lifecycle.start();
			await waitForRecord(0);
			const initialHost = ctx.herdrCollabHost;
			expect(initialHost).toBeDefined();

			await lifecycle.suspend("public collab guest active");
			await lifecycle.resume();
			const resumedRecord = await waitForRecord(4);
			await lifecycle.whenIdle();
			expect(discoveryRequests).toBe(5);
			const resumedHost = ctx.herdrCollabHost;
			expect(resumedRecord).toMatchObject({ t: "host", ompSessionId: "session-one" });
			expect(records).toHaveLength(5);
			expect(resumedHost).toBeDefined();
			expect(resumedHost).not.toBe(initialHost);

			const closeResumedHost = closers[4];
			if (!closeResumedHost) throw new Error("Expected resumed host close handle");
			closeResumedHost();
			await waitForRecord(5);
			await lifecycle.whenIdle();
			expect(discoveryRequests).toBe(6);
			const rearmedHost = ctx.herdrCollabHost;
			expect(rearmedHost).toBeDefined();
			expect(rearmedHost).not.toBe(resumedHost);
			expect(records).toHaveLength(6);

			const closeRearmedHost = closers[5];
			if (!closeRearmedHost) throw new Error("Expected rearmed host close handle");
			closeRearmedHost();
			await failClosed.promise;
			await lifecycle.whenIdle();
			expect(ctx.herdrCollabHost).toBeUndefined();
			expect(records).toHaveLength(6);
			expect(errors).toContain("Herdr OMP bridge ended (bridge dropped); automatic rearm limit reached");
		} finally {
			await lifecycle.stop("test cleanup");
			server.stop(true);
		}
	});

	it("bounds route_busy retries when a renderer never detaches", async () => {
		const sessionManager = {
			getSessionId: () => "session-one",
			snapshotForReplication: () => ({
				header: { type: "session", id: "session-one", timestamp: "2026-01-01T00:00:00Z", cwd: "/host" },
				entries: [],
			}),
		};
		const ctx = makeContext(sessionManager);
		const errors: string[] = [];
		ctx.showError = message => errors.push(message);
		let hostAnnouncements = 0;
		let pending = "";
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open() {},
				data(socket, data) {
					pending += data.toString();
					let newline = pending.indexOf("\n");
					while (newline >= 0) {
						const line = pending.slice(0, newline);
						pending = pending.slice(newline + 1);
						if (line.trim()) {
							const record = JSON.parse(line) as Record<string, unknown>;
							if (record.t === "host") {
								hostAnnouncements += 1;
								socket.write(
									hostAnnouncements === 1
										? '{"t":"ready","routeGeneration":1}\n'
										: '{"t":"error","code":"route_busy","message":"OMP host route is already active"}\n',
								);
							}
						}
						newline = pending.indexOf("\n");
					}
				},
			},
		});
		const session = {
			sessionManager,
			registerSessionChangeCallback: () => () => {},
		} as unknown as Pick<AgentSession, "registerSessionChangeCallback" | "sessionManager">;
		const lifecycle = createLifecycle(ctx, session, {
			address: `127.0.0.1:${server.port}`,
			token: "bridge-token",
			paneId: "pane-1",
			routeGeneration: 1,
		});

		try {
			await lifecycle.start();
			await lifecycle.suspend("public collab guest active");
			await expect(lifecycle.resume()).rejects.toThrow(/route remained busy/);
			await lifecycle.whenIdle();

			expect(hostAnnouncements).toBeGreaterThan(4);
			expect(hostAnnouncements).toBeLessThan(12);
			expect(errors.some(error => error.includes("route remained busy"))).toBe(true);
		} finally {
			await lifecycle.stop("test cleanup");
			server.stop(true);
		}
	});

	it("does not announce a provisional target when terminal rearm races session rollback", async () => {
		let sessionId = "retained-session";
		let rollbackReconciliation: (() => void) | undefined;
		const sessionManager = {
			getSessionId: () => sessionId,
			snapshotForReplication: () => ({
				header: { type: "session", id: sessionId, timestamp: "2026-01-01T00:00:00Z", cwd: "/host" },
				entries: [],
			}),
		};
		const ctx = makeContext(sessionManager);
		let activeHerdrHost = ctx.herdrCollabHost;
		const terminalDetach = Promise.withResolvers<void>();
		Object.defineProperty(ctx, "herdrCollabHost", {
			configurable: true,
			get: () => activeHerdrHost,
			set: value => {
				if (activeHerdrHost !== undefined && value === undefined) terminalDetach.resolve();
				activeHerdrHost = value;
			},
		});
		const records: Record<string, unknown>[] = [];
		const closers: (() => void)[] = [];
		const waiters = new Map<number, (record: Record<string, unknown>) => void>();
		let pending = "";
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open() {},
				data(socket, data) {
					pending += data.toString();
					let newline = pending.indexOf("\n");
					while (newline >= 0) {
						const line = pending.slice(0, newline);
						pending = pending.slice(newline + 1);
						if (line.trim()) {
							const record = JSON.parse(line) as Record<string, unknown>;
							if (record.t === "host") {
								const index = records.push(record) - 1;
								closers[index] = () => {
									socket.write('{"t":"close","reason":"bridge dropped"}\n');
								};
								waiters.get(index)?.(record);
								waiters.delete(index);
								socket.write('{"t":"ready","routeGeneration":1}\n');
							}
						}
						newline = pending.indexOf("\n");
					}
				},
			},
		});
		const waitForRecord = (index: number): Promise<Record<string, unknown>> => {
			const record = records[index];
			if (record) return Promise.resolve(record);
			const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
			waiters.set(index, resolve);
			return promise;
		};
		const session = {
			sessionManager,
			registerSessionChangeCallback(_callback: () => void, options?: { onRollback?: () => void }) {
				rollbackReconciliation = options?.onRollback;
				return () => {
					rollbackReconciliation = undefined;
				};
			},
		} as unknown as Pick<AgentSession, "registerSessionChangeCallback" | "sessionManager">;
		const lifecycle = createLifecycle(ctx, session, {
			address: `127.0.0.1:${server.port}`,
			token: "bridge-token",
			paneId: "pane-1",
			routeGeneration: 1,
		});

		try {
			await lifecycle.start();
			await waitForRecord(0);
			sessionId = "provisional-target";
			const closeInitialHost = closers[0];
			if (!closeInitialHost) throw new Error("Expected initial host close handle");
			closeInitialHost();
			await terminalDetach.promise;
			await lifecycle.whenIdle();
			expect(records).toHaveLength(1);
			expect(records.some(record => record.ompSessionId === "provisional-target")).toBe(false);

			sessionId = "retained-session";
			if (!rollbackReconciliation) throw new Error("Expected rollback reconciliation callback");
			rollbackReconciliation();
			const retainedRecord = await waitForRecord(1);
			await lifecycle.whenIdle();
			expect(retainedRecord).toMatchObject({ t: "host", ompSessionId: "retained-session" });
			expect(records).toHaveLength(2);
		} finally {
			await lifecycle.stop("test cleanup");
			server.stop(true);
		}
	});

	it.skipIf(process.platform === "win32")(
		"uses discovery credentials before attempting the inherited address",
		async () => {
			const root = await fs.mkdtemp(path.join("/tmp", "omp-herdr-stale-"));
			const socketPath = path.join(root, "herdr.sock");
			const staleAnnouncements: Record<string, unknown>[] = [];
			const freshAnnouncements: Record<string, unknown>[] = [];
			const discoveryRequests: Record<string, unknown>[] = [];
			let stalePending = "";
			let freshPending = "";
			let discoveryPending = "";
			const staleServer = Bun.listen({
				hostname: "127.0.0.1",
				port: 0,
				socket: {
					open() {},
					data(socket, data) {
						stalePending += data.toString();
						const newline = stalePending.indexOf("\n");
						if (newline < 0) return;
						const record = JSON.parse(stalePending.slice(0, newline)) as Record<string, unknown>;
						stalePending = stalePending.slice(newline + 1);
						if (record.t !== "host") return;
						staleAnnouncements.push(record);
						socket.write(
							'{"t":"error","code":"host-authentication-failed","message":"OMP host bridge token was rejected"}\n',
						);
					},
				},
			});
			const freshServer = Bun.listen({
				hostname: "127.0.0.1",
				port: 0,
				socket: {
					open() {},
					data(socket, data) {
						freshPending += data.toString();
						const newline = freshPending.indexOf("\n");
						if (newline < 0) return;
						const record = JSON.parse(freshPending.slice(0, newline)) as Record<string, unknown>;
						freshPending = freshPending.slice(newline + 1);
						if (record.t !== "host") return;
						freshAnnouncements.push(record);
						if (record.routeGeneration !== 7) {
							socket.write(
								'{"t":"error","code":"route-generation-mismatch","message":"expected route generation 7"}\n',
							);
							return;
						}
						socket.write('{"t":"ready","routeGeneration":8}\n');
					},
				},
			});
			const discoveryServer = Bun.listen({
				unix: socketPath,
				socket: {
					open() {},
					data(socket, data) {
						discoveryPending += data.toString();
						const newline = discoveryPending.indexOf("\n");
						if (newline < 0) return;
						const request = JSON.parse(discoveryPending.slice(0, newline)) as Record<string, unknown>;
						discoveryPending = discoveryPending.slice(newline + 1);
						discoveryRequests.push(request);
						socket.write(
							`${JSON.stringify({
								id: request.id,
								result: {
									type: "pane_omp_bridge",
									pane_id: "pane-current",
									address: `127.0.0.1:${freshServer.port}`,
									token: "fresh-token",
									route_generation: 7,
								},
							})}\n`,
						);
					},
					close() {},
					error() {},
				},
			});
			const sessionManager = {
				getSessionId: () => "session-one",
				snapshotForReplication: () => ({
					header: { type: "session", id: "session-one", timestamp: "2026-01-01T00:00:00Z", cwd: "/host" },
					entries: [],
				}),
			};
			const ctx = makeContext(sessionManager);
			const errors: string[] = [];
			ctx.showError = message => errors.push(message);
			const session = {
				sessionManager,
				registerSessionChangeCallback: () => () => {},
			} as unknown as Pick<AgentSession, "registerSessionChangeCallback" | "sessionManager">;
			const lifecycle = new HerdrCollabHostLifecycle(ctx, session, {
				role: "host",
				managed: true,
				current: {
					address: `127.0.0.1:${staleServer.port}`,
					token: "stale-token",
					paneId: "pane-1",
				},
				discovery: { socketPath, paneId: "pane-1" },
				routeGeneration: 1,
			});

			try {
				await lifecycle.start();
				expect(staleAnnouncements).toHaveLength(0);
				expect(discoveryRequests).toHaveLength(1);
				expect(discoveryRequests[0]).toMatchObject({
					method: "pane.omp_bridge",
					params: { pane_id: "pane-1" },
				});
				expect(freshAnnouncements).toHaveLength(1);
				expect(freshAnnouncements[0]?.token).toBe("fresh-token");
				expect(freshAnnouncements[0]?.paneId).toBe("pane-current");
				expect(freshAnnouncements[0]?.routeGeneration).toBe(7);
				expect(ctx.herdrCollabHost).toBeDefined();
				expect(errors).toEqual([]);
			} finally {
				await lifecycle.stop("test cleanup");
				discoveryServer.stop(true);
				staleServer.stop(true);
				freshServer.stop(true);
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);
});
