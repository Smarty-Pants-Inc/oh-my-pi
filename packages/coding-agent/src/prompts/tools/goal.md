Manage the active goal-mode objective.

Use a single `op` field:
- `create` starts a goal and enables goal mode. Requires `objective`. Omit `token_budget`: agent-created goals are always unbounded. A strict tool schema may require `token_budget: null`; numeric values are rejected. Only the interactive owner command may add, change, or remove a cap. Use `create` only when no goal exists and no goal is paused.
- `get` returns the current goal (active or paused) and remaining token budget.
- `resume` re-activates a paused goal so work can continue.
- `complete` marks the goal complete after you have verified every deliverable against current evidence.
- `drop` discards the current goal without completing it.

NEVER call `complete` because a budget is low or a turn is ending. Call it only when the goal is actually done and verified.
If `get` shows a paused goal, call `resume` before continuing work on it.
