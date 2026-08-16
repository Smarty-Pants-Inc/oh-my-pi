# OMP 17.3.5 reconstruction patch ledger

This ledger records the deterministic reconstruction of the Smarty fork on the
frozen upstream target. It excludes upstream-sync merges and records each
substantive non-merge patch once. The final candidate commit and tree are
reported outside this tracked file to avoid a self-referential commit identity.

## Frozen inputs

| Identity | Value |
| --- | --- |
| Upstream URL | `https://github.com/can1357/oh-my-pi.git` |
| Upstream default branch | `main` |
| Upstream fetch window | `2026-08-16T08:01:07Z` to `2026-08-16T08:01:10Z` |
| Upstream commit | `37eee71978951fccf66b21f7e3e2b74596ac9d74` |
| Upstream tree | `a20c0452f99155e7adeaecfad28e4afd0223c684` |
| Upstream version | `17.3.5` |
| Shared merge base | `ffd53ff92a6f575d499730475a73460dd7cc2eea` |
| Smarty bootstrap main | `f2aa92fc6567df1965295ff68ae592a2ccfd7b88` |
| Bootstrap tree | `73c050c217d2136db2c49ceeadb916cd05e82b94` |
| Accepted donor | `f477ba48dbfb0b24b2f7cdb4f41eea9dc8bc6e63` |
| Donor tree | `ce82d88b24390f5b39a6850f345bbc81321e6772` |

The reconstruction branch starts directly at the upstream commit. It contains
no upstream-sync merge and no blind replay of the donor history.

## Legacy Smarty fork patches

The source inventory is the reverse, no-merge history of
`upstream/main..origin/main`. `701d41cc1` reconstructs retained fork behavior;
`b861df22d` owns CI and Mergify policy; `b0b80f62a` owns regenerated Bazel
metadata.

| Source patch | Disposition | Reconstruction and proof |
| --- | --- | --- |
| `06e8550b3` fork foundation | Reimplemented | Compaction input budget, goal budget/exit rules, Mach-O repair, tests, and retained fork metadata in `701d41cc1`. Focused compaction, goal, and native-script tests pass. |
| `17a9926b6`, `5410c7d40` extension settlement | Reimplemented as one causal unit | In-flight follow-up ownership, before-`agent_end` settlement, stale-generation rejection, UI/runtime callers, and tests in `701d41cc1`. Extension runner/session tests pass. |
| `ead22a62e`, `2d42042fc` stabilizer tests | Reapplied where the contract remains live | Native vector timeout and abort/deadline queue ownership assertions retained against current source. |
| `5a50f0ee4` provider-neutral execution environments and Cloudflare adapter | Reimplemented | New Cloudflare package and current execution-environment seam in `701d41cc1`. Package check passes; 81 tests pass and the two opt-in real-service tests skip by contract. |
| `d614ebf5a` system-prompt builder | Reimplemented | Sole-owner extension hook and current prompt pipeline integration in `701d41cc1`; builder tests pass. |
| `92471446a`, `b18d89fcd` Fresh companion and seeded-state rehydration | Reimplemented as one lifecycle unit | Fresh wire/lifecycle surfaces and new-session goal/todo restoration in `701d41cc1`, reconciled with upstream mode-exit ownership. Fresh/session tests pass. |
| `2dcc4af07` loader cadence | Reapplied | 60 fps cadence and matching tests in `701d41cc1`. |
| `17ccb629a` provider discovery isolation | Reimplemented | Policy-gated provider directories, cache/preload order, and tests in `701d41cc1`. |
| `4e34b2959` Smarty Pants branding | Reapplied | Welcome/splash branding and tests in `701d41cc1`. |
| `8715d5276`, `f4517abb3` todo lifecycle | Reimplemented as one causal unit | Task-completion reconciliation, explicit todo choice, owned dialect, async completion, rehydration, and tests in `701d41cc1`, with current authority fixes in `502c79a37` and `4fba4d0ce`. |
| `4b9f43c46` shared model registry test | Upstream equivalent; dropped | Upstream `37eee719` already uses `sharedModelRegistry` in the affected concurrent-session test. |
| `c163469f4`, `1fada2bb8`, `6554ee22c` generated Bazel locks | Obsolete snapshots; regenerated | Not replayed. Current lock regenerated from the reconstructed source and committed as `b0b80f62a`. |
| `fc77ce35b` builder marker test | Reapplied | Retained with the current builder tests in `701d41cc1`. |
| `7b606eb05` async fixture restoration | Reapplied | Retained with current todo/extension fixtures in `701d41cc1`. |
| `e9cc2c85d`, `27db8f410` compatibility repairs | Selectively reimplemented | Current Antigravity fixtures, setup-wizard short-terminal behavior, SessionTools wording compatibility, timeout recovery, todo setup, exit dependencies, and CI chunking in `701d41cc1`. |
| `daaf11a80`, `c8d1f98b9`, `bb7fbceb2` managed-session/native/print ownership | Reimplemented as one causal unit | Semantic delivery IDs, companion ownership, lifecycle fences, terminal metadata, goal parsing, headless drain, and hard-exit behavior in `701d41cc1`; current final-boundary repairs in `502c79a37`, `de925db98`, and `4fba4d0ce`. |
| `384bd111c` managed-session fixtures | Reapplied | Tree ask/re-answer/navigation and concurrent-dispose assertions retained with the reconstructed lifecycle. |
| `64477987d`, `4439797a0` independent collaboration renderers | Reimplemented as one transport unit | Local transport, bridge commands, authority/display/transcript validation, protocol 4, install smoke, and tests in `701d41cc1`. |
| `560e4b4b5` queue-safe CI and `.mergify.yml` | Retained and adapted | Current 17.3.5 workflow keeps queue refs and the always-run `smarty_ci` aggregate; serial one-at-a-time Mergify policy is in `b861df22d`. |

## Context and autonomy mission patches

These patches form a strict dependency chain. Each was reapplied against the
17.3.5 architecture, then repaired at the shared runtime seam.

| Source patch | Reconstruction | Proof |
| --- | --- | --- |
| `96681f40e` typed context/autonomy foundation | `e16bc4fd0` | Context registry, behavior manifest, goal/todo/task authority, provider contracts, and focused tests. |
| `b6d6a5fd2` runtime authority/native-free gates | `58d7c1368` | Capability/runtime guards, native-free context commands, provider payload guards, and hostile tests. |
| `cc002bdbb` compaction context binding | `e452e053e` | Typed internal context survives summarization and provider delivery. |
| `d544e363a` provider evidence | `1d52f83a2` | Final-payload evidence and context explain/diff surfaces. |
| `fde4e84be` model-visible implementation provenance | `721fdccd1` | Protected source closure and prompt/tool/global/config identity. |
| `f5d9c26f2` evidence/capability boundaries | `8b2930a16` | Fail-closed evidence guards and session capability enforcement. |
| `bb0066ded` native and passive-delivery closure | `da71c9e22`, then `502c79a37` and `de925db98` | Native boundaries and passive late-result persistence without post-final semantic work. |
| `f477ba48d` deterministic protected ordering | `65ffef549` | Explicit Unicode code-point comparator and hostile prefix/case/BMP-private-use/astral/duplicate tests. |

## Current-upstream protected deltas and reconstruction repairs

| Delta | Before | After | Proof |
| --- | --- | --- | --- |
| Date and working-directory reminder | Upstream prepended OMP-authored text to the first `role:user` message. | Registered typed `internal_context` delivered through provider instruction channels; execution-environment cwd mapping prevents host-path leakage; system-prompt bytes stay stable. | Date/cwd, attribution, payload-guard, and live session explain tests. |
| Exploration checkpoint notice | Upstream injected a hidden custom steering message. | Registered typed `internal_context` with explicit checkpoint trigger/order/provenance. | Checkpoint and final-payload evidence tests. |
| Behavior defaults | Donor YAML was descriptive; runtime defaults bypassed it. | One strict, fail-closed parser supplies governed defaults while explicit user config still wins. | Schema, parity, hostile drift, goal/todo/task tests. |
| Cursor and Devin evidence | Provider payloads were delivered but not parsed back into exact final evidence. | Evidence is captured at the last provider transform/guard boundary; missing evidence fails closed. | `provider-final-payload-evidence.test.ts`. |
| Goal terminal state | Donor cleared completed goal identity/status on restart and could stop active goals after tool-less/empty-todo turns. | Terminal identity/history persists; active goals remain active until an explicit terminal transition. | Goal persistence and hostile continuation tests. |
| User-visible final boundary | Donor could start semantic work for a late async result after the final boundary and could record `started` before dispatch. | Late results persist passively; no post-final provider turn starts; `started` follows successful dispatch. | Automatic-turn authority, async delivery, and lifecycle tests. |
| Queue-only and mode-exit ownership | Initial reconstruction could wake an idle model and capture a persisted session before mode-exit reconciliation. | Queue-only delivery remains passive; reconciler runs before the first persisted session-file capture while preserving upstream transactional checkpoints. | `4fba4d0ce` focused lifecycle/async suite. |
| Stable prompt test projection | One donor test rebuilt a model-dependent default prompt and failed against upstream stable prompt behavior. | Test now verifies the stable default path through the shared prompt projection. | `1dabfb254`, 7 focused prompt tests pass. |

Upstream prompt changes to rewind reporting and browser close/kill ownership are
preserved. New date/cwd and checkpoint sources are registered and generated,
not silently accepted as untyped content.

## Deterministic proof commands

```sh
git log --reverse --no-merges --format='%H %s' upstream/main..origin/main
git log --cherry-pick --right-only upstream/main...origin/main --no-merges
git diff --name-only 37eee71978951fccf66b21f7e3e2b74596ac9d74..HEAD
bun --cwd packages/coding-agent run gen:prompt-manifest:check
bun packages/coding-agent/src/cli.ts context manifest --json
bun packages/coding-agent/src/cli.ts context diff 37eee71978951fccf66b21f7e3e2b74596ac9d74 HEAD --json
bun packages/coding-agent/src/cli.ts context protected-delta 37eee71978951fccf66b21f7e3e2b74596ac9d74 HEAD --json
```

Generated hashes, exact final candidate identity, upstream-freshness evidence,
test accounting, baseline-reproduced failures, and the immutable reviewer
verdict belong to the final handoff because they describe the commit containing
this file.
