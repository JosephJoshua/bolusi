// The required emulator correctness gate ids — the ONE list, in a dependency-free module.
//
// WHY ITS OWN FILE (task 175 / 177). This id list is dependency-free so BOTH `registry.ts` (for
// `loadHarness().requiredGateIds`) and the device entry `run.ts` can name the gates from ONE source that
// the two lists cannot drift from. Historically it also kept `@bolusi/test-support` out of any file that
// only needed the ids: the package's barrel re-exports `node-column-aead.js` (`node:crypto`), which Metro
// cannot resolve for a device build. Task 177 fixed the underlying hazard — `registry.ts` now imports the
// device-safe `@bolusi/test-support/device` subpath (no `node:crypto`), so it bundles — but this list
// stays standalone because the no-drift single-source-of-truth reason survives the fix.
//
// Pinned equal to the driver's `EMULATOR_REQUIRED_GATES` (scripts/harness-device.mjs) in
// test/harness-producer.test.ts — the denominator guard (T-14).

/** The correctness gates the emulator lane requires green (D20 §1 correctness subset). */
export const EMULATOR_CORRECTNESS_GATE_IDS: readonly string[] = Object.freeze([
  'SEC-DEV-06-at-rest',
  'SEC-AUTH-09-leg1',
  'SEC-OPLOG-06-jcs',
  'CHAOS-01',
  'CHAOS-03',
  'CHAOS-06',
  'CHAOS-07',
]);
