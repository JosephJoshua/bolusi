# TASK 142 — nothing runs what CI runs: `main`'s CI was RED for a full day and every local gate said green

**Status:** in-progress
**Priority:** **HIGH (process).** This is the meta-defect behind three separate landed regressions. A repo whose §2.1 rule is "read the tool's OWN output" shipped a day of commits against a gate nobody read.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the orchestrator, 2026-07-22, after reading `gh run list` for the first time in this phase.

## What happened (evidence, not inference)

`gh run list` on 2026-07-22 shows **30+ consecutive failing runs on `main`**, back past 2026-07-21T06:04. Job-level breakdown:

| run | date | failing jobs |
| --- | --- | --- |
| 29805890853 | 07-21 06:04 | `lint`, `security-sweep` |
| 29845762736 | 07-21 15:49 | `lint`, `security-sweep` |
| 29857853172 | 07-21 18:35 | `lint`, `security-sweep`, **`db-client`**, **`unit`**, **`chaos-harness`** |

Three distinct causes, all invisible locally:

1. **`lint` — for over a day.** CI's `lint` job runs `pnpm lint` **and** `pnpm i18n:check`. Locally `pnpm lint` alone is green; the i18n gate was failing on `t('bolusi.task112.absentEverywhere')` in `apps/mobile/src/i18n.test.ts` — a *legitimate* test of §6's missing-key degradation. **Fixed** in `fix(i18n): exclude test files from the extraction gate and assert its denominator`.
2. **`db-client`** — task 120's migration added `media_sha256`/`media_mime` and never regenerated the committed client types; CI's `db:codegen` + `git diff --exit-code` caught it. **Fixed** in `fix(db-client): regenerate client types…`.
3. **`unit` + `chaos-harness`** — `chaos-05-tamper-matrix` T8 fails on all 10 seeds. That one is a REAL product defect (task **127**) and must stay red until 127 lands. The gate is working.

`security-sweep` is red **by design** (SEC-AUTH-09 emulator-pending, SEC-AUTH-10 artifact-pending per D21) — but that is exactly what made the rest invisible: a permanently-red job trains everyone to stop reading the run.

## Why the existing discipline did not catch it

CLAUDE.md §2.1 says read the tool's own output — and every local run *was* read. The gap is that **the local tool set is not the CI tool set**: `pnpm lint` ≠ the `lint` job, `pnpm --filter … test` ≠ the `unit` job, and nothing local runs `db:codegen && git diff --exit-code` or the chaos lane. "Green locally" was a true statement about a different question.

## Deliverable

1. **One command — `pnpm verify` (or `ci:local`) — that runs exactly what CI's push-triggered jobs run**, in the same order, each step capturing `EXIT=` next to its output per §2.1. Derive the step list FROM `.github/workflows/ci.yml` rather than hand-copying it, so the two cannot drift.
2. **A drift gate:** a test that fails when `ci.yml` gains a step the local command does not run. Hand-syncing is what created this task.
3. **Make the by-design red legible.** `security-sweep`'s SEC-allowlist failure must be distinguishable at a glance from a real regression — either a separate job/step whose red is expected and labelled, or a summary line that names which failures are owed vs. unexpected. A gate that is *always* red teaches people to ignore the whole run, which is how items 1-3 above survived a day.
4. Add the merge/push checklist step: **read `gh run list` after pushing to `main`** — an actual command in the merge discipline, not an intention.

## FALSIFY (§2.11 — REPORT it)
- Break one thing per CI job (an unused export, a stale codegen, a missing i18n key, a type error) and confirm `pnpm verify` reds on each with the SAME failure CI reports. A local command that passes while CI fails is the exact defect this task exists to remove.
- Remove a step from the local command → the drift gate reds. Restore → green.
- State the runtime honestly: if full parity is too slow to run per-commit, say so and define the subset + when the full run is mandatory (pre-merge), rather than quietly dropping steps.


---

## ADDENDUM — the same blindness on the other side: two lanes that have NEVER RUN

While reading `gh run list` I checked whether the lanes v0's exit actually depends on had ever executed:

```
event breakdown of the last 60 runs: {'push': 59, 'schedule': 1}
the one schedule run: 29804441399  2026-07-21T05:35  CANCELLED  (only job listed: chaos-nightly)
```

`.github/workflows/ci.yml:478` and `:578` gate `android-emulator` and `ios-simulator` on
`github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'`. That gating is
**deliberate and correct** (the comment at :473-475 explains it: an expensive lane whose first-run
failure should be a red scheduled job, not a false green on a PR). The problem is that neither
trigger has ever produced a completed run — the sole scheduled run was cancelled, and no
`workflow_dispatch` had ever been issued.

**Consequence:** tasks 27a, 85 and 117 have sat `in-progress` against a lane that has never
executed, and **SEC-AUTH-09 leg 1** — the one item D21 says v0's exit still waits on, described
there as "a CI event, not a hardware purchase" — had never been attempted. The gate was not red or
green; it was absent, and nothing said so.

The orchestrator dispatched the first run manually on 2026-07-22 (`gh workflow run ci --ref main` →
run `29890632296`).

**Additional deliverable for this task:** the by-design-skipped lanes must be as legible as the
by-design-red one (item 3 above). A lane that has never run is not evidence of anything, and a task
must not be able to sit `in-progress` citing a lane with no completed run behind it. At minimum:
state in the task index (or the lane's own doc) when each dispatch-only lane last completed, and
make "never" visible.
