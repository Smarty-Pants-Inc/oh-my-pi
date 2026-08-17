import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("InteractiveMode loop auto-submit", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let pendingInput: Promise<SubmittedUserInput> | undefined;

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-loop-auto-submit-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	beforeEach(() => {
		settings.set("loop.mode", "prompt");
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode.disableLoopMode("Loop mode disabled.");
		mode.cancelPendingSubmission();
		if (mode.onInputCallback) {
			mode.onInputCallback({ text: "", cancelled: true, started: false });
		}
		await pendingInput;
		pendingInput = undefined;
		mode.vibeModeEnabled = false;
		Reflect.deleteProperty(session, "isCompacting");
		Reflect.deleteProperty(session, "isStreaming");
		Reflect.deleteProperty(session, "hasPostPromptWork");
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode.stop();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("never manufactures direct user input for an autonomous loop wake", async () => {
		vi.useFakeTimers();
		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat this";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(10_000);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);
		expect(session.getAutomaticTurnOutcomes().at(-1)).toMatchObject({
			source: "loop_mode_autonomous_wake",
			status: "rejected",
			reason: "loop mode cannot manufacture direct user input",
		});
	});

	it("reports waiting, running, paused, resumed, and disabled loop states", async () => {
		const setLoopModeStatus = vi.spyOn(mode.statusLine, "setLoopModeStatus");

		await mode.handleLoopCommand("3");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "waiting",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.setLoopPrompt("repeat this");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "running",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.pauseLoop();
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "paused",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.setLoopPrompt("resume this");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "running",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.disableLoopMode();
		expect(setLoopModeStatus).toHaveBeenLastCalledWith(undefined);
	});
});
