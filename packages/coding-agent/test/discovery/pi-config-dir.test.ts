import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDisabledProviders, setDisabledProviders } from "@oh-my-pi/pi-coding-agent/capability";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import {
	findAllNearestProjectConfigDirs,
	findConfigFile,
	findConfigFileWithMeta,
	getConfigDirPaths,
	getConfigDirs,
} from "@oh-my-pi/pi-coding-agent/config";
import { getUserPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getAgentDir } from "@oh-my-pi/pi-utils";

describe("PI_CONFIG_DIR", () => {
	const original = process.env.PI_CONFIG_DIR;
	afterEach(() => {
		if (original === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = original;
		}
	});

	test("getUserPath resolves the native user scope via getAgentDir (profile-aware)", () => {
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};
		// Native user config follows the active profile through getAgentDir(), not
		// ctx.home, so it stays in sync with builtin.ts and getMCPConfigPath("user").
		// The old behavior joined ctx.home + ".omp/agent" and leaked the default
		// profile's config into every profile.
		expect(getUserPath(ctx, "native", "commands")).toBe(path.join(getAgentDir(), "commands"));
		expect(getUserPath(ctx, "native", "commands")).not.toContain(ctx.home);
	});

	test("getConfigDirs respects PI_CONFIG_DIR for user base", () => {
		process.env.PI_CONFIG_DIR = ".config/omp";
		const result = getConfigDirs("commands", { project: false });
		const expected = path.resolve(path.join(os.homedir(), ".config/omp", "agent", "commands"));
		expect(result[0]).toEqual({ path: expected, source: ".omp", level: "user" });
	});

	test("disabled compatibility providers omit their ambient roots dynamically", () => {
		const savedDisabledProviders = getDisabledProviders();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-config-roots-"));
		const compatibilityRoots = [".claude", ".codex", ".gemini"];

		try {
			for (const root of [".omp", ...compatibilityRoots]) {
				fs.mkdirSync(path.join(cwd, root, "commands"), { recursive: true });
			}
			for (const root of compatibilityRoots) {
				fs.writeFileSync(path.join(cwd, root, "ambient.md"), root);
			}
			fs.writeFileSync(path.join(cwd, ".omp", "native.md"), "native");

			setDisabledProviders(["claude", "codex", "gemini"]);

			expect(getConfigDirs("commands", { cwd }).map(({ source, level }) => [source, level])).toEqual([
				[".omp", "user"],
				[".omp", "project"],
			]);
			expect(getConfigDirPaths("commands", { cwd })).toEqual(
				getConfigDirs("commands", { cwd }).map(({ path }) => path),
			);
			expect(findConfigFile("ambient.md", { cwd, user: false })).toBeUndefined();
			expect(findConfigFileWithMeta("ambient.md", { cwd, user: false })).toBeUndefined();
			expect(findConfigFile("native.md", { cwd, user: false })).toBe(path.join(cwd, ".omp", "native.md"));
			expect(findConfigFileWithMeta("native.md", { cwd, user: false })).toEqual({
				path: path.join(cwd, ".omp", "native.md"),
				source: ".omp",
				level: "project",
			});
			expect(findAllNearestProjectConfigDirs("commands", cwd).map(({ source }) => source)).toEqual([".omp"]);

			setDisabledProviders([]);
			expect(getConfigDirs("commands", { cwd }).map(({ source }) => source)).toEqual([
				".omp",
				".claude",
				".codex",
				".gemini",
				".omp",
				".claude",
				".codex",
				".gemini",
			]);
		} finally {
			setDisabledProviders(savedDisabledProviders);
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
