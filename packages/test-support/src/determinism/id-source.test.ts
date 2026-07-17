import { describe, expect, test } from 'vitest';

import { FakeClock } from './clock.js';
import { makeIdSource } from './id-source.js';
import { mulberry32 } from './prng.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])([0-9a-f]{3})-([0-9a-f])([0-9a-f]{3})-[0-9a-f]{12}$/;

/** The 48-bit unix_ts_ms prefix (RFC 9562 §5.7) as it renders in the id text. */
function msPrefixHex(id: string): string {
  return id.replace(/-/g, '').slice(0, 12);
}

describe('makeIdSource — UUIDv7 from FakeClock ms + seeded PRNG (testing-guide §3.3, T-6)', () => {
  test('emits syntactically valid UUIDv7: version nibble 7, variant bits 10', () => {
    const source = makeIdSource(new FakeClock(1_700_000_000_000), mulberry32(1));
    const id = source();
    const match = UUID_RE.exec(id);
    expect(match).not.toBeNull();
    // group 1 = version nibble; group 3 = variant nibble (top two bits must be 10 => 8|9|a|b).
    expect(match?.[1]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(match?.[3]);
  });

  test('encodes the FakeClock ms into the 48-bit timestamp prefix', () => {
    const ms = 1_700_000_000_000;
    const source = makeIdSource(new FakeClock(ms), mulberry32(7));
    const id = source();
    expect(msPrefixHex(id)).toBe(ms.toString(16).padStart(12, '0'));
  });

  test('follows the clock: after advance(), the next id encodes the NEW ms', () => {
    const clock = new FakeClock(1_700_000_000_000);
    const source = makeIdSource(clock, mulberry32(3));
    source();
    clock.advance(60_000);
    const id = source();
    expect(msPrefixHex(id)).toBe((1_700_000_000_000 + 60_000).toString(16).padStart(12, '0'));
  });

  test('byte-stable per (seed, clock): two sources built identically emit an identical sequence', () => {
    const a = makeIdSource(new FakeClock(1_700_000_000_000), mulberry32(42));
    const b = makeIdSource(new FakeClock(1_700_000_000_000), mulberry32(42));
    const seqA = Array.from({ length: 32 }, () => a());
    const seqB = Array.from({ length: 32 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  test('a different seed yields a different id sequence (randomness is real, not constant)', () => {
    const a = makeIdSource(new FakeClock(1_700_000_000_000), mulberry32(1));
    const b = makeIdSource(new FakeClock(1_700_000_000_000), mulberry32(2));
    expect(a()).not.toBe(b());
  });

  test('ids minted in the same ms still sort ascending (monotonic; keeps canonical order stable)', () => {
    const source = makeIdSource(new FakeClock(1_700_000_000_000), mulberry32(9));
    const ids = Array.from({ length: 16 }, () => source());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});
