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
    switching: false,
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
    expect(resolveZone(input({ session: null }))).toEqual({
      kind: 'switcher',
      mode: 'choose',
      origin: 'home',
    });
  });

  test('idle-locked lands on the switcher in `lock` mode (§8.2 — the switcher IS the lock)', () => {
    expect(resolveZone(input({ session: null, locked: true }))).toEqual({
      kind: 'switcher',
      mode: 'lock',
      origin: 'home',
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

  test('an open session that ASKED for the switcher reaches it, carrying the origin route (task 143)', () => {
    // THE DEFECT THIS TASK CLOSES. Before `switching`, `session !== null && pinFor === null` mapped
    // to the shell for EVERY input, so no live-session tap could produce the switcher — the avatar
    // was a dead control. `switching` is the reachable input; `origin` is the surface it was opened
    // from, so the abandon path (below) can return there rather than home.
    expect(
      resolveZone(input({ session: { userId: 'user-a' }, switching: true, route: 'home' })),
    ).toEqual({ kind: 'switcher', mode: 'choose', origin: 'home' });
    expect(
      resolveZone(input({ session: { userId: 'user-a' }, switching: true, route: 'settings' })),
    ).toEqual({ kind: 'switcher', mode: 'choose', origin: 'settings' });
  });

  test('a picked face wins over a still-set `switching` — the PIN pad is the later step', () => {
    // Once a face is tapped `pinFor` is set; the roster is behind us. If `switching` also lingered
    // (it does, until the switch lands) the gate must still show the PIN pad, so back from the pad
    // returns to the roster rather than skipping it.
    expect(
      resolveZone(input({ session: { userId: 'user-a' }, switching: true, pinFor: 'user-b' })),
    ).toEqual({ kind: 'pin', userId: 'user-b', mode: 'choose' });
  });

  test('`switching` is inert without a session — the pre-session switcher is reached by session===null', () => {
    // A stale `switching` flag cannot manufacture a switcher when there is nobody signed in: step 2
    // (session === null) already owns that surface and decides lock-vs-choose. The flag only matters
    // in the session-open branch.
    expect(resolveZone(input({ session: null, switching: true }))).toEqual({
      kind: 'switcher',
      mode: 'choose',
      origin: 'home',
    });
    expect(resolveZone(input({ session: null, locked: true, switching: true }))).toEqual({
      kind: 'switcher',
      mode: 'lock',
      origin: 'home',
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
    const switches = [true, false];
    const routes: ShellRoute[] = ['home', 'syncStatus', 'settings'];
    const kinds = new Set<Zone['kind']>();

    let count = 0;
    for (const device of devices)
      for (const session of sessions)
        for (const locked of locks)
          for (const pinFor of pins)
            for (const switching of switches)
              for (const route of routes) {
                const zone = resolveZone({ device, session, locked, pinFor, switching, route });
                expect(
                  zone,
                  JSON.stringify({ device, session, locked, pinFor, switching, route }),
                ).toBeDefined();
                expect(zone.kind).toBeTruthy();
                kinds.add(zone.kind);
                count += 1;
              }

    // The sweep's own denominator (T-14 — a guard must assert its own coverage). Without these two
    // lines a bug that made the loops iterate zero times would report a green "every combination".
    expect(count).toBe(
      devices.length *
        sessions.length *
        locks.length *
        pins.length *
        switches.length *
        routes.length,
    );
    expect([...kinds].sort()).toEqual(['enrollment', 'pin', 'shell', 'switcher']);
  });
});

describe('backTarget — hardware back IS the header back (§8.1)', () => {
  test('the LOCK switcher has NO back — a back button would walk into A`s session (§8.2)', () => {
    // Origin is irrelevant to a lock: there is no shell to walk back to, that IS the property.
    expect(backTarget({ kind: 'switcher', mode: 'lock', origin: 'home' })).toBeNull();
  });

  test('a voluntary switcher is abandoned back to the ORIGIN, not unconditionally home (task 143)', () => {
    // The pre-session / home-avatar case returns home...
    expect(backTarget({ kind: 'switcher', mode: 'choose', origin: 'home' })).toEqual({
      kind: 'shellRoute',
      route: 'home',
    });
    // ...but a switch opened from the avatar ON Settings or Sync Status returns THERE. Before this
    // task `backTarget` hardcoded `route: 'home'`, so abandoning a switch dumped the user on the notes
    // list no matter where they came from — the return-path half of the defect.
    expect(backTarget({ kind: 'switcher', mode: 'choose', origin: 'settings' })).toEqual({
      kind: 'shellRoute',
      route: 'settings',
    });
    expect(backTarget({ kind: 'switcher', mode: 'choose', origin: 'syncStatus' })).toEqual({
      kind: 'shellRoute',
      route: 'syncStatus',
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
