import { describe, expect, test } from 'vitest';

import {
  backTarget,
  resolveZone,
  type DeviceStatus,
  type ShellRoute,
  type Zone,
  type ZoneInput,
} from './zone.js';

function input(overrides: Partial<ZoneInput> = {}): ZoneInput {
  return {
    device: 'active',
    session: { userId: 'user-a' },
    locked: false,
    pinFor: null,
    route: 'home',
    ...overrides,
  };
}

describe('resolveZone — the gate (task 24 acceptance)', () => {
  test('unenrolled lands on the enrollment wizard, with no danger banner', () => {
    expect(resolveZone(input({ device: 'unenrolled', session: null }))).toEqual({
      kind: 'enrollment',
      revoked: false,
    });
  });

  test('a revoked device lands on the wizard WITH the danger banner (§8.5)', () => {
    expect(resolveZone(input({ device: 'revoked', session: null }))).toEqual({
      kind: 'enrollment',
      revoked: true,
    });
  });

  test('enrolled with no session lands on the switcher in `choose` mode', () => {
    expect(resolveZone(input({ session: null }))).toEqual({ kind: 'switcher', mode: 'choose' });
  });

  test('idle-locked lands on the switcher in `lock` mode (§8.2 — the switcher IS the lock)', () => {
    expect(resolveZone(input({ session: null, locked: true }))).toEqual({
      kind: 'switcher',
      mode: 'lock',
    });
  });

  test('a session with nothing pending lands in the shell at its route', () => {
    expect(resolveZone(input({ route: 'syncStatus' }))).toEqual({
      kind: 'shell',
      route: 'syncStatus',
    });
  });

  test('tapping a user on the switcher lands on the PIN pad, carrying the mode', () => {
    expect(resolveZone(input({ session: null, pinFor: 'user-b' }))).toEqual({
      kind: 'pin',
      userId: 'user-b',
      mode: 'choose',
    });
    expect(resolveZone(input({ session: null, locked: true, pinFor: 'user-b' }))).toEqual({
      kind: 'pin',
      userId: 'user-b',
      mode: 'lock',
    });
  });

  test('a voluntary switch from an open session reaches the PIN pad in `choose` mode', () => {
    // A session is open AND a user was tapped: this is user A choosing to hand the counter to B.
    // It is not a lock, so the switch stays abandonable.
    expect(resolveZone(input({ session: { userId: 'user-a' }, pinFor: 'user-b' }))).toEqual({
      kind: 'pin',
      userId: 'user-b',
      mode: 'choose',
    });
  });
});

describe('revocation is terminal and beats every other input (03 §Device)', () => {
  // The adversarial combination: a device revoked WHILE a session is open and a user is mid-switch.
  // A gate that checked the session first would leave a revoked device in the shell until something
  // else happened to lock it — the revocation would be cosmetic.
  test.each([
    ['an open session', input({ device: 'revoked' })],
    ['an open session mid-switch', input({ device: 'revoked', pinFor: 'user-b' })],
    ['a session and a shell route', input({ device: 'revoked', route: 'settings' })],
  ])('revoked wins over %s', (_label, given) => {
    expect(resolveZone(given)).toEqual({ kind: 'enrollment', revoked: true });
  });

  test('unenrolled likewise wins over a stale in-memory session', () => {
    expect(resolveZone(input({ device: 'unenrolled', route: 'settings' }))).toEqual({
      kind: 'enrollment',
      revoked: false,
    });
  });
});

describe('resolveZone is total — no input maps to nothing (the blank-screen guard)', () => {
  test('every combination of the input space resolves to a zone', () => {
    const devices: DeviceStatus[] = ['unenrolled', 'active', 'revoked'];
    const sessions = [null, { userId: 'user-a' }];
    const locks = [true, false];
    const pins = [null, 'user-b'];
    const routes: ShellRoute[] = ['home', 'syncStatus', 'settings'];
    const kinds = new Set<Zone['kind']>();

    let count = 0;
    for (const device of devices)
      for (const session of sessions)
        for (const locked of locks)
          for (const pinFor of pins)
            for (const route of routes) {
              const zone = resolveZone({ device, session, locked, pinFor, route });
              expect(
                zone,
                JSON.stringify({ device, session, locked, pinFor, route }),
              ).toBeDefined();
              expect(zone.kind).toBeTruthy();
              kinds.add(zone.kind);
              count += 1;
            }

    // The sweep's own denominator (T-14 — a guard must assert its own coverage). Without these two
    // lines a bug that made the loops iterate zero times would report a green "every combination".
    expect(count).toBe(
      devices.length * sessions.length * locks.length * pins.length * routes.length,
    );
    expect([...kinds].sort()).toEqual(['enrollment', 'pin', 'shell', 'switcher']);
  });
});

describe('backTarget — hardware back IS the header back (§8.1)', () => {
  test('the LOCK switcher has NO back — a back button would walk into A`s session (§8.2)', () => {
    expect(backTarget({ kind: 'switcher', mode: 'lock' })).toBeNull();
  });

  test('a voluntary switcher can be abandoned back to the shell', () => {
    expect(backTarget({ kind: 'switcher', mode: 'choose' })).toEqual({
      kind: 'shellRoute',
      route: 'home',
    });
  });

  test('the enrollment wizard has nothing behind it', () => {
    expect(backTarget({ kind: 'enrollment', revoked: false })).toBeNull();
    expect(backTarget({ kind: 'enrollment', revoked: true })).toBeNull();
  });

  test('PIN back returns to the user list in BOTH modes — a mis-tapped face must not cost an attempt', () => {
    // Including `lock` mode: the lock has no back, but once a face is picked the user must be able
    // to say "not me" without burning a lockout attempt against the wrong account.
    expect(backTarget({ kind: 'pin', userId: 'u', mode: 'lock' })).toEqual({ kind: 'switcher' });
    expect(backTarget({ kind: 'pin', userId: 'u', mode: 'choose' })).toEqual({ kind: 'switcher' });
  });

  test('shell sub-routes go home; home exits the app', () => {
    expect(backTarget({ kind: 'shell', route: 'syncStatus' })).toEqual({
      kind: 'shellRoute',
      route: 'home',
    });
    expect(backTarget({ kind: 'shell', route: 'settings' })).toEqual({
      kind: 'shellRoute',
      route: 'home',
    });
    expect(backTarget({ kind: 'shell', route: 'home' })).toEqual({ kind: 'exitApp' });
  });
});
