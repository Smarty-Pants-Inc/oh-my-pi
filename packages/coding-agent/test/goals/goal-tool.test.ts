import { describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { completionBudgetReport, GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { Goal, GoalModeState, GoalRuntimeEvent, GoalTokenUsage } from "@oh-my-pi/pi-coding-agent/goals/state";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

function createUsage(overrides: Partial<GoalTokenUsage> = {}): GoalTokenUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		...overrides,
	};
}

function createGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Ship it",
		status: "active",
		tokenBudget: undefined,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function cloneState(state: GoalModeState | undefined): GoalModeState | undefined {
	return state ? { ...state, goal: { ...state.goal } } : undefined;
}

function createToolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		settings: Settings.isolated({ "todo.enabled": false, "todo.reminders": false }),
		...overrides,
	} as ToolSession;
}

function createRuntimeHarness(initialState?: GoalModeState) {
	let state = cloneState(initialState);
	const events: GoalRuntimeEvent[] = [];
	const persists: Array<{ mode: "goal" | "goal_paused" | "none"; state?: GoalModeState }> = [];
	const runtime = new GoalRuntime({
		getState: () => cloneState(state),
		setState: next => {
			state = cloneState(next);
		},
		getCurrentUsage: () => createUsage(),
		emit: async event => {
			events.push(event);
		},
		persist: (mode, persistedState) => {
			persists.push({ mode, state: cloneState(persistedState) });
		},
		sendHiddenMessage: async _message => {},
		now: () => 0,
	});
	return {
		runtime,
		getState: () => cloneState(state),
		setState: (next: GoalModeState | undefined) => {
			state = cloneState(next);
		},
		events,
		persists,
	};
}

describe("GoalTool", () => {
	it("routes create/get/complete operations and returns completion budget details", async () => {
		const createGoalState: GoalModeState = {
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Create route", tokenBudget: 10 }),
		};
		const getGoalState: GoalModeState = {
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Get route", tokensUsed: 4, tokenBudget: 10 }),
		};
		const completedGoal = createGoal({
			objective: "Complete route",
			status: "complete",
			tokensUsed: 7,
			timeUsedSeconds: 3,
			tokenBudget: 10,
		});
		const runtime = {
			createGoal: vi.fn(async () => createGoalState),
			completeGoalFromTool: vi.fn(async () => completedGoal),
		};
		const getGoalModeState = vi.fn(() => getGoalState);
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => runtime as unknown as GoalRuntime,
				getGoalModeState,
			}),
		);

		const created = await tool.execute("call-create", {
			op: "create",
			objective: "  Create route  ",
			token_budget: undefined,
		});
		expect(runtime.createGoal).toHaveBeenCalledWith({ objective: "Create route" });
		expect(created.details).toMatchObject({
			op: "create",
			goal: createGoalState.goal,
			remainingTokens: 10,
			completionBudgetReport: null,
		});

		const fetched = await tool.execute("call-get", { op: "get", objective: undefined, token_budget: undefined });
		expect(getGoalModeState).toHaveBeenCalledTimes(1);
		expect(fetched.details).toMatchObject({
			op: "get",
			goal: getGoalState.goal,
			remainingTokens: 6,
			completionBudgetReport: null,
		});
		expect(runtime.completeGoalFromTool).not.toHaveBeenCalled();

		const completed = await tool.execute("call-complete", {
			op: "complete",
			objective: undefined,
			token_budget: undefined,
		});
		expect(runtime.completeGoalFromTool).toHaveBeenCalledTimes(1);
		expect(completed.details).toMatchObject({
			op: "complete",
			goal: completedGoal,
			remainingTokens: 3,
			completionBudgetReport: completionBudgetReport(completedGoal),
		});
		expect(completed.content[0]).toEqual({
			type: "text",
			text: "Goal: Complete route\nStatus: complete\nTokens: 7 used / 10 budget\nRemaining tokens: 3\n\nGoal achieved. Report final budget usage to the user: tokens used: 7 of 10; time used: 3 seconds.",
		});
	});

	it("creates an unbounded goal when token_budget is omitted", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-create-unbounded", {
			op: "create",
			objective: "Ship without a ceiling",
			token_budget: undefined,
		});

		expect(harness.getState()?.goal.tokenBudget).toBeUndefined();
		expect(result.details).toMatchObject({ remainingTokens: null });
	});

	it("rejects create when a goal already exists", async () => {
		const harness = createRuntimeHarness({
			enabled: true,
			mode: "active",
			goal: createGoal({ objective: "Existing" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(
			tool.execute("call-create", { op: "create", objective: "New goal", token_budget: undefined }),
		).rejects.toThrow("cannot create a new goal because this session already has a goal");
	});

	it("rejects complete when no goal is active", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(
			tool.execute("call-complete", { op: "complete", objective: undefined, token_budget: undefined }),
		).rejects.toThrow("cannot complete goal because no goal is active");
	});

	it("rejects completion before persisting a terminal goal when todo reminders have open work", async () => {
		const harness = createRuntimeHarness();
		await harness.runtime.createGoal({ objective: "Ship the release" });
		const persistedBefore = harness.persists.length;
		const eventsBefore = harness.events.length;
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
				settings: Settings.isolated({ "todo.enabled": true, "todo.reminders": true }),
				isToolActive: name => name === "todo",
				getTodoPhases: () => [
					{
						name: "Verification",
						tasks: [
							{ content: "Run focused checks", status: "in_progress" },
							{ content: "Review results", status: "pending" },
						],
					},
				],
			}),
		);

		let rejection: unknown;
		try {
			await tool.execute("call-complete", {
				op: "complete",
				objective: undefined,
				token_budget: undefined,
			});
		} catch (error) {
			rejection = error;
		}

		expect(rejection).toBeInstanceOf(ToolError);
		expect(rejection).toMatchObject({
			message:
				"goal_completion_blocked_by_open_todos: complete or abandon pending and in-progress todo tasks before completing the goal",
		});
		expect(harness.getState()).toMatchObject({
			enabled: true,
			mode: "active",
			goal: { objective: "Ship the release", status: "active" },
		});
		expect(harness.persists).toHaveLength(persistedBefore);
		expect(harness.persists.at(-1)).toMatchObject({
			mode: "goal",
			state: { enabled: true, mode: "active", goal: { status: "active" } },
		});
		expect(harness.events.slice(eventsBefore)).toEqual([]);
	});

	it("completes with todo reminders when every todo is complete", async () => {
		const harness = createRuntimeHarness();
		await harness.runtime.createGoal({ objective: "Ship the release" });
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
				settings: Settings.isolated({ "todo.enabled": true, "todo.reminders": true }),
				isToolActive: name => name === "todo",
				getTodoPhases: () => [
					{ name: "Verification", tasks: [{ content: "Run focused checks", status: "completed" }] },
				],
			}),
		);

		const result = await tool.execute("call-complete", {
			op: "complete",
			objective: undefined,
			token_budget: undefined,
		});

		expect(result.details?.goal?.status).toBe("complete");
		expect(harness.getState()).toMatchObject({ enabled: false, mode: "exiting", goal: { status: "complete" } });
	});

	it("completes despite open todos when todo reminders are disabled", async () => {
		const harness = createRuntimeHarness();
		await harness.runtime.createGoal({ objective: "Ship the release" });
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
				settings: Settings.isolated({ "todo.enabled": true, "todo.reminders": false }),
				isToolActive: name => name === "todo",
				getTodoPhases: () => [
					{ name: "Verification", tasks: [{ content: "Run focused checks", status: "pending" }] },
				],
			}),
		);

		const result = await tool.execute("call-complete", {
			op: "complete",
			objective: undefined,
			token_budget: undefined,
		});

		expect(result.details?.goal?.status).toBe("complete");
		expect(harness.getState()).toMatchObject({ enabled: false, mode: "exiting", goal: { status: "complete" } });
	});

	it("rejects op=create when the objective is missing or only whitespace", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(
			tool.execute("call-empty", { op: "create", objective: "   \t\n", token_budget: undefined }),
		).rejects.toThrow("objective is required when op=create");
		expect(harness.getState()).toBeUndefined();
	});

	it("rejects every numeric agent token_budget with a stable machine-readable code", async () => {
		const harness = createRuntimeHarness();
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		for (const token_budget of [1, 0, -5]) {
			await expect(
				tool.execute("call-budget", { op: "create", objective: "Ship it", token_budget }),
			).rejects.toThrow("agent_goal_token_budget_not_allowed");
		}
		expect(harness.getState()).toBeUndefined();
	});

	it("returns completion details while hiding the retained headless exit sentinel from op=get", async () => {
		const harness = createRuntimeHarness();
		await harness.runtime.createGoal({ objective: "Ship the release", tokenBudget: 100 });
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const completed = await tool.execute("call-complete", {
			op: "complete",
			objective: undefined,
			token_budget: undefined,
		});

		expect(completed.details?.goal?.status).toBe("complete");
		expect(harness.getState()).toMatchObject({ mode: "exiting", goal: { status: "complete" } });
		const current = await tool.execute("call-get", { op: "get", objective: undefined, token_budget: undefined });
		expect(current.details?.goal).toBeNull();
		expect(current.content).toEqual([{ type: "text", text: "No active goal." }]);
	});

	it("rejects complete for a paused goal", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "active",
			goal: createGoal({ objective: "Paused work", status: "paused" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(
			tool.execute("call-complete", {
				op: "complete",
				objective: undefined,
				token_budget: undefined,
			}),
		).rejects.toThrow("cannot complete goal because no goal is active");
		expect(harness.getState()?.goal.status).toBe("paused");
	});

	it("rejects create until terminal cleanup clears the previous completed goal", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "exiting",
			reason: "completed",
			goal: createGoal({ status: "complete" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		await expect(
			tool.execute("call-create-before-cleanup", {
				op: "create",
				objective: "Next goal",
				token_budget: undefined,
			}),
		).rejects.toThrow("terminal cleanup is still in progress");
		harness.setState(undefined);

		const result = await tool.execute("call-create-after-cleanup", {
			op: "create",
			objective: "Next goal",
			token_budget: undefined,
		});
		expect(result.details?.goal?.objective).toBe("Next goal");
		expect(result.details?.goal?.status).toBe("active");
	});

	it("op=get returns a paused goal even when enabled=false", async () => {
		const harness = createRuntimeHarness({
			enabled: false,
			mode: "active",
			goal: createGoal({ status: "paused" }),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-get", { op: "get", objective: undefined, token_budget: undefined });
		expect(result.details?.goal?.status).toBe("paused");
		expect(result.details?.goal?.objective).toBe("Ship it");
	});

	it("op=block makes an active goal inert", async () => {
		const harness = createRuntimeHarness({
			enabled: true,
			mode: "active",
			goal: createGoal(),
		});
		const tool = new GoalTool(
			createToolSession({
				getGoalRuntime: () => harness.runtime,
				getGoalModeState: () => harness.getState(),
			}),
		);

		const result = await tool.execute("call-block", { op: "block", objective: undefined, token_budget: undefined });
		expect(result.details?.op).toBe("block");
		expect(result.details?.goal?.status).toBe("blocked");
		expect(harness.getState()?.enabled).toBe(false);
	});

	it("exposes only get, create, complete, and block to the model", () => {
		const tool = new GoalTool(createToolSession({}));

		for (const op of ["get", "create", "complete", "block"]) {
			expect(tool.parameters.allows({ op })).toBe(true);
		}
		for (const op of ["pause", "resume", "edit", "replace", "budget", "drop", "clear"]) {
			expect(tool.parameters.allows({ op })).toBe(false);
		}
	});

	it("publishes the required model-operation guidance", () => {
		const tool = new GoalTool(createToolSession({}));
		expect(tool.description).toBe(`The goal is persistent mission state.

- \`get\`: read the current goal and accounting.
- \`create\`: start a goal only when the user or system clearly requested persistent goal mode and no unfinished goal exists. Ordinary clear user prose is sufficient; do not parse prose into authorization rules.
- \`complete\`: use only when the full objective is achieved and the required current evidence supports that claim.
- \`block\`: use when meaningful progress requires user input, unavailable access, or external-state change, or after two evidence-valid failures of the same route with no materially different safe route.

Do not infer a goal from an ordinary task. Do not use completion or blocking to escape difficult work. Pause, resume, edit, replace, budget, drop, and clear are typed owner/system operations. The two-failure rule is concise model guidance backed by tests; do not build a natural-language route-failure classifier.`);
	});
});
