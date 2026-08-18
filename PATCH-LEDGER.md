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
| Bootstrap tree | `73c050c2cc8abea755cf63ff85f0e3bc5271f54b` |
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
| `06e8550b3` fork foundation | Reimplemented | Compaction input budget, goal budget/exit rules, Mach-O repair, tests, and retained fork instruction metadata in `701d41cc1`. Focused compaction, goal, and native-script tests pass. |
| Fork-only `.gitignore` and package changelog edits | `DROP_OBSOLETE` | Scope admission found no Phase 1 requirement for these metadata deltas. `.gitignore`, `packages/agent/CHANGELOG.md`, and `packages/coding-agent/CHANGELOG.md` are restored byte-for-byte to upstream blobs `c4cea6ff0e9f3dc3e48b42bdd8856d2fb9c87160`, `f47be5dbb6f6a4fc505a5cfd2b87ed8a9a37f2c2`, and `4901d84f73388c60160c3cab32841414c7c1b7b2`. Runtime changes remain accounted for by their source-patch rows. |
| Unmapped compatibility-only bytes | `DROP_OBSOLETE` | Scope admission found no directly changed implementation anchor for `packages/catalog/test/variant-collapse.test.ts`, `packages/coding-agent/test/profile-alias.test.ts`, `packages/coding-agent/test/update-cli.test.ts`, or `packages/mnemopi/test/native-vector-parity.test.ts`; the lazy worker/smoke import delta in `packages/coding-agent/src/cli.ts` also does not implement a Phase 1 requirement. All five paths are restored byte-for-byte to frozen upstream `37eee71978951fccf66b21f7e3e2b74596ac9d74`. The eval agent-bridge runtime-profile assertions remain as the runnable dependency of the mapped structured-subagent profile seam. |
| `17a9926b6`, `5410c7d40` extension settlement | Reimplemented as one causal unit | In-flight follow-up ownership, before-`agent_end` settlement, stale-generation rejection, UI/runtime callers, and tests in `701d41cc1`. Extension runner/session tests pass. |
| `ead22a62e`, `2d42042fc` stabilizer tests | Split: `ead22a62e` `DROP_OBSOLETE`; `2d42042fc` reapplied | The timeout-only native-vector edit has no changed implementation anchor and is restored to frozen upstream. The abort/deadline queue ownership assertion remains mapped to the retained agent loop contract. |
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
| Loaded-runner lifecycle proof race | The advisor-yield test could enqueue its navigation yield before the loaded extension runner had installed the matching handler, causing a full-fanout-only timeout. | The fixture now enqueues immediately before navigation, after runner installation, without changing production lifecycle behavior. | `cae737ed9`, 650 repeated focused runs and the full runtime chunk pass. |
| Subagent prompt provenance | The delegated objective was wrapped in OMP text and sent as a normal `role:user` message; the subagent base bypassed registered rendering. | The objective remains direct user content. Both OMP-authored subagent surfaces are registered `internal_context` instructions with exact component provenance and provider-selected developer/system roles. | Hostile executor and final-payload provenance tests. |
| YOLO execution authority | A second `SessionCapabilities` layer overrode native approval modes, blocked arbitrary Bash commands and out-of-workspace structured writes, and required model-issued `capability_grant` calls even in YOLO mode. | The duplicate capability store, grant tool, Bash classifier, structured-write gates, SDK/session plumbing, prompt, manifest entries, and capability-only tests are removed. Native approval modes and per-tool policies own execution again: YOLO auto-approves every tool tier, while explicit prompt/deny overrides and provider safety checks remain intact. | Approval-mode regression executes an arbitrary local command in default YOLO; focused tool, manifest, and type checks pass without capability symbols. |
| Implementation-source ordering | Generation and validation used ambient `localeCompare`, so the content root could change or reject across locales. | Generation and validation share the protected-delta Unicode code-point comparator. | Prefix/case/BMP-private-use/astral/duplicate manifest test. |
| Same-tree protected evidence | `context diff` could report identical roots and no changed paths while still classifying the unchanged generated prompt manifest as protected. | Parsed manifests are supplied only as semantic inputs; the independently computed changed-path input owns file classification. Equal manifests now produce no protected delta. | Same-tree Git regression in `protected-delta.test.ts` and exact source-candidate-to-topology `context diff`. |
| CI-portable context evidence | Context-attribution tests read the operator's ambient global `AGENTS.md`, and native-free tests assumed the CI checkout contained `HEAD^` plus the frozen upstream object. | Tests provide exact isolated global source bytes and a local immutable parent commit. The native-free fixture fetches only the frozen upstream commit when its source checkout does not contain it, then executes the ledger refs unchanged; its local `HEAD^..HEAD` check asserts the intentional same-tree result. Production still requires global sources and immutable refs fail closed. | The attribution, native-free CLI, and clean-checkout files pass together without ambient home files or source-checkout parent history. |
| Exact scope admission | Release candidates and approved policy bound commit/tree identity but not the exact base-to-candidate path set required by §8.6, §17.1, and §23.10. | Each combined-manifest candidate now binds its exact base commit/tree plus reviewed, sorted, unique `scopeCoverage` for every changed path. OMP accepts this map only as caller input, verifies the frozen upstream identity and exact Git diff, and rejects missing/extra paths, broad section labels, or dependencies that do not name a direct changed path in the same map. Activation and approved-policy parsing preserve and compare the same candidate record. | Focused manifest tests reject unknown, missing, duplicate, unsorted, non-equal, circular, self-referential, and non-direct coverage; approved-policy tests prove exact candidate preservation and mismatch detection. |
| Interactive policy drift | Startup blocked all OMP use on approval drift, while the duplicate capability bridge consumed tool context and contradicted YOLO. | Interactive startup still emits `PROMPT_POLICY_REVIEW_REQUIRED` and continues so the Stack guard can retain a visible warning; offline checks remain strict. The duplicate capability bridge is removed instead of hidden behind discovery. | Approved-policy warning, built-in registry, prompt-manifest, and approval-mode tests. |

Upstream prompt changes to rewind reporting and browser close/kill ownership are
preserved. New date/cwd and checkpoint sources are registered and generated,
not silently accepted as untyped content.

## Deterministic proof commands

```sh
git log --reverse --no-merges --format='%H %s' upstream/main..origin/main
git log --cherry-pick --right-only upstream/main...origin/main --no-merges
git diff --name-only 37eee71978951fccf66b21f7e3e2b74596ac9d74..HEAD
(cd packages/coding-agent && bun run gen:prompt-manifest:check)
bun packages/coding-agent/src/cli.ts context manifest --json
bun packages/coding-agent/src/cli.ts context diff --base 37eee71978951fccf66b21f7e3e2b74596ac9d74 --target HEAD --json
bun packages/coding-agent/src/cli.ts context protected-delta --repository . --base 37eee71978951fccf66b21f7e3e2b74596ac9d74 --target HEAD --json
```

Generated hashes, exact final candidate identity, upstream-freshness evidence,
test accounting, baseline-reproduced failures, and the immutable reviewer
verdict belong to the final handoff because they describe the commit containing
this file.
