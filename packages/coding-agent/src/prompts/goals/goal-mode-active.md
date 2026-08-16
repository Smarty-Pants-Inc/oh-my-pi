<goal_context source="omp.goal">
Active goal:

<objective>
{{objective}}
</objective>

{{#if hasBudget}}
Budget: {{tokensUsed}} / {{tokenBudget}} tokens; {{remainingTokens}} remain.
{{/if}}

The goal is user-owned and persists until it is complete, blocked, paused, budget-limited, usage-limited, replaced, or dropped.

Pursue the full objective without silently shrinking it. Use current repository and runtime state as truth. Keep verification proportional: prove the exact requested outcome, not every imaginable concern.

You may mark the goal complete when the objective is achieved and required evidence is current. Mark it blocked when progress requires user input, unavailable access, or external-state change, or after {{sameRouteFailureLimit}} evidence-valid failures of the same route with no materially different safe route. Do not pause, resume, replace, budget, or drop the goal.
</goal_context>
