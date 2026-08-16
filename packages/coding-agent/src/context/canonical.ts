export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Stable Unicode code-point order shared with cross-language evidence consumers. */
export function compareUnicodeCodePoints(left: string, right: string): number {
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.length && rightIndex < right.length) {
		const leftPoint = left.codePointAt(leftIndex)!;
		const rightPoint = right.codePointAt(rightIndex)!;
		if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
		leftIndex += leftPoint > 0xffff ? 2 : 1;
		rightIndex += rightPoint > 0xffff ? 2 : 1;
	}
	return leftIndex < left.length ? 1 : rightIndex < right.length ? -1 : 0;
}

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
