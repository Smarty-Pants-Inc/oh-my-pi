import { describe, expect, it } from "bun:test";
import type { WorkspaceOperationLease } from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type PersistentReadRouteV1, ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function session(): ToolSession {
	return {
		cwd: "/must-not-be-read",
		hasUI: false,
		settings: { get: () => undefined },
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	} as unknown as ToolSession;
}

function persistentRoute(options: { content?: string; failRead?: boolean } = {}): {
	route: PersistentReadRouteV1;
	calls: { begin: number; end: number; reads: Array<Record<string, unknown>> };
} {
	const calls = { begin: 0, end: 0, reads: [] as Array<Record<string, unknown>> };
	const modelPath = "/workspace/src/example.ts";
	const paths = {
		modelRoot: "/workspace",
		parse(input: string) {
			if (input !== "src/example.ts" && input !== modelPath) throw new Error("workspace_path_unsupported_target");
			return {
				inputKind: input.startsWith("/") ? "model_absolute" : "relative",
				modelPath,
				relativePath: "src/example.ts",
			};
		},
		parseReturnedModelPath(input: string) {
			if (input !== modelPath) throw new Error("provider_path_contract_violation");
			return { inputKind: "model_absolute", modelPath, relativePath: "src/example.ts" };
		},
	};
	const route: PersistentReadRouteV1 = {
		paths: paths as PersistentReadRouteV1["paths"],
		async begin() {
			calls.begin++;
			return {
				operationLeaseId: "workspace-operation-1",
				binding: {
					lease: {
						leaseId: "runtime-lease-1",
						replica: { workspaceId: "workspace-1", replicaId: "replica-1" },
						baseGeneration: 4,
					},
					fence: { fenceId: "fence-1" },
					bridge: {
						async readTextFile(request: Record<string, unknown>) {
							calls.reads.push(request);
							if (options.failRead) throw new Error("provider failure");
							const content = options.content ?? "export const routed = true;\n";
							return {
								path: modelPath,
								content,
								sha256: "a".repeat(64),
								byteLength: Buffer.byteLength(content),
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

describe("adaptive persistent read route", () => {
	it("maps the workspace path before one admitted read and releases its exact lease after projection", async () => {
		const { route, calls } = persistentRoute();
		const result = await new ReadTool(session(), route).execute("read-1", { path: "src/example.ts" });

		expect(calls.begin).toBe(1);
		expect(calls.end).toBe(1);
		expect(calls.reads).toEqual([
			{
				operationLeaseId: "workspace-operation-1",
				workspaceId: "workspace-1",
				expectedGeneration: 4,
				replicaId: "replica-1",
				leaseId: "runtime-lease-1",
				fence: { fenceId: "fence-1" },
				path: "/workspace/src/example.ts",
				line: null,
				limit: null,
				byteLimit: 51_200,
			},
		]);
		expect(
			result.content.some(block => block.type === "text" && block.text.includes("export const routed = true;")),
		).toBe(true);
	});

	it("rejects a non-workspace target before admission and never falls back after provider failure", async () => {
		const invalid = persistentRoute();
		await expect(
			new ReadTool(session(), invalid.route).execute("read-invalid", { path: "https://example.com" }),
		).rejects.toThrow("Persistent read path");
		expect(invalid.calls).toEqual({ begin: 0, end: 0, reads: [] });

		const failing = persistentRoute({ failRead: true });
		await expect(
			new ReadTool(session(), failing.route).execute("read-fail", { path: "src/example.ts" }),
		).rejects.toThrow("provider failure");
		expect(failing.calls.begin).toBe(1);
		expect(failing.calls.end).toBe(1);
		expect(failing.calls.reads).toHaveLength(1);
	});
});
