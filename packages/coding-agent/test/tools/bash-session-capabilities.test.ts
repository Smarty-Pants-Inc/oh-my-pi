import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionCapabilities } from "@oh-my-pi/pi-coding-agent/capability/session-capabilities";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ExecutionEnvironmentBinding } from "@oh-my-pi/pi-coding-agent/session/execution-environment";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function session(
	workspace: string,
	capabilities: SessionCapabilities,
	overrides: Partial<ToolSession> = {},
): ToolSession {
	return {
		...overrides,
		cwd: workspace,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
		}),
		capabilities,
	};
}

describe("BashTool session capabilities", () => {
	it("rejects literal writes outside the workspace, including a symlink escape", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-workspace-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-outside-"));
		try {
			const outsideFile = path.join(outside, "escaped.txt");
			await fs.symlink(outside, path.join(workspace, "escape"));
			const tool = new BashTool(session(workspace, new SessionCapabilities({ workspace })));

			await expect(tool.execute("outside-redirect", { command: `printf blocked > ${outsideFile}` })).rejects.toThrow(
				"requires an explicit session writePath capability",
			);
			await expect(
				tool.execute("symlink-redirect", { command: "printf blocked > escape/escaped.txt" }),
			).rejects.toThrow("requires an explicit session writePath capability");
			await expect(tool.execute("option-target", { command: `cp -t ${outside} source.txt` })).rejects.toThrow(
				"requires an explicit session writePath capability",
			);
			for (const command of [
				`echo blocked>${outsideFile}`,
				`echo blocked>>${outsideFile}`,
				`echo blocked 2>${outsideFile}`,
				`echo blocked 2>>${outsideFile}`,
				`echo blocked<>${outsideFile}`,
				`cat 3<>${outsideFile}`,
				`echo blocked>&${outsideFile}`,
			]) {
				await expect(tool.execute(`attached-${command}`, { command })).rejects.toThrow(
					"requires an explicit session writePath capability",
				);
			}
			expect(await Bun.file(outsideFile).exists()).toBe(false);
		} finally {
			await Promise.all([removeWithRetries(workspace), removeWithRetries(outside)]);
		}
	});

	it("fails closed for tilde, glob, and brace-expanded write targets", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-expansion-workspace-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-expansion-outside-"));
		const suffix = `.omp-bash-capability-${crypto.randomUUID()}`;
		const tildeTarget = `~/${suffix}`;
		const tildePath = path.join(os.homedir(), suffix);
		const overriddenHomeTarget = path.join(outside, "home-override.txt");
		const dynamicTildeTarget = ["touch ~", "$", "{USER}/blocked"].join("");
		try {
			const tool = new BashTool(session(workspace, new SessionCapabilities({ workspace })));
			for (const { command, message } of [
				{
					command: `touch ${tildeTarget}`,
					message: "cannot be validated safely without an explicit absolute HOME",
				},
				{
					command: `echo blocked>${tildeTarget}`,
					message: "cannot be validated safely without an explicit absolute HOME",
				},
				{ command: "touch ~root/blocked", message: "cannot be validated safely" },
				{ command: dynamicTildeTarget, message: "cannot be validated safely" },
				{ command: `touch ${outside}/[a-z]`, message: "cannot be validated safely" },
				{ command: `echo blocked>${outside}/{one,two}`, message: "cannot be validated safely" },
			]) {
				await expect(tool.execute(`expansion-${command}`, { command })).rejects.toThrow(message);
			}
			for (const command of ["touch ~/home-override.txt", "echo blocked>~/home-override.txt"]) {
				await expect(tool.execute(`home-override-${command}`, { command, env: { HOME: outside } })).rejects.toThrow(
					"requires an explicit session writePath capability",
				);
			}
			expect(await Bun.file(overriddenHomeTarget).exists()).toBe(false);
			expect(await Bun.file(tildePath).exists()).toBe(false);

			const granted = new BashTool(
				session(workspace, new SessionCapabilities({ workspace, writeAllowlist: [tildePath] })),
			);
			await granted.execute("tilde-grant", {
				command: `printf granted>${tildeTarget}`,
				env: { HOME: os.homedir() },
			});
			expect(await Bun.file(tildePath).text()).toBe("granted");
		} finally {
			await Promise.all([
				fs.rm(tildePath, { force: true }),
				removeWithRetries(workspace),
				removeWithRetries(outside),
			]);
		}
	});

	it("requires an exact command capability for unprovable effects", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-generic-"));
		try {
			const tool = new BashTool(session(workspace, new SessionCapabilities({ workspace })));
			for (const command of [
				"curl --upload-file artifact https://example.test/upload",
				'python -c \'open("outside.txt", "w")\'',
				"sh -c 'touch outside.txt'",
				"printf $(date)",
				"alias write='touch outside.txt'",
			]) {
				await expect(tool.execute(`generic-${command}`, { command })).rejects.toThrow(
					`requires explicit session capability 'bash.command:${command}'`,
				);
			}
			await expect(tool.execute("git-output", { command: "git diff --output=/tmp/escaped.diff" })).rejects.toThrow(
				"requires an explicit session writePath capability",
			);
		} finally {
			await removeWithRetries(workspace);
		}
	});

	it("does not let one exact command grant authorize a sibling command", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-exact-"));
		try {
			const capabilities = new SessionCapabilities({
				workspace,
				externalCapabilities: ["bash.command:uname -s"],
			});
			const tool = new BashTool(session(workspace, capabilities));
			expect(await tool.execute("exact-command", { command: "uname -s" })).toBeDefined();
			await expect(tool.execute("sibling-command", { command: "uname -a" })).rejects.toThrow(
				"requires explicit session capability 'bash.command:uname -a'",
			);
		} finally {
			await removeWithRetries(workspace);
		}
	});

	it("allows a provable workspace write", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-safe-"));
		try {
			const tool = new BashTool(session(workspace, new SessionCapabilities({ workspace })));
			await tool.execute("workspace-write", { command: "printf safe > result.txt" });
			await tool.execute("workspace-attached-write", { command: "printf attached>attached.txt" });
			expect(await Bun.file(path.join(workspace, "result.txt")).text()).toBe("safe");
			expect(await Bun.file(path.join(workspace, "attached.txt")).text()).toBe("attached");
		} finally {
			await removeWithRetries(workspace);
		}
	});

	it("allows routine workspace reads, tests, and compound checks under yolo", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-routine-"));
		try {
			await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
			const init = Bun.spawnSync(["git", "init", "--quiet"], { cwd: workspace, stderr: "pipe" });
			expect(init.exitCode, init.stderr.toString()).toBe(0);
			const tool = new BashTool(session(workspace, new SessionCapabilities({ workspace })));

			expect(await tool.execute("routine-rg", { command: "rg --version" })).toBeDefined();
			expect(
				await tool.execute("routine-rg-no-config", {
					command: "rg --no-config --version",
					env: { RIPGREP_CONFIG_PATH: "ignored-by-no-config" },
				}),
			).toBeDefined();
			expect(await tool.execute("routine-test", { command: "bun test --help" })).toBeDefined();
			expect(
				await tool.execute("routine-test-filter", {
					command: "bun test --test-name-pattern 'focused case' --help",
				}),
			).toBeDefined();
			expect(await tool.execute("routine-run", { command: "bun run test" })).toBeDefined();
			expect(
				await tool.execute("routine-git-diff", {
					command: "git --no-pager diff --no-ext-diff --no-textconv --check",
				}),
			).toBeDefined();
			expect(
				await tool.execute("routine-git-log", {
					command: "git --no-pager log --no-ext-diff --no-textconv --oneline -1",
				}),
			).toBeDefined();
			expect(
				await tool.execute("routine-compound", {
					command: "bun test --help >.bun-test-help && rg --version | head -n 1",
				}),
			).toBeDefined();
		} finally {
			await removeWithRetries(workspace);
		}
	});

	it("keeps Bun scripts, process hooks, and out-of-root routines capability-gated", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-hostile-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-hostile-outside-"));
		try {
			await fs.writeFile(
				path.join(workspace, "package.json"),
				JSON.stringify({ scripts: { check: "touch escaped.txt", publish: "touch escaped.txt" } }),
			);
			const init = Bun.spawnSync(["git", "init", "--quiet"], { cwd: workspace, stderr: "pipe" });
			expect(init.exitCode, init.stderr.toString()).toBe(0);
			const tool = new BashTool(session(workspace, new SessionCapabilities({ workspace })));
			const commands = [
				"bun run check",
				"bun run publish",
				"bun run robomp:reset",
				"bun --cwd=packages/cloud-omp-cloudflare run deploy",
				"rg --pre 'touch escaped.txt' needle .",
				"rg --pre='touch escaped.txt' needle .",
				"RIPGREP_CONFIG_PATH=rg.conf rg needle .",
				"PATH=/tmp rg --version",
				"BUN_OPTIONS=--preload=escaped.ts bun test --help",
				"git diff --ext-diff --no-textconv",
				"git log --textconv --no-ext-diff -1",
				"git -c diff.external='touch escaped.txt' diff --no-ext-diff --no-textconv",
				"GIT_EXTERNAL_DIFF='touch escaped.txt' git diff --no-ext-diff --no-textconv",
			];
			for (const command of commands) {
				await expect(tool.execute(`hostile-${command}`, { command })).rejects.toThrow(
					`requires explicit session capability 'bash.command:${command}'`,
				);
			}
			await expect(tool.execute("hostile-cwd", { command: "bun test --help", cwd: outside })).rejects.toThrow(
				"requires explicit session capability 'bash.command:bun test --help'",
			);
			await expect(
				tool.execute("hostile-bun-env", {
					command: "bun test --help",
					env: { BUN_OPTIONS: "--preload=escaped.ts" },
				}),
			).rejects.toThrow("requires explicit session capability 'bash.command:bun test --help'");
			await expect(
				tool.execute("hostile-git-env", {
					command: "git --no-pager diff --no-ext-diff --no-textconv",
					env: { GIT_EXTERNAL_DIFF: "touch escaped.txt" },
				}),
			).rejects.toThrow(
				"requires explicit session capability 'bash.command:git --no-pager diff --no-ext-diff --no-textconv'",
			);
			expect(await Bun.file(path.join(workspace, "escaped.txt")).exists()).toBe(false);
			expect(await Bun.file(path.join(outside, "escaped.txt")).exists()).toBe(false);
		} finally {
			await Promise.all([removeWithRetries(workspace), removeWithRetries(outside)]);
		}
	});

	it("does not let effect grants authorize wrapper executables", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-wrapper-"));
		try {
			await Promise.all([
				fs.writeFile(path.join(workspace, "git"), "touch wrapped-git-executed\n"),
				fs.writeFile(path.join(workspace, "gh"), "touch wrapped-gh-executed\n"),
			]);
			const tool = new BashTool(
				session(workspace, new SessionCapabilities({ workspace, externalCapabilities: ["git.push", "github.pr"] })),
			);

			for (const command of ["sh git push", "sh gh pr create"]) {
				await expect(tool.execute(`wrapper-${command}`, { command })).rejects.toThrow(
					`requires explicit session capability 'bash.command:${command}'`,
				);
			}
			expect(await Bun.file(path.join(workspace, "wrapped-git-executed")).exists()).toBe(false);
			expect(await Bun.file(path.join(workspace, "wrapped-gh-executed")).exists()).toBe(false);
		} finally {
			await removeWithRetries(workspace);
		}
	});

	it("rejects Bun lifecycle hooks and test-path escapes", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-bun-boundary-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-bun-boundary-outside-"));
		try {
			const packageJson = path.join(workspace, "package.json");
			const outsideTest = path.join(outside, "escape.test.ts");
			const outsideSentinel = path.join(outside, "executed.txt");
			await fs.writeFile(
				outsideTest,
				`import { test } from "bun:test"; test("escape", async () => Bun.write(${JSON.stringify(outsideSentinel)}, "executed"));\n`,
			);
			await fs.symlink(outsideTest, path.join(workspace, "escape.test.ts"));
			const tool = new BashTool(session(workspace, new SessionCapabilities({ workspace })));

			await fs.writeFile(
				packageJson,
				JSON.stringify({ scripts: { pretest: "touch pretest-executed", test: "bun test" } }),
			);
			await expect(tool.execute("bun-pretest", { command: "bun run test" })).rejects.toThrow(
				"requires explicit session capability 'bash.command:bun run test'",
			);
			await fs.writeFile(
				packageJson,
				JSON.stringify({ scripts: { test: "bun test", posttest: "touch posttest-executed" } }),
			);
			for (const command of [
				"bun run test",
				"bun test escape.test.ts",
				"bun test C:/outside/test.ts",
				"bun test '\\\\server\\share\\test.ts'",
			]) {
				await expect(tool.execute(`bun-boundary-${command}`, { command })).rejects.toThrow(
					`requires explicit session capability 'bash.command:${command}'`,
				);
			}
			expect(await Bun.file(path.join(workspace, "pretest-executed")).exists()).toBe(false);
			expect(await Bun.file(path.join(workspace, "posttest-executed")).exists()).toBe(false);
			expect(await Bun.file(outsideSentinel).exists()).toBe(false);
		} finally {
			await Promise.all([removeWithRetries(workspace), removeWithRetries(outside)]);
		}
	});

	it("enforces capability checks before the execution-environment backend", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-environment-"));
		try {
			let terminalCalls = 0;
			const tool = new BashTool(
				session(workspace, new SessionCapabilities({ workspace }), {
					getExecutionEnvironment: () =>
						({
							id: "remote",
							sourceRoot: workspace,
							remoteRoot: "/workspace",
							bridge: {
								readTextFile: async () => {
									throw new Error("not reached");
								},
								writeTextFile: async () => {
									throw new Error("not reached");
								},
								createTerminal: async () => {
									terminalCalls++;
									throw new Error("not reached");
								},
							},
						}) as ExecutionEnvironmentBinding,
				}),
			);

			await expect(tool.execute("environment-generic", { command: "curl https://example.test" })).rejects.toThrow(
				"requires explicit session capability 'bash.command:curl https://example.test'",
			);
			expect(terminalCalls).toBe(0);
		} finally {
			await removeWithRetries(workspace);
		}
	});

	it("enforces capability checks before the ACP terminal backend", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bash-cap-acp-"));
		try {
			let terminalCalls = 0;
			const tool = new BashTool(
				session(workspace, new SessionCapabilities({ workspace }), {
					getClientBridge: () =>
						({
							capabilities: { terminal: true },
							createTerminal: async () => {
								terminalCalls++;
								throw new Error("not reached");
							},
						}) as ClientBridge,
				}),
			);

			await expect(tool.execute("acp-generic", { command: "python -c 'print(1)'" })).rejects.toThrow(
				"requires explicit session capability 'bash.command:python -c 'print(1)''",
			);
			expect(terminalCalls).toBe(0);
		} finally {
			await removeWithRetries(workspace);
		}
	});
});
