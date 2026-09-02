import { Command } from "@oh-my-pi/pi-utils/cli";
import { type Args, parseArgs, reportCliUsageError } from "../cli/args";
import { captureHerdrAgentdHostBridge } from "../collab/agentd-local-transport";
import { takeHerdrHostBridgeToken } from "../collab/herdr-bridge-bootstrap";
import { runRootCommand } from "../main";

/** Owner-only agentd entry point; it never accepts bridge credentials in argv. */
export class CollabRpcHostCommand extends Command {
	static hidden = true;
	static strict = false;

	async run(): Promise<void> {
		const bridge = Object.assign(captureHerdrAgentdHostBridge(takeHerdrHostBridgeToken()), {
			role: "host" as const,
			managed: true as const,
			runtimeOwner: "agentd" as const,
		});
		let parsed: Args;
		try {
			parsed = parseArgs(this.argv);
		} catch (error) {
			if (reportCliUsageError(error)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}
		parsed.mode = "rpc";
		await runRootCommand(parsed, this.argv, {
			collabRpcHost: bridge,
		});
	}
}
