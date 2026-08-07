import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type {
	ClientBridgeCreateTerminalParams,
	ClientBridgeTerminalExitStatus,
} from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { hasExactObjectKeys } from "../boundary-policy";
import {
	CLOUD_OMP_REMOTE_ROOT,
	CLOUDFLARE_RUNTIME_PROTOCOL_ERROR_CODES_V1,
	type CloudflareCheckpointFetchRequestV1,
	type CloudflareCheckpointFetchResponseV1,
	type CloudflareDurableDeadlineV1,
	type CloudflareReplicaCacheEvictionAcceptanceV1,
	type CloudflareReplicaCacheEvictionInspectResultV1,
	type CloudflareReplicaCacheEvictionRequestResultV1,
	type CloudflareReplicaDeleteInspectResultV1,
	type CloudflareReplicaDeleteResultV1,
	type CloudflareReplicaDeletionValidationV1,
	type CloudflareRuntimeEffectEnvelopeV1,
	type CloudflareRuntimeEffectResultEnvelopeV1,
	type CloudflareRuntimeEffectTransportEnvelopeV1,
	type CloudflareRuntimeEffectTransportResultEnvelopeV1,
	type CloudflareRuntimeInspectionEnvelopeV1,
	type CloudflareRuntimeInspectionResultEnvelopeV1,
	type CloudflareRuntimeInspectionTransportEnvelopeV1,
	type CloudflareRuntimeInspectionTransportResultEnvelopeV1,
	type CloudflareRuntimeProtocolErrorCodeV1,
	CloudflareRuntimeProtocolErrorV1,
	type CloudflareRuntimeStatusRequestV1,
	type CloudflareRuntimeStatusResponseV1,
	type CloudflareValidatedRuntimeEffectTransportV1,
	type CloudflareValidatedRuntimeInspectionTransportV1,
	type CloudflareValidatedRuntimeOperationV1,
	type CreateWorkspaceRequest,
	canonicalRuntimeSha256V1,
	cloudOmpRoutes,
	decodeCloudflareCheckpointFetchRequestV1,
	decodeCloudflareCheckpointFetchResponseV1,
	decodeCloudflareDurableDeadlineV1,
	decodeCloudflareReplicaCacheEvictionAcceptanceV1,
	decodeCloudflareReplicaCacheEvictionInspectResultV1,
	decodeCloudflareReplicaCacheEvictionPlanV1,
	decodeCloudflareReplicaCacheEvictionRequestResultV1,
	decodeCloudflareReplicaDeleteInspectResultV1,
	decodeCloudflareReplicaDeleteRequestV1,
	decodeCloudflareReplicaDeleteResultV1,
	decodeCloudflareRuntimeEffectEnvelopeV1,
	decodeCloudflareRuntimeEffectResultEnvelopeV1,
	decodeCloudflareRuntimeEffectTransportEnvelopeV1,
	decodeCloudflareRuntimeEffectTransportResultEnvelopeV1,
	decodeCloudflareRuntimeInspectionEnvelopeV1,
	decodeCloudflareRuntimeInspectionResultEnvelopeV1,
	decodeCloudflareRuntimeInspectionTransportEnvelopeV1,
	decodeCloudflareRuntimeInspectionTransportResultEnvelopeV1,
	decodeCloudflareRuntimeStatusRequestV1,
	decodeCloudflareRuntimeStatusResponseV1,
	type ExecCreateResponse,
	type ExecSnapshot,
	encodeCanonicalRuntimeTupleV1,
	type FilePayload,
	isJsonObject,
	isWireId,
	MAX_COMMAND_BYTES,
	MAX_COMMAND_TIMEOUT_MS,
	MAX_EXEC_OUTPUT_BYTES,
	MAX_SYNC_FILE_BYTES,
	type ManifestResponse,
	projectCloudflareRuntimeInspectionTupleV1,
	type WorkspaceState,
} from "../protocol";
import {
	CLOUD_OMP_PROTOCOL_ERROR_CODES,
	CloudOmpAbortError,
	CloudOmpHttpError,
	type CloudOmpJsonClient,
	CloudOmpProtocolError,
	type CloudOmpProtocolErrorCode,
	CloudOmpTransportError,
} from "./http";

export const POLL_INTERVAL_MS = 250;

export const CLOUD_OMP_ENVIRONMENT_ERROR_CODES = Object.freeze({
	ABORTED: true,
	TRANSPORT_FAILURE: true,
	REMOTE_ERROR: true,
	INVALID_GENERATED_ID: true,
	LEASE_RELEASED: true,
	FILE_TOO_LARGE: true,
	INVALID_TERMINAL_REQUEST: true,
	INVALID_TERMINAL_CWD: true,
	INVALID_COMMAND: true,
	COMMAND_TOO_LARGE: true,
	INVALID_REMOTE_PATH: true,
	INVALID_READ_RANGE: true,
	INVALID_OUTPUT: true,
	UNEXPECTED_FAILURE: true,
	INVALID_FILE_UTF8: true,
} as const);

export type CloudOmpEnvironmentErrorCode = keyof typeof CLOUD_OMP_ENVIRONMENT_ERROR_CODES;
export type CloudOmpClientErrorCode =
	| CloudOmpEnvironmentErrorCode
	| CloudOmpProtocolErrorCode
	| CloudflareRuntimeProtocolErrorCodeV1;
export type CloudOmpEnvironmentErrorKind = "abort" | "transport" | "protocol" | "http" | "environment" | "unexpected";
export type CloudOmpOperationStage =
	| "acquire"
	| "read"
	| "write"
	| "exec_start"
	| "exec_poll"
	| "exec_kill"
	| "exec_dispose"
	| "sync_back"
	| "release"
	| "slot"
	| "validation"
	| "unknown";

export class CloudOmpEnvironmentError extends Error {
	readonly kind: CloudOmpEnvironmentErrorKind;
	readonly stage: CloudOmpOperationStage;
	readonly code: CloudOmpClientErrorCode;
	readonly status?: number;
	declare readonly cause?: unknown;

	constructor(
		kind: CloudOmpEnvironmentErrorKind,
		stage: CloudOmpOperationStage,
		code: CloudOmpClientErrorCode,
		options: { status?: number; cause?: unknown } = {},
	) {
		const safeCode: CloudOmpClientErrorCode = isCloudOmpClientErrorCode(code) ? code : "UNEXPECTED_FAILURE";
		super(`Cloud OMP ${kind} failure during ${stage} (${safeCode})`);
		this.name = "CloudOmpEnvironmentError";
		this.kind = kind;
		this.stage = stage;
		this.code = safeCode;
		this.status = options.status;
		if (options.cause !== undefined)
			Object.defineProperty(this, "cause", { value: options.cause, configurable: true });
	}
}

export function isCloudOmpClientErrorCode(value: unknown): value is CloudOmpClientErrorCode {
	return (
		typeof value === "string" &&
		(Object.hasOwn(CLOUD_OMP_ENVIRONMENT_ERROR_CODES, value) ||
			Object.hasOwn(CLOUD_OMP_PROTOCOL_ERROR_CODES, value) ||
			Object.hasOwn(CLOUDFLARE_RUNTIME_PROTOCOL_ERROR_CODES_V1, value))
	);
}

function environmentFailure(
	code: CloudOmpEnvironmentErrorCode,
	stage: CloudOmpOperationStage = "validation",
): CloudOmpEnvironmentError {
	return new CloudOmpEnvironmentError("environment", stage, code);
}

export async function retryWorkspacePutOnce(
	http: CloudOmpJsonClient,
	workspaceId: string,
	body: CreateWorkspaceRequest,
	signal?: AbortSignal,
): Promise<unknown> {
	return retryTransportOnce(() =>
		http.requestJson<unknown>({ method: "PUT", path: cloudOmpRoutes.workspace(workspaceId), body, signal }),
	);
}

export async function retryTransportOnce<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!(error instanceof CloudOmpTransportError)) throw error;
		return operation();
	}
}

export async function bestEffortDelete(
	http: CloudOmpJsonClient,
	workspaceId: string,
): Promise<"released" | "ambiguous" | "failed"> {
	try {
		await http.requestEmpty({ method: "DELETE", path: cloudOmpRoutes.workspace(workspaceId) });
		return "released";
	} catch (error) {
		return error instanceof CloudOmpTransportError ? "ambiguous" : "failed";
	}
}

export function validateCreateWorkspaceResponse(value: unknown, expectedWorkspaceId: string): number {
	if (!hasExactObjectKeys(value, ["workspaceId", "remoteRoot", "expiresAt"])) throw new CloudOmpProtocolError();
	if (value.workspaceId !== expectedWorkspaceId || value.remoteRoot !== CLOUD_OMP_REMOTE_ROOT) {
		throw new CloudOmpProtocolError();
	}
	const expiresAt = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : Number.NaN;
	if (!Number.isFinite(expiresAt)) throw new CloudOmpProtocolError();
	return expiresAt;
}

export function validateExecCreateResponse(value: unknown): ExecCreateResponse {
	if (!hasExactObjectKeys(value, ["execId"]) || !isWireId(value.execId)) throw new CloudOmpProtocolError();
	return value as unknown as ExecCreateResponse;
}

export function validateExecSnapshot(value: unknown, expectedExecId: string, outputByteLimit: number): ExecSnapshot {
	if (!isJsonObject(value)) throw new CloudOmpProtocolError();
	const allowedKeys = ["execId", "status", "output", "truncated", "sync", "exitCode", "signal"];
	const requiredKeys = ["execId", "status", "output", "truncated", "sync"];
	if (Object.keys(value).some(key => !allowedKeys.includes(key)) || requiredKeys.some(key => !(key in value))) {
		throw new CloudOmpProtocolError();
	}
	if (
		value.execId !== expectedExecId ||
		!["starting", "running", "completed", "failed", "cancelled"].includes(value.status as string) ||
		typeof value.output !== "string" ||
		typeof value.truncated !== "boolean" ||
		!["pending", "complete", "exhausted"].includes(value.sync as string)
	) {
		throw new CloudOmpProtocolError();
	}
	const outputByteLength = encodeStrictUtf8(value.output, "INVALID_OUTPUT").byteLength;
	if (outputByteLength > outputByteLimit || outputByteLength > MAX_EXEC_OUTPUT_BYTES) {
		throw new CloudOmpProtocolError("OUTPUT_LIMIT_EXCEEDED");
	}
	if (value.exitCode !== undefined && value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) {
		throw new CloudOmpProtocolError();
	}
	if (
		value.signal !== undefined &&
		value.signal !== null &&
		(typeof value.signal !== "string" || value.signal.length > 64)
	) {
		throw new CloudOmpProtocolError();
	}
	if (value.status === "completed" && value.sync !== "complete") throw new CloudOmpProtocolError("SYNC_INCOMPLETE");
	return Object.freeze({ ...value }) as unknown as ExecSnapshot;
}

export function validateWorkspaceState(value: unknown, expectedPhase?: WorkspaceState["phase"]): WorkspaceState {
	if (!hasExactObjectKeys(value, ["phase", "activeExecutions", "pendingSyncs", "exhaustedSyncs"])) {
		throw new CloudOmpProtocolError();
	}
	if (!["active", "quiescing", "quiesced", "released"].includes(value.phase as string)) {
		throw new CloudOmpProtocolError();
	}
	for (const key of ["activeExecutions", "pendingSyncs", "exhaustedSyncs"] as const) {
		if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) throw new CloudOmpProtocolError();
	}
	if (expectedPhase && value.phase !== expectedPhase) throw new CloudOmpProtocolError("QUIESCE_INCOMPLETE");
	if (
		expectedPhase === "quiesced" &&
		(value.activeExecutions !== 0 || value.pendingSyncs !== 0 || value.exhaustedSyncs !== 0)
	) {
		throw new CloudOmpProtocolError("WORKSPACE_NOT_SETTLED");
	}
	return value as unknown as WorkspaceState;
}

export function validateManifestResponse(value: unknown): ManifestResponse {
	if (!hasExactObjectKeys(value, ["phase", "rootSha256", "files"])) throw new CloudOmpProtocolError();
	if (value.phase !== "quiesced" || typeof value.rootSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.rootSha256)) {
		throw new CloudOmpProtocolError();
	}
	if (!Array.isArray(value.files)) throw new CloudOmpProtocolError();
	return value as unknown as ManifestResponse;
}

export function createFilePayload(path: string, content: string): FilePayload {
	validateBoundaryPath(path);
	const encoded = encodeStrictUtf8(content, "INVALID_FILE_UTF8");
	const bytes = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
	if (bytes.byteLength > MAX_SYNC_FILE_BYTES) throw environmentFailure("FILE_TOO_LARGE");
	return {
		path,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		byteLength: bytes.byteLength,
		contentBase64: bytes.toString("base64"),
	};
}

export function validateFilePayload(value: unknown, expectedPath: string): asserts value is FilePayload {
	void decodeFilePayload(value, expectedPath);
}

export function decodeFilePayload(value: unknown, expectedPath: string): string {
	if (!hasExactObjectKeys(value, ["path", "sha256", "byteLength", "contentBase64"])) throw new CloudOmpProtocolError();
	if (
		value.path !== expectedPath ||
		typeof value.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.sha256) ||
		!Number.isSafeInteger(value.byteLength) ||
		(value.byteLength as number) < 0 ||
		(value.byteLength as number) > MAX_SYNC_FILE_BYTES ||
		typeof value.contentBase64 !== "string"
	) {
		throw new CloudOmpProtocolError();
	}
	const bytes = Buffer.from(value.contentBase64, "base64");
	if (bytes.toString("base64") !== value.contentBase64 || bytes.byteLength !== value.byteLength) {
		throw new CloudOmpProtocolError("INVALID_FILE_PAYLOAD");
	}
	if (createHash("sha256").update(bytes).digest("hex") !== value.sha256) {
		throw new CloudOmpProtocolError("INVALID_FILE_DIGEST");
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new CloudOmpProtocolError("INVALID_FILE_UTF8");
	}
}

export function validateTerminalParams(params: ClientBridgeCreateTerminalParams): void {
	if (!isJsonObject(params)) throw environmentFailure("INVALID_TERMINAL_REQUEST");
	const allowedKeys = ["command", "args", "cwd", "env", "outputByteLimit", "timeoutMs"];
	if (Object.keys(params).some(key => !allowedKeys.includes(key)))
		throw environmentFailure("INVALID_TERMINAL_REQUEST");
	const outputByteLimit = params.outputByteLimit;
	const timeoutMs = params.timeoutMs;
	if (
		params.command !== "/bin/bash" ||
		!Array.isArray(params.args) ||
		params.args.length !== 4 ||
		params.args[0] !== "--noprofile" ||
		params.args[1] !== "--norc" ||
		params.args[2] !== "-c" ||
		typeof params.args[3] !== "string" ||
		params.env !== undefined ||
		typeof params.cwd !== "string" ||
		typeof outputByteLimit !== "number" ||
		!Number.isSafeInteger(outputByteLimit) ||
		outputByteLimit < 1 ||
		outputByteLimit > MAX_EXEC_OUTPUT_BYTES ||
		typeof timeoutMs !== "number" ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > MAX_COMMAND_TIMEOUT_MS
	) {
		throw environmentFailure("INVALID_TERMINAL_REQUEST");
	}
	if (params.cwd !== CLOUD_OMP_REMOTE_ROOT && !params.cwd.startsWith(`${CLOUD_OMP_REMOTE_ROOT}/`)) {
		throw environmentFailure("INVALID_TERMINAL_CWD");
	}
	if (
		!params.cwd.startsWith("/") ||
		params.cwd
			.split("/")
			.some((segment, index) => index > 0 && (segment === "" || segment === "." || segment === ".."))
	) {
		throw environmentFailure("INVALID_TERMINAL_CWD");
	}
}

export function validateCommand(source: string): void {
	if (source.length === 0 || source.includes("\0")) throw environmentFailure("INVALID_COMMAND");
	if (encodeStrictUtf8(source, "INVALID_COMMAND").byteLength > MAX_COMMAND_BYTES) {
		throw environmentFailure("COMMAND_TOO_LARGE");
	}
}

export function toBoundaryPath(remotePath: string): string {
	if (!remotePath.startsWith(`${CLOUD_OMP_REMOTE_ROOT}/`)) throw environmentFailure("INVALID_REMOTE_PATH");
	const path = remotePath.slice(CLOUD_OMP_REMOTE_ROOT.length + 1);
	validateBoundaryPath(path);
	return path;
}

export function selectLines(content: string, line?: number, limit?: number): string {
	if (line === undefined && limit === undefined) return content;
	if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw environmentFailure("INVALID_READ_RANGE");
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
		throw environmentFailure("INVALID_READ_RANGE");
	const lines = content.split("\n");
	return lines.slice((line ?? 1) - 1, (line ?? 1) - 1 + (limit ?? lines.length)).join("\n");
}

export function isTerminal(snapshot: ExecSnapshot): boolean {
	return snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "cancelled";
}

export function terminalExitStatus(snapshot: ExecSnapshot): ClientBridgeTerminalExitStatus {
	if (snapshot.status === "completed") return { exitCode: snapshot.exitCode ?? 0, signal: snapshot.signal ?? null };
	if (snapshot.signal) return { exitCode: null, signal: snapshot.signal };
	return { exitCode: snapshot.exitCode && snapshot.exitCode !== 0 ? snapshot.exitCode : 1, signal: null };
}

export function assertNotAborted(signal?: AbortSignal, stage: CloudOmpOperationStage = "unknown"): void {
	if (signal?.aborted) throw new CloudOmpEnvironmentError("abort", stage, "ABORTED");
}

export function sanitizeEnvironmentError(
	error: unknown,
	signal?: AbortSignal,
	stage: CloudOmpOperationStage = "unknown",
): CloudOmpEnvironmentError {
	if (signal?.aborted || error instanceof CloudOmpAbortError) {
		return new CloudOmpEnvironmentError("abort", stage, "ABORTED", { cause: error });
	}
	if (error instanceof CloudOmpEnvironmentError) {
		return new CloudOmpEnvironmentError(error.kind, stage, error.code, { status: error.status, cause: error });
	}
	if (error instanceof CloudOmpTransportError) {
		return new CloudOmpEnvironmentError("transport", stage, "TRANSPORT_FAILURE", { cause: error });
	}
	if (error instanceof CloudOmpProtocolError) {
		return new CloudOmpEnvironmentError("protocol", stage, error.code, { cause: error });
	}
	if (error instanceof CloudOmpHttpError) {
		return new CloudOmpEnvironmentError("http", stage, "REMOTE_ERROR", { status: error.status, cause: error });
	}
	if (error instanceof CloudflareRuntimeProtocolErrorV1) {
		return new CloudOmpEnvironmentError("protocol", stage, error.code, { cause: error });
	}
	return new CloudOmpEnvironmentError("unexpected", stage, "UNEXPECTED_FAILURE", { cause: error });
}

export function elapsedMs(startedAt: number): number {
	return Math.max(0, performance.now() - startedAt);
}

export function once(callback: () => void): () => void {
	let called = false;
	return () => {
		if (called) return;
		called = true;
		callback();
	};
}

export function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

type UnrefableTimer = { unref?: () => void };

export function scheduleReleaseAtExpiry(release: () => void, expiresAt: number): void {
	const timer = setTimeout(release, Math.max(0, expiresAt - Date.now())) as unknown as UnrefableTimer;
	timer.unref?.();
}

function validateBoundaryPath(path: string): void {
	if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
		throw environmentFailure("INVALID_REMOTE_PATH");
	}
	for (const segment of path.split("/")) {
		if (segment === "" || segment === "." || segment === ".." || segment.normalize("NFC") !== segment) {
			throw environmentFailure("INVALID_REMOTE_PATH");
		}
	}
}

function encodeStrictUtf8(value: string, code: CloudOmpEnvironmentErrorCode): Uint8Array {
	const bytes = new TextEncoder().encode(value);
	if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value) throw environmentFailure(code);
	return bytes;
}

async function validateClientRuntimeOperationV1(
	input: unknown,
	effect: boolean,
): Promise<CloudflareValidatedRuntimeOperationV1> {
	const validation = effect
		? await decodeCloudflareRuntimeEffectEnvelopeV1(input)
		: await decodeCloudflareRuntimeInspectionEnvelopeV1(input);
	const tuple = projectCloudflareRuntimeInspectionTupleV1(validation.inspection);
	const digest = await canonicalRuntimeSha256V1(tuple);
	const tupleUtf8 = new TextDecoder().decode(encodeCanonicalRuntimeTupleV1(tuple));
	if (digest !== validation.requestSha256 || tupleUtf8 !== validation.canonicalTupleUtf8) {
		throw new CloudflareRuntimeProtocolErrorV1("request_digest_mismatch");
	}
	return validation;
}

export async function encodeCloudflareRuntimeEffectWireV1(input: CloudflareRuntimeEffectEnvelopeV1): Promise<string> {
	const validation = await validateClientRuntimeOperationV1(input, true);
	return JSON.stringify(validation.envelope);
}

export async function encodeCloudflareRuntimeInspectionWireV1(
	input: CloudflareRuntimeInspectionEnvelopeV1,
): Promise<string> {
	const validation = await validateClientRuntimeOperationV1(input, false);
	return JSON.stringify(validation.envelope);
}

export async function decodeCloudflareRuntimeEffectResultWireV1(
	input: unknown,
	expectedRequest: CloudflareRuntimeEffectEnvelopeV1,
): Promise<CloudflareRuntimeEffectResultEnvelopeV1> {
	const expected = await validateClientRuntimeOperationV1(expectedRequest, true);
	return decodeCloudflareRuntimeEffectResultEnvelopeV1(input, expected);
}

export async function decodeCloudflareRuntimeInspectionResultWireV1(
	input: unknown,
	expectedRequest: CloudflareRuntimeInspectionEnvelopeV1,
): Promise<CloudflareRuntimeInspectionResultEnvelopeV1> {
	const expected = await validateClientRuntimeOperationV1(expectedRequest, false);
	return decodeCloudflareRuntimeInspectionResultEnvelopeV1(input, expected);
}

async function validateClientRuntimeEffectTransportV1(
	input: CloudflareRuntimeEffectTransportEnvelopeV1,
): Promise<CloudflareValidatedRuntimeEffectTransportV1> {
	const validation = await decodeCloudflareRuntimeEffectTransportEnvelopeV1(input);
	if (validation.transportFamily === "lifecycle") await validateClientRuntimeOperationV1(validation.envelope, true);
	return validation;
}

async function validateClientRuntimeInspectionTransportV1(
	input: CloudflareRuntimeInspectionTransportEnvelopeV1,
): Promise<CloudflareValidatedRuntimeInspectionTransportV1> {
	const validation = await decodeCloudflareRuntimeInspectionTransportEnvelopeV1(input);
	if (validation.transportFamily === "lifecycle") await validateClientRuntimeOperationV1(validation.envelope, false);
	return validation;
}

export async function encodeCloudflareRuntimeEffectTransportWireV1(
	input: CloudflareRuntimeEffectTransportEnvelopeV1,
): Promise<string> {
	const validation = await validateClientRuntimeEffectTransportV1(input);
	if (validation.transportFamily === "lifecycle") return JSON.stringify(validation.envelope);
	const { transportFamily: _transportFamily, ...envelope } = validation;
	return JSON.stringify(envelope);
}

export async function encodeCloudflareRuntimeInspectionTransportWireV1(
	input: CloudflareRuntimeInspectionTransportEnvelopeV1,
): Promise<string> {
	const validation = await validateClientRuntimeInspectionTransportV1(input);
	if (validation.transportFamily === "lifecycle") return JSON.stringify(validation.envelope);
	const { transportFamily: _transportFamily, ...envelope } = validation;
	return JSON.stringify(envelope);
}

export async function decodeCloudflareRuntimeEffectTransportResultWireV1(
	input: unknown,
	expectedRequest: CloudflareRuntimeEffectTransportEnvelopeV1,
): Promise<CloudflareRuntimeEffectTransportResultEnvelopeV1> {
	const expected = await validateClientRuntimeEffectTransportV1(expectedRequest);
	return decodeCloudflareRuntimeEffectTransportResultEnvelopeV1(input, expected);
}

export async function decodeCloudflareRuntimeInspectionTransportResultWireV1(
	input: unknown,
	expectedRequest: CloudflareRuntimeInspectionTransportEnvelopeV1,
): Promise<CloudflareRuntimeInspectionTransportResultEnvelopeV1> {
	const expected = await validateClientRuntimeInspectionTransportV1(expectedRequest);
	return decodeCloudflareRuntimeInspectionTransportResultEnvelopeV1(input, expected);
}

export async function encodeCloudflareReplicaCacheEvictionWireV1(
	input: unknown,
	options: { readonly workspaceRetentionMs?: number } = {},
): Promise<string> {
	const plan = await decodeCloudflareReplicaCacheEvictionPlanV1(input, options);
	return JSON.stringify(plan);
}

export async function decodeCloudflareReplicaCacheEvictionAcceptanceWireV1(
	input: unknown,
	plan: unknown,
	options: { readonly workspaceRetentionMs?: number } = {},
): Promise<CloudflareReplicaCacheEvictionAcceptanceV1> {
	return decodeCloudflareReplicaCacheEvictionAcceptanceV1(input, plan, options);
}

export async function decodeCloudflareReplicaCacheEvictionResultWireV1(
	input: unknown,
	plan: unknown,
	inspection: boolean,
	options: { readonly workspaceRetentionMs?: number } = {},
): Promise<CloudflareReplicaCacheEvictionInspectResultV1 | CloudflareReplicaCacheEvictionRequestResultV1> {
	return inspection
		? decodeCloudflareReplicaCacheEvictionInspectResultV1(input, plan, options)
		: decodeCloudflareReplicaCacheEvictionRequestResultV1(input, plan, options);
}

export async function encodeCloudflareReplicaDeleteWireV1(
	input: unknown,
	expectedDomain?: "persistent" | "transient_task",
): Promise<string> {
	const validation = await decodeCloudflareReplicaDeleteRequestV1(input, expectedDomain);
	return JSON.stringify(validation.request);
}

export async function decodeCloudflareReplicaDeleteResultWireV1(
	input: unknown,
	request: unknown,
	inspection: boolean,
	expectedDomain?: "persistent" | "transient_task",
): Promise<CloudflareReplicaDeleteInspectResultV1 | CloudflareReplicaDeleteResultV1> {
	return inspection
		? decodeCloudflareReplicaDeleteInspectResultV1(input, request, expectedDomain)
		: decodeCloudflareReplicaDeleteResultV1(input, request, expectedDomain);
}

export function encodeCloudflareRuntimeStatusWireV1(input: CloudflareRuntimeStatusRequestV1): string {
	return JSON.stringify(decodeCloudflareRuntimeStatusRequestV1(input));
}

export function decodeCloudflareRuntimeStatusWireV1(
	input: unknown,
	expectedRequest?: CloudflareRuntimeStatusRequestV1,
): CloudflareRuntimeStatusResponseV1 {
	return decodeCloudflareRuntimeStatusResponseV1(input, expectedRequest);
}

export function encodeCloudflareCheckpointFetchWireV1(input: CloudflareCheckpointFetchRequestV1): string {
	return JSON.stringify(decodeCloudflareCheckpointFetchRequestV1(input));
}

export function decodeCloudflareCheckpointFetchWireV1(
	input: unknown,
	expectedRequest?: CloudflareCheckpointFetchRequestV1,
): Promise<CloudflareCheckpointFetchResponseV1> {
	return decodeCloudflareCheckpointFetchResponseV1(input, expectedRequest);
}

export function decodeCloudflareDurableDeadlineWireV1(
	input: unknown,
	options: { readonly workspaceRetentionMs?: number } = {},
): Promise<CloudflareDurableDeadlineV1> {
	return decodeCloudflareDurableDeadlineV1(input, options);
}

export type { CloudflareReplicaDeletionValidationV1 };
