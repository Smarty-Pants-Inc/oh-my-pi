import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { Sha256Ref } from "../../src/registry/persistent-agent-contracts.js";
import {
	buildTransientTaskHubWaitMessageCanonicalRecordV1,
	hashTransientTaskHubWaitMessageCanonicalRecordV1,
	TRANSIENT_TASK_HUB_WAIT_MESSAGE_CANONICAL_RECORD_KINDS_V1,
	validateTransientTaskHubWaitMessageCanonicalRecordV1,
} from "../../src/session/workspace-runtime-contracts.js";

const sha256Ref = (character: string): Sha256Ref => `sha256:${character.repeat(64)}`;

describe("Hub wait canonical records", () => {
	it("builds and validates the frozen winner key tuple", () => {
		const core = {
			schemaVersion: 1,
			hubWaitInvocationId: "hub-wait-1",
			ownerId: "owner-1",
			senderId: "sender-1",
			fromFilter: null,
			watchedJobIds: ["job-1", "job-2"],
			returnTargetSha256: sha256Ref("a"),
		} as const;
		const record = buildTransientTaskHubWaitMessageCanonicalRecordV1("winner-key", core);
		const tuple = [
			"omp-hub-wait-message-winner-v1",
			"key",
			1,
			core.hubWaitInvocationId,
			core.ownerId,
			core.senderId,
			core.fromFilter,
			core.watchedJobIds,
			core.returnTargetSha256,
		] as const;
		const expectedDigest: Sha256Ref = `sha256:${createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex")}`;

		expect(record).toEqual(core);
		expect(Object.isFrozen(record)).toBe(true);
		expect(validateTransientTaskHubWaitMessageCanonicalRecordV1("winner-key", record)).toBe(true);
		expect(hashTransientTaskHubWaitMessageCanonicalRecordV1("winner-key", record)).toBe(expectedDigest);
		expect(
			validateTransientTaskHubWaitMessageCanonicalRecordV1("winner-key", {
				...record,
				watchedJobIds: ["job-1", "job-1"],
			}),
		).toBe(false);
	});

	it("seals consumed-message bytes and rejects mutations or extra fields", () => {
		const core = {
			schemaVersion: 1,
			id: "message-1",
			from: "peer-1",
			to: "sender-1",
			body: "frozen payload",
			ts: 1_800_000_000_000,
			replyTo: null,
		} as const;
		const record = buildTransientTaskHubWaitMessageCanonicalRecordV1("consumed-message", core);

		expect(record.messageSha256).toBe(hashTransientTaskHubWaitMessageCanonicalRecordV1("consumed-message", core));
		expect(Object.isFrozen(record)).toBe(true);
		expect(validateTransientTaskHubWaitMessageCanonicalRecordV1("consumed-message", record)).toBe(true);
		expect(
			validateTransientTaskHubWaitMessageCanonicalRecordV1("consumed-message", {
				...record,
				body: "mutated payload",
			}),
		).toBe(false);
		expect(
			validateTransientTaskHubWaitMessageCanonicalRecordV1("consumed-message", {
				...record,
				extra: true,
			}),
		).toBe(false);
	});

	it("publishes every controller-owned Hub wait record family", () => {
		expect(TRANSIENT_TASK_HUB_WAIT_MESSAGE_CANONICAL_RECORD_KINDS_V1).toEqual(
			expect.arrayContaining([
				"return-target-registration-request",
				"return-target-registration-receipt",
				"preselection-recovery-ref",
				"preselection-enumeration",
				"preselection-inspection",
				"preselection-adopt-request",
				"preselection-adoption-receipt",
				"return-delivery-request",
				"return-delivery-receipt",
				"send-await-outbound-state",
				"return-block",
				"return-target-retirement-request",
				"return-target-retirement-receipt",
				"retired-plan-adopt-request",
				"retired-plan-adoption-receipt",
			]),
		);
	});
});
