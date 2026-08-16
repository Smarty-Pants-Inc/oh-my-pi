import { describe, expect, it } from "bun:test";
import { classifyProtectedPath, diffProtectedSurface, diffProtectedSurfaces } from "../../src/policy/protected-surface";

describe("protected surface path classification", () => {
	it("classifies protected paths and leaves ordinary implementation paths unblocked", () => {
		expect(classifyProtectedPath("packages/coding-agent/src/prompts/system.md")).toEqual([
			{ path: "packages/coding-agent/src/prompts/system.md", surface: "prompt-content", kind: "changed" },
		]);
		expect(classifyProtectedPath("packages/coding-agent/src/utils/format.ts")).toEqual([]);
		for (const unprotected of [
			"packages/ai/src/providers/google-types.ts",
			"packages/ai/src/dialect/types.ts",
			"packages/hashline/src/types.ts",
			"packages/coding-agent/src/capability/types.ts",
			"packages/coding-agent/src/stt/asr-protocol.ts",
			"packages/coding-agent/src/tiny/title-protocol.ts",
			"packages/coding-agent/src/slash-commands/helpers/format.ts",
			"packages/coding-agent/src/tools/renderers.ts",
			"packages/coding-agent/src/tools/gh-types.ts",
			"packages/coding-agent/src/utils/changelog.ts",
			"packages/mnemopi/src/diagnose.ts",
			"packages/utils/src/stderr-guard.ts",
		]) {
			expect(classifyProtectedPath(unprotected), `overclassified ordinary implementation: ${unprotected}`).toEqual(
				[],
			);
		}
	});

	it("normalizes separators before classifying paths", () => {
		expect(classifyProtectedPath(".\\packages\\coding-agent\\src\\task\\spawn-policy.ts")).toEqual([
			{ path: "packages/coding-agent/src/task/spawn-policy.ts", surface: "subagent", kind: "changed" },
			{ path: "packages/coding-agent/src/task/spawn-policy.ts", surface: "task", kind: "changed" },
		]);
	});

	it("keeps provider wrapper and tool description paths distinct", () => {
		expect(classifyProtectedPath("packages/coding-agent/src/providers/openai/wrapper.ts")).toEqual([
			{
				path: "packages/coding-agent/src/providers/openai/wrapper.ts",
				surface: "provider-mapping",
				kind: "changed",
			},
			{
				path: "packages/coding-agent/src/providers/openai/wrapper.ts",
				surface: "provider-wrapper",
				kind: "changed",
			},
		]);
		expect(classifyProtectedPath("packages/coding-agent/src/tools/bash-description.ts")).toEqual([
			{ path: "packages/coding-agent/src/tools/bash-description.ts", surface: "tool-description", kind: "changed" },
			{ path: "packages/coding-agent/src/tools/bash-description.ts", surface: "tool-schema", kind: "changed" },
		]);
	});

	it("classifies every nested compaction implementation path", () => {
		expect(classifyProtectedPath("packages/agent/src/compaction/pipeline/dispatch.ts")).toEqual([
			{
				path: "packages/agent/src/compaction/pipeline/dispatch.ts",
				surface: "provider-wrapper",
				kind: "changed",
			},
		]);
	});

	it("classifies live provider/tool transformation inventory paths", () => {
		expect(classifyProtectedPath("packages/ai/src/utils/schema/wire.ts").map(item => item.surface)).toEqual([
			"tool-schema",
		]);
		expect(classifyProtectedPath("packages/ai/src/context-instructions.ts").map(item => item.surface)).toEqual([
			"provider-mapping",
		]);
		expect(classifyProtectedPath("packages/ai/src/utils.ts").map(item => item.surface)).toEqual(["provider-wrapper"]);
		expect(classifyProtectedPath("packages/ai/src/auth-storage.ts").map(item => item.surface)).toEqual([
			"provider-mapping",
			"provider-wrapper",
		]);
		expect(classifyProtectedPath("packages/mnemopi/src/core/memory.ts").map(item => item.surface)).toEqual([
			"provider-wrapper",
		]);
		expect(classifyProtectedPath("crates/pi-shell/src/minimizer/engine.rs").map(item => item.surface)).toEqual([
			"provider-wrapper",
			"tool-schema",
		]);
		expect(classifyProtectedPath("packages/utils/src/acp/connection.ts").map(item => item.surface)).toEqual([
			"capability",
			"provider-wrapper",
			"tool-schema",
		]);
		expect(classifyProtectedPath("packages/coding-agent/src/export/ttsr.ts").map(item => item.surface)).toEqual([
			"automatic-turn",
			"behavior",
			"capability",
			"provider-wrapper",
		]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/modes/components/agent-transcript-viewer.ts").map(
				item => item.surface,
			),
		).toEqual(["capability", "provider-wrapper", "subagent"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/modes/components/plan-review-overlay.ts").map(
				item => item.surface,
			),
		).toEqual(["behavior", "prompt-content", "prompt-entry", "provider-wrapper"]);
		expect(classifyProtectedPath("packages/agent/src/replay-policy.ts").map(item => item.surface)).toEqual([
			"provider-wrapper",
		]);
		expect(classifyProtectedPath("packages/catalog/src/compat/openai.ts").map(item => item.surface)).toEqual([
			"provider-mapping",
		]);
		expect(classifyProtectedPath("packages/coding-agent/src/session/messages.ts").map(item => item.surface)).toEqual([
			"provider-wrapper",
		]);
		expect(classifyProtectedPath("packages/coding-agent/src/mcp/manager.ts").map(item => item.surface)).toEqual([
			"provider-wrapper",
			"tool-schema",
		]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/config/inline-tool-descriptors-mode.ts").map(
				item => item.surface,
			),
		).toEqual(["tool-schema"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/session/session-handoff.ts").map(item => item.surface),
		).toEqual(["provider-wrapper"]);
		expect(classifyProtectedPath("packages/catalog/src/identity/family.ts").map(item => item.surface)).toEqual([
			"provider-mapping",
		]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/context/implementation-sources.ts").map(item => item.surface),
		).toEqual(["guard"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/session/todo-tracker.ts").map(item => item.surface),
		).toEqual(["task", "todo"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/extensibility/extensions/wrapper.ts").map(
				item => item.surface,
			),
		).toEqual(["tool-schema"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/extensibility/extensions/runner.ts").map(
				item => item.surface,
			),
		).toEqual(["guard", "provider-wrapper"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/modes/skill-command.ts").map(item => item.surface),
		).toEqual(["provider-wrapper", "skill"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/modes/acp/acp-agent.ts").map(item => item.surface),
		).toEqual(["provider-wrapper", "skill"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/modes/rpc/host-tools.ts").map(item => item.surface),
		).toEqual(["provider-wrapper", "tool-schema"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/slash-commands/builtin-modes.ts").map(item => item.surface),
		).toEqual(["automatic-turn", "provider-wrapper"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/session/acp-permission-gate.ts").map(item => item.surface),
		).toEqual(["approval"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/session/retry-fallback-chains.ts").map(item => item.surface),
		).toEqual(["provider-mapping", "provider-wrapper"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/modes/controllers/todo-command-controller.ts").map(
				item => item.surface,
			),
		).toEqual(["provider-wrapper", "todo"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/modes/components/custom-editor.ts").map(item => item.surface),
		).toEqual(["capability", "provider-wrapper"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/slash-commands/helpers/todo.ts").map(item => item.surface),
		).toEqual(["provider-wrapper", "task", "todo"]);
		expect(classifyProtectedPath("packages/coding-agent/src/cli/plugin-cli.ts").map(item => item.surface)).toEqual([
			"capability",
			"configuration",
			"provider-mapping",
			"provider-wrapper",
			"skill",
			"tool-schema",
		]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/modes/components/hook-input.ts").map(item => item.surface),
		).toEqual(["approval", "automatic-turn", "goal", "prompt-entry", "prompt-trigger", "provider-wrapper"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/slash-commands/helpers/mcp.ts").map(item => item.surface),
		).toEqual(["capability", "configuration", "provider-wrapper", "tool-schema"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/modes/components/session-selector.ts").map(
				item => item.surface,
			),
		).toEqual(["automatic-turn", "behavior", "prompt-target", "provider-wrapper"]);
		expect(classifyProtectedPath("packages/agent/src/pause.ts").map(item => item.surface)).toEqual([
			"automatic-turn",
			"capability",
		]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/collab/local-transport.ts").map(item => item.surface),
		).toEqual(["approval", "automatic-turn", "prompt-entry", "prompt-target", "provider-wrapper", "subagent"]);
		expect(
			classifyProtectedPath("packages/coding-agent/src/modes/fresh-omp-companion-wire.ts").map(item => item.surface),
		).toEqual(["approval", "automatic-turn", "capability", "goal", "task", "todo"]);
		expect(classifyProtectedPath("packages/natives/native/loader-state.js").map(item => item.surface)).toEqual([
			"capability",
			"provider-wrapper",
			"tool-schema",
		]);
	});
});

describe("protected semantic manifest deltas", () => {
	it("classifies all prompt contract fields without depending on a prompt file path", () => {
		const result = diffProtectedSurface({
			before: {
				prompts: [
					{
						content: "old",
						visibility: "private",
						role: "assistant",
						target: "cli",
						trigger: "start",
						order: 1,
						default: false,
					},
				],
			},
			after: {
				prompts: [
					{
						content: "new",
						visibility: "shared",
						role: "system",
						target: "task",
						trigger: "turn",
						order: 2,
						default: true,
					},
				],
			},
		});

		expect(result.protectedDelta).toBe(true);
		expect(result.classifications.map(change => change.surface)).toEqual([
			"prompt-entry",
			"prompt-content",
			"prompt-default",
			"prompt-order",
			"prompt-role",
			"prompt-target",
			"prompt-trigger",
			"prompt-visibility",
		]);
	});

	it("detects prompt entries, provider mappings and wrappers, and tool contracts", () => {
		const result = diffProtectedSurface({
			before: {
				prompts: [],
				providers: { openai: { mapping: "old", wrapper: "fetch" } },
				tools: { bash: { description: "old", inputSchema: { type: "object" } } },
			},
			after: {
				prompts: [{ content: "new" }],
				providers: { openai: { mapping: "new", wrapper: "custom" } },
				tools: { bash: { description: "new", inputSchema: { type: "string" } } },
			},
		});

		expect(result.classifications.map(change => change.surface)).toEqual([
			"prompt-entry",
			"prompt-content",
			"provider-mapping",
			"provider-mapping",
			"provider-wrapper",
			"tool-description",
			"tool-schema",
		]);
	});

	it("protects implementation source and generated tool contract manifest fields", () => {
		const result = diffProtectedSurface({
			before: { implementationSources: [], toolSchemas: [] },
			after: {
				implementationSources: [{ path: "packages/agent/src/agent-loop.ts", sha256: "a" }],
				toolSchemas: [{ id: "tool.ask", descriptionSha256: "b", schemaSha256: "c" }],
			},
		});

		expect(new Set(result.classifications.map(change => change.surface))).toEqual(
			new Set(["provider-wrapper", "tool-description", "tool-schema"]),
		);
	});

	it("detects behavioral authority fields and does not block unrelated manifest metadata", () => {
		const protectedResult = diffProtectedSurface({
			before: {
				behavior: "manual",
				automaticTurns: false,
				goals: ["a"],
				todo: false,
				task: { enabled: false },
				subagents: ["reviewer"],
				approvals: "required",
				capabilities: ["read"],
			},
			after: {
				behavior: "automatic",
				automaticTurns: true,
				goals: ["b"],
				todo: true,
				task: { enabled: true },
				subagents: ["reviewer", "worker"],
				approvals: "none",
				capabilities: ["read", "write"],
			},
		});
		expect(protectedResult.classifications.map(change => change.surface)).toEqual([
			"approval",
			"automatic-turn",
			"behavior",
			"capability",
			"goal",
			"subagent",
			"task",
			"todo",
		]);

		expect(diffProtectedSurface({ before: { label: "before" }, after: { label: "after" } })).toEqual({
			protectedDelta: false,
			classifications: [],
		});
	});

	it("sorts and deduplicates batch output regardless of input order", () => {
		const reverse = diffProtectedSurfaces([
			{ path: "src/task/spawn-policy.ts" },
			{ before: { prompts: [] }, after: { prompts: [{ content: "x" }] } },
		]);
		const forward = diffProtectedSurfaces([
			{ before: { prompts: [] }, after: { prompts: [{ content: "x" }] } },
			{ path: "src/task/spawn-policy.ts" },
		]);

		expect(reverse).toEqual(forward);
		expect(reverse.classifications).toEqual([
			{ path: "prompts", surface: "prompt-entry", kind: "changed" },
			{ path: "prompts[0].content", surface: "prompt-content", kind: "added" },
			{ path: "src/task/spawn-policy.ts", surface: "subagent", kind: "changed" },
			{ path: "src/task/spawn-policy.ts", surface: "task", kind: "changed" },
		]);
	});

	it("covers shared instructions, configuration, skills, guards, tools, automatic turns, and capability seams", () => {
		expect(
			[
				"AGENTS.md",
				".agents/skills/review/SKILL.md",
				"packages/coding-agent/src/agent-behavior.yml",
				"packages/coding-agent/src/context/approved-policy.ts",
				"packages/coding-agent/src/tools/write.ts",
				"packages/coding-agent/src/session/agent-session.ts",
				"packages/coding-agent/src/session/stream-guards.ts",
				"packages/coding-agent/src/edit/index.ts",
				"packages/coding-agent/scripts/generate-prompt-manifest.ts",
			].map(path => classifyProtectedPath(path).map(item => item.surface)),
		).toEqual([
			["instruction"],
			["skill"],
			["behavior", "configuration"],
			["guard"],
			["tool-schema"],
			["automatic-turn"],
			["automatic-turn", "provider-wrapper"],
			["capability", "tool-schema"],
			["guard"],
		]);
	});
});
