import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getWorktreeDir } from "@oh-my-pi/pi-utils";
import type { ISO8601, Sha256Ref } from "../registry/persistent-agent-contracts";
import type {
	CanonicalRuntimeValue,
	ConfidentialTransientTaskCaptureBranchMaterializationPlanV1,
	ConfidentialTransientTaskCaptureMaterializationStoreV1,
	ConfidentialTransientTaskCaptureObjectImportRequestV1,
	ConfidentialTransientTaskCaptureRefCompareAndSwapRequestV1,
	ConfidentialTransientTaskCaptureRepositoryHandleV1,
	ConfidentialTransientTaskCaptureRepositoryOpenRequestV1,
	ConfidentialTransientTaskCaptureRepositoryOpenResultV1,
	ConfidentialTransientTaskCaptureRepositoryResolverV1,
	ConfidentialTransientTaskEnsureIsolationRequestV1,
	ConfidentialTransientTaskEnsureIsolationResultV1,
	ConfidentialTransientTaskGitCaptureRefCompareAndSwapInvocationV1,
	ConfidentialTransientTaskGitCaptureRefDeleteInvocationV1,
	ConfidentialTransientTaskGitObjectImportInvocationV1,
	ConfidentialTransientTaskIsolationCleanupEffectV1,
	ConfidentialTransientTaskIsolationCleanupComponentRequestV1,
	ConfidentialTransientTaskIsolationCleanupRequestV1,
	ConfidentialTransientTaskIsolationCreatorDescriptorV1,
	ConfidentialTransientTaskIsolationOwnerLivenessEvidenceV1,
	ConfidentialTransientTaskIsolationOwnerProcessIdentityProbeV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1,
	ConfidentialTransientTaskIsolationOwnershipClaimNotAppliedProofV1,
	ConfidentialTransientTaskIsolationOwnershipClaimV1,
	ConfidentialTransientTaskPostTerminalStoreV1,
	TransientTaskCaptureMaterializationInspectResultV1,
	TransientTaskCleanupAuthorityProofV1,
	TransientTaskControllerAuthorityProofV1,
	TransientTaskGitObjectFormatV1,
	TransientTaskIsolationCleanupHandleV1,
	TransientTaskIsolationCleanupInspectRequestV1,
	TransientTaskIsolationCleanupResultV1,
	TransientTaskIsolationOwnershipClaimEffectInspectRequestV1,
	TransientTaskIsolationOwnershipClaimEffectV1,
} from "../session/workspace-runtime-contracts";
import { canonicalRuntimeSha256 } from "../session/workspace-runtime-contracts";

const TASK_ISOLATION_MOUNT_DIR = "m";

/** Captured nested-repository patch retained by the canonical SingleResult shape. */
export interface NestedRepoPatch {
	readonly relativePath: string;
	readonly patch: string;
}

export interface TransientTaskIsolationPhysicalIdentityV1 {
	readonly namespaceSha256: string;
	readonly directorySegment: string;
	readonly baseDir: string;
	readonly mergedDir: string;
	readonly ownershipClaimPath: string;
	readonly captureBranchRef: string;
}

/** Derive physical isolation only from the immutable task/run/create identity. */
export async function deriveTransientTaskIsolationPhysicalIdentityV1(input: {
	readonly taskId: string;
	readonly runId: string;
	readonly createId: string;
}): Promise<TransientTaskIsolationPhysicalIdentityV1> {
	const namespaceSha256 = await canonicalRuntimeSha256([
		"omp-transient-task-isolation-namespace-v1",
		1,
		input.taskId,
		input.runId,
		input.createId,
	]);
	const directorySegment = `t1-${namespaceSha256}`;
	const baseDir = getWorktreeDir(directorySegment);
	return Object.freeze({
		namespaceSha256,
		directorySegment,
		baseDir,
		mergedDir: path.join(baseDir, TASK_ISOLATION_MOUNT_DIR),
		ownershipClaimPath: `${baseDir}.owner-v1`,
		captureBranchRef: `refs/heads/omp/task/v1/${namespaceSha256}`,
	});
}

/** Pre-bound physical materializer; it receives no presentation identity or ambient lookup authority. */
export interface ConfidentialTransientTaskIsolationMaterializerV1 {
	ensureIsolation(
		request: ConfidentialTransientTaskEnsureIsolationRequestV1,
	): Promise<ConfidentialTransientTaskEnsureIsolationResultV1>;
}

/** Accept only the stored claim-current creator preparation and its exact derived locators. */
export async function ensureIsolation(
	request: ConfidentialTransientTaskEnsureIsolationRequestV1,
	materializer: ConfidentialTransientTaskIsolationMaterializerV1,
): Promise<ConfidentialTransientTaskEnsureIsolationResultV1> {
	const preparation = request.preparation;
	if (preparation.state !== "claim_current") {
		return { status: "invalid", code: "ownership_claim_not_current" };
	}
	const descriptor = preparation.creatorDescriptor;
	const controller = request.controller;
	if (
		descriptor.taskId !== controller.taskId ||
		descriptor.runId !== controller.runId ||
		descriptor.createId !== controller.createId ||
		descriptor.ownerManifestSha256 !== preparation.ownershipClaim.ownerManifestSha256 ||
		preparation.ownershipClaim.claimSha256 !== preparation.ownershipClaimReceipt.currentClaimSha256
	) {
		return { status: "invalid", code: "record_invariant_violation" };
	}
	const identity = await deriveTransientTaskIsolationPhysicalIdentityV1(descriptor);
	if (
		descriptor.namespaceSha256 !== identity.namespaceSha256 ||
		descriptor.directorySegment !== identity.directorySegment ||
		descriptor.baseDir !== identity.baseDir ||
		descriptor.mergedDir !== identity.mergedDir ||
		descriptor.ownershipClaimPath !== identity.ownershipClaimPath ||
		descriptor.captureBranchRef !== identity.captureBranchRef
	) {
		return { status: "invalid", code: "record_invariant_violation" };
	}
	return materializer.ensureIsolation(request);
}

function zeroObjectId(objectFormat: TransientTaskGitObjectFormatV1): string {
	return "0".repeat(objectFormat === "sha1" ? 40 : 64);
}

/** Build the object-only import invocation from the already-durable exact request. */
export function createTransientTaskCaptureObjectImportInvocationV1(
	repository: ConfidentialTransientTaskCaptureRepositoryHandleV1,
	request: ConfidentialTransientTaskCaptureObjectImportRequestV1,
): ConfidentialTransientTaskGitObjectImportInvocationV1 {
	return Object.freeze({
		repository,
		storeDispatchState: "outcome_unknown",
		command: request.command,
		expected: Object.freeze({
			objectFormat: request.objectFormat,
			objectType: request.object.objectType,
			expectedObjectSha: request.object.expectedObjectSha,
			objectBodyBytesBase64: request.object.objectBodyBytesBase64,
			objectBodyByteLength: request.object.objectBodyByteLength,
			objectBodySha256: request.object.objectBodySha256,
		}),
	});
}

/** Map a durable capture request without treating an all-zero old value as an object ID. */
export function createTransientTaskCaptureRefCompareAndSwapInvocationV1(
	repository: ConfidentialTransientTaskCaptureRepositoryHandleV1,
	request: ConfidentialTransientTaskCaptureRefCompareAndSwapRequestV1,
): ConfidentialTransientTaskGitCaptureRefCompareAndSwapInvocationV1 {
	const absentObjectId = zeroObjectId(request.objectFormat);
	if (
		request.expectedNewCaptureRefSha === absentObjectId ||
		request.command[2] !== request.captureBranchRef ||
		request.command[3] !== request.expectedNewCaptureRefSha ||
		request.command[4] !== request.expectedOldCaptureRefSha
	) {
		throw new TypeError("Invalid durable capture-ref compare-and-swap request");
	}
	return Object.freeze({
		repository,
		storeDispatchState: "outcome_unknown",
		command: request.command,
		expected: Object.freeze({
			objectFormat: request.objectFormat,
			refName: request.captureBranchRef,
			expectedOld:
				request.expectedOldCaptureRefSha === absentObjectId
					? Object.freeze({ state: "absent" as const })
					: Object.freeze({ state: "present" as const, objectId: request.expectedOldCaptureRefSha }),
			expectedNew: Object.freeze({ state: "present" as const, objectId: request.expectedNewCaptureRefSha }),
		}),
	});
}

/** Map the ordered cleanup component to a CAS delete whose expected-new state is absence. */
export function createTransientTaskCaptureRefDeleteInvocationV1(
	repository: TransientTaskIsolationCleanupHandleV1,
	objectFormat: TransientTaskGitObjectFormatV1,
	request: Extract<
		ConfidentialTransientTaskIsolationCleanupComponentRequestV1,
		{ readonly component: "capture_ref_cas_delete" }
	>,
): ConfidentialTransientTaskGitCaptureRefDeleteInvocationV1 {
	if (request.expectedOldCaptureRefSha === zeroObjectId(objectFormat)) {
		throw new TypeError("Capture-ref cleanup requires a present expected-old object ID");
	}
	return Object.freeze({
		repository,
		storeDispatchState: "component_outcome_unknown",
		command: Object.freeze([
			"git",
			"update-ref",
			"-d",
			request.captureBranchRef,
			request.expectedOldCaptureRefSha,
		] as const),
		expected: Object.freeze({
			objectFormat,
			refName: request.captureBranchRef,
			expectedOld: Object.freeze({ state: "present" as const, objectId: request.expectedOldCaptureRefSha }),
			expectedNew: Object.freeze({ state: "absent" as const }),
		}),
	});
}

/** Open only the exact durable capture sink; no cwd, search, or fallback is accepted. */
export async function openTransientTaskCaptureRepositoryV1(
	resolver: ConfidentialTransientTaskCaptureRepositoryResolverV1,
	request: ConfidentialTransientTaskCaptureRepositoryOpenRequestV1,
): Promise<ConfidentialTransientTaskCaptureRepositoryOpenResultV1> {
	return resolver.openCaptureRepository(request);
}

/** Execute the frozen object-import prefix and sole ref CAS through the durable store. */
export async function materializeTransientTaskCaptureBranchV1(
	store: ConfidentialTransientTaskCaptureMaterializationStoreV1,
	repository: ConfidentialTransientTaskCaptureRepositoryHandleV1,
	authority: TransientTaskCleanupAuthorityProofV1,
	plan: ConfidentialTransientTaskCaptureBranchMaterializationPlanV1,
): Promise<readonly TransientTaskCaptureMaterializationInspectResultV1[]> {
	const results: TransientTaskCaptureMaterializationInspectResultV1[] = [];
	for (const effect of plan.objectImports) {
		const result = await store.runEffect({ effect, repository, authority });
		results.push(result);
		if (result.status !== "applied" && result.status !== "already_applied") return Object.freeze(results);
	}
	results.push(await store.runEffect({ effect: plan.captureRefCompareAndSwap, repository, authority }));
	return Object.freeze(results);
}

function isolationCleanupInspectRequest(
	request: ConfidentialTransientTaskIsolationCleanupRequestV1,
): TransientTaskIsolationCleanupInspectRequestV1 {
	const plan = request.plan;
	return {
		schemaVersion: 1,
		taskId: plan.taskId,
		runId: plan.runId,
		isolationCleanupId: plan.isolationCleanupId,
		planSha256: plan.planSha256,
		cleanupRequestSha256: request.cleanupRequestSha256,
		cleanupClaimSha256: plan.cleanupClaim.claimSha256,
		cleanupDescriptorSha256: plan.cleanupDescriptorSha256,
		isolationNamespaceSha256: plan.isolationNamespaceSha256,
		isolationOwnerManifestSha256: plan.isolationOwnerManifestSha256,
		isolationCreatorDescriptorSha256: plan.isolationCreatorDescriptorSha256,
	};
}

async function adoptIsolationCleanup(
	store: ConfidentialTransientTaskPostTerminalStoreV1,
	request: ConfidentialTransientTaskIsolationCleanupRequestV1,
) {
	const inspectRequest = isolationCleanupInspectRequest(request);
	const inspection = await store.inspectIsolationCleanup(inspectRequest);
	switch (inspection.status) {
		case "absent":
			return null;
		case "conflict":
		case "invalid":
			return inspection;
		case "in_progress":
		case "matching":
			return store.adoptIsolationCleanup({
				...inspectRequest,
				expectedInspectionSha256: inspection.inspectionSha256,
				expectedCleanupAttemptSha256: inspection.cleanupAttemptSha256,
				expectedStatus: inspection.status,
				expectedProgressSha256: inspection.status === "in_progress" ? inspection.progressSha256 : null,
				expectedReceiptSha256: inspection.status === "matching" ? inspection.receiptSha256 : null,
				authority: request.authority,
				expectedPostTerminalRevision: request.expectedPostTerminalRevision,
			});
	}
}

async function dispatchIsolationCleanup(
	store: ConfidentialTransientTaskPostTerminalStoreV1,
	effect: ConfidentialTransientTaskIsolationCleanupEffectV1,
): Promise<TransientTaskIsolationCleanupResultV1> {
	try {
		return await store.cleanupIsolation(effect);
	} catch (dispatchError) {
		try {
			const adopted = await adoptIsolationCleanup(store, effect.request);
			if (adopted?.status === "matching") return { status: "already_cleaned", receipt: adopted.receipt };
			if (adopted?.status === "in_progress") return { status: "in_progress", progress: adopted.progress };
			if (adopted?.status === "conflict" || adopted?.status === "invalid") {
				return { status: adopted.status, code: "record_invariant_violation" };
			}
		} catch {
			// Preserve the dispatch failure when the recovery store itself is unavailable.
		}
		throw dispatchError;
	}
}

/** Resume the exact durable aggregate attempt; only a proven absent row may start it. */
export async function cleanupIsolation(
	store: ConfidentialTransientTaskPostTerminalStoreV1,
	effect: ConfidentialTransientTaskIsolationCleanupEffectV1,
): Promise<TransientTaskIsolationCleanupResultV1> {
	const adopted = await adoptIsolationCleanup(store, effect.request);
	if (adopted === null) return dispatchIsolationCleanup(store, effect);
	if (adopted.status === "matching") return { status: "already_cleaned", receipt: adopted.receipt };
	if (adopted.status === "in_progress") {
		return dispatchIsolationCleanup(store, {
			request: adopted.attempt.request,
			cleanupTarget: adopted.cleanupTarget,
		});
	}
	if (adopted.status === "conflict" || adopted.status === "invalid") {
		return { status: adopted.status, code: "record_invariant_violation" };
	}
	return { status: "conflict", code: "record_invariant_violation" };
}

const CLAIM_SHA256_REF = /^sha256:[0-9a-f]{64}$/;

function strictClaimRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length !== 0)
		return undefined;
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return undefined;
	for (const key of actual) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return undefined;
	}
	return value as Record<string, unknown>;
}

function validClaimIdentity(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function validClaimIso8601(value: unknown): value is ISO8601 {
	if (typeof value !== "string") return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

async function claimTupleRef(tuple: readonly CanonicalRuntimeValue[]): Promise<Sha256Ref> {
	return `sha256:${await canonicalRuntimeSha256(tuple)}` as Sha256Ref;
}

function claimControllerProofTuple(proof: TransientTaskControllerAuthorityProofV1): readonly CanonicalRuntimeValue[] {
	return [
		1,
		proof.taskId,
		proof.runId,
		proof.createId,
		proof.controllerId,
		proof.workspaceId,
		proof.controlHostId,
		proof.controllerEpoch,
		proof.fencingGeneration,
	];
}

function claimOwnershipTuple(
	claim: ConfidentialTransientTaskIsolationOwnershipClaimV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-isolation-claim-v1",
		1,
		claim.ownerManifestSha256,
		claim.claimOperationId,
		claim.claimantInstanceId,
		claim.controlHostId,
		claim.pid,
		claim.processStartToken,
		claim.claimedAt,
	];
}

async function claimOwnerManifestTuple(
	descriptor: ConfidentialTransientTaskIsolationCreatorDescriptorV1,
): Promise<readonly CanonicalRuntimeValue[]> {
	const identity = await deriveTransientTaskIsolationPhysicalIdentityV1(descriptor);
	return [
		"omp-transient-task-isolation-owner-v1",
		1,
		["omp-transient-task-isolation-namespace-v1", 1, descriptor.taskId, descriptor.runId, descriptor.createId],
		identity.namespaceSha256,
		descriptor.effectIdentityManifestSha256,
		[
			"omp-transient-task-publication-target-v1",
			"key",
			1,
			descriptor.taskId,
			descriptor.runId,
			descriptor.createId,
			descriptor.publicationTargetId,
		],
		descriptor.worktreePublicationId,
		descriptor.isolationCleanupId,
		descriptor.bindingOperationId,
		descriptor.ownershipClaimCreateOperationId,
		descriptor.directorySegment,
		descriptor.captureBranchRef,
	];
}

async function claimCreatorDescriptorTuple(
	descriptor: ConfidentialTransientTaskIsolationCreatorDescriptorV1,
): Promise<readonly CanonicalRuntimeValue[]> {
	return [
		"omp-transient-task-isolation-creator-v1",
		1,
		await claimOwnerManifestTuple(descriptor),
		descriptor.baseDir,
		descriptor.mergedDir,
		descriptor.ownershipClaimPath,
	];
}

function claimLivenessEvidenceTuple(
	evidence: ConfidentialTransientTaskIsolationOwnerLivenessEvidenceV1,
): readonly CanonicalRuntimeValue[] {
	return [
		"omp-transient-task-isolation-owner-liveness-v1",
		"evidence",
		1,
		evidence.taskId,
		evidence.runId,
		evidence.createId,
		evidence.effectOperationId,
		evidence.creatorDescriptorSha256,
		evidence.requestSha256,
		evidence.attemptSha256,
		claimOwnershipTuple(evidence.observedClaim),
		evidence.probingControlHostId,
		evidence.verdict,
		evidence.basis,
	];
}

async function claimRequestTuple(
	request: ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1,
): Promise<readonly CanonicalRuntimeValue[]> {
	const prefix: CanonicalRuntimeValue[] = [
		"omp-transient-task-isolation-claim-effect-v1",
		"request",
		1,
		request.taskId,
		request.runId,
		request.createId,
		request.operation,
		request.effectOperationId,
		await claimCreatorDescriptorTuple(request.creatorDescriptor),
		claimControllerProofTuple(request.controller),
		request.authoritySha256,
		request.requestedAt,
	];
	if (request.operation === "exclusive_create")
		return [...prefix, null, claimOwnershipTuple(request.nextClaim), true, true, false];
	if (request.operation === "stale_same_owner_cas_adopt")
		return [
			...prefix,
			[claimLivenessEvidenceTuple(request.staleOwnerEvidence), request.staleOwnerEvidence.evidenceSha256],
			claimOwnershipTuple(request.expectedClaim),
			claimOwnershipTuple(request.nextClaim),
			true,
			true,
		];
	return [...prefix, claimOwnershipTuple(request.expectedClaim), null, true, true, request.reason];
}

async function claimAttemptTuple(
	attempt: ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1,
): Promise<readonly CanonicalRuntimeValue[]> {
	return [
		"omp-transient-task-isolation-claim-effect-v1",
		"attempt",
		1,
		attempt.state,
		await claimRequestTuple(attempt.request),
		attempt.openedAt,
	];
}

async function claimReceiptTuple(
	receipt: ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1,
): Promise<readonly CanonicalRuntimeValue[]> {
	const prefix: CanonicalRuntimeValue[] = [
		"omp-transient-task-isolation-claim-effect-v1",
		"receipt",
		1,
		receipt.taskId,
		receipt.runId,
		receipt.createId,
		receipt.effectOperationId,
		receipt.operation,
		receipt.outcome,
		receipt.requestSha256,
		receipt.attemptSha256,
		receipt.authoritySha256,
		receipt.previousClaimSha256,
	];
	return receipt.operation === "pre_bind_cas_release"
		? [...prefix, null, null, receipt.completedAt, receipt.reason]
		: [...prefix, claimOwnershipTuple(receipt.claim), receipt.currentClaimSha256, receipt.completedAt];
}

async function validateClaimDescriptor(
	descriptor: ConfidentialTransientTaskIsolationCreatorDescriptorV1,
): Promise<boolean> {
	if (
		!strictClaimRecord(descriptor, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"publicationTargetId",
			"worktreePublicationId",
			"isolationCleanupId",
			"bindingOperationId",
			"ownershipClaimCreateOperationId",
			"effectIdentityManifestSha256",
			"namespaceSha256",
			"directorySegment",
			"baseDir",
			"mergedDir",
			"ownershipClaimPath",
			"captureBranchRef",
			"ownerManifestSha256",
			"creatorDescriptorSha256",
		]) ||
		descriptor.schemaVersion !== 1 ||
		![
			descriptor.taskId,
			descriptor.runId,
			descriptor.createId,
			descriptor.publicationTargetId,
			descriptor.worktreePublicationId,
			descriptor.isolationCleanupId,
			descriptor.bindingOperationId,
			descriptor.ownershipClaimCreateOperationId,
		].every(validClaimIdentity) ||
		![
			descriptor.effectIdentityManifestSha256,
			descriptor.ownerManifestSha256,
			descriptor.creatorDescriptorSha256,
		].every(value => CLAIM_SHA256_REF.test(value))
	)
		return false;
	const identity = await deriveTransientTaskIsolationPhysicalIdentityV1(descriptor);
	return (
		descriptor.namespaceSha256 === identity.namespaceSha256 &&
		descriptor.directorySegment === identity.directorySegment &&
		descriptor.baseDir === identity.baseDir &&
		descriptor.mergedDir === identity.mergedDir &&
		descriptor.ownershipClaimPath === identity.ownershipClaimPath &&
		descriptor.captureBranchRef === identity.captureBranchRef &&
		descriptor.ownerManifestSha256 === (await claimTupleRef(await claimOwnerManifestTuple(descriptor))) &&
		descriptor.creatorDescriptorSha256 === (await claimTupleRef(await claimCreatorDescriptorTuple(descriptor)))
	);
}

async function validateClaimValue(claim: ConfidentialTransientTaskIsolationOwnershipClaimV1): Promise<boolean> {
	return Boolean(
		strictClaimRecord(claim, [
			"schemaVersion",
			"ownerManifestSha256",
			"claimOperationId",
			"claimantInstanceId",
			"controlHostId",
			"pid",
			"processStartToken",
			"claimedAt",
			"claimSha256",
		]) &&
			claim.schemaVersion === 1 &&
			CLAIM_SHA256_REF.test(claim.ownerManifestSha256) &&
			CLAIM_SHA256_REF.test(claim.claimSha256) &&
			[claim.claimOperationId, claim.claimantInstanceId, claim.controlHostId].every(validClaimIdentity) &&
			Number.isSafeInteger(claim.pid) &&
			claim.pid > 0 &&
			(claim.processStartToken === null || validClaimIdentity(claim.processStartToken)) &&
			validClaimIso8601(claim.claimedAt) &&
			claim.claimSha256 === (await claimTupleRef(claimOwnershipTuple(claim))),
	);
}

function sameClaimValue(
	left: ConfidentialTransientTaskIsolationOwnershipClaimV1,
	right: ConfidentialTransientTaskIsolationOwnershipClaimV1,
): boolean {
	return (
		left.claimSha256 === right.claimSha256 &&
		JSON.stringify(claimOwnershipTuple(left)) === JSON.stringify(claimOwnershipTuple(right))
	);
}

function canonicalClaimBytes(claim: ConfidentialTransientTaskIsolationOwnershipClaimV1): Buffer {
	return Buffer.from(
		JSON.stringify({
			schemaVersion: claim.schemaVersion,
			ownerManifestSha256: claim.ownerManifestSha256,
			claimOperationId: claim.claimOperationId,
			claimantInstanceId: claim.claimantInstanceId,
			controlHostId: claim.controlHostId,
			pid: claim.pid,
			processStartToken: claim.processStartToken,
			claimedAt: claim.claimedAt,
			claimSha256: claim.claimSha256,
		}),
		"utf8",
	);
}

async function validateClaimController(
	controller: TransientTaskControllerAuthorityProofV1,
	descriptor: ConfidentialTransientTaskIsolationCreatorDescriptorV1,
): Promise<boolean> {
	return Boolean(
		strictClaimRecord(controller, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"controllerId",
			"workspaceId",
			"controlHostId",
			"controllerEpoch",
			"fencingGeneration",
		]) &&
			controller.schemaVersion === 1 &&
			controller.taskId === descriptor.taskId &&
			controller.runId === descriptor.runId &&
			controller.createId === descriptor.createId &&
			[controller.controllerId, controller.workspaceId, controller.controlHostId].every(validClaimIdentity) &&
			Number.isSafeInteger(controller.controllerEpoch) &&
			controller.controllerEpoch > 0 &&
			Number.isSafeInteger(controller.fencingGeneration) &&
			controller.fencingGeneration > 0,
	);
}

async function validateClaimStaleEvidence(
	evidence: ConfidentialTransientTaskIsolationOwnerLivenessEvidenceV1,
	request: Extract<
		ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1,
		{ operation: "stale_same_owner_cas_adopt" }
	>,
): Promise<boolean> {
	return Boolean(
		strictClaimRecord(evidence, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"effectOperationId",
			"creatorDescriptorSha256",
			"requestSha256",
			"attemptSha256",
			"observedClaim",
			"probingControlHostId",
			"evidenceSha256",
			"verdict",
			"basis",
		]) &&
			evidence.schemaVersion === 1 &&
			evidence.verdict === "stale" &&
			(evidence.basis === "same_host_pid_absent" || evidence.basis === "same_host_process_start_token_mismatch") &&
			![
				evidence.taskId,
				evidence.runId,
				evidence.createId,
				evidence.effectOperationId,
				evidence.probingControlHostId,
			].some(value => !validClaimIdentity(value)) &&
			[
				evidence.creatorDescriptorSha256,
				evidence.requestSha256,
				evidence.attemptSha256,
				evidence.evidenceSha256,
			].every(value => CLAIM_SHA256_REF.test(value)) &&
			(await validateClaimValue(evidence.observedClaim)) &&
			evidence.taskId === request.taskId &&
			evidence.runId === request.runId &&
			evidence.createId === request.createId &&
			evidence.creatorDescriptorSha256 === request.creatorDescriptor.creatorDescriptorSha256 &&
			evidence.probingControlHostId === request.controller.controlHostId &&
			sameClaimValue(evidence.observedClaim, request.expectedClaim) &&
			evidence.evidenceSha256 === (await claimTupleRef(claimLivenessEvidenceTuple(evidence))),
	);
}

async function validateClaimRequest(
	request: ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1,
): Promise<boolean> {
	if (request === null || typeof request !== "object" || Array.isArray(request) || !("operation" in request))
		return false;
	const keys =
		request.operation === "exclusive_create"
			? [
					"schemaVersion",
					"taskId",
					"runId",
					"createId",
					"operation",
					"effectOperationId",
					"creatorDescriptor",
					"controller",
					"authoritySha256",
					"requestedAt",
					"requestSha256",
					"expectedClaim",
					"nextClaim",
					"exclusive",
					"noFollow",
					"createParentDirectories",
				]
			: request.operation === "stale_same_owner_cas_adopt"
				? [
						"schemaVersion",
						"taskId",
						"runId",
						"createId",
						"operation",
						"effectOperationId",
						"creatorDescriptor",
						"controller",
						"authoritySha256",
						"requestedAt",
						"requestSha256",
						"expectedClaim",
						"staleOwnerEvidence",
						"nextClaim",
						"compareAndSwap",
						"noFollow",
					]
				: request.operation === "pre_bind_cas_release"
					? [
							"schemaVersion",
							"taskId",
							"runId",
							"createId",
							"operation",
							"effectOperationId",
							"creatorDescriptor",
							"controller",
							"authoritySha256",
							"requestedAt",
							"requestSha256",
							"expectedClaim",
							"nextClaim",
							"compareAndSwap",
							"noFollow",
							"reason",
						]
					: null;
	if (
		!keys ||
		!strictClaimRecord(request, keys) ||
		request.schemaVersion !== 1 ||
		![request.taskId, request.runId, request.createId, request.effectOperationId].every(validClaimIdentity) ||
		!CLAIM_SHA256_REF.test(request.authoritySha256) ||
		!CLAIM_SHA256_REF.test(request.requestSha256) ||
		!validClaimIso8601(request.requestedAt) ||
		!(await validateClaimDescriptor(request.creatorDescriptor)) ||
		!(await validateClaimController(request.controller, request.creatorDescriptor)) ||
		request.taskId !== request.creatorDescriptor.taskId ||
		request.runId !== request.creatorDescriptor.runId ||
		request.createId !== request.creatorDescriptor.createId
	)
		return false;
	if (request.operation === "exclusive_create") {
		if (
			request.expectedClaim !== null ||
			request.exclusive !== true ||
			request.noFollow !== true ||
			request.createParentDirectories !== false ||
			!(await validateClaimValue(request.nextClaim)) ||
			request.nextClaim.ownerManifestSha256 !== request.creatorDescriptor.ownerManifestSha256 ||
			request.nextClaim.claimOperationId !== request.effectOperationId ||
			request.nextClaim.controlHostId !== request.controller.controlHostId
		)
			return false;
	} else if (request.operation === "stale_same_owner_cas_adopt") {
		if (
			request.compareAndSwap !== true ||
			request.noFollow !== true ||
			!(await validateClaimValue(request.expectedClaim)) ||
			!(await validateClaimValue(request.nextClaim)) ||
			request.expectedClaim.ownerManifestSha256 !== request.creatorDescriptor.ownerManifestSha256 ||
			request.nextClaim.ownerManifestSha256 !== request.creatorDescriptor.ownerManifestSha256 ||
			request.nextClaim.claimOperationId !== request.effectOperationId ||
			request.nextClaim.controlHostId !== request.controller.controlHostId ||
			!(await validateClaimStaleEvidence(request.staleOwnerEvidence, request))
		)
			return false;
	} else if (
		request.compareAndSwap !== true ||
		request.noFollow !== true ||
		!(await validateClaimValue(request.expectedClaim)) ||
		request.expectedClaim.ownerManifestSha256 !== request.creatorDescriptor.ownerManifestSha256 ||
		request.nextClaim !== null ||
		(request.reason !== "create_aborted" && request.reason !== "isolation_create_failed")
	)
		return false;
	return request.requestSha256 === (await claimTupleRef(await claimRequestTuple(request)));
}

async function validateClaimAttempt(
	attempt: ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1,
): Promise<boolean> {
	return Boolean(
		strictClaimRecord(attempt, ["state", "request", "openedAt", "attemptSha256"]) &&
			(attempt.state === "claim_not_applied" || attempt.state === "claim_outcome_unknown") &&
			validClaimIso8601(attempt.openedAt) &&
			CLAIM_SHA256_REF.test(attempt.attemptSha256) &&
			(await validateClaimRequest(attempt.request)) &&
			attempt.attemptSha256 === (await claimTupleRef(await claimAttemptTuple(attempt))),
	);
}

const CLAIM_HELPER_INPUT_LIMIT = 16 * 1024 * 1024;
const CLAIM_HELPER_OUTPUT_LIMIT = 256 * 1024;
const CLAIM_HELPER_TIMEOUT_MS = 60_000;

async function resolveClaimHelperExecutable(): Promise<string> {
	if (process.platform === "win32") throw new Error("transient_task_authority_platform_unsupported");
	const directories = new Set(
		(process.env.PATH ?? "").split(path.delimiter).filter(directory => path.isAbsolute(directory)),
	);
	directories.add("/usr/local/bin");
	directories.add("/opt/homebrew/bin");
	directories.add("/usr/bin");
	for (const directory of directories) {
		try {
			const executable = await fs.realpath(path.join(directory, "python3"));
			if ((await fs.stat(executable)).isFile()) {
				await fs.access(executable, fsConstants.X_OK);
				return executable;
			}
		} catch {}
	}
	throw new Error("transient_task_authority_helper_unavailable");
}

const CLAIM_AUTHORITY_HELPER_SOURCE = String.raw`
import base64, fcntl, json, os, stat, sys

NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)
CLOEXEC = getattr(os, "O_CLOEXEC", 0)
READ_DIR = os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC
READ_FILE = os.O_RDONLY | NOFOLLOW | CLOEXEC
LOCK_NAME = ".omp-transient-task-isolation-exclusion-v1.lock"
MAX_CLAIM = 64 * 1024
if len(sys.argv) != 3:
    raise SystemExit(2)
INPUT_PATH, OUTPUT_PATH = sys.argv[1:]

def canonical_absolute(value):
    return isinstance(value, str) and value.startswith("/") and "\0" not in value and os.path.normpath(value) == value

def open_absolute_directory(target):
    if not canonical_absolute(target):
        raise ValueError("invalid path")
    current = os.open("/", READ_DIR)
    try:
        for component in [part for part in target.split("/") if part]:
            if component in (".", ".."):
                raise ValueError("invalid component")
            child = os.open(component, READ_DIR, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise

def private_regular(info):
    return stat.S_ISREG(info.st_mode) and not stat.S_IMODE(info.st_mode) & 0o077 and (not hasattr(os, "getuid") or info.st_uid == os.getuid())

def read_all(descriptor, limit):
    chunks = []
    remaining = limit + 1
    while remaining > 0:
        chunk = os.read(descriptor, min(65536, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    value = b"".join(chunks)
    if len(value) > limit:
        raise ValueError("file too large")
    return value

def read_entry(parent, name, limit):
    try:
        expected = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None
    descriptor = os.open(name, READ_FILE, dir_fd=parent)
    try:
        actual = os.fstat(descriptor)
        if not private_regular(actual) or (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
            raise ValueError("unsafe entry")
        content = read_all(descriptor, limit)
        final = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (final.st_dev, final.st_ino) != (actual.st_dev, actual.st_ino):
            raise ValueError("entry changed")
        return content
    finally:
        os.close(descriptor)

def read_absolute_file(target, limit):
    parent_path, name = os.path.split(target)
    if not canonical_absolute(target) or not name or name in (".", ".."):
        raise ValueError("invalid input")
    parent = open_absolute_directory(parent_path)
    try:
        value = read_entry(parent, name, limit)
        if value is None:
            raise FileNotFoundError(target)
        return value
    finally:
        os.close(parent)

def emit(value):
    content = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "strict")
    parent_path, name = os.path.split(OUTPUT_PATH)
    parent = open_absolute_directory(parent_path)
    descriptor = None
    try:
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW | CLOEXEC, 0o600, dir_fd=parent)
        offset = 0
        while offset < len(content):
            offset += os.write(descriptor, content[offset:])
        os.fsync(descriptor)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)

def write_private(parent, name, content):
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW | CLOEXEC, 0o600, dir_fd=parent)
    try:
        offset = 0
        while offset < len(content):
            offset += os.write(descriptor, content[offset:])
        os.fsync(descriptor)
        info = os.fstat(descriptor)
        if not private_regular(info):
            raise ValueError("unsafe created entry")
        return info
    finally:
        os.close(descriptor)

def replace_private(parent, name, content):
    temporary = ".omp-claim-" + os.urandom(12).hex()
    try:
        temporary_info = write_private(parent, temporary, content)
        os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        final = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (final.st_dev, final.st_ino) != (temporary_info.st_dev, temporary_info.st_ino) or read_entry(parent, name, len(content)) != content:
            raise ValueError("replacement changed")
        os.fsync(parent)
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass

def validate_layout(request):
    root_path = request["worktreesRoot"]
    base_path = request["baseDir"]
    merged_path = request["mergedDir"]
    claim_path = request["ownershipClaimPath"]
    segment = request["directorySegment"]
    if not canonical_absolute(root_path) or not isinstance(segment, str) or not segment or "/" in segment or "\0" in segment:
        raise ValueError("invalid layout")
    if base_path != root_path + "/" + segment or merged_path != base_path + "/m" or claim_path != root_path + "/" + segment + ".owner-v1":
        raise ValueError("layout mismatch")
    return root_path, segment + ".owner-v1"

def acquire_root(request):
    root_path, claim_name = validate_layout(request)
    root = open_absolute_directory(root_path)
    lock = os.open(LOCK_NAME, os.O_RDWR | os.O_CREAT | NOFOLLOW | CLOEXEC, 0o600, dir_fd=root)
    if not private_regular(os.fstat(lock)):
        os.close(lock)
        os.close(root)
        raise ValueError("unsafe lock")
    fcntl.flock(lock, fcntl.LOCK_EX)
    return root, lock, claim_name

def exclusive_install(root, name, content):
    temporary = ".omp-claim-" + os.urandom(12).hex()
    try:
        temporary_info = write_private(root, temporary, content)
        try:
            os.link(temporary, name, src_dir_fd=root, dst_dir_fd=root, follow_symlinks=False)
        except FileExistsError:
            return "exact" if read_entry(root, name, MAX_CLAIM) == content else "conflict"
        final = os.stat(name, dir_fd=root, follow_symlinks=False)
        if (final.st_dev, final.st_ino) != (temporary_info.st_dev, temporary_info.st_ino) or read_entry(root, name, MAX_CLAIM) != content:
            raise ValueError("claim changed")
        os.fsync(root)
        return "created"
    finally:
        try:
            os.unlink(temporary, dir_fd=root)
        except FileNotFoundError:
            pass

def cas_replace(root, name, expected, desired):
    before = os.stat(name, dir_fd=root, follow_symlinks=False)
    if read_entry(root, name, MAX_CLAIM) != expected:
        return False
    current = os.stat(name, dir_fd=root, follow_symlinks=False)
    if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
        raise ValueError("claim changed")
    replace_private(root, name, desired)
    return True

def cas_unlink(root, name, expected):
    try:
        before = os.stat(name, dir_fd=root, follow_symlinks=False)
    except FileNotFoundError:
        return "absent"
    if read_entry(root, name, MAX_CLAIM) != expected:
        return "conflict"
    current = os.stat(name, dir_fd=root, follow_symlinks=False)
    if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
        raise ValueError("claim changed")
    moved = ".omp-released-" + os.urandom(12).hex()
    os.rename(name, moved, src_dir_fd=root, dst_dir_fd=root)
    try:
        moved_info = os.stat(moved, dir_fd=root, follow_symlinks=False)
        if (moved_info.st_dev, moved_info.st_ino) != (before.st_dev, before.st_ino) or read_entry(root, moved, MAX_CLAIM) != expected:
            raise ValueError("released entry changed")
        os.unlink(moved, dir_fd=root)
        os.fsync(root)
        return "released"
    except BaseException:
        try:
            os.rename(moved, name, src_dir_fd=root, dst_dir_fd=root)
        except BaseException:
            pass
        raise

try:
    if not NOFOLLOW or not CLOEXEC or not DIRECTORY:
        emit({"status":"unsupported"})
        raise SystemExit(0)
    request = json.loads(read_absolute_file(INPUT_PATH, 16 * 1024 * 1024).decode("utf-8", "strict"))
    if not isinstance(request, dict) or request.get("operation") not in ("claim_dispatch", "claim_inspect"):
        raise ValueError("invalid request")
    root, lock, claim_name = acquire_root(request)
    try:
        if request["operation"] == "claim_inspect":
            current = read_entry(root, claim_name, MAX_CLAIM)
            emit({"status":"absent"} if current is None else {"status":"present","claimBytesBase64":base64.b64encode(current).decode("ascii")})
        else:
            effect = request["claimOperation"]
            expected = None if request["expectedClaimUtf8"] is None else request["expectedClaimUtf8"].encode("utf-8", "strict")
            desired = None if request["nextClaimUtf8"] is None else request["nextClaimUtf8"].encode("utf-8", "strict")
            if effect == "exclusive_create" and expected is None and desired is not None:
                outcome = exclusive_install(root, claim_name, desired)
                emit({"status":"applied","outcome":outcome} if outcome != "conflict" else {"status":"conflict"})
            elif effect == "stale_same_owner_cas_adopt" and expected is not None and desired is not None:
                emit({"status":"applied","outcome":"adopted"} if cas_replace(root, claim_name, expected, desired) else {"status":"conflict"})
            elif effect == "pre_bind_cas_release" and expected is not None and desired is None:
                outcome = cas_unlink(root, claim_name, expected)
                emit({"status":"applied","outcome":outcome} if outcome != "conflict" else {"status":"conflict"})
            else:
                raise ValueError("invalid claim operation")
    finally:
        os.close(lock)
        os.close(root)
except SystemExit:
    raise
except (OSError, ValueError, TypeError, UnicodeError, KeyError, json.JSONDecodeError, base64.binascii.Error):
    emit({"status":"outcome_unknown"})
`;

async function readClaimHelperOutput(outputPath: string): Promise<unknown> {
	const descriptor = await fs.open(outputPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		const before = await descriptor.stat();
		if (
			!before.isFile() ||
			before.size > CLAIM_HELPER_OUTPUT_LIMIT ||
			(before.mode & 0o7777) !== 0o600 ||
			(typeof process.getuid === "function" && before.uid !== process.getuid())
		)
			throw new Error("transient_task_authority_outcome_unknown");
		const content = await descriptor.readFile();
		const after = await descriptor.stat();
		if (content.byteLength !== before.size || after.size !== before.size)
			throw new Error("transient_task_authority_outcome_unknown");
		return JSON.parse(content.toString("utf8"));
	} finally {
		await descriptor.close();
	}
}

async function runClaimAuthorityHelper(request: Readonly<Record<string, unknown>>): Promise<unknown> {
	const payload = Buffer.from(JSON.stringify(request), "utf8");
	if (payload.byteLength > CLAIM_HELPER_INPUT_LIMIT) throw new Error("transient_task_authority_outcome_unknown");
	const executable = await resolveClaimHelperExecutable();
	let temporaryRoot: string | undefined;
	try {
		temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-authority-"));
		await fs.chmod(temporaryRoot, 0o700);
		const root = await fs.realpath(temporaryRoot);
		const inputPath = path.join(root, "input");
		const outputPath = path.join(root, "output");
		await fs.writeFile(inputPath, payload, { flag: "wx", mode: 0o600 });
		const result = await new Promise<unknown>((resolve, reject) => {
			const child = spawn(executable, ["-I", "-S", "-c", CLAIM_AUTHORITY_HELPER_SOURCE, inputPath, outputPath], {
				stdio: "ignore",
			});
			const timeout = setTimeout(() => child.kill("SIGKILL"), CLAIM_HELPER_TIMEOUT_MS);
			timeout.unref();
			child.once("error", () => {
				clearTimeout(timeout);
				reject(new Error("transient_task_authority_outcome_unknown"));
			});
			child.once("close", code => {
				clearTimeout(timeout);
				if (code !== 0) {
					reject(new Error("transient_task_authority_outcome_unknown"));
					return;
				}
				void readClaimHelperOutput(outputPath).then(resolve, () =>
					reject(new Error("transient_task_authority_outcome_unknown")),
				);
			});
		});
		return result;
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message === "transient_task_authority_platform_unsupported" ||
				error.message === "transient_task_authority_helper_unavailable")
		)
			throw error;
		throw new Error("transient_task_authority_outcome_unknown");
	} finally {
		if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
	}
}

export type PackageInternalNativeTransientTaskIsolationOwnershipClaimInspectionV1 =
	| { readonly status: "matching"; readonly receipt: ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1 }
	| {
			readonly status: "not_applied";
			readonly proof: ConfidentialTransientTaskIsolationOwnershipClaimNotAppliedProofV1;
	  }
	| {
			readonly status: "stale_same_owner";
			readonly observedClaim: ConfidentialTransientTaskIsolationOwnershipClaimV1;
			readonly ownerLivenessEvidence: Extract<
				ConfidentialTransientTaskIsolationOwnerLivenessEvidenceV1,
				{ readonly verdict: "stale" }
			>;
	  }
	| {
			readonly status: "same_owner_live";
			readonly observedClaim: ConfidentialTransientTaskIsolationOwnershipClaimV1;
			readonly ownerLivenessEvidence: Extract<
				ConfidentialTransientTaskIsolationOwnerLivenessEvidenceV1,
				{ readonly verdict: "live" }
			>;
	  }
	| {
			readonly status: "same_owner_liveness_indeterminate";
			readonly observedClaim: ConfidentialTransientTaskIsolationOwnershipClaimV1;
			readonly ownerLivenessEvidence: Extract<
				ConfidentialTransientTaskIsolationOwnerLivenessEvidenceV1,
				{ readonly verdict: "indeterminate" }
			>;
	  }
	| {
			readonly status: "live_different_owner";
			readonly observedClaim: ConfidentialTransientTaskIsolationOwnershipClaimV1;
	  }
	| { readonly status: "outcome_unknown" | "conflict" | "invalid" };

export interface PackageInternalNativeTransientTaskIsolationOwnershipClaimRuntimeV1
	extends TransientTaskIsolationOwnershipClaimEffectV1 {
	inspect(input: {
		readonly attempt: ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1;
		readonly request: TransientTaskIsolationOwnershipClaimEffectInspectRequestV1;
	}): Promise<PackageInternalNativeTransientTaskIsolationOwnershipClaimInspectionV1>;
}

function claimHelperRequest(
	descriptor: ConfidentialTransientTaskIsolationCreatorDescriptorV1,
	operation: "claim_dispatch" | "claim_inspect",
): Record<string, unknown> {
	return {
		operation,
		worktreesRoot: path.dirname(descriptor.baseDir),
		directorySegment: descriptor.directorySegment,
		baseDir: descriptor.baseDir,
		mergedDir: descriptor.mergedDir,
		ownershipClaimPath: descriptor.ownershipClaimPath,
	};
}

async function claimFromHelperResult(
	value: unknown,
): Promise<ConfidentialTransientTaskIsolationOwnershipClaimV1 | null | undefined> {
	const result = strictClaimRecord(value, ["status", "claimBytesBase64"]);
	if (result?.status !== "present" || typeof result.claimBytesBase64 !== "string") return undefined;
	try {
		const bytes = Buffer.from(result.claimBytesBase64, "base64");
		if (bytes.toString("base64") !== result.claimBytesBase64) return undefined;
		const parsed: unknown = JSON.parse(bytes.toString("utf8"));
		if (!(await validateClaimValue(parsed as ConfidentialTransientTaskIsolationOwnershipClaimV1))) return undefined;
		const claim = parsed as ConfidentialTransientTaskIsolationOwnershipClaimV1;
		return bytes.equals(canonicalClaimBytes(claim)) ? Object.freeze({ ...claim }) : undefined;
	} catch {
		return undefined;
	}
}

async function inspectPhysicalClaim(
	descriptor: ConfidentialTransientTaskIsolationCreatorDescriptorV1,
): Promise<ConfidentialTransientTaskIsolationOwnershipClaimV1 | null | undefined> {
	const value = await runClaimAuthorityHelper(claimHelperRequest(descriptor, "claim_inspect"));
	const absent = strictClaimRecord(value, ["status"]);
	if (absent?.status === "absent") return null;
	if (absent?.status === "unsupported") return undefined;
	return claimFromHelperResult(value);
}

function inspectRequestMatchesAttempt(
	request: TransientTaskIsolationOwnershipClaimEffectInspectRequestV1,
	attempt: ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1,
): boolean {
	const effect = attempt.request;
	return Boolean(
		strictClaimRecord(request, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"operation",
			"effectOperationId",
			"creatorDescriptorSha256",
			"requestSha256",
			"attemptSha256",
		]) &&
			request.schemaVersion === 1 &&
			request.taskId === effect.taskId &&
			request.runId === effect.runId &&
			request.createId === effect.createId &&
			request.operation === effect.operation &&
			request.effectOperationId === effect.effectOperationId &&
			request.creatorDescriptorSha256 === effect.creatorDescriptor.creatorDescriptorSha256 &&
			request.requestSha256 === effect.requestSha256 &&
			request.attemptSha256 === attempt.attemptSha256,
	);
}

async function mintClaimReceipt(
	request: ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1,
	attemptSha256: Sha256Ref,
	completedAt: ISO8601,
	outcome: "created" | "exact_claim_adopted" | "stale_same_owner_adopted" | "released_before_bind",
): Promise<ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1> {
	const core =
		request.operation === "pre_bind_cas_release"
			? {
					schemaVersion: 1 as const,
					taskId: request.taskId,
					runId: request.runId,
					createId: request.createId,
					effectOperationId: request.effectOperationId,
					requestSha256: request.requestSha256,
					attemptSha256,
					authoritySha256: request.authoritySha256,
					completedAt,
					operation: request.operation,
					outcome: "released_before_bind" as const,
					previousClaimSha256: request.expectedClaim.claimSha256,
					currentClaimSha256: null,
					reason: request.reason,
				}
			: {
					schemaVersion: 1 as const,
					taskId: request.taskId,
					runId: request.runId,
					createId: request.createId,
					effectOperationId: request.effectOperationId,
					requestSha256: request.requestSha256,
					attemptSha256,
					authoritySha256: request.authoritySha256,
					completedAt,
					operation: request.operation,
					outcome:
						request.operation === "exclusive_create"
							? outcome === "created"
								? ("created" as const)
								: ("exact_claim_adopted" as const)
							: ("stale_same_owner_adopted" as const),
					previousClaimSha256: request.operation === "exclusive_create" ? null : request.expectedClaim.claimSha256,
					claim: request.nextClaim,
					currentClaimSha256: request.nextClaim.claimSha256,
				};
	const receipt = {
		...core,
		receiptSha256: await claimTupleRef(
			await claimReceiptTuple(core as ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1),
		),
	} as ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1;
	return Object.freeze(receipt);
}

async function mintClaimLivenessEvidence(
	request: ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1,
	attemptSha256: Sha256Ref,
	observedClaim: ConfidentialTransientTaskIsolationOwnershipClaimV1,
	processIdentityProbe: ConfidentialTransientTaskIsolationOwnerProcessIdentityProbeV1,
): Promise<ConfidentialTransientTaskIsolationOwnerLivenessEvidenceV1> {
	let verdict: ConfidentialTransientTaskIsolationOwnerLivenessEvidenceV1["verdict"];
	let basis: ConfidentialTransientTaskIsolationOwnerLivenessEvidenceV1["basis"];
	if (observedClaim.controlHostId !== request.controller.controlHostId) {
		verdict = "indeterminate";
		basis = "different_control_host";
	} else if (observedClaim.processStartToken === null) {
		verdict = "indeterminate";
		basis = "missing_process_start_token";
	} else {
		const probe = await processIdentityProbe.inspect({
			controlHostId: observedClaim.controlHostId,
			pid: observedClaim.pid,
			processStartToken: observedClaim.processStartToken,
		});
		if (probe.status === "pid_absent") {
			verdict = "stale";
			basis = "same_host_pid_absent";
		} else if (probe.status === "process_start_token_mismatch") {
			verdict = "stale";
			basis = "same_host_process_start_token_mismatch";
		} else if (probe.status === "live" && probe.observedProcessStartToken === observedClaim.processStartToken) {
			verdict = "live";
			basis = "same_host_process_identity_live";
		} else {
			verdict = "indeterminate";
			basis =
				probe.status === "unsupported"
					? "process_probe_unsupported"
					: probe.status === "permission_denied"
						? "process_probe_permission_denied"
						: "process_probe_unavailable";
		}
	}
	const core = {
		schemaVersion: 1 as const,
		taskId: request.taskId,
		runId: request.runId,
		createId: request.createId,
		effectOperationId: request.effectOperationId,
		creatorDescriptorSha256: request.creatorDescriptor.creatorDescriptorSha256,
		requestSha256: request.requestSha256,
		attemptSha256,
		observedClaim,
		probingControlHostId: request.controller.controlHostId,
		verdict,
		basis,
	} as ConfidentialTransientTaskIsolationOwnerLivenessEvidenceV1;
	return Object.freeze({ ...core, evidenceSha256: await claimTupleRef(claimLivenessEvidenceTuple(core)) });
}

/** Package-internal runtime for the sole durable claim-effect store. */
export function createPackageInternalNativeTransientTaskIsolationOwnershipClaimRuntimeV1(options: {
	readonly processIdentityProbe: ConfidentialTransientTaskIsolationOwnerProcessIdentityProbeV1;
	readonly now?: () => ISO8601;
}): PackageInternalNativeTransientTaskIsolationOwnershipClaimRuntimeV1 {
	const now = options.now ?? (() => new Date().toISOString() as ISO8601);
	return Object.freeze({
		async dispatch(request: ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1) {
			if (!(await validateClaimRequest(request)))
				return { status: "invalid" as const, code: "record_invariant_violation" as const };
			let result: unknown;
			try {
				result = await runClaimAuthorityHelper({
					...claimHelperRequest(request.creatorDescriptor, "claim_dispatch"),
					claimOperation: request.operation,
					expectedClaimUtf8: request.expectedClaim
						? canonicalClaimBytes(request.expectedClaim).toString("utf8")
						: null,
					nextClaimUtf8: request.nextClaim ? canonicalClaimBytes(request.nextClaim).toString("utf8") : null,
				});
			} catch (error) {
				if (
					error instanceof Error &&
					(error.message === "transient_task_authority_platform_unsupported" ||
						error.message === "transient_task_authority_helper_unavailable")
				)
					return { status: "unsupported" as const, code: "claim_cas_unsupported" as const };
				throw new Error("claim_effect_outcome_unknown");
			}
			const applied = strictClaimRecord(result, ["status", "outcome"]);
			if (applied?.status === "applied")
				return {
					status: "applied" as const,
					observedClaimSha256: request.operation === "pre_bind_cas_release" ? null : request.nextClaim.claimSha256,
				};
			const status = strictClaimRecord(result, ["status"]);
			if (status?.status === "unsupported")
				return { status: "unsupported" as const, code: "claim_cas_unsupported" as const };
			if (status?.status !== "conflict") throw new Error("claim_effect_outcome_unknown");
			const observed = await inspectPhysicalClaim(request.creatorDescriptor).catch(() => undefined);
			if (!observed) return { status: "conflict" as const, code: "claim_path_changed" as const };
			if (observed.claimSha256 === (request.nextClaim?.claimSha256 ?? request.expectedClaim?.claimSha256))
				return { status: "conflict" as const, code: "same_digest_different_owner_tuple" as const };
			return {
				status: "conflict" as const,
				code:
					observed.ownerManifestSha256 !== request.creatorDescriptor.ownerManifestSha256
						? ("live_different_owner" as const)
						: ("claim_path_changed" as const),
			};
		},
		async inspect(input: {
			readonly attempt: ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1;
			readonly request: TransientTaskIsolationOwnershipClaimEffectInspectRequestV1;
		}) {
			if (
				!(await validateClaimAttempt(input.attempt)) ||
				!inspectRequestMatchesAttempt(input.request, input.attempt)
			)
				return { status: "invalid" as const };
			let observed: ConfidentialTransientTaskIsolationOwnershipClaimV1 | null | undefined;
			try {
				observed = await inspectPhysicalClaim(input.attempt.request.creatorDescriptor);
			} catch {
				return { status: "outcome_unknown" as const };
			}
			if (observed === undefined) return { status: "outcome_unknown" as const };
			const inspectedAt = now();
			if (!validClaimIso8601(inspectedAt)) return { status: "invalid" as const };
			const effect = input.attempt.request;
			const matching =
				effect.operation === "pre_bind_cas_release"
					? observed === null
					: observed !== null && sameClaimValue(observed, effect.nextClaim);
			if (matching)
				return {
					status: "matching" as const,
					receipt: await mintClaimReceipt(
						effect,
						input.attempt.attemptSha256,
						inspectedAt,
						effect.operation === "exclusive_create"
							? "exact_claim_adopted"
							: effect.operation === "stale_same_owner_cas_adopt"
								? "stale_same_owner_adopted"
								: "released_before_bind",
					),
				};
			const observedState =
				effect.operation === "exclusive_create" && observed === null
					? ("claim_path_absent" as const)
					: effect.operation === "stale_same_owner_cas_adopt" &&
							observed !== null &&
							sameClaimValue(observed, effect.expectedClaim)
						? ("expected_stale_claim_present" as const)
						: effect.operation === "pre_bind_cas_release" &&
								observed !== null &&
								sameClaimValue(observed, effect.expectedClaim)
							? ("expected_current_claim_present" as const)
							: null;
			if (observedState) {
				const core = {
					schemaVersion: 1 as const,
					request: effect,
					attemptSha256: input.attempt.attemptSha256,
					observedState,
					inspectedAt,
				};
				return {
					status: "not_applied" as const,
					proof: Object.freeze({
						...core,
						proofSha256: await claimTupleRef([
							"omp-transient-task-isolation-claim-effect-v1",
							"not_applied",
							1,
							await claimRequestTuple(effect),
							core.attemptSha256,
							core.observedState,
							core.inspectedAt,
						]),
					}),
				};
			}
			if (observed === null) return { status: "conflict" as const };
			if (observed.ownerManifestSha256 !== effect.creatorDescriptor.ownerManifestSha256)
				return { status: "live_different_owner" as const, observedClaim: observed };
			const evidence = await mintClaimLivenessEvidence(
				effect,
				input.attempt.attemptSha256,
				observed,
				options.processIdentityProbe,
			);
			if (evidence.verdict === "stale")
				return { status: "stale_same_owner" as const, observedClaim: observed, ownerLivenessEvidence: evidence };
			if (evidence.verdict === "live")
				return { status: "same_owner_live" as const, observedClaim: observed, ownerLivenessEvidence: evidence };
			return {
				status: "same_owner_liveness_indeterminate" as const,
				observedClaim: observed,
				ownerLivenessEvidence: evidence,
			};
		},
	} satisfies PackageInternalNativeTransientTaskIsolationOwnershipClaimRuntimeV1);
}
