import * as fs from "node:fs";
import * as path from "node:path";
import {
	classifyCanonicalRelativePath,
	classifySynchronizedRelativePath,
	compareUtf8,
	hasExactObjectKeys,
	MAX_HTTP_BODY_BYTES,
	MAX_SYNC_FILE_BASE64_BYTES,
	MAX_SYNC_FILE_BYTES,
	MAX_SYNC_FILE_COUNT,
	MAX_SYNC_TOTAL_BYTES,
} from "../boundary-policy";
import {
	type BoundaryManifestEntry,
	type CreateWorkspaceRequest,
	type FilePayload,
	isJsonObject,
	type ManifestResponse,
	type WorkspaceState,
} from "../protocol";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const AUDIT_CORRELATION_ID_PATTERN = /^[0-9a-f]{32}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const DOWNLOAD_CONCURRENCY = 8;

async function runGitListing(
	cwd: string,
	args: readonly string[],
	signal?: AbortSignal,
	stdin?: Uint8Array,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const process = Bun.spawn(["git", "--no-optional-locks", ...args], {
		cwd,
		stdin: stdin ?? "ignore",
		stdout: "pipe",
		stderr: "pipe",
		signal,
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function listGitFiles(
	cwd: string,
	options: { others?: boolean; excludeStandard?: boolean; signal?: AbortSignal } = {},
): Promise<string[]> {
	const args = ["ls-files", "-z"];
	if (options.others) args.push("--others");
	if (options.excludeStandard) args.push("--exclude-standard");
	const result = await runGitListing(cwd, args, options.signal);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout.split("\0").filter(Boolean);
}

async function listIgnoredGitFiles(cwd: string, files: readonly string[], signal?: AbortSignal): Promise<string[]> {
	if (files.length === 0) return [];
	const args = ["check-ignore", "-z", "--stdin"];
	const result = await runGitListing(cwd, args, signal, new TextEncoder().encode(`${files.join("\0")}\0`));
	if (result.exitCode === 1) return [];
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout.split("\0").filter(Boolean);
}

export class ManifestBoundaryError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ManifestBoundaryError";
		this.code = code;
	}
}

export interface BoundaryManifestSnapshot {
	readonly rootSha256: string;
	readonly files: readonly BoundaryManifestEntry[];
	readonly fileCount: number;
	readonly totalBytes: number;
}

export interface SeedBundle {
	readonly seedManifest: BoundaryManifestEntry[];
	readonly seedRootSha256: string;
	readonly files: FilePayload[];
	readonly totalBytes: number;
}

export interface ManifestSyncTransport {
	quiesce(signal?: AbortSignal): Promise<WorkspaceState>;
	getManifest(signal?: AbortSignal): Promise<ManifestResponse>;
	readFile(path: string, signal?: AbortSignal): Promise<FilePayload>;
}

export interface SyncBackOptions {
	readonly sourceRoot: string;
	readonly seedManifest: readonly BoundaryManifestEntry[];
	readonly seedRootSha256: string;
	readonly transport: ManifestSyncTransport;
	readonly signal?: AbortSignal;
}

export interface SyncBackResult {
	readonly finalRootSha256: string;
	readonly fileCount: number;
	readonly totalBytes: number;
}

interface LocalFile {
	readonly entry: BoundaryManifestEntry;
	readonly bytes: Uint8Array;
}

export const compareUtf8Paths = compareUtf8;

export function assertCanonicalRelativePath(value: unknown): asserts value is string {
	const classification = classifyCanonicalRelativePath(value);
	if (classification.accepted) return;
	if (classification.reason === "path_not_strict_utf8") {
		fail("invalid_path", "Path must be strict UTF-8");
	}
	if (classification.reason === "path_noncanonical_segment") {
		fail("invalid_path", "Path contains an empty, escaping, or non-canonical segment");
	}
	fail("invalid_path", "Path must be a non-empty canonical relative POSIX path");
}

export function assertSynchronizedPath(value: unknown): asserts value is string {
	const classification = classifySynchronizedRelativePath(value);
	if (classification.accepted) return;
	if (classification.reason === "path_denied_segment") {
		fail("denied_path", `Path is denied from synchronization: ${value}`);
	}
	if (classification.reason === "path_denied_secret_or_hydrated_state") {
		fail("denied_path", `Secret or hydrated-state path is denied from synchronization: ${value}`);
	}
	if (classification.reason === "path_denied_suffix") {
		fail("denied_path", `Secret, database, log, or runtime-state path is denied from synchronization: ${value}`);
	}
	if (classification.reason === "path_denied_gcloud_directory") {
		fail("denied_path", `Credential directory is denied from synchronization: ${value}`);
	}
	assertCanonicalRelativePath(value);
}

export function sha256Hex(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function canonicalRootSha256(entries: readonly BoundaryManifestEntry[]): string {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const entry of entries) {
		hasher.update(entry.path);
		hasher.update("\0");
		hasher.update(entry.sha256);
		hasher.update("\0");
		hasher.update(String(entry.byteLength));
		hasher.update("\n");
	}
	return hasher.digest("hex");
}

export function validateBoundaryManifest(entriesValue: unknown, rootSha256Value: unknown): BoundaryManifestSnapshot {
	if (!Array.isArray(entriesValue)) fail("invalid_manifest", "Manifest files must be an array");
	if (entriesValue.length > MAX_SYNC_FILE_COUNT) {
		fail("file_count_exceeded", `Manifest exceeds the ${MAX_SYNC_FILE_COUNT}-file cap`);
	}
	const rootSha256 = requireSha256(rootSha256Value, "invalid_root_digest");
	const files: BoundaryManifestEntry[] = [];
	const destinationKeys = new Set<string>();
	let previousPath: string | undefined;
	let totalBytes = 0;

	for (const value of entriesValue) {
		const record = requireExactRecord(value, ["path", "sha256", "byteLength"], "invalid_manifest_entry");
		assertSynchronizedPath(record.path);
		const entryPath = record.path;
		const sha256 = requireSha256(record.sha256, "invalid_file_digest");
		const byteLength = requireNonNegativeSafeInteger(record.byteLength, "invalid_file_size");
		if (byteLength > MAX_SYNC_FILE_BYTES) {
			fail("file_size_exceeded", `Manifest file exceeds the ${MAX_SYNC_FILE_BYTES}-byte cap: ${entryPath}`);
		}
		if (previousPath !== undefined && compareUtf8Paths(previousPath, entryPath) >= 0) {
			fail("invalid_manifest_order", "Manifest paths must be unique and sorted by UTF-8 bytes");
		}
		if (previousPath !== undefined && entryPath.startsWith(`${previousPath}/`)) {
			fail("path_prefix_collision", "Manifest cannot contain both a file and one of its descendants");
		}
		previousPath = entryPath;
		const destinationKey = entryPath.normalize("NFC").toLowerCase();
		if (destinationKeys.has(destinationKey)) {
			fail("destination_collision", "Manifest paths collide after NFC normalization and lowercase folding");
		}
		destinationKeys.add(destinationKey);
		totalBytes += byteLength;
		if (totalBytes > MAX_SYNC_TOTAL_BYTES) {
			fail("total_bytes_exceeded", `Manifest exceeds the ${MAX_SYNC_TOTAL_BYTES}-byte total cap`);
		}
		files.push(Object.freeze({ path: entryPath, sha256, byteLength }));
	}

	const computedRoot = canonicalRootSha256(files);
	if (computedRoot !== rootSha256) {
		fail("root_digest_mismatch", "Manifest root digest does not match its complete canonical file list");
	}
	return freezeSnapshot(files, computedRoot, totalBytes);
}

export function validateManifestResponse(value: unknown): BoundaryManifestSnapshot {
	const record = requireExactRecord(value, ["phase", "rootSha256", "files"], "invalid_manifest_response");
	if (record.phase !== "quiesced") {
		fail("workspace_not_quiesced", "Final manifest is valid only for a quiesced workspace");
	}
	return validateBoundaryManifest(record.files, record.rootSha256);
}

export async function captureLocalManifest(
	sourceRoot: string,
	signal?: AbortSignal,
): Promise<BoundaryManifestSnapshot> {
	const files = await enumerateLocalFiles(sourceRoot, signal);
	const entries = files.map(file => file.entry).sort((left, right) => compareUtf8Paths(left.path, right.path));
	return validateBoundaryManifest(entries, canonicalRootSha256(entries));
}

export async function createSeedBundle(sourceRoot: string, signal?: AbortSignal): Promise<SeedBundle> {
	const localFiles = await enumerateLocalFiles(sourceRoot, signal);
	localFiles.sort((left, right) => compareUtf8Paths(left.entry.path, right.entry.path));
	const entries = localFiles.map(file => file.entry);
	const seedManifest = validateBoundaryManifest(entries, canonicalRootSha256(entries));
	const contentByPath = new Map(localFiles.map(file => [file.entry.path, file.bytes] as const));
	const files = seedManifest.files.map(entry => {
		const bytes = contentByPath.get(entry.path);
		if (!bytes) fail("seed_incomplete", `Seed bytes are missing for manifest path: ${entry.path}`);
		return { ...entry, contentBase64: Buffer.from(bytes).toString("base64") };
	});
	return Object.freeze({
		seedManifest: seedManifest.files.map(entry => ({ ...entry })),
		seedRootSha256: seedManifest.rootSha256,
		files,
		totalBytes: seedManifest.totalBytes,
	});
}

export function buildCreateWorkspaceRequest(auditCorrelationId: string, seed: SeedBundle): CreateWorkspaceRequest {
	if (!AUDIT_CORRELATION_ID_PATTERN.test(auditCorrelationId)) {
		fail("invalid_audit_correlation_id", "Audit correlation ID must be 32 lowercase hexadecimal characters");
	}
	const request: CreateWorkspaceRequest = {
		auditCorrelationId,
		seedRootSha256: seed.seedRootSha256,
		files: seed.files,
	};
	const encodedLength = Buffer.byteLength(JSON.stringify(request), "utf8");
	if (encodedLength > MAX_HTTP_BODY_BYTES) {
		fail("seed_body_exceeded", `Base64 seed request exceeds the ${MAX_HTTP_BODY_BYTES}-byte HTTP body cap`);
	}
	return request;
}

export async function syncBack(options: SyncBackOptions): Promise<SyncBackResult> {
	const { sourceRoot, seedManifest, seedRootSha256, transport, signal } = options;
	const sealedSeedManifest = validateBoundaryManifest(seedManifest, seedRootSha256);
	throwIfAborted(signal);
	assertQuiescedState(await transport.quiesce(signal));

	const localAfterQuiesce = await captureLocalManifest(sourceRoot, signal);
	assertManifestEqual(localAfterQuiesce, sealedSeedManifest, "Local isolation worktree drifted after acquisition");

	const finalManifest = validateManifestResponse(await transport.getManifest(signal));
	const seedByPath = new Map(sealedSeedManifest.files.map(entry => [entry.path, entry] as const));
	const finalByPath = new Map(finalManifest.files.map(entry => [entry.path, entry] as const));
	const changed = finalManifest.files.filter(entry => {
		const seedEntry = seedByPath.get(entry.path);
		return !seedEntry || seedEntry.sha256 !== entry.sha256 || seedEntry.byteLength !== entry.byteLength;
	});
	const deletions = sealedSeedManifest.files.filter(entry => !finalByPath.has(entry.path));
	const addedPaths = changed.filter(entry => !seedByPath.has(entry.path)).map(entry => entry.path);
	await assertPathsNotIgnored(sourceRoot, addedPaths, signal);

	const stagingRoot = await createSameFilesystemStagingRoot(sourceRoot);
	try {
		await downloadChangedFiles(stagingRoot, changed, transport, signal);
		await verifyStagedFiles(stagingRoot, changed);

		const localBeforeApply = await captureLocalManifest(sourceRoot, signal);
		assertManifestEqual(
			localBeforeApply,
			sealedSeedManifest,
			"Local isolation worktree drifted during sync download",
		);
		await assertApplyTargetsSafe(sourceRoot, changed, deletions, seedByPath);

		await applyValidatedChanges(sourceRoot, stagingRoot, changed, deletions);
		const appliedManifest = await captureLocalManifest(sourceRoot, signal);
		assertManifestEqual(appliedManifest, finalManifest, "Applied worktree does not match the validated final root");
	} finally {
		await fs.promises.rm(stagingRoot, { recursive: true, force: true });
	}

	return {
		finalRootSha256: finalManifest.rootSha256,
		fileCount: finalManifest.fileCount,
		totalBytes: finalManifest.totalBytes,
	};
}

function freezeSnapshot(
	files: readonly BoundaryManifestEntry[],
	rootSha256: string,
	totalBytes: number,
): BoundaryManifestSnapshot {
	return Object.freeze({
		rootSha256,
		files: Object.freeze([...files]),
		fileCount: files.length,
		totalBytes,
	});
}

async function enumerateLocalFiles(sourceRootValue: string, signal?: AbortSignal): Promise<LocalFile[]> {
	throwIfAborted(signal);
	const sourceRoot = path.resolve(sourceRootValue);
	const sourceRootStat = await requireRegularDirectoryRoot(sourceRoot);
	let trackedPaths: string[];
	let untrackedPaths: string[];
	try {
		[trackedPaths, untrackedPaths] = await Promise.all([
			listGitFiles(sourceRoot, { signal }),
			listGitFiles(sourceRoot, { others: true, excludeStandard: true, signal }),
		]);
	} catch (error) {
		throwIfAborted(signal);
		fail("git_enumeration_failed", "Git synchronization listing failed", error);
	}
	await assertDirectoryIdentity(sourceRoot, sourceRootStat, ".");
	const relativePaths = [...new Set([...trackedPaths, ...untrackedPaths])].sort(compareUtf8Paths);

	const files: LocalFile[] = [];
	const destinationKeys = new Set<string>();
	let totalBytes = 0;
	for (const relativePath of relativePaths) {
		throwIfAborted(signal);
		await assertDirectoryIdentity(sourceRoot, sourceRootStat, ".");
		assertCanonicalRelativePath(relativePath);
		const absolutePath = resolveBoundaryPath(sourceRoot, relativePath);
		const stat = await lstatOrNull(absolutePath);
		if (!stat) continue;
		assertSynchronizedPath(relativePath);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			fail("unsupported_local_entry", `Seed path is not a regular file: ${relativePath}`);
		}
		const destinationKey = relativePath.normalize("NFC").toLowerCase();
		if (destinationKeys.has(destinationKey)) {
			fail("destination_collision", "Local seed paths collide after NFC normalization and lowercase folding");
		}
		destinationKeys.add(destinationKey);
		if (files.length >= MAX_SYNC_FILE_COUNT) {
			fail("file_count_exceeded", `Local seed exceeds the ${MAX_SYNC_FILE_COUNT}-file cap`);
		}
		if (stat.size > MAX_SYNC_FILE_BYTES) {
			fail("file_size_exceeded", `Local seed file exceeds the ${MAX_SYNC_FILE_BYTES}-byte cap: ${relativePath}`);
		}
		const bytes = await readRegularFileNoFollow(absolutePath, relativePath);
		if (bytes.byteLength > MAX_SYNC_FILE_BYTES) {
			fail("file_size_exceeded", `Local seed file exceeds the ${MAX_SYNC_FILE_BYTES}-byte cap: ${relativePath}`);
		}
		assertStrictUtf8Bytes(bytes, relativePath);
		totalBytes += bytes.byteLength;
		if (totalBytes > MAX_SYNC_TOTAL_BYTES) {
			fail("total_bytes_exceeded", `Local seed exceeds the ${MAX_SYNC_TOTAL_BYTES}-byte total cap`);
		}
		files.push({
			entry: Object.freeze({ path: relativePath, sha256: sha256Hex(bytes), byteLength: bytes.byteLength }),
			bytes,
		});
	}
	await assertDirectoryIdentity(sourceRoot, sourceRootStat, ".");
	return files;
}

async function readRegularFileNoFollow(absolutePath: string, displayPath: string): Promise<Uint8Array> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch (error) {
		fail("local_file_changed", `Synchronized file changed or became unsafe while reading: ${displayPath}`, error);
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) fail("unsupported_local_entry", `Seed path is not a regular file: ${displayPath}`);
		return new Uint8Array(await handle.readFile());
	} finally {
		await handle.close();
	}
}

async function assertPathsNotIgnored(
	sourceRootValue: string,
	candidatePaths: readonly string[],
	signal?: AbortSignal,
): Promise<void> {
	if (candidatePaths.length === 0) return;
	const sourceRoot = path.resolve(sourceRootValue);
	const sourceRootStat = await requireRegularDirectoryRoot(sourceRoot);
	let ignoredPaths: string[];
	try {
		ignoredPaths = await listIgnoredGitFiles(sourceRoot, candidatePaths, signal);
	} catch (error) {
		throwIfAborted(signal);
		fail("git_ignore_check_failed", "Git ignore check failed", error);
	}
	await assertDirectoryIdentity(sourceRoot, sourceRootStat, ".");
	if (ignoredPaths.length > 0) {
		fail(
			"ignored_remote_path",
			`Remote manifest contains a path excluded from local synchronization: ${ignoredPaths[0]}`,
		);
	}
}

async function createSameFilesystemStagingRoot(sourceRootValue: string): Promise<string> {
	const sourceRoot = path.resolve(sourceRootValue);
	const parent = path.dirname(sourceRoot);
	const base = path.basename(sourceRoot).replaceAll(path.sep, "-") || "workspace";
	const stagingRoot = await fs.promises.mkdtemp(path.join(parent, `.${base}.cloud-omp-sync-`));
	try {
		await fs.promises.chmod(stagingRoot, 0o700);
		return stagingRoot;
	} catch (error) {
		await fs.promises.rm(stagingRoot, { recursive: true, force: true });
		throw error;
	}
}

async function downloadChangedFiles(
	stagingRoot: string,
	entries: readonly BoundaryManifestEntry[],
	transport: ManifestSyncTransport,
	signal?: AbortSignal,
): Promise<void> {
	let nextIndex = 0;
	let firstError: unknown;
	const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, entries.length) }, async () => {
		for (;;) {
			if (firstError) return;
			const index = nextIndex;
			nextIndex += 1;
			const expected = entries[index];
			if (!expected) return;
			try {
				throwIfAborted(signal);
				const payload = await transport.readFile(expected.path, signal);
				const bytes = validateFilePayload(payload, expected);
				const stagedPath = resolveBoundaryPath(stagingRoot, expected.path);
				await fs.promises.mkdir(path.dirname(stagedPath), { recursive: true });
				await Bun.write(stagedPath, bytes);
			} catch (error) {
				firstError ??= error;
			}
		}
	});
	await Promise.all(workers);
	if (firstError) throw firstError;
}

async function verifyStagedFiles(stagingRoot: string, entries: readonly BoundaryManifestEntry[]): Promise<void> {
	for (const entry of entries) {
		const stagedPath = resolveBoundaryPath(stagingRoot, entry.path);
		const stat = await lstatOrNull(stagedPath);
		if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
			fail("invalid_staged_file", `Downloaded staging entry is missing, symbolic, or non-regular: ${entry.path}`);
		}
		const bytes = await readRegularFileNoFollow(stagedPath, entry.path);
		assertStrictUtf8Bytes(bytes, entry.path);
		if (bytes.byteLength !== entry.byteLength || sha256Hex(bytes) !== entry.sha256) {
			fail(
				"staged_file_mismatch",
				`Downloaded staging entry does not match the sealed final manifest: ${entry.path}`,
			);
		}
	}
}

function validateFilePayload(value: unknown, expected: BoundaryManifestEntry): Uint8Array {
	const record = requireExactRecord(value, ["path", "sha256", "byteLength", "contentBase64"], "invalid_file_payload");
	assertSynchronizedPath(record.path);
	const payloadPath = record.path;
	const sha256 = requireSha256(record.sha256, "invalid_file_digest");
	const byteLength = requireNonNegativeSafeInteger(record.byteLength, "invalid_file_size");
	if (byteLength > MAX_SYNC_FILE_BYTES)
		fail("file_size_exceeded", `Downloaded file exceeds the file cap: ${payloadPath}`);
	if (typeof record.contentBase64 !== "string" || !BASE64_PATTERN.test(record.contentBase64)) {
		fail("invalid_base64", `Downloaded file is not canonical base64: ${payloadPath}`);
	}
	if (record.contentBase64.length > MAX_SYNC_FILE_BASE64_BYTES) {
		fail("file_size_exceeded", `Downloaded base64 file exceeds the encoded file cap: ${payloadPath}`);
	}
	const bytes = new Uint8Array(Buffer.from(record.contentBase64, "base64"));
	if (Buffer.from(bytes).toString("base64") !== record.contentBase64) {
		fail("invalid_base64", `Downloaded file is not canonical base64: ${payloadPath}`);
	}
	assertStrictUtf8Bytes(bytes, payloadPath);
	if (
		payloadPath !== expected.path ||
		sha256 !== expected.sha256 ||
		byteLength !== expected.byteLength ||
		bytes.byteLength !== expected.byteLength ||
		sha256Hex(bytes) !== expected.sha256
	) {
		fail("file_payload_mismatch", `Downloaded file does not match the sealed final manifest: ${expected.path}`);
	}
	return bytes;
}

async function assertApplyTargetsSafe(
	sourceRootValue: string,
	writes: readonly BoundaryManifestEntry[],
	deletions: readonly BoundaryManifestEntry[],
	seedByPath: ReadonlyMap<string, BoundaryManifestEntry>,
): Promise<void> {
	const sourceRoot = path.resolve(sourceRootValue);
	await requireRegularDirectoryRoot(sourceRoot);
	const deletionPaths = new Set(deletions.map(entry => entry.path));
	for (const entry of [...deletions, ...writes]) {
		const segments = entry.path.split("/");
		let current = sourceRoot;
		for (const segment of segments.slice(0, -1)) {
			current = path.join(current, segment);
			const stat = await lstatOrNull(current);
			if (!stat) break;
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				fail("unsafe_local_target", `Local sync target has a symlink or non-directory ancestor: ${entry.path}`);
			}
		}
		const target = resolveBoundaryPath(sourceRoot, entry.path);
		const leaf = await lstatOrNull(target);
		if (deletionPaths.has(entry.path)) {
			if (!leaf || leaf.isSymbolicLink() || !leaf.isFile()) {
				fail("unsafe_local_target", `Local deletion target is missing, symbolic, or non-regular: ${entry.path}`);
			}
			continue;
		}
		if (leaf && (leaf.isSymbolicLink() || !leaf.isFile())) {
			fail("unsafe_local_target", `Local write target is symbolic or non-regular: ${entry.path}`);
		}
		if (leaf && !seedByPath.has(entry.path)) {
			fail("unexpected_local_target", `Remote addition would overwrite an unsupported local file: ${entry.path}`);
		}
	}
}

async function applyValidatedChanges(
	sourceRootValue: string,
	stagingRoot: string,
	writes: readonly BoundaryManifestEntry[],
	deletions: readonly BoundaryManifestEntry[],
): Promise<void> {
	const sourceRoot = path.resolve(sourceRootValue);
	for (const entry of [...deletions].sort((left, right) => compareUtf8Paths(right.path, left.path))) {
		await fs.promises.unlink(resolveBoundaryPath(sourceRoot, entry.path));
	}
	for (const entry of writes) {
		const target = resolveBoundaryPath(sourceRoot, entry.path);
		const staged = resolveBoundaryPath(stagingRoot, entry.path);
		await fs.promises.mkdir(path.dirname(target), { recursive: true });
		await fs.promises.rename(staged, target);
	}
}

function assertQuiescedState(value: unknown): asserts value is WorkspaceState {
	const record = requireExactRecord(
		value,
		["phase", "activeExecutions", "pendingSyncs", "exhaustedSyncs"],
		"invalid_quiesce_state",
	);
	if (record.phase !== "quiesced") fail("workspace_not_quiesced", "Workspace did not reach the quiesced phase");
	for (const key of ["activeExecutions", "pendingSyncs", "exhaustedSyncs"] as const) {
		const count = requireNonNegativeSafeInteger(record[key], "invalid_quiesce_state");
		if (count !== 0) {
			fail("incomplete_provider_sync", `Workspace quiesce reported nonzero ${key}`);
		}
	}
}

function assertManifestEqual(
	actual: BoundaryManifestSnapshot,
	expected: BoundaryManifestSnapshot,
	message: string,
): void {
	if (
		actual.rootSha256 !== expected.rootSha256 ||
		actual.fileCount !== expected.fileCount ||
		actual.totalBytes !== expected.totalBytes ||
		actual.files.some((entry, index) => {
			const expectedEntry = expected.files[index];
			return (
				!expectedEntry ||
				entry.path !== expectedEntry.path ||
				entry.sha256 !== expectedEntry.sha256 ||
				entry.byteLength !== expectedEntry.byteLength
			);
		})
	) {
		fail("manifest_drift", message);
	}
}

async function requireRegularDirectoryRoot(root: string): Promise<fs.Stats> {
	const stat = await lstatOrNull(root);
	if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
		fail("invalid_source_root", "Synchronization sourceRoot must be an existing non-symlink directory");
	}
	return stat;
}

async function assertDirectoryIdentity(absolutePath: string, expected: fs.Stats, displayPath: string): Promise<void> {
	const actual = await lstatOrNull(absolutePath);
	if (
		!actual ||
		actual.isSymbolicLink() ||
		!actual.isDirectory() ||
		actual.dev !== expected.dev ||
		actual.ino !== expected.ino
	) {
		fail("local_file_changed", `Synchronized directory changed or became unsafe while reading: ${displayPath}`);
	}
}

function resolveBoundaryPath(root: string, relativePath: string): string {
	assertCanonicalRelativePath(relativePath);
	const absolute = path.resolve(root, ...relativePath.split("/"));
	if (!absolute.startsWith(`${root}${path.sep}`))
		fail("path_escape", "Resolved path escaped the synchronization root");
	return absolute;
}

async function lstatOrNull(filePath: string): Promise<fs.Stats | null> {
	try {
		return await fs.promises.lstat(filePath);
	} catch (error) {
		if (error !== null && typeof error === "object" && "code" in error && Reflect.get(error, "code") === "ENOENT") {
			return null;
		}
		throw error;
	}
}

function decodeStrictUtf8(bytes: Uint8Array, message: string): string {
	try {
		return STRICT_UTF8_DECODER.decode(bytes);
	} catch (error) {
		fail("invalid_utf8", message, error);
	}
}

function assertStrictUtf8Bytes(bytes: Uint8Array, displayPath: string): void {
	decodeStrictUtf8(bytes, `Synchronized file is not strict UTF-8: ${displayPath}`);
}

function requireExactRecord(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
	if (!isJsonObject(value)) fail(code, "Expected a JSON object");
	if (!hasExactObjectKeys(value, keys)) {
		fail(code, "Object contains missing or unknown fields");
	}
	return value;
}

function requireSha256(value: unknown, code: string): string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(code, "Expected a lowercase SHA-256 digest");
	return value;
}

function requireNonNegativeSafeInteger(value: unknown, code: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) fail(code, "Expected a non-negative safe integer");
	return value as number;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

function fail(code: string, message: string, cause?: unknown): never {
	const error = new ManifestBoundaryError(code, message);
	if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause, configurable: true });
	throw error;
}
