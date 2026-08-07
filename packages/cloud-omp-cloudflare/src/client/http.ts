import { hasExactObjectKeys, MAX_HTTP_BODY_BYTES } from "../boundary-policy";
import {
	CLOUDFLARE_RUNTIME_PROTOCOL_ERROR_CODES_V1,
	type CloudflareRuntimeProtocolErrorCodeV1,
	CloudflareRuntimeProtocolErrorV1,
	type CloudOmpWireErrorCode,
	isCloudOmpWireErrorCode,
	type WireErrorResponse,
} from "../protocol";

export type CloudOmpBearerRole = "ordinary" | "admin";
export type CloudOmpHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface CloudOmpHttpClientOptions {
	endpoint: string | URL;
	bearer: string;
	fetch?: typeof globalThis.fetch;
	maxBodyBytes?: number;
}

export interface CloudOmpJsonRequest {
	method: CloudOmpHttpMethod;
	path: string;
	body?: unknown;
	/** Prevalidated JSON bytes; sent without parse/stringify reconstruction. */
	bodyJson?: string;
	signal?: AbortSignal;
}
export const CLOUD_OMP_PROTOCOL_ERROR_CODES = Object.freeze({
	INVALID_RESPONSE: true,
	EMPTY_RESPONSE: true,
	INVALID_ROUTE: true,
	INVALID_REQUEST_BODY: true,
	REQUEST_BODY_TOO_LARGE: true,
	REDIRECT_REFUSED: true,
	EXPECTED_EMPTY_RESPONSE: true,
	UNEXPECTED_EMPTY_RESPONSE: true,
	RESPONSE_BODY_TOO_LARGE: true,
	INVALID_UTF8_RESPONSE: true,
	INVALID_JSON_RESPONSE: true,
	BEARER_ROLE_MISMATCH: true,
	WRITE_READBACK_MISMATCH: true,
	OUTPUT_LIMIT_EXCEEDED: true,
	SYNC_INCOMPLETE: true,
	QUIESCE_INCOMPLETE: true,
	WORKSPACE_NOT_SETTLED: true,
	INVALID_FILE_PAYLOAD: true,
	INVALID_FILE_DIGEST: true,
	INVALID_FILE_UTF8: true,
} as const);

export type CloudOmpProtocolErrorCode = keyof typeof CLOUD_OMP_PROTOCOL_ERROR_CODES;
export type CloudOmpHttpErrorCode = "REMOTE_ERROR";

export function isCloudOmpProtocolErrorCode(value: unknown): value is CloudOmpProtocolErrorCode {
	return typeof value === "string" && Object.hasOwn(CLOUD_OMP_PROTOCOL_ERROR_CODES, value);
}

export class CloudOmpTransportError extends Error {
	readonly code = "TRANSPORT_FAILURE" as const;

	constructor() {
		super("Cloud OMP transport failed");
		this.name = "CloudOmpTransportError";
	}
}

export class CloudOmpAbortError extends Error {
	readonly code = "ABORTED" as const;

	constructor() {
		super("Cloud OMP request aborted");
		this.name = "CloudOmpAbortError";
	}
}

export class CloudOmpProtocolError extends Error {
	readonly code: CloudOmpProtocolErrorCode;

	constructor(code: CloudOmpProtocolErrorCode = "INVALID_RESPONSE") {
		const safeCode = isCloudOmpProtocolErrorCode(code) ? code : "INVALID_RESPONSE";
		super(`Cloud OMP protocol failure (${safeCode})`);
		this.name = "CloudOmpProtocolError";
		this.code = safeCode;
	}
}

export class CloudOmpHttpError extends Error {
	readonly status: number;
	readonly code: CloudOmpHttpErrorCode = "REMOTE_ERROR";

	constructor(status: number, _wireCode?: CloudOmpWireErrorCode) {
		super(`Cloud OMP request failed (REMOTE_ERROR, HTTP ${status})`);
		this.name = "CloudOmpHttpError";
		this.status = status;
	}
}

export function validateCloudOmpEndpoint(value: string | URL): URL {
	let endpoint: URL;
	try {
		endpoint = new URL(value instanceof URL ? value.href : value);
	} catch {
		throw new TypeError("Cloud OMP endpoint must be an absolute HTTPS URL");
	}
	if (
		endpoint.protocol !== "https:" ||
		endpoint.username !== "" ||
		endpoint.password !== "" ||
		endpoint.search !== "" ||
		endpoint.hash !== ""
	) {
		throw new TypeError("Cloud OMP endpoint must be an absolute HTTPS URL without credentials, query, or fragment");
	}
	endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
	return endpoint;
}

export class CloudOmpJsonClient {
	readonly role: CloudOmpBearerRole;
	readonly endpoint: string;

	readonly #endpoint: URL;
	readonly #bearer: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #maxBodyBytes: number;

	constructor(role: CloudOmpBearerRole, options: CloudOmpHttpClientOptions) {
		if (typeof options.bearer !== "string" || options.bearer.length === 0 || /[\r\n]/.test(options.bearer)) {
			throw new TypeError("Cloud OMP bearer must be a non-empty header-safe string");
		}
		const maxBodyBytes = options.maxBodyBytes ?? MAX_HTTP_BODY_BYTES;
		if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_HTTP_BODY_BYTES) {
			throw new TypeError("Cloud OMP body limit is invalid");
		}
		this.role = role;
		this.#endpoint = validateCloudOmpEndpoint(options.endpoint);
		this.endpoint = this.#endpoint.href;
		this.#bearer = options.bearer;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#maxBodyBytes = maxBodyBytes;
		Object.freeze(this);
	}

	async requestJson<T>(request: CloudOmpJsonRequest): Promise<T> {
		const bytes = await this.#request(request, false);
		if (bytes.byteLength === 0) {
			throw new CloudOmpProtocolError("EMPTY_RESPONSE");
		}
		return parseJson(bytes) as T;
	}

	async requestEmpty(request: CloudOmpJsonRequest): Promise<void> {
		await this.#request(request, true);
	}

	async #request(request: CloudOmpJsonRequest, expectEmpty: boolean): Promise<Uint8Array> {
		this.#assertRouteRole(request.path);
		if (!request.path.startsWith("/v1/")) {
			throw new CloudOmpProtocolError("INVALID_ROUTE");
		}

		const url = new URL(this.#endpoint.href);
		url.pathname = `${this.#endpoint.pathname}${request.path}`.replace(/\/{2,}/g, "/");

		let body: Uint8Array | undefined;
		if (request.body !== undefined && request.bodyJson !== undefined) {
			throw new CloudOmpProtocolError("INVALID_REQUEST_BODY");
		}
		if (request.body !== undefined || request.bodyJson !== undefined) {
			let encoded: string | undefined;
			try {
				encoded = request.bodyJson ?? JSON.stringify(request.body);
				if (encoded === undefined || (request.bodyJson !== undefined && JSON.parse(encoded) === undefined)) {
					throw new Error();
				}
			} catch {
				throw new CloudOmpProtocolError("INVALID_REQUEST_BODY");
			}
			body = new TextEncoder().encode(encoded);
			if (body.byteLength > this.#maxBodyBytes) {
				throw new CloudOmpProtocolError("REQUEST_BODY_TOO_LARGE");
			}
		}

		let response: Response;
		try {
			response = await this.#fetch(url, {
				method: request.method,
				headers: {
					accept: "application/json",
					authorization: `Bearer ${this.#bearer}`,
					...(body ? { "content-length": String(body.byteLength), "content-type": "application/json" } : {}),
				},
				body,
				credentials: "omit",
				redirect: "error",
				signal: request.signal,
			});
		} catch {
			if (request.signal?.aborted) throw new CloudOmpAbortError();
			throw new CloudOmpTransportError();
		}

		if (response.redirected || (response.status >= 300 && response.status < 400)) {
			throw new CloudOmpProtocolError("REDIRECT_REFUSED");
		}

		const responseBody = await readBoundedBody(response, this.#maxBodyBytes);
		if (!response.ok) {
			if (request.path.startsWith("/v1/runtime/")) {
				const runtimeError = tryParseRuntimeError(responseBody);
				if (runtimeError) throw new CloudflareRuntimeProtocolErrorV1(runtimeError.error.code);
			}
			const wireError = tryParseWireError(responseBody);
			throw new CloudOmpHttpError(response.status, wireError?.error.code);
		}
		if (expectEmpty) {
			if (response.status !== 204 || responseBody.byteLength !== 0) {
				throw new CloudOmpProtocolError("EXPECTED_EMPTY_RESPONSE");
			}
			return responseBody;
		}
		if (response.status === 204) {
			throw new CloudOmpProtocolError("UNEXPECTED_EMPTY_RESPONSE");
		}
		return responseBody;
	}

	#assertRouteRole(path: string): void {
		const isAdminRoute = path.startsWith("/v1/admin/");
		if ((this.role === "admin") !== isAdminRoute) {
			throw new CloudOmpProtocolError("BEARER_ROLE_MISMATCH");
		}
	}
}

export function createOrdinaryJsonClient(options: CloudOmpHttpClientOptions): CloudOmpJsonClient {
	return new CloudOmpJsonClient("ordinary", options);
}

export function createAdminJsonClient(options: CloudOmpHttpClientOptions): CloudOmpJsonClient {
	return new CloudOmpJsonClient("admin", options);
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength && /^\d+$/.test(declaredLength)) {
		const parsedLength = Number(declaredLength);
		if (!Number.isSafeInteger(parsedLength) || parsedLength > limit) {
			throw new CloudOmpProtocolError("RESPONSE_BODY_TOO_LARGE");
		}
	}
	if (!response.body) return new Uint8Array();

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > limit) {
				await reader.cancel();
				throw new CloudOmpProtocolError("RESPONSE_BODY_TOO_LARGE");
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof CloudOmpProtocolError) throw error;
		throw new CloudOmpTransportError();
	} finally {
		reader.releaseLock();
	}

	const result = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function parseJson(bytes: Uint8Array): unknown {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new CloudOmpProtocolError("INVALID_UTF8_RESPONSE");
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new CloudOmpProtocolError("INVALID_JSON_RESPONSE");
	}
}

function tryParseWireError(bytes: Uint8Array): WireErrorResponse | undefined {
	if (bytes.byteLength === 0) return undefined;
	let value: unknown;
	try {
		value = parseJson(bytes);
	} catch {
		return undefined;
	}
	if (!hasExactObjectKeys(value, ["error"]) || !hasExactObjectKeys(value.error, ["code", "message"])) return undefined;
	if (typeof value.error.message !== "string" || !isCloudOmpWireErrorCode(value.error.code)) return undefined;
	return { error: { code: value.error.code, message: value.error.message } };
}

interface CloudflareRuntimeWireError {
	readonly error: {
		readonly code: CloudflareRuntimeProtocolErrorCodeV1;
		readonly message: string;
	};
}

function tryParseRuntimeError(bytes: Uint8Array): CloudflareRuntimeWireError | undefined {
	if (bytes.byteLength === 0) return undefined;
	let value: unknown;
	try {
		value = parseJson(bytes);
	} catch {
		return undefined;
	}
	if (!hasExactObjectKeys(value, ["error"]) || !hasExactObjectKeys(value.error, ["code", "message"])) {
		return undefined;
	}
	if (
		typeof value.error.code !== "string" ||
		!Object.hasOwn(CLOUDFLARE_RUNTIME_PROTOCOL_ERROR_CODES_V1, value.error.code) ||
		typeof value.error.message !== "string"
	) {
		return undefined;
	}
	return value as unknown as CloudflareRuntimeWireError;
}
