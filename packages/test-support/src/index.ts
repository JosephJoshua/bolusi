// @bolusi/test-support — golden vectors, determinism kit, fakes, driver-conformance
// suite (08-stack-and-repo §3.2). TEST-ONLY: shipping source never imports this package
// (08 §3.3 rule 6) — it appears in test files, the harness, and CI entry points.
export const PACKAGE_NAME = '@bolusi/test-support' as const;

export { noblePort } from './crypto/noble-port.js';
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
export {
  mulberry32,
  pick,
  randomBytes,
  randomInt,
  shuffle,
  type Prng,
} from './determinism/prng.js';

// Driver-conformance suite (task 04) — identical statement set against better-sqlite3 in
// CI and op-sqlite on device (testing-guide §2.3).
export * from './driver-conformance/index.js';

// Adversarial op builders for the server push-validation surface (task 07; 05 §8–9).
export * from './oplog-fixtures/index.js';
