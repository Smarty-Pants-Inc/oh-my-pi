import { afterEach, describe, expect, it, vi } from "bun:test";
import * as piNatives from "@oh-my-pi/pi-natives";
import { LiveSessionController } from "../src/live/controller";
import * as liveTransport from "../src/live/transport";
import type { AgentSession, AgentSessionEvent } from "../src/session/agent-session";

type TransportCallbacks = {
	onEvent: (event: unknown) => void;
	onOutputLevel: (level: number) => void;
};

type AudioCaptureFactory = (sampleRate: number, callback: unknown) => FakeAudioCapture;
type LiveTransportFactory = (options: { callbacks: TransportCallbacks }) => FakeLiveTransport;

class FakeAudioCapture {
	stop(): void {}
}

class FakeLiveTransport {
	static instances: FakeLiveTransport[] = [];
	readonly messages: unknown[] = [];
	readonly sent = Promise.withResolvers<void>();
	readonly callbacks: TransportCallbacks;

	constructor(options: { callbacks: TransportCallbacks }) {
		this.callbacks = options.callbacks;
		FakeLiveTransport.instances.push(this);
	}

	async connect(): Promise<void> {}

	async send(message: unknown): Promise<void> {
		this.messages.push(message);
		this.sent.resolve();
	}

	async close(): Promise<void> {}

	async setMuted(_muted: boolean): Promise<void> {}

	pushAudio(_samples: Float32Array): void {}
}

afterEach(() => {
	FakeLiveTransport.instances = [];
	vi.restoreAllMocks();
});

describe("LiveSessionController closure rejection", () => {
	it("appends an explicit failure result before clearing a rejected delegation", async () => {
		let sessionListener: ((event: AgentSessionEvent) => void) | undefined;
		const session = {
			modelRegistry: { authStorage: {} },
			sessionId: "live-session",
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				sessionListener = listener;
				return () => {
					sessionListener = undefined;
				};
			},
			sendCustomMessage: async () => ({ status: "accepted", delivery: "started_turn" }),
		} as unknown as AgentSession;
		const phases: string[] = [];
		const audioCaptureModule = piNatives as unknown as { AudioCapture: AudioCaptureFactory };
		const liveTransportModule = liveTransport as unknown as { CodexLiveTransport: LiveTransportFactory };
		vi.spyOn(audioCaptureModule, "AudioCapture").mockImplementation(
			(_sampleRate, _callback) => new FakeAudioCapture(),
		);
		vi.spyOn(liveTransportModule, "CodexLiveTransport").mockImplementation(options => new FakeLiveTransport(options));
		const controller = new LiveSessionController({
			session,
			callbacks: {
				onPhase: phase => phases.push(phase),
				onLevels: () => {},
				onTranscript: () => {},
				onTerminal: () => {},
			},
			extractAssistantText: message =>
				message.content
					.filter((content): content is { type: "text"; text: string } => content.type === "text")
					.map(content => content.text)
					.join(""),
		});

		await controller.start();
		const transport = FakeLiveTransport.instances[0];
		if (!transport) throw new Error("live transport was not created");
		transport.callbacks.onEvent({
			type: "delegation.created",
			item: { id: "delegation-1", content: [{ type: "input_text", text: "Complete the work" }] },
		});
		if (!sessionListener) throw new Error("session listener was not registered");

		sessionListener({
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "This must not be sent as complete." }],
				} as never,
			],
			closureRejected: {
				reason: "stale_todos",
				todos: [{ content: "Finish live task", status: "pending" }],
			},
		});

		await transport.sent.promise;
		expect(transport.messages).toEqual([
			expect.objectContaining({
				type: "delegation.context.append",
				delegation_item_id: "delegation-1",
				content: [
					expect.objectContaining({
						type: "input_text",
						text: expect.stringContaining(
							"The delegated task did not complete because 1 actionable todo item(s) remain.",
						),
					}),
				],
			}),
		]);
		expect(JSON.stringify(transport.messages)).not.toContain("This must not be sent as complete.");
		expect(phases.at(-1)).toBe("listening");
		await controller.stop();
	});
});
