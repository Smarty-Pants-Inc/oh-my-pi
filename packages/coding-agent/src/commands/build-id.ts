import { Command } from "@oh-my-pi/pi-utils/cli";
import { OMP_BUILD_ID } from "../build-identity";

/** Hidden machine-readable query for this process's immutable build identity. */
export class BuildIdCommand extends Command {
	static hidden = true;
	static strict = false;

	async run(): Promise<void> {
		process.stdout.write(`${OMP_BUILD_ID}\n`);
	}
}
