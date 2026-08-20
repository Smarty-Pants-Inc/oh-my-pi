import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ManifestFixture {
	readonly root: string;
	write(relativePath: string, content: string | Uint8Array): Promise<void>;
	track(...relativePaths: string[]): Promise<void>;
	dispose(): Promise<void>;
}

export async function createManifestFixture(
	files: Readonly<Record<string, string | Uint8Array>> = {},
): Promise<ManifestFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-omp-manifest-"));
	await runGit(root, ["init", "-q"]);
	const fixture: ManifestFixture = {
		root,
		async write(relativePath, content) {
			await Bun.write(path.join(root, ...relativePath.split("/")), content);
		},
		async track(...relativePaths) {
			await runGit(root, ["add", "--", ...relativePaths]);
		},
		dispose: () => fs.rm(root, { recursive: true, force: true }),
	};
	for (const [relativePath, content] of Object.entries(files)) await fixture.write(relativePath, content);
	if (Object.keys(files).length > 0) await fixture.track(...Object.keys(files));
	return fixture;
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
	const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
}
