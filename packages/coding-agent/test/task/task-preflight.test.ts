import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(options: {
	manager: AsyncJobManager;
	settings?: Record<string, unknown>;
	spawns?: string | boolean;
	modelRegistry?: ModelRegistry;
}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true, ...options.settings }),
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		asyncJobManager: options.manager,
		modelRegistry: options.modelRegistry,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function resultFor(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		assignment: "work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
	});
}

function modelRegistry(
	models: Model<Api>[],
	awaitBackgroundRefresh: () => Promise<void> = async () => {},
): ModelRegistry {
	return {
		authStorage: {},
		getAvailable: () => models,
		awaitBackgroundRefresh,
		getApiKey: async () => "test-key",
	} as unknown as ModelRegistry;
}

function mockDiscovery(agents: AgentDefinition[] = [taskAgent]): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

describe("task async preflight", () => {
	const managers: AsyncJobManager[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function manager(): AsyncJobManager {
		const result = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(result);
		return result;
	}

	it.each([
		{
			name: "Unknown",
			params: { agent: "missing", name: "Unknown", task: "Work." },
			expectation: 'Unknown agent "missing"',
		},
		{
			name: "Disabled",
			params: { agent: "task", name: "Disabled", task: "Work." },
			settings: { "task.disabledAgents": ["task"] },
			expectation: 'Agent "task" is disabled',
		},
		{
			name: "Disallowed",
			params: { agent: "task", name: "Disallowed", task: "Work." },
			spawns: "scout",
			expectation: "Cannot spawn 'task'",
		},
	])(
		"returns $name policy errors before registering an async job",
		async ({ name, params, settings, spawns, expectation }) => {
			mockDiscovery();
			const jobs = manager();
			const tool = await TaskTool.create(createSession({ manager: jobs, settings, spawns }));

			const result = await tool.execute("preflight", params as TaskParams);

			expect(textOf(result)).toContain(expectation);
			expect(jobs.getJob(name)).toBeUndefined();
		},
	);

	it("rejects an invalid async batch atomically before dispatching any item", async () => {
		mockDiscovery();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
		const jobs = manager();
		const register = vi.spyOn(jobs, "register");
		const tool = await TaskTool.create(createSession({ manager: jobs, settings: { "task.batch": true } }));

		const result = await tool.execute("mixed-preflight", {
			context: "Shared context.",
			tasks: [
				{ name: "Invalid", agent: "missing", task: "Do invalid work." },
				{ name: "AlsoInvalid", agent: "also-missing", task: "Do more invalid work." },
				{ name: "Valid", agent: "task", task: "Do valid work." },
			],
		} as TaskParams);

		const text = textOf(result);
		expect(text).toContain('Task Invalid failed preflight: Unknown agent "missing"');
		expect(text).toContain('Task AlsoInvalid failed preflight: Unknown agent "also-missing"');
		expect(register).not.toHaveBeenCalled();
		expect(runSubprocess).not.toHaveBeenCalled();
		expect(jobs.getJob("Invalid")).toBeUndefined();
		expect(jobs.getJob("AlsoInvalid")).toBeUndefined();
		expect(jobs.getJob("Valid")).toBeUndefined();
	});

	it("rejects an invalid synchronous batch before running any item", async () => {
		mockDiscovery();
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
		const jobs = manager();
		const register = vi.spyOn(jobs, "register");
		const tool = await TaskTool.create(
			createSession({ manager: jobs, settings: { "async.enabled": false, "task.batch": true } }),
		);

		const result = await tool.execute("sync-preflight", {
			context: "Shared context.",
			tasks: [
				{ name: "Invalid", agent: "missing", task: "Do invalid work." },
				{ name: "Valid", agent: "task", task: "Do valid work." },
			],
		} as TaskParams);

		expect(textOf(result)).toContain('Task Invalid failed preflight: Unknown agent "missing"');
		expect(register).not.toHaveBeenCalled();
		expect(runSubprocess).not.toHaveBeenCalled();
		expect(jobs.getJob("Invalid")).toBeUndefined();
		expect(jobs.getJob("Valid")).toBeUndefined();
	});
	it("forwards ordered per-spawn model selectors through the ordinary synchronous task path", async () => {
		mockDiscovery();
		const first = model("p", "first");
		const second = model("p", "second");
		const runSubprocess = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => resultFor(options.id));
		const jobs = manager();
		const tool = await TaskTool.create(
			createSession({
				manager: jobs,
				modelRegistry: modelRegistry([first, second]),
				settings: { "async.enabled": false },
			}),
		);

		const output = await tool.execute("model-dispatch", {
			agent: "task",
			name: "Chosen",
			task: "Work.",
			model: ["p/first", "p/second"],
		} as TaskParams);

		expect(textOf(output)).toContain("done");
		expect(runSubprocess).toHaveBeenCalledTimes(1);
		expect(runSubprocess.mock.calls[0]?.[0].modelOverride).toEqual(["p/first", "p/second"]);
		expect(runSubprocess.mock.calls[0]?.[0].modelSelectionExplicit).toBe(true);
		expect(runSubprocess.mock.calls[0]?.[0].allowedModels?.map(candidate => candidate.id)).toEqual([
			"first",
			"second",
		]);
	});

	it("rejects an out-of-scope model before registering a job or allocating an agent id", async () => {
		mockDiscovery();
		const allowed = model("p", "allowed");
		const denied = model("p", "denied");
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
		const jobs = manager();
		const register = vi.spyOn(jobs, "register");
		const session = createSession({
			manager: jobs,
			modelRegistry: modelRegistry([allowed, denied]),
			settings: { enabledModels: ["p/allowed"] },
		});
		const allocate = vi.fn(async () => "unexpected");
		session.agentOutputManager = { allocate } as unknown as ToolSession["agentOutputManager"];
		const tool = await TaskTool.create(session);

		const output = await tool.execute("model-preflight", {
			agent: "task",
			name: "Denied",
			task: "Work.",
			model: "p/denied",
		} as TaskParams);

		expect(textOf(output)).toContain("within the active enabledModels scope");
		expect(register).not.toHaveBeenCalled();
		expect(allocate).not.toHaveBeenCalled();
		expect(runSubprocess).not.toHaveBeenCalled();
		expect(jobs.getJob("Denied")).toBeUndefined();
	});

	it("rejects a mixed model batch atomically before any dispatch", async () => {
		mockDiscovery();
		const first = model("p", "first");
		const second = model("p", "second");
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
		const jobs = manager();
		const register = vi.spyOn(jobs, "register");
		const tool = await TaskTool.create(
			createSession({
				manager: jobs,
				modelRegistry: modelRegistry([first, second]),
				settings: { "task.batch": true, enabledModels: ["p/first"] },
			}),
		);

		const output = await tool.execute("model-batch", {
			context: "Shared context.",
			tasks: [
				{ name: "Valid", agent: "task", task: "First.", model: "p/first" },
				{ name: "Invalid", agent: "task", task: "Second.", model: "p/second" },
			],
		} as TaskParams);

		expect(textOf(output)).toContain("Task Invalid failed preflight");
		expect(textOf(output)).toContain("within the active enabledModels scope");
		expect(register).not.toHaveBeenCalled();
		expect(runSubprocess).not.toHaveBeenCalled();
		expect(jobs.getJob("Valid")).toBeUndefined();
		expect(jobs.getJob("Invalid")).toBeUndefined();
	});

	it("aborts model-discovery preflight before allocating or dispatching", async () => {
		mockDiscovery();
		const available = model("p", "available");
		const refreshStarted = Promise.withResolvers<void>();
		const refreshGate = Promise.withResolvers<void>();
		const jobs = manager();
		const register = vi.spyOn(jobs, "register");
		const runSubprocess = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(resultFor("unexpected"));
		const session = createSession({
			manager: jobs,
			modelRegistry: modelRegistry([available], async () => {
				refreshStarted.resolve();
				await refreshGate.promise;
			}),
		});
		const allocate = vi.fn(async () => "unexpected");
		session.agentOutputManager = { allocate } as unknown as ToolSession["agentOutputManager"];
		const tool = await TaskTool.create(session);
		const controller = new AbortController();

		const pending = tool.execute(
			"abort-preflight",
			{ agent: "task", name: "Cancelled", task: "Work." } as TaskParams,
			controller.signal,
		);
		await refreshStarted.promise;
		controller.abort(new Error("cancelled during model discovery"));
		const output = await pending;
		refreshGate.resolve();

		expect(textOf(output)).toContain("cancelled during model discovery");
		expect(register).not.toHaveBeenCalled();
		expect(allocate).not.toHaveBeenCalled();
		expect(runSubprocess).not.toHaveBeenCalled();
		expect(jobs.getJob("Cancelled")).toBeUndefined();
	});
});
