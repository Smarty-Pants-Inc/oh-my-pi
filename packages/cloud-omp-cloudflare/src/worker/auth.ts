const BEARER_PREFIX = "Bearer ";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
	const length = Math.max(left.byteLength, right.byteLength);
	let difference = left.byteLength ^ right.byteLength;
	for (let index = 0; index < length; index++) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return difference === 0;
}

export async function bearerMatches(authorization: string | null, expectedDigestHex: string): Promise<boolean> {
	if (!authorization?.startsWith(BEARER_PREFIX)) return false;
	const bearer = authorization.slice(BEARER_PREFIX.length);
	if (bearer.length === 0 || bearer.trim() !== bearer || /\s/.test(bearer)) return false;

	const expected = decodeDigest(expectedDigestHex);
	const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(bearer)));
	return expected !== null && constantTimeEqual(actual, expected);
}

function decodeDigest(value: string): Uint8Array | null {
	if (!SHA256_HEX.test(value)) return null;
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.byteLength; index++) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}
