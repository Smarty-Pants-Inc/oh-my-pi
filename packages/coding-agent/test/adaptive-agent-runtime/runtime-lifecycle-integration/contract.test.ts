import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	PERSISTENT_RUNTIME_POLICY_DEFAULTS_V1,
	type PersistentAgentOpenRecordV1,
	type PersistentAgentOwnership,
	type PersistentAgentRecordCommitGuardV1,
	type PersistentAgentRecordV1,
	type WorkspaceId,
} from "../../../src/registry/persistent-agent-contracts.js";
import {
	DurableManagedWorkspaceSeedSourceStoreV1,
	FileRuntimeDurableStateStoreV1,
	ManagedWorkspaceStore,
	materializeWorkspaceSnapshotV1,
	readManagedWorkspaceSeedSourceV1,
} from "../../../src/session/managed-workspace.js";
import {
	PersistentWorkspaceAuthorityStoreV1,
	RuntimeAttachmentFileStoreV1,
	WorkspaceRuntimeControllerV1,
} from "../../../src/session/workspace-controller.js";
import {
	DeterministicRuntimeScheduler,
	WorkspaceRuntimeProviderRegistry,
} from "../../../src/session/workspace-provider-registry.js";
import {
	type FrozenReplicaCheckpointRef,
	PERSISTENT_WORKSPACE_PATH_MAPPER_V1,
	PERSISTENT_WORKSPACE_RETENTION_DEFAULTS_V1,
	type ReplicaCheckpoint,
	type RuntimeAcquireRequest,
	type RuntimeAcquireResult,
	type RuntimeAttachmentRecordV1,
	type RuntimeBinding,
	type RuntimeCheckpointAcknowledgeRequest,
	type RuntimeCheckpointAcknowledgeResult,
	type RuntimeCheckpointRequest,
	type RuntimeCheckpointResult,
	type RuntimeExecutionBridge,
	type RuntimeFence,
	type RuntimeInspectResult,
	type RuntimeLeaseRef,
	type RuntimeLeaseReleaseRequest,
	type RuntimeLeaseReleaseResult,
	type RuntimeProvider,
	type RuntimePushRequest,
	type RuntimePushResult,
	type RuntimeQuiesceRequest,
	type RuntimeQuiesceResult,
	type RuntimeReplicaCacheEvictionRequest,
	type RuntimeReplicaCacheEvictionRequestResult,
	type WorkspaceImage,
	type WorkspaceSnapshot,
} from "../../../src/session/workspace-runtime-contracts.js";

const START = "2026-08-06T00:00:00.000Z";
const SEED_LIMITS = {
	maxFiles: 10,
	maxFileBytes: 1024,
	maxTotalBytes: 1024,
	deniedPatterns: [],
} as const;

class Clock {
	#milliseconds = Date.parse(START);

	now = (): string => new Date(this.#milliseconds).toISOString();

	tick(milliseconds = 1_000): string {
		this.#milliseconds += milliseconds;
		return this.now();
	}

	advance(milliseconds: number): void {
		this.#milliseconds += milliseconds;
	}
}

class UnusedRuntimeBridge implements RuntimeExecutionBridge {
	#unavailable(): never {
		throw new Error("The runtime lifecycle fixture never uses an execution bridge");
	}

	async readTextFile(): Promise<never> {
		return this.#unavailable();
	}

	async readBinaryFile(): Promise<never> {
		return this.#unavailable();
	}

	async writeTextFile(): Promise<never> {
		return this.#unavailable();
	}

	async exists(): Promise<never> {
		return this.#unavailable();
	}

	async stat(): Promise<never> {
		return this.#unavailable();
	}

	async mkdir(): Promise<never> {
		return this.#unavailable();
	}

	async remove(): Promise<never> {
		return this.#unavailable();
	}

	async rename(): Promise<never> {
		return this.#unavailable();
	}

	async listFiles(): Promise<never> {
		return this.#unavailable();
	}

	async searchText(): Promise<never> {
		return this.#unavailable();
	}

	async submitCommand(): Promise<never> {
		return this.#unavailable();
	}

	async inspectCommand(): Promise<never> {
		return this.#unavailable();
	}

	async cancelCommand(): Promise<never> {
		return this.#unavailable();
	}

	async disposeCommand(): Promise<never> {
		return this.#unavailable();
	}
}

class RecordingRuntimeProvider implements RuntimeProvider {
	readonly supportedLocations = ["local"] as const;
	readonly calls: string[] = [];
	readonly receivedSnapshots: WorkspaceSnapshot[] = [];
	readonly evictionRequests: RuntimeReplicaCacheEvictionRequest[] = [];
	#lease: RuntimeLeaseRef | null = null;
	#fence: RuntimeFence | null = null;
	#image: WorkspaceImage | null = null;
	#frozen: FrozenReplicaCheckpointRef | null = null;
	#checkpoint: ReplicaCheckpoint | null = null;
	#acknowledged = false;
	readonly #bridge = new UnusedRuntimeBridge();
	#nextAcquireGate: {
		readonly entered: PromiseWithResolvers<void>;
		readonly release: PromiseWithResolvers<void>;
	} | null = null;
	#advanceNextDiscovery = false;

	constructor(
		readonly id: string,
		readonly profileId: string,
		readonly costMicrosPerHour: number,
		readonly clock: Clock,
		readonly order: string[],
	) {}

	#record(call: string): void {
		this.calls.push(call);
		this.order.push(`${this.id}:${call}`);
	}

	#active(): { readonly lease: RuntimeLeaseRef; readonly fence: RuntimeFence } {
		if (this.#lease === null || this.#fence === null) throw new Error(`${this.id} has no active lease`);
		return { lease: this.#lease, fence: this.#fence };
	}

	#unavailable(): never {
		throw new Error(`${this.id} lifecycle fixture received an unexpected provider call`);
	}

	blockNextAcquire(): { readonly entered: Promise<void>; readonly release: () => void } {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		this.#nextAcquireGate = { entered, release };
		this.#advanceNextDiscovery = true;
		return { entered: entered.promise, release: () => release.resolve() };
	}

	async discoverCandidates(): Promise<{
		readonly status: "available";
		readonly candidates: readonly [
			{
				readonly providerId: string;
				readonly profileId: string;
				readonly location: "local";
				readonly capabilities: readonly [];
				readonly workspaceFormats: readonly ["omp-text-v1"];
				readonly os: "linux";
				readonly arch: "arm64";
				readonly cpu: 1;
				readonly memoryMiB: 128;
				readonly network: "none";
				readonly available: true;
				readonly estimatedIncrementalCostMicrosPerHour: number;
				readonly estimatedReadyLatencyMs: 1;
			},
		];
	}> {
		this.#record("discover");
		if (this.#advanceNextDiscovery) {
			this.#advanceNextDiscovery = false;
			this.clock.tick();
		}
		return {
			status: "available",
			candidates: [
				{
					providerId: this.id,
					profileId: this.profileId,
					location: "local",
					capabilities: [],
					workspaceFormats: ["omp-text-v1"],
					os: "linux",
					arch: "arm64",
					cpu: 1,
					memoryMiB: 128,
					network: "none",
					available: true,
					estimatedIncrementalCostMicrosPerHour: this.costMicrosPerHour,
					estimatedReadyLatencyMs: 1,
				},
			],
		};
	}

	async acquire(request: RuntimeAcquireRequest): Promise<RuntimeAcquireResult> {
		this.#record("acquire");
		const gate = this.#nextAcquireGate;
		if (gate !== null) {
			gate.entered.resolve();
			await gate.release.promise;
			this.#nextAcquireGate = null;
		}
		const acquiredAt = this.clock.tick();
		const lease: RuntimeLeaseRef = {
			leaseId: request.plan.leaseId,
			replica: request.plan.replica,
			fenceId: request.plan.fenceId,
			baseGeneration: request.plan.baseCheckpoint.generation,
			renewalSequence: request.plan.initialRenewalSequence,
			acquiredAt,
			renewBy: new Date(Date.parse(acquiredAt) + 30_000).toISOString(),
			expiresAt: new Date(Date.parse(acquiredAt) + 60_000).toISOString(),
		};
		this.#lease = lease;
		this.#fence = request.fence;
		this.#acknowledged = false;
		const binding: RuntimeBinding = {
			lease,
			fence: request.fence,
			modelRoot: "/workspace",
			bridge: this.#bridge,
		};
		return {
			status: "acquired",
			request: {
				transitionId: request.transitionId,
				requestId: request.requestId,
				requestSha256: request.requestSha256,
			},
			lease,
			binding,
			providerPhase: "reserved",
			deletionAuthorityDomain: "persistent",
		};
	}

	async push(request: RuntimePushRequest): Promise<RuntimePushResult> {
		this.#record("push");
		const { lease, fence } = this.#active();
		if (request.lease.leaseId !== lease.leaseId || request.fence.token !== fence.token)
			throw new Error("push lost its exact lease or fence");
		this.receivedSnapshots.push(request.snapshot);
		this.#image = request.snapshot.checkpoint;
		this.clock.tick();
		return {
			status: "materialized",
			request: {
				transitionId: request.transitionId,
				requestId: request.requestId,
				requestSha256: request.requestSha256,
			},
			replica: lease.replica,
			canonicalGeneration: lease.baseGeneration,
			rootSha256: request.snapshot.checkpoint.rootSha256,
			fileCount: request.snapshot.checkpoint.fileCount,
			byteCount: request.snapshot.checkpoint.byteCount,
		};
	}

	async inspect(request: {
		readonly leaseId: string;
		readonly fence: RuntimeFence | null;
	}): Promise<RuntimeInspectResult> {
		this.#record("inspect");
		const { lease, fence } = this.#active();
		if (request.leaseId !== lease.leaseId || request.fence?.fenceId !== fence.fenceId)
			throw new Error("inspect lost its exact lease or fence");
		if (this.#image === null) throw new Error("inspect before push");
		this.clock.tick();
		return {
			status: "present",
			lease,
			providerPhase: "ready",
			compute: "running",
			activeCommands: 0,
			pendingSyncs: 0,
			replicaImage: this.#image,
		};
	}

	async quiesce(request: RuntimeQuiesceRequest): Promise<RuntimeQuiesceResult> {
		this.#record("quiesce");
		const { lease, fence } = this.#active();
		if (request.lease.leaseId !== lease.leaseId || request.fence.fenceId !== fence.fenceId)
			throw new Error("quiesce lost its exact lease or fence");
		this.clock.tick();
		return {
			status: "quiesced",
			request: {
				transitionId: request.transitionId,
				requestId: request.requestId,
				requestSha256: request.requestSha256,
			},
			lease,
			activeCommands: 0,
			pendingSyncs: 0,
		};
	}

	async checkpoint(request: RuntimeCheckpointRequest): Promise<RuntimeCheckpointResult> {
		this.#record("checkpoint");
		const { lease, fence } = this.#active();
		if (request.lease.leaseId !== lease.leaseId || request.fence.fenceId !== fence.fenceId)
			throw new Error("checkpoint lost its exact lease or fence");
		const snapshot = materializeWorkspaceSnapshotV1({
			workspaceId: lease.replica.workspaceId,
			generation: lease.baseGeneration + 1,
			committedAt: this.clock.tick(),
			files: [{ path: "runtime.txt", contentUtf8: "checkpointed by provider one" }],
		});
		const reference: FrozenReplicaCheckpointRef = {
			providerId: lease.replica.providerId,
			profileId: lease.replica.profileId,
			workspaceId: lease.replica.workspaceId,
			replicaId: lease.replica.replicaId,
			leaseId: lease.leaseId,
			checkpointId: request.checkpointId,
			format: "omp-text-v1",
			baseGeneration: lease.baseGeneration,
			frozenAt: snapshot.checkpoint.committedAt,
			rootSha256: snapshot.checkpoint.rootSha256,
			fileCount: snapshot.checkpoint.fileCount,
			byteCount: snapshot.checkpoint.byteCount,
		};
		this.#frozen = reference;
		this.#checkpoint = {
			reference,
			rootSha256: snapshot.checkpoint.rootSha256,
			fileCount: snapshot.checkpoint.fileCount,
			byteCount: snapshot.checkpoint.byteCount,
			files: snapshot.files,
		};
		return {
			status: "checkpointed",
			request: {
				transitionId: request.transitionId,
				requestId: request.requestId,
				requestSha256: request.requestSha256,
			},
			reference,
		};
	}

	async revoke(request: {
		readonly transitionId: string;
		readonly requestId: string;
		readonly requestSha256: string;
		readonly leaseId: string;
		readonly fenceId: string;
	}): Promise<{
		readonly status: "revoked";
		readonly request: { readonly transitionId: string; readonly requestId: string; readonly requestSha256: string };
		readonly replica: RuntimeLeaseRef["replica"];
		readonly leaseId: string;
		readonly fenceId: string;
	}> {
		this.#record("revoke");
		const { lease, fence } = this.#active();
		if (request.leaseId !== lease.leaseId || request.fenceId !== fence.fenceId)
			throw new Error("revoke lost its fence");
		this.clock.tick();
		return {
			status: "revoked",
			request: {
				transitionId: request.transitionId,
				requestId: request.requestId,
				requestSha256: request.requestSha256,
			},
			replica: lease.replica,
			leaseId: lease.leaseId,
			fenceId: fence.fenceId,
		};
	}

	async fetchCheckpoint(): Promise<{ readonly status: "fetched"; readonly checkpoint: ReplicaCheckpoint }> {
		this.#record("fetch");
		if (this.#checkpoint === null) throw new Error("fetch before checkpoint");
		this.clock.tick();
		return { status: "fetched", checkpoint: this.#checkpoint };
	}

	async acknowledgeCheckpoint(
		request: RuntimeCheckpointAcknowledgeRequest,
	): Promise<RuntimeCheckpointAcknowledgeResult> {
		this.#record("acknowledge");
		if (this.#frozen === null || request.reference.checkpointId !== this.#frozen.checkpointId)
			throw new Error("acknowledgement does not bind the frozen checkpoint");
		this.#acknowledged = true;
		const acknowledgedAt = this.clock.tick();
		return {
			status: "acknowledged",
			request: {
				parentOperationId: request.parentOperationId,
				requestId: request.requestId,
				requestSha256: request.requestSha256,
			},
			reference: request.reference,
			canonicalCommit: request.canonicalCommit,
			acknowledgedAt,
		};
	}

	async requestReplicaCacheEviction(
		request: RuntimeReplicaCacheEvictionRequest,
	): Promise<RuntimeReplicaCacheEvictionRequestResult> {
		this.#record("cache-eviction");
		this.evictionRequests.push(request);
		return {
			status: "accepted",
			acceptance: {
				requestId: request.requestId,
				requestSha256: request.requestSha256,
				replica: request.replica,
				retentionDeadline: request.retentionDeadline,
				acceptedAt: this.clock.tick(),
			},
		};
	}

	async release(request: RuntimeLeaseReleaseRequest): Promise<RuntimeLeaseReleaseResult> {
		this.#record("release");
		if (!this.#acknowledged) throw new Error("release before checkpoint acknowledgement");
		const { lease } = this.#active();
		if (request.leaseId !== lease.leaseId) throw new Error("release lost its exact lease");
		this.clock.tick();
		return {
			status: "released",
			request: {
				parentOperationId: request.parentOperationId,
				requestId: request.requestId,
				requestSha256: request.requestSha256,
			},
			replica: lease.replica,
			leaseId: lease.leaseId,
			compute: "stopped",
		};
	}

	async inspectAcquire(): Promise<never> {
		return this.#unavailable();
	}

	async renew(): Promise<never> {
		return this.#unavailable();
	}

	async inspectRenewal(): Promise<never> {
		return this.#unavailable();
	}

	async inspectPush(): Promise<never> {
		return this.#unavailable();
	}

	async inspectCommand(): Promise<never> {
		return this.#unavailable();
	}

	async reconcileCommandStart(): Promise<never> {
		return this.#unavailable();
	}

	async inspectQuiesce(): Promise<never> {
		return this.#unavailable();
	}

	async recoveryFreeze(): Promise<never> {
		return this.#unavailable();
	}

	async inspectRecoveryFreeze(): Promise<never> {
		return this.#unavailable();
	}

	async inspectCheckpoint(): Promise<never> {
		return this.#unavailable();
	}

	async inspectCheckpointAcknowledgement(): Promise<never> {
		return this.#unavailable();
	}

	async inspectRevoke(): Promise<never> {
		return this.#unavailable();
	}

	async inspectRelease(): Promise<never> {
		return this.#unavailable();
	}

	async inspectReplicaCacheEviction(): Promise<never> {
		return this.#unavailable();
	}

	async deleteReplica(): Promise<never> {
		return this.#unavailable();
	}

	async inspectReplicaDeletion(): Promise<never> {
		return this.#unavailable();
	}
}

describe("WorkspaceRuntimeControllerV1 runtime lifecycle integration", () => {
	it("preserves canonical continuity across a draining provider switch", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "omp-runtime-lifecycle-integration-"));
		try {
			const clock = new Clock();
			const workspaceId: WorkspaceId = "runtime-lifecycle-workspace";
			const durable = new FileRuntimeDurableStateStoreV1(join(root, "durable"));
			const authority = new PersistentWorkspaceAuthorityStoreV1({
				durable,
				now: clock.now,
				id: (() => {
					let sequence = 0;
					return () => `authority-${++sequence}`;
				})(),
				authorizePersistentCleanupProof: async () => false,
			});
			let record: PersistentAgentRecordV1;
			const ownership: PersistentAgentOwnership = {
				agentId: "runtime-lifecycle-agent",
				controlHostId: "runtime-lifecycle-host",
				intent: "open",
				ownerEpoch: 1,
				acquiredAt: clock.now(),
				isHeld: () => true,
				read: async () => ({ kind: "record", record }),
				insert: async next => {
					record = next;
					return next;
				},
				replace: async (expectedRevision, next, guard) => {
					if (!guard.isCurrent() || record.revision !== expectedRevision)
						throw new Error("durable ownership lost");
					record = next;
					return next;
				},
				deleteCreating: async () => {
					throw new Error("the open lifecycle fixture cannot delete a creating record");
				},
				close: async () => {},
			};
			const controllerLeaseResult = await authority.acquire({ workspaceId, ownership, ttlMs: 3_600_000 });
			if (controllerLeaseResult.status !== "acquired") throw new Error("controller lease was not acquired");
			const controllerLease = controllerLeaseResult.lease;
			const seeds = new DurableManagedWorkspaceSeedSourceStoreV1({ durable, now: clock.now });
			const canonical = new ManagedWorkspaceStore({ durable, authority, seedSources: seeds, now: clock.now });
			const seedPath = join(root, "seed");
			await mkdir(seedPath);
			await writeFile(join(seedPath, "initial.txt"), "canonical bytes");
			const seedRead = await readManagedWorkspaceSeedSourceV1({ sourcePath: seedPath, limits: SEED_LIMITS });
			const source = {
				sourceId: "runtime-lifecycle-seed",
				bindId: "runtime-lifecycle-seed-bind",
				expectedImage: seedRead.image,
				limits: SEED_LIMITS,
			};
			expect(await seeds.bind({ source, sourcePath: seedPath, expiresAt: "2026-08-07T00:00:00.000Z" })).toEqual({
				status: "bound",
			});
			const canonicalCreated = await canonical.create({
				createId: "runtime-lifecycle-workspace-create",
				stageId: "runtime-lifecycle-workspace-stage",
				workspaceId,
				seed: { kind: "copy", source },
				expectedImage: seedRead.image,
				retention: PERSISTENT_WORKSPACE_RETENTION_DEFAULTS_V1,
				controllerLease: controllerLease.proof,
			});
			if (canonicalCreated.status !== "created") throw new Error("canonical workspace was not created");
			record = {
				schemaVersion: 1,
				revision: 1,
				controlHostId: ownership.controlHostId,
				agentId: ownership.agentId,
				displayName: "Runtime lifecycle",
				kind: "main",
				parentAgentId: null,
				modelProfileId: "test-model",
				runtimePolicy: PERSISTENT_RUNTIME_POLICY_DEFAULTS_V1,
				createdAt: clock.now(),
				updatedAt: clock.now(),
				phase: "open",
				operation: null,
				session: {
					sessionId: "runtime-lifecycle-session",
					sessionStorageKey: "runtime-lifecycle.jsonl",
					sessionInitEntryId: "runtime-lifecycle-session-init",
				},
				workspace: {
					workspaceId,
					canonical: { state: "present", workspace: canonicalCreated.workspace },
					knownReplicas: { revision: 0, entries: [] },
				},
				releasedAt: null,
			} satisfies PersistentAgentOpenRecordV1;
			const attachments = new RuntimeAttachmentFileStoreV1({ durable, authority });
			const initialAttachment: RuntimeAttachmentRecordV1 = {
				schemaVersion: 1,
				createId: "runtime-lifecycle-attachment",
				revision: 1,
				workspaceId,
				attachment: {
					state: "none",
					transitionId: null,
					active: null,
					lastDiscardedRuntimeChanges: null,
					block: null,
				},
				scheduler: {
					input: null,
					providers: [],
					candidates: [],
					decision: { status: "not_evaluated" },
					evaluatedAt: null,
					durationMs: null,
				},
				lastCompletedTransition: null,
				updatedAt: clock.now(),
			};
			const attachmentCreated = await attachments.create({
				createId: initialAttachment.createId,
				initial: initialAttachment,
				controllerLease: controllerLease.proof,
			});
			expect(attachmentCreated.status).toBe("complete");

			const order: string[] = [];
			const first = new RecordingRuntimeProvider("provider-one", "profile-one", 3_600_000, clock, order);
			const second = new RecordingRuntimeProvider("provider-two", "profile-two", 7_200_000, clock, order);
			const providers = new WorkspaceRuntimeProviderRegistry();
			providers.register(first);
			providers.register(second);
			const guard: PersistentAgentRecordCommitGuardV1 = { isCurrent: () => true };
			const controller = new WorkspaceRuntimeControllerV1({
				workspaceId,
				ownership,
				controllerLeaseStore: authority,
				controllerLease,
				controllerLeaseTtlMs: 3_600_000,
				runtimeLeaseTtlMs: 60_000,
				commitGuard: guard,
				attachmentStore: attachments,
				canonicalStore: canonical,
				registry: providers,
				scheduler: new DeterministicRuntimeScheduler(),
				providerConfigurations: [
					{ providerId: first.id, enabled: true },
					{ providerId: second.id, enabled: true },
				],
				cacheEvictionDelayMsByProvider: { [first.id]: 10_000 },
				now: clock.now,
				identity: (() => {
					let sequence = 0;
					return () => `runtime-operation-${++sequence}`;
				})(),
				fenceToken: (() => {
					let sequence = 0;
					return () => `runtime-fence-${++sequence}`;
				})(),
			});
			const observer = new WorkspaceRuntimeControllerV1({
				workspaceId,
				ownership,
				controllerLeaseStore: authority,
				controllerLease,
				controllerLeaseTtlMs: 3_600_000,
				runtimeLeaseTtlMs: 60_000,
				commitGuard: guard,
				attachmentStore: attachments,
				canonicalStore: canonical,
				registry: providers,
				scheduler: new DeterministicRuntimeScheduler(),
				providerConfigurations: [
					{ providerId: first.id, enabled: true },
					{ providerId: second.id, enabled: true },
				],
				cacheEvictionDelayMsByProvider: { [first.id]: 10_000 },
				now: clock.now,
				identity: () => "observer-operation",
				fenceToken: () => "observer-fence",
			});

			const firstOperation = await controller.beginWorkspaceOperation(
				{
					capabilities: [],
					placement: "auto",
					configuredProviderId: first.id,
					workspaceFormat: "omp-text-v1",
					os: null,
					arch: null,
					minCpu: 0,
					minMemoryMiB: 0,
					network: "none",
					maxReadyLatencyMs: null,
				},
				"operation-one",
			);
			expect(first.receivedSnapshots).toEqual([
				{
					checkpoint: expect.objectContaining({ workspaceId, generation: 0 }),
					files: seedRead.files,
				},
			]);
			const attachmentBeforeSwitch = await attachments.read(workspaceId);
			if (attachmentBeforeSwitch.status !== "present")
				throw new Error("active attachment disappeared before switch");
			const acquireGate = second.blockNextAcquire();

			let drainSettled = false;
			const drain = controller.drainToNone("policy_change", true).then(checkpoint => {
				drainSettled = true;
				return checkpoint;
			});
			const queuedSecondOperation = controller.beginWorkspaceOperation(
				{
					capabilities: [],
					placement: "auto",
					configuredProviderId: second.id,
					workspaceFormat: "omp-text-v1",
					os: null,
					arch: null,
					minCpu: 0,
					minMemoryMiB: 0,
					network: "none",
					maxReadyLatencyMs: null,
				},
				"operation-two",
			);
			let secondOperationSettled = false;
			void queuedSecondOperation.then(() => {
				secondOperationSettled = true;
			});
			for (let index = 0; index < 20; index++) await Promise.resolve();
			expect(drainSettled).toBeFalse();
			expect(secondOperationSettled).toBeFalse();
			expect(first.calls).toEqual(["discover", "acquire", "push", "inspect"]);

			firstOperation.end();
			const committedCheckpoint = await drain;
			expect(committedCheckpoint).toMatchObject({ workspaceId, generation: 1 });
			await acquireGate.entered;
			const inProgressAttachment = await attachments.read(workspaceId);
			if (inProgressAttachment.status !== "present" || inProgressAttachment.record.attachment.state !== "acquiring")
				throw new Error("second acquisition did not durably enter its in-progress transition");
			expect(inProgressAttachment.record.revision).toBeGreaterThanOrEqual(
				attachmentBeforeSwitch.record.revision + 2,
			);
			expect(inProgressAttachment.record.updatedAt).toBe("2026-08-06T00:00:11.000Z");
			const inProgressStatus = await observer.status();
			expect(inProgressStatus).toMatchObject({
				state: "acquiring",
				providerId: second.id,
				transition: {
					status: "in_progress",
					currentFrom: "none",
					currentTo: "active",
					currentStartedAt: "2026-08-06T00:00:10.000Z",
				},
			});
			expect(inProgressStatus.transition.currentStartedAt).not.toBe(inProgressAttachment.record.updatedAt);
			acquireGate.release();
			const secondOperation = await queuedSecondOperation;
			expect(second.receivedSnapshots).toEqual([
				{
					checkpoint: expect.objectContaining({ workspaceId, generation: 1 }),
					files: [
						{
							path: PERSISTENT_WORKSPACE_PATH_MAPPER_V1.parse("runtime.txt").relativePath,
							contentUtf8: "checkpointed by provider one",
							sha256: expect.any(String),
							byteLength: 28,
						},
					],
				},
			]);
			expect(first.evictionRequests).toHaveLength(1);
			expect(order).toEqual([
				"provider-one:discover",
				"provider-two:discover",
				"provider-one:acquire",
				"provider-one:push",
				"provider-one:inspect",
				"provider-one:quiesce",
				"provider-one:checkpoint",
				"provider-one:revoke",
				"provider-one:fetch",
				"provider-one:acknowledge",
				"provider-one:cache-eviction",
				"provider-one:release",
				"provider-one:discover",
				"provider-two:discover",
				"provider-two:acquire",
				"provider-two:push",
				"provider-two:inspect",
			]);
			expect(order.indexOf("provider-one:release")).toBeLessThan(order.indexOf("provider-two:acquire"));

			clock.advance(3_000);
			const status = await controller.status();
			expect(status).toMatchObject({
				state: "active",
				providerId: second.id,
				profileId: second.profileId,
				workspaceGeneration: 1,
				activeOperationCount: 1,
				scheduler: {
					decision: { status: "selected", providerId: second.id, profileId: second.profileId },
				},
				transition: {
					lastCompleted: {
						reason: "first_tool",
						from: "none",
						to: "active",
						startedAt: "2026-08-06T00:00:11.000Z",
						completedAt: "2026-08-06T00:00:14.000Z",
					},
				},
				latency: {
					lastReadyLatencyMs: 3_000,
					accumulatedActiveRuntimeMs: 10_000,
					accumulatedZeroRuntimeIdleMs: 7_000,
				},
				replicaCleanup: {
					cacheEvictionPendingCount: 1,
					nextCleanupAt: first.evictionRequests[0]?.retentionDeadline,
				},
				cost: {
					availability: "available",
					estimateSource: "configured",
					unitRateMicrosPerHour: second.costMicrosPerHour,
					estimatedIncrementalCostMicrosPerHour: second.costMicrosPerHour,
					measuredActiveIntervalMs: 10_000,
					conservativeUpperBoundMicros: 20_000,
				},
			});
			secondOperation.end();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
