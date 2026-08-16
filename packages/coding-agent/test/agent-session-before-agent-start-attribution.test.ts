import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ContextInstruction } from "@oh-my-pi/pi-ai";
import { inferCopilotInitiator } from "@oh-my-pi/pi-ai/providers/github-copilot-headers";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ref } from "@oh-my-pi/pi-coding-agent/utils/git";

describe("AgentSession before_agent_start typed provider context", () => {
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;
	let capturedInstructions: ContextInstruction[] = [];

	const injectedText = "before-agent-start injected message";

	beforeEach(async () => {
		capturedInstructions = [];
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
	});

	function createSession() {
		const emitBeforeAgentStart = vi.fn().mockResolvedValue({
			messages: [
				{
					message: {
						customType: "before-start",
						content: injectedText,
						display: false,
					},
					extensionPath: "/test/extensions/inject.ts",
				},
			],
		});
		const extensionRunner = {
			emitBeforeAgentStart,
			emit: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const mockModel = createMockModel({ responses: [{ content: ["Done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (streamModel, context, options) => {
				capturedInstructions = session.buildProviderContextInstructions();
				return mockModel.stream(streamModel, context, options);
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});

		return { emitBeforeAgentStart };
	}

	function expectTypedExtensionInstruction(): void {
		const instruction = capturedInstructions.find(item => item.id === "extension.before_agent_start.0");
		expect(instruction).toBeDefined();
		expect(instruction?.role).toBe("internal_context");
		expect(instruction?.sourcePath).toBe("/test/extensions/inject.ts");
		expect(instruction?.renderedText).toContain(injectedText);
		expect(instruction?.renderedText).toContain("cannot override a direct user request");
		expect(session.messages.some(message => message.role === "custom" && message.customType === "before-start")).toBe(
			false,
		);
	}

	function findPromptMessage(messages: AgentMessage[], text: string): AgentMessage | undefined {
		return messages.find(message => {
			if ((message.role !== "user" && message.role !== "developer") || typeof message.content === "string") {
				return false;
			}
			return message.content.some(block => block.type === "text" && block.text === text);
		});
	}
	it("keeps direct-user authority while serializing before_agent_start as internal context", async () => {
		const { emitBeforeAgentStart } = createSession();

		await session.prompt("hello from user");

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		expectTypedExtensionInstruction();
		const llmMessages = convertToLlm(session.messages.filter(message => message.role !== "assistant"));
		expect(inferCopilotInitiator(llmMessages)).toBe("user");
	});

	it("keeps synthetic authority while serializing before_agent_start as internal context", async () => {
		const { emitBeforeAgentStart } = createSession();

		await session.prompt("internal reminder", { synthetic: true });

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		expectTypedExtensionInstruction();
		const llmMessages = convertToLlm(session.messages.filter(message => message.role !== "assistant"));
		expect(inferCopilotInitiator(llmMessages)).toBe("agent");
	});

	it("allows user-role prompts to opt into agent attribution", async () => {
		const { emitBeforeAgentStart } = createSession();
		const promptText = "delegated task";

		await session.prompt(promptText, { attribution: "agent" });

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		const promptMessage = findPromptMessage(session.messages, promptText);
		expect(promptMessage).toBeDefined();
		expect(promptMessage?.role).toBe("user");
		if (promptMessage?.role !== "user") {
			throw new Error("Expected delegated prompt to remain a user-role message");
		}
		expect(promptMessage.attribution).toBe("agent");

		expectTypedExtensionInstruction();
		const llmMessages = convertToLlm(session.messages.filter(message => message.role !== "assistant"));
		expect(inferCopilotInitiator(llmMessages)).toBe("agent");
	});

	it("includes active compaction context in the runtime explanation", async () => {
		vi.spyOn(ref, "commitIdentity").mockResolvedValue({ commit: "0".repeat(40), tree: "1".repeat(40) });
		createSession();
		session.agent.replaceMessages([
			{
				role: "branchSummary",
				summary: "exact branch summary evidence",
				fromId: "branch-root",
				timestamp: 1,
			},
			{
				role: "compactionSummary",
				summary: "exact compaction summary evidence",
				tokensBefore: 42,
				timestamp: 2,
			},
		]);

		const explanation = await session.explainContext({ includeContent: true });
		const branch = explanation.components.find(
			component => component.id === "agent.compaction.prompts.branch-summary-context",
		);
		const compaction = explanation.components.find(
			component => component.id === "agent.compaction.prompts.compaction-summary-context",
		);

		expect(branch).toMatchObject({
			trigger: "compaction",
			triggered: true,
			effective: true,
			availability: "effective",
			actualRole: "system",
		});
		expect(branch?.content).toContain("exact branch summary evidence");
		expect(compaction).toMatchObject({
			trigger: "compaction",
			triggered: true,
			effective: true,
			availability: "effective",
			actualRole: "system",
		});
		expect(compaction?.content).toContain("exact compaction summary evidence");
		expect(branch?.providerOrder).toBeLessThan(compaction?.providerOrder ?? -1);
	});
});
