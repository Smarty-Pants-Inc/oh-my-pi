/**
 * Root command for the coding agent CLI.
 */

import { isBunTestRuntime } from "@oh-my-pi/pi-utils";
import { Command } from "@oh-my-pi/pi-utils/cli";
import { type Args as ParsedArgs, parseArgs, reportCliUsageError } from "../cli/args";
import { takeHerdrHostBridge } from "../collab/herdr-bridge-bootstrap";
import { assertApprovedStartup, promptPolicyReviewWarning } from "../context/approved-policy";
import { runRootCommand } from "../main";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";
import { launchHelp } from "./launch-help";

export async function verifyApprovedStartupForLaunch(
	isInteractive: boolean,
	verify: () => Promise<unknown> = assertApprovedStartup,
): Promise<void> {
	try {
		await verify();
	} catch (error) {
		const warning = isInteractive ? promptPolicyReviewWarning(error) : undefined;
		if (!warning) throw error;
		process.stderr.write(`Warning: ${warning}\n`);
	}
}

export default class Index extends Command {
	static description = launchHelp.description;
	static hidden = launchHelp.hidden;
	static args = launchHelp.args;
	static flags = launchHelp.flags;
	static examples = launchHelp.examples;

	static strict = false;

	async run(): Promise<void> {
		const herdrHostBridge = takeHerdrHostBridge();
		const { args } = prepareAcpTerminalAuthArgs(this.argv);
		let parsed: ParsedArgs;
		try {
			parsed = parseArgs(args);
		} catch (error) {
			if (reportCliUsageError(error)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}
		if (!isBunTestRuntime()) {
			await runRootCommand(parsed, args, {
				verifyApprovedStartup: verifyApprovedStartupForLaunch,
				herdrHostBridge,
			});
			return;
		}
		await runRootCommand(parsed, args, { herdrHostBridge });
	}
}
