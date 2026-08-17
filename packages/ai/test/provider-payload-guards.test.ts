import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function model<TApi extends "bedrock-converse-stream" | "cursor-agent" | "openai-completions">(api: TApi): Model<TApi> {
	return buildModel({
		id: "guard-test",
		name: "Guard Test",
		api,
		provider: api === "bedrock-converse-stream" ? "amazon-bedrock" : api === "cursor-agent" ? "cursor" : "openai",
		baseUrl: api === "cursor-agent" ? "https://127.0.0.1:1" : "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	}) as Model<TApi>;
}

describe("async provider payload guards", () => {
	it("blocks Cursor before tool contracts or transport setup", async () => {
		let toolContractsObserved = false;
		const result = await streamCursor(model("cursor-agent"), context, {
			apiKey: "test-token",
			customSystemPrompt: "protected Cursor system prompt",
			onPayload: async payload => {
				await Promise.resolve();
				expect(payload).toMatchObject({ customSystemPrompt: "protected Cursor system prompt" });
				throw new Error("cursor payload denied");
			},
			onToolContracts: () => {
				toolContractsObserved = true;
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("cursor payload denied");
		expect(toolContractsObserved).toBe(false);
	});

	it("sends the replacement payload returned by the Bedrock hook", async () => {
		let body: unknown;
		const fetchMock = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
				return new Response("stop", { status: 400 });
			},
			{ preconnect: fetch.preconnect },
		) satisfies FetchImpl;
		await streamBedrock(model("bedrock-converse-stream"), context, {
			bearerToken: "test-token",
			fetch: fetchMock,
			onPayload: () => ({ messages: [], system: [{ text: "replacement bedrock prompt" }] }),
		}).result();

		expect(body).toMatchObject({ messages: [], system: [{ text: "replacement bedrock prompt" }] });
	});

	it("blocks Bedrock before fetch", async () => {
		let fetched = false;
		const fetchMock = Object.assign(
			async (): Promise<Response> => {
				fetched = true;
				return new Response();
			},
			{ preconnect: fetch.preconnect },
		) satisfies FetchImpl;
		const result = await streamBedrock(model("bedrock-converse-stream"), context, {
			bearerToken: "test-token",
			fetch: fetchMock,
			onPayload: async () => {
				await Promise.resolve();
				throw new Error("bedrock payload denied");
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("bedrock payload denied");
		expect(fetched).toBe(false);
	});

	it("blocks OpenAI Completions before fetch", async () => {
		let fetched = false;
		const fetchMock = Object.assign(
			async (): Promise<Response> => {
				fetched = true;
				return new Response();
			},
			{ preconnect: fetch.preconnect },
		) satisfies FetchImpl;
		const result = await streamOpenAICompletions(model("openai-completions"), context, {
			apiKey: "test-token",
			fetch: fetchMock,
			onPayload: async () => {
				await Promise.resolve();
				throw new Error("completions payload denied");
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("completions payload denied");
		expect(fetched).toBe(false);
	});

	it("sends the replacement payload returned by the OpenAI Completions hook", async () => {
		let body: unknown;
		const fetchMock = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				body = JSON.parse(String(init?.body));
				return new Response("stop", { status: 400 });
			},
			{ preconnect: fetch.preconnect },
		) satisfies FetchImpl;
		await streamOpenAICompletions(model("openai-completions"), context, {
			apiKey: "test-token",
			fetch: fetchMock,
			onPayload: () => ({ model: "replacement-model", messages: [], stream: true }),
		}).result();

		expect(body).toMatchObject({ model: "replacement-model", messages: [], stream: true });
	});

	it("serializes the replacement payload returned by the Cursor hook", async () => {
		const result = await streamCursor(model("cursor-agent"), context, {
			apiKey: "test-token",
			onPayload: () =>
				Object.defineProperty({}, "conversationId", {
					get: () => {
						throw new Error("cursor replacement consumed");
					},
				}),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("cursor replacement consumed");
	});
});
