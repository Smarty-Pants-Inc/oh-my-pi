import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("ArtifactManager concurrency and transactions", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-artifacts-${crypto.randomUUID()}`, "session");
		dirs.push(path.dirname(dir));
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			removeSyncWithRetries(dir);
		}
		vi.restoreAllMocks();
	});

	// First-use init (dir scan → #nextId seed) must run exactly once. Two callers
	// racing a fresh manager both yield inside #scanExistingIds before either
	// marks init done; if the second re-seeds #nextId after the first consumed an
	// id, both allocate the same numeric id and the second write clobbers the
	// first. Same toolType => file overwrite; the first id resolves to B's bytes.
	it("hands concurrent same-toolType savers distinct ids that each resolve to their own content", async () => {
		const mgr = new ArtifactManager(freshDir());
		const [idA, idB] = await Promise.all([mgr.save("CONTENT-A", "bash"), mgr.save("CONTENT-B", "bash")]);

		expect(idA).not.toBe(idB);

		const pathA = await mgr.getPath(idA);
		const pathB = await mgr.getPath(idB);
		expect(pathA).not.toBeNull();
		expect(pathB).not.toBeNull();
		expect(await Bun.file(pathA as string).text()).toBe("CONTENT-A");
		expect(await Bun.file(pathB as string).text()).toBe("CONTENT-B");
	});

	// Different toolTypes turn a duplicate id into two coexisting files
	// (`{id}.bash.log` + `{id}.async.log`); getPath's startsWith(`${id}.`) then
	// resolves ambiguously in unspecified readdir order. Distinct ids keep each
	// artifact:// pointing at the content its caller wrote.
	it("hands concurrent different-toolType savers distinct ids that each resolve to their own content", async () => {
		const mgr = new ArtifactManager(freshDir());
		const [idA, idB] = await Promise.all([mgr.save("BASH-BYTES", "bash"), mgr.save("ASYNC-BYTES", "async")]);

		expect(idA).not.toBe(idB);

		const pathA = await mgr.getPath(idA);
		const pathB = await mgr.getPath(idB);
		expect(await Bun.file(pathA as string).text()).toBe("BASH-BYTES");
		expect(await Bun.file(pathB as string).text()).toBe("ASYNC-BYTES");
	});

	// The race also re-opens on a fresh manager over a directory that already
	// holds artifacts (e.g. after a `#artifactManager = null` reset): the scan
	// seeds from maxId, and concurrent callers must still get ids past it.
	it("does not reuse ids when racing init over a pre-populated directory", async () => {
		const dir = freshDir();
		const seed = new ArtifactManager(dir);
		await seed.save("OLD", "bash");

		const mgr = new ArtifactManager(dir);
		const [idA, idB] = await Promise.all([mgr.save("NEW-A", "bash"), mgr.save("NEW-B", "bash")]);

		expect(idA).not.toBe(idB);
		expect(await Bun.file((await mgr.getPath(idA)) as string).text()).toBe("NEW-A");
		expect(await Bun.file((await mgr.getPath(idB)) as string).text()).toBe("NEW-B");
	});

	it("keeps a large transaction preimage out of the JavaScript ArrayBuffer heap", async () => {
		const mgr = new ArtifactManager(freshDir());
		const allocation = await mgr.allocatePath("large");
		const artifactBytes = 32 * 1024 * 1024;
		try {
			const file = await fs.open(allocation.path, "w");
			try {
				await file.truncate(artifactBytes);
			} finally {
				await file.close();
			}
		} finally {
			allocation.release();
		}

		Bun.gc(true);
		const arrayBuffersBefore = process.memoryUsage().arrayBuffers;
		const transaction = await mgr.beginTransaction();
		try {
			Bun.gc(true);
			const retainedArrayBuffers = process.memoryUsage().arrayBuffers - arrayBuffersBefore;
			expect(retainedArrayBuffers).toBeLessThan(artifactBytes / 8);
		} finally {
			await transaction.commit();
		}
	});

	it("waits for live writers, fences later source writes, and seeds a restarted target above copied ids", async () => {
		const sourceDir = freshDir();
		const destinationDir = path.join(path.dirname(sourceDir), "branched-session");
		const source = new ArtifactManager(sourceDir);
		const historicalBytes = Buffer.from([0, 1, 2, 0xfe, 0xff, 13, 10]);
		const liveWriter = await source.allocatePath("stream");
		await fs.writeFile(liveWriter.path, historicalBytes.subarray(0, 3));

		let cloneAcquired = false;
		const acquiringClone = source.beginCloneTransaction().then(transaction => {
			cloneAcquired = true;
			return transaction;
		});
		await Promise.resolve();
		expect(cloneAcquired).toBe(false);
		await fs.appendFile(liveWriter.path, historicalBytes.subarray(3));

		liveWriter.release();
		const clone = await acquiringClone;
		let laterSourceWriteSettled = false;
		const laterSourceWrite = source.save("SOURCE-AFTER-SNAPSHOT", "bash").then(id => {
			laterSourceWriteSettled = true;
			return id;
		});
		await Promise.resolve();
		expect(laterSourceWriteSettled).toBe(false);

		await clone.publish(destinationDir);
		const restartedTarget = new ArtifactManager(destinationDir);
		const historicalPath = await restartedTarget.getPath(liveWriter.id);
		expect(historicalPath).toBeString();
		expect(await fs.readFile(historicalPath as string)).toEqual(historicalBytes);
		const targetId = await restartedTarget.save("TARGET-NEW", "bash");
		expect(Number(targetId)).toBeGreaterThan(Number(liveWriter.id));
		expect(laterSourceWriteSettled).toBe(false);

		await clone.commit();
		await expect(laterSourceWrite).resolves.toBe(String(Number(liveWriter.id) + 1));
	});

	it("preserves the clone rollback cleanup failure", async () => {
		const sourceDir = freshDir();
		const destinationDir = path.join(path.dirname(sourceDir), "rollback-cleanup-failure-target");
		const source = new ArtifactManager(sourceDir);
		await source.save("HISTORICAL", "bash");
		const clone = await source.beginCloneTransaction();
		await clone.publish(destinationDir);
		const cleanupFailure = Object.assign(new Error("artifact clone cleanup failed"), { code: "EIO" });
		const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(cleanupFailure);

		let rollbackError: unknown;
		try {
			await clone.rollback();
		} catch (error) {
			rollbackError = error;
		}
		expect(rollbackError).toBeInstanceOf(AggregateError);
		expect((rollbackError as AggregateError).message).toBe("Artifact clone rollback failed");
		expect((rollbackError as AggregateError).errors).toEqual([cleanupFailure]);
		remove.mockRestore();
		await fs.rm(destinationDir, { recursive: true, force: true });
		await expect(source.save("SOURCE-AFTER-ROLLBACK", "bash")).resolves.toBeString();
	});

	it("fails a clone on a non-ENOENT copy error and removes its destination staging directory", async () => {
		const sourceDir = freshDir();
		const destinationDir = path.join(path.dirname(sourceDir), "copy-failure-target");
		const source = new ArtifactManager(sourceDir);
		await source.save("HISTORICAL", "bash");
		const clone = await source.beginCloneTransaction();
		const failure = Object.assign(new Error("artifact clone copy failed"), { code: "EIO" });
		const copy = vi.spyOn(fs, "copyFile").mockRejectedValueOnce(failure);

		await expect(clone.publish(destinationDir)).rejects.toBe(failure);
		copy.mockRestore();
		await clone.rollback();
		await expect(fs.stat(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
		const stagingPrefix = `.${path.basename(destinationDir)}.artifact-clone-`;
		expect((await fs.readdir(path.dirname(destinationDir))).some(name => name.startsWith(stagingPrefix))).toBe(false);
	});

	it("fails a clone on an atomic publish error and removes its staged directory", async () => {
		const sourceDir = freshDir();
		const destinationDir = path.join(path.dirname(sourceDir), "publish-failure-target");
		const source = new ArtifactManager(sourceDir);
		await source.save("HISTORICAL", "bash");
		const clone = await source.beginCloneTransaction();
		const failure = Object.assign(new Error("artifact clone rename failed"), { code: "EIO" });
		const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(failure);

		await expect(clone.publish(destinationDir)).rejects.toBe(failure);
		rename.mockRestore();
		await clone.rollback();
		await expect(fs.stat(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
		const stagingPrefix = `.${path.basename(destinationDir)}.artifact-clone-`;
		expect((await fs.readdir(path.dirname(destinationDir))).some(name => name.startsWith(stagingPrefix))).toBe(false);
	});

	it("treats an absent source artifact directory as a successful empty clone", async () => {
		const sourceDir = freshDir();
		const destinationDir = path.join(path.dirname(sourceDir), "empty-target");
		const source = new ArtifactManager(sourceDir);
		const clone = await source.beginCloneTransaction();

		await clone.publish(destinationDir);
		await clone.commit();
		await expect(fs.stat(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
