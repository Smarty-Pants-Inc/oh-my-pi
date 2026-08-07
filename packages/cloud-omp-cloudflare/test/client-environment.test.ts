import { afterEach, describe, expect, it, jest } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientBridgeCreateTerminalParams } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { CloudflareEnvironmentDependencies } from "../src/client/environment";
import { CloudOmpEnvironmentError, createCloudflareEnvironmentProvider } from "../src/client/environment";
import {
	CLOUD_OMP_WORKSPACE_TTL_MS,
	type CreateWorkspaceRequest,
	type ExecSnapshot,
	type FilePayload,
	type WorkspaceState,
} from "../src/protocol";

const WORKSPACE_ID = "0123456789abcdef0123456789abcdef";
const EXEC_ID = "abcdef0123456789abcdef0123456789";
const BEARER = "ordinary-environment-bearer";
const temporaryRoots: string[] = [];

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Cloudflare execution environment provider", () => {
	it("retries acquisition once with the identical client ID and seed body", async () => {
		const fixture = await workspaceFixture();
		const puts: Array<{ path: string; body: string }> = [];
		let putAttempts = 0;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			if (request.method === "PUT" && path === `/v1/workspaces/${WORKSPACE_ID}`) {
				puts.push({ path, body: await request.text() });
				putAttempts += 1;
				if (putAttempts === 1) throw new Error("transport lost after send");
				return Response.json(
					{ workspaceId: WORKSPACE_ID, remoteRoot: "/workspace", expiresAt: "2026-08-04T00:30:00.000Z" },
					{ status: 201 },
				);
			}
			if (request.method === "DELETE" && path === `/v1/workspaces/${WORKSPACE_ID}`)
				return new Response(null, { status: 204 });
			throw new Error("unexpected route");
		};
		const provider = makeProvider(fetch, fixture.auditRoot);
		const lease = await provider.acquire(request(fixture.sourceRoot));
		expect(puts).toHaveLength(2);
		expect(puts[0]).toEqual(puts[1]);
		expect(Object.isFrozen(lease)).toBe(true);
		expect(Object.isFrozen(lease.bridge)).toBe(true);
		const authority = lease.releaseAuthority;
		expect(Object.isFrozen(authority)).toBe(true);
		expect(Object.isFrozen(authority.provider)).toBe(true);
		expect(Object.isFrozen(authority.lease)).toBe(true);
		expect(Object.isFrozen(authority.fence)).toBe(true);
		expect(Object.isFrozen(authority.request)).toBe(true);
		expect(authority.provider.id).toBe(authority.lease.replica.providerId);
		expect(authority.fence.fenceId).toBe(authority.lease.fenceId);
		expect(authority.request.replica).toEqual(authority.lease.replica);
		expect(authority.request.leaseId).toBe(authority.lease.leaseId);
		const receipt = await lease.release();
		expect(receipt).toEqual({
			status: "released",
			request: {
				requestId: authority.request.requestId,
				requestSha256: authority.request.requestSha256,
				parentOperationId: authority.request.parentOperationId,
			},
			replica: authority.lease.replica,
			leaseId: authority.lease.leaseId,
			compute: "stopped",
		});
	});

	it("performs one best-effort DELETE after unresolved acquisition", async () => {
		const fixture = await workspaceFixture();
		const calls: string[] = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			calls.push(`${request.method} ${new URL(request.url).pathname}`);
			if (request.method === "PUT") throw new Error("raw seed and bearer must not escape");
			return new Response(null, { status: 204 });
		};
		const provider = makeProvider(fetch, fixture.auditRoot);
		let failure: Error | undefined;
		try {
			await provider.acquire(request(fixture.sourceRoot));
		} catch (error) {
			failure = error as Error;
		}
		expect(failure).toBeInstanceOf(CloudOmpEnvironmentError);
		expect(failure?.message).not.toContain(BEARER);
		expect(failure?.message).not.toContain(fixture.sourceRoot);
		expect(calls).toEqual([
			`PUT /v1/workspaces/${WORKSPACE_ID}`,
			`PUT /v1/workspaces/${WORKSPACE_ID}`,
			`DELETE /v1/workspaces/${WORKSPACE_ID}`,
		]);
	});

	it("holds ambiguous cleanup until the validated workspace expiry", async () => {
		const fixture = await workspaceFixture();
		jest.useFakeTimers();
		jest.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
		try {
			const expiresAt = new Date(Date.now() + 1_000).toISOString();
			let workspacePuts = 0;
			let workspaceDeletes = 0;
			let sentinelWrites = 0;
			const fetch: typeof globalThis.fetch = async (input, init) => {
				const request = new Request(input, init);
				const path = new URL(request.url).pathname;
				if (request.method === "PUT" && path === `/v1/workspaces/${WORKSPACE_ID}`) {
					workspacePuts += 1;
					return Response.json(
						{ workspaceId: WORKSPACE_ID, remoteRoot: "/workspace", expiresAt },
						{ status: 201 },
					);
				}
				if (request.method === "PUT" && path.endsWith("/files")) {
					sentinelWrites += 1;
					if (sentinelWrites === 1) throw new Error("lost sentinel response");
					return Response.json(await request.json());
				}
				if (request.method === "DELETE" && path === `/v1/workspaces/${WORKSPACE_ID}`) {
					workspaceDeletes += 1;
					if (workspaceDeletes === 1) throw new Error("lost cleanup response");
					return new Response(null, { status: 204 });
				}
				throw new Error("unexpected route");
			};
			const provider = makeProvider(fetch, fixture.auditRoot, { testRemoteSentinel: true });
			await expect(provider.acquire(request(fixture.sourceRoot))).rejects.toMatchObject({
				code: "TRANSPORT_FAILURE",
			});

			const nextLease = provider.acquire(request(fixture.sourceRoot));
			await Promise.resolve();
			expect(workspacePuts).toBe(1);
			jest.advanceTimersByTime(999);
			await Promise.resolve();
			expect(workspacePuts).toBe(1);
			jest.advanceTimersByTime(1);
			const lease = await nextLease;
			expect(workspacePuts).toBe(2);
			await lease.release();
		} finally {
			jest.useRealTimers();
		}
	});

	it("holds unobserved same-ID acquisition ambiguity through the fixed workspace TTL", async () => {
		const fixture = await workspaceFixture();
		jest.useFakeTimers();
		jest.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
		try {
			let workspacePuts = 0;
			let workspaceDeletes = 0;
			const fetch: typeof globalThis.fetch = async (input, init) => {
				const request = new Request(input, init);
				const path = new URL(request.url).pathname;
				if (request.method === "PUT" && path === `/v1/workspaces/${WORKSPACE_ID}`) {
					workspacePuts += 1;
					if (workspacePuts <= 2) throw new Error("lost workspace response");
					return Response.json(
						{
							workspaceId: WORKSPACE_ID,
							remoteRoot: "/workspace",
							expiresAt: new Date(Date.now() + CLOUD_OMP_WORKSPACE_TTL_MS).toISOString(),
						},
						{ status: 201 },
					);
				}
				if (request.method === "DELETE" && path === `/v1/workspaces/${WORKSPACE_ID}`) {
					workspaceDeletes += 1;
					if (workspaceDeletes === 1) throw new Error("lost cleanup response");
					return new Response(null, { status: 204 });
				}
				throw new Error("unexpected route");
			};
			const provider = makeProvider(fetch, fixture.auditRoot);
			await expect(provider.acquire(request(fixture.sourceRoot))).rejects.toMatchObject({
				code: "TRANSPORT_FAILURE",
			});
			expect(workspacePuts).toBe(2);
			expect(workspaceDeletes).toBe(1);

			const nextLease = provider.acquire(request(fixture.sourceRoot));
			await Promise.resolve();
			jest.advanceTimersByTime(CLOUD_OMP_WORKSPACE_TTL_MS - 1);
			await Promise.resolve();
			expect(workspacePuts).toBe(2);
			jest.advanceTimersByTime(1);
			const lease = await nextLease;
			expect(workspacePuts).toBe(3);
			await lease.release();
		} finally {
			jest.useRealTimers();
		}
	});

	it("holds an ambiguous normal release until expiry and frees confirmed releases immediately", async () => {
		const fixture = await workspaceFixture();
		jest.useFakeTimers();
		jest.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
		try {
			const expiresAt = new Date(Date.now() + 1_000).toISOString();
			let workspacePuts = 0;
			let workspaceDeletes = 0;
			const fetch: typeof globalThis.fetch = async (input, init) => {
				const request = new Request(input, init);
				const path = new URL(request.url).pathname;
				if (request.method === "PUT" && path === `/v1/workspaces/${WORKSPACE_ID}`) {
					workspacePuts += 1;
					return Response.json(
						{ workspaceId: WORKSPACE_ID, remoteRoot: "/workspace", expiresAt },
						{ status: 201 },
					);
				}
				if (request.method === "DELETE" && path === `/v1/workspaces/${WORKSPACE_ID}`) {
					workspaceDeletes += 1;
					if (workspaceDeletes <= 2) throw new Error("lost release response");
					return new Response(null, { status: 204 });
				}
				throw new Error("unexpected route");
			};
			const provider = makeProvider(fetch, fixture.auditRoot);
			const firstLease = await provider.acquire(request(fixture.sourceRoot));
			await expect(firstLease.release()).rejects.toMatchObject({ code: "TRANSPORT_FAILURE" });
			expect(workspaceDeletes).toBe(2);

			const nextLease = provider.acquire(request(fixture.sourceRoot));
			await Promise.resolve();
			expect(workspacePuts).toBe(1);
			jest.advanceTimersByTime(999);
			await Promise.resolve();
			expect(workspacePuts).toBe(1);
			jest.advanceTimersByTime(1);
			const secondLease = await nextLease;
			expect(workspacePuts).toBe(2);
			await secondLease.release();

			const thirdLease = await provider.acquire(request(fixture.sourceRoot));
			expect(workspacePuts).toBe(3);
			await thirdLease.release();
		} finally {
			jest.useRealTimers();
		}
	});

	it("does not free a lease slot after a definite release failure", async () => {
		const fixture = await workspaceFixture();
		jest.useFakeTimers();
		jest.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
		try {
			let workspacePuts = 0;
			const fetch: typeof globalThis.fetch = async (input, init) => {
				const request = new Request(input, init);
				const path = new URL(request.url).pathname;
				if (request.method === "PUT" && path === `/v1/workspaces/${WORKSPACE_ID}`) {
					workspacePuts += 1;
					return Response.json(
						{
							workspaceId: WORKSPACE_ID,
							remoteRoot: "/workspace",
							expiresAt: new Date(Date.now() + 1_000).toISOString(),
						},
						{ status: 201 },
					);
				}
				if (request.method === "DELETE" && path === `/v1/workspaces/${WORKSPACE_ID}`) {
					return Response.json({ error: { code: "workspace_busy", message: "still live" } }, { status: 409 });
				}
				throw new Error("unexpected route");
			};
			const provider = makeProvider(fetch, fixture.auditRoot);
			const lease = await provider.acquire(request(fixture.sourceRoot));
			await expect(lease.release()).rejects.toMatchObject({
				code: "REMOTE_ERROR",
				kind: "http",
				stage: "release",
				status: 409,
			});

			const controller = new AbortController();
			const waitingLease = provider.acquire({ ...request(fixture.sourceRoot), signal: controller.signal });
			jest.advanceTimersByTime(1_000);
			await Promise.resolve();
			expect(workspacePuts).toBe(1);
			controller.abort();
			await expect(waitingLease).rejects.toMatchObject({ code: "ABORTED" });
		} finally {
			jest.useRealTimers();
		}
	});

	it("creates the test sentinel only after seed upload and before returning the lease", async () => {
		const fixture = await workspaceFixture();
		const order: string[] = [];
		let sentinelBody: FilePayload | undefined;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			if (request.method === "PUT" && path === `/v1/workspaces/${WORKSPACE_ID}`) {
				order.push("seed");
				return Response.json(
					{ workspaceId: WORKSPACE_ID, remoteRoot: "/workspace", expiresAt: "2026-08-04T00:30:00.000Z" },
					{ status: 201 },
				);
			}
			if (request.method === "PUT" && path.endsWith("/files")) {
				order.push("sentinel");
				sentinelBody = (await request.json()) as FilePayload;
				return Response.json(sentinelBody);
			}
			if (request.method === "DELETE") return new Response(null, { status: 204 });
			throw new Error("unexpected route");
		};
		const provider = makeProvider(fetch, fixture.auditRoot, { testRemoteSentinel: true });
		const lease = await provider.acquire(request(fixture.sourceRoot));
		expect(order).toEqual(["seed", "sentinel"]);
		expect(sentinelBody?.path).toBe("remote-only.txt");
		expect(Buffer.from(sentinelBody!.contentBase64, "base64").toString("utf8")).toBe(
			"remote sentinel from cloud-omp fixture\n",
		);
		await lease.release();
	});

	it("routes read/write and strict bash handles over same-ID protocol without command replay", async () => {
		const fixture = await workspaceFixture();
		const execPosts: unknown[] = [];
		const routes: string[] = [];
		let fileContent = "seeded text\n";
		let snapshot: ExecSnapshot = {
			execId: EXEC_ID,
			status: "completed",
			output: "remote output\n",
			truncated: false,
			sync: "complete",
			exitCode: 0,
			signal: null,
		};
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			routes.push(`${request.method} ${path}`);
			if (request.method === "PUT" && path === `/v1/workspaces/${WORKSPACE_ID}`) {
				return Response.json(
					{ workspaceId: WORKSPACE_ID, remoteRoot: "/workspace", expiresAt: "2026-08-04T00:30:00.000Z" },
					{ status: 201 },
				);
			}
			if (request.method === "POST" && path.endsWith("/files/read"))
				return Response.json(payload("seeded.txt", fileContent));
			if (request.method === "PUT" && path.endsWith("/files")) {
				const body = (await request.json()) as FilePayload;
				fileContent = Buffer.from(body.contentBase64, "base64").toString("utf8");
				return Response.json(body);
			}
			if (request.method === "POST" && path.endsWith("/exec")) {
				execPosts.push(await request.json());
				return Response.json({ execId: EXEC_ID }, { status: 201 });
			}
			if (request.method === "GET" && path.endsWith(`/exec/${EXEC_ID}`)) return Response.json(snapshot);
			if (request.method === "POST" && path.endsWith(`/exec/${EXEC_ID}/kill`)) {
				snapshot = { ...snapshot, status: "cancelled", exitCode: null, signal: "SIGTERM" };
				return Response.json(snapshot);
			}
			if (request.method === "DELETE") return new Response(null, { status: 204 });
			throw new Error("unexpected route");
		};
		const provider = makeProvider(fetch, fixture.auditRoot);
		const lease = await provider.acquire(request(fixture.sourceRoot));
		expect(await lease.bridge.readTextFile({ path: "/workspace/seeded.txt" })).toBe("seeded text\n");
		await lease.bridge.writeTextFile({ path: "/workspace/seeded.txt", content: "changed remotely\n" });
		const terminal = await lease.bridge.createTerminal(terminalRequest("printf remote", 42_000));
		expect(await terminal.currentOutput()).toMatchObject({ output: "remote output\n", truncated: false });
		expect(await terminal.waitForExit()).toEqual({ exitCode: 0, signal: null });
		await terminal.kill();
		await terminal.release();
		expect(execPosts).toEqual([
			{ source: "printf remote", cwd: "/workspace", timeoutMs: 42_000, outputByteLimit: 4 * 1024 * 1024 },
		]);
		expect(routes.filter(route => route === `POST /v1/workspaces/${WORKSPACE_ID}/exec`)).toHaveLength(1);
		await lease.release();

		const audit = await readFile(join(fixture.auditRoot, "audit.jsonl"), "utf8");
		expect(audit).not.toContain("printf remote");
		expect(audit).not.toContain("remote output");
		expect(audit).not.toContain("changed remotely");
		expect(audit).not.toContain(BEARER);
	});

	it("rejects non-bash and environment-bearing terminal requests before remote mutation", async () => {
		const fixture = await workspaceFixture();
		let execAttempts = 0;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			if (request.method === "PUT") {
				return Response.json(
					{ workspaceId: WORKSPACE_ID, remoteRoot: "/workspace", expiresAt: "2026-08-04T00:30:00.000Z" },
					{ status: 201 },
				);
			}
			if (request.method === "POST" && path.endsWith("/exec")) execAttempts += 1;
			if (request.method === "DELETE") return new Response(null, { status: 204 });
			throw new Error("unexpected route");
		};
		const lease = await makeProvider(fetch, fixture.auditRoot).acquire(request(fixture.sourceRoot));
		await expect(
			lease.bridge.createTerminal({ ...terminalRequest("echo safe"), command: "/usr/bin/env" }),
		).rejects.toMatchObject({ code: "INVALID_TERMINAL_REQUEST" });
		await expect(
			lease.bridge.createTerminal({
				...terminalRequest("echo safe"),
				env: [{ name: "SECRET", value: "must-not-cross" }],
			}),
		).rejects.toMatchObject({ code: "INVALID_TERMINAL_REQUEST" });
		await expect(
			lease.bridge.createTerminal({
				command: "/bin/bash",
				args: ["--noprofile", "--norc", "-c", "echo safe"],
				cwd: "/workspace",
				outputByteLimit: 4 * 1024 * 1024,
			}),
		).rejects.toMatchObject({ code: "INVALID_TERMINAL_REQUEST" });
		await expect(lease.bridge.createTerminal(terminalRequest("echo safe", 120_001))).rejects.toMatchObject({
			code: "INVALID_TERMINAL_REQUEST",
		});
		expect(execAttempts).toBe(0);
		await lease.release();
	});

	it("rejects snapshots larger than the terminal-specific output limit", async () => {
		const fixture = await workspaceFixture();
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			if (request.method === "PUT") {
				return Response.json(
					{ workspaceId: WORKSPACE_ID, remoteRoot: "/workspace", expiresAt: "2026-08-04T00:30:00.000Z" },
					{ status: 201 },
				);
			}
			if (request.method === "POST" && path.endsWith("/exec"))
				return Response.json({ execId: EXEC_ID }, { status: 201 });
			if (request.method === "GET" && path.endsWith(`/exec/${EXEC_ID}`)) {
				return Response.json({
					execId: EXEC_ID,
					status: "running",
					output: "123456789",
					truncated: true,
					sync: "pending",
				});
			}
			if (request.method === "DELETE") return new Response(null, { status: 204 });
			throw new Error("unexpected route");
		};
		const lease = await makeProvider(fetch, fixture.auditRoot).acquire(request(fixture.sourceRoot));
		const terminal = await lease.bridge.createTerminal({ ...terminalRequest("echo bounded"), outputByteLimit: 8 });
		await expect(terminal.currentOutput()).rejects.toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
		await terminal.release();
		await lease.release();
	});

	it("never retries a possibly-started command after transport loss", async () => {
		const fixture = await workspaceFixture();
		let execAttempts = 0;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			if (request.method === "PUT" && path === `/v1/workspaces/${WORKSPACE_ID}`) {
				return Response.json(
					{ workspaceId: WORKSPACE_ID, remoteRoot: "/workspace", expiresAt: "2026-08-04T00:30:00.000Z" },
					{ status: 201 },
				);
			}
			if (request.method === "POST" && path.endsWith("/exec")) {
				execAttempts += 1;
				throw new Error("secret raw command was possibly started");
			}
			if (request.method === "DELETE") return new Response(null, { status: 204 });
			throw new Error("unexpected route");
		};
		const provider = makeProvider(fetch, fixture.auditRoot);
		const lease = await provider.acquire(request(fixture.sourceRoot));
		let failure: Error | undefined;
		try {
			await lease.bridge.createTerminal(terminalRequest("secret raw command"));
		} catch (error) {
			failure = error as Error;
		}
		expect(execAttempts).toBe(1);
		expect(failure?.message).not.toContain("secret raw command");
		await lease.release();
	});

	it("syncs the real manifest and releases the workspace once", async () => {
		const fixture = await workspaceFixture();
		let workspaceDeletes = 0;
		let remoteManifest: { rootSha256: string; files: CreateWorkspaceRequest["files"] } | undefined;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			if (request.method === "PUT") {
				const seed = (await request.json()) as CreateWorkspaceRequest;
				remoteManifest = { rootSha256: seed.seedRootSha256, files: seed.files };
				return Response.json(
					{ workspaceId: WORKSPACE_ID, remoteRoot: "/workspace", expiresAt: "2026-08-04T00:30:00.000Z" },
					{ status: 201 },
				);
			}
			if (request.method === "POST" && path.endsWith("/quiesce")) return Response.json(quiesced());
			if (request.method === "GET" && path.endsWith("/manifest")) {
				return Response.json({
					phase: "quiesced",
					rootSha256: remoteManifest?.rootSha256,
					files: remoteManifest?.files.map(({ path: filePath, sha256, byteLength }) => ({
						path: filePath,
						sha256,
						byteLength,
					})),
				});
			}
			if (request.method === "DELETE" && path === `/v1/workspaces/${WORKSPACE_ID}`) {
				workspaceDeletes += 1;
				return new Response(null, { status: 204 });
			}
			throw new Error("unexpected route");
		};
		const lease = await makeProvider(fetch, fixture.auditRoot).acquire(request(fixture.sourceRoot));
		await lease.syncBack();
		const [firstRelease, secondRelease] = await Promise.all([lease.release(), lease.release()]);
		expect(secondRelease).toBe(firstRelease);
		expect(firstRelease).toMatchObject({
			status: "released",
			leaseId: lease.releaseAuthority.lease.leaseId,
			compute: "stopped",
		});
		expect(workspaceDeletes).toBe(1);
	});
});

function makeProvider(
	fetch: typeof globalThis.fetch,
	auditPath: string,
	config: { testRemoteSentinel?: boolean } = {},
) {
	return createCloudflareEnvironmentProvider(
		{
			endpoint: "https://gateway.example.test",
			bearer: BEARER,
			auditPath: join(auditPath, "audit.jsonl"),
			...config,
		},
		dependenciesFor(fetch),
	);
}

function dependenciesFor(fetch: typeof globalThis.fetch): CloudflareEnvironmentDependencies {
	return { fetch, randomId: () => WORKSPACE_ID };
}

function request(sourceRoot: string) {
	return { taskId: "task-id", runId: "run-id", sourceRoot };
}

function terminalRequest(source: string, timeoutMs = 120_000): ClientBridgeCreateTerminalParams {
	return {
		command: "/bin/bash",
		args: ["--noprofile", "--norc", "-c", source],
		cwd: "/workspace",
		timeoutMs,
		outputByteLimit: 4 * 1024 * 1024,
	};
}

function payload(path: string, content: string): FilePayload {
	const bytes = Buffer.from(content, "utf8");
	return {
		path,
		sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
		byteLength: bytes.byteLength,
		contentBase64: bytes.toString("base64"),
	};
}

function quiesced(): WorkspaceState {
	return { phase: "quiesced", activeExecutions: 0, pendingSyncs: 0, exhaustedSyncs: 0 };
}

async function workspaceFixture(): Promise<{ sourceRoot: string; auditRoot: string }> {
	const root = await mkdtemp(join(tmpdir(), "cloud-omp-environment-test-"));
	temporaryRoots.push(root);
	const sourceRoot = await mkdtemp(join(root, "source-"));
	const auditRoot = await mkdtemp(join(root, "audit-"));
	await writeFile(join(sourceRoot, "seeded.txt"), "seeded text\n");
	const git = Bun.spawn(["git", "init", "--quiet"], { cwd: sourceRoot, stdout: "ignore", stderr: "ignore" });
	if ((await git.exited) !== 0) throw new Error("git init failed");
	return { sourceRoot, auditRoot };
}
