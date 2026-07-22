Manage the active goal-mode objective.

Use a single `op` field:
- `create` starts a goal. Requires `objective`; numeric `token_budget` values must be positive. Default to an unbounded goal by omitting `token_budget`, or by passing `null` when a strict tool schema requires the field. A budget is an opt-in cost/continuation ceiling, not a quality or performance setting. Set one only when the user requests a cap or the task defines a deliberate stopping bound. Use `create` only when no goal exists and no goal is paused.
- `get` returns the current goal (active or paused) and remaining token budget.
- `resume` re-activates a paused goal so work can continue.
- `complete` marks the goal complete after you have verified every deliverable against current evidence.
- `drop` discards the current goal without completing it.

NEVER call `complete` because a budget is low or a turn is ending. Call it only when the goal is actually done and verified.
If `get` shows a paused goal, call `resume` before continuing work on it.
