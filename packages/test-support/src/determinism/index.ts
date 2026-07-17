// The determinism kit (testing-guide §3.3) — the seam that makes every chaos scenario and
// property test reproducible bit-for-bit from one uint32 seed (T-6). PRNG, FakeClock, seeded
// UUIDv7 IdSource, seeded device keypairs, and the notes op-script generator.

export { mulberry32, pick, randomBytes, randomInt, shuffle, type Prng } from './prng.js';
export { FakeClock } from './clock.js';
export { makeIdSource } from './id-source.js';
export { deriveDeviceKeypair, type DeviceKeypair } from './keypair.js';
export {
  generateScript,
  RECENCY_WINDOW,
  type GenerateScriptOptions,
  type ScriptOp,
  type ScriptOpKind,
} from './script.js';
