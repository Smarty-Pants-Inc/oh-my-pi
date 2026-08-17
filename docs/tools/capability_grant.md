# capability_grant

> Record one narrow session capability that the direct user explicitly authorized in the current turn.

## Source

- Entry: `packages/coding-agent/src/tools/capability-grant.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/capability-grant.md`
- Authority store: `packages/coding-agent/src/capability/session-capabilities.ts`

## Registration

The tool is discoverable, strict-schema, and read-tier. It is available only when the session has a `SessionCapabilities` boundary. A successful call changes session authority; it does not perform the authorized write or external effect.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `"writePath" \| "externalCapability"` | Yes | Selects a canonical path grant or an exact named external-effect grant. |
| `value` | nonempty `string` | Yes | Exact path or exact capability name authorized by the current direct-user request. |

Unknown fields are rejected.

## Outputs

The text result is `Granted <kind>: <normalized value>`. Structured details record:

- direct-user turn ID and SHA-256 of that user prompt;
- source `direct_user_turn` and grant timestamp;
- grant kind and canonical or normalized value.

## Authority rules

- The current turn must be a live direct-user turn with matching `direct_user_input` continuation authority.
- Goal continuation, async-result, retry, hidden, and other automatic turns cannot grant authority.
- `writePath` resolves the longest existing path prefix and records the canonical target. An unresolved or unsafe symlink path fails.
- `externalCapability` trims the name and later checks require an exact match.
- The grant lasts for the session and can be reused by later capability decisions.

## Errors

- Missing session capability boundary: `session capability boundary is unavailable`.
- Wrong turn provenance: `capability grants require the current direct-user turn with direct_user_input continuation authority`.
- Empty external capability or non-canonicalizable path: the boundary error is returned as `ToolError`.
