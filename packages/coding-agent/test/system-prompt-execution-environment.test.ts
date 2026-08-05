import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";

const sourceRoot = "/local/isolation/worktree";
const remoteRoot = "/workspace";
const executionEnvironment = { sourceRoot, remoteRoot };

function baseOptions() {
	return {
		cwd: sourceRoot,
		resolvedCustomPrompt: "Base prompt",
		skills: [],
		rules: [],
		toolNames: [],
		activeRepoContext: null,
		includeWorkspaceTree: true,
		workspaceTree: {
			rootPath: sourceRoot,
			rendered: ".\n  - src/\n    - index.ts",
			truncated: false,
			totalLines: 3,
			agentsMdFiles: [`${sourceRoot}/src/AGENTS.md`, "/Users/example/.omp/AGENTS.md"],
		},
	};
}

describe("execution environment system prompt projection", () => {
	it("keeps discovery inputs local while rendering only the remote workspace namespace", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			...baseOptions(),
			executionEnvironment,
			additionalWorkspaceRoots: [`${sourceRoot}/packages/app`, "/Users/example/shared"],
			contextFiles: [
				{ path: `${sourceRoot}/AGENTS.md`, content: "Workspace-local instructions" },
				{ path: "/Users/example/.omp/AGENTS.md", content: "User-level instructions" },
			],
		});

		const rendered = systemPrompt.join("\n\n");
		expect(rendered).toContain("Workspace-local instructions");
		expect(rendered).toContain("User-level instructions");
		expect(rendered).toContain('<file path="/workspace/AGENTS.md">');
		expect(rendered).toContain("<file>\nUser-level instructions");
		expect(rendered).toContain("- /workspace/src/AGENTS.md");
		expect(rendered).toContain("- /workspace/packages/app");
		expect(rendered).toContain("current working directory is '/workspace'");
		expect(rendered).not.toContain(sourceRoot);
		expect(rendered).not.toContain("/Users/example/.omp/AGENTS.md");
		expect(rendered).not.toContain("/Users/example/shared");
	});

	it("fails closed when prompt content contains the exact local source root", async () => {
		await expect(
			buildSystemPrompt({
				...baseOptions(),
				executionEnvironment,
				contextFiles: [],
				resolvedAppendSystemPrompt: `Do not expose ${sourceRoot}`,
			}),
		).rejects.toThrow("Execution environment system prompt contains the local source root");
	});

	it("leaves ordinary local prompt paths unchanged without a binding", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			...baseOptions(),
			additionalWorkspaceRoots: [`${sourceRoot}/packages/app`],
			contextFiles: [{ path: `${sourceRoot}/AGENTS.md`, content: "Local instructions" }],
		});

		const rendered = systemPrompt.join("\n\n");
		expect(rendered).toContain(`<file path="${sourceRoot}/AGENTS.md">`);
		expect(rendered).toContain(`- ${sourceRoot}/src/AGENTS.md`);
		expect(rendered).toContain(`- ${sourceRoot}/packages/app`);
		expect(rendered).toContain(`current working directory is '${sourceRoot}'`);
		expect(rendered).not.toContain("<execution-environment>");
	});
});
