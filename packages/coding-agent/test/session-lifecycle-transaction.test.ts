import { describe, expect, it, vi } from "bun:test";
import type { SessionLifecycleOwnership } from "@oh-my-pi/pi-coding-agent/session/session-lifecycle-owner";
import { SessionLifecycleTransaction } from "@oh-my-pi/pi-coding-agent/session/session-lifecycle-transaction";

function ownership(): SessionLifecycleOwnership {
	return {
		ready: async () => {},
		quarantineBash: async () => {},
		acquire: async () => {},
		markTarget: () => {},
		prepareCommit: async () => {},
		selectCommit: async () => {},
		activateCommit: async () => {},
		prepareRollback: async () => {},
		selectRollback: async () => {},
		activateRollback: async () => {},
	};
}

describe("SessionLifecycleTransaction resource binding", () => {
	it("registers the commit side and settles with the lifecycle fence", async () => {
		const commit = vi.fn();
		const rollback = vi.fn();
		const release = vi.fn();
		const activateFence = vi.fn();
		const transaction = new SessionLifecycleTransaction({
			captureRetainedCheckpoint: async () => ({ restore: async () => {} }),
			beginOwnership: ownership,
			activateFence,
		});
		transaction.bindResource("artifact", { commit, rollback, release });
		await transaction.captureRetained();
		await transaction.acquireOwnership();
		transaction.markTarget();
		await transaction.commit();

		await expect(transaction.settled).resolves.toBeUndefined();
		expect(commit).toHaveBeenCalledTimes(1);
		expect(rollback).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
		expect(activateFence).toHaveBeenCalledTimes(1);
	});

	it("keeps rollback cleanup and release paired with the same resource", async () => {
		const order: string[] = [];
		const transaction = new SessionLifecycleTransaction({
			captureRetainedCheckpoint: async () => ({
				restore: async () => {
					order.push("restore");
				},
			}),
			beginOwnership: ownership,
			activateFence: () => {
				order.push("fence");
			},
		});
		transaction.bindResource("artifact", {
			commit: () => {
				order.push("commit");
			},
			rollback: () => {
				order.push("rollback");
			},
			release: () => {
				order.push("release");
			},
		});
		await transaction.captureRetained();
		await transaction.acquireOwnership();
		transaction.markTarget();
		await transaction.rollback({ cause: new Error("target failed"), message: "rollback failed" });

		expect(order).toEqual(["rollback", "restore", "release", "fence"]);
	});
});
