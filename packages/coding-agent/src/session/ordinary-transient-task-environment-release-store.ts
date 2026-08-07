import { createHash } from "node:crypto";
import type { ISO8601, OperationId } from "../registry/persistent-agent-contracts.js";
import {
	ExecutionEnvironmentReleaseIndeterminateErrorV1,
	type ExecutionEnvironmentRuntimeReleaseAuthorityV1,
	freezeExecutionEnvironmentRuntimeReleaseAuthorityV1,
	reconcileExecutionEnvironmentRuntimeReleaseV1,
} from "./execution-environment.js";
import type { RuntimeDurableStateStoreV1 } from "./managed-workspace.js";
import type {
	OrdinaryTransientTaskExecutionEnvironmentReleaseStartupResultV1,
	PrivateOrdinaryTransientTaskEnvironmentReleaseAuthorityV1,
	PrivateOrdinaryTransientTaskEnvironmentReleaseIndexV1,
	PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1,
} from "./workspace-controller-codecs.js";
import {
	decodeOrdinaryTransientTaskEnvironmentReleaseIndex,
	exactJson,
	executionEnvironmentReleaseAuthoritySha256,
	lifecycleIdentity,
	nowIso,
	ORDINARY_TRANSIENT_TASK_ENVIRONMENT_RELEASE_NAMESPACE_V1,
	ordinaryTransientTaskEnvironmentReleaseIndexWithEntries,
	ordinaryTransientTaskEnvironmentReleaseRowSha256,
	proxyFreeData,
	strictRecord,
	validDetachedRecoveryOwnerIndex,
	validExecutionEnvironmentReleaseResult,
} from "./workspace-controller-codecs.js";
import type {
	ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1,
	OrdinaryTransientTaskExecutionEnvironmentReleaseBarrierV1,
	RuntimeLeaseReleaseResult,
	RuntimeProvider,
	RuntimeProviderRegistry,
	TransientTaskWorkspaceKeyV1,
} from "./workspace-runtime-contracts.js";

export class DurableOrdinaryTransientTaskExecutionEnvironmentReleaseStoreV1 {
	readonly #durable: RuntimeDurableStateStoreV1;
	readonly #ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1;
	readonly #providerRegistry: RuntimeProviderRegistry;
	readonly #now: () => ISO8601;

	constructor(options: {
		readonly durable: RuntimeDurableStateStoreV1;
		readonly ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1;
		readonly providerRegistry: RuntimeProviderRegistry;
		readonly now?: () => ISO8601;
	}) {
		if (!validDetachedRecoveryOwnerIndex(options.ownerSessionIndex))
			throw new TypeError("Transient task execution-environment release owner session is invalid");
		const { indexSha256: _indexSha256, ...ownerSessionCore } = options.ownerSessionIndex;
		const expectedIndexSha256 = `sha256:${createHash("sha256")
			.update(JSON.stringify(["async-job-owner-session-index", ownerSessionCore]), "utf8")
			.digest("hex")}`;
		if (options.ownerSessionIndex.indexSha256 !== expectedIndexSha256)
			throw new TypeError("Transient task execution-environment release owner-session digest is invalid");
		this.#durable = options.durable;
		this.#ownerSessionIndex = Object.freeze(structuredClone(options.ownerSessionIndex));
		this.#providerRegistry = options.providerRegistry;
		this.#now = options.now ?? nowIso;
	}

	#indexKey(): string {
		return this.#ownerSessionIndex.indexSha256;
	}

	#rowIdentity(key: TransientTaskWorkspaceKeyV1 & { readonly createId: OperationId }): string {
		return `${key.taskId}\u0000${key.runId}\u0000${key.createId}`;
	}

	async #prepare(
		key: TransientTaskWorkspaceKeyV1 & { readonly createId: OperationId },
		authority: ExecutionEnvironmentRuntimeReleaseAuthorityV1,
	): Promise<PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1> {
		const frozen = await freezeExecutionEnvironmentRuntimeReleaseAuthorityV1(authority);
		const serializableCore = {
			providerId: frozen.provider.id,
			lease: frozen.lease,
			fence: frozen.fence,
			request: frozen.request,
		};
		const serializable: PrivateOrdinaryTransientTaskEnvironmentReleaseAuthorityV1 = {
			...serializableCore,
			authoritySha256: executionEnvironmentReleaseAuthoritySha256(serializableCore),
		};
		const openedAt = this.#now();
		return this.#durable.transact(
			ORDINARY_TRANSIENT_TASK_ENVIRONMENT_RELEASE_NAMESPACE_V1,
			this.#indexKey(),
			currentInput => {
				const index = decodeOrdinaryTransientTaskEnvironmentReleaseIndex(currentInput, this.#ownerSessionIndex);
				const identity = this.#rowIdentity(key);
				const existing = index.entries.find(entry => this.#rowIdentity(entry) === identity);
				if (existing) {
					if (!exactJson(existing.authority, serializable))
						throw new Error("Transient task execution-environment release authority conflict");
					return { state: index, result: existing };
				}
				const core = {
					schemaVersion: 1 as const,
					taskId: key.taskId,
					runId: key.runId,
					createId: key.createId,
					authority: serializable,
					state: "release_not_applied" as const,
					receipt: null,
					openedAt,
					updatedAt: openedAt,
				};
				const row: PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1 = {
					...core,
					rowSha256: ordinaryTransientTaskEnvironmentReleaseRowSha256(core),
				};
				return {
					state: ordinaryTransientTaskEnvironmentReleaseIndexWithEntries(index, [...index.entries, row]),
					result: row,
				};
			},
		);
	}

	async #transitionToOutcomeUnknown(
		row: PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1,
	): Promise<PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1> {
		return this.#durable.transact(
			ORDINARY_TRANSIENT_TASK_ENVIRONMENT_RELEASE_NAMESPACE_V1,
			this.#indexKey(),
			currentInput => {
				const index = decodeOrdinaryTransientTaskEnvironmentReleaseIndex(currentInput, this.#ownerSessionIndex);
				const identity = this.#rowIdentity(row);
				const entryIndex = index.entries.findIndex(entry => this.#rowIdentity(entry) === identity);
				if (entryIndex < 0) throw new Error("Transient task execution-environment release row disappeared");
				const current = index.entries[entryIndex]!;
				if (!exactJson(current.authority, row.authority))
					throw new Error("Transient task execution-environment release authority changed");
				if (current.state !== "release_not_applied") return { state: index, result: current };
				const core = {
					...current,
					state: "release_outcome_unknown" as const,
					updatedAt: this.#now(),
				};
				const { rowSha256: _priorRowSha256, ...undigested } = core;
				const next = {
					...undigested,
					rowSha256: ordinaryTransientTaskEnvironmentReleaseRowSha256(undigested),
				};
				const entries = [...index.entries];
				entries[entryIndex] = next;
				return {
					state: ordinaryTransientTaskEnvironmentReleaseIndexWithEntries(index, entries),
					result: next,
				};
			},
		);
	}

	async #recordReleased(
		row: PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1,
		receipt: RuntimeLeaseReleaseResult,
	): Promise<RuntimeLeaseReleaseResult> {
		return this.#durable.transact(
			ORDINARY_TRANSIENT_TASK_ENVIRONMENT_RELEASE_NAMESPACE_V1,
			this.#indexKey(),
			currentInput => {
				const index = decodeOrdinaryTransientTaskEnvironmentReleaseIndex(currentInput, this.#ownerSessionIndex);
				const identity = this.#rowIdentity(row);
				const entryIndex = index.entries.findIndex(entry => this.#rowIdentity(entry) === identity);
				if (entryIndex < 0) throw new Error("Transient task execution-environment release row disappeared");
				const current = index.entries[entryIndex]!;
				if (!exactJson(current.authority, row.authority))
					throw new Error("Transient task execution-environment release authority changed");
				if (current.state === "released") return { state: index, result: current.receipt! };
				if (!validExecutionEnvironmentReleaseResult(receipt, current.authority))
					throw new TypeError("Transient task execution-environment release receipt is invalid");
				const core = {
					...current,
					state: "released" as const,
					receipt,
					updatedAt: this.#now(),
				};
				const { rowSha256: _priorRowSha256, ...undigested } = core;
				const next = {
					...undigested,
					rowSha256: ordinaryTransientTaskEnvironmentReleaseRowSha256(undigested),
				};
				const entries = [...index.entries];
				entries[entryIndex] = next;
				return {
					state: ordinaryTransientTaskEnvironmentReleaseIndexWithEntries(index, entries),
					result: receipt,
				};
			},
		);
	}

	async #runtimeAuthority(
		row: PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1,
		provider?: ExecutionEnvironmentRuntimeReleaseAuthorityV1["provider"],
	): Promise<ExecutionEnvironmentRuntimeReleaseAuthorityV1> {
		const resolved = provider ?? this.#providerRegistry.get(row.authority.providerId);
		if (resolved.id !== row.authority.providerId)
			throw new Error("Transient task execution-environment release provider identity changed");
		return freezeExecutionEnvironmentRuntimeReleaseAuthorityV1({
			provider: resolved,
			lease: row.authority.lease,
			fence: row.authority.fence,
			request: row.authority.request,
		});
	}

	async #dispatch(
		row: PrivateOrdinaryTransientTaskEnvironmentReleaseRowV1,
		authority: ExecutionEnvironmentRuntimeReleaseAuthorityV1,
		inspectFirst: boolean,
	): Promise<
		Exclude<OrdinaryTransientTaskExecutionEnvironmentReleaseBarrierV1, { readonly status: "not_applicable" }>
	> {
		if (row.state === "released") return Object.freeze({ status: "released", receipt: row.receipt! });
		try {
			const receipt = await reconcileExecutionEnvironmentRuntimeReleaseV1(authority, inspectFirst);
			return Object.freeze({ status: "released", receipt: await this.#recordReleased(row, receipt) });
		} catch (error) {
			if (error instanceof ExecutionEnvironmentReleaseIndeterminateErrorV1)
				return Object.freeze({ status: "release_outcome_unknown", request: row.authority.request });
			throw error;
		}
	}

	async release(
		key: TransientTaskWorkspaceKeyV1 & { readonly createId: OperationId },
		authority: ExecutionEnvironmentRuntimeReleaseAuthorityV1,
	): Promise<
		Exclude<OrdinaryTransientTaskExecutionEnvironmentReleaseBarrierV1, { readonly status: "not_applicable" }>
	> {
		if (
			!proxyFreeData(key) ||
			!strictRecord(key, ["taskId", "runId", "createId"]) ||
			![key.taskId, key.runId, key.createId].every(lifecycleIdentity)
		)
			throw new TypeError("Transient task execution-environment release key is invalid");
		const prepared = await this.#prepare(key, authority);
		if (prepared.state === "released") return Object.freeze({ status: "released", receipt: prepared.receipt! });
		const transitioned = await this.#transitionToOutcomeUnknown(prepared);
		const runtimeAuthority = await this.#runtimeAuthority(transitioned, authority.provider);
		return this.#dispatch(transitioned, runtimeAuthority, prepared.state !== "release_not_applied");
	}

	async reconcilePending(): Promise<OrdinaryTransientTaskExecutionEnvironmentReleaseStartupResultV1> {
		let index: PrivateOrdinaryTransientTaskEnvironmentReleaseIndexV1;
		try {
			index = decodeOrdinaryTransientTaskEnvironmentReleaseIndex(
				await this.#durable.inspect(ORDINARY_TRANSIENT_TASK_ENVIRONMENT_RELEASE_NAMESPACE_V1, this.#indexKey()),
				this.#ownerSessionIndex,
			);
		} catch {
			return { status: "invalid" };
		}
		const blocked: Extract<
			OrdinaryTransientTaskExecutionEnvironmentReleaseStartupResultV1,
			{ status: "blocked" }
		>["entries"][number][] = [];
		const pending = [...index.entries]
			.filter(entry => entry.state !== "released")
			.sort(
				(left, right) =>
					left.openedAt.localeCompare(right.openedAt) ||
					this.#rowIdentity(left).localeCompare(this.#rowIdentity(right)),
			);
		for (const entry of pending) {
			let provider: RuntimeProvider;
			try {
				provider = this.#providerRegistry.get(entry.authority.providerId);
			} catch {
				blocked.push({
					taskId: entry.taskId,
					runId: entry.runId,
					createId: entry.createId,
					providerId: entry.authority.providerId,
					reason: "provider_unavailable",
				});
				continue;
			}
			try {
				const transitioned = await this.#transitionToOutcomeUnknown(entry);
				const authority = await this.#runtimeAuthority(transitioned, provider);
				const result = await this.#dispatch(transitioned, authority, true);
				if (result.status === "release_outcome_unknown")
					blocked.push({
						taskId: entry.taskId,
						runId: entry.runId,
						createId: entry.createId,
						providerId: entry.authority.providerId,
						reason: "release_outcome_unknown",
					});
			} catch {
				return { status: "invalid" };
			}
		}
		return blocked.length === 0 ? { status: "ready" } : { status: "blocked", entries: blocked };
	}
}
