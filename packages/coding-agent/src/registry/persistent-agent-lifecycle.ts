import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import { isDeepStrictEqual as sameJson } from "node:util";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { RegistryModelConnectionResolver } from "../config/model-connection-resolver.js";
import { ModelRegistry } from "../config/model-registry.js";
import { Settings } from "../config/settings.js";
import { createAgentSession, discoverAuthStorage, loadSessionExtensions } from "../sdk.js";
import type { AgentSession } from "../session/agent-session.js";
import { LocalWorkspaceProvider } from "../session/local-workspace-provider.js";
import {
	DurableManagedWorkspaceSeedSourceStoreV1,
	FileRuntimeDurableStateStoreV1,
	ManagedWorkspaceStore,
	readManagedWorkspaceSeedSourceV1,
} from "../session/managed-workspace.js";
import { loadEntriesFromFile } from "../session/session-loader.js";
import { SessionManager } from "../session/session-manager.js";
import { FileSessionStorage } from "../session/session-storage.js";
import {
	PersistentWorkspaceAuthorityStoreV1,
	RuntimeAttachmentFileStoreV1,
	WorkspaceRuntimeControllerV1,
} from "../session/workspace-controller.js";
import {
	DeterministicRuntimeScheduler,
	type RuntimeProviderConfigurationV1,
	WorkspaceRuntimeProviderRegistry,
} from "../session/workspace-provider-registry.js";
import {
	type AdaptiveRuntimeEventV1,
	materializeWorkspaceRetentionPolicyV1,
	PERSISTENT_MODEL_WORKSPACE_ROOT,
	type RuntimeAttachmentRecordV1,
	type RuntimeController,
	type RuntimeDiscardRuntimeChangesAuthorization,
	type RuntimeReplicaDeleteResult,
	type RuntimeRequirements,
	type RuntimeStatusSnapshot,
	type RuntimeTransitionReason,
	type SessionJournalStatusSnapshot,
	type WorkspaceControllerLease,
	type WorkspaceOperationLease,
} from "../session/workspace-runtime-contracts.js";
import { EventBus } from "../utils/event-bus.js";
import {
	createPersistentAgentRecoveryRequiredRecordV1,
	persistentAgentInterruptedRecoveryCodeV1,
	persistentAgentRecoveryActionsV1,
} from "./agent-lifecycle.js";
import { type AgentRef, AgentRegistry, type PersistentAgentRegistryBinding } from "./agent-registry.js";
import {
	type CreatePersistentAgentOptions,
	type DeletePersistentAgentWorkspaceOptions,
	decodePersistentRuntimePolicyV1,
	type ISO8601,
	type KnownReplicaRecordV1,
	type ManagedWorkspaceSeedLimitsV1,
	type ManagedWorkspaceSeedSourceRefV1,
	type OpenPersistentAgentOptions,
	type OperationId,
	PERSISTENT_TOOL_FINGERPRINT_SHA256_V1,
	PERSISTENT_TOOL_NAMES,
	PERSISTENT_TOOL_REGISTRATIONS_V1,
	type PersistentAgentCreatingRecordV1,
	PersistentAgentError,
	type PersistentAgentForkingRecordV1,
	type PersistentAgentForkResult,
	type PersistentAgentHandle,
	type PersistentAgentId,
	type PersistentAgentOpenRecordV1,
	type PersistentAgentOwnership,
	type PersistentAgentParkedRecordV1,
	type PersistentAgentParkingRecordV1,
	type PersistentAgentPresentStatus,
	type PersistentAgentRecordV1,
	type PersistentAgentRecoveryRequiredRecordV1,
	type PersistentAgentReleasedRecordV1,
	type PersistentAgentReleasingRecordV1,
	type PersistentAgentRevivingRecordV1,
	type PersistentAgentSessionRef,
	type PersistentAgentStatus,
	type PersistentRuntimePolicy,
	type PersistentRuntimePolicyUpdateResultV1,
	type PersistentToolSet,
	type PersistentWorkspaceAuthorityV1,
	type PersistentWorkspaceDeletionStatusV1,
	type RecoverPersistentAgentOptions,
	type ReleasePersistentAgentOptions,
	type Sha256Ref,
	type TerminalReplicaCleanupProofV1,
	type WorkspaceCheckpoint,
	type WorkspaceDeletionPlanCoreV1,
	type WorkspaceId,
	type WorkspaceOperationLeaseId,
} from "./persistent-agent-contracts.js";
import {
	FilePersistentAgentStore,
	materializeWorkspaceDeletionPlanV1,
	normalizePersistentAgentIdV1,
	persistentAgentStorageKeyV1,
	replaceKnownReplicaV1,
	terminalReplicaCleanupProofSha256V1,
	workspaceDeletionPlanCoreSha256V1,
} from "./persistent-agent-store.js";

const CONTROLLER_TTL_MS = 30_000;
const RUNTIME_LEASE_TTL_MS = 60_000;
const COPY_BIND_TTL_MS = 15 * 60_000;
const DEFAULT_DELETE_GRACE_MS = 3_600_000;
const SEED_LIMITS: ManagedWorkspaceSeedLimitsV1 = Object.freeze({
	maxFiles: 100_000,
	maxFileBytes: 64 * 1024 * 1024,
	maxTotalBytes: 2_147_483_647,
	deniedPatterns: Object.freeze([".git", ".git/**"]),
});
const EMPTY_IMAGE = Object.freeze({
	rootSha256: createHash("sha256").digest("hex"),
	fileCount: 0,
	byteCount: 0,
});
const SYSTEM_PROMPT =
	"You are a persistent OMP coding agent. Work only through the durable managed workspace mounted at /workspace.";
const TOOL_SET: PersistentToolSet = Object.freeze({
	registrations: PERSISTENT_TOOL_REGISTRATIONS_V1,
	activeNames: PERSISTENT_TOOL_NAMES,
	fingerprintSha256: PERSISTENT_TOOL_FINGERPRINT_SHA256_V1,
});

interface LifecycleAssembly {
	readonly root: string;
	readonly store: FilePersistentAgentStore;
	readonly registry: AgentRegistry;
	readonly storage: FileSessionStorage;
	readonly durable: FileRuntimeDurableStateStoreV1;
	readonly authority: PersistentWorkspaceAuthorityStoreV1;
	readonly attachments: RuntimeAttachmentFileStoreV1;
	readonly seeds: DurableManagedWorkspaceSeedSourceStoreV1;
	readonly canonical: ManagedWorkspaceStore;
	readonly providers: WorkspaceRuntimeProviderRegistry;
	readonly scheduler: DeterministicRuntimeScheduler;
}


interface OwnedRuntime {
	readonly ownership: PersistentAgentOwnership;
	readonly controllerLease: WorkspaceControllerLease;
	readonly controller: WorkspaceRuntimeControllerV1;
	readonly refBox: { ref: AgentRef | null };
	runtimeLifecycle: PersistentRuntimeLifecycleV1 | null;
}

let assemblyPromise: Promise<LifecycleAssembly> | undefined;
const liveHandles = new Map<string, PersistentAgentHandleV1>();
let providerExtensionsPromise: Promise<void> | undefined;

async function ensureProviderExtensions(assembly: LifecycleAssembly, settings: Settings): Promise<void> {
	providerExtensionsPromise ??= loadSessionExtensions(
		{ runtimeProviderRegistry: assembly.providers },
		process.cwd(),
		settings,
		new EventBus(),
	).then(() => undefined);
	await providerExtensionsPromise;
}

function now(): ISO8601 {
	return new Date().toISOString();
}

function id(): OperationId {
	return randomUUID();
}

function sha256Ref(value: unknown): Sha256Ref {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function abort(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

function creating(record: PersistentAgentRecordV1): PersistentAgentCreatingRecordV1 {
	if (record.phase !== "creating")
		throw new PersistentAgentError("revision_conflict", record.agentId, true, "record_revision_conflict");
	return record;
}

function openRecord(record: PersistentAgentRecordV1): PersistentAgentOpenRecordV1 {
	if (record.phase !== "open")
		throw new PersistentAgentError("revision_conflict", record.agentId, true, "record_revision_conflict");
	return record;
}

function parking(record: PersistentAgentRecordV1): PersistentAgentParkingRecordV1 {
	if (record.phase !== "parking")
		throw new PersistentAgentError("revision_conflict", record.agentId, true, "record_revision_conflict");
	return record;
}

function parked(record: PersistentAgentRecordV1): PersistentAgentParkedRecordV1 {
	if (record.phase !== "parked")
		throw new PersistentAgentError("revision_conflict", record.agentId, true, "record_revision_conflict");
	return record;
}

function reviving(record: PersistentAgentRecordV1): PersistentAgentRevivingRecordV1 {
	if (record.phase !== "reviving")
		throw new PersistentAgentError("revision_conflict", record.agentId, true, "record_revision_conflict");
	return record;
}

function forking(record: PersistentAgentRecordV1): PersistentAgentForkingRecordV1 {
	if (record.phase !== "forking")
		throw new PersistentAgentError("revision_conflict", record.agentId, true, "record_revision_conflict");
	return record;
}

function releasing(record: PersistentAgentRecordV1): PersistentAgentReleasingRecordV1 {
	if (record.phase !== "releasing")
		throw new PersistentAgentError("revision_conflict", record.agentId, true, "record_revision_conflict");
	return record;
}

function released(record: PersistentAgentRecordV1): PersistentAgentReleasedRecordV1 {
	if (record.phase !== "released")
		throw new PersistentAgentError("revision_conflict", record.agentId, true, "record_revision_conflict");
	return record;
}

function recoveryRequired(record: PersistentAgentRecordV1): PersistentAgentRecoveryRequiredRecordV1 {
	if (record.phase !== "recovery_required")
		throw new PersistentAgentError("revision_conflict", record.agentId, true, "record_revision_conflict");
	return record;
}

function addMs(value: ISO8601, milliseconds: number): ISO8601 {
	return new Date(Date.parse(value) + milliseconds).toISOString();
}

function guard(ownership: PersistentAgentOwnership, refBox: { ref: AgentRef | null }) {
	return Object.freeze({
		isCurrent: () =>
			ownership.isHeld() && (refBox.ref === null || AgentRegistry.global().get(ownership.agentId) === refBox.ref),
	});
}

type AgentLifecycleAdaptiveEventKindV1 = Extract<
	AdaptiveRuntimeEventV1,
	{ kind: "agent.created" | "agent.opened" | "agent.parked" | "agent.revived" | "agent.released" }
>["kind"];

class PersistentRuntimeLifecycleV1 implements RuntimeController {
	readonly #assembly: LifecycleAssembly;
	readonly #owned: OwnedRuntime;
	readonly #eventBus: EventBus;
	readonly #sessionManager: SessionManager;
	#currentPolicy: PersistentRuntimePolicy;
	#closed = false;
	#runtimeMayBeActive = false;
	#activeWorkspaceOperations = 0;
	#idleTimer: NodeJS.Timeout | undefined;
	#idleGeneration = 0;
	#serialTail: Promise<void> = Promise.resolve();

	constructor(
		assembly: LifecycleAssembly,
		owned: OwnedRuntime,
		policy: PersistentRuntimePolicy,
		eventBus: EventBus,
		sessionManager: SessionManager,
	) {
		this.#assembly = assembly;
		this.#owned = owned;
		this.#currentPolicy = policy;
		this.#eventBus = eventBus;
		this.#sessionManager = sessionManager;
	}

	readonly currentRuntimePolicy = (): PersistentRuntimePolicy => {
		this.#requireCurrent();
		return this.#currentPolicy;
	};

	async runSerialized<Result>(
		signal: AbortSignal | undefined,
		action: () => Promise<Result>,
		requireCurrentAfter = true,
	): Promise<Result> {
		const predecessor = this.#serialTail;
		let release = (): void => undefined;
		this.#serialTail = new Promise<void>(resolve => {
			release = resolve;
		});
		await predecessor;
		try {
			this.#requireCurrent();
			abort(signal);
			const result = await action();
			if (requireCurrentAfter) this.#requireCurrent();
			return result;
		} catch (error) {
			if (!this.#authorityIsCurrent()) this.close();
			throw error;
		} finally {
			release();
		}
	}

	async beginWorkspaceOperation(
		requirements: RuntimeRequirements,
		operationLeaseId: WorkspaceOperationLeaseId,
		signal?: AbortSignal,
	): Promise<WorkspaceOperationLease> {
		this.#requireCurrent();
		this.cancelIdleRuntime();
		let lease: WorkspaceOperationLease;
		try {
			lease = await this.#owned.controller.beginWorkspaceOperation(requirements, operationLeaseId, signal);
		} catch (error) {
			if (!this.#authorityIsCurrent()) this.close();
			else this.#armIdleRuntime();
			throw error;
		}
		this.#runtimeMayBeActive = true;
		this.#activeWorkspaceOperations++;
		let ended = false;
		return Object.freeze({
			operationLeaseId: lease.operationLeaseId,
			binding: lease.binding,
			end: () => {
				if (ended) return;
				ended = true;
				if (!this.#authorityIsCurrent()) this.close();
				try {
					lease.end();
				} finally {
					this.#activeWorkspaceOperations--;
					this.#armIdleRuntime();
				}
			},
		});
	}

	async drainToNone(
		reason: RuntimeTransitionReason,
		commitReplica: boolean,
		signal?: AbortSignal,
	): Promise<WorkspaceCheckpoint> {
		this.#requireCurrent();
		this.cancelIdleRuntime();
		const checkpoint = await this.#owned.controller.drainToNone(reason, commitReplica, signal);
		this.#runtimeMayBeActive = false;
		return checkpoint;
	}

	async status(signal?: AbortSignal): Promise<RuntimeStatusSnapshot> {
		this.#requireCurrent();
		return this.#owned.controller.status(signal);
	}

	commitRuntimePolicy(policy: PersistentRuntimePolicy): void {
		this.#requireCurrent();
		this.#currentPolicy = policy;
		this.rearmIdleRuntime();
	}


	cancelIdleRuntime(): void {
		this.#idleGeneration++;
		if (!this.#idleTimer) return;
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
	}

	rearmIdleRuntime(): void {
		this.cancelIdleRuntime();
		this.#armIdleRuntime();
	}

	emitLifecycle(kind: AgentLifecycleAdaptiveEventKindV1, record: PersistentAgentRecordV1): void {
		if (this.#closed) return;
		const workspace = workspaceFrom(record);
		const session = sessionFrom(record);
		this.#emit({
			schemaVersion: 1,
			timestamp: now(),
			kind,
			outcome: "succeeded",
			correlationId: id(),
			agentIdHash: sha256Ref(record.agentId),
			...(workspace ? { workspaceIdHash: sha256Ref(workspace.workspaceId) } : {}),
			...(session ? { sessionIdHash: sha256Ref(session.sessionId) } : {}),
			details: {
				agentPhase: record.phase,
				publicState: publicState(record, this.#assembly.registry.get(record.agentId)),
				recordRevision: record.revision,
			},
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.cancelIdleRuntime();
		liveHandles.delete(normalizePersistentAgentIdV1(this.#owned.ownership.agentId));
	}

	#authorityIsCurrent(): boolean {
		return (
			this.#owned.ownership.isHeld() &&
			(this.#owned.refBox.ref === null ||
				this.#assembly.registry.get(this.#owned.ownership.agentId) === this.#owned.refBox.ref)
		);
	}

	#requireCurrent(): void {
		if (!this.#closed && this.#authorityIsCurrent()) return;
		this.close();
		throw new PersistentAgentError(
			"ownership_unavailable",
			this.#owned.ownership.agentId,
			true,
			"ownership_conflict",
		);
	}

	#armIdleRuntime(): void {
		if (
			this.#closed ||
			!this.#runtimeMayBeActive ||
			this.#activeWorkspaceOperations !== 0 ||
			!this.#authorityIsCurrent()
		)
			return;
		const generation = ++this.#idleGeneration;
		const timer = setTimeout(() => {
			if (this.#idleTimer === timer) this.#idleTimer = undefined;
			void this.runSerialized(undefined, async () => {
				if (
					this.#closed ||
					generation !== this.#idleGeneration ||
					!this.#runtimeMayBeActive ||
					this.#activeWorkspaceOperations !== 0
				)
					return;
				await this.drainToNone("idle_timeout", true);
			}).catch(() => undefined);
		}, this.#currentPolicy.idleRuntimeTtlMs);
		timer.unref?.();
		this.#idleTimer = timer;
	}

	#emit(event: AdaptiveRuntimeEventV1): void {
		if (this.#closed || !this.#authorityIsCurrent()) {
			this.close();
			return;
		}
		try {
			this.#eventBus.emit(event.kind, event);
			this.#sessionManager.appendCustomEntry(event.kind, event);
		} catch {
			// Observability is non-authoritative and must not change lifecycle outcomes.
		}
	}
}

function binding(record: PersistentAgentRecordV1, ownership: PersistentAgentOwnership): PersistentAgentRegistryBinding {
	return { recordRevision: record.revision, ownerEpoch: ownership.ownerEpoch, recordPhase: record.phase };
}

async function getAssembly(): Promise<LifecycleAssembly> {
	assemblyPromise ??= (async () => {
		const root = path.join(getAgentDir(), "persistent-agents", "v1");
		const store = await FilePersistentAgentStore.open({ rootDir: root });
		const registry = AgentRegistry.global();
		registry.bindProcessOwnedPersistentAgentStore(store);
		const storage = new FileSessionStorage();
		const durable = new FileRuntimeDurableStateStoreV1(root);
		const providers = new WorkspaceRuntimeProviderRegistry();
		providers.register(new LocalWorkspaceProvider());
		const authority = new PersistentWorkspaceAuthorityStoreV1({
			durable,
			authorizePersistentCleanupProof: async (proof, cleanupProof) => {
				for (const lookup of await store.list()) {
					if (lookup.kind !== "record") continue;
					const record = lookup.record;
					const workspace =
						record.phase === "creating"
							? null
							: record.phase === "recovery_required"
								? record.recovery.failedPhase === "creating"
									? null
									: record.recovery.workspace
								: record.workspace;
					if (workspace?.workspaceId !== proof.workspaceId) continue;
					const canonical = workspace.canonical;
					return (
						(canonical.state === "tombstoned" || canonical.state === "purged") &&
						canonical.deletion.core.deleteId === proof.deleteId &&
						canonical.cleanupProof?.proofSha256 === cleanupProof.proofSha256
					);
				}
				return false;
			},
		});
		const attachments = new RuntimeAttachmentFileStoreV1({ durable, authority });
		const seeds = new DurableManagedWorkspaceSeedSourceStoreV1({ durable });
		const canonical = new ManagedWorkspaceStore({ durable, authority, seedSources: seeds });
		return {
			root,
			store,
			registry,
			storage,
			durable,
			authority,
			attachments,
			seeds,
			canonical,
			providers,
			scheduler: new DeterministicRuntimeScheduler(),
		};
	})();
	return assemblyPromise;
}

function sessionFile(assembly: LifecycleAssembly, agentId: PersistentAgentId, ref: PersistentAgentSessionRef): string {
	return path.join(assembly.root, "sessions", persistentAgentStorageKeyV1(agentId), ref.sessionStorageKey);
}

function preallocateSession(): PersistentAgentSessionRef {
	const sessionId = randomUUID();
	return Object.freeze({
		sessionId,
		sessionStorageKey: `${sessionId}.jsonl`,
		sessionInitEntryId: randomUUID(),
	});
}

function sessionInitPayload(agentId: string, _modelProfileId: string) {
	return Object.freeze({
		systemPrompt: SYSTEM_PROMPT,
		task: JSON.stringify({
			schemaVersion: 1,
			agentId,
			modelWorkspaceRoot: PERSISTENT_MODEL_WORKSPACE_ROOT,
			toolFingerprintSha256: PERSISTENT_TOOL_FINGERPRINT_SHA256_V1,
		}),
		tools: [...PERSISTENT_TOOL_NAMES],
		restrictToolNames: true,
	});
}

function recoveryFailure(
	agentId: PersistentAgentId,
	code: ConstructorParameters<typeof PersistentAgentError>[3],
	retryable = false,
): never {
	throw new PersistentAgentError("recovery_required", agentId, retryable, code);
}

function requirePlannedSessionHeader(
	agentId: PersistentAgentId,
	entries: Awaited<ReturnType<typeof loadEntriesFromFile>>,
	ref: PersistentAgentSessionRef,
	createdAt: ISO8601,
	parentSession?: string,
): void {
	const header = entries[0];
	if (
		header?.type !== "session" ||
		header.id !== ref.sessionId ||
		header.timestamp !== createdAt ||
		header.cwd !== path.resolve(PERSISTENT_MODEL_WORKSPACE_ROOT) ||
		header.parentSession !== parentSession
	)
		recoveryFailure(agentId, "session_identity_mismatch");
}

function requirePlannedSessionInit(
	agentId: PersistentAgentId,
	entries: Awaited<ReturnType<typeof loadEntriesFromFile>>,
	ref: PersistentAgentSessionRef,
	payload: ReturnType<typeof sessionInitPayload>,
): boolean {
	const matches = entries.filter(entry => entry.type === "session_init" && entry.id === ref.sessionInitEntryId);
	if (matches.length === 0) return false;
	if (matches.length !== 1) recoveryFailure(agentId, "session_invalid");
	const entry = matches[0]!;
	const actual: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entry)) {
		if (key !== "type" && key !== "id" && key !== "parentId" && key !== "timestamp") actual[key] = value;
	}
	if (!sameJson(actual, payload)) recoveryFailure(agentId, "session_identity_mismatch");
	return true;
}

async function openOrCreatePlannedSession(
	assembly: LifecycleAssembly,
	agentId: PersistentAgentId,
	ref: PersistentAgentSessionRef,
	createdAt: ISO8601,
	parentSession?: string,
): Promise<SessionManager> {
	const file = sessionFile(assembly, agentId, ref);
	const entries = await loadEntriesFromFile(file, assembly.storage);
	if (entries.length === 0) {
		if (assembly.storage.existsSync(file)) recoveryFailure(agentId, "session_invalid");
		return SessionManager.createPlanned({
			sessionId: ref.sessionId,
			sessionFile: file,
			createdAt,
			cwd: PERSISTENT_MODEL_WORKSPACE_ROOT,
			parentSession,
			storage: assembly.storage,
		});
	}
	requirePlannedSessionHeader(agentId, entries, ref, createdAt, parentSession);
	return SessionManager.open(file, undefined, assembly.storage, {
		initialCwd: PERSISTENT_MODEL_WORKSPACE_ROOT,
		suppressBreadcrumb: true,
	});
}

async function ensurePlannedSessionInit(
	assembly: LifecycleAssembly,
	agentId: PersistentAgentId,
	ref: PersistentAgentSessionRef,
	manager: SessionManager,
	payload: ReturnType<typeof sessionInitPayload>,
): Promise<void> {
	const file = sessionFile(assembly, agentId, ref);
	let entries = await loadEntriesFromFile(file, assembly.storage);
	if (!requirePlannedSessionInit(agentId, entries, ref, payload)) {
		manager.appendPlannedSessionInit(ref.sessionInitEntryId, payload);
		await manager.flush();
		entries = await loadEntriesFromFile(file, assembly.storage);
		if (!requirePlannedSessionInit(agentId, entries, ref, payload)) recoveryFailure(agentId, "session_init_missing");
	}
}

function attachRecoveryRegistryRef(
	assembly: LifecycleAssembly,
	owned: OwnedRuntime,
	record: Exclude<PersistentAgentRecordV1, { phase: "creating" | "released" }>,
	sessionOverride?: PersistentAgentSessionRef,
): AgentRef {
	const session =
		sessionOverride ??
		(record.phase === "recovery_required"
			? record.recovery.failedPhase === "creating"
				? recoveryFailure(record.agentId, "session_missing")
				: record.recovery.session
			: record.session);
	const existing = assembly.registry.get(record.agentId);
	if (existing?.session) recoveryFailure(record.agentId, "record_revision_conflict", true);
	const ref =
		existing ??
		assembly.registry.register({
			id: record.agentId,
			displayName: record.displayName,
			kind: record.kind,
			parentId: record.parentAgentId ?? undefined,
			session: null,
			sessionFile: sessionFile(assembly, record.agentId, session),
			status: "parked",
			persistent: binding(record, owned.ownership),
		});
	ref.sessionFile = sessionFile(assembly, record.agentId, session);
	owned.refBox.ref = ref;
	return ref;
}

async function disposeRecoveredSession(assembly: LifecycleAssembly, agentId: PersistentAgentId): Promise<void> {
	const ref = assembly.registry.get(agentId);
	if (!ref) return;
	const session = ref.session;
	if (session) {
		await session.sessionManager.flush();
		assembly.registry.detachSession(agentId, ref);
		await session.dispose();
	}
	assembly.registry.setStatus(agentId, "parked", ref);
}

async function releaseControllerAuthority(assembly: LifecycleAssembly, owned: OwnedRuntime): Promise<void> {
	const result = await assembly.authority.release({ proof: owned.controllerLease.proof, ownership: owned.ownership });
	if (result.status !== "released" && result.status !== "already_released") {
		recoveryFailure(owned.ownership.agentId, "ownership_conflict", true);
	}
}

function recordCommon(record: PersistentAgentRecordV1) {
	return {
		schemaVersion: record.schemaVersion,
		controlHostId: record.controlHostId,
		agentId: record.agentId,
		displayName: record.displayName,
		kind: record.kind,
		parentAgentId: record.parentAgentId,
		modelProfileId: record.modelProfileId,
		runtimePolicy: record.runtimePolicy,
		createdAt: record.createdAt,
	};
}

function providerConfigurations(
	settings: Settings,
	registry: WorkspaceRuntimeProviderRegistry,
): readonly RuntimeProviderConfigurationV1[] {
	return registry.list().map(provider => ({
		providerId: provider.id,
		enabled:
			provider.id === "local"
				? settings.get("agents.persistent.providers.local.enabled")
				: provider.id === "cloudflare"
					? settings.get("agents.persistent.providers.cloudflare.enabled")
					: true,
	}));
}

async function acquireRuntime(
	assembly: LifecycleAssembly,
	ownership: PersistentAgentOwnership,
	workspaceId: WorkspaceId,
): Promise<OwnedRuntime> {
	const controllerLeaseResult = await assembly.authority.acquire({ workspaceId, ownership, ttlMs: CONTROLLER_TTL_MS });
	if (controllerLeaseResult.status !== "acquired") {
		throw new PersistentAgentError("ownership_unavailable", ownership.agentId, true, "ownership_conflict");
	}
	const settings = await Settings.init();
	await ensureProviderExtensions(assembly, settings);
	const refBox = { ref: null as AgentRef | null };
	const controller = new WorkspaceRuntimeControllerV1({
		workspaceId,
		ownership,
		controllerLeaseStore: assembly.authority,
		controllerLease: controllerLeaseResult.lease,
		controllerLeaseTtlMs: CONTROLLER_TTL_MS,
		runtimeLeaseTtlMs: RUNTIME_LEASE_TTL_MS,
		commitGuard: guard(ownership, refBox),
		attachmentStore: assembly.attachments,
		canonicalStore: assembly.canonical,
		registry: assembly.providers,
		scheduler: assembly.scheduler,
		providerConfigurations: providerConfigurations(settings, assembly.providers),
	});
	return {
		ownership,
		controllerLease: controllerLeaseResult.lease,
		refBox,
		controller,
		runtimeLifecycle: null,
	};
}

async function refreshBinding(assembly: LifecycleAssembly, owned: OwnedRuntime): Promise<PersistentAgentRecordV1> {
	const lookup = await owned.ownership.read();
	if (lookup.kind !== "record")
		throw new PersistentAgentError("invalid_record", owned.ownership.agentId, false, "invalid_fields");
	if (
		owned.refBox.ref &&
		!assembly.registry.bindPersistentState(
			lookup.record.agentId,
			binding(lookup.record, owned.ownership),
			owned.refBox.ref,
		)
	) {
		throw new PersistentAgentError("revision_conflict", lookup.record.agentId, true, "record_revision_conflict");
	}
	return lookup.record;
}

async function replace(
	assembly: LifecycleAssembly,
	owned: Pick<OwnedRuntime, "ownership" | "refBox">,
	current: PersistentAgentRecordV1,
	next: PersistentAgentRecordV1,
): Promise<PersistentAgentRecordV1> {
	const written = await owned.ownership.replace(current.revision, next, guard(owned.ownership, owned.refBox));
	if (
		owned.refBox.ref &&
		!assembly.registry.bindPersistentState(written.agentId, binding(written, owned.ownership), owned.refBox.ref)
	) {
		throw new PersistentAgentError("revision_conflict", written.agentId, true, "record_revision_conflict");
	}
	return written;
}

async function createLiveSession(
	assembly: LifecycleAssembly,
	owned: OwnedRuntime,
	record: Exclude<PersistentAgentRecordV1, { phase: "creating" | "released" | "recovery_required" }>,
	manager: SessionManager,
	expectedRef: AgentRef | null,
	registryRecord: PersistentAgentRecordV1 = record,
): Promise<AgentSession> {
	const settings = await Settings.init();
	await ensureProviderExtensions(assembly, settings);
	const eventBus = new EventBus();
	const authStorage = await discoverAuthStorage(getAgentDir());
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();
	const profile = settings.get("modelConnections")[record.modelProfileId];
	if (!profile) throw new Error(`Unknown model connection profile: ${record.modelProfileId}`);
	const resolver = new RegistryModelConnectionResolver(modelRegistry);
	const resolved = resolver.resolve(profile, record.session.sessionId);
	if (owned.runtimeLifecycle) throw new Error("Persistent runtime lifecycle is already bound");
	const runtimeLifecycle = new PersistentRuntimeLifecycleV1(
		assembly,
		owned,
		record.runtimePolicy,
		eventBus,
		manager,
	);
	owned.runtimeLifecycle = runtimeLifecycle;
	const result = await createAgentSession({
		cwd: PERSISTENT_MODEL_WORKSPACE_ROOT,
		operationalCwd: PERSISTENT_MODEL_WORKSPACE_ROOT,
		agentDir: getAgentDir(),
		settings,
		authStorage,
		modelRegistry,
		modelConnectionResolver: resolver,
		model: resolved.model,
		getApiKey: () => resolved.apiKey,
		providerSessionId: record.session.sessionId,
		runtimeProviderRegistry: assembly.providers,
		disableExtensionDiscovery: true,
		eventBus,
		toolNames: [...PERSISTENT_TOOL_NAMES],
		restrictToolNames: true,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		workspaceTree: {
			rootPath: PERSISTENT_MODEL_WORKSPACE_ROOT,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		additionalDirectories: [],
		sessionManager: manager,
		persistentTools: {
			controller: runtimeLifecycle,
			currentRuntimePolicy: runtimeLifecycle.currentRuntimePolicy,
		},
		agentId: record.agentId,
		agentDisplayName: record.displayName,
		agentRegistry: assembly.registry,
		expectedAgentRef: expectedRef,
		persistentRegistryBinding: binding(registryRecord, owned.ownership),
		taskDepth: record.kind === "sub" ? 1 : 0,
		parentAgentId: record.parentAgentId ?? undefined,
	}).catch(error => {
		runtimeLifecycle.close();
		owned.runtimeLifecycle = null;
		throw error;
	});
	const ref = assembly.registry.get(record.agentId);
	if (!ref || ref.session !== result.session) {
		await result.session.dispose();
		runtimeLifecycle.close();
		owned.runtimeLifecycle = null;
		throw new PersistentAgentError("revision_conflict", record.agentId, true, "record_revision_conflict");
	}
	owned.refBox.ref = ref;
	return result.session;
}

function workspaceFrom(record: PersistentAgentRecordV1) {
	if (record.phase === "creating")
		return record.operation.progress.step === "planned" ? null : record.operation.progress.workspace;
	if (record.phase === "recovery_required")
		return record.recovery.failedPhase === "creating" ? null : record.recovery.workspace;
	return record.workspace;
}

async function hasDurableRuntimePreservationImpossibility(
	assembly: LifecycleAssembly,
	record: PersistentAgentRecordV1,
): Promise<boolean> {
	const workspace = workspaceFrom(record);
	if (!workspace) return false;
	const read = await assembly.attachments.read(workspace.workspaceId);
	if (read.status !== "present") return false;
	const attachment = read.record.attachment;
	return attachment.state === "draining" && attachment.recoveryFreeze?.state === "preservation_impossible";
}

function sessionFrom(record: PersistentAgentRecordV1): PersistentAgentSessionRef | null {
	if (record.phase === "creating") {
		const progress = record.operation.progress;
		return progress.step === "planned" || progress.step === "workspace_ready" ? null : progress.session;
	}
	if (record.phase === "recovery_required")
		return record.recovery.failedPhase === "creating" ? null : record.recovery.session;
	return record.session;
}

function publicState(record: PersistentAgentRecordV1, ref: AgentRef | undefined) {
	if (record.phase === "open")
		return ref?.status === "running"
			? ("running" as const)
			: ref?.status === "idle"
				? ("idle" as const)
				: ("open" as const);
	return record.phase;
}

function unavailableRuntime(
	record: PersistentAgentRecordV1,
	attachmentRecord: RuntimeAttachmentRecordV1 | null,
	currentStartedAt: ISO8601 | null,
	observedAt: ISO8601,
): RuntimeStatusSnapshot {
	const workspace = workspaceFrom(record);
	const canonical = workspace?.canonical;
	const generation = canonical?.state === "present" ? canonical.workspace.checkpoint.generation : 0;
	const attachment = attachmentRecord?.attachment;
	let transition: RuntimeStatusSnapshot["transition"];
	if (!attachment || attachment.state === "none" || attachment.state === "active") {
		transition = {
			status: "none",
			currentTransitionId: null,
			currentReason: null,
			currentFrom: null,
			currentTo: null,
			currentStartedAt: null,
			currentErrorCode: null,
			lastCompleted: attachmentRecord?.lastCompletedTransition ?? null,
		};
	} else {
		if (currentStartedAt === null) throw new Error("Runtime transition timing is unavailable");
		transition =
			attachment.block === null
				? {
						status: "in_progress",
						currentTransitionId: attachment.transitionId,
						currentReason: attachment.state === "draining" ? attachment.reason : "first_tool",
						currentFrom: attachment.state === "draining" ? "active" : "none",
						currentTo: attachment.state === "draining" ? "none" : "active",
						currentStartedAt,
						currentErrorCode: null,
						lastCompleted: attachmentRecord?.lastCompletedTransition ?? null,
					}
				: {
						status: "blocked",
						currentTransitionId: attachment.transitionId,
						currentReason: attachment.state === "draining" ? attachment.reason : "first_tool",
						currentFrom: attachment.state === "draining" ? "active" : "none",
						currentTo: attachment.state === "draining" ? "none" : "active",
						currentStartedAt,
						currentErrorCode: attachment.block.code,
						lastCompleted: attachmentRecord?.lastCompletedTransition ?? null,
					};
	}
	const common = {
		workspaceGeneration: generation,
		scheduler: attachmentRecord?.scheduler ?? {
			input: null,
			providers: [],
			candidates: [],
			decision: { status: "not_evaluated" as const },
			evaluatedAt: null,
			durationMs: null,
		},
		transition,
		checkpoint: {
			availability: "unavailable" as const,
			reasonCode: "checkpoint_status_unavailable" as const,
			observedAt,
		},
		replicaCleanup: {
			availability: "unavailable" as const,
			reasonCode: "replica_cleanup_status_unavailable" as const,
			observedAt,
		},
		latency: {
			createToFirstModelTokenMs: null,
			createToFirstWorkspaceReadyMs: null,
			lastSchedulerMs: attachmentRecord?.scheduler.durationMs ?? null,
			lastReadyLatencyMs: null,
			lastDrainMs: null,
			lastQuiesceMs: null,
			lastSyncMs: null,
			lastCanonicalPublishMs: null,
			lastReleaseMs: null,
			lastReplicaCleanupMs: null,
			accumulatedActiveRuntimeMs: 0,
			accumulatedZeroRuntimeIdleMs: 0,
			observedThrough: observedAt,
		},
		cost: { availability: "unavailable" as const, reasonCode: "cost_status_unavailable" as const, observedAt },
		observedAt,
	};
	if (!attachment || attachment.state === "none")
		return {
			...common,
			state: "none",
			block: attachment?.block ?? null,
			providerId: null,
			profileId: null,
			leaseId: null,
			compute: null,
			activeOperationCount: 0,
		};
	if (attachment.state === "acquiring")
		return {
			...common,
			state: "acquiring",
			block: attachment.block,
			providerId: attachment.plan.target.candidate.providerId,
			profileId: attachment.plan.target.candidate.profileId,
			leaseId: attachment.progress.lease?.leaseId ?? null,
			compute: null,
			activeOperationCount: 0,
		};
	const active = attachment.active;
	return attachment.state === "active"
		? {
				...common,
				state: "active",
				block: null,
				providerId: active.target.candidate.providerId,
				profileId: active.target.candidate.profileId,
				leaseId: active.lease.leaseId,
				compute: "unknown",
				activeOperationCount: "unknown",
			}
		: {
				...common,
				state: "draining",
				block: attachment.block,
				providerId: active.target.candidate.providerId,
				profileId: active.target.candidate.profileId,
				leaseId: active.lease.leaseId,
				compute: "unknown",
				activeOperationCount: "unknown",
			};
}

function journalStatus(observedAt: ISO8601): SessionJournalStatusSnapshot {
	return {
		availability: "unavailable",
		state: "unavailable",
		reasonCode: "journal_status_unavailable",
		pendingCommits: "unknown",
		failedSinkCount: "unknown",
		needsReconcileStreamCount: "unknown",
		oldestPendingAgeMs: "unknown",
		retryCount: "unknown",
		observedAt,
	};
}

function deletionStatus(workspace: NonNullable<ReturnType<typeof workspaceFrom>>, observedAt: ISO8601) {
	const rows = workspace.knownReplicas.entries;
	const counts = {
		workspaceId: workspace.workspaceId,
		knownReplicaCount: rows.length,
		cacheEvictionPendingCount: rows.filter(row => row.cacheEviction.state === "pending").length,
		cacheEvictionCompleteCount: rows.filter(row => row.cacheEviction.state === "complete").length,
		cleanupCompleteCount: rows.filter(row => row.cleanup.state === "complete").length,
		cleanupPendingCount: rows.filter(row => row.cleanup.state === "pending").length,
		cleanupFailedCount: rows.filter(row => row.cleanup.state === "failed").length,
	};
	const canonical = workspace.canonical;
	if (canonical.state === "present")
		return {
			...counts,
			state: "retained" as const,
			deleteId: null,
			deletionPlanCoreSha256: null,
			deletionPlanSha256: null,
			tombstone: null,
			purgeAfter: null,
		};
	if (canonical.state === "delete_core_planned")
		return {
			...counts,
			state: "delete_core_planned" as const,
			deleteId: canonical.deletionCore.deleteId,
			deletionPlanCoreSha256: canonical.deletionPlanCoreSha256,
			deletionPlanSha256: null,
			tombstone: null,
			purgeAfter: canonical.deletionCore.purgeAfter,
		};
	if (canonical.state === "delete_planned")
		return {
			...counts,
			state: "delete_planned" as const,
			deleteId: canonical.deletion.core.deleteId,
			deletionPlanCoreSha256: canonical.deletionPlanCoreSha256,
			deletionPlanSha256: canonical.deletionPlanSha256,
			tombstone: null,
			purgeAfter: canonical.deletion.core.purgeAfter,
		};
	if (canonical.state === "purged")
		return {
			...counts,
			state: "purged" as const,
			deleteId: canonical.deletion.core.deleteId,
			deletionPlanCoreSha256: canonical.deletionPlanCoreSha256,
			deletionPlanSha256: canonical.deletionPlanSha256,
			tombstone: canonical.tombstone,
			purgeAfter: canonical.deletion.core.purgeAfter,
		};
	const complete = rows.every(row => row.cleanup.state === "complete");
	const due = Date.parse(canonical.deletion.core.purgeAfter) <= Date.parse(observedAt);
	return {
		...counts,
		state: complete ? (due ? ("purge_due" as const) : ("tombstoned" as const)) : ("cleanup_pending" as const),
		deleteId: canonical.deletion.core.deleteId,
		deletionPlanCoreSha256: canonical.deletionPlanCoreSha256,
		deletionPlanSha256: canonical.deletionPlanSha256,
		tombstone: canonical.tombstone,
		purgeAfter: canonical.deletion.core.purgeAfter,
	};
}

async function presentStatus(
	assembly: LifecycleAssembly,
	record: PersistentAgentRecordV1,
	signal?: AbortSignal,
): Promise<PersistentAgentPresentStatus> {
	abort(signal);
	const observedAt = now();
	const workspace = workspaceFrom(record);
	const identity = sessionFrom(record);
	const live = liveHandles.get(normalizePersistentAgentIdV1(record.agentId));
	let attachment: RuntimeAttachmentRecordV1 | null = null;
	let currentStartedAt: ISO8601 | null = null;
	if (workspace) {
		const attachmentRead = await assembly.attachments.read(workspace.workspaceId);
		if (attachmentRead.status === "present") {
			attachment = attachmentRead.record;
			const runtimeAttachment = attachment.attachment;
			if (runtimeAttachment.state === "acquiring" || runtimeAttachment.state === "draining") {
				currentStartedAt = await assembly.attachments.readTransitionStartedAt(
					workspace.workspaceId,
					runtimeAttachment.transitionId,
				);
			}
		}
	}
	const runtime = live
		? await live.runtimeStatus(signal)
		: unavailableRuntime(record, attachment, currentStartedAt, observedAt);
	const owner = await assembly.store.inspectOwnership(record.agentId, signal);
	const file = identity ? sessionFile(assembly, record.agentId, identity) : null;
	let health: PersistentAgentPresentStatus["session"]["health"] = identity ? "present" : "absent";
	let materialized = false;
	if (file) {
		try {
			const peek = await SessionManager.peekSessionInit(file, assembly.storage);
			materialized = peek !== null;
			health = peek === null ? "missing" : peek.init === null ? "invalid" : "present";
		} catch {
			health = "invalid";
		}
	}
	const recovery =
		record.phase === "recovery_required"
			? {
					code: record.recovery.code,
					failedPhase: record.recovery.failedPhase,
					operationId: record.recovery.operationId,
					detectedAt: record.recovery.detectedAt,
					actions: persistentAgentRecoveryActionsV1(record),
				}
			: null;
	return {
		kind: "present",
		agentId: record.agentId,
		displayName: record.displayName,
		agentKind: record.kind,
		parentAgentId: record.parentAgentId,
		recordRevision: record.revision,
		recordPhase: record.phase,
		state: publicState(record, assembly.registry.get(record.agentId)),
		ownership: owner,
		session: { identity, materialized, health },
		workspace: {
			workspaceId: workspace?.workspaceId ?? null,
			authority: workspace,
			health: workspace
				? workspace.canonical.state === "purged"
					? "purged"
					: workspace.canonical.state === "tombstoned"
						? "tombstoned"
						: "present"
				: "planned",
			deletion: workspace ? deletionStatus(workspace, observedAt) : null,
		},
		runtime,
		runtimePolicy: record.runtimePolicy,
		journal: journalStatus(observedAt),
		tools: identity ? TOOL_SET : null,
		modelProfileId: record.modelProfileId,
		recovery,
		updatedAt: record.updatedAt,
		releasedAt: record.phase === "released" ? record.releasedAt : null,
	};
}

export async function createPersistentAgent(options: CreatePersistentAgentOptions): Promise<PersistentAgentHandle> {
	const runtimePolicy = decodePersistentRuntimePolicyV1(options.runtimePolicy);
	const agentId = options.id;
	normalizePersistentAgentIdV1(agentId);
	abort(options.signal);
	const kind = options.kind ?? "main";
	const parentAgentId = options.parentAgentId ?? null;
	if ((kind === "main" && parentAgentId !== null) || (kind === "sub" && parentAgentId === null))
		throw new PersistentAgentError("invalid_transition", agentId, false, "invalid_fields");
	if (!options.modelProfileId || options.modelProfileId.trim() !== options.modelProfileId)
		throw new PersistentAgentError("invalid_transition", agentId, false, "invalid_fields");
	const displayName = options.displayName ?? agentId;
	if (!displayName || displayName.trim() !== displayName)
		throw new PersistentAgentError("invalid_transition", agentId, false, "invalid_fields");
	const copyWorkspace = options.workspace.kind === "copy" ? options.workspace : null;
	const seedRead = copyWorkspace
		? await readManagedWorkspaceSeedSourceV1({
				sourcePath: copyWorkspace.sourcePath,
				limits: SEED_LIMITS,
				signal: options.signal,
			})
		: null;
	const assembly = await getAssembly();
	const settings = await Settings.init();
	const retention = materializeWorkspaceRetentionPolicyV1(settings.get("agents.persistent.workspaceRetention"));
	const startedAt = now();
	const workspaceId = randomUUID();
	const session = preallocateSession();
	const initPayload = sessionInitPayload(agentId, options.modelProfileId);
	const copySource: ManagedWorkspaceSeedSourceRefV1 | null = seedRead
		? Object.freeze({ sourceId: randomUUID(), bindId: id(), expectedImage: seedRead.image, limits: SEED_LIMITS })
		: null;
	const plan = Object.freeze({
		kind: "create" as const,
		operationId: id(),
		startedAt,
		startedFromRevision: 0,
		resources: {
			workspaceId,
			workspaceCreateId: id(),
			workspaceStageId: id(),
			sessionCreateId: id(),
			session,
			runtimeAttachmentCreateId: id(),
		},
		seed: copySource
			? { kind: "copy" as const, source: copySource }
			: { kind: "empty" as const, expectedImage: EMPTY_IMAGE },
		retention,
		sessionInitPayloadSha256: sha256Ref(initPayload),
	});
	const ownership = await assembly.store.acquire(agentId, "create", options.signal);
	let owned: OwnedRuntime | null = null;
	let createdSession: AgentSession | null = null;
	try {
		let record = await ownership.insert({
			schemaVersion: 1,
			revision: 1,
			controlHostId: assembly.store.controlHostId,
			agentId,
			displayName,
			kind,
			parentAgentId,
			modelProfileId: options.modelProfileId,
			runtimePolicy,
			createdAt: startedAt,
			updatedAt: startedAt,
			phase: "creating",
			operation: { kind: "create", plan, progress: { step: "planned" } },
			releasedAt: null,
		});
		owned = await acquireRuntime(assembly, ownership, workspaceId);
		if (copySource && copyWorkspace) {
			const bound = await assembly.seeds.bind({
				source: copySource,
				sourcePath: copyWorkspace.sourcePath,
				expiresAt: addMs(startedAt, COPY_BIND_TTL_MS),
			});
			if (bound.status === "conflict")
				throw new PersistentAgentError("recovery_required", agentId, false, "seed_source_changed");
		}
		const created = await assembly.canonical.create({
			createId: plan.resources.workspaceCreateId,
			stageId: plan.resources.workspaceStageId,
			workspaceId,
			seed: plan.seed,
			expectedImage: copySource?.expectedImage ?? EMPTY_IMAGE,
			retention,
			controllerLease: owned.controllerLease.proof,
		});
		if (created.status !== "created" && created.status !== "already_created")
			throw new PersistentAgentError("recovery_required", agentId, true, "workspace_identity_conflict");
		if (copySource) await assembly.seeds.release({ source: copySource, reason: "workspace_ready" });
		const workspace: PersistentWorkspaceAuthorityV1 = {
			workspaceId,
			canonical: { state: "present", workspace: created.workspace },
			knownReplicas: { revision: 0, entries: [] },
		};
		record = creating(
			await replace(assembly, owned, record, {
				...record,
				revision: record.revision + 1,
				updatedAt: now(),
				operation: { ...record.operation, progress: { step: "workspace_ready", workspace } },
			}),
		);
		const manager = SessionManager.createPlanned({
			sessionId: session.sessionId,
			sessionFile: sessionFile(assembly, agentId, session),
			createdAt: startedAt,
			cwd: PERSISTENT_MODEL_WORKSPACE_ROOT,
			storage: assembly.storage,
		});
		record = creating(
			await replace(assembly, owned, record, {
				...record,
				revision: record.revision + 1,
				updatedAt: now(),
				operation: { ...record.operation, progress: { step: "session_header_ready", workspace, session } },
			}),
		);
		const openProjection: PersistentAgentOpenRecordV1 = {
			...record,
			revision: record.revision + 1,
			updatedAt: now(),
			phase: "open",
			operation: null,
			session,
			workspace,
			releasedAt: null,
		};
		createdSession = await createLiveSession(assembly, owned, openProjection, manager, null, record);
		manager.appendPlannedSessionInit(session.sessionInitEntryId, initPayload);
		await manager.flush();
		record = creating(
			await replace(assembly, owned, record, {
				...record,
				revision: record.revision + 1,
				updatedAt: now(),
				operation: { ...record.operation, progress: { step: "session_initialized", workspace, session } },
			}),
		);
		const initial: RuntimeAttachmentRecordV1 = {
			schemaVersion: 1,
			createId: plan.resources.runtimeAttachmentCreateId,
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
			updatedAt: now(),
		};
		const attached = await assembly.attachments.create({
			createId: plan.resources.runtimeAttachmentCreateId,
			initial,
			controllerLease: owned.controllerLease.proof,
		});
		if (attached.status !== "complete")
			throw new PersistentAgentError("recovery_required", agentId, true, "runtime_reconciliation_blocked");
		record = creating(
			await replace(assembly, owned, record, {
				...record,
				revision: record.revision + 1,
				updatedAt: now(),
				operation: {
					...record.operation,
					progress: {
						step: "runtime_none_initialized",
						workspace,
						session,
						runtimeAttachmentRevision: attached.record.revision,
					},
				},
			}),
		);
		const opened = openRecord(
			await replace(assembly, owned, record, {
				...record,
				revision: record.revision + 1,
				updatedAt: now(),
				phase: "open",
				operation: null,
				session,
				workspace,
				releasedAt: null,
			}),
		);
		const handle = new PersistentAgentHandleV1(assembly, owned, createdSession, opened);
		liveHandles.set(normalizePersistentAgentIdV1(agentId), handle);
		owned.runtimeLifecycle?.emitLifecycle("agent.created", opened);
		return handle;
	} catch (error) {
		owned?.runtimeLifecycle?.close();
		if (createdSession) await createdSession.dispose().catch(() => undefined);
		if (owned?.refBox.ref) assembly.registry.unregister(agentId, owned.refBox.ref);
		if (owned)
			await assembly.authority.release({ proof: owned.controllerLease.proof, ownership }).catch(() => undefined);
		await ownership.close();
		throw error;
	}
}

export async function openPersistentAgent(
	agentId: PersistentAgentId,
	options: OpenPersistentAgentOptions = {},
): Promise<PersistentAgentHandle> {
	normalizePersistentAgentIdV1(agentId);
	abort(options.signal);
	const existing = liveHandles.get(normalizePersistentAgentIdV1(agentId));
	if (existing) return existing;
	const assembly = await getAssembly();
	const initial = await assembly.store.lookup(agentId, options.signal);
	if (initial.kind === "missing") throw new PersistentAgentError("not_found", agentId, false, "invalid_fields");
	if (initial.kind === "invalid") throw new PersistentAgentError("invalid_record", agentId, false, initial.reason);
	if (initial.record.phase === "released")
		throw new PersistentAgentError("released", agentId, false, "invalid_phase_relationship");
	if (initial.record.phase === "recovery_required")
		throw new PersistentAgentError("recovery_required", agentId, false, initial.record.recovery.code);
	if (initial.record.phase !== "parked") {
		if (options.recovery === "none")
			throw new PersistentAgentError("recovery_required", agentId, true, "interrupted_open");
		const recovery = await assembly.store.acquire(agentId, "recover", options.signal);
		try {
			const read = await recovery.read();
			if (
				read.kind !== "record" ||
				read.record.phase === "released" ||
				read.record.phase === "recovery_required" ||
				read.record.phase === "parked"
			)
				throw new PersistentAgentError("recovery_required", agentId, false, "invalid_phase_relationship");
			const recoveryCode = (await hasDurableRuntimePreservationImpossibility(assembly, read.record))
				? "runtime_preservation_impossible"
				: persistentAgentInterruptedRecoveryCodeV1(read.record);
			const next = createPersistentAgentRecoveryRequiredRecordV1(read.record, recoveryCode, now());
			await recovery.replace(read.record.revision, next, { isCurrent: () => recovery.isHeld() });
		} finally {
			await recovery.close();
		}
		await recoverPersistentAgent(agentId, { action: "resume", signal: options.signal });
		return openPersistentAgent(agentId, { recovery: "none", signal: options.signal });
	}
	const ownership = await assembly.store.acquire(agentId, "revive", options.signal);
	let owned: OwnedRuntime | null = null;
	try {
		const lookup = await ownership.read();
		if (lookup.kind !== "record")
			throw new PersistentAgentError("revision_conflict", agentId, true, "record_revision_conflict");
		const parkedRecord = parked(lookup.record);
		const revive = {
			kind: "revive" as const,
			plan: {
				kind: "revive" as const,
				operationId: id(),
				startedAt: now(),
				startedFromRevision: parkedRecord.revision,
				session: parkedRecord.session,
				workspaceId: parkedRecord.workspace.workspaceId,
				expectedGeneration:
					parkedRecord.workspace.canonical.state === "present"
						? parkedRecord.workspace.canonical.workspace.checkpoint.generation
						: 0,
				runtimeReconcileTransitionId: id(),
				sessionOpenId: id(),
			},
			progress: { step: "planned" as const },
		};
		const ref =
			assembly.registry.get(agentId) ??
			assembly.registry.register({
				id: agentId,
				displayName: parkedRecord.displayName,
				kind: parkedRecord.kind,
				parentId: parkedRecord.parentAgentId ?? undefined,
				session: null,
				sessionFile: sessionFile(assembly, agentId, parkedRecord.session),
				status: "parked",
				persistent: binding(parkedRecord, ownership),
			});
		owned = await acquireRuntime(assembly, ownership, parkedRecord.workspace.workspaceId);
		owned.refBox.ref = ref;
		let record = reviving(
			await replace(assembly, owned, parkedRecord, {
				...parkedRecord,
				revision: parkedRecord.revision + 1,
				updatedAt: now(),
				phase: "reviving",
				operation: revive,
			}),
		);
		const checkpoint = await owned.controller.drainToNone("crash_recovery", true, options.signal);
		record = reviving(await refreshBinding(assembly, owned));
		record = reviving(
			await replace(assembly, owned, record, {
				...record,
				revision: record.revision + 1,
				updatedAt: now(),
				operation: { ...record.operation, progress: { step: "runtime_none", checkpoint } },
			}),
		);
		const manager = await SessionManager.open(
			sessionFile(assembly, agentId, record.session),
			undefined,
			assembly.storage,
			{ initialCwd: PERSISTENT_MODEL_WORKSPACE_ROOT, suppressBreadcrumb: true },
		);
		const openCandidate: PersistentAgentOpenRecordV1 = {
			...record,
			revision: record.revision + 1,
			updatedAt: now(),
			phase: "open",
			operation: null,
			releasedAt: null,
		};
		const session = await createLiveSession(assembly, owned, openCandidate, manager, ref);
		const opened = openRecord(await replace(assembly, owned, record, openCandidate));
		const handle = new PersistentAgentHandleV1(assembly, owned, session, opened);
		liveHandles.set(normalizePersistentAgentIdV1(agentId), handle);
		owned.runtimeLifecycle?.emitLifecycle("agent.revived", opened);
		return handle;
	} catch (error) {
		owned?.runtimeLifecycle?.close();
		if (owned)
			await assembly.authority.release({ proof: owned.controllerLease.proof, ownership }).catch(() => undefined);
		await ownership.close();
		throw error;
	}
}

function replicaOrder(left: KnownReplicaRecordV1, right: KnownReplicaRecordV1): number {
	return (
		left.replica.providerId.localeCompare(right.replica.providerId) ||
		left.replica.profileId.localeCompare(right.replica.profileId) ||
		left.replica.replicaId.localeCompare(right.replica.replicaId)
	);
}

async function publishDeletionWorkspace(
	assembly: LifecycleAssembly,
	owned: Pick<OwnedRuntime, "ownership" | "refBox">,
	current: PersistentAgentRecordV1,
	workspace: PersistentWorkspaceAuthorityV1,
	step?: "deletion_core_planned" | "delete_planned" | "workspace_disposition_applied",
): Promise<PersistentAgentRecordV1> {
	if (current.phase === "releasing") {
		if (step === "deletion_core_planned" && workspace.canonical.state === "delete_core_planned") {
			return replace(assembly, owned, current, {
				...current,
				revision: current.revision + 1,
				updatedAt: now(),
				workspace,
				operation: {
					...current.operation,
					progress: {
						step,
						workspace,
						deletionCore: workspace.canonical.deletionCore,
						deletionPlanCoreSha256: workspace.canonical.deletionPlanCoreSha256,
					},
				},
			});
		}
		if (step === "delete_planned" && workspace.canonical.state === "delete_planned") {
			return replace(assembly, owned, current, {
				...current,
				revision: current.revision + 1,
				updatedAt: now(),
				workspace,
				operation: {
					...current.operation,
					progress: {
						step,
						workspace,
						deletion: workspace.canonical.deletion,
						deletionPlanCoreSha256: workspace.canonical.deletionPlanCoreSha256,
						deletionPlanSha256: workspace.canonical.deletionPlanSha256,
					},
				},
			});
		}
		if (step !== "workspace_disposition_applied")
			throw new Error("Release deletion progress does not match the canonical state");
		return replace(assembly, owned, current, {
			...current,
			revision: current.revision + 1,
			updatedAt: now(),
			workspace,
			operation: { ...current.operation, progress: { step, workspace } },
		});
	}
	if (current.phase !== "released")
		throw new PersistentAgentError("invalid_transition", current.agentId, false, "invalid_phase_relationship");
	return replace(assembly, owned, current, {
		...current,
		revision: current.revision + 1,
		updatedAt: now(),
		workspace,
	});
}

async function executeWorkspaceDeletion(
	assembly: LifecycleAssembly,
	owned: Pick<OwnedRuntime, "ownership" | "refBox">,
	currentInput: PersistentAgentRecordV1,
	deletedBytesGraceMs: number,
	signal?: AbortSignal,
): Promise<PersistentAgentRecordV1> {
	abort(signal);
	let current = currentInput;
	let workspace = workspaceFrom(current);
	if (!workspace)
		throw new PersistentAgentError(
			"workspace_delete_conflict",
			current.agentId,
			false,
			"workspace_identity_conflict",
		);
	if (workspace.canonical.state === "tombstoned" || workspace.canonical.state === "purged") {
		if (current.phase === "releasing" && current.operation.plan.disposition.kind === "delete") {
			const disposition = current.operation.plan.disposition;
			const core = workspace.canonical.deletion.core;
			if (
				core.deleteId !== disposition.deleteId ||
				core.deletionAuthorityId !== disposition.deletionAuthorityId ||
				core.quarantineId !== disposition.quarantineId
			) {
				throw new PersistentAgentError(
					"workspace_delete_conflict",
					current.agentId,
					false,
					"workspace_identity_conflict",
				);
			}
			return publishDeletionWorkspace(assembly, owned, current, workspace, "workspace_disposition_applied");
		}
		return current;
	}
	let attachmentRead = await assembly.attachments.read(workspace.workspaceId);
	if (attachmentRead.status !== "present" || attachmentRead.record.attachment.state !== "none")
		throw new PersistentAgentError(
			"workspace_delete_conflict",
			current.agentId,
			true,
			"runtime_reconciliation_blocked",
		);
	let materialized: Awaited<ReturnType<typeof materializeWorkspaceDeletionPlanV1>>;
	if (workspace.canonical.state === "present") {
		const presentCanonical = workspace.canonical;
		const disposition =
			current.phase === "releasing" && current.operation.plan.disposition.kind === "delete"
				? current.operation.plan.disposition
				: { deleteId: id(), deletionAuthorityId: id(), quarantineId: id() };
		const plannedDeletionAt = now();
		const core: WorkspaceDeletionPlanCoreV1 = {
			deleteId: disposition.deleteId,
			deletionAuthorityId: disposition.deletionAuthorityId,
			quarantineId: disposition.quarantineId,
			workspaceId: workspace.workspaceId,
			expectedCheckpoint: presentCanonical.workspace.checkpoint,
			expectedRuntimeAttachmentCreateId: attachmentRead.record.createId,
			expectedRuntimeAttachmentRevision: attachmentRead.record.revision,
			expectedKnownReplicaCatalogRevision: workspace.knownReplicas.revision,
			plannedDeletionAt,
			deletedBytesGraceMs,
			purgeAfter: addMs(plannedDeletionAt, deletedBytesGraceMs),
			replicaRequests: [...workspace.knownReplicas.entries]
				.sort(replicaOrder)
				.map(row => ({ replica: row.replica, deletionAuthorityDomain: "persistent", requestId: id() })),
		};
		const deletionPlanCoreSha256 = await workspaceDeletionPlanCoreSha256V1(core);
		workspace = {
			...workspace,
			canonical: {
				state: "delete_core_planned",
				workspace: presentCanonical.workspace,
				deletionCore: core,
				deletionPlanCoreSha256,
			},
		};
		current = await publishDeletionWorkspace(assembly, owned, current, workspace, "deletion_core_planned");
		materialized = await materializeWorkspaceDeletionPlanV1(core);
		workspace = {
			...workspace,
			canonical: {
				state: "delete_planned",
				workspace: presentCanonical.workspace,
				deletion: materialized.deletion,
				deletionPlanCoreSha256: materialized.deletionPlanCoreSha256,
				deletionPlanSha256: materialized.deletionPlanSha256,
			},
		};
		current = await publishDeletionWorkspace(assembly, owned, current, workspace, "delete_planned");
	} else if (workspace.canonical.state === "delete_core_planned") {
		const staged = workspace.canonical;
		if ((await workspaceDeletionPlanCoreSha256V1(staged.deletionCore)) !== staged.deletionPlanCoreSha256)
			throw new PersistentAgentError(
				"workspace_delete_conflict",
				current.agentId,
				false,
				"workspace_identity_conflict",
			);
		materialized = await materializeWorkspaceDeletionPlanV1(staged.deletionCore);
		workspace = {
			...workspace,
			canonical: {
				state: "delete_planned",
				workspace: staged.workspace,
				deletion: materialized.deletion,
				deletionPlanCoreSha256: materialized.deletionPlanCoreSha256,
				deletionPlanSha256: materialized.deletionPlanSha256,
			},
		};
		current = await publishDeletionWorkspace(assembly, owned, current, workspace, "delete_planned");
	} else {
		const planned = workspace.canonical;
		materialized = await materializeWorkspaceDeletionPlanV1(planned.deletion.core);
		if (
			JSON.stringify(materialized.deletion) !== JSON.stringify(planned.deletion) ||
			materialized.deletionPlanCoreSha256 !== planned.deletionPlanCoreSha256 ||
			materialized.deletionPlanSha256 !== planned.deletionPlanSha256
		)
			throw new PersistentAgentError(
				"workspace_delete_conflict",
				current.agentId,
				false,
				"workspace_identity_conflict",
			);
	}
	const core = materialized.deletion.core;
	attachmentRead = await assembly.attachments.read(workspace.workspaceId);
	if (
		attachmentRead.status !== "present" ||
		attachmentRead.record.attachment.state !== "none" ||
		attachmentRead.record.createId !== core.expectedRuntimeAttachmentCreateId ||
		attachmentRead.record.revision !== core.expectedRuntimeAttachmentRevision
	)
		throw new PersistentAgentError(
			"workspace_delete_conflict",
			current.agentId,
			true,
			"runtime_reconciliation_blocked",
		);
	const authorityResult = await assembly.authority.deletionStore.acquire({
		deletion: materialized.deletion,
		deletionPlanCoreSha256: materialized.deletionPlanCoreSha256,
		deletionPlanSha256: materialized.deletionPlanSha256,
		ownership: owned.ownership,
		ttlMs: CONTROLLER_TTL_MS,
	});
	if (authorityResult.status !== "acquired")
		throw new PersistentAgentError("workspace_delete_conflict", current.agentId, true, "ownership_conflict");
	const deletionAuthority = authorityResult.authority;
	const verified = await assembly.authority.deletionStore.verify({
		proof: deletionAuthority.proof,
		ownership: owned.ownership,
		observedCanonicalGeneration: core.expectedCheckpoint.generation,
		attachment: attachmentRead.record,
	});
	if (verified.status !== "verified" && verified.status !== "already_verified")
		throw new PersistentAgentError(
			"workspace_delete_conflict",
			current.agentId,
			false,
			"workspace_identity_conflict",
		);
	const deleted = await assembly.canonical.delete({
		deletion: materialized.deletion,
		deletionPlanCoreSha256: materialized.deletionPlanCoreSha256,
		deletionPlanSha256: materialized.deletionPlanSha256,
		deletionAuthority: deletionAuthority.proof,
		deletionVerification: verified.receipt,
	});
	if (deleted.status !== "tombstoned" && deleted.status !== "already_tombstoned")
		throw new PersistentAgentError(
			"workspace_delete_conflict",
			current.agentId,
			false,
			"workspace_identity_conflict",
		);
	workspace = {
		...workspace,
		canonical: {
			state: "tombstoned",
			tombstone: deleted.tombstone,
			deletion: materialized.deletion,
			deletionPlanCoreSha256: materialized.deletionPlanCoreSha256,
			deletionPlanSha256: materialized.deletionPlanSha256,
			cleanupProof: null,
		},
	};
	current = await publishDeletionWorkspace(assembly, owned, current, workspace, "workspace_disposition_applied");
	try {
		return await resumeWorkspaceCleanup(assembly, owned, current, signal);
	} finally {
		await assembly.authority.deletionStore.release({ proof: deletionAuthority.proof, ownership: owned.ownership });
	}
}

class PersistentAgentHandleV1 implements PersistentAgentHandle {
	readonly agentId: PersistentAgentId;
	readonly #runtimeLifecycle: PersistentRuntimeLifecycleV1;
	#record: PersistentAgentRecordV1;
	#closed = false;
	constructor(
		readonly assembly: LifecycleAssembly,
		readonly owned: OwnedRuntime,
		readonly session: AgentSession,
		record: PersistentAgentRecordV1,
	) {
		if (!owned.runtimeLifecycle) throw new Error("Persistent runtime lifecycle is not bound");
		this.agentId = record.agentId;
		this.#record = record;
		this.#runtimeLifecycle = owned.runtimeLifecycle;
	}
	async runtimeStatus(signal?: AbortSignal) {
		return this.#runtimeLifecycle.status(signal);
	}
	#requireOpen() {
		if (this.#closed || this.#record.phase !== "open")
			throw new PersistentAgentError("invalid_transition", this.agentId, false, "invalid_phase_relationship");
	}
	async send(message: string, signal?: AbortSignal): Promise<void> {
		this.#requireOpen();
		if (!message) throw new TypeError("Persistent agent message must be non-empty");
		abort(signal);
		this.#runtimeLifecycle.cancelIdleRuntime();
		return this.#runtimeLifecycle.runSerialized(signal, async () => {
			this.#requireOpen();
			this.#runtimeLifecycle.cancelIdleRuntime();
			const onAbort = () => {
				void this.session.abort({ reason: "Persistent agent send aborted" });
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				await this.session.prompt(message);
			} finally {
				signal?.removeEventListener("abort", onAbort);
				this.#runtimeLifecycle.rearmIdleRuntime();
			}
		});
	}
	async status(signal?: AbortSignal): Promise<PersistentAgentPresentStatus> {
		return this.#runtimeLifecycle.runSerialized(signal, async () => {
			const record = await refreshBinding(this.assembly, this.owned);
			this.#record = record;
			return presentStatus(this.assembly, record, signal);
		});
	}
	async forkSession(signal?: AbortSignal): Promise<PersistentAgentForkResult> {
		this.#requireOpen();
		abort(signal);
		this.#runtimeLifecycle.cancelIdleRuntime();
		let transitionStarted = false;
		return this.#runtimeLifecycle
			.runSerialized(signal, async () => {
				this.#requireOpen();
				this.#runtimeLifecycle.cancelIdleRuntime();
				const sourceRecord = openRecord(await refreshBinding(this.assembly, this.owned));
				const previous = sourceRecord.session;
				const target = preallocateSession();
				const operation = {
					kind: "fork" as const,
					plan: {
						kind: "fork" as const,
						operationId: id(),
						startedAt: now(),
						startedFromRevision: sourceRecord.revision,
						source: previous,
						target,
						targetCreateId: id(),
						workspaceId: sourceRecord.workspace.workspaceId,
						expectedGeneration:
							sourceRecord.workspace.canonical.state === "present"
								? sourceRecord.workspace.canonical.workspace.checkpoint.generation
								: 0,
					},
					progress: { step: "planned" as const },
				};
				let current = forking(
					await replace(this.assembly, this.owned, sourceRecord, {
						...sourceRecord,
						revision: sourceRecord.revision + 1,
						updatedAt: now(),
						phase: "forking",
						operation,
					}),
				);
				transitionStarted = true;
				await this.session.sessionManager.flush();
				const sourceSnapshot = this.session.sessionManager.snapshotForReplication();
				const targetManager = SessionManager.createPlanned({
					sessionId: target.sessionId,
					sessionFile: sessionFile(this.assembly, this.agentId, target),
					createdAt: operation.plan.startedAt,
					cwd: PERSISTENT_MODEL_WORKSPACE_ROOT,
					parentSession: sessionFile(this.assembly, this.agentId, previous),
					storage: this.assembly.storage,
				});
				for (const entry of sourceSnapshot.entries) targetManager.ingestReplicatedEntry(entry);
				targetManager.appendPlannedSessionInit(
					target.sessionInitEntryId,
					sessionInitPayload(this.agentId, current.modelProfileId),
				);
				await targetManager.flush();
				const body = await this.assembly.storage.readText(sessionFile(this.assembly, this.agentId, target));
				current = forking(
					await replace(this.assembly, this.owned, current, {
						...current,
						revision: current.revision + 1,
						updatedAt: now(),
						operation: {
							...operation,
							progress: { step: "target_durable", target, targetSha256: sha256Ref(body) },
						},
					}),
				);
				await this.session.switchSession(sessionFile(this.assembly, this.agentId, target));
				const opened = openRecord(
					await replace(this.assembly, this.owned, current, {
						...current,
						revision: current.revision + 1,
						updatedAt: now(),
						phase: "open",
						operation: null,
						session: target,
					}),
				);
				this.#record = opened;
				this.#runtimeLifecycle.rearmIdleRuntime();
				return { previous, current: target, status: await presentStatus(this.assembly, opened, signal) };
			})
			.catch(error => {
				if (transitionStarted) this.#runtimeLifecycle.close();
				else this.#runtimeLifecycle.rearmIdleRuntime();
				throw error;
			});
	}
	async setRuntimePolicy(
		policyInput: PersistentRuntimePolicy,
		signal?: AbortSignal,
	): Promise<PersistentRuntimePolicyUpdateResultV1> {
		this.#requireOpen();
		abort(signal);
		const policy = decodePersistentRuntimePolicyV1(policyInput);
		return this.#runtimeLifecycle.runSerialized(signal, async () => {
			this.#requireOpen();
			let current = openRecord(await refreshBinding(this.assembly, this.owned));
			const previousPolicy = current.runtimePolicy;
			if (sameJson(previousPolicy, policy))
				return {
					changed: false,
					previousPolicy,
					currentPolicy: previousPolicy,
					previousRecordRevision: current.revision,
					recordRevision: current.revision,
					status: await presentStatus(this.assembly, current, signal),
				};
			this.#runtimeLifecycle.cancelIdleRuntime();
			try {
				await this.#runtimeLifecycle.drainToNone("policy_change", true, signal);
				current = openRecord(await refreshBinding(this.assembly, this.owned));
				if (!sameJson(current.runtimePolicy, previousPolicy))
					throw new PersistentAgentError(
						"revision_conflict",
						this.agentId,
						true,
						"record_revision_conflict",
					);
				const previousRecordRevision = current.revision;
				current = openRecord(
					await replace(this.assembly, this.owned, current, {
						...current,
						revision: current.revision + 1,
						updatedAt: now(),
						runtimePolicy: policy,
					}),
				);
				this.#runtimeLifecycle.commitRuntimePolicy(policy);
				this.#record = current;
				return {
					changed: true,
					previousPolicy,
					currentPolicy: policy,
					previousRecordRevision,
					recordRevision: current.revision,
					status: await presentStatus(this.assembly, current, signal),
				};
			} catch (error) {
				this.#runtimeLifecycle.rearmIdleRuntime();
				throw error;
			}
		});
	}
	async park(signal?: AbortSignal): Promise<PersistentAgentPresentStatus> {
		this.#requireOpen();
		abort(signal);
		this.#runtimeLifecycle.cancelIdleRuntime();
		let transitionStarted = false;
		return this.#runtimeLifecycle
			.runSerialized(
				signal,
				async () => {
					this.#requireOpen();
					this.#runtimeLifecycle.cancelIdleRuntime();
					const source = openRecord(await refreshBinding(this.assembly, this.owned));
					const operation = {
						kind: "park" as const,
						plan: {
							kind: "park" as const,
							operationId: id(),
							startedAt: now(),
							startedFromRevision: source.revision,
							sourceSession: source.session,
							workspaceId: source.workspace.workspaceId,
							expectedGeneration:
								source.workspace.canonical.state === "present"
									? source.workspace.canonical.workspace.checkpoint.generation
									: 0,
							runtimeTransitionId: id(),
						},
						progress: { step: "planned" as const },
					};
					let current = parking(
						await replace(this.assembly, this.owned, source, {
							...source,
							revision: source.revision + 1,
							updatedAt: now(),
							phase: "parking",
							operation,
						}),
					);
					transitionStarted = true;
					const checkpoint = await this.#runtimeLifecycle.drainToNone("park", true, signal);
					current = parking(await refreshBinding(this.assembly, this.owned));
					current = parking(
						await replace(this.assembly, this.owned, current, {
							...current,
							revision: current.revision + 1,
							updatedAt: now(),
							operation: { ...current.operation, progress: { step: "runtime_none", checkpoint } },
						}),
					);
					await this.session.sessionManager.flush();
					current = parking(
						await replace(this.assembly, this.owned, current, {
							...current,
							revision: current.revision + 1,
							updatedAt: now(),
							operation: { ...current.operation, progress: { step: "session_durable", checkpoint } },
						}),
					);
					this.assembly.registry.setStatus(this.agentId, "parked", this.owned.refBox.ref ?? undefined);
					this.assembly.registry.detachSession(this.agentId, this.owned.refBox.ref ?? undefined);
					await this.session.dispose();
					current = parking(
						await replace(this.assembly, this.owned, current, {
							...current,
							revision: current.revision + 1,
							updatedAt: now(),
							operation: { ...current.operation, progress: { step: "session_disposed", checkpoint } },
						}),
					);
					const parkedRecord = parked(
						await replace(this.assembly, this.owned, current, {
							...current,
							revision: current.revision + 1,
							updatedAt: now(),
							phase: "parked",
							operation: null,
						}),
					);
					this.#runtimeLifecycle.emitLifecycle("agent.parked", parkedRecord);
					await releaseControllerAuthority(this.assembly, this.owned);
					await this.owned.ownership.close();
					this.#closed = true;
					this.#record = parkedRecord;
					this.#runtimeLifecycle.close();
					return presentStatus(this.assembly, parkedRecord, signal);
				},
				false,
			)
			.catch(error => {
				if (transitionStarted) this.#runtimeLifecycle.close();
				else this.#runtimeLifecycle.rearmIdleRuntime();
				throw error;
			});
	}
	async release(options: ReleasePersistentAgentOptions = {}): Promise<PersistentAgentPresentStatus> {
		this.#requireOpen();
		abort(options.signal);
		this.#runtimeLifecycle.cancelIdleRuntime();
		let transitionStarted = false;
		return this.#runtimeLifecycle
			.runSerialized(
				options.signal,
				async () => {
					this.#requireOpen();
					this.#runtimeLifecycle.cancelIdleRuntime();
					const source = openRecord(await refreshBinding(this.assembly, this.owned));
					const disposition = options.deleteWorkspace
						? {
								kind: "delete" as const,
								deleteId: id(),
								deletionAuthorityId: id(),
								quarantineId: id(),
								deletedBytesGraceMs: options.deletedBytesGraceMs ?? DEFAULT_DELETE_GRACE_MS,
							}
						: { kind: "retain" as const };
					const operation = {
						kind: "release" as const,
						plan: {
							kind: "release" as const,
							operationId: id(),
							startedAt: now(),
							startedFromRevision: source.revision,
							sourceSession: source.session,
							workspaceId: source.workspace.workspaceId,
							runtimeTransitionId: id(),
							disposition,
						},
						progress: { step: "planned" as const },
					};
					let current = releasing(
						await replace(this.assembly, this.owned, source, {
							...source,
							revision: source.revision + 1,
							updatedAt: now(),
							phase: "releasing",
							operation,
						}),
					);
					transitionStarted = true;
					await this.#runtimeLifecycle.drainToNone("agent_release", true, options.signal);
					current = releasing(await refreshBinding(this.assembly, this.owned));
					current = releasing(
						await replace(this.assembly, this.owned, current, {
							...current,
							revision: current.revision + 1,
							updatedAt: now(),
							operation: {
								...current.operation,
								progress: { step: "runtime_none", workspace: current.workspace },
							},
						}),
					);
					await releaseControllerAuthority(this.assembly, this.owned);
					await this.session.sessionManager.flush();
					this.assembly.registry.setStatus(this.agentId, "aborted", this.owned.refBox.ref ?? undefined);
					this.assembly.registry.detachSession(this.agentId, this.owned.refBox.ref ?? undefined);
					await this.session.dispose();
					current = releasing(
						await replace(this.assembly, this.owned, current, {
							...current,
							revision: current.revision + 1,
							updatedAt: now(),
							operation: {
								...current.operation,
								progress: { step: "session_closed", workspace: current.workspace },
							},
						}),
					);
					if (disposition.kind === "delete")
						current = releasing(
							await executeWorkspaceDeletion(
								this.assembly,
								this.owned,
								current,
								disposition.deletedBytesGraceMs,
								options.signal,
							),
						);
					else
						current = releasing(
							await replace(this.assembly, this.owned, current, {
								...current,
								revision: current.revision + 1,
								updatedAt: now(),
								operation: {
									...current.operation,
									progress: { step: "workspace_disposition_applied", workspace: current.workspace },
								},
							}),
						);
					const completedAt = now();
					const releasedRecord = released(
						await replace(this.assembly, this.owned, current, {
							...current,
							revision: current.revision + 1,
							updatedAt: completedAt,
							phase: "released",
							operation: null,
							release: { operationId: operation.plan.operationId, disposition, completedAt },
							releasedAt: completedAt,
						}),
					);
					this.#runtimeLifecycle.emitLifecycle("agent.released", releasedRecord);
					await this.owned.ownership.close();
					if (this.owned.refBox.ref) this.assembly.registry.unregister(this.agentId, this.owned.refBox.ref);
					this.#closed = true;
					this.#record = releasedRecord;
					this.#runtimeLifecycle.close();
					return presentStatus(this.assembly, releasedRecord, options.signal);
				},
				false,
			)
			.catch(error => {
				if (transitionStarted) this.#runtimeLifecycle.close();
				else this.#runtimeLifecycle.rearmIdleRuntime();
				throw error;
			});
	}
}

export async function getPersistentAgentStatus(
	agentId: PersistentAgentId,
	signal?: AbortSignal,
): Promise<PersistentAgentStatus> {
	normalizePersistentAgentIdV1(agentId);
	abort(signal);
	const assembly = await getAssembly();
	const lookup = await assembly.store.lookup(agentId, signal);
	if (lookup.kind === "missing") return { kind: "missing", agentId };
	if (lookup.kind === "invalid")
		return {
			kind: "invalid",
			agentId,
			recordPhase: "unknown",
			state: "recovery_required",
			ownership: await assembly.store.inspectOwnership(agentId, signal),
			recovery: {
				code: "record_invalid",
				failedPhase: "unknown",
				operationId: null,
				detectedAt: now(),
				actions: [],
			},
		};
	return presentStatus(assembly, lookup.record, signal);
}

export async function listPersistentAgents(signal?: AbortSignal): Promise<readonly PersistentAgentStatus[]> {
	const assembly = await getAssembly();
	abort(signal);
	return Promise.all(
		(await assembly.store.list(signal)).map(lookup =>
			lookup.kind === "record"
				? presentStatus(assembly, lookup.record, signal)
				: lookup.kind === "invalid"
					? getPersistentAgentStatus(lookup.agentId, signal)
					: Promise.resolve({ kind: "missing" as const, agentId: lookup.agentId }),
		),
	);
}

export async function setPersistentAgentRuntimePolicy(
	agentId: PersistentAgentId,
	policy: PersistentRuntimePolicy,
	signal?: AbortSignal,
): Promise<PersistentRuntimePolicyUpdateResultV1> {
	const live = liveHandles.get(normalizePersistentAgentIdV1(agentId));
	if (live) return live.setRuntimePolicy(policy, signal);
	const decoded = decodePersistentRuntimePolicyV1(policy);
	const assembly = await getAssembly();
	const ownership = await assembly.store.acquire(agentId, "open", signal);
	try {
		const lookup = await ownership.read();
		if (lookup.kind !== "record") throw new PersistentAgentError("not_found", agentId, false, "invalid_fields");
		const current = parked(lookup.record);
		const previousPolicy = current.runtimePolicy;
		if (JSON.stringify(previousPolicy) === JSON.stringify(decoded))
			return {
				changed: false,
				previousPolicy,
				currentPolicy: previousPolicy,
				previousRecordRevision: current.revision,
				recordRevision: current.revision,
				status: await presentStatus(assembly, current, signal),
			};
		const next = parked(
			await ownership.replace(
				current.revision,
				{ ...current, revision: current.revision + 1, updatedAt: now(), runtimePolicy: decoded },
				{ isCurrent: () => ownership.isHeld() },
			),
		);
		return {
			changed: true,
			previousPolicy,
			currentPolicy: decoded,
			previousRecordRevision: current.revision,
			recordRevision: next.revision,
			status: await presentStatus(assembly, next, signal),
		};
	} finally {
		await ownership.close();
	}
}

export async function deletePersistentAgentWorkspace(
	agentId: PersistentAgentId,
	options: DeletePersistentAgentWorkspaceOptions = {},
): Promise<PersistentWorkspaceDeletionStatusV1> {
	normalizePersistentAgentIdV1(agentId);
	abort(options.signal);
	const assembly = await getAssembly();
	const ownership = await assembly.store.acquire(agentId, "delete_workspace", options.signal);
	try {
		const lookup = await ownership.read();
		if (lookup.kind !== "record") throw new PersistentAgentError("not_found", agentId, false, "invalid_fields");
		const owned: Pick<OwnedRuntime, "ownership" | "refBox"> = { ownership, refBox: { ref: null } };
		let current = released(lookup.record);
		if (current.workspace.canonical.state === "purged")
			throw new PersistentAgentError("workspace_already_deleted", agentId, false, "workspace_identity_conflict");
		if (current.workspace.canonical.state === "tombstoned")
			current = released(await resumeWorkspaceCleanup(assembly, owned, current, options.signal));
		else
			current = released(
				await executeWorkspaceDeletion(
					assembly,
					owned,
					current,
					options.deletedBytesGraceMs ?? DEFAULT_DELETE_GRACE_MS,
					options.signal,
				),
			);
		await ownership.close();
		return deletionStatus(current.workspace, now());
	} catch (error) {
		if (ownership.isHeld()) await ownership.close();
		throw error;
	}
}

async function resumeWorkspaceCleanup(
	assembly: LifecycleAssembly,
	owned: Pick<OwnedRuntime, "ownership" | "refBox">,
	currentInput: PersistentAgentRecordV1,
	signal?: AbortSignal,
): Promise<PersistentAgentRecordV1> {
	let current = currentInput;
	let workspace = workspaceFrom(current);
	if (workspace?.canonical.state !== "tombstoned") return current;
	const canonical = workspace.canonical;
	for (const planned of canonical.deletion.replicaRequests) {
		const row = workspace.knownReplicas.entries.find(
			entry => JSON.stringify(entry.replica) === JSON.stringify(planned.replica),
		);
		if (!row || row.cleanup.state === "complete") continue;
		abort(signal);
		const provider = assembly.providers.get(planned.replica.providerId);
		const request = {
			...planned.request,
			replica: planned.replica,
			authorization: {
				domain: "persistent" as const,
				deletion: canonical.deletion,
				deletionPlanCoreSha256: canonical.deletionPlanCoreSha256,
				deletionPlanSha256: canonical.deletionPlanSha256,
				tombstone: canonical.tombstone,
			},
			signal,
		};
		let result: RuntimeReplicaDeleteResult;
		try {
			const inspected = await provider.inspectReplicaDeletion(request);
			if (inspected.status === "not_started") result = await provider.deleteReplica(request);
			else result = inspected;
		} catch {
			const failedAt = now();
			const attempts =
				row.cleanup.state === "pending" || row.cleanup.state === "failed" ? row.cleanup.attempts + 1 : 1;
			const updated: KnownReplicaRecordV1 = {
				...row,
				cleanup: {
					state: "failed",
					request: planned.request,
					attempts,
					failedAt,
					code: "cleanup_failed",
					retryable: true,
					nextRetryAt: null,
				},
			};
			workspace = {
				...workspace,
				knownReplicas: replaceKnownReplicaV1(workspace.knownReplicas, workspace.knownReplicas.revision, updated),
			};
			current = await publishDeletionWorkspace(assembly, owned, current, workspace);
			continue;
		}
		const attempts = row.cleanup.state === "pending" || row.cleanup.state === "failed" ? row.cleanup.attempts + 1 : 1;
		const updated: KnownReplicaRecordV1 =
			result.status === "cleanup_pending"
				? {
						...row,
						cleanup: {
							state: "pending",
							request: planned.request,
							attempts,
							lastAttemptAt: result.observedAt,
							lastResult: "cleanup_pending",
							nextAttemptAt: result.retryAfter,
						},
					}
				: {
						...row,
						cleanup: {
							state: "complete",
							request: planned.request,
							outcome: result.status,
							completedAt: result.observedAt,
							receiptSha256: result.receiptSha256,
						},
					};
		workspace = {
			...workspace,
			knownReplicas: replaceKnownReplicaV1(workspace.knownReplicas, workspace.knownReplicas.revision, updated),
		};
		current = await publishDeletionWorkspace(assembly, owned, current, workspace);
	}
	if (workspace.knownReplicas.entries.every(row => row.cleanup.state === "complete")) {
		const proofCore = {
			schemaVersion: 1 as const,
			workspaceId: workspace.workspaceId,
			deleteId: canonical.deletion.core.deleteId,
			catalogRevision: workspace.knownReplicas.revision,
			deletionPlanCoreSha256: canonical.deletionPlanCoreSha256,
			deletionPlanSha256: canonical.deletionPlanSha256,
			entries: [...workspace.knownReplicas.entries].sort(replicaOrder).map(row => {
				if (row.cleanup.state !== "complete") throw new Error("Cleanup proof row is incomplete");
				return {
					replica: row.replica,
					deletionAuthorityDomain: "persistent" as const,
					request: row.cleanup.request,
					outcome: row.cleanup.outcome,
					completedAt: row.cleanup.completedAt,
					receiptSha256: row.cleanup.receiptSha256,
				};
			}),
			verifiedAt: now(),
		};
		const cleanupProof: TerminalReplicaCleanupProofV1 = {
			...proofCore,
			proofSha256: await terminalReplicaCleanupProofSha256V1(proofCore),
		};
		workspace = { ...workspace, canonical: { ...canonical, cleanupProof } };
		current = await publishDeletionWorkspace(assembly, owned, current, workspace);
	}
	return current;
}

export async function retryPersistentAgentWorkspaceCleanup(
	agentId: PersistentAgentId,
	signal?: AbortSignal,
): Promise<PersistentWorkspaceDeletionStatusV1> {
	const assembly = await getAssembly();
	abort(signal);
	const ownership = await assembly.store.acquire(agentId, "delete_workspace", signal);
	try {
		const lookup = await ownership.read();
		if (lookup.kind !== "record" || lookup.record.phase !== "released")
			throw new PersistentAgentError("invalid_transition", agentId, false, "invalid_phase_relationship");
		const owned: Pick<OwnedRuntime, "ownership" | "refBox"> = { ownership, refBox: { ref: null } };
		const current = released(await resumeWorkspaceCleanup(assembly, owned, released(lookup.record), signal));
		await ownership.close();
		return deletionStatus(current.workspace, now());
	} catch (error) {
		if (ownership.isHeld()) await ownership.close();
		throw error;
	}
}

export async function purgePersistentAgentWorkspace(
	agentId: PersistentAgentId,
	signal?: AbortSignal,
): Promise<PersistentWorkspaceDeletionStatusV1> {
	const assembly = await getAssembly();
	abort(signal);
	const ownership = await assembly.store.acquire(agentId, "purge_workspace", signal);
	try {
		const lookup = await ownership.read();
		if (lookup.kind !== "record")
			throw new PersistentAgentError("invalid_transition", agentId, false, "invalid_phase_relationship");
		const current = released(lookup.record);
		const workspace = current.workspace;
		if (workspace.canonical.state === "purged") {
			await ownership.close();
			return deletionStatus(workspace, now());
		}
		if (workspace.canonical.state !== "tombstoned")
			throw new PersistentAgentError("workspace_delete_conflict", agentId, true, "cleanup_failed");
		const canonical = workspace.canonical;
		const cleanupProof = canonical.cleanupProof;
		if (cleanupProof === null)
			throw new PersistentAgentError("workspace_delete_conflict", agentId, true, "cleanup_failed");
		if (Date.parse(now()) < Date.parse(canonical.tombstone.purgeAfter))
			throw new PersistentAgentError("workspace_purge_not_due", agentId, true, "workspace_identity_conflict");
		const authorityResult = await assembly.authority.deletionStore.acquire({
			deletion: canonical.deletion,
			deletionPlanCoreSha256: canonical.deletionPlanCoreSha256,
			deletionPlanSha256: canonical.deletionPlanSha256,
			ownership,
			ttlMs: CONTROLLER_TTL_MS,
		});
		if (authorityResult.status !== "acquired")
			throw new PersistentAgentError("workspace_delete_conflict", agentId, true, "ownership_conflict");
		const purged = await assembly.canonical.purge({
			workspaceId: workspace.workspaceId,
			deletion: canonical.deletion,
			deletionPlanCoreSha256: canonical.deletionPlanCoreSha256,
			deletionPlanSha256: canonical.deletionPlanSha256,
			deletionAuthority: authorityResult.authority.proof,
			cleanupProof,
		});
		if (purged.status !== "purged" && purged.status !== "already_purged")
			throw new PersistentAgentError(
				purged.status === "not_due" ? "workspace_purge_not_due" : "workspace_delete_conflict",
				agentId,
				purged.status === "not_due",
				"workspace_identity_conflict",
			);
		const purgedCleanupProof = purged.cleanupProof;
		if (purgedCleanupProof === null)
			throw new PersistentAgentError("workspace_delete_conflict", agentId, false, "workspace_identity_conflict");
		const nextWorkspace: PersistentWorkspaceAuthorityV1 = {
			...workspace,
			canonical: {
				state: "purged",
				tombstone: purged.tombstone,
				deletion: canonical.deletion,
				deletionPlanCoreSha256: canonical.deletionPlanCoreSha256,
				deletionPlanSha256: canonical.deletionPlanSha256,
				cleanupProof: purgedCleanupProof,
				purgedAt: now(),
			},
		};
		await ownership.replace(
			current.revision,
			{ ...current, revision: current.revision + 1, updatedAt: now(), workspace: nextWorkspace },
			{ isCurrent: () => ownership.isHeld() },
		);
		await assembly.authority.deletionStore.release({ proof: authorityResult.authority.proof, ownership });
		await ownership.close();
		return deletionStatus(nextWorkspace, now());
	} catch (error) {
		if (ownership.isHeld()) await ownership.close();
		throw error;
	}
}

async function recoverCreateToParked(
	assembly: LifecycleAssembly,
	ownership: PersistentAgentOwnership,
	record: PersistentAgentRecoveryRequiredRecordV1,
	options: RecoverPersistentAgentOptions,
): Promise<PersistentAgentStatus> {
	if (record.recovery.failedPhase !== "creating") recoveryFailure(record.agentId, "invalid_phase_relationship");
	const operation = record.recovery.operation;
	const plan = operation.plan;
	const owned = await acquireRuntime(assembly, ownership, plan.resources.workspaceId);
	let manager: SessionManager | null = null;
	let liveSession: AgentSession | null = null;
	try {
		const inspected = await assembly.canonical.inspectCreate({
			workspaceId: plan.resources.workspaceId,
			createId: plan.resources.workspaceCreateId,
			stageId: plan.resources.workspaceStageId,
		});
		let managedWorkspace: Extract<
			PersistentWorkspaceAuthorityV1["canonical"],
			{ readonly state: "present" }
		>["workspace"];
		if (inspected.status === "present") {
			managedWorkspace = inspected.workspace;
			if (options.copySourcePath !== undefined) recoveryFailure(record.agentId, "invalid_fields");
		} else {
			if (inspected.status === "conflict") recoveryFailure(record.agentId, "workspace_identity_mismatch");
			if (plan.seed.kind === "copy") {
				const source = await assembly.seeds.inspect(plan.seed.source);
				if (source.status === "conflict") recoveryFailure(record.agentId, "seed_source_changed");
				if (source.status === "absent") {
					if (options.copySourcePath === undefined) recoveryFailure(record.agentId, "seed_source_binding_missing");
					const seed = await readManagedWorkspaceSeedSourceV1({
						sourcePath: options.copySourcePath,
						limits: plan.seed.source.limits,
						signal: options.signal,
					});
					if (!sameJson(seed.image, plan.seed.source.expectedImage))
						recoveryFailure(record.agentId, "seed_source_changed");
					const bound = await assembly.seeds.bind({
						source: plan.seed.source,
						sourcePath: options.copySourcePath,
						expiresAt: addMs(now(), COPY_BIND_TTL_MS),
					});
					if (bound.status === "conflict") recoveryFailure(record.agentId, "seed_source_changed");
				} else if (options.copySourcePath !== undefined) {
					recoveryFailure(record.agentId, "invalid_fields");
				}
			} else if (options.copySourcePath !== undefined) {
				recoveryFailure(record.agentId, "invalid_fields");
			}
			const created = await assembly.canonical.create({
				createId: plan.resources.workspaceCreateId,
				stageId: plan.resources.workspaceStageId,
				workspaceId: plan.resources.workspaceId,
				seed: plan.seed,
				expectedImage: plan.seed.kind === "copy" ? plan.seed.source.expectedImage : plan.seed.expectedImage,
				retention: plan.retention,
				controllerLease: owned.controllerLease.proof,
			});
			if (created.status !== "created" && created.status !== "already_created") {
				recoveryFailure(record.agentId, "workspace_identity_mismatch", created.status === "controller_lost");
			}
			managedWorkspace = created.workspace;
		}
		const expectedImage = plan.seed.kind === "copy" ? plan.seed.source.expectedImage : plan.seed.expectedImage;
		if (
			managedWorkspace.workspaceId !== plan.resources.workspaceId ||
			managedWorkspace.checkpoint.generation !== 0 ||
			managedWorkspace.checkpoint.rootSha256 !== expectedImage.rootSha256 ||
			managedWorkspace.checkpoint.fileCount !== expectedImage.fileCount ||
			managedWorkspace.checkpoint.byteCount !== expectedImage.byteCount ||
			!sameJson(managedWorkspace.retention, plan.retention)
		)
			recoveryFailure(record.agentId, "workspace_identity_mismatch");
		if (plan.seed.kind === "copy")
			await assembly.seeds.release({ source: plan.seed.source, reason: "workspace_ready" });
		const workspace: PersistentWorkspaceAuthorityV1 = {
			workspaceId: plan.resources.workspaceId,
			canonical: { state: "present", workspace: managedWorkspace },
			knownReplicas: { revision: 0, entries: [] },
		};
		if (operation.progress.step !== "planned" && !sameJson(operation.progress.workspace, workspace)) {
			recoveryFailure(record.agentId, "workspace_identity_mismatch");
		}
		let current = creating(
			await replace(assembly, owned, record, {
				...recordCommon(record),
				revision: record.revision + 1,
				updatedAt: now(),
				phase: "creating",
				operation,
				releasedAt: null,
			}),
		);
		if (current.operation.progress.step === "planned") {
			current = creating(
				await replace(assembly, owned, current, {
					...current,
					revision: current.revision + 1,
					updatedAt: now(),
					operation: { ...current.operation, progress: { step: "workspace_ready", workspace } },
				}),
			);
		}
		manager = await openOrCreatePlannedSession(assembly, record.agentId, plan.resources.session, plan.startedAt);
		if (current.operation.progress.step === "workspace_ready") {
			current = creating(
				await replace(assembly, owned, current, {
					...current,
					revision: current.revision + 1,
					updatedAt: now(),
					operation: {
						...current.operation,
						progress: { step: "session_header_ready", workspace, session: plan.resources.session },
					},
				}),
			);
		} else if (
			current.operation.progress.step === "planned" ||
			!sameJson(current.operation.progress.session, plan.resources.session)
		) {
			recoveryFailure(record.agentId, "session_identity_mismatch");
		}
		const initPayload = sessionInitPayload(record.agentId, record.modelProfileId);
		if (sha256Ref(initPayload) !== plan.sessionInitPayloadSha256)
			recoveryFailure(record.agentId, "session_identity_mismatch");
		await ensurePlannedSessionInit(assembly, record.agentId, plan.resources.session, manager, initPayload);
		if (current.operation.progress.step === "session_header_ready") {
			current = creating(
				await replace(assembly, owned, current, {
					...current,
					revision: current.revision + 1,
					updatedAt: now(),
					operation: {
						...current.operation,
						progress: { step: "session_initialized", workspace, session: plan.resources.session },
					},
				}),
			);
		}
		const attachmentInspection = await assembly.attachments.inspectCreate({
			workspaceId: plan.resources.workspaceId,
			createId: plan.resources.runtimeAttachmentCreateId,
		});
		let attachmentRecord: RuntimeAttachmentRecordV1;
		if (attachmentInspection.status === "missing") {
			const initial: RuntimeAttachmentRecordV1 = {
				schemaVersion: 1,
				createId: plan.resources.runtimeAttachmentCreateId,
				revision: 1,
				workspaceId: plan.resources.workspaceId,
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
				updatedAt: now(),
			};
			const created = await assembly.attachments.create({
				createId: plan.resources.runtimeAttachmentCreateId,
				initial,
				controllerLease: owned.controllerLease.proof,
			});
			if (created.status !== "complete")
				recoveryFailure(record.agentId, "runtime_reconciliation_blocked", created.status === "controller_lost");
			attachmentRecord = created.record;
		} else if (attachmentInspection.status === "complete") {
			attachmentRecord = attachmentInspection.record;
		} else {
			recoveryFailure(record.agentId, "runtime_reconciliation_blocked");
		}
		if (
			attachmentRecord.revision !== 1 ||
			attachmentRecord.createId !== plan.resources.runtimeAttachmentCreateId ||
			attachmentRecord.attachment.state !== "none"
		) {
			recoveryFailure(record.agentId, "runtime_reconciliation_blocked");
		}
		if (current.operation.progress.step === "session_initialized") {
			current = creating(
				await replace(assembly, owned, current, {
					...current,
					revision: current.revision + 1,
					updatedAt: now(),
					operation: {
						...current.operation,
						progress: {
							step: "runtime_none_initialized",
							workspace,
							session: plan.resources.session,
							runtimeAttachmentRevision: 1,
						},
					},
				}),
			);
		}
		if (
			current.operation.progress.step !== "runtime_none_initialized" ||
			current.operation.progress.runtimeAttachmentRevision !== 1
		) {
			recoveryFailure(record.agentId, "runtime_reconciliation_blocked");
		}
		if (assembly.registry.get(record.agentId)) recoveryFailure(record.agentId, "record_revision_conflict", true);
		const openCandidate: PersistentAgentOpenRecordV1 = {
			...recordCommon(current),
			revision: current.revision + 1,
			updatedAt: now(),
			phase: "open",
			operation: null,
			session: plan.resources.session,
			workspace,
			releasedAt: null,
		};
		liveSession = await createLiveSession(assembly, owned, openCandidate, manager, null);
		manager = null;
		const opened = openRecord(await replace(assembly, owned, current, openCandidate));
		const handle = new PersistentAgentHandleV1(assembly, owned, liveSession, opened);
		liveHandles.set(normalizePersistentAgentIdV1(record.agentId), handle);
		return handle.park(options.signal);
	} catch (error) {
		owned.runtimeLifecycle?.close();
		if (liveSession) await liveSession.dispose().catch(() => undefined);
		if (owned.refBox.ref) assembly.registry.unregister(record.agentId, owned.refBox.ref);
		if (manager) await manager.close().catch(() => undefined);
		if (ownership.isHeld()) await releaseControllerAuthority(assembly, owned).catch(() => undefined);
		throw error;
	}
}

async function openExactExistingSession(
	assembly: LifecycleAssembly,
	agentId: PersistentAgentId,
	ref: PersistentAgentSessionRef,
	modelProfileId: string,
): Promise<SessionManager> {
	const file = sessionFile(assembly, agentId, ref);
	const entries = await loadEntriesFromFile(file, assembly.storage);
	const header = entries[0];
	if (!header) recoveryFailure(agentId, "session_missing");
	if (
		header.type !== "session" ||
		header.id !== ref.sessionId ||
		header.cwd !== path.resolve(PERSISTENT_MODEL_WORKSPACE_ROOT)
	) {
		recoveryFailure(agentId, "session_identity_mismatch");
	}
	if (!requirePlannedSessionInit(agentId, entries, ref, sessionInitPayload(agentId, modelProfileId))) {
		recoveryFailure(agentId, "session_init_missing");
	}
	return SessionManager.open(file, undefined, assembly.storage, {
		initialCwd: PERSISTENT_MODEL_WORKSPACE_ROOT,
		suppressBreadcrumb: true,
	});
}

async function closeExactRecoveredSession(
	assembly: LifecycleAssembly,
	agentId: PersistentAgentId,
	ref: PersistentAgentSessionRef,
	modelProfileId: string,
): Promise<void> {
	const file = sessionFile(assembly, agentId, ref);
	const entries = await loadEntriesFromFile(file, assembly.storage);
	const header = entries[0];
	if (!header) recoveryFailure(agentId, "session_missing");
	if (
		header.type !== "session" ||
		header.id !== ref.sessionId ||
		header.cwd !== path.resolve(PERSISTENT_MODEL_WORKSPACE_ROOT)
	)
		recoveryFailure(agentId, "session_identity_mismatch");
	if (!requirePlannedSessionInit(agentId, entries, ref, sessionInitPayload(agentId, modelProfileId)))
		recoveryFailure(agentId, "session_init_missing");
	const live = assembly.registry.get(agentId)?.session;
	if (live) {
		await live.sessionManager.flush();
		return;
	}
	const manager = await SessionManager.open(file, undefined, assembly.storage, {
		initialCwd: PERSISTENT_MODEL_WORKSPACE_ROOT,
		suppressBreadcrumb: true,
	});
	await manager.flush();
	await manager.close();
}

async function continueParkingToParked(
	assembly: LifecycleAssembly,
	owned: OwnedRuntime,
	record: PersistentAgentRecoveryRequiredRecordV1,
	signal?: AbortSignal,
	checkpointOverride?: WorkspaceCheckpoint,
): Promise<PersistentAgentStatus> {
	if (record.recovery.failedPhase !== "parking") recoveryFailure(record.agentId, "invalid_phase_relationship");
	let current = parking(
		await replace(assembly, owned, record, {
			...recordCommon(record),
			revision: record.revision + 1,
			updatedAt: now(),
			phase: "parking",
			operation: record.recovery.operation,
			session: record.recovery.session,
			workspace: record.recovery.workspace,
			releasedAt: null,
		}),
	);
	if (current.operation.progress.step === "planned") {
		const checkpoint = checkpointOverride ?? (await owned.controller.drainToNone("park", true, signal));
		current = parking(await refreshBinding(assembly, owned));
		current = parking(
			await replace(assembly, owned, current, {
				...current,
				revision: current.revision + 1,
				updatedAt: now(),
				operation: { ...current.operation, progress: { step: "runtime_none", checkpoint } },
			}),
		);
	} else if (checkpointOverride && !sameJson(current.operation.progress.checkpoint, checkpointOverride)) {
		recoveryFailure(record.agentId, "runtime_reconciliation_blocked");
	}
	if (current.operation.progress.step === "runtime_none") {
		await closeExactRecoveredSession(assembly, current.agentId, current.session, current.modelProfileId);
		current = parking(
			await replace(assembly, owned, current, {
				...current,
				revision: current.revision + 1,
				updatedAt: now(),
				operation: {
					...current.operation,
					progress: { step: "session_durable", checkpoint: current.operation.progress.checkpoint },
				},
			}),
		);
	}
	if (current.operation.progress.step === "session_durable") {
		await disposeRecoveredSession(assembly, current.agentId);
		current = parking(
			await replace(assembly, owned, current, {
				...current,
				revision: current.revision + 1,
				updatedAt: now(),
				operation: {
					...current.operation,
					progress: { step: "session_disposed", checkpoint: current.operation.progress.checkpoint },
				},
			}),
		);
	}
	if (current.operation.progress.step !== "session_disposed")
		recoveryFailure(record.agentId, "session_dispose_failed", true);
	const parkedRecord = parked(
		await replace(assembly, owned, current, {
			...recordCommon(current),
			revision: current.revision + 1,
			updatedAt: now(),
			phase: "parked",
			operation: null,
			session: current.session,
			workspace: current.workspace,
			releasedAt: null,
		}),
	);
	await releaseControllerAuthority(assembly, owned);
	await owned.ownership.close();
	return presentStatus(assembly, parkedRecord, signal);
}

async function recoverParkingToParked(
	assembly: LifecycleAssembly,
	ownership: PersistentAgentOwnership,
	record: PersistentAgentRecoveryRequiredRecordV1,
	signal?: AbortSignal,
): Promise<PersistentAgentStatus> {
	if (record.recovery.failedPhase !== "parking") recoveryFailure(record.agentId, "invalid_phase_relationship");
	const owned = await acquireRuntime(assembly, ownership, record.recovery.workspace.workspaceId);
	try {
		return await continueParkingToParked(assembly, owned, record, signal);
	} catch (error) {
		if (ownership.isHeld()) await releaseControllerAuthority(assembly, owned).catch(() => undefined);
		throw error;
	}
}

async function recoverSteadyToParked(
	assembly: LifecycleAssembly,
	ownership: PersistentAgentOwnership,
	record: PersistentAgentRecoveryRequiredRecordV1,
	signal?: AbortSignal,
): Promise<PersistentAgentStatus> {
	if (
		record.recovery.failedPhase !== "open" &&
		record.recovery.failedPhase !== "parked" &&
		record.recovery.failedPhase !== "reviving"
	) {
		recoveryFailure(record.agentId, "invalid_phase_relationship");
	}
	const owned = await acquireRuntime(assembly, ownership, record.recovery.workspace.workspaceId);
	try {
		let current: PersistentAgentRecordV1 = record;
		if (record.recovery.failedPhase === "reviving") {
			let revivingRecord = reviving(
				await replace(assembly, owned, record, {
					...recordCommon(record),
					revision: record.revision + 1,
					updatedAt: now(),
					phase: "reviving",
					operation: record.recovery.operation,
					session: record.recovery.session,
					workspace: record.recovery.workspace,
					releasedAt: null,
				}),
			);
			if (revivingRecord.operation.progress.step === "planned") {
				const checkpoint = await owned.controller.drainToNone("crash_recovery", true, signal);
				revivingRecord = reviving(await refreshBinding(assembly, owned));
				revivingRecord = reviving(
					await replace(assembly, owned, revivingRecord, {
						...revivingRecord,
						revision: revivingRecord.revision + 1,
						updatedAt: now(),
						operation: { ...revivingRecord.operation, progress: { step: "runtime_none", checkpoint } },
					}),
				);
			}
			if (revivingRecord.operation.progress.step !== "runtime_none")
				recoveryFailure(record.agentId, "runtime_reconciliation_blocked");
			current = revivingRecord;
		} else {
			await owned.controller.drainToNone("crash_recovery", true, signal);
			current = await refreshBinding(assembly, owned);
			if (current.phase !== "recovery_required" || current.recovery.failedPhase !== record.recovery.failedPhase) {
				recoveryFailure(record.agentId, "record_revision_conflict", true);
			}
		}
		await disposeRecoveredSession(assembly, record.agentId);
		let session: PersistentAgentSessionRef;
		let workspace: PersistentWorkspaceAuthorityV1;
		if (current.phase === "reviving") {
			session = current.session;
			workspace = current.workspace;
		} else {
			if (current.phase !== "recovery_required" || current.recovery.failedPhase === "creating")
				recoveryFailure(record.agentId, "record_revision_conflict", true);
			session = current.recovery.session;
			workspace = current.recovery.workspace;
		}
		const parkedRecord = parked(
			await replace(assembly, owned, current, {
				...recordCommon(current),
				revision: current.revision + 1,
				updatedAt: now(),
				phase: "parked",
				operation: null,
				session,
				workspace,
				releasedAt: null,
			}),
		);
		await releaseControllerAuthority(assembly, owned);
		await ownership.close();
		return presentStatus(assembly, parkedRecord, signal);
	} catch (error) {
		if (ownership.isHeld()) await releaseControllerAuthority(assembly, owned).catch(() => undefined);
		throw error;
	}
}
async function recoverForkToParked(
	assembly: LifecycleAssembly,
	ownership: PersistentAgentOwnership,
	record: PersistentAgentRecoveryRequiredRecordV1,
	signal?: AbortSignal,
): Promise<PersistentAgentStatus> {
	if (record.recovery.failedPhase !== "forking") recoveryFailure(record.agentId, "invalid_phase_relationship");
	const operation = record.recovery.operation;
	const plan = operation.plan;
	const owned = await acquireRuntime(assembly, ownership, record.recovery.workspace.workspaceId);
	let targetManager: SessionManager | null = null;
	let liveSession: AgentSession | null = null;
	try {
		const sourceManager = await openExactExistingSession(
			assembly,
			record.agentId,
			plan.source,
			record.modelProfileId,
		);
		await sourceManager.flush();
		const sourceSnapshot = sourceManager.snapshotForReplication();
		const targetFile = sessionFile(assembly, record.agentId, plan.target);
		const sourceFile = sessionFile(assembly, record.agentId, plan.source);
		let targetEntries = await loadEntriesFromFile(targetFile, assembly.storage);
		if (targetEntries.length === 0) {
			if (assembly.storage.existsSync(targetFile)) recoveryFailure(record.agentId, "session_invalid");
			targetManager = SessionManager.createPlanned({
				sessionId: plan.target.sessionId,
				sessionFile: targetFile,
				createdAt: plan.startedAt,
				cwd: PERSISTENT_MODEL_WORKSPACE_ROOT,
				parentSession: sourceFile,
				storage: assembly.storage,
			});
			for (const entry of sourceSnapshot.entries) targetManager.ingestReplicatedEntry(entry);
			targetManager.appendPlannedSessionInit(
				plan.target.sessionInitEntryId,
				sessionInitPayload(record.agentId, record.modelProfileId),
			);
			await targetManager.flush();
			targetEntries = await loadEntriesFromFile(targetFile, assembly.storage);
		} else {
			targetManager = await SessionManager.open(targetFile, undefined, assembly.storage, {
				initialCwd: PERSISTENT_MODEL_WORKSPACE_ROOT,
				suppressBreadcrumb: true,
			});
		}
		await sourceManager.close();
		requirePlannedSessionHeader(record.agentId, targetEntries, plan.target, plan.startedAt, sourceFile);
		if (
			!requirePlannedSessionInit(
				record.agentId,
				targetEntries,
				plan.target,
				sessionInitPayload(record.agentId, record.modelProfileId),
			)
		) {
			recoveryFailure(record.agentId, "session_init_missing");
		}
		if (
			targetEntries.length !== sourceSnapshot.entries.length + 2 ||
			!sameJson(targetEntries.slice(1, -1), sourceSnapshot.entries)
		) {
			recoveryFailure(record.agentId, "session_identity_mismatch");
		}
		const targetSha256 = sha256Ref(await assembly.storage.readText(targetFile));
		if (
			operation.progress.step === "target_durable" &&
			(operation.progress.targetSha256 !== targetSha256 || !sameJson(operation.progress.target, plan.target))
		) {
			recoveryFailure(record.agentId, "session_identity_mismatch");
		}
		const expectedRef = attachRecoveryRegistryRef(assembly, owned, record, plan.target);
		let current = forking(
			await replace(assembly, owned, record, {
				...recordCommon(record),
				revision: record.revision + 1,
				updatedAt: now(),
				phase: "forking",
				operation,
				session: record.recovery.session,
				workspace: record.recovery.workspace,
				releasedAt: null,
			}),
		);
		if (current.operation.progress.step === "planned") {
			current = forking(
				await replace(assembly, owned, current, {
					...current,
					revision: current.revision + 1,
					updatedAt: now(),
					operation: {
						...current.operation,
						progress: { step: "target_durable", target: plan.target, targetSha256 },
					},
				}),
			);
		}
		if (current.operation.progress.step !== "target_durable")
			recoveryFailure(record.agentId, "session_identity_mismatch");
		const openCandidate: PersistentAgentOpenRecordV1 = {
			...recordCommon(current),
			revision: current.revision + 1,
			updatedAt: now(),
			phase: "open",
			operation: null,
			session: plan.target,
			workspace: current.workspace,
			releasedAt: null,
		};
		if (!targetManager) recoveryFailure(record.agentId, "session_missing");
		liveSession = await createLiveSession(assembly, owned, openCandidate, targetManager, expectedRef);
		targetManager = null;
		const opened = openRecord(await replace(assembly, owned, current, openCandidate));
		const handle = new PersistentAgentHandleV1(assembly, owned, liveSession, opened);
		liveHandles.set(normalizePersistentAgentIdV1(record.agentId), handle);
		return handle.park(signal);
	} catch (error) {
		owned.runtimeLifecycle?.close();
		if (liveSession) await liveSession.dispose().catch(() => undefined);
		if (owned.refBox.ref) assembly.registry.unregister(record.agentId, owned.refBox.ref);
		if (targetManager) await targetManager.close().catch(() => undefined);
		if (ownership.isHeld()) await releaseControllerAuthority(assembly, owned).catch(() => undefined);
		throw error;
	}
}

async function finishReleaseFromRuntimeNone(
	assembly: LifecycleAssembly,
	ownership: PersistentAgentOwnership,
	currentInput: PersistentAgentReleasingRecordV1,
	signal?: AbortSignal,
): Promise<PersistentAgentStatus> {
	const owned: Pick<OwnedRuntime, "ownership" | "refBox"> = { ownership, refBox: { ref: null } };
	let current = currentInput;
	if (current.operation.progress.step === "runtime_none") {
		await closeExactRecoveredSession(assembly, current.agentId, current.session, current.modelProfileId);
		await disposeRecoveredSession(assembly, current.agentId);
		current = releasing(
			await replace(assembly, owned, current, {
				...current,
				revision: current.revision + 1,
				updatedAt: now(),
				operation: { ...current.operation, progress: { step: "session_closed", workspace: current.workspace } },
			}),
		);
	}
	const disposition = current.operation.plan.disposition;
	if (current.operation.progress.step === "session_closed") {
		if (disposition.kind === "retain") {
			current = releasing(
				await replace(assembly, owned, current, {
					...current,
					revision: current.revision + 1,
					updatedAt: now(),
					operation: {
						...current.operation,
						progress: { step: "workspace_disposition_applied", workspace: current.workspace },
					},
				}),
			);
		} else {
			current = releasing(
				await executeWorkspaceDeletion(assembly, owned, current, disposition.deletedBytesGraceMs, signal),
			);
		}
	} else if (
		disposition.kind === "delete" &&
		(current.operation.progress.step === "deletion_core_planned" ||
			current.operation.progress.step === "delete_planned")
	) {
		current = releasing(
			await executeWorkspaceDeletion(assembly, owned, current, disposition.deletedBytesGraceMs, signal),
		);
	}
	if (current.operation.progress.step !== "workspace_disposition_applied")
		recoveryFailure(current.agentId, "cleanup_failed", true);
	const completedAt = now();
	const releasedRecord = released(
		await replace(assembly, owned, current, {
			...recordCommon(current),
			revision: current.revision + 1,
			updatedAt: completedAt,
			phase: "released",
			operation: null,
			session: current.session,
			workspace: current.workspace,
			release: { operationId: current.operation.plan.operationId, disposition, completedAt },
			releasedAt: completedAt,
		}),
	);
	const ref = assembly.registry.get(current.agentId);
	if (ref) assembly.registry.unregister(current.agentId, ref);
	liveHandles.delete(normalizePersistentAgentIdV1(current.agentId));
	await ownership.close();
	return presentStatus(assembly, releasedRecord, signal);
}

async function recoverReleaseToReleased(
	assembly: LifecycleAssembly,
	ownership: PersistentAgentOwnership,
	record: PersistentAgentRecoveryRequiredRecordV1,
	signal?: AbortSignal,
): Promise<PersistentAgentStatus> {
	if (record.recovery.failedPhase !== "releasing") recoveryFailure(record.agentId, "invalid_phase_relationship");
	const disposition = record.recovery.operation.plan.disposition;
	if (disposition.kind === "delete") {
		if (
			new Set([disposition.deleteId, disposition.deletionAuthorityId, disposition.quarantineId]).size !== 3 ||
			!Number.isSafeInteger(disposition.deletedBytesGraceMs) ||
			disposition.deletedBytesGraceMs < 0
		)
			recoveryFailure(record.agentId, "invalid_fields");
	}
	let owned: OwnedRuntime | null = null;
	let replaceOwner: Pick<OwnedRuntime, "ownership" | "refBox"> = { ownership, refBox: { ref: null } };
	try {
		const canonicalState = record.recovery.workspace.canonical.state;
		if (canonicalState !== "tombstoned" && canonicalState !== "purged") {
			owned = await acquireRuntime(assembly, ownership, record.recovery.workspace.workspaceId);
			replaceOwner = { ownership, refBox: owned.refBox };
		}
		let current = releasing(
			await replace(assembly, replaceOwner, record, {
				...recordCommon(record),
				revision: record.revision + 1,
				updatedAt: now(),
				phase: "releasing",
				operation: record.recovery.operation,
				session: record.recovery.session,
				workspace: record.recovery.workspace,
				releasedAt: null,
			}),
		);
		if (current.operation.progress.step === "planned") {
			if (!owned) recoveryFailure(record.agentId, "ownership_conflict", true);
			await owned.controller.drainToNone("agent_release", true, signal);
			current = releasing(await refreshBinding(assembly, owned));
			current = releasing(
				await replace(assembly, owned, current, {
					...current,
					revision: current.revision + 1,
					updatedAt: now(),
					operation: { ...current.operation, progress: { step: "runtime_none", workspace: current.workspace } },
				}),
			);
		}
		if (owned) {
			await releaseControllerAuthority(assembly, owned);
			owned = null;
		}
		return finishReleaseFromRuntimeNone(assembly, ownership, current, signal);
	} catch (error) {
		if (owned && ownership.isHeld()) await releaseControllerAuthority(assembly, owned).catch(() => undefined);
		throw error;
	}
}

async function recoverAfterAuthorizedDiscard(
	assembly: LifecycleAssembly,
	ownership: PersistentAgentOwnership,
	record: PersistentAgentRecoveryRequiredRecordV1,
	signal?: AbortSignal,
): Promise<PersistentAgentStatus> {
	if (record.recovery.code !== "runtime_preservation_impossible" || record.recovery.failedPhase === "creating") {
		recoveryFailure(record.agentId, "runtime_reconciliation_blocked");
	}
	const workspace = record.recovery.workspace;
	const owned = await acquireRuntime(assembly, ownership, workspace.workspaceId);
	try {
		const read = await assembly.attachments.read(workspace.workspaceId);
		if (read.status !== "present") recoveryFailure(record.agentId, "runtime_reconciliation_blocked");
		const attachment = read.record.attachment;
		let authorization: RuntimeDiscardRuntimeChangesAuthorization;
		if (attachment.state === "draining") {
			if (
				attachment.plan.freezeAuthority !== "control_plane_recovery" ||
				attachment.recoveryFreeze?.state !== "preservation_impossible"
			) {
				recoveryFailure(record.agentId, "runtime_reconciliation_blocked");
			}
			authorization = attachment.discardAuthorization ?? {
				schemaVersion: 1,
				discardId: id(),
				expectedAttachmentRevision: read.record.revision,
				ownerEpoch: ownership.ownerEpoch,
				impossibility: attachment.recoveryFreeze.proof,
				authorizedAt: now(),
			};
		} else if (attachment.state === "none" && attachment.lastDiscardedRuntimeChanges !== null) {
			authorization = attachment.lastDiscardedRuntimeChanges;
		} else {
			recoveryFailure(record.agentId, "runtime_reconciliation_blocked");
		}
		const discarded = await owned.controller.discardRuntimeChangesAfterPreservationImpossible(authorization, signal);
		const refreshed = recoveryRequired(await refreshBinding(assembly, owned));
		if (
			refreshed.recovery.failedPhase !== record.recovery.failedPhase ||
			refreshed.recovery.operationId !== record.recovery.operationId
		) {
			recoveryFailure(record.agentId, "record_revision_conflict", true);
		}
		if (refreshed.recovery.failedPhase === "parking") {
			return continueParkingToParked(assembly, owned, refreshed, signal, discarded.checkpoint);
		}
		if (refreshed.recovery.failedPhase === "releasing") {
			let current = releasing(
				await replace(assembly, owned, refreshed, {
					...recordCommon(refreshed),
					revision: refreshed.revision + 1,
					updatedAt: now(),
					phase: "releasing",
					operation: refreshed.recovery.operation,
					session: refreshed.recovery.session,
					workspace: refreshed.recovery.workspace,
					releasedAt: null,
				}),
			);
			if (current.operation.progress.step === "planned") {
				current = releasing(
					await replace(assembly, owned, current, {
						...current,
						revision: current.revision + 1,
						updatedAt: now(),
						operation: { ...current.operation, progress: { step: "runtime_none", workspace: current.workspace } },
					}),
				);
			}
			await releaseControllerAuthority(assembly, owned);
			return finishReleaseFromRuntimeNone(assembly, ownership, current, signal);
		}
		if (refreshed.recovery.failedPhase === "forking") {
			await releaseControllerAuthority(assembly, owned);
			return recoverForkToParked(assembly, ownership, refreshed, signal);
		}
		if (refreshed.recovery.failedPhase === "reviving") {
			let current = reviving(
				await replace(assembly, owned, refreshed, {
					...recordCommon(refreshed),
					revision: refreshed.revision + 1,
					updatedAt: now(),
					phase: "reviving",
					operation: refreshed.recovery.operation,
					session: refreshed.recovery.session,
					workspace: refreshed.recovery.workspace,
					releasedAt: null,
				}),
			);
			if (current.operation.progress.step === "planned") {
				current = reviving(
					await replace(assembly, owned, current, {
						...current,
						revision: current.revision + 1,
						updatedAt: now(),
						operation: {
							...current.operation,
							progress: { step: "runtime_none", checkpoint: discarded.checkpoint },
						},
					}),
				);
			} else if (!sameJson(current.operation.progress.checkpoint, discarded.checkpoint)) {
				recoveryFailure(record.agentId, "runtime_reconciliation_blocked");
			}
			await disposeRecoveredSession(assembly, current.agentId);
			const parkedRecord = parked(
				await replace(assembly, owned, current, {
					...recordCommon(current),
					revision: current.revision + 1,
					updatedAt: now(),
					phase: "parked",
					operation: null,
					session: current.session,
					workspace: current.workspace,
					releasedAt: null,
				}),
			);
			await releaseControllerAuthority(assembly, owned);
			await ownership.close();
			return presentStatus(assembly, parkedRecord, signal);
		}
		if (refreshed.recovery.failedPhase !== "open" && refreshed.recovery.failedPhase !== "parked") {
			recoveryFailure(record.agentId, "invalid_phase_relationship");
		}
		await disposeRecoveredSession(assembly, refreshed.agentId);
		const parkedRecord = parked(
			await replace(assembly, owned, refreshed, {
				...recordCommon(refreshed),
				revision: refreshed.revision + 1,
				updatedAt: now(),
				phase: "parked",
				operation: null,
				session: refreshed.recovery.session,
				workspace: refreshed.recovery.workspace,
				releasedAt: null,
			}),
		);
		await releaseControllerAuthority(assembly, owned);
		await ownership.close();
		return presentStatus(assembly, parkedRecord, signal);
	} catch (error) {
		if (ownership.isHeld()) await releaseControllerAuthority(assembly, owned).catch(() => undefined);
		throw error;
	}
}

async function discardInterruptedCreation(
	assembly: LifecycleAssembly,
	ownership: PersistentAgentOwnership,
	record: PersistentAgentRecoveryRequiredRecordV1,
	_signal?: AbortSignal,
): Promise<PersistentAgentStatus> {
	if (record.recovery.failedPhase !== "creating") recoveryFailure(record.agentId, "invalid_phase_relationship");
	const operation = record.recovery.operation;
	const plan = operation.plan;
	const owned = await acquireRuntime(assembly, ownership, plan.resources.workspaceId);
	try {
		const canonical = await assembly.canonical.inspectCreate({
			workspaceId: plan.resources.workspaceId,
			createId: plan.resources.workspaceCreateId,
			stageId: plan.resources.workspaceStageId,
		});
		if (canonical.status === "present" || canonical.status === "conflict")
			recoveryFailure(record.agentId, "workspace_identity_mismatch");
		if (canonical.status === "staging") {
			const aborted = await assembly.canonical.abortCreate({
				workspaceId: plan.resources.workspaceId,
				createId: plan.resources.workspaceCreateId,
				stageId: plan.resources.workspaceStageId,
				controllerLease: owned.controllerLease.proof,
			});
			if (aborted.status !== "aborted" && aborted.status !== "already_absent")
				recoveryFailure(record.agentId, "workspace_identity_mismatch");
		}
		const attachment = await assembly.attachments.abortCreate({
			workspaceId: plan.resources.workspaceId,
			createId: plan.resources.runtimeAttachmentCreateId,
			controllerLease: owned.controllerLease.proof,
		});
		if (attachment.status !== "missing") recoveryFailure(record.agentId, "runtime_reconciliation_blocked");
		const file = sessionFile(assembly, record.agentId, plan.resources.session);
		if (assembly.storage.existsSync(file)) {
			const entries = await loadEntriesFromFile(file, assembly.storage);
			if (entries.length === 0) recoveryFailure(record.agentId, "session_invalid");
			requirePlannedSessionHeader(record.agentId, entries, plan.resources.session, plan.startedAt);
			await assembly.storage.deleteSessionWithArtifacts(file);
		}
		if (plan.seed.kind === "copy")
			await assembly.seeds.release({ source: plan.seed.source, reason: "creation_discarded" });
		const creatingRecord = creating(
			await replace(assembly, owned, record, {
				...recordCommon(record),
				revision: record.revision + 1,
				updatedAt: now(),
				phase: "creating",
				operation,
				releasedAt: null,
			}),
		);
		await ownership.deleteCreating(creatingRecord.revision);
		await releaseControllerAuthority(assembly, owned);
		await ownership.close();
		return { kind: "missing", agentId: record.agentId };
	} catch (error) {
		if (ownership.isHeld()) await releaseControllerAuthority(assembly, owned).catch(() => undefined);
		throw error;
	}
}

export async function recoverPersistentAgent(
	agentId: PersistentAgentId,
	options: RecoverPersistentAgentOptions,
): Promise<PersistentAgentStatus> {
	const assembly = await getAssembly();
	abort(options.signal);
	const ownership = await assembly.store.acquire(agentId, "recover", options.signal);
	try {
		const lookup = await ownership.read();
		if (lookup.kind !== "record")
			throw new PersistentAgentError("invalid_transition", agentId, false, "invalid_phase_relationship");
		const record = recoveryRequired(lookup.record);
		if (!persistentAgentRecoveryActionsV1(record).includes(options.action)) {
			throw new PersistentAgentError("invalid_transition", agentId, false, "invalid_phase_relationship");
		}
		if (options.action !== "retry-create" && options.copySourcePath !== undefined) {
			throw new PersistentAgentError("invalid_transition", agentId, false, "invalid_fields");
		}
		switch (options.action) {
			case "retry-create":
				return recoverCreateToParked(assembly, ownership, record, options);
			case "discard-creation":
				return discardInterruptedCreation(assembly, ownership, record, options.signal);
			case "resume":
				return recoverSteadyToParked(assembly, ownership, record, options.signal);
			case "finish-park":
				return recoverParkingToParked(assembly, ownership, record, options.signal);
			case "finish-fork":
				return recoverForkToParked(assembly, ownership, record, options.signal);
			case "finish-release":
				return recoverReleaseToReleased(assembly, ownership, record, options.signal);
			case "discard-runtime-changes":
				return recoverAfterAuthorizedDiscard(assembly, ownership, record, options.signal);
		}
	} catch (error) {
		if (ownership.isHeld()) {
			try {
				const lookup = await ownership.read();
				if (
					lookup.kind === "record" &&
					(await hasDurableRuntimePreservationImpossibility(assembly, lookup.record))
				) {
					const detectedAt = now();
					let next: PersistentAgentRecoveryRequiredRecordV1 | null = null;
					if (lookup.record.phase === "recovery_required") {
						next = {
							...lookup.record,
							revision: lookup.record.revision + 1,
							updatedAt: detectedAt,
							recovery: { ...lookup.record.recovery, code: "runtime_preservation_impossible", detectedAt },
						};
					} else {
						switch (lookup.record.phase) {
							case "creating":
							case "open":
							case "parking":
							case "parked":
							case "reviving":
							case "forking":
							case "releasing":
								next = createPersistentAgentRecoveryRequiredRecordV1(
									lookup.record,
									"runtime_preservation_impossible",
									detectedAt,
								);
								break;
							case "released":
								break;
						}
					}
					if (next) await ownership.replace(lookup.record.revision, next, { isCurrent: () => ownership.isHeld() });
				}
			} catch {}
			await ownership.close();
		}
		throw error;
	}
}
