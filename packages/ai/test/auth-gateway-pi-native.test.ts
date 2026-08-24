import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { streamPiNative } from "@oh-my-pi/pi-ai/providers/pi-native-client";
import type {
	PiNativeBoundaryApprovalDecision,
	PiNativeBoundaryPreparationEvent,
} from "@oh-my-pi/pi-ai/providers/pi-native-server";
import { encodeStream, formatError, parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	ModelSpec,
	Usage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type GetChatMessageRequest,
	GetChatMessageRequestSchema,
	GetUserJwtResponseSchema,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { readSseJson } from "@oh-my-pi/pi-utils";

function makeEventStream(events: AssistantMessageEvent[], final: AssistantMessage): AssistantMessageEventStream {
	async function* iter() {
		for (const e of events) yield e;
	}
	const stream = iter() as unknown as AssistantMessageEventStream;
	(stream as { result(): Promise<AssistantMessage> }).result = async () => final;
	return stream;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<string[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
	}
	buf += decoder.decode();
	return buf.split("\n\n").filter(s => s.length > 0);
}

function parseSseLine(line: string): unknown {
	const stripped = line.replace(/^data: /, "");
	if (stripped === "[DONE]") return "[DONE]";
	return JSON.parse(stripped);
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function baseAssistant(overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

const baseContext: Context = {
	systemPrompt: ["you are helpful"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

describe("pi-native parseRequest", () => {
	it("preserves typed instruction semantics for provider-side mapping", () => {
		const instruction = {
			id: "goal.continuation",
			sourcePath: "packages/coding-agent/src/prompts/goals/continuation.md",
			role: "internal_context" as const,
			target: "main" as const,
			trigger: "goal-continuation",
			sha256: "test-sha256",
			renderedText: "Continue the active goal without overriding the user.",
		};
		const parsed = parseRequest({
			modelId: "claude-sonnet-4-5",
			context: { ...baseContext, instructions: [instruction] },
		});

		expect(parsed.context.instructions).toEqual([instruction]);
	});

	it("accepts modelId + context and returns canonical shape", () => {
		const parsed = parseRequest({
			modelId: "claude-sonnet-4-5",
			context: baseContext,
			options: { temperature: 0.5, reasoning: Effort.High },
			stream: false,
		});
		expect(parsed.modelId).toBe("claude-sonnet-4-5");
		expect(parsed.context).toEqual(baseContext);
		expect(parsed.options.temperature).toBe(0.5);
		expect(parsed.options.reasoning).toBe(Effort.High);
		expect(parsed.stream).toBe(false);
	});

	it("falls back to model.id when modelId is absent (streamProxy compat)", () => {
		const parsed = parseRequest({
			model: {
				id: "claude-opus-4-1",
				provider: "anthropic",
				api: "anthropic-messages",
			},
			context: baseContext,
		});
		expect(parsed.modelId).toBe("claude-opus-4-1");
	});

	it("accepts top-level string `model` as the id (extra compat)", () => {
		const parsed = parseRequest({
			model: "gpt-5",
			context: baseContext,
		});
		expect(parsed.modelId).toBe("gpt-5");
	});

	it("defaults stream to true when omitted", () => {
		const parsed = parseRequest({ modelId: "x", context: baseContext });
		expect(parsed.stream).toBe(true);
	});

	it("drops server-controlled and unknown option keys", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: {
				temperature: 0.2,
				cachedContent: "cachedContents/caller-owned-corpus",
				apiKey: "should-be-stripped",
				signal: {},
				fetch: () => {},
				onPayload: () => {},
				onResponse: () => {},
				onSseEvent: () => {},
				execHandlers: {},
				providerSessionState: new Map(),
				notARealField: "ignored",
			},
		});
		expect(parsed.options).toEqual({
			temperature: 0.2,
			cachedContent: "cachedContents/caller-owned-corpus",
		});
		expect("apiKey" in parsed.options).toBe(false);
		expect("signal" in parsed.options).toBe(false);
		expect("fetch" in parsed.options).toBe(false);
		expect("onPayload" in parsed.options).toBe(false);
		expect("onResponse" in parsed.options).toBe(false);
		expect("onSseEvent" in parsed.options).toBe(false);
		expect("notARealField" in parsed.options).toBe(false);
	});

	it("preserves loopGuard so the remote cook pass can disable the server-side guard", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: { loopGuard: { enabled: false } },
		});
		expect(parsed.options.loopGuard).toEqual({ enabled: false });
	});

	it("forwards acceptEmptyResponse so a passive Google advisor can accept silence server-side", () => {
		const parsed = parseRequest({
			modelId: "google/gemini-3.6-flash",
			context: baseContext,
			options: { acceptEmptyResponse: true },
		});
		expect(parsed.options.acceptEmptyResponse).toBe(true);
	});

	it("forwards an explicit statefulResponses disablement to the native stream", () => {
		const parsed = parseRequest({
			modelId: "openai/gpt-5",
			context: baseContext,
			options: { promptCacheKey: "bench-cache-pair", statefulResponses: false },
		});
		expect(parsed.options.promptCacheKey).toBe("bench-cache-pair");
		expect(parsed.options.statefulResponses).toBe(false);
	});

	it("preserves headers, metadata, sessionId, thinkingBudgets, and hidden thinking summaries", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: {
				headers: { "x-foo": "bar" },
				metadata: { user_id: "u" },
				sessionId: "explicit-session",
				thinkingBudgets: { high: 8192 },
				hideThinkingSummary: true,
				stopSequences: ["\n\n"],
				toolChoice: "required",
				serviceTier: "priority",
				cacheRetention: "long",
			},
		});
		expect(parsed.options.headers).toEqual({ "x-foo": "bar" });
		expect(parsed.options.metadata).toEqual({ user_id: "u" });
		expect(parsed.options.sessionId).toBe("explicit-session");
		expect(parsed.options.thinkingBudgets).toEqual({ high: 8192 });
		expect(parsed.options.hideThinkingSummary).toBe(true);
		expect(parsed.options.stopSequences).toEqual(["\n\n"]);
		expect(parsed.options.toolChoice).toBe("required");
		expect(parsed.options.serviceTier).toBe("priority");
		expect(parsed.options.cacheRetention).toBe("long");
	});
	it("preserves Bedrock guardrails in the canonical options bag", () => {
		const parsed = parseRequest({
			modelId: "amazon-bedrock/amazon.nova-lite-v1:0",
			context: baseContext,
			options: {
				guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/example",
				guardrailVersion: "7",
				guardrailTrace: "enabled_full",
			},
		});

		expect(parsed.options).toMatchObject({
			guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/example",
			guardrailVersion: "7",
			guardrailTrace: "enabled_full",
		});
	});

	it("forwards the explicit prompt-cache policy through the canonical options bag", () => {
		const parsed = parseRequest({
			modelId: "gpt-5.6",
			context: baseContext,
			options: {
				promptCache: { mode: "explicit", ttl: "30m", breakpoint: "none" },
			},
		});

		expect(parsed.options.promptCache).toEqual({
			mode: "explicit",
			ttl: "30m",
			breakpoint: "none",
		});
	});

	it("rejects missing required fields", () => {
		expect(() => parseRequest({ context: baseContext })).toThrow(/modelId/);
		expect(() => parseRequest({ modelId: "x" })).toThrow(/context/);
		expect(() => parseRequest({ modelId: "x", context: { systemPrompt: [] } })).toThrow(/messages/);
	});

	it("rejects non-object body", () => {
		expect(() => parseRequest(null)).toThrow();
		expect(() => parseRequest("hello")).toThrow();
		expect(() => parseRequest([])).toThrow();
	});

	it("validates instruction, systemPrompt, and tools container shapes", () => {
		expect(() =>
			parseRequest({
				modelId: "x",
				context: { systemPrompt: "not array", messages: [] },
			}),
		).toThrow(/systemPrompt/);
		expect(() =>
			parseRequest({
				modelId: "x",
				context: { instructions: "not array", messages: [] },
			}),
		).toThrow(/instructions/);
		expect(() =>
			parseRequest({
				modelId: "x",
				context: { messages: [], tools: "not array" },
			}),
		).toThrow(/tools/);
	});

	it("skips null and undefined option values", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: { temperature: null, topP: undefined, maxTokens: 100 },
		});
		expect("temperature" in parsed.options).toBe(false);
		expect("topP" in parsed.options).toBe(false);
		expect(parsed.options.maxTokens).toBe(100);
	});
});

describe("pi-native gateway cache controls", () => {
	it("suspends the final provider payload and sends the approved replacement bytes", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pi-native-guard-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openai", "provider-secret-key");
		let upstreamCalls = 0;
		let upstreamBody = "";
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async req => {
				upstreamCalls++;
				upstreamBody = await req.text();
				return new Response(
					`${[
						{
							id: "chatcmpl-boundary",
							object: "chat.completion.chunk",
							created: 0,
							model: "replacement-wire-model",
							choices: [{ index: 0, delta: { content: "ok" } }],
						},
						{
							id: "chatcmpl-boundary",
							object: "chat.completion.chunk",
							created: 0,
							model: "replacement-wire-model",
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						},
					]
						.map(event => `data: ${JSON.stringify(event)}\n\n`)
						.join("")}data: [DONE]\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const providerModel = buildModel({
			id: "gateway-final-model",
			name: "Gateway Final Model",
			api: "openai-completions",
			provider: "openai",
			baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
			headers: { "x-provider-secret": "provider-header-secret" },
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
			compat: { supportsDeveloperRole: true },
		} as ModelSpec<"openai-completions">);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-token"],
			storage,
			resolveModel: () => providerModel,
			version: "test",
		});

		try {
			const clientModel = {
				...providerModel,
				id: "requested-alias",
				name: "Requested Alias",
				compat: { ...providerModel.compat, supportsDeveloperRole: false },
				baseUrl: handle.url,
				headers: undefined,
				transport: "pi-native" as const,
			} satisfies Model<Api>;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let observedPayload: Record<string, unknown> | undefined;
			let observedModel: Model<Api> | undefined;
			let replacementPayload: Record<string, unknown> | undefined;
			const result = streamPiNative(clientModel, baseContext, {
				apiKey: "gateway-token",
				onPayload: async (payload, model) => {
					observedPayload = payload as Record<string, unknown>;
					observedModel = model;
					replacementPayload = {
						...observedPayload,
						model: "replacement-wire-model",
					};
					entered.resolve();
					await release.promise;
					return replacementPayload;
				},
			}).result();
			await entered.promise;
			expect(upstreamCalls).toBe(0);
			expect(observedPayload?.model).toBe(providerModel.id);
			const { baseUrl: _baseUrl, headers: _headers, transport: _transport, ...safeModel } = providerModel;
			expect(observedModel).toEqual({ ...safeModel, baseUrl: "" });
			expect(JSON.stringify(observedModel)).not.toContain("provider-secret");
			release.resolve();
			await result;

			expect(upstreamCalls).toBe(1);
			expect(upstreamBody).toBe(JSON.stringify(replacementPayload));
		} finally {
			await handle.close();
			upstream.stop(true);
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("protects Devin auth while rehydrating the approved request at the protobuf boundary", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pi-native-devin-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("devin", "provider-secret");
		const authPayload = toBinary(
			GetUserJwtResponseSchema,
			create(GetUserJwtResponseSchema, { userJwt: "provider-user-jwt" }),
		);
		let chatRequests = 0;
		let outboundRequest: GetChatMessageRequest | undefined;
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async req => {
				if (new URL(req.url).pathname.endsWith("/GetUserJwt")) return new Response(authPayload);
				chatRequests++;
				const frame = new Uint8Array(await req.arrayBuffer());
				const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1, false);
				outboundRequest = fromBinary(GetChatMessageRequestSchema, gunzipSync(frame.subarray(5, 5 + length)));
				return new Response(new Uint8Array());
			},
		});
		const providerModel = buildModel({
			id: "devin-final-model",
			name: "Devin Final Model",
			api: "devin-agent",
			provider: "devin",
			baseUrl: `http://127.0.0.1:${upstream.port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		} as ModelSpec<"devin-agent">);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-token"],
			storage,
			resolveModel: () => providerModel,
			version: "test",
		});
		const clientModel = { ...providerModel, baseUrl: handle.url, transport: "pi-native" as const };
		const context: Context = {
			messages: [{ role: "user", content: "use probe", timestamp: 0 }],
			tools: [
				{
					name: "probe",
					description: "Probe a value",
					parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
				},
			],
		};

		try {
			let observedPayload: unknown;
			let observedContracts: unknown;
			const result = await streamPiNative(clientModel, context, {
				apiKey: "gateway-token",
				onPayload: payload => {
					observedPayload = payload;
					return { ...(payload as Record<string, unknown>), prompt: "approved Devin prompt" };
				},
				onToolContracts: payload => {
					observedContracts = payload;
				},
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(observedPayload).toMatchObject({ metadata: { apiKey: "", userJwt: "" } });
			expect(JSON.stringify(observedPayload)).not.toContain("provider-secret");
			expect(JSON.stringify(observedPayload)).not.toContain("provider-user-jwt");
			expect(observedContracts).toMatchObject({ tools: [{ name: "probe", description: "Probe a value" }] });
			expect(chatRequests).toBe(1);
			expect(outboundRequest?.prompt).toBe("approved Devin prompt");
			expect(outboundRequest?.metadata?.apiKey).toBe("devin-session-token$provider-secret");
			expect(outboundRequest?.metadata?.userJwt).toBe("provider-user-jwt");

			const rejected = await streamPiNative(clientModel, context, {
				apiKey: "gateway-token",
				onPayload: payload => ({
					...(payload as Record<string, unknown>),
					metadata: {
						...((payload as { metadata: Record<string, unknown> }).metadata ?? {}),
						apiKey: "attacker-key",
						userJwt: "attacker-jwt",
					},
				}),
			}).result();
			expect(rejected.stopReason).toBe("error");
			expect(rejected.errorMessage).toContain("cannot inject or rebind provider credentials");
			expect(chatRequests).toBe(1);
		} finally {
			await handle.close();
			upstream.stop(true);
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("enforces terminal tamper, bearer anti-DoS, replay, expiry, cancel, and restart custody", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pi-native-custody-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openai", "provider-key");
		let upstreamCalls = 0;
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				upstreamCalls++;
				return new Response(
					`data: ${JSON.stringify({
						id: "chatcmpl-custody",
						object: "chat.completion.chunk",
						created: 0,
						model: "custody-model",
						choices: [{ index: 0, delta: { content: "ok" } }],
					})}\n\ndata: ${JSON.stringify({
						id: "chatcmpl-custody",
						object: "chat.completion.chunk",
						created: 0,
						model: "custody-model",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					})}\n\ndata: [DONE]\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const providerModel = buildModel({
			id: "custody-model",
			name: "Custody Model",
			api: "openai-completions",
			provider: "openai",
			baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		} as ModelSpec<"openai-completions">);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-token", "other-valid-token"],
			storage,
			resolveModel: () => providerModel,
			boundaryApprovalTtlMs: 80,
			version: "test",
		});
		const clientModel = {
			...providerModel,
			baseUrl: handle.url,
			transport: "pi-native" as const,
		} satisfies Model<Api>;
		let handleClosed = false;

		try {
			const legacyBoundary = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer gateway-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: providerModel.id,
					context: baseContext,
					stream: true,
					boundaryApproval: { version: 1, payload: true, toolContracts: false },
				}),
			});
			expect(legacyBoundary.status).toBe(400);
			expect(await legacyBoundary.text()).toContain(
				"pi-native boundary approval requires /v1/pi/boundary-stream/v1",
			);

			const unprotectedBoundaryRoute = await fetch(`${handle.url}/v1/pi/boundary-stream/v1`, {
				method: "POST",
				headers: { Authorization: "Bearer gateway-token", "Content-Type": "application/json" },
				body: JSON.stringify({ modelId: providerModel.id, context: baseContext, stream: true }),
			});
			expect(unprotectedBoundaryRoute.status).toBe(400);
			expect(await unprotectedBoundaryRoute.text()).toContain(
				"pi-native boundary stream requires at least one approval callback",
			);

			const unsupportedTools = await fetch(`${handle.url}/v1/pi/boundary-stream/v1`, {
				method: "POST",
				headers: {
					Authorization: "Bearer gateway-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					modelId: providerModel.id,
					context: baseContext,
					stream: true,
					boundaryApproval: {
						version: 1,
						payload: false,
						toolContracts: true,
					},
				}),
			});
			expect(unsupportedTools.status).toBe(400);
			expect(await unsupportedTools.text()).toContain(
				"pi-native tool-contract boundary approval is unsupported for API openai-completions",
			);
			expect(upstreamCalls).toBe(0);

			const statuses: number[] = [];
			await expect(
				streamPiNative(clientModel, baseContext, {
					apiKey: "gateway-token",
					fetch: (async (input, init) => {
						if (!String(input).endsWith("/v1/pi/boundary-approval")) return fetch(input, init);
						const decision = JSON.parse(String(init?.body)) as Record<string, unknown>;
						const tampered = { ...decision, payloadSha256: "0".repeat(64) };
						const first = await fetch(input, {
							...init,
							body: JSON.stringify(tampered),
						});
						statuses.push(first.status);
						const replay = await fetch(input, init);
						statuses.push(replay.status);
						return first;
					}) as typeof fetch,
					onPayload: () => undefined,
				}).result(),
			).rejects.toThrow();
			// The callback helper attempts its terminal reject after the first POST
			// fails; both the tampered decision and every follow-up are already consumed.
			expect(statuses).toEqual([409, 409, 409, 409]);
			expect(upstreamCalls).toBe(0);

			let wrongBearerStatus = 0;
			await streamPiNative(clientModel, baseContext, {
				apiKey: "gateway-token",
				fetch: (async (input, init) => {
					if (!String(input).endsWith("/v1/pi/boundary-approval")) return fetch(input, init);
					const wrong = await fetch(input, {
						...init,
						headers: {
							...(init?.headers as Record<string, string>),
							Authorization: "Bearer other-valid-token",
						},
					});
					wrongBearerStatus = wrong.status;
					return fetch(input, init);
				}) as typeof fetch,
				onPayload: () => undefined,
			}).result();
			expect(wrongBearerStatus).toBe(403);
			expect(upstreamCalls).toBe(1);

			let replayStatus = 0;
			await streamPiNative(clientModel, baseContext, {
				apiKey: "gateway-token",
				fetch: (async (input, init) => {
					if (!String(input).endsWith("/v1/pi/boundary-approval")) return fetch(input, init);
					const approved = await fetch(input, init);
					replayStatus = (await fetch(input, init)).status;
					return approved;
				}) as typeof fetch,
				onPayload: () => undefined,
			}).result();
			expect(replayStatus).toBe(409);
			expect(upstreamCalls).toBe(2);

			await expect(
				streamPiNative(clientModel, baseContext, {
					apiKey: "gateway-token",
					onPayload: async () => {
						await Bun.sleep(120);
					},
				}).result(),
			).rejects.toThrow(/expired/);
			expect(upstreamCalls).toBe(2);

			const cancel = new AbortController();
			await expect(
				streamPiNative(clientModel, baseContext, {
					apiKey: "gateway-token",
					signal: cancel.signal,
					onPayload: () => {
						cancel.abort(new Error("client cancelled protected stream"));
					},
				}).result(),
			).rejects.toThrow("client cancelled protected stream");
			expect(upstreamCalls).toBe(2);

			const pendingResponse = await fetch(`${handle.url}/v1/pi/boundary-stream/v1`, {
				method: "POST",
				headers: { Authorization: "Bearer gateway-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: providerModel.id,
					context: baseContext,
					stream: true,
					boundaryApproval: { version: 1, payload: true, toolContracts: false },
				}),
			});
			expect(pendingResponse.status).toBe(200);
			const pendingEvents = readSseJson<PiNativeBoundaryPreparationEvent>(pendingResponse.body!);
			const pending = (await pendingEvents.next()).value?.boundaryApproval;
			if (!pending) throw new Error("expected pending boundary preparation");
			const staleDecision: PiNativeBoundaryApprovalDecision = {
				version: 1,
				requestId: pending.requestId,
				streamId: pending.streamId,
				sessionId: pending.sessionId,
				sequence: pending.sequence,
				preparationId: pending.preparationId,
				kind: pending.kind,
				modelSha256: pending.modelSha256,
				payloadSha256: pending.payloadSha256,
				expiresAt: pending.expiresAt,
				decision: "keep",
			};
			await handle.close();
			handleClosed = true;
			const restarted = startAuthGateway({
				bind: "127.0.0.1:0",
				bearerTokens: ["gateway-token"],
				storage,
				resolveModel: () => providerModel,
				version: "test",
			});
			try {
				const staleApproval = await fetch(`${restarted.url}/v1/pi/boundary-approval`, {
					method: "POST",
					headers: { Authorization: "Bearer gateway-token", "Content-Type": "application/json" },
					body: JSON.stringify(staleDecision),
				});
				expect(staleApproval.status).toBe(409);
				expect(upstreamCalls).toBe(2);
			} finally {
				await restarted.close();
			}
		} finally {
			if (!handleClosed) await handle.close();
			upstream.stop(true);
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("delivers statefulResponses false to the provider stream", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pi-native-cache-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const mock = createMockModel({
			provider: "openrouter",
			id: "pi-native-cache",
		});
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: () => mock,
			version: "test",
		});

		try {
			mock.push({ content: ["ok"] });
			const response = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: {
					Authorization: "Bearer test-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					modelId: "pi-native-cache",
					context: baseContext,
					options: {
						promptCacheKey: "bench-cache-pair",
						statefulResponses: false,
					},
					stream: false,
				}),
			});

			expect(response.status).toBe(200);
			await response.json();
			expect(mock.calls).toHaveLength(1);
			expect(mock.calls[0]?.options).toMatchObject({
				promptCacheKey: "bench-cache-pair",
				statefulResponses: false,
			});
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
			clearCustomApis();
		}
	});
});
describe("pi-native encodeStream", () => {
	it("ships every AssistantMessageEvent verbatim, terminated by [DONE]", async () => {
		// Pi-native is omp-talks-to-omp: the client feeds parsed events directly
		// into `AssistantMessageEventStream.push()`, so the wire IS the canonical
		// event type. No partial-stripping, no per-event re-shaping.
		const finalMessage = baseAssistant({
			content: [{ type: "text", text: "hi" }],
			usage: { ...ZERO_USAGE, input: 4, output: 2, totalTokens: 6 },
		});
		const partialAfterDelta: AssistantMessage = baseAssistant({
			content: [{ type: "text", text: "hi" }],
		});
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: baseAssistant() },
			{
				type: "text_start",
				contentIndex: 0,
				partial: baseAssistant({ content: [{ type: "text", text: "" }] }),
			},
			{
				type: "text_delta",
				contentIndex: 0,
				delta: "hi",
				partial: partialAfterDelta,
			},
			{
				type: "text_end",
				contentIndex: 0,
				content: "hi",
				partial: partialAfterDelta,
			},
			{ type: "done", reason: "stop", message: finalMessage },
		];
		const chunks = await collectSse(encodeStream(makeEventStream(events, finalMessage)));
		const parsed = chunks.map(parseSseLine);

		// Every payload is the input event verbatim — partials, signatures,
		// usage all intact. Terminator follows `done`/`error`.
		expect(parsed.length).toBe(events.length + 1);
		for (let i = 0; i < events.length; i++) {
			expect(parsed[i]).toEqual(JSON.parse(JSON.stringify(events[i])));
		}
		expect(parsed[parsed.length - 1]).toBe("[DONE]");
	});

	it("preserves the rolling `partial` on every delta (sanity: no shrink)", async () => {
		// Guards against an accidental re-introduction of partial-stripping
		// optimization. Clients depend on `partial` being present.
		const final = baseAssistant({ content: [{ type: "text", text: "abc" }] });
		const events: AssistantMessageEvent[] = [
			{ type: "text_delta", contentIndex: 0, delta: "abc", partial: final },
			{ type: "done", reason: "stop", message: final },
		];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, final)))).map(parseSseLine) as Array<
			Record<string, unknown>
		>;
		expect(parsed[0]).toHaveProperty("partial");
		expect((parsed[0] as { partial: AssistantMessage }).partial.content).toEqual([{ type: "text", text: "abc" }]);
	});

	it("stops streaming after a terminal `done` and emits [DONE] once", async () => {
		const final = baseAssistant();
		const events: AssistantMessageEvent[] = [
			{ type: "done", reason: "stop", message: final },
			// This trailing event must NOT reach the wire — terminal events end
			// the stream so the client iterator resolves cleanly.
			{ type: "text_delta", contentIndex: 0, delta: "ghost", partial: final },
		];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, final)))).map(parseSseLine);
		expect(parsed.length).toBe(2);
		expect((parsed[0] as { type: string }).type).toBe("done");
		expect(parsed[1]).toBe("[DONE]");
	});

	it("forwards `error` events verbatim, then closes with [DONE]", async () => {
		const errored = baseAssistant({
			stopReason: "error",
			errorMessage: "upstream blew up",
			usage: { ...ZERO_USAGE, input: 3 },
		});
		const events: AssistantMessageEvent[] = [{ type: "error", reason: "error", error: errored }];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, errored)))).map(parseSseLine);
		expect(parsed[0]).toEqual({
			type: "error",
			reason: "error",
			error: JSON.parse(JSON.stringify(errored)),
		});
		expect(parsed[1]).toBe("[DONE]");
	});

	it("emits a synthetic error envelope when the source iterator throws", async () => {
		// Source-stream failures (network drop after `streamSimple` returned)
		// must not hang the client. We surface a minimal `error` event followed
		// by `[DONE]` so the iterator on the other end resolves.
		const broken = (async function* () {
			yield {
				type: "start",
				partial: baseAssistant(),
			} satisfies AssistantMessageEvent;
			throw new Error("connection reset");
		})() as unknown as AssistantMessageEventStream;
		(broken as { result(): Promise<AssistantMessage> }).result = async () => baseAssistant();

		const parsed = (await collectSse(encodeStream(broken))).map(parseSseLine);
		expect((parsed[0] as { type: string }).type).toBe("start");
		expect(parsed[1]).toEqual({
			type: "error",
			reason: "error",
			errorMessage: "connection reset",
		});
		expect(parsed[2]).toBe("[DONE]");
	});
});

describe("pi-native formatError", () => {
	it("emits { error: { type, message } } with the given status", async () => {
		const res = formatError(401, "authentication_error", "no credential");
		expect(res.status).toBe(401);
		expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
		expect(await res.json()).toEqual({
			error: { type: "authentication_error", message: "no credential" },
		});
	});
});
