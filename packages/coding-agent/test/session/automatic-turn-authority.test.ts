import { describe, expect, it } from "bun:test";
import { AutomaticTurnAuthority } from "../../src/session/automatic-turn-authority";

describe("automatic turn authority", () => {
	it("allows only a still-open asynchronous origin", () => {
		const authority = new AutomaticTurnAuthority();
		expect(authority.authorize("active_async_result_wake", "missing")).toBe(false);
		const origin = authority.openTurn();
		expect(authority.authorize("active_async_result_wake", origin)).toBe(true);
		authority.closeTurn(origin);
		expect(authority.authorize("active_async_result_wake", origin)).toBe(false);
		expect(authority.outcomes().map(outcome => outcome.status)).toEqual(["rejected", "accepted", "rejected"]);
	});

	it("allows registered peer-message wakes without an asynchronous origin", () => {
		const authority = new AutomaticTurnAuthority();
		expect(authority.authorize("peer_message_wake")).toBe(true);
		expect(authority.outcomes()).toEqual([
			expect.objectContaining({ source: "peer_message_wake", status: "accepted" }),
		]);
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
