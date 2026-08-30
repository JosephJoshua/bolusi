# TASK 194 — split the owed-forever SEC red into its own job; delete the CI-oracle tower (GATED — owner sign-off)

**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none (this task does not change any SEC id's proof; it relocates where an already-owed red is reported).

**Filed by:** the 2026-08-30 complexity/over-engineering audit (owner-approved cut-list, **Tier 3 #7 — the biggest single LOC win, and the only one that moves a security gate**).

## Blocked on

**Owner sign-off (§6 red flag — moves a SEC gate; governed by D21).** Build the design and present it; do **NOT** touch `ci.yml`, branch protection, or delete any oracle until signed off. Status flips to `todo` only after the owner ratifies with a `decisions/` entry.

## Goal — the root cause of "the weird CI setup"

SEC-AUTH-10's **permanent expected-red shares a GitHub job conclusion** (`security-sweep`) with real security checks. That single design choice forced an entire tower to tell "expected red" from "real red":

- `scripts/ci-parity.mjs` (1507) — the bespoke CI-log-parsing oracle
- `scripts/ci-status.mjs` (465) — a local mirror of it
- `packages/test-support/src/ci-parity.test.ts` (785) + `ci-status.test.ts` (204) — suites over the mirror
- `scripts/sec-sweep.mjs` (158), `scripts/verify.mjs` (312, "run CI locally")

A **5-task patch chain (142 → 154 → 166 → 172 → 184)** each fixed the *previous wrapper's* blindness. **Fix by construction:** give the one owed check (SEC-AUTH-10) its **own 1-line job** so its red never mixes with real checks; gate merges with **GitHub-native required-checks / branch protection**. Then the log-parsing oracle is unnecessary → delete `ci-parity` / `ci-status` / `sec-sweep` + their tests. Replace `verify.mjs`'s bespoke CI-emulation engine with **`act`** (run the real workflow locally). Est. **~2,000–3,400 LOC** removed.

## Must preserve — NON-NEGOTIABLE

1. **SEC-AUTH-10 stays RED / owed** until task 27 produces the device artifact (D21). The split **relocates** the red; it must **never discharge** it. Greening it against a params-pinning test is moving the yardstick (§2.11) — forbidden.
2. **A NEW security-sweep red must still BLOCK merge** — a *different* SEC id going red must fail the PR. GitHub-native required-checks must enforce exactly what task 172 demanded of `ci:status`: a red for a NEW reason cannot print "OWED" and pass.
3. **The owed-id set stays DERIVED from the allowlist** (task 184), not hand-copied.

## Docs to read

- `ai-docs/decisions/2026-07-22-assume-device-performance-passes.md` (D21); CLAUDE.md §2.11 (the CI green-for-wrong-reason stories), §6; memory `bolusi-ci-is-the-ground-truth`.
- `ai-docs/tasks/{142,154,166,172,184}-*.md` (the patch chain this replaces) + their falsifications.

## Files / modules touched (AFTER sign-off only)

- `.github/workflows/ci.yml` (split `security-sweep` → owed check in its own job)
- Branch-protection config (repo settings — **outward-facing, confirm before applying**)
- Delete: `scripts/{ci-parity,ci-status,sec-sweep,verify}.mjs`, `packages/test-support/src/{ci-parity,ci-status}.test.ts`
- The owed-id derivation (from the allowlist)
- New `ai-docs/decisions/2026-08-30-split-owed-sec-job.md`

## Acceptance

- One owed check in its own job (red, non-blocking); real security checks in a required job that blocks on any red.
- Merge-gating uses GitHub-native status, not a bespoke oracle.
- `act` reproduces the real workflow locally.

### Falsification (§2.11 — these are the gates that were green-for-wrong-reason; falsify at the mechanism, not the wrapper)

1. **Force a NON-owed SEC id red** (e.g. break SEC-AUTH-09's test) → the PR must go **RED and be UNMERGEABLE**. Prove the native required-check *blocks the merge*, not merely prints red.
2. **Confirm the owed job** is red and that its red does **not** block — and that SEC-AUTH-10 is the **only** id with that exemption (a second owed id must not be silently absorbed — the task-166 failure-mode-not-just-id lesson).
3. **Delete the oracle, prove no merge dependency lost** — re-run the 172 (red-for-new-reason still blocks) and 184 (owed set derived, not hand-copied) falsifications against the native mechanism.
4. **`act`** runs the real workflow and reproduces a known red locally (replacing `verify.mjs`'s emulation, which was never the real CI — memory `bolusi-ci-is-the-ground-truth`).
