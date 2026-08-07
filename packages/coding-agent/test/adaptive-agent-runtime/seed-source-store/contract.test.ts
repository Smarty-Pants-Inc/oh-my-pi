import { describe, expect, it } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type {
	ISO8601,
	ManagedWorkspaceSeedLimitsV1,
	ManagedWorkspaceSeedSourceRefV1,
	Sha256Hex,
} from "../../../src/registry/persistent-agent-contracts.js";
import {
	DurableManagedWorkspaceSeedSourceStoreV1,
	FileRuntimeDurableStateStoreV1,
	materializeWorkspaceSnapshotV1,
	readManagedWorkspaceSeedSourceV1,
} from "../../../src/session/managed-workspace.js";
import { PERSISTENT_WORKSPACE_PATH_MAPPER_V1 } from "../../../src/session/workspace-runtime-contracts.js";

const NOW = "2026-08-06T12:00:00.000Z" as ISO8601;
const EXPIRES = "2026-08-06T12:10:00.000Z" as ISO8601;
const LATER = "2026-08-06T12:20:00.000Z" as ISO8601;

function limits(overrides: Partial<ManagedWorkspaceSeedLimitsV1> = {}): ManagedWorkspaceSeedLimitsV1 {
	return {
		maxFiles: 32,
		maxFileBytes: 1024,
		maxTotalBytes: 4096,
		deniedPatterns: [],
		...overrides,
	};
}

function source(
	expectedImage: ManagedWorkspaceSeedSourceRefV1["expectedImage"],
	seedLimits: ManagedWorkspaceSeedLimitsV1,
	overrides: Partial<ManagedWorkspaceSeedSourceRefV1> = {},
): ManagedWorkspaceSeedSourceRefV1 {
	return {
		sourceId: "seed-source",
		bindId: "seed-bind",
		expectedImage,
		limits: seedLimits,
		...overrides,
	};
}

async function writeTextTree(root: string): Promise<void> {
	await mkdir(path.join(root, "a"), { recursive: true });
	await writeFile(path.join(root, "é.txt"), "accent\n", "utf8");
	await writeFile(path.join(root, "z.txt"), "zeta\r\n", "utf8");
	await writeFile(path.join(root, "a", "β.txt"), "beta\n", "utf8");
}

async function rejectionText(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		throw new Error("Expected rejection");
	} catch (error) {
		return String(error);
	}
}

describe("managed workspace seed source reader", () => {
	it("returns deterministic canonical UTF-8 rows and image bytes in UTF-8 path order", async () => {
		using temp = TempDir.createSync("@omp-seed-reader-order-");
		const root = path.join(temp.path(), "source");
		await writeTextTree(root);
		const seedLimits = limits();

		const first = await readManagedWorkspaceSeedSourceV1({ sourcePath: root, limits: seedLimits });
		const second = await readManagedWorkspaceSeedSourceV1({ sourcePath: root, limits: seedLimits });

		expect(first).toEqual(second);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(first.files.map(file => file.path)).toEqual(
			["a/β.txt", "z.txt", "é.txt"].map(value => PERSISTENT_WORKSPACE_PATH_MAPPER_V1.parse(value).relativePath),
		);
		expect(first.files.map(file => file.contentUtf8)).toEqual(["beta\n", "zeta\r\n", "accent\n"]);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.image)).toBe(true);
		expect(Object.isFrozen(first.files)).toBe(true);
		expect(first.files.every(Object.isFrozen)).toBe(true);

		const materialized = materializeWorkspaceSnapshotV1({
			workspaceId: "seed-order-workspace",
			generation: 0,
			committedAt: NOW,
			files: first.files,
		});
		expect(first.image).toEqual({
			rootSha256: materialized.checkpoint.rootSha256,
			fileCount: materialized.checkpoint.fileCount,
			byteCount: materialized.checkpoint.byteCount,
		});
	});

	it("rejects every bound, denied, unsafe, noncanonical, and non-text input without leaking its path", async () => {
		using temp = TempDir.createSync("@omp-seed-reader-reject-");
		const root = path.join(temp.path(), "source");
		await mkdir(root, { recursive: true });
		await writeFile(path.join(root, "one.txt"), "abc", "utf8");
		await writeFile(path.join(root, "two.key"), "def", "utf8");

		const cases: readonly ManagedWorkspaceSeedLimitsV1[] = [
			limits({ maxFiles: 1 }),
			limits({ maxFileBytes: 2 }),
			limits({ maxTotalBytes: 5 }),
			limits({ deniedPatterns: ["**/*.key"] }),
		];
		for (const seedLimits of cases) {
			const message = await rejectionText(
				readManagedWorkspaceSeedSourceV1({ sourcePath: root, limits: seedLimits }),
			);
			expect(message).not.toContain(root);
		}

		const symlinkRoot = path.join(temp.path(), "symlink");
		await mkdir(symlinkRoot);
		await symlink(path.join(root, "one.txt"), path.join(symlinkRoot, "linked.txt"));
		expect(
			await rejectionText(readManagedWorkspaceSeedSourceV1({ sourcePath: symlinkRoot, limits: limits() })),
		).not.toContain(symlinkRoot);

		const malformedRoot = path.join(temp.path(), "malformed");
		await mkdir(malformedRoot);
		await writeFile(path.join(malformedRoot, "bad.txt"), new Uint8Array([0xc3, 0x28]));
		expect(
			await rejectionText(readManagedWorkspaceSeedSourceV1({ sourcePath: malformedRoot, limits: limits() })),
		).not.toContain(malformedRoot);

		const binaryRoot = path.join(temp.path(), "binary");
		await mkdir(binaryRoot);
		await writeFile(path.join(binaryRoot, "bad.txt"), new Uint8Array([0x61, 0, 0x62]));
		expect(
			await rejectionText(readManagedWorkspaceSeedSourceV1({ sourcePath: binaryRoot, limits: limits() })),
		).not.toContain(binaryRoot);

		const noncanonicalRoot = path.join(temp.path(), "noncanonical");
		await mkdir(noncanonicalRoot);
		await writeFile(path.join(noncanonicalRoot, "bad\\name.txt"), "text", "utf8");
		expect(
			await rejectionText(readManagedWorkspaceSeedSourceV1({ sourcePath: noncanonicalRoot, limits: limits() })),
		).not.toContain(noncanonicalRoot);
	});

	it("stops before enumeration for an aborted signal", async () => {
		using temp = TempDir.createSync("@omp-seed-reader-abort-");
		const root = path.join(temp.path(), "source");
		await mkdir(root);
		await writeFile(path.join(root, "file.txt"), "text", "utf8");
		const controller = new AbortController();
		controller.abort();
		const message = await rejectionText(
			readManagedWorkspaceSeedSourceV1({ sourcePath: root, limits: limits(), signal: controller.signal }),
		);
		expect(message).toContain("AbortError");
		expect(message).not.toContain(root);
	});
});

describe("DurableManagedWorkspaceSeedSourceStoreV1", () => {
	it("binds one exact reference idempotently and conflicts on identity, path, limits, image, or expiry drift", async () => {
		using temp = TempDir.createSync("@omp-seed-store-bind-");
		const root = path.join(temp.path(), "source");
		const alternate = path.join(temp.path(), "alternate");
		await writeTextTree(root);
		await writeTextTree(alternate);
		const seedLimits = limits();
		const read = await readManagedWorkspaceSeedSourceV1({ sourcePath: root, limits: seedLimits });
		const ref = source(read.image, seedLimits);
		const durable = new FileRuntimeDurableStateStoreV1(path.join(temp.path(), "state"));
		const store = new DurableManagedWorkspaceSeedSourceStoreV1({ durable, now: () => NOW });

		expect(await store.bind({ source: ref, sourcePath: root, expiresAt: EXPIRES })).toEqual({ status: "bound" });
		expect(await store.bind({ source: ref, sourcePath: root, expiresAt: EXPIRES })).toEqual({
			status: "already_bound",
		});
		expect(
			await store.bind({ source: { ...ref, bindId: "other-bind" }, sourcePath: root, expiresAt: EXPIRES }),
		).toEqual({
			status: "conflict",
		});
		expect(await store.bind({ source: ref, sourcePath: alternate, expiresAt: EXPIRES })).toEqual({
			status: "conflict",
		});
		expect(
			await store.bind({
				source: { ...ref, limits: limits({ maxFiles: seedLimits.maxFiles + 1 }) },
				sourcePath: root,
				expiresAt: EXPIRES,
			}),
		).toEqual({ status: "conflict" });
		expect(
			await store.bind({
				source: {
					...ref,
					expectedImage: { ...ref.expectedImage, rootSha256: "f".repeat(64) as Sha256Hex },
				},
				sourcePath: root,
				expiresAt: EXPIRES,
			}),
		).toEqual({ status: "conflict" });
		expect(await store.bind({ source: ref, sourcePath: root, expiresAt: LATER })).toEqual({ status: "conflict" });
		const wrongImageRef = source({ ...ref.expectedImage, rootSha256: "e".repeat(64) as Sha256Hex }, seedLimits, {
			sourceId: "wrong-image-source",
			bindId: "wrong-image-bind",
		});
		expect(await store.bind({ source: wrongImageRef, sourcePath: root, expiresAt: EXPIRES })).toEqual({
			status: "conflict",
		});
	});

	it("keeps inspect/open/readers path-free and detects source changes against the immutable image", async () => {
		using temp = TempDir.createSync("@omp-seed-store-private-");
		const root = path.join(temp.path(), "source-canary");
		await mkdir(root);
		await writeFile(path.join(root, "file.txt"), "before", "utf8");
		const seedLimits = limits();
		const read = await readManagedWorkspaceSeedSourceV1({ sourcePath: root, limits: seedLimits });
		const ref = source(read.image, seedLimits);
		const store = new DurableManagedWorkspaceSeedSourceStoreV1({
			durable: new FileRuntimeDurableStateStoreV1(path.join(temp.path(), "state")),
			now: () => NOW,
		});

		const bound = await store.bind({ source: ref, sourcePath: root, expiresAt: EXPIRES });
		const inspection = await store.inspect(ref);
		const reader = await store.open(ref);
		expect(JSON.stringify({ bound, inspection, reader })).not.toContain(root);
		expect(Object.keys(reader)).toEqual(["source", "readFiles", "close"]);
		expect(await reader.readFiles()).toEqual(read.files);
		const conflictingRef = { ...ref, bindId: "conflicting-open" };
		const conflictingInspection = await store.inspect(conflictingRef);
		expect(conflictingInspection).toEqual({ status: "conflict", sourceId: ref.sourceId });
		expect(JSON.stringify(conflictingInspection)).not.toContain(root);
		const conflictMessage = await rejectionText(store.open(conflictingRef));
		expect(conflictMessage).not.toContain(root);

		await writeFile(path.join(root, "file.txt"), "after", "utf8");
		const message = await rejectionText(reader.readFiles());
		expect(message).toContain("changed");
		expect(message).not.toContain(root);
		const openMessage = await rejectionText(store.open(ref));
		expect(openMessage).toContain("changed");
		expect(openMessage).not.toContain(root);
		await reader.close();
		const closedMessage = await rejectionText(reader.readFiles());
		expect(closedMessage).not.toContain(root);
	});

	it("expires and releases the private binding without exposing or retaining the path", async () => {
		using temp = TempDir.createSync("@omp-seed-store-release-");
		const root = path.join(temp.path(), "source-canary");
		await mkdir(root);
		await writeFile(path.join(root, "file.txt"), "text", "utf8");
		const seedLimits = limits();
		const read = await readManagedWorkspaceSeedSourceV1({ sourcePath: root, limits: seedLimits });
		const durable = new FileRuntimeDurableStateStoreV1(path.join(temp.path(), "state"));
		let now = NOW;
		const store = new DurableManagedWorkspaceSeedSourceStoreV1({ durable, now: () => now });
		const readyRef = source(read.image, seedLimits, { sourceId: "ready-source", bindId: "ready-bind" });

		await store.bind({ source: readyRef, sourcePath: root, expiresAt: EXPIRES });
		const readyReader = await store.open(readyRef);
		expect(await store.release({ source: readyRef, reason: "workspace_ready" })).toEqual({ status: "released" });
		expect(await durable.inspect("managed-workspace-seed-source-v1", readyRef.sourceId)).toBeNull();
		const releasedReaderMessage = await rejectionText(readyReader.readFiles());
		expect(releasedReaderMessage).not.toContain(root);
		await readyReader.close();
		expect(await store.inspect(readyRef)).toEqual({ status: "absent", sourceId: readyRef.sourceId });
		expect(await store.release({ source: readyRef, reason: "creation_discarded" })).toEqual({
			status: "already_absent",
		});

		const expiredRef = source(read.image, seedLimits, { sourceId: "expired-source", bindId: "expired-bind" });
		await store.bind({ source: expiredRef, sourcePath: root, expiresAt: EXPIRES });
		now = LATER;
		expect(await store.release({ source: expiredRef, reason: "expired" })).toEqual({ status: "released" });
		expect(await store.inspect(expiredRef)).toEqual({ status: "absent", sourceId: expiredRef.sourceId });
		const unavailable = await rejectionText(store.open(expiredRef));
		expect(unavailable).not.toContain(root);

		const autoExpiredRef = source(read.image, seedLimits, { sourceId: "auto-expired", bindId: "auto-expired-bind" });
		now = NOW;
		await store.bind({ source: autoExpiredRef, sourcePath: root, expiresAt: EXPIRES });
		now = LATER;
		const expiredInspection = await store.inspect(autoExpiredRef);
		expect(expiredInspection).toEqual({ status: "absent", sourceId: autoExpiredRef.sourceId });
		expect(await durable.inspect("managed-workspace-seed-source-v1", autoExpiredRef.sourceId)).toBeNull();
		expect(JSON.stringify(expiredInspection)).not.toContain(root);
	});
});
