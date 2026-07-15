import { describe, expect, test } from 'vitest';

import { zClientBookkeeping, zServerBookkeeping, zSyncStatus } from '../src/index.js';

describe('client bookkeeping (05 §2.3)', () => {
  test.each(['local', 'synced', 'rejected'] as const)('syncStatus accepts %s', (status) => {
    expect(zSyncStatus.safeParse(status).success).toBe(true);
  });

  test('syncStatus rejects a value outside the machine', () => {
    expect(zSyncStatus.safeParse('pending').success).toBe(false);
  });

  test('a rejected row with code and reason parses', () => {
    const result = zClientBookkeeping.safeParse({
      syncStatus: 'rejected',
      syncedAt: null,
      rejectionCode: 'CHAIN_BROKEN',
      rejectionReason: 'previousHash mismatch at seq 9',
    });
    expect(result.success).toBe(true);
  });

  test('a synced row with null rejection fields parses', () => {
    const result = zClientBookkeeping.safeParse({
      syncStatus: 'synced',
      syncedAt: 1752481112223,
      rejectionCode: null,
      rejectionReason: null,
    });
    expect(result.success).toBe(true);
  });

  test('non-integer syncedAt fails', () => {
    const result = zClientBookkeeping.safeParse({
      syncStatus: 'synced',
      syncedAt: 1752481112223.5,
      rejectionCode: null,
      rejectionReason: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('server bookkeeping (05 §2.4)', () => {
  test('a valid acceptance row parses', () => {
    const result = zServerBookkeeping.safeParse({
      serverSeq: 8814,
      receivedAt: 1752482334455,
      clockSkewFlagged: false,
    });
    expect(result.success).toBe(true);
  });

  test('non-integer serverSeq fails', () => {
    const result = zServerBookkeeping.safeParse({
      serverSeq: 12.5,
      receivedAt: 1752482334456,
      clockSkewFlagged: false,
    });
    expect(result.success).toBe(false);
  });

  test('non-integer receivedAt fails', () => {
    const result = zServerBookkeeping.safeParse({
      serverSeq: 13,
      receivedAt: '2026-07-14T08:00:00Z',
      clockSkewFlagged: true,
    });
    expect(result.success).toBe(false);
  });

  test('non-boolean clockSkewFlagged fails', () => {
    const result = zServerBookkeeping.safeParse({
      serverSeq: 14,
      receivedAt: 1752482334457,
      clockSkewFlagged: 1,
    });
    expect(result.success).toBe(false);
  });
});
