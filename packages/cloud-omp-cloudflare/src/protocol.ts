export {
	MAX_COMMAND_BYTES,
	MAX_COMMAND_TIMEOUT_MS,
	MAX_EXEC_OUTPUT_BYTES,
	MAX_HTTP_BODY_BYTES,
	MAX_SYNC_FILE_BYTES,
	MAX_SYNC_FILE_COUNT,
	MAX_SYNC_TOTAL_BYTES,
} from "./boundary-policy";

export const CLOUD_OMP_API_PREFIX = "/v1" as const;
export const CLOUD_OMP_REMOTE_ROOT = "/workspace" as const;

export const CLOUD_OMP_WORKSPACE_TTL_MS = 30 * 60 * 1_000;

export interface BoundaryManifestEntry {
	path: string;
	sha256: string;
	byteLength: number;
}

export type FilePayload = BoundaryManifestEntry & { contentBase64: string };

export interface CreateWorkspaceRequest {
	auditCorrelationId: string;
	seedRootSha256: string;
	files: FilePayload[];
}

export interface CreateWorkspaceResponse {
	workspaceId: string;
	remoteRoot: typeof CLOUD_OMP_REMOTE_ROOT;
	expiresAt: string;
}

export interface FileReadRequest {
	path: string;
}

export interface ExecRequest {
	source: string;
	cwd: string;
	timeoutMs: number;
	outputByteLimit: number;
}

export type WorkspacePhase = "active" | "quiescing" | "quiesced" | "released";

export interface WorkspaceState {
	phase: WorkspacePhase;
	activeExecutions: number;
	pendingSyncs: number;
	exhaustedSyncs: number;
}

export interface ExecCreateResponse {
	execId: string;
}

export interface ManifestResponse {
	phase: WorkspacePhase;
	rootSha256: string;
	files: BoundaryManifestEntry[];
}

export type ExecStatus = "starting" | "running" | "completed" | "failed" | "cancelled";
export type ExecSyncStatus = "pending" | "complete" | "exhausted";

export interface ExecSnapshot {
	execId: string;
	status: ExecStatus;
	output: string;
	truncated: boolean;
	sync: ExecSyncStatus;
	exitCode?: number | null;
	signal?: string | null;
}

export interface HealthResponse {
	ok: true;
}

/** Every error code that can cross the Cloud OMP gateway/Worker boundary. */
export const CLOUD_OMP_WIRE_ERROR_CODES = Object.freeze({
	unauthorized: true,
	query_not_allowed: true,
	content_length_invalid: true,
	request_too_large: true,
	content_type_invalid: true,
	json_invalid: true,
	body_not_allowed: true,
	method_not_allowed: true,
	not_found: true,
	internal_error: true,
	workspace_id_invalid: true,
	execution_id_invalid: true,
	audit_correlation_id_invalid: true,
	seed_root_invalid: true,
	files_invalid: true,
	file_count_exceeded: true,
	file_length_invalid: true,
	file_too_large: true,
	total_file_bytes_exceeded: true,
	seed_root_mismatch: true,
	path_invalid: true,
	file_digest_invalid: true,
	file_content_invalid: true,
	command_invalid: true,
	command_too_large: true,
	cwd_invalid: true,
	timeout_invalid: true,
	output_limit_invalid: true,
	invalid_request: true,
	unknown_fields: true,
	invalid_path: true,
	denied_path: true,
	invalid_cwd: true,
	invalid_base64: true,
	invalid_file_size: true,
	invalid_digest: true,
	file_digest_mismatch: true,
	invalid_utf8: true,
	invalid_manifest_order: true,
	invalid_manifest_entry: true,
	destination_collision: true,
	unsafe_path: true,
	file_not_found: true,
	unsupported_file: true,
	unsupported_entry: true,
	too_many_files: true,
	workspace_too_large: true,
	cleanup_timeout: true,
	invalid_workspace_id: true,
	invalid_seed: true,
	seed_too_large: true,
	seed_digest_mismatch: true,
	workspace_gone: true,
	workspace_seed_conflict: true,
	seed_verify_failed: true,
	workspace_state_lost: true,
	invalid_command: true,
	invalid_timeout: true,
	invalid_output_limit: true,
	invalid_generated_id: true,
	invalid_workspace_phase: true,
	execution_active: true,
	execution_start_failed: true,
	execution_identity_mismatch: true,
	quiesce_incomplete: true,
	restart_superseded: true,
	invalid_execution_id: true,
	execution_not_found: true,
	workspace_not_found: true,
	workspace_initializing: true,
	sync_unsettled: true,
	container_restart_failed: true,
	workspace_busy: true,
	execution_failed: true,
} as const);

export type CloudOmpWireErrorCode = keyof typeof CLOUD_OMP_WIRE_ERROR_CODES;

export function isCloudOmpWireErrorCode(value: unknown): value is CloudOmpWireErrorCode {
	return typeof value === "string" && Object.hasOwn(CLOUD_OMP_WIRE_ERROR_CODES, value);
}

export interface WireErrorResponse {
	error: {
		code: CloudOmpWireErrorCode;
		message: string;
	};
}

const WIRE_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isWireId(value: unknown): value is string {
	return typeof value === "string" && WIRE_ID_PATTERN.test(value);
}

/** Canonical guard for untrusted JSON object envelopes in this package. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireWireId(value: string): void {
	if (!isWireId(value)) {
		throw new TypeError("Cloud OMP identifier must be 32 lowercase hexadecimal characters");
	}
}

export const cloudOmpRoutes = Object.freeze({
	health: `${CLOUD_OMP_API_PREFIX}/health` as const,
	workspace(clientWorkspaceId: string): string {
		requireWireId(clientWorkspaceId);
		return `${CLOUD_OMP_API_PREFIX}/workspaces/${clientWorkspaceId}`;
	},
	fileRead(workspaceId: string): string {
		requireWireId(workspaceId);
		return `${CLOUD_OMP_API_PREFIX}/workspaces/${workspaceId}/files/read`;
	},
	files(workspaceId: string): string {
		requireWireId(workspaceId);
		return `${CLOUD_OMP_API_PREFIX}/workspaces/${workspaceId}/files`;
	},
	manifest(workspaceId: string): string {
		requireWireId(workspaceId);
		return `${CLOUD_OMP_API_PREFIX}/workspaces/${workspaceId}/manifest`;
	},
	exec(workspaceId: string): string {
		requireWireId(workspaceId);
		return `${CLOUD_OMP_API_PREFIX}/workspaces/${workspaceId}/exec`;
	},
	execSnapshot(workspaceId: string, execId: string): string {
		requireWireId(workspaceId);
		requireWireId(execId);
		return `${CLOUD_OMP_API_PREFIX}/workspaces/${workspaceId}/exec/${execId}`;
	},
	execKill(workspaceId: string, execId: string): string {
		requireWireId(workspaceId);
		requireWireId(execId);
		return `${CLOUD_OMP_API_PREFIX}/workspaces/${workspaceId}/exec/${execId}/kill`;
	},
	quiesce(workspaceId: string): string {
		requireWireId(workspaceId);
		return `${CLOUD_OMP_API_PREFIX}/workspaces/${workspaceId}/quiesce`;
	},
	adminRestart(workspaceId: string): string {
		requireWireId(workspaceId);
		return `${CLOUD_OMP_API_PREFIX}/admin/workspaces/${workspaceId}/restart`;
	},
});
