import { describe, expect, test, vi } from "bun:test";
import type { Api, ApiKeyResolver, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelConnectionProfile } from "../../../src/config/model-connection-contracts";
import { ModelConnectionProfileValidationError } from "../../../src/config/model-connection-contracts";
import {
	ModelConnectionResolutionError,
	RegistryModelConnectionResolver,
} from "../../../src/config/model-connection-resolver";
import type { ModelRegistry } from "../../../src/config/model-registry";

const profile: ModelConnectionProfile = {
	id: "primary",
	model: { provider: "test-provider", id: "test-model" },
};

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return buildModel({
		id: "test-model",
		name: "Test model",
		api: "openai-responses",
		provider: "test-provider",
		baseUrl: "https://gateway.example.test/v1/",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...overrides,
	} as ModelSpec<Api>) as Model<Api>;
}

function registryFor(model: Model<Api> | undefined, apiKey: ApiKeyResolver) {
	return {
		find: vi.fn(() => model),
		resolver: vi.fn(() => apiKey),
	} as unknown as Pick<ModelRegistry, "find" | "resolver">;
}

describe("model connection resolution", () => {
	test("strictly validates before one exact lookup, preserving model and lazy resolver identity", () => {
		const model = makeModel();
		const apiKey = vi.fn() as unknown as ApiKeyResolver;
		const registry = registryFor(model, apiKey);
		const resolver = new RegistryModelConnectionResolver(registry);

		const resolved = resolver.resolve(profile, "provider-session-1");

		expect(registry.find).toHaveBeenCalledTimes(1);
		expect(registry.find).toHaveBeenCalledWith("test-provider", "test-model");
		expect(registry.resolver).toHaveBeenCalledWith(model, "provider-session-1");
		expect(resolved.profileId).toBe(profile.id);
		expect(resolved.model).toBe(model);
		expect(resolved.apiKey).toBe(apiKey);
		expect(apiKey).not.toHaveBeenCalled();
	});

	test("rejects malformed profiles before lookup or credential resolution", () => {
		const apiKey = vi.fn() as unknown as ApiKeyResolver;
		const registry = registryFor(makeModel(), apiKey);
		const resolver = new RegistryModelConnectionResolver(registry);
		const malformed = {
			id: "primary",
			model: { provider: "test-provider", id: "test-model", baseUrl: "https://forbidden.example.test" },
		};

		expect(() => resolver.resolve(malformed as unknown as ModelConnectionProfile, "provider-session-1")).toThrow(
			ModelConnectionProfileValidationError,
		);
		expect(registry.find).not.toHaveBeenCalled();
		expect(registry.resolver).not.toHaveBeenCalled();
	});

	test("fails closed when the exact registered model is absent", () => {
		const apiKey = vi.fn() as unknown as ApiKeyResolver;
		const registry = registryFor(undefined, apiKey);
		const resolver = new RegistryModelConnectionResolver(registry);

		expect(() => resolver.resolve(profile, "provider-session-1")).toThrow(ModelConnectionResolutionError);
		expect(registry.find).toHaveBeenCalledTimes(1);
		expect(registry.resolver).not.toHaveBeenCalled();
	});

	test("rejects alias or cross-provider lookup results before credential resolution", () => {
		const apiKey = vi.fn() as unknown as ApiKeyResolver;
		const registry = registryFor(makeModel({ id: "resolved-alias" }), apiKey);
		const resolver = new RegistryModelConnectionResolver(registry);

		expect(() => resolver.resolve(profile, "provider-session-1")).toThrow(ModelConnectionResolutionError);
		expect(registry.resolver).not.toHaveBeenCalled();
	});

	test("fingerprints connection identity while excluding headers and credential callbacks", () => {
		const apiKey = vi.fn() as unknown as ApiKeyResolver;
		const first = new RegistryModelConnectionResolver(
			registryFor(makeModel({ headers: { authorization: "Bearer first-secret" } }), apiKey),
		).resolve(profile, "provider-session-1");
		const second = new RegistryModelConnectionResolver(
			registryFor(
				makeModel({
					headers: { authorization: "Bearer second-secret" },
					baseUrl: "https://gateway.example.test/v1",
				}),
				apiKey,
			),
		).resolve(profile, "provider-session-2");
		const changedRequestModel = new RegistryModelConnectionResolver(
			registryFor(makeModel({ requestModelId: "upstream-model" }), apiKey),
		).resolve(profile, "provider-session-1");

		expect(first.fingerprint).toBe(second.fingerprint);
		expect(changedRequestModel.fingerprint).not.toBe(first.fingerprint);
	});
});
