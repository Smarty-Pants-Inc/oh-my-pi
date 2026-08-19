import { afterEach, describe, expect, it } from "bun:test";
import { HerdrCollabHostLifecycle } from "@oh-my-pi/pi-coding-agent/collab/herdr-host-lifecycle";
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

afterEach(() => AgentRegistry.resetGlobalForTests());

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
								socket.write('{"t":"ready"}\n');
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
		const lifecycle = new HerdrCollabHostLifecycle(ctx, session, {
			role: "host",
			managed: true,
			address: `127.0.0.1:${server.port}`,
			token: "bridge-token",
			paneId: "pane-1",
			routeGeneration: 1,
		});

		try {
			await lifecycle.start(true);
			expect(records).toHaveLength(0);
			await lifecycle.resume();
			const first = await waitForRecord(0);
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
										: '{"t":"ready"}\n',
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
		const lifecycle = new HerdrCollabHostLifecycle(ctx, session, {
			role: "host",
			managed: true,
			address: `127.0.0.1:${server.port}`,
			token: "bridge-token",
			paneId: "pane-1",
			routeGeneration: 1,
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
										? '{"t":"ready"}\n'
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
		const lifecycle = new HerdrCollabHostLifecycle(ctx, session, {
			role: "host",
			managed: true,
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
								socket.write('{"t":"ready"}\n');
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
		const lifecycle = new HerdrCollabHostLifecycle(ctx, session, {
			role: "host",
			managed: true,
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
});
