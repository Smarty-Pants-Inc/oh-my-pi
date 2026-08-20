/**
 * Contract: when the SDK supplies provider-shaping options to AgentSession,
 * the advisor `Agent` constructed by `#buildAdvisorRuntime` inherits them so
 * its OpenRouter/OpenAI requests cache and route like the main turn.
 *
 * Regression for can1357/oh-my-pi#3639: before the fix, the advisor was built
 * with only `sessionId`/`getApiKey`/telemetry — it dropped the session's
 * `streamFn` wrapper (so `providers.openrouterVariant` and `loopGuard` never
 * landed on advisor requests), its `promptCacheKey` (so OpenAI Responses
 * fell back to a different cache shard), its shared `providerSessionState`,
 * and its explicit websocket preference.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage, type StreamFn } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Context, ContextTarget, FetchImpl, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { bindRenderedInstruction } from "@oh-my-pi/pi-coding-agent/context/registry";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { obfuscateProviderContext, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** Provider-facing advisor session ids must be UUIDv7 (issue #5040): Codex writes
 *  them verbatim onto `conversation_id`/`session_id` headers, so `-advisor`
 *  labels stay local-only (telemetry, transcripts). */
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function metadataSessionId(options: SimpleStreamOptions | undefined): string {
	const metadata = options?.metadata;
	if (!metadata || typeof metadata.user_id !== "string") {
		throw new Error("Expected metadata.user_id");
	}
	const userId: unknown = JSON.parse(metadata.user_id);
	if (!userId || typeof userId !== "object" || !("session_id" in userId) || typeof userId.session_id !== "string") {
		throw new Error("Expected metadata.user_id.session_id");
	}
	return userId.session_id;
}

describe("AgentSession advisor provider-options parity", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(() => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	const settings = () =>
		Settings.isolated({
			"compaction.enabled": false,
			"providers.openrouterVariant": "floor",
			"model.loopGuard.enabled": true,
		});
	type LateInputDelivery = (session: AgentSession, agent: Agent, secret: string) => Promise<void> | void;
	const lateInputCases: [string, LateInputDelivery][] = [
		[
			"an idle user-attributed custom message is appended",
			async (targetSession, _agent, secret) => {
				await targetSession.sendCustomMessage(
					{
						customType: "background-tan-dispatch",
						content: `Background task contains ${secret}`,
						display: false,
						attribution: "user",
					},
					{ deliverAs: "nextTurn", triggerTurn: false },
				);
			},
		],
		[
			"a bash execution is appended",
			(_session, agent, secret) => {
				agent.appendMessage({
					role: "bashExecution",
					command: "printf late-output",
					output: `Command output contains ${secret}`,
					exitCode: 0,
					timestamp: Date.now(),
				} as unknown as AgentMessage);
			},
		],
		[
			"a Python execution is appended",
			(_session, agent, secret) => {
				agent.appendMessage({
					role: "pythonExecution",
					code: "print('late-output')",
					output: `Python output contains ${secret}`,
					exitCode: 0,
					timestamp: Date.now(),
				} as unknown as AgentMessage);
			},
		],
		[
			"provider-visible history is replaced",
			(_session, agent, secret) => {
				agent.replaceMessages([
					...agent.state.messages,
					{ role: "user", content: `Replacement contains ${secret}`, timestamp: Date.now() },
				]);
			},
		],
	];

	beforeEach(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		tempDir = TempDir.createSync("@pi-advisor-parity-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	});

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
		authStorage.close();
	});

	it("wraps the inherited streamFn and preserves promptCacheKey and providerSessionState", () => {
		const advisorStreamFn: StreamFn = (m, ctx, opts) => streamSimple(m, ctx, opts);
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn,
			preferWebsockets: true,
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		// The advisor keeps an SDK-provided stream function behind its own retry
		// budget wrapper. The capture tests below prove delegation and option
		// forwarding; identity must differ so the advisor can apply its cap.
		expect(advisor.streamFn).not.toBe(advisorStreamFn);
		expect(advisor.streamFn).not.toBe(streamSimple);

		// Shared transport / fast-mode state map keeps Codex websockets and
		// Anthropic fast-mode fallbacks consistent across the two agents.
		expect(advisor.providerSessionState).toBe(session.providerSessionState);

		// The advisor's session identity is its own provider-facing UUIDv7
		// (issue #5040), distinct from the parent's. Without a pinned parent
		// `promptCacheKey` the advisor caches on that same UUID so consecutive
		// advisor turns stay on one OpenAI Responses shard.
		expect(advisor.sessionId).toMatch(UUID_V7_PATTERN);
		expect(advisor.sessionId).not.toBe(mainAgent.sessionId);
		expect(advisor.promptCacheKey).toBe(advisor.sessionId);
	});

	it("keeps main-request tool evidence out of advisor stream options", async () => {
		const capturedStreamOptions: Array<SimpleStreamOptions | undefined> = [];
		const captureStreamFn: StreamFn = (_m, _ctx, opts) => {
			capturedStreamOptions.push(opts);
			// Return a stream that immediately fails — we only need to observe
			// the options the advisor handed us before the call.
			throw new Error("capture-stop");
		};
		const onPayload = async (payload: unknown) => payload;
		const onResponse = async (_response: unknown, _model: unknown) => undefined;
		const onSseEvent = (_event: { data: string }, _model: unknown) => {};
		const transformProviderContext = async <T>(context: T): Promise<T> => context;

		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: captureStreamFn,
			onPayload,
			onResponse,
			onSseEvent,
			transformProviderContext,
			preferWebsockets: true,
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		await advisor.prompt("ping").catch(() => {});

		expect(capturedStreamOptions.length).toBeGreaterThan(0);
		const opts = capturedStreamOptions[0];
		if (!opts) throw new Error("Expected captured advisor stream options");

		// Provider hooks forwarded by the Agent loop carry the session's wrappers
		// (the session wraps `onResponse`/`onSseEvent` to also drive its
		// `RawSseDebugBuffer` — what matters here is that *something* is wired,
		// not the exact closure identity for those two).
		expect(typeof opts.onPayload).toBe("function");
		expect(opts.onToolContracts).toBeUndefined();
		expect(typeof opts.onResponse).toBe("function");
		expect(typeof opts.onSseEvent).toBe("function");

		// Bare `onPayload` has no session-side wrapping so it reaches the stream
		// call unchanged — proof the SDK-provided hook was installed.
		expect(opts.onPayload).toBe(onPayload);

		// Cache routing identity threaded through into the actual stream call.
		// Without a parent `providerPromptCacheKey`, the advisor's effective key
		// is its own provider-facing UUIDv7 session id (issue #5040).
		expect(opts.sessionId).toBe(advisor.sessionId);
		expect(opts.promptCacheKey).toBe(advisor.sessionId);
		expect(opts.providerSessionState).toBe(session.providerSessionState);
		expect(opts.preferWebsockets).toBe(true);
	});

	it("projects fresh obfuscated goal state across active and terminal advisor requests", async () => {
		const capturedContexts: Context[] = [];
		const captureStreamFn: StreamFn = (_m, context) => {
			capturedContexts.push(context);
			throw new Error("capture-stop");
		};
		const secret = "ceo<&>-demo-secret-token";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }], "test-key");
		const transformTargets: Array<ContextTarget | undefined> = [];
		const transformProviderContext = async (
			context: Context,
			_model: Model,
			target?: ContextTarget,
		): Promise<Context> => {
			transformTargets.push(target);
			return {
				...context,
				instructions: [
					...(context.instructions ?? []),
					bindRenderedInstruction("goal.active", "volatile main goal projection", "main"),
				],
			};
		};
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: captureStreamFn,
			obfuscator,
			transformProviderContext,
		});
		const activeGoalState: GoalModeState = {
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-1",
				objective: `Return usable output from the paid <CEO> demo with ${secret}`,
				status: "active",
				tokenBudget: 100,
				tokensUsed: 55,
				timeUsedSeconds: 9,
				createdAt: 1,
				updatedAt: 1,
			},
		};
		session.setGoalModeState(activeGoalState);
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");
		await advisor.prompt("Review the active mission").catch(() => {});
		advisor.reset();
		session.setGoalModeState({
			...activeGoalState,
			enabled: false,
			mode: "exiting",
			reason: "completed",
			goal: { ...activeGoalState.goal, status: "complete", updatedAt: 2 },
		});
		await advisor.prompt("Review the completion claim").catch(() => {});

		expect(capturedContexts).toHaveLength(2);
		expect(transformTargets).toEqual(["side_model", "side_model"]);
		const missions = capturedContexts.map(
			context => context.instructions?.filter(instruction => instruction.id === "goal.advisor_mission") ?? [],
		);
		expect(missions[0]).toHaveLength(1);
		expect(missions[1]).toHaveLength(1);
		expect(capturedContexts.every(context => context.instructions?.every(item => item.target === "side_model"))).toBe(
			true,
		);
		expect(capturedContexts.every(context => context.instructions?.every(item => item.id !== "goal.active"))).toBe(
			true,
		);
		expect(missions[0]?.[0]?.target).toBe("side_model");
		expect(missions[0]?.[0]?.renderedText).toContain('status="active"');
		expect(missions[1]?.[0]?.renderedText).toContain('status="complete"');
		for (const [mission] of missions) {
			expect(mission?.renderedText).toMatch(
				/Return usable output from the paid &lt;CEO&gt; demo with \$\$[A-Z0-9]+:L\$\$/,
			);
			expect(mission?.renderedText).not.toContain("tokenBudget");
			expect(mission?.renderedText).not.toContain("tokensUsed");
			expect(mission?.renderedText).not.toContain("timeUsedSeconds");
			expect(mission?.renderedText).not.toContain(secret);
			expect(mission?.renderedText).not.toContain("ceo&lt;&amp;&gt;-demo-secret-token");
		}
	});

	it("projects a terminal mission for one successful advisor review", async () => {
		const capturedContexts: Context[] = [];
		const plainSecret = "OTHERSECRET";
		const regexSecret = "tok_abc123";
		const derivedPrefix = "TOKABC123";
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: plainSecret, friendlyName: derivedPrefix },
				{ type: "regex", content: "tok_[a-z0-9]+", mode: "replace" },
			],
			"test-key",
		);
		const successStream = (): AssistantMessageEventStream => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => successStream(),
		});
		const advisorSettings = settings();
		advisorSettings.set("advisor.syncBacklog", "1");
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: advisorSettings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (_requestModel, context) => {
				capturedContexts.push(context);
				return successStream();
			},
			obfuscator,
		});
		const activeGoalState: GoalModeState = {
			enabled: true,
			mode: "active",
			goal: {
				id: "one-shot-terminal-goal",
				objective: "Review this terminal transition exactly once",
				status: "active",
				tokenBudget: 100,
				tokensUsed: 10,
				timeUsedSeconds: 2,
				createdAt: 1,
				updatedAt: 1,
			},
		};
		session.setGoalModeState(activeGoalState);
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		await mainAgent.prompt(`Review the active mission containing ${plainSecret}`);
		session.setGoalModeState({
			...activeGoalState,
			enabled: false,
			mode: "exiting",
			reason: "completed",
			goal: {
				...activeGoalState.goal,
				objective: `Review this terminal transition exactly once with ${regexSecret}`,
				status: "complete",
				updatedAt: 2,
			},
		});
		session.setAdvisorContextPrompt("Updated context during the terminal transition");
		await mainAgent.prompt("Review the terminal transition");
		await mainAgent.prompt("Continue after the completed goal");

		expect(capturedContexts).toHaveLength(3);
		const missions = capturedContexts.map(context =>
			context.instructions?.find(instruction => instruction.id === "goal.advisor_mission"),
		);
		expect(missions[0]?.renderedText).toContain('status="active"');
		expect(missions[1]?.renderedText).toContain('status="complete"');
		expect(missions[2]).toBeUndefined();
		expect(JSON.stringify(capturedContexts[1])).not.toContain(derivedPrefix);
		expect(JSON.stringify(capturedContexts[2])).not.toContain(derivedPrefix);
	});

	it("discards a provider transform that races a semantic mission change", async () => {
		const capturedContexts: Context[] = [];
		const firstTransformStarted = Promise.withResolvers<void>();
		const releaseFirstTransform = Promise.withResolvers<void>();
		let transformCalls = 0;
		const successStream = (): AssistantMessageEventStream => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (_requestModel, context) => {
				capturedContexts.push(context);
				return successStream();
			},
			transformProviderContext: async context => {
				transformCalls++;
				if (transformCalls === 1) {
					firstTransformStarted.resolve();
					await releaseFirstTransform.promise;
				}
				return context;
			},
		});
		const oldObjective = "Do not send this stale mission";
		const newObjective = "Send only this current mission";
		const goalState = (objective: string): GoalModeState => ({
			enabled: true,
			mode: "active",
			goal: {
				id: "transform-race-goal",
				objective,
				status: "active",
				tokenBudget: 100,
				tokensUsed: 10,
				timeUsedSeconds: 2,
				createdAt: 1,
				updatedAt: 1,
			},
		});
		session.setGoalModeState(goalState(oldObjective));
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		const stalePrompt = advisor.prompt("Start the stale review").catch(() => {});
		await firstTransformStarted.promise;
		session.setGoalModeState(goalState(newObjective));
		releaseFirstTransform.resolve();
		await stalePrompt;
		advisor.reset();
		await advisor.prompt("Review the current mission");

		expect(capturedContexts).toHaveLength(1);
		const serialized = JSON.stringify(capturedContexts[0]);
		expect(serialized).toContain(newObjective);
		expect(serialized).not.toContain(oldObjective);
	});

	it("discards a transformed mission that changes during credential resolution", async () => {
		const capturedContexts: Context[] = [];
		const credentialStarted = Promise.withResolvers<void>();
		const releaseCredential = Promise.withResolvers<void>();
		const originalGetApiKey = authStorage.getApiKey.bind(authStorage);
		let delayCredential = true;
		vi.spyOn(authStorage, "getApiKey").mockImplementation(async (provider, sessionId, options) => {
			if (delayCredential) {
				delayCredential = false;
				credentialStarted.resolve();
				await releaseCredential.promise;
			}
			return originalGetApiKey(provider, sessionId, options);
		});
		const successStream = (): AssistantMessageEventStream => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (_requestModel, context) => {
				capturedContexts.push(context);
				return successStream();
			},
			transformProviderContext: async context => context,
		});
		const oldObjective = "Do not dispatch this stale mission";
		const newObjective = "Dispatch only this current mission";
		const goalState = (objective: string): GoalModeState => ({
			enabled: true,
			mode: "active",
			goal: {
				id: "credential-race-goal",
				objective,
				status: "active",
				tokenBudget: 100,
				tokensUsed: 10,
				timeUsedSeconds: 2,
				createdAt: 1,
				updatedAt: 1,
			},
		});
		session.setGoalModeState(goalState(oldObjective));
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		const stalePrompt = advisor.prompt("Start credential resolution").catch(() => {});
		await credentialStarted.promise;
		session.setGoalModeState(goalState(newObjective));
		releaseCredential.resolve();
		await stalePrompt;
		advisor.reset();
		await advisor.prompt("Review the current mission");

		expect(capturedContexts).toHaveLength(1);
		const serialized = JSON.stringify(capturedContexts[0]);
		expect(serialized).toContain(newObjective);
		expect(serialized).not.toContain(oldObjective);
	});

	it("discards a mission before a slash command awaits with a regex secret", async () => {
		const capturedContexts: Context[] = [];
		const advisorCredentialStarted = Promise.withResolvers<void>();
		const releaseAdvisorCredential = Promise.withResolvers<void>();
		const commandStarted = Promise.withResolvers<void>();
		const releaseCommand = Promise.withResolvers<void>();
		const originalGetApiKey = authStorage.getApiKey.bind(authStorage);
		let delayCredential = true;
		vi.spyOn(authStorage, "getApiKey").mockImplementation(async (provider, sessionId, options) => {
			if (delayCredential) {
				delayCredential = false;
				advisorCredentialStarted.resolve();
				await releaseAdvisorCredential.promise;
			}
			return originalGetApiKey(provider, sessionId, options);
		});
		const successStream = (): AssistantMessageEventStream => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const plainSecret = "OTHERSECRET";
		const regexSecret = "tok_abc123";
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: plainSecret, friendlyName: "TOKABC123" },
				{ type: "regex", content: "tok_[a-z0-9]+", mode: "replace" },
			],
			"test-key",
		);
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: successStream,
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (_requestModel, context) => {
				capturedContexts.push(context);
				return successStream();
			},
			obfuscator,
			transformProviderContext: async context => context,
			customCommands: [
				{
					path: "hold.ts",
					resolvedPath: "/test/hold.ts",
					source: "project",
					command: {
						name: "hold",
						description: "Hold prompt expansion",
						execute: async () => {
							commandStarted.resolve();
							await releaseCommand.promise;
						},
					},
				},
			],
		});
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "credential-secret-race-goal",
				objective: `Finish using ${plainSecret}`,
				status: "active",
				tokenBudget: 100,
				tokensUsed: 10,
				timeUsedSeconds: 2,
				createdAt: 1,
				updatedAt: 2,
			},
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		const stalePrompt = advisor.prompt("Start credential resolution").catch(() => {});
		await advisorCredentialStarted.promise;
		const activePrimaryPrompt = session.prompt(`/hold ${regexSecret}`);
		await commandStarted.promise;
		releaseAdvisorCredential.resolve();
		await stalePrompt;
		releaseCommand.resolve();
		await activePrimaryPrompt;

		expect(capturedContexts).toHaveLength(0);
	});

	it("discards a mission prepared before an @file load adds a regex secret", async () => {
		const capturedContexts: Context[] = [];
		const advisorCredentialStarted = Promise.withResolvers<void>();
		const releaseAdvisorCredential = Promise.withResolvers<void>();
		const beforeAgentStartEntered = Promise.withResolvers<void>();
		const releaseBeforeAgentStart = Promise.withResolvers<void>();
		const originalGetApiKey = authStorage.getApiKey.bind(authStorage);
		let delayCredential = true;
		vi.spyOn(authStorage, "getApiKey").mockImplementation(async (provider, sessionId, options) => {
			if (delayCredential) {
				delayCredential = false;
				advisorCredentialStarted.resolve();
				await releaseAdvisorCredential.promise;
			}
			return originalGetApiKey(provider, sessionId, options);
		});
		const successStream = (): AssistantMessageEventStream => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const plainSecret = "OTHERSECRET";
		const regexSecret = "tok_file123";
		await Bun.write(tempDir.join("secret.txt"), `Loaded content contains ${regexSecret}`);
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: plainSecret, friendlyName: "TOKFILE123" },
				{ type: "regex", content: "tok_[a-z0-9]+", mode: "replace" },
			],
			"test-key",
		);
		const extensionRunner = {
			emitBeforeAgentStart: vi.fn(async () => {
				beforeAgentStartEntered.resolve();
				await releaseBeforeAgentStart.promise;
				return undefined;
			}),
			emit: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: successStream,
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (_requestModel, context) => {
				capturedContexts.push(context);
				return successStream();
			},
			obfuscator,
			transformProviderContext: async context => context,
			extensionRunner,
		});
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "file-secret-race-goal",
				objective: `Finish using ${plainSecret}`,
				status: "active",
				tokenBudget: 100,
				tokensUsed: 10,
				timeUsedSeconds: 2,
				createdAt: 1,
				updatedAt: 2,
			},
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		const stalePrompt = advisor.prompt("Start credential resolution").catch(() => {});
		await advisorCredentialStarted.promise;
		const activePrimaryPrompt = session.prompt("Inspect @secret.txt");
		await beforeAgentStartEntered.promise;
		releaseAdvisorCredential.resolve();
		await stalePrompt;
		releaseBeforeAgentStart.resolve();
		await activePrimaryPrompt;

		expect(capturedContexts).toHaveLength(0);
	});

	it.each(lateInputCases)("discards a mission before %s", async (_case, deliverLateInput) => {
		const capturedContexts: Context[] = [];
		const credentialStarted = Promise.withResolvers<void>();
		const releaseCredential = Promise.withResolvers<void>();
		const originalGetApiKey = authStorage.getApiKey.bind(authStorage);
		let delayCredential = true;
		vi.spyOn(authStorage, "getApiKey").mockImplementation(async (provider, sessionId, options) => {
			if (delayCredential) {
				delayCredential = false;
				credentialStarted.resolve();
				await releaseCredential.promise;
			}
			return originalGetApiKey(provider, sessionId, options);
		});
		const successStream = (): AssistantMessageEventStream => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const plainSecret = "OTHERSECRET";
		const regexSecret = "tok_tan123";
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: plainSecret, friendlyName: "TOKTAN123" },
				{ type: "regex", content: "tok_[a-z0-9]+", mode: "replace" },
			],
			"test-key",
		);
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: successStream,
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (_requestModel, context) => {
				capturedContexts.push(context);
				return successStream();
			},
			obfuscator,
			transformProviderContext: async context => context,
		});
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "late-input-secret-race-goal",
				objective: `Finish using ${plainSecret}`,
				status: "active",
				tokenBudget: 100,
				tokensUsed: 10,
				timeUsedSeconds: 2,
				createdAt: 1,
				updatedAt: 2,
			},
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		const stalePrompt = advisor.prompt("Start credential resolution").catch(() => {});
		await credentialStarted.promise;
		await deliverLateInput(session, mainAgent, regexSecret);
		releaseCredential.resolve();
		await stalePrompt;

		expect(capturedContexts).toHaveLength(0);
	});
	it("carries sensitive-value validation to deferred provider dispatch", async () => {
		const dispatchedContexts: Context[] = [];
		const dispatchStarted = Promise.withResolvers<void>();
		const releaseDispatch = Promise.withResolvers<void>();
		const plainSecret = "OTHERSECRET";
		const regexSecret = "tok_abc123";
		const derivedPrefix = "TOKABC123";
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: plainSecret, friendlyName: derivedPrefix },
				{ type: "regex", content: "tok_[a-z0-9]+", mode: "replace" },
			],
			"test-key",
		);
		const successStream = (): AssistantMessageEventStream => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: successStream,
		});
		let firstPreparedContext: Context | undefined;
		let requestCount = 0;
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (_requestModel, context, options) => {
				requestCount++;
				if (requestCount > 1) {
					dispatchedContexts.push(context);
					return successStream();
				}
				firstPreparedContext = context;
				const stream = new AssistantMessageEventStream();
				void (async () => {
					dispatchStarted.resolve();
					await releaseDispatch.promise;
					try {
						options?.providerDispatchGuard?.();
						dispatchedContexts.push(context);
						const message = createAssistantMessage("ok");
						stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					} catch (error) {
						stream.fail(error);
					}
				})();
				return stream;
			},
			obfuscator,
			transformProviderContext: async context => context,
		});
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "deferred-secret-race-goal",
				objective: `Finish using ${plainSecret}`,
				status: "active",
				tokenBudget: 100,
				tokensUsed: 10,
				timeUsedSeconds: 2,
				createdAt: 1,
				updatedAt: 2,
			},
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		const stalePrompt = advisor.prompt("Wait before provider dispatch").catch(() => {});
		await dispatchStarted.promise;
		expect(JSON.stringify(firstPreparedContext)).toContain(derivedPrefix);
		mainAgent.appendMessage({
			role: "toolResult",
			toolCallId: "tool-secret",
			toolName: "read",
			content: [{ type: "text", text: `Tool output contains ${regexSecret}` }],
			isError: false,
			timestamp: Date.now(),
		});
		releaseDispatch.resolve();
		await stalePrompt;

		expect(dispatchedContexts).not.toContain(firstPreparedContext);
	});

	it("suppresses a persisted terminal mission after mode reconciliation and tree navigation", async () => {
		const capturedContexts: Context[] = [];
		const captureStreamFn: StreamFn = (_m, context) => {
			capturedContexts.push(context);
			throw new Error("capture-stop");
		};
		const rootEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Keep this branch point" }],
			timestamp: Date.now(),
		});
		const abandonedObjective = "Ship the abandoned terminal objective";
		sessionManager.appendModeChange("goal", {
			goal: {
				id: "abandoned-goal",
				objective: abandonedObjective,
				status: "complete",
				tokenBudget: 100,
				tokensUsed: 100,
				timeUsedSeconds: 10,
				createdAt: 1,
				updatedAt: 2,
			},
		});
		const mainAgent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: captureStreamFn,
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const rehydratedTerminalState = session.getGoalModeState();
		if (!rehydratedTerminalState) throw new Error("Expected persisted terminal goal state");
		session.setGoalModeState(undefined);
		session.rehydrateGoalModeState(rehydratedTerminalState);

		const abandonedAdvisor = session.getAdvisorAgent();
		if (!abandonedAdvisor) throw new Error("Expected advisor agent to be live");
		await abandonedAdvisor.prompt("Review the terminal mission").catch(() => {});

		const navigation = await session.navigateTree(rootEntryId);
		expect(navigation.cancelled).toBe(false);
		const currentAdvisor = session.getAdvisorAgent();
		if (!currentAdvisor) throw new Error("Expected advisor agent after history rewrite");
		await currentAdvisor.prompt("Review the current mission").catch(() => {});

		expect(capturedContexts).toHaveLength(2);
		const missions = capturedContexts.map(context =>
			context.instructions?.find(instruction => instruction.id === "goal.advisor_mission"),
		);
		expect(missions[0]).toBeUndefined();
		expect(JSON.stringify(capturedContexts[0])).not.toContain(abandonedObjective);
		expect(missions[1]).toBeUndefined();
	});

	it("drops a persisted terminal mission at a reset boundary", async () => {
		const capturedContexts: Context[] = [];
		const terminalObjective = "Do not revive this completed objective after clear";
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Finish the terminal work" }],
			timestamp: 1,
		});
		sessionManager.appendModeChange("goal", {
			goal: {
				id: "terminal-reset-goal",
				objective: terminalObjective,
				status: "complete",
				tokenBudget: 100,
				tokensUsed: 100,
				timeUsedSeconds: 10,
				createdAt: 1,
				updatedAt: 2,
			},
		});
		const mainAgent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (_requestModel, context) => {
				capturedContexts.push(context);
				throw new Error("capture-stop");
			},
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		await expect(session.resetSessionContext()).resolves.toEqual({ droppedCount: 1 });
		expect(session.getGoalModeState()).toBeUndefined();
		expect(sessionManager.buildSessionContext().mode).toBe("none");
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent after reset");
		await advisor.prompt("Review the reset session").catch(() => {});

		expect(capturedContexts).toHaveLength(1);
		const firstRequest = capturedContexts[0];
		expect(
			firstRequest?.instructions?.find(instruction => instruction.id === "goal.advisor_mission"),
		).toBeUndefined();
		expect(JSON.stringify(firstRequest)).not.toContain(terminalObjective);
	});

	it("omits a completed outgoing goal from the first advisor request after handoff", async () => {
		const capturedContexts: Context[] = [];
		const completedObjective = "Do not carry this completed objective into the handoff session";
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Finish the outgoing work" }],
			timestamp: 1,
		});
		sessionManager.appendMessage(createAssistantMessage("The outgoing work is complete"));
		sessionManager.appendModeChange("goal", {
			goal: {
				id: "completed-handoff-goal",
				objective: completedObjective,
				status: "complete",
				tokenBudget: 100,
				tokensUsed: 100,
				timeUsedSeconds: 10,
				createdAt: 1,
				updatedAt: 2,
			},
		});
		const mainAgent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const handoffSettings = settings();
		handoffSettings.set("goal.enabled", true);
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: handoffSettings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (_requestModel, context) => {
				capturedContexts.push(context);
				throw new Error("capture-stop");
			},
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");

		await session.handoff();
		const replacementAdvisor = session.getAdvisorAgent();
		if (!replacementAdvisor) throw new Error("Expected advisor agent after handoff");
		await replacementAdvisor.prompt("Review the replacement session").catch(() => {});

		expect(capturedContexts).toHaveLength(1);
		const firstRequest = capturedContexts[0];
		expect(
			firstRequest?.instructions?.find(instruction => instruction.id === "goal.advisor_mission"),
		).toBeUndefined();
		expect(JSON.stringify(firstRequest)).not.toContain(completedObjective);
	});

	it("retains regex secrets from deliveries preserved across handoff", async () => {
		const capturedContexts: Context[] = [];
		const plainSecret = "OTHERSECRET";
		const regexSecret = "ABC12345";
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: plainSecret, friendlyName: regexSecret },
				{ type: "regex", content: "(?<=token=)[A-Z0-9]{8}", mode: "replace" },
			],
			"test-key",
		);
		sessionManager.appendMessage({ role: "user", content: "Prepare the handoff", timestamp: 1 });
		sessionManager.appendMessage(createAssistantMessage("Ready to hand off"));
		const mainAgent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const handoffSettings = settings();
		handoffSettings.set("goal.enabled", true);
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: handoffSettings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (_requestModel, context) => {
				capturedContexts.push(context);
				throw new Error("capture-stop");
			},
			obfuscator,
			transformProviderContext: context => obfuscateProviderContext(obfuscator, context),
		});
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "preserved-queue-secret-goal",
				objective: `Finish using ${plainSecret}`,
				status: "active",
				tokenBudget: 100,
				tokensUsed: 10,
				timeUsedSeconds: 2,
				createdAt: 1,
				updatedAt: 2,
			},
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		mainAgent.followUp({ role: "user", content: `queued token=${regexSecret}`, timestamp: 3 });
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");

		await session.handoff();
		const replacementAdvisor = session.getAdvisorAgent();
		if (!replacementAdvisor) throw new Error("Expected advisor agent after handoff");
		await replacementAdvisor.prompt("Review the replacement session").catch(() => {});

		expect(capturedContexts).toHaveLength(1);
		const serialized = JSON.stringify(capturedContexts[0]);
		expect(serialized).not.toContain(plainSecret);
		expect(serialized).not.toContain(regexSecret);
	});

	it("chooses collision-safe placeholders when inherited transforms redact advisor messages first", async () => {
		const capturedContexts: Context[] = [];
		const captureStreamFn: StreamFn = (_m, context) => {
			capturedContexts.push(context);
			throw new Error("capture-stop");
		};
		const plainSecret = "OTHERSECRET";
		const regexSecret = "tok_abc123";
		const derivedPrefix = "TOKABC123";
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: plainSecret, friendlyName: derivedPrefix },
				{ type: "regex", content: "tok_[a-z0-9]+", mode: "replace" },
			],
			"test-key",
		);
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: captureStreamFn,
			obfuscator,
			transformProviderContext: async context => obfuscateProviderContext(obfuscator, context),
		});
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-collision",
				objective: `Finish <mission> & preserve ${plainSecret}`,
				status: "active",
				tokenBudget: 100,
				tokensUsed: 10,
				timeUsedSeconds: 2,
				createdAt: 1,
				updatedAt: 2,
			},
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");
		await advisor.prompt(`Review the result containing ${regexSecret}`).catch(() => {});

		expect(capturedContexts).toHaveLength(1);
		const serialized = JSON.stringify(capturedContexts[0]);
		expect(serialized).not.toContain(plainSecret);
		expect(serialized).not.toContain(regexSecret);
		expect(serialized).not.toContain(derivedPrefix);
		const mission = capturedContexts[0]?.instructions?.find(instruction => instruction.id === "goal.advisor_mission");
		expect(mission?.renderedText).toContain("Finish &lt;mission&gt; &amp; preserve");
	});

	it("uses retained primary regex secrets when an advisor starts after session resume", async () => {
		const capturedContexts: Context[] = [];
		const plainSecret = "OTHERSECRET";
		const regexSecret = "tok_abc123";
		const derivedPrefix = "TOKABC123";
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: plainSecret, friendlyName: derivedPrefix },
				{ type: "regex", content: "tok_[a-z0-9]+", mode: "replace" },
			],
			"test-key",
		);
		const mainStreamFn: StreamFn = () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const mainAgent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [{ role: "user", content: `Resumed primary delta contains ${regexSecret}`, timestamp: 1 }],
			},
			streamFn: mainStreamFn,
		});
		const advisorSettings = settings();
		advisorSettings.set("advisor.syncBacklog", "1");
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: advisorSettings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: (_requestModel, context) => {
				capturedContexts.push(context);
				throw new Error("capture-stop");
			},
			obfuscator,
		});
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-retained-regex-collision",
				objective: `Finish using ${plainSecret}`,
				status: "active",
				tokenBudget: 100,
				tokensUsed: 10,
				timeUsedSeconds: 2,
				createdAt: 1,
				updatedAt: 2,
			},
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		await advisor.prompt("Review the retained mission").catch(() => {});

		expect(capturedContexts).toHaveLength(1);
		const serialized = JSON.stringify(capturedContexts[0]);
		expect(serialized).not.toContain(plainSecret);
		expect(serialized).not.toContain(regexSecret);
		expect(serialized).not.toContain(derivedPrefix);
	});

	it("retains extension-injected provider messages for later advisor missions", async () => {
		const provider = "mission-wire-provider";
		const api = "mission-wire-api";
		const modelId = "mission-wire-model";
		const plainSecret = "OTHERSECRET";
		const regexSecret = "tok_abc123";
		const derivedPrefix = "TOKABC123";
		await Bun.write(
			tempDir.join(".omp/secrets.yml"),
			`- type: plain\n  content: ${plainSecret}\n  friendlyName: ${derivedPrefix}\n- type: regex\n  content: tok_[a-z0-9]+\n  mode: replace\n`,
		);
		const sourceId = "<inline-0>";
		const sdkAuthStorage = createInMemoryAuthStorage();
		const sdkModelRegistry = new ModelRegistry(sdkAuthStorage, tempDir.join("mission-models.yml"));
		const capturedContexts: Context[] = [];
		const providerExtension: ExtensionFactory = pi => {
			let injectedPrimaryContext = false;
			pi.on("context", event => {
				if (injectedPrimaryContext) return undefined;
				injectedPrimaryContext = true;
				return {
					messages: [
						...event.messages,
						{
							role: "user",
							content: `Extension-only provider message contains ${regexSecret}`,
							timestamp: 2,
						} satisfies AgentMessage,
					],
				};
			});
			pi.registerProvider(provider, {
				baseUrl: "http://127.0.0.1:8080/v1",
				apiKey: "test-key",
				api,
				streamSimple: (_requestModel, context) => {
					capturedContexts.push(context);
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const message = createAssistantMessage("ok");
						stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					});
					return stream;
				},
				models: [
					{
						id: modelId,
						name: "Mission wire model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 4096,
						maxTokens: 1024,
					},
				],
			});
		};
		const sdkSettings = Settings.isolated({ "compaction.enabled": false, "secrets.enabled": true });
		sdkSettings.setModelRole("default", `${provider}/${modelId}`);
		sdkSettings.setModelRole("advisor", `${provider}/${modelId}`);

		try {
			const created = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage: sdkAuthStorage,
				modelRegistry: sdkModelRegistry,
				settings: sdkSettings,
				disableExtensionDiscovery: true,
				extensions: [providerExtension],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			session = created.session;
			await session.prompt("Prepare the primary context");
			expect(capturedContexts).toHaveLength(1);
			capturedContexts.length = 0;
			session.setGoalModeState({
				enabled: true,
				mode: "active",
				goal: {
					id: "sdk-goal",
					objective: `Deliver the SDK mission through the real provider transform with ${plainSecret}`,
					status: "active",
					tokenBudget: 100,
					tokensUsed: 20,
					timeUsedSeconds: 3,
					createdAt: 1,
					updatedAt: 1,
				},
			});
			expect(session.setAdvisorEnabled(true)).toBe(true);
			const advisor = session.getAdvisorAgent();
			if (!advisor) throw new Error("Expected SDK-created advisor agent");
			await advisor.prompt("Inspect the mission");

			expect(capturedContexts).toHaveLength(1);
			const delivered = capturedContexts[0]?.instructions ?? [];
			const missions = delivered.filter(instruction => instruction.id === "goal.advisor_mission");
			expect(missions).toHaveLength(1);
			expect(delivered.every(instruction => instruction.target === "side_model")).toBe(true);
			expect(delivered.some(instruction => instruction.id === "goal.active")).toBe(false);
			expect(missions[0]?.renderedText).toContain("Deliver the SDK mission through the real provider transform");
			expect(missions[0]?.renderedText).not.toContain("tokensUsed");
			const serialized = JSON.stringify(capturedContexts[0]);
			expect(serialized).not.toContain(plainSecret);
			expect(serialized).not.toContain(regexSecret);
			expect(serialized).not.toContain(derivedPrefix);
		} finally {
			await session?.dispose();
			sdkModelRegistry.clearSourceRegistrations(sourceId);
			sdkAuthStorage.close();
		}
	});

	it("caps Codex SSE attempts inside each advisor-level retry", async () => {
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		const capturedStreamOptions: Array<SimpleStreamOptions | undefined> = [];
		const capturedModels: Model[] = [];
		let requestCount = 0;
		const fetchMock: FetchImpl = async () => {
			requestCount += 1;
			throw new TypeError("The socket connection was closed unexpectedly");
		};
		const captureStreamFn: StreamFn = (requestModel, context, opts) => {
			capturedModels.push(requestModel);
			capturedStreamOptions.push(opts);
			return streamSimple(requestModel, context, { ...opts, preferWebsockets: false, fetch: fetchMock });
		};
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: captureStreamFn,
		});
		session.settings.setModelRole("advisor", "openai-codex/gpt-5.6-sol");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");
		await advisor.prompt("ping").catch(() => {});

		expect(capturedModels[0]?.api).toBe("openai-codex-responses");
		expect(capturedStreamOptions[0]?.codexSseMaxAttempts).toBe(1);
		expect(requestCount).toBe(1);
		expect(advisor.state.error).toContain("socket connection was closed unexpectedly");
	});

	it("reuses the main agent's providerPromptCacheKey unchanged so tan/shared sessions stay on the parent shard", () => {
		// Regression for codex-connector review on #3640: when the SDK pins
		// `agent.promptCacheKey` (tan/shared-session callers do this to share
		// the parent provider cache while keeping a distinct providerSessionId),
		// the advisor MUST pass that key through unchanged or it cannot read the
		// exact shard populated by the parent turn.
		const parentPromptCacheKey = "tan-parent-cache-key";
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			promptCacheKey: parentPromptCacheKey,
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		// Explicit provider cache keys are shared byte-for-byte with the parent
		// live turn; only the provider session id stays advisor-scoped.
		expect(advisor.promptCacheKey).toBe(parentPromptCacheKey);
		// Session id remains a distinct provider-facing UUIDv7 (issue #5040) so
		// credential stickiness and session-keyed telemetry stay distinct from
		// the parent.
		expect(advisor.sessionId).toMatch(UUID_V7_PATTERN);
		expect(advisor.sessionId).not.toBe(advisor.promptCacheKey);
	});

	it("propagates the advisor's own provider session id via metadata.user_id, distinct from the main agent", async () => {
		// Regression for #6625: the separately constructed advisor Agent had no
		// metadata resolver, so its outbound Anthropic request omitted the
		// `metadata.user_id` session identity that AgentSession installs for the
		// main/subagent agents — custom proxies saw advisor traffic with no
		// stable session id to route or attribute on.
		const capturedStreamOptions: Array<SimpleStreamOptions | undefined> = [];
		const captureStreamFn: StreamFn = (_m, _ctx, opts) => {
			capturedStreamOptions.push(opts);
			throw new Error("capture-stop");
		};
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: captureStreamFn,
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor?.sessionId) throw new Error("Expected advisor agent with a provider session id");

		await advisor.prompt("ping").catch(() => {});

		const opts = capturedStreamOptions[0];
		if (!opts) throw new Error("Expected captured advisor stream options");

		// The advisor request must carry a non-empty session id keyed to the
		// advisor's own provider-facing UUIDv7, not the parent session id.
		expect(metadataSessionId(opts)).toBe(advisor.sessionId);

		// Distinct from the main agent's session identity (both non-empty).
		expect(metadataSessionId({ metadata: mainAgent.metadataForProvider("anthropic") })).toBeTruthy();
		expect(metadataSessionId(opts)).not.toBe(
			metadataSessionId({ metadata: mainAgent.metadataForProvider("anthropic") }),
		);
	});

	it("refreshes the advisor provider session identity after starting a new session", async () => {
		const capturedStreamOptions: Array<SimpleStreamOptions | undefined> = [];
		const captureStreamFn: StreamFn = (_m, _ctx, opts) => {
			capturedStreamOptions.push(opts);
			throw new Error("capture-stop");
		};
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: captureStreamFn,
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor?.sessionId) throw new Error("Expected advisor agent with a provider session id");
		const previousAdvisorSessionId = advisor.sessionId;

		expect(await session.newSession()).toBe(true);
		expect(session.getAdvisorAgent()).toBe(advisor);
		expect(advisor.sessionId).toMatch(UUID_V7_PATTERN);
		expect(advisor.sessionId).not.toBe(previousAdvisorSessionId);
		expect(advisor.sessionId).not.toBe(mainAgent.sessionId);
		expect(advisor.promptCacheKey).toBe(advisor.sessionId);

		await advisor.prompt("ping").catch(() => {});

		expect(metadataSessionId(capturedStreamOptions[0])).toBe(advisor.sessionId);
		expect(metadataSessionId(capturedStreamOptions[0])).not.toBe(previousAdvisorSessionId);
	});

	it("refreshes the advisor provider session identity on a fork that skips advisor re-prime", async () => {
		// Regression for #6625 review: `fork()` (like a branch whose hook returns
		// `skipConversationRestore`) updates the primary provider identity via
		// `#syncAgentSessionId()` WITHOUT running `resetSessionState()`. The advisor
		// must still rebind to the new provider session id instead of emitting the
		// pre-fork one.
		const capturedStreamOptions: Array<SimpleStreamOptions | undefined> = [];
		const captureStreamFn: StreamFn = (_m, _ctx, opts) => {
			capturedStreamOptions.push(opts);
			throw new Error("capture-stop");
		};
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: captureStreamFn,
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor?.sessionId) throw new Error("Expected advisor agent with a provider session id");
		const previousAdvisorSessionId = advisor.sessionId;

		expect(await session.fork()).toBe(true);
		expect(session.getAdvisorAgent()).toBe(advisor);
		expect(advisor.sessionId).toMatch(UUID_V7_PATTERN);
		expect(advisor.sessionId).not.toBe(previousAdvisorSessionId);
		expect(advisor.sessionId).not.toBe(mainAgent.sessionId);
		// Fork inherits the parent's provider prompt-cache key (shared shard), so it
		// stays pinned to the main agent's key rather than the advisor's own id.
		expect(advisor.promptCacheKey).toBe(mainAgent.promptCacheKey);

		await advisor.prompt("ping").catch(() => {});

		expect(metadataSessionId(capturedStreamOptions[0])).toBe(advisor.sessionId);
		expect(metadataSessionId(capturedStreamOptions[0])).not.toBe(previousAdvisorSessionId);
	});
});
