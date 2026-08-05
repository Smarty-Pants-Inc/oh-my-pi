import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { CLOUD_OMP_REMOTE_ROOT, type CreateWorkspaceRequest, type ExecRequest } from "../src/protocol";
import { SQLiteRetryScheduler, WorkspaceAlarmCoordinator } from "../src/worker/retry-scheduler";
import {
	hashWorkspaceId,
	validateWorkspaceAuditRecord,
	type WorkspaceAuditRecord,
	WorkspaceAuditSink,
} from "../src/worker/workspace-audit";
import {
	manifestRootSha256,
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
	readonly writeStarted = Promise.withResolvers<void>();
	nextWriteGate: Promise<void> | undefined;
	lstatError: unknown;

	async readFile(path: string): Promise<ReadableStream<Uint8Array>> {
		const bytes = this.files.get(path);
		if (!bytes) throw missing(path);
		return new ReadableStream({
			start(controller) {
				controller.enqueue(bytes.slice());
				controller.close();
			},
		});
	}

	async lstat(path: string): Promise<WorkspaceStatLike> {
		if (this.lstatError !== undefined) throw this.lstatError;
		if (this.files.has(path)) return { isFile: true, isDirectory: false, isSymbolicLink: false };
		if (this.directories.has(path)) return { isFile: false, isDirectory: true, isSymbolicLink: false };
		throw missing(path);
	}

	async readdir(path: string): Promise<WorkspaceDirentLike[]> {
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
		if (!this.files.has(path) && !this.directories.has(path) && !options?.force) throw missing(path);
		for (const file of [...this.files.keys()]) {
			if (file === path || (options?.recursive && file.startsWith(`${path}/`))) this.files.delete(file);
		}
		for (const directory of [...this.directories]) {
			if (directory === path || (options?.recursive && directory.startsWith(`${path}/`)))
				this.directories.delete(directory);
		}
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
});
