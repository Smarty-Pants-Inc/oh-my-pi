import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type CustomMessage, convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected bundled anthropic model");

function userMessage(text: string, timestamp: number, steering = false): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		attribution: "user",
		timestamp,
		...(steering ? { steering: true } : {}),
	};
}

function customMessage(
	customType: string,
	content: string,
	options: {
		display: boolean;
		attribution: "user" | "agent";
		timestamp: number;
		details?: Record<string, unknown>;
	},
): CustomMessage<Record<string, unknown>> {
	return {
		role: "custom",
		customType,
		content,
		display: options.display,
		attribution: options.attribution,
		timestamp: options.timestamp,
		details: options.details,
	};
}

function waitForImmediate(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

function hiddenCompanion(
	customType: "ultrathink-notice" | "image-attachment-description",
	text: string,
	timestamp: number,
) {
	return customMessage(customType, text, { display: false, attribution: "user", timestamp });
}

describe("AgentSession queued prompt seam", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
	});

	function createAgent(): Agent {
		const mock = createMockModel({ responses: [{ content: ["unused"] }] });
		return new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
	}

	function createSession(agent = createAgent()): AgentSession {
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		vi.spyOn(agent, "continue").mockResolvedValue(undefined);
		vi.spyOn(agent, "continueQueuedMessageBlock").mockResolvedValue(undefined);
		return session;
	}

	it("exposes only sanitized user-owned prompts with stable object-identity ids", () => {
		const agent = createAgent();
		const target = createSession(agent);
		const hidden = hiddenCompanion("ultrathink-notice", "hidden companion secret", 1);
		const firstUser = userMessage("same visible text", 2, true);
		const internal = customMessage("internal-card", "internal queue secret", {
			display: true,
			attribution: "agent",
			timestamp: 3,
		});
		const skill = customMessage("skill-prompt", "expanded provider-only skill body", {
			display: true,
			attribution: "user",
			timestamp: 4,
			details: { __queueChipText: "/skill:review public args" },
		});
		const secondUser = userMessage("same visible text", 5);
		agent.replaceQueues([hidden, firstUser, internal, skill], [secondUser], true);

		const first = target.getQueuedPrompts();
		expect(first.map(({ text, delivery }) => ({ text, delivery }))).toEqual([
			{ text: "same visible text", delivery: "steer" },
			{ text: "/skill:review public args", delivery: "steer" },
			{ text: "same visible text", delivery: "afterCurrent" },
		]);
		expect(new Set(first.map(prompt => prompt.id)).size).toBe(3);
		expect(first[0]?.id).not.toBe(first[2]?.id);
		expect(first.map(prompt => prompt.id)).toEqual(target.getQueuedPrompts().map(prompt => prompt.id));
		const serialized = JSON.stringify(first);
		expect(serialized).not.toContain("hidden companion secret");
		expect(serialized).not.toContain("internal queue secret");
		expect(serialized).not.toContain("expanded provider-only skill body");
	});

	it("orders prompts by submission time across delivery queues", () => {
		const agent = createAgent();
		const target = createSession(agent);
		const olderFollowUp = userMessage("older follow-up", 10);
		const newerSteer = userMessage("newer steer", 20, true);
		agent.replaceQueues([newerSteer], [olderFollowUp], true);

		expect(target.getQueuedPrompts().map(prompt => prompt.text)).toEqual(["older follow-up", "newer steer"]);
	});

	it("reports image counts without exposing image bytes", () => {
		const agent = createAgent();
		const target = createSession(agent);
		const owner: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "inspect screenshot" },
				{ type: "image", mimeType: "image/png", data: "private-image-bytes" },
			],
			attribution: "user",
			timestamp: 25,
		};
		agent.replaceQueues([owner], [], true);

		expect(target.getQueuedPrompts()[0]).toEqual({
			id: expect.any(String),
			text: "inspect screenshot",
			delivery: "steer",
			imageCount: 1,
		});
		expect(JSON.stringify(target.getQueuedPrompts())).not.toContain("private-image-bytes");
	});

	it("keeps the display placeholder out of an image-only editor draft", () => {
		const agent = createAgent();
		const target = createSession(agent);
		const owner: UserMessage = {
			role: "user",
			content: [{ type: "image", mimeType: "image/png", data: "image-only" }],
			attribution: "user",
			timestamp: 26,
		};
		agent.replaceQueues([owner], [], true);
		const prompt = target.getQueuedPrompts()[0];
		if (!prompt) throw new Error("Expected image-only queued prompt");

		expect(prompt.text).toBe("[Image]");
		expect(target.getQueuedPromptDraft(prompt.id)).toEqual({
			text: "",
			images: [{ type: "image", mimeType: "image/png", data: "image-only" }],
		});
	});

	it("breaks equal-time ties by stable enqueue identity", () => {
		const agent = createAgent();
		const target = createSession(agent);
		const first = userMessage("first follow-up", 27);
		const second = userMessage("second steer", 27, true);
		agent.followUp(first);
		agent.steer(second);

		expect(target.getQueuedPrompts().map(prompt => prompt.text)).toEqual(["first follow-up", "second steer"]);
	});

	it("updates only the selected prompt text while preserving identity, order, timing, images, and companions", async () => {
		const agent = createAgent();
		const target = createSession(agent);
		const older = userMessage("older", 30, true);
		const companion = hiddenCompanion("image-attachment-description", "hidden image description", 31);
		const owner: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "before edit [Image #1]" },
				{ type: "image", mimeType: "image/png", data: "image-data" },
			],
			attribution: "user",
			timestamp: 32,
		};
		const newer = userMessage("newer", 33);
		agent.replaceQueues([older, companion, owner], [newer], true);
		const before = target.getQueuedPrompts();
		const id = before.find(prompt => prompt.text.startsWith("before edit"))?.id;
		if (!id) throw new Error("Expected editable queued prompt id");
		const changed = vi.fn();
		target.onQueuedPromptsChanged(changed);

		expect(await target.updateQueuedPromptText(id, "after edit [Image #1]")).toEqual({ status: "updated" });
		expect(target.getQueuedPrompts()).toEqual([
			{ id: before[0]?.id, text: "older", delivery: "steer" },
			{ id, text: "after edit [Image #1]", delivery: "steer", imageCount: 1 },
			{ id: before[2]?.id, text: "newer", delivery: "afterCurrent" },
		]);
		expect(agent.peekSteeringQueue()[1]).toBe(companion);
		expect(agent.peekSteeringQueue()[2]).toBe(owner);
		expect(target.getQueuedPromptDraft(id)).toEqual({
			text: "after edit [Image #1]",
			images: [{ type: "image", mimeType: "image/png", data: "image-data" }],
		});
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it("replaces edited images and only regenerates their owned description companion", async () => {
		const agent = createAgent();
		const target = createSession(agent);
		const magic = hiddenCompanion("ultrathink-notice", "keep magic", 33);
		const oldDescription = hiddenCompanion("image-attachment-description", "old image", 34);
		const owner: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "old [Image #1]" },
				{ type: "image", mimeType: "image/png", data: "old-image" },
			],
			attribution: "user",
			timestamp: 35,
		};
		agent.replaceQueues([magic, oldDescription, owner], [], true);
		const id = target.getQueuedPrompts()[0]?.id;
		if (!id) throw new Error("Expected image-bearing queued prompt");
		const replacement = { type: "image" as const, mimeType: "image/png", data: "new-image" };

		expect(await target.updateQueuedPromptText(id, "new [Image #1]", [replacement])).toEqual({
			status: "updated",
		});
		expect(agent.peekSteeringQueue()[0]).toBe(magic);
		expect(agent.peekSteeringQueue()).not.toContain(oldDescription);
		expect(agent.peekSteeringQueue().at(-1)).toBe(owner);
		expect(target.getQueuedPromptDraft(id)).toEqual({ text: "new [Image #1]", images: [replacement] });
	});

	it("removes only the selected prompt and its contiguous companions", async () => {
		const agent = createAgent();
		const target = createSession(agent);
		const keep = userMessage("keep", 34, true);
		const companion = hiddenCompanion("ultrathink-notice", "selected companion", 35);
		const remove = userMessage("remove", 36, true);
		const followUp = userMessage("follow up", 37);
		agent.replaceQueues([keep, companion, remove], [followUp], true);
		const id = target.getQueuedPrompts().find(prompt => prompt.text === "remove")?.id;
		if (!id) throw new Error("Expected removable queued prompt id");

		expect(await target.removeQueuedPrompt(id)).toEqual({ status: "updated" });
		expect(agent.peekSteeringQueue()).toEqual([keep]);
		expect(agent.peekFollowUpQueue()).toEqual([followUp]);
		expect(await target.removeQueuedPrompt(id)).toEqual({ status: "stale" });
	});

	it("restores the newest prompt across timing lanes in reverse chronological order", async () => {
		const agent = createAgent();
		const target = createSession(agent);
		const olderFollowUp = userMessage("older follow-up", 38);
		const newerSteer = userMessage("newer steer", 39, true);
		const newestFollowUp = userMessage("newest follow-up", 40);
		agent.replaceQueues([newerSteer], [olderFollowUp, newestFollowUp], true);

		expect((await target.popLastQueuedMessageDurably())?.text).toBe("newest follow-up");
		expect((await target.popLastQueuedMessageDurably())?.text).toBe("newer steer");
		expect((await target.popLastQueuedMessageDurably())?.text).toBe("older follow-up");
		expect(await target.popLastQueuedMessageDurably()).toBeUndefined();
	});

	it("restores by chronology after retiming appends an older prompt behind a newer one", async () => {
		const agent = createAgent();
		const target = createSession(agent);
		agent.state.isStreaming = true;
		const olderFollowUp = userMessage("older retimed", 41);
		const newerSteer = userMessage("newer stays newest", 42, true);
		agent.replaceQueues([newerSteer], [olderFollowUp], true);
		const olderId = target.getQueuedPrompts().find(prompt => prompt.text === "older retimed")?.id;
		if (!olderId) throw new Error("Expected older queued prompt");

		expect(await target.setQueuedPromptDelivery(olderId, "steer")).toEqual({ status: "updated" });
		expect(agent.peekSteeringQueue()).toEqual([newerSteer, olderFollowUp]);
		expect((await target.popLastQueuedMessageDurably())?.text).toBe("newer stays newest");
		expect((await target.popLastQueuedMessageDurably())?.text).toBe("older retimed");
		agent.state.isStreaming = false;
	});

	it("retimes only the selected owner and its contiguous preceding companions", async () => {
		const agent = createAgent();
		const target = createSession(agent);
		const existingSteer = userMessage("existing steer", 10, true);
		const earlierFollowUp = userMessage("earlier follow-up", 20);
		const unrelatedHidden = customMessage("other-hidden", "do not move", {
			display: false,
			attribution: "user",
			timestamp: 21,
		});
		const magicCompanion = hiddenCompanion("ultrathink-notice", "magic companion", 22);
		const imageCompanion = hiddenCompanion("image-attachment-description", "image companion", 23);
		const owner = userMessage("selected prompt", 24);
		const laterFollowUp = userMessage("later follow-up", 25);
		const ownerContent = owner.content;
		agent.replaceQueues(
			[existingSteer],
			[earlierFollowUp, unrelatedHidden, magicCompanion, imageCompanion, owner, laterFollowUp],
			true,
		);
		const id = target.getQueuedPrompts().find(prompt => prompt.text === "selected prompt")?.id;
		if (!id) throw new Error("Expected selected queued prompt id");
		const replaceQueues = vi.spyOn(agent, "replaceQueues");

		expect(await target.setQueuedPromptDelivery(id, "steer")).toEqual({ status: "updated" });
		await waitForImmediate();
		expect(replaceQueues.mock.calls[0]?.[2]).toBe(true);
		expect([...agent.peekSteeringQueue()]).toEqual([existingSteer, magicCompanion, imageCompanion, owner]);
		expect([...agent.peekFollowUpQueue()]).toEqual([earlierFollowUp, unrelatedHidden, laterFollowUp]);
		expect(agent.peekSteeringQueue()[1]).toBe(magicCompanion);
		expect(agent.peekSteeringQueue()[2]).toBe(imageCompanion);
		expect(agent.peekSteeringQueue()[3]).toBe(owner);
		expect(owner.content).toBe(ownerContent);
		expect(owner.timestamp).toBe(24);
		expect(owner.steering).toBe(true);
		expect(target.getQueuedPrompts().find(prompt => prompt.id === id)?.delivery).toBe("steer");

		expect(await target.setQueuedPromptDelivery(id, "steer")).toEqual({ status: "updated" });

		await waitForImmediate();
		expect(await target.setQueuedPromptDelivery(id, "afterCurrent")).toEqual({ status: "updated" });
		await waitForImmediate();
		expect([...agent.peekSteeringQueue()]).toEqual([existingSteer]);
		expect([...agent.peekFollowUpQueue()]).toEqual([
			earlierFollowUp,
			unrelatedHidden,
			laterFollowUp,
			magicCompanion,
			imageCompanion,
			owner,
		]);
		expect(agent.peekFollowUpQueue().at(-1)).toBe(owner);
		expect(owner.content).toBe(ownerContent);
		expect(owner.timestamp).toBe(24);
		expect(owner.steering).toBeUndefined();
		expect(target.getQueuedPrompts().find(prompt => prompt.id === id)).toMatchObject({
			id,
			delivery: "afterCurrent",
		});
	});

	it("notifies only for visible identity or delivery changes through one agent subscription", () => {
		const agent = createAgent();
		const subscribe = agent.subscribeQueueChanges.bind(agent);
		const unsubscribed = vi.fn();
		const subscribeSpy = vi.spyOn(agent, "subscribeQueueChanges").mockImplementation(listener => {
			const unsubscribe = subscribe(listener);
			return () => {
				unsubscribed();
				unsubscribe();
			};
		});
		const target = createSession(agent);
		const firstListener = vi.fn();
		const secondListener = vi.fn();
		target.onQueuedPromptsChanged(firstListener);
		target.onQueuedPromptsChanged(secondListener);
		expect(subscribeSpy).toHaveBeenCalledTimes(1);

		const hidden = hiddenCompanion("ultrathink-notice", "hidden", 30);
		const secondHidden = hiddenCompanion("image-attachment-description", "also hidden", 31);
		const owner = userMessage("visible", 32, true);
		agent.steer(hidden);
		expect(firstListener).not.toHaveBeenCalled();
		agent.steer(owner);
		expect(firstListener).toHaveBeenCalledTimes(1);
		expect(secondListener).toHaveBeenCalledTimes(1);
		agent.replaceQueues([hidden, secondHidden, owner], [], true);
		expect(firstListener).toHaveBeenCalledTimes(1);
		agent.replaceQueues([hidden, secondHidden], [owner], true);
		expect(firstListener).toHaveBeenCalledTimes(2);
		expect(secondListener).toHaveBeenCalledTimes(2);

		target.beginDispose();
		expect(unsubscribed).toHaveBeenCalledTimes(1);
		agent.clearAllQueues();
		expect(firstListener).toHaveBeenCalledTimes(2);
		expect(secondListener).toHaveBeenCalledTimes(2);
	});

	it("returns stale for departed owners and unavailable across lifecycle fences", async () => {
		const agent = createAgent();
		const target = createSession(agent);
		const staleOwner = userMessage("stale", 40, true);
		agent.replaceQueues([staleOwner], [], true);
		const staleId = target.getQueuedPrompts()[0]?.id;
		if (!staleId) throw new Error("Expected stale prompt id");
		agent.clearAllQueues();
		expect(await target.setQueuedPromptDelivery(staleId, "afterCurrent")).toEqual({ status: "stale" });
		expect(await target.updateQueuedPromptText(staleId, "still stale")).toEqual({ status: "stale" });
		expect(await target.removeQueuedPrompt(staleId)).toEqual({ status: "stale" });

		const liveOwner = userMessage("live", 41, true);
		agent.replaceQueues([liveOwner], [], true);
		const liveId = target.getQueuedPrompts()[0]?.id;
		if (!liveId) throw new Error("Expected live prompt id");
		const replaceQueues = vi.spyOn(agent, "replaceQueues");
		target.setLifecycleTransitionFenceForTests(true);
		expect(await target.setQueuedPromptDelivery(liveId, "afterCurrent")).toEqual({
			status: "unavailable",
			reason: "session_transition",
		});
		expect(await target.updateQueuedPromptText(liveId, "blocked edit")).toEqual({
			status: "unavailable",
			reason: "session_transition",
		});
		expect(await target.removeQueuedPrompt(liveId)).toEqual({
			status: "unavailable",
			reason: "session_transition",
		});
		expect(replaceQueues).not.toHaveBeenCalled();
		target.setLifecycleTransitionFenceForTests(false);

		target.beginDispose();
		expect(await target.setQueuedPromptDelivery(liveId, "afterCurrent")).toEqual({
			status: "unavailable",
			reason: "session_transition",
		});
		expect(agent.peekSteeringQueue()[0]).toBe(liveOwner);
	});

	it("promotes an interrupt block before aborting and keeps interrupt out of persistent delivery metadata", async () => {
		const agent = createAgent();
		const target = createSession(agent);
		agent.state.isStreaming = true;
		const existingFirst = userMessage("existing first", 50, true);
		const existingSecond = userMessage("existing second", 51, true);
		const earlierFollowUp = userMessage("earlier follow-up", 52);
		const companion = hiddenCompanion("ultrathink-notice", "selected companion", 53);
		const owner = userMessage("interrupt me", 54);
		const laterFollowUp = userMessage("later follow-up", 55);
		agent.replaceQueues([existingFirst, existingSecond], [earlierFollowUp, companion, owner, laterFollowUp], true);
		const id = target.getQueuedPrompts().find(prompt => prompt.text === "interrupt me")?.id;
		if (!id) throw new Error("Expected interrupt prompt id");

		const order: string[] = [];
		const originalReplaceQueues = agent.replaceQueues.bind(agent);
		vi.spyOn(agent, "replaceQueues").mockImplementation((steering, followUp, preserveCompanions) => {
			order.push("replace");
			originalReplaceQueues(steering, followUp, preserveCompanions);
		});
		let steeringAtAbort: AgentMessage[] | undefined;
		let followUpAtAbort: AgentMessage[] | undefined;
		const abort = vi.spyOn(target, "abort").mockImplementation(options => {
			order.push("abort");
			steeringAtAbort = [...agent.peekSteeringQueue()];
			followUpAtAbort = [...agent.peekFollowUpQueue()];
			expect(options).toEqual({ reason: USER_INTERRUPT_LABEL });
			return Promise.resolve();
		});

		expect(await target.setQueuedPromptDelivery(id, "interrupt")).toEqual({ status: "updated" });
		expect(order).toEqual(["replace", "abort"]);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(steeringAtAbort).toEqual([companion, owner, existingFirst, existingSecond]);
		expect(followUpAtAbort).toEqual([earlierFollowUp, laterFollowUp]);
		expect(agent.peekSteeringQueue()[0]).toBe(companion);
		expect(agent.peekSteeringQueue()[1]).toBe(owner);
		expect(owner.steering).toBe(true);
		expect(target.getQueuedPrompts().find(prompt => prompt.id === id)).toMatchObject({ id, delivery: "steer" });
		agent.state.isStreaming = false;
	});

	it("refuses NOW when the active turn ended before confirmation", async () => {
		const agent = createAgent();
		const target = createSession(agent);
		const owner = userMessage("too late to interrupt", 59);
		agent.replaceQueues([], [owner], true);
		const id = target.getQueuedPrompts()[0]?.id;
		if (!id) throw new Error("Expected queued prompt id");
		const replaceQueues = vi.spyOn(agent, "replaceQueues");
		const abort = vi.spyOn(target, "abort");

		expect(await target.setQueuedPromptDelivery(id, "interrupt")).toEqual({
			status: "unavailable",
			reason: "no_active_turn",
		});
		expect(replaceQueues).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
		expect(target.getQueuedPrompts()[0]).toMatchObject({ id, delivery: "afterCurrent" });
	});

	it("converts a collab prompt retimed to after-current as a raw user turn", async () => {
		const agent = createAgent();
		const target = createSession(agent);
		const owner = customMessage(COLLAB_PROMPT_MESSAGE_TYPE, "guest follow-up", {
			display: true,
			attribution: "user",
			timestamp: 60,
			details: { from: "guest" },
		});
		agent.replaceQueues([owner], [], true);
		const id = target.getQueuedPrompts()[0]?.id;
		if (!id) throw new Error("Expected collab queued prompt id");

		expect(await target.setQueuedPromptDelivery(id, "afterCurrent")).toEqual({ status: "updated" });
		expect(owner.details).toMatchObject({ from: "guest", __ompSteering: false });
		const converted = convertToLlm([owner]);
		expect(converted).toHaveLength(1);
		expect(converted[0]?.role).toBe("user");
		expect(JSON.stringify(converted[0])).toContain("guest follow-up");
		expect(JSON.stringify(converted[0])).not.toContain("system-notice");
	});
});
