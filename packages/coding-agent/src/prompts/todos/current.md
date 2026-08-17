<todo_context source="omp.todo">
Working memory only. These items do not create scope or authorize another turn.

{{#each phases}}
- {{name}}
{{#each tasks}}
  - [{{status}}] {{content}}{{#if blocker}}: {{blocker}}{{/if}}
{{/each}}
{{/each}}

{{closed}} closed; {{open}} open.

Use this list to preserve the thread. Update it only when state materially changes. Mark finished work done, genuine external waits blocked, and obsolete or no-longer-required items dropped or removed.
</todo_context>
