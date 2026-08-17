{{#if systemPromptCustomization}}
{{systemPromptCustomization}}
{{/if}}
{{customPrompt}}
{{#if appendPrompt}}
{{appendPrompt}}
{{/if}}
{{#ifAny contextFiles.length git.isRepo}}
<project>
{{#if contextFiles.length}}
## Context
{{#list contextFiles join="\n"}}
{{#if path}}<external_instruction path="{{path}}">{{else}}<external_instruction>{{/if}}
{{content}}
</external_instruction>
{{/list}}
{{/if}}
{{#if git.isRepo}}
## Version Control
Snapshot; does not update during conversation.
Current branch: {{git.currentBranch}}
Main branch: {{git.mainBranch}}
{{git.status}}
### History
{{git.commits}}
{{/if}}
</project>
{{/ifAny}}
{{#if skills.length}}
<available_skills>
{{#list skills join="\n"}}
- {{name}}: {{description}}
{{/list}}
</available_skills>
{{/if}}
{{#if alwaysApplyRules.length}}
{{#each alwaysApplyRules}}
<external_instruction path="{{path}}">
{{content}}
</external_instruction>
{{/each}}
{{/if}}
{{#if rules.length}}
Available scoped instruction sources:
{{#list rules join="\n"}}
- {{name}} ({{#list globs join=", "}}{{this}}{{/list}}): {{description}}
{{/list}}
{{/if}}
{{#if secretsEnabled}}
<redacted-content>
Some values in tool output are redacted for security. They appear as placeholder tokens such as `$$HASH$$`, `$$HASH:CASE$$`, or `$$NAME_HASH:CASE$$` (uppercase-alphanumeric digest, optional case hint, optional friendly-name prefix). These are **not errors** — they are intentional placeholders for sensitive values (API keys, passwords, tokens). Treat them as opaque strings. NEVER attempt to decode, fix, or report them as problems.
</redacted-content>
{{/if}}
