import { describe, expect, it } from "bun:test";

import { computeFileHash } from "@oh-my-pi/hashline";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	canonicalRuntimeSha256,
	type PersistentModelWorkspacePath,
	type PersistentWorkspacePathMapper,
	type WorkspaceOperationLease,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EditTool, type PersistentEditRouteV1 } from "../../../src/edit";

const workspaceId = "workspace-1";
const operationLeaseId = "edit-operation-1";

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

function fixture(options: { readonly failWrite?: boolean; readonly dropWrite?: boolean } = {}): {
	route: PersistentEditRouteV1;
	files: Map<string, string>;
	events: string[];
	mutations: Array<{ operation: string; request: Record<string, unknown> }>;
	beginCount: () => number;
	endCount: () => number;
} {
	let begun = 0;
	let ended = 0;
	const files = new Map<string, string>([["/workspace/src/example.ts", "before\n"]]);
	const directories = new Set<string>(["/workspace", "/workspace/src"]);
	const events: string[] = [];
	const mutations: Array<{ operation: string; request: Record<string, unknown> }> = [];
	const paths: PersistentWorkspacePathMapper = {
		modelRoot: "/workspace",
		parse(input) {
			events.push(`parse:${input}`);
			if (/^[a-z][a-z0-9+.-]*:/i.test(input) || input.includes("\0")) throw new Error("unsupported target");
			const relative = input.startsWith("/workspace/") ? input.slice("/workspace/".length) : input;
			if (!relative || relative.startsWith("/") || relative.split("/").includes("..")) {
				throw new Error("outside workspace");
			}
			const modelPath = `/workspace/${relative}` as PersistentModelWorkspacePath;
			return {
				inputKind: input.startsWith("/") ? "model_absolute" : "relative",
				modelPath,
				relativePath: relative as never,
			};
		},
		parseReturnedModelPath(input) {
			return this.parse(input);
		},
	};
	const accessResult = (request: Record<string, unknown>) => {
		const path = request.path as string;
		const content = files.get(path);
		if (content === undefined) throw new Error(`missing ${path}`);
		return {
			path,
			content,
			sha256: new Bun.SHA256().update(content).digest("hex"),
			byteLength: Buffer.byteLength(content, "utf8"),
		};
	};
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
			async readTextFile(request: Record<string, unknown>) {
				return accessResult(request);
			},
			async readBinaryFile(request: Record<string, unknown>) {
				const result = accessResult(request);
				return {
					path: result.path,
					contentBase64: Buffer.from(result.content).toString("base64"),
					sha256: result.sha256,
					byteLength: result.byteLength,
					truncated: false,
				};
			},
			async exists(request: Record<string, unknown>) {
				return files.has(request.path as string);
			},
			async stat(request: Record<string, unknown>) {
				const target = request.path as string;
				if (directories.has(target)) {
					return { path: target, kind: "directory" as const, byteLength: null, sha256: null };
				}
				const content = files.get(target);
				if (content === undefined) throw new Error(`missing ${target}`);
				return {
					path: target,
					kind: "file" as const,
					byteLength: Buffer.byteLength(content, "utf8"),
					sha256: new Bun.SHA256().update(content).digest("hex"),
				};
			},
			async writeTextFile(request: Record<string, unknown>) {
				mutations.push({ operation: "write_text", request });
				if (options.failWrite) throw new Error("provider write failed");
				if (!options.dropWrite) files.set(request.path as string, request.content as string);
				return {
					status: "written" as const,
					path: request.path,
					sha256: request.contentSha256,
					byteLength: Buffer.byteLength(request.content as string, "utf8"),
				};
			},
			async mkdir(request: Record<string, unknown>) {
				mutations.push({ operation: "mkdir", request });
				const target = request.path as string;
				const status = directories.has(target) ? "already_exists" : "created";
				directories.add(target);
				return { status } as const;
			},
			async remove(request: Record<string, unknown>) {
				mutations.push({ operation: "remove", request });
				files.delete(request.path as string);
				return { status: "removed" as const };
			},
			async rename(request: Record<string, unknown>) {
				mutations.push({ operation: "rename", request });
				const content = files.get(request.from as string);
				if (content === undefined) throw new Error("missing rename source");
				files.set(request.to as string, content);
				files.delete(request.from as string);
				return { status: "renamed" as const };
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
			async begin() {
				events.push("begin");
				begun++;
				return lease;
			},
		},
		files,
		events,
		mutations,
		beginCount: () => begun,
		endCount: () => ended,
	};
}

describe("persistent edit route", () => {
	it("validates before one lease and routes replace through canonical provider identities", async () => {
		const state = fixture();
		const result = await new EditTool(session(), "replace", state.route).execute("call-1", {
			path: "src/example.ts",
			old_string: "before",
			new_string: "after",
		});

		const write = state.mutations[0]!;
		expect(write.operation).toBe("write_text");
		expect(write.request.path).toBe("/workspace/src/example.ts");
		expect(write.request.requestId).toBe(
			await canonicalRuntimeSha256([
				"omp-provider-subrequest-id-v1",
				workspaceId,
				"workspace_operation",
				operationLeaseId,
				0,
				"write_text",
			]),
		);
		const contentSha256 = new Bun.SHA256().update("after\n").digest("hex");
		expect(write.request.requestSha256).toBe(
			await canonicalRuntimeSha256([
				"omp-runtime-request-v1",
				"write_text",
				operationLeaseId,
				workspaceId,
				7,
				"replica-1",
				"runtime-lease-1",
				"fence-1",
				"/workspace/src/example.ts",
				contentSha256,
				6,
			]),
		);
		expect(state.events.indexOf("parse:src/example.ts")).toBeLessThan(state.events.indexOf("begin"));
		expect(state.beginCount()).toBe(1);
		expect(state.endCount()).toBe(1);
		expect(state.files.get("/workspace/src/example.ts")).toBe("after\n");
		expect(result.details?.path).toBe("/workspace/src/example.ts");
	});

	it("bridges every patch move mutation in frozen order", async () => {
		const state = fixture();
		await new EditTool(session(), "patch", state.route).execute("call-2", {
			path: "src/example.ts",
			edits: [{ op: "update", rename: "moved/example.ts", diff: "@@\n-before\n+after\n" }],
		});

		expect(state.mutations.map(entry => entry.operation)).toEqual(["mkdir", "write_text", "remove"]);
		for (let ordinal = 0; ordinal < state.mutations.length; ordinal++) {
			const mutation = state.mutations[ordinal]!;
			expect(mutation.request.operationLeaseId).toBe(operationLeaseId);
			expect(mutation.request.requestId).toBe(
				await canonicalRuntimeSha256([
					"omp-provider-subrequest-id-v1",
					workspaceId,
					"workspace_operation",
					operationLeaseId,
					ordinal,
					mutation.operation,
				]),
			);
		}
		expect(state.files.has("/workspace/src/example.ts")).toBe(false);
		expect(state.files.get("/workspace/moved/example.ts")).toBe("after\n");
		expect(state.beginCount()).toBe(1);
		expect(state.endCount()).toBe(1);
	});

	it("uses the rename bridge for a content-preserving hashline move", async () => {
		const state = fixture();
		const tag = computeFileHash("before\n");
		await new EditTool(session(), "hashline", state.route).execute("call-3", {
			input: `[src/example.ts#${tag}]\nMV renamed.ts`,
		});

		expect(state.mutations.map(entry => entry.operation)).toEqual(["rename"]);
		expect(state.files.has("/workspace/src/example.ts")).toBe(false);
		expect(state.files.get("/workspace/renamed.ts")).toBe("before\n");
		expect(state.beginCount()).toBe(1);
		expect(state.endCount()).toBe(1);
	});

	it("rejects every invalid hashline model path before admission", async () => {
		const state = fixture();
		await expect(
			new EditTool(session(), "hashline", state.route).execute("call-3", {
				input: "[src/example.ts#abcd]\nMV ../outside.ts",
			}),
		).rejects.toThrow("outside /workspace");
		expect(state.beginCount()).toBe(0);
		expect(state.endCount()).toBe(0);
		expect(state.mutations).toHaveLength(0);
	});

	it("never falls back locally and ends the lease after a provider failure", async () => {
		const state = fixture({ failWrite: true });
		await expect(
			new EditTool(session(), "replace", state.route).execute("call-4", {
				path: "src/example.ts",
				old_string: "before",
				new_string: "after",
			}),
		).rejects.toThrow("provider write failed");
		expect(state.mutations.map(entry => entry.operation)).toEqual(["write_text"]);
		expect(state.files.get("/workspace/src/example.ts")).toBe("before\n");
		expect(state.beginCount()).toBe(1);
		expect(state.endCount()).toBe(1);
	});

	it("rejects a successful write receipt when provider content did not change", async () => {
		const state = fixture({ dropWrite: true });
		await expect(
			new EditTool(session(), "replace", state.route).execute("call-5", {
				path: "src/example.ts",
				old_string: "before",
				new_string: "after",
			}),
		).rejects.toThrow("write verification failed");
		expect(state.mutations.map(entry => entry.operation)).toEqual(["write_text"]);
		expect(state.files.get("/workspace/src/example.ts")).toBe("before\n");
		expect(state.beginCount()).toBe(1);
		expect(state.endCount()).toBe(1);
	});
});
