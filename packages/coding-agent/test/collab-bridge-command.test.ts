import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { runCli } from "../src/cli";
import * as collabRpcGuest from "../src/collab/rpc-guest";
import * as main from "../src/main";

const bridgeEnvNames = [
	"HERDR_OMP_BRIDGE",
	"HERDR_OMP_BRIDGE_TOKEN",
	"HERDR_OMP_GUEST_BRIDGE_TOKEN",
	"HERDR_PANE_ID",
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

describe("CollabRpcGuest command", () => {
	it("uses the captured guest token without starting runRootCommand", async () => {
		const runRootCommand = vi.spyOn(main, "runRootCommand").mockResolvedValue(undefined);
		const runGuest = vi.spyOn(collabRpcGuest, "runCollabRpcGuest").mockResolvedValue(undefined);
		process.env.HERDR_OMP_GUEST_BRIDGE_TOKEN = "environment-secret";

		await runCli(["__collab-rpc-guest", "127.0.0.1:1234", "room-rpc", "--token-env"]);

		expect(runRootCommand).not.toHaveBeenCalled();
		expect(runGuest).toHaveBeenCalledWith({
			address: "127.0.0.1:1234",
			roomId: "room-rpc",
			token: "environment-secret",
		});
	});
});
