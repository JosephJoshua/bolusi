// mulberry32 — the PINNED PRNG of the determinism kit (testing-guide §3.3).
//
// Pinned means the algorithm is part of the contract: every seeded fixture, op script
// and property test reproduces bit-for-bit from its uint32 seed, on Node and on Hermes
// alike (T-6 — "every randomized test prints its seed on failure and is reproducible
// from that seed alone"). Swapping the algorithm silently invalidates every recorded
// seed, so it is never "just a random number generator".
//
// Scope note: task 03 needs only the PRNG (for the SEC-OPLOG-06 random-envelope
// property test and the comparator property tests). The rest of the kit — FakeClock,
// IdSource, op-script generator, seeded keypairs — is task 26's, and builds on this.

/** A deterministic `[0, 1)` source. */
export type Prng = () => number;

/**
 * Build a mulberry32 PRNG from a uint32 seed.
 *
 * Uses only 32-bit integer ops (`Math.imul`, `>>>`), which behave identically on Hermes
 * and V8 — no float accumulation that could drift between engines.
 */
export function mulberry32(seed: number): Prng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in `[min, max]` (inclusive). */
export function randomInt(prng: Prng, min: number, max: number): number {
  return min + Math.floor(prng() * (max - min + 1));
}

/** Pick one element. Throws on an empty list rather than returning undefined. */
export function pick<T>(prng: Prng, items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('pick() from an empty array');
  return items[randomInt(prng, 0, items.length - 1)] as T;
}

/** `count` deterministic bytes. */
export function randomBytes(prng: Prng, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) out[i] = randomInt(prng, 0, 255);
  return out;
}

/** Fisher-Yates on a copy, driven entirely by `prng`. */
export function shuffle<T>(prng: Prng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(prng, 0, i);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
