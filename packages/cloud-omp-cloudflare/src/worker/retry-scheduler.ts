import type { SyncRetryIntent, SyncRetryScheduler } from "@cloudflare/computer";
import type { SqlStorageLike, WorkspaceStateStore } from "./workspace-state-store";

export type { SqlCursorLike, SqlStorageLike } from "./workspace-state-store";
export { EXECUTIONS_TABLE, RETRY_INTENTS_TABLE, WORKSPACE_STATE_TABLE } from "./workspace-state-store";

/** Owns the Durable Object's single alarm and always derives it from durable state. */
export class WorkspaceAlarmCoordinator {
	#tail: Promise<void> = Promise.resolve();
	#now: () => number = Date.now;

	constructor(
		private readonly storage: SqlStorageLike,
		private readonly store: WorkspaceStateStore,
	) {}

	setClock(now: () => number): void {
		this.#now = now;
	}

	rearm(nowEpochMs: number = this.#now()): Promise<void> {
		const run = this.#tail.then(() => this.#rearmNow(nowEpochMs));
		this.#tail = run.catch(() => undefined);
		return run;
	}

	async #rearmNow(nowEpochMs: number): Promise<void> {
		const target = this.store.alarmTarget();
		if (target === undefined) {
			await this.storage.deleteAlarm();
			return;
		}
		const alarmAt = Math.max(nowEpochMs, target);
		const current = await this.storage.getAlarm?.();
		if (current !== alarmAt) await this.storage.setAlarm(alarmAt);
	}
}

/** SQLite-backed scheduler required by Workspace's pending-pull retry contract. */
export class SQLiteRetryScheduler implements SyncRetryScheduler {
	constructor(
		private readonly store: WorkspaceStateStore,
		private readonly alarms: WorkspaceAlarmCoordinator,
	) {}

	async get(backend: string): Promise<SyncRetryIntent | undefined> {
		return this.store.getRetry(backend);
	}

	async schedule(intent: SyncRetryIntent): Promise<void> {
		if (
			!intent.backend ||
			!Number.isSafeInteger(intent.attempt) ||
			intent.attempt < 1 ||
			!Number.isSafeInteger(intent.notBefore) ||
			intent.notBefore < 0
		) {
			throw new Error("Invalid Workspace sync retry intent");
		}
		this.store.scheduleRetry(intent);
		await this.alarms.rearm();
	}

	async clear(backend: string): Promise<void> {
		this.store.clearRetry(backend);
		await this.alarms.rearm();
	}

	list(): SyncRetryIntent[] {
		return this.store.listRetries();
	}

	async clearAll(): Promise<void> {
		this.store.clearRetries();
		await this.alarms.rearm();
	}
}
