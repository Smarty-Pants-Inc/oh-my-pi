Delegate one or more bounded assignments when independent work can reduce wall-clock time or a separate perspective is materially useful.

Each assignment must be self-contained, scoped to the current request or active goal, and explicit about allowed files, expected result, and integration boundary. Run independent assignments concurrently. Keep coupled changes under one owner.

Delegation divides existing scope; it never creates scope. Do not delegate when dispatch and integration cost exceed the expected benefit.

{{#if asyncEnabled}}
Execution returns job IDs immediately; completed results are delivered automatically.
{{else}}
Execution waits for each assignment to finish.
{{/if}}

# Async Job Contract
- Results auto-deliver. A settled `hub jobs`/`hub wait` snapshot is the delivery; no duplicate `async-result` follows.
- Job IDs are process-local and expire roughly five minutes after settlement. Afterward, use the agent ID with `hub send`, `agent://<id>`, or `history://<id>`.
- With `outputSchema`, a result's parsed payload — when present — is served at `agent://<id>` (fields via `agent://<id>?q=.<field>`) regardless of validity; a schema-violating (invalid) result also previews the payload inline in the auto-delivered follow-up.
- `completed` means successful yield/job exit, not artifact acceptance. Verify claimed changes.
# Task Design
- Pick each item's most specific available agent. Omitting `agent` selects the spawn-policy default (`{{defaultAgent}}`); omit it only when that agent fits the task. Otherwise pass the specialist explicitly.
- Parallelize independent ownership. Same-file edits are not guaranteed to merge.{{#if ircEnabled}} Have siblings coordinate through `hub` before editing shared files.{{/if}} Keep coupled changes under one integration owner.

# Inputs
{{#if batchEnabled}}
- `context`: Shared goal, constraints, and contracts for every assignment. Applies to the entire batch; do not duplicate this background into individual tasks.
- `tasks[]`: Array of subagents to spawn.
  - `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
  - `agent`: The agent type to spawn (e.g. {{#if scoutAvailable}}`scout`, {{/if}}`reviewer`). Omitting `agent` selects the spawn-policy default (`{{defaultAgent}}`).
  - `task`: Complete, self-contained assignment.
  - `model`: Optional direct model selector. It overrides the selected agent's default model.
{{#if evalToolsEnabled}}  - `tools`: Names of eval-defined tools (`@tool` in Python, `tool(fn, {…})` in JS) to expose to this subagent.
{{/if}}{{#if effortEnabled}}  - `effort`: Scale with complexity: `"lo"`|`"med"`|`"hi"`.
{{/if}}  - `outputSchema`: Optional result schema.
  - `schemaMode`: `"permissive"` (default) or `"strict"`.
{{#if isolationEnabled}}  - `isolated`: Run in a dedicated worktree.
{{/if}}
{{else}}
- `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
- `agent`: The agent type to spawn (e.g. {{#if scoutAvailable}}`scout`, {{/if}}`reviewer`). Omitting `agent` selects the spawn-policy default (`{{defaultAgent}}`).
- `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are prohibited.
{{#if evalToolsEnabled}}- `tools`: Names of eval-defined tools (`@tool` in Python, `tool(fn, {…})` in JS) to expose to this subagent.
{{/if}}{{#if effortEnabled}}- `effort`: Scale with complexity: `"lo"`|`"med"`|`"hi"`.
{{/if}}- `model`: Optional direct model selector. It overrides the selected agent's default model.
- `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.
- `schemaMode`: `"permissive"` (default) accepts a retry-exhausted invalid result with a warning; `"strict"` fails it.
{{#if isolationEnabled}}
{{#if applyIsolatedChanges}}
- `isolated`: Run in a dedicated worktree; successful changes are automatically applied to the parent checkout.
{{else}}
- `isolated`: Run in a dedicated worktree; changes are retained as patch or branch artifacts without modifying the parent checkout.
{{/if}}
{{/if}}
{{/if}}

# Available agents
{{#if spawningDisabled}}
Agent spawning is disabled.
{{else}}
Pick the most specific agent. Omit `agent` only when the spawn-policy default is that agent.
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (read-only){{/if}}{{#if blocking}} (blocking){{/if}}
{{description}}
{{/list}}
{{/if}}
