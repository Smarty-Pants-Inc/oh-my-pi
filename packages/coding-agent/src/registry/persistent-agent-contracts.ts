import {
	type RuntimeArch,
	type RuntimeNetwork,
	type RuntimeOs,
	type RuntimeProviderRequestIdentity,
	type RuntimeReplicaCacheEvictionAcceptance,
	type RuntimeReplicaCacheEvictionAcceptancePending,
	type RuntimeReplicaCacheEvictionCompletion,
	type RuntimeReplicaCacheEvictionDeadlineMismatch,
	type RuntimeReplicaCacheEvictionDeferredReason,
	type RuntimeReplicaCacheEvictionPlan,
	type RuntimeReplicaCacheEvictionRejection,
	type RuntimeReplicaDeletionAuthorizationV1,
	type RuntimeReplicaRef,
	type RuntimeStatusSnapshot,
	SAFE_DIAGNOSTIC_MESSAGE_CATALOG_V1,
	type SafeDiagnosticCodeV1,
	type SessionJournalStatusSnapshot,
	type WorkspaceImage,
	type WorkspaceRetentionPolicy,
	type WorkspaceTombstone,
} from "../session/workspace-runtime-contracts.js";

export type ISO8601 = string;
export type Sha256Hex = string;
export type Sha256Ref = `sha256:${string}`;
export type PersistentAgentId = string;
export type TransientTaskId = string;
export type TransientTaskRunId = string;
export type TransientTaskOutcomePayloadId = string;
export type TransientTaskResultPublicationTargetId = string;
export type WorkspaceId = string;
export type OperationId = string;
export type WorkspaceOperationLeaseId = string;
export type WorkspaceControllerLeaseId = string;
export type ProviderRequestId = string;
export type FrozenCheckpointId = string;
export type ProviderId = string;
export type ProfileId = string;
export type ReplicaId = string;
export type RuntimeLeaseId = string;
export type RuntimeFenceId = string;
export type CommandId = string;
export type ManagedWorkspaceSeedSourceId = string;

export type PersistentAgentKind = "main" | "sub";
export type RuntimePlacement = "local" | "cloud" | "auto";
export type RuntimePlacementState = "none" | "acquiring" | "active" | "draining";

export interface WorkspaceCheckpoint {
	readonly workspaceId: WorkspaceId;
	readonly generation: number;
	readonly rootSha256: Sha256Hex;
	readonly fileCount: number;
	readonly byteCount: number;
	readonly committedAt: ISO8601;
}

export interface ManagedWorkspaceRef {
	readonly workspaceId: WorkspaceId;
	readonly mode: "managed";
	readonly format: "omp-text-v1";
	/** Immutable create-time policy copied from validated host configuration. */
	readonly retention: WorkspaceRetentionPolicy;
	readonly checkpoint: WorkspaceCheckpoint;
}

export type ManagedWorkspaceSeed = { readonly kind: "empty" } | { readonly kind: "copy"; readonly sourcePath: string };

export interface PersistentRuntimePolicy {
	readonly placement: RuntimePlacement;
	readonly providerId: ProviderId | null;
	readonly os: RuntimeOs | null;
	readonly arch: RuntimeArch | null;
	readonly minCpu: number;
	readonly minMemoryMiB: number;
	readonly network: RuntimeNetwork;
	readonly maxReadyLatencyMs: number | null;
	readonly idleRuntimeTtlMs: number;
}

export const PERSISTENT_RUNTIME_POLICY_DEFAULTS_V1 = Object.freeze({
	placement: "auto",
	providerId: null,
	os: null,
	arch: null,
	minCpu: 0,
	minMemoryMiB: 0,
	network: "none",
	maxReadyLatencyMs: null,
	idleRuntimeTtlMs: 60000,
} satisfies PersistentRuntimePolicy);

/** Closed partial shape used only by settings and normalized CLI flags. */
export interface PersistentRuntimePolicyOverlayV1 {
	readonly placement?: RuntimePlacement;
	readonly providerId?: ProviderId | null;
	readonly os?: RuntimeOs | null;
	readonly arch?: RuntimeArch | null;
	readonly minCpu?: number;
	readonly minMemoryMiB?: number;
	readonly network?: RuntimeNetwork;
	readonly maxReadyLatencyMs?: number | null;
	readonly idleRuntimeTtlMs?: number;
}

export const PERSISTENT_RUNTIME_POLICY_INTEGER_MAX_V1 = 2_147_483_647 as const;

export type PersistentRuntimePolicyValidationCodeV1 =
	| "runtime_policy_invalid_shape"
	| "runtime_policy_invalid_placement"
	| "runtime_policy_invalid_provider_id"
	| "runtime_policy_invalid_os"
	| "runtime_policy_invalid_arch"
	| "runtime_policy_invalid_min_cpu"
	| "runtime_policy_invalid_min_memory_mib"
	| "runtime_policy_invalid_network"
	| "runtime_policy_invalid_max_ready_latency_ms"
	| "runtime_policy_invalid_idle_runtime_ttl_ms";

export type PersistentRuntimePolicyValidationResultV1 =
	| {
			readonly status: "valid";
			readonly policy: PersistentRuntimePolicy;
	  }
	| {
			readonly status: "invalid";
			readonly code: PersistentRuntimePolicyValidationCodeV1;
	  };

export class PersistentRuntimePolicyValidationError extends Error {
	constructor(readonly code: PersistentRuntimePolicyValidationCodeV1) {
		super(code);
		this.name = "PersistentRuntimePolicyValidationError";
	}
}

const PERSISTENT_RUNTIME_POLICY_KEYS_V1 = [
	"placement",
	"providerId",
	"os",
	"arch",
	"minCpu",
	"minMemoryMiB",
	"network",
	"maxReadyLatencyMs",
	"idleRuntimeTtlMs",
] as const;
function isWellFormedPersistentRuntimePolicyUnicodeV1(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(++index);
			if (next < 0xdc00 || next > 0xdfff) return false;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function snapshotPersistentRuntimePolicyRecordV1(
	value: unknown,
	requireComplete: boolean,
): Readonly<Record<string, unknown>> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return null;
		const keys: string[] = [];
		for (const key of Reflect.ownKeys(value)) {
			if (
				typeof key !== "string" ||
				!PERSISTENT_RUNTIME_POLICY_KEYS_V1.includes(key as (typeof PERSISTENT_RUNTIME_POLICY_KEYS_V1)[number])
			)
				return null;
			keys.push(key);
		}
		if (requireComplete && keys.length !== PERSISTENT_RUNTIME_POLICY_KEYS_V1.length) return null;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const snapshot: Record<string, unknown> = Object.create(null);
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (!descriptor?.enumerable || !("value" in descriptor)) return null;
			snapshot[key] = descriptor.value;
		}
		return Object.freeze(snapshot);
	} catch {
		return null;
	}
}

function isPersistentRuntimePolicyIntegerV1(value: unknown, minimum: number): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		!Object.is(value, -0) &&
		value >= minimum &&
		value <= PERSISTENT_RUNTIME_POLICY_INTEGER_MAX_V1
	);
}

function validatePersistentRuntimePolicyFieldV1(
	key: (typeof PERSISTENT_RUNTIME_POLICY_KEYS_V1)[number],
	value: unknown,
): PersistentRuntimePolicyValidationCodeV1 | null {
	switch (key) {
		case "placement":
			return value === "local" || value === "cloud" || value === "auto" ? null : "runtime_policy_invalid_placement";
		case "providerId":
			return value === null ||
				(typeof value === "string" &&
					value.length > 0 &&
					value.trim() === value &&
					isWellFormedPersistentRuntimePolicyUnicodeV1(value))
				? null
				: "runtime_policy_invalid_provider_id";
		case "os":
			return value === null || value === "darwin" || value === "linux" || value === "windows"
				? null
				: "runtime_policy_invalid_os";
		case "arch":
			return value === null || value === "arm64" || value === "x64" ? null : "runtime_policy_invalid_arch";
		case "minCpu":
			return isPersistentRuntimePolicyIntegerV1(value, 0) ? null : "runtime_policy_invalid_min_cpu";
		case "minMemoryMiB":
			return isPersistentRuntimePolicyIntegerV1(value, 0) ? null : "runtime_policy_invalid_min_memory_mib";
		case "network":
			return value === "none" || value === "egress" ? null : "runtime_policy_invalid_network";
		case "maxReadyLatencyMs":
			return value === null || isPersistentRuntimePolicyIntegerV1(value, 0)
				? null
				: "runtime_policy_invalid_max_ready_latency_ms";
		case "idleRuntimeTtlMs":
			return isPersistentRuntimePolicyIntegerV1(value, 0) ? null : "runtime_policy_invalid_idle_runtime_ttl_ms";
	}
}

/** Strict closed decoder for one complete durable runtime policy. */
export function validatePersistentRuntimePolicyV1(input: unknown): PersistentRuntimePolicyValidationResultV1 {
	const policy = snapshotPersistentRuntimePolicyRecordV1(input, true);
	if (policy === null) return { status: "invalid", code: "runtime_policy_invalid_shape" };
	for (const key of PERSISTENT_RUNTIME_POLICY_KEYS_V1) {
		const code = validatePersistentRuntimePolicyFieldV1(key, policy[key]);
		if (code !== null) return { status: "invalid", code };
	}
	return { status: "valid", policy: policy as unknown as PersistentRuntimePolicy };
}

/** Throws the frozen typed validation error instead of applying a fallback. */
export function decodePersistentRuntimePolicyV1(input: unknown): PersistentRuntimePolicy {
	const result = validatePersistentRuntimePolicyV1(input);
	if (result.status === "invalid") throw new PersistentRuntimePolicyValidationError(result.code);
	return result.policy;
}

/** Strict closed decoder for the settings-only partial overlay. */
export function decodePersistentRuntimePolicyOverlayV1(input: unknown): PersistentRuntimePolicyOverlayV1 {
	const overlay = snapshotPersistentRuntimePolicyRecordV1(input, false);
	if (overlay === null) {
		throw new PersistentRuntimePolicyValidationError("runtime_policy_invalid_shape");
	}
	for (const key of PERSISTENT_RUNTIME_POLICY_KEYS_V1) {
		if (!Object.hasOwn(overlay, key)) continue;
		const code = validatePersistentRuntimePolicyFieldV1(key, overlay[key]);
		if (code !== null) throw new PersistentRuntimePolicyValidationError(code);
	}
	return overlay as PersistentRuntimePolicyOverlayV1;
}

/** Applies one validated overlay to the frozen built-ins and decodes the complete result. */
export function materializePersistentRuntimePolicyV1(input: unknown = {}): PersistentRuntimePolicy {
	const overlay = decodePersistentRuntimePolicyOverlayV1(input);
	return decodePersistentRuntimePolicyV1({ ...PERSISTENT_RUNTIME_POLICY_DEFAULTS_V1, ...overlay });
}

export const PERSISTENT_MODEL_ONLY_TOOL_NAMES = ["checkpoint", "goal", "rewind", "todo"] as const;

export const PERSISTENT_WORKSPACE_TOOL_NAMES = ["bash", "edit", "glob", "grep", "read", "write"] as const;

export const PERSISTENT_TOOL_NAMES = [
	"bash",
	"checkpoint",
	"edit",
	"glob",
	"goal",
	"grep",
	"read",
	"rewind",
	"todo",
	"write",
] as const;

export type PersistentModelOnlyToolName = (typeof PERSISTENT_MODEL_ONLY_TOOL_NAMES)[number];
export type PersistentWorkspaceToolName = (typeof PERSISTENT_WORKSPACE_TOOL_NAMES)[number];
export type PersistentToolName = (typeof PERSISTENT_TOOL_NAMES)[number];

export type PersistentToolOrigin = "omp_core" | "extension" | "mcp" | "custom" | "mounted_device";

export type PersistentUnsupportedToolReason =
	| "host_workspace_access"
	| "host_process_access"
	| "external_agent_spawn"
	| "external_service_access"
	| "unrouted_workspace_access"
	| "untrusted_tool_origin"
	| "missing_persistent_authority";

export type PersistentToolAuthority =
	| {
			readonly kind: "model_only";
			readonly origin: "omp_core";
			readonly contract: "current-agent-control-only-v1";
	  }
	| {
			readonly kind: "workspace_operation";
			readonly origin: "omp_core";
			readonly contract: "runtime-operation-lease-v1";
			readonly tool: PersistentWorkspaceToolName;
	  }
	| {
			readonly kind: "unsupported";
			readonly origin: PersistentToolOrigin;
			readonly reason: PersistentUnsupportedToolReason;
	  };

export const PERSISTENT_TOOL_REGISTRATIONS_V1 = [
	{
		name: "bash",
		implementationId: "omp-core:packages/coding-agent/src/tools/bash.ts#BashTool",
		authority: {
			kind: "workspace_operation",
			origin: "omp_core",
			contract: "runtime-operation-lease-v1",
			tool: "bash",
		},
	},
	{
		name: "checkpoint",
		implementationId: "omp-core:packages/coding-agent/src/tools/checkpoint.ts#CheckpointTool",
		authority: { kind: "model_only", origin: "omp_core", contract: "current-agent-control-only-v1" },
	},
	{
		name: "edit",
		implementationId: "omp-core:packages/coding-agent/src/edit/index.ts#EditTool",
		authority: {
			kind: "workspace_operation",
			origin: "omp_core",
			contract: "runtime-operation-lease-v1",
			tool: "edit",
		},
	},
	{
		name: "glob",
		implementationId: "omp-core:packages/coding-agent/src/tools/glob.ts#GlobTool",
		authority: {
			kind: "workspace_operation",
			origin: "omp_core",
			contract: "runtime-operation-lease-v1",
			tool: "glob",
		},
	},
	{
		name: "goal",
		implementationId: "omp-core:packages/coding-agent/src/goals/tools/goal-tool.ts#GoalTool",
		authority: { kind: "model_only", origin: "omp_core", contract: "current-agent-control-only-v1" },
	},
	{
		name: "grep",
		implementationId: "omp-core:packages/coding-agent/src/tools/grep.ts#GrepTool",
		authority: {
			kind: "workspace_operation",
			origin: "omp_core",
			contract: "runtime-operation-lease-v1",
			tool: "grep",
		},
	},
	{
		name: "read",
		implementationId: "omp-core:packages/coding-agent/src/tools/read.ts#ReadTool",
		authority: {
			kind: "workspace_operation",
			origin: "omp_core",
			contract: "runtime-operation-lease-v1",
			tool: "read",
		},
	},
	{
		name: "rewind",
		implementationId: "omp-core:packages/coding-agent/src/tools/checkpoint.ts#RewindTool",
		authority: { kind: "model_only", origin: "omp_core", contract: "current-agent-control-only-v1" },
	},
	{
		name: "todo",
		implementationId: "omp-core:packages/coding-agent/src/tools/todo.ts#TodoTool",
		authority: { kind: "model_only", origin: "omp_core", contract: "current-agent-control-only-v1" },
	},
	{
		name: "write",
		implementationId: "omp-core:packages/coding-agent/src/tools/write.ts#WriteTool",
		authority: {
			kind: "workspace_operation",
			origin: "omp_core",
			contract: "runtime-operation-lease-v1",
			tool: "write",
		},
	},
] as const;

Object.freeze(PERSISTENT_MODEL_ONLY_TOOL_NAMES);
Object.freeze(PERSISTENT_WORKSPACE_TOOL_NAMES);
Object.freeze(PERSISTENT_TOOL_NAMES);
for (const registration of PERSISTENT_TOOL_REGISTRATIONS_V1) {
	Object.freeze(registration.authority);
	Object.freeze(registration);
}
Object.freeze(PERSISTENT_TOOL_REGISTRATIONS_V1);

export type PersistentToolRegistration = (typeof PERSISTENT_TOOL_REGISTRATIONS_V1)[number];

export const PERSISTENT_TOOL_FINGERPRINT_SHA256_V1 =
	"6eafccb2c02b3f680add474860fcd5aaf21a71739fb3a14319d3f7f157601f45" as const;

export interface PersistentToolSet {
	readonly registrations: typeof PERSISTENT_TOOL_REGISTRATIONS_V1;
	readonly activeNames: typeof PERSISTENT_TOOL_NAMES;
	readonly fingerprintSha256: typeof PERSISTENT_TOOL_FINGERPRINT_SHA256_V1;
}

export interface PersistentAgentSessionRef {
	readonly sessionId: string;
	/** Relative logical key below the normalized agent session prefix. */
	readonly sessionStorageKey: string;
	/** Preallocated before the session header or initialization entry is written. */
	readonly sessionInitEntryId: string;
}

export interface ManagedWorkspaceSeedLimitsV1 {
	readonly maxFiles: number;
	readonly maxFileBytes: number;
	readonly maxTotalBytes: number;
	readonly deniedPatterns: readonly string[];
}

export interface ManagedWorkspaceSeedSourceRefV1 {
	readonly sourceId: ManagedWorkspaceSeedSourceId;
	readonly bindId: OperationId;
	readonly expectedImage: WorkspaceImage;
	readonly limits: ManagedWorkspaceSeedLimitsV1;
}

export type PersistentManagedWorkspaceSeedPlanV1 =
	| {
			readonly kind: "empty";
			readonly expectedImage: WorkspaceImage;
	  }
	| {
			readonly kind: "copy";
			/** Opaque reference resolved only by the trusted seed-source authority. */
			readonly source: ManagedWorkspaceSeedSourceRefV1;
	  };

export type KnownReplicaObservationV1 =
	| { readonly state: "never_observed" }
	| {
			readonly state: "present" | "retained";
			readonly observedAt: ISO8601;
			readonly image: WorkspaceImage | null;
	  }
	| {
			/** Provider-cache bytes are absent; this is never final deletion proof. */
			readonly state: "absent";
			readonly observedAt: ISO8601;
	  }
	| {
			readonly state: "unknown";
			readonly observedAt: ISO8601;
			readonly code: SafeDiagnosticCodeV1;
	  };

export type KnownReplicaCacheEvictionProgressV1 =
	| { readonly state: "not_started" }
	| { readonly state: "submission_outcome_unknown" }
	| {
			readonly state: "inspection_pending";
			readonly pending: RuntimeReplicaCacheEvictionAcceptancePending;
	  }
	| {
			readonly state: "accepted";
			readonly acceptance: RuntimeReplicaCacheEvictionAcceptance;
	  }
	| {
			readonly state: "deferred";
			readonly acceptance: RuntimeReplicaCacheEvictionAcceptance;
			readonly reason: RuntimeReplicaCacheEvictionDeferredReason;
			readonly nextAttemptAt: ISO8601;
	  }
	| {
			readonly state: "rejected";
			readonly rejection: RuntimeReplicaCacheEvictionRejection;
	  }
	| {
			readonly state: "deadline_mismatch";
			readonly mismatch: RuntimeReplicaCacheEvictionDeadlineMismatch;
	  };

export type KnownReplicaCacheEvictionV1 =
	| { readonly state: "not_requested" }
	| {
			readonly state: "pending";
			readonly plan: RuntimeReplicaCacheEvictionPlan;
			readonly attempts: number;
			readonly lastAttemptAt: ISO8601 | null;
			readonly progress: KnownReplicaCacheEvictionProgressV1;
	  }
	| {
			readonly state: "complete";
			readonly plan: RuntimeReplicaCacheEvictionPlan;
			readonly result: RuntimeReplicaCacheEvictionCompletion;
	  };

export type KnownReplicaCleanupV1 =
	| { readonly state: "not_requested" }
	| {
			readonly state: "pending";
			readonly request: RuntimeProviderRequestIdentity;
			readonly attempts: number;
			readonly lastAttemptAt: ISO8601 | null;
			readonly lastResult: "cleanup_pending" | "transport_unknown" | null;
			readonly nextAttemptAt: ISO8601 | null;
	  }
	| {
			/** Durable failed attempt; retry reuses this exact request identity. */
			readonly state: "failed";
			readonly request: RuntimeProviderRequestIdentity;
			readonly attempts: number;
			readonly failedAt: ISO8601;
			readonly code: SafeDiagnosticCodeV1;
			readonly retryable: boolean;
			readonly nextRetryAt: ISO8601 | null;
	  }
	| {
			readonly state: "complete";
			readonly request: RuntimeProviderRequestIdentity;
			readonly outcome: "deleted" | "already_deleted" | "absent";
			readonly completedAt: ISO8601;
			readonly receiptSha256: Sha256Ref;
	  };

export interface KnownReplicaRecordV1 {
	readonly replica: RuntimeReplicaRef;
	/** Persisted before the first provider side effect for this replica identity. */
	readonly plannedByOperationId: OperationId;
	/** Frozen provider-deletion domain; persistent catalog rows are always persistent. */
	readonly deletionAuthorityDomain: RuntimeReplicaDeletionAuthorizationV1["domain"];
	readonly firstPlannedAt: ISO8601;
	readonly lastLeaseId: RuntimeLeaseId | null;
	readonly observation: KnownReplicaObservationV1;
	/** Noncanonical provider-cache reclamation; orthogonal to cleanup. */
	readonly cacheEviction: KnownReplicaCacheEvictionV1;
	/** Canonical-tombstone-driven final replica cleanup only. */
	readonly cleanup: KnownReplicaCleanupV1;
}

export interface KnownReplicaCatalogV1 {
	readonly revision: number;
	/** Unique and UTF-8 sorted by providerId/profileId/replicaId. */
	readonly entries: readonly KnownReplicaRecordV1[];
}

export interface WorkspaceReplicaDeletePlanCoreV1 {
	readonly replica: RuntimeReplicaRef;
	readonly deletionAuthorityDomain: "persistent";
	/** Preallocated before the core digest; never replaced after publication. */
	readonly requestId: ProviderRequestId;
}

/**
 * First durable deletion stage. This closed value contains every input needed
 * to derive the exact tombstone and every persistent replica-delete digest,
 * but contains no requestSha256 or final deletion-plan digest.
 */
export interface WorkspaceDeletionPlanCoreV1 {
	readonly deleteId: OperationId;
	readonly deletionAuthorityId: OperationId;
	readonly quarantineId: OperationId;
	readonly workspaceId: WorkspaceId;
	readonly expectedCheckpoint: WorkspaceCheckpoint;
	readonly expectedRuntimeAttachmentCreateId: OperationId;
	readonly expectedRuntimeAttachmentRevision: number;
	readonly expectedKnownReplicaCatalogRevision: number;
	/** One canonical UTC millisecond instant read once while constructing the core. */
	readonly plannedDeletionAt: ISO8601;
	readonly deletedBytesGraceMs: number;
	/** Exactly plannedDeletionAt + deletedBytesGraceMs, checked and frozen. */
	readonly purgeAfter: ISO8601;
	/** Frozen after runtime reaches none; unique and UTF-8 replica-key sorted. */
	readonly replicaRequests: readonly WorkspaceReplicaDeletePlanCoreV1[];
}

export interface WorkspaceReplicaDeletePlanV1 {
	readonly replica: RuntimeReplicaRef;
	readonly deletionAuthorityDomain: "persistent";
	readonly request: RuntimeProviderRequestIdentity;
}

export interface TerminalReplicaCleanupEntryProofV1 {
	readonly replica: RuntimeReplicaRef;
	readonly deletionAuthorityDomain: "persistent";
	readonly request: RuntimeProviderRequestIdentity;
	readonly outcome: "deleted" | "already_deleted" | "absent";
	readonly completedAt: ISO8601;
	readonly receiptSha256: Sha256Ref;
}

export interface TerminalReplicaCleanupProofV1 {
	readonly schemaVersion: 1;
	readonly workspaceId: WorkspaceId;
	readonly deleteId: OperationId;
	readonly catalogRevision: number;
	/** SHA-256 reference of the exact deletion-plan-core tuple in §7.4. */
	readonly deletionPlanCoreSha256: Sha256Ref;
	/** SHA-256 reference of the exact complete deletion-plan tuple in §7.4. */
	readonly deletionPlanSha256: Sha256Ref;
	/** Unique and UTF-8 sorted by providerId/profileId/replicaId. */
	readonly entries: readonly TerminalReplicaCleanupEntryProofV1[];
	readonly verifiedAt: ISO8601;
	/** SHA-256 reference of the exact terminal-cleanup tuple in §7.4. */
	readonly proofSha256: Sha256Ref;
}

/**
 * Second durable deletion stage. Each entry must match the corresponding core
 * replica/domain/requestId and add only its non-circular requestSha256.
 */
export interface WorkspaceDeletionPlanV1 {
	readonly core: WorkspaceDeletionPlanCoreV1;
	readonly replicaRequests: readonly WorkspaceReplicaDeletePlanV1[];
}

export type PersistentCanonicalWorkspaceStateV1 =
	| {
			readonly state: "present";
			readonly workspace: ManagedWorkspaceRef;
	  }
	| {
			/** Core and its digest are durable before any request hash is finalized. */
			readonly state: "delete_core_planned";
			readonly workspace: ManagedWorkspaceRef;
			readonly deletionCore: WorkspaceDeletionPlanCoreV1;
			readonly deletionPlanCoreSha256: Sha256Ref;
	  }
	| {
			/** Complete plan and both digests are durable before deletion effects. */
			readonly state: "delete_planned";
			readonly workspace: ManagedWorkspaceRef;
			readonly deletion: WorkspaceDeletionPlanV1;
			readonly deletionPlanCoreSha256: Sha256Ref;
			readonly deletionPlanSha256: Sha256Ref;
	  }
	| {
			readonly state: "tombstoned";
			readonly tombstone: WorkspaceTombstone;
			readonly deletion: WorkspaceDeletionPlanV1;
			readonly deletionPlanCoreSha256: Sha256Ref;
			readonly deletionPlanSha256: Sha256Ref;
			readonly cleanupProof: TerminalReplicaCleanupProofV1 | null;
	  }
	| {
			readonly state: "purged";
			readonly tombstone: WorkspaceTombstone;
			readonly deletion: WorkspaceDeletionPlanV1;
			readonly deletionPlanCoreSha256: Sha256Ref;
			readonly deletionPlanSha256: Sha256Ref;
			readonly cleanupProof: TerminalReplicaCleanupProofV1;
			readonly purgedAt: ISO8601;
	  };

export interface PersistentWorkspaceAuthorityV1 {
	readonly workspaceId: WorkspaceId;
	readonly canonical: PersistentCanonicalWorkspaceStateV1;
	readonly knownReplicas: KnownReplicaCatalogV1;
}

export type PersistentAgentOperationalPhase =
	| "creating"
	| "open"
	| "parking"
	| "parked"
	| "reviving"
	| "forking"
	| "releasing"
	| "released";
export type PersistentAgentSteadyPhase = "open" | "parked" | "released";
export type PersistentAgentTransientPhase = "creating" | "parking" | "reviving" | "forking" | "releasing";
export type PersistentAgentPhase = PersistentAgentOperationalPhase | "recovery_required";
export type PersistentAgentReportedPhase = PersistentAgentPhase | "unknown";

export interface PersistentAgentPlanBaseV1 {
	readonly operationId: OperationId;
	readonly startedAt: ISO8601;
	readonly startedFromRevision: number;
}

export interface PersistentAgentCreateResourcesV1 {
	readonly workspaceId: WorkspaceId;
	readonly workspaceCreateId: OperationId;
	readonly workspaceStageId: OperationId;
	readonly sessionCreateId: OperationId;
	readonly session: PersistentAgentSessionRef;
	/** Sole identity accepted by runtime-attachment create/inspect/abort recovery. */
	readonly runtimeAttachmentCreateId: OperationId;
	// Controller leases are live ownership-scoped capabilities and deliberately absent.
}

export interface PersistentAgentCreatePlanV1 extends PersistentAgentPlanBaseV1 {
	readonly kind: "create";
	readonly resources: PersistentAgentCreateResourcesV1;
	readonly seed: PersistentManagedWorkspaceSeedPlanV1;
	/** Complete create-time policy, durable before canonical workspace creation. */
	readonly retention: WorkspaceRetentionPolicy;
	/** Digest of the exact canonical session_init payload expected at its ID. */
	readonly sessionInitPayloadSha256: Sha256Ref;
}

export type PersistentAgentCreateProgressV1 =
	| { readonly step: "planned" }
	| {
			readonly step: "workspace_ready";
			readonly workspace: PersistentWorkspaceAuthorityV1;
	  }
	| {
			readonly step: "session_header_ready";
			readonly workspace: PersistentWorkspaceAuthorityV1;
			readonly session: PersistentAgentSessionRef;
	  }
	| {
			readonly step: "session_initialized";
			readonly workspace: PersistentWorkspaceAuthorityV1;
			readonly session: PersistentAgentSessionRef;
	  }
	| {
			readonly step: "runtime_none_initialized";
			readonly workspace: PersistentWorkspaceAuthorityV1;
			readonly session: PersistentAgentSessionRef;
			readonly runtimeAttachmentRevision: number;
	  };

export interface PersistentAgentCreateOperationV1 {
	readonly kind: "create";
	readonly plan: PersistentAgentCreatePlanV1;
	readonly progress: PersistentAgentCreateProgressV1;
}

export interface PersistentAgentParkPlanV1 extends PersistentAgentPlanBaseV1 {
	readonly kind: "park";
	readonly sourceSession: PersistentAgentSessionRef;
	readonly workspaceId: WorkspaceId;
	readonly expectedGeneration: number;
	readonly runtimeTransitionId: OperationId;
}

export type PersistentAgentParkProgressV1 =
	| { readonly step: "planned" }
	| { readonly step: "runtime_none"; readonly checkpoint: WorkspaceCheckpoint }
	| { readonly step: "session_durable"; readonly checkpoint: WorkspaceCheckpoint }
	| { readonly step: "session_disposed"; readonly checkpoint: WorkspaceCheckpoint };

export interface PersistentAgentParkOperationV1 {
	readonly kind: "park";
	readonly plan: PersistentAgentParkPlanV1;
	readonly progress: PersistentAgentParkProgressV1;
}

export interface PersistentAgentRevivePlanV1 extends PersistentAgentPlanBaseV1 {
	readonly kind: "revive";
	readonly session: PersistentAgentSessionRef;
	readonly workspaceId: WorkspaceId;
	readonly expectedGeneration: number;
	readonly runtimeReconcileTransitionId: OperationId;
	readonly sessionOpenId: OperationId;
}

export type PersistentAgentReviveProgressV1 =
	| { readonly step: "planned" }
	| { readonly step: "runtime_none"; readonly checkpoint: WorkspaceCheckpoint };

export interface PersistentAgentReviveOperationV1 {
	readonly kind: "revive";
	readonly plan: PersistentAgentRevivePlanV1;
	readonly progress: PersistentAgentReviveProgressV1;
}

export interface PersistentAgentForkPlanV1 extends PersistentAgentPlanBaseV1 {
	readonly kind: "fork";
	readonly source: PersistentAgentSessionRef;
	/** Complete before source flush or target creation. */
	readonly target: PersistentAgentSessionRef;
	readonly targetCreateId: OperationId;
	readonly workspaceId: WorkspaceId;
	readonly expectedGeneration: number;
}

export type PersistentAgentForkProgressV1 =
	| { readonly step: "planned" }
	| {
			readonly step: "target_durable";
			readonly target: PersistentAgentSessionRef;
			readonly targetSha256: Sha256Ref;
	  };

export interface PersistentAgentForkOperationV1 {
	readonly kind: "fork";
	readonly plan: PersistentAgentForkPlanV1;
	readonly progress: PersistentAgentForkProgressV1;
}

export type PersistentAgentReleaseDispositionV1 =
	| { readonly kind: "retain" }
	| {
			readonly kind: "delete";
			readonly deleteId: OperationId;
			readonly deletionAuthorityId: OperationId;
			readonly quarantineId: OperationId;
			readonly deletedBytesGraceMs: number;
	  };

export interface PersistentAgentReleasePlanV1 extends PersistentAgentPlanBaseV1 {
	readonly kind: "release";
	readonly sourceSession: PersistentAgentSessionRef;
	readonly workspaceId: WorkspaceId;
	readonly runtimeTransitionId: OperationId;
	readonly disposition: PersistentAgentReleaseDispositionV1;
}

export type PersistentAgentReleaseProgressV1 =
	| { readonly step: "planned" }
	| {
			readonly step: "runtime_none";
			readonly workspace: PersistentWorkspaceAuthorityV1;
	  }
	| {
			readonly step: "session_closed";
			readonly workspace: PersistentWorkspaceAuthorityV1;
	  }
	| {
			readonly step: "deletion_core_planned";
			readonly workspace: PersistentWorkspaceAuthorityV1;
			readonly deletionCore: WorkspaceDeletionPlanCoreV1;
			readonly deletionPlanCoreSha256: Sha256Ref;
	  }
	| {
			readonly step: "delete_planned";
			readonly workspace: PersistentWorkspaceAuthorityV1;
			readonly deletion: WorkspaceDeletionPlanV1;
			readonly deletionPlanCoreSha256: Sha256Ref;
			readonly deletionPlanSha256: Sha256Ref;
	  }
	| {
			readonly step: "workspace_disposition_applied";
			readonly workspace: PersistentWorkspaceAuthorityV1;
	  };

export interface PersistentAgentReleaseOperationV1 {
	readonly kind: "release";
	readonly plan: PersistentAgentReleasePlanV1;
	readonly progress: PersistentAgentReleaseProgressV1;
}

export type PersistentAgentOperationV1 =
	| PersistentAgentCreateOperationV1
	| PersistentAgentParkOperationV1
	| PersistentAgentReviveOperationV1
	| PersistentAgentForkOperationV1
	| PersistentAgentReleaseOperationV1;

export interface PersistentAgentRecordCommonV1 {
	readonly schemaVersion: 1;
	readonly revision: number;
	readonly controlHostId: string;
	readonly agentId: PersistentAgentId;
	readonly displayName: string;
	readonly kind: PersistentAgentKind;
	readonly parentAgentId: PersistentAgentId | null;
	readonly modelProfileId: string;
	readonly runtimePolicy: PersistentRuntimePolicy;
	readonly createdAt: ISO8601;
	readonly updatedAt: ISO8601;
}

export interface PersistentAgentCreatingRecordV1 extends PersistentAgentRecordCommonV1 {
	readonly phase: "creating";
	readonly operation: PersistentAgentCreateOperationV1;
	readonly releasedAt: null;
}

export interface PersistentAgentOpenRecordV1 extends PersistentAgentRecordCommonV1 {
	readonly phase: "open";
	readonly operation: null;
	readonly session: PersistentAgentSessionRef;
	readonly workspace: PersistentWorkspaceAuthorityV1;
	readonly releasedAt: null;
}

export interface PersistentAgentParkingRecordV1 extends PersistentAgentRecordCommonV1 {
	readonly phase: "parking";
	readonly operation: PersistentAgentParkOperationV1;
	readonly session: PersistentAgentSessionRef;
	readonly workspace: PersistentWorkspaceAuthorityV1;
	readonly releasedAt: null;
}

export interface PersistentAgentParkedRecordV1 extends PersistentAgentRecordCommonV1 {
	readonly phase: "parked";
	readonly operation: null;
	readonly session: PersistentAgentSessionRef;
	readonly workspace: PersistentWorkspaceAuthorityV1;
	readonly releasedAt: null;
}

export interface PersistentAgentRevivingRecordV1 extends PersistentAgentRecordCommonV1 {
	readonly phase: "reviving";
	readonly operation: PersistentAgentReviveOperationV1;
	readonly session: PersistentAgentSessionRef;
	readonly workspace: PersistentWorkspaceAuthorityV1;
	readonly releasedAt: null;
}

export interface PersistentAgentForkingRecordV1 extends PersistentAgentRecordCommonV1 {
	readonly phase: "forking";
	readonly operation: PersistentAgentForkOperationV1;
	readonly session: PersistentAgentSessionRef;
	readonly workspace: PersistentWorkspaceAuthorityV1;
	readonly releasedAt: null;
}

export interface PersistentAgentReleasingRecordV1 extends PersistentAgentRecordCommonV1 {
	readonly phase: "releasing";
	readonly operation: PersistentAgentReleaseOperationV1;
	readonly session: PersistentAgentSessionRef;
	readonly workspace: PersistentWorkspaceAuthorityV1;
	readonly releasedAt: null;
}

export interface PersistentAgentReleaseReceiptV1 {
	readonly operationId: OperationId;
	readonly disposition: PersistentAgentReleaseDispositionV1;
	readonly completedAt: ISO8601;
}

export interface PersistentAgentReleasedRecordV1 extends PersistentAgentRecordCommonV1 {
	readonly phase: "released";
	readonly operation: null;
	readonly session: PersistentAgentSessionRef;
	readonly workspace: PersistentWorkspaceAuthorityV1;
	readonly release: PersistentAgentReleaseReceiptV1;
	readonly releasedAt: ISO8601;
}

export type PersistentAgentRecoveryCode =
	| "interrupted_create"
	| "interrupted_open"
	| "interrupted_park"
	| "interrupted_revive"
	| "interrupted_fork"
	| "interrupted_release"
	| "record_invalid"
	| "record_revision_conflict"
	| "wrong_control_host"
	| "seed_source_binding_missing"
	| "seed_source_changed"
	| "workspace_missing"
	| "workspace_identity_mismatch"
	| "session_missing"
	| "session_invalid"
	| "session_identity_mismatch"
	| "session_init_missing"
	| "session_dispose_failed"
	| "primary_persistence_indeterminate"
	| "runtime_reconciliation_blocked"
	| "runtime_preservation_impossible"
	| "cleanup_failed";

export interface PersistentAgentRecoveryDetailsV1 {
	readonly code: PersistentAgentRecoveryCode;
	readonly operationId: OperationId | null;
	readonly detectedAt: ISO8601;
}

export type PersistentAgentRecoveryContextV1 =
	| {
			readonly failedPhase: "creating";
			readonly operation: PersistentAgentCreateOperationV1;
	  }
	| {
			readonly failedPhase: "open";
			readonly operation: null;
			readonly session: PersistentAgentSessionRef;
			readonly workspace: PersistentWorkspaceAuthorityV1;
	  }
	| {
			readonly failedPhase: "parking";
			readonly operation: PersistentAgentParkOperationV1;
			readonly session: PersistentAgentSessionRef;
			readonly workspace: PersistentWorkspaceAuthorityV1;
	  }
	| {
			readonly failedPhase: "parked";
			readonly operation: null;
			readonly session: PersistentAgentSessionRef;
			readonly workspace: PersistentWorkspaceAuthorityV1;
	  }
	| {
			readonly failedPhase: "reviving";
			readonly operation: PersistentAgentReviveOperationV1;
			readonly session: PersistentAgentSessionRef;
			readonly workspace: PersistentWorkspaceAuthorityV1;
	  }
	| {
			readonly failedPhase: "forking";
			readonly operation: PersistentAgentForkOperationV1;
			readonly session: PersistentAgentSessionRef;
			readonly workspace: PersistentWorkspaceAuthorityV1;
	  }
	| {
			readonly failedPhase: "releasing";
			readonly operation: PersistentAgentReleaseOperationV1;
			readonly session: PersistentAgentSessionRef;
			readonly workspace: PersistentWorkspaceAuthorityV1;
	  };

export interface PersistentAgentRecoveryRequiredRecordV1 extends PersistentAgentRecordCommonV1 {
	readonly phase: "recovery_required";
	readonly recovery: PersistentAgentRecoveryDetailsV1 & PersistentAgentRecoveryContextV1;
}

export type PersistentAgentOperationalRecordV1 =
	| PersistentAgentCreatingRecordV1
	| PersistentAgentOpenRecordV1
	| PersistentAgentParkingRecordV1
	| PersistentAgentParkedRecordV1
	| PersistentAgentRevivingRecordV1
	| PersistentAgentForkingRecordV1
	| PersistentAgentReleasingRecordV1
	| PersistentAgentReleasedRecordV1;

export type PersistentAgentRecordV1 = PersistentAgentOperationalRecordV1 | PersistentAgentRecoveryRequiredRecordV1;

export type PersistentAgentInvalidRecordReason =
	| "invalid_json"
	| "unsupported_schema"
	| "invalid_fields"
	| "agent_key_mismatch"
	| "invalid_phase_relationship";

export type PersistentAgentLookup =
	| { readonly kind: "missing"; readonly agentId: PersistentAgentId }
	| { readonly kind: "record"; readonly record: PersistentAgentRecordV1 }
	| {
			readonly kind: "invalid";
			readonly agentId: PersistentAgentId;
			readonly recordStorageKey: string;
			readonly reason: PersistentAgentInvalidRecordReason;
	  };

export type PersistentAgentOwnershipIntent =
	| "create"
	| "open"
	| "revive"
	| "park"
	| "fork"
	| "release"
	| "recover"
	| "delete_workspace"
	| "purge_workspace";

export type PersistentAgentOwnershipState =
	| "unowned"
	| "owned_here"
	| "owned_elsewhere"
	| "interrupted"
	| "unavailable";

export interface PersistentAgentOwnershipStatus {
	readonly state: PersistentAgentOwnershipState;
	readonly controlHostId: string;
	readonly processId: number | null;
	readonly intent: PersistentAgentOwnershipIntent | null;
	readonly acquiredAt: ISO8601 | null;
}

export interface PersistentAgentOwnershipEpochRecordV1 {
	readonly schemaVersion: 1;
	readonly agentId: PersistentAgentId;
	readonly controlHostId: string;
	readonly ownerEpoch: number;
	readonly updatedAt: ISO8601;
}

/**
 * Non-serializable registry capability checked synchronously at durable record publication.
 * False or a thrown check is a revision conflict; callers must never retry with a new guard.
 */
export interface PersistentAgentRecordCommitGuardV1 {
	isCurrent(): boolean;
}

export interface PersistentAgentOwnership {
	readonly agentId: PersistentAgentId;
	readonly controlHostId: string;
	readonly intent: PersistentAgentOwnershipIntent;
	readonly ownerEpoch: number;
	readonly acquiredAt: ISO8601;
	isHeld(): boolean;
	read(): Promise<PersistentAgentLookup>;
	insert(record: PersistentAgentCreatingRecordV1): Promise<PersistentAgentCreatingRecordV1>;
	replace(
		expectedRevision: number,
		next: PersistentAgentRecordV1,
		commitGuard: PersistentAgentRecordCommitGuardV1,
	): Promise<PersistentAgentRecordV1>;
	/** Allowed only after every resource in the create plan is proved absent. */
	deleteCreating(expectedRevision: number): Promise<void>;
	close(): Promise<void>;
}

export interface PersistentAgentStore {
	readonly controlHostId: string;
	lookup(agentId: PersistentAgentId, signal?: AbortSignal): Promise<PersistentAgentLookup>;
	list(signal?: AbortSignal): Promise<readonly PersistentAgentLookup[]>;
	inspectOwnership(agentId: PersistentAgentId, signal?: AbortSignal): Promise<PersistentAgentOwnershipStatus>;
	acquire(
		agentId: PersistentAgentId,
		intent: PersistentAgentOwnershipIntent,
		signal?: AbortSignal,
	): Promise<PersistentAgentOwnership>;
}

export type PersistentAgentPublicState =
	| "creating"
	| "running"
	| "idle"
	| "open"
	| "parking"
	| "parked"
	| "reviving"
	| "forking"
	| "releasing"
	| "released"
	| "recovery_required";

export type PersistentAgentSessionHealth =
	| "absent"
	| "planned"
	| "present"
	| "missing"
	| "invalid"
	| "identity_mismatch";

export type PersistentAgentWorkspaceHealth =
	| "planned"
	| "present"
	| "missing"
	| "identity_mismatch"
	| "tombstoned"
	| "purged";

export type PersistentWorkspaceDeletionStateV1 =
	| "retained"
	| "delete_core_planned"
	| "delete_planned"
	| "cleanup_pending"
	| "tombstoned"
	| "purge_due"
	| "purged";

export type PersistentWorkspaceDeletionStatusV1 = {
	readonly workspaceId: WorkspaceId;
	readonly knownReplicaCount: number;
	readonly cacheEvictionPendingCount: number;
	readonly cacheEvictionCompleteCount: number;
	readonly cleanupCompleteCount: number;
	readonly cleanupPendingCount: number;
	readonly cleanupFailedCount: number;
} & (
	| {
			readonly state: "retained";
			readonly deleteId: null;
			readonly deletionPlanCoreSha256: null;
			readonly deletionPlanSha256: null;
			readonly tombstone: null;
			readonly purgeAfter: null;
	  }
	| {
			readonly state: "delete_core_planned";
			readonly deleteId: OperationId;
			readonly deletionPlanCoreSha256: Sha256Ref;
			readonly deletionPlanSha256: null;
			readonly tombstone: null;
			readonly purgeAfter: ISO8601;
	  }
	| {
			readonly state: "delete_planned";
			readonly deleteId: OperationId;
			readonly deletionPlanCoreSha256: Sha256Ref;
			readonly deletionPlanSha256: Sha256Ref;
			readonly tombstone: null;
			readonly purgeAfter: ISO8601;
	  }
	| {
			readonly state: "cleanup_pending";
			readonly deleteId: OperationId;
			readonly deletionPlanCoreSha256: Sha256Ref;
			readonly deletionPlanSha256: Sha256Ref;
			readonly tombstone: WorkspaceTombstone;
			readonly purgeAfter: ISO8601;
	  }
	| {
			readonly state: "tombstoned";
			readonly deleteId: OperationId;
			readonly deletionPlanCoreSha256: Sha256Ref;
			readonly deletionPlanSha256: Sha256Ref;
			readonly tombstone: WorkspaceTombstone;
			readonly purgeAfter: ISO8601;
	  }
	| {
			readonly state: "purge_due";
			readonly deleteId: OperationId;
			readonly deletionPlanCoreSha256: Sha256Ref;
			readonly deletionPlanSha256: Sha256Ref;
			readonly tombstone: WorkspaceTombstone;
			readonly purgeAfter: ISO8601;
	  }
	| {
			readonly state: "purged";
			readonly deleteId: OperationId;
			readonly deletionPlanCoreSha256: Sha256Ref;
			readonly deletionPlanSha256: Sha256Ref;
			readonly tombstone: WorkspaceTombstone;
			readonly purgeAfter: ISO8601;
	  }
);

export type PersistentAgentRecoveryAction =
	| "retry-create"
	| "resume"
	| "finish-park"
	| "finish-fork"
	| "finish-release"
	| "discard-creation"
	| "discard-runtime-changes";

export interface PersistentAgentStatusRecovery {
	readonly code: PersistentAgentRecoveryCode;
	readonly failedPhase: PersistentAgentOperationalPhase | "unknown";
	readonly operationId: OperationId | null;
	readonly detectedAt: ISO8601;
	readonly actions: readonly PersistentAgentRecoveryAction[];
}

export interface PersistentAgentPresentStatus {
	readonly kind: "present";
	readonly agentId: PersistentAgentId;
	readonly displayName: string;
	readonly agentKind: PersistentAgentKind;
	readonly parentAgentId: PersistentAgentId | null;
	readonly recordRevision: number;
	readonly recordPhase: PersistentAgentPhase;
	readonly state: PersistentAgentPublicState;
	readonly ownership: PersistentAgentOwnershipStatus;
	readonly session: {
		readonly identity: PersistentAgentSessionRef | null;
		readonly materialized: boolean;
		readonly health: PersistentAgentSessionHealth;
	};
	readonly workspace: {
		readonly workspaceId: WorkspaceId | null;
		readonly authority: PersistentWorkspaceAuthorityV1 | null;
		readonly health: PersistentAgentWorkspaceHealth;
		readonly deletion: PersistentWorkspaceDeletionStatusV1 | null;
	};
	readonly runtime: RuntimeStatusSnapshot;
	/** Exact complete policy from the current runtime-validated agent record. */
	readonly runtimePolicy: PersistentRuntimePolicy;
	readonly journal: SessionJournalStatusSnapshot;
	readonly tools: PersistentToolSet | null;
	readonly modelProfileId: string;
	readonly recovery: PersistentAgentStatusRecovery | null;
	readonly updatedAt: ISO8601;
	readonly releasedAt: ISO8601 | null;
}

export type PersistentAgentStatus =
	| { readonly kind: "missing"; readonly agentId: PersistentAgentId }
	| {
			readonly kind: "invalid";
			readonly agentId: PersistentAgentId;
			readonly recordPhase: "unknown";
			readonly state: "recovery_required";
			readonly ownership: PersistentAgentOwnershipStatus;
			readonly recovery: PersistentAgentStatusRecovery & {
				readonly code: "record_invalid";
				readonly failedPhase: "unknown";
				readonly operationId: null;
				readonly actions: readonly [];
			};
	  }
	| PersistentAgentPresentStatus;

export type PersistentAgentErrorCode =
	| "invalid_agent_id"
	| "not_found"
	| "already_exists"
	| "released"
	| "owned_elsewhere"
	| "ownership_unavailable"
	| "wrong_control_host"
	| "invalid_record"
	| "revision_conflict"
	| "recovery_required"
	| "invalid_transition"
	| "unsupported_operation"
	| "workspace_already_deleted"
	| "workspace_delete_conflict"
	| "workspace_purge_not_due";

export class PersistentAgentError extends Error {
	constructor(
		readonly code: PersistentAgentErrorCode,
		readonly agentId: PersistentAgentId,
		readonly retryable: boolean,
		readonly diagnosticCode: SafeDiagnosticCodeV1,
	) {
		super(SAFE_DIAGNOSTIC_MESSAGE_CATALOG_V1[diagnosticCode]);
		this.name = "PersistentAgentError";
	}
}

export interface CreatePersistentAgentOptions {
	readonly id: PersistentAgentId;
	readonly displayName?: string;
	readonly kind?: PersistentAgentKind;
	readonly parentAgentId?: PersistentAgentId;
	readonly workspace: ManagedWorkspaceSeed;
	readonly modelProfileId: string;
	readonly runtimePolicy: PersistentRuntimePolicy;
	readonly signal?: AbortSignal;
}

export interface OpenPersistentAgentOptions {
	readonly recovery?: "safe" | "none";
	readonly signal?: AbortSignal;
}

export interface ReleasePersistentAgentOptions {
	readonly deleteWorkspace?: boolean;
	readonly deletedBytesGraceMs?: number;
	readonly signal?: AbortSignal;
}

export interface RecoverPersistentAgentOptions {
	readonly action: PersistentAgentRecoveryAction;
	/**
	 * Transient trusted path accepted only when `retry-create` repairs
	 * `seed_source_binding_missing`; never persisted, surfaced, or logged.
	 */
	readonly copySourcePath?: string;
	readonly signal?: AbortSignal;
}

export interface DeletePersistentAgentWorkspaceOptions {
	readonly deletedBytesGraceMs?: number;
	readonly signal?: AbortSignal;
}

export interface PersistentAgentForkResult {
	readonly previous: PersistentAgentSessionRef;
	readonly current: PersistentAgentSessionRef;
	readonly status: PersistentAgentPresentStatus;
}

/**
 * A temporary clean-parked caller receives either member only after releasing
 * its exact controller proof and then closing its temporary ownership; the
 * returned status therefore reports `ownership.state === "unowned"`. A live
 * owned handle retains both authorities.
 */
export type PersistentRuntimePolicyUpdateResultV1 =
	| {
			readonly changed: false;
			readonly previousPolicy: PersistentRuntimePolicy;
			readonly currentPolicy: PersistentRuntimePolicy;
			/** Equal to recordRevision for a no-op. */
			readonly previousRecordRevision: number;
			readonly recordRevision: number;
			readonly status: PersistentAgentPresentStatus;
	  }
	| {
			readonly changed: true;
			readonly previousPolicy: PersistentRuntimePolicy;
			readonly currentPolicy: PersistentRuntimePolicy;
			/** The revision immediately before the policy CAS. */
			readonly previousRecordRevision: number;
			readonly recordRevision: number;
			readonly status: PersistentAgentPresentStatus;
	  };

/**
 * Validators reject every uncorrelated shape. For `changed: false`, the
 * policies are field-equal, the revisions are equal, and status exposes those
 * same values. For `changed: true`, `recordRevision` equals
 * `previousRecordRevision + 1`, and status exposes the new policy at that
 * revision.
 */

export interface PersistentAgentHandle {
	readonly agentId: PersistentAgentId;
	send(message: string, signal?: AbortSignal): Promise<void>;
	status(signal?: AbortSignal): Promise<PersistentAgentPresentStatus>;
	forkSession(signal?: AbortSignal): Promise<PersistentAgentForkResult>;
	setRuntimePolicy(
		policy: PersistentRuntimePolicy,
		signal?: AbortSignal,
	): Promise<PersistentRuntimePolicyUpdateResultV1>;
	park(signal?: AbortSignal): Promise<PersistentAgentPresentStatus>;
	release(options?: ReleasePersistentAgentOptions): Promise<PersistentAgentPresentStatus>;
}
