import { describe, expect, it } from "bun:test";
import { type GoalStatus, parseGoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";

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
	it("restores every canonical state without changing goal identity or accounting", () => {
		const statuses: GoalStatus[] = [
			"active",
			"paused",
			"blocked",
			"budget_limited",
			"usage_limited",
			"complete",
			"dropped",
			"superseded",
		];

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
		}
	});

	it("migrates legacy hyphenated status values deterministically", () => {
		expect(parseGoalModeState("goal", { goal: persistedGoal("budget-limited") })?.goal.status).toBe("budget_limited");
		expect(parseGoalModeState("goal", { goal: persistedGoal("usage-limited") })?.goal.status).toBe("usage_limited");
	});

	it("does not reactivate a persisted paused goal when its mode marker disagrees", () => {
		expect(parseGoalModeState("goal", { goal: persistedGoal("paused") })).toBeUndefined();
		expect(parseGoalModeState("goal_paused", { goal: persistedGoal("active") })).toBeUndefined();
	});

	it("restores completed state as exiting so it cannot continue", () => {
		expect(parseGoalModeState("goal", { goal: persistedGoal("complete") })).toMatchObject({
			enabled: false,
			mode: "exiting",
			reason: "completed",
			goal: { status: "complete" },
		});
	});
});
