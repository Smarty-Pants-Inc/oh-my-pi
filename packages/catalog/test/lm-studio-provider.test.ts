import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { lmStudioModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("lm studio local provider discovery", () => {
	test("marks native VLM models as image-capable", async () => {
		const requestedUrls: string[] = [];
		const fetchMock: FetchImpl = vi.fn(async input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url === "http://127.0.0.1:1234/api/v0/models") {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "qwen/qwen3.6-27b",
								type: "vlm",
								capabilities: ["tool_use"],
								max_context_length: 262144,
							},
							{ id: "plain-llm", type: "llm" },
							{ id: "Qwen3.8-27B-UD-Q6_K_XL", type: "llm" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:1234/v1/models") {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "qwen/qwen3.6-27b", object: "model" },
							{ id: "plain-llm", object: "model" },
							{ id: "Qwen3.8-27B-UD-Q6_K_XL", object: "model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const models = await lmStudioModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();
		const vision = models?.find(model => model.id === "qwen/qwen3.6-27b");
		const text = models?.find(model => model.id === "plain-llm");
		const qwen38 = models?.find(model => model.id === "Qwen3.8-27B-UD-Q6_K_XL");

		expect(requestedUrls).toContain("http://127.0.0.1:1234/api/v0/models");
		expect(vision?.input).toEqual(["text", "image"]);
		expect(vision?.contextWindow).toBe(262144);
		expect(text?.input).toEqual(["text"]);
		expect(qwen38?.reasoning).toBe(true);
	});

	test("refetches stale cached Qwen 3.8+ rows with reasoning disabled", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-lm-studio-qwen-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const baseUrl = "http://127.0.0.1:1234/v1";
		const modelId = "Qwen3.8-27B-UD-Q6_K_XL";
		const requestedUrls: string[] = [];
		const fetchMock: FetchImpl = vi.fn(async input => {
			requestedUrls.push(String(input));
			return new Response(JSON.stringify({ data: [{ id: modelId }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});

		try {
			const discovered = await lmStudioModelManagerOptions({ baseUrl, fetch: fetchMock }).fetchDynamicModels?.();
			const model = discovered?.find(candidate => candidate.id === modelId);
			if (!model) throw new Error("LM Studio Qwen fixture was not discovered");

			await resolveProviderModels(
				{
					providerId: "lm-studio",
					staticModels: [],
					cacheDbPath: dbPath,
					fetchDynamicModels: async () => [{ ...model, reasoning: false }],
				},
				"online",
			);
			requestedUrls.length = 0;

			const refreshed = await resolveProviderModels(
				{
					...lmStudioModelManagerOptions({ baseUrl, fetch: fetchMock }),
					staticModels: [],
					cacheDbPath: dbPath,
				},
				"online-if-uncached",
			);

			expect(requestedUrls).toContain("http://127.0.0.1:1234/v1/models");
			expect(refreshed.models.find(candidate => candidate.id === modelId)?.reasoning).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("prefers the loaded context window over the architectural maximum", async () => {
		const fetchMock: FetchImpl = vi.fn(async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:1234/api/v0/models") {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "loaded-small",
								type: "llm",
								state: "loaded",
								max_context_length: 262144,
								loaded_context_length: 81920,
							},
							{
								id: "unloaded",
								type: "llm",
								state: "not-loaded",
								max_context_length: 262144,
								loaded_context_length: null,
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:1234/v1/models") {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "loaded-small", object: "model" },
							{ id: "unloaded", object: "model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const models = await lmStudioModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();
		const loaded = models?.find(model => model.id === "loaded-small");
		const unloaded = models?.find(model => model.id === "unloaded");

		expect(loaded?.contextWindow).toBe(81920);
		expect(unloaded?.contextWindow).toBe(262144);
	});

	test("falls back to the OpenAI-compatible catalog when native metadata hangs", async () => {
		let nativeAborted = false;
		let openAiCatalogStartedBeforeAbort = false;
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			const url = String(input);
			if (url === "http://127.0.0.1:11434/api/v0/models") {
				const pending = Promise.withResolvers<Response>();
				const abort = () => {
					nativeAborted = true;
					pending.reject(new DOMException("Aborted", "AbortError"));
				};
				if (init?.signal?.aborted) {
					abort();
				} else {
					init?.signal?.addEventListener("abort", abort, { once: true });
				}
				return pending.promise;
			}
			if (url === "http://127.0.0.1:11434/v1/models") {
				openAiCatalogStartedBeforeAbort = !nativeAborted;
				return new Response(JSON.stringify({ data: [{ id: "omlx-model", object: "model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const models = await lmStudioModelManagerOptions({
			baseUrl: "http://127.0.0.1:11434/v1",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(openAiCatalogStartedBeforeAbort).toBe(true);
		expect(nativeAborted).toBe(true);
		expect(models?.find(model => model.id === "omlx-model")?.input).toEqual(["text"]);
	});
});
