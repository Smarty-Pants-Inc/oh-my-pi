/**
 * Runtime-neutral limits and path rules shared by the local client and Cloudflare Worker.
 *
 * Keep this module free of Node and Worker imports: it is deliberately the one source of
 * truth for values and path classification across both boundaries.
 */
export const CLOUD_OMP_BOUNDARY_LIMITS = Object.freeze({
	httpBodyBytes: 32 * 1024 * 1024,
	commandBytes: 32 * 1024,
	commandTimeoutMs: 120_000,
	execOutputBytes: 4 * 1024 * 1024,
	syncFileBytes: 256 * 1024,
	syncTotalBytes: 20 * 1024 * 1024,
	syncFileCount: 1_000,
});

export const MAX_HTTP_BODY_BYTES = CLOUD_OMP_BOUNDARY_LIMITS.httpBodyBytes;
export const MAX_COMMAND_BYTES = CLOUD_OMP_BOUNDARY_LIMITS.commandBytes;
export const MAX_COMMAND_TIMEOUT_MS = CLOUD_OMP_BOUNDARY_LIMITS.commandTimeoutMs;
export const MAX_EXEC_OUTPUT_BYTES = CLOUD_OMP_BOUNDARY_LIMITS.execOutputBytes;
export const MAX_SYNC_FILE_BYTES = CLOUD_OMP_BOUNDARY_LIMITS.syncFileBytes;
export const MAX_SYNC_TOTAL_BYTES = CLOUD_OMP_BOUNDARY_LIMITS.syncTotalBytes;
export const MAX_SYNC_FILE_COUNT = CLOUD_OMP_BOUNDARY_LIMITS.syncFileCount;
export const MAX_SYNC_FILE_BASE64_BYTES = Math.ceil(MAX_SYNC_FILE_BYTES / 3) * 4;

const DENIED_SEGMENTS: ReadonlySet<string> = new Set([
	".git",
	".hg",
	".svn",
	".omp",
	".smarty",
	".codex",
	".claude",
	".ssh",
	".gnupg",
	".aws",
	".azure",
	".kube",
	".docker",
	"node_modules",
	".pnpm-store",
	".npm",
	".yarn",
	".cache",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".tox",
	".venv",
	"venv",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	".next",
	".nuxt",
	".turbo",
	".parcel-cache",
]);

const DENIED_FILE_NAMES: ReadonlySet<string> = new Set([
	".npmrc",
	".yarnrc",
	".yarnrc.yml",
	".pypirc",
	".netrc",
	"_netrc",
	".git-credentials",
	"credentials",
	"credentials.json",
	"auth.json",
	"service-account.json",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	".ds_store",
]);

const DENIED_FILE_SUFFIXES = [
	".pem",
	".key",
	".p12",
	".pfx",
	".jks",
	".keystore",
	".sqlite",
	".sqlite3",
	".db",
	".db3",
	"-wal",
	"-shm",
	".log",
	".pid",
] as const;

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export type CanonicalPathRejection =
	| "path_not_string_or_empty"
	| "path_not_relative_posix"
	| "path_not_strict_utf8"
	| "path_noncanonical_segment";

export type SynchronizedPathRejection =
	| CanonicalPathRejection
	| "path_denied_segment"
	| "path_denied_secret_or_hydrated_state"
	| "path_denied_suffix"
	| "path_denied_gcloud_directory";

export type PathClassification =
	| { readonly accepted: true; readonly path: string }
	| { readonly accepted: false; readonly reason: CanonicalPathRejection };

export type SynchronizedPathClassification =
	| { readonly accepted: true; readonly path: string }
	| { readonly accepted: false; readonly reason: SynchronizedPathRejection };

/** Compares strings by their UTF-8 bytes, preserving manifest digest order. */
export function compareUtf8(left: string, right: string): number {
	const leftBytes = utf8.encode(left);
	const rightBytes = utf8.encode(right);
	const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
	for (let index = 0; index < length; index += 1) {
		const difference = leftBytes[index]! - rightBytes[index]!;
		if (difference !== 0) return difference;
	}
	return leftBytes.byteLength - rightBytes.byteLength;
}

/** Classifies relative POSIX syntax without imposing synchronization deny rules. */
export function classifyCanonicalRelativePath(value: unknown): PathClassification {
	if (typeof value !== "string" || value.length === 0) {
		return { accepted: false, reason: "path_not_string_or_empty" };
	}
	if (value.startsWith("/") || value.endsWith("/")) {
		return { accepted: false, reason: "path_not_relative_posix" };
	}
	try {
		if (strictUtf8.decode(utf8.encode(value)) !== value) {
			return { accepted: false, reason: "path_not_strict_utf8" };
		}
	} catch {
		return { accepted: false, reason: "path_not_strict_utf8" };
	}
	for (const segment of value.split("/")) {
		if (
			segment.length === 0 ||
			segment === "." ||
			segment === ".." ||
			segment.includes("\\") ||
			segment.includes("\0") ||
			segment.normalize("NFC") !== segment
		) {
			return { accepted: false, reason: "path_noncanonical_segment" };
		}
	}
	return { accepted: true, path: value };
}

/** Classifies canonical paths against the complete synchronization allowlist. */
export function classifySynchronizedRelativePath(value: unknown): SynchronizedPathClassification {
	const canonical = classifyCanonicalRelativePath(value);
	if (!canonical.accepted) return canonical;
	const segments = canonical.path.split("/");
	for (let index = 0; index < segments.length; index += 1) {
		const folded = segments[index]!.toLowerCase();
		if (DENIED_SEGMENTS.has(folded)) return { accepted: false, reason: "path_denied_segment" };
		if (folded.startsWith(".env") || DENIED_FILE_NAMES.has(folded)) {
			return { accepted: false, reason: "path_denied_secret_or_hydrated_state" };
		}
		if (DENIED_FILE_SUFFIXES.some(suffix => folded.endsWith(suffix))) {
			return { accepted: false, reason: "path_denied_suffix" };
		}
		if (folded === ".config" && segments[index + 1]?.toLowerCase() === "gcloud") {
			return { accepted: false, reason: "path_denied_gcloud_directory" };
		}
	}
	return canonical;
}

/** Tests that an untrusted JSON value has exactly the required own enumerable keys. */
export function hasExactObjectKeys(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const actualKeys = Object.keys(value);
	return actualKeys.length === expectedKeys.length && actualKeys.every(key => expectedKeys.includes(key));
}
