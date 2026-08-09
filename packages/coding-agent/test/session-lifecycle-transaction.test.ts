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
	it("seals before host completion and finalizes exactly once after acknowledgement", async () => {
		const seal = vi.fn();
		const finalize = vi.fn();
		const rollback = vi.fn();
		const release = vi.fn();
		const activateFence = vi.fn();
		const transaction = new SessionLifecycleTransaction({
			captureRetainedCheckpoint: async () => ({ restore: async () => {} }),
			beginOwnership: ownership,
			activateFence,
		});
		transaction.bindResource("artifact", { seal, finalize, rollback, release });
		await transaction.captureRetained();
		await transaction.acquireOwnership();
		transaction.markTarget();
		const activate = await transaction.prepareCommit();

		expect(seal).toHaveBeenCalledTimes(1);
		expect(finalize).not.toHaveBeenCalled();
		expect(activateFence).not.toHaveBeenCalled();
		await Promise.all([activate(), transaction.activateCommitAfterHostPublication()]);

		await expect(transaction.settled).resolves.toBeUndefined();
		expect(finalize).toHaveBeenCalledTimes(1);
		expect(rollback).not.toHaveBeenCalled();
		expect(release).not.toHaveBeenCalled();
		expect(activateFence).toHaveBeenCalledTimes(1);
	});

	it("rolls back sealed resources and releases their fences after host rejection", async () => {
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
			seal: () => {
				order.push("seal");
			},
			finalize: () => {
				order.push("finalize");
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
		await transaction.prepareCommit();
		await transaction.rollback({ cause: new Error("target failed"), message: "rollback failed" });

		expect(order).toEqual(["seal", "rollback", "restore", "release", "fence"]);
	});

	it("recaptures quiesced runtime without asking the host for a second full checkpoint", async () => {
		const recapture = vi.fn(async () => {});
		const captureRetainedCheckpoint = vi.fn(async () => ({ restore: async () => {}, recapture }));
		const transaction = new SessionLifecycleTransaction({
			captureRetainedCheckpoint,
			beginOwnership: ownership,
			activateFence: () => {},
		});

		await transaction.captureRetained({ capturePersistedSessionFile: true });
		await transaction.recaptureRetained({ capturePersistedSessionFile: true });

		expect(captureRetainedCheckpoint).toHaveBeenCalledTimes(1);
		expect(recapture).toHaveBeenCalledTimes(1);
		expect(recapture).toHaveBeenCalledWith({ capturePersistedSessionFile: true });
	});
});
