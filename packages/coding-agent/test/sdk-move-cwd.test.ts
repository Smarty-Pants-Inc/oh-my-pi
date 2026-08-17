import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

describe("createAgentSession cwd after /move", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("runs tools from the moved session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions"));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
				"edit.mode": "replace",
				"tools.xdev": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["bash", "write", "edit", "ast_edit"],
		});

		try {
			await sessionManager.moveTo(cwdB);
			fs.writeFileSync(path.join(cwdB, "edit.txt"), "before\n");
			fs.writeFileSync(path.join(cwdB, "ast.ts"), "legacyWrap(x, value)\n");
			fs.writeFileSync(path.join(cwdA, "stale-edit.txt"), "before\n");
			fs.writeFileSync(path.join(cwdA, "stale-ast.ts"), "legacyWrap(x, value)\n");

			const bashTool = session.getToolByName("bash");
			const writeTool = session.getToolByName("write");
			const editTool = session.getToolByName("edit");
			const astEditTool = session.getToolByName("ast_edit");
			if (!bashTool || !writeTool || !editTool || !astEditTool) throw new Error("Expected moved-session tools");
			const result = await bashTool.execute("pwd-after-move", { command: "pwd" });
			await bashTool.execute("write-after-move", { command: "printf moved > result.txt" });
			await writeTool.execute("structured-write-after-move", { path: "written.txt", content: "live" });
			await editTool.execute("edit-after-move", {
				path: "edit.txt",
				old_string: "before",
				new_string: "after",
			});
			await astEditTool.execute("ast-edit-after-move", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: ["ast.ts"],
			});
			const applyAstEdit = session.peekPendingInvoker();
			if (!applyAstEdit) throw new Error("Expected pending AST edit");
			await applyAstEdit({ action: "apply", reason: "apply moved-root regression edit" });

			expect(textContent(result)).toContain(cwdB);
			expect(fs.readFileSync(path.join(cwdB, "result.txt"), "utf8")).toBe("moved");
			expect(fs.readFileSync(path.join(cwdB, "written.txt"), "utf8")).toBe("live");
			expect(fs.readFileSync(path.join(cwdB, "edit.txt"), "utf8")).toBe("after\n");
			expect(fs.readFileSync(path.join(cwdB, "ast.ts"), "utf8")).toContain("modernWrap(x, value)");
			await expect(
				bashTool.execute("write-before-move-root", { command: "printf stale > stale.txt", cwd: cwdA }),
			).rejects.toThrow("requires an explicit session writePath capability");
			await expect(
				writeTool.execute("structured-write-before-move-root", {
					path: path.join(cwdA, "stale-write.txt"),
					content: "stale",
				}),
			).rejects.toThrow("requires an explicit session writePath capability");
			await expect(
				editTool.execute("edit-before-move-root", {
					path: path.join(cwdA, "stale-edit.txt"),
					old_string: "before",
					new_string: "stale",
				}),
			).rejects.toThrow("requires an explicit session writePath capability");
			await expect(
				astEditTool.execute("ast-edit-before-move-root", {
					ops: [{ pat: "legacyWrap($A, $B)", out: "staleWrap($A, $B)" }],
					paths: [path.join(cwdA, "stale-ast.ts")],
				}),
			).rejects.toThrow("requires an explicit session writePath capability");
			expect(fs.existsSync(path.join(cwdA, "stale.txt"))).toBe(false);
			expect(fs.existsSync(path.join(cwdA, "stale-write.txt"))).toBe(false);
			expect(fs.readFileSync(path.join(cwdA, "stale-edit.txt"), "utf8")).toBe("before\n");
			expect(fs.readFileSync(path.join(cwdA, "stale-ast.ts"), "utf8")).toBe("legacyWrap(x, value)\n");
		} finally {
			try {
				await session.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
});
