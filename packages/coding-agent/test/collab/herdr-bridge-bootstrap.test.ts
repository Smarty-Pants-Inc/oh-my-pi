import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	captureHerdrBridgeBootstrap,
	discoverHerdrHostBridge,
	resolveHerdrHostBridge,
	validateHerdrSocketPath,
} from "@oh-my-pi/pi-coding-agent/collab/herdr-bridge-bootstrap";

const packageDir = path.resolve(import.meta.dir, "../..");
const cliEntry = path.join(packageDir, "src", "cli.ts");

async function withDiscoveryServer<T>(
	respond: (request: Record<string, unknown>) => string,
	run: (socketPath: string, requests: Record<string, unknown>[]) => Promise<T>,
): Promise<T> {
	const root = await fs.mkdtemp(path.join("/tmp", "omp-herdr-discovery-"));
	const socketPath = path.join(root, "herdr.sock");
	const requests: Record<string, unknown>[] = [];
	let pending = "";
	const server = Bun.listen({
		unix: socketPath,
		socket: {
			open() {},
			data(socket, data) {
				pending += data.toString();
				let newline = pending.indexOf("\n");
				while (newline >= 0) {
					const line = pending.slice(0, newline);
					pending = pending.slice(newline + 1);
					if (line.trim()) {
						const request = JSON.parse(line) as Record<string, unknown>;
						requests.push(request);
						socket.write(`${respond(request)}\n`);
					}
					newline = pending.indexOf("\n");
				}
			},
			close() {},
			error() {},
		},
	});
	try {
		return await run(socketPath, requests);
	} finally {
		server.stop(true);
		await fs.rm(root, { recursive: true, force: true });
	}
}

function successResponse(request: Record<string, unknown>, paneId = "pane-1"): string {
	return JSON.stringify({
		id: request.id,
		result: {
			type: "pane_omp_bridge",
			pane_id: paneId,
			address: "127.0.0.1:4321",
			token: "fresh-bridge-token",
		},
	});
}
afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform === "win32")("Herdr bridge credential discovery", () => {
	it("preserves ordinary non-Herdr startup when no bridge locator exists", async () => {
		expect(await resolveHerdrHostBridge(undefined)).toBeUndefined();
	});

	it("does not probe an ordinary Herdr pane that lacks the managed bridge signal", async () => {
		await withDiscoveryServer(successResponse, async (socketPath, requests) => {
			const proc = Bun.spawn([process.execPath, cliEntry, "--max-time", "5d", "--print", "hello"], {
				cwd: packageDir,
				env: {
					...process.env,
					HERDR_OMP_BRIDGE: undefined,
					HERDR_OMP_BRIDGE_TOKEN: undefined,
					HERDR_OMP_GUEST_BRIDGE_TOKEN: undefined,
					HERDR_SOCKET_PATH: socketPath,
					HERDR_PANE_ID: "pane-1",
				},
				stdout: "ignore",
				stderr: "pipe",
			});
			const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

			expect(exitCode).toBe(2);
			expect(stderr).toContain("Invalid --max-time value");
			expect(stderr).not.toContain("fresh-bridge-token");
			expect(requests).toHaveLength(0);
		});
	});

	it("discovers absent credentials with the exact pane-bound local API request", async () => {
		await withDiscoveryServer(successResponse, async (socketPath, requests) => {
			const env = {
				HERDR_OMP_BRIDGE: "127.0.0.1:1234",
				HERDR_SOCKET_PATH: socketPath,
				HERDR_PANE_ID: "pane-1",
			};
			const bootstrap = captureHerdrBridgeBootstrap(env);
			const bridge = await resolveHerdrHostBridge(bootstrap.hostBridge);

			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				method: "pane.omp_bridge",
				params: { pane_id: "pane-1" },
			});
			const requestId = requests[0]?.id;
			if (typeof requestId !== "string") throw new Error("expected a string discovery request id");
			expect(requestId.length).toBeGreaterThan(0);
			expect(bridge).toMatchObject({
				address: "127.0.0.1:4321",
				token: "fresh-bridge-token",
				paneId: "pane-1",
			});
		});
	});

	it("revalidates inherited credentials against the PID-bound local API", async () => {
		await withDiscoveryServer(
			request => successResponse(request, "pane-current"),
			async (socketPath, requests) => {
				const env = {
					HERDR_OMP_BRIDGE: "127.0.0.1:1234",
					HERDR_OMP_BRIDGE_TOKEN: "retired-token",
					HERDR_SOCKET_PATH: socketPath,
					HERDR_PANE_ID: "pane-1",
				};
				const bootstrap = captureHerdrBridgeBootstrap(env);
				expect(bootstrap.hostBridge).toEqual({
					current: {
						address: "127.0.0.1:1234",
						token: "retired-token",
						paneId: "pane-1",
					},
					discovery: { socketPath, paneId: "pane-1" },
				});
				const bridge = await resolveHerdrHostBridge(bootstrap.hostBridge);

				expect(requests).toHaveLength(1);
				expect(requests[0]).toMatchObject({
					method: "pane.omp_bridge",
					params: { pane_id: "pane-1" },
				});
				expect(bridge).toMatchObject({
					address: "127.0.0.1:4321",
					token: "fresh-bridge-token",
					paneId: "pane-current",
				});
				expect(env.HERDR_OMP_BRIDGE_TOKEN).toBeUndefined();
			},
		);
	});

	it("disables inherited credentials when no authenticated discovery path is available", async () => {
		const env = {
			HERDR_OMP_BRIDGE: "127.0.0.1:1234",
			HERDR_OMP_BRIDGE_TOKEN: "current-token",
			HERDR_PANE_ID: "pane-1",
		};
		const bootstrap = captureHerdrBridgeBootstrap(env);

		expect(bootstrap.hostBridge).toBeUndefined();
		expect(await resolveHerdrHostBridge(bootstrap.hostBridge)).toBeUndefined();
	});

	it("rejects a discovery result without a usable PID-resolved pane", async () => {
		await withDiscoveryServer(
			request => successResponse(request, " "),
			async socketPath => {
				await expect(discoverHerdrHostBridge({ socketPath, paneId: "pane-1" })).rejects.toThrow(
					"malformed local API response",
				);
			},
		);
	});

	it("rejects a non-socket local API path", async () => {
		const root = await fs.mkdtemp(path.join("/tmp", "omp-herdr-discovery-file-"));
		const socketPath = path.join(root, "herdr.sock");
		try {
			await Bun.write(socketPath, "not a socket");
			await expect(discoverHerdrHostBridge({ socketPath, paneId: "pane-1" })).rejects.toThrow(
				"effective-user-owned Unix socket",
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a Unix socket not owned by the effective user", async () => {
		await withDiscoveryServer(successResponse, async socketPath => {
			const effectiveUid = process.geteuid?.();
			if (effectiveUid === undefined) throw new Error("expected a POSIX effective uid");
			await expect(validateHerdrSocketPath(socketPath, effectiveUid + 1)).rejects.toThrow(
				"effective-user-owned Unix socket",
			);
		});
	});

	it("allows a private subtree below a sticky ancestor but still rejects an unsafe higher ancestor", async () => {
		const effectiveUid = 501;
		const socketPath = "/synthetic/shared/user/private/herdr.sock";
		const canonicalParent = path.dirname(socketPath);
		type NodeKind = "directory" | "socket";
		const fakeStat = (uid: number, mode: number, kind: NodeKind): Stats =>
			({
				uid,
				mode,
				isDirectory: () => kind === "directory",
				isSocket: () => kind === "socket",
			}) as Stats;
		const stats: Record<string, Stats> = {
			[socketPath]: fakeStat(effectiveUid, 0o600, "socket"),
			[canonicalParent]: fakeStat(effectiveUid, 0o700, "directory"),
			"/synthetic/shared/user": fakeStat(effectiveUid, 0o700, "directory"),
			"/synthetic/shared": fakeStat(0, 0o1777, "directory"),
			"/synthetic": fakeStat(0, 0o755, "directory"),
			"/": fakeStat(0, 0o755, "directory"),
		};
		vi.spyOn(fs, "realpath").mockImplementation((async () => canonicalParent) as unknown as typeof fs.realpath);
		vi.spyOn(fs, "lstat").mockImplementation((async target => {
			const stat = stats[String(target)];
			if (stat) return stat;
			const error = new Error(`missing synthetic path: ${String(target)}`) as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		}) as typeof fs.lstat);

		await expect(validateHerdrSocketPath(socketPath, effectiveUid)).resolves.toBe(socketPath);

		stats["/synthetic"] = fakeStat(0, 0o777, "directory");
		await expect(validateHerdrSocketPath(socketPath, effectiveUid)).rejects.toThrow("unsafe parent directory mode");
	});

	it("rejects a cross-user-writable non-sticky parent before connecting", async () => {
		await withDiscoveryServer(successResponse, async (socketPath, requests) => {
			const root = path.dirname(socketPath);
			await fs.chmod(root, 0o777);
			try {
				await expect(discoverHerdrHostBridge({ socketPath, paneId: "pane-1" })).rejects.toThrow(
					"unsafe parent directory mode",
				);
				expect(requests).toHaveLength(0);
			} finally {
				await fs.chmod(root, 0o700);
			}
		});
	});

	it("rejects a socket directly under a root-owned sticky parent before connecting", async () => {
		const root = await fs.realpath("/tmp");
		const rootStat = await fs.lstat(root);
		expect(rootStat.uid).toBe(0);
		expect(rootStat.mode & 0o022).not.toBe(0);
		expect(rootStat.mode & 0o1000).toBe(0o1000);
		const socketPath = path.join(root, `omp-herdr-discovery-${crypto.randomUUID()}.sock`);
		let requests = 0;
		const server = Bun.listen({
			unix: socketPath,
			socket: {
				open() {},
				data() {
					requests += 1;
				},
			},
		});
		try {
			await expect(discoverHerdrHostBridge({ socketPath, paneId: "pane-1" })).rejects.toThrow(
				"unsafe parent directory mode",
			);
			expect(requests).toBe(0);
		} finally {
			server.stop(true);
			await fs.rm(socketPath, { force: true });
		}
	});

	it("rejects malformed local API JSON", async () => {
		await withDiscoveryServer(
			() => "not-json",
			async socketPath => {
				await expect(discoverHerdrHostBridge({ socketPath, paneId: "pane-1" })).rejects.toThrow(
					"malformed local API response",
				);
			},
		);
	});

	it("never exposes a token carried by a denied response", async () => {
		const secret = "do-not-log-this-token";
		await withDiscoveryServer(
			request =>
				JSON.stringify({
					id: request.id,
					error: { code: "omp_bridge_discovery_denied", message: `denied ${secret}` },
					token: secret,
				}),
			async socketPath => {
				let message = "";
				try {
					await discoverHerdrHostBridge({ socketPath, paneId: "pane-1" });
				} catch (error) {
					message = error instanceof Error ? error.message : String(error);
				}
				expect(message).toContain("denied bridge discovery");
				expect(message).not.toContain(secret);
			},
		);
	});
});
