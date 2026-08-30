# TASK 183 — security-guide's SEC-AUTH-09 leg 3 names a "statistical timing test"; the shipped and accepted proof is the structural constant-time one — reconcile the wording

**Priority:** LOW — spec/doc reconciliation. The security property is proven and gated; only the guide's wording lags what actually gates.
**Depends on:** 28 (the SEC-AUTH-09 discharge).
**Blocks:** —
**SEC ids owned by THIS task:** none (it edits the SEC-AUTH-09 spec text, not the id's coverage).
**Filed by:** orchestrator, 2026-07-25, on the SEC-AUTH-09 discharge review (rev-28-sec09).

## The mismatch
`security-guide.md` SEC-AUTH-09 leg 3 has two lines that disagree about what proves the PIN comparison
is constant-time:
- **~line 157** requires "the quick-crypto `timingSafeEqual` equivalent" — a STRUCTURAL constant-time
  compare. This IS what ships: `packages/core/src/auth/verifier.ts:152` `timingSafeEqualBytes` (length
  folded into the accumulator, single OR-accumulate loop, no short-circuit, one terminal compare), on
  the real production PIN path (`verifyPinAgainst` → `pin-verify.ts:187`). Verified in the discharge.
- **~line 186** names a "statistical timing test on equal-length inputs" — which was NOT shipped, and
  which rev-28-sec09 judged the WRONG proof for this target: a statistical timing gate on a managed
  JS/Hermes runtime is dominated by GC/JIT/scheduler noise (the per-byte signal is far smaller), so it
  would be a FLAKY gate proving LESS than the shipped structural+behavioural proof. The D12 timing-vs-
  correctness asymmetry in `28-security-sweep.md` says as much.

The discharge accepted the structural proof (line 157) as the stronger, honestly-caveated evidence and
titled SEC-AUTH-09 on it. Line 186's wording now over-specifies a method the project deliberately did
not use.

## Deliverable
Reconcile the guide so leg 3's acceptance matches what actually gates: the structural `timingSafeEqual`-
equivalent compare on the production PIN path, with the honest caveat that "constant-time" on a managed
runtime is structural/best-effort, not a machine-cycle guarantee. Either delete line 186's statistical-
timing requirement or reframe it as "structural constant-time compare; a statistical timing test is
explicitly NOT required (and is unreliable on the Hermes/JS target — D12)". Keep the property's intent
(no data-dependent early exit); change only the method wording.

## Note
This is a SPEC edit — its own task per CLAUDE.md §4 (do not edit spec content as a side effect of
implementation). No code change. Confirm `sec-inventory.mjs`'s guide parse (the id/roll-up denominator)
still reads SEC-AUTH-09 correctly after the edit — a reworded leg must not change the id count.
