import { describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, ProviderResponseMetadata } from "@oh-my-pi/pi-ai/types";
import { normalizeProviderResponse, notifyProviderResponse } from "@oh-my-pi/pi-ai/utils/provider-response";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { GetUserJwtResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

describe("provider response metadata", () => {
	it("normalizes response status, headers, and request id", () => {
		const response = new Response(null, {
			status: 202,
			headers: {
				"X-Request-ID": "req_123",
				"X-RateLimit-Remaining": "42",
			},
		});

		expect(normalizeProviderResponse(response, "req_123")).toEqual({
			status: 202,
			headers: {
				"x-request-id": "req_123",
				"x-ratelimit-remaining": "42",
			},
			requestId: "req_123",
		});
	});

	it("invokes the response callback with normalized metadata", async () => {
		const seen: Array<{ response: ProviderResponseMetadata; model: Model | undefined }> = [];
		const model = { provider: "openai", api: "openai-responses", id: "gpt-test" } as Model;

		await notifyProviderResponse(
			{
				onResponse: (response, responseModel) => {
					seen.push({ response, model: responseModel });
				},
			},
			new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }),
			model,
			null,
			{ attempt: 1 },
		);

		expect(seen).toEqual([
			{
				response: {
					status: 204,
					headers: { "cache-control": "no-store" },
					requestId: null,
					metadata: { attempt: 1 },
				},
				model,
			},
		]);
	});
});

function createSseResponse(events: unknown[], headers: Record<string, string> = {}): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream", ...headers },
	});
}

describe("streamSimple onResponse propagation", () => {
	it("invokes onResponse for the default openai-completions path through streamSimple", async () => {
		const model: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
		};

		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
				createSseResponse(
					[
						{
							id: "chatcmpl-onresponse",
							object: "chat.completion.chunk",
							created: 0,
							model: model.id,
							choices: [{ index: 0, delta: { content: "ok" } }],
						},
						{
							id: "chatcmpl-onresponse",
							object: "chat.completion.chunk",
							created: 0,
							model: model.id,
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						},
						"[DONE]",
					],
					{ "x-request-id": "req_stream_simple" },
				),
			{ preconnect: fetch.preconnect },
		);

		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
		const seen: ProviderResponseMetadata[] = [];
		const result = await streamSimple(model, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			onResponse: response => {
				seen.push(response);
			},
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.status).toBe(200);
		expect(seen[0]?.headers["x-request-id"]).toBe("req_stream_simple");
	});
});

const providerResponseContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

describe("built-in provider response acceptance", () => {
	it("passes Ollama metadata through the response gate before emitting start", async () => {
		const model: Model<"ollama-chat"> = buildModel({
			id: "ollama-test",
			name: "Ollama Test",
			api: "ollama-chat",
			provider: "ollama",
			baseUrl: "https://ollama.example",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
		});
		const responseGateError = "Ollama response gate rejected";
		const events: string[] = [];
		const responses: ProviderResponseMetadata[] = [];
		let callbackModel: Model | undefined;
		const stream = streamOllama(model, providerResponseContext, {
			apiKey: "test-key",
			fetch: async () =>
				new Response('{"message":{"content":"ok"},"done":true,"done_reason":"stop"}\n', {
					status: 201,
					headers: {
						"X-Request-ID": "ollama-chat-response",
						"X-Provider-Response": "ollama",
					},
				}),
			onResponse: async (response, responseModel) => {
				responses.push(response);
				callbackModel = responseModel;
				throw new Error(responseGateError);
			},
		});

		for await (const event of stream) events.push(event.type);
		const result = await stream.result();

		expect(events).toEqual(["error"]);
		expect(result.errorMessage).toContain(responseGateError);
		expect(responses).toEqual([
			expect.objectContaining({
				status: 201,
				requestId: "ollama-chat-response",
				headers: expect.objectContaining({
					"x-request-id": "ollama-chat-response",
					"x-provider-response": "ollama",
				}),
			}),
		]);
		expect(callbackModel).toBe(model);
	});

	it("passes only Devin chat metadata through the response gate before emitting start", async () => {
		const model: Model<"devin-agent"> = buildModel({
			id: "devin-test",
			name: "Devin Test",
			api: "devin-agent",
			provider: "devin",
			baseUrl: "https://devin.example",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
		});
		const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
		const responseGateError = "Devin response gate rejected";
		const events: string[] = [];
		const responses: ProviderResponseMetadata[] = [];
		let callbackModel: Model | undefined;
		const fetchMock = (async (input: string | URL | Request) => {
			if (String(input).includes("GetUserJwt")) {
				return new Response(authPayload, { headers: { "X-Request-ID": "devin-auth-response" } });
			}
			return new Response(new Uint8Array(), {
				status: 202,
				headers: {
					"X-Request-ID": "devin-chat-response",
					"X-Provider-Response": "devin",
				},
			});
		}) as typeof fetch;
		const stream = streamDevin(model, providerResponseContext, {
			apiKey: "test-key",
			fetch: fetchMock,
			onResponse: async (response, responseModel) => {
				responses.push(response);
				callbackModel = responseModel;
				throw new Error(responseGateError);
			},
		});

		for await (const event of stream) events.push(event.type);
		const result = await stream.result();

		expect(events).toEqual(["error"]);
		expect(result.errorMessage).toContain(responseGateError);
		expect(responses).toEqual([
			expect.objectContaining({
				status: 202,
				requestId: "devin-chat-response",
				headers: expect.objectContaining({
					"x-request-id": "devin-chat-response",
					"x-provider-response": "devin",
				}),
			}),
		]);
		expect(callbackModel).toBe(model);
	});
});
