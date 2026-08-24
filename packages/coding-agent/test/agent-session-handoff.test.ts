import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, ToolCall } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ExtensionRunner,
	loadExtensionFromFactory,
	loadExtensions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AsyncResultEntry } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionHandoff, type SessionHandoffHost } from "@oh-my-pi/pi-coding-agent/session/session-handoff";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSettingsAwareStreamFn } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

const HANDOFF_SECRET = "HANDOFF_SECRET_TOKEN_12345";
const UNRENDERABLE_SNAPCOMPACT_TEXT = "\uE000\uE001\uE002\uE003\uE004\uE005\uE006\uE007\uE008\uE009";

describe("AgentSession handoff", () => {
	// Immutable across the whole file: the model registry's synchronous bundled-model
	// load dominates per-test setup (~100ms each), and the auth store + bundled model
	// never change. Build them once. Per-test mutable state (session, session file,
	// emitted events) is rebuilt in beforeEach.
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let events: AgentSessionEvent[];
	let obfuscator: SecretObfuscator;

	/** Drain post-turn maintenance deterministically for negative tests (those proving
	 *  maintenance did NOT run, where there is no positive signal to poll on). Post-turn
	 *  work is scheduled fire-and-forget: a single event-loop turn lets the handler run to
	 *  its decision and register any compaction pass as a tracked post-prompt task, then
	 *  `waitForIdle()` drains that task to completion. */
	async function drainMaintenance(): Promise<void> {
		await Bun.sleep(0);
		await session.waitForIdle();
	}

	function mockAutoCompactionPreparation(): string {
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept context" }],
			timestamp: Date.now() - 1,
		});
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue({
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old context" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		});
		return firstKeptEntryId;
	}

	async function prepareIncompleteHandoffRollback(options?: { asyncRollbackFailure?: Error }): Promise<{
		targetFailure: Error;
		eventTypes: string[];
		participantRollback: { advisor: boolean; async: boolean };
	}> {
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		await session.dispose();
		sessionManager = await SessionManager.open(retainedSessionFile, tempDir.path());
		const extensionsResult = await loadExtensions([], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry,
			extensionRunner,
			obfuscator,
			ownedAsyncJobManager: asyncManager,
			agentId: "Main",
		});
		const targetFailure = new Error("handoff target materialization failed");
		const ensureOnDisk = sessionManager.ensureOnDisk.bind(sessionManager);
		vi.spyOn(sessionManager, "ensureOnDisk").mockImplementation(async () => {
			if (session.sessionFile !== retainedSessionFile) throw targetFailure;
			await ensureOnDisk();
		});
		const eventTypes: string[] = [];
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation((event, finalizeBeforeHostCompletion) => {
			eventTypes.push(event.type);
			return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
		});
		const participantRollback = { advisor: false, async: false };
		const beginTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
		vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
			const transaction = beginTransaction(kind);
			if (kind === "advisor" || kind === "async-result") {
				const rollback = transaction.rollback.bind(transaction);
				vi.spyOn(transaction, "rollback").mockImplementation(() => {
					participantRollback[kind === "advisor" ? "advisor" : "async"] = true;
					rollback();
					if (kind === "async-result" && options?.asyncRollbackFailure) throw options.asyncRollbackFailure;
				});
			}
			return transaction;
		});
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");
		return { targetFailure, eventTypes, participantRollback };
	}

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-handoff-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) {
			throw new Error("Expected built-in anthropic model to exist");
		}
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-handoff-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];
		obfuscator = new SecretObfuscator([{ type: "plain", content: HANDOFF_SECRET }]);

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
				"compaction.keepRecentTokens": 1,
			}),
			modelRegistry,
			obfuscator,
		});

		session.subscribe(event => {
			events.push(event);
		});

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("rejects a scoped peer wake while handoff generation owns the session", async () => {
		const handoffStarted = Promise.withResolvers<void>();
		const handoffGenerated = Promise.withResolvers<string>();
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockImplementation(async () => {
			handoffStarted.resolve();
			return await handoffGenerated.promise;
		});
		let committed = false;

		const handoff = session.handoff();
		await handoffStarted.promise;
		expect(session.isGeneratingHandoff).toBe(true);
		const disposition = await session.sendCustomMessage(
			{ customType: "peer-message", content: "wait for handoff", display: true, attribution: "agent" },
			{
				deliveryMode: "auto",
				automaticTurnSource: "peer_message_wake",
				onStartedTurnAccepted: () => {
					committed = true;
				},
			},
		);
		const agentMessagesDuringHandoff = [...session.agent.state.messages];
		const branchDuringHandoff = sessionManager.getBranch();

		handoffGenerated.resolve("## Goal\nContinue from here");
		await handoff;

		expect(disposition).toEqual({ status: "unavailable", reason: "session_transition" });
		expect(committed).toBe(false);
		expect(agentMessagesDuringHandoff).toHaveLength(0);
		expect(branchDuringHandoff).toHaveLength(2);
	});

	it("rejects a normal prompt while handoff generation owns the session", async () => {
		const handoffStarted = Promise.withResolvers<void>();
		const handoffGenerated = Promise.withResolvers<string>();
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockImplementation(async () => {
			handoffStarted.resolve();
			return await handoffGenerated.promise;
		});
		const mock = createMockModel({ handler: () => ({ content: ["must not run"] }) });
		session.agent.streamFn = mock.stream;

		const handoff = session.handoff();
		await handoffStarted.promise;
		try {
			const blockedPrompts = [
				() => session.prompt("must not be lost during handoff"),
				() => session.prompt("must not queue during handoff", { streamingBehavior: "steer" }),
				() => session.steer("must not steer during handoff"),
				() => session.followUp("must not follow up during handoff"),
				() => session.sendUserMessage("must not send during handoff", { deliverAs: "followUp" }),
			];
			for (const send of blockedPrompts) {
				await expect(send()).rejects.toThrow("Session transition in progress");
			}
			expect(mock.calls).toHaveLength(0);
			expect(session.agent.peekSteeringQueue()).toHaveLength(0);
			expect(session.agent.peekFollowUpQueue()).toHaveLength(0);
			expect(JSON.stringify(session.agent.state.messages)).not.toContain("must not");
			expect(JSON.stringify(sessionManager.getBranch())).not.toContain("must not");
		} finally {
			handoffGenerated.resolve("## Goal\nContinue from here");
			await handoff;
		}
	});

	it("rejects a prompt before handoff acquires the lifecycle fence", async () => {
		const apiKeyStarted = Promise.withResolvers<void>();
		const releaseApiKey = Promise.withResolvers<void>();
		vi.spyOn(modelRegistry, "getApiKey").mockImplementationOnce(async () => {
			apiKeyStarted.resolve();
			await releaseApiKey.promise;
			return "test-key";
		});
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");
		const mock = createMockModel({ handler: () => ({ content: ["must not run"] }) });
		session.agent.streamFn = mock.stream;

		const handoff = session.handoff();
		await apiKeyStarted.promise;
		try {
			expect(session.isGeneratingHandoff).toBe(true);
			await expect(session.prompt("must not start before handoff fence")).rejects.toThrow(
				"Session transition in progress",
			);
			expect(mock.calls).toHaveLength(0);
		} finally {
			releaseApiKey.resolve();
			await handoff;
		}
	});

	it("rejects a concurrent direct handoff without losing the first abort owner", async () => {
		const started = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<string>();
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockImplementation((_context, _model, options) => {
				started.resolve();
				options.streamOptions.signal?.addEventListener(
					"abort",
					() => cancelled.reject(new Error("provider request aborted")),
					{ once: true },
				);
				return cancelled.promise;
			});

		const first = session.handoff();
		await started.promise;
		await expect(session.handoff()).rejects.toThrow("Handoff generation is already in progress");
		expect(session.isGeneratingHandoff).toBe(true);

		const abort = session.abort({ reason: "Cancel the original handoff" });
		await expect(first).rejects.toThrow("Cancel the original handoff");
		await abort;

		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(session.isGeneratingHandoff).toBe(false);
	});

	it("aborts after document generation while retained flush is pending before creating a target", async () => {
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedEntryIds = sessionManager.getEntries().map(entry => entry.id);
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");

		let retainedCaptured = false;
		const capturePersistedSessionFile = sessionManager.capturePersistedSessionFile.bind(sessionManager);
		vi.spyOn(sessionManager, "capturePersistedSessionFile").mockImplementation(async () => {
			const snapshot = await capturePersistedSessionFile();
			retainedCaptured = true;
			return snapshot;
		});
		const flushStarted = Promise.withResolvers<void>();
		const releaseFlush = Promise.withResolvers<void>();
		let blocked = false;
		const flush = sessionManager.flush.bind(sessionManager);
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			if (retainedCaptured && !blocked) {
				blocked = true;
				flushStarted.resolve();
				await releaseFlush.promise;
			}
			await flush();
		});
		const newSession = vi.spyOn(sessionManager, "newSession");

		const handoff = session.handoff();
		await flushStarted.promise;
		const abort = session.abort({ reason: "Abort during handoff flush" });
		releaseFlush.resolve();

		await expect(handoff).rejects.toThrow("Abort during handoff flush");
		await abort;
		expect(newSession).not.toHaveBeenCalled();
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(sessionManager.getEntries().map(entry => entry.id)).toEqual(retainedEntryIds);
	});

	it("rolls back an abort during target materialization before handoff commit", async () => {
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedEntryIds = sessionManager.getEntries().map(entry => entry.id);
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");

		const materializationStarted = Promise.withResolvers<void>();
		const releaseMaterialization = Promise.withResolvers<void>();
		let replacementSessionFile: string | undefined;
		const ensureOnDisk = sessionManager.ensureOnDisk.bind(sessionManager);
		vi.spyOn(sessionManager, "ensureOnDisk").mockImplementation(async () => {
			if (session.sessionFile !== retainedSessionFile) {
				replacementSessionFile = session.sessionFile;
				materializationStarted.resolve();
				await releaseMaterialization.promise;
			}
			await ensureOnDisk();
		});
		const closeProviderSession = vi.fn();
		session.providerSessionState.set("late-abort-materialization", { close: closeProviderSession });

		const handoff = session.handoff();
		await materializationStarted.promise;
		const abort = session.abort({ reason: "Abort during target materialization" });
		releaseMaterialization.resolve();

		await expect(handoff).rejects.toThrow("Abort during target materialization");
		await abort;
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(sessionManager.getEntries().map(entry => entry.id)).toEqual(retainedEntryIds);
		expect(closeProviderSession).not.toHaveBeenCalled();
		expect(replacementSessionFile).toBeString();
		expect(await Bun.file(replacementSessionFile!).exists()).toBe(false);
	});

	it("rolls back an abort during session_ready before commit activation", async () => {
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		await session.dispose();
		sessionManager = await SessionManager.open(retainedSessionFile, tempDir.path());

		const readyStarted = Promise.withResolvers<void>();
		const releaseReady = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn(() => false),
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeSessionMutation: vi.fn().mockResolvedValue(undefined),
			emitWithHostCompletion: vi.fn(
				async (event: { type: string }, prepare?: () => void | Promise<void | (() => void | Promise<void>)>) => {
					const prepared = await prepare?.();
					if (event.type === "session_ready") {
						readyStarted.resolve();
						await releaseReady.promise;
					}
					if (typeof prepared === "function") await prepared();
				},
			),
		} as unknown as ExtensionRunner;
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
			}),
			modelRegistry,
			extensionRunner,
			obfuscator,
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const retainedEntryIds = sessionManager.getEntries().map(entry => entry.id);
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");
		const closeProviderSession = vi.fn();
		session.providerSessionState.set("late-abort-ready", { close: closeProviderSession });

		const handoff = session.handoff();
		await readyStarted.promise;
		const abort = session.abort({ reason: "Abort during session_ready" });
		releaseReady.resolve();

		await expect(handoff).rejects.toThrow("Abort during session_ready");
		await abort;
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(sessionManager.getEntries().map(entry => entry.id)).toEqual(retainedEntryIds);
		expect(closeProviderSession).not.toHaveBeenCalled();
		expect(extensionRunner.emitWithHostCompletion).toHaveBeenCalledWith(
			{ type: "session_rollback" },
			expect.any(Function),
		);
	});

	it("cancels speculation before delegating an explicit handoff", async () => {
		const order: string[] = [];
		vi.spyOn(SessionMaintenance.prototype, "cancelSpeculation").mockImplementation(() => {
			order.push("cancel");
		});
		vi.spyOn(SessionHandoff.prototype, "handoffToNewSession").mockImplementation(async () => {
			order.push("delegate");
			return { document: "## Goal\nExplicit handoff" };
		});

		await expect(session.handoff()).resolves.toMatchObject({ document: "## Goal\nExplicit handoff" });
		expect(order).toEqual(["cancel", "delegate"]);
	});

	it("leaves no orphan file when deferred speculative handoff generation is discarded", async () => {
		session.settings.set("compaction.handoffSaveToDisk", true);
		const artifactsDir = sessionManager.getArtifactsDir();
		if (!artifactsDir) throw new Error("Expected artifacts directory");
		await fs.mkdir(artifactsDir, { recursive: true });
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nSpeculative handoff");
		const handoffHost = {
			agent: session.agent,
			sessionManager,
			settings: session.settings,
			modelRegistry,
			extensionRunner: undefined,
			sideStreamFn: async () => {
				throw new Error("Mocked handoff generation should not stream");
			},
			obfuscator,
			model: () => model,
			thinkingLevel: () => undefined,
			sessionId: () => sessionManager.getSessionId(),
			baseSystemPrompt: () => ["Test"],
			obfuscateTextForProvider: text => text,
			deobfuscateFromProvider: text => text,
			convertMessagesToLlm: async () => [],
			prepareSimpleStreamOptions: options => options,
			effectiveServiceTier: () => undefined,
		} satisfies Partial<SessionHandoffHost>;
		const handoff = new SessionHandoff(handoffHost as unknown as SessionHandoffHost);

		const result = await handoff.generateDocument(undefined, { autoTriggered: true }, true);

		expect(result?.document).toBe("## Goal\nSpeculative handoff");
		expect(result?.savedPath).toBeUndefined();
		expect((await fs.readdir(artifactsDir)).filter(file => /^handoff-.*\.md$/.test(file))).toEqual([]);
	});

	it("waits for an accepted peer wake to finish before capturing the handoff snapshot", async () => {
		const beforeStartEntered = Promise.withResolvers<void>();
		const releaseBeforeStart = Promise.withResolvers<void>();
		const responseAccepted = Promise.withResolvers<void>();
		const releaseResponse = Promise.withResolvers<void>();
		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const initialUser = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "seed" }],
			timestamp: Date.now() - 2,
		};
		const initialAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		};
		const initialMessages: AgentMessage[] = [initialUser, initialAssistant];
		sessionManager.appendMessage(initialUser);
		sessionManager.appendMessage(initialAssistant);
		const extensionRunner = {
			hasHandlers: vi.fn(() => false),
			emitBeforeAgentStart: vi.fn(async () => {
				beforeStartEntered.resolve();
				await releaseBeforeStart.promise;
				return undefined;
			}),
			emitBeforeSessionMutation: vi.fn().mockResolvedValue(undefined),
			emit: vi.fn().mockResolvedValue(undefined),
			emitWithHostCompletion: vi.fn(async (_event: { type: string }, completion?: () => void | Promise<void>) => {
				await completion?.();
			}),
		} as unknown as ExtensionRunner;
		const wakeResponse = "slow wake response";
		const wakeStream: StreamFn = (requestModel, _context, options) => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(async () => {
				await options?.onResponse?.({ status: 200, headers: { "x-test": "accepted" } }, requestModel);
				responseAccepted.resolve();
				await releaseResponse.promise;
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: wakeResponse }],
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
						stopReason: "stop",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						timestamp: Date.now(),
					},
				});
			});
			return stream;
		};
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: initialMessages },
				streamFn: wakeStream,
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry,
			extensionRunner,
			obfuscator,
		});

		let capturedMessages = "";
		const generationStarted = Promise.withResolvers<void>();
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockImplementation(async context => {
				capturedMessages = JSON.stringify(context.messages);
				generationStarted.resolve();
				return "## Goal\nContinue from here";
			});
		const wakeText = "include this accepted wake in the handoff snapshot";
		const sending = session.sendCustomMessage(
			{ customType: "peer-message", content: wakeText, display: true, attribution: "agent" },
			{ deliveryMode: "auto", automaticTurnSource: "peer_message_wake" },
		);
		await beforeStartEntered.promise;

		const handingOff = session.handoff();
		try {
			await Promise.race([generationStarted.promise, Bun.sleep(50)]);
			expect(generateHandoffSpy).not.toHaveBeenCalled();

			releaseBeforeStart.resolve();
			await responseAccepted.promise;
			await expect(sending).resolves.toEqual({ status: "accepted", delivery: "started_turn" });
			await Promise.race([generationStarted.promise, Bun.sleep(50)]);
			expect(generateHandoffSpy).not.toHaveBeenCalled();

			releaseResponse.resolve();
			await expect(handingOff).resolves.toMatchObject({ document: "## Goal\nContinue from here" });
			expect(capturedMessages).toContain(wakeText);
			expect(capturedMessages).toContain(wakeResponse);
			expect(JSON.stringify(session.agent.state.messages)).not.toContain(wakeResponse);
		} finally {
			releaseBeforeStart.resolve();
			releaseResponse.resolve();
			await Promise.allSettled([sending, handingOff]);
		}
	});

	it("cancels while semantic acceptance is pending and releases the handoff fence", async () => {
		const beforeStartEntered = Promise.withResolvers<void>();
		const releaseBeforeStart = Promise.withResolvers<void>();
		const beforeSwitch = Promise.withResolvers<void>();
		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const initialUser = { role: "user" as const, content: "seed", timestamp: Date.now() - 2 };
		const initialAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		};
		sessionManager.appendMessage(initialUser);
		sessionManager.appendMessage(initialAssistant);
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_switch"),
			emitBeforeAgentStart: vi.fn(async () => {
				beforeStartEntered.resolve();
				await releaseBeforeStart.promise;
				return undefined;
			}),
			emit: vi.fn(async (event: { type: string }) => {
				if (event.type === "session_before_switch") beforeSwitch.resolve();
			}),
			emitBeforeSessionMutation: vi.fn().mockResolvedValue(undefined),
			emitWithHostCompletion: vi.fn(async (_event: { type: string }, completion?: () => void | Promise<void>) => {
				await completion?.();
			}),
		} as unknown as ExtensionRunner;
		const mock = createMockModel({ handler: () => ({ content: ["done"] }) });
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [initialUser, initialAssistant] },
				streamFn: mock.stream,
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry,
			extensionRunner,
			obfuscator,
		});

		const sending = session.sendCustomMessage(
			{ customType: "peer-message", content: "pending wake", display: true, attribution: "agent" },
			{ deliveryMode: "auto", automaticTurnSource: "peer_message_wake" },
		);
		await beforeStartEntered.promise;
		const controller = new AbortController();
		const handingOff = session.handoff(undefined, { signal: controller.signal });
		await beforeSwitch.promise;
		await Bun.sleep(0);

		await expect(
			session.sendCustomMessage(
				{ customType: "probe", content: "fenced", display: false, attribution: "agent" },
				{ deliveryMode: "steer" },
			),
		).resolves.toEqual({ status: "unavailable", reason: "session_transition" });
		controller.abort();
		await expect(withTimeout(handingOff, 1_000, "Handoff cancellation timed out")).rejects.toThrow(
			"Handoff cancelled",
		);
		await expect(
			session.sendCustomMessage(
				{ customType: "probe", content: "after cancel", display: false, attribution: "agent" },
				{ deliveryMode: "steer" },
			),
		).resolves.toMatchObject({ status: "accepted" });

		releaseBeforeStart.resolve();
		await expect(sending).resolves.toEqual({ status: "accepted", delivery: "started_turn" });
		await session.waitForIdle();
	});

	it("does not run auto-compaction after handoff turn completes", async () => {
		const handoffText = "## Goal\nContinue from here";
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue(handoffText);

		const result = await session.handoff();
		await drainMaintenance();

		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(result?.document).toBe(handoffText);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
	});

	it("clears staged preview state when handoff creates the replacement session", async () => {
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");
		session.toolChoiceQueue.registerPendingInvoker("old-session-preview", "ast_edit", async () => ({
			content: [{ type: "text", text: "applied old preview" }],
		}));
		expect(session.peekPendingInvoker()).toBeDefined();
		expect(session.nextToolChoiceDirective()).toBeDefined();

		await session.handoff();

		expect(session.peekPendingInvoker()).toBeUndefined();
		expect(session.nextToolChoiceDirective()).toBeUndefined();
	});

	it("carries local:// artifacts into the handed-off session", async () => {
		// Handoff is a continuity operation: the generated document references
		// plans/scratch files the old session wrote under its local:// root. The
		// fresh session mints a new local root, so the artifacts must be copied
		// forward or every reference the handoff document carries dangles.
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");
		const localOptions = {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		};
		const oldLocalRoot = resolveLocalUrlToPath("local://", localOptions);
		const oldPlanPath = resolveLocalUrlToPath("local://my-plan.md", localOptions);
		const oldNestedPath = resolveLocalUrlToPath("local://research/notes.txt", localOptions);
		await fs.mkdir(path.dirname(oldNestedPath), { recursive: true });
		await Bun.write(oldPlanPath, "# Plan\n\nbody\n");
		await Bun.write(oldNestedPath, "scratch notes");

		await session.handoff();

		const newLocalRoot = resolveLocalUrlToPath("local://", localOptions);
		expect(newLocalRoot).not.toBe(oldLocalRoot);
		expect(await Bun.file(resolveLocalUrlToPath("local://my-plan.md", localOptions)).text()).toBe("# Plan\n\nbody\n");
		expect(await Bun.file(resolveLocalUrlToPath("local://research/notes.txt", localOptions)).text()).toBe(
			"scratch notes",
		);
		// The source session's artifacts remain untouched on disk.
		expect(await Bun.file(oldPlanPath).text()).toBe("# Plan\n\nbody\n");
	});

	it("emits handoff lifecycle hooks on the outgoing and replacement sessions", async () => {
		// dispose() is terminal: it closes the manager and releases its in-memory
		// transcript. Reopen the persisted session file for the replacement
		// session, as production revival paths do.
		await session.dispose();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		sessionManager = await SessionManager.open(sessionFile, tempDir.path());
		const extensionsResult = await loadExtensions([], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const observedEvents: Array<{
			type: "session_before_switch" | "session_switch";
			reason: string;
			previousSessionFile: string | undefined;
			activeSessionFile: string | undefined;
			messageCount: number;
			handoffEntryCount: number;
		}> = [];
		vi.spyOn(extensionRunner, "hasHandlers").mockImplementation(eventName => eventName === "session_before_switch");
		const emit = extensionRunner.emit.bind(extensionRunner);
		const completionSpy = vi.spyOn(extensionRunner, "emitWithHostCompletion");
		vi.spyOn(extensionRunner, "emit").mockImplementation(event => {
			if (event.type === "session_before_switch" || event.type === "session_switch") {
				observedEvents.push({
					type: event.type,
					reason: event.reason,
					previousSessionFile: event.type === "session_switch" ? event.previousSessionFile : undefined,
					activeSessionFile: session.sessionFile,
					messageCount: sessionManager.getBranch().filter(entry => entry.type === "message").length,
					handoffEntryCount: sessionManager
						.getBranch()
						.filter(entry => entry.type === "custom_message" && entry.customType === "handoff").length,
				});
			}
			return emit(event);
		});

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
			}),
			modelRegistry,
			extensionRunner,
			obfuscator,
		});
		const previousSessionFile = session.sessionFile;
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("## Goal\nContinue from here");
		const closeProviderSession = vi.fn();
		session.providerSessionState.set("handoff-test", { close: closeProviderSession });

		await session.handoff();

		const nextSessionFile = session.sessionFile;
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(nextSessionFile).not.toBe(previousSessionFile);
		expect(observedEvents).toEqual([
			{
				type: "session_before_switch",
				reason: "handoff",
				previousSessionFile: undefined,
				activeSessionFile: previousSessionFile,
				messageCount: 2,
				handoffEntryCount: 0,
			},
			{
				type: "session_switch",
				reason: "handoff",
				previousSessionFile,
				activeSessionFile: previousSessionFile,
				messageCount: 2,
				handoffEntryCount: 0,
			},
		]);
		expect(completionSpy).toHaveBeenCalledWith({ type: "session_ready" }, expect.any(Function));
		expect(closeProviderSession).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("preserves durable journal mutations when handoff flush fails before the post-quiescence capture", async () => {
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedEntries = structuredClone(sessionManager.getEntries());
		const retainedMessages = structuredClone(session.messages);

		const failure = new Error("handoff retained flush failed after mutation");
		const mutationText = "durable handoff mutation";
		let flushCalls = 0;
		let durableMutationRaw: string | undefined;
		const flush = sessionManager.flush.bind(sessionManager);
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			const call = ++flushCalls;
			if (call === 2) {
				sessionManager.appendMessage({ role: "user", content: mutationText, timestamp: 99 });
				session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			}
			await flush();
			if (call === 2) durableMutationRaw = await Bun.file(retainedSessionFile).text();
			if (call === 2) throw failure;
		});
		let captureCalls = 0;
		const capturePersistedSessionFile = sessionManager.capturePersistedSessionFile.bind(sessionManager);
		vi.spyOn(sessionManager, "capturePersistedSessionFile").mockImplementation(async () => {
			const snapshot = await capturePersistedSessionFile();
			captureCalls++;
			return snapshot;
		});
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");

		await expect(session.handoff()).rejects.toBe(failure);

		if (durableMutationRaw === undefined) throw new Error("Expected durable handoff mutation bytes");
		expect(flushCalls).toBe(3);
		expect(durableMutationRaw).toContain(mutationText);
		expect(captureCalls).toBe(2); // Initial checkpoint plus rollback preservation; recapture was not reached.
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(sessionManager.getEntries()).toEqual([
			...retainedEntries,
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({ role: "user", content: mutationText, timestamp: 99 }),
			}),
		]);
		expect(session.messages).toEqual(retainedMessages);
		expect(await Bun.file(retainedSessionFile).text()).toBe(durableMutationRaw);
	});

	it("restores retained state and removes a failed replacement before handoff rollback", async () => {
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const previousSessionFile = session.sessionFile;
		if (!previousSessionFile) throw new Error("Expected retained session file");
		await session.dispose();
		sessionManager = await SessionManager.open(previousSessionFile, tempDir.path());
		const extensionsResult = await loadExtensions([], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
			}),
			modelRegistry,
			extensionRunner,
			obfuscator,
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const retainedEntries = sessionManager.getEntries().map(entry => entry.id);
		const retainedMessages = [...session.messages];
		const retainedSystemPrompt = [...session.agent.state.systemPrompt];
		const checkpoint = { checkpointMessageCount: 2, checkpointEntryId: "handoff-checkpoint", startedAt: "start" };
		const retainedSteer: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "retained steer" }],
			attribution: "user",
			timestamp: 3,
		};
		const retainedFollowUp: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "retained follow-up" }],
			attribution: "user",
			timestamp: 4,
		};
		session.setCheckpointState(checkpoint);
		session.setPlanReferencePath("local://HANDOFF-RETAINED.md");
		session.agent.replaceQueues([retainedSteer], [retainedFollowUp]);
		const retainedPreview = (input: unknown) => input;
		session.toolChoiceQueue.registerPendingInvoker("handoff-retained-preview", "ast_edit", retainedPreview);

		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");
		let replacementSessionFile: string | undefined;
		const failure = new Error("handoff target materialization failed");
		const ensureOnDisk = sessionManager.ensureOnDisk.bind(sessionManager);
		vi.spyOn(sessionManager, "ensureOnDisk").mockImplementation(async () => {
			if (sessionManager.getSessionFile() !== previousSessionFile) {
				replacementSessionFile = sessionManager.getSessionFile();
				session.agent.setSystemPrompt(["replacement prompt"]);
				throw failure;
			}
			await ensureOnDisk();
		});

		let rollbackAtDispatch:
			| {
					sessionFile: string | undefined;
					entries: string[];
					messages: AgentMessage[];
					checkpoint: unknown;
					steering: AgentMessage[];
					followUp: AgentMessage[];
					systemPrompt: string[];
					planReferencePath: string;
					preview: ((input: unknown) => unknown) | undefined;
			  }
			| undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation((event, finalizeBeforeHostCompletion) => {
			if (event.type === "session_rollback") {
				rollbackAtDispatch = {
					sessionFile: session.sessionFile,
					entries: sessionManager.getEntries().map(entry => entry.id),
					messages: [...session.messages],
					checkpoint: session.getCheckpointState(),
					steering: [...session.agent.peekSteeringQueue()],
					followUp: [...session.agent.peekFollowUpQueue()],
					systemPrompt: session.agent.state.systemPrompt,
					planReferencePath: session.getPlanReferencePath(),
					preview: session.peekPendingInvoker(),
				};
			}
			return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
		});

		await expect(session.handoff()).rejects.toBe(failure);
		expect(rollbackAtDispatch).toEqual({
			sessionFile: previousSessionFile,
			entries: retainedEntries,
			messages: retainedMessages,
			checkpoint,
			steering: [retainedSteer],
			followUp: [retainedFollowUp],
			systemPrompt: retainedSystemPrompt,
			planReferencePath: "local://HANDOFF-RETAINED.md",
			preview: retainedPreview,
		});
		expect(await Bun.file(previousSessionFile).exists()).toBe(true);
		expect(replacementSessionFile).toBeString();
		expect(await Bun.file(replacementSessionFile!).exists()).toBe(false);
	});

	it("suppresses handoff rollback publication when replacement cleanup fails but releases advisor and async transitions", async () => {
		const fixture = await prepareIncompleteHandoffRollback();
		const cleanupFailure = new Error("replacement cleanup failed");
		vi.spyOn(sessionManager, "dropSession").mockRejectedValue(cleanupFailure);

		let thrown: unknown;
		try {
			await session.handoff();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AggregateError);
		const rollbackError = thrown as AggregateError;
		expect(rollbackError.message).toBe("Handoff failed and rollback was incomplete");
		expect(sessionManager.dropSession).toHaveBeenCalledTimes(1);
		expect(rollbackError.errors).toContain(fixture.targetFailure);
		const retainedRestoreError = rollbackError.errors.find(
			error => error instanceof AggregateError,
		) as AggregateError;
		expect(retainedRestoreError.errors).toContain(cleanupFailure);
		expect(fixture.eventTypes).not.toContain("session_rollback");
		expect(fixture.participantRollback).toEqual({ advisor: true, async: true });
	});

	it("suppresses handoff rollback publication when retained JSONL restoration fails but releases advisor and async transitions", async () => {
		const fixture = await prepareIncompleteHandoffRollback();
		const durableFailure = new Error("retained journal restore failed");
		vi.spyOn(sessionManager, "restorePersistedSessionFile").mockRejectedValue(durableFailure);

		let thrown: unknown;
		try {
			await session.handoff();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AggregateError);
		const rollbackError = thrown as AggregateError;
		expect(rollbackError.message).toBe("Handoff failed and rollback was incomplete");
		expect(sessionManager.restorePersistedSessionFile).toHaveBeenCalledTimes(1);
		expect(rollbackError.errors).toContain(fixture.targetFailure);
		const retainedRestoreError = rollbackError.errors.find(
			error => error instanceof AggregateError,
		) as AggregateError;
		expect(retainedRestoreError.errors).toContain(durableFailure);
		expect(fixture.eventTypes).not.toContain("session_rollback");
		expect(fixture.participantRollback).toEqual({ advisor: true, async: true });
	});

	it("suppresses handoff rollback publication when retained JSONL restoration returns false", async () => {
		const fixture = await prepareIncompleteHandoffRollback();
		const rewriteEntries = vi.spyOn(sessionManager, "rewriteEntries");
		vi.spyOn(sessionManager, "restorePersistedSessionFile").mockResolvedValue(false);

		let thrown: unknown;
		try {
			await session.handoff();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AggregateError);
		const rollbackError = thrown as AggregateError;
		expect(rollbackError.message).toBe("Handoff failed and rollback was incomplete");
		expect(sessionManager.restorePersistedSessionFile).toHaveBeenCalledTimes(1);
		expect(rewriteEntries).toHaveBeenCalledTimes(1);
		expect(rollbackError.errors).toContain(fixture.targetFailure);
		const retainedRestoreError = rollbackError.errors.find(
			error => error instanceof AggregateError,
		) as AggregateError;
		expect(retainedRestoreError.errors).toContainEqual(
			expect.objectContaining({ message: "Retained session journal preimage could not be restored" }),
		);
		expect(fixture.eventTypes).not.toContain("session_rollback");
		expect(fixture.participantRollback).toEqual({ advisor: true, async: true });
	});

	it("suppresses handoff rollback publication when async release fails after retained restoration", async () => {
		const asyncRollbackFailure = new Error("retained async release failed");
		const fixture = await prepareIncompleteHandoffRollback({ asyncRollbackFailure });

		let thrown: unknown;
		try {
			await session.handoff();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AggregateError);
		const rollbackError = thrown as AggregateError;
		expect(rollbackError.message).toBe("Handoff failed and rollback was incomplete");
		expect(rollbackError.errors).toEqual(expect.arrayContaining([fixture.targetFailure, asyncRollbackFailure]));
		expect(fixture.participantRollback).toEqual({ advisor: true, async: true });
		expect(fixture.eventTypes).not.toContain("session_rollback");
	});

	it("keeps direct user delivery authoritative after rollback without an aside-created turn", async () => {
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		await session.dispose();
		sessionManager = await SessionManager.open(retainedSessionFile, tempDir.path());
		const extensionsResult = await loadExtensions([], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		const deliveredContexts: string[] = [];
		const primaryMock = createMockModel({
			handler: context => {
				deliveredContexts.push(JSON.stringify(context.messages));
				return { content: ["primary reply"] };
			},
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: primaryMock.stream,
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry,
			extensionRunner,
			obfuscator,
			ownedAsyncJobManager: asyncManager,
			agentId: "Main",
		});
		session.settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		expect(session.toggleAdvisorEnabled()).toBe(true);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const retainedFollowUpMarker = "retained handoff follow-up";
		session.agent.replaceQueues(
			[],
			[
				{
					role: "user",
					content: [{ type: "text", text: retainedFollowUpMarker }],
					attribution: "user",
					timestamp: 2,
				},
			],
		);
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");

		let advisorReceiptResolutions = 0;
		let advisorReceiptRejections = 0;
		const advisorReceipt = session.yieldQueue.enqueueWithReceipt("advisor", {
			note: "retained handoff advisor receipt",
			severity: "nit" as const,
			advisor: undefined,
		});
		void advisorReceipt.then(
			() => advisorReceiptResolutions++,
			() => advisorReceiptRejections++,
		);
		let asyncReceiptResolutions = 0;
		let asyncReceiptRejections = 0;
		let asyncReceipt: Promise<void> | undefined;
		const beginTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
		vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
			if (kind === "async-result" && !asyncReceipt) {
				asyncReceipt = session.yieldQueue.enqueueWithReceipt<AsyncResultEntry>("async-result", {
					jobId: "retained-handoff-queued-receipt",
					result: "retained queued async receipt",
					job: undefined,
					durationMs: 0,
					epoch: 0,
				});
				void asyncReceipt.then(
					() => asyncReceiptResolutions++,
					() => asyncReceiptRejections++,
				);
			}
			return beginTransaction(kind);
		});
		const jobGate = Promise.withResolvers<string>();
		const jobId = asyncManager.register("task", "retained handoff deferred job", () => jobGate.promise, {
			id: "retained-handoff-deferred-job",
			ownerId: "Main",
		});
		const targetEnsureStarted = Promise.withResolvers<void>();
		const continueTargetEnsure = Promise.withResolvers<void>();
		const ensureOnDisk = sessionManager.ensureOnDisk.bind(sessionManager);
		vi.spyOn(sessionManager, "ensureOnDisk").mockImplementation(async () => {
			if (session.sessionFile !== retainedSessionFile) {
				targetEnsureStarted.resolve();
				await continueTargetEnsure.promise;
			}
			await ensureOnDisk();
		});
		const failure = new Error("handoff readiness failed");
		let readyState: { advisor: number; async: number; advisorQueued: boolean; asyncQueued: boolean } | undefined;
		let rollbackState:
			| {
					advisor: number;
					async: number;
					advisorQueued: boolean;
					asyncQueued: boolean;
					followUpQueued: boolean;
					providerCalls: number;
					jobStatus: string | undefined;
			  }
			| undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_ready") {
					readyState = {
						advisor: advisorReceiptResolutions + advisorReceiptRejections,
						async: asyncReceiptResolutions + asyncReceiptRejections,
						advisorQueued: session.yieldQueue.has("advisor"),
						asyncQueued: session.yieldQueue.has("async-result"),
					};
					throw failure;
				}
				if (event.type === "session_rollback") {
					rollbackState = {
						advisor: advisorReceiptResolutions + advisorReceiptRejections,
						async: asyncReceiptResolutions + asyncReceiptRejections,
						advisorQueued: session.yieldQueue.has("advisor"),
						asyncQueued: session.yieldQueue.has("async-result"),
						followUpQueued: session.agent
							.peekFollowUpQueue()
							.some(message => JSON.stringify(message).includes(retainedFollowUpMarker)),
						providerCalls: primaryMock.calls.length,
						jobStatus: asyncManager.getJob(jobId)?.status,
					};
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		const handoff = session.handoff();
		await targetEnsureStarted.promise;
		jobGate.resolve("retained deferred result");
		await asyncManager.waitForOwnerJobs("Main");
		await asyncManager.drainDeliveries({ filter: { ownerId: "Main" } });
		expect(asyncManager.getJob(jobId)?.status).toBe("completed");
		expect(asyncReceipt).toBeDefined();
		expect(advisorReceiptResolutions + advisorReceiptRejections).toBe(0);
		expect(asyncReceiptResolutions + asyncReceiptRejections).toBe(0);
		continueTargetEnsure.resolve();
		await expect(handoff).rejects.toBe(failure);

		expect(readyState).toEqual({ advisor: 0, async: 0, advisorQueued: false, asyncQueued: false });
		expect(rollbackState).toEqual({
			advisor: 0,
			async: 0,
			advisorQueued: true,
			asyncQueued: true,
			followUpQueued: true,
			providerCalls: 0,
			jobStatus: "completed",
		});
		await expect(advisorReceipt).resolves.toBeUndefined();
		await expect(asyncReceipt!).resolves.toBeUndefined();
		expect(advisorReceiptResolutions).toBe(1);
		expect(advisorReceiptRejections).toBe(0);
		expect(asyncReceiptResolutions).toBe(1);
		expect(asyncReceiptRejections).toBe(0);
		await waitFor(() => deliveredContexts.some(context => context.includes(retainedFollowUpMarker)));
		expect(deliveredContexts.some(context => context.includes(retainedFollowUpMarker))).toBe(true);
		expect(session.getAutomaticTurnOutcomes()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "direct_user_input",
					status: "started",
					originTurnId: expect.any(String),
				}),
			]),
		);
		const deliveredMessages = session.messages.map(message => JSON.stringify(message));
		expect(deliveredMessages.filter(message => message.includes(retainedFollowUpMarker))).toHaveLength(1);
		expect(asyncManager.getJob(jobId)?.status).toBe("completed");
	});

	it("commits handoff by discarding retained async work before it can enter the target", async () => {
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		await session.dispose();
		sessionManager = await SessionManager.open(retainedSessionFile, tempDir.path());
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry,
			obfuscator,
			ownedAsyncJobManager: asyncManager,
			agentId: "Main",
		});
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");

		let retainedReceipt: Promise<void> | undefined;
		const beginTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
		vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
			if (kind === "async-result" && !retainedReceipt) {
				retainedReceipt = session.yieldQueue.enqueueWithReceipt<AsyncResultEntry>("async-result", {
					jobId: "retained-handoff-commit-receipt",
					result: "retained queued async receipt",
					job: undefined,
					durationMs: 0,
					epoch: 0,
				});
				void retainedReceipt.catch(() => {});
			}
			return beginTransaction(kind);
		});
		const jobGate = Promise.withResolvers<string>();
		const jobId = asyncManager.register("task", "retained handoff commit job", () => jobGate.promise, {
			id: "retained-handoff-commit-job",
			ownerId: "Main",
		});
		const targetEnsureStarted = Promise.withResolvers<void>();
		const continueTargetEnsure = Promise.withResolvers<void>();
		const ensureOnDisk = sessionManager.ensureOnDisk.bind(sessionManager);
		vi.spyOn(sessionManager, "ensureOnDisk").mockImplementation(async () => {
			if (session.sessionFile !== retainedSessionFile) {
				targetEnsureStarted.resolve();
				await continueTargetEnsure.promise;
			}
			await ensureOnDisk();
		});

		const handoff = session.handoff();
		await targetEnsureStarted.promise;
		jobGate.resolve("retained result must not cross handoff");
		await asyncManager.waitForOwnerJobs("Main");
		await asyncManager.drainDeliveries({ filter: { ownerId: "Main" } });
		expect(asyncManager.getJob(jobId)?.status).toBe("completed");
		expect(retainedReceipt).toBeDefined();
		continueTargetEnsure.resolve();
		await expect(handoff).resolves.toEqual({ document: "## Goal\nContinue from here", savedPath: undefined });

		expect(asyncManager.getJob(jobId)).toBeUndefined();
		await expect(retainedReceipt!).rejects.toThrow("Yield queue entry cleared before dispatch");
		expect(session.yieldQueue.has("async-result")).toBe(false);
		expect(session.agent.peekFollowUpQueue()).not.toContainEqual(
			expect.objectContaining({ customType: "async-result" }),
		);
	});
	it("runs handoff generation through the configured side stream function", async () => {
		const handoffText = "## Goal\nContinue via side stream";
		let sideStreamCalls = 0;
		let capturedSideSessionId: string | undefined;
		const sideStreamFn: StreamFn = (requestModel, _context, options) => {
			sideStreamCalls++;
			capturedSideSessionId = options?.sessionId;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: handoffText }],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					stopReason: "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		await session.dispose();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		sessionManager = await SessionManager.open(sessionFile, tempDir.path());
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
				"compaction.keepRecentTokens": 1,
			}),
			modelRegistry,
			obfuscator,
			sideStreamFn,
		});
		const preHandoffSessionId = session.sessionId;

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockImplementation(async (context, requestModel, options) => {
				expect(options.completeImpl).toBeDefined();
				const message = await options.completeImpl!(requestModel, context, options.streamOptions);
				return message.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join("\n");
			});

		const result = await session.handoff();

		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(result?.document).toBe(handoffText);
		expect(sideStreamCalls).toBe(1);
		expect(capturedSideSessionId).toStartWith(`${preHandoffSessionId}:side:`);
	});

	it("preserves queued steering and follow-up messages across the handoff reset", async () => {
		// Defect 2: handoff() calls agent.reset(), which clears the core steering/follow-up
		// queues. Steers/follow-ups already queued (the mis-routed first compaction message,
		// or RPC/SDK steer()/followUp() issued during the handoff) must survive into the new
		// session instead of being silently dropped.
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue");

		const textOf = (message: AgentMessage): string => {
			if (!("content" in message)) return "";
			const content = message.content;
			if (typeof content === "string") return content;
			const textBlock = content.find(block => block.type === "text");
			return textBlock?.type === "text" ? textBlock.text : "";
		};

		const userMsg: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "keep-steer" }],
			attribution: "user",
			timestamp: Date.now(),
		};
		// A hidden, user-attributed companion (e.g. an ultrathink notice). It is
		// display:false, so isUserQueuedMessage(...) is false for it: preservation must
		// keep it adjacent to its prompt rather than filter it out or reorder it.
		const companionMsg: AgentMessage = {
			role: "custom",
			customType: "ultrathink-notice",
			content: [{ type: "text", text: "companion" }],
			attribution: "user",
			display: false,
			timestamp: Date.now(),
		};
		const followUpMsg: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "keep-followup" }],
			attribution: "user",
			timestamp: Date.now(),
		};
		session.agent.steer(userMsg);
		session.agent.steer(companionMsg);
		session.agent.followUp(followUpMsg);
		expect(session.agent.hasQueuedMessages()).toBe(true);

		await session.handoff();

		expect(session.agent.peekSteeringQueue().map(textOf)).toEqual(["keep-steer", "companion"]);
		expect(session.agent.peekFollowUpQueue().map(textOf)).toEqual(["keep-followup"]);
	});

	it.each([
		["active", true],
		["paused", false],
		["blocked", false],
		["budget_limited", false],
		["usage_limited", false],
	] as const)("preserves a non-final %s goal in the handoff target", async (status, autoTriggered) => {
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue");
		session.settings.set("goal.enabled", true);
		const goal = {
			id: `handoff-${status}-goal`,
			objective: `Continue the ${status} goal`,
			status,
			tokenBudget: 1_000,
			tokensUsed: 10,
			timeUsedSeconds: 2,
			createdAt: 1,
			updatedAt: 2,
		};
		session.setGoalModeState({ enabled: status === "active", mode: "active", goal });

		await session.handoff(undefined, autoTriggered ? { autoTriggered: true } : undefined);

		const targetContext = sessionManager.buildSessionContext();
		expect(targetContext.mode).toBe(status === "paused" ? "goal_paused" : "goal");
		expect(targetContext.modeData?.goal).toEqual(goal);
		expect(session.getGoalModeState()).toEqual({ enabled: status === "active", mode: "active", goal });
	});

	it("moves durable semantic queue ownership to the handoff target", async () => {
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue");
		session.agent.state.isStreaming = true;
		await expect(
			session.sendCustomMessage(
				{ customType: "handoff-mail", content: "deliver only from target", display: true, attribution: "agent" },
				{ deliveryMode: "steer" },
			),
		).resolves.toEqual({ status: "accepted", delivery: "queued_steer" });
		const sourceSessionFile = session.sessionFile;
		if (!sourceSessionFile) throw new Error("Expected durable source session");
		session.agent.state.isStreaming = false;

		await session.handoff();

		const targetSessionFile = session.sessionFile;
		if (!targetSessionFile || targetSessionFile === sourceSessionFile)
			throw new Error("Expected handoff target session");
		const queued = session.agent.peekSteeringQueue()[0];
		expect(queued).toMatchObject({ role: "custom", customType: "handoff-mail" });
		session.agent.emitExternalEvent({ type: "message_start", message: queued! });
		session.agent.emitExternalEvent({ type: "message_end", message: queued! });
		await waitFor(() =>
			sessionManager
				.getBranch()
				.some(entry => entry.type === "custom" && entry.customType === "omp:settled-semantic-delivery"),
		);
		await sessionManager.flush();

		const sourceManager = await SessionManager.open(sourceSessionFile, tempDir.path(), undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
		});
		const sourcePending = sourceManager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === "omp:pending-semantic-delivery");
		const sourceSettled = new Set(
			sourceManager
				.getBranch()
				.flatMap(entry =>
					entry.type === "custom" && entry.customType === "omp:settled-semantic-delivery"
						? [(entry.data as { pendingId?: string }).pendingId]
						: [],
				),
		);
		expect(sourcePending).toHaveLength(1);
		expect(sourceSettled.has(sourcePending[0]!.id)).toBe(true);
		await sourceManager.close();
		sourceManager.releaseRetainedEntries();

		const targetBranch = sessionManager.getBranch();
		const targetPending = targetBranch.filter(
			entry => entry.type === "custom" && entry.customType === "omp:pending-semantic-delivery",
		);
		const targetSettled = new Set(
			targetBranch.flatMap(entry =>
				entry.type === "custom" && entry.customType === "omp:settled-semantic-delivery"
					? [(entry.data as { pendingId?: string }).pendingId]
					: [],
			),
		);
		expect(targetPending).toHaveLength(1);
		expect(targetSettled.has(targetPending[0]!.id)).toBe(true);
		expect(
			targetBranch.filter(entry => entry.type === "custom_message" && entry.customType === "handoff-mail"),
		).toHaveLength(1);
	});

	it("hands off a durable custom prompt with its retimed queue kind", async () => {
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue");
		session.agent.state.isStreaming = true;
		await session.sendCustomMessage(
			{ customType: "retimed-handoff-mail", content: "keep new timing", display: true, attribution: "user" },
			{ deliveryMode: "afterCurrent" },
		);
		const queuedId = session.getQueuedPrompts()[0]?.id;
		if (!queuedId) throw new Error("Expected durable handoff prompt");
		await expect(session.setQueuedPromptDelivery(queuedId, "steer")).resolves.toEqual({ status: "updated" });
		session.agent.state.isStreaming = false;

		await session.handoff();

		expect(session.agent.peekFollowUpQueue()).toHaveLength(0);
		expect(session.agent.peekSteeringQueue()).toHaveLength(1);
		expect(JSON.stringify(session.agent.peekSteeringQueue()[0])).toContain("keep new timing");
		const pending = sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === "omp:pending-semantic-delivery");
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({ data: { kind: "steer" } });
	});

	it("keeps durable semantic queue ownership on the source when handoff rolls back", async () => {
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue");
		session.agent.state.isStreaming = true;
		await session.sendCustomMessage(
			{ customType: "rollback-mail", content: "survive failed handoff", display: true, attribution: "agent" },
			{ deliveryMode: "steer" },
		);
		const sourceSessionFile = session.sessionFile;
		if (!sourceSessionFile) throw new Error("Expected durable source session");
		session.agent.state.isStreaming = false;
		const failure = new Error("handoff target migration failed");
		const appendEntriesAtomically = sessionManager.appendEntriesAtomically.bind(sessionManager);
		vi.spyOn(sessionManager, "appendEntriesAtomically").mockImplementation(append => {
			if (session.sessionFile !== sourceSessionFile) return Promise.reject(failure);
			return appendEntriesAtomically(append);
		});

		await expect(session.handoff()).rejects.toBe(failure);
		expect(session.sessionFile).toBe(sourceSessionFile);
		const durableSourceLines = (await Bun.file(sourceSessionFile).text())
			.split("\n")
			.filter(line => line.includes("semantic-delivery"));
		expect(durableSourceLines.some(line => line.includes("omp:pending-semantic-delivery"))).toBe(true);
		expect(durableSourceLines.some(line => line.includes("omp:settled-semantic-delivery"))).toBe(false);
		session = undefined as unknown as AgentSession;
		const reopened = await SessionManager.open(sourceSessionFile, tempDir.path(), undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
		});
		const reopenedPending = reopened
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === "omp:pending-semantic-delivery");
		expect(reopenedPending).toHaveLength(1);
		expect(reopenedPending[0]).toMatchObject({
			type: "custom",
			data: { v: 1, kind: "steer", message: { role: "custom", customType: "rollback-mail" } },
		});
		const reopenedSettled = reopened
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === "omp:settled-semantic-delivery");
		expect(reopenedSettled).toHaveLength(0);
		sessionManager = reopened;
		session = new AgentSession({
			agent: new Agent({ initialState: { model: undefined, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry,
			obfuscator,
		});
		const postConstructPending = sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === "omp:pending-semantic-delivery");
		const postConstructSettled = sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom" && entry.customType === "omp:settled-semantic-delivery");
		expect(postConstructPending).toHaveLength(1);
		expect(postConstructSettled).toHaveLength(0);
		expect(session.agent.peekSteeringQueue()).toHaveLength(1);
		expect(JSON.stringify(session.agent.peekSteeringQueue()[0])).toContain("survive failed handoff");
	});

	it("preserves steering and follow-up messages enqueued while the handoff is in flight", async () => {
		// Defect 2 in-flight window: the queue snapshot must be captured immediately before
		// agent.reset() (after generateHandoff resolves), NOT at handoff entry. A steer or
		// follow-up issued WHILE the handoff document is still generating must survive the
		// reset — proving capture happens late rather than at the start of handoff().
		const { promise: handoffDoc, resolve: releaseHandoff } = Promise.withResolvers<string>();
		let generateHandoffCalled = false;
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockImplementation(async () => {
			generateHandoffCalled = true;
			return handoffDoc;
		});

		const textOf = (message: AgentMessage): string => {
			if (!("content" in message)) return "";
			const content = message.content;
			if (typeof content === "string") return content;
			const textBlock = content.find(block => block.type === "text");
			return textBlock?.type === "text" ? textBlock.text : "";
		};

		const handoffPromise = session.handoff();
		// Block until we are genuinely mid-handoff (document generation in flight).
		await waitFor(() => generateHandoffCalled);

		// Enqueue AFTER generation started but BEFORE it resolves — the window where the old
		// session is still live and agent.reset() has not yet fired.
		session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "inflight-steer" }],
			attribution: "user",
			timestamp: Date.now(),
		});
		session.agent.followUp({
			role: "user",
			content: [{ type: "text", text: "inflight-followup" }],
			attribution: "user",
			timestamp: Date.now(),
		});

		releaseHandoff("## Goal\nContinue");
		await handoffPromise;

		expect(session.agent.peekSteeringQueue().map(textOf)).toEqual(["inflight-steer"]);
		expect(session.agent.peekFollowUpQueue().map(textOf)).toEqual(["inflight-followup"]);
	});
	it("obfuscates custom instructions before generating a handoff", async () => {
		const placeholder = obfuscator.obfuscate(HANDOFF_SECRET);
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue(`## Goal\nKeep ${placeholder}`);

		const result = await session.handoff(`preserve ${HANDOFF_SECRET}`);

		const handoffCall = generateHandoffSpy.mock.calls[0];
		if (!handoffCall) throw new Error("Expected generateHandoffFromContext call");
		// Custom instructions are obfuscated, rendered into the handoff prompt, and
		// appended as the trailing context message — the raw secret never reaches
		// the provider.
		const trailing = handoffCall[0].messages.at(-1);
		const trailingText =
			typeof trailing?.content === "string"
				? trailing.content
				: (trailing?.content ?? []).map(block => (block.type === "text" ? block.text : "")).join("");
		expect(trailingText).toContain(`preserve ${placeholder}`);
		expect(trailingText).not.toContain(HANDOFF_SECRET);
		expect(result?.document).toContain(HANDOFF_SECRET);
		expect(result?.document).not.toContain(placeholder);
	});

	it("obfuscates the previous compaction summary but preserves opaque replay data", async () => {
		session.settings.set("compaction.methodOrder", ["soft"]);
		const placeholder = obfuscator.obfuscate(HANDOFF_SECRET);
		const entries = sessionManager.getBranch();
		const lastEntryId = entries[entries.length - 1]?.id;
		if (!lastEntryId) throw new Error("Expected a seeded entry id");
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId: lastEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			previousSummary: `summary ${HANDOFF_SECRET}`,
			previousPreserveData: {
				openaiRemoteCompaction: {
					replacementHistory: [{ role: "user", content: `history ${HANDOFF_SECRET}` }],
				},
			},
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: compactionModule.DEFAULT_COMPACTION_SETTINGS,
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);

		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "new summary",
			shortSummary: undefined,
			firstKeptEntryId: lastEntryId,
			tokensBefore: 100,
			details: {},
		});

		await session.compact();

		const call = compactSpy.mock.calls[0];
		if (!call) throw new Error("Expected compact call");
		expect(call[0].previousSummary).toBe(`summary ${placeholder}`);
		expect(call[0].previousSummary).not.toContain(HANDOFF_SECRET);
		// Opaque provider-replay state (encrypted_content / replacementHistory) must pass through
		// byte-identical — rewriting it would corrupt OpenAI remote-compaction replay.
		expect(call[0].previousPreserveData).toBe(fixedPreparation.previousPreserveData);
	});

	it("obfuscates migrated snapcompact archive text but preserves opaque replay data", async () => {
		session.settings.set("compaction.methodOrder", ["soft"]);
		const placeholder = obfuscator.obfuscate(HANDOFF_SECRET);
		const entries = sessionManager.getBranch();
		const lastEntryId = entries[entries.length - 1]?.id;
		if (!lastEntryId) throw new Error("Expected a seeded entry id");
		const replaySlot = {
			replacementHistory: [{ role: "user", content: `history ${HANDOFF_SECRET}` }],
		};
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId: lastEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			previousPreserveData: {
				openaiRemoteCompaction: replaySlot,
				[snapcompact.PRESERVE_KEY]: {
					frames: [],
					totalChars: 32,
					truncatedChars: 0,
					text: `archived ${HANDOFF_SECRET}`,
					textHead: `head ${HANDOFF_SECRET}`,
				},
			},
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: compactionModule.DEFAULT_COMPACTION_SETTINGS,
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "new summary",
			shortSummary: undefined,
			firstKeptEntryId: lastEntryId,
			tokensBefore: 100,
			details: {},
		});

		await session.compact();

		const call = compactSpy.mock.calls[0];
		if (!call) throw new Error("Expected compact call");
		const preserve = call[0].previousPreserveData;
		if (!preserve) throw new Error("Expected previousPreserveData");
		// The archive plaintext that compact() migrates into the summary prompt is
		// redacted, so the raw secret never reaches the provider.
		const archive = preserve[snapcompact.PRESERVE_KEY] as { text: string; textHead: string };
		expect(archive.text).toBe(`archived ${placeholder}`);
		expect(archive.textHead).toBe(`head ${placeholder}`);
		expect(JSON.stringify(archive)).not.toContain(HANDOFF_SECRET);
		// Opaque provider-replay state stays byte-identical (same reference) — only the
		// snapcompact slot's text is rewritten.
		expect(preserve.openaiRemoteCompaction).toBe(replaySlot);
	});

	it("does not call the LLM summarizer when manual snapcompact preflight fails", async () => {
		const entries = sessionManager.getBranch();
		const lastEntryId = entries[entries.length - 1]?.id;
		if (!lastEntryId) throw new Error("Expected a seeded entry id");
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId: lastEntryId,
			messagesToSummarize: [
				{
					role: "user",
					content: [{ type: "text", text: UNRENDERABLE_SNAPCOMPACT_TEXT.repeat(100) }],
					timestamp: 1,
				},
			],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "snapcompact" },
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockRejectedValue(new Error("429 quota exhausted"));

		await expect(session.compact(undefined, { mode: "snapcompact" })).rejects.toThrow(
			"snapcompact cannot render this conversation locally",
		);

		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("advances from auto snapcompact to soft compaction when local preflight rejects the transcript", async () => {
		session.settings.set("compaction.methodOrder", ["snapcompact", "soft"]);
		const entries = sessionManager.getBranch();
		const lastEntryId = entries[entries.length - 1]?.id;
		if (!lastEntryId) throw new Error("Expected a seeded entry id");
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId: lastEntryId,
			messagesToSummarize: [
				{
					role: "user",
					content: [{ type: "text", text: UNRENDERABLE_SNAPCOMPACT_TEXT.repeat(100) }],
					timestamp: 1,
				},
			],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "snapcompact" },
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "compacted",
			shortSummary: undefined,
			firstKeptEntryId: lastEntryId,
			tokensBefore: 100,
			details: {},
		});

		await session.runIdleCompaction();

		const endEvent = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "auto_compaction_end" }> =>
				event.type === "auto_compaction_end" && event.action === "context-full",
		);
		expect(compactSpy).toHaveBeenCalled();
		expect(events).toContainEqual({ type: "auto_compaction_start", reason: "idle", action: "snapcompact" });
		expect(endEvent).toMatchObject({
			type: "auto_compaction_end",
			action: "context-full",
		});
		expect(endEvent?.errorMessage).toBeUndefined();
		const downgradeNotice = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "notice" }> =>
				event.type === "notice" &&
				event.source === "compaction" &&
				event.message.startsWith("snapcompact disabled: unsupported characters for selected snapcompact font"),
		);
		expect(downgradeNotice?.message).toContain("trying the next preferred compaction method.");
	});

	it("strips hook-supplied snapcompact data when persisting context-full compaction", async () => {
		const localTempDir = TempDir.createSync("@pi-context-full-preserve-data-");
		const localSessionManager = SessionManager.inMemory(localTempDir.path());
		const firstKeptEntryId = localSessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		};
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session.compacting"),
			emit: vi.fn(async (event: { type: string }) =>
				event.type === "session.compacting"
					? {
							preserveData: {
								otherState: "keep-me",
								[snapcompact.PRESERVE_KEY]: { frames: [], totalChars: 0, truncatedChars: 0 },
							},
						}
					: undefined,
			),
			disposeFileFallbacks: vi.fn(),
			clearManagedTimers: vi.fn(),
		} as unknown as ExtensionRunner;
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "context-full summary",
			shortSummary: undefined,
			firstKeptEntryId,
			tokensBefore: 100,
			details: {},
			preserveData: { resultState: "keep-result" },
		});
		const localAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const localSession = new AgentSession({
			agent: localAgent,
			sessionManager: localSessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["soft"],
			}),
			modelRegistry,
			extensionRunner,
		});

		try {
			await localSession.compact();
			const compactionEntry = localSessionManager.getEntries().find(entry => entry.type === "compaction");
			if (compactionEntry?.type !== "compaction") throw new Error("Expected persisted compaction entry");
			expect(compactionEntry.preserveData).toEqual({
				otherState: "keep-me",
				resultState: "keep-result",
			});
			expect(compactionEntry.preserveData).not.toHaveProperty(snapcompact.PRESERVE_KEY);
		} finally {
			await localSession.dispose();
			await localTempDir.remove();
		}
	});

	it("strips hook-supplied snapcompact data when persisting auto context-full compaction", async () => {
		const localTempDir = TempDir.createSync("@pi-auto-context-full-preserve-data-");
		const localSessionManager = SessionManager.inMemory(localTempDir.path());
		const firstKeptEntryId = localSessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		};
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session.compacting"),
			emit: vi.fn(async (event: { type: string }) =>
				event.type === "session.compacting"
					? {
							preserveData: {
								otherState: "keep-me",
								[snapcompact.PRESERVE_KEY]: { frames: [], totalChars: 0, truncatedChars: 0 },
							},
						}
					: undefined,
			),
			disposeFileFallbacks: vi.fn(),
			clearManagedTimers: vi.fn(),
		} as unknown as ExtensionRunner;
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "auto context-full summary",
			shortSummary: undefined,
			firstKeptEntryId,
			tokensBefore: 100,
			details: {},
			preserveData: { resultState: "keep-result" },
		});
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.autoContinue": false,
			"compaction.methodOrder": ["soft"],
			"providers.cacheRetention": "none",
		});
		const sideMock = createMockModel({ provider: "anthropic", responses: [{ content: ["summary"] }] });
		const promptCacheKey = "inherited-parent-cache";
		const localAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			promptCacheKey,
		});
		const localSession = new AgentSession({
			agent: localAgent,
			sessionManager: localSessionManager,
			settings,
			modelRegistry,
			extensionRunner,
			sideStreamFn: createSettingsAwareStreamFn(settings, sideMock.stream),
		});

		try {
			await localSession.runIdleCompaction();
			expect(compactSpy).toHaveBeenCalledTimes(1);
			expect(compactSpy.mock.calls[0]?.[5]?.promptCacheKey).toBe(promptCacheKey);
			expect(compactSpy.mock.calls[0]?.[5]?.cacheRetention).toBe("none");
			const completeImpl = compactSpy.mock.calls[0]?.[5]?.completeImpl;
			if (!completeImpl) throw new Error("Expected automatic compaction to use the side stream transport");
			await completeImpl(sideMock, { messages: [] }, {});
			expect(sideMock.calls[0]?.options?.cacheRetention).toBe("none");
			const compactionEntry = localSessionManager.getEntries().find(entry => entry.type === "compaction");
			if (compactionEntry?.type !== "compaction") throw new Error("Expected persisted compaction entry");
			expect(compactionEntry.preserveData).toEqual({
				otherState: "keep-me",
				resultState: "keep-result",
			});
			expect(compactionEntry.preserveData).not.toHaveProperty(snapcompact.PRESERVE_KEY);
		} finally {
			await localSession.dispose();
			await localTempDir.remove();
		}
	});
	it("keeps pre-prompt context-full checks aligned with provider-anchored usage", async () => {
		await session.dispose();
		authStorage.setRuntimeApiKey("openai", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const mock = createMockModel({
			id: "gpt-5.5",
			provider: "openai",
			contextWindow: 10_000,
			responses: [
				{
					content: ["ok"],
					stopReason: "stop",
					usage: {
						input: 1_005,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1_025,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
		});
		const seedUser: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		};
		const seedAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "short reasoning",
					thinkingSignature: JSON.stringify({
						id: "rs_repro",
						type: "reasoning",
						content: [],
						encrypted_content: "blob ".repeat(30_000),
						summary: [],
					}),
				},
				{ type: "text", text: "done" },
			],
			api: mock.api,
			provider: "openai",
			model: mock.id,
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		};
		sessionManager.appendMessage(seedUser);
		sessionManager.appendMessage(seedAssistant);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mock,
				systemPrompt: ["Test"],
				tools: [],
				messages: [seedUser, seedAssistant],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
				"compaction.methodOrder": ["soft"],
				"compaction.thresholdTokens": 8_000,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});
		session.subscribe(event => {
			events.push(event);
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "pre-prompt compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		expect(session.getContextUsage({ contextWindow: 10_000 })).toMatchObject({
			tokens: 1_000,
			contextWindow: 10_000,
			percent: 10,
		});

		await session.prompt("small pending prompt");

		expect(compactSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(mock.calls).toHaveLength(1);
	});
	it("floors pre-prompt context-full checks by the stored conversation when provider usage is deflated", async () => {
		// Mirror of the provider-anchored test, but the large payload is real, on-wire-
		// compressible text (what a before_provider_request hook like Headroom shrinks),
		// NOT encrypted reasoning. The provider reports a deflated 1k prompt tokens, yet
		// the stored conversation is ~20k tokens — compaction MUST still fire.
		await session.dispose();
		authStorage.setRuntimeApiKey("openai", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const mock = createMockModel({
			id: "gpt-5.5",
			provider: "openai",
			contextWindow: 10_000,
			responses: [{ content: ["ok"], stopReason: "stop" }],
		});
		const seedUser: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		};
		// ~20k tokens of plain text in a normal text block — counted by the floor.
		const bulkText = "alpha beta gamma delta epsilon ".repeat(3_000);
		const seedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: bulkText }],
			api: mock.api,
			provider: "openai",
			model: mock.id,
			stopReason: "stop",
			// Deflated: a before_provider_request compressor shrank the request, so the
			// provider only billed ~1k prompt tokens for a ~20k-token conversation.
			usage: {
				input: 1_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		};
		sessionManager.appendMessage(seedUser);
		sessionManager.appendMessage(seedAssistant);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [seedUser, seedAssistant] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["soft"],
				"compaction.thresholdTokens": 8_000,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});
		session.subscribe(event => {
			events.push(event);
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "pre-prompt compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		// Display still shows the provider-anchored (deflated) usage — only the
		// compaction decision takes the local floor.
		expect(session.getContextUsage({ contextWindow: 10_000 })?.tokens).toBe(1_000);

		await session.prompt("small pending prompt");

		// The floor (~20k from the stored text) exceeds the 8k threshold, so the
		// deflated 1k provider count no longer suppresses compaction.
		expect(compactSpy).toHaveBeenCalled();
	});
	it("does not double-count unchanged non-message tokens in provider-anchored pre-prompt checks", async () => {
		await session.dispose();
		authStorage.setRuntimeApiKey("openai", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const mock = createMockModel({
			id: "gpt-5.5",
			provider: "openai",
			contextWindow: 10_000,
			responses: [
				{
					content: ["seed response"],
					stopReason: "stop",
					usage: {
						input: 8_500,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 8_510,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
				{ content: ["ok"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mock,
				systemPrompt: ["expanded system prompt ".repeat(30_000)],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["soft"],
				"compaction.thresholdTokens": 9_500,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});
		session.subscribe(event => {
			events.push(event);
		});

		await session.prompt("seed prompt");
		expect(mock.calls).toHaveLength(1);
		session.settings.set("compaction.enabled", true);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "pre-prompt compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		await session.prompt("small pending prompt");
		await drainMaintenance();

		expect(compactSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(mock.calls).toHaveLength(2);
	});
	it("does not run auto maintenance after final yield", async () => {
		session.settings.set("compaction.methodOrder", ["handoff", "soft"]);
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const yieldCall: ToolCall = {
			type: "toolCall",
			id: "call_yield_done",
			name: "yield",
			arguments: { result: { data: { done: true } } },
		};
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [yieldCall],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff document" });
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { done: true } },
			},
			isError: false,
		});
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await drainMaintenance();

		expect(handoffSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
	});

	it("persists handoff session immediately with previous session as parent", async () => {
		const previousSessionFile = session.sessionFile;
		if (!previousSessionFile) {
			throw new Error("Expected previous session file");
		}

		const handoffText = "## Goal\nContinue from here";
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue(handoffText);

		const result = await session.handoff();
		const handoffSessionFile = session.sessionFile;
		if (!handoffSessionFile) {
			throw new Error("Expected handoff session file");
		}

		type PersistedEntry = {
			type?: string;
			parentSession?: string;
			customType?: string;
			display?: boolean;
		};
		const handoffEntries = (await Bun.file(handoffSessionFile).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as PersistedEntry);

		expect(result?.document).toBe(handoffText);
		expect(session.getLastAssistantText()).toBeUndefined();
		expect(session.hasCopyCandidateAssistantMessage()).toBe(false);
		expect(session.getLastVisibleHandoffText()).toBe(
			`<handoff-context>\n${handoffText}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`,
		);
		expect(handoffSessionFile).not.toBe(previousSessionFile);
		expect(handoffEntries.find(entry => entry.type === "session")).toMatchObject({
			type: "session",
			parentSession: previousSessionFile,
		});
		expect(
			handoffEntries.some(
				entry => entry.type === "custom_message" && entry.customType === "handoff" && entry.display,
			),
		).toBe(true);

		const previousSessionText = await Bun.file(previousSessionFile).text();
		expect(previousSessionText).toContain('"text":"seed"');
	});

	it("does not run auto maintenance when strategy is off", async () => {
		session.settings.set("compaction.methodOrder", []);
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff");
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await drainMaintenance();

		expect(handoffSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
	});

	it("restores default methods when enabling auto-compaction from an empty order", () => {
		session.settings.set("compaction.enabled", true);
		session.settings.set("compaction.methodOrder", []);

		expect(session.autoCompactionEnabled).toBe(false);
		session.setAutoCompactionEnabled(true);
		expect(session.settings.get("compaction.methodOrder")).toEqual([
			"remote",
			"snapcompact",
			"handoff",
			"shake",
			"soft",
		]);
		expect(session.autoCompactionEnabled).toBe(true);
	});

	it("falls back to context-full maintenance for overflow when strategy is handoff", async () => {
		session.settings.set("compaction.methodOrder", ["handoff", "soft"]);
		session.settings.set("contextPromotion.enabled", false);
		const firstKeptEntryId = mockAutoCompactionPreparation();
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "overflow fallback summary",
			shortSummary: undefined,
			firstKeptEntryId,
			tokensBefore: 100,
			details: {},
		});

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}
		const handoffSpy = vi.spyOn(session, "handoff");
		const generateHandoffSpy = vi.spyOn(compactionModule, "generateHandoffFromContext");

		const overflowAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "overflow" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "error",
			errorMessage: "maximum context length is 200000 tokens, however you requested 200001 tokens",
			usage: {
				input: 120_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: overflowAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowAssistant] });
		await waitFor(() => events.filter(event => event.type === "auto_compaction_end").length === 1);

		expect(handoffSpy).not.toHaveBeenCalled();
		expect(generateHandoffSpy).not.toHaveBeenCalled();
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const startEvents = events.filter(event => event.type === "auto_compaction_start");
		expect(startEvents).toHaveLength(1);
		expect(startEvents[0]).toMatchObject({
			type: "auto_compaction_start",
			reason: "overflow",
			action: "context-full",
		});
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).not.toMatchObject({
			errorMessage: "Auto-handoff failed: no handoff document was generated",
		});
	});

	it("uses handoff strategy for threshold-triggered auto maintenance", async () => {
		session.settings.set("compaction.methodOrder", ["handoff", "soft"]);
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);
		const sessionFile = session.sessionFile;

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("handoff document");

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await waitFor(
			() =>
				generateHandoffSpy.mock.calls.length === 1 &&
				events.filter(event => event.type === "auto_compaction_end").length === 1,
		);

		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({ type: "auto_compaction_end", aborted: false, willRetry: false });
		expect(sessionManager.getBranch().at(-1)).toMatchObject({ type: "compaction", summary: "handoff document" });
		expect(session.sessionFile).toBe(sessionFile);
	});

	it("completes threshold-triggered auto-handoff while the original prompt is still unwinding", async () => {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});

		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "text", text: "maintenance trigger" }],
					stopReason: "stop",
					usage: {
						input: 190_000,
						output: 1_000,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 191_000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const agentEndWillContinue: Array<boolean | undefined> = [];
		const extensionsResult = await loadExtensions([], tempDir.path());
		const captureAgentEnd = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_end", event => {
					agentEndWillContinue.push(event.willContinue);
				});
			},
			tempDir.path(),
			new EventBus(),
			extensionsResult.runtime,
			"capture-agent-end",
		);
		const extensionRunner = new ExtensionRunner(
			[captureAgentEnd],
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["handoff", "soft"],
				"compaction.thresholdPercent": 1,
				"contextPromotion.enabled": false,
			}),
			extensionRunner,
			modelRegistry,
		});
		session.subscribe(event => {
			events.push(event);
		});

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("## Goal\nContinue from here");
		await session.prompt("Trigger threshold handoff");

		expect(mock.calls).toHaveLength(1);
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(agentEndWillContinue).toEqual([undefined]);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({ type: "auto_compaction_end", action: "handoff", aborted: false });
		expect(endEvents[0]).not.toMatchObject({ errorMessage: expect.any(String) });
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
	});

	it("completes pre-prompt auto-handoff for a scoped peer wake without waiting on itself", async () => {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const seedUser = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "seed" }],
			timestamp: Date.now() - 2,
		};
		const seedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		};
		sessionManager.appendMessage(seedUser);
		sessionManager.appendMessage(seedAssistant);

		const mock = createMockModel({ handler: () => ({ content: ["wake response"] }) });
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [seedUser, seedAssistant] },
				streamFn: mock.stream,
			}),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["handoff", "soft"],
				"compaction.thresholdTokens": 1,
				"contextPromotion.enabled": false,
				"compaction.asyncEnabled": false,
			}),
			modelRegistry,
			obfuscator,
		});
		mockAutoCompactionPreparation();
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("## Goal\nContinue from here");
		const marker = "wake after pre-prompt handoff";
		let committed = 0;

		const disposition = await withTimeout(
			session.sendCustomMessage(
				{
					customType: "peer-message",
					content: marker,
					display: true,
					attribution: "agent",
				},
				{
					deliveryMode: "auto",
					automaticTurnSource: "peer_message_wake",
					onStartedTurnAccepted: () => committed++,
				},
			),
			2_000,
			"Timed out waiting for scoped peer wake auto-handoff",
		);

		expect(disposition).toEqual({ status: "accepted", delivery: "started_turn" });
		expect(committed).toBe(1);
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(mock.calls).toHaveLength(1);
		expect(JSON.stringify(sessionManager.getBranch())).toContain(marker);
	});

	it("does not start agent.continue when threshold-handoff defers and todos are incomplete", async () => {
		// Reproduces the user-reported race: at agent_end, threshold + handoff strategy
		// schedules a deferred handoff and returns. The handler used to fall through to
		// #checkTodoCompletion, which scheduled agent.continue() — both fired concurrently,
		// rendering as "Auto-handoff" loader + an assistant message still streaming.
		session.settings.set("compaction.methodOrder", ["handoff", "soft"]);
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);
		session.settings.set("todo.enabled", true);
		session.settings.set("todo.reminders", true);

		// Active todo phase with an incomplete task so #checkTodoCompletion would normally fire.
		session.setTodoPhases([{ name: "Phase 1", tasks: [{ content: "unfinished work", status: "pending" }] }]);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("## Goal\nContinue");
		const continueSpy = vi.spyOn(session.agent, "continue");

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await waitFor(() => generateHandoffSpy.mock.calls.length === 1);
		await session.waitForIdle();

		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(sessionManager.getBranch().at(-1)).toMatchObject({ type: "compaction", summary: "## Goal\nContinue" });
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("dispose unblocks the post-prompt drain when a deferred handoff is mid-flight", async () => {
		// Reproduces /exit / Ctrl+C-double-tap hanging when a deferred handoff is awaiting
		// the LLM call: dispose() now aborts the auto-compaction controller before draining
		// post-prompt tasks, so Promise.allSettled() in #cancelPostPromptTasks can resolve.
		session.settings.set("compaction.methodOrder", ["handoff", "soft"]);
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);
		mockAutoCompactionPreparation();

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const { promise: handoffPending, resolve: resolveHandoff } = Promise.withResolvers<string>();

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockImplementation(async (_context, _model, options) => {
				// Mirror the real generateHandoffFromContext contract: reject when the
				// caller aborts via the stream-options signal.
				const signal = options.streamOptions.signal;
				return await new Promise<string>((resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("Handoff cancelled")), { once: true });
					handoffPending.then(resolve, reject);
				});
			});

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		// Let the deferred auto-compaction task enter the handoff document request.
		await waitFor(() => generateHandoffSpy.mock.calls.length === 1);
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(session.isCompacting).toBe(true);

		// dispose must NOT wait for the LLM call to resolve on its own — it must abort it.
		const disposed = withTimeout(
			session.dispose().then(() => "disposed" as const),
			2_000,
			"Timed out waiting for session disposal",
		);

		await expect(disposed).resolves.toBe("disposed");
		// Releasing after the fact must not leak into other tests.
		resolveHandoff("handoff");
	});

	it("advances to soft compaction when handoff returns no document", async () => {
		session.settings.set("compaction.methodOrder", ["handoff", "soft"]);
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);
		const firstKeptEntryId = mockAutoCompactionPreparation();
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "soft fallback summary",
			shortSummary: undefined,
			firstKeptEntryId,
			tokensBefore: 100,
			details: {},
		});

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const generateHandoffSpy = vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("");

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await waitFor(() =>
			events.some(event => event.type === "auto_compaction_end" && event.action === "context-full"),
		);

		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(2);
		expect(endEvents[0]).toMatchObject({
			type: "auto_compaction_end",
			action: "handoff",
			aborted: false,
			willRetry: false,
			errorMessage: "Auto-handoff returned no document; trying the next preferred compaction method.",
		});
		expect(endEvents[1]).toMatchObject({
			type: "auto_compaction_end",
			action: "context-full",
			aborted: false,
			willRetry: false,
		});
	});

	it("resets to the base system prompt before generating a handoff", async () => {
		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}
		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const extensionsResult = await loadExtensions([], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const emitBeforeAgentStart = vi.spyOn(extensionRunner, "emitBeforeAgentStart").mockResolvedValueOnce({
			systemPrompt: ["Hook override"],
		});
		vi.spyOn(extensionRunner, "emit").mockResolvedValue(undefined);

		const mock = createMockModel({
			responses: [{ content: ["normal response"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "compaction.keepRecentTokens": 1 }),
			modelRegistry,
			extensionRunner,
		});
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});

		await session.prompt("hello from user");
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("## Goal\nContinue from here");
		await session.handoff();

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		expect(mock.calls.map(c => c.context.systemPrompt?.join("\n\n") ?? "")).toEqual(["Hook override"]);
		const handoffCall = generateHandoffSpy.mock.calls[0];
		if (!handoffCall) throw new Error("Expected generateHandoffFromContext call");
		expect(handoffCall[0].systemPrompt).toEqual(["Test"]);
	});

	it("forwards the agent's provider prompt-cache key to the handoff request", async () => {
		// Cache parity: the live loop routes on the agent's promptCacheKey
		// (providerPromptCacheKey), so handoff must reuse it rather than this.sessionId
		// — otherwise sessions built with a distinct key still cold-miss the cache.
		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			promptCacheKey: "shared-cache-key",
			sessionId: "provider-session-id",
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "compaction.keepRecentTokens": 1 }),
			modelRegistry,
		});
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("## Goal\nContinue");

		await session.handoff();

		const call = generateHandoffSpy.mock.calls[0];
		if (!call) throw new Error("Expected generateHandoffFromContext call");
		const streamOptions = call[2].streamOptions;
		expect(streamOptions.promptCacheKey).toBe("shared-cache-key");
		// Side-request lineage stays unique so append-only provider state never mixes.
		expect(streamOptions.sessionId).toContain(":side:");
		expect(streamOptions.sessionId).not.toBe("shared-cache-key");
	});

	it("saves auto-handoff document to disk when enabled", async () => {
		session.settings.set("compaction.handoffSaveToDisk", true);

		const handoffText = "## Goal\nContinue from here";
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue(handoffText);

		const result = await session.handoff(undefined, { autoTriggered: true });
		expect(result?.savedPath).toBeDefined();
		if (!result?.savedPath) throw new Error("Expected handoff document path");
		expect(result.savedPath.endsWith(".md")).toBe(true);
		const savedText = await Bun.file(result.savedPath).text();
		expect(savedText).toContain(handoffText);
	});

	it("does not save manual handoff document when save setting is enabled", async () => {
		session.settings.set("compaction.handoffSaveToDisk", true);

		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nManual handoff");

		const result = await session.handoff();
		expect(result?.savedPath).toBeUndefined();
	});

	it("does not start handoff prompt when provided signal is already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();

		const generateHandoffSpy = vi.spyOn(compactionModule, "generateHandoffFromContext");

		await expect(session.handoff(undefined, { signal: controller.signal })).rejects.toThrow("Handoff cancelled");
		expect(generateHandoffSpy).not.toHaveBeenCalled();
	});

	it("aborts handoff generation when provided signal is cancelled", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<string>();
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockImplementation((_context, _model, options) => {
				started.resolve();
				const signal = options.streamOptions.signal;
				const onAbort = () => {
					const error = new Error("aborted");
					error.name = "AbortError";
					cancelled.reject(error);
				};
				if (signal?.aborted) {
					onAbort();
				} else {
					signal?.addEventListener("abort", onAbort, { once: true });
				}
				return cancelled.promise;
			});

		const handoffPromise = session.handoff(undefined, { signal: controller.signal });
		await started.promise;
		controller.abort();

		await expect(handoffPromise).rejects.toThrow("Handoff cancelled");
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(generateHandoffSpy.mock.calls[0]?.[2]?.streamOptions?.signal?.aborted).toBe(true);
	});

	it("surfaces the reason when the harness aborts an in-flight handoff", async () => {
		const started = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<string>();
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockImplementation((_context, _model, options) => {
			started.resolve();
			options.streamOptions.signal?.addEventListener("abort", () => cancelled.reject(new Error("request aborted")), {
				once: true,
			});
			return cancelled.promise;
		});

		const handoffPromise = session.handoff();
		await started.promise;
		await session.abort({ reason: "Harness stopped the session" });

		await expect(handoffPromise).rejects.toThrow("Harness stopped the session");
	});

	it("surfaces the real error when generation fails without a user abort", async () => {
		// Providers throw name==="AbortError" errors on non-user conditions (stalls,
		// nested resolution failures). The handoff signal is never aborted here, so the
		// failure must surface verbatim instead of being masked as "Handoff cancelled".
		const providerError = new Error("Deepseek stream stalled");
		providerError.name = "AbortError";
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockRejectedValue(providerError);

		await expect(session.handoff()).rejects.toThrow("Deepseek stream stalled");
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(session.isGeneratingHandoff).toBe(false);
	});

	it("surfaces empty handoff generation as a failure, not a false cancel", async () => {
		// Regression for #7993: the #7904 fix stopped masking provider errors as
		// "Handoff cancelled", but an empty/whitespace-only generation still returned
		// undefined, which the /handoff caller reported as "Handoff cancelled" with no
		// detail. Empty output is a real failure and must surface as one.
		const generateHandoffSpy = vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("   \n  ");

		await expect(session.handoff()).rejects.toThrow("Handoff generation produced no content");
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(session.isGeneratingHandoff).toBe(false);
	});

	it("auto-triggered handoff returns undefined on empty generation for context-full fallback", async () => {
		// Auto-handoff is best-effort: an empty document must NOT throw so maintenance
		// can fall back to context-full compaction (see runAutoCompaction).
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("");

		const result = await session.handoff(undefined, { autoTriggered: true });
		expect(result).toBeUndefined();
	});
});
