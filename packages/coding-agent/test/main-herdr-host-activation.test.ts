import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import * as collabGuestModule from "@oh-my-pi/pi-coding-agent/collab/guest";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type CollabBridgeBootstrap,
	reconcilePrivateHerdrAfterStartupJoin,
	runInteractiveStartupSequence,
	runRootCommand,
} from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import * as setupWizardModule from "@oh-my-pi/pi-coding-agent/modes/setup-wizard";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

function interactiveSession(sessionManager: SessionManager, activeSettings: Settings): AgentSession {
	return {
		sessionManager,
		settings: activeSettings,
		agent: { state: { tools: [] }, metadataForProvider: () => undefined },
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: { model: undefined },
		model: undefined,
		thinkingLevel: undefined,
		getAllToolNames: () => [],
	} as unknown as AgentSession;
}

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	setInteractiveHost(false);
	resetSettingsForTest();
});

describe("automatic Herdr host activation", () => {
	it("starts a fresh private guest without setup, splash, or welcome", async () => {
		using tempDir = TempDir.createSync("@omp-private-guest-startup-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("setupVersion", 0);
		Settings.instance.set("startup.setupWizard", true);
		Settings.instance.set("startup.showSplash", true);
		Settings.instance.set("startup.checkUpdate", false);
		Settings.instance.set("startup.changelogMode", "hidden");
		Settings.instance.set("marketplace.autoUpdate", "off");

		const parsed = parseArgs([]);
		disableStartupFeatures(parsed, tempDir.join("sessions"));
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const session = interactiveSession(sessionManager, Settings.instance);
		const stopped = new Error("startup reached input loop");
		let mode: InteractiveMode | undefined;
		let initOptions: Parameters<InteractiveMode["init"]>[0];
		const setupEntered = new Error("private guest entered setup startup");
		const selectSetupScenes = vi.spyOn(setupWizardModule, "selectSetupScenes").mockRejectedValue(setupEntered);
		const runSetupWizard = vi.spyOn(setupWizardModule, "runSetupWizard").mockRejectedValue(setupEntered);
		const runStartupSplash = vi.spyOn(setupWizardModule, "runStartupSplash").mockRejectedValue(setupEntered);
		const join = vi
			.spyOn(collabGuestModule.CollabGuestLink.prototype, "joinWithTransport")
			.mockImplementation(async () => {
				await mode?.renderInitialMessages({ clearTerminalHistory: true });
			});
		vi.spyOn(InteractiveMode.prototype, "init").mockImplementation(async function (this: InteractiveMode, options) {
			mode = this;
			initOptions = options;
		});
		const renderInitialMessages = vi.spyOn(InteractiveMode.prototype, "renderInitialMessages").mockResolvedValue();
		vi.spyOn(InteractiveMode.prototype, "getUserInput").mockRejectedValue(stopped);

		try {
			await expect(
				runRootCommand(parsed, [], {
					collabBridge: {
						role: "guest",
						address: "127.0.0.1:4321",
						roomId: "room-1",
						token: "guest-token",
					},
					forceSetupWizard: true,
					settings: Settings.instance,
					discoverAuthStorage: async () => authStorage,
					createAgentSession: async options => {
						if (!options) throw new Error("Expected session options");
						return sessionResult(options, session);
					},
				}),
			).rejects.toBe(stopped);

			expect(selectSetupScenes).not.toHaveBeenCalled();
			expect(runSetupWizard).not.toHaveBeenCalled();
			expect(runStartupSplash).not.toHaveBeenCalled();
			expect(initOptions).toEqual({
				suppressWelcomeIntro: true,
				clearInitialTerminalHistory: true,
			});
			expect(join).toHaveBeenCalledTimes(1);
			expect(renderInitialMessages).toHaveBeenCalledTimes(1);
			expect(renderInitialMessages).toHaveBeenCalledWith({
				clearTerminalHistory: true,
			});
		} finally {
			mode?.stop();
			await sessionManager.close();
			authStorage.close();
		}
	});

	it("suppresses local model and update notices for an authoritative guest replica", async () => {
		using tempDir = TempDir.createSync("@omp-private-guest-notices-");
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			"startup.changelogMode": "off",
			"startup.checkUpdate": true,
			"startup.showSplash": false,
		});
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const parsed = parseArgs([]);
		disableStartupFeatures(parsed, tempDir.join("sessions"));
		let manager: SessionManager | undefined;
		let notifications: Array<{ kind: string; message: string }> = [];
		let versionCheck: Promise<unknown> | undefined;

		try {
			await runRootCommand(parsed, [], {
				collabBridge: {
					role: "guest",
					address: "127.0.0.1:4321",
					roomId: "room-1",
					token: "guest-token",
				},
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					if (!options?.sessionManager) throw new Error("Expected session manager");
					manager = options.sessionManager;
					return {
						...sessionResult(options, interactiveSession(manager, settings)),
						modelFallbackMessage:
							"No models available. Use /login or set an API key environment variable. Then use /model to select a model.",
					};
				},
				runInteractiveMode: async (...args) => {
					notifications = args[3] as typeof notifications;
					versionCheck = args[4] as Promise<unknown>;
				},
			});

			expect(notifications).toEqual([]);
			expect(await versionCheck).toBeUndefined();
		} finally {
			await manager?.close();
			authStorage.close();
		}
	});

	it("still enters forced setup for an ordinary launch", async () => {
		using tempDir = TempDir.createSync("@omp-ordinary-setup-startup-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("setupVersion", 0);
		Settings.instance.set("startup.setupWizard", true);
		Settings.instance.set("startup.showSplash", false);
		Settings.instance.set("startup.checkUpdate", false);
		Settings.instance.set("startup.changelogMode", "hidden");
		Settings.instance.set("marketplace.autoUpdate", "off");

		const parsed = parseArgs([]);
		disableStartupFeatures(parsed, tempDir.join("sessions"));
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const session = interactiveSession(sessionManager, Settings.instance);
		const setupEntered = new Error("ordinary launch entered setup startup");
		let mode: InteractiveMode | undefined;
		const selectSetupScenes = vi
			.spyOn(setupWizardModule, "selectSetupScenes")
			.mockImplementation(async (_storedVersion, _scenes, ctx) => {
				mode = ctx as InteractiveMode;
				throw setupEntered;
			});

		try {
			await expect(
				runRootCommand(parsed, [], {
					forceSetupWizard: true,
					settings: Settings.instance,
					discoverAuthStorage: async () => authStorage,
					createAgentSession: async options => {
						if (!options) throw new Error("Expected session options");
						return sessionResult(options, session);
					},
				}),
			).rejects.toBe(setupEntered);
			expect(selectSetupScenes).toHaveBeenCalledTimes(1);
		} finally {
			mode?.stop();
			await sessionManager.close();
			authStorage.close();
		}
	});

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

	it("cleans up once and rethrows when initial managed activation fails", async () => {
		const failure = new Error("managed bridge activation failed");
		let cleanupCalls = 0;

		await expect(
			runInteractiveStartupSequence(
				undefined,
				undefined,
				async () => {
					throw failure;
				},
				async () => {
					cleanupCalls += 1;
				},
			),
		).rejects.toBe(failure);
		expect(cleanupCalls).toBe(1);
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

		await reconcilePrivateHerdrAfterStartupJoin({
			collabGuest: {},
			herdrCollabHostLifecycle: lifecycle,
			shutdown,
		});
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
					discovery: {
						socketPath: `/tmp/herdr-${scenario.name}.sock`,
						paneId: "pane-9",
					},
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
					discovery: {
						socketPath: `/tmp/herdr-${scenario.name}.sock`,
						paneId: "pane-9",
					},
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
			discovery: {
				socketPath: "/tmp/herdr-diagnostic.sock",
				paneId: "pane-diagnostic",
			},
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
