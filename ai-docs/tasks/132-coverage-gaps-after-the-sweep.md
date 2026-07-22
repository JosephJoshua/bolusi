# TASK 132 — coverage gaps: a shape-asserted chaos seam with no consumer, an untested Android back handler, and a catalog guard that proves membership but not content

**Status:** in-progress
**Priority:** MEDIUM — each is a guard or a seam that looks covered and is not. Filed from the coverage half of the sweep so the gaps are owned rather than rediscovered.
**Depends on:** 26, 123, 24
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA spec-verify + coverage sweep, 2026-07-22.

## Gaps

1. **The chaos `schemaVersion` seam is dead data.** `script.test.ts:97` and `seed-200k.test.ts:72` assert the generator's `schemaVersion` output — but **nothing consumes it**: `generateScript` is imported by no chaos scenario, and `HarnessDevice.createNote` goes through the real command runtime, which stamps the CURRENT version. So the harness has never folded a v1 or v2 `note_created`. The generator is also capped at `1 | 2`, so it can never emit the version production actually sends. testing-guide §3.2.2's obligation is currently satisfied by a shape assertion with no behaviour behind it; the v1/v2 fold paths are covered only by `packages/modules/test/migration.test.ts` hand-building ops.
2. **`useHardwareBack` has no test at all** (used at `App.tsx:144`). Its own header claims "the subscription is re-created whenever `handler` changes … a stale closure left registered would answer for a screen that is no longer on top" — unproven. `zone.ts`'s `backTarget` decision IS tested; the Android `BackHandler` subscription is not. "Typed and compiling ≠ running on the target": Android back could answer for the wrong screen.
3. **The module-catalog guard proves membership, not content** (`module-catalog-coverage.test.ts`, task 123). Set-equality both directions plus a non-vacuity test is genuinely good — but a row with `catalogs: {id:{}, en:{}}` or a no-op `register` passes. The content proof (`notes-catalog-boot.test.tsx`) is hard-coded to `notes` and does not generalize with the registry. Also the denominator regex at `:44` (`^\./([a-z][a-z0-9]*)/screens$`) excludes any module id containing `-` or `_` — such a module drops out of BOTH sides and the equality still passes.
4. **No app-layer media↔sync independence guard.** `packages/core/test/media/sync-independence.test.ts` covers both directions with denominators and a positive control (verified), but the app layer has none: `apps/mobile/src/media/triggers.ts:18-23` and `media/client.ts:78` import from `../bootstrap/triggers.js` (the sync trigger module). Legitimate today — two interval constants and two port types — but nothing asserts it stays that way. FR-1138 erosion at the one layer the core guard doesn't reach. LOW.

## Deliverable
Close each: make the chaos seam actually fold old versions (or delete the dead generator field and say so); test `useHardwareBack`'s subscription lifecycle; extend the catalog guard to assert non-empty content per registered module and widen the id regex; add the app-layer independence assertion. Each fix must be **falsified** — break the thing, watch the specific guard red, restore.
