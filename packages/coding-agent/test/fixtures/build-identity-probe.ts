import { OMP_BUILD_ID } from "../../src/build-identity";

if (process.argv.includes("--spawn-child")) {
	const child = Bun.spawn(["bun", "-e", 'process.stdout.write(process.env.OMP_MANAGED_BUILD_ID ?? "<absent>")'], {
		env: process.env,
		stdout: "pipe",
	});
	const inherited = await new Response(child.stdout).text();
	const exitCode = await child.exited;
	process.stdout.write(`${JSON.stringify({ buildId: OMP_BUILD_ID, inherited, exitCode })}\n`);
} else {
	process.stdout.write(`${OMP_BUILD_ID}\n`);
}
