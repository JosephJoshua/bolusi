// @bolusi/test-support — golden vectors, determinism kit, fakes, driver-conformance
// suite (08-stack-and-repo §3.2). TEST-ONLY: shipping source never imports this package
// (08 §3.3 rule 6) — it appears in test files, the harness, and CI entry points.
export const PACKAGE_NAME = '@bolusi/test-support' as const;

export { noblePort } from './crypto/noble-port.js';
export { nodeColumnAead } from './crypto/node-column-aead.js';
export {
  generateSignedCore,
  generateSignedCores,
  type GeneratedSignedCore,
} from './crypto/envelope-generator.js';
export {
  argon2idVectors,
  canonicalizationVectors,
  ed25519Vectors,
  ieee754HexToNumber,
  numberVectors,
  propertySortingVector,
  sha256Vectors,
  type Argon2idVector,
  type CanonicalizationVector,
  type Ed25519Vector,
  type NumberVector,
  type PropertySortingVector,
  type Sha256Vector,
} from './crypto/vectors.js';
// The determinism kit (testing-guide §3.3): PRNG, FakeClock, seeded UUIDv7 IdSource, seeded
// device keypairs, and the notes op-script generator — every seam a chaos run reproduces from.
export {
  mulberry32,
  pick,
  randomBytes,
  randomInt,
  shuffle,
  type Prng,
  FakeClock,
  makeIdSource,
  deriveDeviceKeypair,
  type DeviceKeypair,
  generateScript,
  RECENCY_WINDOW,
  type GenerateScriptOptions,
  type ScriptOp,
  type ScriptOpKind,
} from './determinism/index.js';

// Driver-conformance suite (task 04) — identical statement set against better-sqlite3 in
// CI and op-sqlite on device (testing-guide §2.3).
export * from './driver-conformance/index.js';

// SEED-200K (testing-guide §4.1) — the year-equivalent local history the on-device Part C rebuild /
// execute-latency gates seed (task 27a). Built ahead of its device consumer (the flag-gated harness
// in apps/mobile), like the driver-conformance probe above.
export { generateSeed200k, SEED_200K, type Seed200kSpec } from './seed/seed-200k.js';

// Adversarial op builders for the server push-validation surface (task 07; 05 §8–9).
export * from './oplog-fixtures/index.js';

// The module-contract fixture module (task 11) — 02 §9.3's "fixture module with one gated field
// to keep the mechanism itself under test". Exports the MANIFEST; the caller calls `defineModule`
// (see fixture-module.ts for why that matters).
export {
  FIXTURE_SECRET_PERMISSION,
  FIXTURE_TABLE,
  FixtureParseError,
  fixtureItemsTable,
  itemCreatedPayload,
  listItemsInput,
  makeFixtureModuleManifest,
  type CreateItemInput,
  type FixtureCursorCodec,
  type FixtureDatabase,
  type FixtureItemRow,
  type FixtureItemsTable,
  type FixtureParseIssue,
  type FixtureSort,
  type ItemCreatedPayload,
  type ListItemsInput,
} from './fixtures/fixture-module.js';

// The applier conformance suite (T-8 / testing-guide §2.4) — every module's appliers folded
// through the real projection engine against BOTH engines, oracle-digest-equal.
export {
  runApplierConformance,
  type ApplierConformanceEngine,
  type ApplierConformanceResult,
} from './applier-conformance/index.js';

// CHAOS-07's deterministic scripts + expected-classification table (testing-guide §3.6). Shipped
// by task 17 (which owns the conflict rules) for task 26's harness (which owns the N-device
// convergence run) — one contract, so the two cannot disagree about what the scenario means.
export {
  chaos07Cases,
  chaos07ExpectedConflicts,
  type Chaos07Case,
  type Chaos07ExpectedConflict,
  type Chaos07Op,
  type Chaos07SubCase,
} from './fixtures/chaos-07.js';
