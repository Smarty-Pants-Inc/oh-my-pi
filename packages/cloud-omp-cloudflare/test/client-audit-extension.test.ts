import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CloudOmpAuditError,
	CloudOmpAuditWriter,
	createAuditCorrelationId,
	hashWorkspaceId,
	validateAuditRecord,
} from "../src/client/audit";
import cloudflareExtension, { loadCloudflareEnvironmentConfig } from "../src/extension";

const temporaryRoots: string[] = [];

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Cloud OMP local audit", () => {
	it("writes private schema-valid lifecycle metadata without prohibited content", async () => {
		const root = await mkdtemp(join(tmpdir(), "cloud-omp-audit-test-"));
		temporaryRoots.push(root);
		const auditPath = join(root, "audit.jsonl");
		const writer = new CloudOmpAuditWriter(
			{
				correlationId: createAuditCorrelationId(),
				workspaceIdSha256: hashWorkspaceId("0123456789abcdef0123456789abcdef"),
				taskId: "task-owner",
				runId: "session-id",
				containerInternetEnabled: true,
			},
			{ path: auditPath, now: () => new Date("2026-08-04T00:00:00.000Z") },
		);
		await writer.record({
			operation: "exec_complete",
			durationMs: 12,
			outcome: "success",
			byteCount: 19,
			exitCode: 0,
			truncated: false,
		});

		const text = await readFile(auditPath, "utf8");
		const record = JSON.parse(text.trim());
		validateAuditRecord(record);
		expect(text).not.toContain("Bearer");
		expect(text).not.toContain("rawCommand");
		expect(text).not.toContain("stdout");
		expect(text).not.toContain("fileContent");
		expect(text).not.toContain("0123456789abcdef0123456789abcdef");
		expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
	});

	it("rejects prohibited or unknown audit fields", async () => {
		const root = await mkdtemp(join(tmpdir(), "cloud-omp-audit-test-"));
		temporaryRoots.push(root);
		const writer = new CloudOmpAuditWriter(
			{
				correlationId: createAuditCorrelationId(),
				workspaceIdSha256: hashWorkspaceId("0123456789abcdef0123456789abcdef"),
				taskId: "owner",
				runId: "session",
				containerInternetEnabled: true,
			},
			{ path: join(root, "audit.jsonl") },
		);
		expect(() =>
			writer.record({ operation: "exec_start", durationMs: 1, outcome: "success", rawCommand: "secret" } as never),
		).toThrow(CloudOmpAuditError);
	});
});

describe("Cloud OMP extension hydration", () => {
	it("requires endpoint and ordinary bearer and rejects invalid sentinel opt-ins", () => {
		expect(() => loadCloudflareEnvironmentConfig({})).toThrow("CLOUD_OMP_CLOUDFLARE_ENDPOINT");
		expect(() =>
			loadCloudflareEnvironmentConfig({
				CLOUD_OMP_CLOUDFLARE_ENDPOINT: "https://gateway.example.test",
				CLOUD_OMP_CLOUDFLARE_BEARER: "ordinary-bearer",
				CLOUD_OMP_TEST_REMOTE_SENTINEL: "0",
			}),
		).toThrow("explicit value 1");
	});

	it("does not inspect Cloudflare management credentials", () => {
		const environment = new Proxy(
			{
				CLOUD_OMP_CLOUDFLARE_ENDPOINT: "https://gateway.example.test",
				CLOUD_OMP_CLOUDFLARE_BEARER: "ordinary-bearer",
			},
			{
				get(target, property, receiver) {
					if (String(property).includes("API_TOKEN") || String(property).includes("ACCOUNT_ID")) {
						throw new Error("management credential was read");
					}
					return Reflect.get(target, property, receiver);
				},
			},
		);
		expect(loadCloudflareEnvironmentConfig(environment)).toMatchObject({
			endpoint: "https://gateway.example.test/",
			bearer: "ordinary-bearer",
			testRemoteSentinel: false,
		});
	});

	it("registers exactly one runtime and one legacy environment provider", () => {
		const previousEndpoint = process.env.CLOUD_OMP_CLOUDFLARE_ENDPOINT;
		const previousBearer = process.env.CLOUD_OMP_CLOUDFLARE_BEARER;
		const previousSentinel = process.env.CLOUD_OMP_TEST_REMOTE_SENTINEL;
		process.env.CLOUD_OMP_CLOUDFLARE_ENDPOINT = "https://gateway.example.test";
		process.env.CLOUD_OMP_CLOUDFLARE_BEARER = "ordinary-bearer";
		delete process.env.CLOUD_OMP_TEST_REMOTE_SENTINEL;
		try {
			const runtimeProviders: unknown[] = [];
			const environmentProviders: unknown[] = [];
			cloudflareExtension({
				setLabel() {},
				registerRuntimeProvider(provider: unknown) {
					runtimeProviders.push(provider);
				},
				registerExecutionEnvironmentProvider(provider: unknown) {
					environmentProviders.push(provider);
				},
			} as never);
			expect(runtimeProviders).toHaveLength(1);
			expect(environmentProviders).toHaveLength(1);
		} finally {
			setOrDeleteEnvironment("CLOUD_OMP_CLOUDFLARE_ENDPOINT", previousEndpoint);
			setOrDeleteEnvironment("CLOUD_OMP_CLOUDFLARE_BEARER", previousBearer);
			setOrDeleteEnvironment("CLOUD_OMP_TEST_REMOTE_SENTINEL", previousSentinel);
		}
	});
});

function setOrDeleteEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
