# TASK 178 — wire the 7 emulator gate RUNNERS on device now that `@bolusi/test-support` is device-bundle-safe (177): the at-rest `AtRestDeviceEnv` (real op-sqlite seed) + the JCS/chaos on-device runners

**Priority:** HIGH — the remaining half of 27a's emulator correctness lane. Task 177 removed the structural blocker (test-support now has a `/device` subpath with no `node:crypto`, so the gate BODIES bundle into the release APK and the harness imports them). What is left is the on-device SEAMS each gate runs against — none of which is host-verifiable (no AVD on the dev host).
**Depends on:** 177 (device-bundle-safe subpath + wired harness entry), 27a
**Blocks:** 27a going GREEN (its gates stay `skipped` until their runners exist), 28 roll-up indirectly
**SEC ids owned by THIS task:** none directly, but SEC-DEV-06 L6 (at-rest) and SEC-OPLOG-06 land their on-device legs here.
**Filed by:** impl-177, 2026-07-25, from wiring the device-bundle-safe harness — every one of the 7 required gates emits an HONEST `skipped` with a corrected reason (bundle-safety fixed; the seam is not).

---

## Ground truth (what 177 left in place)

After 177, `apps/mobile/src/harness/run-and-emit.ts` calls `loadHarness()` (registry.ts), which resolves the device-safe `@bolusi/test-support/device` subpath into the release bundle (`expo export --platform android` bundles EXIT=0; the OLD barrel fails on `node:crypto` — the 177 falsification). `resolveGateResults(harness)` (run.ts) then emits all 7 `EMULATOR_CORRECTNESS_GATE_IDS` as `skipped`, each detail naming WHY:

- **SEC-DEV-06-at-rest** — the gate BODY (`runAtRestGate` + `checkDbAtRestIsCiphertext`, unit-proven real pass/fail in Node) is importable and bundle-safe. Unbuilt: the on-device `AtRestDeviceEnv` (`apps/mobile/src/harness/part-c/at-rest-device-ctx.ts`) — its `seedEncryptedDb`/`seedUnencryptedControl` seams.
- **SEC-OPLOG-06-jcs, CHAOS-01/03/06/07** — no on-device runner exists at all (the shared-engine JCS-vector / reduced-chaos scenarios replayed on op-sqlite).

## Deliverable

1. **Build the at-rest `AtRestDeviceEnv`.** Seed the 11 signed-off columns (`AT_REST_ENCRYPTED_COLUMNS`: operations ×3, notes ×2, user_pin_verifiers ×3, media_items ×1, quarantined_ops ×1, users_directory ×1) through the REAL app writers (op-sqlite + `deviceColumnAead`), copy the DB file, read back the physically-stored cells, and provide a cipher-disabled control DB for the T-14b positive control. **The COVERAGE check is all-or-nothing by design** — every one of the 11 columns must be populated with a non-null sealed value or the gate fails loudly; a partial seed is a red, not a pass. This means bringing up enrollment (user_pin_verifiers), a rejected op (quarantined_ops), a media attach (media_items), and a user sync (users_directory), not only notes/operations.
2. **Build the JCS-vector + reduced-chaos on-device runners** and return them from `loadHarness()`; wire them into `resolveGateResults(harness)` at the single seam 177 left (each gate id branch in `run.ts`).
3. Every runner falsified before believed (§2.11): a runner that cannot go red is the worst case. The at-rest DETECTION logic is already Node-falsified (`driver-conformance/at-rest.test.ts`); this task falsifies the on-device SEED (a missing column → the coverage red actually fires on the emulator).

## Acceptance

- The `android-emulator` job reaches `harness:device: EMULATOR correctness gates PASS (7 gates, …)` and exits 0, with the capture committed under `reports/device-gates/YYYY-MM-DD-emulator.json`.
- Each gate that goes green did so through a runner that was watched go RED (the seed-missing-a-column falsification for at-rest; the scenario-mismatch falsification for JCS/chaos).
- Node lanes stay green; `@bolusi/test-support/device` stays `node:crypto`-free (the 177 guard `device-bundle-safe.test.ts` stays green).

## Note for the picker

The runId round-trip is ALREADY fixed (177): `HarnessActivity.getLaunchOptions()` reads `intent?.extras` lazily, so `--es bolusiHarnessRunId <id>` reaches JS and the result echoes it (guarded in `test/harness-activity-plugin.test.ts`). Do not re-solve it. The single wiring seam for the runners is `resolveGateResults(harness)` in `apps/mobile/src/harness/run.ts` — 177's header there points at it.
