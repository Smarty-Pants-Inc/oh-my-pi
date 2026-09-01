Delegate one or more bounded assignments when independent work can reduce wall-clock time or a separate perspective is materially useful.

Each assignment must be self-contained, scoped to the current request or active goal, and explicit about allowed files, expected result, and integration boundary. Run independent assignments concurrently. Keep coupled changes under one owner.

Delegation divides existing scope; it never creates scope. Do not delegate when dispatch and integration cost exceed the expected benefit.

{{#if asyncEnabled}}
Execution returns job IDs immediately; completed results are delivered automatically.
{{else}}
Execution waits for each assignment to finish.
{{/if}}

# Task Design
- Pick each item's most specific available agent. Omitting `agent` selects the spawn-policy default (`{{defaultAgent}}`); omit it only when that agent fits the task. Otherwise pass the specialist explicitly.
- Parallelize independent ownership. Same-file edits are not guaranteed to merge.{{#if ircEnabled}} Have siblings coordinate through `hub` before editing shared files.{{/if}} Keep coupled changes under one integration owner.

# Inputs
{{#if batchEnabled}}
- `context`: Shared goal, constraints, and contracts for every assignment.
- `tasks[]`: Independent assignments to run concurrently when appropriate.
  - `name`: Optional stable identifier.
  - `agent`: Optional agent type. Omit it to use `{{defaultAgent}}`.
  - `task`: Complete, self-contained assignment.
  - `model`: Optional direct model selector. It overrides the selected agent's default model.
{{#if effortEnabled}}  - `effort`: Optional reasoning level: `"lo"`, `"med"`, or `"hi"`.
{{/if}}  - `outputSchema`: Optional result schema.
  - `schemaMode`: `"permissive"` (default) or `"strict"`.
{{#if isolationEnabled}}  - `isolated`: Run in a dedicated worktree.
{{/if}}
{{else}}
- `name`: Optional stable identifier.
- `agent`: Optional agent type. Omit it to use `{{defaultAgent}}`.
- `task`: Complete, self-contained assignment.
- `model`: Optional direct model selector. It overrides the selected agent's default model.
{{#if effortEnabled}}- `effort`: Optional reasoning level: `"lo"`, `"med"`, or `"hi"`.
{{/if}}- `outputSchema`: Optional result schema.
- `schemaMode`: `"permissive"` (default) or `"strict"`.
{{#if isolationEnabled}}- `isolated`: Run in a dedicated worktree.
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
