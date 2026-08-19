import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { createOmpBuildIdentityDefine } from "../scripts/compile-binary";

const packageDir = path.resolve(import.meta.dir, "..");
const probeEntry = path.join(import.meta.dir, "fixtures", "build-identity-probe.ts");
const cliEntry = path.join(packageDir, "src", "cli.ts");

describe("OMP build identity", () => {
	it("ignores ambient source build identities in the module and hidden probe", async () => {
		const env = {
			...process.env,
			OMP_BUILD_ID: "runtime-decoy",
			OMP_MANAGED_BUILD_ID: "managed-source-decoy",
		};
		const moduleProbe = await $`bun ${probeEntry}`.cwd(packageDir).env(env).quiet().nothrow();
		expect(moduleProbe.exitCode).toBe(0);
		expect(moduleProbe.text()).toBe("\n");

		const cliProbe = await $`bun ${cliEntry} __build-id`.cwd(packageDir).env(env).quiet().nothrow();
		expect(cliProbe.exitCode).toBe(0);
		expect(cliProbe.text()).toBe("\n");
	});

	it("uses only the dedicated manager argument for immutable source releases", async () => {
		const env = {
			...process.env,
			OMP_BUILD_ID: "runtime-decoy",
			OMP_MANAGED_BUILD_ID: "managed-source-decoy",
		};
		const moduleProbe = await $`bun ${probeEntry} __managed-source-build-id managed-source-build-123`
			.cwd(packageDir)
			.env(env)
			.quiet()
			.nothrow();
		expect(moduleProbe.exitCode).toBe(0);
		expect(moduleProbe.text()).toBe("managed-source-build-123\n");

		const cliProbe = await $`bun ${cliEntry} __managed-source-build-id managed-source-build-123 __build-id`
			.cwd(packageDir)
			.env(env)
			.quiet()
			.nothrow();
		expect(cliProbe.exitCode).toBe(0);
		expect(cliProbe.text()).toBe("managed-source-build-123\n");
	});

	it("does not treat an ambient preload global as a source build identity", async () => {
		using tempDir = TempDir.createSync("@omp-build-identity-preload-");
		const preload = tempDir.join("build-id-spoof.ts");
		await Bun.write(preload, 'Object.assign(globalThis, { __OMP_BUILD_ID__: "preload-spoof" });\n');
		const result = await $`bun ${probeEntry} __managed-source-build-id managed-source-build-123`
			.cwd(packageDir)
			.env({
				...process.env,
				BUN_INSPECT_PRELOAD: preload,
				OMP_MANAGED_BUILD_ID: "managed-source-decoy",
			})
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		expect(result.text()).toBe("managed-source-build-123\n");
	});

	it("scrubs the ambient managed identity before a descendant can inherit it", async () => {
		const result = await $`bun ${probeEntry} __managed-source-build-id managed-source-build-123 --spawn-child`
			.cwd(packageDir)
			.env({ ...process.env, OMP_MANAGED_BUILD_ID: "managed-source-decoy" })
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.text())).toEqual({
			buildId: "managed-source-build-123",
			inherited: "<absent>",
			exitCode: 0,
		});
	});

	it("prints the compile-time identity even when runtime env disagrees", async () => {
		using tempDir = TempDir.createSync("@omp-build-identity-");
		const outfile = tempDir.join("omp-build-id-probe");
		const output = await Bun.build({
			entrypoints: [probeEntry],
			root: packageDir,
			define: createOmpBuildIdentityDefine("managed-build-123"),
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
			.env({ ...process.env, OMP_BUILD_ID: "runtime-decoy", OMP_MANAGED_BUILD_ID: "managed-source-decoy" })
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		expect(result.text()).toBe("managed-build-123\n");
	});

	it("does not fall back to a hostile source identity when compiled empty", async () => {
		using tempDir = TempDir.createSync("@omp-build-identity-empty-");
		const outfile = tempDir.join("omp-build-id-probe");
		const output = await Bun.build({
			entrypoints: [probeEntry],
			root: packageDir,
			define: createOmpBuildIdentityDefine(""),
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
		const result = await $`${outfile} --spawn-child`
			.env({ ...process.env, OMP_MANAGED_BUILD_ID: "hostile-source-decoy" })
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.text())).toEqual({ buildId: "", inherited: "<absent>", exitCode: 0 });
	});
});
