// The Sync Status screen (design-system §8.4/§4; 03 §8/§10; 01 §5.2).
//
// The suite is organised around the screen's thesis: OFFLINE IS NOT A PROBLEM. The first describe
// block is the one that matters — it drives the states that most apps render identically (offline
// vs broken) and asserts they come out different.
//
// Boundary ages are computed from the EXPORTED 03 §8 constants; there is no numeric age literal in
// this file (this task's acceptance says so explicitly).
import { selectBanner } from '@bolusi/ui';
import { describe, expect, test } from 'vitest';

import {
  STALENESS_STALE_MS,
  STALENESS_WARNING_MS,
  type SyncLoopState,
  type SyncState,
} from '@bolusi/core';

import {
  bannerCauses,
  isOfflineButHealthy,
  manualSync,
  mediaQueue,
  MEDIA_STATUS_KEY,
  reassurance,
  REASSURANCE_KEY,
  showsRejectedSection,
  staleness,
  syncChipState,
  syncProblems,
  type MediaRow,
  type RejectedOpRow,
  type SyncStatusInput,
} from './model.js';

const NOW = 1_700_000_000_000;

/**
 * `@bolusi/core`'s `SyncState` (task 15), replacing task 24's local stopgap. Two renames came with
 * the repoint and both are the real shape, not a preference: `lastServerTimeAt` →
 * `lastServerTimeReceivedAt`, and `loopState` is GONE — 03 §10 keeps the loop state in memory, so
 * it is not a column and not on this record. It arrives on `SyncStatusInput` instead.
 */
function state(overrides: Partial<SyncState> = {}): SyncState {
  return {
    cursor: 0,
    devicesDirectoryVersion: 0,
    lastSuccessfulSyncAt: NOW,
    lastPushAt: null,
    lastPullAt: null,
    pushHalted: false,
    syncDisabled: false,
    syncDisabledReason: null,
    lastSyncError: null,
    backoffUntil: null,
    lastServerTime: NOW,
    lastServerTimeReceivedAt: NOW,
    ...overrides,
  };
}

function input(overrides: Partial<SyncStatusInput> = {}): SyncStatusInput {
  return {
    state: state(),
    loopState: 'idle' satisfies SyncLoopState,
    pendingOperationCount: 0,
    pendingMediaCount: 0,
    rejected: [],
    quarantined: [],
    media: [],
    isOffline: false,
    manualSyncBusy: false,
    manualSyncError: null,
    now: NOW,
    ...overrides,
  };
}

function rejectedRow(code: string): RejectedOpRow {
  return {
    opId: `op-${code}`,
    type: 'notes.note_created',
    at: NOW,
    rejectionCode: code,
    rejectionReason: 'detail',
  };
}

describe('THE THESIS — offline is a normal state, not an error', () => {
  test('offline with nothing wrong raises NO problem at all', () => {
    const given = input({ isOffline: true });
    expect(syncProblems(given)).toEqual([]);
    expect(isOfflineButHealthy(given)).toBe(true);
  });

  test('offline with a pile of pending work STILL raises no problem — unsynced ≠ unsaved (§4.3)', () => {
    // The routine case for this shop: days offline, dozens of local ops. Nothing here is wrong.
    const given = input({ isOffline: true, pendingOperationCount: 47, pendingMediaCount: 12 });
    expect(syncProblems(given)).toEqual([]);
    expect(isOfflineButHealthy(given)).toBe(true);
    // And the app says so as a RECEIPT, not a warning.
    expect(reassurance(given)).toEqual({ kind: 'savedHere', pendingOperationCount: 47 });
    expect(REASSURANCE_KEY.savedHere).toBe('sync.status.pending');
  });

  test('the offline chip is the neutral `offline`, never `attention` (§4 rule 6)', () => {
    expect(syncChipState(input({ isOffline: true }))).toBe('offline');
    expect(syncChipState(input({ isOffline: true, pendingOperationCount: 47 }))).toBe('offline');
  });

  test('being offline NEVER disables manual sync — the loop decides, not NetInfo', () => {
    expect(manualSync(input({ isOffline: true }))).toEqual({ kind: 'ready' });
  });

  test.each([
    [
      'a revoked device',
      input({
        isOffline: true,
        state: state({ syncDisabled: true, syncDisabledReason: 'device_revoked' }),
      }),
    ],
    ['a broken chain', input({ isOffline: true, state: state({ pushHalted: true }) })],
    ['a rejected op', input({ isOffline: true, rejected: [rejectedRow('SCHEMA_INVALID')] })],
    [
      'a quarantined op',
      input({ isOffline: true, quarantined: [{ opId: 'op-1', deviceId: 'device-2' }] }),
    ],
  ])('offline + %s IS a problem — the distinction survives being offline', (_label, given) => {
    // The other half of the thesis: "offline is fine" must not become "offline hides everything".
    // Each of these means data is not where the user thinks it is, and being offline changes nothing
    // about that.
    expect(syncProblems(given).length).toBeGreaterThan(0);
    expect(isOfflineButHealthy(given)).toBe(false);
    expect(syncChipState(given)).toBe('attention');
    expect(reassurance(given).kind).toBe('attention');
  });
});

describe('staleness tiers, in both directions (03 §8)', () => {
  const syncedAt = (age: number): SyncState =>
    state({ lastSuccessfulSyncAt: NOW - age, lastServerTime: NOW, lastServerTimeReceivedAt: NOW });

  test('never synced is `stale` — the loud banner (03 §8: "or never synced")', () => {
    const given = input({ state: state({ lastSuccessfulSyncAt: null }) });
    expect(staleness(given)).toBe('stale');
    const banner = selectBanner(bannerCauses(given));
    expect(banner?.variant).toBe('danger');
    expect(banner?.cause).toEqual({ kind: 'staleness', level: 'stale' });
  });

  test('fresh raises no banner — quiet is a feature (§3.6)', () => {
    const given = input({ state: syncedAt(STALENESS_WARNING_MS - 1) });
    expect(staleness(given)).toBe('fresh');
    expect(selectBanner(bannerCauses(given))).toBeNull();
  });

  test('warning at the threshold raises the `warning` banner', () => {
    const given = input({ state: syncedAt(STALENESS_WARNING_MS) });
    expect(staleness(given)).toBe('warning');
    expect(selectBanner(bannerCauses(given))?.variant).toBe('warning');
  });

  test('stale at the threshold raises the `danger` banner', () => {
    const given = input({ state: syncedAt(STALENESS_STALE_MS) });
    expect(staleness(given)).toBe('stale');
    expect(selectBanner(bannerCauses(given))?.variant).toBe('danger');
  });

  test('the tier de-escalates too — a sync heals the banner (03 §8: levels move both ways)', () => {
    expect(staleness(input({ state: syncedAt(STALENESS_STALE_MS) }))).toBe('stale');
    expect(staleness(input({ state: syncedAt(STALENESS_WARNING_MS) }))).toBe('warning');
    expect(staleness(input({ state: syncedAt(0) }))).toBe('fresh');
    expect(selectBanner(bannerCauses(input({ state: syncedAt(0) })))).toBeNull();
  });

  test('a rejected op outranks staleness in the banner ladder (§3.6)', () => {
    const given = input({
      state: syncedAt(STALENESS_STALE_MS),
      rejected: [rejectedRow('BAD_SIGNATURE')],
    });
    const banner = selectBanner(bannerCauses(given));
    expect(banner?.cause).toEqual({ kind: 'rejectedOps' });
    expect(banner?.suppressedCount).toBe(1);
  });

  test('revocation outranks everything (§3.6 rung 1)', () => {
    const given = input({
      state: state({
        lastSuccessfulSyncAt: null,
        syncDisabled: true,
        syncDisabledReason: 'device_revoked',
      }),
      rejected: [rejectedRow('DEVICE_REVOKED')],
    });
    expect(selectBanner(bannerCauses(given))?.cause).toEqual({ kind: 'deviceRevoked' });
  });
});

describe('the counters are DERIVED — no stored count column exists to read (01 §5.2)', () => {
  test('SyncState carries no count field: the type makes the bug unwritable', () => {
    // 01 §5.2: `pendingOperationCount` / `pendingMediaCount` are derived queries, NEVER stored.
    // The strongest available assertion is structural — the record genuinely has no such key, so a
    // screen cannot read one even by accident. A test that merely checked the rendered number would
    // pass just as happily against a stored column.
    const record: SyncState = state();
    // The key list is @bolusi/core's `SyncState` (task 15), not task 24's stopgap. `loopState` is
    // absent for the same reason the counts are: 03 §10 keeps the loop state in memory, so it is
    // not a column — the record and the DDL agree by construction.
    expect(Object.keys(record).sort()).toEqual([
      'backoffUntil',
      'cursor',
      'devicesDirectoryVersion',
      'lastPullAt',
      'lastPushAt',
      'lastServerTime',
      'lastServerTimeReceivedAt',
      'lastSuccessfulSyncAt',
      'lastSyncError',
      'pushHalted',
      'syncDisabled',
      'syncDisabledReason',
    ]);
    expect(record).not.toHaveProperty('pendingOperationCount');
    expect(record).not.toHaveProperty('pendingMediaCount');
  });

  test('the counts arrive alongside the state and are what the screen renders', () => {
    const given = input({ pendingOperationCount: 3, pendingMediaCount: 2 });
    expect(reassurance(given)).toEqual({ kind: 'savedHere', pendingOperationCount: 3 });
  });

  test('pending media alone still reports work in hand', () => {
    expect(reassurance(input({ pendingMediaCount: 2 })).kind).toBe('savedHere');
  });
});

describe('the reassurance line reads REASSURANCE_KEY — the map the screen renders (task 65, §2.8)', () => {
  // `SyncStatusScreen`'s tier-1 sentence renders `t(REASSURANCE_KEY[reassurance(input).kind])`, so
  // the map is on the shipping path: break a slot and both the screen AND these assertions change.
  // Each case DRIVES the state through `reassurance()` (never a static restatement of the map) and
  // asserts the resulting KEY — the stable identifier, never the localized copy.
  test.each([
    ['allSent', input(), 'sync.status.upToDate'],
    ['savedHere', input({ pendingOperationCount: 3 }), 'sync.status.pending'],
    ['syncing', input({ loopState: 'pushing' }), 'sync.status.syncing'],
    ['syncing', input({ loopState: 'pulling' }), 'sync.status.syncing'],
    ['attention', input({ rejected: [rejectedRow('BAD_SIGNATURE')] }), 'sync.rejected.banner'],
  ] as const)('%s renders %s', (kind, given, key) => {
    const answer = reassurance(given);
    expect(answer.kind).toBe(kind);
    expect(REASSURANCE_KEY[answer.kind]).toBe(key);
  });

  test('the map covers every reassurance kind and no more (T-14 denominator)', () => {
    // If a `Reassurance` arm were added and the map not extended, `satisfies Record<…>` would fail to
    // compile; this pins the runtime shape so a silently-narrowed map cannot pass vacuously.
    expect(Object.keys(REASSURANCE_KEY).sort()).toEqual([
      'allSent',
      'attention',
      'savedHere',
      'syncing',
    ]);
  });
});

describe('the header chip maps all five states from the same fixtures (§8.1)', () => {
  test.each([
    ['synced', input()],
    ['pending', input({ pendingOperationCount: 3 })],
    ['syncing', input({ loopState: 'pushing' })],
    ['syncing', input({ loopState: 'pulling' })],
    ['offline', input({ isOffline: true })],
    ['attention', input({ rejected: [rejectedRow('SCOPE_VIOLATION')] })],
    [
      'attention',
      input({ state: state({ syncDisabled: true, syncDisabledReason: 'device_revoked' }) }),
    ],
  ])('renders `%s`', (expected, given) => {
    expect(syncChipState(given)).toBe(expected);
  });

  test('all five states are reachable — the mapping has no dead arm (T-14 denominator)', () => {
    const reached = new Set([
      syncChipState(input()),
      syncChipState(input({ pendingOperationCount: 1 })),
      syncChipState(input({ loopState: 'pulling' })),
      syncChipState(input({ isOffline: true })),
      syncChipState(input({ rejected: [rejectedRow('BAD_SIGNATURE')] })),
    ]);
    expect([...reached].sort()).toEqual(['attention', 'offline', 'pending', 'synced', 'syncing']);
  });

  test('attention beats syncing, offline and pending — a rejection is never hidden by a spinner', () => {
    const given = input({
      loopState: 'pushing',
      isOffline: true,
      pendingOperationCount: 5,
      rejected: [rejectedRow('UNKNOWN_TYPE')],
    });
    expect(syncChipState(given)).toBe('attention');
  });
});

describe('manual sync (§8.4 item 3)', () => {
  test('ready by default', () => {
    expect(manualSync(input())).toEqual({ kind: 'ready' });
  });

  test('busy while the loop runs (design-system §3.1 `busy`)', () => {
    expect(manualSync(input({ manualSyncBusy: true }))).toEqual({ kind: 'busy' });
  });

  test('disabled WITH an explanation when the device is revoked', () => {
    const given = input({
      state: state({ syncDisabled: true, syncDisabledReason: 'device_revoked' }),
    });
    // A disabled button with no reason is how a user concludes the app is broken.
    expect(manualSync(given)).toEqual({
      kind: 'disabled',
      reasonKey: 'core.rejection.DEVICE_REVOKED',
    });
  });

  test('revocation beats busy — a revoked device must not look like it is trying', () => {
    const given = input({
      manualSyncBusy: true,
      state: state({ syncDisabled: true, syncDisabledReason: 'device_revoked' }),
    });
    expect(manualSync(given).kind).toBe('disabled');
  });

  test('a manual-sync failure is carried as inline text, never as a modal (§8.4 item 3)', () => {
    // The model surfaces the error as a string the screen renders next to the button. There is no
    // modal affordance in the type at all — backoff continues in the background regardless.
    const given = input({ manualSyncError: 'core.errors.NETWORK' });
    expect(given.manualSyncError).toBe('core.errors.NETWORK');
    // A failed manual sync is NOT a problem with the data: nothing was lost, and the loop retries.
    expect(syncProblems(given)).toEqual([]);
    expect(manualSync(given)).toEqual({ kind: 'ready' });
  });
});

describe('rejected + quarantined surfacing (§8.4 items 4/5)', () => {
  test('the rejected section renders only when non-empty', () => {
    expect(showsRejectedSection(input())).toBe(false);
    expect(showsRejectedSection(input({ rejected: [rejectedRow('CHAIN_HALTED')] }))).toBe(true);
  });

  test('a row carries its code and its reason separately — the reason is never the message', () => {
    // The screen renders `translateRejectionCode(row.rejectionCode)` as the message (i18n owns the
    // `core.rejection.<CODE>` derivation AND the unknown-code fallback), and keeps `rejectionReason`
    // for the collapsed technical-details slot. That every code in 05 §8's closed set resolves in
    // BOTH catalogs is proven in rejection-keys.test.ts, against the real catalogs.
    const row = rejectedRow('BAD_SIGNATURE');
    expect(row.rejectionCode).toBe('BAD_SIGNATURE');
    expect(row.rejectionReason).toBe('detail');
  });

  test('quarantined ops are their own loud problem — held out of view, not applied', () => {
    const given = input({ quarantined: [{ opId: 'op-1', deviceId: 'device-2' }] });
    expect(syncProblems(given)).toContainEqual({ kind: 'quarantined', count: 1 });
    expect(syncChipState(given)).toBe('attention');
  });

  test('problems are ordered worst-first when several are true at once', () => {
    const given = input({
      state: state({ pushHalted: true, syncDisabled: true, syncDisabledReason: 'device_revoked' }),
      rejected: [rejectedRow('DEVICE_REVOKED')],
      quarantined: [{ opId: 'op-1', deviceId: 'device-2' }],
    });
    expect(syncProblems(given).map((p) => p.kind)).toEqual([
      'deviceRevoked',
      'pushHalted',
      'rejected',
      'quarantined',
    ]);
  });
});

describe('the media queue (§8.4 item 5)', () => {
  const row = (
    uploadStatus: MediaRow['uploadStatus'],
    progressPercent: number | null = null,
  ): MediaRow => ({ mediaId: `m-${uploadStatus}`, uploadStatus, progressPercent });

  test('`uploaded` rows drop off the queue', () => {
    const media = [row('pending'), row('uploaded', 100), row('failed')];
    expect(mediaQueue(input({ media })).map((r) => r.uploadStatus)).toEqual(['pending', 'failed']);
  });

  test('each queued status has a label key, and `uploading` carries progress', () => {
    expect(MEDIA_STATUS_KEY.pending).toBe('media.status.pending');
    expect(MEDIA_STATUS_KEY.uploading).toBe('media.status.uploading');
    expect(MEDIA_STATUS_KEY.failed).toBe('media.status.failed');
    expect(mediaQueue(input({ media: [row('uploading', 42)] }))[0]?.progressPercent).toBe(42);
  });

  test('a failed upload is not a data problem — the photo is on the device and retryable', () => {
    // media.status.failed is "Gagal mengirim. Ketuk untuk coba lagi." — an action, not an alarm.
    // It must not push the whole screen into `attention`, or a flaky hotspot would cry wolf daily.
    const given = input({ media: [row('failed')], pendingMediaCount: 1 });
    expect(syncProblems(given)).toEqual([]);
    expect(syncChipState(given)).not.toBe('attention');
  });
});
