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
  syncTitleState,
  type RejectedOpRow,
  type SyncStatusInput,
  type SyncTitleState,
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
      expandedRejectedOpId={null}
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
// actual defect. So each case DRIVES a state through `syncTitleState` and asserts the title the screen
// rendered is the one `SYNC_TITLE_KEY` names for that state — a KEY identity, resolved through the
// real shipping catalog. Two controls keep that from passing vacuously: the fixtures must cover
// every `SyncTitleState` (denominator), and the comparison instrument must be shown to detect
// SAMENESS (oracle), or "all titles are distinct" would be green against any implementation.
//
// task 147 added `photosPending` — the title state the media-blind chip cannot carry (ops sent,
// photos still queued). It is driven through `syncTitleState`, not `syncChipState`, because the two
// deliberately diverge there (the chip stays `synced`); that divergence is witnessed on its own below.

/** Each `SyncTitleState`, DRIVEN through the model — never asserted flat. `photosPending` is task 147. */
const STATE_FIXTURES = [
  ['synced', {}],
  ['pending', { pendingOperationCount: 3 }],
  ['photosPending', { pendingMediaCount: 3 }],
  ['syncing', { loopState: 'pushing' }],
  ['offline', { isOffline: true }],
  ['attention', { rejected: REJECTED }],
] as const satisfies readonly (readonly [SyncTitleState, Partial<SyncStatusInput>])[];

describe('the header title states the actual sync state (task 126/147, design-system §8.1/§8.4)', () => {
  test.each(STATE_FIXTURES)('`%s` renders its own title key', (expected, over) => {
    // T-14b: pin the fixture against the model first, so this case cannot silently be testing a
    // different state than the one it is named for.
    expect(syncTitleState(input(over))).toBe(expected);
    expect(titleOf(over)).toBe(t(SYNC_TITLE_KEY[expected]));
  });

  test('every state resolves a DISTINCT title — one hardcoded title for all of them reds here', () => {
    const titles = STATE_FIXTURES.map(([, over]) => titleOf(over));
    expect(new Set(titles).size).toBe(STATE_FIXTURES.length);
  });

  test('DENOMINATOR: the fixtures cover every title state the map can be asked for (T-14)', () => {
    // Without this, dropping fixtures to a single row would leave "all distinct" trivially true.
    const covered = STATE_FIXTURES.map(([kind]) => kind);
    expect([...covered].sort()).toEqual(Object.keys(SYNC_TITLE_KEY).sort());
    expect(covered).toHaveLength(6);
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

// ── TASK 147: the CHIP and the TITLE, witnessed together in the rendered screen ───────────────────
//
// task 144 item 3 observed that nothing asserts the CHIP's rendered state — only the title — so "the
// chip and the title are one verdict" was by-construction but unobserved. This reads the SyncChip's
// per-state icon testID (`ui.syncChip.icon.<state>`, SyncChip.tsx) AND the title together, on the one
// state where they deliberately diverge (ops sent, photos queued): the chip stays `synced`, the title
// says photos-pending, and NEITHER claims "All Sent" over the pending-photos counter.
describe('the chip and title are witnessed together on the pending-media screen (task 147)', () => {
  /** Which SyncChip icon actually rendered — the ambient verdict, read the way task 144 asked for. */
  function renderedChip(over: Partial<SyncStatusInput>) {
    const screen = renderSync(over);
    const states = ['synced', 'pending', 'syncing', 'offline', 'attention'] as const;
    return states.filter((s) => screen.query(`ui.syncChip.icon.${s}`) !== null);
  }

  test('ops sent + 3 photos queued: chip renders `synced`, title is photos-pending, never "All Sent"', () => {
    const over = { pendingMediaCount: 3, pendingOperationCount: 0 };
    // Pin the fixtures against the model (T-14b) so this cannot drift to a different state silently.
    expect(syncChipState(input(over))).toBe('synced');
    expect(syncTitleState(input(over))).toBe('photosPending');

    // The RENDERED chip is exactly one icon — `synced` — and no phantom sixth chip state leaked.
    expect(renderedChip(over)).toEqual(['synced']);

    // The RENDERED title is the photos-pending key, and specifically NOT the "All Sent" key that
    // shipped over these same three pending photos. Compared as KEYS via the real catalog (not copy).
    expect(titleOf(over)).toBe(t(SYNC_TITLE_KEY.photosPending));
    expect(titleOf(over)).not.toBe(t(SYNC_TITLE_KEY.synced));

    // The counter that contradicted the old headline is still on screen, still counting the photos —
    // the headline now agrees with it instead of denying it.
    const screen = renderSync(over);
    expect(textsIn(screen.get('sync-counter-media'))).toContain('3');
  });

  test('POSITIVE CONTROL: an all-clear device renders the `synced` chip AND the "All Sent" title', () => {
    // The chip witness must be able to SHOW `synced`+titleSynced, or the assertion above proves nothing
    // about divergence. Here chip and title agree on the genuinely-synced verdict.
    expect(renderedChip({})).toEqual(['synced']);
    expect(titleOf({})).toBe(t(SYNC_TITLE_KEY.synced));
  });

  test('POSITIVE CONTROL: pending OPS render the `pending` chip AND the pending title', () => {
    const over = { pendingOperationCount: 3 };
    expect(renderedChip(over)).toEqual(['pending']);
    expect(titleOf(over)).toBe(t(SYNC_TITLE_KEY.pending));
  });
});
