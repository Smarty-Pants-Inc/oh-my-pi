import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { MAX_HTTP_BODY_BYTES } from "../src/boundary-policy";
import type { FilePayload } from "../src/protocol.ts";
import { bearerMatches, constantTimeEqual } from "../src/worker/auth";
import worker, { type WorkerEnv, type WorkspaceNamespace, type WorkspaceRpc } from "../src/worker/router";
import { manifestRootSha256, sha256Hex } from "../src/worker/workspace-files";

const WORKSPACE_ID = "a".repeat(32);
const EXEC_ID = "b".repeat(32);
const AUDIT_ID = "3".repeat(32);
const BEARER = "ordinary-route-test-token";
let bearerDigest = "";

beforeAll(async () => {
	bearerDigest = await sha256Hex(new TextEncoder().encode(BEARER));
});

class ThrowingNamespace implements WorkspaceNamespace {
	readonly names: string[] = [];
	readonly gets: DurableObjectId[] = [];
	readonly rpc = new Proxy({} as WorkspaceRpc, {
		get: () => {
			throw new Error("Validation reached RPC");
		},
	});

	idFromName(name: string): DurableObjectId {
		this.names.push(name);
		return { name } as DurableObjectId;
	}

	get(id: DurableObjectId): WorkspaceRpc {
		this.gets.push(id);
		return this.rpc;
	}
}

let namespace: ThrowingNamespace;
let env: WorkerEnv;

beforeEach(() => {
	namespace = new ThrowingNamespace();
	env = { WORKSPACE: namespace, CLOUD_OMP_BEARER_SHA256: bearerDigest };
});

describe("fake gateway Worker bearer authentication", () => {
	it("compares digest bytes without accepting length or content differences", () => {
		expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
		expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
		expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
	});

	it("accepts only one exact Bearer credential against a lowercase SHA-256 digest", async () => {
		expect(await bearerMatches(`Bearer ${BEARER}`, bearerDigest)).toBe(true);
		expect(await bearerMatches(`Bearer ${BEARER}x`, bearerDigest)).toBe(false);
		expect(await bearerMatches(`bearer ${BEARER}`, bearerDigest)).toBe(false);
		expect(await bearerMatches(`Bearer  ${BEARER}`, bearerDigest)).toBe(false);
		expect(await bearerMatches(null, bearerDigest)).toBe(false);
		expect(await bearerMatches(`Bearer ${BEARER}`, bearerDigest.toUpperCase())).toBe(false);
	});

	it("authenticates health and returns a uniform 401 before IDs, body limits, or Durable Objects", async () => {
		const health = await request("/v1/health");
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: true });
		expect(health.headers.get("access-control-allow-origin")).toBeNull();

		const missing = await request("/v1/health", { authenticated: false });
		const malformed = await request(`/v1/workspaces/NOT-CANONICAL`, {
			method: "DELETE",
			authenticated: false,
			headers: { "content-length": String(MAX_HTTP_BODY_BYTES + 1) },
		});
		expect(missing.status).toBe(401);
		expect(malformed.status).toBe(401);
		expect(await missing.json()).toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });
		expect(await malformed.json()).toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });
		expect(namespace.names).toEqual([]);
	});
});

describe("fake gateway Worker request validation", () => {
	it("rejects oversized declared bodies before routing or Durable Object allocation", async () => {
		const response = await request("/v1/health", {
			headers: { "content-length": String(MAX_HTTP_BODY_BYTES + 1) },
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			error: { code: "request_too_large", message: "Request body exceeds size limit" },
		});
		expect(namespace.names).toEqual([]);
	});

	it("limits streamed bodies even when Content-Length is absent", async () => {
		let emittedChunks = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (emittedChunks === 33) {
					controller.close();
					return;
				}
				emittedChunks += 1;
				controller.enqueue(new Uint8Array(1024 * 1024));
			},
		});
		const response = await worker.fetch(
			new Request(`https://gateway.example/v1/workspaces/${WORKSPACE_ID}/files`, {
				method: "PUT",
				headers: {
					authorization: `Bearer ${BEARER}`,
					"content-type": "application/json",
				},
				body,
			}),
			env,
		);
		expect(response.status).toBe(413);
		expect((await response.json()).error.code).toBe("request_too_large");
		expect(namespace.names).toEqual([]);
	});

	it("rejects malformed IDs, JSON, media types, and bodies on bodyless routes before RPC", async () => {
		const workspaceId = await request(`/v1/workspaces/${WORKSPACE_ID.toUpperCase()}`, { method: "DELETE" });
		expect(workspaceId.status).toBe(400);
		expect((await workspaceId.json()).error.code).toBe("workspace_id_invalid");

		const execId = await request(`/v1/workspaces/${WORKSPACE_ID}/exec/${EXEC_ID.toUpperCase()}`);
		expect(execId.status).toBe(400);
		expect((await execId.json()).error.code).toBe("execution_id_invalid");

		const malformedJson = await request(`/v1/workspaces/${WORKSPACE_ID}/files/read`, {
			method: "POST",
			rawBody: "{",
		});
		expect(malformedJson.status).toBe(400);
		expect((await malformedJson.json()).error.code).toBe("json_invalid");

		const wrongType = await request(`/v1/workspaces/${WORKSPACE_ID}/files/read`, {
			method: "POST",
			rawBody: JSON.stringify({ path: "file.txt" }),
			headers: { "content-type": "text/plain" },
		});
		expect(wrongType.status).toBe(415);

		const bodyNotAllowed = await request(`/v1/workspaces/${WORKSPACE_ID}/quiesce`, {
			method: "POST",
			rawBody: "{}",
		});
		expect(bodyNotAllowed.status).toBe(400);
		expect((await bodyNotAllowed.json()).error.code).toBe("body_not_allowed");
		expect(namespace.names).toEqual([]);
	});

	it("rejects every unknown request field, including executable and env escape hatches", async () => {
		const exec = await request(`/v1/workspaces/${WORKSPACE_ID}/exec`, {
			method: "POST",
			body: {
				source: "pwd",
				cwd: "/workspace",
				timeoutMs: 1_000,
				outputByteLimit: 1_024,
				env: { SECRET: "must-not-pass" },
			},
		});
		expect(exec.status).toBe(400);
		expect((await exec.json()).error.code).toBe("unknown_fields");

		const executable = await request(`/v1/workspaces/${WORKSPACE_ID}/exec`, {
			method: "POST",
			body: {
				source: "pwd",
				cwd: "/workspace",
				timeoutMs: 1_000,
				outputByteLimit: 1_024,
				executable: "/bin/sh",
			},
		});
		expect(executable.status).toBe(400);

		const read = await request(`/v1/workspaces/${WORKSPACE_ID}/files/read`, {
			method: "POST",
			body: { path: "file.txt", extra: true },
		});
		expect(read.status).toBe(400);

		const payload = await makePayload("file.txt", "content");
		const write = await request(`/v1/workspaces/${WORKSPACE_ID}/files`, {
			method: "PUT",
			body: { ...payload, extra: true },
		});
		expect(write.status).toBe(400);

		const root = await manifestRootSha256([payload]);
		const create = await request(`/v1/workspaces/${WORKSPACE_ID}`, {
			method: "PUT",
			body: {
				auditCorrelationId: AUDIT_ID,
				seedRootSha256: root,
				files: [{ ...payload, extra: true }],
			},
		});
		expect(create.status).toBe(400);
		expect(namespace.names).toEqual([]);
	});

	it("enforces canonical synchronized paths and destination collision rules", async () => {
		for (const path of [
			"/absolute.txt",
			"a//b.txt",
			"a/../b.txt",
			"a\\b.txt",
			"cafe\u0301.txt",
			".env",
			"node_modules/package.json",
		]) {
			const response = await request(`/v1/workspaces/${WORKSPACE_ID}/files/read`, {
				method: "POST",
				body: { path },
			});
			expect(response.status).toBe(400);
		}

		const upper = await makePayload("A.txt", "upper");
		const lower = await makePayload("a.txt", "lower");
		const response = await request(`/v1/workspaces/${WORKSPACE_ID}`, {
			method: "PUT",
			body: {
				auditCorrelationId: AUDIT_ID,
				seedRootSha256: await manifestRootSha256([upper, lower]),
				files: [upper, lower],
			},
		});
		expect(response.status).toBe(409);
		expect((await response.json()).error.code).toBe("destination_collision");
		expect(namespace.names).toEqual([]);
	});

	it("recomputes file and root digests and rejects malformed manifests before acquisition", async () => {
		const payload = await makePayload("file.txt", "content");
		const badFile = await request(`/v1/workspaces/${WORKSPACE_ID}/files`, {
			method: "PUT",
			body: { ...payload, sha256: "0".repeat(64) },
		});
		expect(badFile.status).toBe(422);
		expect((await badFile.json()).error.code).toBe("file_digest_mismatch");

		const nonCanonicalBase64 = await request(`/v1/workspaces/${WORKSPACE_ID}/files`, {
			method: "PUT",
			body: { path: "file.txt", sha256: "0".repeat(64), byteLength: 1, contentBase64: "AA" },
		});
		expect(nonCanonicalBase64.status).toBe(400);
		expect((await nonCanonicalBase64.json()).error.code).toBe("invalid_base64");

		const invalidUtf8Bytes = new Uint8Array([0xff]);
		const invalidUtf8 = await request(`/v1/workspaces/${WORKSPACE_ID}/files`, {
			method: "PUT",
			body: {
				path: "file.txt",
				sha256: await sha256Hex(invalidUtf8Bytes),
				byteLength: 1,
				contentBase64: "/w==",
			},
		});
		expect(invalidUtf8.status).toBe(422);
		expect((await invalidUtf8.json()).error.code).toBe("invalid_utf8");

		const badRoot = await request(`/v1/workspaces/${WORKSPACE_ID}`, {
			method: "PUT",
			body: { auditCorrelationId: AUDIT_ID, seedRootSha256: "0".repeat(64), files: [payload] },
		});
		expect(badRoot.status).toBe(400);
		expect((await badRoot.json()).error.code).toBe("seed_root_mismatch");

		const second = await makePayload("second.txt", "second");
		const unsorted = [second, payload];
		const badOrder = await request(`/v1/workspaces/${WORKSPACE_ID}`, {
			method: "PUT",
			body: {
				auditCorrelationId: AUDIT_ID,
				seedRootSha256: await manifestRootSha256(unsorted),
				files: unsorted,
			},
		});
		expect(badOrder.status).toBe(400);
		expect((await badOrder.json()).error.code).toBe("invalid_manifest_order");
		expect(namespace.names).toEqual([]);
	});

	it("enforces file-count, total-byte, file-size, command, timeout, and output caps before RPC", async () => {
		const tooMany = await request(`/v1/workspaces/${WORKSPACE_ID}`, {
			method: "PUT",
			body: {
				auditCorrelationId: AUDIT_ID,
				seedRootSha256: "0".repeat(64),
				files: Array.from({ length: 1_001 }, () => ({})),
			},
		});
		expect(tooMany.status).toBe(413);
		expect((await tooMany.json()).error.code).toBe("file_count_exceeded");

		const tooManyBytes = await request(`/v1/workspaces/${WORKSPACE_ID}`, {
			method: "PUT",
			body: {
				auditCorrelationId: AUDIT_ID,
				seedRootSha256: "0".repeat(64),
				files: Array.from({ length: 81 }, (_, index) => ({
					path: `file-${String(index).padStart(2, "0")}.txt`,
					sha256: "0".repeat(64),
					byteLength: 256 * 1024,
					contentBase64: "",
				})),
			},
		});
		expect(tooManyBytes.status).toBe(413);
		expect((await tooManyBytes.json()).error.code).toBe("total_file_bytes_exceeded");

		const oversizedFile = await request(`/v1/workspaces/${WORKSPACE_ID}/files`, {
			method: "PUT",
			body: {
				path: "large.txt",
				sha256: "0".repeat(64),
				byteLength: 256 * 1024 + 1,
				contentBase64: "",
			},
		});
		expect(oversizedFile.status).toBe(413);

		for (const body of [
			{ source: "x".repeat(32 * 1024 + 1), cwd: "/workspace", timeoutMs: 1, outputByteLimit: 1 },
			{ source: "pwd", cwd: "/workspace", timeoutMs: 0, outputByteLimit: 1 },
			{ source: "pwd", cwd: "/workspace", timeoutMs: 120_001, outputByteLimit: 1 },
			{ source: "pwd", cwd: "/workspace", timeoutMs: 1, outputByteLimit: 4 * 1024 * 1024 + 1 },
		]) {
			const response = await request(`/v1/workspaces/${WORKSPACE_ID}/exec`, { method: "POST", body });
			expect([400, 413]).toContain(response.status);
		}
		expect(namespace.names).toEqual([]);
	});
});

async function request(
	path: string,
	options: {
		method?: string;
		body?: unknown;
		rawBody?: string;
		authenticated?: boolean;
		headers?: HeadersInit;
	} = {},
): Promise<Response> {
	const headers = new Headers(options.headers);
	if (options.authenticated !== false) headers.set("authorization", `Bearer ${BEARER}`);
	let body = options.rawBody;
	if (options.body !== undefined) body = JSON.stringify(options.body);
	if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
	return worker.fetch(
		new Request(`https://gateway.example${path}`, { method: options.method ?? "GET", headers, body }),
		env,
	);
}

async function makePayload(path: string, content: string): Promise<FilePayload> {
	const bytes = new TextEncoder().encode(content);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return {
		path,
		sha256: await sha256Hex(bytes),
		byteLength: bytes.byteLength,
		contentBase64: btoa(binary),
	};
}
