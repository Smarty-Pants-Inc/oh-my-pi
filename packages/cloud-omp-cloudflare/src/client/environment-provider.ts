import { randomBytes } from "node:crypto";
import type { ExecutionEnvironmentProvider, ExecutionEnvironmentRequest } from "@oh-my-pi/pi-coding-agent";
import { CLOUD_OMP_WORKSPACE_TTL_MS, isWireId } from "../protocol";
import { auditErrorCode, CloudOmpAuditWriter, createAuditCorrelationId, hashWorkspaceId } from "./audit";
import { CloudflareEnvironmentBridge } from "./environment-bridge";
import { CloudflareEnvironmentLease } from "./environment-lease";
import {
	assertNotAborted,
	bestEffortDelete,
	CloudOmpEnvironmentError,
	elapsedMs,
	once,
	retryWorkspacePutOnce,
	sanitizeEnvironmentError,
	scheduleReleaseAtExpiry,
	validateCreateWorkspaceResponse,
} from "./environment-wire";
import { type CloudOmpHttpClientOptions, type CloudOmpJsonClient, createOrdinaryJsonClient } from "./http";
import { buildCreateWorkspaceRequest, createSeedBundle, type SeedBundle } from "./manifest";

const REMOTE_SENTINEL_PATH = "remote-only.txt";
const REMOTE_SENTINEL_CONTENT = "remote sentinel from cloud-omp fixture\n";
const CONTAINER_INTERNET_ENABLED = true;

export interface CloudflareEnvironmentConfig {
	endpoint: string | URL;
	bearer: string;
	auditPath?: string;
	testRemoteSentinel?: boolean;
}

/** The only test seams: transport injection and deterministic workspace IDs. */
export interface CloudflareEnvironmentDependencies {
	fetch?: typeof globalThis.fetch;
	randomId?: () => string;
}

export function createCloudflareEnvironmentProvider(
	config: CloudflareEnvironmentConfig,
	dependencies: CloudflareEnvironmentDependencies = {},
): ExecutionEnvironmentProvider {
	return new CloudflareEnvironmentProvider(config, dependencies);
}

export class CloudflareEnvironmentProvider implements ExecutionEnvironmentProvider {
	readonly #config: Readonly<CloudflareEnvironmentConfig>;
	readonly #http: CloudOmpJsonClient;
	readonly #randomId: () => string;
	readonly #slot = new SingleLeaseSlot();

	constructor(config: CloudflareEnvironmentConfig, dependencies: CloudflareEnvironmentDependencies = {}) {
		this.#config = Object.freeze({
			endpoint: config.endpoint instanceof URL ? config.endpoint.href : config.endpoint,
			bearer: config.bearer,
			...(config.auditPath === undefined ? {} : { auditPath: config.auditPath }),
			testRemoteSentinel: config.testRemoteSentinel === true,
		});
		const httpOptions: CloudOmpHttpClientOptions = {
			endpoint: this.#config.endpoint,
			bearer: this.#config.bearer,
			...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
		};
		this.#http = createOrdinaryJsonClient(httpOptions);
		this.#randomId = dependencies.randomId ?? (() => randomBytes(16).toString("hex"));
		Object.freeze(this);
	}

	async acquire(request: ExecutionEnvironmentRequest) {
		const startedAt = performance.now();
		assertNotAborted(request.signal, "acquire");
		const releaseSlot = await this.#slot.acquire(request.signal);
		let workspaceId = "";
		let audit: CloudOmpAuditWriter | undefined;
		let seed: SeedBundle | undefined;
		let expiresAt: number | undefined;
		let workspaceCreateAttempted = false;

		try {
			workspaceId = this.#randomId();
			if (!isWireId(workspaceId))
				throw new CloudOmpEnvironmentError("environment", "acquire", "INVALID_GENERATED_ID");
			const correlationId = createAuditCorrelationId();
			audit = new CloudOmpAuditWriter(
				{
					correlationId,
					workspaceIdSha256: hashWorkspaceId(workspaceId),
					ownerId: request.ownerId,
					sessionId: request.sessionId,
					containerInternetEnabled: CONTAINER_INTERNET_ENABLED,
				},
				{ path: this.#config.auditPath },
			);
			seed = await createSeedBundle(request.sourceRoot, request.signal);
			const createRequest = buildCreateWorkspaceRequest(correlationId, seed);
			workspaceCreateAttempted = true;
			const response = await retryWorkspacePutOnce(this.#http, workspaceId, createRequest, request.signal);
			expiresAt = validateCreateWorkspaceResponse(response, workspaceId);

			const bridge = new CloudflareEnvironmentBridge(this.#http, workspaceId, audit);
			if (this.#config.testRemoteSentinel) {
				await bridge.writeInternal(REMOTE_SENTINEL_PATH, REMOTE_SENTINEL_CONTENT, request.signal);
			}
			await audit.record({
				operation: "acquire",
				durationMs: elapsedMs(startedAt),
				outcome: "success",
				byteCount: seed.totalBytes,
				fileCount: seed.files.length,
				seedRootSha256: seed.seedRootSha256,
				cleanupState: "not_started",
			});

			return new CloudflareEnvironmentLease({
				id: workspaceId,
				sourceRoot: request.sourceRoot,
				bridge,
				http: this.#http,
				audit,
				seedManifest: seed.seedManifest,
				seedRootSha256: seed.seedRootSha256,
				expiresAt: expiresAt!,
				releaseSlot,
			});
		} catch (error) {
			const cleanupResult = workspaceId ? await bestEffortDelete(this.#http, workspaceId) : "released";
			if (audit) {
				await audit
					.record({
						operation: "acquire",
						durationMs: elapsedMs(startedAt),
						outcome: request.signal?.aborted ? "cancelled" : "failed",
						...(seed
							? { byteCount: seed.totalBytes, fileCount: seed.files.length, seedRootSha256: seed.seedRootSha256 }
							: {}),
						cleanupState: cleanupResult === "released" ? "completed" : "failed",
						errorCode: auditErrorCode(error),
					})
					.catch(() => {});
			}
			if (cleanupResult === "released") releaseSlot();
			else if (cleanupResult === "ambiguous") {
				// A post-cleanup timestamp keeps the slot held for at least a full server TTL after uncertainty.
				const fallbackExpiryAt = workspaceCreateAttempted ? Date.now() + CLOUD_OMP_WORKSPACE_TTL_MS : undefined;
				const slotExpiryAt = expiresAt ?? fallbackExpiryAt;
				if (slotExpiryAt !== undefined) scheduleReleaseAtExpiry(releaseSlot, slotExpiryAt);
			}
			throw sanitizeEnvironmentError(error, request.signal, "acquire");
		}
	}
}

interface LeaseWaiter {
	resolve: (release: () => void) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

class SingleLeaseSlot {
	#held = false;
	readonly #waiters: LeaseWaiter[] = [];

	acquire(signal?: AbortSignal): Promise<() => void> {
		assertNotAborted(signal, "slot");
		if (!this.#held) {
			this.#held = true;
			return Promise.resolve(once(() => this.#release()));
		}
		const { promise, resolve, reject } = Promise.withResolvers<() => void>();
		const waiter: LeaseWaiter = { resolve, reject, signal };
		if (signal) {
			waiter.onAbort = () => {
				const index = this.#waiters.indexOf(waiter);
				if (index >= 0) this.#waiters.splice(index, 1);
				reject(new CloudOmpEnvironmentError("abort", "slot", "ABORTED"));
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		}
		this.#waiters.push(waiter);
		return promise;
	}

	#release(): void {
		for (;;) {
			const waiter = this.#waiters.shift();
			if (!waiter) {
				this.#held = false;
				return;
			}
			if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal?.aborted) continue;
			waiter.resolve(once(() => this.#release()));
			return;
		}
	}
}
