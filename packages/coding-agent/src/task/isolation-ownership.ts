import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileLock } from "@oh-my-pi/pi-natives";
import { getWorktreesDir } from "@oh-my-pi/pi-utils";
import type {
	ConfidentialTaskAdapterWorktreeCliManagedRecognitionV1,
	ConfidentialTransientTaskIsolationPreparingAuthorityV1,
} from "../session/workspace-runtime-contracts";

const CLAIM_SUFFIX = ".owner-v1";
const NAMESPACE = /^t1-([0-9a-f]{64})$/;
const SHA256_REF = /^sha256:[0-9a-f]{64}$/;
type Recognition = ConfidentialTaskAdapterWorktreeCliManagedRecognitionV1;

const EXCLUSION_LOCK_FILE = ".omp-transient-task-isolation-exclusion-v1.lock";

/** Shared with claim installation/release so a clear cannot race an ownership claim. */
export function tryAcquireTaskIsolationExclusionLock(): FileLock | null {
	try {
		const lock = FileLock.tryAcquire(path.join(getWorktreesDir(), EXCLUSION_LOCK_FILE));
		return lock.acquired ? lock : null;
	} catch {
		return null;
	}
}

export function isTaskIsolationExclusionLockSidecar(name: string): boolean {
	return name === EXCLUSION_LOCK_FILE;
}

function isRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const actual = Reflect.ownKeys(value);
	return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function namespaceFor(baseDir: string): string | null {
	return NAMESPACE.exec(path.basename(baseDir))?.[1] ?? null;
}

function descriptorFor(preparation: ConfidentialTransientTaskIsolationPreparingAuthorityV1): unknown {
	switch (preparation.state) {
		case "claim_effect_not_applied":
		case "claim_effect_outcome_unknown":
		case "claim_current":
			return preparation.creatorDescriptor;
		case "ready_to_bind":
		case "bound":
			return preparation.ready.creatorDescriptor;
		case "released_before_bind":
			return null;
	}
}

function recognizePreparation(
	baseDir: string,
	preparation: ConfidentialTransientTaskIsolationPreparingAuthorityV1 | undefined,
): Recognition | null {
	if (!preparation) return null;
	const descriptor = descriptorFor(preparation);
	if (
		!isRecord(descriptor, [
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
		])
	)
		return null;
	const namespace = namespaceFor(baseDir);
	if (
		descriptor.schemaVersion !== 1 ||
		typeof descriptor.namespaceSha256 !== "string" ||
		namespace !== descriptor.namespaceSha256 ||
		descriptor.directorySegment !== path.basename(baseDir) ||
		descriptor.baseDir !== baseDir ||
		descriptor.mergedDir !== path.join(baseDir, "m") ||
		descriptor.ownershipClaimPath !== `${baseDir}${CLAIM_SUFFIX}` ||
		typeof descriptor.ownerManifestSha256 !== "string" ||
		!SHA256_REF.test(descriptor.ownerManifestSha256) ||
		typeof descriptor.creatorDescriptorSha256 !== "string" ||
		!SHA256_REF.test(descriptor.creatorDescriptorSha256)
	)
		return null;
	return {
		source: "creator_preparation_row",
		claimState: "not_observed",
		isolationNamespaceSha256: namespace as never,
		isolationOwnerManifestSha256: descriptor.ownerManifestSha256 as never,
		isolationCreatorDescriptorSha256: descriptor.creatorDescriptorSha256 as never,
	};
}

function decodedClaim(value: unknown): value is Record<string, unknown> {
	return (
		isRecord(value, [
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
		value.schemaVersion === 1 &&
		typeof value.ownerManifestSha256 === "string" &&
		SHA256_REF.test(value.ownerManifestSha256) &&
		isNonEmptyString(value.claimOperationId) &&
		isNonEmptyString(value.claimantInstanceId) &&
		isNonEmptyString(value.controlHostId) &&
		typeof value.pid === "number" &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		(value.processStartToken === null || isNonEmptyString(value.processStartToken)) &&
		typeof value.claimedAt === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.claimedAt) &&
		new Date(value.claimedAt).toISOString() === value.claimedAt &&
		typeof value.claimSha256 === "string" &&
		SHA256_REF.test(value.claimSha256)
	);
}

/** Recognizes a managed entry without exposing claim bytes or probing a process. */
export async function recognizeManagedTaskIsolationEntryV1(
	baseDir: string,
	preparation?: ConfidentialTransientTaskIsolationPreparingAuthorityV1,
): Promise<Recognition | null> {
	const namespace = namespaceFor(baseDir);
	const invalid = (): Recognition => ({
		source: "sibling_claim",
		claimState: "present_unreadable_or_invalid",
		isolationNamespaceSha256: namespace as never,
		isolationOwnerManifestSha256: null,
		isolationCreatorDescriptorSha256: null,
	});
	const claimPath = `${baseDir}${CLAIM_SUFFIX}`;
	let stat: Stats;
	try {
		stat = await fs.lstat(claimPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return invalid();
		return (
			recognizePreparation(baseDir, preparation) ??
			(namespace
				? {
						source: "canonical_namespace_guard",
						claimState: "absent",
						isolationNamespaceSha256: namespace as never,
						isolationOwnerManifestSha256: null,
						isolationCreatorDescriptorSha256: null,
					}
				: null)
		);
	}
	if (!stat.isFile() || stat.isSymbolicLink()) return invalid();
	try {
		const handle = await fs.open(claimPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			if (!(await handle.stat()).isFile()) return invalid();
			const value: unknown = JSON.parse(await handle.readFile("utf8"));
			if (!decodedClaim(value)) return invalid();
			return {
				source: "sibling_claim",
				claimState: "decoded",
				isolationNamespaceSha256: namespace as never,
				isolationOwnerManifestSha256: value.ownerManifestSha256 as never,
				isolationCreatorDescriptorSha256: null,
			};
		} finally {
			await handle.close();
		}
	} catch {
		return invalid();
	}
}
