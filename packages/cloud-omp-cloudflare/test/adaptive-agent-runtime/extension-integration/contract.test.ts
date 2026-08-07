import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	ExecutionEnvironmentProvider,
	ExtensionAPI,
	ExtensionFactory,
	RuntimeProvider,
} from "@oh-my-pi/pi-coding-agent";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	discoverRuntimeProviders,
	WorkspaceRuntimeProviderRegistry,
} from "@oh-my-pi/pi-coding-agent/session/workspace-provider-registry";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import cloudOmpCloudflareExtension from "../../../src/extension";
import { CLOUD_OMP_VERSION_METADATA } from "../../../src/index";

const packageRoot = resolve(import.meta.dir, "../../..");
const validEnvironment = {
	CLOUD_OMP_CLOUDFLARE_ENDPOINT: "https://gateway.example.test",
	CLOUD_OMP_CLOUDFLARE_BEARER: "ordinary-bearer",
} as const;

function interceptRegistrations(captured: {
	runtime: RuntimeProvider[];
	legacy: ExecutionEnvironmentProvider[];
}): ExtensionFactory {
	return pi => {
		const intercepted = new Proxy(pi, {
			get(target, property) {
				if (property === "registerRuntimeProvider") {
					return (provider: RuntimeProvider) => {
						captured.runtime.push(provider);
						target.registerRuntimeProvider(provider);
					};
				}
				if (property === "registerExecutionEnvironmentProvider") {
					return (provider: ExecutionEnvironmentProvider) => {
						captured.legacy.push(provider);
						target.registerExecutionEnvironmentProvider(provider);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as ExtensionAPI;
		cloudOmpCloudflareExtension(intercepted);
	};
}

async function withEnvironment<T>(
	environment: Readonly<Record<string, string | undefined>>,
	run: () => Promise<T>,
): Promise<T> {
	const names = [
		"CLOUD_OMP_CLOUDFLARE_ENDPOINT",
		"CLOUD_OMP_CLOUDFLARE_BEARER",
		"CLOUD_OMP_AUDIT_PATH",
		"CLOUD_OMP_TEST_REMOTE_SENTINEL",
	] as const;
	const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
	for (const name of names) {
		const value = environment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		return await run();
	} finally {
		for (const name of names) {
			const value = previous[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

describe("Cloudflare adaptive extension integration", () => {
	test("registers into the supplied shared runtime registry without entering model registration", async () => {
		await withEnvironment(validEnvironment, async () => {
			const registry = new WorkspaceRuntimeProviderRegistry();
			const runtime = new ExtensionRuntime(registry);
			const captured = { runtime: [] as RuntimeProvider[], legacy: [] as ExecutionEnvironmentProvider[] };
			const extension = await loadExtensionFromFactory(
				interceptRegistrations(captured),
				packageRoot,
				new EventBus(),
				runtime,
				"cloudflare-integration",
			);

			expect(runtime.runtimeProviderRegistry).toBe(registry);
			expect(captured.runtime).toHaveLength(1);
			expect(registry.list()).toEqual(captured.runtime);
			expect(registry.get(captured.runtime[0]!.id)).toBe(captured.runtime[0]);
			expect(captured.runtime[0]).toMatchObject({ id: "cloudflare", supportedLocations: ["cloud"] });
			expect(runtime.pendingProviderRegistrations).toEqual([]);

			expect(captured.legacy).toHaveLength(1);
			expect(extension.executionEnvironmentProvider).toBe(captured.legacy[0]);
			expect(typeof extension.executionEnvironmentProvider?.acquire).toBe("function");
			expect(extension.label).toBe("Cloud OMP — Cloudflare Computer");

			const [disabledObservation] = await discoverRuntimeProviders({
				registry,
				configurations: [],
				requirements: {
					capabilities: ["workspace.read"],
					placement: "cloud",
					configuredProviderId: null,
					workspaceFormat: "omp-text-v1",
					os: null,
					arch: null,
					minCpu: 0,
					minMemoryMiB: 0,
					network: "egress",
					maxReadyLatencyMs: null,
				},
			});
			expect(disabledObservation).toEqual({
				providerId: "cloudflare",
				registered: true,
				enabled: false,
				availability: { status: "not_queried", reason: "disabled" },
				supportedLocations: ["cloud"],
				candidates: [],
			});
		});
	});

	test("invalid configuration performs zero registration", async () => {
		await withEnvironment({}, async () => {
			const registry = new WorkspaceRuntimeProviderRegistry();
			const runtime = new ExtensionRuntime(registry);
			const captured = { runtime: [] as RuntimeProvider[], legacy: [] as ExecutionEnvironmentProvider[] };

			await expect(
				loadExtensionFromFactory(
					interceptRegistrations(captured),
					packageRoot,
					new EventBus(),
					runtime,
					"invalid-cloudflare-integration",
				),
			).rejects.toThrow("CLOUD_OMP_CLOUDFLARE_ENDPOINT");
			expect(captured).toEqual({ runtime: [], legacy: [] });
			expect(registry.list()).toEqual([]);
			expect(runtime.pendingProviderRegistrations).toEqual([]);
		});
	});

	test("pins the experimental package, Worker bindings, build image, and TypeScript boundaries coherently", async () => {
		const [packageText, dockerfile, wranglerText, clientTsconfigText, workerTsconfigText, lockfile] =
			await Promise.all([
				readFile(resolve(packageRoot, "package.json"), "utf8"),
				readFile(resolve(packageRoot, "Dockerfile"), "utf8"),
				readFile(resolve(packageRoot, "wrangler.jsonc"), "utf8"),
				readFile(resolve(packageRoot, "tsconfig.json"), "utf8"),
				readFile(resolve(packageRoot, "tsconfig.worker.json"), "utf8"),
				readFile(resolve(packageRoot, "../..", "bun.lock"), "utf8"),
			]);
		const packageJson = JSON.parse(packageText) as {
			private: boolean;
			version: string;
			description: string;
			exports: Record<string, unknown>;
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
			cloudOmp: { computerGitHead: string };
			omp: { extensions: string[] };
		};
		const wrangler = JSON.parse(wranglerText) as {
			main: string;
			compatibility_date: string;
			compatibility_flags: string[];
			version_metadata: { binding: string };
			containers: Array<Record<string, unknown>>;
			durable_objects: { bindings: Array<Record<string, unknown>> };
			migrations: Array<Record<string, unknown>>;
		};
		const clientTsconfig = JSON.parse(clientTsconfigText) as { extends: string; include: string[] };
		const workerTsconfig = JSON.parse(workerTsconfigText) as {
			extends: string;
			compilerOptions: { lib: string[]; types: string[] };
			include: string[];
		};

		expect(packageJson.private).toBe(true);
		expect(packageJson.description).toContain("Experimental");
		expect(Object.keys(packageJson.exports).sort()).toEqual([".", "./extension"]);
		expect(packageJson.omp.extensions).toEqual(["./src/extension.ts"]);
		expect(packageJson.dependencies["@cloudflare/computer"]).toBe("0.1.1");
		expect(packageJson.devDependencies.wrangler).toBe("4.118.0");
		expect(packageJson.devDependencies["@cloudflare/workers-types"]).toBe("5.20260801.1");
		expect(packageJson.cloudOmp.computerGitHead).toBe(CLOUD_OMP_VERSION_METADATA.computerGitHead);
		expect(packageJson.version).toBe(CLOUD_OMP_VERSION_METADATA.packageVersion);
		expect(CLOUD_OMP_VERSION_METADATA.workerVersion).toBe(packageJson.version);
		expect(CLOUD_OMP_VERSION_METADATA.computerPackageVersion).toBe(packageJson.dependencies["@cloudflare/computer"]);
		expect(dockerfile).toContain(`FROM --platform=linux/amd64 ${CLOUD_OMP_VERSION_METADATA.computerdImage}`);
		expect(dockerfile).toContain(`FROM --platform=linux/amd64 ${CLOUD_OMP_VERSION_METADATA.nodeBaseImage}`);
		expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/computerd"]');
		expect(dockerfile).toContain("cloud-omp-provider-v1");

		expect(wrangler.main).toBe("src/worker/index.ts");
		expect(wrangler.compatibility_date).toBe("2026-08-04");
		expect(wrangler.compatibility_flags).toEqual(["nodejs_compat"]);
		expect(wrangler.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
		expect(wrangler.containers).toEqual([
			{
				class_name: "CloudOmpWorkspace",
				image: "./Dockerfile",
				instance_type: "standard-2",
				max_instances: 1,
				rollout_active_grace_period: 0,
				rollout_step_percentage: [100],
			},
		]);
		expect(wrangler.durable_objects.bindings).toEqual([{ name: "WORKSPACE", class_name: "CloudOmpWorkspace" }]);
		expect(wrangler.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["CloudOmpWorkspace"] }]);

		expect(clientTsconfig).toEqual({
			extends: "../tsconfig.workspace.json",
			include: ["src/client", "src/extension.ts", "src/index.ts", "src/protocol.ts"],
		});
		expect(workerTsconfig).toEqual({
			extends: "../../tsconfig.base.json",
			compilerOptions: { lib: ["ES2024", "WebWorker"], types: ["bun", "assets"] },
			include: ["src/protocol.ts", "src/worker", "../../node_modules/@cloudflare/workers-types/index.d.ts"],
		});

		expect(lockfile).toContain('"@cloudflare/computer": ["@cloudflare/computer@0.1.1"');
		expect(lockfile).toContain(
			"sha512-4xWx5yX+y5MyNhtIK9N6LcyBsbzGdaxGbhfZdh51zRWRfdkI8OhL2ftBCReqaR6HD7we+Yg0rEihwBETrmkbmg==",
		);
		expect(lockfile).toContain('"@cloudflare/workers-types": ["@cloudflare/workers-types@5.20260801.1"');
		expect(lockfile).toContain('"wrangler": ["wrangler@4.118.0"');
	});
});
