import { describe, expect, test } from "bun:test";
import { resolveDeveloperRoleSupport } from "@oh-my-pi/pi-catalog/compat/developer-role";

describe("developer-role compatibility", () => {
	test("matches the exact OpenAI-family wire policy without loading runtime natives", () => {
		expect(resolveDeveloperRoleSupport("openai-codex-responses", { provider: "openai-codex" })).toBe(true);
		expect(resolveDeveloperRoleSupport("openai-completions", { provider: "openai" })).toBe(true);
		expect(resolveDeveloperRoleSupport("openai-completions", { provider: "azure" })).toBe(true);
		expect(resolveDeveloperRoleSupport("openai-completions", { provider: "openrouter" })).toBe(false);
		expect(
			resolveDeveloperRoleSupport("openai-responses", {
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
			}),
		).toBe(true);
		expect(
			resolveDeveloperRoleSupport("openai-responses", {
				provider: "github-copilot",
				baseUrl: "https://api.githubcopilot.com",
			}),
		).toBe(true);
		expect(resolveDeveloperRoleSupport("azure-openai-responses", { provider: "azure" })).toBe(true);
		expect(resolveDeveloperRoleSupport("anthropic-messages", { provider: "anthropic" })).toBe(false);
	});

	test("honors an explicit catalog override before endpoint inference", () => {
		expect(
			resolveDeveloperRoleSupport("openai-responses", {
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				compat: { supportsDeveloperRole: false },
			}),
		).toBe(false);
		expect(
			resolveDeveloperRoleSupport("anthropic-messages", {
				provider: "custom",
				compat: { supportsDeveloperRole: true },
			}),
		).toBe(true);
	});
});
