import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { canonicalJson, type JsonValue, sha256 } from "../../src/context/canonical";
import {
	activationStatePath,
	assertTrackedManifestCurrent,
	canonicalGithubRepository,
	parseContextReleaseManifest,
	trackedContentManifest,
} from "../../src/context/manifest";

describe("tracked context manifest", () => {
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
			candidates: [{ repository: "Smarty-Pants-Inc/oh-my-pi", commit: "a".repeat(40), tree: "b".repeat(40) }],
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
	});

	it("uses a self-excluding canonical root", () => {
		const manifest = trackedContentManifest();
		const { rootSha256, ...payload } = manifest;
		expect(rootSha256).toBe(sha256(canonicalJson(payload as unknown as JsonValue)));
	});
});
