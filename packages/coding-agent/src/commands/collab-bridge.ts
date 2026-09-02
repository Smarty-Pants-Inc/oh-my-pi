import { Command } from "@oh-my-pi/pi-utils/cli";
import { type Args as ParsedArgs, parseArgs, reportCliUsageError } from "../cli/args";
import {
	handoffHerdrGuestBridgeToken,
	takeHerdrGuestBridgeToken,
	takeHerdrHostBridge,
} from "../collab/herdr-bridge-bootstrap";
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
		const bridge = takeHerdrHostBridge();
		const [ompSessionId, generation, ...args] = this.argv;
		const routeGeneration = Number(generation);
		if (!ompSessionId || !bridge || !Number.isSafeInteger(routeGeneration) || routeGeneration < 1) {
			throw new Error(
				"__collab-host-bridge requires <omp-session-id> <route-generation>, HERDR_OMP_BRIDGE, HERDR_OMP_BRIDGE_TOKEN, and HERDR_PANE_ID",
			);
		}
		const parsed = parseNormalArgs(args);
		if (!parsed) return;
		await runRootCommand(parsed, args, {
			collabBridge: { role: "host", ...bridge, ompSessionId, routeGeneration },
		});
	}
}

export class CollabGuestBridge extends Command {
	static hidden = true;
	static strict = false;

	async run(): Promise<void> {
		const [address, roomId, tokenArgInitial, ...args] = this.argv;
		let tokenArg = tokenArgInitial;
		if (tokenArg && tokenArg !== "--token-env") {
			handoffHerdrGuestBridgeToken(tokenArg);
			tokenArg = "--token-env";
		}
		if (tokenArg !== "--token-env") {
			throw new Error("__collab-guest-bridge requires <address> <room-id> --token-env");
		}
		const token = takeHerdrGuestBridgeToken();
		if (!address || !roomId || !token) {
			throw new Error(
				"__collab-guest-bridge requires <address> <room-id> --token-env with HERDR_OMP_GUEST_BRIDGE_TOKEN",
			);
		}
		const parsed = parseNormalArgs(args);
		if (!parsed) return;
		await runRootCommand(parsed, args, { collabBridge: { role: "guest", address, roomId, token } });
	}
}
