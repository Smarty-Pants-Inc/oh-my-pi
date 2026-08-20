import { expect, test } from "bun:test";
import { PROVIDER_DESCRIPTORS, resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";

test("lightweight cache resolver matches every descriptor default", () => {
	for (const descriptor of PROVIDER_DESCRIPTORS) {
		const options = descriptor.createModelManagerOptions({});
		expect(resolveModelCacheProviderId(descriptor.providerId)).toBe(options.cacheProviderId ?? descriptor.providerId);
	}
});

test("lightweight cache resolver matches scoped descriptor inputs", () => {
	const cases = [
		{ providerId: "litellm", baseUrl: "http://litellm.example:4100/v1" },
		{ providerId: "lm-studio", baseUrl: "http://lm-studio.example:1234/v1" },
		{ providerId: "ollama", baseUrl: "http://ollama.example:11434/v1/" },
		{ providerId: "opencode-go", baseUrl: "https://opencode.example/go" },
		{ providerId: "opencode-zen", baseUrl: "https://opencode.example/zen/v1/" },
		{ providerId: "vllm", baseUrl: "http://vllm.example:8000/v1" },
	] as const;
	for (const { providerId, baseUrl } of cases) {
		const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === providerId);
		if (!descriptor) throw new Error(`Missing descriptor for ${providerId}`);
		const config = { apiKey: "cache-test-key", baseUrl };
		const options = descriptor.createModelManagerOptions(config);
		expect(resolveModelCacheProviderId(providerId, config)).toBe(options.cacheProviderId ?? providerId);
	}
});

test("ollama cache scope preserves reverse-proxy path prefixes", () => {
	const teamA = resolveModelCacheProviderId("ollama", { baseUrl: "https://proxy.example/team-a/v1/" });
	expect(teamA).toBe(resolveModelCacheProviderId("ollama", { baseUrl: "https://proxy.example/team-a" }));
	expect(teamA).toBe(resolveModelCacheProviderId("ollama", { baseUrl: "https://proxy.example/team-a/" }));
	expect(teamA).not.toBe(resolveModelCacheProviderId("ollama", { baseUrl: "https://proxy.example/team-b/v1" }));
});

test("Qwen template-effort opt-out splits local cache identity without losing enabled hits", () => {
	for (const [providerId, baseUrl] of [
		["vllm", "http://vllm.example:8000/v1"],
		["lm-studio", "http://lm-studio.example:1234/v1"],
	] as const) {
		const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === providerId);
		if (!descriptor) throw new Error(`Missing descriptor for ${providerId}`);
		const enabled = { baseUrl, compat: { qwenTemplateReasoningEffort: true } };
		const disabled = { baseUrl, compat: { qwenTemplateReasoningEffort: false } };
		const defaultCacheId = resolveModelCacheProviderId(providerId, { baseUrl });
		expect(resolveModelCacheProviderId(providerId, enabled)).toBe(defaultCacheId);
		expect(resolveModelCacheProviderId(providerId, disabled)).not.toBe(defaultCacheId);
		expect(descriptor.createModelManagerOptions(disabled).cacheProviderId).toBe(
			resolveModelCacheProviderId(providerId, disabled),
		);
	}

	expect(
		resolveModelCacheProviderId("vllm", {
			baseUrl: "http://vllm-a.example/v1",
			compat: { qwenTemplateReasoningEffort: false },
		}),
	).not.toBe(
		resolveModelCacheProviderId("vllm", {
			baseUrl: "http://vllm-b.example/v1",
			compat: { qwenTemplateReasoningEffort: false },
		}),
	);
});
