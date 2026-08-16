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
