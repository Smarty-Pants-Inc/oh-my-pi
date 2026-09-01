import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import {
	ASYNC_INLINE_RESULT_MAX_CHARS,
	type AsyncResultEntry,
} from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BashRunner } from "@oh-my-pi/pi-coding-agent/session/bash-runner";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { type AdvisorStats, SessionAdvisors } from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import type { BuildSessionContextOptions, SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionLifecycleTransaction } from "@oh-my-pi/pi-coding-agent/session/session-lifecycle-transaction";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { OutputSink } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import type { XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { TempDir } from "@oh-my-pi/pi-utils";
import { assistantMsg } from "./utilities";

/**
 * Regression for issue #3846: in-TUI `/resume` rebuilt the *previous*
 * session's display context before switching files. That call expands persisted
 * snapcompact archives and `openaiRemoteCompaction.replacementHistory` payloads
 * into messages, which can OOM on huge pre-fix sessions even though the loader
 * itself streams. The previous context is only needed for same-session reloads
 * (where `#didSessionMessagesChange` compares against the freshly rebuilt one);
 * different-session switches MUST skip that work.
 */
describe("AgentSession.switchSession previous-context build", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(() => {
		authStorage.close();
	});

	afterEach(async () => {
		while (sessions.length > 0) {
			await sessions.pop()?.dispose();
		}
		for (const dir of tempDirs.splice(0)) {
			try {
				await dir.remove();
			} catch {}
		}
		vi.restoreAllMocks();
	});

	function buildSession(
		tempDir: TempDir,
		extensionRunner?: ExtensionRunner,
	): { session: AgentSession; sessionManager: SessionManager } {
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: options.tools ?? [],
			},
			convertToLlm,
			...(options.streamFn ? { streamFn: options.streamFn } : {}),
		});
		const extensionRunner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		sessions.push(session);
		return { session, sessionManager, extensionRunner };
	}

	function createPendingAdvisorWork(note: string) {
		const release = Promise.withResolvers<void>();
		const firstStarted = Promise.withResolvers<void>();
		const resumed = Promise.withResolvers<void>();
		const resumedCompleted = Promise.withResolvers<void>();
		let callCount = 0;
		const mock = createMockModel({
			handler: async (_context, options) => {
				callCount++;
				if (callCount === 1) {
					firstStarted.resolve();
					await raceWithSignal(new Promise<never>(() => {}), options?.signal);
					throw new Error("aborted advisor attempt unexpectedly resumed");
				}
				if (callCount === 2) {
					resumed.resolve();
					await raceWithSignal(release.promise, options?.signal);
					resumedCompleted.resolve();
					return {
						content: [{ type: "toolCall", name: "advise", arguments: { note, severity: "nit" } }],
					};
				}
				return { content: [] };
			},
		});
		return {
			mock,
			release,
			firstStarted: firstStarted.promise,
			resumed: resumed.promise,
			resumedCompleted: resumedCompleted.promise,
		};
	}

	interface StableAdvisorStats {
		configured: boolean;
		active: boolean;
		model: AdvisorStats["model"];
		cost: number;
		advisors: Array<{
			name: string;
			status: AdvisorStats["advisors"][number]["status"];
			model: AdvisorStats["advisors"][number]["model"];
			cost: number;
		}>;
	}

	function stableAdvisorStats(stats: AdvisorStats): StableAdvisorStats {
		return {
			configured: stats.configured,
			active: stats.active,
			model: stats.model,
			cost: stats.cost,
			advisors: stats.advisors.map(advisor => ({
				name: advisor.name,
				status: advisor.status,
				model: advisor.model,
				cost: advisor.cost,
			})),
		};
	}

	/** Wrap `sessionManager.buildSessionContext` so each call's caller-visible
	 *  state (the manager's currently-loaded session file) is recorded in
	 *  invocation order. The constructor itself calls `buildSessionContext`
	 *  once; spying *after* construction means only switchSession-driven calls
	 *  are observed. */
	function instrumentBuildSessionContext(sessionManager: SessionManager): {
		calls: Array<{ sessionFile: string | undefined; transcript: boolean | undefined }>;
		restore: () => void;
	} {
		const calls: Array<{ sessionFile: string | undefined; transcript: boolean | undefined }> = [];
		const original = sessionManager.buildSessionContext.bind(sessionManager);
		const patched = (options?: BuildSessionContextOptions): SessionContext => {
			calls.push({ sessionFile: sessionManager.getSessionFile(), transcript: options?.transcript });
			return original(options);
		};
		sessionManager.buildSessionContext = patched as SessionManager["buildSessionContext"];
		return {
			calls,
			restore: () => {
				sessionManager.buildSessionContext = original;
			},
		};
	}

	async function installDurableMutationBeforePostQuiescenceCapture(
		session: AgentSession,
		sessionManager: SessionManager,
		mutationText: string,
		failureAfterMutation?: Error,
	): Promise<{
		retainedSessionFile: string;
		retainedRaw: string;
		retainedEntries: SessionEntry[];
		retainedMessages: AgentMessage[];
		flushCalls(): number;
		durableMutationRaw(): string | undefined;
		captureCalls(): number;
		postQuiescenceRaw(): string | undefined;
		postQuiescenceEntries(): SessionEntry[] | undefined;
		postQuiescenceMessages(): AgentMessage[] | undefined;
	}> {
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const retainedSessionFile = sessionManager.getSessionFile();
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedRaw = await fs.readFile(retainedSessionFile, "utf8");
		const retainedEntries = structuredClone(sessionManager.getEntries());
		const retainedMessages = structuredClone(session.messages);

		let flushCalls = 0;
		let durableMutationRaw: string | undefined;
		const flush = sessionManager.flush.bind(sessionManager);
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			const call = ++flushCalls;
			if (call === 2) {
				sessionManager.appendMessage({ role: "user", content: mutationText, timestamp: 99 });
				session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			}
			await flush();
			if (call === 2) durableMutationRaw = await fs.readFile(retainedSessionFile, "utf8");
			if (call === 2 && failureAfterMutation) throw failureAfterMutation;
		});

		let captureCalls = 0;
		let postQuiescenceRaw: string | undefined;
		let postQuiescenceEntries: SessionEntry[] | undefined;
		let postQuiescenceMessages: AgentMessage[] | undefined;
		const capturePersistedSessionFile = sessionManager.capturePersistedSessionFile.bind(sessionManager);
		vi.spyOn(sessionManager, "capturePersistedSessionFile").mockImplementation(async () => {
			const snapshot = await capturePersistedSessionFile();
			captureCalls++;
			if (captureCalls === 2) {
				postQuiescenceRaw = snapshot?.content;
				postQuiescenceEntries = structuredClone(sessionManager.getEntries());
				postQuiescenceMessages = structuredClone(session.messages);
			}
			return snapshot;
		});

		return {
			retainedSessionFile,
			retainedRaw,
			retainedEntries,
			retainedMessages,
			flushCalls: () => flushCalls,
			durableMutationRaw: () => durableMutationRaw,
			captureCalls: () => captureCalls,
			postQuiescenceRaw: () => postQuiescenceRaw,
			postQuiescenceEntries: () => postQuiescenceEntries,
			postQuiescenceMessages: () => postQuiescenceMessages,
		};
	}

	it("skips building the previous display context when switching to a different session", async () => {
		const tempDir = TempDir.createSync("@pi-switch-prev-ctx-different-");
		tempDirs.push(tempDir);

		const { session, sessionManager } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "previous", timestamp: 1 });
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();
		expect(previousSessionFile).toBeString();

		const otherManager = SessionManager.create(tempDir.path(), tempDir.path());
		otherManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await otherManager.flush();
		const targetSessionFile = otherManager.getSessionFile();
		expect(targetSessionFile).toBeString();
		expect(targetSessionFile).not.toBe(previousSessionFile);
		await otherManager.close();

		const { calls, restore } = instrumentBuildSessionContext(sessionManager);
		try {
			const switched = await session.switchSession(targetSessionFile!);
			expect(switched).toBe(true);
			expect(session.sessionFile).toBe(targetSessionFile);
		} finally {
			restore();
		}

		// The previous session's display context MUST NOT be materialized. Only
		// the new target context (post-`setSessionFile`) should be built.
		expect(calls).toEqual([{ sessionFile: targetSessionFile!, transcript: undefined }]);
	});

	it("builds the previous display context for same-session reloads", async () => {
		const tempDir = TempDir.createSync("@pi-switch-prev-ctx-reload-");
		tempDirs.push(tempDir);

		const { session, sessionManager } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "current", timestamp: 1 });
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeString();

		const { calls, restore } = instrumentBuildSessionContext(sessionManager);
		try {
			const switched = await session.switchSession(sessionFile!);
			expect(switched).toBe(true);
			expect(session.sessionFile).toBe(sessionFile);
		} finally {
			restore();
		}

		// Same-session reload must snapshot the pre-reload context so
		// `#didSessionMessagesChange` can detect rollback edits.
		expect(calls).toEqual([
			{ sessionFile: sessionFile!, transcript: undefined },
			{ sessionFile: sessionFile!, transcript: undefined },
		]);
	});

	it("restores the previous session when cwd adoption is rejected", async () => {
		const sourceDir = TempDir.createSync("@pi-switch-cwd-source-");
		const targetDir = TempDir.createSync("@pi-switch-cwd-target-");
		tempDirs.push(sourceDir, targetDir);

		const { session, sessionManager } = buildSession(sourceDir);
		sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();
		const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		await targetManager.close();
		expect(previousSessionFile).toBeString();
		expect(targetSessionFile).toBeString();

		const onCwdChange = vi.fn(async () => false);
		const switched = await session.switchSession(targetSessionFile!, { onCwdChange });

		expect(switched).toBe(false);
		expect(onCwdChange).toHaveBeenCalledWith(targetDir.path(), sourceDir.path());
		expect(sessionManager.getSessionFile()).toBe(previousSessionFile);
		expect(sessionManager.getCwd()).toBe(sourceDir.path());
	});
	it("rejects callback-free switches across project directories", async () => {
		const sourceDir = TempDir.createSync("@pi-switch-no-callback-source-");
		const targetDir = TempDir.createSync("@pi-switch-no-callback-target-");
		tempDirs.push(sourceDir, targetDir);

		const { session, sessionManager } = buildSession(sourceDir);
		sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();

		const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		await targetManager.close();

		const switched = await session.switchSession(targetSessionFile!);

		expect(switched).toBe(false);
		expect(sessionManager.getSessionFile()).toBe(previousSessionFile);
		expect(sessionManager.getCwd()).toBe(sourceDir.path());
	});
	it("adopts a foreign replica without changing the local cwd", async () => {
		const sourceDir = TempDir.createSync("@pi-switch-collab-source-");
		const targetDir = TempDir.createSync("@pi-switch-collab-target-");
		const extraDir = TempDir.createSync("@pi-switch-collab-extra-");
		tempDirs.push(sourceDir, targetDir, extraDir);

		const { session, sessionManager } = buildSession(sourceDir);
		sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
		await sessionManager.flush();
		const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
		targetManager.appendMessage({ role: "user", content: "host snapshot", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		await targetManager.close();
		expect(targetSessionFile).toBeString();

		const processCwd = process.cwd();
		const onCwdChange = vi.fn(async () => {
			throw new Error("collab must not invoke cwd callback");
		});
		const switched = await session.switchSession(targetSessionFile!, {
			preserveLocalCwd: true,
			onCwdChange,
		});

		expect(switched).toBe(true);
		expect(onCwdChange).not.toHaveBeenCalled();
		expect(process.cwd()).toBe(processCwd);
		expect(sessionManager.getSessionFile()).toBe(targetSessionFile);
		expect(sessionManager.getCwd()).toBe(sourceDir.path());
		expect(sessionManager.getRecordedCwd()).toBe(targetDir.path());
		await sessionManager.addWorkspaceDirectory(extraDir.path());
		expect(await Bun.file(targetSessionFile!).text()).not.toContain(extraDir.path());
	});

	it("fails closed when cwd rollback throws after changing it", async () => {
		const sourceDir = TempDir.createSync("@pi-switch-cwd-error-source-");
		const targetDir = TempDir.createSync("@pi-switch-cwd-error-target-");
		tempDirs.push(sourceDir, targetDir);

		const { session, sessionManager } = buildSession(sourceDir);
		const targetManager = SessionManager.create(targetDir.path(), targetDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		await targetManager.close();
		expect(targetSessionFile).toBeString();

		let actualCwd = sourceDir.path();
		let callbackCount = 0;
		const onCwdChange = vi.fn(async (newCwd: string, _previousCwd: string) => {
			actualCwd = newCwd;
			const call = callbackCount++;
			if (call === 0) throw new Error("settings reload failed");
			if (call === 1) throw new Error("cwd restore denied");
			return true;
		});

		await expect(session.switchSession(targetSessionFile!, { onCwdChange })).rejects.toThrow(
			/settings reload failed.*cwd restore denied.*process may remain in/,
		);

		expect(actualCwd).toBe(sourceDir.path());
		expect(onCwdChange).toHaveBeenCalledTimes(2);
		expect(onCwdChange).toHaveBeenNthCalledWith(2, sourceDir.path(), targetDir.path());
		expect(sessionManager.getCwd()).toBe(sourceDir.path());
		expect(session.isDisposed).toBe(true);
	});
	it("rejects reload when the session-before-switch hook cancels", async () => {
		const tempDir = TempDir.createSync("@pi-switch-reload-cancel-");
		tempDirs.push(tempDir);

		const emit = vi.fn(async () => ({ cancel: true }));
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_before_switch",
			emit,
		} as unknown as ExtensionRunner;
		const { session, sessionManager } = buildSession(tempDir, extensionRunner);
		sessionManager.appendMessage({ role: "user", content: "current", timestamp: 1 });
		await sessionManager.flush();
		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeString();

		await expect(session.reload()).rejects.toThrow("Session reload cancelled");
		expect(emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "session_before_switch", targetSessionFile: sessionFile }),
		);
	});
});
