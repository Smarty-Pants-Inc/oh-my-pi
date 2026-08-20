import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	assertCanonicalRelativePath,
	assertSynchronizedPath,
	buildCreateWorkspaceRequest,
	canonicalRootSha256,
	createSeedBundle,
	type SeedBundle,
	sha256Hex,
	validateBoundaryManifest,
	validateManifestResponse,
} from "../src/client/manifest";
import {
	type BoundaryManifestEntry,
	MAX_HTTP_BODY_BYTES,
	MAX_SYNC_FILE_BYTES,
	MAX_SYNC_FILE_COUNT,
	MAX_SYNC_TOTAL_BYTES,
} from "../src/protocol";
import { createManifestFixture, type ManifestFixture } from "./support/manifest-fixture";

const fixtures: ManifestFixture[] = [];
const ZERO_DIGEST = "0".repeat(64);

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose()));
});

describe("canonical synchronization paths", () => {
	test("rejects escapes, non-POSIX forms, non-NFC text, and invalid Unicode", () => {
		for (const value of [
			"",
			"/absolute",
			"../escape",
			"a/../escape",
			"a//b",
			"a\\b",
			"a/",
			"e\u0301.txt",
			"bad\0name",
			"\ud800",
		]) {
			expect(() => assertCanonicalRelativePath(value)).toThrow();
		}
		expect(() => assertCanonicalRelativePath("src/é.ts")).not.toThrow();
	});

	test("rejects secret, dependency, cache, build, database, and session-state paths", () => {
		for (const value of [
			".env",
			".env.production",
			"src/private.pem",
			"node_modules/pkg/index.js",
			"dist/index.js",
			".omp/sessions/session.json",
			".aws/credentials",
			"state.sqlite-wal",
			"logs/run.log",
		]) {
			expect(() => assertSynchronizedPath(value)).toThrow();
		}
		expect(() => assertSynchronizedPath("src/environment.ts")).not.toThrow();
	});

	test("rejects case and normalization destination collisions", () => {
		for (const paths of [
			["README.md", "readme.md"],
			["É.txt", "é.txt"],
		]) {
			const files = paths.map(path => ({ path, sha256: ZERO_DIGEST, byteLength: 0 }));
			files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
			expect(() => validateBoundaryManifest(files, canonicalRootSha256(files))).toThrow(/collide/);
		}
	});
});

describe("canonical manifests", () => {
	test("uses the specified canonical root digest bytes", () => {
		const files: BoundaryManifestEntry[] = [
			{
				path: "seeded.txt",
				sha256: "e80b71cd14d3cbd65f4173abcbfcf01a545dbca32a72d575108b553a648cc96f",
				byteLength: 8,
			},
		];
		expect(canonicalRootSha256(files)).toBe("8730f2bcee2365a3c30618f5050a0318208d8a830f518b81c6bdb7d5353d723d");
	});

	test("requires a complete sorted response with a matching root", () => {
		const files = [entry("a.txt", "a\n"), entry("b.txt", "b\n")];
		const rootSha256 = canonicalRootSha256(files);
		expect(validateManifestResponse({ phase: "quiesced", rootSha256, files }).rootSha256).toBe(rootSha256);
		expect(() => validateManifestResponse({ phase: "active", rootSha256, files })).toThrow(/quiesced/);
		expect(() => validateManifestResponse({ phase: "quiesced", rootSha256: ZERO_DIGEST, files })).toThrow(
			/root digest/,
		);
		expect(() => validateManifestResponse({ phase: "quiesced", rootSha256, files: [...files].reverse() })).toThrow(
			/sorted/,
		);
		expect(() => validateManifestResponse({ phase: "quiesced", rootSha256, files, partial: true })).toThrow(
			/unknown fields/,
		);
	});

	test("rejects a file path that is also an ancestor directory", () => {
		const files = [
			{ path: "node", sha256: ZERO_DIGEST, byteLength: 0 },
			{ path: "node/child.txt", sha256: ZERO_DIGEST, byteLength: 0 },
		];
		expect(() => validateBoundaryManifest(files, canonicalRootSha256(files))).toThrow(
			/file and one of its descendants/,
		);
	});

	test("enforces count, per-file, and aggregate byte caps without truncation", () => {
		const oversized = [{ path: "large.txt", sha256: ZERO_DIGEST, byteLength: MAX_SYNC_FILE_BYTES + 1 }];
		expect(() => validateBoundaryManifest(oversized, canonicalRootSha256(oversized))).toThrow(/file.*cap/i);

		const tooMany = Array.from({ length: MAX_SYNC_FILE_COUNT + 1 }, (_, index) => ({
			path: `f${index.toString().padStart(4, "0")}.txt`,
			sha256: ZERO_DIGEST,
			byteLength: 0,
		}));
		expect(() => validateBoundaryManifest(tooMany, canonicalRootSha256(tooMany))).toThrow(/file.*cap/i);

		const aggregate = Array.from(
			{ length: Math.floor(MAX_SYNC_TOTAL_BYTES / MAX_SYNC_FILE_BYTES) + 1 },
			(_, index) => ({
				path: `chunk-${index.toString().padStart(3, "0")}.txt`,
				sha256: ZERO_DIGEST,
				byteLength: MAX_SYNC_FILE_BYTES,
			}),
		);
		expect(() => validateBoundaryManifest(aggregate, canonicalRootSha256(aggregate))).toThrow(/total cap/i);
	});
});

describe("git seed enumeration", () => {
	test("enumerates tracked and untracked regular UTF-8 files while excluding ignored files", async () => {
		const fixture = await makeFixture({ ".gitignore": "ignored.txt\n", "tracked.txt": "tracked\n" });
		await fixture.write("untracked/nested.txt", "untracked\n");
		await fixture.write("ignored.txt", "must not upload\n");

		const seed = await createSeedBundle(fixture.root);
		expect(seed.seedManifest.map(file => file.path)).toEqual([".gitignore", "tracked.txt", "untracked/nested.txt"]);
		expect(seed.files.map(file => file.path)).toEqual(seed.seedManifest.map(file => file.path));
		expect(seed.seedRootSha256).toBe(canonicalRootSha256(seed.seedManifest));
		expect(seed.totalBytes).toBe(seed.seedManifest.reduce((total, file) => total + file.byteLength, 0));
		for (const file of seed.files) {
			const bytes = new Uint8Array(Buffer.from(file.contentBase64, "base64"));
			expect(bytes.byteLength).toBe(file.byteLength);
			expect(sha256Hex(bytes)).toBe(file.sha256);
		}

		const request = buildCreateWorkspaceRequest("0123456789abcdef0123456789abcdef", seed);
		expect(request.seedRootSha256).toBe(seed.seedRootSha256);
		expect(request.files).toEqual(seed.files);
	});

	test("rejects a base64 seed whose exact JSON body exceeds the HTTP cap", () => {
		const seed: SeedBundle = {
			seedManifest: [],
			seedRootSha256: canonicalRootSha256([]),
			totalBytes: 0,
			files: [
				{
					path: "oversized.txt",
					sha256: ZERO_DIGEST,
					byteLength: 0,
					contentBase64: "A".repeat(MAX_HTTP_BODY_BYTES),
				},
			],
		};
		expect(() => buildCreateWorkspaceRequest("0123456789abcdef0123456789abcdef", seed)).toThrow(/HTTP body cap/);
	});

	test("rejects a tracked symlink", async () => {
		const fixture = await makeFixture({ "target.txt": "target\n" });
		await fs.symlink("target.txt", path.join(fixture.root, "link.txt"));
		await fixture.track("link.txt");
		await expect(createSeedBundle(fixture.root)).rejects.toMatchObject({ code: "unsupported_local_entry" });
	});

	test("rejects a tracked path that becomes a directory", async () => {
		const fixture = await makeFixture({ directory: "was a file\n" });
		await fs.unlink(path.join(fixture.root, "directory"));
		await fs.mkdir(path.join(fixture.root, "directory"));
		await fixture.write("directory/child.txt", "child\n");
		await expect(createSeedBundle(fixture.root)).rejects.toMatchObject({ code: "unsupported_local_entry" });
	});

	test("rejects invalid UTF-8 and oversized files", async () => {
		const invalidUtf8 = await makeFixture({ "invalid.txt": new Uint8Array([0xc3, 0x28]) });
		await expect(createSeedBundle(invalidUtf8.root)).rejects.toMatchObject({ code: "invalid_utf8" });

		const oversized = await makeFixture({ "large.txt": new Uint8Array(MAX_SYNC_FILE_BYTES + 1) });
		await expect(createSeedBundle(oversized.root)).rejects.toMatchObject({ code: "file_size_exceeded" });
	}, 30_000);

	test("enforces local seed file-count and total-byte caps", async () => {
		const tooMany = await makeFixture({});
		for (let index = 0; index <= MAX_SYNC_FILE_COUNT; index += 1) {
			await tooMany.write(`many/f${index.toString().padStart(4, "0")}.txt`, "");
		}
		await expect(createSeedBundle(tooMany.root)).rejects.toMatchObject({ code: "file_count_exceeded" });

		const tooLarge = await makeFixture({});
		const chunk = new Uint8Array(MAX_SYNC_FILE_BYTES);
		const chunkCount = Math.floor(MAX_SYNC_TOTAL_BYTES / MAX_SYNC_FILE_BYTES) + 1;
		for (let index = 0; index < chunkCount; index += 1) {
			await tooLarge.write(`chunks/f${index.toString().padStart(3, "0")}.txt`, chunk);
		}
		await expect(createSeedBundle(tooLarge.root)).rejects.toMatchObject({ code: "total_bytes_exceeded" });
	}, 30_000);

	test("rejects tracked denied paths instead of silently dropping them", async () => {
		const fixture = await makeFixture({ ".env.local": "NOT_A_REAL_SECRET=fixed-test-literal\n" });
		await expect(createSeedBundle(fixture.root)).rejects.toMatchObject({ code: "denied_path" });
	});
});

function entry(relativePath: string, content: string): BoundaryManifestEntry {
	const bytes = new TextEncoder().encode(content);
	return { path: relativePath, sha256: sha256Hex(bytes), byteLength: bytes.byteLength };
}

async function makeFixture(files: Readonly<Record<string, string | Uint8Array>>): Promise<ManifestFixture> {
	const fixture = await createManifestFixture(files);
	fixtures.push(fixture);
	return fixture;
}
