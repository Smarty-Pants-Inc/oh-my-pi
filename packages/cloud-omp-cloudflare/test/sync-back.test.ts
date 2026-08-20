import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	canonicalRootSha256,
	compareUtf8Paths,
	createSeedBundle,
	type ManifestSyncTransport,
	type SeedBundle,
	sha256Hex,
	syncBack,
} from "../src/client/manifest";
import type { BoundaryManifestEntry, FilePayload, ManifestResponse, WorkspaceState } from "../src/protocol";
import { createManifestFixture, type ManifestFixture } from "./support/manifest-fixture";

const fixtures: ManifestFixture[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose()));
});

describe("validated sync-back", () => {
	test("applies differential writes and seed-tracked deletions only after complete validation", async () => {
		const fixture = await makeFixture({
			"change.txt": "old change\n",
			"delete.txt": "delete me\n",
			"keep.txt": "keep\n",
		});
		const seed = await createSeedBundle(fixture.root);
		const remoteFiles = {
			"added/nested.txt": "added\n",
			"change.txt": "new change\n",
			"keep.txt": "keep\n",
		};
		const final = sealedManifest(remoteFiles);
		const readPaths: string[] = [];

		const result = await syncBack({
			sourceRoot: fixture.root,
			seedManifest: seed.seedManifest,
			seedRootSha256: seed.seedRootSha256,
			transport: transportFor(final, remoteFiles, readPaths),
		});

		expect(readPaths).toEqual(["added/nested.txt", "change.txt"]);
		expect(await Bun.file(path.join(fixture.root, "keep.txt")).text()).toBe("keep\n");
		expect(await Bun.file(path.join(fixture.root, "change.txt")).text()).toBe("new change\n");
		expect(await Bun.file(path.join(fixture.root, "added/nested.txt")).text()).toBe("added\n");
		expect(await Bun.file(path.join(fixture.root, "delete.txt")).exists()).toBe(false);
		expect(result).toEqual({
			finalRootSha256: final.rootSha256,
			fileCount: final.files.length,
			totalBytes: final.files.reduce((total, file) => total + file.byteLength, 0),
		});
	});

	test("does not mutate the worktree when any downloaded file fails the sealed manifest", async () => {
		const fixture = await makeFixture({
			"change.txt": "old change\n",
			"delete.txt": "delete me\n",
		});
		const seed = await createSeedBundle(fixture.root);
		const remoteFiles = { "added.txt": "added\n", "change.txt": "new change\n" };
		const final = sealedManifest(remoteFiles);
		const transport = transportFor(final, remoteFiles);
		transport.readFile = async relativePath => {
			const expected = final.files.find(file => file.path === relativePath)!;
			if (relativePath === "change.txt") {
				return { ...expected, contentBase64: Buffer.from("tampered\n").toString("base64") };
			}
			return payload(relativePath, remoteFiles[relativePath as keyof typeof remoteFiles]);
		};

		await expect(runSync(fixture, seed, transport)).rejects.toMatchObject({ code: "file_payload_mismatch" });
		expect(await Bun.file(path.join(fixture.root, "change.txt")).text()).toBe("old change\n");
		expect(await Bun.file(path.join(fixture.root, "delete.txt")).text()).toBe("delete me\n");
		expect(await Bun.file(path.join(fixture.root, "added.txt")).exists()).toBe(false);
	});

	test("rejects incomplete, pending, exhausted, skipped, or unknown quiesce state before manifest fetch", async () => {
		const fixture = await makeFixture({ "keep.txt": "keep\n" });
		const seed = await createSeedBundle(fixture.root);
		const states: unknown[] = [
			{ phase: "quiescing", activeExecutions: 0, pendingSyncs: 0, exhaustedSyncs: 0 },
			{ phase: "quiesced", activeExecutions: 1, pendingSyncs: 0, exhaustedSyncs: 0 },
			{ phase: "quiesced", activeExecutions: 0, pendingSyncs: 1, exhaustedSyncs: 0 },
			{ phase: "quiesced", activeExecutions: 0, pendingSyncs: 0, exhaustedSyncs: 1 },
			{ phase: "quiesced", activeExecutions: 0, pendingSyncs: 0 },
			{ phase: "quiesced", activeExecutions: 0, pendingSyncs: 0, exhaustedSyncs: 0, sync: "skipped" },
		];
		for (const state of states) {
			let manifestRequested = false;
			const transport: ManifestSyncTransport = {
				quiesce: async () => state as WorkspaceState,
				getManifest: async () => {
					manifestRequested = true;
					throw new Error("manifest must not be requested");
				},
				readFile: async () => {
					throw new Error("file must not be requested");
				},
			};
			await expect(runSync(fixture, seed, transport)).rejects.toBeInstanceOf(Error);
			expect(manifestRequested).toBe(false);
		}
	});

	test("proves the local seed is unchanged before requesting or applying the remote result", async () => {
		const fixture = await makeFixture({ "tracked.txt": "seed\n" });
		const seed = await createSeedBundle(fixture.root);
		await fixture.write("tracked.txt", "local drift\n");
		let manifestRequested = false;
		const transport: ManifestSyncTransport = {
			quiesce: quiesced,
			getManifest: async () => {
				manifestRequested = true;
				throw new Error("manifest must not be requested after drift");
			},
			readFile: async () => {
				throw new Error("file must not be requested after drift");
			},
		};

		await expect(runSync(fixture, seed, transport)).rejects.toMatchObject({ code: "manifest_drift" });
		expect(manifestRequested).toBe(false);
		expect(await Bun.file(path.join(fixture.root, "tracked.txt")).text()).toBe("local drift\n");
	});

	test("rejects invalid or ignored final manifests without local mutation", async () => {
		const fixture = await makeFixture({ ".gitignore": "ignored/\n", "keep.txt": "keep\n" });
		const seed = await createSeedBundle(fixture.root);
		const remoteFiles = { ".gitignore": "ignored/\n", "ignored/result.txt": "ignored\n", "keep.txt": "changed\n" };
		const final = sealedManifest(remoteFiles);
		let fileRequested = false;
		const transport = transportFor(final, remoteFiles);
		transport.readFile = async relativePath => {
			fileRequested = true;
			return payload(relativePath, remoteFiles[relativePath as keyof typeof remoteFiles]);
		};

		await expect(runSync(fixture, seed, transport)).rejects.toMatchObject({ code: "ignored_remote_path" });
		expect(fileRequested).toBe(false);
		expect(await Bun.file(path.join(fixture.root, "keep.txt")).text()).toBe("keep\n");
		expect(await Bun.file(path.join(fixture.root, "ignored/result.txt")).exists()).toBe(false);

		const invalidRoot: ManifestSyncTransport = {
			quiesce: quiesced,
			getManifest: async () => ({ ...final, rootSha256: "0".repeat(64) }),
			readFile: async () => {
				throw new Error("invalid manifest must not download files");
			},
		};
		await expect(runSync(fixture, seed, invalidRoot)).rejects.toMatchObject({ code: "root_digest_mismatch" });
		expect(await Bun.file(path.join(fixture.root, "keep.txt")).text()).toBe("keep\n");
	});

	test("rejects a local symlink drift before any remote manifest or mutation", async () => {
		const fixture = await makeFixture({ "tracked.txt": "seed\n" });
		const seed = await createSeedBundle(fixture.root);
		const outside = path.join(fixture.root, "outside.txt");
		await Bun.write(outside, "outside\n");
		await fs.unlink(path.join(fixture.root, "tracked.txt"));
		await fs.symlink("outside.txt", path.join(fixture.root, "tracked.txt"));
		let manifestRequested = false;
		const transport: ManifestSyncTransport = {
			quiesce: quiesced,
			getManifest: async () => {
				manifestRequested = true;
				throw new Error("manifest must not be requested after symlink drift");
			},
			readFile: async () => {
				throw new Error("file must not be requested after symlink drift");
			},
		};

		await expect(runSync(fixture, seed, transport)).rejects.toMatchObject({ code: "unsupported_local_entry" });
		expect(manifestRequested).toBe(false);
		expect(await Bun.file(outside).text()).toBe("outside\n");
	});
});

function sealedManifest(files: Readonly<Record<string, string>>): ManifestResponse {
	const entries = Object.entries(files)
		.map(([relativePath, content]) => entry(relativePath, content))
		.sort((left, right) => compareUtf8Paths(left.path, right.path));
	return { phase: "quiesced", rootSha256: canonicalRootSha256(entries), files: entries };
}

function entry(relativePath: string, content: string): BoundaryManifestEntry {
	const bytes = new TextEncoder().encode(content);
	return { path: relativePath, sha256: sha256Hex(bytes), byteLength: bytes.byteLength };
}

function payload(relativePath: string, content: string): FilePayload {
	return { ...entry(relativePath, content), contentBase64: Buffer.from(content).toString("base64") };
}

function transportFor(
	manifest: ManifestResponse,
	files: Readonly<Record<string, string>>,
	readPaths: string[] = [],
): ManifestSyncTransport {
	return {
		quiesce: quiesced,
		getManifest: async () => manifest,
		readFile: async relativePath => {
			readPaths.push(relativePath);
			const content = files[relativePath];
			if (content === undefined) throw new Error(`unexpected remote read: ${relativePath}`);
			return payload(relativePath, content);
		},
	};
}

async function quiesced(): Promise<WorkspaceState> {
	return { phase: "quiesced", activeExecutions: 0, pendingSyncs: 0, exhaustedSyncs: 0 };
}

async function runSync(fixture: ManifestFixture, seed: SeedBundle, transport: ManifestSyncTransport) {
	return syncBack({
		sourceRoot: fixture.root,
		seedManifest: seed.seedManifest,
		seedRootSha256: seed.seedRootSha256,
		transport,
	});
}

async function makeFixture(files: Readonly<Record<string, string | Uint8Array>>): Promise<ManifestFixture> {
	const fixture = await createManifestFixture(files);
	fixtures.push(fixture);
	return fixture;
}
