import { describe, expect, it } from "bun:test";

import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	PersistentModelWorkspacePath,
	PersistentWorkspacePathMapper,
	WorkspaceOperationLease,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool, type PersistentGrepRouteV1 } from "@oh-my-pi/pi-coding-agent/tools/grep";

const workspaceId = "workspace-1";
const modelRoot = "/workspace" as const;
const operationLeaseId = "workspace-operation-1";
const searchPath = "/workspace/src" as PersistentModelWorkspacePath;
const matchPath = "/workspace/src/example.ts" as PersistentModelWorkspacePath;

const paths: PersistentWorkspacePathMapper = {
	modelRoot,
	parse(input) {
		if (input === "src" || input === searchPath) {
			return {
				inputKind: input.startsWith("/") ? "model_absolute" : "relative",
				modelPath: searchPath,
				relativePath: "src" as never,
			};
		}
		if (input === matchPath) {
			return { inputKind: "model_absolute", modelPath: matchPath, relativePath: "src/example.ts" as never };
		}
		throw new Error("workspace_path_unsupported_target");
	},
	parseReturnedModelPath(input) {
		if (input !== matchPath) throw new Error("provider_path_contract_violation");
		return { inputKind: "model_absolute", modelPath: matchPath, relativePath: "src/example.ts" as never };
	},
};

function session(): ToolSession {
	return {
		cwd: "/host/workspace-must-not-be-read",
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function persistentRoute(options: { readonly failSearch?: boolean } = {}): {
	route: PersistentGrepRouteV1;
	calls: { begin: number; end: number; searches: Array<Record<string, unknown>> };
} {
	const calls = { begin: 0, end: 0, searches: [] as Array<Record<string, unknown>> };
	const route: PersistentGrepRouteV1 = {
		paths,
		async begin() {
			calls.begin++;
			return {
				operationLeaseId,
				binding: {
					lease: {
						leaseId: "runtime-lease-1",
						replica: { workspaceId, replicaId: "replica-1" },
						baseGeneration: 4,
					},
					fence: { fenceId: "fence-1", token: "secret" },
					bridge: {
						async searchText(request: Record<string, unknown>) {
							calls.searches.push(request);
							if (options.failSearch) throw new Error("provider failure");
							return {
								matches: [{ path: matchPath, line: 2, column: 1, text: "const needle = true;" }],
								nextCursor: null,
							};
						},
					},
				},
				end() {
					calls.end++;
				},
			} as unknown as WorkspaceOperationLease;
		},
	};
	return { route, calls };
}

describe("persistent grep route", () => {
	it("maps paths before one admitted search, uses the exact lease binding, and releases it", async () => {
		const fixture = persistentRoute();
		const result = await new GrepTool(session(), { persistentRoute: fixture.route }).execute("grep-1", {
			pattern: "needle",
			path: "src",
		});

		expect(fixture.calls.begin).toBe(1);
		expect(fixture.calls.end).toBe(1);
		expect(fixture.calls.searches).toEqual([
			{
				operationLeaseId,
				workspaceId,
				expectedGeneration: 4,
				replicaId: "replica-1",
				leaseId: "runtime-lease-1",
				fence: { fenceId: "fence-1", token: "secret" },
				path: searchPath,
				pattern: "needle",
				flags: "",
				limit: 2000,
				cursor: null,
			},
		]);
		expect(result.content.some(block => block.type === "text" && block.text.includes("const needle = true;"))).toBe(
			true,
		);
	});

	it("does not fall back after a provider failure and releases its lease", async () => {
		const fixture = persistentRoute({ failSearch: true });
		await expect(
			new GrepTool(session(), { persistentRoute: fixture.route }).execute("grep-fail", {
				pattern: "needle",
				path: "src",
			}),
		).rejects.toThrow("provider failure");
		expect(fixture.calls.begin).toBe(1);
		expect(fixture.calls.end).toBe(1);
		expect(fixture.calls.searches).toHaveLength(1);
	});

	it("rejects a non-workspace path before admission", async () => {
		const fixture = persistentRoute();
		await expect(
			new GrepTool(session(), { persistentRoute: fixture.route }).execute("grep-invalid", {
				pattern: "needle",
				path: "file:///host/workspace/example.ts",
			}),
		).rejects.toThrow("Persistent grep paths must be relative to or rooted at /workspace");
		expect(fixture.calls.begin).toBe(0);
		expect(fixture.calls.end).toBe(0);
		expect(fixture.calls.searches).toEqual([]);
	});
});
