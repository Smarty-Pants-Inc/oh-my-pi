import { afterEach, describe, expect, test, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { logger } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

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

	test("delivers a synchronous run failure to its owning session", async () => {
		const ownerDeliveries: Array<{ jobId: string; text: string }> = [];
		const defaultDeliveries: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			onJobComplete: (jobId, text) => {
				defaultDeliveries.push({ jobId, text });
			},
		});
		manager.registerDeliverySink("owner-session", (jobId, text) => {
			ownerDeliveries.push({ jobId, text });
		});

		const jobId = manager.register(
			"task",
			"synchronous failure",
			() => {
				throw new Error("synchronous failure");
			},
			{ ownerId: "owner-session" },
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(ownerDeliveries).toEqual([{ jobId, text: "synchronous failure" }]);
		expect(defaultDeliveries).toEqual([]);
		expect(manager.getJob(jobId)).toMatchObject({ status: "failed", errorText: "synchronous failure" });
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

	test("bounds owner-job reap while preserving late settlement", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		const release = Promise.withResolvers<void>();
		const jobId = manager.register(
			"task",
			"ignores abort",
			async () => {
				await release.promise;
				return "late result";
			},
			{ ownerId: "owner" },
		);

		const reap = await manager.cancelAndReapOwnerJobs("owner", Date.now());

		expect(reap.settled).toBe(false);
		expect(reap.pendingJobIds).toEqual([jobId]);
		expect(manager.getJob(jobId)?.status).toBe("cancelled");

		release.resolve();
		await reap.completion;
		expect(manager.getJob(jobId)?.resultText).toBe("late result");
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

	test("does not evict or misroute a replacement when a discarded job later settles", async () => {
		const oldStarted = Promise.withResolvers<void>();
		const releaseOld = Promise.withResolvers<void>();
		const releaseReplacement = Promise.withResolvers<void>();
		const oldDeliveries: string[] = [];
		const replacementDeliveries: Array<{ jobId: string; text: string; ownerId: string | undefined }> = [];
		const manager = new AsyncJobManager({ retentionMs: 0 });
		manager.registerDeliverySink("old-owner", jobId => {
			oldDeliveries.push(jobId);
			return;
		});
		manager.registerDeliverySink("replacement-owner", (jobId, text, job) => {
			replacementDeliveries.push({ jobId, text, ownerId: job?.ownerId });
			return;
		});

		const jobId = manager.register(
			"bash",
			"old job",
			async () => {
				oldStarted.resolve();
				await releaseOld.promise;
				return "old result";
			},
			{ id: "reused-job", ownerId: "old-owner" },
		);
		await oldStarted.promise;
		const oldJob = manager.getJob(jobId);
		if (!oldJob) throw new Error("Old job was not registered");

		expect(manager.discardJobs([oldJob])).toBe(0);
		expect(manager.getJob(jobId)).toBeUndefined();
		const replacementJobId = manager.register(
			"bash",
			"replacement job",
			async () => {
				await releaseReplacement.promise;
				return "replacement result";
			},
			{ id: jobId, ownerId: "replacement-owner" },
		);
		expect(replacementJobId).toBe(jobId);

		releaseOld.resolve();
		await oldJob.promise;
		expect(manager.getJob(replacementJobId)?.status).toBe("running");

		releaseReplacement.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });

		expect(oldDeliveries).toEqual([]);
		expect(replacementDeliveries).toEqual([
			{ jobId: replacementJobId, text: "replacement result", ownerId: "replacement-owner" },
		]);
	});

	test("requeues a deferred delivery while the same job object remains registered", async () => {
		const deliveries: string[] = [];
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		manager.registerDeliverySink("owner", (_jobId, text) => {
			deliveries.push(text);
		});

		const jobId = manager.register("task", "same object", async () => "initial result", {
			id: "same-object-replay",
			ownerId: "owner",
		});
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		const job = manager.getJob(jobId);
		if (!job) throw new Error("Expected completed job to remain registered");

		expect(manager.requeueDelivery(job, "replayed result")).toBe(true);
		await manager.drainDeliveries({ timeoutMs: 500 });

		expect(deliveries).toEqual(["initial result", "replayed result"]);
		expect(manager.getJob(jobId)).toBe(job);
	});

	test("dead-letters a deferred delivery when its job id now belongs to a replacement", async () => {
		const oldDeliveryStarted = Promise.withResolvers<void>();
		const releaseOldDelivery = Promise.withResolvers<void>();
		const releaseReplacement = Promise.withResolvers<string>();
		const staleRetryDeadLettered = Promise.withResolvers<void>();
		const warn = vi.spyOn(logger, "warn").mockImplementation(message => {
			if (message === "Async job delivery dead-lettered after failure: stale job identity") {
				staleRetryDeadLettered.resolve();
			}
		});
		const oldDeliveries: string[] = [];
		const replacementDeliveries: string[] = [];
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		manager.registerDeliverySink("old-owner", async (_jobId, text) => {
			oldDeliveries.push(text);
			oldDeliveryStarted.resolve();
			await releaseOldDelivery.promise;
			throw new Error("force deferred delivery replay");
		});
		manager.registerDeliverySink("replacement-owner", (_jobId, text) => {
			replacementDeliveries.push(text);
		});

		const jobId = manager.register("task", "old job", async () => "old result", {
			id: "reused-deferred-job",
			ownerId: "old-owner",
		});
		const oldJob = manager.getJob(jobId);
		if (!oldJob) throw new Error("Expected old job to be registered");
		await oldDeliveryStarted.promise;
		expect(manager.discardJobs([oldJob], { ownerId: "old-owner" })).toBe(1);

		const replacementJobId = manager.register("task", "replacement job", () => releaseReplacement.promise, {
			id: jobId,
			ownerId: "replacement-owner",
		});
		const replacementJob = manager.getJob(replacementJobId);
		if (!replacementJob) throw new Error("Expected replacement job to be registered");
		expect(replacementJobId).toBe(jobId);

		// The transition replay owns the old object, not merely its reusable id.
		expect(manager.requeueDelivery(oldJob, "stale replay text")).toBe(false);
		releaseOldDelivery.resolve();
		await staleRetryDeadLettered.promise;
		warn.mockRestore();

		expect(oldDeliveries).toEqual(["old result"]);
		expect(replacementDeliveries).toEqual([]);
		expect(manager.getJob(jobId)).toBe(replacementJob);
		expect(replacementJob.status).toBe("running");

		releaseReplacement.resolve("replacement result");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(replacementDeliveries).toEqual(["replacement result"]);
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
	test("counts filtered job state without materializing snapshots", async () => {
		const runningGate = Promise.withResolvers<void>();
		const deliveryGate = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		manager.registerDeliverySink("Main", async () => {
			await deliveryGate.promise;
		});
		const runningId = manager.register(
			"bash",
			"still running",
			async () => {
				await runningGate.promise;
				return "done";
			},
			{ ownerId: "Main" },
		);
		const failedId = manager.register(
			"task",
			"failed",
			async () => {
				throw new Error("failed");
			},
			{ ownerId: "Main" },
		);
		manager.register(
			"task",
			"other owner",
			async () => {
				throw new Error("other failure");
			},
			{ ownerId: "Other" },
		);
		await manager.getJob(failedId)?.promise;

		const ownerFilter = { ownerId: "Main" };
		expect(manager.countRunningJobs(ownerFilter)).toBe(1);
		expect(manager.countRecentFailures(5, ownerFilter)).toBe(1);
		expect(manager.countPendingDeliveries(ownerFilter)).toBe(1);
		const runningJob = manager.getJob(runningId);
		if (!runningJob) throw new Error("expected running job");
		expect(manager.countRunningJobs({ ...ownerFilter, excludeJobs: new Set([runningJob]) })).toBe(0);

		runningGate.resolve();
		deliveryGate.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
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
