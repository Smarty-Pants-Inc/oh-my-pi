import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { tryAcquireTaskIsolationExclusionLock } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

describe("worktree clear managed-claim exclusion", () => {
	let root: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-clear-"));
		setWorktreesDir(root);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(async () => {
		setWorktreesDir(undefined);
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});
	it("skips a sibling claim even under --all while removing a provably empty legacy shell", async () => {
		const claimed = path.join(root, "legacy-claimed");
		const empty = path.join(root, "legacy-empty");
		await Promise.all([fs.mkdir(claimed), fs.mkdir(empty)]);
		await fs.writeFile(`${claimed}.owner-v1`, "{ malformed claim }");
		await clearWorktrees({ all: true, dryRun: false, json: true });
		await expect(fs.stat(claimed)).resolves.toBeDefined();
		await expect(fs.stat(empty)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("does not scan or remove while the claim exclusion lock is held", async () => {
		const empty = path.join(root, "legacy-empty");
		await fs.mkdir(empty);
		const lock = tryAcquireTaskIsolationExclusionLock();
		expect(lock?.acquired).toBe(true);
		try {
			await clearWorktrees({ all: true, dryRun: false, json: true });
			await expect(fs.stat(empty)).resolves.toBeDefined();
		} finally {
			lock?.release();
		}
	});
	it("rejects a symlink candidate instead of removing its target", async () => {
		const target = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-target-"));
		try {
			await fs.symlink(target, path.join(root, "linked"));
			await clearWorktrees({ all: true, dryRun: false, json: true });
			await expect(fs.stat(target)).resolves.toBeDefined();
		} finally {
			await fs.rm(target, { recursive: true, force: true });
		}
	});
});
