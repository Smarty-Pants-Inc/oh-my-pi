import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getDefault } from "../../src/config/settings-schema";
import { canonicalJson, compareUnicodeCodePoints, type JsonValue, sha256 } from "../../src/context/canonical";
import {
	computeImplementationSources,
	runtimeImportSpecifiersForImplementationSource,
} from "../../src/context/implementation-sources";
import {
	activationStatePath,
	approvedCandidateSourceMatches,
	assertTrackedManifestCurrent,
	canonicalGithubRepository,
	isApprovedCandidateSource,
	parseContentManifest,
	parseContextReleaseManifest,
	trackedContentManifest,
	validateScopeCoverage,
} from "../../src/context/manifest";
import { agentBehavior, parseAgentBehavior } from "../../src/context/registry";
import { exportRenderedToolContracts, parseGeneratedToolContracts } from "../../src/context/tool-contracts";
import { classifyProtectedPath } from "../../src/policy/protected-surface";

describe("tracked context manifest", () => {
	it("uses the fail-closed behavior manifest as the governed runtime default source", () => {
		expect(getDefault("tools.approvalMode")).toBe("yolo");
		expect(getDefault("todo.enabled")).toBe(agentBehavior.todo.enabled);
		expect(getDefault("todo.reminders")).toBe(agentBehavior.todo.stopReminders);
		expect(getDefault("todo.eager")).toBe(agentBehavior.todo.eager);
		expect(getDefault("goal.enabled")).toBe(agentBehavior.goal.enabled);
		expect(getDefault("goal.continuationModes")).toEqual(agentBehavior.goal.continuationModes);
		expect(getDefault("task.eager")).toBe(agentBehavior.task.eager);
		expect(getDefault("task.maxRecursionDepth")).toBe(agentBehavior.task.maxRecursionDepth);

		const source = Bun.file(path.resolve(import.meta.dir, "../../src/agent-behavior.yml")).text();
		return source.then(text => {
			expect(parseAgentBehavior(text)).toEqual(agentBehavior);
			expect(() => parseAgentBehavior(`${text}\nunknownProtectedDefault: true\n`)).toThrow(
				"unknown or missing fields",
			);
			expect(() => parseAgentBehavior(text.replace("maxRecursionDepth: 2", "maxRecursionDepth: nope"))).toThrow(
				"task.maxRecursionDepth",
			);
			expect(() => parseAgentBehavior(text.replace("midRunNudges: false", "midRunNudges: true"))).toThrow(
				"must match the shared reminder default",
			);
			expect(() => parseAgentBehavior(text.replace("forcedFanout: false", "forcedFanout: true"))).toThrow(
				"task.forcedFanout must be false",
			);
		});
	});

	it("uses the canonical activation state path and ignores environment decoys", () => {
		Bun.env.SMARTY_POLICY_STATE_PATH = "/tmp/decoy-state.json";
		try {
			expect(activationStatePath()).toEndWith(path.join(".omp", "policy-state.json"));
			expect(activationStatePath()).not.toBe(Bun.env.SMARTY_POLICY_STATE_PATH);
		} finally {
			delete Bun.env.SMARTY_POLICY_STATE_PATH;
		}
	});

	it("normalizes only canonical GitHub owner/name origins", () => {
		expect(canonicalGithubRepository("git@github.com:Smarty-Pants-Inc/oh-my-pi.git")).toBe(
			"Smarty-Pants-Inc/oh-my-pi",
		);
		expect(canonicalGithubRepository("https://github.com/Smarty-Pants-Inc/oh-my-pi")).toBe(
			"Smarty-Pants-Inc/oh-my-pi",
		);
		expect(canonicalGithubRepository("https://example.com/Smarty-Pants-Inc/oh-my-pi.git")).toBeUndefined();
	});

	it("keeps the OMP internal prompt capability off the package API", async () => {
		const packageJson = (await Bun.file(path.resolve(import.meta.dir, "../../package.json")).json()) as {
			exports: Record<string, unknown>;
		};
		expect(packageJson.exports["./context/internal-session"]).toBeNull();
		expect(packageJson.exports["./context/internal-session.js"]).toBeNull();
	});

	it("accepts only the active immutable materialized Stack package", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-materialized-extension-"));
		const stackRoot = path.join(repositoryRoot, "home/.smarty-stack");
		const packageRoot = path.join(stackRoot, "versions/0.20.11");
		const currentRoot = path.join(stackRoot, "current");
		const relativeEntry = "extensions/smarty-prompt-guard/src/index.ts";
		const entryPath = path.join(packageRoot, relativeEntry);
		const currentEntryPath = path.join(currentRoot, relativeEntry);
		const repository = "Smarty-Pants-Inc/smarty-stack";
		const commit = "a".repeat(40);
		const tree = "b".repeat(40);
		const chmodTree = async (directory: string, directoryMode: number, fileMode: number): Promise<void> => {
			for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
				const target = path.join(directory, entry.name);
				if (entry.isDirectory()) await chmodTree(target, directoryMode, fileMode);
				else if (entry.isFile()) await fs.chmod(target, fileMode);
			}
			await fs.chmod(directory, directoryMode);
		};
		try {
			await fs.mkdir(path.dirname(entryPath), { recursive: true });
			const provenance = {
				schema: "smarty.stack.provenance.v1",
				version: "0.20.11",
				repository,
				commit,
				tree,
				createdAt: "2026-08-22",
				purpose: "test package",
				sources: [],
				authority: "test",
				recovery: "test",
				nonclaims: [],
			};
			const files = new Map<string, string>([
				["PROVENANCE.json", `${JSON.stringify(provenance, null, 2)}\n`],
				[
					"extensions/smarty-prompt-guard/package.json",
					'{"type":"module","omp":{"extensions":["./src/index.ts"]}}\n',
				],
				[relativeEntry, "export default function promptGuard() {}\n"],
				[
					"runtime-package.json",
					'{"schema":"smarty.stack.runtime_projection.v1","files":["PROVENANCE.json","runtime-package.json"],"directories":["extensions/smarty-prompt-guard"]}\n',
				],
			]);
			for (const [relative, source] of files) {
				const target = path.join(packageRoot, relative);
				await fs.mkdir(path.dirname(target), { recursive: true });
				await Bun.write(target, source);
			}
			const manifest = {
				schema: "smarty.stack.release_manifest.v1",
				version: "0.20.11",
				createdAt: "2026-08-22",
				status: "protected_candidate_requires_external_approval",
				files: [...files]
					.map(([relative, source]) => ({
						path: relative,
						bytes: Buffer.byteLength(source),
						sha256: sha256(source),
					}))
					.sort((left, right) => compareUnicodeCodePoints(left.path, right.path)),
			};
			const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
			await Bun.write(path.join(packageRoot, "MANIFEST.json"), manifestSource);
			const checksums = [
				...manifest.files.map(entry => [entry.path, entry.sha256] as const),
				["MANIFEST.json", sha256(manifestSource)] as const,
			]
				.sort(([left], [right]) => compareUnicodeCodePoints(left, right))
				.map(([relative, digest]) => `${digest}  ${relative}`)
				.join("\n");
			await Bun.write(path.join(packageRoot, "SHA256SUMS.txt"), `${checksums}\n`);
			await fs.symlink(path.join("versions", "0.20.11"), currentRoot);
			const result = Bun.spawnSync(["git", "init", "-q"], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
			expect(result.exitCode).toBe(0);
			const release = {
				candidates: [{ repository, commit, tree }],
			} as unknown as Parameters<typeof isApprovedCandidateSource>[1];

			expect(await isApprovedCandidateSource(currentEntryPath, release)).toBe(false);
			await chmodTree(packageRoot, 0o555, 0o444);
			expect(await isApprovedCandidateSource(entryPath, release)).toBe(false);
			expect(await isApprovedCandidateSource(currentEntryPath, release)).toBe(true);
		} finally {
			try {
				await chmodTree(packageRoot, 0o755, 0o644);
			} catch {}
			await fs.rm(repositoryRoot, { recursive: true, force: true });
		}
	});

	it("binds extension packages to approved identity, tree, and clean source", () => {
		const identity = {
			repository: "Smarty-Pants-Inc/oh-my-pi",
			baseCommit: "c".repeat(40),
			baseTree: "d".repeat(40),
			commit: "a".repeat(40),
			tree: "b".repeat(40),
			scopeCoverage: [{ path: "packages/coding-agent/src/context/manifest.ts", requirement: "§8.6" }],
		};
		const release = { candidates: [identity] };
		const packageTree = "e".repeat(40);
		expect(approvedCandidateSourceMatches(identity.repository, identity, packageTree, packageTree, "", release)).toBe(
			true,
		);
		expect(
			approvedCandidateSourceMatches(identity.repository, identity, packageTree, "f".repeat(40), "", release),
		).toBe(false);
		expect(
			approvedCandidateSourceMatches(
				identity.repository,
				identity,
				packageTree,
				packageTree,
				" M source.ts",
				release,
			),
		).toBe(false);
		expect(approvedCandidateSourceMatches("other/repository", identity, packageTree, packageTree, "", release)).toBe(
			false,
		);
	});

	it("keeps an approved symlinked package active after unrelated commits and rejects package drift", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-approved-extension-"));
		const packageRoot = path.join(repositoryRoot, "packages/plugin");
		const linkedRoot = path.join(repositoryRoot, "linked-plugin");
		const indexPath = path.join(packageRoot, "src/index.ts");
		const linkedIndexPath = path.join(linkedRoot, "src/index.ts");
		const storePath = path.join(packageRoot, "src/store.ts");
		const runGit = (...args: string[]): string => {
			const result = Bun.spawnSync(["git", ...args], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			return result.stdout.toString().trim();
		};
		try {
			await fs.mkdir(path.dirname(indexPath), { recursive: true });
			await Promise.all([
				Bun.write(path.join(packageRoot, "package.json"), '{"name":"test-plugin"}\n'),
				Bun.write(indexPath, 'import "./store.js";\nexport default function plugin() {}\n'),
				Bun.write(storePath, "export const value = 1;\n"),
				Bun.write(path.join(repositoryRoot, ".gitignore"), "packages/plugin/src/store.js\n"),
				Bun.write(
					path.join(packageRoot, "MANIFEST.json"),
					'{"schema":"smarty.stack.release_manifest.v1","version":"0.20.11","createdAt":"2026-08-22","status":"protected_candidate_requires_external_approval","files":[]}\n',
				),
				Bun.write(
					path.join(packageRoot, "PROVENANCE.json"),
					'{"schema":"smarty.stack.provenance.v1","version":"0.20.11","repository":"Smarty-Pants-Inc/smarty-dev","commit":null,"tree":null,"createdAt":"2026-08-22","purpose":"test","sources":[],"authority":"test","recovery":"test","nonclaims":[]}\n',
				),
				Bun.write(path.join(packageRoot, "SHA256SUMS.txt"), ""),
			]);
			await fs.symlink(packageRoot, linkedRoot);
			runGit("init", "-q");
			runGit("config", "user.name", "OMP Test");
			runGit("config", "user.email", "omp-test@example.com");
			runGit("remote", "add", "origin", "https://github.com/Smarty-Pants-Inc/smarty-dev.git");
			runGit("add", ".");
			runGit("commit", "-qm", "approved package");
			const commit = runGit("rev-parse", "HEAD");
			const tree = runGit("rev-parse", "HEAD^{tree}");
			const release = {
				candidates: [{ repository: "Smarty-Pants-Inc/smarty-dev", commit, tree }],
			} as unknown as Parameters<typeof isApprovedCandidateSource>[1];

			await Bun.write(path.join(repositoryRoot, "unrelated.txt"), "later commit\n");
			runGit("add", "unrelated.txt");
			runGit("commit", "-qm", "unrelated change");
			const unrelatedCommit = runGit("rev-parse", "HEAD");
			expect(await isApprovedCandidateSource(linkedIndexPath, release)).toBe(true);

			await Bun.write(storePath, "export const value = 2;\n");
			expect(await isApprovedCandidateSource(linkedIndexPath, release)).toBe(false);
			runGit("checkout", "--", "packages/plugin/src/store.ts");

			const untrackedPath = path.join(packageRoot, "src/untracked.ts");
			await Bun.write(untrackedPath, "export {};\n");
			expect(await isApprovedCandidateSource(linkedIndexPath, release)).toBe(false);
			await fs.rm(untrackedPath);

			const ignoredShadowPath = path.join(packageRoot, "src/store.js");
			await Bun.write(ignoredShadowPath, "export const value = 3;\n");
			expect(await isApprovedCandidateSource(linkedIndexPath, release)).toBe(false);
			await fs.rm(ignoredShadowPath);

			await Bun.write(path.join(packageRoot, "package.json"), '{"name":"changed-plugin"}\n');
			runGit("add", "packages/plugin/package.json");
			runGit("commit", "-qm", "change package");
			expect(await isApprovedCandidateSource(linkedIndexPath, release)).toBe(false);
			runGit("reset", "--hard", unrelatedCommit);
			expect(await isApprovedCandidateSource(linkedIndexPath, release)).toBe(true);
		} finally {
			await fs.rm(repositoryRoot, { recursive: true, force: true });
		}
	});

	it("rejects tracked byte, mode, and type drift hidden by Git worktree flags", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hidden-extension-drift-"));
		const packageRoot = path.join(repositoryRoot, "packages/plugin");
		const indexPath = path.join(packageRoot, "src/index.ts");
		const storePath = path.join(packageRoot, "src/store.ts");
		const targetPath = path.join(packageRoot, "src/target.ts");
		const relativeStorePath = "packages/plugin/src/store.ts";
		const originalStore = "target.ts";
		const runGit = (...args: string[]): string => {
			const result = Bun.spawnSync(["git", ...args], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			return result.stdout.toString().trim();
		};
		try {
			await fs.mkdir(path.dirname(indexPath), { recursive: true });
			await Promise.all([
				Bun.write(path.join(packageRoot, "package.json"), '{"name":"hidden-drift-plugin","type":"module"}\n'),
				Bun.write(indexPath, 'import "./store.js";\nexport default function plugin() {}\n'),
				Bun.write(storePath, originalStore),
				Bun.write(targetPath, "export const target = true;\n"),
			]);
			runGit("init", "-q");
			runGit("config", "user.name", "OMP Test");
			runGit("config", "user.email", "omp-test@example.com");
			runGit("remote", "add", "origin", "https://github.com/Smarty-Pants-Inc/smarty-dev.git");
			runGit("add", ".");
			runGit("commit", "-qm", "approved hidden-drift package");
			const commit = runGit("rev-parse", "HEAD");
			const tree = runGit("rev-parse", "HEAD^{tree}");
			const release = {
				candidates: [{ repository: "Smarty-Pants-Inc/smarty-dev", commit, tree }],
			} as unknown as Parameters<typeof isApprovedCandidateSource>[1];

			expect(await isApprovedCandidateSource(indexPath, release)).toBe(true);
			for (const [hideFlag, showFlag] of [
				["--assume-unchanged", "--no-assume-unchanged"],
				["--skip-worktree", "--no-skip-worktree"],
			] as const) {
				runGit("update-index", hideFlag, relativeStorePath);
				await Bun.write(storePath, `export const value = ${JSON.stringify(hideFlag)};\n`);
				expect(runGit("status", "--porcelain=v1", "--", relativeStorePath)).toBe("");
				expect(await isApprovedCandidateSource(indexPath, release)).toBe(false);
				await Bun.write(storePath, originalStore);
				runGit("update-index", showFlag, relativeStorePath);
				expect(await isApprovedCandidateSource(indexPath, release)).toBe(true);
			}
			if (process.platform !== "win32") {
				runGit("update-index", "--assume-unchanged", relativeStorePath);
				await fs.chmod(storePath, 0o755);
				expect(runGit("status", "--porcelain=v1", "--", relativeStorePath)).toBe("");
				expect(await isApprovedCandidateSource(indexPath, release)).toBe(false);
				await fs.chmod(storePath, 0o644);
				expect(await isApprovedCandidateSource(indexPath, release)).toBe(true);

				await fs.rm(storePath);
				await fs.symlink("target.ts", storePath);
				expect(runGit("status", "--porcelain=v1", "--", relativeStorePath)).toBe("");
				expect(await isApprovedCandidateSource(indexPath, release)).toBe(false);
				await fs.rm(storePath);
				await Bun.write(storePath, originalStore);
				runGit("update-index", "--no-assume-unchanged", relativeStorePath);
				expect(await isApprovedCandidateSource(indexPath, release)).toBe(true);
			}
		} finally {
			await fs.rm(repositoryRoot, { recursive: true, force: true });
		}
	});

	it("approves core.symlinks=false placeholders while rejecting symlink content and type drift", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-symlinks-false-extension-"));
		const packageRoot = path.join(repositoryRoot, "packages/plugin");
		const indexPath = path.join(packageRoot, "src/index.ts");
		const linkPath = path.join(packageRoot, "current.txt");
		const relativeLinkPath = "packages/plugin/current.txt";
		const linkTarget = "target.txt";
		const runGit = (...args: string[]): string => {
			const result = Bun.spawnSync(["git", ...args], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			return result.stdout.toString().trim();
		};
		try {
			await fs.mkdir(path.dirname(indexPath), { recursive: true });
			await Promise.all([
				Bun.write(path.join(packageRoot, "package.json"), '{"name":"symlink-plugin","type":"module"}\n'),
				Bun.write(indexPath, "export default function plugin() {}\n"),
				Bun.write(path.join(packageRoot, linkTarget), "target\n"),
			]);
			await fs.symlink(linkTarget, linkPath);
			runGit("init", "-q");
			runGit("config", "user.name", "OMP Test");
			runGit("config", "user.email", "omp-test@example.com");
			runGit("config", "core.symlinks", "true");
			runGit("remote", "add", "origin", "https://github.com/Smarty-Pants-Inc/smarty-dev.git");
			runGit("add", ".");
			runGit("commit", "-qm", "approved symlink package");
			const commit = runGit("rev-parse", "HEAD");
			const tree = runGit("rev-parse", "HEAD^{tree}");
			const release = {
				candidates: [{ repository: "Smarty-Pants-Inc/smarty-dev", commit, tree }],
			} as unknown as Parameters<typeof isApprovedCandidateSource>[1];

			expect(runGit("ls-tree", "HEAD", "--", relativeLinkPath)).toStartWith("120000 blob ");
			expect(await isApprovedCandidateSource(indexPath, release)).toBe(true);

			runGit("update-index", "--assume-unchanged", relativeLinkPath);
			await fs.rm(linkPath);
			await Bun.write(linkPath, linkTarget);
			expect((await fs.lstat(linkPath)).isFile()).toBe(true);
			expect(runGit("status", "--porcelain=v1", "--", relativeLinkPath)).toBe("");
			expect(await isApprovedCandidateSource(indexPath, release)).toBe(false);

			runGit("config", "core.symlinks", "false");
			expect(await isApprovedCandidateSource(indexPath, release)).toBe(true);

			await Bun.write(linkPath, "other.txt");
			expect(runGit("status", "--porcelain=v1", "--", relativeLinkPath)).toBe("");
			expect(await isApprovedCandidateSource(indexPath, release)).toBe(false);

			await fs.rm(linkPath);
			await fs.mkdir(linkPath);
			expect(runGit("status", "--porcelain=v1", "--", relativeLinkPath)).toBe("");
			expect(await isApprovedCandidateSource(indexPath, release)).toBe(false);
		} finally {
			await fs.rm(repositoryRoot, { recursive: true, force: true });
		}
	});

	it("keeps indexed executables approved when core.filemode disables filesystem mode checks", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-filemode-false-extension-"));
		const packageRoot = path.join(repositoryRoot, "packages/plugin");
		const indexPath = path.join(packageRoot, "src/index.ts");
		const executablePath = path.join(packageRoot, "bin/run.js");
		const relativeExecutablePath = "packages/plugin/bin/run.js";
		const runGit = (...args: string[]): string => {
			const result = Bun.spawnSync(["git", ...args], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			return result.stdout.toString().trim();
		};
		try {
			await Promise.all([
				fs.mkdir(path.dirname(indexPath), { recursive: true }),
				fs.mkdir(path.dirname(executablePath), { recursive: true }),
			]);
			await Promise.all([
				Bun.write(path.join(packageRoot, "package.json"), '{"name":"filemode-plugin","type":"module"}\n'),
				Bun.write(indexPath, "export default function plugin() {}\n"),
				Bun.write(executablePath, '#!/usr/bin/env bun\nconsole.log("clean");\n'),
			]);
			runGit("init", "-q");
			runGit("config", "user.name", "OMP Test");
			runGit("config", "user.email", "omp-test@example.com");
			runGit("config", "core.fileMode", "false");
			runGit("remote", "add", "origin", "https://github.com/Smarty-Pants-Inc/smarty-dev.git");
			runGit("add", ".");
			runGit("update-index", "--chmod=+x", relativeExecutablePath);
			runGit("commit", "-qm", "approved executable package");
			await fs.chmod(executablePath, 0o644);
			const commit = runGit("rev-parse", "HEAD");
			const tree = runGit("rev-parse", "HEAD^{tree}");
			const release = {
				candidates: [{ repository: "Smarty-Pants-Inc/smarty-dev", commit, tree }],
			} as unknown as Parameters<typeof isApprovedCandidateSource>[1];

			expect(runGit("ls-tree", "HEAD", "--", relativeExecutablePath)).toStartWith("100755 blob ");
			expect(runGit("status", "--porcelain=v1", "--", relativeExecutablePath)).toBe("");
			expect(await isApprovedCandidateSource(indexPath, release)).toBe(true);

			runGit("update-index", "--assume-unchanged", relativeExecutablePath);
			await Bun.write(executablePath, '#!/usr/bin/env bun\nconsole.log("drift");\n');
			expect(runGit("status", "--porcelain=v1", "--", relativeExecutablePath)).toBe("");
			expect(await isApprovedCandidateSource(indexPath, release)).toBe(false);
		} finally {
			await fs.rm(repositoryRoot, { recursive: true, force: true });
		}
	});

	it("treats package directories as literal Git pathspecs", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-literal-package-pathspec-"));
		const packageRoot = path.join(repositoryRoot, "packages/plugin[1]");
		const indexPath = path.join(packageRoot, "src/index.ts");
		const storePath = path.join(packageRoot, "src/store.ts");
		const runGit = (...args: string[]): string => {
			const result = Bun.spawnSync(["git", ...args], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			return result.stdout.toString().trim();
		};
		try {
			await fs.mkdir(path.dirname(indexPath), { recursive: true });
			await Promise.all([
				Bun.write(path.join(packageRoot, "package.json"), '{"name":"literal-pathspec-plugin","type":"module"}\n'),
				Bun.write(indexPath, 'import "./store.js";\nexport default function plugin() {}\n'),
				Bun.write(storePath, "export const value = 1;\n"),
			]);
			runGit("init", "-q");
			runGit("config", "user.name", "OMP Test");
			runGit("config", "user.email", "omp-test@example.com");
			runGit("remote", "add", "origin", "https://github.com/Smarty-Pants-Inc/smarty-dev.git");
			runGit("add", ".");
			runGit("commit", "-qm", "approved literal-pathspec package");
			const commit = runGit("rev-parse", "HEAD");
			const tree = runGit("rev-parse", "HEAD^{tree}");
			const release = {
				candidates: [{ repository: "Smarty-Pants-Inc/smarty-dev", commit, tree }],
			} as unknown as Parameters<typeof isApprovedCandidateSource>[1];

			expect(await isApprovedCandidateSource(indexPath, release)).toBe(true);
			await Bun.write(storePath, "export const value = 2;\n");
			expect(await isApprovedCandidateSource(indexPath, release)).toBe(false);
		} finally {
			await fs.rm(repositoryRoot, { recursive: true, force: true });
		}
	});

	it("approves an unchanged repository-root extension package", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-root-extension-"));
		const indexPath = path.join(repositoryRoot, "src/index.ts");
		const runGit = (...args: string[]): string => {
			const result = Bun.spawnSync(["git", ...args], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			return result.stdout.toString().trim();
		};
		try {
			await fs.mkdir(path.dirname(indexPath), { recursive: true });
			await Promise.all([
				Bun.write(path.join(repositoryRoot, "package.json"), '{"name":"root-plugin","type":"module"}\n'),
				Bun.write(indexPath, "export default function plugin() {}\n"),
			]);
			runGit("init", "-q");
			runGit("config", "user.name", "OMP Test");
			runGit("config", "user.email", "omp-test@example.com");
			runGit("remote", "add", "origin", "https://github.com/Smarty-Pants-Inc/smarty-dev.git");
			runGit("add", ".");
			runGit("commit", "-qm", "approved root package");
			const commit = runGit("rev-parse", "HEAD");
			const tree = runGit("rev-parse", "HEAD^{tree}");
			const release = {
				candidates: [{ repository: "Smarty-Pants-Inc/smarty-dev", commit, tree }],
			} as unknown as Parameters<typeof isApprovedCandidateSource>[1];

			expect(await isApprovedCandidateSource(indexPath, release)).toBe(true);
		} finally {
			await fs.rm(repositoryRoot, { recursive: true, force: true });
		}
	});

	it("rejects extension graphs that escape their approved package or lack a candidate package root", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-contained-extension-"));
		const directRoot = path.join(repositoryRoot, "packages/direct");
		const symlinkRoot = path.join(repositoryRoot, "packages/symlink");
		const noManifestRoot = path.join(repositoryRoot, "loose");
		const runGit = (...args: string[]): string => {
			const result = Bun.spawnSync(["git", ...args], { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			return result.stdout.toString().trim();
		};
		try {
			await Promise.all([
				fs.mkdir(path.join(directRoot, "src"), { recursive: true }),
				fs.mkdir(path.join(symlinkRoot, "src"), { recursive: true }),
				fs.mkdir(noManifestRoot, { recursive: true }),
			]);
			await Promise.all([
				Bun.write(path.join(repositoryRoot, "shared.ts"), "export const shared = true;\n"),
				Bun.write(path.join(directRoot, "package.json"), '{"name":"direct-plugin"}\n'),
				Bun.write(
					path.join(directRoot, "src/index.ts"),
					'import "../../../shared.ts";\nexport default () => {};\n',
				),
				Bun.write(path.join(symlinkRoot, "package.json"), '{"name":"symlink-plugin"}\n'),
				Bun.write(path.join(symlinkRoot, "src/index.ts"), 'import "./external.js";\nexport default () => {};\n'),
				Bun.write(path.join(noManifestRoot, "index.ts"), "export default () => {};\n"),
			]);
			await fs.symlink("../../../shared.ts", path.join(symlinkRoot, "src/external.ts"));
			runGit("init", "-q");
			runGit("config", "user.name", "OMP Test");
			runGit("config", "user.email", "omp-test@example.com");
			runGit("remote", "add", "origin", "https://github.com/Smarty-Pants-Inc/smarty-dev.git");
			runGit("add", ".");
			runGit("commit", "-qm", "approved package graphs");
			const commit = runGit("rev-parse", "HEAD");
			const tree = runGit("rev-parse", "HEAD^{tree}");
			const release = {
				candidates: [{ repository: "Smarty-Pants-Inc/smarty-dev", commit, tree }],
			} as unknown as Parameters<typeof isApprovedCandidateSource>[1];

			expect(await isApprovedCandidateSource(path.join(directRoot, "src/index.ts"), release)).toBe(false);
			expect(await isApprovedCandidateSource(path.join(symlinkRoot, "src/index.ts"), release)).toBe(false);
			expect(await isApprovedCandidateSource(path.join(noManifestRoot, "index.ts"), release)).toBe(false);
		} finally {
			await fs.rm(repositoryRoot, { recursive: true, force: true });
		}
	});

	it("parses an exact self-bound release record and rejects protected drift", () => {
		const contentManifest = trackedContentManifest();
		const combinedPromptBehaviorSha256 = sha256(
			canonicalJson({
				behaviorSha256: contentManifest.behaviorSha256,
				contentManifestRootSha256: contentManifest.rootSha256,
			}),
		);
		const releasePayload = {
			schema: "omp.context_release_manifest.v1" as const,
			repository: "Smarty-Pants-Inc/oh-my-pi",
			commit: "a".repeat(40),
			tree: "b".repeat(40),
			candidates: [
				{
					repository: "Smarty-Pants-Inc/oh-my-pi",
					baseCommit: "c".repeat(40),
					baseTree: "d".repeat(40),
					commit: "a".repeat(40),
					tree: "b".repeat(40),
					scopeCoverage: [
						{ path: "packages/a.ts", requirement: "§2.15" },
						{
							path: "packages/b.test.ts",
							dependencyOf: "packages/a.ts",
							necessity: "Runnable contract proof.",
						},
					],
				},
			],
			contentManifest,
			contentManifestRootSha256: contentManifest.rootSha256,
			behaviorSha256: contentManifest.behaviorSha256,
			globalAgentsPath: "/home/test/.omp/agent/AGENTS.md",
			globalAgentsSha256: "c".repeat(64),
			globalAgentsSourceSha256: "c".repeat(64),
			configurationPath: "/home/test/.omp/agent/config.yml",
			configurationSourceSha256: "d".repeat(64),
			configurationSemanticSha256: "e".repeat(64),
			combinedPromptBehaviorSha256,
		};
		const release = {
			...releasePayload,
			rootSha256: sha256(canonicalJson(releasePayload as unknown as JsonValue)),
		};
		const { rootSha256, ...boundPayload } = release;
		expect(release.repository).toBe("Smarty-Pants-Inc/oh-my-pi");
		expect(release.contentManifest.rootSha256).toBe(release.contentManifestRootSha256);
		expect(release.contentManifest.providerMappings).toHaveLength(2);
		expect(rootSha256).toBe(sha256(canonicalJson(boundPayload as unknown as JsonValue)));
		expect(parseContextReleaseManifest(JSON.stringify(release))).toEqual(release);
		expect(() => parseContextReleaseManifest(JSON.stringify({ ...release, unknownProtectedField: "drift" }))).toThrow(
			"unknown or missing fields",
		);
		expect(() =>
			parseContextReleaseManifest(
				JSON.stringify({
					...release,
					contentManifest: { ...release.contentManifest, providerMappings: [] },
				}),
			),
		).toThrow();
		const candidate = release.candidates[0]!;
		for (const scopeCoverage of [
			[candidate.scopeCoverage[0], candidate.scopeCoverage[0]],
			[...candidate.scopeCoverage].reverse(),
			[{ ...candidate.scopeCoverage[0], unknown: true }],
		]) {
			expect(() =>
				parseContextReleaseManifest(JSON.stringify({ ...release, candidates: [{ ...candidate, scopeCoverage }] })),
			).toThrow();
		}
		expect(() => validateScopeCoverage(["packages/a.ts", "packages/b.ts"], [candidate.scopeCoverage[0]])).toThrow(
			"missing=packages/b.ts",
		);
		expect(() =>
			validateScopeCoverage(
				["packages/a.ts"],
				[candidate.scopeCoverage[0], { path: "packages/extra.ts", requirement: "§2.15" }],
			),
		).toThrow("extra=packages/extra.ts");
		expect(() => validateScopeCoverage(["packages/a.ts"], [{ path: "packages/a.ts", requirement: "§23" }])).toThrow(
			"exact specification section or item",
		);
		expect(() =>
			validateScopeCoverage(
				["packages/a.ts"],
				[{ path: "packages/a.ts", dependencyOf: "packages/missing.ts", necessity: "Circular convenience." }],
			),
		).toThrow("directly mapped path in the same set");
		expect(() =>
			validateScopeCoverage(
				["packages/a.ts"],
				[{ path: "packages/a.ts", dependencyOf: "packages/a.ts", necessity: "Self dependency." }],
			),
		).toThrow("must not reference itself");
		expect(() =>
			validateScopeCoverage(
				["packages/a.ts", "packages/b.ts"],
				[
					{ path: "packages/a.ts", dependencyOf: "packages/b.ts", necessity: "Cycle half one." },
					{ path: "packages/b.ts", dependencyOf: "packages/a.ts", necessity: "Cycle half two." },
				],
			),
		).toThrow("directly mapped path in the same set");
	});

	it("is deterministic and matches live prompt, behavior, and tool contracts", async () => {
		const packageRoot = path.resolve(import.meta.dir, "../..");
		const result = Bun.spawnSync(["bun", "scripts/generate-prompt-manifest.ts", "--check"], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect((await assertTrackedManifestCurrent()).rootSha256).toBe(trackedContentManifest().rootSha256);
		const manifest = trackedContentManifest();
		const toolIds = manifest.toolSchemas.map(tool => tool.id);
		expect(toolIds).toContain("tool.ask");
		for (const fixedRuntimeTool of [
			"tool.generate_image",
			"tool.tts",
			"tool.vibe_kill",
			"tool.vibe_list",
			"tool.vibe_send",
			"tool.vibe_spawn",
			"tool.vibe_wait",
		]) {
			expect(toolIds).toContain(fixedRuntimeTool);
		}
		expect(manifest.prompts.map(prompt => prompt.path)).toContain(
			"packages/agent/src/compaction/prompts/summarization-system.md",
		);
		expect(manifest.implementationSources.some(entry => entry.path === "packages/agent/src/agent-loop.ts")).toBe(
			true,
		);
		expect(manifest.implementationSources.some(entry => entry.path === "packages/ai/src/utils/schema/wire.ts")).toBe(
			true,
		);
		expect(manifest.implementationSources.some(entry => entry.path === "packages/ai/src/utils.ts")).toBe(true);
		for (const liveProviderInput of [
			"packages/agent/src/replay-policy.ts",
			"packages/catalog/src/compat/openai.ts",
			"packages/coding-agent/src/session/messages.ts",
		]) {
			expect(manifest.implementationSources.some(entry => entry.path === liveProviderInput)).toBe(true);
		}
		expect(
			manifest.implementationSources.some(entry => entry.path === "packages/ai/src/providers/openai-responses.ts"),
		).toBe(true);
		expect(
			manifest.implementationSources.some(
				entry => entry.path === "packages/coding-agent/src/session/agent-session.ts",
			),
		).toBe(true);
		expect(
			manifest.implementationSources.some(
				entry => entry.path === "packages/coding-agent/src/config/inline-tool-descriptors-mode.ts",
			),
		).toBe(true);
		expect(
			manifest.implementationSources.some(
				entry => entry.path === "packages/coding-agent/src/session/session-handoff.ts",
			),
		).toBe(true);
		expect(
			manifest.prompts.find(entry => entry.id === "agent.compaction.prompts.compaction-summary")?.target,
		).toEqual(["side_model"]);
	});

	it("binds and classifies every checked model-visible transformer", async () => {
		const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
		const sources = await computeImplementationSources(repositoryRoot);
		const paths = new Set(sources.map(source => source.path));
		const promptPaths = new Set(trackedContentManifest().prompts.map(prompt => prompt.path));
		for (const required of [
			"docs/approval-mode.md",
			"crates/pi-natives/src/shell.rs",
			"crates/pi-natives/src/fonts/Silver.ttf",
			"crates/pi-shell/src/minimizer/engine.rs",
			"crates/pi-shell/src/minimizer/defs/biome.toml",
			"packages/agent/src/compaction.ts",
			"packages/agent/src/proxy.ts",
			"packages/agent/src/telemetry.ts",
			"packages/ai/src/auth-storage.ts",
			"packages/ai/src/dialect/anthropic.md",
			"packages/ai/src/providers/google-antigravity-forced-tool.md",
			"packages/ai/src/utils/tool-call-loop-guard.ts",
			"packages/ai/src/usage/openai-codex-reset.ts",
			"packages/catalog/src/discovery/cursor-proto.ts",
			"packages/catalog/src/discovery/devin-proto.ts",
			"packages/catalog/src/discovery/protobuf.ts",
			"packages/catalog/src/provider-models/descriptors.ts",
			"packages/catalog/src/wire/codex.ts",
			"packages/hashline/src/prompt.md",
			"packages/mnemopi/src/core/beam/recall.ts",
			"packages/mnemopi/src/core/memory.ts",
			"packages/natives/native/desktop.js",
			"packages/snapcompact/src/prompts/snapcompact-summary.md",
			"packages/utils/src/acp/connection.ts",
			"packages/utils/src/cli.ts",
			"packages/utils/src/fetch-retry.ts",
			"packages/utils/src/runtime-install.ts",
			"packages/utils/src/tls-fetch.ts",
			"packages/utils/src/turndown/service.ts",
			"packages/coding-agent/src/discovery/agents-md.ts",
			"packages/coding-agent/src/eval/completion-bridge.ts",
			"packages/coding-agent/src/export/ttsr.ts",
			"packages/coding-agent/src/extensibility/plugins/loader.ts",
			"packages/coding-agent/src/extensibility/extensions/runner.ts",
			"packages/coding-agent/src/extensibility/extensions/wrapper.ts",
			"packages/coding-agent/src/extensibility/skills.ts",
			"packages/coding-agent/src/goals/runtime.ts",
			"packages/coding-agent/src/mcp/client.ts",
			"packages/coding-agent/src/mcp/tool-cache.ts",
			"packages/coding-agent/src/live/protocol.ts",
			"packages/coding-agent/src/modes/acp/acp-agent.ts",
			"packages/coding-agent/src/modes/components/agent-transcript-viewer.ts",
			"packages/coding-agent/src/modes/components/extensions/types.ts",
			"packages/coding-agent/src/modes/components/settings-defs.ts",
			"packages/coding-agent/src/modes/components/hook-input.ts",
			"packages/coding-agent/src/modes/components/session-selector.ts",
			"packages/coding-agent/src/modes/components/extensions/state-manager.ts",
			"packages/coding-agent/src/modes/components/plan-review-overlay.ts",
			"packages/coding-agent/src/modes/components/settings-selector.ts",
			"packages/coding-agent/src/modes/controllers/live-command-controller.ts",
			"packages/coding-agent/src/modes/fresh-omp-companion-wire.ts",
			"packages/coding-agent/src/modes/rpc/rpc-mode.ts",
			"packages/coding-agent/src/modes/utils/context-usage.ts",
			"packages/coding-agent/src/modes/utils/ui-helpers.ts",
			"packages/coding-agent/src/modes/skill-command.ts",
			"packages/coding-agent/src/secrets/obfuscator.ts",
			"packages/coding-agent/src/session/async-job-delivery.ts",
			"packages/coding-agent/src/session/provider-image-budget.ts",
			"packages/coding-agent/src/session/session-context.ts",
			"packages/coding-agent/src/session/session-stats.ts",
			"packages/coding-agent/src/session/settings-stream-fn.ts",
			"packages/coding-agent/src/session/todo-tracker.ts",
			"packages/coding-agent/src/stt/asr-worker.ts",
			"packages/coding-agent/src/stt/stt-controller.ts",
			"packages/coding-agent/src/tiny/worker.ts",
			"packages/coding-agent/src/tts/speech-enhancer.ts",
			"packages/coding-agent/src/utils/image-loading.ts",
			"packages/coding-agent/src/utils/mac-file-urls.applescript",
			"packages/coding-agent/src/utils/shell-snapshot-fn-env.sh",
			"packages/coding-agent/src/cli.ts",
			"packages/coding-agent/src/cli/flag-tables.ts",
			"packages/coding-agent/src/cli/plugin-cli.ts",
			"packages/coding-agent/src/cli/session-picker.ts",
			"packages/coding-agent/src/commands/setup.ts",
			"packages/coding-agent/src/commands/launch.ts",
			"packages/coding-agent/src/slash-commands/helpers/mcp.ts",
			"packages/natives/native/loader-state.js",
			"packages/utils/src/version.ts",
			"crates/pi-natives/src/power.rs",
		]) {
			expect(paths.has(required), `missing model-visible implementation source: ${required}`).toBe(true);
		}
		for (const source of sources) {
			expect(
				classifyProtectedPath(source.path).length,
				`unclassified model-visible implementation source: ${source.path}`,
			).toBeGreaterThan(0);
			if (!source.path.endsWith(".ts")) continue;
			const sourceText = await Bun.file(path.join(repositoryRoot, source.path)).text();
			for (const match of sourceText.matchAll(
				/from\s+["']([^"']+\.(?:lark|md))["']\s+with\s*\{\s*type:\s*["']text["']\s*\}/g,
			)) {
				const importedPath = match[1];
				if (!importedPath?.startsWith(".")) continue;
				const resolved = path
					.relative(repositoryRoot, path.resolve(repositoryRoot, path.dirname(source.path), importedPath))
					.replaceAll(path.sep, "/");
				expect(
					paths.has(resolved) || promptPaths.has(resolved),
					`unbound Markdown imported by model-visible source ${source.path}: ${resolved}`,
				).toBe(true);
			}
			for (const match of sourceText.matchAll(
				/from\s+["']([^"']+\.json)["']\s+with\s*\{\s*type:\s*["']json["']\s*\}/g,
			)) {
				const importedPath = match[1];
				if (!importedPath?.startsWith(".")) continue;
				const resolved = path
					.relative(repositoryRoot, path.resolve(repositoryRoot, path.dirname(source.path), importedPath))
					.replaceAll(path.sep, "/");
				expect(
					paths.has(resolved),
					`unbound JSON imported by model-visible source ${source.path}: ${resolved}`,
				).toBe(true);
			}
		}

		for (const excluded of [
			"packages/coding-agent/src/capability/types.ts",
			"packages/coding-agent/src/cleanse/types.ts",
			"packages/coding-agent/src/config/keybindings.ts",
			"packages/coding-agent/src/dap/types.ts",
			"packages/coding-agent/src/eval/types.ts",
			"packages/coding-agent/src/extensibility/custom-tools/types.ts",
			"packages/coding-agent/src/internal-urls/types.ts",
			"packages/coding-agent/src/markit/types.ts",
			"packages/coding-agent/src/plan-mode/state.ts",
			"packages/coding-agent/src/stt/asr-protocol.ts",
			"packages/coding-agent/src/tools/renderers.ts",
			"packages/coding-agent/src/utils/changelog.ts",
		]) {
			expect(paths.has(excluded), `type-only source entered protected implementation inventory: ${excluded}`).toBe(
				false,
			);
			expect(classifyProtectedPath(excluded)).toEqual([]);
		}

		for (const sourceRoot of ["packages/agent/src", "packages/ai/src", "packages/coding-agent/src"]) {
			for await (const relativePath of new Bun.Glob("**/*.ts").scan({
				cwd: path.join(repositoryRoot, sourceRoot),
			})) {
				const sourcePath = `${sourceRoot}/${relativePath}`;
				const sourceText = await Bun.file(path.join(repositoryRoot, sourcePath)).text();
				const importsModelCaller = [
					...sourceText.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["']/g),
				].some(match =>
					/\b(?:Agent|completeSimple|instrumentedCompleteSimple|streamSimple)\b/.test(match[1] ?? ""),
				);
				const callsModel = /\b(?:new\s+Agent|completeSimple|instrumentedCompleteSimple|streamSimple)\s*\(/.test(
					sourceText,
				);
				if (importsModelCaller && callsModel) {
					expect(
						paths.has(sourcePath),
						`model request producer is absent from implementation inventory: ${sourcePath}`,
					).toBe(true);
				}
			}
		}
	});

	it("follows executable imports but not type-only or barrel-only edges", async () => {
		expect(
			runtimeImportSpecifiersForImplementationSource(`
				import type { TypeOnly } from "./type-only";
				import { type MixedType, runtimeValue } from "./runtime";
				export { redirected } from "./barrel-only";
				export type { ExportedType } from "./exported-type";
				const deferred = import("./dynamic");
				void runtimeValue;
				void deferred;
			`),
		).toEqual(["./runtime", "./dynamic"]);

		const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
		const paths = new Set((await computeImplementationSources(repositoryRoot)).map(source => source.path));
		expect(paths.has("packages/coding-agent/src/cleanse/checkers.ts")).toBe(true);
		expect(paths.has("packages/coding-agent/src/config/model-roles.ts")).toBe(true);
		expect(paths.has("packages/coding-agent/src/extensibility/custom-tools/types.ts")).toBe(false);
		expect(paths.has("packages/ai/src/usage.ts")).toBe(true);
		expect(paths.has("packages/ai/src/usage/cursor.ts")).toBe(true);
		expect(paths.has("packages/mnemopi/src/core/beam/types.ts")).toBe(false);
		expect(paths.has("packages/mnemopi/src/diagnose.ts")).toBe(false);
		expect(paths.has("packages/ai/src/providers/google-types.ts")).toBe(false);
		expect(paths.has("packages/coding-agent/src/tiny/title-protocol.ts")).toBe(false);
		expect(paths.has("packages/ai/src/dialect/types.ts")).toBe(false);
		expect(paths.has("packages/hashline/src/types.ts")).toBe(false);
		expect(paths.has("packages/coding-agent/generated/prompt-manifest.json")).toBe(false);
		expect(paths.has("packages/coding-agent/generated/tool-contracts.json")).toBe(true);
		expect(paths.has("packages/coding-agent/scripts/generate-prompt-manifest.ts")).toBe(false);
		expect(classifyProtectedPath("packages/coding-agent/scripts/generate-prompt-manifest.ts")).toEqual([
			{
				path: "packages/coding-agent/scripts/generate-prompt-manifest.ts",
				surface: "guard",
				kind: "changed",
			},
		]);
		expect(paths.has("packages/coding-agent/src/context/implementation-sources.ts")).toBe(true);
		expect(paths.has("packages/coding-agent/src/context/manifest.ts")).toBe(true);
		expect(paths.has("packages/utils/src/stderr-guard.ts")).toBe(false);
		expect(paths.has("packages/utils/src/process-name.ts")).toBe(false);
		expect(paths.has("packages/utils/src/color.ts")).toBe(false);
	});

	it("fails closed over new executable relative imports while bounding type and barrel edges", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-implementation-sources-"));
		const sourceRoot = path.join(repositoryRoot, "packages/agent/src");
		const runtimeRoot = path.join(repositoryRoot, "packages/runtime");
		await Promise.all([
			fs.mkdir(sourceRoot, { recursive: true }),
			fs.mkdir(path.join(runtimeRoot, "src"), { recursive: true }),
		]);
		try {
			await Promise.all([
				Bun.write(
					path.join(sourceRoot, "agent.ts"),
					'import type { TypeOnly } from "./type-only";\nimport { runtime } from "./runtime";\nimport { native } from "./native.js";\nimport { engine } from "@test/runtime/engine";\nexport { barrelOnly } from "./barrel-only";\nvoid runtime;\nvoid native;\nvoid engine;\n',
				),
				Bun.write(path.join(sourceRoot, "runtime.ts"), 'export const runtime = import("./dynamic");\n'),
				Bun.write(path.join(sourceRoot, "dynamic.ts"), "export const dynamic = true;\n"),
				Bun.write(path.join(sourceRoot, "native.js"), 'export const native = import("./nested-js");\n'),
				Bun.write(path.join(sourceRoot, "nested-js.js"), "export const nested = true;\n"),
				Bun.write(path.join(sourceRoot, "type-only.ts"), "export interface TypeOnly { value: string }\n"),
				Bun.write(path.join(sourceRoot, "barrel-only.ts"), "export const barrelOnly = true;\n"),
				Bun.write(
					path.join(runtimeRoot, "package.json"),
					JSON.stringify({ name: "@test/runtime", exports: { "./*": { import: "./src/*.ts" } } }),
				),
				Bun.write(path.join(runtimeRoot, "src/engine.ts"), 'export const engine = import("./nested");\n'),
				Bun.write(path.join(runtimeRoot, "src/nested.ts"), "export const nested = true;\n"),
			]);
			const paths = (await computeImplementationSources(repositoryRoot)).map(source => source.path);
			expect(paths).toEqual([
				"packages/agent/src/agent.ts",
				"packages/agent/src/dynamic.ts",
				"packages/agent/src/native.js",
				"packages/agent/src/nested-js.js",
				"packages/agent/src/runtime.ts",
				"packages/runtime/src/engine.ts",
				"packages/runtime/src/nested.ts",
			]);
		} finally {
			await fs.rm(repositoryRoot, { recursive: true, force: true });
		}
	});

	it("hashes implementation sources as exact bytes", async () => {
		const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-implementation-source-bytes-"));
		const fontPath = path.join(repositoryRoot, "crates/pi-natives/src/fonts/Silver.ttf");
		const firstBytes = new Uint8Array([0x80]);
		const secondBytes = new Uint8Array([0x81]);
		try {
			await Promise.all([
				fs.mkdir(path.join(repositoryRoot, "packages/agent/src"), { recursive: true }),
				fs.mkdir(path.dirname(fontPath), { recursive: true }),
			]);
			await Promise.all([
				Bun.write(path.join(repositoryRoot, "packages/agent/src/agent.ts"), "export {};\n"),
				Bun.write(fontPath, firstBytes),
			]);
			expect(new TextDecoder().decode(firstBytes)).toBe(new TextDecoder().decode(secondBytes));
			const firstHash = (await computeImplementationSources(repositoryRoot)).find(
				source => source.path === "crates/pi-natives/src/fonts/Silver.ttf",
			)?.sha256;

			await Bun.write(fontPath, secondBytes);
			const secondHash = (await computeImplementationSources(repositoryRoot)).find(
				source => source.path === "crates/pi-natives/src/fonts/Silver.ttf",
			)?.sha256;

			expect(firstHash).toBe(sha256(firstBytes));
			expect(secondHash).toBe(sha256(secondBytes));
			expect(secondHash).not.toBe(firstHash);
		} finally {
			await fs.rm(repositoryRoot, { recursive: true, force: true });
		}
	});

	it("requires normalized Unicode code-point-sorted implementation paths", () => {
		const manifest = trackedContentManifest();
		const hostile = [
			"packages/agent/src/compaction/prefix.ts",
			"packages/agent/src/compaction/prefix/a.ts",
			"packages/agent/src/compaction/A.ts",
			"packages/agent/src/compaction/a.ts",
			"packages/agent/src/compaction/\u{e000}.ts",
			"packages/agent/src/compaction/\u{1f600}.ts",
		]
			.sort(compareUnicodeCodePoints)
			.map((sourcePath, index) => ({ path: sourcePath, sha256: index.toString(16).padStart(64, "0") }));
		const validPayload = { ...manifest, implementationSources: hostile };
		const { rootSha256: _validRoot, ...validWithoutRoot } = validPayload;
		expect(
			parseContentManifest(
				JSON.stringify({
					...validWithoutRoot,
					rootSha256: sha256(canonicalJson(validWithoutRoot as unknown as JsonValue)),
				}),
			).implementationSources,
		).toEqual(hostile);
		const invalidPaths = [
			[],
			[...hostile].reverse(),
			[{ path: "packages/agent/./src/compaction/x.ts", sha256: "c".repeat(64) }],
			[{ path: "packages/agent/src/compaction/x.ts", sha256: "C".repeat(64) }],
			[
				{ path: "packages/agent/src/compaction/x.ts", sha256: "c".repeat(64) },
				{ path: "packages/agent/src/compaction/x.ts", sha256: "d".repeat(64) },
			],
		];
		for (const implementationSources of invalidPaths) {
			const payload = { ...manifest, implementationSources };
			const { rootSha256: _root, ...withoutRoot } = payload;
			expect(() =>
				parseContentManifest(
					JSON.stringify({
						...withoutRoot,
						rootSha256: sha256(canonicalJson(withoutRoot as unknown as JsonValue)),
					}),
				),
			).toThrow();
		}
	});

	it("rejects mutated generated tool contract structure and values", async () => {
		const source = await Bun.file(new URL("../../generated/tool-contracts.json", import.meta.url)).text();
		const contracts = JSON.parse(source) as Record<string, unknown>;
		expect(() => parseGeneratedToolContracts(JSON.stringify({ ...contracts, extra: true }))).toThrow();
		const tools = contracts.tools as Array<Record<string, unknown>>;
		expect(() =>
			parseGeneratedToolContracts(
				JSON.stringify({ ...contracts, tools: [{ ...tools[0], description: "mutated" }, ...tools.slice(1)] }),
			),
		).toThrow("root does not match");
	});

	it("exports hashes from exact final provider-rendered tool contracts", () => {
		const binding = {
			contentManifestRootSha256: "a".repeat(64),
			configurationSemanticSha256: "b".repeat(64),
		};
		const payload = {
			tools: [
				{
					type: "function",
					function: {
						name: "write",
						description: "",
						parameters: { type: "object", properties: { i: { type: "string" } }, required: ["i"] },
					},
				},
			],
		};
		const exported = exportRenderedToolContracts(payload, { provider: "openai", id: "gpt-test" }, binding);
		expect(exported).toMatchObject({
			schema: "omp.rendered_tool_contracts.v1",
			provider: "openai",
			model: "gpt-test",
			...binding,
			tools: [{ id: "tool.write", description: "" }],
		});
		expect(exported.tools[0]?.descriptionSha256).toBe(sha256(""));
		expect(exported.tools[0]?.schemaSha256).toBe(
			sha256(canonicalJson({ type: "object", properties: { i: { type: "string" } }, required: ["i"] })),
		);
		const { rootSha256, ...rootPayload } = exported;
		expect(rootSha256).toBe(sha256(canonicalJson(rootPayload as unknown as JsonValue)));

		const transformed = structuredClone(payload);
		transformed.tools[0]!.function.description = "provider/model transform drift";
		expect(
			exportRenderedToolContracts(transformed, { provider: "openai", id: "gpt-test" }, binding).rootSha256,
		).not.toBe(exported.rootSha256);
		expect(
			exportRenderedToolContracts(payload, { provider: "openai", id: "gpt-other" }, binding).rootSha256,
		).not.toBe(exported.rootSha256);
		expect(
			exportRenderedToolContracts(
				payload,
				{ provider: "openai", id: "gpt-test" },
				{
					...binding,
					configurationSemanticSha256: "c".repeat(64),
				},
			).rootSha256,
		).not.toBe(exported.rootSha256);
		expect(() =>
			exportRenderedToolContracts(
				payload,
				{ provider: "openai", id: "gpt-test" },
				{
					...binding,
					contentManifestRootSha256: "not-a-hash",
				},
			),
		).toThrow("lowercase SHA-256");
	});

	it("uses a self-excluding canonical root", () => {
		const manifest = trackedContentManifest();
		const { rootSha256, ...payload } = manifest;
		expect(rootSha256).toBe(sha256(canonicalJson(payload as unknown as JsonValue)));
	});
});
