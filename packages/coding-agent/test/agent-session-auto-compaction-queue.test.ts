import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as unexpectedStopClassifier from "@oh-my-pi/pi-coding-agent/session/unexpected-stop-classifier";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";

const runtimeSignalStoreKey = "__ompRuntimeSignals";

type RuntimeSignalGlobal = typeof globalThis & { [runtimeSignalStoreKey]?: string[] };

function getRuntimeSignals(): string[] {
	const globalWithSignals = globalThis as RuntimeSignalGlobal;
	if (!globalWithSignals[runtimeSignalStoreKey]) {
		globalWithSignals[runtimeSignalStoreKey] = [];
	}
	return globalWithSignals[runtimeSignalStoreKey];
}

/**
 * Regression tests for authority-scoped queue handling after compaction.
 */
describe("AgentSession auto-compaction queue resume", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-auto-compaction-queue-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		vi.useFakeTimers();

		// Install the short-circuit extension directly. Loading a generated
		// TypeScript file here used to compile the same fixture for every test.
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_before_compact", async event => {
					getRuntimeSignals().push("before_compact:enter");
					const gate = (globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> })
						.__ompManualCompactGate;
					if (gate) await gate;
					return {
						compaction: {
							summary: "compacted",
							shortSummary: undefined,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
				pi.on("message_end", async event => {
					if (event.message.role !== "custom" || event.message.customType !== "peer-message") return;
					const gate = (globalThis as typeof globalThis & { __ompSemanticPersistenceGate?: Promise<void> })
						.__ompSemanticPersistenceGate;
					if (gate) await gate;
				});
				pi.on("auto_compaction_start", event => {
					getRuntimeSignals().push(`compaction:start:${event.reason}`);
				});
				pi.on("auto_compaction_end", event => {
					getRuntimeSignals().push(`compaction:end:${event.aborted ? "aborted" : "ok"}`);
				});
				pi.on("todo_reminder", event => {
					getRuntimeSignals().push(`todo:${event.attempt}/${event.maxAttempts}`);
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"compaction-short-circuit",
		);

		sessionManager = SessionManager.inMemory(tempDir.path());
		getRuntimeSignals().length = 0;

		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) {
			throw new Error("Expected built-in anthropic model to exist");
		}
		// Pin the window and output reservation: the threshold/usage math below is
		// tuned to a 200k/64k context-full budget and must stay stable across
		// catalog regenerations.
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		// Seed a minimal session branch so prepareCompaction() returns a preparation.
		sessionManager.appendMessage({
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": false,
				"todo.reminders": true,
				"todo.remindersMax": 3,
			}),
			modelRegistry,
			extensionRunner,
		});
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			try {
				vi.useRealTimers();
				await Bun.sleep(0);
			} finally {
				getRuntimeSignals().length = 0;
				(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
					undefined;
				(
					globalThis as typeof globalThis & { __ompSemanticPersistenceGate?: Promise<void> }
				).__ompSemanticPersistenceGate = undefined;
				vi.restoreAllMocks();
			}
		}
	});
	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("does not resume after threshold compaction for an unscoped custom message", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		expect(session.agent.hasQueuedMessages()).toBe(true);

		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue(undefined);

		const agentEndTerminalStates: Array<boolean | undefined> = [];
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "auto_compaction_end") onCompactionDone();
			if (event.type === "agent_end") agentEndTerminalStates.push(event.isTerminal);
		});

		// Build a fake AssistantMessage with high token usage to trigger threshold
		// compaction (contextWindow=200000, threshold ~80%).
		const assistantMsg = {
			role: "assistant" as const,
			// Non-empty content: an empty `stop` turn would trip the empty-stop guard
			// (#handleEmptyAssistantStop) and short-circuit the agent_end handler before
			// compaction/todo checks run — hanging this test forever under fake timers.
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		// Drive auto-compaction through the event flow:
		// message_end → stores #lastAssistantMessage
		// agent_end   → #checkCompaction → shouldCompact → #runAutoCompaction
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		// The custom message remains queued for the next explicit user turn.
		await compactionDone;
		await Promise.resolve();
		await session.waitForIdle();

		expect(continueSpy).not.toHaveBeenCalled();
		expect(session.agent.hasQueuedMessages()).toBe(true);
		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
		expect(agentEndTerminalStates).toEqual([true]);
		session.agent.clearAllQueues();
	});

	it("marks manual compaction active before abort teardown can yield", async () => {
		session.settings.set("compaction.keepRecentTokens", 1);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "user",
			content: "second turn",
			timestamp: Date.now(),
		});

		const abortEntered = Promise.withResolvers<void>();
		const releaseAbort = Promise.withResolvers<void>();
		let compactingDuringAbort: boolean | undefined;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			compactingDuringAbort = session.isCompacting;
			abortEntered.resolve();
			await releaseAbort.promise;
		});

		const compactPromise = session.compact();
		await abortEntered.promise;
		releaseAbort.resolve();
		await compactPromise;

		expect(compactingDuringAbort).toBe(true);
	});

	it("persists a scoped wake before manual compaction disconnects", async () => {
		vi.useRealTimers();
		session.settings.set("compaction.keepRecentTokens", 1);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		session.agent.streamFn = createMockModel({ handler: () => ({ content: ["Done"] }) }).stream;

		const countWakeEntries = () =>
			sessionManager
				.getBranch()
				.filter(
					entry =>
						entry.type === "custom_message" &&
						entry.customType === "peer-message" &&
						JSON.stringify(entry.content).includes("accepted before manual compaction"),
				).length;
		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;
		let callbackWakeEntries = -1;
		let compactPromise: Promise<unknown> | undefined;

		const sending = session.sendCustomMessage(
			{
				customType: "peer-message",
				content: "accepted before manual compaction",
				display: true,
				attribution: "agent",
			},
			{
				deliveryMode: "auto",
				automaticTurnSource: "peer_message_wake",
				onStartedTurnAccepted: () => {
					callbackWakeEntries = countWakeEntries();
					compactPromise = session.compact();
				},
			},
		);

		try {
			await expect(withTimeout(sending, 1000, "Scoped wake acceptance timed out")).resolves.toEqual({
				status: "accepted",
				delivery: "started_turn",
			});
			expect(callbackWakeEntries).toBe(0);
			while (!getRuntimeSignals().includes("before_compact:enter")) {
				await Promise.resolve();
			}
			expect(countWakeEntries()).toBe(1);
		} finally {
			gate.resolve();
			await compactPromise;
		}
	});

	it("abortCompaction cancels startup while semantic acceptance is pending", async () => {
		vi.useRealTimers();
		session.agent.streamFn = createMockModel({ handler: () => ({ content: ["Done"] }) }).stream;
		const persistenceGate = Promise.withResolvers<void>();
		(
			globalThis as typeof globalThis & { __ompSemanticPersistenceGate?: Promise<void> }
		).__ompSemanticPersistenceGate = persistenceGate.promise;
		let compactPromise: Promise<unknown> | undefined;
		const sending = session.sendCustomMessage(
			{
				customType: "peer-message",
				content: "hold acceptance during compact cancellation",
				display: true,
				attribution: "agent",
			},
			{
				deliveryMode: "auto",
				automaticTurnSource: "peer_message_wake",
				onStartedTurnAccepted: () => {
					compactPromise = session.compact();
					void compactPromise.catch(() => {});
					session.abortCompaction();
				},
			},
		);

		try {
			while (!compactPromise) await Bun.sleep(1);
			await expect(withTimeout(compactPromise, 1_000, "Compaction cancellation timed out")).rejects.toThrow(
				"Compaction cancelled",
			);
			expect(session.isCompacting).toBe(false);
			await expect(
				session.sendCustomMessage(
					{ customType: "probe", content: "after compact cancel", display: false, attribution: "agent" },
					{ deliveryMode: "steer" },
				),
			).resolves.toMatchObject({ status: "accepted" });
		} finally {
			persistenceGate.resolve();
			await sending;
			await session.waitForIdle();
		}
	});

	it("rejects scoped peer wake while manual compaction owns the semantic-delivery fence", async () => {
		session.settings.set("compaction.keepRecentTokens", 1);
		vi.useRealTimers();
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		session.agent.streamFn = mock.stream;
		const countWakeEntries = () =>
			sessionManager
				.getBranch()
				.filter(
					entry =>
						entry.type === "custom_message" &&
						entry.customType === "peer-message" &&
						JSON.stringify(entry.content).includes("must remain retryable during compaction"),
				).length;

		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;
		const compactPromise = session.compact();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}

		let committed = false;
		try {
			await expect(
				session.sendCustomMessage(
					{
						customType: "peer-message",
						content: "must remain retryable during compaction",
						display: true,
						attribution: "agent",
					},
					{
						deliveryMode: "auto",
						automaticTurnSource: "peer_message_wake",
						onStartedTurnAccepted: () => {
							committed = true;
						},
					},
				),
			).resolves.toEqual({ status: "unavailable", reason: "session_transition" });
			expect(committed).toBe(false);
			expect(mock.calls).toHaveLength(0);
			expect(countWakeEntries()).toBe(0);
		} finally {
			gate.resolve();
			await compactPromise;
		}

		expect(countWakeEntries()).toBe(0);
		await expect(
			session.sendCustomMessage(
				{
					customType: "peer-message",
					content: "must remain retryable during compaction",
					display: true,
					attribution: "agent",
				},
				{
					deliveryMode: "auto",
					automaticTurnSource: "peer_message_wake",
					onStartedTurnAccepted: () => {
						expect(JSON.stringify(session.agent.state.messages)).not.toContain(
							"must remain retryable during compaction",
						);
						expect(countWakeEntries()).toBe(0);
						committed = true;
					},
				},
			),
		).resolves.toEqual({ status: "accepted", delivery: "started_turn" });
		await session.waitForIdle();
		expect(committed).toBe(true);
		expect(countWakeEntries()).toBe(1);
		expect(mock.calls).toHaveLength(1);
	});

	it("resumes a message queued during manual compaction once it completes (#5800)", async () => {
		// Regression for #5800 review: manual /compact disconnects the agent
		// listener before `await abort()`, so the abort-finally stranded-message
		// drain is suppressed while disconnected. Unlike /new (which resets the
		// queue), compaction preserves the agent queues, so a steer/follow-up that
		// arrives mid-compaction (async IRC, an xd:// mount notice, an SDK steer)
		// would hang until the next explicit prompt unless compact() re-drains
		// after reconnecting.
		session.settings.set("compaction.keepRecentTokens", 1);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const continueSpy = vi
			.spyOn(session.agent, "continueQueuedMessageBlock")
			.mockImplementation(async (_queue, block) => {
				expect(block).toEqual([
					expect.objectContaining({
						role: "user",
						content: [{ type: "text", text: "please respond after compaction" }],
						attribution: "user",
					}),
				]);
				session.agent.clearAllQueues();
			});

		// Park compaction inside its awaited hook so we can queue a follow-up while
		// the session is disconnected and abort has already run its finally.
		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;

		const compactPromise = session.compact();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}

		// An agent-attributed IRC record arrives before the user's message. It must
		// stay parked while the attributed user owns the resumed direct turn.
		session.agent.steer({
			role: "user",
			content: "parent IRC must stay passive",
			attribution: "agent",
			steering: true,
			timestamp: Date.now(),
		});
		await session.sendUserMessage("please respond after compaction");
		expect(session.agent.hasQueuedMessages()).toBe(true);

		gate.resolve();
		await compactPromise;
		await session.waitForIdle();

		// compact()'s finally re-drained the stranded queue after reconnecting.
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(session.agent.peekSteeringQueue()).toEqual([
			expect.objectContaining({ content: "parent IRC must stay passive", attribution: "agent" }),
		]);
		expect(session.agent.peekFollowUpQueue()).toEqual([]);
		session.agent.clearAllQueues();
	});

	it.each([
		["delivery", "manual"],
		["text", "manual"],
		["removal", "manual"],
		["delivery", "automatic"],
		["now", "manual"],
		["now", "automatic"],
	] as const)(
		"waits to commit a session-backed queued prompt %s until %s compaction settles",
		async (mutation, compaction) => {
			session.settings.set("compaction.keepRecentTokens", 1);
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "previous answer" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 1_000,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

			const gate = Promise.withResolvers<void>();
			(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
				gate.promise;
			const compactPromise = compaction === "manual" ? session.compact() : session.runIdleCompaction();

			try {
				while (!getRuntimeSignals().includes("before_compact:enter")) {
					await Promise.resolve();
				}

				await session.sendUserMessage("queued during compaction");
				const queued = session.getQueuedPrompts()[0];
				if (!queued) throw new Error("Expected a session-backed queued prompt");
				const targetDelivery = queued.delivery === "steer" ? "afterCurrent" : "steer";
				if (mutation !== "now") session.agent.state.isStreaming = true;
				const continueSpy =
					mutation === "now"
						? vi.spyOn(session.agent, "continueQueuedMessageBlock").mockImplementation(async (queue, block) => {
								expect(queue).toBe("steering");
								expect(block).toEqual([
									expect.objectContaining({
										role: "user",
										content: [{ type: "text", text: "queued during compaction" }],
										attribution: "user",
									}),
								]);
								session.agent.clearAllQueues();
							})
						: undefined;

				let mutationSettled = false;
				const operation = (
					mutation === "now"
						? session.setQueuedPromptDelivery(queued.id, "interrupt")
						: mutation === "delivery"
							? session.setQueuedPromptDelivery(queued.id, targetDelivery)
							: mutation === "text"
								? session.updateQueuedPromptText(queued.id, "edited after compaction")
								: session.removeQueuedPrompt(queued.id)
				).finally(() => {
					mutationSettled = true;
				});
				await Promise.resolve();
				expect(mutationSettled).toBe(false);

				gate.resolve();
				await compactPromise;
				await expect(operation).resolves.toEqual({ status: "updated" });
				if (mutation === "now") await session.waitForIdle();

				const prompts = session.getQueuedPrompts();
				if (mutation === "now") {
					expect(continueSpy).toHaveBeenCalledTimes(1);
					expect(prompts).toEqual([]);
				} else if (mutation === "delivery") {
					expect(prompts[0]).toMatchObject({
						id: queued.id,
						text: "queued during compaction",
						delivery: targetDelivery,
					});
				} else if (mutation === "text") {
					expect(prompts[0]).toMatchObject({ id: queued.id, text: "edited after compaction" });
				} else {
					expect(prompts).toEqual([]);
				}
			} finally {
				gate.resolve();
				await compactPromise;
				session.agent.state.isStreaming = false;
				session.agent.clearAllQueues();
			}
		},
	);

	it("cancels an in-flight auto-compaction when manual compact startup aborts", async () => {
		// Give the branch something to summarize so auto-compaction reaches the
		// awaited session_before_compact hook, where the test parks it.
		session.settings.set("compaction.keepRecentTokens", 1);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });

		// Park the in-flight auto-compaction inside its awaited hook so
		// #autoCompactionAbortController stays installed across the manual /compact
		// startup abort below.
		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;

		const appendCompactionSpy = vi.spyOn(sessionManager, "appendCompaction");
		let autoAborted: boolean | undefined;
		const autoEnded = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") {
				autoAborted = event.aborted;
				autoEnded.resolve();
			}
		});

		const autoPromise = session.runIdleCompaction();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}

		// Manual /compact startup performs exactly this internal abort while holding
		// its own freshly installed #compactionAbortController. The auto signal is
		// raised synchronously (before abort's first await), then the gate releases
		// the parked pass so it observes the abort and unwinds.
		const abortPromise = session.abort({ goalReason: "internal", preserveCompaction: true });
		gate.resolve();
		await abortPromise;
		await autoPromise;
		await autoEnded.promise;

		// The in-flight auto pass MUST be cancelled so it cannot race the manual run
		// and double-rewrite session history.
		expect(autoAborted).toBe(true);
		expect(appendCompactionSpy).not.toHaveBeenCalled();
	});

	it("runs threshold compaction for active goal turns that end with yield", async () => {
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-threshold",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});

		const yieldCall = {
			type: "toolCall" as const,
			id: "call_goal_yield",
			name: "yield",
			arguments: { status: "progress" },
		};
		const assistantMsg = {
			role: "assistant" as const,
			content: [yieldCall],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "toolUse" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			isError: false,
			result: {
				content: [{ type: "text" as const, text: "Yielded." }],
				details: { status: "success" },
			},
		});
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
	});

	it("runs active-goal threshold compaction after yield followed by a trailing empty stop", async () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});

		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-yield-empty-stop-threshold",
				objective: "continue after compacting",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});

		const yieldCall = {
			type: "toolCall" as const,
			id: "call_goal_yield_then_empty",
			name: "yield",
			arguments: { status: "progress" },
		};
		const yieldMsg = {
			role: "assistant" as const,
			content: [yieldCall],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "toolUse" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};
		const trailingEmptyStop = {
			role: "assistant" as const,
			content: [],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 191000,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191001,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now + 1,
		};

		session.agent.emitExternalEvent({ type: "message_end", message: yieldMsg });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			isError: false,
			result: {
				content: [{ type: "text" as const, text: "Yielded." }],
				details: { status: "success" },
			},
		});
		session.agent.emitExternalEvent({ type: "message_end", message: trailingEmptyStop });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [yieldMsg, trailingEmptyStop] });

		await session.waitForIdle();

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
		expect(
			debugSpy.mock.calls.some(([message, context]) => {
				if (message !== "agent_end maintenance routing") return false;
				if (context?.route !== "post-yield-trailing-stop-active-goal-checkCompaction") return false;
				return context.successfulYield === true;
			}),
		).toBe(true);
	});

	it("triggers threshold compaction in active goals even when per-turn pruning shaves the post-prune estimate below threshold", async () => {
		// Regression for #3174. Goal mode is the most common scenario: the agent
		// runs many tool-result-heavy turns and the per-turn "useless" /
		// "supersede" passes shave tokens off every check. Pre-fix
		// `#checkCompaction` subtracted those savings from the threshold input, so
		// with the reporter's fixed `compaction.thresholdTokens: 76384`, the
		// threshold input fell below the trigger even when the provider-billed
		// prompt (and the visible context anchored to it) sat above 90k tokens —
		// auto-compaction silently no-op'd indefinitely while the loop kept
		// running.
		//
		// This seeds one large `useless` tool result whose suffix sits inside the
		// 8k cache-warm window so `#pruneStaleToolResults` actually returns ≥20k
		// savings (well above the buggy code's mis-subtraction needed to drop
		// 91000 below 76384). Compaction MUST still fire because the last turn's
		// billed context tokens (91k) are above the configured threshold.
		const now = Date.now();

		// Seed: small user, small toolCall, ONE big useless tool result, then a
		// handful of small turns that keep the suffix after the big result under
		// the 8000-token cache-warm cutoff. The big result is the only viable
		// prune candidate, and it alone saves well over 20k tokens — enough to
		// drag the pre-fix threshold input from 91k well below 76384.
		sessionManager.appendMessage({
			role: "user",
			content: "Investigate every module of the project.",
			timestamp: now - 200,
		});
		const bigCallId = "call-big-useless";
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: bigCallId, name: "grep", arguments: { pattern: "TODO" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now - 180,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: bigCallId,
			toolName: "grep",
			content: [{ type: "text", text: "match line\n".repeat(20000) }], // ~40k+ tokens
			isError: false,
			useless: true,
			timestamp: now - 170,
		});
		// A few small follow-up turns so the big result's suffix stays inside the
		// 8000-token cache-warm window. Each pair is well under a hundred tokens.
		for (let i = 0; i < 4; i++) {
			const smallId = `call-small-${i}`;
			const ts = now - 160 + i * 2;
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: smallId, name: "read", arguments: { path: `note-${i}.md` } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: ts,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: smallId,
				toolName: "read",
				content: [{ type: "text", text: `tiny note ${i}` }],
				isError: false,
				timestamp: ts + 1,
			});
		}
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-threshold-pruneable",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});

		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		session.settings.set("compaction.thresholdTokens", 76384);
		session.settings.set("compaction.thresholdPercent", -1);
		session.settings.set("compaction.methodOrder", ["soft"]);
		session.settings.set("compaction.dropUseless", true);
		session.settings.set("compaction.supersedeReads", true);
		session.settings.set("compaction.keepRecentTokens", 10000);
		session.settings.set("compaction.reserveTokens", 16384);

		// Final assistant turn: billed at ~91k context tokens, just over the
		// reporter's threshold. The pre-fix code would have subtracted ≥20k of
		// prune savings and dropped the threshold input below 76384, skipping
		// compaction. Post-fix it must trigger.
		const finalAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Investigated module-7; continuing." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 5000,
				output: 1000,
				cacheRead: 85000,
				cacheWrite: 0,
				totalTokens: 91000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};

		session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });

		await session.waitForIdle();

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
	});
	it("runs active-goal threshold compaction before unexpected-stop retry continuation", async () => {
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-unexpected-stop-threshold",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		session.settings.set("compaction.thresholdTokens", 76384);
		session.settings.set("compaction.thresholdPercent", -1);
		session.settings.set("compaction.autoContinue", true);
		session.settings.set("contextPromotion.enabled", false);
		session.settings.set("features.unexpectedStopDetection", "smart");
		session.settings.set("providers.unexpectedStopModel", "online");

		vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "I should continue investigating another module." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 5000,
				output: 1000,
				cacheRead: 85000,
				cacheWrite: 0,
				totalTokens: 91000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
	});

	it("resolves a pending retry before active-goal compaction continuation returns", async () => {
		// Codex review on #3175: a retry can succeed with a non-empty text stop
		// that is already over the active-goal compaction threshold. If the
		// compaction pre-empt schedules its own continuation before the normal
		// bottom-of-handler `#resolveRetry()` call runs, the session stays
		// `isRetrying` and later prompt/idle gates remain blocked.
		vi.useRealTimers();
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-retry-threshold",
				objective: "recover from retry and compact",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		session.settings.set("compaction.thresholdTokens", 76384);
		session.settings.set("compaction.thresholdPercent", -1);
		session.settings.set("compaction.autoContinue", true);
		session.settings.set("contextPromotion.enabled", false);
		session.settings.set("retry.enabled", true);
		session.settings.set("retry.baseDelayMs", 5);
		session.settings.set("retry.maxDelayMs", 5_000);
		session.settings.set("retry.maxRetries", 1);
		session.settings.set("retry.modelFallback", false);

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const { promise: retryStarted, resolve: onRetryStarted } = Promise.withResolvers<void>();
		const { promise: retryEnded, resolve: onRetryEnded } = Promise.withResolvers<void>();
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_retry_start") onRetryStarted();
			if (event.type === "auto_retry_end") onRetryEnded();
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const retryableError = {
			role: "assistant" as const,
			// Thinking-only partial: a committed visible text block would classify the
			// failed turn as replay-unsafe and suppress the retry this test depends on.
			content: [{ type: "thinking" as const, thinking: "Transient provider failure." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "error" as const,
			errorMessage: "503 service unavailable: overloaded_error retry-after-ms=50",
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now - 1,
		};
		session.agent.emitExternalEvent({ type: "message_end", message: retryableError });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [retryableError] });

		await withTimeout(retryStarted, 1000, "Retry start timed out");
		expect(session.isRetrying).toBe(true);

		const recoveredOverThreshold = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Recovered; continuing the active goal." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 5000,
				output: 1000,
				cacheRead: 85000,
				cacheWrite: 0,
				totalTokens: 91000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};
		session.agent.emitExternalEvent({ type: "message_end", message: recoveredOverThreshold });
		await withTimeout(retryEnded, 1000, "Retry end timed out");
		expect(session.isRetrying).toBe(true);

		session.agent.emitExternalEvent({ type: "agent_end", messages: [recoveredOverThreshold] });

		await withTimeout(compactionDone, 1000, "Compaction end timed out");
		await session.waitForIdle();

		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
		expect(session.isRetrying).toBe(false);
	});

	it("removes orphan toolUse assistant before active-goal threshold compaction continuation", async () => {
		// Codex review on #3175: when an active goal turn is over threshold AND
		// stops with an empty `toolUse` (no tool call), the new ordering must NOT
		// skip `#handleEmptyAssistantStop` — that handler is the only path that
		// strips the orphan assistant from active context + session history. If a
		// compaction continuation runs with the orphan still in place, the next
		// Anthropic turn carries a `tool_use` block with no matching
		// `tool_result` and corrupts the message history.
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-orphan-toolUse-threshold",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		session.settings.set("compaction.thresholdTokens", 76384);
		session.settings.set("compaction.thresholdPercent", -1);
		session.settings.set("compaction.autoContinue", true);
		session.settings.set("contextPromotion.enabled", false);

		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const orphanToolUse = {
			role: "assistant" as const,
			// Empty toolUse stop: stopReason says a tool was requested but the
			// content block is empty (no toolCall). This is the case the empty-stop
			// cleanup defends against.
			content: [] as never[],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "toolUse" as const,
			usage: {
				input: 5000,
				output: 1000,
				cacheRead: 85000,
				cacheWrite: 0,
				totalTokens: 91000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};
		session.agent.emitExternalEvent({ type: "message_end", message: orphanToolUse });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [orphanToolUse] });

		await session.waitForIdle();

		// Empty-stop cleanup short-circuits before any compaction continuation, so
		// the threshold compaction MUST NOT fire on this turn — the next turn
		// starts from the cleaned-up branch with the retry-reminder developer
		// message instead. The pre-fix ordering let compaction reach
		// `auto_compaction_start` first, scheduling a continuation while the
		// orphan `toolUse` entry was still the session leaf.
		const signals = getRuntimeSignals();
		expect(signals).not.toContain("compaction:start:threshold");

		// `#removeEmptyStopFromActiveContext` rewinds the session leaf past the
		// orphan via `sessionManager.branch(parentId)` / `resetLeaf()`. If the
		// cleanup is skipped, the orphan is still the leaf when the compaction
		// continuation runs and the next Anthropic turn sends a `tool_use` block
		// with no matching `tool_result`.
		const branch = sessionManager.getBranch();
		const orphanInBranch = branch.some(entry => {
			if (entry.type !== "message") return false;
			const message = entry.message as { role: string; stopReason?: string };
			return message.role === "assistant" && message.stopReason === "toolUse";
		});
		expect(orphanInBranch).toBe(false);
	});

	it("has isCompacting true when the auto_compaction_start event fires", async () => {
		// Defect 1: the compaction AbortController (which backs isCompacting) must be
		// installed before auto_compaction_start is emitted. If it is installed after,
		// a message typed the instant the loader appears is read while
		// isCompacting === false and mis-routed into the core steering queue (which a
		// later handoff reset would wipe) instead of the safe UI compaction queue.
		let capturedIsCompacting: boolean | undefined;
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") {
				capturedIsCompacting = session.isCompacting;
			} else if (event.type === "auto_compaction_end") {
				onCompactionDone();
			}
		});

		// Defensive: mirror the resume-drain stub so any queued continuation settles
		// instead of spinning the drain (see the threshold test above).
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;

		expect(capturedIsCompacting).toBe(true);
	});

	it("does not emit todo reminder lifecycle signals or continue automatically", async () => {
		vi.spyOn(session, "getActiveToolNames").mockReturnValue(["todo"]);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		session.setTodoPhases([
			{
				name: "Execution",
				tasks: [{ content: "Finish pending task", status: "in_progress" }],
			},
		]);

		const { promise: agentEnd, resolve: onAgentEnd } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "agent_end") onAgentEnd();
		});

		const assistantMsg = {
			role: "assistant" as const,
			// Non-empty content: see comment on the first test's assistantMsg.
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await withTimeout(agentEnd, 1000, "Agent end timed out");
		await Promise.resolve();

		expect(getRuntimeSignals().some(signal => signal.startsWith("todo:"))).toBe(false);
		expect(continueSpy).not.toHaveBeenCalled();
		await session.waitForIdle();
	});
});
