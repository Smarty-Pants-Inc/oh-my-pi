# OMP 18.0.11 reconstruction patch ledger

This ledger records the deterministic reconstruction of the Smarty fork on the
frozen upstream target. It excludes upstream-sync merges and records each
substantive non-merge behavior family once. The final candidate commit and tree
are reported outside this tracked file to avoid a self-referential identity.

## Frozen inputs

| Identity | Value |
| --- | --- |
| Upstream URL | `https://github.com/can1357/oh-my-pi.git` |
| Upstream default branch | `main` |
| Upstream frozen at | `2026-09-01T00:41:28-04:00` |
| Upstream commit | `eea5628f13043286e17c4a2ea4fc28b15fda33ca` |
| Upstream tree | `257f25692c75703f3b1b81af47b3fb676b59f879` |
| Upstream version | `18.0.11` |
| Prior sync base / shared merge base | `4854db856c20e000a3760d793c56d78065dcf83f` |
| Prior Smarty fork tip | `931a233d51ee528bf30ffc5b7aa93eece82c6295` |
| Prior Smarty fork tree | `2309e9feb9db7b3728e157d683728a451290270f` |
| Accepted donor | `425752a78590b4720d15b901d611c0f7e98cc3ea` |
| Donor tree | `134ad2f82d86f5aef78cf819f31ccc1cd1c7759b` |
| Reconstruction bootstrap | `dc78eba4e50aaf64e7fce9c71075d6e2746e9ae7` |
| Bootstrap tree | `134ad2f82d86f5aef78cf819f31ccc1cd1c7759b` |

The reconstruction branch starts directly at the frozen upstream commit. It
contains no upstream-sync merge and no blind replay of the donor history.

## Retained Smarty fork baseline

The 17.3.5 ledger remains the semantic baseline for retained fork behavior. The
18.0.11 reconstruction uses the causal inventory from the prior sync base to
the accepted donor rather than treating the raw 303-commit compare as a replay
plan. Legacy source patch identities below name the behavior provenance; the
current implementation is reconstructed against the 18.0.11 architecture.

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
| `4b9f43c46` shared model registry test | Upstream equivalent; dropped | The 17.3.5 upstream baseline already uses `sharedModelRegistry` in the affected concurrent-session test. |
| `c163469f4`, `1fada2bb8`, `6554ee22c` generated Bazel locks | Obsolete snapshots; regenerated | Not replayed. Current lock regenerated from the reconstructed source and committed as `b0b80f62a`. |
| `fc77ce35b` builder marker test | Reapplied | Retained with the current builder tests in `701d41cc1`. |
| `7b606eb05` async fixture restoration | Reapplied | Retained with current todo/extension fixtures in `701d41cc1`. |
| `e9cc2c85d`, `27db8f410` compatibility repairs | Selectively reimplemented | Current Antigravity fixtures, setup-wizard short-terminal behavior, SessionTools wording compatibility, timeout recovery, todo setup, exit dependencies, and CI chunking in `701d41cc1`. |
| `daaf11a80`, `c8d1f98b9`, `bb7fbceb2` managed-session/native/print ownership | Reimplemented as one causal unit | Semantic delivery IDs, companion ownership, lifecycle fences, terminal metadata, goal parsing, headless drain, and hard-exit behavior in `701d41cc1`; current final-boundary repairs in `502c79a37`, `de925db98`, and `4fba4d0ce`. |
| `384bd111c` managed-session fixtures | Reapplied | Tree ask/re-answer/navigation and concurrent-dispose assertions retained with the reconstructed lifecycle. |
| `64477987d`, `4439797a0` independent collaboration renderers | Reimplemented as one transport unit | Local transport, bridge commands, authority/display/transcript validation, protocol 4, install smoke, and tests in `701d41cc1`. |
| `560e4b4b5` queue-safe CI and `.mergify.yml` | Retained and adapted | The 17.3.5 baseline established queue refs, the always-run `smarty_ci` aggregate, and serial one-at-a-time Mergify policy; the 18.0.11 reconstruction preserves the current equivalents. |

## Context and autonomy mission patches

These patches formed a strict dependency chain in the 17.3.5 reconstruction.
Their retained semantics are now repaired against the 18.0.11 shared runtime seams.

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

## 18.0.11 reconstruction delta

Upstream 18.0.11 replaces substantial catalog, compatibility, provider, and
session plumbing. The reconstruction preserves that architecture and restores
only the retained Smarty behavior at current shared seams.

| Behavior family | Current reconstruction | Proof and residual accounting |
| --- | --- | --- |
| Context, provenance, protected scope, and Stack admission | Typed context delivery, exact source attribution, candidate scope coverage, deterministic protected ordering, and runtime policy warnings remain bound to the current prompt pipeline. | Workspace TypeScript checks and generated prompt-manifest validation pass. |
| Goal, todo, advisor, async, and semantic-delivery lifecycle | Current session transactions preserve companion ownership, durable retiming, passive late delivery, goal authority, and upstream switch-context capture. | Focused session/switch/tool-rebuild suite: 219 pass, 1 residual ACP snapshot polling timeout because the sink consumes the job before the test observes queued state. |
| Herdr bridge, queue steering, and hyperlink metadata | Managed renderer handoff, queue-safe steering, per-target file links, and process-local hyperlink settings are reconciled with current TUI/runtime ownership. | Cross-project resume and hyperlink suites: 46 pass. |
| Provider, catalog, and thinking compatibility | Cursor/Devin protocol updates, OpenAI-compatible provider repairs, Qwen backend projection, and the KDL-owned 2.4T mandatory-effort exception are preserved. | AI suites: 45 pass. Catalog compatibility/thinking suite: 56 pass, 1 residual authored-cache expectation that still treats Qwen 3.8 27B as mandatory although the KDL rule limits mandatory effort to 2.4T. |
| Discovery, commit, and isolation integration | Custom-backend reasoning projection, context-versioned discovery caching, Git-backed commit fixtures, and deferred isolation cleanup are reconciled with current native Git ownership. | Focused discovery/commit/isolation suite: 40 pass, 3 residuals: one clean-repository fixture skips the completion path, and two cache cases expose that the configured discovery namespace does not encode a later `qwenTemplateReasoningEffort: false` opt-out. |
| Landing policy | Accepted donor policy narrows unchanged-head retry to typed `/smarty-land REPAIR_REQUIRED` external/transient results and requires a fresh helper-derived `-r2` request ID. | Prompt registry generation and exact manifest check pass. |

Each residual above received one repair-and-reverify round. Repository policy
requires reporting the remaining evidence instead of applying another repair
or review pass to the same finding.

## Deterministic proof commands

```sh
git log --reverse --no-merges --format='%H %s' 4854db856c20e000a3760d793c56d78065dcf83f..425752a78590b4720d15b901d611c0f7e98cc3ea
git log --cherry-pick --right-only eea5628f13043286e17c4a2ea4fc28b15fda33ca...425752a78590b4720d15b901d611c0f7e98cc3ea --no-merges
git diff --name-only eea5628f13043286e17c4a2ea4fc28b15fda33ca..HEAD
(cd packages/coding-agent && bun run gen:prompt-manifest:check)
bun packages/coding-agent/src/cli.ts context manifest --json
bun packages/coding-agent/src/cli.ts context diff --base eea5628f13043286e17c4a2ea4fc28b15fda33ca --target HEAD --json
bun packages/coding-agent/src/cli.ts context protected-delta --repository . --base eea5628f13043286e17c4a2ea4fc28b15fda33ca --target HEAD --json
```

Generated hashes, exact final candidate identity, upstream-freshness evidence,
test accounting, baseline-reproduced failures, and the immutable reviewer
verdict belong to the final handoff because they describe the commit containing
this file.
