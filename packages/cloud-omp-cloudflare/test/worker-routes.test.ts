import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type {
	CreateWorkspaceRequest,
	CreateWorkspaceResponse,
	ExecCreateResponse,
	ExecRequest,
	ExecSnapshot,
	FilePayload,
	FileReadRequest,
	ManifestResponse,
	WorkspaceState,
} from "../src/protocol.ts";
import worker, { type WorkerEnv, type WorkspaceNamespace, type WorkspaceRpc } from "../src/worker/router";
import { manifestRootSha256, sha256Hex } from "../src/worker/workspace-files";

const WORKSPACE_ID = "a".repeat(32);
const EXEC_ID = "b".repeat(32);
const AUDIT_ID = "c".repeat(32);
const ORDINARY_BEARER = "ordinary-test-bearer";
const ADMIN_BEARER = "admin-test-bearer";
let ordinaryDigest = "";
let adminDigest = "";

beforeAll(async () => {
	ordinaryDigest = await sha256Hex(new TextEncoder().encode(ORDINARY_BEARER));
	adminDigest = await sha256Hex(new TextEncoder().encode(ADMIN_BEARER));
});

class FakeWorkspace implements WorkspaceRpc {
	readonly calls: Array<{ method: string; args: unknown[] }> = [];
	readonly failures: Record<string, unknown> = {};

	async createWorkspace(clientWorkspaceId: string, request: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse> {
		this.#call("createWorkspace", clientWorkspaceId, request);
		return { workspaceId: clientWorkspaceId, remoteRoot: "/workspace", expiresAt: "2026-08-04T00:30:00.000Z" };
	}

	async readFile(request: FileReadRequest): Promise<FilePayload> {
		this.#call("readFile", request);
		return makePayload(request.path, "read-result");
	}

	async writeFile(request: FilePayload): Promise<FilePayload> {
		this.#call("writeFile", request);
		return request;
	}

	async getManifest(): Promise<ManifestResponse> {
		this.#call("getManifest");
		return { phase: "active", rootSha256: "0".repeat(64), files: [] };
	}

	async createExec(request: ExecRequest): Promise<ExecCreateResponse> {
		this.#call("createExec", request);
		return { execId: EXEC_ID };
	}

	async getExec(execId: string): Promise<ExecSnapshot> {
		this.#call("getExec", execId);
		return execSnapshot(execId);
	}

	async killExec(execId: string): Promise<ExecSnapshot> {
		this.#call("killExec", execId);
		return { ...execSnapshot(execId), status: "cancelled" };
	}

	async deleteExec(execId: string): Promise<void> {
		this.#call("deleteExec", execId);
	}

	async quiesce(): Promise<WorkspaceState> {
		this.#call("quiesce");
		return workspaceState("quiesced");
	}

	async release(): Promise<void> {
		this.#call("release");
	}

	async restartForTest(): Promise<WorkspaceState> {
		this.#call("restartForTest");
		return workspaceState("active");
	}

	#call(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
		if (Object.hasOwn(this.failures, method)) throw this.failures[method];
	}
}

class FakeNamespace implements WorkspaceNamespace {
	readonly requestedNames: string[] = [];
	readonly allocatedIds: DurableObjectId[] = [];

	constructor(readonly workspace: FakeWorkspace) {}

	idFromName(name: string): DurableObjectId {
		this.requestedNames.push(name);
		return { name } as DurableObjectId;
	}

	get(id: DurableObjectId): WorkspaceRpc {
		this.allocatedIds.push(id);
		return this.workspace;
	}
}

let workspace: FakeWorkspace;
let namespace: FakeNamespace;
let env: WorkerEnv;

beforeEach(() => {
	workspace = new FakeWorkspace();
	namespace = new FakeNamespace(workspace);
	env = {
		WORKSPACE: namespace,
		CLOUD_OMP_BEARER_SHA256: ordinaryDigest,
		CLOUD_OMP_ADMIN_BEARER_SHA256: adminDigest,
	};
});

describe("fake gateway Worker routes", () => {
	it("routes every public operation to the workspace named by the client ID", async () => {
		const seedFile = await makePayload("src/input.txt", "seeded\n");
		const seedRootSha256 = await manifestRootSha256([seedFile]);
		const createBody: CreateWorkspaceRequest = { auditCorrelationId: AUDIT_ID, seedRootSha256, files: [seedFile] };
		const create = await fetchRoute(`/v1/workspaces/${WORKSPACE_ID}`, { method: "PUT", body: createBody });
		expect(create.status).toBe(200);
		expect(await create.json()).toEqual({
			workspaceId: WORKSPACE_ID,
			remoteRoot: "/workspace",
			expiresAt: "2026-08-04T00:30:00.000Z",
		});

		const read = await fetchRoute(`/v1/workspaces/${WORKSPACE_ID}/files/read`, {
			method: "POST",
			body: { path: "src/input.txt" },
		});
		expect(read.status).toBe(200);
		expect(await read.json()).toEqual(await makePayload("src/input.txt", "read-result"));

		const writePayload = await makePayload("src/output.txt", "written\n");
		const write = await fetchRoute(`/v1/workspaces/${WORKSPACE_ID}/files`, { method: "PUT", body: writePayload });
		expect(write.status).toBe(200);
		expect(await write.json()).toEqual(writePayload);

		const manifest = await fetchRoute(`/v1/workspaces/${WORKSPACE_ID}/manifest`);
		expect(manifest.status).toBe(200);
		expect(await manifest.json()).toEqual({ phase: "active", rootSha256: "0".repeat(64), files: [] });

		const execRequest: ExecRequest = {
			source: "printf ok",
			cwd: "/workspace",
			timeoutMs: 1_000,
			outputByteLimit: 4_096,
		};
		const createExec = await fetchRoute(`/v1/workspaces/${WORKSPACE_ID}/exec`, {
			method: "POST",
			body: execRequest,
		});
		expect(createExec.status).toBe(200);
		expect(await createExec.json()).toEqual({ execId: EXEC_ID });

		const getExec = await fetchRoute(`/v1/workspaces/${WORKSPACE_ID}/exec/${EXEC_ID}`);
		expect(getExec.status).toBe(200);
		expect(await getExec.json()).toEqual(execSnapshot(EXEC_ID));

		const kill = await fetchRoute(`/v1/workspaces/${WORKSPACE_ID}/exec/${EXEC_ID}/kill`, { method: "POST" });
		expect(kill.status).toBe(200);
		expect(await kill.json()).toEqual({ ...execSnapshot(EXEC_ID), status: "cancelled" });

		const deleteExec = await fetchRoute(`/v1/workspaces/${WORKSPACE_ID}/exec/${EXEC_ID}`, { method: "DELETE" });
		expect(deleteExec.status).toBe(204);
		expect(await deleteExec.text()).toBe("");

		const quiesce = await fetchRoute(`/v1/workspaces/${WORKSPACE_ID}/quiesce`, { method: "POST" });
		expect(quiesce.status).toBe(200);
		expect(await quiesce.json()).toEqual(workspaceState("quiesced"));

		const release = await fetchRoute(`/v1/workspaces/${WORKSPACE_ID}`, { method: "DELETE" });
		expect(release.status).toBe(204);
		expect(await release.text()).toBe("");

		expect(namespace.requestedNames).toEqual(Array(10).fill(WORKSPACE_ID));
		expect(workspace.calls.map(call => call.method)).toEqual([
			"createWorkspace",
			"readFile",
			"writeFile",
			"getManifest",
			"createExec",
			"getExec",
			"killExec",
			"deleteExec",
			"quiesce",
			"release",
		]);
		expect(workspace.calls[0].args).toEqual([WORKSPACE_ID, createBody]);
	});

	it("uses the separate admin bearer and returns restart state only in test deployments", async () => {
		const ordinary = await fetchRoute(`/v1/admin/workspaces/${WORKSPACE_ID}/restart`, {
			method: "POST",
			token: ORDINARY_BEARER,
		});
		expect(ordinary.status).toBe(401);
		expect(namespace.requestedNames).toEqual([]);

		const admin = await fetchRoute(`/v1/admin/workspaces/${WORKSPACE_ID}/restart`, {
			method: "POST",
			token: ADMIN_BEARER,
		});
		expect(admin.status).toBe(200);
		expect(await admin.json()).toEqual(workspaceState("active"));
		expect(workspace.calls.at(-1)).toEqual({ method: "restartForTest", args: [] });

		const adminOnOrdinaryRoute = await fetchRoute("/v1/health", { token: ADMIN_BEARER });
		expect(adminOnOrdinaryRoute.status).toBe(401);

		const sameDigestEnv = { ...env, CLOUD_OMP_ADMIN_BEARER_SHA256: ordinaryDigest };
		const sameDigest = await fetchRoute(`/v1/admin/workspaces/${WORKSPACE_ID}/restart`, {
			method: "POST",
			token: ORDINARY_BEARER,
			overrideEnv: sameDigestEnv,
		});
		expect(sameDigest.status).toBe(401);

		const disabledEnv = { ...env, CLOUD_OMP_ADMIN_BEARER_SHA256: undefined };
		const disabled = await fetchRoute(`/v1/admin/workspaces/${WORKSPACE_ID}/restart`, {
			method: "POST",
			token: ADMIN_BEARER,
			overrideEnv: disabledEnv,
		});
		expect(disabled.status).toBe(404);
		expect(await disabled.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
	});

	it("enforces exact methods and paths without redirects or permissive CORS", async () => {
		const wrongMethod = await fetchRoute(`/v1/workspaces/${WORKSPACE_ID}/manifest`, { method: "POST" });
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get("allow")).toBe("GET");
		expect(wrongMethod.headers.get("location")).toBeNull();
		expect(wrongMethod.headers.get("access-control-allow-origin")).toBeNull();

		const trailingSlash = await fetchRoute(`/v1/workspaces/${WORKSPACE_ID}/manifest/`);
		expect(trailingSlash.status).toBe(404);
		expect(trailingSlash.headers.get("location")).toBeNull();

		const query = await fetchRoute("/v1/health?unexpected=true");
		expect(query.status).toBe(400);
		expect((await query.json()).error.code).toBe("query_not_allowed");

		const options = await fetchRoute("/v1/health", { method: "OPTIONS" });
		expect(options.status).toBe(405);
		expect(options.headers.get("access-control-allow-origin")).toBeNull();
		expect(namespace.requestedNames).toEqual([]);
	});

	it("maps domain errors safely and replaces unknown failures with a generic 500", async () => {
		workspace.failures.getManifest = Object.assign(new Error("Workspace has an active execution"), {
			name: "WorkspaceObjectError",
			status: 409,
			code: "workspace_busy",
		});
		const conflict = await fetchRoute(`/v1/workspaces/${WORKSPACE_ID}/manifest`);
		expect(conflict.status).toBe(409);
		const conflictText = await conflict.text();
		expect(JSON.parse(conflictText)).toEqual({
			error: { code: "workspace_busy", message: "Workspace has an active execution" },
		});
		expect(conflictText).not.toContain("stack");

		workspace.failures.getManifest = new Error("Bearer top-secret and file contents");
		const internal = await fetchRoute(`/v1/workspaces/${WORKSPACE_ID}/manifest`);
		expect(internal.status).toBe(500);
		const text = await internal.text();
		expect(JSON.parse(text)).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
		expect(text).not.toContain("top-secret");
		expect(text).not.toContain("stack");
	});
});

async function fetchRoute(
	path: string,
	options: {
		method?: string;
		body?: unknown;
		token?: string;
		headers?: HeadersInit;
		overrideEnv?: WorkerEnv;
	} = {},
): Promise<Response> {
	const headers = new Headers(options.headers);
	headers.set("authorization", `Bearer ${options.token ?? ORDINARY_BEARER}`);
	let body: string | undefined;
	if (options.body !== undefined) {
		body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
		if (!headers.has("content-type")) headers.set("content-type", "application/json");
	}
	return worker.fetch(
		new Request(`https://gateway.example${path}`, { method: options.method ?? "GET", headers, body }),
		options.overrideEnv ?? env,
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

function execSnapshot(execId: string): ExecSnapshot {
	return {
		execId,
		status: "completed",
		output: "done",
		truncated: false,
		sync: "complete",
		exitCode: 0,
		signal: null,
	};
}

function workspaceState(phase: WorkspaceState["phase"]): WorkspaceState {
	return { phase, activeExecutions: 0, pendingSyncs: 0, exhaustedSyncs: 0 };
}
