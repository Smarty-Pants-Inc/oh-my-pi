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
		parentTaskPrefix?: string;
		taskDepth?: number;
		env?: Readonly<Record<string, string | undefined>>;
	} = {},
): Uint8Array | undefined {
	return resolveFreshOmpCompanionSecret({
		isInteractive: overrides.isInteractive ?? true,
		noSession: overrides.noSession ?? false,
		parentTaskPrefix: overrides.parentTaskPrefix,
		taskDepth: overrides.taskDepth,
		env: overrides.env ?? BASE_ENV,
	});
}

describe("Fresh OMP companion host gate", () => {
	it("accepts only the canonical 32-byte capability in a top-level interactive persistent session", () => {
		expect(TOKEN).toHaveLength(43);
		expect(resolve()).toEqual(Buffer.alloc(32, 0x5a));
		expect(resolve({ env: { ...BASE_ENV, TMUX: "", STY: "" } })).toEqual(Buffer.alloc(32, 0x5a));
	});

	it("rejects every excluded mode, ownership, persistence, and terminal-multiplexer state", () => {
		const excluded: Array<[string, Parameters<typeof resolve>[0]]> = [
			["print/rpc/acp/noninteractive", { isInteractive: false }],
			["no-session", { noSession: true }],
			["nested prefix", { parentTaskPrefix: "task:" }],
			["present empty nested prefix", { parentTaskPrefix: "" }],
			["nested depth", { taskDepth: 1 }],
			["tmux", { env: { ...BASE_ENV, TMUX: "/tmp/tmux-1" } }],
			["screen", { env: { ...BASE_ENV, STY: "123.pts" } }],
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

		for (const [label, env] of rejectedEnvs) {
			expect(resolve({ env }), label).toBeUndefined();
		}
	});

	it("consumes both transport values after resolving the internal secret, including rejected gates", () => {
		const accepted = { ...BASE_ENV };
		expect(
			consumeFreshOmpCompanionSecret({
				isInteractive: true,
				noSession: false,
				env: accepted,
			}),
		).toEqual(Buffer.alloc(32, 0x5a));
		expect(accepted).not.toHaveProperty("FRESH_OMP_COMPANION");
		expect(accepted).not.toHaveProperty("FRESH_OMP_COMPANION_TOKEN");

		const rejected = { ...BASE_ENV };
		expect(
			consumeFreshOmpCompanionSecret({
				isInteractive: false,
				noSession: false,
				env: rejected,
			}),
		).toBeUndefined();
		expect(rejected).not.toHaveProperty("FRESH_OMP_COMPANION");
		expect(rejected).not.toHaveProperty("FRESH_OMP_COMPANION_TOKEN");
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
					createAgentSession: async options => {
						observedOptions = options;
						throw stop;
					},
				}),
			).rejects.toBe(stop);

			expect(Reflect.get(globalThis, probeKey)).toEqual({ marker: null, token: null });
			expect(observedOptions?.hostInternalExtensions).toHaveLength(1);
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
