import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import * as collabGuestModule from "@oh-my-pi/pi-coding-agent/collab/guest";
import { HerdrCollabHostLifecycle } from "@oh-my-pi/pi-coding-agent/collab/herdr-host-lifecycle";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type CollabBridgeBootstrap,
	reconcilePrivateHerdrAfterStartupJoin,
	runInteractiveStartupSequence,
	runRootCommand,
	startManagedHerdrHost,
} from "@oh-my-pi/pi-coding-agent/main";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setInteractiveHost, TempDir } from "@oh-my-pi/pi-utils";

function disableStartupFeatures(parsed: Args, sessionDir: string): void {
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	parsed.sessionDir = sessionDir;
}

function sessionResult(options: CreateAgentSessionOptions, session: AgentSession): CreateAgentSessionResult {
	if (!options.eventBus || !options.preloadedExtensions) {
		throw new Error("Expected main to provide event bus and preloaded extensions");
	}
	return {
		session,
		extensionsResult: options.preloadedExtensions,
		setToolUIContext: () => {},
		eventBus: options.eventBus,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	setInteractiveHost(false);
});

describe("automatic Herdr host activation", () => {
	it("does not start the managed route until splash and setup gates finish", async () => {
		const order: string[] = [];
		const splash = Promise.withResolvers<void>();
		const setup = Promise.withResolvers<void>();
		const privateStart = Promise.withResolvers<void>();
		const startup = runInteractiveStartupSequence(
			async () => {
				order.push("splash-start");
				await splash.promise;
				order.push("splash-done");
			},
			async () => {
				order.push("setup-start");
				await setup.promise;
				order.push("setup-done");
			},
			async () => {
				order.push("private-start");
				privateStart.resolve();
			},
		);
		await Promise.resolve();
		expect(order).toEqual(["splash-start"]);
		splash.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["splash-start", "splash-done", "setup-start"]);
		setup.resolve();
		await startup;
		await privateStart.promise;
		expect(order).toEqual(["splash-start", "splash-done", "setup-start", "setup-done", "private-start"]);
	});

	it("continues without Herdr when initial managed activation fails", async () => {
		const failure = new Error("managed bridge activation failed");
		const start = vi.spyOn(HerdrCollabHostLifecycle.prototype, "start").mockRejectedValue(failure);
		const showError = vi.fn();
		const mode = { showError, herdrCollabHostLifecycle: undefined } as unknown as Parameters<
			typeof startManagedHerdrHost
		>[0];
		const session = {} as Parameters<typeof startManagedHerdrHost>[1];
		const bridge = {
			role: "host",
			managed: true,
			discovery: { socketPath: "/tmp/stale-herdr.sock", paneId: "pane-1" },
			routeGeneration: 1,
		} as const;

		await expect(startManagedHerdrHost(mode, session, bridge, false)).resolves.toBeUndefined();

		expect(start).toHaveBeenCalledWith(false);
		expect(mode.herdrCollabHostLifecycle).toBeUndefined();
		expect(showError).toHaveBeenCalledWith(
			"Herdr OMP bridge unavailable; continuing without Herdr bridge: managed bridge activation failed",
		);
	});

	it("surfaces private-route resume failure when startup join returns without a guest", async () => {
		const failure = new Error("bridge unavailable");
		let resumed = 0;
		let shutdowns = 0;
		const lifecycle = {
			resume: async () => {
				resumed += 1;
				throw failure;
			},
		};
		const shutdown = async (): Promise<void> => {
			shutdowns += 1;
		};

		await expect(
			reconcilePrivateHerdrAfterStartupJoin({
				collabGuest: undefined,
				herdrCollabHostLifecycle: lifecycle,
				shutdown,
			}),
		).rejects.toBe(failure);
		expect(resumed).toBe(1);
		expect(shutdowns).toBe(1);

		await reconcilePrivateHerdrAfterStartupJoin({ collabGuest: {}, herdrCollabHostLifecycle: lifecycle, shutdown });
		expect(resumed).toBe(1);
		expect(shutdowns).toBe(1);
	});

	it("surfaces the restoration-owned first resume failure and cleans up once", async () => {
		const failure = new Error("restored private route activation failed");
		const restorationResume = vi.fn(async () => {
			throw failure;
		});
		const fallbackResume = vi.fn(async () => {});
		const shutdown = vi.fn(async () => {});
		vi.spyOn(collabGuestModule, "getCollabGuestRestorationCompletion").mockImplementation(() => restorationResume());

		await expect(
			reconcilePrivateHerdrAfterStartupJoin({
				collabGuest: undefined,
				herdrCollabHostLifecycle: { resume: fallbackResume },
				shutdown,
			}),
		).rejects.toBe(failure);
		expect(restorationResume).toHaveBeenCalledTimes(1);
		expect(fallbackResume).not.toHaveBeenCalled();
		expect(shutdown).toHaveBeenCalledTimes(1);
	});

	it("passes managed activation for normal start, resume, fork, and join only after session creation", async () => {
		using tempDir = TempDir.createSync("@omp-herdr-activation-");
		const sourceSession = tempDir.join("source.jsonl");
		await Bun.write(
			sourceSession,
			`${JSON.stringify({
				type: "session",
				id: "019f0000-0000-7000-8000-000000000001",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: process.cwd(),
			})}\n`,
		);
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			"startup.changelogMode": "off",
			"startup.checkUpdate": false,
			"startup.showSplash": false,
		});
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const cases = [
			{ name: "start", args: [], join: undefined },
			{ name: "resume", args: [`--resume=${sourceSession}`], join: undefined },
			{ name: "fork", args: [`--fork=${sourceSession}`], join: undefined },
			{ name: "join", args: [], join: "ws://localhost:8788/r/test#key" },
		] as const;

		try {
			for (const scenario of cases) {
				const parsed = parseArgs([...scenario.args]);
				if (scenario.join) parsed.join = scenario.join;
				disableStartupFeatures(parsed, tempDir.join(`sessions-${scenario.name}`));
				const herdrHostBridge = {
					current: {
						address: "127.0.0.1:4321",
						token: `token-${scenario.name}`,
						paneId: "pane-9",
					},
					discovery: { socketPath: `/tmp/herdr-${scenario.name}.sock`, paneId: "pane-9" },
				};
				let manager: SessionManager | undefined;
				let created = false;
				let bridge: CollabBridgeBootstrap | undefined;

				await runRootCommand(parsed, [...scenario.args], {
					herdrHostBridge,
					discoverAuthStorage: async () => authStorage,
					settings,
					createAgentSession: async options => {
						if (!options?.sessionManager) throw new Error("Expected resolved session manager");
						manager = options.sessionManager;
						created = true;
						const session = {
							sessionManager: manager,
							settings,
							model: undefined,
							getAllToolNames: () => [],
						} as unknown as AgentSession;
						return sessionResult(options, session);
					},
					runInteractiveMode: async (...args) => {
						expect(created).toBe(true);
						bridge = args.at(-1) as CollabBridgeBootstrap | undefined;
					},
				});

				expect(manager?.getSessionId()).toBeTruthy();
				expect(bridge).toEqual({
					role: "host",
					managed: true,
					current: {
						address: "127.0.0.1:4321",
						token: `token-${scenario.name}`,
						paneId: "pane-9",
					},
					discovery: { socketPath: `/tmp/herdr-${scenario.name}.sock`, paneId: "pane-9" },
					routeGeneration: 1,
				});
				expect(bridge).not.toHaveProperty("ompSessionId");
				await manager?.close();
				AgentLifecycleManager.resetGlobalForTests();
			}
		} finally {
			authStorage.close();
		}
	}, 20_000);

	it("leaves non-Herdr startup and an explicit diagnostic bridge unchanged", async () => {
		using tempDir = TempDir.createSync("@omp-herdr-nonmanaged-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			"startup.changelogMode": "off",
			"startup.checkUpdate": false,
			"startup.showSplash": false,
		});
		const diagnostic: CollabBridgeBootstrap = {
			role: "host",
			current: {
				address: "127.0.0.1:9999",
				token: "diagnostic-token",
				paneId: "pane-diagnostic",
			},
			discovery: { socketPath: "/tmp/herdr-diagnostic.sock", paneId: "pane-diagnostic" },
			ompSessionId: "caller-supplied-session",
			routeGeneration: 7,
		};

		const run = async (collabBridge?: CollabBridgeBootstrap): Promise<CollabBridgeBootstrap | undefined> => {
			const parsed = parseArgs([]);
			disableStartupFeatures(parsed, tempDir.join(collabBridge ? "diagnostic" : "plain"));
			let manager: SessionManager | undefined;
			let captured: CollabBridgeBootstrap | undefined;
			await runRootCommand(parsed, [], {
				collabBridge,
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					if (!options?.sessionManager) throw new Error("Expected session manager");
					manager = options.sessionManager;
					return sessionResult(options, {
						sessionManager: manager,
						settings,
						model: undefined,
						getAllToolNames: () => [],
					} as unknown as AgentSession);
				},
				runInteractiveMode: async (...args) => {
					captured = args.at(-1) as CollabBridgeBootstrap | undefined;
				},
			});
			await manager?.close();
			AgentLifecycleManager.resetGlobalForTests();
			return captured;
		};

		try {
			expect(await run()).toBeUndefined();
			expect(await run(diagnostic)).toBe(diagnostic);
		} finally {
			authStorage.close();
		}
	}, 20_000);
});
