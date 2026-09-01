import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
	assertAuditOperationOrder,
	assertFixtureBytes,
	readJsonlAudit,
	runRealOmpChildScenario,
} from "./support/cloudflare-harness";

const realChildEnabled = process.env.CLOUD_OMP_RUN_REAL_OMP_CHILD === "1";
const run = realChildEnabled ? test : test.skip;

run(
	"real OMP child merges the bounded Cloudflare fixture only after remote lifecycle completion",
	async () => {
		const result = await runRealOmpChildScenario({ model: process.env.CLOUD_OMP_REAL_MODEL });
		try {
			expect(result.exitCode, result.stderr).toBe(0);
			await assertFixtureBytes(result.fixture);
			const auditRecords = await readJsonlAudit(result.auditPath);
			const execStarts = auditRecords.filter(record => record.operation === "exec_start");
			const execCompletes = auditRecords.filter(record => record.operation === "exec_complete");
			expect(execStarts).toHaveLength(1);
			expect(execCompletes).toHaveLength(1);
			expect(execCompletes[0]?.outcome).toBe("success");
			expect(execCompletes[0]?.exitCode).toBe(0);
			expect(auditRecords.length).toBeGreaterThan(0);
			assertAuditOperationOrder(auditRecords, [
				"acquire",
				"read",
				"read",
				"write",
				"exec_start",
				"exec_complete",
				"sync_back",
				"release",
			]);
			const serializedAudit = JSON.stringify(auditRecords);
			expect(serializedAudit).not.toContain(process.env.CLOUD_OMP_CLOUDFLARE_BEARER!);
			expect(serializedAudit).not.toContain("remote sentinel from cloud-omp fixture");
		} finally {
			await fs.rm(result.auditPath, { force: true });
			await result.fixture.dispose();
		}
	},
	30 * 60_000,
);
