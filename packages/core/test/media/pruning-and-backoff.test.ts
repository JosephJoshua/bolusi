// Storage management (06 §7) + the media backoff schedule (03 §4.1).
//
// Pure functions over a FakeClock — no filesystem, no device. That is the point of splitting
// "decide" from "act": 06 §7's rules are the kind that can only otherwise be tested by filling a
// real phone's disk, which means in practice they would never be tested at all.
import { describe, expect, it } from 'vitest';

import {
  MEDIA_BACKOFF_SCHEDULE_MS,
  MEDIA_PERSISTENT_FAILURE_ATTEMPTS,
  ORPHAN_RETENTION_MS,
  UPLOADED_RETENTION_MS,
  bandFor,
  isCaptureRefused,
  isPersistentlyFailing,
  mediaBackoffDelayMs,
  prunePlanFor,
  remoteCacheEvictions,
  retentionWindowMs,
  type PrunableItem,
} from '../../src/index.js';

const NOW = 1_726_000_000_000;
const PLENTY = 4_000_000_000; // 4 GB free — the `normal` band

function item(over: Partial<PrunableItem> = {}): PrunableItem {
  return {
    id: 'm-1',
    localPath: '/doc/media/m-1.jpg',
    uploadStatus: 'uploaded',
    attachedToOperationId: 'op-1',
    capturedAt: NOW - 1_000,
    uploadedAt: NOW - 1_000,
    ...over,
  };
}

describe('backoff schedule (03 §4.1 — owned there, asserted here against the doc)', () => {
  it('is exactly 5s -> 15s -> 60s -> 5min', () => {
    expect(MEDIA_BACKOFF_SCHEDULE_MS).toEqual([5_000, 15_000, 60_000, 300_000]);
  });

  it('indexes by uploadAttempts, 1-based, and caps forever after', () => {
    // Transcribed from 03 §4.1, not derived from the array above.
    const expected: ReadonlyArray<[number, number]> = [
      [1, 5_000],
      [2, 15_000],
      [3, 60_000],
      [4, 300_000],
      [5, 300_000],
      [50, 300_000],
    ];
    let checked = 0;
    for (const [attempts, delay] of expected) {
      expect(mediaBackoffDelayMs(attempts), `attempts=${attempts}`).toBe(delay);
      checked += 1;
    }
    expect(checked).toBe(6); // denominator (T-14)
  });

  it('throws on zero or fractional attempts rather than returning a plausible number', () => {
    // Returning 0 (or the first delay) would hide a caller bug behind a working-looking retry.
    for (const bad of [0, -1, 1.5, NaN]) {
      expect(() => mediaBackoffDelayMs(bad), `${bad}`).toThrow(RangeError);
    }
  });

  it('persistent-failure threshold is >= 5 attempts (03 §4.1; 06 §8)', () => {
    expect(MEDIA_PERSISTENT_FAILURE_ATTEMPTS).toBe(5);
    expect(isPersistentlyFailing(4)).toBe(false);
    expect(isPersistentlyFailing(5)).toBe(true);
    expect(isPersistentlyFailing(6)).toBe(true);
    // Crossing the threshold escalates visibility, it does not stop retrying (03 §4.1) — the
    // delay at 5+ attempts is still a real, scheduled 5 minutes.
    expect(mediaBackoffDelayMs(5)).toBe(300_000);
  });
});

describe('06 §7 free-space bands', () => {
  it.each([
    [4_000_000_000, 'normal'],
    [500_000_001, 'normal'],
    [500_000_000, 'normal'], // "< 500 MB" is strict
    [499_999_999, 'warning'],
    [200_000_000, 'warning'],
    [199_999_999, 'loud'],
    [50_000_000, 'loud'],
    [49_999_999, 'capture_refused'],
    [0, 'capture_refused'],
  ])('%i bytes free => %s', (free, band) => {
    expect(bandFor(free)).toBe(band);
  });

  it('capture is refused below 50 MB — never a silent camera failure (PRD-012 §6)', () => {
    expect(isCaptureRefused(49_999_999)).toBe(true);
    expect(isCaptureRefused(50_000_000)).toBe(false);
  });

  it('uploaded retention drops to 0 below 200 MB, and is 7 days otherwise', () => {
    expect(retentionWindowMs(PLENTY)).toBe(UPLOADED_RETENTION_MS);
    expect(retentionWindowMs(499_999_999)).toBe(UPLOADED_RETENTION_MS); // warning keeps 7d
    expect(retentionWindowMs(199_999_999)).toBe(0); // loud
    expect(retentionWindowMs(10_000_000)).toBe(0); // capture_refused
  });

  it('retention is 7 days, orphan cleanup is 24 h — the pinned numbers (06 §7)', () => {
    expect(UPLOADED_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(ORPHAN_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('06 §7 pruning eligibility', () => {
  it('uploaded + 7 days => file deleted, ROW KEPT (localPath = null is the derived "pruned")', () => {
    const old = item({ uploadedAt: NOW - UPLOADED_RETENTION_MS });
    expect(prunePlanFor(old, NOW, PLENTY)).toBe('delete_file');
    // One millisecond earlier, it is not yet eligible — the boundary is real.
    expect(prunePlanFor(item({ uploadedAt: NOW - UPLOADED_RETENTION_MS + 1 }), NOW, PLENTY)).toBe(
      'keep',
    );
  });

  it('an already-pruned row is idempotent — no second delete', () => {
    expect(
      prunePlanFor(item({ localPath: null, uploadedAt: NOW - UPLOADED_RETENTION_MS }), NOW, PLENTY),
    ).toBe('keep');
  });

  it('orphan + 24 h => ROW AND FILE deleted (06 §4)', () => {
    const orphan = item({ attachedToOperationId: null, uploadStatus: 'pending', uploadedAt: null });
    expect(prunePlanFor({ ...orphan, capturedAt: NOW - ORPHAN_RETENTION_MS }, NOW, PLENTY)).toBe(
      'delete_row_and_file',
    );
    expect(
      prunePlanFor({ ...orphan, capturedAt: NOW - ORPHAN_RETENTION_MS + 1 }, NOW, PLENTY),
    ).toBe('keep');
  });

  it('the orphan rule is checked BEFORE the status rules, or every abandoned capture lives forever', () => {
    // An orphan is `pending` (never attached => never uploaded). If "never prune pending" were
    // evaluated first, `delete_row_and_file` would be unreachable and 06 §4's 24 h rule dead.
    const oldOrphan = item({
      attachedToOperationId: null,
      uploadStatus: 'pending',
      uploadedAt: null,
      capturedAt: NOW - ORPHAN_RETENTION_MS * 2,
    });
    expect(prunePlanFor(oldOrphan, NOW, PLENTY)).toBe('delete_row_and_file');
  });

  it.each(['pending', 'uploading', 'failed'] as const)(
    '%s media is NEVER pruned — at any storage level, however desperate (06 §7)',
    (status) => {
      const unUploaded = item({ uploadStatus: status, uploadedAt: null, capturedAt: NOW - 1e9 });
      let checked = 0;
      // Every band, including the two that trip retention to 0. Un-uploaded evidence is exempt
      // from storage pressure entirely — this is the load-bearing NEGATIVE of §7.
      for (const free of [PLENTY, 499_999_999, 199_999_999, 49_999_999, 0]) {
        expect(prunePlanFor(unUploaded, NOW, free), `${status} @ ${free}`).toBe('keep');
        checked += 1;
      }
      expect(checked).toBe(5); // denominator
    },
  );

  it('< 200 MB prunes uploaded media IMMEDIATELY (retention window 0)', () => {
    const justUploaded = item({ uploadedAt: NOW }); // zero seconds old
    expect(prunePlanFor(justUploaded, NOW, PLENTY)).toBe('keep');
    expect(prunePlanFor(justUploaded, NOW, 199_999_999)).toBe('delete_file');
  });

  it('uploaded with a null uploadedAt is kept — never delete on an unknown clock', () => {
    // 03 §4 sets `uploadedAt` only on complete success, so this shape is a bug. Deleting the file
    // because we cannot date it would destroy evidence to tidy up a bug.
    expect(prunePlanFor(item({ uploadedAt: null }), NOW, 0)).toBe('keep');
  });
});

describe('06 §6/§7 remote cache eviction', () => {
  const entries = [
    { id: 'c-new', lastUsedAt: 300 },
    { id: 'c-old', lastUsedAt: 100 },
    { id: 'c-mid', lastUsedAt: 200 },
  ];

  it('nothing is evicted while storage is normal', () => {
    expect(remoteCacheEvictions(entries, PLENTY)).toEqual([]);
  });

  it('is evicted OLDEST-FIRST, regardless of the input order', () => {
    const evicted = remoteCacheEvictions(entries, 199_999_999);
    expect(evicted).toEqual(['c-old', 'c-mid', 'c-new']);
  });

  it('< 200 MB evicts the cache FULLY (06 §7)', () => {
    expect(remoteCacheEvictions(entries, 199_999_999)).toHaveLength(3);
    expect(remoteCacheEvictions(entries, 0)).toHaveLength(3);
  });

  it('< 500 MB evicts the oldest half — proportional, keeping recently-viewed evidence renderable', () => {
    const evicted = remoteCacheEvictions(entries, 499_999_999);
    expect(evicted).toEqual(['c-old', 'c-mid']);
  });

  it('an empty cache evicts nothing without throwing', () => {
    expect(remoteCacheEvictions([], 0)).toEqual([]);
  });
});
