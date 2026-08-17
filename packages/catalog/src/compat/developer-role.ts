import { hostMatchesUrl, modelMatchesHost } from "../hosts";
import type { Api } from "../types";

interface DeveloperRoleSpec {
	provider: string;
	baseUrl?: string;
	compat?: { supportsDeveloperRole?: boolean };
}

/** Native-free source of truth for typed instruction wire-role compatibility. */
export function resolveDeveloperRoleSupport(api: Api, spec: DeveloperRoleSpec): boolean {
	const override = spec.compat?.supportsDeveloperRole;
	if (override !== undefined) return override;
	const model = { provider: spec.provider, baseUrl: spec.baseUrl ?? "" };
	switch (api) {
		case "openai-codex-responses":
			return true;
		case "openai-completions":
			return modelMatchesHost(model, "openai") || modelMatchesHost(model, "azureOpenAI");
		case "openai-responses":
		case "azure-openai-responses":
			return (
				modelMatchesHost(model, "azureOpenAI") ||
				hostMatchesUrl(model.baseUrl, "openai") ||
				hostMatchesUrl(model.baseUrl, "githubCopilot")
			);
		default:
			return false;
	}
}
