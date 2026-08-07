import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { RuntimeSearchRequest, RuntimeSearchResult } from "@oh-my-pi/pi-coding-agent";
import {
	CLOUD_OMP_REMOTE_ROOT,
	CLOUDFLARE_RUNTIME_SEARCH_BYTE_BUDGET_V1,
	CLOUDFLARE_RUNTIME_SEARCH_FILE_BUDGET_V1,
	CLOUDFLARE_RUNTIME_SEARCH_RESULT_BYTE_BUDGET_V1,
	CLOUDFLARE_RUNTIME_SEARCH_TRAVERSAL_BUDGET_V1,
	type CloudflareRuntimeEffectTransportEnvelopeV1,
	type CloudflareRuntimeInspectionTransportEnvelopeV1,
	type CreateWorkspaceRequest,
	canonicalRuntimeSha256V1,
	type ExecRequest,
	encodeCloudflareRuntimeSearchCursorV1,
	MAX_SYNC_FILE_BYTES,
} from "../src/protocol";
import { SQLiteRetryScheduler, WorkspaceAlarmCoordinator } from "../src/worker/retry-scheduler";
import {
	hashWorkspaceId,
	validateWorkspaceAuditRecord,
	type WorkspaceAuditRecord,
	WorkspaceAuditSink,
} from "../src/worker/workspace-audit";
import {
	adaptWorkspaceFilesystem,
	manifestRootSha256,
	readAll,
	sha256Hex,
	type WorkspaceDirentLike,
	type WorkspaceFilesystemLike,
	type WorkspaceStatLike,
} from "../src/worker/workspace-files";
import {
	type ContainerLike,
	type RuntimeHandle,
	type RuntimeLike,
	type RuntimeResult,
	type WorkspaceLike,
	WorkspaceObjectRuntime,
} from "../src/worker/workspace-runtime";
import {
	EXECUTIONS_TABLE,
	RETRY_INTENTS_TABLE,
	type SqlCursorLike,
	type SqlStorageLike,
	WorkspaceStateStore,
} from "../src/worker/workspace-state-store";

const WORKSPACE_ID = "a".repeat(32);
const EXEC_ID = "b".repeat(32);
const AUDIT_ID = "c".repeat(32);
const EXEC_REQUEST: ExecRequest = {
	source: "printf test",
	cwd: CLOUD_OMP_REMOTE_ROOT,
	timeoutMs: 1_000,
	outputByteLimit: 4_096,
};
const RUNTIME_REPLICA = {
	providerId: "cloudflare",
	profileId: "standard-2",
	replicaId: "replica-filesystem-1",
	workspaceId: "workspace-filesystem-1",
} as const;
const RUNTIME_FENCE = { fenceId: "fence-filesystem-1", token: "token-filesystem-1" } as const;
const RUNTIME_LEASE = {
	leaseId: "lease-filesystem-1",
	replica: RUNTIME_REPLICA,
	fenceId: RUNTIME_FENCE.fenceId,
	baseGeneration: 3,
	renewalSequence: 0,
	acquiredAt: "2030-01-01T00:00:00.000Z",
	renewBy: "2030-01-01T00:05:00.000Z",
	expiresAt: "2030-01-01T00:10:00.000Z",
} as const;
const RUNTIME_ACCESS = {
	operationLeaseId: "operation-filesystem-1",
	workspaceId: RUNTIME_REPLICA.workspaceId,
	expectedGeneration: RUNTIME_LEASE.baseGeneration,
	replicaId: RUNTIME_REPLICA.replicaId,
	leaseId: RUNTIME_LEASE.leaseId,
	fence: RUNTIME_FENCE,
} as const;
const RUNTIME_ACCESS_TUPLE = [
	RUNTIME_ACCESS.operationLeaseId,
	RUNTIME_ACCESS.workspaceId,
	RUNTIME_ACCESS.expectedGeneration,
	RUNTIME_ACCESS.replicaId,
	RUNTIME_ACCESS.leaseId,
	RUNTIME_FENCE.fenceId,
] as const;

function isBinding(value: unknown): value is SQLQueryBindings {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		value instanceof Uint8Array
	);
}

class FakeStorage implements SqlStorageLike {
	readonly database = new Database(":memory:");
	alarm: number | null = null;
	readonly alarmWrites: Array<number | null> = [];
	readonly sql = {
		exec: <Row extends object = Record<string, unknown>>(
			query: string,
			...bindings: unknown[]
		): SqlCursorLike<Row> => {
			if (!bindings.every(isBinding)) throw new Error("Unsupported fake SQL binding");
			const statement = this.database.prepare<Row, SQLQueryBindings[]>(query);
			let rows: Row[] = [];
			if (/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(query)) rows = statement.all(...bindings);
			else statement.run(...bindings);
			return { toArray: () => rows };
		},
	};

	transactionSync<T>(callback: () => T): T {
		return this.database.transaction(callback)();
	}

	async getAlarm(): Promise<number | null> {
		return this.alarm;
	}

	async setAlarm(scheduledTime: number | Date): Promise<void> {
		this.alarm = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
		this.alarmWrites.push(this.alarm);
	}

	async deleteAlarm(): Promise<void> {
		this.alarm = null;
		this.alarmWrites.push(null);
	}

	close(): void {
		this.database.close();
	}
}

function missing(path: string): Error & { code: string } {
	return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

class FakeFilesystem implements WorkspaceFilesystemLike {
	readonly files = new Map<string, Uint8Array>();
	readonly directories = new Set<string>();
	readonly symlinks = new Map<string, string>();
	readonly renameCalls: Array<{ oldPath: string; newPath: string }> = [];
	readonly rmCalls: string[] = [];
	readonly readdirCalls: string[] = [];
	readonly lstatCalls: string[] = [];
	readonly readCalls: string[] = [];
	readByteCount = 0;
	readonly writeStarted = Promise.withResolvers<void>();
	readonly #inodes = new Map<string, number>();
	#nextInode = 1;
	nextWriteGate: Promise<void> | undefined;
	renameErrorAfterMutation: unknown;
	lstatError: unknown;

	#inode(path: string): number {
		const existing = this.#inodes.get(path);
		if (existing !== undefined) return existing;
		const inode = this.#nextInode++;
		this.#inodes.set(path, inode);
		return inode;
	}

	async readFile(path: string): Promise<ReadableStream<Uint8Array>> {
		this.readCalls.push(path);
		const bytes = this.files.get(path);
		if (bytes === undefined) throw missing(path);
		this.readByteCount += bytes.byteLength;
		return new ReadableStream({
			start(controller) {
				controller.enqueue(bytes.slice());
				controller.close();
			},
		});
	}

	async lstat(path: string): Promise<WorkspaceStatLike> {
		this.lstatCalls.push(path);
		if (this.lstatError !== undefined) throw this.lstatError;
		const bytes = this.files.get(path);
		if (bytes !== undefined) {
			return {
				inode: this.#inode(path),
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
				size: bytes.byteLength,
			};
		}
		if (this.directories.has(path)) {
			return { inode: this.#inode(path), isFile: false, isDirectory: true, isSymbolicLink: false, size: 0 };
		}
		if (this.symlinks.has(path)) {
			return { inode: this.#inode(path), isFile: false, isDirectory: false, isSymbolicLink: true, size: 0 };
		}
		throw missing(path);
	}

	async readdir(path: string): Promise<WorkspaceDirentLike[]> {
		this.readdirCalls.push(path);
		if (!this.directories.has(path)) throw missing(path);
		const prefix = `${path}/`;
		const names = new Map<string, WorkspaceDirentLike>();
		for (const directory of this.directories) {
			if (!directory.startsWith(prefix)) continue;
			const tail = directory.slice(prefix.length);
			if (!tail || tail.includes("/")) continue;
			names.set(tail, { name: tail, isFile: false, isDirectory: true, isSymbolicLink: false });
		}
		for (const file of this.files.keys()) {
			if (!file.startsWith(prefix)) continue;
			const tail = file.slice(prefix.length);
			if (!tail || tail.includes("/")) continue;
			names.set(tail, { name: tail, isFile: true, isDirectory: false, isSymbolicLink: false });
		}
		for (const symlink of this.symlinks.keys()) {
			if (!symlink.startsWith(prefix)) continue;
			const tail = symlink.slice(prefix.length);
			if (!tail || tail.includes("/")) continue;
			names.set(tail, { name: tail, isFile: false, isDirectory: false, isSymbolicLink: true });
		}
		return [...names.values()];
	}

	async writeFile(path: string, content: Uint8Array): Promise<void> {
		this.writeStarted.resolve();
		await this.nextWriteGate;
		this.files.set(path, content.slice());
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		if (!options?.recursive) {
			this.directories.add(path);
			return;
		}
		let current = "";
		for (const segment of path.split("/").filter(Boolean)) {
			current += `/${segment}`;
			this.directories.add(current);
		}
	}

	async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
		this.rmCalls.push(path);
		if (!this.files.has(path) && !this.directories.has(path) && !this.symlinks.has(path) && !options?.force) {
			throw missing(path);
		}
		for (const file of [...this.files.keys()]) {
			if (file === path || (options?.recursive && file.startsWith(`${path}/`))) this.files.delete(file);
		}
		for (const directory of [...this.directories]) {
			if (directory === path || (options?.recursive && directory.startsWith(`${path}/`))) {
				this.directories.delete(directory);
			}
		}
		for (const symlink of [...this.symlinks.keys()]) {
			if (symlink === path || (options?.recursive && symlink.startsWith(`${path}/`))) this.symlinks.delete(symlink);
		}
		for (const inodePath of [...this.#inodes.keys()]) {
			if (inodePath === path || (options?.recursive && inodePath.startsWith(`${path}/`)))
				this.#inodes.delete(inodePath);
		}
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		this.renameCalls.push({ oldPath, newPath });
		await this.lstat(oldPath);
		if (oldPath !== newPath) {
			await this.rm(newPath, { recursive: true, force: true });
			for (const [path, value] of [...this.files.entries()]) {
				if (path !== oldPath && !path.startsWith(`${oldPath}/`)) continue;
				this.files.delete(path);
				this.files.set(`${newPath}${path.slice(oldPath.length)}`, value);
			}
			for (const [path, value] of [...this.symlinks.entries()]) {
				if (path !== oldPath && !path.startsWith(`${oldPath}/`)) continue;
				this.symlinks.delete(path);
				this.symlinks.set(`${newPath}${path.slice(oldPath.length)}`, value);
			}
			for (const path of [...this.directories]) {
				if (path !== oldPath && !path.startsWith(`${oldPath}/`)) continue;
				this.directories.delete(path);
				this.directories.add(`${newPath}${path.slice(oldPath.length)}`);
			}
			for (const [path, inode] of [...this.#inodes.entries()]) {
				if (path !== oldPath && !path.startsWith(`${oldPath}/`)) continue;
				this.#inodes.delete(path);
				this.#inodes.set(`${newPath}${path.slice(oldPath.length)}`, inode);
			}
		}
		const error = this.renameErrorAfterMutation;
		this.renameErrorAfterMutation = undefined;
		if (error !== undefined) throw error;
	}
}

class FakeHandle
	extends ReadableStream<{
		id: string;
		seq: number;
		name: "stdout" | "stderr" | "result" | "exit";
		value: unknown;
	}>
	implements RuntimeHandle
{
	readonly backend = "container-shell";
	readonly #controller: ReadableStreamDefaultController<{
		id: string;
		seq: number;
		name: "stdout" | "stderr" | "result" | "exit";
		value: unknown;
	}>;
	readonly #resultGate = Promise.withResolvers<RuntimeResult>();
	readonly #immediateResult?: RuntimeResult;
	readonly #beforeResult?: () => Promise<void>;
	readonly #events: Array<{ seq: number; name: "stdout" | "stderr" | "result" | "exit"; value: unknown }>;
	readonly #configuredResult: RuntimeResult;
	readonly #hanging: boolean;
	#resultStarted = false;
	#closed = false;
	#terminalResult: RuntimeResult | undefined;
	killCount = 0;
	disposeCount = 0;

	constructor(
		readonly id: string,
		events: Array<{ seq: number; name: "stdout" | "stderr" | "result" | "exit"; value: unknown }>,
		options: { result: RuntimeResult; hanging?: boolean; beforeResult?: () => Promise<void> },
	) {
		let controller!: ReadableStreamDefaultController<{
			id: string;
			seq: number;
			name: "stdout" | "stderr" | "result" | "exit";
			value: unknown;
		}>;
		super({
			start(value) {
				controller = value;
			},
		});
		this.#controller = controller;
		this.#beforeResult = options.beforeResult;
		this.#events = events.map(event => ({ ...event }));
		this.#configuredResult = options.result;
		this.#hanging = Boolean(options.hanging);
		for (const event of events) controller.enqueue({ id, ...event });
		if (options.hanging) this.#immediateResult = undefined;
		else {
			this.#immediateResult = options.result;
			controller.close();
			this.#closed = true;
		}
		if (options.hanging) this.#resultGate.promise.catch(() => undefined);
	}

	async result(): Promise<RuntimeResult> {
		if (!this.#resultStarted) {
			this.#resultStarted = true;
			await this.#beforeResult?.();
		}
		return this.#immediateResult ?? this.#terminalResult ?? this.#resultGate.promise;
	}
	replay(): FakeHandle {
		return new FakeHandle(this.id, this.#events, {
			result: this.#immediateResult ?? this.#terminalResult ?? this.#configuredResult,
			hanging: this.#hanging && !this.#closed,
			beforeResult: this.#beforeResult,
		});
	}

	async kill(): Promise<void> {
		this.killCount++;
		if (!this.#closed) {
			this.#closed = true;
			this.#controller.close();
			this.#terminalResult = {
				status: "cancelled",
				exitCode: 137,
				skipped: [],
				sync: { status: "complete", skipped: [] },
			};
			this.#resultGate.resolve(this.#terminalResult);
		}
	}

	[Symbol.dispose](): void {
		this.disposeCount++;
	}
}

class FakeRuntime implements RuntimeLike {
	readonly execCalls: Array<{ source: string; id: string }> = [];
	readonly getCalls: Array<{ id: string; resume: number | "full" }> = [];
	readonly killCalls: string[] = [];
	readonly disposeCalls: string[] = [];
	readonly execStarted = Promise.withResolvers<void>();
	readonly handles = new Map<string, FakeHandle>();
	nextExec: FakeHandle | Error | Promise<FakeHandle> | undefined;
	recoveryHandle: FakeHandle | undefined;
	killError: unknown;
	disposeError: unknown;

	async exec(
		source: string,
		options: { id: string; cwd: string; timeoutMs: number; encoding: "utf8" },
	): Promise<RuntimeHandle> {
		this.execCalls.push({ source, id: options.id });
		this.execStarted.resolve();
		const next = await this.nextExec;
		if (!next) throw new Error("No fake exec configured");
		if (next instanceof Error) throw next;
		this.handles.set(options.id, next);
		return next;
	}

	async getExec(id: string, options: { resume: number | "full"; encoding: "utf8" }): Promise<RuntimeHandle> {
		this.getCalls.push({ id, resume: options.resume });
		const handle = this.recoveryHandle ?? this.handles.get(id);
		if (!handle) throw missing(`exec:${id}`);
		return options.resume === "full" ? handle.replay() : handle;
	}

	async killExec(id: string): Promise<void> {
		this.killCalls.push(id);
		if (this.killError !== undefined) throw this.killError;
		const handle = this.handles.get(id) ?? this.recoveryHandle;
		if (!handle) throw missing(`exec:${id}`);
		await handle.kill();
	}

	async disposeExec(id: string): Promise<void> {
		this.disposeCalls.push(id);
		if (this.disposeError !== undefined) throw this.disposeError;
		this.handles.delete(id);
	}
}

class FakeWorkspace implements WorkspaceLike {
	readonly retryCalls: string[] = [];
	readonly retryResults: Array<
		| { status: "idle"; backend: string }
		| { status: "complete"; backend: string; applied: number; skipped: unknown[] }
		| { status: "pending"; backend: string; attempt: number; notBefore: number; error: string }
		| { status: "exhausted"; backend: string; attempt: number; error: string }
	> = [];
	closeCount = 0;

	constructor(
		readonly fs: FakeFilesystem,
		readonly runtime: FakeRuntime,
	) {}

	async retryPendingSync(backend = "container-shell") {
		this.retryCalls.push(backend);
		const result = this.retryResults.shift();
		if (!result) throw new Error("No fake retry result configured");
		return result;
	}
	async ready(): Promise<void> {}

	async close(): Promise<void> {
		this.closeCount++;
	}
}

class FakeContainer implements ContainerLike {
	restartCount = 0;
	destroyCount = 0;
	running = true;
	readonly ephemeralFiles = new Set<string>();

	async restart(env: Record<string, string>): Promise<void> {
		expect(env).toEqual({ PORT: "8080", MOUNT_POINT: CLOUD_OMP_REMOTE_ROOT });
		this.restartCount++;
		this.ephemeralFiles.clear();
	}

	async destroy(): Promise<void> {
		this.destroyCount++;
		this.running = false;
		this.ephemeralFiles.clear();
	}

	async status(): Promise<{ running: boolean; exit: null }> {
		return { running: this.running, exit: null };
	}
}

interface Harness {
	storage: FakeStorage;
	store: WorkspaceStateStore;
	alarms: WorkspaceAlarmCoordinator;
	retryScheduler: SQLiteRetryScheduler;
	filesystem: FakeFilesystem;
	runtime: FakeRuntime;
	workspace: FakeWorkspace;
	container: FakeContainer;
	core: WorkspaceObjectRuntime;
	pending: Promise<unknown>[];
	auditRecords: WorkspaceAuditRecord[];
	now: { value: number };
}

async function createHarness(
	existing?: Pick<Harness, "storage" | "filesystem" | "runtime" | "workspace" | "container" | "now">,
	options: { cleanupTimeoutMs?: number } = {},
): Promise<Harness> {
	const storage = existing?.storage ?? new FakeStorage();
	const store = new WorkspaceStateStore(storage);
	const filesystem = existing?.filesystem ?? new FakeFilesystem();
	const runtime = existing?.runtime ?? new FakeRuntime();
	const workspace = existing?.workspace ?? new FakeWorkspace(filesystem, runtime);
	const container = existing?.container ?? new FakeContainer();
	const now = existing?.now ?? { value: 1_000 };
	const alarms = new WorkspaceAlarmCoordinator(storage, store);
	const retryScheduler = new SQLiteRetryScheduler(store, alarms);
	const pending: Promise<unknown>[] = [];
	const auditRecords: WorkspaceAuditRecord[] = [];
	const audit = new WorkspaceAuditSink({
		workerVersionId: "worker-version-test",
		now: () => new Date(now.value),
		emit: record => auditRecords.push(record),
	});
	const core = new WorkspaceObjectRuntime({
		store,
		workspace,
		container,
		retryScheduler,
		alarms,
		audit,
		now: () => now.value,
		randomId: () => EXEC_ID,
		waitUntil: promise => pending.push(promise),
		sleep: async () => undefined,
		...(options.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: options.cleanupTimeoutMs }),
	});
	await core.initialize();
	return {
		storage,
		store,
		alarms,
		retryScheduler,
		filesystem,
		runtime,
		workspace,
		container,
		core,
		pending,
		auditRecords,
		now,
	};
}

async function drain(harness: Harness): Promise<void> {
	for (;;) {
		const batch = harness.pending.splice(0);
		if (batch.length === 0) return;
		await Promise.all(batch);
	}
}

async function createEmptyWorkspace(harness: Harness): Promise<CreateWorkspaceRequest> {
	const request: CreateWorkspaceRequest = {
		auditCorrelationId: AUDIT_ID,
		seedRootSha256: await manifestRootSha256([]),
		files: [],
	};
	await harness.core.createWorkspace(WORKSPACE_ID, request);
	return request;
}

async function enableRuntimeBridge(harness: Harness): Promise<void> {
	harness.store.saveRuntimeReplica({
		replica: RUNTIME_REPLICA,
		lease: RUNTIME_LEASE,
		fenceVerifierSha256: await canonicalRuntimeSha256V1([
			"omp-cloudflare-fence-verifier-v1",
			RUNTIME_FENCE.fenceId,
			RUNTIME_FENCE.token,
		]),
		deletionAuthorityDomain: "persistent",
		providerPhase: "ready",
		replicaImage: null,
		admissionClosed: false,
		tombstone: null,
		updatedAtEpochMs: harness.now.value,
	});
}

function bridgeInspection(
	operation: "exists" | "stat" | "list_files" | "search_text",
	request: Record<string, unknown>,
): CloudflareRuntimeInspectionTransportEnvelopeV1 {
	return {
		schemaVersion: 1,
		family: "bridge",
		operation,
		replica: RUNTIME_REPLICA,
		request: { ...RUNTIME_ACCESS, ...request },
	} as unknown as CloudflareRuntimeInspectionTransportEnvelopeV1;
}

function bridgeEffect(
	operation: "remove" | "rename",
	request: Record<string, unknown>,
): CloudflareRuntimeEffectTransportEnvelopeV1 {
	return {
		schemaVersion: 1,
		family: "bridge",
		operation,
		replica: RUNTIME_REPLICA,
		request: { ...RUNTIME_ACCESS, ...request },
	} as unknown as CloudflareRuntimeEffectTransportEnvelopeV1;
}

async function renameEffect(
	from: string,
	to: string,
	requestId: string,
): Promise<CloudflareRuntimeEffectTransportEnvelopeV1> {
	return bridgeEffect("rename", {
		requestId,
		requestSha256: await canonicalRuntimeSha256V1([
			"omp-runtime-request-v1",
			"rename",
			...RUNTIME_ACCESS_TUPLE,
			from,
			to,
		]),
		from,
		to,
	});
}

async function removeEffect(path: string, requestId: string): Promise<CloudflareRuntimeEffectTransportEnvelopeV1> {
	return bridgeEffect("remove", {
		requestId,
		requestSha256: await canonicalRuntimeSha256V1([
			"omp-runtime-request-v1",
			"remove",
			...RUNTIME_ACCESS_TUPLE,
			path,
			true,
		]),
		path,
		recursive: true,
	});
}

function completeResult(status: RuntimeResult["status"] = "completed"): RuntimeResult {
	return { status, exitCode: status === "completed" ? 0 : 1, skipped: [], sync: { status: "complete", skipped: [] } };
}

describe("CloudOmpWorkspace durable state machine", () => {
	it("seeds and enumerates a non-empty workspace without sparse manifest entries", async () => {
		const harness = await createHarness();
		try {
			const bytes = new TextEncoder().encode("seeded\n");
			const file = {
				path: "seed.txt",
				sha256: await sha256Hex(bytes),
				byteLength: bytes.byteLength,
				contentBase64: btoa("seeded\n"),
			};
			const seedRootSha256 = await manifestRootSha256([file]);
			await expect(
				harness.core.createWorkspace(WORKSPACE_ID, {
					auditCorrelationId: AUDIT_ID,
					seedRootSha256,
					files: [file],
				}),
			).resolves.toMatchObject({ workspaceId: WORKSPACE_ID, remoteRoot: CLOUD_OMP_REMOTE_ROOT });
			await expect(harness.core.getManifest()).resolves.toEqual({
				phase: "active",
				rootSha256: seedRootSha256,
				files: [{ path: file.path, sha256: file.sha256, byteLength: file.byteLength }],
			});
		} finally {
			harness.storage.close();
		}
	});

	it("atomically reserves starting, preserves fractional sequence values, and rejects a racing exec", async () => {
		const harness = await createHarness();
		try {
			await createEmptyWorkspace(harness);
			const gate = Promise.withResolvers<FakeHandle>();
			harness.runtime.nextExec = gate.promise;
			const first = harness.core.createExec(EXEC_REQUEST);
			await harness.runtime.execStarted.promise;
			await expect(harness.core.createExec(EXEC_REQUEST)).rejects.toMatchObject({
				status: 409,
				code: "execution_active",
			});
			gate.resolve(
				new FakeHandle(
					EXEC_ID,
					[
						{ seq: 1.5, name: "stdout", value: "a" },
						{ seq: 1.5, name: "stdout", value: "duplicate" },
						{ seq: 2.25, name: "stderr", value: "b" },
					],
					{ result: completeResult() },
				),
			);
			await first;
			await drain(harness);
			expect(await harness.core.getExec(EXEC_ID)).toEqual({
				execId: EXEC_ID,
				status: "completed",
				output: "ab",
				truncated: false,
				sync: "complete",
				exitCode: 0,
			});
			const persisted = harness.storage.database
				.prepare<{ lastSeq: number }, []>(`SELECT lastSeq FROM ${EXECUTIONS_TABLE} WHERE id = '${EXEC_ID}'`)
				.get();
			expect(persisted?.lastSeq).toBe(2.25);
			const schema = harness.storage.database
				.prepare<{ name: string; type: string }, []>(`PRAGMA table_info(${EXECUTIONS_TABLE})`)
				.all();
			expect(schema.find(column => column.name === "lastSeq")?.type).toBe("REAL");
			expect(schema.some(column => column.name === "source")).toBe(false);
			await harness.core.deleteExec(EXEC_ID);
			await harness.core.deleteExec(EXEC_ID);
			expect(harness.runtime.disposeCalls).toEqual([EXEC_ID]);
		} finally {
			harness.storage.close();
		}
	});

	it("recovers a starting reservation by ID without replaying source", async () => {
		const harness = await createHarness();
		try {
			await createEmptyWorkspace(harness);
			harness.runtime.nextExec = new Error("transport lost after start");
			await expect(harness.core.createExec(EXEC_REQUEST)).rejects.toMatchObject({ code: "execution_start_failed" });
			harness.runtime.recoveryHandle = new FakeHandle(
				EXEC_ID,
				[
					{ seq: 0.5, name: "stdout", value: "recovered" },
					{ seq: 0.5, name: "stdout", value: "duplicate" },
				],
				{ result: completeResult() },
			);
			await harness.core.getExec(EXEC_ID);
			await drain(harness);
			const snapshot = await harness.core.getExec(EXEC_ID);
			expect(snapshot.output).toBe("recovered");
			expect(snapshot.status).toBe("completed");
			expect(harness.runtime.execCalls).toEqual([{ source: EXEC_REQUEST.source, id: EXEC_ID }]);
			expect(harness.runtime.getCalls).toEqual([
				{ id: EXEC_ID, resume: -1 },
				{ id: EXEC_ID, resume: "full" },
			]);
		} finally {
			harness.storage.close();
		}
	});

	it("persists pending sync across client death and retries only at notBefore", async () => {
		const harness = await createHarness();
		try {
			await createEmptyWorkspace(harness);
			const pendingResult: RuntimeResult = {
				status: "completed",
				exitCode: 0,
				skipped: [],
				sync: { status: "pending", skipped: [], error: "pull unavailable" },
			};
			harness.runtime.nextExec = new FakeHandle(EXEC_ID, [], {
				result: pendingResult,
				beforeResult: () =>
					harness.retryScheduler.schedule({ backend: "container-shell", attempt: 1, notBefore: 2_000 }),
			});
			await harness.core.createExec(EXEC_REQUEST);
			await drain(harness);
			const pendingSnapshot = await harness.core.getExec(EXEC_ID);
			await drain(harness);
			expect(pendingSnapshot.sync).toBe("pending");
			expect(harness.storage.alarm).toBe(2_000);
			const retrySchema = harness.storage.database
				.prepare<{ name: string; type: string }, []>(`PRAGMA table_info(${RETRY_INTENTS_TABLE})`)
				.all();
			expect(retrySchema.find(column => column.name === "notBefore")?.type).toBe("REAL");

			harness.runtime.recoveryHandle = new FakeHandle(EXEC_ID, [], { result: pendingResult });
			const recovered = await createHarness(harness);
			harness.now.value = 1_999;
			await recovered.core.alarm();
			await drain(recovered);
			expect(harness.workspace.retryCalls).toHaveLength(0);
			expect(harness.storage.alarm).toBe(2_000);

			harness.workspace.retryResults.push({
				status: "complete",
				backend: "container-shell",
				applied: 1,
				skipped: [],
			});
			harness.now.value = 2_000;
			await recovered.core.alarm();
			await drain(recovered);
			expect(harness.workspace.retryCalls).toEqual(["container-shell"]);
			expect(await recovered.retryScheduler.get("container-shell")).toBeUndefined();
			expect((await recovered.core.getExec(EXEC_ID)).status).toBe("completed");
		} finally {
			harness.storage.close();
		}
	});

	it("marks exhausted and skipped synchronization terminally failed", async () => {
		for (const result of [
			{ status: "exhausted" as const, backend: "container-shell", attempt: 5, error: "failed" },
			{ status: "complete" as const, backend: "container-shell", applied: 0, skipped: [{}] },
			{ status: "idle" as const, backend: "container-shell" },
		]) {
			const harness = await createHarness();
			try {
				await createEmptyWorkspace(harness);
				const pendingResult: RuntimeResult = {
					status: "completed",
					exitCode: 0,
					skipped: [],
					sync: { status: "pending", skipped: [], error: "pull unavailable" },
				};
				harness.runtime.nextExec = new FakeHandle(EXEC_ID, [], {
					result: pendingResult,
					beforeResult: () =>
						harness.retryScheduler.schedule({
							backend: "container-shell",
							attempt: 5,
							notBefore: harness.now.value,
						}),
				});
				await harness.core.createExec(EXEC_REQUEST);
				await drain(harness);
				harness.workspace.retryResults.push(result);
				await harness.core.alarm();
				await drain(harness);
				expect(await harness.core.getExec(EXEC_ID)).toMatchObject({ status: "failed", sync: "exhausted" });
			} finally {
				harness.storage.close();
			}
		}
	});

	it("uses one expiry alarm and gives expiry cleanup precedence", async () => {
		const harness = await createHarness();
		try {
			await createEmptyWorkspace(harness);
			const hanging = new FakeHandle(EXEC_ID, [{ seq: 0.25, name: "stdout", value: "live" }], {
				result: completeResult(),
				hanging: true,
			});
			harness.runtime.nextExec = hanging;
			await harness.core.createExec(EXEC_REQUEST);
			const expiresAt = 1_000 + 30 * 60 * 1_000;
			expect(harness.storage.alarm).toBe(expiresAt);
			harness.filesystem.files.set(`${CLOUD_OMP_REMOTE_ROOT}/late.txt`, new TextEncoder().encode("late"));
			harness.now.value = expiresAt;
			await harness.core.alarm();
			expect(harness.container.restartCount).toBe(1);
			expect(harness.workspace.closeCount).toBe(2);
			expect(harness.container.destroyCount).toBe(1);
			expect(harness.filesystem.files.size).toBe(0);
			expect(harness.storage.alarm).toBeNull();
			expect(hanging.killCount).toBe(1);
			expect(harness.runtime.disposeCalls).toEqual([EXEC_ID]);
			await harness.core.release();
			expect(harness.workspace.closeCount).toBe(2);
			expect(harness.container.destroyCount).toBe(1);
			await expect(harness.core.getManifest()).rejects.toMatchObject({ status: 410, code: "workspace_gone" });
			const state = harness.storage.database
				.prepare<{ phase: string; cleanupReason: string }, []>(
					"SELECT phase, cleanupReason FROM cloud_omp_workspace_state WHERE singleton = 1",
				)
				.get();
			expect(state).toEqual({ phase: "released", cleanupReason: "expiry" });
		} finally {
			harness.storage.close();
		}
	});

	it("quiesce invalidates the stale backend and release does not clean the fenced execution remotely", async () => {
		const harness = await createHarness();
		try {
			await createEmptyWorkspace(harness);
			harness.runtime.nextExec = new FakeHandle(EXEC_ID, [], { result: completeResult() });
			await harness.core.createExec(EXEC_REQUEST);
			await drain(harness);
			expect(await harness.core.getExec(EXEC_ID)).toMatchObject({ status: "completed", sync: "complete" });
			harness.container.ephemeralFiles.add("late-container-only.txt");
			const state = await harness.core.quiesce();
			expect(state).toEqual({ phase: "quiesced", activeExecutions: 0, pendingSyncs: 0, exhaustedSyncs: 0 });
			expect(harness.container.restartCount).toBe(1);
			expect(harness.workspace.closeCount).toBe(1);
			expect(harness.container.ephemeralFiles.size).toBe(0);
			await expect(
				harness.core.writeFile({ path: "late.txt", byteLength: 0, sha256: "0".repeat(64), contentBase64: "" }),
			).rejects.toMatchObject({ status: 409 });
			await Promise.all([harness.core.release(), harness.core.release()]);
			expect(harness.workspace.closeCount).toBe(2);
			expect(harness.container.destroyCount).toBe(1);
			expect(harness.runtime.killCalls).toHaveLength(0);
			expect(harness.runtime.disposeCalls).toHaveLength(0);
		} finally {
			harness.storage.close();
		}
	});

	it("persists the workspace hash and audit correlation and requires both for idempotent create", async () => {
		const harness = await createHarness();
		try {
			const request = await createEmptyWorkspace(harness);
			await expect(harness.core.createWorkspace(WORKSPACE_ID, request)).resolves.toMatchObject({
				workspaceId: WORKSPACE_ID,
			});
			await expect(
				harness.core.createWorkspace(WORKSPACE_ID, { ...request, auditCorrelationId: "d".repeat(32) }),
			).rejects.toMatchObject({ status: 409, code: "workspace_seed_conflict" });
			const row = harness.storage.database
				.prepare<{ workspaceIdSha256: string; auditCorrelationId: string }, []>(
					"SELECT workspaceIdSha256, auditCorrelationId FROM cloud_omp_workspace_state WHERE singleton = 1",
				)
				.get();
			expect(row).toEqual({ workspaceIdSha256: await hashWorkspaceId(WORKSPACE_ID), auditCorrelationId: AUDIT_ID });
			const schema = harness.storage.database
				.prepare<{ name: string }, []>("PRAGMA table_info(cloud_omp_workspace_state)")
				.all();
			expect(schema.some(column => column.name === "workspaceId")).toBe(false);
		} finally {
			harness.storage.close();
		}
	});

	it("emits schema-valid Worker audit records without prohibited content", async () => {
		const harness = await createHarness();
		try {
			await createEmptyWorkspace(harness);
			const content = "sensitive file content";
			const bytes = new TextEncoder().encode(content);
			await harness.core.writeFile({
				path: "audit.txt",
				sha256: await sha256Hex(bytes),
				byteLength: bytes.byteLength,
				contentBase64: btoa(content),
			});
			harness.runtime.nextExec = new FakeHandle(
				EXEC_ID,
				[{ seq: 1, name: "stdout", value: "sensitive remote output" }],
				{ result: completeResult() },
			);
			await harness.core.createExec(EXEC_REQUEST);
			await drain(harness);
			await harness.core.release();
			for (const record of harness.auditRecords) validateWorkspaceAuditRecord(record);
			const serialized = JSON.stringify(harness.auditRecords);
			expect(serialized).not.toContain(WORKSPACE_ID);
			expect(serialized).not.toContain(EXEC_ID);
			expect(serialized).not.toContain(EXEC_REQUEST.source);
			expect(serialized).not.toContain(content);
			expect(serialized).not.toContain("sensitive remote output");
			for (const prohibited of [
				"workspaceId",
				"execId",
				"command",
				"output",
				"fileContent",
				"ownerId",
				"sessionId",
				"bearer",
			]) {
				expect(harness.auditRecords.some(record => Object.hasOwn(record, prohibited))).toBe(false);
			}
			expect(harness.auditRecords.every(record => record.workerVersionId === "worker-version-test")).toBe(true);
			expect(harness.auditRecords.every(record => record.containerInternetEnabled === true)).toBe(true);
			const firstAudit = harness.auditRecords[0];
			if (!firstAudit) throw new Error("Expected Worker audit records");
			expect(() => validateWorkspaceAuditRecord({ ...firstAudit, containerInternetEnabled: false })).toThrow(
				"Invalid Worker audit record",
			);
		} finally {
			harness.storage.close();
		}
	});

	it("suppresses only exact ENOENT cleanup errors and propagates unknown cleanup failures", async () => {
		const missingHarness = await createHarness();
		try {
			await createEmptyWorkspace(missingHarness);
			missingHarness.runtime.nextExec = new FakeHandle(EXEC_ID, [], { result: completeResult() });
			await missingHarness.core.createExec(EXEC_REQUEST);
			await drain(missingHarness);
			missingHarness.runtime.disposeError = missing(`exec:${EXEC_ID}`);
			await expect(missingHarness.core.deleteExec(EXEC_ID)).resolves.toBeUndefined();
			expect(missingHarness.store.execution(EXEC_ID)).toBeUndefined();
		} finally {
			missingHarness.storage.close();
		}

		const unknownHarness = await createHarness();
		try {
			await createEmptyWorkspace(unknownHarness);
			unknownHarness.runtime.nextExec = new FakeHandle(EXEC_ID, [], { result: completeResult() });
			await unknownHarness.core.createExec(EXEC_REQUEST);
			await drain(unknownHarness);
			unknownHarness.runtime.disposeError = new Error("execution not found");
			await expect(unknownHarness.core.deleteExec(EXEC_ID)).rejects.toThrow("execution not found");
			expect(unknownHarness.store.execution(EXEC_ID)).toBeDefined();
		} finally {
			unknownHarness.storage.close();
		}
	});

	it("permits only legal workspace phase compare-and-set transitions", async () => {
		const harness = await createHarness();
		try {
			await createEmptyWorkspace(harness);
			expect(harness.store.finishQuiesce()?.phase).toBe("active");
			expect(harness.store.beginQuiesce()?.phase).toBe("quiescing");
			expect(harness.store.finishQuiesce()?.phase).toBe("quiesced");
			expect(harness.store.finishRestart()?.phase).toBe("quiesced");
		} finally {
			harness.storage.close();
		}
	});

	it("fences a delayed execution start before release can destroy the workspace", async () => {
		const harness = await createHarness();
		try {
			await createEmptyWorkspace(harness);
			const gate = Promise.withResolvers<FakeHandle>();
			const handle = new FakeHandle(EXEC_ID, [], { result: completeResult() });
			harness.runtime.nextExec = gate.promise;
			const createExec = harness.core.createExec(EXEC_REQUEST);
			await harness.runtime.execStarted.promise;
			const release = harness.core.release();
			gate.resolve(handle);
			await expect(createExec).rejects.toMatchObject({ status: 410, code: "workspace_gone" });
			await release;
			expect(handle.killCount).toBe(1);
			expect(harness.runtime.execCalls).toEqual([{ source: EXEC_REQUEST.source, id: EXEC_ID }]);
			expect(harness.container.destroyCount).toBe(1);
			expect(harness.store.workspace()?.phase).toBe("released");
		} finally {
			harness.storage.close();
		}
	});

	it("fences a delayed file write and waits for it before release cleanup", async () => {
		const harness = await createHarness();
		try {
			await createEmptyWorkspace(harness);
			const content = "delayed secret";
			const bytes = new TextEncoder().encode(content);
			const request = {
				path: "delayed.txt",
				sha256: await sha256Hex(bytes),
				byteLength: bytes.byteLength,
				contentBase64: btoa(content),
			};
			const gate = Promise.withResolvers<void>();
			harness.filesystem.nextWriteGate = gate.promise;
			const write = harness.core.writeFile(request);
			await harness.filesystem.writeStarted.promise;
			const release = harness.core.release();
			await expect(harness.core.writeFile(request)).rejects.toMatchObject({ status: 409 });
			gate.resolve();
			await expect(write).rejects.toMatchObject({ status: 410, code: "workspace_gone" });
			await release;
			expect(harness.filesystem.files.has(`${CLOUD_OMP_REMOTE_ROOT}/delayed.txt`)).toBe(false);
			expect(harness.container.destroyCount).toBe(1);
		} finally {
			harness.storage.close();
		}
	});

	it("propagates message-only and non-ENOENT filesystem probe failures", async () => {
		for (const error of [
			new Error("ENOENT: message-only failure"),
			Object.assign(new Error("not found"), { code: "EACCES" }),
		]) {
			const harness = await createHarness();
			try {
				await createEmptyWorkspace(harness);
				harness.filesystem.lstatError = error;
				const bytes = new TextEncoder().encode("probe");
				await expect(
					harness.core.writeFile({
						path: "probe.txt",
						sha256: await sha256Hex(bytes),
						byteLength: bytes.byteLength,
						contentBase64: btoa("probe"),
					}),
				).rejects.toBe(error);
			} finally {
				harness.storage.close();
			}
		}
	});

	it("emits timed_out when release mutation drain reaches its cleanup timeout", async () => {
		const harness = await createHarness(undefined, { cleanupTimeoutMs: 1 });
		try {
			await createEmptyWorkspace(harness);
			const bytes = new TextEncoder().encode("blocked");
			const gate = Promise.withResolvers<void>();
			harness.filesystem.nextWriteGate = gate.promise;
			const write = harness.core.writeFile({
				path: "blocked.txt",
				sha256: await sha256Hex(bytes),
				byteLength: bytes.byteLength,
				contentBase64: btoa("blocked"),
			});
			await harness.filesystem.writeStarted.promise;
			await expect(harness.core.release()).rejects.toMatchObject({ code: "cleanup_timeout" });
			const timeout = harness.auditRecords.find(
				record => record.operation === "release" && record.outcome === "timed_out",
			);
			expect(timeout).toMatchObject({
				containerInternetEnabled: true,
				cleanupState: "failed",
				errorCode: "CLEANUP_TIMEOUT",
			});
			if (timeout) validateWorkspaceAuditRecord(timeout);
			gate.resolve();
			await expect(write).rejects.toMatchObject({ code: "workspace_gone" });
		} finally {
			harness.storage.close();
		}
	});

	it("distinguishes command timeout from explicit kill in exec completion audit", async () => {
		const timeoutHarness = await createHarness();
		try {
			await createEmptyWorkspace(timeoutHarness);
			timeoutHarness.runtime.nextExec = new FakeHandle(EXEC_ID, [], {
				result: {
					status: "failed",
					exitCode: 124,
					skipped: [],
					sync: { status: "complete", skipped: [] },
				},
			});
			await timeoutHarness.core.createExec(EXEC_REQUEST);
			await drain(timeoutHarness);
			expect(timeoutHarness.auditRecords.find(record => record.operation === "exec_complete")).toMatchObject({
				outcome: "timed_out",
				exitCode: 124,
				signal: null,
			});
		} finally {
			timeoutHarness.storage.close();
		}

		const killedHarness = await createHarness();
		try {
			await createEmptyWorkspace(killedHarness);
			killedHarness.runtime.nextExec = new FakeHandle(EXEC_ID, [], {
				result: completeResult(),
				hanging: true,
			});
			await killedHarness.core.createExec(EXEC_REQUEST);
			await expect(killedHarness.core.killExec(EXEC_ID)).resolves.toMatchObject({
				status: "cancelled",
				exitCode: 137,
			});
			expect(killedHarness.auditRecords.find(record => record.operation === "exec_complete")).toMatchObject({
				outcome: "cancelled",
				exitCode: 137,
				signal: null,
			});
		} finally {
			killedHarness.storage.close();
		}
	});

	it("adapts the provider-backed filesystem to required atomic rename", async () => {
		const backing = new FakeFilesystem();
		const providerCalls: Array<{ oldPath: string; newPath: string }> = [];
		const filesystem = adaptWorkspaceFilesystem({
			fs: backing,
			provider: () => ({
				rename: async (oldPath, newPath) => {
					providerCalls.push({ oldPath, newPath });
					await backing.rename(oldPath, newPath);
				},
			}),
		});
		const from = `${CLOUD_OMP_REMOTE_ROOT}/adapter-from.txt`;
		const to = `${CLOUD_OMP_REMOTE_ROOT}/adapter-to.txt`;
		await filesystem.mkdir(CLOUD_OMP_REMOTE_ROOT, { recursive: true });
		await filesystem.writeFile(from, new TextEncoder().encode("atomic\n"));
		await filesystem.rename(from, to);
		expect(providerCalls).toEqual([{ oldPath: from, newPath: to }]);
		await expect(filesystem.lstat(from)).rejects.toMatchObject({ code: "ENOENT" });
		expect(new TextDecoder().decode(await readAll(await filesystem.readFile(to), 1024))).toBe("atomic\n");
	});

	it("rejects symlink ancestors while preserving leaf symlink stat and remove", async () => {
		const harness = await createHarness();
		try {
			await createEmptyWorkspace(harness);
			await enableRuntimeBridge(harness);
			const link = `${CLOUD_OMP_REMOTE_ROOT}/link`;
			const child = `${link}/outside.txt`;
			const safe = `${CLOUD_OMP_REMOTE_ROOT}/safe.txt`;
			harness.filesystem.symlinks.set(link, "/outside");
			harness.filesystem.files.set(safe, new TextEncoder().encode("safe"));
			const rmCalls = harness.filesystem.rmCalls.length;
			const renameCalls = harness.filesystem.renameCalls.length;
			const readdirCalls = harness.filesystem.readdirCalls.length;

			for (const envelope of [
				bridgeInspection("exists", { path: child }),
				bridgeInspection("stat", { path: child }),
				bridgeInspection("list_files", { directory: link, pattern: "*", limit: 100, cursor: null }),
				await removeEffect(child, "1".repeat(64)),
				await renameEffect(child, `${CLOUD_OMP_REMOTE_ROOT}/moved.txt`, "2".repeat(64)),
				await renameEffect(safe, child, "3".repeat(64)),
			]) {
				await expect(harness.core.applyRuntimeBridgeOperation(envelope)).rejects.toMatchObject({
					status: 400,
					code: "unsafe_path",
				});
			}
			expect(harness.filesystem.rmCalls).toHaveLength(rmCalls);
			expect(harness.filesystem.renameCalls).toHaveLength(renameCalls);
			expect(harness.filesystem.readdirCalls).toHaveLength(readdirCalls);

			await expect(
				harness.core.applyRuntimeBridgeOperation(bridgeInspection("stat", { path: link })),
			).resolves.toMatchObject({ result: { path: link, kind: "symlink" } });
			await expect(
				harness.core.applyRuntimeBridgeOperation(await removeEffect(link, "4".repeat(64))),
			).resolves.toMatchObject({ result: { status: "removed" } });
			expect(harness.filesystem.symlinks.has(link)).toBe(false);
		} finally {
			harness.storage.close();
		}
	});

	it("does not treat a fresh missing source plus existing destination as renamed", async () => {
		const harness = await createHarness();
		try {
			await createEmptyWorkspace(harness);
			await enableRuntimeBridge(harness);
			const from = `${CLOUD_OMP_REMOTE_ROOT}/missing.txt`;
			const to = `${CLOUD_OMP_REMOTE_ROOT}/unrelated.txt`;
			const unrelated = new TextEncoder().encode("unrelated");
			harness.filesystem.files.set(to, unrelated);
			const requestId = "5".repeat(64);
			const envelope = await renameEffect(from, to, requestId);
			await expect(harness.core.applyRuntimeBridgeOperation(envelope)).rejects.toMatchObject({
				status: 404,
				code: "file_not_found",
			});
			await expect(harness.core.applyRuntimeBridgeOperation(envelope)).rejects.toMatchObject({
				status: 404,
				code: "file_not_found",
			});
			expect(harness.store.runtimeRequest(requestId)).toMatchObject({ state: "reserved", result: null });
			expect(harness.filesystem.renameCalls).toHaveLength(0);
			expect(harness.filesystem.files.get(to)).toEqual(unrelated);
		} finally {
			harness.storage.close();
		}
	});

	it("reconciles only the exact durably captured rename outcome", async () => {
		const reconciled = await createHarness();
		try {
			await createEmptyWorkspace(reconciled);
			await enableRuntimeBridge(reconciled);
			const from = `${CLOUD_OMP_REMOTE_ROOT}/source.txt`;
			const to = `${CLOUD_OMP_REMOTE_ROOT}/destination.txt`;
			reconciled.filesystem.files.set(from, new TextEncoder().encode("source"));
			reconciled.filesystem.files.set(to, new TextEncoder().encode("prior destination"));
			const requestId = "6".repeat(64);
			const envelope = await renameEffect(from, to, requestId);
			const transportLost = new Error("transport lost after atomic rename");
			reconciled.filesystem.renameErrorAfterMutation = transportLost;
			await expect(reconciled.core.applyRuntimeBridgeOperation(envelope)).rejects.toBe(transportLost);
			expect(reconciled.store.runtimeRequest(requestId)).toMatchObject({
				state: "outcome_unknown",
				result: {
					operation: "rename",
					source: { path: from },
					destination: { path: to },
				},
			});
			await expect(reconciled.core.applyRuntimeBridgeOperation(envelope)).resolves.toMatchObject({
				result: { status: "already_renamed" },
			});
		} finally {
			reconciled.storage.close();
		}

		const mismatched = await createHarness();
		try {
			await createEmptyWorkspace(mismatched);
			await enableRuntimeBridge(mismatched);
			const from = `${CLOUD_OMP_REMOTE_ROOT}/source.txt`;
			const to = `${CLOUD_OMP_REMOTE_ROOT}/destination.txt`;
			mismatched.filesystem.files.set(from, new TextEncoder().encode("source"));
			mismatched.filesystem.files.set(to, new TextEncoder().encode("prior destination"));
			const envelope = await renameEffect(from, to, "7".repeat(64));
			mismatched.filesystem.renameErrorAfterMutation = new Error("transport lost after atomic rename");
			await expect(mismatched.core.applyRuntimeBridgeOperation(envelope)).rejects.toThrow("transport lost");
			await mismatched.filesystem.rm(to, { force: true });
			mismatched.filesystem.files.set(to, new TextEncoder().encode("unrelated replacement"));
			await expect(mismatched.core.applyRuntimeBridgeOperation(envelope)).rejects.toMatchObject({
				status: 409,
				code: "request_conflict",
			});
		} finally {
			mismatched.storage.close();
		}
	});

	it("resumes opaque search cursors without rereading completed files or duplicating matches", async () => {
		const harness = await createHarness();
		try {
			await createEmptyWorkspace(harness);
			await enableRuntimeBridge(harness);
			await harness.filesystem.mkdir(`${CLOUD_OMP_REMOTE_ROOT}/search`, { recursive: true });
			await harness.filesystem.mkdir(`${CLOUD_OMP_REMOTE_ROOT}/outside`, { recursive: true });
			const priorDirectory = `${CLOUD_OMP_REMOTE_ROOT}/search/0000-prior`;
			const priorNestedDirectory = `${priorDirectory}/nested`;
			const priorFile = `${priorNestedDirectory}/ignored.txt`;
			await harness.filesystem.mkdir(priorNestedDirectory, { recursive: true });
			harness.filesystem.files.set(priorFile, new TextEncoder().encode("no match here\n"));
			const paths = ["a.txt", "b.txt", "c.txt"].map(name => `${CLOUD_OMP_REMOTE_ROOT}/search/${name}`);
			for (const [index, path] of paths.entries()) {
				harness.filesystem.files.set(path, new TextEncoder().encode(`prefix ${index}\nalpha\nbeta ${index}\n`));
			}
			harness.filesystem.files.set(
				`${CLOUD_OMP_REMOTE_ROOT}/outside/ignored.txt`,
				new TextEncoder().encode("alpha\nbeta outside\n"),
			);
			const search = async (path: string, pattern: string, cursor: string | null): Promise<RuntimeSearchResult> => {
				const response = await harness.core.applyRuntimeBridgeOperation(
					bridgeInspection("search_text", { path, pattern, flags: "", limit: 1, cursor }),
				);
				return response.result as RuntimeSearchResult;
			};

			const first = await search(`${CLOUD_OMP_REMOTE_ROOT}/search`, "alpha\\nbeta", null);
			expect(first.matches).toEqual([{ path: paths[0], line: 2, column: 1, text: "alpha" }]);
			expect(first.nextCursor).toEqual(expect.any(String));
			const firstCursorTuple = JSON.parse(atob(first.nextCursor!)) as unknown[];
			expect([firstCursorTuple[0], firstCursorTuple[2], firstCursorTuple[3]]).toEqual([
				"omp-cloudflare-search-cursor-v1",
				paths[1],
				9,
			]);
			expect(harness.filesystem.readCalls).toEqual([priorFile, ...paths.slice(0, 2)]);

			harness.filesystem.readCalls.length = 0;
			harness.filesystem.readdirCalls.length = 0;
			harness.filesystem.lstatCalls.length = 0;
			const second = await search(`${CLOUD_OMP_REMOTE_ROOT}/search`, "alpha\\nbeta", first.nextCursor);
			expect(second.matches).toEqual([{ path: paths[1], line: 2, column: 1, text: "alpha" }]);
			expect(second.nextCursor).toEqual(expect.any(String));
			expect(harness.filesystem.readCalls).toEqual(paths.slice(1));
			expect(harness.filesystem.readdirCalls).not.toContain(priorDirectory);
			expect(harness.filesystem.readdirCalls).not.toContain(priorNestedDirectory);
			expect(harness.filesystem.lstatCalls).not.toContain(priorDirectory);
			expect(harness.filesystem.lstatCalls).not.toContain(paths[0]);

			harness.filesystem.readCalls.length = 0;
			const third = await search(`${CLOUD_OMP_REMOTE_ROOT}/search`, "alpha\\nbeta", second.nextCursor);
			expect(third).toEqual({
				matches: [{ path: paths[2], line: 2, column: 1, text: "alpha" }],
				nextCursor: null,
			});
			expect(harness.filesystem.readCalls).toEqual(paths.slice(2));

			const multiPath = `${CLOUD_OMP_REMOTE_ROOT}/search/multi.txt`;
			harness.filesystem.files.set(multiPath, new TextEncoder().encode("hit first\nmiddle\nhit second\n"));
			const multiFirst = await search(multiPath, "hit", null);
			expect(multiFirst.matches).toEqual([{ path: multiPath, line: 1, column: 1, text: "hit first" }]);
			const multiCursorTuple = JSON.parse(atob(multiFirst.nextCursor!)) as unknown[];
			expect([multiCursorTuple[0], multiCursorTuple[2], multiCursorTuple[3]]).toEqual([
				"omp-cloudflare-search-cursor-v1",
				multiPath,
				17,
			]);
			const multiSecond = await search(multiPath, "hit", multiFirst.nextCursor);
			expect(multiSecond).toEqual({
				matches: [{ path: multiPath, line: 3, column: 1, text: "hit second" }],
				nextCursor: null,
			});

			const staleRequest = {
				...RUNTIME_ACCESS,
				path: multiPath as RuntimeSearchRequest["path"],
				pattern: "hit",
				flags: "",
				limit: 1,
				cursor: null,
			} as RuntimeSearchRequest;
			const staleCursor = await encodeCloudflareRuntimeSearchCursorV1(staleRequest, {
				path: staleRequest.path,
				codeUnitOffset: 100,
			});
			await expect(search(multiPath, "hit", staleCursor)).rejects.toMatchObject({
				status: 409,
				code: "request_conflict",
			});
		} finally {
			harness.storage.close();
		}
	});

	it("bounds no-match search by file, byte, and traversal metadata budgets", async () => {
		const fileHarness = await createHarness();
		try {
			await createEmptyWorkspace(fileHarness);
			await enableRuntimeBridge(fileHarness);
			await fileHarness.filesystem.mkdir(`${CLOUD_OMP_REMOTE_ROOT}/search`, { recursive: true });
			const paths = Array.from(
				{ length: CLOUDFLARE_RUNTIME_SEARCH_FILE_BUDGET_V1 + 1 },
				(_, index) => `${CLOUD_OMP_REMOTE_ROOT}/search/${String(index).padStart(4, "0")}.txt`,
			);
			for (const path of paths) fileHarness.filesystem.files.set(path, new TextEncoder().encode("x"));
			const search = async (cursor: string | null): Promise<RuntimeSearchResult> => {
				const response = await fileHarness.core.applyRuntimeBridgeOperation(
					bridgeInspection("search_text", {
						path: `${CLOUD_OMP_REMOTE_ROOT}/search`,
						pattern: "needle",
						flags: "",
						limit: 1,
						cursor,
					}),
				);
				return response.result as RuntimeSearchResult;
			};
			const first = await search(null);
			expect(first.matches).toEqual([]);
			expect(first.nextCursor).toEqual(expect.any(String));
			expect(fileHarness.filesystem.readCalls).toEqual(paths.slice(0, CLOUDFLARE_RUNTIME_SEARCH_FILE_BUDGET_V1));
			fileHarness.filesystem.readCalls.length = 0;
			const second = await search(first.nextCursor);
			expect(second).toEqual({ matches: [], nextCursor: null });
			expect(fileHarness.filesystem.readCalls).toEqual(paths.slice(CLOUDFLARE_RUNTIME_SEARCH_FILE_BUDGET_V1));
		} finally {
			fileHarness.storage.close();
		}

		const byteHarness = await createHarness();
		try {
			await createEmptyWorkspace(byteHarness);
			await enableRuntimeBridge(byteHarness);
			await byteHarness.filesystem.mkdir(`${CLOUD_OMP_REMOTE_ROOT}/search`, { recursive: true });
			const paths = Array.from(
				{ length: CLOUDFLARE_RUNTIME_SEARCH_BYTE_BUDGET_V1 / MAX_SYNC_FILE_BYTES + 1 },
				(_, index) => `${CLOUD_OMP_REMOTE_ROOT}/search/${String(index).padStart(4, "0")}.txt`,
			);
			for (const path of paths)
				byteHarness.filesystem.files.set(path, new Uint8Array(MAX_SYNC_FILE_BYTES).fill(120));
			const search = async (cursor: string | null): Promise<RuntimeSearchResult> => {
				const response = await byteHarness.core.applyRuntimeBridgeOperation(
					bridgeInspection("search_text", {
						path: `${CLOUD_OMP_REMOTE_ROOT}/search`,
						pattern: "needle",
						flags: "",
						limit: 1,
						cursor,
					}),
				);
				return response.result as RuntimeSearchResult;
			};
			const first = await search(null);
			expect(first.matches).toEqual([]);
			expect(first.nextCursor).toEqual(expect.any(String));
			expect(byteHarness.filesystem.readByteCount).toBe(CLOUDFLARE_RUNTIME_SEARCH_BYTE_BUDGET_V1);
			byteHarness.filesystem.readCalls.length = 0;
			byteHarness.filesystem.readByteCount = 0;
			const second = await search(first.nextCursor);
			expect(second).toEqual({ matches: [], nextCursor: null });
			expect(byteHarness.filesystem.readCalls).toEqual(paths.slice(-1));
			expect(byteHarness.filesystem.readByteCount).toBe(MAX_SYNC_FILE_BYTES);
		} finally {
			byteHarness.storage.close();
		}

		const traversalHarness = await createHarness();
		try {
			await createEmptyWorkspace(traversalHarness);
			await enableRuntimeBridge(traversalHarness);
			const searchRoot = `${CLOUD_OMP_REMOTE_ROOT}/search`;
			await traversalHarness.filesystem.mkdir(searchRoot, { recursive: true });
			const bucketCount = 5;
			const directoryCount =
				Math.floor((CLOUDFLARE_RUNTIME_SEARCH_TRAVERSAL_BUDGET_V1 - 3 - bucketCount * 2) / 2) + 2;
			const bucketPaths = Array.from(
				{ length: bucketCount },
				(_, index) => `${searchRoot}/bucket-${String(index).padStart(2, "0")}`,
			);
			for (const bucket of bucketPaths) traversalHarness.filesystem.directories.add(bucket);
			const directoryPaths = Array.from({ length: directoryCount }, (_, index) => {
				const bucket = bucketPaths[Math.floor((index * bucketCount) / directoryCount)]!;
				return `${bucket}/${String(index).padStart(5, "0")}`;
			});
			for (const directory of directoryPaths) traversalHarness.filesystem.directories.add(directory);
			const search = async (cursor: string | null): Promise<RuntimeSearchResult> => {
				const response = await traversalHarness.core.applyRuntimeBridgeOperation(
					bridgeInspection("search_text", {
						path: searchRoot,
						pattern: "needle",
						flags: "",
						limit: 1,
						cursor,
					}),
				);
				return response.result as RuntimeSearchResult;
			};
			traversalHarness.filesystem.readdirCalls.length = 0;
			traversalHarness.filesystem.lstatCalls.length = 0;
			const first = await search(null);
			expect(first.matches).toEqual([]);
			expect(first.nextCursor).toEqual(expect.any(String));
			expect(traversalHarness.filesystem.readdirCalls.length + traversalHarness.filesystem.lstatCalls.length).toBe(
				CLOUDFLARE_RUNTIME_SEARCH_TRAVERSAL_BUDGET_V1,
			);
			const cursorTuple = JSON.parse(atob(first.nextCursor!)) as unknown[];
			expect(cursorTuple[3]).toBe(0);
			const resumedDirectory = cursorTuple[2] as string;

			traversalHarness.filesystem.readdirCalls.length = 0;
			traversalHarness.filesystem.lstatCalls.length = 0;
			await expect(search(first.nextCursor)).resolves.toEqual({ matches: [], nextCursor: null });
			expect(
				traversalHarness.filesystem.readdirCalls.length + traversalHarness.filesystem.lstatCalls.length,
			).toBeLessThanOrEqual(CLOUDFLARE_RUNTIME_SEARCH_TRAVERSAL_BUDGET_V1);
			expect(traversalHarness.filesystem.readdirCalls).toContain(resumedDirectory);
			expect(traversalHarness.filesystem.readdirCalls).not.toContain(directoryPaths[0]);
			expect(traversalHarness.filesystem.lstatCalls).not.toContain(directoryPaths[0]);
			expect(traversalHarness.filesystem.readdirCalls).not.toContain(bucketPaths[0]);
			expect(traversalHarness.filesystem.lstatCalls).not.toContain(bucketPaths[0]);

			const lexicalPriorDirectory = `${searchRoot}/z!`;
			const exactDirectory = `${searchRoot}/z`;
			traversalHarness.filesystem.directories.add(lexicalPriorDirectory);
			traversalHarness.filesystem.directories.add(exactDirectory);
			const directoryCursorRequest = {
				...RUNTIME_ACCESS,
				path: searchRoot as RuntimeSearchRequest["path"],
				pattern: "needle",
				flags: "",
				limit: 1,
				cursor: null,
			} as RuntimeSearchRequest;
			const directoryCursor = await encodeCloudflareRuntimeSearchCursorV1(directoryCursorRequest, {
				path: exactDirectory as RuntimeSearchRequest["path"],
				codeUnitOffset: 0,
			});
			traversalHarness.filesystem.readdirCalls.length = 0;
			traversalHarness.filesystem.lstatCalls.length = 0;
			await expect(search(directoryCursor)).resolves.toEqual({ matches: [], nextCursor: null });
			expect(traversalHarness.filesystem.readdirCalls).toContain(exactDirectory);
			expect(traversalHarness.filesystem.readdirCalls).not.toContain(lexicalPriorDirectory);
			expect(traversalHarness.filesystem.lstatCalls).not.toContain(lexicalPriorDirectory);
		} finally {
			traversalHarness.storage.close();
		}
	});

	it("paginates before repeated full-line matches exceed the encoded result budget", async () => {
		const harness = await createHarness();
		try {
			await createEmptyWorkspace(harness);
			await enableRuntimeBridge(harness);
			const path = `${CLOUD_OMP_REMOTE_ROOT}/escaped-line.txt`;
			harness.filesystem.files.set(path, new Uint8Array(MAX_SYNC_FILE_BYTES).fill(1));
			const search = async (cursor: string | null): Promise<RuntimeSearchResult> => {
				const response = await harness.core.applyRuntimeBridgeOperation(
					bridgeInspection("search_text", {
						path,
						pattern: "\u0001",
						flags: "",
						limit: 1_000,
						cursor,
					}),
				);
				return response.result as RuntimeSearchResult;
			};

			const first = await search(null);
			expect(first.matches).toHaveLength(1);
			expect(first.matches[0]).toMatchObject({ path, line: 1, column: 1 });
			expect(first.matches[0]!.text.length).toBe(MAX_SYNC_FILE_BYTES);
			expect(first.nextCursor).toEqual(expect.any(String));
			expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThanOrEqual(
				CLOUDFLARE_RUNTIME_SEARCH_RESULT_BYTE_BUDGET_V1,
			);
			const cursorTuple = JSON.parse(atob(first.nextCursor!)) as unknown[];
			expect(cursorTuple[3]).toBe(1);

			const second = await search(first.nextCursor);
			expect(second.matches).toHaveLength(1);
			expect(second.matches[0]).toMatchObject({ path, line: 1, column: 2 });
			expect(new TextEncoder().encode(JSON.stringify(second)).byteLength).toBeLessThanOrEqual(
				CLOUDFLARE_RUNTIME_SEARCH_RESULT_BYTE_BUDGET_V1,
			);
		} finally {
			harness.storage.close();
		}
	});
});
