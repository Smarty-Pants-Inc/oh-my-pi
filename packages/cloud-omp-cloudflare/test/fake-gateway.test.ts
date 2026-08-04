import { expect, test } from "bun:test";
import { FAKE_GATEWAY_BEARER, FakeCloudflareGateway } from "./support/cloudflare-harness";

const workspaceId = "0123456789abcdef0123456789abcdef";
const headers = { authorization: `Bearer ${FAKE_GATEWAY_BEARER}`, "content-type": "application/json" };

test("fake gateway enforces authenticated bounded workspace lifecycle without local execution", async () => {
	const gateway = new FakeCloudflareGateway();
	const unauthorized = await gateway.fetch("https://fake.invalid/v1/health");
	expect(unauthorized.status).toBe(401);

	const contentBase64 = Buffer.from("fixture\n").toString("base64");
	const sha256 = "e80b71cd14d3cbd65f4173abcbfcf01a545dbca32a72d575108b553a648cc96f";
	const rootSha256 = "8730f2bcee2365a3c30618f5050a0318208d8a830f518b81c6bdb7d5353d723d";
	const created = await gateway.fetch(`https://fake.invalid/v1/workspaces/${workspaceId}`, {
		method: "PUT",
		headers,
		body: JSON.stringify({
			auditCorrelationId: "fedcba9876543210fedcba9876543210",
			seedRootSha256: rootSha256,
			files: [{ path: "seeded.txt", contentBase64, sha256, byteLength: 8 }],
		}),
	});
	expect(created.status).toBe(201);

	const read = await gateway.fetch(`https://fake.invalid/v1/workspaces/${workspaceId}/files/read`, {
		method: "POST",
		headers,
		body: JSON.stringify({ path: "seeded.txt" }),
	});
	expect(read.status).toBe(200);
	const payload: unknown = await read.json();
	if (
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload) ||
		!("contentBase64" in payload) ||
		typeof payload.contentBase64 !== "string"
	) {
		throw new Error("fake file read omitted contentBase64");
	}
	expect(Buffer.from(payload.contentBase64, "base64").toString()).toBe("fixture\n");

	const released = await gateway.fetch(`https://fake.invalid/v1/workspaces/${workspaceId}`, {
		method: "DELETE",
		headers,
	});
	expect(released.status).toBe(204);
});

test("fake gateway reserves admin routes for the admin bearer", async () => {
	const adminBearer = "fake-admin-bearer";
	const gateway = new FakeCloudflareGateway({ adminBearer });
	const route = `https://fake.invalid/v1/admin/workspaces/${workspaceId}/restart`;

	const ordinaryBearer = await gateway.fetch(route, { method: "POST", headers });
	expect(ordinaryBearer.status).toBe(401);

	const admin = await gateway.fetch(route, {
		method: "POST",
		headers: { authorization: `Bearer ${adminBearer}` },
	});
	expect(admin.status).toBe(409);
});
