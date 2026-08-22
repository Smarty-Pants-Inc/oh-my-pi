import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { DaemonCompletionNotification } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const recordParameters = type({ value: "string" });

type Harness = {
	session: AgentSession;
	manager?: AsyncJobManager;
	authStorage: AuthStorage;
	tempDir: TempDir;
	recorded: string[];
};

const harnesses: Harness[] = [];

function recordCall(value: string, id: string): MockResponse {
	return {
		content: [{ type: "toolCall", id, name: "record", arguments: { value } }],
		stopReason: "toolUse",
	};
}

function done(text = "done"): MockResponse {
	return { content: [text], stopReason: "stop" };
}

async function createHarness(
	responses: MockResponse[],
	options: { async?: boolean; gatedFirstResponse?: Promise<void>; onFirstProviderCall?: () => void } = {},
): Promise<Harness & { modelCalls: () => number; modelContextText: (index: number) => string }> {
	const tempDir = TempDir.createSync("@pi-turn-authority-");
	const recorded: string[] = [];
	const recordTool: AgentTool<typeof recordParameters, { value: string }> = {
		name: "record",
		label: "Record",
		description: "Record a test value",
		parameters: recordParameters,
		execute: async (_toolCallId, params) => {
			recorded.push(params.value);
			return { content: [{ type: "text", text: `recorded:${params.value}` }], details: params };
		},
	};
	let responseIndex = 0;
	const mock = createMockModel({
		handler: async () => {
			if (responseIndex === 0) {
				options.onFirstProviderCall?.();
				await options.gatedFirstResponse;
			}
			const response = responses[responseIndex++];
			if (!response) throw new Error(`Unexpected provider call ${responseIndex}`);
			return response;
		},
	});
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model");
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [recordTool] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const manager = options.async ? new AsyncJobManager({}) : undefined;
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		}),
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map([[recordTool.name, recordTool]]),
		...(manager ? { agentId: "AuthorityProbe", asyncJobManager: manager } : {}),
	});
	const harness = { session, manager, authStorage, tempDir, recorded };
	harnesses.push(harness);
	return {
		...harness,
		modelCalls: () => mock.calls.length,
		modelContextText: (index: number) => JSON.stringify(mock.calls[index]?.context.messages ?? []),
	};
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.dispose();
		harness.authStorage.close();
		harness.tempDir.removeSync();
	}
	AgentRegistry.resetGlobalForTests();
});

describe("AgentSession automatic turn authority", () => {
	it("persists an unscoped launch completion without granting it a semantic turn", async () => {
		const { session, recorded, modelCalls } = await createHarness([]);
		const owner = session.sessionManager.getSessionId();
		const completion = {
			event: "daemon-completed",
			completionId: "authority-completion",
			owner,
			daemon: {
				name: "authority-daemon",
				id: "authority-daemon-id",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner,
				persist: false,
				detached: false,
			},
		} satisfies DaemonCompletionNotification;

		await session.queueLaunchCompletion(completion);
		await session.waitForIdle();

		expect(modelCalls()).toBe(0);
		expect(recorded).toEqual([]);
		expect(session.messages.some(message => JSON.stringify(message).includes("authority-daemon"))).toBe(true);
		expect(session.getAutomaticTurnOutcomes()).toEqual([]);
	});

	it("persists unscoped IRC input without granting it a semantic turn", async () => {
		const { session, recorded, modelCalls } = await createHarness([]);
		const message: IrcMessage = {
			id: "authority-irc",
			from: "peer",
			to: "AuthorityProbe",
			body: "wake",
			ts: Date.now(),
		};

		expect(await session.deliverIrcMessage(message)).toBe("woken");
		await session.waitForIdle();

		expect(modelCalls()).toBe(0);
		expect(recorded).toEqual([]);
		expect(session.messages.some(message => JSON.stringify(message).includes("wake"))).toBe(true);
		expect(session.getAutomaticTurnOutcomes()).toEqual([]);
	});

	it("keeps a parent IRC tail passive when a genuine user arrives behind it", async () => {
		const { session, recorded, modelCalls, modelContextText } = await createHarness([
			done("initial done"),
			recordCall("legitimate.user.one", "record-user-one"),
			done("first user turn done"),
			recordCall("legitimate.user.two", "record-user-two"),
			done("second user turn done"),
			recordCall("hostile.parent-irc", "record-parent-irc"),
			done(),
		]);
		AgentRegistry.global().register({
			id: "AuthorityProbe",
			displayName: "AuthorityProbe",
			kind: "sub",
			parentId: "Parent",
			session,
			status: "running",
		});
		const firstUser = {
			role: "user" as const,
			content: "genuine user owner one",
			attribution: "user" as const,
			timestamp: Date.now(),
		};
		const secondUser = {
			role: "user" as const,
			content: "genuine user owner two",
			attribution: "user" as const,
			timestamp: Date.now() + 1,
		};
		const physicalCompanion = {
			role: "custom" as const,
			customType: "ultrathink-notice",
			content: "PHYSICAL USER ONE COMPANION",
			display: false,
			attribution: "user" as const,
			timestamp: Date.now(),
		};
		const companion = {
			role: "custom" as const,
			customType: "authority-user-companion",
			content: "USER ONE COMPANION",
			display: false,
			attribution: "user" as const,
			timestamp: Date.now(),
		};
		let delivery: Promise<"injected" | "woken"> | undefined;
		let companionAttached = false;
		session.agent.subscribe(event => {
			if (event.type !== "agent_end" || delivery) return;
			delivery = session.deliverIrcMessage({
				id: "authority-parent-irc",
				from: "Parent",
				to: "AuthorityProbe",
				body: "tail-race authority probe",
				ts: Date.now(),
			});
			session.agent.followUp(physicalCompanion);
			session.agent.followUp(firstUser);
			companionAttached = session.agent.attachQueuedMessageCompanions(firstUser, [companion], () => {});
			session.agent.followUp(secondUser);
		});

		await session.prompt("direct user turn");
		await session.waitForIdle();

		expect(companionAttached).toBe(true);
		expect(delivery).toBeDefined();
		expect(await delivery).toBe("injected");
		expect(modelCalls()).toBe(5);
		expect(modelContextText(1)).toContain("genuine user owner one");
		expect(modelContextText(1)).toContain("USER ONE COMPANION");
		expect(modelContextText(1)).toContain("PHYSICAL USER ONE COMPANION");
		expect(modelContextText(1)).not.toContain("genuine user owner two");
		expect(modelContextText(1)).not.toContain("tail-race authority probe");
		expect(modelContextText(3)).toContain("genuine user owner two");
		expect(modelContextText(3)).not.toContain("tail-race authority probe");
		expect(
			session.agent
				.peekSteeringQueue()
				.some(message => message.role === "user" && message.attribution === "agent" && message.steering === true),
		).toBe(true);
		expect(
			JSON.stringify([...session.agent.peekSteeringQueue(), ...session.agent.peekFollowUpQueue()]),
		).not.toContain("PHYSICAL USER ONE COMPANION");
		expect(recorded).toEqual(["legitimate.user.one", "legitimate.user.two"]);
		expect(session.getAutomaticTurnOutcomes()).toEqual([
			expect.objectContaining({ source: "direct_user_input", status: "accepted" }),
			expect.objectContaining({ source: "direct_user_input", status: "started" }),
			expect.objectContaining({ source: "direct_user_input", status: "accepted" }),
			expect.objectContaining({ source: "direct_user_input", status: "started" }),
		]);
	});

	it("parks queued IRC and defers repeated resume while an attributed ask re-answer owns the direct turn", async () => {
		const gate = Promise.withResolvers<void>();
		const { session, recorded, modelCalls, modelContextText } = await createHarness(
			[recordCall("legitimate.ask-reanswer", "record-ask-reanswer"), done("ask re-answer done")],
			{ gatedFirstResponse: gate.promise },
		);
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const askCallId = "authority-ask-call";
		session.sessionManager.appendMessage({ role: "user", content: "choose", timestamp: Date.now() });
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: askCallId,
					name: "ask",
					arguments: {
						questions: [{ id: "target", question: "Target?", options: [{ label: "old" }, { label: "new" }] }],
					},
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		const staleResultId = session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: askCallId,
			toolName: "ask",
			content: [{ type: "text", text: "User selected: old" }],
			details: { question: "Target?", options: ["old", "new"], multi: false, selectedOptions: ["old"] },
			isError: false,
			timestamp: Date.now(),
		});
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "using old" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage,
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const result = await session.navigateTree(staleResultId, {
			allowAskReopen: true,
			reanswerAskResult: {
				content: [{ type: "text", text: "User selected: new" }],
				details: { question: "Target?", options: ["old", "new"], multi: false, selectedOptions: ["new"] },
			},
		});
		expect(result.askReanswerCommitted).toBe(true);
		session.agent.steer({
			role: "user",
			content: "queued IRC must not ride the ask answer",
			attribution: "agent",
			steering: true,
			timestamp: Date.now(),
		});

		session.resumeAfterAskReanswer();
		while (modelCalls() === 0) await Bun.sleep(1);
		session.resumeAfterAskReanswer();
		expect(modelCalls()).toBe(1);
		gate.resolve();
		await session.waitForIdle();

		expect(modelCalls()).toBe(2);
		expect(modelContextText(0)).toContain("User selected: new");
		expect(modelContextText(0)).not.toContain("queued IRC must not ride the ask answer");
		expect(session.agent.peekSteeringQueue()).toEqual([
			expect.objectContaining({ content: "queued IRC must not ride the ask answer", attribution: "agent" }),
		]);
		expect(recorded).toEqual(["legitimate.ask-reanswer"]);
		const directOutcomes = session
			.getAutomaticTurnOutcomes()
			.filter(outcome => outcome.source === "direct_user_input");
		expect(directOutcomes.filter(outcome => outcome.status === "accepted")).toHaveLength(2);
		expect(directOutcomes.filter(outcome => outcome.status === "started")).toHaveLength(1);
		expect(directOutcomes.filter(outcome => outcome.status === "deferred")).toHaveLength(1);
	});

	it("serializes all-mode arrivals that land after the owner guard but before dequeue", async () => {
		const providerGate = Promise.withResolvers<void>();
		const dequeueGate = Promise.withResolvers<void>();
		const afterOwnerGuard = Promise.withResolvers<void>();
		const { session, recorded, modelCalls, modelContextText } = await createHarness(
			[
				recordCall("legitimate.concurrent.one", "record-concurrent-one"),
				done("first concurrent turn done"),
				recordCall("legitimate.concurrent.two", "record-concurrent-two"),
				done("second concurrent turn done"),
			],
			{ gatedFirstResponse: providerGate.promise },
		);
		const firstUser = {
			role: "user" as const,
			content: "concurrent user owner one",
			attribution: "user" as const,
			steering: true,
			timestamp: Date.now(),
		};
		const secondUser = {
			role: "user" as const,
			content: "concurrent user owner two",
			attribution: "user" as const,
			steering: true,
			timestamp: Date.now() + 1,
		};
		const ircArrival = {
			role: "user" as const,
			content: "concurrent IRC arrival",
			attribution: "agent" as const,
			steering: true,
			timestamp: Date.now() + 2,
		};
		const runOrder: string[] = [];
		session.agent.subscribe(event => {
			if (event.type === "agent_start") runOrder.push("start");
			if (event.type === "agent_end") runOrder.push("end");
		});
		session.setSteeringMode("one-at-a-time");
		session.setFollowUpMode("one-at-a-time");
		session.setInterruptMode("wait");
		let lateHookInstalled = false;
		let detachLateHook = () => {};
		const detachSetupHook = session.agent.addBeforeQueuedMessageDequeueHook(() => {
			if (lateHookInstalled) return;
			lateHookInstalled = true;
			detachLateHook = session.agent.addBeforeQueuedMessageDequeueHook(async () => {
				detachLateHook();
				afterOwnerGuard.resolve();
				await dequeueGate.promise;
			});
		});
		session.agent.steer(firstUser);

		session.resumeAfterAskReanswer();
		await afterOwnerGuard.promise;

		// The owner guard has already filtered the queue, but this later async hook
		// still holds Agent's dequeue. Real RPC/UI-equivalent writes update desired
		// settings, while A keeps the forced effective modes until its finalizer.
		session.setSteeringMode("all");
		session.setFollowUpMode("all");
		session.setInterruptMode("immediate");
		expect(session.steeringMode).toBe("all");
		expect(session.followUpMode).toBe("all");
		expect(session.interruptMode).toBe("immediate");
		expect(session.agent.getSteeringMode()).toBe("one-at-a-time");
		expect(session.agent.getFollowUpMode()).toBe("one-at-a-time");
		expect(session.agent.getInterruptMode()).toBe("wait");
		session.agent.steer(secondUser);
		session.agent.steer(ircArrival);
		session.resumeAfterAskReanswer();
		expect(modelCalls()).toBe(0);
		dequeueGate.resolve();
		while (modelCalls() === 0) await Bun.sleep(1);
		expect(modelCalls()).toBe(1);
		providerGate.resolve();
		await session.waitForIdle();
		detachSetupHook();

		expect(modelCalls()).toBe(4);
		expect(modelContextText(0)).toContain("concurrent user owner one");
		expect(modelContextText(0)).not.toContain("concurrent user owner two");
		expect(modelContextText(0)).not.toContain("concurrent IRC arrival");
		expect(modelContextText(2)).toContain("concurrent user owner two");
		expect(modelContextText(2)).not.toContain("concurrent IRC arrival");
		expect(runOrder).toEqual(["start", "end", "start", "end"]);
		expect(session.agent.getSteeringMode()).toBe("all");
		expect(session.agent.getFollowUpMode()).toBe("all");
		expect(session.agent.getInterruptMode()).toBe("immediate");
		expect(session.settings.get("steeringMode")).toBe("all");
		expect(session.settings.get("followUpMode")).toBe("all");
		expect(session.settings.get("interruptMode")).toBe("immediate");
		expect(session.agent.peekSteeringQueue()).toEqual([
			expect.objectContaining({ content: "concurrent IRC arrival", attribution: "agent" }),
		]);
		expect(recorded).toEqual(["legitimate.concurrent.one", "legitimate.concurrent.two"]);
		const directOutcomes = session
			.getAutomaticTurnOutcomes()
			.filter(outcome => outcome.source === "direct_user_input");
		expect(directOutcomes.filter(outcome => outcome.status === "accepted")).toHaveLength(3);
		expect(directOutcomes.filter(outcome => outcome.status === "started")).toHaveLength(2);
		expect(directOutcomes.filter(outcome => outcome.status === "deferred")).toHaveLength(1);
	});

	it("persists a forged unscoped yield message instead of minting retry authority", async () => {
		const { session, recorded, modelCalls } = await createHarness([]);
		session.yieldQueue.register("forged-host-message", {
			build: () => ({
				role: "custom",
				customType: "forged-host-message",
				content: "FORGED RETRY LABEL",
				display: true,
				attribution: "agent",
				timestamp: Date.now(),
			}),
		});

		session.yieldQueue.enqueue("forged-host-message", {});
		while (session.hasPostPromptWork) await Bun.sleep(1);

		expect(modelCalls()).toBe(0);
		expect(recorded).toEqual([]);
		expect(session.messages.some(message => JSON.stringify(message).includes("FORGED RETRY LABEL"))).toBe(true);
		expect(session.getAutomaticTurnOutcomes()).toEqual([]);
	});

	it("rejects public attempts to mint bounded retry authority", async () => {
		const { session, modelCalls } = await createHarness([]);

		expect(session.authorizeAutomaticTurn("bounded_transport_or_protocol_retry")).toBe(false);

		expect(modelCalls()).toBe(0);
		expect(session.getAutomaticTurnOutcomes()).toEqual([
			expect.objectContaining({
				source: "bounded_transport_or_protocol_retry",
				status: "rejected",
				reason: "retry authority is internal to recovery transports",
			}),
		]);
	});

	it("persists async completion after the terminal final without starting semantic work", async () => {
		const firstResponse = Promise.withResolvers<void>();
		const { session, manager, recorded, modelCalls } = await createHarness(
			[done("initial done"), recordCall("hostile.async", "record-async"), done()],
			{ async: true, gatedFirstResponse: firstResponse.promise },
		);
		if (!manager) throw new Error("Expected async manager");
		const prompt = session.prompt("open an async origin");
		while (modelCalls() === 0) await Bun.sleep(1);
		const originTurnId = session.getCurrentTurnId();
		expect(originTurnId).toMatch(/^turn-/);
		firstResponse.resolve();

		await prompt;
		expect(session.getCurrentTurnId()).toBeUndefined();
		manager.register("task", "authority probe", async () => "ASYNC AUTHORITY RESULT", {
			id: "authority-job",
			ownerId: "AuthorityProbe",
			originTurnId,
		});
		await manager.waitForOwnerJobs("AuthorityProbe");
		await manager.drainDeliveries({ filter: { ownerId: "AuthorityProbe" } });
		await session.waitForIdle();

		expect(modelCalls()).toBe(1);
		expect(recorded).toEqual([]);
		expect(session.getAutomaticTurnOutcomes()).toEqual([]);
		expect(session.messages.some(message => JSON.stringify(message).includes("ASYNC AUTHORITY RESULT"))).toBe(true);
	});

	it("keeps late async completion passive after an explicit goal pause", async () => {
		const firstResponse = Promise.withResolvers<void>();
		const providerStarted = Promise.withResolvers<void>();
		const jobResult = Promise.withResolvers<string>();
		const { session, manager, recorded, modelCalls } = await createHarness(
			[done("initial done"), recordCall("hostile.paused-async", "record-paused-async"), done()],
			{
				async: true,
				gatedFirstResponse: firstResponse.promise,
				onFirstProviderCall: () => providerStarted.resolve(),
			},
		);
		if (!manager) throw new Error("Expected async manager");
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-pause-async",
				objective: "Pause without a late wake",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		});

		const prompt = session.prompt("start an async origin");
		await providerStarted.promise;
		const originTurnId = session.getCurrentTurnId();
		expect(originTurnId).toMatch(/^turn-/);
		manager.register("task", "paused authority probe", async () => await jobResult.promise, {
			id: "paused-authority-job",
			ownerId: "AuthorityProbe",
			originTurnId,
		});

		await session.goalRuntime.pauseGoal();
		expect(session.getGoalModeState()).toMatchObject({ enabled: false, goal: { status: "paused" } });
		expect(session.getCurrentTurnId()).toBeUndefined();
		firstResponse.resolve();
		await prompt;
		jobResult.resolve("PAUSED ASYNC AUTHORITY RESULT");
		await manager.waitForOwnerJobs("AuthorityProbe");
		await manager.drainDeliveries({ filter: { ownerId: "AuthorityProbe" } });
		await session.waitForIdle();

		expect(modelCalls()).toBe(1);
		expect(recorded).toEqual([]);
		expect(
			session
				.getAutomaticTurnOutcomes()
				.some(outcome => outcome.source === "active_async_result_wake" && outcome.status === "started"),
		).toBe(false);
		expect(session.messages.some(message => JSON.stringify(message).includes("PAUSED ASYNC AUTHORITY RESULT"))).toBe(
			true,
		);
	});

	it("keeps a queued async completion passive when the goal pauses before injection", async () => {
		const firstResponse = Promise.withResolvers<void>();
		const providerStarted = Promise.withResolvers<void>();
		const { session, manager, recorded, modelCalls } = await createHarness(
			[done("initial done"), recordCall("hostile.queued-paused-async", "record-queued-paused-async"), done()],
			{
				async: true,
				gatedFirstResponse: firstResponse.promise,
				onFirstProviderCall: () => providerStarted.resolve(),
			},
		);
		if (!manager) throw new Error("Expected async manager");
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-pause-queued-async",
				objective: "Pause before queued async injection",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		});

		const prompt = session.prompt("start an async origin");
		await providerStarted.promise;
		const originTurnId = session.getCurrentTurnId();
		expect(originTurnId).toMatch(/^turn-/);
		manager.register("task", "queued paused authority probe", async () => "QUEUED PAUSED ASYNC RESULT", {
			id: "queued-paused-authority-job",
			ownerId: "AuthorityProbe",
			originTurnId,
		});
		await manager.waitForOwnerJobs("AuthorityProbe");
		await manager.drainDeliveries({ filter: { ownerId: "AuthorityProbe" } });
		expect(session.hasPendingAsyncWork()).toBe(true);

		await session.goalRuntime.pauseGoal();
		expect(session.getCurrentTurnId()).toBeUndefined();
		expect(session.hasPendingAsyncWork()).toBe(false);
		firstResponse.resolve();
		await prompt;
		await session.waitForIdle();

		expect(modelCalls()).toBe(1);
		expect(recorded).toEqual([]);
		expect(
			session
				.getAutomaticTurnOutcomes()
				.some(outcome => outcome.source === "active_async_result_wake" && outcome.status === "started"),
		).toBe(false);
		expect(session.messages.some(message => JSON.stringify(message).includes("QUEUED PAUSED ASYNC RESULT"))).toBe(
			true,
		);
	});

	it("records a pre-dispatch goal continuation failure without a false start", async () => {
		const { session } = await createHarness([]);
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-pre-dispatch",
				objective: "Prove accurate dispatch accounting",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		});
		const failure = new Error("pre-dispatch failure");
		const prompt = session.agent.prompt.bind(session.agent);
		session.agent.prompt = async () => {
			throw failure;
		};
		try {
			await expect(
				session.promptCustomMessage({
					customType: "goal-continuation",
					content: "Continue the active goal.",
					display: false,
					attribution: "agent",
				}),
			).rejects.toThrow("pre-dispatch failure");
		} finally {
			session.agent.prompt = prompt;
		}

		const outcomes = session
			.getAutomaticTurnOutcomes()
			.filter(outcome => outcome.source === "active_goal_continuation");
		expect(outcomes.map(outcome => outcome.status)).toEqual(["accepted", "failed"]);
	});

	it("defers goal continuation when direct user input is queued at provider dispatch", async () => {
		const { session, modelCalls } = await createHarness([done()]);
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-user-precedence",
				objective: "Preserve direct user precedence",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		});
		session.agent.followUp({
			role: "user",
			content: "direct user input wins",
			attribution: "user",
			timestamp: Date.now(),
		});

		await session.promptCustomMessage({
			customType: "goal-continuation",
			content: "Continue the active goal.",
			display: false,
			attribution: "agent",
		});
		await session.waitForIdle();

		expect(modelCalls()).toBe(1);
		expect(session.agent.peekFollowUpQueue()).toEqual([]);
		expect(
			session
				.getAutomaticTurnOutcomes()
				.filter(outcome => outcome.source === "active_goal_continuation")
				.map(outcome => outcome.status),
		).toEqual(["deferred"]);
		expect(
			session
				.getAutomaticTurnOutcomes()
				.filter(outcome => outcome.source === "direct_user_input")
				.map(outcome => outcome.status),
		).toEqual(["accepted", "started"]);
	});
});
