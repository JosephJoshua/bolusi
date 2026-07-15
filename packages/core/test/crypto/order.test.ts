// Canonical total order (05-operation-log §4): timestamp ASC, deviceId ASC, seq ASC.
//
// FR-1118 hinges on this being a TOTAL order: every device must fold any op set into the
// same sequence regardless of arrival order. Property tests are seeded and deterministic
// (T-6) — each prints its seed on failure and reproduces from that seed alone.
import { compareCanonicalOrder, sortCanonical, type CanonicalOrderKey } from '@bolusi/core';
import { mulberry32, randomInt, shuffle, type Prng } from '@bolusi/test-support';
import { describe, expect, it } from 'vitest';

/** Fixed seeds, every PR (testing-guide §3.3). */
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * Ops drawn from a deliberately TINY value space: 3 timestamps x 3 devices x 3 seqs.
 * Collisions are the point — a large random space would almost never produce the equal
 * timestamps and equal (timestamp, deviceId) pairs where tie-breaking actually matters.
 */
function generateOps(prng: Prng, count: number): CanonicalOrderKey[] {
  const timestamps = [1_700_000_000_000, 1_700_000_000_001, 1_700_000_001_000];
  const deviceIds = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    'ffffffff-ffff-4fff-bfff-ffffffffffff',
  ];
  return Array.from({ length: count }, () => ({
    timestamp: timestamps[randomInt(prng, 0, timestamps.length - 1)] as number,
    deviceId: deviceIds[randomInt(prng, 0, deviceIds.length - 1)] as string,
    seq: randomInt(prng, 1, 3),
  }));
}

describe('compareCanonicalOrder', () => {
  describe('field precedence (05 §4)', () => {
    const base: CanonicalOrderKey = { timestamp: 1000, deviceId: 'device-b', seq: 5 };

    it('orders by timestamp first', () => {
      expect(compareCanonicalOrder({ ...base, timestamp: 999 }, base)).toBeLessThan(0);
      expect(compareCanonicalOrder({ ...base, timestamp: 1001 }, base)).toBeGreaterThan(0);
    });

    it('breaks a timestamp tie by deviceId', () => {
      expect(compareCanonicalOrder({ ...base, deviceId: 'device-a' }, base)).toBeLessThan(0);
      expect(compareCanonicalOrder({ ...base, deviceId: 'device-c' }, base)).toBeGreaterThan(0);
    });

    it('breaks a timestamp+deviceId tie by seq', () => {
      expect(compareCanonicalOrder({ ...base, seq: 4 }, base)).toBeLessThan(0);
      expect(compareCanonicalOrder({ ...base, seq: 6 }, base)).toBeGreaterThan(0);
    });

    it('returns 0 only for an identical triple', () => {
      expect(compareCanonicalOrder(base, { ...base })).toBe(0);
    });

    it('lets an earlier timestamp win even when deviceId and seq both sort later', () => {
      // Precedence, not a blend: a lower timestamp wins regardless of the tie-breakers.
      const earlier: CanonicalOrderKey = { timestamp: 999, deviceId: 'zzz', seq: 999 };
      expect(compareCanonicalOrder(earlier, base)).toBeLessThan(0);
    });

    it('compares deviceId by UTF-16 code unit, not locale', () => {
      // localeCompare would order these by collation rules (and differ across ICU
      // builds); code-unit order is identical on every device. 'B' (0x42) < 'a' (0x61).
      const upper: CanonicalOrderKey = { timestamp: 1, deviceId: 'B', seq: 1 };
      const lower: CanonicalOrderKey = { timestamp: 1, deviceId: 'a', seq: 1 };
      expect(compareCanonicalOrder(upper, lower)).toBeLessThan(0);
    });
  });

  describe.each(SEEDS)('total-order properties (seed %i)', (seed) => {
    const ops = generateOps(mulberry32(seed), 12);

    it('is antisymmetric', () => {
      // Math.sign preserves -0, and toBe uses Object.is (-0 !== 0), so normalize.
      const sign = (value: number): number => Math.sign(value) || 0;
      for (const a of ops) {
        for (const b of ops) {
          expect(sign(compareCanonicalOrder(a, b))).toBe(sign(-compareCanonicalOrder(b, a)));
        }
      }
    });

    it('is transitive', () => {
      for (const a of ops) {
        for (const b of ops) {
          for (const c of ops) {
            if (compareCanonicalOrder(a, b) <= 0 && compareCanonicalOrder(b, c) <= 0) {
              expect(compareCanonicalOrder(a, c)).toBeLessThanOrEqual(0);
            }
          }
        }
      }
    });

    it('is total — equality holds only for an identical triple', () => {
      for (const a of ops) {
        for (const b of ops) {
          const identical =
            a.timestamp === b.timestamp && a.deviceId === b.deviceId && a.seq === b.seq;
          expect(compareCanonicalOrder(a, b) === 0).toBe(identical);
        }
      }
    });

    it('is reflexive', () => {
      for (const op of ops) expect(compareCanonicalOrder(op, op)).toBe(0);
    });
  });

  describe.each(SEEDS)('permutation invariance (seed %i)', (seed) => {
    it('sorts every shuffle of an op set into the identical sequence', () => {
      const prng = mulberry32(seed);
      const ops = generateOps(prng, 20);
      const expected = sortCanonical(ops);

      // Arrival order must not survive into the fold: any permutation converges.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect(sortCanonical(shuffle(prng, ops))).toEqual(expected);
      }
    });

    it('converges despite equal-timestamp and equal-timestamp+deviceId collisions', () => {
      const prng = mulberry32(seed);
      const ops = generateOps(prng, 20);

      // Assert the fixture actually contains the collisions this test claims to cover —
      // otherwise it would silently degrade into a plain sort test.
      const timestampCollisions = ops.length - new Set(ops.map((o) => o.timestamp)).size;
      const pairCollisions =
        ops.length - new Set(ops.map((o) => `${o.timestamp}|${o.deviceId}`)).size;
      expect(timestampCollisions).toBeGreaterThan(0);
      expect(pairCollisions).toBeGreaterThan(0);

      expect(sortCanonical(shuffle(prng, ops))).toEqual(sortCanonical(ops));
    });
  });

  describe('sortCanonical', () => {
    it("does not mutate the caller's array", () => {
      const ops: CanonicalOrderKey[] = [
        { timestamp: 2, deviceId: 'b', seq: 1 },
        { timestamp: 1, deviceId: 'a', seq: 1 },
      ];
      const snapshot = [...ops];
      sortCanonical(ops);
      expect(ops).toEqual(snapshot);
    });

    it('orders a mixed set exactly by (timestamp, deviceId, seq)', () => {
      const ops: CanonicalOrderKey[] = [
        { timestamp: 2, deviceId: 'a', seq: 1 },
        { timestamp: 1, deviceId: 'b', seq: 2 },
        { timestamp: 1, deviceId: 'b', seq: 1 },
        { timestamp: 1, deviceId: 'a', seq: 9 },
      ];
      expect(sortCanonical(ops)).toEqual([
        { timestamp: 1, deviceId: 'a', seq: 9 },
        { timestamp: 1, deviceId: 'b', seq: 1 },
        { timestamp: 1, deviceId: 'b', seq: 2 },
        { timestamp: 2, deviceId: 'a', seq: 1 },
      ]);
    });
  });
});
