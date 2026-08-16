import { describe, expect, it } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { ExecutionEnvironmentBinding } from "@oh-my-pi/pi-coding-agent/session/execution-environment";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function createBinding(sourceRoot: string): ExecutionEnvironmentBinding {
	return {
		id: "test-environment",
		sourceRoot,
		remoteRoot: "/workspace",
		bridge: {
			readTextFile: async () => "unused",
			writeTextFile: async () => {},
			createTerminal: async () => {
				throw new Error("unused");
			},
		},
	};
}

async function createPromptSession(
	cwd: string,
	authStorage: AuthStorage,
	overrides: Parameters<typeof createAgentSession>[0] = {},
) {
	const model = getBundledModel("openai", "gpt-4o-mini");
	return await createAgentSession({
		cwd,
		agentDir: `${cwd}/.agent`,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage),
		model,
		settings: Settings.isolated({ includeWorkspaceTree: true }),
		sessionManager: SessionManager.inMemory(cwd),
		disableExtensionDiscovery: true,
		executionEnvironment: createBinding(cwd),
		skills: [],
		rules: [],
		promptTemplates: [],
		slashCommands: [],
		toolNames: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		agentRegistry: new AgentRegistry(),
		...overrides,
	});
}

describe("execution environment session prompts", () => {
	it("discovers context at the local cwd but exposes only remote operational paths", async () => {
		using tempDir = TempDir.createSync("@omp-environment-prompt-");
		const sourceRoot = tempDir.path();
		const contextPath = tempDir.join("AGENTS.md");
		await Bun.write(contextPath, "locally-discovered-environment-context");
		const authStorage = await AuthStorage.create(":memory:");

		try {
			const { session } = await createPromptSession(sourceRoot, authStorage, {
				workspaceTree: {
					rootPath: sourceRoot,
					rendered: ".\n  - AGENTS.md",
					truncated: false,
					totalLines: 2,
					agentsMdFiles: [contextPath],
				},
			});
			try {
				const rendered = session.systemPrompt.join("\n\n");
				expect(session.sessionManager.getCwd()).toBe(sourceRoot);
				expect(rendered).toContain("locally-discovered-environment-context");
				expect(rendered).toContain('<file path="/workspace/AGENTS.md">');
				expect(rendered).toContain("current working directory: '/workspace'.");
				expect(rendered).not.toContain(sourceRoot);
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
		}
	});

	it("rejects an SDK system prompt override that reintroduces sourceRoot", async () => {
		using tempDir = TempDir.createSync("@omp-environment-prompt-leak-");
		const sourceRoot = tempDir.path();
		const authStorage = await AuthStorage.create(":memory:");

		try {
			await expect(
				createPromptSession(sourceRoot, authStorage, {
					contextFiles: [],
					workspaceTree: {
						rootPath: sourceRoot,
						rendered: "",
						truncated: false,
						totalLines: 0,
						agentsMdFiles: [],
					},
					systemPrompt: defaultPrompt => [...defaultPrompt, `Local worktree: ${sourceRoot}`],
				}),
			).rejects.toThrow("Execution environment system prompt contains the local source root");
		} finally {
			authStorage.close();
		}
	});
});
