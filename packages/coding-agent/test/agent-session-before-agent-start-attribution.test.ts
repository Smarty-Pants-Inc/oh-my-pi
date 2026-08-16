import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentOptions, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { ContextInstruction, Model } from "@oh-my-pi/pi-ai";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import { inferCopilotInitiator } from "@oh-my-pi/pi-ai/providers/github-copilot-headers";
import { buildGitLabDuoWorkflowStartRequest } from "@oh-my-pi/pi-ai/providers/gitlab-duo-workflow";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	canonicalJson,
	compareUnicodeCodePoints,
	type JsonValue,
	sha256,
} from "@oh-my-pi/pi-coding-agent/context/canonical";
import {
	captureRuntimeContextEvidence,
	isRuntimeContextEvidencePayload,
} from "@oh-my-pi/pi-coding-agent/context/explain";
import { buildContextReleaseManifest } from "@oh-my-pi/pi-coding-agent/context/manifest";
import { exportRenderedToolContracts } from "@oh-my-pi/pi-coding-agent/context/tool-contracts";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { diff, fetch as gitFetch, ref } from "@oh-my-pi/pi-coding-agent/utils/git";

const repository = path.resolve(import.meta.dir, "../../..");
const scopeBase = "37eee71978951fccf66b21f7e3e2b74596ac9d74";
const scopeBaseTree = "a20c0452f99155e7adeaecfad28e4afd0223c684";
const scopeBaseUrl = "https://github.com/can1357/oh-my-pi.git";

describe("AgentSession before_agent_start typed provider context", () => {
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;
	let capturedInstructions: ContextInstruction[] = [];
	let fixtureHome = "";
	let ambientHome = "";

	const injectedText = "before-agent-start injected message";
	const globalAgentsSource = "isolated before-agent-start test instructions\n";
	const configurationSource = "{}\n";

	beforeEach(async () => {
		capturedInstructions = [];
		ambientHome = os.homedir();
		fixtureHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-before-agent-start-home-"));
		const agentDir = path.join(fixtureHome, ".omp/agent");
		await fs.mkdir(agentDir, { recursive: true });
		await Promise.all([
			fs.writeFile(path.join(agentDir, "AGENTS.md"), globalAgentsSource),
			fs.writeFile(path.join(agentDir, "config.yml"), configurationSource),
		]);
		vi.spyOn(os, "homedir").mockReturnValue(fixtureHome);
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
		await fs.rm(fixtureHome, { recursive: true, force: true });
		fixtureHome = "";
	});

	function createSession(
		fixture: Pick<AgentOptions, "onPayload" | "streamFn"> & {
			systemPrompt?: string[];
			tools?: AgentTool[];
		} = {},
	) {
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
				systemPrompt: fixture.systemPrompt ?? ["Test"],
				tools: fixture.tools ?? [],
				messages: [],
			},
			transformProviderContext: context => {
				capturedInstructions = session.buildProviderContextInstructions();
				return capturedInstructions.length > 0
					? { ...context, instructions: [...(context.instructions ?? []), ...capturedInstructions] }
					: context;
			},
			streamFn: (streamModel, context, streamOptions) => {
				return fixture.streamFn
					? fixture.streamFn(streamModel, context, streamOptions)
					: mockModel.stream(streamModel, context, streamOptions);
			},
			onPayload: fixture.onPayload,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});

		return { emitBeforeAgentStart, model };
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

	async function writeReviewedPolicyState() {
		let baseIdentity = await ref.commitIdentity(repository, scopeBase);
		if (!baseIdentity) {
			await gitFetch(repository, scopeBaseUrl, scopeBase, `refs/omp/test-scope-base/${scopeBase}`);
			baseIdentity = await ref.commitIdentity(repository, scopeBase);
		}
		if (baseIdentity?.commit !== scopeBase || baseIdentity.tree !== scopeBaseTree) {
			throw new Error("Expected the exact frozen scope base");
		}
		const changedPaths = (await diff(repository, { base: scopeBase, head: "HEAD", nameOnly: true, z: true }))
			.split("\0")
			.filter(Boolean)
			.sort(compareUnicodeCodePoints);
		const release = await buildContextReleaseManifest(repository, undefined, {
			scopeCoverage: changedPaths.map(changedPath => ({
				path: changedPath,
				requirement: "§8.6 test fixture for the required expanded candidate schema.",
			})),
		});
		await fs.writeFile(path.join(fixtureHome, ".omp/policy-state.json"), `${JSON.stringify(release)}\n`);
		return release;
	}

	it("binds release evidence to isolated global sources without ambient home files", async () => {
		const release = await writeReviewedPolicyState();

		expect(release.globalAgentsPath).toBe(path.join(fixtureHome, ".omp/agent/AGENTS.md"));
		expect(release.globalAgentsPath).not.toBe(path.join(ambientHome, ".omp/agent/AGENTS.md"));
		expect(release.globalAgentsSha256).toBe(sha256(globalAgentsSource));
		expect(release.configurationSourceSha256).toBe(sha256(configurationSource));
	});

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

	it("matches live explain order and rendered contracts to the same final guarded payload", async () => {
		const release = await writeReviewedPolicyState();
		const probeSchema = type({ query: "string" });
		const probeTool: AgentTool<typeof probeSchema, undefined> = {
			name: "context_probe",
			label: "Context Probe",
			description: "Inspect exact context evidence",
			parameters: probeSchema,
			async execute() {
				return { content: [{ type: "text", text: "unused" }], details: undefined };
			},
		};

		let guardedPayload: unknown;
		let sentPayload: unknown;
		let guardCalls = 0;
		const anthropicStream: StreamFn = (streamModel, context, streamOptions) => {
			if (streamModel.api !== "anthropic-messages") throw new Error("Expected an Anthropic model");
			if (!streamOptions || typeof streamOptions.apiKey !== "string") throw new Error("Expected a resolved API key");
			return streamAnthropic(streamModel as Model<"anthropic-messages">, context, {
				...streamOptions,
				apiKey: streamOptions.apiKey,
			});
		};
		const { model } = createSession({
			systemPrompt: ["exact base system block", "exact project system block"],
			tools: [probeTool],
			streamFn: anthropicStream,
			onPayload: async (payload, payloadModel) => {
				guardCalls++;
				if (!payloadModel) throw new Error("Expected the selected provider model");
				const guarded = structuredClone(payload) as {
					system?: Array<Record<string, unknown>>;
					tools?: Array<Record<string, unknown>>;
				};
				const projectBlock = guarded.system?.[1];
				if (!projectBlock || typeof projectBlock.text !== "string") {
					throw new Error("Expected the final Anthropic payload to contain the project system block");
				}
				projectBlock.text = `${projectBlock.text} [guarded]`;
				const tool = guarded.tools?.[0];
				if (!tool || typeof tool.description !== "string") {
					throw new Error("Expected the final Anthropic payload to contain the context probe tool");
				}
				tool.description = `${tool.description} [guarded]`;
				guardedPayload = structuredClone(guarded);
				const renderedToolContracts = exportRenderedToolContracts(guarded, payloadModel, {
					contentManifestRootSha256: release.contentManifestRootSha256,
					configurationSemanticSha256: release.configurationSemanticSha256,
				});
				session.setRenderedToolContracts(renderedToolContracts);
				session.setRuntimeContextEvidence(
					captureRuntimeContextEvidence(
						guarded,
						payloadModel,
						"main",
						session.buildProviderContextInstructions(),
						renderedToolContracts,
					),
					payloadModel,
				);
				return guarded;
			},
		});
		const beforeRequest = await session.explainContext({ includeContent: true });
		expect(beforeRequest.components.filter(component => component.effective)).toHaveLength(0);
		expect(beforeRequest.components.every(component => component.providerOrder === null)).toBe(true);
		expect(beforeRequest.toolContracts.status).toBe("unavailable");

		const events = [
			{
				type: "message_start",
				message: {
					id: "msg_context_explain",
					usage: {
						input_tokens: 12,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: {
					input_tokens: 12,
					output_tokens: 4,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
			{ type: "message_stop" },
		];
		const createRequest = vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(payload => {
			sentPayload = structuredClone(payload);
			const response = new Response(null, { status: 200, headers: { "request-id": "req_context_explain" } });
			return {
				async withResponse() {
					return {
						data: {
							async *[Symbol.asyncIterator]() {
								for (const event of events) yield event;
							},
						},
						response,
						request_id: "req_context_explain",
					};
				},
			} as never;
		});

		await session.prompt("prove live context parity");

		session.agent.setSystemPrompt(["post-request state must not replace the captured request"]);
		const explanation = await session.explainContext({ includeContent: true });
		if (!sentPayload || !guardedPayload) throw new Error("Expected one captured provider call");
		expect(guardCalls).toBe(1);
		expect(createRequest).toHaveBeenCalledTimes(1);
		expect(sentPayload).toEqual(guardedPayload);
		const wireSystem = ((sentPayload as { system?: unknown[] }).system ?? []).flatMap(block => {
			if (!block || typeof block !== "object" || !("text" in block) || typeof block.text !== "string") return [];
			return [block.text];
		});
		const ordered = explanation.components
			.filter(component => component.effective && component.providerOrder !== null)
			.sort((left, right) => (left.providerOrder ?? 0) - (right.providerOrder ?? 0));
		expect(ordered.map(component => component.id)).toEqual([
			"runtime.system_prompt.0",
			"runtime.system_prompt.1",
			"extension.before_agent_start.0",
		]);
		expect(ordered.map(component => component.providerOrder)).toEqual([0, 1, 2]);
		expect(ordered.map(component => component.actualRole)).toEqual(["system", "system", "system"]);
		expect(ordered.map(component => component.content)).toEqual(wireSystem);
		expect(ordered.map(component => component.sha256)).toEqual(wireSystem.map(sha256));

		expect(explanation).toMatchObject({ provider: model.provider, model: model.id });
		expect(explanation.release.contentManifestRootSha256).toBe(release.contentManifestRootSha256);
		expect(explanation.release.configurationSemanticSha256).toBe(release.configurationSemanticSha256);
		expect(explanation.toolContracts.status).toBe("effective");
		if (explanation.toolContracts.status !== "effective") throw new Error("Expected rendered tool contracts");
		const rendered = explanation.toolContracts.export;
		const expected = exportRenderedToolContracts(sentPayload, model, {
			contentManifestRootSha256: release.contentManifestRootSha256,
			configurationSemanticSha256: release.configurationSemanticSha256,
		});
		expect(rendered).toEqual(expected);
		expect(rendered.contentManifestRootSha256).toBe(explanation.release.contentManifestRootSha256);
		expect(rendered.configurationSemanticSha256).toBe(explanation.release.configurationSemanticSha256);
		expect(rendered.tools).toHaveLength(1);
		expect(rendered.tools[0]).toMatchObject({
			id: "tool.context_probe",
			description: "Inspect exact context evidence [guarded]",
		});
		const { rootSha256, ...rootPayload } = rendered;
		expect(rootSha256).toBe(sha256(canonicalJson(rootPayload as unknown as JsonValue)));
	});

	it("retains guarded GitLab flow instructions and replaces start evidence with late contracts", async () => {
		const release = await writeReviewedPolicyState();
		createSession();
		const gitlabModel: Model<"gitlab-duo-agent"> = buildModel({
			id: "gitlab-explain-fixture",
			name: "GitLab Explain Fixture",
			api: "gitlab-duo-agent",
			provider: "gitlab-duo-agent",
			baseUrl: "https://gitlab.example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
			supportsTools: true,
		});
		const typedInstruction: ContextInstruction = {
			id: "extension.gitlab.policy",
			sourcePath: "/test/extensions/gitlab-policy.ts",
			role: "internal_context",
			target: "main",
			trigger: "extension_event",
			sha256: sha256("pre-guard GitLab policy"),
			renderedText: "pre-guard GitLab policy",
			order: 10,
		};
		const startRequest = buildGitLabDuoWorkflowStartRequest("workflow-explain", gitlabModel, {
			systemPrompt: ["pre-guard GitLab system"],
			instructions: [typedInstruction],
			messages: [{ role: "user", content: "GitLab request", timestamp: 1 }],
		});
		const guardedSystem = "exact final guarded GitLab flow instruction";
		const prompt = startRequest.flowConfig?.prompts[0];
		if (!prompt) throw new Error("Expected the GitLab start request to contain an inline flow prompt");
		prompt.prompt_template.system = guardedSystem;
		const guardedPayload = { startRequest };
		const binding = {
			contentManifestRootSha256: release.contentManifestRootSha256,
			configurationSemanticSha256: release.configurationSemanticSha256,
		};
		const staleStartContracts = exportRenderedToolContracts(guardedPayload, gitlabModel, binding);
		expect(staleStartContracts.tools).toHaveLength(0);
		session.setRuntimeContextEvidence(
			captureRuntimeContextEvidence(guardedPayload, gitlabModel, "main", [typedInstruction], staleStartContracts),
			gitlabModel,
		);
		session.setRenderedToolContracts(staleStartContracts);

		const latePayload = {
			tools: [
				{
					name: "gitlab_context_probe",
					description: "exact late guarded GitLab tool",
					jsonSchemaString: JSON.stringify({
						type: "object",
						properties: { query: { type: "string" } },
						required: ["query"],
					}),
				},
			],
		};
		const lateContracts = exportRenderedToolContracts(latePayload, gitlabModel, binding);
		session.setRenderedToolContracts(lateContracts);

		const actionResponse = { actionResponse: { requestID: "action-explain", result: "ignored side frame" } };
		expect(isRuntimeContextEvidencePayload(actionResponse, gitlabModel)).toBe(false);
		if (isRuntimeContextEvidencePayload(actionResponse, gitlabModel)) {
			session.setRuntimeContextEvidence(
				captureRuntimeContextEvidence(actionResponse, gitlabModel, "main", [], undefined),
				gitlabModel,
			);
		}

		const explanation = await session.explainContext({ includeContent: true });
		const ordered = explanation.components.filter(
			component => component.effective && component.providerOrder !== null,
		);
		expect(ordered).toHaveLength(1);
		expect(ordered[0]).toMatchObject({
			id: "runtime.system_prompt.0",
			content: guardedSystem,
			actualRole: "system",
			providerOrder: 0,
			sha256: sha256(guardedSystem),
		});
		expect(explanation.components.find(component => component.id === typedInstruction.id)).toMatchObject({
			source: typedInstruction.sourcePath,
			triggered: true,
			effective: false,
			providerOrder: null,
		});
		expect(explanation.toolContracts.status).toBe("effective");
		if (explanation.toolContracts.status !== "effective") throw new Error("Expected late GitLab contracts");
		expect(explanation.toolContracts.export).toEqual(lateContracts);
		expect(explanation.toolContracts.export.rootSha256).not.toBe(staleStartContracts.rootSha256);
		expect(explanation.toolContracts.export.tools).toEqual([
			expect.objectContaining({
				id: "tool.gitlab_context_probe",
				description: "exact late guarded GitLab tool",
			}),
		]);
		const { rootSha256, ...rootPayload } = explanation.toolContracts.export;
		expect(rootSha256).toBe(sha256(canonicalJson(rootPayload as unknown as JsonValue)));
	});

	it("does not reconstruct unsent compaction context before a provider request", async () => {
		await writeReviewedPolicyState();
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
			triggered: false,
			effective: false,
			availability: "available",
			actualRole: "system",
			providerOrder: null,
		});
		expect(branch?.content).not.toContain("exact branch summary evidence");
		expect(compaction).toMatchObject({
			trigger: "compaction",
			triggered: false,
			effective: false,
			availability: "available",
			actualRole: "system",
			providerOrder: null,
		});
		expect(compaction?.content).not.toContain("exact compaction summary evidence");
	});
});
