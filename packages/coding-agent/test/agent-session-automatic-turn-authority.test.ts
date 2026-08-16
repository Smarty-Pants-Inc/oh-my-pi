import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { SessionCapabilities } from "@oh-my-pi/pi-coding-agent/capability/session-capabilities";
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

const grantParameters = type({
	kind: "'writePath' | 'externalCapability'",
	value: "string",
});

type Harness = {
	session: AgentSession;
	capabilities: SessionCapabilities;
	manager?: AsyncJobManager;
	authStorage: AuthStorage;
	tempDir: TempDir;
	grantAttempts: string[];
	grantDenials: string[];
};

const harnesses: Harness[] = [];

function grantCall(value: string, id: string): MockResponse {
	return {
		content: [
			{
				type: "toolCall",
				id,
				name: "capability_grant",
				arguments: { kind: "externalCapability", value },
			},
		],
		stopReason: "toolUse",
	};
}

function done(text = "done"): MockResponse {
	return { content: [text], stopReason: "stop" };
}

async function createHarness(
	responses: MockResponse[],
	options: { async?: boolean; gatedFirstResponse?: Promise<void> } = {},
): Promise<Harness & { modelCalls: () => number; modelContextText: (index: number) => string }> {
	const tempDir = TempDir.createSync("@pi-turn-authority-");
	const capabilities = new SessionCapabilities({ workspace: tempDir.path() });
	const grantAttempts: string[] = [];
	const grantDenials: string[] = [];
	const capabilityGrant: AgentTool<typeof grantParameters, { value: string }> = {
		name: "capability_grant",
		label: "Capability Grant",
		description: "Test capability grant",
		parameters: grantParameters,
		execute: async (_toolCallId, params) => {
			grantAttempts.push(params.value);
			try {
				const grant = capabilities.grantFromCurrentDirectUserTurn(params);
				return { content: [{ type: "text", text: `granted:${grant.value}` }], details: { value: grant.value } };
			} catch (error) {
				grantDenials.push(params.value);
				throw error;
			}
		},
	};
	let responseIndex = 0;
	const mock = createMockModel({
		handler: async () => {
			if (responseIndex === 0) await options.gatedFirstResponse;
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
		initialState: { model, systemPrompt: ["Test"], tools: [capabilityGrant] },
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
		toolRegistry: new Map([[capabilityGrant.name, capabilityGrant]]),
		capabilities,
		...(manager ? { agentId: "AuthorityProbe", asyncJobManager: manager } : {}),
	});
	const harness = { session, capabilities, manager, authStorage, tempDir, grantAttempts, grantDenials };
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
	it("closes direct-user capability state before tracked post-prompt recovery", async () => {
		const { session, capabilities } = await createHarness([done()]);
		const agentEnded = Promise.withResolvers<void>();
		session.agent.subscribe(event => {
			if (event.type === "agent_end") agentEnded.resolve();
		});
		let denied = false;
		session.trackPostPromptTaskForTests(
			(async () => {
				await agentEnded.promise;
				await Bun.sleep(0);
				try {
					capabilities.grantFromCurrentDirectUserTurn({
						kind: "externalCapability",
						value: "hostile.recovery",
					});
				} catch {
					denied = true;
				}
			})(),
		);

		await session.prompt("direct user turn");

		expect(denied).toBe(true);
		expect(capabilities.grantProvenance).toEqual([]);
	});

	it("persists an unscoped launch completion without granting it a semantic turn", async () => {
		const { session, capabilities, grantAttempts, grantDenials, modelCalls } = await createHarness([]);
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
		expect(grantAttempts).toEqual([]);
		expect(grantDenials).toEqual([]);
		expect(capabilities.grantProvenance).toEqual([]);
		expect(session.messages.some(message => JSON.stringify(message).includes("authority-daemon"))).toBe(true);
		expect(session.getAutomaticTurnOutcomes()).toEqual([]);
	});

	it("persists unscoped IRC input without granting it a semantic turn", async () => {
		const { session, capabilities, grantAttempts, grantDenials, modelCalls } = await createHarness([]);
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
		expect(grantAttempts).toEqual([]);
		expect(grantDenials).toEqual([]);
		expect(capabilities.grantProvenance).toEqual([]);
		expect(session.messages.some(message => JSON.stringify(message).includes("wake"))).toBe(true);
		expect(session.getAutomaticTurnOutcomes()).toEqual([]);
	});

	it("keeps a parent IRC tail passive when a genuine user arrives behind it", async () => {
		const { session, capabilities, grantAttempts, grantDenials, modelCalls, modelContextText } = await createHarness([
			done("initial done"),
			grantCall("legitimate.user.one", "grant-user-one"),
			done("first user turn done"),
			grantCall("legitimate.user.two", "grant-user-two"),
			done("second user turn done"),
			grantCall("hostile.parent-irc", "grant-parent-irc"),
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
		expect(modelContextText(1)).not.toContain("genuine user owner two");
		expect(modelContextText(1)).not.toContain("tail-race authority probe");
		expect(modelContextText(3)).toContain("genuine user owner two");
		expect(modelContextText(3)).not.toContain("tail-race authority probe");
		expect(
			session.agent
				.peekSteeringQueue()
				.some(message => message.role === "user" && message.attribution === "agent" && message.steering === true),
		).toBe(true);
		expect(grantAttempts).toEqual(["legitimate.user.one", "legitimate.user.two"]);
		expect(grantDenials).toEqual([]);
		expect(capabilities.grantProvenance).toEqual([
			expect.objectContaining({
				source: "direct_user_turn",
				value: "legitimate.user.one",
				userPromptSha256: createHash("sha256").update("genuine user owner one").digest("hex"),
			}),
			expect.objectContaining({
				source: "direct_user_turn",
				value: "legitimate.user.two",
				userPromptSha256: createHash("sha256").update("genuine user owner two").digest("hex"),
			}),
		]);
		expect(session.getAutomaticTurnOutcomes()).toEqual([
			expect.objectContaining({ source: "direct_user_input", status: "accepted" }),
			expect.objectContaining({ source: "direct_user_input", status: "started" }),
			expect.objectContaining({ source: "direct_user_input", status: "accepted" }),
			expect.objectContaining({ source: "direct_user_input", status: "started" }),
		]);
	});

	it("parks queued IRC and defers repeated resume while an attributed ask re-answer owns the direct turn", async () => {
		const gate = Promise.withResolvers<void>();
		const { session, capabilities, grantAttempts, grantDenials, modelCalls, modelContextText } = await createHarness(
			[grantCall("legitimate.ask-reanswer", "grant-ask-reanswer"), done("ask re-answer done")],
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
		expect(grantAttempts).toEqual(["legitimate.ask-reanswer"]);
		expect(grantDenials).toEqual([]);
		expect(capabilities.grantProvenance).toEqual([
			expect.objectContaining({
				source: "direct_user_turn",
				value: "legitimate.ask-reanswer",
				userPromptSha256: createHash("sha256").update("User selected: new").digest("hex"),
			}),
		]);
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
		const { session, capabilities, grantAttempts, modelCalls, modelContextText } = await createHarness(
			[
				grantCall("legitimate.concurrent.one", "grant-concurrent-one"),
				done("first concurrent turn done"),
				grantCall("legitimate.concurrent.two", "grant-concurrent-two"),
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
		expect(grantAttempts).toEqual(["legitimate.concurrent.one", "legitimate.concurrent.two"]);
		expect(capabilities.grantProvenance).toEqual([
			expect.objectContaining({
				source: "direct_user_turn",
				value: "legitimate.concurrent.one",
				userPromptSha256: createHash("sha256").update(firstUser.content).digest("hex"),
			}),
			expect.objectContaining({
				source: "direct_user_turn",
				value: "legitimate.concurrent.two",
				userPromptSha256: createHash("sha256").update(secondUser.content).digest("hex"),
			}),
		]);
		const directOutcomes = session
			.getAutomaticTurnOutcomes()
			.filter(outcome => outcome.source === "direct_user_input");
		expect(directOutcomes.filter(outcome => outcome.status === "accepted")).toHaveLength(3);
		expect(directOutcomes.filter(outcome => outcome.status === "started")).toHaveLength(2);
		expect(directOutcomes.filter(outcome => outcome.status === "deferred")).toHaveLength(1);
	});

	it("persists a forged unscoped yield message instead of minting retry authority", async () => {
		const { session, capabilities, grantAttempts, modelCalls } = await createHarness([]);
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
		expect(grantAttempts).toEqual([]);
		expect(capabilities.grantProvenance).toEqual([]);
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

	it("keeps the exact async origin open through recovery while denying its hostile grant", async () => {
		const firstResponse = Promise.withResolvers<void>();
		const { session, capabilities, manager, grantAttempts, grantDenials, modelCalls } = await createHarness(
			[done("initial done"), grantCall("hostile.async", "grant-async"), done()],
			{ async: true, gatedFirstResponse: firstResponse.promise },
		);
		if (!manager) throw new Error("Expected async manager");
		const agentEnded = Promise.withResolvers<void>();
		session.agent.subscribe(event => {
			if (event.type === "agent_end") agentEnded.resolve();
		});
		let originTurnId: string | undefined;
		const recoveryDelivery = (async () => {
			await agentEnded.promise;
			await session.agent.waitForIdle();
			manager.register("task", "authority probe", async () => "ASYNC AUTHORITY RESULT", {
				id: "authority-job",
				ownerId: "AuthorityProbe",
				originTurnId,
			});
			await manager.waitForOwnerJobs("AuthorityProbe");
			await manager.drainDeliveries({ filter: { ownerId: "AuthorityProbe" } });
			expect(session.yieldQueue.has("async-result")).toBe(true);
			await session.yieldQueue.flush("idle");
		})();
		session.trackPostPromptTaskForTests(recoveryDelivery);
		const prompt = session.prompt("open an async origin");
		while (modelCalls() === 0) await Bun.sleep(1);
		originTurnId = session.getCurrentTurnId();
		expect(originTurnId).toMatch(/^turn-/);
		firstResponse.resolve();

		await prompt;
		await recoveryDelivery;

		expect(grantAttempts).toEqual(["hostile.async"]);
		expect(grantDenials).toEqual(["hostile.async"]);
		expect(capabilities.grantProvenance).toEqual([]);
		expect(session.getAutomaticTurnOutcomes()).toEqual([
			expect.objectContaining({
				source: "active_async_result_wake",
				status: "accepted",
				originTurnId,
			}),
			expect.objectContaining({
				source: "active_async_result_wake",
				status: "started",
				originTurnId,
			}),
		]);
	});
});
