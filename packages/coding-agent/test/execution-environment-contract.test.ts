import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ExtensionFactory,
	loadExtensionFromFactory,
	loadExtensions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type ExecutionEnvironmentBinding,
	type ExecutionEnvironmentProvider,
	mapExecutionEnvironmentPath,
} from "@oh-my-pi/pi-coding-agent/session/execution-environment";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const provider: ExecutionEnvironmentProvider = {
	async acquire() {
		throw new Error("provider must not be acquired during session construction");
	},
};

const binding: ExecutionEnvironmentBinding = {
	id: "test-environment",
	sourceRoot: "/local/worktree",
	remoteRoot: "/workspace",
	bridge: {
		async readTextFile() {
			return "";
		},
		async writeTextFile() {},
		async createTerminal() {
			return {
				terminalId: "test-terminal",
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

const registerProvider: ExtensionFactory = pi => {
	pi.registerExecutionEnvironmentProvider(provider);
};

describe("execution environment workspace path mapping", () => {
	const roots = { sourceRoot: "/local/worktree", remoteRoot: "/workspace" };

	test("maps the complete accepted relative, source-root, and remote-root namespace", () => {
		expect(mapExecutionEnvironmentPath(roots, ".")).toBe("/workspace");
		expect(mapExecutionEnvironmentPath(roots, "src/../README.md")).toBe("/workspace/README.md");
		expect(mapExecutionEnvironmentPath(roots, "/local/worktree/src/index.ts")).toBe("/workspace/src/index.ts");
		expect(mapExecutionEnvironmentPath(roots, "/workspace/src/index.ts")).toBe("/workspace/src/index.ts");
	});

	test("maps Windows source-root paths into the POSIX remote namespace", () => {
		const windowsRoots = { sourceRoot: "C:\\worktree", remoteRoot: "/workspace" };
		expect(mapExecutionEnvironmentPath(windowsRoots, "src\\index.ts")).toBe("/workspace/src/index.ts");
		expect(mapExecutionEnvironmentPath(windowsRoots, "C:\\worktree\\src\\index.ts")).toBe("/workspace/src/index.ts");
	});

	test("rejects escapes, unrelated absolute paths, and non-canonical absolute paths", () => {
		expect(() => mapExecutionEnvironmentPath(roots, "../outside.txt")).toThrow("outside");
		expect(() => mapExecutionEnvironmentPath(roots, "/outside/file.txt")).toThrow("outside");
		expect(() => mapExecutionEnvironmentPath(roots, "/local/worktree/../outside.txt")).toThrow("canonical");
		expect(() => mapExecutionEnvironmentPath(roots, "/workspace/src/../index.ts")).toThrow("canonical");
		expect(() => mapExecutionEnvironmentPath(roots, "")).toThrow("non-empty");
	});
});

describe("execution environment extension and session contract", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `pi-execution-environment-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	function sessionOptions(): CreateAgentSessionOptions {
		return {
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			preloadedCustomToolPaths: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		};
	}

	test("stores one provider on its Extension and rejects duplicate registration", async () => {
		const eventBus = new EventBus();
		const base = await loadExtensions([], tempDir, eventBus);
		const extension = await loadExtensionFromFactory(registerProvider, tempDir, eventBus, base.runtime, "provider");
		expect(extension.executionEnvironmentProvider).toBe(provider);

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerExecutionEnvironmentProvider(provider);
					pi.registerExecutionEnvironmentProvider(provider);
				},
				tempDir,
				eventBus,
				base.runtime,
				"duplicate-provider",
			),
		).rejects.toThrow("more than one execution environment provider");
	});

	test("rejects explicit-plus-extension and multiple-extension providers", async () => {
		await expect(
			createAgentSession({
				...sessionOptions(),
				executionEnvironmentProvider: provider,
				extensions: [registerProvider],
			}),
		).rejects.toThrow("Multiple execution environment providers");

		await expect(
			createAgentSession({
				...sessionOptions(),
				extensions: [registerProvider, registerProvider],
			}),
		).rejects.toThrow("Multiple execution environment providers");
	});

	test("rejects binding/provider conflicts", async () => {
		await expect(
			createAgentSession({
				...sessionOptions(),
				executionEnvironment: binding,
				executionEnvironmentProvider: provider,
			}),
		).rejects.toThrow("both an execution environment binding and provider");
	});

	test("preserves extension-owned provider registration across preloaded reuse", async () => {
		const eventBus = new EventBus();
		const preloaded = await loadExtensions([], tempDir, eventBus);
		const extension = await loadExtensionFromFactory(
			registerProvider,
			tempDir,
			eventBus,
			preloaded.runtime,
			"provider",
		);
		preloaded.extensions.push(extension);
		const sharedExtensions = preloaded.extensions;

		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await createAgentSession({
				...sessionOptions(),
				preloadedExtensions: preloaded,
			});
			try {
				expect(result.extensionsResult.extensions[0]?.executionEnvironmentProvider).toBe(provider);
			} finally {
				await result.session.dispose();
			}
		}

		expect(preloaded.extensions).toBe(sharedExtensions);
		expect(preloaded.extensions).toHaveLength(1);
		expect(preloaded.extensions[0]?.executionEnvironmentProvider).toBe(provider);
	});

	test("constructs an unchanged session when no environment is configured", async () => {
		const result = await createAgentSession(sessionOptions());
		try {
			expect(result.extensionsResult.extensions.some(extension => extension.executionEnvironmentProvider)).toBe(
				false,
			);
		} finally {
			await result.session.dispose();
		}
	});
});
