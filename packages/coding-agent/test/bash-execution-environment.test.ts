import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type {
	ClientBridge,
	ClientBridgeCreateTerminalParams,
	ClientBridgeTerminalHandle,
} from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ExecutionEnvironmentBinding } from "@oh-my-pi/pi-coding-agent/session/execution-environment";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolInput } from "@oh-my-pi/pi-coding-agent/tools/bash";

const SOURCE_ROOT = "/tmp/cloud-omp-source";
const REMOTE_ROOT = "/workspace";

function makeHandle(overrides: Partial<ClientBridgeTerminalHandle> = {}): ClientBridgeTerminalHandle {
	return {
		terminalId: "environment-terminal",
		waitForExit: async () => ({ exitCode: 0, signal: null }),
		currentOutput: async () => ({ output: "environment output\n", truncated: false }),
		kill: async () => {},
		release: async () => {},
		...overrides,
	};
}

function makeBinding(
	createTerminal: (params: ClientBridgeCreateTerminalParams) => Promise<ClientBridgeTerminalHandle>,
): ExecutionEnvironmentBinding {
	return {
		id: "environment-1",
		sourceRoot: SOURCE_ROOT,
		remoteRoot: REMOTE_ROOT,
		bridge: {
			readTextFile: async () => {
				throw new Error("bash must not read files through the environment bridge");
			},
			writeTextFile: async () => {
				throw new Error("bash must not write files through the environment bridge");
			},
			createTerminal,
		},
	};
}

function makeSession(options: {
	environment?: ExecutionEnvironmentBinding;
	clientBridge?: ClientBridge;
	asyncEnabled?: boolean;
	interceptorRules?: Array<{ pattern: string; tool: string; message: string }>;
	throwOnLocalAccess?: boolean;
}): ToolSession {
	const session = {
		cwd: options.environment?.sourceRoot ?? "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return options.asyncEnabled ?? false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return Boolean(options.interceptorRules);
				if (key === "bash.direnv") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "grep.enabled") return false;
				if (key === "glob.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return options.interceptorRules ?? [];
			},
			getShellConfig() {
				return { shell: "/bin/bash", args: ["-l", "-c"], env: {}, prefix: undefined };
			},
		},
		getExecutionEnvironment: () => options.environment,
		getClientBridge: options.throwOnLocalAccess
			? () => {
					throw new Error("local ACP bridge lookup reached");
				}
			: () => options.clientBridge,
	} as unknown as ToolSession;
	if (options.throwOnLocalAccess) {
		Object.defineProperty(session, "asyncJobManager", {
			get() {
				throw new Error("local job manager reached");
			},
		});
	}
	return session;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("BashTool execution environment routing", () => {
	it("uses only the environment terminal and preserves the raw command", async () => {
		const createCalls: ClientBridgeCreateTerminalParams[] = [];
		const binding = makeBinding(async params => {
			createCalls.push(params);
			return makeHandle();
		});
		const statSpy = vi.spyOn(fs.promises, "stat").mockRejectedValue(new Error("local cwd stat reached"));
		const executeSpy = vi
			.spyOn(bashExecutor, "executeBash")
			.mockRejectedValue(new Error("local process execution reached"));
		const tool = new BashTool(makeSession({ environment: binding, throwOnLocalAccess: true }));

		const command = "cd nested && printf 'remote only\\n'";
		const result = await tool.execute("environment-call", { command, timeout: 30, env: {} });

		expect(result.content.find(block => block.type === "text")?.text).toContain("environment output");
		expect(createCalls).toEqual([
			{
				command: "/bin/bash",
				args: ["--noprofile", "--norc", "-c", command],
				cwd: REMOTE_ROOT,
				env: undefined,
				timeoutMs: 30_000,
				outputByteLimit: DEFAULT_MAX_BYTES,
			},
		]);
		expect(result.details?.terminalId).toBeUndefined();
		expect(statSpy).not.toHaveBeenCalled();
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it.each([
		[undefined, REMOTE_ROOT],
		["nested", `${REMOTE_ROOT}/nested`],
		[`${SOURCE_ROOT}/nested`, `${REMOTE_ROOT}/nested`],
		[`${REMOTE_ROOT}/nested`, `${REMOTE_ROOT}/nested`],
	] as const)("maps environment cwd %s to %s", async (cwd, expectedCwd) => {
		let createParams: ClientBridgeCreateTerminalParams | undefined;
		const binding = makeBinding(async params => {
			createParams = params;
			return makeHandle();
		});
		const tool = new BashTool(makeSession({ environment: binding }));

		await tool.execute("cwd-call", { command: "pwd", cwd, timeout: 30 });

		expect(createParams?.cwd).toBe(expectedCwd);
	});

	it.each([
		[{ command: "true", timeout: 30, async: true }, "only foreground execution"],
		[{ command: "true", timeout: 30, pty: true }, "does not support PTY"],
		[{ command: "true", timeout: 0 }, "timeout between 1 and 120"],
		[{ command: "true", timeout: 121 }, "timeout between 1 and 120"],
		[{ command: "true" }, "timeout between 1 and 120"],
		[{ command: "cat skill://demo", timeout: 30 }, "internal protocol references in command"],
		[{ command: "pwd", cwd: "local://scratch", timeout: 30 }, "internal protocol references in cwd"],
		[{ command: `cat ${SOURCE_ROOT}/file`, timeout: 30 }, "local sourceRoot in command"],
		[{ command: "pwd", cwd: "../escape", timeout: 30 }, "outside the execution environment workspace"],
		[{ command: "pwd", cwd: "/etc", timeout: 30 }, "outside the execution environment workspace"],
		[{ command: "true", env: { TOKEN: "value" }, timeout: 30 }, "does not accept model-supplied"],
		[{ command: "true", env: { TOKEN: "artifact://1" }, timeout: 30 }, "internal protocol references in env"],
		[{ command: "true", env: { TOKEN: SOURCE_ROOT }, timeout: 30 }, "local sourceRoot in env"],
	] as Array<[BashToolInput, string]>)("rejects unsupported environment input %#", async (input, message) => {
		const createTerminal = vi.fn(async () => makeHandle());
		const binding = makeBinding(createTerminal);
		const tool = new BashTool(makeSession({ environment: binding, asyncEnabled: true }));

		await expect(tool.execute("invalid-call", input)).rejects.toThrow(message);
		expect(createTerminal).not.toHaveBeenCalled();
	});

	it("runs the existing interceptor before creating an environment terminal", async () => {
		const createTerminal = vi.fn(async () => makeHandle());
		const binding = makeBinding(createTerminal);
		const tool = new BashTool(
			makeSession({
				environment: binding,
				interceptorRules: [{ pattern: "^\\s*cat\\s+", tool: "read", message: "Use read instead." }],
			}),
		);

		await expect(
			tool.execute("blocked-call", { command: "cat file", timeout: 30 }, undefined, undefined, {
				toolNames: ["read"],
			} as AgentToolContext),
		).rejects.toThrow("Use read instead");
		expect(createTerminal).not.toHaveBeenCalled();
	});

	it("does not fall back when environment terminal creation fails", async () => {
		const binding = makeBinding(async () => {
			throw new Error("create exploded");
		});
		const statSpy = vi.spyOn(fs.promises, "stat").mockRejectedValue(new Error("local cwd stat reached"));
		const executeSpy = vi
			.spyOn(bashExecutor, "executeBash")
			.mockRejectedValue(new Error("local process execution reached"));
		const tool = new BashTool(makeSession({ environment: binding, throwOnLocalAccess: true }));

		await expect(tool.execute("create-failure", { command: "true", timeout: 30 })).rejects.toThrow(
			"Execution environment terminal create failed: create exploded",
		);
		expect(statSpy).not.toHaveBeenCalled();
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("treats output polling failure as terminal and still releases", async () => {
		const events: string[] = [];
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const handle = makeHandle({
			waitForExit: () => pendingExit.promise,
			currentOutput: async () => {
				events.push("output");
				throw new Error("poll exploded");
			},
			release: async () => {
				events.push("release");
			},
		});
		const tool = new BashTool(makeSession({ environment: makeBinding(async () => handle) }));

		await expect(tool.execute("poll-failure", { command: "sleep 1", timeout: 1 })).rejects.toThrow(
			"Execution environment terminal output polling failed: poll exploded",
		);
		expect(events).toEqual(["output", "release"]);
	});

	it("treats final output failure as terminal and still releases", async () => {
		const events: string[] = [];
		const handle = makeHandle({
			currentOutput: async () => {
				events.push("output");
				throw new Error("output exploded");
			},
			release: async () => {
				events.push("release");
			},
		});
		const tool = new BashTool(makeSession({ environment: makeBinding(async () => handle) }));

		await expect(tool.execute("output-failure", { command: "true", timeout: 30 })).rejects.toThrow(
			"Execution environment terminal output failed: output exploded",
		);
		expect(events).toEqual(["output", "release"]);
	});

	it("treats wait failure as terminal and still releases", async () => {
		const events: string[] = [];
		const handle = makeHandle({
			waitForExit: async () => {
				throw new Error("wait exploded");
			},
			release: async () => {
				events.push("release");
			},
		});
		const tool = new BashTool(makeSession({ environment: makeBinding(async () => handle) }));

		await expect(tool.execute("wait-failure", { command: "true", timeout: 30 })).rejects.toThrow(
			"Execution environment terminal wait for exit failed: wait exploded",
		);
		expect(events).toEqual(["release"]);
	});

	it("kills before the final output read and releases last on cancellation", async () => {
		const events: string[] = [];
		const controller = new AbortController();
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const handle = makeHandle({
			waitForExit: () => {
				events.push("wait");
				controller.abort();
				return pendingExit.promise;
			},
			kill: async () => {
				events.push("kill");
			},
			currentOutput: async () => {
				events.push("output");
				return { output: "partial", truncated: false };
			},
			release: async () => {
				events.push("release");
			},
		});
		const tool = new BashTool(makeSession({ environment: makeBinding(async () => handle) }));

		await expect(
			tool.execute("cancelled-call", { command: "sleep 60", timeout: 30 }, controller.signal),
		).rejects.toThrow("Command aborted");
		expect(events).toEqual(["wait", "kill", "output", "release"]);
	});

	it("kills before the final output read and releases last on timeout", async () => {
		const events: string[] = [];
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const handle = makeHandle({
			waitForExit: () => pendingExit.promise,
			kill: async () => {
				events.push("kill");
			},
			currentOutput: async () => {
				events.push("output");
				return { output: "timeout output", truncated: false };
			},
			release: async () => {
				events.push("release");
			},
		});
		const tool = new BashTool(makeSession({ environment: makeBinding(async () => handle) }));

		await expect(tool.execute("timeout-call", { command: "sleep 60", timeout: 1 })).rejects.toThrow(
			"Command timed out after 1 seconds",
		);
		expect(events.slice(-3)).toEqual(["kill", "output", "release"]);
	});

	it("makes kill failure terminal without reading output", async () => {
		const events: string[] = [];
		const controller = new AbortController();
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const handle = makeHandle({
			waitForExit: () => {
				controller.abort();
				return pendingExit.promise;
			},
			kill: async () => {
				events.push("kill");
				throw new Error("kill exploded");
			},
			currentOutput: async () => {
				events.push("output");
				return { output: "must not be read", truncated: false };
			},
			release: async () => {
				events.push("release");
			},
		});
		const tool = new BashTool(makeSession({ environment: makeBinding(async () => handle) }));

		await expect(
			tool.execute("kill-failure", { command: "sleep 60", timeout: 30 }, controller.signal),
		).rejects.toThrow("Execution environment terminal kill failed: kill exploded");
		expect(events).toEqual(["kill", "release"]);
	});

	it("invalidates successful execution when terminal release fails", async () => {
		const events: string[] = [];
		const handle = makeHandle({
			currentOutput: async () => {
				events.push("output");
				return { output: "success", truncated: false };
			},
			release: async () => {
				events.push("release");
				throw new Error("release exploded");
			},
		});
		const tool = new BashTool(makeSession({ environment: makeBinding(async () => handle) }));

		await expect(tool.execute("release-failure", { command: "true", timeout: 30 })).rejects.toThrow(
			"Execution environment terminal release failed: release exploded",
		);
		expect(events).toEqual(["output", "release"]);
	});

	it("keeps local process execution unchanged when no environment or ACP bridge is bound", async () => {
		const executeSpy = vi.spyOn(bashExecutor, "executeBash").mockResolvedValue({
			output: "local output\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 13,
			outputLines: 1,
			outputBytes: 13,
		});
		const tool = new BashTool(makeSession({}));

		const result = await tool.execute("local-call", { command: "echo local", timeout: 30 });

		expect(executeSpy).toHaveBeenCalledTimes(1);
		expect(executeSpy.mock.calls[0]?.[0]).toBe("echo local");
		expect(executeSpy.mock.calls[0]?.[1]?.cwd).toBe("/tmp");
		expect(result.content.find(block => block.type === "text")?.text).toContain("local output");
	});

	it("keeps ACP routing unchanged when no execution environment is bound", async () => {
		let createParams: ClientBridgeCreateTerminalParams | undefined;
		const handle = makeHandle({ terminalId: "acp-terminal" });
		const clientBridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async params => {
				createParams = params;
				return handle;
			},
		};
		const tool = new BashTool(makeSession({ clientBridge }));

		const result = await tool.execute("acp-call", { command: "echo local", timeout: 30 });

		expect(createParams?.command).toBe("/bin/bash");
		expect(createParams?.args).toEqual(["-l", "-c", "echo local"]);
		expect(createParams?.timeoutMs).toBeUndefined();
		expect(result.details?.terminalId).toBeUndefined();
	});
});
