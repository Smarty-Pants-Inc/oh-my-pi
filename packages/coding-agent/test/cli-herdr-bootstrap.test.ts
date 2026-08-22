import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const packageDir = path.resolve(import.meta.dir, "..");
const probeEntry = path.join(import.meta.dir, "fixtures", "herdr-cli-child-probe.ts");
const cliEntry = path.join(packageDir, "src", "cli.ts");
type BridgeTokenEnvName = "HERDR_OMP_BRIDGE_TOKEN" | "HERDR_OMP_GUEST_BRIDGE_TOKEN";
const bridgeTokenEnvNames: BridgeTokenEnvName[] = ["HERDR_OMP_BRIDGE_TOKEN", "HERDR_OMP_GUEST_BRIDGE_TOKEN"];

async function runProbe(command: string, tokenEnvName: BridgeTokenEnvName): Promise<string> {
	const result = await $`bun ${probeEntry} ${command}`
		.cwd(packageDir)
		.env({
			...process.env,
			HERDR_SOCKET_PATH: undefined,
			HERDR_OMP_BRIDGE: "127.0.0.1:1234",
			HERDR_OMP_BRIDGE_TOKEN: undefined,
			HERDR_OMP_GUEST_BRIDGE_TOKEN: undefined,
			HERDR_PANE_ID: "pane-1",
			[tokenEnvName]: "bridge-secret",
		})
		.quiet()
		.nothrow();
	expect(result.exitCode).toBe(0);
	return result.text();
}

async function withDiscoveryProbe(
	run: (socketPath: string, requestCount: () => number) => Promise<void>,
): Promise<void> {
	const root = await fs.mkdtemp(path.join("/tmp", "omp-herdr-cli-discovery-"));
	const socketPath = path.join(root, "herdr.sock");
	let requests = 0;
	let pending = "";
	const server = Bun.listen({
		unix: socketPath,
		socket: {
			open() {},
			data(socket, data) {
				pending += data.toString();
				const newline = pending.indexOf("\n");
				if (newline < 0) return;
				const request = JSON.parse(pending.slice(0, newline)) as Record<string, unknown>;
				pending = pending.slice(newline + 1);
				requests += 1;
				socket.write(
					`${JSON.stringify({
						id: request.id,
						result: {
							type: "pane_omp_bridge",
							pane_id: "pane-current",
							address: "127.0.0.1:4321",
							token: "fresh-token",
						},
					})}\n`,
				);
			},
			close() {},
			error() {},
		},
	});
	try {
		await run(socketPath, () => requests);
	} finally {
		server.stop(true);
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("Herdr bridge CLI bootstrap", () => {
	it.each(bridgeTokenEnvNames)("scrubs %s before lazy command modules and descendants run", async tokenEnvName => {
		await Promise.all(
			["plugin", "update", "auth-broker", "join"].map(async command => {
				expect(await runProbe(command, tokenEnvName)).toContain("HERDR_CHILD_TOKENS=<absent>|<absent>;EXIT=0");
			}),
		);
	});

	it.each([
		["print", ["--max-time", "5d", "--print", "hello"]],
		["RPC", ["--max-time", "5d", "--mode", "rpc"]],
	] as const)("does not probe authenticated discovery for %s command parsing", async (_mode, args) => {
		await withDiscoveryProbe(async (socketPath, requestCount) => {
			const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
				cwd: packageDir,
				env: {
					...process.env,
					HERDR_SOCKET_PATH: socketPath,
					HERDR_OMP_BRIDGE: "127.0.0.1:1234",
					HERDR_OMP_BRIDGE_TOKEN: "retired-token",
					HERDR_OMP_GUEST_BRIDGE_TOKEN: undefined,
					HERDR_PANE_ID: "pane-1",
				},
				stdout: "ignore",
				stderr: "pipe",
			});
			const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

			expect(exitCode).toBe(2);
			expect(stderr).toContain("Invalid --max-time value");
			expect(requestCount()).toBe(0);
		});
	});

	it("ignores and scrubs stale inherited bridge state before loading a command", async () => {
		const env = { ...process.env };
		delete env.HERDR_PANE_ID;
		const result = await $`bun ${probeEntry} auth-broker`
			.cwd(packageDir)
			.env({
				...env,
				HERDR_SOCKET_PATH: undefined,
				HERDR_OMP_BRIDGE: "127.0.0.1:1234",
				HERDR_OMP_BRIDGE_TOKEN: "bridge-secret",
				HERDR_OMP_GUEST_BRIDGE_TOKEN: "guest-secret",
			})
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		expect(result.text()).toContain("HERDR_CHILD_TOKENS=<absent>|<absent>;EXIT=0");
	});

	it("scrubs both bridge tokens before reporting an invalid guest token", async () => {
		const result = await $`bun ${probeEntry} auth-broker`
			.cwd(packageDir)
			.env({
				...process.env,
				HERDR_SOCKET_PATH: undefined,
				HERDR_OMP_BRIDGE: "127.0.0.1:1234",
				HERDR_OMP_BRIDGE_TOKEN: "host-secret",
				HERDR_OMP_GUEST_BRIDGE_TOKEN: " ",
				HERDR_PANE_ID: "pane-1",
			})
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("Incomplete Herdr OMP guest bridge environment");
		expect(result.text()).toContain("HERDR_CHILD_TOKENS=<absent>|<absent>;EXIT=0");
	});
});
