import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { canonicalJson, type JsonValue, sha256 } from "../../src/context/canonical";
import {
	activationStatePath,
	approvedCandidateSourceMatches,
	assertTrackedManifestCurrent,
	canonicalGithubRepository,
	parseContentManifest,
	parseContextReleaseManifest,
	trackedContentManifest,
} from "../../src/context/manifest";
import { exportRenderedToolContracts, parseGeneratedToolContracts } from "../../src/context/tool-contracts";

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

	it("binds extension additions to exact candidate identity and bytes", () => {
		const identity = { repository: "Smarty-Pants-Inc/oh-my-pi", commit: "a".repeat(40), tree: "b".repeat(40) };
		const release = { candidates: [identity] };
		expect(
			approvedCandidateSourceMatches(identity.repository, identity, "c".repeat(64), "c".repeat(64), release),
		).toBe(true);
		expect(
			approvedCandidateSourceMatches(identity.repository, identity, "c".repeat(64), "d".repeat(64), release),
		).toBe(false);
		expect(
			approvedCandidateSourceMatches("other/repository", identity, "c".repeat(64), "c".repeat(64), release),
		).toBe(false);
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
		const manifest = trackedContentManifest();
		const toolIds = manifest.toolSchemas.map(tool => tool.id);
		expect(toolIds).toContain("tool.ask");
		expect(toolIds).toContain("tool.capability_grant");
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

	it("requires normalized localeCompare-sorted implementation paths", () => {
		const manifest = trackedContentManifest();
		const nonAscii = [
			{ path: "packages/agent/src/compaction/é.ts", sha256: "a".repeat(64) },
			{ path: "packages/agent/src/compaction/z.ts", sha256: "b".repeat(64) },
		].sort((left, right) => left.path.localeCompare(right.path));
		const invalidPaths = [
			[],
			[...manifest.implementationSources, ...nonAscii]
				.sort((left, right) => left.path.localeCompare(right.path))
				.reverse(),
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
