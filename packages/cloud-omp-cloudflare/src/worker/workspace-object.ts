import { DurableObject } from "cloudflare:workers";
import { type DurableObjectStorageLike, Workspace } from "@cloudflare/computer";
import { CloudflareContainerBackend, withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import type {
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
import { type ContainerLike, WorkspaceObjectRuntime } from "./workspace-runtime";
import { type SqlStorageLike, WorkspaceStateStore } from "./workspace-state-store";

export interface CloudOmpWorkerEnv {
	WORKSPACE: DurableObjectNamespace<CloudOmpWorkspace>;
	CF_VERSION_METADATA: WorkerVersionMetadata;
}

const ContainerDurableObject = withWorkspaceContainer(class extends DurableObject<CloudOmpWorkerEnv> {});

export class CloudOmpWorkspace extends ContainerDurableObject {
	readonly #backend: CloudflareContainerBackend;
	readonly #workspace: Workspace;
	readonly #runtime: WorkspaceObjectRuntime;

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
		} satisfies ContainerLike;
		this.#backend = new CloudflareContainerBackend({
			container: () => this,
			workspace: { binding: "WORKSPACE", id: ctx.id.toString() },
			connectTimeoutMs: 60_000,
			heartbeatIntervalMs: 20_000,
			restartAttempts: 1,
		});
		this.#workspace = new Workspace({
			storage: ctx.storage as unknown as DurableObjectStorageLike,
			backends: [this.#backend],
			retryScheduler,
			retry: { initialDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 5 },
			waitUntil: promise => ctx.waitUntil(promise),
		});
		this.#runtime = new WorkspaceObjectRuntime({
			store,
			workspace: this.#workspace,
			container,
			retryScheduler,
			alarms,
			audit,
			waitUntil: promise => ctx.waitUntil(promise),
		});
		ctx.blockConcurrencyWhile(() => this.#runtime.initialize());
	}

	override fetch(request: Request): Promise<Response> {
		return this.#backend.handleFetch(request);
	}

	alarm(): Promise<void> {
		return this.#runtime.alarm();
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
}
