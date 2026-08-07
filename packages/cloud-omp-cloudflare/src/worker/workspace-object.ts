import { DurableObject } from "cloudflare:workers";
import { type DurableObjectStorageLike, Workspace } from "@cloudflare/computer";
import { CloudflareContainerBackend, withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import type {
	RuntimeReplicaCacheEvictionInspectResult,
	RuntimeReplicaCacheEvictionRequestResult,
	RuntimeReplicaDeleteInspectResult,
	RuntimeReplicaDeleteResult,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import type {
	CloudflareCheckpointFetchResponseV1,
	CloudflareRuntimeEffectResultEnvelopeV1,
	CloudflareRuntimeEffectTransportEnvelopeV1,
	CloudflareRuntimeEffectTransportResultEnvelopeV1,
	CloudflareRuntimeInspectionResultEnvelopeV1,
	CloudflareRuntimeInspectionTransportEnvelopeV1,
	CloudflareRuntimeInspectionTransportResultEnvelopeV1,
	CloudflareRuntimeStatusResponseV1,
	CreateWorkspaceRequest,
	CreateWorkspaceResponse,
	ExecCreateResponse,
	ExecRequest,
	ExecSnapshot,
	FilePayload,
	FileReadRequest,
	ManifestResponse,
	WorkspaceState,
} from "../protocol";
import { SQLiteRetryScheduler, WorkspaceAlarmCoordinator } from "./retry-scheduler";
import { WorkspaceAuditSink } from "./workspace-audit";
import { adaptWorkspaceFilesystem } from "./workspace-files";
import { type ContainerLike, type WorkspaceLike, WorkspaceObjectRuntime } from "./workspace-runtime";
import { type SqlStorageLike, WorkspaceStateStore } from "./workspace-state-store";

export interface CloudOmpWorkerEnv {
	WORKSPACE: DurableObjectNamespace<CloudOmpWorkspace>;
	CF_VERSION_METADATA: WorkerVersionMetadata;
	CLOUD_OMP_WORKSPACE_RETENTION_MS?: number | string;
}
const ContainerDurableObject = withWorkspaceContainer(class extends DurableObject<CloudOmpWorkerEnv> {});

export class CloudOmpWorkspace extends ContainerDurableObject {
	readonly #backend: CloudflareContainerBackend;
	readonly #runtime: WorkspaceObjectRuntime;
	#adaptiveTail: Promise<void> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: CloudOmpWorkerEnv) {
		super(ctx, env);
		const storage = ctx.storage as SqlStorageLike;
		const store = new WorkspaceStateStore(storage);
		const alarms = new WorkspaceAlarmCoordinator(storage, store);
		const retryScheduler = new SQLiteRetryScheduler(store, alarms);
		const audit = new WorkspaceAuditSink({ workerVersionId: env.CF_VERSION_METADATA.id });
		const containerApi = this.getWorkspaceContainer();
		const rawContainer = ctx.container;
		if (!rawContainer) throw new Error("CloudOmpWorkspace requires a container-enabled Durable Object");
		const container = {
			restart: (containerEnv: Record<string, string>) => containerApi.restart(containerEnv),
			status: () => containerApi.status(),
			destroy: () => rawContainer.destroy(),
			get running() {
				return rawContainer.running;
			},
		} satisfies ContainerLike;
		this.#backend = new CloudflareContainerBackend({
			container: () => this,
			workspace: { binding: "WORKSPACE", id: ctx.id.toString() },
			connectTimeoutMs: 60_000,
			heartbeatIntervalMs: 20_000,
			restartAttempts: 1,
		});
		const workspace = new Workspace({
			storage: ctx.storage as unknown as DurableObjectStorageLike,
			backends: [this.#backend],
			retryScheduler,
			retry: { initialDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 5 },
			waitUntil: promise => ctx.waitUntil(promise),
		});
		const runtimeWorkspace = {
			fs: adaptWorkspaceFilesystem(workspace),
			runtime: workspace.runtime,
			retryPendingSync: (backend?: string) => workspace.retryPendingSync(backend),
			ready: (options?: string | { all?: boolean }) => workspace.ready(options),
			close: () => workspace.close(),
		} satisfies WorkspaceLike;
		this.#runtime = new WorkspaceObjectRuntime({
			store,
			workspace: runtimeWorkspace,
			container,
			retryScheduler,
			alarms,
			audit,
			waitUntil: promise => ctx.waitUntil(promise),
			containerRunning: () => rawContainer.running,
			workspaceRetentionMs: parseWorkspaceRetentionMs(env.CLOUD_OMP_WORKSPACE_RETENTION_MS),
		});
		ctx.blockConcurrencyWhile(() => this.#runtime.initialize());
	}

	override fetch(request: Request): Promise<Response> {
		return this.#backend.handleFetch(request);
	}

	alarm(): Promise<void> {
		return this.#serializeAdaptive(() => this.#runtime.alarm());
	}

	createWorkspace(clientWorkspaceId: string, request: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse> {
		return this.#runtime.createWorkspace(clientWorkspaceId, request);
	}

	readFile(request: FileReadRequest): Promise<FilePayload> {
		return this.#runtime.readFile(request);
	}

	writeFile(request: FilePayload): Promise<FilePayload> {
		return this.#runtime.writeFile(request);
	}

	getManifest(): Promise<ManifestResponse> {
		return this.#runtime.getManifest();
	}

	createExec(request: ExecRequest): Promise<ExecCreateResponse> {
		return this.#runtime.createExec(request);
	}

	getExec(execId: string): Promise<ExecSnapshot> {
		return this.#runtime.getExec(execId);
	}

	killExec(execId: string): Promise<ExecSnapshot> {
		return this.#runtime.killExec(execId);
	}

	deleteExec(execId: string): Promise<void> {
		return this.#runtime.deleteExec(execId);
	}

	quiesce(): Promise<WorkspaceState> {
		return this.#runtime.quiesce();
	}

	release(): Promise<void> {
		return this.#runtime.release();
	}

	restartForTest(): Promise<WorkspaceState> {
		return this.#runtime.restartForTest();
	}

	applyRuntimeEffect(input: unknown): Promise<CloudflareRuntimeEffectResultEnvelopeV1> {
		return this.#serializeAdaptive(() => this.#runtime.applyRuntimeEffect(input));
	}

	inspectRuntimeOperation(input: unknown): Promise<CloudflareRuntimeInspectionResultEnvelopeV1> {
		return this.#runtime.inspectRuntimeOperation(input);
	}

	applyRuntimeControlEffect(
		input: CloudflareRuntimeEffectTransportEnvelopeV1,
	): Promise<CloudflareRuntimeEffectTransportResultEnvelopeV1> {
		return this.#serializeAdaptive(() => this.#runtime.applyRuntimeControlEffect(input));
	}

	inspectRuntimeControl(
		input: CloudflareRuntimeInspectionTransportEnvelopeV1,
	): Promise<CloudflareRuntimeInspectionTransportResultEnvelopeV1> {
		return this.#runtime.inspectRuntimeControl(input);
	}

	inspectRuntimeStatus(input: unknown): CloudflareRuntimeStatusResponseV1 {
		return this.#runtime.inspectRuntimeStatus(input);
	}

	fetchRuntimeCheckpoint(input: unknown): CloudflareCheckpointFetchResponseV1 {
		return this.#runtime.fetchRuntimeCheckpoint(input);
	}

	requestReplicaCacheEviction(input: unknown): Promise<RuntimeReplicaCacheEvictionRequestResult> {
		return this.#serializeAdaptive(() => this.#runtime.requestReplicaCacheEviction(input));
	}

	inspectReplicaCacheEviction(input: unknown): Promise<RuntimeReplicaCacheEvictionInspectResult> {
		return this.#runtime.inspectReplicaCacheEviction(input);
	}

	deleteRuntimeReplica(input: unknown): Promise<RuntimeReplicaDeleteResult> {
		return this.#serializeAdaptive(() => this.#runtime.deleteRuntimeReplica(input));
	}

	inspectRuntimeReplicaDeletion(input: unknown): Promise<RuntimeReplicaDeleteInspectResult> {
		return this.#runtime.inspectRuntimeReplicaDeletion(input);
	}

	applyRuntimeBridgeOperation(
		input: CloudflareRuntimeEffectTransportEnvelopeV1 | CloudflareRuntimeInspectionTransportEnvelopeV1,
	): Promise<CloudflareRuntimeEffectTransportResultEnvelopeV1 | CloudflareRuntimeInspectionTransportResultEnvelopeV1> {
		return this.#serializeAdaptive(() => this.#runtime.applyRuntimeBridgeOperation(input));
	}
	#serializeAdaptive<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.#adaptiveTail.then(operation, operation);
		this.#adaptiveTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

function parseWorkspaceRetentionMs(value: number | string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new TypeError("Cloud OMP workspace retention must be a positive safe integer");
	return parsed;
}
