import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalJson, type JsonValue, sha256 } from "../../src/context/canonical";
import { buildProtectedDeltaEvidence, diffManifestRoots, diffProtectedRepository } from "../../src/context/diff";

const identity = {
	repository: "Smarty-Pants-Inc/oh-my-pi",
	baseCommit: "a".repeat(40),
	baseTree: "b".repeat(40),
	headCommit: "c".repeat(40),
	headTree: "d".repeat(40),
};

describe("protected delta evidence", () => {
	it("does not classify an unchanged manifest across identical trees", async () => {
		const repository = await fs.mkdtemp(path.join(os.tmpdir(), "omp-protected-delta-"));
		const runGit = (...args: string[]): string => {
			const result = Bun.spawnSync(["git", ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
			return result.stdout.toString().trim();
		};
		try {
			runGit("init", "--quiet");
			runGit("config", "user.name", "OMP Test");
			runGit("config", "user.email", "omp-test@example.invalid");
			runGit("remote", "add", "origin", "https://github.com/Smarty-Pants-Inc/oh-my-pi.git");
			const manifestDirectory = path.join(repository, "packages/coding-agent/generated");
			await fs.mkdir(manifestDirectory, { recursive: true });
			await fs.copyFile(
				path.resolve(import.meta.dir, "../../generated/prompt-manifest.json"),
				path.join(manifestDirectory, "prompt-manifest.json"),
			);
			runGit("add", ".");
			runGit("commit", "--quiet", "-m", "base");
			const base = runGit("rev-parse", "HEAD");
			runGit("commit", "--quiet", "--allow-empty", "-m", "same tree");

			const evidence = await diffProtectedRepository({ repository, base, target: "HEAD" });
			expect(evidence.baseTree).toBe(evidence.headTree);
			expect(evidence.protectedDelta).toBe(false);
			expect(evidence.classifications).toEqual([]);
		} finally {
			await fs.rm(repository, { recursive: true, force: true });
		}
	});

	it("reports a missing pre-registry manifest as an explicit null root", () => {
		expect(diffManifestRoots(undefined, { rootSha256: "a".repeat(64) })).toEqual({
			baseRootSha256: null,
			targetRootSha256: "a".repeat(64),
			changed: true,
		});
	});

	it("binds immutable repository identity and classification into one canonical hash", () => {
		const evidence = buildProtectedDeltaEvidence({
			...identity,
			protectedDelta: true,
			classifications: [{ path: "AGENTS.md", surface: "instruction", kind: "changed" }],
		});
		const { classificationSha256, ...payload } = evidence;

		expect(evidence.schema).toBe("smarty.protected_delta.v1");
		expect(classificationSha256).toBe(sha256(canonicalJson(payload as unknown as JsonValue)));
	});

	it("changes the hash for identity or protected-surface mutations", () => {
		const ordinary = buildProtectedDeltaEvidence({
			...identity,
			protectedDelta: false,
			classifications: [],
		});
		const changedIdentity = buildProtectedDeltaEvidence({
			...identity,
			headTree: "e".repeat(40),
			protectedDelta: false,
			classifications: [],
		});
		const protectedChange = buildProtectedDeltaEvidence({
			...identity,
			protectedDelta: true,
			classifications: [{ path: "src/goals/runtime.ts", surface: "goal", kind: "changed" }],
		});

		expect(
			new Set([
				ordinary.classificationSha256,
				changedIdentity.classificationSha256,
				protectedChange.classificationSha256,
			]).size,
		).toBe(3);
	});
});
