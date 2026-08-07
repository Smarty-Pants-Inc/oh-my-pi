import {
	type ExecutionEnvironmentBridge,
	type ExecutionEnvironmentLease,
	ExecutionEnvironmentReleaseIndeterminateErrorV1,
	type ExecutionEnvironmentRuntimeReleaseAuthorityV1,
	reconcileExecutionEnvironmentRuntimeReleaseV1,
} from "@oh-my-pi/pi-coding-agent/session/execution-environment";
import type { RuntimeLeaseReleaseResult } from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import {
	type BoundaryManifestEntry,
	CLOUD_OMP_REMOTE_ROOT,
	cloudOmpRoutes,
	type FilePayload,
	type FileReadRequest,
	type ManifestResponse,
	type WorkspaceState,
} from "../protocol";
import { auditErrorCode, type CloudOmpAuditWriter } from "./audit";
import {
	assertNotAborted,
	CloudOmpEnvironmentError,
	elapsedMs,
	retryTransportOnce,
	sanitizeEnvironmentError,
	validateFilePayload,
	validateManifestResponse,
	validateWorkspaceState,
} from "./environment-wire";
import type { CloudOmpJsonClient } from "./http";
import { type SyncBackResult, syncBack } from "./manifest";

export interface LeaseOptions {
	id: string;
	sourceRoot: string;
	bridge: ExecutionEnvironmentBridge;
	http: CloudOmpJsonClient;
	audit: CloudOmpAuditWriter;
	seedManifest: BoundaryManifestEntry[];
	seedRootSha256: string;
	releaseAuthority: ExecutionEnvironmentRuntimeReleaseAuthorityV1;
}

export class CloudflareEnvironmentLease implements ExecutionEnvironmentLease {
	readonly id: string;
	readonly sourceRoot: string;
	readonly remoteRoot = CLOUD_OMP_REMOTE_ROOT;
	readonly bridge: ExecutionEnvironmentBridge;
	readonly releaseAuthority: ExecutionEnvironmentRuntimeReleaseAuthorityV1;

	readonly #http: CloudOmpJsonClient;
	readonly #audit: CloudOmpAuditWriter;
	readonly #seedManifest: readonly BoundaryManifestEntry[];
	readonly #seedRootSha256: string;
	#syncPromise?: Promise<void>;
	#releasePromise?: Promise<RuntimeLeaseReleaseResult>;

	constructor(options: LeaseOptions) {
		this.id = options.id;
		this.sourceRoot = options.sourceRoot;
		this.bridge = options.bridge;
		this.#http = options.http;
		this.#audit = options.audit;
		this.#seedManifest = Object.freeze(options.seedManifest.map(entry => Object.freeze({ ...entry })));
		this.#seedRootSha256 = options.seedRootSha256;
		this.releaseAuthority = options.releaseAuthority;
		Object.freeze(this);
	}

	syncBack(signal?: AbortSignal): Promise<void> {
		if (this.#releasePromise)
			return Promise.reject(new CloudOmpEnvironmentError("environment", "sync_back", "LEASE_RELEASED"));
		this.#syncPromise ??= this.#performSyncBack(signal);
		return this.#syncPromise;
	}

	release(): Promise<RuntimeLeaseReleaseResult> {
		this.#releasePromise ??= this.#performRelease();
		return this.#releasePromise;
	}

	async #performSyncBack(signal?: AbortSignal): Promise<void> {
		assertNotAborted(signal, "sync_back");
		const startedAt = performance.now();
		try {
			const result: SyncBackResult = await syncBack({
				sourceRoot: this.sourceRoot,
				seedManifest: this.#seedManifest,
				seedRootSha256: this.#seedRootSha256,
				transport: {
					quiesce: requestSignal => this.#quiesce(requestSignal),
					getManifest: requestSignal => this.#getManifest(requestSignal),
					readFile: (path, requestSignal) => this.#readFile(path, requestSignal),
				},
				signal,
			});
			await this.#audit.record({
				operation: "sync_back",
				durationMs: elapsedMs(startedAt),
				outcome: "success",
				byteCount: result.totalBytes,
				fileCount: result.fileCount,
				seedRootSha256: this.#seedRootSha256,
				finalRootSha256: result.finalRootSha256,
			});
		} catch (error) {
			await this.#audit
				.record({
					operation: "sync_back",
					durationMs: elapsedMs(startedAt),
					outcome: signal?.aborted ? "cancelled" : "failed",
					seedRootSha256: this.#seedRootSha256,
					errorCode: auditErrorCode(error),
				})
				.catch(() => {});
			throw sanitizeEnvironmentError(error, signal, "sync_back");
		}
	}

	async #performRelease(): Promise<RuntimeLeaseReleaseResult> {
		if (this.#syncPromise) await this.#syncPromise.catch(() => {});
		const startedAt = performance.now();
		try {
			const receipt = await reconcileExecutionEnvironmentRuntimeReleaseV1(this.releaseAuthority);
			await this.#audit
				.record({
					operation: "release",
					durationMs: elapsedMs(startedAt),
					outcome: "success",
					cleanupState: "completed",
				})
				.catch(() => {});
			return receipt;
		} catch (error) {
			const failure =
				error instanceof ExecutionEnvironmentReleaseIndeterminateErrorV1 && error.errors.length > 0
					? error.errors[0]
					: error;
			await this.#audit
				.record({
					operation: "release",
					durationMs: elapsedMs(startedAt),
					outcome: "failed",
					cleanupState: "failed",
					errorCode: auditErrorCode(failure),
				})
				.catch(() => {});
			throw failure;
		}
	}

	async #quiesce(signal?: AbortSignal): Promise<WorkspaceState> {
		const value = await retryTransportOnce(() =>
			this.#http.requestJson<unknown>({ method: "POST", path: cloudOmpRoutes.quiesce(this.id), signal }),
		);
		return validateWorkspaceState(value, "quiesced");
	}

	async #getManifest(signal?: AbortSignal): Promise<ManifestResponse> {
		const value = await retryTransportOnce(() =>
			this.#http.requestJson<unknown>({ method: "GET", path: cloudOmpRoutes.manifest(this.id), signal }),
		);
		return validateManifestResponse(value);
	}

	async #readFile(path: string, signal?: AbortSignal): Promise<FilePayload> {
		const value = await retryTransportOnce(() =>
			this.#http.requestJson<unknown>({
				method: "POST",
				path: cloudOmpRoutes.fileRead(this.id),
				body: { path } satisfies FileReadRequest,
				signal,
			}),
		);
		validateFilePayload(value, path);
		return value;
	}
}
