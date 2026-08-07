import { describe, expect, test } from "bun:test";
import {
	assertNoDuplicatePersistentRuntimePolicyFlags,
	materializeCreateRuntimePolicy,
	materializeRuntimePolicyUpdate,
	parsePersistentRuntimePolicyFlags,
} from "@oh-my-pi/pi-coding-agent/cli/agents-cli";
import { getDefault } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	type ExtensionFactory,
	loadExtensionFromFactory,
	loadExtensions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type {
	ExecutionEnvironmentBinding,
	ExecutionEnvironmentProvider,
} from "@oh-my-pi/pi-coding-agent/session/execution-environment";
import { LocalWorkspaceProvider } from "@oh-my-pi/pi-coding-agent/session/local-workspace-provider";
import { WorkspaceRuntimeProviderRegistry } from "@oh-my-pi/pi-coding-agent/session/workspace-provider-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const binding: ExecutionEnvironmentBinding = {
	id: "bound-environment",
	sourceRoot: "/source",
	remoteRoot: "/workspace",
	bridge: {
		async readTextFile() {
			return "";
		},
		async writeTextFile() {},
		async createTerminal() {
			return {
				terminalId: "terminal",
				async waitForExit() {
					return { exitCode: 0 };
				},
				async currentOutput() {
					return { output: "", truncated: false, exitStatus: { exitCode: 0 } };
				},
				async kill() {},
				async release() {},
			};
		},
	},
};

const environmentProvider: ExecutionEnvironmentProvider = {
	async acquire() {
		throw new Error("contract test must not acquire the environment");
	},
};

describe("Wave 4B SDK and extension public seams", () => {
	test("registers runtime providers immediately into the shared registry", async () => {
		const registry = new WorkspaceRuntimeProviderRegistry();
		const eventBus = new EventBus();
		const loaded = await loadExtensions([], process.cwd(), eventBus, registry);
		const provider = new LocalWorkspaceProvider();
		const factory: ExtensionFactory = pi => {
			pi.registerRuntimeProvider(provider);
			pi.registerExecutionEnvironmentProvider(environmentProvider);
		};

		const extension = await loadExtensionFromFactory(factory, process.cwd(), eventBus, loaded.runtime, "contract");

		expect(loaded.runtime.runtimeProviderRegistry).toBe(registry);
		expect(registry.get(provider.id)).toBe(provider);
		expect(extension.executionEnvironmentProvider).toBe(environmentProvider);
	});

	test("rejects a second legacy environment provider on one extension", async () => {
		const loaded = await loadExtensions([], process.cwd(), new EventBus());
		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerExecutionEnvironmentProvider(environmentProvider);
					pi.registerExecutionEnvironmentProvider(environmentProvider);
				},
				process.cwd(),
				new EventBus(),
				loaded.runtime,
				"duplicate",
			),
		).rejects.toThrow("more than one execution environment provider");
	});

	test("exposes the non-owning execution environment on SDK and tool session types", () => {
		const options: Pick<CreateAgentSessionOptions, "executionEnvironment" | "executionEnvironmentProvider"> = {
			executionEnvironment: binding,
		};
		const toolSession: Pick<
			ToolSession,
			"cwd" | "hasUI" | "getExecutionEnvironment" | "getSessionFile" | "getSessionSpawns"
		> = {
			cwd: "/source",
			hasUI: false,
			getExecutionEnvironment: () => binding,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};

		expect(options.executionEnvironment).toBe(binding);
		expect(toolSession.getExecutionEnvironment?.()).toBe(binding);
	});
});

describe("Wave 4B persistent CLI policy parsing", () => {
	test("seeds the first CLIProxyAPI model connection profile", () => {
		expect(getDefault("modelConnections")).toEqual({
			"cliproxyapi-default": {
				id: "cliproxyapi-default",
				model: { provider: "cliproxyapi", id: "gpt-5.6-terra" },
			},
		});
	});

	test("normalizes the exact closed runtime flag vocabulary", () => {
		expect(
			parsePersistentRuntimePolicyFlags({
				placement: "cloud",
				providerId: "null",
				os: "any",
				arch: "x64",
				minCpu: "4",
				minMemoryMib: "8192",
				network: "egress",
				maxReadyLatencyMs: "null",
				idleRuntimeTtlMs: "0",
			}),
		).toEqual({
			placement: "cloud",
			providerId: null,
			os: null,
			arch: "x64",
			minCpu: 4,
			minMemoryMiB: 8192,
			network: "egress",
			maxReadyLatencyMs: null,
			idleRuntimeTtlMs: 0,
		});
	});

	test("applies create defaults then settings then explicit flags", () => {
		expect(
			materializeCreateRuntimePolicy(
				{ placement: "local", minCpu: 2, idleRuntimeTtlMs: 10 },
				{ placement: "cloud", minCpu: "8" },
			),
		).toEqual({
			placement: "cloud",
			providerId: null,
			os: null,
			arch: null,
			minCpu: 8,
			minMemoryMiB: 0,
			network: "none",
			maxReadyLatencyMs: null,
			idleRuntimeTtlMs: 10,
		});
	});

	test("overlays set-runtime-policy flags only on the durable current policy", () => {
		const current = materializeCreateRuntimePolicy({}, { placement: "local", minCpu: "3", network: "none" });
		const updated = materializeRuntimePolicyUpdate(current, { network: "egress" });
		expect(updated).toEqual({ ...current, network: "egress" });
		expect(() => materializeRuntimePolicyUpdate(current, {})).toThrow("at least one runtime policy flag");
	});

	test("rejects non-canonical integers and duplicate policy flags before effects", () => {
		for (const minCpu of ["", "01", "-1", "+1", "1.0", "1e2", "2147483648", "NaN", "Infinity"]) {
			expect(() => parsePersistentRuntimePolicyFlags({ minCpu })).toThrow();
		}
		expect(() =>
			assertNoDuplicatePersistentRuntimePolicyFlags([
				"set-runtime-policy",
				"A",
				"--network",
				"none",
				"--network=egress",
			]),
		).toThrow("at most once");
	});
});
