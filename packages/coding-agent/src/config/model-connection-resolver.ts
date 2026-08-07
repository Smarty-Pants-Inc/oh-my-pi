import type { Api, Model } from "@oh-my-pi/pi-ai";
import type {
	ModelConnectionFingerprint,
	ModelConnectionProfile,
	ModelConnectionResolver,
	ResolvedModelConnection,
} from "./model-connection-contracts";
import { decodeModelConnectionProfileV1 } from "./model-connection-contracts";
import type { ModelRegistry } from "./model-registry";

type ModelConnectionRegistry = Pick<ModelRegistry, "find" | "resolver">;
type FingerprintValue = null | boolean | number | string | FingerprintValue[] | { [key: string]: FingerprintValue };

const OMITTED_COMPATIBILITY_KEYS = /(?:api[_-]?key|auth(?:orization)?|credential|header|password|secret|token)/i;
const OMITTED_ROUTING_QUERY_KEY = /^(?:api[_-]?key|key|auth(?:orization)?|credential|password|secret|token)$/i;

/** The registry lookup did not resolve the exact profile-owned model. */
export class ModelConnectionResolutionError extends Error {
	constructor(readonly code: "model_connection_model_not_found" | "model_connection_model_mismatch") {
		super(code);
		this.name = "ModelConnectionResolutionError";
	}
}

function canonicalizeFingerprintValue(value: unknown): FingerprintValue | undefined {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0) ? value : undefined;
	if (Array.isArray(value)) {
		return value.map(entry => canonicalizeFingerprintValue(entry) ?? null);
	}
	if (typeof value !== "object") return undefined;

	const descriptors = Object.getOwnPropertyDescriptors(value);
	const result: { [key: string]: FingerprintValue } = {};
	for (const key of Object.keys(descriptors).sort()) {
		if (OMITTED_COMPATIBILITY_KEYS.test(key)) continue;
		const descriptor = descriptors[key];
		if (!descriptor?.enumerable || !("value" in descriptor)) continue;
		const canonical = canonicalizeFingerprintValue(descriptor.value);
		if (canonical !== undefined) result[key] = canonical;
	}
	return result;
}

function normalizeRoutingUrl(baseUrl: string): string {
	try {
		const url = new URL(baseUrl);
		url.username = "";
		url.password = "";
		for (const key of [...url.searchParams.keys()]) {
			if (OMITTED_ROUTING_QUERY_KEY.test(key)) url.searchParams.delete(key);
		}
		url.searchParams.sort();
		url.hash = "";
		url.pathname = url.pathname.replace(/\/+$/, "") || "/";
		return url.toString();
	} catch {
		return "invalid-routing-url";
	}
}

function fingerprintFor(profile: ModelConnectionProfile, model: Model<Api>): ModelConnectionFingerprint {
	const canonical = JSON.stringify({
		api: model.api,
		compatibility: canonicalizeFingerprintValue(model.compat),
		modelId: model.id,
		oauth: model.isOAuth === true,
		profileId: profile.id,
		provider: model.provider,
		reasoning: {
			enabled: model.reasoning,
			mode: model.reasoningMode ?? null,
			thinking: canonicalizeFingerprintValue(model.thinking),
		},
		requestModelId: model.requestModelId ?? model.id,
		routingUrl: normalizeRoutingUrl(model.baseUrl),
		transport: model.transport ?? "provider-default",
		useResponsesLite: model.useResponsesLite === true,
		websockets: model.preferWebsockets === true,
	});
	return Bun.SHA256.hash(canonical, "hex") as ModelConnectionFingerprint;
}

/**
 * Resolves one already-registered model profile without selecting an alias,
 * cloning model metadata, or touching credentials eagerly.
 */
export class RegistryModelConnectionResolver implements ModelConnectionResolver {
	constructor(private readonly modelRegistry: ModelConnectionRegistry) {}

	resolve(profile: ModelConnectionProfile, providerSessionId: string): ResolvedModelConnection {
		const decodedProfile = decodeModelConnectionProfileV1(profile);
		const model = this.modelRegistry.find(decodedProfile.model.provider, decodedProfile.model.id);
		if (model === undefined) {
			throw new ModelConnectionResolutionError("model_connection_model_not_found");
		}
		if (model.provider !== decodedProfile.model.provider || model.id !== decodedProfile.model.id) {
			throw new ModelConnectionResolutionError("model_connection_model_mismatch");
		}

		const apiKey = this.modelRegistry.resolver(model, providerSessionId);
		return {
			profileId: decodedProfile.id,
			model,
			apiKey,
			fingerprint: fingerprintFor(decodedProfile, model),
		};
	}
}
