// @bolusi/test-support/device — the DEVICE-BUNDLE-SAFE surface (task 177).
//
// ── WHY THIS FILE EXISTS (read before adding an export) ─────────────────────────────────────────
// The main barrel `./index.ts` re-exports `nodeColumnAead` (line 7), which `import`s `node:crypto` at
// module top level. Metro bundles EVERY static dependency of an imported module, so the moment the
// on-device harness (`apps/mobile/src/harness/registry.ts` → `at-rest-device-ctx.ts`) imports ANYTHING
// from the barrel, `node:crypto` is dragged into the RELEASE Android bundle and `expo export --platform
// android` fails: `Unable to resolve module node:crypto from …/dist/crypto/node-column-aead.js`. That is
// the exact regression task 177 fixes.
//
// This subpath re-exports ONLY the pieces the on-device harness needs, and its transitive import graph
// touches NO Node-only module. The reachable set is exactly:
//   device.ts → seed/seed-200k.ts → determinism/script.ts, determinism/prng.ts
//             → determinism/prng.ts
//             → determinism/script.ts → determinism/prng.ts
//             → driver-conformance/at-rest.ts   (self-contained; imports nothing)
//             → vectors/jcs.ts                  (the shared RFC 8785 vectors view; imports nothing)
// None of those imports `node:crypto` / `node:*` / `node-column-aead`. `device-bundle-safe.test.ts`
// walks this graph from THIS file and fails if any reachable module reaches a Node-only import — the
// §2.11 guard that keeps the claim above from silently rotting when a new export is added here.
//
// The `.` barrel is UNCHANGED and stays the surface for the Node test lanes (server, other packages);
// this file NEVER re-exports it (that would re-introduce `node:crypto` and defeat the whole point).

// SEED-200K (testing-guide §4.1) — the year-equivalent local history the on-device Part C rebuild /
// execute-latency runners replay. Pure: derives everything from one uint32 seed, touches no DB.
export { generateSeed200k, SEED_200K, type Seed200kSpec } from './seed/seed-200k.js';

// The determinism-kit seams the SEED-200K builder is composed from — the PRNG the seed is derived from
// and the op-descriptor shape the on-device runner maps to real `notes` commands.
export { mulberry32, type Prng } from './determinism/prng.js';
export { type ScriptOp, type ScriptOpKind } from './determinism/script.js';

// SEC-DEV-06's at-rest probe logic + its T-14b positive control (driver-conformance/at-rest.ts). Pure
// byte-level checks over injected seams — imports no DB driver, no filesystem, no `node:crypto`. This is
// the gate BODY the emulator lane's SEC-DEV-06-at-rest runner drives on device.
export {
  AT_REST_ENCRYPTED_COLUMNS,
  checkControlSeedIsWitnessed,
  checkDbAtRestIsCiphertext,
  type AtRestFinding,
  type AtRestProbeContext,
  type SealedCell,
} from './driver-conformance/at-rest.js';

// The shared RFC 8785 (JCS) golden vectors (SEC-OPLOG-06) — the SAME fixture set the Node stage-5 suite
// replays, so the on-device SEC-OPLOG-06-jcs runner (task 178) proves byte-identical canonicalization on
// Hermes against ONE source of truth (T-5), never a device-only copy. Pure data view over the shared
// JSON — no `node:*`, no `crypto/` file — so it stays device-bundle-safe (device-bundle-safe.test.ts).
export {
  numberVectors,
  canonicalizationVectors,
  propertySortingVector,
  ieee754HexToNumber,
  type NumberVector,
  type CanonicalizationVector,
  type PropertySortingVector,
} from './vectors/jcs.js';
