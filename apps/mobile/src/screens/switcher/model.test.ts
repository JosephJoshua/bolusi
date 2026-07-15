import { describe, expect, test } from 'vitest';

import {
  initialsOf,
  sortByRecency,
  SWITCHER_KEY,
  switcherState,
  tapTarget,
  type SwitcherState,
  type SwitcherUser,
} from './model.js';

function user(overrides: Partial<SwitcherUser> & { id: string; name: string }): SwitcherUser {
  return { photoMediaId: null, lastActiveAt: null, needsFirstPin: false, ...overrides };
}

const SITI = user({ id: 'u-siti', name: 'Siti Rahayu', lastActiveAt: 3_000 });
const YOSEF = user({ id: 'u-yosef', name: 'Yosef Wanggai', lastActiveAt: 1_000 });
const NEVER = user({ id: 'u-new', name: 'Agus Kelasin' });

describe('ordering — most-recently-active first (§8.2, NFR-1003`s 5 s budget)', () => {
  test('the person who just used it is the first row', () => {
    expect(sortByRecency([YOSEF, SITI]).map((u) => u.id)).toEqual(['u-siti', 'u-yosef']);
  });

  test('never-used users sort last, behind everyone who has', () => {
    expect(sortByRecency([NEVER, YOSEF, SITI]).map((u) => u.id)).toEqual([
      'u-siti',
      'u-yosef',
      'u-new',
    ]);
  });

  test('ties break on name — the order is deterministic, so muscle memory holds', () => {
    // A list that reshuffles between renders defeats the recognition it exists to build.
    const a = user({ id: 'u-b', name: 'Budi', lastActiveAt: 5_000 });
    const b = user({ id: 'u-a', name: 'Ani', lastActiveAt: 5_000 });
    expect(sortByRecency([a, b]).map((u) => u.name)).toEqual(['Ani', 'Budi']);
    expect(sortByRecency([b, a]).map((u) => u.name)).toEqual(['Ani', 'Budi']);
  });

  test('the caller`s array is never mutated — a virtualized list must not shift mid-scroll', () => {
    const source = [YOSEF, SITI];
    sortByRecency(source);
    expect(source.map((u) => u.id)).toEqual(['u-yosef', 'u-siti']);
  });
});

describe('the four mandatory states (design-system §5) — all present, all distinct', () => {
  test('null users ⇒ loading', () => {
    expect(switcherState(null, null)).toEqual({ kind: 'loading' });
  });

  test('an empty list ⇒ EMPTY, not error — and it gets the enrollment CTA (§8.2)', () => {
    expect(switcherState([], null)).toEqual({ kind: 'empty' });
  });

  test('a query error ⇒ error, carrying its code for support (§5)', () => {
    expect(switcherState(null, 'UNEXPECTED')).toEqual({ kind: 'error', code: 'UNEXPECTED' });
  });

  test('error wins over a stale list — a failed refresh must not render as data', () => {
    expect(switcherState([SITI], 'UNEXPECTED').kind).toBe('error');
  });

  test('empty and error are different states with different keys (FR-1036)', () => {
    // The bug this guards: rendering `[]` as "nothing here" when the truth is "we could not ask".
    expect(switcherState([], null).kind).not.toBe(switcherState(null, 'UNEXPECTED').kind);
    expect(SWITCHER_KEY.empty).not.toBe(SWITCHER_KEY.error);
    expect(SWITCHER_KEY.empty).not.toBe(SWITCHER_KEY.unauthorized);
  });

  test('every state kind resolves a label key (T-14 denominator)', () => {
    const kinds: SwitcherState['kind'][] = ['loading', 'empty', 'error', 'unauthorized', 'ready'];
    for (const kind of kinds) expect(SWITCHER_KEY[kind]).toMatch(/^[a-z]+\./);
    expect(Object.keys(SWITCHER_KEY).sort()).toEqual([...kinds].sort());
  });

  test('a ready list is sorted on the way out', () => {
    const ready = switcherState([YOSEF, SITI], null);
    expect(ready.kind).toBe('ready');
    expect(ready.kind === 'ready' && ready.users.map((u) => u.id)).toEqual(['u-siti', 'u-yosef']);
  });
});

describe('deactivated users never render — 14 filters them, this model does not re-filter', () => {
  test('the model renders exactly what listSwitcherUsers returned', () => {
    // api/02-auth §5.1 makes "switcher-usable" 14's decision, and 14's `listSwitcherUsers` already
    // excludes `deactivated`. A second filter here would be a second answer to the same question
    // (CLAUDE.md §2.8) — and the two could disagree. The type carries no `status` field at all, so
    // this screen structurally CANNOT render a deactivated user unless 14 hands one over.
    const ready = switcherState([SITI, YOSEF], null);
    expect(ready.kind === 'ready' && ready.users).toHaveLength(2);
    expect(SITI).not.toHaveProperty('status');
  });
});

describe('tapping a card (§8.3, §6.6)', () => {
  test('a user with a verifier goes to the PIN pad', () => {
    expect(tapTarget(SITI)).toEqual({ kind: 'pin', userId: 'u-siti' });
  });

  test('a pinVerifier:null user goes to PIN SETUP, never to a pad they cannot satisfy', () => {
    // Sending them to the pad is a locked door with no key: guesses against a verifier that does
    // not exist still burn attempts, so a brand-new user could lock themselves out on day one.
    const fresh = user({ id: 'u-new', name: 'Agus', needsFirstPin: true });
    expect(tapTarget(fresh)).toEqual({ kind: 'firstPinSetup', userId: 'u-new' });
  });
});

describe('initials for the Avatar (§3.12)', () => {
  test.each([
    ['Siti Rahayu', 'SR'],
    ['Yosef', 'Y'],
    ['Agus Dwi Kelasin', 'AK'],
    ['  Budi   Santoso  ', 'BS'],
    ['yosef wanggai', 'YW'],
  ])('%s → %s', (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });

  test('a blank name still renders something — a card must never be an empty disc', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });

  test('initials are 1–2 characters, as AvatarButton`s contract requires', () => {
    for (const name of ['Siti Rahayu', 'Yosef', 'Agus Dwi Kelasin', '']) {
      expect(initialsOf(name).length).toBeGreaterThanOrEqual(1);
      expect(initialsOf(name).length).toBeLessThanOrEqual(2);
    }
  });
});
