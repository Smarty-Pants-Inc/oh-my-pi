import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { FileLock } from "@oh-my-pi/pi-natives";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import type { SessionStorage } from "../session/session-storage.js";
import { FileSessionStorage } from "../session/session-storage.js";
import type {
	CanonicalRuntimeValue,
	RuntimeProviderRequestIdentity,
	RuntimeReplicaCacheEvictionAcceptance,
	RuntimeReplicaCacheEvictionAcceptancePending,
	RuntimeReplicaCacheEvictionPlan,
	RuntimeReplicaRef,
	TransientTaskGitEffectSafetyV1,
	WorkspaceImage,
	WorkspaceTombstone,
} from "../session/workspace-runtime-contracts.js";
import {
	canonicalRuntimeSha256,
	decodeWorkspaceRetentionPolicyV1,
	SAFE_DIAGNOSTIC_MESSAGE_CATALOG_V1,
} from "../session/workspace-runtime-contracts.js";
import { createTransientTaskGitEffectSafetyRuntimeV1 } from "../utils/git.js";
import type {
	ISO8601,
	KnownReplicaCatalogV1,
	KnownReplicaRecordV1,
	PersistentAgentCreatingRecordV1,
	PersistentAgentId,
	PersistentAgentInvalidRecordReason,
	PersistentAgentLookup,
	PersistentAgentOperationV1,
	PersistentAgentOwnership,
	PersistentAgentOwnershipEpochRecordV1,
	PersistentAgentOwnershipIntent,
	PersistentAgentOwnershipStatus,
	PersistentAgentRecordCommitGuardV1,
	PersistentAgentRecordV1,
	PersistentAgentRecoveryCode,
	PersistentAgentReleaseDispositionV1,
	PersistentAgentSessionRef,
	PersistentAgentStore,
	PersistentCanonicalWorkspaceStateV1,
	PersistentWorkspaceAuthorityV1,
	Sha256Hex,
	Sha256Ref,
	TerminalReplicaCleanupProofV1,
	WorkspaceCheckpoint,
	WorkspaceDeletionPlanCoreV1,
	WorkspaceDeletionPlanV1,
} from "./persistent-agent-contracts.js";
import { decodePersistentRuntimePolicyV1, PersistentAgentError } from "./persistent-agent-contracts.js";

/**
 * Source-relative capability for the durable post-terminal store that alone
 * may construct the repository-bound Git runtime. The package export map
 * blocks this module's subpath, and no public barrel re-exports this value.
 *
 * Cycle invariant: utils/git.ts reads this live binding only when its factory
 * is invoked; persistent-agent-store.ts never invokes that factory during
 * module evaluation.
 */
export const TRANSIENT_TASK_GIT_RUNTIME_MINT_AUTHORITY = Object.freeze({});

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const AGENT_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SHA256_REF = /^sha256:[0-9a-f]{64}$/;
const MAX_ID_BYTES = 512;
const PHASES: Readonly<Record<string, true>> = Object.freeze({
	creating: true,
	open: true,
	parking: true,
	parked: true,
	reviving: true,
	forking: true,
	releasing: true,
	released: true,
	recovery_required: true,
});
const RECOVERY_CODES: Readonly<Record<PersistentAgentRecoveryCode, true>> = Object.freeze({
	interrupted_create: true,
	interrupted_open: true,
	interrupted_park: true,
	interrupted_revive: true,
	interrupted_fork: true,
	interrupted_release: true,
	record_invalid: true,
	record_revision_conflict: true,
	wrong_control_host: true,
	seed_source_binding_missing: true,
	seed_source_changed: true,
	workspace_missing: true,
	workspace_identity_mismatch: true,
	session_missing: true,
	session_invalid: true,
	session_identity_mismatch: true,
	session_init_missing: true,
	session_dispose_failed: true,
	primary_persistence_indeterminate: true,
	runtime_reconciliation_blocked: true,
	runtime_preservation_impossible: true,
	cleanup_failed: true,
});
const COMMON_KEYS = [
	"schemaVersion",
	"revision",
	"controlHostId",
	"agentId",
	"displayName",
	"kind",
	"parentAgentId",
	"modelProfileId",
	"runtimePolicy",
	"createdAt",
	"updatedAt",
] as const;
const PROGRESS_ORDER: Readonly<Record<string, readonly string[]>> = Object.freeze({
	create: ["planned", "workspace_ready", "session_header_ready", "session_initialized", "runtime_none_initialized"],
	park: ["planned", "runtime_none", "session_durable", "session_disposed"],
	revive: ["planned", "runtime_none"],
	fork: ["planned", "target_durable"],
	release: [
		"planned",
		"runtime_none",
		"session_closed",
		"deletion_core_planned",
		"delete_planned",
		"workspace_disposition_applied",
	],
});

export type PersistentAgentRecordValidationV1 =
	| { readonly ok: true; readonly record: PersistentAgentRecordV1 }
	| { readonly ok: false; readonly reason: PersistentAgentInvalidRecordReason };

export interface MaterializedWorkspaceDeletionPlanV1 {
	readonly deletionPlanCoreSha256: Sha256Ref;
	readonly tombstone: WorkspaceTombstone;
	readonly deletion: WorkspaceDeletionPlanV1;
	readonly deletionPlanSha256: Sha256Ref;
}

export interface FilePersistentAgentStoreOptions {
	readonly rootDir?: string;
	readonly controlHostId?: string;
	readonly storage?: SessionStorage;
	readonly now?: () => Date;
}

class InvalidRecord extends Error {
	constructor(readonly reason: PersistentAgentInvalidRecordReason) {
		super(reason);
	}
}

function invalid(reason: PersistentAgentInvalidRecordReason = "invalid_fields"): never {
	throw new InvalidRecord(reason);
}

function wellFormed(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0xd800 || code > 0xdfff) continue;
		if (code >= 0xdc00 || index + 1 >= value.length) return false;
		const next = value.charCodeAt(index + 1);
		if (next < 0xdc00 || next > 0xdfff) return false;
		index++;
	}
	return true;
}

function opaqueId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.trim() === value &&
		wellFormed(value) &&
		!value.includes("\0") &&
		Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES
	);
}

function agentId(value: unknown): value is PersistentAgentId {
	return typeof value === "string" && AGENT_ID.test(value);
}

export function normalizePersistentAgentIdV1(value: PersistentAgentId): string {
	if (!agentId(value)) throw new PersistentAgentError("invalid_agent_id", String(value), false, "invalid_fields");
	return value.toLowerCase();
}

export function persistentAgentStorageKeyV1(value: PersistentAgentId): string {
	return Bun.SHA256.hash(normalizePersistentAgentIdV1(value), "hex");
}

function integer(value: unknown, minimum = 0): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum;
}

function iso8601(value: unknown): value is ISO8601 {
	if (typeof value !== "string" || !wellFormed(value)) return false;
	const epoch = Date.parse(value);
	return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function sha256(value: unknown): value is Sha256Hex {
	return typeof value === "string" && SHA256.test(value);
}

function sha256Ref(value: unknown): value is Sha256Ref {
	return typeof value === "string" && SHA256_REF.test(value);
}

function diagnosticCode(value: unknown): boolean {
	return typeof value === "string" && Object.hasOwn(SAFE_DIAGNOSTIC_MESSAGE_CATALOG_V1, value);
}

function object(
	value: unknown,
	keys: readonly string[],
	reason: PersistentAgentInvalidRecordReason = "invalid_fields",
) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(reason);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) invalid(reason);
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key)))
		invalid(reason);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const snapshot: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = descriptors[key];
		if (!descriptor?.enumerable || !("value" in descriptor)) invalid(reason);
		snapshot[key] = descriptor.value;
	}
	return snapshot;
}

function array(value: unknown): readonly unknown[] {
	if (!Array.isArray(value)) invalid();
	return value;
}

function freeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const member of Object.values(value as Record<string, unknown>)) freeze(member);
	return value;
}

function canonicalObject(value: unknown): unknown {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (!wellFormed(value)) invalid();
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid();
		return value;
	}
	if (Array.isArray(value)) return value.map(canonicalObject);
	if (typeof value !== "object") invalid();
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		result[key] = canonicalObject((value as Record<string, unknown>)[key]);
	}
	return result;
}

function jsonLine(value: unknown): string {
	return `${JSON.stringify(canonicalObject(value))}\n`;
}

async function tupleSha256Ref(tuple: readonly CanonicalRuntimeValue[]): Promise<Sha256Ref> {
	return `sha256:${await canonicalRuntimeSha256(tuple)}`;
}

function logicalSessionKey(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		!value ||
		!wellFormed(value) ||
		path.posix.isAbsolute(value) ||
		value.includes("\\") ||
		value.includes("\0")
	) {
		return false;
	}
	return value.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

function sessionRef(value: unknown): PersistentAgentSessionRef {
	const input = object(value, ["sessionId", "sessionStorageKey", "sessionInitEntryId"]);
	if (!opaqueId(input.sessionId) || !logicalSessionKey(input.sessionStorageKey) || !opaqueId(input.sessionInitEntryId))
		invalid();
	return input as unknown as PersistentAgentSessionRef;
}

function workspaceImage(value: unknown): WorkspaceImage {
	const input = object(value, ["rootSha256", "fileCount", "byteCount"]);
	if (!sha256(input.rootSha256) || !integer(input.fileCount) || !integer(input.byteCount)) invalid();
	return input as unknown as WorkspaceImage;
}

function checkpoint(value: unknown, expectedWorkspaceId?: string): WorkspaceCheckpoint {
	const input = object(value, ["workspaceId", "generation", "rootSha256", "fileCount", "byteCount", "committedAt"]);
	if (
		!opaqueId(input.workspaceId) ||
		(expectedWorkspaceId !== undefined && input.workspaceId !== expectedWorkspaceId) ||
		!integer(input.generation) ||
		!sha256(input.rootSha256) ||
		!integer(input.fileCount) ||
		!integer(input.byteCount) ||
		!iso8601(input.committedAt)
	)
		invalid();
	return input as unknown as WorkspaceCheckpoint;
}

function checkpointTuple(value: WorkspaceCheckpoint): readonly CanonicalRuntimeValue[] {
	return [value.workspaceId, value.generation, value.rootSha256, value.fileCount, value.byteCount, value.committedAt];
}

function replica(value: unknown, expectedWorkspaceId?: string): RuntimeReplicaRef {
	const input = object(value, ["providerId", "profileId", "replicaId", "workspaceId"]);
	if (
		!opaqueId(input.providerId) ||
		!opaqueId(input.profileId) ||
		!opaqueId(input.replicaId) ||
		!opaqueId(input.workspaceId) ||
		(expectedWorkspaceId !== undefined && input.workspaceId !== expectedWorkspaceId)
	)
		invalid();
	return input as unknown as RuntimeReplicaRef;
}

function replicaTuple(value: RuntimeReplicaRef): readonly CanonicalRuntimeValue[] {
	return [value.providerId, value.profileId, value.replicaId, value.workspaceId];
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareReplica(left: RuntimeReplicaRef, right: RuntimeReplicaRef): number {
	return (
		compareUtf8(left.providerId, right.providerId) ||
		compareUtf8(left.profileId, right.profileId) ||
		compareUtf8(left.replicaId, right.replicaId)
	);
}

function sameReplica(left: RuntimeReplicaRef, right: RuntimeReplicaRef): boolean {
	return (
		left.providerId === right.providerId &&
		left.profileId === right.profileId &&
		left.replicaId === right.replicaId &&
		left.workspaceId === right.workspaceId
	);
}

function replicaKey(value: RuntimeReplicaRef): string {
	return `${value.providerId}\0${value.profileId}\0${value.replicaId}`;
}

function requestIdentity(value: unknown): RuntimeProviderRequestIdentity {
	const input = object(value, ["requestId", "requestSha256"]);
	if (!opaqueId(input.requestId) || !sha256(input.requestSha256)) invalid();
	return input as unknown as RuntimeProviderRequestIdentity;
}

interface ValidatedManagedWorkspace {
	readonly workspaceId: string;
	readonly retention: unknown;
	readonly checkpoint: WorkspaceCheckpoint;
}

function managedWorkspace(value: unknown): ValidatedManagedWorkspace {
	const input = object(value, ["workspaceId", "mode", "format", "retention", "checkpoint"]);
	if (!opaqueId(input.workspaceId) || input.mode !== "managed" || input.format !== "omp-text-v1") invalid();
	try {
		decodeWorkspaceRetentionPolicyV1(input.retention);
	} catch {
		invalid();
	}
	const validatedCheckpoint = checkpoint(input.checkpoint, input.workspaceId);
	return { workspaceId: input.workspaceId, retention: input.retention, checkpoint: validatedCheckpoint };
}

function evictionPlan(value: unknown, expectedReplica: RuntimeReplicaRef): RuntimeReplicaCacheEvictionPlan {
	const input = object(value, [
		"requestId",
		"requestSha256",
		"requestedByOperationId",
		"replica",
		"mode",
		"delayMs",
		"plannedAt",
		"retentionDeadline",
	]);
	if (
		!opaqueId(input.requestId) ||
		!sha256(input.requestSha256) ||
		!opaqueId(input.requestedByOperationId) ||
		(input.mode !== "explicit" && input.mode !== "workspace_retention") ||
		!integer(input.delayMs) ||
		!iso8601(input.plannedAt) ||
		!iso8601(input.retentionDeadline)
	)
		invalid();
	const planReplica = replica(input.replica, expectedReplica.workspaceId);
	if (!sameReplica(planReplica, expectedReplica)) invalid("invalid_phase_relationship");
	const deadline = Date.parse(input.plannedAt) + input.delayMs;
	if (!Number.isSafeInteger(deadline) || new Date(deadline).toISOString() !== input.retentionDeadline) invalid();
	return input as unknown as RuntimeReplicaCacheEvictionPlan;
}

function evictionAcceptance(
	value: unknown,
	plan: RuntimeReplicaCacheEvictionPlan,
	pending: boolean,
): RuntimeReplicaCacheEvictionAcceptance | RuntimeReplicaCacheEvictionAcceptancePending {
	const timestampKey = pending ? "observedAt" : "acceptedAt";
	const input = object(value, ["requestId", "requestSha256", "replica", "retentionDeadline", timestampKey]);
	if (
		input.requestId !== plan.requestId ||
		input.requestSha256 !== plan.requestSha256 ||
		!sameReplica(replica(input.replica, plan.replica.workspaceId), plan.replica) ||
		input.retentionDeadline !== plan.retentionDeadline ||
		!iso8601(input[timestampKey])
	)
		invalid("invalid_phase_relationship");
	return input as unknown as RuntimeReplicaCacheEvictionAcceptance | RuntimeReplicaCacheEvictionAcceptancePending;
}

function cacheEviction(value: unknown, expectedReplica: RuntimeReplicaRef): void {
	if (value === null || typeof value !== "object") invalid();
	const state = Object.getOwnPropertyDescriptor(value, "state")?.value;
	if (state === "not_requested") {
		object(value, ["state"]);
		return;
	}
	if (state === "pending") {
		const input = object(value, ["state", "plan", "attempts", "lastAttemptAt", "progress"]);
		const plan = evictionPlan(input.plan, expectedReplica);
		if (!integer(input.attempts, 1) || (input.lastAttemptAt !== null && !iso8601(input.lastAttemptAt))) invalid();
		const progressState = Object.getOwnPropertyDescriptor(input.progress as object, "state")?.value;
		if (progressState === "not_started" || progressState === "submission_outcome_unknown")
			object(input.progress, ["state"]);
		else if (progressState === "inspection_pending")
			evictionAcceptance(object(input.progress, ["state", "pending"]).pending, plan, true);
		else if (progressState === "accepted")
			evictionAcceptance(object(input.progress, ["state", "acceptance"]).acceptance, plan, false);
		else if (progressState === "deferred") {
			const progress = object(input.progress, ["state", "acceptance", "reason", "nextAttemptAt"]);
			evictionAcceptance(progress.acceptance, plan, false);
			if (
				![
					"not_released",
					"active_compute",
					"compute_ambiguous",
					"checkpoint_unacknowledged",
					"command_or_sync_ambiguous",
				].includes(String(progress.reason)) ||
				!iso8601(progress.nextAttemptAt)
			)
				invalid();
		} else if (progressState === "rejected") {
			const rejection = object(object(input.progress, ["state", "rejection"]).rejection, [
				"requestId",
				"requestSha256",
				"replica",
				"retentionDeadline",
				"code",
				"observedAt",
			]);
			if (
				rejection.requestId !== plan.requestId ||
				rejection.requestSha256 !== plan.requestSha256 ||
				!sameReplica(replica(rejection.replica), plan.replica) ||
				rejection.retentionDeadline !== plan.retentionDeadline ||
				rejection.code !== "provider_request_rejected" ||
				!iso8601(rejection.observedAt)
			)
				invalid("invalid_phase_relationship");
		} else if (progressState === "deadline_mismatch") {
			const mismatch = object(object(input.progress, ["state", "mismatch"]).mismatch, [
				"requestId",
				"requestSha256",
				"replica",
				"plannedRetentionDeadline",
				"providerRetentionDeadline",
				"observedAt",
			]);
			if (
				mismatch.requestId !== plan.requestId ||
				mismatch.requestSha256 !== plan.requestSha256 ||
				!sameReplica(replica(mismatch.replica), plan.replica) ||
				mismatch.plannedRetentionDeadline !== plan.retentionDeadline ||
				!iso8601(mismatch.providerRetentionDeadline) ||
				!iso8601(mismatch.observedAt)
			)
				invalid("invalid_phase_relationship");
		} else invalid();
		return;
	}
	if (state === "complete") {
		const input = object(value, ["state", "plan", "result"]);
		const plan = evictionPlan(input.plan, expectedReplica);
		const result = object(input.result, ["acceptance", "outcome", "completedAt", "receiptSha256"]);
		evictionAcceptance(result.acceptance, plan, false);
		if (
			!["evicted", "already_evicted", "absent"].includes(String(result.outcome)) ||
			!iso8601(result.completedAt) ||
			!sha256Ref(result.receiptSha256)
		)
			invalid();
		return;
	}
	invalid();
}

function cleanup(value: unknown): void {
	if (value === null || typeof value !== "object") invalid();
	const state = Object.getOwnPropertyDescriptor(value, "state")?.value;
	if (state === "not_requested") object(value, ["state"]);
	else if (state === "pending") {
		const input = object(value, ["state", "request", "attempts", "lastAttemptAt", "lastResult", "nextAttemptAt"]);
		requestIdentity(input.request);
		if (
			!integer(input.attempts, 1) ||
			(input.lastAttemptAt !== null && !iso8601(input.lastAttemptAt)) ||
			![null, "cleanup_pending", "transport_unknown"].includes(input.lastResult as null | string) ||
			(input.nextAttemptAt !== null && !iso8601(input.nextAttemptAt))
		)
			invalid();
	} else if (state === "failed") {
		const input = object(value, ["state", "request", "attempts", "failedAt", "code", "retryable", "nextRetryAt"]);
		requestIdentity(input.request);
		if (
			!integer(input.attempts, 1) ||
			!iso8601(input.failedAt) ||
			!diagnosticCode(input.code) ||
			typeof input.retryable !== "boolean" ||
			(input.nextRetryAt !== null && !iso8601(input.nextRetryAt)) ||
			(input.retryable === false && input.nextRetryAt !== null)
		)
			invalid();
	} else if (state === "complete") {
		const input = object(value, ["state", "request", "outcome", "completedAt", "receiptSha256"]);
		requestIdentity(input.request);
		if (
			!["deleted", "already_deleted", "absent"].includes(String(input.outcome)) ||
			!iso8601(input.completedAt) ||
			!sha256Ref(input.receiptSha256)
		)
			invalid();
	} else invalid();
}

function isNondecreasingInstant(current: ISO8601 | null, next: ISO8601 | null): boolean {
	return current === null || (next !== null && Date.parse(next) >= Date.parse(current));
}

function isEvictionProgressReplacementValid(
	current: Extract<KnownReplicaRecordV1["cacheEviction"], { readonly state: "pending" }>["progress"],
	next: Extract<KnownReplicaRecordV1["cacheEviction"], { readonly state: "pending" }>["progress"],
): boolean {
	if (equal(current, next)) return true;
	switch (current.state) {
		case "not_started":
			return next.state === "submission_outcome_unknown";
		case "submission_outcome_unknown":
			return next.state !== "not_started" && next.state !== "submission_outcome_unknown";
		case "inspection_pending": {
			if (next.state === "inspection_pending") {
				return (
					current.pending.requestId === next.pending.requestId &&
					current.pending.requestSha256 === next.pending.requestSha256 &&
					equal(current.pending.replica, next.pending.replica) &&
					current.pending.retentionDeadline === next.pending.retentionDeadline &&
					Date.parse(next.pending.observedAt) >= Date.parse(current.pending.observedAt)
				);
			}
			const nextObservedAt =
				next.state === "accepted" || next.state === "deferred"
					? next.acceptance.acceptedAt
					: next.state === "rejected"
						? next.rejection.observedAt
						: next.state === "deadline_mismatch"
							? next.mismatch.observedAt
							: null;
			return nextObservedAt !== null && Date.parse(nextObservedAt) >= Date.parse(current.pending.observedAt);
		}
		case "accepted":
			return false;
		case "deferred":
			return (
				next.state === "deferred" &&
				equal(current.acceptance, next.acceptance) &&
				current.reason === next.reason &&
				Date.parse(next.nextAttemptAt) >= Date.parse(current.nextAttemptAt)
			);
		case "rejected":
		case "deadline_mismatch":
			return false;
	}
}

function isCacheEvictionReplacementValid(
	current: KnownReplicaRecordV1["cacheEviction"],
	next: KnownReplicaRecordV1["cacheEviction"],
): boolean {
	if (equal(current, next)) return true;
	if (current.state === "not_requested") {
		return (
			next.state === "pending" &&
			next.attempts === 1 &&
			next.lastAttemptAt === null &&
			next.progress.state === "not_started"
		);
	}
	if (current.state === "complete" || next.state === "not_requested") return false;
	if (!equal(current.plan, next.plan)) return false;
	if (next.state === "complete") {
		if (
			(current.progress.state === "accepted" || current.progress.state === "deferred") &&
			!equal(current.progress.acceptance, next.result.acceptance)
		)
			return false;
		if (
			current.progress.state === "inspection_pending" &&
			Date.parse(next.result.acceptance.acceptedAt) < Date.parse(current.progress.pending.observedAt)
		)
			return false;
		return ["submission_outcome_unknown", "inspection_pending", "accepted", "deferred"].includes(
			current.progress.state,
		);
	}
	if (next.attempts === current.attempts) {
		const dispatchStarted =
			current.progress.state === "not_started" && next.progress.state === "submission_outcome_unknown";
		if (dispatchStarted && next.lastAttemptAt === null) return false;
		if (
			current.lastAttemptAt !== next.lastAttemptAt &&
			!(dispatchStarted && current.lastAttemptAt === null && next.lastAttemptAt !== null)
		)
			return false;
		return isEvictionProgressReplacementValid(current.progress, next.progress);
	}
	return (
		next.attempts === current.attempts + 1 &&
		current.progress.state === "submission_outcome_unknown" &&
		next.progress.state === "submission_outcome_unknown" &&
		next.lastAttemptAt !== null &&
		isNondecreasingInstant(current.lastAttemptAt, next.lastAttemptAt)
	);
}

function isCleanupPendingReplacementValid(
	current: Extract<KnownReplicaRecordV1["cleanup"], { readonly state: "pending" }>,
	next: Extract<KnownReplicaRecordV1["cleanup"], { readonly state: "pending" }>,
): boolean {
	if (!equal(current.request, next.request)) return false;
	if (next.attempts === current.attempts) {
		if (
			!isNondecreasingInstant(current.lastAttemptAt, next.lastAttemptAt) ||
			!isNondecreasingInstant(current.nextAttemptAt, next.nextAttemptAt)
		)
			return false;
		if (current.lastResult === "cleanup_pending" && next.lastResult !== "cleanup_pending") return false;
		if (current.lastResult === "transport_unknown" && next.lastResult === null) return false;
		return true;
	}
	return (
		next.attempts === current.attempts + 1 &&
		next.lastAttemptAt !== null &&
		isNondecreasingInstant(current.lastAttemptAt, next.lastAttemptAt) &&
		next.lastResult === "transport_unknown" &&
		next.nextAttemptAt === null
	);
}

function isCleanupReplacementValid(
	current: KnownReplicaRecordV1["cleanup"],
	next: KnownReplicaRecordV1["cleanup"],
): boolean {
	if (equal(current, next)) return true;
	if (current.state === "not_requested") {
		return (
			next.state === "pending" &&
			next.attempts === 1 &&
			next.lastAttemptAt === null &&
			next.lastResult === null &&
			next.nextAttemptAt === null
		);
	}
	if (current.state === "complete" || next.state === "not_requested") return false;
	if (!equal(current.request, next.request)) return false;
	if (current.state === "failed") {
		return (
			next.state === "pending" &&
			current.retryable &&
			next.attempts === current.attempts + 1 &&
			next.lastAttemptAt === null &&
			next.lastResult === null &&
			next.nextAttemptAt === null
		);
	}
	if (next.state === "pending") return isCleanupPendingReplacementValid(current, next);
	if (next.state === "failed")
		return next.attempts === current.attempts && isNondecreasingInstant(current.lastAttemptAt, next.failedAt);
	return isNondecreasingInstant(current.lastAttemptAt, next.completedAt);
}

function isKnownReplicaReplacementValid(current: KnownReplicaRecordV1, next: KnownReplicaRecordV1): boolean {
	if (
		!equal(current.replica, next.replica) ||
		current.plannedByOperationId !== next.plannedByOperationId ||
		current.deletionAuthorityDomain !== next.deletionAuthorityDomain ||
		current.firstPlannedAt !== next.firstPlannedAt ||
		(current.lastLeaseId !== null && next.lastLeaseId === null)
	)
		return false;
	if (current.observation.state !== "never_observed") {
		if (next.observation.state === "never_observed") return false;
		const currentObservedAt = Date.parse(current.observation.observedAt);
		const nextObservedAt = Date.parse(next.observation.observedAt);
		if (
			nextObservedAt < currentObservedAt ||
			(nextObservedAt === currentObservedAt && !equal(current.observation, next.observation))
		)
			return false;
	}
	return (
		isCacheEvictionReplacementValid(current.cacheEviction, next.cacheEviction) &&
		isCleanupReplacementValid(current.cleanup, next.cleanup)
	);
}

function knownReplica(value: unknown, workspaceId: string): KnownReplicaRecordV1 {
	const input = object(value, [
		"replica",
		"plannedByOperationId",
		"deletionAuthorityDomain",
		"firstPlannedAt",
		"lastLeaseId",
		"observation",
		"cacheEviction",
		"cleanup",
	]);
	const ref = replica(input.replica, workspaceId);
	if (
		!opaqueId(input.plannedByOperationId) ||
		input.deletionAuthorityDomain !== "persistent" ||
		!iso8601(input.firstPlannedAt) ||
		(input.lastLeaseId !== null && !opaqueId(input.lastLeaseId))
	)
		invalid();
	const observationState = Object.getOwnPropertyDescriptor(input.observation as object, "state")?.value;
	if (observationState === "never_observed") object(input.observation, ["state"]);
	else if (observationState === "present" || observationState === "retained") {
		const observation = object(input.observation, ["state", "observedAt", "image"]);
		if (!iso8601(observation.observedAt)) invalid();
		if (observation.image !== null) workspaceImage(observation.image);
	} else if (observationState === "absent") {
		if (!iso8601(object(input.observation, ["state", "observedAt"]).observedAt)) invalid();
	} else if (observationState === "unknown") {
		const observation = object(input.observation, ["state", "observedAt", "code"]);
		if (!iso8601(observation.observedAt) || !diagnosticCode(observation.code)) invalid();
	} else invalid();
	cacheEviction(input.cacheEviction, ref);
	cleanup(input.cleanup);
	return input as unknown as KnownReplicaRecordV1;
}

function knownReplicaCatalog(value: unknown, workspaceId: string): KnownReplicaCatalogV1 {
	const input = object(value, ["revision", "entries"]);
	if (!integer(input.revision)) invalid();
	const entries = array(input.entries).map(entry => knownReplica(entry, workspaceId));
	if (input.revision < entries.length) invalid("invalid_phase_relationship");
	const keys = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		const key = replicaKey(entry.replica);
		if (keys.has(key) || (index > 0 && compareReplica(entries[index - 1]!.replica, entry.replica) >= 0)) invalid();
		keys.add(key);
	}
	return input as unknown as KnownReplicaCatalogV1;
}

function deletionCoreTuple(core: WorkspaceDeletionPlanCoreV1): readonly CanonicalRuntimeValue[] {
	return [
		"omp-workspace-deletion-plan-core-v1",
		core.deleteId,
		core.deletionAuthorityId,
		core.quarantineId,
		core.workspaceId,
		checkpointTuple(core.expectedCheckpoint),
		core.expectedRuntimeAttachmentCreateId,
		core.expectedRuntimeAttachmentRevision,
		core.expectedKnownReplicaCatalogRevision,
		core.plannedDeletionAt,
		core.deletedBytesGraceMs,
		core.purgeAfter,
		core.replicaRequests.map(entry => [
			...replicaTuple(entry.replica),
			entry.deletionAuthorityDomain,
			entry.requestId,
		]),
	];
}

function persistentDeleteTuple(input: {
	readonly requestId: string;
	readonly replica: RuntimeReplicaRef;
	readonly deletionPlanCoreSha256: Sha256Ref;
	readonly tombstone: WorkspaceTombstone;
}): readonly CanonicalRuntimeValue[] {
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
			checkpointTuple(input.tombstone.lastCheckpoint),
			input.tombstone.purgeAfter,
		],
	];
}

function deletionPlanTuple(deletion: WorkspaceDeletionPlanV1): readonly CanonicalRuntimeValue[] {
	return [
		"omp-workspace-deletion-plan-v1",
		deletionCoreTuple(deletion.core),
		deletion.replicaRequests.map(entry => [
			...replicaTuple(entry.replica),
			entry.deletionAuthorityDomain,
			entry.request.requestId,
			entry.request.requestSha256,
		]),
	];
}

function terminalCleanupTuple(
	proof: Omit<TerminalReplicaCleanupProofV1, "proofSha256">,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-terminal-replica-cleanup-proof-v1",
		1,
		proof.workspaceId,
		proof.deleteId,
		proof.catalogRevision,
		proof.deletionPlanCoreSha256,
		proof.deletionPlanSha256,
		proof.entries.map(entry => [
			...replicaTuple(entry.replica),
			entry.deletionAuthorityDomain,
			entry.request.requestId,
			entry.request.requestSha256,
			entry.outcome,
			entry.completedAt,
			entry.receiptSha256,
		]),
		proof.verifiedAt,
	];
}

function deletionCore(value: unknown): WorkspaceDeletionPlanCoreV1 {
	const input = object(value, [
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
	if (
		!opaqueId(input.deleteId) ||
		!opaqueId(input.deletionAuthorityId) ||
		!opaqueId(input.quarantineId) ||
		new Set([input.deleteId, input.deletionAuthorityId, input.quarantineId]).size !== 3 ||
		!opaqueId(input.workspaceId) ||
		!opaqueId(input.expectedRuntimeAttachmentCreateId) ||
		!integer(input.expectedRuntimeAttachmentRevision, 1) ||
		!integer(input.expectedKnownReplicaCatalogRevision) ||
		!iso8601(input.plannedDeletionAt) ||
		!integer(input.deletedBytesGraceMs) ||
		input.deletedBytesGraceMs > 2_147_483_647 ||
		!iso8601(input.purgeAfter)
	)
		invalid();
	checkpoint(input.expectedCheckpoint, input.workspaceId);
	const purge = Date.parse(input.plannedDeletionAt) + input.deletedBytesGraceMs;
	if (!Number.isSafeInteger(purge) || new Date(purge).toISOString() !== input.purgeAfter) invalid();
	const entries = array(input.replicaRequests).map(value => {
		const entry = object(value, ["replica", "deletionAuthorityDomain", "requestId"]);
		const ref = replica(entry.replica, input.workspaceId as string);
		if (entry.deletionAuthorityDomain !== "persistent" || !opaqueId(entry.requestId)) invalid();
		return { ref, requestId: entry.requestId as string };
	});
	const replicaKeys = new Set<string>();
	const requestIds = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (
			replicaKeys.has(replicaKey(entry.ref)) ||
			requestIds.has(entry.requestId) ||
			(index > 0 && compareReplica(entries[index - 1]!.ref, entry.ref) >= 0)
		)
			invalid();
		replicaKeys.add(replicaKey(entry.ref));
		requestIds.add(entry.requestId);
	}
	return input as unknown as WorkspaceDeletionPlanCoreV1;
}

export async function workspaceDeletionPlanCoreSha256V1(core: WorkspaceDeletionPlanCoreV1): Promise<Sha256Ref> {
	deletionCore(core);
	return tupleSha256Ref(deletionCoreTuple(core));
}

export function deriveWorkspaceTombstoneV1(core: WorkspaceDeletionPlanCoreV1): WorkspaceTombstone {
	deletionCore(core);
	return freeze({
		workspaceId: core.workspaceId,
		deleteId: core.deleteId,
		deletionAuthorityId: core.deletionAuthorityId,
		quarantineId: core.quarantineId,
		deletedAt: core.plannedDeletionAt,
		lastCheckpoint: core.expectedCheckpoint,
		purgeAfter: core.purgeAfter,
	});
}

async function materializeDeletionUnchecked(
	core: WorkspaceDeletionPlanCoreV1,
): Promise<MaterializedWorkspaceDeletionPlanV1> {
	const deletionPlanCoreSha256 = await tupleSha256Ref(deletionCoreTuple(core));
	const tombstone: WorkspaceTombstone = {
		workspaceId: core.workspaceId,
		deleteId: core.deleteId,
		deletionAuthorityId: core.deletionAuthorityId,
		quarantineId: core.quarantineId,
		deletedAt: core.plannedDeletionAt,
		lastCheckpoint: core.expectedCheckpoint,
		purgeAfter: core.purgeAfter,
	};
	const replicaRequests = await Promise.all(
		core.replicaRequests.map(async entry => ({
			replica: entry.replica,
			deletionAuthorityDomain: "persistent" as const,
			request: {
				requestId: entry.requestId,
				requestSha256: await canonicalRuntimeSha256(
					persistentDeleteTuple({
						requestId: entry.requestId,
						replica: entry.replica,
						deletionPlanCoreSha256,
						tombstone,
					}),
				),
			},
		})),
	);
	const deletion: WorkspaceDeletionPlanV1 = { core, replicaRequests };
	return {
		deletionPlanCoreSha256,
		tombstone,
		deletion,
		deletionPlanSha256: await tupleSha256Ref(deletionPlanTuple(deletion)),
	};
}

export async function materializeWorkspaceDeletionPlanV1(
	core: WorkspaceDeletionPlanCoreV1,
): Promise<MaterializedWorkspaceDeletionPlanV1> {
	deletionCore(core);
	return freeze(await materializeDeletionUnchecked(core));
}

async function deletionPlan(value: unknown): Promise<WorkspaceDeletionPlanV1> {
	const input = object(value, ["core", "replicaRequests"]);
	const core = deletionCore(input.core);
	const expected = await materializeDeletionUnchecked(core);
	if (!equal(input, expected.deletion)) invalid("invalid_phase_relationship");
	return input as unknown as WorkspaceDeletionPlanV1;
}

export async function workspaceDeletionPlanSha256V1(value: WorkspaceDeletionPlanV1): Promise<Sha256Ref> {
	const validated = await deletionPlan(value);
	return tupleSha256Ref(deletionPlanTuple(validated));
}

function terminalProofCore(value: unknown): Omit<TerminalReplicaCleanupProofV1, "proofSha256"> {
	const input = object(value, [
		"schemaVersion",
		"workspaceId",
		"deleteId",
		"catalogRevision",
		"deletionPlanCoreSha256",
		"deletionPlanSha256",
		"entries",
		"verifiedAt",
	]);
	if (
		input.schemaVersion !== 1 ||
		!opaqueId(input.workspaceId) ||
		!opaqueId(input.deleteId) ||
		!integer(input.catalogRevision) ||
		!sha256Ref(input.deletionPlanCoreSha256) ||
		!sha256Ref(input.deletionPlanSha256) ||
		!iso8601(input.verifiedAt)
	)
		invalid();
	const entries = array(input.entries);
	const keys = new Set<string>();
	let previous: RuntimeReplicaRef | undefined;
	for (const value of entries) {
		const entry = object(value, [
			"replica",
			"deletionAuthorityDomain",
			"request",
			"outcome",
			"completedAt",
			"receiptSha256",
		]);
		const ref = replica(entry.replica, input.workspaceId);
		const key = replicaKey(ref);
		requestIdentity(entry.request);
		if (
			entry.deletionAuthorityDomain !== "persistent" ||
			!["deleted", "already_deleted", "absent"].includes(String(entry.outcome)) ||
			!iso8601(entry.completedAt) ||
			Date.parse(entry.completedAt) > Date.parse(input.verifiedAt as string) ||
			!sha256Ref(entry.receiptSha256) ||
			keys.has(key) ||
			(previous && compareReplica(previous, ref) >= 0)
		)
			invalid();
		keys.add(key);
		previous = ref;
	}
	return input as unknown as Omit<TerminalReplicaCleanupProofV1, "proofSha256">;
}

export async function terminalReplicaCleanupProofSha256V1(
	proof: Omit<TerminalReplicaCleanupProofV1, "proofSha256">,
): Promise<Sha256Ref> {
	const validated = terminalProofCore(proof);
	return tupleSha256Ref(terminalCleanupTuple(validated));
}

async function terminalProof(
	value: unknown,
	deletion: WorkspaceDeletionPlanV1,
	expected: MaterializedWorkspaceDeletionPlanV1,
	catalog: KnownReplicaCatalogV1,
): Promise<void> {
	const input = object(value, [
		"schemaVersion",
		"workspaceId",
		"deleteId",
		"catalogRevision",
		"deletionPlanCoreSha256",
		"deletionPlanSha256",
		"entries",
		"verifiedAt",
		"proofSha256",
	]);
	if (
		input.schemaVersion !== 1 ||
		input.workspaceId !== deletion.core.workspaceId ||
		input.deleteId !== deletion.core.deleteId ||
		input.catalogRevision !== catalog.revision ||
		input.deletionPlanCoreSha256 !== expected.deletionPlanCoreSha256 ||
		input.deletionPlanSha256 !== expected.deletionPlanSha256 ||
		!iso8601(input.verifiedAt) ||
		!sha256Ref(input.proofSha256)
	)
		invalid("invalid_phase_relationship");
	const proofCore = terminalProofCore({
		schemaVersion: input.schemaVersion,
		workspaceId: input.workspaceId,
		deleteId: input.deleteId,
		catalogRevision: input.catalogRevision,
		deletionPlanCoreSha256: input.deletionPlanCoreSha256,
		deletionPlanSha256: input.deletionPlanSha256,
		entries: input.entries,
		verifiedAt: input.verifiedAt,
	});
	const entries = proofCore.entries;
	if (entries.length !== deletion.replicaRequests.length) invalid("invalid_phase_relationship");
	for (let index = 0; index < entries.length; index++) {
		const entry = object(entries[index], [
			"replica",
			"deletionAuthorityDomain",
			"request",
			"outcome",
			"completedAt",
			"receiptSha256",
		]);
		const planned = deletion.replicaRequests[index]!;
		const catalogEntry = catalog.entries[index];
		const request = requestIdentity(entry.request);
		if (
			!catalogEntry ||
			!sameReplica(replica(entry.replica), planned.replica) ||
			entry.deletionAuthorityDomain !== "persistent" ||
			!equal(request, planned.request) ||
			catalogEntry.cleanup.state !== "complete" ||
			!equal(request, catalogEntry.cleanup.request) ||
			entry.outcome !== catalogEntry.cleanup.outcome ||
			entry.completedAt !== catalogEntry.cleanup.completedAt ||
			entry.receiptSha256 !== catalogEntry.cleanup.receiptSha256
		)
			invalid("invalid_phase_relationship");
	}
	if ((await terminalReplicaCleanupProofSha256V1(proofCore)) !== input.proofSha256)
		invalid("invalid_phase_relationship");
}

function catalogMatchesDeletion(
	catalog: KnownReplicaCatalogV1,
	deletion: WorkspaceDeletionPlanV1,
	initial: boolean,
): void {
	if (
		(initial && catalog.revision !== deletion.core.expectedKnownReplicaCatalogRevision) ||
		(!initial && catalog.revision < deletion.core.expectedKnownReplicaCatalogRevision) ||
		catalog.entries.length !== deletion.replicaRequests.length
	)
		invalid("invalid_phase_relationship");
	for (let index = 0; index < deletion.replicaRequests.length; index++) {
		const planned = deletion.replicaRequests[index]!;
		const row = catalog.entries[index];
		if (!row || !sameReplica(row.replica, planned.replica) || row.deletionAuthorityDomain !== "persistent")
			invalid("invalid_phase_relationship");
		if (row.cleanup.state !== "not_requested" && !equal(row.cleanup.request, planned.request))
			invalid("invalid_phase_relationship");
	}
}

async function workspaceAuthority(value: unknown): Promise<PersistentWorkspaceAuthorityV1> {
	const input = object(value, ["workspaceId", "canonical", "knownReplicas"]);
	if (!opaqueId(input.workspaceId) || input.canonical === null || typeof input.canonical !== "object") invalid();
	const catalog = knownReplicaCatalog(input.knownReplicas, input.workspaceId);
	const state = Object.getOwnPropertyDescriptor(input.canonical, "state")?.value;
	if (state === "present") {
		const canonical = object(input.canonical, ["state", "workspace"]);
		const workspace = managedWorkspace(canonical.workspace);
		if (workspace.workspaceId !== input.workspaceId) invalid("invalid_phase_relationship");
	} else if (state === "delete_core_planned") {
		const canonical = object(input.canonical, ["state", "workspace", "deletionCore", "deletionPlanCoreSha256"]);
		const workspace = managedWorkspace(canonical.workspace);
		const core = deletionCore(canonical.deletionCore);
		if (
			workspace.workspaceId !== input.workspaceId ||
			core.workspaceId !== input.workspaceId ||
			!equal(workspace.checkpoint, core.expectedCheckpoint) ||
			canonical.deletionPlanCoreSha256 !== (await workspaceDeletionPlanCoreSha256V1(core)) ||
			catalog.revision !== core.expectedKnownReplicaCatalogRevision ||
			catalog.entries.length !== core.replicaRequests.length
		)
			invalid("invalid_phase_relationship");
		for (let index = 0; index < core.replicaRequests.length; index++)
			if (!sameReplica(core.replicaRequests[index]!.replica, catalog.entries[index]!.replica))
				invalid("invalid_phase_relationship");
	} else if (state === "delete_planned") {
		const canonical = object(input.canonical, [
			"state",
			"workspace",
			"deletion",
			"deletionPlanCoreSha256",
			"deletionPlanSha256",
		]);
		const workspace = managedWorkspace(canonical.workspace);
		const deletion = await deletionPlan(canonical.deletion);
		const expected = await materializeDeletionUnchecked(deletion.core);
		if (
			workspace.workspaceId !== input.workspaceId ||
			!equal(workspace.checkpoint, deletion.core.expectedCheckpoint) ||
			canonical.deletionPlanCoreSha256 !== expected.deletionPlanCoreSha256 ||
			canonical.deletionPlanSha256 !== expected.deletionPlanSha256
		)
			invalid("invalid_phase_relationship");
		catalogMatchesDeletion(catalog, deletion, true);
	} else if (state === "tombstoned" || state === "purged") {
		const canonical = object(input.canonical, [
			"state",
			"tombstone",
			"deletion",
			"deletionPlanCoreSha256",
			"deletionPlanSha256",
			"cleanupProof",
			...(state === "purged" ? ["purgedAt"] : []),
		]);
		const deletion = await deletionPlan(canonical.deletion);
		const expected = await materializeDeletionUnchecked(deletion.core);
		if (
			!equal(canonical.tombstone, expected.tombstone) ||
			canonical.deletionPlanCoreSha256 !== expected.deletionPlanCoreSha256 ||
			canonical.deletionPlanSha256 !== expected.deletionPlanSha256
		)
			invalid("invalid_phase_relationship");
		catalogMatchesDeletion(catalog, deletion, false);
		if (
			state === "purged" &&
			(!iso8601(canonical.purgedAt) ||
				Date.parse(canonical.purgedAt) < Date.parse(deletion.core.purgeAfter) ||
				canonical.cleanupProof === null)
		)
			invalid("invalid_phase_relationship");
		if (canonical.cleanupProof !== null) await terminalProof(canonical.cleanupProof, deletion, expected, catalog);
	} else invalid("invalid_phase_relationship");
	return input as unknown as PersistentWorkspaceAuthorityV1;
}

function requirePresentWorkspace(authority: PersistentWorkspaceAuthorityV1): ValidatedManagedWorkspace {
	if (authority.canonical.state !== "present") invalid("invalid_phase_relationship");
	return managedWorkspace(authority.canonical.workspace);
}

export async function validatePersistentWorkspaceAuthorityV1(input: unknown): Promise<boolean> {
	try {
		await workspaceAuthority(input);
		return true;
	} catch {
		return false;
	}
}

export function appendKnownReplicaV1(
	catalog: KnownReplicaCatalogV1,
	record: KnownReplicaRecordV1,
): KnownReplicaCatalogV1 {
	knownReplicaCatalog(catalog, record.replica.workspaceId);
	knownReplica(record, record.replica.workspaceId);
	if (
		record.lastLeaseId !== null ||
		record.observation.state !== "never_observed" ||
		record.cacheEviction.state !== "not_requested" ||
		record.cleanup.state !== "not_requested"
	)
		throw new PersistentAgentError("invalid_transition", record.replica.replicaId, false, "invalid_fields");
	const existing = catalog.entries.find(entry => replicaKey(entry.replica) === replicaKey(record.replica));
	if (existing) {
		if (equal(existing, record)) return catalog;
		throw new PersistentAgentError("invalid_transition", record.replica.replicaId, false, "invalid_fields");
	}
	const revision = catalog.revision + 1;
	if (!Number.isSafeInteger(revision))
		throw new PersistentAgentError("invalid_transition", record.replica.replicaId, false, "invalid_fields");
	return freeze({
		revision,
		entries: [...catalog.entries, record].sort((left, right) => compareReplica(left.replica, right.replica)),
	});
}

export function replaceKnownReplicaV1(
	catalog: KnownReplicaCatalogV1,
	expectedRevision: number,
	record: KnownReplicaRecordV1,
): KnownReplicaCatalogV1 {
	knownReplicaCatalog(catalog, record.replica.workspaceId);
	knownReplica(record, record.replica.workspaceId);
	if (catalog.revision !== expectedRevision)
		throw new PersistentAgentError("revision_conflict", record.replica.replicaId, true, "record_revision_conflict");
	const index = catalog.entries.findIndex(entry => replicaKey(entry.replica) === replicaKey(record.replica));
	if (index < 0) throw new PersistentAgentError("not_found", record.replica.replicaId, false, "invalid_fields");
	if (equal(catalog.entries[index], record)) return catalog;
	if (!isKnownReplicaReplacementValid(catalog.entries[index]!, record))
		throw new PersistentAgentError("invalid_transition", record.replica.replicaId, false, "invalid_fields");
	const revision = catalog.revision + 1;
	if (!Number.isSafeInteger(revision))
		throw new PersistentAgentError("invalid_transition", record.replica.replicaId, false, "invalid_fields");
	const entries = [...catalog.entries];
	entries[index] = record;
	return freeze({ revision, entries });
}

interface ValidatedPlan extends Record<string, unknown> {
	kind: string;
	operationId: string;
	startedAt: ISO8601;
	startedFromRevision: number;
}

function plan(value: unknown, kind: string, extra: readonly string[]): ValidatedPlan {
	const input = object(value, ["kind", "operationId", "startedAt", "startedFromRevision", ...extra]);
	if (
		input.kind !== kind ||
		!opaqueId(input.operationId) ||
		!iso8601(input.startedAt) ||
		!integer(input.startedFromRevision)
	)
		invalid();
	return input as ValidatedPlan;
}

async function createOperation(value: unknown, revision: number): Promise<void> {
	const operation = object(value, ["kind", "plan", "progress"]);
	if (operation.kind !== "create") invalid("invalid_phase_relationship");
	const createPlan = plan(operation.plan, "create", ["resources", "seed", "retention", "sessionInitPayloadSha256"]);
	if (createPlan.startedFromRevision !== 0 || revision < 1 || !sha256Ref(createPlan.sessionInitPayloadSha256))
		invalid("invalid_phase_relationship");
	const resources = object(createPlan.resources, [
		"workspaceId",
		"workspaceCreateId",
		"workspaceStageId",
		"sessionCreateId",
		"session",
		"runtimeAttachmentCreateId",
	]);
	const plannedSession = sessionRef(resources.session);
	const ids: unknown[] = [
		createPlan.operationId,
		resources.workspaceId,
		resources.workspaceCreateId,
		resources.workspaceStageId,
		resources.sessionCreateId,
		resources.runtimeAttachmentCreateId,
		plannedSession.sessionId,
		plannedSession.sessionInitEntryId,
	];
	try {
		decodeWorkspaceRetentionPolicyV1(createPlan.retention);
	} catch {
		invalid();
	}
	const seedKind =
		createPlan.seed !== null && typeof createPlan.seed === "object"
			? Object.getOwnPropertyDescriptor(createPlan.seed, "kind")?.value
			: undefined;
	let expectedImage: WorkspaceImage;
	if (seedKind === "empty") {
		expectedImage = workspaceImage(object(createPlan.seed, ["kind", "expectedImage"]).expectedImage);
	} else if (seedKind === "copy") {
		const source = object(object(createPlan.seed, ["kind", "source"]).source, [
			"sourceId",
			"bindId",
			"expectedImage",
			"limits",
		]);
		ids.push(source.sourceId, source.bindId);
		expectedImage = workspaceImage(source.expectedImage);
		const limits = object(source.limits, ["maxFiles", "maxFileBytes", "maxTotalBytes", "deniedPatterns"]);
		if (!integer(limits.maxFiles, 1) || !integer(limits.maxFileBytes, 1) || !integer(limits.maxTotalBytes, 1))
			invalid();
		const patterns = array(limits.deniedPatterns);
		if (
			patterns.some(pattern => typeof pattern !== "string" || !wellFormed(pattern)) ||
			new Set(patterns).size !== patterns.length
		)
			invalid();
	} else invalid();
	if (ids.some(value => !opaqueId(value)) || new Set(ids).size !== ids.length) invalid();
	const step =
		operation.progress !== null && typeof operation.progress === "object"
			? Object.getOwnPropertyDescriptor(operation.progress, "step")?.value
			: undefined;
	if (step === "planned") object(operation.progress, ["step"]);
	else if (
		["workspace_ready", "session_header_ready", "session_initialized", "runtime_none_initialized"].includes(
			String(step),
		)
	) {
		const progress = object(operation.progress, [
			"step",
			"workspace",
			...(step === "workspace_ready" ? [] : ["session"]),
			...(step === "runtime_none_initialized" ? ["runtimeAttachmentRevision"] : []),
		]);
		const authority = await workspaceAuthority(progress.workspace);
		const workspace = requirePresentWorkspace(authority);
		if (
			authority.workspaceId !== resources.workspaceId ||
			authority.knownReplicas.revision !== 0 ||
			authority.knownReplicas.entries.length !== 0 ||
			workspace.checkpoint.generation !== 0 ||
			workspace.checkpoint.rootSha256 !== expectedImage.rootSha256 ||
			workspace.checkpoint.fileCount !== expectedImage.fileCount ||
			workspace.checkpoint.byteCount !== expectedImage.byteCount ||
			!equal(workspace.retention, createPlan.retention)
		)
			invalid("invalid_phase_relationship");
		if (step !== "workspace_ready" && !equal(sessionRef(progress.session), plannedSession))
			invalid("invalid_phase_relationship");
		if (step === "runtime_none_initialized" && progress.runtimeAttachmentRevision !== 1)
			invalid("invalid_phase_relationship");
	} else invalid("invalid_phase_relationship");
}

async function steadyOperation(
	value: unknown,
	phase: "park" | "revive" | "fork" | "release",
	sessionValue: unknown,
	workspace: PersistentWorkspaceAuthorityV1,
	revision: number,
): Promise<void> {
	const operation = object(value, ["kind", "plan", "progress"]);
	if (operation.kind !== phase) invalid("invalid_phase_relationship");
	const extras: Readonly<Record<"park" | "revive" | "fork" | "release", readonly string[]>> = {
		park: ["sourceSession", "workspaceId", "expectedGeneration", "runtimeTransitionId"],
		revive: ["session", "workspaceId", "expectedGeneration", "runtimeReconcileTransitionId", "sessionOpenId"],
		fork: ["source", "target", "targetCreateId", "workspaceId", "expectedGeneration"],
		release: ["sourceSession", "workspaceId", "runtimeTransitionId", "disposition"],
	};
	const operationPlan = plan(operation.plan, phase, extras[phase]);
	if (operationPlan.startedFromRevision >= revision || operationPlan.workspaceId !== workspace.workspaceId)
		invalid("invalid_phase_relationship");
	const currentSession = sessionRef(sessionValue);
	const ids: unknown[] = [operationPlan.operationId, currentSession.sessionId, currentSession.sessionInitEntryId];
	let expectedGeneration: number | null = null;
	let disposition: PersistentAgentReleaseDispositionV1 | null = null;
	if (phase === "park") {
		if (
			!equal(sessionRef(operationPlan.sourceSession), currentSession) ||
			!integer(operationPlan.expectedGeneration) ||
			!opaqueId(operationPlan.runtimeTransitionId)
		)
			invalid("invalid_phase_relationship");
		expectedGeneration = operationPlan.expectedGeneration;
		ids.push(operationPlan.runtimeTransitionId);
	} else if (phase === "revive") {
		if (
			!equal(sessionRef(operationPlan.session), currentSession) ||
			!integer(operationPlan.expectedGeneration) ||
			!opaqueId(operationPlan.runtimeReconcileTransitionId) ||
			!opaqueId(operationPlan.sessionOpenId)
		)
			invalid("invalid_phase_relationship");
		expectedGeneration = operationPlan.expectedGeneration;
		ids.push(operationPlan.runtimeReconcileTransitionId, operationPlan.sessionOpenId);
	} else if (phase === "fork") {
		const source = sessionRef(operationPlan.source);
		const target = sessionRef(operationPlan.target);
		if (
			!equal(source, currentSession) ||
			equal(source, target) ||
			source.sessionStorageKey === target.sessionStorageKey ||
			!opaqueId(operationPlan.targetCreateId) ||
			!integer(operationPlan.expectedGeneration)
		)
			invalid("invalid_phase_relationship");
		expectedGeneration = operationPlan.expectedGeneration;
		ids.push(operationPlan.targetCreateId, target.sessionId, target.sessionInitEntryId);
	} else {
		if (
			!equal(sessionRef(operationPlan.sourceSession), currentSession) ||
			!opaqueId(operationPlan.runtimeTransitionId)
		)
			invalid("invalid_phase_relationship");
		disposition = validateDisposition(operationPlan.disposition);
		ids.push(operationPlan.runtimeTransitionId);
		if (disposition.kind === "delete")
			ids.push(disposition.deleteId, disposition.deletionAuthorityId, disposition.quarantineId);
	}
	if (ids.some(value => !opaqueId(value)) || new Set(ids).size !== ids.length) invalid("invalid_phase_relationship");
	const step =
		operation.progress !== null && typeof operation.progress === "object"
			? Object.getOwnPropertyDescriptor(operation.progress, "step")?.value
			: undefined;
	if (!PROGRESS_ORDER[phase]!.includes(String(step))) invalid("invalid_phase_relationship");
	if (step === "planned") {
		object(operation.progress, ["step"]);
		const present = requirePresentWorkspace(workspace);
		if (expectedGeneration !== null && present.checkpoint.generation !== expectedGeneration)
			invalid("invalid_phase_relationship");
	} else if (phase === "park" && ["runtime_none", "session_durable", "session_disposed"].includes(String(step))) {
		const progressCheckpoint = checkpoint(
			object(operation.progress, ["step", "checkpoint"]).checkpoint,
			workspace.workspaceId,
		);
		const present = requirePresentWorkspace(workspace);
		if (
			expectedGeneration === null ||
			progressCheckpoint.generation < expectedGeneration ||
			!equal(progressCheckpoint, present.checkpoint)
		)
			invalid("invalid_phase_relationship");
	} else if (phase === "revive" && step === "runtime_none") {
		const progressCheckpoint = checkpoint(
			object(operation.progress, ["step", "checkpoint"]).checkpoint,
			workspace.workspaceId,
		);
		const present = requirePresentWorkspace(workspace);
		if (
			expectedGeneration === null ||
			progressCheckpoint.generation < expectedGeneration ||
			!equal(progressCheckpoint, present.checkpoint)
		)
			invalid("invalid_phase_relationship");
	} else if (phase === "fork" && step === "target_durable") {
		requirePresentWorkspace(workspace);
		const progress = object(operation.progress, ["step", "target", "targetSha256"]);
		if (!equal(sessionRef(progress.target), sessionRef(operationPlan.target)) || !sha256Ref(progress.targetSha256))
			invalid("invalid_phase_relationship");
	} else if (phase === "release") {
		if (["runtime_none", "session_closed", "workspace_disposition_applied"].includes(String(step))) {
			const progressWorkspace = await workspaceAuthority(
				object(operation.progress, ["step", "workspace"]).workspace,
			);
			if (!equal(progressWorkspace, workspace)) invalid("invalid_phase_relationship");
			if (step === "workspace_disposition_applied") {
				if (disposition?.kind === "retain") requirePresentWorkspace(progressWorkspace);
				else if (disposition?.kind === "delete") {
					if (progressWorkspace.canonical.state !== "tombstoned") invalid("invalid_phase_relationship");
					deletionCoreMatchesDisposition(progressWorkspace.canonical.deletion.core, disposition);
				} else invalid("invalid_phase_relationship");
			} else requirePresentWorkspace(progressWorkspace);
		} else if (step === "deletion_core_planned") {
			const progress = object(operation.progress, ["step", "workspace", "deletionCore", "deletionPlanCoreSha256"]);
			const progressWorkspace = await workspaceAuthority(progress.workspace);
			const core = deletionCore(progress.deletionCore);
			if (
				!equal(progressWorkspace, workspace) ||
				progressWorkspace.canonical.state !== "delete_core_planned" ||
				!equal(progressWorkspace.canonical.deletionCore, core) ||
				progressWorkspace.canonical.deletionPlanCoreSha256 !== progress.deletionPlanCoreSha256 ||
				progress.deletionPlanCoreSha256 !== (await workspaceDeletionPlanCoreSha256V1(core)) ||
				disposition?.kind !== "delete"
			)
				invalid("invalid_phase_relationship");
			deletionCoreMatchesDisposition(core, disposition);
		} else if (step === "delete_planned") {
			const progress = object(operation.progress, [
				"step",
				"workspace",
				"deletion",
				"deletionPlanCoreSha256",
				"deletionPlanSha256",
			]);
			const progressWorkspace = await workspaceAuthority(progress.workspace);
			const deletion = await deletionPlan(progress.deletion);
			const expected = await materializeDeletionUnchecked(deletion.core);
			if (
				!equal(progressWorkspace, workspace) ||
				progressWorkspace.canonical.state !== "delete_planned" ||
				!equal(progressWorkspace.canonical.deletion, deletion) ||
				progress.deletionPlanCoreSha256 !== expected.deletionPlanCoreSha256 ||
				progress.deletionPlanSha256 !== expected.deletionPlanSha256 ||
				progressWorkspace.canonical.deletionPlanCoreSha256 !== expected.deletionPlanCoreSha256 ||
				progressWorkspace.canonical.deletionPlanSha256 !== expected.deletionPlanSha256 ||
				disposition?.kind !== "delete"
			)
				invalid("invalid_phase_relationship");
			deletionCoreMatchesDisposition(deletion.core, disposition);
		} else invalid("invalid_phase_relationship");
	} else invalid("invalid_phase_relationship");
}

function validateDisposition(value: unknown): PersistentAgentReleaseDispositionV1 {
	const kind =
		value !== null && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "kind")?.value : undefined;
	if (kind === "retain") return object(value, ["kind"]) as unknown as PersistentAgentReleaseDispositionV1;
	if (kind === "delete") {
		const input = object(value, ["kind", "deleteId", "deletionAuthorityId", "quarantineId", "deletedBytesGraceMs"]);
		if (
			!opaqueId(input.deleteId) ||
			!opaqueId(input.deletionAuthorityId) ||
			!opaqueId(input.quarantineId) ||
			new Set([input.deleteId, input.deletionAuthorityId, input.quarantineId]).size !== 3 ||
			!integer(input.deletedBytesGraceMs) ||
			input.deletedBytesGraceMs > 2_147_483_647
		)
			invalid();
		return input as unknown as PersistentAgentReleaseDispositionV1;
	}
	invalid();
}

function deletionCoreMatchesDisposition(
	core: WorkspaceDeletionPlanCoreV1,
	disposition: Extract<PersistentAgentReleaseDispositionV1, { readonly kind: "delete" }>,
): void {
	if (
		core.deleteId !== disposition.deleteId ||
		core.deletionAuthorityId !== disposition.deletionAuthorityId ||
		core.quarantineId !== disposition.quarantineId ||
		core.deletedBytesGraceMs !== disposition.deletedBytesGraceMs
	)
		invalid("invalid_phase_relationship");
}

function common(input: Record<string, unknown>): void {
	if (input.schemaVersion !== 1) invalid("unsupported_schema");
	if (
		!integer(input.revision, 1) ||
		!opaqueId(input.controlHostId) ||
		!agentId(input.agentId) ||
		!opaqueId(input.displayName) ||
		(input.kind !== "main" && input.kind !== "sub") ||
		!opaqueId(input.modelProfileId) ||
		!iso8601(input.createdAt) ||
		!iso8601(input.updatedAt) ||
		Date.parse(input.updatedAt) < Date.parse(input.createdAt)
	)
		invalid();
	if (input.kind === "main") {
		if (input.agentId !== "Main" || input.parentAgentId !== null) invalid("invalid_phase_relationship");
	} else if (
		!agentId(input.parentAgentId) ||
		normalizePersistentAgentIdV1(input.parentAgentId) === normalizePersistentAgentIdV1(input.agentId)
	)
		invalid("invalid_phase_relationship");
	if (normalizePersistentAgentIdV1(input.agentId) === "main" && input.kind !== "main")
		invalid("invalid_phase_relationship");
	try {
		decodePersistentRuntimePolicyV1(input.runtimePolicy);
	} catch {
		invalid();
	}
}

async function recovery(value: unknown, revision: number, updatedAt: ISO8601): Promise<void> {
	if (value === null || typeof value !== "object") invalid();
	const failedPhase = Object.getOwnPropertyDescriptor(value, "failedPhase")?.value;
	const input = object(value, [
		"code",
		"operationId",
		"detectedAt",
		"failedPhase",
		"operation",
		...(failedPhase === "creating" ? [] : ["session", "workspace"]),
	]);
	if (
		typeof input.code !== "string" ||
		!Object.hasOwn(RECOVERY_CODES, input.code) ||
		!iso8601(input.detectedAt) ||
		input.detectedAt !== updatedAt ||
		!["creating", "open", "parking", "parked", "reviving", "forking", "releasing"].includes(String(failedPhase))
	)
		invalid();
	const interrupted: Readonly<Record<string, string>> = {
		creating: "interrupted_create",
		open: "interrupted_open",
		parking: "interrupted_park",
		reviving: "interrupted_revive",
		forking: "interrupted_fork",
		releasing: "interrupted_release",
	};
	if (input.code.startsWith("interrupted_") && interrupted[String(failedPhase)] !== input.code)
		invalid("invalid_phase_relationship");
	if (failedPhase === "creating") {
		if (!opaqueId(input.operationId)) invalid();
		await createOperation(input.operation, revision);
	} else if (failedPhase === "open" || failedPhase === "parked") {
		if (input.operation !== null || input.operationId !== null) invalid("invalid_phase_relationship");
		sessionRef(input.session);
		requirePresentWorkspace(await workspaceAuthority(input.workspace));
	} else {
		if (!opaqueId(input.operationId)) invalid();
		const session = sessionRef(input.session);
		const workspace = await workspaceAuthority(input.workspace);
		await steadyOperation(
			input.operation,
			failedPhase === "parking"
				? "park"
				: failedPhase === "reviving"
					? "revive"
					: failedPhase === "forking"
						? "fork"
						: "release",
			session,
			workspace,
			revision,
		);
	}
	const operationId =
		input.operation !== null ? (input.operation as { plan?: { operationId?: unknown } }).plan?.operationId : null;
	if (operationId !== input.operationId) invalid("invalid_phase_relationship");
}

export async function validatePersistentAgentRecordV1(
	inputValue: unknown,
	expectedAgentId?: PersistentAgentId,
): Promise<PersistentAgentRecordValidationV1> {
	try {
		if (inputValue === null || typeof inputValue !== "object") invalid();
		const phase = Object.getOwnPropertyDescriptor(inputValue, "phase")?.value;
		if (typeof phase !== "string" || !Object.hasOwn(PHASES, phase)) invalid("invalid_phase_relationship");
		const phaseKeys =
			phase === "creating"
				? ["phase", "operation", "releasedAt"]
				: phase === "released"
					? ["phase", "operation", "session", "workspace", "release", "releasedAt"]
					: phase === "recovery_required"
						? ["phase", "recovery"]
						: ["phase", "operation", "session", "workspace", "releasedAt"];
		const input = object(inputValue, [...COMMON_KEYS, ...phaseKeys]);
		common(input);
		if (
			expectedAgentId !== undefined &&
			normalizePersistentAgentIdV1(input.agentId as string) !== normalizePersistentAgentIdV1(expectedAgentId)
		)
			invalid("agent_key_mismatch");
		if (phase === "creating") {
			if (input.releasedAt !== null) invalid("invalid_phase_relationship");
			await createOperation(input.operation, input.revision as number);
		} else if (phase === "open" || phase === "parked") {
			if (input.operation !== null || input.releasedAt !== null) invalid("invalid_phase_relationship");
			sessionRef(input.session);
			requirePresentWorkspace(await workspaceAuthority(input.workspace));
		} else if (["parking", "reviving", "forking", "releasing"].includes(phase)) {
			if (input.releasedAt !== null) invalid("invalid_phase_relationship");
			const session = sessionRef(input.session);
			const workspace = await workspaceAuthority(input.workspace);
			await steadyOperation(
				input.operation,
				phase === "parking" ? "park" : phase === "reviving" ? "revive" : phase === "forking" ? "fork" : "release",
				session,
				workspace,
				input.revision as number,
			);
		} else if (phase === "released") {
			if (
				input.operation !== null ||
				!iso8601(input.releasedAt) ||
				Date.parse(input.updatedAt as string) < Date.parse(input.releasedAt)
			)
				invalid("invalid_phase_relationship");
			sessionRef(input.session);
			const workspace = await workspaceAuthority(input.workspace);
			const release = object(input.release, ["operationId", "disposition", "completedAt"]);
			if (!opaqueId(release.operationId) || release.completedAt !== input.releasedAt)
				invalid("invalid_phase_relationship");
			const disposition = validateDisposition(release.disposition);
			if (
				disposition.kind === "delete" &&
				[disposition.deleteId, disposition.deletionAuthorityId, disposition.quarantineId].includes(
					release.operationId as string,
				)
			)
				invalid("invalid_phase_relationship");
			if (disposition.kind === "delete") {
				if (workspace.canonical.state !== "tombstoned" && workspace.canonical.state !== "purged")
					invalid("invalid_phase_relationship");
				deletionCoreMatchesDisposition(workspace.canonical.deletion.core, disposition);
			}
		} else await recovery(input.recovery, input.revision as number, input.updatedAt as ISO8601);
		return { ok: true, record: freeze(inputValue as PersistentAgentRecordV1) };
	} catch (error) {
		return { ok: false, reason: error instanceof InvalidRecord ? error.reason : "invalid_fields" };
	}
}

export async function decodePersistentAgentRecordV1(
	input: unknown,
	expectedAgentId?: PersistentAgentId,
): Promise<PersistentAgentRecordV1> {
	const result = await validatePersistentAgentRecordV1(input, expectedAgentId);
	if (result.ok) return result.record;
	throw new PersistentAgentError("invalid_record", expectedAgentId ?? "unknown", false, result.reason);
}

function operationProgress(record: PersistentAgentRecordV1): PersistentAgentOperationV1 | null {
	if (record.phase === "recovery_required" || record.operation === null) return null;
	return record.operation;
}

function validateOperationContinuation(current: PersistentAgentOperationV1, next: PersistentAgentOperationV1): void {
	const order = PROGRESS_ORDER[current.kind];
	const currentRank = order?.indexOf(current.progress.step) ?? -1;
	const nextRank = order?.indexOf(next.progress.step) ?? -1;
	if (
		current.kind !== next.kind ||
		!equal(current.plan, next.plan) ||
		currentRank < 0 ||
		nextRank < currentRank ||
		nextRank > currentRank + 1 ||
		(nextRank === currentRank && current.kind !== "release" && !equal(current, next))
	)
		invalid("invalid_phase_relationship");
}

function recordWorkspaceAuthority(record: PersistentAgentRecordV1): PersistentWorkspaceAuthorityV1 | null {
	if (record.phase === "creating") return null;
	if (record.phase === "recovery_required") {
		return record.recovery.failedPhase === "creating" ? null : record.recovery.workspace;
	}
	return record.workspace;
}

function canonicalWorkspaceStateRank(state: PersistentCanonicalWorkspaceStateV1["state"]): number {
	switch (state) {
		case "present":
			return 0;
		case "delete_core_planned":
			return 1;
		case "delete_planned":
			return 2;
		case "tombstoned":
			return 3;
		case "purged":
			return 4;
	}
}

function canonicalManagedWorkspace(state: PersistentCanonicalWorkspaceStateV1): ValidatedManagedWorkspace | null {
	return state.state === "present" || state.state === "delete_core_planned" || state.state === "delete_planned"
		? state.workspace
		: null;
}

function canonicalDeletionCore(state: PersistentCanonicalWorkspaceStateV1): WorkspaceDeletionPlanCoreV1 | null {
	if (state.state === "delete_core_planned") return state.deletionCore;
	return state.state === "delete_planned" || state.state === "tombstoned" || state.state === "purged"
		? state.deletion.core
		: null;
}

function canonicalDeletionPlan(state: PersistentCanonicalWorkspaceStateV1): WorkspaceDeletionPlanV1 | null {
	return state.state === "delete_planned" || state.state === "tombstoned" || state.state === "purged"
		? state.deletion
		: null;
}

function canonicalTombstone(state: PersistentCanonicalWorkspaceStateV1): WorkspaceTombstone | null {
	return state.state === "tombstoned" || state.state === "purged" ? state.tombstone : null;
}

function canonicalCleanupProof(state: PersistentCanonicalWorkspaceStateV1): TerminalReplicaCleanupProofV1 | null {
	return state.state === "tombstoned" || state.state === "purged" ? state.cleanupProof : null;
}

function validateCanonicalWorkspaceReplacement(
	current: PersistentCanonicalWorkspaceStateV1,
	next: PersistentCanonicalWorkspaceStateV1,
): void {
	const currentRank = canonicalWorkspaceStateRank(current.state);
	const nextRank = canonicalWorkspaceStateRank(next.state);
	if (nextRank < currentRank || nextRank > currentRank + 1) invalid("invalid_phase_relationship");
	const currentWorkspace = canonicalManagedWorkspace(current);
	const nextWorkspace = canonicalManagedWorkspace(next);
	if (currentWorkspace && !nextWorkspace) {
		if (nextRank < 3) invalid("invalid_phase_relationship");
	} else if (currentWorkspace && nextWorkspace) {
		if (
			!equal(currentWorkspace.retention, nextWorkspace.retention) ||
			nextWorkspace.checkpoint.generation < currentWorkspace.checkpoint.generation ||
			(nextWorkspace.checkpoint.generation === currentWorkspace.checkpoint.generation &&
				!equal(currentWorkspace.checkpoint, nextWorkspace.checkpoint))
		)
			invalid("invalid_phase_relationship");
	}
	const currentCore = canonicalDeletionCore(current);
	const nextCore = canonicalDeletionCore(next);
	if (currentCore && (!nextCore || !equal(currentCore, nextCore))) invalid("invalid_phase_relationship");
	const currentPlan = canonicalDeletionPlan(current);
	const nextPlan = canonicalDeletionPlan(next);
	if (currentPlan && (!nextPlan || !equal(currentPlan, nextPlan))) invalid("invalid_phase_relationship");
	const currentTombstone = canonicalTombstone(current);
	const nextTombstone = canonicalTombstone(next);
	if (currentTombstone && (!nextTombstone || !equal(currentTombstone, nextTombstone)))
		invalid("invalid_phase_relationship");
	const currentProof = canonicalCleanupProof(current);
	const nextProof = canonicalCleanupProof(next);
	if (currentProof && (!nextProof || !equal(currentProof, nextProof))) invalid("invalid_phase_relationship");
	if (
		next.state === "purged" &&
		(current.state !== "tombstoned" ||
			current.cleanupProof === null ||
			next.cleanupProof === null ||
			!equal(current.cleanupProof, next.cleanupProof))
	)
		invalid("invalid_phase_relationship");
	if (current.state === "purged" && !equal(current, next)) invalid("invalid_phase_relationship");
}

function validateCatalogReplacement(current: KnownReplicaCatalogV1, next: KnownReplicaCatalogV1): void {
	if (equal(current, next)) return;
	if (next.revision !== current.revision + 1 || next.entries.length < current.entries.length)
		invalid("invalid_phase_relationship");
	const currentByReplica = new Map(current.entries.map(entry => [replicaKey(entry.replica), entry]));
	let changes = 0;
	for (const nextEntry of next.entries) {
		const key = replicaKey(nextEntry.replica);
		const currentEntry = currentByReplica.get(key);
		if (!currentEntry) {
			if (
				nextEntry.lastLeaseId !== null ||
				nextEntry.observation.state !== "never_observed" ||
				nextEntry.cacheEviction.state !== "not_requested" ||
				nextEntry.cleanup.state !== "not_requested"
			)
				invalid("invalid_phase_relationship");
			changes++;
			continue;
		}
		if (!isKnownReplicaReplacementValid(currentEntry, nextEntry)) invalid("invalid_phase_relationship");
		if (!equal(currentEntry, nextEntry)) changes++;
		currentByReplica.delete(key);
	}
	if (currentByReplica.size !== 0 || changes !== 1) invalid("invalid_phase_relationship");
}

function transition(current: PersistentAgentRecordV1, next: PersistentAgentRecordV1): void {
	if (
		next.revision !== current.revision + 1 ||
		next.agentId !== current.agentId ||
		next.controlHostId !== current.controlHostId ||
		next.createdAt !== current.createdAt ||
		next.displayName !== current.displayName ||
		next.kind !== current.kind ||
		next.parentAgentId !== current.parentAgentId ||
		next.modelProfileId !== current.modelProfileId ||
		Date.parse(next.updatedAt) < Date.parse(current.updatedAt)
	)
		invalid("invalid_phase_relationship");
	const allowed: Readonly<Record<string, readonly string[]>> = {
		creating: ["creating", "open", "recovery_required"],
		open: ["open", "parking", "forking", "releasing", "recovery_required"],
		parking: ["parking", "parked", "recovery_required"],
		parked: ["parked", "reviving", "releasing", "recovery_required"],
		reviving: ["reviving", "open", "parked", "recovery_required"],
		forking: ["forking", "open", "recovery_required"],
		releasing: ["releasing", "released", "recovery_required"],
		released: ["released"],
		recovery_required: [
			"creating",
			"open",
			"parking",
			"parked",
			"reviving",
			"forking",
			"releasing",
			"released",
			"recovery_required",
		],
	};
	if (!allowed[current.phase]!.includes(next.phase)) invalid("invalid_phase_relationship");
	const policyChanged = !equal(current.runtimePolicy, next.runtimePolicy);
	if (
		policyChanged &&
		!(
			(current.phase === "open" || current.phase === "parked") &&
			next.phase === current.phase &&
			equal(current.session, next.session) &&
			equal(current.workspace, next.workspace)
		)
	)
		invalid("invalid_phase_relationship");
	if (
		current.phase === next.phase &&
		(current.phase === "open" || current.phase === "parked") &&
		(next.phase === "open" || next.phase === "parked") &&
		!equal(current.session, next.session)
	)
		invalid("invalid_phase_relationship");
	if (next.phase === "recovery_required" && current.phase !== "recovery_required") {
		const recovery = next.recovery;
		if (
			recovery.failedPhase !== current.phase ||
			recovery.detectedAt !== next.updatedAt ||
			!equal(recovery.operation, current.operation)
		)
			invalid("invalid_phase_relationship");
		if (
			current.phase !== "creating" &&
			(!equal((recovery as { readonly session: unknown }).session, current.session) ||
				!equal((recovery as { readonly workspace: unknown }).workspace, current.workspace))
		)
			invalid("invalid_phase_relationship");
	}
	if (current.phase === "recovery_required") {
		const recoveryAllowed: Readonly<Record<string, readonly string[]>> = {
			creating: ["creating", "open", "recovery_required"],
			open: ["open", "parked", "recovery_required"],
			parking: ["parking", "parked", "recovery_required"],
			parked: ["parked", "reviving", "recovery_required"],
			reviving: ["reviving", "open", "parked", "recovery_required"],
			forking: ["forking", "open", "recovery_required"],
			releasing: ["releasing", "released", "recovery_required"],
		};
		const recovery = current.recovery;
		if (!recoveryAllowed[recovery.failedPhase]!.includes(next.phase)) invalid("invalid_phase_relationship");
		if (next.phase === "recovery_required") {
			if (
				next.recovery.failedPhase !== recovery.failedPhase ||
				next.recovery.operationId !== recovery.operationId ||
				(recovery.failedPhase !== "creating" &&
					!equal(
						(next.recovery as { readonly session?: unknown }).session,
						(recovery as { readonly session?: unknown }).session,
					)) ||
				(recovery.operation === null) !== (next.recovery.operation === null)
			)
				invalid("invalid_phase_relationship");
			if (recovery.operation && next.recovery.operation)
				validateOperationContinuation(recovery.operation, next.recovery.operation);
		} else if (recovery.failedPhase !== "creating") {
			if (recovery.failedPhase === "forking" && next.phase === "open") {
				if (
					recovery.operation.progress.step !== "target_durable" ||
					!equal(next.session, recovery.operation.plan.target) ||
					!equal(next.session, recovery.operation.progress.target) ||
					!equal(next.workspace, recovery.workspace)
				)
					invalid("invalid_phase_relationship");
			} else if ("session" in next && !equal(next.session, recovery.session)) {
				invalid("invalid_phase_relationship");
			}
			if (next.phase !== recovery.failedPhase && !equal(recordWorkspaceAuthority(next), recovery.workspace))
				invalid("invalid_phase_relationship");
		}
		if (next.phase === recovery.failedPhase && recovery.operation && "operation" in next && next.operation)
			validateOperationContinuation(recovery.operation, next.operation);
		if (
			recovery.failedPhase === "parked" &&
			next.phase === "reviving" &&
			next.operation.plan.startedFromRevision !== current.revision
		)
			invalid("invalid_phase_relationship");
	}
	if (current.phase === "recovery_required") {
		const recovery = current.recovery;
		if (recovery.failedPhase === "creating" && next.phase === "open") {
			if (
				recovery.operation.progress.step !== "runtime_none_initialized" ||
				!equal(next.session, recovery.operation.plan.resources.session) ||
				!equal(next.session, recovery.operation.progress.session) ||
				!equal(next.workspace, recovery.operation.progress.workspace)
			)
				invalid("invalid_phase_relationship");
		} else if (recovery.failedPhase === "parking" && next.phase === "parked") {
			if (recovery.operation.progress.step !== "session_disposed") invalid("invalid_phase_relationship");
		} else if (recovery.failedPhase === "reviving" && (next.phase === "open" || next.phase === "parked")) {
			if (recovery.operation.progress.step !== "runtime_none") invalid("invalid_phase_relationship");
		} else if (recovery.failedPhase === "releasing" && next.phase === "released") {
			if (
				recovery.operation.progress.step !== "workspace_disposition_applied" ||
				next.release.operationId !== recovery.operation.plan.operationId ||
				!equal(next.release.disposition, recovery.operation.plan.disposition)
			)
				invalid("invalid_phase_relationship");
		}
	}
	const before = operationProgress(current);
	const after = operationProgress(next);
	if (
		after &&
		current.phase !== "recovery_required" &&
		(!before || before.kind !== after.kind) &&
		after.plan.startedFromRevision !== current.revision
	)
		invalid("invalid_phase_relationship");
	if (
		after &&
		(current.phase === "open" || current.phase === "parked") &&
		(!("session" in next) ||
			!equal(current.session, next.session) ||
			!("workspace" in next) ||
			!equal(current.workspace, next.workspace))
	)
		invalid("invalid_phase_relationship");
	if (before && after && before.kind === after.kind) {
		if (!equal(before.plan, after.plan)) invalid("invalid_phase_relationship");
		const order = PROGRESS_ORDER[before.kind];
		const beforeRank = order?.indexOf(before.progress.step) ?? -1;
		const afterRank = order?.indexOf(after.progress.step) ?? -1;
		const retainReleaseCompletion =
			before.kind === "release" &&
			after.kind === "release" &&
			before.progress.step === "session_closed" &&
			after.progress.step === "workspace_disposition_applied" &&
			before.plan.disposition.kind === "retain";
		if (beforeRank < 0 || afterRank < beforeRank || (afterRank > beforeRank + 1 && !retainReleaseCompletion))
			invalid("invalid_phase_relationship");
		if (
			beforeRank === afterRank &&
			before.kind !== "release" &&
			!equal(
				(current as { readonly operation?: unknown }).operation,
				(next as { readonly operation?: unknown }).operation,
			)
		)
			invalid("invalid_phase_relationship");
	}
	if (
		current.phase === "creating" &&
		next.phase === "open" &&
		(current.operation.progress.step !== "runtime_none_initialized" ||
			!equal(next.session, current.operation.plan.resources.session) ||
			!equal(next.session, current.operation.progress.session) ||
			!equal(next.workspace, current.operation.progress.workspace))
	)
		invalid("invalid_phase_relationship");
	if (
		current.phase === "parking" &&
		next.phase === "parked" &&
		(current.operation.progress.step !== "session_disposed" ||
			!equal(current.session, next.session) ||
			!equal(current.workspace, next.workspace))
	)
		invalid("invalid_phase_relationship");
	if (
		current.phase === "reviving" &&
		(next.phase === "open" || next.phase === "parked") &&
		(current.operation.progress.step !== "runtime_none" ||
			!equal(current.session, next.session) ||
			!equal(current.workspace, next.workspace))
	)
		invalid("invalid_phase_relationship");
	if (
		current.phase === "releasing" &&
		next.phase === "released" &&
		(current.operation.progress.step !== "workspace_disposition_applied" ||
			!equal(current.session, next.session) ||
			!equal(current.workspace, next.workspace) ||
			next.release.operationId !== current.operation.plan.operationId ||
			!equal(next.release.disposition, current.operation.plan.disposition))
	)
		invalid("invalid_phase_relationship");
	if (
		current.phase === "forking" &&
		next.phase === "open" &&
		(current.operation.progress.step !== "target_durable" ||
			!equal(next.session, current.operation.plan.target) ||
			!equal(next.session, current.operation.progress.target) ||
			!equal(next.workspace, current.workspace))
	)
		invalid("invalid_phase_relationship");
	if (
		current.phase === "released" &&
		next.phase === "released" &&
		(!equal(current.session, next.session) ||
			!equal(current.release, next.release) ||
			current.releasedAt !== next.releasedAt)
	)
		invalid("invalid_phase_relationship");
	const currentWorkspace = recordWorkspaceAuthority(current);
	const nextWorkspace = recordWorkspaceAuthority(next);
	if (currentWorkspace && !nextWorkspace) invalid("invalid_phase_relationship");
	if (currentWorkspace && nextWorkspace) {
		if (currentWorkspace.workspaceId !== nextWorkspace.workspaceId) invalid("invalid_phase_relationship");
		validateCanonicalWorkspaceReplacement(currentWorkspace.canonical, nextWorkspace.canonical);
		if (
			currentWorkspace.canonical.state !== nextWorkspace.canonical.state &&
			!equal(currentWorkspace.knownReplicas, nextWorkspace.knownReplicas)
		)
			invalid("invalid_phase_relationship");
		if (
			currentWorkspace.canonical.state === "tombstoned" &&
			currentWorkspace.canonical.cleanupProof === null &&
			nextWorkspace.canonical.state === "tombstoned" &&
			nextWorkspace.canonical.cleanupProof !== null &&
			!equal(currentWorkspace.knownReplicas, nextWorkspace.knownReplicas)
		)
			invalid("invalid_phase_relationship");
		if (
			currentWorkspace.canonical.state === "purged" &&
			!equal(currentWorkspace.knownReplicas, nextWorkspace.knownReplicas)
		)
			invalid("invalid_phase_relationship");
		if (
			current.phase === "released" &&
			nextWorkspace.knownReplicas.entries.length > currentWorkspace.knownReplicas.entries.length
		)
			invalid("invalid_phase_relationship");
		validateCatalogReplacement(currentWorkspace.knownReplicas, nextWorkspace.knownReplicas);
	}
}

function ownershipEpoch(
	value: unknown,
	expectedAgentId: PersistentAgentId,
	controlHostId: string,
): PersistentAgentOwnershipEpochRecordV1 {
	const input = object(value, ["schemaVersion", "agentId", "controlHostId", "ownerEpoch", "updatedAt"]);
	if (
		input.schemaVersion !== 1 ||
		!agentId(input.agentId) ||
		normalizePersistentAgentIdV1(input.agentId) !== normalizePersistentAgentIdV1(expectedAgentId) ||
		input.controlHostId !== controlHostId ||
		!integer(input.ownerEpoch, 1) ||
		!iso8601(input.updatedAt)
	)
		invalid();
	return input as unknown as PersistentAgentOwnershipEpochRecordV1;
}

function abort(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function chmod(target: string, mode: number): Promise<void> {
	try {
		await fs.promises.chmod(target, mode);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

async function initializeRoot(root: string, storage: SessionStorage, requestedHostId?: string): Promise<string> {
	await fs.promises.mkdir(root, { recursive: true, mode: DIRECTORY_MODE });
	for (const directory of ["records", "locks", "ownership", "sessions", "workspaces", "runtime"]) {
		const target = path.join(root, directory);
		await fs.promises.mkdir(target, { recursive: true, mode: DIRECTORY_MODE });
		await chmod(target, DIRECTORY_MODE);
	}
	await chmod(root, DIRECTORY_MODE);
	const hostPath = path.join(root, "control-host.json");
	try {
		const input = object(JSON.parse(await storage.readText(hostPath)), ["schemaVersion", "controlHostId"]);
		if (input.schemaVersion !== 1 || !opaqueId(input.controlHostId))
			throw new PersistentAgentError("ownership_unavailable", "Main", false, "invalid_fields");
		if (requestedHostId !== undefined && requestedHostId !== input.controlHostId)
			throw new PersistentAgentError("wrong_control_host", "Main", false, "wrong_control_host");
		return input.controlHostId;
	} catch (error) {
		if (!isEnoent(error)) {
			if (error instanceof PersistentAgentError) throw error;
			throw new PersistentAgentError("ownership_unavailable", "Main", false, "invalid_fields");
		}
	}
	const controlHostId = requestedHostId ?? crypto.randomUUID();
	if (!opaqueId(controlHostId))
		throw new PersistentAgentError("ownership_unavailable", "Main", false, "invalid_fields");
	await storage.writeTextAtomic(hostPath, jsonLine({ schemaVersion: 1, controlHostId }));
	await storage.drain();
	await chmod(hostPath, FILE_MODE);
	const reread = object(JSON.parse(await storage.readText(hostPath)), ["schemaVersion", "controlHostId"]);
	if (reread.schemaVersion !== 1 || reread.controlHostId !== controlHostId)
		throw new PersistentAgentError("ownership_unavailable", "Main", true, "primary_persistence_indeterminate");
	return controlHostId;
}

class FileOwnership implements PersistentAgentOwnership {
	#held = true;
	#revision: number | null | undefined;
	#tail: Promise<void> = Promise.resolve();
	constructor(
		readonly agentId: PersistentAgentId,
		readonly controlHostId: string,
		readonly intent: PersistentAgentOwnershipIntent,
		readonly ownerEpoch: number,
		readonly acquiredAt: ISO8601,
		readonly lock: FileLock,
		readonly store: FilePersistentAgentStore,
	) {}
	isHeld(): boolean {
		return this.#held && this.lock.acquired && this.store.isCurrent(this);
	}
	read(): Promise<PersistentAgentLookup> {
		return this.#serialize(async () => {
			this.requireHeld();
			const result = await this.store.lookup(this.agentId);
			this.observe(result.kind === "record" ? result.record.revision : null);
			return result;
		});
	}
	insert(record: PersistentAgentCreatingRecordV1): Promise<PersistentAgentCreatingRecordV1> {
		return this.#serialize(async () => {
			this.requireHeld();
			if (typeof this.#revision === "number")
				throw new PersistentAgentError("already_exists", this.agentId, false, "record_revision_conflict");
			const result = await this.store.insert(this, record);
			this.#revision = result.revision;
			return result;
		});
	}
	replace(
		expectedRevision: number,
		next: PersistentAgentRecordV1,
		commitGuard: PersistentAgentRecordCommitGuardV1,
	): Promise<PersistentAgentRecordV1> {
		return this.#serialize(async () => {
			this.requireHeld();
			if (this.#revision !== undefined && this.#revision !== expectedRevision)
				throw new PersistentAgentError("revision_conflict", this.agentId, true, "record_revision_conflict");
			const result = await this.store.replace(this, expectedRevision, next, commitGuard);
			this.#revision = result.revision;
			return result;
		});
	}
	deleteCreating(expectedRevision: number): Promise<void> {
		return this.#serialize(async () => {
			this.requireHeld();
			if (this.#revision !== undefined && this.#revision !== expectedRevision)
				throw new PersistentAgentError("revision_conflict", this.agentId, true, "record_revision_conflict");
			await this.store.deleteCreating(this, expectedRevision);
			this.#revision = null;
		});
	}
	close(): Promise<void> {
		return this.#serialize(async () => {
			if (!this.#held) return;
			this.#held = false;
			this.store.close(this);
		});
	}
	requireHeld(): void {
		if (!this.isHeld())
			throw new PersistentAgentError("ownership_unavailable", this.agentId, false, "ownership_conflict");
	}
	observe(revision: number | null): void {
		this.#revision = revision;
	}
	canPublish(expectedRevision: number | null): boolean {
		return this.isHeld() && this.#revision === expectedRevision;
	}
	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

export class FilePersistentAgentStore implements PersistentAgentStore {
	readonly controlHostId: string;
	readonly #root: string;
	readonly #storage: SessionStorage;
	readonly #now: () => Date;
	readonly #owners = new Map<string, FileOwnership>();
	readonly #gitEffectSafety: TransientTaskGitEffectSafetyV1;
	readonly #gitHandleIssuer: object;

	private constructor(root: string, controlHostId: string, storage: SessionStorage, now: () => Date) {
		this.#root = root;
		this.controlHostId = controlHostId;
		this.#storage = storage;
		this.#now = now;
		// Constructor-time composition is deliberately after ESM evaluation.
		const runtime = createTransientTaskGitEffectSafetyRuntimeV1(TRANSIENT_TASK_GIT_RUNTIME_MINT_AUTHORITY);
		this.#gitEffectSafety = runtime.effectSafety;
		this.#gitHandleIssuer = runtime.handleIssuer;
		if (
			typeof this.#gitEffectSafety.importObjectOnly !== "function" ||
			typeof this.#gitEffectSafety.compareAndSwapCaptureRef !== "function" ||
			typeof this.#gitEffectSafety.compareAndSwapDeleteCaptureRef !== "function" ||
			!Object.hasOwn(this.#gitHandleIssuer, "mintCaptureRepositoryHandle") ||
			!Object.hasOwn(this.#gitHandleIssuer, "mintIsolationCleanupHandle")
		) {
			throw new Error("Git effect-safety runtime composition is incomplete.");
		}
	}

	static async open(options: FilePersistentAgentStoreOptions = {}): Promise<FilePersistentAgentStore> {
		const root = options.rootDir ?? path.join(getAgentDir(), "persistent-agents", "v1");
		const storage = options.storage ?? new FileSessionStorage();
		return new FilePersistentAgentStore(
			root,
			await initializeRoot(root, storage, options.controlHostId),
			storage,
			options.now ?? (() => new Date()),
		);
	}

	async lookup(value: PersistentAgentId, signal?: AbortSignal): Promise<PersistentAgentLookup> {
		abort(signal);
		const key = persistentAgentStorageKeyV1(value);
		let text: string;
		try {
			text = await this.#storage.readText(this.#recordPath(key));
		} catch (error) {
			if (isEnoent(error)) return { kind: "missing", agentId: value };
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { kind: "invalid", agentId: value, recordStorageKey: key, reason: "invalid_json" };
		}
		const result = await validatePersistentAgentRecordV1(parsed, value);
		return result.ok
			? { kind: "record", record: result.record }
			: { kind: "invalid", agentId: value, recordStorageKey: key, reason: result.reason };
	}

	async list(signal?: AbortSignal): Promise<readonly PersistentAgentLookup[]> {
		abort(signal);
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(path.join(this.#root, "records"), { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) return [];
			throw error;
		}
		const results: PersistentAgentLookup[] = [];
		for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
			abort(signal);
			if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
			const key = entry.name.slice(0, -5);
			let parsed: unknown;
			try {
				parsed = JSON.parse(await this.#storage.readText(this.#recordPath(key)));
			} catch (error) {
				if (error instanceof SyntaxError)
					results.push({ kind: "invalid", agentId: key, recordStorageKey: key, reason: "invalid_json" });
				else if (!isEnoent(error)) throw error;
				continue;
			}
			const rawId =
				parsed !== null && typeof parsed === "object"
					? Object.getOwnPropertyDescriptor(parsed, "agentId")?.value
					: undefined;
			const id = agentId(rawId) ? rawId : key;
			const validation = await validatePersistentAgentRecordV1(parsed, agentId(rawId) ? rawId : undefined);
			if (!validation.ok)
				results.push({ kind: "invalid", agentId: id, recordStorageKey: key, reason: validation.reason });
			else if (persistentAgentStorageKeyV1(validation.record.agentId) !== key)
				results.push({
					kind: "invalid",
					agentId: validation.record.agentId,
					recordStorageKey: key,
					reason: "agent_key_mismatch",
				});
			else results.push({ kind: "record", record: validation.record });
		}
		return results.sort((left, right) =>
			compareUtf8(
				(left.kind === "record" ? left.record.agentId : left.agentId).toLowerCase(),
				(right.kind === "record" ? right.record.agentId : right.agentId).toLowerCase(),
			),
		);
	}

	async inspectOwnership(value: PersistentAgentId, signal?: AbortSignal): Promise<PersistentAgentOwnershipStatus> {
		abort(signal);
		const local = this.#owners.get(normalizePersistentAgentIdV1(value));
		if (local?.isHeld())
			return {
				state: "owned_here",
				controlHostId: this.controlHostId,
				processId: process.pid,
				intent: local.intent,
				acquiredAt: local.acquiredAt,
			};
		let lock: FileLock;
		try {
			lock = FileLock.tryAcquire(this.#lockPath(persistentAgentStorageKeyV1(value)));
		} catch {
			return {
				state: "unavailable",
				controlHostId: this.controlHostId,
				processId: null,
				intent: null,
				acquiredAt: null,
			};
		}
		if (!lock.acquired) {
			lock.release();
			return {
				state: "owned_elsewhere",
				controlHostId: this.controlHostId,
				processId: null,
				intent: null,
				acquiredAt: null,
			};
		}
		lock.release();
		const lookup = await this.lookup(value, signal);
		const interrupted =
			lookup.kind === "invalid" ||
			(lookup.kind === "record" && !["parked", "released"].includes(lookup.record.phase));
		return {
			state: interrupted ? "interrupted" : "unowned",
			controlHostId: this.controlHostId,
			processId: null,
			intent: null,
			acquiredAt: null,
		};
	}

	async acquire(
		value: PersistentAgentId,
		intent: PersistentAgentOwnershipIntent,
		signal?: AbortSignal,
	): Promise<PersistentAgentOwnership> {
		abort(signal);
		const normalized = normalizePersistentAgentIdV1(value);
		if (this.#owners.get(normalized)?.isHeld())
			throw new PersistentAgentError("owned_elsewhere", value, true, "ownership_conflict");
		const key = persistentAgentStorageKeyV1(value);
		let lock: FileLock;
		try {
			lock = FileLock.tryAcquire(this.#lockPath(key));
		} catch {
			throw new PersistentAgentError("ownership_unavailable", value, true, "ownership_conflict");
		}
		if (!lock.acquired) {
			lock.release();
			throw new PersistentAgentError("owned_elsewhere", value, true, "ownership_conflict");
		}
		try {
			let previous = 0;
			try {
				previous = ownershipEpoch(
					JSON.parse(await this.#storage.readText(this.#ownershipPath(key))),
					value,
					this.controlHostId,
				).ownerEpoch;
			} catch (error) {
				if (!isEnoent(error))
					throw new PersistentAgentError("ownership_unavailable", value, false, "invalid_fields");
			}
			const ownerEpoch = previous + 1;
			if (!integer(ownerEpoch, 1))
				throw new PersistentAgentError("ownership_unavailable", value, false, "invalid_fields");
			const acquiredAt = this.#now().toISOString();
			const epoch: PersistentAgentOwnershipEpochRecordV1 = {
				schemaVersion: 1,
				agentId: value,
				controlHostId: this.controlHostId,
				ownerEpoch,
				updatedAt: acquiredAt,
			};
			try {
				await this.#storage.writeTextAtomic(this.#ownershipPath(key), jsonLine(epoch), {
					commitGuard: () => lock.acquired && !this.#owners.has(normalized),
				});
				await this.#storage.drain();
			} catch {}
			let reread: PersistentAgentOwnershipEpochRecordV1;
			try {
				reread = ownershipEpoch(
					JSON.parse(await this.#storage.readText(this.#ownershipPath(key))),
					value,
					this.controlHostId,
				);
			} catch {
				throw new PersistentAgentError("ownership_unavailable", value, true, "primary_persistence_indeterminate");
			}
			if (!equal(reread, epoch))
				throw new PersistentAgentError("ownership_unavailable", value, true, "primary_persistence_indeterminate");
			await chmod(this.#ownershipPath(key), FILE_MODE);
			const owner = new FileOwnership(value, this.controlHostId, intent, ownerEpoch, acquiredAt, lock, this);
			this.#owners.set(normalized, owner);
			return owner;
		} catch (error) {
			lock.release();
			throw error;
		}
	}

	isCurrent(owner: FileOwnership): boolean {
		return this.#owners.get(normalizePersistentAgentIdV1(owner.agentId)) === owner;
	}
	close(owner: FileOwnership): void {
		const key = normalizePersistentAgentIdV1(owner.agentId);
		if (this.#owners.get(key) === owner) this.#owners.delete(key);
		owner.lock.release();
	}

	async insert(
		owner: FileOwnership,
		record: PersistentAgentCreatingRecordV1,
	): Promise<PersistentAgentCreatingRecordV1> {
		owner.requireHeld();
		const current = await this.lookup(owner.agentId);
		if (current.kind === "record") owner.observe(current.record.revision);
		else if (current.kind === "missing") owner.observe(null);
		if (current.kind !== "missing")
			throw new PersistentAgentError(
				current.kind === "invalid" ? "invalid_record" : "already_exists",
				owner.agentId,
				false,
				current.kind === "invalid" ? current.reason : "record_revision_conflict",
			);
		const validation = await validatePersistentAgentRecordV1(record, owner.agentId);
		if (!validation.ok || validation.record.phase !== "creating" || record.revision !== 1)
			throw new PersistentAgentError(
				"invalid_record",
				owner.agentId,
				false,
				validation.ok ? "invalid_phase_relationship" : validation.reason,
			);
		if (record.controlHostId !== this.controlHostId)
			throw new PersistentAgentError("wrong_control_host", owner.agentId, false, "wrong_control_host");
		return (await this.#publish(owner, null, validation.record)) as PersistentAgentCreatingRecordV1;
	}

	async replace(
		owner: FileOwnership,
		expectedRevision: number,
		next: PersistentAgentRecordV1,
		commitGuard: PersistentAgentRecordCommitGuardV1,
	): Promise<PersistentAgentRecordV1> {
		if (typeof commitGuard?.isCurrent !== "function") {
			throw new TypeError("Persistent agent record commit guard is required");
		}
		owner.requireHeld();
		const current = await this.lookup(owner.agentId);
		if (current.kind === "missing")
			throw new PersistentAgentError("not_found", owner.agentId, false, "invalid_fields");
		if (current.kind === "invalid")
			throw new PersistentAgentError("invalid_record", owner.agentId, false, current.reason);
		owner.observe(current.record.revision);
		if (current.record.controlHostId !== this.controlHostId)
			throw new PersistentAgentError("wrong_control_host", owner.agentId, false, "wrong_control_host");
		if (current.record.revision !== expectedRevision)
			throw new PersistentAgentError("revision_conflict", owner.agentId, true, "record_revision_conflict");
		const validation = await validatePersistentAgentRecordV1(next, owner.agentId);
		if (!validation.ok) throw new PersistentAgentError("invalid_record", owner.agentId, false, validation.reason);
		try {
			transition(current.record, validation.record);
		} catch (error) {
			throw new PersistentAgentError(
				"invalid_transition",
				owner.agentId,
				false,
				error instanceof InvalidRecord ? error.reason : "invalid_phase_relationship",
			);
		}
		return this.#publish(owner, current.record, validation.record, commitGuard);
	}

	async deleteCreating(owner: FileOwnership, expectedRevision: number): Promise<void> {
		owner.requireHeld();
		const current = await this.lookup(owner.agentId);
		if (current.kind === "missing") return;
		if (current.kind === "invalid")
			throw new PersistentAgentError("invalid_record", owner.agentId, false, current.reason);
		owner.observe(current.record.revision);
		if (current.record.revision !== expectedRevision)
			throw new PersistentAgentError("revision_conflict", owner.agentId, true, "record_revision_conflict");
		if (current.record.phase !== "creating")
			throw new PersistentAgentError("invalid_transition", owner.agentId, false, "invalid_phase_relationship");
		try {
			await this.#storage.unlink(this.#recordPath(persistentAgentStorageKeyV1(owner.agentId)));
			await this.#storage.drain();
		} catch (error) {
			if (!isEnoent(error)) {
				const reread = await this.lookup(owner.agentId);
				if (reread.kind === "missing") return;
				throw new PersistentAgentError(
					"recovery_required",
					owner.agentId,
					true,
					"primary_persistence_indeterminate",
				);
			}
		}
	}

	async #publish(
		owner: FileOwnership,
		current: PersistentAgentRecordV1 | null,
		next: PersistentAgentRecordV1,
		commitGuard?: PersistentAgentRecordCommitGuardV1,
	): Promise<PersistentAgentRecordV1> {
		owner.requireHeld();
		const externalGuardIsCurrent = (): boolean => {
			try {
				return commitGuard?.isCurrent() ?? true;
			} catch {
				return false;
			}
		};
		if (!externalGuardIsCurrent()) {
			throw new PersistentAgentError("revision_conflict", owner.agentId, true, "record_revision_conflict");
		}
		const target = this.#recordPath(persistentAgentStorageKeyV1(owner.agentId));
		let commitGuardRejected = false;
		try {
			await this.#storage.writeTextAtomic(target, jsonLine(next), {
				commitGuard: () => {
					const allowed = owner.canPublish(current?.revision ?? null) && externalGuardIsCurrent();
					if (!allowed) commitGuardRejected = true;
					return allowed;
				},
			});
			await this.#storage.drain();
		} catch {}
		if (commitGuardRejected) {
			throw new PersistentAgentError("revision_conflict", owner.agentId, true, "record_revision_conflict");
		}
		const reread = await this.lookup(owner.agentId);
		if (reread.kind === "record" && equal(reread.record, next)) {
			await chmod(target, FILE_MODE);
			return reread.record;
		}
		if (current !== null && reread.kind === "record" && equal(reread.record, current))
			throw new PersistentAgentError("revision_conflict", owner.agentId, true, "record_revision_conflict");
		throw new PersistentAgentError("recovery_required", owner.agentId, true, "primary_persistence_indeterminate");
	}

	#recordPath(key: string): string {
		return path.join(this.#root, "records", `${key}.json`);
	}
	#lockPath(key: string): string {
		return path.join(this.#root, "locks", `${key}.lock`);
	}
	#ownershipPath(key: string): string {
		return path.join(this.#root, "ownership", `${key}.json`);
	}
}
