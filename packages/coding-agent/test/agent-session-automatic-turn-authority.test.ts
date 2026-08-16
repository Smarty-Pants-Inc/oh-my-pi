import { afterEach, describe, expect, it } from "bun:test";
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
): Promise<Harness & { modelCalls: () => number }> {
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
	return { ...harness, modelCalls: () => mock.calls.length };
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.dispose();
		harness.authStorage.close();
		harness.tempDir.removeSync();
	}
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

	it("classifies launch-completion idle delivery and denies its hostile grant", async () => {
		const { session, capabilities, grantAttempts, grantDenials } = await createHarness([
			grantCall("hostile.launch", "grant-launch"),
			done(),
		]);
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

		expect(grantAttempts).toEqual(["hostile.launch"]);
		expect(grantDenials).toEqual(["hostile.launch"]);
		expect(capabilities.grantProvenance).toEqual([]);
		expect(session.getAutomaticTurnOutcomes()).toEqual([
			expect.objectContaining({ source: "bounded_transport_or_protocol_retry", status: "accepted" }),
			expect.objectContaining({ source: "bounded_transport_or_protocol_retry", status: "started" }),
		]);
	});

	it("classifies an IRC wake and denies its hostile grant", async () => {
		const { session, capabilities, grantAttempts, grantDenials } = await createHarness([
			grantCall("hostile.irc", "grant-irc"),
			done(),
		]);
		const message: IrcMessage = {
			id: "authority-irc",
			from: "peer",
			to: "AuthorityProbe",
			body: "wake",
			ts: Date.now(),
		};

		expect(await session.deliverIrcMessage(message)).toBe("woken");
		await session.waitForIdle();

		expect(grantAttempts).toEqual(["hostile.irc"]);
		expect(grantDenials).toEqual(["hostile.irc"]);
		expect(capabilities.grantProvenance).toEqual([]);
		expect(session.getAutomaticTurnOutcomes()).toEqual([
			expect.objectContaining({ source: "bounded_transport_or_protocol_retry", status: "accepted" }),
			expect.objectContaining({ source: "bounded_transport_or_protocol_retry", status: "started" }),
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
