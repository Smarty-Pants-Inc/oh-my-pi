import type { ExecutionEnvironmentBridge, ExecutionEnvironmentLease } from "@oh-my-pi/pi-coding-agent";
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
	once,
	retryTransportOnce,
	sanitizeEnvironmentError,
	scheduleReleaseAtExpiry,
	validateFilePayload,
	validateManifestResponse,
	validateWorkspaceState,
} from "./environment-wire";
import { type CloudOmpJsonClient, CloudOmpTransportError } from "./http";
import { type SyncBackResult, syncBack } from "./manifest";

export interface LeaseOptions {
	id: string;
	sourceRoot: string;
	bridge: ExecutionEnvironmentBridge;
	http: CloudOmpJsonClient;
	audit: CloudOmpAuditWriter;
	seedManifest: BoundaryManifestEntry[];
	seedRootSha256: string;
	expiresAt: number;
	releaseSlot: () => void;
}

export class CloudflareEnvironmentLease implements ExecutionEnvironmentLease {
	readonly id: string;
	readonly sourceRoot: string;
	readonly remoteRoot = CLOUD_OMP_REMOTE_ROOT;
	readonly bridge: ExecutionEnvironmentBridge;

	readonly #http: CloudOmpJsonClient;
	readonly #audit: CloudOmpAuditWriter;
	readonly #seedManifest: readonly BoundaryManifestEntry[];
	readonly #seedRootSha256: string;
	readonly #expiresAt: number;
	readonly #releaseSlot: () => void;
	#syncPromise?: Promise<void>;
	#releasePromise?: Promise<void>;

	constructor(options: LeaseOptions) {
		this.id = options.id;
		this.sourceRoot = options.sourceRoot;
		this.bridge = options.bridge;
		this.#http = options.http;
		this.#audit = options.audit;
		this.#seedManifest = Object.freeze(options.seedManifest.map(entry => Object.freeze({ ...entry })));
		this.#seedRootSha256 = options.seedRootSha256;
		this.#expiresAt = options.expiresAt;
		this.#releaseSlot = once(options.releaseSlot);
		Object.freeze(this);
	}

	syncBack(signal?: AbortSignal): Promise<void> {
		if (this.#releasePromise)
			return Promise.reject(new CloudOmpEnvironmentError("environment", "sync_back", "LEASE_RELEASED"));
		this.#syncPromise ??= this.#performSyncBack(signal);
		return this.#syncPromise;
	}

	release(): Promise<void> {
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

	async #performRelease(): Promise<void> {
		if (this.#syncPromise) await this.#syncPromise.catch(() => {});
		const startedAt = performance.now();
		let remoteReleased = false;
		let cleanupAmbiguous = false;
		try {
			await retryTransportOnce(() =>
				this.#http.requestEmpty({ method: "DELETE", path: cloudOmpRoutes.workspace(this.id) }),
			);
			remoteReleased = true;
			await this.#audit.record({
				operation: "release",
				durationMs: elapsedMs(startedAt),
				outcome: "success",
				cleanupState: "completed",
			});
		} catch (error) {
			cleanupAmbiguous = error instanceof CloudOmpTransportError;
			await this.#audit
				.record({
					operation: "release",
					durationMs: elapsedMs(startedAt),
					outcome: "failed",
					cleanupState: remoteReleased ? "completed" : "failed",
					errorCode: auditErrorCode(error),
				})
				.catch(() => {});
			throw sanitizeEnvironmentError(error, undefined, "release");
		} finally {
			if (remoteReleased) this.#releaseSlot();
			else if (cleanupAmbiguous) scheduleReleaseAtExpiry(this.#releaseSlot, this.#expiresAt);
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
