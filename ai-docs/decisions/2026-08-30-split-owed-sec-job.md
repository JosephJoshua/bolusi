# D25 — Owner ruling: split the owed SEC red into its own job and delete the CI-oracle tower

**Date:** decided 2026-08-30 (complexity/over-engineering audit, Tier 3 #7); **ratified 2026-09-16**. · **Status:** Accepted — owner decision ("full delete + native checks").
**Amends:** the merge-gating mechanism introduced by tasks 142 → 154 → 166 → 172 → 184. **Does NOT amend** D21, and does NOT change any SEC id's proof obligation.
**Unblocks:** task 194 (was `blocked` pending exactly this entry).

## What the owner ruled

Stop telling "expected red" from "real red" by parsing CI logs. Give the one permanently-owed check its own CI job, make `security-sweep` fail only on real findings, require *that* job in branch protection, and delete the oracle tower the old arrangement needed.

## The problem this removes

SEC-AUTH-10 is owed until a physical device produces its KDF benchmark artifact (D21). That red is permanent and correct. But it shared the `security-sweep` job conclusion with every real security check, so a red conclusion was ambiguous by construction — and a merge gate cannot be built on an ambiguous signal.

Five tasks were spent patching that ambiguity downstream, each fixing the previous wrapper's blindness:

| Task | What it patched |
| ---- | --------------- |
| 142 | local `verify` vs CI drift — the local tool set was not the CI tool set |
| 154 | the owed bucket absorbed an inventory-level regression |
| 166 | the owed scope absorbed a *different failure mode* on the same owed id |
| 172 | `ci:status` classified owed by job NAME and never called `assert` |
| 184 | the owed set was hand-copied rather than derived from the allowlist |

Every one of those is the same defect: a second-order reader trying to recover, from log text, a distinction the producer had already thrown away.

## The decision

**Fix at the source, not with another wrapper.** The inventory already tags each failure with a machine-readable `[CODE]`. Partition on it where it is produced:

- **`security-sweep`** — fails only on real findings. Expected GREEN. **This is the required check**; any red here blocks the merge.
- **`sec-owed`** — fails only while ids are owed. Expected RED. **Not required**, so it never blocks. Seconds-long: "which ids are owed" is a question about the guide and the allowlist, needing no build and no test lanes.

The job identity now *is* the classification, so nothing downstream has to re-derive it.

### Deleted (~3.3k LOC)

`scripts/ci-parity.mjs` (1507), `scripts/ci-status.mjs` (465), `scripts/verify.mjs` (312), `packages/test-support/src/ci-parity.test.ts` (785), `ci-status.test.ts` (204). Local reproduction of the real workflow is `act`, not a bespoke re-implementation of it — the re-implementation was never the real CI, which is what task 142 existed to discover.

### Explicitly KEPT

`sec-sweep.mjs` and `sec-inventory.mjs` stay. The audit's cut-list named `sec-sweep` for deletion, but it is not an oracle: it runs the SEC inventory, the secrets scan, the dependency/lockfile audit and the frozen-lockfile check. Those are the checks that catch a *new* red, and non-negotiable #2 below requires them. Only the owed assertion moved out of it.

## NON-NEGOTIABLE — what must remain true

1. **SEC-AUTH-10 stays RED and owed** until task 27 produces the device artifact. This ruling **relocates** a red; it must never discharge one. Emptying the allowlist to green the job would discharge the id without its proof — yardstick-moving, forbidden by CLAUDE.md §2.11.
2. **A NEW security red still blocks the merge.** Any failure mode other than the non-empty-allowlist one lands in the blocking bucket, fails `security-sweep`, and fails the required check. An absent or unrecognised code is treated as **blocking** — the partition fails closed, so a mode introduced later blocks on the day it appears rather than waiting to be registered.
3. **The owed set stays DERIVED from the allowlist** (task 184), never hand-copied. One implementation (`pendingOwedIds`) serves both the sweep and the owed job, so they cannot disagree.
4. **Task 166's lesson is structural now.** An owed id is exempt for its allowlist row and for nothing else; a different mode naming that same id is a genuine red. This is enforced by the partition and covered by a negative control that was watched go red.

## Falsification performed before ratifying (§2.11)

- **Owed job derives its red:** emptied the allowlist → `pnpm sec:owed` EXIT=0; restored → EXIT=1 naming `SEC-AUTH-10 → ai-docs/tasks/27-device-gates.md`. The red is read from the file, not hardcoded.
- **Fail-closed default:** flipped the partition so an uncoded failure counted as owed → the fail-closed control went RED (EXIT=1); restored → green.
- **Task-166 absorption:** added `ALLOWLISTED_BUT_TITLED` to the owed-eligible set → the "different mode naming an owed id still blocks" control went RED (EXIT=1); restored → green.

## Residual risk, recorded

Merge-gating now depends on **branch-protection configuration**, which lives in repo settings rather than in the tree — it is not diffable and not reviewable in a PR. That is the accepted trade for deleting ~3.3k LOC of in-tree machinery that was itself a documented source of wrong-reason greens (incidents INC-T11). The required-check set must name `security-sweep` and must **not** name `sec-owed`; if that configuration is ever lost, the symptom is a merge that should have been blocked going through, so the configuration is recorded here and in task 194.
