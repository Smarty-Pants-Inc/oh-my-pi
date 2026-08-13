import { Command } from "@oh-my-pi/pi-utils/cli";
import { type Args as ParsedArgs, parseArgs, reportCliUsageError } from "../cli/args";
import { runRootCommand } from "../main";

function parseNormalArgs(args: string[]): ParsedArgs | null {
	try {
		return parseArgs(args);
	} catch (error) {
		if (reportCliUsageError(error)) {
			process.exitCode = 2;
			return null;
		}
		throw error;
	}
}

export class CollabHostBridge extends Command {
	static hidden = true;
	static strict = false;

	async run(): Promise<void> {
		const [ompSessionId, generation, ...args] = this.argv;
		const address = process.env.HERDR_OMP_BRIDGE;
		const token = process.env.HERDR_OMP_BRIDGE_TOKEN;
		const paneId = process.env.HERDR_PANE_ID;
		const routeGeneration = Number(generation);
		if (
			!ompSessionId ||
			!address ||
			!token ||
			!paneId ||
			!Number.isSafeInteger(routeGeneration) ||
			routeGeneration < 1
		) {
			throw new Error(
				"__collab-host-bridge requires <omp-session-id> <route-generation>, HERDR_OMP_BRIDGE, HERDR_OMP_BRIDGE_TOKEN, and HERDR_PANE_ID",
			);
		}
		const parsed = parseNormalArgs(args);
		if (!parsed) return;
		await runRootCommand(parsed, args, {
			collabBridge: { role: "host", address, token, paneId, ompSessionId, routeGeneration },
		});
	}
}

export class CollabGuestBridge extends Command {
	static hidden = true;
	static strict = false;

	async run(): Promise<void> {
		const [address, roomId, token, ...args] = this.argv;
		if (!address || !roomId || !token) throw new Error("__collab-guest-bridge requires <address> <room-id> <token>");
		const parsed = parseNormalArgs(args);
		if (!parsed) return;
		await runRootCommand(parsed, args, { collabBridge: { role: "guest", address, roomId, token } });
	}
}
