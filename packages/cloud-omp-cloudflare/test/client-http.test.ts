import { describe, expect, it } from "bun:test";
import { CloudOmpEnvironmentError, sanitizeEnvironmentError } from "../src/client/environment-wire";
import {
	CloudOmpAbortError,
	CloudOmpHttpError,
	CloudOmpProtocolError,
	CloudOmpTransportError,
	createAdminJsonClient,
	createOrdinaryJsonClient,
	validateCloudOmpEndpoint,
} from "../src/client/http";

const ordinaryBearer = "ordinary-bearer-value";
const adminBearer = "admin-bearer-value";

describe("Cloud OMP authenticated JSON HTTP client", () => {
	it("accepts only absolute credential-free HTTPS endpoints", () => {
		expect(validateCloudOmpEndpoint("https://gateway.example.test").href).toBe("https://gateway.example.test/");
		for (const endpoint of [
			"http://gateway.example.test",
			"/relative",
			"https://user@gateway.example.test",
			"https://gateway.example.test?token=x",
			"https://gateway.example.test#fragment",
		]) {
			expect(() => validateCloudOmpEndpoint(endpoint)).toThrow();
		}
	});

	it("uses redirect:error and never crosses ordinary/admin bearer roles", async () => {
		const calls: Array<{ authorization: string | null; redirect: RequestRedirect | undefined; path: string }> = [];
		const transport: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			calls.push({
				authorization: request.headers.get("authorization"),
				redirect: init?.redirect,
				path: new URL(request.url).pathname,
			});
			return Response.json({ ok: true });
		};
		const ordinary = createOrdinaryJsonClient({
			endpoint: "https://gateway.example.test",
			bearer: ordinaryBearer,
			fetch: transport,
		});
		const admin = createAdminJsonClient({
			endpoint: "https://gateway.example.test",
			bearer: adminBearer,
			fetch: transport,
		});

		await ordinary.requestJson({ method: "GET", path: "/v1/health" });
		await admin.requestJson({
			method: "POST",
			path: "/v1/admin/workspaces/0123456789abcdef0123456789abcdef/restart",
		});
		await expect(
			ordinary.requestJson({
				method: "POST",
				path: "/v1/admin/workspaces/0123456789abcdef0123456789abcdef/restart",
			}),
		).rejects.toBeInstanceOf(CloudOmpProtocolError);
		await expect(admin.requestJson({ method: "GET", path: "/v1/health" })).rejects.toBeInstanceOf(
			CloudOmpProtocolError,
		);

		expect(calls).toEqual([
			{ authorization: `Bearer ${ordinaryBearer}`, redirect: "error", path: "/v1/health" },
			{
				authorization: `Bearer ${adminBearer}`,
				redirect: "error",
				path: "/v1/admin/workspaces/0123456789abcdef0123456789abcdef/restart",
			},
		]);
	});

	it("refuses redirect responses without exposing the bearer", async () => {
		const client = createOrdinaryJsonClient({
			endpoint: "https://gateway.example.test",
			bearer: ordinaryBearer,
			fetch: async () => new Response(null, { status: 302, headers: { location: "https://attacker.invalid" } }),
		});
		let failure: Error | undefined;
		try {
			await client.requestJson({ method: "GET", path: "/v1/health" });
		} catch (error) {
			failure = error as Error;
		}
		expect(failure).toBeInstanceOf(CloudOmpProtocolError);
		expect(failure?.message).not.toContain(ordinaryBearer);
		expect(failure?.message).not.toContain("attacker.invalid");
	});

	it("bounds streamed response bodies instead of trusting Content-Length", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(12));
				controller.enqueue(new Uint8Array(12));
				controller.close();
			},
		});
		const client = createOrdinaryJsonClient({
			endpoint: "https://gateway.example.test",
			bearer: ordinaryBearer,
			maxBodyBytes: 16,
			fetch: async () => new Response(stream, { status: 200 }),
		});
		await expect(client.requestJson({ method: "GET", path: "/v1/health" })).rejects.toMatchObject({
			code: "RESPONSE_BODY_TOO_LARGE",
		});
	});

	it("rejects oversized JSON before invoking the transport", async () => {
		let fetchCalls = 0;
		const client = createOrdinaryJsonClient({
			endpoint: "https://gateway.example.test",
			bearer: ordinaryBearer,
			maxBodyBytes: 16,
			fetch: async () => {
				fetchCalls += 1;
				return Response.json({ ok: true });
			},
		});
		await expect(
			client.requestJson({
				method: "PUT",
				path: "/v1/workspaces/0123456789abcdef0123456789abcdef",
				body: { value: "x".repeat(32) },
			}),
		).rejects.toMatchObject({ code: "REQUEST_BODY_TOO_LARGE" });
		expect(fetchCalls).toBe(0);
	});

	it("sanitizes transport and server error surfaces", async () => {
		const rawSecret = "raw-command-and-output-secret";
		const transportClient = createOrdinaryJsonClient({
			endpoint: "https://gateway.example.test",
			bearer: ordinaryBearer,
			fetch: async () => {
				throw new Error(rawSecret);
			},
		});
		let transportFailure: Error | undefined;
		try {
			await transportClient.requestJson({ method: "GET", path: "/v1/health" });
		} catch (error) {
			transportFailure = error as Error;
		}
		expect(transportFailure).toBeInstanceOf(CloudOmpTransportError);
		expect(transportFailure?.message).not.toContain(rawSecret);
		expect(transportFailure?.message).not.toContain(ordinaryBearer);

		const serverClient = createOrdinaryJsonClient({
			endpoint: "https://gateway.example.test",
			bearer: ordinaryBearer,
			fetch: async () => Response.json({ error: { code: "execution_failed", message: rawSecret } }, { status: 500 }),
		});
		let serverFailure: CloudOmpHttpError | undefined;
		try {
			await serverClient.requestJson({ method: "GET", path: "/v1/health" });
		} catch (error) {
			serverFailure = error as CloudOmpHttpError;
		}
		expect(serverFailure).toBeInstanceOf(CloudOmpHttpError);
		expect(serverFailure?.code).toBe("REMOTE_ERROR");
		expect(serverFailure?.message).not.toContain(rawSecret);
		expect(serverFailure?.message).not.toContain("execution_failed");
	});

	it("maps client failures to typed, sanitized environment errors without discarding cause or status", () => {
		const httpCause = new CloudOmpHttpError(503, "workspace_gone");
		const httpError = sanitizeEnvironmentError(httpCause, undefined, "acquire");
		expect(httpError).toBeInstanceOf(CloudOmpEnvironmentError);
		expect(httpError).toMatchObject({ kind: "http", stage: "acquire", code: "REMOTE_ERROR", status: 503 });
		expect(httpError.cause).toBe(httpCause);
		expect(httpError.message).not.toContain("workspace_gone");

		const protocolCause = new CloudOmpProtocolError("INVALID_JSON_RESPONSE");
		const protocolError = sanitizeEnvironmentError(protocolCause, undefined, "read");
		expect(protocolError).toMatchObject({ kind: "protocol", stage: "read", code: "INVALID_JSON_RESPONSE" });
		expect(protocolError.cause).toBe(protocolCause);

		const transportCause = new CloudOmpTransportError();
		const transportError = sanitizeEnvironmentError(transportCause, undefined, "write");
		expect(transportError).toMatchObject({ kind: "transport", stage: "write", code: "TRANSPORT_FAILURE" });
		expect(transportError.cause).toBe(transportCause);

		const abortCause = new CloudOmpAbortError();
		const abortError = sanitizeEnvironmentError(abortCause, undefined, "sync_back");
		expect(abortError).toMatchObject({ kind: "abort", stage: "sync_back", code: "ABORTED" });
		expect(abortError.cause).toBe(abortCause);
	});
});
