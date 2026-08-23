import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetActiveRulesForTests, setActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

describe("ReadTool internal resource metadata", () => {
	afterEach(() => {
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
		resetActiveRulesForTests();
		resetRegisteredArtifactDirsForTests();
	});

	it("carries file targets and transformed line alignment into read details", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-resource-metadata-"));
		try {
			const artifactsDir = path.join(tempDir, "artifacts");
			const agentPath = path.join(artifactsDir, "Worker.md");
			const historyPath = path.join(tempDir, "History.jsonl");
			const rulePath = path.join(tempDir, "policy.instructions.md");
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(agentPath, JSON.stringify({ result: { ok: true } }));
			await Bun.write(historyPath, '{"raw":"session record"}\n');
			await Bun.write(rulePath, "---\ndescription: policy\n---\nrule body\n");

			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile: path.join(tempDir, "Main.jsonl"),
			});
			AgentRegistry.global().register({
				id: "History",
				displayName: "history",
				kind: "sub",
				session: {
					messages: [{ role: "user", content: "history body", timestamp: 1 }],
				} as unknown as AgentSession,
				sessionFile: historyPath,
				status: "idle",
			});
			setActiveRules([
				{
					name: "policy",
					path: rulePath,
					content: "rule body\n",
					_source: { provider: "test", providerName: "test", path: rulePath, level: "project" },
				},
			]);

			const session: ToolSession = {
				cwd: tempDir,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
			};
			const tool = new ReadTool(session);
			const agent = await tool.execute("read-agent-extraction", { path: "agent://Worker/result" });
			const history = await tool.execute("read-history", { path: "history://History:1" });
			const rule = await tool.execute("read-rule", { path: "rule://policy:1" });
			const index = await tool.execute("read-history-index", { path: "history://" });

			for (const [result, sourcePath] of [
				[agent, agentPath],
				[history, historyPath],
				[rule, rulePath],
			] as const) {
				expect(result.details).toMatchObject({
					resolvedPath: sourcePath,
					isDirectory: false,
					sourceLineAligned: false,
				});
			}
			expect(index.details?.resolvedPath).toBeUndefined();
			expect(index.details?.isDirectory).toBeUndefined();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
