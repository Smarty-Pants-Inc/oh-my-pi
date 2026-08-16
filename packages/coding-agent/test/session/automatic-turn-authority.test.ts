import { describe, expect, it } from "bun:test";
import { AutomaticTurnAuthority } from "../../src/session/automatic-turn-authority";

describe("automatic turn authority", () => {
	it("allows only a still-open asynchronous origin", () => {
		const authority = new AutomaticTurnAuthority();
		expect(authority.authorize("active_async_result_wake", false)).toBe(false);
		expect(authority.authorize("active_async_result_wake", true)).toBe(true);
		expect(authority.outcomes().map(outcome => outcome.status)).toEqual(["rejected", "accepted"]);
	});

	it("records queue, start, defer, and failure outcomes without conflating them", () => {
		const authority = new AutomaticTurnAuthority();
		authority.record("active_goal_continuation", "accepted", "queued");
		authority.record("active_goal_continuation", "deferred", "user input won");
		authority.record("bounded_transport_or_protocol_retry", "started", "retry committed");
		authority.record("bounded_transport_or_protocol_retry", "failed", "transport failed");

		expect(authority.outcomes()).toEqual([
			{ sequence: 1, source: "active_goal_continuation", status: "accepted", reason: "queued" },
			{ sequence: 2, source: "active_goal_continuation", status: "deferred", reason: "user input won" },
			{
				sequence: 3,
				source: "bounded_transport_or_protocol_retry",
				status: "started",
				reason: "retry committed",
			},
			{
				sequence: 4,
				source: "bounded_transport_or_protocol_retry",
				status: "failed",
				reason: "transport failed",
			},
		]);
	});
});
