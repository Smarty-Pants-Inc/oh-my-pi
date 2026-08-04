import {
	classifySynchronizedRelativePath,
	compareUtf8,
	MAX_SYNC_FILE_BYTES,
	MAX_SYNC_FILE_COUNT,
	MAX_SYNC_TOTAL_BYTES,
} from "../boundary-policy";
import type { BoundaryManifestEntry, FilePayload } from "../protocol";
import { WorkspaceObjectError } from "./errors";

export { compareUtf8 };

export const REMOTE_ROOT = "/workspace" as const;

export interface WorkspaceStatLike {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

export interface WorkspaceDirentLike {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

export interface WorkspaceFilesystemLike {
	readFile(path: string): Promise<ReadableStream<Uint8Array>>;
	lstat(path: string): Promise<WorkspaceStatLike>;
	readdir(path: string): Promise<WorkspaceDirentLike[]>;
	writeFile(path: string, content: Uint8Array): Promise<void>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export function canonicalRelativePath(value: string): string {
	const classification = classifySynchronizedRelativePath(value);
	if (classification.accepted) return classification.path;
	if (classification.reason === "path_not_strict_utf8") {
		throw new WorkspaceObjectError(400, "invalid_path", "Path must be strict UTF-8");
	}
	if (classification.reason.startsWith("path_denied_")) {
		throw new WorkspaceObjectError(400, "denied_path", "Path is outside the synchronized workspace allowlist");
	}
	if (classification.reason === "path_noncanonical_segment") {
		throw new WorkspaceObjectError(400, "invalid_path", "Path contains a non-canonical segment");
	}
	throw new WorkspaceObjectError(400, "invalid_path", "Path must be a non-empty canonical relative POSIX path");
}

export function absoluteWorkspacePath(relativePath: string): string {
	return `${REMOTE_ROOT}/${canonicalRelativePath(relativePath)}`;
}

export function canonicalWorkspaceDirectory(value: string): string {
	if (value === REMOTE_ROOT) return value;
	if (!value.startsWith(`${REMOTE_ROOT}/`)) {
		throw new WorkspaceObjectError(400, "invalid_cwd", "cwd must be /workspace or a canonical child directory");
	}
	return absoluteWorkspacePath(value.slice(REMOTE_ROOT.length + 1));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const input = new Uint8Array(bytes.byteLength);
	input.set(bytes);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer));
	return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeBase64(value: string): Uint8Array {
	try {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		if (encodeBase64(bytes) !== value) throw new Error("non-canonical base64");
		return bytes;
	} catch {
		throw new WorkspaceObjectError(400, "invalid_base64", "File contentBase64 is not canonical base64");
	}
}

export function encodeBase64(bytes: Uint8Array): string {
	let result = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		result += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
	}
	return btoa(result);
}

export async function validatePayload(
	payload: FilePayload,
): Promise<{ entry: BoundaryManifestEntry; bytes: Uint8Array }> {
	const path = canonicalRelativePath(payload.path);
	if (
		!Number.isSafeInteger(payload.byteLength) ||
		payload.byteLength < 0 ||
		payload.byteLength > MAX_SYNC_FILE_BYTES
	) {
		throw new WorkspaceObjectError(400, "invalid_file_size", "File byteLength exceeds the synchronized file cap");
	}
	if (!HEX_64.test(payload.sha256)) {
		throw new WorkspaceObjectError(400, "invalid_digest", "File sha256 must be lowercase hexadecimal");
	}
	const bytes = decodeBase64(payload.contentBase64);
	if (bytes.byteLength !== payload.byteLength || (await sha256Hex(bytes)) !== payload.sha256) {
		throw new WorkspaceObjectError(
			422,
			"file_digest_mismatch",
			"File payload digest or byte length does not match content",
		);
	}
	try {
		strictUtf8.decode(bytes);
	} catch {
		throw new WorkspaceObjectError(422, "invalid_utf8", "Synchronized files must contain strict UTF-8");
	}
	return { entry: { path, sha256: payload.sha256, byteLength: bytes.byteLength }, bytes };
}

export async function manifestRootSha256(entries: readonly BoundaryManifestEntry[]): Promise<string> {
	let material = "";
	for (const entry of entries) material += `${entry.path}\0${entry.sha256}\0${entry.byteLength}\n`;
	return sha256Hex(utf8.encode(material));
}

export function validateManifestEntries(entries: readonly BoundaryManifestEntry[]): void {
	let prior = "";
	const destinationKeys = new Set<string>();
	for (const entry of entries) {
		const path = canonicalRelativePath(entry.path);
		if (prior && compareUtf8(path, prior) <= 0) {
			throw new WorkspaceObjectError(400, "invalid_manifest_order", "Manifest paths must be unique and sorted");
		}
		prior = path;
		if (!HEX_64.test(entry.sha256) || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
			throw new WorkspaceObjectError(400, "invalid_manifest_entry", "Manifest entry is malformed");
		}
		const destinationKey = path.normalize("NFC").toLowerCase();
		if (destinationKeys.has(destinationKey)) {
			throw new WorkspaceObjectError(
				409,
				"destination_collision",
				"Manifest contains a case or normalization collision",
			);
		}
		destinationKeys.add(destinationKey);
	}
}

async function lstatOrNull(fs: WorkspaceFilesystemLike, path: string): Promise<WorkspaceStatLike | null> {
	try {
		return await fs.lstat(path);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

export async function requireSafeDirectory(fs: WorkspaceFilesystemLike, absolutePath: string): Promise<void> {
	const canonical = canonicalWorkspaceDirectory(absolutePath);
	let current = REMOTE_ROOT;
	const rootStat = await lstatOrNull(fs, current);
	if (!rootStat?.isDirectory || rootStat.isSymbolicLink) {
		throw new WorkspaceObjectError(400, "invalid_cwd", "Workspace root is not a regular directory");
	}
	if (canonical === REMOTE_ROOT) return;
	for (const segment of canonical.slice(REMOTE_ROOT.length + 1).split("/")) {
		current += `/${segment}`;
		const stat = await lstatOrNull(fs, current);
		if (!stat?.isDirectory || stat.isSymbolicLink) {
			throw new WorkspaceObjectError(
				400,
				"invalid_cwd",
				"cwd contains a missing, non-directory, or symbolic-link component",
			);
		}
	}
}

export async function requireSafeFilePath(
	fs: WorkspaceFilesystemLike,
	relativePath: string,
	createParents: boolean,
): Promise<string> {
	const path = canonicalRelativePath(relativePath);
	const segments = path.split("/");
	let current = REMOTE_ROOT;
	const rootStat = await lstatOrNull(fs, current);
	if (!rootStat?.isDirectory || rootStat.isSymbolicLink) {
		throw new WorkspaceObjectError(400, "unsafe_path", "Workspace root is not a regular directory");
	}
	for (const segment of segments.slice(0, -1)) {
		current += `/${segment}`;
		const stat = await lstatOrNull(fs, current);
		if (!stat) {
			if (createParents) {
				await fs.mkdir(current);
				continue;
			}
			throw new WorkspaceObjectError(404, "file_not_found", "Workspace file does not exist");
		}
		if (!stat.isDirectory || stat.isSymbolicLink) {
			throw new WorkspaceObjectError(
				400,
				"unsafe_path",
				"File path contains a non-directory or symbolic-link ancestor",
			);
		}
	}
	const absolute = `${REMOTE_ROOT}/${path}`;
	const leaf = await lstatOrNull(fs, absolute);
	if (leaf?.isSymbolicLink || (leaf && !leaf.isFile)) {
		throw new WorkspaceObjectError(400, "unsafe_path", "File path names a symbolic link or non-regular entry");
	}
	return absolute;
}

export async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > limit)
				throw new WorkspaceObjectError(422, "file_too_large", "Workspace file exceeds the synchronized file cap");
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export async function readFilePayload(fs: WorkspaceFilesystemLike, relativePath: string): Promise<FilePayload> {
	const path = canonicalRelativePath(relativePath);
	const absolute = await requireSafeFilePath(fs, path, false);
	const stat = await lstatOrNull(fs, absolute);
	if (!stat) throw new WorkspaceObjectError(404, "file_not_found", "Workspace file does not exist");
	if (!stat.isFile || stat.isSymbolicLink) {
		throw new WorkspaceObjectError(400, "unsupported_file", "Path is not a regular file");
	}
	const bytes = await readAll(await fs.readFile(absolute), MAX_SYNC_FILE_BYTES);
	try {
		strictUtf8.decode(bytes);
	} catch {
		throw new WorkspaceObjectError(422, "invalid_utf8", "Synchronized files must contain strict UTF-8");
	}
	return { path, byteLength: bytes.byteLength, sha256: await sha256Hex(bytes), contentBase64: encodeBase64(bytes) };
}

export async function enumerateManifest(
	fs: WorkspaceFilesystemLike,
): Promise<{ entries: BoundaryManifestEntry[]; rootSha256: string }> {
	const entries: BoundaryManifestEntry[] = [];
	let totalBytes = 0;
	const walk = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
		const children = await fs.readdir(absoluteDirectory);
		for (const child of children.sort((left, right) => compareUtf8(left.name, right.name))) {
			const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
			canonicalRelativePath(relative);
			const absolute = `${absoluteDirectory}/${child.name}`;
			const stat = await fs.lstat(absolute);
			if (stat.isSymbolicLink || (!stat.isFile && !stat.isDirectory)) {
				throw new WorkspaceObjectError(
					422,
					"unsupported_entry",
					"Workspace manifest contains a symbolic link or non-regular entry",
				);
			}
			if (stat.isDirectory) {
				await walk(absolute, relative);
				continue;
			}
			if (entries.length >= MAX_SYNC_FILE_COUNT)
				throw new WorkspaceObjectError(422, "too_many_files", "Workspace exceeds the file-count cap");
			const payload = await readFilePayload(fs, relative);
			totalBytes += payload.byteLength;
			if (totalBytes > MAX_SYNC_TOTAL_BYTES)
				throw new WorkspaceObjectError(422, "workspace_too_large", "Workspace exceeds the total-byte cap");
			entries.push({ path: payload.path, sha256: payload.sha256, byteLength: payload.byteLength });
		}
	};
	await requireSafeDirectory(fs, REMOTE_ROOT);
	await walk(REMOTE_ROOT, "");
	entries.sort((left, right) => compareUtf8(left.path, right.path));
	validateManifestEntries(entries);
	return { entries, rootSha256: await manifestRootSha256(entries) };
}
