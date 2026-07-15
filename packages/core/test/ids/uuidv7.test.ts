// UUIDv7 generator (08-stack-and-repo §2.3): implemented inside @bolusi/core over the
// injected rng/clock — no uuid dependency, deterministic-testable (T-6). RFC 9562 §5.7
// layout, §6.2 monotonic-random for same-ms ordering. Ids are lowercase canonical text
// (10-db §2), version 7, variant 0b10.
import { createUuidV7Generator } from '@bolusi/core';
import { zUuidV7 } from '@bolusi/schemas';
import { mulberry32, randomBytes as prngBytes, type Prng } from '@bolusi/test-support';
import { describe, expect, it } from 'vitest';

/** A settable fake clock (T-6) — no wall clock is ever read. */
function fakeClock(startMs: number): { now: () => number; set: (ms: number) => void } {
  let value = startMs;
  return { now: () => value, set: (ms) => (value = ms) };
}

/** An injected rng bound to a seeded mulberry32 (T-6, §3.3). */
function seededRandomBytes(seed: number): { randomBytes: (n: number) => Uint8Array; prng: Prng } {
  const prng = mulberry32(seed);
  return { randomBytes: (n: number) => prngBytes(prng, n), prng };
}

/** Strip dashes → 32 lowercase hex chars. */
function hex(id: string): string {
  return id.replace(/-/g, '');
}

describe('createUuidV7Generator', () => {
  it('sets the version nibble to 7', () => {
    const clock = fakeClock(1_700_000_000_000);
    const next = createUuidV7Generator({
      now: clock.now,
      randomBytes: seededRandomBytes(1).randomBytes,
    });
    // Version is the 13th hex nibble (RFC 9562 §5.7): dashed index 14.
    expect(next().charAt(14)).toBe('7');
  });

  it('sets the variant bits to 0b10 (first nibble of group 4 in {8,9,a,b})', () => {
    const clock = fakeClock(1_700_000_000_000);
    const next = createUuidV7Generator({
      now: clock.now,
      randomBytes: seededRandomBytes(2).randomBytes,
    });
    // Variant nibble is dashed index 19.
    for (let i = 0; i < 50; i += 1) {
      expect('89ab', `variant nibble of id #${i}`).toContain(next().charAt(19));
    }
  });

  it('encodes the injected clock ms as the leading 48-bit timestamp', () => {
    const ms = 1_726_000_000_123;
    const clock = fakeClock(ms);
    const next = createUuidV7Generator({
      now: clock.now,
      randomBytes: seededRandomBytes(3).randomBytes,
    });
    const id = next();
    // First 12 hex chars = the 48-bit unix_ts_ms.
    expect(Number.parseInt(hex(id).slice(0, 12), 16)).toBe(ms);
  });

  it('produces lowercase canonical text that validates as UUIDv7', () => {
    const clock = fakeClock(1_700_000_000_000);
    const next = createUuidV7Generator({
      now: clock.now,
      randomBytes: seededRandomBytes(4).randomBytes,
    });
    for (let i = 0; i < 100; i += 1) {
      const id = next();
      expect(id).toBe(id.toLowerCase());
      // The canonical validator: only real v7 ids parse (interrogated oracle, T-13).
      expect(() => zUuidV7.parse(id)).not.toThrow();
    }
  });

  it('is strictly monotonic for many ids sharing one millisecond (RFC 9562 §6.2)', () => {
    const clock = fakeClock(1_700_000_000_000); // never advanced — all ids share this ms
    const next = createUuidV7Generator({
      now: clock.now,
      randomBytes: seededRandomBytes(5).randomBytes,
    });
    const ids = Array.from({ length: 500 }, () => next());
    expect(new Set(ids).size, 'all ids distinct').toBe(ids.length);
    const sorted = [...ids].sort();
    expect(sorted, 'lexical order === generation order within one ms').toEqual(ids);
  });

  it('stays strictly ascending as the clock advances', () => {
    const clock = fakeClock(1_700_000_000_000);
    const rng = seededRandomBytes(6);
    const next = createUuidV7Generator({ now: clock.now, randomBytes: rng.randomBytes });
    const ids: string[] = [];
    const stepPrng = mulberry32(99);
    for (let i = 0; i < 300; i += 1) {
      clock.set(clock.now() + Math.floor(stepPrng() * 5)); // 0..4 ms — forces same-ms + advance
      ids.push(next());
    }
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never regresses ordering when the injected clock rolls backwards', () => {
    const clock = fakeClock(1_700_000_000_000);
    const next = createUuidV7Generator({
      now: clock.now,
      randomBytes: seededRandomBytes(7).randomBytes,
    });
    const a = next();
    clock.set(clock.now() - 60_000); // clock jumps back 60s
    const b = next();
    expect(b > a, 'monotonicity survives a backwards clock').toBe(true);
  });

  it('is fully deterministic given the same seed and clock schedule', () => {
    const schedule = [10, 10, 11, 11, 11, 20];
    const run = (seed: number): string[] => {
      let idx = 0;
      const next = createUuidV7Generator({
        now: () => schedule[Math.min(idx, schedule.length - 1)]!,
        randomBytes: seededRandomBytes(seed).randomBytes,
      });
      return schedule.map(() => {
        const id = next();
        idx += 1;
        return id;
      });
    };
    expect(run(1234)).toEqual(run(1234));
    expect(run(1234)).not.toEqual(run(5678));
  });
});
