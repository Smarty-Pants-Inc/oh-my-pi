import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import {
	consumeFreshOmpCompanionSecret,
	resolveFreshOmpCompanionEndpoint,
	runRootCommand,
} from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

const SECRET = Buffer.alloc(32, 0x5a);
const BASE_ENV = {
	FRESH_OMP_COMPANION: "1",
	FRESH_OMP_COMPANION_ENDPOINT:
		process.platform === "win32" ? String.raw`\\.\pipe\fresh-omp-test` : "/tmp/fresh-omp-test.sock",
};

function resolve(
	overrides: {
		isInteractive?: boolean;
		noSession?: boolean;
		freshProvenance?: boolean;
		parentTaskPrefix?: string;
		taskDepth?: number;
		launchEnv?: Readonly<Record<string, string | undefined>>;
		env?: Readonly<Record<string, string | undefined>>;
	} = {},
): string | undefined {
	return resolveFreshOmpCompanionEndpoint({
		isInteractive: overrides.isInteractive ?? true,
		noSession: overrides.noSession ?? false,
		freshProvenance: overrides.freshProvenance ?? true,
		parentTaskPrefix: overrides.parentTaskPrefix,
		taskDepth: overrides.taskDepth,
		launchEnv: Object.hasOwn(overrides, "launchEnv") ? overrides.launchEnv : BASE_ENV,
		env: overrides.env ?? {},
	});
}

async function withSecretChannel<T>(run: (launchEnv: Record<string, string>) => Promise<T>): Promise<T> {
	const endpoint =
		process.platform === "win32"
			? String.raw`\\.\pipe\fresh-omp-${crypto.randomUUID()}`
			: path.join(os.tmpdir(), `fresh-omp-${crypto.randomUUID()}.sock`);
	const server = net.createServer(socket => socket.end(SECRET));
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(endpoint, listening.resolve);
	await listening.promise;
	server.off("error", listening.reject);
	try {
		return await run({ FRESH_OMP_COMPANION: "1", FRESH_OMP_COMPANION_ENDPOINT: endpoint });
	} finally {
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	}
}

describe("Fresh OMP companion host gate", () => {
	it("accepts only a bounded one-shot endpoint in a top-level interactive persistent session", () => {
		expect(resolve()).toBe(BASE_ENV.FRESH_OMP_COMPANION_ENDPOINT);
		expect(resolve({ env: { TMUX: "", STY: "" } })).toBe(BASE_ENV.FRESH_OMP_COMPANION_ENDPOINT);
	});

	it("rejects every excluded mode, ownership, persistence, and terminal-multiplexer state", () => {
		const excluded: Array<[string, Parameters<typeof resolve>[0]]> = [
			["print/rpc/acp/noninteractive", { isInteractive: false }],
			["missing Fresh argv provenance", { freshProvenance: false }],
			["no-session", { noSession: true }],
			["nested prefix", { parentTaskPrefix: "task:" }],
			["present empty nested prefix", { parentTaskPrefix: "" }],
			["nested depth", { taskDepth: 1 }],
			["tmux", { env: { TMUX: "/tmp/tmux-1" } }],
			["screen", { env: { STY: "123.pts" } }],
			["invalid negative depth", { taskDepth: -1 }],
		];

		for (const [label, options] of excluded) {
			expect(resolve(options), label).toBeUndefined();
		}
	});

	it("rejects absent and malformed marker/endpoint combinations", () => {
		const rejectedEnvs: Array<[string, Readonly<Record<string, string | undefined>>]> = [
			["marker absent", { FRESH_OMP_COMPANION_ENDPOINT: BASE_ENV.FRESH_OMP_COMPANION_ENDPOINT }],
			["marker wrong", { ...BASE_ENV, FRESH_OMP_COMPANION: "true" }],
			["endpoint absent", { FRESH_OMP_COMPANION: "1" }],
			["endpoint empty", { ...BASE_ENV, FRESH_OMP_COMPANION_ENDPOINT: "" }],
			["endpoint NUL", { ...BASE_ENV, FRESH_OMP_COMPANION_ENDPOINT: "bad\0endpoint" }],
			["endpoint oversized", { ...BASE_ENV, FRESH_OMP_COMPANION_ENDPOINT: "x".repeat(4097) }],
		];

		for (const [label, launchEnv] of rejectedEnvs) {
			expect(resolve({ launchEnv }), label).toBeUndefined();
		}
	});

	it("does not authorize from process or project dotenv values after launch authority is unavailable", () => {
		expect(resolve({ launchEnv: undefined, env: BASE_ENV })).toBeUndefined();
	});

	it("reads exactly one channel secret and consumes captured and live transport values", async () => {
		await withSecretChannel(async channelEnv => {
			const acceptedLaunch = { ...channelEnv };
			const acceptedEnv = { ...channelEnv, FRESH_OMP_COMPANION_TOKEN: "legacy" };
			expect(
				await consumeFreshOmpCompanionSecret({
					isInteractive: true,
					noSession: false,
					freshProvenance: true,
					launchEnv: acceptedLaunch,
					env: acceptedEnv,
				}),
			).toEqual(SECRET);
			for (const env of [acceptedLaunch, acceptedEnv]) {
				expect(env).not.toHaveProperty("FRESH_OMP_COMPANION");
				expect(env).not.toHaveProperty("FRESH_OMP_COMPANION_ENDPOINT");
				expect(env).not.toHaveProperty("FRESH_OMP_COMPANION_TOKEN");
			}
		});

		const rejectedLaunch = { ...BASE_ENV };
		const rejectedEnv = { ...BASE_ENV };
		expect(
			await consumeFreshOmpCompanionSecret({
				isInteractive: false,
				noSession: false,
				freshProvenance: true,
				launchEnv: rejectedLaunch,
				env: rejectedEnv,
			}),
		).toBeUndefined();
		for (const env of [rejectedLaunch, rejectedEnv]) {
			expect(env).not.toHaveProperty("FRESH_OMP_COMPANION");
			expect(env).not.toHaveProperty("FRESH_OMP_COMPANION_ENDPOINT");
		}
	});

	it("keeps the capability channel private while retaining explicitly linked public extensions", async () => {
		await withSecretChannel(async channelEnv => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fresh-companion-env-"));
			const probeKey = `__freshOmpCompanionEnvProbe${crypto.randomUUID()}`;
			const extensionPath = path.join(root, "public-extension.ts");
			const messagingPath = path.join(root, "plugin", "messaging-style.ts");
			fs.mkdirSync(path.dirname(messagingPath), { recursive: true });
			fs.writeFileSync(
				extensionPath,
				`globalThis[${JSON.stringify(probeKey)}] = { marker: Bun.env.FRESH_OMP_COMPANION ?? null, endpoint: Bun.env.FRESH_OMP_COMPANION_ENDPOINT ?? null, token: Bun.env.FRESH_OMP_COMPANION_TOKEN ?? null }; export default function () {}`,
			);
			fs.writeFileSync(
				messagingPath,
				`export default function (pi) { pi.registerSessionMutationFence(() => { globalThis[${JSON.stringify(probeKey)}].messaging = (globalThis[${JSON.stringify(probeKey)}].messaging ?? 0) + 1; }); }`,
			);

			const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
			const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
			const parsed = parseArgs([]);
			parsed.freshOmpCompanion = true;
			parsed.extensions = [extensionPath, messagingPath];
			parsed.noExtensions = true;
			parsed.noSkills = true;
			parsed.noRules = true;
			parsed.noTools = true;
			parsed.noLsp = true;
			parsed.sessionDir = root;
			const previousMarker = Bun.env.FRESH_OMP_COMPANION;
			const previousEndpoint = Bun.env.FRESH_OMP_COMPANION_ENDPOINT;
			const previousToken = Bun.env.FRESH_OMP_COMPANION_TOKEN;
			let observedOptions: CreateAgentSessionOptions | undefined;
			const stop = new Error("stop after companion bootstrap");

			try {
				Bun.env.FRESH_OMP_COMPANION = channelEnv.FRESH_OMP_COMPANION;
				Bun.env.FRESH_OMP_COMPANION_ENDPOINT = channelEnv.FRESH_OMP_COMPANION_ENDPOINT;
				await expect(
					runRootCommand(parsed, [], {
						discoverAuthStorage: async () => authStorage,
						settings,
						consumeFreshOmpCompanionLaunchEnv: () => ({ ...channelEnv }),
						createAgentSession: async options => {
							observedOptions = options;
							throw stop;
						},
					}),
				).rejects.toBe(stop);

				expect(Reflect.get(globalThis, probeKey)).toEqual({ marker: null, endpoint: null, token: null });
				expect(observedOptions?.hostInternalExtension?.extension.path).toBe("<host:fresh-omp-companion>");
				expect(observedOptions?.hostInternalExtension?.beforeSessionMutation).toBeFunction();
				const hostBinding = observedOptions?.hostInternalExtension;
				if (
					!hostBinding?.beforeSessionMutation ||
					!observedOptions?.preloadedExtensions ||
					!observedOptions.sessionManager
				) {
					throw new Error("Expected Fresh host and linked public extension bindings");
				}
				const messaging = observedOptions.preloadedExtensions.extensions.find(
					extension => extension.path === messagingPath,
				);
				if (!messaging) throw new Error("Expected linked messaging-style extension");
				expect(messaging.sessionMutationFences).toHaveLength(1);
				let freshFences = 0;
				const freshFence = hostBinding.beforeSessionMutation;
				hostBinding.beforeSessionMutation = async (event, ctx) => {
					freshFences++;
					await freshFence(event, ctx);
				};
				const runner = new ExtensionRunner(
					observedOptions.preloadedExtensions.extensions,
					observedOptions.preloadedExtensions.runtime,
					root,
					observedOptions.sessionManager,
					new ModelRegistry(authStorage, path.join(root, "models.yml")),
					undefined,
					undefined,
					undefined,
					undefined,
					hostBinding,
				);
				await runner.emitBeforeSessionMutation({ type: "session_switch" });
				expect(freshFences).toBe(1);
				expect(Reflect.get(globalThis, probeKey)).toMatchObject({ messaging: 1 });
				expect(Bun.env.FRESH_OMP_COMPANION).toBeUndefined();
				expect(Bun.env.FRESH_OMP_COMPANION_ENDPOINT).toBeUndefined();
			} finally {
				Reflect.deleteProperty(globalThis, probeKey);
				if (previousMarker === undefined) delete Bun.env.FRESH_OMP_COMPANION;
				else Bun.env.FRESH_OMP_COMPANION = previousMarker;
				if (previousEndpoint === undefined) delete Bun.env.FRESH_OMP_COMPANION_ENDPOINT;
				else Bun.env.FRESH_OMP_COMPANION_ENDPOINT = previousEndpoint;
				if (previousToken === undefined) delete Bun.env.FRESH_OMP_COMPANION_TOKEN;
				else Bun.env.FRESH_OMP_COMPANION_TOKEN = previousToken;
				authStorage.close();
				await observedOptions?.sessionManager?.close();
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}, 15_000);

	it("defers incarnation entropy until eligible companion construction", async () => {
		const probe = path.resolve(import.meta.dir, "fixtures/fresh-omp-companion-gate-lazy.ts");
		const child = Bun.spawn([process.execPath, probe], { stdout: "pipe", stderr: "pipe" });
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
	}, 15_000);
});
