# TASK 113 — the nightly chaos lane's `CHAOS_SCALE=4 × 100 seeds` is impractical for the heavy scenarios; add a per-scenario ×4 nightly seed cap

**Status:** done
**Priority:** LOW — nightly is a scheduled deep run, not a merge gate; nothing is broken today. But the ×4 nightly coverage is currently **unrunnable** for CHAOS-03/08, so it is honest-on-paper only until this lands. Track it so the coverage isn't silently fictional.
**Depends on:** 26 (done — the scale policy + scenarios this sits on)
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the orchestrator, 2026-07-20, from impl-106's flagged open issue (task 106 report §f) — flagged, not silently reduced.

## The finding (task 106, measured)

`chaos:nightly` runs `CHAOS_SCALE=4 × 100 seeds`. Under the D-CHAOS-SCALE policy (testing-guide §3.7), the scenario seed helpers correctly return **every** resolved seed under nightly (guardrail #2 — nightly must not silently sample). That is right for the light scenarios. For the two heavy ones it is unrunnable:

- **CHAOS-03** at ×4 = **56,000 ops/seed** (~40 min/seed measured-extrapolated from the 14,000-op = 526–591s figure) × 100 seeds ≈ **days**.
- **CHAOS-08** at ×4 = **80,000 ops/seed** × 100 seeds — same class.

So the nightly job, as configured, would either never finish or be silently killed — which is the failure mode the whole D-CHAOS-SCALE policy exists to prevent: coverage that reads as "runs everything" while actually running nothing.

## The fix (a JOB-level knob, not a scenario-helper change)

The scenario helpers are correct — they must keep returning all resolved seeds so an explicit `CHAOS_SEEDS=`/nightly reproduction runs the full set. The cap belongs at the **job** level: a per-scenario ×4 nightly seed sample (e.g. the heavy scenarios run the ×4 volume against a *small* seed sample — 3–5 — while the light scenarios keep the full 100). testing-guide §3.7 already documents this as the nightly job's concern; this task wires it.

- Add a per-scenario `nightly ×4 seed cap` (heavy scenarios: CHAOS-03, CHAOS-08 — the two whose single ×4 seed exceeds a sane nightly-per-seed budget; keep the rest uncapped).
- The cap must be **documented and asserted**, never silent (§2.11): the nightly config states which scenarios are ×4-seed-capped and to what, and a test asserts the heavy scenarios' ×4 lane resolves to the capped sample while the light ones resolve to the full set. **Falsify:** remove the cap → the heavy scenario's ×4 seed count returns to the full 100 (the unrunnable state) → the assertion reds.
- Do NOT reduce the ×4 VOLUME (that is the whole point of the ×4 nightly lane — stress at 4× the written volume); cap only the SEED SAMPLE for the heavy scenarios.

## Docs to read
- `ai-docs/testing-guide.md` §3.7 (D-CHAOS-SCALE — the two levers; the nightly ×4 note this task discharges) and §3.6 (CHAOS-03/08 headers).
- `packages/harness/scenarios/chaos-03-days-offline.test.ts` and `chaos-08-rebuild.test.ts` (`chaos03Seeds`/`chaos08Seeds`/`isFullVolume` — understand why the cap must NOT go here) plus the nightly job wiring (`chaos:nightly` in `package.json` / CI).

## Acceptance
- The nightly ×4 lane runs the heavy scenarios at ×4 volume over a small, documented seed sample; the light scenarios keep the full nightly seed set.
- The cap is stated in the nightly config/testing-guide and **asserted with a falsifiable test** (remove the cap → red), so ×4 coverage can never silently become unrunnable-and-therefore-skipped.
- `pnpm typecheck`/`pnpm lint`/`pnpm chaos` (CI lane, unaffected) green — read the output (§2.1).

## Note
Filed because impl-106 flagged this rather than unilaterally reducing nightly coverage — the correct call (a hidden seed cap would be exactly the silent-coverage-cut the policy forbids). It is LOW because nightly is not a gate, but it must be tracked: an unrunnable nightly lane that reports "×4 × 100" is a coverage claim with no coverage behind it.
