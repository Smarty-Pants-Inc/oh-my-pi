import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FilePayload } from "../../src/protocol";

const FIXTURE_ROOT = path.resolve(import.meta.dir, "../fixtures/omp-child");
const PACKAGE_ROOT = path.resolve(import.meta.dir, "../..");
const OMP_ROOT = path.resolve(PACKAGE_ROOT, "../..");

export const FAKE_GATEWAY_BEARER = "cloud-omp-fake-gateway-bearer";
export const REMOTE_ROOT = "/workspace";
export const REMOTE_SENTINEL_PATH = "remote-only.txt";
export const REMOTE_SENTINEL_CONTENT = "remote sentinel from cloud-omp fixture\n";

type FakeFile = { content: Uint8Array; sha256: string };
type FakeWorkspace = {
	files: Map<string, FakeFile>;
	phase: "active" | "quiescing" | "quiesced" | "released";
	seedRootSha256: string;
	expiresAt: string;
	executions: Map<string, Record<string, unknown>>;
};

/**
 * An in-memory `/v1` transport for adapter tests. It intentionally never starts
 * a process, so command tests cannot accidentally exercise a local shell.
 */
export class FakeCloudflareGateway {
	readonly #workspaces = new Map<string, FakeWorkspace>();
	readonly #adminBearer?: string;

	constructor(options: { adminBearer?: string } = {}) {
		this.#adminBearer = options.adminBearer;
	}

	async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const request = input instanceof Request ? input : new Request(input, init);
		const segments = new URL(request.url).pathname.split("/").filter(Boolean);
		if (segments[0] !== "v1") return error(404, "not_found", "route not found");
		if (segments[1] === "admin") return this.#handleAdmin(request, segments);
		if (request.headers.get("authorization") !== `Bearer ${FAKE_GATEWAY_BEARER}`) {
			return error(401, "unauthorized", "authentication is required");
		}
		if (segments.length === 2 && segments[1] === "health" && request.method === "GET") return json(200, { ok: true });
		if (segments[1] !== "workspaces" || !isWireId(segments[2] ?? ""))
			return error(404, "not_found", "route not found");

		const workspaceId = segments[2]!;
		if (segments.length === 3 && request.method === "PUT") return this.#create(workspaceId, request);
		const workspace = this.#workspaces.get(workspaceId);
		if (!workspace) return error(410, "workspace_gone", "workspace does not exist");
		if (segments.length === 3 && request.method === "DELETE") {
			workspace.phase = "released";
			workspace.executions.clear();
			return new Response(null, { status: 204 });
		}
		if (workspace.phase === "released") return error(410, "workspace_gone", "workspace is released");

		const tail = segments.slice(3);
		if (tail.join("/") === "files/read" && request.method === "POST") return this.#readFile(workspace, request);
		if (tail.join("/") === "files" && request.method === "PUT") return this.#writeFile(workspace, request);
		if (tail.join("/") === "manifest" && request.method === "GET") return json(200, await manifestFor(workspace));
		if (tail.join("/") === "quiesce" && request.method === "POST") {
			if (workspace.executions.size > 0) return error(409, "execution_active", "an execution is active");
			workspace.phase = "quiesced";
			return json(200, { phase: workspace.phase });
		}
		if (tail[0] === "exec") return this.#handleExec(workspace, request, tail.slice(1));
		return error(404, "not_found", "route not found");
	}

	async #create(workspaceId: string, request: Request): Promise<Response> {
		const body = await readJson(request);
		if (
			typeof body !== "object" ||
			body === null ||
			Array.isArray(body) ||
			!("files" in body) ||
			!Array.isArray(body.files) ||
			!("seedRootSha256" in body) ||
			typeof body.seedRootSha256 !== "string"
		) {
			return error(400, "invalid_request", "invalid workspace seed");
		}
		const files = new Map<string, FakeFile>();
		for (const candidate of body.files) {
			if (
				typeof candidate !== "object" ||
				candidate === null ||
				Array.isArray(candidate) ||
				!("path" in candidate) ||
				!isCanonicalPath(candidate.path) ||
				!("contentBase64" in candidate) ||
				typeof candidate.contentBase64 !== "string" ||
				!("sha256" in candidate) ||
				typeof candidate.sha256 !== "string" ||
				!("byteLength" in candidate) ||
				typeof candidate.byteLength !== "number"
			) {
				return error(400, "invalid_request", "invalid seed file");
			}
			const content = new Uint8Array(Buffer.from(candidate.contentBase64, "base64"));
			const sha256 = await sha256Hex(content);
			if (candidate.sha256 !== sha256 || candidate.byteLength !== content.byteLength || files.has(candidate.path)) {
				return error(400, "invalid_request", "invalid seed file digest");
			}
			files.set(candidate.path, { content, sha256 });
		}
		const seedRootSha256 = await rootDigest(files);
		if (seedRootSha256 !== body.seedRootSha256) return error(400, "invalid_request", "invalid seed root digest");
		const existing = this.#workspaces.get(workspaceId);
		if (existing) {
			return existing.seedRootSha256 === seedRootSha256
				? json(200, workspaceResponse(workspaceId, existing.expiresAt))
				: error(409, "seed_conflict", "workspace ID was seeded differently");
		}
		const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
		this.#workspaces.set(workspaceId, {
			files,
			phase: "active",
			seedRootSha256,
			expiresAt,
			executions: new Map(),
		});
		return json(201, workspaceResponse(workspaceId, expiresAt));
	}

	async #readFile(workspace: FakeWorkspace, request: Request): Promise<Response> {
		const body = await readJson(request);
		if (
			typeof body !== "object" ||
			body === null ||
			Array.isArray(body) ||
			!("path" in body) ||
			typeof body.path !== "string"
		) {
			return error(400, "invalid_request", "invalid file read request");
		}
		const file = workspace.files.get(body.path);
		if (!file) return error(404, "file_not_found", "file does not exist");
		return json(200, payloadFor(body.path, file));
	}

	async #writeFile(workspace: FakeWorkspace, request: Request): Promise<Response> {
		if (workspace.phase !== "active") return error(409, "workspace_not_active", "workspace is not active");
		const body = await readJson(request);
		if (
			typeof body !== "object" ||
			body === null ||
			Array.isArray(body) ||
			!("path" in body) ||
			!isCanonicalPath(body.path) ||
			!("contentBase64" in body) ||
			typeof body.contentBase64 !== "string" ||
			!("sha256" in body) ||
			typeof body.sha256 !== "string" ||
			!("byteLength" in body) ||
			typeof body.byteLength !== "number"
		) {
			return error(400, "invalid_request", "invalid file payload");
		}
		const content = new Uint8Array(Buffer.from(body.contentBase64, "base64"));
		const sha256 = await sha256Hex(content);
		if (body.sha256 !== sha256 || body.byteLength !== content.byteLength)
			return error(400, "invalid_request", "invalid file digest");
		workspace.files.set(body.path, { content, sha256 });
		return json(200, payloadFor(body.path, workspace.files.get(body.path)!));
	}

	async #handleExec(workspace: FakeWorkspace, request: Request, tail: string[]): Promise<Response> {
		if (tail.length === 0 && request.method === "POST") {
			if (workspace.phase !== "active" || workspace.executions.size > 0) {
				return error(409, "execution_active", "an execution is active");
			}
			const body = await readJson(request);
			if (
				typeof body !== "object" ||
				body === null ||
				Array.isArray(body) ||
				!("source" in body) ||
				typeof body.source !== "string" ||
				!("cwd" in body) ||
				typeof body.cwd !== "string"
			) {
				return error(400, "invalid_request", "invalid execution request");
			}
			const execId = randomHexId();
			workspace.executions.set(execId, {
				execId,
				status: "completed",
				output: "",
				truncated: false,
				sync: "complete",
				exitCode: 0,
				signal: null,
			});
			return json(201, { execId });
		}
		const execId = tail[0];
		if (!execId || !isWireId(execId)) return error(404, "not_found", "route not found");
		const execution = workspace.executions.get(execId);
		if (!execution) return error(404, "exec_not_found", "execution does not exist");
		if (tail.length === 1 && request.method === "GET") return json(200, execution);
		if (tail.length === 2 && tail[1] === "kill" && request.method === "POST") {
			execution.status = "cancelled";
			execution.exitCode = null;
			return json(200, execution);
		}
		if (tail.length === 1 && request.method === "DELETE") {
			workspace.executions.delete(execId);
			return new Response(null, { status: 204 });
		}
		return error(404, "not_found", "route not found");
	}

	async #handleAdmin(request: Request, segments: string[]): Promise<Response> {
		if (!this.#adminBearer || request.headers.get("authorization") !== `Bearer ${this.#adminBearer}`) {
			return error(
				this.#adminBearer ? 401 : 404,
				this.#adminBearer ? "unauthorized" : "not_found",
				"route unavailable",
			);
		}
		const workspaceId = segments[3];
		if (segments.length !== 5 || segments[2] !== "workspaces" || segments[4] !== "restart" || !workspaceId) {
			return error(404, "not_found", "route not found");
		}
		const workspace = this.#workspaces.get(workspaceId);
		if (workspace?.phase !== "active" || workspace.executions.size > 0) {
			return error(409, "restart_conflict", "workspace cannot restart");
		}
		return json(200, { phase: workspace.phase });
	}
}

export interface MaterializedFixture {
	root: string;
	expectedFiles: Readonly<Record<string, string>>;
	dispose(): Promise<void>;
}

/** Copies reviewed fixture bytes, then creates a disposable repository with one clean initial commit. */
export async function materializeOmpChildFixture(): Promise<MaterializedFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-omp-omp-child-"));
	await fs.cp(FIXTURE_ROOT, root, { recursive: true });
	await runGit(root, ["init", "-q", "-b", "main"]);
	await runGit(root, ["config", "user.email", "cloud-omp-fixture@example.invalid"]);
	await runGit(root, ["config", "user.name", "Cloud OMP Fixture"]);
	await fs.mkdir(path.join(root, ".omp", "agents"), { recursive: true });
	await fs.copyFile(
		path.resolve(import.meta.dir, "../fixtures/omp-child-agent.md"),
		path.join(root, ".omp", "agents", "cloud-omp-e2e.md"),
	);
	await fs.writeFile(
		path.join(root, ".omp", "config.yml"),
		"task:\n  batch: false\n  isolation:\n    mode: auto\n    apply: true\n    merge: patch\n",
		"utf8",
	);
	await runGit(root, ["add", "."]);
	await runGit(root, ["commit", "-q", "-m", "fixture seed"]);
	return {
		root,
		expectedFiles: await readExpectedFiles(root),
		dispose: () => fs.rm(root, { recursive: true, force: true }),
	};
}

export function requireRealGatewayEnvironment(env: NodeJS.ProcessEnv = process.env): {
	endpoint: string;
	bearer: string;
} {
	if (env.CLOUD_OMP_RUN_REAL_GATEWAY !== "1")
		throw new Error("real gateway tests require CLOUD_OMP_RUN_REAL_GATEWAY=1");
	return requireGatewayCredentials(env);
}

export function requireRealOmpChildEnvironment(env: NodeJS.ProcessEnv = process.env): {
	endpoint: string;
	bearer: string;
} {
	if (env.CLOUD_OMP_RUN_REAL_OMP_CHILD !== "1")
		throw new Error("real OMP-child tests require CLOUD_OMP_RUN_REAL_OMP_CHILD=1");
	if (env.CLOUD_OMP_TEST_REMOTE_SENTINEL !== "1")
		throw new Error("real OMP-child tests require CLOUD_OMP_TEST_REMOTE_SENTINEL=1");
	return requireGatewayCredentials(env);
}

export async function runRealGatewayLifecycle(options: {
	endpoint: string;
	bearer: string;
	adminBearer: string;
}): Promise<{ workspaceId: string; expiresAt: string }> {
	assertNoManagementToken();
	const base = validatedEndpoint(options.endpoint);
	const unauthorized = await fetch(new URL("/v1/health", base));
	if (unauthorized.status !== 401)
		throw new Error(`unauthenticated health returned ${unauthorized.status}, expected 401`);
	const fixture = await materializeOmpChildFixture();
	try {
		const seed = await payloadFromFile(
			"seeded-file.txt",
			await fs.readFile(path.join(fixture.root, "seeded-file.txt")),
		);
		const seedRootSha256 = await rootDigest(
			new Map([
				[seed.path, { content: new Uint8Array(Buffer.from(seed.contentBase64, "base64")), sha256: seed.sha256 }],
			]),
		);
		const workspaceId = randomHexId();
		const created = await gatewayRequest(base, options.bearer, `/v1/workspaces/${workspaceId}`, "PUT", {
			auditCorrelationId: randomHexId(),
			seedRootSha256,
			files: [seed],
		});
		if (!created.ok) throw await gatewayFailure("workspace creation", created);
		const createBody = (await created.json()) as { expiresAt?: unknown };
		if (typeof createBody.expiresAt !== "string") throw new Error("workspace creation omitted expiresAt");
		const read = await gatewayRequest(base, options.bearer, `/v1/workspaces/${workspaceId}/files/read`, "POST", {
			path: seed.path,
		});
		if (!read.ok) throw await gatewayFailure("seed read", read);
		const readBody = (await read.json()) as { contentBase64?: unknown };
		if (Buffer.from(String(readBody.contentBase64), "base64").toString("utf8") !== "seeded fixture bytes\n") {
			throw new Error("seeded file did not round-trip exactly");
		}
		const write = await payloadFromFile("gateway-write.txt", Buffer.from("gateway write bytes\n"));
		const wrote = await gatewayRequest(base, options.bearer, `/v1/workspaces/${workspaceId}/files`, "PUT", write);
		if (!wrote.ok) throw await gatewayFailure("file write", wrote);
		await runGatewayExec(
			base,
			options.bearer,
			workspaceId,
			"test \"$(cat seeded-file.txt)\" = 'seeded fixture bytes' && printf 'container write bytes\\n' > container-created.txt",
		);
		await assertManifestContains(base, options.bearer, workspaceId, "container-created.txt");
		const restart = await gatewayRequest(
			base,
			options.adminBearer,
			`/v1/admin/workspaces/${workspaceId}/restart`,
			"POST",
		);
		if (!restart.ok) throw await gatewayFailure("admin restart", restart);
		await runGatewayExec(
			base,
			options.bearer,
			workspaceId,
			"test -f container-created.txt && test \"$(cat gateway-write.txt)\" = 'gateway write bytes'",
		);
		const delayedWrite = await startGatewayExec(
			base,
			options.bearer,
			workspaceId,
			"(sleep 5; printf 'late container write\\n' > late-write.txt) & printf started",
		);
		await awaitGatewayExec(base, options.bearer, workspaceId, delayedWrite);
		const slowExecution = await startGatewayExec(base, options.bearer, workspaceId, "sleep 30");
		const killed = await gatewayRequest(
			base,
			options.bearer,
			`/v1/workspaces/${workspaceId}/exec/${slowExecution}/kill`,
			"POST",
		);
		if (!killed.ok) throw await gatewayFailure("execution kill", killed);
		await awaitGatewayExec(base, options.bearer, workspaceId, slowExecution, "cancelled");
		const disposed = await gatewayRequest(
			base,
			options.bearer,
			`/v1/workspaces/${workspaceId}/exec/${slowExecution}`,
			"DELETE",
		);
		if (disposed.status !== 204) throw await gatewayFailure("execution disposal", disposed);
		const quiesced = await gatewayRequest(base, options.bearer, `/v1/workspaces/${workspaceId}/quiesce`, "POST");
		if (!quiesced.ok) throw await gatewayFailure("workspace quiesce", quiesced);
		await Bun.sleep(5_500);
		await assertManifestOmits(base, options.bearer, workspaceId, "late-write.txt");
		for (let attempt = 0; attempt < 2; attempt++) {
			const released = await gatewayRequest(base, options.bearer, `/v1/workspaces/${workspaceId}`, "DELETE");
			if (released.status !== 204) throw await gatewayFailure(`workspace release ${attempt + 1}`, released);
		}
		return { workspaceId, expiresAt: createBody.expiresAt };
	} finally {
		await fixture.dispose();
	}
}
async function runGatewayExec(base: URL, bearer: string, workspaceId: string, source: string): Promise<void> {
	const execId = await startGatewayExec(base, bearer, workspaceId, source);
	await awaitGatewayExec(base, bearer, workspaceId, execId, "completed");
}

async function startGatewayExec(base: URL, bearer: string, workspaceId: string, source: string): Promise<string> {
	const created = await gatewayRequest(base, bearer, `/v1/workspaces/${workspaceId}/exec`, "POST", {
		source,
		cwd: REMOTE_ROOT,
		timeoutMs: 120_000,
		outputByteLimit: 4 * 1024 * 1024,
	});
	if (!created.ok) throw await gatewayFailure("execution creation", created);
	const payload: unknown = await created.json();
	if (
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload) ||
		!("execId" in payload) ||
		typeof payload.execId !== "string" ||
		!isWireId(payload.execId)
	) {
		throw new Error("execution creation omitted a valid execId");
	}
	return payload.execId;
}

async function awaitGatewayExec(
	base: URL,
	bearer: string,
	workspaceId: string,
	execId: string,
	expectedStatus: "completed" | "cancelled" = "completed",
): Promise<void> {
	for (let attempt = 0; attempt < 480; attempt++) {
		const snapshot = await gatewayRequest(base, bearer, `/v1/workspaces/${workspaceId}/exec/${execId}`, "GET");
		if (!snapshot.ok) throw await gatewayFailure("execution poll", snapshot);
		const payload: unknown = await snapshot.json();
		if (
			typeof payload !== "object" ||
			payload === null ||
			Array.isArray(payload) ||
			!("status" in payload) ||
			typeof payload.status !== "string"
		) {
			throw new Error("execution poll omitted a status");
		}
		if (payload.status === "starting" || payload.status === "running") {
			await Bun.sleep(250);
			continue;
		}
		if (payload.status !== expectedStatus) {
			const output = "output" in payload && typeof payload.output === "string" ? payload.output : "";
			const exitCode = "exitCode" in payload ? String(payload.exitCode) : "missing";
			throw new Error(
				`execution ended as ${payload.status}, expected ${expectedStatus}; exitCode=${exitCode}; output=${JSON.stringify(output)}`,
			);
		}
		return;
	}
	throw new Error("execution did not settle within 120 seconds");
}

async function assertManifestContains(
	base: URL,
	bearer: string,
	workspaceId: string,
	expectedPath: string,
): Promise<void> {
	await assertManifestPath(base, bearer, workspaceId, expectedPath, true);
}

async function assertManifestOmits(
	base: URL,
	bearer: string,
	workspaceId: string,
	expectedPath: string,
): Promise<void> {
	await assertManifestPath(base, bearer, workspaceId, expectedPath, false);
}

async function assertManifestPath(
	base: URL,
	bearer: string,
	workspaceId: string,
	expectedPath: string,
	present: boolean,
): Promise<void> {
	const response = await gatewayRequest(base, bearer, `/v1/workspaces/${workspaceId}/manifest`, "GET");
	if (!response.ok) throw await gatewayFailure("manifest fetch", response);
	const payload: unknown = await response.json();
	if (
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload) ||
		!("files" in payload) ||
		!Array.isArray(payload.files)
	) {
		throw new Error("manifest omitted files");
	}
	const found = payload.files.some(
		entry =>
			typeof entry === "object" &&
			entry !== null &&
			!Array.isArray(entry) &&
			"path" in entry &&
			entry.path === expectedPath,
	);
	if (found !== present)
		throw new Error(`manifest ${present ? "did not contain" : "unexpectedly contained"} ${expectedPath}`);
}

export async function runRealOmpChildScenario(options: { model?: string } = {}): Promise<{
	fixture: MaterializedFixture;
	auditPath: string;
	exitCode: number;
	stdout: string;
	stderr: string;
}> {
	const credentials = requireRealOmpChildEnvironment();
	assertNoManagementToken();
	const fixture = await materializeOmpChildFixture();
	const auditPath = path.join(os.tmpdir(), "cloud-omp", `audit-fixture-${process.pid}-${randomHexId()}.jsonl`);
	const args = [
		path.join(OMP_ROOT, "packages/coding-agent/src/cli.ts"),
		"--no-extensions",
		"-e",
		PACKAGE_ROOT,
		"--config",
		path.join(fixture.root, ".omp", "config.yml"),
		"--print",
		...(options.model ? ["--model", options.model] : []),
		"Use exactly one top-level task with agent cloud-omp-e2e, isolated true, and execution environment. Do not do any workspace work yourself.",
	];
	try {
		const proc = Bun.spawn([process.execPath, ...args], {
			cwd: fixture.root,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				CLOUD_OMP_CLOUDFLARE_ENDPOINT: credentials.endpoint,
				CLOUD_OMP_CLOUDFLARE_BEARER: credentials.bearer,
				CLOUD_OMP_AUDIT_PATH: auditPath,
				CLOUD_OMP_TEST_REMOTE_SENTINEL: "1",
			},
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { fixture, auditPath, exitCode, stdout, stderr };
	} catch (error) {
		await fs.rm(auditPath, { force: true });
		await fixture.dispose();
		throw error;
	}
}

export async function assertFixtureBytes(fixture: MaterializedFixture): Promise<void> {
	for (const [relativePath, expected] of Object.entries(fixture.expectedFiles)) {
		const actual = await fs.readFile(path.join(fixture.root, relativePath), "utf8");
		if (actual !== expected) throw new Error(`${relativePath} did not contain the expected bytes`);
	}
}

export function assertAuditOperationOrder(
	records: readonly Record<string, unknown>[],
	expected: readonly string[],
): void {
	const observed = records
		.map(record => record.operation)
		.filter((value): value is string => typeof value === "string");
	let cursor = 0;
	for (const operation of observed) if (operation === expected[cursor]) cursor++;
	if (cursor !== expected.length)
		throw new Error(`audit did not preserve lifecycle order: expected ${expected.join(" < ")}`);
}

export async function readJsonlAudit(auditPath: string): Promise<Record<string, unknown>[]> {
	const raw = await fs.readFile(auditPath, "utf8");
	return raw
		.split("\n")
		.filter(Boolean)
		.map(line => {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
				throw new Error("audit record must be an object");
			return parsed as Record<string, unknown>;
		});
}

async function readExpectedFiles(root: string): Promise<Readonly<Record<string, string>>> {
	const parsed: unknown = JSON.parse(await fs.readFile(path.join(root, "expected-files.json"), "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error("fixture expected-files.json must be a string map");
	const expectedFiles = parsed as Record<string, unknown>;
	if (Object.values(expectedFiles).some(value => typeof value !== "string"))
		throw new Error("fixture expected-files.json must be a string map");
	return expectedFiles as Record<string, string>;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
		env: { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});
	if ((await proc.exited) !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
}

async function payloadFromFile(pathname: string, content: Uint8Array): Promise<FilePayload> {
	return {
		path: pathname,
		contentBase64: Buffer.from(content).toString("base64"),
		sha256: await sha256Hex(content),
		byteLength: content.byteLength,
	};
}

async function manifestFor(workspace: FakeWorkspace): Promise<Record<string, unknown>> {
	return {
		phase: workspace.phase,
		rootSha256: await rootDigest(workspace.files),
		files: [...workspace.files.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([pathname, file]) => ({
				path: pathname,
				sha256: file.sha256,
				byteLength: file.content.byteLength,
			})),
	};
}

function payloadFor(pathname: string, file: FakeFile): FilePayload {
	return {
		path: pathname,
		contentBase64: Buffer.from(file.content).toString("base64"),
		sha256: file.sha256,
		byteLength: file.content.byteLength,
	};
}

async function rootDigest(files: ReadonlyMap<string, FakeFile>): Promise<string> {
	const manifest = [...files.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([pathname, file]) => `${pathname}\0${file.sha256}\0${file.content.byteLength}\n`)
		.join("");
	return sha256Hex(new TextEncoder().encode(manifest));
}

async function sha256Hex(content: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", content);
	return Buffer.from(digest).toString("hex");
}

function randomHexId(): string {
	return randomBytes(16).toString("hex");
}

function isWireId(value: string): boolean {
	return /^[0-9a-f]{32}$/.test(value);
}

function isCanonicalPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value
			.split("/")
			.every(part => part !== "" && part !== "." && part !== ".." && !part.includes("\\") && !part.includes("\0"))
	);
}

function json(status: number, value: unknown): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function error(status: number, code: string, message: string): Response {
	return json(status, { error: { code, message } });
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		return undefined;
	}
}

function assertNoManagementToken(env: NodeJS.ProcessEnv = process.env): void {
	for (const name of ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"]) {
		if (env[name]) throw new Error(`${name} must not be present during a Cloudflare runtime scenario`);
	}
}

function requireGatewayCredentials(env: NodeJS.ProcessEnv): { endpoint: string; bearer: string } {
	const endpoint = env.CLOUD_OMP_CLOUDFLARE_ENDPOINT;
	const bearer = env.CLOUD_OMP_CLOUDFLARE_BEARER;
	if (!endpoint || !bearer)
		throw new Error("real Cloudflare tests require CLOUD_OMP_CLOUDFLARE_ENDPOINT and CLOUD_OMP_CLOUDFLARE_BEARER");
	validatedEndpoint(endpoint);
	return { endpoint, bearer };
}

function validatedEndpoint(value: string): URL {
	const endpoint = new URL(value);
	if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
		throw new Error(
			"CLOUD_OMP_CLOUDFLARE_ENDPOINT must be an absolute https URL without credentials, query, or fragment",
		);
	}
	return endpoint;
}

async function gatewayRequest(
	base: URL,
	bearer: string,
	pathname: string,
	method: string,
	body?: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	return fetch(new URL(pathname, base), {
		method,
		redirect: "error",
		headers: {
			authorization: `Bearer ${bearer}`,
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function gatewayFailure(operation: string, response: Response): Promise<Error> {
	return new Error(`${operation} failed with ${response.status}: ${await response.text()}`);
}

function workspaceResponse(workspaceId: string, expiresAt: string): Record<string, unknown> {
	return { workspaceId, remoteRoot: REMOTE_ROOT, expiresAt };
}
