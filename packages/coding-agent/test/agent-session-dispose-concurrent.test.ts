import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { MnemopiSessionState, setMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { EvalRunner } from "@oh-my-pi/pi-coding-agent/session/eval-runner";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("AgentSession concurrent disposal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-dispose-concurrent-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.useRealTimers();
		const current = session;
		session = undefined;
		if (current) await current.dispose();
		authStorage.close();
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	function createSession(
		ownedAsyncJobManager?: AsyncJobManager,
		options?: { agentId?: string; asyncJobManager?: AsyncJobManager; extensionRunner?: ExtensionRunner },
	): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			ownedAsyncJobManager,
			extensionRunner: options?.extensionRunner,
			asyncJobManager: options?.asyncJobManager,
			agentId: options?.agentId ?? "Main",
		});
		return session;
	}

	it("tags an owner's jobs with the shutdown reason before disposing the manager", async () => {
		// Regression: `#disposeOwnedAsyncJobs` pre-cancels the owner's jobs via
		// `#cancelOwnAsyncJobs` BEFORE `manager.dispose()`. If that pre-cancel
		// dropped the shutdown reason, the owned subagent job saw a generic
		// caller signal and was tombstoned instead of parked.
		const owned = new AsyncJobManager({ maxRunningJobs: 1 });
		const started = Promise.withResolvers<void>();
		let abortReason: unknown;
		owned.register(
			"task",
			"running subagent",
			async ({ signal }) => {
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener(
					"abort",
					() => {
						abortReason = signal.reason;
						aborted.resolve();
					},
					{ once: true },
				);
				started.resolve();
				await aborted.promise;
				return "stopped";
			},
			{ ownerId: "Main", agentId: "Sub" },
		);
		const current = createSession(owned);

		await started.promise;
		await current.dispose();
		session = undefined;

		expect(abortReason).toBe(ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
	});

	it("propagates a generic cancellation for a subagent dispose so nested children stay terminal", async () => {
		// A subagent session leaves `ownedAsyncJobManager` undefined and inherits
		// the shared manager. Its dispose (e.g. `release({ tombstone: true })`
		// during an explicit hard kill) must NOT tag its owned jobs as shutdown,
		// or nested children would be rediscovered as parked instead of terminal.
		const shared = new AsyncJobManager({ maxRunningJobs: 1 });
		const started = Promise.withResolvers<void>();
		let abortReason: unknown;
		shared.register(
			"task",
			"nested child",
			async ({ signal }) => {
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener(
					"abort",
					() => {
						abortReason = signal.reason;
						aborted.resolve();
					},
					{ once: true },
				);
				started.resolve();
				await aborted.promise;
				return "stopped";
			},
			{ ownerId: "Sub", agentId: "NestedChild" },
		);
		const current = createSession(undefined, { agentId: "Sub", asyncJobManager: shared });

		await started.promise;
		await current.dispose();
		session = undefined;

		expect(abortReason).not.toBe(ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
		expect(abortReason).toBeInstanceOf(DOMException);
		await shared.dispose({ timeoutMs: 1_000 });
	});

	it("starts independent writers together and closes persistence after their barrier", async () => {
		const owned = new AsyncJobManager({ maxRunningJobs: 1, retentionMs: 1_000, onJobComplete: () => {} });
		const asyncGate = Promise.withResolvers<void>();
		const hindsightGate = Promise.withResolvers<void>();
		const mnemopiGate = Promise.withResolvers<void>();
		const asyncStarted = Promise.withResolvers<void>();
		const order: string[] = [];
		vi.spyOn(owned, "dispose").mockImplementation(async () => {
			order.push("async:start");
			asyncStarted.resolve();
			await asyncGate.promise;
			order.push("async:end");
			return true;
		});

		const current = createSession(owned);
		const hindsight: HindsightSessionState = Object.create(HindsightSessionState.prototype);
		vi.spyOn(hindsight, "flushRetainQueue").mockImplementation(async () => {
			order.push("hindsight:start");
			await hindsightGate.promise;
			order.push("hindsight:end");
		});
		vi.spyOn(hindsight, "dispose").mockImplementation(() => {});
		current.setHindsightSessionState(hindsight);

		const mnemopi: MnemopiSessionState = Object.create(MnemopiSessionState.prototype);
		vi.spyOn(mnemopi, "dispose").mockImplementation(async () => {
			order.push("mnemopi:start");
			await mnemopiGate.promise;
			order.push("mnemopi:end");
		});
		setMnemopiSessionState(current, mnemopi);

		let persistenceClosed = false;
		vi.spyOn(current.sessionManager, "close").mockImplementation(async () => {
			persistenceClosed = true;
			order.push("session:close");
		});

		const dispose = current.dispose();
		try {
			await asyncStarted.promise;
			await Promise.resolve();
			expect(order).toContain("hindsight:start");
			expect(order).toContain("mnemopi:start");
			expect(order).not.toContain("async:end");
			expect(order).not.toContain("hindsight:end");
			expect(order).not.toContain("mnemopi:end");
			expect(persistenceClosed).toBe(false);
		} finally {
			asyncGate.resolve();
			hindsightGate.resolve();
			mnemopiGate.resolve();
		}
		await dispose;
		session = undefined;

		const closeAt = order.indexOf("session:close");
		expect(closeAt).toBeGreaterThan(order.indexOf("async:end"));
		expect(closeAt).toBeGreaterThan(order.indexOf("hindsight:end"));
		expect(closeAt).toBeGreaterThan(order.indexOf("mnemopi:end"));
	});

	it("publishes terminal shutdown only after abort quiescence", async () => {
		const postPromptGate = Promise.withResolvers<void>();
		const shutdown = vi.fn();
		const extensionRunner = {
			hasHandlers: vi.fn((type: string) => type === "session_shutdown"),
			emitSessionShutdown: vi.fn(async () => {
				shutdown();
				return new Set<string>();
			}),
			disposeFileFallbacks: vi.fn(),
			clearManagedTimers: vi.fn(),
		} as unknown as ExtensionRunner;
		const current = createSession(undefined, { extensionRunner });
		current.trackPostPromptTaskForTests(postPromptGate.promise);

		const dispose = current.dispose();
		await flushMicrotasks();
		expect(shutdown).not.toHaveBeenCalled();

		postPromptGate.resolve();
		await dispose;
		session = undefined;
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(extensionRunner.clearManagedTimers).toHaveBeenCalledTimes(1);
	});

	it("drains a queued extension agent_end before session_shutdown", async () => {
		const extensionEntered = Promise.withResolvers<void>();
		const releaseExtension = Promise.withResolvers<void>();
		const publicAgentEnd = Promise.withResolvers<void>();
		const order: string[] = [];
		let shutdownPublished = false;
		const extensionRunner = {
			hasHandlers: vi.fn((type: string) => type === "agent_end" || type === "session_shutdown"),
			emit: vi.fn(async (event: { type: string }) => {
				if (shutdownPublished) order.push(`after-shutdown:${event.type}`);
				if (event.type !== "agent_end") return;
				order.push("agent_end:start");
				extensionEntered.resolve();
				await releaseExtension.promise;
				order.push("agent_end:end");
			}),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			emitSessionShutdown: vi.fn(async () => {
				shutdownPublished = true;
				order.push("session_shutdown");
				return new Set<string>();
			}),
			disposeFileFallbacks: vi.fn(),
			clearManagedTimers: vi.fn(),
		} as unknown as ExtensionRunner;
		const current = createSession(undefined, { extensionRunner });
		let dispose: Promise<void> | undefined;
		current.subscribe(event => {
			if (event.type !== "agent_end") return;
			publicAgentEnd.resolve();
			dispose ??= current.dispose();
		});

		const prompt = current.prompt("finish before shutdown");
		await publicAgentEnd.promise;
		await extensionEntered.promise;
		expect(shutdownPublished).toBe(false);

		releaseExtension.resolve();
		await Promise.all([prompt, dispose!]);
		session = undefined;

		expect(order).toEqual(["agent_end:start", "agent_end:end", "session_shutdown"]);
		expect(order.filter(event => event.startsWith("after-shutdown:"))).toEqual([]);
	});

	it("keeps a suppressed abort agent_end behind blocked message_end fan-out before shutdown", async () => {
		const extensionEntered = Promise.withResolvers<void>();
		const releaseExtension = Promise.withResolvers<void>();
		const order: string[] = [];
		let shutdownPublished = false;
		const extensionRunner = {
			hasHandlers: vi.fn((type: string) => type === "message_end" || type === "session_shutdown"),
			emit: vi.fn(async (event: { type: string }) => {
				if (event.type !== "message_end") return;
				order.push("message_end:extension:start");
				extensionEntered.resolve();
				await releaseExtension.promise;
				if (shutdownPublished) order.push("after-shutdown:message_end:extension");
				order.push("message_end:extension:end");
			}),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			emitSessionShutdown: vi.fn(async () => {
				shutdownPublished = true;
				order.push("session_shutdown");
				return new Set<string>();
			}),
			disposeFileFallbacks: vi.fn(),
			clearManagedTimers: vi.fn(),
		} as unknown as ExtensionRunner;
		const current = createSession(undefined, { extensionRunner });
		let publicAgentEnds = 0;
		current.subscribe(event => {
			if (event.type === "agent_end") publicAgentEnds++;
			if (event.type !== "message_end") return;
			if (shutdownPublished) order.push("after-shutdown:message_end:public");
			order.push("message_end:public");
		});

		const message = createAssistantMessage("blocked ordinary event");
		const messageEnd = current.emitSessionEventForTests({ type: "message_end", message });
		await extensionEntered.promise;

		// beginDispose() is dispose's synchronous fence; the tracked promise models
		// #dispatchAgentEvent's abort agent_end ownership before teardown drains it.
		current.beginDispose();
		const abortedMessage = { ...createAssistantMessage("aborted terminal"), stopReason: "aborted" as const };
		const abortAgentEnd = current
			.emitSessionEventForTests({ type: "agent_end", messages: [abortedMessage] })
			.then(() => order.push("agent_end:suppressed"));
		current.trackPostPromptTaskForTests(abortAgentEnd);
		const dispose = current.dispose();
		for (let i = 0; i < 20 && !shutdownPublished; i++) await flushMicrotasks();
		expect(shutdownPublished).toBe(false);
		expect(order).toEqual(["message_end:extension:start"]);

		releaseExtension.resolve();
		await Promise.all([messageEnd, abortAgentEnd, dispose]);
		session = undefined;

		expect(publicAgentEnds).toBe(0);
		expect(order).toEqual([
			"message_end:extension:start",
			"message_end:extension:end",
			"message_end:public",
			"agent_end:suppressed",
			"session_shutdown",
		]);
		expect(order.filter(event => event.startsWith("after-shutdown:"))).toEqual([]);
	});

	it("does not publish a late agent_end after session_shutdown", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const releaseLateTask = Promise.withResolvers<void>();
		const shutdownEntered = Promise.withResolvers<void>();
		const releaseShutdown = Promise.withResolvers<void>();
		const extensionAgentEnds: string[] = [];
		const publicAgentEnds: string[] = [];
		let shutdownPublished = false;
		const extensionRunner = {
			hasHandlers: vi.fn((type: string) => type === "agent_end" || type === "session_shutdown"),
			emit: vi.fn(async (event: { type: string }) => {
				if (event.type === "agent_end") extensionAgentEnds.push(shutdownPublished ? "after" : "before");
			}),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			emitSessionShutdown: vi.fn(async () => {
				shutdownPublished = true;
				shutdownEntered.resolve();
				await releaseShutdown.promise;
				return new Set<string>();
			}),
			disposeFileFallbacks: vi.fn(),
			clearManagedTimers: vi.fn(),
		} as unknown as ExtensionRunner;
		const current = createSession(undefined, { extensionRunner });
		current.subscribe(event => {
			if (event.type === "agent_end") publicAgentEnds.push(shutdownPublished ? "after" : "before");
		});
		const lateAssistant = createAssistantMessage("late terminal");
		const lateTask = releaseLateTask.promise.then(() => {
			current.agent.emitExternalEvent({ type: "agent_end", messages: [lateAssistant] });
		});
		current.trackPostPromptTaskForTests(lateTask);

		const dispose = current.dispose();
		await shutdownEntered.promise;
		releaseLateTask.resolve();
		await lateTask;
		await flushMicrotasks();
		expect(publicAgentEnds).toEqual([]);
		expect(extensionAgentEnds).toEqual([]);

		releaseShutdown.resolve();
		await dispose;
		session = undefined;
		expect(publicAgentEnds).toEqual([]);
		expect(extensionAgentEnds).toEqual([]);
	}, 15_000);

	it("bounds post-prompt work that ignores abort", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const current = createSession();
		const hangingTask = Promise.withResolvers<void>();
		current.trackPostPromptTaskForTests(hangingTask.promise);

		const dispose = current.dispose();
		await flushMicrotasks();
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		await dispose;
		session = undefined;

		expect(warn).toHaveBeenCalledWith(
			"Post-prompt tasks still draining at dispose deadline",
			expect.objectContaining({ error: "Error: Timed out draining post-prompt tasks during dispose" }),
		);
	});

	it("applies the disposal deadline when joining an unbounded ordinary abort", async () => {
		vi.useFakeTimers();
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const current = createSession();
		const hangingTask = Promise.withResolvers<void>();
		current.trackPostPromptTaskForTests(hangingTask.promise);
		const agentAbort = vi.spyOn(current.agent, "abort");
		const kernelCleanupStarted = Promise.withResolvers<void>();
		const disposeKernels = vi.spyOn(EvalRunner.prototype, "disposeKernels").mockImplementation(async () => {
			kernelCleanupStarted.resolve();
		});

		const ordinaryAbort = current.abort();
		await flushMicrotasks();
		expect(agentAbort).toHaveBeenCalledTimes(1);
		expect(disposeKernels).not.toHaveBeenCalled();

		const dispose = current.dispose();
		await flushMicrotasks();
		expect(agentAbort).toHaveBeenCalledTimes(1);
		expect(disposeKernels).not.toHaveBeenCalled();

		vi.advanceTimersByTime(4_999);
		await flushMicrotasks();
		expect(disposeKernels).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		await kernelCleanupStarted.promise;
		expect(disposeKernels).toHaveBeenCalledTimes(1);

		await Promise.all([ordinaryAbort, dispose]);
		session = undefined;
		expect(agentAbort).toHaveBeenCalledTimes(1);
	});

	it("clears the owned async manager when its dispose rejects", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const owned = new AsyncJobManager({ maxRunningJobs: 1, retentionMs: 1_000, onJobComplete: () => {} });
		vi.spyOn(owned, "dispose").mockRejectedValue(new Error("async dispose failed"));
		AsyncJobManager.setInstance(owned);
		const current = createSession(owned);

		await current.dispose();
		session = undefined;

		expect(AsyncJobManager.instance()).toBeUndefined();
		expect(warn).toHaveBeenCalledWith("Session dispose subsystem failed during parallel teardown", {
			error: "Error: async dispose failed",
		});
	});
});
