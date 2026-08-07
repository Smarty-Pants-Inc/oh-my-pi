import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AsyncJobManager, type ManagedAsyncJobCompletionRow } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type {
	ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1,
	TransientTaskAsyncJobCompletionHandoffV1,
	TransientTaskParentResultDeliveryStoreV1,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";

const SHA = `sha256:${"a".repeat(64)}` as const;

type ManagedRecoveryTestRecord = {
	readonly coordinates: {
		readonly ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1;
		readonly jobId: string;
		readonly agentId: string;
		readonly label: string;
		readonly startedAtEpochMs: number;
	};
	readonly recoveryRecordSha256: string;
	readonly [key: string]: unknown;
};

function managedOwnerIndex(ownerId = "Main"): ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1 {
	const core = {
		schemaVersion: 1 as const,
		ownerId,
		ownerSessionId: "session-1",
		ownerSessionGenerationSha256: SHA,
		deliveryEpoch: 0,
	};
	return {
		...core,
		indexSha256: `sha256:${createHash("sha256")
			.update(JSON.stringify(["async-job-owner-session-index", core]), "utf8")
			.digest("hex")}` as typeof SHA,
	};
}

function managedHandoff(
	ownerId: string,
	jobId: string,
	text: string,
	terminalStatus: "completed" | "cancelled" = "completed",
) {
	return {
		schemaVersion: 1,
		jobType: "task",
		ownerId,
		jobId,
		notAppliedReceiptSha256: SHA,
		handoffSha256: `sha256:${createHash("sha256").update(["managed-handoff", ownerId, jobId, text, terminalStatus].join("\0")).digest("hex")}`,
		terminalStatus,
		text,
		jobErrorTextUtf8: terminalStatus === "cancelled" ? text : null,
		attempt: {
			attemptSha256: SHA,
			operation: { request: { identity: { identitySha256: SHA }, settlementRequestSha256: SHA } },
		},
		settlementRequest: { sinkResultUtf8: text },
		settledResultReceipt: { publishedAt: "2026-01-01T00:00:00.000Z" },
		currentAuthority: {},
	} as unknown as TransientTaskAsyncJobCompletionHandoffV1;
}

function managedRecord(
	ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1,
	jobId: string,
	text: string,
	startedAtEpochMs: number,
	terminalStatus: "completed" | "cancelled" = "completed",
): ManagedRecoveryTestRecord {
	const completion = managedHandoff(ownerSessionIndex.ownerId, jobId, text, terminalStatus);
	return {
		schemaVersion: 1,
		jobType: "task",
		coordinates: { ownerSessionIndex, jobId, agentId: jobId, label: jobId, startedAtEpochMs },
		recoveryState: "handoff_ready",
		terminalStatus,
		status: terminalStatus === "cancelled" ? "cancelled" : "completed",
		resultText: terminalStatus === "cancelled" ? null : text,
		errorText: terminalStatus === "cancelled" ? text : null,
		transientTaskCompletion: completion,
		transientTaskSettlementBlock: null,
		notAppliedReceiptSha256: SHA,
		blockSha256: null,
		handoffSha256: completion.handoffSha256,
		recoveryRecordSha256: SHA,
	};
}

function committedManagedHandoff(row: ManagedAsyncJobCompletionRow) {
	return { status: "committed", handoffSha256: row.transientTaskCompletion.handoffSha256 } as const;
}

function notAppliedManagedHandoff(row: ManagedAsyncJobCompletionRow) {
	return { status: "not_applied", handoffSha256: row.transientTaskCompletion.handoffSha256 } as const;
}

function bindManagedRecoveryStore(
	manager: AsyncJobManager,
	ownerSessionIndex: ConfidentialAsyncJobTransientTaskRecoveryOwnerSessionIndexV1,
	rows: Map<string, ManagedRecoveryTestRecord>,
	options?: { readonly terminalJobIds?: ReadonlySet<string> },
): void {
	const store = {
		detachedSettlement: {
			prepareAsyncJobRecovery: async (request: { readonly record: ManagedRecoveryTestRecord }) => {
				rows.set(request.record.coordinates.jobId, request.record);
				return { status: "prepared", record: request.record };
			},
			transitionAsyncJobRecovery: async (request: { readonly record: ManagedRecoveryTestRecord }) => {
				rows.set(request.record.coordinates.jobId, request.record);
				return { status: "transitioned", record: request.record, receipt: {} };
			},
			enumerateAsyncJobRecovery: async () => ({
				status: "matching",
				entries: Array.from(rows.values()).map(record => ({
					jobId: record.coordinates.jobId,
					startedAtEpochMs: record.coordinates.startedAtEpochMs,
					recoveryRecordSha256: record.recoveryRecordSha256,
				})),
			}),
			inspectAsyncJobRecovery: async (request: { readonly jobId: string }) =>
				options?.terminalJobIds?.has(request.jobId)
					? { status: "terminal", terminalReceiptSha256: SHA }
					: {
							status: "matching",
							entry: { jobId: request.jobId },
						},
			adoptAsyncJobRecovery: async (request: {
				readonly inspection: { readonly entry: { readonly jobId: string } };
			}) => ({
				status: "adopted",
				record: rows.get(request.inspection.entry.jobId)!,
			}),
		},
	} as unknown as TransientTaskParentResultDeliveryStoreV1;
	const bound = manager.bindTransientTaskParentResultDeliveryStore({ ownerSessionIndex, store });
	if (bound.status !== "bound") throw new Error("Expected managed recovery store to bind");
}

describe("AsyncJobManager", () => {
	test("forwards progress updates and delivers completion", async () => {
		const progressEvents: Array<{ text: string; details?: Record<string, unknown> }> = [];
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register(
			"bash",
			"echo hi",
			async ({ reportProgress }) => {
				await reportProgress("running step", { async: { state: "running" } });
				return "final output";
			},
			{
				onProgress: async (text, details) => {
					progressEvents.push({ text, details });
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(progressEvents).toEqual([{ text: "running step", details: { async: { state: "running" } } }]);
		expect(completions).toEqual([{ jobId, text: "final output" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("swallows progress callback errors without failing the job", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register(
			"task",
			"agent task",
			async ({ reportProgress }) => {
				await reportProgress("subagent started");
				return "task done";
			},
			{
				onProgress: async () => {
					throw new Error("progress renderer exploded");
				},
			},
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "task done" }]);
		expect(manager.getJob(jobId)?.status).toBe("completed");
	});

	test("delivers error text when run fails", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "bad command", async () => {
			throw new Error("command failed");
		});

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(completions).toEqual([{ jobId, text: "command failed" }]);
		expect(manager.getJob(jobId)?.status).toBe("failed");
		expect(manager.getJob(jobId)?.errorText).toBe("command failed");
	});

	test("cancels a running job by id", async () => {
		const completions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				completions.push({ jobId, text });
			},
		});

		const jobId = manager.register("bash", "sleep", async ({ signal }) => {
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
			throw new Error("unreachable");
		});

		expect(manager.cancel(jobId)).toBe(true);
		expect(manager.cancel(jobId)).toBe(false);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("cancelled");
		expect(completions).toHaveLength(0);
	});

	test("enforces maxRunningJobs cap", () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const firstJobId = manager.register("bash", "first", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		expect(() =>
			manager.register("bash", "second", async () => {
				return "second";
			}),
		).toThrow(/Background job limit reached/);

		manager.cancel(firstJobId);
	});

	test("queued jobs do not count toward the cap until markRunning", async () => {
		const manager = new AsyncJobManager({
			maxRunningJobs: 1,
			onJobComplete: async () => {},
		});

		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const queuedJobId = manager.register(
			"task",
			"queued",
			async ({ markRunning }) => {
				await gate.promise;
				markRunning();
				started.resolve();
				await release.promise;
				return "queued done";
			},
			{ queued: true },
		);

		// Queued job holds no slot: another job registers fine at cap 1.
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			return "done";
		});

		// Free the slot, then let the queued job start: it now occupies the slot.
		manager.cancel(runningJobId);
		gate.resolve();
		await started.promise;
		expect(() => manager.register("bash", "third", async () => "third")).toThrow(/Background job limit reached/);

		release.resolve();
		await manager.waitForAll();
		expect(manager.getJob(queuedJobId)?.status).toBe("completed");
	});

	test("evicts completed jobs after retention period", async () => {
		const manager = new AsyncJobManager({
			retentionMs: 25,
			onJobComplete: async () => {},
		});

		const jobId = manager.register("task", "short", async () => "done");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("completed");
		await Bun.sleep(60);
		expect(manager.getJob(jobId)).toBeUndefined();
	});

	test("cancelAll does not clear retention timers for already completed jobs", async () => {
		const manager = new AsyncJobManager({
			retentionMs: 30,
			onJobComplete: async () => {},
		});

		const completedJobId = manager.register("task", "completed", async () => "done");
		const runningJobId = manager.register("bash", "running", async ({ signal }) => {
			await new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			throw new Error("aborted");
		});

		const completedDeadline = Date.now() + 2_000;
		while (manager.getJob(completedJobId)?.status === "running") {
			if (Date.now() >= completedDeadline) throw new Error("Timed out waiting for completed job");
			await Bun.sleep(5);
		}
		manager.cancelAll();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(completedJobId)?.status).toBe("completed");
		expect(manager.getJob(runningJobId)?.status).toBe("cancelled");

		await Bun.sleep(80);
		expect(manager.getJob(completedJobId)).toBeUndefined();
		expect(manager.getJob(runningJobId)).toBeUndefined();
	});

	test("acknowledgeDeliveries suppresses pending retries for completed jobs", async () => {
		let attempts = 0;
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				attempts += 1;
				throw new Error("delivery failed");
			},
		});

		const jobId = manager.register("task", "awaited-job", async () => "done");
		await manager.waitForAll();

		const firstAttemptDeadline = Date.now() + 2_000;
		while (attempts === 0) {
			if (Date.now() >= firstAttemptDeadline) throw new Error("Timed out waiting for first delivery attempt");
			await Bun.sleep(5);
		}

		expect(manager.hasPendingDeliveries()).toBe(true);
		const removed = manager.acknowledgeDeliveries([jobId]);
		expect(removed).toBeGreaterThanOrEqual(1);

		const drained = await manager.drainDeliveries({ timeoutMs: 200 });
		expect(drained).toBe(true);
		expect(manager.hasPendingDeliveries()).toBe(false);

		const attemptsAfterAck = attempts;
		await Bun.sleep(700);
		expect(attempts).toBe(attemptsAfterAck);
	});

	test("dispose clears jobs and pending deliveries", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {
				throw new Error("delivery failed");
			},
		});

		manager.register("bash", "will-complete", async () => "output");
		await manager.waitForAll();
		expect(manager.hasPendingDeliveries()).toBe(true);

		const drained = await manager.dispose({ timeoutMs: 25 });
		expect(drained).toBe(false);
		expect(manager.getAllJobs()).toHaveLength(0);
		expect(manager.hasPendingDeliveries()).toBe(false);
	});

	test("dispose honors timeout when a cancelled job never settles", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		manager.register("bash", "ignores-abort", async () => {
			await Promise.withResolvers<never>().promise;
			return "unreachable";
		});

		const startedAt = Date.now();
		const result = await Promise.race([
			manager.dispose({ timeoutMs: 25 }).then(drained => ({ drained, settled: true })),
			Bun.sleep(150).then(() => ({ drained: true, settled: false })),
		]);

		expect(result.settled).toBe(true);
		expect(result.drained).toBe(false);
		expect(Date.now() - startedAt).toBeLessThan(150);
		expect(manager.getAllJobs()).toHaveLength(0);
	});

	test("scoped delivery drain returns once matching owner deliveries finish", async () => {
		let mainJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const subagentCompletions: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({ retentionMs: 0 });
		manager.registerDeliverySink("0-Main", async () => {
			notifyMainDeliveryStarted();
			await mainDeliveryReleased;
		});
		manager.registerDeliverySink("3-AuthLoader", (jobId, text) => {
			subagentCompletions.push({ jobId, text });
		});

		mainJobId = manager.register("task", "main job", async () => "main result", { ownerId: "0-Main" });
		const targetJobId = manager.register("task", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(true);
		const drained = await manager.drainDeliveries({ timeoutMs: 50, filter: { ownerId: "3-AuthLoader" } });

		expect(drained).toBe(true);
		expect(subagentCompletions).toEqual([{ jobId: targetJobId, text: "subagent result" }]);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(false);

		expect(manager.acknowledgeDeliveries([mainJobId])).toBe(0);
		expect(manager.hasPendingDeliveries({ ownerId: "0-Main" })).toBe(false);
		releaseMainDelivery();
		await Bun.sleep(0);
	});

	test("scoped delivery drain times out while a matching delivery callback is in flight", async () => {
		let targetJobId = "";
		let releaseMainDelivery = (): void => {};
		let notifyMainDeliveryStarted = (): void => {};
		let releaseTargetDelivery = (): void => {};
		let notifyTargetDeliveryStarted = (): void => {};
		const mainDeliveryStarted = new Promise<void>(resolve => {
			notifyMainDeliveryStarted = resolve;
		});
		const mainDeliveryReleased = new Promise<void>(resolve => {
			releaseMainDelivery = resolve;
		});
		const targetDeliveryStarted = new Promise<void>(resolve => {
			notifyTargetDeliveryStarted = resolve;
		});
		const targetDeliveryReleased = new Promise<void>(resolve => {
			releaseTargetDelivery = resolve;
		});
		const completions: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink("0-Main", async () => {
			notifyMainDeliveryStarted();
			await mainDeliveryReleased;
		});
		manager.registerDeliverySink("3-AuthLoader", async jobId => {
			notifyTargetDeliveryStarted();
			await targetDeliveryReleased;
			completions.push(jobId);
		});

		manager.register("task", "main job", async () => "main result", { ownerId: "0-Main" });
		targetJobId = manager.register("task", "subagent job", async () => "subagent result", {
			ownerId: "3-AuthLoader",
		});
		await manager.waitForAll();
		await mainDeliveryStarted;

		const timedOut = await manager.drainDeliveries({ timeoutMs: 10, filter: { ownerId: "3-AuthLoader" } });
		await targetDeliveryStarted;

		expect(timedOut).toBe(false);
		expect(manager.hasPendingDeliveries({ ownerId: "3-AuthLoader" })).toBe(true);
		expect(completions).toEqual([]);

		releaseTargetDelivery();
		const drained = await manager.drainDeliveries({ timeoutMs: 200, filter: { ownerId: "3-AuthLoader" } });
		expect(drained).toBe(true);
		expect(completions).toEqual([targetJobId]);

		releaseMainDelivery();
		expect(await manager.drainDeliveries({ timeoutMs: 200 })).toBe(true);
	});

	test("cancelAll with ownerId only cancels matching jobs", async () => {
		const manager = new AsyncJobManager({
			onJobComplete: async () => {},
		});

		const hold = (signal: AbortSignal) =>
			new Promise<void>(resolve => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});

		const parentJobId = manager.register(
			"bash",
			"parent-job",
			async ({ signal }) => {
				await hold(signal);
				return "parent-cancelled";
			},
			{ ownerId: "0-Main" },
		);
		const subagentJobId = manager.register(
			"bash",
			"subagent-job",
			async ({ signal }) => {
				await hold(signal);
				return "subagent-cancelled";
			},
			{ ownerId: "3-AuthLoader" },
		);

		manager.cancelAll({ ownerId: "3-AuthLoader" });

		expect(manager.getJob(parentJobId)?.status).toBe("running");
		expect(manager.getJob(subagentJobId)?.status).toBe("cancelled");

		// Filtered query mirrors filtered cancel.
		expect(manager.getRunningJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);
		expect(manager.getRunningJobs({ ownerId: "3-AuthLoader" })).toEqual([]);
		expect(manager.getAllJobs({ ownerId: "0-Main" }).map(j => j.id)).toEqual([parentJobId]);

		// Unscoped cancelAll still cleans up everything.
		manager.cancelAll();
		await manager.waitForAll();
		expect(manager.getJob(parentJobId)?.status).toBe("cancelled");
	});

	test("routes owned deliveries to the owner's registered sink only", async () => {
		const mainDeliveries: string[] = [];
		const defaultDeliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				defaultDeliveries.push(jobId);
			},
		});
		manager.registerDeliverySink("Main", jobId => {
			mainDeliveries.push(jobId);
		});

		manager.register("bash", "owned", async () => "ok", { id: "owned-1", ownerId: "Main" });
		manager.register("bash", "unowned", async () => "ok", { id: "unowned-1" });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });

		expect(mainDeliveries).toEqual(["owned-1"]);
		expect(defaultDeliveries).toEqual(["unowned-1"]);
	});

	test("dead-letters an owned delivery when its owner has no live sink", async () => {
		const defaultDeliveries: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				defaultDeliveries.push(jobId);
			},
		});
		const unregister = manager.registerDeliverySink("Sub", () => {});
		unregister();

		manager.register("bash", "orphan", async () => "orphan result", { id: "orphan-1", ownerId: "Sub" });
		await manager.waitForAll();
		const drained = await manager.drainDeliveries({ timeoutMs: 500 });

		// Dead-letter drops the delivery (drain settles) without misrouting it
		// into the default sink; the outcome stays readable on the job row.
		expect(drained).toBe(true);
		expect(defaultDeliveries).toEqual([]);
		expect(manager.getJob("orphan-1")?.resultText).toBe("orphan result");
	});

	test("keeps plain registration while a managed task blocks and rehydrates only for its exact owner session", async () => {
		const digest = `sha256:${"a".repeat(64)}` as `sha256:${string}`;
		const ownerCore = {
			schemaVersion: 1 as const,
			ownerId: "Main",
			ownerSessionId: "session-a",
			ownerSessionGenerationSha256: digest,
			deliveryEpoch: 7,
		};
		const ownerSessionIndex = {
			...ownerCore,
			indexSha256: `sha256:${createHash("sha256")
				.update(JSON.stringify(["async-job-owner-session-index", ownerCore]), "utf8")
				.digest("hex")}` as `sha256:${string}`,
		};
		let recoveryRecord: { readonly recoveryRecordSha256: string } | undefined;
		let enumerated = 0;
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const bound = manager.bindTransientTaskParentResultDeliveryStore({
			ownerSessionIndex,
			store: {
				detachedSettlement: {
					prepareAsyncJobRecovery: async (request: {
						readonly record: { readonly recoveryRecordSha256: string };
					}) => {
						recoveryRecord = request.record;
						return { status: "prepared", record: request.record } as never;
					},
					transitionAsyncJobRecovery: async (request: {
						readonly record: { readonly recoveryRecordSha256: string };
					}) => {
						recoveryRecord = request.record;
						return { status: "transitioned", record: request.record } as never;
					},
					enumerateAsyncJobRecovery: async (_request: unknown) => {
						enumerated++;
						return {
							status: "matching",
							entries: [{ jobId: "managed-1", recoveryRecordSha256: recoveryRecord!.recoveryRecordSha256 }],
						} as never;
					},
					inspectAsyncJobRecovery: async (_request: unknown) =>
						({ status: "terminal", terminalReceiptSha256: digest }) as never,
				},
			},
		} as never);
		expect(bound.status).toBe("bound");

		const plainJobId = manager.register("bash", "plain", async () => "plain result");
		const attempt = {
			attemptSha256: digest,
			operation: { request: { identity: { identitySha256: digest }, settlementRequestSha256: digest } },
		};
		const managedJobId = manager.registerTransientTask(
			"managed",
			async context => {
				await context.freezeSettlementRecovery({
					attempt,
					terminalStatus: "completed",
					text: "managed result",
					jobErrorTextUtf8: null,
					parentDeliveryRequest: {},
					inspectRequest: {},
				} as never);
				return {
					state: "blocked_indeterminate",
					cancellationPolicy: "reject_preserve_block",
					jobType: "task",
					ownerId: "Main",
					jobId: context.jobId,
					blockedAt: new Date().toISOString(),
					terminalStatus: "completed",
					text: "managed result",
					jobErrorTextUtf8: null,
					attempt,
					notAppliedReceipt: null,
					inspectRequest: {},
					blockSha256: digest,
				} as never;
			},
			{
				id: "managed-1",
				agentId: "Worker",
				...ownerCore,
			},
		);

		await manager.getJob(plainJobId)!.promise;
		await manager.getJob(managedJobId)!.promise;
		expect(manager.getJob(plainJobId)).toMatchObject({ status: "completed", resultText: "plain result" });
		expect(manager.getJob(managedJobId)).toMatchObject({
			status: "running",
			transientTaskSettlementManaged: true,
		});
		expect(manager.cancel(managedJobId)).toBe(false);

		const wrongOwner = { ...ownerSessionIndex, ownerSessionId: "session-b" };
		expect(
			await manager.rehydrateTransientTaskSettlements({
				ownerSessionIndex: wrongOwner,
				requestedAt: new Date().toISOString(),
			}),
		).toEqual([{ status: "session_mismatch" }]);
		expect(enumerated).toBe(0);

		expect(
			await manager.rehydrateTransientTaskSettlements({ ownerSessionIndex, requestedAt: new Date().toISOString() }),
		).toEqual([{ status: "terminal", terminalReceiptSha256: digest }]);
		expect(enumerated).toBe(1);
	});

	test("waitForOwnerJobs settles cancelled jobs and skips suppressed ones on request", async () => {
		const manager = new AsyncJobManager({});
		manager.register(
			"bash",
			"hung",
			async ({ signal }) => {
				await new Promise<void>(resolve => {
					if (signal.aborted) return resolve();
					signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return "stopped";
			},
			{ id: "hung-1", ownerId: "Sub" },
		);

		// Quiescence-barrier contract: a watched (suppressed) job can never
		// re-wake a run, so the filtered wait treats it as settled.
		manager.watchJobs(["hung-1"]);
		await expect(manager.waitForOwnerJobs("Sub", { excludeSuppressed: true })).resolves.toBe(true);

		// Teardown-reap contract: the unfiltered wait blocks until the
		// cancelled job's body actually finishes.
		const reap = manager.waitForOwnerJobs("Sub", { timeoutMs: 1_000 });
		manager.cancelAll({ ownerId: "Sub" });
		await expect(reap).resolves.toBe(true);
		expect(manager.getJob("hung-1")?.status).toBe("cancelled");
	});

	test("notifies only after a durable managed handoff row is present", async () => {
		const managed: string[] = [];
		const manager = new AsyncJobManager({});
		const ownerSessionIndex = managedOwnerIndex();
		const rows = new Map<string, ManagedRecoveryTestRecord>();
		manager.registerManagedCompletionSink("Main", row => {
			managed.push(row.jobId);
			return committedManagedHandoff(row);
		});
		bindManagedRecoveryStore(manager, ownerSessionIndex, rows);

		await manager.rehydrateTransientTaskSettlements({
			ownerSessionIndex,
			requestedAt: "2026-01-01T00:00:01.000Z",
		});
		expect(managed).toEqual([]);

		rows.set("live-managed-1", managedRecord(ownerSessionIndex, "live-managed-1", "frozen result", 1));
		await manager.rehydrateTransientTaskSettlements({
			ownerSessionIndex,
			requestedAt: "2026-01-01T00:00:02.000Z",
		});

		expect(managed).toEqual(["live-managed-1"]);
		expect(await manager.inspectSettledRow({ jobId: "live-managed-1", ownerId: "Main" })).toMatchObject({
			status: "settled",
		});
	});

	test("rehydrates retained handoffs in durable source order", async () => {
		const manager = new AsyncJobManager({});
		const ownerSessionIndex = managedOwnerIndex();
		const rows = new Map([
			["first", managedRecord(ownerSessionIndex, "first", "one", 1)],
			["second", managedRecord(ownerSessionIndex, "second", "two", 2)],
		]);
		const delivered: string[] = [];
		manager.registerManagedCompletionSink("Main", row => {
			delivered.push(row.jobId);
			return committedManagedHandoff(row);
		});
		bindManagedRecoveryStore(manager, ownerSessionIndex, rows);

		await manager.rehydrateTransientTaskSettlements({ ownerSessionIndex, requestedAt: "2026-01-01T00:00:01.000Z" });
		expect(delivered).toEqual(["first", "second"]);
	});

	test("keeps an explicitly not-applied handoff at the owner queue head", async () => {
		const manager = new AsyncJobManager({});
		const ownerSessionIndex = managedOwnerIndex();
		const rows = new Map([
			["first", managedRecord(ownerSessionIndex, "first", "one", 1)],
			["second", managedRecord(ownerSessionIndex, "second", "two", 2)],
		]);
		bindManagedRecoveryStore(manager, ownerSessionIndex, rows);
		await manager.rehydrateTransientTaskSettlements({ ownerSessionIndex, requestedAt: "2026-01-01T00:00:01.000Z" });

		const firstAttempt = Promise.withResolvers<void>();
		const attempted: string[] = [];
		const release = manager.registerManagedCompletionSink("Main", row => {
			attempted.push(row.jobId);
			firstAttempt.resolve();
			return notAppliedManagedHandoff(row);
		});
		await firstAttempt.promise;
		await Promise.resolve();
		expect(attempted).toEqual(["first"]);
		await release();

		const delivered: string[] = [];
		const drained = Promise.withResolvers<void>();
		const rebound = manager.registerManagedCompletionSink("Main", row => {
			delivered.push(row.jobId);
			if (delivered.length === 2) drained.resolve();
			return committedManagedHandoff(row);
		});
		await drained.promise;
		expect(delivered).toEqual(["first", "second"]);
		await rebound();
	});

	test("retries an ambiguously rejected handoff idempotently before later work", async () => {
		const manager = new AsyncJobManager({});
		const ownerSessionIndex = managedOwnerIndex();
		const rows = new Map([
			["first", managedRecord(ownerSessionIndex, "first", "one", 1)],
			["second", managedRecord(ownerSessionIndex, "second", "two", 2)],
		]);
		bindManagedRecoveryStore(manager, ownerSessionIndex, rows);
		await manager.rehydrateTransientTaskSettlements({ ownerSessionIndex, requestedAt: "2026-01-01T00:00:01.000Z" });

		const committed = new Set<string>();
		let effectCount = 0;
		const ambiguousAttempt = Promise.withResolvers<void>();
		const release = manager.registerManagedCompletionSink("Main", row => {
			if (!committed.has(row.transientTaskCompletion.handoffSha256)) {
				committed.add(row.transientTaskCompletion.handoffSha256);
				effectCount += 1;
			}
			ambiguousAttempt.resolve();
			throw new Error("commit acknowledgement lost");
		});
		await ambiguousAttempt.promise;
		await release();

		const delivered: string[] = [];
		const drained = Promise.withResolvers<void>();
		const rebound = manager.registerManagedCompletionSink("Main", row => {
			if (!committed.has(row.transientTaskCompletion.handoffSha256)) {
				committed.add(row.transientTaskCompletion.handoffSha256);
				effectCount += 1;
			}
			delivered.push(row.jobId);
			if (delivered.length === 2) drained.resolve();
			return committedManagedHandoff(row);
		});
		await drained.promise;
		expect(delivered).toEqual(["first", "second"]);
		expect(effectCount).toBe(2);
		await rebound();
	});

	test("fences the exact managed sink binding before allowing replacement", async () => {
		const manager = new AsyncJobManager({});
		const ownerSessionIndex = managedOwnerIndex();
		const rows = new Map([["retained", managedRecord(ownerSessionIndex, "retained", "one", 1)]]);
		bindManagedRecoveryStore(manager, ownerSessionIndex, rows);
		await manager.rehydrateTransientTaskSettlements({ ownerSessionIndex, requestedAt: "2026-01-01T00:00:01.000Z" });

		const oldStarted = Promise.withResolvers<void>();
		const oldGate = Promise.withResolvers<void>();
		const release = manager.registerManagedCompletionSink("Main", async row => {
			oldStarted.resolve();
			await oldGate.promise;
			return committedManagedHandoff(row);
		});
		await oldStarted.promise;
		const fence = release();
		expect(() => manager.registerManagedCompletionSink("Main", committedManagedHandoff)).toThrow(
			"Managed completion sink is already registered for owner: Main",
		);
		oldGate.resolve();
		await fence;

		const replacementDelivered = Promise.withResolvers<void>();
		const rebound = manager.registerManagedCompletionSink("Main", row => {
			replacementDelivered.resolve();
			return committedManagedHandoff(row);
		});
		await release();
		expect(() => manager.registerManagedCompletionSink("Main", committedManagedHandoff)).toThrow(
			"Managed completion sink is already registered for owner: Main",
		);
		await replacementDelivered.promise;
		await rebound();
	});

	test("dispose fences managed replay and rejects later registration", async () => {
		const manager = new AsyncJobManager({});
		const ownerSessionIndex = managedOwnerIndex();
		const rows = new Map([["retained", managedRecord(ownerSessionIndex, "retained", "one", 1)]]);
		bindManagedRecoveryStore(manager, ownerSessionIndex, rows);
		await manager.rehydrateTransientTaskSettlements({ ownerSessionIndex, requestedAt: "2026-01-01T00:00:01.000Z" });

		const callbackStarted = Promise.withResolvers<void>();
		const callbackGate = Promise.withResolvers<void>();
		let callbackFinished = false;
		manager.registerManagedCompletionSink("Main", async row => {
			callbackStarted.resolve();
			await callbackGate.promise;
			callbackFinished = true;
			return committedManagedHandoff(row);
		});
		await callbackStarted.promise;
		let disposeSettled = false;
		const disposing = manager.dispose({ timeoutMs: 1_000 }).then(result => {
			disposeSettled = true;
			return result;
		});
		await Promise.resolve();
		expect(disposeSettled).toBe(false);
		callbackGate.resolve();
		expect(await disposing).toBe(true);
		expect(callbackFinished).toBe(true);
		expect(() => manager.registerManagedCompletionSink("Main", committedManagedHandoff)).toThrow(
			"Async job manager is disposed",
		);
	});

	test("fails closed without mutating an unrelated colliding job", async () => {
		const manager = new AsyncJobManager({});
		const foreignId = manager.register("bash", "foreign", async () => "foreign result", {
			id: "collision",
			ownerId: "Other",
			agentId: "Other",
		});
		await manager.getJob(foreignId)!.promise;
		const foreign = manager.getJob(foreignId)!;
		const ownerSessionIndex = managedOwnerIndex();
		const rows = new Map([[foreignId, managedRecord(ownerSessionIndex, foreignId, "managed result", 1)]]);
		bindManagedRecoveryStore(manager, ownerSessionIndex, rows);

		expect(
			await manager.rehydrateTransientTaskSettlements({
				ownerSessionIndex,
				requestedAt: "2026-01-01T00:00:01.000Z",
			}),
		).toEqual([{ status: "conflict" }]);
		expect(manager.getJob(foreignId)).toBe(foreign);
		expect(foreign).toMatchObject({ ownerId: "Other", agentId: "Other", resultText: "foreign result" });
		expect(foreign.transientTaskRecoveryRecord).toBeUndefined();
	});

	test("fails closed on a recovery identity collision for the same managed job", async () => {
		const manager = new AsyncJobManager({});
		const ownerSessionIndex = managedOwnerIndex();
		const original = managedRecord(ownerSessionIndex, "collision", "one", 1);
		const rows = new Map([["collision", original]]);
		bindManagedRecoveryStore(manager, ownerSessionIndex, rows);
		await manager.rehydrateTransientTaskSettlements({ ownerSessionIndex, requestedAt: "2026-01-01T00:00:01.000Z" });
		rows.set("collision", { ...original, recoveryRecordSha256: `sha256:${"b".repeat(64)}` });

		expect(
			await manager.rehydrateTransientTaskSettlements({
				ownerSessionIndex,
				requestedAt: "2026-01-01T00:00:02.000Z",
			}),
		).toEqual([{ status: "conflict" }]);
		expect(manager.getJob("collision")?.transientTaskRecoveryRecord?.recoveryRecordSha256).toBe(SHA);
	});

	test("queues the complete retained snapshot before a live settlement", async () => {
		const manager = new AsyncJobManager({});
		const ownerSessionIndex = managedOwnerIndex();
		const rows = new Map([
			["first", managedRecord(ownerSessionIndex, "first", "one", 1)],
			["second", managedRecord(ownerSessionIndex, "second", "two", 2)],
		]);
		bindManagedRecoveryStore(manager, ownerSessionIndex, rows);
		await manager.rehydrateTransientTaskSettlements({ ownerSessionIndex, requestedAt: "2026-01-01T00:00:01.000Z" });

		const firstStarted = Promise.withResolvers<void>();
		const firstGate = Promise.withResolvers<void>();
		const delivered: string[] = [];
		const release = manager.registerManagedCompletionSink("Main", async row => {
			delivered.push(row.jobId);
			if (row.jobId === "first") {
				firstStarted.resolve();
				await firstGate.promise;
			}
			return committedManagedHandoff(row);
		});
		await firstStarted.promise;
		const live = managedRecord(ownerSessionIndex, "live", "three", 3);
		rows.set("live", live);
		const liveResume = manager.resumeTransientTaskSettlement({
			ownerSessionIndex,
			jobId: "live",
			expectedRecoveryRecordSha256: SHA,
			requestedAt: "2026-01-01T00:00:02.000Z",
		});
		await Promise.resolve();
		await Promise.resolve();
		firstGate.resolve();
		expect(await liveResume).toMatchObject({ status: "settled" });
		expect(delivered).toEqual(["first", "second", "live"]);
		await release();
	});

	test("reclaims delivered digests only after safe managed eviction", async () => {
		const manager = new AsyncJobManager({});
		const ownerSessionIndex = managedOwnerIndex();
		const rows = new Map([["reclaim", managedRecord(ownerSessionIndex, "reclaim", "one", 1)]]);
		const terminalJobIds = new Set<string>();
		bindManagedRecoveryStore(manager, ownerSessionIndex, rows, { terminalJobIds });

		let deliveryCount = 0;
		const firstRelease = manager.registerManagedCompletionSink("Main", row => {
			deliveryCount += 1;
			return committedManagedHandoff(row);
		});
		await manager.rehydrateTransientTaskSettlements({ ownerSessionIndex, requestedAt: "2026-01-01T00:00:01.000Z" });
		expect(deliveryCount).toBe(1);
		await firstRelease();

		terminalJobIds.add("reclaim");
		expect(
			await manager.reconcileTransientTaskSessionCutover({
				ownerSessionIndex,
				requestedAt: "2026-01-01T00:00:02.000Z",
			}),
		).toEqual({ status: "ready", evictedTerminalJobIds: ["reclaim"] });
		terminalJobIds.delete("reclaim");
		await manager.rehydrateTransientTaskSettlements({ ownerSessionIndex, requestedAt: "2026-01-01T00:00:03.000Z" });

		const replayed = Promise.withResolvers<void>();
		const secondRelease = manager.registerManagedCompletionSink("Main", row => {
			deliveryCount += 1;
			replayed.resolve();
			return committedManagedHandoff(row);
		});
		await replayed.promise;
		expect(deliveryCount).toBe(2);
		await secondRelease();
	});

	test("never notifies managed sinks for cancelled durable rows", async () => {
		const manager = new AsyncJobManager({});
		const ownerSessionIndex = managedOwnerIndex();
		const rows = new Map([["cancelled", managedRecord(ownerSessionIndex, "cancelled", "cancelled", 1, "cancelled")]]);
		const delivered: string[] = [];
		manager.registerManagedCompletionSink("Main", row => {
			delivered.push(row.jobId);
			return committedManagedHandoff(row);
		});
		bindManagedRecoveryStore(manager, ownerSessionIndex, rows);

		await manager.rehydrateTransientTaskSettlements({
			ownerSessionIndex,
			requestedAt: "2026-01-01T00:00:01.000Z",
		});

		expect(delivered).toEqual([]);
		expect(await manager.inspectSettledRow({ jobId: "cancelled", ownerId: "Main" })).toMatchObject({
			status: "settled",
		});
	});
});

describe("AsyncJobManager smart poll-wait escalation", () => {
	const newManager = () => new AsyncJobManager({ onJobComplete: async () => {} });

	test("first poll waits the ladder floor", () => {
		const m = newManager();
		expect(m.nextPollWaitMs("Main", 1_000)).toBe(5_000);
		// A fresh owner also starts at the floor.
		expect(m.nextPollWaitMs("Other", 1_000)).toBe(5_000);
	});

	test("back-to-back polls climb the ladder to the top rung", () => {
		const m = newManager();
		const owner = "Main";
		const t = 1_000;
		const waits: number[] = [];
		for (let i = 0; i < 6; i++) {
			// Same timestamp every time → zero gap → always escalates.
			waits.push(m.nextPollWaitMs(owner, t));
			m.recordPollWaitEnd(owner, t);
		}
		// Climbs the rungs, then saturates at the top.
		expect(waits).toEqual([5_000, 10_000, 30_000, 60_000, 300_000, 300_000]);
	});

	test("a quiet gap of a minute resets back to the floor", () => {
		const m = newManager();
		const owner = "Main";

		expect(m.nextPollWaitMs(owner, 0)).toBe(5_000);
		m.recordPollWaitEnd(owner, 0);

		// Still within the reset window (just under a minute) → keeps climbing.
		expect(m.nextPollWaitMs(owner, 59_999)).toBe(10_000);
		m.recordPollWaitEnd(owner, 60_000);

		// A full minute without polling resets the climb to the floor.
		expect(m.nextPollWaitMs(owner, 120_000)).toBe(5_000);
	});

	test("escalation is tracked independently per owner", () => {
		const m = newManager();
		const t = 1_000;

		m.nextPollWaitMs("A", t);
		m.recordPollWaitEnd("A", t);
		m.nextPollWaitMs("A", t);
		m.recordPollWaitEnd("A", t);

		// A fresh owner starts at the floor regardless of A's escalation.
		expect(m.nextPollWaitMs("B", t)).toBe(5_000);
		// A keeps climbing from where it left off.
		expect(m.nextPollWaitMs("A", t)).toBe(30_000);
	});
});
