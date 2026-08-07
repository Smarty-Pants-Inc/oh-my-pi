import { describe, expect, it } from "bun:test";

import type {
	PersistentModelWorkspacePath,
	WorkspaceOperationLease,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type PersistentBashRouteV1 } from "@oh-my-pi/pi-coding-agent/tools/bash";

const modelPath = "/workspace/src/example.ts" as PersistentModelWorkspacePath;
const workspaceId = "workspace-1";
const operationLeaseId = "workspace-operation-1";

function sha256(tuple: readonly (string | number | boolean)[]): string {
	return new Bun.SHA256().update(JSON.stringify(tuple)).digest("hex");
}

function session(): ToolSession {
	return {
		cwd: "/must-not-be-read",
		hasUI: false,
		settings: { get: () => undefined },
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	} as unknown as ToolSession;
}

function persistentRoute(options: { readonly failSubmit?: boolean } = {}): {
	route: PersistentBashRouteV1;
	calls: {
		begin: number;
		end: number;
		submit: Record<string, unknown> | undefined;
		dispose: Record<string, unknown> | undefined;
	};
} {
	const calls = {
		begin: 0,
		end: 0,
		submit: undefined as Record<string, unknown> | undefined,
		dispose: undefined as Record<string, unknown> | undefined,
	};
	const route: PersistentBashRouteV1 = {
		paths: {
			modelRoot: "/workspace",
			parse(input: string) {
				if (input === "/workspace") {
					return {
						inputKind: "model_absolute",
						modelPath: "/workspace" as PersistentModelWorkspacePath,
						relativePath: "" as never,
					};
				}
				if (input !== "src/example.ts" && input !== modelPath) throw new Error("workspace_path_unsupported_target");
				return {
					inputKind: input.startsWith("/") ? "model_absolute" : "relative",
					modelPath,
					relativePath: "src/example.ts" as never,
				};
			},
			parseReturnedModelPath(input: string) {
				return this.parse(input);
			},
		} as PersistentBashRouteV1["paths"],
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
					fence: { fenceId: "fence-1" },
					bridge: {
						async submitCommand(request: Record<string, unknown>) {
							calls.submit = request;
							if (options.failSubmit) throw new Error("provider failure");
							return {
								commandId: request.commandId,
								requestSha256: request.requestSha256,
								status: "succeeded",
								sync: "complete",
								execution: { certainty: "completed" },
								output: "routed output\n",
								truncated: false,
								exitCode: 0,
								signal: null,
								updatedAt: "2026-01-01T00:00:00.000Z",
							};
						},
						async disposeCommand(request: Record<string, unknown>) {
							calls.dispose = request;
							return { status: "disposed", commandId: request.commandId };
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

describe("adaptive persistent Bash route", () => {
	it("maps before one admitted non-PTY command and disposes through the runtime bridge", async () => {
		const fixture = persistentRoute();
		const result = await new BashTool(session(), { persistentRoute: fixture.route }).execute("bash-1", {
			command: "printf routed",
			cwd: "src/example.ts",
		});

		const commandId = sha256(["omp-persistent-bash-command-id-v1", operationLeaseId]);
		const submit = fixture.calls.submit!;
		expect(submit.commandId).toBe(commandId);
		expect(submit.requestSha256).toBe(
			sha256([
				"omp-runtime-request-v1",
				"command_submit",
				operationLeaseId,
				workspaceId,
				4,
				"replica-1",
				"runtime-lease-1",
				"fence-1",
				"/bin/bash",
				"printf routed",
				modelPath,
				"omp-runtime-scrubbed-v1",
				120_000,
				4_194_304,
				false,
			]),
		);
		expect(submit.command).toEqual({
			shell: "/bin/bash",
			source: "printf routed",
			cwd: modelPath,
			environment: "omp-runtime-scrubbed-v1",
			timeoutMs: 120_000,
			outputByteLimit: 4_194_304,
			pty: false,
		});
		expect(fixture.calls.dispose).toMatchObject({
			commandId,
			requestId: sha256([
				"omp-provider-subrequest-id-v1",
				workspaceId,
				"workspace_operation",
				operationLeaseId,
				1,
				"command_dispose",
			]),
		});
		expect(fixture.calls.begin).toBe(1);
		expect(fixture.calls.end).toBe(1);
		expect(result.content.some(block => block.type === "text" && block.text.includes("routed output"))).toBe(true);
	});

	it("rejects unsupported modes and paths before admission and never falls back after provider failure", async () => {
		const invalid = persistentRoute();
		const tool = new BashTool(session(), { persistentRoute: invalid.route });
		await expect(tool.execute("bash-async", { command: "true", async: true })).rejects.toThrow("foreground");
		await expect(tool.execute("bash-pty", { command: "true", pty: true })).rejects.toThrow("PTY");
		await expect(tool.execute("bash-env", { command: "true", env: { PATH: "/bin" } })).rejects.toThrow("environment");
		await expect(tool.execute("bash-cwd", { command: "true", cwd: "../escape" })).rejects.toThrow("cwd");
		expect(invalid.calls.begin).toBe(0);

		const failing = persistentRoute({ failSubmit: true });
		await expect(
			new BashTool(session(), { persistentRoute: failing.route }).execute("bash-fail", { command: "true" }),
		).rejects.toThrow("provider failure");
		expect(failing.calls.begin).toBe(1);
		expect(failing.calls.end).toBe(1);
		expect(failing.calls.submit).toBeDefined();
	});
});
