// The required emulator correctness gate ids — the ONE list, in a dependency-free module.
//
// WHY ITS OWN FILE (task 175 / 177). The device harness must name these ids to emit its result, but it
// must NOT drag `@bolusi/test-support` into the release bundle to do so: that package's barrel
// re-exports `node-column-aead.js` (`node:crypto`), which Metro cannot resolve for a device build, so a
// single value-import of `registry.ts` (which needs the seed/at-rest machinery) breaks the APK assemble
// (proven by `expo export`; see task 177). Keeping the id list here — imported by BOTH `registry.ts`
// (for `loadHarness().requiredGateIds`) and the device entry `run.ts` — lets the device path stay
// test-support-free while the two lists cannot drift.
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
