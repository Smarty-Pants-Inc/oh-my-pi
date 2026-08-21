import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CompactionMethod } from "@oh-my-pi/pi-coding-agent/session/compaction-methods";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as snapcompactModule from "@oh-my-pi/snapcompact";

const CONTEXT_WINDOW = 100_000;
const THRESHOLD = 50_000;
const SPECULATION_BAND_START = THRESHOLD - 8_192;

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMessage(text: string, model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 10_000,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10_100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("async speculative compaction", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let sessionManager: SessionManager;
	let maintenance: SessionMaintenance;
	let events: string[];
	let emittedEvents: Array<{ type: string; errorMessage?: string }>;

	function appendSummarizableConversation(): void {
		const text = "conversation ".repeat(8_000);
		sessionManager.appendMessage(userMessage(text));
		sessionManager.appendMessage(assistantMessage("response ".repeat(8_000), model));
		sessionManager.appendMessage(userMessage(text));
		sessionManager.appendMessage(assistantMessage("final response", model));
	}

	let maintenanceSettings: Settings;
	type MaintenanceOptions = {
		asyncEnabled?: boolean;
		methodOrder?: CompactionMethod[];
		generateHandoffDocument?: SessionMaintenanceHost["generateHandoffDocument"];
		persistHandoffDocument?: SessionMaintenanceHost["persistHandoffDocument"];
		extensionRunner?: SessionMaintenanceHost["extensionRunner"];
		buildDisplaySessionContext?: SessionMaintenanceHost["buildDisplaySessionContext"];
	};

	function createMaintenance(options: MaintenanceOptions = {}): SessionMaintenance {
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.asyncEnabled": options.asyncEnabled ?? true,
			"compaction.methodOrder": options.methodOrder ?? ["soft"],
			"compaction.thresholdPercent": 50,
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
		});
		maintenanceSettings = settings;
		const host = {
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner: options.extensionRunner,
			sideStreamFn: async () => {
				throw new Error("The compact seam should be used instead of the side stream");
			},
			providerSessionState: new Map(),
			preferWebsockets: undefined,
			model: () => model,
			thinkingLevel: () => undefined,
			isDisposed: () => false,
			isStreaming: () => false,
			isGeneratingHandoff: () => false,
			promptGeneration: () => 0,
			sessionId: () => sessionManager.getSessionId(),
			messages: () => agent.state.messages,
			baseSystemPrompt: () => ["Test"],
			goalModeState: () => undefined,
			planReferencePath: () => "",
			nonMessageTokenSource: () => ({}),
			memoryBackendSession: () => undefined,
			emitSessionEvent: async (event: { type: string; errorMessage?: string }) => {
				events.push(event.type);
				emittedEvents.push(event);
			},
			emitNotice: () => {},
			schedulePostPromptTask: () => {},
			scheduleAgentContinue: () => {},
			scheduleCompactionContinuation: () => false,
			persistTurnMessagesForMidRunCompaction: async () => false,
			findLastAssistantMessage: () => undefined,
			beginSemanticDeliveryMaintenance: async () => () => {},
			disconnectFromAgent: () => {},
			reconnectToAgent: () => {},
			drainStrandedQueuedMessages: () => {},
			buildDisplaySessionContext: options.buildDisplaySessionContext ?? (() => ({ messages: [] })),
			convertToLlmForSideRequest: (messages: AgentMessage[]) => messages as never,
			obfuscateTextForProvider: (text: string | undefined) => text,
			obfuscatePreparationForProvider: <T>(preparation: T) => preparation,
			closeCodexProviderSessionsForHistoryRewrite: () => {},
			resetCodexProviderAfterCompaction: () => {},
			resetPlanReference: () => {},
			syncTodoPhasesFromBranch: () => {},
			resetAdvisorRuntimes: () => {},
			rebaseAfterCompaction: () => {},
			recordAnchoredHistoryRewrite: () => {},
			getContextBreakdown: () => undefined,
			getContextUsage: () => undefined,
			shake: async () => ({ modified: false, tokensRemoved: 0 }),
			dropImages: async () => ({ removed: 0 }),
			generateHandoffDocument: options.generateHandoffDocument ?? (async () => undefined),
			persistHandoffDocument: options.persistHandoffDocument ?? (async () => {}),
			removeAssistantMessageFromActiveContext: () => {},
			dropPersistedAssistantTurn: async () => undefined,
			runRecoveryCompactionWithRollback: async () => ({ deferredHandoff: false, continuationScheduled: false }),
			parseRetryAfterMsFromError: () => undefined,
			setModelTemporary: async () => {},
			abort: async () => {},
			abortHandoff: () => {},
		} as unknown as SessionMaintenanceHost;
		return new SessionMaintenance(host);
	}

	async function waitForState(state: "idle" | "running" | "armed"): Promise<void> {
		for (let microtask = 0; microtask < 100 && maintenance.speculationState !== state; microtask++) {
			await Promise.resolve();
		}
		if (maintenance.speculationState !== state) {
			throw new Error(`Speculation did not become ${state}`);
		}
	}

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in model");
		model = { ...bundled, contextWindow: CONTEXT_WINDOW };
	});

	beforeEach(() => {
		sessionManager = SessionManager.inMemory();
		events = [];
		emittedEvents = [];
		appendSummarizableConversation();
		maintenance = createMaintenance();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
	});

	it("does not call the summarizer below the speculative band, then arms inside it", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "speculative summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START - 1, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).not.toHaveBeenCalled();

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		expect(maintenance.speculationState).toBe("running");
		await waitForState("armed");
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("commits an armed summary at threshold without paying for another summarizer call", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "armed summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("armed summary");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(events).toEqual(expect.arrayContaining(["auto_compaction_start", "auto_compaction_end"]));
	});

	it("persists a speculative handoff only after its armed compaction commits", async () => {
		const generated = { document: "speculative handoff" };
		const generateHandoffDocument = vi.fn<SessionMaintenanceHost["generateHandoffDocument"]>(async () => generated);
		const persistHandoffDocument = vi.fn<SessionMaintenanceHost["persistHandoffDocument"]>(async result => {
			const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
			expect(entry).toMatchObject({ type: "compaction", method: "handoff" });
			expect(result).toBe(generated);
		});
		maintenance = createMaintenance({
			methodOrder: ["handoff"],
			generateHandoffDocument,
			persistHandoffDocument,
		});

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");

		expect(generateHandoffDocument).toHaveBeenCalledTimes(1);
		expect(generateHandoffDocument.mock.calls[0]?.[2]).toBe(true);
		expect(persistHandoffDocument).not.toHaveBeenCalled();

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		expect(persistHandoffDocument).toHaveBeenCalledTimes(1);
	});

	it("persists a blocking handoff only after its compaction entry commits", async () => {
		const generated = { document: "blocking handoff" };
		const generateHandoffDocument = vi.fn<SessionMaintenanceHost["generateHandoffDocument"]>(async () => generated);
		const persistHandoffDocument = vi.fn<SessionMaintenanceHost["persistHandoffDocument"]>(async result => {
			const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
			expect(entry).toMatchObject({ type: "compaction", method: "handoff" });
			expect(result).toBe(generated);
		});
		maintenance = createMaintenance({
			methodOrder: ["handoff"],
			generateHandoffDocument,
			persistHandoffDocument,
		});

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		expect(generateHandoffDocument.mock.calls[0]?.[2]).toBe(true);
		expect(persistHandoffDocument).toHaveBeenCalledTimes(1);
	});

	it("does not persist a blocking handoff when its commit fails and falls back", async () => {
		const generated = { document: "discarded handoff" };
		const generateHandoffDocument = vi.fn<SessionMaintenanceHost["generateHandoffDocument"]>(async () => generated);
		const persistHandoffDocument = vi.fn<SessionMaintenanceHost["persistHandoffDocument"]>(async () => {});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "fallback soft summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		vi.spyOn(sessionManager, "appendCompaction").mockImplementationOnce(() => {
			throw new Error("handoff commit failed");
		});
		maintenance = createMaintenance({
			methodOrder: ["handoff", "soft"],
			generateHandoffDocument,
			persistHandoffDocument,
		});

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		expect(persistHandoffDocument).not.toHaveBeenCalled();
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry).toMatchObject({ type: "compaction", method: "soft", summary: "fallback soft summary" });
	});

	it("does not persist a blocking handoff aborted after generation starts", async () => {
		const generated = { document: "aborted handoff" };
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<typeof generated>();
		const generateHandoffDocument = vi.fn<SessionMaintenanceHost["generateHandoffDocument"]>(async () => {
			started.resolve();
			return await release.promise;
		});
		const persistHandoffDocument = vi.fn<SessionMaintenanceHost["persistHandoffDocument"]>(async () => {});
		maintenance = createMaintenance({
			methodOrder: ["handoff"],
			generateHandoffDocument,
			persistHandoffDocument,
		});

		const compaction = maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD,
		});
		await started.promise;
		maintenance.abortCompaction();
		release.resolve(generated);
		await compaction;

		expect(persistHandoffDocument).not.toHaveBeenCalled();
		expect(sessionManager.getEntries().filter(item => item.type === "compaction")).toHaveLength(0);
	});

	it("acknowledges and persists a handoff before post-append display failure without falling back", async () => {
		const generated = { document: "committed handoff" };
		const postAppendFailure = new Error("post-append display rebuild failed");
		const buildDisplaySessionContext = vi.fn<SessionMaintenanceHost["buildDisplaySessionContext"]>(() => {
			throw postAppendFailure;
		});
		const persistHandoffDocument = vi.fn<SessionMaintenanceHost["persistHandoffDocument"]>(async () => {});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "unexpected fallback summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const appendCompactionSpy = vi.spyOn(sessionManager, "appendCompaction");
		const extensionRunner = {
			hasHandlers: vi.fn(() => false),
			emit: vi.fn(async () => {}),
		} as unknown as SessionMaintenanceHost["extensionRunner"];
		maintenance = createMaintenance({
			methodOrder: ["handoff", "soft"],
			generateHandoffDocument: async () => generated,
			persistHandoffDocument,
			buildDisplaySessionContext,
			extensionRunner,
		});

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		expect(appendCompactionSpy).toHaveBeenCalledTimes(1);
		expect(persistHandoffDocument).toHaveBeenCalledTimes(1);
		expect(persistHandoffDocument).toHaveBeenCalledWith(generated);
		expect(compactSpy).not.toHaveBeenCalled();
		// A second start would mean onCommitted remained false and method fallback ran.
		expect(emittedEvents.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		const endEvents = emittedEvents.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]?.errorMessage).toContain(postAppendFailure.message);
		expect(endEvents[0]?.errorMessage).not.toContain("trying the next preferred compaction method");
		expect(extensionRunner?.emit).not.toHaveBeenCalled();
	});

	it("persists a committed handoff even when session_compact publication throws", async () => {
		const generated = { document: "committed handoff" };
		const publicationFailure = new Error("session_compact publication failed");
		const extensionRunner = {
			hasHandlers: vi.fn(() => false),
			emit: vi.fn(async (event: { type: string }) => {
				if (event.type === "session_compact") throw publicationFailure;
			}),
		} as unknown as SessionMaintenanceHost["extensionRunner"];
		const persistHandoffDocument = vi.fn<SessionMaintenanceHost["persistHandoffDocument"]>(async () => {});
		maintenance = createMaintenance({
			methodOrder: ["handoff"],
			generateHandoffDocument: async () => generated,
			persistHandoffDocument,
			extensionRunner,
		});

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		expect(persistHandoffDocument).toHaveBeenCalledWith(generated);
		expect(sessionManager.getEntries().findLast(item => item.type === "compaction")).toMatchObject({
			type: "compaction",
			method: "handoff",
		});
		expect(emittedEvents.findLast(event => event.type === "auto_compaction_end")?.errorMessage).toContain(
			publicationFailure.message,
		);
	});

	it("discards an armed summary after a reset boundary and re-summarizes the new branch", async () => {
		let invocation = 0;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: `summary ${++invocation}`,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		sessionManager.appendResetBoundary();
		appendSummarizableConversation();

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		expect(compactSpy).toHaveBeenCalledTimes(2);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("summary 2");
	});

	it("does not start speculative work when async compaction is disabled", () => {
		maintenance = createMaintenance({ asyncEnabled: false });
		const compactSpy = vi.spyOn(compactionModule, "compact");

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);

		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("does not speculate when snapcompact leads the configured methods", () => {
		// Snapcompact is local and effectively instant — there is no
		// summarization latency to hide, so no background run may start.
		const compactSpy = vi.spyOn(compactionModule, "compact");
		maintenance = createMaintenance({ methodOrder: ["snapcompact", "soft"] });

		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);

		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("discards an armed summary when the real pass resolves to snapcompact", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "armed summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const snapSpy = vi.spyOn(snapcompactModule, "compact").mockImplementation(async preparation => ({
			summary: "snapcompact archive",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		// Method order changed after arming: the real pass now runs the instant
		// local method, and the stale LLM summary must not override it.
		maintenanceSettings.override("compaction.methodOrder", ["snapcompact"]);

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		expect(snapSpy).toHaveBeenCalledTimes(1);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("snapcompact archive");
		// Exactly the speculation's summarizer call — the pass never re-summarized.
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("discards an armed soft summary when the resolved method changes to handoff", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "stale soft summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const generateHandoffDocument = vi.fn<SessionMaintenanceHost["generateHandoffDocument"]>(async () => ({
			document: "fresh handoff",
		}));
		maintenance = createMaintenance({ methodOrder: ["soft"], generateHandoffDocument });
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		maintenanceSettings.override("compaction.methodOrder", ["handoff"]);

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(generateHandoffDocument).toHaveBeenCalledTimes(1);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry).toMatchObject({ type: "compaction", method: "handoff" });
		expect(entry?.type === "compaction" ? entry.summary : undefined).toContain("fresh handoff");
	});

	it("recomputes an armed summary when its effective compaction settings change", async () => {
		let invocation = 0;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: `summary ${++invocation}`,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");
		maintenanceSettings.override("compaction.keepRecentTokens", 2);

		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		expect(compactSpy).toHaveBeenCalledTimes(2);
		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("summary 2");
	});

	it("cancels in-flight speculation when automatic compaction is disabled", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			started.resolve();
			await release.promise;
			return {
				summary: "stale disabled summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await started.promise;
		expect(maintenance.speculationState).toBe("running");

		maintenanceSettings.clearOverride("compaction.enabled");
		maintenance.setAutoCompactionEnabled(false);
		expect(maintenance.speculationState).toBe("idle");
		release.resolve();
		for (let microtask = 0; microtask < 10; microtask++) await Promise.resolve();
		await maintenance.runAutoCompaction("threshold", false, false, false, { triggerContextTokens: THRESHOLD });

		expect(maintenance.speculationState).toBe("idle");
		expect(sessionManager.getEntries().filter(item => item.type === "compaction")).toHaveLength(0);
	});

	it("clears an armed speculation when manual compaction starts", async () => {
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "manual summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		maintenance.maybeStartSpeculativeCompaction(SPECULATION_BAND_START, CONTEXT_WINDOW);
		await waitForState("armed");

		await maintenance.compact();

		expect(maintenance.speculationState).toBe("idle");
	});

	it("defers a threshold pass that jumped past the band, then commits the armed result for free", async () => {
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "grace summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		// One large turn skipped the pre-threshold band entirely: deferral must
		// start the speculation itself and keep the pass non-blocking.
		expect(maintenance.deferThresholdCompactionToSpeculation(THRESHOLD + 1_000, CONTEXT_WINDOW)).toBe(true);
		expect(maintenance.speculationState).toBe("running");
		// While the run is in flight, later boundaries inside the band keep deferring.
		expect(maintenance.deferThresholdCompactionToSpeculation(THRESHOLD + 1_500, CONTEXT_WINDOW)).toBe(true);
		await waitForState("armed");

		// Armed: deferral ends so the real pass splices the result in immediately.
		expect(maintenance.deferThresholdCompactionToSpeculation(THRESHOLD + 2_000, CONTEXT_WINDOW)).toBe(false);
		await maintenance.runAutoCompaction("threshold", false, false, false, {
			triggerContextTokens: THRESHOLD + 2_000,
		});

		const entry = sessionManager.getEntries().findLast(item => item.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe("grace summary");
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("stops deferring at the grace cap so the blocking pass reclaims context", () => {
		const compactSpy = vi.spyOn(compactionModule, "compact");

		// Lead floor (8192) bounds the band for a 50K threshold: at the cap the
		// blocking pass must own the recovery again.
		const graceCap = THRESHOLD + 8_192;
		expect(maintenance.deferThresholdCompactionToSpeculation(graceCap, CONTEXT_WINDOW)).toBe(false);
		expect(maintenance.speculationState).toBe("idle");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("never defers when async compaction is disabled or a local method leads", () => {
		maintenance = createMaintenance({ asyncEnabled: false });
		expect(maintenance.deferThresholdCompactionToSpeculation(THRESHOLD + 1, CONTEXT_WINDOW)).toBe(false);
		expect(maintenance.speculationState).toBe("idle");

		// Snapcompact is local and effectively instant — blocking on it is fine.
		maintenance = createMaintenance({ methodOrder: ["snapcompact", "soft"] });
		expect(maintenance.deferThresholdCompactionToSpeculation(THRESHOLD + 1, CONTEXT_WINDOW)).toBe(false);
		expect(maintenance.speculationState).toBe("idle");
	});
});
