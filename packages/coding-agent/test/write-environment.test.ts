import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ExecutionEnvironmentBinding } from "@oh-my-pi/pi-coding-agent/session/execution-environment";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

interface SessionOptions {
	environment?: ExecutionEnvironmentBinding;
	getClientBridge?: () => ClientBridge;
	enableLsp?: boolean;
}

function createSession(cwd: string, options: SessionOptions = {}): ToolSession {
	const getArtifactsDir = () => path.join(cwd, "artifacts");
	const getSessionId = () => "session-a";
	return {
		cwd,
		hasUI: false,
		enableLsp: options.enableLsp ?? true,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir,
		getSessionId,
		localProtocolOptions: { getArtifactsDir, getSessionId },
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		getExecutionEnvironment: options.environment ? () => options.environment : undefined,
		getClientBridge: options.getClientBridge,
	};
}

function resultText(result: AgentToolResult): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function environment(
	sourceRoot: string,
	handlers: {
		writeTextFile(params: { path: string; content: string }): Promise<void>;
		readTextFile(params: { path: string; line?: number; limit?: number }): Promise<string>;
	},
): ExecutionEnvironmentBinding {
	return {
		id: "environment-a",
		sourceRoot,
		remoteRoot: "/workspace",
		bridge: {
			writeTextFile: handlers.writeTextFile,
			readTextFile: handlers.readTextFile,
			createTerminal: async () => {
				throw new Error("write must not create a terminal");
			},
		},
	};
}

describe("write tool execution environment routing", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-environment-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("writes and verifies remotely without inspecting or mutating the local workspace", async () => {
		const remoteFiles = new Map<string, string>();
		const writeTextFile = spyOn(
			{
				writeTextFile: async ({ path: remotePath, content }: { path: string; content: string }) => {
					remoteFiles.set(remotePath, content);
				},
			},
			"writeTextFile",
		);
		const readTextFile = spyOn(
			{
				readTextFile: async ({ path: remotePath }: { path: string; line?: number; limit?: number }) => {
					const content = remoteFiles.get(remotePath);
					if (content === undefined) throw new Error("remote file is missing");
					return content;
				},
			},
			"readTextFile",
		);
		const localExists = spyOn(fs, "exists");
		const localFile = spyOn(Bun, "file");
		const localWrite = spyOn(Bun, "write");
		const getClientBridge = spyOn(
			{
				getClientBridge: (): ClientBridge => {
					throw new Error("ACP fallback must not run");
				},
			},
			"getClientBridge",
		);

		try {
			const result = await new WriteTool(
				createSession(tmpDir, {
					environment: environment(tmpDir, { writeTextFile, readTextFile }),
					getClientBridge,
				}),
			).execute("call-environment", { path: "nested/output.txt", content: "remote text\n" });

			expect(writeTextFile).toHaveBeenCalledTimes(1);
			expect(writeTextFile).toHaveBeenCalledWith({ path: "/workspace/nested/output.txt", content: "remote text\n" });
			expect(readTextFile).toHaveBeenCalledTimes(1);
			expect(readTextFile).toHaveBeenCalledWith({ path: "/workspace/nested/output.txt" });
			expect(resultText(result)).toContain("Successfully wrote 12 bytes to /workspace/nested/output.txt");
			expect(localExists).not.toHaveBeenCalled();
			expect(localFile).not.toHaveBeenCalled();
			expect(localWrite).not.toHaveBeenCalled();
			expect(getClientBridge).not.toHaveBeenCalled();
		} finally {
			localExists.mockRestore();
			localFile.mockRestore();
			localWrite.mockRestore();
		}
	});

	it("keeps ordinary writes local when no environment binding exists", async () => {
		const target = path.join(tmpDir, "local.txt");
		await new WriteTool(createSession(tmpDir, { enableLsp: false })).execute("call-local", {
			path: target,
			content: "local text\n",
		});
		expect(await Bun.file(target).text()).toBe("local text\n");
	});

	it("surfaces remote write, verification, and unsupported-target failures without a local fallback", async () => {
		const localExists = spyOn(fs, "exists");
		const localFile = spyOn(Bun, "file");
		const localWrite = spyOn(Bun, "write");
		const rejectedWrite = spyOn(
			{
				writeTextFile: async () => {
					throw new Error("remote symlink target is unsupported");
				},
			},
			"writeTextFile",
		);
		const unreadable = spyOn(
			{
				readTextFile: async () => {
					throw new Error("read must not run after a failed remote write");
				},
			},
			"readTextFile",
		);

		try {
			const tool = new WriteTool(
				createSession(tmpDir, {
					environment: environment(tmpDir, { writeTextFile: rejectedWrite, readTextFile: unreadable }),
				}),
			);
			await expect(tool.execute("call-remote-error", { path: "symlink", content: "text" })).rejects.toThrow(
				"remote symlink target is unsupported",
			);
			expect(rejectedWrite).toHaveBeenCalledTimes(1);
			expect(unreadable).not.toHaveBeenCalled();

			const mismatched = new WriteTool(
				createSession(tmpDir, {
					environment: environment(tmpDir, {
						writeTextFile: async () => undefined,
						readTextFile: async () => "remote formatting changed this",
					}),
				}),
			);
			await expect(mismatched.execute("call-mismatch", { path: "output.txt", content: "expected" })).rejects.toThrow(
				"remote content did not match the requested text",
			);

			await expect(tool.execute("call-mode", { path: "script", content: "#!/bin/sh\necho hi\n" })).rejects.toThrow(
				"executable-mode preservation",
			);
			await expect(tool.execute("call-binary", { path: "binary", content: "\ud800" })).rejects.toThrow(
				"strict UTF-8 text content",
			);
			await expect(tool.execute("call-archive", { path: "bundle.zip:entry.txt", content: "text" })).rejects.toThrow(
				"archive member targets",
			);
			await expect(tool.execute("call-database", { path: "data.db:records", content: "text" })).rejects.toThrow(
				"SQLite table or row targets",
			);
			await expect(tool.execute("call-escape", { path: "../outside.txt", content: "text" })).rejects.toThrow(
				"Path is outside the execution environment workspace",
			);
			expect(rejectedWrite).toHaveBeenCalledTimes(1);
			expect(unreadable).not.toHaveBeenCalled();
			await expect(
				tool.execute("call-uri", { path: "file:///workspace/output.txt", content: "text" }),
			).rejects.toThrow("Unknown URI-like write target");
			await expect(tool.execute("call-conflict", { path: "conflict://1", content: "text" })).rejects.toThrow(
				"not conflict:// targets",
			);
			expect(localExists).not.toHaveBeenCalled();
			expect(localFile).not.toHaveBeenCalled();
			expect(localWrite).not.toHaveBeenCalled();
		} finally {
			localExists.mockRestore();
			localFile.mockRestore();
			localWrite.mockRestore();
		}
	});
});
