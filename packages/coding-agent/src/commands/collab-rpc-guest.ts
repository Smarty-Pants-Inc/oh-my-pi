import { Command } from "@oh-my-pi/pi-utils/cli";
import type { Args } from "../cli/args";
import { parseArgs, reportCliUsageError } from "../cli/args";
import { takeHerdrGuestBridgeToken } from "../collab/herdr-bridge-bootstrap";
import { runRootCommand } from "../main";
/** Owner-only entry point for an adopted agentd Collab session. */
export class CollabRpcGuestCommand extends Command {
	static hidden = true;
	static strict = false;

	async run(): Promise<void> {
		const token = takeHerdrGuestBridgeToken();
		const [address, roomId, ...argv] = this.argv;
		if (!address || !roomId || argv[0] !== "--token-env" || argv.includes("--token-env", 1)) {
			throw new Error("__collab-rpc-guest requires <bridge-address> <room-id> --token-env");
		}
		if (!token || token.trim() !== token || token.includes("\0")) {
			throw new Error("__collab-rpc-guest requires HERDR_OMP_GUEST_BRIDGE_TOKEN");
		}
		let parsed: Args;
		try {
			parsed = parseArgs(argv.slice(1));
		} catch (error) {
			if (reportCliUsageError(error)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}
		parsed.mode = "rpc";
		const dependencies = { collabRpcGuest: { address, roomId, token } };
		await runRootCommand(parsed, argv.slice(1), dependencies);
	}
}
