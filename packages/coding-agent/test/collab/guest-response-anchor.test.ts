import { expect, it, spyOn } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { COLLAB_PROTO, type CollabFrame } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type { CollabTransport } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import {
	MAX_REPLICATED_PAYLOAD_BYTES,
	shrinkForReplication,
} from "@oh-my-pi/pi-coding-agent/collab/replication-shrink";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { MAX_RESPONSE_ANCHOR_ID_BYTES } from "@oh-my-pi/pi-coding-agent/session/response-anchor";

class TestTransport implements CollabTransport {
	onOpen: (() => void) | undefined;
	onFrame: ((frame: CollabFrame, fromPeer: number) => void) | undefined;
	onClose: ((reason: string, willReconnect: boolean) => void) | undefined;
	readonly isOpen = true;

	connect(): void {
		queueMicrotask(() => this.onOpen?.());
	}

	send(frame: CollabFrame): boolean {
		if (frame.t === "hello") {
			queueMicrotask(() =>
				this.emit({
					t: "welcome",
					proto: COLLAB_PROTO,
					header: { type: "session", id: "host", timestamp: "2026-08-30T00:00:00Z", cwd: "/host" },
					state: {
						isStreaming: false,
						queuedMessageCount: 0,
						sessionName: "host",
						cwd: "/host",
						participants: [{ name: "Host", role: "host" }],
					},
					agents: [],
					entryCount: 0,
				}),
			);
		}
		return true;
	}

	close(): void {}

	emit(frame: CollabFrame): void {
		this.onFrame?.(frame, 0);
	}
}

function assistant(responseAnchorId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: responseAnchorId }],
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
		responseAnchorId,
		timestamp: 0,
	};
}

it("mirrors terminality after an oversized entry and clipped agent_end preserve the same scalar anchor", async () => {
	const staleLocal = assistant("stale-local-anchor");
	const exactResponseAnchorId = "a".repeat(MAX_RESPONSE_ANCHOR_ID_BYTES);
	const localMessages: AgentMessage[] = [staleLocal];
	const mirrored = Promise.withResolvers<void>();
	const ingested = Promise.withResolvers<void>();
	let mirroredMessage: AssistantMessage | undefined;
	let mirroredTerminal: boolean | undefined;
	const ctx = {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: { get: () => "" },
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local",
			getCwd: () => "/local",
			ingestReplicatedEntry: () => {},
			setAssistantResponseAnchorTerminal: async (message: AssistantMessage, isTerminal: boolean) => {
				mirroredMessage = message;
				mirroredTerminal = isTerminal;
				mirrored.resolve();
				return true;
			},
		},
		session: {
			messages: localMessages,
			switchSession: async () => {},
			newSession: async () => true,
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
				replaceMessages: (messages: AgentMessage[]) => {
					localMessages.splice(0, localMessages.length, ...messages);
					ingested.resolve();
				},
			},
		},
		statusContainer: { clear: () => {}, disposeChildren: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: async () => {},
		reloadTodos: async () => {},
		showStatus: () => {},
		showError: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: { handleEvent: async () => {} },
		syncRunningSubagentBadge: () => {},
	} as unknown as InteractiveModeContext;
	const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
	const guest = new CollabGuestLink(ctx);
	const transport = new TestTransport();

	try {
		await guest.joinWithTransport(transport, { roomId: "anchor-test" });
		const replicatedEntry = shrinkForReplication({
			type: "message" as const,
			id: "exact-entry",
			parentId: null,
			timestamp: "2026-08-30T00:00:01Z",
			message: {
				...assistant(exactResponseAnchorId),
				metadata: Object.fromEntries(
					Array.from({ length: 6_000 }, (_, index) => [`field-${index}`, "x".repeat(300)]),
				),
			},
		});
		expect(Buffer.byteLength(JSON.stringify(replicatedEntry))).toBeLessThanOrEqual(MAX_REPLICATED_PAYLOAD_BYTES);
		expect(replicatedEntry.message.responseAnchorId).toBe(exactResponseAnchorId);
		transport.emit({ t: "entry", entry: replicatedEntry });
		await ingested.promise;
		const exactLocal = localMessages.find(
			(message): message is AssistantMessage =>
				message.role === "assistant" && message.responseAnchorId === exactResponseAnchorId,
		);
		expect(exactLocal).toBeDefined();
		if (!exactLocal) throw new Error("replicated anchor message was not ingested");

		const clipped = shrinkForReplication({
			type: "agent_end" as const,
			messages: Array.from({ length: 256 }, (_, index) => ({
				...assistant(`clipped-${index}`),
				content: [{ type: "text" as const, text: "x".repeat(8 * 1024) }],
				model: "remote",
				timestamp: index,
			})),
			isTerminal: true,
			responseAnchorId: exactResponseAnchorId,
			responseAnchorTerminal: true,
		});

		expect(Buffer.byteLength(JSON.stringify(clipped))).toBeLessThanOrEqual(MAX_REPLICATED_PAYLOAD_BYTES);
		expect(clipped.responseAnchorId).toBe(exactResponseAnchorId);
		expect(clipped.responseAnchorTerminal).toBe(true);
		transport.emit({ t: "event", event: clipped });
		await mirrored.promise;

		expect(mirroredMessage).toBe(exactLocal);
		expect(mirroredTerminal).toBe(true);
	} finally {
		await guest.leave("test cleanup");
		writeSpy.mockRestore();
	}
});
