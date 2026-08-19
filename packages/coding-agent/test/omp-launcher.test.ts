import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const sourceRunner = path.join(import.meta.dir, "..", "scripts", "omp");
const sourceRunnerDir = path.dirname(sourceRunner);
const launcherPreload = path.join(sourceRunnerDir, "omp.ts");
type BridgeTokenEnvName = "HERDR_OMP_BRIDGE_TOKEN" | "HERDR_OMP_GUEST_BRIDGE_TOKEN";
const trustedLaunchCases = [
	["managed ordinary launch", undefined],
	["HERDR_OMP_BRIDGE_TOKEN", "HERDR_OMP_BRIDGE_TOKEN"],
	["HERDR_OMP_GUEST_BRIDGE_TOKEN", "HERDR_OMP_GUEST_BRIDGE_TOKEN"],
] as const satisfies readonly (readonly [string, BridgeTokenEnvName | undefined])[];

describe("source OMP launcher", () => {
	it.each(trustedLaunchCases)(
		"keeps capabilities and startup hooks out of helpers for %s",
		async (_label, tokenEnvName) => {
			using tempDir = TempDir.createSync("@omp-source-launcher-");
			const root = tempDir.path();
			const bin = path.join(root, "bin");
			const helperLog = path.join(root, "helper.log");
			const pathBunLog = path.join(root, "path-bun.log");
			const startupLog = path.join(root, "startup.log");
			const traceLog = path.join(root, "trace.log");
			const bashEnv = path.join(root, "bash-env");
			const bunLog = path.join(root, "bun.log");
			const callerCwd = path.join(root, "caller");
			const trustedBun = path.join(root, "trusted-bun");
			fs.mkdirSync(bin, { recursive: true });
			fs.mkdirSync(callerCwd);
			for (const helper of ["dirname", "readlink"]) {
				const helperPath = path.join(bin, helper);
				await Bun.write(helperPath, `#!/bin/sh\nprintf reached >> "$OMP_TEST_HELPER_LOG"\nprintf '/attacker\\n'\n`);
				fs.chmodSync(helperPath, 0o755);
			}
			const pathBun = path.join(bin, "bun");
			await Bun.write(pathBun, `#!/bin/sh\nprintf reached > "$OMP_TEST_PATH_BUN_LOG"\n`);
			await Bun.write(
				trustedBun,
				`#!/bin/bash -p
printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "\${HERDR_OMP_BRIDGE_TOKEN-<absent>}" "\${HERDR_OMP_GUEST_BRIDGE_TOKEN-<absent>}" "\${herdr_host_bridge_token-<absent>}" "\${herdr_guest_bridge_token-<absent>}" "\${herdr_bridge_token-<absent>}" "\${BUN_INSPECT_PRELOAD-<absent>}" "\${BUN_OPTIONS-<absent>}" "\${BUN_BE_BUN-<absent>}" "\${NODE_OPTIONS-<absent>}" "$PWD" > "$OMP_TEST_BUN_LOG"
printf 'trusted-bun-stderr-ok\n' >&2
`,
			);
			fs.chmodSync(pathBun, 0o755);
			fs.chmodSync(trustedBun, 0o755);
			await Bun.write(bashEnv, `printf reached > "$OMP_TEST_STARTUP_LOG"\n`);

			const proc = Bun.spawn([sourceRunner, "--version"], {
				cwd: callerCwd,
				env: {
					...process.env,
					BASH_ENV: bashEnv,
					BASH_XTRACEFD: "2",
					BUN_INSPECT_PRELOAD: path.join(root, "ambient-preload.ts"),
					BUN_OPTIONS: "--preload=ambient-preload.ts",
					BUN_BE_BUN: "1",
					NODE_OPTIONS: "--require=ambient-preload.js",
					ENV: bashEnv,
					HERDR_OMP_BRIDGE_TOKEN: undefined,
					HERDR_OMP_GUEST_BRIDGE_TOKEN: undefined,
					OMP_BRIDGE_BUN: trustedBun,
					herdr_bridge_token: "retired-caller-exported",
					herdr_host_bridge_token: "caller-exported",
					herdr_guest_bridge_token: "caller-exported",
					HOME: path.join(root, "home"),
					OMP_TEST_BUN_LOG: bunLog,
					OMP_TEST_HELPER_LOG: helperLog,
					OMP_TEST_PATH_BUN_LOG: pathBunLog,
					OMP_TEST_STARTUP_LOG: startupLog,
					OMP_TEST_TRACE_LOG: traceLog,
					PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
					PS4: '$(printf "%s" "$HERDR_OMP_BRIDGE_TOKEN$HERDR_OMP_GUEST_BRIDGE_TOKEN" > "$OMP_TEST_TRACE_LOG")',
					SHELLOPTS: "xtrace",
					"BASH_FUNC_pwd%%": '() { printf reached > "$OMP_TEST_STARTUP_LOG"; builtin pwd "$@"; }',
					...(tokenEnvName ? { [tokenEnvName]: "bridge-secret" } : {}),
				},
				stdout: "ignore",
				stderr: "pipe",
			});
			const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
			const expectedHostToken = tokenEnvName === "HERDR_OMP_BRIDGE_TOKEN" ? "bridge-secret" : "<absent>";
			const expectedGuestToken = tokenEnvName === "HERDR_OMP_GUEST_BRIDGE_TOKEN" ? "bridge-secret" : "<absent>";

			expect(exitCode, stderr).toBe(0);
			expect(fs.existsSync(helperLog)).toBe(false);
			expect(fs.existsSync(pathBunLog)).toBe(false);
			expect(fs.existsSync(startupLog)).toBe(false);
			expect(fs.existsSync(traceLog)).toBe(false);
			expect(stderr).toContain("trusted-bun-stderr-ok");
			expect(stderr).not.toContain("bridge-secret");
			expect(fs.readFileSync(bunLog, "utf8")).toBe(
				`${expectedHostToken}|${expectedGuestToken}|<absent>|<absent>|<absent>|<absent>|<absent>|<absent>|<absent>|${sourceRunnerDir}\n`,
			);
		},
	);

	it("removes inherited Bash startup hooks before CLI code runs", async () => {
		using tempDir = TempDir.createSync("@omp-source-preload-env-");
		const root = tempDir.path();
		const proc = Bun.spawn(
			[
				process.execPath,
				"--no-env-file",
				"--preload",
				launcherPreload,
				"-e",
				`const unsafe = Object.keys(process.env).filter(name => name.startsWith("BASH_FUNC_") || ["SHELLOPTS", "PS4", "BASH_XTRACEFD", "BASH_ENV", "ENV", "BUN_BE_BUN", "NODE_OPTIONS"].includes(name)); process.stdout.write(JSON.stringify(unsafe));`,
			],
			{
				cwd: root,
				env: {
					...process.env,
					BASH_ENV: path.join(root, "bash-env"),
					BASH_XTRACEFD: "2",
					BUN_BE_BUN: "1",
					NODE_OPTIONS: "--require=ambient-preload.js",
					ENV: path.join(root, "env"),
					OMP_LAUNCH_CWD: root,
					PS4: "hostile",
					SHELLOPTS: "xtrace",
					"BASH_FUNC_pwd%%": "() { printf reached; }",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual([]);
	});

	it("moves a legacy positional guest token before helpers or Bun start", async () => {
		using tempDir = TempDir.createSync("@omp-source-launcher-legacy-guest-");
		const root = tempDir.path();
		const bin = path.join(root, "bin");
		const callerCwd = path.join(root, "caller");
		const helperLog = path.join(root, "helper.log");
		const bunLog = path.join(root, "bun.log");
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(callerCwd);
		for (const helper of ["dirname", "readlink", "mkdir"]) {
			const helperPath = path.join(bin, helper);
			await Bun.write(helperPath, `#!/bin/sh\nprintf reached >> "$OMP_TEST_HELPER_LOG"\n`);
			fs.chmodSync(helperPath, 0o755);
		}
		const fakeBun = path.join(bin, "bun");
		await Bun.write(
			fakeBun,
			`#!/bin/sh
printf '%s|%s|%s|%s|%s\n' "\${HERDR_OMP_GUEST_BRIDGE_TOKEN-<absent>}" "\${BUN_OPTIONS-<absent>}" "\${NODE_OPTIONS-<absent>}" "$PWD" "$*" > "$OMP_TEST_BUN_LOG"
`,
		);
		fs.chmodSync(fakeBun, 0o755);

		const proc = Bun.spawn(
			[sourceRunner, "__collab-guest-bridge", "127.0.0.1:1234", "room", "legacy-secret", "--no-tools"],
			{
				cwd: callerCwd,
				env: {
					...process.env,
					BUN_OPTIONS: "--preload=ambient.ts",
					HERDR_OMP_BRIDGE_TOKEN: undefined,
					HERDR_OMP_GUEST_BRIDGE_TOKEN: undefined,
					NODE_OPTIONS: "--require=ambient-preload.js",
					OMP_BRIDGE_BUN: fakeBun,
					HOME: path.join(root, "home"),
					OMP_TEST_BUN_LOG: bunLog,
					OMP_TEST_HELPER_LOG: helperLog,
					PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
				},
				stdout: "ignore",
				stderr: "pipe",
			},
		);
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		const log = fs.readFileSync(bunLog, "utf8");

		expect(exitCode, stderr).toBe(0);
		expect(fs.existsSync(helperLog)).toBe(false);
		expect(log).toContain(`legacy-secret|<absent>|<absent>|${sourceRunnerDir}|`);
		expect(log).toContain("__collab-guest-bridge 127.0.0.1:1234 room --token-env --no-tools");
		expect(log).not.toContain("room legacy-secret");
	});

	it("rejects a bridge launch when Bun is available only through PATH", async () => {
		using tempDir = TempDir.createSync("@omp-source-launcher-unpaired-bun-");
		const root = tempDir.path();
		const bin = path.join(root, "bin");
		const callerCwd = path.join(root, "caller");
		const bunLog = path.join(root, "bun.log");
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(callerCwd);
		const fakeBun = path.join(bin, "bun");
		await Bun.write(fakeBun, `#!/bin/sh\nprintf reached > "$OMP_TEST_BUN_LOG"\n`);
		fs.chmodSync(fakeBun, 0o755);

		const proc = Bun.spawn([sourceRunner, "--version"], {
			cwd: callerCwd,
			env: {
				...process.env,
				HERDR_OMP_GUEST_BRIDGE_TOKEN: "bridge-secret",
				HOME: path.join(root, "home"),
				OMP_TEST_BUN_LOG: bunLog,
				PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

		expect(exitCode).toBe(1);
		expect(stderr).toContain("managed bridge launch did not provide an absolute trusted Bun executable");
		expect(fs.existsSync(bunLog)).toBe(false);
	});

	it("keeps the caller-selected dev launch cwd without a bridge capability", async () => {
		using tempDir = TempDir.createSync("@omp-source-launcher-ordinary-");
		const root = tempDir.path();
		const bin = path.join(root, "bin");
		const callerCwd = path.join(root, "caller");
		const bunLog = path.join(root, "bun.log");
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(callerCwd);
		const fakeBun = path.join(bin, "bun");
		await Bun.write(
			fakeBun,
			`#!/bin/sh
printf '%s|%s|%s|%s\n' "\${HERDR_OMP_BRIDGE_TOKEN-<absent>}" "\${HERDR_OMP_GUEST_BRIDGE_TOKEN-<absent>}" "\${NODE_OPTIONS-<absent>}" "$PWD" > "$OMP_TEST_BUN_LOG"
`,
		);
		fs.chmodSync(fakeBun, 0o755);

		const proc = Bun.spawn([sourceRunner, "--version"], {
			cwd: callerCwd,
			env: {
				...process.env,
				HERDR_OMP_BRIDGE_TOKEN: undefined,
				HERDR_OMP_GUEST_BRIDGE_TOKEN: undefined,
				NODE_OPTIONS: "--require=ambient-preload.js",
				HOME: path.join(root, "home"),
				OMP_DEV_LAUNCH_DIR: callerCwd,
				OMP_TEST_BUN_LOG: bunLog,
				PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

		expect(exitCode, stderr).toBe(0);
		expect(fs.readFileSync(bunLog, "utf8")).toBe(`<absent>|<absent>|<absent>|${callerCwd}\n`);
	});
});
