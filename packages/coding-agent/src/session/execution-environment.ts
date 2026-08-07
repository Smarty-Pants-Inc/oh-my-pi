import * as path from "node:path";
import type { ClientBridge } from "./client-bridge";
import {
	canonicalRuntimeProviderInspectionSha256V1,
	type RuntimeFence,
	type RuntimeLeaseRef,
	type RuntimeLeaseReleaseInspectRequest,
	type RuntimeLeaseReleaseInspectResult,
	type RuntimeLeaseReleaseResult,
	type RuntimeParentOperationProviderRequestIdentity,
	type RuntimeProvider,
	type RuntimeReplicaRef,
} from "./workspace-runtime-contracts.js";

export type ExecutionEnvironmentBridge = Required<
	Pick<ClientBridge, "readTextFile" | "writeTextFile" | "createTerminal">
>;

export interface ExecutionEnvironmentRequest {
	taskId: string;
	runId: string;
	sourceRoot: string;
	signal?: AbortSignal;
}

export interface ExecutionEnvironmentBinding {
	readonly id: string;
	readonly sourceRoot: string;
	readonly remoteRoot: string;
	readonly bridge: ExecutionEnvironmentBridge;
}

export interface ExecutionEnvironmentLease extends ExecutionEnvironmentBinding {
	/** Exact frozen capability for lifecycle-owned release dispatch and recovery. Reading it has no effect. */
	readonly releaseAuthority: ExecutionEnvironmentRuntimeReleaseAuthorityV1;
	syncBack(signal?: AbortSignal): Promise<void>;
	/** Resolves only after no provider process or later flush can mutate the workspace. */
	release(): Promise<RuntimeLeaseReleaseResult>;
}

export interface ExecutionEnvironmentProvider {
	acquire(request: ExecutionEnvironmentRequest): Promise<ExecutionEnvironmentLease>;
}
export type ExecutionEnvironmentReleaseProviderV1 = Pick<RuntimeProvider, "id" | "release" | "inspectRelease">;

export interface ExecutionEnvironmentRuntimeReleaseAuthorityV1 {
	readonly provider: ExecutionEnvironmentReleaseProviderV1;
	readonly lease: RuntimeLeaseRef;
	readonly fence: RuntimeFence;
	readonly request: RuntimeLeaseReleaseInspectRequest;
}

export class ExecutionEnvironmentReleaseContractErrorV1 extends Error {
	readonly code = "EXECUTION_ENVIRONMENT_RELEASE_CONTRACT_INVALID" as const;

	constructor(message = "Execution environment release authority or receipt is invalid") {
		super(message);
		this.name = "ExecutionEnvironmentReleaseContractErrorV1";
	}
}

export class ExecutionEnvironmentReleaseIndeterminateErrorV1 extends Error {
	readonly code = "EXECUTION_ENVIRONMENT_RELEASE_INDETERMINATE" as const;
	readonly recoverable = true as const;
	readonly request: RuntimeLeaseReleaseInspectRequest;
	readonly inspection: Exclude<RuntimeLeaseReleaseInspectResult, { readonly status: "complete" }> | null;
	readonly errors: readonly unknown[];

	constructor(
		request: RuntimeLeaseReleaseInspectRequest,
		inspection: Exclude<RuntimeLeaseReleaseInspectResult, { readonly status: "complete" }> | null,
		errors: readonly unknown[] = [],
	) {
		super(`Execution environment release remains unresolved for request ${JSON.stringify(request.requestId)}`);
		this.name = "ExecutionEnvironmentReleaseIndeterminateErrorV1";
		this.request = request;
		this.inspection = inspection;
		this.errors = Object.freeze([...errors]);
		if (errors.length > 0) Object.defineProperty(this, "cause", { value: new AggregateError(errors) });
	}
}

const RELEASE_REQUEST_KEYS = ["requestId", "requestSha256", "parentOperationId", "replica", "leaseId"] as const;
const RELEASE_RESULT_KEYS = ["status", "request", "replica", "leaseId", "compute"] as const;
const RELEASE_REQUEST_IDENTITY_KEYS = ["requestId", "requestSha256", "parentOperationId"] as const;
const REPLICA_KEYS = ["providerId", "profileId", "replicaId", "workspaceId"] as const;
const LEASE_KEYS = [
	"leaseId",
	"replica",
	"fenceId",
	"baseGeneration",
	"renewalSequence",
	"acquiredAt",
	"renewBy",
	"expiresAt",
] as const;
const FENCE_KEYS = ["fenceId", "token"] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function releaseContractFailure(message?: string): never {
	throw new ExecutionEnvironmentReleaseContractErrorV1(message);
}

function exactDataRecord<const Key extends string>(value: unknown, keys: readonly Key[]): Record<Key, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) releaseContractFailure();
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) releaseContractFailure();
		const ownKeys = Reflect.ownKeys(value);
		const isAllowedKey = (key: PropertyKey): key is Key =>
			typeof key === "string" && keys.some(candidate => candidate === key);
		if (ownKeys.length !== keys.length || ownKeys.some(key => !isAllowedKey(key))) {
			releaseContractFailure();
		}
		const snapshot = {} as Record<Key, unknown>;
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) releaseContractFailure();
			snapshot[key] = descriptor.value;
		}
		return Object.freeze(snapshot);
	} catch {
		return releaseContractFailure();
	}
}

function requireIdentity(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) releaseContractFailure();
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) releaseContractFailure();
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) releaseContractFailure();
	}
	return value;
}

function requireSha256(value: unknown): string {
	if (typeof value !== "string" || !SHA256_HEX.test(value)) releaseContractFailure();
	return value;
}

function requireNonNegativeSafeInteger(value: unknown): number {
	if (!Number.isSafeInteger(value) || Object.is(value, -0) || (value as number) < 0) releaseContractFailure();
	return value as number;
}

function requireIso8601(value: unknown): string {
	if (typeof value !== "string") releaseContractFailure();
	const epoch = Date.parse(value);
	if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) releaseContractFailure();
	return value;
}

function requireReplica(value: unknown): RuntimeReplicaRef {
	const input = exactDataRecord(value, REPLICA_KEYS);
	return Object.freeze({
		providerId: requireIdentity(input.providerId),
		profileId: requireIdentity(input.profileId),
		replicaId: requireIdentity(input.replicaId),
		workspaceId: requireIdentity(input.workspaceId),
	});
}

function sameReplica(left: RuntimeReplicaRef, right: RuntimeReplicaRef): boolean {
	return (
		left.providerId === right.providerId &&
		left.profileId === right.profileId &&
		left.replicaId === right.replicaId &&
		left.workspaceId === right.workspaceId
	);
}

function requireRequestIdentity(value: unknown): RuntimeParentOperationProviderRequestIdentity {
	const input = exactDataRecord(value, RELEASE_REQUEST_IDENTITY_KEYS);
	return Object.freeze({
		requestId: requireSha256(input.requestId),
		requestSha256: requireSha256(input.requestSha256),
		parentOperationId: requireIdentity(input.parentOperationId),
	});
}

function sameRequestIdentity(
	left: RuntimeParentOperationProviderRequestIdentity,
	right: RuntimeParentOperationProviderRequestIdentity,
): boolean {
	return (
		left.requestId === right.requestId &&
		left.requestSha256 === right.requestSha256 &&
		left.parentOperationId === right.parentOperationId
	);
}

async function requireReleaseRequest(value: unknown): Promise<RuntimeLeaseReleaseInspectRequest> {
	const input = exactDataRecord(value, RELEASE_REQUEST_KEYS);
	const request = Object.freeze({
		...requireRequestIdentity({
			requestId: input.requestId,
			requestSha256: input.requestSha256,
			parentOperationId: input.parentOperationId,
		}),
		replica: requireReplica(input.replica),
		leaseId: requireIdentity(input.leaseId),
	});
	const expectedSha256 = await canonicalRuntimeProviderInspectionSha256V1({ operation: "release", request });
	if (request.requestSha256 !== expectedSha256)
		releaseContractFailure("Execution environment release digest is invalid");
	return request as RuntimeLeaseReleaseInspectRequest;
}

/** Strictly snapshots the exact runtime authority used by one compatibility lease. */
export async function freezeExecutionEnvironmentRuntimeReleaseAuthorityV1(input: {
	readonly provider: ExecutionEnvironmentReleaseProviderV1;
	readonly lease: RuntimeLeaseRef;
	readonly fence: RuntimeFence;
	readonly request: RuntimeLeaseReleaseInspectRequest;
}): Promise<ExecutionEnvironmentRuntimeReleaseAuthorityV1> {
	if (
		input.provider === null ||
		typeof input.provider !== "object" ||
		typeof input.provider.release !== "function" ||
		typeof input.provider.inspectRelease !== "function"
	) {
		releaseContractFailure("Execution environment release provider is invalid");
	}
	const providerId = requireIdentity(input.provider.id);
	const provider: ExecutionEnvironmentReleaseProviderV1 = Object.freeze({
		id: providerId,
		release: input.provider.release.bind(input.provider),
		inspectRelease: input.provider.inspectRelease.bind(input.provider),
	});
	const leaseInput = exactDataRecord(input.lease, LEASE_KEYS);
	const lease = Object.freeze({
		leaseId: requireIdentity(leaseInput.leaseId),
		replica: requireReplica(leaseInput.replica),
		fenceId: requireIdentity(leaseInput.fenceId),
		baseGeneration: requireNonNegativeSafeInteger(leaseInput.baseGeneration),
		renewalSequence: requireNonNegativeSafeInteger(leaseInput.renewalSequence),
		acquiredAt: requireIso8601(leaseInput.acquiredAt),
		renewBy: requireIso8601(leaseInput.renewBy),
		expiresAt: requireIso8601(leaseInput.expiresAt),
	}) as RuntimeLeaseRef;
	if (
		Date.parse(lease.acquiredAt) > Date.parse(lease.renewBy) ||
		Date.parse(lease.renewBy) > Date.parse(lease.expiresAt)
	) {
		releaseContractFailure("Execution environment lease timestamps are invalid");
	}
	const fenceInput = exactDataRecord(input.fence, FENCE_KEYS);
	const fence = Object.freeze({
		fenceId: requireIdentity(fenceInput.fenceId),
		token: requireIdentity(fenceInput.token),
	}) as RuntimeFence;
	const request = await requireReleaseRequest(input.request);
	if (
		providerId !== lease.replica.providerId ||
		fence.fenceId !== lease.fenceId ||
		request.leaseId !== lease.leaseId ||
		!sameReplica(request.replica, lease.replica)
	) {
		releaseContractFailure("Execution environment release authority identities do not match");
	}
	return Object.freeze({ provider, lease, fence, request });
}

/** Strict total receipt decoder used at both provider and TaskAdapter boundaries. */
export async function requireExecutionEnvironmentReleaseResultV1(
	value: unknown,
	expected?: Pick<ExecutionEnvironmentRuntimeReleaseAuthorityV1, "lease" | "request">,
): Promise<RuntimeLeaseReleaseResult> {
	const input = exactDataRecord(value, RELEASE_RESULT_KEYS);
	const status = input.status;
	if (status !== "released" && status !== "already_released" && status !== "expired" && status !== "absent") {
		releaseContractFailure();
	}
	const compute = input.compute;
	if (compute !== "stopped" && compute !== "not_applicable") releaseContractFailure();
	const request = requireRequestIdentity(input.request);
	const replica = requireReplica(input.replica);
	const leaseId = requireIdentity(input.leaseId);
	await requireReleaseRequest({ ...request, replica, leaseId });
	if (
		expected &&
		(!sameRequestIdentity(request, expected.request) ||
			!sameReplica(replica, expected.lease.replica) ||
			leaseId !== expected.lease.leaseId)
	) {
		releaseContractFailure("Execution environment release receipt does not match its lease authority");
	}
	const result: RuntimeLeaseReleaseResult = Object.freeze({
		status,
		request,
		replica,
		leaseId,
		compute,
	});
	return result;
}

async function requireReleaseInspection(
	value: unknown,
	authority: ExecutionEnvironmentRuntimeReleaseAuthorityV1,
): Promise<RuntimeLeaseReleaseInspectResult> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) releaseContractFailure();
	const status = Object.getOwnPropertyDescriptor(value, "status")?.value;
	if (status === "complete") {
		const input = exactDataRecord(value, ["status", "result"] as const);
		return Object.freeze({
			status: "complete",
			result: await requireExecutionEnvironmentReleaseResultV1(input.result, authority),
		});
	}
	const keys =
		status === "in_progress"
			? (["status", "request", "replica", "leaseId", "compute", "observedAt"] as const)
			: (["status", "request", "replica", "leaseId"] as const);
	const input = exactDataRecord(value, keys);
	if (status !== "not_requested" && status !== "in_progress") releaseContractFailure();
	const request = requireRequestIdentity(input.request);
	const replica = requireReplica(input.replica);
	const leaseId = requireIdentity(input.leaseId);
	if (
		!sameRequestIdentity(request, authority.request) ||
		!sameReplica(replica, authority.lease.replica) ||
		leaseId !== authority.lease.leaseId
	) {
		releaseContractFailure("Execution environment release inspection does not match its lease authority");
	}
	if (status === "not_requested") return Object.freeze({ status, request, replica, leaseId });
	if (
		input.compute !== "not_applicable" &&
		input.compute !== "stopped" &&
		input.compute !== "running" &&
		input.compute !== "unknown"
	) {
		releaseContractFailure();
	}
	return Object.freeze({
		status,
		request,
		replica,
		leaseId,
		compute: input.compute,
		observedAt: requireIso8601(input.observedAt),
	}) as RuntimeLeaseReleaseInspectResult;
}

/** Submit or exact-inspect/replay one immutable release mutation. */
export async function reconcileExecutionEnvironmentRuntimeReleaseV1(
	authority: ExecutionEnvironmentRuntimeReleaseAuthorityV1,
	inspectFirst = false,
): Promise<RuntimeLeaseReleaseResult> {
	const errors: unknown[] = [];
	if (!inspectFirst) {
		try {
			return await requireExecutionEnvironmentReleaseResultV1(
				await authority.provider.release(authority.request),
				authority,
			);
		} catch (error) {
			errors.push(error);
		}
	}

	let inspection: RuntimeLeaseReleaseInspectResult;
	try {
		inspection = await requireReleaseInspection(
			await authority.provider.inspectRelease(authority.request),
			authority,
		);
	} catch (error) {
		errors.push(error);
		throw new ExecutionEnvironmentReleaseIndeterminateErrorV1(authority.request, null, errors);
	}
	if (inspection.status === "complete") return inspection.result;
	if (inspection.status === "in_progress") {
		throw new ExecutionEnvironmentReleaseIndeterminateErrorV1(authority.request, inspection, errors);
	}

	try {
		return await requireExecutionEnvironmentReleaseResultV1(
			await authority.provider.release(authority.request),
			authority,
		);
	} catch (error) {
		errors.push(error);
	}
	try {
		inspection = await requireReleaseInspection(
			await authority.provider.inspectRelease(authority.request),
			authority,
		);
	} catch (error) {
		errors.push(error);
		throw new ExecutionEnvironmentReleaseIndeterminateErrorV1(authority.request, null, errors);
	}
	if (inspection.status === "complete") return inspection.result;
	throw new ExecutionEnvironmentReleaseIndeterminateErrorV1(authority.request, inspection, errors);
}

type PathApi = typeof path.posix;

function isPathWithin(pathApi: PathApi, root: string, candidate: string): boolean {
	const relative = pathApi.relative(root, candidate);
	return (
		relative === "" ||
		(relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative))
	);
}

function requireCanonicalAbsolute(pathApi: PathApi, value: string, label: string): void {
	if (!pathApi.isAbsolute(value) || pathApi.resolve(value) !== value) {
		throw new Error(`${label} must be a canonical absolute path: ${value}`);
	}
}

function toRemotePath(pathApi: PathApi, sourceRoot: string, remoteRoot: string, sourcePath: string): string {
	const relative = pathApi.relative(sourceRoot, sourcePath);
	if (relative === "") return remoteRoot;
	return path.posix.join(remoteRoot, ...relative.split(pathApi.sep));
}

/**
 * Map a workspace path into the execution environment's POSIX namespace.
 *
 * Relative paths resolve below `sourceRoot`. Canonical absolute paths below
 * `sourceRoot` map to the corresponding path below `remoteRoot`, while
 * canonical absolute paths already below `remoteRoot` are returned unchanged.
 * Every other path is rejected.
 */
export function mapExecutionEnvironmentPath(
	environment: Pick<ExecutionEnvironmentBinding, "sourceRoot" | "remoteRoot">,
	inputPath: string,
): string {
	if (inputPath.length === 0 || inputPath.includes("\0")) {
		throw new Error("Execution environment path must be a non-empty filesystem path");
	}

	const localPath =
		path.win32.isAbsolute(environment.sourceRoot) && !path.posix.isAbsolute(environment.sourceRoot)
			? path.win32
			: path.posix;
	requireCanonicalAbsolute(localPath, environment.sourceRoot, "Execution environment sourceRoot");
	requireCanonicalAbsolute(path.posix, environment.remoteRoot, "Execution environment remoteRoot");

	if (path.posix.isAbsolute(inputPath)) {
		requireCanonicalAbsolute(path.posix, inputPath, "Execution environment path");
		if (isPathWithin(path.posix, environment.remoteRoot, inputPath)) return inputPath;
		if (localPath === path.posix && isPathWithin(localPath, environment.sourceRoot, inputPath)) {
			return toRemotePath(localPath, environment.sourceRoot, environment.remoteRoot, inputPath);
		}
		throw new Error(`Path is outside the execution environment workspace: ${inputPath}`);
	}

	if (localPath.isAbsolute(inputPath)) {
		requireCanonicalAbsolute(localPath, inputPath, "Execution environment path");
		if (!isPathWithin(localPath, environment.sourceRoot, inputPath)) {
			throw new Error(`Path is outside the execution environment workspace: ${inputPath}`);
		}
		return toRemotePath(localPath, environment.sourceRoot, environment.remoteRoot, inputPath);
	}

	if (path.win32.isAbsolute(inputPath)) {
		throw new Error(`Path is outside the execution environment workspace: ${inputPath}`);
	}

	const resolvedSourcePath = localPath.resolve(environment.sourceRoot, inputPath);
	if (!isPathWithin(localPath, environment.sourceRoot, resolvedSourcePath)) {
		throw new Error(`Path is outside the execution environment workspace: ${inputPath}`);
	}
	return toRemotePath(localPath, environment.sourceRoot, environment.remoteRoot, resolvedSourcePath);
}
