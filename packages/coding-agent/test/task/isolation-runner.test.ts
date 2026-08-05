import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type {
	ExecutionEnvironmentLease,
	ExecutionEnvironmentProvider,
} from "@oh-my-pi/pi-coding-agent/session/execution-environment";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	applyEligibleNestedPatches,
	type IsolatedRunOptions,
	mergeIsolatedChanges,
	runIsolatedSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as gitModule from "@oh-my-pi/pi-coding-agent/utils/git";
import * as natives from "@oh-my-pi/pi-natives";
import { $ } from "bun";

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "NestedOnly",
		agent: "task",
		agentSource: "bundled",
		task: "Do nested work",
		assignment: "Do nested work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

const tempRoots: string[] = [];

async function git(repoRoot: string, ...args: string[]): Promise<string> {
	const result = await $`git ${args}`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.text();
}

async function seedFooRepo(finalContent: string): Promise<{ repoRoot: string; patchPath: string }> {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-merge-"));
	tempRoots.push(repoRoot);

	await git(repoRoot, "init");
	await git(repoRoot, "config", "user.email", "repro@example.com");
	await git(repoRoot, "config", "user.name", "Repro");
	await Bun.write(path.join(repoRoot, "foo.txt"), "old\n");
	await git(repoRoot, "add", "foo.txt");
	await git(repoRoot, "commit", "-m", "base");
	await Bun.write(path.join(repoRoot, "foo.txt"), "new\n");
	await git(repoRoot, "commit", "-am", "change to new");

	const patchPath = path.join(repoRoot, "task.patch");
	const patchText = await git(repoRoot, "diff-tree", "--binary", "--full-index", "--no-commit-id", "-p", "HEAD");
	await Bun.write(patchPath, patchText);

	if (finalContent !== "new\n") {
		await git(repoRoot, "reset", "--hard", "HEAD~1");
		if (finalContent !== "old\n") {
			await Bun.write(path.join(repoRoot, "foo.txt"), finalContent);
			await git(repoRoot, "commit", "-am", "diverge");
		}
	}
	return { repoRoot, patchPath };
}

describe("runIsolatedSubprocess", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		await Promise.all(tempRoots.splice(0).map(tempRoot => fs.rm(tempRoot, { force: true, recursive: true })));
	});

	function setupLifecycleMocks(events: string[], isolationDir: string) {
		vi.spyOn(worktreeModule, "ensureIsolation").mockImplementation(async () => {
			events.push("worktree");
			return {
				mergedDir: isolationDir,
				backend: natives.IsoBackendKind.Rcopy,
				fellBack: false,
				fallbackReason: null,
			};
		});
		const capture = vi.spyOn(worktreeModule, "commitToBranch").mockImplementation(async () => {
			events.push("capture");
			return null;
		});
		vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(async () => {
			events.push("cleanup");
		});
		return { capture };
	}

	function fakeEnvironment(
		events: string[],
		isolationDir: string,
		behavior: {
			acquireFails?: boolean;
			acquireError?: unknown;
			syncFails?: boolean;
			syncError?: unknown;
			releaseFails?: boolean;
			releaseError?: unknown;
			leaseId?: string;
		} = {},
	) {
		const syncBack = vi.fn<ExecutionEnvironmentLease["syncBack"]>(async () => {
			events.push("sync");
			if (behavior.syncFails) throw behavior.syncError;
		});
		const release = vi.fn<ExecutionEnvironmentLease["release"]>(async () => {
			events.push("release");
			if (behavior.releaseFails) throw behavior.releaseError;
		});
		const lease: ExecutionEnvironmentLease = {
			id: behavior.leaseId ?? "lease-1",
			sourceRoot: isolationDir,
			remoteRoot: "/workspace",
			bridge: {
				readTextFile: async () => "",
				writeTextFile: async () => {},
				createTerminal: async () => {
					throw new Error("Unused fake terminal");
				},
			},
			syncBack,
			release,
		};
		const acquire = vi.fn<ExecutionEnvironmentProvider["acquire"]>(async () => {
			events.push("acquire");
			if (behavior.acquireFails) throw behavior.acquireError;
			return lease;
		});
		return { provider: { acquire }, lease, acquire, syncBack, release };
	}

	function lifecycleOptions(
		provider: ExecutionEnvironmentProvider,
		overrides: Partial<IsolatedRunOptions["baseOptions"]> = {},
	): IsolatedRunOptions {
		const repoRoot = "/repo";
		return {
			baseOptions: {
				cwd: repoRoot,
				agent: {
					name: "task",
					description: "Task agent",
					systemPrompt: "test",
					source: "bundled",
				},
				task: "Do environment work",
				index: 0,
				id: "EnvironmentTask",
				parentAgentId: "OwnerAgent",
				...overrides,
			},
			executionEnvironmentProvider: provider,
			context: {
				repoRoot,
				baseline: {
					root: {
						repoRoot,
						headCommit: "base",
						staged: "",
						unstaged: "",
						untracked: [],
						untrackedPatch: "",
					},
					nested: [],
				},
			},
			preferredBackend: undefined,
			agentId: "EnvironmentTask",
			mergeMode: "branch",
			artifactsDir: "/artifacts",
			buildFailureResult: error =>
				result({
					id: "EnvironmentTask",
					exitCode: 1,
					error: error instanceof Error ? error.message : String(error),
				}),
		};
	}

	it("orders worktree, acquire, child quiescence, sync, release, capture, and merge", async () => {
		const events: string[] = [];
		const isolationDir = "/repo/.omp/isolation/EnvironmentTask";
		const signal = new AbortController().signal;
		const { capture } = setupLifecycleMocks(events, isolationDir);
		capture.mockImplementation(async () => {
			events.push("capture");
			return { branchName: "omp/task/EnvironmentTask", baseSha: "base", nestedPatches: [] };
		});
		vi.spyOn(worktreeModule, "mergeTaskBranches").mockImplementation(async () => {
			events.push("merge");
			return { merged: ["omp/task/EnvironmentTask"], failed: [] };
		});
		vi.spyOn(worktreeModule, "cleanupTaskBranches").mockResolvedValue();
		const environment = fakeEnvironment(events, isolationDir);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			events.push("child");
			const binding = options.executionEnvironment;
			expect(binding).toEqual({
				id: environment.lease.id,
				sourceRoot: isolationDir,
				remoteRoot: "/workspace",
				bridge: environment.lease.bridge,
			});
			expect(binding).not.toBe(environment.lease);
			expect(binding).not.toHaveProperty("syncBack");
			expect(binding).not.toHaveProperty("release");
			events.push("quiescence");
			return result({ id: "EnvironmentTask" });
		});

		const outcome = await runIsolatedSubprocess(lifecycleOptions(environment.provider, { signal }));
		await mergeIsolatedChanges({ result: outcome, repoRoot: "/repo", mergeMode: "branch" });

		expect(events).toEqual([
			"worktree",
			"acquire",
			"child",
			"quiescence",
			"sync",
			"release",
			"capture",
			"cleanup",
			"merge",
		]);
		expect(events.indexOf("release")).toBeLessThan(events.indexOf("capture"));
		expect(events.indexOf("capture")).toBeLessThan(events.indexOf("merge"));
		expect(environment.acquire).toHaveBeenCalledWith({
			ownerId: "OwnerAgent",
			sessionId: "EnvironmentTask",
			sourceRoot: isolationDir,
			signal,
		});
		expect(environment.syncBack).toHaveBeenCalledWith(signal);
		expect(environment.release).toHaveBeenCalledTimes(1);
		expect(outcome.exitCode).toBe(0);
	});

	it("does not start the child or release when acquisition fails before returning a lease", async () => {
		const events: string[] = [];
		const isolationDir = "/repo/.omp/isolation/EnvironmentTask";
		const { capture } = setupLifecycleMocks(events, isolationDir);
		const environment = fakeEnvironment(events, isolationDir, {
			acquireFails: true,
			acquireError: new Error("acquire failed"),
		});
		const child = vi.spyOn(executorModule, "runSubprocess");

		const outcome = await runIsolatedSubprocess(lifecycleOptions(environment.provider));

		expect(events).toEqual(["worktree", "acquire", "cleanup"]);
		expect(child).not.toHaveBeenCalled();
		expect(environment.syncBack).not.toHaveBeenCalled();
		expect(environment.release).not.toHaveBeenCalled();
		expect(capture).not.toHaveBeenCalled();
		expect(outcome.error).toContain("acquire failed");
	});

	it("releases once when child session startup throws", async () => {
		const events: string[] = [];
		const isolationDir = "/repo/.omp/isolation/EnvironmentTask";
		const { capture } = setupLifecycleMocks(events, isolationDir);
		const environment = fakeEnvironment(events, isolationDir);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			events.push("child");
			throw new Error("session start failed");
		});

		const outcome = await runIsolatedSubprocess(lifecycleOptions(environment.provider));

		expect(events).toEqual(["worktree", "acquire", "child", "release", "cleanup"]);
		expect(environment.syncBack).not.toHaveBeenCalled();
		expect(environment.release).toHaveBeenCalledTimes(1);
		expect(capture).not.toHaveBeenCalled();
		expect(outcome.error).toContain("session start failed");
	});

	it("skips sync and releases once after child failure", async () => {
		const events: string[] = [];
		const isolationDir = "/repo/.omp/isolation/EnvironmentTask";
		const { capture } = setupLifecycleMocks(events, isolationDir);
		const environment = fakeEnvironment(events, isolationDir);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			events.push("child", "quiescence");
			return result({ id: "EnvironmentTask", error: "child failed" });
		});

		const outcome = await runIsolatedSubprocess(lifecycleOptions(environment.provider));

		expect(events).toEqual(["worktree", "acquire", "child", "quiescence", "release", "cleanup"]);
		expect(environment.syncBack).not.toHaveBeenCalled();
		expect(environment.release).toHaveBeenCalledTimes(1);
		expect(capture).not.toHaveBeenCalled();
		expect(outcome.error).toBe("child failed");
	});

	it("skips sync and releases once after child cancellation", async () => {
		const events: string[] = [];
		const isolationDir = "/repo/.omp/isolation/EnvironmentTask";
		const controller = new AbortController();
		const { capture } = setupLifecycleMocks(events, isolationDir);
		const environment = fakeEnvironment(events, isolationDir);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			events.push("child");
			controller.abort();
			events.push("quiescence");
			return result({ id: "EnvironmentTask" });
		});

		const outcome = await runIsolatedSubprocess(
			lifecycleOptions(environment.provider, { signal: controller.signal }),
		);

		expect(events).toEqual(["worktree", "acquire", "child", "quiescence", "release", "cleanup"]);
		expect(environment.syncBack).not.toHaveBeenCalled();
		expect(environment.release).toHaveBeenCalledTimes(1);
		expect(capture).not.toHaveBeenCalled();
		expect(outcome.aborted).toBe(true);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.error).toContain("cancelled before capture");
	});

	it("releases once and blocks capture when sync-back fails", async () => {
		const events: string[] = [];
		const isolationDir = "/repo/.omp/isolation/EnvironmentTask";
		const { capture } = setupLifecycleMocks(events, isolationDir);
		const environment = fakeEnvironment(events, isolationDir, {
			syncFails: true,
			syncError: new Error("manifest rejected"),
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			events.push("child", "quiescence");
			return result({ id: "EnvironmentTask" });
		});

		const outcome = await runIsolatedSubprocess(lifecycleOptions(environment.provider));

		expect(events).toEqual(["worktree", "acquire", "child", "quiescence", "sync", "release", "cleanup"]);
		expect(environment.release).toHaveBeenCalledTimes(1);
		expect(capture).not.toHaveBeenCalled();
		expect(outcome.exitCode).toBe(1);
		expect(outcome.error).toContain("sync-back failed");
		expect(outcome.error).toContain("manifest rejected");
		expect(outcome.patchPath).toBeUndefined();
		expect(outcome.branchName).toBeUndefined();
		expect(outcome.nestedPatches).toBeUndefined();
	});

	it("reports an escaped lease ID and blocks capture when release fails", async () => {
		const events: string[] = [];
		const isolationDir = "/repo/.omp/isolation/EnvironmentTask";
		const leaseId = "lease-unsafe\nvalue";
		const { capture } = setupLifecycleMocks(events, isolationDir);
		const environment = fakeEnvironment(events, isolationDir, {
			leaseId,
			releaseFails: true,
			releaseError: new Error("close failed"),
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			events.push("child", "quiescence");
			return result({ id: "EnvironmentTask" });
		});

		const outcome = await runIsolatedSubprocess(lifecycleOptions(environment.provider));

		expect(events).toEqual(["worktree", "acquire", "child", "quiescence", "sync", "release", "cleanup"]);
		expect(environment.release).toHaveBeenCalledTimes(1);
		expect(capture).not.toHaveBeenCalled();
		expect(outcome.exitCode).toBe(1);
		expect(outcome.error).toContain("release failed");
		expect(outcome.error).toContain(JSON.stringify(leaseId));
		expect(outcome.error).not.toContain(leaseId);
		expect(outcome.patchPath).toBeUndefined();
		expect(outcome.branchName).toBeUndefined();
		expect(outcome.nestedPatches).toBeUndefined();
	});

	it("preserves branch-mode output as a patch when branch transfer fails", async () => {
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-run-"));
		tempRoots.push(repoRoot);
		const isolationDir = path.join(repoRoot, "isolated");
		const artifactsDir = path.join(repoRoot, "artifacts");
		const baseline = {
			root: {
				repoRoot,
				headCommit: "base",
				staged: "",
				unstaged: "",
				untracked: [],
				untrackedPatch: "",
			},
			nested: [],
		};
		const rootPatch = "diff --git a/task.txt b/task.txt\n--- a/task.txt\n+++ b/task.txt\n@@ -1 +1 @@\n-old\n+new\n";

		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: isolationDir,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result({ id: "PreserveBranchFailure" }));
		vi.spyOn(worktreeModule, "commitToBranch").mockRejectedValue(new Error("remote: object corrupt"));
		const captureSpy = vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch,
			nestedPatches: [],
		});
		const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
		AgentRegistry.global().register({
			id: "PreserveBranchFailure",
			displayName: "PreserveBranchFailure",
			kind: "sub",
			session: null,
			status: "parked",
		});
		const deleteSpy = vi.spyOn(gitModule.branch, "tryDelete").mockResolvedValue(true);

		const outcome = await runIsolatedSubprocess({
			baseOptions: {
				cwd: repoRoot,
				agent: {
					name: "task",
					description: "Task agent",
					systemPrompt: "test",
					source: "bundled",
				},
				task: "Do work",
				index: 0,
				id: "PreserveBranchFailure",
			},
			context: { repoRoot, baseline },
			preferredBackend: undefined,
			agentId: "PreserveBranchFailure",
			mergeMode: "branch",
			artifactsDir,
			buildFailureResult: err => result({ exitCode: 1, error: String(err) }),
		});

		const patchPath = path.join(artifactsDir, "PreserveBranchFailure.patch");
		expect(outcome.error).toContain("Merge failed: remote: object corrupt");
		expect(outcome.patchPath).toBe(patchPath);
		expect(await Bun.file(patchPath).text()).toBe(rootPatch);
		expect(outcome.nestedPatches).toEqual([]);
		expect(captureSpy).toHaveBeenCalledWith(isolationDir, baseline);
		expect(deleteSpy).toHaveBeenCalledWith(repoRoot, "omp/task/PreserveBranchFailure");
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
		expect(AgentRegistry.global().get("PreserveBranchFailure")?.history?.patchPath).toBe(patchPath);
	});

	it("keeps an isolated worktree until deferred child cleanup settles", async () => {
		const cleanupGate = Promise.withResolvers<void>();
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/isolated",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			options.onCleanupDeferred?.(cleanupGate.promise);
			return result({ exitCode: 1, aborted: true, error: "cleanup exceeded its deadline" });
		});
		const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();

		const outcome = await runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent: {
					name: "task",
					description: "Task agent",
					systemPrompt: "test",
					source: "bundled",
				},
				task: "Do work",
				index: 0,
				id: "DeferredCleanup",
			},
			context: {
				repoRoot: "/repo",
				baseline: {
					root: {
						repoRoot: "/repo",
						headCommit: "base",
						staged: "",
						unstaged: "",
						untracked: [],
						untrackedPatch: "",
					},
					nested: [],
				},
			},
			preferredBackend: undefined,
			agentId: "DeferredCleanup",
			mergeMode: "patch",
			artifactsDir: "/artifacts",
			buildFailureResult: error => result({ exitCode: 1, error: String(error) }),
		});

		expect(outcome.exitCode).toBe(1);
		expect(cleanupSpy).not.toHaveBeenCalled();
		cleanupGate.resolve();
		await cleanupGate.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
	});
	it("releases an environment lease before deferred worktree cleanup", async () => {
		const events: string[] = [];
		const isolationDir = "/repo/.omp/isolation/EnvironmentTask";
		const cleanupGate = Promise.withResolvers<void>();
		const { capture } = setupLifecycleMocks(events, isolationDir);
		const environment = fakeEnvironment(events, isolationDir);
		let deferredCleanup: Promise<void> | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			events.push("child");
			options.onCleanupDeferred?.(cleanupGate.promise);
			return result({ id: "EnvironmentTask", exitCode: 1, aborted: true, error: "cleanup pending" });
		});

		const outcome = await runIsolatedSubprocess(
			lifecycleOptions(environment.provider, {
				onCleanupDeferred: completion => {
					deferredCleanup = completion;
				},
			}),
		);

		expect(outcome.error).toBe("cleanup pending");
		expect(events).toEqual(["worktree", "acquire", "child"]);
		expect(environment.syncBack).not.toHaveBeenCalled();
		expect(environment.release).not.toHaveBeenCalled();
		expect(capture).not.toHaveBeenCalled();
		expect(deferredCleanup).toBeDefined();

		cleanupGate.resolve();
		await deferredCleanup;
		await Promise.resolve();

		expect(events).toEqual(["worktree", "acquire", "child", "release", "cleanup"]);
		expect(environment.release).toHaveBeenCalledTimes(1);
		expect(capture).not.toHaveBeenCalled();
	});
});

describe("mergeIsolatedChanges", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempRoots.splice(0).map(tempRoot => fs.rm(tempRoot, { force: true, recursive: true })));
	});

	it("allows nested-only branch-mode patches to apply when no root branch was created", async () => {
		const mergeSpy = vi.spyOn(worktreeModule, "mergeTaskBranches");
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		});

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
		expect(outcome.mergedBranchForNestedPatches).toBe(true);
		expect(outcome.summary).toContain("nested repository patches captured");
	});

	it("surfaces branch preparation errors instead of reporting no changes", async () => {
		const mergeSpy = vi.spyOn(worktreeModule, "mergeTaskBranches");
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				error: "Merge failed: git apply --3way failed for task dirty-context: conflict",
				patchPath: "/repo/artifacts/dirty-context.patch",
			}),
		});

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(outcome.changesApplied).toBe(false);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.mergedBranchForNestedPatches).toBe(false);
		expect(outcome.summary).toContain("Branch merge failed before a task branch could be created");
		expect(outcome.summary).toContain("git apply --3way failed");
		expect(outcome.summary).toContain("/repo/artifacts/dirty-context.patch");
		expect(outcome.summary).not.toContain("No changes to apply");
	});

	it("treats already-applied patch-mode diffs as successful no-ops", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("new\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.summary).not.toContain("Patches were not applied");
		expect(await git(repoRoot, "status", "--porcelain", "--", "foo.txt")).toBe("");
	});

	it("rejects patch-mode conflicts without dirtying the worktree", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("other\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(false);
		expect(outcome.summary).toContain("Patches were not applied");
		expect(await git(repoRoot, "status", "--porcelain", "--", "foo.txt")).toBe("");
		expect(await Bun.file(path.join(repoRoot, "foo.txt")).text()).toBe("other\n");
		expect(await git(repoRoot, "ls-files", "-u", "--", "foo.txt")).toBe("");
	});

	it("applies a fresh patch-mode diff when context matches", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("old\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
		expect(await Bun.file(path.join(repoRoot, "foo.txt")).text()).toBe("new\n");
	});

	it("prefers forward apply when both reverse-check and forward-check succeed", async () => {
		// If git-apply's fuzz ever lets `--reverse --check` succeed while forward
		// `--check` also succeeds (e.g. repeated context with the postimage present
		// elsewhere), the outcome must NOT be a silent no-op.
		const { repoRoot, patchPath } = await seedFooRepo("old\n");
		const canApplySpy = vi.spyOn(gitModule.patch, "canApplyText").mockResolvedValue(true);
		const applySpy = vi.spyOn(gitModule.patch, "applyText").mockResolvedValue(undefined);

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(canApplySpy).toHaveBeenCalledTimes(2);
		expect(applySpy).toHaveBeenCalledTimes(1);
		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
	});

	it("does not mark failed branch-mode runs as nested-patch eligible", async () => {
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				exitCode: 1,
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.mergedBranchForNestedPatches).toBe(false);
	});
});

describe("applyEligibleNestedPatches", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const nestedPatch = { relativePath: "nested", patch: "diff --git a/file b/file\n" };

	it("skips when patch-mode parent merge failed", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches");
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: false,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("skips when branch mode did not actually merge the root branch", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches");
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "branch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("applies nested patches and returns no warning on success", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue([]);
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).toHaveBeenCalledTimes(1);
	});

	it("returns a system-notification suffix on apply failure", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockRejectedValue(new Error("boom"));
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "branch",
			changesApplied: true,
			mergedBranchForNestedPatches: true,
		});
		expect(suffix).toContain("Some nested repository patches failed to apply");
	});

	it("surfaces stash-restore warnings from applyNestedPatches as a system-notification", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue([
			"Pre-existing dirty state in nested repo `nested` could not be auto-restored after the agent commit; stash entry preserved (conflict).",
		]);
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toContain("could not be auto-restored");
		expect(suffix).toContain("stash entry preserved");
		expect(suffix).toContain("<system-notification>");
	});
});
