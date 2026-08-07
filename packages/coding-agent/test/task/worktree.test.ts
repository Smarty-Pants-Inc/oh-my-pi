import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries, setWorktreesDir } from "@oh-my-pi/pi-utils";
import type { Sha256Ref } from "../../src/registry/persistent-agent-contracts";
import { TRANSIENT_TASK_GIT_RUNTIME_MINT_AUTHORITY } from "../../src/registry/persistent-agent-store";
import type {
	ConfidentialTransientTaskCaptureBranchMaterializationPlanV1,
	ConfidentialTransientTaskCaptureMaterializationEffectRequestV1,
	ConfidentialTransientTaskCaptureMaterializationStoreV1,
	ConfidentialTransientTaskCaptureObjectImportRequestV1,
	ConfidentialTransientTaskCaptureRefCompareAndSwapRequestV1,
	ConfidentialTransientTaskCaptureRepositoryOpenRequestV1,
	ConfidentialTransientTaskCaptureRepositoryResolverV1,
	ConfidentialTransientTaskEnsureIsolationRequestV1,
	ConfidentialTransientTaskGitRepositoryBindingSnapshotV1,
	ConfidentialTransientTaskIsolationCleanupComponentRequestV1,
	ConfidentialTransientTaskIsolationCleanupDescriptorV1,
	ConfidentialTransientTaskIsolationCleanupEffectV1,
	ConfidentialTransientTaskIsolationCreatorDescriptorV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1,
	ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1,
	ConfidentialTransientTaskIsolationOwnershipClaimV1,
	ConfidentialTransientTaskIsolationPreparingAuthorityV1,
	ConfidentialTransientTaskPostTerminalStoreV1,
	TransientTaskCaptureMaterializationInspectResultV1,
	TransientTaskCleanupAuthorityProofV1,
	TransientTaskControllerAuthorityProofV1,
	TransientTaskGitObjectFormatV1,
	TransientTaskPublicationTargetCleanupClaimV1,
} from "../../src/session/workspace-runtime-contracts";
import {
	type ConfidentialTransientTaskIsolationMaterializerV1,
	cleanupIsolation,
	createTransientTaskCaptureObjectImportInvocationV1,
	createTransientTaskCaptureRefCompareAndSwapInvocationV1,
	createTransientTaskCaptureRefDeleteInvocationV1,
	deriveTransientTaskIsolationPhysicalIdentityV1,
	ensureIsolation,
	materializeTransientTaskCaptureBranchV1,
	openTransientTaskCaptureRepositoryV1,
} from "../../src/task/worktree";
import { createTransientTaskGitEffectSafetyRuntimeV1 } from "../../src/utils/git";

const NOW = "2026-01-02T03:04:05.000Z";
const SHA_A: Sha256Ref = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B: Sha256Ref = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C: Sha256Ref = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const SHA_D: Sha256Ref = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const ABSENT_SHA1 = "0".repeat(40);
const tempDirs: string[] = [];

function sha256Ref(value: string | Uint8Array): Sha256Ref {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function gitObjectSha1(type: "blob" | "tree" | "commit", body: Uint8Array): string {
	return createHash("sha1")
		.update(Buffer.from(`${type} ${body.byteLength}\0`, "utf8"))
		.update(body)
		.digest("hex");
}

async function runGit(repo: string, args: readonly string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repo,
		stderr: "pipe",
		stdout: "pipe",
		windowsHide: true,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`);
	return stdout.trim();
}

async function createGitRepo(prefix = "omp-worktree-contract-"): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(repo);
	await runGit(repo, ["init", "-q", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(repo, "tracked.txt"), "initial\n");
	await runGit(repo, ["add", "tracked.txt"]);
	await runGit(repo, ["commit", "-q", "-m", "initial"]);
	return repo;
}

function parseObjectFormat(value: string): TransientTaskGitObjectFormatV1 {
	if (value === "sha1" || value === "sha256") return value;
	throw new Error(`Unsupported test repository object format: ${value}`);
}

async function captureRepositoryBinding(
	repositoryRoot: string,
): Promise<Extract<ConfidentialTransientTaskGitRepositoryBindingSnapshotV1, { scope: "capture_materialization" }>> {
	return {
		repositoryRoot,
		gitDir: await runGit(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]),
		commonDir: await runGit(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		objectFormat: parseObjectFormat(await runGit(repositoryRoot, ["rev-parse", "--show-object-format"])),
		scope: "capture_materialization",
	};
}

async function cleanupRepositoryBinding(
	repositoryRoot: string,
): Promise<Extract<ConfidentialTransientTaskGitRepositoryBindingSnapshotV1, { scope: "cleanup_ref_delete" }>> {
	return {
		repositoryRoot,
		gitDir: await runGit(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]),
		commonDir: await runGit(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
		objectFormat: parseObjectFormat(await runGit(repositoryRoot, ["rev-parse", "--show-object-format"])),
		scope: "cleanup_ref_delete",
	};
}

function cleanupAuthority(): TransientTaskCleanupAuthorityProofV1 {
	return {
		schemaVersion: 1,
		taskId: "task-1",
		runId: "run-1",
		cleanupId: "cleanup-1",
		cleanupAuthorityId: "cleanup-authority-1",
		workspaceId: "workspace-1",
		controlHostId: "host-1",
		cleanupEpoch: 2,
		fencingGeneration: 3,
	};
}

function cleanupClaim(): TransientTaskPublicationTargetCleanupClaimV1 {
	return {
		schemaVersion: 1,
		key: {
			schemaVersion: 1,
			taskId: "task-1",
			runId: "run-1",
			createId: "create-1",
			publicationTargetId: "publication-target-1",
		},
		isolationCleanupId: "isolation-cleanup-1",
		openOperationId: "cleanup-open-1",
		cleanupClaimOperationId: "cleanup-claim-1",
		access: "live",
		bindingRevision: 1,
		renewalSequence: 0,
		bindingReceiptSha256: SHA_A,
		bindingAuthoritySha256: SHA_B,
		bindingOpenRequestSha256: sha256Hex("binding-open"),
		cleanupDescriptorSha256: SHA_C,
		isolationNamespaceSha256: sha256Hex("namespace"),
		isolationOwnerManifestSha256: SHA_D,
		isolationCreatorDescriptorSha256: SHA_A,
		claimedAt: NOW,
		claimSha256: SHA_B,
	};
}

function captureObjectRequest(
	bodyText: string,
	effectOperationId: string,
	effectOrdinal = 0,
): ConfidentialTransientTaskCaptureObjectImportRequestV1 {
	const body = Buffer.from(bodyText, "utf8");
	return {
		schemaVersion: 1,
		taskId: "task-1",
		runId: "run-1",
		capturePreparationId: "capture-preparation-1",
		captureId: "capture-1",
		rootBranchPublicationId: "root-branch-publication-1",
		effectOperationId,
		effectIdentityManifestSha256: SHA_A,
		preparationReceiptSha256: SHA_B,
		preparedMemberId: "prepared-member-1",
		objectFormat: "sha1",
		effectOrdinal,
		requestedAt: NOW,
		effectRequestSha256: sha256Hex(effectOperationId),
		effectKind: "object_import",
		selectorKeyUtf8: `object:${effectOrdinal}`,
		command: Object.freeze(["git", "hash-object", "-t", "blob", "-w", "--stdin"]),
		object: {
			ordinal: effectOrdinal,
			objectType: "blob",
			objectBodyBytesBase64: body.toString("base64"),
			objectBodyByteLength: body.byteLength,
			objectBodySha256: sha256Ref(body),
			expectedObjectSha: gitObjectSha1("blob", body),
			objectMetadataSha256: sha256Ref(`metadata:${effectOperationId}`),
		},
	};
}

function captureRefRequest(
	captureBranchRef: string,
	expectedNewCaptureRefSha: string,
	expectedOldCaptureRefSha = ABSENT_SHA1,
): ConfidentialTransientTaskCaptureRefCompareAndSwapRequestV1 {
	const effectOperationId = "capture-ref-cas-1";
	return {
		schemaVersion: 1,
		taskId: "task-1",
		runId: "run-1",
		capturePreparationId: "capture-preparation-1",
		captureId: "capture-1",
		rootBranchPublicationId: "root-branch-publication-1",
		effectOperationId,
		effectIdentityManifestSha256: SHA_A,
		preparationReceiptSha256: SHA_B,
		preparedMemberId: "prepared-member-1",
		objectFormat: "sha1",
		effectOrdinal: 2,
		requestedAt: NOW,
		effectRequestSha256: sha256Hex(effectOperationId),
		effectKind: "capture_ref_compare_and_swap",
		selectorKeyUtf8: "capture-ref",
		command: Object.freeze([
			"git",
			"update-ref",
			captureBranchRef,
			expectedNewCaptureRefSha,
			expectedOldCaptureRefSha,
		]),
		captureBranchRef,
		expectedOldCaptureRefSha,
		expectedNewCaptureRefSha,
		objectClosureSha256: SHA_C,
	};
}

function capturePlan(
	objectImports: readonly [
		ConfidentialTransientTaskCaptureObjectImportRequestV1,
		...ConfidentialTransientTaskCaptureObjectImportRequestV1[],
	],
	captureRefCompareAndSwap: ConfidentialTransientTaskCaptureRefCompareAndSwapRequestV1,
): ConfidentialTransientTaskCaptureBranchMaterializationPlanV1 {
	return {
		schemaVersion: 1,
		taskId: "task-1",
		runId: "run-1",
		capturePreparationId: "capture-preparation-1",
		captureId: "capture-1",
		rootBranchPublicationId: "root-branch-publication-1",
		preparedMemberId: "prepared-member-1",
		objectFormat: "sha1",
		objectImports,
		captureRefCompareAndSwap,
		materializationPlanSha256: SHA_D,
	};
}

function appliedResult(
	effect: ConfidentialTransientTaskCaptureMaterializationEffectRequestV1,
): TransientTaskCaptureMaterializationInspectResultV1 {
	return {
		status: "applied",
		effectOperationId: effect.effectOperationId,
		effectRequestSha256: effect.effectRequestSha256,
		attemptSha256: SHA_A,
		receiptSha256: SHA_B,
		observedEvidenceSha256: SHA_C,
		inspectionSha256: SHA_D,
	};
}

function conflictResult(
	effect: ConfidentialTransientTaskCaptureMaterializationEffectRequestV1,
): TransientTaskCaptureMaterializationInspectResultV1 {
	return {
		status: "conflict",
		effectOperationId: effect.effectOperationId,
		observedEvidenceSha256: SHA_C,
		inspectionSha256: SHA_D,
	};
}

function materializationStore(
	runEffect: ConfidentialTransientTaskCaptureMaterializationStoreV1["runEffect"],
): ConfidentialTransientTaskCaptureMaterializationStoreV1 {
	return {
		runEffect,
		async inspectEffect(request) {
			return {
				status: "absent",
				effectOperationId: request.effectOperationId,
				inspectionSha256: SHA_A,
			};
		},
		async adoptEffect() {
			return { status: "absent" };
		},
	};
}

function captureRepositoryOpenRequest(): ConfidentialTransientTaskCaptureRepositoryOpenRequestV1 {
	return {
		schemaVersion: 1,
		taskId: "task-1",
		runId: "run-1",
		captureSinkRef: "capture-sink:nested-repository",
		postTerminalIntentSha256: SHA_A,
		capturePreparationId: "capture-preparation-1",
		captureId: "capture-1",
		expectedPostTerminalRevision: 4,
		authority: cleanupAuthority(),
		captureRepositoryOpenRequestSha256: sha256Hex("capture-open"),
	};
}

function captureRepositoryResolver(
	openCaptureRepository: ConfidentialTransientTaskCaptureRepositoryResolverV1["openCaptureRepository"],
): ConfidentialTransientTaskCaptureRepositoryResolverV1 {
	return {
		openCaptureRepository,
		async inspectCaptureRepositoryOpen(request) {
			return { ...request, status: "absent", inspectionSha256: SHA_A };
		},
		async adoptCaptureRepositoryOpen(request) {
			return {
				status: "absent",
				captureRepositoryOpenRequestSha256: request.request.captureRepositoryOpenRequestSha256,
			};
		},
	};
}

function ownershipClaim(ownerManifestSha256: Sha256Ref): ConfidentialTransientTaskIsolationOwnershipClaimV1 {
	return {
		schemaVersion: 1,
		ownerManifestSha256,
		claimOperationId: "ownership-claim-create-1",
		claimantInstanceId: "controller-instance-1",
		controlHostId: "host-1",
		pid: 1234,
		processStartToken: "process-start-1",
		claimedAt: NOW,
		claimSha256: SHA_C,
	};
}

async function ensureFixture(): Promise<{
	request: ConfidentialTransientTaskEnsureIsolationRequestV1;
	cleanupDescriptor: ConfidentialTransientTaskIsolationCleanupDescriptorV1;
}> {
	const taskId = "task-1";
	const runId = "run-1";
	const createId = "create-1";
	const identity = await deriveTransientTaskIsolationPhysicalIdentityV1({ taskId, runId, createId });
	const controller = {
		schemaVersion: 1,
		taskId,
		runId,
		createId,
		controllerId: "controller-1",
		workspaceId: "workspace-1",
		controlHostId: "host-1",
		controllerEpoch: 1,
		fencingGeneration: 1,
	} satisfies TransientTaskControllerAuthorityProofV1;
	const descriptor = {
		schemaVersion: 1,
		taskId,
		runId,
		createId,
		publicationTargetId: "publication-target-1",
		worktreePublicationId: "worktree-publication-1",
		isolationCleanupId: "isolation-cleanup-1",
		bindingOperationId: "binding-1",
		ownershipClaimCreateOperationId: "ownership-claim-create-1",
		effectIdentityManifestSha256: SHA_A,
		namespaceSha256: identity.namespaceSha256,
		directorySegment: identity.directorySegment,
		baseDir: identity.baseDir,
		mergedDir: identity.mergedDir,
		ownershipClaimPath: identity.ownershipClaimPath,
		captureBranchRef: identity.captureBranchRef,
		ownerManifestSha256: SHA_B,
		creatorDescriptorSha256: SHA_D,
	} satisfies ConfidentialTransientTaskIsolationCreatorDescriptorV1;
	const claim = ownershipClaim(descriptor.ownerManifestSha256);
	const claimRequest = {
		schemaVersion: 1,
		taskId,
		runId,
		createId,
		operation: "exclusive_create",
		effectOperationId: descriptor.ownershipClaimCreateOperationId,
		creatorDescriptor: descriptor,
		controller,
		authoritySha256: SHA_A,
		requestedAt: NOW,
		requestSha256: SHA_B,
		expectedClaim: null,
		nextClaim: claim,
		exclusive: true,
		noFollow: true,
		createParentDirectories: false,
	} satisfies ConfidentialTransientTaskIsolationOwnershipClaimEffectRequestV1;
	const attempt = {
		state: "claim_outcome_unknown",
		request: claimRequest,
		openedAt: NOW,
		attemptSha256: SHA_A,
	} satisfies ConfidentialTransientTaskIsolationOwnershipClaimEffectAttemptV1;
	const receipt = {
		schemaVersion: 1,
		taskId,
		runId,
		createId,
		effectOperationId: claimRequest.effectOperationId,
		requestSha256: claimRequest.requestSha256,
		attemptSha256: attempt.attemptSha256,
		authoritySha256: claimRequest.authoritySha256,
		completedAt: NOW,
		receiptSha256: SHA_D,
		operation: "exclusive_create",
		outcome: "created",
		previousClaimSha256: null,
		claim,
		currentClaimSha256: claim.claimSha256,
	} satisfies Extract<
		ConfidentialTransientTaskIsolationOwnershipClaimEffectReceiptV1,
		{ operation: "exclusive_create" }
	>;
	const preparation = {
		state: "claim_current",
		creatorDescriptor: descriptor,
		orderedClaimAttempts: [attempt],
		orderedClaimReceipts: [receipt],
		ownershipClaim: claim,
		ownershipClaimReceipt: receipt,
		updatedAt: NOW,
	} satisfies Extract<ConfidentialTransientTaskIsolationPreparingAuthorityV1, { state: "claim_current" }>;
	const cleanupDescriptor = {
		schemaVersion: 1,
		creatorDescriptor: descriptor,
		mergedDir: descriptor.mergedDir,
		backend: 7,
		fellBack: false,
		fallbackReason: null,
		cleanupDescriptorSha256: SHA_C,
	} satisfies ConfidentialTransientTaskIsolationCleanupDescriptorV1;
	return {
		request: {
			preparation,
			controller,
			authoritySha256: SHA_A,
			requestSha256: SHA_D,
			requestedAt: NOW,
		},
		cleanupDescriptor,
	};
}

function cleanupRefRequest(
	captureBranchRef: string,
	expectedOldCaptureRefSha: string,
): Extract<ConfidentialTransientTaskIsolationCleanupComponentRequestV1, { component: "capture_ref_cas_delete" }> {
	const claim = ownershipClaim(SHA_D);
	return {
		schemaVersion: 1,
		taskId: "task-1",
		runId: "run-1",
		isolationCleanupId: "isolation-cleanup-1",
		componentOperationId: "capture-ref-delete-1",
		component: "capture_ref_cas_delete",
		ordinal: 2,
		planSha256: SHA_A,
		cleanupRequestSha256: sha256Hex("cleanup-request"),
		cleanupClaimSha256: SHA_B,
		ownershipClaimSha256: claim.claimSha256,
		predecessorReceiptSha256: SHA_C,
		authority: cleanupAuthority(),
		expectedPostTerminalRevision: 5,
		requestSha256: sha256Hex("capture-ref-delete"),
		requestedAt: NOW,
		captureBranchRef,
		expectedOldCaptureRefSha,
		captureRefStateSourceSha256: SHA_D,
		ownershipClaim: claim,
		compareAndSwap: true,
		force: false,
	};
}

async function isolationCleanupEffect(
	repositoryRoot: string,
): Promise<ConfidentialTransientTaskIsolationCleanupEffectV1> {
	const { request: ensureRequest, cleanupDescriptor } = await ensureFixture();
	const descriptor = ensureRequest.preparation.creatorDescriptor;
	const claim = cleanupClaim();
	const authority = cleanupAuthority();
	const componentOperationIds = [
		"cleanup-backend-stop-1",
		"cleanup-directory-delete-1",
		"cleanup-capture-ref-delete-1",
		"cleanup-owner-release-1",
	] as const;
	const plan = {
		schemaVersion: 1,
		taskId: descriptor.taskId,
		runId: descriptor.runId,
		isolationCleanupId: descriptor.isolationCleanupId,
		publicationTargetId: descriptor.publicationTargetId,
		publicationTargetKey: claim.key,
		bindingAccess: claim.access,
		bindingRevision: claim.bindingRevision,
		bindingRenewalSequence: claim.renewalSequence,
		bindingReceiptSha256: claim.bindingReceiptSha256,
		bindingAuthoritySha256: claim.bindingAuthoritySha256,
		bindingOpenRequestSha256: claim.bindingOpenRequestSha256,
		cleanupDescriptorSha256: cleanupDescriptor.cleanupDescriptorSha256,
		isolationNamespaceSha256: descriptor.namespaceSha256,
		isolationOwnerManifestSha256: descriptor.ownerManifestSha256,
		isolationCreatorDescriptorSha256: descriptor.creatorDescriptorSha256,
		cleanupClaim: claim,
		ownershipClaimSha256: ensureRequest.preparation.ownershipClaim.claimSha256,
		captureRefStateSourceSha256: SHA_A,
		componentOrder: ["backend_stop", "directory_delete", "capture_ref_cas_delete", "ownership_claim_release"],
		componentOperationIds,
		planSha256: SHA_B,
		plannedAt: NOW,
		cleanupKind: "after_capture",
		captureId: "capture-1",
		captureReceiptSha256: SHA_C,
	} as const;
	const runtime = createTransientTaskGitEffectSafetyRuntimeV1(TRANSIENT_TASK_GIT_RUNTIME_MINT_AUTHORITY);
	const cleanupTarget = runtime.handleIssuer.mintIsolationCleanupHandle(
		await cleanupRepositoryBinding(repositoryRoot),
		claim,
	);
	return {
		request: {
			plan,
			cleanupDescriptor,
			ownershipClaim: ensureRequest.preparation.ownershipClaim,
			expectedOldCaptureRefSha: await runGit(repositoryRoot, ["rev-parse", "HEAD"]),
			authority,
			expectedPostTerminalRevision: 5,
			cleanupRequestSha256: sha256Hex("aggregate-cleanup-request"),
			requestedAt: NOW,
		},
		cleanupTarget,
	};
}

function unexpectedPostTerminalMethod(): never {
	throw new Error("unexpected post-terminal store method");
}

function postTerminalStore(
	cleanup: ConfidentialTransientTaskPostTerminalStoreV1["cleanupIsolation"],
): ConfidentialTransientTaskPostTerminalStoreV1 {
	return {
		openCaptureRepository: unexpectedPostTerminalMethod,
		inspectCaptureRepositoryOpen: unexpectedPostTerminalMethod,
		adoptCaptureRepositoryOpen: unexpectedPostTerminalMethod,
		generateCaptureCommitMessage: unexpectedPostTerminalMethod,
		inspectCaptureCommitMessageGeneration: unexpectedPostTerminalMethod,
		adoptCaptureCommitMessageGeneration: unexpectedPostTerminalMethod,
		prepareCapture: unexpectedPostTerminalMethod,
		inspectCapturePreparation: unexpectedPostTerminalMethod,
		adoptCapturePreparation: unexpectedPostTerminalMethod,
		runEffect: unexpectedPostTerminalMethod,
		inspectEffect: unexpectedPostTerminalMethod,
		adoptEffect: unexpectedPostTerminalMethod,
		runCaptureSubeffect: unexpectedPostTerminalMethod,
		inspectCaptureSubeffect: unexpectedPostTerminalMethod,
		adoptCaptureSubeffect: unexpectedPostTerminalMethod,
		putIntent: unexpectedPostTerminalMethod,
		inspectIntent: unexpectedPostTerminalMethod,
		inspectConfidential: unexpectedPostTerminalMethod,
		replace: unexpectedPostTerminalMethod,
		capture: unexpectedPostTerminalMethod,
		inspectCapture: unexpectedPostTerminalMethod,
		adoptCapture: unexpectedPostTerminalMethod,
		runIsolationCleanupComponent: unexpectedPostTerminalMethod,
		inspectIsolationCleanupComponent: unexpectedPostTerminalMethod,
		adoptIsolationCleanupComponent: unexpectedPostTerminalMethod,
		cleanupIsolation: cleanup,
		inspectIsolationCleanup: unexpectedPostTerminalMethod,
		adoptIsolationCleanup: unexpectedPostTerminalMethod,
		prepareMerge: unexpectedPostTerminalMethod,
		inspectMergePreparation: unexpectedPostTerminalMethod,
		adoptMergePreparation: unexpectedPostTerminalMethod,
		runMergeSubeffect: unexpectedPostTerminalMethod,
		inspectMergeSubeffect: unexpectedPostTerminalMethod,
		adoptMergeSubeffect: unexpectedPostTerminalMethod,
		mergeStep: unexpectedPostTerminalMethod,
		inspectMergeStep: unexpectedPostTerminalMethod,
		adoptMergeStep: unexpectedPostTerminalMethod,
		finishMerge: unexpectedPostTerminalMethod,
		inspectMergeFinish: unexpectedPostTerminalMethod,
		adoptMergeFinish: unexpectedPostTerminalMethod,
		compose: unexpectedPostTerminalMethod,
		inspectComposition: unexpectedPostTerminalMethod,
		adoptComposition: unexpectedPostTerminalMethod,
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
	await Promise.all(tempDirs.splice(0).map(directory => removeWithRetries(directory)));
});

describe("frozen task worktree contracts", () => {
	describe("physical isolation identity and authority", () => {
		it("derives deterministic repository-independent locators from the full task/run/create identity", async () => {
			const worktreesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worktree-root-"));
			tempDirs.push(worktreesRoot);
			const originalEnvironment = process.env.OMP_WORKTREE_DIR;
			delete process.env.OMP_WORKTREE_DIR;
			setWorktreesDir(worktreesRoot);
			try {
				const input = {
					taskId: "orchestrate-goal-execution.Test1-0982d2a",
					runId: "run-1",
					createId: "create-operation-1",
				};
				const first = await deriveTransientTaskIsolationPhysicalIdentityV1(input);
				const repeated = await deriveTransientTaskIsolationPhysicalIdentityV1(input);
				const nextCreate = await deriveTransientTaskIsolationPhysicalIdentityV1({
					...input,
					createId: "create-operation-2",
				});

				expect(repeated).toEqual(first);
				expect(first.namespaceSha256).toMatch(/^[0-9a-f]{64}$/);
				expect(first.directorySegment).toBe(`t1-${first.namespaceSha256}`);
				expect(first.directorySegment).not.toContain(input.taskId);
				expect(first.baseDir).toBe(path.join(worktreesRoot, first.directorySegment));
				expect(first.mergedDir).toBe(path.join(first.baseDir, "m"));
				expect(first.ownershipClaimPath).toBe(`${first.baseDir}.owner-v1`);
				expect(first.captureBranchRef).toBe(`refs/heads/omp/task/v1/${first.namespaceSha256}`);
				expect(nextCreate.namespaceSha256).not.toBe(first.namespaceSha256);
			} finally {
				if (originalEnvironment === undefined) delete process.env.OMP_WORKTREE_DIR;
				else process.env.OMP_WORKTREE_DIR = originalEnvironment;
			}
		});

		it("forwards one exact claim-current ensure request and preserves materializer results", async () => {
			const { request, cleanupDescriptor } = await ensureFixture();
			const expected = { status: "created", cleanupDescriptor } as const;
			const call = vi.fn<ConfidentialTransientTaskIsolationMaterializerV1["ensureIsolation"]>(async () => expected);
			const materializer = { ensureIsolation: call } satisfies ConfidentialTransientTaskIsolationMaterializerV1;

			await expect(ensureIsolation(request, materializer)).resolves.toBe(expected);
			expect(call).toHaveBeenCalledTimes(1);
			expect(call).toHaveBeenCalledWith(request);
		});

		it("rejects non-current claims and mismatched durable identities before physical materialization", async () => {
			const invalidState = await ensureFixture();
			Reflect.set(invalidState.request.preparation, "state", "ready_to_bind");
			const invalidIdentity = await ensureFixture();
			Reflect.set(invalidIdentity.request.preparation.creatorDescriptor, "mergedDir", "/ambient/wrong-root");
			const call = vi.fn<ConfidentialTransientTaskIsolationMaterializerV1["ensureIsolation"]>();
			const materializer = { ensureIsolation: call } satisfies ConfidentialTransientTaskIsolationMaterializerV1;

			await expect(ensureIsolation(invalidState.request, materializer)).resolves.toEqual({
				status: "invalid",
				code: "ownership_claim_not_current",
			});
			await expect(ensureIsolation(invalidIdentity.request, materializer)).resolves.toEqual({
				status: "invalid",
				code: "record_invariant_violation",
			});
			expect(call).not.toHaveBeenCalled();
		});
	});

	describe("repository-bound capture", () => {
		it("opens the exact durable sink and materializes into a nested repository without ambient root discovery", async () => {
			const parent = await createGitRepo("omp-capture-parent-");
			const nested = path.join(parent, "vendor", "nested");
			await fs.mkdir(nested, { recursive: true });
			await runGit(nested, ["init", "-q", "-b", "main"]);
			await runGit(nested, ["config", "user.email", "nested@example.com"]);
			await runGit(nested, ["config", "user.name", "Nested User"]);
			await fs.writeFile(path.join(nested, "nested.txt"), "nested initial\n");
			await runGit(nested, ["add", "nested.txt"]);
			await runGit(nested, ["commit", "-q", "-m", "nested initial"]);
			const nestedTip = await runGit(nested, ["rev-parse", "HEAD"]);

			const runtime = createTransientTaskGitEffectSafetyRuntimeV1(TRANSIENT_TASK_GIT_RUNTIME_MINT_AUTHORITY);
			const repository = runtime.handleIssuer.mintCaptureRepositoryHandle(await captureRepositoryBinding(nested));
			const request = captureRepositoryOpenRequest();
			const open = vi.fn<ConfidentialTransientTaskCaptureRepositoryResolverV1["openCaptureRepository"]>(
				async received => ({
					status: "opened",
					captureRepositoryOpenRequestSha256: received.captureRepositoryOpenRequestSha256,
					repository,
				}),
			);
			const opened = await openTransientTaskCaptureRepositoryV1(captureRepositoryResolver(open), request);
			if (opened.status !== "opened" && opened.status !== "already_opened")
				throw new Error("expected capture repository");

			const objectRequest = captureObjectRequest("captured only in nested repository\n", "nested-object-import-1");
			const objectInvocation = createTransientTaskCaptureObjectImportInvocationV1(opened.repository, objectRequest);
			const objectResult = await runtime.effectSafety.importObjectOnly(objectInvocation);
			expect(open).toHaveBeenCalledWith(request);
			expect(objectInvocation.expected).toEqual({
				objectFormat: objectRequest.objectFormat,
				objectType: objectRequest.object.objectType,
				expectedObjectSha: objectRequest.object.expectedObjectSha,
				objectBodyBytesBase64: objectRequest.object.objectBodyBytesBase64,
				objectBodyByteLength: objectRequest.object.objectBodyByteLength,
				objectBodySha256: objectRequest.object.objectBodySha256,
			});
			expect(objectResult.before.status).toBe("absent");
			expect(objectResult.after.status).toBe("present");
			await expect(runGit(nested, ["cat-file", "-e", objectRequest.object.expectedObjectSha])).resolves.toBe("");
			await expect(runGit(parent, ["cat-file", "-e", objectRequest.object.expectedObjectSha])).rejects.toThrow();

			const captureBranchRef = "refs/heads/omp/task/v1/nested-contract";
			const refRequest = captureRefRequest(captureBranchRef, nestedTip);
			const refInvocation = createTransientTaskCaptureRefCompareAndSwapInvocationV1(opened.repository, refRequest);
			const refResult = await runtime.effectSafety.compareAndSwapCaptureRef(refInvocation);
			expect(refInvocation.expected.expectedOld).toEqual({ state: "absent" });
			expect(refInvocation.expected.expectedNew).toEqual({ state: "present", objectId: nestedTip });
			expect(refResult.before.status).toBe("absent");
			expect(refResult.command).toMatchObject({ exitCode: 0, terminalState: "reaped" });
			expect(refResult.after).toMatchObject({ status: "present", objectId: nestedTip });
			expect(await runGit(nested, ["rev-parse", captureBranchRef])).toBe(nestedTip);
			await expect(runGit(parent, ["rev-parse", "--verify", captureBranchRef])).rejects.toThrow();

			const repeated = await runtime.effectSafety.importObjectOnly(objectInvocation);
			expect(repeated.before.status).toBe("present");
			expect(repeated.command).toBeNull();
		});

		it("preserves exact open failure results and resolver exceptions", async () => {
			const request = captureRepositoryOpenRequest();
			const invalid = captureRepositoryResolver(async received => ({
				status: "invalid",
				captureRepositoryOpenRequestSha256: received.captureRepositoryOpenRequestSha256,
			}));
			const failed = captureRepositoryResolver(async () => {
				throw new Error("capture sink unavailable");
			});

			await expect(openTransientTaskCaptureRepositoryV1(invalid, request)).resolves.toEqual({
				status: "invalid",
				captureRepositoryOpenRequestSha256: request.captureRepositoryOpenRequestSha256,
			});
			await expect(openTransientTaskCaptureRepositoryV1(failed, request)).rejects.toThrow(
				"capture sink unavailable",
			);
		});

		it("maps durable ref updates without treating an absent old value as an object id", async () => {
			const repo = await createGitRepo();
			const runtime = createTransientTaskGitEffectSafetyRuntimeV1(TRANSIENT_TASK_GIT_RUNTIME_MINT_AUTHORITY);
			const repository = runtime.handleIssuer.mintCaptureRepositoryHandle(await captureRepositoryBinding(repo));
			const next = await runGit(repo, ["rev-parse", "HEAD"]);
			const absent = captureRefRequest("refs/heads/omp/task/v1/absent", next);
			const presentOldSha = "1".repeat(40);
			const present = captureRefRequest("refs/heads/omp/task/v1/present", next, presentOldSha);

			expect(
				createTransientTaskCaptureRefCompareAndSwapInvocationV1(repository, absent).expected.expectedOld,
			).toEqual({
				state: "absent",
			});
			expect(
				createTransientTaskCaptureRefCompareAndSwapInvocationV1(repository, present).expected.expectedOld,
			).toEqual({
				state: "present",
				objectId: presentOldSha,
			});
		});

		it("rejects malformed durable ref requests instead of repairing them from Git state", async () => {
			const repo = await createGitRepo();
			const runtime = createTransientTaskGitEffectSafetyRuntimeV1(TRANSIENT_TASK_GIT_RUNTIME_MINT_AUTHORITY);
			const repository = runtime.handleIssuer.mintCaptureRepositoryHandle(await captureRepositoryBinding(repo));
			const request = captureRefRequest("refs/heads/omp/task/v1/invalid", await runGit(repo, ["rev-parse", "HEAD"]));
			Reflect.set(request, "expectedNewCaptureRefSha", "2".repeat(40));

			expect(() => createTransientTaskCaptureRefCompareAndSwapInvocationV1(repository, request)).toThrow(
				"Invalid durable capture-ref compare-and-swap request",
			);
		});
	});

	describe("ordered capture materialization", () => {
		it("dispatches every object import before the sole ref CAS with stored operation ids intact", async () => {
			const repo = await createGitRepo();
			const runtime = createTransientTaskGitEffectSafetyRuntimeV1(TRANSIENT_TASK_GIT_RUNTIME_MINT_AUTHORITY);
			const repository = runtime.handleIssuer.mintCaptureRepositoryHandle(await captureRepositoryBinding(repo));
			const first = captureObjectRequest("first object\n", "object-import-1", 0);
			const second = captureObjectRequest("second object\n", "object-import-2", 1);
			const ref = captureRefRequest("refs/heads/omp/task/v1/materialized", second.object.expectedObjectSha);
			const plan = capturePlan([first, second], ref);
			const authority = cleanupAuthority();
			const runEffect = vi.fn<ConfidentialTransientTaskCaptureMaterializationStoreV1["runEffect"]>(
				async ({ effect }) => appliedResult(effect),
			);

			const results = await materializeTransientTaskCaptureBranchV1(
				materializationStore(runEffect),
				repository,
				authority,
				plan,
			);

			expect(runEffect.mock.calls.map(([call]) => call.effect.effectOperationId)).toEqual([
				first.effectOperationId,
				second.effectOperationId,
				ref.effectOperationId,
			]);
			expect(
				runEffect.mock.calls.every(([call]) => call.repository === repository && call.authority === authority),
			).toBe(true);
			expect(results.map(result => result.status)).toEqual(["applied", "applied", "applied"]);
		});

		it("stops at the first non-applied object result and never advances the capture ref", async () => {
			const repo = await createGitRepo();
			const runtime = createTransientTaskGitEffectSafetyRuntimeV1(TRANSIENT_TASK_GIT_RUNTIME_MINT_AUTHORITY);
			const repository = runtime.handleIssuer.mintCaptureRepositoryHandle(await captureRepositoryBinding(repo));
			const first = captureObjectRequest("blocked object\n", "object-import-blocked", 0);
			const second = captureObjectRequest("must not run\n", "object-import-skipped", 1);
			const ref = captureRefRequest("refs/heads/omp/task/v1/not-created", second.object.expectedObjectSha);
			const runEffect = vi.fn<ConfidentialTransientTaskCaptureMaterializationStoreV1["runEffect"]>(
				async ({ effect }) => conflictResult(effect),
			);

			const results = await materializeTransientTaskCaptureBranchV1(
				materializationStore(runEffect),
				repository,
				cleanupAuthority(),
				capturePlan([first, second], ref),
			);

			expect(runEffect).toHaveBeenCalledTimes(1);
			expect(runEffect.mock.calls[0]?.[0].effect).toBe(first);
			expect(results).toEqual([conflictResult(first)]);
		});

		it("propagates durable store failures without synthesizing a fallback branch", async () => {
			const repo = await createGitRepo();
			const runtime = createTransientTaskGitEffectSafetyRuntimeV1(TRANSIENT_TASK_GIT_RUNTIME_MINT_AUTHORITY);
			const repository = runtime.handleIssuer.mintCaptureRepositoryHandle(await captureRepositoryBinding(repo));
			const object = captureObjectRequest("store failure\n", "object-import-failure");
			const ref = captureRefRequest("refs/heads/omp/task/v1/failure", object.object.expectedObjectSha);
			const runEffect = vi.fn<ConfidentialTransientTaskCaptureMaterializationStoreV1["runEffect"]>(async () => {
				throw new Error("durable effect store failed");
			});

			await expect(
				materializeTransientTaskCaptureBranchV1(
					materializationStore(runEffect),
					repository,
					cleanupAuthority(),
					capturePlan([object], ref),
				),
			).rejects.toThrow("durable effect store failed");
		});
	});

	describe("capture-ref cleanup", () => {
		it("deletes only the expected captured tip and remains idempotent after absence", async () => {
			const repo = await createGitRepo();
			const captureRef = "refs/heads/omp/task/v1/cleanup";
			const expectedTip = await runGit(repo, ["rev-parse", "HEAD"]);
			await runGit(repo, ["update-ref", captureRef, expectedTip]);
			const runtime = createTransientTaskGitEffectSafetyRuntimeV1(TRANSIENT_TASK_GIT_RUNTIME_MINT_AUTHORITY);
			const repository = runtime.handleIssuer.mintIsolationCleanupHandle(
				await cleanupRepositoryBinding(repo),
				cleanupClaim(),
			);
			const request = cleanupRefRequest(captureRef, expectedTip);
			const invocation = createTransientTaskCaptureRefDeleteInvocationV1(repository, "sha1", request);

			expect(invocation.command).toEqual(["git", "update-ref", "-d", captureRef, expectedTip]);
			expect(invocation.expected.expectedOld).toEqual({ state: "present", objectId: expectedTip });
			expect(invocation.expected.expectedNew).toEqual({ state: "absent" });
			const first = await runtime.effectSafety.compareAndSwapDeleteCaptureRef(invocation);
			expect(first.before).toMatchObject({ status: "present", objectId: expectedTip });
			expect(first.after.status).toBe("absent");
			await expect(runGit(repo, ["rev-parse", "--verify", captureRef])).rejects.toThrow();

			const repeated = await runtime.effectSafety.compareAndSwapDeleteCaptureRef(invocation);
			expect(repeated.before.status).toBe("absent");
			expect(repeated.command).toBeNull();
			expect(repeated.after.status).toBe("absent");
		});

		it("does not delete a ref whose tip changed after cleanup was planned", async () => {
			const repo = await createGitRepo();
			const expectedOld = await runGit(repo, ["rev-parse", "HEAD"]);
			await fs.writeFile(path.join(repo, "tracked.txt"), "new tip\n");
			await runGit(repo, ["commit", "-q", "-am", "new tip"]);
			const currentTip = await runGit(repo, ["rev-parse", "HEAD"]);
			const captureRef = "refs/heads/omp/task/v1/changed";
			await runGit(repo, ["update-ref", captureRef, currentTip]);
			const runtime = createTransientTaskGitEffectSafetyRuntimeV1(TRANSIENT_TASK_GIT_RUNTIME_MINT_AUTHORITY);
			const repository = runtime.handleIssuer.mintIsolationCleanupHandle(
				await cleanupRepositoryBinding(repo),
				cleanupClaim(),
			);
			const invocation = createTransientTaskCaptureRefDeleteInvocationV1(
				repository,
				"sha1",
				cleanupRefRequest(captureRef, expectedOld),
			);

			const result = await runtime.effectSafety.compareAndSwapDeleteCaptureRef(invocation);
			expect(result.before).toMatchObject({ status: "present", objectId: currentTip });
			expect(result.command).toBeNull();
			expect(result.after).toMatchObject({ status: "present", objectId: currentTip });
			expect(await runGit(repo, ["rev-parse", captureRef])).toBe(currentTip);
		});

		it("rejects cleanup plans that use the all-zero absence marker as an expected present tip", async () => {
			const repo = await createGitRepo();
			const runtime = createTransientTaskGitEffectSafetyRuntimeV1(TRANSIENT_TASK_GIT_RUNTIME_MINT_AUTHORITY);
			const repository = runtime.handleIssuer.mintIsolationCleanupHandle(
				await cleanupRepositoryBinding(repo),
				cleanupClaim(),
			);

			expect(() =>
				createTransientTaskCaptureRefDeleteInvocationV1(
					repository,
					"sha1",
					cleanupRefRequest("refs/heads/omp/task/v1/invalid-cleanup", ABSENT_SHA1),
				),
			).toThrow("Capture-ref cleanup requires a present expected-old object ID");
		});

		it("delegates the exact aggregate cleanup effect and preserves durable failure results", async () => {
			const effect = await isolationCleanupEffect(await createGitRepo());
			const expected = { status: "invalid", code: "record_invariant_violation" } as const;
			const dispatch = vi.fn<ConfidentialTransientTaskPostTerminalStoreV1["cleanupIsolation"]>(async () => expected);

			await expect(cleanupIsolation(postTerminalStore(dispatch), effect)).resolves.toBe(expected);
			expect(dispatch).toHaveBeenCalledTimes(1);
			expect(dispatch).toHaveBeenCalledWith(effect);
		});

		it("propagates aggregate cleanup store exceptions", async () => {
			const effect = await isolationCleanupEffect(await createGitRepo());
			const dispatch = vi.fn<ConfidentialTransientTaskPostTerminalStoreV1["cleanupIsolation"]>(async () => {
				throw new Error("cleanup store unavailable");
			});

			await expect(cleanupIsolation(postTerminalStore(dispatch), effect)).rejects.toThrow(
				"cleanup store unavailable",
			);
		});
	});
});
