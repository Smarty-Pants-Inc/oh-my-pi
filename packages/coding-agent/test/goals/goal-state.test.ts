import { describe, expect, it } from "bun:test";
import { type GoalStatus, isGoalEnabledStatus, parseGoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";

function persistedGoal(status: string): Record<string, unknown> {
	return {
		id: "goal-1",
		objective: "Ship it",
		status,
		tokenBudget: 100,
		tokensUsed: 25,
		timeUsedSeconds: 12,
		createdAt: 1,
		updatedAt: 2,
	};
}

describe("persisted goal state", () => {
	it("restores every current canonical state without changing identity or accounting", () => {
		const statuses: GoalStatus[] = ["active", "paused", "blocked", "budget_limited", "usage_limited"];

		for (const status of statuses) {
			const restored = parseGoalModeState(status === "paused" ? "goal_paused" : "goal", {
				goal: persistedGoal(status),
			});
			expect(restored?.goal).toMatchObject({
				id: "goal-1",
				status,
				tokenBudget: 100,
				tokensUsed: 25,
				timeUsedSeconds: 12,
			});
			expect(restored?.enabled).toBe(isGoalEnabledStatus(status));
		}
	});

	it("migrates legacy hyphenated status values deterministically", () => {
		const budgetLimited = parseGoalModeState("goal", { goal: persistedGoal("budget-limited") });
		expect(budgetLimited?.goal.status).toBe("budget_limited");
		expect(budgetLimited?.enabled).toBe(true);
		expect(parseGoalModeState("goal", { goal: persistedGoal("usage-limited") })?.goal.status).toBe("usage_limited");
	});

	it("does not reactivate a persisted paused goal when its mode marker disagrees", () => {
		expect(parseGoalModeState("goal", { goal: persistedGoal("paused") })).toBeUndefined();
		expect(parseGoalModeState("goal_paused", { goal: persistedGoal("active") })).toBeUndefined();
	});

	it("keeps terminal goal history out of the current projection", () => {
		for (const status of ["complete", "dropped", "superseded"] as const) {
			expect(parseGoalModeState("goal", { goal: persistedGoal(status) })).toBeUndefined();
		}
	});
});
