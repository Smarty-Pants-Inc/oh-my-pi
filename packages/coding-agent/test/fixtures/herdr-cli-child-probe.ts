import { runCli } from "../../src/cli";

const command = process.argv[2] ?? "auth-broker";
const cliRun = runCli([command, "--help"]);
const child = Bun.spawn(
	[
		process.execPath,
		"-e",
		'process.stdout.write([process.env.HERDR_OMP_BRIDGE_TOKEN ?? "<absent>", process.env.HERDR_OMP_GUEST_BRIDGE_TOKEN ?? "<absent>"].join("|"))',
	],
	{ env: process.env, stdout: "pipe" },
);
await cliRun;
const inherited = await new Response(child.stdout).text();
const exitCode = await child.exited;
process.stdout.write(`HERDR_CHILD_TOKENS=${inherited};EXIT=${exitCode}\n`);
