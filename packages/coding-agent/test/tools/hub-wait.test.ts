/**
 * Unified `hub` wait: one blocking primitive racing background jobs against
 * incoming peer messages. These contracts are new to the merge — the halves
 * (pure message wait, pure job poll) are covered by the pre-existing
 * messaging/job suites.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type CoordinationDetails, HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";

const SELF_ID = "Main";

function makeSession(manager: AsyncJobManager | undefined): ToolSession {
	const stub = {
		cwd: process.cwd(),
		settings: {
			get(key: string): unknown {
				if (key === "async.pollWaitDuration") return "5m";
				if (key === "irc.timeoutMs") return 120_000;
				return undefined;
			},
		},
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => SELF_ID,
	};
	// Structurally-partial test session: HubTool only touches the fields above.
	return stub as unknown as ToolSession;
}

/** Register a job that never settles on its own; returns its id + resolver. */
function registerHangingJob(
	manager: AsyncJobManager,
	label: string,
): { id: string; finish: (text: string, resultContent?: AsyncJob["resultContent"]) => void } {
	const gate = Promise.withResolvers<{ text: string; resultContent?: AsyncJob["resultContent"] }>();
	const id = manager.register(
		"bash",
		label,
		async ({ setResultContent }) => {
			const result = await gate.promise;
			if (result.resultContent) setResultContent(result.resultContent);
			return result.text;
		},
		{ ownerId: SELF_ID },
	);
	return { id, finish: (text, resultContent) => gate.resolve({ text, resultContent }) };
}

describe("hub unified wait", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("an incoming message settles the wait while watched jobs keep running", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "sleep forever");
		const tool = new HubTool(makeSession(manager));

		// The bus waiter is parked synchronously before execute()'s first
		// suspension, so the send below cannot race the park.
		const pending = tool.execute("call_1", { op: "wait" });
		await IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "shared file is yours" });

		const result = await pending;
		const details = result.details as CoordinationDetails;
		expect(result.isError).not.toBe(true);
		expect(details.op).toBe("wait");
		expect(details.waited?.from).toBe("Peer");
		expect(details.waited?.body).toBe("shared file is yours");
		// The job was not consumed by the message win.
		expect(manager.getJob(job.id)?.status).toBe("running");

		manager.cancel(job.id);
	});

	test("requeues a photo-finish job when a peer message wins", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const automaticDeliveries: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink(SELF_ID, (jobId, text) => {
			automaticDeliveries.push({ jobId, text });
		});
		const job = registerHangingJob(manager, "photo finish");
		const pending = new HubTool(makeSession(manager)).execute("call_photo_finish", { op: "wait", ids: [job.id] });

		// Resolving the parked message waiter first makes the message the race
		// winner; settling the job in the same turn keeps it watched until cleanup.
		const send = IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "message wins" });
		job.finish("job also finished");
		await send;
		const result = await pending;
		await manager.drainDeliveries({ filter: { ownerId: SELF_ID }, timeoutMs: 100 });

		const details = result.details as CoordinationDetails;
		expect(details.waited?.body).toBe("message wins");
		expect(manager.getJob(job.id)?.status).toBe("completed");
		expect(manager.isDeliverySuppressed(job.id)).toBe(false);
		expect(automaticDeliveries).toEqual([{ jobId: job.id, text: "job also finished" }]);
	});

	test("delivers a watched photo-finish before zero-retention eviction", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const automaticDeliveries: string[] = [];
		const manager = new AsyncJobManager({ retentionMs: 0 });
		manager.registerDeliverySink(SELF_ID, (_jobId, text) => {
			automaticDeliveries.push(text);
		});
		const job = registerHangingJob(manager, "zero retention photo finish");
		const pending = new HubTool(makeSession(manager)).execute("call_zero_retention", {
			op: "wait",
			ids: [job.id],
		});

		const send = IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "message before eviction" });
		job.finish("retained until delivery");
		await send;
		const result = await pending;
		await manager.drainDeliveries({ filter: { ownerId: SELF_ID }, timeoutMs: 100 });

		expect((result.details as CoordinationDetails).waited?.body).toBe("message before eviction");
		expect(automaticDeliveries).toEqual(["retained until delivery"]);
		expect(manager.getJob(job.id)).toBeUndefined();
	});

	test("keeps a shared watch until the overlapping manual wait acknowledges", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const automaticDeliveries: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink(SELF_ID, (_jobId, text) => {
			automaticDeliveries.push(text);
		});
		const job = registerHangingJob(manager, "shared watch");
		const tool = new HubTool(makeSession(manager));
		const messageWait = tool.execute("call_overlap_message", { op: "wait", ids: [job.id] });
		const manualWait = tool.execute("call_overlap_manual", { op: "wait", ids: [job.id] });

		const send = IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "first wait wins message" });
		job.finish("shared result");
		await send;
		const [messageResult, manualResult] = await Promise.all([messageWait, manualWait]);
		await manager.drainDeliveries({ filter: { ownerId: SELF_ID }, timeoutMs: 1 });

		expect((messageResult.details as CoordinationDetails).waited?.body).toBe("first wait wins message");
		expect((manualResult.details as CoordinationDetails).jobs?.[0]?.resultText).toBe("shared result");
		expect(manager.isDeliverySuppressed(job.id)).toBe(true);
		expect(automaticDeliveries).toEqual([]);
	});

	test("a settling job returns the snapshot exactly like the old poll", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const job = registerHangingJob(manager, "quick job");
		const tool = new HubTool(makeSession(manager));

		const pending = tool.execute("call_2", { op: "wait", ids: [job.id] });
		job.finish("done output");

		const result = await pending;
		const details = result.details as CoordinationDetails;
		expect(details.op).toBe("wait");
		expect(details.jobs?.map(j => j.status)).toEqual(["completed"]);
		expect(details.jobs?.[0]?.resultText).toBe("done output");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("## Completed (1)");
		expect(result.content).toHaveLength(1);
	});

	test("returns two image jobs with recoverable boundaries and suppresses automatic delivery", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "task", kind: "sub", parentId: SELF_ID, session: null });

		const automaticDeliveries: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink(SELF_ID, (_jobId, text) => {
			automaticDeliveries.push(text);
		});
		const first = registerHangingJob(manager, "first image job");
		const second = registerHangingJob(manager, "second image job");
		const tool = new HubTool(makeSession(manager));
		const firstImage: ImageContent = { type: "image", data: "Zmlyc3Q=", mimeType: "image/png" };
		const secondImage: ImageContent = { type: "image", data: "c2Vjb25k", mimeType: "image/jpeg" };

		const pending = tool.execute("call_images", { op: "wait", ids: [first.id, second.id] });
		first.finish("first image ready", [{ type: "text", text: "first image ready" }, firstImage]);
		second.finish("second image ready", [{ type: "text", text: "second image ready" }, secondImage]);
		const result = await pending;

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain(`Image #1: job \`${first.id}\``);
		expect(text).toContain(`Image #2: job \`${second.id}\``);
		expect(text.indexOf(`Image #1: job \`${first.id}\``)).toBeLessThan(
			text.indexOf(`Image #2: job \`${second.id}\``),
		);
		expect(text).not.toContain(firstImage.data);
		expect(text).not.toContain(secondImage.data);
		expect(result.content[1]).toBe(firstImage);
		expect(result.content[2]).toBe(secondImage);
		expect(manager.isDeliverySuppressed(first.id)).toBe(true);
		expect(manager.isDeliverySuppressed(second.id)).toBe(true);
		await manager.drainDeliveries({ filter: { ownerId: SELF_ID }, timeoutMs: 1 });
		expect(automaticDeliveries).toEqual([]);
	});

	test("spills oversized mixed job results without moving images ahead of their job map", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const firstImage: ImageContent = { type: "image", data: "c3BpbGwtZmlyc3Q=", mimeType: "image/png" };
		const secondImage: ImageContent = { type: "image", data: "c3BpbGwtc2Vjb25k", mimeType: "image/jpeg" };
		const hugeResult = `spill payload start\n${"x".repeat(8_192)}\nspill payload end`;
		const firstId = manager.register(
			"eval",
			"oversized image job",
			async ({ setResultContent }) => {
				setResultContent([{ type: "text", text: hugeResult }, firstImage]);
				return hugeResult;
			},
			{ id: "spill-image-1", ownerId: SELF_ID },
		);
		const secondId = manager.register(
			"eval",
			"small image job",
			async ({ setResultContent }) => {
				setResultContent([{ type: "text", text: "second ready" }, secondImage]);
				return "second ready";
			},
			{ id: "spill-image-2", ownerId: SELF_ID },
		);
		await Promise.all([manager.getJob(firstId)?.promise, manager.getJob(secondId)?.promise]);

		const spillSettings = Settings.isolated({
			"tools.artifactSpillThreshold": 1,
			"tools.artifactTailBytes": 1,
			"tools.artifactTailLines": 100,
			"tools.artifactHeadBytes": 1,
		});
		const saved: string[] = [];
		const context = {
			settings: spillSettings,
			sessionManager: {
				saveArtifact: async (content: string) => {
					saved.push(content);
					return "hub-spill";
				},
			},
		} as unknown as AgentToolContext;
		const result = await wrapToolWithMetaNotice(new HubTool(makeSession(manager))).execute(
			"call_spill",
			{ op: "jobs" },
			undefined,
			undefined,
			context,
		);

		expect(saved).toHaveLength(1);
		expect(saved[0]).toContain("spill payload start");
		expect(saved[0]).toContain(`Image #1: job \`${firstId}\``);
		expect(saved[0]).toContain(`Image #2: job \`${secondId}\``);
		expect(result.content.map(block => block.type)).toEqual(["text", "image", "image"]);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("artifact://hub-spill");
		expect(text).toContain(`Image #1: job \`${firstId}\``);
		expect(text).toContain(`Image #2: job \`${secondId}\``);
		expect(result.content[1]).toBe(firstImage);
		expect(result.content[2]).toBe(secondImage);
		await manager.dispose();
	});

	test("bare wait with no jobs and no running peers returns immediately", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({ id: "Sleeper", displayName: "task", kind: "sub", session: null, status: "idle" });

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const tool = new HubTool(makeSession(manager));

		// A regression to a blocking message wait fails via the test timeout.
		const result = await tool.execute("call_3", { op: "wait" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("No running background jobs to wait for.");
		expect(result.useless).toBe(true);
	});

	test("bare wait ignores a detached ref whose running status is stale", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: SELF_ID, displayName: "main", kind: "main", session: null });
		registry.register({
			id: "Zombie",
			displayName: "stale task",
			kind: "sub",
			parentId: SELF_ID,
			session: null,
			status: "running",
		});

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		// `timeoutMs: 0` would block forever if the stale ref still opened the
		// message-wait gate; the test times out instead of asserting.
		const result = await new HubTool(makeSession(manager)).execute("call_4", { op: "wait", timeoutMs: 0 });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("No running background jobs to wait for.");
		// The stale ref is reported (not silently dropped): it is the only handle
		// the caller has for clearing it with `hub cancel`.
		expect(text).toContain("Zombie");
		expect(text).toContain("no turn in flight");
	});

	test("bare wait returns a message already queued on the bus", async () => {
		const registry = AgentRegistry.global();
		// A recipient whose live hand-off throws is the only way a message
		// reaches the mailbox: `IrcBus.send` buffers solely from that catch.
		registry.register({
			id: SELF_ID,
			displayName: "main",
			kind: "main",
			session: {
				deliverIrcMessage: () => Promise.reject(new Error("session disposed")),
			},
		} as unknown as Parameters<AgentRegistry["register"]>[0]);
		// Idle peer: nothing is running, so the liveness gate would otherwise
		// short-circuit the wait before the mailbox is ever consulted.
		registry.register({ id: "Peer", displayName: "task", kind: "sub", session: null, status: "idle" });

		const firstReceipt = await IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "picked up the lock" });
		const secondReceipt = await IrcBus.global().send({ from: "Peer", to: SELF_ID, body: "starting the edit" });
		expect(firstReceipt.outcome).toBe("failed");
		expect(secondReceipt.outcome).toBe("failed");
		expect(IrcBus.global().unreadCount(SELF_ID)).toBe(2);

		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const result = await new HubTool(makeSession(manager)).execute("call_5", { op: "wait" });
		const details = result.details as CoordinationDetails;

		expect(details.op).toBe("wait");
		expect(details.waited?.from).toBe("Peer");
		expect(details.waited?.body).toBe("picked up the lock");
		// Consumed exactly one message, not merely peeked or drained the backlog.
		expect(IrcBus.global().unreadCount(SELF_ID)).toBe(1);
		expect(
			IrcBus.global()
				.inbox(SELF_ID)
				.map(message => message.body),
		).toEqual(["starting the edit"]);
	});
});
