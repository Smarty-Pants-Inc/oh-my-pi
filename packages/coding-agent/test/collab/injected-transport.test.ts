import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { LocalCollabTransport } from "@oh-my-pi/pi-coding-agent/collab/local-transport";
import { COLLAB_PROTO, type CollabFrame, type CollabUiRequestDraft } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { InMemoryCollabRouter, type InMemoryCollabTransport } from "./helpers/in-memory-transport";

const flush = async (): Promise<void> => {
	await new Promise<void>(resolve => queueMicrotask(resolve));
	await new Promise<void>(resolve => queueMicrotask(resolve));
};

function makeHostContext(
	prompts: { content: unknown; details?: unknown; options?: unknown }[],
	listener: { current?: (event: AgentSessionEvent) => void },
	onPrompt?: () => void,
): InteractiveModeContext {
	return {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "host-session",
			getCwd: () => "/host",
			snapshotForReplication: () => ({
				header: { type: "session", id: "host-session", timestamp: "2026-01-01T00:00:00Z", cwd: "/host" },
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
			emitNotice: () => {},
			promptCustomMessage: (message: { content: unknown; details?: unknown }, options: unknown) => {
				prompts.push({ content: message.content, details: message.details, options });
				onPrompt?.();
				return Promise.resolve();
			},
			abort: () => Promise.resolve(),
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

afterEach(() => AgentRegistry.resetGlobalForTests());

describe("injected collab transport", () => {
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

	it("forwards terminal stale-todo closure rejection to collab guests", async () => {
		const router = new InMemoryCollabRouter();
		const prompts: { content: unknown; details?: unknown; options?: unknown }[] = [];
		const listener: { current?: (event: AgentSessionEvent) => void } = {};
		const host = new CollabHost(makeHostContext(prompts, listener));
		await host.startWithTransport(router.host(), { trustedLocal: true });
		const peer = router.guest();
		const frames = connectRawPeer(peer, "observer");
		await flush();

		const closureRejected = {
			reason: "stale_todos" as const,
			todos: [{ content: "Finish the requested work", status: "pending" as const }],
		};
		listener.current?.({ type: "agent_end", messages: [], closureRejected });
		await flush();

		const event = framesOf(frames, "event").at(-1)?.event;
		if (event?.type !== "agent_end") throw new Error("expected terminal agent_end frame");
		expect(event.closureRejected).toEqual(closureRejected);
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
		connectRawPeer(controller, "untrusted hello name");
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
		local.onFrame?.({ t: "prompt", text: "missing revision" }, controller.peerId, { displayName: "Alice" });
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
	it("rejects malformed outer attribution without closing the Herdr transport", async () => {
		const opened = Promise.withResolvers<Bun.Socket<undefined>>();
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					opened.resolve(socket);
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
