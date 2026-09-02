import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as crypto from "node:crypto";
import { Container, type OverlayOptions, Spacer, setKeybindings } from "@oh-my-pi/pi-tui";
import { isRecord } from "@oh-my-pi/pi-utils";
import { KeybindingsManager } from "../../../src/config/keybindings";
import type {
	ExtensionAPI,
	ExtensionAskDialogQuestion,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionEvent,
	ExtensionUIContext,
} from "../../../src/extensibility/extensions";
import { AskDialogComponent } from "../../../src/modes/components/ask-dialog";
import { CustomEditor } from "../../../src/modes/components/custom-editor";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import { createFreshOmpCompanionController } from "../../../src/modes/fresh-omp-companion";
import { getEditorTheme, getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
});

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme");
	setThemeInstance(dark);
});

function makeHarness() {
	const editor = new CustomEditor(getEditorTheme());
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const requestRender = vi.fn();
	const setFocus = vi.fn();
	const addAutocompleteProvider = vi.fn();
	const fakeHandle = {
		hide: vi.fn(),
		setHidden: vi.fn(),
		isHidden: vi.fn(() => false),
	};
	const showOverlay = vi.fn(() => fakeHandle);
	let uiContext: ExtensionUIContext | undefined;
	const ctx = {
		editor,
		ui: {
			requestRender,
			setFocus,
			showOverlay,
			terminal: { rows: 40 },
		},
		editorContainer,
		session: {
			extensionRunner: undefined,
			setUsageFallbackConfirmer: vi.fn(),
		},
		setToolUIContext(context: ExtensionUIContext, hasUI: boolean): void {
			expect(hasUI).toBe(true);
			uiContext = context;
		},
		addAutocompleteProvider,
		syncComposerShape: vi.fn(),
	} as unknown as InteractiveModeContext;

	const controller = new ExtensionUiController(ctx);

	return {
		editor,
		requestRender,
		addAutocompleteProvider,
		editorContainer,
		setFocus,
		showOverlay,
		fakeHandle,
		controller,
		async init(): Promise<ExtensionUIContext> {
			await controller.initHooksAndCustomTools();
			expect(uiContext).toBeDefined();
			return uiContext!;
		},
	};
}

describe("ExtensionUiController editor UI", () => {
	it("requests a render after extension pasteToEditor mutates the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.pasteToEditor("hello");
		ui.pasteToEditor(" world");

		expect(harness.editor.getText()).toBe("hello world");
		expect(harness.requestRender).toHaveBeenCalledTimes(2);
	});

	it("requests a render after extension setEditorText replaces the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.setEditorText("hello");

		expect(harness.editor.getText()).toBe("hello");
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
	});

	it("keeps a populated prompt visible and routes input to it until the draft is cleared", async () => {
		const harness = makeHarness();
		harness.editor.setText("finish this wor");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		const pending = harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);

		ask?.handleInput?.("d");
		expect(harness.editor.getText()).toBe("finish this word");

		harness.editor.setText("");
		ask?.handleInput?.("\n");
		expect(await pending).toEqual({
			kind: "submit",
			results: [
				{
					id: "confirm",
					question: "Continue?",
					options: ["Yes", "No"],
					multi: false,
					selectedOptions: ["Yes"],
					customInput: undefined,
					note: undefined,
					timedOut: undefined,
				},
			],
		});
		expect(harness.editorContainer.children).toEqual([harness.editor]);
	});

	it("does not fire editor-slot shortcuts that would orphan the ask dialog (#6738)", () => {
		const harness = makeHarness();
		harness.editor.setText("draft in progress");
		// Simulate an editor-slot shortcut like the Agent Hub binding, whose
		// handler clears editorContainer and would strand the pending ask.
		let hubOpened = false;
		harness.editor.setCustomKeyHandler("ctrl+s", () => {
			hubOpened = true;
			harness.editorContainer.clear();
		});
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// Ctrl+S reaches the draft editor while ask is open; the shortcut must be
		// swallowed, the draft untouched, and the ask surface preserved.
		ask?.handleInput?.("\x13");
		expect(hubOpened).toBe(false);
		expect(harness.editor.getText()).toBe("draft in progress");
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);
	});

	it("exposes the draft editor cursor while it proxies input, and drops it once cleared (#6738)", () => {
		const harness = makeHarness();
		harness.editor.setText("finish this wor");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// The ask dialog holds TUI focus, but rendering it must mirror focus onto
		// the draft editor so its insertion cursor is visible.
		ask?.render?.(80);
		expect(harness.editor.focused).toBe(true);

		// Once the draft clears, the ask controls take over and the editor cursor
		// must not linger.
		harness.editor.setText("");
		ask?.render?.(80);
		expect(harness.editor.focused).toBe(false);
	});

	it("lets the clear action empty the draft and lift the ask guard (#6738)", () => {
		const harness = makeHarness();
		// Route Ctrl+C to the guard: keep app.clear on Ctrl+C but move the ask
		// cancel key off it, so Ctrl+C reaches draft editing instead of cancelling.
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
		harness.editor.setActionKeys("app.clear", ["ctrl+c"]);
		let cleared = 0;
		// Mirror interactive wiring: app.clear (Ctrl+C) clears the draft.
		harness.editor.onClear = () => {
			cleared++;
			harness.editor.setText("");
		};
		harness.editor.setText("half typed prompt");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);

		// Ctrl+C is reserved by the base editor and never clears; the guard must
		// dispatch the configured clear action so the "finish or clear" hint works.
		ask?.handleInput?.("\x03");
		expect(cleared).toBe(1);
		expect(harness.editor.getText()).toBe("");

		// With the draft gone the guard releases: the next key reaches the ask
		// controls and submits the highlighted option.
		ask?.handleInput?.("\n");
		expect(harness.editorContainer.children).toEqual([harness.editor]);
	});

	it("remounts the draft editor when the ask surface is restored after a nested prompt (#6738)", async () => {
		const harness = makeHarness();
		harness.editor.setText("half typed prompt");
		const questions: ExtensionAskDialogQuestion[] = [
			{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
		];

		harness.controller.showAskDialog(questions);
		const ask = harness.editorContainer.children[0];
		expect(ask).toBeInstanceOf(AskDialogComponent);
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);

		// Draft submitted: the guard lifts and ask controls take input; open the
		// note prompt, which swaps the container to the nested editor.
		harness.editor.setText("");
		ask?.handleInput?.("n");
		const promptEditor = harness.editorContainer.children[0];
		expect(promptEditor).not.toBe(ask);

		// A failed async submission restores the draft while the nested prompt is
		// open, re-blocking the guard.
		harness.editor.setText("half typed prompt");

		// Cancelling the nested prompt restores the ask surface; the draft editor
		// must be remounted so routed input lands on a visible surface.
		promptEditor?.handleInput?.("\x1b");
		expect(harness.editorContainer.children).toEqual([ask, harness.editor]);
		// The dialog's prompt-active latch clears when the awaited onPrompt
		// promise settles; yield a microtask before routing the next key.
		await Promise.resolve();
		ask?.handleInput?.("!");
		expect(harness.editor.getText()).toBe("half typed prompt!");
	});

	it("bridges addAutocompleteProvider factories to the interactive mode context (#4919)", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		expect(typeof ui.addAutocompleteProvider).toBe("function");

		const factory = (current: unknown) => current as never;
		ui.addAutocompleteProvider(factory);

		expect(harness.addAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(harness.addAutocompleteProvider).toHaveBeenCalledWith(factory);
	});
});

type InputResult = { consume?: boolean; data?: string } | undefined;
type InputListener = (data: string) => InputResult;
type RegisteredHandler = (event: ExtensionEvent, context: ExtensionContext) => void | Promise<void>;

const COMPANION_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index);
const OSC_PREFIX = "\x1b]777;notify;fresh://omp-companion;v1;";
const OSC_TERMINATOR = "\x1b\\";
const COMMAND_PREFIX = "\u{10ffff}fresh-omp-command:v1:";
const COMMAND_END = "\u{10fffe}";
let nextCommandSequence = 0;

function latestCommandTarget(): {
	incarnation: string;
	sequence: number;
	sessionGeneration: number;
	sessionId: string;
	workEpoch: number;
} {
	// The test harness installs a Bun mock before commands inspect captured writes.
	const mockedWrite = process.stdout.write as typeof process.stdout.write & { mock?: { calls: unknown[][] } };
	const calls = mockedWrite.mock?.calls ?? [];
	for (let index = calls.length - 1; index >= 0; index--) {
		const frame = calls[index]?.[0];
		if (typeof frame !== "string" || !frame.startsWith(OSC_PREFIX) || !frame.endsWith(OSC_TERMINATOR)) continue;
		const content = frame.slice(OSC_PREFIX.length, -OSC_TERMINATOR.length);
		const authenticated = content.slice(content.indexOf(";") + 1);
		const bodyText = authenticated.slice(0, authenticated.lastIndexOf("."));
		try {
			const envelope: unknown = JSON.parse(Buffer.from(bodyText, "base64url").toString("utf8"));
			if (!isRecord(envelope) || !isRecord(envelope.snapshot)) continue;
			const snapshot = envelope.snapshot;
			if (
				typeof snapshot.incarnation === "string" &&
				typeof snapshot.sequence === "number" &&
				typeof snapshot.sessionGeneration === "number" &&
				typeof snapshot.sessionId === "string" &&
				typeof snapshot.workEpoch === "number"
			) {
				return {
					incarnation: snapshot.incarnation,
					sequence: snapshot.sequence,
					sessionGeneration: snapshot.sessionGeneration,
					sessionId: snapshot.sessionId,
					workEpoch: snapshot.workEpoch,
				};
			}
		} catch {
			// Ignore non-companion writes and malformed test fixtures.
		}
	}
	throw new Error("Missing companion snapshot for command target");
}

function authenticatedCommandFrame(value: Record<string, unknown>): string {
	const body = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
	const tag = crypto
		.createHmac("sha256", COMPANION_SECRET)
		.update("fresh-omp/in/v1\0", "utf8")
		.update(body, "ascii")
		.digest("base64url");
	return `${COMMAND_PREFIX}${body}.${tag}${COMMAND_END}`;
}

function authenticatedCancelFrame(): string {
	const snapshot = latestCommandTarget();
	return authenticatedCommandFrame({
		version: 1,
		type: "cancel",
		incarnation: snapshot.incarnation,
		sessionGeneration: snapshot.sessionGeneration,
		sessionId: snapshot.sessionId,
		workEpoch: snapshot.workEpoch,
		commandSequence: ++nextCommandSequence,
	});
}

function authenticatedSnapshotAckFrame(): string {
	const snapshot = latestCommandTarget();
	return authenticatedCommandFrame({
		version: 1,
		type: "snapshot_ack",
		...snapshot,
		accepted: true,
		commandSequence: ++nextCommandSequence,
	});
}

function makeNewSessionInputHarness() {
	const listeners = new Set<InputListener>();
	const ordinaryListenerInput: string[] = [];
	const ordinaryTuiInput: string[] = [];
	const abort = vi.fn();
	const handlers = new Map<ExtensionEvent["type"], RegisteredHandler>();
	let commandActions: ExtensionCommandContextActions | undefined;
	let uiContext: ExtensionUIContext | undefined;
	let newSession = async (): Promise<boolean> => true;
	const sessionManager = {
		getSessionId: () => "018f1d74-7f7b-7d31-8d93-9a21c7b95bb1",
		getSessionName: () => "Companion test",
		getCwd: () => "/tmp/companion-test",
		getBranch: () => [],
		ensureOnDisk: async () => {},
	};
	const hookWidgetContainerAbove = new Container();
	hookWidgetContainerAbove.addChild(new Spacer(1));
	const hookWidgetContainerBelow = new Container();
	const addInputListener = (listener: InputListener): (() => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	const dispatchInput = (data: string): void => {
		let current = data;
		for (const listener of listeners) {
			const result = listener(current);
			if (result?.consume) return;
			if (result?.data !== undefined) current = result.data;
		}
		if (current) ordinaryTuiInput.push(current);
	};
	const companion = createFreshOmpCompanionController(COMPANION_SECRET);
	companion.factory({
		on: (type: ExtensionEvent["type"], handler: RegisteredHandler) => handlers.set(type, handler),
		registerTool: vi.fn(),
		getThinkingLevel: () => "high",
		logger: { warn: vi.fn() },
	} as unknown as ExtensionAPI);
	const setHostTerminalInput = companion.setHostTerminalInput;

	const extensionRunner = {
		initialize: vi.fn(
			(
				_actions: unknown,
				_contextActions: unknown,
				capturedCommandActions: ExtensionCommandContextActions,
				capturedUiContext: ExtensionUIContext,
			) => {
				commandActions = capturedCommandActions;
				uiContext = capturedUiContext;
			},
		),
		onError: vi.fn(),
		emit: vi.fn(async () => undefined),
		setHostTerminalInput: vi.fn((register: (handler: InputListener) => () => void) => {
			setHostTerminalInput?.(register);
		}),
		getComposerShapes: () => [],
	};
	const ctx = {
		editor: new CustomEditor(getEditorTheme()),
		ui: {
			requestRender: vi.fn(),
			setFocus: vi.fn(),
			terminal: { rows: 40 },
			addInputListener,
		},
		editorContainer: new Container(),
		hookWidgetContainerAbove,
		hookWidgetContainerBelow,
		sessionManager,
		session: {
			extensionRunner,
			setUsageFallbackConfirmer: vi.fn(),
			newSession: () => newSession(),
			isStreaming: false,
			isCompacting: false,
			abort,
			getContextUsage: () => undefined,
			agent: { waitForIdle: async () => {} },
		},
		setToolUIContext: vi.fn(),
		addAutocompleteProvider: vi.fn(),
		syncComposerShape: vi.fn(),
		clearTransientSessionUi: vi.fn(),
		statusLine: { invalidate: vi.fn(), resetActiveTime: vi.fn() },
		resetTranscript: vi.fn(),
		present: vi.fn(),
		reloadTodos: async () => {},
		setWorkingMessage: vi.fn(),
		setEditorComponent: vi.fn(),
		toolOutputExpanded: false,
		setToolsExpanded: vi.fn(),
	} as unknown as InteractiveModeContext;
	ctx.editorContainer.addChild(ctx.editor);
	const controller = new ExtensionUiController(ctx);
	const companionContext = {
		get ui() {
			if (!uiContext) throw new Error("Extension UI context was not initialized");
			return uiContext;
		},
		getContextUsage: () => undefined,
		getAsyncJobSnapshot: () => null,
		getAsyncJobCounts: () => null,
		isCompacting: () => false,
		cwd: "/tmp/companion-test",
		sessionManager,
		model: { provider: "test", id: "test" },
		isIdle: () => true,
		abort,
		setTimeout: globalThis.setTimeout,
		setInterval: globalThis.setInterval,
		clearTimer: (timer: Parameters<ExtensionContext["clearTimer"]>[0]) => {
			clearTimeout(timer);
			clearInterval(timer);
		},
	} as unknown as ExtensionContext;
	const emitCompanion = async (type: ExtensionEvent["type"]): Promise<void> => {
		const handler = handlers.get(type);
		if (!handler) throw new Error(`Missing companion handler for ${type}`);
		await handler({ type } as ExtensionEvent, companionContext);
	};
	const fenceCompanion = async (): Promise<void> => {
		await companion.beforeSessionMutation({ type: "session_switch" }, companionContext);
	};
	const completeCompanion = async (type: "session_ready" | "session_rollback"): Promise<void> => {
		const completion = Promise.resolve(companion.afterDispatch({ type } as ExtensionEvent, companionContext));
		const hostInput = listeners.values().next().value;
		if (!hostInput) throw new Error("Missing host-private companion input listener");
		hostInput(authenticatedSnapshotAckFrame());
		await completion;
	};
	return {
		abort,
		controller,
		addPublicListener(): void {
			controller.addExtensionTerminalInputListener(data => {
				ordinaryListenerInput.push(data);
				return undefined;
			});
		},
		get commandActions(): ExtensionCommandContextActions {
			if (!commandActions) throw new Error("Command actions were not initialized");
			return commandActions;
		},
		dispatchInput,
		emitCompanion,
		fenceCompanion,
		completeCompanion,
		get listenerCount(): number {
			return listeners.size;
		},
		get ordinaryListenerInput(): readonly string[] {
			return ordinaryListenerInput;
		},
		get publicUiSymbolCount(): number {
			return uiContext ? Object.getOwnPropertySymbols(uiContext).length : 0;
		},
		get ordinaryTuiInput(): readonly string[] {
			return ordinaryTuiInput;
		},
		setNewSession(handler: () => Promise<boolean>): void {
			newSession = handler;
		},
	};
}

describe("ExtensionUiController host-private companion input", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		nextCommandSequence = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("keeps the host filter first and live once through public clearing, session replacement, and shutdown", async () => {
		const harness = makeNewSessionInputHarness();
		await harness.controller.initHooksAndCustomTools();
		expect(harness.publicUiSymbolCount).toBe(0);
		await harness.emitCompanion("session_start");
		vi.advanceTimersByTime(1_000);
		vi.advanceTimersByTime(0);
		expect(harness.listenerCount).toBe(1);
		harness.addPublicListener();
		expect(harness.listenerCount).toBe(2);
		const frame = authenticatedCancelFrame();
		harness.dispatchInput(frame);
		vi.advanceTimersByTime(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);
		expect(harness.ordinaryListenerInput).toEqual([""]);
		expect(harness.ordinaryTuiInput).toEqual([]);

		harness.setNewSession(async () => {
			harness.dispatchInput(authenticatedCancelFrame());
			expect(harness.ordinaryTuiInput).toEqual([]);
			vi.advanceTimersByTime(0);
			expect(harness.abort).toHaveBeenCalledTimes(2);
			expect(harness.listenerCount).toBe(1);
			await harness.fenceCompanion();
			harness.dispatchInput(authenticatedCancelFrame());
			vi.advanceTimersByTime(0);
			expect(harness.abort).toHaveBeenCalledTimes(2);
			await harness.emitCompanion("session_ready");
			await harness.completeCompanion("session_ready");
			return true;
		});

		expect(await harness.commandActions.newSession()).toEqual({ cancelled: false });
		expect(harness.listenerCount).toBe(1);
		harness.dispatchInput(authenticatedCancelFrame());
		vi.advanceTimersByTime(0);
		expect(harness.abort).toHaveBeenCalledTimes(3);
		expect(harness.ordinaryListenerInput).toEqual([""]);
		expect(harness.ordinaryTuiInput).toEqual([]);
		await harness.emitCompanion("session_shutdown");
		expect(harness.listenerCount).toBe(0);
	});

	it("survives public cleanup when new-session cancellation happens before the switch fence", async () => {
		const harness = makeNewSessionInputHarness();
		await harness.controller.initHooksAndCustomTools();
		await harness.emitCompanion("session_start");
		vi.advanceTimersByTime(1_000);
		vi.advanceTimersByTime(0);
		const frame = authenticatedCancelFrame();
		harness.setNewSession(async () => {
			harness.dispatchInput(frame);
			expect(harness.ordinaryTuiInput).toEqual([]);
			vi.advanceTimersByTime(0);
			expect(harness.abort).toHaveBeenCalledTimes(1);
			return false;
		});

		expect(await harness.commandActions.newSession()).toEqual({ cancelled: true });
		harness.dispatchInput(authenticatedCancelFrame());
		vi.advanceTimersByTime(0);
		expect(harness.abort).toHaveBeenCalledTimes(2);
		expect(harness.ordinaryListenerInput).toEqual([]);
		expect(harness.ordinaryTuiInput).toEqual([]);
	});

	it("restores the private filter and command handling after a thrown rollback", async () => {
		const harness = makeNewSessionInputHarness();
		await harness.controller.initHooksAndCustomTools();
		await harness.emitCompanion("session_start");
		vi.advanceTimersByTime(1_000);
		vi.advanceTimersByTime(0);
		const frame = authenticatedCancelFrame();
		harness.setNewSession(async () => {
			await harness.fenceCompanion();
			harness.dispatchInput(frame);
			expect(harness.ordinaryTuiInput).toEqual([]);
			await harness.emitCompanion("session_rollback");
			await harness.completeCompanion("session_rollback");
			throw new Error("replacement failed");
		});

		await expect(harness.commandActions.newSession()).rejects.toThrow("replacement failed");
		harness.dispatchInput(authenticatedCancelFrame());
		vi.advanceTimersByTime(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);
		expect(harness.ordinaryListenerInput).toEqual([]);
		expect(harness.ordinaryTuiInput).toEqual([]);
		expect(harness.listenerCount).toBe(1);
	});
});

describe("ExtensionUiController custom overlay", () => {
	// showHookCustom mounts the overlay in the `.then` of a Promise.try chain;
	// draining the microtask queue a few times settles it without real timers.
	const flushMicrotasks = async () => {
		for (let i = 0; i < 3; i++) await Promise.resolve();
	};

	it("forwards overlayOptions to showOverlay and invokes onHandle", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const onHandle = vi.fn();
		const overlayOptions: OverlayOptions = {
			anchor: "bottom-center",
			width: "85%",
			maxHeight: "55%",
			margin: { bottom: 1, left: 2, right: 2 },
		};

		ui.custom<void>(() => new Container(), { overlay: true, overlayOptions, onHandle });

		await flushMicrotasks();
		expect(harness.showOverlay).toHaveBeenCalledTimes(1);
		expect(harness.showOverlay).toHaveBeenCalledWith(expect.any(Container), overlayOptions);
		expect(onHandle).toHaveBeenCalledTimes(1);
		expect(onHandle).toHaveBeenCalledWith(harness.fakeHandle);
	});

	it("resolves overlayOptions factories before showing the overlay", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const overlayOptions: OverlayOptions = { anchor: "top-right", width: 40 };
		const resolveOverlayOptions = vi.fn(() => overlayOptions);

		ui.custom<void>(() => new Container(), {
			overlay: true,
			overlayOptions: resolveOverlayOptions,
		});

		await flushMicrotasks();
		expect(resolveOverlayOptions).toHaveBeenCalledTimes(1);
		expect(harness.showOverlay).toHaveBeenCalledWith(expect.any(Container), overlayOptions);
	});

	it("falls back to the full-cover defaults when overlayOptions is absent", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.custom<void>(() => new Container(), { overlay: true });

		await flushMicrotasks();
		expect(harness.showOverlay).toHaveBeenCalledTimes(1);
		expect(harness.showOverlay).toHaveBeenCalledWith(expect.any(Container), {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
	});

	it("rejects and restores the editor when a custom factory fails", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const failure = new Error("custom factory failed");

		await expect(ui.custom(() => Promise.reject(failure))).rejects.toBe(failure);

		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.setFocus).toHaveBeenLastCalledWith(harness.editor);
	});

	it("aborts a pending custom factory and disposes its late component", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		harness.editor.setText("draft before factory");
		const controller = new AbortController();
		const factory = Promise.withResolvers<Container>();
		const component = new Container() as Container & { dispose: Mock<() => void> };
		component.dispose = vi.fn();

		const pending = ui.custom(() => factory.promise, { signal: controller.signal });
		harness.editor.setText("draft typed while factory is pending");
		controller.abort();

		await expect(pending).rejects.toBe(controller.signal.reason);
		factory.resolve(component);
		await flushMicrotasks();

		expect(component.dispose).toHaveBeenCalledTimes(1);
		expect(harness.editorContainer.children).toEqual([harness.editor]);
		expect(harness.editor.getText()).toBe("draft typed while factory is pending");
	});
});
