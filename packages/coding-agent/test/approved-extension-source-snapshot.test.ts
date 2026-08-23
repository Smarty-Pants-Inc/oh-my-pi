import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { approvedCandidateSourceModule, type ContextReleaseManifest } from "@oh-my-pi/pi-coding-agent/context/manifest";
import { loadLegacyPiModule } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { TempDir } from "@oh-my-pi/pi-utils";

interface TestExtensionApi {
	registerCommand(name: string, definition: { handler: () => Promise<void> }): void;
}

interface TestExtensionModule {
	default: (api: TestExtensionApi) => Promise<void>;
	loadLazyFactory(): Promise<(api: TestExtensionApi) => Promise<void>>;
}

function runGit(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

describe("approved source-linked extension snapshots", () => {
	it("executes only the approved module, factory, and lazy registration after source mutation", async () => {
		using tempDir = TempDir.createSync("@omp-approved-source-snapshot-");
		const repositoryRoot = tempDir.join("repository");
		const packageRoot = path.join(repositoryRoot, "packages", "omp-prompt-steering");
		const linkedPackageRoot = path.join(repositoryRoot, "runtime", "node_modules", "omp-prompt-steering");
		const entryPath = path.join(packageRoot, "src", "index.ts");
		const linkedEntryPath = path.join(linkedPackageRoot, "src", "index.ts");
		const modulePath = path.join(packageRoot, "src", "module.ts");
		const lazyPath = path.join(packageRoot, "src", "lazy.ts");
		const moduleMarker = tempDir.join("module-marker.txt");
		const factoryMarker = tempDir.join("factory-marker.txt");
		const registrationMarker = tempDir.join("registration-marker.txt");

		fs.mkdirSync(path.dirname(entryPath), { recursive: true });
		fs.writeFileSync(
			path.join(packageRoot, "package.json"),
			JSON.stringify({ name: "omp-prompt-steering", type: "module" }),
		);
		fs.writeFileSync(
			entryPath,
			[
				'import { moduleValue } from "./module.ts";',
				"",
				"export default async function register(pi) {",
				`\tawait Bun.write(${JSON.stringify(factoryMarker)}, \`approved-factory:\${moduleValue}\\n\`);`,
				'\tpi.registerCommand("approved-factory-command", { handler: async () => {} });',
				"}",
				"",
				"export async function loadLazyFactory() {",
				'\treturn (await import("./lazy.ts")).register;',
				"}",
			].join("\n"),
		);
		fs.writeFileSync(
			modulePath,
			[
				`await Bun.write(${JSON.stringify(moduleMarker)}, "approved-module\\n");`,
				'export const moduleValue = "approved";',
			].join("\n"),
		);
		fs.writeFileSync(
			lazyPath,
			[
				"export async function register(pi) {",
				`\tawait Bun.write(${JSON.stringify(registrationMarker)}, "approved-registration\\n");`,
				'\tpi.registerCommand("approved-lazy-command", { handler: async () => {} });',
				"}",
			].join("\n"),
		);
		fs.mkdirSync(path.dirname(linkedPackageRoot), { recursive: true });
		fs.symlinkSync(packageRoot, linkedPackageRoot);

		runGit(repositoryRoot, "init", "-q");
		runGit(repositoryRoot, "config", "user.name", "OMP Test");
		runGit(repositoryRoot, "config", "user.email", "omp-test@example.com");
		runGit(repositoryRoot, "remote", "add", "origin", "https://github.com/Smarty-Pants-Inc/smarty-dev.git");
		runGit(repositoryRoot, "add", ".");
		runGit(repositoryRoot, "commit", "-qm", "approved source-linked extension");
		const commit = runGit(repositoryRoot, "rev-parse", "HEAD");
		const tree = runGit(repositoryRoot, "rev-parse", "HEAD^{tree}");
		const release = {
			candidates: [{ repository: "Smarty-Pants-Inc/smarty-dev", commit, tree }],
		} as ContextReleaseManifest;

		const approved = await approvedCandidateSourceModule(linkedEntryPath, release);
		expect(approved).toBeDefined();
		if (!approved) throw new Error("Expected source-linked extension approval");

		fs.writeFileSync(
			entryPath,
			[
				'import { moduleValue } from "./module.ts";',
				"",
				"export default async function register(pi) {",
				`\tawait Bun.write(${JSON.stringify(factoryMarker)}, \`mutated-factory:\${moduleValue}\\n\`);`,
				'\tpi.registerCommand("mutated-factory-command", { handler: async () => {} });',
				"}",
				"",
				"export async function loadLazyFactory() {",
				'\treturn (await import("./lazy.ts")).register;',
				"}",
			].join("\n"),
		);
		fs.writeFileSync(
			modulePath,
			[
				`await Bun.write(${JSON.stringify(moduleMarker)}, "mutated-module\\n");`,
				'export const moduleValue = "mutated";',
			].join("\n"),
		);
		fs.writeFileSync(
			lazyPath,
			[
				"export async function register(pi) {",
				`\tawait Bun.write(${JSON.stringify(registrationMarker)}, "mutated-registration\\n");`,
				'\tpi.registerCommand("mutated-lazy-command", { handler: async () => {} });',
				"}",
			].join("\n"),
		);

		const extensionModule = (await loadLegacyPiModule(approved.entryPath, approved)) as TestExtensionModule;
		const registeredCommands: string[] = [];
		const api: TestExtensionApi = {
			registerCommand(name) {
				registeredCommands.push(name);
			},
		};
		await extensionModule.default(api);
		await (await extensionModule.loadLazyFactory())(api);

		expect(await Bun.file(moduleMarker).text()).toBe("approved-module\n");
		expect(await Bun.file(factoryMarker).text()).toBe("approved-factory:approved\n");
		expect(await Bun.file(registrationMarker).text()).toBe("approved-registration\n");
		expect(registeredCommands).toEqual(["approved-factory-command", "approved-lazy-command"]);
	});
});
