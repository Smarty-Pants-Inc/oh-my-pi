import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { Extension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { DaemonCompletionNotification } from "@oh-my-pi/pi-coding-agent/launch/protocol";
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
		options: {
			streamFn?: StreamFn;
			advisorStreamFn?: StreamFn;
			persist?: boolean;
			asyncJobManager?: AsyncJobManager;
			agentId?: string;
			tools?: AgentTool[];
			toolRegistry?: Map<string, AgentTool>;
			xdev?: XdevState;
			builtInToolNames?: string[];
		} = {},
	): {
		session: AgentSession;
		sessionManager: SessionManager;
		extensionRunner: ExtensionRunner;
	} {
		const sessionManager =
			options.persist === false
				? SessionManager.inMemory(tempDir.path())
				: SessionManager.create(tempDir.path(), tempDir.path());
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
			...(options.advisorStreamFn ? { advisorStreamFn: options.advisorStreamFn } : {}),
			...(options.asyncJobManager
				? { ownedAsyncJobManager: options.asyncJobManager, agentId: options.agentId ?? "Main" }
				: {}),
			toolRegistry: options.toolRegistry,
			xdev: options.xdev,
			builtInToolNames: options.builtInToolNames,
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

	it("emits switch at the retained identity and ready only after target messages are active", async () => {
		const tempDir = TempDir.createSync("@pi-switch-lifecycle-ready-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "previous", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();
		if (!previousSessionFile) throw new Error("Expected previous session file");
		await session.switchSession(previousSessionFile);

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target one", timestamp: 2 });
		targetManager.appendMessage({ role: "user", content: "target two", timestamp: 3 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		await targetManager.close();

		const observed: Array<{ type: "session_switch" | "session_ready"; sessionFile?: string; messages: number }> = [];
		const emit = extensionRunner.emit.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emit").mockImplementation(event => {
			if (event.type === "session_switch") {
				observed.push({ type: event.type, sessionFile: session.sessionFile, messages: session.messages.length });
			}
			return emit(event);
		});
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation((event, finalizeBeforeHostCompletion) => {
			if (event.type === "session_ready") {
				observed.push({ type: event.type, sessionFile: session.sessionFile, messages: session.messages.length });
			}
			return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
		});

		await expect(session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(observed).toEqual([
			{ type: "session_switch", sessionFile: previousSessionFile, messages: 1 },
			{ type: "session_ready", sessionFile: targetSessionFile, messages: 2 },
		]);
	});
	it("rejects duplicate and out-of-order lifecycle capture and publication steps", async () => {
		const lifecycle = new SessionLifecycleTransaction({
			captureRetainedCheckpoint: async () => ({ restore: async () => {} }),
			beginOwnership: () => ({
				ready: async () => {},
				quarantineBash: async () => {},
				acquire: async () => {},
				markTarget: () => {},
				prepareCommit: async () => {},
				selectCommit: async () => {},
				activateCommit: async () => {},
				prepareRollback: async () => {},
				selectRollback: async () => {},
				activateRollback: async () => {},
			}),
			activateFence: () => {},
		});

		expect(() => lifecycle.markTarget()).toThrow("Lifecycle target cannot be marked from phase fenced");
		await lifecycle.captureRetained();
		await expect(lifecycle.captureRetained()).rejects.toThrow(
			"Lifecycle retained capture cannot start from phase checkpointed",
		);
		await lifecycle.recaptureRetained();
		await lifecycle.acquireOwnership();
		lifecycle.markTarget();
		expect(() => lifecycle.markTarget()).toThrow("Lifecycle target cannot be marked from phase target-marked");
		lifecycle.markPublicationStarted();
		expect(() => lifecycle.markPublicationStarted()).toThrow("Lifecycle publication already started");
	});

	for (const transition of ["newSession", "fork", "switchSession"] as const) {
		it(`runs the host session fence before retained capture${transition === "fork" ? "" : " or abort"} for ${transition}`, async () => {
			const tempDir = TempDir.createSync(`@pi-${transition}-host-fence-order-`);
			tempDirs.push(tempDir);
			const { session, sessionManager, extensionRunner } = buildSession(tempDir);
			sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
			await sessionManager.ensureOnDisk();

			let targetSessionFile: string | undefined;
			if (transition === "switchSession") {
				const target = SessionManager.create(tempDir.path(), tempDir.path());
				target.appendMessage({ role: "user", content: "target", timestamp: 2 });
				await target.ensureOnDisk();
				targetSessionFile = target.getSessionFile();
				await target.close();
				if (!targetSessionFile) throw new Error("Expected target session file");
			}

			const order: string[] = [];
			const hasHandlers = extensionRunner.hasHandlers.bind(extensionRunner);
			vi.spyOn(extensionRunner, "hasHandlers").mockImplementation(eventType => {
				if (eventType === "session_before_switch") return true;
				return hasHandlers(eventType);
			});
			const emit = extensionRunner.emit.bind(extensionRunner);
			vi.spyOn(extensionRunner, "emit").mockImplementation(event => {
				if (event.type === "session_before_switch") order.push("public");
				return emit(event);
			});
			const beforeMutation = extensionRunner.emitBeforeSessionMutation.bind(extensionRunner);
			vi.spyOn(extensionRunner, "emitBeforeSessionMutation").mockImplementation(event => {
				if (event.type === "session_switch") order.push("host");
				return beforeMutation(event);
			});
			const capture = sessionManager.capturePersistedSessionFile.bind(sessionManager);
			vi.spyOn(sessionManager, "capturePersistedSessionFile").mockImplementation(() => {
				order.push("capture");
				return capture();
			});
			const abort = session.abort.bind(session);
			vi.spyOn(session, "abort").mockImplementation(options => {
				order.push("abort");
				return abort(options);
			});

			const result =
				transition === "newSession"
					? session.newSession()
					: transition === "fork"
						? session.fork()
						: session.switchSession(targetSessionFile!);
			await expect(result).resolves.toBe(true);
			expect(order.slice(0, transition === "fork" ? 3 : 4)).toEqual(
				transition === "fork" ? ["public", "host", "capture"] : ["public", "host", "capture", "abort"],
			);
		});
	}

	it("materializes target journal mutations before session_ready publication", async () => {
		const tempDir = TempDir.createSync("@pi-switch-materialized-ready-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		await targetManager.close();

		session.setSessionSwitchReconciler(async () => {
			session.sessionManager.appendMessage({
				role: "user",
				content: "durable before switch readiness",
				timestamp: 3,
			});
		});
		let journalAtReady: string | undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_ready") journalAtReady = await Bun.file(targetSessionFile).text();
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		await expect(session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(journalAtReady).toContain("durable before switch readiness");
	});

	for (const failurePoint of ["reconciler", "prompt refresh"] as const) {
		it(`rolls back exactly without publishing session_ready when target ${failurePoint} fails`, async () => {
			const tempDir = TempDir.createSync(`@pi-switch-${failurePoint.replace(" ", "-")}-rollback-`);
			tempDirs.push(tempDir);
			const { session, sessionManager, extensionRunner } = buildSession(tempDir);
			const retainedEntryId = sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
			sessionManager.appendMessage(assistantMsg("retained reply"));
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			await sessionManager.ensureOnDisk();
			await sessionManager.flush();
			const retainedSessionFile = session.sessionFile;
			if (!retainedSessionFile) throw new Error("Expected retained session file");
			const retainedLeafId = sessionManager.getLeafId();
			const retainedEntries = structuredClone(sessionManager.getEntries());
			const retainedMessages = [...session.messages];
			const retainedRaw = await Bun.file(retainedSessionFile).text();
			const retainedSystemPrompt = [...session.agent.state.systemPrompt];
			expect(sessionManager.getEntry(retainedEntryId)).toBeDefined();

			const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
			targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
			await targetManager.ensureOnDisk();
			await targetManager.flush();
			const targetSessionFile = targetManager.getSessionFile();
			if (!targetSessionFile) throw new Error("Expected target session file");
			await targetManager.close();

			const failure = new Error(`target ${failurePoint} failed`);
			if (failurePoint === "reconciler") {
				let reconcileAttempts = 0;
				session.setSessionSwitchReconciler(async () => {
					reconcileAttempts++;
					if (reconcileAttempts !== 1) return;
					sessionManager.appendMessage({ role: "user", content: "partial reconciler mutation", timestamp: 3 });
					throw failure;
				});
			} else {
				vi.spyOn(session, "refreshBaseSystemPrompt").mockImplementationOnce(async () => {
					session.agent.setSystemPrompt(["partial target prompt"]);
					throw failure;
				});
			}
			const published: string[] = [];
			const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
			vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
				async (event, finalizeBeforeHostCompletion) => {
					const result = await emitWithHostCompletion(event, finalizeBeforeHostCompletion);
					published.push(event.type);
					return result;
				},
			);

			await expect(session.switchSession(targetSessionFile)).rejects.toBe(failure);

			expect(published).toEqual(["session_rollback"]);
			expect(session.sessionFile).toBe(retainedSessionFile);
			expect(sessionManager.getLeafId()).toBe(retainedLeafId);
			expect(sessionManager.getEntries()).toEqual(retainedEntries);
			expect(session.messages).toEqual(retainedMessages);
			expect(await Bun.file(retainedSessionFile).text()).toBe(retainedRaw);
			expect(session.agent.state.systemPrompt).toEqual(retainedSystemPrompt);
		});
	}

	it("rejects incomplete owner selection before publication and restores every reversible owner", async () => {
		const tempDir = TempDir.createSync("@pi-switch-owner-selection-rollback-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("retained reply"));
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedLeafId = sessionManager.getLeafId();
		const retainedEntries = structuredClone(sessionManager.getEntries());
		const retainedRaw = await Bun.file(retainedSessionFile).text();
		const retainedDirective = "retained owner-selection directive";
		const retainedPreview = (input: unknown) => ({ retained: input });
		session.toolChoiceQueue.pushOnce("none", { label: retainedDirective });
		session.toolChoiceQueue.registerPendingInvoker("retained-preview", "ast_edit", retainedPreview);

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		await targetManager.close();

		const failure = new Error("required tool owner selection failed");
		const beginToolOwnership = session.agent.beginToolDirectiveSessionTransition.bind(session.agent);
		let commitSelectionAttempts = 0;
		let rollbackSelections = 0;
		vi.spyOn(session.agent, "beginToolDirectiveSessionTransition").mockImplementation(() => {
			const transition = beginToolOwnership();
			return {
				commit: () => {
					commitSelectionAttempts++;
					if (commitSelectionAttempts === 1) throw failure;
					transition.commit();
				},
				rollback: () => {
					rollbackSelections++;
					transition.rollback();
				},
			};
		});
		const finishBashTransition = BashRunner.prototype.finishSessionTransition;
		const bashSelections: boolean[] = [];
		vi.spyOn(BashRunner.prototype, "finishSessionTransition").mockImplementation(function (
			this: BashRunner,
			transition,
			success,
		) {
			bashSelections.push(success);
			return finishBashTransition.call(this, transition, success);
		});
		const published: string[] = [];
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				const result = await emitWithHostCompletion(event, finalizeBeforeHostCompletion);
				published.push(event.type);
				return result;
			},
		);

		await expect(session.switchSession(targetSessionFile)).rejects.toBe(failure);

		expect(commitSelectionAttempts).toBe(1);
		expect(rollbackSelections).toBe(1);
		expect(bashSelections).toEqual([true, false]);
		expect(published).toEqual(["session_rollback"]);
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(sessionManager.getLeafId()).toBe(retainedLeafId);
		expect(sessionManager.getEntries()).toEqual(retainedEntries);
		expect(await Bun.file(retainedSessionFile).text()).toBe(retainedRaw);
		expect(session.toolChoiceQueue.inspect()).toEqual([retainedDirective]);
		expect(session.peekPendingInvoker()).toBe(retainedPreview);

		await expect(session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(published).toEqual(["session_rollback", "session_ready"]);
	});

	it("selects runtime owners before ACK and finalizes artifacts exactly once after host completion", async () => {
		const tempDir = TempDir.createSync("@pi-switch-finalized-publication-");
		tempDirs.push(tempDir);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		await targetManager.close();

		let artifactFinalized = false;
		let artifactFinalizeAttempts = 0;
		let advisorSelected = false;
		let bashSelected = false;
		let asyncSelected = false;
		let launchSelected = false;
		let targetFramePersisted = false;
		const hostEvents: string[] = [];
		const hostFault = new Error("contained target host publication fault");
		const hostExtension = {
			path: "test://finalized-publication-host",
			resolvedPath: "test://finalized-publication-host",
			handlers: new Map(),
		} as unknown as Extension;
		const runtime = new ExtensionRuntime();
		const extensionRunner = new ExtensionRunner(
			[],
			runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				extension: hostExtension,
				afterDispatch: async event => {
					hostEvents.push(event.type);
					if (event.type !== "session_ready") return;
					expect(artifactFinalized).toBe(false);
					sessionManager.appendCustomEntry("test_host_frame", { text: "persisted target host frame" });
					await sessionManager.flush();
					targetFramePersisted = (await Bun.file(targetSessionFile).text()).includes(
						"persisted target host frame",
					);
					throw hostFault;
				},
			},
		);
		const containedErrors: string[] = [];
		extensionRunner.onError(error => containedErrors.push(error.error));
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
			ownedAsyncJobManager: asyncManager,
			agentId: "Main",
		});
		sessions.push(session);

		const beginArtifactTransaction = sessionManager.beginArtifactTransaction.bind(sessionManager);
		vi.spyOn(sessionManager, "beginArtifactTransaction").mockImplementation(async () => {
			const transaction = await beginArtifactTransaction();
			return {
				rollback: () => transaction.rollback(),
				commit: async () => {
					artifactFinalizeAttempts++;
					expect(advisorSelected).toBe(true);
					expect(bashSelected).toBe(true);
					expect(asyncSelected).toBe(true);
					expect(launchSelected).toBe(true);
					await transaction.commit();
					artifactFinalized = true;
				},
			};
		});
		const beginYieldTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
		vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
			const transaction = beginYieldTransaction(kind);
			return {
				rollback: () => transaction.rollback(),
				activate: () => transaction.activate(),
				commit: () => {
					transaction.commit();
					if (kind === "advisor") {
						expect(artifactFinalized).toBe(false);
						advisorSelected = true;
					} else if (kind === "async-result") {
						expect(bashSelected).toBe(true);
						asyncSelected = true;
					} else if (kind === "launch-completion") {
						expect(asyncSelected).toBe(true);
						launchSelected = true;
					}
				},
			};
		});
		const finishBashTransition = BashRunner.prototype.finishSessionTransition;
		vi.spyOn(BashRunner.prototype, "finishSessionTransition").mockImplementation(function (
			this: BashRunner,
			transition,
			success,
		) {
			finishBashTransition.call(this, transition, success);
			if (success) {
				expect(advisorSelected).toBe(true);
				bashSelected = true;
			}
		});

		await expect(session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(artifactFinalized).toBe(true);
		expect(artifactFinalizeAttempts).toBe(1);
		expect(hostEvents).toEqual(["session_ready"]);
		expect(targetFramePersisted).toBe(true);
		expect(containedErrors).toContain(hostFault.message);
		expect(session.sessionFile).toBe(targetSessionFile);
		expect(await Bun.file(targetSessionFile).exists()).toBe(true);
		expect(await Bun.file(targetSessionFile).text()).toContain("persisted target host frame");
	});

	it("preserves durable journal mutations when new-session flush fails before the post-quiescence capture", async () => {
		const tempDir = TempDir.createSync("@pi-new-pre-abort-checkpoint-");
		tempDirs.push(tempDir);
		const { session, sessionManager } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "retained before new", timestamp: 1 });
		const failure = new Error("new-session retained flush failed after mutation");
		const mutationText = "durable new-session mutation";
		const fixture = await installDurableMutationBeforePostQuiescenceCapture(
			session,
			sessionManager,
			mutationText,
			failure,
		);

		await expect(session.newSession()).rejects.toBe(failure);

		const durableMutationRaw = fixture.durableMutationRaw();
		if (durableMutationRaw === undefined) throw new Error("Expected durable new-session mutation bytes");
		expect(fixture.flushCalls()).toBe(3);
		expect(durableMutationRaw).toContain(mutationText);
		expect(fixture.captureCalls()).toBe(2); // Initial checkpoint plus rollback preservation; recapture was not reached.
		expect(session.sessionFile).toBe(fixture.retainedSessionFile);
		expect(sessionManager.getEntries()).toEqual([
			...fixture.retainedEntries,
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({ role: "user", content: mutationText, timestamp: 99 }),
			}),
		]);
		expect(session.messages).toEqual(fixture.retainedMessages);
		expect(await fs.readFile(fixture.retainedSessionFile, "utf8")).toBe(durableMutationRaw);
	});

	it("preserves durable journal mutations when switch flush fails before the post-quiescence capture", async () => {
		const tempDir = TempDir.createSync("@pi-switch-pre-abort-checkpoint-");
		tempDirs.push(tempDir);
		const { session, sessionManager } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "retained before switch", timestamp: 1 });

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "switch target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected switch target session file");
		await targetManager.close();

		const failure = new Error("switch retained flush failed after mutation");
		const mutationText = "durable switch mutation";
		const fixture = await installDurableMutationBeforePostQuiescenceCapture(
			session,
			sessionManager,
			mutationText,
			failure,
		);

		await expect(session.switchSession(targetSessionFile)).rejects.toBe(failure);

		const durableMutationRaw = fixture.durableMutationRaw();
		if (durableMutationRaw === undefined) throw new Error("Expected durable switch mutation bytes");
		expect(fixture.flushCalls()).toBe(3);
		expect(durableMutationRaw).toContain(mutationText);
		expect(fixture.captureCalls()).toBe(2); // Initial checkpoint plus rollback preservation; recapture was not reached.
		expect(session.sessionFile).toBe(fixture.retainedSessionFile);
		expect(sessionManager.getEntries()).toEqual([
			...fixture.retainedEntries,
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({ role: "user", content: mutationText, timestamp: 99 }),
			}),
		]);
		expect(session.messages).toEqual(fixture.retainedMessages);
		expect(await fs.readFile(fixture.retainedSessionFile, "utf8")).toBe(durableMutationRaw);
	});

	it("uses the successful post-quiescence capture as the authoritative rollback checkpoint", async () => {
		const tempDir = TempDir.createSync("@pi-new-post-quiescence-checkpoint-");
		tempDirs.push(tempDir);
		const { session, sessionManager } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "retained before quiescence", timestamp: 1 });
		const fixture = await installDurableMutationBeforePostQuiescenceCapture(
			session,
			sessionManager,
			"authoritative post-quiescence mutation",
		);
		const targetFailure = new Error("new-session target failed after retained capture");
		vi.spyOn(sessionManager, "newSession").mockRejectedValue(targetFailure);

		await expect(session.newSession()).rejects.toBe(targetFailure);

		expect(fixture.flushCalls()).toBe(3);
		expect(fixture.captureCalls()).toBe(2);
		const postQuiescenceRaw = fixture.postQuiescenceRaw();
		const postQuiescenceEntries = fixture.postQuiescenceEntries();
		const postQuiescenceMessages = fixture.postQuiescenceMessages();
		expect(postQuiescenceRaw).toBeString();
		expect(postQuiescenceEntries).toBeDefined();
		expect(postQuiescenceMessages).toBeDefined();
		if (
			postQuiescenceRaw === undefined ||
			postQuiescenceEntries === undefined ||
			postQuiescenceMessages === undefined
		) {
			throw new Error("Expected a complete post-quiescence checkpoint");
		}
		expect(session.sessionFile).toBe(fixture.retainedSessionFile);
		expect(sessionManager.getEntries()).toEqual(postQuiescenceEntries);
		expect(session.messages).toEqual(postQuiescenceMessages);
		expect(await fs.readFile(fixture.retainedSessionFile, "utf8")).toBe(postQuiescenceRaw);
	});

	it("preserves a retained append accepted after the rollback checkpoint", async () => {
		const tempDir = TempDir.createSync("@pi-switch-post-checkpoint-append-");
		tempDirs.push(tempDir);
		const { session, sessionManager } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "retained before checkpoint", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("retained assistant"));
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = sessionManager.getSessionFile();
		if (!retainedSessionFile) throw new Error("Expected retained session file");

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		targetManager.appendMessage(assistantMsg("target assistant"));
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		await targetManager.close();

		let postCheckpointEntryId: string | undefined;
		const captureTarget = sessionManager.capturePersistedSessionFileAt.bind(sessionManager);
		vi.spyOn(sessionManager, "capturePersistedSessionFileAt").mockImplementation(async sessionFile => {
			const snapshot = await captureTarget(sessionFile);
			postCheckpointEntryId = sessionManager.appendCustomEntry("post_checkpoint_extension", {
				text: "must survive retained rollback",
			});
			await sessionManager.flush();
			return snapshot;
		});

		const targetFailure = new Error("target adoption failed after retained append");
		const setSessionFile = sessionManager.setSessionFile.bind(sessionManager);
		vi.spyOn(sessionManager, "setSessionFile").mockImplementation(async sessionFile => {
			await setSessionFile(sessionFile);
			throw targetFailure;
		});

		await expect(session.switchSession(targetSessionFile)).rejects.toBe(targetFailure);

		if (!postCheckpointEntryId) throw new Error("Expected post-checkpoint append");
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(sessionManager.getEntry(postCheckpointEntryId)).toMatchObject({
			type: "custom",
			customType: "post_checkpoint_extension",
		});
		expect(await fs.readFile(retainedSessionFile, "utf8")).toContain("must survive retained rollback");
	});

	it("emits new-session ready only after setup completes", async () => {
		const tempDir = TempDir.createSync("@pi-new-session-lifecycle-");
		tempDirs.push(tempDir);
		const { session, extensionRunner } = buildSession(tempDir);
		let switchFrameCallbacks = 0;
		const order: string[] = [];
		let sessionChangeCallbacks = 0;
		session.registerSessionChangeCallback(() => sessionChangeCallbacks++);
		const emit = extensionRunner.emit.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emit").mockImplementation(event => {
			if (event.type === "session_switch") {
				order.push("switch");
				session.registerSessionChangeCallback(() => switchFrameCallbacks++);
			}
			return emit(event);
		});
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_ready") {
					order.push("ready");
					expect(sessionChangeCallbacks).toBe(0);
					expect(switchFrameCallbacks).toBe(0);
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		await expect(
			session.newSession(undefined, async sessionManager => {
				order.push("setup");
				await sessionManager.setSessionName("configured", "user");
			}),
		).resolves.toBe(true);

		expect(order).toEqual(["switch", "setup", "ready"]);
		expect(switchFrameCallbacks).toBe(1);
		expect(sessionChangeCallbacks).toBe(1);
		expect(session.sessionManager.getSessionName()).toBe("configured");
	});

	it("rehydrates setup-seeded goal and todos before new-session readiness", async () => {
		const tempDir = TempDir.createSync("@pi-new-session-seeded-state-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		const now = Date.now();
		const seededGoal = {
			id: "goal-seeded-by-extension",
			objective: "Continue the replacement route",
			status: "active" as const,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		};
		const seededTodos = [
			{
				name: "Replacement route",
				tasks: [{ content: "Run the next product proof", status: "in_progress" as const }],
			},
		];
		let beforeSwitchCalls = 0;
		let reconcileCalls = 0;
		session.setSessionBeforeSwitchReconciler(async () => {
			beforeSwitchCalls++;
		});
		session.setSessionSwitchReconciler(async () => {
			reconcileCalls++;
			const context = sessionManager.buildSessionContext();
			expect(context.mode).toBe("goal");
			expect(context.modeData?.goal).toMatchObject({ objective: seededGoal.objective });
			expect(session.getGoalModeState()).toMatchObject({ enabled: true, goal: seededGoal });
		});

		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_ready") {
					expect(session.getTodoPhases()).toEqual(seededTodos);
					expect(session.getGoalModeState()?.goal.objective).toBe(seededGoal.objective);
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		await expect(
			session.newSession(undefined, async manager => {
				manager.appendModeChange("goal", { goal: seededGoal });
				manager.appendCustomEntry("user_todo_edit", { phases: seededTodos });
			}),
		).resolves.toBe(true);

		expect(beforeSwitchCalls).toBe(1);
		expect(reconcileCalls).toBe(1);
		expect(session.getTodoPhases()).toEqual(seededTodos);
		expect(session.getGoalModeState()?.goal.objective).toBe(seededGoal.objective);
	});

	it("hydrates a persisted goal during AgentSession construction", async () => {
		const tempDir = TempDir.createSync("@pi-resume-goal-hydration-");
		tempDirs.push(tempDir);
		const now = Date.now();
		const persistedGoal = {
			id: "persisted-resume-goal",
			objective: "Resume this exact objective",
			status: "active" as const,
			tokensUsed: 12,
			timeUsedSeconds: 3,
			createdAt: now - 1_000,
			updatedAt: now,
		};
		const seedManager = SessionManager.create(tempDir.path(), tempDir.path());
		seedManager.appendModeChange("goal", { goal: persistedGoal });
		await seedManager.ensureOnDisk();
		await seedManager.flush();
		const sessionFile = seedManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted goal session file");
		await seedManager.close();

		const sessionManager = await SessionManager.open(sessionFile, tempDir.path());
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
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

		expect(session.getGoalModeState()).toEqual({ enabled: true, mode: "active", goal: persistedGoal });
	});

	it("clears stale goal state when switching to a session without a goal", async () => {
		const tempDir = TempDir.createSync("@pi-switch-goal-clear-");
		tempDirs.push(tempDir);
		const { session } = buildSession(tempDir);
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "stale-goal",
				objective: "Must not cross the session boundary",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: now });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		await targetManager.close();

		await expect(session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(session.getGoalModeState()).toBeUndefined();
	});

	it("refuses an invalid persisted goal status during new-session setup", async () => {
		const tempDir = TempDir.createSync("@pi-new-session-invalid-goal-");
		tempDirs.push(tempDir);
		const { session } = buildSession(tempDir);
		const now = Date.now();

		await expect(
			session.newSession(undefined, async manager => {
				manager.appendModeChange("goal", {
					goal: {
						id: "invalid-goal",
						objective: "Invalid state must not hydrate",
						status: "invented",
						tokensUsed: 0,
						timeUsedSeconds: 0,
						createdAt: now,
						updatedAt: now,
					},
				});
			}),
		).resolves.toBe(true);

		expect(session.getGoalModeState()).toBeUndefined();
	});

	it("cleans partially opened lifecycle ownership before publishing a switch frame", async () => {
		const tempDir = TempDir.createSync("@pi-new-session-ownership-init-");
		tempDirs.push(tempDir);
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		const recoveryMarker = "post-failure lifecycle fence recovery";
		const primaryMock = createMockModel({
			handler: () => ({ content: ["recovery reply"] }),
		});
		const { session, extensionRunner } = buildSession(tempDir, {
			streamFn: primaryMock.stream,
			asyncJobManager: asyncManager,
			agentId: "Main",
		});
		const retainedInvoker = (input: unknown) => input;
		session.toolChoiceQueue.registerPendingInvoker("retained-preview", "ast_edit", retainedInvoker);
		const failure = new Error("async ownership transaction failed");
		const beginTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
		const beginTransactionSpy = vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
			if (kind === "async-result") throw failure;
			return beginTransaction(kind);
		});
		const emitSpy = vi.spyOn(extensionRunner, "emit");
		const completionSpy = vi.spyOn(extensionRunner, "emitWithHostCompletion");

		await expect(session.newSession()).rejects.toBe(failure);

		expect(emitSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session_switch" }));
		expect(completionSpy).not.toHaveBeenCalledWith({ type: "session_rollback" });
		expect(session.peekPendingInvoker()).toBe(retainedInvoker);
		beginTransactionSpy.mockRestore();
		const recoveryReceipt = session.queueLaunchCompletion({
			event: "daemon-completed",
			completionId: recoveryMarker,
			owner: session.sessionManager.getSessionId(),
			daemon: {
				name: recoveryMarker,
				id: recoveryMarker,
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner: session.sessionManager.getSessionId(),
				persist: false,
				detached: false,
			},
		} satisfies DaemonCompletionNotification);
		await expect(recoveryReceipt).resolves.toBeUndefined();
		expect(primaryMock.calls).toHaveLength(0);
		expect(session.messages.filter(message => JSON.stringify(message).includes(recoveryMarker))).toHaveLength(1);
		await expect(session.newSession()).resolves.toBe(true);
	});

	it("materializes the exact new-session journal before host completion", async () => {
		const tempDir = TempDir.createSync("@pi-new-session-materialized-");
		tempDirs.push(tempDir);
		const { session, extensionRunner } = buildSession(tempDir);
		let targetSessionFile: string | undefined;
		let journalAtCompletion: string | undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_ready") {
					targetSessionFile = session.sessionFile;
					if (!targetSessionFile) throw new Error("Expected replacement session file before readiness");
					expect(await Bun.file(targetSessionFile).exists()).toBe(true);
					journalAtCompletion = await Bun.file(targetSessionFile).text();
					expect(journalAtCompletion).toContain("durable before readiness");
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		await expect(
			session.newSession(undefined, async manager => {
				manager.appendMessage({ role: "user", content: "durable before readiness", timestamp: 1 });
			}),
		).resolves.toBe(true);

		expect(targetSessionFile).toBe(session.sessionFile);
		expect(journalAtCompletion).toBeString();
	});

	it("rolls back a new session whose target journal cannot materialize without publishing readiness", async () => {
		const tempDir = TempDir.createSync("@pi-new-session-materialization-rollback-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("retained reply"));
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedJournal = await Bun.file(retainedSessionFile).text();
		const retainedMessages = [...session.messages];
		let retainedCallbacks = 0;
		let retainedRollbacks = 0;
		let targetCallbacks = 0;
		let targetDiscards = 0;
		const unregisterRetained = session.registerSessionChangeCallback(() => retainedCallbacks++);
		session.registerSessionChangeCallback(() => {}, { onRollback: () => retainedRollbacks++ });
		const failure = new Error("new target materialization failed");
		let replacementSessionFile: string | undefined;
		const ensureOnDisk = sessionManager.ensureOnDisk.bind(sessionManager);
		const ensureOnDiskSpy = vi.spyOn(sessionManager, "ensureOnDisk").mockImplementation(async () => {
			if (session.sessionFile !== retainedSessionFile) {
				replacementSessionFile = session.sessionFile;
				throw failure;
			}
			await ensureOnDisk();
		});
		const completion = vi.spyOn(extensionRunner, "emitWithHostCompletion");

		await expect(
			session.newSession(undefined, async () => {
				unregisterRetained();
				session.registerSessionChangeCallback(() => targetCallbacks++, {
					onDiscard: () => targetDiscards++,
				});
			}),
		).rejects.toBe(failure);

		expect(completion.mock.calls.map(([event]) => event.type)).toEqual(["session_rollback"]);
		expect(retainedCallbacks).toBe(0);
		expect(targetCallbacks).toBe(0);
		expect(targetDiscards).toBe(1);
		expect(retainedRollbacks).toBe(1);
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(session.messages).toEqual(retainedMessages);
		expect(await Bun.file(retainedSessionFile).text()).toBe(retainedJournal);
		expect(replacementSessionFile).toBeString();
		expect(await Bun.file(replacementSessionFile!).exists()).toBe(false);
		ensureOnDiskSpy.mockRestore();
		await expect(session.newSession()).resolves.toBe(true);
		expect(retainedCallbacks).toBe(1);
	});

	it("runs retained rollback callbacks even when discarded cleanup fails", async () => {
		const tempDir = TempDir.createSync("@pi-new-session-discard-cleanup-");
		tempDirs.push(tempDir);
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		const { session, sessionManager, extensionRunner } = buildSession(tempDir, {
			asyncJobManager: asyncManager,
			agentId: "Main",
		});
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");

		const activatedYieldKinds: string[] = [];
		const beginTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
		const beginTransactionSpy = vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
			const transaction = beginTransaction(kind);
			return {
				commit: () => transaction.commit(),
				activate: () => {
					activatedYieldKinds.push(kind);
					transaction.activate();
				},
				rollback: () => transaction.rollback(),
			};
		});

		const materializationFailure = new Error("target journal materialization failed");
		const discardFailure = new Error("discard cleanup failed");
		const discardOrder: string[] = [];
		let targetCallbacks = 0;
		let retainedRollbacks = 0;
		session.registerSessionChangeCallback(() => {}, { onRollback: () => retainedRollbacks++ });
		const ensureOnDisk = sessionManager.ensureOnDisk.bind(sessionManager);
		const ensureOnDiskSpy = vi.spyOn(sessionManager, "ensureOnDisk").mockImplementation(async () => {
			if (session.sessionFile !== retainedSessionFile) throw materializationFailure;
			await ensureOnDisk();
		});
		const completion = vi.spyOn(extensionRunner, "emitWithHostCompletion");

		let thrown: unknown;
		try {
			await session.newSession(undefined, async () => {
				session.registerSessionChangeCallback(() => targetCallbacks++, {
					onDiscard: () => discardOrder.push("first"),
				});
				session.registerSessionChangeCallback(() => targetCallbacks++, {
					onDiscard: () => {
						discardOrder.push("throwing");
						throw discardFailure;
					},
				});
				session.registerSessionChangeCallback(() => targetCallbacks++, {
					onDiscard: () => discardOrder.push("last"),
				});
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).errors).toEqual([materializationFailure, discardFailure]);
		expect(discardOrder).toEqual(["first", "throwing", "last"]);
		expect(retainedRollbacks).toBe(1);
		expect(targetCallbacks).toBe(0);
		expect(completion.mock.calls.map(([event]) => event.type)).not.toContain("session_rollback");
		expect(activatedYieldKinds.sort()).toEqual(["advisor", "async-result", "launch-completion"]);
		expect(session.sessionFile).toBe(retainedSessionFile);

		ensureOnDiskSpy.mockRestore();
		beginTransactionSpy.mockRestore();
		await expect(session.newSession()).resolves.toBe(true);
		expect(targetCallbacks).toBe(0);
		expect(discardOrder).toEqual(["first", "throwing", "last"]);
	});

	it("emits rollback when a fork transition returns false", async () => {
		const tempDir = TempDir.createSync("@pi-fork-lifecycle-false-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		vi.spyOn(sessionManager, "fork").mockResolvedValue(undefined);
		const completion = vi.spyOn(extensionRunner, "emitWithHostCompletion");

		await expect(session.fork()).resolves.toBe(false);
		expect(completion.mock.calls.map(([event]) => event.type)).toEqual(["session_rollback"]);
	});

	it("suppresses fork rollback publication when artifact clone cleanup fails", async () => {
		const tempDir = TempDir.createSync("@pi-fork-clone-rollback-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const targetFailure = new Error("fork readiness failed");
		const cloneRollbackFailure = new Error("artifact clone rollback failed");
		const rollbackClone = vi.fn().mockRejectedValue(cloneRollbackFailure);
		vi.spyOn(sessionManager, "beginArtifactCloneTransaction").mockResolvedValue({
			publish: vi.fn().mockResolvedValue(undefined),
			commit: vi.fn().mockResolvedValue(undefined),
			rollback: rollbackClone,
		});
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		const completion = vi
			.spyOn(extensionRunner, "emitWithHostCompletion")
			.mockImplementation(async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_ready") throw targetFailure;
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			});

		let thrown: unknown;
		try {
			await session.fork();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AggregateError);
		const rollbackError = thrown as AggregateError;
		expect(rollbackError.message).toBe("Fork failed and rollback was incomplete");
		expect(rollbackError.errors).toEqual(expect.arrayContaining([targetFailure, cloneRollbackFailure]));
		expect(rollbackClone).toHaveBeenCalledTimes(1);
		expect(completion.mock.calls.map(([event]) => event.type)).not.toContain("session_rollback");
	});

	it("restores a failed /drop replacement completely before rollback and keeps the retained file", async () => {
		const tempDir = TempDir.createSync("@pi-new-lifecycle-rollback-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();
		if (!previousSessionFile) throw new Error("Expected retained session file");
		await session.switchSession(previousSessionFile);

		const checkpoint = { checkpointMessageCount: 1, checkpointEntryId: "new-checkpoint", startedAt: "start" };
		const retainedSteer: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "retained steer" }],
			attribution: "user",
			timestamp: 2,
		};
		const retainedFollowUp: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "retained follow-up" }],
			attribution: "user",
			timestamp: 3,
		};
		session.setCheckpointState(checkpoint);
		session.setPlanReferencePath("local://RETAINED.md");
		session.agent.replaceQueues([retainedSteer], [retainedFollowUp]);
		const retainedEntries = sessionManager.getEntries().map(entry => entry.id);
		const retainedMessages = [...session.messages];
		const retainedSystemPrompt = [...session.agent.state.systemPrompt];

		let replacementSessionFile: string | undefined;
		let rollbackAtDispatch:
			| {
					sessionFile: string | undefined;
					entries: string[];
					messages: AgentMessage[];
					checkpoint: unknown;
					steering: AgentMessage[];
					followUp: AgentMessage[];
					systemPrompt: string[];
					planReferencePath: string;
			  }
			| undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation((event, finalizeBeforeHostCompletion) => {
			if (event.type === "session_rollback") {
				rollbackAtDispatch = {
					sessionFile: session.sessionFile,
					entries: sessionManager.getEntries().map(entry => entry.id),
					messages: [...session.messages],
					checkpoint: session.getCheckpointState(),
					steering: [...session.agent.peekSteeringQueue()],
					followUp: [...session.agent.peekFollowUpQueue()],
					systemPrompt: session.agent.state.systemPrompt,
					planReferencePath: session.getPlanReferencePath(),
				};
			}
			return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
		});

		const failure = new Error("new-session setup failed");
		await expect(
			session.newSession({ drop: true }, async manager => {
				replacementSessionFile = manager.getSessionFile();
				manager.appendMessage({ role: "user", content: "replacement", timestamp: 4 });
				await manager.ensureOnDisk();
				session.agent.setSystemPrompt(["replacement prompt"]);
				throw failure;
			}),
		).rejects.toBe(failure);

		expect(rollbackAtDispatch).toEqual({
			sessionFile: previousSessionFile,
			entries: retainedEntries,
			messages: retainedMessages,
			checkpoint,
			steering: [retainedSteer],
			followUp: [retainedFollowUp],
			systemPrompt: retainedSystemPrompt,
			planReferencePath: "local://RETAINED.md",
		});
		expect(await Bun.file(previousSessionFile).exists()).toBe(true);
		expect(replacementSessionFile).toBeString();
		expect(await Bun.file(replacementSessionFile!).exists()).toBe(false);
	});

	it("restores advisor backlog, queued cards, runtime state, and an unsettled receipt after readiness fails", async () => {
		const tempDir = TempDir.createSync("@pi-new-session-advisor-rollback-");
		tempDirs.push(tempDir);
		const primaryMock = createMockModel({ handler: () => ({ content: ["primary reply"] }) });
		const pendingAdvisor = createPendingAdvisorWork("resumed new-session advisor work");
		const { session, sessionManager, extensionRunner } = buildSession(tempDir, {
			streamFn: primaryMock.stream,
			advisorStreamFn: pendingAdvisor.mock.stream,
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.toggleAdvisorEnabled()).toBe(true);
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("retained reply"));
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await session.prompt("start retained advisor work");
		await pendingAdvisor.firstStarted;
		expect(pendingAdvisor.mock.calls).toHaveLength(1);
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedRaw = await Bun.file(retainedSessionFile).text();
		const retainedLeafId = sessionManager.getLeafId();
		if (!retainedLeafId) throw new Error("Expected retained leaf");
		const checkpoint = {
			checkpointMessageCount: session.messages.length,
			checkpointEntryId: retainedLeafId,
			startedAt: "retained",
		};
		session.setCheckpointState(checkpoint);
		const retainedSteeringCard: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "retained new-session steering card",
			display: true,
			attribution: "agent",
			timestamp: 3,
		};
		const retainedFollowUpCard: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "retained new-session follow-up card",
			display: true,
			attribution: "agent",
			timestamp: 4,
		};
		session.agent.replaceQueues([retainedSteeringCard], [retainedFollowUpCard]);
		let receiptResolutions = 0;
		let receiptRejections = 0;
		const receipt = session.yieldQueue.enqueueWithReceipt("advisor", {
			note: "retained new-session yield",
			severity: "nit" as const,
			advisor: undefined,
		});
		void receipt.then(
			() => {
				receiptResolutions++;
			},
			() => {
				receiptRejections++;
			},
		);
		const advisorReset = vi.spyOn(SessionAdvisors.prototype, "resetSessionState");
		const retainedAdvisorResetCalls = advisorReset.mock.calls.length;
		const retainedAdvisorStats = stableAdvisorStats(session.getAdvisorStats());
		const retainedEntries = sessionManager.getEntries().map(entry => entry.id);
		const retainedMessages = [...session.messages];
		const firstAdvisorTail = pendingAdvisor.mock.calls[0]?.context.messages.at(-1);
		const retainedAdvisorPrompt = firstAdvisorTail?.role === "user" ? firstAdvisorTail.content : undefined;

		const failure = new Error("new-session readiness fan-out failed before finalization");
		const phases: string[] = [];
		let replacementSessionFile: string | undefined;
		let readyState:
			| {
					steering: AgentMessage[];
					followUp: AgentMessage[];
					yieldQueued: boolean;
					advisorCalls: number;
					advisorResetCalls: number;
			  }
			| undefined;
		let rollbackState:
			| {
					sessionFile?: string;
					leafId: string | null;
					entries: string[];
					messages: AgentMessage[];
					raw: string;
					steering: AgentMessage[];
					followUp: AgentMessage[];
					checkpoint: unknown;
					advisorStats: StableAdvisorStats;
					yieldQueued: boolean;
					receiptResolutions: number;
					receiptRejections: number;
					advisorCalls: number;
					advisorResetCalls: number;
					advisorPrompt: unknown;
			  }
			| undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_ready") {
					phases.push("ready");
					replacementSessionFile = session.sessionFile;
					readyState = {
						steering: [...session.agent.peekSteeringQueue()],
						followUp: [...session.agent.peekFollowUpQueue()],
						yieldQueued: session.yieldQueue.has("advisor"),
						advisorCalls: pendingAdvisor.mock.calls.length,
						advisorResetCalls: advisorReset.mock.calls.length,
					};
					throw failure;
				}
				if (event.type === "session_rollback") {
					phases.push("rollback");
					rollbackState = {
						sessionFile: session.sessionFile,
						leafId: sessionManager.getLeafId(),
						entries: sessionManager.getEntries().map(entry => entry.id),
						messages: [...session.messages],
						raw: await Bun.file(retainedSessionFile).text(),
						steering: [...session.agent.peekSteeringQueue()],
						followUp: [...session.agent.peekFollowUpQueue()],
						checkpoint: session.getCheckpointState(),
						advisorStats: stableAdvisorStats(session.getAdvisorStats()),
						yieldQueued: session.yieldQueue.has("advisor"),
						receiptResolutions,
						receiptRejections,
						advisorCalls: pendingAdvisor.mock.calls.length,
						advisorResetCalls: advisorReset.mock.calls.length,
						advisorPrompt: retainedAdvisorPrompt,
					};
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		await expect(
			session.newSession(undefined, async manager => {
				replacementSessionFile = manager.getSessionFile();
				manager.appendMessage({ role: "user", content: "replacement", timestamp: 5 });
				await manager.ensureOnDisk();
			}),
		).rejects.toBe(failure);

		expect(phases).toEqual(["ready", "rollback"]);
		expect(readyState).toEqual({
			steering: [],
			followUp: [],
			yieldQueued: false,
			advisorCalls: 1,
			advisorResetCalls: retainedAdvisorResetCalls,
		});
		expect(rollbackState).toEqual({
			sessionFile: retainedSessionFile,
			leafId: retainedLeafId,
			entries: retainedEntries,
			messages: retainedMessages,
			raw: retainedRaw,
			steering: [retainedSteeringCard],
			followUp: [retainedFollowUpCard],
			checkpoint,
			advisorStats: retainedAdvisorStats,
			yieldQueued: true,
			receiptResolutions: 0,
			receiptRejections: 0,
			advisorCalls: 1,
			advisorResetCalls: retainedAdvisorResetCalls,
			advisorPrompt: retainedAdvisorPrompt,
		});
		expect(replacementSessionFile).toBeString();
		expect(replacementSessionFile).not.toBe(retainedSessionFile);
		expect(await Bun.file(replacementSessionFile!).exists()).toBe(false);

		pendingAdvisor.release.resolve();
		await pendingAdvisor.resumed;
		await expect(receipt).resolves.toBeUndefined();
		expect(receiptResolutions).toBe(1);
		expect(receiptRejections).toBe(0);
	});

	it("removes a failed fork artifact and restores retained state before rollback", async () => {
		const tempDir = TempDir.createSync("@pi-fork-lifecycle-rollback-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();
		if (!previousSessionFile) throw new Error("Expected retained session file");
		await session.switchSession(previousSessionFile);
		const checkpoint = { checkpointMessageCount: 1, checkpointEntryId: "fork-checkpoint", startedAt: "start" };
		session.setCheckpointState(checkpoint);

		const observed: Array<{ type: "session_switch" | "session_rollback"; sessionFile: string | undefined }> = [];
		const emit = extensionRunner.emit.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emit").mockImplementation(event => {
			if (event.type === "session_switch") observed.push({ type: event.type, sessionFile: session.sessionFile });
			return emit(event);
		});
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation((event, finalizeBeforeHostCompletion) => {
			if (event.type === "session_rollback") {
				observed.push({ type: event.type, sessionFile: session.sessionFile });
				expect(session.messages).toEqual([{ role: "user", content: "retained", timestamp: 1 }]);
				expect(session.getCheckpointState()).toBe(checkpoint);
			}
			return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
		});

		let replacementSessionFile: string | undefined;
		const fork = sessionManager.fork.bind(sessionManager);
		const failure = new Error("fork failed after replacement identity");
		vi.spyOn(sessionManager, "fork").mockImplementation(async beforeJournalPublish => {
			const result = await fork(beforeJournalPublish);
			replacementSessionFile = result?.newSessionFile;
			throw failure;
		});

		await expect(session.fork()).rejects.toBe(failure);
		expect(observed).toEqual([
			{ type: "session_switch", sessionFile: previousSessionFile },
			{ type: "session_rollback", sessionFile: previousSessionFile },
		]);
		expect(await Bun.file(previousSessionFile).exists()).toBe(true);
		expect(replacementSessionFile).toBeString();
		expect(await Bun.file(replacementSessionFile!).exists()).toBe(false);
	});

	it("preserves fork artifact bytes across reopen and advances the restarted target allocator", async () => {
		const tempDir = TempDir.createSync("@pi-fork-artifact-clone-");
		tempDirs.push(tempDir);
		const { session, sessionManager } = buildSession(tempDir);
		const historicalBytes = Buffer.from([0, 0xff, 17, 34, 51, 68]);
		const allocation = await sessionManager.allocateArtifactPath("bash");
		const historicalId = allocation.id;
		const historicalPath = allocation.path;
		const historicalRelease = allocation.release;
		if (!historicalId || !historicalPath || !historicalRelease) throw new Error("Expected artifact allocation");
		try {
			await fs.writeFile(historicalPath, historicalBytes);
		} finally {
			historicalRelease();
		}
		sessionManager.appendMessage({
			role: "user",
			content: `retained fork link artifact://${historicalId}`,
			timestamp: 1,
		});
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const sourceSessionFile = session.sessionFile;

		await expect(session.fork()).resolves.toBe(true);
		const targetSessionFile = session.sessionFile;
		expect(targetSessionFile).toBeString();
		expect(targetSessionFile).not.toBe(sourceSessionFile);

		const reopened = await SessionManager.open(targetSessionFile!, tempDir.path(), undefined, {
			suppressBreadcrumb: true,
		});
		try {
			expect(JSON.stringify(reopened.getEntries())).toContain(`artifact://${historicalId}`);
			const reopenedHistoricalPath = await reopened.getArtifactPath(historicalId);
			expect(reopenedHistoricalPath).toBeString();
			expect(await fs.readFile(reopenedHistoricalPath as string)).toEqual(historicalBytes);
			const targetId = await reopened.saveArtifact("new target artifact", "bash");
			expect(Number(targetId)).toBeGreaterThan(Number(historicalId));
		} finally {
			await reopened.close();
		}
	});

	it("rolls back a published fork artifact clone before lifecycle success", async () => {
		const tempDir = TempDir.createSync("@pi-fork-artifact-clone-failure-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		const historicalId = await sessionManager.saveArtifact("retained artifact bytes", "bash");
		if (!historicalId) throw new Error("Expected historical artifact id");
		sessionManager.appendMessage({ role: "user", content: `artifact://${historicalId}`, timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		const failure = Object.assign(new Error("artifact clone publish failed"), { code: "EIO" });
		let replacementSessionFile: string | undefined;
		const beginArtifactCloneTransaction = sessionManager.beginArtifactCloneTransaction.bind(sessionManager);
		vi.spyOn(sessionManager, "beginArtifactCloneTransaction").mockImplementation(async () => {
			const transaction = await beginArtifactCloneTransaction();
			if (!transaction) throw new Error("Expected persisted artifact clone transaction");
			return {
				commit: () => transaction.commit(),
				rollback: () => transaction.rollback(),
				publish: async destinationSessionFile => {
					replacementSessionFile = destinationSessionFile;
					await transaction.publish(destinationSessionFile);
					throw failure;
				},
			};
		});
		const lifecycleEvents: string[] = [];
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation((event, finalizeBeforeHostCompletion) => {
			lifecycleEvents.push(event.type);
			return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
		});

		await expect(session.fork()).rejects.toBe(failure);
		expect(lifecycleEvents).not.toContain("session_ready");
		expect(lifecycleEvents).toContain("session_rollback");
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(replacementSessionFile).toBeString();
		expect(await Bun.file(replacementSessionFile!).exists()).toBe(false);
		expect(await Bun.file(replacementSessionFile!.slice(0, -6)).exists()).toBe(false);
		const retainedArtifactPath = await sessionManager.getArtifactPath(historicalId!);
		expect(await Bun.file(retainedArtifactPath!).text()).toBe("retained artifact bytes");
	});

	it("suppresses rollback publication when fork clone cleanup fails while still releasing the source fence", async () => {
		const tempDir = TempDir.createSync("@pi-fork-artifact-clone-cleanup-failure-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		const historicalId = await sessionManager.saveArtifact("retained cleanup-failure bytes", "bash");
		if (!historicalId) throw new Error("Expected historical artifact id");
		sessionManager.appendMessage({ role: "user", content: `artifact://${historicalId}`, timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		const publicationFailure = new Error("fork readiness failed");
		const cleanupFailure = Object.assign(new Error("clone destination cleanup failed"), { code: "EIO" });
		const lifecycleEvents: string[] = [];
		let replacementSessionFile: string | undefined;
		const beginArtifactCloneTransaction = sessionManager.beginArtifactCloneTransaction.bind(sessionManager);
		vi.spyOn(sessionManager, "beginArtifactCloneTransaction").mockImplementation(async () => {
			const transaction = await beginArtifactCloneTransaction();
			if (!transaction) throw new Error("Expected persisted artifact clone transaction");
			return {
				publish: (destinationSessionFile: string) => transaction.publish(destinationSessionFile),
				commit: () => transaction.commit(),
				rollback: async () => {
					vi.spyOn(fs, "rm").mockRejectedValueOnce(cleanupFailure);
					await transaction.rollback();
				},
			};
		});
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				lifecycleEvents.push(event.type);
				if (event.type === "session_ready") {
					replacementSessionFile = session.sessionFile;
					throw publicationFailure;
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		let thrown: unknown;
		try {
			await session.fork();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).errors).toContain(publicationFailure);
		const cloneRollbackFailure = (thrown as AggregateError).errors.find(error => error instanceof AggregateError) as
			| AggregateError
			| undefined;
		expect(cloneRollbackFailure?.errors).toContain(cleanupFailure);
		expect(lifecycleEvents).toContain("session_ready");
		expect(lifecycleEvents).not.toContain("session_rollback");
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(replacementSessionFile).toBeString();
		expect(await Bun.file(replacementSessionFile!).exists()).toBe(false);
		expect(await Bun.file(replacementSessionFile!.slice(0, -6)).exists()).toBe(false);
		const retainedArtifactPath = await sessionManager.getArtifactPath(historicalId);
		expect(await Bun.file(retainedArtifactPath!).text()).toBe("retained cleanup-failure bytes");
		const nextId = await sessionManager.saveArtifact("source fence released", "bash");
		expect(Number(nextId)).toBeGreaterThan(Number(historicalId));
	});

	it("preserves non-root branch artifact bytes across reopen and advances the restarted allocator", async () => {
		const tempDir = TempDir.createSync("@pi-branch-artifact-clone-");
		tempDirs.push(tempDir);
		const { session, sessionManager } = buildSession(tempDir);
		const historicalBytes = Buffer.from([7, 6, 5, 0, 4, 3, 2, 1]);
		const allocation = await sessionManager.allocateArtifactPath("read");
		const historicalId = allocation.id;
		const historicalPath = allocation.path;
		const historicalRelease = allocation.release;
		if (!historicalId || !historicalPath || !historicalRelease) throw new Error("Expected artifact allocation");
		try {
			await fs.writeFile(historicalPath, historicalBytes);
		} finally {
			historicalRelease();
		}
		sessionManager.appendMessage({
			role: "user",
			content: `retained branch link artifact://${historicalId}`,
			timestamp: 1,
		});
		sessionManager.appendMessage(assistantMsg("retained assistant"));
		const selectedEntryId = sessionManager.appendMessage({ role: "user", content: "edit this", timestamp: 2 });
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const sourceSessionFile = session.sessionFile;

		await expect(session.branch(selectedEntryId)).resolves.toMatchObject({ cancelled: false });
		const targetSessionFile = session.sessionFile;
		expect(targetSessionFile).toBeString();
		expect(targetSessionFile).not.toBe(sourceSessionFile);

		const reopened = await SessionManager.open(targetSessionFile!, tempDir.path(), undefined, {
			suppressBreadcrumb: true,
		});
		try {
			expect(JSON.stringify(reopened.getEntries())).toContain(`artifact://${historicalId}`);
			const reopenedHistoricalPath = await reopened.getArtifactPath(historicalId);
			expect(reopenedHistoricalPath).toBeString();
			expect(await fs.readFile(reopenedHistoricalPath as string)).toEqual(historicalBytes);
			const targetId = await reopened.saveArtifact("new branch artifact", "read");
			expect(Number(targetId)).toBeGreaterThan(Number(historicalId));
		} finally {
			await reopened.close();
		}
	});

	it("restores the complete retained checkpoint before emitting rollback", async () => {
		const tempDir = TempDir.createSync("@pi-switch-lifecycle-rollback-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();
		if (!previousSessionFile) throw new Error("Expected previous session file");
		await session.switchSession(previousSessionFile);
		const checkpoint = { checkpointMessageCount: 1, checkpointEntryId: "retained-checkpoint", startedAt: "start" };
		session.setCheckpointState(checkpoint);

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendModelChange(`${model.provider}/${model.id}`);
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		await targetManager.close();

		let rollbackAtDispatch:
			| { sessionFile?: string; messageCount: number; firstMessage: unknown; checkpoint: unknown }
			| undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		const completion = vi
			.spyOn(extensionRunner, "emitWithHostCompletion")
			.mockImplementation((event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_rollback") {
					rollbackAtDispatch = {
						sessionFile: session.sessionFile,
						messageCount: session.messages.length,
						firstMessage: session.messages[0],
						checkpoint: session.getCheckpointState(),
					};
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			});
		const failure = new Error("target model lookup failed");
		const modelLookup = vi.spyOn(modelRegistry, "getAvailable").mockImplementationOnce(() => {
			throw failure;
		});
		try {
			await expect(session.switchSession(targetSessionFile)).rejects.toBe(failure);
		} finally {
			modelLookup.mockRestore();
		}

		expect(session.sessionFile).toBe(previousSessionFile);
		expect(session.messages).toHaveLength(1);
		expect(session.messages[0]).toMatchObject({ role: "user", content: "retained" });
		expect(session.getCheckpointState()).toBe(checkpoint);
		expect(rollbackAtDispatch).toMatchObject({
			sessionFile: previousSessionFile,
			messageCount: 1,
			firstMessage: { role: "user", content: "retained" },
		});
		expect(rollbackAtDispatch?.checkpoint).toBe(checkpoint);
		expect(completion.mock.calls.map(([event]) => event.type)).toEqual(["session_rollback"]);
	});

	it("deep-clones header and entries on every SessionManager restore", async () => {
		const tempDir = TempDir.createSync("@pi-session-restore-clone-");
		tempDirs.push(tempDir);
		const manager = SessionManager.inMemory(tempDir.path());
		await manager.setSessionName("retained title", "user");
		const entryId = manager.appendMessage({ role: "user", content: "retained entry", timestamp: 1 });
		const snapshot = manager.captureState();
		const retainedHeader = structuredClone(snapshot.header);

		manager.restoreState(snapshot);
		await manager.setSessionName("aliased title", "user");
		const restoredEntry = manager.getEntry(entryId);
		if (restoredEntry?.type !== "message" || restoredEntry.message.role !== "user") {
			throw new Error("Expected restored user message entry");
		}
		restoredEntry.message.content = "aliased entry";
		const restoredHeader = manager.getHeader();
		if (!restoredHeader) throw new Error("Expected restored header");
		restoredHeader.cwd = path.join(tempDir.path(), "aliased-cwd");

		manager.restoreState(snapshot);
		expect(manager.getSessionName()).toBe("retained title");
		expect(manager.getHeader()).toEqual(retainedHeader);
		expect(manager.getEntry(entryId)).toMatchObject({
			type: "message",
			message: { role: "user", content: "retained entry" },
		});
		await manager.close();
	});

	it("reasserts deep retained state and byte-exact JSONL after rollback reconciliation flushes mutations", async () => {
		const tempDir = TempDir.createSync("@pi-switch-reconcile-exact-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		await sessionManager.setSessionName("retained title", "user");
		const retainedEntryId = sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = sessionManager.getSessionFile();
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedRaw = await Bun.file(retainedSessionFile).text();
		const retainedEntries = structuredClone(sessionManager.getEntries());

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendModelChange(`${model.provider}/${model.id}`);
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		await targetManager.close();

		session.setSessionSwitchReconciler(async () => {
			await sessionManager.setSessionName("reconciler title", "user");
			const retainedEntry = sessionManager.getEntry(retainedEntryId);
			if (retainedEntry?.type !== "message" || retainedEntry.message.role !== "user") {
				throw new Error("Expected retained user entry during reconciliation");
			}
			retainedEntry.message.content = "reconciler entry mutation";
			sessionManager.appendMessage({ role: "user", content: "reconciler append", timestamp: 3 });
			await sessionManager.flush();
		});
		let rollbackRaw: string | undefined;
		let rollbackTitle: string | undefined;
		let rollbackEntries: unknown;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_rollback") {
					rollbackRaw = await Bun.file(retainedSessionFile).text();
					rollbackTitle = sessionManager.getSessionName();
					rollbackEntries = structuredClone(sessionManager.getEntries());
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);
		const failure = new Error("target model lookup failed before reconciliation");
		vi.spyOn(modelRegistry, "getAvailable").mockImplementationOnce(() => {
			throw failure;
		});

		await expect(session.switchSession(targetSessionFile)).rejects.toBe(failure);
		expect(rollbackRaw).toBe(retainedRaw);
		expect(rollbackTitle).toBe("retained title");
		expect(rollbackEntries).toEqual(retainedEntries);
		expect(await Bun.file(retainedSessionFile).text()).toBe(retainedRaw);
		await sessionManager.rewriteEntries();
		expect(await Bun.file(retainedSessionFile).text()).toBe(retainedRaw);
	});

	it("commits a switch by dropping fenced retained jobs, deliveries, receipts, and oversized spill", async () => {
		const tempDir = TempDir.createSync("@pi-switch-async-commit-");
		tempDirs.push(tempDir);
		const primaryMock = createMockModel({ handler: () => ({ content: ["primary reply"] }) });
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		const { session, sessionManager } = buildSession(tempDir, {
			streamFn: primaryMock.stream,
			asyncJobManager: asyncManager,
		});
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedArtifactManager = sessionManager.getArtifactManager();
		if (!retainedArtifactManager) throw new Error("Expected retained artifact manager");

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		await targetManager.close();

		let queuedReceipt: Promise<void> | undefined;
		const beginYieldTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
		vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
			if (kind === "async-result" && !queuedReceipt) {
				queuedReceipt = session.yieldQueue.enqueueWithReceipt<AsyncResultEntry>("async-result", {
					jobId: "retained-queued-receipt",
					result: "retained queued delivery",
					job: undefined,
					durationMs: 0,
					epoch: 0,
				});
				void queuedReceipt.catch(() => {});
			}
			return beginYieldTransaction(kind);
		});

		const jobGate = Promise.withResolvers<string>();
		const oversized = "x".repeat(ASYNC_INLINE_RESULT_MAX_CHARS + 1);
		const jobId = asyncManager.register("task", "retained oversized job", () => jobGate.promise, {
			id: "retained-running-job",
			ownerId: "Main",
		});
		const loadStarted = Promise.withResolvers<void>();
		const continueLoad = Promise.withResolvers<void>();
		const setSessionFile = sessionManager.setSessionFile.bind(sessionManager);
		vi.spyOn(sessionManager, "setSessionFile").mockImplementation(async sessionFile => {
			loadStarted.resolve();
			await continueLoad.promise;
			return setSessionFile(sessionFile);
		});

		const switching = session.switchSession(targetSessionFile);
		await loadStarted.promise;
		jobGate.resolve(oversized);
		await asyncManager.waitForOwnerJobs("Main");
		await asyncManager.drainDeliveries({ filter: { ownerId: "Main" } });
		expect(await retainedArtifactManager.listFiles()).toEqual([]);
		continueLoad.resolve();
		await expect(switching).resolves.toBe(true);

		expect(asyncManager.getJob(jobId)).toBeUndefined();
		expect(queuedReceipt).toBeDefined();
		await expect(queuedReceipt!).rejects.toThrow("Yield queue entry cleared before dispatch");
		expect(await retainedArtifactManager.listFiles()).toEqual([]);
		expect(await sessionManager.getArtifactManager()?.listFiles()).toEqual([]);
		expect(session.hasPendingAsyncWork()).toBe(false);
		expect(primaryMock.calls).toHaveLength(0);
	});

	it("rolls back a switch before replaying fenced running, queued, receipt, and oversized async work", async () => {
		const tempDir = TempDir.createSync("@pi-switch-async-rollback-");
		tempDirs.push(tempDir);
		const primaryMock = createMockModel({ handler: () => ({ content: ["primary reply"] }) });
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		const { session, sessionManager } = buildSession(tempDir, {
			streamFn: primaryMock.stream,
			asyncJobManager: asyncManager,
		});
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = sessionManager.getSessionFile();
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedArtifactManager = sessionManager.getArtifactManager();
		if (!retainedArtifactManager) throw new Error("Expected retained artifact manager");

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendModelChange(`${model.provider}/${model.id}`);
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		const targetArtifactsDir = targetManager.getArtifactsDir();
		if (!targetSessionFile || !targetArtifactsDir) throw new Error("Expected target session paths");
		await targetManager.close();

		let receiptResolutions = 0;
		let receiptRejections = 0;
		let queuedReceipt: Promise<void> | undefined;
		const beginYieldTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
		vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
			if (kind === "async-result" && !queuedReceipt) {
				queuedReceipt = session.yieldQueue.enqueueWithReceipt<AsyncResultEntry>("async-result", {
					jobId: "retained-queued-receipt",
					result: "retained queued delivery",
					job: undefined,
					durationMs: 0,
					epoch: 0,
				});
				void queuedReceipt.then(
					() => receiptResolutions++,
					() => receiptRejections++,
				);
			}
			return beginYieldTransaction(kind);
		});

		const jobGate = Promise.withResolvers<string>();
		const oversized = `retained oversized output\n${"y".repeat(ASYNC_INLINE_RESULT_MAX_CHARS + 1)}`;
		const jobId = asyncManager.register("task", "retained oversized job", () => jobGate.promise, {
			id: "retained-running-job",
			ownerId: "Main",
		});
		const loadStarted = Promise.withResolvers<void>();
		const continueLoad = Promise.withResolvers<void>();
		const setSessionFile = sessionManager.setSessionFile.bind(sessionManager);
		vi.spyOn(sessionManager, "setSessionFile").mockImplementation(async sessionFile => {
			loadStarted.resolve();
			await continueLoad.promise;
			return setSessionFile(sessionFile);
		});
		const failure = new Error("target model lookup failed");
		vi.spyOn(modelRegistry, "getAvailable").mockImplementationOnce(() => {
			throw failure;
		});

		const switching = session.switchSession(targetSessionFile);
		await loadStarted.promise;
		jobGate.resolve(oversized);
		await asyncManager.waitForOwnerJobs("Main");
		await asyncManager.drainDeliveries({ filter: { ownerId: "Main" } });
		expect(await retainedArtifactManager.listFiles()).toEqual([]);
		continueLoad.resolve();
		await expect(switching).rejects.toBe(failure);
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(asyncManager.getJob(jobId)?.status).toBe("completed");

		await session.settleAsyncWork();
		expect(queuedReceipt).toBeDefined();
		await expect(queuedReceipt!).resolves.toBeUndefined();
		expect(receiptResolutions).toBe(1);
		expect(receiptRejections).toBe(0);
		const retainedArtifactFiles = await retainedArtifactManager.listFiles();
		expect(retainedArtifactFiles).toHaveLength(1);
		expect(await Bun.file(path.join(retainedArtifactManager.dir, retainedArtifactFiles[0]!)).text()).toBe(oversized);
		await expect(fs.stat(targetArtifactsDir)).rejects.toMatchObject({ code: "ENOENT" });
		expect(session.hasPendingAsyncWork()).toBe(false);
	});

	for (const transition of ["newSession", "fork"] as const) {
		it(`rolls back ${transition} readiness failure before replaying retained owner work exactly once`, async () => {
			const tempDir = TempDir.createSync(`@pi-${transition}-async-rollback-`);
			tempDirs.push(tempDir);
			const primaryMock = createMockModel({ handler: () => ({ content: ["primary reply"] }) });
			const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
			const { session, sessionManager, extensionRunner } = buildSession(tempDir, {
				streamFn: primaryMock.stream,
				asyncJobManager: asyncManager,
			});
			sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			await sessionManager.ensureOnDisk();
			await sessionManager.flush();
			const retainedSessionFile = session.sessionFile;
			if (!retainedSessionFile) throw new Error("Expected retained session file");

			let receiptResolutions = 0;
			let receiptRejections = 0;
			let queuedReceipt: Promise<void> | undefined;
			const queuedMarker = `${transition} retained queued receipt`;
			const beginYieldTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
			vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
				if (kind === "async-result" && !queuedReceipt) {
					queuedReceipt = session.yieldQueue.enqueueWithReceipt<AsyncResultEntry>("async-result", {
						jobId: `${transition}-retained-queued-receipt`,
						result: queuedMarker,
						job: undefined,
						durationMs: 0,
						epoch: 0,
					});
					void queuedReceipt.then(
						() => receiptResolutions++,
						() => receiptRejections++,
					);
				}
				return beginYieldTransaction(kind);
			});

			const jobGate = Promise.withResolvers<string>();
			const jobMarker = `${transition} retained deferred owner job`;
			const jobId = asyncManager.register("task", `${transition} retained job`, () => jobGate.promise, {
				id: `${transition}-retained-running-job`,
				ownerId: "Main",
			});
			const failure = new Error(`${transition} readiness failed`);
			const rollbackPublicationFailure = new Error(`${transition} rollback publication failed`);
			let rollbackObservation:
				| {
						sessionFile: string | undefined;
						messages: AgentMessage[];
						providerCalls: number;
						receiptResolutions: number;
						receiptRejections: number;
				  }
				| undefined;
			const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
			vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
				async (event, finalizeBeforeHostCompletion) => {
					if (event.type === "session_ready") {
						jobGate.resolve(jobMarker);
						await asyncManager.waitForOwnerJobs("Main");
						await asyncManager.drainDeliveries({ filter: { ownerId: "Main" } });
						throw failure;
					}
					if (event.type === "session_rollback") {
						rollbackObservation = {
							messages: [...session.messages],
							sessionFile: session.sessionFile,
							providerCalls: primaryMock.calls.length,
							receiptResolutions,
							receiptRejections,
						};
						throw rollbackPublicationFailure;
					}
					return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
				},
			);

			const result = transition === "newSession" ? session.newSession() : session.fork();
			let transitionError: unknown;
			try {
				await result;
			} catch (error) {
				transitionError = error;
			}
			expect(transitionError).toBeInstanceOf(AggregateError);
			expect((transitionError as AggregateError).errors).toEqual([failure, rollbackPublicationFailure]);
			expect(rollbackObservation).toEqual({
				sessionFile: retainedSessionFile,
				messages: [{ role: "user", content: "retained", timestamp: 1 }],
				providerCalls: 0,
				receiptResolutions: 0,
				receiptRejections: 0,
			});
			expect(asyncManager.getJob(jobId)?.status).toBe("completed");

			await session.settleAsyncWork();
			expect(queuedReceipt).toBeDefined();
			await expect(queuedReceipt!).resolves.toBeUndefined();
			expect(receiptResolutions).toBe(1);
			expect(receiptRejections).toBe(0);
			const countDelivered = (marker: string): number =>
				primaryMock.calls.reduce(
					(count, call) => count + JSON.stringify(call.context.messages).split(marker).length - 1,
					0,
				);
			expect(countDelivered(jobMarker)).toBe(0);
			expect(countDelivered(queuedMarker)).toBe(0);
			const countPersisted = (marker: string): number =>
				session.messages.filter(message => JSON.stringify(message).includes(marker)).length;
			expect(countPersisted(jobMarker)).toBe(1);
			expect(countPersisted(queuedMarker)).toBe(1);
			const callsAfterDelivery = primaryMock.calls.length;
			await session.settleAsyncWork();
			expect(primaryMock.calls).toHaveLength(callsAfterDelivery);
			expect(countDelivered(jobMarker)).toBe(0);
			expect(countDelivered(queuedMarker)).toBe(0);
			expect(countPersisted(jobMarker)).toBe(1);
			expect(countPersisted(queuedMarker)).toBe(1);
		});

		it(`commits ${transition} by discarding retained owner work instead of injecting it into the target`, async () => {
			const tempDir = TempDir.createSync(`@pi-${transition}-async-commit-`);
			tempDirs.push(tempDir);
			const primaryMock = createMockModel({ handler: () => ({ content: ["primary reply"] }) });
			const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
			const { session, sessionManager, extensionRunner } = buildSession(tempDir, {
				streamFn: primaryMock.stream,
				asyncJobManager: asyncManager,
			});
			sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			await sessionManager.ensureOnDisk();
			await sessionManager.flush();

			let receiptRejections = 0;
			let queuedReceipt: Promise<void> | undefined;
			const queuedMarker = `${transition} discarded queued receipt`;
			const beginYieldTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
			vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
				if (kind === "async-result" && !queuedReceipt) {
					queuedReceipt = session.yieldQueue.enqueueWithReceipt<AsyncResultEntry>("async-result", {
						jobId: `${transition}-discarded-queued-receipt`,
						result: queuedMarker,
						job: undefined,
						durationMs: 0,
						epoch: 0,
					});
					void queuedReceipt.catch(() => receiptRejections++);
				}
				return beginYieldTransaction(kind);
			});

			const jobGate = Promise.withResolvers<string>();
			const jobMarker = `${transition} discarded deferred owner job`;
			const jobId = asyncManager.register("task", `${transition} retained job`, () => jobGate.promise, {
				id: `${transition}-discarded-running-job`,
				ownerId: "Main",
			});
			let snapshotAtPublication: AsyncJobSnapshot | null | undefined;
			const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
			vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
				async (event, finalizeBeforeHostCompletion) => {
					if (event.type !== "session_ready") {
						return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
					}
					jobGate.resolve(jobMarker);
					await asyncManager.waitForOwnerJobs("Main");
					await asyncManager.drainDeliveries({ filter: { ownerId: "Main" } });
					return emitWithHostCompletion(event, async () => {
						const continuation = await finalizeBeforeHostCompletion?.();
						snapshotAtPublication = session.getAsyncJobSnapshot();
						return continuation;
					});
				},
			);

			const result = transition === "newSession" ? session.newSession() : session.fork();
			await expect(result).resolves.toBe(true);
			expect(asyncManager.getJob(jobId)).toBeUndefined();
			expect(queuedReceipt).toBeDefined();
			await expect(queuedReceipt!).rejects.toThrow("Yield queue entry cleared before dispatch");
			expect(receiptRejections).toBe(1);
			expect(session.hasPendingAsyncWork()).toBe(false);
			expect(snapshotAtPublication?.running).toEqual([]);
			expect(snapshotAtPublication?.recent).toEqual([]);
			expect(snapshotAtPublication?.delivery).toMatchObject({ queued: 0, pendingJobIds: [] });

			await session.sendUserMessage("fresh target turn");
			const targetContexts = JSON.stringify(primaryMock.calls.map(call => call.context.messages));
			expect(targetContexts).not.toContain(jobMarker);
			expect(targetContexts).not.toContain(queuedMarker);
		});
	}

	it("does not wait for retained async formatting before publishing a new target", async () => {
		const tempDir = TempDir.createSync("@pi-new-async-format-fence-");
		tempDirs.push(tempDir);
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		const { session, sessionManager, extensionRunner } = buildSession(tempDir, { asyncJobManager: asyncManager });
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		await sessionManager.ensureOnDisk();

		const formattingStarted = Promise.withResolvers<void>();
		const allowFormatting = Promise.withResolvers<void>();
		vi.spyOn(sessionManager, "allocateArtifactPath").mockImplementation(async () => {
			formattingStarted.resolve();
			await allowFormatting.promise;
			return {};
		});
		const jobGate = Promise.withResolvers<string>();
		asyncManager.register("task", "retained formatting job", () => jobGate.promise, {
			id: "retained-formatting-job",
			ownerId: "Main",
		});
		jobGate.resolve("x".repeat(ASYNC_INLINE_RESULT_MAX_CHARS + 1));
		await formattingStarted.promise;

		const readyReached = Promise.withResolvers<void>();
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation((event, finalizeBeforeHostCompletion) => {
			if (event.type === "session_ready") readyReached.resolve();
			return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
		});
		const transition = session.newSession();
		try {
			await readyReached.promise;
			await expect(transition).resolves.toBe(true);
		} finally {
			allowFormatting.resolve();
			await transition.catch(() => undefined);
		}
		await asyncManager.drainDeliveries({ filter: { ownerId: "Main" } });
	});

	it("rolls back switch artifacts after host ACK rejection and reuses their id", async () => {
		const tempDir = TempDir.createSync("@pi-switch-target-artifact-rollback-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = sessionManager.getSessionFile();
		if (!retainedSessionFile) throw new Error("Expected retained session file");

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		const existingArtifactId = await targetManager.saveArtifact("target original", "switch");
		const existingArtifactPath = existingArtifactId
			? await targetManager.getArtifactPath(existingArtifactId)
			: undefined;
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile || !existingArtifactPath) throw new Error("Expected target artifact state");
		const targetRaw = await Bun.file(targetSessionFile).text();
		await targetManager.close();

		const failure = new Error("target host ACK failed after artifact mutation");
		let readyAttempts = 0;
		let rolledBackArtifactId: string | undefined;
		let rolledBackArtifactPath: string | undefined;
		let committedArtifactId: string | undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_ready") {
					readyAttempts++;
					if (readyAttempts === 1) {
						await Bun.write(existingArtifactPath, "target overwrite");
						rolledBackArtifactId = await sessionManager.saveArtifact("target created then rolled back", "switch");
						rolledBackArtifactPath = rolledBackArtifactId
							? ((await sessionManager.getArtifactPath(rolledBackArtifactId)) ?? undefined)
							: undefined;
						sessionManager.appendMessage({ role: "user", content: "target partial append", timestamp: 3 });
						await sessionManager.flush();
						await finalizeBeforeHostCompletion?.();
						throw failure;
					}
					committedArtifactId = await sessionManager.saveArtifact("target committed after retry", "switch");
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		await expect(session.switchSession(targetSessionFile)).rejects.toBe(failure);
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(await Bun.file(targetSessionFile).text()).toBe(targetRaw);
		expect(await Bun.file(existingArtifactPath).text()).toBe("target overwrite");
		expect(rolledBackArtifactPath).toBeString();
		expect(await Bun.file(rolledBackArtifactPath!).exists()).toBe(false);

		await expect(session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(committedArtifactId).toBe(rolledBackArtifactId);
		expect(await Bun.file(rolledBackArtifactPath!).text()).toBe("target committed after retry");
	});

	it("restores prior absence of a target artifact directory after readiness fails", async () => {
		const tempDir = TempDir.createSync("@pi-switch-target-artifact-absence-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		const targetArtifactsDir = targetManager.getArtifactsDir();
		if (!targetSessionFile || !targetArtifactsDir) throw new Error("Expected target session paths");
		const targetRaw = await Bun.file(targetSessionFile).text();
		await targetManager.close();

		const failure = new Error("target readiness failed after first artifact");
		let createdArtifactPath: string | undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_ready") {
					const id = await sessionManager.saveArtifact("target first artifact", "switch");
					createdArtifactPath = id ? ((await sessionManager.getArtifactPath(id)) ?? undefined) : undefined;
					sessionManager.appendMessage({ role: "user", content: "target partial append", timestamp: 3 });
					await sessionManager.flush();
					throw failure;
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		await expect(session.switchSession(targetSessionFile)).rejects.toBe(failure);
		expect(await Bun.file(targetSessionFile).text()).toBe(targetRaw);
		expect(createdArtifactPath).toBeString();
		expect(await Bun.file(createdArtifactPath!).exists()).toBe(false);
		await expect(fs.stat(targetArtifactsDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("releases async and artifact fences and suppresses rollback publication when target restoration also fails", async () => {
		const tempDir = TempDir.createSync("@pi-switch-secondary-rollback-failure-");
		tempDirs.push(tempDir);
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		const { session, sessionManager, extensionRunner } = buildSession(tempDir, { asyncJobManager: asyncManager });
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedRaw = await Bun.file(retainedSessionFile).text();
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const retainedAgentMessages = [...session.agent.state.messages];

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		await targetManager.close();

		const readyFailure = new Error("target readiness failed");
		const targetRestoreFailure = new Error("target persisted restore failed");
		let readyAttempts = 0;
		let createdTargetArtifactPath: string | undefined;
		let rollbackRuntime: { sessionFile: string | undefined; messages: AgentMessage[] } | undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_ready") {
					readyAttempts++;
					if (readyAttempts === 1) {
						const artifactId = await sessionManager.saveArtifact("target artifact", "switch");
						createdTargetArtifactPath = artifactId
							? ((await sessionManager.getArtifactPath(artifactId)) ?? undefined)
							: undefined;
						throw readyFailure;
					}
				}
				if (event.type === "session_rollback") {
					rollbackRuntime = {
						sessionFile: session.sessionFile,
						messages: [...session.agent.state.messages],
					};
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);
		vi.spyOn(sessionManager, "restorePersistedSessionFile").mockImplementationOnce(async () => {
			throw targetRestoreFailure;
		});

		let firstError: unknown;
		try {
			await session.switchSession(targetSessionFile);
		} catch (error) {
			firstError = error;
		}

		expect(firstError).toBeInstanceOf(AggregateError);
		expect((firstError as AggregateError).errors).toEqual([readyFailure, targetRestoreFailure]);
		expect(rollbackRuntime).toBeUndefined();
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(session.agent.state.messages).toEqual(retainedAgentMessages);
		expect(await Bun.file(retainedSessionFile).text()).toBe(retainedRaw);
		expect(createdTargetArtifactPath).toBeString();
		expect(await Bun.file(createdTargetArtifactPath!).exists()).toBe(false);

		await expect(session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(readyAttempts).toBe(2);
	});

	it("suppresses rollback publication when target journal preimage restoration returns false", async () => {
		const tempDir = TempDir.createSync("@pi-switch-false-target-restore-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedRaw = await Bun.file(retainedSessionFile).text();

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		await targetManager.close();

		const readyFailure = new Error("target readiness failed after mutation");
		let readyAttempts = 0;
		const published: string[] = [];
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_ready") {
					readyAttempts++;
					if (readyAttempts === 1) {
						sessionManager.appendMessage({ role: "user", content: "unrestored target mutation", timestamp: 3 });
						await sessionManager.flush();
						throw readyFailure;
					}
				}
				const result = await emitWithHostCompletion(event, finalizeBeforeHostCompletion);
				published.push(event.type);
				return result;
			},
		);
		vi.spyOn(sessionManager, "restorePersistedSessionFile").mockResolvedValueOnce(false);

		let failure: unknown;
		try {
			await session.switchSession(targetSessionFile);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors[0]).toBe(readyFailure);
		expect((failure as AggregateError).errors[1]).toEqual(
			expect.objectContaining({ message: "Target session journal preimage could not be restored" }),
		);
		expect(published).toEqual([]);
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(await Bun.file(retainedSessionFile).text()).toBe(retainedRaw);
		await expect(session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(published).toEqual(["session_ready"]);
	});

	for (const transition of ["branch", "tree"] as const) {
		it(`rolls back ${transition} before replaying retained running work and its queued receipt once`, async () => {
			const tempDir = TempDir.createSync(`@pi-${transition}-async-rollback-`);
			tempDirs.push(tempDir);
			const primaryMock = createMockModel({ handler: () => ({ content: ["primary reply"] }) });
			const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
			const { session, sessionManager, extensionRunner } = buildSession(tempDir, {
				streamFn: primaryMock.stream,
				asyncJobManager: asyncManager,
			});
			const rootEntryId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			sessionManager.appendMessage(assistantMsg("reply"));
			sessionManager.appendMessage({ role: "user", content: "retained leaf", timestamp: 2 });
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			await sessionManager.ensureOnDisk();
			await sessionManager.flush();

			let receiptResolutions = 0;
			let receiptRejections = 0;
			let queuedReceipt: Promise<void> | undefined;
			const queuedMarker = `${transition} retained queued receipt`;
			const beginYieldTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
			vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
				if (kind === "async-result" && !queuedReceipt) {
					queuedReceipt = session.yieldQueue.enqueueWithReceipt<AsyncResultEntry>("async-result", {
						jobId: `${transition}-retained-queued-receipt`,
						result: queuedMarker,
						job: undefined,
						durationMs: 0,
						epoch: 0,
					});
					void queuedReceipt.then(
						() => receiptResolutions++,
						() => receiptRejections++,
					);
				}
				return beginYieldTransaction(kind);
			});

			const jobGate = Promise.withResolvers<string>();
			const jobMarker = `${transition} retained deferred owner job`;
			const jobId = asyncManager.register("task", `${transition} retained job`, () => jobGate.promise, {
				id: `${transition}-retained-running-job`,
				ownerId: "Main",
			});
			const transitionEvent = transition === "branch" ? "session_branch" : "session_tree";
			if (transition === "tree") {
				vi.spyOn(extensionRunner, "hasHandlers").mockImplementation(eventType => eventType === "session_tree");
			}
			const beforeMutation = extensionRunner.emitBeforeSessionMutation.bind(extensionRunner);
			vi.spyOn(extensionRunner, "emitBeforeSessionMutation").mockImplementation(async event => {
				if (event.type === transitionEvent) {
					jobGate.resolve(jobMarker);
					await asyncManager.waitForOwnerJobs("Main");
					await asyncManager.drainDeliveries({ filter: { ownerId: "Main" } });
				}
				return beforeMutation(event);
			});
			const failure = new Error(`${transition} lifecycle fan-out failed`);
			const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
			vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
				async (event, finalizeBeforeHostCompletion) => {
					if (event.type === transitionEvent) throw failure;
					return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
				},
			);

			const result = transition === "branch" ? session.branch(rootEntryId) : session.navigateTree(rootEntryId);
			await expect(result).rejects.toBe(failure);
			expect(asyncManager.getJob(jobId)?.status).toBe("completed");
			await session.settleAsyncWork();
			expect(queuedReceipt).toBeDefined();
			await expect(queuedReceipt!).resolves.toBeUndefined();
			expect(receiptResolutions).toBe(1);
			expect(receiptRejections).toBe(0);
			const countDelivered = (marker: string): number =>
				primaryMock.calls.reduce(
					(count, call) => count + JSON.stringify(call.context.messages).split(marker).length - 1,
					0,
				);
			expect(countDelivered(jobMarker)).toBe(0);
			expect(countDelivered(queuedMarker)).toBe(0);
			const countPersisted = (marker: string): number =>
				session.messages.filter(message => JSON.stringify(message).includes(marker)).length;
			expect(countPersisted(jobMarker)).toBe(1);
			expect(countPersisted(queuedMarker)).toBe(1);
			const callsAfterDelivery = primaryMock.calls.length;
			await session.settleAsyncWork();
			expect(primaryMock.calls).toHaveLength(callsAfterDelivery);
			expect(countDelivered(jobMarker)).toBe(0);
			expect(countDelivered(queuedMarker)).toBe(0);
			expect(countPersisted(jobMarker)).toBe(1);
			expect(countPersisted(queuedMarker)).toBe(1);
		});

		it(`commits ${transition} by discarding retained running work and its queued receipt`, async () => {
			const tempDir = TempDir.createSync(`@pi-${transition}-async-commit-`);
			tempDirs.push(tempDir);
			const primaryMock = createMockModel({ handler: () => ({ content: ["primary reply"] }) });
			const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
			const { session, sessionManager, extensionRunner } = buildSession(tempDir, {
				streamFn: primaryMock.stream,
				asyncJobManager: asyncManager,
			});
			const rootEntryId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
			sessionManager.appendMessage(assistantMsg("reply"));
			sessionManager.appendMessage({ role: "user", content: "retained leaf", timestamp: 2 });
			session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
			await sessionManager.ensureOnDisk();
			await sessionManager.flush();

			let receiptRejections = 0;
			let queuedReceipt: Promise<void> | undefined;
			const queuedMarker = `${transition} discarded queued receipt`;
			const beginYieldTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
			vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
				if (kind === "async-result" && !queuedReceipt) {
					queuedReceipt = session.yieldQueue.enqueueWithReceipt<AsyncResultEntry>("async-result", {
						jobId: `${transition}-discarded-queued-receipt`,
						result: queuedMarker,
						job: undefined,
						durationMs: 0,
						epoch: 0,
					});
					void queuedReceipt.catch(() => receiptRejections++);
				}
				return beginYieldTransaction(kind);
			});

			const jobGate = Promise.withResolvers<string>();
			const jobMarker = `${transition} discarded deferred owner job`;
			const jobId = asyncManager.register("task", `${transition} retained job`, () => jobGate.promise, {
				id: `${transition}-discarded-running-job`,
				ownerId: "Main",
			});
			const transitionEvent = transition === "branch" ? "session_branch" : "session_tree";
			if (transition === "tree") {
				vi.spyOn(extensionRunner, "hasHandlers").mockImplementation(eventType => eventType === "session_tree");
			}
			const beforeMutation = extensionRunner.emitBeforeSessionMutation.bind(extensionRunner);
			vi.spyOn(extensionRunner, "emitBeforeSessionMutation").mockImplementation(async event => {
				if (event.type === transitionEvent) {
					jobGate.resolve(jobMarker);
					await asyncManager.waitForOwnerJobs("Main");
					await asyncManager.drainDeliveries({ filter: { ownerId: "Main" } });
				}
				return beforeMutation(event);
			});

			const result = transition === "branch" ? session.branch(rootEntryId) : session.navigateTree(rootEntryId);
			await expect(result).resolves.toMatchObject({ cancelled: false });
			expect(asyncManager.getJob(jobId)).toBeUndefined();
			expect(queuedReceipt).toBeDefined();
			await expect(queuedReceipt!).rejects.toThrow("Yield queue entry cleared before dispatch");
			expect(receiptRejections).toBe(1);
			expect(session.hasPendingAsyncWork()).toBe(false);

			await session.sendUserMessage("fresh target turn");
			const targetContexts = JSON.stringify(primaryMock.calls.map(call => call.context.messages));
			expect(targetContexts).not.toContain(jobMarker);
			expect(targetContexts).not.toContain(queuedMarker);
		});
	}

	it("quiesces a root branch before identity mutation and publishes only after target messages are active", async () => {
		const tempDir = TempDir.createSync("@pi-branch-lifecycle-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		const rootEntryId = sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("reply"));
		const oldLeafId = sessionManager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		await sessionManager.ensureOnDisk();
		const previousSessionFile = session.sessionFile;
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const observed: Array<{
			phase: "before" | "complete";
			sessionFile?: string;
			leafId: string | null;
			messages: number;
		}> = [];
		const beforeMutation = extensionRunner.emitBeforeSessionMutation.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitBeforeSessionMutation").mockImplementation(event => {
			if (event.type === "session_branch") {
				observed.push({
					phase: "before",
					sessionFile: session.sessionFile,
					leafId: sessionManager.getLeafId(),
					messages: session.messages.length,
				});
			}
			return beforeMutation(event);
		});
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation((event, finalizeBeforeHostCompletion) => {
			if (event.type === "session_branch") {
				observed.push({
					phase: "complete",
					sessionFile: session.sessionFile,
					leafId: sessionManager.getLeafId(),
					messages: session.messages.length,
				});
			}
			return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
		});

		await expect(session.branch(rootEntryId)).resolves.toMatchObject({ cancelled: false });
		expect(observed).toEqual([
			{ phase: "before", sessionFile: previousSessionFile, leafId: oldLeafId, messages: 3 },
			{ phase: "complete", sessionFile: session.sessionFile, leafId: null, messages: 0 },
		]);
		expect(session.sessionFile).not.toBe(previousSessionFile);
		expect(session.messages).toHaveLength(0);
	});

	it("rolls back a root branch whose target journal cannot materialize without publishing the branch", async () => {
		const tempDir = TempDir.createSync("@pi-root-branch-materialization-rollback-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		const rootEntryId = sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("reply"));
		const retainedLeafId = sessionManager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedJournal = await Bun.file(retainedSessionFile).text();
		const retainedMessages = [...session.messages];
		const failure = new Error("root branch target materialization failed");
		let replacementSessionFile: string | undefined;
		const ensureOnDisk = sessionManager.ensureOnDisk.bind(sessionManager);
		vi.spyOn(sessionManager, "ensureOnDisk").mockImplementation(async () => {
			if (session.sessionFile !== retainedSessionFile) {
				replacementSessionFile = session.sessionFile;
				throw failure;
			}
			await ensureOnDisk();
		});
		let rollbackAtPublication:
			| { sessionFile?: string; leafId: string | null; messages: AgentMessage[]; raw: string }
			| undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_rollback") {
					rollbackAtPublication = {
						sessionFile: session.sessionFile,
						leafId: sessionManager.getLeafId(),
						messages: [...session.messages],
						raw: await Bun.file(retainedSessionFile).text(),
					};
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		await expect(session.branch(rootEntryId)).rejects.toBe(failure);

		expect(rollbackAtPublication).toEqual({
			sessionFile: retainedSessionFile,
			leafId: retainedLeafId,
			messages: retainedMessages,
			raw: retainedJournal,
		});
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(sessionManager.getLeafId()).toBe(retainedLeafId);
		expect(session.messages).toEqual(retainedMessages);
		expect(await Bun.file(retainedSessionFile).text()).toBe(retainedJournal);
		expect(replacementSessionFile).toBeString();
		expect(await Bun.file(replacementSessionFile!).exists()).toBe(false);
	});

	it("publishes retained rollback when tree artifact acquisition fails after the host fence", async () => {
		const tempDir = TempDir.createSync("@pi-tree-artifact-acquisition-rollback-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		const rootEntryId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("reply"));
		const retainedLeafId = sessionManager.appendMessage({ role: "user", content: "retained leaf", timestamp: 2 });
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedEntries = structuredClone(sessionManager.getEntries());
		const retainedMessages = [...session.messages];
		const retainedRaw = await Bun.file(retainedSessionFile).text();
		const phases: string[] = [];
		const beforeMutation = extensionRunner.emitBeforeSessionMutation.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitBeforeSessionMutation").mockImplementation(async event => {
			if (event.type === "session_tree") phases.push("fence");
			return beforeMutation(event);
		});
		const failure = new Error("tree artifact acquisition failed after host fence");
		vi.spyOn(sessionManager, "beginArtifactTransaction").mockRejectedValueOnce(failure);
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_tree") phases.push("tree");
				if (event.type === "session_rollback") phases.push("rollback");
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		await expect(session.navigateTree(rootEntryId)).rejects.toBe(failure);

		expect(phases).toEqual(["fence", "rollback"]);
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(sessionManager.getLeafId()).toBe(retainedLeafId);
		expect(sessionManager.getEntries()).toEqual(retainedEntries);
		expect(session.messages).toEqual(retainedMessages);
		expect(await Bun.file(retainedSessionFile).text()).toBe(retainedRaw);
		await expect(session.navigateTree(rootEntryId)).resolves.toMatchObject({ cancelled: false });
	});

	it("restores advisor work and receipts before a post-fence branch rollback is published", async () => {
		const tempDir = TempDir.createSync("@pi-branch-lifecycle-rollback-");
		tempDirs.push(tempDir);
		const primaryMock = createMockModel({ handler: () => ({ content: ["primary reply"] }) });
		const pendingAdvisor = createPendingAdvisorWork("resumed branch advisor work");
		const { session, sessionManager, extensionRunner } = buildSession(tempDir, {
			streamFn: primaryMock.stream,
			advisorStreamFn: pendingAdvisor.mock.stream,
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.toggleAdvisorEnabled()).toBe(true);
		const rootEntryId = sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("reply"));
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await session.prompt("second");
		await pendingAdvisor.firstStarted;
		expect(pendingAdvisor.mock.calls).toHaveLength(1);
		const oldLeafId = sessionManager.getLeafId();
		if (!oldLeafId) throw new Error("Expected retained branch leaf");
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const checkpoint = {
			checkpointMessageCount: session.messages.length,
			checkpointEntryId: oldLeafId,
			startedAt: "retained",
		};
		session.setCheckpointState(checkpoint);
		const retainedAdvisorCard: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "retained branch advisor card",
			display: true,
			attribution: "agent",
			timestamp: 3,
		};
		session.agent.replaceQueues([retainedAdvisorCard], []);
		let receiptSettled = false;
		let receipt: Promise<void> | undefined;
		const beginTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
		vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
			if (kind === "advisor" && !receipt) {
				receipt = session.yieldQueue.enqueueWithReceipt("advisor", {
					note: "retained branch yield",
					severity: "nit" as const,
					advisor: undefined,
				});
				void receipt.then(
					() => {
						receiptSettled = true;
					},
					() => {},
				);
			}
			return beginTransaction(kind);
		});
		const advisorReset = vi.spyOn(SessionAdvisors.prototype, "resetSessionState");
		const retainedAdvisorResetCalls = advisorReset.mock.calls.length;
		const retainedEntries = sessionManager.getEntries().map(entry => entry.id);
		const retainedMessages = [...session.messages];
		const retainedAdvisorStats = stableAdvisorStats(session.getAdvisorStats());
		const firstAdvisorTail = pendingAdvisor.mock.calls[0]?.context.messages.at(-1);
		const retainedAdvisorPrompt = firstAdvisorTail?.role === "user" ? firstAdvisorTail.content : undefined;
		const retainedRaw = await Bun.file(retainedSessionFile).text();

		const phases: string[] = [];
		let replacementSessionFile: string | undefined;
		let rollbackAtDispatch:
			| {
					sessionFile?: string;
					leafId: string | null;
					entries: string[];
					messages: AgentMessage[];
					raw: string;
					steering: AgentMessage[];
					checkpoint: unknown;
					advisorStats: StableAdvisorStats;
					advisorYieldQueued: boolean;
					receiptSettled: boolean;
					advisorResetCalls: number;
					advisorCalls: number;
					advisorPrompt: unknown;
			  }
			| undefined;
		const beforeMutation = extensionRunner.emitBeforeSessionMutation.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitBeforeSessionMutation").mockImplementation(event => {
			if (event.type === "session_branch") phases.push("fence");
			return beforeMutation(event);
		});
		const failure = new Error("branch event fan-out failed");
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_branch") {
					phases.push("branch");
					expect(session.yieldQueue.has("advisor")).toBe(false);
					expect(session.agent.peekSteeringQueue()).toEqual([]);
					replacementSessionFile = session.sessionFile;
					sessionManager.appendMessage({ role: "user", content: "partial branch handler", timestamp: 4 });
					throw failure;
				}
				if (event.type === "session_rollback") {
					phases.push("rollback");
					rollbackAtDispatch = {
						sessionFile: session.sessionFile,
						leafId: sessionManager.getLeafId(),
						entries: sessionManager.getEntries().map(entry => entry.id),
						messages: [...session.messages],
						raw: await Bun.file(retainedSessionFile).text(),
						steering: [...session.agent.peekSteeringQueue()],
						checkpoint: session.getCheckpointState(),
						advisorStats: stableAdvisorStats(session.getAdvisorStats()),
						advisorYieldQueued: session.yieldQueue.has("advisor"),
						receiptSettled,
						advisorResetCalls: advisorReset.mock.calls.length,
						advisorCalls: pendingAdvisor.mock.calls.length,
						advisorPrompt: retainedAdvisorPrompt,
					};
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		await expect(session.branch(rootEntryId)).rejects.toBe(failure);

		expect(phases).toEqual(["fence", "branch", "rollback"]);
		expect(rollbackAtDispatch).toEqual({
			sessionFile: retainedSessionFile,
			leafId: oldLeafId,
			entries: retainedEntries,
			messages: retainedMessages,
			raw: retainedRaw,
			steering: [retainedAdvisorCard],
			checkpoint,
			advisorStats: retainedAdvisorStats,
			advisorYieldQueued: true,
			receiptSettled: false,
			advisorResetCalls: retainedAdvisorResetCalls,
			advisorCalls: 1,
			advisorPrompt: retainedAdvisorPrompt,
		});
		expect(receiptSettled).toBe(false);
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(sessionManager.getLeafId()).toBe(oldLeafId);
		expect(sessionManager.getEntries().map(entry => entry.id)).toEqual(retainedEntries);
		expect(session.messages).toEqual(retainedMessages);
		expect(replacementSessionFile).toBeString();
		expect(replacementSessionFile).not.toBe(retainedSessionFile);
		expect(await Bun.file(replacementSessionFile!).exists()).toBe(false);

		pendingAdvisor.release.resolve();
		await pendingAdvisor.resumed;
		await expect(receipt!).resolves.toBeUndefined();
		expect(receiptSettled).toBe(true);
	});

	it("quiesces root tree navigation before leaf mutation and publishes only after target context is active", async () => {
		const tempDir = TempDir.createSync("@pi-tree-lifecycle-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		const rootEntryId = sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("reply"));
		const oldLeafId = sessionManager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const sessionFile = session.sessionFile;
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		vi.spyOn(extensionRunner, "hasHandlers").mockImplementation(eventType => eventType === "session_tree");
		const observed: Array<{ phase: "before" | "complete"; leafId: string | null; messages: number }> = [];
		const beforeMutation = extensionRunner.emitBeforeSessionMutation.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitBeforeSessionMutation").mockImplementation(event => {
			if (event.type === "session_tree") {
				observed.push({ phase: "before", leafId: sessionManager.getLeafId(), messages: session.messages.length });
			}
			return beforeMutation(event);
		});
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation((event, finalizeBeforeHostCompletion) => {
			if (event.type === "session_tree") {
				observed.push({ phase: "complete", leafId: sessionManager.getLeafId(), messages: session.messages.length });
			}
			return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
		});

		await expect(session.navigateTree(rootEntryId)).resolves.toMatchObject({ cancelled: false });
		expect(observed).toEqual([
			{ phase: "before", leafId: oldLeafId, messages: 3 },
			{ phase: "complete", leafId: null, messages: 0 },
		]);
		expect(session.sessionFile).toBe(sessionFile);
		expect(session.messages).toHaveLength(0);
	});

	it("restores tree state and artifact allocation after host ACK rejection", async () => {
		const tempDir = TempDir.createSync("@pi-tree-lifecycle-rollback-");
		tempDirs.push(tempDir);
		const primaryMock = createMockModel({ handler: () => ({ content: ["primary reply"] }) });
		const pendingAdvisor = createPendingAdvisorWork("resumed tree advisor work");
		const { session, sessionManager, extensionRunner } = buildSession(tempDir, {
			streamFn: primaryMock.stream,
			advisorStreamFn: pendingAdvisor.mock.stream,
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.toggleAdvisorEnabled()).toBe(true);
		const rootEntryId = sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("reply"));
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await session.prompt("retained active turn");
		await pendingAdvisor.firstStarted;
		expect(pendingAdvisor.mock.calls).toHaveLength(1);
		const retainedLeafId = sessionManager.getLeafId();
		if (!retainedLeafId) throw new Error("Expected retained tree leaf");
		sessionManager.appendMessageToBranch({ role: "user", content: "inactive tail", timestamp: 2 }, retainedLeafId);
		sessionManager.branch(retainedLeafId);
		const retainedWorkspace = path.join(tempDir.path(), "retained-workspace");
		const rolledBackWorkspace = path.join(tempDir.path(), "rolled-back-workspace");
		await sessionManager.setSessionName("retained title", "user");
		await sessionManager.addWorkspaceDirectory(retainedWorkspace);
		const retainedArtifactId = await sessionManager.saveArtifact("retained artifact", "tree");
		if (!retainedArtifactId) throw new Error("Expected retained artifact id");
		const retainedArtifactPath = await sessionManager.getArtifactPath(retainedArtifactId);
		if (!retainedArtifactPath) throw new Error("Expected retained artifact path");
		const artifactManager = sessionManager.getArtifactManager();
		if (!artifactManager) throw new Error("Expected persistent artifact manager");
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedLeafAtFence = sessionManager.getLeafId();
		if (!retainedLeafAtFence) throw new Error("Expected retained leaf at tree fence");
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const checkpoint = {
			checkpointMessageCount: session.messages.length,
			checkpointEntryId: retainedLeafId,
			startedAt: "retained",
		};
		session.setCheckpointState(checkpoint);
		const retainedAdvisorCard: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "retained tree advisor card",
			display: true,
			attribution: "agent",
			timestamp: 3,
		};
		session.agent.replaceQueues([retainedAdvisorCard], []);
		let receiptSettled = false;
		const advisorReset = vi.spyOn(SessionAdvisors.prototype, "resetSessionState");
		const retainedAdvisorResetCalls = advisorReset.mock.calls.length;
		const retainedEntries = sessionManager.getEntries().map(entry => entry.id);
		const retainedHeader = structuredClone(sessionManager.getHeader());
		const retainedEntryState = structuredClone(sessionManager.getEntries());
		const retainedArtifactFiles = (await artifactManager.listFiles()).sort();
		const retainedMessages = [...session.messages];
		const retainedAdvisorStats = stableAdvisorStats(session.getAdvisorStats());
		const firstAdvisorTail = pendingAdvisor.mock.calls[0]?.context.messages.at(-1);
		const retainedAdvisorPrompt = firstAdvisorTail?.role === "user" ? firstAdvisorTail.content : undefined;
		const retainedRaw = await Bun.file(retainedSessionFile).text();

		vi.spyOn(extensionRunner, "hasHandlers").mockImplementation(eventType => eventType === "session_tree");
		const phases: string[] = [];
		let partialEntryId: string | undefined;
		let rolledBackArtifactId: string | undefined;
		let rolledBackArtifactPath: string | undefined;
		let rollbackAtDispatch:
			| {
					sessionFile?: string;
					leafId: string | null;
					entries: string[];
					header: unknown;
					entryState: unknown;
					sessionName: string | undefined;
					workspace: string[];
					artifactFiles: string[];
					retainedArtifactContent: string;
					rolledBackArtifactExists: boolean;
					messages: AgentMessage[];
					raw: string;
					steering: AgentMessage[];
					checkpoint: unknown;
					advisorStats: StableAdvisorStats;
					advisorYieldQueued: boolean;
					receiptSettled: boolean;
					advisorResetCalls: number;
					advisorCalls: number;
					advisorPrompt: unknown;
			  }
			| undefined;
		const beforeMutation = extensionRunner.emitBeforeSessionMutation.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitBeforeSessionMutation").mockImplementation(event => {
			if (event.type === "session_tree") phases.push("fence");
			return beforeMutation(event);
		});
		const failure = new Error("tree host ACK failed");
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_tree") {
					phases.push("tree");
					expect(session.yieldQueue.has("advisor")).toBe(false);
					expect(session.agent.peekSteeringQueue()).toEqual([]);
					await sessionManager.setSessionName("rolled back title", "user");
					await sessionManager.addWorkspaceDirectory(rolledBackWorkspace);
					await Bun.write(retainedArtifactPath, "rolled back overwrite");
					rolledBackArtifactId = await sessionManager.saveArtifact("rolled back artifact", "tree");
					if (!rolledBackArtifactId) throw new Error("Expected rolled-back artifact id");
					const createdArtifactPath = await sessionManager.getArtifactPath(rolledBackArtifactId);
					if (!createdArtifactPath) throw new Error("Expected rolled-back artifact path");
					rolledBackArtifactPath = createdArtifactPath;
					partialEntryId = sessionManager.appendMessage({
						role: "user",
						content: "partial tree handler",
						timestamp: 4,
					});
					await finalizeBeforeHostCompletion?.();
					throw failure;
				}
				if (event.type === "session_rollback") {
					phases.push("rollback");
					rollbackAtDispatch = {
						sessionFile: session.sessionFile,
						leafId: sessionManager.getLeafId(),
						entries: sessionManager.getEntries().map(entry => entry.id),
						header: structuredClone(sessionManager.getHeader()),
						entryState: structuredClone(sessionManager.getEntries()),
						sessionName: sessionManager.getSessionName(),
						workspace: sessionManager.getAdditionalDirectories(),
						artifactFiles: (await artifactManager.listFiles()).sort(),
						retainedArtifactContent: await Bun.file(retainedArtifactPath).text(),
						rolledBackArtifactExists: await Bun.file(rolledBackArtifactPath!).exists(),
						messages: [...session.messages],
						raw: await Bun.file(retainedSessionFile).text(),
						steering: [...session.agent.peekSteeringQueue()],
						checkpoint: session.getCheckpointState(),
						advisorStats: stableAdvisorStats(session.getAdvisorStats()),
						advisorYieldQueued: session.yieldQueue.has("advisor"),
						receiptSettled,
						advisorResetCalls: advisorReset.mock.calls.length,
						advisorCalls: pendingAdvisor.mock.calls.length,
						advisorPrompt: retainedAdvisorPrompt,
					};
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		// Queue at the transition boundary. The normal 1 ms idle dispatcher may
		// consume an earlier entry before navigation starts under a loaded runner;
		// this case exercises lifecycle quarantine after the fence is acquired.
		const receipt = session.yieldQueue.enqueueWithReceipt("advisor", {
			note: "retained tree yield",
			severity: "nit" as const,
			advisor: undefined,
		});
		void receipt.then(
			() => {
				receiptSettled = true;
			},
			() => {},
		);
		await expect(session.navigateTree(rootEntryId)).rejects.toBe(failure);

		expect(phases).toEqual(["fence", "tree", "rollback"]);
		expect(rollbackAtDispatch).toEqual({
			sessionFile: retainedSessionFile,
			leafId: retainedLeafAtFence,
			entries: retainedEntries,
			header: retainedHeader,
			entryState: retainedEntryState,
			sessionName: "retained title",
			workspace: [retainedWorkspace],
			artifactFiles: retainedArtifactFiles,
			retainedArtifactContent: "rolled back overwrite",
			rolledBackArtifactExists: false,
			messages: retainedMessages,
			raw: retainedRaw,
			steering: [retainedAdvisorCard],
			checkpoint,
			advisorStats: retainedAdvisorStats,
			advisorYieldQueued: true,
			receiptSettled: false,
			advisorResetCalls: retainedAdvisorResetCalls,
			advisorCalls: 1,
			advisorPrompt: retainedAdvisorPrompt,
		});
		expect(receiptSettled).toBe(false);
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(sessionManager.getLeafId()).toBe(retainedLeafAtFence);
		expect(sessionManager.getEntries().map(entry => entry.id)).toEqual(retainedEntries);
		expect(sessionManager.getHeader()).toEqual(retainedHeader);
		expect(sessionManager.getEntries()).toEqual(retainedEntryState);
		expect(sessionManager.getSessionName()).toBe("retained title");
		expect(sessionManager.getAdditionalDirectories()).toEqual([retainedWorkspace]);
		expect(session.messages).toEqual(retainedMessages);
		expect(partialEntryId).toBeString();
		expect(sessionManager.getEntry(partialEntryId!)).toBeUndefined();
		expect((await artifactManager.listFiles()).sort()).toEqual(retainedArtifactFiles);
		expect(await Bun.file(retainedArtifactPath).text()).toBe("rolled back overwrite");
		expect(rolledBackArtifactPath).toBeString();
		expect(await Bun.file(rolledBackArtifactPath!).exists()).toBe(false);
		const reusedArtifactId = await sessionManager.saveArtifact("committed after rollback", "tree");
		expect(reusedArtifactId).toBe(rolledBackArtifactId);
		expect(await sessionManager.getArtifactPath(reusedArtifactId!)).toBe(rolledBackArtifactPath!);
		expect(await Bun.file(rolledBackArtifactPath!).text()).toBe("committed after rollback");

		pendingAdvisor.release.resolve();
		await pendingAdvisor.resumed;
		await expect(receipt).resolves.toBeUndefined();
		expect(receiptSettled).toBe(true);
	});

	it("rolls back provisional tree artifacts and runtime owners when Bash prepare settlement fails", async () => {
		const tempDir = TempDir.createSync("@pi-tree-bash-prepare-rollback-");
		tempDirs.push(tempDir);
		let retainedPermissionToolExecutions = 0;
		const makeTool = (
			name: string,
			options: { discoverable?: boolean; countPermission?: boolean } = {},
		): AgentTool => ({
			name,
			label: name,
			description: `Retained ${name} probe`,
			parameters: {} as never,
			...(options.discoverable ? { loadMode: "discoverable" as const } : {}),
			execute: async () => {
				if (options.countPermission) retainedPermissionToolExecutions++;
				return { content: [{ type: "text", text: "ok" }] };
			},
		});
		const readTool = makeTool("read");
		const writeTool = makeTool("write");
		const permissionBashTool = makeTool("bash", { countPermission: true });
		const mountedTool = makeTool("retained-mounted", { discoverable: true });
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[writeTool.name, writeTool],
			[permissionBashTool.name, permissionBashTool],
			[mountedTool.name, mountedTool],
		]);
		const xdev: XdevState = {
			tools: toolRegistry,
			mountedNames: new Set(),
			builtInNames: new Set(["read", "write"]),
			isActive: name => session.getEnabledToolNames().includes(name),
		};
		const primaryMock = createMockModel({
			handler: () => ({ content: ["primary reply"] }),
		});
		const pendingAdvisor = createPendingAdvisorWork("resumed artifact-commit advisor work");
		let advisorResumed = false;
		void pendingAdvisor.resumed.then(() => {
			advisorResumed = true;
		});
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		const { session, sessionManager, extensionRunner } = buildSession(tempDir, {
			streamFn: primaryMock.stream,
			advisorStreamFn: pendingAdvisor.mock.stream,
			asyncJobManager: asyncManager,
			tools: [readTool, writeTool, permissionBashTool, mountedTool],
			toolRegistry,
			xdev,
			builtInToolNames: ["read", "write"],
		});
		const resumedAdvisorYieldQueued = Promise.withResolvers<void>();
		const enqueueYield = session.yieldQueue.enqueue.bind(session.yieldQueue);
		vi.spyOn(session.yieldQueue, "enqueue").mockImplementation((kind, entry) => {
			enqueueYield(kind, entry);
			if (
				kind === "advisor" &&
				entry !== null &&
				typeof entry === "object" &&
				"note" in entry &&
				entry.note === "resumed artifact-commit advisor work"
			) {
				resumedAdvisorYieldQueued.resolve();
			}
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const permissionRequests: string[] = [];
		const bridge = {
			capabilities: { requestPermission: true },
			async requestPermission() {
				permissionRequests.push("bash");
				return { outcome: "selected", optionId: "allow_always", kind: "allow_always" };
			},
		} as ClientBridge;
		session.setClientBridge(bridge);
		const retainedPermissionTool = session.agent.state.tools.find(tool => tool.name === "bash");
		if (!retainedPermissionTool) throw new Error("Expected retained permission tool");
		await retainedPermissionTool.execute(
			"retained-permission",
			{ command: "echo retained" },
			undefined,
			undefined as never,
			undefined as never,
		);
		expect(permissionRequests).toEqual(["bash"]);
		await session.setActiveToolPresentation(["read", "write", "bash", "retained-mounted"], ["retained-mounted"]);
		expect(session.getMountedXdevToolNames()).toEqual(["retained-mounted"]);
		expect(session.toggleAdvisorEnabled()).toBe(true);
		const rootEntryId = sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("root reply"));
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await session.prompt("retained active turn");
		await pendingAdvisor.firstStarted;
		const retainedLeafId = sessionManager.getLeafId();
		if (!retainedLeafId) throw new Error("Expected retained tree leaf");
		const retainedArtifactId = await sessionManager.saveArtifact("retained artifact", "tree");
		if (!retainedArtifactId) throw new Error("Expected retained artifact id");
		const retainedArtifactPath = await sessionManager.getArtifactPath(retainedArtifactId);
		if (!retainedArtifactPath) throw new Error("Expected retained artifact path");
		const artifactManager = sessionManager.getArtifactManager();
		if (!artifactManager) throw new Error("Expected persistent artifact manager");
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const checkpoint = {
			checkpointMessageCount: session.messages.length,
			checkpointEntryId: retainedLeafId,
			startedAt: "retained",
		};
		session.setCheckpointState(checkpoint);
		const retainedAdvisorCard: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "retained artifact-commit advisor card",
			display: true,
			attribution: "agent",
			timestamp: 3,
		};
		session.agent.replaceQueues([retainedAdvisorCard], []);
		let advisorReceiptSettled = false;
		let advisorReceipt: Promise<void> | undefined;
		const retainedDirective = "retained tree directive";
		const retainedPreviewInvoker = (input: unknown) => input;
		session.toolChoiceQueue.pushOnce("none", { label: retainedDirective });
		session.toolChoiceQueue.registerPendingInvoker("retained-preview", "bash", retainedPreviewInvoker);
		let retainedCallbacks = 0;
		let targetCallbacks = 0;
		let targetDiscards = 0;
		session.registerSessionChangeCallback(() => retainedCallbacks++);
		const retainedLaunch: DaemonCompletionNotification = {
			event: "daemon-completed",
			completionId: "retained-tree-prepare-launch",
			owner: sessionManager.getSessionId(),
			daemon: {
				name: "retained-tree-daemon",
				id: "retained-tree-daemon-id",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner: sessionManager.getSessionId(),
				persist: false,
				detached: false,
			},
		};
		let launchReceipt: Promise<void> | undefined;
		const retainedRaw = await Bun.file(retainedSessionFile).text();
		const retainedArtifactFiles = (await artifactManager.listFiles())
			.filter(file => !file.includes("advisor"))
			.sort();

		const bashStarted = Promise.withResolvers<void>();
		const bashGate = Promise.withResolvers<void>();
		const bashResult = {
			output: "retained bash output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 20,
			outputLines: 1,
			outputBytes: 20,
		};
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			bashStarted.resolve();
			await bashGate.promise;
			return bashResult;
		});
		const bashPromise = session.executeBash("retained-tree-command");
		await bashStarted.promise;

		let asyncReceiptSettled = false;
		let queuedAsyncReceipt: Promise<void> | undefined;
		const queuedMarker = "artifact commit retained queued receipt";
		const beginYieldTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
		vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
			if (kind === "advisor" && !advisorReceipt) {
				advisorReceipt = session.yieldQueue.enqueueWithReceipt("advisor", {
					note: "retained artifact-commit yield",
					severity: "nit" as const,
					advisor: undefined,
				});
				void advisorReceipt.then(
					() => {
						advisorReceiptSettled = true;
					},
					() => {},
				);
			}
			if (kind === "async-result" && !queuedAsyncReceipt) {
				queuedAsyncReceipt = session.yieldQueue.enqueueWithReceipt<AsyncResultEntry>("async-result", {
					jobId: "artifact-commit-retained-receipt",
					result: queuedMarker,
					job: undefined,
					durationMs: 0,
					epoch: 0,
				});
				void queuedAsyncReceipt.then(
					() => {
						asyncReceiptSettled = true;
					},
					() => {},
				);
			}
			return beginYieldTransaction(kind);
		});
		const asyncJobGate = Promise.withResolvers<string>();
		const asyncMarker = "artifact commit retained deferred job";
		const asyncJobId = asyncManager.register("task", "artifact commit retained job", () => asyncJobGate.promise, {
			id: "artifact-commit-retained-job",
			ownerId: "Main",
		});

		const failure = new Error("tree Bash prepare settlement failed");
		let artifactFinalizeAttempts = 0;
		let artifactRollbackStarted = false;
		let bashSettlementAttempts = 0;
		let treePublished = false;
		let partialEntryId: string | undefined;
		let rolledBackArtifactPath: string | undefined;
		const beginArtifactTransaction = sessionManager.beginArtifactTransaction.bind(sessionManager);
		vi.spyOn(sessionManager, "beginArtifactTransaction").mockImplementation(async () => {
			const transaction = await beginArtifactTransaction();
			return {
				rollback: async () => {
					artifactRollbackStarted = true;
					await transaction.rollback();
				},
				commit: async () => {
					if (!artifactRollbackStarted) artifactFinalizeAttempts++;
					await transaction.commit();
				},
			};
		});
		const awaitSessionTransition = BashRunner.prototype.awaitSessionTransition;
		vi.spyOn(BashRunner.prototype, "awaitSessionTransition").mockImplementation(async function (
			this: BashRunner,
			transition,
		) {
			bashSettlementAttempts++;
			if (bashSettlementAttempts === 1) throw failure;
			await awaitSessionTransition.call(this, transition);
		});
		vi.spyOn(extensionRunner, "hasHandlers").mockImplementation(eventType => eventType === "session_tree");
		const rollbackPublicationStarted = Promise.withResolvers<void>();
		const allowRollbackPublication = Promise.withResolvers<void>();
		let rollbackAtDispatch:
			| {
					published: boolean;
					artifactFinalizeAttempts: number;
					bashSettlementAttempts: number;
					sessionFile: string | undefined;
					raw: string;
					leafId: string | null;
					targetEntryPresent: boolean;
					targetRawPresent: boolean;
					artifactFiles: string[];
					retainedArtifactContent: string;
					rolledBackArtifactExists: boolean;
					directives: readonly string[];
					retainedPreview: boolean;
					activeTools: string[];
					mountedTools: string[];
					targetDiscards: number;
					bashRunning: boolean;
					bashEntryPresent: boolean;
			  }
			| undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_tree") {
					await Bun.write(retainedArtifactPath, "target overwrite");
					const rolledBackArtifactId = await sessionManager.saveArtifact("target artifact", "tree");
					rolledBackArtifactPath = rolledBackArtifactId
						? ((await sessionManager.getArtifactPath(rolledBackArtifactId)) ?? undefined)
						: undefined;
					partialEntryId = sessionManager.appendMessage({
						role: "user",
						content: "target partial append",
						timestamp: 4,
					});
					await sessionManager.flush();
					session.toolChoiceQueue.pushOnce("none", { label: "target tree directive" });
					session.toolChoiceQueue.registerPendingInvoker("target-preview", "bash", input => input);
					session.registerSessionChangeCallback(() => targetCallbacks++, {
						onDiscard: () => targetDiscards++,
					});
					launchReceipt = session.queueLaunchCompletion(retainedLaunch);
					void launchReceipt.catch(() => {});
					asyncJobGate.resolve(asyncMarker);
					await asyncManager.waitForOwnerJobs("Main");
					await asyncManager.drainDeliveries({ filter: { ownerId: "Main" } });
				}
				if (event.type === "session_rollback") {
					const raw = await Bun.file(retainedSessionFile).text();
					rollbackAtDispatch = {
						published: treePublished,
						artifactFinalizeAttempts,
						bashSettlementAttempts,
						sessionFile: session.sessionFile,
						raw,
						leafId: sessionManager.getLeafId(),
						targetEntryPresent: partialEntryId ? sessionManager.getEntry(partialEntryId) !== undefined : true,
						targetRawPresent: raw.includes("target partial append"),
						artifactFiles: (await artifactManager.listFiles()).filter(file => !file.includes("advisor")).sort(),
						retainedArtifactContent: await Bun.file(retainedArtifactPath).text(),
						rolledBackArtifactExists: await Bun.file(rolledBackArtifactPath!).exists(),
						directives: session.toolChoiceQueue.inspect(),
						retainedPreview: session.peekPendingInvoker() === retainedPreviewInvoker,
						activeTools: session.getActiveToolNames(),
						mountedTools: session.getMountedXdevToolNames(),
						targetDiscards,
						bashRunning: session.isBashRunning,
						bashEntryPresent: sessionManager
							.getEntries()
							.some(entry => entry.type === "message" && entry.message.role === "bashExecution"),
					};
					rollbackPublicationStarted.resolve();
					await allowRollbackPublication.promise;
				}
				const result = await emitWithHostCompletion(event, finalizeBeforeHostCompletion);
				if (event.type === "session_tree") treePublished = true;
				return result;
			},
		);

		const navigation = session.navigateTree(rootEntryId);
		await rollbackPublicationStarted.promise;
		expect(advisorResumed).toBe(false);
		expect(rollbackAtDispatch?.raw).toBe(retainedRaw);
		allowRollbackPublication.resolve();
		await expect(navigation).rejects.toBe(failure);
		expect(bashSettlementAttempts).toBe(2);
		expect(artifactFinalizeAttempts).toBe(0);
		expect(rollbackAtDispatch).toEqual({
			published: false,
			artifactFinalizeAttempts: 0,
			bashSettlementAttempts: 2,
			sessionFile: retainedSessionFile,
			raw: retainedRaw,
			leafId: retainedLeafId,
			targetEntryPresent: false,
			targetRawPresent: false,
			artifactFiles: retainedArtifactFiles,
			retainedArtifactContent: "target overwrite",
			rolledBackArtifactExists: false,
			directives: [retainedDirective],
			retainedPreview: true,
			activeTools: ["read", "write", "bash"],
			mountedTools: ["retained-mounted"],
			targetDiscards: 1,
			bashRunning: true,
			bashEntryPresent: false,
		});
		expect(sessionManager.getEntry(partialEntryId!)).toBeUndefined();
		expect(await Bun.file(retainedArtifactPath).text()).toBe("target overwrite");
		expect(await Bun.file(rolledBackArtifactPath!).exists()).toBe(false);
		expect(session.getCheckpointState()).toEqual(checkpoint);
		expect(asyncManager.getJob(asyncJobId)?.status).toBe("completed");
		expect(retainedCallbacks).toBe(0);
		expect(targetCallbacks).toBe(0);
		expect(session.toolChoiceQueue.inspect()).toEqual([retainedDirective]);
		expect(session.peekPendingInvoker()).toBe(retainedPreviewInvoker);
		const restoredPermissionTool = session.agent.state.tools.find(tool => tool.name === "bash");
		if (!restoredPermissionTool) throw new Error("Expected restored permission tool");
		await restoredPermissionTool.execute(
			"retained-permission-after-rollback",
			{ command: "echo retained" },
			undefined,
			undefined as never,
			undefined as never,
		);
		expect(permissionRequests).toEqual(["bash"]);
		expect(retainedPermissionToolExecutions).toBe(2);

		bashGate.resolve();
		await expect(bashPromise).resolves.toEqual(bashResult);
		const bashEntry = sessionManager
			.getEntries()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "bashExecution" &&
					entry.message.command === "retained-tree-command",
			);
		expect(bashEntry?.parentId).toBe(retainedLeafId);
		session.setCheckpointState(undefined);

		await pendingAdvisor.resumed;
		pendingAdvisor.release.resolve();
		await pendingAdvisor.resumedCompleted;
		await resumedAdvisorYieldQueued.promise;
		await session.settleAsyncWork();
		expect(launchReceipt).toBeDefined();
		await expect(launchReceipt!).resolves.toBeUndefined();
		expect(queuedAsyncReceipt).toBeDefined();
		await expect(queuedAsyncReceipt!).resolves.toBeUndefined();
		expect(asyncReceiptSettled).toBe(true);
		const countDelivered = (marker: string): number =>
			session.messages.reduce((count, message) => count + JSON.stringify(message).split(marker).length - 1, 0);
		expect(countDelivered(asyncMarker)).toBe(1);
		expect(countDelivered(queuedMarker)).toBe(1);
		expect(session.hasPendingAsyncWork()).toBe(false);

		const advisorNotes = session.messages.flatMap(message => {
			if (message.role !== "custom" || message.customType !== "advisor") return [];
			return (
				(
					message as AgentMessage & {
						details?: { notes: Array<{ note: string; severity?: string; advisor?: string }> };
					}
				).details?.notes ?? []
			);
		});
		expect(advisorNotes).toEqual([
			{ note: "retained artifact-commit yield", severity: "nit", advisor: undefined },
			{ note: "resumed artifact-commit advisor work", severity: "nit", advisor: undefined },
		]);
		expect(advisorReceipt).toBeDefined();
		await expect(advisorReceipt!).resolves.toBeUndefined();
		expect(advisorReceiptSettled).toBe(true);
	}, 15_000);

	it("waits out a live streaming artifact writer, preserves a later overwrite, and removes created paths", async () => {
		const tempDir = TempDir.createSync("@pi-tree-streaming-artifact-rollback-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir);
		const rootEntryId = sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("reply"));
		sessionManager.appendMessage({ role: "user", content: "retained leaf", timestamp: 2 });
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const artifactManager = sessionManager.getArtifactManager();
		if (!artifactManager) throw new Error("Expected persistent artifact manager");
		const liveArtifact = await sessionManager.allocateArtifactPath("bash");
		const liveArtifactId = liveArtifact.id;
		const liveArtifactPath = liveArtifact.path;
		const liveArtifactRelease = liveArtifact.release;
		if (!liveArtifactId || !liveArtifactPath || !liveArtifactRelease) {
			liveArtifactRelease?.();
			throw new Error("Expected leased streaming artifact path");
		}
		const sink = new OutputSink({
			artifactPath: liveArtifactPath,
			artifactId: liveArtifactId,
			artifactRelease: liveArtifactRelease,
			spillThreshold: 1,
			artifactMaxBytes: 0,
		});
		sink.push("stream head π\n");

		const transactionRequested = Promise.withResolvers<void>();
		const publicationStarted = Promise.withResolvers<void>();
		const failPublication = Promise.withResolvers<void>();
		let publicationObserved = false;
		const originalBeginTransaction = artifactManager.beginTransaction.bind(artifactManager);
		vi.spyOn(artifactManager, "beginTransaction").mockImplementation(() => {
			const transaction = originalBeginTransaction();
			transactionRequested.resolve();
			return transaction;
		});
		vi.spyOn(extensionRunner, "hasHandlers").mockImplementation(eventType => eventType === "session_tree");
		const failure = new Error("tree streaming event fan-out failed");
		let rolledBackArtifactId: string | undefined;
		let rolledBackArtifactPath: string | undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_tree") {
					publicationObserved = true;
					publicationStarted.resolve();
					await Bun.write(liveArtifactPath, "transaction overwrite");
					rolledBackArtifactId = await sessionManager.saveArtifact("transaction-created artifact", "tree");
					if (!rolledBackArtifactId) throw new Error("Expected transaction-created artifact id");
					rolledBackArtifactPath = (await sessionManager.getArtifactPath(rolledBackArtifactId)) ?? undefined;
					if (!rolledBackArtifactPath) throw new Error("Expected transaction-created artifact path");
					await failPublication.promise;
					throw failure;
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		const navigation = session.navigateTree(rootEntryId);
		try {
			await transactionRequested.promise;
			await Promise.resolve();
			expect(publicationObserved).toBe(false);
			sink.push("stream tail β\n");
			await sink.dump();
			await publicationStarted.promise;
			failPublication.resolve();
			await expect(navigation).rejects.toBe(failure);

			expect(await sessionManager.getArtifactPath(liveArtifactId)).toBe(liveArtifactPath);
			expect(await Bun.file(liveArtifactPath).text()).toBe("transaction overwrite");
			expect(rolledBackArtifactPath).toBeString();
			expect(await Bun.file(rolledBackArtifactPath!).exists()).toBe(false);

			const reusedArtifactId = await sessionManager.saveArtifact("committed after streaming rollback", "tree");
			expect(reusedArtifactId).toBe(rolledBackArtifactId);
			expect(await sessionManager.getArtifactPath(reusedArtifactId!)).toBe(rolledBackArtifactPath!);
			expect(await Bun.file(rolledBackArtifactPath!).text()).toBe("committed after streaming rollback");
		} finally {
			failPublication.resolve();
			await sink.dispose();
			await navigation.catch(() => undefined);
		}
	});

	it("restores the in-memory artifact map and allocator before tree rollback dispatch", async () => {
		const tempDir = TempDir.createSync("@pi-tree-memory-artifact-rollback-");
		tempDirs.push(tempDir);
		const { session, sessionManager, extensionRunner } = buildSession(tempDir, { persist: false });
		const rootEntryId = sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("reply"));
		sessionManager.appendMessage({ role: "user", content: "retained leaf", timestamp: 2 });
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const retainedArtifactId = await sessionManager.saveArtifact("retained memory artifact", "tree");
		expect(retainedArtifactId).toBe("0");
		const retainedState = sessionManager.captureState();
		const retainedHeader = structuredClone(retainedState.header);
		const retainedEntries = structuredClone(retainedState.entries);
		const retainedArtifacts = [...(retainedState.inMemoryArtifacts ?? new Map<string, string>())];

		vi.spyOn(extensionRunner, "hasHandlers").mockImplementation(eventType => eventType === "session_tree");
		const failure = new Error("in-memory tree event fan-out failed");
		let rolledBackArtifactId: string | undefined;
		let rollbackAtDispatch:
			| {
					header: unknown;
					entries: unknown;
					artifacts: Array<[string, string]>;
					counter: number;
			  }
			| undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_tree") {
					await sessionManager.setSessionName("rolled back memory title", "user");
					rolledBackArtifactId = await sessionManager.saveArtifact("rolled back memory artifact", "tree");
					throw failure;
				}
				if (event.type === "session_rollback") {
					const state = sessionManager.captureState();
					rollbackAtDispatch = {
						header: state.header,
						entries: state.entries,
						artifacts: [...(state.inMemoryArtifacts ?? new Map<string, string>())],
						counter: state.inMemoryArtifactCounter,
					};
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		await expect(session.navigateTree(rootEntryId)).rejects.toBe(failure);
		expect(rollbackAtDispatch).toEqual({
			header: retainedHeader,
			entries: retainedEntries,
			artifacts: retainedArtifacts,
			counter: retainedState.inMemoryArtifactCounter,
		});
		const restoredState = sessionManager.captureState();
		expect(restoredState.header).toEqual(retainedHeader);
		expect(restoredState.entries).toEqual(retainedEntries);
		expect([...(restoredState.inMemoryArtifacts ?? new Map<string, string>())]).toEqual(retainedArtifacts);
		expect(restoredState.inMemoryArtifactCounter).toBe(retainedState.inMemoryArtifactCounter);
		expect(await sessionManager.saveArtifact("committed memory artifact", "tree")).toBe(rolledBackArtifactId);
	});

	it("restores advisor backlog, cards, receipts, and both journals after a target append fails", async () => {
		const tempDir = TempDir.createSync("@pi-switch-atomic-rollback-");
		tempDirs.push(tempDir);
		const primaryMock = createMockModel({ handler: () => ({ content: ["primary reply"] }) });
		const pendingAdvisor = createPendingAdvisorWork("resumed switch advisor work");
		const { session, sessionManager, extensionRunner } = buildSession(tempDir, {
			streamFn: primaryMock.stream,
			advisorStreamFn: pendingAdvisor.mock.stream,
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.toggleAdvisorEnabled()).toBe(true);
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("retained reply"));
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await session.prompt("start retained advisor work");
		await pendingAdvisor.firstStarted;
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		const retainedRaw = await Bun.file(retainedSessionFile).text();

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		targetManager.appendMessage(assistantMsg("target reply"));
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		const targetRaw = await Bun.file(targetSessionFile).text();
		await targetManager.close();

		const retainedAdvisorCard: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "retained switch advisor card",
			display: true,
			attribution: "agent",
			timestamp: 3,
		};
		session.agent.replaceQueues([retainedAdvisorCard], []);
		let receiptSettled = false;
		const receipt = session.yieldQueue.enqueueWithReceipt("advisor", {
			note: "retained switch yield",
			severity: "nit" as const,
		});
		void receipt.then(
			() => {
				receiptSettled = true;
			},
			() => {},
		);
		const advisorReset = vi.spyOn(SessionAdvisors.prototype, "resetSessionState");
		const retainedAdvisorResetCalls = advisorReset.mock.calls.length;
		const retainedAdvisorStats = stableAdvisorStats(session.getAdvisorStats());
		const retainedEntries = sessionManager.getEntries().map(entry => entry.id);
		const retainedMessages = [...session.messages];

		const failure = new Error("target readiness handler append failed");
		let rollbackState:
			| {
					steering: AgentMessage[];
					retainedRaw: string;
					targetRaw: string;
					yieldQueued: boolean;
					receiptSettled: boolean;
					advisorStats: StableAdvisorStats;
					advisorCalls: number;
					advisorResetCalls: number;
			  }
			| undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_ready") {
					// This ordinary readiness handler mutates the target JSONL, then fails
					// before finalization so the exact target preimage must still be restored.
					sessionManager.appendMessage({ role: "user", content: "partial target handler", timestamp: 4 });
					await sessionManager.flush();
					throw failure;
				}
				if (event.type === "session_rollback") {
					rollbackState = {
						retainedRaw: await Bun.file(retainedSessionFile).text(),
						targetRaw: await Bun.file(targetSessionFile).text(),
						steering: [...session.agent.peekSteeringQueue()],
						yieldQueued: session.yieldQueue.has("advisor"),
						receiptSettled,
						advisorStats: stableAdvisorStats(session.getAdvisorStats()),
						advisorCalls: pendingAdvisor.mock.calls.length,
						advisorResetCalls: advisorReset.mock.calls.length,
					};
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		await expect(session.switchSession(targetSessionFile)).rejects.toBe(failure);

		expect(rollbackState).toEqual({
			retainedRaw,
			targetRaw,
			steering: [retainedAdvisorCard],
			yieldQueued: true,
			receiptSettled: false,
			advisorStats: retainedAdvisorStats,
			advisorCalls: 1,
			advisorResetCalls: retainedAdvisorResetCalls,
		});
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(sessionManager.getEntries().map(entry => entry.id)).toEqual(retainedEntries);
		expect(session.messages).toEqual(retainedMessages);

		pendingAdvisor.release.resolve();
		await pendingAdvisor.resumed;
		await expect(receipt).resolves.toBeUndefined();
		expect(receiptSettled).toBe(true);
	});
	it("rolls back provisional switch artifacts and every retained runtime owner when Bash prepare settlement fails", async () => {
		const tempDir = TempDir.createSync("@pi-switch-bash-prepare-rollback-");
		tempDirs.push(tempDir);
		const deliveredContexts: string[] = [];
		const asyncMarker = "retained deferred async result";
		const primaryMock = createMockModel({
			handler: context => {
				const serialized = JSON.stringify(context.messages);
				deliveredContexts.push(serialized);
				return { content: ["primary reply"] };
			},
		});
		const pendingAdvisor = createPendingAdvisorWork("resumed Bash settlement advisor work");
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		const makeTool = (name: string, loadMode?: "discoverable"): AgentTool & { executeCalls: number } => {
			const tool = {
				name,
				label: name,
				description: `Test ${name}`,
				parameters: {} as never,
				executeCalls: 0,
				async execute() {
					tool.executeCalls++;
					return { content: [{ type: "text" as const, text: `${name} executed` }] };
				},
				...(loadMode ? { loadMode } : {}),
			};
			return tool;
		};
		const readTool = makeTool("read");
		const writeTool = makeTool("write");
		const bashTool = makeTool("bash");
		const retainedMountedTool = makeTool("retained-mounted", "discoverable");
		const targetMountedTool = makeTool("target-mounted", "discoverable");
		const toolRegistry = new Map<string, AgentTool>([
			[readTool.name, readTool],
			[writeTool.name, writeTool],
			[bashTool.name, bashTool],
			[retainedMountedTool.name, retainedMountedTool],
			[targetMountedTool.name, targetMountedTool],
		]);
		let session: AgentSession;
		const xdev: XdevState = {
			tools: toolRegistry as XdevState["tools"],
			mountedNames: new Set(),
			builtInNames: new Set(["read", "write"]),
			isActive: name => session.getEnabledToolNames().includes(name),
		};
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const extensionRunner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const agent = new Agent({
			getToolChoice: () => session.nextToolChoiceDirective(),
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: primaryMock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
			toolRegistry,
			xdev,
			builtInToolNames: ["read", "write"],
			advisorStreamFn: pendingAdvisor.mock.stream,
			ownedAsyncJobManager: asyncManager,
			agentId: "Main",
		});
		sessions.push(session);
		const permissionRequests: string[] = [];
		const bridge: ClientBridge = {
			capabilities: { requestPermission: true },
			async requestPermission(toolCall) {
				permissionRequests.push(toolCall.toolCallId);
				return { outcome: "selected", optionId: "allow_always", kind: "allow_always" };
			},
		};
		session.setClientBridge(bridge);
		await session.setActiveToolPresentation(["read", "write", "bash", "retained-mounted"], ["retained-mounted"]);
		const retainedBashTool = session.agent.state.tools.find(tool => tool.name === "bash");
		if (!retainedBashTool) throw new Error("Expected retained bash tool");
		await retainedBashTool.execute(
			"retained-permission",
			{ command: "echo retained permission" },
			undefined,
			undefined as never,
			undefined as never,
		);
		expect(permissionRequests).toEqual(["retained-permission"]);

		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.toggleAdvisorEnabled()).toBe(true);
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("retained reply"));
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await session.prompt("start retained advisor work");
		await pendingAdvisor.firstStarted;
		await session.waitForIdle();
		let retainedLeafId = sessionManager.getLeafId();
		if (!retainedLeafId) throw new Error("Expected retained switch leaf");
		const retainedArtifactId = await sessionManager.saveArtifact("retained artifact bytes", "switch");
		if (!retainedArtifactId) throw new Error("Expected retained artifact id");
		const retainedArtifactPath = await sessionManager.getArtifactPath(retainedArtifactId);
		if (!retainedArtifactPath) throw new Error("Expected retained artifact path");
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionFile = session.sessionFile;
		if (!retainedSessionFile) throw new Error("Expected retained session file");
		let retainedRaw = await Bun.file(retainedSessionFile).text();
		const retainedArtifactFiles = (await sessionManager.getArtifactManager()?.listFiles())?.filter(
			file => !file.includes("advisor"),
		);
		if (!retainedArtifactFiles) throw new Error("Expected retained artifact manager");

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		const targetArtifactId = await targetManager.saveArtifact("target artifact preimage", "switch");
		if (!targetArtifactId) throw new Error("Expected target artifact id");
		const targetArtifactPath = await targetManager.getArtifactPath(targetArtifactId);
		if (!targetArtifactPath) throw new Error("Expected target artifact path");
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		const targetRaw = await Bun.file(targetSessionFile).text();
		await targetManager.close();

		const retainedPreview = (input: unknown) => ({ retainedPreview: input });
		const inFlightInvoker = (input: unknown) => ({ retainedInFlight: input });
		session.setForcedToolChoice("bash");
		session.agent.setBeforeModelCall(() => ({ stop: true, reason: "defer retained directive" }));
		await session.agent.prompt("defer retained directive");
		session.agent.setBeforeModelCall(undefined);
		session.toolChoiceQueue.clear();
		session.toolChoiceQueue.pushOnce(
			{ type: "tool", name: "bash" },
			{ label: "retained-in-flight", onInvoked: inFlightInvoker },
		);
		session.toolChoiceQueue.pushOnce({ type: "tool", name: "bash" }, { label: "retained-pending" });
		expect(session.toolChoiceQueue.nextToolChoice()).toEqual({ type: "tool", name: "bash" });
		session.toolChoiceQueue.registerPendingInvoker("retained-preview", "ast_edit", retainedPreview);
		const retainedQueueLabels = [...session.toolChoiceQueue.inspect()];
		expect(session.toolChoiceQueue.hasInFlight).toBe(true);
		let queueAtOwnership: { labels: readonly string[]; hasInFlight: boolean } | undefined;
		const beginToolChoiceTransition = session.toolChoiceQueue.beginSessionTransition.bind(session.toolChoiceQueue);
		vi.spyOn(session.toolChoiceQueue, "beginSessionTransition").mockImplementation(() => {
			queueAtOwnership = {
				labels: session.toolChoiceQueue.inspect(),
				hasInFlight: session.toolChoiceQueue.hasInFlight,
			};
			return beginToolChoiceTransition();
		});

		const retainedAdvisorCard: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "retained settlement advisor card",
			display: true,
			attribution: "agent",
			timestamp: 3,
		};
		const asyncGate = Promise.withResolvers<string>();
		const asyncJobId = asyncManager.register("task", "retained async job", () => asyncGate.promise, {
			id: "retained-switch-settlement-job",
			ownerId: "Main",
		});
		const retainedSessionId = sessionManager.getSessionId();
		let retainedCallbackCalls = 0;
		let discardedTargetCallbacks = 0;
		session.registerSessionChangeCallback(() => retainedCallbackCalls++);
		let retainedLaunchReceipt: Promise<void> | undefined;
		let targetLaunchReceipt: Promise<void> | undefined;
		let targetArtifactCreatedPath: string | undefined;
		let targetRuntimeMutated = false;
		session.setSessionSwitchReconciler(async () => {
			if (session.sessionFile !== targetSessionFile) return;
			targetRuntimeMutated = true;
			await session.setActiveToolPresentation(["read", "write", "target-mounted"], ["target-mounted"]);
			session.toolChoiceQueue.registerPendingInvoker("target-preview", "ast_edit", () => "target");
			session.registerSessionChangeCallback(
				() => {
					throw new Error("Discarded target callback must not run");
				},
				{ onDiscard: () => discardedTargetCallbacks++ },
			);
			await Bun.write(targetArtifactPath, "target artifact provisional overwrite");
			const createdId = await sessionManager.saveArtifact("target provisional artifact", "switch");
			targetArtifactCreatedPath = createdId
				? ((await sessionManager.getArtifactPath(createdId)) ?? undefined)
				: undefined;
			sessionManager.appendMessage({ role: "user", content: "target provisional journal", timestamp: 4 });
			await sessionManager.flush();
			const completion = (owner: string, completionId: string) =>
				({
					event: "daemon-completed",
					completionId,
					owner,
					daemon: {
						name: completionId,
						id: completionId,
						state: "exited",
						createdAt: 1,
						startedAt: 1,
						exitedAt: 2,
						exitCode: 0,
						restartCount: 0,
						outputBytes: 0,
						owner,
						persist: false,
						detached: false,
					},
				}) satisfies DaemonCompletionNotification;
			retainedLaunchReceipt = session.queueLaunchCompletion(completion(retainedSessionId, "retained-launch"));
			void retainedLaunchReceipt.catch(() => {});
			targetLaunchReceipt = session.queueLaunchCompletion(
				completion(sessionManager.getSessionId(), "target-launch"),
			);
			void targetLaunchReceipt.catch(() => {});
			asyncGate.resolve(asyncMarker);
			await asyncManager.waitForOwnerJobs("Main");
			await asyncManager.drainDeliveries({ filter: { ownerId: "Main" } });
		});

		const bashStarted = Promise.withResolvers<void>();
		const bashGate = Promise.withResolvers<void>();
		const bashResult = {
			output: "retained Bash result",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 20,
			outputLines: 1,
			outputBytes: 20,
		};
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async () => {
			bashStarted.resolve();
			await bashGate.promise;
			return bashResult;
		});
		const bashPromise = session.executeBash("retained prepare settlement command");
		await bashStarted.promise;
		const settlementFailure = new Error("Bash prepare settlement failed");
		vi.spyOn(BashRunner.prototype, "awaitSessionTransition").mockRejectedValueOnce(settlementFailure);
		const emit = extensionRunner.emit.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emit").mockImplementation(async event => {
			if (event.type === "session_switch") {
				retainedLeafId = sessionManager.getLeafId();
				retainedRaw = await Bun.file(retainedSessionFile).text();
			}
			return emit(event);
		});
		const lifecycleEvents: string[] = [];
		let rollbackRuntimeState:
			| {
					retainedRaw: string;
					targetRaw: string;
					toolChoiceLabels: readonly string[];
					hasInFlightToolChoice: boolean;
					queueInvokerAvailable: boolean;
					pendingInvokerSelected: boolean;
					steering: AgentMessage[];
					discardedTargetCallbacks: number;
			  }
			| undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_rollback") {
					rollbackRuntimeState = {
						retainedRaw: await Bun.file(retainedSessionFile).text(),
						targetRaw: await Bun.file(targetSessionFile).text(),
						toolChoiceLabels: session.toolChoiceQueue.inspect(),
						hasInFlightToolChoice: session.toolChoiceQueue.hasInFlight,
						queueInvokerAvailable: session.peekQueueInvoker() !== undefined,
						pendingInvokerSelected: session.peekPendingInvoker() === retainedPreview,
						steering: [...session.agent.peekSteeringQueue()],
						discardedTargetCallbacks,
					};
				}
				const result = await emitWithHostCompletion(event, finalizeBeforeHostCompletion);
				lifecycleEvents.push(event.type);
				return result;
			},
		);
		session.agent.replaceQueues([retainedAdvisorCard], []);
		let advisorReceiptSettled = false;
		const advisorReceipt = session.yieldQueue.enqueueWithReceipt("advisor", {
			note: "retained settlement advisor receipt",
			severity: "nit" as const,
		});
		void advisorReceipt.then(
			() => {
				advisorReceiptSettled = true;
			},
			() => {},
		);
		let asyncReceiptSettled = false;
		const asyncReceipt = session.yieldQueue.enqueueWithReceipt<AsyncResultEntry>("async-result", {
			jobId: "retained-async-receipt",
			result: "retained async receipt",
			job: undefined,
			durationMs: 0,
			epoch: 0,
		});
		void asyncReceipt.then(
			() => {
				asyncReceiptSettled = true;
			},
			() => {},
		);

		await expect(session.switchSession(targetSessionFile)).rejects.toBe(settlementFailure);
		expect(queueAtOwnership).toEqual({ labels: retainedQueueLabels, hasInFlight: true });
		expect(targetRuntimeMutated).toBe(true);
		expect(lifecycleEvents).toEqual(["session_rollback"]);
		expect(rollbackRuntimeState).toEqual({
			retainedRaw,
			targetRaw,
			toolChoiceLabels: retainedQueueLabels,
			hasInFlightToolChoice: true,
			queueInvokerAvailable: true,
			pendingInvokerSelected: true,
			steering: [retainedAdvisorCard],
			discardedTargetCallbacks: 1,
		});
		expect(session.sessionFile).toBe(retainedSessionFile);
		expect(await Bun.file(targetSessionFile).text()).toBe(targetRaw);
		expect(await Bun.file(retainedArtifactPath).text()).toBe("retained artifact bytes");
		expect(await Bun.file(targetArtifactPath).text()).toBe("target artifact provisional overwrite");
		expect(targetArtifactCreatedPath).toBeString();
		expect(await Bun.file(targetArtifactCreatedPath!).exists()).toBe(false);
		expect(
			(await sessionManager.getArtifactManager()?.listFiles())?.filter(file => !file.includes("advisor")),
		).toEqual(retainedArtifactFiles);
		expect(session.getMountedXdevToolNames()).toEqual(["retained-mounted"]);
		expect(session.getEnabledToolNames()).toEqual(expect.arrayContaining(["bash", "retained-mounted"]));
		expect(discardedTargetCallbacks).toBe(1);
		expect(retainedCallbackCalls).toBe(0);
		expect(asyncManager.getJob(asyncJobId)?.status).toBe("completed");
		expect(session.isBashRunning).toBe(true);
		await pendingAdvisor.resumed;
		pendingAdvisor.release.resolve();
		await expect(advisorReceipt).resolves.toBeUndefined();
		await expect(asyncReceipt).resolves.toBeUndefined();
		await expect(retainedLaunchReceipt).resolves.toBeUndefined();
		await expect(targetLaunchReceipt).rejects.toThrow("discarded lifecycle owner");
		expect(advisorReceiptSettled).toBe(true);
		expect(asyncReceiptSettled).toBe(true);
		await retainedBashTool.execute(
			"retained-permission-again",
			{ command: "echo retained permission" },
			undefined,
			undefined as never,
			undefined as never,
		);
		expect(permissionRequests).toEqual(["retained-permission"]);

		bashGate.resolve();
		await expect(bashPromise).resolves.toEqual(bashResult);
		const retainedBashEntry = sessionManager
			.getEntries()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "bashExecution" &&
					entry.message.command === "retained prepare settlement command",
			);
		expect(retainedBashEntry?.parentId).toBe(retainedLeafId);
		for (const marker of [asyncMarker, "retained settlement advisor receipt", "retained-launch"]) {
			expect(deliveredContexts.some(context => context.includes(marker))).toBe(false);
			expect(session.messages.filter(message => JSON.stringify(message).includes(marker))).toHaveLength(1);
		}

		await session.newSession();
		expect(retainedCallbackCalls).toBe(1);
	}, 15_000);

	it("selects every retained owner before rollback publication, then auto-delivers fenced work once", async () => {
		const tempDir = TempDir.createSync("@pi-switch-two-phase-rollback-");
		tempDirs.push(tempDir);
		const deliveredContexts: string[] = [];
		const deliveryObserved = Promise.withResolvers<void>();
		const retainedFollowUpMarker = "retained automatic rollback follow-up";
		const retainedYieldMarker = "retained automatic rollback yield";
		const retainedLaunchMarker = "retained-automatic-rollback-launch";
		const primaryMock = createMockModel({
			handler: context => {
				const serialized = JSON.stringify(context.messages);
				deliveredContexts.push(serialized);
				if (
					serialized.includes(retainedFollowUpMarker) &&
					serialized.includes(retainedYieldMarker) &&
					serialized.includes(retainedLaunchMarker)
				) {
					deliveryObserved.resolve();
				}
				return { content: ["primary reply"] };
			},
		});
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		const { session, sessionManager, extensionRunner } = buildSession(tempDir, {
			streamFn: primaryMock.stream,
			asyncJobManager: asyncManager,
		});
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		sessionManager.appendMessage(assistantMsg("retained reply"));
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();
		const retainedSessionId = sessionManager.getSessionId();

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		await targetManager.close();

		session.agent.replaceQueues(
			[],
			[
				{
					role: "user",
					content: [{ type: "text", text: retainedFollowUpMarker }],
					attribution: "user",
					timestamp: 3,
				},
			],
		);
		const retainedPreview = (input: unknown) => ({ retained: input });
		session.toolChoiceQueue.registerPendingInvoker("retained-preview", "ast_edit", retainedPreview);

		let yieldReceipt: Promise<void> | undefined;
		let yieldReceiptResolutions = 0;
		let yieldReceiptRejections = 0;
		const rolledBackYieldKinds = new Set<string>();
		const beginTransaction = session.yieldQueue.beginTransaction.bind(session.yieldQueue);
		vi.spyOn(session.yieldQueue, "beginTransaction").mockImplementation(kind => {
			if (kind === "async-result" && !yieldReceipt) {
				yieldReceipt = session.yieldQueue.enqueueWithReceipt<AsyncResultEntry>("async-result", {
					jobId: "retained-automatic-rollback-yield",
					result: retainedYieldMarker,
					job: undefined,
					durationMs: 0,
					epoch: 0,
				});
				void yieldReceipt.then(
					() => yieldReceiptResolutions++,
					() => yieldReceiptRejections++,
				);
			}
			const transaction = beginTransaction(kind);
			return {
				commit: () => transaction.commit(),
				activate: () => transaction.activate(),
				rollback: () => {
					rolledBackYieldKinds.add(kind);
					transaction.rollback();
				},
			};
		});

		const completion = (owner: string, completionId: string): DaemonCompletionNotification => ({
			event: "daemon-completed",
			completionId,
			owner,
			daemon: {
				name: completionId,
				id: completionId,
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner,
				persist: false,
				detached: false,
			},
		});
		let retainedLaunchReceipt: Promise<void> | undefined;
		let targetLaunchReceipt: Promise<void> | undefined;
		let retainedLaunchResolutions = 0;
		let retainedLaunchRejections = 0;
		let targetLaunchResolutions = 0;
		let targetLaunchRejections = 0;
		let discardedTargetCallbacks = 0;
		session.setSessionSwitchReconciler(async () => {
			if (session.sessionFile !== targetSessionFile) return;
			session.toolChoiceQueue.registerPendingInvoker("target-preview", "ast_edit", input => input);
			session.registerSessionChangeCallback(() => {}, { onDiscard: () => discardedTargetCallbacks++ });
			retainedLaunchReceipt = session.queueLaunchCompletion(completion(retainedSessionId, retainedLaunchMarker));
			targetLaunchReceipt = session.queueLaunchCompletion(
				completion(sessionManager.getSessionId(), "target-automatic-rollback-launch"),
			);
			void retainedLaunchReceipt.then(
				() => retainedLaunchResolutions++,
				() => retainedLaunchRejections++,
			);
			void targetLaunchReceipt.then(
				() => targetLaunchResolutions++,
				() => targetLaunchRejections++,
			);
		});

		const failure = new Error("switch finalizer failed");
		vi.spyOn(BashRunner.prototype, "prepareCommit").mockRejectedValueOnce(failure);
		const prepareRollbackStarted = Promise.withResolvers<void>();
		const allowPrepareRollback = Promise.withResolvers<void>();
		const prepareRollback = BashRunner.prototype.prepareRollback;
		let bashRollbackPrepared = false;
		vi.spyOn(BashRunner.prototype, "prepareRollback").mockImplementation(async function (
			this: BashRunner,
			transition,
		) {
			prepareRollbackStarted.resolve();
			await allowPrepareRollback.promise;
			await prepareRollback.call(this, transition);
			bashRollbackPrepared = true;
		});
		const rollbackSessionTransition = BashRunner.prototype.rollbackSessionTransition;
		let bashOwnershipSelected = false;
		vi.spyOn(BashRunner.prototype, "rollbackSessionTransition").mockImplementation(async function (
			this: BashRunner,
			transition,
		) {
			await rollbackSessionTransition.call(this, transition);
			bashOwnershipSelected = true;
		});
		const discardJobs = vi.spyOn(asyncManager, "discardJobs");

		let artifactRollbackStarted = false;
		const beginArtifactTransaction = sessionManager.beginArtifactTransaction.bind(sessionManager);
		vi.spyOn(sessionManager, "beginArtifactTransaction").mockImplementation(async () => {
			const transaction = await beginArtifactTransaction();
			return {
				rollback: async () => {
					artifactRollbackStarted = true;
					expect(bashRollbackPrepared).toBe(true);
					expect(discardJobs).toHaveBeenCalled();
					await transaction.rollback();
				},
				commit: () => transaction.commit(),
			};
		});

		const rollbackPublicationStarted = Promise.withResolvers<void>();
		const allowRollbackPublication = Promise.withResolvers<void>();
		let rollbackAtPublication:
			| {
					rolledBackYieldKinds: string[];
					bashOwnershipSelected: boolean;
					discardedTargetCallbacks: number;
					retainedPreviewSelected: boolean;
					followUpQueued: boolean;
					asyncYieldQueued: boolean;
					launchYieldQueued: boolean;
					yieldReceiptSettlements: number;
					retainedLaunchSettlements: number;
					targetLaunchResolutions: number;
					targetLaunchRejections: number;
					providerCalls: number;
			  }
			| undefined;
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_rollback") {
					await Promise.resolve();
					rollbackAtPublication = {
						rolledBackYieldKinds: [...rolledBackYieldKinds].sort(),
						bashOwnershipSelected,
						discardedTargetCallbacks,
						retainedPreviewSelected: session.peekPendingInvoker() === retainedPreview,
						followUpQueued: session.agent
							.peekFollowUpQueue()
							.some(message => JSON.stringify(message).includes(retainedFollowUpMarker)),
						asyncYieldQueued: session.yieldQueue.has("async-result"),
						launchYieldQueued: session.yieldQueue.has("launch-completion"),
						yieldReceiptSettlements: yieldReceiptResolutions + yieldReceiptRejections,
						retainedLaunchSettlements: retainedLaunchResolutions + retainedLaunchRejections,
						targetLaunchResolutions,
						targetLaunchRejections,
						providerCalls: primaryMock.calls.length,
					};
					rollbackPublicationStarted.resolve();
					await allowRollbackPublication.promise;
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		const switching = session.switchSession(targetSessionFile);
		await prepareRollbackStarted.promise;
		expect(artifactRollbackStarted).toBe(false);
		allowPrepareRollback.resolve();
		await rollbackPublicationStarted.promise;
		expect(primaryMock.calls).toHaveLength(0);
		expect(yieldReceiptResolutions + yieldReceiptRejections).toBe(0);
		expect(retainedLaunchResolutions + retainedLaunchRejections).toBe(0);
		allowRollbackPublication.resolve();
		await expect(switching).rejects.toBe(failure);

		expect(rollbackAtPublication).toEqual({
			rolledBackYieldKinds: ["advisor", "async-result", "launch-completion"],
			bashOwnershipSelected: true,
			discardedTargetCallbacks: 1,
			retainedPreviewSelected: true,
			followUpQueued: true,
			asyncYieldQueued: true,
			launchYieldQueued: false,
			yieldReceiptSettlements: 0,
			retainedLaunchSettlements: 0,
			targetLaunchResolutions: 0,
			targetLaunchRejections: 1,
			providerCalls: 0,
		});
		expect(yieldReceipt).toBeDefined();
		expect(retainedLaunchReceipt).toBeDefined();
		expect(targetLaunchReceipt).toBeDefined();
		await expect(yieldReceipt!).resolves.toBeUndefined();
		await expect(retainedLaunchReceipt!).resolves.toBeUndefined();
		await expect(targetLaunchReceipt!).rejects.toThrow("discarded lifecycle owner");
		await deliveryObserved.promise;
		expect(yieldReceiptResolutions).toBe(1);
		expect(yieldReceiptRejections).toBe(0);
		expect(retainedLaunchResolutions).toBe(1);
		expect(retainedLaunchRejections).toBe(0);
		expect(targetLaunchResolutions).toBe(0);
		expect(targetLaunchRejections).toBe(1);
		expect(deliveredContexts.some(context => context.includes(retainedFollowUpMarker))).toBe(true);
		expect(deliveredContexts.some(context => context.includes(retainedYieldMarker))).toBe(true);
		expect(deliveredContexts.some(context => context.includes(retainedLaunchMarker))).toBe(true);
		const deliveredMessages = session.messages.map(message => JSON.stringify(message));
		expect(deliveredMessages.filter(message => message.includes(retainedFollowUpMarker))).toHaveLength(1);
		expect(deliveredContexts.length).toBeGreaterThan(0);
	});
	it("defers selected target persistence and callbacks until host afterDispatch completes", async () => {
		const tempDir = TempDir.createSync("@pi-switch-host-publication-barrier-");
		tempDirs.push(tempDir);
		const primaryMock = createMockModel({ handler: () => ({ content: ["target delivery reply"] }) });
		const advisorMock = createMockModel({ handler: () => ({ content: ["advisor reply"] }) });
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();

		const targetManager = SessionManager.create(tempDir.path(), tempDir.path());
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile();
		if (!targetSessionFile) throw new Error("Expected target session file");
		await targetManager.close();

		let ordinaryHandlerRuns = 0;
		const ordinaryExtension = {
			path: "test://host-publication-ordinary-handler",
			resolvedPath: "test://host-publication-ordinary-handler",
			handlers: new Map([["session_ready", [() => ordinaryHandlerRuns++]]]),
			sessionMutationFences: [],
		} as unknown as Extension;
		const hostExtension = {
			path: "test://host-publication-host-handler",
			resolvedPath: "test://host-publication-host-handler",
			handlers: new Map(),
			sessionMutationFences: [],
		} as unknown as Extension;
		const hostPublicationStarted = Promise.withResolvers<void>();
		const releaseHostPublication = Promise.withResolvers<void>();
		const extensionRunner = new ExtensionRunner(
			[ordinaryExtension],
			new ExtensionRuntime(),
			tempDir.path(),
			sessionManager,
			modelRegistry,
			undefined,
			undefined,
			undefined,
			undefined,
			{
				extension: hostExtension,
				afterDispatch: async event => {
					if (event.type !== "session_ready") return;
					expect(ordinaryHandlerRuns).toBe(1);
					expect(session.sessionFile).toBe(targetSessionFile);
					hostPublicationStarted.resolve();
					await releaseHostPublication.promise;
				},
			},
		);
		const asyncManager = new AsyncJobManager({ retentionMs: 60_000 });
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: primaryMock.stream,
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
			advisorStreamFn: advisorMock.stream,
			ownedAsyncJobManager: asyncManager,
			agentId: "Main",
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.toggleAdvisorEnabled()).toBe(true);
		sessions.push(session);

		let sessionChangeCallbacks = 0;
		session.registerSessionChangeCallback(() => sessionChangeCallbacks++);
		const switching = session.switchSession(targetSessionFile);
		await hostPublicationStarted.promise;

		const advisorMarker = "host-barrier advisor yield";
		const asyncMarker = "host-barrier oversized async result";
		const launchMarker = "host-barrier supervised completion";
		let advisorSettlements = 0;
		const advisorReceipt = session.yieldQueue.enqueueWithReceipt("advisor", {
			note: advisorMarker,
			severity: "nit" as const,
			advisor: undefined,
		});
		void advisorReceipt.then(
			() => advisorSettlements++,
			() => advisorSettlements++,
		);
		const asyncResultGate = Promise.withResolvers<string>();
		const asyncJobId = asyncManager.register("task", "blocked target async delivery", () => asyncResultGate.promise, {
			id: "host-publication-async-result",
			ownerId: "Main",
		});
		asyncResultGate.resolve(`${asyncMarker}: ${"x".repeat(ASYNC_INLINE_RESULT_MAX_CHARS + 1)}`);
		await asyncManager.waitForOwnerJobs("Main");
		await asyncManager.drainDeliveries({ filter: { ownerId: "Main" } });

		const targetSessionId = sessionManager.getSessionId();
		let launchSettlements = 0;
		const launchReceipt = session.queueLaunchCompletion({
			event: "daemon-completed",
			completionId: launchMarker,
			owner: targetSessionId,
			daemon: {
				name: launchMarker,
				id: launchMarker,
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner: targetSessionId,
				persist: false,
				detached: false,
			},
		} satisfies DaemonCompletionNotification);
		void launchReceipt.then(
			() => launchSettlements++,
			() => launchSettlements++,
		);

		const targetArtifactManager = sessionManager.getArtifactManager();
		if (!targetArtifactManager) throw new Error("Expected target artifact manager");
		expect(primaryMock.calls).toHaveLength(0);
		expect(sessionChangeCallbacks).toBe(0);
		expect(advisorSettlements).toBe(0);
		expect(launchSettlements).toBe(0);
		expect(await targetArtifactManager.listFiles()).toEqual([]);
		expect(asyncManager.getJob(asyncJobId)?.status).toBe("completed");

		releaseHostPublication.resolve();
		await expect(switching).resolves.toBe(true);
		await expect(advisorReceipt).resolves.toBeUndefined();
		await expect(launchReceipt).resolves.toBeUndefined();
		await session.settleAsyncWork();
		await session.waitForIdle();

		expect(sessionChangeCallbacks).toBe(1);
		expect(advisorSettlements).toBe(1);
		expect(launchSettlements).toBe(1);
		const targetArtifacts = await targetArtifactManager.listFiles();
		expect(targetArtifacts).toHaveLength(1);
		expect(await Bun.file(path.join(targetArtifactManager.dir, targetArtifacts[0]!)).text()).toContain(asyncMarker);
		for (const marker of [advisorMarker, asyncMarker, launchMarker]) {
			expect(primaryMock.calls.some(call => JSON.stringify(call.context.messages).includes(marker))).toBe(false);
			expect(session.messages.filter(message => JSON.stringify(message).includes(marker))).toHaveLength(1);
		}
	});
});
