export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function sortValue(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map(key => [key, sortValue(value[key]!)]),
	);
}

export function canonicalJson(value: JsonValue): string {
	return JSON.stringify(sortValue(value));
}

export function sha256(value: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function hashJson(value: JsonValue): string {
	return sha256(canonicalJson(value));
}
