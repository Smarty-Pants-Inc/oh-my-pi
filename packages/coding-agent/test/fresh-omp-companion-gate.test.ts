import { describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	consumeFreshOmpCompanionSecret,
	resolveFreshOmpCompanionSecret,
	runRootCommand,
} from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

const TOKEN = Buffer.alloc(32, 0x5a).toString("base64url");
const BASE_ENV = {
	FRESH_OMP_COMPANION: "1",
	FRESH_OMP_COMPANION_TOKEN: TOKEN,
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
): Uint8Array | undefined {
	return resolveFreshOmpCompanionSecret({
		isInteractive: overrides.isInteractive ?? true,
		noSession: overrides.noSession ?? false,
		freshProvenance: overrides.freshProvenance ?? true,
		parentTaskPrefix: overrides.parentTaskPrefix,
		taskDepth: overrides.taskDepth,
		launchEnv: Object.hasOwn(overrides, "launchEnv") ? overrides.launchEnv : BASE_ENV,
		env: overrides.env ?? {},
	});
}

describe("Fresh OMP companion host gate", () => {
	it("accepts only the canonical 32-byte capability in a top-level interactive persistent session", () => {
		expect(TOKEN).toHaveLength(43);
		expect(resolve()).toEqual(Buffer.alloc(32, 0x5a));
		expect(resolve({ env: { TMUX: "", STY: "" } })).toEqual(Buffer.alloc(32, 0x5a));
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

	it("rejects absent, malformed, and non-canonical marker/token combinations", () => {
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		const lastIndex = alphabet.indexOf(TOKEN.at(-1) ?? "");
		if (lastIndex < 0 || lastIndex % 4 !== 0) throw new Error("Expected a canonical base64url tail");
		const nonCanonical = `${TOKEN.slice(0, -1)}${alphabet[lastIndex + 1]}`;

		const rejectedEnvs: Array<[string, Readonly<Record<string, string | undefined>>]> = [
			["marker absent", { FRESH_OMP_COMPANION_TOKEN: TOKEN }],
			["marker wrong", { ...BASE_ENV, FRESH_OMP_COMPANION: "true" }],
			["token absent", { FRESH_OMP_COMPANION: "1" }],
			["token short", { ...BASE_ENV, FRESH_OMP_COMPANION_TOKEN: TOKEN.slice(1) }],
			["token long", { ...BASE_ENV, FRESH_OMP_COMPANION_TOKEN: `${TOKEN}A` }],
			["token alphabet", { ...BASE_ENV, FRESH_OMP_COMPANION_TOKEN: `%${TOKEN.slice(1)}` }],
			["token non-canonical", { ...BASE_ENV, FRESH_OMP_COMPANION_TOKEN: nonCanonical }],
		];

		for (const [label, launchEnv] of rejectedEnvs) {
			expect(resolve({ launchEnv }), label).toBeUndefined();
		}
	});

	it("does not authorize from process or project dotenv values after launch authority is unavailable", () => {
		expect(resolve({ launchEnv: undefined, env: BASE_ENV })).toBeUndefined();
	});

	it("consumes captured and live transport values after accepted and rejected gates", () => {
		const acceptedLaunch = { ...BASE_ENV };
		const acceptedEnv = { ...BASE_ENV };
		expect(
			consumeFreshOmpCompanionSecret({
				isInteractive: true,
				noSession: false,
				freshProvenance: true,
				launchEnv: acceptedLaunch,
				env: acceptedEnv,
			}),
		).toEqual(Buffer.alloc(32, 0x5a));
		for (const env of [acceptedLaunch, acceptedEnv]) {
			expect(env).not.toHaveProperty("FRESH_OMP_COMPANION");
			expect(env).not.toHaveProperty("FRESH_OMP_COMPANION_TOKEN");
		}

		const rejectedLaunch = { ...BASE_ENV };
		const rejectedEnv = { ...BASE_ENV };
		expect(
			consumeFreshOmpCompanionSecret({
				isInteractive: false,
				noSession: false,
				freshProvenance: true,
				launchEnv: rejectedLaunch,
				env: rejectedEnv,
			}),
		).toBeUndefined();
		for (const env of [rejectedLaunch, rejectedEnv]) {
			expect(env).not.toHaveProperty("FRESH_OMP_COMPANION");
			expect(env).not.toHaveProperty("FRESH_OMP_COMPANION_TOKEN");
		}
	});

	it("keeps the decoded capability private before public extensions load", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fresh-companion-env-"));
		const probeKey = `__freshOmpCompanionEnvProbe${crypto.randomUUID()}`;
		const extensionPath = path.join(root, "public-extension.ts");
		fs.writeFileSync(
			extensionPath,
			`globalThis[${JSON.stringify(probeKey)}] = { marker: Bun.env.FRESH_OMP_COMPANION ?? null, token: Bun.env.FRESH_OMP_COMPANION_TOKEN ?? null };\nexport default function () {}\n`,
		);

		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const parsed = parseArgs([]);
		parsed.freshOmpCompanion = true;
		parsed.extensions = [extensionPath];
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = root;
		const previousMarker = Bun.env.FRESH_OMP_COMPANION;
		const previousToken = Bun.env.FRESH_OMP_COMPANION_TOKEN;
		let observedOptions: CreateAgentSessionOptions | undefined;
		const stop = new Error("stop after companion bootstrap");

		try {
			Bun.env.FRESH_OMP_COMPANION = BASE_ENV.FRESH_OMP_COMPANION;
			Bun.env.FRESH_OMP_COMPANION_TOKEN = BASE_ENV.FRESH_OMP_COMPANION_TOKEN;
			await expect(
				runRootCommand(parsed, [], {
					discoverAuthStorage: async () => authStorage,
					settings,
					consumeFreshOmpCompanionLaunchEnv: () => ({ ...BASE_ENV }),
					createAgentSession: async options => {
						observedOptions = options;
						throw stop;
					},
				}),
			).rejects.toBe(stop);

			expect(Reflect.get(globalThis, probeKey)).toEqual({ marker: null, token: null });
			expect(observedOptions?.hostInternalExtension).toBeDefined();
			expect(Bun.env.FRESH_OMP_COMPANION).toBeUndefined();
			expect(Bun.env.FRESH_OMP_COMPANION_TOKEN).toBeUndefined();
		} finally {
			Reflect.deleteProperty(globalThis, probeKey);
			if (previousMarker === undefined) delete Bun.env.FRESH_OMP_COMPANION;
			else Bun.env.FRESH_OMP_COMPANION = previousMarker;
			if (previousToken === undefined) delete Bun.env.FRESH_OMP_COMPANION_TOKEN;
			else Bun.env.FRESH_OMP_COMPANION_TOKEN = previousToken;
			authStorage.close();
			await observedOptions?.sessionManager?.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("defers incarnation entropy until eligible companion construction", async () => {
		const probe = path.resolve(import.meta.dir, "fixtures/fresh-omp-companion-gate-lazy.ts");
		const child = Bun.spawn([process.execPath, probe], { stdout: "pipe", stderr: "pipe" });
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
	}, 15_000);
});
