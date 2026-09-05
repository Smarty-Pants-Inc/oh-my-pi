import { afterEach, expect, it, vi } from "bun:test";
import { AuthStorage, type Api, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const authStorages: AuthStorage[] = [];
const tempDirs: TempDir[] = [];

function yieldingSession(model?: Model<Api>, modelFallback = false): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	return {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model,
		servingModel: model ? { selector: `${model.provider}/${model.id}`, isFallback: modelFallback } : undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "yield",
					toolName: "yield",
					result: { content: [], details: { status: "success", data: { ok: true } } },
					isError: false,
				} as AgentSessionEvent);
			}
		},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
	} as unknown as AgentSession;
}

function sessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: new ExtensionRuntime() },
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const authStorage of authStorages.splice(0)) await authStorage.close();
	for (const tempDir of tempDirs.splice(0)) tempDir[Symbol.dispose]();
});

it("overlaps registry refresh for an inherited session-model selector", async () => {
	const tempDir = TempDir.createSync("@pi-task-launch-");
	tempDirs.push(tempDir);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorages.push(authStorage);

	const refreshGate = Promise.withResolvers<void>();
	vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(() => refreshGate.promise);

	const sessionManager = SessionManager.inMemory(tempDir.path());
	const openGate = Promise.withResolvers<SessionManager>();
	const openStarted = Promise.withResolvers<void>();
	const openSpy = vi.spyOn(SessionManager, "open").mockImplementation(() => {
		openStarted.resolve();
		return openGate.promise;
	});

	const sessionCreationStarted = Promise.withResolvers<void>();
	let sessionCreated = false;
	const session = yieldingSession();
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
		sessionCreationStarted.resolve();
		sessionCreated = true;
		return sessionResult(session);
	});

	const run = runSubprocess({
		cwd: tempDir.path(),
		artifactsDir: tempDir.path(),
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
		task: "test",
		index: 0,
		id: "task-launch-overlap",
		authStorage,
		modelOverride: "session/default",
		modelSelectionExplicit: false,
		enableLsp: false,
		enableIrc: false,
	});
	await openStarted.promise;

	expect(openSpy).toHaveBeenCalledTimes(1);
	expect(sessionCreated).toBe(false);

	openGate.resolve(sessionManager);
	await sessionCreationStarted.promise;
	expect(sessionCreated).toBe(true);

	refreshGate.resolve();
	expect((await run).exitCode).toBe(0);
});

it("refreshes the model catalog before resolving an explicit selector", async () => {
	const tempDir = TempDir.createSync("@pi-task-explicit-model-");
	tempDirs.push(tempDir);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorages.push(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	let refreshed = false;
	const refreshGate = Promise.withResolvers<void>();
	const refreshStarted = Promise.withResolvers<void>();
	vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(async () => {
		refreshStarted.resolve();
		await refreshGate.promise;
		refreshed = true;
	});
	vi.spyOn(ModelRegistry.prototype, "getAvailable").mockImplementation(() => (refreshed ? [model] : []));
	vi.spyOn(ModelRegistry.prototype, "hasConfiguredAuth").mockReturnValue(true);
	vi.spyOn(ModelRegistry.prototype, "getApiKey").mockResolvedValue("test-key");

	let sessionCreated = false;
	const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
		sessionCreated = true;
		return sessionResult(yieldingSession());
	});
	const selector = `${model.provider}/${model.id}`;
	const run = runSubprocess({
		cwd: tempDir.path(),
		artifactsDir: tempDir.path(),
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
		task: "test",
		index: 0,
		id: "task-explicit-model-refresh",
		authStorage,
		modelOverride: selector,
		modelSelectionExplicit: true,
		enableLsp: false,
		enableIrc: false,
	});

	await refreshStarted.promise;
	expect(sessionCreated).toBe(false);

	refreshGate.resolve();
	expect((await run).exitCode).toBe(0);
	expect(createSpy.mock.calls[0]?.[0]?.model).toBe(model);
});

it("defers an explicit selector until child extensions register their provider", async () => {
	const tempDir = TempDir.createSync("@pi-task-extension-model-");
	tempDirs.push(tempDir);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorages.push(authStorage);
	const selector = "runtime-provider/runtime-model";
	const extensionPath = tempDir.join("runtime-provider.ts");
	const preparedExtension: PreparedExtension = {
		path: extensionPath,
		resolvedPath: extensionPath,
		factory: pi => {
			pi.registerProvider("runtime-provider", {
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [
					{
						id: "runtime-model",
						name: "Runtime Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8_192,
					},
				],
			});
		},
		error: null,
	};
	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue();
	const createAgentSession = sdkModule.createAgentSession;
	const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		const created = await createAgentSession(options);
		const selected = created.session.model;
		const fallback = created.session.servingModel?.isFallback ?? false;
		await created.session.dispose();
		return sessionResult(yieldingSession(selected, fallback));
	});

	const result = await runSubprocess({
		cwd: tempDir.path(),
		artifactsDir: tempDir.path(),
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
		task: "test",
		index: 0,
		id: "task-extension-model",
		authStorage,
		settings: Settings.isolated({ enabledModels: [selector] }),
		modelOverride: selector,
		modelSelectionExplicit: true,
		preloadedExtensionPaths: [extensionPath],
		preloadedPreparedExtensions: [preparedExtension],
		enableLsp: false,
		enableIrc: false,
	});

	expect(result.exitCode).toBe(0);
	expect(result.resolvedModel).toBe(selector);
	expect(createSpy.mock.calls[0]?.[0]?.model).toBeUndefined();
	expect(createSpy.mock.calls[0]?.[0]?.modelPattern).toEqual([selector]);
});

it("uses the policy catalog for auth fallback when the executor creates its registry", async () => {
	const tempDir = TempDir.createSync("@pi-task-local-registry-fallback-");
	tempDirs.push(tempDir);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorages.push(authStorage);
	const requested = getBundledModel("opencode-zen", "qwen3.6-plus-free");
	const parent = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!requested || !parent) throw new Error("Expected requested and parent fallback models to exist");

	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue();
	vi.spyOn(ModelRegistry.prototype, "getAvailable").mockReturnValue([parent]);
	vi.spyOn(ModelRegistry.prototype, "getAll").mockReturnValue([requested, parent]);
	vi.spyOn(ModelRegistry.prototype, "getApiKey").mockImplementation(async model =>
		model.provider === parent.provider ? "test-key" : undefined,
	);
	const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(yieldingSession()));

	const result = await runSubprocess({
		cwd: tempDir.path(),
		artifactsDir: tempDir.path(),
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
		task: "test",
		index: 0,
		id: "task-local-registry-fallback",
		authStorage,
		settings: Settings.isolated({
			enabledModels: [`${requested.provider}/${requested.id}`, `${parent.provider}/${parent.id}`],
		}),
		modelOverride: `${requested.provider}/${requested.id}`,
		modelSelectionExplicit: true,
		parentActiveModelPattern: `${parent.provider}/${parent.id}`,
		enableLsp: false,
		enableIrc: false,
	});

	expect(result.exitCode).toBe(0);
	expect(createSpy.mock.calls[0]?.[0]).toMatchObject({ model: parent, initialModelFallback: true });
});

it("marks a later authenticated selector as the initial fallback", async () => {
	const tempDir = TempDir.createSync("@pi-task-ordered-model-fallback-");
	tempDirs.push(tempDir);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorages.push(authStorage);
	const requested = getBundledModel("opencode-zen", "qwen3.6-plus-free");
	const fallback = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!requested || !fallback) throw new Error("Expected ordered fallback models to exist");

	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue();
	vi.spyOn(ModelRegistry.prototype, "getAvailable").mockReturnValue([fallback]);
	vi.spyOn(ModelRegistry.prototype, "getAll").mockReturnValue([requested, fallback]);
	vi.spyOn(ModelRegistry.prototype, "getApiKey").mockImplementation(async model =>
		model.provider === fallback.provider ? "test-key" : undefined,
	);
	const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(yieldingSession()));
	const requestedSelector = `${requested.provider}/${requested.id}`;
	const fallbackSelector = `${fallback.provider}/${fallback.id}`;

	const result = await runSubprocess({
		cwd: tempDir.path(),
		artifactsDir: tempDir.path(),
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
		task: "test",
		index: 0,
		id: "task-ordered-model-fallback",
		authStorage,
		modelOverride: [requestedSelector, fallbackSelector],
		modelSelectionExplicit: true,
		parentActiveModelPattern: fallbackSelector,
		enableLsp: false,
		enableIrc: false,
	});

	expect(result.exitCode).toBe(0);
	expect(result.resolvedModel).toBe(fallbackSelector);
	expect(result.resolvedModelIsFallback).toBe(true);
	expect(createSpy.mock.calls[0]?.[0]).toMatchObject({ model: fallback, initialModelFallback: true });
});

it("rejects an out-of-scope explicit selector when the executor creates its registry", async () => {
	const tempDir = TempDir.createSync("@pi-task-local-registry-scope-");
	tempDirs.push(tempDir);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorages.push(authStorage);
	const requested = getBundledModel("opencode-zen", "qwen3.6-plus-free");
	const allowed = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!requested || !allowed) throw new Error("Expected requested and allowed models to exist");

	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue();
	vi.spyOn(ModelRegistry.prototype, "getAvailable").mockReturnValue([requested, allowed]);
	vi.spyOn(ModelRegistry.prototype, "getAll").mockReturnValue([requested, allowed]);
	vi.spyOn(ModelRegistry.prototype, "getApiKey").mockResolvedValue("test-key");
	const unresolvedSession = yieldingSession();
	const promptSpy = vi.spyOn(unresolvedSession, "prompt");
	const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		...sessionResult(unresolvedSession),
		modelFallbackMessage: `Model "${requested.provider}/${requested.id}" not found`,
	});

	const result = await runSubprocess({
		cwd: tempDir.path(),
		artifactsDir: tempDir.path(),
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
		task: "test",
		index: 0,
		id: "task-local-registry-scope",
		authStorage,
		settings: Settings.isolated({ enabledModels: [`${allowed.provider}/${allowed.id}`] }),
		modelOverride: `${requested.provider}/${requested.id}`,
		modelSelectionExplicit: true,
		enableLsp: false,
		enableIrc: false,
	});

	expect(result.exitCode).toBe(1);
	expect(result.error).toContain(`Model "${requested.provider}/${requested.id}" not found`);
	expect(createSpy).toHaveBeenCalledTimes(1);
	expect(promptSpy).not.toHaveBeenCalled();
});

it("fails an explicit selector that remains unresolved after refresh", async () => {
	const tempDir = TempDir.createSync("@pi-task-unresolved-model-");
	tempDirs.push(tempDir);
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorages.push(authStorage);

	const refreshGate = Promise.withResolvers<void>();
	const refreshStarted = Promise.withResolvers<void>();
	vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(async () => {
		refreshStarted.resolve();
		await refreshGate.promise;
	});
	vi.spyOn(ModelRegistry.prototype, "getAvailable").mockReturnValue([]);
	const unresolvedSession = yieldingSession();
	const promptSpy = vi.spyOn(unresolvedSession, "prompt");
	const createSpy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		...sessionResult(unresolvedSession),
		modelFallbackMessage: 'Model "missing/model" not found',
	});

	const run = runSubprocess({
		cwd: tempDir.path(),
		artifactsDir: tempDir.path(),
		agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
		task: "test",
		index: 0,
		id: "task-unresolved-model-refresh",
		authStorage,
		modelOverride: "missing/model",
		modelSelectionExplicit: true,
		enableLsp: false,
		enableIrc: false,
	});

	await refreshStarted.promise;
	expect(createSpy).not.toHaveBeenCalled();
	refreshGate.resolve();
	const result = await run;
	expect(result.exitCode).toBe(1);
	expect(result.error).toContain('Model "missing/model" not found');
	expect(createSpy).toHaveBeenCalledTimes(1);
	expect(promptSpy).not.toHaveBeenCalled();
});
