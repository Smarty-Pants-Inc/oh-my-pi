import type { Api, ApiKeyResolver, Model } from "@oh-my-pi/pi-ai";

export interface ProviderScopedModelRef {
	readonly provider: string;
	readonly id: string;
}

export interface ModelConnectionProfile {
	readonly id: string;
	readonly model: ProviderScopedModelRef;
}
function isCanonicalModelConnectionStringV1(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(++index);
			if (next < 0xdc00 || next > 0xdfff) return false;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

export class ModelConnectionProfileValidationError extends Error {
	constructor(
		readonly code:
			| "model_connection_invalid_shape"
			| "model_connection_invalid_id"
			| "model_connection_invalid_model",
	) {
		super(code);
		this.name = "ModelConnectionProfileValidationError";
	}
}

function snapshotModelConnectionProfileV1(input: unknown): ModelConnectionProfile | null {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
	try {
		const prototype = Object.getPrototypeOf(input);
		const keys = Reflect.ownKeys(input);
		const descriptors = Object.getOwnPropertyDescriptors(input);
		if (
			(prototype !== Object.prototype && prototype !== null) ||
			keys.length !== 2 ||
			!keys.includes("id") ||
			!keys.includes("model")
		)
			return null;
		const idDescriptor = descriptors.id;
		const modelDescriptor = descriptors.model;
		if (
			!idDescriptor?.enumerable ||
			!("value" in idDescriptor) ||
			!modelDescriptor?.enumerable ||
			!("value" in modelDescriptor) ||
			!isCanonicalModelConnectionStringV1(idDescriptor.value)
		)
			return null;
		const model = modelDescriptor.value;
		if (model === null || typeof model !== "object" || Array.isArray(model)) return null;
		const modelPrototype = Object.getPrototypeOf(model);
		const modelKeys = Reflect.ownKeys(model);
		const modelDescriptors = Object.getOwnPropertyDescriptors(model);
		if (
			(modelPrototype !== Object.prototype && modelPrototype !== null) ||
			modelKeys.length !== 2 ||
			!modelKeys.includes("provider") ||
			!modelKeys.includes("id")
		)
			return null;
		const providerDescriptor = modelDescriptors.provider;
		const modelIdDescriptor = modelDescriptors.id;
		if (
			!providerDescriptor?.enumerable ||
			!("value" in providerDescriptor) ||
			!modelIdDescriptor?.enumerable ||
			!("value" in modelIdDescriptor) ||
			!isCanonicalModelConnectionStringV1(providerDescriptor.value) ||
			!isCanonicalModelConnectionStringV1(modelIdDescriptor.value)
		)
			return null;
		return Object.freeze({
			id: idDescriptor.value,
			model: Object.freeze({ provider: providerDescriptor.value, id: modelIdDescriptor.value }),
		});
	} catch {
		return null;
	}
}

/** Strictly validates the closed provider-scoped model profile. */
export function validateModelConnectionProfileV1(input: unknown): input is ModelConnectionProfile {
	return snapshotModelConnectionProfileV1(input) !== null;
}

/** Strict decoder used before model or auth resolution. */
export function decodeModelConnectionProfileV1(input: unknown): ModelConnectionProfile {
	const profile = snapshotModelConnectionProfileV1(input);
	if (profile === null) {
		throw new ModelConnectionProfileValidationError("model_connection_invalid_shape");
	}
	return profile;
}

declare const modelConnectionFingerprintBrand: unique symbol;

export type ModelConnectionFingerprint = string & {
	readonly [modelConnectionFingerprintBrand]: "ModelConnectionFingerprint";
};

export interface ResolvedModelConnection {
	readonly profileId: string;
	readonly model: Model<Api>;
	readonly apiKey: ApiKeyResolver;
	readonly fingerprint: ModelConnectionFingerprint;
}

export interface ModelConnectionResolver {
	resolve(profile: ModelConnectionProfile, providerSessionId: string): ResolvedModelConnection;
}
