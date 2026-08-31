# D22 — split the owed-forever SEC red into its own job; retire the CI-oracle tower

**Date filed:** 2026-08-30 (complexity/over-engineering audit, Tier 3 #7) · **Ratified:** 2026-08-31 (owner sign-off) · **Status:** Accepted.
**Governs:** task 194. **Amends:** the CI-parity posture built by tasks 142 → 154 → 166 → 172 → 184 (this replaces the bespoke oracle those tasks patched). **Depends on / preserves:** D21 (SEC-AUTH-10 stays owed).

## What the owner ruled

Approve moving the SEC merge-gate from the bespoke CI-log-parsing oracle to **GitHub-native required status checks**, and splitting the owed-forever SEC-AUTH-10 red out of the `security-sweep` conclusion into its **own non-required job**. Implement the `ci.yml` job split, the oracle deletion, and the `verify.mjs` → `act` swap; **PAUSE before editing branch-protection repo settings** (outward-facing) and present that step separately for a final go.

## Root cause this resolves

SEC-AUTH-10's permanent expected-red **shares one GitHub job conclusion** (`security-sweep`, which runs `pnpm sec:sweep`) with real security checks (secrets scan, dependency audit, the SEC-inventory bookkeeping gates). Because a real red and the owed red are indistinguishable at the job level, an entire tower grew to tell them apart — `ci-parity.mjs` (1507), `ci-status.mjs` (465), their two test suites (785 + 204), `sec-sweep.mjs` (158), and `verify.mjs`'s (312) bespoke CI-emulation. Each of tasks 142/154/166/172/184 patched the *previous wrapper's* blindness. Fixing the conflation at the source removes the reason the tower exists.

## The design

1. **`security-sweep` (REQUIRED — blocks merge).** Runs the real checks only: secrets scan, dependency audit, and the SEC-inventory *regression* gates (a security-guide id with no owning marker, an allowlisted-but-titled id, a NEW untitled id). It **hard-pins the sanctioned owed set to exactly `{SEC-AUTH-10}`**: any other id on the pending allowlist, or SEC-AUTH-10 disappearing without discharge, fails this job (task 166 "failure-mode, not just id"; task 172 "a red for a NEW reason cannot print OWED and pass"). This job must be GREEN today.
2. **`security-owed` (NON-required — expected red, non-blocking).** Reports the SEC-AUTH-10 owed red. Stays red until task 27 commits the device benchmark artifact (D21). It is excluded from branch-protection required checks, so its red never blocks a merge. The split **relocates** the red; it must **never discharge** it.
3. **Branch protection (outward-facing — separate go).** Required status checks = the real jobs incl. `security-sweep`, **excluding** `security-owed`. This is the GitHub-native gate that replaces the oracle.
4. **`verify.mjs` → `act`.** The local "run CI" entry becomes `nektos/act` running the real `ci.yml`, not a hand-written emulation that was never the real CI (memory `bolusi-ci-is-the-ground-truth`).
5. **Delete** `ci-parity.mjs`, `ci-status.mjs`, `sec-sweep.mjs`, `ci-parity.test.ts`, `ci-status.test.ts` once the native gate carries their invariant. Keep `sec-inventory.mjs`, `secrets-scan.mjs`, `dependency-audit.mjs` (the real checks) and the allowlist-derived owed set (task 184).

## Non-negotiable (carried from D21 / §2.11)

- **SEC-AUTH-10 stays RED / owed** until task 27 produces the artifact. Greening it against a params-pinning test is yardstick-moving — forbidden.
- **A NEW `security-sweep` red still BLOCKS.** A different SEC id going red must fail the required job and make the PR unmergeable — proven by falsification, not asserted.
- **The owed set stays DERIVED from the allowlist**, never hand-copied.

## Falsifications required before belief (§2.11)

1. Break a non-owed SEC id's test (e.g. SEC-AUTH-09) → the required job goes red and the PR is **unmergeable** (native required-check *blocks*, not merely prints red). *[branch-protection-dependent → runs after the paused go.]*
2. The owed job is red and does **not** block; SEC-AUTH-10 is the **only** id with that exemption — a second owed id makes the required job red.
3. Delete the oracle, prove no merge dependency is lost — re-run the task-172 (red-for-new-reason blocks) and task-184 (owed set derived, not hand-copied) falsifications against the native mechanism.
4. `act` runs the real workflow and reproduces a known red locally.

## Why this is safe to land in stages

The `ci.yml` split + oracle deletion + `act` swap change *how the red is reported and how merges are gated in principle*, but the branch-protection wiring (step 3) is the only outward-facing, hard-to-reverse action — it is deferred to a separate owner go, so nothing about repo settings changes without a second confirmation.
