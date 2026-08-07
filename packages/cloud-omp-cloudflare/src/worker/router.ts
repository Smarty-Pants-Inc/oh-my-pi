import type { RuntimeReplicaRef } from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import { MAX_HTTP_BODY_BYTES } from "../boundary-policy";
import {
	type CloudflareRuntimeEffectTransportEnvelopeV1,
	type CloudflareRuntimeInspectionTransportEnvelopeV1,
	type CloudflareValidatedRuntimeEffectTransportV1,
	type CloudflareValidatedRuntimeInspectionTransportV1,
	type CloudflareValidatedRuntimeOperationV1,
	type CloudOmpWireErrorCode,
	cloudflareRuntimeRoutesV1,
	decodeCloudflareCheckpointFetchResponseV1,
	decodeCloudflareReplicaCacheEvictionInspectResultV1,
	decodeCloudflareReplicaCacheEvictionRequestResultV1,
	decodeCloudflareReplicaDeleteInspectResultV1,
	decodeCloudflareReplicaDeleteResultV1,
	decodeCloudflareRuntimeEffectTransportResultEnvelopeV1,
	decodeCloudflareRuntimeInspectionTransportResultEnvelopeV1,
	decodeCloudflareRuntimeStatusResponseV1,
	deriveCloudflareRuntimeDurableObjectNameV1,
	type HealthResponse,
	isCloudOmpWireErrorCode,
	type WireErrorResponse,
} from "../protocol";
import { bearerMatches } from "./auth";
import {
	RequestValidationError,
	validateCanonicalId,
	validateCloudflareCheckpointFetchRequestV1,
	validateCloudflareReplicaCacheEvictionPlanV1,
	validateCloudflareReplicaDeleteRequestV1,
	validateCloudflareRuntimeEffectTransportEnvelopeV1,
	validateCloudflareRuntimeInspectionTransportEnvelopeV1,
	validateCloudflareRuntimeStatusRequestV1,
	validateCreateWorkspaceRequest,
	validateExecRequest,
	validateFilePayload,
	validateFileReadRequest,
} from "./validation";
import type { CloudOmpWorkspace as CloudOmpWorkspaceRpcSource } from "./workspace-object";

export interface WorkspaceRpc
	extends Pick<
		CloudOmpWorkspaceRpcSource,
		| "createWorkspace"
		| "readFile"
		| "writeFile"
		| "getManifest"
		| "createExec"
		| "getExec"
		| "killExec"
		| "deleteExec"
		| "quiesce"
		| "release"
		| "restartForTest"
		| "applyRuntimeEffect"
		| "inspectRuntimeOperation"
		| "applyRuntimeControlEffect"
		| "inspectRuntimeControl"
		| "inspectRuntimeStatus"
		| "fetchRuntimeCheckpoint"
		| "requestReplicaCacheEviction"
		| "inspectReplicaCacheEviction"
		| "deleteRuntimeReplica"
		| "inspectRuntimeReplicaDeletion"
		| "applyRuntimeBridgeOperation"
	> {}

export interface WorkspaceNamespace {
	idFromName(name: string): DurableObjectId;
	get(id: DurableObjectId): WorkspaceRpc;
}

export interface WorkerEnv {
	WORKSPACE: WorkspaceNamespace;
	CLOUD_OMP_BEARER_SHA256: string;
	CLOUD_OMP_ADMIN_BEARER_SHA256?: string;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;
const ADMIN_RESTART_PATH = /^\/v1\/admin\/workspaces\/([^/]+)\/restart$/;
const ADMIN_RESTART_AUTH_PATH = /^\/v1\/admin\/workspaces\/[^/]+\/restart$/;
const WORKSPACE_PATH = /^\/v1\/workspaces\/([^/]+)$/;
const FILE_READ_PATH = /^\/v1\/workspaces\/([^/]+)\/files\/read$/;
const FILE_WRITE_PATH = /^\/v1\/workspaces\/([^/]+)\/files$/;
const MANIFEST_PATH = /^\/v1\/workspaces\/([^/]+)\/manifest$/;
const EXEC_COLLECTION_PATH = /^\/v1\/workspaces\/([^/]+)\/exec$/;
const EXEC_PATH = /^\/v1\/workspaces\/([^/]+)\/exec\/([^/]+)$/;
const EXEC_KILL_PATH = /^\/v1\/workspaces\/([^/]+)\/exec\/([^/]+)\/kill$/;
const QUIESCE_PATH = /^\/v1\/workspaces\/([^/]+)\/quiesce$/;
const RUNTIME_EFFECT_PATH = cloudflareRuntimeRoutesV1.effect;
const RUNTIME_INSPECT_PATH = cloudflareRuntimeRoutesV1.inspect;
const RUNTIME_STATUS_PATH = cloudflareRuntimeRoutesV1.status;
const RUNTIME_CHECKPOINT_FETCH_PATH = cloudflareRuntimeRoutesV1.checkpointFetch;
const RUNTIME_CACHE_EVICTION_PATH = cloudflareRuntimeRoutesV1.cacheEviction;
const RUNTIME_CACHE_EVICTION_INSPECT_PATH = cloudflareRuntimeRoutesV1.cacheEvictionInspect;
const RUNTIME_REPLICA_DELETE_PATH = cloudflareRuntimeRoutesV1.replicaDelete;
const RUNTIME_REPLICA_DELETE_INSPECT_PATH = cloudflareRuntimeRoutesV1.replicaDeleteInspect;
const RUNTIME_PATHS: Readonly<Record<string, true>> = Object.freeze({
	[RUNTIME_EFFECT_PATH]: true,
	[RUNTIME_INSPECT_PATH]: true,
	[RUNTIME_STATUS_PATH]: true,
	[RUNTIME_CHECKPOINT_FETCH_PATH]: true,
	[RUNTIME_CACHE_EVICTION_PATH]: true,
	[RUNTIME_CACHE_EVICTION_INSPECT_PATH]: true,
	[RUNTIME_REPLICA_DELETE_PATH]: true,
	[RUNTIME_REPLICA_DELETE_INSPECT_PATH]: true,
});
const WORKSPACE_ERROR_STATUSES: Partial<Record<number, true>> = {
	400: true,
	404: true,
	409: true,
	410: true,
	422: true,
	500: true,
};
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

const worker = {
	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		try {
			const url = new URL(request.url);
			const pathname = url.pathname;
			const adminRoute = ADMIN_RESTART_AUTH_PATH.test(pathname);
			if (adminRoute && env.CLOUD_OMP_ADMIN_BEARER_SHA256 === undefined) return notFound();

			const expectedDigest = adminRoute ? env.CLOUD_OMP_ADMIN_BEARER_SHA256 : env.CLOUD_OMP_BEARER_SHA256;
			const separatedAdminDigest = !adminRoute || expectedDigest !== env.CLOUD_OMP_BEARER_SHA256;
			if (
				expectedDigest === undefined ||
				!separatedAdminDigest ||
				!(await bearerMatches(request.headers.get("authorization"), expectedDigest))
			) {
				return errorResponse(401, "unauthorized", "Unauthorized");
			}

			if (url.search !== "") {
				throw new RequestValidationError(400, "query_not_allowed", "Query parameters are not allowed");
			}
			if ((pathname === "/v1/runtime" || pathname.startsWith("/v1/runtime/")) && RUNTIME_PATHS[pathname] !== true) {
				return notFound();
			}
			const body = await collectRequestBody(request);
			return await dispatchAuthenticated(request, pathname, body, env);
		} catch (error) {
			return mapError(error);
		}
	},
} satisfies ExportedHandler<WorkerEnv>;

export default worker;

async function dispatchAuthenticated(
	request: Request,
	pathname: string,
	body: Uint8Array,
	env: WorkerEnv,
): Promise<Response> {
	if (pathname === "/v1/health") {
		const methodError = requireMethod(request.method, "GET");
		if (methodError) return methodError;
		requireEmptyBody(body);
		return jsonResponse<HealthResponse>(200, { ok: true });
	}

	if (pathname === RUNTIME_EFFECT_PATH) {
		const methodError = requireMethod(request.method, "POST");
		if (methodError) return methodError;
		const parsed = parseJsonBody(request, body);
		const validated = await validateCloudflareRuntimeEffectTransportEnvelopeV1(parsed);
		const stub = await runtimeStub(env, runtimeReplicaFromEffectTransport(validated));
		const envelope = parsed as CloudflareRuntimeEffectTransportEnvelopeV1;
		const result =
			validated.transportFamily === "lifecycle"
				? await stub.applyRuntimeEffect(envelope)
				: validated.transportFamily === "control"
					? await stub.applyRuntimeControlEffect(envelope)
					: await stub.applyRuntimeBridgeOperation(envelope);
		return jsonResponse(200, await decodeCloudflareRuntimeEffectTransportResultEnvelopeV1(result, validated));
	}

	if (pathname === RUNTIME_INSPECT_PATH) {
		const methodError = requireMethod(request.method, "POST");
		if (methodError) return methodError;
		const parsed = parseJsonBody(request, body);
		const validated = await validateCloudflareRuntimeInspectionTransportEnvelopeV1(parsed);
		const stub = await runtimeStub(env, runtimeReplicaFromInspectionTransport(validated));
		const envelope = parsed as CloudflareRuntimeInspectionTransportEnvelopeV1;
		const result =
			validated.transportFamily === "lifecycle"
				? await stub.inspectRuntimeOperation(envelope)
				: validated.transportFamily === "control"
					? await stub.inspectRuntimeControl(envelope)
					: await stub.applyRuntimeBridgeOperation(envelope);
		return jsonResponse(200, await decodeCloudflareRuntimeInspectionTransportResultEnvelopeV1(result, validated));
	}

	if (pathname === RUNTIME_STATUS_PATH) {
		const methodError = requireMethod(request.method, "POST");
		if (methodError) return methodError;
		const parsed = parseJsonBody(request, body);
		const validated = validateCloudflareRuntimeStatusRequestV1(parsed);
		const result = await (await runtimeStub(env, validated.replica)).inspectRuntimeStatus(parsed);
		return jsonResponse(200, decodeCloudflareRuntimeStatusResponseV1(result, validated));
	}

	if (pathname === RUNTIME_CHECKPOINT_FETCH_PATH) {
		const methodError = requireMethod(request.method, "POST");
		if (methodError) return methodError;
		const parsed = parseJsonBody(request, body);
		const validated = validateCloudflareCheckpointFetchRequestV1(parsed);
		const result = await (
			await runtimeStub(env, {
				providerId: validated.locator.providerId,
				profileId: validated.locator.profileId,
				replicaId: validated.locator.replicaId,
				workspaceId: validated.locator.workspaceId,
			})
		).fetchRuntimeCheckpoint(parsed);
		return jsonResponse(200, await decodeCloudflareCheckpointFetchResponseV1(result, validated));
	}

	if (pathname === RUNTIME_CACHE_EVICTION_PATH || pathname === RUNTIME_CACHE_EVICTION_INSPECT_PATH) {
		const methodError = requireMethod(request.method, "POST");
		if (methodError) return methodError;
		const parsed = parseJsonBody(request, body);
		const plan = await validateCloudflareReplicaCacheEvictionPlanV1(parsed);
		const stub = await runtimeStub(env, plan.replica);
		if (pathname === RUNTIME_CACHE_EVICTION_PATH) {
			const result = await stub.requestReplicaCacheEviction(parsed);
			return jsonResponse(200, await decodeCloudflareReplicaCacheEvictionRequestResultV1(result, plan));
		}
		const result = await stub.inspectReplicaCacheEviction(parsed);
		return jsonResponse(200, await decodeCloudflareReplicaCacheEvictionInspectResultV1(result, plan));
	}

	if (pathname === RUNTIME_REPLICA_DELETE_PATH || pathname === RUNTIME_REPLICA_DELETE_INSPECT_PATH) {
		const methodError = requireMethod(request.method, "POST");
		if (methodError) return methodError;
		const parsed = parseJsonBody(request, body);
		const validated = await validateCloudflareReplicaDeleteRequestV1(parsed);
		const stub = await runtimeStub(env, validated.request.replica);
		if (pathname === RUNTIME_REPLICA_DELETE_PATH) {
			const result = await stub.deleteRuntimeReplica(parsed);
			return jsonResponse(200, await decodeCloudflareReplicaDeleteResultV1(result, validated.request));
		}
		const result = await stub.inspectRuntimeReplicaDeletion(parsed);
		return jsonResponse(200, await decodeCloudflareReplicaDeleteInspectResultV1(result, validated.request));
	}

	const admin = pathname.match(ADMIN_RESTART_PATH);
	if (admin) {
		const methodError = requireMethod(request.method, "POST");
		if (methodError) return methodError;
		requireEmptyBody(body);
		const stub = workspaceStub(env, validateCanonicalId(admin[1], "workspace"));
		return jsonResponse(200, await stub.restartForTest());
	}

	const fileRead = pathname.match(FILE_READ_PATH);
	if (fileRead) {
		const methodError = requireMethod(request.method, "POST");
		if (methodError) return methodError;
		const workspaceId = validateCanonicalId(fileRead[1], "workspace");
		const parsed = validateFileReadRequest(parseJsonBody(request, body));
		const stub = workspaceStub(env, workspaceId);
		return jsonResponse(200, await stub.readFile(parsed));
	}

	const fileWrite = pathname.match(FILE_WRITE_PATH);
	if (fileWrite) {
		const methodError = requireMethod(request.method, "PUT");
		if (methodError) return methodError;
		const workspaceId = validateCanonicalId(fileWrite[1], "workspace");
		const parsed = await validateFilePayload(parseJsonBody(request, body));
		const stub = workspaceStub(env, workspaceId);
		return jsonResponse(200, await stub.writeFile(parsed));
	}

	const manifest = pathname.match(MANIFEST_PATH);
	if (manifest) {
		const methodError = requireMethod(request.method, "GET");
		if (methodError) return methodError;
		requireEmptyBody(body);
		const stub = workspaceStub(env, validateCanonicalId(manifest[1], "workspace"));
		return jsonResponse(200, await stub.getManifest());
	}

	const execKill = pathname.match(EXEC_KILL_PATH);
	if (execKill) {
		const methodError = requireMethod(request.method, "POST");
		if (methodError) return methodError;
		requireEmptyBody(body);
		const workspaceId = validateCanonicalId(execKill[1], "workspace");
		const execId = validateCanonicalId(execKill[2], "execution");
		const stub = workspaceStub(env, workspaceId);
		return jsonResponse(200, await stub.killExec(execId));
	}

	const exec = pathname.match(EXEC_PATH);
	if (exec) {
		const allowedMethod = request.method === "GET" || request.method === "DELETE";
		if (!allowedMethod) return methodNotAllowed("GET, DELETE");
		requireEmptyBody(body);
		const workspaceId = validateCanonicalId(exec[1], "workspace");
		const execId = validateCanonicalId(exec[2], "execution");
		const stub = workspaceStub(env, workspaceId);
		if (request.method === "GET") return jsonResponse(200, await stub.getExec(execId));
		await stub.deleteExec(execId);
		return new Response(null, { status: 204 });
	}

	const execCollection = pathname.match(EXEC_COLLECTION_PATH);
	if (execCollection) {
		const methodError = requireMethod(request.method, "POST");
		if (methodError) return methodError;
		const workspaceId = validateCanonicalId(execCollection[1], "workspace");
		const parsed = validateExecRequest(parseJsonBody(request, body));
		const stub = workspaceStub(env, workspaceId);
		return jsonResponse(200, await stub.createExec(parsed));
	}

	const quiesce = pathname.match(QUIESCE_PATH);
	if (quiesce) {
		const methodError = requireMethod(request.method, "POST");
		if (methodError) return methodError;
		requireEmptyBody(body);
		const stub = workspaceStub(env, validateCanonicalId(quiesce[1], "workspace"));
		return jsonResponse(200, await stub.quiesce());
	}

	const workspace = pathname.match(WORKSPACE_PATH);
	if (workspace) {
		const workspaceId = validateCanonicalId(workspace[1], "workspace");
		if (request.method === "PUT") {
			const parsed = await validateCreateWorkspaceRequest(parseJsonBody(request, body));
			return jsonResponse(200, await workspaceStub(env, workspaceId).createWorkspace(workspaceId, parsed));
		}
		if (request.method === "DELETE") {
			requireEmptyBody(body);
			await workspaceStub(env, workspaceId).release();
			return new Response(null, { status: 204 });
		}
		return methodNotAllowed("PUT, DELETE");
	}

	return notFound();
}

function workspaceStub(env: WorkerEnv, workspaceId: string): WorkspaceRpc {
	const durableId = env.WORKSPACE.idFromName(workspaceId);
	return env.WORKSPACE.get(durableId);
}

async function runtimeStub(env: WorkerEnv, replica: RuntimeReplicaRef): Promise<WorkspaceRpc> {
	const name = await deriveCloudflareRuntimeDurableObjectNameV1(replica);
	return env.WORKSPACE.get(env.WORKSPACE.idFromName(name));
}

function runtimeReplicaFromEffectTransport(validated: CloudflareValidatedRuntimeEffectTransportV1): RuntimeReplicaRef {
	return validated.transportFamily === "lifecycle" ? runtimeReplicaFromLifecycle(validated) : validated.replica;
}

function runtimeReplicaFromInspectionTransport(
	validated: CloudflareValidatedRuntimeInspectionTransportV1,
): RuntimeReplicaRef {
	return validated.transportFamily === "lifecycle" ? runtimeReplicaFromLifecycle(validated) : validated.replica;
}

function runtimeReplicaFromLifecycle(validated: CloudflareValidatedRuntimeOperationV1): RuntimeReplicaRef {
	const inspection = validated.inspection;
	switch (inspection.operation) {
		case "acquire":
			return inspection.request.plan.replica;
		case "push":
		case "quiesce":
		case "checkpoint":
			return inspection.request.lease.replica;
		case "revoke":
		case "release":
			return inspection.request.replica;
		case "checkpoint_acknowledgement":
			return {
				providerId: inspection.request.reference.providerId,
				profileId: inspection.request.reference.profileId,
				workspaceId: inspection.request.reference.workspaceId,
				replicaId: inspection.request.reference.replicaId,
			};
	}
}

async function collectRequestBody(request: Request): Promise<Uint8Array> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		if (!/^\d+$/.test(declaredLength)) {
			throw new RequestValidationError(400, "content_length_invalid", "Invalid Content-Length");
		}
		const parsedLength = Number(declaredLength);
		if (!Number.isSafeInteger(parsedLength)) {
			throw new RequestValidationError(413, "request_too_large", "Request body exceeds size limit");
		}
		if (parsedLength > MAX_HTTP_BODY_BYTES) {
			throw new RequestValidationError(413, "request_too_large", "Request body exceeds size limit");
		}
	}
	if (request.body === null) return new Uint8Array();

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_HTTP_BODY_BYTES) {
				await reader.cancel().catch(() => {});
				throw new RequestValidationError(413, "request_too_large", "Request body exceeds size limit");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	if (chunks.length === 1) return chunks[0];
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function parseJsonBody(request: Request, body: Uint8Array): unknown {
	const contentType = request.headers.get("content-type");
	if (contentType === null || contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
		throw new RequestValidationError(415, "content_type_invalid", "Content-Type must be application/json");
	}
	if (body.byteLength === 0) throw new RequestValidationError(400, "json_invalid", "Request body must contain JSON");
	let text: string;
	try {
		text = fatalDecoder.decode(body);
	} catch {
		throw new RequestValidationError(400, "json_invalid", "Request body must be strict UTF-8 JSON");
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new RequestValidationError(400, "json_invalid", "Request body must contain valid JSON");
	}
}

function requireEmptyBody(body: Uint8Array): void {
	if (body.byteLength !== 0) throw new RequestValidationError(400, "body_not_allowed", "Request body is not allowed");
}

function requireMethod(actual: string, allowed: string): Response | null {
	return actual === allowed ? null : methodNotAllowed(allowed);
}

function methodNotAllowed(allowed: string): Response {
	return errorResponse(405, "method_not_allowed", "Method not allowed", { allow: allowed });
}

function notFound(): Response {
	return errorResponse(404, "not_found", "Not found");
}

function mapError(error: unknown): Response {
	if (error instanceof RequestValidationError) return errorResponse(error.status, error.code, error.message);
	if (isWorkspaceObjectError(error)) {
		if (error.status === 500) return errorResponse(500, "internal_error", "Internal server error");
		return errorResponse(error.status, error.code, error.message);
	}
	return errorResponse(500, "internal_error", "Internal server error");
}

function isWorkspaceObjectError(
	error: unknown,
): error is { status: number; code: CloudOmpWireErrorCode; message: string } {
	if (error === null || typeof error !== "object") return false;
	const candidate = error as { name?: unknown; status?: unknown; code?: unknown; message?: unknown };
	return (
		candidate.name === "WorkspaceObjectError" &&
		typeof candidate.status === "number" &&
		WORKSPACE_ERROR_STATUSES[candidate.status] === true &&
		isCloudOmpWireErrorCode(candidate.code) &&
		typeof candidate.message === "string" &&
		candidate.message.length > 0 &&
		candidate.message.length <= 1_024
	);
}

function jsonResponse<T>(status: number, body: T): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorResponse(status: number, code: CloudOmpWireErrorCode, message: string, headers?: HeadersInit): Response {
	const body: WireErrorResponse = { error: { code, message } };
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...JSON_HEADERS, ...headers },
	});
}
