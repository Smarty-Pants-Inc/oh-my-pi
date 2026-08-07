import type {
	OperationId,
	ProviderRequestId,
	Sha256Hex,
	WorkspaceId,
	WorkspaceOperationLeaseId,
} from "../registry/persistent-agent-contracts.js";

export type CanonicalRuntimeValue = null | boolean | string | number | readonly CanonicalRuntimeValue[];

const encoder = new TextEncoder();

function assertWellFormedUnicode(value: string): void {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0xd800 || code > 0xdfff) continue;
		if (code >= 0xdc00 || index + 1 >= value.length) throw new TypeError("Unpaired UTF-16 surrogate");
		const next = value.charCodeAt(index + 1);
		if (next < 0xdc00 || next > 0xdfff) throw new TypeError("Unpaired UTF-16 surrogate");
		index++;
	}
}

function assertCanonicalRuntimeValue(value: CanonicalRuntimeValue): void {
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "string") {
		assertWellFormedUnicode(value);
		return;
	}
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
			throw new TypeError("Canonical runtime numbers must be safe integers");
		}
		return;
	}
	if (!Array.isArray(value)) throw new TypeError("Canonical runtime objects are forbidden");
	for (const item of value) assertCanonicalRuntimeValue(item);
}

export function encodeCanonicalRuntimeTupleV1(tuple: readonly CanonicalRuntimeValue[]): Uint8Array<ArrayBuffer> {
	assertCanonicalRuntimeValue(tuple);
	return encoder.encode(JSON.stringify(tuple));
}

export async function canonicalRuntimeSha256(tuple: readonly CanonicalRuntimeValue[]): Promise<Sha256Hex> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", encodeCanonicalRuntimeTupleV1(tuple));
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") as Sha256Hex;
}

export async function deriveProviderSubrequestId(input: {
	readonly workspaceId: WorkspaceId;
	readonly parentKind: "workspace_operation" | "runtime_transition" | "runtime_renewal";
	readonly parentId: WorkspaceOperationLeaseId | OperationId;
	readonly ordinal: number;
	readonly operation: string;
}): Promise<ProviderRequestId> {
	if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
		throw new TypeError("Provider request ordinal must be non-negative");
	}
	return canonicalRuntimeSha256([
		"omp-provider-subrequest-id-v1",
		input.workspaceId,
		input.parentKind,
		input.parentId,
		input.ordinal,
		input.operation,
	]);
}
