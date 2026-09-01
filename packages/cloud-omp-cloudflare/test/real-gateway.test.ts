import { expect, test } from "bun:test";
import { requireRealGatewayEnvironment, runRealGatewayLifecycle } from "./support/cloudflare-harness";

const realGatewayEnabled = process.env.CLOUD_OMP_RUN_REAL_GATEWAY === "1";
const run = realGatewayEnabled ? test : test.skip;

run(
	"real Cloudflare gateway lifecycle is explicitly enabled and has no management token",
	async () => {
		const credentials = requireRealGatewayEnvironment();
		const adminBearer = process.env.CLOUD_OMP_CLOUDFLARE_ADMIN_BEARER;
		if (!adminBearer)
			throw new Error(
				"real gateway lifecycle requires CLOUD_OMP_CLOUDFLARE_ADMIN_BEARER for the test-only restart route",
			);
		const result = await runRealGatewayLifecycle({
			...credentials,
			adminBearer,
		});
		expect(result.workspaceId).toMatch(/^[0-9a-f]{32}$/);
		expect(result.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	},
	10 * 60_000,
);
