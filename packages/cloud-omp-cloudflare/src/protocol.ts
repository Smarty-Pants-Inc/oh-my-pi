import type {
	WorkspaceCheckpoint,
	WorkspaceDeletionPlanCoreV1,
	WorkspaceDeletionPlanV1,
} from "@oh-my-pi/pi-coding-agent/registry/persistent-agent-contracts";
import {
	type CanonicalRuntimeValue as CanonicalRuntimeValueV1,
	canonicalRuntimeSha256 as canonicalRuntimeSha256V1,
	deriveProviderSubrequestId as deriveCloudflareProviderSubrequestIdV1,
	encodeCanonicalRuntimeTupleV1,
} from "@oh-my-pi/pi-coding-agent/session/canonical-runtime";
import type {
	CanonicalWorkspaceCommitReceipt,
	CloudflareDurableDeadlineKind,
	FrozenReplicaCheckpointLocator,
	FrozenReplicaCheckpointRef,
	PersistentModelWorkspacePath,
	ReplicaCheckpoint,
	RuntimeAccessContext,
	RuntimeAcquireInspectRequest,
	RuntimeAcquireInspectResult,
	RuntimeAcquireRequest,
	RuntimeAcquireResult,
	RuntimeCanonicalProviderInspectionV1,
	RuntimeCanonicalProviderOperationV1,
	RuntimeCheckpointAcknowledgeInspectRequest,
	RuntimeCheckpointAcknowledgeInspectResult,
	RuntimeCheckpointAcknowledgeRequest,
	RuntimeCheckpointAcknowledgeResult,
	RuntimeCheckpointFetchResult,
	RuntimeCheckpointInspectRequest,
	RuntimeCheckpointRequest,
	RuntimeCheckpointResult,
	RuntimeCommandInspectResult,
	RuntimeCommandLocator,
	RuntimeCommandRequest,
	RuntimeCommandSnapshot,
	RuntimeCommandStartReconcileResult,
	RuntimeFence,
	RuntimeFileStat,
	RuntimeFrozenCheckpointInspectResult,
	RuntimeInspectResult,
	RuntimeLeaseRef,
	RuntimeLeaseReleaseInspectRequest,
	RuntimeLeaseReleaseInspectResult,
	RuntimeLeaseReleaseRequest,
	RuntimeLeaseReleaseResult,
	RuntimeLeaseRenewalPlan,
	RuntimeLeaseRenewalReceipt,
	RuntimeLeaseRenewInspectResult,
	RuntimeLeaseRenewRequest,
	RuntimeListRequest,
	RuntimeListResult,
	RuntimeMutationContext,
	RuntimePushInspectRequest,
	RuntimePushInspectResult,
	RuntimePushRequest,
	RuntimePushResult,
	RuntimeQuiesceInspectRequest,
	RuntimeQuiesceInspectResult,
	RuntimeQuiesceRequest,
	RuntimeQuiesceResult,
	RuntimeReadBinaryRequest,
	RuntimeReadBinaryResult,
	RuntimeReadTextRequest,
	RuntimeReadTextResult,
	RuntimeRecoveryFreezeInspectResult,
	RuntimeRecoveryFreezePlan,
	RuntimeRecoveryFreezeRequest,
	RuntimeRecoveryFreezeResult,
	RuntimeReplicaCacheEvictionAcceptance,
	RuntimeReplicaCacheEvictionInspectResult,
	RuntimeReplicaCacheEvictionPlan,
	RuntimeReplicaCacheEvictionRequestResult,
	RuntimeReplicaDeleteInspectResult,
	RuntimeReplicaDeleteRequest,
	RuntimeReplicaDeleteResult,
	RuntimeReplicaDeletionAuthorizationV1,
	RuntimeReplicaRef,
	RuntimeRevokeInspectRequest,
	RuntimeRevokeInspectResult,
	RuntimeRevokeRequest,
	RuntimeRevokeResult,
	RuntimeSearchRequest,
	RuntimeSearchResult,
	RuntimeWriteResult,
	RuntimeWriteTextRequest,
	WorkspaceImage,
	WorkspaceSnapshot,
	WorkspaceTombstone,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import {
	classifyCanonicalRelativePath,
	compareUtf8,
	hasExactObjectKeys,
	MAX_COMMAND_BYTES,
	MAX_COMMAND_TIMEOUT_MS,
	MAX_EXEC_OUTPUT_BYTES,
	MAX_SYNC_FILE_BYTES,
} from "./boundary-policy";

export {
	MAX_COMMAND_BYTES,
	MAX_COMMAND_TIMEOUT_MS,
	MAX_EXEC_OUTPUT_BYTES,
	MAX_HTTP_BODY_BYTES,
	MAX_SYNC_FILE_BYTES,
	MAX_SYNC_FILE_COUNT,
	MAX_SYNC_TOTAL_BYTES,
} from "./boundary-policy";
export type { CanonicalRuntimeValueV1 };
export { canonicalRuntimeSha256V1, deriveCloudflareProviderSubrequestIdV1, encodeCanonicalRuntimeTupleV1 };

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
	protocol_invalid: true,
	request_digest_mismatch: true,
	request_conflict: true,
	checkpoint_generation_mismatch: true,
	retention_deadline_mismatch: true,
	deletion_authority_domain_mismatch: true,
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

export const cloudflareRuntimeRoutesV1 = Object.freeze({
	effect: `${CLOUD_OMP_API_PREFIX}/runtime/effect`,
	inspect: `${CLOUD_OMP_API_PREFIX}/runtime/inspect`,
	status: `${CLOUD_OMP_API_PREFIX}/runtime/status`,
	checkpointFetch: `${CLOUD_OMP_API_PREFIX}/runtime/checkpoint/fetch`,
	cacheEviction: `${CLOUD_OMP_API_PREFIX}/runtime/cache-eviction`,
	cacheEvictionInspect: `${CLOUD_OMP_API_PREFIX}/runtime/cache-eviction/inspect`,
	replicaDelete: `${CLOUD_OMP_API_PREFIX}/runtime/replica-delete`,
	replicaDeleteInspect: `${CLOUD_OMP_API_PREFIX}/runtime/replica-delete/inspect`,
} as const);

export const CLOUDFLARE_RUNTIME_PROTOCOL_ERROR_CODES_V1 = Object.freeze({
	invalid_shape: true,
	unknown_fields: true,
	invalid_schema_version: true,
	invalid_operation: true,
	invalid_identity: true,
	invalid_digest: true,
	invalid_timestamp: true,
	invalid_integer: true,
	request_digest_mismatch: true,
	request_conflict: true,
	request_identity_mismatch: true,
	push_generation_mismatch: true,
	checkpoint_mismatch: true,
	retention_deadline_mismatch: true,
	deletion_authority_domain_mismatch: true,
	deletion_plan_core_digest_mismatch: true,
	deletion_request_digest_mismatch: true,
	deletion_plan_digest_mismatch: true,
	tombstone_mismatch: true,
	deadline_invalid: true,
	provider_response_invalid: true,
} as const);

export type CloudflareRuntimeProtocolErrorCodeV1 = keyof typeof CLOUDFLARE_RUNTIME_PROTOCOL_ERROR_CODES_V1;

const CLOUDFLARE_RUNTIME_PROTOCOL_MESSAGES_V1: Readonly<Record<CloudflareRuntimeProtocolErrorCodeV1, string>> =
	Object.freeze({
		invalid_shape: "Cloudflare runtime protocol value has an invalid shape",
		unknown_fields: "Cloudflare runtime protocol value has missing or unknown fields",
		invalid_schema_version: "Cloudflare runtime protocol schema version is invalid",
		invalid_operation: "Cloudflare runtime protocol operation is invalid",
		invalid_identity: "Cloudflare runtime protocol identity is invalid",
		invalid_digest: "Cloudflare runtime protocol digest is invalid",
		invalid_timestamp: "Cloudflare runtime protocol timestamp is invalid",
		invalid_integer: "Cloudflare runtime protocol integer is invalid",
		request_digest_mismatch: "Cloudflare runtime request digest does not match its typed fields",
		request_conflict: "The Cloudflare runtime request identity conflicts with an existing reservation",
		request_identity_mismatch: "Cloudflare runtime request identity does not match its typed fields",
		push_generation_mismatch: "Cloudflare runtime push generation does not match the lease",
		checkpoint_mismatch: "Cloudflare runtime checkpoint fields do not match",
		retention_deadline_mismatch: "Cloudflare runtime retention deadline does not match its frozen plan",
		deletion_authority_domain_mismatch: "Cloudflare runtime deletion authority domain does not match the replica",
		deletion_plan_core_digest_mismatch: "Cloudflare runtime deletion-plan core digest does not match",
		deletion_request_digest_mismatch: "Cloudflare runtime replica-deletion request digest does not match",
		deletion_plan_digest_mismatch: "Cloudflare runtime deletion-plan digest does not match",
		tombstone_mismatch: "Cloudflare runtime tombstone does not match the deletion plan",
		deadline_invalid: "Cloudflare runtime durable deadline is invalid",
		provider_response_invalid: "Cloudflare runtime provider response is invalid",
	});

export class CloudflareRuntimeProtocolErrorV1 extends Error {
	readonly code: CloudflareRuntimeProtocolErrorCodeV1;

	constructor(code: CloudflareRuntimeProtocolErrorCodeV1) {
		super(CLOUDFLARE_RUNTIME_PROTOCOL_MESSAGES_V1[code]);
		this.name = "CloudflareRuntimeProtocolErrorV1";
		this.code = code;
	}
}

export type CloudflareRuntimeEffectEnvelopeV1 =
	| {
			readonly schemaVersion: 1;
			readonly operation: "acquire";
			readonly request: Omit<RuntimeAcquireRequest, "signal">;
	  }
	| { readonly schemaVersion: 1; readonly operation: "push"; readonly request: Omit<RuntimePushRequest, "signal"> }
	| {
			readonly schemaVersion: 1;
			readonly operation: "quiesce";
			readonly request: Omit<RuntimeQuiesceRequest, "signal">;
	  }
	| {
			readonly schemaVersion: 1;
			readonly operation: "checkpoint";
			readonly request: Omit<RuntimeCheckpointRequest, "signal">;
	  }
	| { readonly schemaVersion: 1; readonly operation: "revoke"; readonly request: Omit<RuntimeRevokeRequest, "signal"> }
	| {
			readonly schemaVersion: 1;
			readonly operation: "checkpoint_acknowledgement";
			readonly request: Omit<RuntimeCheckpointAcknowledgeRequest, "signal">;
	  }
	| {
			readonly schemaVersion: 1;
			readonly operation: "release";
			readonly request: Omit<RuntimeLeaseReleaseRequest, "signal">;
	  };

export type CloudflareRuntimeInspectionEnvelopeV1 =
	| { readonly schemaVersion: 1; readonly operation: "acquire"; readonly request: RuntimeAcquireInspectRequest }
	| { readonly schemaVersion: 1; readonly operation: "push"; readonly request: RuntimePushInspectRequest }
	| { readonly schemaVersion: 1; readonly operation: "quiesce"; readonly request: RuntimeQuiesceInspectRequest }
	| { readonly schemaVersion: 1; readonly operation: "checkpoint"; readonly request: RuntimeCheckpointInspectRequest }
	| { readonly schemaVersion: 1; readonly operation: "revoke"; readonly request: RuntimeRevokeInspectRequest }
	| {
			readonly schemaVersion: 1;
			readonly operation: "checkpoint_acknowledgement";
			readonly request: RuntimeCheckpointAcknowledgeInspectRequest;
	  }
	| { readonly schemaVersion: 1; readonly operation: "release"; readonly request: RuntimeLeaseReleaseInspectRequest };

export interface CloudflareValidatedRuntimeOperationV1 {
	readonly operation: RuntimeCanonicalProviderOperationV1;
	readonly requestId: string;
	readonly requestSha256: string;
	readonly canonicalTupleUtf8: string;
	readonly inspection: RuntimeCanonicalProviderInspectionV1;
	readonly envelope: CloudflareRuntimeEffectEnvelopeV1 | CloudflareRuntimeInspectionEnvelopeV1;
}

type CloudflareSupplementalTransportEnvelopeV1<
	Family extends "control" | "bridge",
	Operation extends string,
	Request,
> = {
	readonly schemaVersion: 1;
	readonly family: Family;
	readonly operation: Operation;
	readonly replica: RuntimeReplicaRef;
	readonly request: Request;
};

type CloudflareSupplementalTransportResultEnvelopeV1<
	Family extends "control" | "bridge",
	Operation extends string,
	Result,
> = {
	readonly schemaVersion: 1;
	readonly family: Family;
	readonly operation: Operation;
	readonly replica: RuntimeReplicaRef;
	readonly result: Result;
};

type CloudflareRuntimeBridgePathRequestV1 = RuntimeAccessContext & {
	readonly path: PersistentModelWorkspacePath;
};
type CloudflareRuntimeBridgeMkdirRequestV1 = RuntimeMutationContext & {
	readonly path: PersistentModelWorkspacePath;
	readonly recursive: boolean;
};
type CloudflareRuntimeBridgeRenameRequestV1 = RuntimeMutationContext & {
	readonly from: PersistentModelWorkspacePath;
	readonly to: PersistentModelWorkspacePath;
};
type CloudflareRuntimeBridgeInspectCommandRequestV1 = RuntimeAccessContext & { readonly commandId: string };
type CloudflareRuntimeBridgeCancelCommandRequestV1 = RuntimeMutationContext & {
	readonly commandId: string;
	readonly signal: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
};
type CloudflareRuntimeBridgeDisposeCommandRequestV1 = RuntimeMutationContext & { readonly commandId: string };

type CloudflareRuntimeControlEffectEnvelopeV1 =
	| CloudflareSupplementalTransportEnvelopeV1<"control", "renew", Omit<RuntimeLeaseRenewRequest, "signal">>
	| CloudflareSupplementalTransportEnvelopeV1<
			"control",
			"recovery_freeze",
			Omit<RuntimeRecoveryFreezeRequest, "signal">
	  >
	| CloudflareSupplementalTransportEnvelopeV1<"control", "command_start_reconcile", RuntimeCommandLocator>;

type CloudflareRuntimeControlInspectionEnvelopeV1 =
	| CloudflareSupplementalTransportEnvelopeV1<"control", "renew", RuntimeLeaseRenewalPlan>
	| CloudflareSupplementalTransportEnvelopeV1<
			"control",
			"recovery_freeze",
			Omit<RuntimeRecoveryFreezeRequest, "signal">
	  >
	| CloudflareSupplementalTransportEnvelopeV1<"control", "command", RuntimeCommandLocator>;

type CloudflareRuntimeBridgeEffectEnvelopeV1 =
	| CloudflareSupplementalTransportEnvelopeV1<"bridge", "write_text_file", RuntimeWriteTextRequest>
	| CloudflareSupplementalTransportEnvelopeV1<"bridge", "mkdir", CloudflareRuntimeBridgeMkdirRequestV1>
	| CloudflareSupplementalTransportEnvelopeV1<"bridge", "remove", CloudflareRuntimeBridgeMkdirRequestV1>
	| CloudflareSupplementalTransportEnvelopeV1<"bridge", "rename", CloudflareRuntimeBridgeRenameRequestV1>
	| CloudflareSupplementalTransportEnvelopeV1<"bridge", "submit_command", RuntimeCommandRequest>
	| CloudflareSupplementalTransportEnvelopeV1<
			"bridge",
			"cancel_command",
			CloudflareRuntimeBridgeCancelCommandRequestV1
	  >
	| CloudflareSupplementalTransportEnvelopeV1<
			"bridge",
			"dispose_command",
			CloudflareRuntimeBridgeDisposeCommandRequestV1
	  >;

type CloudflareRuntimeBridgeInspectionEnvelopeV1 =
	| CloudflareSupplementalTransportEnvelopeV1<"bridge", "read_text_file", RuntimeReadTextRequest>
	| CloudflareSupplementalTransportEnvelopeV1<"bridge", "read_binary_file", RuntimeReadBinaryRequest>
	| CloudflareSupplementalTransportEnvelopeV1<"bridge", "exists", CloudflareRuntimeBridgePathRequestV1>
	| CloudflareSupplementalTransportEnvelopeV1<"bridge", "stat", CloudflareRuntimeBridgePathRequestV1>
	| CloudflareSupplementalTransportEnvelopeV1<"bridge", "list_files", RuntimeListRequest>
	| CloudflareSupplementalTransportEnvelopeV1<"bridge", "search_text", RuntimeSearchRequest>
	| CloudflareSupplementalTransportEnvelopeV1<
			"bridge",
			"inspect_command",
			CloudflareRuntimeBridgeInspectCommandRequestV1
	  >;

export type CloudflareRuntimeEffectTransportEnvelopeV1 =
	| CloudflareRuntimeEffectEnvelopeV1
	| CloudflareRuntimeControlEffectEnvelopeV1
	| CloudflareRuntimeBridgeEffectEnvelopeV1;

export type CloudflareRuntimeInspectionTransportEnvelopeV1 =
	| CloudflareRuntimeInspectionEnvelopeV1
	| CloudflareRuntimeControlInspectionEnvelopeV1
	| CloudflareRuntimeBridgeInspectionEnvelopeV1;

type CloudflareRuntimeControlEffectResultEnvelopeV1 =
	| CloudflareSupplementalTransportResultEnvelopeV1<"control", "renew", RuntimeLeaseRenewalReceipt>
	| CloudflareSupplementalTransportResultEnvelopeV1<"control", "recovery_freeze", RuntimeRecoveryFreezeResult>
	| CloudflareSupplementalTransportResultEnvelopeV1<
			"control",
			"command_start_reconcile",
			RuntimeCommandStartReconcileResult
	  >;

type CloudflareRuntimeControlInspectionResultEnvelopeV1 =
	| CloudflareSupplementalTransportResultEnvelopeV1<"control", "renew", RuntimeLeaseRenewInspectResult>
	| CloudflareSupplementalTransportResultEnvelopeV1<"control", "recovery_freeze", RuntimeRecoveryFreezeInspectResult>
	| CloudflareSupplementalTransportResultEnvelopeV1<"control", "command", RuntimeCommandInspectResult>;

type CloudflareRuntimeBridgeEffectResultEnvelopeV1 =
	| CloudflareSupplementalTransportResultEnvelopeV1<"bridge", "write_text_file", RuntimeWriteResult>
	| CloudflareSupplementalTransportResultEnvelopeV1<
			"bridge",
			"mkdir",
			{ readonly status: "created" | "already_exists" }
	  >
	| CloudflareSupplementalTransportResultEnvelopeV1<
			"bridge",
			"remove",
			{ readonly status: "removed" | "already_absent" }
	  >
	| CloudflareSupplementalTransportResultEnvelopeV1<
			"bridge",
			"rename",
			{ readonly status: "renamed" | "already_renamed" }
	  >
	| CloudflareSupplementalTransportResultEnvelopeV1<"bridge", "submit_command", RuntimeCommandSnapshot>
	| CloudflareSupplementalTransportResultEnvelopeV1<"bridge", "cancel_command", RuntimeCommandSnapshot>
	| CloudflareSupplementalTransportResultEnvelopeV1<
			"bridge",
			"dispose_command",
			{ readonly status: "disposed" | "already_disposed"; readonly commandId: string }
	  >;

type CloudflareRuntimeBridgeInspectionResultEnvelopeV1 =
	| CloudflareSupplementalTransportResultEnvelopeV1<"bridge", "read_text_file", RuntimeReadTextResult>
	| CloudflareSupplementalTransportResultEnvelopeV1<"bridge", "read_binary_file", RuntimeReadBinaryResult>
	| CloudflareSupplementalTransportResultEnvelopeV1<"bridge", "exists", boolean>
	| CloudflareSupplementalTransportResultEnvelopeV1<"bridge", "stat", RuntimeFileStat>
	| CloudflareSupplementalTransportResultEnvelopeV1<"bridge", "list_files", RuntimeListResult>
	| CloudflareSupplementalTransportResultEnvelopeV1<"bridge", "search_text", RuntimeSearchResult>
	| CloudflareSupplementalTransportResultEnvelopeV1<"bridge", "inspect_command", RuntimeCommandInspectResult>;

export type CloudflareRuntimeEffectTransportResultEnvelopeV1 =
	| CloudflareRuntimeEffectResultEnvelopeV1
	| CloudflareRuntimeControlEffectResultEnvelopeV1
	| CloudflareRuntimeBridgeEffectResultEnvelopeV1;

export type CloudflareRuntimeInspectionTransportResultEnvelopeV1 =
	| CloudflareRuntimeInspectionResultEnvelopeV1
	| CloudflareRuntimeControlInspectionResultEnvelopeV1
	| CloudflareRuntimeBridgeInspectionResultEnvelopeV1;

type CloudflareValidatedRuntimeControlEffectTransportV1 =
	| (Extract<CloudflareRuntimeControlEffectEnvelopeV1, { readonly operation: "renew" }> & {
			readonly transportFamily: "control";
			readonly canonicalTupleUtf8: string;
	  })
	| (Extract<CloudflareRuntimeControlEffectEnvelopeV1, { readonly operation: "recovery_freeze" }> & {
			readonly transportFamily: "control";
			readonly canonicalTupleUtf8: string;
	  })
	| (Extract<CloudflareRuntimeControlEffectEnvelopeV1, { readonly operation: "command_start_reconcile" }> & {
			readonly transportFamily: "control";
	  });

type CloudflareValidatedRuntimeControlInspectionTransportV1 =
	| (Extract<CloudflareRuntimeControlInspectionEnvelopeV1, { readonly operation: "renew" }> & {
			readonly transportFamily: "control";
			readonly canonicalTupleUtf8: string;
	  })
	| (Extract<CloudflareRuntimeControlInspectionEnvelopeV1, { readonly operation: "recovery_freeze" }> & {
			readonly transportFamily: "control";
			readonly canonicalTupleUtf8: string;
	  })
	| (Extract<CloudflareRuntimeControlInspectionEnvelopeV1, { readonly operation: "command" }> & {
			readonly transportFamily: "control";
	  });

export type CloudflareValidatedRuntimeEffectTransportV1 =
	| (CloudflareValidatedRuntimeOperationV1 & {
			readonly transportFamily: "lifecycle";
			readonly envelope: CloudflareRuntimeEffectEnvelopeV1;
	  })
	| CloudflareValidatedRuntimeControlEffectTransportV1
	| (CloudflareRuntimeBridgeEffectEnvelopeV1 & { readonly transportFamily: "bridge" });

export type CloudflareValidatedRuntimeInspectionTransportV1 =
	| (CloudflareValidatedRuntimeOperationV1 & {
			readonly transportFamily: "lifecycle";
			readonly envelope: CloudflareRuntimeInspectionEnvelopeV1;
	  })
	| CloudflareValidatedRuntimeControlInspectionTransportV1
	| (CloudflareRuntimeBridgeInspectionEnvelopeV1 & { readonly transportFamily: "bridge" });

type StrictJsonValueV1 =
	| null
	| boolean
	| string
	| number
	| readonly StrictJsonValueV1[]
	| { readonly [key: string]: StrictJsonValueV1 };

const SHA256_HEX_V1 = /^[0-9a-f]{64}$/;
const SHA256_REF_V1 = /^sha256:[0-9a-f]{64}$/;
const ISO8601_V1 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const strictProtocolEncoderV1 = new TextEncoder();
const strictProtocolCursorDecoderV1 = new TextDecoder("utf-8", { fatal: true });
const MAX_RUNTIME_SEARCH_PATTERN_BYTES_V1 = 4_096;
const RUNTIME_SEARCH_FLAGS_V1 = /^[gims]*$/;
const RUNTIME_SEARCH_CURSOR_VERSION_V1 = "omp-cloudflare-search-cursor-v1";
export const CLOUDFLARE_RUNTIME_SEARCH_CURSOR_MAX_CHARS_V1 = 8_192;
export const CLOUDFLARE_RUNTIME_SEARCH_FILE_BUDGET_V1 = 64;
export const CLOUDFLARE_RUNTIME_SEARCH_BYTE_BUDGET_V1 = 1_048_576;
export const CLOUDFLARE_RUNTIME_SEARCH_TRAVERSAL_BUDGET_V1 = 8_192;
// Covers worst-case JSON escaping for one maximum-size line plus the largest opaque cursor.
export const CLOUDFLARE_RUNTIME_SEARCH_RESULT_BYTE_BUDGET_V1 = 2_097_152;

export interface CloudflareRuntimeSearchCursorPositionV1 {
	readonly path: PersistentModelWorkspacePath;
	readonly codeUnitOffset: number;
}

function isBoundedRuntimeSearchPatternV1(pattern: string): boolean {
	let escaped = false;
	let characterClass = false;
	for (const character of pattern) {
		if (escaped) {
			if (!characterClass && (character === "k" || (character >= "1" && character <= "9"))) return false;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (characterClass) {
			if (character === "]") characterClass = false;
			continue;
		}
		if (character === "[") {
			characterClass = true;
			continue;
		}
		// The Worker runtime only provides a backtracking RegExp engine. Fixed-width
		// branches preserve regex semantics without admitting catastrophic patterns.
		if ("()*+?{}".includes(character)) return false;
	}
	return true;
}

async function cloudflareRuntimeSearchQuerySha256V1(request: RuntimeSearchRequest): Promise<string> {
	const tuple = [
		"omp-cloudflare-search-query-v1",
		request.operationLeaseId,
		request.workspaceId,
		request.expectedGeneration,
		request.replicaId,
		request.leaseId,
		request.fence.fenceId,
		request.path,
		request.pattern,
		request.flags,
	] as const;
	return canonicalRuntimeSha256V1(tuple);
}

function encodeCanonicalBase64BytesV1(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + 0x8000)));
	}
	return btoa(binary);
}

export function runtimeSearchCursorPathFitsV1(path: PersistentModelWorkspacePath): boolean {
	const bytes = strictProtocolEncoderV1.encode(
		JSON.stringify([RUNTIME_SEARCH_CURSOR_VERSION_V1, "0".repeat(64), path, 0]),
	).byteLength;
	return Math.ceil(bytes / 3) * 4 <= CLOUDFLARE_RUNTIME_SEARCH_CURSOR_MAX_CHARS_V1;
}

export async function encodeCloudflareRuntimeSearchCursorV1(
	request: RuntimeSearchRequest,
	position: CloudflareRuntimeSearchCursorPositionV1,
): Promise<string> {
	const path = requiredRuntimePathV1(position.path, true);
	const codeUnitOffset = requiredIntegerWithinV1(position.codeUnitOffset, 0, MAX_SYNC_FILE_BYTES);
	if (path !== request.path && !path.startsWith(`${request.path}/`)) protocolFailure("invalid_shape");
	const tuple = [
		RUNTIME_SEARCH_CURSOR_VERSION_V1,
		await cloudflareRuntimeSearchQuerySha256V1(request),
		path,
		codeUnitOffset,
	] as const;
	const cursor = encodeCanonicalBase64BytesV1(strictProtocolEncoderV1.encode(JSON.stringify(tuple)));
	if (cursor.length > CLOUDFLARE_RUNTIME_SEARCH_CURSOR_MAX_CHARS_V1) protocolFailure("invalid_shape");
	return cursor;
}

export async function decodeCloudflareRuntimeSearchCursorV1(
	cursor: string | null,
	request: RuntimeSearchRequest,
): Promise<CloudflareRuntimeSearchCursorPositionV1 | null> {
	if (cursor === null) return null;
	if (cursor.length > CLOUDFLARE_RUNTIME_SEARCH_CURSOR_MAX_CHARS_V1) protocolFailure("invalid_shape");
	try {
		const json = strictProtocolCursorDecoderV1.decode(decodeCanonicalBase64V1(cursor));
		const parsed: unknown = JSON.parse(json);
		if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== RUNTIME_SEARCH_CURSOR_VERSION_V1) {
			protocolFailure("invalid_shape");
		}
		const querySha256 = requiredSha256V1(parsed[1] as StrictJsonValueV1);
		const path = requiredRuntimePathV1(parsed[2] as StrictJsonValueV1, true);
		const codeUnitOffset = requiredIntegerWithinV1(parsed[3] as StrictJsonValueV1, 0, MAX_SYNC_FILE_BYTES);
		if (
			querySha256 !== (await cloudflareRuntimeSearchQuerySha256V1(request)) ||
			(path !== request.path && !path.startsWith(`${request.path}/`)) ||
			json !== JSON.stringify([RUNTIME_SEARCH_CURSOR_VERSION_V1, querySha256, path, codeUnitOffset])
		) {
			protocolFailure("invalid_shape");
		}
		return { path, codeUnitOffset };
	} catch (error) {
		if (error instanceof CloudflareRuntimeProtocolErrorV1) throw error;
		protocolFailure("invalid_shape");
	}
}

function protocolFailure(code: CloudflareRuntimeProtocolErrorCodeV1): never {
	throw new CloudflareRuntimeProtocolErrorV1(code);
}

function isWellFormedUnicodeV1(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function strictJsonSnapshotV1(value: unknown, ancestors: ReadonlySet<object> = new Set()): StrictJsonValueV1 {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (!isWellFormedUnicodeV1(value)) protocolFailure("invalid_shape");
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || Object.is(value, -0)) protocolFailure("invalid_integer");
		return value;
	}
	if (typeof value !== "object") protocolFailure("invalid_shape");
	if (ancestors.has(value)) protocolFailure("invalid_shape");
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(value);
	try {
		if (Array.isArray(value)) {
			const ownKeys = Reflect.ownKeys(value);
			if (
				ownKeys.length !== value.length + 1 ||
				!ownKeys.every((key, index) => key === (index < value.length ? String(index) : "length"))
			) {
				protocolFailure("invalid_shape");
			}
			const descriptors = Object.getOwnPropertyDescriptors(value);
			const snapshot: StrictJsonValueV1[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = descriptors[String(index)];
				if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
					protocolFailure("invalid_shape");
				}
				snapshot.push(strictJsonSnapshotV1(descriptor.value, nextAncestors));
			}
			return snapshot;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) protocolFailure("invalid_shape");
		const ownKeys = Reflect.ownKeys(value);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const snapshot: Record<string, StrictJsonValueV1> = Object.create(null);
		for (const key of ownKeys) {
			if (typeof key !== "string" || !isWellFormedUnicodeV1(key)) protocolFailure("invalid_shape");
			const descriptor = descriptors[key];
			if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
				protocolFailure("invalid_shape");
			}
			snapshot[key] = strictJsonSnapshotV1(descriptor.value, nextAncestors);
		}
		return snapshot;
	} catch (error) {
		if (error instanceof CloudflareRuntimeProtocolErrorV1) throw error;
		return protocolFailure("invalid_shape");
	}
}

function strictProtocolRecordV1(value: StrictJsonValueV1, keys: readonly string[]): Record<string, StrictJsonValueV1> {
	if (!hasExactObjectKeys(value, keys)) protocolFailure("unknown_fields");
	return value;
}

function requiredIdentityV1(value: StrictJsonValueV1): string {
	if (typeof value !== "string" || value.length === 0 || !isWellFormedUnicodeV1(value)) {
		protocolFailure("invalid_identity");
	}
	return value;
}

function requiredSha256V1(value: StrictJsonValueV1): string {
	if (typeof value !== "string" || !SHA256_HEX_V1.test(value)) protocolFailure("invalid_digest");
	return value;
}

function requiredSha256RefV1(value: StrictJsonValueV1): string {
	if (typeof value !== "string" || !SHA256_REF_V1.test(value)) protocolFailure("invalid_digest");
	return value;
}

function requiredIntegerV1(value: StrictJsonValueV1, minimum = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) {
		protocolFailure("invalid_integer");
	}
	return value;
}

function requiredIso8601V1(value: StrictJsonValueV1): string {
	if (typeof value !== "string" || !ISO8601_V1.test(value)) protocolFailure("invalid_timestamp");
	try {
		if (new Date(value).toISOString() !== value) protocolFailure("invalid_timestamp");
	} catch {
		protocolFailure("invalid_timestamp");
	}
	return value;
}

function requiredLiteralV1<T extends string | boolean | number>(
	value: StrictJsonValueV1,
	allowed: readonly T[],
	code: CloudflareRuntimeProtocolErrorCodeV1 = "invalid_shape",
): T {
	if (!allowed.includes(value as T)) protocolFailure(code);
	return value as T;
}

function requiredArrayV1(value: StrictJsonValueV1): readonly StrictJsonValueV1[] {
	if (!Array.isArray(value)) protocolFailure("invalid_shape");
	return value;
}

function requiredIntegerWithinV1(value: StrictJsonValueV1, minimum: number, maximum: number): number {
	const decoded = requiredIntegerV1(value, minimum);
	if (decoded > maximum) protocolFailure("invalid_integer");
	return decoded;
}

function requiredNullableIntegerV1(value: StrictJsonValueV1, minimum: number): number | null {
	return value === null ? null : requiredIntegerV1(value, minimum);
}

function requiredStringAllowEmptyV1(value: StrictJsonValueV1): string {
	if (typeof value !== "string" || !isWellFormedUnicodeV1(value)) protocolFailure("invalid_shape");
	return value;
}

function requiredRuntimePathV1(value: StrictJsonValueV1, allowRoot: boolean): PersistentModelWorkspacePath {
	const path = requiredIdentityV1(value);
	if (path === CLOUD_OMP_REMOTE_ROOT) {
		if (!allowRoot) protocolFailure("invalid_shape");
		return path as PersistentModelWorkspacePath;
	}
	if (!path.startsWith(`${CLOUD_OMP_REMOTE_ROOT}/`)) protocolFailure("invalid_shape");
	const classification = classifyCanonicalRelativePath(path.slice(CLOUD_OMP_REMOTE_ROOT.length + 1));
	if (!classification.accepted) protocolFailure("invalid_shape");
	return path as PersistentModelWorkspacePath;
}

function decodeCanonicalBase64V1(value: StrictJsonValueV1): Uint8Array<ArrayBuffer> {
	if (typeof value !== "string") protocolFailure("invalid_shape");
	try {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		let canonical = "";
		for (let index = 0; index < bytes.byteLength; index += 1) canonical += String.fromCharCode(bytes[index]!);
		if (btoa(canonical) !== value) protocolFailure("invalid_shape");
		return bytes;
	} catch (error) {
		if (error instanceof CloudflareRuntimeProtocolErrorV1) throw error;
		return protocolFailure("invalid_shape");
	}
}

function equalStrictJsonV1(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((value, index) => equalStrictJsonV1(value, right[index]));
	}
	const leftKeys = Object.keys(left);
	const rightRecord = right as Record<string, unknown>;
	if (leftKeys.length !== Object.keys(rightRecord).length) return false;
	return leftKeys.every(
		key =>
			Object.hasOwn(rightRecord, key) && equalStrictJsonV1((left as Record<string, unknown>)[key], rightRecord[key]),
	);
}

async function sha256BytesV1(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	if (!globalThis.crypto?.subtle) protocolFailure("invalid_digest");
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function assertWorkspaceImageV1(value: StrictJsonValueV1): asserts value is Record<string, StrictJsonValueV1> {
	const image = strictProtocolRecordV1(value, ["rootSha256", "fileCount", "byteCount"]);
	requiredSha256V1(image.rootSha256);
	requiredIntegerV1(image.fileCount);
	requiredIntegerV1(image.byteCount);
}

function assertWorkspaceCheckpointV1(value: StrictJsonValueV1): asserts value is Record<string, StrictJsonValueV1> {
	const checkpoint = strictProtocolRecordV1(value, [
		"workspaceId",
		"generation",
		"rootSha256",
		"fileCount",
		"byteCount",
		"committedAt",
	]);
	requiredIdentityV1(checkpoint.workspaceId);
	requiredIntegerV1(checkpoint.generation);
	requiredSha256V1(checkpoint.rootSha256);
	requiredIntegerV1(checkpoint.fileCount);
	requiredIntegerV1(checkpoint.byteCount);
	requiredIso8601V1(checkpoint.committedAt);
}

function assertReplicaV1(value: StrictJsonValueV1): asserts value is Record<string, StrictJsonValueV1> {
	const replica = strictProtocolRecordV1(value, ["providerId", "profileId", "replicaId", "workspaceId"]);
	requiredIdentityV1(replica.providerId);
	requiredIdentityV1(replica.profileId);
	requiredIdentityV1(replica.replicaId);
	requiredIdentityV1(replica.workspaceId);
}

export async function deriveCloudflareRuntimeDurableObjectNameV1(replica: RuntimeReplicaRef): Promise<string> {
	const snapshot = strictJsonSnapshotV1(replica);
	assertReplicaV1(snapshot);
	return `runtime:v1:${await canonicalRuntimeSha256V1([
		"omp-cloudflare-runtime-do-v1",
		requiredIdentityV1(snapshot.providerId),
		requiredIdentityV1(snapshot.profileId),
		requiredIdentityV1(snapshot.replicaId),
		requiredIdentityV1(snapshot.workspaceId),
	])}`;
}

function assertLeaseV1(value: StrictJsonValueV1): asserts value is Record<string, StrictJsonValueV1> {
	const lease = strictProtocolRecordV1(value, [
		"leaseId",
		"replica",
		"fenceId",
		"baseGeneration",
		"renewalSequence",
		"acquiredAt",
		"renewBy",
		"expiresAt",
	]);
	requiredIdentityV1(lease.leaseId);
	assertReplicaV1(lease.replica);
	requiredIdentityV1(lease.fenceId);
	requiredIntegerV1(lease.baseGeneration);
	requiredIntegerV1(lease.renewalSequence);
	const acquiredAt = Date.parse(requiredIso8601V1(lease.acquiredAt));
	const renewBy = Date.parse(requiredIso8601V1(lease.renewBy));
	const expiresAt = Date.parse(requiredIso8601V1(lease.expiresAt));
	if (!(acquiredAt < renewBy && renewBy <= expiresAt)) protocolFailure("invalid_timestamp");
}

function assertFenceV1(value: StrictJsonValueV1, expectedFenceId: string): void {
	const fence = strictProtocolRecordV1(value, ["fenceId", "token"]);
	if (requiredIdentityV1(fence.fenceId) !== expectedFenceId) protocolFailure("request_identity_mismatch");
	requiredIdentityV1(fence.token);
}

function assertRuntimeAccessContextV1(
	request: Record<string, StrictJsonValueV1>,
	replica: Record<string, StrictJsonValueV1>,
): RuntimeAccessContext {
	const workspaceId = requiredIdentityV1(request.workspaceId);
	const replicaId = requiredIdentityV1(request.replicaId);
	if (workspaceId !== replica.workspaceId || replicaId !== replica.replicaId) {
		protocolFailure("request_identity_mismatch");
	}
	const fence = strictProtocolRecordV1(request.fence, ["fenceId", "token"]);
	return {
		operationLeaseId: requiredIdentityV1(request.operationLeaseId),
		workspaceId,
		expectedGeneration: requiredIntegerV1(request.expectedGeneration),
		replicaId,
		leaseId: requiredIdentityV1(request.leaseId),
		fence: {
			fenceId: requiredIdentityV1(fence.fenceId),
			token: requiredIdentityV1(fence.token),
		} as RuntimeFence,
	};
}

function assertRuntimeCommandSpecV1(value: StrictJsonValueV1): RuntimeCommandRequest["command"] {
	const command = strictProtocolRecordV1(value, [
		"shell",
		"source",
		"cwd",
		"environment",
		"timeoutMs",
		"outputByteLimit",
		"pty",
	]);
	requiredLiteralV1(command.shell, ["/bin/bash"] as const);
	const source = requiredIdentityV1(command.source);
	if (source.includes("\0") || strictProtocolEncoderV1.encode(source).byteLength > MAX_COMMAND_BYTES) {
		protocolFailure("invalid_shape");
	}
	return {
		shell: "/bin/bash",
		source,
		cwd: requiredRuntimePathV1(command.cwd, true),
		environment: requiredLiteralV1(command.environment, ["omp-runtime-scrubbed-v1"] as const),
		timeoutMs: requiredIntegerWithinV1(command.timeoutMs, 1, MAX_COMMAND_TIMEOUT_MS),
		outputByteLimit: requiredIntegerWithinV1(command.outputByteLimit, 1, MAX_EXEC_OUTPUT_BYTES),
		pty: requiredLiteralV1(command.pty, [false] as const),
	};
}

function assertCandidateV1(value: StrictJsonValueV1): void {
	const candidate = strictProtocolRecordV1(value, [
		"providerId",
		"profileId",
		"location",
		"capabilities",
		"workspaceFormats",
		"os",
		"arch",
		"cpu",
		"memoryMiB",
		"network",
		"available",
		"estimatedIncrementalCostMicrosPerHour",
		"estimatedReadyLatencyMs",
	]);
	requiredIdentityV1(candidate.providerId);
	requiredIdentityV1(candidate.profileId);
	requiredLiteralV1(candidate.location, ["local", "cloud"] as const);
	const capabilities = requiredArrayV1(candidate.capabilities);
	const seenCapabilities = new Set<string>();
	for (const capability of capabilities) {
		const decoded = requiredLiteralV1(capability, [
			"workspace.read",
			"workspace.write",
			"workspace.list",
			"workspace.search",
			"process.exec",
			"process.pty",
			"process.env",
		] as const);
		if (seenCapabilities.has(decoded)) protocolFailure("invalid_shape");
		seenCapabilities.add(decoded);
	}
	const formats = requiredArrayV1(candidate.workspaceFormats);
	if (formats.length !== 1 || formats[0] !== "omp-text-v1") protocolFailure("invalid_shape");
	requiredLiteralV1(candidate.os, ["darwin", "linux", "windows"] as const);
	requiredLiteralV1(candidate.arch, ["arm64", "x64"] as const);
	requiredIntegerV1(candidate.cpu);
	requiredIntegerV1(candidate.memoryMiB);
	requiredLiteralV1(candidate.network, ["none", "egress"] as const);
	if (typeof candidate.available !== "boolean") protocolFailure("invalid_shape");
	requiredIntegerV1(candidate.estimatedIncrementalCostMicrosPerHour);
	requiredIntegerV1(candidate.estimatedReadyLatencyMs);
}

function assertLeasePlanV1(value: StrictJsonValueV1): void {
	const plan = strictProtocolRecordV1(value, [
		"replica",
		"leaseId",
		"fenceId",
		"initialRenewalSequence",
		"baseCheckpoint",
		"deletionAuthorityDomain",
		"leaseTtlMs",
	]);
	assertReplicaV1(plan.replica);
	requiredIdentityV1(plan.leaseId);
	requiredIdentityV1(plan.fenceId);
	requiredLiteralV1(plan.initialRenewalSequence, [0] as const);
	assertWorkspaceCheckpointV1(plan.baseCheckpoint);
	requiredLiteralV1(plan.deletionAuthorityDomain, ["persistent", "transient_task"] as const);
	if (requiredIntegerV1(plan.leaseTtlMs, 1) < 1) protocolFailure("invalid_integer");
	const replica = plan.replica;
	const checkpoint = plan.baseCheckpoint;
	if (replica.workspaceId !== checkpoint.workspaceId) protocolFailure("checkpoint_mismatch");
}

async function assertWorkspaceSnapshotV1(value: StrictJsonValueV1): Promise<void> {
	const snapshot = strictProtocolRecordV1(value, ["checkpoint", "files"]);
	assertWorkspaceCheckpointV1(snapshot.checkpoint);
	const checkpoint = snapshot.checkpoint;
	const files = requiredArrayV1(snapshot.files);
	let totalBytes = 0;
	let manifestMaterial = "";
	let previousPath: string | null = null;
	for (const fileValue of files) {
		const file = strictProtocolRecordV1(fileValue, ["path", "sha256", "byteLength", "contentUtf8"]);
		const path = requiredIdentityV1(file.path);
		const classification = classifyCanonicalRelativePath(path);
		if (!classification.accepted) protocolFailure("invalid_shape");
		if (previousPath !== null && compareUtf8(previousPath, path) >= 0) protocolFailure("invalid_shape");
		previousPath = path;
		const sha256 = requiredSha256V1(file.sha256);
		const byteLength = requiredIntegerV1(file.byteLength);
		if (typeof file.contentUtf8 !== "string" || !isWellFormedUnicodeV1(file.contentUtf8))
			protocolFailure("invalid_shape");
		const bytes = strictProtocolEncoderV1.encode(file.contentUtf8);
		if (bytes.byteLength !== byteLength || (await sha256BytesV1(bytes)) !== sha256) {
			protocolFailure("checkpoint_mismatch");
		}
		manifestMaterial += `${path}\0${sha256}\0${byteLength}\n`;
		totalBytes += byteLength;
		if (!Number.isSafeInteger(totalBytes)) protocolFailure("invalid_integer");
	}
	if (
		checkpoint.fileCount !== files.length ||
		checkpoint.byteCount !== totalBytes ||
		(await sha256BytesV1(strictProtocolEncoderV1.encode(manifestMaterial))) !== checkpoint.rootSha256
	) {
		protocolFailure("checkpoint_mismatch");
	}
}

function assertFrozenCheckpointReferenceV1(value: StrictJsonValueV1): void {
	const reference = strictProtocolRecordV1(value, [
		"providerId",
		"profileId",
		"workspaceId",
		"replicaId",
		"leaseId",
		"checkpointId",
		"rootSha256",
		"fileCount",
		"byteCount",
		"format",
		"baseGeneration",
		"frozenAt",
	]);
	for (const key of ["providerId", "profileId", "workspaceId", "replicaId", "leaseId", "checkpointId"] as const) {
		requiredIdentityV1(reference[key]);
	}
	requiredSha256V1(reference.rootSha256);
	requiredIntegerV1(reference.fileCount);
	requiredIntegerV1(reference.byteCount);
	requiredLiteralV1(reference.format, ["omp-text-v1"] as const);
	requiredIntegerV1(reference.baseGeneration);
	requiredIso8601V1(reference.frozenAt);
}

function assertCanonicalCommitReceiptV1(value: StrictJsonValueV1): void {
	const receipt = strictProtocolRecordV1(value, [
		"workspaceId",
		"commitId",
		"expectedGeneration",
		"checkpoint",
		"durableAt",
	]);
	requiredIdentityV1(receipt.workspaceId);
	requiredIdentityV1(receipt.commitId);
	requiredIntegerV1(receipt.expectedGeneration);
	assertWorkspaceCheckpointV1(receipt.checkpoint);
	requiredIso8601V1(receipt.durableAt);
	if (receipt.workspaceId !== receipt.checkpoint.workspaceId) protocolFailure("checkpoint_mismatch");
}

function assertRequestIdentityV1(request: Record<string, StrictJsonValueV1>): void {
	requiredSha256V1(request.requestId);
	requiredSha256V1(request.requestSha256);
}

function workspaceImageTupleV1(image: WorkspaceImage): readonly CanonicalRuntimeValueV1[] {
	return [image.rootSha256, image.fileCount, image.byteCount];
}

export function projectCloudflareRuntimeInspectionTupleV1(
	input: RuntimeCanonicalProviderInspectionV1,
): readonly CanonicalRuntimeValueV1[] {
	switch (input.operation) {
		case "acquire": {
			const { request } = input;
			return [
				"omp-runtime-provider-v1",
				"acquire",
				request.transitionId,
				request.candidate.providerId,
				request.candidate.profileId,
				request.plan.replica.workspaceId,
				request.plan.replica.replicaId,
				request.plan.leaseId,
				request.plan.fenceId,
				request.plan.baseCheckpoint.generation,
				request.plan.baseCheckpoint.rootSha256,
				request.plan.baseCheckpoint.fileCount,
				request.plan.baseCheckpoint.byteCount,
				request.plan.deletionAuthorityDomain,
				request.plan.leaseTtlMs,
				request.plan.initialRenewalSequence,
			];
		}
		case "push": {
			const { request } = input;
			return [
				"omp-runtime-provider-v1",
				"push",
				request.transitionId,
				request.lease.replica.providerId,
				request.lease.replica.profileId,
				request.lease.replica.workspaceId,
				request.lease.replica.replicaId,
				request.lease.leaseId,
				request.lease.fenceId,
				request.lease.baseGeneration,
				...workspaceImageTupleV1(request.snapshot),
			];
		}
		case "quiesce": {
			const { request } = input;
			return [
				"omp-runtime-provider-v1",
				"quiesce",
				request.transitionId,
				request.lease.replica.providerId,
				request.lease.replica.profileId,
				request.lease.replica.workspaceId,
				request.lease.replica.replicaId,
				request.lease.leaseId,
				request.lease.fenceId,
				request.lease.baseGeneration,
			];
		}
		case "checkpoint": {
			const { request } = input;
			return [
				"omp-runtime-provider-v1",
				"checkpoint",
				request.transitionId,
				request.lease.replica.providerId,
				request.lease.replica.profileId,
				request.lease.replica.workspaceId,
				request.lease.replica.replicaId,
				request.lease.leaseId,
				request.lease.fenceId,
				request.checkpointId,
				request.lease.baseGeneration,
			];
		}
		case "revoke": {
			const { request } = input;
			return [
				"omp-runtime-provider-v1",
				"revoke",
				request.transitionId,
				request.replica.providerId,
				request.replica.profileId,
				request.replica.workspaceId,
				request.replica.replicaId,
				request.leaseId,
				request.fenceId,
				request.reasonCode,
			];
		}
		case "checkpoint_acknowledgement": {
			const { request } = input;
			return [
				"omp-runtime-provider-v1",
				"checkpoint_ack",
				request.parentOperationId,
				request.reference.providerId,
				request.reference.profileId,
				request.reference.workspaceId,
				request.reference.replicaId,
				request.reference.leaseId,
				request.reference.checkpointId,
				request.reference.baseGeneration,
				request.canonicalCommit.commitId,
				request.canonicalCommit.checkpoint.generation,
				request.canonicalCommit.checkpoint.rootSha256,
				request.canonicalCommit.checkpoint.fileCount,
				request.canonicalCommit.checkpoint.byteCount,
			];
		}
		case "release": {
			const { request } = input;
			return [
				"omp-runtime-provider-v1",
				"release",
				request.parentOperationId,
				request.replica.providerId,
				request.replica.profileId,
				request.replica.workspaceId,
				request.replica.replicaId,
				request.leaseId,
			];
		}
	}
}

async function validateRuntimeOperationEnvelopeV1(
	input: unknown,
	effect: boolean,
): Promise<CloudflareValidatedRuntimeOperationV1> {
	const snapshot = strictJsonSnapshotV1(input);
	const envelope = strictProtocolRecordV1(snapshot, ["schemaVersion", "operation", "request"]);
	requiredLiteralV1(envelope.schemaVersion, [1] as const, "invalid_schema_version");
	const operation = requiredLiteralV1(
		envelope.operation,
		["acquire", "push", "quiesce", "checkpoint", "revoke", "checkpoint_acknowledgement", "release"] as const,
		"invalid_operation",
	);
	let inspection: RuntimeCanonicalProviderInspectionV1;
	switch (operation) {
		case "acquire": {
			const keys = effect
				? ["requestId", "requestSha256", "transitionId", "candidate", "plan", "fence"]
				: ["requestId", "requestSha256", "transitionId", "candidate", "plan"];
			const request = strictProtocolRecordV1(envelope.request, keys);
			assertRequestIdentityV1(request);
			requiredIdentityV1(request.transitionId);
			assertCandidateV1(request.candidate);
			assertLeasePlanV1(request.plan);
			const candidate = request.candidate as Record<string, StrictJsonValueV1>;
			const plan = request.plan as Record<string, StrictJsonValueV1>;
			const replica = plan.replica as Record<string, StrictJsonValueV1>;
			if (candidate.providerId !== replica.providerId || candidate.profileId !== replica.profileId) {
				protocolFailure("request_identity_mismatch");
			}
			if (effect) assertFenceV1(request.fence, requiredIdentityV1(plan.fenceId));
			inspection = {
				operation,
				request: {
					requestId: request.requestId,
					requestSha256: request.requestSha256,
					transitionId: request.transitionId,
					candidate: request.candidate,
					plan: request.plan,
				} as unknown as RuntimeAcquireInspectRequest,
			};
			break;
		}
		case "push": {
			const keys = effect
				? ["requestId", "requestSha256", "transitionId", "lease", "fence", "snapshot"]
				: ["requestId", "requestSha256", "transitionId", "lease", "snapshot"];
			const request = strictProtocolRecordV1(envelope.request, keys);
			assertRequestIdentityV1(request);
			requiredIdentityV1(request.transitionId);
			assertLeaseV1(request.lease);
			const lease = request.lease as Record<string, StrictJsonValueV1>;
			if (effect) {
				assertFenceV1(request.fence, requiredIdentityV1(lease.fenceId));
				await assertWorkspaceSnapshotV1(request.snapshot);
				const snapshot = request.snapshot as Record<string, StrictJsonValueV1>;
				const checkpoint = snapshot.checkpoint as Record<string, StrictJsonValueV1>;
				const replica = lease.replica as Record<string, StrictJsonValueV1>;
				if (checkpoint.generation !== lease.baseGeneration) protocolFailure("push_generation_mismatch");
				if (checkpoint.workspaceId !== replica.workspaceId) protocolFailure("checkpoint_mismatch");
				inspection = {
					operation,
					request: {
						requestId: request.requestId,
						requestSha256: request.requestSha256,
						transitionId: request.transitionId,
						lease: request.lease,
						snapshot: {
							rootSha256: checkpoint.rootSha256,
							fileCount: checkpoint.fileCount,
							byteCount: checkpoint.byteCount,
						},
					} as unknown as RuntimePushInspectRequest,
				};
			} else {
				assertWorkspaceImageV1(request.snapshot);
				inspection = { operation, request: request as unknown as RuntimePushInspectRequest };
			}
			break;
		}
		case "quiesce":
		case "checkpoint": {
			const keys =
				operation === "checkpoint"
					? effect
						? ["requestId", "requestSha256", "transitionId", "checkpointId", "lease", "fence"]
						: ["requestId", "requestSha256", "transitionId", "checkpointId", "lease"]
					: effect
						? ["requestId", "requestSha256", "transitionId", "lease", "fence"]
						: ["requestId", "requestSha256", "transitionId", "lease"];
			const request = strictProtocolRecordV1(envelope.request, keys);
			assertRequestIdentityV1(request);
			requiredIdentityV1(request.transitionId);
			assertLeaseV1(request.lease);
			if (operation === "checkpoint") requiredIdentityV1(request.checkpointId);
			const lease = request.lease as Record<string, StrictJsonValueV1>;
			if (effect) assertFenceV1(request.fence, requiredIdentityV1(lease.fenceId));
			inspection =
				operation === "checkpoint"
					? { operation, request: request as unknown as RuntimeCheckpointInspectRequest }
					: { operation, request: request as unknown as RuntimeQuiesceInspectRequest };
			break;
		}
		case "revoke": {
			const request = strictProtocolRecordV1(envelope.request, [
				"requestId",
				"requestSha256",
				"transitionId",
				"replica",
				"leaseId",
				"fenceId",
				"reasonCode",
			]);
			assertRequestIdentityV1(request);
			requiredIdentityV1(request.transitionId);
			assertReplicaV1(request.replica);
			requiredIdentityV1(request.leaseId);
			requiredIdentityV1(request.fenceId);
			requiredIdentityV1(request.reasonCode);
			inspection = { operation, request: request as unknown as RuntimeRevokeInspectRequest };
			break;
		}
		case "checkpoint_acknowledgement": {
			const request = strictProtocolRecordV1(envelope.request, [
				"requestId",
				"requestSha256",
				"parentOperationId",
				"reference",
				"canonicalCommit",
			]);
			assertRequestIdentityV1(request);
			requiredIdentityV1(request.parentOperationId);
			assertFrozenCheckpointReferenceV1(request.reference);
			assertCanonicalCommitReceiptV1(request.canonicalCommit);
			const reference = request.reference as Record<string, StrictJsonValueV1>;
			const commit = request.canonicalCommit as Record<string, StrictJsonValueV1>;
			const checkpoint = commit.checkpoint as Record<string, StrictJsonValueV1>;
			if (
				reference.workspaceId !== commit.workspaceId ||
				reference.workspaceId !== checkpoint.workspaceId ||
				reference.baseGeneration !== commit.expectedGeneration ||
				checkpoint.generation !== requiredIntegerV1(reference.baseGeneration) + 1 ||
				reference.rootSha256 !== checkpoint.rootSha256 ||
				reference.fileCount !== checkpoint.fileCount ||
				reference.byteCount !== checkpoint.byteCount
			) {
				protocolFailure("checkpoint_mismatch");
			}
			inspection = { operation, request: request as unknown as RuntimeCheckpointAcknowledgeInspectRequest };
			break;
		}
		case "release": {
			const request = strictProtocolRecordV1(envelope.request, [
				"requestId",
				"requestSha256",
				"parentOperationId",
				"replica",
				"leaseId",
			]);
			assertRequestIdentityV1(request);
			requiredIdentityV1(request.parentOperationId);
			assertReplicaV1(request.replica);
			requiredIdentityV1(request.leaseId);
			inspection = { operation, request: request as unknown as RuntimeLeaseReleaseInspectRequest };
			break;
		}
	}
	const tuple = projectCloudflareRuntimeInspectionTupleV1(inspection);
	const requestSha256 = await canonicalRuntimeSha256V1(tuple);
	if (requestSha256 !== inspection.request.requestSha256) protocolFailure("request_digest_mismatch");
	return {
		operation,
		requestId: inspection.request.requestId,
		requestSha256,
		canonicalTupleUtf8: new TextDecoder().decode(encodeCanonicalRuntimeTupleV1(tuple)),
		inspection,
		envelope: snapshot as unknown as CloudflareRuntimeEffectEnvelopeV1 | CloudflareRuntimeInspectionEnvelopeV1,
	};
}

export function decodeCloudflareRuntimeEffectEnvelopeV1(
	input: unknown,
): Promise<CloudflareValidatedRuntimeOperationV1> {
	return validateRuntimeOperationEnvelopeV1(input, true);
}

export function decodeCloudflareRuntimeInspectionEnvelopeV1(
	input: unknown,
): Promise<CloudflareValidatedRuntimeOperationV1> {
	return validateRuntimeOperationEnvelopeV1(input, false);
}

function runtimeRenewalTupleV1(plan: RuntimeLeaseRenewalPlan): readonly CanonicalRuntimeValueV1[] {
	return [
		"omp-runtime-provider-v1",
		"renew",
		plan.renewalId,
		plan.sequence,
		plan.expectedLease.replica.providerId,
		plan.expectedLease.replica.profileId,
		plan.expectedLease.replica.workspaceId,
		plan.expectedLease.replica.replicaId,
		plan.expectedLease.leaseId,
		plan.expectedLease.fenceId,
		plan.expectedLease.baseGeneration,
		plan.expectedLease.renewalSequence,
		plan.expectedLease.acquiredAt,
		plan.expectedLease.renewBy,
		plan.expectedLease.expiresAt,
		plan.leaseTtlMs,
	];
}

function decodeRuntimeLeaseV1(value: StrictJsonValueV1): RuntimeLeaseRef {
	assertLeaseV1(value);
	return value as unknown as RuntimeLeaseRef;
}

interface DecodedRuntimeRenewalPlanTransportV1 {
	readonly plan: RuntimeLeaseRenewalPlan;
	readonly canonicalTupleUtf8: string;
}

async function decodeRuntimeRenewalPlanTransportV1(
	value: StrictJsonValueV1,
): Promise<DecodedRuntimeRenewalPlanTransportV1> {
	const plan = strictProtocolRecordV1(value, ["renewalId", "sequence", "expectedLease", "leaseTtlMs", "request"]);
	const request = strictProtocolRecordV1(plan.request, ["requestId", "requestSha256"]);
	const decoded: RuntimeLeaseRenewalPlan = {
		renewalId: requiredIdentityV1(plan.renewalId),
		sequence: requiredIntegerV1(plan.sequence, 1),
		expectedLease: decodeRuntimeLeaseV1(plan.expectedLease),
		leaseTtlMs: requiredIntegerV1(plan.leaseTtlMs, 1),
		request: {
			requestId: requiredSha256V1(request.requestId),
			requestSha256: requiredSha256V1(request.requestSha256),
		},
	};
	if (decoded.sequence !== decoded.expectedLease.renewalSequence + 1) protocolFailure("request_identity_mismatch");
	const tuple = runtimeRenewalTupleV1(decoded);
	if ((await canonicalRuntimeSha256V1(tuple)) !== decoded.request.requestSha256)
		protocolFailure("request_digest_mismatch");
	return { plan: decoded, canonicalTupleUtf8: new TextDecoder().decode(encodeCanonicalRuntimeTupleV1(tuple)) };
}

function decodeRuntimeRecoveryFreezeLocatorTransportV1(value: StrictJsonValueV1) {
	const locator = strictProtocolRecordV1(value, [
		"recoveryFreezeId",
		"replica",
		"leaseId",
		"fenceId",
		"baseGeneration",
		"checkpointId",
	]);
	assertReplicaV1(locator.replica);
	return {
		recoveryFreezeId: requiredIdentityV1(locator.recoveryFreezeId),
		replica: locator.replica as unknown as RuntimeReplicaRef,
		leaseId: requiredIdentityV1(locator.leaseId),
		fenceId: requiredIdentityV1(locator.fenceId),
		baseGeneration: requiredIntegerV1(locator.baseGeneration),
		checkpointId: requiredIdentityV1(locator.checkpointId),
	} as Omit<RuntimeRecoveryFreezeRequest, "signal">["locator"];
}

interface DecodedRuntimeRecoveryFreezeTransportV1 {
	readonly request: Omit<RuntimeRecoveryFreezeRequest, "signal">;
	readonly canonicalTupleUtf8: string;
}

async function decodeRuntimeRecoveryFreezeRequestTransportV1(
	value: StrictJsonValueV1,
): Promise<DecodedRuntimeRecoveryFreezeTransportV1> {
	const request = strictProtocolRecordV1(value, ["requestId", "requestSha256", "locator"]);
	const decoded: Omit<RuntimeRecoveryFreezeRequest, "signal"> = {
		requestId: requiredSha256V1(request.requestId),
		requestSha256: requiredSha256V1(request.requestSha256),
		locator: decodeRuntimeRecoveryFreezeLocatorTransportV1(request.locator),
	};
	const { locator } = decoded;
	const tuple = [
		"omp-runtime-provider-v1",
		"recovery_freeze",
		locator.recoveryFreezeId,
		locator.replica.providerId,
		locator.replica.profileId,
		locator.replica.workspaceId,
		locator.replica.replicaId,
		locator.leaseId,
		locator.fenceId,
		locator.baseGeneration,
		locator.checkpointId,
	] as const;
	if ((await canonicalRuntimeSha256V1(tuple)) !== decoded.requestSha256) protocolFailure("request_digest_mismatch");
	return { request: decoded, canonicalTupleUtf8: new TextDecoder().decode(encodeCanonicalRuntimeTupleV1(tuple)) };
}

function decodeRuntimeCommandLocatorTransportV1(value: StrictJsonValueV1): RuntimeCommandLocator {
	const locator = strictProtocolRecordV1(value, ["replica", "leaseId", "commandId", "requestSha256"]);
	assertReplicaV1(locator.replica);
	return {
		replica: locator.replica as unknown as RuntimeReplicaRef,
		leaseId: requiredIdentityV1(locator.leaseId),
		commandId: requiredIdentityV1(locator.commandId),
		requestSha256: requiredSha256V1(locator.requestSha256),
	};
}

function assertTransportReplicaMatchV1(actual: RuntimeReplicaRef, expected: Record<string, StrictJsonValueV1>): void {
	if (!equalStrictJsonV1(actual, expected)) protocolFailure("request_identity_mismatch");
}

async function assertRuntimeMutationDigestV1(
	request: Record<string, StrictJsonValueV1>,
	tuple: readonly CanonicalRuntimeValueV1[],
): Promise<void> {
	requiredSha256V1(request.requestId);
	const requestSha256 = requiredSha256V1(request.requestSha256);
	if ((await canonicalRuntimeSha256V1(tuple)) !== requestSha256) protocolFailure("request_digest_mismatch");
}

async function assertRuntimeBridgeRequestV1(
	operation:
		| CloudflareRuntimeBridgeEffectEnvelopeV1["operation"]
		| CloudflareRuntimeBridgeInspectionEnvelopeV1["operation"],
	value: StrictJsonValueV1,
	replica: Record<string, StrictJsonValueV1>,
): Promise<void> {
	const baseKeys = ["operationLeaseId", "workspaceId", "expectedGeneration", "replicaId", "leaseId", "fence"] as const;
	const mutationKeys = [...baseKeys, "requestId", "requestSha256"] as const;
	let keys: readonly string[];
	switch (operation) {
		case "read_text_file":
			keys = [...baseKeys, "path", "line", "limit", "byteLimit"];
			break;
		case "read_binary_file":
			keys = [...baseKeys, "path", "offset", "byteLimit"];
			break;
		case "write_text_file":
			keys = [...mutationKeys, "path", "content", "contentSha256"];
			break;
		case "exists":
		case "stat":
			keys = [...baseKeys, "path"];
			break;
		case "mkdir":
		case "remove":
			keys = [...mutationKeys, "path", "recursive"];
			break;
		case "rename":
			keys = [...mutationKeys, "from", "to"];
			break;
		case "list_files":
			keys = [...baseKeys, "directory", "pattern", "limit", "cursor"];
			break;
		case "search_text":
			keys = [...baseKeys, "path", "pattern", "flags", "limit", "cursor"];
			break;
		case "submit_command":
			keys = [...baseKeys, "commandId", "requestSha256", "command"];
			break;
		case "inspect_command":
			keys = [...baseKeys, "commandId"];
			break;
		case "cancel_command":
			keys = [...mutationKeys, "commandId", "signal"];
			break;
		case "dispose_command":
			keys = [...mutationKeys, "commandId"];
			break;
	}
	const request = strictProtocolRecordV1(value, keys);
	const access = assertRuntimeAccessContextV1(request, replica);
	const accessTuple = [
		access.operationLeaseId,
		access.workspaceId,
		access.expectedGeneration,
		access.replicaId,
		access.leaseId,
		access.fence.fenceId,
	] as const;
	if (operation === "list_files" && request.cursor !== null) {
		const cursor = requiredIdentityV1(request.cursor);
		if (!/^\d+$/.test(cursor)) protocolFailure("invalid_shape");
	}
	switch (operation) {
		case "read_text_file":
			requiredRuntimePathV1(request.path, false);
			requiredNullableIntegerV1(request.line, 1);
			requiredNullableIntegerV1(request.limit, 1);
			requiredIntegerWithinV1(request.byteLimit, 1, MAX_SYNC_FILE_BYTES);
			return;
		case "read_binary_file":
			requiredRuntimePathV1(request.path, false);
			requiredIntegerV1(request.offset);
			requiredIntegerWithinV1(request.byteLimit, 1, MAX_SYNC_FILE_BYTES);
			return;
		case "write_text_file": {
			const path = requiredRuntimePathV1(request.path, false);
			const content = requiredStringAllowEmptyV1(request.content);
			const bytes = strictProtocolEncoderV1.encode(content);
			if (bytes.byteLength > MAX_SYNC_FILE_BYTES) protocolFailure("invalid_shape");
			const contentSha256 = requiredSha256V1(request.contentSha256);
			if ((await sha256BytesV1(bytes)) !== contentSha256) protocolFailure("request_digest_mismatch");
			await assertRuntimeMutationDigestV1(request, [
				"omp-runtime-request-v1",
				"write_text",
				...accessTuple,
				path,
				contentSha256,
				bytes.byteLength,
			]);
			return;
		}
		case "exists":
		case "stat":
			requiredRuntimePathV1(request.path, true);
			return;
		case "mkdir":
		case "remove": {
			const path = requiredRuntimePathV1(request.path, false);
			if (typeof request.recursive !== "boolean") protocolFailure("invalid_shape");
			await assertRuntimeMutationDigestV1(request, [
				"omp-runtime-request-v1",
				operation,
				...accessTuple,
				path,
				request.recursive,
			]);
			return;
		}
		case "rename":
			await assertRuntimeMutationDigestV1(request, [
				"omp-runtime-request-v1",
				"rename",
				...accessTuple,
				requiredRuntimePathV1(request.from, false),
				requiredRuntimePathV1(request.to, false),
			]);
			return;
		case "list_files":
			requiredRuntimePathV1(request.directory, true);
			requiredStringAllowEmptyV1(request.pattern);
			requiredIntegerWithinV1(request.limit, 1, 1_000);
			return;
		case "search_text": {
			const path = requiredRuntimePathV1(request.path, true);
			if (!runtimeSearchCursorPathFitsV1(path)) protocolFailure("invalid_shape");
			const pattern = requiredIdentityV1(request.pattern);
			const flags = requiredStringAllowEmptyV1(request.flags);
			const limit = requiredIntegerWithinV1(request.limit, 1, 1_000);
			const cursor = request.cursor === null ? null : requiredIdentityV1(request.cursor);
			if (
				strictProtocolEncoderV1.encode(pattern).byteLength > MAX_RUNTIME_SEARCH_PATTERN_BYTES_V1 ||
				!RUNTIME_SEARCH_FLAGS_V1.test(flags) ||
				!isBoundedRuntimeSearchPatternV1(pattern)
			) {
				protocolFailure("invalid_shape");
			}
			try {
				new RegExp(pattern, flags);
			} catch {
				protocolFailure("invalid_shape");
			}
			await decodeCloudflareRuntimeSearchCursorV1(cursor, {
				...access,
				path,
				pattern,
				flags,
				limit,
				cursor,
			} as RuntimeSearchRequest);
			return;
		}
		case "submit_command": {
			const requestSha256 = requiredSha256V1(request.requestSha256);
			requiredIdentityV1(request.commandId);
			const command = assertRuntimeCommandSpecV1(request.command);
			if (
				(await canonicalRuntimeSha256V1([
					"omp-runtime-request-v1",
					"command_submit",
					...accessTuple,
					command.shell,
					command.source,
					command.cwd,
					command.environment,
					command.timeoutMs,
					command.outputByteLimit,
					command.pty,
				])) !== requestSha256
			) {
				protocolFailure("request_digest_mismatch");
			}
			return;
		}
		case "inspect_command":
			requiredIdentityV1(request.commandId);
			return;
		case "cancel_command": {
			const signal = requiredLiteralV1(request.signal, ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"] as const);
			await assertRuntimeMutationDigestV1(request, [
				"omp-runtime-request-v1",
				"command_cancel",
				...accessTuple,
				requiredIdentityV1(request.commandId),
				signal,
			]);
			return;
		}
		case "dispose_command":
			await assertRuntimeMutationDigestV1(request, [
				"omp-runtime-request-v1",
				"command_dispose",
				...accessTuple,
				requiredIdentityV1(request.commandId),
			]);
	}
}

async function decodeCloudflareSupplementalRuntimeTransportEnvelopeV1(
	snapshot: StrictJsonValueV1,
	effect: boolean,
): Promise<
	| Exclude<CloudflareValidatedRuntimeEffectTransportV1, { readonly transportFamily: "lifecycle" }>
	| Exclude<CloudflareValidatedRuntimeInspectionTransportV1, { readonly transportFamily: "lifecycle" }>
> {
	const envelope = strictProtocolRecordV1(snapshot, ["schemaVersion", "family", "operation", "replica", "request"]);
	requiredLiteralV1(envelope.schemaVersion, [1] as const, "invalid_schema_version");
	const family = requiredLiteralV1(envelope.family, ["control", "bridge"] as const, "invalid_operation");
	assertReplicaV1(envelope.replica);
	if (family === "control") {
		const operation = requiredLiteralV1(
			envelope.operation,
			effect
				? (["renew", "recovery_freeze", "command_start_reconcile"] as const)
				: (["renew", "recovery_freeze", "command"] as const),
			"invalid_operation",
		);
		const replica = envelope.replica as unknown as RuntimeReplicaRef;
		if (operation === "renew") {
			if (effect) {
				const request = strictProtocolRecordV1(envelope.request, ["plan", "fence"]);
				const decoded = await decodeRuntimeRenewalPlanTransportV1(request.plan);
				assertTransportReplicaMatchV1(decoded.plan.expectedLease.replica, envelope.replica);
				assertFenceV1(request.fence, decoded.plan.expectedLease.fenceId);
				return {
					transportFamily: "control",
					schemaVersion: 1,
					family,
					operation,
					replica,
					request: { plan: decoded.plan, fence: request.fence as unknown as RuntimeFence },
					canonicalTupleUtf8: decoded.canonicalTupleUtf8,
				};
			}
			const decoded = await decodeRuntimeRenewalPlanTransportV1(envelope.request);
			assertTransportReplicaMatchV1(decoded.plan.expectedLease.replica, envelope.replica);
			return {
				transportFamily: "control",
				schemaVersion: 1,
				family,
				operation,
				replica,
				request: decoded.plan,
				canonicalTupleUtf8: decoded.canonicalTupleUtf8,
			};
		}
		if (operation === "recovery_freeze") {
			const decoded = await decodeRuntimeRecoveryFreezeRequestTransportV1(envelope.request);
			assertTransportReplicaMatchV1(decoded.request.locator.replica, envelope.replica);
			return {
				transportFamily: "control",
				schemaVersion: 1,
				family,
				operation,
				replica,
				request: decoded.request,
				canonicalTupleUtf8: decoded.canonicalTupleUtf8,
			};
		}
		const request = decodeRuntimeCommandLocatorTransportV1(envelope.request);
		assertTransportReplicaMatchV1(request.replica, envelope.replica);
		return { transportFamily: "control", schemaVersion: 1, family, operation, replica, request } as
			| CloudflareValidatedRuntimeControlEffectTransportV1
			| CloudflareValidatedRuntimeControlInspectionTransportV1;
	}
	const operation = requiredLiteralV1(
		envelope.operation,
		effect
			? ([
					"write_text_file",
					"mkdir",
					"remove",
					"rename",
					"submit_command",
					"cancel_command",
					"dispose_command",
				] as const)
			: ([
					"read_text_file",
					"read_binary_file",
					"exists",
					"stat",
					"list_files",
					"search_text",
					"inspect_command",
				] as const),
		"invalid_operation",
	);
	await assertRuntimeBridgeRequestV1(operation, envelope.request, envelope.replica);
	return { transportFamily: "bridge", ...envelope } as unknown as
		| (CloudflareRuntimeBridgeEffectEnvelopeV1 & { readonly transportFamily: "bridge" })
		| (CloudflareRuntimeBridgeInspectionEnvelopeV1 & { readonly transportFamily: "bridge" });
}

export async function decodeCloudflareRuntimeEffectTransportEnvelopeV1(
	input: unknown,
): Promise<CloudflareValidatedRuntimeEffectTransportV1> {
	const snapshot = strictJsonSnapshotV1(input);
	if (hasExactObjectKeys(snapshot, ["schemaVersion", "operation", "request"])) {
		const validated = await decodeCloudflareRuntimeEffectEnvelopeV1(snapshot);
		return {
			...validated,
			transportFamily: "lifecycle",
			envelope: validated.envelope as CloudflareRuntimeEffectEnvelopeV1,
		};
	}
	return (await decodeCloudflareSupplementalRuntimeTransportEnvelopeV1(
		snapshot,
		true,
	)) as CloudflareValidatedRuntimeEffectTransportV1;
}

export async function decodeCloudflareRuntimeInspectionTransportEnvelopeV1(
	input: unknown,
): Promise<CloudflareValidatedRuntimeInspectionTransportV1> {
	const snapshot = strictJsonSnapshotV1(input);
	if (hasExactObjectKeys(snapshot, ["schemaVersion", "operation", "request"])) {
		const validated = await decodeCloudflareRuntimeInspectionEnvelopeV1(snapshot);
		return {
			...validated,
			transportFamily: "lifecycle",
			envelope: validated.envelope as CloudflareRuntimeInspectionEnvelopeV1,
		};
	}
	return (await decodeCloudflareSupplementalRuntimeTransportEnvelopeV1(
		snapshot,
		false,
	)) as CloudflareValidatedRuntimeInspectionTransportV1;
}

export async function decodeCloudflareRecoveryFreezePlanV1(input: unknown): Promise<RuntimeRecoveryFreezePlan> {
	const snapshot = strictJsonSnapshotV1(input);
	const plan = strictProtocolRecordV1(snapshot, ["locator", "canonicalCommitId", "requests"]);
	const locator = strictProtocolRecordV1(plan.locator, [
		"recoveryFreezeId",
		"replica",
		"leaseId",
		"fenceId",
		"baseGeneration",
		"checkpointId",
	]);
	requiredIdentityV1(locator.recoveryFreezeId);
	assertReplicaV1(locator.replica);
	requiredIdentityV1(locator.leaseId);
	requiredIdentityV1(locator.fenceId);
	requiredIntegerV1(locator.baseGeneration);
	requiredIdentityV1(locator.checkpointId);
	requiredIdentityV1(plan.canonicalCommitId);
	const requests = strictProtocolRecordV1(plan.requests, ["freeze", "checkpointAcknowledgement", "release"]);
	const freeze = strictProtocolRecordV1(requests.freeze, ["requestId", "requestSha256"]);
	assertRequestIdentityV1(freeze);
	const acknowledgement = strictProtocolRecordV1(requests.checkpointAcknowledgement, [
		"requestId",
		"parentOperationId",
	]);
	requiredSha256V1(acknowledgement.requestId);
	const recoveryFreezeId = requiredIdentityV1(locator.recoveryFreezeId);
	if (requiredIdentityV1(acknowledgement.parentOperationId) !== recoveryFreezeId) {
		protocolFailure("request_identity_mismatch");
	}
	const release = strictProtocolRecordV1(requests.release, ["requestId", "requestSha256", "parentOperationId"]);
	assertRequestIdentityV1(release);
	if (requiredIdentityV1(release.parentOperationId) !== recoveryFreezeId) {
		protocolFailure("request_identity_mismatch");
	}
	const replica = locator.replica as Record<string, StrictJsonValueV1>;
	const workspaceId = requiredIdentityV1(replica.workspaceId);
	const expectedFreezeId = await deriveCloudflareProviderSubrequestIdV1({
		workspaceId,
		parentKind: "runtime_transition",
		parentId: recoveryFreezeId,
		ordinal: 4,
		operation: "recovery_freeze",
	});
	const expectedAcknowledgementId = await deriveCloudflareProviderSubrequestIdV1({
		workspaceId,
		parentKind: "runtime_transition",
		parentId: recoveryFreezeId,
		ordinal: 5,
		operation: "checkpoint_acknowledgement",
	});
	const expectedReleaseId = await deriveCloudflareProviderSubrequestIdV1({
		workspaceId,
		parentKind: "runtime_transition",
		parentId: recoveryFreezeId,
		ordinal: 6,
		operation: "release",
	});
	if (
		freeze.requestId !== expectedFreezeId ||
		acknowledgement.requestId !== expectedAcknowledgementId ||
		release.requestId !== expectedReleaseId
	) {
		protocolFailure("request_identity_mismatch");
	}
	const freezeTuple: readonly CanonicalRuntimeValueV1[] = [
		"omp-runtime-provider-v1",
		"recovery_freeze",
		recoveryFreezeId,
		replica.providerId as string,
		replica.profileId as string,
		workspaceId,
		replica.replicaId as string,
		locator.leaseId as string,
		locator.fenceId as string,
		locator.baseGeneration as number,
		locator.checkpointId as string,
	];
	if ((await canonicalRuntimeSha256V1(freezeTuple)) !== freeze.requestSha256) {
		protocolFailure("request_digest_mismatch");
	}
	const releaseInspection: RuntimeCanonicalProviderInspectionV1 = {
		operation: "release",
		request: {
			requestId: release.requestId,
			requestSha256: release.requestSha256,
			parentOperationId: recoveryFreezeId,
			replica: locator.replica,
			leaseId: locator.leaseId,
		} as unknown as RuntimeLeaseReleaseInspectRequest,
	};
	if (
		(await canonicalRuntimeSha256V1(projectCloudflareRuntimeInspectionTupleV1(releaseInspection))) !==
		release.requestSha256
	) {
		protocolFailure("request_digest_mismatch");
	}
	return snapshot as unknown as RuntimeRecoveryFreezePlan;
}

export const CLOUDFLARE_WORKSPACE_RETENTION_MS_DEFAULT_V1 = 3_600_000 as const;
export const CLOUDFLARE_ALARM_BATCH_LIMIT_V1 = 100 as const;
export const CLOUDFLARE_RETENTION_RETRY_MS_V1 = 60_000 as const;

interface CloudflareDurableDeadlineBaseV1 {
	readonly schemaVersion: 1;
	readonly dueAtEpochMs: number;
	readonly attempt: number;
	readonly updatedAtEpochMs: number;
}

export interface CloudflareWorkspaceRetentionDeferralV1 {
	readonly reason:
		| "not_released"
		| "active_compute"
		| "compute_ambiguous"
		| "checkpoint_unacknowledged"
		| "command_or_sync_ambiguous";
	readonly observedAtEpochMs: number;
	readonly nextAttemptAtEpochMs: number;
}

export type CloudflareDurableDeadlineV1 =
	| (CloudflareDurableDeadlineBaseV1 & { readonly kind: "sync_retry"; readonly key: string })
	| (CloudflareDurableDeadlineBaseV1 & { readonly kind: "runtime_expiry"; readonly key: string })
	| (CloudflareDurableDeadlineBaseV1 & {
			readonly kind: "workspace_retention";
			readonly key: string;
			readonly eviction: RuntimeReplicaCacheEvictionPlan;
			readonly acceptedAtEpochMs: number;
			readonly lastDeferral: CloudflareWorkspaceRetentionDeferralV1 | null;
	  });

export interface CloudflareDeadlineSummaryV1 {
	readonly earliestDueAtEpochMs: number | null;
	readonly counts: Readonly<Record<CloudflareDurableDeadlineKind, number>>;
}

export type CloudflarePhysicalAlarmDirectiveV1 =
	| { readonly action: "delete" }
	| { readonly action: "set"; readonly atEpochMs: number };

function checkedEpochAdditionV1(epochMs: number, durationMs: number): number {
	const result = epochMs + durationMs;
	if (!Number.isSafeInteger(result) || result < 0) protocolFailure("invalid_timestamp");
	return result;
}

function assertCacheEvictionPlanFieldsV1(
	value: StrictJsonValueV1,
	expectedWorkspaceRetentionMs?: number,
): Record<string, StrictJsonValueV1> {
	const plan = strictProtocolRecordV1(value, [
		"requestId",
		"requestSha256",
		"requestedByOperationId",
		"replica",
		"mode",
		"delayMs",
		"plannedAt",
		"retentionDeadline",
	]);
	assertRequestIdentityV1(plan);
	requiredIdentityV1(plan.requestedByOperationId);
	assertReplicaV1(plan.replica);
	const mode = requiredLiteralV1(plan.mode, ["explicit", "workspace_retention"] as const);
	const delayMs = requiredIntegerV1(plan.delayMs);
	if (mode === "explicit") {
		if (delayMs !== 0) protocolFailure("retention_deadline_mismatch");
	} else {
		if (delayMs < 1 || (expectedWorkspaceRetentionMs !== undefined && delayMs !== expectedWorkspaceRetentionMs)) {
			protocolFailure("retention_deadline_mismatch");
		}
	}
	const plannedAt = Date.parse(requiredIso8601V1(plan.plannedAt));
	const retentionDeadline = Date.parse(requiredIso8601V1(plan.retentionDeadline));
	if (checkedEpochAdditionV1(plannedAt, delayMs) !== retentionDeadline) {
		protocolFailure("retention_deadline_mismatch");
	}
	return plan;
}

export function projectCloudflareReplicaCacheEvictionTupleV1(
	plan: RuntimeReplicaCacheEvictionPlan,
): readonly CanonicalRuntimeValueV1[] {
	return [
		"omp-runtime-provider-v1",
		"replica_cache_evict",
		plan.requestedByOperationId,
		plan.replica.providerId,
		plan.replica.profileId,
		plan.replica.workspaceId,
		plan.replica.replicaId,
		plan.mode,
		plan.delayMs,
		plan.plannedAt,
		plan.retentionDeadline,
	];
}

export async function decodeCloudflareReplicaCacheEvictionPlanV1(
	input: unknown,
	options: { readonly workspaceRetentionMs?: number } = {},
): Promise<RuntimeReplicaCacheEvictionPlan> {
	const snapshot = strictJsonSnapshotV1(input);
	const plan = assertCacheEvictionPlanFieldsV1(snapshot, options.workspaceRetentionMs);
	const decoded = plan as unknown as RuntimeReplicaCacheEvictionPlan;
	if ((await canonicalRuntimeSha256V1(projectCloudflareReplicaCacheEvictionTupleV1(decoded))) !== plan.requestSha256) {
		protocolFailure("request_digest_mismatch");
	}
	return decoded;
}

function assertCacheEvictionEchoV1(
	value: StrictJsonValueV1,
	keys: readonly string[],
	plan: RuntimeReplicaCacheEvictionPlan,
): Record<string, StrictJsonValueV1> {
	const echo = strictProtocolRecordV1(value, keys);
	if (
		requiredSha256V1(echo.requestId) !== plan.requestId ||
		requiredSha256V1(echo.requestSha256) !== plan.requestSha256
	) {
		protocolFailure("request_identity_mismatch");
	}
	assertReplicaV1(echo.replica);
	if (!equalStrictJsonV1(echo.replica, plan.replica)) protocolFailure("request_identity_mismatch");
	return echo;
}

function assertCacheEvictionAcceptanceV1(
	value: StrictJsonValueV1,
	plan: RuntimeReplicaCacheEvictionPlan,
): Record<string, StrictJsonValueV1> {
	const acceptance = assertCacheEvictionEchoV1(
		value,
		["requestId", "requestSha256", "replica", "retentionDeadline", "acceptedAt"],
		plan,
	);
	if (requiredIso8601V1(acceptance.retentionDeadline) !== plan.retentionDeadline) {
		protocolFailure("retention_deadline_mismatch");
	}
	requiredIso8601V1(acceptance.acceptedAt);
	return acceptance;
}

export async function decodeCloudflareReplicaCacheEvictionAcceptanceV1(
	input: unknown,
	planInput: unknown,
	options: { readonly workspaceRetentionMs?: number } = {},
): Promise<RuntimeReplicaCacheEvictionAcceptance> {
	const plan = await decodeCloudflareReplicaCacheEvictionPlanV1(planInput, options);
	const snapshot = strictJsonSnapshotV1(input);
	assertCacheEvictionAcceptanceV1(snapshot, plan);
	return snapshot as unknown as RuntimeReplicaCacheEvictionAcceptance;
}

export async function decodeCloudflareReplicaCacheEvictionRequestResultV1(
	input: unknown,
	planInput: unknown,
	options: { readonly workspaceRetentionMs?: number } = {},
): Promise<RuntimeReplicaCacheEvictionRequestResult> {
	const plan = await decodeCloudflareReplicaCacheEvictionPlanV1(planInput, options);
	const snapshot = strictJsonSnapshotV1(input);
	if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot))
		protocolFailure("provider_response_invalid");
	const status = requiredLiteralV1(
		(snapshot as Record<string, StrictJsonValueV1>).status,
		["accepted", "already_accepted", "acceptance_pending", "rejected", "deadline_mismatch", "complete"] as const,
		"provider_response_invalid",
	);
	if (status === "accepted" || status === "already_accepted") {
		const result = strictProtocolRecordV1(snapshot, ["status", "acceptance"]);
		assertCacheEvictionAcceptanceV1(result.acceptance, plan);
	} else if (status === "acceptance_pending") {
		const result = strictProtocolRecordV1(snapshot, ["status", "pending"]);
		const pending = assertCacheEvictionEchoV1(
			result.pending,
			["requestId", "requestSha256", "replica", "retentionDeadline", "observedAt"],
			plan,
		);
		if (requiredIso8601V1(pending.retentionDeadline) !== plan.retentionDeadline) {
			protocolFailure("retention_deadline_mismatch");
		}
		requiredIso8601V1(pending.observedAt);
	} else if (status === "rejected") {
		const result = strictProtocolRecordV1(snapshot, ["status", "rejection"]);
		const rejection = assertCacheEvictionEchoV1(
			result.rejection,
			["requestId", "requestSha256", "replica", "retentionDeadline", "code", "observedAt"],
			plan,
		);
		if (requiredIso8601V1(rejection.retentionDeadline) !== plan.retentionDeadline) {
			protocolFailure("retention_deadline_mismatch");
		}
		requiredLiteralV1(rejection.code, ["provider_request_rejected"] as const);
		requiredIso8601V1(rejection.observedAt);
	} else if (status === "deadline_mismatch") {
		const result = strictProtocolRecordV1(snapshot, ["status", "mismatch"]);
		const mismatch = assertCacheEvictionEchoV1(
			result.mismatch,
			[
				"requestId",
				"requestSha256",
				"replica",
				"plannedRetentionDeadline",
				"providerRetentionDeadline",
				"observedAt",
			],
			plan,
		);
		if (requiredIso8601V1(mismatch.plannedRetentionDeadline) !== plan.retentionDeadline) {
			protocolFailure("retention_deadline_mismatch");
		}
		requiredIso8601V1(mismatch.providerRetentionDeadline);
		requiredIso8601V1(mismatch.observedAt);
	} else {
		const result = strictProtocolRecordV1(snapshot, ["status", "result"]);
		const completion = strictProtocolRecordV1(result.result, [
			"acceptance",
			"outcome",
			"completedAt",
			"receiptSha256",
		]);
		assertCacheEvictionAcceptanceV1(completion.acceptance, plan);
		requiredLiteralV1(completion.outcome, ["evicted", "already_evicted", "absent"] as const);
		requiredIso8601V1(completion.completedAt);
		requiredSha256RefV1(completion.receiptSha256);
	}
	return snapshot as unknown as RuntimeReplicaCacheEvictionRequestResult;
}

export async function decodeCloudflareReplicaCacheEvictionInspectResultV1(
	input: unknown,
	planInput: unknown,
	options: { readonly workspaceRetentionMs?: number } = {},
): Promise<RuntimeReplicaCacheEvictionInspectResult> {
	const plan = await decodeCloudflareReplicaCacheEvictionPlanV1(planInput, options);
	const snapshot = strictJsonSnapshotV1(input);
	if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot))
		protocolFailure("provider_response_invalid");
	const status = requiredLiteralV1(
		(snapshot as Record<string, StrictJsonValueV1>).status,
		[
			"not_started",
			"acceptance_pending",
			"accepted",
			"deferred",
			"rejected",
			"deadline_mismatch",
			"complete",
		] as const,
		"provider_response_invalid",
	);
	if (status === "not_started") {
		const result = assertCacheEvictionEchoV1(
			snapshot,
			["status", "requestId", "requestSha256", "replica", "retentionDeadline", "observedAt"],
			plan,
		);
		if (requiredIso8601V1(result.retentionDeadline) !== plan.retentionDeadline) {
			protocolFailure("retention_deadline_mismatch");
		}
		requiredIso8601V1(result.observedAt);
	} else if (status === "accepted") {
		const result = strictProtocolRecordV1(snapshot, ["status", "acceptance"]);
		assertCacheEvictionAcceptanceV1(result.acceptance, plan);
	} else if (status === "deferred") {
		const result = strictProtocolRecordV1(snapshot, [
			"status",
			"acceptance",
			"reason",
			"nextAttemptAt",
			"observedAt",
		]);
		assertCacheEvictionAcceptanceV1(result.acceptance, plan);
		requiredLiteralV1(result.reason, [
			"not_released",
			"active_compute",
			"compute_ambiguous",
			"checkpoint_unacknowledged",
			"command_or_sync_ambiguous",
		] as const);
		requiredIso8601V1(result.nextAttemptAt);
		requiredIso8601V1(result.observedAt);
	} else {
		const resultStatus = status === "acceptance_pending" ? "acceptance_pending" : status;
		const requestResult =
			resultStatus === "acceptance_pending"
				? { status: "acceptance_pending", pending: (snapshot as Record<string, StrictJsonValueV1>).pending }
				: snapshot;
		await decodeCloudflareReplicaCacheEvictionRequestResultV1(requestResult, plan, options);
	}
	return snapshot as unknown as RuntimeReplicaCacheEvictionInspectResult;
}

export async function decodeCloudflareDurableDeadlineV1(
	input: unknown,
	options: { readonly workspaceRetentionMs?: number } = {},
): Promise<CloudflareDurableDeadlineV1> {
	const snapshot = strictJsonSnapshotV1(input);
	if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot))
		protocolFailure("deadline_invalid");
	const kind = requiredLiteralV1(
		(snapshot as Record<string, StrictJsonValueV1>).kind,
		["sync_retry", "runtime_expiry", "workspace_retention"] as const,
		"deadline_invalid",
	);
	const keys =
		kind === "workspace_retention"
			? [
					"schemaVersion",
					"dueAtEpochMs",
					"attempt",
					"updatedAtEpochMs",
					"kind",
					"key",
					"eviction",
					"acceptedAtEpochMs",
					"lastDeferral",
				]
			: ["schemaVersion", "dueAtEpochMs", "attempt", "updatedAtEpochMs", "kind", "key"];
	const row = strictProtocolRecordV1(snapshot, keys);
	requiredLiteralV1(row.schemaVersion, [1] as const, "deadline_invalid");
	const dueAt = requiredIntegerV1(row.dueAtEpochMs);
	const attempt = requiredIntegerV1(row.attempt);
	const updatedAt = requiredIntegerV1(row.updatedAtEpochMs);
	requiredIdentityV1(row.key);
	if (kind === "workspace_retention") {
		const eviction = await decodeCloudflareReplicaCacheEvictionPlanV1(row.eviction, options);
		if (row.key !== eviction.requestId) protocolFailure("deadline_invalid");
		const acceptedAt = requiredIntegerV1(row.acceptedAtEpochMs);
		if (attempt === 0) {
			if (
				row.lastDeferral !== null ||
				dueAt !== Date.parse(eviction.retentionDeadline) ||
				updatedAt !== acceptedAt
			) {
				protocolFailure("deadline_invalid");
			}
		} else {
			const deferral = strictProtocolRecordV1(row.lastDeferral, [
				"reason",
				"observedAtEpochMs",
				"nextAttemptAtEpochMs",
			]);
			requiredLiteralV1(
				deferral.reason,
				[
					"not_released",
					"active_compute",
					"compute_ambiguous",
					"checkpoint_unacknowledged",
					"command_or_sync_ambiguous",
				] as const,
				"deadline_invalid",
			);
			const observed = requiredIntegerV1(deferral.observedAtEpochMs);
			const next = requiredIntegerV1(deferral.nextAttemptAtEpochMs);
			if (
				updatedAt !== observed ||
				dueAt !== next ||
				checkedEpochAdditionV1(observed, CLOUDFLARE_RETENTION_RETRY_MS_V1) !== next
			) {
				protocolFailure("deadline_invalid");
			}
		}
	}
	return snapshot as unknown as CloudflareDurableDeadlineV1;
}

const DEADLINE_KIND_PRIORITY_V1: Readonly<Record<CloudflareDurableDeadlineKind, number>> = Object.freeze({
	runtime_expiry: 0,
	sync_retry: 1,
	workspace_retention: 2,
});

export function compareCloudflareDurableDeadlinesV1(
	left: CloudflareDurableDeadlineV1,
	right: CloudflareDurableDeadlineV1,
): number {
	return (
		left.dueAtEpochMs - right.dueAtEpochMs ||
		DEADLINE_KIND_PRIORITY_V1[left.kind] - DEADLINE_KIND_PRIORITY_V1[right.kind] ||
		compareUtf8(left.key, right.key)
	);
}

export function summarizeCloudflareDurableDeadlinesV1(
	deadlines: readonly CloudflareDurableDeadlineV1[],
): CloudflareDeadlineSummaryV1 {
	const counts: Record<CloudflareDurableDeadlineKind, number> = {
		sync_retry: 0,
		runtime_expiry: 0,
		workspace_retention: 0,
	};
	let earliestDueAtEpochMs: number | null = null;
	for (const deadline of deadlines) {
		counts[deadline.kind] += 1;
		if (earliestDueAtEpochMs === null || deadline.dueAtEpochMs < earliestDueAtEpochMs) {
			earliestDueAtEpochMs = deadline.dueAtEpochMs;
		}
	}
	return { earliestDueAtEpochMs, counts };
}

export function selectDueCloudflareDurableDeadlinesV1(
	deadlines: readonly CloudflareDurableDeadlineV1[],
	nowEpochMs: number,
): readonly CloudflareDurableDeadlineV1[] {
	requiredIntegerV1(nowEpochMs);
	return deadlines
		.filter(deadline => deadline.dueAtEpochMs <= nowEpochMs)
		.sort(compareCloudflareDurableDeadlinesV1)
		.slice(0, CLOUDFLARE_ALARM_BATCH_LIMIT_V1);
}

export function rearmCloudflarePhysicalAlarmV1(
	deadlines: readonly CloudflareDurableDeadlineV1[],
	nowEpochMs: number,
): CloudflarePhysicalAlarmDirectiveV1 {
	requiredIntegerV1(nowEpochMs);
	const summary = summarizeCloudflareDurableDeadlinesV1(deadlines);
	if (summary.earliestDueAtEpochMs === null) return { action: "delete" };
	return { action: "set", atEpochMs: Math.max(nowEpochMs, summary.earliestDueAtEpochMs) };
}

export function deferCloudflareWorkspaceRetentionDeadlineV1(
	deadline: Extract<CloudflareDurableDeadlineV1, { readonly kind: "workspace_retention" }>,
	reason: CloudflareWorkspaceRetentionDeferralV1["reason"],
	nowEpochMs: number,
): Extract<CloudflareDurableDeadlineV1, { readonly kind: "workspace_retention" }> {
	requiredIntegerV1(nowEpochMs);
	const nextAttemptAtEpochMs = checkedEpochAdditionV1(nowEpochMs, CLOUDFLARE_RETENTION_RETRY_MS_V1);
	const nextAttempt = checkedEpochAdditionV1(deadline.attempt, 1);
	return {
		...deadline,
		attempt: nextAttempt,
		updatedAtEpochMs: nowEpochMs,
		dueAtEpochMs: nextAttemptAtEpochMs,
		lastDeferral: { reason, observedAtEpochMs: nowEpochMs, nextAttemptAtEpochMs },
	};
}

const PERSISTENT_DELETION_GRACE_MAX_V1 = 2_147_483_647;

function workspaceCheckpointTupleV1(checkpoint: WorkspaceCheckpoint): readonly CanonicalRuntimeValueV1[] {
	return [
		checkpoint.workspaceId,
		checkpoint.generation,
		checkpoint.rootSha256,
		checkpoint.fileCount,
		checkpoint.byteCount,
		checkpoint.committedAt,
	];
}

function replicaTupleV1(replica: RuntimeReplicaRef): readonly CanonicalRuntimeValueV1[] {
	return [replica.providerId, replica.profileId, replica.replicaId, replica.workspaceId];
}

function compareReplicaRecordsV1(
	left: Record<string, StrictJsonValueV1>,
	right: Record<string, StrictJsonValueV1>,
): number {
	for (const key of ["providerId", "profileId", "replicaId"] as const) {
		const compared = compareUtf8(left[key] as string, right[key] as string);
		if (compared !== 0) return compared;
	}
	return 0;
}

function assertWorkspaceTombstoneV1(value: StrictJsonValueV1): Record<string, StrictJsonValueV1> {
	const tombstone = strictProtocolRecordV1(value, [
		"workspaceId",
		"deleteId",
		"deletionAuthorityId",
		"quarantineId",
		"deletedAt",
		"lastCheckpoint",
		"purgeAfter",
	]);
	const workspaceId = requiredIdentityV1(tombstone.workspaceId);
	const deleteId = requiredIdentityV1(tombstone.deleteId);
	const deletionAuthorityId = requiredIdentityV1(tombstone.deletionAuthorityId);
	const quarantineId = requiredIdentityV1(tombstone.quarantineId);
	if (new Set([deleteId, deletionAuthorityId, quarantineId]).size !== 3) protocolFailure("invalid_identity");
	const deletedAt = Date.parse(requiredIso8601V1(tombstone.deletedAt));
	assertWorkspaceCheckpointV1(tombstone.lastCheckpoint);
	const checkpoint = tombstone.lastCheckpoint as Record<string, StrictJsonValueV1>;
	if (checkpoint.workspaceId !== workspaceId) protocolFailure("checkpoint_mismatch");
	const purgeAfter = Date.parse(requiredIso8601V1(tombstone.purgeAfter));
	if (purgeAfter < deletedAt) protocolFailure("invalid_timestamp");
	return tombstone;
}

function assertDeletionPlanCoreV1(value: StrictJsonValueV1): Record<string, StrictJsonValueV1> {
	const core = strictProtocolRecordV1(value, [
		"deleteId",
		"deletionAuthorityId",
		"quarantineId",
		"workspaceId",
		"expectedCheckpoint",
		"expectedRuntimeAttachmentCreateId",
		"expectedRuntimeAttachmentRevision",
		"expectedKnownReplicaCatalogRevision",
		"plannedDeletionAt",
		"deletedBytesGraceMs",
		"purgeAfter",
		"replicaRequests",
	]);
	const deleteId = requiredIdentityV1(core.deleteId);
	const deletionAuthorityId = requiredIdentityV1(core.deletionAuthorityId);
	const quarantineId = requiredIdentityV1(core.quarantineId);
	if (new Set([deleteId, deletionAuthorityId, quarantineId]).size !== 3) {
		protocolFailure("invalid_identity");
	}
	const workspaceId = requiredIdentityV1(core.workspaceId);
	assertWorkspaceCheckpointV1(core.expectedCheckpoint);
	const checkpoint = core.expectedCheckpoint as Record<string, StrictJsonValueV1>;
	if (checkpoint.workspaceId !== workspaceId) protocolFailure("checkpoint_mismatch");
	requiredIdentityV1(core.expectedRuntimeAttachmentCreateId);
	requiredIntegerV1(core.expectedRuntimeAttachmentRevision);
	requiredIntegerV1(core.expectedKnownReplicaCatalogRevision);
	const plannedAt = Date.parse(requiredIso8601V1(core.plannedDeletionAt));
	const graceMs = requiredIntegerV1(core.deletedBytesGraceMs);
	if (graceMs > PERSISTENT_DELETION_GRACE_MAX_V1) protocolFailure("invalid_integer");
	const purgeAfter = Date.parse(requiredIso8601V1(core.purgeAfter));
	if (checkedEpochAdditionV1(plannedAt, graceMs) !== purgeAfter) protocolFailure("tombstone_mismatch");
	const requests = requiredArrayV1(core.replicaRequests);
	let previous: Record<string, StrictJsonValueV1> | null = null;
	for (const requestValue of requests) {
		const request = strictProtocolRecordV1(requestValue, ["replica", "deletionAuthorityDomain", "requestId"]);
		assertReplicaV1(request.replica);
		requiredLiteralV1(request.deletionAuthorityDomain, ["persistent"] as const);
		requiredSha256V1(request.requestId);
		const replica = request.replica as Record<string, StrictJsonValueV1>;
		if (replica.workspaceId !== workspaceId) protocolFailure("request_identity_mismatch");
		if (previous !== null && compareReplicaRecordsV1(previous, replica) >= 0) protocolFailure("invalid_shape");
		previous = replica;
	}
	return core;
}

export function deriveCloudflareWorkspaceTombstoneV1(core: WorkspaceDeletionPlanCoreV1): WorkspaceTombstone {
	return {
		workspaceId: core.workspaceId,
		deleteId: core.deleteId,
		deletionAuthorityId: core.deletionAuthorityId,
		quarantineId: core.quarantineId,
		deletedAt: core.plannedDeletionAt,
		lastCheckpoint: core.expectedCheckpoint,
		purgeAfter: core.purgeAfter,
	};
}

export function projectCloudflareDeletionPlanCoreTupleV1(
	core: WorkspaceDeletionPlanCoreV1,
): readonly CanonicalRuntimeValueV1[] {
	return [
		"omp-workspace-deletion-plan-core-v1",
		core.deleteId,
		core.deletionAuthorityId,
		core.quarantineId,
		core.workspaceId,
		workspaceCheckpointTupleV1(core.expectedCheckpoint),
		core.expectedRuntimeAttachmentCreateId,
		core.expectedRuntimeAttachmentRevision,
		core.expectedKnownReplicaCatalogRevision,
		core.plannedDeletionAt,
		core.deletedBytesGraceMs,
		core.purgeAfter,
		core.replicaRequests.map(request => [
			...replicaTupleV1(request.replica),
			request.deletionAuthorityDomain,
			request.requestId,
		]),
	];
}

export function projectCloudflarePersistentReplicaDeleteTupleV1(input: {
	readonly requestId: string;
	readonly replica: RuntimeReplicaRef;
	readonly deletionPlanCoreSha256: string;
	readonly tombstone: WorkspaceTombstone;
}): readonly CanonicalRuntimeValueV1[] {
	return [
		"omp-runtime-provider-v1",
		"replica_delete",
		"persistent",
		input.requestId,
		input.replica.providerId,
		input.replica.profileId,
		input.replica.workspaceId,
		input.replica.replicaId,
		input.deletionPlanCoreSha256,
		[
			input.tombstone.workspaceId,
			input.tombstone.deleteId,
			input.tombstone.deletionAuthorityId,
			input.tombstone.quarantineId,
			input.tombstone.deletedAt,
			workspaceCheckpointTupleV1(input.tombstone.lastCheckpoint),
			input.tombstone.purgeAfter,
		],
	];
}

export function projectCloudflareDeletionPlanTupleV1(
	deletion: WorkspaceDeletionPlanV1,
): readonly CanonicalRuntimeValueV1[] {
	return [
		"omp-workspace-deletion-plan-v1",
		projectCloudflareDeletionPlanCoreTupleV1(deletion.core),
		deletion.replicaRequests.map(request => [
			...replicaTupleV1(request.replica),
			request.deletionAuthorityDomain,
			request.request.requestId,
			request.request.requestSha256,
		]),
	];
}

export function projectCloudflareTransientReplicaDeleteTupleV1(input: {
	readonly replica: RuntimeReplicaRef;
	readonly authorization: Extract<RuntimeReplicaDeletionAuthorizationV1, { readonly domain: "transient_task" }>;
}): readonly CanonicalRuntimeValueV1[] {
	const { replica, authorization } = input;
	return [
		"omp-runtime-provider-v1",
		"replica_delete",
		"transient_task",
		replica.providerId,
		replica.profileId,
		replica.workspaceId,
		replica.replicaId,
		authorization.taskId,
		authorization.runId,
		authorization.workspaceId,
		authorization.cleanupId,
		authorization.cleanupAuthorityId,
		authorization.cleanupPlanSha256,
		workspaceCheckpointTupleV1(authorization.finalCheckpoint),
		authorization.replicaDeleteRequestId,
		authorization.replicaDeletionQuarantineId,
		authorization.replicaDeletionPlannedAt,
		authorization.replicaDeletionPurgeAfter,
	];
}

export function projectCloudflareReplicaDeleteReceiptTupleV1(
	request: Omit<RuntimeReplicaDeleteRequest, "signal">,
): readonly CanonicalRuntimeValueV1[] {
	const purgeAfter =
		request.authorization.domain === "persistent"
			? request.authorization.tombstone.purgeAfter
			: request.authorization.replicaDeletionPurgeAfter;
	return [
		"omp-cloudflare-replica-delete-receipt-v1",
		request.requestId,
		request.requestSha256,
		request.replica.workspaceId,
		request.replica.replicaId,
		purgeAfter,
	];
}

async function validatePersistentDeletionAuthorizationV1(
	authorizationValue: StrictJsonValueV1,
	outerRequest: Record<string, StrictJsonValueV1>,
): Promise<void> {
	const authorization = strictProtocolRecordV1(authorizationValue, [
		"domain",
		"deletion",
		"deletionPlanCoreSha256",
		"deletionPlanSha256",
		"tombstone",
	]);
	requiredLiteralV1(authorization.domain, ["persistent"] as const);
	const deletion = strictProtocolRecordV1(authorization.deletion, ["core", "replicaRequests"]);
	const core = assertDeletionPlanCoreV1(deletion.core);
	const coreTyped = core as unknown as WorkspaceDeletionPlanCoreV1;
	const receivedCoreDigest = requiredSha256RefV1(authorization.deletionPlanCoreSha256);
	const expectedCoreDigest = `sha256:${await canonicalRuntimeSha256V1(projectCloudflareDeletionPlanCoreTupleV1(coreTyped))}`;
	if (receivedCoreDigest !== expectedCoreDigest) protocolFailure("deletion_plan_core_digest_mismatch");
	const expectedTombstone = deriveCloudflareWorkspaceTombstoneV1(coreTyped);
	assertWorkspaceTombstoneV1(authorization.tombstone);
	if (!equalStrictJsonV1(authorization.tombstone, expectedTombstone)) protocolFailure("tombstone_mismatch");
	const coreRequests = requiredArrayV1(core.replicaRequests);
	const finalRequests = requiredArrayV1(deletion.replicaRequests);
	if (coreRequests.length !== finalRequests.length) protocolFailure("invalid_shape");
	let selected = false;
	for (let index = 0; index < finalRequests.length; index += 1) {
		const coreRequest = coreRequests[index] as Record<string, StrictJsonValueV1>;
		const finalRequest = strictProtocolRecordV1(finalRequests[index]!, [
			"replica",
			"deletionAuthorityDomain",
			"request",
		]);
		assertReplicaV1(finalRequest.replica);
		requiredLiteralV1(finalRequest.deletionAuthorityDomain, ["persistent"] as const);
		const requestIdentity = strictProtocolRecordV1(finalRequest.request, ["requestId", "requestSha256"]);
		assertRequestIdentityV1(requestIdentity);
		if (
			!equalStrictJsonV1(finalRequest.replica, coreRequest.replica) ||
			finalRequest.deletionAuthorityDomain !== coreRequest.deletionAuthorityDomain ||
			requestIdentity.requestId !== coreRequest.requestId
		) {
			protocolFailure("request_identity_mismatch");
		}
		const expectedRequestDigest = await canonicalRuntimeSha256V1(
			projectCloudflarePersistentReplicaDeleteTupleV1({
				requestId: requestIdentity.requestId as string,
				replica: finalRequest.replica as unknown as RuntimeReplicaRef,
				deletionPlanCoreSha256: receivedCoreDigest,
				tombstone: expectedTombstone,
			}),
		);
		if (requestIdentity.requestSha256 !== expectedRequestDigest) {
			protocolFailure("deletion_request_digest_mismatch");
		}
		if (
			outerRequest.requestId === requestIdentity.requestId &&
			equalStrictJsonV1(outerRequest.replica, finalRequest.replica)
		) {
			selected = true;
			if (outerRequest.requestSha256 !== requestIdentity.requestSha256) {
				protocolFailure("deletion_request_digest_mismatch");
			}
		}
	}
	if (!selected) protocolFailure("request_identity_mismatch");
	const deletionTyped = deletion as unknown as WorkspaceDeletionPlanV1;
	const expectedPlanDigest = `sha256:${await canonicalRuntimeSha256V1(projectCloudflareDeletionPlanTupleV1(deletionTyped))}`;
	if (requiredSha256RefV1(authorization.deletionPlanSha256) !== expectedPlanDigest) {
		protocolFailure("deletion_plan_digest_mismatch");
	}
}

async function validateTransientDeletionAuthorizationV1(
	authorizationValue: StrictJsonValueV1,
	outerRequest: Record<string, StrictJsonValueV1>,
): Promise<void> {
	const authorization = strictProtocolRecordV1(authorizationValue, [
		"domain",
		"taskId",
		"runId",
		"workspaceId",
		"cleanupId",
		"cleanupAuthorityId",
		"cleanupPlanSha256",
		"finalCheckpoint",
		"replicaDeleteRequestId",
		"replicaDeletionQuarantineId",
		"replicaDeletionPlannedAt",
		"replicaDeletionPurgeAfter",
	]);
	requiredLiteralV1(authorization.domain, ["transient_task"] as const);
	requiredIdentityV1(authorization.taskId);
	requiredIdentityV1(authorization.runId);
	const workspaceId = requiredIdentityV1(authorization.workspaceId);
	const cleanupId = requiredIdentityV1(authorization.cleanupId);
	const cleanupAuthorityId = requiredIdentityV1(authorization.cleanupAuthorityId);
	const quarantineId = requiredIdentityV1(authorization.replicaDeletionQuarantineId);
	if (new Set([cleanupId, cleanupAuthorityId, quarantineId]).size !== 3) protocolFailure("invalid_identity");
	requiredSha256RefV1(authorization.cleanupPlanSha256);
	assertWorkspaceCheckpointV1(authorization.finalCheckpoint);
	const checkpoint = authorization.finalCheckpoint as Record<string, StrictJsonValueV1>;
	if (checkpoint.workspaceId !== workspaceId) protocolFailure("checkpoint_mismatch");
	if (requiredSha256V1(authorization.replicaDeleteRequestId) !== outerRequest.requestId) {
		protocolFailure("request_identity_mismatch");
	}
	const replica = outerRequest.replica as Record<string, StrictJsonValueV1>;
	if (replica.workspaceId !== workspaceId) protocolFailure("request_identity_mismatch");
	const plannedAt = Date.parse(requiredIso8601V1(authorization.replicaDeletionPlannedAt));
	const purgeAfter = Date.parse(requiredIso8601V1(authorization.replicaDeletionPurgeAfter));
	if (purgeAfter < plannedAt) protocolFailure("invalid_timestamp");
	const expectedDigest = await canonicalRuntimeSha256V1(
		projectCloudflareTransientReplicaDeleteTupleV1({
			replica: outerRequest.replica as unknown as RuntimeReplicaRef,
			authorization: authorization as unknown as Extract<
				RuntimeReplicaDeletionAuthorizationV1,
				{ readonly domain: "transient_task" }
			>,
		}),
	);
	if (outerRequest.requestSha256 !== expectedDigest) protocolFailure("deletion_request_digest_mismatch");
}

export interface CloudflareReplicaDeletionValidationV1 {
	readonly request: Omit<RuntimeReplicaDeleteRequest, "signal">;
	readonly authorizationDomain: RuntimeReplicaDeletionAuthorizationV1["domain"];
	readonly canonicalTupleUtf8: string;
	readonly requestSha256: string;
}

export async function decodeCloudflareReplicaDeleteRequestV1(
	input: unknown,
	expectedDomain?: RuntimeReplicaDeletionAuthorizationV1["domain"],
): Promise<CloudflareReplicaDeletionValidationV1> {
	const snapshot = strictJsonSnapshotV1(input);
	const request = strictProtocolRecordV1(snapshot, ["requestId", "requestSha256", "replica", "authorization"]);
	assertRequestIdentityV1(request);
	assertReplicaV1(request.replica);
	if (
		request.authorization === null ||
		typeof request.authorization !== "object" ||
		Array.isArray(request.authorization)
	) {
		protocolFailure("invalid_shape");
	}
	const authorizationDomain = requiredLiteralV1((request.authorization as Record<string, StrictJsonValueV1>).domain, [
		"persistent",
		"transient_task",
	] as const);
	if (expectedDomain !== undefined && authorizationDomain !== expectedDomain) {
		protocolFailure("deletion_authority_domain_mismatch");
	}
	if (authorizationDomain === "persistent") {
		await validatePersistentDeletionAuthorizationV1(request.authorization, request);
	} else {
		await validateTransientDeletionAuthorizationV1(request.authorization, request);
	}
	const typedRequest = snapshot as unknown as Omit<RuntimeReplicaDeleteRequest, "signal">;
	let tuple: readonly CanonicalRuntimeValueV1[];
	if (typedRequest.authorization.domain === "persistent") {
		tuple = projectCloudflarePersistentReplicaDeleteTupleV1({
			requestId: typedRequest.requestId,
			replica: typedRequest.replica,
			deletionPlanCoreSha256: typedRequest.authorization.deletionPlanCoreSha256,
			tombstone: typedRequest.authorization.tombstone,
		});
	} else {
		tuple = projectCloudflareTransientReplicaDeleteTupleV1({
			replica: typedRequest.replica,
			authorization: typedRequest.authorization,
		});
	}
	const requestSha256 = await canonicalRuntimeSha256V1(tuple);
	if (requestSha256 !== typedRequest.requestSha256) protocolFailure("deletion_request_digest_mismatch");
	return {
		request: typedRequest,
		authorizationDomain,
		canonicalTupleUtf8: new TextDecoder().decode(encodeCanonicalRuntimeTupleV1(tuple)),
		requestSha256,
	};
}

function assertReplicaDeletionResponseEchoV1(
	value: StrictJsonValueV1,
	request: Omit<RuntimeReplicaDeleteRequest, "signal">,
): Record<string, StrictJsonValueV1> {
	const response = strictProtocolRecordV1(value, [
		"status",
		"request",
		"replica",
		"authorization",
		"observedAt",
		"retryAfter",
		"receiptSha256",
	]);
	const identity = strictProtocolRecordV1(response.request, ["requestId", "requestSha256"]);
	if (identity.requestId !== request.requestId || identity.requestSha256 !== request.requestSha256) {
		protocolFailure("request_identity_mismatch");
	}
	assertReplicaV1(response.replica);
	if (
		!equalStrictJsonV1(response.replica, request.replica) ||
		!equalStrictJsonV1(response.authorization, request.authorization)
	) {
		protocolFailure("request_identity_mismatch");
	}
	requiredIso8601V1(response.observedAt);
	return response;
}

export async function decodeCloudflareReplicaDeleteResultV1(
	input: unknown,
	requestInput: unknown,
	expectedDomain?: RuntimeReplicaDeletionAuthorizationV1["domain"],
): Promise<RuntimeReplicaDeleteResult> {
	const validatedRequest = await decodeCloudflareReplicaDeleteRequestV1(requestInput, expectedDomain);
	const snapshot = strictJsonSnapshotV1(input);
	const response = assertReplicaDeletionResponseEchoV1(snapshot, validatedRequest.request);
	const status = requiredLiteralV1(
		response.status,
		["deleted", "already_deleted", "absent", "cleanup_pending"] as const,
		"provider_response_invalid",
	);
	if (status === "cleanup_pending") {
		if (response.retryAfter !== null) requiredIso8601V1(response.retryAfter);
		if (response.receiptSha256 !== null) protocolFailure("provider_response_invalid");
	} else {
		if (response.retryAfter !== null) protocolFailure("provider_response_invalid");
		const receiptSha256 = requiredSha256RefV1(response.receiptSha256);
		const expectedReceiptSha256 = `sha256:${await canonicalRuntimeSha256V1(projectCloudflareReplicaDeleteReceiptTupleV1(validatedRequest.request))}`;
		if (receiptSha256 !== expectedReceiptSha256) protocolFailure("provider_response_invalid");
	}
	return snapshot as unknown as RuntimeReplicaDeleteResult;
}

export async function decodeCloudflareReplicaDeleteInspectResultV1(
	input: unknown,
	requestInput: unknown,
	expectedDomain?: RuntimeReplicaDeletionAuthorizationV1["domain"],
): Promise<RuntimeReplicaDeleteInspectResult> {
	const validatedRequest = await decodeCloudflareReplicaDeleteRequestV1(requestInput, expectedDomain);
	const snapshot = strictJsonSnapshotV1(input);
	if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
		protocolFailure("provider_response_invalid");
	}
	const status = (snapshot as Record<string, StrictJsonValueV1>).status;
	if (status === "not_started") {
		const response = assertReplicaDeletionResponseEchoV1(snapshot, validatedRequest.request);
		if (response.retryAfter !== null || response.receiptSha256 !== null) {
			protocolFailure("provider_response_invalid");
		}
		return snapshot as unknown as RuntimeReplicaDeleteInspectResult;
	}
	return decodeCloudflareReplicaDeleteResultV1(snapshot, validatedRequest.request, expectedDomain);
}

export interface CloudflareRuntimeStatusRequestV1 {
	readonly schemaVersion: 1;
	readonly replica: RuntimeReplicaRef;
	readonly leaseId: string;
}

export interface CloudflareRuntimeStatusResponseV1 {
	readonly schemaVersion: 1;
	readonly observationSource: "durable_state_and_container_running_only";
	readonly containerRunning: boolean;
	readonly result: RuntimeInspectResult;
	readonly deadlines: CloudflareDeadlineSummaryV1;
}

export interface CloudflareCheckpointFetchRequestV1 {
	readonly schemaVersion: 1;
	readonly locator: FrozenReplicaCheckpointLocator;
}

export interface CloudflareCheckpointFetchResponseV1 {
	readonly schemaVersion: 1;
	readonly result: RuntimeCheckpointFetchResult;
}

function assertFrozenCheckpointLocatorV1(value: StrictJsonValueV1): Record<string, StrictJsonValueV1> {
	const locator = strictProtocolRecordV1(value, [
		"providerId",
		"profileId",
		"workspaceId",
		"replicaId",
		"leaseId",
		"checkpointId",
	]);
	for (const key of ["providerId", "profileId", "workspaceId", "replicaId", "leaseId", "checkpointId"] as const) {
		requiredIdentityV1(locator[key]);
	}
	return locator;
}

function assertDeadlineSummaryV1(value: StrictJsonValueV1): void {
	const summary = strictProtocolRecordV1(value, ["earliestDueAtEpochMs", "counts"]);
	if (summary.earliestDueAtEpochMs !== null) requiredIntegerV1(summary.earliestDueAtEpochMs);
	const counts = strictProtocolRecordV1(summary.counts, ["sync_retry", "runtime_expiry", "workspace_retention"]);
	requiredIntegerV1(counts.sync_retry);
	requiredIntegerV1(counts.runtime_expiry);
	requiredIntegerV1(counts.workspace_retention);
}

function assertRuntimeInspectResultV1(value: StrictJsonValueV1): void {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		protocolFailure("provider_response_invalid");
	const status = requiredLiteralV1(
		(value as Record<string, StrictJsonValueV1>).status,
		["absent", "tombstoned", "present"] as const,
		"provider_response_invalid",
	);
	if (status === "absent") {
		const result = strictProtocolRecordV1(value, ["status", "replica", "leaseId"]);
		assertReplicaV1(result.replica);
		requiredIdentityV1(result.leaseId);
		return;
	}
	if (status === "tombstoned") {
		const result = strictProtocolRecordV1(value, ["status", "tombstone"]);
		assertWorkspaceTombstoneV1(result.tombstone);
		return;
	}
	const result = strictProtocolRecordV1(value, [
		"status",
		"lease",
		"providerPhase",
		"compute",
		"activeCommands",
		"pendingSyncs",
		"replicaImage",
	]);
	assertLeaseV1(result.lease);
	requiredLiteralV1(result.providerPhase, [
		"reserved",
		"materializing",
		"ready",
		"quiescing",
		"recovery_freezing",
		"quiesced",
		"revoked",
		"released",
		"expired",
	] as const);
	requiredLiteralV1(result.compute, ["not_applicable", "stopped", "running", "unknown"] as const);
	requiredIntegerV1(result.activeCommands);
	requiredIntegerV1(result.pendingSyncs);
	if (result.replicaImage !== null) assertWorkspaceImageV1(result.replicaImage);
}

export function decodeCloudflareRuntimeStatusRequestV1(input: unknown): CloudflareRuntimeStatusRequestV1 {
	const snapshot = strictJsonSnapshotV1(input);
	const request = strictProtocolRecordV1(snapshot, ["schemaVersion", "replica", "leaseId"]);
	requiredLiteralV1(request.schemaVersion, [1] as const, "invalid_schema_version");
	assertReplicaV1(request.replica);
	requiredIdentityV1(request.leaseId);
	return snapshot as unknown as CloudflareRuntimeStatusRequestV1;
}

export function decodeCloudflareRuntimeStatusResponseV1(
	input: unknown,
	expectedRequest?: CloudflareRuntimeStatusRequestV1,
): CloudflareRuntimeStatusResponseV1 {
	const snapshot = strictJsonSnapshotV1(input);
	const response = strictProtocolRecordV1(snapshot, [
		"schemaVersion",
		"observationSource",
		"containerRunning",
		"result",
		"deadlines",
	]);
	requiredLiteralV1(response.schemaVersion, [1] as const, "invalid_schema_version");
	requiredLiteralV1(response.observationSource, ["durable_state_and_container_running_only"] as const);
	if (typeof response.containerRunning !== "boolean") protocolFailure("provider_response_invalid");
	assertRuntimeInspectResultV1(response.result);
	assertDeadlineSummaryV1(response.deadlines);
	const result = response.result as Record<string, StrictJsonValueV1>;
	const expected = expectedRequest === undefined ? undefined : decodeCloudflareRuntimeStatusRequestV1(expectedRequest);
	if (expected !== undefined) {
		if (result.status === "absent") {
			if (!equalStrictJsonV1(result.replica, expected.replica) || result.leaseId !== expected.leaseId) {
				protocolFailure("request_identity_mismatch");
			}
		} else if (result.status === "present") {
			const lease = result.lease as Record<string, StrictJsonValueV1>;
			if (!equalStrictJsonV1(lease.replica, expected.replica) || lease.leaseId !== expected.leaseId) {
				protocolFailure("request_identity_mismatch");
			}
		} else {
			const tombstone = result.tombstone as Record<string, StrictJsonValueV1>;
			if (tombstone.workspaceId !== expected.replica.workspaceId) protocolFailure("request_identity_mismatch");
		}
	}
	if (result.status === "present") {
		if (response.containerRunning) {
			if (result.compute !== "running") protocolFailure("provider_response_invalid");
		} else if (result.compute !== "stopped" && result.compute !== "not_applicable") {
			protocolFailure("provider_response_invalid");
		}
	} else if (response.containerRunning) {
		protocolFailure("provider_response_invalid");
	}
	return snapshot as unknown as CloudflareRuntimeStatusResponseV1;
}

export function decodeCloudflareCheckpointFetchRequestV1(input: unknown): CloudflareCheckpointFetchRequestV1 {
	const snapshot = strictJsonSnapshotV1(input);
	const request = strictProtocolRecordV1(snapshot, ["schemaVersion", "locator"]);
	requiredLiteralV1(request.schemaVersion, [1] as const, "invalid_schema_version");
	assertFrozenCheckpointLocatorV1(request.locator);
	return snapshot as unknown as CloudflareCheckpointFetchRequestV1;
}

async function assertReplicaCheckpointV1(value: StrictJsonValueV1): Promise<void> {
	const checkpoint = strictProtocolRecordV1(value, ["rootSha256", "fileCount", "byteCount", "reference", "files"]);
	requiredSha256V1(checkpoint.rootSha256);
	requiredIntegerV1(checkpoint.fileCount);
	requiredIntegerV1(checkpoint.byteCount);
	assertFrozenCheckpointReferenceV1(checkpoint.reference);
	const reference = checkpoint.reference as Record<string, StrictJsonValueV1>;
	if (
		checkpoint.rootSha256 !== reference.rootSha256 ||
		checkpoint.fileCount !== reference.fileCount ||
		checkpoint.byteCount !== reference.byteCount
	) {
		protocolFailure("checkpoint_mismatch");
	}
	const files = requiredArrayV1(checkpoint.files);
	let totalBytes = 0;
	let manifestMaterial = "";
	let previousPath: string | null = null;
	for (const fileValue of files) {
		const file = strictProtocolRecordV1(fileValue, ["path", "sha256", "byteLength", "contentUtf8"]);
		const path = requiredIdentityV1(file.path);
		if (!classifyCanonicalRelativePath(path).accepted) protocolFailure("invalid_shape");
		if (previousPath !== null && compareUtf8(previousPath, path) >= 0) protocolFailure("invalid_shape");
		previousPath = path;
		if (typeof file.contentUtf8 !== "string" || !isWellFormedUnicodeV1(file.contentUtf8))
			protocolFailure("invalid_shape");
		const bytes = strictProtocolEncoderV1.encode(file.contentUtf8);
		const byteLength = requiredIntegerV1(file.byteLength);
		const sha256 = requiredSha256V1(file.sha256);
		if (bytes.byteLength !== byteLength || (await sha256BytesV1(bytes)) !== sha256) {
			protocolFailure("checkpoint_mismatch");
		}
		manifestMaterial += `${path}\0${sha256}\0${byteLength}\n`;
		totalBytes += byteLength;
		if (!Number.isSafeInteger(totalBytes)) protocolFailure("invalid_integer");
	}
	if (
		files.length !== checkpoint.fileCount ||
		totalBytes !== checkpoint.byteCount ||
		(await sha256BytesV1(strictProtocolEncoderV1.encode(manifestMaterial))) !== checkpoint.rootSha256
	) {
		protocolFailure("checkpoint_mismatch");
	}
}

export async function decodeCloudflareCheckpointFetchResponseV1(
	input: unknown,
	expectedRequest?: CloudflareCheckpointFetchRequestV1,
): Promise<CloudflareCheckpointFetchResponseV1> {
	const snapshot = strictJsonSnapshotV1(input);
	const response = strictProtocolRecordV1(snapshot, ["schemaVersion", "result"]);
	requiredLiteralV1(response.schemaVersion, [1] as const, "invalid_schema_version");
	const result = strictProtocolRecordV1(response.result, ["status", "checkpoint"]);
	requiredLiteralV1(result.status, ["fetched"] as const, "provider_response_invalid");
	await assertReplicaCheckpointV1(result.checkpoint);
	const expected =
		expectedRequest === undefined ? undefined : decodeCloudflareCheckpointFetchRequestV1(expectedRequest);
	if (expected !== undefined) {
		const checkpoint = result.checkpoint as Record<string, StrictJsonValueV1>;
		const reference = checkpoint.reference as Record<string, StrictJsonValueV1>;
		if (!equalStrictJsonV1(reference, expected.locator)) {
			const locatorProjection = {
				providerId: reference.providerId,
				profileId: reference.profileId,
				workspaceId: reference.workspaceId,
				replicaId: reference.replicaId,
				leaseId: reference.leaseId,
				checkpointId: reference.checkpointId,
			};
			if (!equalStrictJsonV1(locatorProjection, expected.locator)) protocolFailure("request_identity_mismatch");
		}
	}
	return snapshot as unknown as CloudflareCheckpointFetchResponseV1;
}

export interface CloudflareRuntimeErrorResponseV1 {
	readonly error: {
		readonly code: CloudflareRuntimeProtocolErrorCodeV1;
		readonly message: string;
	};
}

export function cloudflareRuntimeErrorResponseV1(error: unknown): CloudflareRuntimeErrorResponseV1 {
	const code = error instanceof CloudflareRuntimeProtocolErrorV1 ? error.code : "invalid_shape";
	return { error: { code, message: CLOUDFLARE_RUNTIME_PROTOCOL_MESSAGES_V1[code] } };
}

export type CloudflareRuntimeAcquireResultV1 = Omit<RuntimeAcquireResult, "binding">;

export type CloudflareRuntimeEffectResultEnvelopeV1 =
	| { readonly schemaVersion: 1; readonly operation: "acquire"; readonly result: CloudflareRuntimeAcquireResultV1 }
	| { readonly schemaVersion: 1; readonly operation: "push"; readonly result: RuntimePushResult }
	| { readonly schemaVersion: 1; readonly operation: "quiesce"; readonly result: RuntimeQuiesceResult }
	| { readonly schemaVersion: 1; readonly operation: "checkpoint"; readonly result: RuntimeCheckpointResult }
	| { readonly schemaVersion: 1; readonly operation: "revoke"; readonly result: RuntimeRevokeResult }
	| {
			readonly schemaVersion: 1;
			readonly operation: "checkpoint_acknowledgement";
			readonly result: RuntimeCheckpointAcknowledgeResult;
	  }
	| { readonly schemaVersion: 1; readonly operation: "release"; readonly result: RuntimeLeaseReleaseResult };

export type CloudflareRuntimeInspectionResultEnvelopeV1 =
	| { readonly schemaVersion: 1; readonly operation: "acquire"; readonly result: RuntimeAcquireInspectResult }
	| { readonly schemaVersion: 1; readonly operation: "push"; readonly result: RuntimePushInspectResult }
	| { readonly schemaVersion: 1; readonly operation: "quiesce"; readonly result: RuntimeQuiesceInspectResult }
	| {
			readonly schemaVersion: 1;
			readonly operation: "checkpoint";
			readonly result: RuntimeFrozenCheckpointInspectResult;
	  }
	| { readonly schemaVersion: 1; readonly operation: "revoke"; readonly result: RuntimeRevokeInspectResult }
	| {
			readonly schemaVersion: 1;
			readonly operation: "checkpoint_acknowledgement";
			readonly result: RuntimeCheckpointAcknowledgeInspectResult;
	  }
	| { readonly schemaVersion: 1; readonly operation: "release"; readonly result: RuntimeLeaseReleaseInspectResult };

function assertRequestEchoV1(
	value: StrictJsonValueV1,
	expected: { readonly requestId: string; readonly requestSha256: string },
	identityKey: "transitionId" | "parentOperationId",
	expectedIdentity: string,
): void {
	const request = strictProtocolRecordV1(value, ["requestId", "requestSha256", identityKey]);
	if (
		request.requestId !== expected.requestId ||
		request.requestSha256 !== expected.requestSha256 ||
		request[identityKey] !== expectedIdentity
	) {
		protocolFailure("request_identity_mismatch");
	}
}

function assertReplicaAndLeaseMatchV1(
	replicaValue: StrictJsonValueV1,
	leaseIdValue: StrictJsonValueV1,
	expectedReplica: RuntimeReplicaRef,
	expectedLeaseId: string,
): void {
	assertReplicaV1(replicaValue);
	if (!equalStrictJsonV1(replicaValue, expectedReplica) || leaseIdValue !== expectedLeaseId) {
		protocolFailure("request_identity_mismatch");
	}
}

function assertReferenceMatchesCheckpointRequestV1(
	value: StrictJsonValueV1,
	request: RuntimeCheckpointInspectRequest,
): void {
	assertFrozenCheckpointReferenceV1(value);
	const reference = value as Record<string, StrictJsonValueV1>;
	if (
		reference.providerId !== request.lease.replica.providerId ||
		reference.profileId !== request.lease.replica.profileId ||
		reference.workspaceId !== request.lease.replica.workspaceId ||
		reference.replicaId !== request.lease.replica.replicaId ||
		reference.leaseId !== request.lease.leaseId ||
		reference.checkpointId !== request.checkpointId ||
		reference.baseGeneration !== request.lease.baseGeneration
	) {
		protocolFailure("checkpoint_mismatch");
	}
}

function assertAcquireEffectResultV1(value: StrictJsonValueV1, request: RuntimeAcquireInspectRequest): void {
	const result = strictProtocolRecordV1(value, [
		"status",
		"request",
		"lease",
		"providerPhase",
		"deletionAuthorityDomain",
	]);
	requiredLiteralV1(result.status, ["acquired", "already_acquired"] as const, "provider_response_invalid");
	assertRequestEchoV1(result.request, request, "transitionId", request.transitionId);
	assertLeaseV1(result.lease);
	const lease = result.lease as Record<string, StrictJsonValueV1>;
	if (
		!equalStrictJsonV1(lease.replica, request.plan.replica) ||
		lease.leaseId !== request.plan.leaseId ||
		lease.fenceId !== request.plan.fenceId ||
		lease.baseGeneration !== request.plan.baseCheckpoint.generation ||
		lease.renewalSequence !== request.plan.initialRenewalSequence
	) {
		protocolFailure("request_identity_mismatch");
	}
	requiredLiteralV1(result.providerPhase, ["reserved"] as const);
	if (result.deletionAuthorityDomain !== request.plan.deletionAuthorityDomain) {
		protocolFailure("deletion_authority_domain_mismatch");
	}
}

function assertAcquireInspectionResultV1(value: StrictJsonValueV1, request: RuntimeAcquireInspectRequest): void {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		protocolFailure("provider_response_invalid");
	const status = requiredLiteralV1(
		(value as Record<string, StrictJsonValueV1>).status,
		["not_started", "in_progress", "complete"] as const,
		"provider_response_invalid",
	);
	if (status === "complete") {
		const result = strictProtocolRecordV1(value, [
			"status",
			"request",
			"lease",
			"deletionAuthorityDomain",
			"providerPhase",
		]);
		assertRequestEchoV1(result.request, request, "transitionId", request.transitionId);
		assertLeaseV1(result.lease);
		const lease = result.lease as Record<string, StrictJsonValueV1>;
		if (!equalStrictJsonV1(lease.replica, request.plan.replica) || lease.leaseId !== request.plan.leaseId) {
			protocolFailure("request_identity_mismatch");
		}
		if (result.deletionAuthorityDomain !== request.plan.deletionAuthorityDomain) {
			protocolFailure("deletion_authority_domain_mismatch");
		}
		requiredLiteralV1(result.providerPhase, ["reserved"] as const);
		return;
	}
	const keys =
		status === "in_progress"
			? ["status", "request", "replica", "leaseId", "deletionAuthorityDomain", "providerPhase", "observedAt"]
			: ["status", "request", "replica", "leaseId", "deletionAuthorityDomain"];
	const result = strictProtocolRecordV1(value, keys);
	assertRequestEchoV1(result.request, request, "transitionId", request.transitionId);
	assertReplicaAndLeaseMatchV1(result.replica, result.leaseId, request.plan.replica, request.plan.leaseId);
	if (result.deletionAuthorityDomain !== request.plan.deletionAuthorityDomain) {
		protocolFailure("deletion_authority_domain_mismatch");
	}
	if (status === "in_progress") {
		requiredLiteralV1(result.providerPhase, ["reserved"] as const);
		requiredIso8601V1(result.observedAt);
	}
}

function assertPushEffectResultV1(value: StrictJsonValueV1, request: RuntimePushInspectRequest): void {
	const result = strictProtocolRecordV1(value, [
		"rootSha256",
		"fileCount",
		"byteCount",
		"status",
		"request",
		"replica",
		"canonicalGeneration",
	]);
	assertWorkspaceImageV1({ rootSha256: result.rootSha256, fileCount: result.fileCount, byteCount: result.byteCount });
	requiredLiteralV1(result.status, ["materialized", "already_materialized"] as const, "provider_response_invalid");
	assertRequestEchoV1(result.request, request, "transitionId", request.transitionId);
	assertReplicaAndLeaseMatchV1(result.replica, request.lease.leaseId, request.lease.replica, request.lease.leaseId);
	if (
		result.canonicalGeneration !== request.lease.baseGeneration ||
		result.rootSha256 !== request.snapshot.rootSha256 ||
		result.fileCount !== request.snapshot.fileCount ||
		result.byteCount !== request.snapshot.byteCount
	) {
		protocolFailure("checkpoint_mismatch");
	}
}

function assertQuiesceEffectResultV1(value: StrictJsonValueV1, request: RuntimeQuiesceInspectRequest): void {
	const result = strictProtocolRecordV1(value, ["status", "request", "lease", "activeCommands", "pendingSyncs"]);
	requiredLiteralV1(result.status, ["quiesced", "already_quiesced"] as const, "provider_response_invalid");
	assertRequestEchoV1(result.request, request, "transitionId", request.transitionId);
	assertLeaseV1(result.lease);
	if (!equalStrictJsonV1(result.lease, request.lease) || result.activeCommands !== 0 || result.pendingSyncs !== 0) {
		protocolFailure("provider_response_invalid");
	}
}

function assertCheckpointEffectResultV1(value: StrictJsonValueV1, request: RuntimeCheckpointInspectRequest): void {
	const result = strictProtocolRecordV1(value, ["status", "request", "reference"]);
	requiredLiteralV1(result.status, ["checkpointed", "already_checkpointed"] as const, "provider_response_invalid");
	assertRequestEchoV1(result.request, request, "transitionId", request.transitionId);
	assertReferenceMatchesCheckpointRequestV1(result.reference, request);
}

function assertRevokeEffectResultV1(value: StrictJsonValueV1, request: RuntimeRevokeInspectRequest): void {
	const result = strictProtocolRecordV1(value, ["status", "request", "replica", "leaseId", "fenceId"]);
	requiredLiteralV1(
		result.status,
		["revoked", "already_revoked", "expired", "absent"] as const,
		"provider_response_invalid",
	);
	assertRequestEchoV1(result.request, request, "transitionId", request.transitionId);
	assertReplicaAndLeaseMatchV1(result.replica, result.leaseId, request.replica, request.leaseId);
	if (result.fenceId !== request.fenceId) protocolFailure("request_identity_mismatch");
}

function assertAcknowledgementEffectResultV1(
	value: StrictJsonValueV1,
	request: RuntimeCheckpointAcknowledgeInspectRequest,
): void {
	const result = strictProtocolRecordV1(value, [
		"status",
		"request",
		"reference",
		"canonicalCommit",
		"acknowledgedAt",
	]);
	requiredLiteralV1(result.status, ["acknowledged", "already_acknowledged"] as const, "provider_response_invalid");
	assertRequestEchoV1(result.request, request, "parentOperationId", request.parentOperationId);
	if (
		!equalStrictJsonV1(result.reference, request.reference) ||
		!equalStrictJsonV1(result.canonicalCommit, request.canonicalCommit)
	) {
		protocolFailure("checkpoint_mismatch");
	}
	requiredIso8601V1(result.acknowledgedAt);
}

function assertReleaseEffectResultV1(value: StrictJsonValueV1, request: RuntimeLeaseReleaseInspectRequest): void {
	const result = strictProtocolRecordV1(value, ["status", "request", "replica", "leaseId", "compute"]);
	requiredLiteralV1(
		result.status,
		["released", "already_released", "expired", "absent"] as const,
		"provider_response_invalid",
	);
	assertRequestEchoV1(result.request, request, "parentOperationId", request.parentOperationId);
	assertReplicaAndLeaseMatchV1(result.replica, result.leaseId, request.replica, request.leaseId);
	requiredLiteralV1(result.compute, ["stopped", "not_applicable"] as const, "provider_response_invalid");
}

function assertGenericInspectionResultV1(
	operation: RuntimeCanonicalProviderOperationV1,
	value: StrictJsonValueV1,
	request: RuntimeCanonicalProviderInspectionV1["request"],
): void {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		protocolFailure("provider_response_invalid");
	const status = (value as Record<string, StrictJsonValueV1>).status;
	if (operation === "push") {
		const pushRequest = request as RuntimePushInspectRequest;
		if (status === "complete") {
			const result = strictProtocolRecordV1(value, ["status", "result"]);
			assertPushEffectResultV1(result.result, pushRequest);
			return;
		}
		const keys =
			status === "in_progress"
				? ["status", "request", "replica", "leaseId", "providerPhase", "observedAt"]
				: ["status", "request", "replica", "leaseId"];
		const result = strictProtocolRecordV1(value, keys);
		requiredLiteralV1(status, ["not_started", "in_progress"] as const, "provider_response_invalid");
		assertRequestEchoV1(result.request, pushRequest, "transitionId", pushRequest.transitionId);
		assertReplicaAndLeaseMatchV1(
			result.replica,
			result.leaseId,
			pushRequest.lease.replica,
			pushRequest.lease.leaseId,
		);
		if (status === "in_progress") {
			requiredLiteralV1(result.providerPhase, ["materializing"] as const);
			requiredIso8601V1(result.observedAt);
		}
		return;
	}
	if (operation === "quiesce") {
		const quiesceRequest = request as RuntimeQuiesceInspectRequest;
		if (status === "complete") {
			const result = strictProtocolRecordV1(value, ["status", "result"]);
			assertQuiesceEffectResultV1(result.result, quiesceRequest);
			return;
		}
		const keys =
			status === "in_progress"
				? ["status", "request", "lease", "activeCommands", "pendingSyncs", "observedAt"]
				: ["status", "request", "lease"];
		const result = strictProtocolRecordV1(value, keys);
		requiredLiteralV1(status, ["not_started", "in_progress"] as const, "provider_response_invalid");
		assertRequestEchoV1(result.request, quiesceRequest, "transitionId", quiesceRequest.transitionId);
		assertLeaseV1(result.lease);
		if (!equalStrictJsonV1(result.lease, quiesceRequest.lease)) protocolFailure("request_identity_mismatch");
		if (status === "in_progress") {
			requiredIntegerV1(result.activeCommands);
			requiredIntegerV1(result.pendingSyncs);
			requiredIso8601V1(result.observedAt);
		}
		return;
	}
	if (operation === "checkpoint") {
		const checkpointRequest = request as RuntimeCheckpointInspectRequest;
		if (status === "absent") {
			const result = strictProtocolRecordV1(value, ["status", "request", "locator"]);
			assertRequestEchoV1(result.request, checkpointRequest, "transitionId", checkpointRequest.transitionId);
			assertFrozenCheckpointLocatorV1(result.locator);
			const locator = result.locator as Record<string, StrictJsonValueV1>;
			if (
				locator.providerId !== checkpointRequest.lease.replica.providerId ||
				locator.profileId !== checkpointRequest.lease.replica.profileId ||
				locator.workspaceId !== checkpointRequest.lease.replica.workspaceId ||
				locator.replicaId !== checkpointRequest.lease.replica.replicaId ||
				locator.leaseId !== checkpointRequest.lease.leaseId ||
				locator.checkpointId !== checkpointRequest.checkpointId
			) {
				protocolFailure("checkpoint_mismatch");
			}
			return;
		}
		const keys =
			status === "acknowledged"
				? ["status", "request", "reference", "canonicalCommit", "acknowledgedAt"]
				: ["status", "request", "reference"];
		const result = strictProtocolRecordV1(value, keys);
		requiredLiteralV1(status, ["frozen", "acknowledged"] as const, "provider_response_invalid");
		assertRequestEchoV1(result.request, checkpointRequest, "transitionId", checkpointRequest.transitionId);
		assertReferenceMatchesCheckpointRequestV1(result.reference, checkpointRequest);
		if (status === "acknowledged") {
			assertCanonicalCommitReceiptV1(result.canonicalCommit);
			requiredIso8601V1(result.acknowledgedAt);
		}
		return;
	}
	if (operation === "revoke") {
		const revokeRequest = request as RuntimeRevokeInspectRequest;
		if (status === "complete") {
			const result = strictProtocolRecordV1(value, ["status", "result"]);
			assertRevokeEffectResultV1(result.result, revokeRequest);
			return;
		}
		const result = strictProtocolRecordV1(value, ["status", "request", "replica", "leaseId", "fenceId"]);
		requiredLiteralV1(status, ["not_started"] as const, "provider_response_invalid");
		assertRequestEchoV1(result.request, revokeRequest, "transitionId", revokeRequest.transitionId);
		assertReplicaAndLeaseMatchV1(result.replica, result.leaseId, revokeRequest.replica, revokeRequest.leaseId);
		if (result.fenceId !== revokeRequest.fenceId) protocolFailure("request_identity_mismatch");
		return;
	}
	if (operation === "checkpoint_acknowledgement") {
		const acknowledgementRequest = request as RuntimeCheckpointAcknowledgeInspectRequest;
		if (status === "complete") {
			const result = strictProtocolRecordV1(value, ["status", "result"]);
			assertAcknowledgementEffectResultV1(result.result, acknowledgementRequest);
			return;
		}
		const result = strictProtocolRecordV1(value, ["status", "request", "reference"]);
		requiredLiteralV1(status, ["not_requested"] as const, "provider_response_invalid");
		assertRequestEchoV1(
			result.request,
			acknowledgementRequest,
			"parentOperationId",
			acknowledgementRequest.parentOperationId,
		);
		if (!equalStrictJsonV1(result.reference, acknowledgementRequest.reference))
			protocolFailure("checkpoint_mismatch");
		return;
	}
	const releaseRequest = request as RuntimeLeaseReleaseInspectRequest;
	if (status === "complete") {
		const result = strictProtocolRecordV1(value, ["status", "result"]);
		assertReleaseEffectResultV1(result.result, releaseRequest);
		return;
	}
	const keys =
		status === "in_progress"
			? ["status", "request", "replica", "leaseId", "compute", "observedAt"]
			: ["status", "request", "replica", "leaseId"];
	const result = strictProtocolRecordV1(value, keys);
	requiredLiteralV1(status, ["not_requested", "in_progress"] as const, "provider_response_invalid");
	assertRequestEchoV1(result.request, releaseRequest, "parentOperationId", releaseRequest.parentOperationId);
	assertReplicaAndLeaseMatchV1(result.replica, result.leaseId, releaseRequest.replica, releaseRequest.leaseId);
	if (status === "in_progress") {
		requiredLiteralV1(result.compute, ["not_applicable", "stopped", "running", "unknown"] as const);
		requiredIso8601V1(result.observedAt);
	}
}

export function decodeCloudflareRuntimeEffectResultEnvelopeV1(
	input: unknown,
	expected: CloudflareValidatedRuntimeOperationV1,
): CloudflareRuntimeEffectResultEnvelopeV1 {
	const snapshot = strictJsonSnapshotV1(input);
	const envelope = strictProtocolRecordV1(snapshot, ["schemaVersion", "operation", "result"]);
	requiredLiteralV1(envelope.schemaVersion, [1] as const, "invalid_schema_version");
	if (envelope.operation !== expected.operation) protocolFailure("invalid_operation");
	switch (expected.inspection.operation) {
		case "acquire":
			assertAcquireEffectResultV1(envelope.result, expected.inspection.request);
			break;
		case "push":
			assertPushEffectResultV1(envelope.result, expected.inspection.request);
			break;
		case "quiesce":
			assertQuiesceEffectResultV1(envelope.result, expected.inspection.request);
			break;
		case "checkpoint":
			assertCheckpointEffectResultV1(envelope.result, expected.inspection.request);
			break;
		case "revoke":
			assertRevokeEffectResultV1(envelope.result, expected.inspection.request);
			break;
		case "checkpoint_acknowledgement":
			assertAcknowledgementEffectResultV1(envelope.result, expected.inspection.request);
			break;
		case "release":
			assertReleaseEffectResultV1(envelope.result, expected.inspection.request);
			break;
	}
	return snapshot as unknown as CloudflareRuntimeEffectResultEnvelopeV1;
}

export function decodeCloudflareRuntimeInspectionResultEnvelopeV1(
	input: unknown,
	expected: CloudflareValidatedRuntimeOperationV1,
): CloudflareRuntimeInspectionResultEnvelopeV1 {
	const snapshot = strictJsonSnapshotV1(input);
	const envelope = strictProtocolRecordV1(snapshot, ["schemaVersion", "operation", "result"]);
	requiredLiteralV1(envelope.schemaVersion, [1] as const, "invalid_schema_version");
	if (envelope.operation !== expected.operation) protocolFailure("invalid_operation");
	if (expected.inspection.operation === "acquire") {
		assertAcquireInspectionResultV1(envelope.result, expected.inspection.request);
	} else {
		assertGenericInspectionResultV1(expected.inspection.operation, envelope.result, expected.inspection.request);
	}
	return snapshot as unknown as CloudflareRuntimeInspectionResultEnvelopeV1;
}

function assertRenewalReceiptV1(value: StrictJsonValueV1, plan: RuntimeLeaseRenewalPlan): void {
	const receipt = strictProtocolRecordV1(value, [
		"renewalId",
		"sequence",
		"request",
		"priorLease",
		"lease",
		"providerOutcome",
		"completedAt",
	]);
	if (receipt.renewalId !== plan.renewalId || receipt.sequence !== plan.sequence) {
		protocolFailure("request_identity_mismatch");
	}
	const request = strictProtocolRecordV1(receipt.request, ["requestId", "requestSha256"]);
	if (!equalStrictJsonV1(request, plan.request)) protocolFailure("request_identity_mismatch");
	assertLeaseV1(receipt.priorLease);
	assertLeaseV1(receipt.lease);
	if (!equalStrictJsonV1(receipt.priorLease, plan.expectedLease)) protocolFailure("request_identity_mismatch");
	const lease = receipt.lease;
	if (
		lease.leaseId !== plan.expectedLease.leaseId ||
		!equalStrictJsonV1(lease.replica, plan.expectedLease.replica) ||
		lease.fenceId !== plan.expectedLease.fenceId ||
		lease.baseGeneration !== plan.expectedLease.baseGeneration ||
		lease.renewalSequence !== plan.sequence ||
		lease.acquiredAt !== plan.expectedLease.acquiredAt
	) {
		protocolFailure("request_identity_mismatch");
	}
	requiredLiteralV1(receipt.providerOutcome, ["renewed", "already_renewed"] as const, "provider_response_invalid");
	requiredIso8601V1(receipt.completedAt);
}

function assertRenewalInspectionResultV1(value: StrictJsonValueV1, plan: RuntimeLeaseRenewalPlan): void {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		protocolFailure("provider_response_invalid");
	const status = requiredLiteralV1(
		(value as Record<string, StrictJsonValueV1>).status,
		["absent", "complete", "rejected"] as const,
		"provider_response_invalid",
	);
	if (status === "absent") {
		const result = strictProtocolRecordV1(value, ["status", "renewalId", "sequence", "requestId"]);
		if (
			result.renewalId !== plan.renewalId ||
			result.sequence !== plan.sequence ||
			result.requestId !== plan.request.requestId
		) {
			protocolFailure("request_identity_mismatch");
		}
		return;
	}
	if (status === "complete") {
		const result = strictProtocolRecordV1(value, ["status", "receipt"]);
		assertRenewalReceiptV1(result.receipt, plan);
		return;
	}
	const result = strictProtocolRecordV1(value, [
		"status",
		"renewalId",
		"sequence",
		"reason",
		"observedRenewalSequence",
		"observedAt",
	]);
	if (result.renewalId !== plan.renewalId || result.sequence !== plan.sequence) {
		protocolFailure("request_identity_mismatch");
	}
	requiredLiteralV1(
		result.reason,
		["lease_expired", "lease_revoked", "expected_lease_mismatch"] as const,
		"provider_response_invalid",
	);
	if (result.observedRenewalSequence !== null) requiredIntegerV1(result.observedRenewalSequence);
	requiredIso8601V1(result.observedAt);
}

function assertRecoveryLocatorMatchV1(
	value: StrictJsonValueV1,
	request: Omit<RuntimeRecoveryFreezeRequest, "signal">,
): void {
	const locator = decodeRuntimeRecoveryFreezeLocatorTransportV1(value);
	if (!equalStrictJsonV1(locator, request.locator)) protocolFailure("request_identity_mismatch");
}

function assertRecoveryReferenceV1(
	value: StrictJsonValueV1,
	request: Omit<RuntimeRecoveryFreezeRequest, "signal">,
): void {
	assertFrozenCheckpointReferenceV1(value);
	const reference = value as Record<string, StrictJsonValueV1>;
	const { locator } = request;
	if (
		reference.providerId !== locator.replica.providerId ||
		reference.profileId !== locator.replica.profileId ||
		reference.workspaceId !== locator.replica.workspaceId ||
		reference.replicaId !== locator.replica.replicaId ||
		reference.leaseId !== locator.leaseId ||
		reference.checkpointId !== locator.checkpointId ||
		reference.baseGeneration !== locator.baseGeneration
	) {
		protocolFailure("checkpoint_mismatch");
	}
}

async function assertRecoveryProofV1(
	value: StrictJsonValueV1,
	request: Omit<RuntimeRecoveryFreezeRequest, "signal">,
): Promise<void> {
	const proof = strictProtocolRecordV1(value, ["locator", "code", "proofSha256", "observedAt"]);
	assertRecoveryLocatorMatchV1(proof.locator, request);
	const code = requiredLiteralV1(
		proof.code,
		[
			"replica_absent",
			"replica_image_missing",
			"replica_image_invalid",
			"acknowledged_mutation_ledger_incomplete",
		] as const,
		"provider_response_invalid",
	);
	const observedAt = requiredIso8601V1(proof.observedAt);
	const expectedDigest = await canonicalRuntimeSha256V1([
		"omp-cloudflare-recovery-impossible-v1",
		request.locator.recoveryFreezeId,
		request.locator.replica.workspaceId,
		request.locator.replica.replicaId,
		request.locator.leaseId,
		request.locator.fenceId,
		request.locator.baseGeneration,
		request.locator.checkpointId,
		code,
		observedAt,
	]);
	if (requiredSha256V1(proof.proofSha256) !== expectedDigest) protocolFailure("provider_response_invalid");
}

function assertRecoveryFrozenFieldsV1(
	result: Record<string, StrictJsonValueV1>,
	request: Omit<RuntimeRecoveryFreezeRequest, "signal">,
): void {
	assertRecoveryReferenceV1(result.reference, request);
	requiredSha256V1(result.acknowledgedMutationsSha256);
	requiredIntegerV1(result.observedRenewalSequence);
	requiredLiteralV1(result.commandAdmission, ["closed"] as const, "provider_response_invalid");
	requiredLiteralV1(result.activeCommands, [0] as const, "provider_response_invalid");
	requiredLiteralV1(result.pendingSyncs, [0] as const, "provider_response_invalid");
	requiredLiteralV1(
		result.priorFence,
		["recovery_revoked", "already_revoked", "expired"] as const,
		"provider_response_invalid",
	);
}

async function assertRecoveryEffectResultV1(
	value: StrictJsonValueV1,
	request: Omit<RuntimeRecoveryFreezeRequest, "signal">,
): Promise<void> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		protocolFailure("provider_response_invalid");
	const status = requiredLiteralV1(
		(value as Record<string, StrictJsonValueV1>).status,
		["frozen", "already_frozen", "preservation_impossible", "already_proved_impossible"] as const,
		"provider_response_invalid",
	);
	if (status === "frozen" || status === "already_frozen") {
		const result = strictProtocolRecordV1(value, [
			"status",
			"reference",
			"acknowledgedMutationsSha256",
			"observedRenewalSequence",
			"commandAdmission",
			"activeCommands",
			"pendingSyncs",
			"priorFence",
		]);
		assertRecoveryFrozenFieldsV1(result, request);
		return;
	}
	const result = strictProtocolRecordV1(value, ["status", "proof"]);
	await assertRecoveryProofV1(result.proof, request);
}

async function assertRecoveryInspectionResultV1(
	value: StrictJsonValueV1,
	request: Omit<RuntimeRecoveryFreezeRequest, "signal">,
): Promise<void> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		protocolFailure("provider_response_invalid");
	const status = requiredLiteralV1(
		(value as Record<string, StrictJsonValueV1>).status,
		["absent", "in_progress", "frozen", "preservation_impossible"] as const,
		"provider_response_invalid",
	);
	if (status === "absent") {
		const result = strictProtocolRecordV1(value, ["status", "locator"]);
		assertRecoveryLocatorMatchV1(result.locator, request);
		return;
	}
	if (status === "in_progress") {
		const result = strictProtocolRecordV1(value, [
			"status",
			"locator",
			"phase",
			"activeCommands",
			"pendingSyncs",
			"observedAt",
		]);
		assertRecoveryLocatorMatchV1(result.locator, request);
		requiredLiteralV1(
			result.phase,
			["sealing_admission", "reconciling_commands", "freezing_checkpoint"] as const,
			"provider_response_invalid",
		);
		requiredIntegerV1(result.activeCommands);
		requiredIntegerV1(result.pendingSyncs);
		requiredIso8601V1(result.observedAt);
		return;
	}
	if (status === "frozen") {
		const result = strictProtocolRecordV1(value, [
			"status",
			"reference",
			"acknowledgedMutationsSha256",
			"observedRenewalSequence",
			"commandAdmission",
			"activeCommands",
			"pendingSyncs",
			"priorFence",
		]);
		assertRecoveryFrozenFieldsV1(result, request);
		return;
	}
	const result = strictProtocolRecordV1(value, ["status", "proof"]);
	await assertRecoveryProofV1(result.proof, request);
}

function assertRuntimeCommandSnapshotV1(
	value: StrictJsonValueV1,
	expectedCommandId: string,
	expectedRequestSha256: string | null,
	outputByteLimit: number,
): RuntimeCommandSnapshot["status"] {
	const snapshot = strictProtocolRecordV1(value, [
		"commandId",
		"requestSha256",
		"sync",
		"output",
		"truncated",
		"exitCode",
		"signal",
		"updatedAt",
		"status",
		"execution",
	]);
	if (requiredIdentityV1(snapshot.commandId) !== expectedCommandId) protocolFailure("request_identity_mismatch");
	const requestSha256 = requiredSha256V1(snapshot.requestSha256);
	if (expectedRequestSha256 !== null && requestSha256 !== expectedRequestSha256) {
		protocolFailure("request_identity_mismatch");
	}
	requiredLiteralV1(snapshot.sync, ["pending", "complete", "exhausted"] as const, "provider_response_invalid");
	const output = requiredStringAllowEmptyV1(snapshot.output);
	if (strictProtocolEncoderV1.encode(output).byteLength > outputByteLimit)
		protocolFailure("provider_response_invalid");
	if (typeof snapshot.truncated !== "boolean") protocolFailure("provider_response_invalid");
	if (snapshot.exitCode !== null && typeof snapshot.exitCode !== "number")
		protocolFailure("provider_response_invalid");
	if (snapshot.signal !== null) {
		requiredLiteralV1(
			snapshot.signal,
			[
				"SIGABRT",
				"SIGBUS",
				"SIGFPE",
				"SIGHUP",
				"SIGILL",
				"SIGINT",
				"SIGKILL",
				"SIGPIPE",
				"SIGQUIT",
				"SIGSEGV",
				"SIGTERM",
				"SIGTRAP",
				"other",
			] as const,
			"provider_response_invalid",
		);
	}
	requiredIso8601V1(snapshot.updatedAt);
	const status = requiredLiteralV1(
		snapshot.status,
		["reserved", "start_unknown", "running", "succeeded", "failed", "cancelled"] as const,
		"provider_response_invalid",
	);
	if (status === "reserved") {
		const execution = strictProtocolRecordV1(snapshot.execution, ["certainty", "proof"]);
		requiredLiteralV1(execution.certainty, ["not_started"] as const, "provider_response_invalid");
		requiredLiteralV1(
			execution.proof,
			["reservation_without_attempt", "backend_absent"] as const,
			"provider_response_invalid",
		);
	} else {
		const execution = strictProtocolRecordV1(snapshot.execution, ["certainty"]);
		const certainty = status === "start_unknown" ? "unknown" : status === "running" ? "started" : "completed";
		requiredLiteralV1(execution.certainty, [certainty] as const, "provider_response_invalid");
	}
	return status;
}

function assertRuntimeCommandInspectionResultV1(
	value: StrictJsonValueV1,
	locator: RuntimeCommandLocator | CloudflareRuntimeBridgeInspectCommandRequestV1,
): void {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		protocolFailure("provider_response_invalid");
	const status = requiredLiteralV1(
		(value as Record<string, StrictJsonValueV1>).status,
		["absent", "present"] as const,
		"provider_response_invalid",
	);
	if (status === "absent") {
		const result = strictProtocolRecordV1(value, ["status", "commandId", "execution"]);
		if (result.commandId !== locator.commandId) protocolFailure("request_identity_mismatch");
		const execution = strictProtocolRecordV1(result.execution, ["certainty", "proof"]);
		requiredLiteralV1(execution.certainty, ["not_started"] as const, "provider_response_invalid");
		requiredLiteralV1(execution.proof, ["provider_reservation_absent"] as const, "provider_response_invalid");
		return;
	}
	const result = strictProtocolRecordV1(value, ["status", "snapshot"]);
	assertRuntimeCommandSnapshotV1(
		result.snapshot,
		locator.commandId,
		"requestSha256" in locator ? locator.requestSha256 : null,
		MAX_EXEC_OUTPUT_BYTES,
	);
}

function assertRuntimeCommandReconcileResultV1(value: StrictJsonValueV1, locator: RuntimeCommandLocator): void {
	const result = strictProtocolRecordV1(value, ["status", "snapshot"]);
	const status = requiredLiteralV1(
		result.status,
		["not_started", "unknown", "observed"] as const,
		"provider_response_invalid",
	);
	const snapshotStatus = assertRuntimeCommandSnapshotV1(
		result.snapshot,
		locator.commandId,
		locator.requestSha256,
		MAX_EXEC_OUTPUT_BYTES,
	);
	if (
		(status === "not_started" && snapshotStatus !== "reserved") ||
		(status === "unknown" && snapshotStatus !== "start_unknown") ||
		(status === "observed" && (snapshotStatus === "reserved" || snapshotStatus === "start_unknown"))
	) {
		protocolFailure("provider_response_invalid");
	}
}

async function assertRuntimeBridgeInspectionResultV1(
	operation: CloudflareRuntimeBridgeInspectionEnvelopeV1["operation"],
	value: StrictJsonValueV1,
	request: CloudflareRuntimeBridgeInspectionEnvelopeV1["request"],
): Promise<void> {
	switch (operation) {
		case "read_text_file": {
			const expected = request as RuntimeReadTextRequest;
			const result = strictProtocolRecordV1(value, ["path", "content", "sha256", "byteLength"]);
			if (result.path !== expected.path) protocolFailure("request_identity_mismatch");
			const content = requiredStringAllowEmptyV1(result.content);
			const bytes = strictProtocolEncoderV1.encode(content);
			if (
				requiredIntegerWithinV1(result.byteLength, 0, expected.byteLimit) !== bytes.byteLength ||
				requiredSha256V1(result.sha256) !== (await sha256BytesV1(bytes))
			) {
				protocolFailure("provider_response_invalid");
			}
			return;
		}
		case "read_binary_file": {
			const expected = request as RuntimeReadBinaryRequest;
			const result = strictProtocolRecordV1(value, ["path", "contentBase64", "sha256", "byteLength", "truncated"]);
			if (result.path !== expected.path) protocolFailure("request_identity_mismatch");
			const bytes = decodeCanonicalBase64V1(result.contentBase64);
			if (
				requiredIntegerWithinV1(result.byteLength, 0, expected.byteLimit) !== bytes.byteLength ||
				requiredSha256V1(result.sha256) !== (await sha256BytesV1(bytes)) ||
				typeof result.truncated !== "boolean"
			) {
				protocolFailure("provider_response_invalid");
			}
			return;
		}
		case "exists":
			if (typeof value !== "boolean") protocolFailure("provider_response_invalid");
			return;
		case "stat": {
			const expected = request as CloudflareRuntimeBridgePathRequestV1;
			const result = strictProtocolRecordV1(value, ["path", "kind", "byteLength", "sha256"]);
			if (result.path !== expected.path) protocolFailure("request_identity_mismatch");
			const kind = requiredLiteralV1(
				result.kind,
				["file", "directory", "symlink", "other"] as const,
				"provider_response_invalid",
			);
			if (kind === "file") {
				requiredIntegerV1(result.byteLength);
				requiredSha256V1(result.sha256);
			} else if (result.byteLength !== null || result.sha256 !== null) {
				protocolFailure("provider_response_invalid");
			}
			return;
		}
		case "list_files": {
			const expected = request as RuntimeListRequest;
			const result = strictProtocolRecordV1(value, ["entries", "nextCursor"]);
			const entries = requiredArrayV1(result.entries);
			if (entries.length > expected.limit) protocolFailure("provider_response_invalid");
			let previousPath: string | null = null;
			for (const valueEntry of entries) {
				const entry = strictProtocolRecordV1(valueEntry, ["path", "kind", "byteLength"]);
				const path = requiredRuntimePathV1(entry.path, false);
				if (previousPath !== null && compareUtf8(previousPath, path) >= 0)
					protocolFailure("provider_response_invalid");
				previousPath = path;
				requiredLiteralV1(entry.kind, ["file", "directory", "symlink"] as const, "provider_response_invalid");
				if (entry.byteLength !== null) requiredIntegerV1(entry.byteLength);
			}
			if (result.nextCursor !== null) {
				const cursor = requiredIdentityV1(result.nextCursor);
				const start = expected.cursor === null ? 0 : Number.parseInt(expected.cursor, 10);
				if (cursor !== String(start + entries.length)) protocolFailure("provider_response_invalid");
			}
			return;
		}
		case "search_text": {
			const expected = request as RuntimeSearchRequest;
			if (
				strictProtocolEncoderV1.encode(JSON.stringify(value)).byteLength >
				CLOUDFLARE_RUNTIME_SEARCH_RESULT_BYTE_BUDGET_V1
			) {
				protocolFailure("provider_response_invalid");
			}
			const result = strictProtocolRecordV1(value, ["matches", "nextCursor"]);
			const matches = requiredArrayV1(result.matches);
			if (matches.length > expected.limit) protocolFailure("provider_response_invalid");
			for (const valueMatch of matches) {
				const match = strictProtocolRecordV1(valueMatch, ["path", "line", "column", "text"]);
				requiredRuntimePathV1(match.path, false);
				requiredIntegerV1(match.line, 1);
				requiredIntegerV1(match.column, 1);
				requiredStringAllowEmptyV1(match.text);
			}
			if (result.nextCursor !== null) {
				const cursor = requiredIdentityV1(result.nextCursor);
				if (cursor === expected.cursor) protocolFailure("provider_response_invalid");
				try {
					await decodeCloudflareRuntimeSearchCursorV1(cursor, expected);
				} catch {
					protocolFailure("provider_response_invalid");
				}
			}
			return;
		}
		case "inspect_command":
			assertRuntimeCommandInspectionResultV1(value, request as CloudflareRuntimeBridgeInspectCommandRequestV1);
	}
}

function assertRuntimeBridgeEffectResultV1(
	operation: CloudflareRuntimeBridgeEffectEnvelopeV1["operation"],
	value: StrictJsonValueV1,
	request: CloudflareRuntimeBridgeEffectEnvelopeV1["request"],
): void {
	switch (operation) {
		case "write_text_file": {
			const expected = request as RuntimeWriteTextRequest;
			const result = strictProtocolRecordV1(value, ["status", "path", "sha256", "byteLength"]);
			requiredLiteralV1(result.status, ["written", "already_written"] as const, "provider_response_invalid");
			if (
				result.path !== expected.path ||
				result.sha256 !== expected.contentSha256 ||
				result.byteLength !== strictProtocolEncoderV1.encode(expected.content).byteLength
			) {
				protocolFailure("provider_response_invalid");
			}
			return;
		}
		case "mkdir": {
			const result = strictProtocolRecordV1(value, ["status"]);
			requiredLiteralV1(result.status, ["created", "already_exists"] as const, "provider_response_invalid");
			return;
		}
		case "remove": {
			const result = strictProtocolRecordV1(value, ["status"]);
			requiredLiteralV1(result.status, ["removed", "already_absent"] as const, "provider_response_invalid");
			return;
		}
		case "rename": {
			const result = strictProtocolRecordV1(value, ["status"]);
			requiredLiteralV1(result.status, ["renamed", "already_renamed"] as const, "provider_response_invalid");
			return;
		}
		case "submit_command": {
			const expected = request as RuntimeCommandRequest;
			assertRuntimeCommandSnapshotV1(
				value,
				expected.commandId,
				expected.requestSha256,
				expected.command.outputByteLimit,
			);
			return;
		}
		case "cancel_command": {
			const expected = request as CloudflareRuntimeBridgeCancelCommandRequestV1;
			assertRuntimeCommandSnapshotV1(value, expected.commandId, null, MAX_EXEC_OUTPUT_BYTES);
			return;
		}
		case "dispose_command": {
			const expected = request as CloudflareRuntimeBridgeDisposeCommandRequestV1;
			const result = strictProtocolRecordV1(value, ["status", "commandId"]);
			requiredLiteralV1(result.status, ["disposed", "already_disposed"] as const, "provider_response_invalid");
			if (result.commandId !== expected.commandId) protocolFailure("request_identity_mismatch");
		}
	}
}

function supplementalResultEnvelopeV1(
	snapshot: StrictJsonValueV1,
	expected:
		| Exclude<CloudflareValidatedRuntimeEffectTransportV1, { readonly transportFamily: "lifecycle" }>
		| Exclude<CloudflareValidatedRuntimeInspectionTransportV1, { readonly transportFamily: "lifecycle" }>,
): Record<string, StrictJsonValueV1> {
	const envelope = strictProtocolRecordV1(snapshot, ["schemaVersion", "family", "operation", "replica", "result"]);
	requiredLiteralV1(envelope.schemaVersion, [1] as const, "invalid_schema_version");
	if (envelope.family !== expected.transportFamily || envelope.operation !== expected.operation) {
		protocolFailure("invalid_operation");
	}
	assertReplicaV1(envelope.replica);
	if (!equalStrictJsonV1(envelope.replica, expected.replica)) protocolFailure("request_identity_mismatch");
	return envelope;
}

export async function decodeCloudflareRuntimeEffectTransportResultEnvelopeV1(
	input: unknown,
	expected: CloudflareValidatedRuntimeEffectTransportV1,
): Promise<CloudflareRuntimeEffectTransportResultEnvelopeV1> {
	if (expected.transportFamily === "lifecycle") {
		return decodeCloudflareRuntimeEffectResultEnvelopeV1(input, expected);
	}
	const snapshot = strictJsonSnapshotV1(input);
	const envelope = supplementalResultEnvelopeV1(snapshot, expected);
	if (expected.transportFamily === "control") {
		switch (expected.operation) {
			case "renew":
				assertRenewalReceiptV1(envelope.result, expected.request.plan);
				break;
			case "recovery_freeze":
				await assertRecoveryEffectResultV1(envelope.result, expected.request);
				break;
			case "command_start_reconcile":
				assertRuntimeCommandReconcileResultV1(envelope.result, expected.request);
				break;
		}
	} else {
		assertRuntimeBridgeEffectResultV1(expected.operation, envelope.result, expected.request);
	}
	return snapshot as unknown as CloudflareRuntimeEffectTransportResultEnvelopeV1;
}

export async function decodeCloudflareRuntimeInspectionTransportResultEnvelopeV1(
	input: unknown,
	expected: CloudflareValidatedRuntimeInspectionTransportV1,
): Promise<CloudflareRuntimeInspectionTransportResultEnvelopeV1> {
	if (expected.transportFamily === "lifecycle") {
		return decodeCloudflareRuntimeInspectionResultEnvelopeV1(input, expected);
	}
	const snapshot = strictJsonSnapshotV1(input);
	const envelope = supplementalResultEnvelopeV1(snapshot, expected);
	if (expected.transportFamily === "control") {
		switch (expected.operation) {
			case "renew":
				assertRenewalInspectionResultV1(envelope.result, expected.request);
				break;
			case "recovery_freeze":
				await assertRecoveryInspectionResultV1(envelope.result, expected.request);
				break;
			case "command":
				assertRuntimeCommandInspectionResultV1(envelope.result, expected.request);
				break;
		}
	} else {
		await assertRuntimeBridgeInspectionResultV1(expected.operation, envelope.result, expected.request);
	}
	return snapshot as unknown as CloudflareRuntimeInspectionTransportResultEnvelopeV1;
}

export type CloudflareReplicaCacheEvictionPlanV1 = RuntimeReplicaCacheEvictionPlan;
export type CloudflareReplicaCacheEvictionAcceptanceV1 = RuntimeReplicaCacheEvictionAcceptance;
export type CloudflareReplicaCacheEvictionRequestResultV1 = RuntimeReplicaCacheEvictionRequestResult;
export type CloudflareReplicaCacheEvictionInspectResultV1 = RuntimeReplicaCacheEvictionInspectResult;
export type CloudflareReplicaDeleteResultV1 = RuntimeReplicaDeleteResult;
export type CloudflareReplicaDeleteInspectResultV1 = RuntimeReplicaDeleteInspectResult;
export type CloudflareFrozenCheckpointInspectResultV1 = RuntimeFrozenCheckpointInspectResult;
export type CloudflareReplicaCheckpointV1 = ReplicaCheckpoint;
export type CloudflareFrozenCheckpointReferenceV1 = FrozenReplicaCheckpointRef;
export type CloudflareCanonicalWorkspaceCommitReceiptV1 = CanonicalWorkspaceCommitReceipt;
export type CloudflareWorkspaceSnapshotV1 = WorkspaceSnapshot;
