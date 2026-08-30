import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, type LiveTranscript } from "@oh-my-pi/pi-coding-agent/live/controller";
import { LiveVisualizer } from "@oh-my-pi/pi-coding-agent/live/visualizer";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

/** Fake InteractiveModeContext plus typed capture channels for focus/mount traffic. */
interface ContextHarness {
	ctx: InteractiveModeContext;
	/** The editor stub the controller must restore after live mode ends. */
	editor: unknown;
	/** Every component handed to `ui.setFocus`, in order. */
	focused: unknown[];
	/** Every component handed to `editorContainer.addChild`, in order. */
	mounted: unknown[];
	/** Resolves when `ui.setFocus` sees the original editor again. */
	editorRefocused: Promise<void>;
	/** Assistant transcript components passed to the chat presenter. */
	presented: unknown[];
	/** Current simulated chat-container children, mutable to model a rebuild detaching a live block. */
	chatChildren: unknown[];
}

function createContext(): ContextHarness {
	const editor = {
		getUseTerminalCursor: vi.fn(() => true),
		setUseTerminalCursor: vi.fn(),
	};
	const focused: unknown[] = [];
	const mounted: unknown[] = [];
	const presented: unknown[] = [];
	const chatChildren: unknown[] = [];
	const refocused = Promise.withResolvers<void>();
	const ctx = {
		effectiveHideThinkingBlock: false,
		viewSession: {},
		proseOnlyThinking: true,
		hideToolActivity: false,
		toolOutputExpanded: false,
		settings: Settings.isolated({ "live.voice": "vale" }),
		keybindings: { getKeys: vi.fn(() => ["ctrl+l"]) },
		session: {},
		extractAssistantText: vi.fn(() => ""),
		editor,
		editorContainer: {
			clear: vi.fn(),
			addChild: vi.fn((component: unknown) => {
				mounted.push(component);
			}),
		},
		ui: {
			getShowHardwareCursor: vi.fn(() => true),
			setShowHardwareCursor: vi.fn(),
			setFocus: vi.fn((component: unknown) => {
				focused.push(component);
				if (component === editor) refocused.resolve();
			}),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
		},
		showError: vi.fn(),
		chatContainer: { children: chatChildren },
		present: vi.fn((component: unknown) => {
			presented.push(component);
			chatChildren.push(component);
		}),
	} as unknown as InteractiveModeContext;
	return { ctx, editor, focused, mounted, presented, chatChildren, editorRefocused: refocused.promise };
}

afterEach(() => {
	vi.restoreAllMocks();
});

beforeAll(async () => {
	await initTheme(false);
});

describe("LiveCommandController", () => {
	it("forwards the selected voice across the live-session boundary", async () => {
		const { ctx } = createContext();
		let receivedVoice: string | undefined;
		const controller = new LiveCommandController(ctx, options => {
			receivedVoice = options.voice;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			expect(receivedVoice).toBe("vale");
		} finally {
			await controller.stop();
		}
	});

	it("stops the session and restores the editor when the live-toggle chord hits the focused visualizer", async () => {
		const { ctx, editor, focused, mounted, editorRefocused } = createContext();
		const stop = vi.fn(async () => {});
		const controller = new LiveCommandController(ctx, options => {
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockImplementation(stop);
			return session;
		});

		await controller.handleCommand();
		expect(controller.active).toBe(true);

		// The controller replaces and focuses the editor with the visualizer;
		// Ctrl+L must end the call from there, not just from the editor.
		const visualizer = focused[0];
		if (!(visualizer instanceof LiveVisualizer)) {
			throw new Error("expected the controller to focus a LiveVisualizer");
		}
		visualizer.handleInput("\x0c"); // Ctrl+L — the keypress alone must drive teardown
		await editorRefocused;

		expect(stop).toHaveBeenCalled();
		expect(mounted.at(-1)).toBe(editor);
		expect(focused.at(-1)).toBe(editor);
		// `active` stays true until #finish's fire-and-forget settling promise
		// clears; drain microtasks deterministically instead of sleeping.
		for (let i = 0; controller.active && i < 20; i++) await Promise.resolve();
		expect(controller.active).toBe(false);
	});

	it("anchors an explicitly finalized live assistant transcript", async () => {
		const { ctx, presented } = createContext();
		let onTranscript: ((transcript: LiveTranscript | undefined) => void) | undefined;
		const controller = new LiveCommandController(ctx, options => {
			onTranscript = options.callbacks.onTranscript;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			if (!onTranscript) throw new Error("Expected live transcript callback");
			onTranscript({ role: "assistant", turn: 1, text: "final live reply", final: true });
			const component = presented[0] as { render(width: number): readonly string[] };
			const raw = component.render(80).join("\n");
			expect(raw).toContain("\x1b]133;A;aid=omp-response-");
			expect(raw).toContain("\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07");
		} finally {
			await controller.stop();
		}
	});

	it("anchors a live assistant transcript when its turn rolls over", async () => {
		const { ctx, presented, chatChildren } = createContext();
		let onTranscript: ((transcript: LiveTranscript | undefined) => void) | undefined;
		const controller = new LiveCommandController(ctx, options => {
			onTranscript = options.callbacks.onTranscript;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			if (!onTranscript) throw new Error("Expected live transcript callback");
			onTranscript({ role: "assistant", turn: 1, text: "first live reply", final: false });
			const firstComponent = presented[0];
			chatChildren.splice(chatChildren.indexOf(firstComponent), 1);
			onTranscript({ role: "assistant", turn: 2, text: "second live reply", final: false });
			expect(chatChildren).toContain(firstComponent);
			expect(presented.filter(component => component === firstComponent)).toHaveLength(2);
			const component = presented[0] as { render(width: number): readonly string[] };
			const raw = component.render(80).join("\n");
			expect(raw).toContain("\x1b]133;A;aid=omp-response-");
			expect(raw).toContain("\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07");
		} finally {
			await controller.stop();
		}
	});

	it("re-presents a detached live assistant transcript before stop fallback finalizes it", async () => {
		const { ctx, presented, chatChildren } = createContext();
		let onTranscript: ((transcript: LiveTranscript | undefined) => void) | undefined;
		const controller = new LiveCommandController(ctx, options => {
			onTranscript = options.callbacks.onTranscript;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		await controller.handleCommand();
		if (!onTranscript) throw new Error("Expected live transcript callback");
		onTranscript({ role: "assistant", turn: 1, text: "reply before stop", final: false });
		const component = presented[0] as { render(width: number): readonly string[] };
		chatChildren.splice(chatChildren.indexOf(component), 1);

		await controller.stop();

		expect(chatChildren).toContain(component);
		expect(presented.filter(presentedComponent => presentedComponent === component)).toHaveLength(2);
		const raw = component.render(80).join("\n");
		expect(raw).toContain("\x1b]133;A;aid=omp-response-");
		expect(raw).toContain("\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07");
	});
});
