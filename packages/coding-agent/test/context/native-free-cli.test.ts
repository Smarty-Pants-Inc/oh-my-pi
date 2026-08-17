import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registeredPromptSource } from "../../src/context/registry";

const repository = path.resolve(import.meta.dir, "../../../..");
const cliEntry = path.join(repository, "packages/coding-agent/src/cli.ts");
const blockNativeImport = path.join(import.meta.dir, "../fixtures/block-native-import.ts");
const frozenUpstream = "37eee71978951fccf66b21f7e3e2b74596ac9d74";
const frozenUpstreamUrl = "https://github.com/can1357/oh-my-pi.git";
let home = "";
let historyRepository = "";
let processIndex = 0;

interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function ensureFrozenUpstream(cwd: string): void {
	const hasUpstream = Bun.spawnSync(["git", "cat-file", "-e", `${frozenUpstream}^{commit}`], {
		cwd,
		stdout: "ignore",
		stderr: "ignore",
	});
	if (hasUpstream.exitCode === 0) return;
	const fetch = Bun.spawnSync(
		["git", "fetch", "--quiet", "--no-tags", "--depth=1", frozenUpstreamUrl, frozenUpstream],
		{
			cwd,
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	if (fetch.exitCode !== 0) throw new Error(fetch.stderr.toString());
}

function fixtureScopeCoverage(cwd: string): Array<{ path: string; requirement: string }> {
	ensureFrozenUpstream(cwd);
	const result = Bun.spawnSync(["git", "diff", "--name-only", "-z", frozenUpstream, "HEAD"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout
		.toString()
		.split("\0")
		.filter(Boolean)
		.sort()
		.map(changedPath => ({
			path: changedPath,
			requirement: "§8.6 test fixture for the required expanded candidate schema.",
		}));
}

async function writePolicyState(repositoryRoot: string, manifestModule: string): Promise<void> {
	const policyStatePath = path.join(home, ".omp/policy-state.json");
	const script = `
		import { buildContextReleaseManifest } from ${JSON.stringify(manifestModule)};
		const release = await buildContextReleaseManifest(${JSON.stringify(repositoryRoot)}, undefined, {
			scopeCoverage: ${JSON.stringify(fixtureScopeCoverage(repositoryRoot))},
		});
		process.stdout.write(JSON.stringify(release));
	`;
	const child = Bun.spawnSync(["/usr/bin/env", Bun.which("bun") ?? process.execPath, "-e", script], {
		cwd: repositoryRoot,
		env: {
			...Bun.env,
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: path.join(home, ".omp/agent"),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (child.exitCode !== 0) throw new Error(child.stderr.toString());
	await fs.writeFile(policyStatePath, child.stdout);
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

async function runPrintedLedgerCommand(line: string): Promise<Record<string, unknown>> {
	const [executable, ...args] = line.trim().split(/\s+/u);
	expect(executable).toBe("bun");
	expect(args[0]).toBe("packages/coding-agent/src/cli.ts");
	const baseIndex = args.indexOf("--base");
	expect(args[baseIndex + 1]).toBe(frozenUpstream);
	const index = processIndex++;
	const stdoutPath = path.join(home, `stdout-${index}`);
	const stderrPath = path.join(home, `stderr-${index}`);
	const child = Bun.spawnSync(["/usr/bin/env", Bun.which("bun") ?? process.execPath, ...args], {
		cwd: historyRepository,
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
	expect(child.exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as Record<string, unknown>;
}

beforeAll(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-free-context-"));
	historyRepository = path.join(home, "history-repository");
	const clone = Bun.spawnSync(["git", "clone", "--quiet", "--no-local", repository, historyRepository], {
		stdout: "ignore",
		stderr: "pipe",
	});
	if (clone.exitCode !== 0) throw new Error(clone.stderr.toString());
	await fs.symlink(path.join(repository, "node_modules"), path.join(historyRepository, "node_modules"));
	ensureFrozenUpstream(historyRepository);
	for (const args of [
		["remote", "set-url", "origin", "https://github.com/Smarty-Pants-Inc/oh-my-pi.git"],
		["config", "user.name", "OMP Test"],
		["config", "user.email", "omp-test@example.invalid"],
		["commit", "--quiet", "--allow-empty", "-m", "materialize parent for context diff"],
	]) {
		const result = Bun.spawnSync(["git", ...args], { cwd: historyRepository, stdout: "ignore", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	}
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
	await writePolicyState(repository, path.join(repository, "packages/coding-agent/src/context/manifest.ts"));
}, 30_000);

afterAll(async () => {
	await fs.rm(home, { recursive: true, force: true });
});

describe("native-free context CLI", () => {
	it("executes the context-delta commands printed in the patch ledger", async () => {
		const ledger = await fs.readFile(path.join(repository, "PATCH-LEDGER.md"), "utf8");
		const commands = ledger
			.split("\n")
			.filter(line => line.startsWith("bun packages/coding-agent/src/cli.ts context ") && line.includes("-delta"));
		expect(commands).toHaveLength(1);
		const diffCommand = ledger
			.split("\n")
			.find(line => line.startsWith("bun packages/coding-agent/src/cli.ts context diff "));
		expect(diffCommand).toBeDefined();

		const [diff, protectedDelta] = await Promise.all([
			runPrintedLedgerCommand(diffCommand!),
			runPrintedLedgerCommand(commands[0]!),
		]);
		expect(diff.schema).toBe("omp.context_diff.v1");
		expect(protectedDelta.schema).toBe("smarty.protected_delta.v1");
	}, 30_000);

	it("runs every offline context command without resolving the native package", async () => {
		const manifest = await runJson(["context", "manifest", "--json"]);
		const diff = await runJson(
			["context", "diff", "--base", "HEAD^", "--target", "HEAD", "--json"],
			true,
			historyRepository,
		);
		const protectedDelta = await runJson([
			"context",
			"protected-delta",
			"--repository",
			historyRepository,
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
		expect(diff.changed).toBe(false);
		expect(protectedDelta.schema).toBe("smarty.protected_delta.v1");
		expect(protectedDelta.protectedDelta).toBe(false);
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
		expect(normalComponents.find(component => component.id === "system.base")).toMatchObject({
			enabled: true,
			triggered: false,
			effective: false,
			availability: "available",
			providerOrder: null,
		});
		expect(normalComponents.every(component => component.providerOrder === null)).toBe(true);
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
					reasoning: true,
					compat: { supportsDeveloperRole: true },
				},
				runtime: {
					systemPromptBlocks: [
						"exact rendered base block\\nexact returned instructions",
						"project wrapper\\nproject omp instructions\\n",
						"   ",
					],
					instructions: [
						bindRenderedInstruction("todo.snapshot", "exact todo evidence"),
						bindRenderedInstruction("goal.active", "exact active goal evidence"),
					],
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
		const systemBlocks = components.filter(component => String(component.id).startsWith("runtime.system_prompt."));
		expect(systemBlocks).toEqual([
			expect.objectContaining({
				id: "runtime.system_prompt.0",
				content: "exact rendered base block\nexact returned instructions",
				actualRole: "developer",
				providerOrder: 0,
				effective: true,
			}),
			expect.objectContaining({
				id: "runtime.system_prompt.1",
				content: "project wrapper\nproject omp instructions\n",
				actualRole: "developer",
				providerOrder: 1,
				effective: true,
			}),
		]);
		const staticBase = components.find(component => component.id === "system.base");
		expect(staticBase).toMatchObject({
			content: registeredPromptSource("system.base"),
			triggered: false,
			effective: false,
			availability: "available",
			providerOrder: null,
		});
		const projectComponent = components.find(component => component.source === path.join(projectOmp, "AGENTS.md"));
		expect(projectComponent).toMatchObject({
			content: "project omp instructions\n",
			triggered: true,
			effective: false,
			availability: "available",
			providerOrder: null,
		});
		const globalComponent = components.find(
			component => component.source === path.join(home, ".omp/agent/AGENTS.md"),
		);
		expect(globalComponent).toMatchObject({
			content: "native-free global instructions\n",
			triggered: false,
			effective: false,
			availability: "available",
			providerOrder: null,
		});
		const activeGoal = components.find(component => component.id === "goal.active");
		expect(activeGoal).toMatchObject({
			actualRole: "developer",
			content: expect.stringContaining("exact active goal evidence"),
			triggered: true,
			effective: true,
			availability: "effective",
			providerOrder: 3,
		});
		const todo = components.find(component => component.id === "todo.snapshot");
		expect(todo).toMatchObject({ content: expect.stringContaining("exact todo evidence"), providerOrder: 2 });
		const runtimeMcp = components.find(component => component.id === "external.mcp.fixture");
		expect(runtimeMcp).toMatchObject({
			source: "mcp://fixture",
			content: "exact returned instructions",
			triggered: true,
			effective: false,
			availability: "available",
			providerOrder: null,
		});
		const selectedSkill = components.find(component => component.id === "external.skill.mergify-config");
		expect(selectedSkill).toMatchObject({
			actualRole: "user",
			content: "exact selected skill prompt",
			triggered: true,
			effective: true,
			availability: "effective",
			providerOrder: null,
		});
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
