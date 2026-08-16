import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalJson, type JsonValue, sha256 } from "../../src/context/canonical";

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const sourceRepository = path.resolve(import.meta.dir, "../../../..");
const bun = Bun.which("bun") ?? process.execPath;

async function run(command: string[], cwd: string, env?: Record<string, string | undefined>): Promise<CommandResult> {
	const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-context-command-"));
	const stdoutPath = path.join(outputDir, "stdout");
	const stderrPath = path.join(outputDir, "stderr");
	try {
		const child = Bun.spawnSync(command, {
			cwd,
			env: env ?? Bun.env,
			stdout: Bun.file(stdoutPath),
			stderr: Bun.file(stderrPath),
		});
		const [stdout, stderr] = await Promise.all([Bun.file(stdoutPath).text(), Bun.file(stderrPath).text()]);
		return { exitCode: child.exitCode, stdout, stderr };
	} finally {
		await fs.rm(outputDir, { recursive: true, force: true });
	}
}

async function requireSuccess(
	command: string[],
	cwd: string,
	env?: Record<string, string | undefined>,
): Promise<string> {
	const result = await run(command, cwd, env);
	if (result.exitCode !== 0) {
		throw new Error(`command failed (${result.exitCode}): ${command.join(" ")}\n${result.stderr}`);
	}
	return result.stdout;
}

describe("clean-checkout native-free context CLI", () => {
	it("works after a frozen forced install with no native artifact", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-clean-context-"));
		const checkout = path.join(tempRoot, "omp");
		const home = path.join(tempRoot, "home");
		try {
			await requireSuccess(["git", "clone", "--no-local", sourceRepository, checkout], sourceRepository);
			await requireSuccess(["git", "checkout", "--detach", "HEAD"], checkout);
			await requireSuccess(
				["git", "remote", "set-url", "origin", "https://github.com/Smarty-Pants-Inc/oh-my-pi.git"],
				checkout,
			);
			await requireSuccess([bun, "install", "--frozen-lockfile", "--force"], checkout);
			expect(
				await Bun.file(path.join(checkout, "packages/natives/native/pi_natives.darwin-arm64.node")).exists(),
			).toBe(false);

			const agentDir = path.join(home, ".omp/agent");
			await fs.mkdir(agentDir, { recursive: true });
			await Promise.all([
				fs.writeFile(path.join(agentDir, "AGENTS.md"), "clean-checkout global instructions\n"),
				fs.writeFile(path.join(agentDir, "config.yml"), "{}\n"),
				fs.writeFile(path.join(agentDir, "mcp.json"), '{"mcpServers":{"fixture":{"command":"fixture"}}}\n'),
				...(["mergify-config", "mergify-merge-queue", "mergify-merge-protections"] as const).map(async name => {
					const skillDir = path.join(home, ".agents/skills", name);
					await fs.mkdir(skillDir, { recursive: true });
					await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${name}\n`);
				}),
			]);
			const env = { ...Bun.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
			const cli = path.join(checkout, "packages/coding-agent/src/cli.ts");
			const cliJson = async (args: string[]): Promise<Record<string, unknown>> =>
				JSON.parse(await requireSuccess([bun, cli, ...args], checkout, env)) as Record<string, unknown>;

			const manifest = await cliJson(["context", "manifest", "--json"]);
			const contentManifest = manifest.contentManifest as Record<string, unknown>;
			const policyPayload = {
				schema: "smarty.approved_policy.v1",
				approval: {
					reference: "test://clean-checkout-owner-approval",
					approvedBy: "paulbettner",
					approvedAt: "2026-08-15T12:00:00-04:00",
				},
				candidates: manifest.candidates,
				contentManifestRootSha256: manifest.contentManifestRootSha256,
				behaviorSha256: manifest.behaviorSha256,
				globalAgentsSha256: manifest.globalAgentsSha256,
				configurationSemanticSha256: manifest.configurationSemanticSha256,
				combinedPromptBehaviorSha256: manifest.combinedPromptBehaviorSha256,
			};
			const policy = {
				...policyPayload,
				rootSha256: sha256(canonicalJson(policyPayload as unknown as JsonValue)),
			};
			const policyPath = path.join(tempRoot, "approved-policy.json");
			await fs.writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);

			const [approvedManifest, diff, protectedDelta, explain] = await Promise.all([
				cliJson(["context", "manifest", "--json", "--approved-policy", policyPath]),
				cliJson(["context", "diff", "--base", "HEAD^", "--target", "HEAD", "--json"]),
				cliJson([
					"context",
					"protected-delta",
					"--repository",
					checkout,
					"--base",
					"HEAD^",
					"--target",
					"HEAD",
					"--json",
				]),
				cliJson(["context", "explain", "--target", "main", "--provider", "openai-responses", "--json"]),
			]);

			expect(approvedManifest.rootSha256).toBe(manifest.rootSha256);
			expect(diff.schema).toBe("omp.context_diff.v1");
			expect(protectedDelta).toMatchObject({
				schema: "smarty.protected_delta.v1",
				repository: "Smarty-Pants-Inc/oh-my-pi",
				headCommit: manifest.commit,
			});
			expect(protectedDelta.classificationSha256).toMatch(/^[a-f0-9]{64}$/);
			expect(Array.isArray(contentManifest.implementationSources)).toBe(true);
			const components = explain.components as Array<Record<string, unknown>>;
			expect(components.filter(component => String(component.id).startsWith("external.skill."))).toHaveLength(3);
			expect(components.some(component => String(component.id).startsWith("external.mcp."))).toBe(true);
			expect(
				components.some(component =>
					String(component.id).startsWith("implementation.packages/agent/src/compaction/"),
				),
			).toBe(true);
			expect(
				(await requireSuccess(["git", "status", "--porcelain", "--untracked-files=all"], checkout)).trim(),
			).toBe("");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 180_000);
});
