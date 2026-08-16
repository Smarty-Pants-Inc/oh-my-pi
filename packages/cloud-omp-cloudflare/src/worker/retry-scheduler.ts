import type { SyncRetryIntent, SyncRetryScheduler } from "@cloudflare/computer";
import type { SqlStorageLike, WorkspaceStateStore } from "./workspace-state-store";

export type { SqlCursorLike, SqlStorageLike } from "./workspace-state-store";
export { EXECUTIONS_TABLE, RETRY_INTENTS_TABLE, WORKSPACE_STATE_TABLE } from "./workspace-state-store";

/** Owns the Durable Object's single alarm and always derives it from durable state. */
export class WorkspaceAlarmCoordinator {
	#tail: Promise<void> = Promise.resolve();

	constructor(
		private readonly storage: SqlStorageLike,
		private readonly store: WorkspaceStateStore,
	) {}

	rearm(): Promise<void> {
		const run = this.#tail.then(() => this.#rearmNow());
		this.#tail = run.catch(() => undefined);
		return run;
	}

	async #rearmNow(): Promise<void> {
		const alarmAt = this.store.alarmTarget();
		if (alarmAt === undefined) {
			await this.storage.deleteAlarm();
			return;
		}
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
			!Number.isInteger(intent.attempt) ||
			intent.attempt < 1 ||
			!Number.isFinite(intent.notBefore)
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
