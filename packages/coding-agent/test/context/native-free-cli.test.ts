import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repository = path.resolve(import.meta.dir, "../../../..");
const cliEntry = path.join(repository, "packages/coding-agent/src/cli.ts");
const blockNativeImport = path.join(import.meta.dir, "../fixtures/block-native-import.ts");
let home = "";
let processIndex = 0;

interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runCli(args: string[], blockNative: boolean, cwd = repository): Promise<CliResult> {
	const command = ["/usr/bin/env", Bun.which("bun") ?? process.execPath];
	if (blockNative) command.push("--preload", blockNativeImport);
	command.push(cliEntry, ...args);
	const index = processIndex++;
	const stdoutPath = path.join(home, `stdout-${index}`);
	const stderrPath = path.join(home, `stderr-${index}`);
	const child = Bun.spawnSync(command, {
		cwd,
		env: {
			...Bun.env,
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: path.join(home, ".omp/agent"),
			NO_COLOR: "1",
		},
		stdout: Bun.file(stdoutPath),
		stderr: Bun.file(stderrPath),
	});
	const [stdout, stderr] = await Promise.all([Bun.file(stdoutPath).text(), Bun.file(stderrPath).text()]);
	return {
		exitCode: child.exitCode,
		stdout,
		stderr,
	};
}

async function runJson(args: string[], blockNative = true, cwd = repository): Promise<Record<string, unknown>> {
	const result = await runCli(args, blockNative, cwd);
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout.length, JSON.stringify(result)).toBeGreaterThan(0);
	return JSON.parse(result.stdout) as Record<string, unknown>;
}

beforeAll(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-free-context-"));
	const agentDir = path.join(home, ".omp/agent");
	await fs.mkdir(agentDir, { recursive: true });
	await Promise.all([
		fs.writeFile(path.join(agentDir, "AGENTS.md"), "native-free global instructions\n"),
		fs.writeFile(path.join(agentDir, "config.yml"), "{}\n"),
		fs.writeFile(path.join(agentDir, "mcp.json"), '{"mcpServers":{"fixture":{"command":"fixture"}}}\n'),
		...(["mergify-config", "mergify-merge-queue", "mergify-merge-protections"] as const).map(async name => {
			const skillDir = path.join(home, ".agents/skills", name);
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${name}\n`);
		}),
	]);
});

afterAll(async () => {
	await fs.rm(home, { recursive: true, force: true });
});

describe("native-free context CLI", () => {
	it("runs every offline context command without resolving the native package", async () => {
		const manifest = await runJson(["context", "manifest", "--json"]);
		const diff = await runJson(["context", "diff", "--base", "HEAD^", "--target", "HEAD", "--json"]);
		const protectedDelta = await runJson([
			"context",
			"protected-delta",
			"--repository",
			repository,
			"--base",
			"HEAD^",
			"--target",
			"HEAD",
			"--json",
		]);
		const explain = await runJson([
			"context",
			"explain",
			"--target",
			"main",
			"--provider",
			"openai",
			"--model",
			"gpt-5.6",
			"--json",
		]);

		expect(manifest.schema).toBe("omp.context_release_manifest.v1");
		expect(diff.schema).toBe("omp.context_diff.v1");
		expect(protectedDelta.schema).toBe("smarty.protected_delta.v1");
		expect(explain.schema).toBe("omp.context_explain.v1");
		const internalContext = (explain.components as Array<Record<string, unknown>>).find(
			component => component.semanticRole === "internal_context",
		);
		expect(internalContext?.actualRole).toBe("developer");
	}, 30_000);

	it("keeps explain component provenance and wire order identical to the normal path", async () => {
		const args = ["context", "explain", "--target", "main", "--provider", "openai", "--model", "gpt-5.6", "--json"];
		const normal = await runJson(args, false);
		const nativeFree = await runJson(args);
		const normalComponents = normal.components as Array<Record<string, unknown>>;
		const componentIds = normalComponents.map(component => component.id);

		expect(nativeFree.components).toEqual(normalComponents);
		expect(componentIds).toContain("mcp-xdev-guidance");
		expect(componentIds).toContain("skill.smarty_mergify_policy");
		expect(componentIds.filter(id => String(id).startsWith("external.skill."))).toHaveLength(3);
		const mcpPotential = normalComponents.find(component => String(component.id).startsWith("external.mcp.config."));
		expect(mcpPotential).toMatchObject({
			kind: "data",
			triggered: false,
			effective: false,
			availability: "unavailable",
			providerOrder: null,
		});
		expect(normal.toolContracts).toMatchObject({ status: "unavailable" });
		expect(componentIds.some(id => String(id).startsWith("implementation.packages/agent/src/compaction/"))).toBe(
			true,
		);
		expect(componentIds).toContain("implementation.packages/ai/src/utils/schema/wire.ts");
		expect(normalComponents.find(component => component.id === "tool.ask")).toMatchObject({
			triggered: false,
			effective: false,
			availability: "unavailable",
			providerOrder: null,
		});
		expect(
			normalComponents.map(component => ({
				id: component.id,
				source: component.source,
				semanticRole: component.semanticRole,
				actualRole: component.actualRole,
				renderedWrapper: component.renderedWrapper,
				precedence: component.precedence,
				providerOrder: component.providerOrder,
			})),
		).toEqual(
			(nativeFree.components as Array<Record<string, unknown>>).map(component => ({
				id: component.id,
				source: component.source,
				semanticRole: component.semanticRole,
				actualRole: component.actualRole,
				renderedWrapper: component.renderedWrapper,
				precedence: component.precedence,
				providerOrder: component.providerOrder,
			})),
		);
	}, 30_000);

	it("fails closed when offline wire-role compatibility cannot be resolved exactly", async () => {
		const partial = await runCli(["context", "explain", "--provider", "openai", "--json"], true);
		expect(partial.exitCode).not.toBe(0);
		expect(partial.stderr).toContain("requires --provider and --model together");

		const unknown = await runCli(
			["context", "explain", "--provider", "openai", "--model", "not-a-bundled-model", "--json"],
			true,
		);
		expect(unknown.exitCode).not.toBe(0);
		expect(unknown.stderr).toContain("cannot resolve model openai/not-a-bundled-model");
	}, 30_000);

	it("separates runtime MCP text from configured potential and includes project .omp instructions", async () => {
		const project = path.join(home, "workspace/project");
		const projectOmp = path.join(project, ".omp");
		await fs.mkdir(projectOmp, { recursive: true });
		await fs.writeFile(path.join(projectOmp, "AGENTS.md"), "project omp instructions\n");
		const explainModule = path.join(repository, "packages/coding-agent/src/context/explain.ts");
		const registryModule = path.join(repository, "packages/coding-agent/src/context/registry.ts");
		const script = `
			import { explainContext } from ${JSON.stringify(explainModule)};
			import { bindRenderedInstruction } from ${JSON.stringify(registryModule)};
			const explanation = await explainContext({
				cwd: ${JSON.stringify(project)},
				target: "main",
				includeContent: true,
				provider: "openai",
				model: "runtime-evidence",
				wireModel: {
					provider: "openai",
					id: "runtime-evidence",
					api: "openai-responses",
					compat: { supportsDeveloperRole: false },
				},
				runtime: {
					instructions: [bindRenderedInstruction("goal.active", "exact active goal evidence")],
					selectedSkills: [{ name: "mergify-config", renderedText: "exact selected skill prompt", order: 7 }],
					mcpInstructions: [{ name: "fixture", source: "mcp://fixture", content: "exact returned instructions" }],
				},
			});
			process.stdout.write(JSON.stringify(explanation));
		`;
		const command = [
			"/usr/bin/env",
			Bun.which("bun") ?? process.execPath,
			"--preload",
			blockNativeImport,
			"-e",
			script,
		];
		const index = processIndex++;
		const stdoutPath = path.join(home, `stdout-${index}`);
		const stderrPath = path.join(home, `stderr-${index}`);
		const child = Bun.spawnSync(command, {
			cwd: project,
			env: { ...Bun.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, ".omp/agent") },
			stdout: Bun.file(stdoutPath),
			stderr: Bun.file(stderrPath),
		});
		const [stdout, stderr] = await Promise.all([Bun.file(stdoutPath).text(), Bun.file(stderrPath).text()]);
		expect(child.exitCode, stderr).toBe(0);
		const explanation = JSON.parse(stdout) as Record<string, unknown>;
		const components = explanation.components as Array<Record<string, unknown>>;
		const projectComponent = components.find(component => component.source === path.join(projectOmp, "AGENTS.md"));
		expect(projectComponent).toMatchObject({ triggered: true, effective: true, availability: "effective" });
		const activeGoal = components.find(component => component.id === "goal.active");
		expect(activeGoal).toMatchObject({
			actualRole: "system",
			content: expect.stringContaining("exact active goal evidence"),
			triggered: true,
			effective: true,
			availability: "effective",
		});
		const runtimeMcp = components.find(component => component.id === "external.mcp.fixture");
		expect(runtimeMcp).toMatchObject({
			source: "mcp://fixture",
			content: "exact returned instructions",
			triggered: true,
			effective: true,
			availability: "effective",
		});
		expect(typeof runtimeMcp?.providerOrder).toBe("number");
		const selectedSkill = components.find(component => component.id === "external.skill.mergify-config");
		expect(selectedSkill).toMatchObject({
			actualRole: "user",
			content: "exact selected skill prompt",
			triggered: true,
			effective: true,
			availability: "effective",
		});
		expect(typeof selectedSkill?.providerOrder).toBe("number");
		const potentialMcp = components.find(component =>
			String(component.id).startsWith("external.mcp.config.fixture."),
		);
		expect(potentialMcp).toMatchObject({ kind: "data", effective: false, providerOrder: null });
		expect(potentialMcp).not.toHaveProperty("content");
	}, 30_000);

	it("fails closed for a configured dynamic source that cannot be discovered", async () => {
		const configPath = path.join(home, ".omp/agent/config.yml");
		await fs.writeFile(configPath, `extensions:\n  - ${path.join(home, "missing-extension.ts")}\n`);
		try {
			const result = await runCli(
				["context", "explain", "--target", "main", "--provider", "openai", "--model", "gpt-5.6", "--json"],
				true,
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("configured extension is missing");
		} finally {
			await fs.writeFile(configPath, "{}\n");
		}
	}, 30_000);
});
