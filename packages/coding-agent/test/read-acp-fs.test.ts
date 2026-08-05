import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ExecutionEnvironmentBinding } from "@oh-my-pi/pi-coding-agent/session/execution-environment";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const BRIDGE_CONTENT = "// content from editor buffer\nexport function greet() { return 'bridge'; }\n";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(
	cwd: string,
	bridge?: ClientBridge,
	executionEnvironment?: ExecutionEnvironmentBinding,
): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		getClientBridge: bridge ? () => bridge : undefined,
		getExecutionEnvironment: executionEnvironment ? () => executionEnvironment : undefined,
	};
}

function createEnvironment(
	readTextFile: ExecutionEnvironmentBinding["bridge"]["readTextFile"],
): ExecutionEnvironmentBinding {
	return {
		id: "test-environment",
		sourceRoot: "/local/worktree",
		remoteRoot: "/workspace",
		bridge: {
			readTextFile,
			writeTextFile: async () => {},
			createTerminal: async () => {
				throw new Error("terminal must not be created by read");
			},
		},
	};
}

describe("read tool ACP fs routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-acp-fs-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("routes plain text reads through the bridge and does not call Bun.file().text()", async () => {
		// .ts file so summarize would normally run (read.summarize.enabled defaults to true)
		const filePath = path.join(tmpDir, "example.ts");
		await fs.writeFile(filePath, "export function greet() { return 'disk'; }\n");

		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async () => BRIDGE_CONTENT,
		};
		const bridgeSpy = spyOn(bridge, "readTextFile");

		// Wrap Bun.file() to detect any .text() calls
		let textCallCount = 0;
		const origBunFile = Bun.file.bind(Bun);
		const bunFileSpy = spyOn(Bun, "file").mockImplementation(
			(arg: string | URL | Uint8Array | ArrayBufferLike | number, opts?: BlobPropertyBag) => {
				const bunFile = origBunFile(arg as string, opts);
				const origText = bunFile.text.bind(bunFile);
				bunFile.text = async () => {
					textCallCount++;
					return origText();
				};
				return bunFile;
			},
		);

		try {
			const session = createSession(tmpDir, bridge);
			const tool = new ReadTool(session);

			const result = await tool.execute("call-1", { path: filePath });
			const text = textOutput(result);

			// Bridge content should appear in output
			expect(text).toContain("content from editor buffer");
			// Bridge readTextFile was invoked
			expect(bridgeSpy).toHaveBeenCalled();
			// Bun.file().text() must not have been called — bridge is source of truth
			expect(textCallCount).toBe(0);
		} finally {
			bunFileSpy.mockRestore();
		}
	});

	it("applies requested line ranges to bridge content exactly once", async () => {
		const filePath = path.join(tmpDir, "range.txt");
		await fs.writeFile(filePath, "disk one\ndisk two\ndisk three\n");
		const bridgeContent = "bridge one\nbridge two\nbridge three\n";
		const bridge: ClientBridge = {
			capabilities: { readTextFile: true },
			readTextFile: async params => {
				if (typeof params.line !== "number") return bridgeContent;
				const lines = bridgeContent.split("\n");
				const start = Math.max(0, params.line - 1);
				return lines.slice(start, params.limit === undefined ? undefined : start + params.limit).join("\n");
			},
		};

		const session = createSession(tmpDir, bridge);
		const tool = new ReadTool(session);

		const result = await tool.execute("call-range", { path: `${filePath}:2+1` });
		const text = textOutput(result);

		expect(text).toContain("bridge two");
		expect(text).not.toContain("Line 2 is beyond end");
		expect(text).not.toContain("disk two");
	});
});

describe("read tool execution environment routing", () => {
	it("reads and formats remote code through exactly one bridge call without local file access", async () => {
		const bridge = createEnvironment(async () =>
			[
				"export function alpha(): string {",
				"\tconst value = 'remote';",
				"\treturn value;",
				"}",
				"",
				"export function beta(): number {",
				"\tconst value = 2;",
				"\treturn value;",
				"}",
			].join("\n"),
		);
		const bridgeSpy = spyOn(bridge.bridge, "readTextFile");
		const localFileSpy = spyOn(Bun, "file").mockImplementation((() => {
			throw new Error("environment read must not access local files");
		}) as typeof Bun.file);
		try {
			const result = await new ReadTool(createSession("/local/worktree", undefined, bridge)).execute(
				"environment-read",
				{
					path: "src/remote.ts",
				},
			);

			expect(bridgeSpy).toHaveBeenCalledTimes(1);
			expect(bridgeSpy).toHaveBeenCalledWith({ path: "/workspace/src/remote.ts" });
			expect(textOutput(result)).toContain("export function alpha");
			expect(result.details?.resolvedPath).toBe("/workspace/src/remote.ts");
		} finally {
			localFileSpy.mockRestore();
		}
	});

	it("surfaces environment bridge failures without probing or falling back to the local workspace", async () => {
		const bridge = createEnvironment(async () => {
			throw new Error("remote file rejected");
		});
		const bridgeSpy = spyOn(bridge.bridge, "readTextFile");
		const localFileSpy = spyOn(Bun, "file").mockImplementation((() => {
			throw new Error("environment read must not access local files");
		}) as typeof Bun.file);
		try {
			const tool = new ReadTool(createSession("/local/worktree", undefined, bridge));
			await expect(tool.execute("environment-error", { path: "src/remote.ts" })).rejects.toThrow(
				"remote file rejected",
			);
			expect(bridgeSpy).toHaveBeenCalledTimes(1);
		} finally {
			localFileSpy.mockRestore();
		}
	});

	it("rejects unsupported and escaping environment targets before bridge or local filesystem access", async () => {
		const bridge = createEnvironment(async () => "must not be read");
		const bridgeSpy = spyOn(bridge.bridge, "readTextFile");
		const localFileSpy = spyOn(Bun, "file").mockImplementation((() => {
			throw new Error("environment read must not access local files");
		}) as typeof Bun.file);
		try {
			const tool = new ReadTool(createSession("/local/worktree", undefined, bridge));
			await expect(tool.execute("environment-archive", { path: "archive.zip:member.txt" })).rejects.toThrow(
				"Archive paths",
			);
			await expect(tool.execute("environment-escape", { path: "../outside.ts" })).rejects.toThrow(
				"outside the workspace",
			);
			expect(bridgeSpy).not.toHaveBeenCalled();
		} finally {
			localFileSpy.mockRestore();
		}
	});

	it("keeps ACP's existing local fallback when no environment is active", async () => {
		const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-acp-fallback-"));
		try {
			const localFile = path.join(localDir, "acp-fallback.txt");
			await fs.writeFile(localFile, "local fallback content\n");
			const bridge: ClientBridge = {
				capabilities: { readTextFile: true },
				readTextFile: async () => {
					throw new Error("editor buffer unavailable");
				},
			};

			const result = await new ReadTool(createSession(localDir, bridge)).execute("acp-fallback", {
				path: localFile,
			});
			expect(textOutput(result)).toContain("local fallback content");
		} finally {
			await removeWithRetries(localDir);
		}
	});
});
