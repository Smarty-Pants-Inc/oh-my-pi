import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { createHostBridgeTransport, LocalCollabTransport } from "@oh-my-pi/pi-coding-agent/collab/local-transport";
import { COLLAB_PROTO, type CollabFrame, type CollabUiRequestDraft } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { InMemoryCollabRouter, type InMemoryCollabTransport } from "./helpers/in-memory-transport";

const flush = async (): Promise<void> => {
	await new Promise<void>(resolve => queueMicrotask(resolve));
	await new Promise<void>(resolve => queueMicrotask(resolve));
};

interface NoticeRecord {
	level: "info" | "warning" | "error";
	message: string;
	source?: string;
}

function makeHostContext(
	prompts: { content: unknown; details?: unknown; options?: unknown }[],
	listener: { current?: (event: AgentSessionEvent) => void },
	onPrompt?: () => void,
	options?: {
		getSessionId?: () => string;
		notices?: NoticeRecord[];
		promptError?: Error;
		onAbort?: () => void;
		onRefreshRpcHostTools?: (tools: AgentTool[]) => void | Promise<void>;
	},
): InteractiveModeContext {
	return {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: options?.getSessionId ?? (() => "host-session"),
			getCwd: () => "/host",
			snapshotForReplication: () => ({
				header: {
					type: "session",
					id: options?.getSessionId?.() ?? "host-session",
					timestamp: "2026-01-01T00:00:00Z",
					cwd: "/host",
				},
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "host session",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: (callback: (event: AgentSessionEvent) => void) => {
				listener.current = callback;
				return () => {};
			},
			emitNotice: (level: NoticeRecord["level"], message: string, source?: string) => {
				options?.notices?.push({ level, message, source });
			},
			promptCustomMessage: (message: { content: unknown; details?: unknown }, promptOptions: unknown) => {
				prompts.push({ content: message.content, details: message.details, options: promptOptions });
				onPrompt?.();
				return options?.promptError ? Promise.reject(options.promptError) : Promise.resolve();
			},
			abort: () => {
				options?.onAbort?.();
				return Promise.resolve();
			},
			refreshRpcHostTools: async (tools: AgentTool[]) => options?.onRefreshRpcHostTools?.(tools),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		updatePendingMessagesDisplay: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

function connectRawPeer(transport: InMemoryCollabTransport, name: string): CollabFrame[] {
	const frames: CollabFrame[] = [];
	transport.onOpen = () => transport.send({ t: "hello", proto: COLLAB_PROTO, name });
	transport.onFrame = frame => frames.push(frame);
	transport.connect();
	return frames;
}

function framesOf<T extends CollabFrame["t"]>(frames: CollabFrame[], type: T): Extract<CollabFrame, { t: T }>[] {
	return frames.filter((frame): frame is Extract<CollabFrame, { t: T }> => frame.t === type);
}

afterEach(() => {
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("injected collab transport", () => {
	it("keeps private notices isolated and its route alive across a rolled-back provisional target append", async () => {
		let sessionId = "host-session";
		const notices: NoticeRecord[] = [];
		const listener: { current?: (event: AgentSessionEvent) => void } = {};
		const router = new InMemoryCollabRouter();
		const hostTransport = router.host();
		const ctx = makeHostContext([], listener, undefined, { getSessionId: () => sessionId, notices });
		const host = new CollabHost(ctx);
		await host.startWithTransport(hostTransport, { trustedLocal: true, privateHost: true });
		const peer = router.guest();
		router.setAuthority(peer.peerId, true);
		connectRawPeer(peer, "Herdr user");
		await flush();
		peer.send({ t: "abort" });
		await flush();
		peer.close();
		await flush();
		sessionId = "provisional-target";
		ctx.sessionManager.onEntryAppended?.({
			type: "thinking_level_change",
			id: "entry-provisional",
			parentId: null,
			timestamp: "2026-01-01T00:00:01Z",
			thinkingLevel: "low",
		});
		await flush();
		sessionId = "host-session";
		expect(hostTransport.isOpen).toBe(true);
		hostTransport.close();
		await flush();
		expect(notices).toEqual([]);
	});

	it("replays a pending private UI request after the writable native renderer disconnects and is replaced", async () => {
		const router = new InMemoryCollabRouter();
		const host = new CollabHost(makeHostContext([], {}));
		await host.startWithTransport(router.host(), { trustedLocal: true, privateHost: true });
		try {
			const first = router.guest();
			router.setAuthority(first.peerId, true);
			const firstFrames = connectRawPeer(first, "native renderer");
			await flush();

			const pending = host.requestGuestUi({ kind: "editor", title: "Needs native input" });
			if (!pending) throw new Error("expected writable private renderer to accept UI requests");
			await flush();
			const original = framesOf(firstFrames, "ui-request").at(-1);
			if (!original) throw new Error("expected private UI request");
			let settled = false;
			void pending.then(() => {
				settled = true;
			});

			first.close();
			await flush();
			expect(host.participants).toHaveLength(1);
			expect(settled).toBe(false);

			const replacement = router.guest();
			router.setAuthority(replacement.peerId, true);
			const replacementFrames = connectRawPeer(replacement, "replacement renderer");
			await flush();
			expect(framesOf(replacementFrames, "ui-request")).toEqual([original]);

			replacement.send({ t: "ui-response", reqId: original.request.reqId, value: "replacement answer" });
			expect(await pending).toEqual({ kind: "answered", value: "replacement answer" });
		} finally {
			await host.stop("test cleanup");
		}
	});

	it("rejects private-route mutations during a session mismatch and accepts them after rearm", async () => {
		let sessionId = "host-session";
		let aborts = 0;
		const prompts: { content: unknown; details?: unknown; options?: unknown }[] = [];
		const listener: { current?: (event: AgentSessionEvent) => void } = {};
		const ctx = makeHostContext(prompts, listener, undefined, {
			getSessionId: () => sessionId,
			onAbort: () => aborts++,
		});
		const router = new InMemoryCollabRouter();
		const transport = router.host();
		const host = new CollabHost(ctx);
		let rearmed: CollabHost | undefined;
		try {
			await host.startWithTransport(transport, { trustedLocal: true, privateHost: true });
			const peer = router.guest();
			router.setAuthority(peer.peerId, true);
			const frames = connectRawPeer(peer, "Herdr user");
			await flush();

			const pending = host.requestGuestUi({ kind: "select", title: "Continue?", options: ["Yes"] });
			if (!pending) throw new Error("expected writable private route");
			await flush();
			const pendingRequest = framesOf(frames, "ui-request").at(-1);
			if (!pendingRequest) throw new Error("expected private UI request");
			sessionId = "provisional-target";
			expect(host.requestGuestUi({ kind: "select", title: "Blocked", options: ["Yes"] })).toBeNull();
			expect(framesOf(frames, "ui-request")).toHaveLength(1);
			const mutations: CollabFrame[] = [
				{ t: "hello", proto: COLLAB_PROTO, name: "stale renderer" },
				{ t: "prompt", text: "blocked" },
				{ t: "abort" },
				{ t: "agent-cmd", cmd: "kill", agentId: "subagent" },
				{ t: "ui-response", reqId: pendingRequest.request.reqId, value: "Yes" },
			];
			for (const frame of mutations) transport.onFrame?.(frame, peer.peerId);
			await flush();

			expect(prompts).toEqual([]);
			expect(aborts).toBe(0);
			expect(await pending).toEqual({ kind: "unavailable" });
			expect(framesOf(frames, "welcome")).toHaveLength(1);
			expect(framesOf(frames, "error").map(frame => frame.message)).toEqual(
				mutations.map(() => "private collab route is rearming for a session switch"),
			);

			await host.stop("session switched");

			const rearmedRouter = new InMemoryCollabRouter();
			rearmed = new CollabHost(ctx);
			await rearmed.startWithTransport(rearmedRouter.host(), { trustedLocal: true, privateHost: true });
			const rearmedPeer = rearmedRouter.guest();
			rearmedRouter.setAuthority(rearmedPeer.peerId, true);
			const rearmedFrames = connectRawPeer(rearmedPeer, "Herdr user");
			await flush();

			rearmedPeer.send({ t: "prompt", text: "accepted" });
			rearmedPeer.send({ t: "abort" });
			rearmedPeer.send({ t: "agent-cmd", cmd: "kill", agentId: "subagent" });
			await flush();
			expect(prompts).toEqual([
				{
					content: "accepted",
					details: { from: "Herdr user" },
					options: { streamingBehavior: "steer", queueChipText: "accepted" },
				},
			]);
			expect(aborts).toBe(1);
			expect(framesOf(rearmedFrames, "error")).toEqual([]);

			const rearmedPending = rearmed.requestGuestUi({ kind: "select", title: "Continue?", options: ["Yes"] });
			if (!rearmedPending) throw new Error("expected writable rearmed route");
			await flush();
			const request = framesOf(rearmedFrames, "ui-request").at(-1);
			if (!request) throw new Error("expected rearmed UI request");
			rearmedPeer.send({ t: "ui-response", reqId: request.request.reqId, value: "Yes" });
			expect(await rearmedPending).toEqual({ kind: "answered", value: "Yes" });
		} finally {
			await rearmed?.stop("test cleanup");
			await host.stop("test cleanup");
		}
	});

	it("emits join, interrupt, leave, session-switch, and close notices for public collab", async () => {
		let sessionId = "host-session";
		const notices: NoticeRecord[] = [];
		const listener: { current?: (event: AgentSessionEvent) => void } = {};
		const router = new InMemoryCollabRouter();
		const host = new CollabHost(makeHostContext([], listener, undefined, { getSessionId: () => sessionId, notices }));
		await host.startWithTransport(router.host(), { trustedLocal: true });
		const peer = router.guest();
		router.setAuthority(peer.peerId, true);
		connectRawPeer(peer, "Public guest");
		await flush();
		peer.send({ t: "abort" });
		await flush();
		peer.close();
		await flush();
		sessionId = "committed-target";
		listener.current?.({ type: "agent_start" });
		await flush();

		const closeRouter = new InMemoryCollabRouter();
		const closeTransport = closeRouter.host();
		const closeHost = new CollabHost(makeHostContext([], {}, undefined, { notices }));
		await closeHost.startWithTransport(closeTransport, { trustedLocal: true });
		closeTransport.close();
		await flush();

		expect(notices).toEqual([
			{ level: "info", message: "Public guest joined the collab session", source: "collab" },
			{ level: "info", message: "Public guest interrupted", source: "collab" },
			{ level: "info", message: "Public guest left the collab session", source: "collab" },
			{ level: "warning", message: "Collab ended: session switched", source: "collab" },
			{ level: "warning", message: "Collab ended: closed", source: "collab" },
		]);
	});
	it("keeps one trusted-local controller and independently routes snapshots, UI, failover, and broadcasts", async () => {
		const router = new InMemoryCollabRouter();
		const prompts: { content: unknown; details?: unknown; options?: unknown }[] = [];
		const listener: { current?: (event: AgentSessionEvent) => void } = {};
		const host = new CollabHost(makeHostContext(prompts, listener));
		await host.startWithTransport(router.host(), { trustedLocal: true });

		const firstTransport = router.guest();
		const secondTransport = router.guest();
		router.setAuthority(firstTransport.peerId, true);
		router.setAuthority(secondTransport.peerId, false);
		const firstFrames = connectRawPeer(firstTransport, "first");
		const secondFrames = connectRawPeer(secondTransport, "second");
		await flush();

		expect(framesOf(firstFrames, "welcome")).toHaveLength(1);
		expect(framesOf(secondFrames, "welcome")).toHaveLength(1);
		expect(framesOf(firstFrames, "welcome")[0]?.readOnly).toBeUndefined();
		expect(framesOf(secondFrames, "welcome")[0]?.readOnly).toBe(true);
		expect(framesOf(firstFrames, "snapshot-chunk")).toHaveLength(1);
		expect(framesOf(secondFrames, "snapshot-chunk")).toHaveLength(1);

		firstTransport.send({ t: "prompt", text: "controller prompt" });
		secondTransport.send({ t: "prompt", text: "observer prompt" });
		await flush();
		expect(prompts.map(prompt => prompt.content)).toEqual(["controller prompt"]);
		expect(framesOf(secondFrames, "error").at(-1)?.message).toContain("read-only");

		const request: CollabUiRequestDraft = { kind: "editor", title: "Need controller" };
		const pending = host.requestGuestUi(request);
		if (!pending) throw new Error("expected local controller to accept UI requests");
		await flush();
		expect(framesOf(firstFrames, "ui-request")).toHaveLength(1);
		expect(framesOf(secondFrames, "ui-request")).toHaveLength(0);
		secondTransport.send({ t: "ui-response", reqId: 1, value: "observer answer" });
		await flush();
		expect(framesOf(secondFrames, "error").at(-1)?.message).toContain("read-only");
		firstTransport.send({ t: "ui-response", reqId: 1, value: "controller answer" });
		expect(await pending).toEqual({ kind: "answered", value: "controller answer" });

		const handoffPending = host.requestGuestUi({ kind: "editor", title: "Handoff in progress" });
		if (!handoffPending) throw new Error("expected controller UI request before handoff");
		await flush();
		router.setAuthority(secondTransport.peerId, true);
		router.setAuthority(firstTransport.peerId, false);
		await flush();
		expect(framesOf(firstFrames, "authority").at(-1)).toEqual({ t: "authority", canWrite: false });
		expect(framesOf(secondFrames, "authority").at(-1)).toEqual({ t: "authority", canWrite: true });
		expect(framesOf(firstFrames, "ui-request-end").at(-1)?.reqId).toBe(2);
		expect(framesOf(secondFrames, "ui-request").at(-1)?.request.reqId).toBe(2);
		firstTransport.send({ t: "prompt", text: "former controller prompt" });
		secondTransport.send({ t: "prompt", text: "new controller prompt" });
		await flush();
		expect(prompts.map(prompt => prompt.content)).toEqual(["controller prompt", "new controller prompt"]);
		expect(framesOf(firstFrames, "error").at(-1)?.message).toContain("read-only");
		secondTransport.send({ t: "ui-response", reqId: 2, value: "new controller answer" });
		expect(await handoffPending).toEqual({ kind: "answered", value: "new controller answer" });

		const disconnectPending = host.requestGuestUi({ kind: "editor", title: "Controller disconnects" });
		if (!disconnectPending) throw new Error("expected controller UI request before disconnect");
		await flush();
		secondTransport.close();
		expect(await disconnectPending).toEqual({ kind: "unavailable" });

		const replacementTransport = router.guest();
		router.setAuthority(replacementTransport.peerId, true);
		const replacementFrames = connectRawPeer(replacementTransport, "replacement");
		await flush();
		expect(framesOf(replacementFrames, "ui-request")).toHaveLength(0);

		const releasePending = host.requestGuestUi({ kind: "editor", title: "Controller releases" });
		if (!releasePending) throw new Error("expected controller UI request before release");
		await flush();
		router.setAuthority(replacementTransport.peerId, false);
		expect(await releasePending).toEqual({ kind: "unavailable" });
		await flush();
		router.setAuthority(replacementTransport.peerId, true);
		await flush();

		const firstEventStart = firstFrames.length;
		const replacementEventStart = replacementFrames.length;
		listener.current?.({ type: "notice", level: "info", message: "one" });
		listener.current?.({ type: "notice", level: "info", message: "two" });
		await flush();
		expect(framesOf(firstFrames.slice(firstEventStart), "event").map(frame => frame.event)).toEqual([
			{ type: "notice", level: "info", message: "one" },
			{ type: "notice", level: "info", message: "two" },
		]);
		expect(framesOf(replacementFrames.slice(replacementEventStart), "event").map(frame => frame.event)).toEqual(
			framesOf(firstFrames.slice(firstEventStart), "event").map(frame => frame.event),
		);

		firstTransport.close();
		await flush();
		const replacementWelcomeCount = framesOf(replacementFrames, "welcome").length;
		replacementTransport.send({ t: "hello", proto: COLLAB_PROTO, name: "replacement again" });
		await flush();
		expect(framesOf(replacementFrames, "welcome")).toHaveLength(replacementWelcomeCount + 1);
		expect(framesOf(replacementFrames, "welcome").at(-1)?.readOnly).toBeUndefined();
		replacementTransport.send({ t: "prompt", text: "replacement controller" });
		await flush();
		expect(prompts.map(prompt => prompt.content)).toEqual([
			"controller prompt",
			"new controller prompt",
			"replacement controller",
		]);

		await host.stop("test cleanup");
	});

	it("keeps trusted-local peers read-only until explicit authority arrives", async () => {
		const router = new InMemoryCollabRouter();
		const prompts: { content: unknown; details?: unknown; options?: unknown }[] = [];
		const listener: { current?: (event: AgentSessionEvent) => void } = {};
		const host = new CollabHost(makeHostContext(prompts, listener));
		await host.startWithTransport(router.host(), { trustedLocal: true });
		const peer = router.guest();
		const frames = connectRawPeer(peer, "unassigned");
		await flush();

		expect(framesOf(frames, "welcome").at(-1)?.readOnly).toBe(true);
		peer.send({ t: "prompt", text: "must not mutate" });
		await flush();
		expect(prompts).toEqual([]);
		expect(framesOf(frames, "error").at(-1)?.message).toContain("read-only");

		router.setAuthority(peer.peerId, true);
		peer.send({ t: "prompt", text: "explicitly authorized" });
		await flush();
		expect(prompts.map(prompt => prompt.content)).toEqual(["explicitly authorized"]);
		await host.stop("test cleanup");
	});

	it("routes managed host tools only to their controller and clears ownership on replacement", async () => {
		let registeredTools: AgentTool[] = [];
		const refreshes: string[][] = [];
		const ctx = makeHostContext([], {}, undefined, {
			onRefreshRpcHostTools: tools => {
				registeredTools = tools;
				refreshes.push(tools.map(tool => tool.name));
			},
		});
		const router = new InMemoryCollabRouter();
		const host = new CollabHost(ctx);
		await host.startWithTransport(router.host(), { trustedLocal: true });
		const controller = router.guest();
		const observer = router.guest();
		router.setAuthority(controller.peerId, true);
		router.setAuthority(observer.peerId, false);
		const controllerFrames = connectRawPeer(controller, "controller");
		const observerFrames = connectRawPeer(observer, "observer");
		await flush();

		controller.send({
			t: "set-host-tools",
			reqId: 1,
			tools: [{ name: "managed", description: "Managed host tool", parameters: { type: "object" } }],
		});
		await flush();
		expect(registeredTools.map(tool => tool.name)).toEqual(["managed"]);
		expect(framesOf(controllerFrames, "host-tools-set").at(-1)).toMatchObject({ reqId: 1, toolNames: ["managed"] });
		expect(framesOf(observerFrames, "host-tools-set")).toEqual([]);

		observer.send({
			t: "set-host-tools",
			reqId: 2,
			tools: [{ name: "spoofed", description: "Spoofed", parameters: { type: "object" } }],
		});
		await flush();
		expect(framesOf(observerFrames, "host-tools-set").at(-1)?.error).toContain("read-only");
		expect(registeredTools.map(tool => tool.name)).toEqual(["managed"]);

		const updates: unknown[] = [];
		const execution = registeredTools[0]!.execute("toolu-1", { value: 1 }, undefined, update => updates.push(update));
		await flush();
		const call = framesOf(controllerFrames, "host-tool-call").at(-1)?.frame;
		if (!call) throw new Error("expected managed host tool call");
		expect(framesOf(observerFrames, "host-tool-call")).toEqual([]);

		observer.send({
			t: "host-tool-result",
			frame: {
				type: "host_tool_result",
				id: call.id,
				result: { content: [{ type: "text", text: "spoofed" }] },
			},
		});
		await flush();
		let settled = false;
		void execution.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await flush();
		expect(settled).toBe(false);

		controller.send({
			t: "host-tool-update",
			frame: {
				type: "host_tool_update",
				id: call.id,
				partialResult: { content: [{ type: "text", text: "working" }] },
			},
		});
		controller.send({
			t: "host-tool-result",
			frame: {
				type: "host_tool_result",
				id: call.id,
				result: { content: [{ type: "text", text: "done" }] },
			},
		});
		expect(await execution).toEqual({ content: [{ type: "text", text: "done" }] });
		expect(updates).toEqual([{ content: [{ type: "text", text: "working" }] }]);

		const abortController = new AbortController();
		const aborted = registeredTools[0]!.execute("toolu-2", {}, abortController.signal);
		await flush();
		const abortedCall = framesOf(controllerFrames, "host-tool-call").at(-1)?.frame;
		if (!abortedCall) throw new Error("expected abortable host tool call");
		abortController.abort();
		await expect(aborted).rejects.toThrow("was aborted");
		await flush();
		expect(framesOf(controllerFrames, "host-tool-cancel").at(-1)?.frame.targetId).toBe(abortedCall.id);
		expect(framesOf(observerFrames, "host-tool-cancel")).toEqual([]);

		const replaced = registeredTools[0]!.execute("toolu-3", {});
		await flush();
		router.setAuthority(observer.peerId, true);
		router.setAuthority(controller.peerId, false);
		await expect(replaced).rejects.toThrow("lost controller authority");
		await flush();
		expect(registeredTools).toEqual([]);

		observer.send({
			t: "set-host-tools",
			reqId: 3,
			tools: [{ name: "replacement", description: "Replacement tool", parameters: { type: "object" } }],
		});
		await flush();
		expect(registeredTools.map(tool => tool.name)).toEqual(["replacement"]);
		expect(framesOf(observerFrames, "host-tools-set").at(-1)).toMatchObject({ reqId: 3, toolNames: ["replacement"] });
		observer.close();
		await flush();
		expect(registeredTools).toEqual([]);
		expect(refreshes).toContainEqual([]);

		await host.stop("test cleanup");
	});

	it("cancels an active call before replacing a writable host-tool owner", async () => {
		let registeredTools: AgentTool[] = [];
		const host = new CollabHost(
			makeHostContext([], {}, undefined, {
				onRefreshRpcHostTools: tools => {
					registeredTools = tools;
				},
			}),
		);
		const router = new InMemoryCollabRouter();
		await host.startWithTransport(router.host(), { trustedLocal: true });
		const first = router.guest();
		const second = router.guest();
		router.setAuthority(first.peerId, true);
		router.setAuthority(second.peerId, true);
		const firstFrames = connectRawPeer(first, "first owner");
		const secondFrames = connectRawPeer(second, "second owner");
		await flush();

		first.send({
			t: "set-host-tools",
			reqId: 1,
			tools: [{ name: "first_tool", description: "First tool", parameters: { type: "object" } }],
		});
		await flush();
		const execution = registeredTools[0]!.execute("toolu-first", {});
		await flush();
		const call = framesOf(firstFrames, "host-tool-call").at(-1)?.frame;
		if (!call) throw new Error("expected first owner host tool call");

		second.send({
			t: "set-host-tools",
			reqId: 2,
			tools: [{ name: "second_tool", description: "Second tool", parameters: { type: "object" } }],
		});
		await expect(execution).rejects.toThrow("was replaced");
		await flush();

		expect(framesOf(firstFrames, "host-tool-cancel").filter(frame => frame.frame.targetId === call.id)).toHaveLength(
			1,
		);
		expect(framesOf(secondFrames, "host-tools-set").at(-1)).toMatchObject({ reqId: 2, toolNames: ["second_tool"] });
		expect(registeredTools.map(tool => tool.name)).toEqual(["second_tool"]);

		await host.stop("test cleanup");
	});

	it("does not activate queued host-tool registrations after a terminal transport close", async () => {
		const firstRefreshStarted = Promise.withResolvers<void>();
		const releaseFirstRefresh = Promise.withResolvers<void>();
		const finalCleanup = Promise.withResolvers<void>();
		let terminalClosed = false;
		let registeredTools: AgentTool[] = [];
		const refreshes: string[][] = [];
		const host = new CollabHost(
			makeHostContext([], {}, undefined, {
				onRefreshRpcHostTools: async tools => {
					const names = tools.map(tool => tool.name);
					refreshes.push(names);
					if (names[0] === "blocking") {
						firstRefreshStarted.resolve();
						await releaseFirstRefresh.promise;
					}
					registeredTools = tools;
					if (terminalClosed && names.length === 0) finalCleanup.resolve();
				},
			}),
		);
		const router = new InMemoryCollabRouter();
		const hostTransport = router.host();
		await host.startWithTransport(hostTransport, { trustedLocal: true });
		const controller = router.guest();
		router.setAuthority(controller.peerId, true);
		connectRawPeer(controller, "controller");
		await flush();
		refreshes.length = 0;

		controller.send({
			t: "set-host-tools",
			reqId: 1,
			tools: [{ name: "blocking", description: "Blocking tool", parameters: { type: "object" } }],
		});
		await firstRefreshStarted.promise;
		controller.send({
			t: "set-host-tools",
			reqId: 2,
			tools: [{ name: "queued", description: "Queued tool", parameters: { type: "object" } }],
		});
		await flush();
		terminalClosed = true;
		hostTransport.close();
		await flush();
		releaseFirstRefresh.resolve();
		await finalCleanup.promise;
		await flush();

		expect(registeredTools).toEqual([]);
		expect(refreshes).toEqual([["blocking"], []]);
	});

	it("rejects stale registrations across rapid authority revoke and regrant", async () => {
		const staleRefreshStarted = Promise.withResolvers<void>();
		const releaseStaleRefresh = Promise.withResolvers<void>();
		const freshApplied = Promise.withResolvers<void>();
		let registeredTools: AgentTool[] = [];
		const refreshes: string[][] = [];
		const host = new CollabHost(
			makeHostContext([], {}, undefined, {
				onRefreshRpcHostTools: async tools => {
					const names = tools.map(tool => tool.name);
					refreshes.push(names);
					if (names[0] === "stale") {
						staleRefreshStarted.resolve();
						await releaseStaleRefresh.promise;
					}
					registeredTools = tools;
					if (names[0] === "fresh") freshApplied.resolve();
				},
			}),
		);
		const router = new InMemoryCollabRouter();
		await host.startWithTransport(router.host(), { trustedLocal: true });
		const controller = router.guest();
		router.setAuthority(controller.peerId, true);
		const frames = connectRawPeer(controller, "controller");
		await flush();
		refreshes.length = 0;

		controller.send({
			t: "set-host-tools",
			reqId: 1,
			tools: [{ name: "stale", description: "Stale tool", parameters: { type: "object" } }],
		});
		await staleRefreshStarted.promise;
		router.setAuthority(controller.peerId, false);
		router.setAuthority(controller.peerId, true);
		controller.send({
			t: "set-host-tools",
			reqId: 2,
			tools: [{ name: "fresh", description: "Fresh tool", parameters: { type: "object" } }],
		});
		await flush();
		releaseStaleRefresh.resolve();
		await freshApplied.promise;
		await flush();

		expect(refreshes).toEqual([["stale"], [], ["fresh"]]);
		expect(registeredTools.map(tool => tool.name)).toEqual(["fresh"]);
		expect(framesOf(frames, "host-tools-set").find(frame => frame.reqId === 1)?.error).toContain(
			"no longer accepted",
		);
		expect(framesOf(frames, "host-tools-set").find(frame => frame.reqId === 2)).toMatchObject({
			toolNames: ["fresh"],
		});

		await host.stop("test cleanup");
	});

	it("settles pending guest UI as unavailable when the host stops", async () => {
		const router = new InMemoryCollabRouter();
		const prompts: { content: unknown; details?: unknown; options?: unknown }[] = [];
		const listener: { current?: (event: AgentSessionEvent) => void } = {};
		const host = new CollabHost(makeHostContext(prompts, listener));
		await host.startWithTransport(router.host(), { trustedLocal: true });
		const peer = router.guest();
		router.setAuthority(peer.peerId, true);
		connectRawPeer(peer, "controller");
		await flush();

		const clearIntervalSpy = spyOn(globalThis, "clearInterval");
		try {
			const pending = host.requestGuestUi({ kind: "editor", title: "Stops cleanly" });
			if (!pending) throw new Error("expected controller to accept UI requests");
			listener.current?.({ type: "agent_start" });
			await host.stop("test cleanup");
			expect(await pending).toEqual({ kind: "unavailable" });
			expect(clearIntervalSpy).toHaveBeenCalled();
		} finally {
			clearIntervalSpy.mockRestore();
		}
	});

	it("correlates asynchronous host prompt failures to the originating RPC request", async () => {
		const router = new InMemoryCollabRouter();
		const listener: { current?: (event: AgentSessionEvent) => void } = {};
		const host = new CollabHost(makeHostContext([], listener, undefined, { promptError: new Error("rejected") }));
		await host.startWithTransport(router.host(), { trustedLocal: true });
		const controller = router.guest();
		router.setAuthority(controller.peerId, true);
		const frames = connectRawPeer(controller, "controller");
		await flush();

		controller.send({ t: "prompt", text: "fail", requestId: "rpc-prompt-failure" });
		await flush();
		expect(framesOf(frames, "prompt-error").at(-1)).toEqual({
			t: "prompt-error",
			requestId: "rpc-prompt-failure",
			message: "prompt failed: Error: rejected",
		});
		await host.stop("test cleanup");
	});

	it("persists the trusted Herdr display name revision only with valid attribution", async () => {
		const router = new InMemoryCollabRouter();
		const prompts: { content: unknown; details?: unknown; options?: unknown }[] = [];
		const listener: { current?: (event: AgentSessionEvent) => void } = {};
		const host = new CollabHost(makeHostContext(prompts, listener));
		const local = router.host();
		Object.defineProperty(local, "requiresHerdrAttribution", { value: true });
		await host.startWithTransport(local, { trustedLocal: true });
		const controller = router.guest();
		const observer = router.guest();
		router.setAuthority(controller.peerId, true);
		router.setAuthority(observer.peerId, false);
		const controllerFrames = connectRawPeer(controller, "untrusted hello name");
		connectRawPeer(observer, "observer");
		await flush();
		const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" } as const;
		local.onFrame?.({ t: "prompt", text: "[Alice] says: raw", images: [image] }, controller.peerId, {
			displayName: "Alice",
			displayNameRevision: 2,
		});
		observer.send({ t: "prompt", text: "ignored" });
		await flush();
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatchObject({
			content: [{ type: "text", text: "[Alice] says: [Alice] says: raw" }, image],
			details: { from: "Alice", displayNameRevision: 2 },
			options: { queueChipText: "[Alice] says: [Alice] says: raw" },
		});
		local.onFrame?.({ t: "prompt", text: "missing revision", requestId: "rpc-prompt-1" }, controller.peerId, {
			displayName: "Alice",
		});
		local.onFrame?.({ t: "prompt", text: "invalid revision" }, controller.peerId, {
			displayName: "Alice",
			displayNameRevision: 0,
		});
		local.onFrame?.({ t: "prompt", text: "invalid name" }, controller.peerId, {
			displayName: "[Alice]",
			displayNameRevision: 3,
		});
		local.onFrame?.({ t: "prompt", text: "still accepted" }, controller.peerId, {
			displayName: "Alice",
			displayNameRevision: 3,
		});
		await flush();
		expect(framesOf(controllerFrames, "prompt-error").at(-1)).toEqual({
			t: "prompt-error",
			requestId: "rpc-prompt-1",
			message: "trusted local prompt is missing valid attribution or display name revision",
		});
		expect(prompts).toHaveLength(2);
		expect(prompts.at(-1)).toMatchObject({
			content: "[Alice] says: still accepted",
			details: { from: "Alice", displayNameRevision: 3 },
		});
	});

	it("does not persist public relay display name revisions", async () => {
		const router = new InMemoryCollabRouter();
		const prompts: { content: unknown; details?: unknown; options?: unknown }[] = [];
		const listener: { current?: (event: AgentSessionEvent) => void } = {};
		const host = new CollabHost(makeHostContext(prompts, listener));
		const relay = router.host();
		await host.startWithTransport(relay, { trustedLocal: true });
		const guest = router.guest();
		router.setAuthority(guest.peerId, true);
		connectRawPeer(guest, "Public guest");
		await flush();
		relay.onFrame?.({ t: "prompt", text: "spoofed revision" }, guest.peerId, {
			displayName: "Spoofed",
			displayNameRevision: 99,
		});
		await flush();
		expect(prompts).toEqual([
			{
				content: "spoofed revision",
				details: { from: "Public guest" },
				options: { streamingBehavior: "steer", queueChipText: "spoofed revision" },
			},
		]);
	});

	it("rejects startup when Herdr coalesces ready and close in one read", async () => {
		const registrations: string[] = [];
		const ctx = makeHostContext([], {});
		ctx.session.subscribe = (callback: (event: AgentSessionEvent) => void) => {
			registrations.push("session");
			callback({ type: "agent_start" });
			return () => {};
		};
		ctx.eventBus = {
			on(channel: string, _handler: (data: unknown) => void) {
				registrations.push(`event:${channel}`);
				return () => {};
			},
		} as unknown as NonNullable<InteractiveModeContext["eventBus"]>;
		ctx.sessionManager.subscribeEntryAppended = () => {
			registrations.push("entry");
			return () => {};
		};

		const socket = { write: () => 0, end: () => {} } as unknown as Bun.Socket<undefined>;
		const connectSpy = spyOn(Bun, "connect").mockImplementation(((
			options: Bun.TCPSocketConnectOptions<undefined>,
		) => {
			options.socket.open?.(socket);
			options.socket.data?.(
				socket,
				Buffer.from('{"t":"ready","routeGeneration":2}\n{"t":"close","reason":"bridge dropped"}\n'),
			);
			return Promise.resolve(socket);
		}) as typeof Bun.connect);
		const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
			(() => 0) as unknown as typeof globalThis.setInterval,
		);
		const registrySpy = spyOn(AgentRegistry.global(), "onChange");
		let terminatedReason: string | undefined;
		try {
			const host = new CollabHost(ctx);
			await expect(
				host.startWithTransport(
					createHostBridgeTransport("127.0.0.1:1", "route-token", "pane-7", "host-session", 1),
					{
						trustedLocal: true,
						privateHost: true,
						onTerminated: reason => {
							terminatedReason = reason;
						},
					},
				),
			).rejects.toThrow("bridge dropped");

			expect(terminatedReason).toBe("bridge dropped");
			expect(registrations).toEqual([]);
			expect(registrySpy).not.toHaveBeenCalled();
			expect(intervalSpy).not.toHaveBeenCalled();
		} finally {
			registrySpy.mockRestore();
			intervalSpy.mockRestore();
			connectSpy.mockRestore();
		}
	});

	it("surfaces a Herdr error before ready as the exact host startup failure", async () => {
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					socket.write('{"t":"error","code":"omp-build-mismatch","message":"expected build-a, got build-b"}\n');
				},
				data() {},
			},
		});
		try {
			const prompts: { content: unknown; details?: unknown; options?: unknown }[] = [];
			const listener: { current?: (event: AgentSessionEvent) => void } = {};
			const host = new CollabHost(makeHostContext(prompts, listener));
			await expect(
				host.startWithTransport(
					createHostBridgeTransport(`127.0.0.1:${server.port}`, "route-token", "pane-7", "host-session", 1),
					{ trustedLocal: true, privateHost: true },
				),
			).rejects.toThrow("omp-build-mismatch: expected build-a, got build-b");
		} finally {
			server.stop(true);
		}
	});
	it("rejects malformed outer attribution without closing the Herdr transport", async () => {
		const opened = Promise.withResolvers<Bun.Socket<undefined>>();
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					opened.resolve(socket);
					socket.write('{"t":"ready"}\n');
				},
				data() {},
			},
		});
		try {
			const prompts: { content: unknown; details?: unknown; options?: unknown }[] = [];
			const listener: { current?: (event: AgentSessionEvent) => void } = {};
			const accepted = Promise.withResolvers<void>();
			const host = new CollabHost(makeHostContext(prompts, listener, accepted.resolve));
			await host.startWithTransport(new LocalCollabTransport(`127.0.0.1:${server.port}`, undefined, true), {
				trustedLocal: true,
			});
			const socket = await opened.promise;
			socket.write('{"t":"peer-authority","peer":7,"canWrite":true}\n');
			socket.write(`{"t":"frame","fromPeer":7,"frame":{"t":"hello","proto":${COLLAB_PROTO},"name":"bridge"}}\n`);
			socket.write(
				'{"t":"frame","fromPeer":7,"displayName":42,"displayNameRevision":1,"frame":{"t":"prompt","text":"malformed"}}\n',
			);
			socket.write(
				'{"t":"frame","fromPeer":7,"displayName":"Alice","displayNameRevision":2,"frame":{"t":"prompt","text":"accepted"}}\n',
			);
			await accepted.promise;
			expect(prompts.map(prompt => prompt.content)).toEqual(["[Alice] says: accepted"]);
			await host.stop("test cleanup");
		} finally {
			server.stop(true);
		}
	});

	it("rejects malformed inner hello without closing the Herdr transport", async () => {
		const opened = Promise.withResolvers<Bun.Socket<undefined>>();
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					opened.resolve(socket);
					socket.write('{"t":"ready"}\n');
				},
				data() {},
			},
		});
		try {
			const prompts: { content: unknown; details?: unknown; options?: unknown }[] = [];
			const listener: { current?: (event: AgentSessionEvent) => void } = {};
			const accepted = Promise.withResolvers<void>();
			const host = new CollabHost(makeHostContext(prompts, listener, accepted.resolve));
			await host.startWithTransport(new LocalCollabTransport(`127.0.0.1:${server.port}`, undefined, true), {
				trustedLocal: true,
			});
			const socket = await opened.promise;
			socket.write('{"t":"peer-authority","peer":7,"canWrite":true}\n');
			socket.write(`{"t":"frame","fromPeer":7,"frame":{"t":"hello","proto":${COLLAB_PROTO},"name":42}}\n`);
			socket.write(`{"t":"frame","fromPeer":7,"frame":{"t":"hello","proto":${COLLAB_PROTO},"name":"bridge"}}\n`);
			socket.write(
				'{"t":"frame","fromPeer":7,"displayName":"Alice","displayNameRevision":2,"frame":{"t":"prompt","text":"accepted"}}\n',
			);
			await accepted.promise;
			expect(prompts.map(prompt => prompt.content)).toEqual(["[Alice] says: accepted"]);
			await host.stop("test cleanup");
		} finally {
			server.stop(true);
		}
	});

	it("delivers two 500 KiB images from the local bridge exactly once", async () => {
		const opened = Promise.withResolvers<Bun.Socket<undefined>>();
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					opened.resolve(socket);
					socket.write('{"t":"ready"}\n');
				},
				data() {},
			},
		});
		try {
			const prompts: { content: unknown; details?: unknown; options?: unknown }[] = [];
			const listener: { current?: (event: AgentSessionEvent) => void } = {};
			const accepted = Promise.withResolvers<void>();
			const host = new CollabHost(makeHostContext(prompts, listener, accepted.resolve));
			await host.startWithTransport(new LocalCollabTransport(`127.0.0.1:${server.port}`, undefined, true), {
				trustedLocal: true,
			});
			const socket = await opened.promise;
			const data = Buffer.alloc(500 * 1024, 0x7f).toString("base64");
			const images = [
				{ type: "image", data, mimeType: "image/png" },
				{ type: "image", data, mimeType: "image/png" },
			];
			const records =
				'{"t":"peer-authority","peer":7,"canWrite":true}\n' +
				`{"t":"frame","fromPeer":7,"frame":{"t":"hello","proto":${COLLAB_PROTO},"name":"bridge"}}\n` +
				`${JSON.stringify({ t: "frame", fromPeer: 7, displayName: "Alice", displayNameRevision: 2, frame: { t: "prompt", text: "accepted", images } })}\n`;
			for (let offset = 0; offset < records.length; offset += 64 * 1024) {
				socket.write(records.slice(offset, offset + 64 * 1024));
				await Bun.sleep(0);
			}
			await accepted.promise;
			expect(prompts).toHaveLength(1);
			expect(prompts[0]?.content).toEqual([{ type: "text", text: "[Alice] says: accepted" }, ...images]);
			await host.stop("test cleanup");
		} finally {
			server.stop(true);
		}
	});
});
