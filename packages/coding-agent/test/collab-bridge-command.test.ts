import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { runCli } from "../src/cli";
import * as main from "../src/main";

const bridgeEnvNames = [
	"HERDR_OMP_BRIDGE",
	"HERDR_OMP_BRIDGE_TOKEN",
	"HERDR_OMP_GUEST_BRIDGE_TOKEN",
	"HERDR_PANE_ID",
	"HERDR_OMP_ROUTE_GENERATION",
	"HERDR_SOCKET_PATH",
] as const;
type BridgeEnvName = (typeof bridgeEnvNames)[number];

let savedBridgeEnv: Partial<Record<BridgeEnvName, string>>;
let savedExitCode: typeof process.exitCode;

beforeEach(() => {
	savedBridgeEnv = {};
	for (const name of bridgeEnvNames) {
		const value = process.env[name];
		if (value !== undefined) savedBridgeEnv[name] = value;
		delete process.env[name];
	}
	savedExitCode = process.exitCode;
	process.exitCode = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const name of bridgeEnvNames) {
		const value = savedBridgeEnv[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	process.exitCode = savedExitCode ?? 0;
});

describe("CollabGuestBridge token parsing", () => {
	it("uses the captured guest token for --token-env without forwarding the marker", async () => {
		const runRootCommand = vi.spyOn(main, "runRootCommand").mockResolvedValue(undefined);
		process.env.HERDR_OMP_GUEST_BRIDGE_TOKEN = "environment-secret";

		await runCli(["__collab-guest-bridge", "127.0.0.1:1234", "room-1", "--token-env", "--no-tools"]);

		expect(process.env.HERDR_OMP_GUEST_BRIDGE_TOKEN).toBeUndefined();
		expect(runRootCommand).toHaveBeenCalledTimes(1);
		const call = runRootCommand.mock.calls[0];
		if (!call) throw new Error("guest bridge did not start");
		expect(call[1]).toEqual(["--no-tools"]);
		expect(call[2]?.collabBridge).toEqual({
			role: "guest",
			address: "127.0.0.1:1234",
			roomId: "room-1",
			token: "environment-secret",
		});
	});

	it("rejects a blank captured token for the explicit guest bridge command", async () => {
		const runRootCommand = vi.spyOn(main, "runRootCommand").mockResolvedValue(undefined);
		process.env.HERDR_OMP_GUEST_BRIDGE_TOKEN = " ";

		await expect(
			runCli(["__collab-guest-bridge", "127.0.0.1:1234", "room-1", "--token-env", "--no-tools"]),
		).rejects.toThrow("with HERDR_OMP_GUEST_BRIDGE_TOKEN");

		expect(process.env.HERDR_OMP_GUEST_BRIDGE_TOKEN).toBeUndefined();
		expect(runRootCommand).not.toHaveBeenCalled();
	});

	it("normalizes the legacy positional token without forwarding it to the guest", async () => {
		const runRootCommand = vi.spyOn(main, "runRootCommand").mockResolvedValue(undefined);

		await runCli(["__collab-guest-bridge", "127.0.0.1:1234", "room-legacy", "legacy-secret", "--no-tools"]);

		expect(process.env.HERDR_OMP_GUEST_BRIDGE_TOKEN).toBeUndefined();
		expect(runRootCommand).toHaveBeenCalledTimes(1);
		const call = runRootCommand.mock.calls[0];
		if (!call) throw new Error("legacy guest bridge did not start");
		expect(call[1]).toEqual(["--no-tools"]);
		expect(call[2]?.collabBridge).toEqual({
			role: "guest",
			address: "127.0.0.1:1234",
			roomId: "room-legacy",
			token: "legacy-secret",
		});
	});
});

describe("CollabRpcGuestCommand token parsing", () => {
	it("runs the managed RPC guest with its CLI-captured token after scrubbing the environment", async () => {
		const runRootCommand = vi.spyOn(main, "runRootCommand").mockResolvedValue(undefined);
		process.env.HERDR_OMP_GUEST_BRIDGE_TOKEN = "environment-secret";

		await runCli(["__collab-rpc-guest", "127.0.0.1:1234", "room-1", "--token-env", "--no-tools"]);

		expect(process.env.HERDR_OMP_GUEST_BRIDGE_TOKEN).toBeUndefined();
		expect(runRootCommand).toHaveBeenCalledTimes(1);
		const call = runRootCommand.mock.calls[0];
		if (!call) throw new Error("RPC guest did not start");
		expect(call[1]).toEqual(["--no-tools"]);
		expect(call[2]?.collabRpcGuest).toEqual({
			address: "127.0.0.1:1234",
			roomId: "room-1",
			token: "environment-secret",
		});
	});
});

describe("CollabRpcHostCommand token parsing", () => {
	it.skipIf(process.platform === "win32")(
		"runs the managed RPC host with its CLI-captured token after scrubbing bridge claims",
		async () => {
			const runRootCommand = vi.spyOn(main, "runRootCommand").mockResolvedValue(undefined);
			process.env.HERDR_OMP_BRIDGE = "127.0.0.1:1234";
			process.env.HERDR_OMP_BRIDGE_TOKEN = "environment-secret";
			process.env.HERDR_PANE_ID = "pane-1";
			process.env.HERDR_OMP_ROUTE_GENERATION = "3";

			await runCli(["__collab-rpc-host", "--no-tools"]);

			for (const name of bridgeEnvNames) expect(process.env[name]).toBeUndefined();
			expect(runRootCommand).toHaveBeenCalledTimes(1);
			const call = runRootCommand.mock.calls[0];
			if (!call) throw new Error("RPC host did not start");
			expect(call[1]).toEqual(["--no-tools"]);
			expect(call[2]?.collabRpcHost).toEqual({
				address: "127.0.0.1:1234",
				paneId: "pane-1",
				routeGeneration: 3,
				token: "environment-secret",
				role: "host",
				managed: true,
				runtimeOwner: "agentd",
			});
		},
	);
});
