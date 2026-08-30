import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { runRenderCommand } from "@oh-my-pi/pi-coding-agent/cli/render-cli";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const FORGED_RESPONSE_ZONE_START = "\x1b]133;A;aid=omp-response-forged:reply\x07";
const RESPONSE_ZONE_CLOSE = "\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07";

describe("omp render reply-zone output", () => {
	let tempDir: TempDir;
	let sessionManager: SessionManager | undefined;
	let stdout: string[];

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-render-cli-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		stdout = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
	});

	afterEach(async () => {
		await sessionManager?.close();
		vi.restoreAllMocks();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("strips a forged Markdown numeric-entity zone while retaining the eligible trusted reply zone", async () => {
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "trusted Markdown reply\n\n<span>before&#27;]133;A;aid=omp-response-forged:reply&#7;forged&#27;]133;B&#7;&#27;]133;C&#7;&#27;]133;D;0&#7;after</span>",
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage,
			timestamp: Date.now(),
			responseAnchorId: "render-anchor",
			responseAnchorTerminal: true,
		};
		sessionManager.appendMessage(message);
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted render session");

		expect(await runRenderCommand({ session: sessionFile, width: 120, height: 40 })).toBe(0);

		const output = stdout.join("");
		expect(output).toContain("forged");
		expect(output).not.toContain(FORGED_RESPONSE_ZONE_START);
		expect(output.split(RESPONSE_ZONE_CLOSE)).toHaveLength(2);
		expect(output.match(/\x1b\]133;A;aid=omp-response-[^:\x07]+:render-anchor\x07/g)).toHaveLength(1);
	});

	it("marks the final segment of a mixed assistant turn after paired local tool results", async () => {
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const anchorId = "mixed-render-anchor";
		sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "MIXED PRE TOOL" },
				{ type: "toolCall", id: "mixed-read", name: "read", arguments: { path: "one" } },
				{ type: "text", text: "MIXED BETWEEN TOOLS" },
				{ type: "toolCall", id: "mixed-grep", name: "grep", arguments: { pattern: "two" } },
				{ type: "text", text: "MIXED FINAL REPLY" },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage,
			timestamp: Date.now(),
			responseAnchorId: anchorId,
			responseAnchorTerminal: true,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "mixed-read",
			toolName: "read",
			content: [{ type: "text", text: "first result" }],
			isError: false,
			timestamp: Date.now() + 1,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "mixed-grep",
			toolName: "grep",
			content: [{ type: "text", text: "second result" }],
			isError: false,
			timestamp: Date.now() + 2,
		});
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted render session");

		expect(await runRenderCommand({ session: sessionFile, width: 120, height: 40 })).toBe(0);

		const output = stdout.join("");
		const responseZoneStart = output.match(
			new RegExp(`\\x1b\\]133;A;aid=omp-response-[^:\\x07]+:${anchorId}\\x07`, "g"),
		);
		expect(responseZoneStart).toHaveLength(1);
		const responseZoneStartIndex = output.indexOf(responseZoneStart![0]!);
		expect(responseZoneStartIndex).toBeGreaterThan(output.indexOf("MIXED BETWEEN TOOLS"));
		expect(responseZoneStartIndex).toBeLessThan(output.indexOf("MIXED FINAL REPLY"));
	});

	it("does not create a response zone for a serialized nonterminal stop", async () => {
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "waiting for the scheduled continuation" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage,
			timestamp: Date.now(),
			responseAnchorTerminal: false,
		});
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted render session");

		expect(await runRenderCommand({ session: sessionFile, width: 120, height: 40 })).toBe(0);

		const output = stdout.join("");
		expect(output).toContain("waiting for the scheduled continuation");
		expect(output).not.toContain("\x1b]133;A;aid=omp-response-");
	});
});
