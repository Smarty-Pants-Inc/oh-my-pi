import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type {
	ISO8601,
	ManagedWorkspaceRef,
	ManagedWorkspaceSeedLimitsV1,
	ManagedWorkspaceSeedSourceRefV1,
	OperationId,
	Sha256Hex,
	Sha256Ref,
	TerminalReplicaCleanupProofV1,
	WorkspaceCheckpoint,
	WorkspaceDeletionPlanCoreV1,
	WorkspaceDeletionPlanV1,
	WorkspaceId,
} from "../registry/persistent-agent-contracts.js";
import type {
	CanonicalRuntimeValue,
	CanonicalWorkspaceAbortCreateResult,
	CanonicalWorkspaceCommitRequest,
	CanonicalWorkspaceCommitResult,
	CanonicalWorkspaceCreateInspectResult,
	CanonicalWorkspaceCreateRequest,
	CanonicalWorkspaceCreateResult,
	CanonicalWorkspaceDeleteRequest,
	CanonicalWorkspaceDeleteResult,
	CanonicalWorkspaceInspectResult,
	CanonicalWorkspacePurgeRequest,
	CanonicalWorkspacePurgeResult,
	CanonicalWorkspaceSnapshotRequest,
	CanonicalWorkspaceSnapshotResult,
	CanonicalWorkspaceStore,
	ConfidentialTransientTaskCanonicalWorktreePublicationAdoptRequestV1,
	ConfidentialTransientTaskCanonicalWorktreePublicationAdoptResultV1,
	ManagedWorkspaceSeedReader,
	ManagedWorkspaceSeedSourceStore,
	ReplicaCheckpoint,
	RuntimeReplicaRef,
	TransientTaskCanonicalCleanupInspectRequestV1,
	TransientTaskCanonicalCleanupInspectResultV1,
	TransientTaskCanonicalCommitRequestV1,
	TransientTaskCanonicalCommitResultV1,
	TransientTaskCanonicalCreateInspectRequestV1,
	TransientTaskCanonicalCreateInspectResultV1,
	TransientTaskCanonicalCreateRequestV1,
	TransientTaskCanonicalCreateResultV1,
	TransientTaskCanonicalDiscardReceiptV1,
	TransientTaskCanonicalDiscardRequestV1,
	TransientTaskCanonicalDiscardResultV1,
	TransientTaskCanonicalSnapshotRequestV1,
	TransientTaskCanonicalSnapshotResultV1,
	TransientTaskCanonicalWorkspaceStoreV1,
	TransientTaskCanonicalWorktreePublicationEffectV1,
	TransientTaskCanonicalWorktreePublicationInspectRequestV1,
	TransientTaskCanonicalWorktreePublicationInspectResultV1,
	TransientTaskCanonicalWorktreePublicationNotAppliedReceiptV1,
	TransientTaskCanonicalWorktreePublicationResultV1,
	TransientTaskCleanupAuthorityProofV1,
	TransientTaskControllerAuthorityProofV1,
	TransientTaskManagedWorkspaceRefV1,
	TransientTaskPublicationTargetBindingStoreV1,
	TransientTaskPublicationTargetPublicationClaimV1,
	TransientTaskWorktreePublicationReceiptV1,
	TransientTaskWorktreePublicationTargetHandleV1,
	WorkspaceControllerLeaseProof,
	WorkspaceDeletionAuthorityProof,
	WorkspaceImage,
	WorkspaceSnapshot,
	WorkspaceSnapshotFile,
	WorkspaceTombstone,
} from "./workspace-runtime-contracts.js";
import { canonicalRuntimeSha256, decodeWorkspaceRetentionPolicyV1 } from "./workspace-runtime-contracts.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO8601_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 5;

export type ManagedWorkspaceRefValidationCodeV1 =
	| "invalid_shape"
	| "unsupported_mode"
	| "unsupported_format"
	| "workspace_mismatch"
	| "checkpoint_invalid"
	| "retention_invalid";

export class ManagedWorkspaceRefValidationErrorV1 extends Error {
	constructor(readonly code: ManagedWorkspaceRefValidationCodeV1) {
		super(code);
		this.name = "ManagedWorkspaceRefValidationErrorV1";
	}
}

function isStrictRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const ownKeys = Reflect.ownKeys(value);
		if (ownKeys.length !== keys.length) return false;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		return ownKeys.every(key => {
			if (typeof key !== "string" || !keys.includes(key)) return false;
			const descriptor = descriptors[key];
			return descriptor?.enumerable === true && "value" in descriptor;
		});
	} catch {
		return false;
	}
}

function isWellFormedString(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0xd800 || code > 0xdfff) continue;
		if (code >= 0xdc00 || index + 1 >= value.length) return false;
		const next = value.charCodeAt(++index);
		if (next < 0xdc00 || next > 0xdfff) return false;
	}
	return true;
}

function isSafeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0;
}

function isIso8601(value: unknown): value is ISO8601 {
	if (typeof value !== "string" || !ISO8601_MILLISECONDS.test(value)) return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function decodeCheckpoint(input: unknown): WorkspaceCheckpoint {
	const keys = ["workspaceId", "generation", "rootSha256", "fileCount", "byteCount", "committedAt"] as const;
	if (
		!isStrictRecord(input, keys) ||
		!isWellFormedString(input.workspaceId) ||
		!isSafeCount(input.generation) ||
		typeof input.rootSha256 !== "string" ||
		!SHA256_HEX.test(input.rootSha256) ||
		!isSafeCount(input.fileCount) ||
		!isSafeCount(input.byteCount) ||
		!isIso8601(input.committedAt)
	) {
		throw new ManagedWorkspaceRefValidationErrorV1("checkpoint_invalid");
	}
	return Object.freeze({
		workspaceId: input.workspaceId,
		generation: input.generation,
		rootSha256: input.rootSha256,
		fileCount: input.fileCount,
		byteCount: input.byteCount,
		committedAt: input.committedAt,
	});
}

export function decodeManagedWorkspaceRefV1(input: unknown): ManagedWorkspaceRef {
	if (
		!isStrictRecord(input, ["workspaceId", "mode", "format", "retention", "checkpoint"]) ||
		!isWellFormedString(input.workspaceId)
	)
		throw new ManagedWorkspaceRefValidationErrorV1("invalid_shape");
	if (input.mode !== "managed") throw new ManagedWorkspaceRefValidationErrorV1("unsupported_mode");
	if (input.format !== "omp-text-v1") throw new ManagedWorkspaceRefValidationErrorV1("unsupported_format");
	let retention: ReturnType<typeof decodeWorkspaceRetentionPolicyV1>;
	try {
		retention = decodeWorkspaceRetentionPolicyV1(input.retention);
	} catch {
		throw new ManagedWorkspaceRefValidationErrorV1("retention_invalid");
	}
	const checkpoint = decodeCheckpoint(input.checkpoint);
	if (checkpoint.workspaceId !== input.workspaceId)
		throw new ManagedWorkspaceRefValidationErrorV1("workspace_mismatch");
	return Object.freeze({
		workspaceId: input.workspaceId,
		mode: "managed",
		format: "omp-text-v1",
		retention,
		checkpoint,
	});
}

export function decodeTransientTaskManagedWorkspaceRefV1(input: unknown): TransientTaskManagedWorkspaceRefV1 {
	const keys = [
		"schemaVersion",
		"taskId",
		"runId",
		"workspaceId",
		"createId",
		"mode",
		"format",
		"checkpoint",
	] as const;
	if (
		!isStrictRecord(input, keys) ||
		input.schemaVersion !== 1 ||
		!isWellFormedString(input.taskId) ||
		!isWellFormedString(input.runId) ||
		!isWellFormedString(input.workspaceId) ||
		!isWellFormedString(input.createId)
	) {
		throw new ManagedWorkspaceRefValidationErrorV1("invalid_shape");
	}
	if (input.mode !== "managed") throw new ManagedWorkspaceRefValidationErrorV1("unsupported_mode");
	if (input.format !== "omp-text-v1") throw new ManagedWorkspaceRefValidationErrorV1("unsupported_format");
	const checkpoint = decodeCheckpoint(input.checkpoint);
	if (checkpoint.workspaceId !== input.workspaceId)
		throw new ManagedWorkspaceRefValidationErrorV1("workspace_mismatch");
	return Object.freeze({
		schemaVersion: 1,
		taskId: input.taskId,
		runId: input.runId,
		workspaceId: input.workspaceId,
		createId: input.createId,
		mode: "managed",
		format: "omp-text-v1",
		checkpoint,
	});
}

function canonicalPath(path: string): boolean {
	if (path.length === 0 || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("\0"))
		return false;
	return path.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function imageMatches(left: WorkspaceImage, right: WorkspaceImage): boolean {
	return (
		left.rootSha256 === right.rootSha256 && left.fileCount === right.fileCount && left.byteCount === right.byteCount
	);
}

function checkpointMatches(left: WorkspaceCheckpoint, right: WorkspaceCheckpoint): boolean {
	return (
		left.workspaceId === right.workspaceId &&
		left.generation === right.generation &&
		imageMatches(left, right) &&
		left.committedAt === right.committedAt
	);
}

const SHA256_REF = /^sha256:[0-9a-f]{64}$/;
const MAX_DELETION_ID_BYTES = 512;

export interface MaterializedWorkspaceDeletionPlanV1 {
	readonly deletionPlanCoreSha256: Sha256Ref;
	readonly tombstone: WorkspaceTombstone;
	readonly deletion: WorkspaceDeletionPlanV1;
	readonly deletionPlanSha256: Sha256Ref;
}

function invalidDeletionPlan(): never {
	throw new TypeError("Invalid persistent workspace deletion plan");
}

function isOpaqueDeletionId(value: unknown): value is string {
	return (
		isWellFormedString(value) &&
		value.trim() === value &&
		!value.includes("\0") &&
		Buffer.byteLength(value, "utf8") <= MAX_DELETION_ID_BYTES
	);
}

function isCanonicalDeletionTimestamp(value: unknown): value is ISO8601 {
	if (!isWellFormedString(value)) return false;
	const epoch = Date.parse(value);
	return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function isSha256Ref(value: unknown): value is Sha256Ref {
	return typeof value === "string" && SHA256_REF.test(value);
}

function freezeDeletionPlan<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const member of Object.values(value as Record<string, unknown>)) freezeDeletionPlan(member);
	Object.freeze(value);
	return value;
}

function checkpointTuple(checkpoint: WorkspaceCheckpoint): readonly CanonicalRuntimeValue[] {
	return [
		checkpoint.workspaceId,
		checkpoint.generation,
		checkpoint.rootSha256,
		checkpoint.fileCount,
		checkpoint.byteCount,
		checkpoint.committedAt,
	];
}

function replicaTuple(replica: RuntimeReplicaRef): readonly CanonicalRuntimeValue[] {
	return [replica.providerId, replica.profileId, replica.replicaId, replica.workspaceId];
}

function compareDeletionReplica(left: RuntimeReplicaRef, right: RuntimeReplicaRef): number {
	return (
		compareUtf8(left.providerId, right.providerId) ||
		compareUtf8(left.profileId, right.profileId) ||
		compareUtf8(left.replicaId, right.replicaId)
	);
}

function deletionReplicaKey(replica: RuntimeReplicaRef): string {
	return `${replica.providerId}\0${replica.profileId}\0${replica.replicaId}`;
}

function sameDeletionReplica(left: RuntimeReplicaRef, right: RuntimeReplicaRef): boolean {
	return (
		left.providerId === right.providerId &&
		left.profileId === right.profileId &&
		left.replicaId === right.replicaId &&
		left.workspaceId === right.workspaceId
	);
}

function decodeDeletionCheckpoint(input: unknown, workspaceId: WorkspaceId): WorkspaceCheckpoint {
	const keys = ["workspaceId", "generation", "rootSha256", "fileCount", "byteCount", "committedAt"] as const;
	if (
		!isStrictRecord(input, keys) ||
		!isOpaqueDeletionId(input.workspaceId) ||
		input.workspaceId !== workspaceId ||
		!isSafeCount(input.generation) ||
		typeof input.rootSha256 !== "string" ||
		!SHA256_HEX.test(input.rootSha256) ||
		!isSafeCount(input.fileCount) ||
		!isSafeCount(input.byteCount) ||
		!isCanonicalDeletionTimestamp(input.committedAt)
	) {
		return invalidDeletionPlan();
	}
	return freezeDeletionPlan({
		workspaceId: input.workspaceId as WorkspaceId,
		generation: input.generation,
		rootSha256: input.rootSha256 as Sha256Hex,
		fileCount: input.fileCount,
		byteCount: input.byteCount,
		committedAt: input.committedAt,
	});
}

function decodeDeletionReplica(input: unknown, workspaceId: WorkspaceId): RuntimeReplicaRef {
	const keys = ["providerId", "profileId", "replicaId", "workspaceId"] as const;
	if (
		!isStrictRecord(input, keys) ||
		!isOpaqueDeletionId(input.providerId) ||
		!isOpaqueDeletionId(input.profileId) ||
		!isOpaqueDeletionId(input.replicaId) ||
		!isOpaqueDeletionId(input.workspaceId) ||
		input.workspaceId !== workspaceId
	) {
		return invalidDeletionPlan();
	}
	return freezeDeletionPlan({
		providerId: input.providerId as RuntimeReplicaRef["providerId"],
		profileId: input.profileId as RuntimeReplicaRef["profileId"],
		replicaId: input.replicaId as RuntimeReplicaRef["replicaId"],
		workspaceId: input.workspaceId as WorkspaceId,
	});
}

function decodeWorkspaceDeletionPlanCore(input: unknown): WorkspaceDeletionPlanCoreV1 {
	const keys = [
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
	] as const;
	if (
		!isStrictRecord(input, keys) ||
		!isOpaqueDeletionId(input.deleteId) ||
		!isOpaqueDeletionId(input.deletionAuthorityId) ||
		!isOpaqueDeletionId(input.quarantineId) ||
		new Set([input.deleteId, input.deletionAuthorityId, input.quarantineId]).size !== 3 ||
		!isOpaqueDeletionId(input.workspaceId) ||
		!isOpaqueDeletionId(input.expectedRuntimeAttachmentCreateId) ||
		!isSafeCount(input.expectedRuntimeAttachmentRevision) ||
		input.expectedRuntimeAttachmentRevision < 1 ||
		!isSafeCount(input.expectedKnownReplicaCatalogRevision) ||
		!isCanonicalDeletionTimestamp(input.plannedDeletionAt) ||
		!isSafeCount(input.deletedBytesGraceMs) ||
		input.deletedBytesGraceMs > 2_147_483_647 ||
		!isCanonicalDeletionTimestamp(input.purgeAfter) ||
		!Array.isArray(input.replicaRequests)
	) {
		return invalidDeletionPlan();
	}
	const workspaceId = input.workspaceId as WorkspaceId;
	const expectedCheckpoint = decodeDeletionCheckpoint(input.expectedCheckpoint, workspaceId);
	const purgeAfter = Date.parse(input.plannedDeletionAt) + input.deletedBytesGraceMs;
	if (!Number.isSafeInteger(purgeAfter) || new Date(purgeAfter).toISOString() !== input.purgeAfter)
		return invalidDeletionPlan();
	const replicaRequests = input.replicaRequests.map(entry => {
		if (!isStrictRecord(entry, ["replica", "deletionAuthorityDomain", "requestId"])) return invalidDeletionPlan();
		if (entry.deletionAuthorityDomain !== "persistent" || !isOpaqueDeletionId(entry.requestId))
			return invalidDeletionPlan();
		return freezeDeletionPlan({
			replica: decodeDeletionReplica(entry.replica, workspaceId),
			deletionAuthorityDomain: "persistent" as const,
			requestId: entry.requestId as WorkspaceDeletionPlanCoreV1["replicaRequests"][number]["requestId"],
		});
	});
	const replicaKeys = new Set<string>();
	const requestIds = new Set<string>();
	for (let index = 0; index < replicaRequests.length; index++) {
		const entry = replicaRequests[index]!;
		if (
			replicaKeys.has(deletionReplicaKey(entry.replica)) ||
			requestIds.has(entry.requestId) ||
			(index > 0 && compareDeletionReplica(replicaRequests[index - 1]!.replica, entry.replica) >= 0)
		)
			return invalidDeletionPlan();
		replicaKeys.add(deletionReplicaKey(entry.replica));
		requestIds.add(entry.requestId);
	}
	return freezeDeletionPlan({
		deleteId: input.deleteId as OperationId,
		deletionAuthorityId: input.deletionAuthorityId as OperationId,
		quarantineId: input.quarantineId as OperationId,
		workspaceId,
		expectedCheckpoint,
		expectedRuntimeAttachmentCreateId: input.expectedRuntimeAttachmentCreateId as OperationId,
		expectedRuntimeAttachmentRevision: input.expectedRuntimeAttachmentRevision,
		expectedKnownReplicaCatalogRevision: input.expectedKnownReplicaCatalogRevision,
		plannedDeletionAt: input.plannedDeletionAt,
		deletedBytesGraceMs: input.deletedBytesGraceMs,
		purgeAfter: input.purgeAfter,
		replicaRequests,
	});
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

function tombstoneFor(core: WorkspaceDeletionPlanCoreV1): WorkspaceTombstone {
	return freezeDeletionPlan({
		workspaceId: core.workspaceId,
		deleteId: core.deleteId,
		deletionAuthorityId: core.deletionAuthorityId,
		quarantineId: core.quarantineId,
		deletedAt: core.plannedDeletionAt,
		lastCheckpoint: core.expectedCheckpoint,
		purgeAfter: core.purgeAfter,
	});
}

function sameTombstone(left: WorkspaceTombstone, right: WorkspaceTombstone): boolean {
	return (
		left.workspaceId === right.workspaceId &&
		left.deleteId === right.deleteId &&
		left.deletionAuthorityId === right.deletionAuthorityId &&
		left.quarantineId === right.quarantineId &&
		left.deletedAt === right.deletedAt &&
		checkpointMatches(left.lastCheckpoint, right.lastCheckpoint) &&
		left.purgeAfter === right.purgeAfter
	);
}

export async function workspaceDeletionPlanCoreSha256V1(core: WorkspaceDeletionPlanCoreV1): Promise<Sha256Ref> {
	return `sha256:${await canonicalRuntimeSha256(deletionCoreTuple(decodeWorkspaceDeletionPlanCore(core)))}` as Sha256Ref;
}

export function deriveWorkspaceTombstoneV1(core: WorkspaceDeletionPlanCoreV1): WorkspaceTombstone {
	return tombstoneFor(decodeWorkspaceDeletionPlanCore(core));
}

export async function materializeWorkspaceDeletionPlanV1(
	core: WorkspaceDeletionPlanCoreV1,
): Promise<MaterializedWorkspaceDeletionPlanV1> {
	const validatedCore = decodeWorkspaceDeletionPlanCore(core);
	const deletionPlanCoreSha256 =
		`sha256:${await canonicalRuntimeSha256(deletionCoreTuple(validatedCore))}` as Sha256Ref;
	const tombstone = tombstoneFor(validatedCore);
	const deletion = freezeDeletionPlan({
		core: validatedCore,
		replicaRequests: await Promise.all(
			validatedCore.replicaRequests.map(async entry =>
				freezeDeletionPlan({
					replica: entry.replica,
					deletionAuthorityDomain: "persistent" as const,
					request: freezeDeletionPlan({
						requestId: entry.requestId,
						requestSha256: await canonicalRuntimeSha256(
							persistentDeleteTuple({
								requestId: entry.requestId,
								replica: entry.replica,
								deletionPlanCoreSha256,
								tombstone,
							}),
						),
					}),
				}),
			),
		),
	});
	return freezeDeletionPlan({
		deletionPlanCoreSha256,
		tombstone,
		deletion,
		deletionPlanSha256: `sha256:${await canonicalRuntimeSha256(deletionPlanTuple(deletion))}` as Sha256Ref,
	});
}

export async function validateWorkspaceDeletionPlanV1(input: unknown): Promise<MaterializedWorkspaceDeletionPlanV1> {
	if (!isStrictRecord(input, ["core", "replicaRequests"]) || !Array.isArray(input.replicaRequests))
		return invalidDeletionPlan();
	const expected = await materializeWorkspaceDeletionPlanV1(decodeWorkspaceDeletionPlanCore(input.core));
	if (input.replicaRequests.length !== expected.deletion.replicaRequests.length) return invalidDeletionPlan();
	for (let index = 0; index < input.replicaRequests.length; index++) {
		const actual = input.replicaRequests[index];
		const expectedEntry = expected.deletion.replicaRequests[index]!;
		if (!isStrictRecord(actual, ["replica", "deletionAuthorityDomain", "request"])) return invalidDeletionPlan();
		const replica = decodeDeletionReplica(actual.replica, expected.deletion.core.workspaceId);
		if (
			actual.deletionAuthorityDomain !== "persistent" ||
			!isStrictRecord(actual.request, ["requestId", "requestSha256"]) ||
			!isOpaqueDeletionId(actual.request.requestId) ||
			typeof actual.request.requestSha256 !== "string" ||
			!SHA256_HEX.test(actual.request.requestSha256) ||
			!sameDeletionReplica(replica, expectedEntry.replica) ||
			actual.request.requestId !== expectedEntry.request.requestId ||
			actual.request.requestSha256 !== expectedEntry.request.requestSha256
		)
			return invalidDeletionPlan();
	}
	return expected;
}

export async function validatePersistentReplicaDeletionAuthorizationV1(
	input: unknown,
): Promise<MaterializedWorkspaceDeletionPlanV1> {
	if (
		!isStrictRecord(input, ["domain", "deletion", "deletionPlanCoreSha256", "deletionPlanSha256", "tombstone"]) ||
		input.domain !== "persistent" ||
		!isSha256Ref(input.deletionPlanCoreSha256) ||
		!isSha256Ref(input.deletionPlanSha256)
	) {
		return invalidDeletionPlan();
	}
	const expected = await validateWorkspaceDeletionPlanV1(input.deletion);
	const tombstone = decodeDeletionTombstone(input.tombstone, expected.deletion.core.workspaceId);
	if (
		input.deletionPlanCoreSha256 !== expected.deletionPlanCoreSha256 ||
		input.deletionPlanSha256 !== expected.deletionPlanSha256 ||
		!sameTombstone(tombstone, expected.tombstone)
	)
		return invalidDeletionPlan();
	return expected;
}

function decodeDeletionTombstone(input: unknown, workspaceId: WorkspaceId): WorkspaceTombstone {
	const keys = [
		"workspaceId",
		"deleteId",
		"deletionAuthorityId",
		"quarantineId",
		"deletedAt",
		"lastCheckpoint",
		"purgeAfter",
	] as const;
	if (
		!isStrictRecord(input, keys) ||
		!isOpaqueDeletionId(input.workspaceId) ||
		input.workspaceId !== workspaceId ||
		!isOpaqueDeletionId(input.deleteId) ||
		!isOpaqueDeletionId(input.deletionAuthorityId) ||
		!isOpaqueDeletionId(input.quarantineId) ||
		new Set([input.deleteId, input.deletionAuthorityId, input.quarantineId]).size !== 3 ||
		!isCanonicalDeletionTimestamp(input.deletedAt) ||
		!isCanonicalDeletionTimestamp(input.purgeAfter)
	) {
		return invalidDeletionPlan();
	}
	return freezeDeletionPlan({
		workspaceId,
		deleteId: input.deleteId as OperationId,
		deletionAuthorityId: input.deletionAuthorityId as OperationId,
		quarantineId: input.quarantineId as OperationId,
		deletedAt: input.deletedAt,
		lastCheckpoint: decodeDeletionCheckpoint(input.lastCheckpoint, workspaceId),
		purgeAfter: input.purgeAfter,
	});
}

export function materializeWorkspaceSnapshotV1(request: {
	readonly workspaceId: WorkspaceId;
	readonly generation: number;
	readonly committedAt: ISO8601;
	readonly files: readonly { readonly path: string; readonly contentUtf8: string }[];
}): WorkspaceSnapshot {
	if (
		!isWellFormedString(request.workspaceId) ||
		!isSafeCount(request.generation) ||
		!isIso8601(request.committedAt)
	) {
		throw new TypeError("Invalid workspace snapshot identity");
	}
	const files = request.files
		.map(file => {
			if (!canonicalPath(file.path) || typeof file.contentUtf8 !== "string")
				throw new TypeError("Invalid workspace file");
			const bytes = utf8Encoder.encode(file.contentUtf8);
			return Object.freeze({
				path: file.path as WorkspaceSnapshotFile["path"],
				contentUtf8: file.contentUtf8,
				sha256: createHash("sha256").update(bytes).digest("hex") as Sha256Hex,
				byteLength: bytes.byteLength,
			});
		})
		.sort((left, right) => compareUtf8(left.path, right.path));
	for (let index = 1; index < files.length; index++) {
		if (files[index - 1]?.path === files[index]?.path) throw new TypeError("Duplicate workspace path");
	}
	const root = createHash("sha256");
	let byteCount = 0;
	for (const file of files) {
		root
			.update(file.path, "utf8")
			.update("\0", "utf8")
			.update(file.sha256, "utf8")
			.update("\0", "utf8")
			.update(String(file.byteLength), "utf8")
			.update("\n", "utf8");
		byteCount += file.byteLength;
	}
	return Object.freeze({
		checkpoint: Object.freeze({
			workspaceId: request.workspaceId,
			generation: request.generation,
			rootSha256: root.digest("hex") as Sha256Hex,
			fileCount: files.length,
			byteCount,
			committedAt: request.committedAt,
		}),
		files: Object.freeze(files),
	});
}

export function validateWorkspaceSnapshotV1(snapshot: WorkspaceSnapshot): boolean {
	try {
		const rebuilt = materializeWorkspaceSnapshotV1({
			workspaceId: snapshot.checkpoint.workspaceId,
			generation: snapshot.checkpoint.generation,
			committedAt: snapshot.checkpoint.committedAt,
			files: snapshot.files,
		});
		if (!checkpointMatches(snapshot.checkpoint, rebuilt.checkpoint)) return false;
		return snapshot.files.every((file, index) => {
			const expected = rebuilt.files[index];
			return (
				expected !== undefined &&
				file.path === expected.path &&
				file.contentUtf8 === expected.contentUtf8 &&
				file.sha256 === expected.sha256 &&
				file.byteLength === expected.byteLength
			);
		});
	} catch {
		return false;
	}
}

function validateReplicaCheckpoint(
	checkpoint: ReplicaCheckpoint,
	workspaceId: WorkspaceId,
	expectedGeneration: number,
): WorkspaceSnapshot | null {
	if (
		checkpoint.reference.workspaceId !== workspaceId ||
		checkpoint.reference.baseGeneration !== expectedGeneration ||
		checkpoint.reference.format !== "omp-text-v1" ||
		checkpoint.reference.rootSha256 !== checkpoint.rootSha256 ||
		checkpoint.reference.fileCount !== checkpoint.fileCount ||
		checkpoint.reference.byteCount !== checkpoint.byteCount
	)
		return null;
	const snapshot = materializeWorkspaceSnapshotV1({
		workspaceId,
		generation: expectedGeneration + 1,
		committedAt: checkpoint.reference.frozenAt,
		files: checkpoint.files,
	});
	return imageMatches(snapshot.checkpoint, checkpoint) ? snapshot : null;
}

export interface RuntimeDurableStateTransactionResultV1<Result> {
	readonly state: unknown;
	readonly result: Result;
}

export interface RuntimeDurableStateStoreV1 {
	transact<Transaction extends RuntimeDurableStateTransactionResultV1<unknown>>(
		namespace: string,
		key: string,
		operation: (current: unknown | null) => Promise<Transaction> | Transaction,
	): Promise<Transaction["result"]>;
	inspect(namespace: string, key: string): Promise<unknown | null>;
}

interface RuntimeDurableEnvelopeV1 {
	readonly schemaVersion: 1;
	readonly namespace: string;
	readonly key: string;
	readonly state: unknown;
}

function errnoCode(error: unknown): string | null {
	return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: null;
}

export class FileRuntimeDurableStateStoreV1 implements RuntimeDurableStateStoreV1 {
	readonly #root: string;

	constructor(root: string) {
		if (root.length === 0) throw new TypeError("Runtime state root must be non-empty");
		this.#root = root;
	}

	#paths(namespace: string, key: string): { readonly file: string; readonly lock: string } {
		const digest = createHash("sha256")
			.update(namespace, "utf8")
			.update("\0", "utf8")
			.update(key, "utf8")
			.digest("hex");
		const directory = join(this.#root, "adaptive-runtime", namespace);
		return { file: join(directory, `${digest}.json`), lock: join(directory, `${digest}.lock`) };
	}

	async #read(namespace: string, key: string, file: string): Promise<unknown | null> {
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch (error) {
			if (errnoCode(error) === "ENOENT") return null;
			throw error;
		}
		const decoded: unknown = JSON.parse(text);
		if (
			!isStrictRecord(decoded, ["schemaVersion", "namespace", "key", "state"]) ||
			decoded.schemaVersion !== 1 ||
			decoded.namespace !== namespace ||
			decoded.key !== key
		)
			throw new Error("Runtime durable state envelope is invalid");
		return decoded.state;
	}

	async #lock(lockPath: string): Promise<FileHandle> {
		await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
		for (;;) {
			try {
				const handle = await open(lockPath, "wx", 0o600);
				await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
				return handle;
			} catch (error) {
				if (errnoCode(error) !== "EEXIST") throw error;
				try {
					const metadata = await stat(lockPath);
					if (Date.now() - metadata.mtimeMs > LOCK_STALE_MS) {
						await unlink(lockPath);
						continue;
					}
				} catch (inspectionError) {
					if (errnoCode(inspectionError) === "ENOENT") continue;
					throw inspectionError;
				}
				await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
			}
		}
	}

	async inspect(namespace: string, key: string): Promise<unknown | null> {
		const { file } = this.#paths(namespace, key);
		return this.#read(namespace, key, file);
	}

	async transact<Transaction extends RuntimeDurableStateTransactionResultV1<unknown>>(
		namespace: string,
		key: string,
		operation: (current: unknown | null) => Promise<Transaction> | Transaction,
	): Promise<Transaction["result"]> {
		const { file, lock } = this.#paths(namespace, key);
		const handle = await this.#lock(lock);
		let outcome:
			| { readonly status: "succeeded"; readonly value: Transaction["result"] }
			| { readonly status: "failed"; readonly error: unknown };
		try {
			const current = await this.#read(namespace, key, file);
			const next = await operation(current);
			const envelope: RuntimeDurableEnvelopeV1 = { schemaVersion: 1, namespace, key, state: next.state };
			const temporary = `${file}.${randomUUID()}.tmp`;
			await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await rename(temporary, file);
			outcome = { status: "succeeded", value: next.result };
		} catch (error) {
			outcome = { status: "failed", error };
		}

		let cleanupFailure: { readonly error: unknown } | undefined;
		try {
			await handle.close();
		} catch (error) {
			cleanupFailure = { error };
		}
		try {
			await unlink(lock);
		} catch (error) {
			if (errnoCode(error) !== "ENOENT" && cleanupFailure === undefined) cleanupFailure = { error };
		}

		if (outcome.status === "failed") throw outcome.error;
		if (cleanupFailure) throw cleanupFailure.error;
		return outcome.value;
	}
}

const MANAGED_WORKSPACE_SEED_SOURCE_NAMESPACE_V1 = "managed-workspace-seed-source-v1";
const MAX_MANAGED_WORKSPACE_SEED_SOURCE_ID_BYTES_V1 = 512;
const MANAGED_WORKSPACE_SEED_READ_CHUNK_BYTES_V1 = 64 * 1024;

class ManagedWorkspaceSeedSourceFailureV1 extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManagedWorkspaceSeedSourceFailureV1";
	}
}

function failManagedWorkspaceSeedSourceV1(message: string): never {
	throw new ManagedWorkspaceSeedSourceFailureV1(message);
}

function throwIfManagedWorkspaceSeedReadAbortedV1(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error("Managed workspace seed source read aborted");
	error.name = "AbortError";
	throw error;
}

function isOpaqueManagedWorkspaceSeedIdV1(value: unknown): value is string {
	return (
		isWellFormedString(value) &&
		value.trim() === value &&
		!value.includes("\0") &&
		Buffer.byteLength(value, "utf8") <= MAX_MANAGED_WORKSPACE_SEED_SOURCE_ID_BYTES_V1
	);
}

function decodeManagedWorkspaceSeedLimitsV1(input: unknown): ManagedWorkspaceSeedLimitsV1 {
	if (
		!isStrictRecord(input, ["maxFiles", "maxFileBytes", "maxTotalBytes", "deniedPatterns"]) ||
		!isSafeCount(input.maxFiles) ||
		input.maxFiles === 0 ||
		!isSafeCount(input.maxFileBytes) ||
		input.maxFileBytes === 0 ||
		!isSafeCount(input.maxTotalBytes) ||
		input.maxTotalBytes === 0 ||
		!Array.isArray(input.deniedPatterns)
	) {
		failManagedWorkspaceSeedSourceV1("Managed workspace seed source limits are invalid");
	}
	const deniedPatterns = input.deniedPatterns.map(pattern => {
		if (typeof pattern !== "string" || (pattern.length > 0 && !isWellFormedString(pattern)))
			failManagedWorkspaceSeedSourceV1("Managed workspace seed source limits are invalid");
		return pattern;
	});
	if (new Set(deniedPatterns).size !== deniedPatterns.length)
		failManagedWorkspaceSeedSourceV1("Managed workspace seed source limits are invalid");
	return Object.freeze({
		maxFiles: input.maxFiles,
		maxFileBytes: input.maxFileBytes,
		maxTotalBytes: input.maxTotalBytes,
		deniedPatterns: Object.freeze(deniedPatterns),
	});
}

function decodeManagedWorkspaceSeedSourceRefV1(input: unknown): ManagedWorkspaceSeedSourceRefV1 {
	if (
		!isStrictRecord(input, ["sourceId", "bindId", "expectedImage", "limits"]) ||
		!isOpaqueManagedWorkspaceSeedIdV1(input.sourceId) ||
		!isOpaqueManagedWorkspaceSeedIdV1(input.bindId) ||
		!isStrictRecord(input.expectedImage, ["rootSha256", "fileCount", "byteCount"]) ||
		typeof input.expectedImage.rootSha256 !== "string" ||
		!SHA256_HEX.test(input.expectedImage.rootSha256) ||
		!isSafeCount(input.expectedImage.fileCount) ||
		!isSafeCount(input.expectedImage.byteCount)
	) {
		failManagedWorkspaceSeedSourceV1("Managed workspace seed source reference is invalid");
	}
	return Object.freeze({
		sourceId: input.sourceId,
		bindId: input.bindId,
		expectedImage: Object.freeze({
			rootSha256: input.expectedImage.rootSha256 as Sha256Hex,
			fileCount: input.expectedImage.fileCount,
			byteCount: input.expectedImage.byteCount,
		}),
		limits: decodeManagedWorkspaceSeedLimitsV1(input.limits),
	});
}

function managedWorkspaceSeedLimitsMatchV1(
	left: ManagedWorkspaceSeedLimitsV1,
	right: ManagedWorkspaceSeedLimitsV1,
): boolean {
	return (
		left.maxFiles === right.maxFiles &&
		left.maxFileBytes === right.maxFileBytes &&
		left.maxTotalBytes === right.maxTotalBytes &&
		left.deniedPatterns.length === right.deniedPatterns.length &&
		left.deniedPatterns.every((pattern, index) => pattern === right.deniedPatterns[index])
	);
}

function managedWorkspaceSeedSourceMatchesV1(
	left: ManagedWorkspaceSeedSourceRefV1,
	right: ManagedWorkspaceSeedSourceRefV1,
): boolean {
	return (
		left.sourceId === right.sourceId &&
		left.bindId === right.bindId &&
		imageMatches(left.expectedImage, right.expectedImage) &&
		managedWorkspaceSeedLimitsMatchV1(left.limits, right.limits)
	);
}

function canonicalManagedWorkspaceSeedSourcePathV1(sourcePath: string): boolean {
	return (
		sourcePath.length > 0 &&
		!sourcePath.includes("\0") &&
		isAbsolute(sourcePath) &&
		normalize(sourcePath) === sourcePath
	);
}

interface ManagedWorkspaceSeedFileCandidateV1 {
	readonly sourcePath: string;
	readonly path: string;
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
}

function sameManagedWorkspaceSeedFileStatV1(left: ManagedWorkspaceSeedFileCandidateV1, right: Stats): boolean {
	return (
		right.isFile() &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function managedWorkspaceSeedImageV1(files: readonly WorkspaceSnapshotFile[]): WorkspaceImage {
	const root = createHash("sha256");
	let byteCount = 0;
	for (const file of files) {
		root
			.update(file.path, "utf8")
			.update("\0", "utf8")
			.update(file.sha256, "utf8")
			.update("\0", "utf8")
			.update(String(file.byteLength), "utf8")
			.update("\n", "utf8");
		byteCount += file.byteLength;
	}
	return Object.freeze({
		rootSha256: root.digest("hex") as Sha256Hex,
		fileCount: files.length,
		byteCount,
	});
}

export interface ManagedWorkspaceSeedSourceReadV1 {
	readonly image: WorkspaceImage;
	readonly files: readonly WorkspaceSnapshotFile[];
}

/** Read-only bounded enumeration of one explicitly authorized physical directory. */
export async function readManagedWorkspaceSeedSourceV1(request: {
	readonly sourcePath: string;
	readonly limits: ManagedWorkspaceSeedLimitsV1;
	readonly signal?: AbortSignal;
}): Promise<ManagedWorkspaceSeedSourceReadV1> {
	try {
		throwIfManagedWorkspaceSeedReadAbortedV1(request.signal);
		if (!canonicalManagedWorkspaceSeedSourcePathV1(request.sourcePath))
			failManagedWorkspaceSeedSourceV1("Managed workspace seed source path is invalid");
		const limits = decodeManagedWorkspaceSeedLimitsV1(request.limits);
		let denied: readonly Bun.Glob[];
		try {
			denied = limits.deniedPatterns.filter(pattern => pattern.length > 0).map(pattern => new Bun.Glob(pattern));
		} catch {
			failManagedWorkspaceSeedSourceV1("Managed workspace seed source limits are invalid");
		}
		const rootStat = await lstat(request.sourcePath);
		throwIfManagedWorkspaceSeedReadAbortedV1(request.signal);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
			failManagedWorkspaceSeedSourceV1("Managed workspace seed source tree is unsafe");

		const candidates: ManagedWorkspaceSeedFileCandidateV1[] = [];
		let totalBytes = 0;
		const scan = async (directory: string, prefix: string): Promise<void> => {
			throwIfManagedWorkspaceSeedReadAbortedV1(request.signal);
			const before = await lstat(directory);
			if (!before.isDirectory() || before.isSymbolicLink())
				failManagedWorkspaceSeedSourceV1("Managed workspace seed source tree is unsafe");
			const names = (await readdir(directory)).sort(compareUtf8);
			for (const name of names) {
				throwIfManagedWorkspaceSeedReadAbortedV1(request.signal);
				const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
				if (!isWellFormedString(relativePath) || !canonicalPath(relativePath))
					failManagedWorkspaceSeedSourceV1("Managed workspace seed source path is noncanonical");
				if (denied.some(pattern => pattern.match(relativePath)))
					failManagedWorkspaceSeedSourceV1("Managed workspace seed source contains a denied path");
				const sourcePath = join(directory, name);
				const metadata = await lstat(sourcePath);
				if (metadata.isSymbolicLink())
					failManagedWorkspaceSeedSourceV1("Managed workspace seed source tree is unsafe");
				if (metadata.isDirectory()) {
					await scan(sourcePath, relativePath);
					continue;
				}
				if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size < 0)
					failManagedWorkspaceSeedSourceV1("Managed workspace seed source contains a non-regular file");
				if (metadata.size > limits.maxFileBytes)
					failManagedWorkspaceSeedSourceV1("Managed workspace seed source file limit exceeded");
				if (candidates.length >= limits.maxFiles)
					failManagedWorkspaceSeedSourceV1("Managed workspace seed source file-count limit exceeded");
				totalBytes += metadata.size;
				if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes)
					failManagedWorkspaceSeedSourceV1("Managed workspace seed source total-byte limit exceeded");
				candidates.push({
					sourcePath,
					path: relativePath,
					dev: metadata.dev,
					ino: metadata.ino,
					size: metadata.size,
					mtimeMs: metadata.mtimeMs,
					ctimeMs: metadata.ctimeMs,
				});
			}
			const after = await lstat(directory);
			if (
				!after.isDirectory() ||
				after.isSymbolicLink() ||
				before.dev !== after.dev ||
				before.ino !== after.ino ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs
			) {
				failManagedWorkspaceSeedSourceV1("Managed workspace seed source changed during enumeration");
			}
		};
		await scan(request.sourcePath, "");
		const afterRootStat = await lstat(request.sourcePath);
		if (
			!afterRootStat.isDirectory() ||
			afterRootStat.isSymbolicLink() ||
			rootStat.dev !== afterRootStat.dev ||
			rootStat.ino !== afterRootStat.ino
		) {
			failManagedWorkspaceSeedSourceV1("Managed workspace seed source changed during enumeration");
		}

		const files: WorkspaceSnapshotFile[] = [];
		for (const candidate of candidates.sort((left, right) => compareUtf8(left.path, right.path))) {
			throwIfManagedWorkspaceSeedReadAbortedV1(request.signal);
			const handle = await open(candidate.sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
			try {
				const before = await handle.stat();
				if (!sameManagedWorkspaceSeedFileStatV1(candidate, before))
					failManagedWorkspaceSeedSourceV1("Managed workspace seed source changed during enumeration");
				const bytes = Buffer.allocUnsafe(candidate.size);
				let offset = 0;
				while (offset < bytes.byteLength) {
					throwIfManagedWorkspaceSeedReadAbortedV1(request.signal);
					const length = Math.min(MANAGED_WORKSPACE_SEED_READ_CHUNK_BYTES_V1, bytes.byteLength - offset);
					const result = await handle.read(bytes, offset, length, offset);
					if (result.bytesRead === 0)
						failManagedWorkspaceSeedSourceV1("Managed workspace seed source changed during enumeration");
					offset += result.bytesRead;
				}
				throwIfManagedWorkspaceSeedReadAbortedV1(request.signal);
				const after = await handle.stat();
				if (!sameManagedWorkspaceSeedFileStatV1(candidate, after))
					failManagedWorkspaceSeedSourceV1("Managed workspace seed source changed during enumeration");
				let contentUtf8: string;
				try {
					contentUtf8 = utf8Decoder.decode(bytes);
				} catch {
					failManagedWorkspaceSeedSourceV1("Managed workspace seed source contains malformed UTF-8");
				}
				if (bytes.includes(0) || !Buffer.from(contentUtf8, "utf8").equals(bytes))
					failManagedWorkspaceSeedSourceV1("Managed workspace seed source contains binary content");
				files.push(
					Object.freeze({
						path: candidate.path as WorkspaceSnapshotFile["path"],
						contentUtf8,
						sha256: createHash("sha256").update(bytes).digest("hex") as Sha256Hex,
						byteLength: bytes.byteLength,
					}),
				);
			} finally {
				await handle.close();
			}
		}
		const frozenFiles = Object.freeze(files);
		return Object.freeze({ image: managedWorkspaceSeedImageV1(frozenFiles), files: frozenFiles });
	} catch (error) {
		if (
			error instanceof ManagedWorkspaceSeedSourceFailureV1 ||
			(error instanceof Error && error.name === "AbortError")
		)
			throw error;
		if (request.signal?.aborted) throwIfManagedWorkspaceSeedReadAbortedV1(request.signal);
		failManagedWorkspaceSeedSourceV1("Managed workspace seed source could not be read");
	}
}

interface PrivateManagedWorkspaceSeedSourceBindingV1 {
	readonly schemaVersion: 1;
	readonly source: ManagedWorkspaceSeedSourceRefV1;
	readonly sourcePath: string;
	readonly expiresAt: ISO8601;
}

function decodePrivateManagedWorkspaceSeedSourceBindingV1(
	input: unknown | null,
): PrivateManagedWorkspaceSeedSourceBindingV1 | null {
	if (input === null) return null;
	if (
		!isStrictRecord(input, ["schemaVersion", "source", "sourcePath", "expiresAt"]) ||
		input.schemaVersion !== 1 ||
		typeof input.sourcePath !== "string" ||
		!canonicalManagedWorkspaceSeedSourcePathV1(input.sourcePath) ||
		!isIso8601(input.expiresAt)
	) {
		failManagedWorkspaceSeedSourceV1("Managed workspace seed source binding is invalid");
	}
	return Object.freeze({
		schemaVersion: 1,
		source: decodeManagedWorkspaceSeedSourceRefV1(input.source),
		sourcePath: input.sourcePath,
		expiresAt: input.expiresAt,
	});
}

function managedWorkspaceSeedBindingMatchesV1(
	binding: PrivateManagedWorkspaceSeedSourceBindingV1,
	request: {
		readonly source: ManagedWorkspaceSeedSourceRefV1;
		readonly sourcePath: string;
		readonly expiresAt: ISO8601;
	},
): boolean {
	return (
		managedWorkspaceSeedSourceMatchesV1(binding.source, request.source) &&
		binding.sourcePath === request.sourcePath &&
		binding.expiresAt === request.expiresAt
	);
}

/** Durable private authority for transient copy-seed physical paths. */
export class DurableManagedWorkspaceSeedSourceStoreV1 implements ManagedWorkspaceSeedSourceStore {
	readonly #durable: RuntimeDurableStateStoreV1;
	readonly #now: () => ISO8601;

	constructor(options: { readonly durable: RuntimeDurableStateStoreV1; readonly now?: () => ISO8601 }) {
		this.#durable = options.durable;
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	#expiredAt(expiresAt: ISO8601): boolean {
		const now = this.#now();
		if (!isIso8601(now)) failManagedWorkspaceSeedSourceV1("Managed workspace seed source clock is invalid");
		return Date.parse(expiresAt) <= Date.parse(now);
	}

	#expired(binding: PrivateManagedWorkspaceSeedSourceBindingV1): boolean {
		return this.#expiredAt(binding.expiresAt);
	}

	async bind(request: {
		readonly source: ManagedWorkspaceSeedSourceRefV1;
		readonly sourcePath: string;
		readonly expiresAt: ISO8601;
	}): Promise<{ readonly status: "bound" | "already_bound" | "conflict" }> {
		const source = decodeManagedWorkspaceSeedSourceRefV1(request.source);
		if (!canonicalManagedWorkspaceSeedSourcePathV1(request.sourcePath) || !isIso8601(request.expiresAt))
			failManagedWorkspaceSeedSourceV1("Managed workspace seed source bind request is invalid");
		if (this.#expiredAt(request.expiresAt)) return { status: "conflict" };
		const exactRequest = Object.freeze({ source, sourcePath: request.sourcePath, expiresAt: request.expiresAt });
		const observed = decodePrivateManagedWorkspaceSeedSourceBindingV1(
			await this.#durable.inspect(MANAGED_WORKSPACE_SEED_SOURCE_NAMESPACE_V1, source.sourceId),
		);
		if (observed && !this.#expired(observed) && !managedWorkspaceSeedBindingMatchesV1(observed, exactRequest))
			return { status: "conflict" };
		const read = await readManagedWorkspaceSeedSourceV1({ sourcePath: request.sourcePath, limits: source.limits });
		if (!imageMatches(read.image, source.expectedImage)) return { status: "conflict" };
		return this.#durable.transact(MANAGED_WORKSPACE_SEED_SOURCE_NAMESPACE_V1, source.sourceId, currentInput => {
			let current = decodePrivateManagedWorkspaceSeedSourceBindingV1(currentInput);
			if (current && this.#expired(current)) current = null;
			if (this.#expiredAt(request.expiresAt)) return { state: current, result: { status: "conflict" } as const };
			if (current) {
				return {
					state: current,
					result: {
						status: managedWorkspaceSeedBindingMatchesV1(current, exactRequest) ? "already_bound" : "conflict",
					} as const,
				};
			}
			const binding: PrivateManagedWorkspaceSeedSourceBindingV1 = Object.freeze({
				schemaVersion: 1,
				source,
				sourcePath: request.sourcePath,
				expiresAt: request.expiresAt,
			});
			return { state: binding, result: { status: "bound" } as const };
		});
	}

	async inspect(sourceInput: ManagedWorkspaceSeedSourceRefV1) {
		const source = decodeManagedWorkspaceSeedSourceRefV1(sourceInput);
		return this.#durable.transact(MANAGED_WORKSPACE_SEED_SOURCE_NAMESPACE_V1, source.sourceId, currentInput => {
			const current = decodePrivateManagedWorkspaceSeedSourceBindingV1(currentInput);
			if (!current || this.#expired(current)) {
				return { state: null, result: { status: "absent", sourceId: source.sourceId } as const };
			}
			if (!managedWorkspaceSeedSourceMatchesV1(current.source, source))
				return { state: current, result: { status: "conflict", sourceId: source.sourceId } as const };
			return { state: current, result: { status: "bound", source: current.source } as const };
		});
	}

	async #boundPath(source: ManagedWorkspaceSeedSourceRefV1): Promise<string> {
		const result = await this.#durable.transact(
			MANAGED_WORKSPACE_SEED_SOURCE_NAMESPACE_V1,
			source.sourceId,
			currentInput => {
				const current = decodePrivateManagedWorkspaceSeedSourceBindingV1(currentInput);
				if (!current || this.#expired(current)) return { state: null, result: { status: "absent" } as const };
				if (!managedWorkspaceSeedSourceMatchesV1(current.source, source))
					return { state: current, result: { status: "conflict" } as const };
				return { state: current, result: { status: "bound", sourcePath: current.sourcePath } as const };
			},
		);
		if (result.status === "absent") failManagedWorkspaceSeedSourceV1("Managed workspace seed source is unavailable");
		if (result.status === "conflict")
			failManagedWorkspaceSeedSourceV1("Managed workspace seed source conflicts with the requested reference");
		return result.sourcePath;
	}

	async #readBound(
		source: ManagedWorkspaceSeedSourceRefV1,
		signal?: AbortSignal,
	): Promise<readonly WorkspaceSnapshotFile[]> {
		const sourcePath = await this.#boundPath(source);
		const read = await readManagedWorkspaceSeedSourceV1({ sourcePath, limits: source.limits, signal });
		if (!imageMatches(read.image, source.expectedImage))
			failManagedWorkspaceSeedSourceV1("Managed workspace seed source changed");
		const currentSourcePath = await this.#boundPath(source);
		if (currentSourcePath !== sourcePath)
			failManagedWorkspaceSeedSourceV1("Managed workspace seed source binding changed");
		return read.files;
	}

	async open(sourceInput: ManagedWorkspaceSeedSourceRefV1): Promise<ManagedWorkspaceSeedReader> {
		const source = decodeManagedWorkspaceSeedSourceRefV1(sourceInput);
		await this.#readBound(source);
		let closed = false;
		return Object.freeze({
			source,
			readFiles: async (signal?: AbortSignal) => {
				if (closed) failManagedWorkspaceSeedSourceV1("Managed workspace seed source reader is closed");
				return this.#readBound(source, signal);
			},
			close: async () => {
				closed = true;
			},
		});
	}

	async release(request: {
		readonly source: ManagedWorkspaceSeedSourceRefV1;
		readonly reason: "workspace_ready" | "creation_discarded" | "expired";
	}): Promise<{ readonly status: "released" | "already_absent" }> {
		const source = decodeManagedWorkspaceSeedSourceRefV1(request.source);
		if (!(["workspace_ready", "creation_discarded", "expired"] as const).includes(request.reason))
			failManagedWorkspaceSeedSourceV1("Managed workspace seed source release request is invalid");
		return this.#durable.transact(MANAGED_WORKSPACE_SEED_SOURCE_NAMESPACE_V1, source.sourceId, currentInput => {
			const current = decodePrivateManagedWorkspaceSeedSourceBindingV1(currentInput);
			if (!current || !managedWorkspaceSeedSourceMatchesV1(current.source, source))
				return { state: current, result: { status: "already_absent" } as const };
			return { state: null, result: { status: "released" } as const };
		});
	}
}

export type PersistentControllerAuthorizationV1 =
	| { readonly status: "current" }
	| { readonly status: "controller_lost" }
	| { readonly status: "deletion_latched"; readonly deleteId: OperationId };

export interface RuntimeWorkspaceAuthorityV1 {
	authorizePersistentController(proof: WorkspaceControllerLeaseProof): Promise<PersistentControllerAuthorizationV1>;
	authorizePersistentDeletion(proof: WorkspaceDeletionAuthorityProof): Promise<boolean>;
	authorizeTransientController(
		proof: TransientTaskControllerAuthorityProofV1,
	): Promise<"current" | "controller_lost" | "cleanup_latched">;
	authorizeTransientCleanup(proof: TransientTaskCleanupAuthorityProofV1): Promise<boolean>;
}

interface PersistentStagingRecordV1 {
	readonly state: "staging";
	readonly createId: OperationId;
	readonly stageId: OperationId;
	readonly requestIdentitySha256: Sha256Hex;
	readonly stagedImage: WorkspaceImage | null;
}

interface PersistentPresentRecordV1 {
	readonly state: "present";
	readonly createId: OperationId;
	readonly workspace: ManagedWorkspaceRef;
	readonly snapshot: WorkspaceSnapshot;
	readonly commits: Readonly<
		Record<OperationId, { readonly requestSha256: Sha256Hex; readonly result: CanonicalWorkspaceCommitResult }>
	>;
}

interface PersistentDeletedRecordV1 {
	readonly state: "tombstoned" | "purged";
	readonly tombstone: WorkspaceTombstone;
	readonly cleanupProof: TerminalReplicaCleanupProofV1 | null;
}

type PersistentWorkspaceRecordV1 = PersistentStagingRecordV1 | PersistentPresentRecordV1 | PersistentDeletedRecordV1;

interface TransientPublicationRecordV1 {
	readonly attempt: TransientTaskCanonicalWorktreePublicationEffectV1["attempt"];
	readonly state: "not_applied" | "outcome_unknown" | "complete";
	readonly receipt: TransientTaskWorktreePublicationReceiptV1 | null;
}

interface TransientWorkspaceRecordV1 {
	readonly workspace: TransientTaskManagedWorkspaceRefV1;
	readonly snapshot: WorkspaceSnapshot;
	readonly createRequestSha256: Sha256Hex;
	readonly commits: Readonly<
		Record<OperationId, { readonly requestSha256: Sha256Hex; readonly result: TransientTaskCanonicalCommitResultV1 }>
	>;
	readonly publications: Readonly<Record<OperationId, TransientPublicationRecordV1>>;
	readonly discard: TransientTaskCanonicalDiscardReceiptV1 | null;
}

function persistentState(input: unknown | null): PersistentWorkspaceRecordV1 | null {
	return input === null ? null : (input as PersistentWorkspaceRecordV1);
}

function transientState(input: unknown | null): TransientWorkspaceRecordV1 | null {
	return input === null ? null : (input as TransientWorkspaceRecordV1);
}

function authorizationResult(
	authorization: PersistentControllerAuthorizationV1,
):
	| { readonly status: "controller_lost" }
	| { readonly status: "deletion_latched"; readonly deleteId: OperationId }
	| null {
	return authorization.status === "current" ? null : authorization;
}

export class ManagedWorkspaceStore implements CanonicalWorkspaceStore {
	readonly #durable: RuntimeDurableStateStoreV1;
	readonly #authority: RuntimeWorkspaceAuthorityV1;
	readonly #seedSources: ManagedWorkspaceSeedSourceStore;
	readonly #now: () => ISO8601;

	constructor(options: {
		readonly durable: RuntimeDurableStateStoreV1;
		readonly authority: RuntimeWorkspaceAuthorityV1;
		readonly seedSources: ManagedWorkspaceSeedSourceStore;
		readonly now?: () => ISO8601;
	}) {
		this.#durable = options.durable;
		this.#authority = options.authority;
		this.#seedSources = options.seedSources;
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	async create(request: CanonicalWorkspaceCreateRequest): Promise<CanonicalWorkspaceCreateResult> {
		const authorization = authorizationResult(
			await this.#authority.authorizePersistentController(request.controllerLease),
		);
		if (authorization) return authorization;
		const requestSha256 = await canonicalRuntimeSha256([
			"omp-canonical-workspace-create-v1",
			request.createId,
			request.stageId,
			request.workspaceId,
			request.seed.kind,
			request.seed.kind === "empty" ? request.seed.expectedImage.rootSha256 : request.seed.source.sourceId,
			request.expectedImage.rootSha256,
			request.expectedImage.fileCount,
			request.expectedImage.byteCount,
			request.retention.onAgentRelease,
			request.retention.deletedBytesGraceMs,
		]);
		const partition = `persistent\u0000${request.workspaceId}`;
		const prior = await this.#durable.transact("canonical-workspace", partition, currentInput => {
			const current = persistentState(currentInput);
			if (current?.state === "present") {
				const result: CanonicalWorkspaceCreateResult =
					current.createId === request.createId &&
					imageMatches(current.workspace.checkpoint, request.expectedImage)
						? { status: "already_created", createId: request.createId, workspace: current.workspace }
						: { status: "conflict", workspaceId: request.workspaceId, createId: request.createId };
				return { state: current, result };
			}
			if (current?.state === "tombstoned" || current?.state === "purged") {
				return {
					state: current,
					result: { status: "conflict", workspaceId: request.workspaceId, createId: request.createId } as const,
				};
			}
			if (
				current?.state === "staging" &&
				(current.createId !== request.createId ||
					current.stageId !== request.stageId ||
					current.requestIdentitySha256 !== requestSha256)
			) {
				return {
					state: current,
					result: { status: "conflict", workspaceId: request.workspaceId, createId: request.createId } as const,
				};
			}
			const staging: PersistentStagingRecordV1 =
				current?.state === "staging"
					? current
					: {
							state: "staging",
							createId: request.createId,
							stageId: request.stageId,
							requestIdentitySha256: requestSha256,
							stagedImage: null,
						};
			return { state: staging, result: null };
		});
		if (prior) return prior;

		let files: readonly WorkspaceSnapshotFile[] = [];
		if (request.seed.kind === "copy") {
			const reader = await this.#seedSources.open(request.seed.source);
			try {
				files = await reader.readFiles();
			} finally {
				await reader.close();
			}
		}
		const snapshot = materializeWorkspaceSnapshotV1({
			workspaceId: request.workspaceId,
			generation: 0,
			committedAt: this.#now(),
			files,
		});
		if (!imageMatches(snapshot.checkpoint, request.expectedImage)) {
			return { status: "conflict", workspaceId: request.workspaceId, createId: request.createId };
		}
		const secondAuthorization = authorizationResult(
			await this.#authority.authorizePersistentController(request.controllerLease),
		);
		if (secondAuthorization) return secondAuthorization;
		return this.#durable.transact("canonical-workspace", partition, currentInput => {
			const current = persistentState(currentInput);
			if (current?.state === "present") {
				const result: CanonicalWorkspaceCreateResult =
					current.createId === request.createId && imageMatches(current.workspace.checkpoint, snapshot.checkpoint)
						? { status: "already_created", createId: request.createId, workspace: current.workspace }
						: { status: "conflict", workspaceId: request.workspaceId, createId: request.createId };
				return { state: current, result };
			}
			if (
				current?.state !== "staging" ||
				current.createId !== request.createId ||
				current.stageId !== request.stageId ||
				current.requestIdentitySha256 !== requestSha256
			) {
				return {
					state: current,
					result: { status: "conflict", workspaceId: request.workspaceId, createId: request.createId } as const,
				};
			}
			const workspace: ManagedWorkspaceRef = {
				workspaceId: request.workspaceId,
				mode: "managed",
				format: "omp-text-v1",
				retention: request.retention,
				checkpoint: snapshot.checkpoint,
			};
			const next: PersistentPresentRecordV1 = {
				state: "present",
				createId: request.createId,
				workspace,
				snapshot,
				commits: {},
			};
			return { state: next, result: { status: "created", createId: request.createId, workspace } as const };
		});
	}

	async inspectCreate(request: {
		readonly workspaceId: WorkspaceId;
		readonly createId: OperationId;
		readonly stageId: OperationId;
	}): Promise<CanonicalWorkspaceCreateInspectResult> {
		const current = persistentState(
			await this.#durable.inspect("canonical-workspace", `persistent\u0000${request.workspaceId}`),
		);
		if (!current) return { status: "absent", workspaceId: request.workspaceId, createId: request.createId };
		switch (current.state) {
			case "tombstoned":
			case "purged":
				return { status: "absent", workspaceId: request.workspaceId, createId: request.createId };
			case "staging":
				return current.createId === request.createId && current.stageId === request.stageId
					? {
							status: "staging",
							workspaceId: request.workspaceId,
							createId: request.createId,
							stageId: request.stageId,
							stagedImage: current.stagedImage,
						}
					: { status: "conflict", workspaceId: request.workspaceId, createId: request.createId };
			case "present":
				return current.createId === request.createId
					? { status: "present", createId: request.createId, workspace: current.workspace }
					: { status: "conflict", workspaceId: request.workspaceId, createId: request.createId };
		}
	}

	async abortCreate(request: {
		readonly workspaceId: WorkspaceId;
		readonly createId: OperationId;
		readonly stageId: OperationId;
		readonly controllerLease: WorkspaceControllerLeaseProof;
	}): Promise<CanonicalWorkspaceAbortCreateResult> {
		const authorization = authorizationResult(
			await this.#authority.authorizePersistentController(request.controllerLease),
		);
		if (authorization) return authorization;
		return this.#durable.transact("canonical-workspace", `persistent\u0000${request.workspaceId}`, currentInput => {
			const current = persistentState(currentInput);
			if (!current)
				return {
					state: null,
					result: {
						status: "already_absent",
						workspaceId: request.workspaceId,
						createId: request.createId,
					} as const,
				};
			if (
				current.state !== "staging" ||
				current.createId !== request.createId ||
				current.stageId !== request.stageId
			) {
				return {
					state: current,
					result: { status: "conflict", workspaceId: request.workspaceId, createId: request.createId } as const,
				};
			}
			return {
				state: null,
				result: { status: "aborted", workspaceId: request.workspaceId, createId: request.createId } as const,
			};
		});
	}

	async inspect(workspaceId: WorkspaceId): Promise<CanonicalWorkspaceInspectResult> {
		const current = persistentState(
			await this.#durable.inspect("canonical-workspace", `persistent\u0000${workspaceId}`),
		);
		if (!current || current.state === "staging") return { status: "absent", workspaceId };
		return current.state === "present"
			? { status: "present", workspace: current.workspace }
			: { status: current.state, tombstone: current.tombstone };
	}

	async snapshot(request: CanonicalWorkspaceSnapshotRequest): Promise<CanonicalWorkspaceSnapshotResult> {
		const authorization = authorizationResult(
			await this.#authority.authorizePersistentController(request.controllerLease),
		);
		if (authorization) return authorization;
		const current = persistentState(
			await this.#durable.inspect("canonical-workspace", `persistent\u0000${request.workspaceId}`),
		);
		if (current?.state !== "present") {
			return { status: "generation_conflict", workspaceId: request.workspaceId, currentGeneration: -1 };
		}
		if (current.workspace.checkpoint.generation !== request.expectedGeneration) {
			return {
				status: "generation_conflict",
				workspaceId: request.workspaceId,
				currentGeneration: current.workspace.checkpoint.generation,
			};
		}
		return { status: "snapshot", snapshot: current.snapshot };
	}

	async commit(request: CanonicalWorkspaceCommitRequest): Promise<CanonicalWorkspaceCommitResult> {
		const authorization = authorizationResult(
			await this.#authority.authorizePersistentController(request.controllerLease),
		);
		if (authorization) return authorization;
		const requestSha256 = await canonicalRuntimeSha256([
			"omp-canonical-workspace-commit-v1",
			request.workspaceId,
			request.expectedGeneration,
			request.commitId,
			request.replicaCheckpoint.reference.providerId,
			request.replicaCheckpoint.reference.profileId,
			request.replicaCheckpoint.reference.replicaId,
			request.replicaCheckpoint.reference.leaseId,
			request.replicaCheckpoint.reference.checkpointId,
			request.replicaCheckpoint.rootSha256,
			request.replicaCheckpoint.fileCount,
			request.replicaCheckpoint.byteCount,
		]);
		const snapshot = validateReplicaCheckpoint(
			request.replicaCheckpoint,
			request.workspaceId,
			request.expectedGeneration,
		);
		return this.#durable.transact("canonical-workspace", `persistent\u0000${request.workspaceId}`, currentInput => {
			const current = persistentState(currentInput);
			if (current?.state !== "present") {
				return {
					state: current,
					result: {
						status: "conflict",
						workspaceId: request.workspaceId,
						commitId: request.commitId,
						code: "generation_mismatch",
					} as const,
				};
			}
			const prior = current.commits[request.commitId];
			if (prior) {
				if (prior.requestSha256 !== requestSha256) {
					return {
						state: current,
						result: {
							status: "conflict",
							workspaceId: request.workspaceId,
							commitId: request.commitId,
							code: "commit_identity_mismatch",
						} as const,
					};
				}
				const result =
					prior.result.status === "committed"
						? { ...prior.result, status: "already_committed" as const }
						: prior.result;
				return { state: current, result };
			}
			if (current.workspace.checkpoint.generation !== request.expectedGeneration) {
				return {
					state: current,
					result: {
						status: "conflict",
						workspaceId: request.workspaceId,
						commitId: request.commitId,
						code: "generation_mismatch",
					} as const,
				};
			}
			if (!snapshot) {
				return {
					state: current,
					result: {
						status: "conflict",
						workspaceId: request.workspaceId,
						commitId: request.commitId,
						code: "checkpoint_invalid",
					} as const,
				};
			}
			const workspace: ManagedWorkspaceRef = { ...current.workspace, checkpoint: snapshot.checkpoint };
			const result: CanonicalWorkspaceCommitResult = {
				status: "committed",
				workspace,
				receipt: {
					workspaceId: request.workspaceId,
					commitId: request.commitId,
					expectedGeneration: request.expectedGeneration,
					checkpoint: snapshot.checkpoint,
					durableAt: this.#now(),
				},
			};
			const next: PersistentPresentRecordV1 = {
				...current,
				workspace,
				snapshot,
				commits: { ...current.commits, [request.commitId]: { requestSha256, result } },
			};
			return { state: next, result };
		});
	}

	async delete(request: CanonicalWorkspaceDeleteRequest): Promise<CanonicalWorkspaceDeleteResult> {
		if (!(await this.#authority.authorizePersistentDeletion(request.deletionAuthority)))
			return { status: "authority_lost" };
		const rawCore = request.deletion.core;
		const invalid = (
			code: Extract<CanonicalWorkspaceDeleteResult, { status: "verification_invalid" }>["code"],
		): CanonicalWorkspaceDeleteResult => ({
			status: "verification_invalid",
			workspaceId: rawCore.workspaceId,
			deleteId: rawCore.deleteId,
			code,
		});
		const materializedDeletion = await validateWorkspaceDeletionPlanV1(request.deletion).catch(() => null);
		if (!materializedDeletion) return invalid("deletion_plan_digest_mismatch");
		const core = materializedDeletion.deletion.core;
		if (request.deletionPlanCoreSha256 !== materializedDeletion.deletionPlanCoreSha256)
			return invalid("deletion_plan_core_digest_mismatch");
		if (request.deletionPlanSha256 !== materializedDeletion.deletionPlanSha256)
			return invalid("deletion_plan_digest_mismatch");
		if (request.deletionAuthority.workspaceId !== core.workspaceId) return invalid("workspace_mismatch");
		if (
			request.deletionAuthority.deleteId !== core.deleteId ||
			request.deletionVerification.deleteId !== core.deleteId
		)
			return invalid("delete_mismatch");
		if (
			request.deletionAuthority.deletionAuthorityId !== core.deletionAuthorityId ||
			request.deletionVerification.deletionAuthorityId !== core.deletionAuthorityId
		)
			return invalid("authority_mismatch");
		if (request.deletionVerification.deletionEpoch !== request.deletionAuthority.epoch)
			return invalid("verification_epoch_mismatch");
		if (
			request.deletionPlanCoreSha256 !== request.deletionAuthority.deletionPlanCoreSha256 ||
			request.deletionPlanCoreSha256 !== request.deletionVerification.deletionPlanCoreSha256
		)
			return invalid("deletion_plan_core_digest_mismatch");
		if (
			request.deletionPlanSha256 !== request.deletionAuthority.deletionPlanSha256 ||
			request.deletionPlanSha256 !== request.deletionVerification.deletionPlanSha256
		)
			return invalid("deletion_plan_digest_mismatch");
		if (
			request.deletionVerification.canonicalGeneration !== core.expectedCheckpoint.generation ||
			request.deletionVerification.runtimeAttachmentCreateId !== core.expectedRuntimeAttachmentCreateId ||
			request.deletionVerification.runtimeAttachmentRevision !== core.expectedRuntimeAttachmentRevision ||
			request.deletionVerification.runtimeAttachmentState !== "none"
		)
			return invalid("attachment_receipt_mismatch");
		const expectedReceipt = `sha256:${await canonicalRuntimeSha256([
			"omp-workspace-deletion-verification-v1",
			core.workspaceId,
			core.deleteId,
			core.deletionAuthorityId,
			request.deletionPlanCoreSha256,
			request.deletionPlanSha256,
			request.deletionAuthority.epoch,
			request.deletionVerification.canonicalGeneration,
			request.deletionVerification.runtimeAttachmentCreateId,
			request.deletionVerification.runtimeAttachmentRevision,
			"none",
			request.deletionVerification.verifiedAt,
		])}`;
		if (expectedReceipt !== request.deletionVerification.receiptSha256) return invalid("receipt_digest_mismatch");
		return this.#durable.transact("canonical-workspace", `persistent\u0000${core.workspaceId}`, currentInput => {
			const current = persistentState(currentInput);
			if (current?.state === "tombstoned" || current?.state === "purged") {
				return current.tombstone.deleteId === core.deleteId
					? { state: current, result: { status: "already_tombstoned", tombstone: current.tombstone } as const }
					: {
							state: current,
							result: {
								status: "conflict",
								workspaceId: core.workspaceId,
								deleteId: core.deleteId,
								code: "tombstone_conflict",
							} as const,
						};
			}
			if (
				current?.state !== "present" ||
				!checkpointMatches(current.workspace.checkpoint, core.expectedCheckpoint)
			) {
				return {
					state: current,
					result: {
						status: "conflict",
						workspaceId: core.workspaceId,
						deleteId: core.deleteId,
						code: "generation_mismatch",
					} as const,
				};
			}
			const tombstone = deriveWorkspaceTombstoneV1(core);
			const next: PersistentDeletedRecordV1 = { state: "tombstoned", tombstone, cleanupProof: null };
			return { state: next, result: { status: "tombstoned", tombstone } as const };
		});
	}

	async purge(request: CanonicalWorkspacePurgeRequest): Promise<CanonicalWorkspacePurgeResult> {
		if (!(await this.#authority.authorizePersistentDeletion(request.deletionAuthority)))
			return { status: "authority_lost" };
		return this.#durable.transact("canonical-workspace", `persistent\u0000${request.workspaceId}`, currentInput => {
			const current = persistentState(currentInput);
			if (!current || current.state === "staging" || current.state === "present") {
				return { state: current, result: { status: "conflict", code: "tombstone_mismatch" } as const };
			}
			if (current.tombstone.deleteId !== request.deletion.core.deleteId) {
				return { state: current, result: { status: "conflict", code: "delete_id_mismatch" } as const };
			}
			if (
				request.cleanupProof.workspaceId !== request.workspaceId ||
				request.cleanupProof.deleteId !== request.deletion.core.deleteId ||
				request.cleanupProof.deletionPlanCoreSha256 !== request.deletionPlanCoreSha256 ||
				request.cleanupProof.deletionPlanSha256 !== request.deletionPlanSha256
			) {
				return {
					state: current,
					result: {
						status: "cleanup_proof_invalid",
						tombstone: current.tombstone,
						code: "proof_digest_mismatch",
					} as const,
				};
			}
			if (Date.parse(this.#now()) < Date.parse(current.tombstone.purgeAfter)) {
				return {
					state: current,
					result: { status: "not_due", tombstone: current.tombstone, cleanupProof: request.cleanupProof } as const,
				};
			}
			if (current.state === "purged") {
				const matches =
					current.cleanupProof !== null &&
					JSON.stringify(current.cleanupProof) === JSON.stringify(request.cleanupProof);
				return matches
					? {
							state: current,
							result: {
								status: "already_purged",
								tombstone: current.tombstone,
								cleanupProof: request.cleanupProof,
							} as const,
						}
					: {
							state: current,
							result: {
								status: "cleanup_proof_invalid",
								tombstone: current.tombstone,
								code: "proof_digest_mismatch",
							} as const,
						};
			}
			const next: PersistentDeletedRecordV1 = {
				state: "purged",
				tombstone: current.tombstone,
				cleanupProof: request.cleanupProof,
			};
			return {
				state: next,
				result: { status: "purged", tombstone: current.tombstone, cleanupProof: request.cleanupProof } as const,
			};
		});
	}
}
export interface TransientTaskWorktreePublicationEffectExecutorV1 {
	publish(
		effect: TransientTaskCanonicalWorktreePublicationEffectV1,
	): Promise<TransientTaskWorktreePublicationReceiptV1>;
	inspect(
		effect: TransientTaskCanonicalWorktreePublicationEffectV1,
	): Promise<TransientTaskWorktreePublicationReceiptV1 | TransientTaskCanonicalWorktreePublicationNotAppliedReceiptV1>;
}

const WORKTREE_PUBLICATION_DOMAIN_V1 = "omp-transient-task-canonical-worktree-publication-v1";
function validTransientCleanupRequest(request: {
	readonly taskId: string;
	readonly runId: string;
	readonly workspaceId: WorkspaceId;
	readonly cleanupId: OperationId;
	readonly cleanupAuthorityId: OperationId;
	readonly fencingGeneration: number;
	readonly cleanup: TransientTaskCleanupAuthorityProofV1;
}): boolean {
	return (
		request.taskId === request.cleanup.taskId &&
		request.runId === request.cleanup.runId &&
		request.workspaceId === request.cleanup.workspaceId &&
		request.cleanupId === request.cleanup.cleanupId &&
		request.cleanupAuthorityId === request.cleanup.cleanupAuthorityId &&
		request.fencingGeneration === request.cleanup.fencingGeneration
	);
}

function publicationTargetKeyTuple(
	key: TransientTaskPublicationTargetPublicationClaimV1["key"],
): readonly CanonicalRuntimeValue[] {
	return [1, key.taskId, key.runId, key.createId, key.publicationTargetId];
}

function publicationCleanupProofTuple(
	proof: TransientTaskCleanupAuthorityProofV1,
): readonly CanonicalRuntimeValue[] {
	return [
		1,
		proof.taskId,
		proof.runId,
		proof.cleanupId,
		proof.cleanupAuthorityId,
		proof.workspaceId,
		proof.controlHostId,
		proof.cleanupEpoch,
		proof.fencingGeneration,
	];
}

function publicationClaimTuple(
	claim: TransientTaskPublicationTargetPublicationClaimV1,
): readonly CanonicalRuntimeValue[] {
	return [
		1,
		publicationTargetKeyTuple(claim.key),
		claim.isolationCleanupId,
		claim.worktreePublicationId,
		claim.openOperationId,
		"live",
		claim.bindingRevision,
		claim.renewalSequence,
		claim.bindingReceiptSha256,
		claim.bindingAuthoritySha256,
		claim.bindingOpenRequestSha256,
		claim.isolationNamespaceSha256,
		claim.isolationOwnerManifestSha256,
		claim.isolationCreatorDescriptorSha256,
		claim.claimedAt,
	];
}

function publicationRequestTuple(
	request: TransientTaskCanonicalWorktreePublicationEffectV1["attempt"]["request"],
): readonly CanonicalRuntimeValue[] {
	return [
		WORKTREE_PUBLICATION_DOMAIN_V1,
		"request",
		1,
		request.taskId,
		request.runId,
		request.workspaceId,
		request.createId,
		request.cleanupId,
		request.cleanupAuthorityId,
		request.expectedAuthorityRevision,
		request.expectedGeneration,
		request.expectedRootSha256,
		request.fencingGeneration,
		publicationCleanupProofTuple(request.cleanup),
		request.worktreePublicationId,
		request.effectIdentityManifestSha256,
		publicationTargetKeyTuple(request.publicationTargetKey),
		publicationClaimTuple(request.publicationClaim),
		request.bindingRevision,
		request.bindingRenewalSequence,
		request.bindingReceiptSha256,
		request.bindingAuthoritySha256,
		request.bindingOpenRequestSha256,
		checkpointTuple(request.checkpoint),
	];
}

async function validPublicationAttempt(effect: TransientTaskCanonicalWorktreePublicationEffectV1): Promise<boolean> {
	const attempt = effect.attempt;
	const request = attempt.request;
	const claim = request.publicationClaim;
	if (
		!validTransientCleanupRequest(request) ||
		claim.key.taskId !== request.taskId ||
		claim.key.runId !== request.runId ||
		claim.key.createId !== request.createId ||
		JSON.stringify(request.publicationTargetKey) !== JSON.stringify(claim.key) ||
		claim.worktreePublicationId !== request.worktreePublicationId ||
		request.bindingRevision !== claim.bindingRevision ||
		request.bindingRenewalSequence !== claim.renewalSequence ||
		request.bindingReceiptSha256 !== claim.bindingReceiptSha256 ||
		request.bindingAuthoritySha256 !== claim.bindingAuthoritySha256 ||
		request.bindingOpenRequestSha256 !== claim.bindingOpenRequestSha256 ||
		request.checkpoint.workspaceId !== request.workspaceId ||
		request.checkpoint.generation !== request.expectedGeneration ||
		request.checkpoint.rootSha256 !== request.expectedRootSha256 ||
		JSON.stringify(attempt.publicationClaim) !== JSON.stringify(claim) ||
		JSON.stringify(effect.publicationTarget.claim) !== JSON.stringify(claim)
	)
		return false;
	const requestSha256 = await canonicalRuntimeSha256(publicationRequestTuple(request));
	if (request.requestSha256 !== requestSha256) return false;
	const attemptSha256 = `sha256:${await canonicalRuntimeSha256([
		WORKTREE_PUBLICATION_DOMAIN_V1,
		"attempt",
		1,
		publicationRequestTuple(request),
		publicationClaimTuple(attempt.publicationClaim),
		attempt.openedAt,
	])}`;
	return attempt.attemptSha256 === attemptSha256;
}

function samePublicationAttempt(
	left: TransientTaskCanonicalWorktreePublicationEffectV1["attempt"],
	right: TransientTaskCanonicalWorktreePublicationEffectV1["attempt"],
): boolean {
	return left.attemptSha256 === right.attemptSha256 && JSON.stringify(left) === JSON.stringify(right);
}

function publicationReceiptTuple(
	receipt: TransientTaskWorktreePublicationReceiptV1,
): readonly CanonicalRuntimeValue[] {
	return [
		WORKTREE_PUBLICATION_DOMAIN_V1,
		"receipt",
		1,
		receipt.taskId,
		receipt.runId,
		receipt.worktreePublicationId,
		receipt.effectIdentityManifestSha256,
		receipt.workspaceId,
		receipt.createId,
		receipt.cleanupId,
		receipt.cleanupAuthorityId,
		publicationTargetKeyTuple(receipt.publicationTargetKey),
		publicationClaimTuple(receipt.publicationClaim),
		receipt.bindingRevision,
		receipt.bindingRenewalSequence,
		receipt.bindingReceiptSha256,
		receipt.bindingAuthoritySha256,
		receipt.bindingOpenRequestSha256,
		checkpointTuple(receipt.checkpoint),
		receipt.requestSha256,
		receipt.attemptSha256,
		receipt.publishedAt,
	];
}

async function validPublicationReceipt(
	attempt: TransientTaskCanonicalWorktreePublicationEffectV1["attempt"],
	receipt: TransientTaskWorktreePublicationReceiptV1,
): Promise<boolean> {
	const request = attempt.request;
	return (
		receipt.taskId === request.taskId &&
		receipt.runId === request.runId &&
		receipt.worktreePublicationId === request.worktreePublicationId &&
		receipt.effectIdentityManifestSha256 === request.effectIdentityManifestSha256 &&
		receipt.workspaceId === request.workspaceId &&
		receipt.createId === request.createId &&
		receipt.cleanupId === request.cleanupId &&
		receipt.cleanupAuthorityId === request.cleanupAuthorityId &&
		JSON.stringify(receipt.publicationTargetKey) === JSON.stringify(request.publicationTargetKey) &&
		JSON.stringify(receipt.publicationClaim) === JSON.stringify(request.publicationClaim) &&
		receipt.bindingRevision === request.bindingRevision &&
		receipt.bindingRenewalSequence === request.bindingRenewalSequence &&
		receipt.bindingReceiptSha256 === request.bindingReceiptSha256 &&
		receipt.bindingAuthoritySha256 === request.bindingAuthoritySha256 &&
		receipt.bindingOpenRequestSha256 === request.bindingOpenRequestSha256 &&
		checkpointMatches(receipt.checkpoint, request.checkpoint) &&
		receipt.requestSha256 === request.requestSha256 &&
		receipt.attemptSha256 === attempt.attemptSha256 &&
		receipt.receiptSha256 === `sha256:${await canonicalRuntimeSha256(publicationReceiptTuple(receipt))}`
	);
}

async function validPublicationNotApplied(
	attempt: TransientTaskCanonicalWorktreePublicationEffectV1["attempt"],
	proof: TransientTaskCanonicalWorktreePublicationNotAppliedReceiptV1,
): Promise<boolean> {
	const request = attempt.request;
	return (
		proof.taskId === request.taskId &&
		proof.runId === request.runId &&
		proof.cleanupId === request.cleanupId &&
		proof.cleanupAuthorityId === request.cleanupAuthorityId &&
		proof.worktreePublicationId === request.worktreePublicationId &&
		JSON.stringify(proof.publicationTargetKey) === JSON.stringify(request.publicationTargetKey) &&
		proof.publicationClaimSha256 === request.publicationClaim.claimSha256 &&
		proof.publicationRequestSha256 === request.requestSha256 &&
		proof.publicationAttemptSha256 === attempt.attemptSha256 &&
		proof.receiptSha256 ===
			`sha256:${await canonicalRuntimeSha256([
				WORKTREE_PUBLICATION_DOMAIN_V1,
				"not_applied",
				1,
				proof.taskId,
				proof.runId,
				proof.cleanupId,
				proof.cleanupAuthorityId,
				proof.worktreePublicationId,
				publicationTargetKeyTuple(proof.publicationTargetKey),
				proof.publicationClaimSha256,
				proof.publicationRequestSha256,
				proof.publicationAttemptSha256,
				proof.inspectedAt,
			])}`
	);
}

function canonicalDiscardReceiptTuple(
	receipt: Omit<TransientTaskCanonicalDiscardReceiptV1, "receiptSha256">,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-canonical-discard-v1",
		receipt.taskId,
		receipt.runId,
		receipt.workspaceId,
		receipt.cleanupId,
		receipt.cleanupAuthorityId,
		receipt.canonicalDiscardId,
		receipt.finalCheckpoint.generation,
		receipt.finalCheckpoint.rootSha256,
		receipt.finalCheckpoint.fileCount,
		receipt.finalCheckpoint.byteCount,
		receipt.finalCheckpoint.committedAt,
		receipt.cleanupPlanSha256,
		receipt.discardedAt,
	];
}

async function validCanonicalDiscardReceipt(receipt: TransientTaskCanonicalDiscardReceiptV1): Promise<boolean> {
	return (
		receipt.finalCheckpoint.workspaceId === receipt.workspaceId &&
		receipt.receiptSha256 === `sha256:${await canonicalRuntimeSha256(canonicalDiscardReceiptTuple(receipt))}`
	);
}

async function validPublicationInspectRequest(
	request: TransientTaskCanonicalWorktreePublicationInspectRequestV1,
): Promise<boolean> {
	return (
		request.inspectRequestSha256 ===
		(await canonicalRuntimeSha256([
			WORKTREE_PUBLICATION_DOMAIN_V1,
			"inspect",
			1,
			request.taskId,
			request.runId,
			request.cleanupId,
			request.cleanupAuthorityId,
			request.worktreePublicationId,
			publicationTargetKeyTuple(request.publicationTargetKey),
			request.publicationClaimSha256,
			request.publicationRequestSha256,
			request.publicationAttemptSha256,
		]))
	);
}

function transientIdentity(request: {
	readonly taskId: string;
	readonly runId: string;
	readonly workspaceId: WorkspaceId;
	readonly expectedGeneration: number;
	readonly expectedRootSha256: Sha256Hex;
	readonly requestSha256: Sha256Hex;
}): readonly (string | number)[] {
	return [
		request.taskId,
		request.runId,
		request.workspaceId,
		request.expectedGeneration,
		request.expectedRootSha256,
		request.requestSha256,
	];
}

export class TransientTaskCanonicalWorkspaceStore implements TransientTaskCanonicalWorkspaceStoreV1 {
	readonly #durable: RuntimeDurableStateStoreV1;
	readonly #authority: RuntimeWorkspaceAuthorityV1;
	readonly #publication: TransientTaskWorktreePublicationEffectExecutorV1;
	readonly #bindingStore: TransientTaskPublicationTargetBindingStoreV1;
	readonly #now: () => ISO8601;

	constructor(options: {
		readonly durable: RuntimeDurableStateStoreV1;
		readonly authority: RuntimeWorkspaceAuthorityV1;
		readonly publication: TransientTaskWorktreePublicationEffectExecutorV1;
		readonly bindingStore: TransientTaskPublicationTargetBindingStoreV1;
		readonly now?: () => ISO8601;
	}) {
		this.#durable = options.durable;
		this.#authority = options.authority;
		this.#publication = options.publication;
		this.#bindingStore = options.bindingStore;
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	async create(request: TransientTaskCanonicalCreateRequestV1): Promise<TransientTaskCanonicalCreateResultV1> {
		const authorization = await this.#authority.authorizeTransientController(request.controller);
		if (authorization !== "current") return { status: authorization };
		if (
			!validateWorkspaceSnapshotV1(request.snapshot) ||
			request.snapshot.checkpoint.workspaceId !== request.workspaceId ||
			request.snapshot.checkpoint.generation !== 0 ||
			request.expectedGeneration !== 0 ||
			request.snapshot.checkpoint.rootSha256 !== request.expectedRootSha256
		) {
			return { status: "conflict", code: "snapshot_invalid" };
		}
		const createRequestSha256 = await canonicalRuntimeSha256([
			"omp-transient-task-canonical-create-v1",
			...transientIdentity(request),
			request.createId,
			request.snapshot.checkpoint.fileCount,
			request.snapshot.checkpoint.byteCount,
		]);
		return this.#durable.transact(
			"transient-canonical-workspace",
			`${request.taskId}\u0000${request.runId}`,
			currentInput => {
				const current = transientState(currentInput);
				if (current) {
					const result: TransientTaskCanonicalCreateResultV1 =
						current.createRequestSha256 === createRequestSha256
							? { status: "already_created", workspace: current.workspace }
							: { status: "conflict", code: "same_id_different_snapshot" };
					return { state: current, result };
				}
				const workspace: TransientTaskManagedWorkspaceRefV1 = {
					schemaVersion: 1,
					taskId: request.taskId,
					runId: request.runId,
					workspaceId: request.workspaceId,
					createId: request.createId,
					mode: "managed",
					format: "omp-text-v1",
					checkpoint: request.snapshot.checkpoint,
				};
				const next: TransientWorkspaceRecordV1 = {
					workspace,
					snapshot: request.snapshot,
					createRequestSha256,
					commits: {},
					publications: {},
					discard: null,
				};
				return { state: next, result: { status: "created", workspace } as const };
			},
		);
	}

	async inspectCreate(
		request: TransientTaskCanonicalCreateInspectRequestV1,
	): Promise<TransientTaskCanonicalCreateInspectResultV1> {
		const authorization = await this.#authority.authorizeTransientController(request.controller);
		if (authorization !== "current") return { status: authorization };
		const current = transientState(
			await this.#durable.inspect("transient-canonical-workspace", `${request.taskId}\u0000${request.runId}`),
		);
		if (!current) return { status: "absent" };
		return current.workspace.createId === request.createId &&
			current.workspace.workspaceId === request.workspaceId &&
			current.workspace.checkpoint.generation === request.expectedGeneration &&
			current.workspace.checkpoint.rootSha256 === request.expectedRootSha256
			? { status: "present", workspace: current.workspace }
			: { status: "conflict" };
	}

	async snapshot(request: TransientTaskCanonicalSnapshotRequestV1): Promise<TransientTaskCanonicalSnapshotResultV1> {
		const authorization = await this.#authority.authorizeTransientController(request.controller);
		if (authorization !== "current") return { status: authorization };
		const current = transientState(
			await this.#durable.inspect("transient-canonical-workspace", `${request.taskId}\u0000${request.runId}`),
		);
		if (!current) return { status: "generation_conflict", currentGeneration: -1 };
		if (
			current.workspace.checkpoint.generation !== request.expectedGeneration ||
			current.workspace.checkpoint.rootSha256 !== request.expectedRootSha256
		) {
			return { status: "generation_conflict", currentGeneration: current.workspace.checkpoint.generation };
		}
		return { status: "snapshot", snapshot: current.snapshot };
	}

	async commit(request: TransientTaskCanonicalCommitRequestV1): Promise<TransientTaskCanonicalCommitResultV1> {
		if (!validTransientCleanupRequest(request)) return { status: "invalid" };
		const requestSha256 = await canonicalRuntimeSha256([
			"omp-transient-task-canonical-commit-v1",
			...transientIdentity(request),
			request.cleanupId,
			request.cleanupAuthorityId,
			request.commitId,
			request.replicaCheckpoint.reference.providerId,
			request.replicaCheckpoint.reference.profileId,
			request.replicaCheckpoint.reference.replicaId,
			request.replicaCheckpoint.reference.checkpointId,
			request.replicaCheckpoint.rootSha256,
			request.replicaCheckpoint.fileCount,
			request.replicaCheckpoint.byteCount,
		]);
		const snapshot = validateReplicaCheckpoint(
			request.replicaCheckpoint,
			request.workspaceId,
			request.expectedGeneration,
		);
		if (!(await this.#authority.authorizeTransientCleanup(request.cleanup))) return { status: "cleanup_lost" };
		return this.#durable.transact(
			"transient-canonical-workspace",
			`${request.taskId}\u0000${request.runId}`,
			currentInput => {
				const current = transientState(currentInput);
				if (!current) return { state: null, result: { status: "conflict", code: "generation_mismatch" } as const };
				const prior = current.commits[request.commitId];
				if (prior) {
					if (prior.requestSha256 !== requestSha256) {
						return { state: current, result: { status: "conflict", code: "commit_identity_mismatch" } as const };
					}
					const result =
						prior.result.status === "committed"
							? { ...prior.result, status: "already_committed" as const }
							: prior.result;
					return { state: current, result };
				}
				if (
					current.workspace.checkpoint.generation !== request.expectedGeneration ||
					current.workspace.checkpoint.rootSha256 !== request.expectedRootSha256
				) {
					return { state: current, result: { status: "conflict", code: "generation_mismatch" } as const };
				}
				if (!snapshot)
					return { state: current, result: { status: "conflict", code: "checkpoint_invalid" } as const };
				const workspace: TransientTaskManagedWorkspaceRefV1 = {
					...current.workspace,
					checkpoint: snapshot.checkpoint,
				};
				const result: TransientTaskCanonicalCommitResultV1 = {
					status: "committed",
					workspace,
					receipt: {
						workspaceId: request.workspaceId,
						commitId: request.commitId,
						expectedGeneration: request.expectedGeneration,
						checkpoint: snapshot.checkpoint,
						durableAt: this.#now(),
					},
				};
				const next: TransientWorkspaceRecordV1 = {
					...current,
					workspace,
					snapshot,
					commits: { ...current.commits, [request.commitId]: { requestSha256, result } },
				};
				return { state: next, result };
			},
		);
	}

	async publishToWorktree(
		effect: TransientTaskCanonicalWorktreePublicationEffectV1,
	): Promise<TransientTaskCanonicalWorktreePublicationResultV1> {
		const request = effect.attempt.request;
		if (!(await validPublicationAttempt(effect))) return { status: "invalid" };
		if (!(await this.#authority.authorizeTransientCleanup(request.cleanup))) return { status: "cleanup_lost" };
		const preflight = await this.#durable.transact(
			"transient-canonical-workspace",
			`${request.taskId}\u0000${request.runId}`,
			async currentInput => {
				const current = transientState(currentInput);
				if (!current)
					return {
						state: null,
						result: { status: "invalid" } as TransientTaskCanonicalWorktreePublicationResultV1,
					};
				if (
					current.workspace.workspaceId !== request.workspaceId ||
					current.workspace.createId !== request.createId ||
					current.workspace.checkpoint.generation !== request.expectedGeneration ||
					current.workspace.checkpoint.rootSha256 !== request.expectedRootSha256 ||
					!checkpointMatches(current.workspace.checkpoint, request.checkpoint)
				) {
					return {
						state: current,
						result: { status: "generation_conflict" } as TransientTaskCanonicalWorktreePublicationResultV1,
					};
				}
				const prior = current.publications[request.worktreePublicationId];
				if (prior) {
					if (!samePublicationAttempt(prior.attempt, effect.attempt)) {
						return {
							state: current,
							result: {
								status: "publication_identity_conflict",
							} as TransientTaskCanonicalWorktreePublicationResultV1,
						};
					}
					if (prior.state === "complete" && prior.receipt) {
						return (await validPublicationReceipt(prior.attempt, prior.receipt))
							? {
									state: current,
									result: {
										status: "already_published",
										receipt: prior.receipt,
									} as TransientTaskCanonicalWorktreePublicationResultV1,
								}
							: { state: current, result: { status: "invalid" } as const };
					}
					if (prior.state === "outcome_unknown") {
						return {
							state: current,
							result: {
								status: "worktree_publication_outcome_unknown",
							} as TransientTaskCanonicalWorktreePublicationResultV1,
						};
					}
					return { state: current, result: null };
				}
				const attempt: TransientPublicationRecordV1 = {
					attempt: effect.attempt,
					state: "not_applied",
					receipt: null,
				};
				const next: TransientWorkspaceRecordV1 = {
					...current,
					publications: { ...current.publications, [request.worktreePublicationId]: attempt },
				};
				return { state: next, result: null };
			},
		);
		if (preflight) return preflight;
		if (!(await this.#authority.authorizeTransientCleanup(request.cleanup))) return { status: "cleanup_lost" };
		const armed = await this.#durable.transact(
			"transient-canonical-workspace",
			`${request.taskId}\u0000${request.runId}`,
			currentInput => {
				const current = transientState(currentInput);
				const prior = current?.publications[request.worktreePublicationId];
				if (!current || !prior || !samePublicationAttempt(prior.attempt, effect.attempt)) {
					return { state: current, result: false };
				}
				if (prior.state !== "not_applied") return { state: current, result: false };
				const next: TransientWorkspaceRecordV1 = {
					...current,
					publications: {
						...current.publications,
						[request.worktreePublicationId]: { ...prior, state: "outcome_unknown" },
					},
				};
				return { state: next, result: true };
			},
		);
		if (!armed) return { status: "worktree_publication_outcome_unknown" };
		if (!(await this.#authority.authorizeTransientCleanup(request.cleanup))) return { status: "cleanup_lost" };
		let receipt: TransientTaskWorktreePublicationReceiptV1;
		try {
			receipt = await this.#publication.publish(effect);
		} catch {
			return { status: "worktree_publication_outcome_unknown" };
		}
		return this.#completePublication(effect, receipt, "published");
	}

	async #completePublication(
		effect: TransientTaskCanonicalWorktreePublicationEffectV1,
		receipt: TransientTaskWorktreePublicationReceiptV1,
		status: "published" | "already_published",
	): Promise<TransientTaskCanonicalWorktreePublicationResultV1> {
		const request = effect.attempt.request;
		if (!(await validPublicationReceipt(effect.attempt, receipt))) return { status: "invalid" };
		return this.#durable.transact(
			"transient-canonical-workspace",
			`${request.taskId}\u0000${request.runId}`,
			currentInput => {
				const current = transientState(currentInput);
				const prior = current?.publications[request.worktreePublicationId];
				if (
					!current ||
					!prior ||
					!samePublicationAttempt(prior.attempt, effect.attempt) ||
					!checkpointMatches(current.workspace.checkpoint, request.checkpoint)
				) {
					return { state: current, result: { status: "invalid" } as const };
				}
				if (prior.state === "complete" && prior.receipt) {
					return prior.receipt.receiptSha256 === receipt.receiptSha256 &&
						JSON.stringify(prior.receipt) === JSON.stringify(receipt)
						? { state: current, result: { status: "already_published", receipt: prior.receipt } as const }
						: { state: current, result: { status: "publication_identity_conflict" } as const };
				}
				if (prior.state !== "outcome_unknown" || prior.receipt !== null) {
					return { state: current, result: { status: "publication_identity_conflict" } as const };
				}
				const next: TransientWorkspaceRecordV1 = {
					...current,
					publications: {
						...current.publications,
						[request.worktreePublicationId]: { ...prior, state: "complete", receipt },
					},
				};
				return { state: next, result: { status, receipt } };
			},
		);
	}

	async inspectWorktreePublication(
		request: TransientTaskCanonicalWorktreePublicationInspectRequestV1,
	): Promise<TransientTaskCanonicalWorktreePublicationInspectResultV1> {
		if (!(await validPublicationInspectRequest(request))) return { status: "invalid" };
		const current = transientState(
			await this.#durable.inspect("transient-canonical-workspace", `${request.taskId}\u0000${request.runId}`),
		);
		const publication = current?.publications[request.worktreePublicationId];
		if (!publication) return { status: "absent", worktreePublicationId: request.worktreePublicationId };
		const stored = publication.attempt.request;
		if (
			publication.attempt.attemptSha256 !== request.publicationAttemptSha256 ||
			stored.requestSha256 !== request.publicationRequestSha256 ||
			stored.publicationClaim.claimSha256 !== request.publicationClaimSha256 ||
			stored.cleanupId !== request.cleanupId ||
			stored.cleanupAuthorityId !== request.cleanupAuthorityId ||
			JSON.stringify(stored.publicationTargetKey) !== JSON.stringify(request.publicationTargetKey)
		) {
			return { status: "publication_identity_conflict" };
		}
		if (publication.state === "complete" && publication.receipt) {
			return (await validPublicationReceipt(publication.attempt, publication.receipt))
				? { status: "complete", receipt: publication.receipt }
				: { status: "invalid" };
		}
		return {
			status: "outcome_unknown",
			worktreePublicationId: request.worktreePublicationId,
			publicationClaimSha256: request.publicationClaimSha256,
			publicationRequestSha256: request.publicationRequestSha256,
			publicationAttemptSha256: request.publicationAttemptSha256,
		};
	}

	async adoptWorktreePublication(
		request: ConfidentialTransientTaskCanonicalWorktreePublicationAdoptRequestV1,
	): Promise<ConfidentialTransientTaskCanonicalWorktreePublicationAdoptResultV1> {
		if (!(await validPublicationInspectRequest(request))) return { status: "invalid" };
		if (
			request.cleanupAuthority.taskId !== request.taskId ||
			request.cleanupAuthority.runId !== request.runId ||
			request.cleanupAuthority.cleanupId !== request.cleanupId ||
			request.cleanupAuthority.cleanupAuthorityId !== request.cleanupAuthorityId
		)
			return { status: "conflict" };
		if (!(await this.#authority.authorizeTransientCleanup(request.cleanupAuthority)))
			return { status: "authority_lost" };
		const current = transientState(
			await this.#durable.inspect("transient-canonical-workspace", `${request.taskId}\u0000${request.runId}`),
		);
		const publication = current?.publications[request.worktreePublicationId];
		if (!publication) return { status: "absent" };
		const stored = publication.attempt.request;
		if (
			publication.attempt.attemptSha256 !== request.publicationAttemptSha256 ||
			stored.requestSha256 !== request.publicationRequestSha256 ||
			stored.publicationClaim.claimSha256 !== request.publicationClaimSha256 ||
			stored.cleanupId !== request.cleanupId ||
			stored.cleanupAuthorityId !== request.cleanupAuthorityId ||
			stored.bindingAuthoritySha256 !== request.bindingAuthoritySha256 ||
			JSON.stringify(stored.publicationTargetKey) !== JSON.stringify(request.publicationTargetKey)
		)
			return { status: "conflict" };
		if (publication.state === "complete" && publication.receipt) {
			return (await validPublicationReceipt(publication.attempt, publication.receipt))
				? { status: "matching", attempt: publication.attempt, receipt: publication.receipt }
				: { status: "invalid" };
		}
		const claim = publication.attempt.publicationClaim;
		const opened = await this.#bindingStore.open({
			purpose: "worktree_publication",
			access: "live",
			key: claim.key,
			isolationCleanupId: claim.isolationCleanupId,
			worktreePublicationId: claim.worktreePublicationId,
			openOperationId: claim.openOperationId,
			expectedBindingRevision: claim.bindingRevision,
			expectedRenewalSequence: claim.renewalSequence,
			expectedReceiptSha256: claim.bindingReceiptSha256,
			authority: request.bindingAuthority,
			authoritySha256: request.bindingAuthoritySha256,
			openRequestSha256: claim.bindingOpenRequestSha256,
		});
		if (opened.status !== "opened" && opened.status !== "already_opened") return { status: "conflict" };
		const effect: TransientTaskCanonicalWorktreePublicationEffectV1 = {
			attempt: publication.attempt,
			publicationTarget: opened.target as TransientTaskWorktreePublicationTargetHandleV1,
		};
		if (!(await validPublicationAttempt(effect))) return { status: "invalid" };
		if (!(await this.#authority.authorizeTransientCleanup(request.cleanupAuthority)))
			return { status: "authority_lost" };
		let inspection:
			| TransientTaskWorktreePublicationReceiptV1
			| TransientTaskCanonicalWorktreePublicationNotAppliedReceiptV1;
		try {
			inspection = await this.#publication.inspect(effect);
		} catch {
			return { status: "outcome_unknown", attempt: publication.attempt };
		}
		if ("publishedAt" in inspection) {
			if (!(await validPublicationReceipt(publication.attempt, inspection))) return { status: "invalid" };
			const completed = await this.#completePublication(effect, inspection, "already_published");
			return "receipt" in completed
				? { status: "matching", attempt: publication.attempt, receipt: completed.receipt }
				: { status: "conflict" };
		}
		if (!(await validPublicationNotApplied(publication.attempt, inspection))) return { status: "invalid" };
		const restored = await this.#durable.transact(
			"transient-canonical-workspace",
			`${request.taskId}\u0000${request.runId}`,
			currentInput => {
				const latest = transientState(currentInput);
				const prior = latest?.publications[request.worktreePublicationId];
				if (
					!latest ||
					!prior ||
					!samePublicationAttempt(prior.attempt, publication.attempt) ||
					prior.state === "complete"
				)
					return { state: latest, result: false };
				const next: TransientWorkspaceRecordV1 = {
					...latest,
					publications: {
						...latest.publications,
						[request.worktreePublicationId]: { ...prior, state: "not_applied", receipt: null },
					},
				};
				return { state: next, result: true };
			},
		);
		if (!restored) return { status: "conflict" };
		return {
			status: "not_applied",
			attempt: publication.attempt,
			proof: inspection,
			publicationTarget: effect.publicationTarget,
		};
	}

	async discard(request: TransientTaskCanonicalDiscardRequestV1): Promise<TransientTaskCanonicalDiscardResultV1> {
		if (!validTransientCleanupRequest(request)) return { status: "invalid" };
		if (!(await this.#authority.authorizeTransientCleanup(request.cleanup))) return { status: "cleanup_lost" };
		return this.#durable.transact(
			"transient-canonical-workspace",
			`${request.taskId}\u0000${request.runId}`,
			async currentInput => {
				const current = transientState(currentInput);
				if (!current) return { state: null, result: { status: "invalid" } as const };
				if (current.discard) {
					if (!(await validCanonicalDiscardReceipt(current.discard)))
						return { state: current, result: { status: "invalid" } as const };
					const matches =
						current.discard.taskId === request.taskId &&
						current.discard.runId === request.runId &&
						current.discard.workspaceId === request.workspaceId &&
						current.discard.cleanupId === request.cleanupId &&
						current.discard.cleanupAuthorityId === request.cleanupAuthorityId &&
						current.discard.canonicalDiscardId === request.canonicalDiscardId &&
						current.discard.cleanupPlanSha256 === request.cleanupPlanSha256 &&
						checkpointMatches(current.discard.finalCheckpoint, request.finalCheckpoint);
					return matches
						? { state: current, result: { status: "already_discarded", receipt: current.discard } as const }
						: { state: current, result: { status: "discard_identity_conflict" } as const };
				}
				if (
					current.workspace.checkpoint.generation !== request.expectedGeneration ||
					current.workspace.checkpoint.rootSha256 !== request.expectedRootSha256 ||
					!checkpointMatches(current.workspace.checkpoint, request.finalCheckpoint)
				) {
					return { state: current, result: { status: "generation_conflict" } as const };
				}
				const discardedAt = this.#now();
				const receipt: Omit<TransientTaskCanonicalDiscardReceiptV1, "receiptSha256"> = {
					schemaVersion: 1,
					taskId: request.taskId,
					runId: request.runId,
					workspaceId: request.workspaceId,
					cleanupId: request.cleanupId,
					cleanupAuthorityId: request.cleanupAuthorityId,
					canonicalDiscardId: request.canonicalDiscardId,
					finalCheckpoint: request.finalCheckpoint,
					cleanupPlanSha256: request.cleanupPlanSha256,
					discardedAt,
				};
				const completeReceipt: TransientTaskCanonicalDiscardReceiptV1 = {
					...receipt,
					receiptSha256: `sha256:${await canonicalRuntimeSha256(canonicalDiscardReceiptTuple(receipt))}`,
				};
				return {
					state: { ...current, discard: completeReceipt },
					result: { status: "discarded", receipt: completeReceipt } as const,
				};
			},
		);
	}

	async inspectCleanup(
		request: TransientTaskCanonicalCleanupInspectRequestV1,
	): Promise<TransientTaskCanonicalCleanupInspectResultV1> {
		if (!validTransientCleanupRequest(request)) return { status: "invalid" };
		if (!(await this.#authority.authorizeTransientCleanup(request.cleanup))) return { status: "cleanup_lost" };
		const current = transientState(
			await this.#durable.inspect("transient-canonical-workspace", `${request.taskId}\u0000${request.runId}`),
		);
		if (!current) return { status: "absent" };
		if (current.discard) {
			if (!(await validCanonicalDiscardReceipt(current.discard))) return { status: "invalid" };
			return current.discard.taskId === request.taskId &&
				current.discard.runId === request.runId &&
				current.discard.workspaceId === request.workspaceId &&
				current.discard.cleanupId === request.cleanupId &&
				current.discard.cleanupAuthorityId === request.cleanupAuthorityId &&
				current.discard.canonicalDiscardId === request.canonicalDiscardId &&
				current.discard.cleanupPlanSha256 === request.cleanupPlanSha256 &&
				current.discard.finalCheckpoint.generation === request.expectedGeneration &&
				current.discard.finalCheckpoint.rootSha256 === request.expectedRootSha256
				? { status: "discarded", receipt: current.discard }
				: { status: "conflict" };
		}
		return current.workspace.workspaceId === request.workspaceId &&
			current.workspace.checkpoint.generation === request.expectedGeneration &&
			current.workspace.checkpoint.rootSha256 === request.expectedRootSha256
			? { status: "present", workspace: current.workspace }
			: { status: "conflict" };
	}
}
