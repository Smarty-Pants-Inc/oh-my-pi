/**
 * Tests for AgentSession concurrent prompt guard.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, AgentBusyError, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, ToolCall } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { wrapRegisteredTools } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	convertToLlm,
	readPendingSemanticDeliveryId,
	USER_INTERRUPT_LABEL,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

// Mock stream that mimics AssistantMessageEventStream

// AgentSession schedules its TTSR retry and context-promotion continuations
// through `scheduler.wait(delayMs, { signal })` (node:timers/promises), with
// blind 50ms/100ms "settle" delays. Tests that drive a continuation to
// completion would otherwise pay that wall-clock time on every run. This spy
// collapses the blind delay to a single macrotask hop (`scheduler.wait(0)`)
// while preserving the real abort-signal semantics, so the continuation still
// fires only after the aborted/overflowed turn has been recorded. Each test
// that opts in must run inside a block whose afterEach restores mocks.
const originalSchedulerWait = scheduler.wait.bind(scheduler);
function collapseSchedulerSettleDelays(): void {
	vi.spyOn(scheduler, "wait").mockImplementation((_delayMs, options) => originalSchedulerWait(0, options));
}
let sharedDir: string;
let sharedAuthStorage: AuthStorage;
let sharedModelRegistry: ModelRegistry;

beforeAll(async () => {
	sharedDir = path.join(os.tmpdir(), `pi-concurrent-shared-${Snowflake.next()}`);
	fs.mkdirSync(sharedDir, { recursive: true });
	sharedAuthStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
	sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
	sharedAuthStorage.setRuntimeApiKey("openai-codex", "test-key");
	sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir, "models.yml"));
});

afterAll(() => {
	sharedAuthStorage.close();
	removeSyncWithRetries(sharedDir);
});

describe("AgentSession concurrent prompt guard", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		// Collapse scheduler settle delays so the post-abort auto-continue and
		// dispose teardown are deterministic instead of racing the wall clock.
		collapseSchedulerSettleDelays();
		tempDir = path.join(os.tmpdir(), `pi-concurrent-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	async function createSession(settingsOverrides?: Partial<Record<SettingPath, unknown>>) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let abortSignal: AbortSignal | undefined;

		// Use a stream function that responds to abort
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (abortSignal) {
						abortSignal.addEventListener(
							"abort",
							() => {
								stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
							},
							{ once: true },
						);
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated(settingsOverrides);
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		return session;
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(1);
		}

		throw new Error("Timed out waiting for condition");
	}

	it("chooses semantic delivery against the state used for the queue mutation", async () => {
		await createSession();
		session.setCustomMessageAcceptanceHookForTests(() => {
			session.agent.state.isStreaming = true;
		});
		await expect(
			session.sendCustomMessage(
				{ customType: "idle-to-busy", content: "after current", display: false, attribution: "agent" },
				{ deliveryMode: "afterCurrent" },
			),
		).resolves.toEqual({ status: "accepted", delivery: "queued_follow_up" });
		expect(session.agent.peekFollowUpQueue()).toHaveLength(1);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);

		session.agent.clearAllQueues();
		session.setCustomMessageAcceptanceHookForTests(() => {
			session.agent.state.isStreaming = false;
		});
		await expect(
			session.sendCustomMessage(
				{ customType: "busy-to-idle", content: "idle steer", display: false, attribution: "agent" },
				{ deliveryMode: "steer" },
			),
		).resolves.toEqual({ status: "accepted", delivery: "plain_append" });
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
		expect(session.agent.state.messages.at(-1)).toMatchObject({ customType: "busy-to-idle" });
		session.setCustomMessageAcceptanceHookForTests(undefined);
	});
	it("reserves explicitPrompt delivery for the next explicit user prompt", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});

		await expect(
			session.sendCustomMessage(
				{ customType: "mail-status", content: "durable status", display: true, attribution: "agent" },
				{ deliveryMode: "explicitPrompt" },
			),
		).resolves.toEqual({ status: "accepted", delivery: "queued_next_turn" });
		expect(mock.calls).toHaveLength(0);
		expect(session.agent.state.messages).toHaveLength(0);

		await expect(
			session.sendCustomMessage(
				{ customType: "urgent-blocker", content: "urgent blocker", display: true, attribution: "agent" },
				{ deliveryMode: "interrupt" },
			),
		).resolves.toEqual({ status: "downgraded", delivery: "plain_append", reason: "unscoped_automatic_turn" });
		expect(mock.calls).toHaveLength(0);

		await session.prompt("next explicit user prompt");
		expect(mock.calls).toHaveLength(1);
		expect(JSON.stringify(mock.calls[0]?.context.messages)).toContain("urgent blocker");
		expect(JSON.stringify(mock.calls[0]?.context.messages)).toContain("durable status");
	});
	it("starts one idle provider turn for scoped peer semantic delivery", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});

		await expect(
			session.sendCustomMessage(
				{ customType: "peer-message", content: "wake once", display: true, attribution: "agent" },
				{
					deliveryMode: "auto",
					automaticTurnSource: "peer_message_wake",
					onStartedTurnAccepted: () => {
						expect(agent.state.messages).toHaveLength(0);
						expect(sessionManager.getBranch()).toHaveLength(0);
					},
				},
			),
		).resolves.toEqual({ status: "accepted", delivery: "started_turn" });
		await waitFor(() => mock.calls.length === 1);
		expect(mock.calls).toHaveLength(1);
		expect(JSON.stringify(mock.calls[0]?.context.messages)).toContain("wake once");
		expect(session.getAutomaticTurnOutcomes()).toEqual([
			expect.objectContaining({ source: "peer_message_wake", status: "accepted" }),
			expect.objectContaining({ source: "peer_message_wake", status: "started" }),
		]);
	});

	it("rejects scoped peer wake when the persistence listener disconnects before agent_start", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});
		let committed = false;
		session.setCustomMessageAcceptanceHookForTests(() => session.setAgentEventConnectionForTests(false));

		await expect(
			session.sendCustomMessage(
				{ customType: "peer-message", content: "wake through disconnect", display: true, attribution: "agent" },
				{
					deliveryMode: "auto",
					automaticTurnSource: "peer_message_wake",
					onStartedTurnAccepted: () => {
						committed = true;
					},
				},
			),
		).rejects.toThrow("Scoped automatic turn lost its session persistence listener");
		expect(committed).toBe(false);
		expect(JSON.stringify(sessionManager.getBranch())).not.toContain("wake through disconnect");
		expect(JSON.stringify(agent.state.messages)).not.toContain("wake through disconnect");
		expect(session.getAutomaticTurnOutcomes()).toEqual([
			expect.objectContaining({ source: "peer_message_wake", status: "accepted" }),
			expect.objectContaining({ source: "peer_message_wake", status: "failed" }),
		]);
		session.setCustomMessageAcceptanceHookForTests(undefined);
		await session.setAgentEventConnectionForTests(true);
	});

	it("rejects reentrant extension compaction throughout scoped semantic acceptance", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const compactErrors: string[] = [];
		let current: AgentSession;
		let handlerActive = false;
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "message_end"),
			isHandlingEvent: () => handlerActive,
			emitBeforeAgentStart: vi.fn(async () => {
				try {
					await current.compact();
				} catch (error) {
					compactErrors.push(error instanceof Error ? error.message : String(error));
				}
				return undefined;
			}),
			emit: vi.fn(async (event: { type: string; message?: AgentMessage }) => {
				if (event.type !== "message_end" || event.message?.role !== "custom") return;
				handlerActive = true;
				try {
					await current.compact();
				} catch (error) {
					compactErrors.push(error instanceof Error ? error.message : String(error));
				} finally {
					handlerActive = false;
				}
			}),
		} as unknown as ExtensionRunner;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ handler: () => ({ content: ["Done"] }) }).stream,
			convertToLlm,
		});
		current = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
			extensionRunner,
		});
		session = current;

		await expect(
			session.sendCustomMessage(
				{ customType: "peer-message", content: "wake without compaction", display: true, attribution: "agent" },
				{
					deliveryMode: "auto",
					automaticTurnSource: "peer_message_wake",
					onStartedTurnAccepted: () => {},
				},
			),
		).resolves.toEqual({ status: "accepted", delivery: "started_turn" });
		expect(compactErrors).toEqual([
			"Compaction is unavailable while a peer-message wake awaits provider response acceptance",
			"Compaction is unavailable while semantic message delivery is being accepted",
		]);
	});

	it("rejects reentrant scoped idle peer wakes from extension event handlers", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		let disposition: unknown;
		const completed = Promise.withResolvers<void>();
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("message_end", async event => {
					if (event.message.role !== "custom" || event.message.customType !== "reentrant-trigger") return;
					disposition = await pi.sendMessage(
						{
							customType: "peer-message",
							content: "must not start reentrantly",
							display: true,
							attribution: "agent",
						},
						{ deliveryMode: "auto", automaticTurnSource: "peer_message_wake" },
					);
					completed.resolve();
				});
			},
			tempDir,
			new EventBus(),
			extensionRuntime,
			"reentrant-peer-wake",
		);
		const sessionManager = SessionManager.inMemory();
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir,
			sessionManager,
			sharedModelRegistry,
		);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
			extensionRunner,
		});
		const reportSendError = vi.fn();
		const reportRuntimeError = vi.fn();
		await initializeExtensions(session, { reportSendError, reportRuntimeError });

		const trigger: AgentMessage = {
			role: "custom",
			customType: "reentrant-trigger",
			content: "trigger",
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		agent.emitExternalEvent({ type: "message_start", message: trigger });
		agent.emitExternalEvent({ type: "message_end", message: trigger });
		await Promise.race([
			completed.promise,
			Bun.sleep(500).then(() => {
				throw new Error("Reentrant peer wake did not settle");
			}),
		]);

		expect(disposition).toEqual({ status: "unavailable", reason: "reentrant_extension_handler" });
		expect(mock.calls).toHaveLength(0);
		expect(JSON.stringify(agent.state.messages)).not.toContain("must not start reentrantly");
		expect(JSON.stringify(sessionManager.getBranch())).not.toContain("must not start reentrantly");
		expect(reportSendError).not.toHaveBeenCalled();
		expect(reportRuntimeError).not.toHaveBeenCalled();
	});

	it("settles scoped peer wake acceptance before a session mutation fence retires extensions", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const beforeStartEntered = Promise.withResolvers<void>();
		const releaseBeforeStart = Promise.withResolvers<void>();
		const order: string[] = [];
		const sessionManager = SessionManager.inMemory();
		const extensionRunner = {
			hasHandlers: vi.fn(() => false),
			emitBeforeAgentStart: vi.fn(async () => {
				beforeStartEntered.resolve();
				await releaseBeforeStart.promise;
				return undefined;
			}),
			emitBeforeSessionMutation: vi.fn(async () => {
				expect(JSON.stringify(sessionManager.getBranch())).toContain("commit before mutation");
				order.push("fence");
			}),
			emit: vi.fn().mockResolvedValue(undefined),
			emitWithHostCompletion: vi.fn(async (_event: { type: string }, completion?: () => void | Promise<void>) =>
				completion?.(),
			),
		} as unknown as ExtensionRunner;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ handler: () => ({ content: ["Done"] }) }).stream,
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
			extensionRunner,
		});

		const sending = session.sendCustomMessage(
			{ customType: "peer-message", content: "commit before mutation", display: true, attribution: "agent" },
			{
				deliveryMode: "auto",
				automaticTurnSource: "peer_message_wake",
				onStartedTurnAccepted: () => order.push("commit"),
			},
		);
		await beforeStartEntered.promise;
		const switching = session.newSession();
		await Promise.resolve();
		expect(extensionRunner.emitBeforeSessionMutation).not.toHaveBeenCalled();

		releaseBeforeStart.resolve();
		await expect(sending).resolves.toEqual({ status: "accepted", delivery: "started_turn" });
		await expect(switching).resolves.toBe(true);
		expect(order).toEqual(["commit", "fence"]);
	});

	it("does not accept a scoped peer wake when agent prompt fails before agent_start", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ handler: () => ({ content: ["Done"] }) }).stream,
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});
		const failure = new Error("provider start failed");
		vi.spyOn(agent, "prompt").mockRejectedValueOnce(failure);
		let committed = false;

		await expect(
			session.sendCustomMessage(
				{ customType: "peer-message", content: "must stay retryable", display: true, attribution: "agent" },
				{
					deliveryMode: "auto",
					automaticTurnSource: "peer_message_wake",
					onStartedTurnAccepted: () => {
						committed = true;
					},
				},
			),
		).rejects.toThrow(failure);
		expect(committed).toBe(false);
		expect(session.getAutomaticTurnOutcomes()).toEqual([
			expect.objectContaining({ source: "peer_message_wake", status: "accepted" }),
			expect.objectContaining({ source: "peer_message_wake", status: "failed" }),
		]);
	});

	it("keeps a scoped peer wake retryable when the pre-model gate stops before provider dispatch", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		agent.setBeforeModelCall(() => ({ stop: true, reason: "test gate" }));
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});
		let committed = false;
		const queuedSteer = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "queued steer must survive" }],
			steering: true,
			attribution: "user" as const,
			timestamp: Date.now(),
		};
		agent.steer(queuedSteer);

		await expect(
			session.sendCustomMessage(
				{ customType: "peer-message", content: "must remain new", display: true, attribution: "agent" },
				{
					deliveryMode: "auto",
					automaticTurnSource: "peer_message_wake",
					onStartedTurnAccepted: () => {
						committed = true;
					},
				},
			),
		).resolves.toEqual({ status: "unavailable", reason: "prompt_preflight_cancelled" });
		await session.waitForIdle();
		expect(committed).toBe(false);
		expect(mock.calls).toHaveLength(0);
		expect(agent.state.messages).toEqual([queuedSteer]);
		expect(JSON.stringify(sessionManager.getBranch())).toContain("queued steer must survive");
		expect(JSON.stringify(sessionManager.getBranch())).not.toContain("must remain new");
		expect(agent.peekSteeringQueue()).toHaveLength(0);
		expect(session.getAutomaticTurnOutcomes()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: "peer_message_wake", status: "accepted" }),
				expect.objectContaining({ source: "peer_message_wake", status: "failed" }),
			]),
		);
	});

	it("defers a late explicit-prompt message after the provisional queue batch is folded", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses: [{ content: ["first"] }, { content: ["second"] }] });
		const gateEntered = Promise.withResolvers<void>();
		const releaseGate = Promise.withResolvers<void>();
		let gateCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		agent.setBeforeModelCall(async () => {
			if (gateCalls++ !== 0) return;
			gateEntered.resolve();
			await releaseGate.promise;
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});
		agent.steer({
			role: "user",
			content: "direct user steer",
			steering: true,
			attribution: "user",
			timestamp: Date.now(),
		});

		const wake = session.sendCustomMessage(
			{ customType: "peer-message", content: "wake first", display: true, attribution: "agent" },
			{ deliveryMode: "auto", automaticTurnSource: "peer_message_wake", onStartedTurnAccepted: () => {} },
		);
		await gateEntered.promise;
		await expect(
			session.sendCustomMessage(
				{ customType: "peer-message", content: "late explicit", display: true, attribution: "agent" },
				{ deliveryMode: "explicitPrompt" },
			),
		).resolves.toEqual({ status: "accepted", delivery: "queued_next_turn" });

		releaseGate.resolve();
		await expect(wake).resolves.toEqual({ status: "accepted", delivery: "started_turn" });
		await session.waitForIdle();
		const firstContext = JSON.stringify(mock.calls[0]?.context.messages);
		expect(firstContext).toContain("direct user steer");
		expect(firstContext).not.toContain("late explicit");

		await session.prompt("next explicit user prompt");
		const secondContext = JSON.stringify(mock.calls[1]?.context.messages);
		expect(secondContext).toContain("next explicit user prompt");
		expect(secondContext.match(/late explicit/g) ?? []).toHaveLength(1);
	});

	it("rejects unknown automatic-turn sources before idle or busy routing", async () => {
		await createSession();

		for (const [busy, source] of [
			[false, "direct_user_input"],
			[true, "unknown_source"],
		] as const) {
			session.agent.state.isStreaming = busy;
			await expect(
				session.sendCustomMessage(
					{ customType: "peer-message", content: source, display: true, attribution: "agent" },
					{
						deliveryMode: "auto",
						automaticTurnSource: source as "peer_message_wake",
						onStartedTurnAccepted: () => {},
					},
				),
			).rejects.toThrow('automaticTurnSource must be "peer_message_wake"');
		}

		expect(session.agent.state.messages).toHaveLength(0);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
		expect(session.agent.peekFollowUpQueue()).toHaveLength(0);
	});

	it("keeps a scoped peer wake retryable when provider stream creation fails", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const failure = new Error("stream init failed");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: async () => {
				await Promise.resolve();
				throw failure;
			},
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});
		let committed = false;

		await expect(
			session.sendCustomMessage(
				{ customType: "peer-message", content: "retry after stream failure", display: true, attribution: "agent" },
				{
					deliveryMode: "auto",
					automaticTurnSource: "peer_message_wake",
					onStartedTurnAccepted: () => {
						committed = true;
					},
				},
			),
		).resolves.toEqual({ status: "unavailable", reason: "prompt_preflight_cancelled" });
		expect(committed).toBe(false);
		expect(agent.state.messages).toHaveLength(0);
		expect(sessionManager.getBranch()).toHaveLength(0);
		expect(session.getAutomaticTurnOutcomes()).toEqual([
			expect.objectContaining({ source: "peer_message_wake", status: "accepted" }),
			expect.objectContaining({ source: "peer_message_wake", status: "failed" }),
		]);
	});

	it("keeps a scoped peer wake retryable when a provider start event precedes wire failure", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const failure = createAssistantMessage("");
					failure.stopReason = "error";
					failure.errorMessage = "provider failed before response";
					stream.push({ type: "error", reason: "error", error: failure });
				});
				return stream;
			},
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});
		const lifecycleEvents: string[] = [];
		session.subscribe(event => {
			if (
				event.type === "turn_start" ||
				event.type === "message_start" ||
				event.type === "message_end" ||
				event.type === "turn_end" ||
				event.type === "agent_end"
			) {
				lifecycleEvents.push(event.type);
			}
		});
		let committed = false;

		await expect(
			session.sendCustomMessage(
				{ customType: "peer-message", content: "retry after wire failure", display: true, attribution: "agent" },
				{
					deliveryMode: "auto",
					automaticTurnSource: "peer_message_wake",
					onStartedTurnAccepted: () => {
						committed = true;
					},
				},
			),
		).resolves.toEqual({ status: "unavailable", reason: "prompt_preflight_cancelled" });
		expect(committed).toBe(false);
		expect(agent.state.messages).toHaveLength(0);
		expect(sessionManager.getBranch()).toHaveLength(0);
		await waitFor(() => lifecycleEvents.length === 1);
		expect(lifecycleEvents).toEqual(["agent_end"]);
	});

	it("keeps a scoped peer wake retryable when acceptance commit fails", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let requestSignal: AbortSignal | undefined;
		const failure = new Error("mailbox commit failed");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				requestSignal = options?.signal;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial = createAssistantMessage("");
					stream.push({ type: "start", partial });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "started", partial });
				});
				return stream;
			},
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});

		await expect(
			session.sendCustomMessage(
				{ customType: "peer-message", content: "retry after commit failure", display: true, attribution: "agent" },
				{
					deliveryMode: "auto",
					automaticTurnSource: "peer_message_wake",
					onStartedTurnAccepted: () => {
						throw failure;
					},
				},
			),
		).rejects.toThrow(failure);
		expect(requestSignal?.aborted).toBe(true);
		expect(agent.state.messages).toHaveLength(0);
		expect(sessionManager.getBranch()).toHaveLength(0);
		expect(session.getAutomaticTurnOutcomes()).toEqual([
			expect.objectContaining({ source: "peer_message_wake", status: "accepted" }),
			expect.objectContaining({ source: "peer_message_wake", status: "failed" }),
		]);
	});

	it("attaches busy explicitPrompt delivery to the queued user follow-up", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let firstStream: AssistantMessageEventStream | undefined;
		const callMessages: Message[][] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				callMessages.push([...context.messages]);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (callMessages.length > 1)
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				if (callMessages.length === 1) firstStream = stream;
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});
		const firstPrompt = session.prompt("active turn");
		await waitFor(() => session.isStreaming && firstStream !== undefined && callMessages.length === 1);

		await expect(
			session.sendCustomMessage(
				{ customType: "mail-status", content: "busy durable status", display: true, attribution: "agent" },
				{ deliveryMode: "explicitPrompt" },
			),
		).resolves.toEqual({ status: "accepted", delivery: "queued_next_turn" });
		await session.prompt("normal after_current composition", { streamingBehavior: "followUp" });
		expect(callMessages).toHaveLength(1);

		firstStream?.push({ type: "done", reason: "stop", message: createAssistantMessage("First done") });
		await firstPrompt;
		await session.waitForIdle();

		expect(callMessages).toHaveLength(2);
		const providerTurn = JSON.stringify(callMessages[1]);
		expect(providerTurn).toContain("normal after_current composition");
		expect(providerTurn).toContain("busy durable status");
	});
	it("keeps explicitPrompt companions with one-at-a-time steering", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let firstStream: AssistantMessageEventStream | undefined;
		const callMessages: Message[][] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				callMessages.push([...context.messages]);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (callMessages.length > 1)
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				if (callMessages.length === 1) firstStream = stream;
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});
		const active = session.prompt("active turn");
		await waitFor(() => session.isStreaming && firstStream !== undefined);
		await session.sendCustomMessage(
			{ customType: "mail-status", content: "steer durable status", display: true, attribution: "agent" },
			{ deliveryMode: "explicitPrompt" },
		);
		await session.prompt("deliberate steering prompt", { streamingBehavior: "steer" });
		firstStream?.push({ type: "done", reason: "stop", message: createAssistantMessage("First done") });
		await active;
		await session.waitForIdle();
		const providerTurn = JSON.stringify(callMessages[1]);
		expect(providerTurn).toContain("deliberate steering prompt");
		expect(providerTurn).toContain("steer durable status");
	});

	it("restores explicitPrompt companions when their queued user prompt is cleared", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let firstStream: AssistantMessageEventStream | undefined;
		const callMessages: Message[][] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				callMessages.push([...context.messages]);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (callMessages.length > 1)
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				if (callMessages.length === 1) firstStream = stream;
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});
		const active = session.prompt("active turn");
		await waitFor(() => session.isStreaming && firstStream !== undefined);
		await session.sendCustomMessage(
			{ customType: "mail-status", content: "restorable durable status", display: true, attribution: "agent" },
			{ deliveryMode: "explicitPrompt" },
		);
		await session.prompt("discarded queued prompt", { streamingBehavior: "followUp" });
		session.clearQueue({ forInterrupt: true });
		expect(session.agent.peekFollowUpQueue()).toHaveLength(0);
		firstStream?.push({ type: "done", reason: "stop", message: createAssistantMessage("First done") });
		await active;
		await session.prompt("replacement explicit prompt");
		const providerTurn = JSON.stringify(callMessages[1]);
		expect(providerTurn).toContain("replacement explicit prompt");
		expect(providerTurn).toContain("restorable durable status");
		expect(providerTurn).not.toContain("discarded queued prompt");
	});
	it("rejects semantic delivery during and after a lifecycle ownership change", async () => {
		await createSession();
		const before = session.agent.state.messages.length;
		for (const releaseFenceBeforeAcceptance of [false, true]) {
			session.setCustomMessageAcceptanceHookForTests(() => {
				session.setLifecycleTransitionFenceForTests(true);
				if (releaseFenceBeforeAcceptance) session.setLifecycleTransitionFenceForTests(false);
			});

			await expect(
				session.sendCustomMessage(
					{ customType: "retired-delivery", content: "must not land", display: false, attribution: "agent" },
					{ deliveryMode: "steer" },
				),
			).resolves.toEqual({ status: "unavailable", reason: "session_transition" });
			session.setLifecycleTransitionFenceForTests(false);
		}
		expect(session.agent.state.messages).toHaveLength(before);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
		expect(session.agent.peekFollowUpQueue()).toHaveLength(0);
		expect(session.hasPendingMessages()).toBe(false);
		session.setCustomMessageAcceptanceHookForTests(undefined);
	});
	it("rejects prompts when lifecycle ownership changes during asynchronous preparation", async () => {
		await createSession();
		session.setPromptAcceptanceHookForTests(() => {
			session.setLifecycleTransitionFenceForTests(true);
			session.setLifecycleTransitionFenceForTests(false);
		});

		try {
			await expect(session.prompt("idle across handoff")).rejects.toThrow("Session transition in progress");
			session.agent.state.isStreaming = true;
			await expect(session.prompt("queued across handoff", { streamingBehavior: "steer" })).rejects.toThrow(
				"Session transition in progress",
			);
			await expect(
				session.promptCustomMessage(
					{ customType: "queued-race", content: "custom across handoff", display: false },
					{ queueOnly: true, streamingBehavior: "steer" },
				),
			).rejects.toThrow("Session transition in progress");
			expect(session.agent.peekSteeringQueue()).toHaveLength(0);
			expect(session.agent.peekFollowUpQueue()).toHaveLength(0);
		} finally {
			session.setPromptAcceptanceHookForTests(undefined);
			session.setLifecycleTransitionFenceForTests(false);
		}
	});
	it("does not orphan a keyword notice when a queued user prompt loses lifecycle ownership", async () => {
		await createSession({ "magicKeywords.enabled": true, "magicKeywords.ultrathink": true });
		session.agent.state.isStreaming = true;
		let acceptanceCalls = 0;
		session.setPromptAcceptanceHookForTests(() => {
			acceptanceCalls++;
			if (acceptanceCalls !== 2) return;
			session.setLifecycleTransitionFenceForTests(true);
			session.setLifecycleTransitionFenceForTests(false);
		});

		try {
			await expect(
				session.prompt("ultrathink queued across handoff", { streamingBehavior: "steer" }),
			).rejects.toThrow("Session transition in progress");
			expect(acceptanceCalls).toBe(2);
			expect(session.agent.peekSteeringQueue()).toHaveLength(0);
			expect(session.agent.peekFollowUpQueue()).toHaveLength(0);
		} finally {
			session.setPromptAcceptanceHookForTests(undefined);
			session.setLifecycleTransitionFenceForTests(false);
		}
	});
	it("does not orphan a keyword notice when a queued custom prompt loses lifecycle ownership", async () => {
		await createSession({ "magicKeywords.enabled": true, "magicKeywords.ultrathink": true });
		session.agent.state.isStreaming = true;
		let acceptanceCalls = 0;
		session.setPromptAcceptanceHookForTests(() => {
			acceptanceCalls++;
			if (acceptanceCalls !== 2) return;
			session.setLifecycleTransitionFenceForTests(true);
			session.setLifecycleTransitionFenceForTests(false);
		});

		try {
			await expect(
				session.promptCustomMessage(
					{
						customType: "skill-prompt",
						content: "run the skill",
						display: true,
						details: { args: "ultrathink queued across handoff" },
						attribution: "user",
					},
					{ queueOnly: true, streamingBehavior: "followUp" },
				),
			).rejects.toThrow("Session transition in progress");
			expect(acceptanceCalls).toBe(2);
			expect(session.agent.peekSteeringQueue()).toHaveLength(0);
			expect(session.agent.peekFollowUpQueue()).toHaveLength(0);
		} finally {
			session.setPromptAcceptanceHookForTests(undefined);
			session.setLifecycleTransitionFenceForTests(false);
		}
	});
	it("does not run a prompt preflight for an unscoped semantic delivery", async () => {
		await createSession({ "retry.usageAwareFallback": true });
		const before = session.agent.state.messages.length;
		const usageSpy = vi.spyOn(sharedAuthStorage, "getModelUsageHealth");

		await expect(
			session.sendCustomMessage(
				{ customType: "cancelled-preflight", content: "must land passively", display: false, attribution: "agent" },
				{ deliveryMode: "interrupt" },
			),
		).resolves.toEqual({ status: "downgraded", delivery: "plain_append", reason: "unscoped_automatic_turn" });
		expect(usageSpy).not.toHaveBeenCalled();
		expect(session.agent.state.messages).toHaveLength(before + 1);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
		expect(session.agent.peekFollowUpQueue()).toHaveLength(0);
		expect(session.hasPendingMessages()).toBe(false);
	});
	it("downgrades legacy trigger requests without running a prompt preflight", async () => {
		const assertDowngraded = async (options: { deliverAs?: "nextTurn"; triggerTurn: true }) => {
			await createSession({ "retry.usageAwareFallback": true });
			const usageSpy = vi.spyOn(sharedAuthStorage, "getModelUsageHealth");

			const sending = session.sendCustomMessage(
				{
					customType: "cancelled-legacy-preflight",
					content: "must not land",
					display: false,
					attribution: "agent",
				},
				options,
			);
			await expect(sending).resolves.toEqual({
				status: "downgraded",
				delivery: "queued_next_turn",
				reason: "unscoped_automatic_turn",
			});
			expect(usageSpy).not.toHaveBeenCalled();
			expect(session.agent.peekSteeringQueue()).toHaveLength(0);
			expect(session.agent.peekFollowUpQueue()).toHaveLength(0);
			expect(session.hasPendingMessages()).toBe(true);
			usageSpy.mockRestore();
		};

		await assertDowngraded({ triggerTurn: true });
		await assertDowngraded({ deliverAs: "nextTurn", triggerTurn: true });
	});
	it("does not mutate a scoped semantic delivery when the client defers turns", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: sharedModelRegistry,
		});
		session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });
		const before = session.agent.state.messages.length;

		await expect(
			session.sendCustomMessage(
				{ customType: "exact-interrupt", content: "must not queue", display: false, attribution: "agent" },
				{ deliveryMode: "interrupt", automaticTurnSource: "peer_message_wake" },
			),
		).resolves.toEqual({ status: "unavailable", reason: "client_deferred_turn" });
		expect(session.agent.state.messages).toHaveLength(before);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
		expect(session.agent.peekFollowUpQueue()).toHaveLength(0);
		expect(session.hasPendingMessages()).toBe(false);
		expect(mock.calls).toHaveLength(0);
	});

	describe("durable semantic delivery recovery", () => {
		const pendingType = "omp:pending-semantic-delivery";
		const settledType = "omp:settled-semantic-delivery";

		function createPersistentSession(sessionManager: SessionManager, calls: Message[][] = []): AgentSession {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				convertToLlm,
				streamFn: (_model, context) => {
					calls.push([...context.messages]);
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: createAssistantMessage("") });
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
					});
					return stream;
				},
			});
			return new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated(),
				modelRegistry: sharedModelRegistry,
			});
		}

		function holdFirstEnsureOnDisk(manager: SessionManager): { entered: Promise<void>; release: () => void } {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const ensureOnDisk = manager.ensureOnDisk.bind(manager);
			let held = true;
			vi.spyOn(manager, "ensureOnDisk").mockImplementation(async () => {
				if (held) {
					held = false;
					entered.resolve();
					await release.promise;
				}
				await ensureOnDisk();
			});
			return { entered: entered.promise, release: () => release.resolve() };
		}

		it("returns started_turn only after the scoped peer input is durably journaled", async () => {
			const sessionDir = path.join(tempDir, "sessions");
			const manager = SessionManager.create(tempDir, sessionDir);
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			let providerStream: AssistantMessageEventStream | undefined;
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				convertToLlm,
				streamFn: () => {
					const stream = new AssistantMessageEventStream();
					providerStream = stream;
					queueMicrotask(() => {
						stream.push({ type: "start", partial: createAssistantMessage("") });
						stream.push({
							type: "text_delta",
							contentIndex: 0,
							delta: "working",
							partial: createAssistantMessage("working"),
						});
					});
					return stream;
				},
			});
			session = new AgentSession({
				agent,
				sessionManager: manager,
				settings: Settings.isolated(),
				modelRegistry: sharedModelRegistry,
			});
			let committed = false;

			await expect(
				session.sendCustomMessage(
					{ customType: "peer-message", content: "durable idle wake", display: true, attribution: "agent" },
					{
						deliveryMode: "auto",
						automaticTurnSource: "peer_message_wake",
						onStartedTurnAccepted: () => {
							committed = true;
						},
					},
				),
			).resolves.toEqual({ status: "accepted", delivery: "started_turn" });
			expect(committed).toBe(true);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Scoped wake did not materialize a session journal");
			expect(await Bun.file(sessionFile).text()).toContain("durable idle wake");

			providerStream?.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
			await session.waitForIdle();
		});

		it.each([
			["interrupt", { status: "downgraded", delivery: "plain_append", reason: "unscoped_automatic_turn" }],
			["steer", { status: "accepted", delivery: "plain_append" }],
		] as const)(
			"routes busy %s delivery through the idle path when persistence observes the state change",
			async (mode, expected) => {
				const sessionDir = path.join(tempDir, "sessions");
				const manager = SessionManager.create(tempDir, sessionDir);
				session = createPersistentSession(manager);
				session.agent.state.isStreaming = true;
				const gate = holdFirstEnsureOnDisk(manager);

				const sending = session.sendCustomMessage(
					{
						customType: `busy-idle-${mode}`,
						content: `${mode} became idle`,
						display: false,
						attribution: "agent",
					},
					{ deliveryMode: mode },
				);
				await gate.entered;
				session.agent.state.isStreaming = false;
				gate.release();

				await expect(sending).resolves.toEqual(expected);
				expect(session.agent.peekSteeringQueue()).toHaveLength(0);
				expect(session.agent.peekFollowUpQueue()).toHaveLength(0);
				expect(session.agent.state.messages.at(-1)).toMatchObject({ customType: `busy-idle-${mode}` });
				const branch = manager.getBranch();
				const pending = branch.find(entry => entry.type === "custom" && entry.customType === pendingType);
				if (!pending) throw new Error("Expected a durable pending semantic delivery");
				expect(branch).toContainEqual(
					expect.objectContaining({ type: "custom_message", customType: `busy-idle-${mode}` }),
				);
				expect(branch).toContainEqual(
					expect.objectContaining({
						type: "custom",
						customType: settledType,
						data: { pendingId: pending.id, outcome: "delivered" },
					}),
				);
			},
		);

		it("rolls back a failed fresh idle steer before crash-safe retry", async () => {
			const sessionDir = path.join(tempDir, "sessions");
			const manager = SessionManager.create(tempDir, sessionDir);
			session = createPersistentSession(manager);
			const ensureEntered = Promise.withResolvers<void>();
			const releaseEnsure = Promise.withResolvers<void>();
			const ensureOnDisk = manager.ensureOnDisk.bind(manager);
			let failFirstEnsure = true;
			vi.spyOn(manager, "ensureOnDisk").mockImplementation(async () => {
				if (failFirstEnsure) {
					failFirstEnsure = false;
					ensureEntered.resolve();
					await releaseEnsure.promise;
					throw new Error("fresh semantic persistence failed");
				}
				await ensureOnDisk();
			});
			const payload = {
				customType: "fresh-retry-safe-plain",
				content: "persist exactly once after fresh retry",
				display: false,
				attribution: "agent" as const,
			};

			const sending = session.sendCustomMessage(payload, { deliveryMode: "steer" });
			await ensureEntered.promise;
			const laterMessage = { role: "user" as const, content: "keep later fresh append", timestamp: Date.now() };
			session.agent.appendMessage(laterMessage);
			expect(session.agent.state.messages.at(-2)).toMatchObject({ customType: payload.customType });
			releaseEnsure.resolve();

			await expect(sending).rejects.toThrow("fresh semantic persistence failed");
			expect(session.agent.state.messages).toEqual([laterMessage]);
			const failedBranch = manager.getBranch();
			expect(
				failedBranch.some(entry => entry.type === "custom_message" && entry.customType === payload.customType),
			).toBe(false);
			expect(
				failedBranch.some(
					entry =>
						entry.type === "custom" && (entry.customType === pendingType || entry.customType === settledType),
				),
			).toBe(false);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Failed persistence did not retain a recoverable session path");
			expect(await Bun.file(sessionFile).text()).not.toContain(payload.content);

			session = undefined as unknown as AgentSession;
			const resumed = await reopen(sessionFile, sessionDir);
			expect(resumed.agent.peekSteeringQueue()).toHaveLength(0);
			expect(resumed.agent.peekFollowUpQueue()).toHaveLength(0);
			expect(
				resumed.agent.state.messages.filter(
					message => message.role === "custom" && message.customType === payload.customType,
				),
			).toHaveLength(0);

			await expect(resumed.sendCustomMessage(payload, { deliveryMode: "steer" })).resolves.toEqual({
				status: "accepted",
				delivery: "plain_append",
			});
			expect(
				resumed.agent.state.messages.filter(
					message => message.role === "custom" && message.customType === payload.customType,
				),
			).toHaveLength(1);
			await resumed.sessionManager.flush();

			session = undefined as unknown as AgentSession;
			const afterRetry = await reopen(sessionFile, sessionDir);
			expect(
				afterRetry.sessionManager
					.getBranch()
					.filter(entry => entry.type === "custom_message" && entry.customType === payload.customType),
			).toHaveLength(1);
			expect(afterRetry.agent.peekSteeringQueue()).toHaveLength(0);
		});

		it("rolls back the exact live append and durable pending record before a mailbox retry", async () => {
			const sessionDir = path.join(tempDir, "sessions");
			const manager = SessionManager.create(tempDir, sessionDir);
			session = createPersistentSession(manager);
			session.agent.state.isStreaming = true;
			const firstEnsureEntered = Promise.withResolvers<void>();
			const releaseFirstEnsure = Promise.withResolvers<void>();
			const secondEnsureEntered = Promise.withResolvers<void>();
			const releaseSecondEnsure = Promise.withResolvers<void>();
			const ensureOnDisk = manager.ensureOnDisk.bind(manager);
			let ensureCalls = 0;
			vi.spyOn(manager, "ensureOnDisk").mockImplementation(async () => {
				ensureCalls++;
				if (ensureCalls === 1) {
					firstEnsureEntered.resolve();
					await releaseFirstEnsure.promise;
					await ensureOnDisk();
					return;
				}
				if (ensureCalls === 2) {
					secondEnsureEntered.resolve();
					await releaseSecondEnsure.promise;
					throw new Error("conversation settlement publish failed");
				}
				await ensureOnDisk();
			});
			const payload = {
				customType: "retry-safe-plain",
				content: "deliver exactly once after retry",
				display: false,
				attribution: "agent" as const,
			};

			const sending = session.sendCustomMessage(payload, { deliveryMode: "steer" });
			await firstEnsureEntered.promise;
			session.agent.state.isStreaming = false;
			releaseFirstEnsure.resolve();
			await secondEnsureEntered.promise;
			const laterMessage = { role: "user" as const, content: "keep later append", timestamp: Date.now() };
			session.agent.appendMessage(laterMessage);
			expect(session.agent.state.messages.at(-2)).toMatchObject({ customType: payload.customType });
			releaseSecondEnsure.resolve();

			await expect(sending).rejects.toThrow("conversation settlement publish failed");
			expect(session.agent.state.messages).toEqual([laterMessage]);
			const failedBranch = manager.getBranch();
			const pending = failedBranch.find(entry => entry.type === "custom" && entry.customType === pendingType);
			if (!pending) throw new Error("Expected a durable pending semantic delivery");
			expect(failedBranch).toContainEqual(
				expect.objectContaining({
					type: "custom",
					customType: settledType,
					data: { pendingId: pending.id, outcome: "cancelled" },
				}),
			);
			expect(
				failedBranch.some(entry => entry.type === "custom_message" && entry.customType === payload.customType),
			).toBe(false);

			await expect(session.sendCustomMessage(payload, { deliveryMode: "steer" })).resolves.toEqual({
				status: "accepted",
				delivery: "plain_append",
			});
			expect(
				session.agent.state.messages.filter(
					message => message.role === "custom" && message.customType === payload.customType,
				),
			).toHaveLength(1);
			expect(session.agent.state.messages).toContain(laterMessage);
			await manager.ensureOnDisk();
			await manager.flush();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a materialized session");

			await session.dispose();
			session = undefined as unknown as AgentSession;
			const resumed = await reopen(sessionFile, sessionDir);
			expect(resumed.agent.peekSteeringQueue()).toHaveLength(0);
			expect(
				resumed.sessionManager
					.getBranch()
					.filter(entry => entry.type === "custom_message" && entry.customType === payload.customType),
			).toHaveLength(1);
		});

		it("starts a scoped auto turn when a busy receiver becomes idle during pending persistence", async () => {
			const sessionDir = path.join(tempDir, "sessions");
			const manager = SessionManager.create(tempDir, sessionDir);
			const calls: Message[][] = [];
			session = createPersistentSession(manager, calls);
			session.agent.state.isStreaming = true;
			const gate = holdFirstEnsureOnDisk(manager);
			let committed = false;

			const sending = session.sendCustomMessage(
				{ customType: "busy-idle-auto", content: "start after persistence", display: true, attribution: "agent" },
				{
					deliveryMode: "auto",
					automaticTurnSource: "peer_message_wake",
					onStartedTurnAccepted: () => {
						committed = true;
					},
				},
			);
			await gate.entered;
			session.agent.state.isStreaming = false;
			gate.release();

			await expect(sending).resolves.toEqual({ status: "accepted", delivery: "started_turn" });
			await session.waitForIdle();
			expect(committed).toBe(true);
			expect(session.agent.peekSteeringQueue()).toHaveLength(0);
			expect(session.agent.peekFollowUpQueue()).toHaveLength(0);
			expect(JSON.stringify(calls[0])).toContain("start after persistence");
			const branch = manager.getBranch();
			const pending = branch.find(entry => entry.type === "custom" && entry.customType === pendingType);
			if (!pending) throw new Error("Expected a durable pending semantic delivery");
			expect(branch).toContainEqual(
				expect.objectContaining({
					type: "custom",
					customType: settledType,
					data: { pendingId: pending.id, outcome: "delivered" },
				}),
			);
		});

		async function acceptBeforeCrash(
			mode: "interrupt" | "afterCurrent" | "steer" | "explicitPrompt",
			content: string,
		): Promise<{ sessionFile: string; sessionDir: string }> {
			const sessionDir = path.join(tempDir, "sessions");
			const manager = SessionManager.create(tempDir, sessionDir);
			session = createPersistentSession(manager);
			session.agent.state.isStreaming = true;
			await session.sendCustomMessage(
				{ customType: `mail-${mode}`, content, display: true, attribution: "agent" },
				{ deliveryMode: mode },
			);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Semantic acceptance did not materialize a session file");
			// Process-death simulation: reopen the flushed journal without disposing the old AgentSession.
			session = undefined as unknown as AgentSession;
			return { sessionFile, sessionDir };
		}

		async function reopen(sessionFile: string, sessionDir: string, calls: Message[][] = []): Promise<AgentSession> {
			const reopened = await SessionManager.open(sessionFile, sessionDir, undefined, {
				initialCwd: tempDir,
				suppressBreadcrumb: true,
			});
			session = createPersistentSession(reopened, calls);
			return session;
		}

		it.each([
			["interrupt", "steer recovered after crash", "steer"],
			["steer", "explicit steer recovered after crash", "steer"],
			["afterCurrent", "follow-up recovered after crash", "followUp"],
		] as const)("rehydrates busy %s delivery after a process boundary", async (mode, content, queue) => {
			const { sessionFile, sessionDir } = await acceptBeforeCrash(mode, content);
			const resumed = await reopen(sessionFile, sessionDir);
			const recovered = queue === "steer" ? resumed.agent.peekSteeringQueue() : resumed.agent.peekFollowUpQueue();
			expect(recovered).toHaveLength(1);
			expect(JSON.stringify(recovered[0])).toContain(content);
		});

		it("preserves array-valued details through queued semantic recovery", async () => {
			const details = [{ messageId: "one" }, { messageId: "two" }];
			const sessionDir = path.join(tempDir, "sessions");
			const manager = SessionManager.create(tempDir, sessionDir);
			session = createPersistentSession(manager);
			session.agent.state.isStreaming = true;
			await session.sendCustomMessage(
				{ customType: "array-details", content: "preserve metadata", display: true, details, attribution: "agent" },
				{ deliveryMode: "steer" },
			);

			const queued = session.agent.peekSteeringQueue()[0];
			if (queued?.role !== "custom") throw new Error("Expected a queued custom message");
			expect(Array.isArray(queued.details)).toBe(true);
			expect([...(queued.details as typeof details)]).toEqual(details);
			expect(readPendingSemanticDeliveryId(queued.details)).toBeString();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted semantic delivery");

			session = undefined as unknown as AgentSession;
			const resumed = await reopen(sessionFile, sessionDir);
			const recovered = resumed.agent.peekSteeringQueue()[0];
			if (recovered?.role !== "custom") throw new Error("Expected a recovered custom message");
			expect(Array.isArray(recovered.details)).toBe(true);
			expect([...(recovered.details as typeof details)]).toEqual(details);
			expect(readPendingSemanticDeliveryId(recovered.details)).toBeString();
		});

		it("keeps idle explicitPrompt recovery out of automatic turns until the next deliberate prompt", async () => {
			const { sessionFile, sessionDir } = await acceptBeforeCrash("explicitPrompt", "idle status after crash");
			const calls: Message[][] = [];
			const resumed = await reopen(sessionFile, sessionDir, calls);

			resumed.agent.state.isStreaming = false;
			await expect(
				resumed.sendCustomMessage(
					{ customType: "urgent", content: "automatic urgent turn", display: true, attribution: "agent" },
					{ deliveryMode: "interrupt" },
				),
			).resolves.toEqual({ status: "downgraded", delivery: "plain_append", reason: "unscoped_automatic_turn" });
			expect(calls).toHaveLength(0);

			await resumed.prompt("deliberate owner prompt");
			expect(JSON.stringify(calls[0])).toContain("automatic urgent turn");
			expect(JSON.stringify(calls[0])).toContain("idle status after crash");
		});

		it("reattaches busy explicitPrompt recovery to the next queued user prompt", async () => {
			const { sessionFile, sessionDir } = await acceptBeforeCrash("explicitPrompt", "paired status after crash");
			const calls: Message[][] = [];
			const resumed = await reopen(sessionFile, sessionDir, calls);

			await resumed.prompt("paired deliberate prompt");
			const providerTurn = JSON.stringify(calls[0]);
			expect(providerTurn).toContain("paired deliberate prompt");
			expect(providerTurn).toContain("paired status after crash");
		});

		it("cancels pending semantic deliveries before an in-place context reset", async () => {
			const sessionDir = path.join(tempDir, "sessions");
			const manager = SessionManager.create(tempDir, sessionDir);
			session = createPersistentSession(manager);
			session.agent.state.isStreaming = true;
			await session.sendCustomMessage(
				{ customType: "reset-cancelled", content: "must stay before reset", display: false, attribution: "agent" },
				{ deliveryMode: "steer" },
			);
			session.agent.state.isStreaming = false;
			await expect(session.resetSessionContext()).resolves.toEqual({ droppedCount: 0 });

			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a materialized session");
			const resumed = await reopen(sessionFile, sessionDir);
			expect(resumed.agent.peekSteeringQueue()).toHaveLength(0);
			expect(resumed.agent.peekFollowUpQueue()).toHaveLength(0);
			expect(resumed.hasPendingMessages()).toBe(false);
		});

		it("keeps queued acceptance on the retained session when a lifecycle fence begins during persistence", async () => {
			const sessionDir = path.join(tempDir, "sessions");
			const manager = SessionManager.create(tempDir, sessionDir);
			session = createPersistentSession(manager);
			session.agent.state.isStreaming = true;
			const rewriteStarted = Promise.withResolvers<void>();
			const continueRewrite = Promise.withResolvers<void>();
			const ensureOnDisk = manager.ensureOnDisk.bind(manager);
			vi.spyOn(manager, "ensureOnDisk").mockImplementation(async () => {
				rewriteStarted.resolve();
				await continueRewrite.promise;
				await ensureOnDisk();
			});

			const sending = session.sendCustomMessage(
				{ customType: "acceptance-race", content: "must stay retained", display: false, attribution: "agent" },
				{ deliveryMode: "steer" },
			);
			await rewriteStarted.promise;
			session.setLifecycleTransitionFenceForTests(true);
			continueRewrite.resolve();

			await expect(sending).resolves.toEqual({ status: "accepted", delivery: "queued_steer" });
			expect(session.agent.peekSteeringQueue()).toHaveLength(1);
			session.setLifecycleTransitionFenceForTests(false);
		});

		it("settles a concurrent queued acceptance before resetting its delivery", async () => {
			const sessionDir = path.join(tempDir, "sessions");
			const manager = SessionManager.create(tempDir, sessionDir);
			session = createPersistentSession(manager);
			session.agent.state.isStreaming = true;
			const rewriteStarted = Promise.withResolvers<void>();
			const continueRewrite = Promise.withResolvers<void>();
			const ensureOnDisk = manager.ensureOnDisk.bind(manager);
			vi.spyOn(manager, "ensureOnDisk").mockImplementation(async () => {
				rewriteStarted.resolve();
				await continueRewrite.promise;
				await ensureOnDisk();
			});

			const sending = session.sendCustomMessage(
				{ customType: "reset-race", content: "cancel before reset", display: false, attribution: "agent" },
				{ deliveryMode: "explicitPrompt" },
			);
			await rewriteStarted.promise;
			session.agent.state.isStreaming = false;
			const resetting = session.resetSessionContext();
			continueRewrite.resolve();

			await expect(sending).resolves.toEqual({ status: "accepted", delivery: "queued_next_turn" });
			await expect(resetting).resolves.toEqual({ droppedCount: 0 });
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a materialized session");
			const resumed = await reopen(sessionFile, sessionDir);
			expect(resumed.agent.peekSteeringQueue()).toHaveLength(0);
			expect(resumed.hasPendingMessages()).toBe(false);
		});
		it("persists the conversation message before its semantic-delivery settlement", async () => {
			const sessionDir = path.join(tempDir, "sessions");

			const manager = SessionManager.create(tempDir, sessionDir);
			session = createPersistentSession(manager);
			session.agent.state.isStreaming = true;
			await session.sendCustomMessage(
				{ customType: "ordered", content: "ordered delivery", display: false, attribution: "agent" },
				{ deliveryMode: "steer" },
			);

			const queued = session.agent.peekSteeringQueue()[0];
			if (!queued) throw new Error("Expected a queued semantic steer");
			session.agent.state.isStreaming = false;
			session.agent.emitExternalEvent({ type: "message_start", message: queued });
			session.agent.emitExternalEvent({ type: "message_end", message: queued });
			await waitFor(() =>
				manager.getBranch().some(entry => entry.type === "custom" && entry.customType === settledType),
			);

			const branch = manager.getBranch();
			const pendingIndex = branch.findIndex(entry => entry.type === "custom" && entry.customType === pendingType);
			const messageIndex = branch.findIndex(
				entry => entry.type === "custom_message" && entry.customType === "ordered",
			);
			const settledIndex = branch.findIndex(entry => entry.type === "custom" && entry.customType === settledType);
			expect(pendingIndex).toBeGreaterThanOrEqual(0);
			expect(messageIndex).toBeGreaterThan(pendingIndex);
			expect(settledIndex).toBeGreaterThan(messageIndex);
		});

		it("recovers one pending delivery when conversation settlement persistence fails", async () => {
			const sessionDir = path.join(tempDir, "sessions");
			const manager = SessionManager.create(tempDir, sessionDir);
			session = createPersistentSession(manager);
			session.agent.state.isStreaming = true;
			await session.sendCustomMessage(
				{ customType: "failed-settlement", content: "recover exactly once", display: false, attribution: "agent" },
				{ deliveryMode: "steer" },
			);

			const queued = session.agent.peekSteeringQueue()[0];
			if (!queued) throw new Error("Expected a queued semantic steer");
			const atomicBatch = vi
				.spyOn(manager, "appendEntriesAtomically")
				.mockRejectedValueOnce(new Error("conversation settlement publish failed"));
			session.agent.state.isStreaming = false;
			session.agent.emitExternalEvent({ type: "message_start", message: queued });
			session.agent.emitExternalEvent({ type: "message_end", message: queued });
			await waitFor(() => atomicBatch.mock.calls.length === 1);

			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a materialized session");
			session = undefined as unknown as AgentSession;
			const resumed = await reopen(sessionFile, sessionDir);
			expect(resumed.agent.peekSteeringQueue()).toHaveLength(1);
			expect(JSON.stringify(resumed.agent.peekSteeringQueue()[0])).toContain("recover exactly once");
			expect(
				resumed.sessionManager
					.getBranch()
					.some(entry => entry.type === "custom_message" && entry.customType === "failed-settlement"),
			).toBe(false);
			expect(
				resumed.sessionManager
					.getBranch()
					.some(entry => entry.type === "custom" && entry.customType === settledType),
			).toBe(false);
		});
	});

	it("should throw when prompt() called while streaming", async () => {
		await createSession();

		// Start first prompt (don't await, it will block until abort)
		const firstPrompt = session.prompt("First message");

		await waitFor(() => session.isStreaming);

		// Second prompt should reject
		await expect(session.prompt("Second message")).rejects.toBeInstanceOf(AgentBusyError);

		// Cleanup
		await session.abort();
		await firstPrompt.catch(() => {}); // Ignore abort error
	});

	it("coalesces concurrent abort callers onto one teardown promise", async () => {
		await createSession();
		const prompt = session.prompt("First message");
		await waitFor(() => session.isStreaming);
		const agentAbort = vi.spyOn(session.agent, "abort");

		const firstAbort = session.abort();
		const secondAbort = session.abort();
		expect(secondAbort).toBe(firstAbort);
		await expect(firstAbort).resolves.toBeUndefined();
		await prompt.catch(() => {});
		expect(agentAbort).toHaveBeenCalledTimes(1);
	});

	it("upgrades an in-flight internal abort to user-interrupt semantics", async () => {
		await createSession();
		const postPromptGate = Promise.withResolvers<void>();
		session.trackPostPromptTaskForTests(postPromptGate.promise);
		const agentAbort = vi.spyOn(session.agent, "abort");
		const taskAborted = vi.spyOn(session.goalRuntime, "onTaskAborted").mockResolvedValue(undefined);

		const internalAbort = session.abort({
			goalReason: "internal",
			preserveCompaction: true,
			preserveToolChoice: true,
		});
		const userAbort = session.abort({ reason: USER_INTERRUPT_LABEL });
		expect(userAbort).toBe(internalAbort);
		expect(agentAbort).toHaveBeenLastCalledWith(USER_INTERRUPT_LABEL);

		postPromptGate.resolve();
		await userAbort;
		expect(taskAborted).toHaveBeenCalledWith({ reason: "interrupted" });
	});

	it("does not begin a new prompt until abort teardown settles", async () => {
		await createSession();
		const promptAgent = vi.spyOn(session.agent, "prompt");
		const firstPrompt = session.prompt("First message");
		await waitFor(() => promptAgent.mock.calls.length === 1);
		const postPromptGate = Promise.withResolvers<void>();
		session.trackPostPromptTaskForTests(postPromptGate.promise);

		const abort = session.abort();
		const secondPrompt = session.prompt("Second message");
		try {
			await scheduler.yield();
			expect(promptAgent).toHaveBeenCalledTimes(1);
		} finally {
			postPromptGate.resolve();
		}

		await abort;
		await waitFor(() => promptAgent.mock.calls.length === 2);
		await session.abort();
		await Promise.allSettled([firstPrompt, secondPrompt]);
	});

	it("should allow steer() while streaming", async () => {
		await createSession();

		// Start first prompt
		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.isStreaming);

		// steer should work while streaming
		await session.steer("Steer while streaming");
		expect(session.queuedMessageCount).toBe(1);

		// Cleanup
		session.agent.clearAllQueues();
		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("should allow followUp() while streaming", async () => {
		await createSession();

		// Start first prompt
		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.isStreaming);

		// followUp should work while streaming
		await session.followUp("Follow-up while streaming");
		expect(session.queuedMessageCount).toBe(1);

		// Cleanup
		session.agent.clearAllQueues();
		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("reports hidden queued messages as pending without exposing them in the visible count", async () => {
		await createSession();

		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.isStreaming);
		await session.sendCustomMessage(
			{
				customType: "hidden-follow-up",
				content: "Hidden follow-up",
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "followUp" },
		);

		expect(session.queuedMessageCount).toBe(0);
		expect(session.hasPendingMessages()).toBe(true);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });

		session.agent.clearAllQueues();
		expect(session.hasPendingMessages()).toBe(false);
		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("queues sendUserMessage as steer while streaming without AgentBusyError", async () => {
		await createSession();

		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.isStreaming);

		// The first agent loop may dequeue a steer before the assertion runs, so
		// observe agent.steer itself rather than the residual queue length.
		const steered: AgentMessage[] = [];
		const originalSteer = session.agent.steer.bind(session.agent);
		session.agent.steer = (message: AgentMessage) => {
			steered.push(message);
			originalSteer(message);
		};

		// Extension path: no deliverAs while busy must queue, not throw.
		await expect(session.sendUserMessage("hello from extension")).resolves.toBeUndefined();
		expect(steered).toHaveLength(1);
		const queued = steered[0];
		expect(queued?.role).toBe("user");
		if (queued?.role === "user") {
			expect(queued.content).toEqual([{ type: "text", text: "hello from extension" }]);
			expect(queued.steering).toBe(true);
		}

		session.agent.clearAllQueues();
		await session.abort();
		await firstPrompt.catch(() => {});
	});

	it("sendUserMessage without deliverAs preserves prompt-flow keyword notices while streaming", async () => {
		await createSession({ "magicKeywords.enabled": true, "magicKeywords.ultrathink": true });

		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.isStreaming);

		try {
			await session.sendUserMessage("ultrathink fix via extension");
			const queuedShape = session.agent
				.peekSteeringQueue()
				.map(message => (message.role === "custom" ? message.customType : message.role));
			expect(queuedShape).toEqual(["ultrathink-notice", "user"]);
			expect(session.getQueuedMessages()).toEqual({
				steering: ["ultrathink fix via extension"],
				followUp: [],
			});
		} finally {
			session.agent.clearAllQueues();
			await session.abort();
			await firstPrompt.catch(() => {});
		}
	});

	it("sendUserMessage without deliverAs starts a normal prompt when idle", async () => {
		await createSession();

		let rejected: unknown;
		let settled = false;
		const turn = session
			.sendUserMessage("Idle extension message")
			.catch(error => {
				rejected = error;
			})
			.finally(() => {
				settled = true;
			});

		try {
			await waitFor(() => session.isStreaming || settled);
			if (rejected) throw rejected;

			expect(session.isStreaming).toBe(true);
			expect(settled).toBe(false);
			expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		} finally {
			await session.abort();
			await turn;
		}
	});

	it("serializes extension command follow-ups after the active turn fully settles", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const streamStarted = Promise.withResolvers<void>();
		const finishStream = Promise.withResolvers<void>();
		const releaseFirstCommand = Promise.withResolvers<void>();
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					streamStarted.resolve();
					void finishStream.promise.then(() => {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
					});
				});
				return stream;
			},
		});
		const commandCalls: string[] = [];
		const commandStreamingStates: boolean[] = [];
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerCommand("after-turn", {
					handler: async args => {
						commandCalls.push(args);
						commandStreamingStates.push(session.isStreaming);
						if (args === "first") await releaseFirstCommand.promise;
					},
				});
			},
			tempDir,
			new EventBus(),
			extensionRuntime,
			"follow-up-command",
		);
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir,
			sessionManager,
			modelRegistry,
		);
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		const firstPrompt = session.prompt("First message");
		await streamStarted.promise;
		const firstCommand = session.sendUserMessage("/after-turn first", { deliverAs: "followUp" });
		const secondCommand = session.sendUserMessage("/after-turn second", { deliverAs: "followUp" });

		await scheduler.yield();
		expect(commandCalls).toEqual([]);
		finishStream.resolve();
		await firstPrompt;
		await waitFor(() => commandCalls.length > 0);
		try {
			expect(commandCalls).toEqual(["first"]);
			expect(commandStreamingStates).toEqual([false]);
		} finally {
			releaseFirstCommand.resolve();
		}
		await Promise.all([firstCommand, secondCommand]);

		expect(commandCalls).toEqual(["first", "second"]);
		expect(commandStreamingStates).toEqual([false, false]);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
		expect(JSON.stringify(sessionManager.getEntries())).not.toContain("/after-turn");
	});

	it("terminates an exclusive handoff without waking the child until direct user input", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const extensionRuntime = new ExtensionRuntime();
		let mutatorCalls = 0;
		let commandCalls = 0;
		let sourceFile: string | undefined;
		let childFile: string | undefined;
		let childTurn: Promise<unknown> | undefined;
		const childGoal = {
			id: "child-handoff-goal",
			objective: "Continue only in the child session",
			status: "active" as const,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.registerTool({
					name: "commit_handoff",
					label: "Commit handoff",
					description: "Commit a terminal child handoff",
					parameters: pi.arktype({}),
					concurrency: "exclusive",
					terminalAfterSuccess: true,
					async execute() {
						pi.sendUserMessage("/commit-handoff child", { deliverAs: "followUp" });
						return { content: [{ type: "text", text: "handoff committed" }], details: {} };
					},
				});
				pi.registerTool({
					name: "later_mutator",
					label: "Later mutator",
					description: "Must not run after the terminal handoff",
					parameters: pi.arktype({}),
					async execute() {
						mutatorCalls++;
						return { content: [{ type: "text", text: "mutated" }], details: {} };
					},
				});
				pi.registerTool({
					name: "child_complete",
					label: "Child complete",
					description: "Settle the child proof without another provider call",
					parameters: pi.arktype({}),
					concurrency: "exclusive",
					terminalAfterSuccess: true,
					async execute() {
						return { content: [{ type: "text", text: "child settled" }], details: {} };
					},
				});
				pi.registerCommand("commit-handoff", {
					handler: async (_args, ctx) => {
						commandCalls++;
						if (!sourceFile) throw new Error("Expected source session file");
						const result = await ctx.newSession({
							parentSession: sourceFile,
							setup: async manager => {
								manager.appendCustomEntry("smarty-stack.handoff", { phase: "child_committed" });
								manager.appendModeChange("goal", { goal: childGoal });
							},
						});
						if (result.cancelled) throw new Error("Child handoff was cancelled");
						childFile = session.sessionFile;
						childTurn = pi.sendMessage(
							{
								customType: "smarty-stack.handoff-next-turn",
								content: "Continue in the child session.",
								display: false,
								attribution: "agent",
							},
							{ deliverAs: "nextTurn", triggerTurn: true },
						);
					},
				});
			},
			tempDir,
			new EventBus(),
			extensionRuntime,
			"terminal-handoff",
		);
		const sessionManager = SessionManager.create(tempDir, path.join(tempDir, "sessions"));
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir,
			sessionManager,
			sharedModelRegistry,
		);
		const tools = wrapRegisteredTools(extensionRunner.getAllRegisteredTools(), extensionRunner);
		const requestSessionFiles: string[] = [];
		let providerCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools },
			convertToLlm,
			streamFn: () => {
				providerCalls++;
				requestSessionFiles.push(session.sessionFile ?? "missing");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (providerCalls === 1) {
						const message = createAssistantMessage("");
						message.stopReason = "toolUse";
						message.content = [
							{ type: "toolCall", id: "handoff-call", name: "commit_handoff", arguments: {} },
							{ type: "toolCall", id: "mutator-call", name: "later_mutator", arguments: {} },
						] as ToolCall[];
						stream.push({ type: "done", reason: "toolUse", message });
						return;
					}
					const message = createAssistantMessage("");
					message.stopReason = "toolUse";
					message.content = [
						{ type: "text", text: "HANDOFF_CHILD_OK" },
						{ type: "toolCall", id: "child-complete-call", name: "child_complete", arguments: {} },
					] as AssistantMessage["content"];
					stream.push({ type: "done", reason: "toolUse", message });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: sharedModelRegistry,
			extensionRunner,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		});
		sourceFile = session.sessionFile;
		if (!sourceFile) throw new Error("Expected persisted source session");
		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw new Error(error.error);
			},
		});

		await session.prompt("Commit the handoff");
		await waitFor(() => childTurn !== undefined);
		if (!childTurn) throw new Error("Expected child continuation task");
		await childTurn;
		expect(providerCalls).toBe(1);
		await session.prompt("Continue in the child session");
		await session.sessionManager.flush();
		if (!childFile) throw new Error("Expected persisted child session");

		const assistantTexts = async (file: string): Promise<string[]> =>
			(await Bun.file(file).text())
				.split("\n")
				.filter(Boolean)
				.flatMap(line => {
					const entry = JSON.parse(line) as { type?: string; message?: AgentMessage };
					if (entry.type !== "message" || entry.message?.role !== "assistant") return [];
					return entry.message.content.flatMap(block => (block.type === "text" ? [block.text] : []));
				});
		const sourceAssistantTexts = await assistantTexts(sourceFile);
		const childAssistantTexts = await assistantTexts(childFile);

		expect(mutatorCalls).toBe(0);
		expect(commandCalls).toBe(1);
		expect(providerCalls).toBe(2);
		expect(requestSessionFiles).toEqual([sourceFile, childFile]);
		expect(sourceAssistantTexts).not.toContain("HANDOFF_CHILD_OK");
		expect(childAssistantTexts).toContain("HANDOFF_CHILD_OK");
		expect(session.getGoalModeState()).toMatchObject({
			enabled: true,
			mode: "active",
			goal: { id: childGoal.id, objective: childGoal.objective, status: "active" },
		});
	});

	it("defers hidden nextTurn stop reactions until the next direct user prompt", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let firstStream: AssistantMessageEventStream | undefined;
		const callMessages: Message[][] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			convertToLlm,
			streamFn: (_model, context) => {
				callMessages.push([...context.messages]);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (callMessages.length > 1) {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Resumed") });
						return;
					}
				});
				firstStream = stream;
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.isStreaming && firstStream !== undefined && callMessages.length === 1);

		await session.sendCustomMessage(
			{
				customType: "autoresearch-resume",
				content: "Hidden stop reaction",
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: true },
		);

		expect(session.queuedMessageCount).toBe(0);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });

		firstStream?.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
		await firstPrompt;
		await session.waitForIdle();
		expect(callMessages).toHaveLength(1);

		await session.prompt("Continue deliberately");

		expect(callMessages).toHaveLength(2);
		expect(
			callMessages[1]?.some(message => {
				if (typeof message.content === "string") {
					return message.content.includes("Hidden stop reaction");
				}

				return message.content.some(
					content => content.type === "text" && content.text.includes("Hidden stop reaction"),
				);
			}),
		).toBe(true);
	});

	it("records session_stop feedback without starting an unscoped turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Done"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const stopEvents: Array<{
			messages: AgentMessage[];
			stop_hook_active: boolean;
			session_id: string;
			turn_id: number;
			last_assistant_message?: AgentMessage;
		}> = [];
		const eventOrder: string[] = [];
		const extensionRunner = {
			emit: vi.fn(event => {
				eventOrder.push(event.type);
				return Promise.resolve(undefined);
			}),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn(event => {
				eventOrder.push("session_stop");
				stopEvents.push(event);
				if (stopEvents.length === 1) {
					return Promise.resolve({ continue: true, additionalContext: "Mission incomplete; continue." });
				}
				return Promise.resolve(undefined);
			}),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		await session.prompt("First message");
		await session.waitForIdle();

		const callMessages = mock.calls.map(call => call.context.messages);
		expect(callMessages).toHaveLength(1);
		expect(
			callMessages[0]?.some(message =>
				typeof message.content === "string"
					? message.content.includes("Mission incomplete; continue.")
					: message.content.some(
							content => content.type === "text" && content.text.includes("Mission incomplete; continue."),
						),
			),
		).toBe(false);
		expect(eventOrder.filter(type => type === "session_stop" || type === "agent_end")).toEqual([
			"session_stop",
			"agent_end",
		]);
		expect(stopEvents.map(event => event.stop_hook_active)).toEqual([false]);
		expect(stopEvents.map(event => event.turn_id)).toEqual([0]);
		expect(stopEvents[0]?.session_id).toBe(session.sessionId);
		expect(stopEvents[0]?.last_assistant_message?.role).toBe("assistant");
		expect(stopEvents[0]?.messages.some(message => message.role === "user")).toBe(true);
	});

	it("does not use a session_stop reason to create a hidden turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Done"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		let stopCount = 0;
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn(() => {
				stopCount++;
				if (stopCount === 1) {
					return Promise.resolve({
						continue: true,
						additionalContext: "",
						reason: "Continue from fallback reason.",
					});
				}
				return Promise.resolve(undefined);
			}),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		await session.prompt("First message");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
	});

	it("does not emit session_stop when abort starts before the settle pass", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Done"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const settleGate = Promise.withResolvers<void>();
		const settleReached = Promise.withResolvers<void>();
		const emitSessionStop = vi.fn().mockResolvedValue(undefined);
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop,
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
		vi.spyOn(session.goalRuntime, "onAgentEnd").mockImplementation(() => {
			settleReached.resolve();
			return settleGate.promise;
		});

		const promptPromise = session.prompt("First message");
		await settleReached.promise;
		const abortPromise = session.abort();
		settleGate.resolve();

		await abortPromise;
		await promptPromise;
		await session.waitForIdle();

		expect(emitSessionStop).not.toHaveBeenCalled();
	});

	it("cancels an active session_stop pass without applying stale continuation feedback", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Done"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const stopStarted = Promise.withResolvers<void>();
		const stopHook = Promise.withResolvers<{ continue: true; additionalContext: string }>();
		let firstStopSignal: AbortSignal | undefined;
		let stopCount = 0;
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_stop", event => {
					stopCount++;
					if (stopCount !== 1) return;
					firstStopSignal = event.signal;
					stopStarted.resolve();
					return stopHook.promise;
				});
			},
			tempDir,
			new EventBus(),
			extensionRuntime,
			"slow-session-stop",
		);
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir,
			sessionManager,
			modelRegistry,
		);
		const extensionErrors: string[] = [];
		extensionRunner.onError(error => extensionErrors.push(error.error));

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		const promptPromise = session.prompt("First message");
		await stopStarted.promise;
		let abortSettled = false;
		const abortPromise = session.abort().then(() => {
			abortSettled = true;
		});
		await scheduler.yield();
		const abortSettledBeforeHandler = abortSettled;
		const signalWasCancelled = firstStopSignal?.aborted;
		stopHook.resolve({ continue: true, additionalContext: "Should not run after abort." });

		await abortPromise;
		await promptPromise;
		await session.waitForIdle();

		expect(abortSettledBeforeHandler).toBe(true);
		expect(signalWasCancelled).toBe(true);
		expect(extensionErrors).toEqual([]);
		expect(mock.calls).toHaveLength(1);
		expect(session.queuedMessageCount).toBe(0);

		await session.prompt("Second message");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(
			mock.calls[1]?.context.messages.some(message =>
				typeof message.content === "string"
					? message.content.includes("Should not run after abort.")
					: message.content.some(
							content => content.type === "text" && content.text.includes("Should not run after abort."),
						),
			),
		).toBe(false);
	});

	it("does not start any session_stop continuation", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Pass"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn(() => Promise.resolve({ decision: "block" as const, reason: "Run another pass." })),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		await session.prompt("First message");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});

	it("emits session_stop only after empty-stop recovery reaches a final stop", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [{ content: [""] }, { content: ["Recovered"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		await session.prompt("First message");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});

	it("emits session_stop after empty-stop retry cap settles", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [{ content: [""] }, { content: [""] }, { content: [""] }, { content: [""] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		await session.prompt("First message");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});

	it("does not continue session_stop feedback in ACP sessions", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Done"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		let stopCount = 0;
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn(() => {
				stopCount++;
				if (stopCount === 1) {
					return Promise.resolve({ continue: true, additionalContext: "ACP stop continuation." });
				}
				return Promise.resolve(undefined);
			}),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });
		session.setClientBridge({
			capabilities: {},
			deferAgentInitiatedTurns: true,
		});

		await session.prompt("First message");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
	});

	it("does not emit session_stop for subagent sessions", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			handler: () => ({ content: ["Subagent done"] }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner,
			agentKind: "sub",
		});

		await session.prompt("Subagent message");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(extensionRunner.emit).toHaveBeenCalledWith({ type: "agent_end", messages: expect.any(Array) });
		expect(extensionRunner.emitSessionStop).not.toHaveBeenCalled();
	});

	it("should allow prompt() after previous completes", async () => {
		// Create session with a stream that completes immediately
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		// First prompt completes
		await session.prompt("First message");

		// Should not be streaming anymore
		expect(session.isStreaming).toBe(false);

		// Second prompt should work
		await expect(session.prompt("Second message")).resolves.toBe(true);
	});
	it("queues extension follow-up user messages on an idle session without starting a turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		await session.sendUserMessage("hello from session_start", { deliverAs: "followUp" });

		expect(mock.calls).toHaveLength(0);
		expect(session.queuedMessageCount).toBe(1);
	});

	// Regression: a subscriber that fires the next prompt synchronously from the
	// agent_end listener (the shape every wire transport ends up in — rpc-mode
	// stdout subscriber, ACP bridge, Cursor exec) must not collide with the
	// outgoing turn's still-unwinding in-flight bookkeeping. Before the wire-level
	// agent_end was deferred until #promptInFlightCount drops to 0, the
	// subscriber observed agent_end while Session.isStreaming was still true (the
	// agent's own `isStreaming` had flipped, but #promptWithMessage's finally had
	// not yet decremented the prompt-in-flight counter), and the next prompt
	// threw AgentBusyError. Surfaced as `RpcCommandError: prompt: Agent is
	// already processing` from omp-rpc clients (robomp triage reminder path).
	it("subscriber may prompt() synchronously from agent_end without AgentBusyError", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		const observedIsStreamingAtAgentEnd: boolean[] = [];
		const reentrantPromptResults: Array<"resolved" | { error: string }> = [];
		const observedIsStreamingAtRunIdle: boolean[] = [];
		let reentrantPrompted = false;

		session.subscribeRunState(state => {
			if (state === "idle") observedIsStreamingAtRunIdle.push(session.isStreaming);
		});
		session.subscribe(event => {
			if (event.type !== "agent_end") return;
			observedIsStreamingAtAgentEnd.push(session.isStreaming);
			if (reentrantPrompted) return;
			reentrantPrompted = true;
			void session
				.prompt("Second message")
				.then(() => reentrantPromptResults.push("resolved"))
				.catch((err: Error) => reentrantPromptResults.push({ error: err.message }));
		});

		await session.prompt("First message");
		await waitFor(() => reentrantPromptResults.length > 0, 2000);
		await session.waitForIdle();

		expect(observedIsStreamingAtAgentEnd).not.toContain(true);
		expect(observedIsStreamingAtRunIdle).toContain(true);
		expect(reentrantPromptResults).toEqual(["resolved"]);
	});

	it("emits public agent_end before its extension hook settles but keeps waitForIdle authoritative", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const { promise: extensionGate, resolve: releaseExtension } = Promise.withResolvers<void>();
		const extensionRunner = {
			emit: vi.fn((event: { type: string }) =>
				event.type === "agent_end" ? extensionGate : Promise.resolve(undefined),
			),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn().mockReturnValue(false),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner });

		const { promise: publicAgentEnd, resolve: onPublicAgentEnd } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "agent_end") onPublicAgentEnd();
		});

		const prompt = session.prompt("First message");
		await publicAgentEnd;
		expect(extensionRunner.emit).toHaveBeenCalledWith({ type: "agent_end", messages: expect.any(Array) });

		let idleSettled = false;
		const idle = session.waitForIdle().then(() => {
			idleSettled = true;
		});
		await Promise.resolve();
		expect(idleSettled).toBe(false);

		releaseExtension();
		await Promise.all([prompt, idle]);
		expect(idleSettled).toBe(true);
	});

	it("queues idle ACP client-triggered custom messages instead of starting an ownerless turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		session.setClientBridge({
			capabilities: {},
			deferAgentInitiatedTurns: true,
		});

		await session.prompt("First message");
		expect(session.isStreaming).toBe(false);
		const callsAfterFirstPrompt = mock.calls.length;

		const disposition = await session.sendCustomMessage(
			{
				customType: "async-result",
				content: "Background result",
				display: true,
				attribution: "agent",
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		expect(disposition).toEqual({
			status: "downgraded",
			delivery: "queued_next_turn",
			reason: "unscoped_automatic_turn",
		});
		expect(mock.calls).toHaveLength(callsAfterFirstPrompt);
		expect(session.isStreaming).toBe(false);

		await session.prompt("Next user prompt");
		await session.dispose();
		session = undefined as unknown as AgentSession;
		expect(mock.calls).toHaveLength(callsAfterFirstPrompt + 1);
		expect(
			mock.calls.at(-1)?.context.messages.some(message => {
				if (typeof message.content === "string") {
					return message.content.includes("Background result");
				}

				return message.content.some(
					content => content.type === "text" && content.text.includes("Background result"),
				);
			}),
		).toBe(true);
	});

	it("persists owner-scoped ACP async completions without an open origin turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		const ownerId = "acp-session-a";
		const jobGate = Promise.withResolvers<void>();
		const asyncJobManager = new AsyncJobManager({
			maxRunningJobs: 2,
			retentionMs: 1_000,
		});
		AsyncJobManager.setInstance(asyncJobManager);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			agentId: ownerId,
			ownedAsyncJobManager: asyncJobManager,
		});
		session.setClientBridge({
			capabilities: {},
			deferAgentInitiatedTurns: true,
		});
		await session.prompt("First message");
		expect(session.isStreaming).toBe(false);
		const callsAfterFirstPrompt = mock.calls.length;

		try {
			asyncJobManager.register(
				"bash",
				"owned job",
				async () => {
					await jobGate.promise;
					return "Background result";
				},
				{
					id: "owned-job",
					ownerId,
				},
			);
			jobGate.resolve();
			await asyncJobManager.waitForOwnerJobs(ownerId);
			await asyncJobManager.drainDeliveries({ timeoutMs: 1_000, filter: { ownerId } });
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(callsAfterFirstPrompt);
			expect(agent.state.messages.some(message => JSON.stringify(message).includes("Background result"))).toBe(true);
		} finally {
			jobGate.resolve();
		}
	});

	it("scopes ACP async job snapshots and drains to the owning session id", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const modelRegistry = sharedModelRegistry;
		const settings = Settings.isolated();
		const deliveryGate = Promise.withResolvers<void>();
		const delivered: string[] = [];
		const started = new Set<string>();
		const asyncJobManager = new AsyncJobManager({
			maxRunningJobs: 3,
			retentionMs: 1_000,
		});
		AsyncJobManager.setInstance(asyncJobManager);

		const agentA = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ handler: () => ({ content: ["Done"] }) }).stream,
		});
		const agentB = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: createMockModel({ handler: () => ({ content: ["Done"] }) }).stream,
		});
		const sessionB = new AgentSession({
			agent: agentB,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			agentId: "acp-session-b",
			asyncJobManager,
		});
		session = new AgentSession({
			agent: agentA,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			agentId: "acp-session-a",
			ownedAsyncJobManager: asyncJobManager,
		});
		// Override both sessions' self-registered sinks so the test controls
		// delivery timing and records routing order.
		asyncJobManager.registerDeliverySink("acp-session-a", async jobId => {
			started.add(jobId);
			if (jobId === "job-a") {
				await deliveryGate.promise;
			}
			delivered.push(jobId);
		});
		asyncJobManager.registerDeliverySink("acp-session-b", async jobId => {
			started.add(jobId);
			delivered.push(jobId);
		});

		try {
			asyncJobManager.register("bash", "A", async () => "A", { id: "job-a", ownerId: "acp-session-a" });
			await waitFor(() => started.has("job-a"));
			asyncJobManager.register("bash", "B", async () => "B", { id: "job-b", ownerId: "acp-session-b" });
			await waitFor(() => asyncJobManager.getDeliveryState({ ownerId: "acp-session-b" }).queued > 0);

			expect(sessionB.getAsyncJobSnapshot()?.delivery.pendingJobIds).not.toContain("job-a");
			await expect(sessionB.drainAsyncJobDeliveriesForAcp({ timeoutMs: 1_000 })).resolves.toBe(true);
			expect(delivered).toEqual(["job-b"]);
		} finally {
			deliveryGate.resolve();
			await sessionB.dispose();
		}
	});
});

describe("AgentSession TTSR resume gate", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-ttsr-gate-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		vi.restoreAllMocks();
	});

	async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(1);
		}

		throw new Error("Timed out waiting for condition");
	}
	const testRule: Rule = {
		name: "no-unwrap",
		path: "/tmp/no-unwrap.md",
		content: "Do not use .unwrap()",
		condition: ["\\.unwrap\\("],
		_source: { provider: "test", providerName: "test", path: "/tmp/no-unwrap.md", level: "project" },
	};

	function makeMsg(text: string, stopReason: "stop" | "aborted" = "stop"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: Date.now(),
		};
	}

	function pushContinuationStream(stream: AssistantMessageEventStream, onComplete: () => void): void {
		queueMicrotask(() => {
			const partial = makeMsg("");
			stream.push({ type: "start", partial });
			onComplete();
			stream.push({
				type: "done",
				reason: "stop",
				message: makeMsg('Fixed: let val = result.expect("msg")'),
			});
		});
	}

	function pushAbortableTtsrStream(stream: AssistantMessageEventStream, signal: AbortSignal | undefined): void {
		queueMicrotask(() => {
			const partial = makeMsg("");
			stream.push({ type: "start", partial });
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: "let val = result.unwrap(",
				partial: makeMsg("let val = result.unwrap("),
			});
			if (signal) {
				signal.addEventListener(
					"abort",
					() => {
						stream.push({
							type: "error",
							reason: "aborted",
							error: makeMsg("let val = result.unwrap(", "aborted"),
						});
					},
					{ once: true },
				);
			}
		});
	}

	it("prompt() blocks until TTSR interrupt continuation completes", async () => {
		collapseSchedulerSettleDelays();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let continuationCompleted = false;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;

				if (streamCallCount === 1) {
					// First stream: emit text that triggers TTSR, then respond to abort
					pushAbortableTtsrStream(stream, signal);
				} else {
					// Continuation stream: complete normally after a delay
					pushContinuationStream(stream, () => {
						continuationCompleted = true;
					});
				}

				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		// prompt() must block until the TTSR continuation completes
		await session.prompt("Write some Rust code");

		// By the time prompt() returns, the continuation must have finished
		expect(continuationCompleted).toBe(true);
		expect(streamCallCount).toBeGreaterThanOrEqual(2);
		expect(session.isStreaming).toBe(false);
	});

	it("omits extension agent_end for a superseded TTSR settle and does not continue ordinary aborts", async () => {
		collapseSchedulerSettleDelays();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const extensionEmits: Array<{ type: string; willContinue?: boolean }> = [];
		const continuationStarted = Promise.withResolvers<void>();

		let streamCallCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;
				if (streamCallCount === 1) {
					pushAbortableTtsrStream(stream, signal);
				} else {
					pushContinuationStream(stream, () => continuationStarted.resolve());
				}
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		const modelRegistry = sharedModelRegistry;
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_end", event => {
					extensionEmits.push({ type: event.type, willContinue: event.willContinue });
				});
			},
			tempDir,
			new EventBus(),
			extensionRuntime,
			"capture-agent-end",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir,
			sessionManager,
			modelRegistry,
		);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
			extensionRunner,
		});

		const firstGoalEndStarted = Promise.withResolvers<void>();
		const releaseFirstGoalEnd = Promise.withResolvers<void>();
		let goalEndCalls = 0;
		vi.spyOn(GoalRuntime.prototype, "onAgentEnd").mockImplementation(async () => {
			goalEndCalls++;
			if (goalEndCalls !== 1) return;
			firstGoalEndStarted.resolve();
			await releaseFirstGoalEnd.promise;
		});

		const ttsrPrompt = session.prompt("Write some Rust code");
		await firstGoalEndStarted.promise;
		await continuationStarted.promise;
		const pendingClearedWhileMaintenanceBlocked = !session.isTtsrAbortPending;
		releaseFirstGoalEnd.resolve();
		await ttsrPrompt;
		await session.waitForIdle();
		expect(pendingClearedWhileMaintenanceBlocked).toBe(true);

		const ttsrEnds = extensionEmits.filter(event => event.type === "agent_end");
		expect(streamCallCount).toBeGreaterThanOrEqual(2);
		// The intermediate TTSR-abort settle is superseded before public publication,
		// so its extension notification is discarded with it; only the terminal retry settle remains.
		expect(ttsrEnds).toHaveLength(1);
		expect(ttsrEnds[0]?.willContinue).toBeFalsy();

		extensionEmits.length = 0;
		const ordinaryAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;
				queueMicrotask(() => {
					const partial = makeMsg("partial");
					stream.push({ type: "start", partial });
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "partial",
						partial: makeMsg("partial"),
					});
					queueMicrotask(() => {
						session?.agent.abort("user cancelled");
					});
					if (signal) {
						signal.addEventListener(
							"abort",
							() => {
								stream.push({
									type: "error",
									reason: "aborted",
									error: makeMsg("partial", "aborted"),
								});
							},
							{ once: true },
						);
					}
				});
				return stream;
			},
		});
		await session.dispose();
		session = new AgentSession({
			agent: ordinaryAgent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner,
		});

		const promptPromise = session.prompt("user will cancel");
		await session.waitForIdle();
		await promptPromise.catch(() => undefined);

		const ordinaryEnds = extensionEmits.filter(event => event.type === "agent_end");
		expect(ordinaryEnds.length).toBeGreaterThanOrEqual(1);
		for (const event of ordinaryEnds) {
			expect(event.willContinue).toBeFalsy();
		}
	});

	it("labels aborted tool placeholders with the TTSR rule reason", async () => {
		collapseSchedulerSettleDelays();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const toolCallContent: ToolCall = {
			type: "toolCall",
			id: "call_ttsr_abort_reason",
			name: "mock_edit",
			arguments: { snippet: "let val = result.unwrap(" },
		};

		const makeToolCallMsg = (stopReason: "toolUse" | "aborted" = "toolUse"): AssistantMessage => ({
			role: "assistant",
			content: [toolCallContent],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: Date.now(),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;
				if (streamCallCount === 1) {
					queueMicrotask(() => {
						const partial = makeToolCallMsg();
						if (signal) {
							signal.addEventListener(
								"abort",
								() => {
									stream.push({
										type: "error",
										reason: "aborted",
										error: makeToolCallMsg("aborted"),
									});
								},
								{ once: true },
							);
						}
						stream.push({ type: "start", partial });
						stream.push({ type: "toolcall_start", contentIndex: 0, partial });
						stream.push({
							type: "toolcall_delta",
							contentIndex: 0,
							delta: 'let val = result.unwrap("oops")',
							partial,
						});
						// The TTSR abort placeholder is only minted for tool calls that reached
						// `toolcall_end`: the agent loop drops incomplete tool calls from an
						// aborted turn (partial args are unsafe to replay). Complete the call
						// before the rule-driven abort fires so the labeled placeholder survives.
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCallContent, partial });
					});
				} else {
					pushContinuationStream(stream, () => {});
				}
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, ttsrManager });

		await session.prompt("Write some Rust code");

		const toolResult = sessionManager
			.getEntries()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === toolCallContent.id,
			);
		expect(toolResult?.type).toBe("message");
		const text =
			toolResult?.type === "message" && toolResult.message.role === "toolResult"
				? (toolResult.message.content.find((part): part is { type: "text"; text: string } => part.type === "text")
						?.text ?? "")
				: "";
		expect(text).toContain("Tool execution was aborted: TTSR matched rule: no-unwrap");
		expect(text).not.toContain("Request was aborted");
	});

	it("labels only the matching aborted tool placeholder with the TTSR rule reason", async () => {
		collapseSchedulerSettleDelays();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const readToolCallContent: ToolCall = {
			type: "toolCall",
			id: "call_innocent_read",
			name: "read",
			arguments: { path: "history://Eval1WithSkill" },
		};
		const matchedToolCallContent: ToolCall = {
			type: "toolCall",
			id: "call_ttsr_abort_reason",
			name: "mock_edit",
			arguments: { snippet: "let val = result.unwrap(" },
		};

		const makeToolCallMsg = (stopReason: "toolUse" | "aborted" = "toolUse"): AssistantMessage => ({
			role: "assistant",
			content: [readToolCallContent, matchedToolCallContent],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: Date.now(),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;
				if (streamCallCount === 1) {
					queueMicrotask(() => {
						const partial = makeToolCallMsg();
						if (signal) {
							signal.addEventListener(
								"abort",
								() => {
									stream.push({
										type: "error",
										reason: "aborted",
										error: makeToolCallMsg("aborted"),
									});
								},
								{ once: true },
							);
						}
						stream.push({ type: "start", partial });
						stream.push({ type: "toolcall_start", contentIndex: 1, partial });
						stream.push({
							type: "toolcall_delta",
							contentIndex: 1,
							delta: 'let val = result.unwrap("oops")',
							partial,
						});
						// The abort placeholder is only minted for tool calls that reached
						// `toolcall_end`: the agent loop drops incomplete tool calls from an
						// aborted turn (partial args are unsafe to replay). Complete the
						// innocent read before the rule-driven abort fires so its placeholder
						// survives and can carry the neutral sibling label.
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: readToolCallContent, partial });
					});
				} else {
					pushContinuationStream(stream, () => {});
				}
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, ttsrManager });

		await session.prompt("Write some Rust code");

		const toolResults = sessionManager
			.getEntries()
			.filter(entry => entry.type === "message" && entry.message.role === "toolResult")
			.map(entry => (entry.type === "message" && entry.message.role === "toolResult" ? entry.message : undefined))
			.filter(message => message !== undefined);
		const toolResultText = (toolCallId: string): string =>
			toolResults
				.find(message => message.toolCallId === toolCallId)
				?.content.find((part): part is { type: "text"; text: string } => part.type === "text")?.text ?? "";

		const readText = toolResultText(readToolCallContent.id);
		expect(readText).toContain("Tool execution was aborted: TTSR interrupt on another tool call");
		expect(readText).not.toContain("TTSR matched rule: no-unwrap");
		// The matching call never reached `toolcall_end`, so the loop drops it from
		// the aborted turn (partial args are unsafe to replay) and no placeholder is
		// minted. The rule label for a completed matching call is covered by the
		// single-call test above.
		expect(toolResultText(matchedToolCallContent.id)).toBe("");
	});

	it("relativizes the rule file path in the TTSR interrupt injection (no absolute leak)", async () => {
		collapseSchedulerSettleDelays();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;

		const sessionManager = SessionManager.inMemory();
		const cwd = sessionManager.getCwd();
		const ruleAbsPath = path.join(cwd, ".omp", "rules", "no-unwrap.md");
		const expectedRel = path.relative(cwd, ruleAbsPath);
		const rule: Rule = {
			name: "no-unwrap",
			path: ruleAbsPath,
			content: "Do not use .unwrap()",
			condition: ["\\.unwrap\\("],
			_source: { provider: "test", providerName: "test", path: ruleAbsPath, level: "project" },
		};

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(rule);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				if (streamCallCount === 1) {
					pushAbortableTtsrStream(stream, options?.signal);
				} else {
					pushContinuationStream(stream, () => {});
				}
				return stream;
			},
		});

		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, ttsrManager });

		await session.prompt("Write some Rust code");

		const injection = sessionManager
			.getEntries()
			.find(e => e.type === "custom_message" && e.customType === "ttsr-injection");
		expect(injection?.type).toBe("custom_message");
		const content = injection?.type === "custom_message" ? injection.content : undefined;
		expect(typeof content).toBe("string");
		const text = content as string;
		// The rendered interrupt the model receives references the rule by a
		// project-relative path, never the absolute home path.
		expect(text).toContain('reason="rule_violation"');
		expect(text).toContain(`path="${expectedRel}"`);
		expect(text).not.toContain(ruleAbsPath);
	});

	it("prompt() blocks until TTSR deferred continuation completes", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let continuationCompleted = false;

		// interruptMode: "never" -> TTSR match queues deferred injection instead of aborting
		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, _options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();

				if (streamCallCount === 1) {
					// First stream: emit matching text and complete normally
					queueMicrotask(() => {
						const partial = makeMsg("");
						stream.push({ type: "start", partial });
						stream.push({
							type: "text_delta",
							contentIndex: 0,
							delta: "let val = result.unwrap(",
							partial: makeMsg("let val = result.unwrap("),
						});
						// Complete normally (no abort) -- deferred path
						stream.push({
							type: "done",
							reason: "stop",
							message: makeMsg("let val = result.unwrap()"),
						});
					});
				} else {
					// Continuation stream after deferred TTSR injection
					pushContinuationStream(stream, () => {
						continuationCompleted = true;
					});
				}

				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		// prompt() must block until the deferred TTSR continuation completes
		await session.prompt("Write some Rust code");

		// By the time prompt() returns, the deferred continuation must have finished
		expect(continuationCompleted).toBe(true);
		expect(streamCallCount).toBeGreaterThanOrEqual(2);
		expect(session.isStreaming).toBe(false);
	});

	it("prompt() returns immediately when session is aborted during TTSR wait", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: (_model, _context, options) => {
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;

				queueMicrotask(() => {
					const partial = makeMsg("");
					stream.push({ type: "start", partial });
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "result.unwrap(",
						partial: makeMsg("result.unwrap("),
					});
					if (signal) {
						signal.addEventListener(
							"abort",
							() => {
								stream.push({
									type: "error",
									reason: "aborted",
									error: makeMsg("result.unwrap(", "aborted"),
								});
							},
							{ once: true },
						);
					}
				});

				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		// Start prompt (will trigger TTSR and create resume gate)
		const promptPromise = session.prompt("Write some Rust code");
		await waitFor(() => session.isStreaming);

		// Abort session — prompt() should unblock
		await session.abort();
		await promptPromise;

		expect(session.isStreaming).toBe(false);
	});

	it("prompt() waits for TTSR continuation with tool calls to finish", async () => {
		collapseSchedulerSettleDelays();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let toolExecutionFinished = false;
		let allTurnsCompleted = false;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const mockTool: AgentTool = {
			name: "mock_edit",
			label: "Mock Edit",
			description: "A mock edit tool",
			parameters: type({}),
			execute: async () => {
				toolExecutionFinished = true;
				return { content: [{ type: "text" as const, text: "edit applied" }] };
			},
		};

		const toolCallContent: ToolCall = {
			type: "toolCall",
			id: "call_test_001",
			name: "mock_edit",
			arguments: {},
		};

		function makeToolCallMsg(): AssistantMessage {
			return {
				role: "assistant",
				content: [toolCallContent],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
		}

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockTool] },
			streamFn: (_model, _context, options) => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;

				if (streamCallCount === 1) {
					// First stream: emit text that triggers TTSR, then respond to abort
					pushAbortableTtsrStream(stream, signal);
				} else if (streamCallCount === 2) {
					// Continuation: return assistant message with a tool call
					queueMicrotask(() => {
						const msg = makeToolCallMsg();
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
					});
				} else {
					// After tool execution: return final response
					queueMicrotask(() => {
						allTurnsCompleted = true;
						const msg = makeMsg('Fixed: let val = result.expect("msg")');
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					});
				}

				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		// prompt() must block until the TTSR continuation (including tool execution) completes.
		// Before the fix, prompt() returned after the continuation's first assistant message_end,
		// while the agent was still executing tool calls in the background.
		await session.prompt("Write some Rust code");

		// By the time prompt() returns, ALL turns must have completed
		expect(toolExecutionFinished).toBe(true);
		expect(allTurnsCompleted).toBe(true);
		expect(streamCallCount).toBeGreaterThanOrEqual(3);
		expect(session.isStreaming).toBe(false);
	});
	it("interruptMode never folds tool-match reminder into the toolResult instead of driving an extra turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let toolExecuted = false;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const mockTool: AgentTool = {
			name: "mock_edit",
			label: "Mock Edit",
			description: "A mock edit tool",
			parameters: type({ snippet: "string?" }),
			execute: async () => {
				toolExecuted = true;
				return { content: [{ type: "text" as const, text: "edit applied" }] };
			},
		};

		const toolCallContent: ToolCall = {
			type: "toolCall",
			id: "call_never_001",
			name: "mock_edit",
			arguments: { snippet: "let val = result.unwrap()" },
		};

		const makeToolCallMsg = (): AssistantMessage => ({
			role: "assistant",
			content: [toolCallContent],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockTool] },
			streamFn: () => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				if (streamCallCount === 1) {
					// Emit a tool call whose argument delta matches the TTSR rule.
					queueMicrotask(() => {
						const partial = makeToolCallMsg();
						stream.push({ type: "start", partial });
						stream.push({ type: "toolcall_start", contentIndex: 0, partial });
						stream.push({
							type: "toolcall_delta",
							contentIndex: 0,
							delta: 'let val = result.unwrap("oops")',
							partial,
						});
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCallContent, partial });
						stream.push({ type: "done", reason: "toolUse", message: partial });
					});
				} else {
					// Continuation after tool result; finish cleanly.
					queueMicrotask(() => {
						const done = makeMsg("ok");
						stream.push({ type: "start", partial: done });
						stream.push({ type: "done", reason: "stop", message: done });
					});
				}
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		await session.prompt("Write some Rust code");

		// Tool ran (no interrupt) and the loop didn't spawn an extra follow-up turn for injection.
		expect(toolExecuted).toBe(true);
		expect(streamCallCount).toBe(2);

		// The matched tool's result must carry the in-band reminder.
		const toolResult = agent.state.messages.find(
			(m): m is Extract<typeof m, { role: "toolResult" }> =>
				m.role === "toolResult" && m.toolCallId === toolCallContent.id,
		);
		expect(toolResult).toBeDefined();
		const text = Array.isArray(toolResult?.content)
			? toolResult.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map(c => c.text)
					.join("\n")
			: "";
		expect(text).toContain("<system-reminder");
		expect(text).toContain('rule="no-unwrap"');
		expect(text).toContain("Do not use .unwrap()");
		expect(text.indexOf("<system-reminder")).toBeLessThan(text.indexOf("edit applied"));
	});

	it("interruptMode never deduplicates the reminder across sibling tool calls in one batch", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let streamCallCount = 0;
		let executedCount = 0;

		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "never",
			repeatMode: "once",
			repeatGap: 10,
		});
		ttsrManager.addRule(testRule);

		const mockTool: AgentTool = {
			name: "mock_edit",
			label: "Mock Edit",
			description: "A mock edit tool",
			parameters: type({ snippet: "string?" }),
			execute: async () => {
				executedCount++;
				return { content: [{ type: "text" as const, text: "edit applied" }] };
			},
		};

		const toolCallA: ToolCall = {
			type: "toolCall",
			id: "call_dup_A",
			name: "mock_edit",
			arguments: { snippet: "a.unwrap()" },
		};
		const toolCallB: ToolCall = {
			type: "toolCall",
			id: "call_dup_B",
			name: "mock_edit",
			arguments: { snippet: "b.unwrap()" },
		};
		const toolCallC: ToolCall = {
			type: "toolCall",
			id: "call_dup_C",
			name: "mock_edit",
			arguments: { snippet: "c.unwrap()" },
		};

		const makeBatchMsg = (): AssistantMessage => ({
			role: "assistant",
			content: [toolCallA, toolCallB, toolCallC],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockTool] },
			streamFn: () => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				if (streamCallCount === 1) {
					queueMicrotask(() => {
						const partial = makeBatchMsg();
						stream.push({ type: "start", partial });
						const calls: ToolCall[] = [toolCallA, toolCallB, toolCallC];
						for (let i = 0; i < calls.length; i++) {
							const call = calls[i]!;
							stream.push({ type: "toolcall_start", contentIndex: i, partial });
							stream.push({
								type: "toolcall_delta",
								contentIndex: i,
								delta: `let val = result.unwrap("oops-${call.id}")`,
								partial,
							});
							stream.push({ type: "toolcall_end", contentIndex: i, toolCall: call, partial });
						}
						stream.push({ type: "done", reason: "toolUse", message: partial });
					});
				} else {
					queueMicrotask(() => {
						const done = makeMsg("ok");
						stream.push({ type: "start", partial: done });
						stream.push({ type: "done", reason: "stop", message: done });
					});
				}
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const modelRegistry = sharedModelRegistry;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			ttsrManager,
		});

		await session.prompt("Write some Rust code");

		expect(executedCount).toBe(3);
		const toolResults = agent.state.messages.filter(
			(m): m is Extract<typeof m, { role: "toolResult" }> => m.role === "toolResult",
		);
		expect(toolResults).toHaveLength(3);
		const withReminder = toolResults.filter(r =>
			Array.isArray(r.content)
				? r.content.some(c => c.type === "text" && c.text.includes("<system-reminder"))
				: false,
		);
		expect(withReminder).toHaveLength(1);
	});

	it("prompt() waits for context-promotion continuation to finish", async () => {
		collapseSchedulerSettleDelays();
		const authStorage = sharedAuthStorage;
		// The bundled catalog has no codex model whose promotion target carries a
		// strictly larger window (gpt-5.5's bundled target gpt-5.4 is same-window),
		// so pin gpt-5.5 (272k) -> gpt-5.6-sol (372k) via modelOverrides.
		const modelsConfigPath = path.join(tempDir, "models-promo.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					"openai-codex": {
						modelOverrides: {
							"gpt-5.5": { contextPromotionTarget: "openai-codex/gpt-5.6-sol" },
						},
					},
				},
			}),
		);
		const modelRegistry = new ModelRegistry(authStorage, modelsConfigPath);

		const smallModel = modelRegistry.find("openai-codex", "gpt-5.5");
		const largeModel = modelRegistry.find("openai-codex", "gpt-5.6-sol");
		if (!smallModel || !largeModel) {
			throw new Error("Expected small and large codex models to exist");
		}

		let streamCallCount = 0;
		let continuationCompleted = false;

		const makeOverflowMessage = (): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: smallModel.api,
			provider: smallModel.provider,
			model: smallModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "context_length_exceeded: Your input exceeds the context window of this model.",
			timestamp: Date.now(),
		});

		const makeSuccessMessage = (): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text: "Recovered after promotion" }],
			api: largeModel.api,
			provider: largeModel.provider,
			model: largeModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: smallModel, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				streamCallCount++;
				const stream = new AssistantMessageEventStream();
				if (streamCallCount === 1) {
					queueMicrotask(() => {
						const message = makeOverflowMessage();
						stream.push({ type: "start", partial: message });
						stream.push({ type: "error", reason: "error", error: message });
					});
				} else {
					queueMicrotask(() => {
						continuationCompleted = true;
						const message = makeSuccessMessage();
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					});
				}
				return stream;
			},
		});

		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "contextPromotion.enabled": true }),
			modelRegistry,
			extensionRunner,
		});

		await session.prompt("Handle overflow");

		expect(continuationCompleted).toBe(true);
		expect(streamCallCount).toBeGreaterThanOrEqual(2);
		expect(session.model?.id).toBe(largeModel.id);
		expect(session.isStreaming).toBe(false);
		expect(extensionRunner.emitSessionStop).toHaveBeenCalledTimes(1);
	});
});
