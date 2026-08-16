import type { UsageStatistics } from "../session/session-entries";

export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "budget_limited"
	| "usage_limited"
	| "complete"
	| "dropped"
	| "superseded";

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	goal: Goal;
}

const goalStatuses = new Set<GoalStatus>([
	"active",
	"paused",
	"blocked",
	"budget_limited",
	"usage_limited",
	"complete",
	"dropped",
	"superseded",
]);

function normalizeGoalStatus(value: string): GoalStatus | undefined {
	if (value === "budget-limited") return "budget_limited";
	if (value === "usage-limited") return "usage_limited";
	return goalStatuses.has(value as GoalStatus) ? (value as GoalStatus) : undefined;
}

/** Parse persisted goal mode data at every session identity boundary. */
export function parseGoalModeState(mode: unknown, modeData: unknown): GoalModeState | undefined {
	if (mode !== "goal" && mode !== "goal_paused") return undefined;
	if (typeof modeData !== "object" || modeData === null || !("goal" in modeData)) return undefined;
	const goal = modeData.goal;
	if (typeof goal !== "object" || goal === null) return undefined;
	const value = goal as Record<string, unknown>;
	if (
		typeof value.id !== "string" ||
		value.id.length === 0 ||
		typeof value.objective !== "string" ||
		value.objective.length === 0 ||
		typeof value.status !== "string" ||
		typeof value.tokensUsed !== "number" ||
		!Number.isFinite(value.tokensUsed) ||
		value.tokensUsed < 0 ||
		typeof value.timeUsedSeconds !== "number" ||
		!Number.isFinite(value.timeUsedSeconds) ||
		value.timeUsedSeconds < 0 ||
		typeof value.createdAt !== "number" ||
		!Number.isFinite(value.createdAt) ||
		value.createdAt < 0 ||
		typeof value.updatedAt !== "number" ||
		!Number.isFinite(value.updatedAt) ||
		value.updatedAt < 0 ||
		(value.tokenBudget !== undefined &&
			(typeof value.tokenBudget !== "number" || !Number.isInteger(value.tokenBudget) || value.tokenBudget <= 0))
	) {
		return undefined;
	}
	const status = normalizeGoalStatus(value.status);
	if (!status) return undefined;
	if (mode === "goal_paused" ? status !== "paused" : status === "paused") return undefined;
	const complete = status === "complete";
	return {
		enabled: status === "active" || status === "budget_limited",
		mode: complete ? "exiting" : "active",
		reason: complete ? "completed" : undefined,
		goal: {
			id: value.id,
			objective: value.objective,
			status,
			tokenBudget: value.tokenBudget as number | undefined,
			tokensUsed: value.tokensUsed,
			timeUsedSeconds: value.timeUsedSeconds,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
		},
	};
}

export interface GoalToolDetails {
	op: "create" | "get" | "complete" | "block";
	goal?: Goal | null;
	remainingTokens?: number | null;
	completionBudgetReport?: string | null;
}

export type GoalRuntimeEvent =
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "goal_continuation_requested"; prompt: string };

export type GoalTokenUsage = Pick<UsageStatistics, "input" | "output" | "cacheRead" | "cacheWrite">;

export type GoalBudgetSteering = "allowed" | "suppressed";
export type GoalTerminalMetricEmission = "emit" | "suppress";
