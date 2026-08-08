import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager, reconcileArtifactOperationsSync } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("ArtifactManager concurrency and transactions", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-artifacts-${crypto.randomUUID()}`, "session");
		dirs.push(path.dirname(dir));
		return dir;
	}

	async function abandonOperation(parentDir: string): Promise<string> {
		const intentName = (await fs.readdir(parentDir)).find(name => name.startsWith(".omp-artifact-operation-"));
		if (!intentName) throw new Error("expected durable artifact operation intent");
		const intentPath = path.join(parentDir, intentName);
		const intent = JSON.parse(await fs.readFile(intentPath, "utf8")) as { ownerPid: number };
		intent.ownerPid = 0;
		await fs.writeFile(intentPath, `${JSON.stringify(intent)}\n`);
		return intentPath;
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

	it("reserves IDs atomically across independent managers", async () => {
		const dir = freshDir();
		const managerA = new ArtifactManager(dir);
		const managerB = new ArtifactManager(dir);
		const [idA, idB] = await Promise.all([managerA.save("MANAGER-A", "bash"), managerB.save("MANAGER-B", "async")]);

		expect(idA).not.toBe(idB);
		expect(await fs.readFile((await managerA.getPath(idA)) as string, "utf8")).toBe("MANAGER-A");
		expect(await fs.readFile((await managerB.getPath(idB)) as string, "utf8")).toBe("MANAGER-B");
	});

	it("never reuses an ID whose cross-process reservation survived a crash", async () => {
		const dir = freshDir();
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, ".omp-artifact-id-0"), "");

		const manager = new ArtifactManager(dir);
		await expect(manager.save("AFTER-CRASH", "bash")).resolves.toBe("1");
		expect(await fs.readFile((await manager.getPath("1")) as string, "utf8")).toBe("AFTER-CRASH");
	});

	it("does not roll back a path whose reservation was replaced by another inode", async () => {
		const dir = freshDir();
		const manager = new ArtifactManager(dir);
		const transaction = await manager.beginTransaction();
		const id = await transaction.save("TRANSACTION", "bash");
		const artifactPath = await manager.getPath(id);
		if (!artifactPath) throw new Error("expected transaction artifact path");
		await fs.rename(artifactPath, `${artifactPath}.retired`);
		await fs.writeFile(artifactPath, "FOREIGN-OWNER");

		await transaction.rollback();
		await transaction.commit();

		expect(await fs.readFile(artifactPath, "utf8")).toBe("FOREIGN-OWNER");
	});

	it("keeps a large transaction snapshot out of the JavaScript ArrayBuffer heap", async () => {
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

	it("preserves concurrent artifact bytes and removes only transaction-created paths on rollback", async () => {
		const dir = freshDir();
		const mgr = new ArtifactManager(dir);
		const originalId = await mgr.save("ORIGINAL", "bash");
		const originalPath = await mgr.getPath(originalId);
		expect(originalPath).toBeString();

		const transaction = await mgr.beginTransaction();
		const createdId = await transaction.save("TRANSACTION", "async");
		const createdPath = await mgr.getPath(createdId);
		expect(createdPath).toBeString();
		await fs.writeFile(originalPath as string, "CONCURRENT-UPDATE");
		await fs.writeFile(path.join(dir, "50.external.log"), "CONCURRENT-ARTIFACT");

		await transaction.rollback();
		await transaction.commit();

		expect(await fs.readFile(originalPath as string, "utf8")).toBe("CONCURRENT-UPDATE");
		await expect(fs.stat(createdPath as string)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(path.join(dir, "50.external.log"), "utf8")).toBe("CONCURRENT-ARTIFACT");
		await expect(mgr.save("AFTER", "bash")).resolves.toBe("51");
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

	it("clones the complete recursive artifact graph with hard links", async () => {
		const sourceDir = freshDir();
		const destinationDir = path.join(path.dirname(sourceDir), "recursive-target");
		await fs.mkdir(path.join(sourceDir, "local", "plans"), { recursive: true });
		const sourceFile = path.join(sourceDir, "local", "plans", "plan.json");
		await fs.writeFile(sourceFile, "DURABLE-PLAN");
		const source = new ArtifactManager(sourceDir);
		await source.save("TOOL-OUTPUT", "bash");

		const clone = await source.beginCloneTransaction();
		await clone.publish(destinationDir);
		await fs.writeFile(`${destinationDir}.jsonl`, "journal\n");
		await clone.commit();

		const destinationFile = path.join(destinationDir, "local", "plans", "plan.json");
		expect(await fs.readFile(destinationFile, "utf8")).toBe("DURABLE-PLAN");
		expect((await fs.stat(destinationFile)).ino).toBe((await fs.stat(sourceFile)).ino);
		expect((await fs.readdir(destinationDir)).some(name => /^\d+\..*\.log$/.test(name))).toBe(true);
	});

	it("falls back to copying when the filesystem rejects hard links", async () => {
		const sourceDir = freshDir();
		const destinationDir = path.join(path.dirname(sourceDir), "copy-fallback-target");
		const source = new ArtifactManager(sourceDir);
		await source.save("HISTORICAL", "bash");
		const link = vi
			.spyOn(fs, "link")
			.mockRejectedValue(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));
		const copy = vi.spyOn(fs, "copyFile");

		const clone = await source.beginCloneTransaction();
		await clone.publish(destinationDir);
		await fs.writeFile(`${destinationDir}.jsonl`, "journal\n");
		await clone.commit();

		expect(copy).toHaveBeenCalled();
		expect(await fs.readFile((await new ArtifactManager(destinationDir).getPath("0")) as string, "utf8")).toBe(
			"HISTORICAL",
		);
		link.mockRestore();
		copy.mockRestore();
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
		const link = vi
			.spyOn(fs, "link")
			.mockRejectedValue(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));
		const copy = vi.spyOn(fs, "copyFile").mockRejectedValueOnce(failure);

		await expect(clone.publish(destinationDir)).rejects.toBe(failure);
		link.mockRestore();
		copy.mockRestore();
		await clone.rollback();
		await expect(fs.stat(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
		const stagingPrefix = `.${path.basename(destinationDir)}.artifact-stage-`;
		expect((await fs.readdir(path.dirname(destinationDir))).some(name => name.startsWith(stagingPrefix))).toBe(false);
	});

	it("fails a clone on an atomic publish error and removes its staged directory", async () => {
		const sourceDir = freshDir();
		const destinationDir = path.join(path.dirname(sourceDir), "publish-failure-target");
		const source = new ArtifactManager(sourceDir);
		await source.save("HISTORICAL", "bash");
		const clone = await source.beginCloneTransaction();
		const failure = Object.assign(new Error("artifact clone rename failed"), { code: "EIO" });
		const originalRename = fs.rename.bind(fs);
		const rename = vi.spyOn(fs, "rename").mockImplementation(async (sourcePath, destinationPath) => {
			if (sourcePath.toString().includes(".artifact-stage-")) throw failure;
			await originalRename(sourcePath, destinationPath);
		});

		await expect(clone.publish(destinationDir)).rejects.toBe(failure);
		rename.mockRestore();
		await clone.rollback();
		await expect(fs.stat(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
		const stagingPrefix = `.${path.basename(destinationDir)}.artifact-stage-`;
		expect((await fs.readdir(path.dirname(destinationDir))).some(name => name.startsWith(stagingPrefix))).toBe(false);
	});

	it("reconciles an uncommitted clone by removing its final directory and intent", async () => {
		const sourceDir = freshDir();
		const parentDir = path.dirname(sourceDir);
		const destinationDir = path.join(parentDir, "abandoned-clone-target");
		const source = new ArtifactManager(sourceDir);
		await source.save("HISTORICAL", "bash");
		const clone = await source.beginCloneTransaction();
		await clone.publish(destinationDir);
		const intentPath = await abandonOperation(parentDir);

		reconcileArtifactOperationsSync(parentDir);

		await expect(fs.stat(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fs.readdir(parentDir)).some(name => name.includes(".artifact-stage-"))).toBe(false);
		await clone.rollback();
	});

	it("reconciles an uncommitted cross-directory clone from its source marker", async () => {
		const sourceDir = freshDir();
		const destinationDir = freshDir();
		const source = new ArtifactManager(sourceDir);
		await source.save("HISTORICAL", "bash");
		const clone = await source.beginCloneTransaction();
		await clone.publish(destinationDir);
		const sourceIntentPath = await abandonOperation(path.dirname(sourceDir));

		reconcileArtifactOperationsSync(path.dirname(sourceDir));

		await expect(fs.stat(destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(sourceIntentPath)).rejects.toMatchObject({ code: "ENOENT" });
		await clone.rollback();
	});

	it("reconciles a committed clone by retaining its complete final graph", async () => {
		const sourceDir = freshDir();
		const parentDir = path.dirname(sourceDir);
		const destinationDir = path.join(parentDir, "committed-clone-target");
		await fs.mkdir(path.join(sourceDir, "local"), { recursive: true });
		await fs.writeFile(path.join(sourceDir, "local", "state.json"), "STATE");
		const source = new ArtifactManager(sourceDir);
		const clone = await source.beginCloneTransaction();
		await clone.publish(destinationDir);
		await fs.writeFile(`${destinationDir}.jsonl`, "journal\n");
		const intentPath = await abandonOperation(parentDir);

		reconcileArtifactOperationsSync(parentDir);

		expect(await fs.readFile(path.join(destinationDir, "local", "state.json"), "utf8")).toBe("STATE");
		await expect(fs.stat(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fs.readdir(destinationDir)).some(name => name.startsWith(".omp-artifact-owner-"))).toBe(false);
		await clone.commit();
	});

	it("keeps destination managers fenced and rebinds them after relocation rollback", async () => {
		const sourceDir = freshDir();
		const destinationDir = path.join(path.dirname(sourceDir), "rolled-back-relocation");
		const source = new ArtifactManager(sourceDir);
		await source.save("SOURCE", "bash");
		const relocation = await source.beginRelocation(destinationDir);
		const destination = new ArtifactManager(destinationDir);
		let destinationWriteSettled = false;
		const destinationWrite = destination.save("DESTINATION", "async").then(id => {
			destinationWriteSettled = true;
			return id;
		});
		await Promise.resolve();
		expect(destinationWriteSettled).toBe(false);

		await relocation.rollback();

		await expect(destinationWrite).resolves.toBe("0");
		expect(source.dir).toBe(sourceDir);
		expect(destination.dir).toBe(destinationDir);
		expect(await fs.readFile((await source.getPath("0")) as string, "utf8")).toBe("SOURCE");
		expect(await fs.readFile((await destination.getPath("0")) as string, "utf8")).toBe("DESTINATION");
	});

	it("reconciles a journal-committed relocation by retaining the destination and retiring the source", async () => {
		const sourceDir = freshDir();
		const parentDir = path.dirname(sourceDir);
		const destinationDir = freshDir();
		const sourceJournal = `${sourceDir}.jsonl`;
		const destinationJournal = `${destinationDir}.jsonl`;
		const source = new ArtifactManager(sourceDir);
		const id = await source.save("HISTORICAL", "bash");
		await fs.writeFile(sourceJournal, "journal\n");
		const relocation = await source.beginRelocation(destinationDir);
		await fs.rename(sourceJournal, destinationJournal);
		await abandonOperation(parentDir);

		reconcileArtifactOperationsSync(parentDir);

		await expect(fs.stat(sourceDir)).rejects.toMatchObject({ code: "ENOENT" });
		await relocation.commit();
		expect(source.dir).toBe(destinationDir);
		expect(await fs.readFile((await new ArtifactManager(destinationDir).getPath(id)) as string, "utf8")).toBe(
			"HISTORICAL",
		);
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
