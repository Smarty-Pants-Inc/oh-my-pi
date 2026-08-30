import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { loadAdvisorTranscriptCosts } from "@oh-my-pi/pi-coding-agent/advisor/transcript-recorder";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AsyncResultEntry } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { isSafeResponseAnchorId } from "@oh-my-pi/pi-coding-agent/session/response-anchor";
import { type AdvisorStats, SessionAdvisors } from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

function createBtwAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Check the failure mode first.", thinkingSignature: "sig" },
			{ type: "redactedThinking", data: "encrypted-side-channel-thinking" },
			{ type: "text", text: "The fix is to branch the side answer." },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		providerPayload: { type: "openaiResponsesHistory", items: [{ id: "side-channel" }] },
	};
}

function expectSanitizedBtwAssistant(message: AssistantMessage): void {
	expect(message.providerPayload).toBeUndefined();
	expect(message.content).toEqual([
		{ type: "thinking", thinking: "Check the failure mode first." },
		{ type: "text", text: "The fix is to branch the side answer." },
	]);
}

function requiredLeafId(session: AgentSession): string {
	const leafId = session.sessionManager.getLeafId();
	if (!leafId) throw new Error("Expected session leaf");
	return leafId;
}

describe("AgentSession.branchFromBtw", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-btw-branch-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		await fs.promises
			.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
			.catch(() => undefined);
		vi.restoreAllMocks();
	});

	async function createSession(options?: {
		persisted?: boolean;
		extensionRunner?: ExtensionRunner;
		handler?: MockHandler;
		advisorStreamFn?: StreamFn;
		asyncJobManager?: AsyncJobManager;
		agentId?: string;
	}) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: options?.handler ?? (() => ({ content: ["unused"] })) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager =
			options?.persisted === false ? SessionManager.inMemory() : SessionManager.create(tempDir, tempDir);
		const settings = Settings.isolated({ "compaction.enabled": false });
		authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner: options?.extensionRunner,
			...(options?.advisorStreamFn ? { advisorStreamFn: options.advisorStreamFn } : {}),
			...(options?.asyncJobManager
				? { ownedAsyncJobManager: options.asyncJobManager, agentId: options.agentId ?? "Main" }
				: {}),
		});
		return session;
	}

	function createPendingAdvisorWork(note: string) {
		const release = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const resumed = Promise.withResolvers<void>();
		const resumedCompleted = Promise.withResolvers<void>();
		let callCount = 0;
		const mock = createMockModel({
			handler: async (_context, options) => {
				callCount++;
				if (callCount === 1) started.resolve();
				if (callCount === 1) return { content: ["aborted transition attempt"], delayMs: 60_000 };
				if (callCount === 2) {
					resumed.resolve();
					await raceWithSignal(release.promise, options?.signal);
					resumedCompleted.resolve();
					return {
						content: [{ type: "toolCall", name: "advise", arguments: { note, severity: "nit" } }],
					};
				}
				return { content: [] };
			},
		});
		return { mock, release, started, resumed, resumedCompleted };
	}

	interface StableAdvisorStats {
		configured: boolean;
		active: boolean;
		model: AdvisorStats["model"];
		cost: number;
		advisors: Array<{
			name: string;
			status: AdvisorStats["advisors"][number]["status"];
			model: AdvisorStats["advisors"][number]["model"];
			cost: number;
		}>;
	}

	function stableAdvisorStats(stats: AdvisorStats): StableAdvisorStats {
		return {
			configured: stats.configured,
			active: stats.active,
			model: stats.model,
			cost: stats.cost,
			advisors: stats.advisors.map(advisor => ({
				name: advisor.name,
				status: advisor.status,
				model: advisor.model,
				cost: advisor.cost,
			})),
		};
	}

	it("creates a persisted branch with the /btw user input and complete assistant message", async () => {
		const activeSession = await createSession();
		const historicalBytes = Buffer.from([9, 8, 0xff, 7, 0, 6]);
		const allocation = await activeSession.sessionManager.allocateArtifactPath("btw");
		const historicalId = allocation.id;
		const historicalPath = allocation.path;
		const historicalRelease = allocation.release;
		if (!historicalId || !historicalPath || !historicalRelease) throw new Error("Expected artifact allocation");
		try {
			await fs.promises.writeFile(historicalPath, historicalBytes);
		} finally {
			historicalRelease();
		}
		activeSession.sessionManager.appendMessage({
			role: "user",
			content: `seed artifact://${historicalId}`,
			timestamp: Date.now() - 2,
		});
		activeSession.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 1,
		});
		activeSession.agent.replaceMessages(activeSession.sessionManager.buildSessionContext().messages);
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;
		expect(originalFile).toBeDefined();
		const originalRaw = fs.readFileSync(originalFile!, "utf8");
		const assistantMessage = createBtwAssistant();

		const result = await activeSession.branchFromBtw(
			"why did this fail?",
			assistantMessage,
			requiredLeafId(activeSession),
			activeSession.sessionManager.getSessionId(),
		);

		expect(result.cancelled).toBe(false);
		expect(result.sessionFile).toBe(activeSession.sessionFile);
		expect(result.sessionFile).toBeDefined();
		expect(result.sessionFile).not.toBe(originalFile);
		expect(fs.readFileSync(originalFile!, "utf8")).toBe(originalRaw);
		const messages = activeSession.messages;
		expect(messages.at(-2)).toMatchObject({ role: "user", content: [{ type: "text", text: "why did this fail?" }] });
		const promoted = messages.at(-1);
		expect(promoted?.role).toBe("assistant");
		if (promoted?.role !== "assistant") throw new Error("Expected promoted assistant message");
		expectSanitizedBtwAssistant(promoted);
		if (!promoted.responseAnchorId) throw new Error("Expected promoted response anchor id");
		const promotedResponseAnchorId = promoted.responseAnchorId;
		expect(isSafeResponseAnchorId(promotedResponseAnchorId)).toBe(true);
		const reopened = await SessionManager.open(result.sessionFile!, tempDir, undefined, { suppressBreadcrumb: true });
		try {
			expect(JSON.stringify(reopened.getEntries())).toContain(`artifact://${historicalId}`);
			const reopenedHistoricalPath = await reopened.getArtifactPath(historicalId);
			expect(reopenedHistoricalPath).toBeString();
			expect(await fs.promises.readFile(reopenedHistoricalPath as string)).toEqual(historicalBytes);
			const reopenedPromoted = reopened.buildSessionContext().messages.at(-1);
			if (reopenedPromoted?.role !== "assistant") throw new Error("Expected persisted promoted assistant message");
			expect(reopenedPromoted.responseAnchorId).toBe(promotedResponseAnchorId);
			const targetId = await reopened.saveArtifact("new /btw artifact", "btw");
			expect(Number(targetId)).toBeGreaterThan(Number(historicalId));
		} finally {
			await reopened.close();
		}
	});

	it("publishes retained rollback when artifact acquisition fails after the /btw host fence", async () => {
		const phases: string[] = [];
		const extensionRunner = {
			hasHandlers: vi.fn(() => false),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			emitBeforeSessionMutation: vi.fn(async (event: { type: string }) => {
				if (event.type === "session_branch") phases.push("fence");
			}),
			emitWithHostCompletion: vi.fn(
				async (event: { type: string }, finalizeBeforeHostCompletion?: () => unknown | Promise<unknown>) => {
					if (event.type === "session_branch") phases.push("branch");
					if (event.type === "session_rollback") phases.push("rollback");
					const continuation = await finalizeBeforeHostCompletion?.();
					if (typeof continuation === "function") await continuation();
				},
			),
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		activeSession.sessionManager.appendMessage(createBtwAssistant());
		activeSession.agent.replaceMessages(activeSession.sessionManager.buildSessionContext().messages);
		await activeSession.sessionManager.ensureOnDisk();
		await activeSession.sessionManager.flush();
		const retainedSessionFile = activeSession.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedLeafId = requiredLeafId(activeSession);
		const retainedEntries = structuredClone(activeSession.sessionManager.getEntries());
		const retainedRaw = fs.readFileSync(retainedSessionFile, "utf8");
		const failure = new Error("/btw artifact acquisition failed after host fence");
		vi.spyOn(activeSession.sessionManager, "beginArtifactCloneTransaction").mockRejectedValueOnce(failure);

		await expect(
			activeSession.branchFromBtw(
				"question",
				createBtwAssistant(),
				retainedLeafId,
				activeSession.sessionManager.getSessionId(),
			),
		).rejects.toBe(failure);

		expect(phases).toEqual(["fence", "rollback"]);
		expect(activeSession.sessionFile).toBe(retainedSessionFile);
		expect(activeSession.sessionManager.getLeafId()).toBe(retainedLeafId);
		expect(activeSession.sessionManager.getEntries()).toEqual(retainedEntries);
		expect(fs.readFileSync(retainedSessionFile, "utf8")).toBe(retainedRaw);
	});

	it("rolls back a /btw branch before restoring retained running work once", async () => {
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		const observedContexts: string[] = [];
		const failure = new Error("/btw async lifecycle fan-out failed");
		const jobGate = Promise.withResolvers<string>();
		const jobMarker = "/btw retained deferred owner job";
		const jobId = asyncManager.register("task", "retained /btw job", () => jobGate.promise, {
			id: "btw-retained-running-job",
			ownerId: "Main",
		});
		const extensionRunner = {
			hasHandlers: vi.fn(() => false),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			emitBeforeSessionMutation: vi.fn(async (event: { type: string }) => {
				if (event.type !== "session_branch") return;
				jobGate.resolve(jobMarker);
				await asyncManager.waitForOwnerJobs("Main");
				await asyncManager.drainDeliveries({ filter: { ownerId: "Main" } });
			}),
			emitWithHostCompletion: vi.fn(
				async (event: { type: string }, finalizeBeforeHostCompletion?: () => void | Promise<void>) => {
					if (event.type === "session_branch") throw failure;
					await finalizeBeforeHostCompletion?.();
				},
			),
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({
			extensionRunner,
			asyncJobManager: asyncManager,
			handler: context => {
				observedContexts.push(JSON.stringify(context.messages));
				return { content: ["primary reply"] };
			},
		});
		activeSession.sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		activeSession.agent.replaceMessages(activeSession.sessionManager.buildSessionContext().messages);
		await activeSession.sessionManager.ensureOnDisk();
		await activeSession.sessionManager.flush();
		const retainedLeafId = requiredLeafId(activeSession);

		await expect(
			activeSession.branchFromBtw(
				"question",
				createBtwAssistant(),
				retainedLeafId,
				activeSession.sessionManager.getSessionId(),
			),
		).rejects.toBe(failure);
		expect(asyncManager.getJob(jobId)?.status).toBe("completed");
		await activeSession.settleAsyncWork();
		expect(observedContexts.filter(context => context.includes(jobMarker))).toHaveLength(0);
		expect(JSON.stringify(activeSession.agent.state.messages).split(jobMarker)).toHaveLength(2);
		const callsAfterDelivery = observedContexts.length;
		await activeSession.settleAsyncWork();
		expect(observedContexts).toHaveLength(callsAfterDelivery);
		expect(JSON.stringify(activeSession.agent.state.messages).split(jobMarker)).toHaveLength(2);
	});

	it("commits a /btw branch by discarding retained running work and its queued receipt", async () => {
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		const observedContexts: string[] = [];
		let activeSession: AgentSession;
		const jobGate = Promise.withResolvers<string>();
		const jobMarker = "/btw discarded deferred owner job";
		const jobId = asyncManager.register("task", "retained /btw job", () => jobGate.promise, {
			id: "btw-discarded-running-job",
			ownerId: "Main",
		});
		const extensionRunner = {
			hasHandlers: vi.fn(() => false),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			emitBeforeSessionMutation: vi.fn(async (event: { type: string }) => {
				if (event.type !== "session_branch") return;
				jobGate.resolve(jobMarker);
				await asyncManager.waitForOwnerJobs("Main");
				await asyncManager.drainDeliveries({ filter: { ownerId: "Main" } });
			}),
			emitWithHostCompletion: vi.fn(
				async (_event: { type: string }, finalizeBeforeHostCompletion?: () => void | Promise<void>) => {
					await finalizeBeforeHostCompletion?.();
				},
			),
		} as unknown as ExtensionRunner;
		activeSession = await createSession({
			extensionRunner,
			asyncJobManager: asyncManager,
			handler: context => {
				observedContexts.push(JSON.stringify(context.messages));
				return { content: ["primary reply"] };
			},
		});
		activeSession.sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		activeSession.agent.replaceMessages(activeSession.sessionManager.buildSessionContext().messages);
		await activeSession.sessionManager.ensureOnDisk();
		await activeSession.sessionManager.flush();
		const retainedLeafId = requiredLeafId(activeSession);

		let receiptRejections = 0;
		let queuedReceipt: Promise<void> | undefined;
		const queuedMarker = "/btw discarded queued receipt";
		const beginYieldTransaction = activeSession.yieldQueue.beginTransaction.bind(activeSession.yieldQueue);
		vi.spyOn(activeSession.yieldQueue, "beginTransaction").mockImplementation(kind => {
			if (kind === "async-result" && !queuedReceipt) {
				queuedReceipt = activeSession.yieldQueue.enqueueWithReceipt<AsyncResultEntry>("async-result", {
					jobId: "btw-discarded-queued-receipt",
					result: queuedMarker,
					job: undefined,
					durationMs: 0,
					epoch: 0,
				});
				void queuedReceipt.catch(() => receiptRejections++);
			}
			return beginYieldTransaction(kind);
		});

		await expect(
			activeSession.branchFromBtw(
				"question",
				createBtwAssistant(),
				retainedLeafId,
				activeSession.sessionManager.getSessionId(),
			),
		).resolves.toMatchObject({ cancelled: false });
		expect(asyncManager.getJob(jobId)).toBeUndefined();
		expect(queuedReceipt).toBeDefined();
		await expect(queuedReceipt!).rejects.toThrow("Yield queue entry cleared before dispatch");
		expect(receiptRejections).toBe(1);
		expect(activeSession.hasPendingAsyncWork()).toBe(false);

		await activeSession.sendUserMessage("fresh target turn");
		expect(observedContexts.some(context => context.includes(jobMarker))).toBe(false);
		expect(observedContexts.some(context => context.includes(queuedMarker))).toBe(false);
	});

	it("restores advisor work and receipts before the /btw rollback barrier", async () => {
		const failure = new Error("/btw branch event fan-out failed");
		const phases: string[] = [];
		const pendingAdvisor = createPendingAdvisorWork("resumed /btw advisor work");
		const retainedDeliveryStarted = Promise.withResolvers<void>();
		const allowRetainedDelivery = Promise.withResolvers<void>();
		let primaryCallCount = 0;
		const primaryHandler: MockHandler = async () => {
			primaryCallCount++;
			if (primaryCallCount > 1) {
				retainedDeliveryStarted.resolve();
				await allowRetainedDelivery.promise;
			}
			return { content: ["unused"] };
		};
		let advisorResumed = false;
		void pendingAdvisor.resumed.promise.then(() => {
			advisorResumed = true;
		});
		const advisorReset = vi.spyOn(SessionAdvisors.prototype, "resetSessionState");
		const terminalGoalState: GoalModeState = {
			enabled: false,
			mode: "exiting",
			reason: "completed",
			goal: {
				id: "retained-terminal-goal",
				objective: "Preserve pending advisor work across rollback",
				status: "complete",
				tokensUsed: 7,
				timeUsedSeconds: 3,
				createdAt: 1,
				updatedAt: 2,
			},
		};
		let activeSession: AgentSession;
		let replacementSessionFile: string | undefined;
		let rollbackAtDispatch:
			| {
					sessionFile?: string;
					leafId: string | null;
					entries: string[];
					messages: AgentMessage[];
					raw: string;
					steering: AgentMessage[];
					followUp: AgentMessage[];
					checkpoint: unknown;
					advisorStats: StableAdvisorStats;
					goalModeState: GoalModeState | undefined;
					terminalGoalHistoryEntry: unknown;
					advisorYieldQueued: boolean;
					receiptSettled: boolean;
					advisorPaused: boolean;
					advisorResetCalls: number;
					advisorCalls: number;
					advisorPrompt: unknown;
			  }
			| undefined;
		const extensionRunner = {
			hasHandlers: vi.fn(() => false),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			emitBeforeSessionMutation: vi.fn(async (event: { type: string }) => {
				if (event.type === "session_branch") phases.push("fence");
			}),
			emitWithHostCompletion: vi.fn(
				async (event: { type: string }, finalizeBeforeHostCompletion?: () => void | Promise<void>) => {
					if (event.type === "session_branch") {
						phases.push("branch");
						expect(activeSession.yieldQueue.has("advisor")).toBe(false);
						expect(activeSession.getGoalModeState()).toBeUndefined();
						expect(activeSession.agent.peekSteeringQueue()).toEqual([]);
						replacementSessionFile = activeSession.sessionFile;
						throw failure;
					}
					if (event.type === "session_rollback") {
						phases.push("rollback");
						const rollbackSessionFile = retainedSessionFile;
						if (!rollbackSessionFile) throw new Error("Expected retained session file during rollback");
						rollbackAtDispatch = {
							sessionFile: activeSession.sessionFile,
							leafId: activeSession.sessionManager.getLeafId(),
							entries: activeSession.sessionManager.getEntries().map(entry => entry.id),
							messages: [...activeSession.messages],
							raw: fs.readFileSync(rollbackSessionFile, "utf8"),
							steering: [...activeSession.agent.peekSteeringQueue()],
							followUp: [...activeSession.agent.peekFollowUpQueue()],
							checkpoint: activeSession.getCheckpointState(),
							advisorStats: stableAdvisorStats(activeSession.getAdvisorStats()),
							goalModeState: activeSession.getGoalModeState(),
							terminalGoalHistoryEntry: activeSession.sessionManager
								.getEntries()
								.findLast(entry => entry.type === "mode_change" && entry.mode === "goal"),
							advisorYieldQueued: activeSession.yieldQueue.has("advisor"),
							receiptSettled,
							advisorPaused: !advisorResumed,
							advisorResetCalls: advisorReset.mock.calls.length,
							advisorCalls: pendingAdvisor.mock.calls.length,
							advisorPrompt: retainedAdvisorPrompt,
						};
					}
					await finalizeBeforeHostCompletion?.();
				},
			),
		} as unknown as ExtensionRunner;
		activeSession = await createSession({
			extensionRunner,
			advisorStreamFn: pendingAdvisor.mock.stream,
			handler: primaryHandler,
		});
		const resumedAdvisorYieldQueued = Promise.withResolvers<void>();
		let resumedReceipt: Promise<void> | undefined;
		const enqueueYield = activeSession.yieldQueue.enqueue.bind(activeSession.yieldQueue);
		vi.spyOn(activeSession.yieldQueue, "enqueue").mockImplementation((kind, entry) => {
			if (
				kind === "advisor" &&
				entry !== null &&
				typeof entry === "object" &&
				"note" in entry &&
				entry.note === "resumed /btw advisor work"
			) {
				resumedReceipt = activeSession.yieldQueue.enqueueWithReceipt(kind, entry);
				resumedAdvisorYieldQueued.resolve();
				return;
			}
			enqueueYield(kind, entry);
		});
		activeSession.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(activeSession.toggleAdvisorEnabled()).toBe(true);
		activeSession.sessionManager.appendModeChange("goal", { goal: terminalGoalState.goal });
		activeSession.setGoalModeState(terminalGoalState);
		const advisor = activeSession.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to exist");
		const retainedAdvisorMessage = createBtwAssistant();
		retainedAdvisorMessage.usage.cost.total = 7;
		advisor.emitExternalEvent({ type: "message_end", message: retainedAdvisorMessage });
		expect(activeSession.getAdvisorCost()).toBe(7);
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
		activeSession.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		activeSession.agent.replaceMessages(activeSession.sessionManager.buildSessionContext().messages);
		await activeSession.prompt("retain advisor work");
		await pendingAdvisor.started.promise;
		expect(pendingAdvisor.mock.calls).toHaveLength(1);
		await activeSession.sessionManager.ensureOnDisk();
		await activeSession.sessionManager.flush();
		const retainedSessionFile = activeSession.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedLeafId = requiredLeafId(activeSession);
		const checkpoint = {
			checkpointMessageCount: activeSession.messages.length,
			checkpointEntryId: retainedLeafId,
			startedAt: "retained",
		};
		const retainedSteer: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "retained steer" }],
			attribution: "user",
			timestamp: 3,
		};
		const retainedAdvisorCard: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "retained /btw advisor card",
			display: true,
			attribution: "agent",
			timestamp: 4,
		};
		const retainedFollowUp: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "retained follow-up" }],
			attribution: "user",
			timestamp: 5,
		};
		activeSession.setCheckpointState(checkpoint);
		activeSession.agent.replaceQueues([retainedSteer, retainedAdvisorCard], [retainedFollowUp]);
		let receiptSettled = false;
		const receipt = activeSession.yieldQueue.enqueueWithReceipt("advisor", {
			note: "retained /btw yield",
			severity: "nit" as const,
			advisor: undefined,
		});
		void receipt.then(
			() => {
				receiptSettled = true;
			},
			() => {},
		);
		const retainedAdvisorResetCalls = advisorReset.mock.calls.length;
		const retainedEntries = activeSession.sessionManager.getEntries().map(entry => entry.id);
		const retainedMessages = [...activeSession.messages];
		const retainedAdvisorStats = stableAdvisorStats(activeSession.getAdvisorStats());
		const firstAdvisorTail = pendingAdvisor.mock.calls[0]?.context.messages.at(-1);
		const retainedAdvisorPrompt = firstAdvisorTail?.role === "user" ? firstAdvisorTail.content : undefined;
		const retainedRaw = fs.readFileSync(retainedSessionFile, "utf8");

		await expect(
			activeSession.branchFromBtw(
				"why did this fail?",
				createBtwAssistant(),
				retainedLeafId,
				activeSession.sessionManager.getSessionId(),
			),
		).rejects.toBe(failure);

		expect(phases).toEqual(["fence", "branch", "rollback"]);
		expect(rollbackAtDispatch).toEqual({
			sessionFile: retainedSessionFile,
			leafId: retainedLeafId,
			entries: retainedEntries,
			messages: retainedMessages,
			raw: retainedRaw,
			steering: [retainedSteer, retainedAdvisorCard],
			followUp: [retainedFollowUp],
			checkpoint,
			advisorStats: retainedAdvisorStats,
			goalModeState: undefined,
			terminalGoalHistoryEntry: expect.objectContaining({
				type: "mode_change",
				mode: "goal",
				data: { goal: terminalGoalState.goal },
			}),
			advisorYieldQueued: true,
			receiptSettled: false,
			advisorPaused: true,
			advisorResetCalls: retainedAdvisorResetCalls,
			advisorCalls: 1,
			advisorPrompt: retainedAdvisorPrompt,
		});
		expect(receiptSettled).toBe(false);
		expect(activeSession.sessionFile).toBe(retainedSessionFile);
		expect(activeSession.sessionManager.getLeafId()).toBe(retainedLeafId);
		expect(activeSession.sessionManager.getEntries().map(entry => entry.id)).toEqual(retainedEntries);
		expect(activeSession.getAdvisorCost()).toBe(7);
		expect(activeSession.getGoalModeState()).toBeUndefined();
		expect(replacementSessionFile).toBeString();
		expect(replacementSessionFile).not.toBe(retainedSessionFile);
		expect(fs.existsSync(replacementSessionFile!)).toBe(false);

		await retainedDeliveryStarted.promise;
		await pendingAdvisor.resumed.promise;
		pendingAdvisor.release.resolve();
		await pendingAdvisor.resumedCompleted.promise;
		await resumedAdvisorYieldQueued.promise;
		allowRetainedDelivery.resolve();
		await activeSession.settleAsyncWork();
		expect(resumedReceipt).toBeDefined();
		await expect(receipt).resolves.toBeUndefined();
		await expect(resumedReceipt!).resolves.toBeUndefined();
		expect(receiptSettled).toBe(true);
		expect(activeSession.yieldQueue.has("advisor")).toBe(false);
	});
	it("does not record a late advisor turn into a /btw branch", async () => {
		const activeSession = await createSession();
		activeSession.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		activeSession.toggleAdvisorEnabled();
		const advisor = activeSession.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to exist");
		const activeAdvisor = advisor;
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const createBranchedSession = activeSession.sessionManager.createBranchedSession.bind(
			activeSession.sessionManager,
		);
		function createBranchedSessionMock(parentId: string): string | undefined;
		function createBranchedSessionMock(
			parentId: string,
			beforeJournalPublish: (newSessionFile: string) => void | Promise<void>,
		): Promise<string | undefined>;
		function createBranchedSessionMock(
			parentId: string,
			beforeJournalPublish?: (newSessionFile: string) => void | Promise<void>,
		): string | undefined | Promise<string | undefined> {
			const result = beforeJournalPublish
				? createBranchedSession(parentId, beforeJournalPublish)
				: createBranchedSession(parentId);
			const lateMessage = createBtwAssistant();
			lateMessage.usage.cost.total = 9;
			activeAdvisor.emitExternalEvent({ type: "message_end", message: lateMessage });
			return result;
		}
		vi.spyOn(activeSession.sessionManager, "createBranchedSession").mockImplementation(createBranchedSessionMock);

		const result = await activeSession.branchFromBtw(
			"question",
			createBtwAssistant(),
			requiredLeafId(activeSession),
			activeSession.sessionManager.getSessionId(),
		);
		expect(result.cancelled).toBe(false);
		const replacementSessionFile = activeSession.sessionFile;
		if (!replacementSessionFile) throw new Error("Expected the replacement session to be persisted");
		await activeSession.dispose();
		session = undefined;

		expect((await loadAdvisorTranscriptCosts(replacementSessionFile)).get("")).toBeUndefined();
	});

	it("honors session_before_branch cancellation without creating a branch", async () => {
		const emit = vi.fn(async () => ({ cancel: true }));
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit,
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;

		const result = await activeSession.branchFromBtw(
			"question",
			createBtwAssistant(),
			requiredLeafId(activeSession),
			activeSession.sessionManager.getSessionId(),
		);

		expect(result).toEqual({ cancelled: true, sessionFile: originalFile });
		expect(activeSession.sessionFile).toBe(originalFile);
		expect(emit).toHaveBeenCalledWith({
			type: "session_before_branch",
			entryId: activeSession.sessionManager.getLeafId(),
		});
	});

	it("refuses when the session leaf advances while a branch hook is pending", async () => {
		const hookStarted = Promise.withResolvers<void>();
		const hookRelease = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit: vi.fn(async () => {
				hookStarted.resolve();
				await hookRelease.promise;
				return undefined;
			}),
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;

		const branchPromise = activeSession.branchFromBtw(
			"question",
			createBtwAssistant(),
			requiredLeafId(activeSession),
			activeSession.sessionManager.getSessionId(),
		);
		await hookStarted.promise;
		activeSession.sessionManager.appendMessage({ role: "user", content: "late work", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		hookRelease.resolve();

		await expect(branchPromise).rejects.toThrow("Cannot branch /btw: session changed since /btw started");
		expect(activeSession.sessionFile).toBe(originalFile);
	});

	it("refuses when the authorized session id no longer matches the loaded session", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;
		const leafId = requiredLeafId(activeSession);

		// A resumed/branched session preserves the entry id, so the leaf still matches
		// while the loaded session is different.
		await expect(
			activeSession.branchFromBtw("question", createBtwAssistant(), leafId, "some-other-session"),
		).rejects.toThrow("Cannot branch /btw: session changed since /btw started");
		expect(activeSession.sessionFile).toBe(originalFile);
	});

	it("syncs promoted /btw messages into live context even when hooks skip conversation restore", async () => {
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit: vi.fn(async () => ({ skipConversationRestore: true })),
			emitBeforeSessionMutation: vi.fn().mockResolvedValue(undefined),
			emitWithHostCompletion: vi.fn(
				async (_event: { type: string }, finalizeBeforeHostCompletion?: () => void | Promise<void>) => {
					await finalizeBeforeHostCompletion?.();
				},
			),
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		activeSession.agent.replaceMessages(activeSession.sessionManager.buildSessionContext().messages);
		await activeSession.sessionManager.flush();
		const assistantMessage = createBtwAssistant();

		const result = await activeSession.branchFromBtw(
			"question",
			assistantMessage,
			requiredLeafId(activeSession),
			activeSession.sessionManager.getSessionId(),
		);

		expect(result.cancelled).toBe(false);
		const messages = activeSession.messages;
		expect(messages.at(-2)).toMatchObject({ role: "user", content: [{ type: "text", text: "question" }] });
		const promoted = messages.at(-1);
		expect(promoted?.role).toBe("assistant");
		if (promoted?.role !== "assistant") throw new Error("Expected promoted assistant message");
		expectSanitizedBtwAssistant(promoted);
	});

	it("refuses to defer a /btw branch while the main turn is streaming", async () => {
		const providerStarted = Promise.withResolvers<void>();
		const activeSession = await createSession({
			handler: () => {
				providerStarted.resolve();
				return { content: ["main response"], delayMs: 60_000 };
			},
		});
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;

		const promptPromise = activeSession.prompt("main prompt");
		await providerStarted.promise;
		expect(activeSession.isStreaming).toBe(true);

		await expect(
			activeSession.branchFromBtw(
				"question",
				createBtwAssistant(),
				requiredLeafId(activeSession),
				activeSession.sessionManager.getSessionId(),
			),
		).rejects.toThrow("Cannot branch /btw while session maintenance or user work is still running");
		expect(activeSession.isStreaming).toBe(true);
		expect(activeSession.sessionFile).toBe(originalFile);

		await activeSession.abort({ goalReason: "internal", reason: "test cleanup" });
		await promptPromise;
	});

	it("refuses to branch /btw while user bash work is still running", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();

		const bashPromise = activeSession.executeBash('bun -e "await Bun.sleep(60_000)"', () => undefined, {
			useUserShell: false,
		});
		expect(activeSession.isBashRunning).toBe(true);

		await expect(
			activeSession.branchFromBtw(
				"question",
				createBtwAssistant(),
				requiredLeafId(activeSession),
				activeSession.sessionManager.getSessionId(),
			),
		).rejects.toThrow("Cannot branch /btw while session maintenance or user work is still running");

		activeSession.abortBash();
		await bashPromise.catch(() => undefined);
	});

	it("refuses to branch /btw while user Python work is still running", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const abortController = new AbortController();
		const execution = Promise.withResolvers<void>().promise;
		activeSession.trackEvalExecution(execution, abortController).catch(() => undefined);
		expect(activeSession.isEvalRunning).toBe(true);

		await expect(
			activeSession.branchFromBtw(
				"question",
				createBtwAssistant(),
				requiredLeafId(activeSession),
				activeSession.sessionManager.getSessionId(),
			),
		).rejects.toThrow("Cannot branch /btw while session maintenance or user work is still running");

		abortController.abort();
	});

	it("refuses to branch /btw while context maintenance is running", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const sessionWithMaintenance = activeSession as AgentSession & { _maintenanceForTest?: boolean };
		Object.defineProperty(sessionWithMaintenance, "isCompacting", {
			get: () => sessionWithMaintenance._maintenanceForTest === true,
		});
		sessionWithMaintenance._maintenanceForTest = true;

		await expect(
			activeSession.branchFromBtw(
				"question",
				createBtwAssistant(),
				requiredLeafId(activeSession),
				activeSession.sessionManager.getSessionId(),
			),
		).rejects.toThrow("Cannot branch /btw while session maintenance or user work is still running");
	});

	it("does not treat a passive deferred message as post-prompt turn work", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		activeSession.queueDeferredMessage({
			role: "custom",
			customType: "test-hidden-message",
			content: "hidden",
			display: false,
			timestamp: Date.now(),
		});
		expect(activeSession.hasPostPromptWork).toBe(false);
	});

	it("throws for in-memory sessions", async () => {
		const activeSession = await createSession({ persisted: false });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });

		await expect(
			activeSession.branchFromBtw(
				"question",
				createBtwAssistant(),
				requiredLeafId(activeSession),
				activeSession.sessionManager.getSessionId(),
			),
		).rejects.toThrow("Cannot branch /btw: session is not persisted");
	});
});
