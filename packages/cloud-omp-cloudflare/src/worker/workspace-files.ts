import type {
	PersistentModelWorkspacePath,
	ReplicaCheckpoint,
	RuntimeSearchMatch,
	WorkspaceSnapshot,
	WorkspaceSnapshotFile,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import {
	classifySynchronizedRelativePath,
	compareUtf8,
	MAX_SYNC_FILE_BYTES,
	MAX_SYNC_FILE_COUNT,
	MAX_SYNC_TOTAL_BYTES,
} from "../boundary-policy";
import {
	type BoundaryManifestEntry,
	CLOUDFLARE_RUNTIME_SEARCH_BYTE_BUDGET_V1,
	CLOUDFLARE_RUNTIME_SEARCH_CURSOR_MAX_CHARS_V1,
	CLOUDFLARE_RUNTIME_SEARCH_FILE_BUDGET_V1,
	CLOUDFLARE_RUNTIME_SEARCH_RESULT_BYTE_BUDGET_V1,
	CLOUDFLARE_RUNTIME_SEARCH_TRAVERSAL_BUDGET_V1,
	type CloudflareRuntimeSearchCursorPositionV1,
	type FilePayload,
	runtimeSearchCursorPathFitsV1,
} from "../protocol";
import { WorkspaceObjectError } from "./errors";

export { compareUtf8 };

export const REMOTE_ROOT = "/workspace" as const;

export interface WorkspaceStatLike {
	inode: number;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
	size: number;
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
	rename(oldPath: string, newPath: string): Promise<void>;
}

export interface AtomicRenameWorkspaceLike {
	readonly fs: Omit<WorkspaceFilesystemLike, "rename">;
	provider(): Pick<WorkspaceFilesystemLike, "rename">;
}

export function adaptWorkspaceFilesystem(workspace: AtomicRenameWorkspaceLike): WorkspaceFilesystemLike {
	const fs = workspace.fs;
	const provider = workspace.provider();
	return {
		readFile: path => fs.readFile(path),
		lstat: path => fs.lstat(path),
		readdir: path => fs.readdir(path),
		writeFile: (path, content) => fs.writeFile(path, content),
		mkdir: (path, options) => fs.mkdir(path, options),
		rm: (path, options) => fs.rm(path, options),
		rename: (oldPath, newPath) => provider.rename(oldPath, newPath),
	};
}

const HEX_64 = /^[0-9a-f]{64}$/;
const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export function canonicalRelativePath(value: string): WorkspaceSnapshotFile["path"] {
	const classification = classifySynchronizedRelativePath(value);
	if (classification.accepted) return classification.path as WorkspaceSnapshotFile["path"];
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

export function runtimeRelativePath(value: string): string {
	if (!value.startsWith(`${REMOTE_ROOT}/`)) {
		throw new WorkspaceObjectError(400, "invalid_path", "Runtime path must be a canonical /workspace child");
	}
	return canonicalRelativePath(value.slice(REMOTE_ROOT.length + 1));
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

export async function resolveWorkspacePathNoSymlinkAncestors(
	fs: WorkspaceFilesystemLike,
	path: string,
	createParents = false,
): Promise<string> {
	const absolute = path === REMOTE_ROOT ? REMOTE_ROOT : `${REMOTE_ROOT}/${runtimeRelativePath(path)}`;
	const rootStat = await lstatOrNull(fs, REMOTE_ROOT);
	if (!rootStat?.isDirectory || rootStat.isSymbolicLink) {
		throw new WorkspaceObjectError(400, "unsafe_path", "Workspace root is not a regular directory");
	}
	if (absolute === REMOTE_ROOT) return absolute;
	let current = REMOTE_ROOT;
	for (const segment of absolute
		.slice(REMOTE_ROOT.length + 1)
		.split("/")
		.slice(0, -1)) {
		current += `/${segment}`;
		const stat = await lstatOrNull(fs, current);
		if (!stat) {
			if (createParents) {
				await fs.mkdir(current);
				continue;
			}
			break;
		}
		if (!stat.isDirectory || stat.isSymbolicLink) {
			throw new WorkspaceObjectError(
				400,
				"unsafe_path",
				"Runtime path contains a non-directory or symlink ancestor",
			);
		}
	}
	return absolute;
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

export async function validateWorkspaceSnapshot(snapshot: WorkspaceSnapshot): Promise<{
	files: Array<{ entry: WorkspaceSnapshotFile; bytes: Uint8Array }>;
	rootSha256: string;
	byteCount: number;
}> {
	if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.files)) {
		throw new WorkspaceObjectError(400, "protocol_invalid", "Runtime workspace snapshot is malformed");
	}
	if (snapshot.files.length > MAX_SYNC_FILE_COUNT) {
		throw new WorkspaceObjectError(422, "too_many_files", "Runtime workspace snapshot exceeds the file-count cap");
	}
	const files: Array<{ entry: WorkspaceSnapshotFile; bytes: Uint8Array }> = [];
	let byteCount = 0;
	for (const entry of snapshot.files) {
		const path = canonicalRelativePath(entry.path);
		if (typeof entry.contentUtf8 !== "string") {
			throw new WorkspaceObjectError(422, "invalid_utf8", "Runtime workspace files must contain strict UTF-8");
		}
		const bytes = utf8.encode(entry.contentUtf8);
		if (strictUtf8.decode(bytes) !== entry.contentUtf8) {
			throw new WorkspaceObjectError(422, "invalid_utf8", "Runtime workspace files must contain strict UTF-8");
		}
		if (
			!Number.isSafeInteger(entry.byteLength) ||
			entry.byteLength !== bytes.byteLength ||
			entry.byteLength > MAX_SYNC_FILE_BYTES ||
			!HEX_64.test(entry.sha256) ||
			(await sha256Hex(bytes)) !== entry.sha256
		) {
			throw new WorkspaceObjectError(
				422,
				"file_digest_mismatch",
				"Runtime workspace file metadata does not match content",
			);
		}
		byteCount += bytes.byteLength;
		if (byteCount > MAX_SYNC_TOTAL_BYTES) {
			throw new WorkspaceObjectError(
				422,
				"workspace_too_large",
				"Runtime workspace snapshot exceeds the total-byte cap",
			);
		}
		files.push({ entry: { ...entry, path }, bytes });
	}
	validateManifestEntries(files.map(file => file.entry));
	const rootSha256 = await manifestRootSha256(files.map(file => file.entry));
	if (
		snapshot.checkpoint.rootSha256 !== rootSha256 ||
		snapshot.checkpoint.fileCount !== files.length ||
		snapshot.checkpoint.byteCount !== byteCount
	) {
		throw new WorkspaceObjectError(
			422,
			"checkpoint_generation_mismatch",
			"Runtime checkpoint image metadata is invalid",
		);
	}
	return { files, rootSha256, byteCount };
}

export async function materializeWorkspaceSnapshot(
	fs: WorkspaceFilesystemLike,
	snapshot: WorkspaceSnapshot,
): Promise<{
	rootSha256: string;
	fileCount: number;
	byteCount: number;
}> {
	const validated = await validateWorkspaceSnapshot(snapshot);
	await fs.rm(REMOTE_ROOT, { recursive: true, force: true });
	await fs.mkdir(REMOTE_ROOT, { recursive: true });
	for (const file of validated.files) {
		const absolute = await requireSafeFilePath(fs, file.entry.path, true);
		await fs.writeFile(absolute, file.bytes);
	}
	const frozen = await enumerateWorkspaceSnapshotFiles(fs);
	if (
		frozen.rootSha256 !== validated.rootSha256 ||
		frozen.files.length !== validated.files.length ||
		frozen.byteCount !== validated.byteCount
	) {
		throw new WorkspaceObjectError(
			500,
			"seed_verify_failed",
			"Runtime workspace materialization verification failed",
		);
	}
	return { rootSha256: frozen.rootSha256, fileCount: frozen.files.length, byteCount: frozen.byteCount };
}

export async function enumerateWorkspaceSnapshotFiles(fs: WorkspaceFilesystemLike): Promise<{
	files: WorkspaceSnapshotFile[];
	rootSha256: string;
	byteCount: number;
}> {
	const manifest = await enumerateManifest(fs);
	const files: WorkspaceSnapshotFile[] = [];
	let byteCount = 0;
	for (const entry of manifest.entries) {
		const payload = await readFilePayload(fs, entry.path);
		const bytes = decodeBase64(payload.contentBase64);
		const contentUtf8 = strictUtf8.decode(bytes);
		byteCount += bytes.byteLength;
		files.push({
			path: canonicalRelativePath(entry.path),
			sha256: entry.sha256,
			byteLength: entry.byteLength,
			contentUtf8,
		});
	}
	return { files, rootSha256: manifest.rootSha256, byteCount };
}

export async function freezeReplicaCheckpoint(
	fs: WorkspaceFilesystemLike,
	reference: ReplicaCheckpoint["reference"],
): Promise<ReplicaCheckpoint> {
	const snapshot = await enumerateWorkspaceSnapshotFiles(fs);
	if (
		reference.rootSha256 !== snapshot.rootSha256 ||
		reference.fileCount !== snapshot.files.length ||
		reference.byteCount !== snapshot.byteCount
	) {
		throw new WorkspaceObjectError(
			409,
			"request_conflict",
			"Frozen checkpoint reference does not match runtime bytes",
		);
	}
	return {
		reference,
		files: snapshot.files,
		rootSha256: snapshot.rootSha256,
		fileCount: snapshot.files.length,
		byteCount: snapshot.byteCount,
	};
}

export async function readRuntimeFileBytes(
	fs: WorkspaceFilesystemLike,
	path: string,
	limit: number = MAX_SYNC_FILE_BYTES,
): Promise<Uint8Array> {
	const relative = runtimeRelativePath(path);
	const absolute = await requireSafeFilePath(fs, relative, false);
	return readAll(await fs.readFile(absolute), limit);
}

export async function searchWorkspaceText(
	fs: WorkspaceFilesystemLike,
	path: string,
	expression: RegExp,
	cursor: CloudflareRuntimeSearchCursorPositionV1 | null,
	limit: number,
): Promise<{ matches: RuntimeSearchMatch[]; nextPosition: CloudflareRuntimeSearchCursorPositionV1 | null }> {
	const matches: RuntimeSearchMatch[] = [];
	let filesScanned = 0;
	let bytesScanned = 0;
	let traversalSteps = 0;
	let cursorReached = cursor === null;
	let resultMatchBytes = 0;
	const resultFixedBytes =
		utf8.encode('{"matches":[],"nextCursor":""}').byteLength + CLOUDFLARE_RUNTIME_SEARCH_CURSOR_MAX_CHARS_V1;

	const requiredCursorPath = (runtimePath: string): PersistentModelWorkspacePath => {
		const typed = runtimePath as PersistentModelWorkspacePath;
		if (!runtimeSearchCursorPathFitsV1(typed)) {
			throw new WorkspaceObjectError(422, "invalid_path", "Runtime search path exceeds the cursor budget");
		}
		return typed;
	};
	const continuationAt = (runtimePath: string, codeUnitOffset = 0): CloudflareRuntimeSearchCursorPositionV1 => ({
		path: requiredCursorPath(runtimePath),
		codeUnitOffset,
	});
	const consumeTraversalStep = (): boolean => {
		if (traversalSteps >= CLOUDFLARE_RUNTIME_SEARCH_TRAVERSAL_BUDGET_V1) return false;
		traversalSteps++;
		return true;
	};
	const requireTraversalStep = (): void => {
		if (!consumeTraversalStep()) {
			throw new WorkspaceObjectError(422, "invalid_path", "Runtime search path exceeds the traversal budget");
		}
	};
	const lstatRequired = async (absolutePath: string): Promise<WorkspaceStatLike> => {
		requireTraversalStep();
		const stat = await lstatOrNull(fs, absolutePath);
		if (!stat) throw new WorkspaceObjectError(404, "file_not_found", "Runtime search path does not exist");
		return stat;
	};

	const searchFile = async (
		relativePath: string,
		absolutePath: string,
		stat: WorkspaceStatLike,
	): Promise<CloudflareRuntimeSearchCursorPositionV1 | null> => {
		const runtimePath = requiredCursorPath(`${REMOTE_ROOT}/${relativePath}`);
		let startIndex = 0;
		if (!cursorReached && cursor) {
			if (runtimePath !== cursor.path) {
				throw new WorkspaceObjectError(409, "request_conflict", "Runtime search cursor path no longer exists");
			}
			cursorReached = true;
			startIndex = cursor.codeUnitOffset;
		}
		if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_SYNC_FILE_BYTES) {
			throw new WorkspaceObjectError(422, "file_too_large", "Runtime search file size is invalid");
		}
		if (
			filesScanned >= CLOUDFLARE_RUNTIME_SEARCH_FILE_BUDGET_V1 ||
			bytesScanned + stat.size > CLOUDFLARE_RUNTIME_SEARCH_BYTE_BUDGET_V1
		) {
			return continuationAt(runtimePath, startIndex);
		}

		const bytes = await readAll(
			await fs.readFile(absolutePath),
			Math.min(MAX_SYNC_FILE_BYTES, CLOUDFLARE_RUNTIME_SEARCH_BYTE_BUDGET_V1 - bytesScanned),
		);
		if (bytes.byteLength !== stat.size) {
			throw new WorkspaceObjectError(409, "request_conflict", "Runtime search file changed during traversal");
		}
		filesScanned++;
		bytesScanned += bytes.byteLength;
		let text: string;
		try {
			text = strictUtf8.decode(bytes);
		} catch {
			throw new WorkspaceObjectError(422, "invalid_utf8", "Runtime text files must contain strict UTF-8");
		}
		if (startIndex > text.length) {
			throw new WorkspaceObjectError(409, "request_conflict", "Runtime search cursor position is stale");
		}

		expression.lastIndex = startIndex;
		let line = 1;
		let lineStart = 0;
		let newlineSearchFrom = 0;
		for (;;) {
			const match = expression.exec(text);
			if (!match) break;
			const start = match.index;
			while (true) {
				const newline = text.indexOf("\n", newlineSearchFrom);
				if (newline < 0 || newline >= start) break;
				line++;
				lineStart = newline + 1;
				newlineSearchFrom = newline + 1;
			}
			if (matches.length === limit) return continuationAt(runtimePath, start);
			const lineEnd = text.indexOf("\n", start);
			const candidate: RuntimeSearchMatch = {
				path: runtimePath,
				line,
				column: start - lineStart + 1,
				text: text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd),
			};
			const candidateBytes = utf8.encode(JSON.stringify(candidate)).byteLength;
			const separatorBytes = matches.length === 0 ? 0 : 1;
			if (
				resultFixedBytes + resultMatchBytes + separatorBytes + candidateBytes >
				CLOUDFLARE_RUNTIME_SEARCH_RESULT_BYTE_BUDGET_V1
			) {
				if (matches.length === 0) {
					throw new WorkspaceObjectError(
						422,
						"workspace_too_large",
						"A runtime search match exceeds the result budget",
					);
				}
				return continuationAt(runtimePath, start);
			}
			resultMatchBytes += separatorBytes + candidateBytes;
			matches.push(candidate);
			if (match[0].length === 0) expression.lastIndex = start + 1;
		}
		return null;
	};

	const childOrderKey = (child: WorkspaceDirentLike): string => `${child.name}${child.isDirectory ? "/" : ""}`;
	const lowerBoundChild = (children: readonly WorkspaceDirentLike[], key: string): number => {
		let lower = 0;
		let upper = children.length;
		while (lower < upper) {
			const middle = lower + Math.floor((upper - lower) / 2);
			if (compareUtf8(childOrderKey(children[middle]!), key) < 0) lower = middle + 1;
			else upper = middle;
		}
		return lower;
	};
	const firstRelevantChild = (children: readonly WorkspaceDirentLike[], directoryRuntimePath: string): number => {
		if (cursorReached) return 0;
		if (!cursor) return 0;
		const prefix = `${directoryRuntimePath}/`;
		if (!cursor.path.startsWith(prefix)) {
			throw new WorkspaceObjectError(409, "request_conflict", "Runtime search cursor path no longer exists");
		}
		const suffix = cursor.path.slice(prefix.length);
		const separator = suffix.indexOf("/");
		if (separator >= 0) {
			const name = suffix.slice(0, separator);
			const index = lowerBoundChild(children, `${name}/`);
			if (children[index]?.name === name && children[index]?.isDirectory) return index;
		} else {
			const fileIndex = lowerBoundChild(children, suffix);
			if (children[fileIndex]?.name === suffix && !children[fileIndex]?.isDirectory) return fileIndex;
			const directoryIndex = lowerBoundChild(children, `${suffix}/`);
			if (children[directoryIndex]?.name === suffix && children[directoryIndex]?.isDirectory) return directoryIndex;
		}
		throw new WorkspaceObjectError(409, "request_conflict", "Runtime search cursor path no longer exists");
	};

	const walk = async (
		absoluteDirectory: string,
		relativeDirectory: string,
	): Promise<CloudflareRuntimeSearchCursorPositionV1 | null> => {
		const directoryRuntimePath = relativeDirectory ? `${REMOTE_ROOT}/${relativeDirectory}` : REMOTE_ROOT;
		if (!consumeTraversalStep()) return continuationAt(directoryRuntimePath);
		const children = await fs.readdir(absoluteDirectory);
		if (children.length > MAX_SYNC_FILE_COUNT) {
			throw new WorkspaceObjectError(422, "too_many_files", "Runtime search directory exceeds the entry budget");
		}
		children.sort((left, right) =>
			compareUtf8(`${left.name}${left.isDirectory ? "/" : ""}`, `${right.name}${right.isDirectory ? "/" : ""}`),
		);
		const startIndex = firstRelevantChild(children, directoryRuntimePath);
		for (let index = startIndex; index < children.length; index++) {
			const child = children[index]!;
			const relative = canonicalRelativePath(relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name);
			const runtimePath = `${REMOTE_ROOT}/${relative}`;
			if (!consumeTraversalStep()) return continuationAt(runtimePath);
			const absolute = `${absoluteDirectory}/${child.name}`;
			const stat = await lstatOrNull(fs, absolute);
			if (!stat) {
				throw new WorkspaceObjectError(409, "request_conflict", "Runtime search entry changed during traversal");
			}
			if (
				stat.isSymbolicLink ||
				(!stat.isFile && !stat.isDirectory) ||
				child.isSymbolicLink ||
				child.isFile !== stat.isFile ||
				child.isDirectory !== stat.isDirectory
			) {
				throw new WorkspaceObjectError(
					422,
					"unsupported_entry",
					"Text search encountered a symbolic link, changed entry, or non-regular entry",
				);
			}
			if (stat.isDirectory) {
				if (!cursorReached && cursor?.path === runtimePath) {
					if (cursor.codeUnitOffset !== 0) {
						throw new WorkspaceObjectError(409, "request_conflict", "Runtime search directory cursor is invalid");
					}
					cursorReached = true;
				}
				const continuation = await walk(absolute, relative);
				if (continuation) return continuation;
			} else {
				const continuation = await searchFile(relative, absolute, stat);
				if (continuation) return continuation;
			}
		}
		return null;
	};

	const relativeSegments = path === REMOTE_ROOT ? [] : runtimeRelativePath(path).split("/");
	if (relativeSegments.length + 1 > CLOUDFLARE_RUNTIME_SEARCH_TRAVERSAL_BUDGET_V1) {
		throw new WorkspaceObjectError(422, "invalid_path", "Runtime search path exceeds the traversal budget");
	}
	let absolute = REMOTE_ROOT;
	let stat = await lstatRequired(absolute);
	if (!stat.isDirectory || stat.isSymbolicLink) {
		throw new WorkspaceObjectError(400, "unsafe_path", "Workspace root is not a regular directory");
	}
	for (const [index, segment] of relativeSegments.entries()) {
		absolute += `/${segment}`;
		stat = await lstatRequired(absolute);
		if (stat.isSymbolicLink || (index < relativeSegments.length - 1 && !stat.isDirectory)) {
			throw new WorkspaceObjectError(400, "unsafe_path", "Runtime search path contains an unsafe ancestor");
		}
	}
	if (stat.isSymbolicLink || (!stat.isFile && !stat.isDirectory)) {
		throw new WorkspaceObjectError(400, "unsafe_path", "Runtime search path is not a regular file or directory");
	}
	if (stat.isDirectory && cursor?.path === path) {
		if (cursor.codeUnitOffset !== 0) {
			throw new WorkspaceObjectError(409, "request_conflict", "Runtime search directory cursor is invalid");
		}
		cursorReached = true;
	}
	const nextPosition = stat.isDirectory
		? await walk(absolute, path === REMOTE_ROOT ? "" : runtimeRelativePath(path))
		: await searchFile(runtimeRelativePath(path), absolute, stat);
	if (!cursorReached && nextPosition === null) {
		throw new WorkspaceObjectError(409, "request_conflict", "Runtime search cursor path no longer exists");
	}
	return { matches, nextPosition };
}

export async function purgeRuntimeWorkspaceBytes(fs: WorkspaceFilesystemLike): Promise<void> {
	await fs.rm(REMOTE_ROOT, { recursive: true, force: true });
	await fs.mkdir(REMOTE_ROOT, { recursive: true });
}
