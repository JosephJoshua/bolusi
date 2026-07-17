// IdSource — UUIDv7 from a FakeClock's ms + a seeded PRNG (testing-guide §3.3, T-6).
//
// `ctx.newId()` delegates to an injected `IdSource` (04 §5.2; core `runtime/ports.ts`). The
// PRODUCTION source is core's `createUuidV7Generator` over the system clock + a CSPRNG; the
// TEST/harness source is the SAME generator over a FakeClock + mulberry32, so ids — and the
// canonical order `(timestamp, deviceId, seq)` that depends on them — reproduce bit-for-bit
// per seed. This is a thin wiring of core's generator, NOT a second UUIDv7 implementation
// (CLAUDE.md §2.8, T-7): the harness owns no protocol logic.

import { createUuidV7Generator, type IdSource } from '@bolusi/core';

import { randomBytes, type Prng } from './prng.js';

/**
 * Build a seeded, FakeClock-driven `IdSource`.
 *
 * @param clock any `{ now(): number }` (a `FakeClock`) — supplies the 48-bit unix_ts_ms.
 * @param prng  a mulberry32 stream — supplies the 74 random bits (rand_a‖rand_b).
 */
export function makeIdSource(clock: { now(): number }, prng: Prng): IdSource {
  return createUuidV7Generator({
    now: () => clock.now(),
    randomBytes: (length: number) => randomBytes(prng, length),
  });
}
