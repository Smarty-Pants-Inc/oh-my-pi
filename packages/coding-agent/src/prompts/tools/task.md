Delegate one or more bounded assignments when independent work can reduce wall-clock time or a separate perspective is materially useful.

Each assignment must be self-contained, scoped to the current request or active goal, and explicit about allowed files, expected result, and integration boundary. Run independent assignments concurrently. Keep coupled changes under one owner.

Delegation divides existing scope; it never creates scope. Do not delegate when dispatch and integration cost exceed the expected benefit.
Dispatch the initial explicit independent wave, integrate and resolve ownership, then refill only with newly ready independent work.

{{#if asyncEnabled}}
Execution returns job IDs immediately; completed results are delivered automatically.
{{else}}
Execution waits for each assignment to finish.
{{/if}}

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
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (read-only){{/if}}{{#if blocking}} (blocking){{/if}}
{{description}}
{{/list}}
{{/if}}
