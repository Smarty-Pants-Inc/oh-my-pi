import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { createOmpBuildIdentityDefine } from "../scripts/compile-binary";
import { OMP_BUILD_ID } from "../src/build-identity";
import { runCli } from "../src/cli";

const packageDir = path.resolve(import.meta.dir, "..");
const probeEntry = path.join(import.meta.dir, "fixtures", "build-identity-probe.ts");

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe("OMP build identity", () => {
	it("does not let runtime environment variables spoof a source identity", async () => {
		const result = await $`bun ${probeEntry}`
			.cwd(packageDir)
			.env({ ...process.env, OMP_BUILD_ID: "runtime-decoy" })
			.quiet()
			.nothrow();

		expect(result.exitCode).toBe(0);
		expect(result.text()).toMatch(/^source-[0-9a-f]+\n$/);
		expect(result.text()).not.toBe("runtime-decoy\n");
	});

	it("registers __build-id as a clean hidden query", async () => {
		process.exitCode = 0;
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runCli(["__build-id"]);

		expect(process.exitCode).toBe(0);
		expect(stdout).toHaveBeenCalledTimes(1);
		expect(stdout).toHaveBeenCalledWith(`${OMP_BUILD_ID}\n`);
		expect(stderr).not.toHaveBeenCalled();
	});

	it("uses the compile-time identity when runtime environment disagrees", async () => {
		using tempDir = TempDir.createSync("@omp-build-identity-");
		const outfile = tempDir.join("omp-build-id-probe");
		const output = await Bun.build({
			entrypoints: [probeEntry],
			root: packageDir,
			define: createOmpBuildIdentityDefine("compiled-build-123"),
			compile: {
				outfile,
				autoloadBunfig: false,
				autoloadDotenv: false,
				autoloadTsconfig: false,
				autoloadPackageJson: false,
			},
			throw: false,
		});
		expect(output.success).toBe(true);

		const result = await $`${outfile}`
			.env({ ...process.env, OMP_BUILD_ID: "runtime-decoy" })
			.quiet()
			.nothrow();

		expect(result.exitCode).toBe(0);
		expect(result.text()).toBe("compiled-build-123\n");
	});
});
