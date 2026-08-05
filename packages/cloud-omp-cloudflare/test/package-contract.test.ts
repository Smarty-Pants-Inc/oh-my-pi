import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

type PackageManifest = {
	dependencies?: Record<string, unknown>;
	devDependencies?: Record<string, unknown>;
	cloudOmp?: { computerGitHead?: unknown };
	omp?: { extensions?: unknown };
};

const packageRoot = path.resolve(import.meta.dir, "..");

test("adapter package retains the reviewed immutable pins and bindings", async () => {
	const [manifest, wrangler, dockerfile, lockfile] = await Promise.all([
		fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
		fs.readFile(path.join(packageRoot, "wrangler.jsonc"), "utf8"),
		fs.readFile(path.join(packageRoot, "Dockerfile"), "utf8"),
		fs.readFile(path.resolve(packageRoot, "../..", "bun.lock"), "utf8"),
		fs.access(path.join(packageRoot, "src", "index.ts")),
		fs.access(path.join(packageRoot, "src", "extension.ts")),
	]);
	const pkg = JSON.parse(manifest) as PackageManifest;
	expect(pkg.dependencies?.["@cloudflare/computer"]).toBe("0.1.1");
	expect(pkg.devDependencies?.wrangler).toBe("4.118.0");
	expect(pkg.cloudOmp?.computerGitHead).toBe("63d363632e558f7e077794988d36ed75017c2a62");
	expect(pkg.omp?.extensions).toEqual(["./src/extension.ts"]);
	expect(lockfile).toContain('["@cloudflare/computer@0.1.1", "",');
	expect(lockfile).toContain(
		"sha512-4xWx5yX+y5MyNhtIK9N6LcyBsbzGdaxGbhfZdh51zRWRfdkI8OhL2ftBCReqaR6HD7we+Yg0rEihwBETrmkbmg==",
	);
	expect(wrangler).toContain('"compatibility_date": "2026-08-04"');
	expect(wrangler).toContain('"compatibility_flags": ["nodejs_compat"]');
	expect(wrangler).toContain('"class_name": "CloudOmpWorkspace"');
	expect(wrangler).toContain('"name": "WORKSPACE"');
	expect(wrangler).toContain('"instance_type": "standard-2"');
	expect(wrangler).toContain('"max_instances": 1');
	expect(dockerfile).toContain(
		"ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.0-alpha.1@sha256:42ad8d95908fc62336bc74e1ab724df954af7357d1abb13c6a685af21b01b795",
	);
	expect(dockerfile).toContain(
		"node:22-trixie-slim@sha256:c14465d88b83d14caaaa7e6e1f3efa49776a9868dc9713dddf7c79af3abb1d83",
	);
	expect(dockerfile).toContain("FROM --platform=linux/amd64 node:22-trixie-slim");
	expect(dockerfile).toContain("cloud-omp-provider-v1");
});
