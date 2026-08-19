import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";

const packageDir = path.resolve(import.meta.dir, "..");
const probeEntry = path.join(import.meta.dir, "fixtures", "herdr-cli-child-probe.ts");
type BridgeTokenEnvName = "HERDR_OMP_BRIDGE_TOKEN" | "HERDR_OMP_GUEST_BRIDGE_TOKEN";
const bridgeTokenEnvNames: BridgeTokenEnvName[] = ["HERDR_OMP_BRIDGE_TOKEN", "HERDR_OMP_GUEST_BRIDGE_TOKEN"];

async function runProbe(command: string, tokenEnvName: BridgeTokenEnvName): Promise<string> {
	const result = await $`bun ${probeEntry} ${command}`
		.cwd(packageDir)
		.env({
			...process.env,
			HERDR_OMP_BRIDGE: "127.0.0.1:1234",
			HERDR_OMP_BRIDGE_TOKEN: undefined,
			HERDR_OMP_GUEST_BRIDGE_TOKEN: undefined,
			HERDR_PANE_ID: "pane-1",
			[tokenEnvName]: "bridge-secret",
		})
		.quiet()
		.nothrow();
	expect(result.exitCode).toBe(0);
	return result.text();
}

describe("Herdr bridge CLI bootstrap", () => {
	it.each(bridgeTokenEnvNames)("scrubs %s before lazy command modules and descendants run", async tokenEnvName => {
		await Promise.all(
			["plugin", "update", "auth-broker", "join"].map(async command => {
				expect(await runProbe(command, tokenEnvName)).toContain("HERDR_CHILD_TOKENS=<absent>|<absent>;EXIT=0");
			}),
		);
	});

	it("rejects incomplete bridge state before loading a command", async () => {
		const env = { ...process.env };
		delete env.HERDR_PANE_ID;
		const result = await $`bun ${probeEntry} auth-broker`
			.cwd(packageDir)
			.env({
				...env,
				HERDR_OMP_BRIDGE: "127.0.0.1:1234",
				HERDR_OMP_BRIDGE_TOKEN: "bridge-secret",
				HERDR_OMP_GUEST_BRIDGE_TOKEN: undefined,
			})
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("Incomplete Herdr OMP bridge environment");
	});

	it("scrubs both bridge tokens before reporting an invalid guest token", async () => {
		const result = await $`bun ${probeEntry} auth-broker`
			.cwd(packageDir)
			.env({
				...process.env,
				HERDR_OMP_BRIDGE: "127.0.0.1:1234",
				HERDR_OMP_BRIDGE_TOKEN: "host-secret",
				HERDR_OMP_GUEST_BRIDGE_TOKEN: " ",
				HERDR_PANE_ID: "pane-1",
			})
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("Incomplete Herdr OMP guest bridge environment");
		expect(result.text()).toContain("HERDR_CHILD_TOKENS=<absent>|<absent>;EXIT=0");
	});
});
