import { CLOUD_OMP_BOUNDARY_LIMITS, hasExactObjectKeys, MAX_SYNC_FILE_BASE64_BYTES } from "../boundary-policy";
import type {
	CloudOmpWireErrorCode,
	CreateWorkspaceRequest,
	ExecRequest,
	FilePayload,
	FileReadRequest,
} from "../protocol";
import {
	type CloudflareCheckpointFetchRequestV1,
	type CloudflareDurableDeadlineV1,
	type CloudflareReplicaCacheEvictionPlanV1,
	type CloudflareReplicaDeletionValidationV1,
	CloudflareRuntimeProtocolErrorV1,
	type CloudflareRuntimeStatusRequestV1,
	type CloudflareValidatedRuntimeEffectTransportV1,
	type CloudflareValidatedRuntimeInspectionTransportV1,
	type CloudflareValidatedRuntimeOperationV1,
	canonicalRuntimeSha256V1,
	decodeCloudflareCheckpointFetchRequestV1,
	decodeCloudflareDurableDeadlineV1,
	decodeCloudflareReplicaCacheEvictionPlanV1,
	decodeCloudflareReplicaDeleteRequestV1,
	decodeCloudflareRuntimeEffectEnvelopeV1,
	decodeCloudflareRuntimeEffectTransportEnvelopeV1,
	decodeCloudflareRuntimeInspectionEnvelopeV1,
	decodeCloudflareRuntimeInspectionTransportEnvelopeV1,
	decodeCloudflareRuntimeStatusRequestV1,
	encodeCanonicalRuntimeTupleV1,
	isJsonObject,
	projectCloudflareRuntimeInspectionTupleV1,
} from "../protocol";
import {
	canonicalRelativePath,
	canonicalWorkspaceDirectory,
	manifestRootSha256,
	validateManifestEntries,
	validatePayload,
} from "./workspace-files";

const ID_PATTERN = /^[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

export class RequestValidationError extends Error {
	readonly status: number;
	readonly code: CloudOmpWireErrorCode;

	constructor(status: number, code: CloudOmpWireErrorCode, message: string) {
		super(message);
		this.name = "RequestValidationError";
		this.status = status;
		this.code = code;
	}
}

export function validateCanonicalId(value: string, kind: "workspace" | "execution"): string {
	if (!ID_PATTERN.test(value)) {
		throw invalid(kind === "workspace" ? "workspace_id_invalid" : "execution_id_invalid", `Invalid ${kind} ID`);
	}
	return value;
}

export async function validateCreateWorkspaceRequest(value: unknown): Promise<CreateWorkspaceRequest> {
	const record = strictRecord(value, ["auditCorrelationId", "seedRootSha256", "files"]);
	const auditCorrelationId = requiredString(record.auditCorrelationId, "audit_correlation_id_invalid");
	if (!ID_PATTERN.test(auditCorrelationId)) {
		throw invalid("audit_correlation_id_invalid", "Invalid audit correlation ID");
	}
	const seedRootSha256 = sha256String(record.seedRootSha256, "seed_root_invalid");
	if (!Array.isArray(record.files)) throw invalid("files_invalid", "Invalid workspace files");
	if (record.files.length > CLOUD_OMP_BOUNDARY_LIMITS.syncFileCount) {
		throw tooLarge("file_count_exceeded", "Workspace file count exceeds limit");
	}
	let declaredTotalBytes = 0;
	for (const candidate of record.files) {
		const fileRecord = strictRecord(candidate, ["path", "sha256", "byteLength", "contentBase64"]);
		const byteLength = nonNegativeSafeInteger(fileRecord.byteLength, "file_length_invalid");
		if (byteLength > CLOUD_OMP_BOUNDARY_LIMITS.syncFileBytes) {
			throw tooLarge("file_too_large", "Workspace file exceeds size limit");
		}
		declaredTotalBytes += byteLength;
		if (declaredTotalBytes > CLOUD_OMP_BOUNDARY_LIMITS.syncTotalBytes) {
			throw tooLarge("total_file_bytes_exceeded", "Workspace file bytes exceed limit");
		}
	}

	const files: FilePayload[] = [];
	for (const candidate of record.files) files.push(await validateFilePayload(candidate));
	validateManifestEntries(files);

	const computedRoot = await manifestRootSha256(files);
	if (computedRoot !== seedRootSha256) {
		throw invalid("seed_root_mismatch", "Workspace seed root digest does not match files");
	}
	return { auditCorrelationId, seedRootSha256, files };
}

export async function validateFilePayload(value: unknown): Promise<FilePayload> {
	const record = strictRecord(value, ["path", "sha256", "byteLength", "contentBase64"]);
	const payload: FilePayload = {
		path: requiredString(record.path, "path_invalid"),
		sha256: sha256String(record.sha256, "file_digest_invalid"),
		byteLength: nonNegativeSafeInteger(record.byteLength, "file_length_invalid"),
		contentBase64: requiredString(record.contentBase64, "file_content_invalid", true),
	};
	if (payload.byteLength > CLOUD_OMP_BOUNDARY_LIMITS.syncFileBytes) {
		throw tooLarge("file_too_large", "Workspace file exceeds size limit");
	}
	if (payload.contentBase64.length > MAX_SYNC_FILE_BASE64_BYTES) {
		throw tooLarge("file_too_large", "Workspace file exceeds size limit");
	}
	const { entry } = await validatePayload(payload);
	return { ...entry, contentBase64: payload.contentBase64 };
}

export function validateFileReadRequest(value: unknown): FileReadRequest {
	const record = strictRecord(value, ["path"]);
	const path = requiredString(record.path, "path_invalid");
	return { path: canonicalRelativePath(path) };
}

export function validateExecRequest(value: unknown): ExecRequest {
	const record = strictRecord(value, ["source", "cwd", "timeoutMs", "outputByteLimit"]);
	const source = requiredString(record.source, "command_invalid");
	const sourceBytes = strictUtf8Bytes(source, "command_invalid", "Command must be strict UTF-8");
	if (source.includes("\0")) throw invalid("command_invalid", "Command must not contain NUL");
	if (sourceBytes.byteLength > CLOUD_OMP_BOUNDARY_LIMITS.commandBytes) {
		throw tooLarge("command_too_large", "Command exceeds size limit");
	}
	const cwd = canonicalWorkspaceDirectory(requiredString(record.cwd, "cwd_invalid"));
	const timeoutMs = positiveSafeInteger(record.timeoutMs, "timeout_invalid");
	if (timeoutMs > CLOUD_OMP_BOUNDARY_LIMITS.commandTimeoutMs) {
		throw invalid("timeout_invalid", "Execution timeout is outside the allowed range");
	}
	const outputByteLimit = positiveSafeInteger(record.outputByteLimit, "output_limit_invalid");
	if (outputByteLimit > CLOUD_OMP_BOUNDARY_LIMITS.execOutputBytes) {
		throw invalid("output_limit_invalid", "Execution output limit is outside the allowed range");
	}
	return { source, cwd, timeoutMs, outputByteLimit };
}

export function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!isJsonObject(value)) {
		throw invalid("invalid_request", "Request body must be a JSON object");
	}
	if (!hasExactObjectKeys(value, keys)) {
		throw invalid("unknown_fields", "Request contains missing or unknown fields");
	}
	return value;
}

function requiredString(value: unknown, code: CloudOmpWireErrorCode, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw invalid(code, "Invalid string field");
	strictUtf8Bytes(value, code, "String field must be strict UTF-8");
	return value;
}

function sha256String(value: unknown, code: CloudOmpWireErrorCode): string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw invalid(code, "Invalid SHA-256 digest");
	return value;
}

function nonNegativeSafeInteger(value: unknown, code: CloudOmpWireErrorCode): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(code, "Invalid non-negative integer field");
	return value as number;
}

function positiveSafeInteger(value: unknown, code: CloudOmpWireErrorCode): number {
	const number = nonNegativeSafeInteger(value, code);
	if (number === 0) throw invalid(code, "Integer field must be positive");
	return number;
}

function strictUtf8Bytes(value: string, code: CloudOmpWireErrorCode, message: string): Uint8Array {
	const bytes = encoder.encode(value);
	if (fatalDecoder.decode(bytes) !== value) throw invalid(code, message);
	return bytes;
}

function invalid(code: CloudOmpWireErrorCode, message: string): RequestValidationError {
	return new RequestValidationError(400, code, message);
}

function tooLarge(code: CloudOmpWireErrorCode, message: string): RequestValidationError {
	return new RequestValidationError(413, code, message);
}

function workerProtocolFailure(error: unknown): never {
	if (!(error instanceof CloudflareRuntimeProtocolErrorV1)) throw error;
	const code: CloudOmpWireErrorCode =
		error.code === "unknown_fields"
			? "unknown_fields"
			: error.code === "request_conflict"
				? "request_conflict"
				: error.code === "request_digest_mismatch" || error.code === "deletion_request_digest_mismatch"
					? "request_digest_mismatch"
					: error.code === "push_generation_mismatch"
						? "checkpoint_generation_mismatch"
						: error.code === "retention_deadline_mismatch" || error.code === "deadline_invalid"
							? "retention_deadline_mismatch"
							: error.code === "deletion_authority_domain_mismatch"
								? "deletion_authority_domain_mismatch"
								: "protocol_invalid";
	throw new RequestValidationError(400, code, error.message);
}

async function assertWorkerRuntimeOperationV1(validation: CloudflareValidatedRuntimeOperationV1): Promise<void> {
	const tuple = projectCloudflareRuntimeInspectionTupleV1(validation.inspection);
	const digest = await canonicalRuntimeSha256V1(tuple);
	const tupleUtf8 = new TextDecoder().decode(encodeCanonicalRuntimeTupleV1(tuple));
	if (digest !== validation.requestSha256 || tupleUtf8 !== validation.canonicalTupleUtf8) {
		throw new CloudflareRuntimeProtocolErrorV1("request_digest_mismatch");
	}
}

async function validateWorkerRuntimeOperationV1(
	value: unknown,
	effect: boolean,
): Promise<CloudflareValidatedRuntimeOperationV1> {
	try {
		const validation = effect
			? await decodeCloudflareRuntimeEffectEnvelopeV1(value)
			: await decodeCloudflareRuntimeInspectionEnvelopeV1(value);
		await assertWorkerRuntimeOperationV1(validation);
		return validation;
	} catch (error) {
		return workerProtocolFailure(error);
	}
}

export function validateCloudflareRuntimeEffectEnvelopeV1(
	value: unknown,
): Promise<CloudflareValidatedRuntimeOperationV1> {
	return validateWorkerRuntimeOperationV1(value, true);
}

export function validateCloudflareRuntimeInspectionEnvelopeV1(
	value: unknown,
): Promise<CloudflareValidatedRuntimeOperationV1> {
	return validateWorkerRuntimeOperationV1(value, false);
}

export async function validateCloudflareRuntimeEffectTransportEnvelopeV1(
	value: unknown,
): Promise<CloudflareValidatedRuntimeEffectTransportV1> {
	try {
		const validation = await decodeCloudflareRuntimeEffectTransportEnvelopeV1(value);
		if (validation.transportFamily === "lifecycle") await assertWorkerRuntimeOperationV1(validation);
		return validation;
	} catch (error) {
		return workerProtocolFailure(error);
	}
}

export async function validateCloudflareRuntimeInspectionTransportEnvelopeV1(
	value: unknown,
): Promise<CloudflareValidatedRuntimeInspectionTransportV1> {
	try {
		const validation = await decodeCloudflareRuntimeInspectionTransportEnvelopeV1(value);
		if (validation.transportFamily === "lifecycle") await assertWorkerRuntimeOperationV1(validation);
		return validation;
	} catch (error) {
		return workerProtocolFailure(error);
	}
}

export async function validateCloudflareReplicaCacheEvictionPlanV1(
	value: unknown,
	options: { readonly workspaceRetentionMs?: number } = {},
): Promise<CloudflareReplicaCacheEvictionPlanV1> {
	try {
		return await decodeCloudflareReplicaCacheEvictionPlanV1(value, options);
	} catch (error) {
		return workerProtocolFailure(error);
	}
}

export async function validateCloudflareReplicaDeleteRequestV1(
	value: unknown,
	expectedDomain?: "persistent" | "transient_task",
): Promise<CloudflareReplicaDeletionValidationV1> {
	try {
		return await decodeCloudflareReplicaDeleteRequestV1(value, expectedDomain);
	} catch (error) {
		return workerProtocolFailure(error);
	}
}

export function validateCloudflareRuntimeStatusRequestV1(value: unknown): CloudflareRuntimeStatusRequestV1 {
	try {
		return decodeCloudflareRuntimeStatusRequestV1(value);
	} catch (error) {
		return workerProtocolFailure(error);
	}
}

export function validateCloudflareCheckpointFetchRequestV1(value: unknown): CloudflareCheckpointFetchRequestV1 {
	try {
		return decodeCloudflareCheckpointFetchRequestV1(value);
	} catch (error) {
		return workerProtocolFailure(error);
	}
}

export async function validateCloudflareDurableDeadlineV1(
	value: unknown,
	options: { readonly workspaceRetentionMs?: number } = {},
): Promise<CloudflareDurableDeadlineV1> {
	try {
		return await decodeCloudflareDurableDeadlineV1(value, options);
	} catch (error) {
		return workerProtocolFailure(error);
	}
}
