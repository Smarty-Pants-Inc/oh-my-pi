import { describe, expect, it } from "bun:test";

import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	canonicalRuntimeSha256,
	type PersistentModelWorkspacePath,
	type PersistentWorkspacePathMapper,
	type WorkspaceOperationLease,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type PersistentWriteRouteV1, WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

const workspaceId = "workspace-1";
const operationLeaseId = "operation-1";
const modelPath = "/workspace/nested/output.txt" as PersistentModelWorkspacePath;

const paths: PersistentWorkspacePathMapper = {
	modelRoot: "/workspace",
	parse(input) {
		if (input === "nested/output.txt") {
			return { inputKind: "relative", modelPath, relativePath: "nested/output.txt" as never };
		}
		if (input === modelPath) {
			return { inputKind: "model_absolute", modelPath, relativePath: "nested/output.txt" as never };
		}
		throw new Error("outside workspace");
	},
	parseReturnedModelPath(input) {
		return this.parse(input);
	},
};

function session(): ToolSession {
	return {
		cwd: "/host/workspace",
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function route(options: { readonly verifiedContent?: string } = {}): {
	route: PersistentWriteRouteV1;
	beginCount: () => number;
	endCount: () => number;
	mutation: () => Record<string, unknown> | undefined;
	verification: () => Record<string, unknown> | undefined;
} {
	let begun = 0;
	let ended = 0;
	let writeRequest: Record<string, unknown> | undefined;
	let readRequest: Record<string, unknown> | undefined;
	const binding = {
		lease: {
			leaseId: "runtime-lease-1",
			replica: { providerId: "local", profileId: "default", replicaId: "replica-1", workspaceId },
			fenceId: "fence-1",
			baseGeneration: 7,
			renewalSequence: 0,
			acquiredAt: "2026-01-01T00:00:00.000Z",
			renewBy: "2026-01-01T00:01:00.000Z",
			expiresAt: "2026-01-01T00:02:00.000Z",
		},
		fence: { fenceId: "fence-1", token: "secret" },
		modelRoot: "/workspace" as const,
		bridge: {
			async writeTextFile(request: Record<string, unknown>) {
				writeRequest = request;
				return {
					status: "written" as const,
					path: request.path,
					sha256: request.contentSha256,
					byteLength: Buffer.byteLength(request.content as string, "utf8"),
				};
			},
			async readTextFile(request: Record<string, unknown>) {
				readRequest = request;
				const content = options.verifiedContent ?? "remote text\n";
				return {
					path: request.path,
					content,
					sha256: new Bun.SHA256().update(content).digest("hex"),
					byteLength: Buffer.byteLength(content, "utf8"),
				};
			},
		},
	};
	const lease = {
		operationLeaseId,
		binding,
		end() {
			ended++;
		},
	} as unknown as WorkspaceOperationLease;
	return {
		route: {
			paths,
			begin: async () => {
				begun++;
				return lease;
			},
		},
		beginCount: () => begun,
		endCount: () => ended,
		mutation: () => writeRequest,
		verification: () => readRequest,
	};
}

describe("persistent write route", () => {
	it("holds one lease through a distinct provider mutation and parent-identified read-back", async () => {
		const fixture = route();
		const result = await new WriteTool(session(), { persistentRoute: fixture.route }).execute("call-1", {
			path: "nested/output.txt",
			content: "remote text\n",
		});

		const mutation = fixture.mutation()!;
		const verification = fixture.verification()!;
		const contentSha256 = new Bun.SHA256().update("remote text\n").digest("hex");
		expect(mutation.operationLeaseId).toBe(operationLeaseId);
		expect(mutation.requestId).toBe(
			await canonicalRuntimeSha256([
				"omp-provider-subrequest-id-v1",
				workspaceId,
				"workspace_operation",
				operationLeaseId,
				0,
				"write_text",
			]),
		);
		expect(mutation.requestSha256).toBe(
			await canonicalRuntimeSha256([
				"omp-runtime-request-v1",
				"write_text",
				operationLeaseId,
				workspaceId,
				7,
				"replica-1",
				"runtime-lease-1",
				"fence-1",
				modelPath,
				contentSha256,
				12,
			]),
		);
		expect(mutation.requestId).not.toBe(operationLeaseId);
		expect(verification.operationLeaseId).toBe(operationLeaseId);
		expect("requestId" in verification).toBe(false);
		expect(fixture.beginCount()).toBe(1);
		expect(fixture.endCount()).toBe(1);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Successfully wrote 12 bytes to /workspace/nested/output.txt",
		});
	});

	it("does not fall back after a failed read-back and releases the lease", async () => {
		const fixture = route({ verifiedContent: "provider reformatted it" });
		await expect(
			new WriteTool(session(), { persistentRoute: fixture.route }).execute("call-2", {
				path: "nested/output.txt",
				content: "remote text\n",
			}),
		).rejects.toThrow("remote content did not match the requested text");
		expect(fixture.mutation()).toBeDefined();
		expect(fixture.verification()).toBeDefined();
		expect(fixture.endCount()).toBe(1);
	});

	it("rejects a non-workspace target before admission", async () => {
		const fixture = route();
		await expect(
			new WriteTool(session(), { persistentRoute: fixture.route }).execute("call-3", {
				path: "file:///host/workspace/output.txt",
				content: "remote text\n",
			}),
		).rejects.toThrow("paths relative to or rooted at /workspace");
		expect(fixture.beginCount()).toBe(0);
		expect(fixture.endCount()).toBe(0);
	});
});
