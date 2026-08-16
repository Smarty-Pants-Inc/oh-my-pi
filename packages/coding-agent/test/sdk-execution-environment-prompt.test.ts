import { describe, expect, it } from "bun:test";
import type { Api, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { AuthStorage, clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { ExecutionEnvironmentBinding } from "@oh-my-pi/pi-coding-agent/session/execution-environment";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

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
		const api = "test-execution-environment-prompt";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "execution-environment-prompt",
			name: "Execution environment prompt",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey(model.provider, "test-key");

		try {
			const { session } = await createPromptSession(sourceRoot, authStorage, {
				model,
				workspaceTree: {
					rootPath: sourceRoot,
					rendered: ".\n  - AGENTS.md",
					truncated: false,
					totalLines: 2,
					agentsMdFiles: [contextPath],
				},
			});
			try {
				await session.sendUserMessage("verify remote cwd");
				expect(contexts).toHaveLength(1);
				const rendered = session.systemPrompt.join("\n\n");
				expect(session.sessionManager.getCwd()).toBe(sourceRoot);
				expect(rendered).toContain("locally-discovered-environment-context");
				expect(rendered).toContain('<external_instruction path="/workspace/AGENTS.md">');
				expect(rendered).not.toContain("Working directory:");
				expect(rendered).not.toContain(sourceRoot);

				const providerContext = contexts[0]!;
				const reminder = providerContext.instructions?.find(
					instruction => instruction.id === "system.date-cwd-reminder",
				);
				expect(reminder?.role).toBe("internal_context");
				expect(reminder?.trigger).toBe("provider_request");
				expect(reminder?.renderedText).toContain("/workspace");
				expect(reminder?.renderedText).not.toContain(sourceRoot);
				const directUser = providerContext.messages.find(message => message.role === "user");
				const directUserText =
					typeof directUser?.content === "string"
						? directUser.content
						: directUser?.content
								.filter(part => part.type === "text")
								.map(part => part.text)
								.join("");
				expect(directUserText).toBe("verify remote cwd");
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
			clearCustomApis();
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
