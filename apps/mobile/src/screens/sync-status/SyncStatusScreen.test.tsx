// SyncStatusScreen disables "Sync now" when the device is revoked (design-system §8.4 item 3) — this
// file mounts the real screen to prove `manualSync`'s verdict reaches the button's `disabled` prop.
//
// ── WHY THIS FILE EXISTS (task 69) ──────────────────────────────────────────────────────────────
// `model.test.ts` covers `manualSync(input)` — it can prove the FUNCTION returns `disabled` for a
// revoked device. It cannot prove `SyncStatusScreen` performs the composition it assumes:
// `<Button … disabled={sync.kind === 'disabled'}>`. Break that one prop and a revoked device shows a
// live "Sync now" button that can never do anything — the app looks broken rather than blocked, on a
// screen whose whole job (model.ts's thesis) is to be the app's honesty surface — while every model
// assertion stays green because nothing renders the screen.
//
// The assertion reads the button's public `disabled` prop, never its label — T-4. This mirrors
// `EnrollmentScreen.test.tsx`'s `enroll-bind` disabled check.
import { type SyncLoopState, type SyncState } from '@bolusi/core';
import { t } from '@bolusi/i18n';
import { describe, expect, test, vi } from 'vitest';

import { render, textsIn } from '../../../../../packages/ui/test/render.js';

import { SyncStatusScreen } from './SyncStatusScreen.js';
import {
  manualSync,
  SYNC_TITLE_KEY,
  syncChipState,
  type RejectedOpRow,
  type SyncChipState,
  type SyncStatusInput,
} from './model.js';

const NOW = 1_700_000_000_000;

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

function renderSync(over: Partial<SyncStatusInput> = {}) {
  return render(
    <SyncStatusScreen
      input={input(over)}
      currentUser={{ id: 'user-1', initials: 'PO' }}
      onBack={vi.fn()}
      onSyncNow={vi.fn()}
      onOpenRejected={vi.fn()}
      onRetryMedia={vi.fn()}
      onOpenSwitcher={vi.fn()}
    />,
  );
}

const REVOKED = { syncDisabled: true, syncDisabledReason: 'device_revoked' as const };

const REJECTED: readonly RejectedOpRow[] = [
  {
    opId: 'op-1',
    type: 'notes.create',
    at: NOW - 60_000,
    rejectionCode: 'BAD_SIGNATURE',
    rejectionReason: null,
  },
];

/** The AppShell header title node (`AppShell.tsx` derives it from the screen's own testID). */
const TITLE_NODE = 'sync-status-screen.title';

function titleOf(over: Partial<SyncStatusInput>): string {
  return textsIn(renderSync(over).get(TITLE_NODE)).join('');
}

describe('the "Sync now" button is wired to manualSync`s verdict (design-system §8.4 item 3)', () => {
  test('a revoked device disables the button — a dead loop must not offer a live control', () => {
    const revokedInput = input({ state: state(REVOKED) });
    // T-14b: pin the fixture against the model, so a change to `manualSync` cannot leave this test
    // rendering a `ready` button while claiming to test the disabled one.
    expect(manualSync(revokedInput).kind).toBe('disabled');

    const screen = renderSync({ state: state(REVOKED) });
    expect(screen.get('sync-now').props['disabled']).toBe(true);
  });

  test('POSITIVE CONTROL: a healthy device leaves the button ENABLED — disabled is driven by state', () => {
    // Without this, the test above would pass on a screen that disabled the button unconditionally,
    // an app that can never manually sync. Offline is deliberately still ENABLED (model.ts): pressing
    // it is how a user finds out the connection is back.
    expect(manualSync(input()).kind).toBe('ready');

    const screen = renderSync();
    expect(screen.get('sync-now').props['disabled']).toBe(false);
  });
});

// ── TASK 126: the header title is the STATE, not a constant ───────────────────────────────────────
//
// The defect: `title={t('sync.rejected.title')}` for EVERY state. A fully-synced device was headed
// "Perubahan Ditolak" / "Rejected Changes" over a body reading "Semua perubahan terkirim" — the
// screen contradicting itself in its largest text, on the one surface a shop owner opens to find out
// whether their work is safe.
//
// WHAT IS GUARDED, AND WHY IT IS THE MAPPING RATHER THAN THE COPY. Asserting the title string would
// be asserting UI copy (T-4, repo rule) and would go red on a copyedit while staying green on the
// actual defect. So each case DRIVES a state through `syncChipState` and asserts the title the screen
// rendered is the one `SYNC_TITLE_KEY` names for that state — a KEY identity, resolved through the
// real shipping catalog. Two controls keep that from passing vacuously: the fixtures must cover
// every `SyncChipState` (denominator), and the comparison instrument must be shown to detect
// SAMENESS (oracle), or "all five titles are distinct" would be green against any implementation.

/** Each of design-system §8.1's five chip states, DRIVEN through the model — never asserted flat. */
const STATE_FIXTURES = [
  ['synced', {}],
  ['pending', { pendingOperationCount: 3 }],
  ['syncing', { loopState: 'pushing' }],
  ['offline', { isOffline: true }],
  ['attention', { rejected: REJECTED }],
] as const satisfies readonly (readonly [SyncChipState, Partial<SyncStatusInput>])[];

describe('the header title states the actual sync state (task 126, design-system §8.1/§8.4)', () => {
  test.each(STATE_FIXTURES)('`%s` renders its own title key', (expected, over) => {
    // T-14b: pin the fixture against the model first, so this case cannot silently be testing a
    // different state than the one it is named for.
    expect(syncChipState(input(over))).toBe(expected);
    expect(titleOf(over)).toBe(t(SYNC_TITLE_KEY[expected]));
  });

  test('every state resolves a DISTINCT title — one hardcoded title for all of them reds here', () => {
    const titles = STATE_FIXTURES.map(([, over]) => titleOf(over));
    expect(new Set(titles).size).toBe(STATE_FIXTURES.length);
  });

  test('DENOMINATOR: the fixtures cover every chip state the map can be asked for (T-14)', () => {
    // Without this, dropping fixtures to a single row would leave "all distinct" trivially true.
    const covered = STATE_FIXTURES.map(([kind]) => kind);
    expect([...covered].sort()).toEqual(Object.keys(SYNC_TITLE_KEY).sort());
    expect(covered).toHaveLength(5);
  });

  test('POSITIVE CONTROL: the instrument detects SAMENESS, so distinctness is a real finding', () => {
    // T-13 (interrogate the oracle). If `titleOf` returned something unique per call — a node
    // identity, a fresh object, an empty string that `Set` happened to split — the distinctness test
    // above would pass against a screen that hardcodes one title. Two renders of the SAME state must
    // collapse to ONE entry, and two states known to differ must not.
    expect(new Set([titleOf({}), titleOf({})]).size).toBe(1);
    expect(new Set([titleOf({}), titleOf({ isOffline: true })]).size).toBe(2);
  });

  test('no state is titled with the rejected-SECTION header — the regression itself', () => {
    const sectionHeader = t('sync.rejected.title');
    for (const [kind, over] of STATE_FIXTURES) {
      expect(titleOf(over), `${kind} is titled with the rejected-section header`).not.toBe(
        sectionHeader,
      );
    }
  });

  test('`sync.rejected.title` still heads the rejected SECTION, and only when it renders', () => {
    // The fix must not have made the phrase disappear: §8.4 item 4 keeps it as the section header.
    // Reading the section subtree (not the whole screen) is what proves it moved rather than went.
    const attention = renderSync({ rejected: REJECTED });
    expect(textsIn(attention.get('sync-rejected-section'))).toContain(t('sync.rejected.title'));
    expect(renderSync({}).query('sync-rejected-section')).toBeNull();
  });
});
