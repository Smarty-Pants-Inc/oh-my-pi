import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createPersistentAgentRecoveryRequiredRecordV1,
	persistentAgentInterruptedRecoveryCodeV1,
	persistentAgentRecoveryActionsV1,
} from "../../../src/registry/agent-lifecycle.js";
import { AgentRegistry } from "../../../src/registry/agent-registry.js";
import { registerPersistedSubagents } from "../../../src/registry/persisted-agents.js";
import type {
	KnownReplicaCatalogV1,
	KnownReplicaRecordV1,
	PersistentAgentCreatingRecordV1,
	PersistentAgentForkingRecordV1,
	PersistentAgentOpenRecordV1,
	PersistentAgentReleasedRecordV1,
	PersistentWorkspaceAuthorityV1,
	TerminalReplicaCleanupProofV1,
	WorkspaceDeletionPlanCoreV1,
} from "../../../src/registry/persistent-agent-contracts.js";
import { PERSISTENT_RUNTIME_POLICY_DEFAULTS_V1 } from "../../../src/registry/persistent-agent-contracts.js";
import {
	appendKnownReplicaV1,
	FilePersistentAgentStore,
	type MaterializedWorkspaceDeletionPlanV1,
	materializeWorkspaceDeletionPlanV1,
	persistentAgentStorageKeyV1,
	replaceKnownReplicaV1,
	terminalReplicaCleanupProofSha256V1,
	validatePersistentAgentRecordV1,
	validatePersistentWorkspaceAuthorityV1,
} from "../../../src/registry/persistent-agent-store.js";
import type { RuntimeReplicaRef } from "../../../src/session/workspace-runtime-contracts.js";
import { PERSISTENT_WORKSPACE_RETENTION_DEFAULTS_V1 } from "../../../src/session/workspace-runtime-contracts.js";
import { createTransientTaskGitEffectSafetyRuntimeV1 } from "../../../src/utils/git.js";

const ZERO_SHA256 = "0".repeat(64);
const ZERO_SHA256_REF = `sha256:${ZERO_SHA256}` as const;
const CREATED_AT = "2026-08-06T12:00:00.000Z";
const SECOND_AT = "2026-08-06T12:00:01.000Z";
const RELEASED_AT = "2026-08-06T12:02:00.000Z";
const PURGED_AT = "2026-08-06T12:01:00.000Z";

function creatingRecord(agentId = "Alpha", controlHostId = "host-a"): PersistentAgentCreatingRecordV1 {
	return {
		schemaVersion: 1,
		revision: 1,
		controlHostId,
		agentId,
		displayName: agentId,
		kind: "sub",
		parentAgentId: "Main",
		modelProfileId: "default-model",
		runtimePolicy: PERSISTENT_RUNTIME_POLICY_DEFAULTS_V1,
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
		phase: "creating",
		operation: {
			kind: "create",
			plan: {
				kind: "create",
				operationId: "create-operation",
				startedAt: CREATED_AT,
				startedFromRevision: 0,
				resources: {
					workspaceId: "workspace-alpha",
					workspaceCreateId: "workspace-create",
					workspaceStageId: "workspace-stage",
					sessionCreateId: "session-create",
					session: {
						sessionId: "session-alpha",
						sessionStorageKey: "sessions/alpha.jsonl",
						sessionInitEntryId: "session-init",
					},
					runtimeAttachmentCreateId: "runtime-attachment-create",
				},
				seed: {
					kind: "empty",
					expectedImage: { rootSha256: ZERO_SHA256, fileCount: 0, byteCount: 0 },
				},
				retention: PERSISTENT_WORKSPACE_RETENTION_DEFAULTS_V1,
				sessionInitPayloadSha256: ZERO_SHA256_REF,
			},
			progress: { step: "planned" },
		},
		releasedAt: null,
	};
}

function knownReplica(ref: RuntimeReplicaRef, operationId: string): KnownReplicaRecordV1 {
	return {
		replica: ref,
		plannedByOperationId: operationId,
		deletionAuthorityDomain: "persistent",
		firstPlannedAt: CREATED_AT,
		lastLeaseId: null,
		observation: { state: "never_observed" },
		cacheEviction: { state: "not_requested" },
		cleanup: { state: "not_requested" },
	};
}

function sessionRef(sessionId = "session-alpha") {
	return {
		sessionId,
		sessionStorageKey: `sessions/${sessionId}.jsonl`,
		sessionInitEntryId: `session-init-${sessionId}`,
	};
}

function presentWorkspace(): PersistentWorkspaceAuthorityV1 {
	return {
		workspaceId: "workspace-alpha",
		canonical: {
			state: "present",
			workspace: {
				workspaceId: "workspace-alpha",
				mode: "managed",
				format: "omp-text-v1",
				retention: PERSISTENT_WORKSPACE_RETENTION_DEFAULTS_V1,
				checkpoint: {
					workspaceId: "workspace-alpha",
					generation: 3,
					rootSha256: ZERO_SHA256,
					fileCount: 0,
					byteCount: 0,
					committedAt: CREATED_AT,
				},
			},
		},
		knownReplicas: { revision: 0, entries: [] },
	};
}

function commonRecord(controlHostId: string, revision: number, updatedAt = SECOND_AT) {
	return {
		schemaVersion: 1 as const,
		revision,
		controlHostId,
		agentId: "Alpha",
		displayName: "Alpha",
		kind: "sub" as const,
		parentAgentId: "Main",
		modelProfileId: "default-model",
		runtimePolicy: PERSISTENT_RUNTIME_POLICY_DEFAULTS_V1,
		createdAt: CREATED_AT,
		updatedAt,
	};
}

function forkingRecord(controlHostId: string): PersistentAgentForkingRecordV1 {
	const source = sessionRef("session-source");
	const target = sessionRef("session-target");
	return {
		...commonRecord(controlHostId, 4),
		phase: "forking",
		operation: {
			kind: "fork",
			plan: {
				kind: "fork",
				operationId: "fork-operation",
				startedAt: CREATED_AT,
				startedFromRevision: 3,
				source,
				target,
				targetCreateId: "fork-target-create",
				workspaceId: "workspace-alpha",
				expectedGeneration: 3,
			},
			progress: { step: "target_durable", target, targetSha256: ZERO_SHA256_REF },
		},
		session: source,
		workspace: presentWorkspace(),
		releasedAt: null,
	};
}

function tombstonedAuthority(
	materialized: MaterializedWorkspaceDeletionPlanV1,
	cleanupProof: TerminalReplicaCleanupProofV1 | null,
): PersistentWorkspaceAuthorityV1 {
	return {
		workspaceId: materialized.deletion.core.workspaceId,
		canonical: {
			state: "tombstoned",
			tombstone: materialized.tombstone,
			deletion: materialized.deletion,
			deletionPlanCoreSha256: materialized.deletionPlanCoreSha256,
			deletionPlanSha256: materialized.deletionPlanSha256,
			cleanupProof,
		},
		knownReplicas: { revision: 0, entries: [] },
	};
}

function releasedRecord(
	controlHostId: string,
	revision: number,
	workspace: PersistentWorkspaceAuthorityV1,
): PersistentAgentReleasedRecordV1 {
	return {
		...commonRecord(controlHostId, revision, RELEASED_AT),
		phase: "released",
		operation: null,
		session: sessionRef(),
		workspace,
		release: {
			operationId: "release-operation",
			disposition: {
				kind: "delete",
				deleteId: "delete-workspace",
				deletionAuthorityId: "delete-authority",
				quarantineId: "quarantine-workspace",
				deletedBytesGraceMs: 5_000,
			},
			completedAt: RELEASED_AT,
		},
		releasedAt: RELEASED_AT,
	};
}

describe("StoreLifecycleCore contract", () => {
	it("keeps Git runtime minting package-private, identity-bound, and constructor-time", async () => {
		expect(() => createTransientTaskGitEffectSafetyRuntimeV1(Object.freeze({}))).toThrow(
			"Unauthorized Git runtime creation.",
		);

		const blockedPackageSubpath = "@oh-my-pi/pi-coding-agent/registry/persistent-agent-store";
		// This specifier is runtime-selected because a static import is forbidden by
		// the package export map; rejection is the behavior under test.
		await expect(import(blockedPackageSubpath)).rejects.toThrow();

		using temp = TempDir.createSync("@omp-persistent-store-git-");
		const store = await FilePersistentAgentStore.open({
			rootDir: path.join(temp.path(), "persistent-agents", "v1"),
			controlHostId: "host-a",
		});
		expect(store.controlHostId).toBe("host-a");
	});

	it("strict-decodes records without fabricating phases or persisting a copy source path", async () => {
		expect(await validatePersistentAgentRecordV1(creatingRecord(), "alpha")).toMatchObject({ ok: true });

		const invalidPhase = { ...creatingRecord(), phase: "running" };
		expect(await validatePersistentAgentRecordV1(invalidPhase, "Alpha")).toEqual({
			ok: false,
			reason: "invalid_phase_relationship",
		});

		const record = creatingRecord();
		const invalidSeed = {
			...record,
			operation: {
				...record.operation,
				plan: {
					...record.operation.plan,
					seed: { ...record.operation.plan.seed, sourcePath: "/private/source" },
				},
			},
		};
		expect(await validatePersistentAgentRecordV1(invalidSeed, "Alpha")).toEqual({
			ok: false,
			reason: "invalid_fields",
		});

		const mismatchedRecovery = createPersistentAgentRecoveryRequiredRecordV1(
			record,
			"interrupted_open",
			"2026-08-06T12:00:01.000Z",
		);
		expect(await validatePersistentAgentRecordV1(mismatchedRecovery, "Alpha")).toEqual({
			ok: false,
			reason: "invalid_phase_relationship",
		});
	});

	it("reserves exact Main identity and rejects cross-role operation ID substitution", async () => {
		const create = creatingRecord();
		expect(
			await validatePersistentAgentRecordV1(
				{ ...create, agentId: "Main", displayName: "Main", kind: "sub", parentAgentId: "Root" },
				"Main",
			),
		).toMatchObject({ ok: false, reason: "invalid_phase_relationship" });
		expect(
			await validatePersistentAgentRecordV1({ ...create, kind: "main", parentAgentId: null }, "Alpha"),
		).toMatchObject({ ok: false, reason: "invalid_phase_relationship" });
		expect(
			await validatePersistentAgentRecordV1(
				{ ...create, agentId: "Main", displayName: "Main", kind: "main", parentAgentId: null },
				"main",
			),
		).toMatchObject({ ok: true });
		expect(
			await validatePersistentAgentRecordV1({
				...create,
				operation: {
					...create.operation,
					plan: {
						...create.operation.plan,
						operationId: create.operation.plan.resources.workspaceCreateId,
					},
				},
			}),
		).toMatchObject({ ok: false });
	});

	it("fences ownership by a process lock and monotonically advances the durable owner epoch", async () => {
		using temp = TempDir.createSync("@omp-persistent-store-owner-");
		const rootDir = path.join(temp.path(), "persistent-agents", "v1");
		const store = await FilePersistentAgentStore.open({ rootDir, controlHostId: "host-a" });
		const first = await store.acquire("Alpha", "create");
		expect(first.ownerEpoch).toBe(1);
		expect(await store.inspectOwnership("alpha")).toMatchObject({ state: "owned_here", processId: process.pid });
		await expect(store.acquire("ALPHA", "recover")).rejects.toMatchObject({ code: "owned_elsewhere" });

		const inserted = await first.insert(creatingRecord());
		expect(inserted.revision).toBe(1);
		const recovery = createPersistentAgentRecoveryRequiredRecordV1(
			inserted,
			persistentAgentInterruptedRecoveryCodeV1(inserted),
			"2026-08-06T12:00:01.000Z",
		);
		expect(await validatePersistentAgentRecordV1(recovery, "alpha")).toMatchObject({ ok: true });
		expect(persistentAgentRecoveryActionsV1(recovery)).toEqual(["retry-create", "discard-creation"]);
		const commitGuard = new AgentRegistry().createPersistentCommitGuard("Alpha", null, null);
		expect((await first.replace(1, recovery, commitGuard)).revision).toBe(2);
		await first.close();

		const second = await store.acquire("alpha", "recover");
		expect(second.ownerEpoch).toBe(2);
		await second.close();

		const ownershipPath = path.join(rootDir, "ownership", `${persistentAgentStorageKeyV1("Alpha")}.json`);
		await Bun.write(
			ownershipPath,
			'{"schemaVersion":1,"agentId":"Alpha","controlHostId":"host-a","ownerEpoch":0,"updatedAt":"2026-08-06T12:00:02.000Z"}\n',
		);
		await expect(store.acquire("Alpha", "recover")).rejects.toMatchObject({ code: "ownership_unavailable" });
		expect(JSON.parse(await Bun.file(ownershipPath).text()).ownerEpoch).toBe(0);
	});

	it("serializes same-owner CAS and rejects stale or throwing registry commit guards", async () => {
		using temp = TempDir.createSync("@omp-persistent-store-guard-");
		const store = await FilePersistentAgentStore.open({
			rootDir: path.join(temp.path(), "persistent-agents", "v1"),
			controlHostId: "host-a",
		});
		const ownership = await store.acquire("Alpha", "create");
		const creating = await ownership.insert(creatingRecord());
		const recovery = createPersistentAgentRecoveryRequiredRecordV1(
			creating,
			"interrupted_create",
			"2026-08-06T12:00:01.000Z",
		);
		const alternateRecovery = createPersistentAgentRecoveryRequiredRecordV1(
			creating,
			"seed_source_binding_missing",
			"2026-08-06T12:00:01.000Z",
		);

		const registry = new AgentRegistry();
		const binding = { recordRevision: 1, ownerEpoch: ownership.ownerEpoch, recordPhase: "creating" } as const;
		const ref = registry.register({
			id: "Alpha",
			displayName: "Alpha",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
			persistent: binding,
		});
		const staleGuard = registry.createPersistentCommitGuard("alpha", ref, binding);
		registry.unregister("Alpha", ref);
		await expect(ownership.replace(1, recovery, staleGuard)).rejects.toMatchObject({ code: "revision_conflict" });
		await expect(
			ownership.replace(1, recovery, {
				isCurrent: () => {
					throw new Error("stale registry generation");
				},
			}),
		).rejects.toMatchObject({ code: "revision_conflict" });
		expect(await ownership.read()).toMatchObject({ kind: "record", record: { revision: 1 } });

		const absentGuard = registry.createPersistentCommitGuard("ALPHA", null, null);
		const results = await Promise.allSettled([
			ownership.replace(1, recovery, absentGuard),
			ownership.replace(1, alternateRecovery, absentGuard),
		]);
		expect(results[0]).toMatchObject({ status: "fulfilled", value: recovery });
		expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "revision_conflict" } });
		await ownership.close();
		expect(await store.lookup("alpha")).toMatchObject({
			kind: "record",
			record: { phase: "recovery_required", revision: 2 },
		});
	});

	it("binds exactly one process-owned store with reference-counted release", async () => {
		using temp = TempDir.createSync("@omp-persistent-store-registry-");
		const first = await FilePersistentAgentStore.open({
			rootDir: path.join(temp.path(), "first", "persistent-agents", "v1"),
			controlHostId: "host-a",
		});
		const second = await FilePersistentAgentStore.open({
			rootDir: path.join(temp.path(), "second", "persistent-agents", "v1"),
			controlHostId: "host-a",
		});
		const registry = new AgentRegistry();
		expect(() => registry.requireProcessOwnedPersistentAgentStore()).toThrow(
			"Process-owned persistent agent store authority is not bound",
		);
		const releaseFirst = registry.bindProcessOwnedPersistentAgentStore(first);
		const releaseSecond = registry.bindProcessOwnedPersistentAgentStore(first);
		expect(registry.requireProcessOwnedPersistentAgentStore()).toBe(first);
		expect(() => registry.bindProcessOwnedPersistentAgentStore(second)).toThrow(
			"A different process-owned persistent agent store is already bound",
		);
		releaseFirst();
		releaseFirst();
		expect(registry.requireProcessOwnedPersistentAgentStore()).toBe(first);
		releaseSecond();
		expect(() => registry.requireProcessOwnedPersistentAgentStore()).toThrow(
			"Process-owned persistent agent store authority is not bound",
		);
	});

	it("binds persistent registry coordinates monotonically and case-insensitively fences identity", () => {
		const registry = new AgentRegistry();
		const ref = registry.register({
			id: "Alpha",
			displayName: "Alpha",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		expect(() => registry.createPersistentCommitGuard("alpha", null, null)).toThrow(TypeError);
		expect(
			registry.bindPersistentState("Alpha", { recordRevision: 0, ownerEpoch: 1, recordPhase: "parked" }, ref),
		).toBe(false);
		expect(
			registry.bindPersistentState("Alpha", { recordRevision: 4, ownerEpoch: 2, recordPhase: "parked" }, ref),
		).toBe(true);
		const guard = registry.createPersistentCommitGuard("alpha", ref, {
			recordRevision: 4,
			ownerEpoch: 2,
			recordPhase: "parked",
		});
		expect(guard.isCurrent()).toBe(true);
		expect(
			registry.bindPersistentState("Alpha", { recordRevision: 4, ownerEpoch: 3, recordPhase: "open" }, ref),
		).toBe(false);
		expect(
			registry.bindPersistentState("Alpha", { recordRevision: 3, ownerEpoch: 3, recordPhase: "parked" }, ref),
		).toBe(false);
		expect(
			registry.bindPersistentState("Alpha", { recordRevision: 5, ownerEpoch: 1, recordPhase: "open" }, ref),
		).toBe(false);
		expect(ref.persistent).toEqual({ recordRevision: 4, ownerEpoch: 2, recordPhase: "parked" });
		registry.register({
			id: "ALPHA",
			displayName: "collision",
			kind: "sub",
			session: null,
			status: "parked",
		});
		expect(guard.isCurrent()).toBe(false);
	});

	it("rejects cleanup and cache-eviction shortcuts or evidence regression", () => {
		const ref: RuntimeReplicaRef = {
			providerId: "provider-a",
			profileId: "profile-a",
			replicaId: "replica-a",
			workspaceId: "workspace-alpha",
		};
		let catalog: KnownReplicaCatalogV1 = { revision: 0, entries: [] };
		catalog = appendKnownReplicaV1(catalog, knownReplica(ref, "planned-replica"));
		const first = catalog.entries[0]!;
		const cleanupRequest = { requestId: "cleanup-request", requestSha256: ZERO_SHA256 };
		expect(() =>
			replaceKnownReplicaV1(catalog, catalog.revision, {
				...first,
				cleanup: {
					state: "complete",
					request: cleanupRequest,
					outcome: "deleted",
					completedAt: SECOND_AT,
					receiptSha256: ZERO_SHA256_REF,
				},
			}),
		).toThrow();
		catalog = replaceKnownReplicaV1(catalog, catalog.revision, {
			...first,
			cleanup: {
				state: "pending",
				request: cleanupRequest,
				attempts: 1,
				lastAttemptAt: null,
				lastResult: null,
				nextAttemptAt: null,
			},
		});
		const cleanupPlanned = catalog.entries[0]!;
		catalog = replaceKnownReplicaV1(catalog, catalog.revision, {
			...cleanupPlanned,
			cleanup: {
				state: "pending",
				request: cleanupRequest,
				attempts: 1,
				lastAttemptAt: CREATED_AT,
				lastResult: "transport_unknown",
				nextAttemptAt: SECOND_AT,
			},
		});
		const cleanupUnknown = catalog.entries[0]!;
		expect(() =>
			replaceKnownReplicaV1(catalog, catalog.revision, {
				...cleanupUnknown,
				cleanup: {
					state: "pending",
					request: cleanupRequest,
					attempts: 1,
					lastAttemptAt: null,
					lastResult: null,
					nextAttemptAt: null,
				},
			}),
		).toThrow();

		const plan = {
			requestId: "eviction-request",
			requestSha256: ZERO_SHA256,
			requestedByOperationId: "eviction-operation",
			replica: ref,
			mode: "workspace_retention" as const,
			delayMs: 1_000,
			plannedAt: CREATED_AT,
			retentionDeadline: SECOND_AT,
		};
		catalog = replaceKnownReplicaV1(catalog, catalog.revision, {
			...cleanupUnknown,
			cacheEviction: {
				state: "pending",
				plan,
				attempts: 1,
				lastAttemptAt: null,
				progress: { state: "not_started" },
			},
		});
		const evictionPlanned = catalog.entries[0]!;
		catalog = replaceKnownReplicaV1(catalog, catalog.revision, {
			...evictionPlanned,
			cacheEviction: {
				state: "pending",
				plan,
				attempts: 1,
				lastAttemptAt: CREATED_AT,
				progress: { state: "submission_outcome_unknown" },
			},
		});
		const evictionUnknown = catalog.entries[0]!;
		const acceptance = {
			requestId: plan.requestId,
			requestSha256: plan.requestSha256,
			replica: ref,
			retentionDeadline: plan.retentionDeadline,
			acceptedAt: SECOND_AT,
		};
		catalog = replaceKnownReplicaV1(catalog, catalog.revision, {
			...evictionUnknown,
			cacheEviction: {
				state: "pending",
				plan,
				attempts: 1,
				lastAttemptAt: CREATED_AT,
				progress: { state: "accepted", acceptance },
			},
		});
		const evictionAccepted = catalog.entries[0]!;
		expect(() =>
			replaceKnownReplicaV1(catalog, catalog.revision, {
				...evictionAccepted,
				cacheEviction: {
					state: "pending",
					plan,
					attempts: 1,
					lastAttemptAt: CREATED_AT,
					progress: { state: "submission_outcome_unknown" },
				},
			}),
		).toThrow();
	});

	it("derives deletion core, tombstone, request, final-plan, and terminal-cleanup digests in one direction", async () => {
		const alpha: RuntimeReplicaRef = {
			providerId: "alpha-provider",
			profileId: "profile-a",
			replicaId: "replica-a",
			workspaceId: "workspace-alpha",
		};
		const zeta: RuntimeReplicaRef = {
			providerId: "zeta-provider",
			profileId: "profile-z",
			replicaId: "replica-z",
			workspaceId: "workspace-alpha",
		};
		let catalog: KnownReplicaCatalogV1 = { revision: 0, entries: [] };
		catalog = appendKnownReplicaV1(catalog, knownReplica(zeta, "planned-zeta"));
		catalog = appendKnownReplicaV1(catalog, knownReplica(alpha, "planned-alpha"));
		expect(catalog.entries.map(entry => entry.replica.providerId)).toEqual(["alpha-provider", "zeta-provider"]);

		const core: WorkspaceDeletionPlanCoreV1 = {
			deleteId: "delete-workspace",
			deletionAuthorityId: "delete-authority",
			quarantineId: "quarantine-workspace",
			workspaceId: "workspace-alpha",
			expectedCheckpoint: {
				workspaceId: "workspace-alpha",
				generation: 7,
				rootSha256: ZERO_SHA256,
				fileCount: 0,
				byteCount: 0,
				committedAt: CREATED_AT,
			},
			expectedRuntimeAttachmentCreateId: "runtime-attachment-create",
			expectedRuntimeAttachmentRevision: 9,
			expectedKnownReplicaCatalogRevision: catalog.revision,
			plannedDeletionAt: "2026-08-06T12:00:10.000Z",
			deletedBytesGraceMs: 5_000,
			purgeAfter: "2026-08-06T12:00:15.000Z",
			replicaRequests: catalog.entries.map((entry, index) => ({
				replica: entry.replica,
				deletionAuthorityDomain: "persistent",
				requestId: `replica-delete-${index}`,
			})),
		};
		const materialized = await materializeWorkspaceDeletionPlanV1(core);
		expect(materialized.deletionPlanCoreSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(materialized.deletionPlanSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(materialized.tombstone).toEqual({
			workspaceId: core.workspaceId,
			deleteId: core.deleteId,
			deletionAuthorityId: core.deletionAuthorityId,
			quarantineId: core.quarantineId,
			deletedAt: core.plannedDeletionAt,
			lastCheckpoint: core.expectedCheckpoint,
			purgeAfter: core.purgeAfter,
		});
		expect(materialized.deletion.replicaRequests[0]?.request.requestSha256).not.toBe(
			materialized.deletion.replicaRequests[1]?.request.requestSha256,
		);

		for (let index = 0; index < catalog.entries.length; index++) {
			const current = catalog.entries[index]!;
			const planned = materialized.deletion.replicaRequests[index]!;
			catalog = replaceKnownReplicaV1(catalog, catalog.revision, {
				...current,
				cleanup: {
					state: "pending",
					request: planned.request,
					attempts: 1,
					lastAttemptAt: null,
					lastResult: null,
					nextAttemptAt: null,
				},
			});
			const pending = catalog.entries[index]!;
			catalog = replaceKnownReplicaV1(catalog, catalog.revision, {
				...pending,
				cleanup: {
					state: "complete",
					request: planned.request,
					outcome: index === 0 ? "deleted" : "already_deleted",
					completedAt: `2026-08-06T12:00:${20 + index}.000Z`,
					receiptSha256: ZERO_SHA256_REF,
				},
			});
		}
		const proofCore: Omit<TerminalReplicaCleanupProofV1, "proofSha256"> = {
			schemaVersion: 1,
			workspaceId: core.workspaceId,
			deleteId: core.deleteId,
			catalogRevision: catalog.revision,
			deletionPlanCoreSha256: materialized.deletionPlanCoreSha256,
			deletionPlanSha256: materialized.deletionPlanSha256,
			entries: catalog.entries.map((entry, _index) => {
				if (entry.cleanup.state !== "complete") throw new Error("fixture cleanup did not complete");
				return {
					replica: entry.replica,
					deletionAuthorityDomain: "persistent",
					request: entry.cleanup.request,
					outcome: entry.cleanup.outcome,
					completedAt: entry.cleanup.completedAt,
					receiptSha256: entry.cleanup.receiptSha256,
				};
			}),
			verifiedAt: "2026-08-06T12:00:30.000Z",
		};
		const proof: TerminalReplicaCleanupProofV1 = {
			...proofCore,
			proofSha256: await terminalReplicaCleanupProofSha256V1(proofCore),
		};
		expect(
			await validatePersistentWorkspaceAuthorityV1({
				workspaceId: core.workspaceId,
				canonical: {
					state: "tombstoned",
					tombstone: materialized.tombstone,
					deletion: materialized.deletion,
					deletionPlanCoreSha256: materialized.deletionPlanCoreSha256,
					deletionPlanSha256: materialized.deletionPlanSha256,
					cleanupProof: proof,
				},
				knownReplicas: catalog,
			}),
		).toBe(true);
	});

	it("requires tombstone cleanup proof installation before purge and keeps release IDs distinct", async () => {
		using temp = TempDir.createSync("@omp-persistent-store-purge-");
		const rootDir = path.join(temp.path(), "persistent-agents", "v1");
		const store = await FilePersistentAgentStore.open({ rootDir, controlHostId: "host-a" });
		const ownership = await store.acquire("Alpha", "recover");
		const core: WorkspaceDeletionPlanCoreV1 = {
			deleteId: "delete-workspace",
			deletionAuthorityId: "delete-authority",
			quarantineId: "quarantine-workspace",
			workspaceId: "workspace-alpha",
			expectedCheckpoint: {
				workspaceId: "workspace-alpha",
				generation: 3,
				rootSha256: ZERO_SHA256,
				fileCount: 0,
				byteCount: 0,
				committedAt: CREATED_AT,
			},
			expectedRuntimeAttachmentCreateId: "runtime-attachment-create",
			expectedRuntimeAttachmentRevision: 7,
			expectedKnownReplicaCatalogRevision: 0,
			plannedDeletionAt: CREATED_AT,
			deletedBytesGraceMs: 5_000,
			purgeAfter: "2026-08-06T12:00:05.000Z",
			replicaRequests: [],
		};
		const materialized = await materializeWorkspaceDeletionPlanV1(core);
		const proofCore: Omit<TerminalReplicaCleanupProofV1, "proofSha256"> = {
			schemaVersion: 1,
			workspaceId: core.workspaceId,
			deleteId: core.deleteId,
			catalogRevision: 0,
			deletionPlanCoreSha256: materialized.deletionPlanCoreSha256,
			deletionPlanSha256: materialized.deletionPlanSha256,
			entries: [],
			verifiedAt: SECOND_AT,
		};
		const cleanupProof: TerminalReplicaCleanupProofV1 = {
			...proofCore,
			proofSha256: await terminalReplicaCleanupProofSha256V1(proofCore),
		};
		const tombstoned = tombstonedAuthority(materialized, null);
		const tombstonedWithProof = tombstonedAuthority(materialized, cleanupProof);
		const purged: PersistentWorkspaceAuthorityV1 = {
			workspaceId: core.workspaceId,
			canonical: {
				state: "purged",
				tombstone: materialized.tombstone,
				deletion: materialized.deletion,
				deletionPlanCoreSha256: materialized.deletionPlanCoreSha256,
				deletionPlanSha256: materialized.deletionPlanSha256,
				cleanupProof,
				purgedAt: PURGED_AT,
			},
			knownReplicas: { revision: 0, entries: [] },
		};
		const current = releasedRecord(store.controlHostId, 10, tombstoned);
		const directPurge = releasedRecord(store.controlHostId, 11, purged);
		const proofRecord = releasedRecord(store.controlHostId, 11, tombstonedWithProof);
		const purgedRecord = releasedRecord(store.controlHostId, 12, purged);
		expect(
			await validatePersistentAgentRecordV1({
				...current,
				release: { ...current.release, operationId: "delete-workspace" },
			}),
		).toMatchObject({ ok: false, reason: "invalid_phase_relationship" });
		await Bun.write(
			path.join(rootDir, "records", `${persistentAgentStorageKeyV1("Alpha")}.json`),
			`${JSON.stringify(current)}\n`,
		);
		expect(await ownership.read()).toMatchObject({ kind: "record", record: { revision: 10 } });
		const guard = new AgentRegistry().createPersistentCommitGuard("Alpha", null, null);
		await expect(ownership.replace(10, directPurge, guard)).rejects.toMatchObject({ code: "invalid_transition" });
		expect(await ownership.replace(10, proofRecord, guard)).toEqual(proofRecord);
		expect(await ownership.replace(11, purgedRecord, guard)).toEqual(purgedRecord);
		await ownership.close();
	});

	it("finishes fork recovery only with the exact durable target session", async () => {
		using temp = TempDir.createSync("@omp-persistent-store-fork-recovery-");
		const rootDir = path.join(temp.path(), "persistent-agents", "v1");
		const store = await FilePersistentAgentStore.open({ rootDir, controlHostId: "host-a" });
		const interrupted = forkingRecord(store.controlHostId);
		const recovery = createPersistentAgentRecoveryRequiredRecordV1(interrupted, "interrupted_fork", SECOND_AT);
		if (recovery.recovery.failedPhase !== "forking") throw new Error("expected forking recovery context");
		const exactOpen: PersistentAgentOpenRecordV1 = {
			...commonRecord(store.controlHostId, recovery.revision + 1),
			phase: "open",
			operation: null,
			session: recovery.recovery.operation.plan.target,
			workspace: recovery.recovery.workspace,
			releasedAt: null,
		};
		const substitutedTarget: PersistentAgentOpenRecordV1 = {
			...exactOpen,
			session: sessionRef("session-substituted"),
		};
		const ownership = await store.acquire("Alpha", "recover");
		await Bun.write(
			path.join(rootDir, "records", `${persistentAgentStorageKeyV1("Alpha")}.json`),
			`${JSON.stringify(recovery)}\n`,
		);
		expect(await ownership.read()).toMatchObject({ kind: "record", record: { revision: recovery.revision } });
		const guard = new AgentRegistry().createPersistentCommitGuard("Alpha", null, null);
		await expect(ownership.replace(recovery.revision, substitutedTarget, guard)).rejects.toMatchObject({
			code: "invalid_transition",
		});
		expect(await ownership.replace(recovery.revision, exactOpen, guard)).toEqual(exactOpen);
		await ownership.close();
	});

	it("keeps legacy transcript discovery read-only and skips every durable-store ID", async () => {
		using temp = TempDir.createSync("@omp-persistent-store-legacy-");
		const store = await FilePersistentAgentStore.open({
			rootDir: path.join(temp.path(), "persistent-agents", "v1"),
			controlHostId: "host-a",
		});
		const owner = await store.acquire("Alpha", "create");
		await owner.insert(creatingRecord());
		await owner.close();

		const mainSession = path.join(temp.path(), "main.jsonl");
		await Bun.write(mainSession, "");
		await Bun.write(path.join(temp.path(), "main", "Alpha.jsonl"), "");
		await Bun.write(path.join(temp.path(), "main", "Beta.jsonl"), "");
		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, mainSession, store);
		expect(registry.get("Alpha")).toBeUndefined();
		expect(registry.get("Beta")).toMatchObject({ status: "parked", kind: "sub" });
	});
});
