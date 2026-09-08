# TASK 210 — the 6-tap LANE_PIN sequence (3,1,4,1,5,9) is re-typed across the Maestro flows, and the lane credential literals are mirrored from `harness-provision.ts` into YAML by hand

**Depends on:** 201 (landed the promoted flows + `harness-provision.ts` LANE_* constants)
**Blocks:** — (maintainability; no behavior change)
**SEC ids owned by THIS task:** none.
**Priority:** LOW — **largely deferrable.** The actionable dedup is narrow and partly by-design; the cross-language part is structurally unavoidable (Maestro YAML cannot import TS). Filed for the record per §2.7 so it is not lost, not as a merge blocker.
**Filed by:** review-wave of task 201 (2026-09-08), duplication lens; **CONFIRMED real** but ranked the weakest of the three duplication findings (adversarial verify noted 02 inlines the taps by deliberate design).

## The finding

- The pin-pad tap sequence `pin-pad.key.` `3 / 1 / 4 / 1 / 5 / 9` is hardcoded **twice**: `.maestro/02-pin-entry.yaml:30-40` and `.maestro/subflows/unlock.yaml:25-36`.
- The source of truth is `LANE_PIN = '314159'` at `packages/harness/src/harness-provision.ts:48`; sibling lane credentials `LANE_OTP` (`:45`) and `LANE_OWNER_LOGIN` (`:39`) are likewise re-typed as literals into `.maestro/01-launch-enrollment.yaml` (~`43`,`46`).
- If a seeded credential changes in `harness-provision.ts`, every Maestro literal must be hand-updated in lockstep or the enroll/unlock flows silently fail (a wrong PIN just lands the pad in its `wrong` state and the `notes.list` assert never passes — no explicit "credential mismatch" signal).

## Why this is mostly unavoidable / low value

- **Cross-language mirror is structural.** Maestro YAML cannot import a TS constant, so `LANE_PIN`/`LANE_OTP`/`LANE_OWNER_LOGIN` MUST be re-typed somewhere in the flows. The TS side already documents itself as the single source (`harness-provision.ts:36-48` comments say the flows "type as literals" these values, and both YAML files cite `LANE_PIN = '314159', packages/harness/src/harness-provision.ts`).
- **02 inlines the taps ON PURPOSE.** `.maestro/02-pin-entry.yaml:1-3` states it is "Standalone and explicit … it drives the pad key-by-key rather than delegating to `subflows/unlock.yaml`, so it is the first-class evidence that a correct PIN unlocks the session." Collapsing 02 into `runFlow: subflows/unlock.yaml` would delete that first-class evidence — a deliberate design choice, not accidental duplication.

## The only actionable options (pick one, or decline)

1. **Decline / record-only (recommended default).** Keep both — 02's inline taps are intentional evidence; the cross-language literal mirror is unavoidable. Leave this task `todo`/deferrable as the audit trail. Re-evaluate only if a third flow starts re-typing the taps.
2. **Single-source the CREDENTIAL literals as documented values**, not code: add a one-line `# source of truth: packages/harness/src/harness-provision.ts LANE_PIN/LANE_OTP/LANE_OWNER_LOGIN — keep in lockstep` header to each flow that mirrors them (01, 02, unlock), so the coupling is explicit at every mirror site (it is already noted at some). Zero behavior change; cheapest real improvement.
3. **De-dup only the downstream taps** (03–06 unlock hop) via `runFlow: subflows/unlock.yaml` — which they already do — and leave 02 explicit. Confirm no OTHER flow inlines the taps; if none does, there is nothing left to extract and this reduces to option 1.

## FALSIFY (if any change is made)

- If any credential/tap literal is touched, run the emulator lane's enroll + unlock flows (`.maestro/01-launch-enrollment.yaml`, `02-pin-entry.yaml`, and a downstream flow that `runFlow`s `unlock.yaml`) and confirm they still reach `notes.list` — a wrong literal reds silently at the `notes.list` assert, so verify the GREEN, not just "changed".
- Confirm `LANE_PIN`/`LANE_OTP`/`LANE_OWNER_LOGIN` still match between `harness-provision.ts` and every YAML mirror after the edit.

## Acceptance

- Either: this task is consciously **declined/deferred** (option 1) with the rationale recorded here; OR the chosen small improvement (option 2/3) lands with every credential/tap literal still matching `harness-provision.ts` and the emulator enroll+unlock flows green.
- No new gate, no `ci.yml` change, no behavior change to the flows.

## Note

Lowest-priority of the review-wave-201 duplication findings. Do not spend effort disproportionate to LOW; option 2 is the cap on reasonable effort here.
